---
title: Coding Agent 的 Observability / Evaluation
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-series
---

# Coding Agent 的 Observability / Evaluation

## 专题问题

Coding Agent 的可观测性，不只是把日志写到文件；Evaluation 也不只是统计任务成功率。一个 Agent 是否可理解、可恢复、可优化，取决于 Runtime 是否能把用户输入、模型请求、Tool Call、Environment effect、审批、错误、恢复和最终结果关联成一条可验证的证据链。

本专题研究 Event、Trace、Metric、Trajectory、Artifact、Evaluation Sample 和 Dataset 在 Coding Agent 中的责任边界。

重点问题包括：

- 哪些是 Runtime 事实，哪些只是 UI 观察，哪些是模型输出；
- Session、Turn、Step、Tool Call、Operation 和 Trace 如何关联；
- Event log 是否足以重建运行，Trajectory 是否等于 recovery checkpoint；
- 如何计算任务成功率、工具成功率、恢复成功率、延迟、Token 和成本；
- 如何把文件 diff、测试结果和外部副作用纳入任务评价；
- 在线 Trace 与离线 Evaluation 如何共享数据而不泄露 Secret；
- 多 Agent、子 Agent 和并行 Tool Call 如何进行归因；
- Evaluation 结果如何反馈到 Prompt、Policy、模型路由和 Runtime 设计。

## 文章计划

1. **[事实、事件与观察：Coding Agent 应记录什么](01-facts-events-and-observations.md)**
   
   区分 Event、Log、Trace、Projection、Model output 和 Runtime fact，建立可重建的记录边界。

2. **[Trace 的层级：Session、Turn、Step、Tool Call 与 Operation](02-trace-hierarchy-and-correlation.md)**
   
   研究运行链路、父子关系、并发调用、子 Agent、远程 Operation 和失败恢复的关联模型。

3. **[Trajectory、Checkpoint 与 Replay](03-trajectory-checkpoint-and-replay.md)**
   
   区分对话轨迹、状态快照、恢复检查点和可重放请求，分析哪些状态能重建、哪些副作用只能查询。

4. **[Coding Agent 的 Evaluation：从任务完成到执行质量](04-evaluation-and-quality-model.md)**
   
   建立任务成功、代码正确性、工具效率、恢复能力、成本和安全性的评价模型。

5. **[在线 Observability 与离线 Evaluation 的闭环](05-observability-evaluation-loop.md)**
   
   研究 Trace、Dataset、Replay、反馈和版本比较如何形成闭环，以及数据脱敏和样本可比性问题。

## 研究方法

每篇文章都必须先落到具体 Agent 的源码机制，再提炼跨项目概念。抽象概念不能作为主要证据，只能作为对实现的归纳。

每篇文章都区分四类证据：

1. **Runtime fact**：由 Runtime、Environment 或外部系统确认的事实；
2. **Model output**：模型提出的计划、参数或判断，不等于事实；
3. **Observation**：UI、日志或 Trace 对运行状态的投影；
4. **Evaluation judgment**：根据验收标准对任务质量作出的判断。

对每个核心判断，至少给出对应的 Loop、Event/State、持久化、Tool/Environment 或 Evaluation 入口；如果只能从概念或文档推测，必须明确标记为未确认。

研究重点不是收集更多字段，而是回答：

> 发生了什么、谁产生了它、何时发生、影响了哪个资源、是否已经确认，以及恢复时能否重新验证。

## 重点分析对象

- Codex：Event、Turn/Step、Tool execution、Approval、Environment 和恢复事实；
- Pi：Agent Loop、Tool Call、Extension hook、Message/Compaction 与轻量 trajectory；
- OpenCode：Session execution、claim、Workspace、Event 和服务化运行记录；
- Gemini CLI：Session、Tool execution、策略结果、Telemetry 和用户交互；
- Cline：Task history、Tool approval、MCP、diff 和浏览器/编辑器交互；
- OpenHands：Agent event stream、runtime event、trajectory、sandbox 和评估任务；
- Kimi Code：Task persistence、Agent Run、Tool Policy、Subagent 和状态投影；
- mini-SWE-agent：trajectory、submit sentinel、Environment output 和最小任务评价；
- ADK Python：Event、Invocation、Session、Runner、Callback 和应用级评估。

## 当前限制

本专题研究 Runtime 事实与评估机制，不把日志平台或通用 APM 当作核心答案。涉及状态事实时引用 [Agent State](../08-agent-state/README.md)；涉及扩展来源和能力身份时引用 [Extension / Plugin Architecture](../10-extension-plugin-architecture/README.md)。真实在线指标、Provider 缓存命中、成本账单和部署级采样策略需要运行实验或服务端数据，不能仅凭客户端源码推断。

专题已完成初步研究范围。后续如有新增源码证据，优先补充固定版本引用和实验记录，不再扩张为概念性文章。
