---
title: mini-SWE-agent Runtime/Harness Analysis
reviewed_at: 2026-09-15
upstream_repository: https://github.com/SWE-agent/mini-swe-agent
upstream_ref: v2.4.5 plus maintenance commits
upstream_commit: 38c01a19ed1a58dd17dd7c95010e4f69d059c777
status: current
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# mini-SWE-agent Runtime/Harness 分析

本文研究 mini-SWE-agent 从极简任务循环形成的当前 Runtime/Harness，固定在 `v2.4.5` 之后的 commit [`38c01a1`](https://github.com/SWE-agent/mini-swe-agent/commit/38c01a19ed1a58dd17dd7c95010e4f69d059c777)。它不是 SWE-agent 全功能产品的替代 UI，而是一个强调可读性、可配置性和 benchmark 可复现性的最小 agent harness。

## 结论

mini-SWE-agent 的架构核心是三个可替换对象：`Agent`、`Model`、`Environment`。`DefaultAgent.run()` 初始化 system/task 消息，然后重复 `query → execute_actions → observation`，直到提交、限制、格式错误或异常终止。它把 coding agent 的最小闭环暴露出来，同时把模型协议、执行后端和交互确认留在插件边界。

它的关键不是“少几个类”，而是主动拒绝产品化状态：没有中心化 session service、没有独立 tool registry、没有跨 turn permission plane、没有 context graph。一次运行的权威状态就是 `messages` 加上 `model/env/config`，trajectory 是运行结束时的可审计产物。因此 mini-SWE-agent 非常适合做 harness 基线：可以直接观察 coding agent 最小闭环哪些部分是必要的，哪些是 Codex/Cline/Gemini 为产品体验增加的层。

## Runtime 图

```text
CLI/config
   ↓ factory
Agent(Model, Environment, AgentConfig)
   ↓ step
Model.query(messages) → action parser → Environment.execute(action)
   ↑                         ↓
   └──── observation messages ┘
   ↓
trajectory JSON / exit status / submission
```

`mini` CLI 从配置合并 `agent/model/environment/run`，通过 factory 构造三个对象，再调用 `agent.run(task)`；见 [`run/mini.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/run/mini.py)。

### Step 的精确定义

mini-SWE-agent 的 `step()` 不是“一个用户 turn”，而是一次完整的 `Model.query → actions → Environment.execute → observation messages`。`run()` 是一次 task run；`InteractiveAgent` 在 action 执行前插入 confirm/human/yolo，在命令被中断时把用户输入作为 message 加回 trajectory。它没有单独的长期 session 抽象：用户追加任务会通过 `UserNewTask` 异常打断当前 run，再由交互层决定是否继续。

`DefaultAgent` 使用异常作为控制流协议：`FormatError` 将模型格式错误重新变成 observation，连续达到阈值后退出；`LimitsExceeded`、`TimeExceeded`、`Submitted` 和 `InterruptAgentFlow` 将终止原因编码成 exit message。这个设计简单但重要：终止状态仍进入 messages/trajectory，评测可以区分模型错误、超时、成本限制、用户中断和成功提交。

## 关键组件

### 1. Agent：显式 step loop

`DefaultAgent` 保存 messages、模型调用数、成本、连续格式错误计数和起始时间。`query()` 检查 step/cost/wall-time 限制并调用模型；`execute_actions()` 把模型产生的 action 交给 environment，再把结果格式化为 observation。`InteractiveAgent` 在此之上增加 human/confirm/yolo、KeyboardInterrupt、用户拒绝和追加任务。

### 2. Model：协议适配而非策略中心

Model 接收完整 message list，返回带有 actions/usage/cost 的消息；LiteLLM、OpenRouter、Portkey 和 text-based model 通过独立适配器接入。动作既可以是 tool-call，也可以由文本解析产生，说明 harness 的稳定边界是 message/action contract，而不是某个 provider 的工具协议。

### 3. Environment：显式执行后端

Environment 不是抽象的 cwd 字符串，而是 `execute(action)`、template vars 和 serialize contract。LocalEnvironment 直接在配置 cwd 中运行 bash，并在超时杀死进程组；Docker、Singularity、bubblewrap、SWE-rex/Modal 等实现把同一 agent loop 投射到不同隔离后端。环境配置和类型会被写入 trajectory，增强 benchmark 复现性。

但它与 Environment-owned execution 仍有明显距离：`LocalEnvironment` 默认取当前进程 cwd，每个动作通过独立 `subprocess.Popen(shell=True)` 执行，shell 内的 `cd` 和 export 不会自然跨 action 持续；环境状态主要是外部文件系统，而不是 harness 内的 session state。官方 FAQ 也明确说明默认 action 独立执行。安全性来自替换 backend（Docker/Singularity/bubblewrap/Modal），不是由一个中心 policy engine 对每个 tool call 进行多阶段授权。

### 4. Trajectory：运行记录即主要持久化

`serialize()` 保存配置、模型统计、全部 messages、版本、exit status、submission、model/environment metadata，并使用 `mini-swe-agent-1.1` trajectory format。它更像可审计的实验轨迹，而不是 Codex/Cline 那种面向长会话恢复的 session store。

## 从诞生到当前的架构演进判断

本次本地 history 已包含约 1,016 个 commit；从历史可识别出以下架构节点：

1. **模型协议转向 tool-call first（`89cd907`/`3ec6545`/`29` 系列，2026-01-29）**：tool-calling classes 成为默认，模型层从文本解析基线迁移为统一 action/message contract，同时保留 text-based adapters。
2. **Agent/Environment 可由 config/CLI 替换（`5dd250e`，2026-02-05）**：run script 不再硬编码实现，用户可以注入 agent/env class；这是从 benchmark script 到可复用 harness 的关键变化。
3. **Environment 后端扩展（`3cb9254`，2026-02-18；`42b0db1`、`9f56223`）**：加入 Contree，并持续修复 SWE-ReX/Modal/容器执行；执行隔离成为一等扩展点。
4. **限制与异常成为可审计状态（`055c07a`、`6e0413c`、`2afd0fb`、`3df30a4`）**：wall-clock kill、连续格式错误、非交互 limit breach 和完整 malformed response 被纳入 trajectory，而不是直接抛出导致记录丢失。
5. **Benchmark surface 扩展（`9654611`，2026-05-21）**：ProgramBench runner 与 SWE-bench 并列，trajectory/workspace artifact 成为可评估输出。
6. **当前稳定化（`9defc4e`、`147121f`，2026-06/07）**：进程组超时杀死、tool-call malformed/truncation 区分、配置 UTF-8 等修复，体现其目标仍是可重复评测而不是复杂产品会话。

因此 mini-SWE-agent 的演进是“可组合性和评测可靠性增强”，不是“中心 runtime 不断膨胀”。

## 与产品型 coding agent 的差异

它的“session”主要是一次 `run()` 和一份 trajectory；“turn”基本等价于一次 `query + action execution + observation`；“step”是 agent 的单次模型调用。权限是 `InteractiveAgent` 的 confirm/yolo 行为，不是跨会话的策略平面；环境是可替换执行器，不是由 workspace、身份和持久化策略共同管理的 environment-owned execution。正因如此，它适合作为最小基线，帮助区分 agent loop 本身与产品化 harness 的附加层。

官方文档直接把它定位为 simple control flow、快速本地 CLI、稳定 sandbox/evaluation 和 fine-tuning/RL scaffold，并说明默认只有 bash action、不使用模型 tool-calling interface。这个产品定位与源码完全一致：它优化的是可读、可替换、可批量评估，不是持续协作、权限记忆、session fork 或多 surface UX。参见 [Agent control flow](https://mini-swe-agent.com/v2/advanced/control_flow/)、[Environments](https://mini-swe-agent.com/latest/advanced/environments/)、[DefaultAgent API](https://mini-swe-agent.com/latest/reference/agents/default/) 和 [FAQ](https://mini-swe-agent.com/latest/faq/)。

## 未确认事项

- 本次使用本地约 1,016 个 commit；仍未对每个历史节点 checkout 并运行完整 benchmark。
- 未运行 Docker/Modal/SWE-rex，隔离和超时行为仅由源码确认。
- 当前 trajectory 是保存结果，不等价于可从中断点恢复的 session checkpoint；是否存在上层恢复工具需要另行研究。

## 设计原则

mini-SWE-agent 的设计原则与 Codex、Gemini CLI、Cline 不同：它不是把所有产品能力收进一个 central runtime，而是刻意把最小闭环、可替换边界和评测可复现性放在第一位。以下原则均以当前源码和历史提交为依据。

### 原则 1：用最小闭环表达 Agent 的本质

`DefaultAgent` 只需要完成四个动作：初始化消息、向模型查询、执行模型提出的 action、把 observation 加回消息。它没有把 planning、memory、tool registry、permission database 或 session server 作为内核依赖。

这一选择使 `step()` 的语义极其清晰：

```text
messages[n]
  → Model.query
  → assistant message + actions
  → Environment.execute(actions)
  → observation messages
  → messages[n+1]
```

这个闭环是一个 coding agent 的最小可运行定义。其它项目增加的审批、压缩、并发、远程执行和 UI 状态，都可以被理解为在这个闭环前后插入的控制层。

### 原则 2：Agent、Model、Environment 三方解耦

Agent 不知道具体模型 provider，也不拥有文件系统；Model 不直接执行命令，也不决定是否需要用户确认；Environment 不决定下一步推理，只执行 action 并返回结果。三个对象通过少量 Python contract 协作。

这不是传统 MVC 的三层，而是三种可独立替换的实验变量：

| 变量 | 可替换内容 | 不应承担的责任 |
| --- | --- | --- |
| Agent | loop、交互模式、终止策略 | provider API、容器启动 |
| Model | API、tool/text parser、cost/retry | 文件修改、审批 UI |
| Environment | local、Docker、Singularity、Modal | 选择模型、上下文推理 |

因此研究者可以固定 Agent，替换 Model；固定 Model，替换 Environment；或通过 config/CLI 替换 Agent class。这种组合实验能力是它区别于产品型 coding agent 的核心价值。

### 原则 3：配置是组装语言，不是隐藏全局状态

`mini` CLI 先加载 YAML，再递归合并命令行 key-value override，最后通过 `get_model`、`get_environment`、`get_agent` factory 组装运行时。配置中可以直接指定 `agent_class`、`model_class` 和 `environment_class`。

配置因此承担 dependency injection 和实验复现两项职责：同一条命令可以明确记录模型、agent mode、cost limit、environment backend、observation template 和 output path。代价是配置错误会在启动阶段暴露，且不存在复杂服务帮用户自动协调不兼容能力。

### 原则 4：一切重要运行状态都进入消息或 trajectory

Agent 的消息列表是主要的 live state；`serialize()` 则把 config、model stats、version、exit status、submission、messages、model metadata 和 environment metadata 写入 trajectory。格式错误、用户中断、限制超时和成功提交都通过 exit/extra message 表达。

这形成一个非常强的可审计性原则：只要拿到 trajectory，就可以知道模型看到了哪些消息、产生了哪些 action、环境返回了什么、运行为何结束，以及使用了哪种模型和环境。它牺牲了高效的增量 session store，却换来了 benchmark replay 和故障复盘的简单性。

### 原则 5：用异常统一非正常控制流，但不丢失上下文

`FormatError`、`UserInterruption`、`LimitsExceeded`、`TimeExceeded`、`Submitted` 都继承 `InterruptAgentFlow`。`run()` 捕获这些异常，将携带的 message 加回 trajectory，然后根据最后消息 role 是否为 exit 决定是否结束。

这使异常同时承担两个职责：Python 控制流跳转，以及模型可见/评测可见的状态记录。例如格式错误可以把纠错提示作为下一轮 observation；用户中断可以携带评论；环境检测到 magic submit string 可以生成最终 submission。未继承 `InterruptAgentFlow` 的异常则记录 traceback 后重新抛出，避免把程序错误伪装成正常 agent 结果。

### 原则 6：错误要反馈给模型，而不是只反馈给操作者

模型输出 malformed tool call、环境返回非零 code、命令超时或工具参数缺失时，系统尽量生成结构化 observation 交回模型。`format_error_template`、`observation_template`、`exception_info` 和完整 response 保存机制共同保证模型有机会修正下一步行为。

这一原则使 loop 具有闭环自修复能力，但也有边界：模型可能在重复格式错误中浪费预算，因此 `max_consecutive_format_errors`、step limit、cost limit 和 wall-clock limit 是必要的终止保险。

### 原则 7：权限是交互模式，不是跨会话策略系统

`InteractiveAgent` 提供 human、confirm、yolo 三种 mode。confirm 在 action batch 执行前询问用户；用户可以接受、拒绝并附加评论，或切换到 human mode；KeyboardInterrupt 也被转成用户输入 message。

这是一种轻量但明确的 approval 设计：审批发生在 `execute_actions()` 之前，作用域是当前 run/当前 action batch；它不建立持久 allow/deny rules，不跟踪 workspace trust，也不把审批策略注入所有 future sessions。与 Codex/Gemini 的 policy plane 相比，这是有意保持的复杂度边界。

### 原则 8：Environment 是执行后端，而不是完整 Workspace identity

`LocalEnvironment` 的核心是 `execute(action, cwd, timeout)`；DockerEnvironment 则在初始化时创建长存活 container，每次 action 用 `docker exec` 在指定 cwd 执行。Singularity、bubblewrap、Contree、SWE-ReX/Modal 扩展的是后端，不改变 Agent loop。

环境配置会序列化进 trajectory，但 session identity、工具权限、远程 runtime URL 和 workspace event store 不属于 Environment contract。默认本地环境直接使用当前 cwd，action 间 shell 的 `cd`/export 不自动持久化；这正是“执行 backend”而不是“environment-owned product runtime”。

### 原则 9：隔离通过 backend 选择获得

mini-SWE-agent 不在 Agent 内部实现复杂 sandbox policy。需要隔离时选择 Docker、Singularity、bubblewrap、Contree 或 SWE-ReX/Modal；需要快速本地实验时使用 LocalEnvironment。安全、性能、网络和可复现性成为 environment 配置的取舍，而不是每个 tool call 的通用策略判断。

官方文档把 local 明确描述为 host subprocess、把 Docker/Singularity 描述为隔离 backend，并建议 SWE-bench 使用 isolated environments。这说明项目把“安全执行”当作 deployment/backend 选择，不把它伪装成所有环境都具备的统一安全保证。

### 原则 10：模型适配器隔离 provider 与 action protocol

`LitellmModel` 负责 completion、retry、cost calculation、tool declaration、thinking block reorder、cache-control 和 action parsing；OpenRouter、Portkey、Requesty 与 text-based model 通过相同方向的 adapter 接入。

Model contract 允许两种历史路径并存：tool-call API 直接生成 actions，text-based adapter 从模型文本中解析 command。2026-01-29 的 tool-call-first 演进把 tool-calling classes 设为默认，但没有让 Agent loop 依赖某一家 API。这是“协议归一化、provider 保持可替换”的原则。

### 原则 11：成本、步数和墙钟是 runtime 的第一类终止条件

Agent 在每次 query 前检查 `step_limit`、`cost_limit` 和 `wall_time_limit_seconds`。Model 在 response 后累计 cost；Environment 在 command 超时时杀死整个 process group/container command，避免子进程泄漏。

这些限制不是 UI 统计，而是 loop termination contract。它们保证 benchmark 在异常模型、挂起命令和昂贵 provider 下仍能结束，并使结果中的 exit status 可用于评估失败类型。

### 原则 12：成功提交必须由 Environment 识别

默认 prompt 要求模型执行 `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`；Local/Docker 等 Environment 检查输出首行 magic string，在 return code 为 0 时抛出 `Submitted`，后续内容成为 submission。

这是一种反向控制：模型通过命令向 Environment 发出终止信号，Environment 再通过异常把终止事实交回 Agent。它比让模型在自然语言中说“完成了”更容易被 benchmark 可靠解析，但也使终止协议依赖 shell 输出格式。

### 原则 13：Trajectory 优先于可恢复 Session

trajectory 会在每次 step 的 finally 中保存，因此崩溃或中断时仍尽量保留部分运行记录；但该文件主要是结果/审计格式，不是可直接注入 Agent 继续运行的 checkpoint。它没有 Codex 的 rollout/thread store，也没有 Gemini 的 chat reconstruction/context projection。

这个选择将问题拆开：mini-SWE-agent 负责“把一次实验记录完整”，上层 benchmark runner、inspector 或用户自行决定如何消费记录；项目不承诺完整的 session resume、fork、rewind 或跨进程 live event stream。

## 设计原则带来的整体架构形态

把上述原则组合起来，mini-SWE-agent 的 Runtime 可以抽象成：

```text
config specs
   ↓ recursive merge
factories
   ↓
Agent ──────────────── owns messages, limits, cost, termination
  │
  ├── Model ────────── owns API/provider, parsing, retry, formatting
  │      ↑
  │      └── messages + actions + observations
  │
  └── Environment ──── owns command execution, cwd, timeout, isolation
         ↓
      files / process / container / submission signal
   ↓
trajectory JSON
```

这套形态的设计目标不是覆盖所有 coding-agent 产品需求，而是把核心闭环压缩到可读、可测、可替换的最小面积。它的最大优点是研究和评测中的因果关系清晰；最大缺点是长会话、细粒度权限、并发工具、远程控制和 context management 必须由外层另行提供。

## 对横向研究最有价值的观察

mini-SWE-agent 提供了一个“没有产品复杂度的控制组”：

- 如果只保留 `messages → model → action → environment → observation`，agent 仍然可以完成 SWE-bench 类任务；
- session、turn、step 可以先不分离，单次 run 就足够表达实验；
- 工具注册表可以退化为单一 bash tool；
- 审批可以退化为 execute 前的交互确认；
- context compression 可以暂时不存在；
- environment 可以是 subprocess，也可以由同一 contract 替换成容器；
- trajectory 可以替代复杂 event store，成为主要复盘材料。

因此，Codex/Gemini/Cline/OpenHands 中新增的每一层都可以追问：它解决了 mini-SWE-agent 的哪一个具体缺陷？是长上下文、用户持续输入、恢复、权限隔离、并发、跨 surface，还是产品运维？这比单纯比较模块数量更能解释不同 coding agent 的设计思路。

## 证据等级与后续实验

已由源码直接确认：`run/mini.py` 的组装顺序、`DefaultAgent` 的循环与限制、`InteractiveAgent` 的确认/中断、Model 的格式化与 cost、Environment 的执行与序列化、trajectory 的字段和 magic submission 协议。

由历史与源码交叉确认：tool-call-first、Agent/Environment class override、容器后端扩展、ProgramBench surface、wall-clock/process-group cleanup 以及 malformed response 的可审计化。

仍需实验确认：不同 container backend 的实际网络/文件隔离、Docker cleanup 失败时的资源边界、trajectory 被外部工具恢复时的兼容性、模型 cache-control 对 provider cache 的实际影响，以及多 action batch 中部分成功后的消息一致性。

建议的最小实验是：使用同一任务和模型，分别运行 Local、Docker、bubblewrap；在 action 执行中触发 timeout、KeyboardInterrupt、FormatError、拒绝和 magic submit；逐项比较 trajectory 的 messages、exit status、cost、environment config 和 workspace artifact。这能直接量化“极简 loop”在异常路径上的真实行为。

## Runtime 深入分析

### 一次 run 的初始化边界

mini 的启动顺序本身就是架构声明：先读取配置和命令行 override，再创建 Model、Environment、Agent，最后调用 agent.run(task)。task 不在 CLI 内部被拆分为 session/submission/turn；它作为 template variable 进入 instance template，在第一次 query 前被渲染为 user message。Agent 创建完成后，CLI 不再参与 loop，适合嵌入 benchmark runner。

### run 的真实控制流

DefaultAgent.run() 可以概括为：初始化 system/task messages，循环执行 query 和 execute_actions，直到最后一条 message 的 role 为 exit。query 负责检查 step/cost/wall-time limit 并调用 Model；execute_actions 负责把 actions 交给 Environment，再把结果格式化为 observations。finally 中保存 trajectory，因此每次迭代都会留下部分记录。

### Batch action 的语义

Model response 的 extra.actions 是列表。DefaultAgent 默认按顺序执行全部 action，再一次性格式化 observation；InteractiveAgent 先对整个 command list 做确认。这里没有逐 tool-call scheduler、active/queued/completed registry、tail call 或并发 progress。批处理降低了状态复杂度，代价是细粒度取消、单 action retry 和独立审批不属于核心能力。

### Model response 的三层表示

一次模型响应同时存在 provider response、通用 assistant message 和 actions 三种表示。LitellmModel 把原始 response 放入 extra.response，把 tool calls 转成 command actions；发生 FormatError 时仍保存完整 response。这使 Agent loop 消费统一协议，inspector 又能复盘 provider 原始行为。

### Observation 的格式化边界

Environment 返回 output、returncode、exception_info 等结构化字段；Model 使用 observation_template 将它们转成下一条消息。Environment 不知道模型 provider，Model 也不需要知道命令在 host、container 还是 Modal 中执行。模板是 prompt protocol 的一部分，改变模板会改变模型看到的错误和完成信号。

## 终止、错误和恢复语义

FormatError 表示模型输出无法解析或参数不合法。它会变成可反馈给模型的消息，连续达到 max_consecutive_format_errors 才生成 RepeatedFormatError exit。UserInterruption 将 KeyboardInterrupt 和用户评论写回 trajectory，但不自动回滚已经发生的文件修改。LimitsExceeded、TimeExceeded、Submitted 都通过异常携带结构化 exit message。

TimeExceeded 与单命令 timeout 是两个层次：Agent 的 wall-clock limit 终止整个 run，Environment 的 timeout 终止一次 command。LocalEnvironment 使用 process group kill 避免子进程泄漏；DockerEnvironment 还维护 container 生命周期。它们都不负责跨 session supervisor。

Submitted 由 Environment 检查命令输出首行的 magic string 后抛出。这个反向控制路径把模型的 shell sentinel 转成 benchmark 可消费的 submission 字段，优点是确定性高，代价是 completion protocol 与 prompt、shell 输出格式绑定。

## 历史演进与架构含义

2026-01 的 tool-call-first 重构把多个 provider 的 response 归一为 Model/action contract；2026-02 的 Agent/Environment class override 将固定脚本变为 factory-based harness；Contree、SWE-ReX、Modal、bubblewrap 和 Docker 扩展沿 Environment contract 增加隔离后端，没有侵入 Agent loop。

2026-05 至 07 的提交集中强化 ProgramBench、wall-clock kill、非交互 limit、连续格式错误、进程组清理和 malformed response 记录。这些变化的共同目的不是增加 planner，而是让长批量评测在异常路径中仍能收敛、解释和复盘。转向 agents.md、配置 UTF-8 和 tool-call/truncation 区分也体现了项目继续保持核心最小化。

## 设计原则的收益与代价

| 原则 | 直接收益 | 结构性代价 |
| --- | --- | --- |
| 最小闭环 | 易读、易 debug、适合教学和评测 | 长任务控制能力有限 |
| 三对象解耦 | 可替换模型和环境 | 组合错误在运行期暴露 |
| 配置组装 | 实验复现、class override | capability negotiation 较弱 |
| 消息为状态 | trajectory 可审计 | 更新粒度粗、需携带完整 history |
| 异常控制流 | 终止路径统一、错误可反馈 | 异常同时承担业务协议和程序控制 |
| Environment backend | 隔离选择清晰 | 安全策略依赖部署后端 |
| InteractiveAgent 叠加 | DefaultAgent 保持简单 | 权限不是持久 policy plane |
| trajectory first | 评测和复盘简单 | 不是真正 session checkpoint |

## 用户体验与内部设计

| 用户体验 | 内部机制 | 明确缺失的产品能力 |
| --- | --- | --- |
| mini 交互运行 | InteractiveAgent prompt | 多客户端实时控制 |
| human/confirm/yolo | 修改 agent mode | 持久 allow/deny 规则 |
| 执行命令确认 | batch confirmation | call-level scheduler |
| Ctrl-C 后输入评论 | UserInterruption message | 自动文件回滚 |
| 格式错误后继续 | FormatError observation | 复杂错误恢复图 |
| 命令超时 | subprocess/container timeout | 跨任务 supervisor |
| Docker/Singularity 执行 | Environment backend | 统一 environment identity |
| 完成任务 | magic submission sentinel | 语义化 completion protocol |
| trajectory inspector | JSON serialization | 原生 resume/fork |

官方文档把 mini 定位为 simple control flow、local CLI、isolated evaluation 和 RL/FT scaffold，并说明默认只有 bash action、不使用复杂 tool registry。这个定位与源码一致：它优化可读、可替换、可批量评估，不优化持续协作、权限记忆、session fork 或多 surface UX。

## 横向研究中的最小充分基线

mini-SWE-agent 证明 coding agent 的必要核心可以压缩为一条显式 loop，同时把 Model protocol、Environment execution 和 Agent control 三个变化轴分开。它提供了一个没有产品复杂度的控制组：如果 Codex、Gemini、Cline 或 OpenHands 增加了 session store、context graph、policy engine、event bus 或 remote runtime，就可以追问该层解决了 mini 哪个具体缺陷。

研究时应分别记录：谁拥有 messages，谁定义 step，谁解析 action，谁执行 command，谁生成 observation，谁决定 terminal，谁保存 trajectory，谁负责 rollback，谁承担 sandbox。mini 的答案几乎都在 Agent/Model/Environment 三个对象内；这正是其价值，也是它的边界。

## 证据索引与后续实验

Agent loop、限制与序列化见 [default.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)；交互确认与中断见 [interactive.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/interactive.py)；组装见 [mini.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/run/mini.py)；模型适配见 [litellm_model.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/models/litellm_model.py)；环境见 [local.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py) 和 [docker.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/docker.py)。

下一步建议用同一任务运行 Local、Docker、bubblewrap，分别触发 FormatError、拒绝、KeyboardInterrupt、timeout 和 submission，比较 messages、exit status、cost、environment metadata 与 workspace artifact。当前源码与历史已足以确认设计原则，但实际隔离强度、轨迹恢复能力和 provider cache 行为仍需实验。

## Session、Turn、Step 与 Environment 的最小模型

mini-SWE-agent 有意把多个产品层概念压缩掉。为了与其它 coding agent 对齐，可以采用如下映射：

| 横向概念 | mini-SWE-agent 的对应物 | 解释 |
| --- | --- | --- |
| Session | 一次 `agent.run(task)` 及其 trajectory | 没有独立的长期 session service |
| Turn | 通常不存在独立边界 | 用户追加任务通过交互异常回到同一 run |
| Step | 一次 query → actions → observations | loop 的主要控制粒度 |
| Tool call | action 列表中的一个 action | 默认批量顺序执行 |
| Environment | `Environment` 实例及其外部文件/进程 | 执行后端，不是完整任务身份 |
| Checkpoint | trajectory 与外部 artifact | 不承诺原生文件/对话双回滚 |

这个压缩不是遗漏，而是设计选择。mini 的研究价值在于展示：只拥有 messages、模型、执行器和终止条件，也可以完成完整的 coding task。Session、turn、审批、checkpoint 和 event bus 只有在持续交互、恢复、远程控制或产品安全要求出现时才需要拆开。

## 一次 Step 的状态机

```text
ready
  → query model
  → parse assistant response
      ├─ malformed → format observation → retry
      ├─ submit sentinel → submitted
      ├─ no action → continue/exit according to protocol
      └─ actions
           → optional human confirmation
           → execute sequentially
           → format observations
           → append messages
           → check limits
           → next query

any state → KeyboardInterrupt / user interruption
          → interruption message → exit or continue
any state → timeout / cost / step limit → terminal trajectory
```

这里没有独立的 pending approval state store，也没有可跨进程恢复的 active tool call。确认发生在 action batch 执行之前；一旦 environment 开始执行，核心 loop 不提供产品级的逐调用调度或远程撤销。这解释了它的可读性和局限性：控制流可以被几乎完整地读成一个循环，但长任务治理能力不能从这个循环自然推出。

## 状态所有权：为什么它不是长期 Session Runtime

mini 的状态可以分为三层：

1. **Agent 内存态**：messages、step count、cost、format error count、开始时间和终止原因；
2. **Environment 外部态**：文件树、进程、容器、工作目录和 submission sentinel；
3. **Trajectory 记录态**：配置、provider response、actions、observations、usage、exit status 和 environment metadata。

Trajectory 是对前两层的记录，不是第三个可继续执行的 runtime。它可以支持审计和 benchmark replay，但不能自动恢复一个已经退出的 shell、重新取得原有审批上下文，或保证外部文件树回到某一历史点。因此 session fork、tool approval resume、workspace rewind、跨 host attach、后台 task adoption 都不属于核心 contract。

## 动态能力的边界

mini 的能力集合主要在初始化阶段由 config/factory 决定。Environment backend 可以替换，Model adapter 可以替换，Agent class 可以替换；但运行中没有与 MCP marketplace、skills、workspace trust 或 connector session 对应的动态 capability plane。

这意味着工具 schema 的变化通常发生在 Model 初始化或请求构造阶段，而不是由一个持续 session registry 在每个 step 重新协商。若外层 runner 修改配置或替换 environment，那是创建了不同实验条件，不是同一 session 内的 capability mutation。

因此它对 KV cache 的影响也更容易界定：message history 和每一步新增 observation 会改变后续请求上下文；模型 adapter 可能设置 provider-specific cache control；但核心 Agent 不会因为 UI 输入、权限状态或远程 MCP 连接而动态重写工具平面。mini 没有提供统一的 cache invalidation 语义，这不是缺陷，而是它没有承诺产品级动态会话的结果。

## 作为研究基线的最终定位

mini-SWE-agent 应被视为一个“最小充分 harness”，而不是功能较少的完整 coding-agent 产品。它明确回答了最小系统需要什么：

- 保存模型可见 messages 的 loop；
- 把响应转为 action 的协议适配器；
- 执行 action 并生成 observation 的 environment；
- 保证 run 收敛的 step、cost、wall-clock 和格式错误限制；
- 一份能解释结果的 trajectory。

它没有回答长期产品还需要什么：如何在用户持续输入中保持 session identity，如何跨 host 恢复审批，如何把 workspace 变成可回滚状态，如何协调并发 task，如何在工具集合变化时管理模型上下文，以及如何把 transport failure 与 execution failure 分离。

这正是横向研究中的控制价值：其它 coding agent 的复杂 runtime 层，不应只按“功能更多”评价，而应逐项说明它们为 mini 的哪个边界问题付出了状态、协议和运维复杂度。
