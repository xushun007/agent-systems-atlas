# Kimi Code Runtime/Harness 演进索引

本索引记录重要架构复核，不把 routine release 变化误写成新架构。当前针对 `v0.40.0` 的研究文档是：[Kimi Code Harness 演进研究](kimi-code-harness-evolution.md)。

| 复核日期 | 上游提交 | 级别 | 主要变化 | 文档 |
| --- | --- | --- | --- | --- |
| 2026-09-14 | `e27ee60894d714e5844db75da69f29120a2bce43` | major | v2 默认进入 CLI/TUI；Web/server 已 v2；legacy v1 仍由 flag 保留；Scope、StepRequest、permission gate、Wire/replayable state 构成双引擎迁移态。 | [v0.40.0 研究](kimi-code-harness-evolution.md) |
| 2026-09-13 | `ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd` | major | 后续主线移除 legacy Core，Loop 进一步转为 Machine Engine/Agent+Turn machine；该版本不属于本次 v0.40.0 源码快照。 | [整体架构快照](../arch/system-architecture-2026-09-13-ee2cac1.md) |

## 固定的历史里程碑

- `842e699a643d8a60647bd824d28255c56ad61a42`：项目起点。
- `ceb158dc54586f254819edbc83c27e21dca1ecf6`：`agent-core-v2` 与 `kap-server` 以实验引擎落地。
- `4ec2e7fab14ab89cddf77821082c3ff4911f737b`：server 默认 v2，并移除 v1 server package。
- `5240b5c83c876fd6fcbe199b3c7b4f65ef75d215`：生成 config/wire manifests，强化协议边界。
- `e27ee60894d714e5844db75da69f29120a2bce43`：v0.40.0 release；CLI 默认 v2，保留 legacy flag。
