---
title: OpenHands Runtime / Harness 演进研究
snapshot_id: 2026-09-15.ab23be6
reviewed_at: 2026-09-15
upstream_repository: https://github.com/OpenHands/OpenHands
upstream_commit: ab23be62ad724fe83483036a0900bed7b7859166
upstream_commit_date: 2026-08-21
previous_snapshot: null
status: current
change_level: major
verification:
  source_reading: true
  tests_read: false
  runtime_experiment: false
diagram: null
---

# OpenHands Harness 的 Runtime 演进研究

本文研究 OpenHands 从早期“聊天界面驱动一个 coding agent”到 `v1.15.0` 的整体 Runtime/Harness 演进，重点关注：Conversation 生命周期、Agent Server 边界、事件流和恢复、workspace/runtime 选择、工具与安全确认、模型配置、ACP 外部 Agent，以及 Agent Canvas 如何从单一前端变成多后端、多 Agent 的控制平面。

分析基线是 `OpenHands/OpenHands` 远程 ref [`v1.15.0`](https://github.com/OpenHands/OpenHands/tree/v1.15.0)，对应 commit [`ab23be62ad724fe83483036a0900bed7b7859166`](https://github.com/OpenHands/OpenHands/commit/ab23be62ad724fe83483036a0900bed7b7859166)。该远程版本的源码已 checkout 到本地分析目录，并保留了 685 个浅历史 commit；本地目录仅是分析材料，不作为文档中的源码引用。

配套架构图：[OpenHands Runtime Architecture v1.15.0](../diagrams/openhands-runtime-architecture-v1.15.0-ab23be6.excalidraw)。

## 先澄清分析对象：OpenHands 是多仓库 Runtime

在 v1.15.0，`OpenHands/OpenHands` 已不是早期意义上的完整 Python Agent 实现，而是 **Agent Canvas frontend**。仓库中的 `src/` 主要包含 React/TypeScript UI、状态管理、REST/WebSocket client adapter、workspace UI、MCP/ACP 配置和 cloud/local backend registry。

真正的服务端 runtime 位于独立的 [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk)，它拥有：

- Agent loop、LLM provider 和 tool execution；
- Conversation、event store、pause/resume 和 server API；
- workspace/runtime、sandbox、file/bash/browser 等工具；
- MCP、ACP Agent、插件、skills 和远程 workspace；
- Agent Server REST/WebSocket 协议。

因此本文有两个层次：

1. **Harness / product control plane**：基于 `OpenHands/OpenHands@v1.15.0` 实际源码分析；
2. **Backend runtime contract**：根据本仓库的类型、client、测试和文档推断其服务端边界，并明确标记为协议观察，而不是对 SDK 内部实现的源码验证。

这一区分本身就是 OpenHands 的架构演进成果：前端不再拥有 Agent loop，而是成为可以连接多个本地、云端和外部 ACP Agent 的控制中心。

## 核心结论

OpenHands 的 Harness 主线不是“把单个 Agent loop 变复杂”，而是把 coding agent 变成一个由 Agent Canvas 管理的可替换 Runtime。其架构经历了六次边界移动：

1. **从单一 Web 应用到 frontend/backend 分离**：React Canvas 通过 typed client 连接 Agent Server，Agent loop 不再嵌入 UI 进程。
2. **从 Conversation 页面到事件驱动控制面**：REST 负责历史、列表和分页，WebSocket 负责实时事件；客户端用 event store 将两者合并。
3. **从本地 workspace 到 backend-owned workspace/runtime**：conversation 创建时绑定 local/cloud backend、workspace、repository、branch 和 sandbox/runtime URL。
4. **从 OpenHands Agent 到多 Agent/多 Harness 接入**：OpenHands agent、ACP Agent、Claude Code、Codex、Gemini 等都通过统一 conversation/event surface 接入。
5. **从静态设置到 profile/plugin/MCP/skills 能力平面**：模型、工具、MCP server、skills、agent profile 和 plugin 在 conversation start 时组合，并由 server 负责真正执行。
6. **从聊天产品到持续运行的 Agent Canvas**：automations、child conversations、cloud sandboxes、runtime service discovery 和 manifest-driven extension 使其成为控制中心，而不是单一聊天客户端。

到 v1.15.0，可以用如下四平面理解 OpenHands：

| 平面 | 主要职责 | v1.15.0 代表组件 |
| --- | --- | --- |
| Control / Product | 创建 conversation、选择 backend、workspace、profile、automation 和 UI lifecycle | Agent Canvas routes、backend registry、conversation service |
| Transport / Sync | 历史加载、实时事件、重连、去重、流式 delta 合并 | REST clients、WebSocket provider、event store |
| Runtime Contract | 对外表达 agent action、observation、state、pause、metrics 和 error | `OpenHandsEvent`、typed client、conversation API |
| Execution Backend | LLM、tools、sandbox、workspace、MCP、ACP、artifacts 和 persistence | `software-agent-sdk` Agent Server / Cloud runtime |

## 一、用户视角的生命周期

OpenHands v1.15.0 的用户操作通常不是“向当前 Agent loop 写一条消息”这么简单，而是以下状态转移：

```text
选择 backend
  → 选择/创建 workspace、repository、branch
  → 选择 LLM profile / Agent profile / ACP harness
  → 创建 Conversation 或恢复既有 Conversation
  → Agent Server 启动或唤醒 runtime
  → REST 预加载历史
  → WebSocket 订阅实时事件
  → 用户消息 / tool confirmation / pause / resume
  → action ↔ observation ↔ state update
  → finish / error / paused / reconnect / reload
```

Conversation 的 identity 由 server 返回的 conversation id、conversation URL 和可选 session API key 共同确定。Cloud conversation 还具有 sandbox id/status；local conversation 则连接本机 Agent Server。前端的 `AppConversation` 类型记录了这些字段，以及 repository、branch、workspace、agent kind、ACP server、metrics 和 child conversations。

源码依据：[`agent-server-conversation-service.types.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/conversation-service/agent-server-conversation-service.types.ts)、[`agent-server-adapter.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts)。

### Session、Conversation、Turn、Event 的对应关系

OpenHands 前端没有像 Codex 那样以 `Session → Submission → Turn → Step` 作为内部控制内核。它主要消费 backend 的 `Conversation` 和 `Event`：

| 概念 | 在 OpenHands Canvas 中的角色 | 证据/边界 |
| --- | --- | --- |
| Backend | 可切换的 local/cloud Agent Server 连接 | `BackendRegistry`，持有 host、auth mode、org |
| Conversation | 用户可见的长期 coding task/session 容器 | server identity；包含 workspace、model、metrics、status |
| User message | conversation 内提交的输入 | REST/client `sendMessage`，前端也有 optimistic queue |
| Agent step/turn | 主要由后端 Agent Server 执行 | 前端通过 action/message/observation 事件观察，不拥有 loop |
| Event | durable/runtime wire record 的客户端投影 | typed event union，带 id/timestamp/source/action_id/tool_call_id |
| UI state | 前端派生态，不等于 runtime state | Zustand stores、React Query cache、localStorage |

因此，用户的持续输入、暂停、确认和恢复在 UI 上表现为对同一 Conversation 的操作，但真正的 invocation/step identity 和可恢复事实由 Agent Server 定义。前端必须通过 conversation id、event ids、action ids 和 tool call ids 重新同步，不能把 React store 当作执行真相。

## 二、事件架构：REST 历史 + WebSocket 增量

### 1. 为什么同时使用 REST 和 WebSocket

`ConversationWebSocketProvider` 的实现揭示了 v1.15.0 的同步模型：

- 初始 conversation history 通过 REST 加载；
- 旧事件通过分页继续加载；
- WebSocket 只接收最新事件和 streaming deltas；
- 连接建立时使用 latest timestamp 作为 `after_timestamp`，避免重复下载；
- event store 用 event id 去重、按 timestamp 排序；
- 主 conversation 和 planning sub-conversation 可以共享前端处理逻辑，但流式 sender 分开合并；
- socket 异常使用 exponential backoff reconnect；
- 事件 arriving out of order 时由客户端重排。

源码依据：[`conversation-websocket-context.tsx`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/contexts/conversation-websocket-context.tsx)、[`use-event-store.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/stores/use-event-store.ts)、[`use-websocket.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/hooks/use-websocket.ts)。

```text
REST history ──────┐
                    ├── dedupe by event.id ── sort by timestamp ── UI projection
WebSocket deltas ──┘              │
                                  ├── action/observation correlation
                                  ├── streaming delta merge
                                  └── conversation state / metrics stores
```

### 2. Event 不是单纯聊天消息

`OpenHandsEvent` 是多个 event 类型的 union：`MessageEvent`、`ActionEvent`、`ObservationEvent`、`SystemPromptEvent`、`CondensationEvent`、`ConversationStateUpdateEvent`、`PauseEvent`、`StreamingDeltaEvent`、`ACPToolCallEvent`、`HookExecutionEvent`、`ServerErrorEvent` 等。

`ActionEvent` 关联 thought、reasoning、tool name、tool call id、LLM response id、security risk、critic result 和 summary；`ObservationEvent` 通过 `action_id` 指向对应 action，并以 `source: environment` 表示工具/运行环境产生的结果。这种 action-observation 二元结构把“模型提出动作”和“执行环境返回结果”分开，是 coding agent 的核心事件语义。

源码依据：[`openhands-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/openhands-event.ts)、[`action-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/action-event.ts)、[`observation-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/observation-event.ts)。

### 3. Streaming event 与 canonical event 分离

Streaming delta 是临时 UI transport，不应直接当成 durable event：客户端按 sender 合并 delta，在最终 Message/Action event 到达时替换或收敛临时内容。v1.15.0 的 event store 特意不为 transient delta 做普通 event-id tracking，避免每个 token 复制 Set 造成 O(n²)；这反映了前端对“流式展示态”和“最终事实”的明确区分。

## 三、Workspace、Sandbox 和 Environment ownership

OpenHands 的 Environment 不是前端的 cwd。它位于 Agent Server/Cloud runtime 一侧，由 workspace、sandbox、remote URL、session key 和 runtime service 共同组成。前端只负责选择和展示这些边界：

- `workspace_mode` 区分 local repo、new worktree 等用户意图；
- local backend 将命令路由到本机 Agent Server；
- cloud backend 通过 conversation-specific runtime URL 和 session API key 访问 sandbox；
- repository/branch 作为 conversation 创建参数进入后端准备流程；
- file/bash/VSCode 等操作使用当前 conversation 的 runtime，而不是默认浏览器环境。

`AgentServerRuntimeService` 的实现同时展示 local/cloud 两条 transport：local 直接使用 typed `RemoteWorkspace`/`FileClient`，cloud 通过 cloud proxy 转发到 conversation runtime。这样 Workspace identity 和 transport identity 分离，但由同一 conversation 绑定。

源码依据：[`agent-server-runtime-service.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/runtime-service/agent-server-runtime-service.ts)、[`agent-server-conversation-service.api.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/conversation-service/agent-server-conversation-service.api.ts)。

这与典型 coding-agent harness 的差异是：OpenHands Canvas 通过 backend URL 和 runtime service 使用 environment，但 environment 的隔离、进程、文件系统和权限策略并不由本仓库实现，而是由 Agent Server/Cloud runtime 拥有。

## 四、工具、权限和安全边界

### Action → approval → execution → observation

前端对工具安全的核心不是自行执行命令，而是展示和转发 server event：

```text
Agent Server emits ActionEvent
  → action carries tool_call_id + security_risk + optional critic result
  → UI renders confirmation / reject controls
  → user response sent to conversation runtime
  → ObservationEvent or UserRejectObservation
  → backend continues Agent loop
```

`ActionEvent.security_risk`、`critic_result` 和 `UserRejectObservation` 说明审批上下文属于 runtime protocol，而不是纯 UI modal。具体 risk analyzer、confirmation mode、sandbox enforcement 和 command policy 属于 `software-agent-sdk`，本仓库只消费其类型和事件。

### MCP、skills、plugins 和 ACP

v1.15.0 的能力面由多个可替换来源构成：

- MCP server 可以在 UI 中安装、启用、删除和配置 credential；
- skills 从 `@openhands/extensions` catalog 加载，再与 user/project skills 合并；
- plugins 作为 conversation start 的 `PluginSpec` 传给 backend；
- Agent profile 将模型、工具和配置组合成可复用启动选择；
- ACP Agent 把外部 coding harness（例如 Claude Code、Codex、Gemini）包进同一个 Conversation/Event surface；
- child conversation 为 planning/delegation 建立额外 conversation identity。

前端类型中的 `PluginSpec` 支持 source、ref、repo_path 和 parameters；`AppConversation.agent_kind` 区分 OpenHands Agent 与 ACP Agent。这表明“工具是否可用”已经从固定 frontend registry 变成 conversation-start/runtime capability negotiation，但最终工具注入和执行仍在后端。

## 五、架构演进时间线

### 1. 早期 OpenHands：Agent + workspace + Web UI

早期 OpenHands 的产品核心是让模型在 workspace 中观察、提出 action，再由 runtime 执行 shell、文件、浏览器等工具。Web UI 主要是 conversation 展示和输入层，runtime 与 workspace 强耦合。

这一阶段保留下来的不变量是：action 和 observation 分离；conversation 是用户可见的任务单位；workspace 是 Agent 行为的执行边界；模型不会直接获得宿主进程权限。

### 2. Agent Server 化：把 Agent loop 从 UI 进程分离

随后架构把 Agent loop 放入独立 Agent Server，通过 REST/WebSocket 提供 conversation、event、runtime 和 file APIs。Frontend 可以独立发布、更新和连接多个 backend；本地运行和 Cloud sandbox 共享一套 client contract。

在 v1.15.0，这个边界已经非常明确：README 将 Agent Canvas 描述为 self-hosted、always-on engineering team 的控制中心，Agent Server 被描述为运行多个 agents 的 REST API；[README 相关说明](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/README.md#L30-L140)。

### 3. Cloud/local backend registry：Conversation 不再绑定单一部署

Backend registry 将 local 与 cloud 抽象成可切换连接，并通过 backend id、host、auth mode、org id 和 connection revision 隔离 cache。Conversation service 根据 active backend 选择 typed client 或 cloud proxy；这避免 UI 把“当前 host”当作全局常量。

架构意义是 Conversation identity 与 Backend identity 被显式拆开：同一个 UI 可以管理多个 Agent Server，Cloud conversation 还可以拥有专属 runtime URL 和 session API key。

### 4. Event-driven UI：从刷新页面到可重连状态同步

REST history + WebSocket events、event id 去重、timestamp reorder、streaming delta batching、optimistic user message 和 reconnect backoff 逐步形成了一个客户端同步层。v1.15.0 的提交历史中，`keep the events socket alive across refetches and bound hung handshakes`、`batch StreamingDeltaEvents` 等修复说明成熟度问题已经从“能显示消息”转向“重连和高频事件下不丢、不重、不乱”。

### 5. Agent Canvas：从 coding chat 到多 Agent application host

近期演进加入了 automation dashboard、child conversations、workspace 管理、MCP marketplace、skills、plugins、Agent profiles、runtime service discovery、Cloud sandbox 和 ACP。Canvas 的控制对象不再只是一个 chat transcript，而是：

```text
Backend
  ├── Conversation
  │     ├── Runtime / Workspace / Sandbox
  │     ├── Agent profile / LLM / MCP / Skills
  │     ├── Event stream / metrics / pause state
  │     └── child conversations
  └── Automations / external triggers
```

这也是 OpenHands 与单体 coding-agent CLI 的根本差异：它的产品边界天然包含远程 runtime、多个 backend、长期 conversation 和自动化入口。

## 六、v1.15.0 的架构级变化

相对于早期 OpenHands，v1.15.0 的高信号变化集中在产品化和多后端治理：

- Agent Canvas 成为明确的 frontend 产品边界；
- Agent Server 通过 typed TypeScript client 作为唯一 backend API 入口；
- local/cloud backend registry 统一选择和认证；
- Conversation history 采用 REST 分页，实时增量采用 WebSocket；
- event store 引入 id 去重、timestamp 排序、stream batching 和主/规划流隔离；
- workspace、repository、branch、sandbox 和 conversation URL 显式建模；
- MCP、skills、plugins、profiles 和 ACP Agent 进入统一的 conversation start 能力面；
- automations、child conversations 和 cloud runtime 把 conversation 从即时聊天扩展为持续运行任务；
- metrics、execution status、pause、error、condensation 和 hook events 进入统一 event union。

对应的 v1.10–v1.15 release commits 可追溯到：[v1.10.0](https://github.com/OpenHands/OpenHands/commit/56638693908b8ac83a2fa3bde6eb6c33aae37f4b)、[v1.11.0](https://github.com/OpenHands/OpenHands/commit/3c562fa694e54741f41ad7acf7210430079495fe)、[v1.12.0](https://github.com/OpenHands/OpenHands/commit/4d0fe4983b6b8e52c104c7ffa4b7be8c7ab5a364)、[v1.13.0](https://github.com/OpenHands/OpenHands/commit/4f465f3ccada5271a3bbe4a0148941b0c40d243b)、[v1.14.0](https://github.com/OpenHands/OpenHands/commit/c0ba9e6d2b73dca07fe1127b91c1eff719853846)、[v1.15.0](https://github.com/OpenHands/OpenHands/commit/ab23be62ad724fe83483036a0900bed7b7859166)。

## 七、保留下来的不变量

1. **Agent action 与 environment observation 分离**：模型提议动作，runtime 执行并返回观察结果。
2. **Conversation 是用户可见的长期任务 identity**：UI 状态可以重建，conversation/event identity 不能随页面重载改变。
3. **Runtime 拥有 workspace 和工具执行**：浏览器只显示和发送控制意图。
4. **Event 是跨 transport 的事实单元**：REST、WebSocket、UI store 和 transcript 都围绕 event identity 对齐。
5. **Frontend 与 backend contract 解耦**：同一个 Canvas 可以切换 local、cloud 和 ACP backend。
6. **流式展示态和最终事件分离**：delta 可以丢弃/合并，最终 event 才是稳定的 UI 事实。

## 八、与 Codex harness 分析的连接点

这不是横向比较，但可以作为后续统一研究的对照：

- Codex 将 Session/Turn/Step 作为 core runtime 控制内核；OpenHands Canvas 将 Conversation/Event/Backend 作为控制面，Agent step 留在外部 Agent Server。
- Codex 的 Environment 是 core execution abstraction；OpenHands 将 Environment ownership 下沉到 per-conversation Agent Server/Cloud runtime，前端只维护 runtime URL、workspace metadata 和 transport。
- Codex 的 tool policy 可以在 harness 内集中治理；OpenHands 前端通过 ActionEvent/security risk/confirmation protocol 参与，但真正 policy 和 execution 在 SDK backend。
- Codex 以单一 coding-agent runtime 向多客户端扩展；OpenHands 从产品层开始就是多 backend、多 agent、多 workspace、多 automation host。
- OpenHands 的事件模型更直接暴露 action-observation、condensation、pause、hook 和 conversation-state 等产品/runtime事件，适合研究“coding agent 如何成为可观测的任务系统”。

## 证据边界

- 本文对 `OpenHands/OpenHands` 的 frontend 源码和 685 个浅历史 commit 做了核对，但没有 checkout `software-agent-sdk` 的对应 v1.15.0 版本；服务端 Agent loop、工具执行、sandbox 和持久化内部机制需要单独拉取 SDK 仓库确认。

## 九、OpenHands 的 Runtime 设计原则

下面的原则不是产品宣传语，而是从 v1.15.0 的类型、client、store、WebSocket、backend registry、测试和用户操作路径中归纳出的设计约束。它们可以作为后续横向研究的“设计意图假说”：源码直接支持的部分标为已验证，涉及独立 SDK 内部的部分标为协议层推断。

### 原则 1：Conversation 是产品任务边界，Event 是运行事实边界

用户的长期对象是 Conversation：它有 identity、workspace、backend、agent kind、metrics、pause/status 和 child conversations。运行过程的细粒度事实则是 Event：message、action、observation、pause、condensation、state update、stream delta 和 error 都通过事件表达。

这两个边界分别解决两个问题：Conversation 让用户可以恢复、分享、归档、切换 backend；Event 让系统可以流式显示、重连、重排、去重和回放。OpenHands 没有把所有状态塞入一个“当前 conversation JSON”，也没有把每个事件直接当作独立 task。

### 原则 2：前端是控制面，不是 Agent loop 的所有者

Canvas 可以创建 conversation、发送消息、暂停、恢复、选择 profile、配置 MCP 和展示 action，但不能假定 React store 是执行真相。真正的 Agent loop 在 Agent Server/SDK；前端只通过 REST/WebSocket contract 观察并发出的控制意图。

这带来一个重要工程收益：前端崩溃、页面刷新或 WebSocket 断线不应等价于 agent 停止。代价是前端必须处理重新加载 history、补拉旧事件、重新订阅、去重和 transient stream 收敛。

### 原则 3：Transport failure 与 Runtime failure 分离

WebSocket 断开是 transport failure，不应直接转换为 conversation failure；server error、agent pause、tool rejection 和 terminal status 才是 runtime event。`ConversationWebSocketProvider` 的 reconnect/backoff、REST history refill 和 event store 合并体现了这个区分。

因此用户体验上的“刷新后还能继续看到任务”“网络短断后事件不重复”不是偶然 UI 行为，而是 transport 与 execution 解耦的结果。它也解释了为什么 event id、timestamp、sender 和 conversation id 需要进入协议，而不是只保留展示文本。

### 原则 4：最终事件优先于流式展示

StreamingDelta 只服务于低延迟展示；最终 Message/Action/Observation event 才是稳定事实。客户端先合并 delta，最终事件到达后再收敛；delta 丢失不应破坏 conversation history。

这是一种典型的“临时投影不进入事实日志”原则。它避免每个 token 都成为需要去重、分页和恢复的 durable event，也让 WebSocket 重连时可以依赖 REST canonical history 修复 UI。

### 原则 5：Action 与 Observation 必须可关联

coding agent 的关键不是模型输出了文本，而是 action 是否被环境执行、以什么权限执行、返回了什么 observation。OpenHands 用 `action_id`、`tool_call_id`、event id 和 source 将两者关联：Action 描述意图，Observation 描述环境结果或拒绝。

这个原则为 UI、审计、重试和后端 loop 提供共同语言。即使使用 ACP 外部 agent，Canvas 仍通过 action/observation/event surface 表示执行进度，而不直接解析外部 harness 的内部对象。

### 原则 6：Environment 必须由 Backend/Runtime 拥有

用户选择的 repository、branch、workspace mode 和 backend 只是启动意图；命令、文件、浏览器和 MCP 的真正执行位置由 conversation 对应的 Agent Server/Cloud runtime 决定。每个 conversation 可以拥有不同的 runtime URL、sandbox id、session key 和 workspace 状态。

这比“前端传一个 cwd”更强：environment 包含 workspace 内容、运行时进程、服务发现、认证、沙箱和可用工具。OpenHands Canvas 的职责是解析路径、展示文件、选择 backend、处理 runtime ready/status，而不是在浏览器进程中执行代码。

### 原则 7：Backend identity 与 Conversation identity 分离

Backend registry 允许 local/cloud/其它 Agent Server 同时存在；conversation 记录自己使用的 backend 与 runtime 信息。这样“当前激活 backend”可以改变，而已有 conversation 仍能根据自己的 identity 找回原 runtime。

这个原则防止全局 host 配置污染已有任务，也为云端、self-hosted、企业 backend 和 ACP provider 提供统一入口。它的代价是 cache、认证、health、connection revision 和 last-conversation store 都必须按 backend scope 隔离。

### 原则 8：能力采用启动协商，而不是前端硬编码

MCP server、skills、plugins、agent profiles 和 ACP provider 在 conversation 启动/配置阶段形成 capability negotiation。前端可以编辑或选择它们，但最终是否可用、如何注入 prompt、如何执行由 backend runtime 决定。

这使同一个 Canvas 能接入不同 agent harness，但也明确了研究边界：不能仅从 frontend 的 MCP settings 推导工具注册、审批或 prompt cache 行为；必须读取对应 SDK/Agent Server 版本。

### 原则 9：Pause/Resume 是任务状态转换，不是 UI loading 开关

暂停 conversation 的语义是让 backend 停止或挂起运行，并生成可恢复状态；恢复是向同一 conversation 发送控制意图，重新进入 runtime。前端有 pause/resume mutations、state store 和相关测试，说明暂停不是简单隐藏 spinner。

同理，tool confirmation 不是浏览器 modal 的局部状态，而是 action 生命周期中的一个事件/状态。用户拒绝后应产生可被 agent 理解的 rejection observation，而不是让前端静默丢弃模型请求。

### 原则 10：多 Agent 通过 Conversation graph 扩展

planning conversation、child conversation 和 ACP Agent 不是把多个模型输出拼在一个数组里，而是增加 conversation identity 与 parent/child 关系。每个子 conversation 可以拥有自己的事件流和 runtime，但 UI 仍可以在 Canvas 中统一展示任务树。

这比在一个 loop 内增加“subagent tool”更容易隔离资源、权限和恢复，但会引入跨 conversation 事件关联、状态聚合、取消级联和上下文边界问题。v1.15.0 的 child conversation 与 ACP 类型已经把这些问题暴露为产品 contract。

### 原则 11：可观测性必须沿用业务事件模型

metrics、token usage、execution time、runtime status、condensation、hook execution、pause 和 server error 都进入 conversation/event 处理路径。这样成本、性能和失败可以和具体 action、observation、conversation 对齐，而不是单独存在一套不可关联的 telemetry 日志。

### 原则 12：兼容性优先于前端与后端同步发布

backend registry、API compatibility tests、runtime service discovery、event union 和 typed adapters 表明 Canvas 需要面对不同 Agent Server 版本。前端不能假设所有 backend 都支持同样的 event、MCP、ACP 或 workspace 功能，因此 capability/health/compatibility 检查是 runtime 设计的一部分。

## 十、这些原则如何塑造用户体验

| 用户动作 | 表面体验 | 背后的 Runtime 原则 |
| --- | --- | --- |
| 刷新页面 | 任务继续、历史恢复 | 前端非 loop owner；Conversation/Event 可重建 |
| 网络短断 | 自动重连、事件不重复 | Transport failure 与 runtime failure 分离 |
| 选择云端运行 | 同一界面操作远程代码 | Backend-owned environment |
| 拒绝工具调用 | Agent 获得拒绝结果并调整 | Action/Observation correlation |
| 暂停后恢复 | 任务继续而不是重新开始 | Pause/Resume 是 runtime 状态 |
| 使用 ACP Agent | 外部 agent 仍显示在统一 Canvas | capability/adapter boundary |
| 新建子任务 | 主任务与子任务分开追踪 | Conversation graph |
| 配置 MCP/skills | 启动时能力改变 | conversation-start capability negotiation |

这也是 OpenHands 的产品化重点：用户感知到的是“一个持久的工程任务空间”，而不是一个必须始终打开的模型聊天窗口。

## 十一、最值得验证的架构假说

### 11.1 Conversation 是否是后端的恢复原子单位

前端可以根据 conversation id 拉历史、发消息、pause、resume 和获取 runtime info，强烈说明 conversation 是 server-side recovery boundary。但前端源码无法确认后端是否以 append-only event store、snapshot + event replay 或数据库事务实现，需 SDK 源码与运行实验确认。

### 11.2 Event ordering 是否由服务端保证

客户端存在 timestamp sort 和 event id dedupe，说明跨 transport 到达顺序可能不稳定；但不能据此断言 server event sequence 是否具有全局单调 offset。后续应比较 REST 分页和 WebSocket event 的 timestamp/id/sequence，验证是否存在同一 conversation 的严格 ordering contract。

### 11.3 Checkpoint 是否覆盖 workspace 与 conversation

前端提供 rewind/restore 相关 UI 和 workspace tests，但是否实现 conversation transcript 与文件系统的原子双回滚，需要 Agent Server 和 runtime backend 验证。OpenHands 不能简单假设它等价于 Codex 的 rollout rollback。

### 11.4 ACP 的安全边界在哪里

ACP Agent 将 Claude Code、Codex、Gemini 等外部 harness 接入 Canvas，但权限、sandbox、tool registry 和 session persistence 可能由外部 Agent Server 拥有。需要逐个 ACP adapter 追踪：谁持有 cwd、谁处理审批、谁生成 event、谁负责取消，才能比较 OpenHands 的统一层是否真正统一语义。

## 十二、研究边界修正

本报告对 OpenHands v1.15.0 的主要结论集中在 `OpenHands/OpenHands` frontend/control plane。它已经足够说明 OpenHands 的产品架构设计原则，但不能替代对 `software-agent-sdk` 的 runtime 深挖。下一阶段若要与 Codex、Gemini CLI、Cline 做核心 loop 级比较，应额外固定：

- `software-agent-sdk` 与 v1.15.0 的兼容 commit/tag；
- Agent loop 的 step/turn 状态结构；
- tool approval 和 security risk 的后端实现；
- workspace/runtime/sandbox 的生命周期；
- event store 的 append/replay/compaction 机制；
- parent/child conversation 的取消和恢复语义。

在 SDK 未固定之前，对 OpenHands 的最稳妥判断是：它已经把 coding agent 的产品控制面、远程运行面和事件同步面做成一等架构；其单个 agent loop 的内部设计仍需以 SDK 版本源码为准。

## 十三、补充的未确认事项

- 没有运行真实 Agent Server、Cloud sandbox、MCP 或 ACP 端到端实验；恢复和权限流程主要依据 typed client、event types、UI 控制流和测试。
- 前端类型是 backend contract 的强证据，但不能单独证明 server 内部的调度顺序、数据库 schema 或工具批准策略。
- 当前仓库 tag 版本号为 `v1.15.0`，但浅历史中包含若干 release commit 之后的祖先链提交；后续如果需要精确的 release-to-release diff，应以 tag commit 和 path-specific diff 为准。

## 十四、状态所有权与恢复流程

OpenHands 的关键不是“前端能看到哪些状态”，而是“哪个边界拥有状态”。按 v1.15.0 的 frontend contract，可以建立以下所有权模型：

| 状态 | 主要所有者 | 前端可做的事 | 不能据此推断的内容 |
| --- | --- | --- | --- |
| backend connection | Canvas backend registry | 选择、认证、健康检查、切换连接 | backend 内部是否有独立调度器 |
| conversation identity | Agent Server | 创建、列表、恢复、关联 child | 后端持久化实现 |
| event history | Agent Server contract | 分页拉取、去重、排序、展示 | 数据库是否 append-only |
| live execution | Agent Server / SDK | 发消息、pause、resume、确认 | Agent loop 的 step 调度 |
| workspace/runtime | conversation runtime | 查询状态、读写文件、展示终端 | sandbox 隔离实现细节 |
| UI projection | Canvas stores | optimistic update、流式合并、重连 | 是否等于执行真相 |

一次恢复操作可以抽象为：

```text
locate backend
  → resolve conversation identity
  → fetch canonical history
  → attach WebSocket after known event boundary
  → dedupe and reorder incoming events
  → query runtime/status
  → rebuild UI projection
```

这里的顺序很重要。若先依赖 WebSocket 再补历史，可能造成旧事件和新事件交错；若只恢复 UI store 而不查询 runtime status，页面可能显示旧的 running 状态；若只加载最终 message 而忽略 action/observation 关联，用户无法判断某个工具调用是否真正执行。OpenHands 以 REST canonical history、WebSocket live events、event identity 和 runtime status 组合解决这些问题，但后端是否提供严格的 replay cursor 仍未由 frontend 证实。

## 十五、OpenHands 的核心流程压缩表达

从 coding-agent harness 的角度，OpenHands v1.15.0 可以压缩成四个连续阶段：

1. **选择执行域**：用户选择 backend、repository、branch、workspace mode、profile 和 agent kind；这一步确定 conversation 将绑定哪个 environment。
2. **建立任务身份**：Agent Server 创建 conversation，并返回 runtime、sandbox、认证和 event 相关信息；Canvas 保存 identity，但不取得执行所有权。
3. **驱动事件化执行**：用户消息、工具确认、pause/resume 成为控制事件；Agent Server 产生 action、observation、state、metrics、condensation 和 error 事件。
4. **重建可见状态**：REST history 提供稳定事实，WebSocket 提供实时增量，Canvas 合并为消息、工具轨迹、文件状态和任务树。

这四阶段说明 OpenHands 的主要抽象不是“一个更复杂的 prompt loop”，而是“一个可选择执行域、可远程驱动、可事件恢复的 conversation runtime”。Agent loop 是其中重要但被 backend 封装的一段执行逻辑。

对研究结论应保持相应边界：OpenHands frontend 的源码足以证明它如何组织 control plane、transport 和 runtime contract；只有固定并读取 `software-agent-sdk` 后，才能把 action-observation 的协议观察提升为 Agent loop、tool approval、compaction 和 workspace recovery 的实现结论。

## 十六、SDK backend 的真实 Runtime 边界

补充读取 `software-agent-sdk@v1.15.0` 后，OpenHands 的 backend 可以进一步还原为：

```text
Agent Server API
  → ConversationService / EventService
  → LocalConversation or RemoteConversation
  → ConversationState + EventLog
  → Agent.step()
  → LLM request / ActionEvent
  → confirmation policy / security analyzer
  → Workspace executor
  → ObservationEvent
  → EventLog + WebSocket subscribers
```

这修正了仅分析 Canvas 时的一个抽象缺口：OpenHands backend 的核心持久对象是 `ConversationState`，其中同时包含 agent 配置、workspace、confirmation policy、execution status、stats、secret registry、hooks 和 event log；但执行中的具体状态仍由 Agent/Conversation 的内存态推进，EventLog 则提供可重建历史。

### Agent、Conversation、Step、Action 的关系

| 层次 | SDK backend 对象 | 作用 |
| --- | --- | --- |
| Conversation | `LocalConversation` / `RemoteConversation` | 拥有 state、workspace、event log、agent 和运行入口 |
| Agent | `Agent` | 根据当前 state 构造 LLM request，解析响应并调度 action |
| Step | `Agent.step()` | 一次 context preparation → LLM completion → action/message 分支 |
| Action batch | `_ActionBatch` / action events | 组织一次模型响应中的多个工具调用 |
| Tool effect | tool runner + workspace/backend | 产生文件、shell、browser、MCP 等副作用 |
| Observation | `ObservationEvent` | 将执行结果关联回 `action_id` / `tool_call_id` |

因此 OpenHands SDK 的 Step 比 Canvas 的 Event 更接近 coding-agent loop 粒度，但它仍不是不可变的 durable Step snapshot。一个 Step 可以触发 condensation、等待 confirmation、执行并行 action 或返回后继续；稳定事实主要通过 ActionEvent、ObservationEvent、MessageEvent 和 ConversationState 记录。

## 十七、SDK backend 的状态机

一次本地 conversation 的核心控制流可以抽象为：

```text
IDLE
  → user message appended
  → RUNNING
  → prepare LLM messages
       ├─ condensation request → CONDENSING → next step
       ├─ malformed response → error observation → next step
       └─ LLM message/tool calls
             ├─ message content → FINISHED
             ├─ action needs confirmation → WAITING_FOR_CONFIRMATION
             └─ action allowed → execute batch
                                  ↓
                         ObservationEvent(s)
                                  ↓
                              RUNNING

RUNNING → pause → PAUSED
RUNNING → fatal error → ERROR
RUNNING → stuck detector → STUCK
process restart during RUNNING → ERROR + interrupted action observation
```

SDK 明确把 `IDLE`、`RUNNING`、`PAUSED`、`WAITING_FOR_CONFIRMATION`、`FINISHED`、`ERROR` 和 `STUCK` 区分开。Agent Server 在后台 task 中调用 conversation.run，并在 completion 后等待待发布事件排空，再发布最终 state update，避免 WebSocket 先看到 finished、后看到 action/message 的逆序。

这是一种“Conversation 级终态 + Event 级执行事实”的模型。它比普通 CLI loop 更适合远程 UI 和恢复，但仍需要进一步区分：Conversation 状态是当前运行摘要，EventLog 才能解释它为何进入该状态；状态字段本身不能替代事件历史。

## 十八、审批、暂停与恢复的 backend 语义

SDK 的 confirmation policy 由 conversation state 持有，Agent 在 action batch 生成后根据 security risk 和 policy 判断是否需要确认。需要确认时，未匹配的 ActionEvent 保留在 event log/state 中，Conversation 进入 `WAITING_FOR_CONFIRMATION`；Agent Server 的 `respond_to_confirmation` 再批准执行或生成 rejection observation。

这个设计有三个重要特点：

1. 审批作用于已生成的 action，不是让模型重新生成一遍请求；
2. approval policy 可以按 conversation 更新，属于 session/runtime 配置；
3. 工具拒绝仍产生 agent 可见的 observation，不是 UI 静默丢弃。

暂停则由 Conversation/Agent Server 控制，状态变为 `PAUSED`，后续 resume 复用 conversation identity。若进程在 tool 执行中崩溃，初始化逻辑会把遗留的 `RUNNING` 标记改成 `ERROR`，并为第一个 unmatched action 写入“工具执行被中断”的 error event。这个策略优先保证历史诚实：它不把未完成 action 伪装成成功，也不自动声称文件变更已经回滚。

## 十九、Workspace ownership 与执行后端

SDK 的 `BaseWorkspace` 把 read/write/execute 等操作抽象成 workspace contract；`LocalWorkspace` 在本地目录执行，`RemoteWorkspace` 通过 Agent Server 连接远程 workspace。ConversationState 明确保存 workspace，而不是直接使用进程 cwd；Agent Server 在创建 conversation 时为它绑定 workspace 和 persistence directory。

因此 OpenHands 的 Environment 更接近：

> Conversation-owned workspace + execution backend + confirmation/security policy + event persistence。

这比 frontend 的 runtime URL 更完整：SDK Agent 真正通过 conversation state 取得 workspace、policy、hooks、secret registry 和 agent config。RemoteConversation 只改变控制/执行 transport，不改变 Agent 的 action-observation 语义。

但 workspace ownership 仍不自动提供文件与对话的联合 rollback。SDK 的 conversation persistence、workspace operations、git utilities 和 file history 可以分别支持恢复与审计；要确认一次 rewind 是否原子地覆盖 transcript、文件树、进程和 browser，需要专门的 runtime experiment。

## 二十、Context condenser 的恢复含义

Agent 在每次 `step()` 前根据 EventLog 生成 LLM messages；如果 context 超限且配置了 condenser，则产生 CondensationRequest/Condensation event，再用压缩后的 conversation view 继续。原始 events 保留，condenser 负责模型可见 projection。

这形成了与 Gemini/OpenCode 类似但更轻量的双层结构：

```text
EventLog / ConversationState
          ↓ condenser
LLM-visible message projection
          ↓
Agent.step → action/observation events
```

SDK 的 condenser 不是 workspace snapshot，也不是 process checkpoint。它解决 token budget 和长期对话，而不是恢复外部副作用。若模型在压缩前已经看到某个文件修改，压缩后的 summary 必须保留足够语义；但文件真实性仍由 workspace/git state 决定。

## 二十一、SDK backend 的设计原则

### 原则 1：Conversation 同时绑定 Agent、Workspace 与 EventLog

一个 conversation 不是纯消息容器，而是 Agent 配置、执行环境、审批策略、统计、secret、hooks 和事件历史的组合。这样本地和远程 Agent 可以共享同一生命周期。

### 原则 2：Action 与 Observation 是跨组件协议

Agent 产生 ActionEvent，workspace/tool executor 产生 ObservationEvent，二者通过 action/tool call identity 关联。UI、审计、Agent loop 和远程 API 都可以消费同一协议。

### 原则 3：审批发生在 action 已生成、effect 未执行之间

这保证用户批准的是具体工具调用和风险，而不是模糊的下一轮 prompt。拒绝也会回到 Agent context，允许模型调整行为。

### 原则 4：EventLog 保存事实，ConversationState 保存当前投影

EventLog 支持顺序读取、lazy loading、serialization 和 condenser；state 保存当前 status、policy、workspace 和 agent state。两者共同服务恢复，但 state 不是完整的 append-only event store。

### 原则 5：Workspace 是 conversation-owned execution boundary

Agent 不直接依赖宿主 cwd；workspace contract 可以指向本地或远程后端。这样 Agent Server 可以把相同 loop 运行在不同机器或 sandbox，但隔离强度由具体 workspace/backend 提供。

### 原则 6：流式事件与最终状态必须有顺序保证

Agent Server 在发布最终 state 前等待 callback queue 排空，避免客户端误判终态。streaming event 是低延迟观察，canonical event 和 state update 是恢复依据。

### 原则 7：异常恢复优先修复历史诚实性

进程重启时，将遗留 running conversation 标记为 error，并为 unmatched action 写入中断 observation。系统宁愿暴露未完成，也不把半执行状态伪装成成功。

### 原则 8：Agent Server 是 execution transport，不重新实现 Agent loop

REST、WebSocket、ACP 和 remote workspace 负责连接、控制、发布和恢复；真正的 model/action/observation loop 保留在 SDK Agent/Conversation。这样 Canvas 与 CLI 可以共享 backend 语义。

## 二十二、OpenHands 双仓库 Runtime 的最终模型

```text
Agent Canvas
  → backend registry / REST / WebSocket / UI projection
  → Agent Server
       → ConversationService / EventService
       → ConversationState / EventLog
       → Agent.step()
       → confirmation / hooks / security
       → Workspace / Local or Remote executor
       → ActionEvent / ObservationEvent
```

OpenHands 的真正 harness 由两个仓库共同完成：`OpenHands/OpenHands` 提供产品控制面、backend 选择、事件同步和多 Agent Canvas；`OpenHands/software-agent-sdk` 提供 Conversation、Agent loop、EventLog、Workspace、security/confirmation 和 Agent Server。前者决定“用户如何控制任务”，后者决定“任务如何执行并产生事实”。

这个双仓库边界是 OpenHands 与 Codex/Cline/Gemini 的关键差异：它把产品控制面和执行 runtime 在仓库层面分离，但通过 Conversation/Event/Workspace/API contract 重新连接。后续任何 OpenHands 架构结论都应同时标明 frontend commit 和 SDK/backend commit，不能只写 `OpenHands v1.15.0` 而省略执行引擎版本。
