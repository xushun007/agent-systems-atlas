---
title: Kimi Code Agent Loop Runtime
snapshot_id: 2026-08-20.e22479a
reviewed_at: 2026-08-20
upstream_repository: https://github.com/MoonshotAI/kimi-code
upstream_version: v0.31.1
upstream_commit: e22479a62eed9c3b78a67b313f4332c2c0ba9670
upstream_commit_date: 2026-08-01
status: historical
change_level: baseline
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/agent-loop-runtime-2026-08-20-e22479a.excalidraw
---

# Kimi Code Agent Loop Runtime

## 结论

Kimi Code 当前存在两代可运行引擎，不能把它们混成一个实现：

- `kimi web` 始终由 `kap-server` 驱动 `agent-core-v2`；CLI/TUI 默认使用 legacy `agent-core`，仅在 `KIMI_CODE_EXPERIMENTAL_FLAG` 为真时切换到 v2。入口判定见 [`experimental-v2.ts`](../../../../kimi-code/apps/kimi-code/src/cli/experimental-v2.ts#L1)。
- v2 的核心不是 ADK 式的 `Runner ↔ AsyncGenerator<Event>` 协作让渡，而是一个 **Turn FIFO + 每 Turn 的 `StepRequestQueue`**。一次 LLM Step 结束后，只有新的 `StepRequest` 被入队，循环才会继续；工具调用后的默认续步由独立的 `AgentLoopContinuationService` 注入。
- v2 把“事实提交”和“实时观察”拆成两个平面：`WireService` 先归约内存 Model，并为持久化 Op 安排 `wire.jsonl` 追加；Agent-scoped `IEventBus` 同步广播 UI/投影事件。流式 delta 只走 EventBus，完整 content/tool/step 事实走 Wire。
- 因此，Kimi Code 与参考 ADK event loop 的共同点是“外层编排器反复驱动 LLM/工具并向上游发事件”；关键差异是 Kimi 的循环继续条件是 **队列中仍有请求**，不是执行逻辑 `yield` 后由 Runner 恢复生成器。

本文以版本 `v0.31.1`（源码 commit `e22479a62eed9c3b78a67b313f4332c2c0ba9670`）为基线，结论来自源码阅读，未执行真实模型或工具的 runtime 实验。分析时上游工作区在 legacy v1 的若干 loop/hook 文件中存在未提交的用户修改；v2 相关文件无工作区修改，因此 v2 结论对应所记录版本提交。

## Runtime 架构图

- 可编辑源文件：[agent-loop-runtime.excalidraw](../diagrams/agent-loop-runtime-2026-08-20-e22479a.excalidraw)
- 视觉参照：[Google ADK Runtime Event Loop](https://adk.dev/runtime/event-loop/)（Runner、Execution Logic、Event/Services 的分区方式）

图中蓝色表示控制流，绿色表示可回放事实，紫色虚线表示实时事件。图的主路径是当前 `kap-server`/v2 runtime；legacy v1 的对应关系见后文。

## 1. 从用户输入到 Turn

`AgentRPCService.prompt()` 不直接调用模型，而是把输入交给 `AgentPromptService.enqueue()`。Prompt Service 维护自己的 active slot 与 FIFO；轮到该 prompt 时，它构造 `PromptStepRequest` 并交给 `IAgentLoopService.enqueue()`：

1. `PromptStepRequest` 使用 `admission: 'newTurn'`，因此一定创建新 Turn；`SteerStepRequest` 是 `mergeable` 且 `turnScoped: false`，可以合并进当前 Step，并跨 Turn 边界存活。[`promptStepRequests.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/prompt/promptStepRequests.ts#L63)
2. `AgentLoopService` 立即保留单调 Turn ID，把请求分配到 Turn 自己的 `StepRequestQueue`，并把 Turn 放进 `pendingTurns` FIFO；同一 Agent 同时只有一个 `activeTurnJob`。[`loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts#L179)
3. Turn 成为队首后，runtime 记录 `turn.prompt` Wire Op、发布 `turn.started`，再进入 `run()`。[`loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts#L439)

这里有两层队列，职责不同：Prompt FIFO 提供用户请求生命周期与 completion handle；Turn FIFO/Step queue 提供 Agent 执行互斥、steer 合并、retry 插队和续步调度。

## 2. StepRequestQueue 才是循环的“心跳”

`AgentLoopService.run()` 的 `while (true)` 每轮只消费一个 batch。`StepRequestQueue.takeNextBatch()` 选择第一个非 mergeable 请求作为 driver，并把所有 mergeable 请求折叠进同一 Step；其余非 mergeable 请求留给后续 Step。[`stepRequestQueue.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/stepRequestQueue.ts#L38)

每轮依次执行：

1. 检查 Turn abort 与 `maxStepsPerTurn`。
2. 取一个 request batch，在真正执行前才调用 `resolveContextMessages()`，把消息物化进 Context。未物化就取消的请求不会污染历史。
3. 运行 `onWillBeginStep` hooks。Full Compaction 在这个边界检查上下文；错误恢复 handler 也可以把 retry request 插到队首。
4. 记录 `step.begin`，由 `AgentLLMRequesterService` 从 profile、Context projection、tool registry 和 model catalog 构造一次模型请求。
5. 流式 `text`/`think`/tool-call fragments 立即发布到 EventBus；完整响应到达后，content parts 才写入 Context/Wire。
6. 若响应包含工具调用，交给 `AgentToolExecutorService`；每个 `tool.call` 和 `tool.result` 都回写 Context/Wire。
7. 记录 `step.end`，执行 `onDidFinishStep` hooks。
8. 回到队头。队列为空则 Turn completed；不是依据“模型已经回答文本”直接退出。

主循环见 [`loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts#L608)，单 Step 的固定顺序见 [`loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts#L800)。

### 工具如何触发下一轮 LLM

`AgentLoopService` 本身遵守“只消费、不生产请求”的边界。工具 Step 完成且最终 `finishReason === 'tool_calls'` 时，eager Agent-scoped 的 `AgentLoopContinuationService` 在 `onDidFinishStep` 中入队一个不贡献消息的 `ContinuationStepRequest`。下一轮 LLM 从已包含 tool results 的 Context 读取反馈。[`loopContinuationService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopContinuationService.ts#L23)

这个拆分让所有“为什么还要再跑一步”都由外围 aspect 表达：

| 续步来源 | 入队内容 | 目的 |
| --- | --- | --- |
| 工具正常完成 | 空 `ContinuationStepRequest` | 让模型消费工具结果 |
| steer / task notification | mergeable message request | 将实时输入并入最近可执行 Step |
| external Stop hook | continuation request | 给外部 hook 一次阻断正常停止的机会 |
| Full Compaction recovery | retry request，通常插队 | 压缩后重试失败 Step |
| goal driver | continuation/message request | 在 Turn/Step 边界继续自治目标 |

## 3. LLM 与工具执行边界

### LLMRequester

`AgentLLMRequesterService` 在 Turn 边界冻结 model、thinking effort 与 system prompt；每个 Step 重新读取 Context/Tools，并经 projector 生成 provider wire messages。它还在单次请求链内处理 strict、media-degraded、media-stripped 等投影降级，因此这些是“同一 Step 的请求恢复”，不是新的 Agent Step。[`llmRequesterService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts#L216)

模型 provider 以 AsyncIterable 产生 `part`、`usage`、`finish`、`timing`。part 先进入 EventBus 形成低延迟 UI；只有最终 message/usage 完整后，Loop 才追加 durable content、执行工具并封闭 `step.end`。[`llmRequesterService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts#L326)

### ToolExecutor

工具批处理遵循以下边界：

1. provider 顺序执行 preflight：查表、解析与校验参数；
2. `resolveExecution()` 产出访问集合、审批规则和 executable；
3. veto/permission hooks 可阻断或返回 synthetic result；
4. `ToolScheduler` 根据 `ToolAccesses` 决定可并发任务；
5. 执行期间 `tool.progress` 只走 EventBus；
6. `onDidExecuteTool` 完成结果预算、交付和后置处理；
7. Loop 把 final result 写成 Context/Wire 的 `tool.result`。

实现入口见 [`toolExecutorService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts#L180)。取消后，忽略 AbortSignal 的工具只获得有限 grace period，避免 Turn 永久悬挂。

## 4. 两条事件平面

| 平面 | 代表内容 | 顺序与语义 | 消费者 |
| --- | --- | --- | --- |
| Wire / replayable facts | `turn.prompt`、context message、`step.begin/end`、完整 content、`tool.call/result` | `dispatch()` 同步归约 Model，随后安排/执行 journal append；可 restore/replay | Context、Transcript cold rebuild、session resume |
| Agent EventBus / live facts | `turn.started/ended`、delta、tool progress、status、Wire Op 映射事件 | 同进程同步 publish；不等价于磁盘 fsync | kap-server broadcaster、Transcript live projector、SDK/TUI/Web UI |

`WireService.execute()` 的实际顺序是：归约内存 Model → 为可持久化 Op 调用 journal append → 生成并发布 Domain Event → 执行 cross reducers。[`wireService.ts`](../../../../kimi-code/packages/agent-core-v2/src/wire/wireService.ts#L244) 这比 ADK 的“Runner 收到 Event 后再提交 actions”更紧耦合：Kimi 的业务服务直接 dispatch Op，Event 是提交后的投影；但 blob dehydration 等路径的物理持久化可以排队，因此不能把 EventBus 到达解释为已经 fsync。

在 server runtime 中，每个 Agent 的 EventBus 同时被两类边缘消费者订阅：

- `coreBinding` 把 Domain Event 投影成 `@moonshot-ai/transcript` ops，供 transcript REST/WS 增量视图使用。[`coreBinding.ts`](../../../../kimi-code/packages/kap-server/src/services/transcript/coreBinding.ts#L156)
- `SessionEventBroadcaster` 把兼容事件封装为带序号的 `/api/v1/ws` session events，并按订阅过滤；transcript frames 是独立通道。[`sessionEventBroadcaster.ts`](../../../../kimi-code/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts#L988)

## 5. 停止、取消与恢复

| 条件 | 结果 |
| --- | --- |
| Step 后 queue 为空 | 正常完成 Turn；`truncated` 作为结果标记保留 |
| 工具返回且未 `stopTurn` | continuation aspect 入队，继续下一 Step |
| 工具或 hook 设置 `stopTurn` | Step 封闭后结束 Turn，已入队的 turn-scoped continuation 被清理 |
| provider filtered | 转成 `PROVIDER_FILTERED`，Turn failed |
| 达到 max steps | `MaxStepsExceededError`，发布 interrupted，Turn failed |
| Turn AbortSignal 触发 | 当前 Step/工具收到组合 signal，Turn cancelled；queued Turn 可独立取消 |
| error handler 匹配并接管 | handler 自己入队 recovery request，loop 继续 |
| error 未被接管 | Turn failed |

Turn 的 finally 顺序是先释放 active Turn，再 dispatch `turn.end` Wire Op、发布 `turn.ended`，最后 pump 下一个 queued Turn。[`loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts#L463) 这保证监听者看到 `turn.ended` 时，该 Agent 已不再占用旧 Turn 的 active slot。

## 6. 与参考 ADK event loop 的对应关系

| ADK 概念 | Kimi Code v2 对应 | 关键差异 |
| --- | --- | --- |
| Runner | `AgentLoopService` + `AgentPromptService` | Runner 职责被拆成 prompt 生命周期与 Turn/Step 调度 |
| Invocation | `TurnJob` / `Turn` | 一个 Agent 串行执行 Turn，另有 pending Turn FIFO |
| Execution Logic | `AgentLLMRequesterService`、`AgentToolExecutorService`、ordered hooks | 逻辑不是向 Runner yield 一个统一 Event 对象 |
| Event | Wire Op + Domain Event 两类 | durable fact 与 live observation 明确分轨 |
| Session state/history | Agent-scoped Wire Models + `ContextMemory` | 状态按 Agent aggregate 持久化，Session/Agent 都有 DI scope |
| Resume after yield | 新 `StepRequest` 入队并物化 | 没有暂停中的 Agent generator；下一 Step 是新的队列迭代 |

可以把 v2 的最小循环压缩为：

`StepRequest → materialize Context → LLM stream/final → tools → Wire facts → onDidFinishStep → [enqueue continuation?] → next request or Turn end`

## 7. Legacy v1 的位置

Legacy `packages/agent-core` 使用更直接的 `TurnFlow → runTurn → executeLoopStep`：`runTurn` 根据 `stepResult.stopReason === 'tool_use'` 原地 `continue`，而不是依靠 continuation request 入队。[`run-turn.ts`](../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts#L89)

两代实现共享的重要语义包括：

- Step 由 LLM request、stream callbacks、tool batch、`step.end` 构成；
- Context 是下一 Step 的反馈载体；
- 完整 loop events 可回放，delta/progress 属于 live-only；
- compaction 在 Step 边界介入；
- AbortSignal、max steps、tool approval 和结果预算是循环外围约束。

但 v2 把续步、错误恢复、steer 与 goal 统一成 `StepRequest` 调度协议，使“继续运行的原因”成为可组合的队列输入。这是 v2 runtime 相比 v1 最重要的结构变化。

## 未确认事项

- 本次未连接真实 provider，未测量一个含并行工具、审批等待、steer 与 compaction 的完整 Turn 时序。
- 未验证进程在 blob dehydration/persist queue 尚未 flush 时崩溃的恢复窗口；源码只证明内存 Model 与事件发布顺序，不证明每个 live event 到达前均已落盘。
- v2 在 CLI/TUI 仍由总实验开关控制，后续若默认切换，需要重新核对入口范围；`kimi web` 的 v2 结论不受该开关影响。

## 主要源码索引

- [`agent/loop/loopService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts)
- [`agent/loop/stepRequestQueue.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/stepRequestQueue.ts)
- [`agent/loop/loopContinuationService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/loop/loopContinuationService.ts)
- [`agent/prompt/promptService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/prompt/promptService.ts)
- [`agent/llmRequester/llmRequesterService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts)
- [`agent/toolExecutor/toolExecutorService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts)
- [`agent/contextMemory/contextMemoryService.ts`](../../../../kimi-code/packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts)
- [`wire/wireService.ts`](../../../../kimi-code/packages/agent-core-v2/src/wire/wireService.ts)
- [`kap-server transcript coreBinding.ts`](../../../../kimi-code/packages/kap-server/src/services/transcript/coreBinding.ts)
- [`kap-server sessionEventBroadcaster.ts`](../../../../kimi-code/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts)
