---
title: Coding Agent 的流式推理生命周期
series: Coding Agent 的模型运行时：Provider、流式推理与模型切换
part: 2
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的流式推理生命周期

## 结论

流式推理不是把模型输出逐字显示到终端，而是一个跨越 Provider、传输层、解析器、消息历史、UI 和 Step 状态机的生命周期。

对 Coding Agent 来说，流式响应至少有四种不同语义：

```text
transport delta       网络收到了一段增量
semantic fragment     增量可以归入文本、reasoning 或 tool call
accepted response     Runtime 已验证并接受该响应
committed outcome     响应已持久化并可以驱动后续 Step
```

这四者不能互相替代。网络收到一段 JSON 片段，不代表 tool call 参数完整；UI 显示了文字，不代表 Runtime 已经接受 assistant message；模型连接断开，不代表 provider 没有生成后续内容；工具调用解析成功，也不代表工具已经执行。

因此，一个可靠的流式 Runtime 应将响应处理拆成：

```text
Provider stream
    ↓
Transport decoding
    ↓
Event normalization
    ↓
Per-request accumulator
    ↓
Semantic validation
    ↓
Message / tool-call commit
    ↓
Step transition
    ↓
Tool execution or Turn completion
```

本文研究这条链路及其失败边界。重点不是某个 provider 的协议，而是 Coding Agent 如何把不完整、可中断、可能重复的模型输出转换成一致的 Runtime 状态。

## 1. 为什么 Coding Agent 需要流式响应

流式输出有三个产品价值：

1. 降低用户等待首 token 的感知延迟；
2. 允许用户在长响应期间观察 reasoning、工具计划或进度；
3. 让 Runtime 更早知道模型正在请求工具或需要中断。

但流式输出也把一次原本接近原子的模型响应拆成多个时间点。每个时间点都可能发生：

- 用户取消；
- provider 断线；
- JSON 参数尚未完整；
- Session 持久化失败；
- UI 与 Runtime 观察顺序不一致；
- 旧请求的迟到事件覆盖新请求状态。

因此流式设计不是单纯的性能优化，而是改变了模型请求的状态模型。

## 2. 传输事件与语义事件

### 2.1 Transport event

Transport event 是协议层接收到的内容，例如 SSE data、WebSocket frame、HTTP chunk 或 provider SDK callback。它主要回答“网络传来了什么”。

Transport event 可能：

- 重复；
- 乱序；
- 缺少结束标志；
- 包含空心跳；
- 包含 provider 特有的 usage 或 warning；
- 在连接关闭时没有明确错误。

### 2.2 Semantic event

Semantic event 是 Runtime 归一化后的事件，例如：

```text
TextDelta
ReasoningDelta
ToolCallStarted
ToolCallArgumentsDelta
UsageUpdated
StreamCompleted
StreamFailed
StreamCancelled
```

它们不应简单等同于传输帧。一个传输帧可能同时包含文本和工具参数；多个传输帧可能共同组成一个完整 tool call。

### 2.3 State event

State event 是已经影响 Runtime 状态的提交，例如：

```text
AssistantMessageAccepted
ToolCallAccepted
StepCompleted
StepFailed
StepInterrupted
```

只有经过必要验证的 semantic event 才能产生 state event。这样可以保证某个半截 JSON 不会直接进入工具执行层。

## 3. 一个流式请求的状态机

```text
REQUEST_CREATED
      │ send
      ▼
STREAM_OPEN
      │ first event
      ▼
RECEIVING
   ┌──┼──────────────┬─────────────┐
   │  │              │             │
 text tool-call   usage        cancel/error
   │  │              │             │
   └──┴──────┬───────┴─────────────┘
             ▼
       ACCUMULATING
             │ complete
             ▼
       VALIDATING
       ┌─────┼──────┐
       │     │      │
      text  tools  invalid
       │     │      │
       ▼     ▼      ▼
   ACCEPTED  ACCEPTED  FAILED/RECOVERY_REQUIRED
       │     │
       │     └──> TOOL_DISPATCH_PENDING
       ▼
   STEP_CONTINUATION
```

取消和错误可以从 `STREAM_OPEN`、`RECEIVING`、`ACCUMULATING` 和 `VALIDATING` 发生，但每个位置的恢复语义不同。连接刚打开就取消，通常没有模型语义结果；在完整 tool call 之后、工具执行之前取消，则需要保留已接受的调用和未执行状态。

## 4. Text Delta 的处理

文本增量通常最容易处理，但仍然有三个边界：

1. UI 展示可以早于消息持久化；
2. markdown 和代码块在中间状态可能不完整；
3. 取消时 partial text 是否进入历史必须有明确策略。

### 4.1 UI buffer 与 history buffer

建议至少区分两个 buffer：

```text
display_buffer   面向实时 UI，可丢弃或重建
message_buffer   面向 Runtime，等待最终或中断提交
```

UI 可以在每个 delta 到达后刷新；message buffer 则需要按 response identity 聚合。这样 UI 重连时可以从 message 或 event 重新构建，不必把 UI 组件的当前文本当作事实来源。

### 4.2 Partial assistant message

模型输出中断时，Runtime 有三种选择：

- 丢弃 partial 内容，只记录失败；
- 保存 partial 内容并标记 `interrupted`；
- 将 partial 内容作为可见 assistant 消息提交，并附带未完成标记。

没有普遍正确的选择。若 partial 内容包含工具调用或安全相关说明，静默丢弃可能影响审计；若将其当作完整 assistant message，又可能让下一次模型请求误以为决策已经完成。

Codex、Pi 和 OpenCode 都将消息历史、工具结果和执行状态分层处理；这类分层为 partial message 保留“可见但未完成”的状态提供了空间。[^codex-history] [^pi-agent] [^opencode-context]

## 5. Tool Call Delta 的处理

工具调用是流式 Runtime 中最关键的复杂点。典型响应可能如下：

```text
delta 1: tool name = "apply_patch"
delta 2: arguments = "{\"path\":"
delta 3: arguments = "\"src/a.ts\","
delta 4: arguments = "\"patch\":\"..."
delta 5: arguments = "}\""
delta 6: finish_reason = tool_calls
```

Runtime 必须在至少满足以下条件后才把调用交给执行层：

- tool name 已确定；
- tool call identity 已确定；
- arguments 已完成并可解析；
- provider 表示该响应已经结束或调用已经完整；
- 当前 Step 仍然有效，未被取消或替换；
- 工具 schema、权限和 Environment 仍然匹配。

### 5.1 不要按“看起来完整”执行

即使当前字符串恰好能解析成 JSON，也不代表 provider 不会继续追加字段。早期执行会造成：

- 参数被后续 delta 修改；
- 同一 call 被执行两次；
- tool call 与 assistant message 的顺序不一致；
- 用户取消后仍然执行旧请求。

### 5.2 多个 tool call

模型可以在一个响应中生成多个工具调用。Runtime 需要决定：

- 按响应顺序串行执行；
- 并行执行互不相关的调用；
- 等待全部调用解析完成后再 dispatch；
- 某个调用失败时是否取消其余调用。

Pi 的工具准备和执行阶段将调用解析、权限准备和实际执行分开；Codex 保留已执行调用的 metadata；Kimi Code 使用工具去重和策略门。[^pi-prepare] [^codex-recorder] [^kimi-dedupe]

这说明 streaming parser 不应直接拥有执行权限。它只能产生一个待验证的 ToolCall set，后续由 Step/Tool Runtime 决定是否接受。

## 6. Reasoning / Thinking Delta 的边界

部分模型会返回 reasoning、thinking 或内部分析字段。Runtime 需要区分：

- provider 原始字段；
- 用户可见的解释文本；
- 可用于恢复的模型元数据；
- 不应进入下一次 prompt 的内部内容。

不能因为某段 delta 被 provider 标记为 reasoning，就把它自动写入可持久化 transcript 或下一次 Context。不同 provider 对 reasoning 字段的格式、可见性、计费和重放语义并不相同。

模型切换时尤其要避免将旧模型的 reasoning 状态当作新模型的上下文事实。新模型可以看到结构化的任务状态和工具结果，但不应被迫继承 provider 私有的内部推理格式。

## 7. Stream Completion 的语义

连接关闭不一定等于 stream completed。Runtime 至少应区分：

```text
provider_completed      provider 给出明确完成原因
transport_closed        连接关闭，但没有完成事件
parser_completed        内容可以解析，但 provider 未给 finish reason
runtime_cancelled       本地主动取消
provider_error          provider 返回明确错误
unknown                 无法判断请求是否已被接受
```

只有在 provider completion、parser validation 和 Runtime acceptance 都成立时，才适合产生正常的 `AssistantMessageAccepted` 或 `ToolCallAccepted`。

如果连接在完整 tool call 之后关闭但没有 finish reason，系统可以将调用放入 `recovery_required`，而不是自动执行。是否可以接受，需要结合 provider 协议和 request identity 判断。

## 8. 取消的时间窗口

### 8.1 首个 delta 之前

Runtime 可以将请求标记为 cancelled，通常没有 assistant 内容。但 provider 是否已经接受请求仍可能未知，应保留 request identity。

### 8.2 文本输出期间

需要决定 partial text 是否保存。工具通常尚未产生副作用，但模型原始响应可能已经改变用户界面。

### 8.3 Tool call 完整之后、执行之前

这是最重要的边界：模型已经提出动作，但用户取消了执行。正确状态应是“调用已产生但未执行”，不能把 tool call 从历史中静默删除，也不能当作工具失败。

### 8.4 工具执行期间

取消模型 stream 不会自动取消已启动的工具。工具层需要独立响应 cancellation；若取消未被确认，Environment effect 可能仍然未知。

Pi 将 agent loop abort、工具执行和 idle 状态分开；Codex 的任务取消同样需要跨 task、tool runtime 和子进程处理。[^pi-abort] [^codex-abort]

## 9. Backpressure 与并发

### 9.1 三个速度

流式 Runtime 同时面对三种速度：

```text
provider output rate
parser / accumulator rate
consumer rate (UI, persistence, tool preparation)
```

如果 provider 输出快于持久化，Runtime 需要缓冲；如果持久化慢于 UI，UI 不能成为事实提交的唯一驱动；如果 parser 处理 tool arguments 很慢，不能无限积累原始片段。

### 9.2 Backpressure 策略

常见策略包括：

- 限制每个 request 的增量 buffer；
- 大段文本外置，Context 只保留引用；
- UI 采用采样或批量刷新；
- provider stream 暂停读取；
- 超出限制时中断并标记 response incomplete；
- 将 reasoning、text、tool arguments 使用不同队列。

Pi 的 Environment 输出捕获与 spill 主要解决工具结果的大小边界；同样的思想适用于模型流，但模型 delta 还需要保证语义顺序和 response identity。[^pi-env]

### 9.3 并发请求

同一个 Session 通常不允许两个普通 model request 同时推进同一个 Turn，但后台任务、子 Agent、预取或用户 steer 可能造成多个请求存在。每个请求都必须有独立 accumulator 和 response identity，不能共享可变的“当前 assistant message”。

Codex 的 Step/Turn 边界、Kimi 的 StepRequestQueue 和 Pi 的 loop config 都提供了不同形式的请求归属机制。[^codex-step] [^kimi-request] [^pi-loop]

## 10. 流式持久化的两个选择

### 10.1 只保存最终响应

优点是存储简单，历史整洁；缺点是崩溃时可能丢失 partial 内容、usage 和 provider 事件，无法判断 tool call 是否完整。

### 10.2 保存增量事件

优点是可审计、可恢复和可诊断；缺点是需要处理重复、排序、压缩、schema 兼容和重建成本。

成熟 Runtime 可以采用混合策略：

```text
raw stream chunks -> 短期或外部 trace
normalized events -> 核心事件日志
final message     -> Context / UI projection
recovery metadata -> checkpoint / operation state
```

Pi 的 JSONL transaction storage 以及 durable restore 体现了将持久化 frame 与模型 loop 分开的方向；OpenCode 则将 Session message 到 LLM message 的转换作为独立投影。[^pi-jsonl] [^pi-restore] [^opencode-context]

## 11. Provider 事件归一化

不同 Provider 可能用不同结构表达相同语义。归一化层可以定义：

```typescript
type NormalizedModelEvent =
  | { kind: "text_delta", requestId, sequence, text }
  | { kind: "tool_call_delta", requestId, sequence, callId, name?, arguments }
  | { kind: "usage", requestId, usage }
  | { kind: "completed", requestId, finishReason }
  | { kind: "failed", requestId, error }
```

但归一化不能抹掉重要差异。例如：

- 某 provider 的 usage 只在最后返回；
- 某 provider 的 tool arguments 是 JSON 字符串，另一个是结构化 patch；
- 某 provider 支持并行 tool call，另一个只支持单调用；
- 某 provider 的 cancellation 有确认事件，另一个只有连接关闭。

统一类型应保留 provider-specific metadata 或 capability flags，否则上层会误以为所有 provider 具有相同保证。

## 12. 各 Agent 的流式边界

### 12.1 Codex：模型 Step 与执行生命周期结合

Codex 的 StepContext 将模型请求条件与工具路由、Environment 和指令绑定，Turn loop 负责消费模型输出并推进工具或下一步输入。[^codex-step] [^codex-turn]

这使 stream completion 不只是 provider 层事件，而是 Step 状态机的输入。工具结果、取消和 pending input 需要和当前 Turn 关联。

### 12.2 Pi：loop 内的流式响应与工具批次

Pi 的 Agent loop 处理模型响应增量，随后准备和执行工具调用；abort、steer 和 follow-up 通过 loop 边界影响下一次请求。[^pi-loop] [^pi-prepare] [^pi-execute]

它的结构清晰地分开了“解析模型响应”和“执行工具”，适合扩展 provider，但上层 harness 仍需负责 partial response 持久化和恢复策略。

### 12.3 OpenCode：消息投影和 Provider 格式

OpenCode 的 Session runner 不直接把内部消息交给 provider，而是通过 `to-llm-message` 处理工具结果、compaction 和模型格式。[^opencode-context]

因此 stream 累积后的 assistant/tool message 必须能被投影为 provider 可接受的格式；恢复或切换模型时，投影层可能需要重新生成请求，而不是复用原始 provider frame。

### 12.4 Gemini CLI：SDK Session 的流式控制

Gemini CLI SDK Session 将 transcript、动态 instructions、cwd 和 stream loop 结合；shell/tool 执行在模型响应之后继续推进。[^gemini-session]

动态 instructions 的刷新时机是关键边界：如果 Session context 在流式请求期间改变，不能直接修改当前请求的输入，只能影响后续请求。

### 12.5 Kimi Code：请求定型与 StepRequest

Kimi Code 将 StepRequest 的请求定型作为请求形成边界，便于在发送前确定 Context 和能力；响应后的 tool policy、permission gate 和 dedupe 再决定是否进入执行层。[^kimi-materialize] [^kimi-policy] [^kimi-permission]

### 12.6 OpenHands 与 mini-SWE-agent

OpenHands 的模型流位于 agent-server、sandbox 和 workspace 上下文内，流式响应的工具调用不能脱离远程执行环境单独解释。[^openhands-adapter]

mini-SWE-agent 的默认 loop 更直接地将模型响应转为 action，再将 observation 放回 trajectory；它适合作为最小对照基线，但 partial stream、取消和恢复需要上层补充。[^mini-default]

## 13. 设计原则

### 原则一：接收、解析、接受、执行分层

网络收到内容不等于 Runtime 接受响应，响应被接受也不等于工具已执行。

### 原则二：工具调用必须等待语义完整

不执行半截参数，不以 JSON 暂时可解析作为完成标准。

### 原则三：每个请求独立聚合

不得用共享的当前 assistant buffer 处理多个并发或重试请求。

### 原则四：部分结果显式标记

partial text、partial tool call 和 unknown completion 都必须带有未完成语义，不能伪装成正常完成。

### 原则五：取消是控制流事件

取消需要说明请求、流、工具和 Environment 各自是否停止，不能只关闭客户端连接。

### 原则六：provider 差异不能被过度归一化

统一接口应隐藏协议细节，但保留影响恢复、工具执行和成本计量的能力差异。

### 原则七：流式 UI 不是事实存储

UI 可以消费增量事件，但最终状态需要由 Runtime 的消息、事件和 Step 提交决定。

## 14. 验证方案

### 14.1 流式模拟器

构造一个 provider simulator，输出以下序列：

```text
text delta -> tool name -> partial arguments -> completed arguments -> finish
```

在每个 delta 之间注入：

- 用户取消；
- worker 崩溃；
- 重复帧；
- 延迟帧；
- provider error；
- persistence failure。

### 14.2 必须验证的断言

```text
partial arguments are never executed
duplicate delta does not duplicate tool call
old request cannot update new request buffer
cancelled stream does not create completed assistant result
tool call after stream completion has one identity
missing finish reason enters recovery path
UI replay does not create a second execution
usage is attributed to the correct request attempt
```

### 14.3 运行时与静态证据边界

源码可以证明 parser、loop、tool dispatch 和 cancellation 的责任位置；测试可以证明某些输入序列的行为；但 provider 网络断开、服务端已接受请求、真实 backpressure 和实际 KV cache 仍需运行时实验。

## 未确认事项

- 各项目是否保存原始 provider stream frame，需继续检查存储和 debug 选项。
- provider 连接关闭时的完成语义不能跨供应商泛化。
- 各 Agent 是否允许同一 Session 内存在并行 model request，需要结合产品层调用路径确认。
- 流式 reasoning 字段的持久化、可见性和模型切换行为仍需单独研究。

下一篇将研究模型切换与上下文一致性：同一 Session 在更换模型、压缩上下文、调整工具集合或改变 provider 时，哪些状态可以沿用，哪些必须重新定型。

## 参考源码

[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^pi-abort]: [Pi abort and waitForIdle](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L319-L337)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^pi-loop]: [Pi agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and spill](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
