---
title: Coding Agent 的状态生命周期与状态转移
series: Coding Agent 的 Agent State：状态分类、所有权与派生关系
part: 2
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的状态生命周期与状态转移

## 结论

Agent State 的难点不在于定义多少状态，而在于定义状态如何变化、变化由谁触发、变化是否可以撤销，以及状态变化如何影响其它生命周期。

一个用户输入可能引发一条跨层状态链：

```text
Session accepts input
  → Turn admitted
  → Plan/work item selected
  → Step request materialized
  → Model response received
  → Tool call accepted
  → Approval / capability checked
  → Environment effect executed
  → Observation committed
  → Plan revised or item completed
  → Turn converges
```

这些状态并不是一个大状态机中的简单节点。Session、Turn、Step、Tool、Plan、Approval、Environment 和 Provider 各自有生命周期，之间通过事件和引用关联。

因此，正确的问题不是“Agent 当前是什么状态”，而是：

1. 哪个状态正在变化？
2. 哪个 owner 可以触发变化？
3. 哪些前置事实已经成立？
4. 变化是否产生新的外部副作用？
5. 其它状态是同步变化、异步观察，还是稍后重新计算？

## 1. 状态转移的四个基本元素

一个合法的状态转移至少包含：

- subject：哪个对象在变化；
- from/to：前后状态；
- event：触发事件；
- guard：转移成立的条件；
- owner：可以提交转移的责任方；
- effects：转移产生的副作用；
- evidence：支持转移的事实。

例如，工具从 `waiting_approval` 进入 `authorized`，不能只保存 `status = authorized`。恢复器还需要知道哪个 approval 授权、授权范围是否匹配、策略版本是什么，以及审批是否已经被消费。

## 2. 状态转移的来源

状态变化通常由五类事件触发：

### 2.1 用户事件

输入、取消、steer、审批、模型切换、增加信任目录和确认交付结果。

### 2.2 模型事件

assistant response、tool call proposal、finish reason、模型请求失败和 fallback proposal。

模型事件只能提出动作或决策，不能直接修改权限、Environment 或外部资源状态。

### 2.3 Runtime 事件

admit、claim、step activation、compaction、recovery decision、plan revision 和 worker handoff。

### 2.4 Tool / Environment 事件

process started、observation ready、file changed、test passed、remote resource created、sandbox lost。

### 2.5 Provider 事件

stream opened、delta received、rate limited、response completed、connection lost 和 usage reported。

事件来源不同，owner 和可信度也不同。用户可以提出取消意图，Runtime 才能决定取消是否已经确认；模型可以提出工具调用，Tool Runtime 才能接受或拒绝；Environment 可以返回文件状态，但不能直接宣布 Plan completed。

## 3. Session 生命周期

Session 是长期交互和事实归属的边界，典型状态包括：

```text
CREATED → ACTIVE → IDLE → SUSPENDED → RESUMING → ACTIVE → CLOSED
```

### 3.1 Session Created

创建身份、配置、默认模型、初始 Environment 引用和持久化位置。此时没有必要启动模型或工具。

### 3.2 Session Active

可以接收用户输入、启动 Turn 和执行后台任务。Active 不代表一定有模型请求，可能处于等待审批或等待 Environment。

### 3.3 Session Suspended

运行者停止、网络断开或 Environment 暂停，但事实和恢复信息仍然存在。Suspended 不是 Closed，也不意味着后台 operation 已完成。

### 3.4 Session Resuming

恢复器读取事实和控制快照，重新获取 owner，重新观察 Environment，并重建 Context/Plan View。只有必要时才调用模型。

### 3.5 Session Closed

不再接受新的 Turn，未完成 operation 已终止、转移或明确交给外部系统。关闭 Session 不应删除历史事实。

Codex 的 Session/Turn/Task 结构、Pi 的 durable harness、OpenCode 的 Session execution 和 Gemini CLI 的 SDK Session 分别在不同层次表达了长期会话与当前运行的区别。[^codex-session] [^pi-harness] [^opencode-execution] [^gemini-session]

## 4. Turn 生命周期

Turn 表示一次用户目标或一次可辨识的任务推进：

```text
ADMITTED → RUNNING → WAITING → RUNNING → CONVERGED

RUNNING → CANCEL_REQUESTED → CANCELLED
RUNNING → FAILED
RUNNING → BLOCKED
```

### 4.1 Admitted

输入已被 Session 接受并分配 Turn identity。模型还没有必要被调用。

### 4.2 Running

Turn 拥有一个或多个 active Step、工具或子任务。新的用户输入可以被排队、steer 或分配给下一次请求，具体取决于 Runtime 语义。

### 4.3 Waiting

等待审批、工具、后台任务、远程 Environment 或用户补充信息。Waiting 是有意暂停，不是异常。

### 4.4 Converged

所有同步工作已完成、失败或明确交给后台 operation，且 Turn 不再有未处理的输入和悬挂控制状态。

Codex 将 Turn 输入、取消、pending input 和 Step 运行联系起来；Pi 区分 steer、follow-up、abort 和 idle；Kimi Code 通过 Prompt/Step request 和 task state 管理活跃与排队请求。[^codex-turn] [^pi-input] [^kimi-prompt]

## 5. Step 生命周期

Step 是一次模型—Runtime 的决策单元，通常具有更短生命周期：

```text
CREATED → ADMITTED → MATERIALIZED → REQUESTING → RESPONDING
                                      → ACCEPTING_RESULT → COMPLETED

任何阶段 → FAILED / CANCELLED / RECOVERY_REQUIRED
```

### 5.1 Created / Admitted

Runtime 决定下一次模型请求属于哪个 Turn、Plan item 和 Environment。请求 identity 在这一阶段生成。

### 5.2 Materialized / 请求定型

模型、Context、工具集合、权限、Environment reference 和 provider 参数被具体确定，随后请求条件冻结。

### 5.3 Requesting / Responding

Provider 请求已发送，Runtime 接收 stream。当前 Step 的模型和工具集合不应被无标记修改。

### 5.4 Accepting Result

Runtime 验证 assistant text、tool call、finish reason 和 usage，决定是否接受为事实。

### 5.5 Completed

Step 结束，但 Turn 可能继续执行工具、计划项或下一次模型请求。Step completed 不等于用户任务 completed。

Codex 的 StepContext、Kimi Code 的 StepRequest/materialize、Pi 的 Agent loop context snapshot 都体现了请求级边界。[^codex-step] [^kimi-materialize] [^pi-agent]

## 6. Tool Call 生命周期

```text
PROPOSED → ACCEPTED → APPROVAL_REQUIRED → AUTHORIZED → STARTED
                                                    → OBSERVING → FINISHED

PROPOSED → REJECTED
AUTHORIZED → CANCELLED
STARTED → EFFECT_UNKNOWN
```

工具调用状态与 Step 状态不完全同步：Step 可以已经收到完整 tool call，但 Tool 仍在等待审批；Tool 可以已经产生 effect，但 Step 尚未收到 observation。

Codex 的 executed tool call metadata、Pi 的 tool preparation/execution、Kimi Code 的 tool policy/permission/dedupe 和 OpenHands 的 Action/Observation 事件为这一分层提供了实现证据。[^codex-recorder] [^pi-prepare] [^kimi-policy] [^openhands-events]

## 7. Plan Item 生命周期

```text
PENDING → READY → ACTIVE → VERIFYING → COMPLETED

ACTIVE → BLOCKED
ACTIVE → FAILED
ACTIVE → SUPERSEDED
ACTIVE → CANCELLED
```

Plan item 可以跨多个 Step 和 Tool Call。它的完成通常需要 acceptance evidence，不应由单个 assistant message 直接设置为 completed。

Plan item 的 `ACTIVE` 不能简单等同于“模型正在生成”：模型可能在等待工具、等待审批或由子 Agent 执行。

## 8. Environment 生命周期

```text
REQUESTED → PROVISIONING → READY → IN_USE → PAUSED
                                      → RESUMING → DESTROYED
```

Environment 的状态由 Environment owner 或 provider 控制，不由模型直接决定。Agent Runtime 保存 Environment reference 和观察，但必须处理：

- workspace 被用户修改；
- sandbox 被销毁；
- 进程被外部终止；
- 远程服务仍然运行但 Session 已断开；
- 同一目录被另一个 Agent 使用。

OpenHands 的 agent-server/sandbox/workspace 结构、Gemini CLI 的 SessionContext/cwd、mini-SWE-agent 的 Environment protocol 都说明 Environment 需要独立生命周期。[^openhands-adapter] [^gemini-types] [^mini-environment]

## 9. 状态之间如何触发变化

### 9.1 User Input → Turn

Session 接受输入，创建或更新 Turn。输入不会直接修改 Step 的当前请求；如果 Step 正在运行，输入可能进入 steer、pending queue 或下一 Turn。

### 9.2 Model Response → Tool

模型响应提出 Tool Call，Runtime 先接受并检查 capability，之后才进入 approval/execution。模型不能直接把工具变为 started。

### 9.3 Tool Observation → Plan

工具结果可能满足验收、产生失败或使前提失效。Plan Runtime 根据 evidence 更新 work item，不应由工具 wrapper 直接完成整个任务。

### 9.4 Environment Change → Context

Environment observation 使旧 Context 变 stale。Context Builder 在下一次请求中重新选择和投影，而不是直接修改已经发送的 Context。

### 9.5 Approval → Capability

Approval 只扩大或确认特定调用 scope。它不应改变 Session 的所有权限，也不应自动授权后续不同参数。

### 9.6 Recovery → Control State

恢复器读取事件、快照和 Environment 状态，生成新的 recovery decision，随后把 operation 归类为继续、重试、对账、阻塞或终止。

## 10. 状态转移的同步与异步边界

有些变化必须同步提交：

- 接受 Tool Call 和分配 call identity；
- Approval 决策和 scope；
- owner claim 和 lease；
- Plan revision 的版本号。

有些变化只能异步观察：

- 远程进程是否真正停止；
- provider 是否已经接受请求；
- 后台任务是否完成；
- 用户是否修改了共享文件。

系统不能把异步观察当作同步事实。例如发送 cancel 请求后，状态应先是 `cancel_requested`，而不是立即 `cancelled`；发送远程创建请求后，不能立即标记资源 `created`。

## 11. State Transition Guards

每个关键转移都应有 guard：

```text
ToolCall -> Authorized
  requires matching approval and policy version

Step -> Completed
  requires accepted response or explicit failure

PlanItem -> Completed
  requires acceptance evidence

Turn -> Converged
  requires no unhandled synchronous work

Session -> Closed
  requires child operations terminated/transferred

Recovery -> Retryable
  requires effect absent or retry-safe
```

Guard 是防止状态被模型文本、UI 点击或旧 worker 直接覆盖的主要机制。

## 12. 状态转移与不可变事实

推荐将状态变化表示为：

```text
immutable event + new current snapshot
```

而不是：

```text
mutable object.status = "completed"
```

当前快照可以为了性能原地更新，但必须能够通过 event/version 解释这次变化。Pi JSONL storage、Codex history/version 和 Kimi task persistence 分别体现了事件/帧、历史版本和持久任务状态的不同实现方式。[^pi-jsonl] [^codex-history] [^kimi-task]

## 13. 状态转移与并发

并发状态变化需要版本或 owner：

```text
read revision 7
  ├── worker A writes revision 8
  └── worker B tries to write based on revision 7 -> reject/rebase
```

没有 revision check 时，旧 worker 的迟到结果可能覆盖新 worker 的计划、工具或控制状态。

OpenCode execution claim、Pi lane/operation、Codex 子 Agent wait/steer 和 Kimi task/request identity 都体现了并发状态需要责任归属。[^opencode-execution] [^pi-harness] [^codex-wait] [^kimi-request]

## 14. 状态转移与模型 Context

模型只能看到 Context projection，不应直接修改权威 state。一个典型流程是：

```text
Runtime state
  → Context Builder
  → Model response
  → Proposal / Tool Call
  → Admission + Policy
  → State transition
```

模型输出的“已完成”“已授权”“已修改文件”都只是 proposal 或 claim，除非有对应 Runtime/Environment evidence。

Codex 的 history/StepContext、OpenCode 的 message projection、Gemini CLI 的 SessionContext 和 Pi 的 context snapshot 都支持“模型上下文是派生视图”的判断。[^codex-step] [^opencode-context] [^gemini-types] [^pi-agent]

## 15. 不同 Agent 的状态转移取舍

### 15.1 Codex：产品化的层级控制

Codex 把 Session、Turn、Step、工具、权限、Environment 和子 Agent 任务组合成较完整的控制层。Step activation 和 Turn loop 负责把状态变化约束在明确边界；工具和审批拥有独立状态。[^codex-turn] [^codex-step] [^codex-approval]

这使它适合处理持续输入、审批、中断和后台任务，但状态转移路径更复杂，需要维护多层 ID 和异步等待。

### 15.2 Pi：loop 状态与 durable harness 分层

Pi 的 Agent loop 关注 messages、tools、steer、follow-up 和 abort；harness 层增加 lane、operation、frame、restore 和 recovery。[^pi-loop] [^pi-harness]

底层状态机较轻，扩展性强；长期运行状态需要由 harness 或应用层定义 owner、持久化和计划转移。

### 15.3 OpenCode：Session execution 与 projection

OpenCode 将 Session message、execution claim、compaction 和 workspace provider 分开，状态转移通过 execution/claim 和消息投影共同表达。[^opencode-execution] [^opencode-context]

它的关键取舍是把“谁在执行”和“模型/用户看到什么”分离，减少 UI 或 message 对执行状态的直接控制。

### 15.4 OpenHands：事件驱动与远程环境

OpenHands 使用 Action/Observation 事件表达 Agent 与 Environment 互动，agent-server、sandbox 和 workspace 形成额外运行边界。[^openhands-events] [^openhands-adapter]

状态转移必须跨服务和网络处理，远程 Environment 的异步性比本地 loop 更突出。

### 15.5 Kimi Code：请求、任务与权限状态

Kimi Code v2 把 StepRequest、Prompt queue、task persistence、tool policy、permission gate、dedupe 和 subagent context 分层。[^kimi-request] [^kimi-prompt] [^kimi-task] [^kimi-policy] [^kimi-subagent]

它强调请求级状态和队列控制，适合处理 steer、取消和并行请求，但需要严格处理排队期间状态变化。

### 15.6 Gemini CLI：Session loop 与动态上下文

Gemini CLI 的 Session loop 负责 transcript、动态 instructions 和工具执行，状态转移更多通过连续请求和工具 observation 推进。[^gemini-session]

结构清晰、适合 CLI/SDK 复用，但复杂后台任务、子 Agent 和恢复控制通常需要更高层补充。

### 15.7 mini-SWE-agent：最小状态机

mini-SWE-agent 的 DefaultAgent 主要在 query、action、observation 之间循环，提供最小状态基线。[^mini-default]

它的优势是状态少、行为容易观察；代价是 Session、Plan、Approval、Coordination 和 Recovery 状态需要应用层额外实现。

## 16. 设计原则

### 原则一：状态转移必须有明确 owner

模型、UI、工具、Environment 和恢复器都可以触发请求，但只能由对应 owner 提交合法转移。

### 原则二：状态变化必须可解释

每个关键状态都应能追溯到事件、条件、责任主体和证据。

### 原则三：异步请求不等于异步完成

发送 cancel、approval 或 remote operation 后，只有收到确认或观察到终态才能完成转移。

### 原则四：子状态终态不能自动推出父状态终态

Tool completed 不等于 Step completed；Step completed 不等于 Turn completed；child completed 不等于 parent plan completed。

### 原则五：状态 owner 可以转移，但必须有 claim/lease/fencing

恢复和多 Agent 场景中，旧 owner 的迟到事件不能覆盖新 owner 的状态。

### 原则六：状态快照服务性能，事件提供解释

快照可以快速恢复，但不能替代状态变化的因果记录。

## 17. 验证方案

### 17.1 合法转移测试

对每个状态机测试：

- 合法前置状态；
- 缺少 approval；
- 过期 Environment；
- 重复 event；
- 旧 revision 更新；
- 无 owner 的 worker 更新；
- 取消未确认；
- effect unknown 下的 retry。

### 17.2 跨层转移测试

验证以下链路：

```text
user input -> Turn -> Step -> Tool -> Environment
Environment observation -> Plan -> Context -> next Step
approval -> capability -> Tool execution
worker loss -> recovery -> owner handoff -> continued Step
```

每条链都应检查父子状态是否发生了正确的部分转移，而不是被一次事件错误地全部设置为完成。

### 17.3 状态重建测试

从事件日志删除当前快照，重新计算 Session、Turn、Step、Plan 和 Tool 状态，检查是否得到相同的控制结论。对无法重建的外部状态，测试应确认系统进入重新观察或 unknown，而不是猜测。

本文没有对所有 Agent 统一运行这些状态机测试；源码和项目测试提供了局部转移证据，跨项目统一的状态重建和并发 fencing 仍需后续实验。

## 未确认事项

- 各项目是否拥有统一的跨层状态机，还是由多个服务/模块隐式协作，需进一步确认。
- 某些 Agent 的 UI 状态是否可以反向触发 Runtime transition，需结合产品层调用路径研究。
- 远程 Environment 的终态确认和 provider 请求提交状态可能无法由本地状态机证明。
- 多 worker 并发更新下的 fencing 语义尚未进行统一运行验证。

下一篇将研究状态持久化与恢复：哪些状态必须落盘，哪些只能重新观察，快照和事件如何共同重建 Agent。

## 参考源码

[^codex-session]: [Codex Session and fork persistence](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/session.rs#L620-L735)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^pi-input]: [Pi steer, follow-up and abort](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L282-L337)
[^kimi-prompt]: [Kimi prompt queue and steer](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L299-L459)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^pi-loop]: [Pi agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
