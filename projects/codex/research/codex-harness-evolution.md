# Codex Harness 的 Runtime 演进研究

## 研究问题

本文回答一个限定问题：作为重要的 coding agent，Codex 的 harness 如何从一个“模型调用 + shell 沙箱 + TUI”逐步演进为能够承载长会话、持久化恢复、远程执行、多环境、多 Agent、插件/MCP、自动审批和宿主进程治理的 Runtime。

这里的 harness 不是单个 Agent loop，而是围绕模型调用提供以下运行时条件的系统集合：

- 接收、排队、steer、interrupt 和结束用户工作；
- 构造模型每次请求看到的上下文与工具；
- 把工具调用路由到正确的执行环境，并收敛到 Sandbox、审批和 Guardian；
- 记录可恢复的事实，支持 resume、fork、rollback 和迁移；
- 在 TUI、Exec、SDK、远程客户端、daemon 和多 Agent 之间提供一致的生命周期语义。

分析基线是上游仓库 `openai/codex` 的 `rust-v0.154.0`，commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`，发布于 2026-09-09。该 checkout 具有从 2025-04-16 初始提交到该版本的 10,374 个可追溯 commit；文件内容使用 `blob:none` 的 partial-clone 过滤获取，本文的 commit 结论来自本地 Git 历史，发布特性再与 [官方 0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0) 对照。

## 核心结论

Codex harness 的主线不是“把 Agent loop 做得更复杂”，而是持续把原本隐含在一次交互里的运行时状态拆成可治理、可恢复、可并发的边界。其架构演进可以归纳为六次边界移动：

1. **从单次交互到 Session/Submission/Turn 生命周期**：模型采样不再直接等于一次用户操作；Session 负责长生命周期，Submission 负责输入串行化，Task/Turn 负责可取消执行。
2. **从 Turn 级状态到 Step 级一致性快照**：模型、审批、MCP、工具暴露、环境和 `AGENTS.md` 不再以“当前全局状态”隐式读取，而是在每次 sampling step 前捕获并固定。
3. **从本地 cwd 到 Environment-owned execution**：工具不再默认运行在唯一本地工作目录；cwd、workspace roots、文件系统、网络、平台、Shell 和远程 executor 被组合为执行环境。
4. **从 prompt history 到可重建的 Rollout/Thread Store**：历史不只是供模型继续阅读的文本，而是能够支撑 resume、fork、rollback、压缩、分页历史和 daemon recovery 的事实记录与派生状态。
5. **从工具注册表到策略化能力平面**：工具的“存在、模型可见、延迟发现、能否并发、能否执行、是否需要审批”被拆开；MCP、插件、Extension、Hook、Code Mode 和动态工具接入同一运行时能力平面。
6. **从 CLI 进程到 Application Host**：app-server、daemon、远程控制和多客户端成为 harness 的一部分；Core 保留 Session/Turn/Tool 的执行语义，宿主负责协议、队列、恢复、连接、配置和进程治理。

因此，`Session → Submission → SessionTask → Turn → Step → Tool/Observation` 仍是控制主链，但已经不是完整架构。到 `0.154.0`，Codex 实际上形成了四个相互咬合的平面：

| 平面 | 主要职责 | 当前代表边界 |
| --- | --- | --- |
| Control plane | 接纳请求、排队、steer、interrupt、生命周期、客户端通知 | `app-server`、`Session`、`Submission`、`SessionTask` |
| Reasoning/Context plane | 上下文构造、压缩、动态注入、Step 快照、历史重建 | `run_turn()`、`StepContext`、Rollout reconstruction |
| Execution/Safety plane | 工具暴露、审批、Guardian、Sandbox、远程/本地执行 | `ToolRouter`、`Environment`、`Sandbox`、MCP |
| Persistence/Recovery plane | Rollout、State DB、Thread Store、队列、附件、恢复和 fork lineage | `RolloutRecorder`、`ThreadStore`、`ThreadManager` |

这四个平面不是四个独立服务，而是由 Step 和 Turn metadata 连接：Step 固定一次请求的能力与策略，Turn 固定用户可见的生命周期，Rollout 保存事实，app-server 保存宿主级的并发与恢复秩序。

## 一、演进时间线：从 CLI 到 harness

### 1. 2025-04：先建立安全执行外壳

早期 Codex 的核心问题是：模型可以提出 shell/编辑操作，但这些操作不能直接等价为宿主机执行。最早的关键演进包括：

- `b62ef70d2a`：修复 suggest 模式下 shell 命令自动执行的问题；
- `ae5b1b5cb5`：允许为 Sandbox 增加 writable roots；
- `ca7ab76569`：加入用户定义的 safe commands 和 approval logic；
- `965420cfc5`：从配置文件读取 approval mode；
- `31d0d7a305`：将 Rust CLI 初始实现导入 `codex-rs/`；
- `58f0e5ab74`：引入 `codex_execpolicy`，把“命令是否安全”从 TUI 判断中抽出。

这一阶段的 harness 仍然是单体 CLI，但已经建立了后来一直保留的基本分离：**模型提出动作，策略层判定，平台 Sandbox 执行**。这解释了为什么后续的 Permission Profile、Guardian 和远程执行仍然围绕执行策略而不是简单的“确认弹窗”发展。

### 2. 2025-05：持久化和 MCP 把交互变成长会话

`0b46df2677` 一组提交开始把 Rust CLI 的 rollout 保存下来；`83961e0299`/`21cd953dbd` 建立 MCP types/server，`2cf7aeeeb6` 建立 MCP client，`67dfca74b9` 起支持 `config.toml` 中的 MCP servers。此时 Codex 已经不再只是一次性地运行命令：

- 模型上下文需要跨 turn 延续；
- 工具集合可以由外部服务器动态提供；
- MCP tool call 的结果必须进入可重放历史；
- resume 的对象从“输入框内容”变为“会话及其事件”。

MCP 最初作为产品入口（包括 `codex mcp-server`）出现，后来逐步被吸收为 Session Runtime 的能力；这条路线最终在 `0.154.0` 删除独立 `codex mcp-server` 入口，但没有删除 MCP 能力本身。[官方 release 也明确记录了该入口的移除](https://github.com/openai/codex/releases/tag/rust-v0.154.0)。

### 3. 2025-08—10：Session、Turn 和 Submission 成为真正的控制内核

这一阶段是 harness 最重要的一次内核化。关键提交包括：

- `cf7a7e63a3`（2025-08-14）：在 `Codex::spawn()` 中创建 `Session`；
- `17aa394ae7`（2025-08-15）：引入 `Op::UserTurn`；
- `250b244ab4`（2025-09-25）：full state refactor；
- `789e65b9d2`（2025-10-21）：用 `TurnContext` 传递 turn 身份与状态，而不是只传 `sub_id`；
- `5ba2a17576`（2025-10-28）：拆分 submission loop。

这组变化把“运行一次模型请求”的代码，改造成一个能接受异步外部事件的状态机：

```text
client / TUI / exec / SDK
        │
        ▼
Submission queue ── user input / steer / approval / settings / interrupt
        │
        ▼
Session ── owns services, active task, lifecycle events
        │
        ▼
SessionTask / RegularTask
        │
        ▼
TurnContext → run_turn() → sampling ↔ tool execution ↔ observation
```

架构含义是：

- 输入不再要求调用方同步等待当前模型请求结束；
- interrupt 和 steer 可以在 Turn 运行期间进入 Session；
- approval response 不再是 TUI 层的特殊回调，而是 Session 输入；
- 任务结束、取消、失败和中断可以统一发出终态与 idle 生命周期；
- 未来 app-server、远程客户端和多 Agent 可以复用同一控制内核。

### 4. 2025-08—12：app-server 从辅助入口变成宿主边界

2025-08 的 `2c3d906f19` 开始探索新的协议格式，随后 `e7bad650ff` 支持传统 JSON-RPC；`414fe640eb`（2025-09-29）明确分离 `codex mcp` 与 `codex app-server`。之后 app-server 逐步获得：

- thread/start、thread/resume、thread/fork、turn/start 等生命周期 RPC；
- client 与 Core 的事件通知边界；
- app-server v2、SDK、WebSocket/remote transport；
- 文件系统、命令执行、MCP elicitation、插件和配置 API；
- thread list、archive/unarchive、分页历史和状态 DB；
- daemon、remote-control 和宿主进程恢复。

这不是单纯把 TUI 换成 JSON-RPC，而是把 harness 的 host responsibilities 从 Core 中显式抽出。当前 `MessageProcessor` 会持有 `ThreadManager`、`ThreadStore`、queue service、environment manager、plugin startup task 和 outgoing event sink；同时注释明确要求 process-scoped thread store 不随 config reload 改变 persistence backend/root。[当前源码：`message_processor.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/message_processor.rs#L137-L150) [Thread Store ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/message_processor.rs#L267-L303)

### 5. 2026-01：协议化的 Thread、Fork、Collaboration 和动态工具

`f0679a6ab2`（2026-01-09）的版本记录包含 thread/fork endpoint、requirements/list、metrics capability 和 elevated sandbox onboarding；`149625a4f9`（2026-01-21）加入 collaboration modes、request-user-input 和远程模型/WebSocket；`a09055074e`（2026-01-27）让 API v2 thread 可以在启动时注入 dynamic tools，并把调用/结果端到端路由进 Server/Core。

此时 harness 的抽象从“一个客户端控制一个会话”变成：

- 客户端通过稳定协议创建或恢复 Thread；
- Thread 可以 fork 为有独立身份和历史边界的新 Thread；
- collaboration mode 和 subagent 能力由 Thread/Session metadata 控制；
- 动态工具不需要静态编译进 CLI，但必须穿过同一 Tool pipeline；
- requirements 和 capability 让客户端可以根据 Runtime 能力调整 UX。

### 6. 2026-03—04：安全、扩展和代码执行进入统一能力平面

这段时间的 release commits 显示 harness 明显扩张：

- `81c4928825`（2026-03-09）：`request_permissions`、流式 app-server command execution、PTY/TTY、新 Permission Profile 语言，并拆分 filesystem/network sandbox policy；
- `b9904c0ae4`（2026-03-10）：Code Mode、SessionStart/Stop hooks、WebSocket health endpoints、realtime handoff；
- `f028679abb`（2026-03-16）：v2 app-server 文件系统 RPC、Python SDK、Guardian subagent Smart Approvals、Responses API tool-search；
- `4c70bff480`（2026-03-26）：插件成为一等工作流，Multi-Agent V2 使用路径地址和结构化消息，app-server 支持 shell、文件监听和远程 WebSocket；
- `e9fb49366c`（2026-04-23）：多 Environment 和每-turn environment/cwd 选择，稳定 Hooks，远程插件 marketplace 和 Bedrock；
- `e4310be51f`（2026-04-30）：持久化 Goal、Permission Profile、插件 marketplace、外部 Agent session import 和更明确的 Multi-Agent V2 配置。

架构上，这一阶段完成了两个关键转变：

1. **工具不再是一个静态数组**。工具有 registry、exposure、deferred discovery、namespace、schema、runtime 和生命周期事件；模型看到什么与系统能执行什么可以不同。
2. **权限不再是一个 approval mode**。权限由 profile、filesystem/network policy、requirements、additional permissions、environment 和 Guardian 共同决定，且允许在运行中的 Turn 请求更多权限。

### 7. 2026-05—08：Execution Environment 和宿主运行化

`9474e5cfc4`（2026-05-21）将 Goal、remote-control、Permission Profile API/继承/requirements、Windows sandbox 和 Extension lifecycle observation 汇入一组发布特性；`a75c443fdb`（2026-05-26）增加 per-server environment targeting、MCP OAuth、read-only MCP 并发、Extension/Hook context；`d65ed92a5e`（2026-04-15）和 `58573da43`（2026-05-08）则将 MCP Apps、remote-control、分页 thread history、devcontainer 和 sandbox metadata 继续推向宿主化。

2026-08 的提交记录显示 Environment 已成为正式架构边界，而不是一个传入 Shell 的参数：

- `393f64565a`（2026-07-14）：runtime workspace roots scoped to execution environments；
- `fdbab67c66`（2026-08-14）：turn selections 携带 environment config；
- `d75c85f651`（2026-08-19）：thread settings 与 environment configuration 分离；
- `e38290846c`、`fde2156057`、`6c108912ee`：按 environment 执行 command policy、MCP policy 和 shell environment policy；
- `8444cf63b5`（2026-08-25）：从 turn environments 派生 sandbox contexts；
- `f580dd886f`（2026-08-21）：对 remote execution 强制 environment network policies；
- `bce5f2fcfc`/`8a40095ea3`（2026-08-20）：统一 Shell execution 到 unified exec。

这说明 Codex 的执行面已经从：

```text
Tool → local shell → local sandbox
```

演进为：

```text
Tool plan
  → selected Environment
  → executor / platform / cwd / workspace roots
  → permission profile + network policy + command policy
  → local or remote runtime
```

当前 `TurnEnvironmentSnapshot` 会保留环境选择、executor 平台、workspace roots、cwd、权限 profile 和网络策略等信息；工具执行因此可以将“模型请求的动作”和“实际执行位置”分开。[当前源码：`environment_selection.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/environment_selection.rs#L142-L202)

### 8. 2026-09：0.154.0 把实验能力收束为可运营 harness

官方 0.154.0 release 的重点并不是引入新的单一 Agent loop，而是把多个运行时边界补齐：

- managed worktree 支持新建、fork、浏览和恢复隔离 checkout；
- Windows app-server daemon 支持共享后台 Server、生命周期和更新；
- inline asynchronous questions 允许工作中的 Turn 接收用户回答；
- 外部插件升级后，已有 Session 可以刷新 tools、skills 和 hooks；
- MCP OAuth refresh 协调 token 更新并暴露 login challenge，不自动重放被拒绝的调用；
- workspace trust 之前不执行 workspace-controlled helper，macOS sandbox 防止 terminal input injection；
- remote resume/fork 保留 permissions 和 server model defaults；
- Guardian 在 compaction、用户追加指令、回答变化后重新校验授权上下文；
- 独立 `codex mcp-server` 入口移除。[官方版本说明](https://github.com/openai/codex/releases/tag/rust-v0.154.0)

所以 `0.154.0` 更像一次 harness operationalization：它让隔离、恢复、远程、审批、插件和宿主进程在真实长时运行中互相协调，而不是只在理想的单 turn 中工作。

## 二、当前 Runtime 的核心机制

### 1. Session 是生命周期所有权边界

`Session::spawn()` 接收大量 Runtime services：Auth、Models、Skills、Plugins、MCP、Code Mode、Extensions、Environment、Thread Store、Agent Control、Telemetry、Trace 和历史状态。[当前源码：`Session::spawn()`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L491-L565)

Session 的重要性不在于它是一个 Rust struct，而在于它拥有以下不变量：

- Submission channel 是有界的，外部输入必须经过串行接纳；
- Session 内同时管理当前 active task、lifecycle event 和 services；
- approval、steer、interrupt、settings update 与 user input 共享同一运行时入口；
- Task 结束后统一收束状态，恢复 thread idle 或处理 mailbox work；
- Thread/Session 的持久化与客户端事件不会由某个具体 TUI 实现私有持有。

因此，Session 是 Core 内的 control-plane root；它不是模型上下文，也不是执行环境。

### 2. Turn 是用户可见的工作单元，Step 是一次请求的一致性单元

当前 `run_turn()` 的注释明确描述了循环语义：模型返回 function call 时执行工具并把结果送入下一次 sampling；只有 assistant message 时才结束 Turn。[当前源码：`run_turn()`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L149-L170)

但一个 Turn 可以包含多个 Step。`run_turn()` 在第一次 sampling 前会：

1. 处理上一个 Turn 完成的异步 Hook；
2. 进行 pre-sampling compaction；
3. 根据用户输入解析需要启动的 MCP server/plugin；
4. 调用 `capture_step_context_with_required_mcp_servers()`；
5. 将该 Step 的 world state 和 model-visible context 记录下来；
6. 之后才进入模型流、工具 Future 和 follow-up。

`StepSettings` 的文档明确说，一个 Turn 可以有多个 Step，每个 Step 使用自己的 captured settings；`capture_step_context_inner()` 又明确要求在异步 planning 前捕获 immutable settings version，即使 Turn 后续发生 settings update，已经捕获的请求仍使用原快照。[`StepSettings`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L21-L39) [`capture_step_context_inner`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3468-L3532)

这解决了长运行 Agent 的核心一致性问题：模型看到的工具 schema、审批 reviewer、MCP binding、Environment 和 `AGENTS.md` 内容必须与实际执行该 Step 的能力集合对齐。否则，异步设置更新会造成“模型基于旧工具计划，执行器使用新权限”的漂移。

### 3. 工具执行是能力投影，而不是函数调用

当前 Tool plan 将工具按 exposure 分成 Hidden、Direct、Deferred、CodeModeOnly 等形态，并在 `build_model_visible_specs()` 处决定本 Step 的模型可见 Specs。[当前源码：`spec_plan.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L223-L265) [模型可见工具构造](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L531-L573)

工具层至少有四个不同问题：

| 问题 | 运行时回答 |
| --- | --- |
| 系统是否实现该能力？ | `ToolRegistry` / `ToolExecutor` 是否注册 |
| 本 Step 是否允许模型看到？ | `ToolExposure`、namespace、feature、model capability |
| 模型能否延迟发现？ | Deferred tool / Tool Search / Code Mode projection |
| 这次调用能否执行？ | Approval、Guardian、Sandbox、Environment、MCP policy |

这使 Codex 可以同时支持内建工具、MCP、插件、Extension、动态工具、Code Mode 和客户端工具，而不把所有工具都塞进系统 prompt，也不把“注册”误当成“授权”。

### 4. Environment 是执行与安全的联合边界

Environment 在当前实现中至少携带：environment identity、cwd、workspace roots、executor connection、executor platform OS、permission profile、network policy、shell environment 和 MCP policy。Environment-aware runtime 让以下情形具有同一个抽象：

- 本地工作区；
- managed worktree；
- 远程 executor；
- 多 workspace roots；
- Windows sandbox service；
- 受限或只读 Environment；
- Guardian review session 的隔离执行环境。

这比传统“Sandbox 包住 Shell”更强：Sandbox 是最终 enforcement，而 Environment 决定 Sandbox 应该针对哪个执行目标、哪些 roots、哪种平台和哪组网络规则生成。

### 5. Approval、Guardian 和 Sandbox 形成三级策略收敛

Codex 的安全路径可以抽象为：

```text
Tool request
  → semantic approval decision
  → Guardian / user / extension reviewer
  → permission profile + filesystem/network policy
  → platform executor / sandbox
  → tool result + audit/event history
```

这里的三个层次不能互相替代：

- Approval 决定这次动作是否应该继续；
- Guardian 决定在自动审批或高风险路径中是否接受该动作和其上下文；
- Sandbox/Executor 决定即使上层判断错误，进程在操作系统层面还能触达什么。

0.154.0 的 Guardian 变更尤其说明安全已经成为 context lifecycle 的一部分：压缩、fork、用户追加回答和恢复都会影响授权证据，因此审批不能只缓存一个 `allow` 结果，必须校验它对应的 action、history version 和 root authorization context。

### 6. Rollout 是事实日志，State DB 是可查询派生状态

Rollout 保存模型项、用户项、工具调用、事件、turn boundaries、settings metadata 和上下文压缩结果；State DB/Thread Store 保存线程目录、索引、队列、sections、attachments、pagination cursor 和派生元数据。两者共同构成恢复平面，但职责不同：

- Rollout 适合回答“发生了什么”；
- State DB 适合回答“现在有哪些线程、如何分页、谁在写、如何恢复”；
- ThreadManager 负责把持久化历史变成可运行的 Session；
- app-server 负责把恢复结果以稳定的 protocol snapshot 交付给客户端。

当前 `ForkSnapshot` 会区分按 user message 截断和“如同此刻中断”的 snapshot；如果 persisted history 结束在 mid-turn，fork 会补写与真实 interrupt 一致的 `<turn_aborted>` boundary。[当前源码：`ForkSnapshot`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cbf1b340/codex-rs/core/src/thread_manager.rs#L176-L194) [fork snapshot reconstruction](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cbf1b340/codex-rs/core/src/thread_manager.rs#L2251-L2352)

这体现了 Codex 的关键设计取向：**恢复与 fork 不是把历史文本复制一遍，而是重建一个合法的运行边界**。

## 三、最重要的架构变化

### 变化 A：从“模型循环”到“异步 Session 控制器”

早期 CLI 可以近似为：输入 → 请求模型 → 执行命令 → 输出。随着 Session、Submission、Task 和 TurnContext 引入，控制权变成：

```text
多个外部事件
  → 有界 Submission queue
  → Session 串行决定接纳顺序
  → Active Task / Turn
  → 事件通知与持久化
```

这使 harness 能够承受在模型工作期间到达的 approval response、steer、async question、interrupt、settings update 和 subagent message。它也是后续 app-server、TUI queued input 和 Multi-Agent V2 的共同基础。

### 变化 B：从“隐式当前配置”到“版本化运行时快照”

早期运行时可以在执行过程中读取 Config 或当前 cwd；现在则逐渐出现：TurnContext、StepSettings、ResolvedStepSettings、StepContext、TurnEnvironmentSnapshot、PermissionProfileState、Guardian transcript cursor 和 persisted settings metadata。

这类对象共同表达一个原则：

> 动态配置可以改变未来边界，但不能偷偷改变已经开始的模型请求、工具执行或审批证据。

这个原则直接解释了当前代码中“settings update 后后续 Step 生效”“active Step 保留 last known context”“resume/fork 保留 saved permissions”“Guardian 拒绝 stale approval”等多组看似分散的提交。

### 变化 C：从“本地沙箱”到“可迁移执行环境”

当 Codex 只运行在本地时，cwd 近似等于 execution target；引入 remote executor、managed worktree、multiple environments 和 Windows sandbox 后，这个假设失效。`0.154.0` 的 worktree 与 Windows daemon 发布项是这个长期变化的产品化表现。[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0)

现在的执行语义需要同时知道：

- 用户要求在哪个 Environment 执行；
- Environment 实际解析到哪个 executor；
- executor 的平台、home、cwd 和 workspace roots；
- 该环境的 Permission Profile、deny-read、network 和 command policy；
- 该执行是否还需要 Guardian/user/extension approval。

这让“跨平台”“远程”“隔离 worktree”和“安全执行”不再是平行功能，而是同一个 Environment abstraction 的不同实例。

### 变化 D：从“历史文本”到“可操作时间线”

Rollout 在早期主要是保存会话；到 2026 年，它开始承载：turn identity、root turn identity、response ticket、reasoning effort、model settings、window/fork position、realtime events、goal state、Guardian context 和插件/权限 metadata。

这使历史成为控制面的一部分：

- compaction 需要在历史上留下 checkpoint/replacement history；
- resume 需要从历史和 State DB 重建当前运行状态；
- fork 需要选择合法边界并处理 mid-turn；
- Guardian 需要知道哪些用户指令和授权证据仍然有效；
- app-server 需要把一致的 resume snapshot 发送给客户端。

因此，Codex 的上下文管理已经不是“把旧消息截断”，而是一个带 lineage、checkpoint 和 lifecycle marker 的时间线系统。

### 变化 E：从“扩展接口”到“扩展运行时”

MCP、Plugins、Skills、Hooks、Extensions、Code Mode、dynamic tools 和 App integrations 逐步汇入同一套 Step/Tool/Session 机制。扩展不只是增加 tool schema，还能影响：

- Session 启动和恢复；
- tool discovery 和 exposure；
- MCP authentication/elicitation；
- PreToolUse/PostToolUse/SessionStart/Stop/compaction hooks；
- async approval 和 Guardian evidence；
- subagent lifecycle 和 environment context；
- context injection 与 prompt-visible state。

因此，Extension runtime 的难点从“如何调用外部工具”变为“如何让扩展参与生命周期，但不破坏 Step 一致性、授权边界和持久化顺序”。

### 变化 F：从“多客户端”到“多宿主/多 Agent”

app-server 让 TUI、Exec、SDK、Desktop、remote-control 可以共享 Core；Multi-Agent V2 又让一棵 thread tree 共享 AgentControl、mailbox、path identity、execution limiter 和 residency manager。此时 harness 必须区分：

- process identity；
- thread identity；
- root turn identity；
- agent path identity；
- environment identity；
- response/request identity。

这些身份不是日志装饰，而是 ownership、authorization、recovery 和 telemetry 的索引。一个子 Agent、Guardian session、remote thread 或 forked thread 如果复用错误身份，就可能把权限、历史或事件写回错误的主体。

## 四、Codex harness 的当前架构模型

```text
┌──────────────────────────────────────────────────────────────┐
│ Application hosts                                             │
│ TUI / codex exec / SDK / Desktop / remote-control / daemon     │
│  protocol, queue, resume snapshot, lifecycle, process control  │
└───────────────┬──────────────────────────────────────────────┘
                │ app-server / embedded Core API
┌───────────────▼──────────────────────────────────────────────┐
│ Control plane                                                  │
│ ThreadManager → CodexThread → Session                          │
│ Submission → SessionTask → Turn                                │
│ approval / steer / interrupt / async question / mailbox        │
└───────────────┬──────────────────────────────────────────────┘
                │ capture immutable StepContext
┌───────────────▼──────────────────────────────────────────────┐
│ Reasoning and capability plane                                  │
│ prompt/context/compaction + model stream + Tool plan            │
│ skills / plugins / MCP / extensions / dynamic tools / hooks     │
└───────────────┬──────────────────────────────────────────────┘
                │ authorize and resolve target
┌───────────────▼──────────────────────────────────────────────┐
│ Execution and safety plane                                     │
│ Environment → executor → shell/files/MCP/Code Mode             │
│ approval → Guardian/extension → profile/network/sandbox        │
└───────────────┬──────────────────────────────────────────────┘
                │ facts, lifecycle, checkpoints
┌───────────────▼──────────────────────────────────────────────┐
│ Persistence and recovery plane                                 │
│ Rollout Log + Thread Store + State DB + queue + attachments     │
│ resume / fork / rollback / migration / lineage / daemon reload  │
└──────────────────────────────────────────────────────────────┘
```

这张图的关键不是组件数量，而是箭头方向：

- host 不直接执行模型工具，而是向 Core 提交协议请求；
- Core 不把工具调用直接交给本地 shell，而是经 Environment 和策略收敛；
- Tool result 不只是返回给模型，还同时进入 event、history、telemetry 和必要的 persistence；
- resume/fork 不只是重新创建 UI，而是从持久化事实重建一个新的可运行边界。

## 五、对后续 coding agent 比较的可复用分析维度

对其它 coding agent，不应只比较“有没有 shell tool”或“是否支持 MCP”。更有区分度的问题是：

1. **生命周期边界**：是否有 Session/Thread/Turn/Step？当前输入是否能在模型运行时安全进入？
2. **一致性快照**：工具定义、权限、cwd、模型设置和上下文在一次模型请求期间是否固定？
3. **执行定位**：工具是否绑定单一本地 cwd，还是有独立 Environment/Executor/Workspace abstraction？
4. **安全收敛**：approval、policy、sandbox、remote executor 是否分层，还是只靠一个确认 UI？
5. **持久化语义**：保存的是消息、事件、命令结果，还是可恢复的 lifecycle timeline？是否支持 mid-turn resume/fork？
6. **扩展参与点**：MCP/plugin/hook 是静态注册，还是能参与 startup、tool routing、approval、context 和 persistence？
7. **宿主分离**：CLI、UI、SDK、daemon、remote client 是否共享同一 Core 生命周期？
8. **并发与多 Agent**：是否区分 thread、turn、agent、environment 和 request identity？是否有 mailbox、ownership、residency 和 unload？
9. **恢复与失败**：网络断开、审批超时、进程崩溃、配置更新、上下文压缩和活跃 writer 冲突时，系统如何保持不变量？
10. **事实与解释的边界**：哪些状态写入日志，哪些只是内存派生；恢复时哪些信息是权威来源？

用这十个维度，才可以把“coding agent 的 harness”从产品功能清单提升为运行时架构比较。

## 证据与验证边界

### 已验证

- 读取 `rust-v0.154.0` 的 Session、Turn、Step settings/context、Environment selection、Tool plan/registry、ThreadManager、app-server 和相关测试源码。
- 从本地 Git 历史检查了 2025-04-16 至 2026-09-09 的 commit 时间线，并用 release feature commits 对关键阶段交叉定位。
- 使用结构图谱确认了 Session、Submission、TurnContext、StepContext、ThreadManager、Environment、Tool 和恢复测试之间的高连接关系。
- 使用官方 `0.154.0` release 对照产品层发布项和 changelog。

### 解释性判断

- “四平面”是对组件职责与数据流的分析模型，不是 Codex 官方给出的模块划分。
- “harness operationalization”是基于 worktree、daemon、remote executor、Guardian、resume/fork 和 plugin refresh 等变化的综合判断。
- “Step 是一致性单元、Turn 是用户可见工作单元”是对当前源码边界的抽象，而不是单个类型的官方定义。

### 未确认事项

- 尚未在真实环境中测量不同客户端、daemon 和 remote executor 对同一 Turn 的时序差异。
- 尚未用故障注入验证 daemon 崩溃、active writer resume、网络审批超时和 mid-turn fork 的完整端到端行为。
- 旧版本部分历史提交的完整 diff 在 partial clone 中可能触发按需 blob 请求；本文对旧阶段主要依据 commit message、文件历史和当前实现回溯，尚未逐个重建每次提交的完整源码快照。
- `0.154.0` 之后的版本可能继续改变 app-server、Guardian、Environment 和 Multi-Agent V2；本文是截至该 commit 的研究快照，不代表后续版本。

## 关键来源

1. [Codex `rust-v0.154.0` official release](https://github.com/openai/codex/releases/tag/rust-v0.154.0)
2. [Codex `rust-v0.153.0...rust-v0.154.0` changelog](https://github.com/openai/codex/compare/rust-v0.153.0...rust-v0.154.0)
3. [Rust implementation initial import `31d0d7a305`](https://github.com/openai/codex/commit/31d0d7a305305ad557035a2edcab60b6be5018d8)
4. [Session creation `cf7a7e63a3`](https://github.com/openai/codex/commit/cf7a7e63a376a90a51bd793319b5a323ab62834d)
5. [Full state refactor `250b244ab4`](https://github.com/openai/codex/commit/250b244ab4223817b8b4f28d827bfd892153ae3e)
6. [Submission loop decomposition `5ba2a17576`](https://github.com/openai/codex/commit/5ba2a1757606919a04d26701e3387b633d1b83de)
7. [App-server protocol and thread evolution `f0679a6ab2`](https://github.com/openai/codex/commit/f0679a6ab2563135e01cc922698cb54921a1719f)
8. [Collaboration and async input `149625a4f9`](https://github.com/openai/codex/commit/149625a4f983e1b3c8530abef1c863689d98a1cc)
9. [Dynamic tools and Multi-Agent guardrails `a09055074e`](https://github.com/openai/codex/commit/a09055074e082d70e8b92795b0cec1e969a6aaf9)
10. [Permission profiles, streaming exec and app-server policy `81c4928825`](https://github.com/openai/codex/commit/81c4928825d1e468447a17d6bc74b9abb48743f4)
11. [Code Mode and hooks `b9904c0ae4`](https://github.com/openai/codex/commit/b9904c0ae4ecb773549efd6ea3fb05229402fdb9)
12. [App-server v2, Guardian and Python SDK `f028679abb`](https://github.com/openai/codex/commit/f028679abb30051cec2434e624cd99975986b41b)
13. [Multi-environment and stable hooks `e9fb49366c`](https://github.com/openai/codex/commit/e9fb49366c93a1478ec71cc41ecee415a197d036)
14. [Remote-control, permissions and extensions `9474e5cfc4`](https://github.com/openai/codex/commit/9474e5cfc4494b0ba319352aa86ce436c59e65c8)
