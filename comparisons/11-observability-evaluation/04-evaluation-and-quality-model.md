---
title: Coding Agent 的 Evaluation：从任务完成到执行质量
series: Coding Agent 的 Observability / Evaluation
part: 4
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Evaluation：从任务完成到执行质量

## 结论

Coding Agent 的 Evaluation 不能只问“最后是否完成”，因为完成至少包含五个不同问题：

1. 代码或资源是否达到用户目标；
2. 任务是否通过了规定的验收；
3. Agent 是否使用了正确的工具和 Environment；
4. 过程是否可恢复、可解释、没有未收敛副作用；
5. 成本、延迟和权限是否在可接受范围内。

因此，Evaluation 不应是一个布尔值，而应是一个带证据的判断：

~~~text
Task outcome
  + acceptance evidence
  + environment evidence
  + safety/policy evidence
  + efficiency/cost evidence
  + recovery evidence
~~~

模型最后说“已完成”只能作为 Model Output；测试退出码只能作为 Environment Observation；Git diff 只能说明文件变化；真正的任务评价必须由明确的验收标准和独立证据组合而成。

本文的核心判断是：

> Coding Agent 的 Evaluation 对象不是模型回答，而是一次由 Agent、Runtime、Environment 和外部验收器共同完成的任务执行。

## 1. 评价对象是什么

### 1.1 Task、Run 和 Outcome

需要区分：

- Task：用户希望达到的目标；
- Run：Agent 为完成目标实际执行的一次运行；
- Outcome：运行后可验证的结果；
- Judgment：根据标准对结果作出的评价。

同一个 Task 可以有多次 Run。一次 Run 失败后重试，不应覆盖前一次运行，否则无法分析失败原因和恢复成本。

~~~text
Task
  ├─ Run A → failed
  ├─ Run B → partial
  └─ Run C → accepted
~~~

### 1.2 Success 不是单一事实

至少要区分：

~~~text
model_finish
tool_success
environment_success
test_pass
task_acceptance
policy_compliance
resource_cleanup
~~~

这些结果可能相互冲突：

- 测试通过，但用户目标没有实现；
- 代码正确，但 Agent 泄露了 Secret；
- Task 完成，但留下后台进程；
- Model Request 失败，但之前的 Tool 已经完成修改；
- Tool 返回成功，但远程 Operation 最终失败。

### 1.3 Evaluation 的主体

评价可以由不同主体完成：

- Runtime：判断状态是否收敛；
- Environment：返回进程、文件和服务事实；
- Test harness：运行测试和静态检查；
- User：确认目标是否满足；
- External evaluator：比较 patch、行为或规范；
- Model：提供解释或自评。

模型自评可以作为辅助信号，但不应成为高风险任务的唯一验收器。

## 2. Evaluation 的证据层级

### 2.1 目标定义

首先要知道“什么算完成”。目标可能来自：

- 用户自然语言；
- Issue acceptance criteria；
- 测试用例；
- Patch 约束；
- API contract；
- 代码审查规则；
- 安全和权限要求。

自然语言目标需要被转换为可检查的条件，否则成功率没有稳定分母。

### 2.2 代码证据

代码证据包括：

- diff；
- 文件 hash；
- AST 或静态检查；
- 编译结果；
- 类型检查；
- 单元测试；
- 集成测试；
- lint 和格式检查。

代码证据说明仓库状态，不自动说明用户目标已经满足。

### 2.3 行为证据

行为证据包括：

- 测试输入输出；
- API response；
- CLI exit code；
- 浏览器交互结果；
- 服务端 resource state；
- 性能和资源消耗。

行为证据比 diff 更接近用户目标，但仍需要知道测试覆盖了什么。

### 2.4 过程证据

过程证据包括：

- Tool Call 是否被允许；
- Environment 是否在正确 workspace；
- 使用了哪个模型和 Tool schema；
- 是否发生重试；
- 是否有超时、取消和未知状态；
- 是否清理了后台进程和远程资源。

过程证据决定结果是否可接受、可解释和可复现。

### 2.5 人工验收

对于视觉效果、产品体验、复杂行为和安全影响，自动测试可能不足。人工验收应记录：

- 验收主体；
- 验收范围；
- 验收时间；
- 使用的版本和 Environment；
- 通过、拒绝或部分通过；
- 拒绝原因。

“用户没有继续投诉”不能替代明确验收。

## 3. 评价维度

### 3.1 Correctness

代码或资源是否正确实现目标。需要结合测试、diff、契约和人工检查。

### 3.2 Completeness

是否完成全部要求，而不是只完成最容易验证的部分。任务可能有多个 acceptance criteria，需要逐项评价。

### 3.3 Robustness

在边界输入、错误条件、重复执行和恢复后是否仍然正确。

### 3.4 Efficiency

完成任务使用了多少 Model Request、Tool Call、Token、时间和 Environment 资源。

效率不能独立于正确性。更少调用但结果错误，不是更高效。

### 3.5 Safety

是否越过 Workspace、Network、Secret、Policy 和用户审批边界。

安全违规通常不能被其他维度的高分抵消。

### 3.6 Recoverability

发生断线、失败、取消、Worker 切换或版本变化后，是否能恢复或明确进入未知状态。

### 3.7 Explainability

是否能用 Trace 和 Environment evidence 说明为什么得出结论。

## 4. 评价模型

### 4.1 不建议简单加权平均

简单模型：

~~~text
score = correctness × 0.5
      + efficiency × 0.2
      + cost × 0.1
      + safety × 0.2
~~~

容易掩盖安全违规或未完成目标。更可靠的结构是门槛加多维报告：

~~~text
if safety_fail:
    outcome = rejected
elif acceptance_fail:
    outcome = failed
else:
    report correctness / efficiency / cost / recovery
~~~

### 4.2 Hard gates

典型 Hard Gate：

- 必须通过编译或指定测试；
- 不得修改受保护路径；
- 不得泄露 Secret；
- 不得留下未授权后台 Operation；
- 必须得到用户批准；
- 必须在指定 Environment 中执行。

Hard Gate 失败后，不能靠较低成本或较短延迟抵消。

### 4.3 Partial outcome

任务可能部分完成：

~~~text
criteria A = pass
criteria B = pass
criteria C = fail
criteria D = unknown
~~~

系统应保留每个 criterion 的证据，不要把它压成“基本完成”。

### 4.4 Evidence graph

一个评价结论应能回指证据：

~~~text
criterion
  → check
  → test/process/file/remote observation
  → Environment fact
  → Run/Step/Tool identity
~~~

如果结论不能回指具体检查和事实，它只能算主观摘要。

## 5. Coding Agent 的具体验收机制

### 5.1 Patch-based task

对于修改代码的任务，基础验收链是：

~~~text
workspace snapshot
  → diff inspection
  → build/type check
  → focused tests
  → broader tests
  → acceptance criteria
~~~

Diff 为空可能表示任务无需修改，也可能表示 Agent 没有执行；需要结合用户目标和 Tool/Model trace 判断。

### 5.2 Command-based task

对命令和脚本任务，不能只看 exit code。还应检查：

- stdout/stderr 是否被截断；
- process 是否真的退出；
- 子进程是否仍在运行；
- 文件和资源是否改变；
- 命令是否使用正确 workspace；
- 网络和 Secret 是否符合 Policy。

### 5.3 Remote-operation task

远程任务需要：

~~~text
request accepted
  → operation started
  → operation status queried
  → resource state confirmed
  → cleanup/ownership confirmed
~~~

HTTP 200 或 Tool Result accepted 只能证明请求阶段成功。

### 5.4 Interactive task

交互任务需要评价：

- 用户输入是否被正确处理；
- approval 是否作用于正确 Tool；
- interrupt 是否真正终止；
- UI projection 是否与 Runtime fact 一致；
- 用户是否能理解当前 unknown 状态。

## 6. 各 Agent 的具体 Evaluation 入口

### 6.1 Codex：Step 和 Tool execution 是评价分解点

Codex 的 StepContext、Permission profile 和 Network approval 提供了把任务执行拆成 Step、权限和 Environment 证据的入口。[^codex-step] [^codex-permissions] [^codex-network]

Codex 的评价不应只看最终 assistant message，而应关联：

- Step 是否完成；
- Tool 是否被允许；
- Network 请求是否获批；
- Environment 是否在正确范围；
- 文件或命令结果是否达到验收标准。

### 6.2 Pi：需要宿主补充验收器

Pi 的 Agent Loop、Tool preparation/execution hook 和 Node Environment 提供了调用和命令输出，但任务级 acceptance、workspace diff、后台资源和长期 Operation 依赖宿主应用。[^pi-prepare] [^pi-execute] [^pi-env]

因此 Pi 的评价能力具有明显的可组合性：宿主可以实现轻量 trajectory，也可以增加独立测试和验收器，但后者不是 Agent Loop 自动保证的。

### 6.3 OpenCode：服务化 Task 需要将 Worker 和 Workspace 纳入评价

OpenCode 的 Workspace provider 与 Session execution claim 意味着同一个任务可能由不同 Worker 或 Workspace instance 完成。[^opencode-workspace] [^opencode-execution]

评价必须确认执行 claim、workspace revision 和最终文件状态，否则一次任务可能在错误 Worker 或错误 workspace 上“成功”。

### 6.4 Gemini CLI：Shell 成功只是过程证据

Gemini CLI 的 Policy Engine 和 Shell execution 分离。[^gemini-policy] [^gemini-shell]

评价应区分：

~~~text
policy allowed
shell process exited 0
tests passed
workspace meets criteria
~~~

四者不是同一个指标。

### 6.5 OpenHands：Sandbox 结果与任务验收跨越服务边界

OpenHands 的 Agent Server、Sandbox、Workspace 和远程服务意味着评价需要跨越 Agent event、Sandbox execution、文件变化和外部 resource state。[^openhands-adapter]

Sandbox 中的命令成功，不自动等于远程服务或最终 Workspace 满足目标。

### 6.6 Kimi Code：父 Task 必须吸收子 Agent 的验收结果

Kimi Code 的 Task persistence、Tool Policy 和 Subagent metadata 提供了将子任务执行和父任务目标关联起来的入口。[^kimi-task] [^kimi-policy] [^kimi-subagent]

子 Agent 输出应先成为父 Agent 的 evidence，再由父 Task 的 acceptance 规则判定，不能直接把子 Agent 的完成文本作为父任务成功。

### 6.7 mini-SWE-agent：任务评价依赖外部 Harness

mini-SWE-agent 的 trajectory 和 LocalEnvironment 记录模型、命令和输出，但最小 Runtime 不自动提供完整的质量评价、Workspace rollback 或远程 operation reconciliation。[^mini-environment] [^mini-local]

因此它通常需要外部 benchmark harness 负责 patch 检查、测试运行、提交判定和 reward 计算。

## 7. 指标定义

### 7.1 Task success rate

分母必须明确：

~~~text
accepted tasks / eligible tasks
~~~

是否包含用户中断、环境失败、配置错误和不可评估样本，必须预先规定。

### 7.2 First-attempt success

衡量首次 Run 是否通过，不把重试成功隐藏在总体成功率中。

### 7.3 Recovery success

衡量发生故障后，系统是否在不重复副作用的情况下恢复到可接受状态。

~~~text
recovered accepted runs / runs requiring recovery
~~~

### 7.4 Tool efficiency

可记录：

- 每个 accepted task 的 Tool Call 数；
- 每个成功 criterion 的 Tool Call 数；
- 无效调用率；
- 重试率；
- 被拒绝调用率；
- 并行度；
- Tool latency。

工具调用少不一定更好，必须与正确性和安全性联合观察。

### 7.5 Cost attribution

至少区分：

- input tokens；
- output tokens；
- cached tokens；
- tool/environment cost；
- child Agent cost；
- retry cost；
- failed-run cost。

失败运行的成本不能从数据集中删除，否则系统会高估平均效率。

### 7.6 Safety violation rate

安全违规应独立统计：

- 未授权 Tool；
- Workspace escape；
- Secret exposure；
- Network policy bypass；
- 未清理后台 Operation；
- 错误继承子 Agent 权限。

安全违规通常是 Hard Gate，而不是平均分中的一个小项。

## 8. 评价数据的版本和可比性

### 8.1 Sample identity

每个 Evaluation sample 至少包括：

~~~text
sample_id
task_definition_version
repository_commit
environment_image
model/provider/version
prompt/config version
tool/capability version
evaluation rubric version
~~~

缺少这些字段，跨版本比较可能把 Runtime、模型、仓库和评价规则变化混在一起。

### 8.2 Repository state

Coding Agent 任务高度依赖仓库状态。必须记录：

- base commit；
- initial uncommitted changes；
- dependency lock；
- test fixtures；
- target branch；
- final diff；
- generated artifacts。

只保存问题描述而不保存代码基线，无法判断结果差异来自 Agent 还是仓库变化。

### 8.3 Environment state

还要记录 OS、工具版本、Sandbox image、Network mode、Secret policy、资源限制和时区/时间相关配置。

### 8.4 Rubric version

同一 patch 使用不同测试或人工标准，结果可能不同。评价规则必须有版本，历史结果不能无标记地混合。

## 9. 失败分类

### 9.1 Model failure

模型没有理解目标、生成错误参数或无法修正错误。

### 9.2 Runtime failure

状态、Context、Policy、调度、持久化或恢复逻辑错误。

### 9.3 Tool failure

工具 schema、handler、Connector 或协议失败。

### 9.4 Environment failure

依赖、权限、网络、Sandbox、Workspace 或资源不足。

### 9.5 Evaluation failure

验收器错误、测试不稳定、证据缺失或样本配置错误。

这些失败类别必须分开。把全部失败归因给模型，会导致错误的产品改进方向。

## 10. 评价与产品反馈

Evaluation 的目的不是只生成排名，还要反馈到 Runtime 设计：

~~~text
failure evidence
  → classify owner
  → change Prompt/Tool/Policy/Environment
  → rerun fixed sample
  → compare outcome and cost
~~~

例如：

- Tool 参数错误率高，可能需要改 schema 或增加 Skill；
- 任务正确但成本高，可能需要改 Context、缓存或规划；
- 重试后成功率高但副作用重复，说明 Operation 和 recovery 不安全；
- 测试通过但用户拒绝率高，说明 acceptance rubric 不完整；
- 子 Agent 提高成功率但成本和延迟失控，说明委派策略需要调整。

## 11. 验证方案

1. 为一个多验收条件的代码任务分别记录 diff、编译、测试、人工验收和最终文件状态，验证是否能得到逐条件结果。
2. 注入 Tool schema 错误、Network 失败、Workspace 变化、Provider timeout 和测试失败，确认失败归因不会全部落到模型。
3. 对同一 Task 执行首次失败、恢复成功和重试成功三次运行，分别统计 first-attempt、recovery 和 overall success。
4. 运行一个有子 Agent 的任务，比较父任务成本、子任务成本和重试成本，验证不会重复计费。
5. 制造一次 accepted-but-running 的远程 Operation，确认任务评价在资源状态确认前不会标记为最终成功。
6. 修改评价规则版本，重新评估同一 Run，验证历史结果可以并存而不是被覆盖。
7. 删除模型最终文本，只保留 Environment facts 和验收器输出，验证任务是否仍能得到可解释评价。

## 设计原则

### 原则一：成功由验收证据定义

模型完成文本、Tool 返回成功和进程退出 0 都只是证据，不能单独定义任务成功。

### 原则二：安全和正确性是门槛，不是平均分

未授权副作用、Secret 泄露、Workspace 越界和未收敛 Operation 不能被效率或成本优势抵消。

### 原则三：Task、Run 和 Outcome 分离

同一个任务可以有多次运行和不同结果；失败 Run 必须保留，不能被后续成功覆盖。

### 原则四：指标必须绑定版本和分母

模型、仓库、Environment、Tool、Policy、Rubric 和样本范围变化时，指标不能直接横向比较。

### 原则五：评价结果必须能反馈责任模块

Evaluation 不仅要说失败，还要指出失败发生在模型、Runtime、Tool、Environment 或验收器哪一层。

## 未确认事项

- 各 Agent 是否有独立、可版本化的 acceptance evaluator，需要结合 benchmark 和产品实现确认；
- Provider usage 和成本字段是否完整，不能仅从客户端请求推断；
- 测试通过与用户目标满足之间的差异，需要结合具体任务集和人工验收；
- 子 Agent 成本、延迟和成功是否已被父任务正确归因，需要运行实验；
- 安全违规是否作为 Hard Gate，取决于具体产品的 Policy 和 UI 行为。

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
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
