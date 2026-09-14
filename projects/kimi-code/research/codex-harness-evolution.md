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

## 核心结论

Kimi Code 的 harness 演进可以概括为四次边界移动：

1. **从 CLI 内嵌 Agent 到可复用 Harness**：早期 `kimi-code` 先围绕本地终端、provider、会话文件和工具循环形成产品；随后把会话、RPC、模型/工具、ACP 和 Web 入口抽到 `agent-core`、SDK 与 `kap-server`。
2. **从单一服务容器到按身份分层的 Scope**：v2 用 App → Session → Agent 的父子 DI Scope 管理状态和资源寿命；Workspace 主要由 Session/Workspace 服务承担，工作目录不再只是一个传给 shell 的 `cwd`。
3. **从隐式循环到显式 admission + Step/Turn 状态**：v1 的 `runTurn`/`turn-step` 是直接编排 LLM、工具、重试和上下文；v2 把 prompt admission、StepRequest、Turn 队列、取消、quiescence、持久事件和权限决策拆成可观察服务。
4. **从“历史文件 + 当前内存”到 Wire + replayable state**：v2 的 durable event、Wire journal、replayable state、ContextMemory 和宿主侧投影共同构成恢复边界；不过在 0.40.0 仍同时存在 v1 SDK façade 与 v2 SDK façade，说明迁移兼容层尚未消失。

## 视图边界与证据规则

本文只讨论 Runtime/Harness，不把 TUI 组件、Web 的 Vue 状态或产品视觉当成核心架构。重要判断均固定到 `e27ee60894d714e5844db75da69f29120a2bce43` 的源码；commit 选择参考官方 [v0.40.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai%2Fkimi-code@0.40.0)。

Graphify 对 `agent-core-v2`、legacy `agent-core`、`kap-server`、`kaos`、`kosong`、`protocol` 与 CLI 源码做了 code-only AST 索引；它用于确认模块边界和依赖密度，不替代源码阅读。

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
