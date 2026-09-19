---
title: Context Compaction：摘要、信息损失与事实保留
series: Coding Agent 的 Context：上下文构建、压缩与记忆边界
part: 2
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Context Compaction：摘要、信息损失与事实保留

## 结论

Context compaction 不是简单删除旧消息，也不是把整段历史交给模型总结后替换原文。它是一次对模型可见历史的重写，必须同时处理 token 预算、事实保留、工具调用完整性、分支关系、权限状态和恢复证据。

安全的压缩设计需要明确区分：

- 原始历史是否仍然保留；
- 模型下一次请求看到什么；
- 摘要由哪个模型、基于哪些消息生成；
- 摘要中的陈述是否具备事实来源；
- 被删除的工具结果是否可以重新获取；
- 压缩期间是否允许新的输入或工具继续推进。

Codex、Pi、Gemini CLI 和 OpenCode 的实现表明，Context compaction 正从“超过窗口时截断文本”演进为 Runtime 的状态迁移。压缩后的摘要只是新的模型输入视图；它不能成为唯一事实源，也不能自动携带原始工具副作用的确定性。

## 1. 为什么压缩是架构问题

模型上下文窗口有限，但 Coding Agent 的运行历史可能无限增长：用户要求、模型计划、工具调用、编译日志、测试结果、文件片段、审批、错误和后台任务都会累积。单纯保留最近 N 条消息会丢失长期约束；单纯保留完整历史又可能超过窗口。

压缩因此改变了 Runtime 的一个重要不变量：模型下一次请求不再能直接看到所有先前消息。之后模型对项目的理解，取决于摘要、保留尾部和可以重新读取的 Environment 事实。

可以把压缩写成：

```text
H_full  --select/summarize/retain-->  H_model
  |                                      |
  +---------- durable source -----------+
```

`H_full` 是完整历史，`H_model` 是当前模型可见历史。两者只有在上下文足够短时才可能相同。压缩器必须保存二者之间的映射，否则无法解释某条事实是原始记录、摘要推断还是当前环境重新观察。

## 2. 压缩发生在哪个边界

常见触发点有三种：

| 触发点 | 优点 | 风险 |
| --- | --- | --- |
| 请求前 | 不发送超窗请求，预算可控 | 需要预估 token，可能过早压缩 |
| 请求失败后 | 依据真实 provider 错误处理 | 首次请求失败，代价和延迟更高 |
| Turn/Step 之间 | 不打断工具动作 | 仍可能在长工具结果后超窗 |

压缩还可以由用户主动触发、由 provider 执行，或由 Runtime 本地生成。触发方式不同，都会影响摘要的权威性和可恢复性。Provider-side compaction 可能返回原生 continuation token 或 encrypted summary；本地 compaction 则能够直接访问 Session history、Environment metadata 和工具记录。

## 3. 必须保留的事实类别

摘要不能只追求“工作进展的自然语言概述”。对 Coding Agent 而言，至少需要考虑：

1. 用户明确提出且仍然有效的约束；
2. 当前任务目标与已完成/未完成部分；
3. 文件修改、测试结果和失败原因；
4. 尚未结算的工具调用、进程和远程任务；
5. 当前 Workspace、分支和 Environment 引用；
6. 审批、拒绝、权限和信任范围；
7. 不应重复执行的外部动作；
8. 可以重新读取或验证的事实来源。

其中第 4、6、7 项经常被普通摘要遗漏，却直接关系到安全和恢复。摘要写着“部署已完成”与持久记录中存在一个未确认的 deploy call，二者的执行语义完全不同。

## 4. Codex：压缩作为历史重写与上下文窗口迁移

Codex `rust-v0.154.0` 的 context manager 为 history 保存 `history_version`，并将 compaction、rollback 等历史重写视为版本变化。它保留 `retained_context`、world state baseline、参考上下文项和面向 prompt/内部消费者的不同读取路径。[^codex-history]

Codex Session 还维护 auto-compact window 的编号和窗口 ID。压缩后的 `CompactedItem` 可以携带 replacement history、compaction response metadata、latest token usage、Guardian history checkpoint 和 retained context。[^codex-compacted]

这不是把旧消息物理删除后插入一段 summary，而是为模型历史建立新的窗口和替换关系。测试覆盖了 live compaction 与恢复历史重建一致、compaction checkpoint 恢复以及 rollback 后 reference context item 的恢复。[^codex-compaction-tests]

设计含义有三点：

- compaction 是可追踪的历史转换，而不是不可见的字符串替换；
- authorization 和 host-owned facts 不应随模型历史压缩而丢失；
- window ID 使多次压缩能够被区分，避免把不同模型上下文误当成同一段历史。

Codex 的代码还区分输出 payload truncation 与 compaction。工具输出太大时可以按 policy 截断；这不等价于一次完整历史摘要。前者处理单条结果的体积，后者重写多个消息之间的关系。[^codex-history]

## 5. Pi：durable frame、summary 与恢复边界

Pi v0.85.1 的 durable harness 以 frame 和 operation 记录运行过程。恢复时可以基于已提交 frames 重建 assistant generation；这与将旧对话摘要交给模型重新生成不同。[^pi-recovery]

如果 Pi 的运行时产生 compaction 或 summary，它需要同时保留 operation、lane 和 checkpoint 关系，才能在摘要后继续判断哪些工具动作已经完成。工具恢复逻辑只对 replay-safe 条件满足的动作重放，说明摘要不能单独决定恢复策略。[^pi-tool-recovery]

Pi JSONL storage 的 transaction 和 torn-tail 处理还提供了持久层的边界：完整提交记录可以 replay，未完成尾部不会成为事实。摘要或 compaction 只有在自身作为完整 commit 写入后，才可以成为后续恢复的输入。[^pi-jsonl]

## 6. OpenCode：本地摘要与 provider compaction 的双路径

OpenCode v2 的 SessionCompaction 支持本地 compaction，也支持 provider compaction。模型能力描述中可以标记 provider compaction 的 mode；model resolver 会在配置不支持时提前拒绝错误组合。[^opencode-model-resolver]

本地 compaction 生成结构化 summary，并以 compaction message 写入 Session；LLM message 转换时明确告诉模型，这是一段早期 conversation 的 summary 和 serialized record，应作为历史上下文而不是新指令处理。[^opencode-compaction] [^opencode-llm]

这个提示非常关键。摘要是由模型或 Runtime 生成的文本，若直接作为普通 user/developer message 注入，模型可能把历史陈述当成当前指令，造成权威等级变化。将其封装为 compaction message 并在转换阶段标注语义，是对摘要信任边界的显式处理。

OpenCode 还将 compaction 的 started、ended、failed 事件写入消息更新器和 Session projector，并持久化摘要 token、文件统计和状态。这样用户可以看到压缩过程，恢复器也能区分 running、completed 和 failed，而不是把压缩中途退出当成普通历史。[^opencode-updater]

## 7. Gemini CLI：Session transcript 与动态 instructions 的压缩问题

Gemini CLI v0.59.0 的 SDK Session 以 transcript 维持会话，并在每次 prompt 时构造包含 session ID、transcript、cwd 和 timestamp 的 SessionContext；dynamic instructions 也可以根据当前 Context 刷新。[^gemini-session]

这类设计将压缩责任置于 transcript 管理和 instructions 构建之间。若 transcript 被裁剪，而动态 instructions 仍然能够从当前 Session/Environment 重新生成，系统可以恢复一部分环境事实；但用户约束和工具结果若只存在于 transcript，就必须有额外保留策略。

Gemini 的 Session 测试验证了 resume transcript 和 system instruction refresh 的接口行为，但不应从中推出摘要内容在所有 CLI 模式下都不会丢失。上下文压缩的质量仍需要对真实长会话进行针对性测试。

## 8. 摘要不是事实数据库

摘要常见的错误不是遗漏一句话，而是改变事实状态。例如：

```text
原始记录：测试命令启动，进程在超时后被杀，结果未知
错误摘要：测试已失败
```

“失败”可能诱使 Agent 修改代码并重新运行；“未知”则要求先查询测试进程或重新确认输出。两者对后续动作的授权完全不同。

因此摘要中的陈述最好携带事实类型：

| 类型 | 示例 | 后续处理 |
| --- | --- | --- |
| confirmed | 文件已提交到 commit X | 可作为历史事实使用 |
| observed | 命令输出显示 test passed | 适用范围受环境和时间限制 |
| inferred | 推测失败原因是依赖版本 | 不能当作已确认原因 |
| pending | 部署请求已发送，响应未知 | 查询或人工确认 |
| superseded | 旧 cwd 已被迁移替代 | 不作为当前环境依据 |

自然语言摘要可以表达这些信息，但 Runtime 必须保留结构化来源或 checkpoint，不能把语义责任完全交给模型措辞。

## 9. 压缩与用户输入、审批和取消

压缩不是无并发的后台维护任务。它可能与用户追加输入、审批响应、中断和模型切换同时发生。至少需要定义：

1. 压缩开始后，新输入进入旧历史还是新窗口；
2. 压缩请求是否可以被取消；
3. 压缩完成前，后续工具是否继续运行；
4. 压缩失败时是否恢复原历史；
5. 用户看到的 summary 是否已经成为模型下一次请求的事实。

Codex 的 window ID、history version 和 compaction checkpoint 为这些问题提供了版本边界；OpenCode 的 compaction message 状态则提供了可观察的运行状态。其他轻量 Agent 若只在数组上做原地替换，很难保证输入和压缩之间的顺序。

## 10. 信息损失的四种类型

### 10.1 内容损失

原始日志、代码片段或错误输出没有进入摘要。可以通过保留文件路径、命令、错误模式和重新获取链接降低风险。

### 10.2 关系损失

摘要保留了“修改了 A”和“测试失败”，却丢失二者的因果关系。Coding Agent 可能错误地认为测试失败来自另一项改动。

### 10.3 权威损失

用户要求、工具事实和模型推测被写成相同语气，导致模型无法判断哪一条可以覆盖哪一条。

### 10.4 时间损失

旧 Environment observation 被当成当前状态。没有 Step、workspace revision 或观察时间，模型会把历史文件内容当成现状。

压缩评估不能只测摘要字数；应测压缩后是否仍能回答关键事实、是否会重复外部动作、是否能正确识别当前 Environment。

## 11. 压缩策略比较

| 策略 | 保留方式 | 适用场景 | 主要代价 |
| --- | --- | --- | --- |
| tail retention | 保留最近消息 | 短任务、低复杂度循环 | 丢长期约束 |
| model summary | 旧消息生成摘要 | 长期对话 | 摘要幻觉和事实合并 |
| structured state | 保留任务、文件、测试、权限字段 | coding runtime | 需要维护 schema |
| external references | 外置日志、文件、diff、查询句柄 | 大型输出和远程任务 | 模型还需主动读取 |
| provider compaction | 由模型服务管理窗口 | 支持原生 continuation | Runtime 可见性较弱 |
| hybrid | 摘要 + tail + structured checkpoint | 长生命周期 Agent | 实现和测试复杂 |

主流 Coding Agent 正趋向 hybrid。单纯 summary 对交互自然，但对工具副作用和恢复不够；单纯结构化状态可靠，但需要模型具备读取和解释这些状态的能力。

## 12. 可复现验证设计

可以用脚本化模型构造一条长轨迹，包含：长期用户约束、多个文件修改、一个失败测试、一个审批拒绝、一个尚未确认的后台动作和一段超大日志。然后触发 compaction，比较压缩前后的模型请求。

必须验证：

- 长期约束是否保留；
- 文件和测试因果是否保留；
- 拒绝过的动作是否被误表示为允许；
- unknown 动作是否被错误摘要为成功；
- 当前 cwd 和 Workspace revision 是否更新；
- 被截断的输出是否仍有重新获取路径；
- compaction 失败时原始 history 是否可用。

实验不需要 API key，只需替代模型适配层；但若要评估摘要质量，必须同时运行真实模型，并由人工或结构化 oracle 判定事实保真。KV cache 和 provider compaction 仍需要实际 provider 验证。

## 13. 设计原则

### 原则一：压缩改变模型视图，不改变唯一事实源

原始历史、工具证据和执行记录应保留。摘要是可替换的派生视图。

### 原则二：摘要必须保留行动相关事实

长期约束、未完成动作、权限决定、Workspace 身份和外部 effect 状态比一般性的“工作进展”更重要。

### 原则三：摘要需要标注事实等级

confirmed、observed、inferred、pending 和 superseded 不应被压成同一种无来源文本。

### 原则四：压缩要有版本和事务边界

history version、window ID、compaction status 和 checkpoint 使压缩可审计、可重试、可恢复。

### 原则五：保留重新观察路径

当文件、进程或远程状态无法完整保留时，摘要应留下路径、句柄或查询方式，而不是只留下结论。

## 14. 结论

Compaction 是 Context Runtime 的状态迁移，不是 token 超限后的文本清理。它必须处理模型可见历史、持久事实、环境观察、权限状态和未完成动作之间的映射。

Codex 将 compaction 作为带窗口版本、replacement history 和 retained context 的历史重写；Pi 通过 durable frame 和 replay policy 将摘要与恢复分开；OpenCode 同时支持本地和 provider compaction，并把摘要包装为历史记录；Gemini CLI 将 transcript 与 dynamic instructions 分层；其他轻量 Agent 则通常需要由外层补足结构化状态和恢复能力。

真正优秀的压缩不是让摘要“写得像人”，而是让压缩后的 Context 仍能支持正确的下一步决策，并且在发生争议时可以回到原始事实和 Environment 观察。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Gemini CLI | `v0.59.0` | `fb0d535af931b27c51e87e5e6ade72905b1e8390` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |

本文完成源码和相关测试阅读，未运行真实 provider 摘要、长上下文实验或 KV cache 测量。

[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L67-L105)
[^codex-compacted]: [Codex compacted history persistence](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3771-L3835)
[^codex-compaction-tests]: [Codex compaction and rollback tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/tests.rs#L2173-L2245)
[^pi-recovery]: [Pi durable assistant recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^pi-tool-recovery]: [Pi tool replay policy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^pi-jsonl]: [Pi JSONL transaction storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L230-L290)
[^opencode-model-resolver]: [OpenCode provider compaction capability](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/model-resolver.ts#L110-L190)
[^opencode-compaction]: [OpenCode SessionCompaction](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/compaction.ts#L680-L783)
[^opencode-llm]: [OpenCode compaction to LLM message](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L270-L295)
[^opencode-updater]: [OpenCode compaction message lifecycle](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/message-updater.ts#L390-L460)
[^gemini-session]: [Gemini CLI Session and dynamic instructions](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
