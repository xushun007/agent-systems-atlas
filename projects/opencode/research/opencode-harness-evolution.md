# OpenCode Harness 的架构演进研究：项目诞生至 v2.0.0

## 研究范围

本文研究 OpenCode 从项目诞生到 `v2.0.0` 的整体 Runtime/Harness 演进。`v1.0.0` 是一个重要的产品发布节点，但不是历史起点；`v2.0.0` 是当前研究终点和一次大型 Runtime 重构的发布收束点。重点关注：

- Session、Prompt、Message、Step 和执行协调如何变化；
- 从单体 `packages/opencode` 到 `core/server/protocol/sdk/tui/codemode` 的边界迁移；
- 持久化从文件/对象 Storage 到 SQLite、Drizzle、事件和 Projection 的变化；
- 工具、权限、MCP、插件和 Code Mode 如何成为能力平面；
- server、TUI、SDK、ACP 和桌面客户端如何共享同一个运行时；
- workspace、location、worktree、PTY 和后台任务如何进入 Agent 执行边界。

分析版本：

- `v1.0.0`：`b9a39b816c92592e824c68cdc9a48acf7717e2a2`，2025-10-31；
- `v2.0.0`：`63f7ceecbed2d7d9a627518d935dd963b9d4ac9f`，2026-09-11。

本文使用 v1.0.0 和 v2.0.0 的源码稀疏工作树，并读取从 2025-03-21 初始提交到 v2.0.0 的约 21,682 个可追溯 commit；其中 v2.0.0 附近的提交历史加深到 1,001 个 commit。源码引用均固定到 GitHub commit；commit subject 用于识别演进方向，关键架构结论以源码为准。

## 核心结论

OpenCode 的全史不是单纯从一个 Agent Loop 线性长大，而是经历了“轻量 CLI/TUI → 工具化 coding agent → 持久化 Session/Server → 产品化客户端 → v2 Effect Runtime”几次边界移动。最近的 v1 → v2 不是一次普通的模块拆分，而是把 Agent 产品从“单体服务中的 Session + Tool Loop”重构成一个由 Effect Service 组成的 Runtime 平台：

```text
v1.0.0：
CLI / TUI
  └── packages/opencode
        ├── Instance / Project
        ├── Session / Prompt / Message
        ├── Storage
        ├── ToolRegistry / Permission
        ├── MCP / Provider
        └── Hono Server

v2.0.0：
Clients: TUI / CLI / SDK / ACP / Desktop
  └── Server + typed Protocol API
        └── Core Effect Runtime
              ├── Location / Instance / Workspace
              ├── Session admission + Inbox
              ├── Session Execution + Run Coordinator
              ├── Runner → Step → LLM stream / Tool fibers
              ├── SQLite / Drizzle Store + projections
              ├── Permission / Environment / PTY
              ├── Plugin generations / MCP / Skills
              └── CodeMode catalog / interpreter
```

从全史看，最重要的变化可以概括为五个责任迁移：

1. **从函数式 Session Prompt 到可协调的 Session Execution**：用户输入不再直接调用一个 prompt 函数，而是进入 Session Inbox，由 Execution/Coordinator 决定何时唤醒、steer、queue、interrupt 或恢复。
2. **从内存/文件状态到数据库事实与 Projection**：Session、Message、Part、事件、inbox、execution claim 和 workspace 状态由数据库承载，UI 读取 Projection，而不是直接持有运行状态。
3. **从工具注册表到能力编排面**：工具注册、Schema、权限、MCP、插件动态更新、Code Mode namespace 和执行上下文被拆开，模型看到的工具可以是能力目录的投影。
4. **从单体 CLI 到可复用服务 Runtime**：Server、SDK、ACP、TUI 和桌面端共享 typed protocol；Core 通过 Effect 服务和 Location 绑定执行环境，不再把 TUI 作为生命周期中心。
5. **从单一 Agent 产品到多入口平台**：早期能力围绕 TUI 交互累积，之后逐步形成 CLI、Server、SDK、ACP、Desktop、Plugin、MCP 和 CodeMode 共同消费的 Runtime。

## 一、项目诞生至 v1.0.0：从轻量 Agent 到产品化 coding agent

### 1. 初始阶段：模型调用、工具和 TUI 紧耦合

2025-03-21 的 [`4b0ea68d`](https://github.com/anomalyco/opencode/commit/4b0ea68d7af9a6031a7ffda7ad66e0cb83315750) 是项目初始提交。随后 `e7258e38`、`005b8ac1`、`904061c2` 建立初始 Agent、Provider 和工具；`cfdd6872` 增加 LSP 支持，`eb9877ee` 增加 Sourcegraph 工具。

早期结构的核心特征是：

```text
TUI
  └── Agent
        ├── Provider
        ├── Tool functions
        ├── file/git/LSP helpers
        └── status / permission UI
```

这时还没有独立的 Session Runtime。模型请求、工具调用、交互状态和 UI 反馈都在同一产品进程中演进。

### 2. Agent Loop 成形：工具结果、重试和文件历史进入核心

`bbfa60c78`（2025-04-16）重新实现 Agent/Provider 并加入 file history；`2de512741` 引入 tool-call streaming；`0697dcc1` 开始处理 nested tool calls 与 result metadata；随后 `bab17d752`（2025-05-08）明确提交为 `feat: session manager`。

这一步完成了从“一次模型请求”到“连续工作会话”的第一次跃迁：工具调用必须可流式展示、可取消、可重试，文件变更需要进入 session history，Agent 不再只是一次性函数。

### 3. Session、权限和持久化形成产品内核

`526a8ea19`（2025-06-01）重构 application path handling 与 data storage architecture；`786db364d`（2025-06-02）加入 permission system；`7f8f46f9f`（2025-06-04）重构 session module 与错误处理；`6f1847542`（2025-06-24）加入 session deletion；`98734ff28`（2025-06-20）整合 session context 和 global config。

这里的架构变化不是“增加一个 Session 类型”，而是形成了几个产品持久化不变量：

- session 有稳定 identity、project/directory 归属和可恢复消息历史；
- 工具执行需要经过 permission，而不是由模型输出直接触发；
- 文件变更、snapshot、revert 和 diff 成为 session 体验的一部分；
- TUI 可以离开当前消息流，重新加载历史、切换 session 和恢复工作。

### 4. MCP、Server、外部工具和子 Agent 扩大 Harness 边界

`37c34fd39`（2025-06-03）加入 MCP 支持；`f6ed59bf4`（2025-06-11）重构 external tools organization 并加入 file search API；`29a6603a8`、`442e1b52a` 开始整理 CLI run、provider configuration 和 server handling；`a454ba889`、`ce7489f6d` 引入 subagent 方向；`4e4cff49c` 等提交持续完善 Task tool。

OpenCode 的 Harness 边界由此从：

```text
模型 → 内置工具 → 当前项目
```

扩展为：

```text
模型
  → 内置工具 / MCP / 外部工具 / subagent
  → permission / session / project
  → server API / TUI / CLI
```

### 5. TUI 重构与 v1.0.0

2025-06-12 到 06-13 出现大规模 `wip: refactoring tui`；`96bdeb3c7`（2025-10-31）提交 `OpenTUI is here`；随后 `1eeba770b` 增加 v1.0 upgrade guide，最终 `b9a39b816` 发布 v1.0.0。

官方 v1.0.0 release 明确说明，TUI 从 Go/BubbleTea 重写为 Zig + SolidJS 的 OpenTUI，但继续连接同一个 OpenCode server。[官方 v1.0.0 release](https://github.com/anomalyco/opencode/releases/tag/v1.0.0)

因此 v1.0.0 的历史意义是：**产品交互层完成一次重大重写，但 Server/Session 后端仍延续 v1 单体 Runtime。** 它不是 v2 Backend 重构的起点，而是旧 Runtime 产品化成熟的展示节点。

## 二、v1.0.0 → v2.0.0：Backend Runtime 重构

## 三、v2 重构的版本节点

### 1. v1.0.0：产品化 TUI，但 Runtime 仍是单体

OpenCode 官方 v1.0.0 release 明确说明：TUI 从 Go/BubbleTea 重写为 Zig + SolidJS 的 OpenTUI，但仍连接同一个 OpenCode server。[官方 v1.0.0 release](https://github.com/anomalyco/opencode/releases/tag/v1.0.0)

这说明 v1.0 的重大变化主要发生在产品 UI 层，而不是 Agent Runtime 的内部边界。v1 的核心仍集中在 `packages/opencode`：

- `Session.Info` 同时携带 session identity、project、directory、parent、title、share、revert 和时间状态；[v1 `Session.Info`](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts#L25-L91)
- `Session.createNext()` 直接通过 `Storage.write()` 创建 session，并通过 Bus 发布事件；[v1 session create](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts#L126-L177)
- `Session.fork()` 读取旧 session 的消息和 parts，重新生成 ID 后复制到新 session；[v1 session fork](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts#L92-L125)
- Server middleware 通过请求中的 `directory` 创建 `Instance`，再在同一个单体包中提供 Session、Config、Tool、MCP、Permission、TUI 和 Project route；[v1 server instance boundary](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/server/server.ts#L82-L147)

v1 的运行链更接近：

```text
HTTP/TUI request
  → Instance(directory)
  → SessionPrompt
  → model stream
  → ToolRegistry
  → Storage / Bus
```

Session 是持久化对象和 Prompt 编排对象，但还不是一个独立的、可恢复的执行调度器。

### 2. v2 的准备阶段：从 UI 重构进入 Backend/Runtime 重构

v2 的提交历史显示，它不是从 v1.0.0 release 当天突然出现，而是由一条持续数月的迁移线形成：

- `4c0feeebb`：增加 v2 backend adapter；
- `a1b274e6f`：加入 v2 CLI 支持；
- `df04a0133`：将 provider integrations 移植到 v2；
- `dc99c600b`：暴露 canonical schema contracts；
- `cd0b27485`：简化 v2 prompt lifecycle 与 execution coordination；
- `64e4f6f91`：将 `run` 命令路由到 v2 API；
- `712d4fb80`：增加 v2 backend adapter；
- `9b8282ad3`、`4a93972a7`：形成 v2 TUI/plugin runtime；
- `4c9a4309c`、`77d3289d2`：持续将 dev 能力合并到 v2；
- `d4b85f8d8`：开始跳过 legacy config reads；
- `fe506f201`：明确 v1/v2 plugin 共存和迁移说明。

因此，v2 的本质不是“换一套 UI”，而是建立第二套 Backend Runtime，并在一段时间内让 v1 和 v2 并存。

### 3. v2.0.0：从迁移分支收束为新的默认 Runtime

v2.0.0 release commit 本身是发布修复 `63f7ceec`，并不代表所有架构变化都发生在一个 commit 中。它之前的关键收束包括：

- `6e954f75e`：隔离 Session admission 和 controls；
- `8ba434b59`：将 projected Session reads 移入 Store；
- `762291b2a`：Session 创建时持久化 durable metadata；
- `a38cbd42a`：隔离 shell tool preparation；
- `4112698e7`：简化 Session Runner control flow；
- `2602dcd0a`：封装 physical attempt execution；
- `cf347cd5e`：让 sessions 在运行 steps 前推进；
- `e84938b30`、`f683eef5f`：Session warming 和可观察性；
- `ded8a492d`：重启后恢复 background jobs；
- `312651f68`：将 session permission handling 纳入 v2 TUI。

所以 `v2.0.0` 是一条长期迁移线的发布收束点，而不是一个孤立 rewrite commit。

## 四、v1 → v2 的架构边界变化

| v1 责任 | v2 责任 | 架构含义 |
| --- | --- | --- |
| `packages/opencode` 单体包 | `core/server/protocol/sdk/tui/plugin/codemode` | 产品入口与 Runtime 解耦 |
| `SessionPrompt` 直接驱动模型 | `SessionInbox` → `SessionExecution` → `SessionRunner` | 输入接纳、执行、恢复分离 |
| `Storage` 保存 session/message/part | SQLite + Drizzle + `SessionStore` + event/projection | 事实记录和读模型分离 |
| `Session.Info` 可变对象 | Session schema + events + store projections | 变更通过事件和持久化边界收敛 |
| `ToolRegistry` 统一注册工具 | Tool runtime + Permission + Plugin + MCP + CodeMode | 工具存在、暴露和执行分层 |
| 请求的 `directory` 建立 Instance | `Location` / `Instance` / `Workspace` / `Worktree` | cwd 成为可寻址执行上下文 |
| Hono server 与核心逻辑同包 | typed Protocol API + Server handlers | 多客户端共享协议和生命周期 |
| TUI 是主要产品入口 | TUI、CLI、SDK、ACP、Desktop 都是 Client | Runtime 不再依赖某个 UI |

## 五、v2.0.0 当前 Runtime

### 3.1 Location / Instance 是执行上下文边界

v2 将项目目录、workspace、server location 和 instance service 作为 Core 的服务依赖。Session 不再只使用一个全局 `process.cwd()`；Server API 在创建 session 时显式传入 `location`，默认值才是当前进程目录。[v2 session API](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/server/src/handlers/session.ts#L112-L128)

这使以下对象可以分开：

- server 连接地址；
- 当前 workspace/project；
- session 绑定的 directory/location；
- worktree 或远程 SSH server；
- PTY、filesystem、shell 和 MCP 的执行环境。

因此 OpenCode v2 的环境抽象比 v1 的 `Instance(directory)` 更接近“位置绑定的运行时实例”，但它仍然主要服务本地/远程 Server 组合，而不是 Codex 那种以 Environment policy 为中心的安全模型。[v2 environment service](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/environment/environment.ts#L1-L180)

### 3.2 Session 是控制面，不只是 transcript

v2 `Session.make()` 注入 Bus、Database、SessionStore、Instance、SessionExecution、SessionInbox、filesystem 和 Scope。它提供 get、view、rename、permissions、switchAgent、switchModel、inbox、prompt、shell、skill、compact、wait 和 resume 等操作。[v2 Session service](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/session.ts#L1-L180)

用户输入首先进入 `SessionPrompt.prepare()`，随后由 `SessionInbox.admit()` 记录，最后通过 `SessionExecution.wake()` 驱动执行。这个顺序非常重要：Prompt preparation 可以失败；只有准备成功后，输入才被 admission；正在执行的 session 由 inbox delivery 决定是 steer、queue、cancel 还是继续。

`SessionExecution` 对每个 session 管理 process-local active execution，并把运行生命周期写成 durable claim：starting 与 started event 同一事务提交；正常终态释放 claim；如果进程在 shutdown、crash、SIGKILL 或 eviction 时消失，未释放的 claim 就成为下次启动恢复的依据。[v2 execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90)

### 3.3 Inbox 取代同步 Prompt 调用

v1 的 `SessionPrompt` 直接消费输入并推进模型；v2 将输入变成带 delivery 语义的 durable item：

```text
prompt / compact / shell / synthetic
       ↓
SessionInbox.admit()
       ↓
delivery = steer | queue
       ↓
SessionExecution.wake()
       ↓
SessionRunCoordinator
       ↓
SessionRunner.drain()
```

这样可以表达：

- 模型运行中用户追加指令，但不一定立即打断当前工作；
- steer 输入在当前执行边界内继续；
- queue 输入留给下一次 turn；
- compaction、move、shell completion 和 synthetic message 也进入同一控制通道；
- client 断开后，server 仍然拥有执行完成和结果记录的责任。

这是 OpenCode v2 最接近“产品级 harness”的部分：它把用户交互的并发问题从 TUI 状态提升为 Core 的 admission/coordination 语义。

### 3.4 Runner / Step 把模型调用和物理执行拆开

v2 `SessionRunner` 暴露 `drain()`，它消费已经记录在 Session history 中的 durable work；如果执行需要迁移到新的 Location，则返回 continuation，而不是由上层重新猜测下一步。[v2 runner contract](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/index.ts#L1-L35)

每个 `SessionStep.attempt()`：

1. 捕获起始 Snapshot；
2. 建立 LLM event publisher；
3. 打开 provider stream；
4. 对 tool-call 启动 fiber；
5. 保留 provider/tool source order；
6. 处理 context overflow、retry、interrupt、tool result 和最终 settlement。[v2 step attempt](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/step.ts#L64-L150)

这和 Codex 的 Step snapshot 不完全相同。OpenCode 的 Step 更接近一次“物理模型尝试 + 工具并发执行”的生命周期；Session Inbox 与数据库 claim 才承担跨输入和重启恢复。

### 3.5 持久化由 Storage 对象变为 Database + Store + Projection

v1 通过 `Storage.write/read/update/list` 保存 Session、Message、Part 和 Share；Session 本身可以在应用代码中直接更新。[v1 session storage](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts#L126-L225)

v2 引入：

- SQLite database 与 Drizzle schema；
- Session、Message、Part、Event、Inbox、Workspace、Execution claim 等关系；
- `SessionStore` 作为读取和 projection 边界；
- migration、session message cursor、context epoch、event-sourced input 和 worktree migration；
- lazy/portable environment 与 server process 的数据库 ownership。

这意味着 v2 的 Session 不是一个可以随意 mutate 的 JSON 对象，而是由“事实记录 + projection + service API”组成。TUI 看到的是 Store 读模型，执行器写入的是 event/database，二者通过 Bus 与 protocol 同步。

### 3.6 工具面从 Registry 变为动态能力平面

v1 Server 直接暴露 `ToolRegistry.ids()` 和 tool schema endpoint；Tool Registry 同时承担内置工具与动态工具注册。[v1 tool registry endpoint](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/server/server.ts#L170-L220)

v2 将工具能力分成多个来源：

- 内建 Tool runtime：read、edit、write、patch、shell、grep、glob、web、question、task；
- MCP tools 与 MCP authorization；
- Plugin transforms、tool updates/removal 和 live plugin generations；
- Agent/skill/instruction 提供的上下文；
- CodeMode catalog，将大量工具变成 namespace、signature、schema 和可按预算投影的目录；
- Permission rules 与 filesystem/environment policy 决定调用是否可以执行。

`CodeModeCatalog.summarize()` 会在固定 inline budget 中保留 namespace 概览，再选择部分 tool listing；这说明 v2 的工具系统不仅决定“工具能不能执行”，还决定“模型当前看到哪些工具信息”。[v2 CodeMode catalog](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/codemode/catalog.ts#L44-L139)

但与 Codex 的 per-Step Tool Plan 相比，OpenCode v2 更偏向“代码模式和插件扩展”：工具目录可以被注入 instructions/CodeMode，减少模型直接面对大量 schema；权限和实际执行仍在 Core Tool/Permission/Environment 路径中收敛。

### 3.7 Plugin 从静态加载项变成运行时参与者

v2 的提交历史反复出现 plugin generation、activation、live package update、tool update/removal、request hook、session hook、MCP transforms 和 plugin-owned UI。到 v2.0.0，插件已经不只是启动时读取配置：

- 插件 activation 需要 readiness/awaitActivation；
- 插件失败可以被隔离，不必击穿整个 Server；
- 插件可以修改工具、MCP、Session request、model generation options 和 UI panels；
- live update 需要 generation identity、刷新和失败恢复；
- TUI 与 Server 都要展示 plugin readiness/failure。

这形成了一个动态扩展平面，但也增加了 Prompt 与 capability 的一致性问题：插件更新可以改变未来 Session/Step 的工具集合，不能悄悄改变已经开始的物理 attempt。

### 3.8 Server / Protocol / SDK 让 Runtime 脱离 TUI

v2 将 API contract 提升到 `@opencode/protocol`，Server handler 通过 typed HTTP API 注册 `session.list/create/import/export/active` 等操作；TUI、CLI、SDK、ACP 和 Desktop 都通过这一边界访问 Core。[v2 session handler](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/server/src/handlers/session.ts#L27-L180)

Server 的职责包括：

- 协议请求验证与错误映射；
- location/session middleware；
- Session、MCP、Provider、Permission、PTY 和 filesystem handler；
- client 断开后的后台执行；
- session event stream 与状态同步；
- server/service/stdio 模式以及远程连接。

因此 v2 的 server 不是薄 HTTP wrapper，而是 Agent Runtime 的宿主边界；但核心执行状态仍在 Core Session/Execution/Database 中，Server 不应取代 Session ownership。

## 六、OpenCode 的架构演进阶段

### 阶段 0：单体 Agent 产品

早期 OpenCode 把 Provider、Session、Tool、MCP、TUI、Server、Storage 和 Project 放在同一个 `packages/opencode` 内。优点是产品迭代快、调用链短；缺点是任何新入口都必须理解单体内部约定。

### 阶段 1：v1.0 产品 UI 稳定化

v1.0 的主要可见变化是 OpenTUI 重写和产品交互收敛，而 Backend 仍保持单体。Session 是持久化对象，Prompt 是驱动执行的函数，Storage 是通用 KV/对象访问，Bus 是跨模块事件机制。

### 阶段 2：v2 Backend 双轨迁移

v2 先以 adapter、canonical schema、backend adapter、v2 API 和 v2 plugin entrypoint 的形式出现。v1 与 v2 并存，使 TUI、CLI、Desktop、SDK 可以逐步迁移，而不是一次性替换整个产品。

### 阶段 3：Effect Service 化

v2 Core 使用 Effect 的 `Service`、`Layer`、`Scope`、`Fiber`、`Stream`、`Schema` 和结构化错误。它的价值不是“换了异步库”，而是让 Database、Bus、Instance、Execution、Runner、Permission、Snapshot、ToolOutput 和 LLM Client 成为可替换的 Runtime 依赖。

### 阶段 4：Durable Session Execution

Session Inbox、Run Coordinator、Runner、Step、durable claims、event/projection 和 restart recovery 共同把 Session 从 transcript container 变成可持续运行的任务控制器。

### 阶段 5：Capability / Plugin / CodeMode 平台化

工具 namespace、CodeMode catalog、MCP transform、live plugin generation、session hooks 和 permissions 让 OpenCode 不再只是内置工具集合，而是一个可扩展 Agent 平台。

### 阶段 6：多客户端和多位置 Runtime

Location、workspace、worktree、SSH server、PTY、ACP、SDK、Desktop 和 TUI 共同推动 Core 成为可被多个客户端消费的服务 Runtime。v2.0.0 是这条路线的稳定发布点，但不是演进终点。

## 七、与 Codex、Pi 的比较定位

这一节只用于确定后续横向研究的比较维度，不展开项目间全面比较。

OpenCode 与 Pi 类似，都从“模型循环 + 工具”向通用 Runtime 演进；但 OpenCode v2 的产品控制面比 Pi 更强：它有成熟的 Server、TUI、SDK、ACP、Desktop、workspace、permission、PTY 和数据库执行协调。

另一方面，OpenCode v2 的抽象方式与 Codex、Pi 都不同：

- 相比 Codex：OpenCode 更强调 TypeScript/Effect 服务组合、可扩展插件和 CodeMode；Codex 更强调 Rust Core、Step/Environment 一致性和权限安全策略；
- 相比 Pi：OpenCode 更早把产品 Server、数据库和客户端协议整合进 Runtime；Pi 更强调通用 Harness、Lane、Drive 和 Operation 原语；
- 相比 v1：v2 不只是拆 package，而是改变了 Session 的输入接纳、执行协调和持久化所有权。

可以把三者的当前关注点概括为：

```text
Codex   → control / policy / environment consistency
Pi      → reusable durable execution primitives
OpenCode→ product server + extensible Effect runtime
```

## 八、稳定不变量与未确认事项

### 稳定不变量

- Session 是用户工作和历史的主要 identity；
- 模型调用必须通过工具执行和结果回写形成闭环；
- Project/location/workspace 决定文件、shell、MCP 和插件的作用域；
- TUI 不应独占 Runtime 状态，server/client protocol 承担跨入口同步；
- compaction、revert、fork、import/export 和 session resume 都需要保留可解释的历史关系；
- 插件和 MCP 可以扩展能力，但最终执行仍必须回到 Core 的 permission/tool/environment 边界。

### 未确认事项

- 本次没有执行真实 Provider、断电、进程被 kill 后重启恢复或多 Server 并发实验；
- `v2.0.0` release commit 本身主要是发布修复，v2 架构结论来自其前 1,000 个 commit 与固定源码；
- v1.0.0 的源码稀疏工作树与 v2.0.0 主工作树使用不同目录；Atlas 不保存源码副本；
- CodeMode 的完整 sandbox、表达式解释器和 provider prompt 投影仍需单独建立机制级分析；
- v2 中部分 `v1` compatibility/migration 文件仍然存在，不能简单推断所有 v1 API 已经从运行时完全消失；
- Graphify 已用于当前 v2 源码的结构提取准备，但本次图谱输出未作为单独 Atlas 资产保存，模块关系结论仍以源码阅读为主。
