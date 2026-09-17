# Building Navi Agent：工程问题驱动的写作提纲

## 系列定位

这是一组来自 Navi Agent 真实构建过程的独立工程文章。

它不按 `runtime`、`tools`、`memory`、`gateway`、`evolution` 等源码模块介绍系统，也不试图写成一套从概念到 API 的 Agent 教程。每篇文章只研究一个在真实开发中出现的工程问题：问题怎样暴露、直觉方案为什么不够、最终建立了什么机制、如何验证，以及当前方案仍有什么边界。

系列面向正在构建 coding agent、个人助理 agent 或自我进化系统的工程师。读者不需要先了解 Navi Agent；每篇文章必须可以独立阅读、独立验证和独立传播。

研究基线：

- 仓库：`xushun007/navi-agent`
- 分析 commit：`5d4cb13810382a13c98185f5cb05fda909441801`
- v0.1 版本分析：[`0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46`](https://github.com/xushun007/navi-agent/commit/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46)
- 演进区间：2026-05-25 至 2026-08-12
- 初版核心 Runtime：`da9c741`，84 行
- 当前历史：410 个 commit

commit 数量只用于定位演进跨度，不作为质量证明。

## 核心叙事

Navi Agent 的演进不是不断增加功能，而是不断回答下面这组问题：

```text
Agent 如何执行？
    ↓
它被允许执行什么？
    ↓
长时间执行如何保持可控？
    ↓
用户如何中断、修正和恢复执行？
    ↓
跨越上下文窗口和进程生命周期后，状态如何延续？
    ↓
系统如何知道自己做了什么、做得是否正确？
    ↓
运行经验如何转化为安全的行为改进？
```

这条主线同时贯穿三种产品形态：

- coding agent 扩大了执行权限；
- 个人助理 agent 扩大了运行时间和状态范围；
- 自我进化 agent 扩大了修改自身行为的权限。

三者共享同一个核心问题：随着权限、时间和状态范围扩大，如何保持系统可控制、可恢复、可验证。

## 文章选择标准

一个主题只有同时满足以下条件，才进入主系列：

1. 来自 Navi Agent 的真实实现或故障，不是纯概念推演；
2. 能指出一个具体的初始方案及其局限；
3. 能提炼至少一个可迁移到其他 Agent 的工程不变量；
4. 有历史代码、测试、日志或实验可以验证；
5. 能明确说明当前方案没有解决什么。

主系列不追求覆盖所有模块。多 Agent、UI、安装发布和项目组织等内容先进入候选池，只有形成足够强的独立工程问题后再写。

## 主系列

### 01｜构建 Navi Agent：从 84 行循环到可控制的 Runtime

#### 工程问题

一个能调用模型和工具的循环，距离真正的 Agent Runtime 还差什么？

#### 触发场景

Navi Agent 的第一版 `AgentRuntime` 只有 84 行：读取 session、调用模型、执行工具、写回结果，直到模型返回最终答案或超过迭代上限。它已经是一个完整 Agent，却无法回答生产环境最重要的问题：当前运行是谁、执行到哪里、为什么停止、失败后能否恢复。

#### 核心判断

Agent Loop 负责推进推理，Agent Runtime 负责管理执行的身份、预算、状态和终态。

#### 文章结构

1. 用 84 行历史代码还原最小 Agent Loop；
2. 明确一次 turn 和一次 loop iteration 的区别；
3. 分析最初四个必要边界：model、session、prompt、tool；
4. 展示迭代上限为什么只是最初级的执行预算；
5. 逐步引出 run identity、event、cancellation、checkpoint 和 finalization；
6. 比较“能完成一次任务”和“能治理一次运行”；
7. 给出最小 Runtime 不变量，而不是推荐一个框架。

#### 关键不变量

- 每次运行具有稳定身份；
- 每条执行路径都必须形成唯一终态；
- 模型输出、工具调用和工具结果保持协议一致；
- 运行预算由 Runtime 强制执行，不能只写在 Prompt 中；
- Session history 与当前 run state 不混为一体。

#### 证据

- `da9c741`：初版 Runtime foundation
- `93dfc72`：resilient tool loop
- `4903427`：persist run lifecycle
- `2d61296`：centralize run finalization
- `src/navi_agent/runtime/agent/engine.py`
- `tests/runtime/test_runtime.py`

#### 配套实验

使用 deterministic fake transport 重放五条路径：直接回答、一次工具调用、多轮工具调用、工具失败、超过迭代上限。对比初版与当前 Runtime 能表达的状态差异。

#### 不讨论

不在本文展开 Tool 安全、上下文压缩和持久恢复，它们各自形成独立文章。

---

### 02｜设计 Agent 的工具执行边界：能力、策略、审批与审计

#### 工程问题

为什么把一个 Python 函数或 JSON Schema 暴露给模型，并不等于拥有一个可靠的 Tool 系统？

#### 触发场景

Coding Agent 获得文件、Shell 和网络工具后，模型不仅能读取信息，也能修改工作区、启动进程和访问宿主环境。仅靠工具描述或 Prompt 约束，无法可靠区分“模型会不会调用”和“系统允不允许执行”。

#### 核心判断

Tool calling 是模型协议；Tool execution 是权限与副作用管理。能力定义、策略判断、人工审批、实际执行和结果审计必须是不同边界。

#### 文章结构

1. 从最初的 `ToolRegistry.dispatch()` 讲起；
2. 区分 schema、toolset、policy、approval、executor、renderer；
3. 解释 risk classification 与 preflight 的不同语义；
4. 分析为什么 approval 必须位于副作用之前；
5. 展示安全工具并发和副作用工具串行的选择；
6. 还原 workspace escape、敏感文件和环境变量泄露风险；
7. 讨论 approval fatigue，以及审批为什么不能替代 sandbox。

#### 关键不变量

- Tool 自身不决定业务策略；
- 所有副作用必须在执行前完成授权判断；
- 拒绝必须 fail closed，并返回可解释结果；
- 子进程默认不能继承不必要的宿主凭证；
- 文件工具与 Shell 对敏感路径使用一致边界；
- 审计记录不泄露原始秘密。

#### 证据

- `6adc739`：structured tool registry
- `fab94b3`：approval-aware policy
- `0900c07`：extract tool executor
- `b79442f`：bash risk classification
- `f7db713`：preflight before approval
- `824a82d`、`b36e990`、`0640141`：凭证和敏感文件边界
- `src/navi_agent/runtime/tools/`
- `src/navi_agent/safety.py`

#### 配套实验

为同一个 Shell 请求构造允许、需要审批、拒绝、执行失败四种结果；验证策略层不执行命令、拒绝无副作用、日志不包含敏感值。

#### 不讨论

Navi Agent 当前的 workspace 和 secret boundary 不是完整进程 sandbox，本文必须明确这一限制。

---

### 03｜Agent 长任务执行：Yield、Timeout、Cancel 与有界输出

#### 工程问题

命令运行时间超过一次交互等待窗口时，Agent 如何先返回控制权，同时继续准确管理同一个进程？

#### 触发场景

一次 `brew install gh` 执行中，Agent 日志将命令判断为失败，但随后检查发现安装实际成功。问题不在 Homebrew，而在 Runtime 把“等待时间结束”误当成了“命令执行失败”。第一轮修复引入 yield 后，又暴露出两个更高风险的问题：后台进程可能永久运行，stdout/stderr 在命令结束前可以无限增长。

#### 核心判断

Yield 只转移等待权，不转移进程所有权。一个后台命令必须保留同一个进程身份，并拥有 deadline、cancel signal、进程组终止、终态和有界输出。

#### 文章结构

1. 用脱敏日志重建 `brew install gh` 的时间线；
2. 区分交互等待窗口、yield threshold 和 hard deadline；
3. 解释为什么不能在 yield 后重新执行命令；
4. 设计 foreground → background 的进程所有权转移；
5. 取消整个进程组，而不是只终止外层 shell；
6. 解释为什么输出必须在读取时有界保留；
7. 讨论默认 60 秒与产品配置 3600 秒的权衡；
8. 展示修复如何从“看起来可用”升级为生命周期闭环。

#### 关键不变量

- 同一个命令在前台和后台阶段只有一个进程实例；
- yield 不产生失败终态；
- timeout 和 cancel 是不同终态原因；
- cancel 必须作用于完整进程组；
- stdout/stderr 的内存占用在运行期间就有上限；
- 用户只能取消自己 session 下的任务。

#### 证据

- 原始脱敏运行日志
- `e0ba638`：yield long shell commands
- `bcaec81`：bound and cancel background shell tasks
- `src/navi_agent/tools/bash_tool.py`
- `src/navi_agent/runtime/tasks/background.py`
- `tests/tools/test_bash_tool.py`

#### 配套实验

执行五组实验：长时间 sleep、持续大输出、父子进程、主动取消、硬超时。记录返回时延、最终状态、残留进程和最大输出缓冲。

#### 不讨论

本文只处理单机子进程生命周期，不把它描述成分布式任务系统。

---

### 04｜可中断的 Agent Runtime：取消、Steer 与断点恢复

#### 工程问题

Agent 正在执行时，用户的新消息应当排队、取消当前任务、修正当前目标，还是恢复一个等待中的交互？

#### 触发场景

CLI 的一问一答模式可以假设请求按顺序到达；微信和持续交互界面不能。用户可能在工具执行中发来“停一下”，也可能补充约束，或者回答 Agent 之前提出的问题。把所有新消息当成下一轮 user message 会破坏当前运行状态。

#### 核心判断

交互控制不是 UI 功能，而是 Runtime 状态机。Cancel、steer、resume 和 next turn 必须是不同的控制操作。

#### 文章结构

1. 分析同一 session 的并发请求竞态；
2. 引入 per-session scheduler；
3. 区分 cancel 与 steer：终止目标和修正目标；
4. 解释 `ask_user` 为什么不能同步阻塞等待；
5. 设计 pending interaction 的持久状态；
6. 用 tool checkpoint 防止恢复时重复副作用；
7. 处理进程重启后的 interrupted run；
8. 把所有路径收敛到统一 finalization。

#### 关键不变量

- 同一 session 不并发修改同一运行状态；
- cancel、steer、resume 具有不同审计事件；
- 等待用户输入时不占用执行线程；
- 恢复不能重复已经成功的副作用工具；
- 过期交互不能恢复到错误的 run；
- 中断后仍然形成可观察终态。

#### 证据

- `6945db7`：schedule requests by session
- `f08e17f`：cancellation and steer
- `8164c40`：resume pending interactions
- `9d72d74`：persist tool checkpoints
- `101ad51`：propagate cancellation
- `be9eeb9`：scope interrupted recovery
- `tests/app/test_interaction_resume.py`
- `tests/runtime/test_run_control.py`

#### 配套实验

构造一个先写文件、再请求用户输入、最后继续执行的任务；分别在等待前、等待中和恢复后重启进程，验证副作用只发生一次。

#### 不讨论

本文不讨论前端如何渲染交互控件，只研究 Runtime 控制语义。

---

### 05｜Agent 上下文是派生视图，不是聊天记录

#### 工程问题

长会话超过上下文窗口后，如何减少模型输入，同时不破坏事实历史、工具协议和任务连续性？

#### 触发场景

简单删除最旧消息会破坏 system instruction、最近用户目标或 tool call/result 配对；直接用摘要替换 session 又会失去可恢复的原始事实。即使模型支持更大窗口，把所有历史持续发送也会增加成本、缓存不稳定和注意力噪声。

#### 核心判断

Session history 是事实记录；model context 是为一次推理构建的派生视图。压缩只应改变视图，不能不可逆地重写事实。

#### 文章结构

1. 区分 session、prompt 和 model context；
2. 展示简单截断如何破坏 tool pair；
3. 设计 head/middle/tail 和 latest-user anchoring；
4. 让 LLM 只压缩中间区域；
5. 结构化 summary 如何保留决策、文件、命令和未完成事项；
6. compaction checkpoint 如何支持持续压缩与恢复；
7. summary 失败时为何选择保留原文；
8. 讨论字符估算、真实 token usage 和压缩抖动的未完成问题。

#### 关键不变量

- 完整 session history 可恢复；
- system instruction 和最新用户目标保留；
- tool call/result 配对始终合法；
- 摘要是派生数据，并带有生成状态；
- 历史请求不能在摘要中变成当前指令；
- 敏感信息不能因摘要再次扩散。

#### 证据

- `4fd7a9b`：context compression engine
- `516b9fe`：LLM context summaries
- `8d5450a`：persist compaction checkpoints
- `4931a37`：trace summary model calls
- `src/navi_agent/runtime/agent/context.py`
- `tests/runtime/test_context_engine.py`

#### 配套实验

构造包含长工具输出、历史用户请求、未完成任务和孤立 tool result 的会话，比较简单截断与 ContextEngine 输出，并验证恢复后的下一轮行为。

#### 不讨论

本文不把任何压缩策略描述成无损；可恢复不等于模型当前仍能看到全部信息。

---

### 06｜个人 Agent 的持久执行：消息、任务与结果投递

#### 工程问题

Agent 从一次性 CLI 变成微信中的长期在线个人助理后，如何保证消息不丢、任务不中断、结果最终可送达？

#### 触发场景

Polling loop 能收到消息，却不能保证进程在处理、回复或后台任务完成前不会崩溃。Cron 和后台任务还会在原始请求结束之后产生结果。此时“模型回答成功”已经不等于“用户收到结果”。

#### 核心判断

个人 Agent 是消息驱动的长期运行系统。Gateway 只做协议适配；可靠性必须由持久 inbox/outbox、幂等处理、重试、dead-letter、启动恢复和有界关闭共同保证。

#### 文章结构

1. 对比 CLI task lifecycle 与 personal-agent lifecycle；
2. 明确 gateway、ApplicationService、Runtime 的边界；
3. 从 polling prototype 走向 durable inbox/outbox；
4. 区分运行成功、消息持久化成功和用户投递成功；
5. 设计 retry classification 与 dead-letter；
6. 让 background task 和 cron 结果进入同一投递链；
7. 进程启动时恢复什么，关闭时等待什么；
8. 说明当前 readiness 和 degraded detection 的缺口。

#### 关键不变量

- 接收确认之前，消息已经进入持久状态；
- 同一外部消息只驱动一次业务处理；
- Runtime 不直接依赖微信协议；
- 回复生成与外部投递是两个独立状态；
- 重试必须有上限，永久失败进入 dead-letter；
- shutdown drain 有明确 deadline。

#### 证据

- `e381e2b` 至 `1286f9d`：微信入口原型与收敛
- `fab6fce`：durable delivery loop
- `2b450a8`：dead-letter controls
- `c2c100b`：persist cron result delivery
- `d3e77c3`：persist background task state
- `52bc7b6`：bound shutdown drain
- `src/navi_agent/gateway/weixin/`
- `tests/gateway/test_weixin_delivery.py`

#### 配套实验

在收到消息后、Runtime 执行中、outbox 写入后、发送前和发送后五个位置注入进程中断，记录重启后的重复处理与最终投递行为。

#### 不讨论

本文不讨论多实例水平扩展；当前结论限定在单进程、持久 SQLite 状态模型。

---

### 07｜Memory Admission：Agent 应该被允许记住什么

#### 工程问题

Agent 如何从对话中形成长期记忆，同时避免把临时信息、错误推断、冲突事实或 Prompt Injection 永久保存？

#### 触发场景

“把聊天历史放进向量库”可以快速实现 recall，却无法回答记忆来源、适用范围、冲突、过期和删除问题。后台 review 如果只看到局部会话，还可能把不完整信息提炼成错误长期记忆。

#### 核心判断

Memory 不是存储功能，而是一个 admission problem。长期写入必须比短期读取拥有更严格的证据、目标、来源和生命周期约束。

#### 文章结构

1. 区分 session history、context、memory 和 recall；
2. 说明 profile memory 与 task-relevant memory 的差异；
3. 分析 hot-path write 和 background review 的取舍；
4. 引入显式 memory target 和 durable-write gate；
5. 处理 provenance、冲突、过期、删除和审计；
6. 解释跨会话 review window 曾经如何失败；
7. 清洗来自用户和工具输出的指令性文本；
8. 给出“什么不应该记住”的负面规则。

#### 关键不变量

- 聊天内容默认不是长期记忆；
- durable memory 写入必须有明确 target 和来源；
- 临时运行观察不能直接晋升为永久事实；
- 冲突不通过静默覆盖解决；
- 用户可以查看、修正和删除记忆；
- 记忆写入不执行其中携带的指令。

#### 证据

- `58c7479`：inject relevant memories
- `3ec3d55`：explicit memory targets
- `42081be`：guard durable writes
- `a7410c0`、`dfdc286`：atomic write 与 locking
- `00d9030`、`cc2385c`：quota 与 conflict candidates
- `7263b85`：cross-session review fix
- `6cde382`、`ad456bd`：transient rejection 与 expiry
- `src/navi_agent/memory/`

#### 配套实验

准备永久偏好、一次性任务参数、相互冲突事实、恶意指令和过期信息五类样本，验证 admission、recall、conflict 和 expiry 行为。

#### 不讨论

本文不把人的记忆分类直接类比为 Agent 的实现真理；分类只服务具体产品约束。

---

### 08｜没有报错，不等于 Agent 做对了：从 Trace 到 Evaluation

#### 工程问题

Agent 运行顺畅、工具成功、响应快速，是否足以证明一次修改提高了系统质量？

#### 触发场景

早期 healthcheck 可以衡量异常数、迭代数、重复工具调用和耗时，却无法识别“执行过程完全正常，但最终结论错误”的运行。随着 Prompt 和 Skill 开始自动产生候选，这个缺口从可观测性问题升级为变更安全问题。

#### 核心判断

Event 记录发生过什么，Trace 解释一次运行，Evaluation 判断结果是否符合目标。Observability 不能替代 correctness evidence。

#### 文章结构

1. 区分 log、runtime event、trace、trajectory 和 eval result；
2. 展示无错误但答案错误的反例；
3. 从 append-only events 构建 trace，而不是 Runtime 双写；
4. 分析 outcome、trajectory、environment-state 三类评估；
5. 说明 healthcheck、IFEval、tool-use、BFCL、HumanEval、SWE-bench 的边界；
6. 比较 deterministic grader 与 model judge；
7. 建立 dataset、case revision、baseline 和 regression gate；
8. 说明为什么提出修改的系统不应独立评判自己的修改。

#### 关键不变量

- 原始运行事实与派生评分分离；
- 同一比较使用相同 case revision 和运行配置；
- 评估目标与候选修改范围相关；
- 关键正确性优先使用环境结果或确定性断言；
- 自动 grader 的不确定性必须可见；
- 单次成功不能证明非确定系统稳定改进。

#### 证据

- `4bd1e1a`：append-only runtime events
- `8cb27bf`：derive traces from events
- `a9f05cd` 至 `1b02573`：offline replay
- `b409b9e` 至 `cfc5fa0`：workflow replay/comparison
- `fadc1dd` 至 `224a85d`：IFEval
- `98a60be` 至 `8fe37ff`：tool-use eval
- `3989a52`：promotion gate
- `src/navi_agent/telemetry/`
- `src/navi_agent/evolution/evals/`

#### 配套实验

选择一个“运行指标更好但答案错误”的候选，与 baseline 使用相同 case 集运行；分别用运行健康分、最终结果断言和 trajectory grader 评分，展示三种结论的差异。

#### 不讨论

Benchmark 分数不等于真实用户价值；本文只讨论如何降低未验证变更进入生产的概率。

---

### 09｜从 Runtime Trace 到受控 Agent 进化

#### 工程问题

Agent 如何利用运行经验改进 Prompt、Skill 和评测用例，同时不让错误经验或攻击输入直接改变线上行为？

#### 触发场景

Navi Agent 最初可以从 trace 生成 candidate，也能应用 Prompt overlay 和 Skill。随着自动化程度提高，系统出现了更危险的问题：未经人工接受的候选可能被应用，验证失败后的变更需要自动回滚，生成候选的 review agent 也不能拥有直接激活权限。

#### 核心判断

自我进化不是运行时自我修改，而是一条受治理的软件交付链：evidence → candidate → admission → isolated evaluation → human acceptance → activation → monitoring → rollback。

#### 文章结构

1. 从 Runtime Trace 中识别重复失败和学习机会；
2. 区分 eval-case、Prompt 和 Skill 三类候选；
3. 解释 review agent 为什么与在线 Runtime 解耦；
4. 区分 candidate generation、admission、activation 和 promotion；
5. 建立 immutable version、provenance 和 evidence store；
6. 用隔离 A/B 比较 baseline 与 candidate；
7. 要求 correctness evidence 和人工接受；
8. 激活失败或回归时自动 rollback；
9. 分析当前系统为何仍是“受控进化”，不是自主无限进化。

#### 关键不变量

- 在线运行只产生 evidence 和 candidate，不直接改变行为；
- 候选生成者不拥有最终激活权；
- admission 与 activation 分离；
- 每个激活版本都能追溯来源和评估证据；
- baseline 与 candidate 在隔离环境中比较；
- 没有 acceptance 和 correctness evidence 就 fail closed；
- 已激活变更必须可回滚。

#### 证据

- `4fe9308`：初版 evaluator/candidate store
- `937d42f` 至 `e2623d6`：candidate 与 Prompt overlay
- `75d4e83`、`f56246c`：统一 review agent
- `a5fe076`、`a050cfb`：governed promotion
- `5c28b20`、`2c49667`：acceptance 与 rollback
- `eb79a03`、`a383dbd`：gate record 与 provenance
- `6984970`、`108dd3d`：staging 与 correctness evidence
- `c750d92`、`513c19e`：admission/activation 与 isolated A/B
- `src/navi_agent/evolution/`

#### 配套实验

构造一个能修复目标 case、但破坏 holdout case 的 Skill 候选。完整记录生成、admission、A/B、拒绝或回滚过程，验证线上 active version 未被污染。

#### 不讨论

本文不把 Prompt、Skill 或 Memory 的在线更新描述为模型权重学习，也不声称系统具备开放式自主研究能力。

## 候选文章池

下面的主题具有价值，但暂不进入主系列：

### 多 Agent 不是多开线程：委派预算、Lineage 与结果收敛

进入条件：补足单 Agent 与多 Agent 的可重复对照实验，明确并行收益、协调成本和失败率，而不是只讲当前实现。

可用证据：`1406871`、`3007447`、`ee8dbc9`、`8371455`、`7698a9a`。

### Runtime Event 如何同时服务 UI、Trace 与 Replay

进入条件：形成一次 schema 演进复盘，证明 observer、trace 双写和统一 event projection 三种方案的实际差异。

可用证据：`4bd1e1a`、`0faf84d`、`8cb27bf`、`dc48586` 和本地 trace viewer。

### 如果重新构建 Navi Agent，我会保留什么、删除什么

进入条件：先完成主系列，再用模块 churn、bug-fix 密度和三个明确设计反转支撑复盘，避免写成主观总结。

## 单篇写作协议

每篇文章以平台中立母稿为唯一事实源，正文建议使用以下结构：

1. **Problem**：用真实场景说明问题，不超过全文 10%；
2. **First Design**：还原当时最简单、合理的实现；
3. **Failure**：用日志、测试或实验说明它在哪里失效；
4. **Mechanism**：解释最终设计和关键数据流；
5. **Invariants**：列出系统必须始终满足的条件；
6. **Evidence**：展示代码、测试和实验结果；
7. **Trade-offs**：说明代价、边界和未解决问题；
8. **Generalization**：提炼对其他 Agent 系统可迁移的原则；
9. **Implementation Notes**：固定 commit、源码和实验索引。

这只是证据结构，不要求所有文章使用相同的小标题。

## 证据要求

正文中的重要结论必须区分：

- **代码事实**：固定 commit 中可以定位的实现；
- **测试事实**：自动化测试覆盖的行为；
- **运行观察**：可复现实验或脱敏日志产生的结果；
- **设计解释**：作者对取舍和演进原因的复盘；
- **未确认事项**：尚未在生产负载或独立实验中验证的判断。

每篇至少包含：

- 一段来自真实版本的最小代码；
- 一次失败或设计反转；
- 一张机制图或状态图；
- 一个可复现实验；
- 一组明确不变量；
- 一段适用边界。

正式架构图必须保存可编辑 `.excalidraw` 源文件，放在 `projects/navi-agent/diagrams/`。提纲阶段不提前绘图。

## 发布策略

文章不标注“第一课、第二课”，只使用统一的 `Building Navi Agent` 系列标识。每篇独立发表，并在文末链接相关主题。

推荐首发顺序：

1. 《Agent 长任务执行：Yield、Timeout、Cancel 与有界输出》
2. 《构建 Navi Agent：从 84 行循环到可控制的 Runtime》
3. 《设计 Agent 的工具执行边界：能力、策略、审批与审计》
4. 《可中断的 Agent Runtime：取消、Steer 与断点恢复》

第一篇选择长任务执行，是因为它同时具备真实事故、两轮修复、操作系统机制和可重复实验，最能建立这个系列的工程辨识度。

## 多平台版本

### `www.agent-io.com`

作为权威母稿，保留完整机制、代码、实验、图、commit 和勘误记录。

### 微信公众号

保持同一工程结论，但减少实现细枝末节；以事故时间线或失败现象开场，代码改为窄屏可读片段，完整实验链接回母稿。

### 知乎

将工程问题转为可搜索的问题表达，强化不同方案的争议和取舍；正文仍以母稿证据为准。

### InfoQ

弱化个人项目叙事，强化约束、架构决策、实验方法、适用边界和可迁移原则。所有“生产级”“安全”“可靠”判断必须限定验证范围。

## 第一篇素材任务

《Agent 长任务执行：Yield、Timeout、Cancel 与有界输出》正式写作前，需要完成：

1. 从 Navi Agent 日志中导出并脱敏 `brew install gh` 事件时间线；
2. 对比 `e0ba638^`、`e0ba638`、`bcaec81` 三个版本的行为；
3. 建立五组可重复进程实验；
4. 记录返回时延、终态、残留进程、输出缓冲和内存数据；
5. 绘制 foreground → yielded background → terminal 的状态图；
6. 明确 Codex 的对应机制只作为机制对照，不替代 Navi 的一手证据；
7. 在母稿中保留第一轮修复仍有高风险缺口这一事实。
