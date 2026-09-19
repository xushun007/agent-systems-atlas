---
title: Tool 副作用、重试与 Exactly-once 的幻觉
series: Coding Agent 的 Tool Invocation：从能力声明到外部副作用
part: 4
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Tool 副作用、重试与 Exactly-once 的幻觉

## 结论

Coding Agent 的重试问题通常不是“失败后要不要再次调用”，而是“第一次调用到底发生了什么”。模型请求可以安全重试，纯读取通常可以重试，文件编辑需要检查版本，部署、删除、发布和数据库写入则可能已经生效但结果尚未返回。

核心结论是：**Exactly-once 是 Runtime、Environment 和外部服务共同提供的协议性质，不是调用循环中的一个 while 条件。** 本地异常不能证明外部副作用没有发生。

安全重试需要分别记录逻辑意图、实际尝试、外部 effect、结果确认和恢复决策。

~~~
logical intent
      ↓
attempt 1 → effect? → result uncertain
      ↓
reconcile / idempotency / query
      ↓
retry attempt 2 or settle unknown
~~~

## 1. 四种执行结果

| 结果 | 含义 | 是否可以直接重试 |
| --- | --- | --- |
| not_started | 已拒绝、参数非法或资源解析失败 | 修正后通常可以 |
| attempted_no_effect | 执行器确认没有产生 effect | 取决于工具语义 |
| effect_confirmed | 外部动作已确认 | 不应重复 |
| effect_unknown | 可能产生 effect，但无法确认 | 先查询或人工确认 |

通用 Runtime 通常只能可靠识别第一类和部分第三类。第二类需要执行器提供证明，第四类是网络超时、进程中断和崩溃窗口中最常见的状态。

## 2. 为什么异常不能说明没有副作用

以下顺序完全可能发生：

1. 工具向远程服务发送请求；
2. 服务接受请求并开始处理；
3. 本地连接在响应前断开；
4. Runtime 报告 timeout；
5. Agent 再次提交相同调用。

本地观察是失败，外部状态却可能已经成功。文件系统也存在相同窗口：写入完成后，进程可能在写入结果日志之前崩溃。

错误记录应尽量包含 effect uncertainty，而不是只有错误文本。恢复器至少需要动作类别、固定参数、Environment、远程 handle、幂等键、尝试次数和最后观察时间。

## 3. Effect classification

| 类别 | 例子 | 默认策略 |
| --- | --- | --- |
| pure_read | 读取文件、查询 Git 状态 | 可重试，需考虑新鲜度 |
| deterministic_local | 固定版本上的 patch | 检查 revision 后重试 |
| idempotent_write | 带幂等键的远程更新 | 查询后可重试 |
| append_or_create | 创建文件、追加日志 | 检查目标状态 |
| external_job | 部署、构建、异步任务 | 保存 handle，先查询 |
| irreversible | 发布、删除、发送消息 | 默认不自动重试 |

Effect class 不是安全证明。它只是 Runtime 选择默认恢复策略所需的工具契约。文件写入也可能触发 watcher、构建系统或远程同步，因此隐藏副作用必须计入分类。

## 4. Pi：replay-safe 是显式门槛

Pi v0.85.1 的 durable harness 对未完成工具调用采用保守策略：只有持久记录和当前工具都声明 replay safe、调用未被取消、参数可以从 checkpoint 恢复时，才执行 replay；否则生成 interrupted 或 unknown outcome，不调用工具。[^pi-recovery]

上游测试验证两个顺序：

1. 先提交 replay commit，再启动工具；
2. 使用持久化参数，而不是从变化后的 Context 重新生成参数。[^pi-test]

这避免恢复器在没有留下意图证据前产生 effect，也避免压缩后参数发生漂移。safe 仍然只是工具作者的合同；部署、数据库和消息发送还需要 provider 幂等键、查询接口或人工确认。

## 5. OpenCode：claim 不是幂等键

OpenCode v2 用持久 claim 发现没有终态的 Session execution，并在不同终态下释放或保留 claim。这个机制解决的是进程崩溃后“哪个 Session 需要恢复”，不是“工具动作是否成功”。[^opencode-execution]

如果 runner 在 effect 后崩溃，恢复服务可以重新取得 Session execution，却不能从 claim 推断工具未执行。它还需要工具 intent、远程 job handle 或 provider status。

OpenCode 的 Workspace driver 要求 provider resource 按 workspace ID 幂等创建，并考虑创建成功但绑定持久化失败的窗口。[^opencode-workspace] 这是 Environment provisioning 的幂等性要求，不能推广为所有工具 effect 都安全。

## 6. Codex：本地取消与外部资源清理

Codex v0.154.0 取消任务时先传播 cooperative token，等待短暂的 graceful interruption，之后强制 abort Runtime task；统一执行管理器可以列出和终止后台 terminal。[^codex-abort] [^codex-unified]

这能减少本地进程泄漏，却不自动提供外部 exactly-once。命令可能已经写文件、启动服务或发送网络请求；task abort 只能阻止尚未执行的后续代码。

Codex 的 executed tool call metadata 和 rollout 记录有助于判断调用是否已经被记录，但记录完整不等于 effect 已确认。[^codex-recorder]

## 7. OpenHands：Action 已发出但 Observation 缺失

OpenHands v1.15.0 的 ActionEvent 和 ObservationEvent 分开记录，并通过 action ID 关联。若 agent-server 已接收 ActionEvent，但服务在 ObservationEvent 到达前退出，恢复器看到的是“动作存在、观察缺失”。[^openhands-events]

此时不能把缺失 observation 当成 not_started。应先查询 agent-server、sandbox 或工具后端；无法查询时，应标记 unknown，并将 action ID 保留给后续恢复流程。

Git worktree 可以回滚一部分文件；Cloud sandbox 可能可以销毁执行资源；shared workspace 中的修改可能已经和父 Agent 混合，不能安全自动还原。

## 8. Kimi Code：dedupe 不是 effect 去重

Kimi Code v0.40.0 的 tool dedupe 能识别同一工具和参数在同一步或跨步骤重复出现，并按重复程度提醒、重试或停止。[^kimi-dedupe]

dedupe 对防止模型循环有价值，但不等于外部 effect 去重。重复请求可能表示第一次结果丢失，也可能表示第一次确实失败；Runtime 仍需根据 attempt、Tool Result 和 Environment 状态决定。

Kimi 的 awaiting approval 是持久任务状态。重启后恢复等待任务时，必须重新检查当前策略和外部资源；旧 approval 不能自动变成新的执行授权。[^kimi-task]

## 9. 文件编辑的重试边界

文件编辑看似比远程部署简单，但仍有多个窗口：

- 第一次写入成功，结果返回失败；
- 另一个进程在两次尝试之间修改文件；
- patch 重试基于旧行号，误改新内容；
- watcher 因第一次写入触发构建或代码生成；
- Git index 和 working tree 状态不一致。

可靠的文件重试需要 base revision、patch identity 和当前 diff 检查。若 patch 已应用，重复应用应识别为完成或冲突，而不是再次写入。

## 10. 外部作业应先查询再重试

部署、构建、队列任务和远程执行应返回可持久化 handle：

~~~
submit → job_id
             ↓
         query(job_id)
             ↓
    succeeded / failed / running / unknown
~~~

网络断开后，Runtime 先 query handle，再决定是否 submit。没有 handle 时，只能依赖 provider 幂等键、请求去重或人工确认。

如果 provider 既没有查询接口，也没有幂等键，默认行为应是 unknown，而不是假设请求没有到达。

## 11. Exactly-once 的边界

Exactly-once 至少需要三层共同配合：

1. Runtime 对 logical intent 和 attempt 的唯一标识；
2. Environment 对执行资源和 owner 的唯一控制；
3. 外部服务对请求的幂等键或事务语义。

缺少第三层时，Runtime 最多提供本地发起的去重，不能提供外部 effect 的 exactly-once。一个 retry=false 配置不能改变这个事实。

| 目标 | 可能依赖的机制 |
| --- | --- |
| 不重复发起同一 Runtime attempt | call/attempt ID |
| 不让两个 runner 同时拥有 Session | claim、lease、fencing |
| 不重复产生外部 effect | provider idempotency 或 transaction |
| 结果最终可确定 | query handle、reconciliation |

## 12. 可复现验证设计

无需 API key，可以构造最小 effect probe：

1. 写入 intent 记录；
2. 执行一个会修改临时文件的工具；
3. 在提交 result 前人为截断日志；
4. 重启恢复器，观察是否标记 unknown；
5. 对 replay-safe 工具验证参数和 commit 顺序；
6. 对 unsafe 工具验证不会自动执行；
7. 使用幂等键模拟 provider 重复请求；
8. 使用无幂等键的 provider 模拟 timeout，确认恢复器优先 query 或请求确认。

实验应分别记录 logical intent、attempt、effect marker、result commit 和 Environment revision。只观察异常文本，无法验证是否产生副作用。

## 13. 设计原则

### 原则一：重试前先判断 effect 状态

失败、超时和断线只表示本地观察不足，不表示外部动作没有发生。

### 原则二：每次尝试都要有稳定身份

Logical intent、attempt、call、Turn 和 Environment 必须可关联，才能防止重复恢复。

### 原则三：安全重放必须是显式合同

Replay-safe、幂等键、查询接口和固定参数缺一不可；没有合同就保守标记 unknown。

### 原则四：本地回滚不覆盖外部世界

Git、worktree 和容器层回滚只能覆盖声明范围，不能替代远程补偿和业务查询。

### 原则五：Exactly-once 需要端到端协议

Runtime、Environment 和 provider 必须共同提供唯一性、所有权和事务/幂等语义。

## 14. 结论

Tool Invocation 的最后难题不是如何再次调用，而是如何知道是否应该再次调用。Pi 用 replay-safe 合同保护 durable tool recovery；OpenCode 用 claim 发现未结算执行，并把 Workspace resource provisioning 的幂等性单独建模；Codex 将本地取消、后台 terminal 和调用 metadata 分层；OpenHands 暴露 Action 与 Observation 之间的缺口；Kimi Code 用 dedupe 控制模型重复，但不把它误当作外部去重。

可靠 Runtime 的默认路径应是：先恢复身份，读取已有 attempt，查询 Environment 和外部 handle，只有安全合同满足时才 replay；否则保留 unknown 并请求确认。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | rust-v0.154.0 | 6b9826e3aa83b1a5947db50f4332cb9c65f1b340 |
| Pi | v0.85.1 | d981de1229ef899957bbe968bc8dcda02a21f477 |
| OpenCode | v2.0.0 | 63f7ceecbed2d7d9a627518d935dd963b9d4ac9f |
| OpenHands | v1.15.0 | ab23be62ad724fe83483036a0900bed7b7859166 |
| Kimi Code | v0.40.0 | e27ee60894d714e5844db75da69f29120a2bce43 |

本文完成源码和相关测试阅读，未运行真实 provider 幂等请求、跨进程 fencing、Cloud sandbox 故障或数据库事务实验。

[^pi-recovery]: [Pi replay-safe tool recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^pi-test]: [Pi tool recovery tests](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/harness/runtime/drive-tools.test.ts#L421-L480)
[^opencode-execution]: [OpenCode Session execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-workspace]: [OpenCode Workspace provider idempotency](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-unified]: [Codex unified execution manager](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^openhands-events]: [OpenHands Action and Observation events](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
