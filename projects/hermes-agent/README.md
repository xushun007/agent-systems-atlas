# Hermes Agent

本项目记录 Hermes Agent 的 Harness/Runtime 架构研究。

- 上游仓库：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- 分析版本：`v0.21.0`，tag `v2026.8.31`
- 分析提交：[`29112bef099274229cadff79cdff7bf7b99c4b77`](https://github.com/NousResearch/hermes-agent/tree/29112bef099274229cadff79cdff7bf7b99c4b77)
- 研究文档：[Hermes Harness Runtime 演进](./research/hermes-harness-evolution.md)

研究范围是从项目早期到 `v2026.8.31` 的主要 Runtime/Harness 演进，重点关注 agent loop、Session/Turn/Step、Context、Environment、Tools/Capabilities、持久化、Gateway、ACP、Subagent 和 Desktop/Bot Mode。跨项目比较暂不放在本文中。
