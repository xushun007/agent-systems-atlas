# 架构对比：Kimi Code 与 Hermes Agent

> Kimi Code 分析版本：`v0.31.1`；精确源码提交：`e22479a62eed9c3b78a67b313f4332c2c0ba9670`。本文是历史机制对比，未将 v0.40.0 的 v2 默认运行时倒灌到旧结论。

本文档对 Kimi Code 与 [Hermes Agent](../../../../hermes-agent) 的智能体执行循环 (Agent Loop) 进行深入对比。

---

## 1. 语言与模块形态对比

| 特性 | Kimi Code | Hermes Agent |
| :--- | :--- | :--- |
| **主语言** | TypeScript | Python (3.11+) |
| **循环结构设计** | **松耦合・模块化**<br>通过 DI 注入服务，将 Turn 循环控制 ([run-turn.ts](../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts))、单步执行 ([turn-step.ts](../../../../kimi-code/packages/agent-core/src/loop/turn-step.ts))、工具生命周期 ([tool-call.ts](../../../../kimi-code/packages/agent-core/src/loop/tool-call.ts)) 拆分为不同类与纯函数。 | **紧耦合・单体化**<br>核心循环在 [conversation_loop.py](../../../../hermes-agent/agent/conversation_loop.py) 的单个 `run_conversation` 宏函数（近 4400 行）中集中实现，状态高度绑定在 `AIAgent` 实例属性上。 |
| **主要定位** | 专注本地与远程开发协作 (Dev Agent) | 包含开发、智能家居、生产力、多媒体在内的综合通用 Agent |

---

## 2. 核心循环控制与数据流

### 2.1 会话干预（/steer）注入机制
* **Hermes Agent**：在 API 请求前置阶段，通过扫描会话历史消息，从尾部开始找到第一个 `role: "tool"` 的消息，并在其 `content` 字符串末尾拼入 steer 指令文本。这种设计会在大模型下一次生成前强制修改之前的环境工具输出，从而影响下文。
* **Kimi Code**：采用单独的队列与动态消息生成器模式。每次单步循环（Step）开始前，通过 [RunTurnInput](../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts#L33) 的 `buildMessages` 闭包回调实时构建上下文，在构建阶段根据状态机动态拼装 steer 信息，对消息历史本身无污染。

### 2.2 消息时序自愈 (Alternation & Empty Prefills)
大模型提供商（特别是 Claude 系列）对消息结构（Role Alternation）校验极其严苛，不合规的消息历史会直接导致接口报错。
* **Hermes Agent**：在请求发送前，通过同步执行 `repair_message_sequence_with_cursor` 对消息流中可能出现的多个连续 `user` 消息或孤立 `tool` 结果进行前置规整，并剥离无法被某些兼容网关支持的 assistant "thinking-only" 消息。
* **Kimi Code**：提供自下而上的自愈机制 —— **Strict Resend** 方案。当发生请求异常时，捕获异常并调用严格重构器 `buildMessagesStrict`，在不修改原会话持久化 ledger 的前提下生成临时规整化的消息结构并重试，容错性高。

---

## 3. 工具执行与并发调度比较

### 3.1 锁定并发调度 (Locks vs. Threads)
* **Hermes Agent**：通常是单线程串行执行工具（其核心工具链为 Python 的 subprocess 物理执行），或者使用简单的线程并发，缺乏工具间的文件/目录级别的资源冲突冲突校验。
* **Kimi Code**：拥有先进的 [ToolScheduler](../../../../kimi-code/packages/agent-core/src/loop/tool-scheduler.ts) 资源锁并发模型。根据工具在 [resolveExecution](../../../../kimi-code/packages/agent-core/src/loop/tool-call.ts#L277) 中返回的 `ToolAccesses` 读写路径描述：
  - 如果多个工具读写不同的目录/文件路径，会**自动并发**执行。
  - 如果路径冲突，则**串行排队**。

### 3.2 优雅终止保护 (Grace Timeout)
* **Hermes Agent**：当发生中断（Interrupt）时，通过信号与本地状态直接强杀（Kill）对应的物理子进程。
* **Kimi Code**：在 [tool-call.ts](../../../../kimi-code/packages/agent-core/src/loop/tool-call.ts#L569) 中使用 `raceExecuteWithGraceTimeout`。当 Turn 被 Abort 信号撤销时，系统先向下游工具传递终止信号，并给予工具 2000ms 的强杀缓冲时间以供其完成临时状态持久化或文件流闭合，若超时仍未退出再强杀，避免了对工作目录文件状态的物理损坏。

---

## 4. 上下文压缩与 Token 控制

* **Hermes Agent**：
  - 在 `conversation_loop.py` 中直接集成 `context_compressor` 来计算 Token 开销。
  - 拥有精细的 Nous 账号资费和 API 调用费用（`usage_pricing`）的拦截与上报。
* **Kimi Code**：
  - 上下文压缩与核心循环完全解耦。
  - 核心循环通过 `recordStepUsage` 和 `shouldContinueAfterStop` 钩子，让 `Agent` 本身的 [FullCompaction](../../../../kimi-code/packages/agent-core/src/agent/compaction/full.ts) 服务去触发上下文压缩（例如缩减历史 `user` 消息、折叠旧工具结果等）。这种基于事件和 Hooks 的做法更为符合关注点分离原则。

---

## 5. 总结

1. **架构美感**：Kimi Code 使用了企业级的设计模式（如依赖注入与 Disposables 生命周期），在代码的清晰度、独立可测性以及可维护性上明显优于 Hermes Agent 的 4000 行 Python 单体函数。
2. **工具调度安全**：Kimi Code 的文件冲突检测并发机制与 2000ms Grace Timeout 设计更贴合对用户真实工作区进行修改时的“安全第一”开发理念。
3. **扩展性**：Kimi Code 完备的 Step 前后 Hooks（`beforeStep`、`afterStep` 等）让业务可以无缝在循环外部挂载监控、审计与拦截插件。
