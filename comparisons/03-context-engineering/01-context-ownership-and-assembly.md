---
title: Coding Agent 的 Context：上下文构成、所有权与请求组装
series: Coding Agent 的 Context：上下文构建、压缩与记忆边界
part: 1
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Context：上下文构成、所有权与请求组装

## 结论

Context 不是 Session 历史的别名，也不是把所有可获得的信息拼接成一个 prompt。它是 Runtime 针对一次模型请求，从多个状态源中选择、转换、截断和排序后形成的**模型可见输入**。

一个成熟的 Coding Agent 至少同时维护三种状态：

1. 完整历史：用于审计、恢复和后续选择；
2. 当前运行状态：用于表达最新环境、权限、工具和执行进度；
3. 请求上下文：用于满足当前模型调用的 token、格式和能力约束。

三者可以相互生成，但不等价。完整历史可能超出模型窗口，当前 Workspace 状态可能尚未被读取，模型上下文可能包含由 Runtime 派生的摘要、工具 schema 和项目指令。Agent 的表现，很大程度上取决于这条派生链是否稳定、及时并且能够保留真正决定下一步行动的事实。

本文提出一个统一模型：

```text
Persistent History + Live Runtime State + Environment Observations
                           ↓
                    Context Selection
                           ↓
                    Prompt Assembly
                           ↓
                     Model Request
                           ↓
              Tool Calls / New Observations
                           ↓
                    History Update
```

这不是单向流水线。工具结果会改变历史和环境，下一次请求又会重新选择上下文；压缩会改变模型可见历史，但不应未经声明地改变 Session 的事实记录。本文先建立横向研究所需的边界，压缩、工具观察和 replay 将在后续文章单独展开。

## 1. Context 的严格定义

本文将一次模型请求的 Context 定义为：

```text
Context(r) = Assemble(
  HistorySelection(r),
  RuntimeFacts(r),
  EnvironmentObservations(r),
  CapabilityDescription(r),
  InstructionLayers(r),
  ModelConstraints(r)
)
```

其中 `r` 是具体请求，而不是整个 Turn。请求之间可能共享历史前缀，但每个请求都可能因为新工具结果、新用户输入、模型窗口或权限变化而形成不同 Context。

### 1.1 Context 不是信息总和

将所有信息放入 prompt 具有三个问题：

- token 成本随着历史线性增长；
- 旧信息可能与当前 Environment 冲突；
- 重要事实会被大量低价值输出淹没。

Context 的工作不是最大化信息量，而是在有限窗口内最大化对当前决策有用、可信且可定位的信息。一个经过压缩的 Context 可能比完整历史短很多，但如果丢失了环境约束、待完成动作和用户不可违反的要求，模型表现会明显下降。

### 1.2 Context 与 KV cache

模型服务通常会对请求前缀进行缓存，但 KV cache 不是 Runtime 的事实存储。前缀是否稳定，取决于 system instruction、工具 schema、历史前缀和序列化方式是否保持一致；动态工具、时间戳、环境状态或每次变化的提示会使后缀甚至前缀失去复用机会。

因此，Context 设计有一个实际取舍：把高频变化信息放在靠后的位置可以减少稳定前缀被破坏，但可能削弱模型对这些信息的注意；把权限和环境变化写入固定系统段可以提高显著性，却增加 cache miss。这个取舍需要用实际 provider 的请求和 cache 统计验证，不能从源码中的 prompt 拼接逻辑直接推出命中率。

## 2. 六类上下文来源

| 来源 | 主要内容 | 典型所有者 | 变化频率 |
| --- | --- | --- | --- |
| 用户历史 | user/assistant/tool message、审批反馈 | Session/历史存储 | 高 |
| Runtime 事实 | 当前 Turn、pending input、模型设置、错误状态 | Session/Turn runtime | 高 |
| Environment 观察 | 文件、Git diff、进程、命令输出、远程状态 | Environment/工具 | 高 |
| 能力描述 | 工具 schema、MCP、skills、可用资源 | capability plane | 中高 |
| 指令层 | system prompt、项目规则、目录级指令 | 配置/Workspace | 中 |
| 模型约束 | context window、输入模态、provider 格式 | model adapter | 低到中 |

这些来源不应被同样处理。用户明确要求和组织策略通常需要保留；大段编译日志适合摘要或外置；文件内容应带路径和观察时间；工具 schema 需要与实际执行能力匹配；模型约束必须在组装前参与裁剪。

### 2.1 历史是事实来源，不是最终 prompt

历史记录应保存发生过的事件及其归属，而 Context Builder 决定哪些事件进入下一次请求。历史中可以存在被取消的工具调用、失败的尝试和后来已经失效的 Environment 观察；它们不一定应原样重放给模型。

相反，某些 Runtime 派生事实不一定以普通消息存在，例如当前模型允许的工具、有效工作目录、管理授权或等待中的操作。若只从聊天消息重建 Context，模型会看到叙述，却看不到当前执行条件。

### 2.2 Environment observation 必须带来源

“当前文件内容”是一种观察，不是永恒事实。Context 中的文件片段至少应关联路径、读取动作和适用环境。命令输出同样应知道来自哪个 cwd、哪个进程和哪一次调用。

这对多 Agent 和后台任务尤其重要：如果两个执行者共享 Workspace，一个旧 observation 可能已经被另一个进程覆盖。把它作为无来源的自然语言粘回 prompt，会让模型误判当前代码状态。

### 2.3 能力描述与能力事实不同

工具 schema 告诉模型“可以请求什么”，但不保证当前请求真的能执行。权限、Environment、provider 和实时策略可能在 tool call 阶段再次约束。Context Builder 应避免把动态能力写成永久事实；至少需要让模型知道限制发生在哪个层次。

## 3. Context 的时间边界

Context 至少有三个时间点：

```text
history selected -> request assembled -> action executed
```

在 history selected 时，Runtime 选择已有事实；在 request assembled 时，模型输入被固定；在 action executed 时，工具可能观察到更新后的外部环境。模型看到的文件列表可能早于工具真正写入的文件，审批策略也可能在动作执行前重新验证。

这解释了一个常见现象：Context “正确”不等于动作“正确”。模型可能基于请求时的旧文件观察作出合理决策，而外部进程在工具执行前修改了文件。要提供更强保证，需要在工具激活前重新读取或锁定资源，而不是只扩大 prompt。

## 4. Codex：历史管理与请求级 Context 分层

Codex `rust-v0.154.0` 的 context manager 明确区分 parent model history、bounded host-owned context facts、retained context、world state 和 history version。其历史对象提供面向 prompt 的转换，同时保留供内部消费者使用的 annotated history。[^codex-history]

几个设计细节值得注意：

1. history version 在 compaction 或 rollback 等重写时递增；
2. user-input/reset revision 与 compaction generation 分开；
3. world state 有最近追加到模型历史的快照和 baseline；
4. 工具输出会按 policy 做 payload truncation；
5. `for_prompt` 与带 metadata 的内部读取路径分开。

这说明 Codex 没有把“持久 transcript”“模型可见历史”和“主机拥有的上下文事实”合并成一个字符串。`StepContext` 还在请求层绑定模型设置、MCP、ToolRouter、环境选择和 `AGENTS.md`，形成一次请求的完整执行条件。[^codex-step]

其设计含义是：压缩和 rollback 改变的是模型历史表示，但应保留足够的 retained context 和授权事实，避免模型历史重写改变 Turn 的权限语义。这也是 Context 作为 Runtime 派生视图而非唯一事实源的典型实现。

## 5. Pi：Context snapshot 与 Agent loop 的局部边界

Pi v0.85.1 底层 Agent 在循环开始时通过 `createContextSnapshot()` 复制 system prompt、messages 和 tools 的顶层数组；每次模型调用从当前循环配置生成 Context。steer 和 follow-up 的区别不只是消息类型，而是它们分别在当前工具推进和下一次模型请求之间进入 Context。[^pi-agent] [^pi-loop]

这种设计较轻：Agent 状态、循环配置和消息列表距离很近，扩展应用可以直接注入 system prompt、tools 和 hooks。代价是 Context 的持久化、压缩和 Environment 事实不由这个底层 Agent 自动完成。Pi v4 durable harness 才进一步引入 lane、operation、frame、restore 和持久化派生视图。

因此研究 Pi 时必须区分：底层 Agent 的 Context 是一次 loop 的内存快照，v4 harness 的 Context 是结合持久 frames、lane state 和恢复逻辑形成的 durable runtime 输入。不能用其中一层的能力描述整个 Pi。

## 6. Gemini CLI：Session transcript 与动态 instructions

Gemini CLI v0.59.0 的 SDK Session 持有会话 transcript，并在发送 prompt 时构造 `SessionContext`，其中包括 session ID、transcript、cwd 和时间戳；动态 instructions 可以在请求阶段刷新，工具也通过 bind context 获得 SessionContext。[^gemini-session]

这里的关键不是“有没有 history 数组”，而是动态 instructions 与 transcript 的责任不同：transcript 提供对话延续，instructions 由当前 Session/Environment 重新计算。若 cwd、IDE 状态或扩展信息改变，instructions 可以刷新而不必伪造一条用户消息。

这种结构适合 CLI 产品和 SDK 复用，但也带来一个一致性问题：动态 instructions 的刷新时机必须与模型请求、工具执行和 Session resume 对齐。Gemini 的测试验证了 SessionContext 和 client system instruction refresh，但不等于证明所有 CLI 扩展和实际文件观察都具备相同的原子边界。[^gemini-session-test]

## 7. OpenCode：Session runner 的消息转换与 Context 管理

OpenCode v2 将 Session 存储、Inbox、Runner、compaction 和 `to-llm-message` 分层。Session message 不是直接等同于 provider message；runner 会根据消息类型、位置变化、工具结果和模型格式转换为 LLM 可接受的输入。工作目录变化会被显式渲染为模型可见消息，说明 Environment 变化需要进入 Context，而不是只修改服务端字段。[^opencode-context]

OpenCode 的工具责任边界还要求工具叶节点处理资源解析、权限和副作用顺序；Context 中的工具定义不能替代这些执行时判断。[^opencode-tools]

这类分层的优点是 provider 适配和 Session 历史可以独立演进；缺点是需要维护多种表示之间的映射。一个 tool result 在数据库 event、Session message、LLM message 和 UI 事件中的字段若不一致，就可能出现“用户看到已完成，模型看不到结果”或“恢复器重复提交”的问题。

## 8. OpenHands：Conversation history 与 workspace observation

OpenHands v1.15.0 的 Conversation、agent-server 和 Workspace API 分离。前端可以读取 conversation history，也可以通过 workspace 文件 API 查看当前 `working_dir`；agent-server 还向运行中的 Agent 提供 sandbox、服务 URL、workspace 和 session key 等执行信息。[^openhands-adapter]

这类架构强调 Context 不只来自聊天记录。Workspace 观察、远程服务地址和 sandbox 状态需要以运行时信息进入 Agent；否则模型只知道用户说过什么，不知道当前环境是否已经 provision、哪个目录是有效的或哪些服务可达。

同时，前端历史和 agent-server 内部上下文不是同一存储。网络断线、sandbox paused 或后端重启后，UI 可能保留历史而 agent-server 需要重新建立执行上下文。这正是“Session history 可恢复”与“Context 可继续执行”之间的差异。

## 9. Kimi Code：Context 物化与请求边界

Kimi Code v0.40.0 的 v2 loop 将 StepRequest 排队、出队和 materialize 分开；请求物化时追加 context 并形成模型层输入。[^kimi-materialize]

这个设计将 Context Builder 放在请求真正进入 loop 的边界，而不是在用户提交时一次性生成。这样可以让排队请求等待期间继续获得适用的上下文，但也要求明确哪些字段在物化时读取、哪些字段在排队时固定。用户输入、权限和 Workspace 迁移如果没有对应的版本标记，重排队或恢复时就会产生语义漂移。

## 10. mini-SWE-agent：最小历史与显式 observation

mini-SWE-agent 的默认 Agent loop 以 query、action 和 observation 推进 trajectory。它的优势是 Context 结构直观：模型看到历史交互和最新执行结果，Environment 负责执行 action。[^mini-default]

但 trajectory 不自动等于 durable Context。工具输出可能被截断，Environment 可能在每个 action 使用新的 subshell，文件系统状态也可能发生外部变化。若需要恢复、压缩或多 Agent 协作，就必须额外记录 observation 来源、Environment identity 和 action 结果语义。

这体现了一个重要取舍：最小 loop 可以降低状态漂移和实现成本，但把 Context 选择、事实保留和恢复责任交给应用层。复杂 Runtime 的价值，正是在这些责任需要长期运行时被显式化之后出现。

## 11. Context 质量的五个判据

### 11.1 相关性

上下文是否包含完成当前动作所需的信息，而不是单纯保留更多历史。最近的工具输出通常相关，但旧用户约束、项目规则和未完成任务也可能比最近的一段日志更重要。

### 11.2 新鲜度

文件、进程和网络观察是否仍适用于当前 Environment。时间戳不是解决方案，但没有来源和版本信息就无法判断过期。

### 11.3 权威性

用户要求、组织策略、工具返回、模型猜测和摘要的可信等级不同。Context Builder 不应把模型生成的计划重新注入为已发生事实。

### 11.4 完整性

是否保留动作的输入、结果、错误和未完成状态。只保留最终文本会丢失审批、取消和部分完成信息。

### 11.5 可恢复性

压缩或模型切换后，是否还能重新得到关键文件、工具结果和执行约束。可恢复性要求历史中存在可重新获取的引用或结构化记录，而不是只保存不可解析的自然语言摘要。

## 12. Context 组装的推荐分层

一个可解释的 Builder 可以按以下顺序工作：

1. 读取 Session/Turn 的固定身份和当前执行阶段；
2. 选择仍然有效的历史分支和工具结果；
3. 注入不可违反的系统、项目和安全指令；
4. 读取当前 Environment 的必要观察，并标记来源；
5. 依据当前 Step 的模型和能力策略选择工具描述；
6. 按模型窗口裁剪、压缩或外置低优先级内容；
7. 生成可审计的 assembly metadata，记录被包含和被省略的内容；
8. 将同一份请求 Context 交给 provider 和执行生命周期记录。

这并不要求把全部 assembly metadata 发给模型。它主要服务调试、质量评估和恢复，帮助回答“模型为什么没有看到某项信息”。

## 13. 可复现验证设计

第一阶段不需要 API key，可以用脚本化模型捕获每次请求的 message、工具 schema、cwd 注释和输入顺序，分别改变：新增工具结果、修改文件后重新读取、插入 steer、压缩历史和切换模型。

可验证的指标包括：

- 同一条用户约束是否跨 Step 保留；
- 工具结果是否只进入正确的后续请求；
- 过期 Environment observation 是否被标记或刷新；
- 动态工具变化是否导致预期的请求前缀变化；
- compaction 后是否仍能恢复未完成动作和权限事实。

这类测试验证 Context Builder 的可观察行为，不验证模型是否真正理解信息，也不验证 provider 的 KV cache。KV cache 需要真实请求和服务端 cache telemetry，不能用本地 message 数组推断。

## 14. 设计原则

### 原则一：历史是事实层，Context 是派生层

不要为了满足当前 prompt 改写唯一事实来源。压缩、截断和模型适配应生成新的视图，并保留可追溯的来源。

### 原则二：上下文必须携带来源和时间语义

文件、命令输出、远程状态和模型计划都应能区分来源。没有来源的文本无法在恢复或冲突时判断权威性。

### 原则三：高价值约束优先于高体积输出

用户不可违反的要求、权限边界、未完成动作和当前 Environment 身份，通常比重复的构建日志更值得保留。

### 原则四：能力描述必须与执行能力一致

模型可见工具、实际可用工具和执行前授权需要有明确映射。不能让 Context 宣称一个当前 Environment 无法执行的能力。

### 原则五：每次请求都要有可解释的 Assembly

质量问题常被误判为模型问题，实际可能是关键文件、审批结果或工具观察没有进入 Context。记录组装决策是 Runtime 可诊断性的基础。

## 15. 结论与边界

Context 是连接 Session 历史、Runtime 状态、Environment 观察、Capability 平面和模型请求的派生层。它既不是完整记忆，也不是简单 prompt。优秀的 Agent 表现通常来自更好的上下文选择：在有限窗口中保留正确、最新、权威且可恢复的事实。

Codex 展示了历史版本、host-owned facts、world state 和 Step Context 的分层；Pi 展示了轻量 loop snapshot 到 durable harness 的层次差异；Gemini CLI 将 transcript 与动态 instructions 分开；OpenCode 通过 Session runner 和 LLM message 转换处理多种表示；OpenHands 将 Conversation history 与 workspace/sandbox observation 分开；Kimi 将 Context 物化放在请求激活边界；mini-SWE-agent 则以最小 trajectory 作为基线并把高级责任留给外层。

本文还没有深入回答两个问题：压缩到底丢失了什么，以及工具结果如何在有限窗口中保留并可恢复。这两个问题分别是后续文章的主题。

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

本文完成源码和相关测试阅读，未运行真实 provider 请求，也未测量 KV cache、模型理解质量或跨产品的端到端上下文保真度。

[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-agent]: [Pi context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^pi-loop]: [Pi agent loop context and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^gemini-session]: [Gemini CLI SDK Session](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^gemini-session-test]: [Gemini CLI Session context tests](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.test.ts#L290-L325)
[^opencode-context]: [OpenCode Session context and LLM message conversion](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L250)
[^opencode-tools]: [OpenCode tool execution responsibility](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-materialize]: [Kimi request materialization](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
