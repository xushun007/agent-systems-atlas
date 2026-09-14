# Hermes Agent Harness 的 Runtime 演进研究

本文研究 Hermes Agent 从早期单体 Agent Loop 到 `v2026.8.31`（代码版本 `v0.21.0`）的整体 Harness/Runtime 演进，重点关注：如何接收和持续处理用户输入；如何组织 Session、Turn、Step；如何把模型调用、工具执行、权限审批和中断串成一致生命周期；如何从本地 cwd 扩展到多种执行环境；如何通过上下文压缩、持久化和 Gateway 支撑长期运行；以及 Subagent、Cron、MCP、ACP 和 Desktop/Bot Mode 如何进入同一运行时。

这里的 Harness 指模型调用周围的运行时，而不是模型本身：输入队列与中断、提示词和工具 schema、provider 路由、工具执行与审批、执行环境、上下文压缩、Session 恢复、宿主集成和可观测回调。

## 研究基线与证据范围

- 代码基线：[`v2026.8.31`](https://github.com/NousResearch/hermes-agent/tree/29112bef099274229cadff79cdff7bf7b99c4b77)，对应提交 `29112bef099274229cadff79cdff7bf7b99c4b77`，发布为 Hermes Agent `v0.21.0`。
- 代码证据：固定 commit 下的 [`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/run_agent.py)、[`agent/conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/conversation_loop.py)、[`agent/turn_context.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_context.py)、[`agent/turn_finalizer.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_finalizer.py)、[`hermes_state.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/hermes_state.py) 和 [`tools/registry.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/registry.py)。
- 官方架构说明：[`developer-guide/architecture.md`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/architecture.md)；循环、工具和 Session 细节见 [`agent-loop.md`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/agent-loop.md)、[`tools-runtime.md`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/tools-runtime.md) 和 [`session-storage.md`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/session-storage.md)。
- Git 历史说明：本地源仓库原本是浅 clone，目标 tag 已单独物化为完整源码 worktree；由于网络 DNS 无法继续 deepen，未把全部历史提交拉入本地。历史阶段依据 tag、当前源码中的兼容结构、官方版本发布说明和官方架构文档重建；因此早期阶段的精确 commit 边界仍属于待补证据，而不是源码级断言。

## 核心结论

Hermes 的架构演进可以概括为：

> 一个以 `AIAgent` 为中心、以消息历史为内部状态的同步 Agent Loop，逐步外扩为一个多入口、多会话、多环境、多代理的个人 Agent 平台 Runtime；核心 Loop 的中心化 ownership 没有被彻底替换。

主要变化有六个：

1. **从一次性 CLI 调用变成长期 Session Runtime。** `AIAgent` 不只负责一次模型调用，还拥有历史、provider、工具、回调、压缩状态、任务资源和 Session identity；SQLite/FTS5、resume 和 lineage 让会话跨进程继续。
2. **从“Turn = 一次请求”变成 Turn 内多次 model/tool iteration。** 一个用户输入可以经历多次模型调用、工具调用、重试、fallback、压缩和中断；代码虽然已经拆出 `turn_context`、`turn_finalizer`、`turn_retry_state`，但 Step/iteration 仍主要是运行中的控制状态，不是独立的不可变快照。
3. **从 cwd 传参变成 Session/Task 绑定的执行上下文。** `runtime_cwd`、`task_id`、环境注册表和 terminal backends 把本地、Docker、SSH、Modal、Daytona、Singularity 等后端纳入统一工具调用；但 Environment 仍由工具和会话上下文组合出来，不是一个严格不可变的一级领域对象。
4. **从静态工具函数变成策略化能力面。** 工具由 registry、toolset、`check_fn`、MCP、插件和平台条件共同决定；model-facing schema 在每轮组装和过滤。能力是动态可用的，但审批、沙箱、凭据和工具可见性仍分布在 registry、tool、agent loop 和宿主回调中，而不是一个单独的统一 Policy Kernel。
5. **从滚动内存历史变成可压缩、可恢复的持久历史。** ContextEngine/压缩器负责选择、摘要和 lineage rotation；SessionDB 保存消息、使用量、压缩锁和检索索引。压缩生成 child session，而非改写为单一不可变事件流。
6. **从单 Agent 宿主变成平台化 Agent 网络。** Gateway、ACP、API、Cron、Subagent、MCP 和 Desktop/Bot Mode 共享 `AIAgent`，但每个入口注入自己的 session key、回调、环境和投递语义。`v0.21.0` 的 Bot Mode、bot-to-bot DM、可持续 Cron、实时 steer 和桌面浏览器，标志着 Runtime 开始承载“多个持续存在的 Agent”而不只是 coding assistant。

## 1. 演进主线：从 Agent Loop 到 Agent Platform

### 阶段一：单体 CLI + 中心化 Agent Loop

早期 Hermes 的基本形态是：CLI 接收用户文本，创建 `AIAgent`，构造 system prompt，调用一个 provider，遇到 tool call 就执行并把结果放回历史，直到生成文本。当前代码仍保留这条最短路径：CLI、Batch、Python library 等入口最终汇入 `AIAgent`，核心实现集中在 `run_agent.py` 与逐步抽出的 `agent/` 模块。

这个阶段的关键设计选择是“内部统一消息格式”：不同 provider/API mode 在边界转换，但循环内部仍使用 OpenAI 风格的 `user/assistant/tool` 消息。这降低了 provider 接入成本，也使工具循环、重试和持久化共享一套状态模型。

### 阶段二：Provider、工具和 Context 成为可替换运行时部件

随着模型和后端增多，Loop 外围形成三个可插拔面：

- provider resolution：从 `(provider, model)` 解析 API mode、凭据和 base URL，并支持 fallback；
- prompt/context：由 prompt builder、memory、skills、context files、ContextEngine 和 compressor 共同生成有效上下文；
- tool runtime：registry 负责发现、schema、可用性检查和 dispatch，terminal/browser/web/MCP 等工具负责具体后端。

这不是完全解耦的 actor/kernel 架构：`AIAgent` 仍是组合者和最终 owner，只是把模型供应商、上下文策略和工具后端从一个函数体逐步变成可替换组件。

### 阶段三：Session 持久化、压缩和 Gateway 化

Session 从内存中的消息列表演进为 SQLite 中的 `sessions` + `messages`，配合 FTS5、usage attribution、压缩锁、profile/平台元数据和 `parent_session_id` lineage。官方文档明确把压缩产生的 child session 作为 lineage，而不是简单截断原列表。

Gateway 随后把同一个 Agent Loop 放到消息平台、webhook、API server 和多 profile 场景中：外部 MessageEvent 先解析 session key，再创建或恢复 AIAgent，执行完成后经平台 adapter 投递结果。由此 Session 的 identity 不再只由本地 CLI 产生，还受平台、chat、profile 和 workspace 路由影响。

### 阶段四：多入口与环境后端扩展

ACP 把 Hermes 变成 IDE 可调用的 agent server；Cron 把它变成可调度的后台 agent；Subagent/delegation 把一次 Turn 拆成多个有独立上下文和 iteration budget 的 Agent；terminal environments 则把工具执行从当前进程 cwd 扩展到容器、远程主机和托管 sandbox。

此时“coding agent”只是一个 surface。相同的核心 Loop 可以通过 CLI 做交互式 coding，通过 ACP 做编辑器会话，通过 Gateway 做持续消息 Agent，通过 Cron 做周期任务，通过 delegate 做子任务。

### 阶段五：平台化多 Agent Runtime（v0.20–v0.21）

官方 `v0.21.0` 发布说明把这一阶段命名为 Pantheon Release：Bot Mode 进入 Desktop，Agent 有 profile、名字、头像、共享 roster 和 group chat；`hermes peer` 让 Agent 之间可以持久化通信；Cron 具备 memory/continuity；Subagent 支持 live steering；MCP 变成 command center；Agent 可以驱动 Desktop 自己的 browser。[官方发布说明](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31)

这意味着运行时的主实体从“当前的一次对话”向“长期存在的 Agent profile + 多个可恢复会话 + 多种投递渠道”移动。核心 Loop 没有消失，但它被更大的生命周期系统包围：profile、gateway、bot chat、cron、desktop backend 和共享 state 都成为 Harness 的一部分。

## 2. 当前 Runtime 的控制流

在目标 tag，主控制流可以压缩为：

```text
CLI / Gateway / ACP / API / Cron / Desktop
  -> resolve profile, session key, cwd, callbacks
  -> create or restore AIAgent
  -> prepare turn: append user input, load history, establish task_id
  -> preflight context: prompt, tools, token estimate, compression
  -> provider call
  -> assistant tool_calls?
       yes -> approval/hooks -> tool backend -> tool result -> next iteration
       no  -> finalizer -> persist messages/memory/usage -> deliver response
  -> interrupt / steer / retry / fallback may redirect the active turn
```

源码中的 `conversation_loop.py` 说明了一个关键事实：Turn 不是单次 API 请求，而是“模型调用、工具 dispatch、重试、fallback、compression、post-turn hooks”的完整过程；`turn_context.py` 负责准备与压缩前置工作，`turn_finalizer.py` 负责中断、持久化、资源清理和结果封装。

## 3. Session、Turn、Step 的关系

### Session：长期身份与恢复边界

Session 是最稳定的运行时边界，通常包括：

- `session_id`、profile、source/platform、gateway session key；
- 消息历史、标题、model usage、压缩状态和 parent/child lineage；
- 与当前 Session 关联的 memory、workspace/cwd、工具审批状态和宿主路由；
- 可被 `/resume`、Gateway 重启或 ACP 重连恢复的持久记录。

Session 的“身份”应尽量稳定，但其运行配置不是全部不可变：用户可以切换 model、增加可信目录、改变 toolset、更新 profile 或继续使用新的环境。Hermes 通过 session metadata、agent 属性和宿主上下文承载这些变化，而不是为每次变化生成统一的 immutable snapshot。

### Turn：一次连续用户意图的执行事务

Turn 通常从一个用户输入开始，在最终文本、失败或中断时结束。Turn 期间会：

- 追加本轮 user message；
- 生成 `task_id`，用于 terminal/browser/VM 等任务资源隔离；
- 执行多个 model/tool iteration；
- 处理 approval callback、`/stop`、`/steer`、重试、fallback 和 context compression；
- 在 finalizer 中决定哪些消息、usage、memory 和结果可以落盘。

用户中断并不等于 Session 结束。源码会关闭未完成的 tool sequence、记录 interrupted 结果、清理 task resources，并保留可恢复的 Session。中途 steer 更接近“向活动 Turn 注入新的 user row”，而不是开启一个完全独立 Session；官方发布说明也明确把 mid-turn steer 作为 agent-loop 能力。

### Step/iteration：控制循环中的短生命周期状态

Hermes 的 `step_callback`、iteration budget 和 tool call iteration 提供了 Step 语义，但它不是像 Codex 那样清晰的、可独立恢复的快照实体：

- 一个 Step 通常对应一次模型响应及其工具执行阶段；
- 多个并发 tool call 会在同一 iteration 内执行，结果按原 tool-call 顺序重新插入；
- Step 状态主要驻留在内存和回调中，最终作为 assistant/tool message、usage 和 metadata 写入 Session；
- 中断、失败和重试由 TurnRetryState、interrupt flags 和 finalizer 协调，而不是通过不可变 Step event log 重放。

因此可用下表概括：

| 概念 | Hermes 的实际边界 | 稳定性 |
|---|---|---|
| Session | 持久 conversation/profile/lineage，可跨进程恢复 | identity 相对稳定，配置可变 |
| Turn | 一次 user intent 到 final/interrupted/failed 的完整执行 | 结束后消息与结果持久化 |
| Step | model response + tool execution 的 loop iteration | 多为瞬时控制状态 |
| Message | provider-neutral transcript row | 持久，但可能在压缩后被摘要替代 |
| Environment | session/task/cwd + terminal/browser backend 的组合 | 由宿主和工具动态解析 |

## 4. 从 cwd 到 Environment

Hermes 中的 Environment 不是单一的 `Environment` domain object，而是几层状态的组合：

1. **逻辑 cwd**：`agent/runtime_cwd.py` 用 session context override、`TERMINAL_CWD` 或进程启动目录解析 agent cwd。
2. **Task identity**：每个 Turn 通常产生 `task_id`，用于隔离 terminal/browser/session resources。
3. **Terminal backend**：local、Docker、SSH、Modal、Daytona、Singularity、Vercel Sandbox 等后端按配置选择。
4. **Credential/env passthrough**：工具决定哪些环境变量、credential files 和 profile 信息可以进入 backend。
5. **Interactive host**：CLI、Gateway、ACP、Desktop 各自提供 approval、clarify、status、stream 和 delivery callback。

所以 Environment 的真实定义是：

> 在某个 Session/Turn 中，工具可以访问的 workspace、cwd、进程/容器/远程执行后端、凭据边界和交互回调的有效组合。

它比“当前本地 cwd”强，但还没有被提升成一个不可变、可序列化、可独立复用的 Runtime 对象。Session 可以重新解析 cwd 和 backend，工具也可能按 task_id 创建临时资源；这提供了灵活性，却使跨入口的一致恢复和安全审计更依赖调用链。

## 5. 从工具注册表到策略化能力面

Hermes 的工具不是简单地把所有函数永久塞进 prompt：

- 工具模块通过 `registry.register()` 自注册；
- AST discovery 自动发现 builtin tools；
- toolset、enabled/disabled 配置和 composite preset 决定候选集合；
- 每个工具的 `check_fn` 判断当前依赖、平台、凭据和运行条件是否满足；
- MCP server 和 plugin 可以追加动态工具；
- `get_definitions()` 最终生成当前模型请求的 tool schemas；
- dispatch 时再执行 hook、approval、参数检查、backend 调用和错误包装。

因此“可变工具”至少有三层含义：

1. **可见性可变**：当前 Session/model 的 prompt 中是否包含该 schema；
2. **可用性可变**：工具依赖、平台、凭据、MCP 连接是否健康；
3. **执行策略可变**：审批、沙箱、profile、task_id、backend 和插件 hook 如何处理调用。

工具 schema 确实会在 prompt/request 组装时影响模型输入，因此工具集合变化可能影响 provider 的 KV/prompt cache。Hermes 已有 prompt caching、stable/context/volatile prompt tiers 和 cache plan，设计目标是让稳定的 system prompt 前缀保持不变；但新增/删除工具、`/model`、profile/permission 变化或 context compression 仍可能改变可缓存前缀。这里的 cache 管理是 provider-facing 的 prompt caching 优化，不等价于把能力注册表做成一个独立的 cache-safe capability snapshot。

## 6. Context、压缩与持久化

Hermes 的 Context 由 system prompt、skills、context files、memory/profile、工具 schema、消息历史和 provider-specific projection 组成。运行时同时维护两种事实：

- **Durable transcript**：SQLite 中的消息和 Session metadata；
- **Effective prompt**：当前 provider call 实际看到的、可能经过压缩、工具过滤、缓存标记和 API mode 转换的输入。

当 token 估算或 provider overflow 触发压缩时，流程通常是：先 flush memory；压缩中间历史，保护最近若干消息并保持 tool call/result 配对；生成 summary；将压缩结果持久化；必要时旋转到 child session lineage；再继续当前 Turn。这样做的优点是可恢复、可搜索、可追踪 lineage；代价是“原始历史”和“当前有效上下文”之间存在摘要边界，不能把压缩后的消息列表视为完整事件重放。

SessionDB 还承担 FTS5 检索、usage attribution、跨进程写入协调和压缩锁。由此 Hermes 的持久化已经远超普通 JSON transcript，但它的核心数据模型仍然是“session + message rows”，而不是完整的 append-only runtime event store。

## 7. 权限、审批和中断

权限控制是分布式的：terminal dangerous-pattern approval、file/edit approval、ACP callback、Gateway interactive callback、sandbox backend、credential passthrough、plugin admission 和 profile 配置共同构成安全边界。

典型工具执行链是：

```text
tool_call
  -> registry resolve
  -> pre-tool plugin hook
  -> dangerous-command / edit approval
  -> terminal/browser/MCP/backend execution
  -> post-tool hook
  -> tool result appended to current Turn
```

approval 通常是 Turn 内等待的异步交互，不是独立 Session snapshot；批准状态可以按 Session 记忆，但不同入口的交互方式由 callback 决定。中断则通过 agent interrupt state、API call cancellation、tool cleanup 和 finalizer 收束。这个设计对产品集成很实用，但在概念上仍是“agent loop 加宿主回调”，不是统一的、可重放的权限决策日志。

## 8. 多 Agent、Cron、Gateway 与 Desktop

### Gateway

Gateway 是 Hermes 从 coding CLI 走向持续服务的关键。它负责平台 adapter、用户授权、session key 路由、消息投递、队列/锁、状态和跨平台 session；Agent 核心不需要知道 Telegram、Discord、Signal 或 webhook 的细节。

### Subagent

`delegate_task` 让 parent Agent 创建具有独立 context、task_id 和 iteration budget 的 child Agent。子 Agent 的输出再作为 tool result 或消息返回 parent。它是“Agent 作为工具”的组合方式，而非完全独立的分布式 worker runtime；生命周期和资源清理由 parent/agent loop 统筹。

### Cron

Cron 把 Turn 调度从“用户现在输入”扩展为“未来某时刻触发的输入”。在 v0.21.0，官方说明中的 continuity、memory、scratchpad 和 Bot Chat 让 Cron Agent 具备跨次运行的状态。这是从 stateless scheduled command 到 persistent agent identity 的重要变化。

### Desktop/Bot Mode

Desktop 把 Agent profile、Bot Chat、group chat、browser 和多 profile 后端组合成产品层。Bot-to-bot DM 被持久化到 canonical Bot Chat，说明 Agent 间通信不再只是一次 delegation 的临时返回值，而开始成为可检索、可恢复的 Session/Message 数据。

## 9. 架构判断：Hermes 的主要演进方向

### 不是“替换核心 Loop”，而是“围绕核心 Loop 建平台”

Hermes 没有把中心 `AIAgent` 完全降级成纯函数，也没有把所有生命周期拆成独立 event-sourced actors。它选择保留一条容易理解、容易接入多 provider 的中心执行路径，再不断把外部能力接进来：SessionDB、ContextEngine、Tool Registry、Gateway、ACP、Cron、Subagent 和 Desktop。

### 抽象强项在扩展面，不在状态不可变性

Hermes 对 provider、tool、environment backend、memory provider、context engine、platform adapter 的扩展性很强；但 Session/Turn/Step 的状态边界主要通过对象属性、消息 rows、回调和 finalizer 维护，Step 不是一等持久化对象，Environment 也不是严格的不可变 capability snapshot。

### 产品能力增长来自宿主和持久化层

从用户体验看，最重要的跃迁不是模型调用本身，而是：能恢复的 Session、跨平台 Gateway、可调度 Cron、可管理的 profile、可互相通信的 Bot、可交互的 Desktop 和能承载真实工具的执行后端。Hermes 的产品化能力主要由这些外围 Runtime 组合产生。

### 对 coding agent 的含义

Hermes 适合把 coding 作为一个 Agent profile/工具集合/环境配置，而不是把 coding workflow 固化为唯一的 Harness。它可以支持 IDE、CLI、远程消息和后台任务的统一 Agent identity；相应代价是，权限、环境、审批、中断和恢复的语义分散在多个层次，需要在跨产品比较时单独检查其一致性。

## 未确认事项

- 早期最初 commit 到各个架构阶段的精确边界，因本地上游仓库历史无法在当前网络条件下继续 deepen，尚未逐 commit 验证。
- 某些 v0.20.x 基础设施功能的引入顺序，当前依据 v0.21.0 release notes 和目标 tag 的兼容代码重建，未分别 checkout 每个 patch tag 做源码 diff。
- Desktop/Bot Mode 的部分状态协调可能依赖 `apps/desktop` 与 gateway/dashboard backend 的实现，本文关注 Runtime/Harness 边界，没有逐文件覆盖所有前端状态管理。
- 本文没有做真实 Gateway、ACP、Cron、approval 或多后端 terminal 的 runtime experiment；相关结论是源码和官方文档验证，不应标记为运行时实测。

## 验证依据

- [固定 commit 的官方 Architecture 文档](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/architecture.md)
- [固定 commit 的 Agent Loop 文档](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/agent-loop.md)
- [固定 commit 的 Tools Runtime 文档](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/tools-runtime.md)
- [固定 commit 的 Session Storage 文档](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/session-storage.md)
- [v2026.8.31 官方发布说明](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31)
