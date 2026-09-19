# Cline

本项目研究 Cline CLI 与 shared agent core 的 Runtime/Harness 架构。

- 上游仓库：[cline/cline](https://github.com/cline/cline)
- 分析基线：monorepo commit [`5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa`](https://github.com/cline/cline/commit/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa)
- CLI 包版本：`3.0.49`
- Runtime 架构：[当前快照](arch/cline-runtime-architecture.md)
- 研究报告：[Cline CLI Harness Runtime 分析](research/cline-cli-harness-evolution.md)

研究重点是 shared core、多宿主 Session/Turn、Prompt Queue、steer/interrupt、Tool Policy、Approval、Checkpoint、Connector 与 Hub。源码仓库与 Atlas 分离，报告中的源码引用均固定到上游 commit。
