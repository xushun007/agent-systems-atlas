# Claude Code Runtime / Harness 架构

> 稳定入口：当前架构基线把 Claude Code 视为“conversation runtime + tool/permission pipeline + task supervisor + durable session/workspace state”，而不是单一的 CLI 工具循环。

## 当前快照

- [Claude Code Runtime / Harness 架构 · 2026-09-18 · `6e2f79c`](claude-code-runtime-architecture-2026-09-18-6e2f79c.md)
- [可编辑 Excalidraw 图](../diagrams/claude-code-runtime-architecture-2026-09-18-6e2f79c.excalidraw)
- [版本演进索引](claude-code-runtime-architecture-history.md)

当前快照确认：`QueryEngine` 持有跨 turn 的 conversation 状态，`queryLoop` 负责单个用户 turn 内的模型—工具迭代，`Task` 层把后台 shell、子 agent、teammate、workflow 与远端 agent 从主循环中分离；权限、沙箱和 workspace 环境则在工具执行边界汇合。

## 相关研究

- [Claude Code Harness Runtime 分析](../research/claude-code-harness-evolution.md)

重要来源边界：本项目分析的是第三方公开的泄漏源码备份，不是 Anthropic 官方发布。本入口与快照只描述 commit `6e2f79c5b97ae619172a3e621e87dd0edb220619` 中可观察到的结构。
