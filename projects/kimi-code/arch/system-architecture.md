# Kimi Code 整体架构

> 结论：Kimi Code 是一个由多种产品入口、宿主适配层和 Agent Runtime 组成的系统。在当前分析版本中，它仍保留 legacy `agent-core`，同时以 `agent-core-v2` 建立按 `App → Workspace → Session → Agent` 分层的运行时。v2 的关键设计不是某个循环类，而是以 Scope 明确资源生命周期，以 Agent 聚合执行事实，再从事件和持久化记录构建 Transcript 等读取模型。

- 上游仓库：<https://github.com/MoonshotAI/kimi-code>
- 分析提交：`e22479a62eed9c3b78a67b313f4332c2c0ba9670`
- 最后复核：2026-08-20
- 可编辑架构图：[Kimi Code Overall Architecture](../diagrams/kimi-code-overall-architecture.excalidraw)
- 执行链细化：[Agent Loop Runtime](agent-loop-runtime.md)

## 视图边界

这张图回答的是“从产品入口到运行时、外部能力和状态系统，Kimi Code 如何组成一个整体”，而不是展开每个实际类或一次 Turn 的全部时序。当前提交同时存在两条引擎路径，因此图中保留了 legacy compatibility path；它是版本现状，不代表两套核心具有相同的长期架构地位。

## 1. 产品入口与宿主适配

Kimi Code 对外提供 CLI/TUI、Kimi Web、Node SDK/ACP，以及 Inspect/Vis 等开发与观察入口。入口本身不直接拥有 Agent 状态，而是通过两类宿主边界接入核心：

- `KimiHarness` / Node SDK 面向嵌入式和本地交互；CLI/TUI 默认仍创建 legacy harness，设置实验开关后改用 v2 harness。[源码：CLI 引擎选择](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/apps/kimi-code/src/cli/experimental-v2.ts#L1-L14) [源码：shell 启动](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/apps/kimi-code/src/cli/run-shell.ts#L67-L90)
- `kap-server` 是 Web/远程访问的 HTTP + WebSocket 宿主，负责认证、安全边界、路由、Core 装配和 Transcript 服务；`kimi web` 进入的是 v2 路径。[源码：服务入口](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/kap-server/src/start.ts#L1-L7) [源码：服务装配](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/kap-server/src/start.ts#L179-L258)

这层适配使同一个 Agent Runtime 可以服务交互终端、浏览器和程序化调用，同时把协议、认证和 UI 生命周期留在 Core 之外。

## 2. v2 Core：Scope 是主要结构

`agent-core-v2` 使用层级 Scope 组织依赖和生命周期，而不是让一个全局管理器持有全部能力。[源码：App bootstrap](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/app/bootstrap/bootstrap.ts#L152-L188)

| Scope | 高层职责 | 典型能力 |
| --- | --- | --- |
| App | 进程级装配与全局生命周期 | Core bootstrap、工作区入口、共享基础设施 |
| Workspace | 工作目录级信任与执行环境 | AGENTS/skills/profiles、MCP、文件系统、进程、Git、工具策略 |
| Session | 一次可恢复的会话边界 | 会话元数据、Agent registry、交互与任务、继承工作区能力 |
| Agent | 一条具体 Agent 执行流 | 消息队列、ContextMemory、LLMRequester、ToolExecutor、EventBus、Wire |

Workspace 采用按标识创建或复用的生命周期，并承载可被其 Session 共享的工作区能力。[源码：Workspace lifecycle](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/app/workspaceLifecycle/workspaceLifecycleService.ts#L83-L141) [测试：并发 materialization](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/test/app/workspaceLifecycle/workspaceLifecycle.test.ts#L372-L411)

Session 在 Workspace 下创建，可恢复、fork 和关闭；创建时将工作区资源注入会话边界。[源码：Session lifecycle](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts#L200-L290) [源码：Session resume](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts#L318-L358)

Agent 是实际执行聚合。Agent lifecycle 创建子 Scope、恢复或初始化 `Wire`、注册元数据，并激活工具能力。[源码：Agent lifecycle](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts#L115-L177)

## 3. Agent Runtime 与外部能力

Agent Scope 内部由队列驱动执行：上下文记忆准备模型输入，LLM requester 调用模型，响应中的工具请求进入 ToolExecutor，结果再回到 Wire 和后续模型轮次。详细的 Turn/工具循环见 [Agent Loop Runtime](agent-loop-runtime.md)，整体图只保留这些稳定职责。

工具执行依赖 Workspace 提供的受控环境，包括文件读写、进程/终端、Git、Web、MCP 以及用户交互。信任状态和工具策略位于执行边界之前，用于决定能力是否可用以及是否需要确认。模型调用则通过 provider 抽象连接 Moonshot、OpenAI-compatible、Anthropic-compatible 等后端，使模型协议与 Agent 编排解耦。

## 4. 持久化、恢复与读取模型

v2 的运行事实以 Agent 为聚合边界。`Wire` 接收 dispatch，先更新内存模型，再把记录追加到 journal，同时通过 Agent EventBus 发布实时事件；恢复时重放 `wire.jsonl` 重建状态。[源码：Wire record/restore](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/agent-core-v2/src/wire/wireService.ts#L105-L206)

因此 Storage 在图中不是简单的“会话数据库”，而包含几类不同用途的状态：

- workspace/session/agent 元数据和索引，用于定位生命周期对象；
- 每个 Agent 的 `wire.jsonl`，作为执行事实日志并支持恢复；
- settings、profiles、credentials 等 Kimi Home 持久状态，为运行时提供配置和身份信息。

Transcript 是 Wire 之上的读取模型，而不是另一份执行真相。在线时，它订阅 Agent EventBus 投影实时事件；冷启动或补历史时，它读取各 Agent 的 `wire.jsonl` 重建视图。两条路径最终汇合到同一个 REST/WebSocket 消费面。[测试：Transcript 实时与冷恢复](https://github.com/MoonshotAI/kimi-code/blob/e22479a62eed9c3b78a67b313f4332c2c0ba9670/packages/kap-server/test/transcript.test.ts#L372-L464)

## 5. 关键控制与数据流

1. 产品入口通过 SDK/harness 或 `kap-server` 建立 Workspace、Session 和 Agent。
2. App Scope 物化 Workspace；Workspace 再为 Session 提供信任、配置和执行能力。
3. Session 创建或恢复 Agent；Agent 以队列、上下文、模型请求和工具执行完成运行循环。
4. Wire 同步更新内存状态、追加持久记录并发布实时事件。
5. 恢复路径从持久记录重建 Agent；读取路径从实时事件或历史日志构建 Transcript。

## 6. 设计解读

- **多入口、少核心**：UI 和协议可以变化，运行时语义集中在 Core 与 Scope 生命周期内。
- **生命周期即依赖边界**：工作区能力不会被误当成 Agent 私有状态，会话和 Agent 也能够独立恢复与清理。
- **写模型与读模型分离**：Wire 保存执行事实，Transcript 针对展示和订阅组织数据。
- **兼容迁移显式化**：v1/v2 选择位于宿主适配层，避免把兼容逻辑扩散进 v2 的 Scope 模型。

## 未确认事项

- 本文结论来自固定提交的实现与测试阅读，未执行端到端运行实验；不能把测试覆盖等同于所有部署模式下的运行验证。
- 当前提交中 CLI/TUI 的 v2 仍由实验开关选择，而 Web 使用 v2。后续版本若完成默认引擎切换，应重新检查这张双路径图。
- 本文只描述仓库内可验证的组件关系，不推断外部托管服务的内部实现。
