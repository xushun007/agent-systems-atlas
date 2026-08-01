# ADK 架构笔记

ADK (Agent Development Kit) 的架构文档。

## 文件索引

| 文件 | 内容 |
|------|------|
| [01-architecture-overview.md](01-architecture-overview.md) | ASCII 架构图: 模块分层、Agent/Node 继承、事件流、状态存储、Plugin 系统、工具系统 |
| [02-mermaid-diagrams.md](02-mermaid-diagrams.md) | Mermaid 图: 模块依赖、调用生命周期、状态分治 |

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
