# 持久化与恢复：副作用未知状态实验

## 问题

当 Agent Runtime 在工具副作用已经发生、但 `ExecutionFinished` 尚未持久化时崩溃，恢复器能否避免重复执行，并将 operation 收敛到可解释状态？

这个问题不是某个 Agent 的边缘 case。它存在于本地文件写入、shell、远程 API、后台任务和 provider 响应丢失等所有“执行事实与外部效果不在同一事务中”的场景。

## 实验范围

本实验先验证一个与具体模型无关的 Runtime 最小模型，随后作为故障矩阵映射到各 Agent。它不声称复现任一项目的完整实现，也不需要 API Key。

目标覆盖：

- 事件写入前崩溃；
- 副作用发生后、完成事件写入前崩溃；
- worker 丢失后的恢复接管；
- 相同 `call_id` 的去重；
- `effect_unknown` 不被盲目重试；
- 恢复决策产生新的可追踪事实。

## 固定版本与环境

本实验属于通用 Runtime 机制实验，不绑定单一上游项目。

- Atlas 工作树：当前 Git checkout；
- Node.js：运行 `node --version` 记录；
- 脚本：[`probe.mjs`](probe.mjs)；
- 外部模型：不使用；
- 外部网络和真实文件系统副作用：不使用。

各项目源码证据见专题文章 [持久化模型与恢复边界](../../comparisons/05-persistence-recovery/02-persistence-and-recovery-boundaries.md) 和 [Failure Recovery 与终态收敛](../../comparisons/05-persistence-recovery/04-failure-recovery-and-convergence.md)。

## 操作步骤

```bash
node experiments/persistence-recovery/probe.mjs
```

脚本为每个故障点建立独立 Runtime，执行一个带 `call_id` 的写操作，在指定提交点模拟进程崩溃，然后使用新的 worker 恢复。所有事件和 effect 都在内存中实现，便于重复运行和检查状态转换。

## 预期断言

1. 崩溃发生在 effect 前：operation 可以安全进入 `retryable`。
2. 崩溃发生在 effect 后、结果持久化前：operation 必须进入 `effect_unknown`，不能直接再次执行。
3. 恢复器能够通过 effect store 对账，将 unknown 收敛为 `reconciled`。
4. 同一 `call_id` 的恢复不会产生第二个 effect。
5. 每次恢复都会追加 `RecoveryDecision`，不覆盖原始事件。

## 观察与结论

运行脚本后，将 stdout 原样保留在本文件的“实验结果”段，并区分：

- 观察：脚本实际输出的状态和 effect 数量；
- 结论：这些结果对 Runtime 设计意味着什么；
- 未确认事项：真实 Agent、provider 和远程 Environment 尚未被该模型覆盖的部分。

## 实验结果

首次执行结果：

```text
{"crash_point":"before-effect","state_before_recovery":"accepted","recovered_state":"retryable","effects_before_recovery":0,"effects_after_recovery":0,"recovery_decisions":1}
{"crash_point":"after-effect-before-finish","state_before_recovery":"running","recovered_state":"reconciled","effects_before_recovery":1,"effects_after_recovery":1,"recovery_decisions":1}
{"crash_point":"after-finish","state_before_recovery":"completed","recovered_state":"completed","effects_before_recovery":1,"effects_after_recovery":1,"recovery_decisions":1}
```

观察结果：副作用发生后但完成事件缺失时，恢复器通过 effect store 对账为 `reconciled`，没有再次创建 effect；副作用尚未发生时进入 `retryable`；已有完成事件时复用完成结果。三个场景均产生且仅产生一个 `RecoveryDecision`。

结论：只要 Runtime 能够以稳定的 `call_id` 关联事件和副作用，就可以把“执行结果丢失”与“动作尚未执行”分开。这个最小模型支持本文提出的保守策略，但真实 shell 和远程 API 是否能提供同样的 effect 查询能力，需要后续适配器实验验证。

## 未确认事项

- 本实验的 effect store 与事件 store 可以被测试程序同时访问，真实文件系统或远程 API 通常不具备这种可查询性。
- 本实验把 `call_id` 传递给 effect store；任意 shell 命令不一定支持幂等键。
- 本实验的 worker 接管是串行的，尚未验证多个恢复者并发竞争和 fencing。
- 本实验不覆盖 provider 已接受请求但响应丢失的情况。
