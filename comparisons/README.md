# Comparisons

围绕具体机制进行横向比较，例如 Agent Loop 终止、上下文压缩、工具审批或 Session 恢复。

## 综合研究

- [主流 Coding Agent Harness / Runtime 全面总结与比较](coding-agent-harness-runtime-synthesis.md)
- [Coding Agent 中的 Agent 与 Runtime：职责边界和代码落点](agent-vs-runtime.md)
- [DeepSeek Harness 固定版本研究](../projects/deepseek-harness/research/deepseek-harness-evolution.md)已纳入综合报告、三层架构对比及以下 11 个机制专题。

## 机制专题

- [Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型](01-session-turn-step-consistency/README.md)——包含状态所有权、输入接纳、Step 一致性、中断收敛和持久化恢复。
- [Coding Agent 的 Environment：执行环境、Workspace 与隔离](02-environment-execution/01-what-is-an-environment.md)——包含 Environment 定义、Sandbox、后台/远程执行和恢复回滚。
- [Coding Agent 的 Context Engineering：上下文构建、压缩与记忆边界](03-context-engineering/01-context-ownership-and-assembly.md)——包含上下文所有权、压缩、工具观察、记忆和分支 Replay。
- [Coding Agent 的 Tool Invocation：工具调用、审批与副作用](04-tool-invocation/01-tool-call-lifecycle.md)——包含工具生命周期、权限策略、流式/并行执行和副作用重试。
- [Coding Agent 的事件、持久化与恢复](05-persistence-recovery/README.md)——包含事件事实、持久化边界、Replay/Retry 和 Failure Recovery。
- [Coding Agent 的模型运行时：Provider、流式推理与模型切换](06-model-runtime/README.md)——包含请求边界、流式推理、模型切换一致性、Provider 故障与模型路由。
- [Coding Agent 的 Planning 与 Task Decomposition](07-planning-decomposition/README.md)——包含可执行任务、计划修正、并行分解、子 Agent 委派、计划恢复与任务验收。
- [Coding Agent 的 Agent State：状态分类、所有权与派生关系](08-agent-state/README.md)——专题已完成，包含状态分类、生命周期、状态转移、持久化恢复和状态投影一致性。
- [Coding Agent 的 Security / Trust Boundary](09-security-trust-boundary/README.md)——已完成三篇：信任模型与能力边界、Prompt Injection 与不可信 Tool Result、Sandbox/Workspace/Network/Secret 隔离；后续以源码证据和运行实验补强，不再扩张概念性文章。
- [Coding Agent 的 Extension / Plugin Architecture](10-extension-plugin-architecture/README.md)——专题已完成，包含 Tool、Skill、Plugin、MCP、动态能力投影、进程边界、生命周期和 Capability Plane。
- [Coding Agent 的 Observability / Evaluation](11-observability-evaluation/README.md)——专题已完成，包含事实与事件、Trace 层级、Trajectory/Checkpoint/Replay、任务评价和在线离线闭环。

## 后续专题

以下专题已完成研究范围定义，尚未开始撰写：

1. **Coding Agent 的 UI / Interaction Runtime**：用户输入、steer、interrupt、approval、流式 UI、后台任务与 Runtime projection。
5. **Coding Agent 的 Agent Protocol / Interoperability**：Model Provider、Tool/MCP、子 Agent、Session、Event、Artifact 和跨进程协议。
