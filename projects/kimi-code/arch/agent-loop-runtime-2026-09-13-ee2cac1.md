---
title: Kimi Code Agent Loop Runtime
snapshot_id: 2026-09-13.ee2cac1
reviewed_at: 2026-09-13
upstream_repository: https://github.com/MoonshotAI/kimi-code
upstream_version: v0.42.0+ (unreleased mainline)
upstream_commit: ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd
upstream_commit_date: 2026-09-12
previous_snapshot: 2026-08-20.e22479a
status: current
change_level: major
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/agent-loop-runtime-2026-09-13-ee2cac1.excalidraw
---

# Kimi Code Agent Loop Runtime（v0.42.0+ 未发布主线）

> 结论：当前 Kimi Code Agent Loop 是一个 **门面包裹的两级状态机 Runtime**。`AgentPromptService` 管输入生命周期，`AgentLoopService` 管对外 admission/steer/notify 与执行投影，`MachineEngine` 驱动 Agent Machine；每个活动 Turn 又由嵌套 Turn Machine 在 `thinking → acting → draining` 间推进。旧版 `StepRequestQueue` 和 `AgentLoopContinuationService` 已不再是循环心跳。

- 可编辑架构图：[agent-loop-runtime-2026-09-13-ee2cac1.excalidraw](../diagrams/agent-loop-runtime-2026-09-13-ee2cac1.excalidraw)
- 整体边界：[Kimi Code 整体架构](system-architecture-2026-09-13-ee2cac1.md)
- 版本变化：[Runtime 演进索引](agent-loop-runtime-history.md)

## 视图边界

本视图只解释一个 Agent 如何接收输入、串行运行 Turn、调用模型和工具、写入状态并发布观察事件。Session/Workspace 生命周期、具体工具实现、协议字段、Tower/Swarm 协作另属独立视图。

## 与上一快照相比

### 删除

- `stepRequestQueue.ts`、`loopContinuationService.ts` 与 `promptStepRequests.ts` 不再存在。
- 循环不再依赖外围 aspect 在工具 Step 后插入 `ContinuationStepRequest`。
- legacy v1 runtime 已从仓库移除，当前图不再保留两代引擎对照路径。

### 职责迁移

- `AgentLoopService` 从 Turn/Step 循环实现者变为门面：保留 reservations、nudges、active job、hook/telemetry 适配，并把 `submit`、`steer`、`notify` 转成 machine commands。[`loopService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/loopService.ts#L101-L258)
- 输入队列、通知、提醒、活动 Turn 和后台工具的所有权进入 Agent Machine。[`machine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/machine.ts#L325-L456)
- LLM stream accumulator、attempt/retry/recovery、工具结果收集和后续 Step 转移进入嵌套 Turn Machine。[`turn.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/turn.ts#L347-L425)

### 保持不变

- 同一 Agent 仍至多运行一个前台 Turn，后续输入 FIFO 等待。
- 模型工具调用仍形成 `LLM → tools → tool results → LLM` 的多 Step 循环。
- 流式 delta/progress 用于实时观察，完成消息/Turn 状态进入可恢复事实。
- Abort、max steps、permission、compaction 和错误恢复仍约束循环，只是接入位置变化。

## 1. 三层 Runtime 职责

### `AgentPromptService`：输入生命周期

Prompt Service 负责 prompt 的 pending/active/completion 状态以及外部 RPC 语义。它不是 Agent 执行器；当输入获得执行资格后，调用 loop facade 的 `submit()`，steer/notify 则进入对应命令路径。[`promptService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/prompt/promptService.ts)

### `AgentLoopService`：稳定门面

门面对上维持 `IAgentLoopService` 的 submit/steer/notify/cancel/status/hooks API，对下延迟创建 `MachineEngine`。它还把 machine events 投影回既有 Wire、Context、telemetry 和 SDK 语义，使状态机重构不必泄漏到所有调用方。[`loop.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/loop.ts#L101-L166) [`engine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/machine/engine.ts#L159-L173)

### `MachineEngine`：状态机宿主

`MachineEngine` 组合 requester、tool executor、machine tools、Agent Machine、Turn Machine 与 event store，负责发送输入、观察状态和把底层 machine events 转成 Runtime events。它是状态机实现与旧服务接口之间的适配边界，而不是新的全局 manager。[`engine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/machine/engine.ts#L240-L312)

## 2. Agent Machine：Agent 级调度与所有权

Agent Machine 的关键状态是 `restoring → idle ↔ running`：

1. 启动时由 store actor fold MachineEngine 的内存 journal，建立 messages、queue、turn index 等镜像；收到 `store.ready` 后进入 `idle`。当前 facade 只从 Agent Scope durable state 注入初始 Turn ID，并不是把完整 Wire 历史恢复进这份 machine-local store。
2. `input.submit` 追加 FIFO queue 并写 `inputSubmitted` 事件；`input.notify` 与 `input.remind` 分别进入通知/提醒集合。
3. `idle` 检测到 pending work 后原子 drain 输入与通知，进入 `running` 并启动唯一的 Turn actor。
4. Turn 请求工具时，Agent Machine 启动 tool actors；detached 工具从 `turnTools` 转入 `background`，不再阻塞当前 Turn。
5. Turn 完成后写入 produced messages 与 `turnEnded`，清理前台工具并回到 `idle`，再决定是否消费下一项。

这些转移可在 [`machine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/machine.ts#L325-L573) 中直接核对。它把“只有一个活动 Turn”“输入如何 steer”“后台工具何时脱离 Turn”从分散约定变成显式状态。

## 3. Turn Machine：LLM/工具循环

Turn Machine 的主状态构成当前循环：

1. **`thinking`**：创建本次 request scope 与 stream accumulator，调用 LLM request actor；headers、parts、usage、finish 被累计并向父级转发。
2. **有工具调用**：完整 assistant message 被加入 `produced`，tool calls 进入 `pendingToolCalls`，状态转为 `acting`。
3. **`acting`**：通知 Agent Machine 生成 tool actors，收集 done/failed/aborted/detached outcomes。
4. **`draining`**：工具全部得到结果后请求父级 drain notifications/reminders；若未超过 max steps，带着 produced history 回到 `thinking`。
5. **无工具调用**：完成的 assistant message直接进入 `done`。错误进入 retry/recovery 或 `failed`；Abort 进入 `aborted`。

因此当前循环可以压缩为：

`thinking(LLM) → [tool calls?] → acting(tools) → draining(inputs) → thinking | done`

工具结束后继续模型调用是 Turn Machine 的内生状态转移，不再需要独立 continuation service。[`turn.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/turn.ts#L427-L573) [`turn.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/turn.ts#L681-L826)

## 4. Retry、recovery 与取消

LLM requester 可在低层协议/传输重试时发出 `llm.request.retrying`；Turn 会回滚本 attempt 的 accumulator，避免把失败 attempt 的流式片段混入后续结果。远程错误先进入 recovery proposal，无法恢复时再按 retry policy 延迟重试，最终才失败。[`turn.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/turn.ts#L468-L657)

取消分两级传播：Agent Machine 进入 `aborting` 并通知 Turn/tool actors；Turn 在 thinking 时终止 LLM scope并尝试 salvage partial message，在 acting 时等待工具 grace period，超时后收敛为 aborted。这个设计把“发出取消”和“所有子 actor 已停止”区分开。

## 5. Tool Runtime

图中把工具执行展开为三个稳定阶段：

- **resolve / policy**：查找工具、校验参数、解析访问与 permission/hook 决策；
- **schedule / execute**：按访问集合调度文件、Shell/Git、Web、MCP、交互或 feature tools；
- **result / detach**：将成功、失败、取消结果发回 Turn；允许异步工具 detached 后由 Agent Machine 作为 background work 持有。

Agent Machine 为每个 tool call 创建独立 abort scope，Turn Machine 只关心结果集合是否闭合。这让并行工具与后台任务不会把 Turn 控制逻辑重新拉回工具实现内部。[`machine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/agent/machine.ts#L277-L320) [`machineTools.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/loop/machineTools.test.ts)

## 6. 状态、持久化与观察

状态机内部 event store 以 journal + slices 表示本次 MachineEngine 生命周期内的 Agent 状态：dispatch 时顺序 fold、append、notify；Agent Machine 通过 store actor 写 input、message、turn 等事件。当前 `createMachineEngine()` 明确使用 `memoryJournal()`，只从 durable state 取得 `initialTurnId` 种子，因此它不是跨进程恢复边界。[`engine.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/agent/loop/machine/engine.ts#L285-L312) [`eventStore.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/human/eventStore/eventStore.ts#L112-L175)

门面再把 machine events 映射到现有 ContextMemory、Wire 和 EventService：

- completed messages、tool calls/results、Turn 边界等成为可回放事实；
- streaming parts、tool progress、状态更新等面向即时观察；
- `kap-server`/SDK 在边缘把这些事件投影成 Transcript、entity 或兼容协议。

这里要区分两个层次：MachineEngine 使用内存 event store 驱动自己的当前状态；Agent Scope 的 `EventDispatcher`、Wire/Context/Event services 维持系统其余部分依赖的持久化、恢复与观察契约。当前 commit 仍处于两套表示逐步收敛的阶段，不能把它们画成同一个类。[`eventDispatcherService.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/src/state/eventDispatcherService.ts#L155-L221)

## 7. 终止与继续条件

| 条件 | 状态机结果 |
| --- | --- |
| LLM 返回普通最终消息 | Turn `done`，Agent 回到 `idle` |
| LLM 返回工具调用 | `thinking → acting`，工具闭合后 `draining → thinking` |
| drain 时有 notify/reminder | 注入 produced history 后继续 `thinking` |
| 达到 max steps | Turn `failed` |
| recovery proposal 可用 | 重置 attempt，重新进入 `thinking` |
| retry policy 允许 | `retrying` 延迟后回到 `thinking` |
| abort | 停止 LLM/工具，salvage/collect 后 `aborted` |
| Agent queue 仍有输入 | 当前 Turn 结束后从 `idle` 启动下一 Turn |

## 设计解读

- **门面隔离重构**：对外接口保持 service 语义，内部行为改为状态机，调用方不必理解 actor 生命周期。
- **Agent 与 Turn 分层**：跨 Turn 的 queue/notification/background tool 属于 Agent；attempt、stream、tool batch 和 Step 迭代属于 Turn。
- **继续原因变成状态，而非请求类型**：工具续步、retry 和 recovery 都在状态图中有明确位置，减少外围 aspects 对调度顺序的隐式耦合。
- **门面连接易变内核与持久契约**：machine-local journal 让状态转移清晰；facade 将其结果写回 durable Wire/state，并保持宿主事件兼容性。

以上是基于实现的架构解释。

## 验证依据

- 源码阅读：`AgentPromptService`、`AgentLoopService`、`MachineEngine`、Agent Machine、Turn Machine、event store、ContextMemory、Wire 与工具适配。
- 测试阅读：[`loop.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/loop/loop.test.ts) 中的文本 Turn、工具/审批、FIFO、取消与恢复用例；[`machineTools.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/loop/machineTools.test.ts)；[`agentState.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd/packages/agent-core-v2/test/agent/state/agentState.test.ts)。
- 运行实验：未执行。

## 未确认事项

- 未连接真实 provider，未验证低层 requester retry、Turn recovery、并行工具、steer 和 notification 同时发生时的完整时序。
- 未模拟 journal append、index rebuild 或进程崩溃，持久化窗口只按实现和测试描述。
- Machine state 与兼容 Wire/Context 表示未来是否进一步合并，源码没有稳定承诺。
