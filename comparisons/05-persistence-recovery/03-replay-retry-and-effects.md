---
title: Coding Agent 的 Replay、Retry 与副作用一致性
series: Coding Agent 的事件、持久化与恢复
part: 3
reviewed_at: 2026-09-17
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Replay、Retry 与副作用一致性

## 结论

在 Coding Agent 中，“重放事件”“重试模型请求”和“重新执行工具”是三个不同操作。它们经常被统称为 retry 或 replay，但安全性、代价和正确性条件完全不同：

```text
Replay event        重建 Runtime 状态       通常可重复
Retry model request 重新向模型请求输出       可能产生不同计划
Retry tool call      再次调用工具            可能重复副作用
Reconcile effect    查询外部状态             用于解决未知结果
Compensate effect   执行反向动作             依赖业务语义
```

一个 Agent 可以安全地重放 `ToolCallAccepted` 事件，却不能因此再次运行 `git commit`、发送邮件、创建云资源或修改数据库。对于有副作用的工具，最可靠的恢复策略通常不是“再试一次”，而是：

1. 先确认此前是否已经执行；
2. 查询 Environment 或外部系统的当前状态；
3. 使用幂等键或资源标识完成对账；
4. 只有在副作用不存在且工具语义允许时才重试；
5. 将恢复决策和不确定性写入新的事实记录。

这也是 exactly-once 在 Agent Runtime 中容易被误用的原因：Runtime 可以对事件消费做到一次，但无法仅凭客户端控制对外部世界做到一次。真正可实现的通常是“至少一次投递 + 幂等执行”或“状态重建 + 结果对账”。

## 1. 三个层次的重试

### 1.1 Provider 请求重试

模型请求失败可能发生在请求尚未提交、服务端已接受但响应未返回、流式响应中断或完整响应已收到但本地未落盘等多个位置。

```text
build context
    ↓
send request
    ├── connection failed before send
    ├── provider accepted, response lost
    ├── stream interrupted after partial output
    └── response received, local persist failed
```

只有第一类通常可以直接重试。后三类都可能导致重复模型生成，且如果模型输出包含工具调用，重复响应还可能生成两个不同的 call identity。

模型请求本身通常没有文件系统副作用，但它会改变 Agent 的控制流：第二次响应可能选择不同工具、不同参数甚至直接结束。因此模型重试不是透明的网络重试，而是一次新的决策。Runtime 至少应保留原请求和失败点，必要时将新请求标记为 recovery attempt。

### 1.2 Tool call 重试

工具重试需要先区分工具类型：

| 工具类型 | 例子 | 默认策略 |
| --- | --- | --- |
| 纯读取 | `rg`、读取文件、查询 Git status | 通常可重试，但结果可能已变化 |
| 可重复写入 | 写入固定内容、应用确定 patch | 需要检查目标版本或幂等条件 |
| 本地进程 | 编译、测试、启动服务 | 可重试，但可能留下进程或文件 |
| 外部创建 | 创建 issue、云资源、分支 | 先查询资源，避免重复创建 |
| 外部通知 | 发邮件、发消息、提交 webhook | 默认不可自动重试 |
| 不可逆动作 | 删除、发布、付款、合并 | 需要人工或业务级恢复协议 |

Pi 在工具恢复中明确区分可安全重放和需要恢复结果的调用；Codex 保留已执行工具调用的元数据；Kimi Code 维护工具调用去重服务。这些设计都不是为了保证所有工具 exactly-once，而是为了在 Runtime 层知道“这个 call 是否已经被处理过”。[^pi-tool-recovery] [^codex-recorder] [^kimi-dedupe]

### 1.3 Environment effect 重试

真正危险的是外部副作用，而不是函数再次被调用。一个工具函数可能返回错误，但已经完成部分操作；也可能返回成功，但异步副作用尚未完成。

因此需要把调用结果拆成：

```text
Invocation status:  accepted / started / returned
Effect status:      none / partial / committed / unknown
Observation status: missing / partial / complete
```

工具的 `returned = failed` 不能推出 `effect = none`。如果 Runtime 没有工具级语义，就只能把 effect 标为 unknown，并让恢复器进入对账流程。

## 2. 为什么 exactly-once 很难

### 2.1 两阶段提交不在同一控制域

Agent Runtime 通常控制事件存储和工具进程，但不控制所有外部资源。下面三个动作无法天然组成一个原子事务：

```text
写入“开始执行”事件
执行文件/网络/数据库副作用
写入“已完成”事件
```

如果进程在第二步之后、第三步之前崩溃，恢复器无法仅从本地日志判断副作用是否存在。若直接重试，就可能重复执行；若永不重试，又可能丢失任务。

### 2.2 “只执行一次”与“效果只发生一次”不同

即使一个 `call_id` 在 Runtime 中只被消费一次，也可能出现：

- worker 执行成功后响应丢失，另一个 worker 接管并再次执行；
- 远端服务按请求到达两次创建两个资源；
- 本地 shell 启动的后台进程没有随父进程终止；
- 文件写入部分完成，重试继续写入不同内容。

Runtime 的去重表只能防止同一个 Runtime 看到相同 call 重复消费，不能代替 Environment 或远端 API 的幂等协议。OpenCode 的 execution claim 解决的是运行者认领和恢复协调；workspace driver 的幂等性则是另一层责任。[^opencode-execution] [^opencode-workspace]

### 2.3 模型生成本身不是确定函数

即使 prompt、模型和参数看起来相同，provider 也可能返回不同结果。上下文压缩、工具 schema、时间、系统状态和流式边界都可能变化。因此“重试模型请求”不能被当作“重放原始决策”。

如果目标是恢复原始决策，应保存模型响应或结构化 tool call；如果目标是继续任务，应明确这是一个新的 recovery decision，并让模型看到之前的失败或未知状态。

## 3. 幂等性的四个层次

### 3.1 事件幂等

同一个 `event_id` 重复写入不会产生两份逻辑状态。实现方式可以是唯一键、去重表或追加日志读取时去重。

### 3.2 请求幂等

同一个 `request_id` 被 provider 或 Runtime 重复处理时，系统可以识别这是同一个模型请求。但这通常只能防止重复记录，不能保证 provider 不生成第二个响应。

### 3.3 工具调用幂等

同一个 `call_id` 的工具调用第二次到达时，Runtime 可以返回第一次保存的结果，而不再执行工具。Kimi Code 的 tool dedupe service 就属于这一层。[^kimi-dedupe]

### 3.4 业务副作用幂等

外部系统根据幂等键、资源名称或版本条件保证同一业务操作不会产生重复效果。例如：

```text
create_issue(idempotency_key=call_id)
write_file(path, expected_hash, content)
update_resource(resource_id, version=7)
```

这是最强也最难获得的一层。Coding agent 不能假设任意 shell 命令或第三方 API 都提供它。

## 4. Retry policy 不应由异常类型单独决定

`timeout`、`process exited 1` 和 `connection reset` 都只是技术层错误，无法直接决定是否安全重试。策略需要结合：

```text
工具副作用等级
+ 调用是否已开始
 + 是否存在幂等键
 + 是否可查询外部状态
 + 是否有部分结果
 + 用户授权范围
 + 当前 Environment 是否仍然有效
```

一个实际的策略表可以是：

| 状态 | 读取工具 | 本地写入 | 远端创建 |
| --- | --- | --- | --- |
| 未开始即失败 | 重试 | 重试 | 重试 |
| 已开始但无结果 | 重新读取 | 检查文件后决定 | 查询资源后决定 |
| 明确完成但响应丢失 | 返回缓存结果 | 校验目标后返回 | 按幂等键查询 |
| 部分完成 | 重新观察 | 按 patch/hash 对账 | 查询并补偿 |
| 结果未知 | 重试读取 | 检查工作树 | 禁止盲目重试 |

Codex 的取消和统一执行管理将进程控制、执行记录和任务状态分开；这类分层有助于避免把“取消请求已发出”误当作“子进程及其副作用已经停止”。[^codex-abort] [^codex-unified]

## 5. Replay 的不同含义

### 5.1 State replay

从事件重建 Session、Turn、Step 和 tool state，不再次调用模型和工具。这是最安全的 replay，适合启动恢复、审计和 UI 重建。

### 5.2 Context replay

从事实日志生成与过去相同或近似的模型上下文。它要求保留历史分支、工具结果、系统指令、模型配置和 schema 版本。上下文生成器发生变化后，Context replay 可能只保证语义等价，不保证字节相等。

### 5.3 Model replay

使用保存的模型响应或 provider replay 能力重现模型输出。它不应再次向真实 provider 发请求，否则那是 retry 或新的 inference。

### 5.4 Tool replay

按原参数重新调用工具。这是最危险的 replay。对纯函数读取通常可接受，对写操作则必须使用幂等、版本校验、快照或人工批准。

### 5.5 Effect replay

重新产生外部副作用，例如再次写文件、发送请求或创建资源。它不应作为通用 Runtime 能力开放，而应由每个工具声明语义，并经过 policy gate。

## 6. 工具结果缓存与“假完成”

保存第一次工具结果并在重试时返回，是一种常见的去重方式，但需要避免把缓存结果当作当前 Environment 的新观察。

例如第一次 `git status` 返回干净，随后用户修改了文件；恢复器若直接返回旧缓存，就会让模型看到过期状态。相反，第一次 `create_issue` 的结果可以作为同一个 `call_id` 的执行结果重用，因为该结果代表已提交的业务副作用。

因此结果缓存要标注：

```text
cache_semantics = observation | effect_result | provider_response
validity = immutable | environment_versioned | time_bounded
reusable_for = recovery | display | model_context
```

OpenCode 的 shell result 和 LLM message 转换展示了“执行结果”和“模型消息”之间的不同投影；Pi 对大输出进行捕获和外置，也说明结果保留策略不能只看文本是否存在。[^opencode-shell] [^opencode-llm] [^pi-env]

## 7. 文件系统工具的特殊问题

Coding agent 最常用的是文件读写、patch、搜索和 shell，但它们的副作用边界不同。

### 7.1 读取

读取通常没有业务副作用，但结果高度依赖 Environment 当前版本。安全做法是记录路径、读取时刻、工作树版本和内容摘要；恢复时可以重新读取，而不是直接把旧内容当新事实。

### 7.2 覆盖写入

`write(path, content)` 若无条件覆盖，重试可能覆盖用户在 Agent 暂停期间的修改。更安全的接口包含期望 hash 或版本：

```text
write(path, expected_hash=h1, new_content=c2)
```

如果当前 hash 不等于 `h1`，工具应返回冲突，而不是继续写入。这样重试会变成一次明确的冲突处理，而不是静默破坏。

### 7.3 Patch

Patch 应记录基准内容或上下文，并在重试时重新验证。一个 patch 已经应用后再次应用，理想结果应是“已应用”或“无需变更”，而不是产生重复修改。若 patch 工具不提供这一语义，Runtime 只能先检查 diff。

### 7.4 Shell

Shell 是最难自动判定的工具：一条命令可以读写文件、启动后台任务、访问网络或调用另一个工具。Runtime 可以记录命令文本和退出码，但不能仅凭 shell wrapper 推导副作用。Codex 的 unified execution 与 executed tool call metadata 提供执行层记录，但具体命令效果仍需 Environment 对账。[^codex-unified] [^codex-recorder]

## 8. 多 Agent 与并行调用

并行工具和子 Agent 使 retry 语义进一步复杂。一个父 Turn 可能同时产生多个调用：

```text
parent turn
  ├── call A: read files
  ├── call B: run tests
  └── call C: write patch
```

如果 B 失败，是否重试 B 取决于 A 和 C 的状态；如果 C 已修改工作树，B 的重新运行可能观察到不同代码。恢复器不能只按父 Turn 的整体状态重试所有子调用。

每个并行 operation 都应有独立 identity、状态和 Environment 影响范围。Codex 的执行工具记录和 Pi 的工具批次执行都保留调用级别信息；这比只保存“这一批工具完成/失败”更适合恢复。[^codex-recorder] [^pi-execute]

子 Agent 的结果也需要区分：父 Agent 收到的是一个 observation，还是子 Agent 对共享 Environment 已经产生副作用。Kimi Code 将 subagent context、task state 和 tool dedupe 分开，说明跨 Agent 恢复不能只复制父子消息。[^kimi-task]

## 9. 从失败到恢复的状态机

一个简化的调用恢复状态机如下：

```text
PROPOSED
  └─ accept -> ACCEPTED
                ├─ deny -> REJECTED
                └─ approve -> AUTHORIZED
                                ├─ start -> RUNNING
                                ├─ cancel -> CANCELLED
                                └─ timeout/unknown
RUNNING
  ├─ result -> OBSERVED -> COMPLETED
  ├─ explicit failure -> FAILED
  ├─ cancellation confirmed -> CANCELLED
  └─ worker lost -> ORPHANED

ORPHANED
  ├─ effect absent -> RETRYABLE
  ├─ effect present -> RECONCILED
  └─ cannot determine -> EFFECT_UNKNOWN
```

`RETRYABLE` 不是最终状态，而是策略判断。恢复器还要重新检查授权、Environment 和当前 Turn 是否仍然允许该动作。`RECONCILED` 也不一定等于原始调用 `COMPLETED`：它表示外部状态已对账，可以安全地把结果补回 Runtime。

## 10. 各 Agent 的设计取舍

### 10.1 Codex：执行记录与取消边界

Codex 的 executed tool call 记录保留调用身份和执行相关 metadata；统一执行管理负责命令运行，任务取消负责中断控制。[^codex-recorder] [^codex-unified] [^codex-abort]

这类结构可以把“模型历史重建”“工具执行状态”和“取消”分开处理。仍需注意：执行记录证明 Runtime 观察到什么，不自动证明任意 shell 副作用具有 exactly-once 语义。

### 10.2 Pi：显式 replay policy

Pi durable harness 的工具恢复逻辑会根据未完成调用和工具策略决定如何注入恢复结果或继续操作；这比盲目重新调用工具更保守。[^pi-tool-recovery]

Pi 的价值在于把 replay policy 放到 harness，而非假设所有底层工具都可重放。代价是每个工具需要定义恢复语义，系统复杂度随工具类型增加。

### 10.3 OpenCode：claim 与 workspace 幂等性分层

OpenCode 的 execution claim 解决运行者协调，workspace driver 解决执行资源和幂等性问题。[^opencode-execution] [^opencode-workspace]

这是一种清晰的责任拆分：Session Runtime 不尝试理解每个业务副作用，而是要求 workspace 或工具层提供足够的对账能力。

### 10.4 Kimi Code：去重与持久化 task state

Kimi Code 的 tool dedupe 防止同一调用身份被重复处理，task persistence 则记录任务在审批、执行和恢复中的状态。[^kimi-dedupe] [^kimi-task]

这一设计适合请求队列化和多任务并发，但去重只在调用身份稳定且第一次结果可取得时有效。若进程在副作用发生前后丢失身份或持久化记录，仍然需要 Environment 对账。

### 10.5 OpenHands：事件轨迹与远程副作用

OpenHands 的 Action/Observation 事件适合表达 Agent 与执行环境的交互，但远程 workspace、服务和 sandbox 的真实副作用需要后端运行时继续确认。[^openhands-events] [^openhands-observation]

事件轨迹可以帮助恢复模型语境，却不应被解释为远程操作已经 exactly-once 完成的证明。

### 10.6 Gemini CLI 与 mini-SWE-agent

Gemini CLI 的 Session loop 和 policy/shell 分层能提供请求级和工具级的控制点；mini-SWE-agent 的默认轨迹则更适合短任务和评估。[^gemini-session] [^gemini-shell] [^mini-default]

两者都说明一个事实：重试能力不是 Agent loop 自然产生的属性，而是需要在持久化、工具协议和 Environment 之间共同定义。

## 11. 机制级解剖：重试到底重试什么

各 Agent 的差异不在于是否有 `retry` 函数，而在于它们是否把“模型请求、工具调用、Environment effect、结果观察”拆成不同的重试对象。

### Codex：以 executed call 记录阻断重复执行

Codex 的 executed-tool-call 记录和 unified execution runtime 将工具调用的身份、执行过程和结果放在 Runtime 侧，而不是完全交给模型历史。[^codex-recorder] [^codex-unified] 取消路径也由任务层统一处理。[^codex-abort]

因此恢复时可以先判断调用是否已被 Runtime 接受，再决定是回放结果、报告中断还是重新执行。它并没有凭一个内存记录保证外部命令 exactly-once：shell 已经产生文件后、记录尚未落盘的窗口仍需 Environment 对账。

### Pi：先恢复协议，再决定是否执行工具

Pi 的工具恢复代码显式区分可安全恢复的 tool operation 与不可盲重放的调用，并通过测试固定这些路径。[^pi-tool-recovery] 这比统一重试更可靠，因为 read-only、幂等写入和任意 shell 的恢复语义不同。

其代价是工具接口需要提供足够的恢复信息；一个没有 replay policy 的扩展工具不能被 harness 安全地自动接管。

### OpenCode：claim 解决重复 worker，不解决重复 effect

OpenCode 的 execution claim 确保同一 Session execution 不会被两个 worker 无条件同时推进，测试还覆盖 owner 丢失后的接管。[^opencode-execution] [^opencode-tests] 但 claim 只回答“谁在跑”，不回答“上一 worker 是否已经让远程 API 创建了资源”。

因此 OpenCode 的正确恢复路径应是 claim 接管后重新观察 workspace/外部资源，再决定是否重试；将 claim 当成业务幂等键会把并发协调误当成副作用去重。

### Kimi Code：调用去重靠稳定身份，任务推进靠持久状态

Kimi Code 的 tool dedupe service 以稳定的工具调用身份判断是否重复，task persistence 保存请求所处阶段。[^kimi-dedupe] [^kimi-task] 这使它能在 prompt/step queue 重试时避免重复消费同一调用。

但去重结果必须可取得：若首次调用已经产生副作用，却在 dedupe 记录写入前崩溃，Runtime 仍只能得到 `effect_unknown`。所以 Kimi 的优势是请求级协议清晰，而非自动消除所有外部不确定性。

### OpenHands：Action/Observation 重放的是交互，不是远端执行

OpenHands 的 Action/Observation 轨迹可以恢复 Agent 对“曾经请求了什么、观察到了什么”的认识。[^openhands-events] [^openhands-observation] 但 sandbox、workspace 和服务端资源位于事件记录之外，必须通过后端再次查询。

这是一种有意的边界：远程执行系统拥有副作用事实，Agent 轨迹只拥有交互事实。它避免把本地日志伪装成 exactly-once 证明，但要求 Environment 提供可查询的 effect identity。

### Gemini CLI 与 mini-SWE-agent：重试粒度偏向整个 loop

Gemini CLI 将 policy、shell 和 Session loop 分开，因而可以在调用前重新判断权限，却未必拥有每个外部 effect 的业务级幂等协议。[^gemini-session] [^gemini-policy] mini-SWE-agent 的 default loop 更接近“追加 observation 后继续模型循环”。[^mini-default]

二者适合短任务的原因正是重试边界简单；一旦执行时间变长，必须把 trajectory 中的调用提升为带 identity、effect status 和对账方法的 operation。

## 12. 设计原则

### 原则一：重放状态，不重放副作用

默认 replay 应只重建 Runtime 状态、消息和恢复决策。工具重新执行必须通过显式 policy gate。

### 原则二：把 call identity 贯穿到 Environment

如果 `call_id` 只存在于内存或聊天消息中，重启后就无法做工具去重。幂等键应尽可能传递到执行器和外部服务。

### 原则三：对账优先于重试

当结果未知时，先观察外部状态。重试是对账失败或确认副作用不存在后的动作。

### 原则四：让工具声明副作用等级

Runtime 不应仅依赖工具名称判断安全性。工具协议至少应声明是否只读、是否可取消、是否幂等、是否支持查询和是否可能产生远端副作用。

### 原则五：恢复决策必须可审计

记录“自动重试了命令”是不够的，还要记录依据、策略版本、检查到的 Environment 状态和最终效果。

### 原则六：Exactly-once 是端到端性质

只有 Runtime、执行器、Environment 和外部服务共同提供幂等或事务语义时，才能讨论效果级 exactly-once。单独在 Agent loop 增加一个去重 Map 不足以实现它。

## 13. 验证方案

### 12.1 确定性本地工具

先实现三个测试工具：

```text
read_counter()        只读并返回计数
write_once(key)       相同 key 只能写入一次
crash_after_effect()  产生副作用后立即终止 worker
```

在以下位置注入进程退出：

- tool call 持久化前；
- effect 执行前；
- effect 完成后、结果持久化前；
- 结果持久化后、Turn 继续前。

重启后记录是否重复写入、是否能识别 unknown、是否重新请求审批，以及模型看到的结果是否与文件系统一致。

### 12.2 远端 API 模拟器

模拟器需要支持：

- 请求到达但响应丢失；
- 相同幂等键重复请求；
- 不同幂等键重复请求；
- 请求超时但资源已创建；
- 查询接口返回最终状态。

这样可以区分 Runtime 的 call dedupe 与业务 API 的 effect idempotency。

### 12.3 可验证断言

```text
same event_id replayed        -> state changes at most once
same call_id recovered        -> tool execution at most once when cached
unknown effect                -> no blind automatic retry
environment changed           -> stale observation is invalidated
recovery decision             -> new auditable event exists
```

本文没有在各 Agent 上统一运行故障注入实验。源码和测试只能证明项目实现了某些记录、去重或 claim 逻辑；不能单独证明生产环境中外部服务的副作用语义。

## 未确认事项

- 各项目工具协议是否对只读、幂等、可取消和远端副作用作了完整机器可读声明，仍需逐项目检查。
- OpenCode workspace driver 的幂等性覆盖范围，以及它能否处理任意 shell 命令，不能泛化推断。
- Pi、Codex 和 Kimi Code 的调用去重记录在存储故障或多进程竞争下的行为，尚未通过统一实验验证。
- 模型 provider 在请求超时后的服务端语义通常不可见，必须依赖 provider request ID 或业务级幂等键。

下一篇将研究 Failure Recovery 与终态收敛：系统如何从中断、崩溃、部分成功和后台任务遗留中形成可解释的最终状态。

## 参考源码

[^pi-tool-recovery]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^opencode-execution]: [OpenCode Session execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-workspace]: [OpenCode Workspace provider idempotency](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^opencode-tests]: [OpenCode claim and recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-unified]: [Codex unified execution manager](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^opencode-shell]: [OpenCode shell result state](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/shell/result.ts#L1-L40)
[^opencode-llm]: [OpenCode LLM message projection](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^pi-env]: [Pi shell output capture and spill](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^openhands-events]: [OpenHands Action and Observation events](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-observation]: [OpenHands observation schema](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/base/observation.ts#L55-L140)
[^gemini-session]: [Gemini CLI SDK stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
