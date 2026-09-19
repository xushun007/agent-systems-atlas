---
title: 恢复会话，为什么不等于恢复执行
series: Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型
part: 5
reviewed_at: 2026-09-16
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# 恢复会话，为什么不等于恢复执行

持久化一段对话，只能证明某些记录已经写入；它不能证明崩溃前的工具没有执行，也不能自动重建提供商流、子进程或远程任务。恢复因此有两个不同目标：恢复可见历史，以及决定未完成动作是否可以继续。前者是数据读取问题，后者是执行语义问题。

结论是：**安全恢复的最小单位不是“最后一条消息”，而是带有执行意图、阶段、参数、结果证据和重试策略的操作记录。** 若这些信息不足，恢复只能发布“中断且外部结果未知”，而不应擅自再次调用工具。

## 1. 崩溃窗口

一次工具调用至少存在以下顺序：

```text
intent persisted -> tool started -> external effect -> result persisted -> terminal published
```

进程可能在任一点消失。尤其是“外部 effect 已发生、result 尚未持久化”窗口，重新打开 Session 时从历史看不到结果，但外部世界已经改变。这个事实无法由普通 JSONL replay 推导出来。

| 恢复观察 | 外部动作可能性 | 默认处理 |
| --- | --- | --- |
| 无 intent | 未开始 | 不恢复 |
| intent，无 start | 可能未开始，也可能 start 记录丢失 | 依据工具协议决定，不默认重试 |
| start，无 result | 可能仍在运行、已失败或已生效 | 查询句柄；否则标记未知 |
| result 已提交 | 已有可见结果 | replay 记录，不重复执行 |
| terminal 已提交 | 本次执行已结算 | 不从旧 claim 恢复 |

这些不是数据库隔离级别的替代品，而是 coding agent 必须面对的业务状态。

## 2. Pi v4：恢复是补写终态，不是重新采样

Pi 的 durable harness 将提交的 frame、lane 状态和运行意图分开恢复。`restore` 读取一致的 branch tip、配置和 lane 操作状态，校验 operation ID 与 intent 的完整性；它本身不会自动启动工作。[^pi-restore]

对于孤儿的 assistant generation，`recoverAssistantGeneration` 根据已提交的 frame 重建部分消息，补写一条带有“最新已提交片段、较新的 live output 可能丢失、外部结果未知”语义的恢复消息。它不会再次调用 provider。[^pi-recovery]

工具恢复更严格：只有持久记录和当前工具都声明 `replay: "safe"`，并且该调用未被取消，才会使用持久化参数重放；否则读取 checkpoint，生成 interrupted/unknown outcome，不执行工具。上游测试验证了 safe 工具使用已保存参数且先提交 replay 记录，unsafe 工具不被调用。[^pi-tool-recovery] “safe”是工具作者提供的协议声明，不是 Runtime 对幂等性的数学证明。

这套设计把“恢复可见历史”和“恢复外部动作”拆开：模型生成可以通过补写恢复消息收敛，工具副作用则必须拥有显式的 replay 合同。

## 3. Pi JSONL：事务边界与撕裂尾部

Pi v0.85.1 的 JSONL storage 使用 v4 header、顺序号和提交 transaction。提交前由内存状态准备写入，文件 append 成功后才应用内存状态；打开时只重放完整行。若最后一行没有换行，storage 将其视为 torn tail，保留此前完整前缀并丢弃尾部；换行结束但 JSON 或序号非法的内部行则报错，而不是静默修复。[^pi-jsonl]

这提供了清晰的日志完整性边界：完整行是可回放记录，未完成尾部不是记录。它能避免半个 JSON transaction 污染内存状态，但不解决 append 已经成功、外部动作随后才完成的业务顺序问题，也没有在这层看到 `fsync` 或跨文件副作用事务。

因此，JSONL transaction 可以让“消息、值、lane 状态”等 Runtime 记录成组提交，却不能让“记录工具意图”和“工具修改工作区”自动原子化。工作区回滚、Git checkpoint 或工具级幂等协议仍是另一个层次。

## 4. OpenCode：持久 claim 作为恢复信号

OpenCode v2 在执行开始时将 Started 事件和 session claim 作为写前意图的一部分；正常终态释放 claim，shutdown 中断保留 claim。服务重启后，恢复扫描持久 claim，并为每个 claim 启动一次候选执行。[^opencode-execution] 上游测试覆盖 claim 的建立、释放、保留和启动时恢复。[^opencode-tests]

这里的 claim 主要回答“哪个 Session 在崩溃时有未结算执行”，并不等价于“某个工具动作没有发生”。如果 runner 在提交外部副作用后死亡，恢复 runner 仍需要知道该动作是否可查询、可重试或必须标记未知。claim 是跨进程发现和所有权协调机制，不是外部 effect 的事务锁。

## 5. 事件日志、状态快照与恢复输入

三类持久数据承担不同责任：

| 数据 | 作用 | 缺失时的风险 |
| --- | --- | --- |
| 事件/entry log | 重建用户可见历史和因果顺序 | 结果不可见、审计断裂 |
| 状态快照 | 快速定位当前 branch/lane/config | 需要从全量日志重放，或状态歧义 |
| execution intent/checkpoint | 判断未完成动作与恢复策略 | 误重试、重复副作用、永久悬挂 |

将 trajectory 当作 checkpoint 是危险的。模型文本和工具输出可以构成研究轨迹，却未必记录了“这次调用是否已提交”“参数是否固定”“外部句柄是什么”。只有包含这些信息的记录，才有资格驱动恢复决策。

## 6. 恢复策略的决策表

一个通用恢复器可以按以下顺序工作：

1. 读取并校验持久日志的完整前缀；拒绝中间损坏，不把损坏当作正常终态。
2. 恢复 Session、Turn、lane 和配置的逻辑状态，但不自动开始新的模型请求。
3. 枚举未结算的 execution intent，建立每个动作的恢复候选。
4. 查询仍存活的本地进程或远程句柄；查询失败不等于动作未发生。
5. 仅对明确声明可安全重放、参数已固定且没有取消标记的动作执行 replay。
6. 对其余动作写入终态为 unknown/interrupted，并让上层决定是否需要人工确认。

这个过程将“恢复”变成受策略约束的状态转换，而不是读取最后消息后继续 while 循环。

## 7. 可复现验证

不需要 API key 就能验证存储层的一部分边界：创建 JSONL session，提交一条完整 transaction；随后追加一个无换行的 transaction，重新打开并确认完整前缀保留、尾部未生效；再插入换行结束但非法的中间行，确认 open 报错且原文件未被静默改写。

还可以人为构造“intent 已写、外部文件已修改、result transaction 被截断”的崩溃窗口。重开后应观察到：日志状态仍是 pending/unknown，而外部文件已经变化。这不是对真实工具崩溃的模拟，而是对不可原子边界的最小反例；它证明仅凭日志不能断言副作用不存在。

当前专题没有运行 OpenCode 服务重启、Pi v4 完整 harness 或真实工具进程的故障注入，因此这些部分的结论来自固定版本源码与上游测试。

## 8. 设计原则

持久化设计应把三件事分离：历史可见性、运行所有权和副作用恢复。日志保证可追溯，claim 发现未结算执行，checkpoint/replay 合同决定是否可以再次动作。任何一层都不能代替另一层。

对 coding agent 尤其重要的是保守恢复。重复一次模型请求通常只是成本问题；重复一次删除、提交、发布或数据库写入则可能改变系统状态。因而“未知”不是实现失败的临时字符串，而是恢复协议必须支持的终态。

## 未确认事项

- Pi JSONL 这一层未证明操作系统崩溃下 append 的 fsync durability。
- 尚未运行跨进程抢占、远程句柄查询或真实 workspace rollback。
- OpenCode claim 的恢复语义不等于分布式租约，也不自动提供工具级幂等性。
- 各项目对用户可见的 unknown 状态和人工确认 UI 仍需进一步研究。

[^pi-restore]: [Pi durable harness restore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/restore.ts#L1-L150)
[^pi-recovery]: [Pi assistant generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-tool-recovery]: [Pi tool recovery and replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^pi-jsonl]: [Pi JSONL storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-tests]: [OpenCode claim and recovery tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146)
