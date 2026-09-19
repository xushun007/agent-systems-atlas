---
title: 中断之后，Agent 到底停在哪里
series: Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型
part: 4
reviewed_at: 2026-09-16
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# 中断之后，Agent 到底停在哪里

“停止”不是一个瞬间，而是一条控制流。取消请求到达时，模型流可能仍在产生事件，工具可能阻塞在子进程或网络调用中，事件监听器可能尚未处理完，持久化层也可能尚未写入终态。因而，`abort()` 返回、工具 promise 结束、事件流发出终态和 Session 变为空闲，不能默认视为同一时刻。

本篇的核心结论是：**中断的首要保证是阻止新的工作被接纳，第二保证是传播取消信号，第三保证才是发布可观察终态；外部动作是否已经停止，需要单独的进程或远程资源协议。** 没有这三个层次，产品界面的“已停止”容易早于真实执行。

## 1. 中断的状态机

可将一次中断抽象为：

```text
running
  -> cancel_requested
  -> cancellation_propagated
  -> execution_settled
  -> terminal_published
  -> idle
```

这些状态允许短暂重叠。例如 `terminal_published` 的监听器仍可能执行，因此事件已对外可见而 Runtime 尚未清理本地 active-run。反过来，执行 fiber 被取消也不必然意味着远程工具已经收到取消请求。

一个可测试的终态应至少回答：是否还会产生新的模型请求、是否还会启动后续工具、当前工具是否结束、未完成动作的结果是什么、取消是否写入历史，以及新输入何时可以重新进入。

## 2. Pi：AbortSignal 是合作式协议

Pi 底层 `Agent.abort()` 只触发当前运行的 `AbortController`。`agent-loop` 在模型请求、工具准备和工具批次之间检查 signal；顺序执行在一个工具返回后检查是否继续，准备阶段也会在 hook 前后检查取消状态。工具执行函数收到同一个 signal，但 Runtime 不会强制终止任意 promise。[^pi-abort]

这一区分有直接后果：

| 场景 | Runtime 能够保证 | Runtime 不能单独保证 |
| --- | --- | --- |
| 当前工具合作式响应 | signal 可见，工具可以提前结束 | 工具实现一定会响应 |
| 当前工具不响应 | 后续循环最终可以被阻止或 fiber 结束 | 已发出的文件、网络、子进程动作被撤销 |
| 顺序工具批次 | signal 后通常不再准备后续工具 | 已完成工具的副作用回滚 |
| 事件监听器 | `agent_end` 事件按循环发布 | 所有异步监听器已经结束，除非等待 idle |

Pi 明确提供 `waitForIdle()`，其 promise 在 `agent_end` 监听器完成、`finishRun()` 清理 active run 后才解决。由此，事件终态和本地空闲是有意分开的。[^pi-idle]

Pi 的并行工具执行还带来一个常见误区：`Promise.all` 可以按调用顺序收集结果，但不能让工具按调用顺序完成。某个工具在取消前已经启动，就需要等待或处理它的实际结果；不能只看结果数组位置推断取消时刻。

## 3. Codex：短暂优雅窗口后强制收敛

Codex 的任务取消先取消合作式 token，并对 Code Mode 等能力发出专门中断；随后等待任务完成，宽限时间为 100ms，超时后 abort Tokio task。这个设计将“给执行者机会自行清理”和“避免取消请求无限等待”放在同一条路径上。[^codex-abort]

强制 abort 解决的是 Runtime 自身 future 的收敛，不是通用的外部撤销。任务若已经启动 shell、远程请求或编辑器动作，实际资源是否停止仍取决于对应执行器。对 coding agent 来说，这也是为什么取消策略不能只由模型循环实现：进程管理器和远程任务句柄必须定义自己的终止语义。

Codex 在中断历史标记与 `TurnAborted` 事件之间尝试 flush rollout，使客户端在收到终态后能重新读取标记。实现对 flush 失败只记录 warning 后继续发布事件，所以它提供的是“先尝试建立可见顺序”，不是失败条件下的强持久化保证。[^codex-abort]

`abort_all_tasks` 还会清理待处理输入；这不是简单地丢弃队列，而是防止取消审批等待者后，把“队列被清空”误解释为用户拒绝审批。输入接纳、取消和审批等待因此共享同一个生命周期控制面。[^codex-abort-all]

## 4. OpenCode：本地执行所有权与持久 claim 分离

OpenCode v2 的 `SessionExecution` 将 process-local active execution 与数据库中的 claim 分开。开始执行时，`Execution.Started` 与 claim 在同一提交点建立；正常完成和主动用户中断释放 claim；shutdown 中断保留 claim，使下次服务启动可以把没有终态的执行视为恢复候选。[^opencode-execution]

该模型解决了“进程死亡时没有机会运行 finally”的问题：恢复依据是持久 claim，而不是依赖关机钩子。测试覆盖了启动时扫描 claim、每个 claim 启动一次恢复，以及用户中断后不让旧 claim 复活等情况。它仍不是分布式恰好一次执行证明；一个外部动作在进程崩溃前已经生效但终态尚未提交，重启时仍需由工具或任务协议处理重复风险。[^opencode-tests]

OpenCode 还区分 `awaitSettlement` 与 `awaitIdle`：前者等待被中断的那一次执行，后者等待进程不再拥有执行。新工作可能在清理期间被接纳，所以“这次中断已经结算”和“Session 当前完全空闲”不能混用。[^opencode-execution]

## 5. 迟到结果与终态收敛

取消最难的情况不是 signal 能否传递，而是迟到结果：工具在取消后完成、模型流在终止事件后抵达、或者监听器在终态发布后写入附加记录。可靠实现需要给每个执行分配身份，并使结果提交检查该身份是否仍然有效。

最低限度的规则包括：

1. 取消后不再启动新的 Step 或工具调用。
2. 已启动动作的结果必须被标为完成、失败、取消或未知之一。
3. 迟到结果不能覆盖已发布的终态。
4. 新一轮工作不能误收旧一轮的工具结果。
5. 用户看到终态时，应能读取与该终态关联的取消记录；若写入失败，界面必须知道这项事实尚未持久化。

这里的“未知”很重要。把一个被中断的 shell 统一记成失败，可能诱使恢复逻辑重试一个已经成功写文件的动作；把它统一记成成功，则可能掩盖半途退出。未知是对外部世界不可观测性的诚实表达。

## 6. 可复现验证

无需 API key 即可检验底层顺序：使用脚本化模型和一个可暂停工具，在工具运行时调用 abort；再分别让工具响应 signal 和忽略 signal。记录 `tool_start`、`tool_end`、模型请求、`turn_end`、`agent_end`、idle 时间点以及副作用文件状态。

这种测试能验证 Pi Agent/loop 的取消传播和事件顺序，不能证明 CLI 的 shell 子进程树、真实提供商流或所有插件都遵循相同协议。Codex 与 OpenCode 的当前结论来自源码和上游测试阅读，没有把未执行的服务级实验写成实测结果。

## 7. 设计原则

中断设计的关键不是把所有任务都强杀，而是显式区分“停止接纳”“停止计算”“停止外部动作”和“发布终态”。合作式取消提供清理机会，硬超时提供本地收敛，持久 claim 提供跨进程发现，未知结果则保护恢复逻辑不作错误重试。代价是实现复杂度和用户语义变得更精细：一个按钮可能对应多个可观察阶段。

## 未确认事项

- 尚未实测真实 shell 子进程树、远程 MCP 调用或 OpenCode 服务重启后的恢复。
- 尚未证明任一项目对任意外部副作用提供回滚或恰好一次保证。
- Pi 结论限于 v0.85.1 底层 Agent；Pi v4 durable harness 的恢复语义需在持久化篇单独讨论。

[^pi-abort]: [Pi loop cancellation and tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L430-L718)
[^pi-idle]: [Pi `abort` and `waitForIdle`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L319-L337)
[^codex-abort]: [Codex task abort](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-abort-all]: [Codex abort-all queue handling](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L509-L535)
[^opencode-execution]: [OpenCode session execution](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L20-L185)
[^opencode-tests]: [OpenCode execution recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
