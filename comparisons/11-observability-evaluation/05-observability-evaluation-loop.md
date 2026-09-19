---
title: 在线 Observability 与离线 Evaluation 的闭环
series: Coding Agent 的 Observability / Evaluation
part: 5
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# 在线 Observability 与离线 Evaluation 的闭环

## 结论

在线 Observability 和离线 Evaluation 不是两套互不相关的系统：

~~~text
在线运行
  → 事实记录与 Trace
  → 样本筛选和脱敏
  → Replay / Dataset
  → 离线 Evaluation
  → 失败归因
  → Prompt / Tool / Policy / Model / Environment 改进
  → 新版本在线运行
~~~

但这个闭环只有在每一步保留语义边界时才有效。在线 Trace 不是天然可评估样本，离线 trajectory 也不是天然可恢复运行。

一个合格的闭环必须同时回答：

- 这次运行实际发生了什么；
- 哪些事实可以被安全保存；
- 样本是否可以与其他版本公平比较；
- Replay 是状态重建还是重新执行；
- 失败责任属于模型、Runtime、Tool、Environment 还是评估器；
- 改进后是否真的提高了质量，而不是只改变了指标定义。

## 1. 在线 Observability 的职责

### 1.1 在线系统记录事实

在线 Runtime 主要记录：

- 用户输入；
- Model Request 和 Provider response；
- Tool Call 生命周期；
- Approval、Interrupt、Steering；
- Environment 执行；
- 文件、进程和远程 Operation；
- 错误、重试和恢复；
- Token、延迟和资源使用。

它的目标是让当前运行可理解、可诊断、可恢复，而不是立即产生最终质量分数。

### 1.2 在线指标是运行指标

在线可以可靠统计：

- 请求延迟；
- Tool queue/execution latency；
- Provider error；
- Tool rejection；
- Process exit；
- Event lag；
- Token usage；
- active operation；
- recovery state。

但在线 Runtime 通常不能仅凭自身知道“代码是否真正解决了用户问题”。它需要测试、人工确认或外部验收器。

### 1.3 在线数据的时效性

在线状态可能快速变化：

- 文件在用户操作后改变；
- 进程退出；
- 远程 Operation 异步完成；
- Token/租约过期；
- Worker 发生接管。

因此在线 Trace 需要保留观察时间和来源，不能把最后一次 UI 状态当作永久事实。

## 2. 从 Trace 到 Evaluation Sample

### 2.1 Sample 不是 Trace 的复制品

一个 Evaluation Sample 应该包含任务、运行和评价所需的最小证据：

~~~text
Sample {
  sample_id
  task_definition
  initial_repository
  initial_environment
  run_reference
  selected_trajectory
  acceptance_criteria
  evaluation_rubric
  redaction_record
  provenance
}
~~~

Trace 中的 UI delta、调试日志和 Secret 不一定进入 Sample。Sample 需要经过筛选、脱敏和版本化。

### 2.2 样本筛选不能只选成功案例

至少应保留：

- 成功；
- 首次失败；
- 恢复成功；
- 恢复失败；
- 用户中断；
- 权限拒绝；
- Environment 失败；
- 外部 Operation unknown；
- 成本或延迟异常；
- 安全违规。

只保留成功轨迹，会让离线评估无法覆盖真实失败分布。

### 2.3 Sample provenance

每个样本必须说明：

- 来自哪个 Session/Turn/Run；
- 上游 commit；
- Model/Provider 版本；
- Tool/Capability 版本；
- Environment image；
- Policy 和配置；
- 原始 Trace 范围；
- 是否经过截断、摘要或脱敏；
- 评价规则版本。

没有 provenance 的样本只能作为演示，不能作为可重复研究数据。

## 3. Replay 在闭环中的位置

### 3.1 State replay

State replay 重建 Event reducer、Session/Turn/Step 状态、UI projection 和指标。

它适合测试：

- 状态机；
- 事件兼容；
- 恢复器；
- Trace 投影；
- 指标重算。

它不应触发真实 Tool 或远程副作用。

### 3.2 Model replay

Model replay 使用相同或不同模型重新生成下一步输出。要记录：

- 原始 Context；
- Tool/Skill projection；
- Provider/model；
- sampling；
- Tool Result；
- Environment observation；
- replay mode。

Model replay 产生新 Run，不是原运行的继续。

### 3.3 Environment replay

Environment replay 在隔离 workspace、Sandbox 或 mock 服务中执行 Tool。它需要固定：

- base commit；
- 依赖；
- Environment image；
- Network；
- Secret policy；
- 时间和随机数；
- 外部服务替身。

即使环境固定，非确定性构建、网络和进程调度仍可能使结果不同。

### 3.4 Effect reconciliation

真实外部副作用不能通过 replay 重新创建，而应执行 reconciliation：

~~~text
saved operation_id/resource_id
  → query current external state
  → compare expected effect
  → classify completed/failed/unknown
~~~

这比重新发起创建请求更安全。

## 4. 在线事实与离线判断的边界

### 4.1 Runtime 提供什么

Runtime 提供：

- Tool Call 状态；
- Policy 决策；
- Environment reference；
- Process/Operation 状态；
- Model request metadata；
- Event 和因果关联。

### 4.2 Evaluator 提供什么

Evaluator 提供：

- acceptance criteria；
- 测试执行；
- diff 检查；
- 行为对比；
- 安全规则；
- 成本/延迟阈值；
- 人工或模型辅助评分。

Evaluator 不应修改原始 Runtime 事实。评价结果应作为新的 Judgment 记录关联原 Run。

### 4.3 Model judge 的边界

模型可以作为辅助评估器，适合：

- 总结差异；
- 归类失败；
- 判断文档或交互质量；
- 生成待人工复核的问题。

它不应单独负责：

- Secret 是否泄露；
- 文件是否真的写入；
- 进程是否终止；
- 远程 Operation 是否完成；
- 高风险权限是否越界。

## 5. 版本比较和实验设计

### 5.1 一个变更只改变一个主要变量

如果同时更换 Model、Prompt、Tool schema、Policy 和 Environment，就无法知道质量变化来自哪里。

至少要记录：

~~~text
control version
candidate version
changed component
unchanged components
sample set
randomization
evaluation rubric
~~~

### 5.2 同一任务的多次 Run

同一个 Sample 可以运行：

- control；
- candidate；
- retry；
- recovery；
- counterfactual。

它们共享 task/sample identity，但必须拥有独立 run_id。

### 5.3 结果不可直接横比的情况

以下情况需要谨慎：

- 仓库 base commit 不同；
- 依赖或测试 fixture 不同；
- Environment 权限不同；
- 任务分布变化；
- 评价规则变更；
- Provider 发生不可控路由变化；
- 样本被摘要或截断；
- 成本统计口径变化。

## 6. 失败归因闭环

### 6.1 Model failure

证据：

- 请求合法；
- Tool 和 Environment 可用；
- Policy 允许；
- 模型选择错误或无法修正。

改进方向：

- Prompt；
- Context；
- Model；
- Tool description；
- Planning。

### 6.2 Runtime failure

证据：

- 模型请求或 Tool 参数合理；
- Runtime 状态、队列、Policy、持久化或恢复错误。

改进方向：

- Step/Turn state；
- concurrency；
- retry；
- checkpoint；
- reducer；
- approval/interrupt。

### 6.3 Tool/Connector failure

证据：

- Tool schema 或参数有效；
- Environment 有能力；
- handler、协议或远程 Connector 失败。

改进方向：

- Tool implementation；
- Connector；
- timeout；
- error contract；
- idempotency。

### 6.4 Environment failure

证据：

- 依赖缺失；
- workspace 不一致；
- 网络或 Secret 不可用；
- Sandbox 或资源限制导致失败。

改进方向：

- provisioning；
- Environment binding；
- isolation；
- dependency image；
- network/credential policy。

### 6.5 Evaluation failure

证据：

- 任务结果和 Runtime 证据存在；
- evaluator、测试或 rubric 错误或不稳定。

改进方向：

- test fixture；
- acceptance criteria；
- evaluator；
- sample curation；
- flaky test handling。

## 7. 具体 Agent 的闭环入口

### 7.1 Codex

Codex 的 StepContext、Permission profile 和 Network approval 可以成为在线样本的执行上下文。[^codex-step] [^codex-permissions] [^codex-network]

闭环分析应保留：

- Step 边界；
- Permission/Network decision；
- Tool execution；
- Environment result；
- 最终验收。

否则离线数据只能看到模型和工具消息，无法解释权限和执行差异。

### 7.2 Pi

Pi 的 Agent Loop preparation/execution hook 和 Node Environment 可以捕获 Tool 调用和 Shell 输出。[^pi-prepare] [^pi-execute] [^pi-env]

它适合将宿主应用的运行记录转换为 trajectory sample，但宿主需要额外补充：

- acceptance；
- workspace snapshot；
- process cleanup；
- operation reconciliation；
- 样本版本。

### 7.3 OpenCode

OpenCode 的 Workspace provider、Session execution claim 和 Worker ownership 应进入 Sample provenance。[^opencode-workspace] [^opencode-execution]

服务化执行中，如果离线样本没有记录 claim 和 workspace instance，control/candidate 结果可能来自不同资源，比较无效。

### 7.4 Gemini CLI

Gemini CLI 的 Policy Engine 和 Shell execution 使在线记录可以区分 policy decision、shell result 和 Environment effect。[^gemini-policy] [^gemini-shell]

离线评估不应仅重放历史 shell output，而应在固定 Environment 中重新执行测试，或明确标记为 observation-only sample。

### 7.5 OpenHands

OpenHands 的 Agent Server、Sandbox、Workspace 和外部服务要求样本跨服务保存 provenance。[^openhands-adapter]

需要明确样本中保存的是：

- Agent trajectory；
- Sandbox execution；
- Workspace artifact；
- 远程服务状态；
- 还是仅保存用户可见结果。

这些样本类型不能混为一谈。

### 7.6 Kimi Code

Kimi Code 的 Task persistence、Tool Policy 和 Subagent metadata 为父子 Run 的样本归因提供入口。[^kimi-task] [^kimi-policy] [^kimi-subagent]

离线评价应分别保存父 Task、子 Agent Run、Tool decision 和父任务 acceptance，不能把子 Agent trajectory 平铺后丢失层级。

### 7.7 mini-SWE-agent

mini-SWE-agent 的 trajectory 和 LocalEnvironment 适合构建轻量 benchmark sample。[^mini-environment] [^mini-local]

但测试、patch acceptance、成本和恢复能力主要由外部 harness 提供；将其与具有完整 Runtime Event 的 Agent 直接比较时，必须说明证据覆盖范围不同。

## 8. 数据脱敏与样本治理

### 8.1 脱敏对象

需要处理：

- API token；
- SSH key；
- Cookie；
- 用户路径；
- 私有源代码；
- 客户数据；
- 远程 URL；
- Prompt 中的机密；
- Tool output；
- Trace metadata。

### 8.2 脱敏不能破坏因果

应保留稳定的替代 identity：

~~~text
真实 token → credential:token-1
真实仓库 → repo:private-7
真实用户 → user:subject-3
真实路径 → workspace:root/src
~~~

同一个样本内的替代 identity 应保持一致，跨样本是否一致则需要根据隐私策略决定。

### 8.3 保留和删除策略

原始 Trace、脱敏 Trace、Evaluation Sample 和聚合指标的保留周期可以不同。删除原始数据后，必须知道哪些结论将无法重算。

## 9. 闭环的质量控制

### 9.1 Data quality

检查：

- Event 是否有 gap；
- identity 是否冲突；
- 时间是否单调；
- Tool Result 是否截断；
- Environment fact 是否缺失；
- Operation 是否 unknown；
- 评价证据是否完整。

### 9.2 Evaluator quality

检查：

- 测试是否 flaky；
- rubric 是否覆盖用户目标；
- 人工判定是否一致；
- Model judge 是否存在偏差；
- 失败样本是否被系统性排除。

### 9.3 Metric quality

检查：

- 分母是否稳定；
- 失败运行是否保留；
- 重试是否重复计数；
- 父子 Agent 是否重复计费；
- 版本变化是否被记录；
- 安全违规是否被平均分稀释。

## 10. 验证方案

1. 从一次真实运行生成原始 Trace、脱敏 Trace 和 Evaluation Sample，检查三者的字段和语义差异。
2. 删除 UI 和 Metric projection，仅使用 canonical Event、Environment fact 和 Operation 状态重建评估输入。
3. 在同一任务集上更换 Prompt、Tool schema、Model 和 Policy，逐次只改变一个变量，检查归因是否清楚。
4. 构造成功、首次失败后恢复成功、Environment 失败、安全拒绝和 unknown Operation 样本，验证数据集不只包含成功案例。
5. 对远程副作用执行 replay，确认系统进行 reconciliation 而不是重复创建资源。
6. 对同一 Sample 运行 control 和 candidate，检查 base commit、Environment、Tool、Policy 和 rubric 是否一致。
7. 删除 Secret 及私有路径后重新生成 Trace，验证仍可关联 Session、Turn、Step、Tool 和 Operation。
8. 重新定义评价规则版本，验证旧 Run 可以在新 rubric 下重新评价，同时保留旧结论。

## 设计原则

### 原则一：在线记录事实，离线生成判断

Runtime 负责保存可关联事实，Evaluator 根据版本化标准生成 Judgment，不能让 UI 或模型文本成为唯一真相。

### 原则二：样本必须保留 provenance

Task、仓库、Environment、Model、Tool、Policy、Runtime 和 Rubric 版本缺一不可，否则结果不可比较。

### 原则三：失败样本是闭环的一等输入

没有失败、恢复、拒绝和 unknown 样本，离线 Evaluation 只会优化正常路径，无法改善真实 Runtime。

### 原则四：副作用通过 reconciliation 评价

外部资源不能通过 replay 重复创建；应使用 operation identity 查询真实状态，再生成评价结论。

### 原则五：指标必须能反馈责任模块

Evaluation 的输出不只是分数，还应指出改进应该落在 Model、Prompt、Tool、Runtime、Policy、Environment 或 Evaluator。

## 未确认事项

- 各 Agent 是否提供完整的在线 Trace 到离线 Dataset 导出链，需要逐项目分析产品和部署代码；
- Provider 账单、缓存命中和真实成本是否可关联到 Run，需要服务端数据；
- 各 Agent 的样本脱敏和保留策略通常不在核心 Runtime 中，需要部署配置；
- Model judge 的实际质量和偏差需要独立实验；
- 复杂远程 Operation 的 reconciliation 需要服务端 API 和真实环境验证。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-SWE-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
