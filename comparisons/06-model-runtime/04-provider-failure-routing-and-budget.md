---
title: Coding Agent 的 Provider 故障、成本预算与模型路由
series: Coding Agent 的模型运行时：Provider、流式推理与模型切换
part: 4
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Provider 故障、成本预算与模型路由

## 结论

模型运行时最终要处理的不是“哪个模型更强”，而是一次具体请求在当前约束下是否还能继续：Provider 是否可用，Context 是否适配，工具能力是否兼容，预算是否足够，用户是否允许自动切换，以及旧请求是否已经产生了可执行结果。

因此，Provider 故障、成本预算和模型路由不应是一个简单的 `try/catch`：

```text
Request admitted
   ↓
Capability / budget / policy check
   ↓
Provider request
   ├── success -> normalize -> continue
   ├── retryable transport failure -> bounded retry
   ├── rate limit -> delay / alternate provider
   ├── context too large -> compact / reduce tools / switch model
   ├── capability mismatch -> 重新定型请求
   ├── budget exhausted -> stop / ask user / downgrade
   └── unknown submission -> reconcile before retry
```

一个成熟 Runtime 的路由决策必须区分：

- 传输失败与模型决策失败；
- 请求未提交与 provider 已接受但响应丢失；
- 当前模型不支持与当前策略不允许；
- 成本预算不足与 Context 无法适配；
- 自动 fallback 与用户主动切换；
- 重新计算 Context 与重复执行旧 tool call。

本文作为模型运行时专题的收束，建立这些机制之间的统一边界。它不评价哪个模型效果最好，而关注 Harness 如何把不稳定的模型服务纳入一个可解释的执行系统。

## 1. Provider 故障的分类

### 1.1 请求构造失败

请求在发送前就失败，例如：

- Context 超过本地计算出的窗口；
- tool schema 无法序列化；
- 当前模型不支持所需输入模态；
- 参数与 provider 协议不兼容；
- 认证配置缺失。

这类失败通常可以安全地重新定型请求或选择兼容模型，不应进行无意义的网络重试。

### 1.2 连接建立失败

DNS、TLS、连接池或网络不可达导致请求没有明确发送结果。它通常具有 retryable 属性，但仍需限制重试次数和退避时间。

### 1.3 请求被限流

Provider 返回 rate limit、quota exceeded 或 concurrency limit。继续立即重试只会放大拥塞。Runtime 需要读取 retry-after、账户预算和当前任务优先级，决定等待、切换 provider 或暂停任务。

### 1.4 请求已接受但响应丢失

这是最危险的网络故障：provider 可能已经开始生成，客户端却只看到 timeout 或 connection reset。不能直接把它归类为“模型没有输出”，更不能直接执行下一次请求产生的 tool call。

### 1.5 响应格式失败

provider 返回了内容，但 tool call、JSON 或 finish reason 无法解析。此时模型决策可能已经存在，只是 Runtime 无法接受。需要保存原始或规范化失败信息，决定是否请求模型修正，而不是无条件 fallback。

### 1.6 Provider 明确拒绝

安全策略拒绝、内容过滤、模型不可用或账户权限不足，通常不适合按相同请求重试。可以修改请求或选择其他模型，但必须把拒绝原因带入新的决策边界。

## 2. Retry 分类

不同失败需要不同 retry 语义：

| 失败 | 是否可重试 | 典型动作 |
| --- | --- | --- |
| 本地序列化失败 | 否，先修复请求 | 重新定型或报告错误 |
| DNS/连接失败 | 有限重试 | 指数退避 |
| 429/限流 | 延迟重试 | 读取 retry-after 或切换 |
| 5xx | 有限重试 | 保持 request 事实，生成新 attempt |
| 响应超时 | 未知 | 查询状态或进入 recovery |
| Context too large | 不能原样重试 | 压缩、裁剪或切换窗口 |
| Tool schema mismatch | 不能原样重试 | 重新生成 capability projection |
| 内容策略拒绝 | 通常不能原样重试 | 调整请求或终止 |
| 解析失败 | 谨慎重试 | 保存原始响应并要求结构化修正 |

Retry 的两个核心属性是：

```text
bounded       重试次数、时间和成本有上限
attributable  每次尝试有独立 request/attempt identity
```

否则系统会在 provider 不可用时无限消耗预算，或者在响应不确定时产生多个相互冲突的 tool call。

## 3. Backoff 不只是延迟

指数退避解决的是瞬时拥塞，不解决永久错误。一个路由器至少要维护：

- provider/model 的健康状态；
- 最近错误类型和时间；
- 当前并发量；
- 账户和模型配额；
- retry-after；
- 任务优先级和 deadline；
- 已消耗的 token 和金钱预算。

可以把一次路由决策表示为：

```text
Route(request) = argmax candidate_models (
  capability_fit
  × availability
  × policy_allowed
  × budget_allowed
  × context_fit
)
```

这不是要求使用数学优化器，而是要求路由逻辑不要只看模型名称。一个更强的模型如果不能处理当前 tool schema 或已经超过预算，就不是有效候选。

## 4. Capability Mismatch 与 Model Fallback

### 4.1 Context window 不匹配

新模型窗口较小，不能直接把旧 prompt 发过去。路由器可以：

1. 重新选择历史；
2. 压缩工具结果；
3. 移除可重新读取的 Environment observation；
4. 减少工具描述；
5. 选择更大窗口模型；
6. 请求用户确认继续。

其中第 3、4 步不能删除当前权限、未完成动作和用户硬约束。Context manager 必须知道什么可以丢，什么丢失后会破坏任务语义。

### 4.2 Tool calling 不匹配

某模型不支持并行 tool call，不意味着可以把并行调用原样塞进 prompt。Runtime 应重新生成工具集合和执行策略：串行化、禁用特定工具或切换兼容模型。

### 4.3 Reasoning 能力不匹配

从 reasoning model 切换到普通模型时，旧 reasoning 不能当作可靠的内部状态。应提供结构化任务摘要、已确认事实和未完成动作。

### 4.4 输入模态不匹配

图像、音频、结构化输入或超长代码引用可能需要不同模型。Fallback 必须重新检查所有 content parts，而不是只更换 model ID。

OpenCode 的 model resolver 明确把模型能力与 compaction 等请求行为关联；Codex 的 model-dependent step settings 也说明模型配置参与 Step 请求定型。[^opencode-model-resolver] [^codex-settings]

## 5. 成本预算的层次

成本不是一个 Session 结束后显示的数字，而是 Runtime 的控制条件。建议至少分成：

```text
request budget       一次模型请求允许的 token / 时间 / 金额
step budget          一次 Step 的模型和工具成本
turn budget          一次用户任务的累计成本
session budget       长期 Session 总成本
organization budget 账户或团队配额
```

不同层次的预算耗尽应导致不同动作：

- request budget 耗尽：压缩、截断或结束当前请求；
- step budget 耗尽：停止当前 Step，保留状态；
- turn budget 耗尽：请求用户确认或使用低成本模型；
- session budget 耗尽：禁止新 Turn 或切换账户策略；
- organization quota 耗尽：暂停或切换 provider。

### 5.1 Token usage 归属

每次请求应将 usage 归属到：

- session/turn/step；
- model/provider；
- attempt；
- input/output/reasoning/cache token；
- tool schema 和 tool result 贡献；
- 是否为 retry 或 fallback。

如果 fallback 请求覆盖了旧请求的 usage，预算系统会低估实际成本；如果 tool result token 没有计入 Step，Runtime 会错误地认为模型仍有足够窗口。

### 5.2 估算与结算

本地 token estimation 适合发送前检查；provider usage 适合最终结算。两者可能因 tokenizer、隐藏字段、reasoning 和缓存计量不同而不一致。

因此应分别保存：

```text
estimated_usage   发送前估算
reported_usage    provider 返回
settled_cost      账单或账户最终确认
```

估算失败不能被当作 provider 计量为零。

## 6. Budget 与 Context Compaction

成本预算和 Context 窗口经常相互影响：压缩可以减少输入 token，但可能增加一次摘要模型调用；切换到大窗口模型可能减少 compaction，却提高输出成本。

一个合理的决策顺序是：

```text
1. 判断当前请求是否超过模型硬窗口
2. 判断是否存在可丢弃或可外置内容
3. 计算压缩成本与信息损失风险
4. 比较候选模型的窗口、价格和能力
5. 按 policy 选择压缩、切换或暂停
```

OpenCode 将 compaction 能力与 model resolver 关联；Codex 的 history manager 和 compaction 机制则将模型历史重写与内部事实保留区分。[^opencode-compaction] [^codex-compaction]

压缩不能只按 token 数排序。当前审批、未完成工具和 Environment freshness 往往比旧的 verbose assistant 文本更重要。

## 7. Fallback 的责任边界

自动 fallback 至少需要记录：

```text
fallback_id
previous_model/provider
new_model/provider
reason
request_attempt
context_projection_version
capability_changes
budget_impact
user_visibility
```

Fallback 不是免费替代。它可能改变：

- 代码修改质量；
- tool call 格式；
- 任务完成时间；
- 隐私和数据出境边界；
- 费用和 token 消耗；
- 用户已经授予的能力范围。

例如从本地 provider 切换到远程 provider，可能改变数据处理地点；从支持严格结构化工具调用的模型切换到文本模型，可能要求更强的解析和安全限制。路由器不应只以“请求成功”为成功标准。

## 8. Provider 与 Environment 的耦合

模型 provider 常被视为外部服务，但它会影响 Environment 的执行节奏：

- provider 延迟让进程和租约继续占用；
- 生成中断可能留下已启动的后台任务；
- fallback 使不同模型面对不同的工具 schema；
- 预算耗尽可能在工具执行前或执行后发生；
- provider region 和网络策略可能改变 Environment 可达性。

因此模型 Runtime 的故障处理不能脱离 Environment。Codex 的 StepContext 将模型设置、工具路由和 Environment 绑定；OpenHands 的 agent-server 将模型调用置于 sandbox/workspace context 中；OpenCode 将 Session execution 和 workspace provider 分层但通过 operation 关联。[^codex-step] [^openhands-adapter] [^opencode-execution]

## 9. Provider 故障与未完成 Tool Call

假设模型在 stream 中生成完整 tool call，随后 provider 连接断开。Runtime 不能直接选择 fallback 模型并执行新模型生成的第二个 tool call。正确流程是：

```text
1. 保存旧 request 和 partial/final response
2. 判断 tool call 是否完整、是否已接受
3. 检查是否已经进入 tool execution
4. 若未执行，决定继续旧决策、请求用户或重新规划
5. 若已执行，读取工具/Environment 状态
6. 只有在旧调用终态明确后才启动 fallback model
```

Codex 的 executed tool call metadata、Pi 的 tool recovery 和 Kimi Code 的 tool dedupe 都提供了调用级别处理的证据。[^codex-recorder] [^pi-recovery] [^kimi-dedupe]

Fallback 模型应看到的是“旧调用状态”，而不是一个没有上下文的错误字符串。

## 10. Router、Policy 与 User Control

模型路由可以是：

- 固定配置：用户明确指定模型；
- 规则路由：按任务类型或 Context 大小选择；
- 健康路由：按 provider 可用性切换；
- 预算路由：按成本阈值降级；
- 质量路由：按工具错误或测试结果升级；
- 混合路由：多种策略组合。

路由器必须和权限策略分开。模型 fallback 不应自动改变文件写入、网络访问或后台任务的权限。Capability 变化需要重新计算并可能重新审批。

用户控制也有三个层次：

```text
可见       用户知道当前使用哪个模型
可配置     用户可以设定允许的模型/provider/fallback
可否决     用户可以阻止自动切换或预算升级
```

面向开发者的 coding agent 通常应至少让用户知道发生了自动 fallback，尤其是跨 provider、跨网络边界或改变成本的 fallback。

## 11. 各 Agent 的路由和故障边界

### 11.1 Codex：模型设置进入 Step

Codex 的 model-dependent step settings 将模型选择与 Step 请求条件绑定；ToolRouter、Environment 和权限在 Step activation 中共同决定当前可执行能力。[^codex-settings] [^codex-step]

这适合在清晰的 Step 边界处理 fallback：旧 Step 的状态被记录，新 Step 以新模型重新定型。风险在于 provider 已接受但响应丢失时，需要结合工具调用和 Turn 状态防止重复决策。

### 11.2 Pi：模型和 loop config 交给调用方

Pi Agent 通过 loop config 管理 model、tools、system prompt 和 messages；底层 loop 不替应用决定预算和 fallback，harness 可以在更高层加入 durable operation 和恢复策略。[^pi-config] [^pi-harness]

优点是可组合、可扩展；代价是应用必须自己定义 provider 健康、usage 归属和模型切换一致性。

### 11.3 OpenCode：Resolver、Compaction 与 Provider Context

OpenCode 的 model resolver 负责模型/Provider 能力，compaction 根据模型上下文和请求能力处理历史，provider context 再将模型特定信息提供给请求。[^opencode-model-resolver] [^opencode-compaction] [^opencode-provider-context]

这使 OpenCode 可以把模型路由和 Context 投影分开；但 fallback 后必须确保 compaction 结果与新模型窗口和 tool protocol 匹配。

### 11.4 Gemini CLI：Provider 与 Policy/Session 的组合

Gemini CLI Session 管理 transcript、动态 instructions 和 stream loop，policy engine 负责工具能力和策略判断。[^gemini-session] [^gemini-policy]

这类组合适合产品级 CLI：模型请求可以感知当前 Session，工具执行又由 policy 层控制。Provider 故障、动态指令刷新和 shell 取消的时序仍需要运行时验证。

### 11.5 Kimi Code：请求定型、任务状态和去重

Kimi Code v2 将请求定型、permission gate、tool policy、task persistence 和 dedupe 分层。[^kimi-materialize] [^kimi-permission] [^kimi-task] [^kimi-dedupe]

这为 fallback 和恢复提供了请求级状态基础，但路由器必须保证新模型请求使用新的 identity，不能绕过旧 task 的未完成状态。

### 11.6 OpenHands：远程服务与模型请求共同受 Environment 约束

OpenHands 的模型运行位于 agent-server 和 sandbox/workspace context 中，provider 故障可能影响远程任务的租约和后台服务。[^openhands-adapter]

它更接近远程软件工程平台：fallback 不只是更换模型，还可能改变请求区域、延迟、工具可达性和任务预算。

### 11.7 mini-SWE-agent：最小基线

mini-SWE-agent 的默认 loop 以 trajectory 推进，模型选择和重试更多由调用方控制。[^mini-default]

它提供一个清晰的最小基线：如果不增加 Runtime 状态，provider 失败通常只能表现为异常、重试或终止；预算、fallback 和多 provider 一致性需要在外层实现。

## 12. 设计原则

### 原则一：先分类错误，再决定重试

所有 provider error 都直接 retry，会把永久错误、未知提交和预算耗尽混成一个无限循环。

### 原则二：Fallback 必须重新定型

切换模型或 provider 后，Context、tool schema、capability、usage 和 request identity 都需要重新生成或重新确认。

### 原则三：预算是控制平面事实

预算不能只在 UI 或账单层统计，它必须影响 Step 是否继续、是否压缩、是否切换和是否请求用户确认。

### 原则四：Unknown submission 阻断自动重复决策

provider 响应丢失时，先确认旧请求和 tool call 状态，再产生 fallback 请求。

### 原则五：路由不改变权限

模型能力升级或 provider 切换不应自动扩大 Environment、网络或文件写入权限。

### 原则六：自动切换必须可见、可追踪、可回溯

用户和研究者都应该知道使用了哪个模型、为什么切换、消耗了多少预算、生成了哪些新的请求。

### 原则七：成本优化不能破坏事实一致性

少用 token 不等于可以丢弃审批、未完成动作、Environment 版本或未知副作用。

## 13. 验证方案

### 13.1 Provider 模拟器故障矩阵

模拟以下响应：

```text
connection_failed_before_send
rate_limited_with_retry_after
accepted_response_lost
context_window_rejected
tool_schema_rejected
partial_stream_then_disconnect
content_policy_rejected
usage_missing
budget_exhausted_after_tool_call
```

每种故障都要观察：

- request/attempt identity；
- Context 是否重新定型；
- tool call 是否重复；
- approval 是否重新检查；
- usage 是否正确归属；
- fallback 是否产生新事件；
- Session/Turn/Step 最终状态。

### 13.2 路由断言

```text
non-retryable error is not retried blindly
fallback receives a new request identity
old unknown response cannot be overwritten silently
new model receives compatible tool schema
budget exhaustion stops or escalates explicitly
provider switch does not expand permissions
usage is charged to the correct attempt and model
```

### 13.3 源码证据边界

固定版本源码可以证明模型解析、工具路由、compaction、task state 和 policy 的责任位置；不能单独证明 provider 真实限流、账单、KV cache、请求提交状态或跨区域故障。后者需要 provider 级实验和运行时配置。

## 未确认事项

- 各 Agent 是否具备完整的多 provider 自动 fallback，不能从单一 model resolver 推断。
- 各 provider 的 request status、retry-after、usage 和 cache 语义需要结合官方 API 文档和运行时响应验证。
- 自动模型降级是否会影响用户隐私、数据区域和权限策略，需要产品配置层确认。
- 预算耗尽发生在模型响应前、tool call 后或后台任务期间的实际控制流，需要逐项目实验。

## 模型运行时专题收束

四篇文章合起来说明，模型运行时的核心不是“连接更多模型”，而是把模型的不确定性纳入 Agent 的一致性边界：

```text
Provider      提供传输和服务能力
Model         提供推理能力和约束
Context       提供当前事实的模型投影
Stream        提供增量响应和中断边界
Tool schema   描述当前可请求的能力
Router        在能力、预算和健康之间选择
Recovery      处理失败、未知提交和模型切换
```

从这个角度看，成熟的 Coding Agent 并不把模型当作唯一的大脑，而把模型作为一个受 Runtime 约束的决策服务。模型可以提出计划和工具调用，但请求身份、能力边界、审批、Environment、副作用、预算和终态都需要由 Harness 保持一致。

## 参考源码

[^opencode-model-resolver]: [OpenCode model resolver and compaction capability](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/model-resolver.ts#L110-L190)
[^codex-settings]: [Codex model-dependent step settings](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L110-L160)
[^opencode-compaction]: [OpenCode Session compaction](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/compaction.ts#L680-L783)
[^codex-compaction]: [Codex compacted history persistence](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3771-L3835)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^opencode-provider-context]: [OpenCode provider context](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/provider-context.ts#L1-L55)
[^pi-config]: [Pi loop configuration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
