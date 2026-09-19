# Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型

## 关键问题

[Session / Turn / Step 关键问题](key-question.md)

## 架构图

[Session / Turn / Step 一致性模型](diagrams/session-turn-step-consistency.excalidraw)

用户在 Agent 执行过程中追加要求、确认审批或点击停止，这些操作从什么时候开始影响执行？本专题沿着这个问题，研究输入、上下文、工具执行与历史记录之间的关系。

## 文章安排

1. [Session、Turn 与 Step：Coding Agent 的状态所有权与执行边界](01-state-ownership.md)——从执行归属、可见性与生命周期建立分析框架，附实现证据和局部实验。
2. [执行中的用户输入：Coding Agent 的接纳、排队与生效边界](02-input-admission.md)——已完成首稿，以 Pi 七组受控实验及 Kimi、Codex 实现分析输入处理。
3. [一次 Step，究竟需要固定什么？](03-step-consistency.md)——请求快照、执行环境与执行前校验。
4. [中断之后，Agent 到底停在哪里？](04-interruption-and-convergence.md)——取消传播、部分完成、迟到结果与终态。
5. [恢复会话，为什么不等于恢复执行？](05-persistence-and-recovery.md)——持久化、外部副作用、重试与恢复。

每篇围绕正常交互中的一个问题展开，分别说明实测、实现依据和仍待验证的部分。统一术语用于比较，不要求项目采用同名类，也不预设所有系统需要相同的复杂度。

## 研究材料

- [版本与证据索引](evidence.md)
- [Kimi 请求状态与队列边界实验](../../experiments/session-turn-step-consistency/kimi-admission/README.md)
- [Pi 执行中输入的可见性实验](../../experiments/session-turn-step-consistency/pi-input-boundaries/README.md)
- [跨项目 Runtime 总报告](../coding-agent-harness-runtime-synthesis.md)

五篇正文已完成。已实测 Kimi 请求队列，以及 Pi 底层 Agent 在模型适配函数入口的输入可见性；第三至第五篇的关键结论目前以源码和上游测试为主，真实 CLI、提供商网络链路、子进程取消和服务重启恢复尚未实测。
