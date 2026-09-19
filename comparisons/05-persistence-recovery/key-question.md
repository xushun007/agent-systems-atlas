# Persistence / Recovery 的关键问题

本专题不问“Agent 有没有保存历史”，而问：进程、worker 或远程 Environment 在不可靠时，Runtime 能否准确说明发生了什么、谁可以继续，以及哪些动作绝不能盲目重做。

## Q1：事件日志记录的是模型看到的消息，还是 Runtime 确认的事实？

**结论：必须把模型/UI 投影与执行事实分开。**

Codex 将 executed tool call 与 history 中的 tool-call/tool-result 配对分开处理；Pi 用 JSONL frame 保存 harness 事实，再由 recovery/replay policy 决定如何解释；OpenHands 的 Action/Observation 记录 Agent 与服务的交互，却不等于远程 workspace 的永久状态。[^codex] [^pi] [^openhands]

因此，`assistant message` 只能说明模型提出或表达了什么；“Runtime 接受了调用”“获得了审批”“工具已产生副作用”“结果已提交”必须有独立身份和状态。否则 compaction、UI 重绘或重启后，系统无法区分“建议执行”和“已经执行”。

## Q2：重启后，最小的可恢复单元是什么？

**结论：不是 transcript，而是带责任和身份的 operation/checkpoint。**

Codex 的 StepContext、Turn/history 和审批状态分别承担执行上下文、模型投影和交互责任；Kimi Code 把 StepRequest、task persistence、permission gate 和 tool dedupe 关联起来；OpenCode 更明确地将 Session message、execution claim 和 workspace driver 拆成三类状态。[^codex-step] [^kimi] [^opencode]

这三种设计共同说明：恢复至少要重建四件事——调用身份、执行责任、当前 owner、Environment reference。Pi 的 durable harness 已把恢复从“加载最后一条消息”推进到“判断 operation 是否已提交、是否可恢复”；Gemini CLI 和 mini-SWE-agent 则把更多 durable execution 责任留给上层应用。[^pi-restore] [^gemini] [^mini]

## Q3：工具调用失败或超时时，什么时候可以重试？

**结论：先区分状态重放、请求重试和副作用重试；`effect_unknown` 默认不能自动重试。**

Codex 的 executed-call 记录和 unified execution 能阻止 Runtime 在已接受调用后无条件制造第二次调用；Pi 为工具定义 replay policy；Kimi Code 以稳定 tool identity 做去重。[^codex-exec] [^pi-tool] [^kimi-dedupe]

但 OpenCode 的 execution claim 只解决“哪个 worker 推进”，不保证远端 API 或 shell effect 没有发生；OpenHands 的 Observation 也不能证明 sandbox 已 exactly-once 完成。[^opencode-claim] [^openhands] 因此安全恢复顺序应是：取得执行权 → 查询 Environment/外部资源 → 复用已知结果或标记未知 → 只有确认不存在或具备业务幂等键时才重试。

## Q4：取消、崩溃和后台任务如何进入终态？

**结论：终态是 Runtime 的承诺，不是 UI 标签。**

Codex 将 abort、Turn 输入排空和任务取消分层处理；Kimi Code 区分 prompt cancellation、task state 和 tool dedupe；OpenCode 通过 execution claim 让 worker 丢失后可以被接管。[^codex-cancel] [^kimi-cancel] [^opencode-claim]

Pi 把 generation recovery、tool recovery 和 JSONL restore 放进 durable harness；OpenHands 必须同时处理 conversation、agent-server、sandbox 和 workspace；Gemini CLI 与 mini-SWE-agent 则通过较小的 loop 边界换取更简单的故障模型。[^pi-restore] [^openhands-adapter] [^gemini] [^mini]

所以 `cancelled` 只表示 Runtime 不再主动推进，不能暗示已经 rollback；`completed` 不能掩盖未收敛的后台任务；`failed` 不能掩盖可能已经产生的外部副作用。无法安全判断时，`effect_unknown` 或 `needs_user_decision` 是正确终态，而不是恢复器的失败。

## 四类设计的取舍

| 设计 | 代表 Agent | 优点 | 代价 |
| --- | --- | --- | --- |
| Turn/Step 责任账本 | Codex | 交互、审批、工具归属清晰 | history 与执行事实需要持续配对 |
| durable harness + replay policy | Pi | 本地崩溃后能恢复中间 operation | 工具必须声明恢复语义 |
| execution claim + workspace 对账 | OpenCode | 适合多 worker 接管 | claim 不等于 effect 幂等 |
| task/request/dedupe 状态机 | Kimi Code | 适合队列、并发和取消 | identity、task、外部副作用必须一致 |

OpenHands 代表跨服务 Environment 边界；Gemini CLI 和 mini-SWE-agent 代表把持久化复杂度留给上层的轻量路线。它们不是“能力不足”的同义词，而是把恢复责任放在不同层级。

## 判断一个实现是否真的可恢复

只需检查四件事：

1. 能否从固定事实重建 operation，而不是从最后一条消息猜测？
2. 是否能区分“未执行”“执行中”“已完成”“副作用未知”？
3. 是否有 owner/claim/lease 机制阻止两个恢复者同时推进？
4. 恢复前是否重新观察 Environment，而不是相信旧 observation？

四项中任意一项缺失，系统最多是可续聊，不是可证明地恢复执行。

## 证据边界

上述结论来自固定版本源码和测试阅读；不同项目的数据库事务、provider 请求提交状态、远程 sandbox 租约和真实 shell 副作用仍需故障注入验证。源码存在 recovery 分支，不等于生产环境已经提供 exactly-once。

[^codex]: [Codex executed tool calls and history pairing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470) / [history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L690-L725)
[^pi]: [Pi JSONL storage and tool recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290) / [replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^openhands]: [OpenHands Action/Observation types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^kimi]: [Kimi StepRequest and persisted task](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^opencode]: [OpenCode Session projection and execution](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^gemini]: [Gemini CLI Session loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^mini]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
[^codex-exec]: [Codex executed calls and unified execution](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^pi-tool]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^opencode-claim]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^codex-cancel]: [Codex cancellation and input drain](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L509-L535)
[^kimi-cancel]: [Kimi prompt cancellation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L445-L459)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
