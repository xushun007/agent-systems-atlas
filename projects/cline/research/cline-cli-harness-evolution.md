---
title: Cline CLI Runtime/Harness Analysis
reviewed_at: 2026-09-15
upstream_repository: https://github.com/cline/cline
upstream_ref: main snapshot; CLI package 3.0.49
upstream_commit: 5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa
status: current
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Cline CLI Runtime/Harness 分析

本文研究 Cline CLI 在 monorepo commit [`5ec2d47`](https://github.com/cline/cline/commit/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa) 的 Runtime/Harness，CLI 包版本为 `3.0.49`。它不是独立 CLI 项目的历史版本，而是与 VS Code、JetBrains、SDK 共享 agent core 的 CLI surface；入口说明见 [`apps/cli/README.md`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/README.md)。

## 结论

Cline CLI 的核心架构是“共享任务 runtime + 多种宿主”。CLI 负责启动、配置、TUI/headless/JSON 输出和 connector 接入；session/runtime/turn 负责把一次任务连接到共享 agent core；tool policy、checkpoint、MCP、hooks、skills 和 provider 配置构成可变能力层。它的产品能力来自同一任务语义在交互终端、CI、后台 hub 和聊天连接器之间复用。

更深一层看，Cline 的基本持久化对象不是单独的 `Turn`，而是可恢复的 task/session。CLI 的 prompt 只是向现有 task runtime 投递输入；runtime-turn 负责一次执行；checkpoint 则同时关联 transcript 与 workspace state。这个设计解释了为什么用户可以从 Plan 切 Act、从历史恢复、用 `/undo` 回退文件、或把同一 session 暴露给 Telegram/Slack/ACP：UI 是 surface，task/session 才是产品事实。

## Runtime 生命周期

```text
CLI command / TUI / connector / hub
              ↓
        SessionRuntime
              ↓ one or more RuntimeTurn
        Agent core + provider + tool policies
              ↓ events / approvals / checkpoints
        TUI, NDJSON, connector updates, session store
```

`SessionRuntime` 是会话边界，保存 session 配置、绑定和状态；`RuntimeTurn` 表示一次用户输入触发的 agent 运行；`run-agent`、`run-interactive` 和 `run-zen` 是不同的宿主流程。CLI README 明确列出 interactive、one-shot、JSON、yolo 和 zen 五种运行形态，说明“交互界面”并不等于“agent 生命周期”。实现入口见 [`run-agent.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/runtime/run-agent.ts)、[`session-runtime.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/connectors/session-runtime.ts) 和 [`runtime-turn.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/connectors/runtime-turn.ts)。

### Session、turn、step 的一致性边界

| 层次 | Cline 归属 | 用户可见行为 | 主要可变状态 |
| --- | --- | --- | --- |
| Session/task | file/memory state、history、connector binding | 恢复、继续、跨 surface 访问 | provider、mode、cwd、session binding |
| Turn | `RuntimeTurn` / agent run | 一次 prompt 到完成/中断 | tool queue、approval、compaction、usage |
| Step/iteration | shared agent core 内部模型-工具迭代 | 流式事件、工具输出、等待审批 | current message/tool state |
| Checkpoint | workspace snapshot + task marker | `/undo`、restore、fork | 文件树与回退指针 |

 Cline 的关键一致性策略是：事件输出可以是 NDJSON/TUI/connector 的不同投影，但 session/task 状态不应由这些 UI 各自维护；checkpoint restore 需要同时修复 workspace rewind 和 CLI `/undo`，历史提交 [`8d078f5`](https://github.com/cline/cline/commit/8d078f59bdb63f3d80a7e71668fe2f4066002c44) 正体现了这一点。审批是 turn 内的暂停点，mode/provider/cwd 是 session/runtime 配置，消息编辑或 session 替换则必须 settle pending approval，这也是历史提交 [`e450cbf`](https://github.com/cline/cline/commit/e450cbf5dd27f6e645b741717bd8fb7df2f61dff) 处理的问题。

## 关键组件

### 1. Session/turn 与表面解耦

同一 session 可以由 TUI、headless CLI、connector 或 zen hub 驱动；事件通过 event bridge/updates 分发到不同输出端。file-state 与 memory-state 将持久化和进程内运行区分开，session history、导出、fork 和 compaction 则负责长期任务的恢复与迁移。

### 2. 工具与策略

工具能力不是只在 CLI 中注册。MCP、skills、rules、spawn/team 等能力由共享 runtime 暴露，CLI 的 `tool-policies`、approval utilities 和 yolo/plan/act 模式决定调用是否需要用户确认。README 特别说明 yolo 会关闭部分 spawn/team 工具，显示策略层可以改变能力集合，而非只改变 UI。

Plan/Act 是一个真正的 policy transition：官方文档将 Plan 描述为允许探索、读取和规划但禁止修改文件/执行命令，切到 Act 后沿用同一上下文进入执行。因而“模型是否知道计划”与“工具是否可执行”分离；plan transcript 可以继续成为 act 的输入，但工具 capability 在 mode transition 时重新计算。CLI 的 `--plan`、`--auto-approve` 和 `--json` 是这一 policy/runtime 设计的产品入口，而不是单纯输出选项。

### 3. Checkpoint 与工作区回退

checkpoint picker、`/undo`、fork metadata 和 compaction 测试表明工作区变更与会话历史被作为可回退的任务状态处理。它比单纯保存聊天 transcript 更接近产品级 coding task runtime：用户可以继续、分叉或回退一次任务。

### 4. 多 provider 与 connector

provider registry、OAuth/API key 配置和不同宿主输出把模型接入从 agent loop 中抽离。Telegram、Google Chat、WhatsApp、Linear 等 connector 将 conversation thread 映射为 session，并提供 `/abort`、`/cwd`、`/yolo` 等运行时控制。

Connector 的本质不是“把消息转发给 CLI”：`thread → session` 映射、session persistence、session gone 后恢复、slash command 和 status update 都属于 host/runtime 协议。历史提交 `51e5daf8`（connector session persist/restore）和 `2131bbba`（Slack thread mapping recovery）说明 Cline 在解决的是远程会话的身份和恢复问题，而不是聊天适配问题。

## 架构演进的重大方向

本次已把 shallow history 加深到约 300 个 commit；以下节点结合 commit message、路径和当前实现确认：

1. **共享 surface/runtime**：当前 commit 的 CLI README 明确 CLI 与 VS Code、JetBrains、SDK 共享 agent core；这不是 CLI 新增一套 agent，而是把既有任务语义外置到多 surface。
2. **Compaction 进入 agentic runtime（`26037b17`，2026-07-21）**：从单纯 transcript 延伸为 agentic compaction，说明上下文管理影响 loop，而非仅是 UI 压缩。
3. **Connector session 持久化（`51e5daf8`，2026-07-27）**：远程 thread 与 session 绑定成为可恢复状态，Cline 开始具备跨消息入口的长生命周期。
4. **Settings/mode 跨重启恢复（`e3c6d510`，2026-07-28）**：mode、auto-approve、compaction 从一次进程参数变为持久化 session/runtime 配置。
5. **Checkpoint 可靠性（`8d078f59`，2026-08-01）**：workspace rewind、restore 和 CLI undo 被统一修复，体现 task transcript 与 filesystem state 的双重一致性。
6. **Prompt queue 与 Ask Question 抽离（`fbaa44be`、`5ec2d47b`，2026-08-03）**：用户输入不再直接塞进 UI loop，而有独立 queue/ask interaction 边界，支持持续输入、等待审批和异步 agent 状态。

这些事件显示 Cline 的主要演进是产品 runtime 化：把原本属于 IDE UI 的 prompt queue、审批、checkpoint、session 和 connector 责任迁移到可复用的 core/host 边界。

## 定位与边界

Cline CLI 比 mini-swe-agent 更产品化，比只面向单一终端的 agent 更强调宿主复用；它与 Codex/Kimi 一样重视持续任务与权限控制，但通过共享 UI/connector/runtime 生态放大能力。当前证据不能证明所有 CLI 行为都在同一进程内完成，尤其 zen hub 的 daemon 边界需要运行时实验确认。

官方使用文档与源码边界一致：CLI 支持 interactive/headless/JSON、Plan/Act、auto-approve、MCP、history、hub 和 schedule；Plan 模式明确禁止执行，Act 模式复用 planning context 后执行，checkpoint 用于回退 workspace。这些用户体验说明 Cline 把“持续任务”作为第一-class 产品对象，而不是把每个 prompt 当作独立 shell run。参见 [CLI Overview](https://docs.cline.bot/usage/cli-overview)、[CLI Reference](https://docs.cline.bot/cli/cli-reference) 和 [Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act)。

## 未确认事项

- 当前 history 已加深约 300 个 commit，但仍不是项目诞生以来的完整历史；更早的 VS Code core 演进需要继续按关键目录 deepen。
- 尚未运行 TUI、JSON、zen 或 connector，因此事件顺序、session 恢复和 checkpoint 的真实时序未验证。
- 工具声明在何时进入具体 provider 请求，以及不同模型 API 的 KV cache 影响，需要请求录制实验确认。

## 设计原则

Cline CLI 的核心不是把 Agent 搬到终端，而是把一个持续的 coding task runtime 暴露给多个 host。以下原则由 CLI runtime、shared core contract、事件桥接、connector、checkpoint 和官方使用方式归纳。

### 原则 1：Session/Task 是产品事实，CLI 是宿主

CLI、TUI、JSON、connector、hub 和 SDK 都可以成为 host；它们负责输入采集与输出投影，shared core 负责 agent 生命周期。CLI prompt 只是向 session/task 投递输入，不是一次孤立的模型调用。

### 原则 2：持续输入必须通过 Prompt Queue

agent turn 执行期间用户仍可能输入下一条 prompt、steer、回答 question 或取消任务。pending prompt 带有 id、delivery 类型、附件数量和 session id，并通过 pending_prompts 与 pending_prompt_submitted 事件反馈 UI。因此输入具备投递语义和生命周期。

### 原则 3：Turn 必须通过事件可观察

AgentEvent 包含 iteration、content/reasoning chunks、tool progress、usage、error 和 done。structured event 是首选，旧 chunk JSON 是兼容 fallback；done event completeness score 用于避免不完整终态覆盖最终结果。

### 原则 4：Runtime state 与 UI projection 分离

TUI、JSON consumer 和 connector 都消费同一事件流，不应成为 agent 状态的唯一来源。这样 UI 可以重绘、connector 可以丢失一次 status update、CLI 可以退出而 hub 任务继续，但 host 必须处理排序、重复、abort 和终态。

### 原则 5：Tool Policy 是 capability overlay

baseline policy、通配符 policy、tool-specific policy 和 interactive override 共同决定工具行为。auto-approve 关闭时，读取、搜索、询问等 safe tools 仍可放行，修改、shell、浏览器和团队工具需要更严格策略。工具存在与工具当前可执行不是同一概念。

### 原则 6：审批必须是跨 host protocol

TUI modal、Telegram 文本、JSON client 都是 approval interaction。approval payload 使用 approval id、session id、tool call id、tool name 和 input，把用户决定返回同一个 runtime call。审批不是 UI 的临时 boolean。

### 原则 7：Plan/Act 是同一 Session 的 policy transition

Plan 允许探索和规划但禁止修改与执行；Act 复用 planning context 后开启执行。它不是两个无关对话，也不只是 UI 状态，因此 mode transition、pending approval 和 compaction 都必须服从 session/runtime 语义。

### 原则 8：Checkpoint 关联 Conversation 与 Workspace

undo、checkpoint、fork 和 workspace rewind 将文件变更视为 task state，而不是不可见 shell side effect。恢复可能只回退文件、只回退对话，或同时回退两者，因此 checkpoint 是 transcript 与 filesystem 的关联点。

### 原则 9：Compaction 保持 task identity

agentic compaction 进入 shared runtime，目标是让长任务在同一 session 中继续，而不是简单压缩 UI 文本。压缩必须保留计划、工具结果、task identity 和继续执行所需上下文。

### 原则 10：Connector 是 Session Adapter

connector 将外部 thread 映射到 session，消费 tool start/end、text delta、approval、failure 和 completion；它不重新实现模型 loop。status delivery failure 被视为通知故障，而不是 runtime 任务故障。

### 原则 11：Hub 把长任务移出前台进程

zen mode 将任务交给后台 hub daemon，前台 CLI 可以退出。由此产生 session discovery、daemon restart、orphan cleanup 和认证问题，但也使任务不依赖一个终端进程。

### 原则 12：Provider 与 Runtime 解耦

provider registry、OAuth、API key、model id、thinking level、retry 和 context overflow recovery 在模型配置边界内；runtime 向 host 输出统一 AgentEvent、usage、error 和 result。不同 provider 的 capability 必须由 adapter 归一化。

### 原则 13：安全默认值按工具语义细化

安全不是一个全局 auto-approve boolean，而是 tool、input、mode、workspace 和 policy 的组合。CLI policy override 只说明 host 层意图，完整安全判断仍在 shared core。

### 原则 14：失败状态必须跨 host 可解释

recoverable error、fatal error、abort、done、usage 和 tool status 都具有结构化表示。不同 host 可以用 text、JSON 或 connector message 展示，但不需要重新猜测任务是否结束。

## 核心控制流

一次 CLI prompt 的路径是：解析 cwd/provider/model/mode/approval，创建 core 并注入 terminal capabilities，注册 AgentEvent subscriber，提交 prompt，执行多次模型与工具 iteration，处理审批、question、submit、compaction、retry 和 error，最后统一清理 hooks、runtime、subscriptions 和 session manager。

一次 connector turn 的路径是：thread 找到 session，HubSessionClient 发送 request，connector 订阅 session event stream，text delta 进入 queue，tool start/end 转为 status，approval.requested 转为用户 Y/N，failed 转为 onFailed，最后以 text、finish reason 和 iterations 结束。

这两条路径共享 session/runtime，却拥有不同的 backpressure、输出编码和审批 UI。这正是 shared core、多 host 的实际架构。

## 设计收益与代价

| 原则 | 收益 | 代价 |
| --- | --- | --- |
| shared core | 多 surface 语义一致 | core contract 复杂 |
| session/task first | 支持恢复和后台任务 | 需要持久化与状态迁移 |
| prompt queue | 支持连续输入和 steer | 需要投递顺序与取消语义 |
| event protocol | TUI、JSON、connector 复用 | 需要去重、重连、终态收敛 |
| policy overlay | 工具级安全和模式切换 | capability 与 policy 需同步 |
| checkpoint | 文件与对话可回退 | 双状态恢复复杂 |
| connector adapter | 外部聊天入口复用任务 | thread/session mapping 运维复杂 |
| hub daemon | 前台退出后任务继续 | daemon 生命周期和认证复杂 |

## 用户体验对应的 Runtime 机制

| 用户动作 | Runtime 机制 |
| --- | --- |
| 输入下一条消息 | pending prompt queue |
| Plan 切换 Act | session policy transition |
| 拒绝工具 | approval protocol + tool result |
| /undo | checkpoint 与 workspace rewind |
| 刷新/重连 | session identity + event replay |
| JSON 自动化 | structured AgentEvent |
| Telegram/Slack 操作 | connector thread/session adapter |
| --yolo | interactive policy override |
| hub 后台运行 | daemon-owned session |

## 核心定位与证据边界

Cline CLI 的真正核心是 shared Session/Task/Turn/Tool runtime，CLI 只是注入 capabilities、转发事件和提供终端交互。它与 mini-SWE-agent 的差异不是工具数量，而是把持续输入、审批、checkpoint、compaction、connector、hub 和多 provider 纳入长期任务生命周期。

源码直接确认：CLI core 创建与 capability 注入、AgentEvent subscription、pending prompt event、connector tool/approval stream、tool policy override、runtime cleanup。历史确认：agentic compaction、connector session persistence、跨重启 settings、checkpoint restore、prompt queue 与 ask extraction。

仍需读取 shared core 或运行实验确认：单次 turn 内部 step 状态机、checkpoint 原子性、compaction 后的 message projection、approval 持久化、hub daemon 恢复、MCP tools 是否动态影响 provider request，以及不同 host 的 cancellation cascade。

## Runtime 状态所有权

| 状态 | 所有者 | Host 行为 |
| --- | --- | --- |
| session identity | core/session store | 恢复、绑定 connector |
| pending prompt | session runtime | 入队、steer、取消 |
| agent iteration | shared agent core | 观察 event、发送 abort |
| tool approval | core policy/approval bridge | 提供用户决定 |
| workspace checkpoint | checkpoint/file history | 请求 restore/undo |
| terminal result | runtime | 映射为 text/JSON/status |

这个分层说明 CLI 进程不是 session 的唯一所有者。前台退出后 hub task 可以继续；UI 重绘也不应改变 tool approval correlation。

## 失败收敛路径

Cline runtime 需要区分模型失败、工具失败、宿主失败和控制失败。provider error、context overflow、tool error、用户拒绝属于 agent 语义；TUI 渲染或 connector status delivery failure 属于宿主语义；abort、timeout、session replacement 属于控制语义。connector 中 status delivery failure 被降级为 warning，说明通知失败不等于任务失败。

## 历史演进的重新解释

301 个可用 commit 显示三条并行主线：prompt queue、ask question 和 tool policy 从 UI 抽到 shared runtime；connector session、settings、checkpoint、compaction 变成跨重启状态；CLI、ACP、hub、Telegram/Slack 不断增加，但共享 event/runtime contract 不变。

51e5daf8 代表 connector session persistence，e3c6d510 代表跨重启 settings，8d078f59 代表 workspace recovery，5ec2d47b 代表 prompt queue。它们共同把 Cline 从 IDE agent 推向 task platform。

## 研究验证计划

应验证连续 prompt 的 queue/steer 顺序、approval 等待时的输入与 Ctrl-C、Plan 到 Act 后 tools/policy 的变化、checkpoint 的 conversation/file 双回退、JSON 与 connector 的 event identity、hub 脱离前台后的 session 恢复，以及动态 MCP tools 对 request/cache 的影响。

## 面向横向研究的核心抽象

### Session、Turn、Step：Cline 的运行时关系

可以把 Cline 的一次持续任务抽象成如下关系：

```text
Session / Task
  ├─ persistent conversation and task identity
  ├─ host binding and runtime configuration
  └─ Turn 1, Turn 2, ...
       ├─ user input delivery
       ├─ model/tool iterations
       ├─ approval or question suspension
       └─ terminal outcome
            └─ Step: model response → tool call → tool result
```

这里的 `Step` 不是独立的用户可恢复对象，而是 turn 内部的一次模型—工具往返。一个 turn 可能包含多个 step；工具审批会让 step 暂停，但不会自然地创建新的 turn。用户在运行过程中继续输入时，输入首先进入 session runtime 的投递队列，随后按照 host 支持的语义成为当前 turn 的 steer、当前 turn 的补充信息，或下一个 turn 的 prompt。具体归类取决于 core 的队列实现，不能仅凭 CLI 的输入框判断。

从一致性角度可分成三类：

| 状态类别 | 典型内容 | 是否应当可变 | 变化方式 |
| --- | --- | --- | --- |
| 身份事实 | session id、task transcript、connector thread 绑定 | 低可变 | 追加事件、恢复、迁移 |
| 运行控制 | mode、auto-approve、provider、pending prompt、abort | 可变 | 通过显式命令或控制事件改变 |
| 执行事实 | tool call、tool result、usage、error、checkpoint | 追加为主 | 产生新事件；回退时建立新边界 |

因此，`session` 是长期身份与恢复边界，`turn` 是一次可观察的工作单元，`step` 是 turn 内部的执行粒度。Plan/Act、模型切换、增加可信任工作目录属于 session/runtime 配置变化；审批与中断属于 turn 控制；模型输出和工具结果属于执行事实。历史消息和已完成工具结果原则上应视为不可变日志，新的 steer、审批决定和恢复动作则应追加，而不是静默改写过去。

这个模型也解释了 Cline 的几个产品行为：

- 重新连接 connector 不应产生新任务，而应重新绑定原 session 并继续消费事件。
- `/abort` 终止当前 turn，但不等于销毁 session；用户仍可以继续提交 prompt。
- `/undo` 不只是删除一段文本，而是请求 workspace checkpoint 与任务历史共同收敛到某个可继续状态。
- session replacement 或消息编辑发生时，旧 turn 的 pending approval 必须先结束，否则一个已经失效的 UI 仍可能批准旧工具调用。

### Environment：不是 cwd，而是可执行边界

对 Cline 而言，environment 不宜定义成一个字符串 `cwd`。更合适的定义是：

> Environment = 工作区身份 + 文件系统可见范围 + 命令执行上下文 + 信任/审批策略 + 外部连接能力。

其中 cwd 只是默认路径。真正影响一次 tool call 的还有 workspace root、允许访问的文件范围、shell 的环境变量和启动目录、MCP server、网络能力、checkpoint provider、模型 provider，以及当前 Plan/Act/YOLO policy。增加可信任工作目录并不是普通 session 文本，而是改变后续工具调用的安全前提；它应该被看作 environment/policy 变更，并留下可追溯的配置事件。

这也是 Cline 从 IDE agent 走向多 host runtime 后必须面对的边界：同一个 session 可以从终端、IDE 或远程 connector 进入，但不能因为 host 改变就隐式改变工作区权限。host 可以请求切换 environment，core 则应重新计算工具策略并让用户知道该变化。

### 动态工具与能力平面

“可变工具”有两层含义：

1. 工具集合可变：MCP server、skills、connector 能力、workspace 状态或 provider capability 变化时，新的工具可能被注册或移除。
2. 工具权限可变：同一个工具在 Plan、Act、YOLO、审批等待或不同工作区中可能具有不同的可执行条件。

因此，工具注册、工具描述、工具策略和工具执行不是同一层。可以抽象为：

```text
tool sources → capability registry → policy evaluation → model-visible tools
                                               ↓
                                         approval bridge
                                               ↓
                                         executor
```

工具通常需要以 schema/description 的形式参与 provider request，但“动态注入 prompt”不是唯一实现，也不应把注册表与自然语言 prompt 混为一谈。工具 schema 更可能位于模型请求的 tools 字段或宿主协议中；规则、skills 和 mode 约束则可能通过 system/developer context 或 policy gate 表达。Cline 当前代码足以确认能力和策略分层，但尚不足以确认每一种 MCP/skill 变化的具体请求编码。

对 KV cache 的影响要分开判断：

- 如果动态工具改变 system/developer 消息或 tools schema，通常会改变请求前缀，可能使前缀缓存失效或缩短可复用前缀。
- 如果工具已注册但仅在执行前由 policy gate 拒绝，模型请求可能不变，主要影响执行结果而非 KV cache。
- 如果 host 侧把工具结果作为新消息追加，则会影响后续 turn 的上下文长度，但不等于每次注册都导致全量 cache 失效。

所以 Cline 的重要架构问题不是“工具是否动态注入 prompt”，而是 capability snapshot 在哪个边界冻结：每个 turn、每次 model request，还是整个 session。当前源码与提交记录支持“运行时动态能力 + 请求时策略判断”的结论，但冻结点和 provider-specific cache 行为仍需请求录制实验确认。

## Cline 的设计取舍

Cline 的 runtime 选择可以概括为“把 IDE 中已验证的 coding-agent 交互能力，提升为可被多个 host 复用的持续任务平台”。它的优势和成本分别来自以下取舍：

| 取舍 | 获得的能力 | 引入的复杂度 |
| --- | --- | --- |
| task/session 优先于单次调用 | 恢复、后台运行、connector 复用 | 身份、迁移和生命周期管理 |
| shared core 优先于 host 自治 | IDE、CLI、SDK 行为一致 | 跨 host contract 和版本兼容 |
| 结构化事件优先于文本输出 | 自动化、重连、状态展示 | 事件顺序、去重和终态收敛 |
| 工具策略优先于全局开关 | 细粒度安全与模式切换 | capability 与 policy 的组合爆炸 |
| checkpoint 优先于不可逆执行 | undo、恢复、探索性修改 | transcript 与文件系统双重一致性 |
| prompt queue 优先于阻塞式输入 | 连续输入、steer、远程控制 | 排队、取消、过期 approval 的语义 |

它与 Codex 类产品 runtime 的接近之处，是都把权限、持续会话、恢复和环境纳入 harness；与 mini-SWE-agent 的距离，则在于 Cline 把 host、连接器和用户控制面也纳入一等架构。Cline 的核心复杂度并非 agent loop 本身，而是一个长期任务在多个入口、多个权限状态和多个执行环境之间保持同一身份与可解释终态。

## 本轮结论与证据等级

### 已确认

- CLI 是 shared agent core 的宿主，不是独立的一套模型 loop。
- session/task、turn、事件流、工具策略、审批桥接、checkpoint 和 connector 是相互关联的 runtime 层。
- prompt queue、agentic compaction、connector persistence、跨重启设置与 workspace rewind 是当前历史中明确的架构级演进节点。
- 当前分析基于固定 commit `5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa`，重要判断均保留 GitHub 固定版本链接。

### 解释性判断

- Cline 正在从 IDE 内嵌 agent 演进为多 host 的 coding-task platform。
- checkpoint 是 conversation 与 workspace 的联合恢复边界，而非单纯的文件快照。
- 动态工具更适合被理解为 capability plane 与 policy overlay，而不是简单的 prompt 拼接。

### 尚未确认

- shared core 内部 step 的精确定义，以及 queue 中输入被判定为 steer 还是下一 turn 的条件。
- 各 provider 的 tools/schema 编码与缓存前缀复用行为。
- hub 脱离前台后的崩溃恢复、事件 replay 和 checkpoint 原子性。

本轮先完成 Cline 的概念和流程深化；上述未确认项保留为后续实验问题，不用源码片段代替运行时证据。
