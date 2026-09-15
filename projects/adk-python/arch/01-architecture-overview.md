# ADK 架构总览

> **版本基线（v2.8.0）**：本文依据 Google ADK Python 官方 commit [`76a96e6221f1e2758a1ff82fde199cd079e9c654`](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654) 的源码整理，审阅日期为 2026-09-15。发布变化以 [`v2.8.0 CHANGELOG`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L1-L171) 为准。本文描述的是 v2.8.0 当前实现，不代表早期 1.x 的 Agent-only 结构。

## v2.8.0 架构结论

ADK v2.8.0 的核心不是 `Runner` 直接驱动一个 Agent，而是由 `App` 装配 root node、全局插件和恢复/缓存策略，`Runner` 创建 `InvocationContext`，再由 `BaseNode`/`Workflow` 产生 Event。Session 中持久化的是 Event 和 state；Workflow 的调度状态在恢复时从事件历史重建。

```text
App (root node + plugins + cache/resumability policy)
  └── Runner (services + lifecycle + event persistence)
        └── InvocationContext (one invocation, queue, branch, resume)
              └── BaseNode / Workflow / LlmAgent
                    └── LLM step ↔ tools/code executor
                          └── Event → SessionService → Session history
```

关键源码：[`App`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/apps/app.py)、[`Runner`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py)、[`InvocationContext`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py)、[`Workflow`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_workflow.py)。

## 公共 API 层 (5 个导出符号)

```
google.adk.__init__ 导出:
  ├── Agent        → LlmAgent 的别名，最常用的 agent 类型
  ├── Context      → 节点级执行上下文 (1:1 映射到节点)
  ├── Event        → 事件数据模型 (消息、工具调用、响应等)
  ├── Runner       → 状态执行引擎，编排 agent 生命周期
  └── Workflow     → 图编排引擎，支持多节点工作流
```

## 顶层架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         App                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Runner                                  │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  InvocationContext (单次调用级单例)                   │  │  │
│  │  │  ├── session_service     (会话存储)                   │  │  │
│  │  │  ├── memory_service      (长期记忆)                   │  │  │
│  │  │  ├── artifact_service    (文件产物)                   │  │  │
│  │  │  ├── credential_service  (认证凭据)                   │  │  │
│  │  │  ├── plugin_manager      (插件系统)                   │  │  │
│  │  │  └── _event_queue        (异步事件队列)               │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                           │                                │  │
│  │            ┌──────────────┴──────────────┐                 │  │
│  │            ▼                             ▼                 │  │
│  │   ┌────────────────┐        ┌──────────────────────┐       │  │
│  │   │ 旧 BaseAgent   │        │ NodeRunner (新路径)  │       │  │
│  │   │ _exec_with_    │        │ 驱动 node.run()       │       │  │
│  │   │ plugin()       │        │ 事件 enrich/persist   │       │  │
│  │   └────────────────┘        └──────────┬───────────┘       │  │
│  │                                        │                   │  │
│  │                     ┌──────────────────┴──────────────┐    │  │
│  │                     ▼                                 ▼    │  │
│  │          ┌────────────────────┐          ┌────────────────┐ │  │
│  │          │ Workflow (图引擎)  │          │ LlmAgent 直调  │ │  │
│  │          │ 边遍历/节点排序    │          │ mode='chat'    │ │  │
│  │          │ 条件路由/并行      │          │ 单次 LLM 调用  │ │  │
│  │          └────────────────────┘          └────────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 核心模块分层

```
┌─────────────────────────────────────────────────────────────────┐
│  应用层 (Application)                                           │
│  App · agent.py · run_config · cli · api_server · dev_server    │
├─────────────────────────────────────────────────────────────────┤
│  编排层 (Orchestration)                                         │
│  Runner · InvocationContext · PluginManager                     │
├─────────────────────────────────────────────────────────────────┤
│  Agent 层 (Agents)                                              │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│  │ LlmAgent    │ │LoopAgent │ │SeqAgent   │ │ ParallelAgent │  │
│  │ (默认/常用) │ │(循环)    │ │(顺序编排) │ │ (并行编排)    │  │
│  └─────────────┘ └──────────┘ └───────────┘ └───────────────┘  │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│  │LangGraph    │ │Remote    │ │ MCP Agent │ │ (自定义)      │  │
│  │Agent        │ │A2AAgent  │ │           │ │               │  │
│  └─────────────┘ └──────────┘ └───────────┘ └───────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Workflow 层 (Graph Engine)                                     │
│  Workflow → BaseNode → [FunctionNode, ToolNode,               │
│              LlmAgentWrapper, JoinNode]                         │
│  Graph · Edge · Trigger · NodeState · NodeRunner               │
│  DynamicNodeScheduler · ParallelWorker                         │
├─────────────────────────────────────────────────────────────────┤
│  模型层 (Models / LLM)                                          │
│  BaseLlm · GeminiLlmConnection · AnthropicLlm · LiteLlm        │
│  LlmRequest · LlmResponse · Registry                           │
├─────────────────────────────────────────────────────────────────┤
│  工具层 (Tools)                                                 │
│  BaseTool · FunctionTool · AgentTool · TransferToAgentTool     │
│  BashTool · GoogleSearchTool · LoadWebPage · SkillToolset      │
│  BaseToolset · ToolboxToolset · CrewaiToolset · LangchainTool  │
├─────────────────────────────────────────────────────────────────┤
│  基础设施层 (Infrastructure)                                    │
│  ┌─────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Session     │ │ Memory     │ │Artifact  │ │ Credential   │  │
│  │ Service     │ │ Service    │ │Service   │ │ Service      │  │
│  │ (对话存储)  │ │ (长期记忆) │ │(文件管理)│ │(认证凭据)    │  │
│  └─────────────┘ └────────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  横切关注点 (Cross-cutting)                                     │
│  Events · Plugins · Telemetry · Features · CodeExecutors       │
│  Evaluation · Optimization · Skills · Auth                     │
└─────────────────────────────────────────────────────────────────┘
```

## Agent 继承层次

```
BaseAgent (ABC)
├── run_async()           ← 旧接口，通过 plugin 执行
├── run_in_new_context()  ← 新接口，创建独立 Context
├── before_agent / after_agent 回调
│
├── LlmAgent (Agent)      ← 最常用，LLM 驱动的 agent
│   ├── model: str
│   ├── instruction: str
│   ├── tools: list
│   ├── planner: BasePlanner
│   └── code_executor: BaseCodeExecutor
│
├── LoopAgent             ← 循环执行子 agent 直到 exit_loop_tool
│
├── SequentialAgent        ← 按顺序执行子 agents
│
├── ParallelAgent          ← 并行执行子 agents
│
├── LangGraphAgent         ← 包装 LangGraph 图
│
└── RemoteA2aAgent         ← 远程 A2A 协议 agent
```

## Workflow 节点层次

```
BaseNode (ABC)
├── _run_impl() → AsyncGenerator[Event, None]
│
├── Workflow         ← 图编排 (START → 边 → 节点 → END)
│   ├── Graph        ← 有向图定义
│   ├── Edge         ← 条件/无条件边
│   └── Trigger      ← 触发条件
│
├── FunctionNode     ← 执行 Python 函数
├── ToolNode         ← 执行工具调用
├── LlmAgentWrapper  ← 将 LlmAgent 包装为 BaseNode
└── JoinNode         ← 多分支汇聚点
```

## 事件流 (一次调用的生命周期)

```
用户输入
    │
    ▼
Runner.run_async()
    │
    ├── 1. 创建 InvocationContext (session, services, event_queue)
    │
    ├── 2. 加载 session 历史事件 (context window)
    │
    ├── 3. 创建 RequestInput Event → append_event()
    │
    ├── 4. 进入执行路径:
    │      LlmAgent → _run_node_async()
    │      Workflow → NodeRunner → 遍历图
    │
    ├── 5. 请求管道处理 (request processors):
    │      basic → instructions → contents → code_execution
    │
    ├── 6. LLM 调用 (BaseLlm.run_async())
    │      ├── LlmRequest → LlmResponse
    │      └── 流式返回 Content chunks
    │
    ├── 7. 响应管道处理 (response processors):
    │      nl_planning → code_execution
    │
    ├── 8. 工具调用循环 (如有):
    │      ToolNode → 执行工具 → FunctionResponse → 回给 LLM
    │
    ├── 9. Event 通过 event_queue 流式返回给 Runner
    │
    └── 10. done_sentinel → Runner 消费完毕 → 返回 AsyncGenerator
              │
              ▼
         用户收到流式响应
```

## 状态存储架构

```
Session.state (dict) 按前缀分治:

  "locale": "en-US"          → sessions 表      (session 级)
  "app:theme": "dark"        → app_states 表    (app 全局)
  "user:name": "Alice"       → user_states 表   (用户级)
  "temp:draft": "..."        → 仅内存，不持久   (临时)

存储实现:
  BaseSessionService (ABC)
  ├── SqliteSessionService     ← aiosqlite + JSON，单文件
  ├── InMemorySessionService   ← 纯内存 dict
  ├── DatabaseSessionService   ← SQLAlchemy 多引擎
  └── VertexAiSessionService   ← GCP Vertex AI
```

## Plugin 系统

```
PluginManager
├── before_agent()   ← agent 执行前钩子
├── after_agent()    ← agent 执行后钩子
├── around_llm_call() ← LLM 调用环绕
│
内置插件:
  ├── AutoTracingPlugin        ← 自动追踪
  ├── ContextFilterPlugin      ← 上下文过滤
  ├── DebugLoggingPlugin       ← 调试日志
  ├── GlobalInstructionPlugin  ← 全局指令
  ├── LoggingPlugin            ← 标准日志
  ├── MultimodalToolResultsPlugin ← 多模态工具结果
  ├── ReflectRetryToolPlugin   ← 工具失败重试
  └── SaveFilesAsArtifactsPlugin ← 文件保存为产物
```

## 工具系统

```
BaseTool (ABC)
├── run() / run_async()       ← 执行逻辑
├── get_declaration()          ← OpenAPI schema
│
├── FunctionTool              ← 包装 Python 函数
├── AgentTool                 ← 调用子 agent
├── TransferToAgentTool       ← 转移控制权到子 agent
├── BashTool                  ← 执行 shell 命令
├── GoogleSearchTool          ← Google 搜索
├── LoadWebPage               ← 加载网页内容
├── GetUserChoiceTool         ← 用户确认
├── ExitLoopTool              ← 退出循环
├── SkillToolset              ← 技能工具集
└── ...

BaseToolset (ABC)
├── ToolboxToolset            ← Google Toolbox
├── CrewaiToolset             ← CrewAI 工具
└── LangchainToolset          ← LangChain 工具
```

## 关键设计决策

| 决策 | 内容 | 原因 |
|------|------|------|
| Runner/NodeRunner 分离 | Runner 管生命周期，NodeRunner 驱动 BaseNode，Workflow 管图调度 | 并发、嵌套 workflow 和事件汇聚分层 |
| Event 作为唯一数据流 | 所有交互通过 Event 传递 | 可持久化、可重放、可评估 |
| Context 与 node path/branch 结合 | Context 共享 invocation 服务，但携带当前 node、branch、isolation scope | 隔离可见事件并支持恢复 |
| InvocationContext 单例 | 一次调用一个实例 | 共享服务和事件队列 |
| 状态前缀分治 | app:/user:/temp:/session | 不同 scope 不同生命周期 |
| Plugin 钩子系统 | before/after/around | 横切关注点解耦 |
| Agent 与 Workflow 并存 | LlmAgent 保持对话/任务语义，BaseNode/Workflow 承载图调度 | 兼容旧 Agent API，同时迁移到 2.0 图 Runtime |

## v2.8.0 版本记录

相对于 2.0 GA，v2.8.0 的变化主要是 Runtime 硬化而不是新增一套顶层架构：

- `Workflow` 成为推荐的图编排抽象，`SequentialAgent`/`ParallelAgent` 仍可用但已逐步转为兼容路径；
- resumability 通过事件重建、branch/isolation、START/JoinNode、node auth 和 cancellation 继续收敛；
- `App` 将 plugin、compaction、context cache 和 resumability 提升为应用级配置；
- model capability、动态 toolset、MCP/A2A、Live resumption 与 telemetry 接入统一 Runtime；
- 2.8.0 重点修复 duplicate execution、OAuth prompt、synthetic user event、contextvars 泄漏和 O(n²) rehydration。

可追溯依据：官方 [`v2.8.0 CHANGELOG`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L1-L171)、[`Workflow`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_workflow.py)、[`Event`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/events/event.py)。
