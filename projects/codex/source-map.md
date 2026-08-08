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

## 使用方式

升级分析基线时，优先按表格逐项确认：符号是否仍存在、调用者是否变化、测试是否覆盖相同不变量。若结论发生变化，应同时更新机制文档、图和 `project.yaml`。
