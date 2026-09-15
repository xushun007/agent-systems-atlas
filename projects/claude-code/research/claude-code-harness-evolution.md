---
title: Claude Code Runtime/Harness Analysis
reviewed_at: 2026-09-15
upstream_repository: https://github.com/freestylefly/claude-code
upstream_ref: master leaked-source snapshot
upstream_commit: 6e2f79c5b97ae619172a3e621e87dd0edb220619
status: current
verification:
  source_reading: true
  tests_read: false
  runtime_experiment: false
provenance: third-party public repository; not an official Anthropic release
---

# Claude Code Runtime/Harness 分析

本文研究 Claude Code 在第三方公开仓库 [`freestylefly/claude-code`](https://github.com/freestylefly/claude-code) 中的源码快照，重点关注 Query/Task/Tool/Session/Permission/Environment 等 harness 核心概念。分析 commit 为 [`6e2f79c`](https://github.com/freestylefly/claude-code/commit/6e2f79c5b97ae619172a3e621e87dd0edb220619)。该仓库 README 将自身描述为官网泄漏代码备份；它没有官方 tag、release 或完整公开历史，因此本报告是“源码快照架构分析”，不能视为官方版本演进结论。

## 结论

这份快照呈现的是高度产品化的 coding-agent runtime：`QueryEngine` 管理会话内多轮输入，`queryLoop` 管理一次 turn 内的模型—工具迭代，`Task` 管理后台 bash、子 agent、teammate、workflow、MCP monitor 和 dream 等并发工作，工具权限、MCP、memory、checkpoint、worktree、remote bridge 和 SDK 构成外围能力层。其显著特征是把“一个 agent 回答”扩展成可中断、可恢复、可分叉、可远程订阅的任务系统。

## Runtime 分层

```text
REPL / CLI / SDK / remote bridge / connector
                    ↓
             QueryEngine / ask()
                    ↓ submitMessage
             queryLoop (one user turn)
                    ↓ repeated iterations
       Claude API ← messages + system prompt + tools
                    ↓ tool orchestration
        permission / hooks / MCP / sandbox / tasks
                    ↓
          observations → next iteration → terminal
                    ↓
       JSONL session transcript + file history + summaries
```

`QueryEngine` 的注释明确区分 conversation 与 turn：一个 QueryEngine 对应一个 conversation，每次 `submitMessage()` 开始一个新 turn；query loop 内部还有 `turnCount` 和多次工具迭代。见 [`QueryEngine.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/QueryEngine.ts) 和 [`query.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/query.ts)。

## 关键组件

### 1. Query/turn loop

`QueryEngine` 保存 mutable messages、permission denials、累计 usage、read-file cache、已发现 skill 和 nested memory；这些状态跨 turn 持续。`queryLoop` 每次迭代维护 messages、tool context、自动压缩、输出 token 恢复、stop hook、pending tool summary 与 transition 原因。模型输出并不直接结束 turn，工具结果、压缩、重试和错误恢复都会继续推进 loop。

### 2. Tool 与 permission plane

`Tool.ts` 定义工具、MCP client、agent definitions、permission context、file history 和 abort 等依赖；`canUseTool` 以及 permission rules 决定工具是否允许执行。权限上下文包括 mode、additional working directories、always allow/deny/ask rules、plan mode 前状态和后台是否避免弹窗。工具还可通过 `refreshTools()` 在 MCP 连接中途更新，说明工具能力是 runtime 状态，而非仅仅是静态 prompt 文本。

### 3. Task supervisor

`Task.ts` 将 local shell、local/remote agent、in-process teammate、workflow、MCP monitor 和 dream 统一成带 status、abort、output file/offset 的任务状态。这个层把长时间或并发执行从主 query loop 中分离出来，并通过 AppState、task ID、输出文件和 kill 语义管理生命周期。

### 4. Session persistence 与 workspace history

session transcript 使用 JSONL 和 parent UUID 组织消息链，支持读取、列表、重命名、tag、fork 和 resume 相关 API；file history 为工具变更提供 checkpoint/undo 语义。compaction、session memory、team memory 与摘要服务使上下文和工作区状态可持续积累。SDK 类型文件还明确把 session mutations、fork 和 session message 查询作为一等接口。

### 5. Environment、remote 与扩展

cwd、additional working directories、worktree、sandbox violation、MCP、LSP、plugins、skills、hooks 和 remote bridge 共同形成执行环境。RemoteSessionManager/WebSocket/permission bridge 允许本地界面订阅远端 session，并把远端权限请求映射成本地可呈现的消息。这里的 environment 已经超出“进程当前目录”，接近 workspace + execution policy + remote control 的组合。

## 可确认的架构演进方向

由于仓库只有三个公开 commit，无法从其历史证明“从诞生到当前”的时间线。仅根据当前快照可确认的成熟方向是：

1. 从单一 REPL 循环扩展为可供 CLI、SDK、remote bridge 和 connector 使用的 Query runtime。
2. 从单次工具调用扩展为 QueryEngine/turn/queryLoop/Task 的多层生命周期模型。
3. 从工具白名单扩展为 permission rules、MCP 动态连接、skills、hooks、agents 和 teams 的能力平面。
4. 从一次性 cwd 执行扩展为 additional directories、sandbox、worktree、远端 session 和可回退 file history。
5. 从聊天记录扩展为 JSONL session graph、fork/resume、compact boundary、memory 和长任务后台状态。

## 与其它 coding agent 研究的连接点

这份快照与 Codex/Cline/Kimi 的共同核心是：持久 conversation、turn 内 tool loop、审批/取消、上下文压缩和 environment boundary。它更突出的差异是 Task supervisor 与 session graph：并发子 agent、teammate、后台任务和远程订阅被纳入 harness 原语，而不是作为 CLI 外部脚本。

## 未确认事项

- 该仓库不是 Anthropic 官方仓库，来源与完整性无法由本研究验证。
- 没有官方版本号和连续 commit 历史，不能据此断言具体演进事件或发布日期。
- 未运行其 Bun/TypeScript runtime；session resume、remote permission、sandbox 和 task kill 的实际时序仍未验证。
- SDK 文件中部分函数是类型/占位实现，不能把所有 SDK 类型声明都当作已实现行为。

## Runtime 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| conversation history | QueryEngine/session storage | 跨 turn，可 JSONL 重建 |
| current query loop | queryLoop state | 单个 user turn |
| tool execution | ToolUseContext/task supervisor | 单次 tool 或后台 task |
| permission context | permission context/canUseTool | session、turn、workspace 组合 |
| workspace mutation | file history/checkpoint/worktree | 执行期间及 rewind |

Claude Code 的 session 不是单一对象：QueryEngine 保存消息和 usage，Task 保存后台工作，permission context 保存授权，file history 保存文件变更，JSONL 将它们关联成可恢复链。

## Query loop 的收敛条件

一个 query loop 可能因模型完成、工具结果继续、max turns、预算耗尽、context compaction、max output recovery、abort、stop hook、permission denial 或异常结束。可恢复 provider/output 错误留在 loop 内；missing tool result 生成 synthetic result；max output error 在确认无法恢复前不会过早暴露给下游 host；非控制异常记录 traceback 后重新抛出。

核心原则是下游宿主不能把中间恢复状态误认为最终失败，模型也不能看到缺少对应 tool result 的非法 history。

## Task supervisor 的设计含义

Task type 覆盖 local bash、local/remote agent、in-process teammate、workflow、MCP monitor 和 dream。每个 task 有 ID、status、abort controller、output file 和 offset。输出文件与 offset 使长任务可以被主 session 增量读取，而不必一次性把所有输出放入 prompt。

Task supervisor 将并发 agent 与主 query loop 解耦，但引入 parent-child cancellation、terminal status、orphan cleanup 和跨 session recovery 的复杂度。

## Permission 与 Environment 的交叉

additional working directories 同时改变权限范围和执行环境；mode、always allow/deny/ask、prePlanMode 和后台 prompt 行为决定同一个 tool 在不同 session/turn 中的执行方式。增加目录不是只往 prompt 里写路径，还会影响文件工具、shell、permission rule 和 sandbox 判断。

## 历史证据的边界

当前第三方仓库只有三个公开 commit，不能支持正式的版本时间线。但 QueryEngine 注释区分 conversation 与 turn，query loop 注释维护 thinking、tool result、compaction recovery，Task 类型覆盖多种后台执行，SDK 类型提供 session create/resume/list/fork/rename/tag。这些可以支持设计结果判断，不能支持某功能首次出现的官方发布日期判断。

## 用户操作与状态转换

| 用户操作 | Runtime 变化 | 恢复要求 |
| --- | --- | --- |
| 新 prompt | 新 turn，复用 QueryEngine | 保留 conversation history |
| Ctrl-C | abort query/tool/task | 补齐 tool result 或标记中断 |
| 拒绝 tool | denial + observation | 保留 denial reason |
| 增加目录 | permission/environment 更新 | session/fork 一致 |
| compact | message projection 重建 | 保留 durable transcript |
| undo | file history rewind | 与 conversation 选择协调 |
| fork | 新 session identity | 复制 transcript，重建 file semantics |
| 远程订阅 | attach event stream | event id/reconnect |
| 后台 task | supervisor 新状态 | parent/child cleanup |

## 研究验证计划

应验证多次 submitMessage 是否真正跨 turn 保留 QueryEngine state；approval 等待时输入与 abort 的顺序；compaction 是否只改变 API projection；task output offset 是否可恢复；fork 是否复制 transcript 但不复制 file undo history；MCP 动态 tools 是否改变 request cache；remote permission bridge 是否能在断线后完成同一 tool call。

## 设计原则

这份第三方源码快照呈现出的 Claude Code harness 设计，不应被理解为官方历史结论；以下是对当前代码结构的原则性提炼。

### 原则 1：QueryEngine 是 conversation runtime

一个 QueryEngine 对应一个 conversation；每次 submitMessage 开始新的 user turn，状态跨 turn 保存。这样连续输入、初始消息、权限拒绝、usage、file cache 和已发现 skills 可以继续存在，而不会重新创建 agent。

### 原则 2：一次 turn 内部仍有独立 query loop

submitMessage 与 queryLoop 分离。queryLoop 在一次 user turn 内多次请求模型，处理 tool use、observation、compaction、max output recovery、stop hook、budget 和 continuation。用户的 turn 不是一次 API call。

### 原则 3：消息是可变运行态，JSONL 是可重建事实

QueryEngine 内部维护 mutableMessages，但 session storage 以 JSONL 和 parent UUID 记录消息链。消息编辑、compact boundary、tool result、system init、rename、tag 和 fork 都可以成为 transcript record。运行态可以从记录重建，而不要求 UI 内存永远存在。

### 原则 4：工具调用是权限和环境的交叉点

ToolUseContext 同时携带 tools、MCP clients、agent definitions、abort controller、cwd、permission context、hooks、thinking config 和 file history。工具不是单一 function，而是模型能力、权限、workspace、hook 和执行器的交叉对象。

### 原则 5：动态能力通过 runtime refresh

refreshTools 可以在 MCP server 中途连接后返回最新 tools；plugins、skills、agents、MCP resources 和 model configuration 都可能改变可用能力。源码能确认工具集合可变，但具体 provider request cache 行为仍需实验。

### 原则 6：Task supervisor 承担并发与长任务

Task 类型覆盖 local shell、local/remote agent、in-process teammate、workflow、MCP monitor 和 dream。每个 task 有 status、abort、output file、offset、start/end time 和通知标记；主 query loop 不直接承担所有后台任务。

### 原则 7：权限状态需要可表达、可恢复

ToolPermissionContext 包含 mode、additional working directories、always allow/deny/ask rules、pre-plan mode 以及后台是否避免 prompt。权限不是简单的 yes/no，而是 session/workspace/tool context 的组合。

### 原则 8：文件变更应具备 rewind 能力

file history、checkpoint、undo、fork 和 session transcript 共同让 workspace mutation 成为可治理状态。chat rewind 与 file rewind 可以分离，说明“模型上下文正确”和“文件树正确”是两个需要协调的恢复目标。

### 原则 9：远程控制复用 session，而不是复制一个 agent

RemoteSessionManager、SessionsWebSocket 和 permission bridge 让本地界面订阅远端 CCR session，并将远端工具权限请求转换为本地 synthetic assistant/tool message。远端执行事实仍由远端 session 拥有，本地只负责控制和呈现。

### 原则 10：错误恢复优先于中间错误展示

queryLoop 对 max_output_tokens、context overflow、retry、compaction 和 missing tool results 有专门处理；某些中间错误会被 withheld，避免下游 host 看到 error 后提前终止，而实际恢复还在继续。

### 原则 11：思考、工具和摘要保持协议合法性

源码明确维护 thinking block 顺序、tool result 紧邻关系、tool output summary、compaction boundary 和 history snip。原因是 provider conversation protocol 对 message block 有比普通聊天更严格的合法性要求。

### 原则 12：多 agent 通过 parent-child lineage

Task type、AgentId、parent tool use、team memory、teammate 和 remote agent 将多 agent 运行组织成父子任务，而不是把所有输出平铺在主消息列表中。取消、输出、权限和 session 需要沿 lineage 管理。

## Runtime 控制流与不变量

一次普通 turn 的路径是：接收 prompt，构造 system/user context，加载 memory、plugins、skills、MCP 和 tools，进入 queryLoop，请求模型，解析 tool uses，检查 permission，执行 task/tool，写入 observation，必要时 compact/retry/continue，最后生成 result 并 flush transcript。

核心不变量包括：每个 tool use 必须有对应 result；thinking trajectory 不得被非法截断；tool approval 等待时用户输入不能丢失；取消必须补齐未完成 tool result；compaction 不得改变 session identity；远程 session 断线不能把本地展示态误判为任务失败；task terminal 后不得继续注入消息。

## 设计收益与代价

| 原则 | 收益 | 代价 |
| --- | --- | --- |
| QueryEngine per conversation | 持续多轮输入 | mutable state 较多 |
| query loop separate | 恢复和 compaction 可集中处理 | turn/iteration 边界复杂 |
| JSONL transcript | 可读、可 fork、可恢复 | 需要 parent chain 和迁移 |
| Task supervisor | 并发后台 agent | task cleanup 与 orphan 管理复杂 |
| permission context | 工具级安全与目录授权 | policy 状态组合多 |
| file rewind | coding 变更可回退 | 文件与 transcript 双一致性 |
| remote session | 跨机器控制 | 权限 bridge 与断线恢复复杂 |
| dynamic tools | MCP/skills 可扩展 | request schema/cache 变化难验证 |

## 用户体验与 Runtime 机制

| 用户动作 | Runtime 机制 |
| --- | --- |
| 连续输入 | QueryEngine 跨 turn state |
| 中断 | AbortController + missing tool result recovery |
| 工具审批 | permission context + canUseTool |
| 增加工作目录 | additionalWorkingDirectories |
| Plan/Act | prePlanMode 与 permission mode |
| /undo | file history / rewind |
| resume | JSONL parent chain |
| fork | transcript copy + new session identity |
| 后台 agent | Task supervisor |
| 远端控制 | SessionsWebSocket + permission bridge |
| MCP/skill 动态接入 | refreshTools + tool context |

## 研究定位

从 harness 角度，这份源码快照的突出设计是把 coding agent 从单一 query loop 提升为“conversation runtime + task supervisor + permission/workspace plane + remote session adapter”。它比 mini-SWE-agent 多出长期会话、动态能力、任务并发和远程控制；与 Codex/Cline/Gemini 的共同问题则是如何在工具、权限、上下文和取消同时变化时保持可恢复事实。

但由于该仓库不是官方版本，以上原则只能作为快照级架构观察。要形成可靠的 Claude Code 研究基线，还需要确认官方来源、构建产物与运行时版本，并将 SDK 占位类型与实际实现分开验证。

## Session、Turn、Step 与 Task 的精确区分

Claude Code 快照中最容易混淆的是 `turn`、`step` 和后台 `task`。它们并非同一条时间轴：

| 对象 | 解决的问题 | 默认生命周期 | 是否进入主 transcript |
| --- | --- | --- | --- |
| Session / conversation | 用户与 agent 的长期身份 | 可跨进程恢复 | 是，作为消息链与元数据 |
| Turn | 一次 `submitMessage` 触发的用户意图 | 从提交到终态 | 是，追加用户与结果 |
| Step / iteration | 一次模型请求及其工具观察 | turn 内部 | 通常以消息、tool result 或事件体现 |
| Task | 可并发、可后台化的执行单元 | 可超出 turn | 不应把全部输出直接平铺 |

一个 turn 可以启动多个 task；task 的输出由 task id、文件和 offset 管理，再由主 query loop 选择性地观察。反过来，一个 session 可以有多个 turn，但不能把后台 task 的生命周期简单等同于某个 turn 的生命周期：turn 可能已经返回，而 task 仍在运行；下一 turn 可能继续读取同一 task 的输出。

这带来一个重要的架构不变量：主 conversation 的终态与后台 task 的终态必须分开记录。否则用户看到“回答完成”时，系统可能错误地杀掉仍在执行的子任务；或者用户恢复 session 时，无法判断 task 是已完成、被取消、失联还是仅仅没有被当前 host 展示。

## 一次请求的抽象状态机

不依赖具体实现名称，可以把一次 Claude Code turn 表达为以下状态机：

```text
accepted
   ↓
context assembled
   ↓
model requested ── recoverable error ──→ retry / compact / continue
   ↓
no tool call ─────────────────────────→ completed
   ↓
tool call parsed
   ↓
permission decision ── deny ──────────→ observation → model requested
   │
   ├─ ask ────────────→ suspended ────→ decision → execute / observation
   │
   └─ allow ──────────→ executing
                              ↓
                       observation persisted
                              ↓
                         model requested

any active state ── abort ──→ cancelled / repaired transcript
any state ───────── fatal ──→ failed with durable diagnostic
```

其中 `suspended` 不是失败态，`retry/compact/continue` 也不是最终错误。对 coding agent 来说，用户体验上的“卡住”“失败”“完成”必须由 harness 根据状态机收敛，而不能仅依据某一次 API 返回或某个工具进程退出码判断。

## 可变状态与不可变事实

快照中的 mutable message buffer、permission context、tool registry、memory cache 和 task map 都是运行时投影；JSONL parent chain、已完成 tool result、session id、tool call id 和 file-history checkpoint 则更接近可重建事实。两者的关系不是“内存状态自动等于持久化状态”，而是：

1. 接受输入、工具调用、权限决定和工具结果时产生事实。
2. QueryEngine 根据事实构造 provider 所需的 message projection。
3. compaction、resume、fork 或 remote attach 时重新生成 projection。
4. projection 可以变化，但不应伪造已经发生过的执行事实。

这一区分对 fork 尤其重要。fork 可以复制 conversation 的逻辑前缀并产生新的 session identity，但不能假定新 session 自动拥有旧 session 的运行中进程、审批句柄或文件回退指针。那些资源必须显式继承、重新绑定，或被标记为不可继承。

## Environment-owned execution 的具体边界

在这份快照中，执行环境至少由以下五个维度组成：

- workspace：cwd、additional directories、worktree、文件历史和 checkpoint；
- process：shell、环境变量、超时、abort controller、后台进程；
- capability：内置工具、MCP、skills、plugins、agents、LSP；
- policy：permission mode、allow/deny/ask、Plan 状态、sandbox 与后台交互规则；
- control plane：本地 REPL、SDK、remote bridge、WebSocket 与 connector。

因此“切换 cwd”可能只是执行上下文切换，而“增加 additional working directory”同时改变 workspace 可见范围和 permission policy。远端 session 则还要增加一个控制平面问题：执行发生在哪里、授权由谁作出、断线后哪个实体拥有恢复权。

Claude Code 的设计倾向是让 task 使用显式的环境和权限上下文，而不是依赖 host 的隐式全局变量。这使 local/remote agent、teammate 和 MCP monitor 可以共享生命周期模型，但代价是每个 task 都需要明确 parent、abort、output、权限和清理责任。

## 能力平面、请求投影与缓存问题

从 harness 视角，工具生命周期可以拆成四个时刻：发现、注册、暴露、执行。MCP/skill/plugin 连接改变的是发现与注册；permission 和 mode 改变的是暴露与执行条件；provider request 则消费某一时刻的工具投影。

这意味着工具变化对模型上下文有三种可能影响：

1. 改变 tools schema，导致 provider 请求前缀发生变化；
2. 只改变本地 permission gate，模型可见 schema 不变；
3. 只追加工具结果或 task observation，影响后续上下文而不是工具注册本身。

快照能确认 `refreshTools()` 和 ToolUseContext 支持运行时能力变化，但不能确认 Anthropic API 层是否为 tools schema 独立缓存、缓存键如何计算，以及 compaction 后哪些工具描述被重发。因此本报告只提出 cache-sensitive boundary，不把“动态工具一定破坏 KV cache”写成事实。

## 这一快照真正显示的架构重心

如果暂时不讨论官方版本时间线，这份代码最有研究价值的不是某个工具实现，而是三个责任中心的形成：

1. `QueryEngine` 负责 conversation 级状态和 turn 调度；
2. `queryLoop` 负责模型协议、tool observation、压缩与错误收敛；
3. `Task`/permission/workspace/remote 层负责把执行从一次前台请求扩展为可治理的长期任务。

这是一种“前台对话、后台执行、持久化恢复”三者分离的 harness。它让 coding agent 具备产品应用所需的暂停、恢复、远程控制和多任务能力，但也意味着系统的正确性不再只由模型循环决定，而由消息协议、权限状态、进程生命周期、文件回退和远程连接共同决定。

## 完整生命周期：Session → Turn → Step → Tool → Task

为了避免把 Claude Code 的多个循环混为一谈，可以把一次长期任务拆成五个层次：

| 层次 | 主要所有者 | 语义 | 终止或恢复方式 |
| --- | --- | --- | --- |
| Session / conversation | session storage + QueryEngine | 用户与 agent 的长期身份、消息链和配置 | resume、fork、rename、tag |
| Turn | `submitMessage` / query loop invocation | 一次用户输入触发的连续推理 | completed、aborted、failed |
| Step / iteration | queryLoop | 一次模型请求及其结果处理 | tool continuation、retry、compact |
| Tool call | ToolUseContext + permission bridge | 一次具有 call id 的执行意图 | allow、deny、result、error、abort |
| Background task | Task supervisor | 可脱离前台 query 的长执行单元 | running、completed、killed、orphaned |

一次 turn 的核心路径可以压缩为：

```text
submitMessage
  → append user message
  → construct context and capability snapshot
  → request model
  → parse thinking / text / tool use
  → permission and hook checks
  → execute tool or spawn task
  → append observation / task result
  → compact, retry, continue, or finish
```

`Step` 的边界是模型请求，而不是单个工具。一个模型响应可能包含多个 tool use，一个 tool use 也可能启动长期 Task；因此不能用 tool count 推断 turn 数，也不能用 query loop iteration 推断用户消息数。Claude Code 的产品复杂度正来自这些时间轴的重叠。

## Prompt、Steer、Interrupt 与 Approval 的时序

Claude Code 的持续输入可以抽象为四种不同控制意图：

1. **新 prompt**：在当前 query 完成后启动新的 turn，复用 QueryEngine 的 conversation state；
2. **steer / follow-up**：在当前 loop 仍可继续时改变下一次模型请求的方向，属于当前 turn 的控制输入；
3. **question answer**：回答工具或 agent 发出的交互问题，补齐当前 tool/task 的等待状态；
4. **interrupt**：向 query、active tool、后台 task 或远程 bridge 发送取消信号。

它们不能都被实现成“往 messages 数组追加一条 user message”。审批尤其如此：审批请求有 tool call identity、permission context 和等待中的执行状态；用户决定需要回到原调用，而不是新建一个没有关联关系的普通 prompt。

可以用以下时序表达审批与中断的相互作用：

```text
model emits tool call
        ↓
permission pending ── user allow ──→ execute ──→ observation
        │                                 │
        ├─ user deny ──→ denial observation┘
        │
        └─ interrupt / session replace
                    → settle pending approval
                    → cancel or invalidate tool call
                    → close/repair query state
```

“settle pending approval”是关键语义：当用户编辑消息、替换 session 或关闭远程连接时，旧 approval 不能继续悬挂并在未来被误批准。快照能确认 permission context、abort controller 和 remote permission bridge 的存在；具体 queue 的公平性、steer 是否能打断 active model stream，则仍需运行时实验。

## Checkpoint、File History 与 Conversation Rewind

Claude Code 同时维护两种需要恢复的状态：

- **conversation state**：消息、tool result、thinking block、compact boundary、session parent chain；
- **workspace state**：文件修改、file history、worktree、checkpoint 和 undo 记录。

这两者不能假定天然原子一致。一次工具调用可能先修改文件，再因模型请求失败；一次 conversation rewind 可能只改变模型可见历史，不应该自动删除已经存在的文件；一次 `/undo` 可能需要同时回退文件和对应 task marker。因而恢复动作至少有三种语义：

| 恢复类型 | Conversation | Workspace | 风险 |
| --- | --- | --- | --- |
| history projection rewind | 改变 API 可见历史 | 不变 | 模型可能忘记已发生的文件变更 |
| file rewind | 不变或追加 rewind 事实 | 回退文件 | 旧消息可能描述已不存在的文件状态 |
| coordinated rewind | 一起回退/建立新边界 | 一起回退/建立新边界 | 需要双状态原子性 |

快照中的 file history、checkpoint、fork 和 JSONL session API 证明 Claude Code 把这两个状态都视为可治理对象，但不能仅凭前端/类型声明断言已经实现了 Codex 式的原子双回滚。专业结论应是：Claude Code 具备 conversation rewind 与 workspace rewind 的架构意图，原子性仍待验证。

## Shared Runtime 的状态机视角

从 harness 角度，Claude Code 的 shared runtime 可以被看作三个相互协作的状态机：

### Query 状态机

`idle → accepting → requesting → processing tool uses → continuing → completed`。compaction、retry、max-output recovery 和 stop hook 是内部转移；abort、fatal error 和 limit 是终态路径。

### Tool 状态机

`discovered → selected → permission pending → executing → observed → terminal`。MCP refresh、permission change、session replacement 可以使一个 discovered tool 失效；因此 tool registry 的存在不能保证某个 call 仍然可执行。

### Task 状态机

`created → running → output available → completed/failed/killed`。task output file 与 offset 提供增量读取，但 task 可能晚于发起它的 query 结束；parent-child lineage 和 abort propagation 决定它是否继续存在。

三者通过 session id、turn/query id、tool call id、task id 和 parent id 关联。任何只维护其中一个状态机的 host 都可能产生错误展示，例如 query 已完成但 task 仍运行，或 permission 已失效但 UI 仍显示批准按钮。

## Connector、Hub、Remote Session 的进程边界

Claude Code 的 host 形态至少包含本地 CLI/REPL、SDK 调用、远程 session bridge 和后台 task。研究时应区分：

```text
foreground host
  └─ QueryEngine / local presentation
       ├─ local tool process
       ├─ Task supervisor / background output
       └─ remote session bridge
             └─ remote Query/Task/Environment
```

本地 host 的退出不必然等于 session 终止；WebSocket 断开不必然等于远程 task 失败；task output 文件可以成为 host 重连后的观察接口。另一方面，permission decision 可能由本地用户产生，却必须作用于远程执行位置，因此 approval bridge 需要携带足够的 session/tool identity 和环境摘要。

这也是 Claude Code 与简单 CLI agent 的分水岭：进程边界成为 runtime contract 的一部分。必须明确谁拥有模型 stream、谁拥有 shell、谁拥有 workspace、谁拥有 session transcript，以及谁拥有取消权。当前快照显示这些责任已经被不同 service/type 分开，但其跨进程恢复协议没有完整公开历史可供确认。

## 失败、恢复与终态收敛

Claude Code 的失败路径不应只按异常类型分类，还应按是否破坏 conversation protocol 和是否产生外部副作用分类：

| 失败类型 | 是否可能继续 loop | 需要收敛的对象 |
| --- | --- | --- |
| provider retryable error | 是 | request state、usage、retry budget |
| context overflow | 是 | message projection、compact boundary |
| malformed tool response | 是 | tool result pairing、assistant message |
| permission denial | 是 | denial observation、pending call |
| tool process failure | 通常是 | process、observation、task status |
| user abort | 否/可新 turn | stream、tool、task、approval |
| session replacement | 旧 loop 否 | old query、pending approval、remote binding |
| fatal invariant violation | 否 | durable diagnostic、未完成调用标记 |

终态收敛至少要满足四个不变量：

1. 未完成的 tool use 不能在 transcript 中永远没有对应 result 或 cancellation marker；
2. 已取消的 query 不能继续向模型发送隐式 continuation；
3. 已失效 session 的 approval 不能批准新 session 的 tool call；
4. host 的展示态可以落后，但恢复时必须以 durable transcript 和 runtime status 重新建立。

源码对 missing tool result、max output recovery、context compaction 和 abort 有明确处理，支持上述状态机解释；但任务进程、文件修改和远程 session 的跨进程原子性仍不能由这份泄漏快照证明。

## 第三方泄漏快照的结论等级

本报告现在可以更清晰地分成三种结论：

### 可以作为源码架构事实的内容

- `QueryEngine` 跨 turn 保存 conversation 状态；
- `queryLoop` 处理模型、工具、压缩、重试和终止；
- permission context、additional working directories、file history、Task supervisor 和 remote bridge 存在；
- session transcript 支持 parent chain、resume/fork 类操作；
- 工具能力可通过 MCP/skills/plugins 等运行时来源变化。

### 可以作为快照级设计解释的内容

- Claude Code 采用前台 conversation、后台 task、持久化 transcript 三者分离；
- permission 与 environment 是同一个 tool execution boundary 的两个侧面；
- QueryEngine、queryLoop、Task supervisor 构成不同时间尺度的 runtime。

### 不能声称的内容

- 某个正式 Claude Code 版本首次引入某能力；
- 当前公开快照代表 Anthropic 官方发布版本的完整代码；
- 未检查的远程服务、构建产物或 SDK 类型已经在生产运行；
- provider cache、checkpoint 原子性和跨进程恢复已经达到 Codex/Cline 同等保证。

因此，Claude Code 适合被纳入“产品化 coding-agent harness 的架构样本”，但不能被纳入严格的官方版本演进时间线。任何历史结论都必须改写为“该快照已经呈现出的架构形态”，而不是“Claude Code 在某版本完成了某次迁移”。
