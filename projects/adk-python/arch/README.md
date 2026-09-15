# ADK 架构笔记

ADK (Agent Development Kit) 的架构文档。

## 版本基线

本目录以 Google ADK Python `v2.8.0` 为当前源码基线：[`76a96e6221f1e2758a1ff82fde199cd079e9c654`](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654)，源码审阅日期为 2026-09-15。版本演进依据见 [Harness / Runtime 演进研究](../research/adk-python-harness-evolution.md) 和官方 [`CHANGELOG.md`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md)。

## 文件索引

| 文件 | 内容 |
|------|------|
| [01-architecture-overview.md](01-architecture-overview.md) | ASCII 架构图: 模块分层、Agent/Node 继承、事件流、状态存储、Plugin 系统、工具系统 |
| `01-architecture-overview.md` | v2.8.0 Runtime 架构、生命周期和组件边界 |

## 快速认知

ADK 的核心导出只有 5 个符号:

```python
from google.adk import Agent, Context, Event, Runner, Workflow
```

- **Agent** (LlmAgent): 定义 agent 的身份、指令、工具
- **Runner**: 状态执行引擎，编排整个生命周期
- **Context**: 每个节点执行独有的上下文 (1:1 映射)
- **Event**: 所有交互的数据模型 (消息、工具调用、响应)
- **Workflow**: 图编排引擎，支持多节点复杂流程

## 相关笔记

- [../runner/](../runner/) - Runner 深入分析
- [../session/](../session/) - Session 存储架构
- [../code_exe/](../code_exe/) - Code Executor 架构
