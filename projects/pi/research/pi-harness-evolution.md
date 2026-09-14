# Pi Harness 的架构演进研究

## 研究范围

本文研究 Pi 从项目早期到 `v0.85.1` 的 coding-agent harness 演进，重点回答：

- Agent Loop、AgentSession、Harness 和 Runtime Host 的职责如何迁移；
- session 从 JSONL 对话文件演进为可恢复的 durable state；
- compaction、branch/fork、steering、retry 和 tool execution 如何获得生命周期语义；
- `ExecutionEnv`、tool context、extension 和 provider 如何成为可替换运行时边界；
- 为什么 2026-08 的 v4 lane-based harness 是一次架构重置，而不仅是 API 重命名。

本文不做 Pi 与 Codex 或其它 coding agent 的横向比较。只保留后续横向研究需要的观察维度：控制面、模型循环、执行环境、能力扩展、持久化、恢复、远程化和宿主进程边界。已有的 `coding-agent-0.79.8` 文档是一个独立版本快照，不作为本文的历史基线。

分析终点是上游 [`v0.85.1`](https://github.com/earendil-works/pi/releases/tag/v0.85.1)，固定 commit 为 [`d981de1229ef899957bbe968bc8dcda02a21f477`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477)，发布于 2026-09-05。历史结论来自 Pi 的 Git commit graph、版本 changelog 和关键版本源码；当前实现结论固定到该 commit 的 GitHub 源码链接。

## 核心结论

Pi 的重大架构变化不是把原有 Agent Loop 不断堆复杂，而是连续把隐含在一次同步交互里的状态拆成可替换、可持久化和可恢复的运行时边界：

```text
早期：
Agent → model stream → tool calls → messages

中期：
AgentSession
  ├── Agent loop
  ├── SessionManager / JSONL tree
  ├── compaction / branch / retry
  └── hooks / extensions / SDK / RPC

当前：
AgentHarness
  ├── Session / SessionStorage / SessionRepo
  ├── tree-scoped named lanes
  ├── durable operation state
  ├── generation / tool effect / deferred polling recovery
  ├── ExecutionEnv / Context / effect gate
  └── Runtime Host / worker / remote service
```

到 `v0.85.1`，Pi 的核心运行时可以分成六个平面：

| 平面 | 主要职责 | 当前边界 |
| --- | --- | --- |
| Model loop | 上下文转换、模型流、tool call、follow-up | `Agent`、`agentLoop()` |
| Session state | entry、branch、lane、配置、inbox、operation result | `Session`、`SessionStorage`、`SessionRepo` |
| Durable execution | generation、retry、tool effect、deferred、compaction | `Lane`、`Drive`、`OperationState` |
| Execution capability | 文件、shell、tool context、取消和执行闸门 | `ExecutionEnv`、`AgentHarnessTool`、`Gate` |
| Extension/service | hooks、resources、skills、provider、UI、RPC | `AgentSessionServices`、`AgentSessionRuntime` |
| Host/process | cwd 绑定、session replacement、child worker、remote client | coding-agent runtime/server |

最重要的架构判断是：**v0.85.1 的 harness 已经不是“带持久化的 Agent Loop”，而是一个以 durable operation 为中心的可恢复执行机；Agent Loop 只是其中的模型生成过程。**

## 一、演进时间线

### 阶段 0：项目诞生——可发布的轻量 Agent 包

Pi 最早的提交建立 npm monorepo、workspace 和双 TypeScript 配置。入口是轻量 Agent/AI 包以及 coding-agent CLI，核心运行语义集中在模型流和工具循环中。

- [`a74c5da1`](https://github.com/earendil-works/pi/commit/a74c5da1)：初始 monorepo setup；
- [`3a9c3a2e`](https://github.com/earendil-works/pi/commit/3a9c3a2e)：早期 `v0.5.3` 发布修复；
- [`f579a3f1`](https://github.com/earendil-works/pi/commit/f579a3f1)：建立多 package lockstep versioning。

这一阶段的边界很简单：

```text
调用方
  └── Agent
        └── agent loop
              └── streamFn / provider
                    └── tools
```

此时 session 主要是 coding-agent 的产品功能，不是通用 Agent Core 的持久化运行时；工具执行也还是 Agent Loop 内的同步过程。

### 阶段 1：Agent Core 与 coding-agent Session 分离

2025-10 开始，Pi 引入更明确的 session storage 和 runtime bridge：

- [`e5cf25a2`](https://github.com/earendil-works/pi/commit/e5cf25a2)：重构 Agent architecture 并加入 session storage；
- [`05dfaa11`](https://github.com/earendil-works/pi/commit/05dfaa11)：加入 custom message extension system；
- [`bbbc232c`](https://github.com/earendil-works/pi/commit/bbbc232c)：unified storage architecture；
- [`0de89a75`](https://github.com/earendil-works/pi/commit/0de89a75)：转向 Store-based architecture；
- [`c2793d80`](https://github.com/earendil-works/pi/commit/c2793d80)：加入 runtime bridge architecture。

架构发生的变化是：

```text
Agent Core
  └── AgentMessage[] / model loop

coding-agent
  ├── session persistence
  ├── runtime bridge
  ├── artifacts / UI state
  └── product-specific orchestration
```

这为后续演进保留了一个重要不变量：Agent Core 不直接知道 TUI、JSONL 文件或具体 Provider 产品语义；coding-agent 可以在外层增加持久化、UI 和扩展，而不复制模型循环。

### 阶段 2：Session Tree、Compaction、Resume 和 AgentSession

2025-11 到 2025-12，session 从“日志文件”变成带 parent/leaf 关系的会话树：

- [`8ae236f9`](https://github.com/earendil-works/pi/commit/8ae236f9)：加入 `/branch` 对话分支；
- [`5e988b44`](https://github.com/earendil-works/pi/commit/5e988b44)：session 文件只保存消息和状态变化，不再保存运行时 event log；
- [`812f2f43`](https://github.com/earendil-works/pi/commit/812f2f43)：延迟 session 创建，直到第一次 user/assistant 交互；
- [`351faef6`](https://github.com/earendil-works/pi/commit/351faef6)：建立 session tree format；
- [`64e7c80c`](https://github.com/earendil-works/pi/commit/64e7c80c)：session tree 使用 UUID，而不是位置索引；
- [`c89b1ec3`](https://github.com/earendil-works/pi/commit/c89b1ec3)：加入 context compaction、`/compact`、auto-trigger；
- [`4bd52cf3`](https://github.com/earendil-works/pi/commit/4bd52cf3)：加入 `/resume`，可以在会话之间切换。

随后 `AgentSession` 成为 coding-agent 的产品语义中心：

- [`29d96ab2`](https://github.com/earendil-works/pi/commit/29d96ab2)：创建 `AgentSession` 基础结构；
- [`eba196f4`](https://github.com/earendil-works/pi/commit/eba196f4)：加入 AgentSession event subscription 和 session persistence；
- [`d08e1e53`](https://github.com/earendil-works/pi/commit/d08e1e53)：加入 prompt、queue、abort、reset；
- [`0119d761`](https://github.com/earendil-works/pi/commit/0119d761)：加入 model、thinking level 和 queue mode 管理；
- [`8d6d2dd7`](https://github.com/earendil-works/pi/commit/8d6d2dd7)：加入 AgentSession compaction；
- [`934c2bc5`](https://github.com/earendil-works/pi/commit/934c2bc5)：加入 AgentSession bash execution；
- [`e9f6de7c`](https://github.com/earendil-works/pi/commit/e9f6de7c)：创建基于 AgentSession 的新入口和新 modes；
- [`3559a43b`](https://github.com/earendil-works/pi/commit/3559a43b)：重写 RPC mode 为 typed protocol；
- [`5482bf3e`](https://github.com/earendil-works/pi/commit/5482bf3e)：加入 SDK，支持程序化使用 AgentSession。

这一次演进将职责分成三层：

```text
Agent
  └── 消息、模型流、tool loop

AgentSession
  ├── prompt / queue / steer / abort
  ├── model / thinking / active tools
  ├── compaction / retry
  ├── extension events
  └── session persistence

Runtime Host
  ├── Interactive
  ├── Print / JSON
  ├── RPC
  └── SDK
```

### 阶段 3：从 Session API 到可编排的 extension/tool 平面

2026-01，Pi 不再把扩展看作几个独立目录，而是统一为 extension runtime：

- [`db312d2e`](https://github.com/earendil-works/pi/commit/db312d2e)：hooks 可以控制 CLI flags、shortcuts 和 tools；
- [`e4dd21a3`](https://github.com/earendil-works/pi/commit/e4dd21a3)：hook 可以访问完整 tool registry，并追加 system prompt；
- [`2849623a`](https://github.com/earendil-works/pi/commit/2849623a)：所有内建 tools 进入 registry；
- [`31438fdf`](https://github.com/earendil-works/pi/commit/31438fdf)：所有 registry tools 都经过 hooks 包装；
- [`9c9e6822`](https://github.com/earendil-works/pi/commit/9c9e6822)：加入 tool/hook event bus；
- [`2846c7d1`](https://github.com/earendil-works/pi/commit/2846c7d1)：统一 extensions system；
- [`9794868b`](https://github.com/earendil-works/pi/commit/9794868b)：加入 extension discovery 和 package manifest；
- [`9ed88646`](https://github.com/earendil-works/pi/commit/9ed88646)：加入可插拔的 remote tool execution operations；
- [`17cb328c`](https://github.com/earendil-works/pi/commit/17cb328c)：允许 extension 修改 system prompt。

工具从静态列表变成多阶段能力：

```text
注册工具
  └── active tools / tool override
        └── hook preflight
              └── execution
                    └── hook post-process
                          └── result / message / next context
```

在这一阶段，模型能看到的工具和系统已注册的工具开始分离；工具控制、system prompt 修改和 remote execution 也开始通过统一扩展接口接入。

同时，queue 语义被显式拆分：

- [`d0a4c370`](https://github.com/earendil-works/pi/commit/d0a4c370)：将 queue 拆成 `steer()` 和 `followUp()`；
- [`58c423ba`](https://github.com/earendil-works/pi/commit/58c423ba)：AgentSession 迁移到新的 queue API。

这为后来 lane inbox 和 durable operation 的输入分层提供了前身。

### 阶段 4：Harness 作为通用 durable agent 边界

2026-05，通用 `packages/agent` 开始出现明确的 harness：

- [`a5b27367`](https://github.com/earendil-works/pi/commit/a5b27367)：initial harness foundation；
- [`83599e78`](https://github.com/earendil-works/pi/commit/83599e78)：拆分 harness compaction 和 session modules；
- [`cdde2e89`](https://github.com/earendil-works/pi/commit/cdde2e89)：consolidate harness session abstraction；
- [`617d8b31`](https://github.com/earendil-works/pi/commit/617d8b31)：收紧 harness environment 和 resources；
- [`322759a3`](https://github.com/earendil-works/pi/commit/322759a3)：snapshot harness turn state；
- [`846906e4`](https://github.com/earendil-works/pi/commit/846906e4)：引入 result-based execution environment；
- [`b7ea8210`](https://github.com/earendil-works/pi/commit/b7ea8210)：让 harness loop 直接运行；
- [`4f40f62b`](https://github.com/earendil-works/pi/commit/4f40f62b)：收紧 harness session semantics；
- [`b63d2633`](https://github.com/earendil-works/pi/commit/b63d2633)：完成 harness tool registry semantics。

这一阶段的关键不是新增一个更大的 Agent 类，而是建立通用契约：

```text
AgentHarness
  ├── session
  ├── models
  ├── tools
  ├── resources
  ├── compaction
  ├── retry
  ├── hooks
  └── stream / event lifecycle
```

### 阶段 5：模型和认证从隐式依赖变为 Models 注入

2026-06，harness 的模型边界被重新定义：

- [`f0ccbbf0`](https://github.com/earendil-works/pi/commit/f0ccbbf0)：AgentHarness 通过 required `Models` instance streaming；
- [`9ab12926`](https://github.com/earendil-works/pi/commit/9ab12926)：`Models` 成为 harness 唯一 auth path；
- [`0d89a333`](https://github.com/earendil-works/pi/commit/0d89a333)：早期 selective `pi-ai/base` entrypoint；
- [`717a8f95`](https://github.com/earendil-works/pi/commit/717a8f95)：之后撤销 selective base entrypoint，回到显式 `Models` provider factory。

架构意义是：harness 不再在每次模型请求时自行解析 API key/header；应用构造 `Models`，harness 只消费已经配置的模型能力。

这使三件事分离：

```text
Provider / Auth construction      应用或 ModelRegistry
Model selection                   AgentHarness / Lane configuration
Generation                       Agent loop / durable operation
```

当前 `AgentHarnessOptions` 明确要求 `session`、`models` 和 `model`，并把 retry、compaction、tools、tool context 和 provider message conversion 作为运行时配置：[当前 `AgentHarnessOptions`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts#L518-L536)

### 阶段 6：Session Storage 从 JSONL 文件抽象为 Repo、Storage 和 Search

2026-07，存储边界开始从“session manager 读写 JSONL”拆成组合式存储：

- [`9e7582aa`](https://github.com/earendil-works/pi/commit/9e7582aa)：SQLite session storage；
- [`0f5a6e42`](https://github.com/earendil-works/pi/commit/0f5a6e42)：SQLite search index；
- [`d5c37c65`](https://github.com/earendil-works/pi/commit/d5c37c65)：composable `Storage` 与 `Search`；
- [`6a9591ae`](https://github.com/earendil-works/pi/commit/6a9591ae)：repo 分别拥有 session 和 storage；
- [`5e48d41e`](https://github.com/earendil-works/pi/commit/5e48d41e)：repo facade；
- [`2700511e`](https://github.com/earendil-works/pi/commit/2700511e)：refine session repository API；
- [`53422a24`](https://github.com/earendil-works/pi/commit/53422a24)：storage-owned session readers；
- [`9b758720`](https://github.com/earendil-works/pi/commit/9b758720)：bounded branch queries；
- [`cbc893b0`](https://github.com/earendil-works/pi/commit/cbc893b0)：prepare storage foundation for harness v2。

这里发生的是所有权转移：

```text
旧模型：SessionManager 直接管理文件和上下文

新模型：
SessionRepo
  ├── create/open/list/fork session
  └── owns session lifecycle
SessionStorage
  ├── append / commit / read values
  ├── sequence and branch queries
  └── recovery records
Search
  └── optional external/indexed query capability
```

当前 v0.85.1 的 `JsonlSessionRepo` 仍支持 append-only JSONL，但它已不再等于整个 session runtime；它实现 `SessionRepo`，并通过 `JsonlStorage` 提供存储实现：[当前 Pi `JsonlSessionRepo`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/repo.ts#L49-L90)

### 阶段 7：v2 Durable Harness——操作状态、恢复和并发边界

2026-08-02 到 2026-08-17 是 Pi harness 的最大架构跃迁：

- [`1d0c9747`](https://github.com/earendil-works/pi/commit/1d0c9747)：实现 in-memory harness v2；
- [`cd20a8d2`](https://github.com/earendil-works/pi/commit/cd20a8d2)：拆分 experimental harness changes；
- [`44289550`](https://github.com/earendil-works/pi/commit/44289550)：promote durable harness API；
- [`591f22a6`](https://github.com/earendil-works/pi/commit/591f22a6)：indexed harness recovery queries；
- [`a838c069`](https://github.com/earendil-works/pi/commit/a838c069)：JSONL session fork 和 torn-tail atomic writes；
- [`14ad9801`](https://github.com/earendil-works/pi/commit/14ad9801)：harness event subscription；
- [`1dd23540`](https://github.com/earendil-works/pi/commit/1dd23540)：buffered event watches；
- [`d1a30561`](https://github.com/earendil-works/pi/commit/d1a30561)：direct event listeners；
- [`45fac5bd`](https://github.com/earendil-works/pi/commit/45fac5bd)：explicit-state harness redesign；
- [`5aeb06bb`](https://github.com/earendil-works/pi/commit/5aeb06bb)：establish durable harness type contracts；
- [`fd9a45aa`](https://github.com/earendil-works/pi/commit/fd9a45aa)：in-memory harness storage；
- [`9d5d9e4f`](https://github.com/earendil-works/pi/commit/9d5d9e4f)：harness execution primitives；
- [`686e6d7c`](https://github.com/earendil-works/pi/commit/686e6d7c)：gate harness tool execution；
- [`17fd5026`](https://github.com/earendil-works/pi/commit/17fd5026)：coding-agent 在 child processes 中 host sessions。

核心变化是“运行过程”变成“可持久化 operation”：

```text
Operation
  ├── meta: operationId / lane / sourceTip / intent
  ├── state: durable state discriminator
  ├── control: running / cancel_requested
  ├── pending entries / inbox
  ├── tool call state
  ├── retry state
  └── immutable terminal result
```

当前 `OperationState` 是一个扁平 union，覆盖 starting、checkpoint、assistant generation、effect pending、retry wait、tools、deferred、summary 和 navigation 等状态：[当前 `OperationState`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/types.ts#L178-L328)

这意味着恢复不再依赖“重新推断最后一条 message 后应该做什么”，而是从 durable operation state 继续执行。

## 二、v0.84.0/v0.85.1 的架构断点

Pi 官方 `v0.84.0` release 明确记录了 breaking change：

- legacy harness session model 被 v4 lane-based `Session`、`SessionStorage`、`SessionRepo` 替换；
- operation records、global facts、shared sequence numbers 和 tree-scoped lane views 成为核心数据模型；
- `AgentHarness` 和 v2 session API 从 experimental entrypoint 提升为默认导出；
- legacy JSONL/in-memory repository API 删除，改用 `JsonlSessionRepo` 和 `InMemorySessionRepo`；
- JSONL publication 需要 atomic `FileSystem.renameFile()`。

见 [官方 v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0)。这不是一次 API 清理，而是持久化执行模型的替换。

`v0.85.1` 本身主要是稳定性和模型支持发布，release note 没有再引入一套新的 session 架构；因此本研究把 v0.84 的 v4 lane-based runtime 视为当前 v0.85.1 的架构基础。[官方 v0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1)

## 三、v0.85.1 当前 Runtime

### 3.1 Agent Loop 仍然保持低层和通用

当前 `agent-loop.ts` 的文件注释仍明确表达：Agent Loop 全程使用 `AgentMessage`，只在 LLM 调用边界转换为 Provider `Message[]`：[当前 `agent-loop.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L1-L38)

这条边界保留了 Agent Core 的通用性：

- Agent Loop 不需要知道 JSONL、SQLite、lane 或 worker；
- AgentMessage 可以承载应用自定义消息；
- Provider adapter 只接收统一的模型消息；
- coding-agent 可以通过 Session/Harness 投影自己的上下文。

### 3.2 Harness 不是 Lane

当前 `Harness` 明确注释为“管理 lanes，但自身不是 lane”。它持有 Session、Models、HookRegistry、EventBus、lane map 和全局配置：[当前 `Harness`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L76)

当前关系是：

```text
Harness
  ├── Session
  ├── Models
  ├── Hooks / Events
  ├── process-local Config
  └── Lane[name]
        ├── branch tip
        ├── lane configuration
        ├── inbox
        ├── active operation
        └── durable drive
```

### 3.3 Lane 是“树视图 + 串行控制线”，不是简单分支名

当前公开的 `AgentLane` 同时提供：

- branch queries；
- append message/custom entry；
- accept/drive operation；
- abort/resume/compact/navigation；
- steer/followUp/nextRun；
- model、thinking level、active tools 更新；
- snapshot/watch。

接口见：[当前 `AgentLane`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts#L538-L580)

Lane 的含义不是“一个平行 agent 实例”，而是：

> 同一 session tree 上，一个具名、可序列化、拥有自身配置和 inbox 的活动视图。

这样可以把 session、branch、lane 和 operation 分开：

```text
Session：持久化世界和全局事实
Branch：entry tree 的祖先路径
Lane：在 tree 上工作的具名视图
Operation：lane 正在执行的一次 durable procedure
```

### 3.4 Drive 把执行拆成可恢复 procedure

当前 `driveOperation()` 根据 durable state dispatcher 到不同 procedure：

- `starting` / `checkpoint`；
- assistant generation / retry / effect recovery；
- tool execution；
- deferred polling；
- summary decision / generation / retry；
- navigation commit。

见：[当前 `driveOperation`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive.ts#L28-L90)

这产生了一个重要的可靠性不变量：模型请求、工具副作用、持久化 commit 和取消不再共享一个不可分割的 async function。每个 procedure 可以在 durable 边界前后恢复或重试。

### 3.5 Tool effect 通过 Gate 与 durable intent 分开

工具执行当前分成至少三个阶段：

1. 根据工具名查找并准备参数；
2. 运行 before-tool 决策、重新校验参数；
3. 经过 `Gate.admit()` 后执行外部副作用，并将结果最终化。

相关实现：[当前 tool preparation/execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/tools.ts#L8-L157)

`Gate` 将 procedure-facing admission 和 owner-facing lifecycle control 分开；abort 先进入 `aborting`，再通过 gate 防止新的 effect 被接纳：[当前 `effect-gate.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/effect-gate.ts#L1-L63)

这比旧 Agent Loop 中直接 `await tool.execute()` 更强：工具副作用有了“意图已记录 / effect 已接纳 / 结果已记录”的恢复边界。

### 3.6 Snapshot 从展示功能变成控制面读模型

Lane snapshot 会复制 lane state，读取当前 branch 的 compaction 截止点、inbox、最后 operation result、usage 和 operation 内的 streaming/retry/deferred 信息：[当前 `captureLaneSnapshot`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/lane.ts#L1728-L1785)

因此 UI、RPC client 或远程观察者不需要直接读取正在变异的内部状态，而是订阅一个可以重新获取的快照。

### 3.7 coding-agent Runtime Host 仍然负责产品边界

通用 AgentHarness 没有吞掉 coding-agent 的全部职责。`AgentSessionRuntime` 仍负责：

- 当前 `AgentSession`；
- cwd-bound services；
- session manager；
- project trust；
- session replacement 时的 shutdown 和 rebind；
- runtime 创建诊断。

当前源码明确说 runtime factory 会根据 effective cwd 重建 cwd-bound services，再创建 AgentSession：[当前 `AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts#L17-L41)

这表明 v0.85.1 同时存在两条关系：

```text
coding-agent product runtime
  └── AgentSessionRuntime
        └── AgentSession
              └── Agent / AgentHarness integration

generic agent runtime
  └── AgentHarness
        └── Session / Repo / Storage / Lane / Drive
```

Harness 是通用 durable runtime；AgentSession 仍是 coding-agent 的产品编排层。

## 四、主要架构迁移总结

| 早期责任 | 当前责任 | 迁移结果 |
| --- | --- | --- |
| Agent Loop 管理全部 tool loop | Lane Drive 管理 durable procedure | 模型生成只是 operation 的一个阶段 |
| SessionManager 读写 JSONL | SessionRepo + Storage + Search | 生命周期、存储、查询解耦 |
| message history 推断恢复位置 | OperationState 明确记录恢复位置 | 从推断恢复转为状态恢复 |
| `/branch` 改变当前对话分支 | named lanes + tree-scoped views | session、branch、lane 分离 |
| API key 在每次请求附近解析 | `Models` 注入 harness | auth/provider 与 generation 解耦 |
| `cwd`/shell 是隐含执行环境 | `Context` + ExecutionEnv + tool context | 工具可移植到不同宿主和执行器 |
| tool 数组直接执行 | registry / hooks / gate / result | 能力、策略、副作用和结果分层 |
| event 只服务 UI | events/watch/snapshot 是公共读模型 | 可被 RPC、worker、远程客户端消费 |
| 单进程 AgentSession | child-process/remote session host | 宿主和执行 session 可分离 |

## 五、Pi harness 的演进主线

Pi 的演进可以压缩为五次抽象提升：

### 1. 从消息循环到会话编排

`Agent` 负责通用模型循环，`AgentSession` 负责 coding-agent 的输入、持久化、模型选择、compaction 和扩展。这个分离使 CLI、RPC、SDK 共用同一运行语义。

### 2. 从日志保存到 Session Tree

JSONL 不再只是 transcript，而是带 parent/leaf、compaction、branch summary、custom entry 和 fork 的 session tree。历史不被原地改写，当前上下文由 tree projection 产生。

### 3. 从函数执行到 Tool/Effect 生命周期

工具调用先准备、校验、hook，再进入 effect gate，最后产生 durable tool result。执行取消、错误、重试和结果回注都获得明确边界。

### 4. 从 Session API 到 Durable Operation

运行中状态不再只存在内存；generation、retry wait、deferred polling、summary 和 navigation 都能用 operation state 表达。恢复从“猜测下一步”变成“继续某个状态机叶子”。

### 5. 从单 Session 到 Lane/Worker/Service Runtime

named lane、child-process session host、remote session client、server-scoped service 和后续 Chord/服务化提交，说明 Pi 正在从嵌入式库演进为可以被多个宿主、worker 和远程客户端承载的 agent runtime。

## 六、建议展示的历史版本节点

`v0.79.8` 保留为已有的单版本分析，不承担“从哪里开始”的基线角色。若要把 Pi 的架构演进做成少量可读的历史展示，建议优先选下面这些节点；它们不是简单的版本等距采样，而是责任边界或持久化模型发生变化的版本。

| 展示节点 | 固定 commit | 为什么具有历史意义 | 建议观察面 |
| --- | --- | --- | --- |
| `v0.5.4` | [`f579a3f1`](https://github.com/earendil-works/pi/commit/f579a3f112824c1dceaa2d0591abbec54d00c1a0) | 早期 monorepo 与多 package lockstep 形成可发布的 Agent/CLI 产品边界 | Agent、coding-agent、package 分层 |
| `v0.45.0` | [`e22feba4`](https://github.com/earendil-works/pi/commit/e22feba494667b511364c2a45a23d05d6404187e) | AgentSession、typed RPC、SDK 与统一 extension 方向成形 | 通用 Agent Core 与产品 session 的分离 |
| `v0.58.0` | [`c0065325`](https://github.com/earendil-works/pi/commit/c00653255da2abc31192b3c31d0e88a768ae4c52) | tool hooks 以及并行/顺序 tool execution 进入稳定演进主线 | tool 生命周期、策略与执行边界 |
| `v0.65.0` | [`8c1831bd`](https://github.com/earendil-works/pi/commit/8c1831bd5c93a8769e7f83307d8c8480f5e398d8) | `AgentState` 生命周期和 mutation API 重新整理 | 状态所有权、事件和 session runtime |
| `v0.72.0` | [`196226bc`](https://github.com/earendil-works/pi/commit/196226bcc071f751bc0c6996fb55bc52e8aa0e6d) | `shouldStopAfterTurn` 等边界使 turn、queued input 和继续执行语义显式化 | 交互控制、steering、终止条件 |
| `v0.80.0` | [`f08e968c`](https://github.com/earendil-works/pi/commit/f08e968c83d92bce5f5fd2f7f20ef37f8cf04a39) | Models API 成为显式依赖与认证边界，旧兼容层被移除 | model/auth 注入与 harness 解耦 |
| `v0.84.0` | [`a5f43bf8`](https://github.com/earendil-works/pi/commit/a5f43bf8aff3c55752432655f7334e3dafd1e256) | v4 lane-based `Session`/`Storage`/`Repo` 与 durable operation 替代 legacy harness | session tree、lane、恢复和持久化执行 |
| `v0.85.1` | [`d981de12`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477) | 当前研究终点，验证 v4 harness 作为已发布 runtime 的形态 | AgentHarness、Lane、Drive、OperationState |

如果后续只制作四张历史架构图，优先顺序建议是：`v0.45.0`（session/SDK 分离）、`v0.58.0`（tool execution 平面）、`v0.80.0`（Models/认证边界）和 `v0.84.0`（v4 durable lane-based harness）。`v0.85.1` 作为当前发布版总览；`v0.79.8` 则作为已有的独立快照，用于观察 v0.80/v0.84 之间的短期变化，而不是作为全史起点。

## 七、研究判断：哪些是稳定不变量，哪些仍在快速演进

### 稳定不变量

- Agent Loop 只在模型边界转换消息格式；
- coding-agent 产品语义位于通用 Agent Core 之上；
- session history 采用追加式 entry/tree，而不是覆盖式上下文文件；
- compaction 是 context projection，不是简单删除历史；
- 工具执行必须经过参数校验、hook 和可取消执行边界；
- provider/auth 不应被低层 harness 隐式拥有；
- fork/branch 需要保留来源关系和可解释的历史边界。

### 快速演进部分

- v2/v4 harness 的 operation slices 和 public API；
- JSONL 与 SQLite 的职责分配；
- lane、session、branch 的跨进程 ownership；
- remote session protocol 和 service runtime；
- Chord 等服务化基础设施在 `v0.85.1` 之后的方向。

## 八、当前版本与后续研究边界

本文终点是 `v0.85.1`，不是当前 `main` 分支。`v0.85.1` 之后的提交已经继续推进 Chord、remote service、named fork streaming 和新的 durable harness 细节；这些不作为本报告的已验证实现结论。

后续若研究 `v0.85.1` 之后的演进，应单独建立新版本快照，重点关注：

- lane-owned runtime 是否成为默认执行模型；
- session worker 与 server service 的最终 ownership；
- remote session 的事件/快照/写入一致性；
- durable operation 是否继续收敛为更通用的 workflow/state-machine runtime；
- Chord 的 service/facet/delta 模型是否进入稳定公共边界。

## 未确认事项

- 本文基于 Git 历史、版本 changelog、`v0.85.1` 源码和测试结构分析，未执行真实 Provider、长时间断电恢复或跨进程故障注入实验。
- Pi 的部分 harness 设计在历史中经历了 experimental、v2、v4 和并行开发分支；commit subject 能确认演进方向，但不能单独证明每个中间设计曾成为稳定公共 API。
- `v0.84.0` release 明确说明 v4 lane-based API 已成为 breaking public change；但 v0.85.1 之后的 Chord、remote service 和更晚 harness work 不应倒推为 v0.85.1 已经具备的稳定能力。
- 代码图谱用于确认当前模块关系；架构阶段划分和“责任迁移”的描述属于基于提交、源码和 release notes 的解释。
