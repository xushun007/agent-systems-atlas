# Codex Runtime 架构演进索引

> 结论：从 `7750465` 到 `ee6814b`，Codex 没有替换 Session/Task/Turn 主链，但在 Step 快照、执行环境、持久化恢复与 app-server 宿主职责上形成了架构级演进。

## 版本

| Review date | Snapshot | Upstream commit | Change level | 主要变化 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-12 | `2026-09-12.ee6814b` | `ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8` | major | Step 设置快照、执行环境、延迟持久化与宿主控制面增强 | [文档](codex-runtime-architecture-2026-09-12-ee6814b.md) | [Excalidraw](../diagrams/codex-runtime-architecture-2026-09-12-ee6814b.excalidraw) |
| 2026-08-14 | `2026-08-14.7750465` | `7750465934d97dd3cbcb3b1655d2f622744010d3` | baseline | Session、Submission、SessionTask 与 Turn Loop 基线 | [文档](codex-runtime-architecture-2026-08-14-7750465.md) | [Excalidraw](../diagrams/codex-runtime-architecture-2026-08-14-7750465.excalidraw) |

## 2026-09-12 · `ee6814b`

### 变化

- `TurnContext` 不再是模型和执行设置的唯一快照；`StepSettings`、`ResolvedStepSettings` 与 `StepContext` 把模型、审批、环境、MCP binding 和工具计划固定到每次 sampling step。
- 工具执行从单一工作目录/本地 Sandbox 视角扩展为 Environment-aware 执行，支持多个环境、runtime workspace roots、Worktree 及本地或远程执行宿主。
- Storage 增加延迟 rollout materialization、迁移、queued items、attachments、realtime history 和 daemon recovery；`Rollout Log + State DB` 仍是高层稳定抽象。
- `app-server` 承担 daemon、turn admission、queue、恢复、验证与动态配置等应用宿主职责。
- 独立 `codex mcp-server` 入口及 `codex-rs/mcp-server` crate 被移除；MCP 继续作为 Runtime 能力存在。

### 保持不变

- 前端经 app-server 或嵌入式客户端进入 Core。
- `Session` 串行处理 Submission，并保持至多一个前台 `SessionTask`。
- `RegularTask` 驱动 `run_turn()`，Turn 在模型采样和工具结果之间迭代。
- 事件流继续承担前端观察与运行状态通知。
- 运行事实继续写入 Rollout，并由 State DB/索引支持查找和恢复。

### 验证范围

- 阅读固定 commit 的 Runtime、Step、工具、Environment、Storage 与 app-server 实现和相关测试。
- 未执行端到端运行实验。
- Guardian、Context、Multi-Agent 和权限机制的独立文档尚未全部升级到该 commit。

## 2026-08-14 · `7750465`

### 基线

- 建立 `Submission Processing → SessionTask → run_turn → Reason/Act/Observe` 的高层模型。
- 将 Runtime Services 内聚在 Session 边界，将 Rollout Log 和 State DB 作为外部持久化边界。
- 图中刻意弱化 `ThreadManager` 和具体任务类型，以表达稳定设计而非 Rust 类图。

### 验证范围

- 基于源码和测试阅读。
- 未执行真实审批、Interrupt、恢复或工具沙箱实验。
