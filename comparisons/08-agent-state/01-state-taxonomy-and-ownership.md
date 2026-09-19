---
title: Coding Agent 的 Agent State：状态分类、所有权与派生关系
series: Coding Agent 的 Agent State：状态分类、所有权与派生关系
part: 1
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Agent State：状态分类、所有权与派生关系

## 结论

Agent State 不是一个可以整体序列化的对象，也不是 Session 里一串消息的别名。它是多个生命周期、多个所有者和多个一致性边界共同构成的状态系统。

一个 Coding Agent 至少同时处理五类状态：

```text
事实状态       已经发生、被接受或被观察到的事情
控制状态       Runtime 当前是否运行、等待、取消或阻塞
任务状态       计划、工作项、依赖、子 Agent 和验收
外部状态       Workspace、进程、Sandbox、远程资源和文件
派生状态       Context、UI、Trace、摘要和指标
```

此外，权限/能力、并发协调和 Provider Runtime 是贯穿这些状态的三个重要维度。

最重要的不是给每个字段分类，而是回答四个问题：

1. 谁拥有这个状态？
2. 谁可以修改它？
3. 它是否必须持久化？
4. 重启后应该恢复、重新观察，还是重新计算？

可以用下面的关系理解 Agent State：

```text
Authoritative Facts
  ├── Runtime Control State
  ├── Task / Plan State
  ├── Capability / Authority State
  └── Coordination State
             ↓
       Execution against Environment
             ↓
       External Effects / Observations
             ↓
       Derived Context / UI / Trace / Metrics
```

事实、控制状态和外部状态不能混为一谈。一个 operation 可以在 Runtime 中标记为 `completed`，但 Workspace 中的文件可能已经被用户修改；一个 Context 可以包含某段文件内容，但它只是过去某一时刻的派生观察；一个 UI 显示“运行中”，也不能证明远程进程仍然存在。

本文建立 Agent State 的统一词汇和所有权模型。后续文章将分别研究状态如何在 Session/Turn/Step 中流动、如何持久化和恢复、以及状态如何影响安全与多 Agent 协作。

## 1. State 的定义边界

本文将 Agent State 定义为：

> 对 Agent 当前任务、执行控制、可用能力、外部环境和已产生结果的可观察表示，以及能够从这些表示重新计算出的派生视图。

这个定义包含两部分：

- **权威状态**：Runtime 可以据此做出控制流和安全决策；
- **派生状态**：可以从权威状态或外部观察重新生成，主要服务于模型、UI、恢复和诊断。

### 1.1 不是所有内存变量都是 Agent State

Provider SDK 的临时 buffer、UI 的光标位置、某个函数的局部变量通常不是独立的 Agent State。如果丢失它们，系统可以从权威事实重新构造，就不需要单独持久化。

但一个临时变量如果决定了是否执行工具、是否已消费审批或是否可以恢复，就已经成为有状态语义的一部分，即使它仍然存在于内存中。

### 1.2 不在数据库中不等于不是状态

运行中的子进程、工作树未提交修改、provider 服务器端已接受的请求和用户尚未响应的审批都可能是关键状态。它们不一定由 Agent 数据库拥有，但恢复器必须考虑它们。

### 1.3 不可持久化不等于不重要

KV cache、网络连接和流式 buffer 通常不适合跨重启恢复，但它们会影响当前请求的行为。正确的处理不是假装它们不存在，而是明确它们属于 ephemeral state，丢失后需要重新计算或进入恢复路径。

## 2. 五类主状态

### 2.1 事实状态

事实状态记录系统已经接受或观察到的事件，例如：

- 用户提交了一条输入；
- 模型提出了一个 Tool Call；
- 用户批准了某个具体调用；
- 工具返回退出码 `1`；
- 文件在某个 Environment 中被修改；
- 恢复器将未知 effect 对账为已完成。

事实应尽量追加保存，并带有身份、来源、时间、Environment reference 和版本。事实状态是其它状态的基础。

Codex 保留 executed tool call metadata 和历史工具调用配对；OpenHands 用 Action/Observation 事件表达 Agent 与执行环境的交互；Kimi Code 持久化 task state 和 tool dedupe 信息。[^codex-recorder] [^codex-history-pairing] [^openhands-events] [^kimi-task] [^kimi-dedupe]

### 2.2 控制状态

控制状态描述 Runtime 当前如何推进：

```text
idle
admitting
running
waiting_model
waiting_approval
waiting_tool
waiting_environment
cancel_requested
interrupted
blocked
completed
failed
orphaned
```

控制状态可以从事实推导，但通常需要作为当前快照维护，方便调度器快速判断。它不是事实本身：`running` 表示 Runtime 认为 operation 正在运行，不等于外部进程一定仍然存在。

Codex 将 Turn 输入、审批等待和执行状态放在 Turn/Step 相关结构中；OpenCode 使用 execution claim 处理谁拥有当前执行；Pi harness 则以 lane、operation 和 restore/recovery 组织长期运行状态。[^codex-turn-state] [^opencode-execution] [^pi-harness]

### 2.3 任务状态

任务状态描述 Agent 想要完成什么、已经完成什么、还缺什么：

- 用户目标；
- plan revision；
- work item；
- 依赖和阻塞原因；
- 子 Agent 运行；
- acceptance condition；
- 验收证据；
- 任务完成或失败 verdict。

任务状态通常跨越多个 Step，可能跨越多个 Turn，不能只存在于当前模型 prompt。它也不等同于工具轨迹：工具轨迹记录发生了什么，任务状态解释这些动作对目标意味着什么。

Kimi Code 的 task persistence、StepRequest 和 subagent context 提供了请求与任务之间的显式边界；Codex 的多 Agent wait/steer 路径则展示了父任务对子运行的控制关系。[^kimi-task] [^kimi-request] [^kimi-subagent] [^codex-wait]

### 2.4 外部状态

外部状态存在于 Agent Runtime 之外：

- 工作树和 Git index；
- 本地进程和后台服务；
- 容器、Sandbox 和远程 workspace；
- 数据库、云资源和部署系统；
- 用户在 Agent 暂停期间做出的修改。

Runtime 可以保存对外部状态的观察，但不能假设自己拥有外部状态的全部真相。恢复时必须重新观察或使用 Environment 提供的查询/版本协议。

OpenHands 将 agent-server、workspace、sandbox 和 session context 分离；Gemini CLI Session 则把 cwd 和动态 instructions 作为请求上下文的一部分；mini-SWE-agent 的 Environment 负责执行 action 并返回 observation。[^openhands-adapter] [^gemini-session] [^mini-environment]

### 2.5 派生状态

派生状态由权威事实、当前控制状态和外部观察生成：

- 给模型的 Context；
- 给用户的 UI 状态；
- 压缩摘要；
- plan view；
- trace、metrics 和成本报表；
- provider-specific request message。

派生状态可以失效、压缩和重建。它应保留来源和版本，但不应成为唯一事实来源。

Codex 的 history manager 区分内部历史和 prompt projection；OpenCode 使用 `to-llm-message` 将 Session message 转换为 LLM message；Pi 的 context snapshot 是一次模型请求的局部视图。[^codex-history] [^opencode-context] [^pi-agent]

## 3. 三个贯穿维度

### 3.1 Capability / Authority

能力状态决定 Agent 当前可以做什么：

```text
registered tool
  ∩ model/provider capability
  ∩ user approval
  ∩ policy
  ∩ Environment availability
```

能力不是普通配置。它会影响模型 Context、工具执行和恢复安全。一个 Session 可能仍然存在，但用户撤销网络权限后，当前 capability state 已改变。

Codex 的 StepContext、权限 profile 和 network approval；Gemini CLI 的 policy engine；Kimi Code 的 tool policy 和 permission gate 都说明能力需要在执行边界重新评估。[^codex-step] [^codex-permissions] [^gemini-policy] [^kimi-policy] [^kimi-permission]

### 3.2 Coordination

协调状态回答谁负责推进某项工作：

- owner；
- worker；
- claim；
- lease；
- fencing token；
- parent/child relation；
- request attempt。

它在单进程里可能很轻，但在后台任务、多 Agent、远程 sandbox 和恢复场景中是核心状态。没有协调状态，两个 worker 都可能认为自己可以继续同一 Tool Call。

OpenCode 的 execution claim、Pi 的 durable operation、Codex 的任务等待/接管和 Kimi 的 task persistence 都把协调责任从普通消息中分离出来。[^opencode-execution] [^pi-harness] [^codex-wait] [^kimi-task]

### 3.3 Provider Runtime

模型请求自己的状态包括：

- model/provider identity；
- request/attempt identity；
- stream progress；
- finish reason；
- usage；
- cancellation；
- retry/fallback；
- context and tool schema version。

它通常属于 Step 或 request 层，而不是 Session 的永久事实。但如果 provider 已经接受请求、响应丢失或产生 tool call，它就会影响事实状态和恢复决策。

## 4. 状态所有权矩阵

| 状态 | 权威所有者 | 典型消费者 | 重启处理 |
| --- | --- | --- | --- |
| 用户输入 | Session / history store | Turn、Context、UI | 恢复 |
| 当前 Turn 控制状态 | Turn runtime | Scheduler、UI、恢复器 | 从事件重建 |
| Step 请求条件 | Step runtime | Model runtime、Tool runtime | 重新定型或恢复 |
| Tool call 事实 | Execution runtime | Context、审计、恢复器 | 去重/对账 |
| Approval | Policy / authority layer | Tool runtime、UI | 校验 scope 和过期 |
| Plan item | Task runtime | Scheduler、模型、UI | 恢复 revision |
| Workspace 状态 | Environment | Tool、验收、恢复器 | 重新观察 |
| Stream buffer | Provider runtime | Parser、UI | 丢弃或进入 partial recovery |
| Context | Context builder | Model provider | 重新生成 |
| UI 状态 | UI projection | 用户 | 重新投影 |
| Trace / metrics | Observability | 诊断、评估 | 可选恢复 |

这个矩阵说明“状态属于谁”比“状态存在哪个文件”更重要。一个数据库表可以保存多个 owner 的投影，但不能因此让 UI 获得修改执行事实的权力。

## 5. 状态变化的四种操作

### 5.1 Accept

Runtime 接受外部输入或模型提案，使其进入自己的状态机。例如接受用户输入、接受 Tool Call、接受 child result。

### 5.2 Transition

状态根据事件进入下一个控制状态，例如 `waiting_approval -> authorized` 或 `running -> completed`。

### 5.3 Observe

Runtime 从 Environment、Provider 或用户得到新的观察。观察可以使已有状态失效，但不会自动改变所有任务结论。

### 5.4 Project

从权威状态生成模型 Context、UI、摘要或 metrics。Project 不应产生新的外部副作用，除非明确进入另一个执行边界。

这四种操作经常被实现混在同一个函数中，导致“显示一条消息”同时改变历史、计划、工具状态和 UI。分开它们可以更容易验证状态所有权。

## 6. 状态一致性不只有一种

### 6.1 事实一致性

事件、工具结果和审批记录没有互相矛盾。

### 6.2 控制一致性

Runtime 的当前状态与未完成 operation、worker owner 和队列状态一致。

### 6.3 环境一致性

当前 Workspace/进程/远程资源与 Runtime 保存的 Environment reference 和观察一致。

### 6.4 语义一致性

模型 Context、UI 和计划视图都表达同一个事实状态，虽然表示形式可以不同。

### 6.5 权限一致性

实际可执行能力不超过当前 policy、approval、Environment 和用户授权。

一个 Agent 可以在事实一致但环境不一致的情况下运行：日志记录了文件写入成功，但用户随后修改了文件。也可以在 Context 一致但权限不一致的情况下运行：模型看到工具 schema，但用户已经撤销授权。

## 7. 状态快照与事件日志

事件日志适合保存变化和因果关系，快照适合快速恢复当前控制状态。两者不是互斥的：

```text
event log: e1 -> e2 -> e3 -> e4 -> e5
                         ↓ snapshot S1
event log: e6 -> e7 -> e8
```

恢复器可以从 `S1 + e6..e8` 重建状态，但必须知道 snapshot 对应的事件边界和 schema 版本。快照不是“把所有对象 dump 到 JSON”，而是 Runtime 对可恢复状态的声明。

Pi 的 JSONL storage 与 restore 逻辑体现了 transaction/frame 和恢复状态的分离；Codex 的 history version 和 compaction 则说明模型历史快照不能替代全部执行事实。[^pi-jsonl] [^pi-restore] [^codex-history]

## 8. 状态与 Context 的派生关系

Context 不应被视为 Agent State 的全集：

```text
Facts + Live State + Environment Observations
                    ↓ selection / projection
                 Model Context
```

Context 可能省略：

- 已完成的旧计划 revision；
- 完整审批历史；
- worker lease；
- 原始流式事件；
- 大型工具输出。

但省略不能改变 Runtime 的事实。Context 压缩后，恢复器仍应能重新读取原始状态；模型切换后，新 Context 仍应保留未完成动作和权限边界。

## 9. 状态与 Environment 的派生关系

Environment observation 是带版本和时间的外部事实：

```text
Observation(path, workspace_id, revision, collected_at)
```

它不是 Runtime 可以永久拥有的当前状态。文件被修改、进程退出或远程 sandbox 被销毁后，旧 observation 仍是历史，但不能作为当前执行条件。

OpenHands 的 workspace/sandbox payload、Gemini CLI 的 cwd/context 和 mini-SWE-agent 的 Environment protocol 都体现了执行环境需要作为独立上下文传递。[^openhands-adapter] [^gemini-types] [^mini-environment]

## 10. 状态与计划的派生关系

计划状态是对事实和目标的解释：

```text
事实：pytest 返回 1
计划解释：验证项失败
下一步：修复实现或检查测试假设
```

事实不会自动告诉 Runtime 计划该如何变化；计划层需要 acceptance、依赖和策略。但计划也不能凭空覆盖事实。

因此，计划 revision 应引用触发它的事实事件；任务完成应引用验收证据；模型 Context 只需要当前 plan view，而不是取代 plan state。

## 11. 状态与 UI 的关系

UI 是最容易被误认为权威状态的地方。进度条、工具卡片、审批弹窗和“完成”标签都是 projection：

```text
Runtime state -> UI event/projection -> visible state
```

UI 可以发出控制意图，例如 cancel、approve、steer，但不能直接把 operation 改成 completed。用户点击 approve 也需要经过 authority layer，生成带 scope 的 Approval fact。

断线重连后，UI 应从事件或当前快照重建，而不是依赖客户端内存中的状态。否则用户刷新页面可能看到任务已完成，Runtime 却仍在等待审批。

## 12. 状态生命周期与不可变边界

不同状态的可变性不同：

| 状态 | 创建后是否可变 | 推荐处理 |
| --- | --- | --- |
| 原始用户输入 | 不可变 | 追加新输入，不修改旧输入 |
| Tool Call 提案 | 不可变事实 | 新增接受/拒绝事件 |
| 当前控制快照 | 可变 | 从事件重建或版本化更新 |
| Plan revision | revision 不变，计划可新增版本 | 保留旧版本和变更原因 |
| Approval | 决策不可变，状态可结束 | 记录消费/过期/撤销 |
| Environment observation | 观察不可变 | 新观察替代当前视图 |
| Context | 可重新生成 | 记录 builder/model 版本 |
| UI projection | 可重建 | 不作为事实来源 |
| Stream buffer | 短期可变 | 完成/中断后提交或丢弃 |

“不可变”通常适合描述已经提交的事实；“当前状态”可以变化，但每次变化最好有事件或版本。把一个对象原地修改到最终状态，会让恢复器无法知道中间发生了什么。

## 13. 状态与 Agent 演进

从轻量 Agent 到产品化 Harness，通常发生这样的状态迁移：

```text
messages / trajectory
        ↓
Session + Turn + Step
        ↓
Tool / approval / Environment state
        ↓
Plan / child run / coordination state
        ↓
checkpoint / recovery / acceptance state
```

mini-SWE-agent 保留较小的 trajectory 和 Environment 接口；Pi 从 Agent loop 发展出 durable harness；Codex 将 Turn/Step、工具、权限、Environment 和多 Agent 控制结合；OpenCode、OpenHands、Kimi Code 则分别强化 execution claim、远程环境、请求/task/subagent 状态。[^mini-default] [^pi-harness] [^codex-step] [^opencode-execution] [^kimi-request]

这不是单纯的代码量增加，而是更多原本隐含在模型上下文和进程内存中的责任被迁移到可观察、可恢复的状态层。

## 14. 设计原则

### 原则一：先定义所有权，再定义存储

同一个字段由谁解释和修改，比它放在数据库、JSONL 还是内存更重要。

### 原则二：事实、控制和派生分离

事实记录发生了什么，控制状态决定接下来做什么，派生视图决定模型和用户看到什么。

### 原则三：外部状态永远需要重新观察

Runtime 保存的是观察和引用，不是对文件、进程和远程资源的永久占有。

### 原则四：权限是状态的一部分

Capability、审批和 policy 变化会改变 Agent 能做什么，不能只作为静态配置处理。

### 原则五：重启后按状态类型处理

事实恢复，控制状态重建，Environment 重新观察，Context 重新生成，stream buffer 通常丢弃或进入恢复流程。

### 原则六：状态迁移要有证据

计划完成、工具成功、审批通过和恢复接管都应关联触发事件和责任主体。

### 原则七：派生视图可以变化，权威事实不能静默变化

模型切换、UI 改版和摘要算法升级可以改变 projection，但不能覆盖原始执行事实。

## 15. 验证方案

### 15.1 状态分类实验

对每个状态注入进程崩溃，观察重启后的处理：

```text
user input accepted
tool call accepted
approval granted
tool effect completed
control state running
plan item completed
Environment observation collected
Context assembled
stream partially received
```

验证每类状态是恢复、重建、重新观察还是丢弃。

### 15.2 所有权实验

让 UI、模型、子 Agent 和恢复 worker 尝试修改同一状态，验证只有合法 owner 能够完成 transition，其他输入被转换为 request 或 proposal。

### 15.3 派生一致性实验

从同一事实日志重新生成 Context、UI 和 plan view，检查三者是否表达相同的 active work、权限和 Environment 状态。

### 15.4 状态冲突实验

让用户在 Agent 暂停时修改工作树，让旧 worker 在新 worker 接管后返回结果，检查 Runtime 是否能识别 stale observation、fencing violation 和 unknown effect。

本文没有对所有项目统一执行这些实验。源码和测试可以证明状态结构和部分 transition；实际重启、网络断开、远程 Environment 和 UI 重连行为仍需项目级实验。

## 未确认事项

- 各项目是否有明确的权威 state store，还是由多个内存/持久化结构共同构成，需要逐项目确认。
- 控制状态是否完全可从事件重建，还是包含无法恢复的外部进程信息，不能只看类型定义。
- 子 Agent 的计划、权限和 Environment 状态是否由父 Session 拥有，需要结合部署和服务边界确认。
- Provider 服务器端请求、KV cache 和远程副作用不一定能被 Agent Runtime 观察。

## 参考源码

[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-history-pairing]: [Codex history tool-call pairing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L690-L725)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^codex-turn-state]: [Codex Turn state](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/state/turn.rs#L88-L124)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
