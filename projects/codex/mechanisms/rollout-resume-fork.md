# Codex Rollout：持久化、恢复与 Fork 语义

## 结论

Codex 的 Rollout 不是把当前 Prompt 定期序列化，而是一条带类型、时间和顺序位置的 canonical JSONL 日志。它同时服务四类消费者：

1. **恢复模型上下文**：从 Response Items、Compaction checkpoint、Rollback 和 World State 重建 `ContextManager`。
2. **恢复线程运行元数据**：模型、context window、token usage、TurnContext 和父子 lineage。
3. **驱动 UI/审计**：保留 TurnStarted、Item、Approval、TurnComplete/Aborted 等事件。
4. **构造 Fork**：在稳定的用户/Turn 边界截取复制前缀，或通过 `history_base` 引用祖先的有界物理区间。

Rollout 是 append-only 的事实日志，但恢复结果不是简单回放所有行：最新有效的 `Compacted.replacement_history` 会成为历史基座，Rollback 会删除逻辑 Turn，World State patch 要在 full snapshot 上重放，fork 中断还可能合成一个终止边界。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有模拟磁盘错误、进程崩溃、压缩文件恢复或多代 paginated fork。

## 机制图

- [Codex Rollout 持久化、恢复与 Fork](../diagrams/codex-rollout-resume-fork.excalidraw)
- [符号级源码索引](../source-map.md)

## 1. RolloutItem 是多平面的统一日志协议

每条 `RolloutLine` 包含 timestamp、可选 ordinal 和一个带 tag 的 `RolloutItem`。核心类型包括：

- `SessionMeta`：thread/session ID、cwd、来源、父子/fork lineage、base instructions、history mode、初始 window；
- `ResponseItem`：真正参与模型对话的 user/assistant/reasoning/tool items；
- `TurnContext` 与 `WorldState`：恢复模型、权限、环境和差异基线；
- `Compacted`：摘要、完整 replacement history 和窗口 ID 链；
- `EventMsg`：Turn/Item/Approval/Token/UI 等生命周期事件；
- inter-agent communication 及其本地 metadata。

这意味着“模型历史”和“完整 Rollout”不能互换。EventMsg 对 UI/审计很重要，但多数不会进入模型 Prompt；World State/TurnContext 用于恢复比较基线，也不作为普通消息逐条发送。

## 2. Session 只依赖 LiveThread 的持久化接口

Core 的 `persist_rollout_items()` 把 canonical items 交给 `LiveThread::append_items()`；`flush_rollout()` 和 `ensure_rollout_materialized()` 也只经由 LiveThread。底层本地实现再连接 `RolloutRecorder`、Thread Store、SQLite projection 和 rollout path。

这种边界让 Session 不直接管理 JSONL 文件，也允许关闭持久化或替换 Store 实现。事件发送路径通常先追加 `EventMsg`，再投递客户端；模型 Response Item 则先完成 ID/媒体准备、写入 History，再进入 Rollout。

## 3. 新线程使用延迟物化

`RolloutRecorder` 持有一个 channel 和后台 writer task。Create 模式可以只有 deferred path、`SessionMeta` 和内存中的 `pending_items`，尚未创建文件：

- `AddItems`：排队；若文件已物化则顺带 flush；
- `Persist`：确保创建文件并写出 pending items；
- `Flush`：处理此前所有 command，并等待文件 flush；有 pending items 时也会触发物化；
- `Shutdown`：成功 drain 后才停止 writer。

因此空白线程或仅有不要求物化的设置事件可以没有 JSONL 文件。第一次真实对话、显式 persist、fork/归档等需要稳定路径的操作才建立文件。

## 4. Writer 以未写后缀实现可重试

`RolloutWriterState` 只在一条 item 成功写出后才从 `pending_items` 删除它，并同步推进 ordinal。写失败时：

1. 保留尚未成功的后缀；
2. 丢弃文件 handle，进入 recovery mode；
3. 重新打开/物化文件并重试一次；
4. 第二次仍失败才把错误返回 barrier，writer 保持可供以后再次 flush。

打开已有文件时会确保末尾有换行；压缩 rollout 在 append 前会物化为 plain JSONL。这个机制降低了部分写入后丢失后缀的风险，但不是数据库事务：进程级崩溃和文件系统 durability 仍受操作系统语义影响。

## 5. Flush 是跨异步边界的可见性屏障

`record_canonical_items()` 只保证 command 进入 writer channel；`flush()` 才保证此前排队内容经过 writer 并完成文件 flush。Codex 在关键可观察边界显式使用它：

- Task body 返回后、发送 `TurnComplete/TurnAborted` 前 flush 普通 items；
- 真实 Interrupt 先 flush `<turn_aborted>` marker，再发 abort event；
- terminal event 发送后再次 flush；
- fork/subagent 读取父历史前先 materialize + flush；
- Shutdown 尝试 drain writer。

这些 barrier 防止客户端收到终态后立即重读，却看不到导致该终态的历史；也防止 fork 遗漏父线程刚生成但仍在 channel 中的尾部。

## 6. 读取 Rollout 保留可恢复信息，不因坏行整体失败

`load_rollout_items()` 逐行解析 JSONL，跳过空行和旧 ghost snapshot；无法解析的单行增加 `parse_errors` 并继续。第一个 `SessionMeta` 决定 canonical thread ID，后续从 fork 复制来的 SessionMeta 不会覆盖它。

`get_rollout_history()` 返回 `InitialHistory::Resumed { conversation_id, Arc<Vec<RolloutItem>>, rollout_path }`。此时仍是完整日志，尚未等于模型历史。

## 7. Resume 通过反向分段找到最小有效基座

`reconstruct_history_from_rollout()` 从新到旧扫描 Turn segments，目标是找到：

- 最新仍有效的 `Compacted.replacement_history`；
- 最新存活用户 Turn 的 previous model settings；
- 最新 reference `TurnContextItem` 或明确的基线清除；
- World State full/patch 序列；
- context window number 与 UUID 链。

一旦这些都已确定，更早记录不能改变结果，就停止反向扫描。然后从 replacement history 开始，只把其后的有效 suffix 按正序回放进 `ContextManager`。没有 replacement history 的旧版 compaction 才退化为用 message summary 重建。

这使恢复成本可以围绕最近 checkpoint，而不是永远从第一条消息完整 replay；源码也为未来 lazy reverse loader 保留了相同形状。

## 8. Rollback 在日志中追加，恢复时逻辑删除

Thread rollback 不修改既有 JSONL，也不回滚工作区文件。它追加 `ThreadRolledBack { num_turns }`：

- 反向扫描时跳过最新 N 个真实 user-turn segments，避免这些 Turn 的 metadata/baseline 成为恢复结果；
- 正向重建 History 时调用 `drop_last_n_user_turns()` 删除对应对话内容；
- fork boundary 计算也会考虑既有 rollback，不能把已回滚 Turn 重新暴露为分叉点。

因此 Rollout 保留“发生过什么”，ContextManager 呈现“当前逻辑上仍存活什么”。

## 9. World State 和窗口身份也必须恢复

World State 恢复按时间正序处理：full item 建立 snapshot，patch 应用 merge patch，compaction 清除旧 baseline；没有 full baseline 的 patch 被忽略。TurnContext 恢复 previous model/comp hash 和 reference context item。

Compacted item 的 `window_number`、`first_window_id`、`previous_window_id`、`window_id` 恢复 auto-compact window 链；旧日志缺少这些字段时，以 compaction 数量等信息降级估算。完成 reconstruction 后，Session 一次性安装 History、World State baseline、窗口和 previous settings。

## 10. Resume 与 Fork 的身份语义不同

`InitialHistory` 明确区分：

- `Resumed`：继续原 thread ID 和原 rollout path；
- `Forked`：用选定历史作为新 thread 的初始上下文，生成新的 thread ID；
- `New/Cleared`：没有可恢复历史。

Resume 读取已有 Rollout 并恢复同一个会话。Fork 则先把 source history 变成 `Forked`，记录 `forked_from_id`，再把初始历史种入新线程。两者可以得到相似的模型 Prompt，但 lineage、持久化归属和后续 append 目标不同。

## 11. ForkSnapshot 定义未完成 Turn 的处理方式

Codex 当前有两种 snapshot：

- `TruncateBeforeNthUserMessage(n)`：严格截在第 n 个 user boundary 前；若越界且 source 正在 mid-turn，则退回 active Turn 开始前，完全丢弃未完成后缀；
- `Interrupted`：保留当前持久化尾部；若尾部仍在 mid-turn，合成与真实 Interrupt 相同的 marker 和 `TurnAborted(Interrupted)`。

`snapshot_turn_state()` 结合显式 TurnStarted/terminal event 与旧式纯 ResponseItem 历史判断是否 mid-turn。这样 fork 后的模型不会误以为一个被截断的工具/推理过程已经正常完成。

## 12. Copied 与 Referenced Fork 是两种物理布局

Legacy/Copied fork 把选定 rollout prefix 追加到新线程，然后写入 child 的有效设置，简单但会复制历史。

Paginated/Referenced fork 使用 `HistoryPosition { thread_id, end_ordinal_exclusive, end_byte_offset }` 作为 `SessionMeta.history_base`：child 本地 rollout 只保存自己的后缀，逻辑读取时 `RolloutLineage` 按 history_base 递归组合祖先的有界物理区间。实现会：

- 检测 lineage cycle、thread ID 或 history mode 不一致；
- 校验 ordinal 与 byte offset 没越过来源文件；
- fork 前持久化 source 并 materialize SQLite projection；
- 在 child reference 持久化前暂时保留 source lifecycle reservation；
- 删除 ancestor 时通过 reference index 防止留下悬空 child。

引用 fork 减少复制，但引入祖先生命周期和边界完整性的约束。

## 关键设计约束

1. **日志与投影分离**：Rollout 保存完整事实，History/UI/SQLite 是不同投影。
2. **追加与重建分离**：Rollback/Compaction 不原地改旧行，由 replay 决定当前有效状态。
3. **排队与持久可见分离**：append 不等于 flush，关键外部边界必须显式 barrier。
4. **checkpoint 与尾部重放结合**：replacement history 是基座，其后 suffix 保留精确语义。
5. **Resume 与 Fork 分离身份**：共享历史不等于共享 thread ID 或 append target。
6. **逻辑 lineage 与物理文件分离**：paginated child 可以引用多个祖先区间。
7. **失败保留未写后缀**：writer retry 不会静默丢弃 pending items。

## 测试证据

- `rollout/src/recorder_tests.rs`：延迟物化、flush、resume append、写失败重开与 pending suffix；
- `core/src/session/rollout_reconstruction_tests.rs`：compaction checkpoint、rollback、TurnContext、World State 和 window 恢复；
- `core/src/session/tests.rs`：InitialHistory::Resumed/Forked 安装与首次上下文注入；
- `core/src/thread_manager_tests.rs`：fork snapshot、mid-turn interrupt boundary 与 lineage；
- `thread-store/src/local/thread_history_materialization_tests.rs`：paginated fork、history_base 与 source reservation；
- `thread-store/src/local/rollout_lineage_tests.rs`：多代 lineage、cutoff 和异常引用。

这些测试只作为源码行为证据阅读，本次没有本地执行。

## 未确认事项

- 未执行真实 crash/restart，无法确认不同文件系统上的最后一次 flush durability。
- 未测量超长 Rollout 的 eager reconstruction 成本以及未来 lazy reverse loader 的收益。
- 未验证 compressed rollout 与引用 fork 同时存在时的性能和归档策略。
- SQLite projection 的 schema、增量物化和 UI pagination 值得作为独立存储机制继续分析。
