---
title: Navi Agent v0.1 Runtime / Harness 分析
snapshot_id: 2026-09-15.0e50b0a
reviewed_at: 2026-09-15
upstream_repository: https://github.com/xushun007/navi-agent
upstream_commit: 0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46
upstream_commit_date: 2026-08-02
previous_snapshot: null
status: current
change_level: major
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: null
---

# Navi Agent v0.1 Harness 的 Runtime 分析

本文研究 Navi Agent `v0.1.0` 的整体 Runtime/Harness，重点关注：Agent loop 如何被拆成 Runtime、Session、Tool、Policy、Event、Transport 和 Application Service；一次运行的身份、状态、终态和恢复如何处理；以及早期设计如何为后续的长任务、审批、上下文压缩、后台任务和自我进化能力留下扩展边界。

分析基线是远程 tag [`v0.1.0`](https://github.com/xushun007/navi-agent/tree/v0.1.0)，对应 commit [`0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46`](https://github.com/xushun007/navi-agent/commit/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46)。本文只引用 GitHub 固定版本源码；本地 checkout 仅用于读取和验证，不作为文档链接目标。

## 核心结论

Navi Agent v0.1 已经不是一个把 LLM 和几个 Python 函数粘在一起的 demo，而是一个“小而完整”的 Agent Runtime。它的核心选择是：

```text
Gateway / CLI
      ↓
ApplicationService       ← 用例、session identity、interaction、cancel
      ↓
AgentRuntime             ← context、model loop、tool dispatch、finalization
      ├── SessionStore     ← conversation history、run/tool records、compaction
      ├── ToolRegistry     ← schema、toolset、dispatch
      ├── ToolPolicy       ← allow / deny / ask
      ├── ModelTransport   ← provider-neutral model boundary
      └── RuntimeEvents    ← persistence、trace、health、UI subscribers
```

它的架构主线可以概括为六个不变量：

1. **Application Service 不拥有推理细节**，只负责把请求变成 runtime invocation，并管理活动运行和交互恢复。
2. **AgentRuntime 拥有一次运行的控制权**，而不是把循环散落在 CLI 或 Gateway 中。
3. **Session history 与 Run record 分离**：消息是对话事实，run/tool record 是执行治理事实。
4. **Tool capability、policy、approval 和 executor 分离**：工具注册不等于允许执行。
5. **RuntimeEvent 是不可变事实流**：持久化、Trace、Health 和 UI 都是 subscriber 派生物。
6. **在线运行与离线 evolution 分离**：进化系统消费 evidence，不直接修改 live loop。

这使 Navi v0.1 与最初的单循环相比，已经具备 coding-agent harness 的基本骨架；但它仍是单进程、单 runtime、以 SQLite/文件为主的本地系统，不应描述成分布式 orchestration platform。

## 一、生命周期：Session、Run、Iteration、Tool Call

Navi v0.1 没有 Codex 那种显式的 `Submission → Turn → Step` 控制层，而是采用下面的层次：

```text
User request
  └── session_id
        └── run_id                  一次 runtime.run_conversation()
              ├── iteration 1       model call → tool calls → observations
              ├── iteration 2       context rebuild → model call → tools
              └── terminal result    completed / cancelled / waiting / failed / limit
```

### Session

`Session` 是用户和对话历史的长期 identity，包含 `session_id`、`user_id` 和 `messages`。SessionStore 提供 load、append、list、snapshot、recall 和 lineage 能力。Session 解决“模型下一轮看到什么”和“用户以后恢复哪段对话”；它不等于当前运行是否仍在执行。

### Run

`RuntimeRunRecord` 是一次运行的治理记录：`run_id`、session/user、source、agent role、model、开始/完成时间、token/cost、trajectory complete、failure/completion reason 等字段被单独保存。这个设计使一次 session 可以有多个 run，也使取消、失败、超限和恢复不会被误写成普通 assistant message。

### Iteration

`AgentRuntime` 以 `max_iterations` 控制循环，v0.1 默认值为 30。Iteration 是内部推进单位：构造上下文、调用模型、记录模型响应、去重 tool calls、执行 tools，再把结果追加回 session。它不是独立 durable object，但 runtime events 会记录 `iteration`，run record 记录整体边界。

### Tool Call

模型返回的 `ToolCall` 有 id、name 和 arguments。Runtime 先为每个 call 生成 action/tool event，再通过 registry 和 policy 决定 allow、deny 或 ask；工具结果以带有相同 tool call id 的 `ToolResult` 返回模型。这个 action/result correlation 是恢复和审计的关键。

## 二、AgentRuntime：从循环到状态机

`AgentRuntime` 的构造器注入 transport、tool registry、session store、prompt builder、trace store、event subscribers、context engine、tool renderer、background task manager、iteration limit、agent role、parent session、model 和 cwd。由此可见，它并非只封装一个 `while`，而是 runtime dependency boundary。

核心执行路径可以还原为：

```text
run_conversation(session_id, user_id, user_message, ...)
  → load or create session
  → start RuntimeRunRecord
  → publish runtime.started
  → append user message
  → for iteration in max_iterations:
       check cancellation
       inject completed background notifications
       load compaction checkpoint
       build context
       call ModelTransport
       record model response / streamed delta
       if no tool calls: append assistant and finalize completed
       else: dedupe calls → preflight/policy → execute
             append tool result → next iteration
  → finalize exactly one terminal outcome
```

Runtime 内部对模型失败、工具失败、timeout、approval denied、cancelled、waiting for input 和 iteration limit 进行了区分。`finalization_reason` 和 terminal event 保证调用方不需要从最后一条文本猜测运行为什么结束。

源码依据：[`runtime/agent/engine.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/agent/engine.py)、[`runtime/models.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/models.py)。

## 三、Session 与持久化：对话事实和执行事实分层

SQLite SessionStore 在 v0.1 中承担的不只是 message history：

- session/message 表保存会话与消息；
- run record 保存每次 invocation 的生命周期和成本；
- tool call/result 记录保存工具执行治理状态；
- compaction checkpoint 保存已覆盖的消息数量、保护区间、source hash 和 summary；
- lineage 保存 parent session 与 delegated/sub-agent session 的关系；
- FTS/recall 提供跨 session 搜索和上下文窗口。

因此，Navi 的持久化模型已经接近“event/trajectory store”，但还不是严格的 append-only event-sourced database：消息、run、tool 和 checkpoint 仍由不同表/记录路径维护，RuntimeEvent 是事实流与观察流的统一接口。

Session 与 Run 的边界是后续扩展的基础：同一 Session 可以被新输入继续使用；同一 run 可以被取消或进入 awaiting input；新的请求通过 session identity 继续对话，但不能覆盖旧 run 的终态。

源码依据：[`runtime/sessions/sqlite.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/sessions/sqlite.py)、[`runtime/sessions/store.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/sessions/store.py)。

## 四、Context 与 prompt：一次迭代的派生快照

`ContextEngine` 从 session messages、system prompt、workspace context、memory recall、skill index 和已有 compaction checkpoint 构造模型上下文。它可以估算 token，保护头部消息和尾部消息，并在超过阈值时调用 summarizer 生成 `ContextCompactionCheckpoint`。

重要的是：context 是每次 iteration 重新派生的请求输入，不是 Session 的原始事实本身。压缩 summary、workspace/memory/skill prompt 和工具 schema 都是可替换的 context contributors；Session message history 保持更稳定，context engine 决定本轮模型看到的窗口。

这为后续对比 Codex 的 Step snapshot 提供了一个关键观察：Navi v0.1 已有“迭代级上下文构造”，但尚未把模型请求看到的工具、策略、环境和 prompt 统一冻结成显式的 immutable Step record。

源码依据：[`runtime/agent/context.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/agent/context.py)、[`runtime/agent/prompt.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/agent/prompt.py)。

## 五、Tool capability plane：Registry、Policy、Approval、Executor

v0.1 已明确拆开四个问题：

| 边界 | 回答的问题 | 组件 |
| --- | --- | --- |
| Capability | 模型可以看到哪些工具和 schema？ | `ToolRegistry`, toolset definitions |
| Policy | 这次调用是否允许？ | `ToolPolicy`, bash assessment |
| Approval | 是否需要用户确认？ | `ApprovalProvider`, `PendingInteraction` |
| Execution | 如何产生副作用？ | tool handler/executor, background manager |

`ToolRegistry.schemas()` 为 model transport 生成声明；`dispatch()` 先做工具查找、参数和策略路径，再决定执行、阻断或产生 approval-required result。`SensitiveToolPolicy` 支持 allow/deny/ask；`BashCommandPolicy` 对 shell command 和 background execution 做风险评估。审批结果不只是 UI 文本，而是带 tool name、arguments、interaction id 和 origin run id 的可恢复记录。

这意味着 v0.1 的工具不是“动态注入 prompt 的一组函数”这么简单：工具 schema 会进入 model request，toolset selection、policy 和 approval 在 execution path 决定实际能力。当前仍没有完整 sandbox；workspace path checks 和 approval 不能等价于进程隔离。

源码依据：[`runtime/tools/registry.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/tools/registry.py)、[`runtime/tools/policy.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/tools/policy.py)、[`runtime/tools/approval.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/tools/approval.py)。

## 六、RuntimeEvent：统一事实流和多种投影

`RuntimeEvent` 是 frozen dataclass，包含 session id、user id、run id、sequence、kind、source、name、event id、iteration、item id、timestamp 和 metadata。Publisher 向多个 subscriber 发布：

```text
RuntimeEventPublisher
  ├── EventStoreWriter       durable runtime evidence
  ├── TraceBuilder           model/tool trajectory
  ├── RunStateTracker        current run status
  ├── health subscriber      critical/optional delivery health
  └── UI/gateway subscriber  user-facing progress
```

EventStoreWriter 会忽略 delta 类型，说明流式 token 与稳定事件已经分离。Subscriber 可标为 critical；关键 subscriber 失败会进入 publisher health，而不会悄悄消失。这是 v0.1 中很有价值的 harness 设计：观测、持久化和用户展示不需要侵入 Agent loop，但 criticality 仍可被 Runtime 管理。

源码依据：[`events.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/events.py)。

## 七、长任务、取消和交互恢复

ApplicationService 通过 `ActiveRunRegistry` 管理 session 当前活动运行，通过 cancellation token 取消运行；`BackgroundTaskManager` 把长时间工具从当前等待窗口中移出，同时保存 queued/running/completed/cancelled 状态和通知投递状态。

工具或 agent 可以返回 `awaiting_input`。`JsonPendingInteractionStore` 保存 pending/resolved/completed/expired 生命周期；下一次用户输入根据 session id 找回 interaction，审批结果再回到原始 tool call。这里已经出现了 coding-agent harness 的重要原则：用户回复不是无上下文的新 prompt，而是对一个挂起控制点的 resolution。

不过 v0.1 的 interaction 恢复还主要由 ApplicationService 组织，不是一个统一的 durable invocation scheduler。后台任务使用独立 manager，普通 Agent loop 使用 cancellation token，二者的恢复语义尚未完全统一。

源码依据：[`app/service.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/app/service.py)、[`runtime/tasks/background.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/tasks/background.py)、[`runtime/tools/interactions.py`](https://github.com/xushun007/navi-agent/blob/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46/src/navi_agent/runtime/tools/interactions.py)。

## 八、Gateway、Transport 与 Application Service

Gateway 只做协议适配：微信 polling、message normalization、pairing/access policy 和 outbound delivery；CLI 负责交互输入与 slash commands。它们不拥有 planning、tool dispatch、memory 或 finalization。

ModelTransport 抽象 provider 调用，OpenAI-compatible transport 只是一个实现。ApplicationService 将 console/gateway request 归一化为 `AppRequest`，选择 session、system prompt、mode 和 runtime services，再向外返回 `RuntimeResult`。这种分层让同一个 AgentRuntime 可以被 CLI、Weixin 和后续 HTTP/API 使用。

## 九、Memory 与 Evolution：在线 Runtime 之外的两个平面

Memory 解决跨 session 的用户事实和偏好；Session 解决当前会话的事实。ContextEngine 可以读取 memory，但历史 memory 不能覆盖当前 workspace 或新的 user input。

Evolution 更进一步：它消费 runtime evidence、trace、eval case、skill usage 和 review run，生成 prompt/skill candidate，经过 evaluator/gate/governance 后才可能形成 overlay。v0.1 已经把 evolution 放在 Runtime 外部，避免在线循环直接自我修改工具、prompt 或权限。这是 Navi 与许多只把“自我改进”写进 prompt 的 Agent 的重要区别。

## 十、v0.1 的架构成熟度判断

### 已经建立的 Runtime 边界

- Agent loop 与 Application/Gateway 解耦；
- Model、ToolRegistry、Policy、Approval、Session、Context、Event、Trace 都可注入；
- Session message、Run record、Tool record 和 RuntimeEvent 提供多层事实；
- cancellation、background task、awaiting input 和 terminal finalization 已有专门对象；
- prompt/context compaction 已经是 Runtime 组件，而非 CLI workaround；
- memory/evolution 被放在 live loop 之外，通过明确接口接入。

### 尚未解决的边界

- 没有统一的 Step/attempt/checkpoint model，iteration 仍主要是 loop 内变量；
- SQLite 和进程内 manager 适合单机，尚无跨进程 lease、分布式 queue 或 worker ownership；
- approval 不是 sandbox，workspace path policy 不能防止任意宿主副作用；
- dynamic tool/schema、prompt contributors 与 provider cache 尚未形成稳定 snapshot contract；
- background task、interaction resume、session resume 仍是多个机制，而不是统一 execution state machine；
- Gateway 当前以 Weixin 为主，外部协议和多客户端一致性仍有限。

## 十一、与 Codex harness 的连接点

这不是横向比较结论，而是后续研究的统一坐标：

- Navi v0.1 的 `Session → Run → Iteration → Tool Call` 对应 Codex 的 Session/Turn/Step，但 Navi 将 Step 语义留在 loop 内，没有显式 immutable snapshot。
- Navi 的 `RuntimeEvent` 已经承担执行事实和投影分发，接近 event-driven harness；Codex 更进一步把 rollout/thread recovery 作为核心存储。
- Navi 的 ToolRegistry/Policy/Approval/Executor 分层，对应 Codex 的 capability/safety/execution plane，但 Navi v0.1 仍缺少完整 process sandbox。
- Navi 的 ApplicationService + Gateway 与 Codex app-server 的方向相似：将输入、取消、审批和生命周期从 UI/协议适配器提升到控制层。
- Navi 的 Evolution plane 是其独特关注点：Runtime 产生 evidence，离线系统治理行为候选，而不是让 live Agent 直接改变自身。

## 版本依据与不确定性

- v0.1 release tag：[`v0.1.0`](https://github.com/xushun007/navi-agent/tree/v0.1.0)
- v0.1 release commit：[`0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46`](https://github.com/xushun007/navi-agent/commit/0e50b0a61f695d7843c9f75d9a72a6d79a7a2c46)
- 本文阅读了 v0.1 的架构、Runtime、Session、Tool、Event、Application 和相关测试源码；未运行 live model、微信 gateway、真实审批或长任务实验。
- v0.1 的历史意义在于建立 Runtime 边界，而不是证明生产级可靠性；并发、sandbox、跨进程恢复和 provider cache 仍需后续版本验证。

## 十二、v0.1 的完整状态所有权

Navi v0.1 的重要架构特征，是把“谁负责什么”显式写进 runtime 边界，而不是让 CLI 直接操作数据库或工具。按生命周期划分：

| 状态 | 所有者 | 可变性 | 恢复含义 |
| --- | --- | --- | --- |
| Session identity | `SessionStore` / ApplicationService | 低可变 | 通过 `session_id` 找回消息和 lineage |
| Conversation facts | SessionStore | 追加为主 | 新 run 继续同一历史 |
| Run lifecycle | `AgentRuntime` + Run record | 从 active 到 terminal | 取消、失败、限额有明确原因 |
| Iteration state | AgentRuntime 内存循环 | 高可变 | 通常不能独立恢复 |
| Tool call | Registry/Policy/Executor | 调用期间变化 | 由 tool id、run id 关联结果 |
| Pending interaction | ApplicationService/interaction store | waiting → resolved/expired | 用户回复可回到原调用 |
| Runtime event | Event publisher/store | 不可变记录 | subscriber 可重建投影 |
| Environment | cwd、workspace、executor、task backend | 可按 run/tool 重建 | metadata 可追踪，非完整快照 |

这个所有权模型避免了两种常见混淆：Session 不等于 active Run，RuntimeEvent 也不等于 UI notification。一个 Session 可以拥有多个已完成或失败的 Run；一个 Run 可以等待用户；一个 ToolCall 可以启动后台 task；而事件只是把这些状态变化以统一格式传播给存储、trace、health 和宿主。

## 十三、Run 的状态机与恢复边界

从 v0.1 的组件组合，可以抽象出以下 Run 状态机：

```text
created
  → active
  → model_requested
  → tool_preflight
       ├─ denied → observation → active
       ├─ awaiting_input → suspended
       └─ allowed → executing
                       ↓
                    observed → active
  → completed / failed / cancelled / limited

suspended → resolved → executing or active
active → cancelled → finalized
```

这里的 `suspended` 是可恢复控制点，不是失败；`cancelled` 是 Run 的终态，但不必摧毁 Session；`failed` 需要记录 failure reason，避免调用方从最后一条 assistant 文本猜测结果。Run record 和 terminal RuntimeEvent 共同承担终态解释，而消息历史只承担模型可见的对话事实。

v0.1 的恢复粒度主要是 Session/interaction，而不是正在执行的 Iteration。若进程在模型请求或 shell command 中间崩溃，Session 可能可以重新加载，但 active tool 的 lease、子进程和精确的 context snapshot 未必可以恢复。因此 Navi 已具备“可继续对话”的基础，却尚未形成“从任意执行点继续”的 durable execution。

## 十四、Tool Call 的控制流与审批时序

一次工具调用可以压缩为：

```text
model tool call
  → resolve schema and handler
  → validate arguments
  → evaluate ToolPolicy
       ├─ allow → execute
       ├─ deny → durable denial result
       └─ ask → PendingInteraction
                    ↓ user response
                resolve original tool call
  → persist result
  → publish event
  → append observation
  → next iteration
```

这个流程的关键是 approval response 必须携带原始 `run_id`、tool call identity 和 interaction identity。否则用户稍后回复时，runtime 无法判断应该批准哪个调用。Navi v0.1 已经将 pending interaction 独立出来，说明它不把审批当作 UI boolean；但审批、sandbox 和 process isolation 仍不是一个统一安全内核，工具执行器仍需自行遵守宿主边界。

多工具调用的风险在于部分成功：第一个 tool 已经修改文件，第二个 tool 等待审批或失败时，Run 不能简单回滚成“没有执行”。v0.1 的事件、tool record 和 run finalization 可以记录这种事实，但没有证据表明存在跨 tool batch 的事务或 workspace checkpoint。因此报告应把它定位为可审计，不要夸大为可回滚。

## 十五、Event：事实日志还是观察事件

Navi 的 `RuntimeEvent` 同时承担两种用途，但二者需要区分：

- `runtime.started`、tool requested、tool completed、run finalized 等事件接近执行事实，可用于持久化和重建状态；
- streamed delta、health notification、UI progress 等事件更接近观察投影，丢失后可由 canonical record 或下一状态修复。

`frozen dataclass`、sequence、event id、run id 和 critical subscriber 设计，说明 Navi 希望事件具备事实流属性；但 SQLite 中 session、run、tool 和 event 的多表写入路径还不能证明完全 append-only 或事务原子。更稳妥的结论是：RuntimeEvent 是统一的事实/观察协议，EventStoreWriter 负责保留关键 runtime evidence，但 v0.1 尚未证明它是唯一的 source of truth。

这一区分对后续版本很重要：如果某个 subscriber 失败，不能把 UI 没收到事件解释成 Run 失败；如果 durable event 已写入而 UI 断线，重连应以 event store/session store 重建；如果只有 delta 丢失，则不应产生虚假的缺口或重复 tool call。

## 十六、Background Task 与主 Run 的关系

BackgroundTaskManager 将长时间执行从前台等待窗口中分离，但它并未完全变成独立 worker platform。更准确的关系是：

```text
Run
  └─ starts background task
       ├─ task state: queued/running/completed/cancelled
       ├─ output / notification record
       └─ parent run or session correlation
```

主 Run 可以在 task 仍运行时进入下一 iteration、等待输入或结束；下一次 context build 再注入 task completion notification。这提供了长任务的基本体验，但需要明确三项未决语义：父 Run 取消是否级联、Session resume 是否重新 attach task、进程重启后 task owner 是否仍存在。

Navi v0.1 的设计更接近“Runtime 内嵌后台任务管理器”，而不是 OpenHands/Cloud 或 Codex hub 那样的 environment-owned durable worker。这个边界决定了它适合单机个人 Agent，不应直接推断为可横向扩展的任务调度系统。

## 十七、v0.1 的设计原则

### 原则 1：Application Service 负责用例，不负责推理

CLI、Gateway 和未来的 API 入口都将用户请求归一化为 application request，由 ApplicationService 选择 Session、创建 Run、转发 interaction 和 cancellation。模型循环、工具 dispatch 和 context build 留在 AgentRuntime。

收益是宿主可替换、测试边界清晰；代价是 ApplicationService 必须理解足够多的生命周期状态，才能正确处理重复请求、活动 Run 和恢复。

### 原则 2：一次 Run 拥有自己的执行事实

Session 保存长期对话，Run 保存这次 invocation 的模型、usage、failure、completion 和 trajectory 状态。这样同一 Session 的多次尝试可以分开审计，取消或失败不会伪装成 assistant message。

收益是评测、诊断和恢复判断更明确；代价是消息、Run、tool 和 event 多套记录需要保持关联。

### 原则 3：Iteration 是 loop 粒度，不冒充 durable Step

v0.1 记录 iteration number 并用它限制循环，但没有把每次模型请求冻结为完整的 StepRequest/context/tool/environment snapshot。它避免过早引入复杂持久化；代价是中断点恢复只能回到 Session/Run 边界，不能可靠回到任意 iteration。

### 原则 4：Capability、Policy、Approval、Execution 四层分离

Registry 回答“有什么工具”，Policy 回答“是否允许”，Approval 回答“是否需要人”，Executor 回答“如何产生副作用”。这使同一个工具可以被不同 mode、user、workspace 或 host 以不同方式处理。

收益是安全规则可测试、工具可扩展；代价是若缺少统一 snapshot，模型看到的 capability 与实际执行 policy 可能在运行中漂移。

### 原则 5：Event 作为 runtime 的共同语言

Runtime 不直接依赖 UI 或 Gateway 的回调完成状态传播，而是发布结构化事件给 EventStore、Trace、Health 和宿主。这样添加新的 transport 不需要复制 agent loop。

收益是可观测、可订阅、易于测试；代价是事件幂等、sequence、重连和 durable/ephemeral 分类必须继续完善。

### 原则 6：Context 是每次 Iteration 的派生快照

Session message、memory、workspace、skills、compaction 和 tool definitions 在每次 iteration 共同构造 context。原始 session facts 与当前模型输入分开，使压缩可以替换 projection 而不必改写全部历史。

收益是长上下文和扩展能力；代价是没有 immutable Step snapshot 时，复盘者难以精确重现某次请求看到的全部输入。

### 原则 7：交互等待必须有可恢复 identity

`PendingInteraction` 让 approval、question 和其它人工输入拥有 interaction id 与生命周期。用户回复是对挂起控制点的 resolution，而不是无关联的新 prompt。

收益是 CLI、Gateway 和未来多 host 可以共享交互语义；代价是 interaction expiration、session replacement 和 concurrent approvals 需要进一步定义。

### 原则 8：Evolution 位于 Live Runtime 之外

Runtime 产生 trace、tool usage、失败和评测 evidence；Evolution 系统离线生成 skill/prompt candidate，经 gate 后才作为新配置接入。在线 loop 不直接自我修改能力和权限。

收益是安全、可审计、便于实验；代价是改进反馈不是即时的，需要额外的 candidate lifecycle 和治理流程。

## 十八、设计收益与代价

| 设计选择 | 主要收益 | 主要代价 |
| --- | --- | --- |
| ApplicationService + AgentRuntime | 宿主与 loop 解耦 | 用例层要协调活动状态 |
| Session 与 Run 分离 | 长期身份和执行审计清晰 | 多记录关联复杂 |
| RuntimeEvent | UI、trace、health、持久化复用 | 事实与观察事件需要分类 |
| Registry/Policy/Approval/Executor | 工具扩展和安全测试 | capability snapshot 不完整 |
| SQLite + FTS | 单机恢复、检索、低运维 | 缺少分布式 lease/worker 语义 |
| BackgroundTaskManager | 长任务不阻塞前台 | parent/child 恢复尚不统一 |
| ContextEngine | 压缩、memory、skills 可组合 | 精确重放成本较高 |
| Evolution side plane | 在线运行安全、候选可治理 | 反馈闭环更慢 |

## 十九、Navi v0.1 的产品定位

Navi v0.1 最准确的定位是“面向个人/本地场景的可扩展 Agent Runtime 骨架”，而不是已经成熟的 coding-agent 平台。它已经把 coding agent 所需的关键问题抽象出来：工具调用、审批、会话、上下文、事件、取消、后台任务和执行环境；但这些能力仍主要在单进程、SQLite 和可注入 service 边界内协作。

它的产品价值不是提供 Codex 式完整 coding workflow，而是提供一个可以逐步加入 workspace、memory、tool policy、gateway、evolution 和多 Agent 能力的内核。v0.1 的架构成熟度应评价为“边界意识强、durability 尚未完成”：它比 demo 更像 runtime，比产品级 harness 更缺少跨进程恢复、环境快照、原子 checkpoint 和多宿主一致性。

## 二十、严格的 v0.1 结论

Navi v0.1 已经建立了一个清晰的最小 Runtime：ApplicationService 管理用例和活动运行，AgentRuntime 管理一次 Run，SessionStore 保存长期事实，ContextEngine 生成 iteration 输入，ToolRegistry/Policy/Approval/Executor 管理能力和副作用，RuntimeEvent 向存储与宿主传播事实。

它尚未证明以下能力：从任意 Step 恢复、跨进程接管 active task、workspace 与 transcript 原子回滚、动态工具变化下的请求 cache 稳定性、以及多 Gateway/worker 的一致调度。因此本报告不把 Navi 描述为“已经完成的平台化演进”，而把 v0.1 定位为一个为长期 runtime 演进预留了正确边界的早期架构快照。
