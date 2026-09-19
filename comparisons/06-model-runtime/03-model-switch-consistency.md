---
title: Coding Agent 的模型切换与上下文一致性
series: Coding Agent 的模型运行时：Provider、流式推理与模型切换
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的模型切换与上下文一致性

## 结论

模型切换不是把 `model` 字段替换成另一个字符串。它改变的是一次模型请求的解释器：上下文窗口、工具协议、系统指令、reasoning 格式、流式事件、usage 计量和终止语义都可能发生变化。

因此，模型切换的核心问题不是“新模型能不能继续看到历史”，而是：

> 新模型看到的 Context 是否仍然代表同一个 Session、同一个 Turn 的事实状态，并且不会继承不适用于它的能力、权限和未完成决策？

可以将切换分成四层：

```text
Model display switch       UI / 默认配置变化
Request-boundary switch    下一个请求使用新模型
Step switch                当前 Step 结束后使用新模型
Execution switch           未完成决策或工具流程中切换模型
```

前两种通常可以在下一次请求边界处理；后两种需要处理旧请求、partial response、工具调用和审批状态。一个安全的 Runtime 不会把旧模型的内部推理状态、工具参数格式或响应缓存直接带给新模型，而是从持久事实和当前 Environment 重新定型请求。

## 1. 什么是上下文一致性

本文将模型切换后的 Context 一致性定义为：

```text
NewContext = Assemble(
  same accepted facts,
  valid current runtime state,
  compatible capabilities,
  model-specific representation
)
```

它不要求新旧请求的 prompt 字节完全相同，也不要求新模型产生相同输出。它要求：

- 已接受的用户事实没有被静默删除；
- 未完成工具调用没有被伪装为已完成；
- 旧模型的 provider 私有字段没有污染新模型；
- 新模型只获得当前有效的工具、权限和 Environment 能力；
- Context 压缩或重写可以追溯到相同事实来源；
- 新请求拥有新的 request identity，但仍属于正确的 Session/Turn/Step 边界。

因此，一致性是事实和责任的一致，而不是文本内容的一致。

## 2. 可继承状态与不可继承状态

### 2.1 通常可以继承

- 用户已提交的需求；
- 已确认的 assistant 文本；
- 已确认的工具调用结果；
- 已验证的文件、Git 和 Environment 观察；
- Session/Turn 的业务身份；
- 未过期且仍匹配的用户偏好；
- 可重新解释的任务状态摘要。

### 2.2 通常需要重新定型

- system/developer instruction 的模型适配版本；
- tool schema 和工具描述；
- context window 裁剪；
- reasoning/thinking 字段；
- provider-specific message 格式；
- sampling、temperature、reasoning effort 等参数；
- usage 预算和成本策略；
- provider request identity；
- 当前模型的有效 capability。

### 2.3 不应直接继承

- partial tool-call JSON；
- 旧 provider 的隐藏 reasoning 状态；
- 已过期审批；
- 旧模型声称但 Runtime 未确认的 Environment 事实；
- 旧请求的 stream buffer；
- 旧模型的 KV cache 引用；
- 仅存在于 UI 的 assistant 文本。

## 3. 模型切换的四个时间边界

### 3.1 请求创建前

用户修改默认模型，尚未开始下一次请求。这是最简单的情况：新的 model identity 进入下一次 Step，旧历史仍然是 Session 事实。

### 3.2 请求排队后、发送前

请求已经被 Runtime 接受，但尚未向 provider 发送。此时需要决定使用排队时冻结的模型，还是使用发送时解析的最新模型。

Kimi Code 将 StepRequest 的 admit、排队和请求定型分开；这种结构可以明确模型配置在哪个边界冻结。[^kimi-request] [^kimi-materialize]

### 3.3 流式响应期间

旧模型可能已经输出文本、reasoning 或部分 tool call。切换新模型时不能直接把 stream buffer 替换成新模型的 buffer。旧 request 要先进入 cancelled、interrupted 或 recovery-required，partial 内容则按照明确策略保存。

Pi 的 Agent loop 将 abort、steer 和 follow-up 作为不同输入路径；Codex 将任务取消与 Turn/Step 生命周期关联。[^pi-abort] [^codex-abort]

### 3.4 工具调用已接受、尚未完成

这是最危险的边界。旧模型已经提出工具动作，新模型可能要继续任务。Runtime 必须先判断：

- tool call 是否已经执行；
- 工具结果是否已持久化；
- 是否仍有审批等待；
- Environment 是否已改变；
- 新模型是否能理解该工具结果或未完成状态。

模型切换不能绕过旧工具的终态处理。

## 4. Model Switch 不是 History Rewrite

历史事实应与模型表示分离：

```text
Persistent facts
       ↓
History selection
       ↓
Model-specific message projection
       ↓
New provider request
```

Codex 的 history manager 同时支持面向 prompt 的历史和内部带注解的历史；OpenCode 通过 `to-llm-message` 将 Session message 转为 provider message；这两类实现都表明模型请求是事实的投影。[^codex-history] [^opencode-context]

如果切换模型时直接修改原始 transcript，会产生两个问题：

- 旧模型实际看到的内容无法再审计；
- 新模型的兼容性需求迫使历史事实被破坏。

正确做法通常是保留同一事实历史，为新模型生成新的 projection。若必须压缩或转换，应记录 projection version、model identity 和转换原因。

## 5. Tool Schema 的一致性

工具 schema 是模型理解执行能力的契约。切换模型时可能发生：

- 新模型不支持旧的 tool call 格式；
- description 需要改变；
- 参数 schema 的严格程度不同；
- 并行 tool call 支持不同；
- tool result 的消息角色不同；
- 某些工具对新模型不可用。

因此有效工具集合应重新计算：

```text
EffectiveTools(new request) =
  registered tools
  ∩ provider protocol
  ∩ model schema support
  ∩ permission policy
  ∩ Environment availability
```

Codex 的 StepContext 绑定 ToolRouter、MCP 和 Environment；Kimi Code 通过 tool policy 和 permission gate 在请求后进入执行前再次校验；OpenCode 由 provider/model resolver 和 Session message projection 协同处理模型能力。[^codex-step] [^kimi-policy] [^kimi-permission] [^opencode-model-resolver]

旧 Context 中的一条自然语言描述“你可以使用某工具”不能替代新请求中的真实 schema。更不能因为工具曾经注册过，就让新模型继续请求已经撤销或不再适用于当前 Environment 的工具。

## 6. 审批能否跨模型复用

审批的复用必须由 scope 和参数匹配决定，而不是由 Session 身份决定。

例如用户批准了：

```text
在 /repo 中执行：git diff --check
```

新模型随后请求：

```text
在 /repo 中执行：git push origin main
```

即使两次请求属于同一个 Turn，也不能复用前一个审批。模型切换更不能扩大审批范围。

审批复用至少需要检查：

- `call_id` 是否相同；
- 参数是否相同或满足明确匹配规则；
- Environment identity 是否相同；
- policy version 是否兼容；
- approval 是否过期或已消费；
- 新模型请求的 capability 是否超过原授权。

Codex 将权限回复绑定到调用身份；Gemini CLI 的 policy engine 将策略评估与 shell 执行分开；Kimi Code 使用 permission gate 处理工具进入执行层的授权。[^codex-approval] [^gemini-policy] [^kimi-permission]

## 7. Context Window 与模型切换

不同模型的 context window 不同，切换可能要求重新裁剪或压缩历史。这里有三个危险：

1. 新模型窗口更小，重要的用户约束被裁掉；
2. 压缩算法改变，摘要丢失未完成工具状态；
3. 新模型窗口更大，Runtime 误把所有旧噪音重新注入。

上下文裁剪应以事实优先级和恢复责任为依据，而不是简单保留最近 N 条消息。至少应保留：

- 当前用户目标；
- 未完成任务；
- 最近有效 Environment 观察；
- 工具调用与结果配对；
- 当前权限和限制；
- 失败、取消和未知副作用状态。

Codex 的 compaction、rollback 和 history version 说明模型历史可以重写，但 Runtime 需要保留足够的内部事实；OpenCode 的 compaction 与 LLM message projection 也把压缩和 provider 输入分开。[^codex-history] [^opencode-compaction] [^opencode-llm]

## 8. Reasoning 状态与模型切换

Reasoning/thinking 内容通常具有 provider 私有格式和不同的可见性。切换模型时有三种策略：

- 丢弃旧 reasoning，只保留结构化事实和工具结果；
- 将 reasoning 压缩为公开的任务状态摘要；
- 尝试把旧 reasoning 原样传给新模型。

第三种通常最不可靠：新模型可能不认识旧格式，且 provider 可能禁止或改变这类字段。更安全的是将旧 reasoning 的可用结果转换为 Runtime 事实，例如“已检查 `src/`，发现测试失败”，而不是把内部推理文本作为新模型的隐藏上下文。

## 9. Model Switch 与 KV Cache

KV cache 是 provider 侧的推理优化，不是 Session 状态。模型切换通常会使 cache 失效，因为模型权重、tokenizer、请求格式或 cache namespace 不同。

即使仍使用同一个模型，以下变化也可能影响前缀缓存：

- system prompt 版本变化；
- tool schema 变化；
- 动态时间或 Environment 状态放在前缀；
- 压缩后历史前缀改变；
- provider serialization 变化；
- request 中插入新的 policy/instruction。

因此 Runtime 应将 cache key 或 cache hint 作为 provider 适配层的可选信息，不应把它作为事实恢复的前提。上下文一致性必须在没有 KV cache 的情况下仍然成立。

## 10. 同一 Step 内切换的安全模型

如果旧模型请求在执行中切换，可采用以下状态机：

```text
OLD_REQUEST_RUNNING
       │ switch requested
       ▼
OLD_REQUEST_STOPPING
       ├── no semantic output -> OLD_REQUEST_CANCELLED
       ├── partial output      -> OLD_RESPONSE_PARTIAL
       ├── complete tool call  -> TOOL_CALL_PENDING_REVIEW
       └── completion accepted -> OLD_RESPONSE_COMMITTED
                                      │
                                      ▼
                              NEW_REQUEST_MATERIALIZE
```

新请求只有在旧请求状态明确后才可以定型。`OLD_RESPONSE_PARTIAL` 不能直接成为新模型的完整 assistant message；`TOOL_CALL_PENDING_REVIEW` 不能因模型切换自动执行；`OLD_RESPONSE_COMMITTED` 则可以作为历史事实投影给新模型。

## 11. Model Switch 与重试的区别

### 11.1 Retry

目标是让同一个模型和请求语义再次获得结果，通常保留相同的 Context 选择，但产生新的 request attempt。

### 11.2 Fallback

目标是在 provider/model 不可用时使用另一个模型继续任务。它应明确这是一个新的决策器，并记录切换原因。

### 11.3 User-selected switch

用户主动选择模型，可能希望保留 Session 事实，但不一定希望当前失败请求自动重放。

### 11.4 Policy-driven switch

Runtime 根据预算、上下文窗口、任务复杂度或失败类型自动切换。此时必须防止策略层悄悄改变用户可见的模型或权限语义。

Codex 的 step settings、Pi 的 model/loop config 和 OpenCode 的 model resolver 都说明模型选择会参与请求级配置，而不是只存在于 UI 设置。[^codex-settings] [^pi-config] [^opencode-model-resolver]

## 12. 各 Agent 的一致性边界

### 12.1 Codex：Step 级模型设置

Codex 通过 StepContext 和 step settings 将模型相关设置绑定到 Step；history manager 则负责把持久历史转换为模型可见历史。[^codex-step] [^codex-settings] [^codex-history]

这意味着模型切换更适合在 Step 边界完成。若在活跃请求中切换，需要经过取消、输入排队和新的 Step activation，而不是直接修改当前调用对象。

### 12.2 Pi：Loop config 与 Context snapshot

Pi 的底层 Agent 通过 loop config 和 context snapshot 管理当前 model、tools、system prompt 和 messages；harness 层可以进一步记录 lane/operation 和恢复状态。[^pi-agent] [^pi-config] [^pi-harness]

优点是调用方可以灵活切换模型；代价是调用方必须自己保证切换时没有遗留的 partial tool call 或旧审批状态。

### 12.3 OpenCode：Model resolver 与 message projection

OpenCode 的 model resolver 处理 provider/model capability，Session runner 再将历史消息转换为 LLM message。[^opencode-model-resolver] [^opencode-context]

这使模型切换可以重新生成 provider-specific 请求，但也要求 compaction、tool result 和 system instruction 在新 projection 中保持语义完整。

### 12.4 Gemini CLI：Session Context 与动态 instructions

Gemini CLI SDK Session 将 transcript、cwd、动态 instructions 和 model 请求结合；模型变化时，新的请求需要重新组装 SessionContext，而不是只替换 provider endpoint。[^gemini-session]

### 12.5 Kimi Code：Materialization 作为一致性门

Kimi Code v2 在 `materializeRequest()`（请求定型）时应用上下文和请求状态；StepRequest 的身份使排队期间的状态变化可以在发送前重新判断。[^kimi-materialize] [^kimi-request]

这提供了一个明确的模型切换门：新模型和工具集合在请求定型时确定，旧排队请求不应无标记地沿用旧 capability。

### 12.6 OpenHands 与 mini-SWE-agent

OpenHands 的模型请求还受到 agent-server、workspace 和 sandbox 状态约束；切换模型不能绕过远程 Environment 的可用性。[^openhands-adapter]

mini-SWE-agent 的默认 loop 将 model 调用作为 trajectory 决策函数，模型切换更多由上层配置负责；其最小实现不自动提供跨模型的持久 Context 兼容层。[^mini-default]

## 13. 设计原则

### 原则一：保持事实身份，不保持 provider 表示

Session、Turn、工具结果和 Environment 事实可以继承；provider message、reasoning 字段和 stream buffer 应重新投影。

### 原则二：模型切换发生在明确的请求边界

若无法说明旧请求何时停止、新请求何时定型，切换就会产生重复决策和状态覆盖。

### 原则三：有效能力随模型重新计算

工具 schema、权限、Environment 和 provider capability 需要在新请求中重新求交集。

### 原则四：审批不能因为模型切换扩大

审批 scope 必须独立于模型身份，且与具体调用参数、Environment 和策略版本关联。

### 原则五：Context compression 不能成为事实删除

压缩可以改变模型表示，但必须保留可恢复的原始事实、摘要来源和未完成状态。

### 原则六：KV cache 是优化，不是语义依赖

模型切换或 cache miss 不应破坏 Session 的事实一致性。

### 原则七：自动 fallback 必须可见、可审计

Runtime 因错误、预算或能力不足切换模型时，应记录原因、旧模型、新模型和新请求 identity。

## 14. 验证方案

### 14.1 切换矩阵

对以下场景分别注入模型切换：

| 场景 | 需要验证 |
| --- | --- |
| 请求发送前 | 新模型是否正确进入下一 Step |
| 排队后发送前 | 使用旧配置还是重新定型 |
| 文本流中 | partial assistant 如何保存 |
| tool call 参数未完成 | 是否阻止工具执行 |
| tool call 已接受未执行 | 是否重新审批或保留 pending |
| 工具执行中 | 模型切换是否影响工具终态 |
| compaction 后 | 关键事实是否仍存在 |
| provider fallback | 新 request identity 和原因是否记录 |

### 14.2 一致性断言

```text
accepted user facts survive model switch
old partial tool call is never silently executed
new model receives only current capabilities
old approval does not expand in scope
old provider reasoning is not treated as new facts
new request has distinct identity
history remains auditable before and after switch
```

### 14.3 KV Cache 观察

如果要研究缓存影响，需要对每次请求记录：

- model/provider identity；
- system prompt hash；
- tool schema hash；
- selected history hash；
- dynamic instruction placement；
- provider cache usage；
- compaction and switch event。

不能通过“prompt 看起来相似”推断 cache 命中，也不能通过缓存命中推断上下文语义一致。

## 未确认事项

- 各项目是否允许活跃 Step 中直接切换模型，需继续检查 UI/SDK 调用路径和测试。
- 各 Provider 的 reasoning、cache 和 request status 语义不能由 Agent 源码完全决定。
- 旧模型已生成但未完成的 tool call 在各项目中的持久化方式仍需通过故障实验确认。
- 自动 fallback 是否向用户展示，以及是否复用原审批，需要结合具体产品配置验证。

下一篇将研究 Provider 故障、成本预算和模型路由：模型运行时如何在超时、限流、上下文过长、预算耗尽和能力不匹配时选择继续、降级或终止。

## 参考源码

[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^pi-abort]: [Pi abort and waitForIdle](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L319-L337)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^opencode-model-resolver]: [OpenCode model resolver](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/model-resolver.ts#L110-L190)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^opencode-compaction]: [OpenCode Session compaction](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/compaction.ts#L680-L783)
[^opencode-llm]: [OpenCode compaction to LLM message](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L270-L295)
[^codex-settings]: [Codex model-dependent step settings](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L110-L160)
[^pi-config]: [Pi loop configuration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^gemini-session]: [Gemini CLI SDK Session](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
