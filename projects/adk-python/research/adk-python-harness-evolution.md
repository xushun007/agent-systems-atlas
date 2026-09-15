---
title: Google ADK Python Runtime / Harness 演进研究
snapshot_id: 2026-09-15.76a96e6
reviewed_at: 2026-09-15
upstream_repository: https://github.com/google/adk-python
upstream_commit: 76a96e6221f1e2758a1ff82fde199cd079e9c654
upstream_commit_date: 2026-08-26
previous_snapshot: null
status: current
change_level: major
verification:
  source_reading: true
  tests_read: false
  runtime_experiment: false
diagram: null
---

# Google ADK Python Harness 的 Runtime 演进研究

本文研究 Google ADK Python 从早期 Agent/Runner/Session 抽象到 `v2.8.0` 的整体 Runtime/Harness 演进，重点关注：执行生命周期、事件与恢复、工作流调度、用户中断与权限、工具和模型能力、代码执行环境，以及这些边界如何从“对话 Agent”扩展为“可持久化、可恢复、可编排的 Agent application runtime”。

分析基线是上游仓库 `google/adk-python` 的 `v2.8.0`，commit [`76a96e6221f1e2758a1ff82fde199cd079e9c654`](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654)。源码使用官方 `v2.8.0` 发布归档核对；官方 GitHub API 中的 tag、commit 和 CHANGELOG 提交链接用于追踪演进。上游源码工作区只作为本地阅读材料，本文不把本地导入提交冒充为上游历史。

## 核心结论

ADK 的主线不是把单个 LLM Agent loop 做得越来越复杂，而是把“Agent 调用”逐步提升为一个具有持久化事实、图调度、恢复协议和应用级策略的 Runtime。它经历了五次关键边界移动：

1. **从 Agent loop 到 Session/Event Runtime**：用户输入、模型响应、工具调用和工具结果被统一成可追加的 `Event`，`Session` 成为对话和运行事实的容器。
2. **从一次性调用到可恢复执行**：暂停、工具确认、认证、Live 重连、rewind、事件压缩和 resumability 使 invocation 可以跨请求继续，而不是必须从头再跑。
3. **从 Agent 树到 Workflow 图**：`BaseNode`、`Workflow`、动态节点和任务模式把控制流从隐含的 agent transfer 提升为可验证、可并发、可重放的图调度。
4. **从共享上下文到分支/隔离/重建**：branch、`isolation_scope`、node path、sequence barrier 和 replay manager 控制不同子任务可见的事件，并从事件历史恢复工作流状态。
5. **从静态工具集合到策略化能力面**：模型能力、动态 toolset、插件、MCP、认证、工具确认、代码执行和 context cache 在请求生成前共同决定“模型能看到什么、运行时能执行什么、哪些动作需要人确认”。

到 `v2.8.0`，ADK 可以抽象成四个相互耦合的平面：

| 平面 | 主要职责 | 代表组件 |
| --- | --- | --- |
| Application / Control | 定义应用边界、入口节点、插件和全局配置 | `App`、`Runner`、`PluginManager` |
| Orchestration | 安排 Agent、Workflow、并发节点、重试、动态节点和任务委派 | `BaseNode`、`Workflow`、`NodeRunner`、`LlmAgent` |
| Context / Capability | 将 session 事件、state、模型能力、工具、缓存和认证组装为 LLM request | `InvocationContext`、LLM flows、`BaseToolset`、`BaseLlm` |
| Persistence / Recovery | 保存 session state 和 Event，支持 replay、resume、rewind、compaction | `SessionService`、`Event`、resumability、replay manager |

这个模型也解释了 ADK 与典型 coding-agent harness 的差异：ADK 把“应用内多 Agent 工作流”和“事件驱动恢复”放在 Runtime 核心；coding agent 通常还需要在此之上增加 workspace/environment、权限策略和宿主进程治理。ADK 有这些能力的对应物，但它们主要以 service、toolset、credential、code executor 和 plugin 形式组合，而不是一个以本地工作区为中心的单一执行环境。

## 一、运行时的基本层次：Session、Invocation、Agent call、Step、Event

ADK 在 `InvocationContext` 的文档中给出了明确的生命周期层次（见 [`invocation_context.py#L105-L143`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py#L105-L143)）：

```text
Session
  └── Invocation：一次从 user message 到最终响应/暂停的运行
        ├── Agent call：一个 agent.run() 生命周期
        │     └── Step：一次 LLM 调用及其工具处理
        │           ├── model response
        │           ├── tool call / tool response
        │           └── 下一次 LLM summarization step
        └── 子 Agent / Workflow calls
              └── branch + isolation_scope
```

需要特别区分：`Session` 不是一个单纯的 prompt history；它持有状态和有序 `Event` 历史。`InvocationContext` 是一次运行的临时控制状态，包含 invocation id、当前 agent/node、branch、session、队列、resumption、live 状态、工具缓存和 cost manager。`Step` 不是一个独立持久化对象，而是由 LLM/工具事件及其 invocation 语义构成的运行单元。

一次运行的核心路径是：

```text
Runner.run_async()
  → get/create Session
  → resolve invocation_id / resume inputs
  → create InvocationContext
  → append user Event
  → plugin before-run
  → run root BaseAgent/BaseNode
  → InvocationContext event queue
  → Runner append non-partial Event to Session
  → yield Event to client / SSE
```

`Runner` 的入口和服务依赖见 [`runners.py#L209-L327`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L209-L327)，运行循环和恢复输入处理见 [`runners.py#L600-L698`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L600-L698)。

### 哪些是持久事实，哪些是可变运行态

| 对象 | 生命周期/作用 | 是否持久化 | 主要可变性 |
| --- | --- | --- | --- |
| `Session` | 用户、App、session id 所属的长期交互容器 | 是，取决于 SessionService | state 和 events 追加；identity 应保持稳定 |
| `Event` | 用户输入、模型输出、工具调用/结果、状态 delta、路由和中断事实 | 是，非 partial Event 通常追加 | 设计上是追加事实；ID、时间和 invocation 归属不应被调用方任意改写 |
| `InvocationContext` | 一次 invocation 的运行控制面 | 否，运行结束后由事件和 state 重建 | 当前 node、队列、resume inputs、active tools、成本等都会变化 |
| `Workflow._LoopState` | 一个 Workflow 执行中的调度器状态 | 否；代码明确标为内存态 | 节点状态、pending tasks、trigger buffer、重试和 replay 状态持续变化 |
| `State` delta | 节点对 session/app/user 状态的待提交变化 | 通过 Event/SessionService 提交 | invocation 内可变；提交边界由 Event append 收敛 |
| `App` | application 级 root、plugins、compaction/cache/resumability 配置 | 通常由部署配置提供 | 运行时应视为应用配置；Runner 会归一化入口 |
| `RunConfig` / live handle | 一次请求或 live 通道的运行参数 | 部分信息进入事件或服务端状态 | 可在恢复请求中补充，但不能任意改变已发生的 invocation 事实 |

因此，用户连续输入、工具确认、认证结果和中断并不是都属于同一层：它们通常以新的外部请求进入 `Runner`，但通过原有 `session_id` 和 `invocation_id` 继续同一个 Session/Invocation；真正被持久化的是 user/function-response Event 以及相关 state delta，而不是内存中的 Python 调度器。

## 二、演进时间线：从 Agent SDK 到可恢复工作流 Runtime

### 1. 早期阶段：Agent、Runner、Session、Tools 的基本闭环

`v0.x–v1.x` 的核心形态是：一个 `Agent` 接收内容，通过 LLM flow 产生模型响应，执行工具，再把结果回送模型。`Runner` 负责把 agent 放进 session；Session service 负责保存会话；工具和 code executor 负责把模型动作接到外部系统。

这阶段已经形成 ADK 的重要不变量：上层 agent 不直接依赖具体存储；LLM provider 通过 `BaseLlm` 和 flow 适配；工具执行与模型调用通过 Event/Context 连接。早期版本的产品表面更接近“Agent API”，但 Runtime 的持久化接口已经为后续恢复和多 Agent 奠定基础。

可追溯的早期能力包括：`v0.3.0` 的 multi-agent、agent-as-workflow、custom agent 和 built-in code execution；`v0.4.0` 的 CLI replay/resume。这说明“工作流”和“恢复”并非 2.0 才突然出现，而是在 2.0 前逐渐从特性变成架构问题。[CHANGELOG 历史](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L3286-L3398)

### 2. `1.16–1.17`：可恢复执行第一次成为 Runtime 能力

`1.16.0` 是重要转折：加入 invocation pause/resume、LLM context compaction 等能力；`1.17.0` 继续支持 rewind、带多个暂停分支的 resumable parallel agent、tool confirmation 和认证相关流程。[`1.16.0` CHANGELOG](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L2503-L2563)；[`1.17.0` CHANGELOG](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L2418-L2502)。

架构含义有三点：

- 中断不再是 UI 层的暂停，而是可被 Event 历史表达、由下一次请求恢复的 execution state；
- 工具确认和认证请求必须保留“等待谁、恢复哪个调用、结果回到哪个分支”的身份信息；
- compaction 不再只是减少 prompt，而是要保持工具调用、分支和恢复语义不被破坏。

此时 ADK 仍可用 Agent 树表达编排，但 Agent 树已经开始承载 workflow engine 的职责。

### 3. `2.0.0` GA：从 Agent 树正式转向 Workflow 图

`2.0.0` 是最大的架构事件。官方 release notes 将它描述为面向生产的 multi-agent workflow 和 dynamic agent collaboration 基础，明确强调：非线性、条件、循环图；并行 worker、嵌套层级团队和 resilient dynamic scheduling；agent 间 routing、控制状态交接和 context variable propagation。[`2.0.0` CHANGELOG](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L1179-L1193)。README 同时将用户心智模型改成 `Agent` 定义行为、`Workflow` 负责编排。

在源码中，这一变化落到了 `BaseNode` 和 `Workflow`：

- `BaseNode` 统一 agent-like node 的输入、输出、schema、retry、timeout、resume 和 `RequestInput` 规范化；见 [`_base_node.py#L43-L196`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_base_node.py#L43-L196)。
- `Workflow` 将 edge 定义编译为 Graph，并把执行明确分为 SETUP、LOOP、FINALIZE；见 [`_workflow.py#L145-L265`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_workflow.py#L145-L265)。
- `LlmAgent` 不再是唯一的调度抽象；task mode、single-turn mode、`AgentTool` 和 Remote A2A agent 使 agent 可以作为节点或受控任务被调用。
- 原来的 `SequentialAgent` 和 `ParallelAgent` 在 v2.8 中已标记为推荐迁移到 `Workflow`，表明图 Runtime 正在取代专用控制流类。

这不是简单增加一个 DAG API。Workflow 调度器要处理并发完成顺序、retry、等待节点、动态节点、HITL、中断、任务委派和恢复。因此，ADK 的“工作流”本质上是一个带 replay 语义的执行引擎，而不是静态拓扑遍历器。

### 4. `2.1–2.4`：把图 Runtime 接入 App、Live、A2A 和插件边界

2.0 后的主要工作不是再次发明调度模型，而是把图模型接入生产边界：

- `App` 成为顶层容器，统一 root agent/node、plugins、event compaction、context cache 和 resumability 配置；见 [`app.py#L53-L104`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/apps/app.py#L53-L104)。
- `Runner` 兼容旧的 agent/node 构造方式，但内部统一归一化为 App，并持有 session、artifact、memory、credential 和 plugin services。
- Workflow 开始处理 replay divergence、branch mutation、single-turn contents、nested workflow telemetry 和任务节点的恢复。
- A2A、MCP、skills、Live session resumption 和 context cache 不再是外围示例，而开始成为跨 Agent/跨进程运行的接入面。
- 插件变成全局 callback plane：它可以在 user message、run、model、tool、event、error、compaction 等边界介入；见 [`base_plugin.py#L41-L71`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/plugins/base_plugin.py#L41-L71)。

这一阶段的本质是把 workflow engine 从库内部能力变成 application runtime：应用级策略和资源不再散落在 Agent 构造代码中，而是由 `App`/`Runner` 装配。

### 5. `2.5–2.6`：resumability、checkpoint 和 replay 成为一等公民

2.5 和 2.6 的 CHANGELOG 显示，ADK 开始系统性修复“暂停后如何继续”的所有边界，而不是只维护根 Agent 的 happy path：

- workflow node 的 checkpoint event；
- delegated task branch isolation；
- task-mode node 的 state-based resumption；
- standalone node 和 `NodeTool` 的 HITL resumption；
- workflow rehydration indexing，降低从历史重建的成本；
- nested workflow、parallel task、tool confirmation 和 auth 的恢复；
- resumable mode 下拒绝 user-authored function call，避免 continuation forgery；
- context cache fingerprint、动态工具和 prompt cache 的一致性；
- transfer loop、duplicate execution 和错误退出时的并发任务收敛。

代表性提交可直接追踪：[checkpoint `cecc1f9`](https://github.com/google/adk-python/commit/cecc1f98d5837de3157a606e7a6409fece5deef)、[branch isolation、dynamic-tool prompt cache 和恢复安全修复](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L463-L611)、[tool confirmation resume `c427020`](https://github.com/google/adk-python/commit/c4270203c657d4abb14188b90ed692465f1f36c9)、[continuation forgery protection `283e92e`](https://github.com/google/adk-python/commit/283e92efc2297246ff6f70ceb220b9b299aa2d67)。2.5 和 2.6 的完整发布区间见 [`CHANGELOG.md#L612-L727`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L612-L727)。

这标志着一个重要转变：ADK 不再把 session 当作“聊天记录”，而是把它当作可重建 execution history。Workflow 的 `_LoopState` 在源码中明确是内存状态；恢复时扫描 session events，建立 recovered executions 和 sequence barrier，然后重新调度尚未完成的节点。也就是说，持久化的是事实，调度器状态是派生物。

### 6. `2.7`：能力声明和请求构造开始解耦

2.7 的核心变化是 model capability reporting：模型自己声明是否支持 output schema 与 tools 的组合，而不是 ADK 仅根据 model id 推断；见 [`base_llm.py#L45-L124`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/models/base_llm.py#L45-L124)。同时加入或强化：

- 工具返回 media；
- thought signatures/server-side tool calls 和 parallel function results 的历史保留；
- Jinja2 instruction templates；
- root LlmAgent task mode；
- skill scripts 的 environment tool execution；
- context cache 的隐式/显式状态和 transfer 场景传播；
- 启动和 hot path 优化。

因此，LLM request 的形成不再是“把 Agent 上的 tools 列表直接塞给模型”，而是一个能力协商结果：模型能力、Agent 模式、工具声明、上下文缓存、认证和 plugin processor 一起决定最终请求。

### 7. `2.8`：恢复正确性、可观测性和互操作性硬化

`2.8.0` 没有重新改变主抽象，但对 runtime 的可靠性边界进行了密集加固：

- RemoteA2aAgent 支持 native task mode；
- Live 使用 `RunConfig.session_resumption.handle` 恢复通道；
- 每个 workflow 的 inference/tool-call 次数和 token spend 进入 telemetry；
- workflow rehydration 避免 O(n²) event comparison；
- 每个 function response 都参与 invocation resume 推断；
- 恢复 non-root agent 时从 history 恢复 branch；
- deterministic START/JoinNode、workflow cancellation、node auth resume；
- 防止 duplicate function execution、duplicate OAuth prompt、duplicate synthetic user event 和 contextvars 泄漏；
- MCP session pool 回收 idle sessions；
- legacy session actions 使用 restricted unpickler；
- partial event 不再触发 function call；
- session identity 在 single-turn node context 中保持稳定。

这些条目说明 v2.8 的成熟度问题已经从“能否编排”转为“并发、恢复、安全和计费是否在所有边界保持一致”。[官方 `2.8.0` CHANGELOG](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L1-L171)

## 三、v2.8 Runtime 的关键组件

### 1. `App` 和 `Runner`：应用装配与运行控制

`App` 是应用级声明：一个 root agent/node，加上全局 plugin、event compaction、context cache 和 resumability 配置。`Runner` 将旧 API（直接传 agent/node）归一化到 App，同时持有 Session、Artifact、Memory、Credential 服务和 PluginManager。

这一步的架构价值是把应用配置和一次 invocation 分开。用户可以改变下一次运行的 `RunConfig` 或提交恢复输入，但不会把一次运行中的 node scheduler、event queue 或 active tool task 当成应用全局状态。

### 2. `SessionService`：状态分层和事件存储

`Session` 包含 `id`、`app_name`、`user_id`、当前 state、ordered events 和更新时间；见 [`session.py#L28-L65`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/sessions/session.py#L28-L65)。State 又通过 key 前缀分成：

| key | 生命周期 | 典型用途 |
| --- | --- | --- |
| 无前缀 | session | 当前会话事实 |
| `app:` | app | 同一 App 共享的配置/状态 |
| `user:` | user | 同一用户跨 session 的状态 |
| `temp:` | invocation 内存 | agent 间临时通信，不进入持久化 |

`State` 同时维护 current value 和 pending delta；见 [`state.py#L61-L135`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/sessions/state.py#L61-L135)。当 Event 被 Runner append 到 SessionService 时，delta 才成为跨请求可重建的状态。因而 state mutation 与 event append 构成一个关键一致性边界。

### 3. `Event`：统一对话、执行和控制事实

`Event` 不只是模型 message。它继承 LLM response，并携带 `invocation_id`、author、actions、generic node output、node path/run id、branch、isolation scope、long-running tool ids、时间戳和 ID；见 [`event.py#L91-L167`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/events/event.py#L91-L167)。Event actions 可表达 state delta、route、compaction、agent state、end-of-agent 和中断相关事实。

Event queue 的设计很关键：所有 node 向共享队列发送事件，Runner 是唯一消费方；non-partial event 在 Session append 完成前会阻塞生产者，partial event 只用于 SSE streaming、不进入 session。见 [`invocation_context.py#L256-L315`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py#L256-L315)。这为并发 workflow 提供了一个单一持久化汇聚点。

### 4. `Workflow`：事件重建上的图调度器

`Workflow._run_impl()` 的 SETUP 阶段从历史事件扫描 recovered executions；随后创建动态节点 scheduler，进入 LOOP 调度 ready nodes，最后收集等待节点和 terminal outputs。它不把 `_LoopState` 当作数据库对象，而是把它作为 event history 的派生状态。

这产生三个重要不变量：

- **事实顺序和执行顺序分离**：并发节点可以先后完成，但 sequence barrier 和 node metadata 保持可重放顺序；
- **动态节点不是静态图的特例**：`ctx.run_node()` 进入同一调度/恢复模型，但由父节点 inline await，避免全局并发限制造成死锁；
- **中断是节点状态而非异常**：`RequestInput` 被 BaseNode 规范化为 interrupt Event，恢复时依据 node、invocation、branch 和 resume input 继续。

### 5. Toolset、Plugin 和 Model capability：能力平面

`BaseToolset.get_tools(readonly_context)` 可以依据 invocation context 动态返回工具，并通过 invocation id 缓存；见 [`base_toolset.py#L63-L166`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/tools/base_toolset.py#L63-L166)。Toolset 还可以在每次 LLM request 前修改 request，处理认证、computer-use 或 provider-specific 工具声明；见 [`base_toolset.py#L208-L240`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/tools/base_toolset.py#L208-L240)。

这意味着“可变工具”不是简单地把工具名称动态拼到 prompt 文本里，而是请求构造期的能力集合：工具 declaration、执行回调、toolset processor、auth config 和 plugin 都可能影响最终的 `LlmRequest`。它当然可能改变 provider 侧的 prompt/tool cache；ADK 的 2.6/2.7 相关提交正是在保护动态工具场景中的 context cache fingerprint 和 cache reuse。`static_instruction`、context cache config 和 dynamic instruction 的分离，则是降低不稳定部分对缓存前缀影响的机制。

因此可以用下面的顺序理解请求：

```text
Session events/state
  + Agent instruction / mode
  + model.capabilities
  + toolset.get_tools(context)
  + plugin callbacks
  + auth / confirmation policy
  + context-cache policy
        │
        ▼
      LlmRequest
        │
        ▼
      model response → tool execution → Event
```

### 6. Environment 和代码执行：执行后端，而非默认 cwd

ADK 的 Environment 不应理解为 coding agent 中的“当前工作目录”。它更接近由 code executor、toolset、credential service、artifact service 和部署平台共同定义的执行后端。当前源码提供 unsafe local process、container、GKE、Vertex AI/Agent Engine sandbox、built-in provider-side execution 等路径；代码执行通过 LLM flow 的 request/response processors 接入，而不是让 Runner 直接 `exec` 任意模型文本。

这带来一个清晰边界：

- Runner 决定 invocation、session、事件和服务依赖；
- Tool/Toolset 决定模型可请求的能力；
- CodeExecutor 决定代码在哪里、以什么隔离级别运行；
- ArtifactService 决定输入输出文件如何跨步骤保存；
- Credential/Auth 决定外部工具是否能访问资源。

所以 ADK 可以承载 coding/data-agent 场景，但“环境拥有执行”的抽象并没有收敛为一个统一 Environment 对象，仍然是多个服务和 executor 的组合。这一点与 Codex 以 workspace/sandbox/environment 为核心的 harness 有明显差异。

## 四、用户持续输入、权限审批和中断如何落到生命周期

### 新用户输入

新输入通常启动一个新的 invocation，但复用已有 `Session`。Runner 将 user message 作为 Event 追加，然后创建本次 InvocationContext。Session 是长期 identity；invocation 是一次从输入到最终响应/暂停的运行；step 是 invocation 内一次 LLM/tool cycle。

### 工具确认与认证

工具调用先作为 Event 事实出现；如果 tool confirmation 或 credential exchange 需要用户/外部系统输入，Runtime 发出可恢复的请求。后续请求带 function response、resume input 或 credential result，通过 invocation/session history 找回原始调用，而不是把结果当成新的普通 user turn。2.5–2.8 的大量修复都围绕“恢复到正确 invocation、分支和 function call”展开。

### 中断与恢复

`RequestInput` 被节点层转换成 interrupt Event；resumable 配置、node 的 `rerun_on_resume`、workflow recovered executions 和 session events 一起决定恢复行为。恢复不是简单重新调用 root agent：它要恢复 user content、invocation id、branch、node path、pending task 和工具/认证上下文。

### Live 输入

Live 场景额外拥有实时请求队列、transcription cache、active streaming/non-blocking tools 和 session resumption handle。这些是 InvocationContext 的运行态或外部服务句柄；不能与 Session 的长期事件历史混为一谈。2.8 的 live 修复表明，通道恢复和普通 invocation resume 是相关但不同的两个协议。

## 五、架构演进中保留下来的不变量

1. **上层 Agent 不直接绑定存储**：Runner 通过 SessionService 抽象 InMemory、SQLite、数据库和 Vertex 后端。
2. **模型、工具和执行器可替换**：LLM adapter、Toolset、CodeExecutor 和 ArtifactService 以接口组合。
3. **Event 是跨层连接器**：模型输出、工具结果、状态变更、路由、中断和 workflow node output 都能进入统一历史。
4. **运行态与持久态分离**：InvocationContext、Context 和 Workflow loop state 可以重建，Session/Event 才是跨请求依据。
5. **恢复必须保留身份**：`session_id`、`invocation_id`、branch、node path、function call id 和 isolation scope 共同确定一个结果应该回到哪里。
6. **插件优先于局部 callback**：全局 policy、logging、metrics、cache、错误处理和 request/response 变换应在应用级 callback plane 实现。

## 六、与其他 coding-agent harness 研究的连接点

这些不是横向比较结论，而是后续研究 ADK 时需要保持一致的观察维度：

- ADK 的 `Session → Invocation → Agent call → Step → Event` 可作为其他 Agent runtime 的生命周期对照表，但不能直接等同于 coding agent 的 Session/Turn/Step；
- ADK 用 Event + replay manager 重建工作流调度状态，这与以 rollout/thread store 为核心的 harness 相近；
- ADK 的 `App`、PluginManager、Toolset、Capability 和 Credential service 对应应用控制面和能力面；
- ADK 的 CodeExecutor/Artifact/Auth 组合对应执行环境，但尚未收敛为 coding-agent 式单一 Environment ownership；
- ADK 2.5–2.8 对恢复、分支隔离、工具确认和 prompt cache 的处理，是研究“长会话 Agent 是否真的可恢复”时最有价值的实现材料。

## 未确认事项

- 本文没有运行真实模型、Live session、外部 MCP/A2A 或多节点恢复实验；恢复和缓存结论来自源码、测试入口和官方 CHANGELOG。
- v2.8.0 的官方 Git tag/commit 已通过 GitHub API 和官方源码归档核对，但本地仓库目前只有源码导入提交，未能形成官方 commit graph；需要时可继续用 GitHub API 按历史版本补齐 commit metadata，或在网络可用时重新执行 partial fetch。
- ADK 的“Environment”目前是多个 executor/service 的组合概念；是否会在后续版本收敛成统一 environment contract，需要后续版本源码确认。
- `Workflow` 文档中仍保留 checkpoint/replay 方向性 TODO，说明 v2.8 的恢复模型已经成熟，但不是所有工作流状态都拥有独立 checkpoint 对象；不能把 Event rehydration 与完整数据库 checkpoint 混为一谈。

## 主要源码与版本依据

- [v2.8.0 commit](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654)
- [`App`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/apps/app.py)
- [`Runner`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py)
- [`InvocationContext`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py)
- [`BaseNode` / `Workflow`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/)
- [`Event` / `Session`](https://github.com/google/adk-python/tree/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/events)
- [`BaseToolset`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/tools/base_toolset.py)
- [`BaseLlm.capabilities`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/models/base_llm.py)
- [`CHANGELOG.md`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md)

## 七、状态所有权：ADK 的 Runtime 不是一个 Session 对象

ADK v2.8 的状态分布在应用、运行控制、会话服务和工作流节点之间：

| 状态 | 所有者 | 生命周期 | 恢复方式 |
| --- | --- | --- | --- |
| App definition | `App` | 应用部署周期 | 重新装配 root node/plugin/config |
| Session identity/state | `SessionService` | 用户会话周期 | 读取 session 和 ordered events |
| Invocation control | `Runner` / `InvocationContext` | 一次请求或恢复请求 | 由 invocation id、resume input 和事件推导 |
| Workflow scheduler | `Workflow` / `_LoopState` | 一次 workflow execution | 从 event history rehydrate |
| Node execution | `BaseNode` / agent | 节点调用周期 | branch、node path、task state 恢复 |
| Event fact | `SessionService` append path | 追加后长期存在 | replay、分页、SSE 投影 |
| State delta | current invocation → Event | 提交前可变 | 随 event append 成为 session state |
| Code execution | `CodeExecutor` / tool backend | invocation 或 tool 周期 | 依赖 executor 自身，不由 Runner 保证 |

这种分层有一个关键后果：`Runner` 负责驱动运行，但不是所有运行资源的 owner；`SessionService` 能恢复对话事实和 state，却不自动拥有外部进程、容器或代码执行资源。ADK 的恢复能力主要是“基于事件重新进入应用图”，而不是“接管一个已经运行的 coding workspace”。

## 八、Workflow 恢复状态机

ADK 的 workflow 可以抽象成：

```text
load session events
  → rehydrate branch/node executions
  → setup graph and dependencies
  → schedule ready nodes
  → node invokes model/tool/child agent
  → emit partial/non-partial events
  → append event and update state delta
  → join/retry/route/interrupt
  → continue or finalize invocation
```

当节点请求人工输入、工具确认或认证时，流程进入可恢复的 suspended 状态；下一次请求必须携带足够的 session、invocation、branch、node path 和 function call identity，才能继续正确节点。并发节点的完成顺序不一定等于图上的逻辑顺序，所以 replay 需要依赖 sequence barrier、node metadata 和已完成 execution，而不是简单重放 Python 调度顺序。

ADK 的恢复对象更接近“工作流图上的未完成节点”，而不是 coding-agent 中的单个 shell tool call。代码执行本身是否可恢复，取决于 `CodeExecutor` 和外部运行平台；Runner 的 resumability 不能自动推导出文件、进程或容器恢复。

## 九、ADK 的人工审批、失败与恢复

人工介入在 ADK 中通常表现为一种需要外部输入的 invocation/node 状态：

```text
node/model requests input
  → emit interrupt/request event
  → persist enough invocation + branch identity
  → external user/tool/auth response
  → resume Runner with session/invocation context
  → continue node or re-run according to node policy
```

失败需要区分三类：

- **应用编排失败**：node routing、workflow join、retry 或 branch recovery 失败；
- **模型/工具协议失败**：LLM response、function response、schema 或 auth 不合法；
- **执行后端失败**：CodeExecutor、artifact、外部服务或沙箱失败。

Event 可以记录前两类的运行事实，但不必然包含第三类执行环境的完整可恢复状态。尤其当代码已经修改文件、创建进程或产生外部资源后，invocation retry 可能重复副作用；ADK 的 workflow/event 恢复不能自动等价于 workspace rollback。需要外部 executor 提供幂等、隔离或 checkpoint 才能获得 coding-agent 所需的副作用治理。

## 十、ADK CodeExecutor 与 Coding Workspace 的差异

ADK 的 code execution 目标是让 Agent 在受控后端执行代码、计算或数据处理；本地 coding agent workspace 的目标则是持续维护一个用户可见、可审查、可回退的工程目录。两者差异如下：

| 维度 | ADK CodeExecutor | Coding-agent workspace |
| --- | --- | --- |
| 主要对象 | 一次代码执行请求 | 长期 repo/worktree identity |
| 状态 | 执行输出、artifact、error | 文件树、diff、checkpoint、环境与任务历史 |
| 生命周期 | invocation/tool 级 | session/task 级，可跨 turn |
| 安全边界 | executor、sandbox、credential | workspace trust、命令策略、文件权限、审批 |
| 恢复 | 重新调度 node/invocation | 继续进程、重建环境或回滚文件/对话 |
| 用户审计 | event/artifact | action、command、diff、approval、rollback |

因此不能因为 ADK 有 `CodeExecutor` 就把它等同于 Codex/Gemini 的 Environment。ADK 抽象的是“代码如何被某个 Agent 工具执行”；coding harness 抽象的是“一个长期工程任务在哪个可治理环境中持续执行”。ADK 可以通过 executor、artifact 和 plugin 组合出后者，但 v2.8 的核心模型仍然以 application/workflow 为中心。

## 十一、ADK 的设计原则

### 原则 1：App 定义应用，Runner 驱动调用

应用级 root agent、workflow、plugin、compaction 和 cache 配置属于 `App`；一次 user input、resume 或 live request 属于 Runner invocation。这样部署配置不会和某个 invocation 的临时队列混在一起。

### 原则 2：SessionService 抽象持久化，Agent 不直接管理存储

Agent/Workflow 通过 session context 读写 state 和 events，不依赖具体数据库。收益是 InMemory、数据库、云服务可替换；代价是恢复正确性需要严格依赖 event contract，而不是对象内存。

### 原则 3：Event 是应用运行的共同事实格式

用户消息、模型输出、工具调用、state delta、路由、pause、compaction、metrics 和错误都可以进入 Event。Runner 负责将 non-partial event 追加到 Session，partial event 只服务流式观察。

这让 replay、SSE、审计和工作流恢复共享语言；但 Event 不是自动的文件系统 checkpoint，也不是所有外部副作用的事务日志。

### 原则 4：Workflow 以图调度替代隐式 transfer

Agent 负责行为，Workflow 负责节点关系、并发、循环、条件、join 和恢复。图结构让多 Agent 应用的控制流显式化；代价是 branch、node path、sequence barrier、dynamic node 和 replay divergence 都成为必须治理的状态。

### 原则 5：恢复优先依赖事实重建，而不是保存调度器对象

`InvocationContext` 和 workflow loop state 是运行态；Session events 是跨请求依据。恢复时重新扫描事件并构造 recovered execution，避免把不可序列化的 Python scheduler 当作持久化格式。

### 原则 6：能力通过 Toolset、Plugin 和 Model capability 协商

最终 LLM request 是模型能力、工具声明、toolset processor、认证、插件和 context cache 的组合结果。工具声明与工具执行分离，code executor 与 Runner 分离；这支持不同模型和后端，但也要求明确 capability snapshot。

### 原则 7：人工输入是可恢复的控制状态

pause、tool confirmation、credential request 和 live resumption 不应被实现成 UI loading 的局部开关，而应带有 invocation、branch、node 和 function call identity。用户回复要回到原控制点。

### 原则 8：应用编排与副作用执行解耦

Workflow 可以决定“哪个节点运行”，CodeExecutor/Toolset 才决定“代码在哪里执行”。这使 ADK 适用于数据、业务流程和多 Agent 应用，但不会自动提供 coding-agent 所需的 workspace rollback、process adoption 或命令级审批。

### 原则 9：插件是跨生命周期的治理平面

Plugin callback 可以观察/修改 user message、model request、tool call、event、error、compaction 和 completion。它适合实现 logging、policy、metrics、cache 和企业集成；代价是插件可能影响多个生命周期边界，必须防止重复执行和状态泄漏。

## 十二、设计收益与代价

| 设计选择 | 收益 | 代价 |
| --- | --- | --- |
| App + Runner | 应用配置与调用解耦 | 需要区分全局与 invocation 状态 |
| SessionService | 存储后端可替换 | 恢复依赖事件语义 |
| Event + replay | 可观察、可恢复、可重放 | 外部副作用不自动原子 |
| Workflow graph | 条件、并发、循环、委派显式 | scheduler 和 branch 状态复杂 |
| Dynamic toolset | 模型/工具能力可协商 | request cache 与 capability snapshot 难管理 |
| Plugin plane | 横切治理统一 | callback 顺序、重复和隔离复杂 |
| CodeExecutor | 代码执行后端可替换 | 不等于长期 coding workspace |
| Resumability | pause/auth/HITL 可继续 | 需要 invocation、node、branch identity |

## 十三、ADK 作为 Coding Agent 研究对象的准确定位

ADK 最适合被理解为 **Agent application orchestration runtime**：它解决如何把多个 Agent、工具、人工输入、外部服务和持久事件组织成可恢复应用。Codex、Gemini CLI、Cline 等则更接近 **coding execution runtime**：它们把工作区、命令、文件变更、审批、模型上下文、取消和恢复收敛到一个长期工程任务。

两者共享 Event、Session、Tool、Model、Approval 和 Recovery 等概念，但中心问题不同：

- ADK 的首要问题是哪个节点在什么条件下运行，以及如何从事件恢复图状态；
- coding harness 的首要问题是模型提出的副作用如何在一个可信、可回退、可持续的工程环境中执行。

因此 ADK 的架构演进不能简单描述为“又一个 coding-agent harness”。更准确的结论是：ADK 提供了 coding harness 可以复用的应用编排、事件恢复和能力协商基础，但 workspace ownership、命令安全、文件回滚和宿主进程治理仍需由上层 coding product 补齐。

## 十四、v2.8 的最终架构判断

到 v2.8，ADK 已从 Agent/Runner/Session 的调用 SDK 演进为以 App、Workflow、Event、SessionService 和 resumability 为核心的应用 Runtime。其重大变化是把运行事实和图调度从一次性函数调用中分离出来，并允许人工输入、认证、工具、Live 通道和多 Agent 在同一事件模型下恢复。

但它没有因此自然变成 Codex 式 coding harness。ADK 的 CodeExecutor、ArtifactService、Toolset 和 Plugin 提供了代码执行所需的零件，真正的工程 workspace、环境快照、命令级审批、文件/对话联合 rollback 和长任务进程治理仍属于应用层或执行后端责任。这是 ADK 与 coding-agent runtime 的核心边界，也是本报告最重要的研究结论。
