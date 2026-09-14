# Kimi Code 整体架构演进索引

> 结论：从 `e22479a` 到 `ee2cac1`，Kimi Code 从双引擎迁移态收敛为单一 v2 Core；Scope 分层、Agent 聚合和持久化/读取模型分离仍是稳定骨架。

## 版本

| Version | Review date | Snapshot | Upstream commit | Change level | 主要变化 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `v0.42.0+`（未发布主线） | 2026-09-13 | `2026-09-13.ee2cac1` | `ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd` | major | 删除 legacy Core；Agent 执行改为状态机；协议、索引与 MCP 管理面增强 | [文档](system-architecture-2026-09-13-ee2cac1.md) | [Excalidraw](../diagrams/system-architecture-2026-09-13-ee2cac1.excalidraw) |
| `v0.31.1` | 2026-08-20 | `2026-08-20.e22479a` | `e22479a62eed9c3b78a67b313f4332c2c0ba9670` | baseline | 双引擎迁移态；建立 Scope、Wire 与 Transcript 高层模型 | [文档](system-architecture-2026-08-20-e22479a.md) | [Excalidraw](../diagrams/system-architecture-2026-08-20-e22479a.excalidraw) |

## 2026-09-13 · `ee2cac1`

### 变化

- legacy `packages/agent-core` 被移除，CLI/SDK 的 `createKimiHarness` 直接装配 v2，不再存在运行时引擎选择。
- Agent Scope 内的循环实现改为门面加 Agent/Turn 两级状态机；状态、输入队列、通知和后台工具的所有权更集中。
- `kap-server` 增加 flat entity message protocol v3，并继续在边缘提供兼容协议、REST/WebSocket、远程控制和调试能力。
- Agent 状态采用事件溯源存储；session/search 索引成为可从 journal 重建的读取基础设施。
- MCP 配置、注册、连接与 OAuth 被整理为统一管理面，同时保留 Workspace/Session/Agent 的能力注入边界。

### 保持不变

- `App → Workspace → Session → Agent` 仍是核心生命周期层次。
- 产品入口通过 SDK/harness 或 `kap-server` 进入同一 Core。
- Workspace 继续提供文件、进程、Git、信任与工具能力；Agent 聚合实际执行状态。
- 执行事实与面向 UI/查询的读取模型继续分离，并支持从持久记录恢复。

### 验证范围

- 阅读固定 commit 的 SDK 装配、Scope 生命周期、Agent/Turn 状态机、事件存储、Wire 兼容读取、索引和 `kap-server` 协议实现及相关测试。
- 未运行真实 provider、Web UI、远程控制或故障恢复实验。

## 2026-08-20 · `e22479a`

### 基线

- 记录 legacy `agent-core` 与 `agent-core-v2` 并存的迁移态。
- 建立多入口、层级 Scope、Agent Wire 和 Transcript 读取模型的整体视图。

### 验证范围

- 基于源码与测试阅读，未执行端到端运行实验。
