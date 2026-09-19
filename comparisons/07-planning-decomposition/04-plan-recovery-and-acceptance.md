---
title: Coding Agent 的计划恢复与任务验收
series: Coding Agent 的 Planning 与 Task Decomposition
part: 4
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的计划恢复与任务验收

## 结论

复杂 Coding Agent 任务的“完成”，不能由最后一条 assistant 消息决定，也不能由所有子 Agent 返回 `completed` 决定。任务验收必须把四类证据合并起来：

```text
Plan state
  + Tool / child trajectory
  + Environment observation
  + Acceptance checks
        ↓
  Runtime verdict
        ↓
completed / failed / blocked / needs_user_decision
```

计划恢复则是这个过程的逆向问题：系统重启或运行者更换后，从持久化计划、未完成 operation、工具事实和当前 Environment 重新构造 active work，并决定继续、重试、对账、重规划还是暂停。

这两个问题本质上是同一个问题的两面：

- 验收判断过去的工作是否已经满足目标；
- 恢复判断未来的工作从哪里安全继续。

如果没有独立的验收和恢复边界，Agent 很容易出现两种错误：

1. 模型说“完成了”，但测试、文件或 Environment 并不支持；
2. 系统重启后忘记已完成的副作用，再次执行同一修改。

## 1. 完成不是一个布尔值

“完成”至少有五种含义：

| 状态 | 含义 |
| --- | --- |
| `plan_completed` | 计划项已满足声明的工作目标 |
| `effect_committed` | 外部副作用已确认提交 |
| `checks_passed` | 验收检查通过 |
| `user_accepted` | 用户确认结果符合预期 |
| `turn_finished` | 当前 Turn 没有继续执行工作 |

这些状态不一定同时发生。例如：

- 代码修改已经提交，但测试失败；
- 测试通过，但用户要求继续优化；
- 子 Agent 完成分析，父 Agent 尚未接受结果；
- Turn 结束，但后台构建仍在运行；
- 文件已经改变，但远程部署结果未知。

Runtime 应避免将它们压缩为一个 `done: true`。

## 2. 验收条件的类型

### 2.1 结构验收

检查文件、符号、配置或目录是否存在，适合验证最基本的产物。

### 2.2 行为验收

运行测试、类型检查、lint、构建或静态分析，验证代码行为。

### 2.3 差异验收

检查 Git diff、修改范围、是否包含不应变化的文件，以及是否保留用户现有修改。

### 2.4 环境验收

检查服务是否启动、远程资源是否存在、进程是否健康、依赖是否安装。

### 2.5 用户验收

需要用户确认设计、迁移、发布、删除或其他主观目标是否满足。

复杂任务通常需要多个验收条件，且条件之间存在依赖：构建通过不等于部署成功，文件存在不等于功能可用。

## 3. 验收证据的可信度

不是所有证据都同样可靠：

```text
模型声称完成
    < assistant summary
工具返回成功
    < 可重复的检查结果
Environment 当前观察
    < 关联版本和资源身份的验收
用户明确确认
    < 取决于目标定义和授权范围
```

这不是简单的固定等级。一次 `exit 0` 的命令也可能没有覆盖真正目标；一次用户确认也可能只确认了展示效果而不是部署状态。

验收记录需要说明检查条件、命令、Environment、版本、结果和时间，而不是只保存“passed”。

## 4. Plan Recovery 的输入

恢复器至少需要读取：

```text
latest plan revision
work item states
completed acceptance evidence
unresolved child runs
pending tool calls
approval state
Environment reference and current observation
model/context recovery metadata
```

缺少任何一类都可能导致错误继续：

- 没有 plan revision：不知道当前 active branch；
- 没有 effect state：可能重复副作用；
- 没有 child state：父任务可能错误地等待或重复委派；
- 没有 Environment reference：旧检查结果可能已过期；
- 没有 approval state：恢复后可能越权执行；
- 没有 acceptance evidence：只能相信模型叙述。

Codex 的 Turn/Step、工具记录和 history 管理，Pi 的 JSONL frames 与 durable restore，OpenCode 的 execution claim，以及 Kimi Code 的 task persistence 都提供了不同层面的恢复输入。[^codex-step] [^codex-history] [^pi-jsonl] [^pi-restore] [^opencode-execution] [^kimi-task]

## 5. 恢复后的第一步不是调用模型

安全的计划恢复通常先执行 Runtime 检查：

```text
1. 读取最新计划 revision
2. 检查是否存在有效 owner
3. 验证 Environment identity
4. 扫描 active / blocked / orphaned work item
5. 重新观察关键文件、Git、进程和远程资源
6. 对账未完成工具和子 Agent effect
7. 验证 approval 是否仍有效
8. 生成 recovery plan view
9. 只有必要时才调用模型
```

模型应该在恢复后的事实状态上做下一步决策，而不是负责判断旧操作是否已经发生。否则每次恢复都可能重新规划并重复旧动作。

## 6. 恢复状态分类

计划项恢复时可以使用：

```text
completed        验收证据仍然有效
stale_completed  曾经通过，但 Environment 已变化
active           有 owner，仍在执行
orphaned         原 owner 消失，状态未收敛
retryable        未产生副作用，可以重新执行
reconcilable     可能产生副作用，需要先对账
blocked          等待依赖、Environment 或用户
superseded       被新 revision 替代
needs_decision   Runtime 无法安全推断
```

`stale_completed` 特别重要：测试曾经通过，但用户后来修改了相关文件；旧 evidence 仍然是历史事实，却不能作为当前任务的完成证明。

## 7. 计划恢复与 Tool Trajectory

工具轨迹提供执行证据，但需要重新解释：

```text
ToolCallAccepted
ExecutionStarted
ObservationReady
ExecutionFinished
AcceptanceCheckPassed
```

只有最后两个或工具特定的 effect confirmation 才可能支持 completed。一个 trajectory 中出现 `apply_patch` action，不等于 patch 已经应用；出现 `pytest` observation，不等于测试结果仍然适用于当前工作树。

OpenHands 的 Action/Observation 事件、mini-SWE-agent 的 trajectory、Codex 的 executed tool call metadata 都说明动作和观察应保持关联，但计划恢复还需要额外的 acceptance 和 Environment 版本。[^openhands-events] [^mini-default] [^codex-recorder]

## 8. 子 Agent 结果的恢复与验收

父 Agent 恢复时，对每个 child run 应检查：

- child 是否有明确终态；
- result artifact 是否仍然存在；
- artifact 所属 Environment 是否仍可访问；
- 父任务是否已经接受结果；
- 子任务的副作用是否已合并；
- child 的 approval 和 lease 是否已结束；
- 结果是否与当前 plan revision 兼容。

子 Agent `completed` 但父 Agent 没有 `accepted` 时，父计划不能直接完成。子 Agent `failed` 但没有副作用时，可以重新委派；子 Agent `unknown` 则应先对账。

Codex 的 `wait_agent` 处理等待和输入活动；Kimi Code 的 subagent context、task state 和 mirror run 记录父子关系；这些结构支持恢复器逐个处理 child，而不是只读取父计划的一行状态。[^codex-wait] [^kimi-subagent] [^kimi-task]

## 9. Environment 变化与验收失效

验收证据必须带 Environment reference：

```text
evidence = {
  check: "pytest tests/auth",
  result: "passed",
  workspace: "ws-17",
  revision: "git-sha-or-snapshot",
  collected_at: "..."
}
```

如果用户随后修改了 `auth/`，旧 evidence 不能直接作为当前完成证据。Runtime 可以：

- 重新运行检查；
- 只重新检查受影响的验收条件；
- 将计划项标记为 stale_completed；
- 请求用户确认不再验证。

Environment 的 freshness 可以按资源范围计算，而不是每次任务都全量重跑。关键是系统不能把 cwd 相同误认为 Environment 相同。

## 10. 计划恢复与模型 Context

恢复后的模型 Context 应包含一个结构化 plan view：

```text
Goal: 修复认证测试失败
Current work: 验证新 token parser
Completed evidence: parser 修改已写入，旧测试通过
Stale evidence: 集成测试来自旧 workspace revision
Blocked: 远程服务未启动
Allowed next actions: 只读检查、启动服务需审批
```

它不需要包含所有旧计划 revision，也不需要把恢复器内部的 lease 和 fencing 细节暴露给模型。Context Builder 负责选择当前可决策的信息，事实日志负责保留完整历史。

Codex 的 history manager、OpenCode 的 LLM message projection、Pi 的 recovery 和 Kimi 的 request materialization 都可以作为这种 plan view 的投影边界。[^codex-history] [^opencode-context] [^pi-recovery] [^kimi-materialize]

## 11. 何时宣布任务完成

可以采用分层终态：

```text
work item completed
  ↓ all required items completed
plan technically satisfied
  ↓ acceptance suite passed
task verified
  ↓ no unresolved background/effect/approval
turn converged
  ↓ user-visible result delivered
session interaction complete
```

模型的最终回复通常只对应最后一层的展示，不应替代前面的内部判断。

### 11.1 技术完成

代码、配置或 artifact 已按计划产生，工具状态明确。

### 11.2 验证完成

必要测试和检查通过，且检查适用于当前 Environment。

### 11.3 交付完成

结果已向用户说明，包含未完成事项、已知风险和需要用户决定的内容。

### 11.4 运营完成

后台任务、远程服务、发布或部署等相关 operation 都已进入可解释终态。

## 12. 任务失败的验收语义

任务失败也应有验收结果。一个失败任务可能是：

- 目标不可达；
- 工具失败但工作树未变；
- 部分修改已完成，需要用户决定是否保留；
- 测试失败但实现修改有价值；
- 远程副作用未知；
- 用户取消了后续工作。

这些状态都需要向用户说明，而不是只返回异常栈。计划可以进入 `failed`，但 Environment 中的实际变化仍需单独报告。

## 13. 各 Agent 的恢复与验收路径

### 13.1 Codex：Turn/Step 与执行事实

Codex 的 Turn loop、StepContext、工具记录、输入队列和 history 共同提供恢复与继续的基础。[^codex-turn] [^codex-step] [^codex-recorder]

它更接近产品化 harness：任务继续、用户输入、工具审批和子 Agent 等交互都需要在 Session/Turn 中收敛。计划验收不一定表现为显式 DAG，但可以通过工具事实、测试结果和 Turn 终态形成。

### 13.2 Pi：frames、restore 与 operation

Pi durable harness 使用 JSONL frames、lane/operation 和 restore/recovery 处理未完成工作；应用可以在其上实现自己的 plan acceptance。[^pi-jsonl] [^pi-restore] [^pi-recovery]

它把“底层 loop 如何继续”和“应用如何判断任务完成”分开，利于扩展，但也要求上层明确 acceptance criteria。

### 13.3 OpenCode：execution claim 与 Session projection

OpenCode 的 execution claim 解决谁可以恢复工作，Session projection 解决模型和 UI 看到什么；任务验收还需要 workspace 观察和项目级测试。[^opencode-execution] [^opencode-context] [^opencode-workspace]

这说明持久 Session 不等于已验证任务，execution state 也不等于业务完成。

### 13.4 OpenHands：跨服务和 Workspace 验收

OpenHands 的 Conversation、agent-server、sandbox 和 workspace 分离，恢复后需要重新确认后端环境和 artifact。[^openhands-adapter]

远程任务不能仅以 conversation history 判断完成，必须确认 workspace 或服务端任务的真实状态。

### 13.5 Kimi Code：Task persistence 与请求级恢复

Kimi Code 的 task state、StepRequest、tool dedupe 和 subagent context 使恢复器可以定位未完成请求和子任务。[^kimi-task] [^kimi-request] [^kimi-dedupe] [^kimi-subagent]

但请求完成仍需通过 acceptance 和 Environment 证据进入父计划，不能把 request finished 直接当作用户目标完成。

### 13.6 Gemini CLI 与 mini-SWE-agent

Gemini CLI 的 Session、动态 instructions 和 tool loop 可以继续模型决策，但复杂任务的独立 plan acceptance 需要更高层实现。[^gemini-session]

mini-SWE-agent 默认以 trajectory 推进，完成通常由模型和任务评估器判断；这提供了最小基线，也说明 durable plan recovery 不是简单 loop 自动产生的能力。[^mini-default]

## 14. 设计原则

### 原则一：完成必须由证据支持

assistant summary 是说明，不是验收结果。

### 原则二：验收结果绑定 Environment 版本

旧 workspace 上的通过结果不能无条件适用于当前工作树。

### 原则三：恢复先对账，再调用模型

先识别已完成、未完成和未知副作用，避免模型重新规划导致重复动作。

### 原则四：父任务接受子结果

子 Agent completed 是候选结果，父 Runtime 或 integration gate 需要显式接受。

### 原则五：技术完成、验证完成和交付完成分离

这样用户可以准确知道代码是否改变、测试是否通过、后台任务是否仍在运行。

### 原则六：stale evidence 是合法状态

历史检查结果仍然有价值，但不应伪装成当前环境事实。

### 原则七：恢复决策产生新事件

继续、重试、跳过、重规划和请求用户确认都需要留下原因和依据。

## 15. 验证方案

### 15.1 验收矩阵

对一个包含探索、修改、测试和后台服务的任务，在以下位置中断：

```text
plan admission 前
child assignment 后
file effect 后
test execution 中
test result 已返回但未持久化
parent result acceptance 前
turn final response 前
```

恢复后验证：

- 已完成 work item 是否重复；
- acceptance evidence 是否仍然适用；
- child result 是否已被父任务接受；
- Environment 是否发生变化；
- 下一步是否有明确 owner 和 scope。

### 15.2 伪成功实验

让模型或 child Agent 返回“完成”，但：

- 文件未修改；
- 测试仍失败；
- artifact 位于错误 workspace；
- 只完成了部分依赖；
- 后台服务尚未启动。

Runtime 应拒绝直接进入 verified/completed，并生成缺失证据或用户决策状态。

### 15.3 终态断言

```text
completed has current acceptance evidence
stale evidence cannot silently close a task
child completion requires parent acceptance
orphaned work has an owner/recovery decision
unknown effect never becomes success by timeout
recovery does not repeat committed effects
final user message matches Runtime verdict
```

本文没有对各 Agent 统一执行计划恢复和验收实验。上述结论来自固定版本源码、测试和机制分析；真实任务的验收覆盖率、远程 artifact 一致性和后台任务终态仍需项目级实验。

## Planning 专题收束

四篇文章形成一条完整链路：

```text
模型计划
  → 可执行工作项
  → 观察驱动的计划修正
  → 并行分解与子 Agent 委派
  → 结果汇聚与 Environment 验证
  → 恢复、验收和终态收敛
```

这条链路揭示了一个重要区别：

> Planning 不是让模型提前写出更多步骤，而是让 Runtime 能够知道当前任务由什么组成、每部分由谁负责、证据在哪里、变化为何发生，以及恢复后从哪里安全继续。

不同 Agent 的差异，主要在于这些责任放在哪里：

- mini-SWE-agent 把计划大部分留在 trajectory 和模型决策中；
- Pi 把长期运行和恢复骨架放进 harness，计划由应用组合；
- Codex 把任务、Turn、Step、工具和子 Agent 控制整合为产品 Runtime；
- OpenCode 通过 Session、execution claim 和 workspace 形成可恢复执行边界；
- OpenHands 通过事件、远程 Agent server 和 workspace 表达环境化任务；
- Kimi Code 将请求、任务、子 Agent、去重和权限边界显式化；
- Gemini CLI 更强调 Session loop 和动态 Context，复杂计划通常由上层产品补足。

因此，计划能力的演进不是从“没有计划”到“有计划”的二元变化，而是从模型内隐状态逐步迁移为 Runtime 可观察、可调度、可恢复和可验收的责任结构。

## 未确认事项

- 各项目的完成 verdict 是否由 Runtime 生成，还是主要由模型和 UI 生成，仍需结合产品层代码确认。
- 计划恢复后是否自动重跑验收检查，可能受成本、权限和 Environment 生命周期影响。
- 子 Agent 的 acceptance event 与 parent plan revision 是否具备跨进程原子性，尚未统一验证。
- 远程部署和后台任务的最终验收通常依赖外部系统，不能仅由 Agent Runtime 证明。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
