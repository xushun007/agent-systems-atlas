---
title: Coding Agent 的事实、事件与观察
series: Coding Agent 的 Observability / Evaluation
part: 1
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的事实、事件与观察

## 结论

Coding Agent 的可观测性首先是事实建模问题，其次才是日志、Trace 和指标问题。

一次 Agent 运行中至少同时存在六类信息：

~~~text
Runtime fact       Runtime 确认发生了什么
Model output       模型提出了什么计划或动作
Tool observation   工具返回了什么内容
Environment fact   文件、进程、网络和外部资源实际发生了什么
UI projection      用户界面展示了什么状态
Evaluation judgment 根据标准判定任务质量如何
~~~

它们不能互相替代：

- 模型说“测试已经通过”，不是测试通过事实；
- Tool 返回“命令成功”，不是文件和远程资源一定达到目标状态；
- UI 显示“已取消”，不是后台进程已经终止；
- Event 记录“请求已发送”，不是外部副作用已经完成；
- 轨迹完整，不代表任务结果正确；
- 任务成功，不代表执行过程高效、安全或可恢复。

因此，一个可研究、可恢复、可评估的 Coding Agent，需要建立如下关系：

~~~text
Facts              事实来源
  ↓
Events             事实变化的记录
  ↓
Projections        面向 UI、Trace、指标的派生视图
  ↓
Evaluation         根据验收标准的质量判断
~~~

本文的核心原则是：

> 记录系统必须标明“谁观察到什么”，不能把模型叙述、工具输出、Runtime 状态和外部资源状态压成同一种消息。

## 1. 为什么日志不是事实

### 1.1 日志通常是过程描述

一条日志可能写成“tool call succeeded”。它可能表示：

- handler 返回了 ok；
- 子进程退出码为 0；
- 远程请求返回了 HTTP 200；
- 结果被 Runtime 接收；
- 结果已经写入持久化；
- 用户界面已经展示。

这些是不同事实。日志如果没有声明语义，读者会把“某个阶段成功”误认为“整个动作成功”。

### 1.2 Event 不是完整世界状态

Event 通常表示某个时间点发生了状态变化：

~~~text
tool_call_dispatched
approval_recorded
process_started
remote_operation_created
~~~

它说明 Runtime 观察到一个事实，但不必然代表外部世界已经完成对应变化。例如 remote_operation_created 只说明外部服务接受了请求，不说明部署完成。

### 1.3 Observation 需要来源和时效

工具输出、UI 状态和模型消息都应附带：

~~~text
source
observed_at
valid_until / freshness
trust level
scope
~~~

文件列表是某个时间点的观察；进程列表可能在返回后立即变化；远程 API 的状态可能有延迟；模型对测试结果的总结可能只是推断。

## 2. 六类记录对象

### 2.1 Runtime Fact

Runtime Fact 是由 Agent Runtime 自己确认的状态事实，例如：

- Session 创建成功；
- Turn 已接受；
- Step 请求已定型；
- Tool Call 已通过 schema 校验；
- 用户审批已记录；
- Tool handler 已启动；
- Event 已持久化；
- Operation 状态已被查询。

Runtime Fact 的关键是主体和观察范围。“Tool Call 已派发”是 Runtime 事实，不等于外部 Tool 已完成。

### 2.2 Model Output

Model Output 包括文本回答、计划、Tool Call 参数、对 Tool Result 的总结和对任务状态的判断。

它是 Agent 决策的输入或输出证据，但不是外部世界的权威状态。记录时应保留模型、Provider、请求版本、采样配置和请求上下文的关联，不应直接把它写成 fact。

### 2.3 Tool Observation

Tool Observation 是 Tool 或 Connector 返回给 Runtime 的内容：

- stdout/stderr；
- 文件读取结果；
- HTTP response；
- 编译器错误；
- 浏览器页面；
- MCP Resource；
- 远程服务状态。

它的可信度依赖 Tool 和来源。Tool Result 可能包含不可信文本、过期状态、Prompt Injection 或截断输出，不能自动提升为系统级事实。

### 2.4 Environment Fact

Environment Fact 由执行环境或外部系统确认：

- 进程 PID、退出码和结束时间；
- workspace revision 或文件 hash；
- 测试框架实际返回的结果；
- 网络请求的响应状态；
- 远程 operation 的状态；
- Sandbox 是否已经销毁；
- 凭证、租约和资源是否仍有效。

这是代码执行评价和恢复最重要的一类证据。模型总结和 Tool output 都可能引用它，但不能代替它。

### 2.5 UI Projection

UI Projection 是面向用户的状态视图：

- 当前正在运行；
- 等待审批；
- 工具调用成功；
- 已取消；
- 任务完成。

它可能是多个 Event 的派生结果，也可能存在延迟、合并和乐观更新。UI 状态应能追溯到事实来源，但不能反向成为唯一事实源。

### 2.6 Evaluation Judgment

Evaluation Judgment 是根据外部标准做出的判断：

- 任务是否完成；
- patch 是否正确；
- 测试是否通过；
- 是否引入回归；
- Agent 是否超出权限；
- 成本和延迟是否可接受。

评价结论应记录标准、数据来源和评估版本。“success=true”如果没有验收规则，只是一个无上下文的标签。

## 3. Event 的事实边界

### 3.1 Event 应描述已发生的变化

好的 Event 名称通常表达状态变化或事实确认：

~~~text
turn_accepted
step_started
model_request_sent
tool_call_validated
approval_recorded
process_exited
workspace_changed
operation_status_confirmed
~~~

不够明确的名称包括 agent_working、tool_success、task_good 和 everything_done。后者把多个状态压缩在一起，无法进行恢复和指标归因。

### 3.2 Intent Event 与 Fact Event 分开

模型提出调用或 Runtime 准备执行时，记录的是意图或控制事实：

~~~text
tool_call_requested
tool_call_dispatched
~~~

外部结果确认后，才记录事实：

~~~text
tool_result_received
process_exit_confirmed
remote_operation_succeeded
~~~

两者不能只用一个 tool_call_completed 替代。

### 3.3 Event 的最小结构

建议事件至少包括：

~~~text
Event {
  event_id
  event_type
  event_version
  occurred_at
  recorded_at
  source
  session_id
  turn_id
  step_id
  parent_id
  subject_id
  payload
  causation_id
  correlation_id
  confidence
}
~~~

其中 occurred_at 是事件发生时间，recorded_at 是 Runtime 记录时间，source 表示谁产生或确认了事件，subject_id 表示事件作用于哪个对象，causation_id 表示由哪个事件触发，correlation_id 用于把多个事件关联到一次运行。

### 3.4 Event version 必须显式

Event payload 会演进。没有 event_version，恢复器无法判断旧事件中的字段语义，也无法安全地把旧事件映射成当前状态。

版本变化至少包括：

- 字段新增；
- 字段含义变化；
- 状态枚举变化；
- 时间和身份字段变化；
- 结果从同步变为异步 operation。

## 4. Event、State 与 Projection

### 4.1 Event 是变化，State 是当前判断

~~~text
Event log:     tool_call_dispatched → process_started → process_exited
State:         Tool Call = completed / failed / unknown
Projection:    UI 显示“命令已完成”
~~~

State 是根据事件、外部查询和恢复规则得到的当前判断；Projection 是面向使用者的派生结果。三者应能互相追溯，但不应存储成同一层对象。

### 4.2 Event log 不是无限可信

事件日志可能丢失、重复、延迟到达、顺序变化，只记录 Host 侧事实，或不包含远程服务最终状态。

所以恢复不能只重放本地事件。对 Environment 和远程 operation，需要在恢复时查询外部事实。

### 4.3 Projection 可以丢弃细节

UI 可以把几十个流式 delta 合并成一条消息；Metric 可以把多个 Tool Call 聚合为一个计数；Trace 可以采样掉部分低价值事件。

但用于恢复和严谨评估的 canonical record 不能依赖这些压缩投影。否则 UI 优化会改变事实语义。

## 5. Model Output 的可观测性

### 5.1 请求必须可关联

至少需要关联：

~~~text
model_request_id
provider
model
session/turn/step
projection_id
context version
sampling/config
started_at/completed_at
usage
finish_reason
~~~

如果没有 projection_id，后续无法知道模型看到哪些 Tool、Skill 和 Resource；如果没有 finish_reason，无法区分正常完成、长度截断、取消和 Provider 错误。

### 5.2 Streaming 记录的边界

流式输出通常包含文本 delta、Tool Call delta、usage 更新、provider event 和 finish event。

原始 delta 适合调试和重建请求，但不应直接作为 UI 或 Evaluation 的唯一输入。Runtime 应生成规范化的 completed output，并记录是否完整。

### 5.3 Tool Call 不能只记录最终参数

Tool Call 需要区分：

~~~text
model proposed
runtime parsed
schema validated
policy checked
approval granted
dispatched
executed
result committed
~~~

这条链能解释“模型做了什么”和“Runtime 实际允许并执行了什么”之间的差异。

## 6. Tool Result 的可观测性

### 6.1 Result 不等于事实

Tool Result 应记录 provider/tool identity、参数的安全摘要、exit code 或协议状态、stdout/stderr 或结构化 payload、truncation、timeout、trust label、观察到的 resource/version 和 redaction status。

一个返回 200 的 HTTP Tool 可能代表请求被接受，不能自动标记远程资源已完成。

### 6.2 Result 的信任标签

建议区分：

~~~text
runtime_confirmed
environment_observed
external_reported
model_interpreted
untrusted_content
stale_or_unknown
~~~

标签不是安全认证的替代品，但能防止下游把外部文本当成 Runtime 指令或确定性事实。

### 6.3 截断和脱敏也是事实

如果输出被截断或脱敏，必须记录：

~~~text
truncated=true/false
redacted=true/false
redaction_policy
original_size
visible_size
~~~

否则评估者可能错误地认为模型看到了完整结果，或认为模型没有依据却做出了判断。

## 7. Environment Fact 的独立记录

### 7.1 文件事实

文件变更不能只记录“edit tool succeeded”。至少需要记录规范化路径、原始和最终 hash、workspace revision、变更范围、用户并发修改、是否写入磁盘以及是否已被测试或构建读取。

### 7.2 进程事实

进程事实包括 process identity、parent/group、start/end time、exit code、signal、stdout/stderr capture、child processes 和 resource usage。

工具返回“命令执行完成”但没有进程退出事实，无法判断是否存在脱离的后台服务。

### 7.3 远程资源事实

对于远程服务，需要记录 endpoint 和 provider identity、request/operation identity、accepted/started/completed 状态、服务端版本或 resource revision、查询时间、取消是否确认以及当前状态是否仍然 unknown。

远程 Connector 的可观测性不能只复用本地 Tool Result。

## 8. UI Projection 的错误边界

### 8.1 UI 是状态投影

UI 应从事件和当前状态投影：

~~~text
facts/events → reducer/state projection → UI
~~~

如果 UI 直接根据模型文本显示“完成”，就会把模型判断提升为系统事实。

### 8.2 乐观状态必须可回收

用户点击取消后，UI 可以立即显示 cancellation requested，但不能直接显示 cancelled。如果后台进程或远程 operation 仍在运行，最终状态可能是：

~~~text
cancel_confirmed
cancel_failed
state_unknown
~~~

### 8.3 UI 合并不能破坏因果关系

为了减少渲染，UI 可以合并多个 Event，但必须保留当前 Turn/Step、Tool Call identity、Approval identity、Error/unknown 状态和父子 Agent 关系。

## 9. 安全和隐私边界

### 9.1 可观测性会放大 Secret 风险

需要防止 Secret 出现在 Model request、Tool arguments、stdout/stderr、exception、Trace span、Event payload、UI 和 Evaluation dataset。

记录“使用了某类凭证”通常足够；不应记录凭证内容。

### 9.2 脱敏必须保留可解释性

更好的做法是：

~~~text
secret value        → [REDACTED]
credential identity → credential:github-primary
resource scope      → repo:example/project
~~~

这样既不暴露 Secret，也保留执行归因。

### 9.3 不可信内容不能进入控制面

Tool Result、MCP Resource、网页和子 Agent 输出可以进入 Observation，但不能直接修改 Policy、Approval、Event authority、Environment scope 或 Evaluation ground truth。

## 10. 各 Agent 的记录边界取舍

### 10.1 Codex

Codex 的 StepContext、Permission profile、Network approval 和 Tool execution 形成了较清晰的执行事实边界。[^codex-step] [^codex-permissions] [^codex-network]

观测重点不是输出了多少文本，而是模型请求、Step 条件、Tool 调用、批准、Environment 和最终执行结果能否关联起来。

### 10.2 Pi

Pi 的 Agent Loop、Tool preparation/execution hook 和 Node Environment 提供了捕获模型调用、工具准备、执行和输出的入口。[^pi-prepare] [^pi-execute] [^pi-env]

由于 Runtime 较轻，应用层需要自行决定哪些 Hook 输出是事实、哪些只是日志，以及如何把后台进程和扩展状态纳入统一 Trace。

### 10.3 OpenCode

OpenCode 的 Workspace provider 与 Session execution claim 使观测对象包括执行 worker、workspace 和 ownership。[^opencode-workspace] [^opencode-execution]

如果只记录 Session 和 Tool name，却不记录 claim、Workspace 和 worker，无法解释同一个 Session 在不同时间由谁执行。

### 10.4 Gemini CLI

Gemini CLI 的 Policy Engine 与 Shell execution 分层。[^gemini-policy] [^gemini-shell]

观测时应区分策略允许命令、命令已派发、Shell 返回退出码和文件/远程资源达到目标状态，而不是把它们合并成一次 shell success。

### 10.5 OpenHands

OpenHands 的 Agent Server、Sandbox、Workspace 和服务上下文使事件关联跨越多个执行边界。[^openhands-adapter]

核心是把本地 Agent event、远程 runtime event、文件变化、服务 URL 和 Session identity 串起来，否则远程执行的事实无法归因。

### 10.6 Kimi Code

Kimi Code 的 Task persistence、Tool Policy 和 Subagent metadata 提供了将任务、策略和子 Agent 关联起来的结构。[^kimi-task] [^kimi-policy] [^kimi-subagent]

观测重点是区分父 Task 的目标、子 Agent 的执行、Tool policy 的决策和最终结果，避免把子 Agent 输出直接计入父 Agent 成功。

### 10.7 mini-SWE-agent

mini-SWE-agent 的 Environment output 和 trajectory 可以记录最小 Agent Loop，但不自动提供完整的 Event、Trace、外部 operation 或 Environment fact 层。[^mini-environment] [^mini-local]

它说明 trajectory 可以记录模型和工具交互了什么，但需要额外证据才能判断系统和外部世界实际发生了什么。

## 11. 从概念落到具体机制

前面的分类只有在能对应到真实代码责任时才有价值。下面把六类记录对象映射到已经分析过的 Agent 实现入口。

### 11.1 Codex：StepContext 是执行事实的入口

Codex 的 StepContext 绑定一次 Step 的执行条件，Permission profile 和 Network approval 分别提供权限配置与网络批准语义。[^codex-step] [^codex-permissions] [^codex-network]

因此在 Codex 中，以下概念不能只理解为抽象字段：

~~~text
StepContext        → 当前 Step 的 Environment/执行条件
Permission profile → Policy 输入
Network approval   → 一类独立的批准事实
Tool execution     → 实际副作用边界
~~~

研究 Codex 的 Observability 时，应从 Step 创建、Tool Router、Approval 记录和 Environment 执行路径开始，而不是先设计一个通用 span schema。

### 11.2 Pi：Agent Loop hook 是事实采集点

Pi 的 preparation hook 在执行前处理 Tool Call，execution hook 进入实际执行，Node Environment 捕获 Shell 输出。[^pi-prepare] [^pi-execute] [^pi-env]

因此 Pi 中的事实边界可以沿代码调用链定位：

~~~text
agent-loop preparation
  → prepared tool call
  → execution hook
  → nodejs Environment
  → stdout/stderr result
~~~

这里的 Tool Result 仍然不是文件或远程资源最终状态。若宿主应用要做可靠评估，还需要在 Environment 层补充文件 hash、进程生命周期和后台服务状态。

### 11.3 OpenCode：Session execution claim 是归因事实

OpenCode 将 Workspace provider、Session execution 和 Tool responsibility 分开。[^opencode-workspace] [^opencode-execution]

这意味着 OpenCode 的 Trace 不能只记录 session_id 和 tool_name，还需要记录：

~~~text
workspace provider
execution claim / worker ownership
session execution state
tool responsibility
~~~

否则无法回答“同一个 Session 的这次修改由哪个 Worker、哪个 Workspace 实例完成”。这里的 claim 不是通用 Trace 的标签，而是服务化执行的真实责任机制。

### 11.4 Gemini CLI：Policy 结果和 Shell 结果来自两条代码路径

Gemini CLI 的 Policy Engine 负责策略判断，Shell 模块负责实际命令执行。[^gemini-policy] [^gemini-shell]

因此以下状态必须分开观察：

~~~text
policy evaluation result
  → shell dispatch
  → process exit / output
  → workspace or external effect
~~~

“策略允许”只能证明第一步；“Shell 返回退出码为 0”只能证明进程层结果；代码是否正确需要测试或其他验收器确认。

### 11.5 OpenHands：本地 Agent 事实跨越远程 Runtime

OpenHands 的 agent-server context payload 将 Agent、Workspace、Sandbox 和服务信息放在跨边界的执行结构中。[^openhands-adapter]

所以 OpenHands 的事实采集需要关联：

~~~text
agent event
  → agent-server request
  → sandbox execution
  → workspace effect
  → service/resource state
~~~

只记录 Agent 侧事件会遗漏远程 Sandbox 和外部服务的状态；只记录 Sandbox 输出又无法解释用户输入、Agent 决策和服务身份。

### 11.6 Kimi Code：Task persistence 和 Subagent metadata 是归因入口

Kimi Code 的 Task persistence 保存任务状态，Tool Policy 负责工具策略，Subagent metadata 描述分叉和镜像上下文。[^kimi-task] [^kimi-policy] [^kimi-subagent]

因此评估父 Agent 任务时，不能把所有子 Agent 消息简单拼接成一条 trajectory。至少要保留：

~~~text
parent task
  → subagent run/fork
  → tool policy decision
  → tool/environment result
  → parent acceptance
~~~

父任务是否成功，应由父任务验收结果判断，而不是由子 Agent 最后一句文本判断。

### 11.7 mini-SWE-agent：trajectory 和 Environment output 的边界

mini-SWE-agent 的 Environment protocol 和 LocalEnvironment 将命令执行、cwd 和输出返回定义为最小执行机制。[^mini-environment] [^mini-local]

它能直接记录：

~~~text
model message
  → command action
  → environment output
  → next model message
~~~

但它默认不提供独立的远程 operation、workspace fact、Policy event 或恢复 checkpoint。这不是观测缺陷，而是最小 Runtime 的明确边界。把 trajectory 当作完整事实记录，会高估它对恢复和任务评价的支持。

### 11.8 机制映射表

| 研究概念 | 必须在源码中找到的机制 | 不能用什么替代 |
| --- | --- | --- |
| Runtime fact | 状态更新、Event append、执行返回或外部查询 | 模型文本 |
| Model output | Provider request/response、stream reducer | UI 消息 |
| Tool observation | Tool handler/Connector 返回结构 | Runtime success 日志 |
| Environment fact | 进程、文件、Sandbox、远程资源查询 | cwd 或 Tool 名称 |
| UI projection | reducer、订阅、状态映射 | UI 文案 |
| Evaluation judgment | 测试、diff、验收器或明确规则 | 最后一条 assistant message |

这张表是后续文章的最低证据标准。没有找到对应机制时，只能写“待验证”，不能把概念推断成实现事实。

## 12. Canonical Record 与派生记录

### 11.1 Canonical record

Canonical record 是恢复和严谨评价依赖的最小事实记录：

~~~text
canonical event
  + model request metadata
  + tool call state
  + environment observation
  + operation reconciliation
~~~

它需要版本化、可关联、可重建，不能为了 UI 方便任意覆盖。

### 11.2 Derived record

派生记录包括 UI timeline、Trace span、latency metric、token/cost aggregation、task success label 和 debugging summary。

派生记录可以重新计算。若它们成为唯一数据源，就会把采样、聚合和展示规则错误地固化为事实。

### 11.3 Projection version

每个派生视图应记录 projection name、projection version、source event range、aggregation rule 和 generated_at。

当成功率、成本或 UI 状态定义变化时，历史数据才可以重新计算和比较。

## 13. 验证方案

### 12.1 事实分类实验

选择一次包含模型请求、Tool Call、审批、Shell、文件修改和测试的运行，逐条标注 Runtime fact、Model output、Tool observation、Environment fact、UI projection 和 Evaluation judgment。

检查是否存在一条记录同时承担多个互相冲突的语义。

### 12.2 断线和未知状态实验

在本地命令产生副作用后、远程请求发出后、结果返回前断开 Host，观察日志、Event、UI 和恢复器是否都保留 unknown 语义，而不是错误显示失败或成功。

### 12.3 UI 与事实对照

让用户取消一个包含后台进程的 Turn，对照 UI 显示、Runtime Event、进程状态和远程 operation 状态，验证 UI 是否准确表达“请求取消”和“取消已确认”的差异。

### 12.4 脱敏实验

注入标记 Secret，检查它是否出现在请求、Tool arguments、stdout、Event、Trace、UI 和 Evaluation dataset，同时验证去敏后仍能通过 credential identity 进行归因。

### 12.5 重建实验

删除所有派生 UI/Metric 数据，只保留 canonical events、模型请求元数据和 Environment facts，验证是否能重建 Tool Call timeline、当前状态、资源变化、失败原因和任务评价输入。

### 12.6 丢失和重复 Event

人为制造重复、乱序和延迟 Event，观察状态 reducer 是否幂等、是否能检测 gap，以及恢复器是否会重复执行外部 operation。

## 设计原则

### 原则一：事实、输出、观察和评价分层

模型说了什么、工具返回什么、Environment 确认什么和评价者判断什么，必须保留不同来源和语义。

### 原则二：意图与结果分开记录

请求、派发、执行、结果接收和外部副作用确认不是同一个事件，不能用单一 success 字段覆盖。

### 原则三：Canonical record 优先于派生视图

UI、Trace 和 Metric 都可以重新计算；恢复和严谨评价必须依赖版本化、可关联的事实记录。

### 原则四：未知状态必须可表达

断线、超时和取消不能自动归类为成功或失败；系统必须保留 unknown 并支持查询和后续收敛。

### 原则五：重要事实必须可追溯

记录不仅要有内容，还要有 source、time、scope、identity 和关联链，以便判断它是否仍然有效。

## 未确认事项

- 各 Agent 是否保存了足够的 canonical Event，还是主要依赖 UI 或 trajectory，需要逐项目阅读持久化实现；
- 外部 Environment facts 是否回流到 Agent Event log，需要运行时和服务端联合观察；
- 各 Provider 的请求、usage 和成本字段是否完整可靠，需要结合 API 返回和账单核对；
- Trace 采样、脱敏和保留策略的实际配置不能由 Agent 核心代码单独确认；
- 任务成功判断是否使用独立验收器，不能由模型最终文本推断。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
