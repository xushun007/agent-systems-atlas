# DeepSeek Harness Runtime 架构演进索引

| 复核日期 | 快照 | 上游版本与提交 | 级别 | 判断 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-21 | `2026-09-21.fb2c4b9` | `dsh-v0.1.5-rc.2` · `fb2c4b9e698e30edb738bca4cf0618587db7d203` | baseline | 插件组合、Agent Loop、Session 事实日志与能力提供方分离 | [快照](runtime-architecture-2026-09-21-fb2c4b9.md) | [图](../diagrams/runtime-architecture-2026-09-21-fb2c4b9.excalidraw) |

## 2026-09-21 · baseline

首次建立固定版本的完整 Runtime 视图。图中保持的核心不变量是：多入口复用组合后的 `AgentRegistry`/`AgentLoop`；模型可见请求从 Session 事件历史派生；工具执行经策略流水线到具体环境服务。阅读了源码及相关测试，未执行运行实验。此前各阶段的责任迁移见[演进报告](../research/deepseek-harness-evolution.md)。
