---
title: Coding Agent 的 Failure Recovery 与终态收敛
series: Coding Agent 的事件、持久化与恢复
part: 4
reviewed_at: 2026-09-17
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Failure Recovery 与终态收敛

## 结论

Coding Agent 的可靠性不由“能否捕获异常”决定，而由系统能否在异常之后形成一个可解释、可继续或可安全停止的终态决定。

一次运行可能经历：

```text
用户输入
  → 模型请求
  → 工具调用
  → 审批等待
  → Environment 执行
  → 文件或远程副作用
  → 结果观察
  → 下一次模型请求
```

任何箭头之间都可能发生中断。一个真正的 recovery 机制必须区分：

- 运行是否已经停止；
- 当前 Step 是否已经结束；
- 工具是否已经产生副作用；
- Turn 是否仍然有继续价值；
- Session 是否可以接受新的输入；
- Environment 是否仍然由当前运行者拥有。

因此，“进程重启成功”不等于“任务恢复成功”。恢复成功至少意味着：

1. 未完成工作的责任被重新识别；
2. 外部状态被重新观察或确认；
3. 旧权限不会被无条件扩大复用；
4. 模型不会把未知状态当成成功或失败；
5. Runtime 最终进入 `completed`、`failed`、`cancelled`、`waiting` 或 `needs_user_decision` 等可解释状态。

本文将“终态收敛”定义为：在没有新的外部输入时，恢复器不会无限重复同一动作，并且每个未完成 operation 都会被归类、处理或明确交给人工决策。

## 1. Failure 不是一种状态

### 1.1 控制流失败

模型 API 返回错误、JSON 解析失败、工具参数校验失败和 Runtime 内部异常，主要影响控制流。它们通常不代表 Environment 已发生副作用。

### 1.2 执行失败

进程启动失败、命令退出非零、工具超时和权限拒绝发生在执行层。它们可能有结果，也可能只说明动作未完成。

### 1.3 观察失败

动作已经可能完成，但客户端没有收到结果、结果写入失败或远程连接断开。此时最危险，因为调用的真实效果未知。

### 1.4 协调失败

worker 崩溃、租约过期、两个恢复者竞争或旧 worker 在接管后重新上线，属于运行者协调问题。它们可能让同一个 operation 被多个进程处理。

### 1.5 环境失败

容器销毁、cwd 不存在、远程 sandbox 不可达、依赖服务停止或工作树被用户修改，属于 Environment 状态问题。Session 仍然可以存在，但原来的执行条件已经消失。

这些失败类型必须在事件和恢复决策中分开。把它们统一映射成 `error`，会让恢复器无法判断是否可以重试，也会让用户无法理解任务停在哪里。

## 2. 终态收敛的定义

一个 Agent 的终态不是 UI 上的颜色，而是 Runtime 对继续执行的承诺。可以用以下不变量判断：

```text
Terminal(Turn) ⇒
  no unclaimed executable operation
  ∧ no unresolved approval
  ∧ no active worker owned by this Turn
  ∧ all effects are committed, compensated, or explicitly unknown
  ∧ next input policy is defined
```

对于整个 Session，还需要说明：

- 是否可以创建新的 Turn；
- 是否保留未解决的 Environment；
- 是否允许恢复后台任务；
- 是否需要用户重新授权；
- 是否存在等待外部事件的 continuation。

`Turn completed` 不一定意味着所有后台任务完成；但系统必须将后台任务从 Turn 的同步终态中分离出来，并为它们建立独立生命周期。否则用户看到“完成”，恢复器却仍然可能在后台执行旧动作。

## 3. 统一恢复状态机

下面的状态机不要求项目使用这些字面量，但可以作为比较不同 Agent 的共同坐标：

```text
                    ┌──────────────┐
                    │   RUNNABLE   │
                    └──────┬───────┘
                           │ claim
                           ▼
                    ┌──────────────┐
             ┌──────│    RUNNING   │──────┐
             │      └──────┬───────┘      │
      cancel │             │              │ worker lost
             ▼             │ result       ▼
       CANCEL_REQUESTED    │       ┌─────────────┐
             │              │       │   ORPHANED  │
             ▼              ▼       └──────┬──────┘
       CANCELLED       OBSERVED           │ inspect
                            │              ├── effect absent -> RETRYABLE
                            ▼              ├── effect present -> RECONCILED
                        COMPLETED          └── unknown -> NEEDS_DECISION

RUNNING ── explicit failure ──> FAILED
RUNNING ── approval required ─> WAITING_APPROVAL
RUNNING ── environment lost ─> WAITING_ENVIRONMENT
RUNNING ── timeout ───────────> EFFECT_UNKNOWN or RETRYABLE
```

其中 `ORPHANED`、`EFFECT_UNKNOWN` 和 `NEEDS_DECISION` 不是失败的别名，而是恢复器必须处理的中间状态。它们的存在使系统可以停止危险动作，等待更多证据，而不是通过猜测强行继续。

## 4. 中断的四种来源

### 4.1 用户中断

用户按下取消或输入 steer，通常希望停止当前模型循环，但未必希望回滚已经完成的文件修改。Runtime 应把：

- 停止模型生成；
- 停止正在运行的工具；
- 清空或保留 pending input；
- 继续当前 Turn；
- 创建新 Turn；

分别定义。

Pi 的 Agent loop 区分 `abort`、`steer` 和 follow-up；工具批次完成、当前工具被中止和下一次模型请求之间有不同的输入边界。[^pi-abort] [^pi-loop]

Codex 则将任务取消、待处理输入和 Turn 生命周期关联起来；取消操作不会自动证明所有子进程和外部效果已经停止。[^codex-abort] [^codex-abort-all]

### 4.2 Runtime 崩溃

进程崩溃时没有机会执行清理逻辑，因此不能依赖 `finally` 把状态改成完成或取消。恢复必须从最后的持久化事实和 Environment 观察开始。

### 4.3 Provider 断线

Provider 断线可能发生在模型响应之前、流式中间或工具调用已生成之后。若响应已包含 tool call 但本地未持久化，恢复器应避免再次请求模型后直接执行未知的第二个调用。

### 4.4 Environment 消失

远程 sandbox 过期、容器重建或工作目录被删除时，Session 可以保留，但原始 Step 的执行条件不存在。系统必须先重建或替换 Environment，并把环境迁移作为一个明确事件，而不是继续使用旧的 cwd 字符串。

## 5. 取消不是回滚

这是 coding agent 中最容易误解的边界。

```text
cancel(model generation)   停止继续产生决策
cancel(tool process)       请求停止执行
rollback(workspace)        恢复文件或资源状态
compensate(effect)         执行业务反向动作
```

用户取消了 `pytest`，不表示测试产生的缓存已经删除；用户取消了 patch 应用，不表示部分写入已经自动恢复；用户取消了远程资源创建，不表示服务端已经撤销请求。

Codex 的取消流程和统一执行器分别处理任务/进程层面的中断；Pi 的恢复工具逻辑也将工具执行状态与 assistant generation 的恢复分开。[^codex-abort] [^codex-unified] [^pi-tool-recovery]

因此，取消事件应记录请求时间、目标 operation、取消是否确认、Environment 返回的状态以及残留副作用。若取消未确认，终态应是 `cancel_requested`、`effect_unknown` 或 `needs_user_decision`，而不是直接标记 `cancelled`。

## 6. 审批等待如何收敛

审批等待是一个合法的非终态，不是异常。它需要防止两个常见问题：审批结果被错误消费，以及恢复后无条件复用旧授权。

一个安全的审批生命周期是：

```text
ApprovalRequested(call_id, scope, policy_version)
  ├── Granted -> Authorized(call_id, scope)
  ├── Denied  -> Rejected(call_id)
  ├── Expired -> ApprovalRequiredAgain
  └── Cancelled -> NoExecution
```

如果 worker 在 `Granted` 后崩溃，恢复器需要确认该授权是否已经被当前 call 消费，以及工具参数是否保持相同。Codex 将审批回复和调用身份绑定，并在 Turn 状态中维护等待对象；Kimi Code 通过 permission gate 与 task persistence 保留类似责任边界。[^codex-approval] [^kimi-permission] [^kimi-task]

“用户曾经允许执行 shell”不应被解释成“恢复器可以允许所有后续 shell”。审批的 scope、参数和策略版本必须进入恢复判断。

## 7. 后台任务的终态

后台任务使 Turn 的完成和 Environment 的完成脱钩。典型例子包括：

- 启动开发服务器；
- 等待远程构建；
- 子 Agent 异步工作；
- 监控测试或文件变化；
- 远程部署任务。

这些任务应有自己的 `operation_id`、worker/lease 和生命周期：

```text
detached -> running -> completed
                    ├─ failed
                    ├─ cancelled
                    ├─ orphaned
                    └─ effect_unknown
```

父 Turn 可以进入 `waiting`、`completed_with_background_work` 或 `detached`，但不能把后台 operation 从日志中删除。Codex 的多 Agent wait/steer 机制体现了父任务等待与输入活动之间的控制边界；OpenHands 的远程 workspace 和服务上下文则要求后端继续维护独立运行状态。[^codex-wait] [^openhands-adapter]

如果后台任务没有租约，重启后可能出现两个 watcher 或两个开发服务器同时运行。若没有资源标识，恢复器也无法判断旧任务是否仍然存在。

## 8. Recovery 的责任转移

恢复通常意味着运行者变化：旧 worker 消失，新 worker 接管。接管不能只是读取 Session 后开始执行，需要经过 claim/lease/fencing。

### 8.1 Claim

Claim 表示某个 worker 当前负责处理 operation。它应带有 worker identity、版本或 token，避免两个 worker 同时认为自己拥有执行权。

### 8.2 Lease

Lease 允许 worker 在崩溃后释放责任。租约过期不等于副作用停止；它只说明旧 worker 不再被信任，需要新 worker 重新观察 Environment。

### 8.3 Fencing

Fencing 防止旧 worker 在失去所有权后继续提交结果。例如新 worker 已经接管 operation，旧 worker 后到的 observation 不应覆盖新状态。

OpenCode 的 Session execution 通过 claim 和恢复测试表达这种运行者协调；Pi harness 的 lane/operation/restore 则把恢复责任放进 durable runtime。[^opencode-execution] [^opencode-tests] [^pi-restore]

## 9. 恢复决策的优先顺序

面对未完成 operation，恢复器可以按以下顺序处理：

```text
1. 是否存在另一个有效 owner？
2. 当前 Environment 是否可访问且 identity 一致？
3. 是否有明确的完成/失败结果？
4. 是否能通过查询确认外部 effect？
5. 当前 approval 是否仍匹配？
6. 工具是否声明可重试或幂等？
7. 用户是否需要重新决定？
8. 生成 recovery decision event
```

这个顺序很重要。先检查工具 retry policy、再检查 Environment，会让恢复器在旧环境或未知副作用上做出错误决定；先重试模型请求，则可能生成第二个不一致的工具调用。

## 10. Context 与终态收敛

恢复器最终通常需要再次调用模型，但模型必须看到的是**恢复后的事实状态**，不是一段模糊的“上次出错了”。

建议将恢复结果投影成结构化上下文：

```text
Recovery notice
  operation: call_123
  previous state: running
  observed effect: file changed / no change / unknown
  action: reconciled / retryable / awaiting approval
  constraints: do not repeat without confirmation
```

OpenCode 通过 Session message 到 LLM message 的转换，Codex 通过 history manager 和工具结果处理，Pi 通过 recovery 结果注入 Agent loop，均体现了恢复状态需要经过 Context 投影，而不是直接把内部异常栈交给模型。[^opencode-context] [^codex-history] [^pi-recovery]

模型可以帮助决定下一步，但不应决定过去是否发生了副作用。`recovery notice` 中的 Environment 观察和 Runtime 决策必须由系统生成，不能让模型将推测写成事实。

## 11. 终态分类与用户体验

用户需要知道任务是“完成”“失败”还是“需要处理”，但 UI 不应把复杂状态全部隐藏成成功/失败二元值。

| Runtime 终态 | 对用户的含义 | 是否可自动继续 |
| --- | --- | --- |
| `completed` | 目标动作和结果已确认 | 可以开始新 Turn |
| `failed` | 动作明确失败，副作用语义已知 | 通常可让模型分析 |
| `cancelled` | 用户或策略确认停止 | 由用户决定是否继续 |
| `waiting_approval` | 尚未获得必要授权 | 等待用户 |
| `waiting_environment` | Environment 尚未就绪 | 自动重试或等待外部恢复 |
| `effect_unknown` | 可能已产生副作用 | 默认不能盲目继续 |
| `needs_user_decision` | Runtime 无法安全推断 | 必须人工决策 |
| `completed_with_background_work` | 主 Turn 完成，后台任务仍存在 | 由后台生命周期管理 |

这种分类可以同时改善安全性和可用性：用户知道为什么不能继续，模型也能收到准确的控制条件。将 `effect_unknown` 显示为普通失败，会诱导用户再次点击重试；将 `waiting_approval` 显示为卡死，则会促使用户重复提交请求。

## 12. 各 Agent 的终态收敛路径

### 12.1 Codex：Turn 级取消与输入排空

Codex 将输入活动、Turn 取消、待处理输入和工具/任务执行放在较清晰的层次中。活跃 Turn 被取消后，剩余输入如何进入历史、是否继续新请求，都由 Turn 生命周期决定，而不是简单清空队列。[^codex-abort-all] [^codex-drain]

它的优势是产品交互语义较明确：用户可以 steer、取消、等待后台 Agent，并保留 Session 归属。恢复难点则在于本地/远程工具效果和多个异步任务之间的终态对账。

### 12.2 Pi：恢复逻辑进入 durable harness

Pi 的恢复实现针对 assistant generation、工具调用和 JSONL frame，允许 harness 在重启后判断哪些消息已持久化、哪些工具需要恢复结果。[^pi-recovery] [^pi-tool-recovery] [^pi-jsonl]

它的演进意义是：恢复不再是 Agent loop 外部的应用补丁，而成为 lane/operation/frame 生命周期的一部分。代价是工具需要提供明确 replay policy，恢复器也必须处理更多中间状态。

### 12.3 OpenCode：execution claim 作为收敛基础

OpenCode 将 Session execution 的 claim、释放和恢复作为独立机制，并用测试覆盖执行者丢失和重新接管。[^opencode-execution] [^opencode-tests]

这使“谁负责继续运行”成为可验证状态，而不是隐含在进程是否存在。但 claim 只能解决协调，不能单独解决 shell 和远程 workspace 的副作用对账。

### 12.4 OpenHands：跨服务恢复

OpenHands 的恢复边界跨越 conversation、agent-server、sandbox 和 workspace。前端可以保留历史，后端仍需重新建立可执行环境；环境不可用时，正确终态应是等待 Environment 或请求用户决策，而不是继续调用模型。[^openhands-adapter]

### 12.5 Kimi Code：任务状态、去重和请求取消

Kimi Code 的任务持久化、工具调用去重和 prompt/step request 队列，为恢复器提供了请求级身份和状态边界。[^kimi-task] [^kimi-dedupe] [^kimi-abort]

这种方式适合队列和并发，但要特别验证“取消请求”和“工具副作用已停止”是否有明确区分。

### 12.6 Gemini CLI 与 mini-SWE-agent：恢复责任的不同位置

Gemini CLI 的 Session loop 具备动态上下文、policy 和 shell 控制点；mini-SWE-agent 的最小 loop 则主要依赖 trajectory 和 Environment。[^gemini-session] [^gemini-policy] [^mini-default]

前者可以作为产品 Session 的基础，但远程恢复和后台任务需要更高层协议；后者适合作为可测试的最小执行基线，但长期恢复、权限等待和多 worker 接管不是默认能力。

## 13. 机制级解剖：各 Agent 如何让失败收敛

失败恢复的区别，最终体现在谁有权把 operation 从中间态推进到终态，以及推进前检查了哪些事实。

### Codex：把取消传播到 Turn、任务和输入队列

Codex 的 abort-all 与 task cancellation 路径分别处理队列中的任务和当前执行中的任务；Turn 还负责排空输入并决定哪些输入进入后续历史。[^codex-abort-all] [^codex-abort] [^codex-drain] 这使“用户取消”不是简单杀掉一个子进程，而是一次 Runtime 状态转换。

它的产品优势是取消、继续输入、后台 Agent 和审批可以拥有稳定的 Session/Turn 语义。未解决的部分是：取消成功只证明 Runtime 不再主动推进，不证明已经发出的 shell、网络请求或远程任务撤销成功。

### Pi：把崩溃恢复纳入 lane/operation 生命周期

Pi 的 restore、generation recovery、tool replay 和 JSONL storage 共同决定 harness 重启后如何重新建立操作状态。[^pi-restore] [^pi-recovery] [^pi-tool-recovery] 其核心不是“恢复最后一个 prompt”，而是判断某个 operation 是否已提交、是否有可复用结果、是否必须停下来。

这套设计适合本地持久运行，但对跨进程接管的要求仍高于单纯读取 JSONL：需要外部 owner、lease 或 Environment probe 才能排除旧 worker 仍在执行的可能。

### OpenCode：先恢复 execution ownership，再推进 Session

OpenCode 的 execution claim、release 和 takeover 机制把 worker 崩溃转换为可测试的责任转移。[^opencode-execution] [^opencode-tests] 这是它收敛设计的核心：没有 owner，就不能把 Session 当作仍在正常推进。

但 claim 只是并发一致性层。恢复 worker 取得 claim 后仍需检查 workspace 和未完成工具，否则可能出现“只有一个 worker 正在重复执行同一个 effect”的单 worker 重复问题。

### OpenHands：故障终态由服务拓扑决定

OpenHands 的 agent-server、conversation、sandbox 和 workspace 分属不同边界，恢复需要重新组装运行上下文。[^openhands-adapter] 因此它的终态比单进程 CLI 更依赖 Environment：服务可用但 sandbox 丢失，应等待或重建；历史可用但 Agent server 不可达，应显示不可继续，而不是继续生成模型调用。

它的优势是能表达远程软件工程任务的真实故障；代价是单个“失败”不能概括所有原因，恢复器必须保留服务、环境和 Agent 三类状态。

### Kimi Code：取消、任务状态和去重各自收敛

Kimi Code 的 prompt service 能取消 pending/active prompt，task persistence 记录任务阶段，tool dedupe 处理重复调用。[^kimi-abort] [^kimi-task] [^kimi-dedupe] 这种拆分能把“停止生成”“任务已取消”“工具副作用是否停止”区分开。

这正是队列化 Runtime 的关键：取消请求可以先让模型 loop 停止，但只有工具执行器确认停止或对账完成，任务才应进入安全终态。若三者状态不同步，最容易产生 UI 显示 cancelled、远端任务仍运行的假完成。

### Gemini CLI 与 mini-SWE-agent：通过缩小故障边界换取简单性

Gemini CLI 的 Session stream loop、policy 和 shell 控制点可以处理流式中断与权限决策；mini-SWE-agent 的 default loop 则通常在 trajectory 中追加失败 observation 后继续或结束。[^gemini-session] [^gemini-policy] [^mini-default]

它们的设计并非不能恢复，而是把恢复责任压缩在一次 loop 或上层调用中。对于短任务这降低了状态机成本；对于后台、远程和多 worker 场景，则必须补足 claim、task state、effect status 和 Environment recovery。

## 14. 设计原则

### 原则一：终态必须是 Runtime 承诺

只有当未完成动作、权限等待、运行者和副作用状态都被处理后，才应宣称 Turn 完成。

### 原则二：中断、取消、回滚分离

停止未来计算不等于撤销过去效果。每个动作都需要明确是否可取消、是否可回滚以及如何补偿。

### 原则三：未知状态阻断危险自动化

对于可能产生外部副作用的 unknown，默认进入对账或人工决策，而不是自动重试。

### 原则四：恢复者必须可替换

Session 状态不能依赖某个 worker 的内存。claim、lease 和 fencing 使责任可以从崩溃的 worker 转移给新的 worker。

### 原则五：后台工作必须有独立生命周期

Turn 的用户交互可以结束，后台 operation 不能因此消失。必须能查询、取消、接管和最终收敛。

### 原则六：恢复决策产生新事实

恢复不是悄悄修改历史，而是基于旧事实产生新的决策事件。这样才可以解释自动重试、跳过、补偿和人工升级。

### 原则七：终态收敛优先于自动完成

一个明确等待用户的任务，比一个重复执行副作用后显示成功的任务更可靠。Runtime 的目标是可解释地结束，而不是无条件地继续。

## 15. 验证方案

### 14.1 故障矩阵

构造如下实验矩阵：

| 故障点 | Environment 状态 | 预期恢复 |
| --- | --- | --- |
| 模型请求前崩溃 | 无副作用 | 重新构建请求 |
| tool call 接受后崩溃 | 无执行 | 恢复或取消调用 |
| 审批通过后崩溃 | 未执行 | 校验 scope 后继续 |
| effect 完成后崩溃 | 副作用存在 | 对账并复用结果 |
| effect 中途崩溃 | 部分修改 | 标记 unknown，禁止盲试 |
| worker 租约过期 | 可能仍运行 | fencing 后再接管 |
| Environment 被销毁 | 状态不可访问 | 等待重建或请求决策 |
| Turn 取消时有后台任务 | 子任务运行 | 分离并管理后台生命周期 |

### 14.2 收敛断言

每个实验至少应断言：

```text
恢复后不会重复消费同一 call_id
未知副作用不会自动变成 completed
旧 worker 不能覆盖新 worker 的状态
审批不会扩大到新的参数或新的 Environment
用户取消不会伪造 rollback
后台任务可查询且最终进入终态
每次恢复都有可追踪的 decision event
```

### 14.3 需要记录的指标

- 从崩溃到重新取得 owner 的时间；
- 未完成 operation 被正确分类的比例；
- 自动恢复与人工升级的比例；
- 重复工具调用次数；
- unknown effect 的最终对账率；
- 恢复后 Context 与 Environment 的不一致次数；
- 终态长期停留在 orphaned 或 waiting 的数量。

本文仍以固定版本源码和测试阅读为主，没有在所有 Agent 上运行统一故障矩阵。特别是远程 Environment、provider 超时和真实文件/网络副作用，需要单独的实验环境和可控模拟器验证。

## 16. 本专题的整体收束

四篇文章可以合并成一个完整判断：

```text
事件日志       记录发生了什么
持久化模型     保存恢复所需的责任
Replay/Retry   决定哪些东西可以再次计算或执行
Failure        让未完成状态进入可解释终态
```

Coding Agent 从“调用模型并执行命令”演进为长期运行的 harness，真正增加的不是更多工具，而是这些边界：

- 模型决策与 Runtime 接受分离；
- Runtime 事件与模型/UI 投影分离；
- Session 历史与 Environment 状态分离；
- 取消与回滚分离；
- 重放状态与重放副作用分离；
- 运行者退出与任务终止分离；
- Turn 完成与后台工作完成分离。

这些边界使系统可以在失败后保持诚实：知道什么已经发生，知道什么尚不确定，知道谁可以继续，以及什么时候必须停下来让用户决定。这比单纯增加异常处理或重试次数更接近 coding agent Runtime 的可靠性核心。

## 未确认事项

- 各项目在多进程/多副本部署下的 fencing 和租约语义，需要结合实际存储与部署配置验证。
- 各项目的远程 Environment 是否能提供可靠的 effect 查询接口，不能由本地 Runtime 代码直接推断。
- provider 请求在网络断开后的服务端提交状态仍是主要未知来源。
- 本文的统一状态名是分析模型，不代表各 Agent 内部使用完全相同的状态机。

## 参考源码

[^pi-abort]: [Pi loop cancellation and tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L430-L718)
[^pi-loop]: [Pi agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-abort-all]: [Codex abort-all queue handling](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L509-L535)
[^codex-unified]: [Codex unified execution manager](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^pi-tool-recovery]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-tests]: [OpenCode claim and recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^opencode-context]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^codex-drain]: [Codex run_turn input consumption and completion](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)
[^kimi-abort]: [Kimi pending and active prompt cancellation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L445-L459)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^gemini-session]: [Gemini CLI SDK stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
