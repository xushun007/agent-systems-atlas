# Codex Multi-Agent V2：线程树、消息语义与资源治理

## 结论

Codex Multi-Agent V2 的本质不是在一个 Agent Loop 内并行几个函数，而是建立一棵独立 Codex thread/session 组成的任务树。整棵树共享一个 session-scoped `AgentControl`，后者统一管理 canonical agent path、父子关系、消息投递、并发执行、内存驻留和持久化恢复。

它把几个容易混淆的概念明确分开：

1. `spawn_agent` 创建独立线程，并用一条会触发 Turn 的 `InterAgentCommunication` 交付初始任务；
2. `send_message` 只投递 mailbox，不唤醒空闲目标；`followup_task` 才会触发新 Turn；
3. 子 Agent 的终态自动回送父 mailbox，`wait_agent` 等待的是本地输入活动，不是轮询子线程；
4. 并发执行槽限制“同时跑多少子 Turn”，residency 限制“内存里保留多少子 Session”；
5. Agent 身份和父子边会持久化，已卸载子线程可从 Rollout 恢复后继续接收消息。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读，重点分析 V2。本文没有运行并发 Agent、跨进程恢复或 residency 压力实验。

## 机制图

- [Codex Multi-Agent V2 关系图](../diagrams/codex-multi-agent-v2.excalidraw)
- [符号级源码索引](../source-map.md)

## 1. 工具层只是控制面的适配器

V2 暴露 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent` 和 `list_agents`。Handler 负责解析参数、解析相对/绝对 task path、发活动事件，再把操作交给共享 `AgentControl`。真正的线程创建、提交、恢复和限制不在工具 Handler 内。

工具可以放在配置的 namespace 中，并按 V2 Feature、模型能力、code mode 和 `wait_agent_enabled` 选择性暴露。Multi-Agent mode 还会作为 World State 指令进入 Prompt：Ultra reasoning 默认可采用 proactive 模式，其他情况默认只在明确请求时使用；部署方可用自定义 hint 覆盖。

## 2. AgentControl 按根会话树隔离状态

根线程与所有后代共享同一个 `AgentControl`，但不同根会话树不共享 registry。它包含：

- `AgentRegistry`：`AgentPath ↔ ThreadId`、昵称、角色和 spawn reservation；
- `AgentExecutionLimiter`：正在执行的 V2 子 Agent Turn 数；
- `V2Residency`：已加载子 Session 的 LRU 队列；
- `RolloutBudget`：整棵树共享的推理预算；
- 到全局 `ThreadManagerState` 的 weak reference，避免引用环。

因此 path `/root/task_a/worker` 既是可读任务身份，也是寻址键；UUID 仍是底层 thread identity。相对引用由当前 AgentPath 解析，重名 path 在 reservation 阶段被拒绝。

## 3. Spawn 先保留资源，再创建线程

`spawn_agent` 的关键顺序是：

1. 从当前 `SessionSource` 计算 child depth 和 canonical path；
2. 基于当前 Turn 构建 child Config，刷新模型/provider、reasoning、cwd、审批与 permission profile；
3. 预留 execution/residency/spawn slot、path 和昵称；
4. 创建全新 thread，或从父 history 构造 fork；
5. commit registry/residency reservation，通知客户端 thread created；
6. 持久化 parent-child edge；
7. 投递带 `trigger_turn=true` 的初始通信。

reservation 使用 Drop 回滚未提交槽位，减少部分创建失败造成的容量泄漏。V2 的默认并发容量由 `max_concurrent_threads_per_session` 控制；root 本身不受子 Agent execution limiter 计数，提示中的并发槽则按产品语义包含 root。

## 4. fork_turns 控制继承多少父上下文

V2 接受 `none`、`all` 或正整数形式的 `fork_turns`：

- `none`：建立新线程，只靠初始任务和新 Session 初始上下文；
- `all`：父 Rollout flush 后继承完整可用模型历史；
- `N`：先截取最近 N 个 fork Turn，再建立 child history。

Fork 不是原样复制 Rollout。过滤器保留 system/developer/user 与 assistant final answer，移除 reasoning、tool call/output、agent message、inter-agent communication 和大多数运行事件；压缩 replacement history 也使用相同清理。V2 还移除父/子 usage hint，必要时把父 developer fragment 替换为 child instructions。

完整 fork 可保留 World State/TurnContext reference baseline；截断 fork 必须重建首个 child context。若最新 legacy compaction 没有 replacement history，也不能安全沿用 reference baseline。`agent_type` 不能与 full-history fork 同时覆盖，因为完整上下文已经绑定父角色语义。

## 5. 消息是否触发 Turn 是显式协议字段

`InterAgentCommunication` 携带 author、recipient、content 和 `trigger_turn`：

- `send_message` 使用 `QueueOnly`：消息进入目标 mailbox；目标正在运行时可在 drain 边界消费，空闲时不会启动 Turn；
- `followup_task` 使用 `TriggerTurn`：确保目标已加载并检查执行容量，然后提交带 parent turn id 的通信；不能以 root 为目标；
- Spawn 初始任务也设置 `trigger_turn=true`；
- 完成通知设置 `trigger_turn=false`，避免子完成自动启动父 Turn。

这个区分让“补充正在进行的任务上下文”和“给已结束 Agent 新任务”拥有不同调度语义，而不是依赖目标当前状态猜测调用者意图。

## 6. 完成结果由子 Session 直接回流

V2 child 发出 `TurnComplete` 或 `TurnAborted` 时，`Session::maybe_notify_parent_of_terminal_turn()` 把事件转换为 `AgentStatus`，构造标准 completion envelope，并通过同一通信通道投递给直接父 Agent。结果只进入父 mailbox，不触发父 Turn。

父 Agent 可在后续 sampling/input drain 边界收到结果；若正阻塞在 `wait_agent`，mailbox activity 会立即结束等待。这个路径比父端为每个 child 建 watcher 更直接；旧版兼容路径才使用 detached status watcher。

## 7. wait_agent 等待输入活动，不等待指定 Agent

V2 `wait_agent` 没有 agent id 列表。它先检查当前 Turn 是否已有 pending mailbox/steer，再订阅 `InputQueueActivity`：

- mailbox 到达 → `Wait completed`；
- 用户 steer → `Wait interrupted by new input`；
- 到达配置 deadline → `timed_out=true`。

最小、默认和最大 timeout 由 V2 Config 限制，避免紧密轮询。一次唤醒只说明“有新活动”，调用者再读取回流消息或 `list_agents`；它不是所有子任务完成的 barrier。

## 8. Interrupt 与状态查询保持树边界

`interrupt_agent` 解析目标 path 后拒绝 root 和 self，向目标提交标准 `Op::Interrupt`；目标已消失或内部死亡按幂等成功处理。它只打断当前 Task，不删除线程、Rollout 或后代。

`list_agents` 从 registry 取 canonical path，再查询 live thread status，可按相对或绝对 path prefix 过滤。结果包含 root 与仍在控制树中的 live agents。消息前会用 `ensure_agent_known()` 防止向树外任意 ThreadId 发送。

## 9. 执行容量与内存驻留是两层限制

`AgentExecutionLimiter` 只在一个 V2 subagent 将要从 idle 启动 Turn 时检查；已在运行的 Agent 接收 queue-only 消息不新增执行槽。Task 生命周期持有 `AgentExecutionGuard`，结束时自动归还 active 计数。

`V2Residency` 则跟踪已加载子线程。容量满时按 LRU 寻找 `Completed/Errored/Interrupted`、无 active Turn、mailbox 为空的 Session：先物化 Rollout并 shutdown，再从 ThreadManager 移除。身份与 spawn edge 仍保留；下一次 message/followup 通过 `ensure_v2_agent_loaded()` 读取存储 metadata 和模型历史，以相同 ThreadId 恢复。

活跃或有待处理消息的线程不可驱逐。这样并发上限保护模型执行资源，residency 上限保护进程内 Session 资源，二者不会把“结束但以后可能复用”误当成“永久关闭”。

## 10. 父子图是持久化事实

非 ephemeral child 创建后，AgentControl 把 open spawn edge 写入 Agent Graph Store。根 Session 恢复时先恢复 V2 agent metadata，不立即加载每个 runtime；需要交互时再 lazy load Rollout。父子 edge 同时支持 descendant 查询、树状展示和生命周期治理。

Thread 的 `SessionSource::SubAgent(ThreadSpawn)` 还保存 parent thread、depth、path、nickname 和 role。它进入 Rollout/Thread metadata，使身份不只存在于内存 registry。V2 当前主要依靠并发、residency 和产品 usage policy 控制扩张；传统 V1 还在工具暴露和 handler 层应用 `agent_max_depth`。

## 关键设计约束

1. 每个 Agent 拥有独立 Session/History，但共享树级控制与预算。
2. task path 必须唯一、可相对解析并可由持久化 metadata 恢复。
3. mailbox delivery 与 Turn scheduling 必须显式分离。
4. completion 必须自动回流，但不能擅自唤醒父 Agent。
5. Fork 必须清除执行轨迹和父 Agent 专属协作指令。
6. 并发容量、驻留容量和已创建身份必须分别治理。
7. 驱逐 runtime 前必须先确保持久化，重载必须保持 ThreadId。

## 测试证据与未确认事项

`core/src/tools/handlers/multi_agents_tests.rs`、`multi_agents_v2/*` 模块测试覆盖工具参数、path、spawn/fork、消息和等待；`core/src/agent/control/*_tests.rs` 覆盖 reservation、execution limiter、residency、恢复和父子图；`core/src/session/tests.rs` 覆盖终态回流与 mailbox。本文只阅读这些测试，没有执行。

尚未验证高扇出任务树的公平性、rollout budget 耗尽时的跨 Agent 收束、进程重启后的完整树恢复，以及大量 LRU unload/reload 的延迟与磁盘开销。
