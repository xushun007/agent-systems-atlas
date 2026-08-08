# Codex 源码证据索引

本索引把 Atlas 中的重要结论映射到可重新检查的源码符号。当前基线为 commit `7750465934d97dd3cbcb3b1655d2f622744010d3`。

## 工具系统

| 结论 | 关键符号 | 源码位置 | 测试证据 |
| --- | --- | --- | --- |
| 每个 Step 组合内建、MCP、Extension 和动态工具 | `build_tool_router()` | [`core/src/tools/spec_plan.rs`](../../../codex/codex-rs/core/src/tools/spec_plan.rs) | `spec_plan_tests.rs` |
| Core 工具受环境、Feature、模型和模式控制 | `add_core_tool_sources()`、`add_shell_tools()`、`add_core_utility_tools()` | [`core/src/tools/spec_plan.rs`](../../../codex/codex-rs/core/src/tools/spec_plan.rs) | `spec_plan_tests.rs` |
| Spec、Exposure 与 Runtime 由同一执行器提供 | `ToolExecutor` | [`tools/src/tool_executor.rs`](../../../codex/codex-rs/tools/src/tool_executor.rs) | `tools/src/tool_spec_tests.rs`、`tool_discovery_tests.rs` |
| 注册不等于模型可见 | `ToolExposure`、`build_model_visible_specs()` | [`tools/src/tool_executor.rs`](../../../codex/codex-rs/tools/src/tool_executor.rs)、[`core/src/tools/spec_plan.rs`](../../../codex/codex-rs/core/src/tools/spec_plan.rs) | `spec_plan_tests.rs` |
| Deferred 工具通过 Tool Search 延迟发现 | `append_tool_search_executor()` | [`core/src/tools/spec_plan.rs`](../../../codex/codex-rs/core/src/tools/spec_plan.rs) | `core/src/tools/spec_plan_tests.rs`、`tools/src/tool_search_tests.rs` |
| Code Mode 将部分 Registry 工具投影为嵌套工具 | `register_code_mode_executors()` | [`core/src/tools/spec_plan.rs`](../../../codex/codex-rs/core/src/tools/spec_plan.rs) | `spec_plan_tests.rs` |
| 外部工具不能覆盖内建工具或无 namespace 的 `shell_command` | `ToolRegistry::register_external_with_exposure()` | [`core/src/tools/registry.rs`](../../../codex/codex-rs/core/src/tools/registry.rs) | `registry_tests.rs`（相关断言位于模块测试） |
| Prompt 只携带本 Step 的模型可见 Specs | `build_prompt()`、`ToolRouter::model_visible_specs()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs)、[`core/src/tools/router.rs`](../../../codex/codex-rs/core/src/tools/router.rs) | `session/tests.rs` |
| Function、Custom 与客户端 Tool Search 被统一为 `ToolCall` | `ToolRouter::build_tool_call()` | [`core/src/tools/router.rs`](../../../codex/codex-rs/core/src/tools/router.rs) | `tools/router_tests.rs` |
| 模型 Tool Item 先记录，再创建执行 Future | `handle_output_item_done()` | [`core/src/stream_events_utils.rs`](../../../codex/codex-rs/core/src/stream_events_utils.rs) | `stream_events_utils_tests.rs`、`session/tests.rs` |
| 并行工具共享读锁，串行工具取得写锁 | `ToolCallRuntime::handle_tool_call_with_source()` | [`core/src/tools/parallel.rs`](../../../codex/codex-rs/core/src/tools/parallel.rs) | `tools/parallel.rs` 内测试 |
| Future 并发执行但结果按调用顺序写回 | `FuturesOrdered`、`drain_in_flight()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | `session/tests.rs` |
| Registry 统一执行事件、Hook、Telemetry 与 Handler | `ToolRegistry::dispatch_any_with_terminal_outcome()` | [`core/src/tools/registry.rs`](../../../codex/codex-rs/core/src/tools/registry.rs) | `registry_tests.rs`（相关断言位于模块测试） |
| Pre Hook 可以阻止或重写输入 | `run_pre_tool_use_hooks()`、`CoreToolRuntime::with_updated_hook_input()` | [`core/src/tools/registry.rs`](../../../codex/codex-rs/core/src/tools/registry.rs) | Hook 相关 Core tests |
| Post Hook 在副作用完成后治理模型可见结果 | `run_post_tool_use_hooks()`、`PostToolUseFeedbackOutput` | [`core/src/tools/registry.rs`](../../../codex/codex-rs/core/src/tools/registry.rs) | Hook 相关 Core tests |
| Shell 命令先由 ExecPolicy 归纳为三态要求 | `ExecPolicyManager::create_exec_approval_requirement_for_command()` | [`core/src/exec_policy.rs`](../../../codex/codex-rs/core/src/exec_policy.rs) | `core/src/exec_policy_tests.rs` |
| Shell Handler 将策略结果交给统一编排器 | `run_shell_command()` 中 `ToolOrchestrator::run()` 调用 | [`core/src/tools/handlers/shell.rs`](../../../codex/codex-rs/core/src/tools/handlers/shell.rs) | Shell Handler tests |
| 审批先经过 PermissionRequest Hook，再到 Guardian/User | `resolve_tool_apporval()` | [`core/src/tools/approvals.rs`](../../../codex/codex-rs/core/src/tools/approvals.rs) | `approvals_tests.rs`、`codex_delegate_tests.rs` |
| Session 级审批按工具定义的 Approval Key 缓存 | `with_cached_approval()`、`Approvable::approval_keys()` | [`core/src/tools/sandboxing.rs`](../../../codex/codex-rs/core/src/tools/sandboxing.rs) | Shell/Apply Patch runtime tests |
| 审批、Sandbox 选择和 denial retry 集中编排 | `ToolOrchestrator::run()` | [`core/src/tools/orchestrator.rs`](../../../codex/codex-rs/core/src/tools/orchestrator.rs) | `core/src/session/tests.rs` 中的 Orchestrator 场景 |
| denied-read 限制会阻止无沙箱升级 | `unsandboxed_execution_allowed()`、`sandbox_permissions_preserving_denied_reads()` | [`core/src/tools/sandboxing.rs`](../../../codex/codex-rs/core/src/tools/sandboxing.rs) | `tools/sandboxing_tests.rs` |
| Apply Patch 按目标文件缓存审批，并共享 Orchestrator | `ApplyPatchRuntime::approval_keys()`、`execute_verified_patch()` | [`core/src/tools/runtimes/apply_patch.rs`](../../../codex/codex-rs/core/src/tools/runtimes/apply_patch.rs)、[`core/src/tools/handlers/apply_patch.rs`](../../../codex/codex-rs/core/src/tools/handlers/apply_patch.rs) | `handlers/apply_patch_tests.rs` |
| 工具输出统一转换为 Responses 输入项 | `ToolOutput::to_response_item()`、`AnyToolResult::into_response()` | [`tools/src/tool_output.rs`](../../../codex/codex-rs/tools/src/tool_output.rs)、[`core/src/tools/registry.rs`](../../../codex/codex-rs/core/src/tools/registry.rs) | `tools/context_tests.rs` |

## 上下文生命周期

| 结论 | 关键符号 | 源码位置 | 测试证据 |
| --- | --- | --- | --- |
| StepContext 固定一次采样使用的模型、环境、能力、工具与指令 | `StepContext`、`capture_step_context()` | [`core/src/session/step_context.rs`](../../../codex/codex-rs/core/src/session/step_context.rs)、[`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| World State 由稳定 ID 的 section 组成并支持 merge patch | `WorldState`、`WorldStateSection`、`render_diff()` | [`core/src/context/world_state/mod.rs`](../../../codex/codex-rs/core/src/context/world_state/mod.rs) | 模块内 tests |
| 每个 Step 汇总模型、AGENTS、权限、环境与扩展状态 | `build_world_state_for_step()` | [`core/src/session/world_state.rs`](../../../codex/codex-rs/core/src/session/world_state.rs) | `session/tests.rs` |
| 初始上下文聚合 fragments、完整 World State 与扩展贡献 | `build_initial_context_with_world_state()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| 无基线时完整注入，有基线时只写入状态差异 | `record_context_updates_and_set_reference_context_item()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `record_context_updates_*` tests |
| Sampling steps 之间继续刷新 World State diff | `record_step_world_state_if_changed()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| ContextManager oldest-first 保存 API 历史并截断工具输出 | `ContextManager::record_items()` | [`core/src/context_manager/history.rs`](../../../codex/codex-rs/core/src/context_manager/history.rs) | 模块内 tests |
| 发请求前修复 call/output 配对并清理不支持模态 | `ContextManager::for_prompt()` | [`core/src/context_manager/history.rs`](../../../codex/codex-rs/core/src/context_manager/history.rs) | 模块内 tests |
| Prompt 独立组合 input、基础指令和本 Step 工具 Specs | `build_prompt()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | `session/tests.rs` |
| 模型与工具结果同时追加到 History 和 Rollout | `record_conversation_items()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| Token 总量以服务端统计为锚点并估算本地新增项 | `ContextManager::get_total_token_usage()` | [`core/src/context_manager/history.rs`](../../../codex/codex-rs/core/src/context_manager/history.rs) | 模块内 token tests |
| 自动压缩预算同时受 compact limit 与模型硬窗口约束 | `context_window_status()` | [`core/src/session/context_window.rs`](../../../codex/codex-rs/core/src/session/context_window.rs) | `session/tests.rs` |
| Window 保存 ID、prefill baseline 与一次性提醒状态 | `AutoCompactWindow` | [`core/src/state/auto_compact_window.rs`](../../../codex/codex-rs/core/src/state/auto_compact_window.rs) | `session/tests.rs` |
| Turn 前处理 token 上限、模型不兼容和窗口下调 | `run_pre_sampling_compact()`、`maybe_run_previous_model_inline_compact()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | `session/tests.rs` |
| Mid-turn follow-up 在压缩后先 continuation 再接收 steer | `run_auto_compact()`、`InitialContextInjection::BeforeLastUserMessage` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs)、[`core/src/compact.rs`](../../../codex/codex-rs/core/src/compact.rs) | `compact_tests.rs` |
| Local compaction 保留最近真实用户消息并追加 summary | `run_compact_task_inner()`、`collect_user_messages()` | [`core/src/compact.rs`](../../../codex/codex-rs/core/src/compact.rs) | `compact_tests.rs` |
| Remote compaction 调用服务端并过滤非规范历史 | `run_remote_compact_task_inner()` | [`core/src/compact_remote.rs`](../../../codex/codex-rs/core/src/compact_remote.rs) | 模块内 tests |
| Remote v2 按预算保留消息并追加 Compaction item | `build_v2_compacted_history()`、`RETAINED_MESSAGE_TOKEN_BUDGET` | [`core/src/compact_remote_v2.rs`](../../../codex/codex-rs/core/src/compact_remote_v2.rs) | 模块内 tests |
| 所有压缩路径在同一边界替换历史、推进窗口并写 checkpoint | `replace_compacted_history()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| 新建上下文只保留规范初始上下文，不保留摘要 | `start_new_context_window()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `start_new_context_window_*` tests |
| Rollout 以 Compacted replacement history 恢复内存态 | `reconstruct_history_from_rollout()` | [`core/src/session/rollout_reconstruction.rs`](../../../codex/codex-rs/core/src/session/rollout_reconstruction.rs) | 模块内 reconstruction tests |
| ModelClientSession 仅在 turn 内复用增量请求和 sticky routing | `ModelClientSession`、`prepare_websocket_request()` | [`core/src/client.rs`](../../../codex/codex-rs/core/src/client.rs) | `client.rs` 内 tests |

## Turn 控制循环

| 结论 | 关键符号 | 源码位置 | 测试证据 |
| --- | --- | --- | --- |
| Submission 携带操作、相关 ID、trace 与父 Turn | `Submission`、`Op` | [`protocol/src/protocol.rs`](../../../codex/codex-rs/protocol/src/protocol.rs) | `session/tests.rs` |
| 单消费者串行分发线程操作 | `submission_loop()` | [`core/src/session/handlers.rs`](../../../codex/codex-rs/core/src/session/handlers.rs) | `session/tests.rs` |
| 用户输入优先 steer，空闲时才启动 RegularTask | `user_input_or_turn_inner()` | [`core/src/session/handlers.rs`](../../../codex/codex-rs/core/src/session/handlers.rs) | steer 相关 session tests |
| Steer 校验活动 Task 类型和 expected turn ID | `Session::steer_input()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `steer_input_*` tests |
| ActiveTurn 统一持有 Task 与可变 TurnState | `ActiveTurn`、`RunningTask`、`TurnState` | [`core/src/state/turn.rs`](../../../codex/codex-rs/core/src/state/turn.rs) | `session/tests.rs` |
| 新前台 Task 会以 Replaced 原因终止旧 Task | `Session::spawn_task()` | [`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | task lifecycle tests |
| SessionTask 抽象 Regular、Review、Compact 的统一生命周期 | `SessionTask`、`AnySessionTask` | [`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | `tasks/mod_tests.rs` |
| start_task 安装取消、后台 handle、TurnContext 与 lifecycle | `Session::start_task()` | [`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | `spawn_task_*` tests |
| RegularTask 可在同一 Turn 内因 pending input 再次 run_turn | `RegularTask::run()` | [`core/src/tasks/regular.rs`](../../../codex/codex-rs/core/src/tasks/regular.rs) | `session/tests.rs` |
| run_turn 在多个 Step/Sampling 之间合并 follow-up 状态 | `run_turn()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | `turn_tests.rs` |
| Sampling 对 retryable stream error 重建 Prompt 并重试 | `run_sampling_request()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | retry 相关 tests |
| Stream 输出、工具 Future、token 与 diff 在请求内收束 | `try_run_sampling_request()`、`drain_in_flight()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | `turn_tests.rs` |
| pending input 只在明确边界 drain | `can_drain_pending_input`、`InputQueue::get_pending_input()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs)、[`core/src/session/input_queue.rs`](../../../codex/codex-rs/core/src/session/input_queue.rs) | input queue tests |
| Mailbox delivery 在 CurrentTurn/NextTurn 间切换 | `MailboxDeliveryPhase` | [`core/src/state/turn.rs`](../../../codex/codex-rs/core/src/state/turn.rs) | mailbox session tests |
| 输入 Hook 可拒绝项目并追加上下文 | `run_hooks_and_record_inputs()` | [`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | Hook 相关 tests |
| Stop Hook 可注入 continuation 并重开 sampling | `run_turn_stop_hooks()` | [`core/src/hook_runtime.rs`](../../../codex/codex-rs/core/src/hook_runtime.rs)、[`core/src/session/turn.rs`](../../../codex/codex-rs/core/src/session/turn.rs) | Hook 相关 tests |
| Interrupt 先 cancel，短暂等待后强制 abort | `interrupt_task()`、`handle_task_abort()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs)、[`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | interrupt 相关 session tests |
| 中断 marker 在 TurnAborted 前持久化 | `interrupted_turn_history_marker()` | [`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | terminal flush tests |
| 正常、错误和取消由同一完成边界发出终态 | `on_task_finished()` | [`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | terminal event tests |
| Task 清空后触发 thread idle 并检查 mailbox 唤醒 | `emit_thread_idle_lifecycle_if_idle()`、`maybe_start_turn_for_pending_work()` | [`core/src/tasks/lifecycle.rs`](../../../codex/codex-rs/core/src/tasks/lifecycle.rs)、[`core/src/tasks/mod.rs`](../../../codex/codex-rs/core/src/tasks/mod.rs) | mailbox/idle tests |

## Rollout、Resume 与 Fork

| 结论 | 关键符号 | 源码位置 | 测试证据 |
| --- | --- | --- | --- |
| RolloutItem 同时承载模型项、上下文元数据和事件 | `RolloutItem`、`RolloutLine` | [`protocol/src/protocol.rs`](../../../codex/codex-rs/protocol/src/protocol.rs) | protocol/rollout tests |
| Session 通过 LiveThread 隔离具体持久化实现 | `persist_rollout_items()`、`flush_rollout()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | `session/tests.rs` |
| Recorder 用后台 command queue 串行写 JSONL | `RolloutRecorder`、`RolloutCmd`、`rollout_writer()` | [`rollout/src/recorder.rs`](../../../codex/codex-rs/rollout/src/recorder.rs) | `rollout/src/recorder_tests.rs` |
| 新线程可延迟到首次 persist/flush 才物化文件 | `deferred_log_file_info`、`ensure_writer_open()` | [`rollout/src/recorder.rs`](../../../codex/codex-rs/rollout/src/recorder.rs) | recorder materialization tests |
| 写失败保留未写后缀并重开文件重试 | `write_pending_with_recovery()`、`write_pending_items_once()` | [`rollout/src/recorder.rs`](../../../codex/codex-rs/rollout/src/recorder.rs) | recorder write-error tests |
| Flush 等待此前 command 写出并刷新文件 | `RolloutRecorder::flush()` | [`rollout/src/recorder.rs`](../../../codex/codex-rs/rollout/src/recorder.rs) | recorder flush tests |
| 读取跳过坏行并以首个 SessionMeta 确定 thread ID | `load_rollout_items()`、`get_rollout_history()` | [`rollout/src/recorder.rs`](../../../codex/codex-rs/rollout/src/recorder.rs) | recorder resume tests |
| InitialHistory 区分 New/Cleared/Resumed/Forked | `InitialHistory`、`ResumedHistory` | [`protocol/src/protocol.rs`](../../../codex/codex-rs/protocol/src/protocol.rs) | session resume/fork tests |
| 恢复反向寻找最新有效 checkpoint 与 metadata | `reconstruct_history_from_rollout()` | [`core/src/session/rollout_reconstruction.rs`](../../../codex/codex-rs/core/src/session/rollout_reconstruction.rs) | `rollout_reconstruction_tests.rs` |
| Compacted replacement history 成为重建基座 | `CompactedItem::replacement_history` | [`protocol/src/protocol.rs`](../../../codex/codex-rs/protocol/src/protocol.rs)、[`core/src/session/rollout_reconstruction.rs`](../../../codex/codex-rs/core/src/session/rollout_reconstruction.rs) | compaction reconstruction tests |
| Rollback 追加事实并在 replay 时删除逻辑 Turn | `ThreadRolledBack`、`drop_last_n_user_turns()` | [`core/src/session/rollout_reconstruction.rs`](../../../codex/codex-rs/core/src/session/rollout_reconstruction.rs)、[`core/src/thread_rollout_truncation.rs`](../../../codex/codex-rs/core/src/thread_rollout_truncation.rs) | rollback reconstruction tests |
| Session 一次安装 History、基线、窗口和 previous settings | `record_initial_history()`、`apply_rollout_reconstruction()` | [`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs) | initial history tests |
| Fork 前 materialize/flush source，防止遗漏排队尾部 | `spawn_subagent()` | [`core/src/thread_manager.rs`](../../../codex/codex-rs/core/src/thread_manager.rs) | agent control fork-flush tests |
| ForkSnapshot 区分截断前缀和合成中断边界 | `ForkSnapshot`、`fork_history_from_snapshot()` | [`core/src/thread_manager.rs`](../../../codex/codex-rs/core/src/thread_manager.rs) | `thread_manager_tests.rs` |
| Mid-turn fork 可追加与真实中断一致的 marker/abort event | `snapshot_turn_state()`、`append_interrupted_boundary()` | [`core/src/thread_manager.rs`](../../../codex/codex-rs/core/src/thread_manager.rs) | fork snapshot tests |
| Referenced fork 以 HistoryPosition 指向祖先有界前缀 | `HistoryPosition`、`ForkPersistence::Referenced` | [`protocol/src/protocol.rs`](../../../codex/codex-rs/protocol/src/protocol.rs)、[`core/src/session/mod.rs`](../../../codex/codex-rs/core/src/session/mod.rs)、[`core/src/thread_manager.rs`](../../../codex/codex-rs/core/src/thread_manager.rs) | paginated fork tests |
| RolloutLineage 递归组合祖先物理区间并检测环 | `RolloutLineage`、`resolve_rollout_lineage()` | [`thread-store/src/local/rollout_lineage.rs`](../../../codex/codex-rs/thread-store/src/local/rollout_lineage.rs) | `rollout_lineage_tests.rs` |
| prepare_fork 持久化 source、选择边界并加载模型上下文 | `paginated_fork::prepare()` | [`thread-store/src/local/paginated_fork.rs`](../../../codex/codex-rs/thread-store/src/local/paginated_fork.rs) | thread history materialization tests |

## Guardian 自动审批审查

| 结论 | 关键符号 | 源码位置 | 测试证据 |
| --- | --- | --- | --- |
| 只有 OnRequest/Granular 与 AutoReview 组合路由到 Guardian | `routes_approval_policy_to_guardian()` | [`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `guardian/tests.rs` |
| PermissionRequest Hook 优先于 Guardian/User reviewer | `resolve_tool_apporval()` | [`core/src/tools/approvals.rs`](../../../codex/codex-rs/core/src/tools/approvals.rs) | `tools/approvals_tests.rs` |
| Guardian request 覆盖命令、Patch、网络、MCP 和权限动作 | `GuardianApprovalRequest` | [`core/src/guardian/approval_request.rs`](../../../codex/codex-rs/core/src/guardian/approval_request.rs) | `guardian/tests.rs` |
| 动作 JSON 稳定排序并递归限制单字符串长度 | `guardian_approval_request_to_json()`、`truncate_guardian_action_value()` | [`core/src/guardian/approval_request.rs`](../../../codex/codex-rs/core/src/guardian/approval_request.rs) | `guardian/tests.rs` |
| Transcript 分离消息/工具预算并保留首条和最新用户证据 | `select_guardian_transcript_entries()` | [`core/src/guardian/prompt.rs`](../../../codex/codex-rs/core/src/guardian/prompt.rs) | `guardian/tests.rs` |
| 普通 developer/context fragment 不作为用户授权证据 | `collect_guardian_transcript_entries()` | [`core/src/guardian/prompt.rs`](../../../codex/codex-rs/core/src/guardian/prompt.rs) | `guardian/tests.rs` |
| History version 与 cursor 决定 Full 或 Delta prompt | `GuardianTranscriptCursor`、`GuardianPromptMode` | [`core/src/guardian/prompt.rs`](../../../codex/codex-rs/core/src/guardian/prompt.rs) | `guardian/tests.rs` |
| Reviewer 强制只读、Never approval 并清空 MCP/扩展能力 | `build_guardian_review_session_config()` | [`core/src/guardian/review_session.rs`](../../../codex/codex-rs/core/src/guardian/review_session.rs) | `review_session.rs` 模块 tests |
| Guardian policy 与 JSON Schema 共同约束输出 | `guardian_policy_prompt_with_config_and_template()`、`guardian_output_schema()` | [`core/src/guardian/prompt.rs`](../../../codex/codex-rs/core/src/guardian/prompt.rs)、[`core/src/guardian/policy.md`](../../../codex/codex-rs/core/src/guardian/policy.md) | `guardian/tests.rs` |
| Guardian 使用独立 Codex thread 和稳定 parent-scoped cache key | `spawn_guardian_review_session()`、`prompt_cache_key_override_for_review_session()` | [`core/src/guardian/review_session.rs`](../../../codex/codex-rs/core/src/guardian/review_session.rs) | `review_session.rs` 模块 tests |
| 空闲 trunk 复用，忙碌 trunk 从已提交 rollout 建临时 fork | `GuardianReviewSessionManager::run_review()`、`run_ephemeral_review()` | [`core/src/guardian/review_session.rs`](../../../codex/codex-rs/core/src/guardian/review_session.rs) | `guardian/tests.rs`、`review_session.rs` 模块 tests |
| 复用键变化会替换 trunk，避免跨不兼容配置共享 | `GuardianReviewSessionReuseKey` | [`core/src/guardian/review_session.rs`](../../../codex/codex-rs/core/src/guardian/review_session.rs) | `review_session.rs` 模块 tests |
| 审查共享 90 秒 deadline，最多三次有限重试 | `run_guardian_review_session_with_retry()` | [`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `review_tests`、`guardian/tests.rs` |
| 仅临时连接/服务异常和 JSON 解析失败可重试 | `should_retry_guardian_review()` | [`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `guardian_review_retry_only_*` |
| Allow/Deny/Timeout/Cancel/Failure 都映射到标准 ReviewDecision | `run_guardian_review()` | [`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `guardian/tests.rs` |
| 工具层把 Guardian 超时、取消和拒绝统一变成 Rejected | `ApprovalResolution::into_tool_result()` | [`core/src/tools/approvals.rs`](../../../codex/codex-rs/core/src/tools/approvals.rs) | `tools/approvals_tests.rs` |
| 只有显式 deny 计入 3 连续或最近 50 中 10 次的熔断 | `GuardianRejectionCircuitBreaker`、`record_guardian_denial()` | [`core/src/guardian/mod.rs`](../../../codex/codex-rs/core/src/guardian/mod.rs)、[`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `guardian/tests.rs` |
| 熔断通过异步 interrupt 终止活跃 Turn 并补齐 idle lifecycle | `record_guardian_denial()` | [`core/src/guardian/review.rs`](../../../codex/codex-rs/core/src/guardian/review.rs) | `guardian/tests.rs`、`session/tests.rs` |
| 客户端覆写只注入 exact-action developer 授权，不直接执行 | `approve_guardian_denied_action()` | [`core/src/session/handlers.rs`](../../../codex/codex-rs/core/src/session/handlers.rs) | `session/tests.rs` |
| MCP elicitation 先做模式/schema 适配再交给 Guardian | `review_guardian_mcp_elicitation()`、`guardian_elicitation_review_request()` | [`core/src/session/mcp.rs`](../../../codex/codex-rs/core/src/session/mcp.rs) | `session/mcp.rs` 模块 tests |

## 使用方式

升级分析基线时，优先按表格逐项确认：符号是否仍存在、调用者是否变化、测试是否覆盖相同不变量。若结论发生变化，应同时更新机制文档、图和 `project.yaml`。
