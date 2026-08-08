# Codex Turn 控制循环：Submission、Steer、采样与中断收束

## 结论

Codex 的控制循环不是单一 `while model calls tool`，而是三层嵌套的生命周期：

1. **Submission Loop** 串行接收 `Op`，保证线程设置、用户输入、审批、Interrupt 等操作按到达顺序分发。
2. **SessionTask Lifecycle** 管理一个活动 Turn 的所有权、取消、终态事件、Rollout flush 和扩展 lifecycle。
3. **Sampling Loop** 在 Regular Task 内多次构建 Step、请求模型、执行工具、接纳 steer，并根据 follow-up/Hook/窗口状态决定继续或结束。

`Submission`、`Turn`、`sampling request` 不是同一个概念：一次用户输入可能 steer 到已有 Turn；一个 Regular Task 可能因 pending input 再次调用 `run_turn()`；一次 `run_turn()` 又可能包含多次 sampling request。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有执行真实 steer、Interrupt、审批暂停或断流恢复实验。

## 机制图

- [Codex Turn 控制循环与中断收束](../diagrams/codex-turn-control-loop.excalidraw)
- [符号级源码索引](../source-map.md)

## 1. Submission Loop 是线程级命令总线

外部调用通过 `SessionIo::submit*()` 把 `Submission { id, op, trace, parent_turn_id }` 写入 channel。`submission_loop()` 单消费者串行分发 `Op`：

- `UserInput`、`Review`、`Compact` 可以创建 Task；
- `Interrupt`、审批响应、`UserInputAnswer` 等操作影响正在运行的 Task；
- `ThreadSettings`、Rollback、MCP refresh 等修改线程状态；
- `Shutdown` 退出循环并执行会话 teardown。

分发本身不会等待 Regular Task 完成。`spawn_task()` 把 Task 放入 Tokio 后台任务，Submission Loop 随即继续处理后续审批、steer 或 interrupt，因此工具等待用户响应时线程仍能接收对应操作。

## 2. 新用户输入优先成为 steer，而不是无条件新建 Turn

`user_input_or_turn_inner()` 先构建新的 `TurnContext` 候选，再调用 `steer_input()`：

- 当前存在 `Regular` Task：把输入和 additional context 放入该 Turn 的 pending queue，返回已有 turn ID；
- 没有活动 Task：用新 sub ID 启动 `RegularTask`；
- 活动 Task 是 Review 或 Compact：拒绝 steer；
- 指定 `expected_turn_id` 且不匹配：拒绝，防止输入进入已经切换的 Turn；
- 空输入：拒绝。

因此客户端提交 ID 只用于请求/事件相关，真正的 Turn 归属由活动 Task 决定。这个设计允许模型运行时追加指令，又避免把晚到输入误投给下一个 Turn。

## 3. 一个 Session 同时只拥有一个前台 Task

`ActiveTurn` 保存 `RunningTask` 和共享 `TurnState`。`RunningTask` 绑定：

- `TaskKind`（Regular、Review、Compact）；
- Task trait object 与 Tokio handle；
- 父/子 `CancellationToken`；
- `TurnContext`、完成通知、执行 guard 和计时器。

`spawn_task()` 在启动新 Task 前调用 `abort_all_tasks(Replaced)`，所以前台 Task 是互斥的。`start_task()` 负责建立统一生命周期：记录 turn-start token 基线、吸收待处理输入、触发扩展 `on_turn_start`、安装 `ActiveTurn`，然后在后台运行 `SessionTask::run()`。

Regular、Review、Compact 共享这套外层协议，但是否可 steer、具体 `run()` 内容和 abort cleanup 不同。

## 4. RegularTask 还包着一层 run_turn 循环

`RegularTask::run()` 先发送 `TurnStarted` 并消费可选的 WebSocket prewarm，然后循环调用 `run_turn()`：

```text
run_turn(initial input)
→ 若 Task 结束时 queue 仍有 pending input
→ run_turn(empty input)
→ 直到 queue 为空
```

这层循环处理 sampling 主循环退出边界附近到达的 steer。它仍属于同一个 Session Task 和 Turn ID，不会额外发出一组 `TurnStarted/TurnComplete`。

## 5. run_turn 的每个 Step 都重新建立一致视图

一次 `run_turn()` 先执行 pre-turn compaction，再解析输入所需 MCP/Plugin，捕获首个 `StepContext`、记录上下文更新和用户输入。随后进入 sampling loop：

1. 在允许的边界 drain pending input；
2. 重新捕获或复用 `StepContext`；
3. 刷新时间和 World State；
4. 从 History 构建 Prompt；
5. 调用 `run_sampling_request()`；
6. 汇总模型 follow-up、pending input 和 token 状态；
7. 决定继续、压缩后继续，或进入 stop hooks。

StepContext 把本次请求的工具定义和执行 Runtime 固定在同一快照中，防止 sampling 时模型看到的工具面与随后执行时的环境漂移。

## 6. Sampling Request 自己还有重试与流消费层

`run_sampling_request()` 构建 Prompt 和 `ToolCallRuntime`，对可重试的 stream error 按 Provider 的 retry budget 重试。重试时重新从 Session History 构建 input，并附加尚待呈现的已执行工具调用；ContextWindowExceeded 和 UsageLimitReached 不进入普通重试。

`try_run_sampling_request()` 消费 Responses stream：

- Output item 进入 History/事件流；
- 客户端工具调用生成 Future，放入 `FuturesOrdered`；
- `end_turn == false` 或工具调用把 `needs_follow_up` 设为 true；
- stream completed 后记录 token usage；
- 所有 in-flight 工具按调用顺序 drain 并写回 History；
- 工具全部结束后才发 token count 和 Turn diff。

工具可并行运行，但 sampling request 不会在工具结果尚未落入上下文时返回外层循环。

## 7. needs_follow_up 是多来源合并的控制信号

下一次 sampling 的原因不只来自工具：

- 模型发出 Function/Custom Tool Call；
- Responses 返回 `end_turn: false`；
- 当前 Turn 收到 steer；
- 可接纳的 inter-agent mailbox 有待处理内容；
- Stop Hook 阻止结束并追加 continuation prompt；
- 达到窗口阈值，压缩后必须恢复 continuation。

外层把 `model_needs_follow_up || has_pending_input` 合并为 `needs_follow_up`。只有它为 false，Stop Hook 也未要求继续，且 After-Agent Hook 未接管时，`run_turn()` 才返回最后一条 assistant message。

## 8. pending input 只在安全边界注入

`InputQueue` 同时管理 turn-local steer 和 session-level inter-agent mailbox。`can_drain_pending_input` 刻意在两个阶段为 false：

- Turn 开始时，让本轮原始输入先被模型采样；
- mid-turn auto compact 后，如果模型/工具仍需 continuation，先完成它再混入 steer。

Mailbox 还有 `CurrentTurn / NextTurn` 两态：一旦已经产生用户可见终态输出，晚到且不要求立即触发的子 Agent 消息会留给下一个 Turn；显式 steer 或新的工具 follow-up 可以重新打开 CurrentTurn delivery。

这避免了“答案已经展示，晚到邮件却悄悄改变同一答案尾部”的竞态。

## 9. Hook 可以改变输入接纳和停止语义

`run_hooks_and_record_inputs()` 对每个输入先执行 pending-input inspection：Hook 可以阻止输入，同时追加额外 context；只要同批次仍有一个真实用户输入被接受，Turn 不会因其他被阻止项整体停止。

当模型看似完成时，Stop Hook 可以：

- 接受终止；
- 阻止终止并给出 continuation fragments，使 sampling loop 继续；
- 请求停止，不再运行 legacy after-agent hook。

因此控制循环的最终终止权不完全属于模型，扩展 lifecycle 可以在明确边界上追加约束。

## 10. Interrupt 是协作取消后再强制收束

`interrupt_task()` 调用 `abort_all_tasks(Interrupted)`。中断流程按以下顺序执行：

1. 从 Session 取走 `ActiveTurn`，阻止新操作继续命中旧 Task；
2. cancel Task token，让 stream、工具和等待中的异步操作协作退出；
3. 最多等待 100ms 的 graceful completion；
4. abort Tokio handle，并调用 Task 自定义 `abort()`；
5. 可选地写入模型可见 `<turn_aborted>` guidance；
6. 先 flush marker，再发送 `TurnAborted`；
7. 再次 flush terminal event，清理 pending waiter/input；
8. 如 mailbox 仍要求执行，调度新的 Regular Turn。

取消 token 是首选退出机制，Tokio abort 是超时后的兜底。Marker 只用于真实 `Interrupted`，`Replaced` 等原因不会伪装成用户中断。

## 11. 正常完成和异常结束统一由 spawn site 收束

后台 Task 返回后，`start_task()` 先 flush 普通 Rollout，再调用 `on_task_finished()`。后者统一：

- 区分成功、`TurnAborted` 与其他错误；
- 记录 token/tool/memory/时延指标；
- 执行 `on_turn_stop`、`on_turn_abort` 或 `on_turn_error`；
- 发出唯一的 `TurnComplete` 或 `TurnAborted`；
- 清空匹配的 `ActiveTurn`，触发 thread-idle lifecycle；
- flush terminal event，并检查 mailbox 是否应唤醒下一 Turn。

如果显式 abort 已经取走 ActiveTurn，后台 Task 即使稍后返回，`on_task_finished()` 也会因找不到匹配状态而退出，避免重复终态事件。

## 关键设计约束

1. **串行分发、并行执行**：Op 顺序稳定，后台 Task 不阻塞审批和 Interrupt。
2. **单前台 Task 所有权**：`ActiveTurn` 是 steer、审批、取消和终态去重的共同锚点。
3. **Turn 与 sampling 分离**：一个 Turn 可包含多轮模型—工具采样和多批 steer。
4. **输入只在边界合流**：原始输入、steer 和 mailbox 不会任意插入正在消费的 stream。
5. **模型不是唯一终止者**：工具、pending input、Hook、压缩和 mailbox 都能要求 continuation。
6. **取消先协作后强制**：先传播 token，再以短超时和 handle abort 收口。
7. **终态事件可持久恢复**：marker、普通 items 和 terminal event 都有明确 flush barrier。

## 测试证据

- `core/src/session/tests.rs`：Task 启动/完成、Interrupt、唯一终态、steer turn ID 校验、非 Regular 拒绝 steer、pending input 与 mailbox 边界；
- `core/src/session/turn_tests.rs`：stream item、follow-up、工具 drain、终止和错误路径；
- `core/src/session/input_queue.rs` 内测试：activity 通知、mailbox/steer 优先级与 delivery phase；
- `core/src/tasks/mod_tests.rs`：Task lifecycle 与 abort 行为；
- `core/src/session/rollout_reconstruction_tests.rs`：TurnComplete/TurnAborted 边界的恢复行为。

这些测试只作为源码证据阅读，本次没有本地执行。

## 未确认事项

- 未实测 100ms graceful interruption 在不同工具和平台进程树上的清理效果。
- 未测量 stream retry 与已执行工具调用重附加在真实断网场景中的幂等性。
- Realtime conversation 有独立的交接协议，本文只覆盖普通 Submission/Regular Task。
- Review、Guardian 和 Multi-Agent Task 在共享 lifecycle 上还有各自的状态机，适合后续单独分析。
