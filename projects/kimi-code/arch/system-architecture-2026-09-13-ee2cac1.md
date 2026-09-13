---
title: Kimi Code 整体架构
snapshot_id: 2026-09-13.ee2cac1
reviewed_at: 2026-09-13
upstream_repository: https://github.com/MoonshotAI/kimi-code
upstream_commit: ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd
upstream_commit_date: 2026-09-12
previous_snapshot: 2026-08-20.e22479a
status: current
change_level: major
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/system-architecture-2026-09-13-ee2cac1.excalidraw
---

# Kimi Code 整体架构

> 结论：Kimi Code 已从 v1/v2 双引擎迁移态收敛为一个由 `agent-core-v2` 承载的 Core。产品入口经 SDK 或 `kap-server` 进入同一运行时；Core 继续以 `App → Workspace → Session → Agent` 管理生命周期，而 Agent 内部改由事件溯源状态与状态机执行。整体设计的主轴因此更清晰：**多宿主、单核心、分层 Scope、事件化执行、可重建读取模型**。

- 可编辑架构图：[system-architecture-2026-09-13-ee2cac1.excalidraw](../diagrams/system-architecture-2026-09-13-ee2cac1.excalidraw)
- 执行链细化：[Agent Loop Runtime](agent-loop-runtime-2026-09-13-ee2cac1.md)
- 版本变化：[整体架构演进索引](system-architecture-history.md)

## 视图边界

本视图回答 Kimi Code 从产品入口、宿主边界、Core Scope、执行能力到持久化/读取模型如何组成一个整体。它不展开 Turn 内部状态、审批细节、上下文压缩策略或 Tower/Swarm 协作协议；这些能力只在所属层次中出现。

## 与上一快照相比

### 删除

- legacy `packages/agent-core` 已从仓库移除，旧图中的 compatibility path 不再成立。
- CLI/TUI 不再根据实验开关选择两代 harness；[`run-shell.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/apps/kimi-code/src/cli/run-shell.ts#L65-L86) 直接调用唯一的 `createKimiHarness()`。

### 职责迁移

- SDK 公共外观仍叫 `KimiHarness`，但 [`createKimiHarness()`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/node-sdk/src/sdk-rpc-client-v2.ts#L2728-L2746) 直接装配 v2 RPC client；“兼容”成为 API/协议边缘职责，而不是第二套 Runtime。
- Agent Loop 从 `StepRequestQueue` 和 continuation aspects 迁移到 `AgentLoopService` 门面后的 Agent/Turn 状态机，详见 [Runtime 快照](agent-loop-runtime-2026-09-13-ee2cac1.md)。
- Agent Scope 的 replayable state 由 `EventDispatcher` 通过 Wire 事件重建；状态机内部另有 machine-local event store，二者由 loop facade 的投影适配连接，不能视为同一份持久状态。

### 新增或增强

- `kap-server` 增加 flat entity message protocol v3，同时在边缘保留 REST、WebSocket 与 v1 投影。
- Session/search index 与 Minidb 读取基础设施已从实验特性转为常规能力，并可在存储异常后从 journal 重建。
- MCP 配置、registry、connection 与 OAuth 被组织成统一管理面；远程控制、运行时开关、检查流和 Session 删除强化了 server host。

### 保持不变

- `App → Workspace → Session → Agent` 仍是依赖和生命周期的主结构。
- Workspace 是工作目录、信任与执行能力边界；Session 是可恢复会话边界；Agent 是实际执行聚合。
- 产品协议与 UI 生命周期留在宿主侧，模型与工具编排留在 Core。
- 执行写模型与 UI/搜索读取模型分离，恢复依赖持久记录而不是前端状态。

## 1. 产品入口与宿主边界

Kimi Code 的入口可归成两类：

- CLI/TUI、Node SDK、ACP 等本地或嵌入式入口通过 `KimiHarness` 使用 Core。
- Kimi Web、Remote Control、Inspect/Debug 等网络入口通过 `kap-server` 的 REST/WebSocket 边界使用 Core。

二者共享相同的 v2 Session/Agent 语义，但承担不同宿主责任：SDK 适配进程内 API 与兼容外观；`kap-server` 额外处理认证、连接、订阅、协议投影、搜索和远程访问。这个边界让 UI/传输协议可以演进，而不改变 Agent Runtime 的所有权模型。

## 2. Core：Scope 是整体骨架

`agent-core-v2` 通过分层 Scope 约束服务的所有权和释放时机。高层职责如下：

| Scope | 拥有的稳定职责 | 代表能力 |
| --- | --- | --- |
| App | 进程级装配、全局目录与控制面 | bootstrap、配置、provider catalog、MCP management、session index |
| Workspace | 工作目录级资源与安全边界 | workspace trust、文件/进程/Git、skills/profiles、MCP handle |
| Session | 可恢复的会话与 Agent 容器 | session lifecycle、agent registry、任务/交互、fork/close |
| Agent | 一条具体执行流及其状态 | prompt lifecycle、loop facade/machines、context、LLM、tools、events/state |

App bootstrap 注册 Scope 与特性装配；Session lifecycle 在 Workspace 下创建、恢复和 fork Session；Agent lifecycle 再创建 Agent 子 Scope 并装配执行服务。[`bootstrap.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/app/bootstrap/bootstrap.ts) [`sessionLifecycleService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts) [`agentLifecycleService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts)

这套分层不是目录分类：它决定某项能力能否被多个 Session 共享、某段状态是否随 Agent 销毁，以及恢复时从哪一层重新物化对象。

## 3. Agent Runtime 与执行能力

Agent Scope 将 prompt admission、Agent loop、上下文、LLM requester、tool executor、权限、压缩、通知和事件状态组合成一个执行聚合。`AgentLoopService` 现在是外部门面，实际控制由 `MachineEngine` 内的 Agent Machine 与嵌套 Turn Machine完成。[`loopService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/loopService.ts#L101-L258) [`engine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/machine/engine.ts)

工具并非 Agent 私有的任意系统调用。它们经 Workspace 提供的文件、进程、Git、Web、MCP 等执行能力，并叠加信任、权限、调度、Abort 和结果预算。LLM requester 则通过 provider catalog 与协议 traits 隔离具体模型后端。Tower、Swarm、goal、skills 和 hooks 作为 feature/service 组合到这些稳定边界，不需要成为整体图的第二条主干。

## 4. 持久化、恢复与读取模型

当前存储可以从职责上分为三层：

1. **事实日志**：`WireService` 把 Agent 执行事实写入 append log；`EventDispatcher` 在 restore 阶段读取 Wire，并把 durable events fold 到 replayable state 与 runtime participants。[`wireService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/wire/wireService.ts#L37-L105) [`eventDispatcherService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/state/eventDispatcherService.ts#L255-L314)
2. **生命周期元数据与索引**：workspace/session/agent 元数据、session index、search index 和 Minidb 负责定位、列表和查询；它们是可修复/可重建的读取基础设施，而不是执行真相。
3. **面向产品的读取模型**：Transcript 与 entity messages 把实时 Core events 和冷态 Wire records 投影成 UI/REST/WS 可消费的表示。[`coreBinding.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/kap-server/src/services/transcript/coreBinding.ts) [`wireRecords.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/kap-server/src/services/transcript/wireRecords.ts)

因此“record / restore”在图中是存储与 Runtime 的双向关系；事件流向宿主则是观察和投影关系。两者不能合并成同一种箭头语义。

## 5. 关键控制与数据流

1. 产品入口经 `KimiHarness` 或 `kap-server` 请求创建/恢复 Workspace、Session 和 Agent。
2. 分层 Scope 物化对应资源，并把 Workspace 执行能力注入 Session/Agent。
3. Prompt 经 Agent Loop 门面进入状态机；Turn 在 LLM 与工具之间迭代。
4. Agent 事件被追加到 journal 并 fold 为当前状态；恢复时反向重放这些事实。
5. 实时事件和冷态记录分别进入 Transcript/entity/search 等读取模型，再由 SDK、REST 或 WebSocket 返回产品端。

## 设计解读

- **单核心降低语义分叉**：API 兼容可以留在 SDK/server edge，而 Turn、恢复、权限和工具不再需要跨两代引擎保持行为对齐。
- **Scope 管所有权，状态机管行为**：Scope 决定资源生命周期；Agent/Turn machine 决定输入、执行、取消和恢复的状态转移，两者职责正交。
- **事件日志是恢复边界**：内存状态是 journal 的投影；Session/search/Transcript 更接近针对不同查询优化的派生模型。
- **功能通过服务组合进入主干**：MCP、skills、hooks、Tower/Swarm 能力丰富，但不会改变入口 → Scope → Agent → 模型/工具 → 存储这一高层骨架。

以上是对固定源码的架构解释，不是上游作者声明的正式设计原则。

## 验证依据

- 源码阅读：`createKimiHarness`、Core bootstrap、Session/Agent lifecycle、Agent/Turn machines、event store、Wire 兼容读取、session/search index、MCP management、Transcript 和协议层。
- 测试阅读：[`loop.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/loop/loop.test.ts)、[`agentLifecycle.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/session/agentLifecycle/agentLifecycle.test.ts)、[`agentState.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/state/agentState.test.ts) 与 Session fork/index 相关测试。
- 运行实验：未执行。

## 未确认事项

- 未运行真实 provider、Web UI、Remote Control 或多 Agent/Tower 场景，无法从本次分析确认跨进程时序和性能特征。
- 新 event-sourced Agent store 与兼容 Wire/Transcript 的长期收敛方向仍在演进；本文只描述当前 commit 的共存关系。
- `kap-server` v1/v3 协议的字段级兼容范围未在本视图展开。
