# Kimi Code Harness 的 Runtime 演进研究

## 研究问题

本文研究 Kimi Code 从项目诞生到 `v0.40.0` 的整体 Runtime/Harness 演进，重点关注：执行循环、Scope 与状态所有权、Session/Agent/Turn/Step 的边界、工具与权限、持久化/恢复，以及 CLI、SDK、ACP、Web 多宿主如何共享或绕开 Core。

这里的 harness 不是单个 Agent loop，而是围绕模型调用提供以下运行时条件的系统集合：

- 接收、排队、steer、interrupt 和结束用户工作；
- 构造模型每次请求看到的上下文与工具；
- 把工具调用路由到正确的 Environment，并收敛到 workspace trust、权限和执行策略；
- 记录可恢复的事实，支持 resume、fork、compaction、undo 和迁移；
- 在 CLI/TUI、SDK、ACP、Web 与 `kap-server` 之间提供一致或可适配的生命周期语义。

分析基线是上游仓库 `MoonshotAI/kimi-code` 的 `@moonshot-ai/kimi-code@0.40.0`，commit `e27ee60894d714e5844db75da69f29120a2bce43`，发布于 2026-09-02。源码使用 partial clone 与 sparse checkout 获取，保留约 1,380 条可追溯 commit；本文的重要 commit 结论来自本地 Git 历史，并与[官方 v0.40.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai%2Fkimi-code@0.40.0) 对照。

配套架构图：[Kimi Code Runtime Architecture v0.40.0](../diagrams/kimi-code-runtime-architecture-v0.40.0-e27ee60.excalidraw)。

## 核心结论

Kimi Code 的 harness 演进可以概括为四次边界移动：

1. **从 CLI 内嵌 Agent 到可复用 Harness**：早期 `kimi-code` 先围绕本地终端、provider、会话文件和工具循环形成产品；随后把会话、RPC、模型/工具、ACP 和 Web 入口抽到 `agent-core`、SDK 与 `kap-server`。
2. **从单一服务容器到按身份分层的 Scope**：v2 用 App → Session → Agent 的父子 DI Scope 管理状态和资源寿命；Workspace 主要由 Session/Workspace 服务承担，工作目录不再只是一个传给 shell 的 `cwd`。
3. **从隐式循环到显式 admission + Step/Turn 状态**：v1 的 `runTurn`/`turn-step` 是直接编排 LLM、工具、重试和上下文；v2 把 prompt admission、StepRequest、Turn 队列、取消、quiescence、持久事件和权限决策拆成可观察服务。
4. **从“历史文件 + 当前内存”到 Wire + replayable state**：v2 的 durable event、Wire journal、replayable state、ContextMemory 和宿主侧投影共同构成恢复边界；不过在 0.40.0 仍同时存在 v1 SDK façade 与 v2 SDK façade，说明迁移兼容层尚未消失。

## 视图边界与证据规则

本文只讨论 Runtime/Harness，不把 TUI 组件、Web 的 Vue 状态或产品视觉当成核心架构。重要判断均固定到 `e27ee60894d714e5844db75da69f29120a2bce43` 的源码；commit 选择参考官方 [v0.40.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai%2Fkimi-code@0.40.0)。

对 `agent-core-v2`、legacy `agent-core`、`kap-server`、`kaos`、`kosong`、`protocol` 与 CLI 源码进行了定向结构阅读；模块边界和依赖关系以源码阅读为准。

## 1. 从诞生到 v0.40.0：重要演进节点

| 阶段 | 代表提交 | 架构意义 |
| --- | --- | --- |
| 项目起点 | [`842e699`](https://github.com/MoonshotAI/kimi-code/commit/842e699a643d8a60647bd824d28255c56ad61a42) | 以 Kimi For Coding 为产品/CLI 起点，先解决本地 coding agent 的交互和 provider 连接。 |
| v0.x 产品化 | [`e2ce6b9`](https://github.com/MoonshotAI/kimi-code/commit/e2ce6b96878088da6d25c99135d04e16df6aa1ed)、[`9143fda`](https://github.com/MoonshotAI/kimi-code/commit/9143fdadf68c252ed4d84b16db0d8274390fa132) | 版本化 CLI、会话、认证、工具和 TUI；harness 仍以 v1 Core 为主，但宿主边界开始稳定。 |
| 远程/多宿主 | [`c5c1834`](https://github.com/MoonshotAI/kimi-code/commit/c5c18347251221fab74e4f452ac4910116c4224d)、[`6c0ce09`](https://github.com/MoonshotAI/kimi-code/commit/6c0ce09414bbfd42d8991c88c89b82c0888ef209) | Web/server、session snapshot、归档/恢复让“本地 cwd 中运行一次”变成可被远程读取和恢复的服务。 |
| v2 落地 | [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) | `agent-core-v2` 与 `kap-server` 作为实验引擎进入仓库，开始新 Scope、事件、权限和协议路径。 |
| v2 成为 Web 默认 | [`4ec2e7f`](https://github.com/MoonshotAI/kimi-code/commit/4ec2e7fab14ab89cddf77821082c3ff4911f737b) | server 默认 v2，并删除 v1 server package；旧 Core 仍服务于 CLI/SDK 兼容路径。 |
| v2 结构化 | [`5240b5c`](https://github.com/MoonshotAI/kimi-code/commit/5240b5c83c876fd6fcbe199b3c7b4f65ef75d215)、[`3615b5d`](https://github.com/MoonshotAI/kimi-code/commit/3615b5da9f33f0d04139459966f2ac58fc872fe3) | 生成 config/wire manifest；删除 definition-level capability resolution，能力解析向运行时服务集中。 |
| v2 默认 CLI | [`e27ee60`](https://github.com/MoonshotAI/kimi-code/commit/e27ee60894d714e5844db75da69f29120a2bce43) 对应版本 | `kimi -p` 与交互 TUI 默认 v2，`KIMI_CODE_LEGACY_FLAG` 明确保留 v1；ACP legacy adapter 已移除，迁移边界变成 SDK/CLI flag。 |

这条时间线说明：Kimi Code 的重大变化不是“把一个 loop 写得更复杂”，而是把原先只服务 CLI 的执行器提升成可恢复、可远程投影、可按 scope 装配的多宿主 Runtime。

## 2. v0.40.0 的实际宿主结构

在当前 commit，CLI 通过 [`experimental-v2.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/apps/kimi-code/src/cli/experimental-v2.ts) 定义引擎门：默认 v2，truthy 的 `KIMI_CODE_LEGACY_FLAG` 才选择 v1；[`run-shell.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/apps/kimi-code/src/cli/run-shell.ts) 同时装配 `createKimiHarnessV2()` 和 `createKimiHarness()`。

```text
CLI/TUI, kimi -p ──┐
Node SDK / ACP ────┼── Kimi Harness ──┬── agent-core-v2（默认）
                  │                  └── agent-core v1（legacy flag）
kap-server/Web ───┴────────────── agent-core-v2（server 默认）
```

因此“共享 Harness”在 0.40.0 仍有两种含义：宿主 API/产品语义努力一致，但底层 Core 并不完全相同。`kap-server` 已直接 import v2 的 event、session、permission、workspace 和 transcript 类型；SDK 仍有 v1 façade 与 v2 RPC client 并存。

## 3. Scope：Environment 不再等于 cwd

v2 在 [`scopes.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/app/scopes.ts) 声明 `App → Session → Agent` 拓扑，底层 [`scope.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/_base/di/scope.ts) 强制子 scope 只能向更短生命周期创建，服务由注册点决定属于哪一层。

在 v0.40.0，Environment 更准确的定义是：**某个 Session/Agent 可使用的执行资源和安全策略集合**，而不是一个目录字符串。它至少包括：

- workspace/session 关联的 `cwd` 与附加目录；
- 文件、shell、git、网络、MCP、plugin 等能力提供者；
- workspace trust、permission mode、user rules、sensitive path 和 dangerous command policy；
- provider/model credentials、skills、config、session persistence 与恢复语义；
- 进程级的 provider catalog、telemetry、日志和配置注册。

这解释了为什么 v2 可以支持远程 Web、ACP、多个 Session、fork 和 Tower/Swarm：入口提供的是 Environment seed 和宿主能力，而不是要求每个入口自己复制一份 loop。`cwd` 仍是 Environment 的一个字段，但不再是 Environment 的全部定义。

## 4. Session、Agent、Turn、Step 的关系

### 4.1 层级

```text
App
└── Session（可恢复会话、workspace 关联、metadata、index）
    └── Agent（一个执行身份/上下文/工具/权限 Scope）
        ├── Prompt（用户输入的 admission 与完成状态）
        └── Turn（一次模型驱动的前台执行）
            └── StepRequest / Step（一次模型或工具推进）
```

`Session` 负责“这段历史和工作环境属于谁”；`Agent` 负责“哪个执行身份持有 context、工具、权限和模型”；`Turn` 负责“一次连续的模型—工具闭环”；`Step` 负责“闭环中的一次可排队/可取消/可重试推进”。这不是 UI 的消息层级，而是资源所有权和调度粒度。

### 4.2 输入、审批、中断和模型变更如何落位

| 用户可感知动作 | 主要归属 | 是否进入 durable/replay 语义 |
| --- | --- | --- |
| 新建/恢复 Session、workspace/cwd、session metadata | Session | 是；由 session metadata/index 与 Agent Wire 共同支撑。 |
| 连续输入、队列、steer、notify | Prompt/Turn admission | `prompt.*`、`turn.prompt`、`turn.steer` 等事件可观察；是否开始新 Turn 由 admission 决定。 |
| 一次 LLM 请求、工具调用、工具结果、重试 | Step/Turn | 工具/turn 事实可进入 Wire；流式 delta 主要是即时观察。 |
| tool approval、permission mode/rules | Agent + Workspace policy | 决策绑定当前 Agent/Environment；改变模式会影响后续执行，不应修改已完成 Turn 的事实。 |
| 中断/取消 | 当前 Turn，向 Step/工具传播 Abort | `turn.cancel`、prompt aborted/turn ended 记录结果；已发生的工具事实不应被当作从未发生。 |
| 模型切换 | Session/Agent configuration，作用于后续 Turn | 当前请求的 provider/model 是该请求的快照；切换不会重写旧 Wire。 |
| 增加可信任目录/附加目录 | Workspace/Session Environment | 影响后续能力解析和策略；具体 prompt 是否重新注入由宿主和 profile 决定，不是历史消息的原地改写。 |

`StepRequest` 在 [`stepRequest.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts) 中显式区分 `newTurn`、`activeOrNewTurn`、`activeOrNextTurn`、`activeTurnOnly`；`AgentLoopService` 负责 admission、FIFO、quiescence、active/pending turn 和取消。这说明“连续 user input”首先是可调度请求，而不是直接追加到一个全局字符串。

### 4.3 不可变与可变

- **事实不可变**：已追加的 user prompt、assistant/tool result、Turn 结束原因、审批结果和 Wire record 是历史事实；compaction/undo 是新的 durable operation，不是隐式修改旧事件。
- **运行状态可变**：active/pending queue、当前 permission mode、model selection、tool registry、token estimate、UI subscriptions、Abort signal 都是当前投影或控制状态。
- **上下文表示可重建**：`ContextMemory` 通过事件追加、splice、undo 和 compaction 产生当前 prompt history；它不是唯一的事实数据库。
- **Step 不等于不可变快照**：Step 的 request/assignment/attempt 可以被取消、重试或失败；应把最终事件和 attempt 记录与临时 stream accumulator 分开。

## 5. Loop 与 Harness 的结构变化

### legacy v1：产品化的直接编排

legacy `agent-core` 的 [`run-turn.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core/src/loop/run-turn.ts)、[`turn-step.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core/src/loop/turn-step.ts) 和 [`tool-scheduler.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core/src/loop/tool-scheduler.ts) 将 LLM stream、tool calls、tool scheduler、retry、context append 和终止条件串在一个 turn runtime 中。它的优点是产品行为直接、调试路径短；缺点是多入口、恢复、审批、后台任务和新能力容易通过更多 service/flag 叠加。

### v2：把执行过程拆为稳定的服务边界

v2 的 [`loop.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loop.ts) 明确定义 `Turn`、`Step`、`StepRequest`、`LoopRunResult`、cancel、settled 和 hooks；[`loopService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts) 维护 pending turns、active turn、standalone/held requests、quiescence 和 error handlers。

这带来三个架构收益：

1. **输入和执行解耦**：Prompt service 可先排队、steer、合并、标记完成，Loop 再按 admission 物化 Turn。
2. **权限成为执行前门**：[`permissionGateService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts) 在 `toolExecutor.onBeforeExecuteTool` 上统一执行 policy、approval、telemetry，而不是让每个工具自己决定是否询问。
3. **恢复和投影有独立位置**：ContextMemory 负责当前模型上下文，EventDispatcher 负责 replayable state，WireService 负责 append journal；宿主再把 runtime events 投影成 transcript/API。

## 6. 工具：从固定工具集到策略化能力平面

v2 的工具注册和选择分成几层：

- [`toolRegistryService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolRegistry/toolRegistryService.ts) 管工具实例、source、disclosure 和解析；
- `toolSelect`/`dynamicTools` 管按上下文加载的工具 schema 和 announcement；
- `toolExecutor` 管参数校验、hook、scheduler、Abort、结果截断；
- permission policy 管当前 Environment 是否允许执行；
- MCP/plugin/skills 通过 contribution/registry 把能力注入到相应 Scope。

所谓“可变工具”不是简单地每轮把一套全新工具硬塞进 system prompt。v2 的动态工具机制会把可加载工具名称以历史 announcement 表示，使用 `select_tools` 加载完整 schema，并在重建上下文时由 [`dynamicTools.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts) 识别/剥离动态 schema。这样做有两个目的：减少常驻 prompt 体积，并把工具可见性变化变成可解释的上下文事实。

对 KV cache 的含义是：**工具 schema 的变更确实可能改变模型输入前缀，从而影响后缀 cache 命中；但 Kimi 的设计不是无条件地每一步重写所有工具定义，而是将常驻工具、动态加载工具、announcement 和实际执行 registry 分离。** 具体 provider 是否对 tool schema 做独立 cache、何时重新计算 token/cache，需要运行真实 provider 才能确认；源码只能确认输入历史和工具注册的边界。

## 7. 持久化、恢复和读取模型

v2 的 [`EventDispatcherService`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/state/eventDispatcherService.ts) 将 durable event fold 成 replayable state，并通过 patch/checkpoint/undo 管理状态投影；[`WireService`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/wire/wireService.ts) 负责 append log、blob offload、版本迁移和损坏 journal 修复；[`contextMemoryService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts) 只向当前 Agent 提供可用于模型请求的 ContextMessage 视图。

因此有三种不同的“状态”：

1. **事实日志**：发生了什么，面向恢复和跨宿主同步；
2. **运行投影**：当前 Agent/Session 的 queue、state、context、token count、permission mode；
3. **产品读取模型**：`kap-server` 的 transcript、session snapshot、search/index、WebSocket/REST entity。

0.40.0 仍在迁移期，v1 harness 和 v2 harness 的 session/API 兼容层并存；不能把所有 UI snapshot 当成 Runtime 真相，也不能把所有 ContextMessage 当成不可变事件。

## 8. 架构级判断

- **Kimi Code 的产品能力来自宿主和恢复链，不仅来自 loop**：Web/ACP/SDK、session index、workspace trust、permission、plugin、MCP 和 transcript 是 harness 的一等部分。
- **v2 的核心抽象是 state ownership**：Scope 决定对象活多久，Event/Wire 决定状态如何恢复，Loop/Prompt 决定动作如何调度。
- **v0.40 的主要风险是双引擎语义漂移**：v1 仍有兼容 API 和 legacy flag，部分 SDK 方法 v2-only；迁移层本身是产品复杂度的一部分。
- **与纯技术框架不同，Kimi 选择把“可用产品”放在架构中心**：默认运行时、Web server、ACP、workspace trust、权限 UI、session migration 和兼容性都被纳入核心设计，而不是留给使用者拼装。

## 未确认事项

- 未连接真实 provider，因此未验证动态工具加载对各 provider KV cache 的实际命中率。
- 未执行跨进程崩溃恢复、真实 ACP client、Web remote control、Tower/Swarm 或多 MCP server 的运行实验。
- 0.40.0 后 v1 兼容层何时完全删除，不能由该版本源码推断。

## 验证依据

- 源码阅读：v1/v2 loop、Prompt/Context、Scope/DI、permission/tool registry、Wire/EventDispatcher、CLI engine gate、SDK/ACP/kap-server imports。
- 测试阅读：`packages/agent-core-v2/test` 中 loop、state、permission、session、wire 相关测试；本次未做运行实验。
- 提交历史：浅历史约 1,000 个提交，覆盖 2026-05-22 项目起点至 2026-09-02 v0.40.0；未拉取完整历史。

## 9. v1/v2 双引擎迁移的真实边界

v1/v2 并存不是简单的“旧代码还没删掉”，而是两个不同成熟度的 runtime contract 同时服务不同宿主：

| 维度 | legacy v1 | v2 |
| --- | --- | --- |
| 主要 loop | `runTurn` + `turn-step` 直接编排 | LoopService + Turn + StepRequest admission |
| 状态组织 | Agent/Session 内存态加 transcript | Scope、Event/Wire、replayable state、ContextMemory |
| 输入语义 | 直接提交到当前 turn/loop | prompt admission、FIFO、held/active/next turn |
| 权限位置 | tool scheduler 与宿主回调 | PermissionGateService 的执行前门 |
| Context | history append/压缩 | ContextMemory 与 durable event projection 分离 |
| 宿主 | CLI/SDK 兼容路径 | CLI/TUI 默认、Web/server、v2 RPC |
| 恢复模型 | session snapshot/历史文件 | Wire journal、state fold、patch/checkpoint/replay |

因此 v2 不是对 v1 的局部重命名，而是把运行时的 admission、状态、权限和恢复边界重新分层。0.40.0 的迁移状态可以表示为：

```text
同一产品语义
   ├─ v1 façade → legacy loop → legacy session/tool path
   └─ v2 façade → Scope → admission → durable state → v2 loop
```

兼容层的存在意味着“默认使用 v2”不等于“所有调用都已经共享 v2 语义”。SDK、ACP 或旧插件如果仍通过 v1 façade 进入，可能拥有不同的 context、approval、event 和恢复边界。横向研究时，应把宿主入口和引擎版本同时记录，而不能只记录 Kimi Code 的产品版本。

## 10. Scope、StepRequest、Wire 与 Replay 的关系

这四个概念解决的是四个不同问题：

| 概念 | 解决的问题 | 生命周期 |
| --- | --- | --- |
| Scope | 哪些服务和资源属于同一生命周期 | App、Session、Agent 分层 |
| StepRequest | 用户/系统意图如何进入执行队列 | admission 到 accepted/rejected |
| Wire | 发生过哪些可持久化运行事件 | append journal |
| Replay | 如何从 Wire 重建当前状态 | session/agent 恢复时执行 |

它们的连接不是线性调用，而是：

```text
Scope owns services
   ↓
StepRequest admitted by LoopService
   ↓
Turn/Step produces runtime effects
   ↓
Wire records durable facts
   ↓
Replay folds facts into Session/Agent state
   ↓
ContextMemory renders next model request
```

`StepRequest` 是控制入口，不是执行事实；Wire record 是事实，不是当前 state；Replay 是重建过程，不是另一个模型 loop；ContextMemory 是模型输入投影，不是完整历史。将这几者混为一个“Step object”会丢失 Kimi v2 最重要的架构变化。

## 11. 权限和 Environment 如何进入 Step

在 v2 中，Step 不应只包含 model 和 messages。一个可解释的 Step execution context 至少需要：

- 所属 App/Session/Agent scope；
- 当前 workspace、cwd、附加目录和 trust 状态；
- 当前 model/provider 与 capability profile；
- active tool snapshot 与动态工具加载状态；
- permission mode、approval policy 和用户规则；
- parent turn、request id、correlation id 和 Abort signal；
- context projection 的版本、token budget 和 compression state。

其中一部分由 Scope service 提供，一部分由 permission gate 在工具执行前读取，一部分由 ContextMemory 在请求构造时派生。v2 的价值在于这些依赖不再隐式来自全局 singleton，而是可以沿 Scope 和 StepRequest 追踪。

当用户增加可信目录、切换模型或改变 approval mode 时，不应修改已经完成的 Wire record；正确语义是更新后续 Step 的 capability/policy input。若当前 Step 已经进入 executing，系统还必须决定变化是等待下一 Step 生效，还是取消/重建当前 Step。源码支持执行前 gate 和 request admission 的分层，但配置变化的原子性仍需运行实验验证。

## 12. 为什么迁移期没有直接删除 v1 Runtime

保留 v1 至少有四个架构原因：

1. **宿主兼容**：CLI、SDK、ACP、插件和自动化脚本不可能在同一版本同时迁移所有调用协议；
2. **行为兼容**：v1 的 tool result、session history、approval callback 和错误语义已经被产品/用户依赖；
3. **回滚能力**：v2 是新状态模型，若出现 Wire/replay、context 或 permission 回归，legacy path 提供可用 fallback；
4. **边界验证**：双引擎允许对相同宿主需求比较新旧实现，逐步确认 v2 的责任迁移。

但双引擎也有显著成本：

- 同一用户动作可能在 v1/v2 产生不同的 session、event 和 tool 行为；
- capability、permission 和 model context 需要维护两套适配；
- 文档和测试必须区分默认引擎、legacy flag 与 server default；
- 迁移完成前无法把一个版本号直接等同于一套唯一 runtime。

因此 v1 的保留不是单纯技术债，而是一次产品 runtime 重构中的兼容性策略；当 v2 的 Wire、Replay、Scope 和 permission gate 尚未覆盖全部宿主时，删除 v1 会把迁移风险转嫁给用户和集成方。

## 13. v2 的终态收敛模型

Kimi v2 的一次 Step/Turn 终态可抽象为：

```text
admitted
  → context rendered
  → model requested
  → tool/policy gate
       ├─ approval pending → resolved / denied
       ├─ cancelled → settled
       └─ allowed → executing
  → effect recorded in Wire
  → state replay/projection updated
  → next Step or Turn terminal
```

需要同时收敛三种状态：

1. **控制状态**：pending request、active turn、cancel、quiescence；
2. **执行事实**：tool call、approval、tool result、error、usage；
3. **读取投影**：ContextMemory、transcript、Web/SDK snapshot。

如果只停止模型 stream 而没有记录 cancelled Step，Replay 可能重新认为调用仍在进行；如果只更新 transcript 而没有写 Wire，Web/ACP 恢复会丢失执行事实；如果只回滚 ContextMemory 而不保留原始 event，审计和重放会失去依据。v2 的架构价值正是为这些状态建立不同 owner，再通过事件关联它们。

## 14. Kimi Code 的设计原则

### 原则 1：Scope 先于服务实例

对象属于 App、Session 还是 Agent，不由调用者临时决定，而由 Scope 拓扑决定。服务只能向更短生命周期创建子依赖，避免 session 状态意外泄漏到全局或 agent 资源长于所属会话。

### 原则 2：Admission 与 Execution 分离

用户输入先成为 StepRequest，再由 LoopService 决定进入当前、下一个或独立 Turn。这样 queue、steer、cancel 和 quiescence 可以被测试，不必混在模型调用代码中。

### 原则 3：Wire 是事实，Context 是投影

Wire journal 和 replayable state 负责恢复与同步；ContextMemory 负责当前模型看到什么。压缩、undo 和动态工具变化影响 projection 时，不应伪造过去的执行事实。

### 原则 4：权限必须位于工具执行前门

PermissionGateService 在 `onBeforeExecuteTool` 位置统一处理 policy、approval、telemetry 和环境限制。工具本身可以声明能力，但不应自行绕过统一执行门。

### 原则 5：动态工具采用按需暴露

常驻工具、工具 announcement、`select_tools` 和实际 registry 分层，减少每次请求都携带完整工具 schema 的成本。工具变化要能在 context/history 中解释，同时在执行时重新验证。

### 原则 6：默认迁移不等于立即删除兼容路径

v2 先成为默认路径，再通过 legacy flag 保留 v1，允许宿主、用户和插件逐步迁移。架构演进以行为兼容和可回滚为约束，而不是以目录清理速度为目标。

### 原则 7：Runtime 状态必须可回放，UI 状态可以重建

Web、CLI、ACP 和 SDK 都可以拥有自己的读取模型，但应从 Wire/session/event contract 重建。UI snapshot、stream delta 和 transient accumulator 不应成为唯一事实来源。

### 原则 8：Environment 是 Scope 绑定的能力边界

cwd 只是 workspace 的一个字段；真正的执行环境还包括 trust、工具、权限、模型、凭据、MCP 和恢复服务。Step 使用的环境输入必须可追踪，避免同一 session 在不同 host 中隐式获得不同能力。

## 15. 设计收益与代价

| 设计选择 | 收益 | 代价 |
| --- | --- | --- |
| App/Session/Agent Scope | 生命周期和资源 ownership 清晰 | DI/Scope 复杂度上升 |
| StepRequest admission | 支持 queue、steer、cancel、quiescence | 输入语义需要额外状态机 |
| Wire + Replay | 恢复、审计、多宿主同步 | journal、迁移、损坏修复复杂 |
| ContextMemory projection | 压缩与工具按需暴露 | 事实与模型输入可能分叉 |
| Permission Gate | 工具安全入口统一 | policy 与 environment 组合复杂 |
| v1/v2 并存 | 兼容、回滚、渐进迁移 | 双语义、双测试、双适配成本 |
| Scope-bound Environment | 多 workspace、多宿主 | 环境快照和跨进程接管难度高 |

## 16. 研究结论的严格表述

Kimi Code v0.40.0 最重要的架构事实不是“已经完成 v2 重构”，而是：v2 已经建立了比 v1 更明确的 Scope、admission、Step、permission、Wire、Replay 和 Context projection 边界，并成为主要默认路径；但 legacy v1 仍然存在于兼容面，因此产品版本仍代表一个双引擎迁移态。

对于后续横向研究，Kimi 的核心问题应表述为：它如何用 Scope 和 Wire 把长期 session、逐步执行、动态 capability 与多宿主恢复连接起来；而不是简单比较它是否拥有某个名为 Session 或 Step 的类。当前报告只对 v0.40.0 做版本快照和历史节点分析，不将未来 v0.41/v2 GA 的行为提前推断为已实现。
