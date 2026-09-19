---
title: Tool Result、流式执行与失败语义
series: Coding Agent 的 Tool Invocation：从能力声明到外部副作用
part: 3
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Tool Result、流式执行与失败语义

## 结论

工具执行不是等待后返回字符串的黑盒。它可能持续产生增量输出、启动多个并行动作、在超时后仍等待外部资源、在取消后返回迟到结果，或者已经产生副作用却没有来得及提交最终状态。

本篇的核心结论是：**输出流、执行状态、外部副作用和持久结果必须分别建模；事件顺序必须有身份和阶段语义；工具失败不能自动等同于动作未发生。**

## 1. 四条并行时间线

一次 Tool Invocation 同时推进四条时间线：

~~~
model call:     requested ──────────────── result projected
execution:      prepared ─ running ─────── settled
output:         update ─ update ─────────── final
effect:         none ─ started ─ partial ─ confirmed/unknown
~~~

它们可能不同步：

- 最终文本已经生成，但子进程仍未退出；
- 工具 promise 已 reject，但文件已经写入；
- UI 收到 timeout，远程任务仍然运行；
- 一个并行工具已完成，另一个仍在写入 Workspace；
- tool end 已发布，但外部服务的异步任务尚未完成。

因此，tool end 只能表达 Runtime 的调用阶段，不应被解释为 Environment 已经稳定。

## 2. Streaming 的价值和风险

增量更新主要服务用户进度、日志展示和取消/backpressure。它们通常不应作为独立历史事实逐条注入模型；更适合聚合为一次 canonical Tool Result，并保存最终状态和必要的中间证据。

| 类型 | 语义 | 是否是最终事实 |
| --- | --- | --- |
| update | 当前观察片段 | 否，除非明确持久化 |
| partial | 已知但未完成的结果 | 是一种中间终态 |
| final | 工具报告完成或失败 | 仍需结合 effect 状态 |
| late | 终态之后抵达的结果 | 不能覆盖既有终态 |

一个 update 包含“编译通过”并不代表全部测试结束；final 文本包含“done”也不代表远程部署已确认。

## 3. Pi：Update callback、取消和并行工具

Pi v0.85.1 的执行函数向工具传入 update callback，并在工具完成后等待相关 update 处理，再形成执行结果。工具异常会被转换为错误结果，但取消 signal 不会强制任意工具 promise 立即结束。[^pi-execute]

这是一种合作式流式协议：

~~~
tool.execute(..., signal, onUpdate)
       ├── onUpdate(...)*
       └── Promise<Result>
~~~

工具实现必须尊重 signal 和 update 生命周期。Runtime 可以在接受结果后停止处理迟到更新，但不能撤销已经发生的文件、网络或进程动作。

Pi 的 sequential 模式在一个工具结束后再准备下一个；parallel 模式先准备工具，再并发执行。并发聚合可以保持调用数组顺序，但工具的实际完成顺序可能不同。[^pi-parallel]

因此模型 Context 需要同时保留 call index 和 completion status。按数组顺序展示结果，不能让 Runtime 假设副作用按相同顺序发生。

## 4. OpenCode：truncated、timeout 与消息投影

OpenCode v2 的 shell result 显式记录 output、truncated、exit 和 timeout。[^opencode-shell]

这使模型和恢复器可以区分：

- 观察是否完整；
- 进程是否在期限内正常结束；
- 进程是否返回非零状态；
- 是否只是拿到了部分输出。

OpenCode 再把内部 Session message 转换成 LLM message。UI 可以折叠日志，模型可以只看到尾部错误和 artifact 路径，数据库则应保留原始状态和大小；三者不必展示相同内容，但必须共享 call ID 和终态。[^opencode-llm]

## 5. Gemini CLI：流式 Session 与工具调度

Gemini CLI v0.59.0 的 SDK Session 通过 send stream 暴露模型和工具循环，直到模型不再请求工具并产生最终响应。工具请求被收集和调度，再将结果送回下一次模型上下文。[^gemini-session]

用户可以在工具执行时看到进度，但下一次模型请求不应把每一条 progress update 当作独立事实。工具完成、失败或部分结果应被聚合后再形成模型可见消息。

如果流在工具结果返回前中断，Session transcript 需要保留“call 已发出但 result 未到达”的状态。否则 resume 时模型可能认为调用从未发生并重复执行。

## 6. OpenHands：Action/Observation 事件顺序

OpenHands v1.15.0 将 ActionEvent 和 ObservationEvent 作为不同事件类型，并用 action ID、tool name、observation 类型和输出字段关联一次执行。[^openhands-events] 终端 observation 可以表达命令、输出和错误；文件编辑 observation 可以表达路径和修改结果。[^openhands-observation]

事件链可以表示为：

~~~
ActionEvent(call_id)
       ↓
agent-server / environment
       ↓
ObservationEvent(call_id)
       ├── UI projection
       ├── transcript projection
       └── next model context
~~~

断线时可能只收到 ActionEvent。恢复时必须判断 observation 是否可以重新获取，而不能将“没有收到 observation”当作“没有执行”。

## 7. Codex：工具 metadata 与取消收敛

Codex 的 executed tool call recorder 保留工具调用 metadata，并对完整参数字节数施加上限；超出范围时仍维持必要的调用关联和 omission 语义。[^codex-recorder]

Codex 任务取消先传播 cooperative token，等待短暂的 graceful interruption，之后才 abort task；已发出的工具或统一执行进程需要独立处理。[^codex-abort]

取消后的结果至少可能处于三种状态：

1. Runtime 已阻止新的工具调用；
2. 当前 Tool Future 已被中断；
3. 外部进程或远程动作状态仍未知。

将第二项直接当成第三项的否定是错误的。一个被 Runtime abort 的任务可能已经向文件或服务发送了请求。

## 8. Kimi Code：重复调用与失效调用

Kimi Code v0.40.0 的 v2 Runtime 通过 tool dedupe 检测同一工具和参数在同一步或跨步骤重复出现，并可在达到阈值时提醒、重试或停止。[^kimi-dedupe]

dedupe 是控制模型循环的机制，不是外部 effect 去重协议。它能识别模型反复提出相同调用，不能证明第一次调用已经失败，也不能安全判断第二次调用一定不应发生。

Kimi 工具还可能在执行时发现 Runtime 已变化并要求重新发起调用；这种返回是 stale/retry 语义，不应被当作普通业务失败。[^kimi-glob]

## 9. 失败语义矩阵

| 观察到的情况 | Runtime 状态 | 对模型的建议 | 对恢复器的建议 |
| --- | --- | --- | --- |
| 参数解析失败 | invalid | 修正参数 | 不重做 effect |
| 权限拒绝 | rejected | 解释授权边界 | 不重试，除非重新审批 |
| 工具未找到 | unavailable | 选择其他能力 | 不执行 fallback |
| 超时但进程未知 | timeout/unknown | 先查询状态 | 不盲目重试 |
| 合作式取消 | interrupted | 说明可能部分完成 | 查询或标记 unknown |
| 输出截断 | partial observation | 提供 artifact 路径 | 保留完整记录 |
| 明确非零退出 | failed | 呈现错误和输出 | 是否重试取决于工具语义 |
| 结果已确认 | succeeded | 进入下一决策 | 不重复执行 |

将所有非零退出码都写成 failed，会让恢复器错误重试 timeout 或 partial 动作；将用户拒绝写成工具错误，则会破坏下一次模型请求对授权的理解。

## 10. 并行执行和共享资源

并行工具调用需要同时处理调度顺序、完成顺序和 Context 顺序。若两个工具修改同一 Workspace，Runtime 必须决定是否串行化、锁定、使用 worktree 或允许最后写入覆盖。

即使工具只读，也可能依赖同一个后台服务或缓存。一个工具重启服务，另一个工具读取服务状态，完成顺序就会影响观察。

因此“支持 parallel”至少要说明：

- 准备是否顺序进行；
- 审批是否可以并发；
- 执行是否共享 Environment；
- 结果是否按 call order 进入 Context；
- 一个失败是否取消其他调用；
- 外部 effect 是否可以独立结算。

没有这些定义，parallel 只是并发 promise，不是可靠的并发模型。

## 11. 迟到结果与终态不可覆盖

当工具已经进入 completed、failed 或 interrupted，迟到 update 或 result 不应悄悄覆盖终态。每个 result commit 都应检查 call generation、Turn/Step identity 和当前 operation 状态。

迟到结果可以作为 evidence 保存，但不能改变用户已经看到的最终语义，除非系统提供显式 correction event。

## 12. 可复现验证设计

无需 API key，可以使用脚本化模型和受控工具验证：

1. 连续发送 update，随后返回 final，检查 update/final 顺序；
2. 发送 update 后取消，确认迟到 update 不覆盖 interrupted；
3. 并行工具以相反顺序完成，比较事件顺序和 Context 结果顺序；
4. 超时但后台 child 仍存在，确认 timeout 不被写成 completed；
5. 输出超过限制，确认 truncated 标志和 artifact 引用存在；
6. Tool Result 在终态之后到达，确认被标为 late/stale；
7. 一个工具失败而另一个工具已经产生 effect，确认整体 Turn 不会抹掉部分结果。

实验需要记录 call ID、Step ID、Environment revision、event sequence、effect marker 和持久提交顺序。只检查模型最终文字，无法验证流式和失败语义。

## 13. 设计原则

### 原则一：流式 update 不是最终事实

增量输出服务实时体验，最终状态和 effect evidence 需要独立提交。

### 原则二：状态和文本分离

timeout、truncated、partial、unknown 和 rejected 等状态不能依靠模型从自然语言中猜测。

### 原则三：并行必须定义资源语义

promise 并发不等于 Environment 并发安全。共享 Workspace、进程、缓存和远程服务需要明确协调。

### 原则四：迟到结果只能补充证据

终态提交后，迟到消息应被识别为 stale 或 late，不能无条件改写历史。

### 原则五：失败不等于无副作用

所有 timeout、interrupt、partial 和 process abort 都要考虑外部 effect 已发生的可能。

## 14. 结论

Tool Result 的可靠性取决于 Runtime 是否能够把流式输出、执行状态、外部副作用和持久记录分开。Pi 提供 update callback、顺序/并行执行和 signal 协议；OpenCode 显式记录 truncated、timeout 和 exit；Gemini CLI 将流式 Session 与工具调度结合；OpenHands 以 Action/Observation 事件建立跨进程关联；Codex 保留工具 metadata 并通过 task cancellation 收敛；Kimi Code 通过 dedupe 和 runtime stale guard 控制重复和失效调用。

对用户而言，最重要的不是看到更多日志，而是知道当前动作处于准备、执行、部分完成、失败、取消还是未知状态。对恢复器而言，最重要的不是收到一个字符串，而是获得带身份、顺序、来源和 effect 语义的 canonical result。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | rust-v0.154.0 | 6b9826e3aa83b1a5947db50f4332cb9c65f1b340 |
| Pi | v0.85.1 | d981de1229ef899957bbe968bc8dcda02a21f477 |
| Gemini CLI | v0.59.0 | fb0d535af931b27c51e87e5e6ade72905b1e8390 |
| OpenCode | v2.0.0 | 63f7ceecbed2d7d9a627518d935dd963b9d4ac9f |
| OpenHands | v1.15.0 | ab23be62ad724fe83483036a0900bed7b7859166 |
| Kimi Code | v0.40.0 | e27ee60894d714e5844db75da69f29120a2bce43 |
| mini-SWE-agent | 当前研究版本 | 38c01a19ed1a58dd17dd7c95010e4f69d059c777 |

本文完成源码和相关测试阅读，未运行真实 provider stream、远程工具、并发 Workspace 或跨进程故障实验。

[^pi-execute]: [Pi streaming tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-parallel]: [Pi sequential and parallel tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L430-L565)
[^codex-recorder]: [Codex executed tool call retention](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-abort]: [Codex task cancellation](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990)
[^gemini-session]: [Gemini CLI SDK stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^opencode-shell]: [OpenCode shell result state](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/shell/result.ts#L1-L40)
[^opencode-llm]: [OpenCode LLM message projection](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^openhands-events]: [OpenHands action and observation events](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-observation]: [OpenHands observation schema](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/base/observation.ts#L55-L140)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-glob]: [Kimi runtime stale guard](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts#L90-L135)
