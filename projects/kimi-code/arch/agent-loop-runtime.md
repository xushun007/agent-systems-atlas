# Kimi Code Agent Loop Runtime

> 稳定入口：当前 Agent Loop 由 `AgentPromptService` 管理输入生命周期，`AgentLoopService` 提供外部门面，`MachineEngine` 驱动 Agent Machine 与嵌套 Turn Machine；循环继续由状态转移和工具结果决定，不再由 `StepRequestQueue`/continuation aspect 编排。

## 当前快照

- [Agent Loop Runtime · 2026-09-13 · `ee2cac1`](agent-loop-runtime-2026-09-13-ee2cac1.md)
- [可编辑 Excalidraw 图](../diagrams/agent-loop-runtime-2026-09-13-ee2cac1.excalidraw)
- [版本演进索引](agent-loop-runtime-history.md)

## 历史快照

- [2026-08-20 · `e22479a`](agent-loop-runtime-2026-08-20-e22479a.md)
- [历史 Excalidraw 图](../diagrams/agent-loop-runtime-2026-08-20-e22479a.excalidraw)

## 视图关系

- [整体系统架构](system-architecture.md) 说明产品入口、Scope、外部能力和持久化边界。
- 本视图只展开单个 Agent 内的输入、Turn、LLM、工具、事件和恢复控制链。
