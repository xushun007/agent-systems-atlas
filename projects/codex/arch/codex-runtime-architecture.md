# Codex Runtime 架构

> 稳定入口：Codex 的 Runtime 主链仍是 `Session → Submission → SessionTask → Turn → Step`，但具体架构判断必须绑定上游 commit 阅读，不再覆盖式更新同一份文档。

## 当前快照

- [Codex Runtime 架构 · 2026-09-12 · `ee6814b`](codex-runtime-architecture-2026-09-12-ee6814b.md)
- [可编辑 Excalidraw 图](../diagrams/codex-runtime-architecture-2026-09-12-ee6814b.excalidraw)
- [版本演进索引](codex-runtime-architecture-history.md)

当前快照确认执行主链没有被替换，但补入了三个必须显式表达的边界：Step 级不可变执行快照、Environment-aware 工具执行，以及由 Rollout 与 State DB 共同承担的持久化/恢复。

## 历史快照

- [2026-08-14 · `7750465`](codex-runtime-architecture-2026-08-14-7750465.md)
- [历史 Excalidraw 图](../diagrams/codex-runtime-architecture-2026-08-14-7750465.excalidraw)

## 相关细化视图

- [Turn 控制循环](../mechanisms/turn-control-loop.md)
- [工具执行系统](../mechanisms/tool-system.md)
- [上下文生命周期](../mechanisms/context-lifecycle.md)
- [Rollout、恢复与 Fork](../mechanisms/rollout-resume-fork.md)

这些机制文档仍分别声明自己的分析 commit；在完成逐项复核前，不应把当前 Runtime 快照的 commit 自动套用到旧机制结论上。
