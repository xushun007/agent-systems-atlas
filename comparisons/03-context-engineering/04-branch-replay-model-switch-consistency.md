---
title: Branch、Replay 与模型切换：Context 一致性的最后边界
series: Coding Agent 的 Context：上下文构建、压缩与记忆边界
part: 4
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Branch、Replay 与模型切换：Context 一致性的最后边界

## 结论

当 Session 出现 fork、rollback、resume、重试或模型切换时，Agent 仍然可能被称为“继续工作”，但它使用的 Context 不一定属于同一个执行语义。真正需要保持的不是所有 token 完全相同，而是：历史分支、Environment 事实、工具协议、用户授权和模型能力之间的关系仍然可解释。

本文的核心结论是：**Replay 应重建事实和上下文关系，不能简单重放 prompt 字符串；模型切换应重新解析与新模型相关的请求参数，但不能篡改已发生的历史；fork 应复制可继承事实并建立新的边界，而不是让两个分支共享可变的 Context。**

## 1. 四种“继续”

| 操作 | 实际含义 | 是否应复用原 Context |
| --- | --- | --- |
| continue | 在同一历史和 Environment 上进入下一 Step | 复用有效前缀，重新注入动态事实 |
| resume | 从持久记录恢复 Session | 重建，不复用旧进程内对象 |
| retry | 对同一逻辑请求再次尝试 | 复用意图和固定参数，重新生成请求 |
| replay | 按历史事件重建 Runtime 状态 | 重放记录，不默认重新执行副作用 |
| fork | 从历史边界创建新分支 | 复制规定范围，建立新身份 |
| rollback | 丢弃部分未来历史并回到边界 | 重建 surviving history，清除失效派生状态 |

这些操作都可能让用户看到“继续”，但它们对 Context 的要求不同。特别是 retry 和 replay 的区别：retry 可能再次请求模型或安全工具，replay 的首要目标是恢复状态；若两者都使用“调用模型继续”实现，就容易重复副作用。

## 2. Branch：历史复制与资源复制不是一回事

创建分支时，至少需要决定三件事：

1. 哪些历史消息复制到新分支；
2. 哪些 Environment 资源被共享、复制或重新创建；
3. 哪些模型设置和权限可以继承。

复制历史不等于复制工作区，复制工作区也不等于复制进程。两个分支可以共享同一个只读代码版本，却使用不同的工具权限和模型；也可以共享 Workspace，却必须串行写入；还可以通过 Git worktree 实现文件视图隔离，但仍共享网络和凭据。

因此 Branch context 应包含来源分支、边界位置、Environment 引用和继承策略，而不是只保存一份消息数组。

## 3. Codex：fork、rollback 与 replay-derived Context

Codex `rust-v0.154.0` 在 Session 中记录 fork 来源、fork persistence 和 fork boundary。子线程可以引用或复制父线程历史；启动和首个 Turn 的上下文还会依据 fork 边界形成差异。[^codex-session-fork]

Codex 的 `rollout_reconstruction` 从持久 rollout 反向处理 rollback、compaction 和 world-state items，再按 surviving segment 顺序重建历史。代码中特别区分 context-only segment、被回滚的用户 Turn 和需要重新建立的 world-state baseline。[^codex-reconstruction]

这说明 rollback 不是 `history.pop()`：

- 需要删除失效的模型可见历史；
- 需要恢复正确的上下文 baseline；
- 需要保留仍然有效的 host-owned facts；
- 需要避免把被回滚 Turn 的设置和工具结果带入新请求；
- 需要在持久 rollout 中写入 rollback marker。

对应测试验证了 fork 后启动 Context 与首个 Turn 的差异，以及 rollback 后参考上下文项的恢复。[^codex-fork-test] 这是一种“重放历史语义”，而不是“复用旧 prompt”。

### 3.1 模型切换

Codex 的 Turn construction 会在模型变化时刷新相关 attachment，并为下一次请求重新解析 model-dependent settings。token budget 代码也保留未解析的 prompt 参数，使后续 Turn 或模型切换能够使用新模型默认值。[^codex-model-switch]

这建立了一个重要不变量：已经发生的响应保留原模型 provenance；下一次请求可以根据新模型窗口、reasoning summary 和能力重新组装 Context。若把旧模型的 token limit、工具协议或 response metadata 直接复制到新模型，Context 看似连续，实际上已经不一致。

## 4. Pi：底层 Agent 的状态替换与 durable harness 分支

Pi 底层 Agent 的 model、system prompt、messages 和 tools 是应用可更新的内存状态；循环配置在一次 run 中捕获一组条件。模型字段变化不会自动重写已开始的 provider request，必须通过 loop 的下一次配置读取才生效。[^pi-agent]

Pi v4 harness 进一步把 lane、operation 和 frame 持久化。不同 lane 可以拥有各自的上下文推进，fork 和 restore 通过 storage snapshot、branch tip 和 lane state 重建状态。[^pi-harness]

这两层需要分别评价：底层 Agent 适合单进程应用集成，状态更新直接；durable harness 适合跨操作恢复，代价是必须处理 frame 提交、分支边界和 replay。不能把底层 Agent 的 `messages` 数组 clone 当成完整 fork 语义。

## 5. OpenCode：provider context 与本地 message history

OpenCode v2 的 provider context 允许已完成的 provider compaction 保存原生 replacement window，而不是只保存本地 summary。代码明确区分 canonical replacement、local summary 和 transport continuation。[^opencode-provider-context]

这解决了一个 provider-specific 问题：某些模型服务在压缩后提供 continuation context 或加密内容，Runtime 不应把它当普通 user message 再次序列化。另一方面，模型切换或 provider 变化时，原生上下文可能不可复用，Runtime 必须回到本地 Session message 和 summary 重新构建。

OpenCode 的 model resolver 根据模型能力决定 compaction mode，并提前拒绝 provider compaction 不支持的配置。[^opencode-model-resolver] 这说明 Context 的连续性受模型协议约束，不是 Session 层可以无条件保证的。

### 5.1 Compaction 与 fork 的相互影响

若一个分支从 compaction 之后创建，分支需要继承 replacement window、summary 和 boundary；若 rollback 越过 compaction，Runtime 又需要恢复旧的历史基线。只复制当前数据库中可见的 summary，可能丢失原始分支关系；只复制完整历史，又可能重建出与当前 provider 不兼容的消息格式。

这也是 OpenCode 将 compaction message、provider context、Session message 和 LLM message 分开的原因：不同层需要不同的 replay 规则。

## 6. Gemini CLI：resume 的 transcript 重建

Gemini CLI v0.59.0 的 SDK Session 支持从 resumed data 读取 conversation messages，并调用 client 的 `resumeChat` 重建模型会话；之后的 prompt 会重新创建包含 session ID、transcript、cwd 和 timestamp 的 SessionContext，动态 instructions 也会重新执行。[^gemini-session]

这是一条清晰的 resume 路径：持久 transcript 是输入，client chat 是运行时对象，dynamic instructions 是当前 Context 的派生部分。重新建立 Session 时不应假设旧的内存 client、旧 cwd 或旧工具绑定仍然存在。

它也暴露了限制：如果 transcript 没有保留工具结果的结构化状态、Workspace revision 或外部任务句柄，resume 只能恢复对话表象。模型可能知道曾经执行过测试，却不知道测试进程是否仍然存活。

## 7. Kimi Code：Replayable state 与会话模型

Kimi Code v0.40.0 的 v2 runtime 使用 durable state contribution 和 replayable state key；token counting model 会从 Context 读取 token 状态，并在压缩或重基线时更新状态。[^kimi-replayable]

这里的关键区别是：可 replay 的是状态贡献，不是任意对象。一个 Agent model 通过 durable event 更新 committed state，非 durable event 不能被当作恢复事实。这样可以避免把 UI 状态、临时连接或未提交的模型输出误当成 Session Context。

Kimi 的 subagent mirror run 还记录 child agent 的 model、model source、fork 标志和 context token 状态。[^kimi-subagent] 这意味着子 Agent 的 Context 继承和 token 统计有独立边界；父 Session 不能只把所有消息拼接给 child 就获得可解释的 fork。

## 8. 模型切换的三种影响

模型切换并不只有“调用不同 endpoint”这一变化：

| 影响 | 例子 | 正确处理 |
| --- | --- | --- |
| 窗口变化 | 新模型可容纳更少 token | 重新选择/压缩 Context |
| 协议变化 | tool schema、图像、reasoning 格式不同 | 重新适配消息和能力 |
| 行为变化 | 摘要、工具选择、输出风格不同 | 保留历史 provenance，不改写过去 |

同一 Session 可以切换模型，但每个 Step 应记录实际模型和 Context window。摘要也可能由不同模型生成，恢复时需要知道摘要来源和兼容范围。

模型切换不应默认为新的 Session，也不应被隐藏成普通配置字段。对用户而言仍是连续任务；对 Runtime 而言，它是一次新的请求条件版本。

## 9. Replay 与外部副作用

Context replay 只能恢复模型看到的状态，不自动恢复 Environment effect。若历史中包含：

```text
assistant requested deploy
tool returned timeout
```

replay 可以重新建立这两条消息，但不能据此决定 deploy 是否已经生效。必须读取 tool intent、远程 job、幂等键或 provider status。否则模型恢复后再次发出 deploy，可能产生重复发布。

这与上一专题的 Environment recovery 直接相连：Context replay 是“恢复认知状态”，effect reconciliation 是“恢复外部事实”。两者需要同一个 call ID 或 operation ID 关联，但不应合并。

## 10. 分支之间的 Context 泄漏

分支设计常见的泄漏包括：

- 子分支看到父分支后来产生的 user input；
- rollback 后仍保留被删除 Turn 的工具结果；
- 分支共享可变工具对象，修改一个分支影响另一个；
- 模型切换后沿用旧模型的 system instructions；
- 新 Environment 的文件观察混入旧 Environment；
- provider continuation token 被错误复用于另一个分支。

防止泄漏需要 immutable boundary、source branch/ordinal、Environment revision、model provenance 和 capability version。仅复制消息数组无法覆盖这些字段。

## 11. 可复现验证设计

可以用脚本化模型构造以下测试：

1. 在历史 A 上创建 fork B，向 A 追加消息，确认 B 不可见；
2. 对 A rollback，确认被删除 Turn 的工具结果不进入下一请求；
3. 切换模型，捕获请求并比较窗口、工具 schema 和历史 provenance；
4. 模拟 provider compaction token 不兼容，确认 Runtime 回退本地 history；
5. replay 一个已完成工具和一个 unknown 工具，确认只有可安全重放的动作执行；
6. 修改 Workspace revision，确认旧分支 observation 不被当成当前事实；
7. 重启后恢复 Session，确认不依赖旧进程内的 client、PID 或工具对象。

这些实验可以完全使用 stub provider，但不能测量真实模型对摘要或分支语义的理解。provider context 和 KV cache 的复用还需要真实服务支持。

## 12. 设计原则

### 原则一：Replay 重建关系，不重放字符串

需要重建历史边界、工具配对、Environment 引用、模型 provenance 和事实等级，而不只是复制 prompt 文本。

### 原则二：分支边界必须不可变

创建分支后，父分支的新输入和 Context 派生状态不能悄悄进入子分支；共享资源必须通过显式 Environment policy 管理。

### 原则三：模型切换创建新的请求条件版本

过去的响应保留原模型来源；未来请求重新计算窗口、协议、工具和摘要策略。

### 原则四：Provider continuation 是可选优化，不是唯一历史

provider context 失效、过期或不可迁移时，Runtime 应能从本地事实和 Session history 重建。

### 原则五：认知恢复与副作用恢复分离

恢复模型 Context 不等于恢复外部动作。所有可能产生副作用的 replay 都需要独立的安全合同。

## 13. 结论

Branch、Replay 和模型切换暴露了 Context 的最终一致性边界。Context 不是一串永恒 token，而是由历史、Environment、能力、模型协议和运行状态共同派生的版本化视图。

Codex 通过 fork boundary、rollout reconstruction、history version 和模型相关设置重建分支与切换语义；Pi 区分底层 Agent snapshot 与 durable harness lane/frame；OpenCode 分离本地 summary、provider replacement window 和 LLM message；Gemini CLI 从 transcript 重新建立 client chat 与 dynamic instructions；Kimi Code 以 replayable state contribution 和 child agent metadata 处理可恢复状态。

对优秀 Coding Agent 而言，真正的连续性不是“模型每次都看到同样的 prompt”，而是：当 Context 被压缩、分支、恢复或模型切换后，Agent 仍然知道哪些事实属于哪条历史，哪些观察属于哪个 Environment，哪些动作已经发生，以及哪些动作绝不能盲目重做。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Gemini CLI | `v0.59.0` | `fb0d535af931b27c51e87e5e6ade72905b1e8390` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| Kimi Code | `v0.40.0` | `e27ee60894d714e5844db75da69f29120a2bce43` |

本文完成源码和测试阅读，未运行真实 provider continuation、跨分支执行或模型切换实验。

[^codex-session-fork]: [Codex fork persistence and boundaries](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/session.rs#L620-L735)
[^codex-reconstruction]: [Codex rollout reconstruction](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/rollout_reconstruction.rs#L40-L110)
[^codex-fork-test]: [Codex fork and rollback tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/tests.rs#L3660-L3750)
[^codex-model-switch]: [Codex model-dependent settings](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L110-L160)
[^pi-agent]: [Pi Agent request snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^opencode-provider-context]: [OpenCode provider context](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/provider-context.ts#L1-L55)
[^opencode-model-resolver]: [OpenCode model compaction capability](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/model-resolver.ts#L110-L190)
[^gemini-session]: [Gemini CLI Session resume and context](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^kimi-replayable]: [Kimi replayable state contributions](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/state/stateContribution.ts#L1-L55)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
