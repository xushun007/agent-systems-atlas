# Kimi Code Agent Loop Runtime 演进索引

> 结论：Kimi Code 的稳定语义仍是串行 Turn、LLM/工具迭代、可恢复事实与实时事件分轨，但实现中心已从请求队列与 continuation aspects 迁移到 Agent/Turn 两级状态机。

## 版本

| Review date | Snapshot | Upstream commit | Change level | 主要变化 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-13 | `2026-09-13.ee2cac1` | `ee2cac102b835fcd7adb3d4b9bc3d62b0b71cdfd` | major | `AgentLoopService` 变为门面；Agent/Turn 状态机接管队列、续步、重试和工具调度 | [文档](agent-loop-runtime-2026-09-13-ee2cac1.md) | [Excalidraw](../diagrams/agent-loop-runtime-2026-09-13-ee2cac1.excalidraw) |
| 2026-08-20 | `2026-08-20.e22479a` | `e22479a62eed9c3b78a67b313f4332c2c0ba9670` | baseline | Turn FIFO、每 Turn `StepRequestQueue` 与 continuation aspects | [文档](agent-loop-runtime-2026-08-20-e22479a.md) | [Excalidraw](../diagrams/agent-loop-runtime-2026-08-20-e22479a.excalidraw) |

## 2026-09-13 · `ee2cac1`

### 变化

- `AgentLoopService` 不再直接实现循环；它维护 admission reservations、nudges、生命周期投影和 hooks，并把命令交给 `MachineEngine`。
- Agent Machine 拥有输入队列、通知、提醒、活动 Turn、前台/后台工具和事件存储镜像。
- 嵌套 Turn Machine 拥有 LLM stream accumulator、retry/recovery、工具结果收集和 `thinking → acting → draining` 循环。
- 工具完成后由 Turn 状态从 `acting` 进入 `draining`，再回到 `thinking`；旧的 `ContinuationStepRequest` 不再是续步机制。
- Agent Machine 以 machine-local event store 驱动内部状态；loop facade 从 Agent Scope 的 durable state 注入初始 Turn ID，并把 machine events 投影回 Context/Wire/EventService。跨进程恢复仍以 Wire/EventDispatcher 为边界。

### 保持不变

- 同一 Agent 的前台 Turn 串行执行，排队输入不会与活动 Turn 重叠。
- 一个逻辑 Step 仍由 LLM 请求、流式响应、可选工具批次和下一次模型调用组成。
- 工具结果通过消息历史反馈给下一步；最大步数、取消、审批、恢复与压缩仍是循环边界能力。
- durable facts 与 live streaming/progress 仍服务不同一致性需求。

### 验证范围

- 阅读 `AgentLoopService`、`MachineEngine`、Agent/Turn machine、event store、context memory 和相关 loop/state 测试。
- 未连接真实模型，也未进行包含并行工具、steer、后台任务和崩溃恢复的端到端实验。

## 2026-08-20 · `e22479a`

### 基线

- 将 v2 建模为 Turn FIFO 与每 Turn `StepRequestQueue`。
- continuation、错误恢复、steer 和 goal 通过可组合请求推进下一步。

### 验证范围

- 基于源码与测试阅读，未执行真实 provider/tool runtime 实验。
