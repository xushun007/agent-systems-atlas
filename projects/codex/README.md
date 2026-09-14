# Codex

- Repository: https://github.com/openai/codex
- Latest Runtime architecture commit: `ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`
- Last reviewed: 2026-09-12

## 内容

- [Codex 项目全局架构](arch/codex-global-architecture.md)
- [Codex 分层架构](arch/codex-layered-architecture.md)
- [Codex Runtime 架构](arch/codex-runtime-architecture.md)
- [Codex Runtime 架构演进索引](arch/codex-runtime-architecture-history.md)
- [工具系统：从暴露到安全执行再到上下文回写](mechanisms/tool-system.md)
- [上下文生命周期：增量构建、窗口预算与压缩恢复](mechanisms/context-lifecycle.md)
- [Turn 控制循环：Submission、Steer、采样与中断收束](mechanisms/turn-control-loop.md)
- [Rollout：持久化、恢复与 Fork 语义](mechanisms/rollout-resume-fork.md)
- [Guardian：自动审批审查与拒绝熔断](mechanisms/guardian-approval-review.md)
- [Multi-Agent V2：线程树、消息语义与资源治理](mechanisms/multi-agent-v2.md)
- [权限控制面：配置约束、Profile 投影与运行时收敛](mechanisms/permission-configuration.md)
- [符号级源码证据索引](source-map.md)
- [Codex Harness Runtime 演进研究](research/codex-harness-evolution.md)

全局架构关注主要组件之间的关系；分层架构强调职责和依赖方向；Runtime 架构进一步展开 Session、Submission 和 Turn Loop 的执行机制。

架构快照和机制文档分别声明自己的上游 commit。当前 Runtime 已升级到最新快照；尚未升级的机制分析继续以各自文档中的 commit 为准，不能由项目级元数据推定。

机制分析进一步追踪源码调用链。当前已完成工具系统、上下文生命周期、Turn 控制循环、Rollout、Guardian、Multi-Agent V2 和权限控制面，覆盖安全执行、上下文演进、运行控制、持久化/恢复、自动审批、多 Agent 通信，以及配置约束到平台 Sandbox 的权限收敛。
