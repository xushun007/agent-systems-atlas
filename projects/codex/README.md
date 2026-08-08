# Codex

- Repository: https://github.com/openai/codex
- Latest analyzed commit: `7750465934d97dd3cbcb3b1655d2f622744010d3`
- Last reviewed: 2026-08-08

## 内容

- [Codex 项目全局架构](arch/codex-global-architecture.md)
- [Codex 分层架构](arch/codex-layered-architecture.md)
- [Codex Runtime 架构](arch/codex-runtime-architecture.md)
- [工具系统：从暴露到安全执行再到上下文回写](mechanisms/tool-system.md)
- [上下文生命周期：增量构建、窗口预算与压缩恢复](mechanisms/context-lifecycle.md)
- [符号级源码证据索引](source-map.md)

全局架构关注主要组件之间的关系；分层架构强调职责和依赖方向；Runtime 架构进一步展开 Session、Submission 和 Turn Loop 的执行机制。

机制分析进一步追踪源码调用链。当前已完成工具系统与上下文生命周期：前者覆盖工具装配与暴露、并发分发、Hook、审批、ExecPolicy、Sandbox 及结果回写；后者覆盖初始/增量上下文、token 窗口、自动压缩、历史替换和 Rollout 恢复。
