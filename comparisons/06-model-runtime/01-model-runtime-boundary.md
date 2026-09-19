---
title: Coding Agent 的模型运行时：Provider、请求与决策边界
series: Coding Agent 的模型运行时：Provider、流式推理与模型切换
part: 1
reviewed_at: 2026-09-17
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的模型运行时：Provider、请求与决策边界

## 结论

在 Coding Agent 中，模型运行时不是一个负责发送 HTTP 请求的 Provider Adapter。它是连接 Context、模型能力、流式响应、工具调用和 Step 生命周期的决策边界。

一个模型调用至少包含以下对象：

```text
Model identity
  + Provider capability
  + Request context
  + Tool schema
  + Sampling / reasoning settings
  + Stream lifecycle
  + Usage and cost accounting
  + Retry / cancellation policy
       ↓
  Model response
       ↓
  assistant content / tool calls / finish reason
       ↓
  Runtime step transition
```

如果只把模型看成 `generate(prompt) -> text`，就无法解释 coding agent 中最关键的现象：模型输出为什么会改变工具执行，工具结果为什么会改变下一次请求，模型切换为什么会影响 Context 和能力集合，以及流式响应中断后为什么不能简单重试。

本文先定义模型运行时的边界，比较 Codex、Pi、OpenCode、OpenHands、Gemini CLI、Kimi Code 和 mini-SWE-agent 在这一边界上的不同设计。后续文章再分别研究流式生命周期、模型切换与上下文一致性，以及 Provider 故障和成本控制。

## 1. Model Runtime 的严格定义

本文将 Model Runtime 定义为：

> 将一次可执行的 Agent 请求转换为模型调用，并把模型产生的增量或最终结果转换为可验证的 Runtime 状态变化的组件集合。

它至少负责五类事情：

1. 将 Context 转换为 provider 可接受的请求；
2. 根据模型能力选择或裁剪 tools、modalities 和参数；
3. 管理流式响应、部分结果和终止原因；
4. 将 assistant response 解析为文本、tool call、reasoning 或错误；
5. 把结果提交给 Step/Turn 状态机，而不是直接决定外部副作用。

模型运行时不应拥有所有状态。Session 历史、Environment、权限和工具执行仍由更高层 Runtime 或专门组件负责；模型运行时提供的是一次推理的请求和响应语义。

## 2. Provider、Model 与 Capability 不是同一个概念

### 2.1 Provider

Provider 是请求传输和服务端协议的边界，例如认证、endpoint、请求格式、流式协议、错误映射和 usage 返回。它回答：

- 请求发到哪里；
- 使用哪个协议；
- 如何认证和限流；
- provider 如何表示 tool call 和 stream event；
- provider 错误如何映射成 Runtime 错误。

### 2.2 Model

Model 是某个 provider 下可选择的推理能力和配置集合。它至少影响：

- context window；
- 支持的工具调用格式；
- 支持的输入模态；
- reasoning 或 thinking 能力；
- 最大输出长度；
- 价格和速率限制；
- 对 system/developer instruction 的处理方式。

同一 Provider 的不同模型不一定共享完全相同的请求约束。反过来，不同 Provider 的同名模型也不一定有相同的 tool call、stream 或 usage 语义。

### 2.3 Capability

Capability 是 Runtime 在当前请求中允许模型使用的能力。它不是模型静态能力的完整列表，而是以下因素的交集：

```text
EffectiveCapabilities =
  ModelCapabilities
  ∩ ProviderProtocol
  ∩ RuntimeToolSet
  ∩ PermissionPolicy
  ∩ EnvironmentAvailability
```

模型支持 function calling，不代表当前 Session 可以调用所有工具；Runtime 注册了工具，也不代表当前 Environment 或权限允许执行工具。

### 2.4 Adapter

Adapter 负责把统一的内部请求和 provider 的特定协议互相转换。它不应悄悄改变工具语义、审批语义或历史责任。如果 adapter 将 provider 的部分流式事件直接吞掉，上一层可能无法判断模型是否已经生成了完整 tool call。

## 3. 一次模型请求的生命周期

一个完整的模型 Step 可以抽象为：

```text
Step admitted
  ↓
resolve model and provider
  ↓
resolve effective capabilities
  ↓
assemble Context and tool schema
  ↓
freeze request identity / settings
  ↓
send provider request
  ↓
consume stream events
  ↓
validate and normalize response
  ↓
persist assistant result
  ↓
classify finish reason
  ↓
continue with tools / finish Step / fail Step
```

每个阶段都有不同的失败语义：

- Context 组装失败：请求尚未发送；
- capability 解析失败：工具集合不可信，不能继续；
- provider 连接失败：可能尚未提交，也可能服务端已接受；
- stream 中断：响应可能只有部分内容；
- response parse 失败：需要保留原始响应或错误上下文；
- assistant result 持久化失败：模型已经作出决策，但 Runtime 未确认接受；
- tool call 解析成功：只表示获得了动作请求，不表示工具已执行。

模型运行时的核心责任，是把这些状态边界传递给上层，而不是把一切都包装成一个字符串或一个通用异常。

## 4. Request Identity 与 Step Identity

模型调用至少需要区分：

```text
session_id
turn_id
step_id
request_id
provider_request_id
assistant_message_id
tool_call_id
```

它们的生命周期不同：

- `step_id` 标识一次 Agent Step；
- `request_id` 标识 Runtime 发起的一次模型请求；
- `provider_request_id` 是服务端或网络层的请求身份；
- `assistant_message_id` 标识模型响应在 Session/History 中的投影；
- `tool_call_id` 标识模型请求出的具体动作。

如果 provider 超时后重新发送请求，新的 `request_id` 不应覆盖旧 request 的事实；如果 provider 返回相同或重复的 tool call，Runtime 也必须通过 call identity 判断是否已经接受或执行。

Kimi Code v2 通过 StepRequest、队列和请求定型把请求身份放在 loop 边界；Codex 的 StepContext 则将模型设置、工具路由和 Environment 条件绑定到一次 Step。[^kimi-request] [^codex-step]

## 5. Context 与 Tool Schema 的请求边界

工具定义是模型请求的一部分，但工具执行不属于模型运行时本身。一次请求应冻结或记录：

```text
tool name
schema
description
capability version
permission context
environment reference
```

如果请求排队后才发送，工具集合可能已经变化。此时 Runtime 必须决定：

- 使用排队时的工具快照；
- 使用请求定型时的最新工具集合；
- 发现变化后拒绝旧请求；
- 将工具变化作为系统事实重新注入 Context。

Kimi Code 的 `materializeRequest()` 位于请求真正形成模型输入的边界；Pi 的 Agent loop 则从当前 loop config 生成 Context 和 tools snapshot。[^kimi-materialize] [^pi-agent]

这个问题也直接影响 KV cache。若动态工具、时间戳、Environment 状态和模型配置被放在稳定 prompt 前缀中，每次能力变化都可能使 provider 的前缀缓存失效；若所有动态信息都放在末尾，又可能影响模型对关键约束的注意。源码可以证明请求如何组装，不能单独证明 provider 的实际 cache hit rate。

## 6. Stream 是状态机，不是字符串流

模型 provider 的流式响应通常包含多类事件：

```text
stream_started
  ├── text_delta
  ├── reasoning_delta
  ├── tool_call_delta
  ├── usage_update
  ├── provider_warning
  └── stream_completed(finish_reason)
```

Runtime 需要处理事件顺序、重复片段、部分 JSON、多个 tool call 和中断。尤其是 tool call 的 arguments 可能跨多个 delta 到达，不能在第一段片段出现时就执行工具。

Gemini CLI SDK 的 Session loop 对模型响应和工具执行采用流式迭代；Pi 的 Agent loop 也将 assistant message 的增量更新、tool call 解析和工具执行分成准备与执行阶段。[^gemini-session] [^pi-execute]

流式 UI 更新与事实提交不是同一件事：

```text
delta received -> UI can render
                 ↓
response normalized -> Runtime can validate
                 ↓
assistant result persisted -> Step can use it as fact
```

如果仅收到半个 tool call，应该保存 partial stream 或标记响应未完成，而不是把不完整参数发送给工具。

## 7. Finish Reason 决定后续控制流

模型响应的结束原因不只是展示信息。典型 finish reason 包括：

- `stop`：模型结束当前响应；
- `tool_calls`：需要把工具调用交给执行层；
- `length`：输出达到限制，可能需要继续或压缩；
- `content_filter`：输出被 provider 策略截断；
- `cancelled`：Runtime 或用户终止；
- `error`：响应未形成可用结果；
- `unknown`：无法确定 provider 的终止语义。

如果 `tool_calls` 被误当作普通 assistant text，Agent 会停止在计划阶段；如果 `length` 被当作成功结束，任务可能遗漏未完成动作；如果 `cancelled` 被当作工具失败，下一次恢复可能重复请求模型。

Codex 的 Step/Turn 处理会将模型响应、工具调用和后续输入放入任务生命周期；OpenCode 则通过 Session message 到 LLM message 的转换维持不同消息类型和终止语义。[^codex-turn] [^opencode-context]

## 8. Model Switch 不是修改一个字符串

模型切换可能改变：

```text
context window
tool schema compatibility
system prompt requirements
reasoning field format
stream event format
usage accounting
sampling controls
parallel tool support
```

因此模型切换至少有三种语义：

1. **同一 Step 内切换**：当前请求失败或模型能力不足，使用另一模型继续同一决策；
2. **Step 边界切换**：当前 Step 完成后，下一个 Step 使用新模型；
3. **Turn 边界切换**：新的用户请求使用新模型，不改变既有 Turn 的历史事实。

同一 Step 内切换最危险，因为旧模型已经可能生成部分 tool call 或 reasoning。安全实现应先将旧请求标记为 aborted/recovered，再以明确的新 request identity 发送请求，而不是覆盖原响应。

Codex 的 step settings 将模型相关配置绑定到 Step；OpenCode 的 model resolver 根据 provider/model 能力决定 compaction 等运行行为；Pi 则通过 loop config 和 context snapshot 让调用方控制模型和工具集合。[^codex-settings] [^opencode-model-resolver] [^pi-config]

## 9. Retry 与模型运行时

模型请求 retry 需要回答四个问题：

1. 请求是否可能已经被 provider 接受？
2. 原响应是否包含可执行的 tool call？
3. 新请求是否仍然使用相同 Context 和能力集合？
4. retry 的结果如何与旧 request 关联？

网络失败不能自动推出“模型没有生成结果”。如果 provider 返回 request ID，应保留它并尝试查询或记录未知状态；如果无法查询，则新请求应被标记为 recovery attempt，并避免自动执行两个相互冲突的响应。

Codex 的执行记录保留 tool call metadata；Kimi Code 有 tool dedupe；Pi 的恢复逻辑对未完成 assistant generation 和工具调用采用不同策略。[^codex-recorder] [^kimi-dedupe] [^pi-recovery]

这里的去重只是 Runtime 的安全网。它不能保证 provider 不产生第二个模型响应，也不能保证模型在第二次请求中选择相同工具。

## 10. Cancellation 与 backpressure

流式模型调用需要支持取消，但取消必须向上层报告真实边界：

```text
cancel requested
  ↓
provider stream abort requested
  ↓
transport closed / provider acknowledged / unknown
  ↓
partial response classified
  ↓
Step cancelled or recovery-required
```

用户取消 UI 渲染，不一定等于 provider 请求已取消；provider 请求已取消，也不一定等于服务端没有产生输出。Runtime 还要处理 backpressure：模型输出速度可能高于 UI、解析器或工具准备速度，不能无限把 delta 堆在内存中。

Pi 的 `abort()` 与 `waitForIdle()` 明确区分取消和空闲等待；Codex 的 task cancellation 则位于任务和工具执行控制层。[^pi-abort] [^codex-abort]

## 11. Usage、成本与观测

Token usage 不只是计费指标，也影响 Context compaction、模型选择和预算终止。Runtime 应区分：

- provider 报告的输入 token；
- 本地估算 token；
- cache read/write token；
- reasoning token；
- tool output token；
- 重试产生的 token；
- 被截断但未完整计量的流。

如果 usage 只在完整响应后写入，流式中断可能导致成本记录缺失；如果本地估算和 provider 账单混为一谈，系统会错误地决定是否压缩或切换模型。

usage 应关联 `request_id`、model identity 和 attempt number，并与 assistant message、tool calls 和 Step 终态分开记录。它是 trace/metrics 事实，不应直接拼接到模型 Context。

## 12. 各 Agent 的模型运行时边界

### 12.1 Codex：Step 绑定执行条件

Codex 的 StepContext 将模型设置、MCP、ToolRouter、Environment 和相关指令条件绑定到一次请求；history manager 负责将内部历史投影为模型可见历史。[^codex-step] [^codex-history]

这使模型调用成为 Step 的一部分，而不是 Session 上一个无状态的 `generate` 函数。模型切换、权限重检和工具路由可以在 Step activation 时形成一致边界。

### 12.2 Pi：底层 loop 与 harness 分层

Pi 底层 Agent loop 通过 context snapshot 和 loop config 管理 model、tools、messages 和输入；harness 层进一步负责 durable operation、恢复和工具策略。[^pi-agent] [^pi-loop] [^pi-recovery]

这种分层适合扩展：库使用者可以替换 provider、system prompt 和 tool set；但底层 loop 本身不自动提供产品级的 Session 持久化或远程 provider 语义。

### 12.3 OpenCode：Provider resolver 与 Session projection

OpenCode 的 model resolver 负责 provider/model 能力和配置，Session runner 将内部消息转换为 provider 可接受的 LLM message。[^opencode-model-resolver] [^opencode-context]

其优势是 provider 适配与 Session 存储分离；代价是必须保证消息转换、compaction、工具 schema 和 model capability 的一致性。

### 12.4 OpenHands：模型调用位于 Agent server 运行时

OpenHands 的模型调用不是前端 conversation 的直接操作，而是 agent-server 与 workspace/sandbox 上下文结合后的后端行为。模型请求需要知道当前 session key、workspace 和可用服务。[^openhands-adapter]

这使模型运行时天然受到远程 Environment 生命周期影响：模型可以继续生成，但如果 sandbox 不可用，工具能力已经失效。

### 12.5 Gemini CLI：Session SDK 与动态指令

Gemini CLI SDK 的 Session 将 transcript、cwd、时间和动态 instructions 组合到模型请求；流式响应随后进入工具或下一轮请求。[^gemini-session]

这种设计强调 SDK 级复用和动态上下文刷新。它需要特别处理 dynamic instructions 与 stream resume 的时序，避免模型请求使用的 Environment 描述和工具执行时的真实环境不一致。

### 12.6 Kimi Code：请求定型与 v2 loop

Kimi Code v2 将 StepRequest 入队、admit 和请求定型分开，并在请求定型时生成实际模型输入；tool policy、permission gate 和 dedupe 位于模型响应进入执行层的边界。[^kimi-materialize] [^kimi-policy] [^kimi-permission]

这是一种请求级 Runtime：排队时保存工作身份，发送前定型 Context，响应后经过能力和策略检查。它适合处理并发和中断，但需要严谨地定义排队期间模型、工具和权限变化。

### 12.7 mini-SWE-agent：模型是 loop 的决策函数

mini-SWE-agent 默认实现将模型调用嵌入 Agent loop，使用 trajectory 中的 action/observation 继续决策。[^mini-default]

它以最小复杂度获得清晰的执行路径，但 Provider capability、流式恢复、模型切换和请求持久化不是核心 loop 的完整职责，需要由上层应用补充。

## 13. 设计原则

### 原则一：Provider 适配不应吞掉生命周期事实

底层协议差异可以归一化，但请求提交、流式中断、部分响应和终止原因不能被静默丢弃。

### 原则二：模型能力与当前能力分离

模型支持的能力不等于当前请求获得的能力。权限、Environment、工具注册和策略都必须参与 effective capability 计算。

### 原则三：请求在发送前冻结关键条件

Context、model identity、tool schema、policy version 和 Environment reference 至少要记录版本或快照，避免请求执行过程中发生无标记漂移。

### 原则四：流式增量不是完成事实

只有经过解析、验证和持久化的最终或明确中断状态，才可驱动 Step 状态转换。

### 原则五：模型重试产生新的决策身份

Retry 不应覆盖旧 request。旧请求的提交状态和新请求的响应必须可关联、可区分、可审计。

### 原则六：模型运行时不直接拥有副作用

模型可以提出 tool call，权限和执行层才决定是否实施。这样模型失败、切换或重试不会直接等价于重复执行外部动作。

### 原则七：终止原因必须进入控制流

`stop`、`tool_calls`、`length`、`cancelled` 和 `error` 会导致不同的 Step/Turn 行为，不能只作为 UI 文本。

## 14. 验证方案

### 14.1 Provider 模拟器

不使用真实 API Key，也可以构造 provider simulator，支持：

- 请求发送前连接失败；
- 请求已接受但响应丢失；
- text delta 后中断；
- tool call arguments 分片到达；
- 重复 tool call；
- 不同 finish reason；
- usage 延迟或缺失；
- cancel 请求未被服务端确认。

### 14.2 必要断言

```text
partial tool-call is never executed
stream interruption is not completed response
retry has a new request identity
old response cannot overwrite newer request state
model capability is not treated as permission
tool_calls finish reason enters execution path
cancelled request does not imply effect rollback
usage is attributed to the correct attempt
```

### 14.3 KV Cache 验证

源码只能说明 prompt 如何组装，不能证明 provider 的 KV cache 命中率。要验证缓存影响，需要记录：

- 完整序列化 prompt 或稳定前缀 hash；
- tool schema 版本；
- system/developer 指令版本；
- request 中动态字段位置；
- provider 返回的 cache read/write usage；
- 模型切换和 compaction 前后的命中情况。

因此，本篇不把“动态工具一定破坏 KV cache”作为结论，而只确认：动态工具改变了请求序列，是否破坏缓存取决于 provider 的缓存粒度和序列化布局。

## 未确认事项

- 各 Agent 对 provider 已接受但响应丢失的请求，是否有 request status 查询或幂等机制，需要实际 provider 验证。
- 各项目的流式响应是否完整保存原始 delta，不能仅凭最终 assistant message 确认。
- 模型切换时是否允许复用旧工具审批、旧 Context snapshot 或旧 reasoning 状态，需要继续阅读各项目的切换路径和测试。
- provider 实际 KV cache 命中、usage 计量和 reasoning token 统计不能由源码静态推出。

下一篇将专门研究流式推理的生命周期：增量响应如何进入消息、工具和 UI，partial response 如何恢复，以及 backpressure 和取消如何影响 Step 一致性。

## 参考源码

[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^pi-agent]: [Pi Agent request snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-settings]: [Codex model-dependent step settings](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L110-L160)
[^opencode-model-resolver]: [OpenCode model resolver and compaction capability](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/model-resolver.ts#L110-L190)
[^pi-config]: [Pi loop configuration and snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-loop]: [Pi agent loop context and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^opencode-execution]: [OpenCode Session execution](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^pi-abort]: [Pi abort and waitForIdle](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L319-L337)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
