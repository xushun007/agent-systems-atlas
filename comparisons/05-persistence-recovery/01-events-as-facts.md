---
title: Coding Agent 的事件、持久化与恢复：执行事实与事件日志
series: Coding Agent 的事件、持久化与恢复
part: 1
reviewed_at: 2026-09-17
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的事件、持久化与恢复：执行事实与事件日志

## 结论

Coding Agent 的事件日志不是 UI 消息的附属品，也不是把对话逐行写入文件。它是 Runtime 对一次执行作出的**事实记录**：谁在什么 Session 和 Turn 中提出了什么动作，动作是否获得授权，在哪个 Environment 中执行，产生了什么结果，以及系统最终如何解释这个结果。

如果系统只保存“用户输入 + 模型回复”，它可以恢复对话，却不能可靠地恢复执行。恢复一个 coding agent，至少要回答以下问题：

- 某个工具调用是否已经真正执行，还是只生成了模型请求？
- 文件修改发生在模型回复之前还是之后？
- 审批是针对一次调用、一个 Turn，还是后续所有相同动作？
- 一个流式响应被中断时，已经接收的内容是否可作为事实？
- 恢复时应继续等待、重试、补偿，还是把动作标记为未知？

因此，成熟 Runtime 通常会把以下几种表示分开：

```text
用户/模型消息       面向模型和用户的语义内容
Runtime 事件        面向执行事实的追加记录
观察/结果           Environment 对动作的返回
Trace               面向诊断的时间与调用关联
Checkpoint          可以从中继续计算的状态边界
投影                从事实派生出的 UI、模型上下文或统计视图
```

它们可以共享 ID 和时间信息，但不应互相冒充。事件是事实的候选载体；消息是语义投影；trace 是诊断视图；checkpoint 是恢复协议。把这些概念合并，短期内代码更少，长期则会使重放、审计和故障恢复无法定义。

## 1. 先定义“事实”

本文把事实定义为：Runtime 已经接受、确认或观察到的状态变化，并且能够说明其来源、归属和状态。事实不等于模型声称发生了什么。

例如，模型返回：

```json
{"name":"shell","arguments":{"command":"pytest"}}
```

这只证明模型请求了一个动作。它不能证明命令已经启动，更不能证明测试通过。至少还需要区分：

```text
ToolCallProposed   模型产生了调用请求
ToolCallAccepted   Runtime 接受并分配了调用身份
ApprovalRequested  系统等待外部授权
ApprovalGranted    授权已针对某个边界成立
ExecutionStarted   Environment 已开始执行
ObservationReady   Environment 返回了结果
ExecutionFinished  Runtime 确认调用终态
```

不同系统未必使用这些完全相同的名称，但如果它们在实现上把多个阶段压成一条“tool message”，就必须承认：恢复器无法区分“尚未执行”和“执行结果丢失”。

### 1.1 事实的最小属性

一条能够支持恢复的执行事实，通常需要包含：

| 属性 | 作用 |
| --- | --- |
| `event_id` | 标识这一条不可混淆的记录 |
| `session_id` / `turn_id` / `step_id` | 确定状态归属和生命周期位置 |
| `parent_id` 或序列号 | 表示因果顺序或事件链 |
| `kind` | 区分输入、动作、审批、观察、错误和终态 |
| `payload` | 记录可重建所需的结构化内容 |
| `status` | 表示 pending、running、completed、failed、cancelled 等状态 |
| `environment_ref` | 说明动作作用于哪个执行环境 |
| 时间信息 | 区分接受、开始、结束等不同时间点 |
| schema/version | 允许后续读取旧记录 |

这不是要求每个项目都使用数据库或完整事件溯源。它要求的是：当系统宣称支持恢复时，恢复所依赖的字段必须真实存在，而不能依靠 UI 文本猜测。

### 1.2 事实、解释与推测

Runtime 应将以下三类内容分开：

1. **已观察事实**：命令返回码为 `1`，文件读取返回某段内容，审批被拒绝。
2. **Runtime 解释**：将返回码映射为工具失败，将拒绝映射为“不再执行该调用”。
3. **模型推测**：测试失败可能由依赖版本不匹配造成。

第三类可以进入上下文，但不能写回执行日志成为事实。否则下一次恢复会把模型的猜测当作已经验证的环境状态。

## 2. 五种常被混淆的记录

### 2.1 Message：语义通信记录

Message 是用户、模型、工具或系统之间传递的内容。它通常服务于两件事：构造下一次模型请求，以及向用户展示会话历史。

一个 message 可以包含工具调用和工具结果，但这并不意味着它足以表达工具生命周期。Provider 的 message 格式常常只关心“模型请求了什么”和“模型看到了什么”，而不关心审批等待、进程启动失败、调用租约或恢复决策。

Message 的优点是容易展示、容易发送给模型；缺点是它通常是**语义层表示**，会丢掉执行层的中间状态。

### 2.2 Event：Runtime 的事实记录

Event 记录系统观察到或接受到的状态变化。它更接近 append-only log，但“事件”这个名字本身不保证不可变性：有些系统会更新同一个事件，有些会追加新的状态事件覆盖旧状态。

研究一个实现时，必须确认它的事件语义：

- 是每次变化追加一条，还是保存当前状态的可变行？
- 事件是否可以在恢复时重新驱动状态机？
- 事件是内部事实，还是从消息和日志拼出来的观察记录？
- 事件的顺序由数据库序号、时间戳，还是内存回调顺序决定？

### 2.3 Observation：Environment 的返回

Observation 是动作作用于 Environment 后得到的观察结果。命令 stdout、stderr、退出码、文件内容、补丁应用结果、浏览器截图和远程 API 响应都可以是 observation。

Observation 不是 action 的同义词，也不一定是完整事实。一个进程可能启动成功但结果尚未产生；一个长时间命令可能只返回了流式片段；一个远程调用超时可能已经在服务器端产生副作用。结果的“不确定”本身也是需要记录的状态。

### 2.4 Trace：诊断与性能视图

Trace 关心调用链、延迟、token、重试、provider 请求和进程跨度。它适合回答“慢在哪里”“哪一次请求触发了失败”，不一定适合回答“系统状态是什么”。

Trace 数据经常采样、异步写入或按保留策略删除，因此不能默认作为恢复依据。相反，事件日志也不应承担全部高基数性能数据，否则会使核心状态存储膨胀。

### 2.5 Checkpoint：可继续计算的边界

Checkpoint 不是“最近一条日志”，而是 Runtime 声明的一个可恢复边界。它应至少包含或能定位：

- 已纳入的历史和当前分支；
- 未完成的 Turn、Step 或工具调用；
- 权限和 Environment 的有效引用；
- 已确认的副作用与未知副作用；
- 恢复后下一步允许执行的动作。

一段 JSONL trajectory 可以帮助重建 checkpoint，但 trajectory 本身不一定具备恢复语义。若缺少未完成动作、Environment identity 或版本化策略，重新读取 trajectory 只能再次生成 prompt，不能安全地继续执行。

## 3. 事件日志的三种架构形态

实际项目大致落在三类，而不是只有“事件溯源”和“没有事件”两个极端。

### 3.1 消息日志主导

```text
user/model/tool messages -> transcript -> next prompt
```

这是最小 Agent 常用的结构。mini-SWE-agent 的默认 loop 以 query、action 和 observation 推进 trajectory；它清晰地展示模型交互，却没有自动提供 Session Store、工具注册中心或完整 workspace identity。[^mini-default]

这种架构适合短生命周期、单进程、单 Environment 的任务。它的边界也很明确：若进程在工具执行后、写入下一条 observation 前崩溃，系统可能只能判断“最后一个动作存在”，无法判断副作用是否完成。

### 3.2 事件与消息并列

```text
                    -> messages -> model/UI
accepted execution  -> events   -> state/recovery
                    -> traces   -> diagnostics
```

Codex 的执行记录和上下文管理体现了这种分层倾向。工具调用有独立的 retained metadata，history 还负责把工具调用与结果配对；这使模型历史与执行记录不必完全使用同一表示。[^codex-tool-recorder] [^codex-history-pairing]

OpenHands 则以 Action 和 Observation 类型表达 Agent 与执行环境之间的交互；这些类型不仅是 UI 文本，还携带动作类别、参数和观察结果的结构。[^openhands-events] [^openhands-observation]

并列存储的难点是双写一致性：如果先写 message 再执行动作，崩溃会留下未执行的调用；如果先执行再写 message，崩溃会留下已经发生但历史不可见的副作用。因此必须明确“接受调用”和“执行调用”之间的恢复状态，而不是仅靠写入顺序碰运气。

### 3.3 Durable harness / 执行声明主导

```text
operation claim -> execution lease -> effect -> persisted result
        |              |              |
     recover        resume/abort    reconcile
```

Pi v4 harness 将 lane、operation、frame、restore 和工具恢复放在 durable runtime 中；恢复逻辑会检查未完成 assistant generation，并按工具策略决定继续、重放或写入恢复结果。[^pi-restore] [^pi-recovery] [^pi-tool-recovery]

OpenCode 的 Session execution 也把执行 claim、状态和恢复测试作为独立概念处理，而不是把 Session message 当作唯一的锁。[^opencode-execution] [^opencode-tests]

这种架构的核心不是“日志更多”，而是 Runtime 对执行拥有明确声明：某项工作由哪个运行者认领、当前是否仍在运行、恢复者是否可以接管，以及外部副作用需要如何对账。

## 4. 一次工具调用应如何落在日志中

可以用如下状态序列检验一个 Runtime 的事件模型：

```text
ModelResponse
    ↓
ToolCallProposed(call_id)
    ↓
ToolCallAccepted ──拒绝──> ToolCallRejected ──> Step/Turn continuation
    ↓
ApprovalRequested
    ↓
ApprovalGranted / ApprovalDenied / ApprovalExpired
    ↓
ExecutionStarted
    ↓
ObservationChunk*             (可选)
    ↓
ObservationReady / EffectUnknown
    ↓
ExecutionFinished
    ↓
ToolResultMessage + next model request
```

这里最重要的是 `EffectUnknown`。超时、进程被杀、网络断开时，系统经常知道“请求已经发出”，却不知道远端副作用是否完成。把它直接写成 `failed` 会误导恢复器安全重试；把它写成 `completed` 又会伪造结果。未知是一个真实而有用的终态，需要后续查询、幂等键或人工决策处理。

### 4.1 审批不是工具结果

审批属于控制平面事实，不是 Environment observation。Codex 将权限回复绑定到调用身份，并把等待中的 approval 放在 Turn 状态中；这说明“用户允许了什么”与“命令返回了什么”是不同生命周期。[^codex-approval]

Gemini CLI 的 policy engine 也把策略评估与 shell 执行分开：策略决定调用是否可继续，shell 层才执行动作。[^gemini-policy] [^gemini-shell]

如果只保存一条“用户同意执行命令”的 message，恢复时无法知道：同意是否已经被某个 call 消费、该同意是否只适用于当前参数、模型重试是否可以复用它。审批事件应关联 `call_id`、策略版本和授权范围。

### 4.2 流式输出不是多个完成结果

模型 token、工具 stdout 和 UI 增量都可能是流式片段。片段适合实时展示和诊断，但不应每个都被当作新的业务状态。建议区分：

```text
stream_started
stream_chunk(sequence, payload)
stream_interrupted(reason)
stream_completed(final_payload)
```

只有完成或明确中断的聚合状态才适合进入模型历史；原始片段可以外置到 trace 或 blob 存储。否则恢复器可能把半条 JSON tool call 当成完整调用，或者把同一输出重复注入上下文。

## 5. 事实日志与模型上下文必须分离

模型需要的是可理解的上下文，不是数据库转储。一个 Runtime 应该从事实日志生成多个投影：

```text
事实日志
  ├── transcript projection     面向模型的消息历史
  ├── UI projection              面向用户的进度和结果
  ├── recovery state             面向恢复器的未完成操作
  ├── audit record               面向权限与责任追踪
  └── trace projection           面向性能和诊断
```

这使系统能够在不改变事实的情况下重新生成模型上下文。例如，Codex 的 history manager 同时保留面向 prompt 的转换和带注解的内部历史，且在压缩、rollback 等重写操作中维护 history version。[^codex-history]

OpenCode 也不是把 Session message 原样交给 provider，而是通过 `to-llm-message` 按消息类型、工具结果和模型格式转换。[^opencode-context]

Pi 的 JSONL storage 与 durable recovery 则说明：持久化 frame 可以作为事实和恢复输入，Agent loop 的 context snapshot 只是某次模型请求的内存视图。[^pi-jsonl] [^pi-agent]

分离投影还有一个安全收益：可以向 UI 展示完整错误和调试信息，却只把经过裁剪的结果放入模型上下文；也可以保留审计所需的原始审批记录，而不把内部策略细节暴露给模型。

## 6. 追加日志不等于事件溯源

很多系统把事件追加到 JSONL、数据库或消息队列，就称为 event-sourced。这个判断并不充分。至少需要验证三个条件：

1. 当前状态能否从事件按确定规则重建；
2. 重建是否包含未完成操作和外部副作用的不确定性；
3. 事件 schema 和解释规则是否具备版本兼容性。

Pi JSONL 具备事务式存储和恢复相关记录，但具体的恢复语义由 harness runtime 的 restore 和 recovery 逻辑共同定义，而不是由文件格式单独决定。[^pi-jsonl] [^pi-restore]

OpenCode 的 execution claim 采用持久状态和测试验证恢复，但这仍属于围绕 Session execution 的 durable coordination，不自动意味着所有聊天消息都能作为通用事件重放。[^opencode-execution] [^opencode-tests]

事件溯源的真正成本在于“事件解释器”的长期维护。增加一个事件类型并不只是增加一个结构体，还要决定旧版本如何读取、事件是否可重放、外部动作是否需要重新执行，以及旧事件生成的新投影是否仍然与当时用户看到的结果一致。

## 7. 恢复时的状态分类

恢复器不应只按最后一条记录决定动作，而应先将运行状态分类：

| 状态 | 已知事实 | 默认恢复动作 |
| --- | --- | --- |
| `not_started` | 调用已排队但未执行 | 可取消或重新调度 |
| `running` | 已取得执行权，未有终态 | 检查租约、接管或等待 |
| `completed` | 有明确结果和完成记录 | 生成后续 Context |
| `failed` | 执行明确失败且副作用语义已知 | 向模型报告失败或结束 |
| `cancelled` | Runtime 或用户明确取消 | 记录取消原因，决定是否继续 Turn |
| `effect_unknown` | 请求可能已经产生副作用 | 对账、人工确认或幂等重试 |
| `orphaned` | 运行者消失但状态未收敛 | 依租约和 Environment 状态恢复 |

`failed` 与 `effect_unknown` 的区别是所有可靠恢复设计的分水岭。一个本地进程在启动前失败，通常可以安全重试；一个网络请求超时，可能已经创建远端资源，不能仅凭客户端异常重试。

## 8. 跨 Agent 的差异

| Agent | 主要事实载体 | 模型上下文关系 | 恢复能力的主要边界 |
| --- | --- | --- | --- |
| Codex | Session/Turn/Step 状态、工具记录、history metadata | history 是 Context 的投影 | 需要区分输入、审批、工具执行和 history 重写 |
| Pi | JSONL frames、lane/operation、Agent messages | loop snapshot 与 durable harness 分层 | 工具 replay 和 assistant generation recovery 是关键 |
| OpenCode | Session message、execution claim、compaction 状态 | `to-llm-message` 生成 provider 输入 | claim、消息和外部 workspace 需要对账 |
| OpenHands | Action/Observation 事件、conversation 与 workspace 状态 | Agent server 将执行环境信息提供给 Agent | 前端历史不等于后端可继续执行状态 |
| Gemini CLI | Session transcript、policy 与 SDK context | 动态 instructions 与 transcript 共同组装 | resume、动态环境和流式执行的边界需单独验证 |
| Kimi Code | StepRequest、持久 task state、tool dedupe | 请求定型时生成 Context | 请求身份、去重和取消必须跨重试保持 |
| mini-SWE-agent | trajectory 中的 action/observation | 直接作为 loop 历史 | 默认实现不提供完整 Session Store 和恢复协议 |

这张表不代表实现复杂度的排名。它表达的是责任放置的位置：轻量系统把事实、上下文和控制流集中在 trajectory；产品化 Runtime 则逐步拆出审批、执行 claim、工具结果、Environment identity 和恢复状态。

## 9. 机制级解剖：事件究竟由谁拥有

前面的分类如果不落到实现边界，仍然只是术语表。下面按“事实在哪里产生、何时提交、如何重新投影”拆开看。

### Codex：工具结果不是普通消息

Codex 在 `executed_tool_calls` 中保留已执行工具调用的结构化记录，`history` 还专门处理 tool call 与 tool result 的配对。[^codex-tool-recorder] [^codex-history-pairing] 这意味着工具事实有两条约束：一是必须能回填到模型历史，二是不能只依赖 UI 展示文本。审批也有 Session 侧的所有权，而不是由单个工具自行决定。[^codex-approval]

因此 Codex 的事件模型更接近“Turn 内的责任账本”：模型提出调用、Runtime 接受调用、工具产生结果、结果进入 history 是不同阶段。它的优势是能解释中断和 compaction 后的上下文；代价是 history 重写时必须维持调用配对，不能把压缩摘要当作原始事实。

### Pi：frame 是事实，replay policy 是解释器

Pi 的 JSONL storage 将 harness 状态追加为 frame，恢复逻辑再依据 assistant generation、tool operation 和 frame 的落盘情况决定如何继续。[^pi-jsonl] [^pi-recovery] 工具恢复并非“发现未完成就重跑”，而是由工具 replay policy 判断是否可以恢复结果。[^pi-tool-recovery]

这把事实和解释器分开：JSONL 说明曾经提交了什么，policy 说明重启后哪些内容可以重新计算。它适合长生命周期 harness，但也把 schema 兼容、frame 顺序和工具 policy 变成长期维护责任。

### OpenCode：Session message 与执行 claim 不是同一种事件

OpenCode 的 Session message 可以被 `to-llm-message` 投影为 provider 输入；execution claim 则解决当前谁拥有运行权。[^opencode-context] [^opencode-execution] 前者是可重建的对话事实，后者是带并发语义的控制事实。把两者合并会导致“历史还在”被误认为“任务仍可继续”。

OpenCode 的关键设计是把 execution 从消息流中剥离出来。这样可以独立处理 worker 崩溃和接管，但也要求恢复器同时检查消息、claim 和 workspace，而不能只读取最后一条 assistant message。

### OpenHands：事件记录交互，不能替 Environment 作证明

OpenHands 的 `Action`/`Observation` 类型表达 Agent 与后端执行服务之间的交互，Observation 是 Runtime 看到的结果，而不是对远程 workspace 当前状态的永久承诺。[^openhands-events] [^openhands-observation] agent-server 还会把 workspace/context 信息作为运行请求的一部分传递。[^openhands-adapter]

这适合跨进程、跨服务架构：事件用于恢复 Agent 语境，Environment 负责重新确认实际状态。代价是事件轨迹和远程副作用天然存在时间差，不能用“有 Observation”推出“远端操作 exactly-once”。

### Kimi Code：请求身份把事实粒度推进到 Step

Kimi Code v2 在 loop 中将 StepRequest 定型，再把请求送入工具策略、权限门和任务状态；请求身份因此比一条普通模型消息更适合作为事实索引。[^kimi-materialize] 这种粒度能回答“这个 step 是否已被消费、是否等待权限、是否应继续”，但也要求 request、task 和 tool call 的 id 在重试中保持稳定。

### Gemini CLI 与 mini-SWE-agent：事实集中在 loop 轨迹

Gemini CLI 的 Session stream loop、policy 和 shell 是清晰的控制点，但其核心记录仍围绕 Session/context 和工具结果组织。[^gemini-policy] [^gemini-shell] mini-SWE-agent 则直接把 action/observation 放在 trajectory 中。[^mini-default] 这两种设计都能支撑短任务；当需要多 worker 接管或远程副作用对账时，必须在 loop 外再引入 operation identity、checkpoint 和 Environment observation。

## 10. 设计原则

### 原则一：先记录责任，再记录文本

记录“哪个调用由哪个 Turn 负责”比记录一段漂亮的工具描述更重要。文本可以重新渲染，责任归属丢失后很难补回。

### 原则二：把未知作为一等状态

崩溃和超时并不总是失败。对外部副作用而言，未知状态比错误状态更准确，也能阻止恢复器做出危险的自动重试。

### 原则三：事实不可变，投影可重建

模型历史、UI 卡片和摘要都可能重新生成；原始动作、授权、观察和终态应尽量追加保存。若出于成本需要压缩，应保存压缩边界和来源，而不是静默覆盖事实。

### 原则四：执行结果必须带 Environment 身份

同一条命令在本地目录、容器、远程 sandbox 和已变更的 Workspace 中不具有相同语义。没有 Environment reference 的 observation 不能可靠地用于恢复。

### 原则五：重放是策略，不是副作用

重放事件应默认只重建状态和 Context；是否重新执行工具，需要依据工具的副作用类别、幂等键和对账结果单独决定。

### 原则六：终态需要收敛证明

`completed`、`failed` 和 `cancelled` 不应只是 UI 标签。Runtime 要能说明对应的 action、observation、approval 和资源租约已经如何收敛；否则下一次恢复仍然会重新发现同一个悬挂状态。

## 11. 如何验证一个 Agent 的事件模型

源码研究可以先建立事件表，再用故障注入验证其真实性。至少应覆盖：

| 场景 | 需要观察的事实 |
| --- | --- |
| 模型生成 tool call 后立即崩溃 | 是否区分 proposed 与 accepted |
| 审批等待时进程退出 | approval 是否可恢复，范围是否保持 |
| 工具已产生文件后客户端断线 | 是否能识别 effect unknown |
| 流式结果中途取消 | 半结果如何保存，是否重复注入 |
| 结果写入前崩溃 | 重启后是否重复执行或安全对账 |
| 两个恢复者同时启动 | 是否有 claim/lease/fencing |
| Context 压缩后恢复 | 事实日志是否仍可重建原始责任 |

验证结果必须区分源码证据和运行时证据。本文对 Codex、Pi、OpenCode、OpenHands、Gemini CLI、Kimi Code 和 mini-SWE-agent 的结论主要来自固定版本源码和测试阅读，没有在这些项目上统一执行故障注入实验。因此，文中关于“实现明确记录了什么”的判断是已验证的源码事实；关于生产部署下崩溃窗口、数据库原子性和远程副作用的结论仍需实验或部署配置证实。

## 未确认事项

- 各项目的日志落盘是否与工具副作用处于同一原子事务，不能仅凭内存状态机确认。
- provider 断线时已提交的请求是否产生副作用，通常需要 provider 或 Environment 的幂等协议。
- UI 展示的事件顺序是否严格等同于 Runtime 的提交顺序，尤其是异步订阅和远程 Session 场景。
- 事件 schema 的长期兼容和迁移策略，需要进一步结合各项目的版本提交和实际存储格式研究。

下一篇将从这些事实记录出发，研究持久化模型和恢复边界：哪些状态必须落盘，哪些可以重建，以及 checkpoint 为什么不是 transcript 的别名。

## 参考源码

[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^codex-tool-recorder]: [Codex executed tool call retention](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-history-pairing]: [Codex history tool-call pairing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L690-L725)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-observation]: [OpenHands observation schema](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/base/observation.ts#L55-L140)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-tool-recovery]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-tests]: [OpenCode claim and recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^pi-agent]: [Pi Agent request snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
