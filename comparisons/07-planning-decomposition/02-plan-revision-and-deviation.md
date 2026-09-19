---
title: Coding Agent 的计划修正与执行偏差
series: Coding Agent 的 Planning 与 Task Decomposition
part: 2
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的计划修正与执行偏差

## 结论

Coding Agent 的初始计划几乎一定会被执行过程中的新信息改变。真正成熟的 Runtime，不是强迫执行者遵守一份已经过时的计划，而是能够判断：哪些计划项仍然有效，哪些需要局部修改，哪些必须整体重规划，哪些变化需要用户确认。

计划修正的核心不是“再让模型生成一份计划”，而是把**新观察与旧计划之间的关系**记录下来：

```text
原计划 revision
      ↓
新的工具结果 / Environment observation / 用户输入
      ↓
偏差分类
      ├── 无影响：继续原计划
      ├── 局部影响：修改一个或几个 work item
      ├── 依赖失效：重新计算后续分支
      ├── 目标改变：建立新计划或新 Turn
      └── 风险升级：暂停并请求用户决策
```

如果只覆盖旧计划文本，系统会失去为什么改变路径的证据；如果每次偏差都重建整个 Session，用户又无法区分已经完成的工作和新的工作。可靠的做法是保存 revision、触发事件、受影响的工作项和新的执行边界。

## 1. 偏差的来源

### 1.1 代码结构偏差

模型预期某个函数位于 `src/client.ts`，实际代码已经迁移到生成目录或不同模块。计划中的文件路径和依赖关系失效，但用户目标可能仍然不变。

### 1.2 工具结果偏差

测试失败、类型检查报错、Git 冲突、命令退出码非零或搜索结果为空，都会改变对任务的理解。

### 1.3 Environment 偏差

用户修改文件、后台进程生成内容、分支切换、依赖版本变化或远程 sandbox 重建，都可能使旧计划的前提不再成立。

### 1.4 权限和策略偏差

需要网络、写入受保护目录或访问新工具时，原计划可能需要审批。计划目标不变，但执行路径和能力边界发生变化。

### 1.5 用户意图偏差

用户在执行中插入新要求、修改范围或撤销某项工作。此时不是技术偏差，而是目标 revision，可能需要建立新的 Turn 或重新排序当前工作。

### 1.6 模型能力偏差

当前模型无法可靠生成某种工具参数、Context 不足或 provider 失败，可能需要切换模型，但不能因此把原计划的完成状态自动改变。

## 2. 计划偏差的分类

可以用“目标、前提、路径、证据、风险”五个维度判断偏差：

| 类型 | 目标 | 前提 | 路径 | 典型动作 |
| --- | --- | --- | --- | --- |
| 路径变化 | 不变 | 不变 | 变 | 局部修改 |
| 前提失效 | 不变 | 变 | 需要重算 | 重新规划受影响分支 |
| 证据不足 | 不变 | 未知 | 未知 | 增加探索步骤 |
| 目标变化 | 变 | 可能变 | 变 | 新计划或新 Turn |
| 风险升级 | 不变 | 高风险 | 受限 | 暂停/请求确认 |
| Environment 变化 | 不变 | 当前状态变 | 需重新观察 | 刷新环境后决定 |

这样可以避免所有失败都触发“从头开始”，也避免所有变化都被模型自然语言解释掩盖。

## 3. Plan Revision 的最小记录

一个计划修正事件至少需要：

```text
revision_id
previous_plan_revision
trigger_event_id
trigger_type
affected_work_items
preserved_work_items
superseded_work_items
new_dependencies
new_acceptance_conditions
decision_owner
environment_reference
```

`trigger_event_id` 是关键。它把“为什么修正”绑定到真实观察，例如测试失败、文件不存在、用户输入或审批拒绝，而不是只记录“模型决定换方案”。

### 3.1 局部修正

适用于目标和主要前提仍然成立的情况：

```text
原计划：修改 A -> 运行测试 -> 修改 B
观察：A 的测试入口不存在
修正：增加“定位测试入口”，保留 B 和最终验收
```

局部修正应尽量保持已经完成工作的身份和证据，避免恢复时重复修改文件。

### 3.2 分支重规划

适用于一个前提影响多个后续工作项：

```text
原计划：升级依赖 -> 运行全部测试 -> 修复失败
观察：依赖版本与项目约束冲突
修正：建立候选版本分支，分别验证兼容性
```

旧路径不应直接标记为 failed，因为它可能只是被新证据 superseded。

### 3.3 目标重规划

用户说“不要改实现，只给我分析原因”，这是目标变化。Runtime 应停止或取消不再适用的 active work，而不是把原计划继续执行到结束再补充一条说明。

## 4. 计划修正与 Session / Turn / Step

计划 revision 的归属需要与已有状态边界一致：

```text
Session:  保留长期任务事实和计划历史
Turn:     表达一次用户目标或目标修正
Step:     执行当前计划项的一次模型—Runtime 交互
Plan:     可以跨多个 Step，通常可跨同一 Turn
```

如果用户只是补充当前任务的约束，可能在同一 Turn 中形成新的 plan revision；如果用户改变了目标，通常应创建新 Turn 并引用旧任务。

模型在当前 Step 中发现新事实，只能提出 revision，不能直接把 Session 或 Turn 的事实覆盖。Runtime 需要在 Step 边界或明确的 plan admission 边界接受变更。

Codex 的 Turn/Step 输入和 pending input 处理体现了用户输入与执行请求之间的边界；Pi 的 steer/follow-up 机制也区分当前工具推进和下一次模型请求。[^codex-input] [^pi-input]

## 5. 新观察如何进入计划

不是所有 observation 都足以改变计划。可以按证据强度分层：

1. **直接事实**：文件不存在、命令返回码、测试失败、用户明确输入；
2. **结构化解释**：测试失败属于类型错误，某个模块是生成代码；
3. **模型假设**：可能需要升级依赖，可能存在竞态；
4. **未来计划**：下一步尝试某种修复。

只有直接事实和经过 Runtime/工具验证的结构化解释可以自动改变计划状态。模型假设可以作为候选 revision，但不应直接关闭已有工作项或声明完成。

OpenHands 的 Action/Observation 事件、mini-SWE-agent 的 action/observation trajectory 和 Codex 的工具结果都提供了“执行结果回到下一次决策”的证据；但这些结果是否自动更新独立计划，还需要区分项目的产品层实现。[^openhands-events] [^mini-default] [^codex-history]

## 6. 失败不一定导致重规划

工具失败至少有四种含义：

```text
transient failure      网络暂时不可用，可重试
action failure         当前动作失败，但计划仍有效
assumption failure     原计划前提错误，需要修正
goal failure           目标不可达或目标已改变
```

例如 `pytest` 返回失败可能只是实现有 bug，计划仍然是“修复实现并通过测试”；搜索命令没有结果可能说明路径假设错误，需要重新探索；权限被拒绝可能需要用户确认，而不是重写目标。

Runtime 应先将 failure 分类，再决定 plan transition。否则模型会在每个命令失败后生成一份越来越长、越来越不一致的新计划。

## 7. Plan Drift：计划逐渐脱离事实

Plan drift 是指计划状态继续存在，但已经不能准确代表 Environment 和执行轨迹。常见原因：

- 工具成功后没有更新计划；
- 用户修改文件后仍使用旧完成证据；
- 计划项依赖发生变化但没有重算；
- 模型在 Context 中自行维护另一份 TODO；
- compaction 丢失了 plan revision；
- 恢复后从旧 checkpoint 继续执行新 Environment。

可以用三个指标识别 drift：

```text
plan status freshness
evidence environment version
active item / actual tool trajectory alignment
```

计划状态应尽可能关联最近验证它的 event 和 Environment version。旧完成状态可以保留，但不能无条件作为当前事实。

## 8. 局部修正与整体重规划的决策

可以使用一个保守判断：

```text
affected dependency set small
∧ user goal unchanged
∧ acceptance conditions unchanged
∧ no new security boundary
    -> local revision

otherwise
    -> branch/global replanning or user decision
```

适合局部修正：文件路径错、单个测试失败、某个工具参数不兼容、需要增加一个探索步骤。

适合整体重规划：用户目标改变、核心架构假设错误、Environment 被重建、权限边界改变、多个并发分支互相冲突。

适合暂停并询问用户：删除/发布/迁移等不可逆动作、旧计划已产生未知副作用、候选路径影响范围明显扩大。

## 9. 计划修正与审批

计划 revision 可能使原审批失效。原来计划只需要读取文件，修正后可能需要写入或联网；原来用户批准修改一个文件，新的分支可能触及多个目录。

审批系统需要绑定计划项或 tool call 的实际 scope，而不是绑定一个模糊的 plan_id。一个新的 plan revision 应重新计算：

- 工具集合；
- Environment scope；
- 文件和网络影响范围；
- approval scope；
- 是否需要用户重新确认。

Codex 的 permission/approval 绑定调用身份；Gemini CLI 的 policy engine 在执行前评估工具能力；Kimi Code 的 permission gate 和 task state 位于请求进入执行层的边界。[^codex-approval] [^gemini-policy] [^kimi-permission]

## 10. 计划修正与并发

并行计划会产生 revision race：两个 worker 根据不同 observation 修改同一个计划。

```text
revision 5
  ├── worker A: 完成接口修改，计划增加测试项
  └── worker B: 发现接口不存在，计划替换实现路径
```

Runtime 需要选择：

- 使用 revision number 拒绝旧更新；
- 合并不冲突的 plan delta；
- 让一个 owner 重新计算完整计划；
- 将冲突暴露给用户。

OpenCode 的 execution claim、Pi 的 lane/operation、Codex 的任务和子 Agent 控制都说明“谁负责推进”是计划一致性的前提。[^opencode-execution] [^pi-harness] [^codex-wait]

没有 owner 或 revision fencing 时，计划状态可能显示两个 work item 同时完成，实际 Environment 却包含相互覆盖的修改。

## 11. 计划修正与 Model Switch

模型切换常常与计划修正同时发生，但二者不应混淆：

- 新 observation 改变了任务路径，是 plan revision；
- Provider 失败导致模型替换，是 model recovery；
- 用户增加目标，是 intent revision；
- Tool permission 改变，是 capability revision。

新模型可以参与修正，但它收到的应是已确认的旧计划、触发证据和当前 Environment 状态，而不是直接继承旧模型的隐藏推理。

## 12. 各 Agent 的计划修正路径

### 12.1 Codex：通过 Turn/Step 和工具结果隐式修正

Codex 的核心执行路径并不强制一份外显任务 DAG。模型可以根据工具结果继续下一 Step，用户输入可以 steer 当前 Turn 或进入后续处理，history/Context 则保留可供下一次请求使用的事实。[^codex-turn] [^codex-input]

这种设计适合动态探索，但计划 revision 多数存在于消息、工具结果和 Turn 状态中。要形成用户可见的稳定计划，需要在产品层增加 projection。

### 12.2 Pi：steer 与 loop revision

Pi 的 steer、follow-up、abort 和 tool batch boundary 提供了改变下一次模型决策的入口；durable harness 的 frames 和 operations 可以记录长期任务的状态变化。[^pi-input] [^pi-harness]

它将计划修正的自由度交给应用和模型，底层 Runtime 负责把输入放到正确的 loop 边界。优点是轻量，代价是显式计划 revision 协议不由底层 Agent 自动提供。

### 12.3 OpenCode：Session 与执行状态共同承载偏差

OpenCode 通过 Session message、compaction、execution claim 和 workspace operation 表达任务推进。新的 observation 可以影响下一次 LLM message projection 和 execution 状态，但独立任务图仍需要更上层的定义。[^opencode-context] [^opencode-execution]

### 12.4 OpenHands：事件驱动的路径更新

OpenHands 的 Action/Observation 轨迹天然支持“执行—观察—重新决策”。远程 workspace 和 sandbox 的变化也可能迫使 Agent 重建计划前提。[^openhands-events] [^openhands-adapter]

### 12.5 Kimi Code：请求队列与任务状态修正

Kimi Code 的 Prompt/Step request、task persistence、取消和 tool dedupe 让计划中的工作可以以请求级状态推进。新的 observation 或用户输入可以影响 pending request，但修正后的请求需要新的身份和重新的请求定型。[^kimi-request] [^kimi-task] [^kimi-materialize]

### 12.6 Gemini CLI：动态 instructions 与模型驱动修正

Gemini CLI 通过 Session transcript、动态 instructions 和工具结果让模型持续更新下一步。它适合动态计划，但如果不额外保存结构化 revision，计划历史主要存在于对话和上下文投影中。[^gemini-session]

### 12.7 mini-SWE-agent：轨迹即修正输入

mini-SWE-agent 的默认 loop 把 observation 直接放回 trajectory，由模型决定下一 action。它没有独立 revision store，因此计划修正主要体现为下一次 action。[^mini-default]

## 13. 设计原则

### 原则一：计划偏差需要分类

不要把所有工具失败都映射为全局重规划，也不要把所有偏差都隐藏在 assistant 文本中。

### 原则二：以观察触发修正

计划 revision 应引用测试结果、文件状态、用户输入、审批或 Environment 变化，而不是只有模型解释。

### 原则三：已完成工作不能被重规划抹掉

完成证据属于事实历史；新计划可以 supersede 后续路径，但不应删除已经发生的副作用。

### 原则四：修正范围应尽可能局部

局部 revision 降低上下文成本和重复动作；只有影响范围不可分离时才进行整体重规划。

### 原则五：目标变化与路径变化分开

用户改变目标通常需要新的 Turn 或新计划；代码结构变化通常只需要局部 revision。

### 原则六：计划状态和 Environment 版本关联

没有新观察的旧 completed 状态不能无限期当作当前事实。

### 原则七：并行 revision 必须有 owner 和版本控制

计划不是任意 worker 都可以覆盖的共享 JSON；更新需要 revision check、claim 或合并策略。

## 14. 验证方案

### 14.1 观测驱动的确定性实验

构造一个固定任务：

```text
查找入口 -> 修改实现 -> 运行测试 -> 修复失败 -> 验证
```

让 Environment 在不同位置注入事实：

- 入口文件不存在；
- 测试命令返回类型错误；
- 用户在中途修改目标文件；
- 修改后出现新的依赖文件；
- 写入权限被拒绝。

观察 Runtime 是否生成局部 revision、整体重规划、等待审批或错误地继续旧路径。

### 14.2 一致性断言

```text
revision has a trigger event
completed evidence is not erased
new plan does not repeat committed effect blindly
goal change does not silently remain in old plan
old approval does not cover expanded scope
parallel revision cannot overwrite newer revision
recovery can identify active work after restart
```

### 14.3 证据边界

源码可以证明项目有 queue、task、Action/Observation、Turn 或 operation；不能仅凭这些结构证明模型计划会被完整解析为独立任务图。需要 UI/API 调用路径和运行时实验确认计划是否真正驱动控制流。

## 未确认事项

- 各项目的结构化计划是否作为持久事实保存，仍需结合前端、Session store 和恢复代码确认。
- 模型自然语言 TODO 与 Runtime execution state 的映射在多数项目中并非稳定公开契约。
- 并行子 Agent 的计划 revision 是否共享 parent plan，不能仅由工具调用关系推断。
- 计划修正后的 UI、Context、审计和恢复投影是否使用同一 revision，需要进一步验证。

下一篇将研究并行任务分解与子 Agent 委派：任务如何划分给多个执行者，如何避免共享 Environment 冲突，以及父 Agent 如何验证子任务结果。

## 参考源码

[^codex-input]: [Codex steer input and turn input](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input.rs#L510-L619)
[^pi-input]: [Pi steer, follow-up and abort](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L282-L337)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
