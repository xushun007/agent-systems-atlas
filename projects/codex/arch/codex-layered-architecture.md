# Codex 分层架构

## 结论

Codex 可以按稳定职责划分为六层，但分层本身不是架构。真正决定系统行为的是跨组件的五组关系：入口适配、会话编排、模型采样、工具执行闭环，以及状态恢复。

本图同时表达“组件属于哪一层”和“组件之间如何协作”。它不是 Cargo crate 依赖图，也不展开一次 Turn 的完整时序；它回答的是：请求由哪个入口进入、由谁管理生命周期、如何驱动模型和工具、结果如何回到 Context，以及哪些状态需要持久化。

分析基线为 commit `7750465934d97dd3cbcb3b1655d2f622744010d3`。

## 架构图

- 可编辑源文件：[codex-layered-architecture.excalidraw](codex-layered-architecture.excalidraw)
- 全局关系视图：[codex-global-architecture.excalidraw](codex-global-architecture.excalidraw)
- Runtime 执行链与版本入口：[Codex Runtime 架构](codex-runtime-architecture.md)

图中箭头按关系着色：蓝/青表示入口与协议，橙色表示 Runtime 控制，红色表示模型链，绿色表示工具执行闭环，紫色表示扩展和策略，深绿色表示状态与配置，灰色表示平台安全边界。双向箭头表示该接口同时承载请求与反馈。

## 关键组件关系

### 入口与协议汇聚

不同产品入口不会各自实现 Agent Runtime：

```text
Terminal / SDK / IDE / MCP Client
  → CLI、Exec JSONL、App Server、MCP Server
  ↔ Protocol Boundary
  → ThreadManager / Interaction Gateway
```

`codex-protocol` 和 `codex-app-server-protocol` 构成稳定边界，使 TUI、Exec、IDE 和 SDK 能共享同一套 Session 与 Turn 语义。

### 会话与 Turn 控制链

```text
ThreadManager ↔ Session
  → Submission Loop ↔ Turn Loop
  → Event Stream → Protocol Boundary → Client
```

`ThreadManager` 负责线程创建、恢复、fork 和关闭；`Session` 持有 Runner 与生命周期状态；`Submission Loop` 串行消费 Op，并驱动一次或多次 Turn。Approval 或用户输入通过 `Interaction Gateway` 暂停并恢复这条控制链。

### 模型调用链

```text
Context ↔ Turn Loop ↔ Model Client ↔ Model Provider
```

Context 提供增量历史、Prompt 和 Compaction 结果；Turn Loop 决定何时继续采样；Model Client 负责请求构建、流式响应和重试；Provider 位于基础设施边界之外。模型输出中的文本和工具调用继续由 Turn Loop 消费。

### 工具执行闭环

```text
Turn Loop
  ↔ Tool Registry / Router
  ↔ Approval / ExecPolicy
  → Sandbox / Execution
  ↔ Workspace / Git
  → Observation
  → Context
  → 下一次 Turn
```

工具“可被发现”和“允许被执行”是两件事。Skills、MCP、Connectors 等负责贡献或注册能力；Router 负责分派；Approval 与 ExecPolicy 决定是否授权；实际副作用落在 Sandbox 和 Workspace 边界。执行结果作为 Observation 追加到 Context，闭合 ReAct 循环。

### 扩展与状态关系

```text
AGENTS.md / Skills / Plugins → Context
Hooks ↔ Turn Loop
MCP / Domain Capabilities → Tool Router
Session ↔ Persistence
Config / Auth → Session
```

扩展层既能影响 Prompt 和可用工具，也能在生命周期边界插入行为，但不应绕过 Runtime 的策略检查。Session 的可恢复状态写入 Rollout、State DB 或 Thread Store；配置与凭据只提供运行参数，不代替会话历史。

## 第一层：产品与客户端

面向最终用户或集成方，负责输入、展示和交互：

- TUI 与顶层 CLI；
- `codex exec` 和 `codex review`；
- IDE、Desktop 等富客户端；
- TypeScript/Python SDK；
- Codex MCP Server。

这一层不应重新实现 Session、Turn 或工具状态机。

## 第二层：接口与协议

把不同产品入口转换成稳定协议：

- `codex-cli` 命令路由；
- `app-server` JSON-RPC v2；
- Exec JSONL 事件流；
- App Server transport；
- `codex-protocol` 与 `codex-app-server-protocol`。

产品形态变化应该优先停留在这一层之上，避免渗入 Core Runtime。

## 第三层：应用编排

管理长生命周期对象和客户端交互：

- ThreadManager 与 Session 生命周期；
- Submission/Op 串行处理；
- Approval 和用户交互；
- Event 分发；
- Thread 创建、恢复、fork 和关闭。

这一层决定“哪个任务何时运行”，并把状态变化发布到 Event Stream；单次 Turn 内的推理和工具闭环属于下一层。

## 第四层：Agent Core

实现 Agent 的核心执行语义：

- Turn Loop（ReAct）；
- Context 增量构建与 Compaction；
- Model Request；
- Tool Registry 和 Router；
- Observation 回写、Follow-up 与终止判断。

这部分的详细机制见 [Codex Runtime 架构](codex-runtime-architecture.md)。

## 第五层：能力与策略

向 Core 提供可组合能力和约束：

- `AGENTS.md` 与 Skills；
- Plugins 与 Hooks；
- MCP 与 Connectors；
- Approval、Exec Policy 和网络策略；
- Memories、Web Search、Image Generation 与协作能力。

能力注册不等于执行授权。能力先进入 Context 或 Tool Router，实际工具调用再经过 Approval / ExecPolicy 与基础设施层。

## 第六层：基础设施

提供进程外部和持久化能力：

- OpenAI、本地 OSS 等 Model Provider；
- macOS/Linux/Windows 沙箱、PTY 与网络代理；
- Workspace、文件系统和 Git；
- Rollout、State DB 与 Thread Store；
- Config、Auth、Secrets、Telemetry。

## 分层约束

1. 产品层通过 Protocol Boundary 进入系统，不直接操作 Core 内部状态。
2. App Server、Exec 和 MCP Server 共享 Session 与 Turn 语义，不复制第二套 Agent Loop。
3. ThreadManager 管生命周期，Submission Loop 管任务串行化，Turn Loop 管单次 Agent 推理。
4. Core 通过 Context Contributions、Hooks 和 Tool Registry 使用扩展能力。
5. 工具发现、工具授权和工具执行分别由 Router、Policy 与 Sandbox 承担。
6. 每次工具结果必须经 Observation 回写 Context，才能参与下一轮推理。
7. 可回放历史、线程索引和配置凭据使用不同存储职责。

## 未确认事项

- 该分层是基于职责与主要依赖归纳，不保证所有辅助 crate 都只依赖相邻层。
- 本次未用 Cargo 依赖图检查全部 workspace crate 的反向依赖。
- IDE/Desktop 的部署组合可能让部分适配组件运行在独立进程，但不改变逻辑分层。
