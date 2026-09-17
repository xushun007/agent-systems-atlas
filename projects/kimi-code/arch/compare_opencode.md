# 架构对比：Kimi Code 与 OpenCode

> Kimi Code 分析版本：`v0.31.1`；精确源码提交：`e22479a62eed9c3b78a67b313f4332c2c0ba9670`。本文是历史机制对比，当前 v0.40.0 的 Kimi Code Runtime/Harness 见 [`research/kimi-code-harness-evolution.md`](../research/kimi-code-harness-evolution.md)。

本文档对 Kimi Code 与 [OpenCode](../../../../opencode) 的智能体执行循环 (Agent Loop / ReAct Loop) 进行深入对比。

---

## 1. 语言与技术栈背景

| 特性 | Kimi Code | OpenCode |
| :--- | :--- | :--- |
| **开发语言** | TypeScript | TypeScript |
| **依赖运行时** | Node.js | Bun + Drizzle + SolidJS Start |
| **基础大模型库** | 自建适配层 [packages/kosong](../../../../kimi-code/packages/kosong) | Vercel AI SDK (`ai` 库) |
| **主要定位** | CLI/TUI 与 Web 协同的多态开发 Agent | 专注云端、LSP/Web 与本地环境结合的 AI 编码应用 |

---

## 2. ReAct Loop 驱动与控制对比

根据对 OpenCode [react_loop_analysis.md](../../../../opencode/react_loop_analysis.md) 的分析，两者的执行循环策略有着不同的设计倾向。

### 2.1 大模型调用的步长控制 (Model Steps)
* **OpenCode**：
  - 手动实现了 ReAct 循环。
  - 在 `session/prompt.ts` 中通过 `while (true)` 不断拉起大模型的 `streamText`，并将生成的步数显式强制设为 `1` (`stopWhen: stepCountIs(1)`)。
  - 这样做是为了在大模型每完成一次推理 (Reason) 后，能够手动提取并由 Processor 执行工具调用，然后观察 (Observe) 工具结果，再决定是否进行下一轮 API 循环。
* **Kimi Code**：
  - 也采用了手动的 Turn-Step 控制机制 ([run-turn.ts](../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts))。
  - Kimi Code 在底层适配层 [packages/kosong](../../../../kimi-code/packages/kosong) 中只要求 LLM 进行标准的单次 Completion 生成，在 Turn Loop 这一层由 `executeLoopStep` 迭代拉起 LLM 和工具批处理，整体策略与 OpenCode 异曲同工，均避开了主流大模型框架（如 LangChain 或 Vercel AI SDK 的自动多步模式 `maxSteps: 10`）造成的步骤黑盒化问题。

### 2.2 为何两者都选择“手动 ReAct 循环”？
无论是 Kimi Code 还是 OpenCode，都放弃了封装好的大模型 SDK 的自动多步工具执行能力（如 AI SDK 的自动多步执行），因为手动 ReAct 循环对于生产级 AI 编码助手至关重要：

| 细分诉求 | OpenCode 的实践 | Kimi Code 的实践 |
| :--- | :--- | :--- |
| **动态提示词与提醒** | 每一步都在 `getMessages` 之后，通过 `insertReminders` 动态向大模型插入实时的上下文提醒（例如切换 Agent 的提示）。 | 每次 Step 执行前触发 `beforeStep` 钩子，并在构建消息历史时调用 `refreshSystemPrompt` 刷新 `AGENTS.md` 和运行时技能上下文。 |
| **中间状态可观测与流式推送** | 依靠事件总线 `Bus.publish` 向客户端流式发送 `PartUpdated`。 | 在 [turn-step.ts](../../../../kimi-code/packages/agent-core/src/loop/turn-step.ts#L318) 中通过 `dispatchEvent` 精细推送 `step.begin`、`text.delta`、`tool.call.delta`、`step.end` 等。 |
| **指令队列处理** | 在循环底部检查 `queued` 中是否有新的积压未处理消息，有则强行 `continue` 开启下一轮。 | 在 TUI 或后台任务管理器中统一调度排队任务，支持 steer 指令的动态缓冲与处理。 |

---

## 3. 并发安全与锁机制 (Locks)

* **OpenCode**：
  - 基于会话级别的锁方案（`lock(sessionID)`）。
  - 当一个会话正在推理时，使用 JS 作用域的 `using abort = lock(sessionID)` 锁定当前会话，防止多路并发推理导致的乱序或大模型状态竞争。当离开 scope 时自动释放锁并派发 `Event.Idle` 事件。
* **Kimi Code**：
  - 同样拥有完善的并发防冲突机制。Kimi Code 更进一步，不仅在会话级别对 Agent Active Turn 进行生命周期等待（[Session.cancelActiveTurnsOnClose](../../../../kimi-code/packages/agent-core/src/session/index.ts#L371)），还在**工具执行级别**使用了基于路径锁机制的 [ToolScheduler](../../../../kimi-code/packages/agent-core/src/loop/tool-scheduler.ts)，对多个并发工具所访问的磁盘物理路径做了互斥判断，安全保障粒度更细。

---

## 4. 工具定义与权限过滤方式

* **OpenCode**：
  - 工具由 `Agent.Info` 直接配置声明，权限细分为全局规则（如 `edit: "allow"`, `bash: { "*": "ask" }`）。
  - 工具与权限的状态合并存放在 `Config` 和 `state()` 中，调用模型时通过参数直接传入。
* **Kimi Code**：
  - 通过 [IToolService](../../../../kimi-code/packages/agent-core/src/services/tool/tool.ts) 和 `ToolManager` 服务集中管控工具的初始化、动态注册、以及卸载。
  - 权限控制由 [PermissionManager](../../../../kimi-code/packages/agent-core/src/agent/permission/index.ts) 进行，支持基于策略模式的多级规则校验（MatchesRule），将业务权限（例如允许或交互确认）做到了引擎级的系统服务中。

---

## 5. 总结

1. **框架依赖性**：OpenCode 高度依赖 Vercel AI SDK 生态（如 `ai` 库中的生成函数），因而其消息结构和转换模式受限于该库的规定；而 Kimi Code 采用了从底层 `kosong` 网关到 `agent-core` 的全套自研链路，更加适合针对冷门厂商模型做定制化协议修复（如 Strict Resend 自动降级自愈）。
2. **高并发与可观测**：两者均认识到，一个成熟的开发辅助 Agent 绝不能完全依赖第三方库的黑盒 Step 运行，必须在步骤之间插入精细的“审计、事件流发布、动态上下文插入及并发控制”逻辑。Kimi Code 通过服务化架构 (DI) 为这些逻辑提供了更加清晰的模块划分。
