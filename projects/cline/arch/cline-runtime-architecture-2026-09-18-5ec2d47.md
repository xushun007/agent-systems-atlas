---
title: Cline Runtime Architecture
snapshot_id: 2026-09-18.5ec2d47
reviewed_at: 2026-09-18
upstream_repository: https://github.com/cline/cline
upstream_commit: 5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa
upstream_commit_date: 2026-08-03
status: current
change_level: baseline
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/cline-runtime-architecture-2026-09-18-5ec2d47.excalidraw
---

# Cline Runtime Architecture

> 结论：Cline 当前 Runtime 不是由单一长驻 agent loop 构成，而是分成宿主 API、可替换的 RuntimeHost、跨用户轮次存活的 SessionRuntime，以及每次 run 新建的 AgentRuntime 四层。持久化、恢复、队列与 Hub 生命周期归 `@cline/core`；模型/工具循环归 `@cline/agents`；Hub/Remote 复用服务端的本地 Runtime，而不是复制一套循环。

可编辑架构图：[cline-runtime-architecture-2026-09-18-5ec2d47.excalidraw](../diagrams/cline-runtime-architecture-2026-09-18-5ec2d47.excalidraw)

## 视图边界

本视图回答：从 CLI、Connector、IDE 或 SDK 发起一次用户输入后，控制如何进入 Session、如何创建一次性的 AgentRuntime、如何调用模型和工具，以及状态、审批、恢复和 Hub 远程路径分别由谁拥有。

视图覆盖 `@cline/core`、`@cline/agents`、`@cline/llms` 与 CLI/Connector 接入；隐藏具体 UI 状态树、单个模型提供商协议细节和每种内置工具的实现。

术语必须分层理解：`RuntimeHost.runTurn` 表示一次用户输入；`AgentRuntime` 发出的 `turn-started` / `turn-finished` 表示同一 run 内一次 model/tool 迭代，二者不是同一个 “turn”。

## 与上一快照相比

这是该视图的首个版本化快照，`change_level` 为 `baseline`，没有上一快照可比较。

### 保持不变

- 不适用；后续复核将以本快照记录的边界和不变量为基线。

## 架构说明

### 1. 宿主入口与 RuntimeHost

`ClineCore.create()` 规范化宿主能力并选择 RuntimeHost；`start()`、`send()`、`abort()` 和 `subscribe()` 随后都委托给该 Host。Host 工厂支持 `local`、`hub`、`remote` 和 `auto`：本地模式构造 `LocalRuntimeHost`，Hub 模式连接或确保共享 Hub，Remote 模式要求远端 endpoint，而 `auto` 在不可连接时回退本地。[ClineCore.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/ClineCore.ts) · [host.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/host.ts) · [runtime-host.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/runtime-host.ts)

CLI 将终端内的 `askQuestion`、`submit` 和 `requestToolApproval` 作为 capabilities 交给 Core；同时订阅 AgentEvent、处理信号中止，并在退出时停止 Session 和释放 Core。这说明 CLI 是宿主适配层，不拥有 agent loop。[run-agent.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/runtime/run-agent.ts)

### 2. 跨轮次 Session 与单次运行 AgentRuntime

`LocalRuntimeHost` 负责 Session 的创建/恢复、用户输入排队、运行状态、持久化以及完成后的团队更新续跑。其内部的 `SessionRuntime` 跨多次用户输入保留 `ConversationStore`、`MessageBuilder`、loop/mistake trackers、订阅者与当前 abort 状态。[local-runtime-host.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/local-runtime-host.ts) · [session-runtime-orchestrator.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts)

关键生命周期边界是：`SessionRuntime.executeRunInternal()` 为每次 `run` / `continue` 调用 `createAgentRuntime()`，并把完整历史作为 initial messages 注入；运行结束后再用 Runtime 的最终消息替换 Session 的 ConversationStore。因此 Session 状态可以跨 run 存活，而 AgentRuntime 可以被重建，用于 OAuth 重试或重放。

### 3. Model / Tool 循环

`AgentRuntime.execute()` 在 `maxIterations` 边界内循环：调用 `model.stream()`，累积 assistant 输出和 tool calls；没有 tool call 时结束，否则执行工具、追加 tool-result messages，再进入下一次迭代。terminal lifecycle tool、abort、错误或迭代上限也会终止；context overflow 每个 run 只进行一次 compaction 后重试。[agent-runtime.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/agents/src/agent-runtime.ts)

工具执行前依次经过 hooks、启用策略和 auto-approve/人工审批判断；之后由 executor 或工具自身执行，再进入 afterTool hooks。`DefaultRuntimeBuilder` 负责组装内置工具、MCP、skills/rules、extensions、teams/subagents 和运行时 hooks，因此 AgentRuntime 消费的是组装后的能力集合，而不负责发现与持久化这些配置。[runtime-builder.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/runtime-builder.ts)

### 4. 队列、事件和兼容边界

交互式 Session 正在运行时，默认输入进入 queue；显式 `steer` 会获得更高优先级，并可在当前 AgentRuntime 下一次模型请求前被消费。`PendingPromptService` 还负责去重、删除、更新和失败重入队。[pending-prompt-service.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts)

AgentRuntime 的细粒度事件由 `RuntimeEventAdapter` 转换成现有宿主消费的 `AgentEvent`。这是一条兼容边界：内部 RuntimeEvent 与外部会话事件并未直接等同。[runtime-event-adapter.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/runtime-event-adapter.ts)

### 5. Hub / Remote 路径

`HubRuntimeHost.runTurn()` 把输入编码成 `run.start` 命令，经 `NodeHubClient` 的 WebSocket 发送；Hub server handler 再调用其持有的 `LocalRuntimeHost.runTurn()`，并发布运行事件。Session 支持 attach/detach 和按 Session 订阅。客户端本地的审批、工具执行器、hooks、compaction 等能力以 capability request/progress/response 回调，因此远程运行仍能调用宿主能力。[hub-runtime-host.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/runtime-host/hub-runtime-host.ts) · [run-handlers.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/server/handlers/run-handlers.ts) · [capability-handlers.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/server/handlers/capability-handlers.ts)

Connector 的 runtime turn 同时订阅流式事件并发送 Session 输入；如果响应没有 result，则按“已排队”处理，而不是视为失败。[runtime-turn.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/connectors/runtime-turn.ts)

### 6. 持久化与恢复

Core 持有 SQLite Session store，并保留 file service fallback；持久化服务管理 manifest、messages、compaction state 和子代理产物。Checkpoint 恢复可分别恢复对话与工作区；工作区操作由 Git checkpoint 实现，失败时执行回滚。[session-service.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/services/session-service.ts) · [persistence-service.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/services/persistence-service.ts) · [checkpoint-restore.ts](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/checkpoint-restore.ts)

## 验证依据

- 源码阅读：上述固定 commit 下的 `ClineCore`、RuntimeHost 工厂与三种 Host、`LocalRuntimeHost`、SessionRuntime orchestrator、`AgentRuntime`、runtime builder、pending prompt、event adapter、Hub server handlers、CLI 与 Connector 入口。
- 测试阅读：[`agent-runtime.test.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/agents/src/agent-runtime.test.ts)、[`session-runtime-orchestrator.test.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.test.ts)、[`local-runtime-host.test.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/local-runtime-host.test.ts)、[`host.test.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/host.test.ts)、[`hub-runtime-host.test.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/runtime-host/hub-runtime-host.test.ts) 和 checkpoint / prompt queue / connector 相关测试。
- 运行实验：未执行。上游 checkout 没有已安装依赖，因此本快照只声明源码与测试阅读结论，不把它表述为运行验证。

## 设计解读

以下是基于已验证实现的架构解读，而不是源码中的显式承诺：

- 将跨轮次状态留在 SessionRuntime、把 AgentRuntime 限定为单次 run，使恢复、重放和连接切换不必复用一个可能已污染的循环实例。
- RuntimeHost 抽象让本地与 Hub/Remote 共享 ClineCore API；Hub capability 回调则把“Runtime 所在位置”和“用户交互/宿主能力所在位置”解耦。
- RuntimeEventAdapter 表明项目正处于内部事件模型与既有 AgentEvent 消费者并存的迁移阶段。

## 未确认事项

- 未进行真实模型、MCP、Sandbox 或 Hub 多客户端运行实验，无法确认不同平台上的时序、超时和进程崩溃恢复表现。
- 上游仓库在本地为浅历史，本快照不对更早版本的职责迁移做历史归因。
- 图中的 IDE / SDK clients 是 RuntimeHost 的宿主类别汇总；本快照没有逐个展开 VS Code 与 JetBrains UI 内部实现。
