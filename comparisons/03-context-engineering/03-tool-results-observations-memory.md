---
title: Tool Result、文件观察与外部记忆：Context 如何保持可用
series: Coding Agent 的 Context：上下文构建、压缩与记忆边界
part: 3
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Tool Result、文件观察与外部记忆：Context 如何保持可用

## 结论

Tool Result 不是工具执行的同义词，而是 Runtime 选择后交给模型的一份观察。它可能被截断、摘要、脱敏、外置或延迟；文件内容、进程状态和远程响应也可能在返回后继续变化。因而，Coding Agent 的 Context 设计必须同时维护三件事：模型需要立即看到什么、完整事实存在哪里、未来如何重新观察。

本文的核心结论是：**高质量 Context 不是把工具输出全部塞进 prompt，而是让每条关键观察具有明确来源、时间、作用范围和重新获取路径。** 输出太大时应外置；输出过期时应重新读取；输出不确定时应标记 unknown；输出中包含高价值事实时，应以结构化 metadata 或持久记录保留，而不能只依靠自然语言摘要。

## 1. Tool Result 的真实结构

一个工具调用至少产生四类数据：

```text
Tool Call
  ├── intent: 模型请求了什么
  ├── execution: Runtime 实际执行了什么
  ├── observation: Runtime 观察到了什么
  └── effect: Environment 发生了什么变化
```

这四者不一定相同。模型可能请求 `run_tests`，Runtime 实际调用一个包装器；工具输出可能只包含 stdout 摘要；Workspace 可能被修改；远程服务可能已经接受请求但尚未返回最终状态。

如果 Context 只保存 observation，模型会失去 execution 和 effect 的部分语义。如果只保存完整 stdout，又会造成 token 爆炸，且 stdout 未必能证明 effect。一个可靠的 Tool Result 应当能关联：工具名、call ID、参数摘要、Environment 引用、退出状态、输出存储位置、截断状态和副作用状态。

## 2. Observation 的四个质量维度

### 2.1 完整性

观察是否包含足以支持下一步决策的内容。编译日志被截断后，末尾错误通常比开头的成功信息更重要；测试结果需要保留失败名称和退出状态，而不是只保留“命令执行完成”。

### 2.2 新鲜度

观察何时产生、针对哪个 cwd、哪个进程和哪个 Workspace revision。旧文件片段在另一个 Agent 修改文件后不能继续被当成当前状态。

### 2.3 权威性

退出码、结构化测试报告、工具返回文本和模型猜测具有不同可信度。模型自己写出的“已修复”不能覆盖工具报告的测试失败。

### 2.4 可获取性

被截断或外置的内容能否通过路径、artifact ID、日志文件或查询句柄再次获取。外置但没有引用的输出等价于丢失。

## 3. Codex：截断输出与 retained tool metadata 分离

Codex `rust-v0.154.0` 的 context manager 对 function output payload 使用专门的 truncation policy；这说明单条工具结果的体积控制独立于完整 compaction。[^codex-history]

Codex 还维护 executed tool call 的 retained metadata，并限制保留的完整参数字节数；当结果过多时，系统保留必要的调用关联和 omission 信息，而不是无限保留所有参数。相关测试验证了边界下最近调用仍可识别，并报告被省略的内容。[^codex-tool-recorder]

这个设计区分了两种价值：

- 大体积输出是模型观察，适合裁剪或外置；
- 调用 ID、工具名、参数摘要和完成状态是 Runtime 关联事实，需要较稳定地保留。

Codex 的 history 还要求成对的 tool call 与 tool output 关联；外部工具事件可以独立命名。这样可以避免压缩或截断后留下一个无法解释的 tool result。[^codex-history-pairing]

更深一层的设计是 retained context 与模型窗口分离。即使旧消息不再进入当前 prompt，一些 host-owned facts 和授权相关信息仍然可以被保留或重新注入。它把“模型需要看到的文本”与“Runtime 需要知道的事实”分开。

## 4. Pi：输出 capture、spill 与 Environment observation

Pi v0.85.1 的 `NodeExecutionEnv` 在 shell 执行时收集 stdout/stderr，并对输出进行 capture；输出过大时可以写入 spill 文件，避免把完整内容都保留在内存或模型消息中。工具结果还会携带 capture 的可用信息和错误状态。[^pi-env]

spill 机制解决的是传输和内存问题，不自动解决 Context 选择问题。Runtime 仍需决定：模型立即看到多少，后续是否可以用路径读取完整日志，摘要是否包含失败位置，日志文件是否属于当前 Workspace 或临时 Environment。

若 spill 文件只存在于短生命周期的本地临时目录，Session 恢复后它可能已经不存在。因此，外置观察需要持久性等级：

| 等级 | 例子 | 恢复能力 |
| --- | --- | --- |
| inline | 直接放入模型消息 | 依赖历史保存 |
| process-local | 本地临时 spill | 进程结束可能丢失 |
| workspace-local | 项目日志文件 | 随 workspace 保留，但可能被修改 |
| session-persistent | Session artifact store | 可跨重启引用 |
| remote durable | 云日志或 provider record | 需远程凭据和查询协议 |

模型看到“日志已写入某文件”并不等于它一定能访问该文件；路径必须相对于正确的 Environment，并且具备相应权限。

## 5. OpenCode：shell capture、message projection 与文件变化

OpenCode v2 的 shell result 显式记录 output、truncated、exit 和 timeout 等状态。[^opencode-shell]

这比只返回字符串更有价值，因为 `truncated: true` 会改变模型对结果完整性的判断。一个被截断的测试日志不能被模型当成“没有其他错误”；一个 timeout 也不能被折叠成普通 non-zero exit。

OpenCode 还将 Session 内部 message 转换为 provider 所需的 LLM message；文件路径变化、compaction 和工具结果在不同表示中可能具有不同结构。[^opencode-llm]

这种多投影架构要求每个投影保留语义：

```text
execution result -> persisted session message -> LLM message -> UI event
```

UI 可以显示折叠后的工具输出，LLM 可以看到截断后的摘要，数据库则应保留状态和引用。若只优化某个投影而删除源事实，就会破坏恢复和诊断。

## 6. OpenHands：Observation 是事件类型，不只是文本

OpenHands v1.15.0 的 agent-server 事件模型将 ActionEvent 和 ObservationEvent 分开，并按环境、agent、消息等来源区分事件。Observation 结构包含工具输出、命令和文件路径等字段；文件编辑、终端输出和浏览器动作都可以形成不同的 observation 类型。[^openhands-events]

这种事件模型具有两个重要作用：

1. 前端可以按事件类型展示、聚合和失效缓存；
2. Runtime 可以区分“模型请求了动作”和“Environment 返回了观察”。

文件编辑 observation 还可以关联路径，前端据此刷新 file changes、file diff 等缓存。[^openhands-cache]

这说明观察不仅服务模型，也服务 UI 和后续 Runtime。若只把它格式化成一段文本，界面无法准确判断哪个文件变化，恢复器也无法区分一次 edit 与一次 bash。

## 7. Gemini CLI：工具结果与 Session transcript

Gemini CLI v0.59.0 的 SDK Session 以 transcript 延续对话，并在 `sendMessage` 流程中使用 SessionContext 绑定 session ID、cwd、timestamp 和动态 instructions。工具调用事件和模型响应通过 Session stream 对外暴露。[^gemini-session]

这种设计使 Tool Result 可以同时成为三类消费者的输入：下一次模型请求、Session transcript 和客户端事件流。三者的需求不完全相同：模型需要简洁可行动的观察，transcript 需要可恢复的历史，客户端需要实时进度和错误状态。

如果三者共享同一份未经裁剪的输出，会造成 token 和 UI 负担；如果三者完全独立，又会出现用户看到的结果与模型上下文不一致。因此需要定义 canonical result，再为每个消费者生成投影。

## 8. 文件观察不是文件状态

Coding Agent 经常通过 `read_file`、`grep`、`git diff` 和测试结果形成对 Workspace 的理解。这些都是 observations，不是锁定的文件版本。

一个文件观察至少应包括：

- 逻辑路径和解析后的绝对位置；
- Workspace/Environment identity；
- 读取时间或 revision；
- 读取方式和范围；
- 是否完整、是否截断；
- 后续是否发生写入。

若没有 revision，模型可能在读取 A 后、另一个进程写入 B 后继续依据 A 修改文件。Runtime 可以通过串行化、文件锁、Git revision 或写入前重新读取降低风险，但扩大 Context 并不能解决并发修改。

### 8.1 diff 是高价值但有边界的观察

diff 比完整文件更节省 Context，并能直接表达修改范围。但 diff 依赖基线：工作树相对哪个 commit、哪个 parent 或哪个 snapshot？没有基线的 diff 无法作为恢复凭据。

此外，未跟踪文件、生成文件、二进制文件和外部数据库变化可能不出现在 Git diff 中。模型看到“diff clean”不应自动得出 Environment clean。

## 9. 外部记忆的几种形态

当结果不能全部放进 Context 时，Runtime 通常采用以下外部记忆：

| 形式 | 适合内容 | 模型如何使用 |
| --- | --- | --- |
| 文件 artifact | 长日志、报告、补丁 | 通过路径再次读取 |
| 结构化 store | 任务、测试、权限、执行状态 | 由 Runtime 注入或工具查询 |
| 向量/检索索引 | 大量历史代码和文档 | 主动检索，需核对来源 |
| Session database | 消息、事件、token、compaction | Context Builder 选择 |
| 远程 handle | sandbox、进程、部署任务 | 查询状态或发送控制命令 |

外部记忆不是自动等于模型记忆。只有当 Context 提供获取路径、查询工具或结构化注入时，模型才可能使用它；索引召回也必须保留文件路径、版本和相关性证据。

## 10. 结果投影与事实等级

建议将 Tool Result 拆成 canonical record 和 model projection：

```text
CanonicalToolRecord
  ├── call_id / tool / args
  ├── environment / revision
  ├── status / exit / timeout
  ├── output reference + inline excerpt
  ├── effect classification
  └── replay / recovery policy
             ↓
       Model Projection
```

Model projection 可以只包含错误摘要和 artifact 路径，但 canonical record 要保留恢复和审计所需字段。模型输出“看起来成功”不能覆盖 canonical status `timeout`；摘要中的“已完成”不能覆盖 effect `unknown`。

## 11. 输出截断的策略问题

截断至少有三种策略：

1. 头部保留：保留命令和初始环境信息；
2. 尾部保留：保留最终错误和退出结果；
3. 头尾保留加外置：兼顾语义和可获取性。

测试日志通常更需要尾部，编译命令和版本信息更需要头部，补丁和结构化 JSON 则可能需要完整 artifact。统一的字符数截断会损害不同工具的语义。

因此输出策略应按工具和内容类型配置，并在结果中显式标记 `truncated`、原始大小和 artifact 引用。没有这些 metadata，模型无法判断“没有出现错误”还是“错误被截断”。

## 12. 观察污染与提示注入

工具输出来自 Environment，可能包含仓库文件中的恶意文本、外部网页内容或命令生成的提示。把它原样放入 Context 会让模型难以区分“数据”与“新指令”。

这不是要求删除所有文本，而是要求保持来源和角色边界：工具结果应作为 observation，文件内容应标明为数据，外部网页应带不可信来源。摘要器也不能把 observation 中的指令提升为系统规则。

Context Builder 还应防止超大输出制造 token denial-of-service；Codex 的输出截断、Pi 的 spill 和 OpenCode 的 truncated flag 都体现了把输出体积作为 Runtime 责任处理的方向。[^codex-history] [^pi-env] [^opencode-shell]

## 13. 可复现验证设计

不需要 API key，可以用脚本化工具产生以下观察：

1. 返回小输出、大输出和包含错误的大输出，比较截断策略；
2. 将完整输出外置，确认模型投影保留 artifact 引用；
3. 在模型读取文件后由另一个进程修改文件，验证 revision/新鲜度语义；
4. 让工具返回 timeout、partial 和 unknown 状态，确认它们没有被统一成 failure；
5. 检查历史、UI 事件和下一次模型请求是否使用一致的 canonical call ID；
6. 重启进程后验证 process-local spill 是否仍可获取；
7. 对包含指令的文件内容确认其仍被当作 observation，而不是高优先级指令。

评估指标不只是“模型能否回答问题”，还应包括：来源是否可追踪、截断是否可发现、过期观察是否可识别、外置内容是否可重新获取，以及恢复器是否能从 canonical record 做出正确判断。

## 14. 设计原则

### 原则一：Observation 必须可定位

每条重要观察都应能关联 call、Environment、路径、revision、时间或远程句柄。

### 原则二：立即可见与完整可恢复分离

模型不需要看到全部日志，但 Runtime 必须保留足够的 artifact 或结构化记录。

### 原则三：截断必须显式可知

结果被截断、超时或部分完成时，状态必须进入模型投影和持久记录。

### 原则四：canonical record 优先于自然语言摘要

摘要服务模型，结构化记录服务审计、恢复和跨投影一致性。

### 原则五：重新观察比长期相信旧观察更可靠

文件、进程和远程状态会变化。Context 应保留重新读取或查询的路径，而不是无限延长旧事实的有效期。

## 15. 结论

Tool Result 是 Environment 的部分观察，不是执行事实的全部。文件内容、命令输出、测试结果、远程响应和后台状态都需要来源、时间、范围和可获取性。高质量 Agent Runtime 会把 canonical execution record、model projection、UI projection 和恢复输入分层，而不是让一段字符串同时承担所有责任。

Codex 将大输出 truncation 与 retained tool metadata 分开；Pi 以 capture、spill 和本地 Environment 支撑结果外置；OpenCode 显式记录 shell output 的 truncated/timeout 状态并维护多种消息投影；OpenHands 将 Action 与 Observation 建模为不同事件；Gemini CLI 将工具事件、transcript 和 SessionContext 连接起来；mini-SWE-agent 则提供最小 action/observation 基线。

对模型而言，Context 越大不一定越好。真正重要的是：模型能看到足够做出下一步决策的观察，Runtime 能保留完整事实，恢复器能在观察缺失或过期时重新取得证据。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Gemini CLI | `v0.59.0` | `fb0d535af931b27c51e87e5e6ade72905b1e8390` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| Kimi Code | `v0.40.0` | `e27ee60894d714e5844db75da69f29120a2bce43` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文完成源码和相关测试阅读，未运行真实 provider、超大工具输出、跨进程文件竞争或远程 artifact 恢复实验。

[^codex-history]: [Codex history output processing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L330-L420)
[^codex-tool-recorder]: [Codex executed tool call retention](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-history-pairing]: [Codex history tool-call pairing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L690-L725)
[^pi-env]: [Pi shell output capture and spill](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-shell]: [OpenCode shell result](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/shell/result.ts#L1-L40)
[^opencode-llm]: [OpenCode Session messages to LLM messages](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-cache]: [OpenHands workspace observation cache invalidation](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/utils/cache-utils.ts#L1-L50)
[^gemini-session]: [Gemini CLI Session transcript and context](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
