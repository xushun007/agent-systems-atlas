---
title: Coding Agent 的模型运行时
reviewed_at: 2026-09-17
status: active
document_type: mechanism-series
---

# Coding Agent 的模型运行时：Provider、流式推理与模型切换

## 专题问题

模型在 Coding Agent 中不是一个独立的文本生成服务。它与 Context、工具能力、权限、Environment、Step 生命周期和持久化状态共同构成一次可执行决策。

本专题研究：

- Provider、Model、Adapter 和 Capability 如何分层；
- 一次模型请求如何进入 Step 状态机；
- 流式响应、部分结果、终止原因和取消如何影响控制流；
- 模型切换如何影响 Context、工具 schema、权限和恢复；
- retry、usage、成本和 KV cache 应由哪些层负责。

## 术语约定

本文使用“请求定型”对应 Runtime 中的 `materialize`：指将尚未具体展开的 StepRequest，结合当前模型、Context、工具集合、权限和 Environment，生成一次具体的 Provider 请求。

“请求冻结”表示请求定型完成后，模型、Context、工具和策略版本不再随意变化；“不可变”则是对冻结后对象性质的描述，而不是这个过程的名称。源码中的 `materializeRequest()` 等函数名保留英文，以便与实现对应。

## 文章目录

1. [Provider、请求与决策边界](01-model-runtime-boundary.md)
2. [流式推理的生命周期](02-stream-lifecycle.md)
3. [模型切换与上下文一致性](03-model-switch-consistency.md)
4. [Provider 故障、成本预算与模型路由](04-provider-failure-routing-and-budget.md)

本专题四篇文章已完成。

## 项目补充

- [DeepSeek Harness：路由准备、请求冻结与流 settlement](deepseek-harness.md)
