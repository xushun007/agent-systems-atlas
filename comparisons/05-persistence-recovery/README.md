---
title: Coding Agent 的事件、持久化与恢复
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-series
---

# Coding Agent 的事件、持久化与恢复

## 专题结论

Coding Agent 的可靠运行时，不能只保存对话记录，也不能把所有异常都交给重试。它需要把执行事实、模型上下文、Environment 状态、权限、外部副作用和恢复责任放在不同但可关联的层次中。

本专题的核心判断是：

```text
事件日志       记录系统确认或观察到的事实
持久化模型     保存恢复所需的身份、责任和中间状态
Replay / Retry  区分重新计算、重新请求与重新执行副作用
Failure        让未完成操作进入可解释、可继续或可停止的终态
```

其中最重要的边界有五个：

- Message 是语义投影，不等于完整执行事实；
- Transcript 和 trajectory 可以帮助重建上下文，不自动等于 checkpoint；
- Event 可以重放来重建状态，但 tool effect 不能无条件重放；
- Cancel 停止未来计算，不等于 rollback 或 compensation；
- Turn 完成不等于后台任务和远程 Environment 已经完成。

## 关键问题

[Persistence / Recovery 关键问题](key-question.md)

## 架构图

[Persistence / Recovery Runtime 架构图](diagrams/persistence-recovery-runtime.excalidraw)

## 文章目录

1. [执行事实与事件日志](01-events-as-facts.md)——定义 message、event、observation、trace、checkpoint 的边界，分析工具调用如何形成可审计事实。
2. [持久化模型与恢复边界](02-persistence-and-recovery-boundaries.md)——说明哪些状态必须落盘，哪些状态可以重建，以及 checkpoint 为什么不是 transcript 的别名。
3. [Replay、Retry 与副作用一致性](03-replay-retry-and-effects.md)——区分状态重放、模型重试、工具重试和 effect reconciliation，解释 exactly-once 的端到端边界。
4. [Failure Recovery 与终态收敛](04-failure-recovery-and-convergence.md)——建立统一恢复状态机，讨论中断、崩溃、审批等待、后台任务和责任接管。

## 研究范围

本文专题比较 Codex、Pi、OpenCode、OpenHands、Gemini CLI、Kimi Code 和 mini-SWE-agent 中与事件、持久化、重放和恢复有关的 Runtime 机制。各项目的结论基于已记录版本的源码和测试阅读，源码链接固定到对应 commit。

比较的对象不是数据库技术本身，而是 Agent Runtime 如何回答以下问题：

- 一次模型决策何时成为 Runtime 接受的工作？
- 一个工具调用何时被视为已经执行？
- 审批、Environment 和外部副作用如何与调用身份关联？
- 崩溃后谁可以接管未完成工作？
- 如何避免将未知状态错误地标记为失败或成功？
- 一个 Session、Turn 或后台 operation 何时真正结束？

## 证据边界

本专题区分三种证据：

1. **源码事实**：固定版本中明确存在的状态、函数、事件类型和责任边界；
2. **测试事实**：项目测试实际覆盖的状态转换或恢复行为；
3. **运行时结论**：需要故障注入、真实 provider 或远程 Environment 才能确认的行为。

目前已完成一个不依赖 API Key 的确定性恢复模型实验：[副作用未知状态实验](../../experiments/persistence-recovery/README.md)。该实验验证了通用 Runtime 模型中“副作用已发生但完成事件丢失”应先对账、再进入 `reconciled` 的原则。

该实验不等同于对每个 Agent 的真实 Runtime 做了故障注入。远程 sandbox、provider 超时、shell 的后台副作用、数据库事务边界和多 worker fencing 仍属于项目级验证范围，不在本专题的已证实结论中。

## 收束

本专题到此完成概念和架构分析。后续如果继续做实验，应作为独立的项目级验证工作，不修改本专题对源码事实和设计边界的表述；实验若发现与当前判断不一致，再通过新的实验记录或专题修订明确更新证据。
