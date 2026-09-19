---
title: Coding Agent 的状态持久化与恢复重建
series: Coding Agent 的 Agent State：状态分类、所有权与派生关系
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的状态持久化与恢复重建

## 结论

Agent State 的持久化不是把内存对象完整写入磁盘，而是为每种状态选择正确的恢复策略：

```text
事实状态       持久化并重放
控制状态       从事实重建，必要时保存快照
任务状态       持久化 revision、依赖和验收证据
外部状态       持久化引用和观察，恢复时重新确认
派生状态       通常重新计算
临时状态       丢弃、重建或进入恢复分支
```

这个区分决定了恢复是否安全。Session history 可以从磁盘读取，不代表 Workspace 仍然相同；Tool Call 可以在日志中出现，不代表命令已经完成；Plan item 可以显示 completed，不代表完成证据仍适用于当前 Environment。

恢复的正确目标不是恢复到“崩溃前内存的每一个字段”，而是：

> 从持久化事实、当前外部观察和有效权限重新构造一个可以解释、可以继续或可以安全停止的 Runtime 状态。

## 1. 三种持久化对象

### 1.1 事实记录

事实记录描述已经接受或观察到的事件：用户输入、Tool Call、Approval、ExecutionStarted、ObservationReady、PlanRevision 和 RecoveryDecision。

事实记录应该尽量追加写入，不通过更新旧记录来伪造历史。它们是恢复和审计的基础。

### 1.2 当前快照

快照保存某一事件边界上的当前控制状态，例如：

- Session 当前状态；
- active Turn 和 Step；
- Plan revision；
- pending approvals；
- running/blocked operations；
- 当前 owner/lease；
- history version。

快照用于加速恢复，但必须能说明由哪些事件生成，并且不能替代事实日志。

### 1.3 外部引用

外部 Environment、artifact、远程任务、进程和 provider request 通常不能完整嵌入 Runtime 状态。系统应保存它们的 identity、version、lease、request ID 或 snapshot reference，恢复时重新查询。

OpenHands 的 workspace/sandbox/session context、OpenCode 的 execution claim、Pi 的 JSONL/frame/restore 和 Codex 的 history/Turn 状态分别展示了事实、控制快照和外部引用的不同组合。[^openhands-adapter] [^opencode-execution] [^pi-jsonl] [^pi-restore] [^codex-history]

## 2. 必须持久化什么

判断标准是：如果丢失某个状态，恢复器是否可能做出不同且危险的决定。

### 2.1 身份和因果关系

必须保留 Session、Turn、Step、Plan、Tool Call、Approval、Environment 和 child run 的关联。没有身份，恢复器只能依赖时间顺序，无法区分并发调用和重试。

### 2.2 已接受的输入和动作

用户输入、已接受的模型 response、Tool Call admission 和 Plan revision 应保存。模型原始输出可以按成本策略外置，但不能只保存最终自然语言而丢失结构化 tool identity。

### 2.3 权限和审批

Approval 需要保存 scope、call identity、policy version、decision、actor 和过期/消费状态。恢复后不能从一条“用户同意了”消息猜测授权范围。

Codex 将审批等待和调用身份绑定；Kimi Code 将 permission gate 和 task state 分开；Gemini CLI 通过 policy engine 在工具执行前评估策略。[^codex-approval] [^kimi-permission] [^gemini-policy]

### 2.4 未完成工作

必须知道哪些 operation 尚未进入终态：模型请求、工具执行、审批、后台服务、child run、计划验收和远程任务。

一个系统如果只保存已经完成的消息，重启后可能看起来很干净，却丢失了最需要处理的工作。

### 2.5 验收证据

Plan item completed 必须关联检查类型、结果、Environment reference、版本和时间。否则恢复器无法判断旧证据是否仍然有效。

## 3. 什么不应直接持久化为权威状态

### 3.1 UI projection

进度条、工具卡片和当前页面可以重建，不应作为 Runtime 完成状态的来源。

### 3.2 完整 Context

可以缓存某次模型请求，但 Context 通常是事实、策略、工具和 Environment 观察的派生结果。模型切换或 compaction 后需要重新生成。

### 3.3 Stream buffer

流式 buffer 可能保存为诊断信息，但未完成 buffer 不应被当作完整 assistant message 或 Tool Call。

### 3.4 当前 Environment 快照的假设

旧文件内容、进程列表和远程资源状态可以作为历史观察，但不能作为恢复后的当前状态。必须重新观察或校验版本。

### 3.5 KV cache

KV cache 是 provider 优化，不是事实状态。它失效后应重新构造请求，不能因为 cache 不可恢复而丢失 Session 语义。

## 4. 事件日志与快照的关系

```text
event e1 -> e2 -> e3 -> e4 -> e5
                         ↓ snapshot S1
event e6 -> e7 -> e8 -> recovery
```

恢复器读取 `S1 + e6..e8`，而不是从最初事件重新扫描全部历史。快照必须带有：

- last applied event sequence；
- schema/runtime version；
- Environment references；
- active owner/lease；
- plan/history revision；
- snapshot creation time。

如果快照没有事件边界，恢复器无法判断哪些事件已经被应用，可能重复计数或跳过变化。

Pi 的 JSONL storage 和 durable restore 将 frame、运行状态和恢复逻辑分开；Codex 的 history version 和 compaction 则说明模型历史快照不能替代完整执行事实。[^pi-jsonl] [^pi-restore] [^codex-history]

## 5. 恢复重建顺序

安全恢复应按依赖顺序进行：

```text
1. 读取 schema/runtime version
2. 读取事实日志和最新快照
3. 重建 Session identity 与 history boundary
4. 重建 Turn / Step / Plan 控制状态
5. 扫描未完成 Tool / Approval / Child operation
6. 获取或重新确认 Environment
7. 对账外部 effect 和验收 evidence
8. 重新计算 Capability / Authority
9. 生成 recovery decision
10. 重建 Context、UI 和 Plan View
11. 只有必要时调用模型
```

顺序不能反过来。先生成模型 Context 再确认 Environment，会把旧观察当成新事实；先恢复工具执行再恢复 Approval，可能越权；先显示 UI 完成再确认 operation，会制造假成功。

## 6. Session 重建

Session 恢复需要确认：

- Session identity 是否有效；
- history 是否完整或存在合法 compaction boundary；
- 是否还有未完成 Turn；
- 默认模型和配置是否发生变化；
- Environment reference 是否仍然存在；
- 是否有 child/background operation；
- 用户是否已经撤销授权。

恢复后的 Session 可以与崩溃前拥有不同的 worker、模型或 Environment，但事实历史和未完成责任必须可关联。

Codex 的 Session fork/reconstruction、Gemini CLI 的 Session transcript/context、OpenCode 的 Session storage/projection 展示了长期会话恢复与当前运行恢复的区别。[^codex-session] [^gemini-session] [^opencode-context]

## 7. Turn 与 Step 重建

### 7.1 Turn

Turn 应从输入、执行事实、pending input、approval 和 child operation 重建：

```text
no pending work + all checks resolved -> converged
pending approval -> waiting_approval
orphaned child -> recovery_required
unknown effect -> needs_decision
```

### 7.2 Step

Step 应判断请求处于：

- 尚未发送；
- provider 可能已接受；
- stream partial；
- assistant response 已接受；
- tool call 已接受但未执行；
- tool 已执行但结果丢失；
- 已完成。

不能因为存在一条 assistant message 就直接把 Step 恢复到 completed。

Codex 的 StepContext、Kimi Code 的 StepRequest/materialize 和 Pi 的 assistant generation recovery 都说明 Step 需要自己的请求身份和恢复边界。[^codex-step] [^kimi-materialize] [^pi-recovery]

## 8. Plan 重建

Plan 需要恢复：

- 当前 revision；
- 每个 work item 的状态；
- 依赖和阻塞原因；
- 已完成的验收证据；
- child run 和 artifact；
- 受影响的 Environment scope；
- 旧 revision 与新 revision 的关系。

已完成但 Environment 已变化的项应进入 `stale_completed`，而不是直接重跑全部计划或继续相信旧结果。

如果旧计划被 supersede，恢复器应保留旧计划作为历史，并从最新 revision 的 active branch 继续。

## 9. Tool 与 Approval 重建

工具恢复需要先确定 effect 状态：

```text
call accepted, no start      -> retryable / cancelled
started, no observation      -> running / unknown
effect likely present        -> reconcile
finished with result         -> completed
approval pending             -> waiting_approval
approval expired             -> request again
```

工具去重只适用于 call identity 和结果仍然可用的情况。没有幂等键或 effect 查询能力时，恢复器不能盲目重新执行。

Codex 保留 executed tool call metadata；Pi 的工具恢复策略区分 replay；Kimi Code 使用 tool dedupe；OpenCode 的 execution claim 处理运行者接管。[^codex-recorder] [^pi-tool-recovery] [^kimi-dedupe] [^opencode-execution]

## 10. Environment 重建与重新观察

Environment 不能从 cwd 字符串重建。至少需要验证：

- workspace identity；
- branch/commit/snapshot；
- 容器或 sandbox identity；
- 进程和后台服务；
- 文件和 Git 状态；
- 远程资源和服务 URL；
- Environment 是否被其他 Agent 使用。

OpenHands 的 workspace/sandbox context、Codex 的 Environment binding、Gemini CLI 的 cwd/SessionContext 和 mini-SWE-agent 的 Environment protocol 都说明环境引用是运行语义的一部分。[^openhands-adapter] [^codex-step] [^gemini-types] [^mini-environment]

恢复后重新观察不一定要全量扫描。可以依据 operation scope、文件版本和验收条件只检查相关资源，但必须明确检查范围。

## 11. Capability 与 Authority 重建

能力状态不能从旧 Context 直接恢复。需要重新计算：

```text
current capability =
model/provider capability
∩ current policy
∩ current approval
∩ current Environment
∩ task scope
```

用户在暂停期间撤销目录信任、改变网络策略或切换模型后，旧 Step 的 capability 不能自动延续到新执行。

恢复器也应区分：

- 历史上曾经被允许的动作；
- 当前仍然允许的动作；
- 已经消费或过期的 approval；
- 新 revision 需要重新授权的动作。

## 12. 恢复与派生视图

恢复顺序完成后，才能重新生成：

```text
authoritative state
  ├── model Context
  ├── UI state
  ├── plan view
  ├── audit view
  └── metrics/trace view
```

OpenCode 的 `to-llm-message`、Codex 的 history manager 和 Pi 的 context snapshot 都体现了模型输入是派生视图；UI 同样应该从恢复后的权威状态重新投影。[^opencode-context] [^codex-history] [^pi-agent]

如果先恢复 UI 再恢复 Runtime，用户可能看到旧的“运行中”或“已完成”；如果先调用模型再重建计划，模型会基于过期状态继续执行。

## 13. 恢复中的版本兼容

持久化状态至少有三种版本：

```text
data schema version
runtime interpretation version
upstream/project version
```

旧事件字段可以仍然可读，但新 Runtime 对状态的解释可能改变。恢复器应：

- 迁移结构化字段；
- 保留原始事件；
- 记录解释器版本；
- 对未知事件采取保守策略；
- 不将无法理解的状态自动标记为 completed。

模型、工具 schema 或 policy version 变化时，旧 Context projection 也可能不能直接重用，需要重新生成。

## 14. 崩溃窗口分析

典型写文件工具可能经历：

```text
ToolCallAccepted
ExecutionStarted
file effect
ObservationReady
ExecutionFinished
Plan evidence committed
```

每两个事件之间都可能崩溃。恢复策略如下：

| 崩溃位置 | 恢复处理 |
| --- | --- |
| Accepted 前 | 不应假设调用存在 |
| Started 前 | 可以检查是否可安全重试 |
| effect 后 | 先对账，可能 unknown |
| Observation 后 | 复用结果或重新验证 |
| Finished 后 | 重建 tool completed |
| Plan evidence 前 | 工具完成但计划仍需验收 |

这说明状态持久化的核心不是每个 token 都写磁盘，而是为不可逆副作用和控制流转移定义恢复边界。

## 15. 不同 Agent 的恢复取舍

### 15.1 Codex

Codex 将 Session/Turn/Step、history、工具记录、审批和 Environment 条件分层，恢复时需要同时重建对话事实和执行责任。[^codex-session] [^codex-step] [^codex-recorder]

### 15.2 Pi

Pi 的 JSONL frames、durable harness、restore 和 recovery 将库级 Agent loop 与长期运行状态分开。[^pi-jsonl] [^pi-restore] [^pi-recovery]

### 15.3 OpenCode

OpenCode 使用 Session message、execution claim、compaction 和 workspace provider 共同表达恢复边界；Session 可恢复不等于 workspace effect 已完成。[^opencode-execution] [^opencode-context] [^opencode-workspace]

### 15.4 OpenHands

OpenHands 的 Conversation、agent-server、sandbox 和 workspace 分离，使恢复需要先重新建立可用 Environment，再恢复 Agent 状态。[^openhands-adapter]

### 15.5 Kimi Code

Kimi Code v2 的 task persistence、StepRequest、tool dedupe、permission gate 和 subagent context 为请求级恢复提供身份和状态。[^kimi-task] [^kimi-request] [^kimi-dedupe] [^kimi-subagent]

### 15.6 Gemini CLI 与 mini-SWE-agent

Gemini CLI 更偏 Session transcript/context 的恢复；mini-SWE-agent 默认更偏 trajectory 的继续。[^gemini-session] [^mini-default]

二者都说明对话可恢复和完整执行可恢复是不同能力。

## 16. 设计原则

### 原则一：事实持久化，状态重建

尽量追加保存事件，当前控制快照可以重建或定期保存。

### 原则二：外部世界重新观察

文件、进程、远程资源和服务状态不应被旧快照永久替代。

### 原则三：恢复先对账，后重试

尤其是可能有副作用的 Tool Call，未知状态不能直接重放。

### 原则四：快照必须有事件边界

没有 last applied event/version 的快照不具备可靠恢复语义。

### 原则五：派生视图最后重建

Context、UI、Plan View 和 Trace 应从恢复后的权威状态生成。

### 原则六：恢复动作本身也是事实

继续、重试、跳过、对账和请求用户确认都应记录新的 RecoveryDecision。

## 17. 验证方案

### 17.1 状态重建测试

从事件日志和快照重建 Session、Turn、Step、Plan、Tool 和 Approval，比较与在线快照的控制结论。

### 17.2 外部状态变化测试

恢复前修改文件、切换分支、终止进程、销毁 sandbox 或变更远程资源，验证旧 observation 是否被标记 stale。

### 17.3 多 worker 恢复测试

让旧 worker 在 lease 过期后返回迟到结果，验证 fencing 阻止旧结果覆盖新状态。

### 17.4 派生视图重建测试

从同一权威状态生成 Context、UI 和 Plan View，确认 active work、权限和 Environment reference 一致。

本文没有在各 Agent 上统一执行上述恢复测试。源码和测试可以证明部分存储、restore、claim、task 或 history 结构；真实远程 Environment、provider 提交状态和多进程竞争仍需运行验证。

## 未确认事项

- 各项目的快照是否能独立于进程完整重建控制状态，需要进一步读取存储适配器。
- 外部 effect 查询能力决定了 unknown 是否能自动收敛，各 Agent 的工具覆盖范围不同。
- 旧 Runtime 版本和新 Runtime 版本之间的持久化迁移策略尚未系统比较。
- UI 重连、后台任务恢复和远程 sandbox 重建的实际顺序需要产品级实验。

下一篇将研究状态投影与一致性：同一权威状态如何生成 Model Context、UI、Plan View、Trace，以及不同投影发生分歧时如何定位问题。

## 参考源码

[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^codex-session]: [Codex Session and fork persistence](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/session.rs#L620-L735)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^pi-tool-recovery]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
