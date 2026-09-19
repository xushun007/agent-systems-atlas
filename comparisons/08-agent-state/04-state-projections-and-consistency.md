---
title: Coding Agent 的状态投影与一致性
series: Coding Agent 的 Agent State：状态分类、所有权与派生关系
part: 4
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的状态投影与一致性

## 结论

一个 Coding Agent 通常不会只有一份状态表示。同一条运行事实会被投影成：

```text
权威状态
  ├── Model Context
  ├── UI / TUI 状态
  ├── Plan View
  ├── Audit 记录
  ├── Trace / Metrics
  └── Provider Request
```

这些投影的格式、粒度和更新速度不同，但都应该指向同一组权威事实。投影不一致时，不能立即认为某个状态机错误；需要区分：

- 事实本身冲突；
- 投影延迟；
- 投影转换错误；
- Environment observation 过期；
- 不同投影有意隐藏了不同信息；
- 用户看到的状态与模型可见状态不一致。

因此，状态一致性不是要求所有界面和消息逐字相同，而是要求：

> 在明确的时间边界和版本边界内，不同投影对同一权威状态作出不相互矛盾的解释。

本文研究 Model Context、UI、Plan View、Audit、Trace 和 Provider Request 的投影关系，并给出区分“事实错误”和“视图错误”的诊断方法。

## 1. 权威状态与投影状态

### 1.1 权威状态

权威状态是 Runtime 可以用来作出控制、安全和恢复决策的事实集合，包括：

- 已接受的用户输入；
- Tool Call admission 和终态；
- Approval scope；
- Plan revision 和 work item 状态；
- owner/lease；
- Environment reference 和观察版本；
- recovery decision；
- 已确认的副作用。

权威状态不一定位于一个数据库中，但必须有清晰的 owner 和更新协议。

### 1.2 投影状态

投影是针对某个消费者生成的表示：

- 模型需要 Context；
- 用户需要可读进度；
- 审计需要不可抵赖的事件；
- 诊断需要时间线和调用关系；
- Provider 需要特定消息和 schema；
- 任务调度器需要当前可运行工作。

同一事实可以在不同投影中有不同字段，但不应改变事实的含义。

## 2. 六种主要投影

### 2.1 Model Context

Context 是模型当前请求可见的事实和能力集合。它需要裁剪、排序、压缩和适配 provider。

Context 可以省略完整审批历史、旧 plan revision、内部 lease 和原始 stream，但不能把未完成动作伪装成完成，也不能把过期 Environment observation 当成当前状态。

Codex 的 history manager、Pi 的 context snapshot、OpenCode 的 `to-llm-message` 和 Gemini CLI 的 SessionContext 都体现了 Context 是 Runtime state 的派生表示。[^codex-history] [^pi-agent] [^opencode-context] [^gemini-types]

### 2.2 UI / TUI State

UI 需要展示：

- 当前运行/等待/完成状态；
- 工具调用和结果；
- 审批请求；
- 计划进度；
- 后台任务；
- 错误和恢复提示。

UI 状态允许延迟、折叠和摘要，但不能成为完成或授权的唯一来源。用户点击 cancel/approve 产生的是控制意图，Runtime 接受后才形成权威事件。

### 2.3 Plan View

Plan View 是面向用户或模型的当前任务图视图。它通常隐藏旧 revision 和内部协调字段，只显示 active、pending、blocked 和 completed work item。

如果 Plan View 没有显示 `stale_completed` 或 `effect_unknown`，用户可能误以为任务已经可靠完成。因此隐藏字段必须有明确的用户体验语义，而不是静默丢失。

### 2.4 Audit View

Audit 关注谁在何时接受、授权、执行或恢复了什么。它需要更完整的身份、scope、policy version 和原始 event 引用，通常比 UI 和 Context 更详细。

### 2.5 Trace / Metrics

Trace 关注时间、调用链、provider latency、token、重试和 worker span；Metrics 关注聚合统计。它们不一定能重建控制状态，因为可能采样、延迟或被保留策略删除。

### 2.6 Provider Request

Provider Request 是模型可见 Context、工具 schema、模型参数和 provider 格式的最终投影。它必须记录 request identity 和 projection version，不能直接被当作完整 Session transcript。

## 3. 投影的一致性层次

### 3.1 Identity consistency

不同投影引用的是同一个 Session、Turn、Step、Tool Call 和 Plan revision。

### 3.2 Semantic consistency

投影表达的状态含义一致。例如 UI 显示工具等待审批，Context 不应告诉模型工具已经执行完成。

### 3.3 Temporal consistency

投影带有版本或时间边界，用户可以知道某状态来自何时。实时 UI 可以暂时落后，但不能将旧状态标成当前状态而不说明。

### 3.4 Capability consistency

Context 展示的工具、UI 显示的授权和实际执行策略一致。模型看到工具不代表一定可用，但应有明确限制。

### 3.5 Recovery consistency

从事件和当前 Environment 重建的状态，与 UI、Context 和 Plan View 的核心结论一致。

## 4. 为什么投影会分歧

### 4.1 异步传播

Runtime 先写事件，UI 通过订阅稍后收到；模型 Context 可能在下一次 Step 才更新。短暂不一致是正常的，但需要版本和顺序信息。

### 4.2 多个提交点

Tool effect、Observation、message projection 和 Plan update 可能不在一个事务中。文件已经修改，UI 还显示工具运行中，是提交点分离造成的中间状态。

### 4.3 投影转换错误

Session message 转换为 provider message 时，工具结果角色、调用 ID 或顺序可能被错误转换，导致模型看到的状态与 UI 不同。

### 4.4 过期 Environment

Context 和 Plan View 基于旧文件观察生成，而用户或后台任务已经修改 Workspace。此时投影可能忠实反映过去的事实，但不代表当前 Environment。

### 4.5 有意的信息裁剪

Audit 显示完整审批，UI 只显示允许/拒绝，Context 只看到当前 capability。信息不同不一定是不一致，但投影必须保留足够的来源和语义。

## 5. Projection Contract

每个投影都应声明一个简单契约：

```text
source state
selected fields
projection version
freshness boundary
omitted information
consumer
rebuild procedure
```

例如 Model Context：

```text
source: Session/Turn/Step facts + Environment observations
selected: current goal, active work, accepted tool results, capabilities
version: context-builder + model + tool-schema
freshness: request materialization time
omitted: old revisions, internal lease, raw trace
rebuild: reassemble from authoritative state
```

没有 projection contract，Context、UI 和 audit 会逐渐各自发展，最后无法解释同一工具为何在三个地方显示三种状态。

## 6. Context Projection

Context Builder 通常执行：

```text
select facts
  → filter stale observations
  → include current plan view
  → include effective capabilities
  → serialize tool schema
  → compact / truncate
  → provider-specific projection
```

它应记录 assembly metadata：包含了哪些事实、排除了哪些事实、使用了什么 model/tool schema version。

Codex 将 prompt history 与内部 history 分离；OpenCode 将 Session message 转为 LLM message；Pi 在 Agent loop 中创建 Context snapshot；Kimi Code 在请求定型时应用 Context 和请求状态。[^codex-history] [^opencode-context] [^pi-agent] [^kimi-materialize]

Context projection 的错误通常表现为：

- 模型重复执行已经完成的工具；
- 模型不知道当前审批已拒绝；
- 模型看到旧文件内容；
- 模型继续被 superseded 的计划驱动；
- 模型拥有过期或不存在的工具。

## 7. UI Projection

UI 需要把内部状态转换成可理解的交互状态，但应保留关键的不确定性：

```text
running             正在执行
waiting approval    等待授权
cancel requested    已请求取消，尚未确认停止
effect unknown      可能已产生副作用，需要对账
stale               历史证据已过期
needs decision      需要用户决定
```

如果 UI 只有“成功/失败”，它会把 Runtime 的关键安全状态隐藏掉。尤其是 cancel requested、effect unknown 和 orphaned 不应被渲染成普通失败。

OpenCode 的 Session message/event 层、OpenHands 的 Action/Observation 事件和 Codex 的 Turn/tool item lifecycle 都为 UI projection 提供事件基础，但 UI 是否完整暴露这些状态需要单独验证。[^opencode-context] [^openhands-events] [^codex-turn]

## 8. Plan View Projection

Plan View 不应直接读取模型最近一条 TODO 文本，而应从 Plan state 生成：

```text
current revision
  ├── completed with valid evidence
  ├── active owner
  ├── pending dependencies
  ├── blocked reason
  ├── stale evidence
  └── needs user decision
```

模型可以提出计划，Runtime 接受后才进入 Plan state；UI 只展示 Plan View。这样模型、UI 和恢复器不会分别维护三份互相竞争的 TODO。

## 9. Audit Projection

Audit 与 Context 的目标不同。Audit 需要保留：

- 原始 event identity；
- actor/worker；
- tool call 和参数摘要；
- approval scope；
- Environment reference；
- policy/schema/runtime version；
- recovery decision；
- 结果和未知状态。

Audit 可以比用户 UI 更详细，也可以对敏感 payload 做脱敏，但脱敏过程不能破坏责任和因果关系。

Codex 的 executed tool call metadata、Pi 的 durable frames、Kimi 的 task/tool dedupe 和 OpenCode 的 execution claim 都提供了审计投影的结构化来源。[^codex-recorder] [^pi-jsonl] [^kimi-task] [^opencode-execution]

## 10. Trace / Metrics Projection

Trace 记录 span 和 timing，Metrics 做聚合：

```text
request latency
first-token latency
tool duration
retry count
token usage
approval wait time
recovery duration
task success rate
```

Trace 可以引用 event_id 和 request_id，但不能假定每个 trace span 都是权威状态。采样、异步写入和丢失会使 trace 不完整。

另一方面，事实日志也不适合承载所有高频 delta 和性能数据。合理的设计是：核心状态保存足够的索引，详细 trace 通过引用关联。

## 11. Provider Request Projection

Provider Request 的投影边界是请求定型时：

```text
authoritative state
  → context selection
  → model/provider capability
  → tool schema
  → request serialization
  → frozen provider request
```

请求发出后，Context、模型、工具集合和策略版本不能静默变化。新的 Environment observation 或用户输入只能影响下一次请求。

模型切换时必须生成新的 provider projection。旧 provider message 可以作为历史事实或审计记录，但不能直接假定新 provider 接受同样的格式。

## 12. 投影延迟与版本

每个投影最好包含：

```text
source_revision
projection_revision
generated_at
valid_until / freshness policy
```

UI 订阅收到旧 revision 时可以丢弃；Context Builder 发现 Environment version 不匹配时可以重新观察；Plan View 发现 parent revision 变化时需要重新生成。

没有 revision，系统只能依赖时间戳；时间相同、时钟漂移和异步消息重排会使判断不可靠。

## 13. 投影冲突的诊断流程

当用户看到 UI 显示完成，但模型又重复执行工具时，可以按以下顺序排查：

```text
1. 权威 Tool/Plan state 是否真的 completed？
2. 完成状态是否有 acceptance/effect evidence？
3. UI 使用的 source_revision 是什么？
4. Context 使用的 history/context revision 是什么？
5. Environment 是否在两次请求之间变化？
6. Tool call identity 是否被保留？
7. 是事实冲突、投影延迟还是 Context assembly 错误？
```

这比直接修改 prompt 或增加一条“不要重复执行”的 system instruction 更可靠。

## 14. 各 Agent 的投影边界

### 14.1 Codex

Codex 将 Turn/Step/tool item、history、StepContext 和执行记录分层。模型 Context 是内部 history 的 projection，UI/事件则是执行生命周期的另一种 projection。[^codex-history] [^codex-step] [^codex-recorder]

优点是事实、模型历史和执行责任不必使用同一表示；代价是投影之间需要维护版本和配对。

### 14.2 Pi

Pi 的 Agent context snapshot 属于模型请求层，JSONL frame 和 harness state 属于 durable runtime；UI 和应用层可以从这些结构生成自己的视图。[^pi-agent] [^pi-jsonl] [^pi-harness]

它将底层 Agent loop 与产品投影解耦，扩展性强；但应用需要自己保持 Context、UI 和 recovery view 一致。

### 14.3 OpenCode

OpenCode 的 Session message、`to-llm-message`、execution claim、compaction 和 workspace provider 构成多个明确投影层。[^opencode-context] [^opencode-execution] [^opencode-workspace]

这使 provider 输入、Session 历史和执行责任可以分别演进，但转换错误可能导致模型、UI 和执行状态分歧。

### 14.4 OpenHands

OpenHands 的 Action/Observation 事件、Conversation history、agent-server context 和 workspace 状态面向不同消费者。[^openhands-events] [^openhands-adapter]

前端历史存在不等于 backend Context 和 workspace 都可继续，投影必须显示或处理远程 Environment 的可用性。

### 14.5 Kimi Code

Kimi Code 的 task state、StepRequest、prompt queue、tool policy、permission gate 和 subagent context 形成请求级、任务级和权限级投影。[^kimi-task] [^kimi-request] [^kimi-policy] [^kimi-permission] [^kimi-subagent]

请求定型时生成模型输入，任务/权限状态则作为 Runtime 权威状态保留；这有利于并发和恢复，但需要避免队列视图与实际执行视图脱节。

### 14.6 Gemini CLI

Gemini CLI 的 Session transcript、dynamic instructions、SessionContext 和 shell/policy 层形成模型与执行的不同视图。[^gemini-session] [^gemini-types] [^gemini-policy]

动态 Context 适合 CLI 交互，但 UI、Session history 和当前 cwd 的新鲜度需要明确边界。

### 14.7 mini-SWE-agent

mini-SWE-agent 的 trajectory 同时承担模型历史和执行观察的主要表示，独立 UI、audit 和 recovery projection 很少。[^mini-default] [^mini-environment]

这提供最小基线，也说明当系统增加持久化、并行和远程执行后，为什么需要把投影从 trajectory 中拆出。

## 15. 设计原则

### 原则一：投影不拥有事实

Context、UI、Plan View 和 Trace 都可以重建，不能成为唯一权威来源。

### 原则二：每个投影声明来源和新鲜度

用户和调试器必须知道一个状态来自哪个 revision、何时生成、适用哪个 Environment。

### 原则三：语义一致比文本一致更重要

不同投影可以有不同格式和信息量，但不能对同一 Tool、Plan 或 Approval 作相互矛盾的核心判断。

### 原则四：隐藏信息必须有理由

Context 和 UI 可以裁剪内部字段，但不能因此丢失安全、恢复和用户决策所需的状态。

### 原则五：投影转换产生版本

模型、工具 schema、Context builder 和 UI projection 变化后，旧投影不能被无标记地当作新事实。

### 原则六：先诊断权威状态，再修复投影

发现 UI、模型和审计不一致时，先确认事实状态和 Environment，再判断是哪一个 projection 出错。

## 16. 验证方案

### 16.1 同源多投影实验

从一组固定事实生成 Context、UI、Plan View、Audit 和 Trace，检查：

- Session/Turn/Step identity 一致；
- Tool call 状态不矛盾；
- Approval scope 一致；
- Plan revision 和 active work 一致；
- Environment reference 一致。

### 16.2 延迟与乱序实验

让 UI event、Context update 和 Audit write 以不同顺序到达，验证 revision/sequence 是否能阻止旧投影覆盖新状态。

### 16.3 Stale Environment 实验

生成 Context 后修改工作树，再执行 Tool Call 和 Plan View 更新，验证系统是否识别旧 Context/完成证据已过期。

### 16.4 投影重建实验

删除 UI 和 Context cache，只保留权威事件、快照和 Environment reference，重新生成所有投影，检查是否得到相同的核心结论。

本文没有对所有 Agent 统一执行这些投影测试。源码和固定版本测试可以证明部分转换边界；实际 UI 重连、异步订阅、provider serialization 和远程 Environment freshness 仍需要运行验证。

## Agent State 专题收束

四篇文章形成完整状态模型：

```text
状态分类与所有权
  → 生命周期与状态转移
  → 持久化与恢复重建
  → Context / UI / Plan / Audit / Trace 投影
```

最终需要坚持的判断是：

> Agent State 不是一个对象，而是一组由不同 owner 管理、以不同生命周期变化、通过多个 projection 被消费的事实和控制状态。

成熟 Harness 的能力，不是让所有表示永远同步，而是让每个表示都能说明自己的来源、版本、新鲜度和权威边界；当它们发生分歧时，系统可以定位分歧来源，并从权威事实和当前 Environment 重新建立一致结论。

## 未确认事项

- 各 Agent 的 UI projection 是否直接消费权威 event，还是经过独立缓存和服务转换，需要逐项目确认。
- Provider Request 是否完整保存 projection metadata，不能仅从模型 adapter 推断。
- Trace/metrics 丢失时是否影响恢复和验收，取决于项目是否错误地把可观测性当作事实来源。
- OpenHands、Codex 和 Kimi Code 的多服务投影顺序需要运行时实验验证。

## 参考源码

[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
