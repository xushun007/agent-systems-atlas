---
title: Coding Agent 的 Planning：从模型计划到可执行任务
series: Coding Agent 的 Planning 与 Task Decomposition
part: 1
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Planning：从模型计划到可执行任务

## 结论

Coding Agent 中的“计划”不是模型输出的一段 TODO 列表，也不是 UI 上显示的进度条。一个真正影响执行的计划，必须回答：任务由哪些工作组成，工作之间有什么依赖，哪些步骤已经被事实确认，下一步由谁负责，失败后从哪里继续，以及 Environment 变化后哪些计划仍然有效。

可以把计划分成四个层次：

```text
Intent             用户希望得到什么
Model proposal     模型认为可以怎样完成
Execution plan     Runtime 接受并跟踪的工作单元
Observed trajectory 实际发生的工具调用和结果
```

四者经常不同：模型可能提出先修改测试再改实现，但 Runtime 由于权限、依赖或 Environment 状态调整顺序；模型计划中的某一步可能被工具结果证明不需要；工具已经修改了文件，但原计划没有更新。

因此，Planning 的核心不是让模型一次性生成更长的计划，而是建立一种可修正、可观察、可恢复的执行结构：

```text
用户目标
   ↓
计划提案
   ↓  validation / admission
可执行工作单元
   ↓
Step / Tool execution
   ↓
Observation
   ↓
计划状态更新、继续、分支或终止
```

本文先建立计划的 Runtime 边界，比较 Codex、Pi、OpenCode、OpenHands、Gemini CLI、Kimi Code 和 mini-SWE-agent 的计划形态。后续文章将研究计划修正、并行分解、子 Agent 委派和计划与实际轨迹的偏差。

## 1. 为什么 Coding Agent 需要 Planning

一个简单 Agent loop 可以直接执行：

```text
模型请求 -> 工具调用 -> 工具结果 -> 下一次模型请求
```

对于一次短命令，这个结构足够。但软件工程任务通常具有：

- 多个文件和多个层次的依赖；
- 需要先探索再决定修改方式；
- 测试、构建和修复的循环；
- 可并行但也可能相互影响的工作；
- 用户中途输入、审批和取消；
- Environment 状态随执行不断变化。

如果没有计划层，所有任务结构都隐含在模型上下文中。这样会出现：

- 模型每一轮重新猜测总体目标；
- 已完成工作和待完成工作混在自然语言中；
- 工具失败后无法判断应重试、回退还是换方案；
- 用户无法知道当前任务是在探索、实施还是验证；
- 恢复时只能从聊天记录猜测下一步。

计划层的作用不是替模型思考，而是把跨多个 Step 的工作状态显式化。

## 2. 计划的最小结构

一个可以被 Runtime 跟踪的工作单元，至少应包含：

| 字段 | 含义 |
| --- | --- |
| `plan_id` | 计划身份 |
| `work_id` | 工作单元身份 |
| `parent_id` | 所属任务或子任务 |
| `description` | 面向用户和模型的目标 |
| `status` | pending、active、blocked、completed、failed、cancelled |
| `dependencies` | 必须先完成的工作 |
| `owner` | 当前 Agent、子 Agent 或 Runtime |
| `acceptance` | 判断完成的条件 |
| `evidence` | 支持状态判断的工具结果或观察 |
| `environment_scope` | 影响的 Workspace 或资源 |
| `revision` | 计划更新版本 |

这并不要求所有 Agent 使用数据库任务图。即使只有一个结构化 plan item，也比把“下一步做什么”藏在 assistant 文本中更容易恢复和审计。

### 2.1 计划项不是 Step

计划项是任务层工作单元，Step 是一次模型—Runtime 交互。一个计划项可能需要多个 Step：

```text
plan item: 修复登录测试
  Step 1: 读取测试和实现
  Step 2: 修改实现
  Step 3: 运行测试
  Step 4: 根据失败结果继续修复
```

反过来，一个 Step 也可能输出多个计划项或重新组织任务。把 plan item 和 Step 一一对应，会让计划无法表达探索和迭代。

### 2.2 计划项不是 Tool Call

Tool Call 是一次具体动作，例如读取文件、运行测试或写入 patch；计划项是一个需要满足验收条件的目标。一次工具调用成功，不等于计划项完成；一次工具调用失败，也不一定等于计划项失败。

### 2.3 计划项不是用户承诺

模型可以提出“我将修改三个文件”，但只有 Runtime 接受并记录后，才成为当前执行计划。即使被接受，计划也应是可修正的事实模型，而不是不可变承诺。

## 3. 自然语言计划与结构化计划

### 3.1 自然语言计划

```text
我会先检查配置，然后修改客户端，最后运行测试。
```

优点是灵活、可读、适合模型生成；缺点是状态难以可靠解析，完成条件模糊，恢复时无法确定哪些内容是承诺、哪些只是解释。

### 3.2 结构化计划

```json
{
  "plan_id": "p-42",
  "items": [
    {"id": "inspect", "status": "completed"},
    {"id": "change", "status": "active", "depends_on": ["inspect"]},
    {"id": "verify", "status": "pending", "depends_on": ["change"]}
  ]
}
```

优点是可以驱动 UI、恢复、并发和验收；缺点是 schema、更新协议和模型输出约束会增加 Runtime 复杂度。

### 3.3 混合模式

产品化 Coding Agent 通常使用混合模式：模型可以产生自然语言解释，Runtime 保存结构化计划状态，UI 再从结构化状态生成进度视图。

关键原则是：自然语言是说明，结构化状态才是控制流依据。

## 4. 计划状态机

一个最小计划项可以使用以下状态：

```text
PENDING
  ├── admit -> READY
  └── cancel -> CANCELLED

READY
  ├── start -> ACTIVE
  └── blocked -> BLOCKED

ACTIVE
  ├── evidence satisfies acceptance -> COMPLETED
  ├── explicit failure -> FAILED
  ├── dependency/environment issue -> BLOCKED
  ├── user cancel -> CANCELLED
  └── plan revision -> SUPERSEDED

BLOCKED
  ├── dependency resolved -> READY
  ├── user decision -> READY / CANCELLED
  └── no path -> FAILED
```

`SUPERSEDED` 很重要：计划项被重新规划后，旧项不应被删除，否则历史上无法解释为什么原计划没有完成。新计划项可以引用旧项，形成计划 revision chain。

## 5. Plan Admission：模型提案如何成为 Runtime 工作

模型输出一份计划后，Runtime 至少需要检查：

1. 是否仍然符合用户目标；
2. 是否包含超出授权范围的动作；
3. 是否依赖不存在的工具或 Environment；
4. 计划项是否可区分、可观察、可验收；
5. 是否包含危险或不可逆操作；
6. 是否与当前未完成 operation 冲突；
7. 是否需要用户补充信息。

计划 admission 不等于一次额外的模型调用，也可以是 Runtime 的 schema 校验和 policy 检查。重要的是不能让未经检查的自然语言计划直接驱动一组外部副作用。

Codex 将模型输出、Step、工具路由和权限放在不同层次；Kimi Code 的 StepRequest、tool policy 和 permission gate 也体现了“请求先进入 Runtime，再进入执行层”的边界。[^codex-step] [^kimi-request] [^kimi-policy]

## 6. 计划与 Context 的关系

计划一旦被接受，就成为后续 Context 的一种 Runtime 事实，但不是每次都需要把完整计划放进 prompt。

模型通常需要看到：

- 当前目标；
- 当前 active work item；
- 相关 pending work；
- 已完成工作中的关键证据；
- 被阻塞的原因；
- 当前验收条件。

模型不一定需要看到：

- 所有历史计划版本；
- 已经完成且与当前无关的细节；
- 内部 worker lease；
- UI 的进度展示字段。

Context Builder 应从计划事实生成当前计划视图，而不是把整个计划对象原样塞入 prompt。OpenCode 的 Session message 到 LLM message 转换、Codex 的 history 管理和 Pi 的 context snapshot 都支持这种事实与模型投影分离。[^opencode-context] [^codex-history] [^pi-agent]

## 7. 计划与 Environment 的关系

计划不是纯粹抽象的待办事项。它应说明或者能够推导：

- 需要访问哪个 Workspace；
- 依赖哪些文件或服务；
- 是否允许并行执行；
- 哪些动作会修改 Environment；
- 验收需要读取什么观察。

例如“运行测试”在不同工作树、分支、容器和依赖版本下并不等价。计划项的完成证据必须关联 Environment reference，否则恢复后可能错误地复用旧结果。

OpenHands 将 Agent server、sandbox、workspace 和 session context 分开；这说明任务计划不能只保存自然语言目标，还要知道实际执行环境。[^openhands-adapter]

## 8. 计划的完成条件

没有 acceptance condition，计划状态很容易退化为模型自报状态。

完成条件可以来自：

- 文件存在或内容匹配；
- patch 应用成功；
- 测试命令返回成功；
- 类型检查通过；
- Git diff 符合约束；
- 用户明确确认；
- 远程任务返回终态。

完成条件也可能是复合条件：

```text
完成“修复登录” =
  实现修改已写入
  ∧ 单元测试通过
  ∧ 类型检查通过
  ∧ 无未处理的冲突
```

模型可以提出满足条件的行动，但 Runtime 应使用工具观察和用户输入验证完成状态。一个 assistant 说“已经修好了”不是足够证据。

## 9. 计划与实际轨迹的偏差

实际执行几乎总会偏离初始计划：

```text
planned: inspect config -> change client -> run tests
actual:  inspect config -> discover generated code
         -> inspect build script -> change generator
         -> regenerate -> change client -> run tests
```

这不是计划失败，而是执行获得新信息后的 revision。Runtime 应记录：

- 原计划版本；
- 触发修正的 observation；
- 新增、删除或替代的计划项；
- 用户是否需要知道变化；
- 旧项是 completed、superseded 还是 abandoned。

如果只覆盖原计划文本，系统会失去解释轨迹；如果每次偏差都创建完整新计划，又会产生过度复杂的历史。可以采用 revision + delta：保留原计划，追加变更原因和新 active branch。

## 10. Codex：隐式计划与执行状态的分层

Codex 的核心 Runtime 不要求所有模型输出都先转为显式任务图；它更多通过 Turn、Step、工具调用、输入队列和历史状态推进任务。StepContext 将工具路由、MCP、Environment 和模型设置绑定到执行请求，Turn loop 负责继续、等待、压缩或结束。[^codex-step] [^codex-turn]

这是一种“隐式计划”设计：计划结构部分存在于模型 Context 和 Turn 控制流中，部分存在于工具/任务状态，而不是统一的用户可见 DAG。

优点是模型自由度高，适合探索式编码；代价是用户难以看到稳定的任务图，恢复器也需要从 Turn、tool result 和 pending input 推断当前工作。

## 11. Pi：从 Loop 到 Harness 的计划边界

Pi 底层 Agent loop 主要围绕 messages、tools、steer、follow-up 和 tool execution 推进，计划通常以模型消息或应用层结构存在。[^pi-loop] [^pi-agent]

Pi durable harness 增加 lane、operation、frame 和恢复边界后，可以把长期工作和计划责任放到更高层。它不强制一种产品化任务图，而是提供可组合的操作和恢复骨架。[^pi-harness]

这种设计将“模型如何计划”与“Runtime 如何跟踪长期操作”分开。应用可以构造显式计划，也可以保留轻量的模型驱动 loop。

## 12. OpenCode：任务执行与 Session 状态

OpenCode 的 Session runner、execution claim、compaction 和 Workspace 工具形成了任务推进的多个状态层。[^opencode-execution] [^opencode-context]

它更关注 Session execution 的责任、消息投影和可恢复运行，而不是把每个模型计划强制变成通用 DAG。计划可以通过 Session message、工具调用和 execution state 表达，Runtime 负责保持这些状态之间的关联。

这适合由模型动态改变执行路径，但对用户可见的计划进度和跨任务依赖，需要额外的产品层抽象。

## 13. OpenHands：事件轨迹作为计划骨架

OpenHands 使用 Action 和 Observation 表达 Agent 与执行环境之间的交互。[^openhands-events] [^openhands-observation]

它更接近“事件驱动的计划”：模型通过 Action 提出下一步，Observation 改变后续决策。对于长任务，事件序列可以形成轨迹和恢复基础，但 Action 序列不自动等于预先存在的完整任务图。

远程 workspace、sandbox 和服务状态使计划必须持续适应 Environment。计划项如果没有与具体 workspace 和 observation 关联，就无法解释同一任务在重启或迁移后的状态。

## 14. Gemini CLI：模型驱动的动态计划

Gemini CLI Session 将 transcript、动态 instructions、cwd 和工具执行结合在同一个 Agent loop 中。[^gemini-session]

它适合让模型根据每次工具观察动态调整计划。动态 instructions 可以补充当前环境和产品策略，但也意味着计划状态可能主要存在于 transcript 和 Runtime context 中，而不是独立的任务图。

这类结构的优点是交互自然，缺点是如果没有结构化 plan projection，用户和恢复器很难区分“模型解释”“下一步建议”和“已经接受的执行承诺”。

## 15. Kimi Code：请求级分解与任务状态

Kimi Code v2 的 StepRequest、Prompt/Step 队列、task persistence 和 subagent 结构提供了比单纯消息更明确的请求级执行边界。[^kimi-request] [^kimi-task]

它的计划更像“可调度的请求集合”：请求被 admission、排队、物化和执行，steer、取消和失败可以作用于不同请求。这样可以将计划中的工作分解为可恢复的 StepRequest，但仍需要上层定义工作项之间的业务依赖和验收条件。

## 16. mini-SWE-agent：没有独立计划层的基线

mini-SWE-agent 的默认 Agent 主要以 query、action 和 observation 推进 trajectory。[^mini-default]

它可以通过模型文本表达计划，但默认没有独立的 plan registry、任务依赖图或计划 checkpoint。这不是缺陷，而是一个有价值的基线：当任务短、环境单一、失败恢复要求低时，计划层可以由模型上下文隐式承担。

当任务变长或需要并行、审批和恢复时，单纯 trajectory 会逐渐承载过多责任，计划状态便会从模型文本中被抽取到 Runtime。

## 17. 计划的三种产品形态

### 17.1 隐式计划

计划存在于 Context 和模型下一步选择中。适合探索和短任务，成本低，解释性弱。

### 17.2 可见计划

Runtime 从模型输出或执行状态生成用户可见的 checklist。适合产品交互，但必须避免把 UI 状态当作事实来源。

### 17.3 可调度计划

计划项具有依赖、owner、Environment scope、验收和恢复状态，可以被多个 worker 或子 Agent 调度。适合长期软件工程任务，但需要更强的状态存储和冲突处理。

三个形态可以共存：用户看到可见计划，Runtime 保存可调度状态，模型收到当前 active branch 的隐式 Context。

## 18. 设计原则

### 原则一：计划是 Runtime 状态，不只是模型文本

只要计划会影响调度、恢复、审批或用户承诺，就应该具备结构化身份和状态。

### 原则二：计划项必须有完成证据

模型的自我描述可以作为提示，但不能单独决定 completed。

### 原则三：计划可以修正，但修正必须可追溯

覆盖旧计划会破坏解释性；追加 revision 和触发证据可以保留任务演进。

### 原则四：Plan、Step、Tool Call 分层

计划项描述目标，Step 描述一次模型—Runtime 交互，Tool Call 描述一次具体动作。三者混合会让恢复和并行调度失去边界。

### 原则五：计划绑定 Environment 范围

没有 Environment identity 和验收观察的计划完成状态，不足以支持恢复。

### 原则六：计划不应替代模型判断

计划提供任务结构和约束，模型仍然可以根据新观察提出 revision。Runtime 负责决定 revision 是否被接受。

### 原则七：计划状态进入 Context 时使用投影

模型需要当前计划视图，不需要整个历史任务图和内部协调字段。

## 19. 验证方案

### 19.1 计划 admission 实验

构造四类模型输出：

```text
valid plan with observable acceptance
plan with unauthorized action
plan with impossible dependency
plan that changes after new observation
```

验证 Runtime 是否：

- 区分 proposal 与 accepted plan；
- 拒绝超出权限的工作；
- 将不可能依赖标记为 blocked；
- 记录 plan revision；
- 保留旧计划和触发证据。

### 19.2 计划与轨迹偏差实验

让 deterministic Environment 在第二个 Step 返回意外文件结构，观察 Agent 是否能：

- 新增计划项；
- 关闭不再需要的计划项；
- 保持已完成工作的证据；
- 避免重复执行已有副作用。

### 19.3 计划恢复实验

在 active plan item 的不同位置中断：模型请求前、工具调用前、工具执行后、验收检查后。恢复后验证 active item、Environment observation 和 next action 是否一致。

本文没有在各 Agent 上统一执行这些实验。源码阅读可以证明计划、Step、Action、Request 和 trajectory 的责任结构，但不能单独证明产品 UI 显示的计划与恢复状态始终一致。

## 未确认事项

- 各 Agent 是否存在独立、持久化的 plan registry，需要结合产品层代码和运行时存储继续确认。
- 模型输出中的计划列表在不同项目中是否会被 Runtime 解析为控制流，不能只根据 UI 文本判断。
- OpenHands、Kimi Code 和 Codex 的子任务/后台任务是否共享同一计划状态，需要进一步研究父子 Session 和 operation 关联。
- 计划 revision 在压缩、分支和模型切换后的保留策略尚未统一验证。

下一篇将研究计划修正与执行偏差：新观察如何使原计划失效，Runtime 如何选择局部修改、整体重规划或请求用户确认。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-agent]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^codex-turn]: [Codex Turn run loop](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^pi-loop]: [Pi agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^openhands-events]: [OpenHands Action and Observation events](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-observation]: [OpenHands observation schema](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/base/observation.ts#L55-L140)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
