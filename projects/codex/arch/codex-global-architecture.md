# Codex 项目全局架构

## 结论

Codex 不是一个单体 CLI，而是围绕 `codex-core` 组织的一组可组合前端、协议、扩展和执行基础设施：

- TUI、`codex exec/review`、IDE/Desktop 客户端及 SDK 通过不同适配层进入同一个 Thread/Session Runtime。
- `app-server` 是面向富客户端的 JSON-RPC 边界；TypeScript SDK 主要封装 `codex exec --experimental-json`，Python SDK 则通过 stdio 驱动 `codex app-server`。
- `codex-core` 负责 Thread/Session、Submission、Turn、上下文、模型请求和工具调度；前端不应复制这些状态机。
- Skills、Plugins、MCP、Connectors、Hooks、Memories 等能力通过扩展与服务平面进入 Core，而不是成为独立的第二套 Agent Loop。
- 工具执行先经过路由、审批与策略，再进入平台沙箱；工作区文件和本地进程始终位于这条安全边界之后。
- Rollout、State DB 与 Thread Store 分别承担可回放历史、索引状态和线程发现/恢复，不能视为一个抽象的“数据库”。

本分析以 commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 为基线，来自源码和 crate 依赖关系阅读，未执行端到端运行实验。

## 架构图

- 可编辑源文件：[codex-global-architecture.excalidraw](codex-global-architecture.excalidraw)
- 分层职责视图：[codex-layered-architecture.excalidraw](codex-layered-architecture.excalidraw)
- Runtime 细节：[codex-runtime-architecture.excalidraw](codex-runtime-architecture.excalidraw)

图中实线表示主要请求或执行路径，紫色虚线表示扩展贡献，青色双向线表示加载与持久化。

## 1. 使用入口与适配层

Codex 提供多种入口，但它们承担的是交互和协议适配，而不是各自实现 Agent Runtime：

- `codex-rs/tui`：交互式终端界面。
- `codex-rs/exec`：非交互执行和 Review 输出。
- `codex-rs/cli`：顶层命令路由，组合 TUI、Exec、App Server、MCP Server、Cloud 等子命令。
- `codex-rs/app-server`：面向 IDE、Desktop 和其他富客户端的 JSON-RPC 服务。
- `sdk/typescript`：启动 `codex exec --experimental-json` 并消费 JSONL 事件。
- `sdk/python`：启动 `codex app-server --listen stdio://` 并使用生成的 v2 类型。

这些入口最终都把用户操作转换成 Core 能理解的 Thread、Turn、Submission、Approval 和 Event。

## 2. 协议边界

Codex 有两类重要协议：

1. `codex-protocol` 定义 Core 内外共享的 `Op`、Event、配置和工具数据结构。
2. `codex-app-server-protocol` 定义富客户端使用的 JSON-RPC v2 请求、响应和通知，并将 Core 事件映射成稳定的客户端接口。

`app-server` 不是 Core 的替代品。它持有客户端连接、Thread API、通知和审批交互，然后委托 `codex-core` 执行。

## 3. Core Runtime

`codex-core` 是全局架构中心，主要承担：

- Thread/Session 创建、恢复和生命周期；
- Submission 串行处理与控制操作；
- Turn Loop、模型采样和 follow-up 判断；
- 上下文增量构建与压缩；
- 工具注册、路由、审批和执行协调；
- Rollout/Event 记录与状态更新。

详细执行链见 [Codex Runtime 架构](codex-runtime-architecture.md)。

工具从装配、模型暴露到审批、沙箱执行和结果回写的完整机制，见 [Codex 工具系统](../mechanisms/tool-system.md)。

## 4. 扩展与服务平面

扩展能力通过明确的注册、发现或协议边界进入 Core：

- Skills 与 `AGENTS.md` 提供任务工作流和工作区指令；
- Plugins 打包 Skills、工具、MCP 和其他贡献；
- MCP 与 Connectors 接入外部工具和授权数据；
- Hooks 在生命周期边界执行策略或自动化；
- Memories、Web Search、Image Generation、Collaboration 等扩展提供领域能力。

这部分决定 Agent “能看到什么、能调用什么”，但执行权限仍由审批、策略和沙箱控制。

## 5. 执行与安全边界

模型产生工具调用后，Core 通过 Tool Router 进入执行管线：

1. 解析工具与参数；
2. 应用 Approval、Exec Policy 和网络策略；
3. 选择平台执行器与沙箱；
4. 执行 Shell、文件操作、`apply_patch`、MCP 或用户交互；
5. 将结果作为 Observation 返回 Turn Loop。

平台层由 macOS Seatbelt、Linux sandbox/bwrap/Landlock、Windows sandbox、网络代理和进程加固等组件组成。沙箱是工具执行边界，而不是模型或 Session 的替代运行时。

## 6. 模型与外部后端

`codex-model-provider`、`codex-api` 和相关客户端把 Core 请求映射到模型后端，包括 OpenAI Responses/ChatGPT 后端和本地 OSS Provider。Cloud Tasks、MCP Servers 与 Connectors 属于外部服务，但进入 Core 的协议和权限路径不同，图中因此分开表达。

## 7. 状态与恢复

- Rollout JSONL 保存对话和事件历史，是恢复与 fork 的可回放事实来源。
- State DB 保存线程元数据、索引和运行状态。
- Thread Store 组合 Rollout 与 State，提供线程发现、读取、恢复和修复。
- `config.toml`、profiles、secrets 与 keyring 提供配置、身份和凭据。

## 主要源码索引

- [`codex-rs/cli`](../../../../codex/codex-rs/cli)
- [`codex-rs/tui`](../../../../codex/codex-rs/tui)
- [`codex-rs/exec`](../../../../codex/codex-rs/exec)
- [`codex-rs/app-server`](../../../../codex/codex-rs/app-server)
- [`codex-rs/app-server-protocol`](../../../../codex/codex-rs/app-server-protocol)
- [`codex-rs/core`](../../../../codex/codex-rs/core)
- [`codex-rs/tools`](../../../../codex/codex-rs/tools)
- [`codex-rs/sandboxing`](../../../../codex/codex-rs/sandboxing)
- [`codex-rs/model-provider`](../../../../codex/codex-rs/model-provider)
- [`codex-rs/rollout`](../../../../codex/codex-rs/rollout)
- [`codex-rs/state`](../../../../codex/codex-rs/state)
- [`codex-rs/thread-store`](../../../../codex/codex-rs/thread-store)
- [`sdk/typescript`](../../../../codex/sdk/typescript)
- [`sdk/python`](../../../../codex/sdk/python)

## 未确认事项

- 本次未运行 IDE/Desktop 客户端，富客户端与 `app-server` 的具体部署拓扑仅按协议和依赖关系归纳。
- Cloud Tasks、Connectors 和本地 OSS Provider 的认证、重连与失败恢复未做运行验证。
- 图按稳定职责分组，没有逐一展示 Cargo workspace 中的所有辅助 crate。
