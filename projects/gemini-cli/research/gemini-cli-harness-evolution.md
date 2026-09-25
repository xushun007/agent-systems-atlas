---
title: Gemini CLI Runtime/Harness Analysis
reviewed_at: 2026-09-15
upstream_repository: https://github.com/google-gemini/gemini-cli
upstream_ref: v0.59.0
upstream_commit: fb0d535af931b27c51e87e5e6ade72905b1e8390
status: current
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Gemini CLI Runtime/Harness 分析

本文研究 Gemini CLI 在 `v0.59.0` 的 Runtime/Harness 结构，重点关注 agent loop、turn/tool 生命周期、上下文、策略与执行环境的组合方式。源码固定在 [v0.59.0](https://github.com/google-gemini/gemini-cli/tree/v0.59.0)，对应 commit [`fb0d535`](https://github.com/google-gemini/gemini-cli/commit/fb0d535af931b27c51e87e5e6ade72905b1e8390)。

配套架构图：[Gemini CLI Runtime Architecture v0.59.0](../diagrams/gemini-cli-runtime-architecture-v0.59.0-fb0d535.excalidraw)。

## 结论

Gemini CLI 已不是“CLI 调用模型并执行几个函数”的薄封装，而是一个以 `packages/core` 为产品级运行时、以 CLI/TUI、IDE、SDK 和 A2A server 为不同宿主的多表面 agent。它的核心创新不是单一循环，而是把一次模型响应拆成可观察、可暂停、可审批、可恢复的 tool-call 状态机，并将 approval mode、sandbox、policy、MCP、hooks、压缩和 session recording 统一接入循环。

更精确地说，v0.59 已出现两个相互配合的“强所有者”：`GeminiChat/AgentChatHistory` 是对话事实和 durable turn ID 的所有者；`ContextManager/ContextWorkingBuffer` 是面向模型请求的可变投影所有者。前者保证恢复、记录和工具响应的线性一致性，后者允许在不破坏原始 transcript 的情况下做摘要、蒸馏、截断、masking 和 late-bind prompt。这是它与早期“直接把 `Content[]` 交给 Gemini API”的最大架构差异。

## Runtime 边界与生命周期

```text
CLI/TUI/IDE/SDK host
        ↓ AgentLoopContext + Config
GeminiClient ── GeminiChat / model routing
        ↓ repeated Turns
Turn ── stream events ── CoreToolScheduler
                         ↓ policy / approval / sandbox
                         ↓ tool executor
        ← tool results / user cancellation / retry
        ↓ compression / loop detection / final event
session recording / history / telemetry
```

`GeminiClient` 持有会话级 chat、turn 计数、当前模型序列、上下文管理器、压缩服务、循环检测器和 hook 状态；`Turn` 表示一次 agentic loop 内的模型响应与工具调用；工具的并行执行、等待审批、取消和结果回注由 scheduler/state manager 负责。关键实现见 [`core/client.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/client.ts)、[`core/turn.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/turn.ts) 和 [`scheduler/state-manager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/state-manager.ts)。

### Session、prompt、turn 与 tool call

| 层次 | 主要对象 | 生命周期 | 长期事实 |
| --- | --- | --- | --- |
| Session | `Config`、session id、`GeminiChat`、`ChatRecordingService` | 一次可恢复对话 | JSONL conversation、metadata、tool records |
| User prompt | `prompt_id`、hook state、loop detector scope | 一次用户输入及其 continuation | prompt 与结果写入 session；运行态可变 |
| Model turn | `Turn`、`sessionTurnCount`、model stream | prompt 内的一次模型请求/响应 | model message、thought、usage、tool calls |
| Tool call | `ToolCallRequestInfo` + scheduler state | validating 到 terminal | 审批、结果、耗时、输出文件 |
| Context render | `ContextManager.renderHistory()` 结果 | 每个模型请求前 | 通常是 API 投影，部分管理结果回写 graph |

`prompt_id` 关联 hook、loop detection、tool calls 和 recording；`schedulerId/parentCallId` 关联 sub-agent 或嵌套调用。一个 prompt 可以因 next-speaker check、loop recovery 或 after-agent hook continuation 递归产生多个 `Turn`，所以用户看到的一次回答不等于一个 API request。stable history turn ID、已完成 tool result、session ID 是事实；当前模型、approval mode、active tools、context graph、IDE context 和 pending tool state 是可变投影。

## 关键组件

### 1. Client、Turn 与 scheduler

`GeminiClient` 负责请求编排、最大 turn 限制、重试、模型切换、hook、上下文压缩、loop detection 和最终事件。`Turn` 将流式文本、thought、citation、tool-call request/response、confirmation、compression 和 finished 事件统一成服务端事件协议。scheduler 则不是简单的工具注册表：它维护 `pending`、`awaiting_approval`、`executing`、`success`、`error` 等调用状态，并把审批模式和 sandbox 结果带入状态迁移。

`GeminiChat` 通过 `sendPromise` 串行化请求；新请求会等待上一个 stream，并在 unanswered function response 存在时先关闭它，避免新的 user message 破坏 Gemini API 的 function-call/function-response 顺序。模型失败时可以 rollback history；压缩成功时用新 history 重建 chat，但保留原 conversation 文件和 session 语义。

一次 tool batch 的实际状态是 `Validating → Scheduled → Executing → Success/Error/Cancelled`，或在执行前进入 `AwaitingApproval`。scheduler 同时维护 request queue、active calls、completed batch 和 cancellation cascade；工具还可以返回 tail call，用原 `callId` 替换成新的 queued call，因此一个模型 tool use 能展开为连续工具链而不立即结束。

### 2. 策略化能力平面

工具由 registry/agent registry/MCP 等来源组成，但是否可调用、是否需要确认、是否需要扩大 sandbox 权限由 policy engine 决定。策略包含 approval mode（如 plan、auto-edit、yolo）、命令安全判断、workspace 约束和持久化规则。因而“工具存在”与“工具当前可执行”是两个不同问题；模型看到的工具集合还会受 agent、策略和运行模式影响。核心证据见 [`policy-engine.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts) 与 [`scheduler.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/scheduler.ts)。

`ToolRegistry` 区分 all-known tools 与 active tools；MCP、discovered tools、skills 和 sub-agent tools 可以已注册但不一定在当前请求暴露。`processTurn()` 在最终模型选定后重新 `setTools(modelToUse)`，scheduler 执行时再次从 registry 查找并 build invocation，形成“请求声明面”和“执行校验面”。动态工具因此不只是 prompt 文本追加：工具声明属于模型请求配置的一部分，具体是否破坏 provider 的 KV cache 需要请求实验才能确认。

### 3. Context 与长期会话

上下文不是静态 system prompt。环境目录、IDE context、memory、agent history、工具输出 masking 和 chat history 会共同构造请求；`ChatCompressionService` 在 token 预算压力下将旧历史压缩，并发出压缩事件。session recording、summary/scratchpad 和 memory service 使长会话具有恢复与跨轮次积累能力。

v0.59 的 Context Management 已是独立 graph/pipeline：`ChatRecordingService` 同步为带 stable ID 的 `AgentChatHistory`，`ContextGraphMapper` 映射为 graph nodes，`ContextWorkingBuffer` 保存 pristine graph 和可变 graph，`PipelineOrchestrator` 按 trigger 运行同步/异步 processors，`ContextManager` 在 pressure barrier 后执行 GC、distillation、normalization、truncation，再 render 为 `apiHistory` 与 `pendingApiHistory`。当前 request 只作为 late-bound preview 加入 API history，UI/recording 仍可保留原始 request。

这相当于把“原始对话事实”和“模型看到的上下文快照”分离：异步 processor 只有在目标 node 仍存在时才能回写，stable IDs、buffer lineage 和 invariant checks 防止旧的异步结果覆盖新状态。它更接近 materialized context view，而不是传统的一次性摘要。

### 4. Environment 与安全执行

workspace、sandbox manager 和 sandboxed filesystem service 共同定义执行边界。命令可能先被安全分析，再进入本地/平台 sandbox；若需要额外权限，scheduler 将其建模为 sandbox expansion，而非让工具自行绕过限制。环境因此是由 `Config`、工作区、sandbox 和 approval policy 共同确定的 capability boundary。

源码中有两种 environment：执行 environment 由 workspace、`SandboxManager`、filesystem service 和平台 sandbox 实现决定；context environment 则包含 `sessionId`、`promptId`、traceDir、projectTempDir、token calculator、event bus、inbox 和 graph mapper，决定上下文 pipeline 的执行。`AgentLoopContext` 将 config、tool/prompt/resource registry、message bus、GeminiClient 和 sandbox manager 绑定成一次 agent turn/sub-agent loop 的 capability snapshot，不是全局 cwd。

## 从早期 CLI 到当前形态的重大演进

本次已从 depth=1 加深到 363 个 commit。以下节点是从历史提交和当前代码共同确认的架构事件：

1. **ContextManager 分离（`6e4e579`，2026-04-13）**：上下文从 chat history 拼接迁移到独立 ContextManager/Sidecar 与 graph pipeline，随后 `71f313b` 接入 `AgentChatHistory`。这一步建立了“事实 history / 请求 projection”的双层架构。
2. **Tool lifecycle 正式化（`005e0cf`，2026-05-05）**：tool call 从隐式 promise 结果变为显式 lifecycle state；`48e9d80` 进一步修复 callId 过滤，说明并发工具的状态隔离成为一等问题。
3. **Unified session bundle（`ccee31d`，2026-05-13）**：session bundle v2 与 history reconstruction 使主 agent、subagent trajectory、tool records 和恢复流程进入统一持久化语义。
4. **Context snapshot/recovery 与 explicit caching（`8a3fde4`、`62e97b1`，2026-05-11）**：上下文管理开始考虑 snapshot 跨 session 恢复和 system-instruction 稳定 hash 的显式 cache，而非只做长度压缩。
5. **取消与 rollback 强化（`783f6cb`、`812f7a2`，2026-08-13/24）**：多 turn request 在取消时整体 rollback，history rollback 与 retry nudge 优化将异常恢复从 UI 行为提升为 runtime 一致性处理。
6. **可信 workspace 与 MCP 安全（`0bd1d43`、`3c311be`，2026-08-28）**：workspace trust fail-closed、restricted mode 过滤 MCP、MCP OAuth SSRF 防护，说明 capability boundary 已扩展到工作区信任和外部服务发现。

核心主线不是“增加更多工具”，而是连续把事实、投影、执行状态、权限和恢复从隐式控制流中抽出来。

## 不变量与定位

模型仍以“消息历史 + 当前工具声明”驱动；工具结果仍回注到下一次模型请求；approval 与 sandbox 仍是执行前的外部控制点。Gemini CLI 的产品化重点是把这些不变量包装成可交互、可观测、可恢复的 runtime，而不是追求最小抽象。

官方使用文档与源码是一致的：用户可以 `--resume` 恢复 project-scoped session、用 `/rewind` 选择只回退对话/只回退文件/两者同时回退，使用 `--worktree` 隔离任务，使用 approval mode、sandbox expansion 和 active tools 控制执行面；这些不是 CLI 表面功能，而是上面 session、history、policy 和 environment 边界的产品化投影。参见固定版本的 [Session Management](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/docs/cli/session-management.md)、[CLI Reference](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/docs/cli/cli-reference.md)、[Sandboxing](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/docs/cli/sandbox.md) 和 [Tools](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/docs/reference/tools.md)。

## 未确认事项

- 未在本次研究中运行真实模型或 sandbox，因此没有验证不同平台的实际隔离强度。
- 本次 history 已取得 363 个 commit，但仍不是从项目诞生开始的完整历史；更早的原始 CLI 演进需要继续向前 deepen。
- 历史提交的架构含义主要由 commit message、diff 和当前实现交叉确认，尚未对每个节点执行旧版本 runtime 回归实验。

## 附录 A：从用户操作反推 Runtime 状态

### A.1 启动与 workspace trust

用户执行 `gemini` 时，CLI 首先确定项目根、工作目录、配置 profile、model、approval mode、sandbox 和 session storage。官方文档把 session 绑定到 project hash，而不是简单绑定进程；这意味着同一个目录下的多次启动可以发现同一批历史，切换目录则切换 session namespace。

源码层面，`Config` 持有运行期配置和 services，`AgentLoopContext` 把它与当前 prompt、registry、message bus 和 sandbox manager 组合起来。workspace trust 是 capability gate：在 restricted/untrusted 状态下，MCP server 和高风险工具不应仅因为“已配置”就进入可用能力集合。v0.59 的 `0bd1d4397` 将这一点强化为 fail-closed，说明 trust 不是 UI 提示，而是执行前的策略输入。

### A.2 用户输入与持续会话

用户输入形成一个 `prompt_id`。同一个 prompt 可能经历：

1. `BeforeAgent` hook 添加额外 context 或阻止执行；
2. `processTurn` 创建 `Turn` 并渲染 context；
3. 模型输出 tool calls；
4. scheduler 等待审批、执行和回注结果；
5. loop detector 发现重复后注入 recovery feedback；
6. next-speaker check 判断模型是否需要继续；
7. `AfterAgent` hook 要求停止、清空 context 或继续执行。

这些 continuation 仍然属于同一个 prompt 的执行链，但每一次 `Turn.run()` 都是新的模型 stream。用户按 Ctrl-C 时，`AbortSignal` 取消 scheduler/stream，产生 `UserCancelled`；新的输入不会简单覆盖旧消息，而要等待或关闭悬空 function-response，防止 API history 非法。

### A.3 `/resume`、`/rewind` 与 `/compress`

`/resume` 是从持久化 session 重建 `GeminiChat` 与 durable history；它不是把终端滚屏重新显示一遍。`/rewind` 的产品语义至少涉及两份状态：聊天事实和工作区文件状态。用户可以保留文件但回退 conversation，也可以保留 conversation 但回退文件，或者两者一起回退。session management 文档中的“project-specific history、automatic saving、checkpoint、rewind”对应源码中的 recording service、history IDs、file history 和 restore commands。

`/compress` 则不是删除 JSONL 原始记录。压缩服务生成新的模型可见 history；成功后 `GeminiClient` 用新 history hot-restart `GeminiChat`，同时把旧 conversation/file path 交给 resumed session data。压缩失败时可能选择 truncation；这种轻量干预不等于完整重建 chat。由此可以区分：

| 用户操作 | durable record | API context | 工作区 |
| --- | --- | --- | --- |
| resume | 读取并重建 | 重新 render | 保留/按 checkpoint 恢复 |
| rewind chat | 截断或追加 rewind record | 重新生成 | 不变 |
| rewind files | 保留 chat | 可继续使用旧上下文 | 回退文件 |
| compress | 原始记录保留 | summary/distilled projection | 不变 |
| cancel | 记录取消/未完成状态 | rollback/close dangling turn | 已执行变更可能保留，取决于工具与 rewind |

## 附录 B：一次工具调用的完整状态机

### B.1 Ingestion

模型在 `Turn` stream 中产生 function call 后，`Turn` 创建 `ToolCallRequestInfo`。这个 request 包含 call ID、名称、参数、prompt ID、父调用、scheduler ID、checkpoint、trace ID 和是否 client initiated。它是 tool call 的事实身份，而不是 UI 临时对象。

`Scheduler.schedule()` 接受单个或批量 request：

1. 如果已有 batch/active call，则放进 request queue；
2. 否则创建 batch，并捕获当前 approval mode；
3. 对 batch 排序，让 topic update 等控制型工具先于动作工具；
4. 从 `ToolRegistry` 查找工具；
5. 为不存在的工具生成 `TOOL_NOT_REGISTERED` error；
6. 对存在的工具执行 `tool.build(args)`，构造 invocation；
7. 将 call 放入 state manager queue。

### B.2 Validation 与 policy

`ValidatingToolCall` 除 request 外还持有 declarative tool、invocation、start time、approval mode 和 scheduler lineage。policy engine 会结合工具 kind、参数、当前 mode、workspace、sandbox 和用户持久化规则作出 decision。常见路径是：

```text
request
  → tool exists?
  → args/schema valid?
  → policy allows?
  → safe without prompt? ── yes → Scheduled
                         └─ no  → AwaitingApproval
  → execute
```

审批不是简单的 boolean。`WaitingToolCall` 保存 serializable confirmation details、correlation ID、approval mode 和 invocation；message bus 把请求传递给 TUI、IDE、ACP 或其它宿主，宿主的响应再通过 correlation ID 找回原 call。这样用户切换 surface 时，审批语义仍属于 runtime call。

### B.3 Execution 与 live output

进入 `Executing` 后，`ToolExecutor` 承担真正调用。shell tool 可以报告 live output、PID、progress 和 output file；MCP tool 可以通过 `CoreEvent.McpProgress` 更新 progress。state manager 每次状态变化都发出 `TOOL_CALLS_UPDATE`，所以 UI 不需要读取执行器内部变量。

执行完成后，如果是普通结果，call 变为 `Success/Error` 并进入 completed batch；如果返回 tail call，原 call 会被记录为中间结果，再由新的 tool request 替换并放到 queue 前端。tail call 保留 original request name/args，避免日志只显示最后一个内部工具。

### B.4 Cancellation

取消需要覆盖四处：等待中的 request queue、queued calls、active calls 和正在运行的 child process。`Scheduler.cancelAll()` 先拒绝 request queue，再将 active non-terminal calls 置为 Cancelled，最后清空 queue。外部 `AbortSignal` 还会让 `_processNextItem()` 停止推进。这样“用户取消”不会只停止 UI spinner，却留下一个仍然能够回写历史的后台工具。

### B.5 Sandbox expansion

如果工具返回 `sandbox_expansion_required`，scheduler 不把它当普通 command error：解析 root command 与 additional permissions，构造 `sandbox_expansion` confirmation，更新 call args/invocation，再进入 `AwaitingApproval`。批准后用扩展权限重新执行；拒绝则保留原始 denial 和 shell output，并结束为 error。这个路径把 sandbox 失败转化为显式用户决策，和 approval mode 的普通工具审批是同一个 runtime 状态系统。

## 附录 C：Context Management 的数据模型

### C.1 Durable history 与 graph node

`AgentChatHistory` 是 durable history 的 strong owner。每个 `HistoryTurn` 由 stable ID 与 Gemini `Content` 组成；`push`、`set`、`rollback` 使 history 具有可控的变更边界。`GeminiChat` 初始化时优先使用内存 history，其次使用 resumed session records；这保证 compression hot restart 不会重新读到旧文件状态覆盖新状态。

`ContextGraphMapper` 把 history turn 映射为 graph node。node ID 不是每次 render 随机生成，因此 processor 可以表达 `replacesId`、`abstractsIds` 和 lineage。原始 node 与 processed node 的关系支持审计：模型看到的是 projection，但研究者仍能追踪它来自哪些消息。

### C.2 Working buffer

`ContextWorkingBuffer` 同时承担两种职责：保存 pristine graph，和接收 processor result 的可变 graph。它不是直接修改 `AgentChatHistory`，因为 context GC、distillation 和 truncation 可能只适合某次请求；只有同步管理结果确认后才回写 master buffer。`ContextManager` 是 pull master，orchestrator 通过 node provider 获取最新节点，避免异步 pipeline 对过期数组进行写回。

### C.3 Trigger 与 pipeline

pipeline 有同步和异步两类。同步 processor 在 `renderHistory()` 的 pressure barrier 前完成；异步 processor 可以在后台运行，但同名 pipeline 由 mutex/scheduled set 串行化。每次 processor 有 target node set，并通过 protected turn IDs 避免修改当前请求或活跃任务的节点。

典型 render 顺序是：

```text
sync durable history
        ↓
preview pending user request
        ↓
hot-start calibration + wait async pipelines
        ↓
evaluate GC/distillation/normalization triggers
        ↓
render API history + pending API history
        ↓
harden sentinels + check invariants
```

`LiveInbox` 允许外部事件进入 context pipeline；`InboxSnapshot` 让一次 processor chain 读取一致的 inbox 视图，并在完成后统一 drain consumed messages。这一点很像事件处理器的 snapshot，不是简单的 prompt string interpolation。

### C.4 Token accounting

Context Manager 使用 chars-per-token、token calculator 和模型 ground truth 维护预算。render 时先估算请求 token；模型 finished event 返回真实 prompt token 后，通过 event bus 反馈给 context environment，校准后续计算。`baseUnits` 和 processed nodes 让压缩、摘要与 token pressure 不再完全依赖粗略字符数。

### C.5 Late binding

当前 user request 先作为 preview node 运行 `new_message` processors，再与 master history 合并。`apiHistoryOverride` 将 processed pending content 放到即将发送的 API history；`displayContent` 仍采用原始 request。这样 hooks/context processors 可以改变模型输入，却不必把内部管理标记暴露给用户 transcript。

## 附录 D：Prompt、工具与 KV cache

### D.1 哪些内容会影响模型请求

在 v0.59，至少下列因素参与请求构造：

- core system prompt 与 memory；
- workspace/environment context 与 `GEMINI.md` 等项目指令；
- durable chat history 或 context graph render 后的 history；
- 当前 user request、IDE context、文件/图像 parts；
- active tool declarations；
- model-dependent tool descriptions；
- approval mode、plan mode、MCP/agent/skill capability；
- provider/model routing 后的 model config。

因此“工具动态注入 prompt”需要拆成两种情况：一是工具 schema 作为 API tools 配置变化；二是工具描述/发现结果作为文本或 message context 变化。源码能够确认两者会影响请求，但无法确认 Gemini 服务端对不同字段使用何种 KV cache key。只有记录连续请求 payload、工具集合、system instruction hash 和 token usage，才能判断命中变化。

### D.2 Model routing 与工具 schema

`processTurn()` 先构造 routing context，再选 model；选定最终 model 后调用 `setTools(modelToUse)`。`currentSequenceModel` 让同一个 prompt 的 continuation 保持模型粘性，同时当模型发生变化时清空 sequence state。这样避免在同一工具链中因每次请求重新 routing 导致 schema/能力漂移。

### D.3 Tool output masking

工具输出是 history 中最容易膨胀的内容。`ToolOutputMaskingService` 在请求前对历史做 masking，减少 token，但不会等同于删除 tool record；masking 后的 history 可以通过 recording/context history 继续追溯。它与 Context Graph 的 distillation 是两种层次：前者针对 bulky output，后者针对结构化历史节点。

## 附录 E：Sub-agent、MCP 与宿主边界

### E.1 Sub-agent

agent registry 可以加载本地 agent definition，`AgentScheduler` 调度 local/remote invocation；`AgentLoopContext.parentSessionId`、scheduler ID 和 parent call ID 提供父子 lineage。子 agent 不是简单 prompt delegation：它有自己的 tool registry/loop context，仍然受父级能力和 cancellation 关系约束，并需要把 trajectory/结果回流到主 session。

### E.2 MCP

MCP server 发现、OAuth metadata、server filtering、resources 和 tool calls 都通过 core services/registry 进入 runtime。v0.59 的安全提交说明 MCP 不仅是扩展接口，也是 SSRF、trust、restricted mode 和 approval 的安全边界。官方 CLI 允许 `--allowed-mcp-server-names`，源码中的 policy/registry 负责将“配置存在的 server”过滤为“当前 session 可用的 server”。

### E.3 多宿主

`packages/core` 导出 client、scheduler、policy、context、sandbox、session 和 agent protocol；CLI package 提供交互 TUI/命令行；SDK/A2A/ACP 提供协议宿主。`AgentSession` 以 event stream 暴露 agent activity，并支持 subscribe、abort、event replay/reattach。这个边界保证宿主消费 typed event，而不是直接依赖 `GeminiClient` 内部变量。

## 附录 F：历史演进的证据链

### F.1 早期阶段：单体 loop 的约束

从当前历史向前看，早期代码仍以 chat、tool 和 CLI 入口紧耦合为主；其架构问题不是不能运行，而是难以同时满足长 session、异步 approval、sub-agent、context pressure 和多宿主。后续 commit message 中反复出现 rollback、session reconstruction、callId isolation、policy bug、scheduler starvation 等问题，说明复杂度是在真实产品行为暴露后逐步显式化的。

### F.2 2026-04：ContextManager/Sidecar

[`6e4e579`](https://github.com/google-gemini/gemini-cli/commit/6e4e579ff) 引入 decoupled ContextManager and Sidecar；[`71f313b`](https://github.com/google-gemini/gemini-cli/commit/71f313b51) 接入 new ContextManager 与 AgentChatHistory。这是架构级变化，因为它移动了 history ownership、token pressure、processor 和 render 的职责，而不是增加一个普通功能。

### F.3 2026-05：tool lifecycle 与 session bundle

[`005e0cf`](https://github.com/google-gemini/gemini-cli/commit/005e0cfc5) 正式化 tool lifecycle；[`ccee31d`](https://github.com/google-gemini/gemini-cli/commit/ccee31d13) 引入 unified session bundle v2/history reconstruction；[`a7936df`](https://github.com/google-gemini/gemini-cli/commit/a7936df7c) 与 [`413416d`](https://github.com/google-gemini/gemini-cli/commit/413416d58) 继续加入 subagent trajectory。此阶段将“工具执行事实”和“会话恢复事实”统一到可重建记录。

### F.4 2026-05：snapshot、cache 与异步一致性

[`62e97b1`](https://github.com/google-gemini/gemini-cli/commit/62e97b14a) 引入 main agent explicit context caching with stable SI hashing；[`8a3fde4`](https://github.com/google-gemini/gemini-cli/commit/8a3fde4c3) 改进 snapshotter model config；[`055e0f6`](https://github.com/google-gemini/gemini-cli/commit/055e0f645) 修复 snapshot recovery across sessions。这些提交表明 context 已从一次性压缩转向可缓存、可恢复的派生状态。

### F.5 2026-08：rollback、安全与信任

[`783f6cb`](https://github.com/google-gemini/gemini-cli/commit/783f6cb49) 将 cancellation rollback 扩展到整个 multi-turn request；[`812f7a2`](https://github.com/google-gemini/gemini-cli/commit/812f7a2bc) 优化 history rollback/retry nudge；[`0bd1d43`](https://github.com/google-gemini/gemini-cli/commit/0bd1d4397) 强化 workspace trust fail-closed 与 restricted MCP filtering；[`3c311be`](https://github.com/google-gemini/gemini-cli/commit/3c311beac) 修复 MCP OAuth metadata SSRF。架构主线由此从“能完成任务”延伸到“失败时不能留下错误状态，未信任环境不能扩大能力”。

## 附录 G：验证计划

当前报告是 source reading + history reading，尚未做 runtime experiment。要把推断变成可验证结论，下一轮应执行：

1. 同一 project 连续发送两轮，记录 session JSONL、history IDs、tool records 和 prompt token usage。
2. 在工具等待 approval 时注入用户输入、切换 model、切换 approval mode，观察 prompt ID、scheduler state 和 history 是否保持一致。
3. 触发 shell sandbox denial，分别批准和拒绝 expansion，检查 command 是否重跑、是否产生重复 tool record。
4. 触发 context compression，比较 durable transcript、rendered API history、pending API history 和 resumed session。
5. 在 MCP server list 变化、model change、skill discovery 后记录 tools schema，比较 system/tool request hash 与 token/cache usage。
6. 启动 sub-agent 并取消父任务，验证 parent/child scheduler、session trajectory 和 cancellation cascade。
7. 使用 `/rewind` 的三种模式，验证聊天事实、文件状态和 checkpoint 的组合恢复。

这些实验才能回答“动态工具具体如何影响请求缓存”“session snapshot 是否可跨进程完全恢复”“sandbox expansion 是否幂等”等仅靠源码不能确定的问题。

## 附录 H：核心 Runtime 不变量

### H.1 History 合法性不变量

Gemini API 对 function call 与 function response 的相邻关系有严格要求。`GeminiChat.closeUnansweredToolResponseTurn()`、对 function response 的特殊记录路径、history rollback 和 `AgentChatHistory` stable ID 都服务于同一个不变量：发送给 API 的 history 必须是合法且可重建的，而用户可见 transcript 仍应保留足够的事实。这个不变量比“消息顺序看起来正确”更强，因为 context management 可能改变 API projection，但不能让 function response 脱离其 call。

### H.2 Tool call identity 不变量

`callId` 是工具调用的主要身份，`prompt_id` 是用户输入/agent loop 的范围身份，`schedulerId` 是执行调度器身份，`parentCallId` 是嵌套关系身份。状态更新、MCP progress、日志和 UI 事件都必须能通过这些 ID 找回同一调用。v0.59 scheduler 的 `activeCalls` map、queue、completed batch 和 `getToolCall()` 形成单一 lookup 路径；这也是为什么历史上需要修复 callId filter 与 session cross-talk。

### H.3 Prompt continuation 不变量

loop recovery、next-speaker、hook continuation 都会产生新的 model request，但不应把一个 user prompt 错误切成多个独立用户操作。`prompt_id` 不变，`currentSequenceModel` 保持模型粘性，hook state 用 active call counter 去重，最后一个 continuation 完成后才清理 hook state。这个设计让“模型被要求继续”与“用户发送了新的消息”在 runtime 中可区分。

### H.4 Context projection 不变量

context processor 可以替换、摘要、蒸馏或截断 node，但不能改变 durable history 的身份链；异步结果只能作用于仍在 buffer 中的 targets；受保护的当前 turn 和 active task 不能被 GC。`ContextManager` 的 `checkContextInvariants()`、node lineage、preview node 分离和 pressure barrier 共同保证：模型可以看到变化的 projection，但旧 pipeline 不能覆盖新事实。

### H.5 Cancellation 不变量

取消的目标不是“停止生成文字”而是停止这次 prompt 的所有继续路径：LLM stream、tool queue、active tool、MCP progress、hook continuation、loop recovery 和 after-agent continuation。`AbortSignal` 被传入 context render、model stream 和 scheduler；`Scheduler.cancelAll()` 对 queue/active calls 做级联收敛；`GeminiClient` 将 abort 统一转换为 `UserCancelled` event。仍需实验确认已执行的文件变更何时自动 rewind，但控制流层面不会继续向模型发送隐式 `Please continue.`。

## 附录 I：核心源文件与责任映射

| Runtime 责任 | 源码位置 | 研究含义 |
| --- | --- | --- |
| 主 loop | [`core/client.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/client.ts) | prompt/turn/continuation、model routing、hook、compression |
| API history | [`core/geminiChat.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/geminiChat.ts) | 串行发送、合法 history、recording 协调 |
| turn event | [`core/turn.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/turn.ts) | 流式 response 与 tool request 的 typed event |
| tool state | [`scheduler/types.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/types.ts) | call lifecycle 数据结构 |
| tool orchestration | [`scheduler/scheduler.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/scheduler.ts) | queue、approval、execute、tail call、sandbox expansion |
| state transitions | [`scheduler/state-manager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/state-manager.ts) | active/completed call 的单一状态所有者 |
| policy | [`policy/policy-engine.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts) | approval mode、安全规则、workspace 与 sandbox 决策 |
| durable history | [`core/agentChatHistory.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/agentChatHistory.ts) | stable turn ID、rollback、raw content |
| session recording | [`services/chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/services/chatRecordingService.ts) | JSONL、metadata、tool records、resume |
| context owner | [`context/contextManager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/context/contextManager.ts) | graph sync、preview、pipeline barrier、render |
| context execution | [`context/pipeline/orchestrator.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/context/pipeline/orchestrator.ts) | sync/async processor、mutex、inbox snapshot |
| loop capability | [`config/agent-loop-context.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/config/agent-loop-context.ts) | 单个 turn/sub-agent 的依赖与 capability snapshot |

### I.1 为什么这些边界适合横向比较

对其它 coding agent 做比较时，应比较责任归属而不是类名。例如：

- 谁拥有 durable conversation facts？
- 谁决定一个 user input 是否启动新的 turn？
- tool approval 是 UI callback、turn state 还是 session policy？
- context compression 修改原始历史，还是生成 API projection？
- cancellation 是否只杀 LLM stream，还是级联到工具和 continuation？
- environment 是 cwd、sandbox backend，还是包含 context/event/identity 的 execution capability？
- sub-agent 是普通 tool、独立 session，还是有父子 scheduler lineage 的 nested runtime？

Gemini CLI 的答案是：history 由 recording/chat 拥有，prompt 由 client scope，tool call 由 scheduler 拥有，policy 由 policy engine 拥有，context projection 由 ContextManager 拥有，execution 由 sandbox/tool executor 拥有，宿主通过 event/protocol 消费结果。这种责任分解就是其真正的架构，而不是目录结构本身。

### I.2 当前设计的代价

边界显式化提高了产品可靠性，也引入了状态同步成本：

1. durable history、chat history、context buffer、API override 之间需要保持一致；
2. tool state、message bus、TUI/IDE event stream 之间需要 correlation ID；
3. async context pipeline 需要 barrier、mutex、target protection 和 stale-result 检查；
4. model routing 可能改变 tool descriptions、token limits 和 cache identity；
5. hook、loop recovery、next-speaker 和 retry 都可能递归调用 client；
6. sub-agent 必须处理 parent cancellation、session recording 和 tool namespace。

因此 Gemini CLI 的复杂度主要不是来自 agent loop 的算法，而是来自“在长期、并发、可审批、可恢复的产品环境中维持多个状态视图的一致性”。

## 附录 J：研究结论的证据等级

### 已由源码直接确认

- `GeminiClient` 可以在一个 prompt 中递归产生多个 `Turn`；
- `GeminiChat` 使用 durable history 和 send serialization；
- scheduler 有显式 tool call status、queue、active calls、approval 和 cancellation；
- policy engine 与 sandbox manager 共同决定执行许可；
- ContextManager 使用 graph/buffer/pipeline 生成 API context projection；
- session recording 保存 conversation、tool、token 和 resume 相关数据；
- AgentLoopContext 为 turn/sub-agent loop 提供固定依赖集合。

### 由历史 commit + 当前实现交叉确认

- ContextManager/Sidecar 是架构级责任迁移，而不是普通 feature；
- unified session bundle 与 history reconstruction 是恢复语义的增强；
- tool lifecycle 正式化是为并发、审批和 UI cross-talk 服务；
- rollback、workspace trust、MCP filtering 和 sandbox expansion 是 runtime 安全/一致性补强。

### 仍属于解释或待验证

- Gemini provider 对 tools/schema/system instruction 的实际 KV cache key；
- 所有平台 sandbox 的真实隔离强度；
- checkpoint rewind 对已执行文件变更的自动恢复边界；
- sub-agent trajectory 在主 session 中的最终可见形式；
- async context pipeline 在高并发真实会话中的延迟和 starvation 行为。
- “动态工具是否每轮重建 prompt、以及具体 provider 的 KV cache 命中策略”需要结合请求日志和 provider 实验，源码只能确认工具声明会参与请求构造，不能推出服务端 cache 行为。

## 附录 K：Gemini CLI Runtime 的最终压缩模型

从架构研究角度，Gemini CLI v0.59 可以压缩为一个“事实—投影—执行—回写”闭环：

```text
durable session/history
          ↓
context graph + working buffer
          ↓ render
model request + active tool snapshot
          ↓
Turn / scheduler / policy / sandbox
          ↓
tool observation + events + usage
          ↓
history recording / checkpoint / context feedback
```

这个闭环中有四个不能混淆的对象：

1. **事实**：用户消息、模型响应、tool call、tool result、审批决定、取消和终止原因；
2. **投影**：压缩、masking、distillation、system instruction、active tools 共同生成的 API history；
3. **执行**：scheduler、policy、sandbox 和 tool executor 组成的可暂停状态机；
4. **反馈**：usage、token ground truth、loop recovery、context processors 和 session recording 对下一轮的影响。

Gemini CLI 的架构级演进，正是把这四类对象从一个同步 `Content[]` 列表中拆出来，并为每类对象建立自己的身份、生命周期和恢复规则。ContextManager 解决投影一致性，scheduler 解决执行一致性，AgentChatHistory 解决事实身份，policy/sandbox 解决 capability 边界；它们通过 prompt、call、turn 和 session ID 重新关联。

这也给出一个更准确的定位：Gemini CLI 不是单纯“带工具的聊天 CLI”，而是一个具有 materialized context view、显式 tool state machine、可恢复 session bundle 和 environment policy gate 的 coding-agent runtime。它的主要成本是多视图一致性；它的主要收益是长任务在压缩、取消、审批、子 agent 和 workspace trust 变化后仍然能够解释和继续。
