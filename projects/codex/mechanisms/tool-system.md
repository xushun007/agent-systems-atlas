# Codex 工具系统：从暴露到安全执行再到上下文回写

## 结论

Codex 的工具系统不是一个简单的 `name → handler` 调度表，而是四个彼此分离、逐步收窄的机制：

1. **能力装配**：Core、MCP、Extensions 和动态工具共同构建 `ToolRegistry`。
2. **模型暴露**：`ToolExposure`、Tool Mode、Feature 与 Provider 能力决定哪些 `ToolSpec` 出现在本次模型请求中。
3. **运行时执行**：模型输出被归一化为 `ToolCall`，再经过并发门、Registry 生命周期、工具专属 Handler；Shell 和 Apply Patch 等副作用工具还会进入统一的审批与沙箱编排器。
4. **结果回写**：所有结果转换为 `ResponseInputItem`，按模型发出调用的顺序写入会话历史，触发下一次采样。

因此，“工具已注册”“模型能看见”“模型能直接调用”“工具被授权执行”是四种不同状态，不能合并理解。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有执行真实命令、审批或沙箱实验，运行时行为仍需后续实验验证。

## 机制图

- [Codex 工具执行与安全闭环](../diagrams/codex-tool-execution-flow.excalidraw)
- [符号级源码索引](../source-map.md)

图中蓝色表示模型协议和请求，紫色表示注册与分发，橙色表示策略决策，红色表示拒绝或升级分支，绿色表示执行结果与上下文回写。

## 1. 工具装配不是静态列表

每个 Step 通过 `build_tool_router()` 重新组合工具。它首先调用 `add_core_tool_sources()` 注册内建工具，然后按运行环境与配置追加其他来源：

```text
Core handlers
MCP tools
Extension contributors
Dynamic tools
Hosted model tools
        ↓
ToolRegistry + hosted specs
        ↓
finalize_tool_router()
        ↓
ToolRouter {
  registry,
  model_visible_specs
}
```

Core 工具本身也不是全部无条件注册：

- 是否存在可执行环境，决定 Shell、Apply Patch、View Image 等工具是否出现；
- 模型的 `ConfigShellToolType` 决定暴露 Unified Exec 还是传统 Shell；
- Feature flags 决定 Plan、Request Permissions、Token Budget、协作工具等是否启用；
- MCP Server 是否存在，决定资源读取工具是否注册；
- Guardian Reviewer 使用一个刻意收窄的工具集合；
- Provider 能力和 Web Search 配置决定使用本地 Extension 工具还是 Hosted Tool。

`ToolRegistry` 区分可信注册与外部注册：可信工具重名会触发错误；外部工具重名则被跳过并记录 warning。外部工具还不能占用无 namespace 的 `shell_command` 名称。这让内建安全边界优先于插件或动态来源。

## 2. ToolExposure 分离注册与模型可见性

`ToolExecutor` 把可执行 Runtime、`ToolSpec` 和默认暴露策略绑定在同一个对象上。`ToolExposure` 有四种状态：

| Exposure | 初始模型请求 | Code Mode 内可用 | Registry 可分发 | 典型用途 |
| --- | --- | --- | --- | --- |
| `Direct` | 是 | 是 | 是 | 普通内建工具 |
| `Deferred` | 否 | 是 | 是 | 通过 `tool_search` 延迟发现 |
| `DirectModelOnly` | 是 | 否 | 是 | 只允许模型直接调用的交互工具 |
| `Hidden` | 否 | 否 | 是 | 兼容或内部调度入口 |

`build_model_visible_specs()` 只选择 `Direct` 和 `DirectModelOnly`，再合并 Hosted Specs。Deferred 工具仍保留在 Registry 中；当存在可搜索的 Deferred 工具时，`finalize_tool_router()` 注册 `tool_search`，通过搜索结果把工具定义按需交给模型。

Code Mode 又增加一层投影：允许进入 Code Mode 的工具会转换成嵌套工具定义，由 `CodeModeExecuteHandler` 执行；`DirectModelOnly` 和 `Hidden` 不进入这条路径。也就是说，Codex 同时维护“模型原生工具面”和“代码运行时嵌套工具面”。

## 3. 模型输出如何成为 ToolCall

`build_prompt()` 把 `ToolRouter::model_visible_specs()` 写入 `Prompt.tools`，并根据模型能力设置 `parallel_tool_calls`。

模型流返回完整 Output Item 后，`handle_output_item_done()` 调用 `ToolRouter::build_tool_call()`，把三种客户端执行请求统一成 `ToolCall`：

- `ResponseItem::FunctionCall` → `ToolPayload::Function`；
- `ResponseItem::CustomToolCall` → `ToolPayload::Custom`；
- `execution == "client"` 的 `ToolSearchCall` → `ToolPayload::ToolSearch`。

Hosted Tool 或普通消息不会进入客户端 Tool Runtime。工具调用原始 Output Item 会先写入会话历史，再创建执行 Future。即使 Turn 随后取消，模型“曾经请求过这个工具”的事实仍与 Rollout/History 保持一致。

## 4. 并行并不意味着结果乱序

`ToolCallRuntime` 使用一个共享 `RwLock` 作为并发门：

- `supports_parallel_tool_calls() == true` 的工具取得读锁，可与其他并行工具同时运行；
- 不支持并行的工具取得写锁，会与所有其他工具互斥；
- 工具可以通过 `wait_until_ready()` 在进入并发门之前等待自身 Runtime 就绪。

采样循环把工具 Future 放入 `FuturesOrdered`。Future 可以并行执行，但 `drain_in_flight()` 按插入顺序取出 `ResponseInputItem` 并写回历史。因此 Codex 同时获得执行并发和稳定的上下文顺序。

取消也不是统一的 `abort()`：普通 Runtime 会终止执行 task；声明 `waits_for_runtime_cancellation()` 的 Runtime 可以先完成进程清理。两者最后都会产生明确的 aborted Tool Output，而不是静默丢失调用。

## 5. Registry 是工具生命周期边界

`ToolRouter` 将 `ToolCall` 包装成携带 Session、StepContext、CancellationToken、Turn Diff Tracker 和调用来源的 `ToolInvocation`，然后交给 `ToolRegistry::dispatch_any_with_terminal_outcome()`。

Registry 的执行顺序是：

```text
查找 Runtime并校验 Payload 类型
→ ToolStarted 事件
→ PreToolUse Hook
→ Handler.handle()
→ Telemetry 与外部上下文标记
→ PostToolUse Hook
→ ToolCompleted / Failed / Blocked 事件
→ AnyToolResult
```

PreToolUse Hook 可以：

- 允许执行；
- 阻止执行并把原因返回模型；
- 重写工具输入，再由具体 Runtime 重新构造 `ToolInvocation`。

PostToolUse Hook 发生在 Handler 已经执行之后，因此它不能撤销副作用。它可以阻止原始结果进入模型，或用反馈消息替换模型可见结果；还可以添加后续 Context。这个时序对安全分析非常重要：Post Hook 是“结果治理”，不是“执行前授权”。

## 6. 审批、ExecPolicy 和沙箱是不同决策

并非所有工具都进入平台沙箱。只读内存工具、计划工具或部分 MCP 工具有自己的 Handler 语义。Shell 和 Apply Patch 等副作用工具通过 `ToolOrchestrator` 共享以下编排：

```text
Tool-specific request
→ ExecApprovalRequirement
→ PermissionRequest Hook
→ Guardian 或 User Reviewer
→ 选择首轮 Sandbox
→ 执行
→ 若 Sandbox Denied 且策略允许：再次审批
→ 无沙箱或保留限制的第二次执行
```

### 6.1 ExecPolicy 先产生三态要求

Shell Handler 在执行前调用 `ExecPolicyManager::create_exec_approval_requirement_for_command()`。它解析命令段、匹配规则并结合 `AskForApproval`，产生：

- `Skip`：无需交互审批；只有所有命令段都被显式 Allow Rule 匹配时，才可能设置 `bypass_sandbox: true`；
- `NeedsApproval`：需要审批，可携带原因和建议写入的 prefix rule；
- `Forbidden`：直接拒绝，不进入执行阶段。

这说明“ExecPolicy Allow”和“无需审批”也不完全等价。启发式或默认策略可以跳过审批但仍然保留沙箱；只有明确规则允许时才可能首轮绕过沙箱。

### 6.2 Reviewer 之前还有 PermissionRequest Hook

`resolve_tool_apporval()` 首先运行 PermissionRequest Hook。Hook 明确 Allow 或 Deny 时直接形成决议；没有结论时，才路由到 Guardian 自动审查或用户审批。所有来源最后归一化为 `ReviewDecision`，拒绝、超时和中止都 fail closed。

Session 级审批缓存以工具定义的 Approval Key 为单位：Shell 通常按环境、规范化命令、cwd 和权限组合缓存；Apply Patch 按目标文件分别缓存。因此“本 Session 不再询问”不会无条件授权其他命令或其他文件。

### 6.3 Sandbox 失败不必然升级

`ToolOrchestrator` 根据有效 Permission Profile、工具偏好、平台和网络策略选择首轮 Sandbox。若执行返回可识别的 `SandboxErr::Denied`，只有同时满足以下条件才考虑第二次尝试：

- 工具声明允许 `escalate_on_failure()`；
- `AskForApproval` 允许请求该类升级，或存在可审批的网络拒绝；
- 当前文件系统限制允许取消沙箱，或者重试仍能保留必要限制；
- Guardian/User/Hook 对升级重试给出允许决议。

含 denied-read 路径的策略不能简单切换到无沙箱执行，因为无沙箱会丢失读限制。这种情况下即使请求 escalated permissions，也必须保留可执行该限制的 Sandbox。

网络审批与文件系统审批也不是同一个开关。`run_attempt()` 可以为本次执行启动 Managed Network 审批，并根据 Immediate/Deferred 模式在执行后完成决议。

## 7. 工具结果如何回到模型

具体输出实现 `ToolOutput::to_response_item()`，最终形成：

- `FunctionCallOutput`；
- `CustomToolCallOutput`；
- `ToolSearchOutput`。

非 Fatal 错误同样被转换成 `success: false` 的模型可见输出，让模型有机会修正参数或选择其他工具。只有 `FunctionCallError::Fatal` 会终止当前运行链。

`drain_in_flight()` 将按序完成的 `ResponseInputItem` 转为 `ResponseItem`，调用 `record_conversation_items()` 写入 History/Rollout。由于工具调用把 `needs_follow_up` 设置为 true，下一轮 Prompt 会从更新后的历史构建，形成闭环：

```text
FunctionCall → FunctionCallOutput → History → Prompt → next sampling
```

## 8. 关键设计约束

1. **Spec 与 Runtime 同源**：`ToolExecutor` 同时提供名字、Spec、Exposure 和 Handle，减少“模型看到的定义”与“实际执行器”漂移。
2. **能力与可见性分离**：Registry 中存在不代表模型本轮可见。
3. **可见性与权限分离**：模型可调用不代表执行被授权。
4. **并发与顺序分离**：执行可并发，写回上下文保持调用顺序。
5. **审批与隔离分离**：用户批准不一定取消 Sandbox，ExecPolicy Allow 也只有在显式规则覆盖全部命令段时才可能绕过 Sandbox。
6. **执行前后 Hook 语义不同**：Pre Hook 能阻止副作用，Post Hook 只能治理结果和追加上下文。
7. **错误尽量进入模型闭环**：可恢复错误成为 Tool Output；Fatal 错误才中断 Runtime。

## 测试证据

本次阅读同时核对了以下测试区域：

- `core/src/tools/spec_plan_tests.rs`：工具暴露、Tool Search 与模式组合；
- `core/src/tools/router_tests.rs`：Response Item 归一化、namespace 与 dispatch；
- `core/src/tools/parallel.rs` 内测试：并发门、取消和失败输出；
- `core/src/exec_policy_tests.rs`：Allow/Prompt/Forbidden、prefix rule 与复杂命令；
- `core/src/tools/sandboxing_tests.rs`：审批默认值、首轮 sandbox override 与 denied-read 约束；
- `core/src/tools/runtimes/shell/unix_escalation_tests.rs`：Unix Shell 升级路径；
- `core/src/tools/handlers/apply_patch_tests.rs`：Patch 路径权限和沙箱行为；
- `core/src/mcp_tool_call_tests.rs`：MCP 工具独立的审批模式。

这些测试作为源码行为证据被阅读，但本次没有在本地执行。

## 未确认事项

- 尚未运行真实工具调用，无法确认不同平台 Sandbox 错误文本如何影响 denial detection。
- Remote Environment 与本地 Sandbox 的责任边界仍需单独分析。
- MCP/Connector 有自己的审批与持久授权逻辑，本文只说明它接入 Registry 的位置，没有展开其完整状态机。
- Code Mode 内嵌工具调用经过独立 JS Runtime bridge，本文只覆盖其与共享 Tool Registry 的边界。
- Guardian 自动审批的模型、Prompt 和故障恢复值得作为独立机制继续分析。
