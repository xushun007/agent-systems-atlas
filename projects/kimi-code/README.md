# Kimi Code

- Repository: https://github.com/MoonshotAI/kimi-code
- Analyzed version: `v0.40.0` (`@moonshot-ai/kimi-code@0.40.0`)
- Source commit: `e27ee60894d714e5844db75da69f29120a2bce43`
- Last reviewed: 2026-09-14
- Current architecture snapshot: `2026-09-14.e27ee60`

## 内容

- [整体系统架构](arch/system-architecture.md) · [版本演进](arch/system-architecture-history.md)
- [Harness 全程演进（v0.40.0）](research/codex-harness-evolution.md) · [演进索引](research/runtime-harness-history.md)
- [当前整体架构图（Excalidraw）](diagrams/system-architecture-2026-09-13-ee2cac1.excalidraw)
- [Agent Loop Runtime](arch/agent-loop-runtime.md) · [版本演进](arch/agent-loop-runtime-history.md)
- [当前 Runtime 图（Excalidraw）](diagrams/agent-loop-runtime-2026-09-13-ee2cac1.excalidraw)
- [历史核心架构（legacy v1）](arch/architecture.md)
- [Legacy v1 执行循环深潜](arch/loop_deep_dive.md)
- [与 Hermes Agent 对比](arch/compare_hermes.md)
- [与 OpenCode 对比](arch/compare_opencode.md)

## 当前判断

Kimi Code 已移除 legacy `agent-core`，CLI、SDK 与 `kap-server` 共享 `agent-core-v2` 单一 Core。Scope 分层仍为 `App → Workspace → Session → Agent`；Agent Loop 则从 `StepRequestQueue + continuation aspects` 重构为 `AgentLoopService` 门面后的 Agent/Turn 两级状态机。

旧架构文档与可编辑图已按日期和 commit 保留，后续复核应新增快照或在 history 中记录 `none`，不要覆盖历史版本。
