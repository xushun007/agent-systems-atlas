---
title: Cline Runtime Architecture
snapshot_id: 2026-09-20.5ec2d47
reviewed_at: 2026-09-20
upstream_repository: https://github.com/cline/cline
upstream_commit: 5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa
upstream_commit_date: 2026-08-03
previous_snapshot: 2026-09-18.5ec2d47
status: current
change_level: minor
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/cline-runtime-architecture-2026-09-20-5ec2d47.excalidraw
---

# Cline Runtime Architecture

> 结论：Cline 的运行时不是“CLI 调用一个 agent loop”这么简单，而是 `Host → RuntimeHost → SessionRuntime → Turn/Prompt Control → per-run AgentRuntime → Step/Tool/Environment` 的分层系统。Session、队列、事件、审批、checkpoint 和 Hub/Remote 共同构成长期任务的控制平面；AgentRuntime 只负责一次 run 内的模型—工具循环。

可编辑架构图：[cline-runtime-architecture-2026-09-20-5ec2d47.excalidraw](../diagrams/cline-runtime-architecture-2026-09-20-5ec2d47.excalidraw)。本快照补全了上一快照中未充分展开的 `Turn/Step`、能力策略、Environment、恢复和事件投影边界。

## 1. 视图边界与核心判断

本视图覆盖 `@cline/core`、`@cline/agents`、`@cline/llms`、CLI/Connector 和 Hub/Remote 路径；重点是一次用户输入如何进入长期 Session，如何排队并创建一次运行，以及运行结果如何通过工具、环境、事件和持久化重新回到宿主。

三个容易混淆的词必须分开：

- `RuntimeHost.runTurn`：宿主提交的一次用户输入。
- `SessionRuntime`：跨多个用户输入存活的任务运行上下文。
- `AgentRuntime` 的 model/tool iteration：一次 run 内部的执行循环；它不是独立的用户 turn。

因此，Cline 的产品事实是可恢复的 `Session/Task`，而不是某个前台 CLI 进程或某个模型请求。

## 2. 完整控制流

```text
CLI / TUI / IDE / SDK / Connector / Hub client
                    │ input / abort / approval
                    ▼
             ClineCore + RuntimeHost
                    │ create / restore / route
                    ▼
               SessionRuntime
                    │ queue / steer / ask / continue
                    ▼
             Turn / Prompt Control
                    │ create run
                    ▼
       AgentRuntime（每次 run 新建）
                    │ model request
                    ▼
       Step: model → tool call → result
          │ policy / hook / approval
          ▼
 Environment / MCP / workspace / shell
          │ effects and observations
          └──────────→ next model request

 events / usage / approval / error / done ──→ host projections
 messages / checkpoints / compaction ───────→ durable state
```

宿主只负责输入、输出投影和 capability callback；`RuntimeHost` 决定 local、hub、remote 或 auto 路径；`SessionRuntime` 持有跨轮次状态；`AgentRuntime` 负责一次运行；Environment 负责副作用及其观察结果。入口和 Host 工厂见 [`ClineCore.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/ClineCore.ts)、[`host.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/host.ts) 和 [`runtime-host.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/runtime-host.ts)。

## 3. Session、Turn、Step 的状态所有权

| 对象 | Cline 中的落点 | 所有权 | 终态/恢复含义 |
| --- | --- | --- | --- |
| Session/Task | `SessionRuntime`、`ConversationStore` | 跨 run 存活 | 可恢复、重连、继续、fork |
| Turn | `runTurn`、queued prompt、一次 AgentRuntime run | 一次用户输入的工作单元 | 完成、abort、失败或继续排队 |
| Step/iteration | AgentRuntime 内 model/tool 往返 | 当前 run 内的执行粒度 | 追加 tool result，进入下一 iteration |
| Prompt | `PendingPromptService` | Session 的输入投递 | dequeue、steer、删除或失败重入队 |
| Checkpoint | conversation marker + workspace snapshot | Session/Task 的恢复关联点 | 对话与工作区分别或联合恢复 |

`LocalRuntimeHost` 负责 Session 创建/恢复、输入排队和持久化；`SessionRuntime.executeRunInternal()` 为一次 run 创建新的 AgentRuntime，并在结束后将最终消息写回 ConversationStore。证据见 [`local-runtime-host.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/host/local-runtime-host.ts) 和 [`session-runtime-orchestrator.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts)。

输入在运行期间进入队列；显式 `steer` 会在下一次模型请求前改变当前运行的输入边界。审批、问题询问和 abort 是 Turn 内的暂停/控制状态，不会自动创建新 Session。队列的去重、删除、更新和失败重入队由 [`pending-prompt-service.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts) 负责。

## 4. AgentRuntime：一次 run 内的执行状态机

AgentRuntime 在 `maxIterations` 范围内重复以下步骤：

1. 由 provider 发起 `model.stream()`。
2. 累积 assistant 内容和 tool calls。
3. 无 tool call 时产生完成候选；有 tool call 时进入策略、hook 和审批。
4. 执行工具并追加 tool-result message。
5. 继续下一次 model request，直到完成、终止工具、abort、错误或迭代上限。

Context overflow 可触发一次 compaction 后重试；不是任意失败都可以无限重试。核心实现见 [`agent-runtime.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/agents/src/agent-runtime.ts)。这说明 `Step` 是循环内的事实边界，而不是 Cline 对外稳定暴露的持久化对象。

## 5. 能力、策略与 Environment

`DefaultRuntimeBuilder` 装配内置工具、MCP、skills/rules、extensions、teams/subagents 和 hooks；它形成 capability registry。工具是否能在当前 Step 执行，还要经过 mode、auto-approve、tool policy、hook 和人工审批。装配入口见 [`runtime-builder.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/runtime-builder.ts)。

Environment 不能缩减为 cwd。对 Cline 更准确的定义是：workspace 身份、文件可见范围、shell/terminal 上下文、MCP/外部连接、checkpoint provider 和当前信任策略的组合。它是 Step 的 effect boundary：工具在这里产生副作用，结果再作为 observation 返回 AgentRuntime。Hub/Remote 中，部分 capability 通过 request/progress/response callback 由远端宿主提供；见 [`capability-handlers.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/server/handlers/capability-handlers.ts)。

## 6. 事件、审批和终态收敛

内部 `RuntimeEvent` 经 [`runtime-event-adapter.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/runtime/orchestration/runtime-event-adapter.ts) 投影为宿主消费的 `AgentEvent`。事件至少需要表达 text delta、tool progress、usage、approval、question、error 和 done；TUI、NDJSON、Connector 不应各自推断任务是否结束。

审批必须绑定 Session、Turn 和 tool call；消息编辑、Session replacement 或 abort 时，旧 approval 不能继续影响新运行。Connector 的 status delivery 失败属于宿主通知故障，不应被误判为 AgentRuntime 失败。这个区分是多宿主架构的关键：运行事实由 Core 产生，TUI/Connector 只是投影。

## 7. 持久化、checkpoint 与恢复

Core 持有 SQLite Session store，并保留 file service fallback；持久化内容包括 manifest、messages、compaction state 和子代理产物。Checkpoint 同时关联 conversation marker 与 workspace snapshot：恢复时可以只恢复文件、只恢复对话，或使两者共同回到可继续状态。实现见 [`session-service.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/services/session-service.ts)、[`persistence-service.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/services/persistence-service.ts) 和 [`checkpoint-restore.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/session/checkpoint-restore.ts)。

## 8. Hub / Remote 的进程边界

`HubRuntimeHost.runTurn()` 通过 WebSocket 发送 `run.start`；Hub server handler 再调用服务端持有的 `LocalRuntimeHost.runTurn()`。客户端仍可能提供审批、工具执行器、hooks、compaction 等 capability callback，因此“运行循环在哪里”和“交互/环境能力在哪里”可以分离。实现见 [`hub-runtime-host.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/runtime-host/hub-runtime-host.ts) 和 [`run-handlers.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/sdk/packages/core/src/hub/server/handlers/run-handlers.ts)。

这使得前台 CLI 可以退出而 Session 继续，但也引入 attach/detach、事件重连、远程 capability 超时、孤儿 Session 和崩溃恢复问题。当前源码和测试确认了接口边界，尚未通过真实 Hub 运行确认所有异常时序。

## 9. 关键设计原则

- Session/Task 是长期产品事实；Host 只是输入输出适配层。
- AgentRuntime 可重建，SessionRuntime 才跨 Turn 持有状态。
- Prompt queue 把持续输入、steer、审批等待和取消变成显式协议。
- Capability registry 与 policy gate 分离；工具存在不等于当前可执行。
- Environment 是副作用与观察结果的边界，不是单一 cwd。
- Event adapter 统一多宿主观察，持久化与恢复不依赖某个 UI。
- Checkpoint 将会话历史和工作区状态关联起来，但两者不应被误认为同一个日志。

## 10. 已确认与未确认

已确认：Host 工厂、SessionRuntime 跨 run 存活、AgentRuntime 每次 run 重建、Prompt Queue、RuntimeEvent/AgentEvent 适配、RuntimeBuilder、Hub/Remote capability callback、SQLite/file persistence 和 checkpoint restore 的代码边界；相关链接均固定到 `5ec2d47`。

未确认：真实模型和 MCP 运行时的 Step 时序、checkpoint 原子性、Hub 崩溃恢复、不同 provider 的 tools schema 与 KV cache 行为、以及 queue 中每一种输入被判定为 steer 还是下一 Turn 的具体条件。本快照没有运行实验，不把源码阅读结论表述为运行验证。
