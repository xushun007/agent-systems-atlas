---
title: DeepSeek Harness Runtime Architecture
snapshot_id: 2026-09-21.fb2c4b9
reviewed_at: 2026-09-21
upstream_repository: https://github.com/deepseek-ai/deepseek-harness
upstream_commit: fb2c4b9e698e30edb738bca4cf0618587db7d203
upstream_commit_date: 2026-09-10
status: current
change_level: baseline
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/runtime-architecture-2026-09-21-fb2c4b9.excalidraw
---

# DeepSeek Harness Runtime 架构

> 结论：`dsh-v0.1.5-rc.2` 不是“固定 Agent Loop 加可选工具”的结构。启动 profile 决定 Cordis 插件树，Agent preset 决定某个 Agent 可见的能力，`AgentLoop` 负责运行控制；Session 事件日志则承担可重建的模型上下文与恢复事实。Web、SDK、ACP 是复用这些服务的入口，不各自实现一套 Loop。

## 视图边界

[可编辑架构图](../diagrams/runtime-architecture-2026-09-21-fb2c4b9.excalidraw)覆盖 profile 装配、入口、Agent 创建与循环、模型/工具请求、Session 日志和执行环境。图中“Environment”是 `fs`、`shell`、`subprocess`、`sandbox` 等能力提供方的归纳，不是上游单一 `Environment` 类。桌面私有管道、Web UI 组件树、PTC 内部执行器和具体存储格式不展开。

## 基线与演进

这是该视图的第一份快照，没有上一快照可比较。历史上从早期 Cordis/Agent Loop，逐步增加 profile、preset、持久化句柄、Session 格式迁移和 durable inbox；证据与保留的不变量见[演进报告](../research/deepseek-harness-evolution.md)。

## 架构说明

1. **组合先于执行。** [`profile.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/boot/app-boot/src/profile.ts#L1-L23)按 bundle、profile 和 overlay 装配插件树；[`AgentPresets`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21)再把某个 Agent 加入预设作用域。插件注册与卸载由 Cordis effect 生命周期约束。
2. **入口控制与 Agent 创建分离。** [`AgentRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L245-L263)持有活跃 Agent 和工厂接口；[`AgentLoop`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L359-L424)注册默认工厂。创建时 `setup` 在发布前完成能力组装；失败回滚，不暴露半配置 Agent。[`CreateAgentOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L124)
3. **运行控制围绕 Session 事实日志。** [`ReactLoopAgent.turn()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L269-L349)记录 `turn/start`、`step/start`、结束事件；[`step()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L352-L473)在模型请求前记录被接纳输入，再以 [`deriveMessages()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L811-L832)构造不可变历史。`agent/*` 的流式观察事件不等于这些持久事实。
4. **模型与工具是不同能力边界。** [`prepareRequest()`/`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L503-L627)先确定真实适配器与请求头，再冻结发送。工具 schema 由 [`ToolRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L780-L838)投给提示词；调用进入前置策略、审批/guard、执行、后置策略流水线，而非直接由 Loop 操作 shell。[`ToolRuntime.execute()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1332-L1349)
5. **存储是独立的单写者句柄。** [`SessionPersistence`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-persistence/src/index.ts#L105-L170)区分 read/write handle 与 `flush` 持久屏障；恢复在重新发布 Agent 前修复未闭合 turn 和工具调用。[`resume.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/resume.spec.ts#L451-L535)

## 验证依据

源码：上述固定提交文件；测试重点阅读 [`loop.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/loop.spec.ts#L439-L510)、[`tool-calls.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/tool-calls.spec.ts#L102-L246)、[`crash-recovery.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L92-L124)。本次未执行这些测试，亦未调用真实模型。

## 设计解读

源码所体现的主要取舍是：把“行为能否被替换”交给组合和作用域，把“执行是否继续”交给 Loop，把“模型到底看过什么”交给 Session 日志。这样扩展能力不必复制 Loop，但插件装配、事件词汇表、迁移链和故障收敛的复杂度明显高于最小 ReAct 实现。此段是架构解释，不是性能或可用性实验结论。

## 未确认事项

- 未验证 Web、桌面、ACP 在真实进程/网络故障下的端到端恢复与审批体验。
- 未测量 plugin 热重载、长 Session 投影或持久化后端的性能。
- 上游仍在开发者预览，本文不能推出后续版本的兼容性承诺。
