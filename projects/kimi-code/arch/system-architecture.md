# Kimi Code 整体架构

> 稳定入口：Kimi Code 已收敛到 `agent-core-v2` 单一核心。它以 `App → Workspace → Session → Agent` Scope 管理生命周期，通过 SDK 或 `kap-server` 服务不同产品入口，并以事件日志、索引和读取模型连接执行与恢复。

## 当前快照

- [整体架构 · 2026-09-13 · `ee2cac1`](system-architecture-2026-09-13-ee2cac1.md)
- [可编辑 Excalidraw 图](../diagrams/system-architecture-2026-09-13-ee2cac1.excalidraw)
- [版本演进索引](system-architecture-history.md)

当前快照记录两项重大变化：legacy `agent-core` 被移除，宿主不再选择双引擎；Agent 的执行内核由显式请求队列重构为 Agent/Turn 两级状态机。

## 历史快照

- [2026-08-20 · `e22479a`](system-architecture-2026-08-20-e22479a.md)
- [历史 Excalidraw 图](../diagrams/system-architecture-2026-08-20-e22479a.excalidraw)

## 相关视图

- [Agent Loop Runtime](agent-loop-runtime.md)
- [历史核心架构（legacy v1）](architecture.md)
- [Legacy v1 执行循环深潜](loop_deep_dive.md)

旧版机制文档仍绑定各自的分析版本；在完成单独复核前，不应把当前 commit 的结论自动套用到它们。
