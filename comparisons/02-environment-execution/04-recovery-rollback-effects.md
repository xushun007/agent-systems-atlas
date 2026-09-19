---
title: Environment 的恢复、回滚与副作用一致性
series: Coding Agent 的 Environment：执行世界的抽象、控制与恢复
part: 4
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Environment 的恢复、回滚与副作用一致性

## 结论

Coding Agent 的“恢复”至少有四个不同目标：恢复用户可见历史、恢复 Workspace 文件、恢复仍然存在的执行资源、恢复未完成动作的业务语义。它们的状态来源、可用证据和失败处理都不同。把它们统一称为 resume，会在崩溃、断线或取消后制造错误的确定性。

本文的核心结论是：**Environment 恢复不是从最后一条消息继续模型循环，而是根据持久化证据重新建立资源关系，并对未完成副作用做保守的 reconciliation。** 能回滚 Git 文件，不代表能撤销网络请求；能恢复 Session，不代表能恢复远程进程；能重新调用工具，也不代表再次调用是安全的。

## 1. 四类恢复目标

| 目标 | 恢复的对象 | 典型证据 | 主要风险 |
| --- | --- | --- | --- |
| 历史恢复 | Session、Turn、消息、事件 | event log、branch tip | 历史缺项或顺序错误 |
| 文件恢复 | Workspace、Git worktree、快照 | diff、commit、snapshot | 外部状态未回滚 |
| 执行恢复 | 进程、PTY、容器、远程 sandbox | PID、handle、claim、provider ID | 双重 owner 或孤儿资源 |
| 动作恢复 | 未完成 tool call、部署、写入 | intent、参数、result、replay policy | 重复副作用 |

这四类恢复可能在不同服务中完成。一个客户端可以先恢复聊天记录，再等待远程 sandbox 启动；一个 runner 可以恢复 claim，却只能把工具结果标记为 unknown；一个 Git worktree 可以恢复到某个提交，但无法撤销已经发送的 HTTP 请求。

## 2. 崩溃窗口决定恢复语义

一次外部动作至少有如下阶段：

```text
intent persisted
       ↓
resource acquired
       ↓
action started
       ↓
external effect happened
       ↓
result persisted
       ↓
terminal published
```

进程可能在任意箭头之间退出。尤其危险的是：`external effect happened` 已经发生，而 `result persisted` 尚未发生。重启后的日志会认为动作没有结果，但外部世界已经被改变。

这说明“最后一条持久消息”不是充分的恢复输入。恢复器还需要知道动作意图、固定参数、资源句柄、取消标记、结果提交状态和是否允许 replay。

### 2.1 Unknown 是必要终态

当 Runtime 不能确认外部动作是否生效时，最诚实的状态是 `unknown`，而不是自动归类为 failure 或 success。

- 记为 failure 可能导致恢复器重复执行已经成功的动作；
- 记为 success 可能让用户误以为结果已确认；
- 记为 cancelled 可能掩盖取消到达时动作已经提交。

`unknown` 并不表示 Runtime 无法继续工作，而是要求后续动作先查询、人工确认或使用幂等键。它是副作用协议的一部分。

## 3. Pi：持久日志、lane 恢复与 replay 合同

Pi v0.85.1 的 durable harness 将 Session 恢复与执行恢复拆开。`restore` 读取持久化 branch tips、配置和 lane state，验证 operation 的 ID、intent 和结构完整性；恢复完成后只是建立可继续使用的 Runtime 状态，并不会因为存在未完成 operation 就盲目发起新的 provider 请求。[^pi-restore]

### 3.1 Assistant generation 的恢复

对于未完成的 assistant generation，Pi 根据已提交 frames 重建最后可见的部分消息，再写入恢复消息。恢复消息会表达：已提交片段是什么、较新的 live output 可能丢失、外部结果未知。恢复器不重新调用 provider。[^pi-generation]

这是一种保守的历史收敛策略。模型输出本身通常不产生直接副作用，重新采样会带来重复成本和不同结果；将最后已知状态明确标记出来，比伪造一个完整 assistant message 更可审计。

### 3.2 Tool replay 的恢复

Pi 对工具调用采用更严格的判断：只有取消状态允许 replay，持久记录和当前工具都声明 `replay: "safe"`，并且参数可以从 checkpoint 重建时，才执行重放；否则读取 checkpoint 并生成 interrupted/unknown outcome，不调用工具。[^pi-tool-recovery]

这里的 `safe` 是能力协议，不是 Runtime 对业务幂等性的证明。一个工具作者声称“safe”，仍可能因为外部服务实现、参数变化或隐藏副作用而不安全。因此高风险工具还需要幂等键、远程查询或人工确认。

Pi 的测试还验证 replay commit 先于 tool start，并使用持久化参数而不是重新从当前模型上下文提取参数。这个顺序避免恢复过程中先产生副作用、后记录“正在重放”的事实。[^pi-tool-test]

## 4. Pi JSONL：文件完整性不是副作用原子性

Pi 的 JSONL storage 对提交 transaction 提供了明确的文件边界。完整行才进入 replay；最后一条无换行的 torn tail 会被丢弃；换行结束但内部非法的行会导致 open 报错，而不是被静默删除。[^pi-jsonl]

这一机制解决两个问题：

1. 不完整的 JSON transaction 不会污染内存状态；
2. 损坏的内部记录不会被伪装成正常历史。

它没有解决另一个问题：工具已经修改 Workspace，而记录工具结果的 transaction 还没有写入。文件日志和 Workspace 文件属于两个存储系统，除非另有事务协议，否则无法自动原子提交。

因此，下列顺序仍然可能发生：

```text
append tool intent
write source file
process crashes before append tool result
```

重启时 JSONL 能准确告诉 Runtime“结果记录缺失”，但不能从日志推出文件写入没有发生。恢复器必须把它当作未确认动作处理。

## 5. OpenCode：claim 发现未结算执行

OpenCode v2 的 SessionExecution 在 Execution.Started 提交时建立持久 claim；正常成功、失败和用户/非 shutdown 中断会释放 claim；shutdown interruption 保留 claim，使下一次服务启动可以发现没有终态的执行。[^opencode-execution]

这个协议解决的是“哪个 Session 需要被恢复”，而不是“动作是否已经发生”。claim 类似一个持久的未结算标记或恢复候选，不是 Workspace 事务锁，也不是外部服务幂等键。

OpenCode 同时区分 `awaitSettlement` 与 `awaitIdle`。前者等待被中断执行的结算，后者等待当前进程不再拥有 Session 执行。新输入可能在清理期间进入，因此即使一次旧执行已经 settlement，Session 仍可能立即拥有新的工作。[^opencode-execution]

上游测试覆盖了启动时扫描 claim、每个 claim 的恢复启动和用户中断释放 claim 的行为。测试能够证明恢复候选的发现和 process-local ownership 语义，不能证明工具外部副作用已经被恢复器查询或撤销。[^opencode-tests]

## 6. OpenHands：Git 恢复与 Cloud sandbox 生命周期

OpenHands v1.15.0 将 Conversation workspace、Git worktree 和 Cloud sandbox 作为不同层次的资源。child conversation 创建新 worktree 时，Git 提交历史决定是否可以建立分支视图；Cloud sandbox 则需要异步 provision、连接和 resume。[^openhands-child]

这意味着恢复一个 OpenHands Conversation 可能包含三个独立动作：

1. 重新加载 Conversation 历史；
2. 找到或重建它的 `working_dir`/worktree；
3. 恢复或重新建立 agent-server 与 Cloud sandbox 的连接。

如果第 1 步成功而第 3 步失败，用户仍然可以看到历史，但不能据此认为 Agent 仍在原 Environment 中。若 worktree 创建失败并 fallback 到 shared workspace，恢复后的资源边界也可能已经改变，必须通过记录或 UI 明示。

## 7. Codex：Rollout 记录与 Environment 之外的资源

Codex 的 Turn 中断路径会先记录 interrupted marker，并尝试 flush rollout，再发布 `TurnAborted`；代码注释说明客户端可能在收到 abort 事件后同步重新读取 rollout。flush 失败时实现记录 warning 并继续发布事件，因此这里是一个优先保证事件顺序的 best-effort durability 设计。[^codex-abort]

Codex 的统一执行管理器还保存后台 terminal 信息，并提供列出、终止和关闭进程的接口。它可以为本地进程恢复或清理提供入口，但进程记录不等于文件快照，也不等于远程服务状态。[^codex-unified]

这体现出两个恢复边界：Rollout 负责会话/Turn 的历史连续性，统一执行管理器负责进程资源；二者需要通过 Turn、call 或 process ID 关联，但不能用一个对象替代另一个对象。

## 8. Git checkpoint 能恢复什么

Git checkpoint 适合恢复版本化文件状态，尤其适用于模型反复编辑、测试失败回退和 child worktree 隔离。它不天然覆盖：

- 未跟踪但被删除的临时文件（除非另行纳入）；
- 数据库写入；
- 包发布、部署和外部 API 调用；
- 后台进程的内存状态；
- 远程 sandbox 的挂载和网络状态；
- 凭据使用产生的审计或计费记录。

所以“回滚”应带有 scope：`workspace rollback`、`git rollback`、`container layer rollback` 和 `external action compensation` 是不同操作。没有 scope 的 rollback 只会制造虚假的安全感。

## 9. 恢复决策表

恢复器可以先构造每个未完成动作的证据表：

| 证据 | 恢复动作 |
| --- | --- |
| 只有模型生成，无外部动作 | 补写中断终态，不重新采样 |
| intent 有固定参数，工具声明 safe replay，未取消 | 记录 replay commit 后重放 |
| intent 有参数但工具不 safe | 标记 unknown，查询或请求确认 |
| 已有 result commit | 只重放记录，不重复工具 |
| 有 remote handle | 先查询资源状态，再决定接管或结束 |
| Workspace 有 checkpoint，外部副作用未知 | 可回滚文件，但保留 unknown effect |
| claim 存在但 owner 仍存活 | 不立即抢占，先确认租约/连接 |

这张表的目标不是规定所有项目必须采用同样流程，而是避免恢复器只看“有没有最后一条 assistant message”。

## 10. 恢复中的双重执行风险

跨进程恢复最危险的错误是两个 runner 同时认为自己拥有同一 Environment。常见触发方式包括：旧进程只是网络断开但仍继续执行、claim 写入成功但 provider binding 尚未完成、恢复器启动后旧进程迟到提交结果。

解决这类问题需要 owner epoch、lease、fencing token 或 provider-side idempotency，而不仅是一个 boolean claim。新 owner 提交结果时，应能证明自己拥有当前版本的执行权；旧 owner 的迟到结果必须被拒绝或标记为 stale。

本文研究的项目中，OpenCode 的 claim 和 Pi 的 durable operation 分别提供了不同程度的持久身份；它们是恢复基础，但不能据此声称已经建立完整的分布式 fencing。Codex 的本地 task cancellation 也不能替代跨进程租约。

## 11. 可复现验证设计

不需要 API key，可以验证本地存储和恢复边界：

1. 写入完整 Session/operation intent；
2. 修改一个 workspace 文件；
3. 在 result transaction 前人为截断日志；
4. 重新打开存储，确认日志缺失 result 但文件变化仍在；
5. 对 safe 和 unsafe 两类工具分别检查是否 replay；
6. 模拟一个仍存活的 owner，确认恢复器不会直接启动第二个 owner；
7. 记录回滚 Git 文件后，外部副作用仍保持 unknown。

这个实验能证明“日志与外部 effect 不是自动原子”的逻辑边界，不代表操作系统断电、真实容器崩溃或云资源回收已经被覆盖。真实故障注入还需要控制子进程、网络和 provider 服务。

## 12. 设计原则

### 原则一：恢复先恢复身份，再恢复动作

先恢复 Session、Environment、owner 和资源 handle，再决定是否继续动作。直接从最后一条消息开始循环，会跳过最重要的执行归属判断。

### 原则二：重放必须有明确合同

Replay 需要固定参数、可判定的安全声明、结果提交顺序和失败处理。没有合同的自动重试，本质上是在猜测外部世界。

### 原则三：回滚必须标注范围

用户和 Runtime 都需要知道回滚覆盖文件、Git、容器还是远程副作用。局部回滚成功时，其他未覆盖的 effect 仍应保留为事实。

### 原则四：连接断开不等于资源终止

远程连接、PTY、sandbox 和 provider request 的状态必须分离。无法观察不代表不存在，也不代表已经完成。

### 原则五：保守状态优于虚假终态

在无法确认外部结果时，`unknown` 能阻止错误的自动重试和错误的成功提示。它应进入历史、恢复器和用户交互，而不是只存在于 debug log。

## 13. 结论

Environment 恢复的本质，是重新建立“历史—资源—动作—副作用”的关系。Session log 能恢复可见历史，Git checkpoint 能恢复部分文件，claim 能发现未结算执行，handle 能重新连接资源，replay policy 才能决定是否再次执行；任何单一机制都不能覆盖全部恢复语义。

Pi 对 assistant generation 和 tool replay 采用保守分支，OpenCode 以持久 claim 发现恢复候选，OpenHands 把 Conversation、worktree 和 Cloud sandbox 的恢复分开，Codex 将 rollout flush 与统一进程管理分层，mini-SWE-agent 则把环境恢复能力留给可替换后端。这些取舍反映了不同的产品定位，但共同指向同一条原则：

> 恢复不是把 Agent 带回最后一次对话，而是让 Runtime 在不确定的外部世界中重新取得可证明的执行位置。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文基于固定版本源码和上游测试阅读，未运行真实 provider、容器崩溃、跨进程 fencing 或 Cloud sandbox 恢复实验。

[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^pi-generation]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-tool-recovery]: [Pi tool replay recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^pi-tool-test]: [Pi durable tool recovery tests](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/harness/runtime/drive-tools.test.ts#L421-L480)
[^pi-jsonl]: [Pi JSONL storage recovery boundary](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^opencode-execution]: [OpenCode Session execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-tests]: [OpenCode execution recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
[^openhands-child]: [OpenHands child workspace and sandbox lifecycle](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/services/child-conversation-launch.ts#L253-L430)
[^codex-abort]: [Codex interrupted rollout handling](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^codex-unified]: [Codex unified execution process manager](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
