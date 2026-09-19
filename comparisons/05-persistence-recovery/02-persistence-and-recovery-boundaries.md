---
title: Coding Agent 的持久化模型与恢复边界
series: Coding Agent 的事件、持久化与恢复
part: 2
reviewed_at: 2026-09-17
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的持久化模型与恢复边界

## 结论

Coding Agent 的持久化问题，不是“把聊天记录保存下来”这么简单。真正需要持久化的是一组能够重新建立责任、权限、执行进度和环境关联的状态。聊天记录只是其中一个投影。

一个可恢复的 Agent 至少需要回答：

```text
从哪一个 Session 恢复？
恢复哪个 Turn 和 Step？
当前是否存在尚未完成的工具调用？
这个调用是否已经产生外部副作用？
恢复者是否拥有继续执行的权限？
恢复时 Environment 是否还是原来的 Environment？
模型看到的上下文是否可以从持久化事实重新生成？
```

因此，持久化边界应围绕**恢复责任**设计，而不是围绕数据库表或文件格式设计。不同 Agent 的取舍可以概括为三种方向：

- 轻量 transcript：保存模型继续对话所需的最小历史，把执行状态交给当前进程；
- execution-aware persistence：额外保存工具调用、审批、任务状态和 Environment 引用；
- durable harness：把运行者认领、操作租约、checkpoint、恢复决策和副作用对账作为一等机制。

本文讨论的是第二篇文章中的“事实日志”如何变成可恢复状态。下一篇将进一步研究 replay、retry 和外部副作用的一致性。

## 1. 持久化的对象不是一棵树，而是几条相互关联的链

一个成熟 Runtime 通常同时维护五条链：

```text
用户意图链      Session -> Turn -> Input
模型计算链      Request -> Response -> ToolCall
执行事实链      Action -> Observation -> Outcome
授权链          Policy -> Approval -> Capability use
环境链          Environment -> Lease -> Effect
```

它们共享关联 ID，但结束时间不同。用户输入可以已经持久化，模型响应可能只收到一半；审批已经通过，工具还未启动；本地进程已经写文件，客户端尚未收到结果。将它们压成一条 transcript，会把这些不同的时间边界隐藏起来。

持久化设计的第一个任务，是说明每条链由谁拥有、在哪个时刻提交、失败时如何补偿。只有这样，恢复器才能知道哪些状态可以直接读取，哪些需要重新观察，哪些必须停止并请求人工确认。

## 2. 三个持久化层次

### 2.1 Transcript：可读的会话历史

Transcript 通常包含 user、assistant、tool 和 system message。它的主要用途是：

- 恢复模型对话上下文；
- 向用户展示过去发生过什么；
- 支持分支、导出和基本审计。

Transcript 并不天然包含：

- 工具是否真正开始执行；
- 工具所属的 Environment 版本；
- 审批适用范围和过期时间；
- 进程租约是否仍然有效；
- 远程调用是否处于未知状态。

Gemini CLI SDK 的 Session 以 transcript、cwd、session ID 和动态 instructions 组装请求上下文，这适合 Session resume 的对话层恢复，但不能仅凭 Session transcript 证明远程 Environment 的副作用已经收敛。[^gemini-session]

### 2.2 Trajectory：模型—Environment 的交互轨迹

Trajectory 比 transcript 更接近 Agent loop：它至少记录模型输出的 action 和 Environment 返回的 observation。mini-SWE-agent 的默认实现就是典型的最小轨迹模型。[^mini-default]

Trajectory 可以重建“模型曾经看到什么”，但仍然可能缺少：

- 调用提交前后的 Runtime 状态；
- 审批等待；
- 被取消的请求；
- 流式输出的边界；
- Environment 的稳定身份；
- 外部副作用与对应资源。

所以 trajectory 适合进行模型行为分析和离线评估，不自动等于可恢复执行记录。

### 2.3 Checkpoint：恢复协议的状态边界

Checkpoint 是系统允许恢复器从某个点继续工作的承诺。它的关键不是内容多，而是语义明确：

```text
checkpoint C
  = history boundary
  + runtime state boundary
  + environment reference
  + outstanding work
  + recovery policy
```

一个 checkpoint 可以是数据库中的多张记录、一个 JSON 文档、一组 JSONL frame，甚至是数据库快照加外部对象引用。格式不重要；重要的是恢复后，系统不会把“已经发生的副作用”再次当成“尚未发生的计划”。

## 3. 什么必须持久化

判断标准不是“以后可能有用”，而是：如果丢失它，恢复器是否可能作出不同且危险的决定。

### 3.1 身份与因果关联

至少要保留 Session、Turn、Step、tool call 和 Environment 的关联。没有这些 ID，恢复器只能按时间排序，很难区分：

- 两个并行工具调用的结果；
- 一个 Turn 中的 steer 与下一个 Turn 的新输入；
- 父 Agent 与子 Agent 的调用；
- 同一个工具重试的不同尝试。

Codex 将 StepContext、TurnState 和输入归属分开表达；Kimi Code 的 StepRequest 及其队列同样把请求身份和所属 loop 作为运行结构的一部分。[^codex-step] [^kimi-request]

### 3.2 接受状态与执行状态

“模型生成了工具调用”与“Environment 已执行工具”之间必须存在可恢复边界。至少需要知道调用是否：

1. 只存在于 provider 响应中；
2. 已被 Runtime 接受；
3. 已等待审批；
4. 已取得执行租约；
5. 已启动；
6. 已得到结果；
7. 结果已进入模型上下文。

Pi 的 durable harness 通过 operation 和恢复逻辑处理未完成 assistant generation 与工具恢复；OpenCode 的 Session execution 使用 claim 和状态转换防止多个运行者同时接管同一执行。[^pi-recovery] [^opencode-execution]

### 3.3 授权事实

审批必须记录被授权的对象和边界，而不是只记录“用户点击了允许”。建议至少保存：

```text
approval_id
call_id
policy_version
requested_capability
normalized_arguments 或匹配条件
decision
decision_scope
actor
created_at / expires_at
```

如果恢复后工具参数发生变化，旧审批是否可复用必须由策略决定。Codex 将审批回复关联到调用身份；Kimi Code 将权限门和工具策略放在执行链上；这些实现都说明审批不是普通对话消息。[^codex-approval] [^kimi-permission] [^kimi-policy]

### 3.4 Environment 引用

cwd 只是 Environment 的一个属性。恢复一个 coding agent 时，至少要知道：

- 使用的是本地目录、容器还是远程 sandbox；
- Environment 的实例或租约 ID；
- 工作树、分支或快照标识；
- 工具进程是否仍然存在；
- 环境是否已暂停、销毁或被其他 Agent 修改。

OpenHands 的 agent-server 会把 sandbox、workspace、服务 URL 和 session key 作为运行环境信息传递给 Agent；这说明后端执行上下文不能由前端 conversation history 单独重建。[^openhands-adapter]

没有 Environment reference 时，恢复器最多能恢复模型叙事，不能证明相同文件系统仍然存在。

### 3.5 未完成工作

持久化不能只保存已经完成的消息。对于 pending input、审批、等待中的后台任务、running process 和未完成模型响应，都应有明确状态。Codex 的 Turn 状态包含等待对象和待处理输入；Kimi Code 持久化 task state；Pi recovery 则针对未完成 assistant generation 进行处理。[^codex-approval] [^kimi-task] [^pi-recovery]

## 4. 什么可以重建

可重建不等于不重要，而是表示它不应成为唯一事实来源。

### 4.1 模型上下文

如果保存了结构化历史、当前策略、Environment 观察引用和模型配置，下一次 prompt 通常可以重新组装。OpenCode 将 Session message 转换为 LLM message；Codex 将内部 history 投影为 prompt history；这两者都说明 provider 输入是派生视图。[^opencode-context] [^codex-history]

但重建必须是版本化的。Context builder、工具 schema、摘要算法或模型适配器发生变化后，同一事实日志可能生成不同 prompt。恢复记录应能说明当时使用的 builder 或 schema 版本，否则“重建原始请求”和“生成一个新的继续请求”会被混淆。

### 4.2 UI 状态

进度条、工具卡片、折叠日志、token 统计和当前面板通常都可以从事件或消息投影重建。它们不应反向成为恢复状态的权威来源。

UI 也可能比 Runtime 更晚收到事件，或者因订阅重连而重复收到事件。因此 UI 去重应依据 `event_id` 或序列号，而不是依靠文本相等。

### 4.3 Trace 与性能数据

延迟、token、provider request id 和 span 通常可单独持久化或按策略丢弃。它们对于诊断很重要，但不应决定一个工具是否完成。高可用系统可以保留 trace 的关键索引，同时把大 payload 外置，避免核心状态存储被日志吞没。

### 4.4 当前文件观察

文件内容、Git status、进程列表和服务健康状态通常应在恢复后重新观察，而不是盲目相信旧值。旧观察仍然有审计价值，但应该带有采集时刻和 Environment 版本。

这也是“事实不可变”和“环境状态可变”之间的区别：日志中不可变地记录“当时读到了什么”，恢复器则必须重新判断“现在是否仍然如此”。

## 5. Checkpoint 的原子性问题

一次有副作用的 Step 至少涉及三类提交：

```text
Runtime record commit
Environment effect commit
Context/message projection commit
```

它们往往不在同一个事务中。比如：

1. Runtime 写入 `ExecutionStarted`；
2. 子进程修改文件；
3. 进程被杀；
4. `ObservationReady` 尚未写入。

重启后，日志显示 running，文件却可能已经改变。此时“从最后一个 checkpoint 重放命令”是不安全的。恢复器必须优先检查 Environment，或者使用工具级幂等键、文件快照和补偿操作确认副作用。

反过来，如果先写 `ExecutionFinished` 再提交文件快照，快照失败会造成“日志认为完成、恢复器却无法验证”的分裂。系统需要明确哪一方是最终事实，以及如何将另一方标为待对账，而不能假设普通文件写入具有分布式事务语义。

### 5.1 Commit point 不只有一个

应区分：

- **admission commit**：Runtime 接受了输入或调用；
- **authorization commit**：权限决定已成立；
- **execution commit**：Environment 接受并开始动作；
- **effect commit**：外部副作用已确认；
- **observation commit**：结果已写入事实日志；
- **projection commit**：模型或 UI 已得到派生消息。

这些提交点可以有不同的顺序。可靠恢复的目标不是强行把它们合并，而是记录跨提交点的中间状态，并为每种中断组合定义恢复动作。

## 6. 本地进程恢复与远程 Environment 恢复

### 6.1 本地进程

本地执行通常容易重新访问 cwd，但不代表状态简单：

- 子进程可能被杀但孙进程仍在运行；
- 文件写入可能只完成了一部分；
- shell 命令可能触发网络或启动服务；
- 当前分支可能被用户在 Agent 停止后修改。

因此本地恢复至少需要重新读取 Git 状态、进程状态和关键文件。Pi 的 node Environment 捕获命令输出并对大输出进行外置或裁剪，这解决的是观察存储问题，不自动解决命令副作用的重放问题。[^pi-env]

### 6.2 容器或远程 sandbox

远程 Environment 往往有独立生命周期：可以创建、暂停、恢复、过期和销毁。Session history 还在，不代表 sandbox 还在；sandbox 还在，也不代表工作树未被其他执行者改变。

OpenHands 的 workspace API 与 agent-server context 分离，体现了这种边界；恢复时要先解决 Environment provisioning，再恢复 Agent loop。[^openhands-adapter]

远程恢复通常需要额外的租约和 fencing：旧 worker 即使网络恢复，也不能继续写入已经被新 worker 接管的 Session。OpenCode 的 execution claim 测试提供了这一类责任迁移的源码证据。[^opencode-tests]

### 6.3 用户仍在修改工作树

这是 coding agent 特有的恢复冲突。Agent 停止期间，用户可能修改文件、切换分支或重置提交。恢复器不能把旧 checkpoint 当作工作树快照；它需要明确：

- 是否以当前工作树继续；
- 是否创建隔离 workspace；
- 是否将用户变更视为新的 Environment version；
- 是否阻止自动应用旧 patch。

Environment identity 与 workspace snapshot 分离，正是为了区分“同一个 Session”与“同一份文件状态”。

## 7. 恢复算法的基本流程

一个保守的恢复流程可以写成：

```text
1. 读取 Session 和最后一个有效 checkpoint
2. 验证 schema、Runtime 版本和恢复策略版本
3. 获取当前 Environment，并确认 identity / lease
4. 扫描未完成 operation、approval 和后台任务
5. 对每个 operation 分类：未开始、运行中、已完成、失败、未知
6. 对 Environment 做必要的状态观察和副作用对账
7. 仅重建可安全重建的消息、Context 和 UI 投影
8. 生成恢复决策事件
9. 继续、暂停、补偿或请求用户决策
10. 写入新的 checkpoint，形成下一次恢复边界
```

其中第 8 步不能省略。恢复不是静默修改旧状态，而应产生一个新的事实：系统在什么依据下决定接管、重试、跳过或停止。这样用户和后续诊断才能解释“恢复后为什么多执行了一步”。

## 8. 不同 Agent 的持久化取舍

### 8.1 Codex：Turn/Step 责任较明确

Codex 将 Turn 输入、StepContext、审批等待、工具记录和 history 管理放在相互关联但不同的模块中。它的恢复关键在于：模型历史可能被 compaction 或 rollback 重写，但 Turn 级输入和执行责任不能随之消失。[^codex-step] [^codex-history]

这是一种产品化 coding harness 的典型取舍：持久化不只是为了 resume 对话，而是为了让中断、审批、后台任务和环境操作继续拥有明确归属。

### 8.2 Pi：从 Agent loop 到 durable harness

Pi 底层 Agent 可以用消息和 context snapshot 继续模型循环；v4 harness 则增加 JSONL frame、lane、operation 和恢复策略。[^pi-agent] [^pi-jsonl] [^pi-restore]

这条演进路径很有代表性：当系统从库级 loop 变成可长期运行的 coding harness，持久化责任从“保存消息”迁移到“保存可接管的操作”。

### 8.3 OpenCode：Session storage 与执行 claim 并列

OpenCode 将 Session 消息、compaction、execution claim 和 Workspace 工具拆开。Session 可以保留历史，execution 则负责谁正在执行以及异常后如何恢复。[^opencode-execution] [^opencode-context]

其优点是消息历史和执行协调可以独立演进；代价是需要维护状态与投影之间的映射，并处理数据库状态与工作树副作用的不一致。

### 8.4 OpenHands：Conversation 与运行环境分离

OpenHands 的前端 conversation、agent-server 和 workspace 不构成一个单体 checkpoint。恢复一个任务需要同时处理历史可见性、后端 Agent 状态和 sandbox 可用性。[^openhands-adapter]

这更接近远程软件工程平台，而不是单进程 CLI：持久化边界必须跨网络、服务进程和工作空间生命周期。

### 8.5 Kimi Code：请求身份和任务状态

Kimi Code v2 通过 StepRequest、请求定型、tool dedupe 和 task persistence，把“请求是否已被消费”“工具调用是否重复”和“任务是否等待审批”显式化。[^kimi-request] [^kimi-dedupe] [^kimi-task]

这种设计在队列化和多任务场景中有价值：恢复器不必只看最后一条模型消息，而可以按请求身份和任务状态继续推进。

### 8.6 Gemini CLI 与 mini-SWE-agent：轻量边界

Gemini CLI 的 SDK Session 更偏向可复用的 Session/context API；mini-SWE-agent 的默认 loop 更偏向短轨迹执行。[^gemini-session] [^mini-default]

这并不表示它们“不支持持久化”，而是其核心抽象没有把 durable execution 作为同等强度的责任。应用层若需要长时间运行、远程恢复或并行执行，必须补充自己的 operation、Environment 和 checkpoint 语义。

## 9. 机制级解剖：什么真正跨重启保留

“支持恢复”不能由存在一个 session 文件推出。关键是看恢复器能否在没有原 worker 内存的情况下重建责任、执行权和 Environment 连接。

### Codex：恢复对象是 Turn 的执行上下文，不是整段 UI

Codex 的 `StepContext` 将 cwd、权限、工具配置等 step 级输入收束为执行上下文；history 则负责把可供模型继续消费的消息重新组织。[^codex-step] [^codex-history] 这形成了两个持久化边界：Turn/Step 的责任和审批不能依赖当前进程，模型 history 可以被 compaction 重建。

这套边界适合交互式 coding agent，因为用户取消、继续输入和审批都需要回到同一个 Turn 责任链。代价是恢复不能简单“加载最后一条消息”：还要恢复当时的权限范围、Environment 配置和未完成工具。

### Pi：从消息存储升级为操作存储

Pi 的 JSONL frame 记录比单纯 transcript 更接近可恢复日志，restore/recovery 逻辑进一步处理半完成的 assistant generation 和工具操作。[^pi-jsonl] [^pi-restore] [^pi-recovery] 这说明 durable harness 的最小单位已从“对话消息”转成“可接管 operation”。

优点是崩溃恢复可以识别中间态；限制是 JSONL 仍主要解决本地 harness 的顺序和重放，跨机器接管、远程 workspace 一致性并不会自动获得。

### OpenCode：三份状态必须共同恢复

OpenCode 至少有三类恢复材料：Session message、execution claim、workspace 状态。`to-llm-message` 只解决第一类的模型投影，execution 模块解决 worker 所有权，workspace driver 才能重新观察工作目录。[^opencode-context] [^opencode-execution] [^opencode-workspace]

它的优点是责任分离明确；缺点也同样明确：任何一类状态单独恢复都可能制造假象——消息存在不代表执行权存在，claim 存在不代表文件系统仍是原状态。

### OpenHands：持久化边界跨越服务和 sandbox

OpenHands 的 agent-server 会把 conversation/context 与 workspace 信息组合后交给运行服务。[^openhands-adapter] 因而恢复不是读取一个本地 session 文件，而是重新建立“历史可见、Agent 可运行、Environment 可访问”的三者关系。

这使它更适合远程软件工程平台，但恢复失败的终态也更多：conversation 可恢复而 sandbox 不可用时，正确状态应是 `waiting_environment`，而不是让模型假设命令仍然可执行。

### Kimi Code：task 是持久化责任的中心

Kimi Code 的 task persistence 保存任务阶段和等待状态，StepRequest/permission gate 则保留请求级责任，tool dedupe 避免恢复时重复消费相同调用。[^kimi-task] [^kimi-request] [^kimi-permission] [^kimi-dedupe]

这是队列化 Runtime 的典型方案：持久化中心不是聊天 transcript，而是 task/request 状态机。它能支持并发和取消，但要求 task 状态、请求身份和外部副作用始终可关联，否则“已消费”可能只是逻辑上的已消费。

### Gemini CLI 与 mini-SWE-agent：恢复层主要留给上层

Gemini CLI 的 SDK Session 提供会话循环和 context 边界，但 policy、shell 和远程执行的持久化责任并未被一个统一 durable execution 层完全吸收。[^gemini-session] mini-SWE-agent 的 trajectory 可以保存一次任务的模型轨迹，却不等于 checkpoint 或可接管的 workspace identity。[^mini-default]

这不是缺陷，而是定位选择：二者把核心复杂度留在应用层，以换取较小的 Runtime。若要用于长期后台任务，必须额外实现 operation store、lease、Environment probe 和恢复决策记录。

## 10. 持久化层的设计原则

### 原则一：恢复边界应比展示边界稳定

UI 可以改版，provider message 可以变换，checkpoint 和事件 schema 则需要长期兼容。不要让恢复依赖某个前端组件的内部字段。

### 原则二：保存“继续执行所需的最小充分状态”

并非所有 stdout、token 和 UI 增量都要进入核心数据库。应保存能够证明责任和恢复决策的结构化信息，大型 payload 通过 blob 引用和保留策略管理。

### 原则三：外部状态永远需要重新验证

事件日志能证明过去观察到什么，不能保证文件、进程和远程资源今天仍然如此。恢复必须区分历史事实和当前观察。

### 原则四：恢复动作本身也要记录

接管、跳过、重试、补偿和请求人工确认都是新的 Runtime 决策，不能只更新旧 operation 的状态而不留下原因。

### 原则五：版本化解释器

schema 版本解决“字段能否读取”，Runtime/策略版本解决“字段如何解释”。两者都需要记录，否则旧 checkpoint 在新版本中可能被错误地重放。

### 原则六：不可证明安全时暂停

当 Environment identity 不明、外部副作用未知或旧审批不再匹配时，暂停并请求重新观察或人工决策通常比自动继续更可靠。

## 11. 可复现验证方案

不需要真实生产流量，也可以构造最小故障注入实验：

```text
for each commit point:
  run deterministic tool
  kill process immediately before/after persistence
  restart with same Session and Environment
  record recovery decision and filesystem diff
```

需要验证的断点包括：

- 写入 `ToolCallAccepted` 前后；
- `ApprovalGranted` 写入前后；
- `ExecutionStarted` 写入前后；
- 文件副作用完成前后；
- `ObservationReady` 写入前后；
- checkpoint 写入前后；
- UI/message projection 写入前后。

每次实验都应记录：原始事件、重启时扫描到的状态、Environment 重新观察结果、恢复决策以及最终文件差异。若只检查“进程有没有恢复”，无法发现重复执行、丢失审批或错误上下文等语义问题。

本文没有对上述项目统一执行这些故障注入实验；跨项目结论来自固定版本源码和测试阅读。尤其是数据库事务边界、远程 sandbox 的租约行为和 provider 请求的实际提交语义，仍不能仅由静态源码推断。

## 未确认事项

- 各 Agent 是否把 checkpoint 与消息写入放在同一事务中，需结合实际存储适配器继续核实。
- OpenHands 前端 conversation 与 backend runtime 的持久化恢复协议，不能仅从 agent-server 类型定义完全确认。
- Codex、Kimi Code 和 OpenCode 在远程或多进程部署中的 fencing 行为，还需要运行时实验补足。
- 各项目对于旧 schema、旧工具参数和模型切换后的 checkpoint 兼容性，尚未系统追踪提交历史。

下一篇将讨论 replay、retry 与 exactly-once 的边界：为什么“事件可以重放”不代表“工具可以重新执行”，以及 coding agent 如何处理不可逆副作用。

## 参考源码

[^gemini-session]: [Gemini CLI SDK Session](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi-request]: [Kimi StepRequest and StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^codex-approval]: [Codex Turn approval and pending state](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/state/turn.rs#L88-L124)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-agent]: [Pi Agent request snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^opencode-tests]: [OpenCode claim and recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^pi-env]: [Pi shell output capture and spill](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-workspace]: [OpenCode workspace driver](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
