# Cline Runtime Architecture 演进索引

> 本文记录 Cline Runtime 架构判断如何随上游源码演进。版本化快照不可被下一次分析覆盖；无架构变化的复核也应留下记录。

## 版本

| Review date | Snapshot | Upstream commit | Change level | 主要变化 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-18 | `2026-09-18.5ec2d47` | `5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa` | baseline | 建立 Host → SessionRuntime → per-run AgentRuntime 基线，并纳入 Hub/Remote、队列、审批与恢复路径 | [快照](cline-runtime-architecture-2026-09-18-5ec2d47.md) | [图](../diagrams/cline-runtime-architecture-2026-09-18-5ec2d47.excalidraw) |

## 2026-09-18 · `5ec2d47`

### 变化

- 首次建立版本化 Runtime 架构快照。
- 记录本地与 Hub/Remote 共用服务端 LocalRuntimeHost 的控制路径。
- 明确 SessionRuntime 跨用户轮次存活，而 AgentRuntime 每次 run 新建。

### 保持不变

- 本次为基线；后续以 RuntimeHost、SessionRuntime、AgentRuntime 和 Core-owned persistence 的职责边界作为复核不变量。

### 验证范围

- 已阅读固定 commit 的关键实现与测试。
- 未执行运行实验；本地上游 checkout 未安装依赖。
- 未逐一验证每个 IDE 宿主和每个 provider 的具体时序。
