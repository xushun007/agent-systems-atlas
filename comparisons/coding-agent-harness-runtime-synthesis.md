# 主流 Coding Agent Harness / Runtime 全面总结与比较

## 研究范围

本文基于 Atlas 中 13 个 coding agent / agent runtime 的固定版本研究，提炼它们从模型循环走向产品级 Harness 的共同规律与结构差异：

- [Codex](../projects/codex/research/codex-harness-evolution.md)：`rust-v0.154.0`；
- [Pi](../projects/pi/research/pi-harness-evolution.md)：`v0.85.1`；
- [Gemini CLI](../projects/gemini-cli/research/gemini-cli-harness-evolution.md)：`v0.59.0`；
- [OpenCode](../projects/opencode/research/opencode-harness-evolution.md)：`v2.0.0`，参考 `v1.0.0`；
- [OpenHands](../projects/openhands/research/openhands-harness-evolution.md)：Canvas 与 `software-agent-sdk@v1.15.0`；
- [Cline](../projects/cline/research/cline-cli-harness-evolution.md)：monorepo main，CLI `3.0.49`；
- [Claude Code](../projects/claude-code/research/claude-code-harness-evolution.md)：第三方泄漏快照；
- [Hermes Agent](../projects/hermes-agent/research/hermes-harness-evolution.md)：`v2026.8.31` / `v0.21.0`；
- [Kimi Code](../projects/kimi-code/research/kimi-code-harness-evolution.md)：`v0.40.0`；
- [Google ADK Python](../projects/adk-python/research/adk-python-harness-evolution.md)：`v2.8.0`；
- [Navi Agent](../projects/navi-agent/research/navi-agent-v0.1-harness.md)：`v0.1.0`；
- [mini-SWE-agent](../projects/mini-swe-agent/research/mini-swe-agent-harness-evolution.md)：`v2.4.5` 之后的维护版本。
- [DeepSeek Harness](../projects/deepseek-harness/research/deepseek-harness-evolution.md)：`dsh-v0.1.5-rc.2`。

这不是简单的功能清单或产品排名。比较对象是 Runtime/Harness：模型请求周围负责输入接纳、上下文构造、工具能力、权限、执行环境、持久化、恢复、宿主连接和终态收敛的系统。

Claude Code 必须单独注明：其分析基于第三方公开的泄漏源码快照，没有官方连续版本历史。因此本文可以使用它观察产品化 runtime 形态，但不把它纳入严格的官方版本演进证据。Navi Agent 也只代表 `v0.1.0` 快照，不据此推断项目整体未来架构。

## 一、总论：Coding Agent 的核心已经不是模型循环

### 1. 最小闭环

任何 coding agent 都可以从下面的最小闭环开始：

```text
user task
  → messages/context
  → model request
  → action/tool call
  → environment execution
  → observation/tool result
  → next model request or terminal result
```

mini-SWE-agent 将这个闭环几乎原样暴露为 `Agent + Model + Environment`。它证明：完成 SWE-bench 类任务并不要求 Session service、事件总线、复杂工具注册表或多客户端协议。

### 2. 产品级 Harness 的增量

当系统加入持续输入、权限审批、文件回退、远程执行、后台任务和多入口之后，最小闭环必须被多个状态机包围：

```text
                 ┌── Context / prompt projection
                 ├── Capability / tool registry
                 ├── Policy / approval / security
                 ├── Environment / workspace / process
                 ├── Persistence / event / recovery
                 └── Host / transport / UI
user input ──────→ admission ─→ turn/step loop ─→ effects
                      ↑              ↓             ↓
                 queue/steer      events       workspace state
                      └────── recovery / replay ───┘
```

因此，真正的架构问题不再是“模型能不能调用工具”，而是：

> 当输入、工具、权限、上下文、环境和宿主都在变化时，系统能否保持同一个任务身份、可解释的执行事实和可收敛的终态？

这也是 Codex、Pi、Gemini CLI、OpenCode、Cline 和 OpenHands 相比 mini-SWE-agent 增加大量 runtime 机制的根本原因。

## 二、七个共同的 Runtime 平面

### 平面 1：Input / Admission

用户输入不一定立即成为模型请求。成熟 runtime 会区分新 prompt、当前 turn 的 steer、下一 turn 的 queue、审批响应、question answer、compact、shell completion 和 interrupt。

代表性实现：

- Codex：Submission、Steer、Turn admission；
- Cline：Prompt Queue、pending prompt、ask interaction；
- OpenCode：SessionInbox、delivery、SessionExecution wake；
- Kimi：StepRequest、active/current/next turn、quiescence；
- Gemini：prompt id、hook continuation、next-speaker 与 turn sequence；
- Pi：Lane、steering、Drive/Operation；
- Navi：ApplicationService、PendingInteraction，但仍是 v0.1 的早期实现。

mini-SWE-agent 刻意不建立这个平面：交互输入通过异常或消息追加回到同一个 run。ADK 则把外部输入主要建模为 Invocation/resume input，而不是 coding-agent 专用的 steer/queue 语义。

### 平面 2：Model / Context Projection

模型看到的输入通常已经不是原始 transcript，而是一个派生 projection：system instruction、项目规则、memory、tool schema、历史、压缩摘要、masking、IDE context 和当前 user request 的组合。

不同项目选择不同的 projection owner：

- Codex：Turn/Step context 与 rollout/history；
- Pi：AgentSession、session tree、compaction 和 extension/tool context；
- Gemini：AgentChatHistory + ContextManager + graph/working buffer；
- Kimi：ContextMemory + Wire/Replay；
- OpenCode：Session history + Inbox + CodeMode catalog；
- ADK：InvocationContext、LLM flow、Toolset、Workflow event projection；
- mini：messages 直接是主要 live state。

共同规律是：长期事实和当前请求投影正在分离。差异在于投影是否是一等对象、是否有 stable identity、是否可跨进程恢复，以及压缩是否只是摘要还是带 lineage 的 context graph。

### 平面 3：Capability / Tool

工具至少有四个不同生命周期：

```text
discover → register → expose to model → execute effect
```

工具注册表只回答“系统知道哪些工具”；model-visible tools 回答“本次请求向模型暴露什么”；policy/approval 回答“当前调用是否允许”；executor 回答“副作用在哪里产生”。

从静态到动态的主要路径是：

- mini-SWE-agent：配置决定 Model/Environment，默认单一 bash action；
- Hermes：registry、toolset、MCP、plugin 和 check function 动态组合；
- Cline：shared core、MCP、skills、tool policy 和 host override；
- Gemini：ToolRegistry、active tools、scheduler、MCP、subagent tool；
- Kimi：常驻工具、announcement、select_tools、dynamic schema 和 ToolExecutor；
- OpenCode：MCP、plugin generations、CodeMode catalog 和 namespace；
- OpenHands：SDK tool registry、skills、plugins、ACP 与 backend capability；
- ADK：Toolset、Plugin、Model capability、Auth 与 CodeExecutor request processor。

工具“动态注入 prompt”不是准确的统一描述。某些变化修改 tools schema，某些修改 system/instruction context，某些只改变本地 policy gate，某些只追加 tool result。只有请求录制才能确认对特定 provider KV cache 的实际影响。

### 平面 4：Policy / Approval / Security

审批从全局布尔开关逐步变为工具、参数、模式、workspace、用户和环境共同决定的 policy：

```text
tool request
  → capability lookup
  → argument/schema validation
  → risk/policy evaluation
  → auto-allow / deny / ask
  → execute or return observation
```

产品型 runtime 的关键变化是：approval 不再只是 UI modal，而是带有 session/turn/tool identity 的挂起状态。批准或拒绝必须回到原始调用；session replacement、interrupt、host disconnect 时必须使旧 approval 收敛或失效。

主要差异：

- Codex、Gemini、Kimi、Cline、OpenHands 都在不同程度上将 approval 放入 runtime protocol；
- Claude Code 将 permission context 与 additional directories、mode、MCP、Task 和 remote bridge 结合；
- Hermes 主要通过 tool check、callback、profile 和 backend 组合，统一 policy kernel 较弱；
- Navi 已拆出 Policy/Approval/Executor，但 v0.1 尚未完成 sandbox 统一；
- mini 只有 InteractiveAgent 的 human/confirm/yolo，属于 run 级交互控制，不是持久 policy plane；
- ADK 的确认、认证和插件回调服务于 invocation/workflow，不天然等同于 coding workspace 的命令安全。

### 平面 5：Environment / Workspace

`cwd` 是所有项目最容易被低估的概念。完整 Environment 至少包括：

- workspace/repository/worktree identity；
- 文件系统可见范围与敏感路径；
- shell/process/container/PTY；
- 网络、MCP、browser、LSP 和外部服务；
- credentials/secrets；
- trust、sandbox、approval policy；
- checkpoint、artifact 和恢复方式；
- 运行该环境的进程或远程 host。

不同项目处于不同成熟度：

| 类型 | 代表 | Environment 形态 |
| --- | --- | --- |
| 执行器 | mini-SWE-agent | `Environment` 是 subprocess/container backend，外部文件树承载主要状态 |
| Session 组合 | Hermes、Navi | cwd、task、backend、policy、callback 组合而成，未完全收敛为不可变对象 |
| Location/Workspace | OpenCode、Kimi | location/Scope/workspace 与 session/agent 绑定，开始成为可寻址资源 |
| Sandbox-owned | Codex、Gemini | Environment 与 trust、sandbox、approval、tool capability 联合治理 |
| Conversation-owned | OpenHands | ConversationState 直接绑定 workspace、policy、agent、event log |
| Application executor | ADK | CodeExecutor/Artifact/Auth/Toolset 组合执行后端，不等于长期 repo workspace |

### 平面 6：Persistence / Recovery

持久化也有层次差异：

1. transcript：模型可见的消息历史；
2. execution facts：tool call、approval、usage、error、interrupt；
3. derived state：当前 status、queue、context projection、scheduler state；
4. external effects：文件、进程、容器、browser、远程服务。

mini 主要保存 trajectory；Hermes 保存 SessionDB message rows、usage、lineage 和压缩信息；Claude Code 使用 JSONL parent chain、file history 与 Task 状态；Cline、Gemini、Kimi、OpenCode、OpenHands、ADK 进一步将 event、state、checkpoint、replay 或 projection 变为 runtime 组件；Pi 则将 session tree、operation、lane/worker 状态推向 durable harness。

核心判断是：

> 保存对话不等于保存执行；保存执行事实也不等于能够恢复外部副作用。

只有当 transcript、execution identity、environment state 和 recovery protocol 同时闭合时，系统才具备真正的任务恢复能力。

### 平面 7：Host / Transport

成熟 Agent 都在从单一 CLI 走向多 host：TUI、CLI、SDK、IDE、ACP、Web、Gateway、Desktop、Cron、daemon、remote session 和 automation。

不同项目的中心边界不同：

- Codex：Core Session + app-server/daemon 多宿主；
- Pi：通用 Agent Core/Harness + Runtime Host；
- Gemini：`packages/core` 被 CLI、IDE、SDK、A2A 等宿主复用；
- OpenCode：Server/Protocol/Effect Runtime 取代 TUI 成为中心；
- OpenHands：Canvas control plane 与 SDK/Agent Server execution plane 分仓库；
- Cline：shared agent core 被 IDE、CLI、connector、hub、SDK 消费；
- Hermes：中心 `AIAgent` 被 Gateway、ACP、Cron、Desktop/Bot 扩展；
- ADK：App/Runner 被 API、Live、A2A、Workflow 和插件消费。

mini 保持单次 run，Navi v0.1 已有 Application/Gateway 边界但尚未形成多进程平台。

## 三、Session、Turn、Step 的统一比较

### 1. Session 的五种含义

不同项目虽然都使用 Session 一词，但实际上有五种不同语义：

| 语义 | 典型项目 | 说明 |
| --- | --- | --- |
| 对话容器 | mini、早期 OpenCode | 保存 messages/trajectory，执行边界较粗 |
| 长期任务身份 | Codex、Cline、Gemini、Claude Code | 绑定输入、配置、工具、恢复和 workspace |
| Runtime scope | Kimi、Navi、ADK | Session 是服务、依赖和状态的生命周期边界 |
| Conversation control plane | OpenHands | 连接 backend、workspace、event、pause/resume 和 UI |
| Durable procedure tree | Pi | session tree 与 operation/lane 共同表达可恢复过程 |

因此比较时不能问“有没有 Session”，而要问：Session 是否拥有执行？是否拥有 workspace？是否拥有 approval？是否拥有 durable event？是否能在进程退出后重新接管 active work？

### 2. Turn 的三种边界

- **用户意图边界**：一次 prompt 到完成/中断，如 Codex、Cline、Hermes、Claude Code；
- **Invocation 边界**：一次 Runner 调用或恢复调用，如 ADK、Navi；
- **执行批次边界**：一次模型请求及工具结果，如 mini 的 step、部分 OpenHands Agent step。

产品 runtime 通常需要同时保留三种边界：用户需要看到 turn，调度器需要看到 invocation，模型协议需要看到 request/step。只保留一种边界会导致连续输入、审批或恢复语义模糊。

### 3. Step 的成熟度阶梯

```text
模型请求计数
  → model + tool iteration
  → tool lifecycle state
  → physical attempt
  → immutable/replayable execution snapshot
```

mini 的 Step 是一次 query/action/observation；Hermes 的 Step 主要是内存 iteration；OpenHands SDK 的 `Agent.step()` 是模型请求到 action batch 的执行粒度；Gemini 的 scheduler 已有细粒度 tool state，但 context projection 与 durable history 分开；OpenCode、Kimi、Codex、Pi 进一步让 Step 或 operation 承载 admission、attempt、environment、policy 和 recovery 信息。

这不是“Step 越细越先进”。细粒度 Step 带来更好的取消、重试、审计和恢复，但也要求处理 partial result、重复 effect、attempt identity、并发和持久化成本。

## 四、完整 Agent 生命周期的横向模型

### 阶段 1：Admission

用户输入进入 Session/Conversation/Application 的入口。成熟实现会先决定：是否接受、属于哪个 session、进入当前 turn 还是下一 turn、是否需要等待前一个 execution、是否应该 steer 或 interrupt。

Codex、Cline、Kimi、OpenCode 在此处的演进最明显；mini 没有 admission 层；Hermes 通过中心 Agent/callback 处理；OpenHands 由 Agent Server conversation API 处理；ADK 由 Runner/Invocation 处理。

### 阶段 2：Context 与 Capability Snapshot

系统加载 system prompt、项目规则、memory、history、工具 schema、环境摘要、权限模式和 provider 配置。此时最理想的设计是生成一个可追踪的 request/step snapshot，至少能回答模型看到了什么、工具有哪些、环境在哪里、策略是什么。

Gemini 的 ContextManager、Kimi 的 ContextMemory、OpenCode 的 Session/CodeMode、Codex 的 Step context 和 Pi 的 durable procedure 已接近这一方向。Hermes、Navi、mini 更依赖内存态或组合配置；ADK 通过 InvocationContext/LLM flow 派生 request，但不以 coding workspace 为中心。

### 阶段 3：Model Request

模型请求不只是 messages，还包括 tools、response schema、model capability、cache policy、thinking/reasoning options 和 provider-specific metadata。模型切换、工具变化、context compaction 和 dynamic instruction 都可能改变 request identity。

其中稳定 prompt 前缀和动态能力后缀的分离，是 Gemini、Hermes、ADK、Kimi、OpenCode 等项目共同面对的 cache-sensitive 问题。源代码可以确认 request projection 的变化，不能单独证明 provider 侧 KV cache 的命中率。

### 阶段 4：Tool Policy 与 Effect Execution

模型产生 action 后，runtime 应先完成 schema validation、policy evaluation、approval、hook 和 environment preparation，再执行副作用。成熟系统还要记录 action identity、attempt、process、output 和 result。

批处理与逐调用调度是重要差异：mini 默认顺序执行 action batch；OpenHands SDK 有并行工具执行器；Gemini 有 scheduler/state manager、queue、active calls、tail call 和 sandbox expansion；OpenCode 有 tool fibers；Codex、Cline、Kimi 也把 tool lifecycle 与 policy/approval 分离到更高层。

### 阶段 5：Observation 与 Continuation

工具结果必须回到正确的 turn/step/tool call，并决定继续、重试、压缩、等待、转移或结束。常见错误包括：缺少 tool result、重复执行、旧 approval 回写、新 session 继续旧 query、context projection 覆盖新事实。

Gemini、OpenCode、Kimi、Claude Code 和 OpenHands 都明确处理协议合法性与 action/result correlation；mini 用 messages/exception 维持简单闭环；Hermes 通过 message rows/finalizer 收敛；ADK 通过 Event、function response、branch/node identity 恢复 workflow。

### 阶段 6：Terminal Settlement

一个好的 terminal result 至少说明：成功、失败、取消、超时、限额、等待人工、上下文无法恢复，还是宿主断开。终态应同时更新执行状态、持久事实、外部资源和用户投影。

Codex、Gemini、OpenCode、Cline、OpenHands 在这方面最产品化；Hermes 由 finalizer 集中处理；Navi 已有 Run record 与 terminal event；ADK 以 invocation/workflow event 表达；mini 把 exit message 写入 trajectory。

## 五、架构演进的共同阶段

### 阶段 A：Single Loop

特征是 CLI 直接创建 Agent，模型返回工具调用，执行器返回 observation，退出后保存日志。mini-SWE-agent 是最清晰的当前控制组；早期 OpenCode、早期 Hermes、ADK 的早期 Agent/Runner 也接近这一形态。

### 阶段 B：Session 化

系统开始保存 conversation、workspace、usage、file history、model/provider 和恢复信息。OpenCode v1、Hermes、Claude Code、Cline 和 Gemini 在不同阶段完成这一转变。

### 阶段 C：策略化工具与可恢复执行

工具 registry 不再等于可执行工具，approval、sandbox、MCP、skills、hooks 和 model capability 进入 request/execution path；取消、压缩、checkpoint、resume 和 rollback 成为核心 runtime 问题。

Codex、Gemini、Kimi、Cline、OpenCode、OpenHands 和 ADK 在这一阶段投入最多；Navi v0.1 已建立基础边界。

### 阶段 D：多宿主与后台化

Session 不再绑定前台终端，Server、SDK、ACP、IDE、Gateway、Cron、Desktop、remote session 和 daemon 开始共享或适配同一个任务。

OpenHands 与 OpenCode 的 backend/server 化最彻底；Codex 和 Cline 也将宿主进程与 Session runtime 分开；Hermes 通过 Gateway/Cron/Bot platform 扩展；Pi 通过 Harness/Drive/Lane 形成通用 durable execution；ADK 通过 App/Workflow/Live/A2A 扩展 application runtime。

### 阶段 E：Procedure / Graph / Platform Runtime

最成熟的系统开始处理：并发执行、子 Agent、任务树、事件 replay、环境迁移、插件 generation、dynamic tools、context graph、后台 worker、跨进程 recovery 和 policy governance。

这时 Agent Loop 只是 Runtime 的一个执行部件。Codex、Pi、Gemini、OpenCode、OpenHands 和 Kimi v2 代表不同方向；Hermes 仍保留中心 AIAgent；ADK 以 Workflow graph 为中心；Cline/Claude Code 的产品化形态则更多围绕 task/session/host 组合。

## 六、13 个系统的架构定位

### Codex：一致性优先的 Coding Execution Runtime

Codex 的核心是 Session/Turn/Step/Submission 与 Environment/Policy/Rollout 的组合。它最重视：

- 任务身份和 turn 边界；
- Step 级请求与执行一致性；
- Environment、Sandbox、Approval、Guardian 的安全收敛；
- rollout 事实日志、resume、fork、rollback；
- app-server、daemon、多 Agent 和远程宿主。

它的产品能力不是附加在一个 CLI 上，而是把 coding execution 的状态、权限和环境纳入核心控制器。代价是状态模型和协议复杂，迁移与运维成本高。

### Pi：通用 Durable Harness 与 Procedure Runtime

Pi 保持较低层、可扩展的 Agent Core，同时把 session tree、compaction、extension、Lane、Drive、Gate、Snapshot 和 durable Operation 引入 Harness。它的中心问题是：如何把一次 Agent 行为表达为可组合、可恢复、可由宿主编排的 procedure。

Pi 比 Codex 更强调通用抽象和扩展性，较少把安全产品策略固化进核心；比 mini 更接近 durable runtime；比 OpenCode 更少依赖产品 server，但在 operation/lane 方面形成独特的执行原语。

### Gemini CLI：Context 与 Tool State 双重显式化

Gemini CLI 的架构亮点是两个强 owner：AgentChatHistory/recording 拥有事实历史，ContextManager 拥有模型请求投影；Tool Scheduler/State Manager 拥有工具生命周期。

它在 context graph、异步 pipeline、stable IDs、compression、rollback、workspace trust、MCP filtering 和 subagent trajectory 上投入很深。其主要代价是多视图一致性：durable history、context buffer、API history、tool state 和 UI event 必须协调。

### OpenCode：产品 Server 与 Effect Runtime

OpenCode v2 把 TUI 之后的 Server/Protocol/Effect Core 变成真正 Runtime。SessionInbox、Execution claim、Runner/Step、Database/Store/Projection、Location/Instance、Plugin generation、MCP、CodeMode 和多客户端协议共同构成 backend-owned execution。

它的特征不是单纯 server 化，而是把输入 admission 和 durable execution 也纳入 Core。代价是 Effect service、数据库 schema、claim/recovery、plugin generation 和多客户端一致性都需要持续维护。

### OpenHands：双仓库的 Conversation/Event Runtime

OpenHands 将 Agent Canvas 控制面与 `software-agent-sdk`/Agent Server 执行面分开。ConversationState 绑定 Agent、Workspace、ConfirmationPolicy、EventLog、hooks 和 stats；Agent.step 产生 ActionEvent；Workspace 执行；ObservationEvent 回写；Agent Server 通过 REST/WebSocket 控制和同步。

它最突出的设计是 backend-owned conversation/runtime、action-observation 协议、local/remote workspace 和多 Agent/ACP 接入。代价是 frontend、SDK、Agent Server、Cloud/automation 的版本和恢复边界需要同时固定。

### Cline：Shared Core 与多 Host 产品任务

Cline 的重点是把 IDE 中的 coding task runtime 复用到 CLI、SDK、connector、hub 和其它 host。Prompt Queue、approval protocol、Plan/Act policy、checkpoint/undo、agentic compaction、connector session persistence 和 structured events 构成长期任务平台。

Cline 的主要复杂度不在单个 loop，而在持续输入、远程线程映射、pending approval、workspace rewind 和多宿主事件投影的协调。

### Claude Code：高度产品化的 Query/Task 快照

第三方快照呈现出 QueryEngine（conversation/turn）、queryLoop（model/tool iteration）、Task supervisor（后台与并发）、Permission/Environment、JSONL session、file history、MCP、remote bridge 和 SDK surface 的组合。

它的架构观察价值很高：前台 conversation、后台 task、持久化 transcript 三者分离；但由于缺乏官方历史，不能断言这些能力的正式版本时间线、生产实现或完整性。

### Hermes：围绕中心 AIAgent 的个人 Agent Platform

Hermes 保留中心化 AIAgent 和消息历史，把 provider、tool、context、SessionDB、Gateway、ACP、Cron、Subagent、Desktop/Bot 和多种 terminal backend 接到外围。

它的扩展面很宽，适合个人 Agent platform；但 Step、approval、Environment 和 task process 的 durable identity 相对弱，统一 policy kernel 和跨进程 recovery 不如 Codex/OpenCode 明确。

### Kimi Code：双引擎迁移中的 Scope/Wire Runtime

Kimi v2 以 App/Session/Agent Scope、StepRequest admission、Turn/Step Loop、PermissionGate、ContextMemory、Wire、EventDispatcher 和 Replay 重新组织 runtime；v0.40.0 仍保留 v1 legacy path。

它的最大架构价值是把生命周期 ownership、输入 admission、事实日志和模型 projection 显式分开；最大风险是双引擎语义漂移，以及迁移期间不同宿主可能进入不同 runtime contract。

### ADK Python：通用 Agent Application Orchestration

ADK 的核心是 App、Runner、SessionService、InvocationContext、Event、Workflow、Plugin、Toolset、Auth、Artifact 和 CodeExecutor。它从 Agent loop 演进为可恢复的 workflow graph runtime。

ADK 解决的是“应用中哪个节点在什么条件下运行、如何暂停和恢复图状态”，而不是单独解决长期 coding workspace 的文件、命令、sandbox、rollback 和进程治理。它是 coding harness 的重要基础，但不是 Codex 式 coding execution runtime。

### Navi Agent：早期但边界意识强的 Runtime 骨架

Navi v0.1 已把 ApplicationService、AgentRuntime、Session/Run、Iteration、ToolRegistry、Policy、Approval、Executor、RuntimeEvent、BackgroundTask 和 Evolution side plane 分开。

它的价值是从早期就明确状态所有权和在线/离线演进边界；但 v0.1 尚未证明 Step snapshot、跨进程 worker、sandbox、原子 checkpoint 和动态 capability/cache contract。

### mini-SWE-agent：最小充分控制组

mini-SWE-agent 只保留 Agent、Model、Environment、messages、limits、trajectory 和 submission。它没有 Session Store、持久 policy、独立 event bus、后台 supervisor、复杂 context graph 或多 host protocol。

它的价值不在功能少，而在提供因果清晰的控制组：其它系统每增加一层，都必须说明是在解决长上下文、持续输入、权限、恢复、并发、远程化还是产品运维问题。

### DeepSeek Harness：插件组合与事件事实双核心

DeepSeek Harness 以 Cordis 插件树组织整个 Runtime：profile/bundle/patch 决定进程级部署，preset/scope 决定单个 Agent 可见的 Prompt、工具和策略，`AgentRegistry`/`AgentLoop` 驱动执行。它没有把扩展限制在外围 Tool API，而是让模型、Session、Loop、审批和 Environment provider 都成为可替换服务。

其另一核心是 Session event log。Turn、Step、请求头、Assistant settlement 与工具结果构成可重建事实；模型请求从日志派生并冻结，实时 stream 只是观察事件。语义 checkpoint 在模型 dispatch 和顶层工具副作用前刷盘；崩溃后未知工具效果被显式标记，而不是自动重试。代价是插件装配、作用域、事件词汇、格式迁移和 projection 都成为 Runtime 正确性的一部分。

## 七、核心维度比较矩阵

| 系统 | 主要事实 | Step/执行粒度 | Environment owner | 恢复模型 | 主要扩展方式 |
| --- | --- | --- | --- | --- | --- |
| Codex | rollout/thread/session facts | Turn/Step/attempt | Core + sandbox/policy | rollout、resume、fork、rollback | app-server、MCP、多 Agent |
| Pi | session tree/operation | procedure/drive/lane | Harness/host | durable operation、session tree | extension、tool、worker |
| Gemini | AgentChatHistory + events | scheduler call + context render | sandbox/policy | session bundle、replay、rewind | MCP、subagent、plugins |
| OpenCode | DB events/projections/inbox | physical Step attempt | Location/Instance | claim、inbox、restart recovery | plugin generations、CodeMode |
| OpenHands | ConversationState + EventLog | Agent.step/action batch | Conversation workspace | event history、pause/resume | ACP、MCP、skills、plugins |
| Cline | task/session/events/checkpoint | RuntimeTurn/tool lifecycle | shared core + host/backend | session persistence、undo、hub | connectors、MCP、skills |
| Claude Code | JSONL/session/task/file history | query loop + task | permission/workspace/task | resume/fork/rewind（快照级） | MCP、skills、plugins、remote |
| Hermes | SessionDB message rows | iteration/tool round | session/task/backend | resume、lineage、compression | Gateway、Cron、ACP、MCP |
| Kimi | Wire/replay/state projection | StepRequest/Turn/Step | Scope/workspace services | Wire、Replay、checkpoint/undo | v2 services、MCP、plugins |
| ADK | Session events/state | Invocation/node/step | CodeExecutor/services | event replay、resumability | Workflow、plugins、A2A |
| Navi | Session/Run/Event records | iteration/tool call | runtime/backend composition | interaction/session recovery | services、gateway、evolution |
| mini | messages/trajectory | query/action batch | Environment backend | trajectory audit，非原生 resume | config/factory/backend |
| DeepSeek Harness | Session event log + projections | explicit Turn/Step/tool call | scoped FS/Shell/Subprocess/Sandbox providers | write handle、flush、repair、format migration | Cordis plugin、profile、preset、capability seam |

## 八、最重要的结构差异

### 1. 谁拥有任务身份

- Codex、Cline、Gemini、OpenCode、OpenHands：长期任务身份是产品事实；
- Kimi：Session/Agent Scope 与 Wire identity 共同拥有；
- Pi：session tree 与 durable procedure 共同拥有；
- Hermes：SessionDB 拥有长期消息身份，AIAgent 拥有 active execution；
- ADK：Session 拥有应用交互身份，Invocation/Workflow 拥有当前运行；
- Navi：Session 与 Run 已分离，但 v0.1 恢复边界较早；
- mini：一次 run/trajectory 近似全部任务身份。
- DeepSeek Harness：SessionId 同时标识持久 Session 与活跃 Agent；Registry 生命周期和 storage ownership 分离。

### 2. 谁拥有执行环境

- Codex/Gemini：环境与安全策略联合进入 core execution；
- OpenCode/Kimi：环境通过 Location/Scope/Workspace/Instance 服务寻址；
- OpenHands：ConversationState 直接绑定 Workspace，Agent Server 拥有执行 transport；
- Cline/Claude：环境由 workspace、permission、host、task、remote bridge 组合；
- Pi/Hermes/Navi：环境是可替换 backend 与 session/task context 的组合；
- ADK：CodeExecutor 是应用工具的执行后端，不天然拥有 repo workspace；
- mini：Environment 只拥有命令执行和隔离 backend。
- DeepSeek Harness：Environment 由作用域化 FS、Shell、Subprocess 与 Sandbox providers 组合；`cwd` 只是 Session 元数据。

### 3. 谁拥有模型上下文

- Gemini、Kimi、OpenCode、ADK：已有显式 context/request projection 层；
- Codex、Pi、OpenHands：有 context/session/condensation 机制，但具体投影 owner 不同；
- Cline、Claude、Hermes：通过 shared core/query engine/context engine 生成长期任务 prompt；
- Navi：已有 ContextEngine，但 Step snapshot 尚不完整；
- mini：messages 接近直接事实和请求输入。

### 4. 谁拥有工具状态

- Gemini、Kimi、OpenCode：有较完整的 queue/active/completed/attempt 状态；
- Codex、Cline、OpenHands：工具与 approval/environment 有明确关联；
- Claude：ToolUseContext 与 Task/permission 分层，但快照级；
- Hermes、Navi：已拆 capability/policy/executor，持久化和统一调度较弱；
- ADK：工具状态嵌入 Event/Invocation/Workflow；
- mini：action batch 处理，工具状态最小化。

## 九、恢复能力的真正分层

### Level 0：重新运行

只有任务输入和配置，失败后从头开始。早期单体 CLI、最简单的 Agent demo 属于此类。

### Level 1：对话恢复

能重新加载 messages/session，并让模型继续对话。Hermes、Claude Code、早期 OpenCode 和部分 mini 上层 runner 接近此层。

### Level 2：执行事实恢复

能恢复 tool call/result、approval、usage、failure、invocation 或 run identity。Gemini、Kimi、OpenHands、ADK、Navi 和 Cline 已显式处理其中大部分。

### Level 3：运行调度恢复

能恢复 queue、active execution、pending interaction、claim、workflow node、background task 或 daemon-owned session。OpenCode、Codex、Pi、Gemini、Cline 和 OpenHands 的 runtime 方向已达到或接近此层；Hermes/Navi 仍有分散机制。

### Level 4：外部副作用恢复

能恢复或回滚文件树、workspace、process、container、browser、remote environment，并保证与对话事实一致。这是最难的一层，任何项目都不能仅凭 transcript 或 event store 自动获得。

Codex 的 Environment/Rollout、Gemini 的 rewind/sandbox、OpenCode 的 workspace/claim、OpenHands 的 conversation workspace、Cline 的 checkpoint/undo 都在尝试处理 Level 4 的部分问题，但具体原子性仍需 runtime experiment 验证。

## 十、架构选择的收益与代价

| 选择 | 受益 | 代价 |
| --- | --- | --- |
| 直接 loop | 可读、低延迟、易评测 | 无持续任务治理 |
| Session first | resume、历史、用户身份 | 状态迁移与并发复杂 |
| Event first | 审计、replay、多 host | sequence、幂等、存储成本 |
| Step snapshot | 精确取消、重试、恢复 | attempt/effect 一致性难 |
| Context projection | 压缩、缓存、动态能力 | 事实与模型输入分叉 |
| Policy overlay | 工具级安全、模式切换 | capability/policy 组合爆炸 |
| Workspace ownership | 文件和任务可治理 | 环境迁移、隔离和回滚复杂 |
| Server-owned execution | client 断线不影响任务 | 认证、lease、重连、运维复杂 |
| Workflow graph | 并发、条件、子 Agent | branch、join、replay divergence |
| Plugin/runtime extension | 生态与能力扩展 | generation、版本和安全边界 |

没有一种架构对所有 Agent 最优。mini 选择把复杂度留在外部，适合 benchmark；Codex 选择把一致性收进 core，适合产品应用；Pi 选择提供通用 durable primitives；OpenCode 选择 server/effect platform；OpenHands 选择 conversation/backend 双仓库；ADK 选择 application graph；Hermes 选择中心 Agent platform；Kimi 选择 Scope/Wire 双引擎迁移。

## 十一、设计原则的共同核心

跨项目最稳定的共同原则有十条：

1. **模型循环不是完整 Runtime**：输入、工具、环境、持久化和宿主都需要独立边界。
2. **用户意图与模型请求不是同一层**：一个 prompt 可以包含多个 model/tool iteration。
3. **工具存在不等于工具可执行**：能力、暴露、策略、审批和执行必须分开。
4. **环境不等于 cwd**：真正环境包含 workspace、process、credentials、trust、sandbox 和 host。
5. **流式展示不等于 durable fact**：delta 可以丢失或合并，最终事件/记录必须可重建。
6. **恢复必须区分对话与副作用**：resume transcript 不代表恢复 shell、文件、容器或浏览器。
7. **审批必须有调用身份**：approval response 要回到原始 tool call，不能只是新 prompt。
8. **取消必须级联**：LLM stream、tool、process、child task、hook、queue 和 remote bridge 都要收敛。
9. **动态能力需要冻结点**：每个 session、turn、request 或 tool execution 的 capability snapshot 必须明确。
10. **产品定位决定状态复杂度**：benchmark harness、个人 Agent、coding product、远程平台和通用 application runtime 的核心取舍不同。

## 十二、不同系统的根本差异不是功能数量

### 1. 一致性中心不同

- Codex：Environment/Step/Policy consistency；
- Gemini：Context/Tool/History consistency；
- OpenCode：Session admission/Execution/Database consistency；
- OpenHands：Conversation/Event/Backend consistency；
- Pi：Durable procedure/operation consistency；
- Cline：Task/host/approval/checkpoint consistency；
- Kimi：Scope/Wire/Replay consistency；
- ADK：Workflow/event/resume consistency；
- Hermes：Agent identity/platform extension consistency；
- mini：run/trajectory reproducibility；
- Navi：runtime boundary/evidence evolution consistency；
- Claude Code：conversation/task/permission/workspace consistency（快照级观察）。

### 2. 复杂度进入系统的时间不同

mini 在初始化配置时解决复杂度；Hermes 在工具、宿主和 Session 周边解决；ADK 在 App/Workflow/Event 层解决；Codex/Gemini/Kimi/OpenCode 在 core execution 中解决；OpenHands 在仓库和服务边界中解决；Cline/Claude 在 shared task runtime 与多 host 中解决。

### 3. 对“正确”的定义不同

- benchmark agent：任务是否完成、轨迹是否可评估；
- coding product：文件、权限、会话和用户意图是否一致；
- remote platform：断线、重启、租约和多客户端是否一致；
- application runtime：工作流节点、事件、状态和外部调用是否可恢复；
- extensible harness：外部扩展是否不破坏核心 loop 和状态边界。

## 十三、对核心问题的集中回答

### Session、Turn、Step 如何关联

最稳妥的统一模型是：

```text
Session = 长期身份与恢复范围
Turn = 一次用户意图/Invocation 的工作单元
Step = 一次模型请求及其工具推进
Tool Call = Step 内可审批、可执行、可观察的副作用意图
```

但各项目的 owner 不同：Codex/Kimi/OpenCode 已将这些边界推入 core；Gemini/Cline/Claude 通过 client/query/task/scheduler 组合；OpenHands/ADK 将 loop 留在 backend/workflow；Hermes/Navi 的 Step 更偏内存态；mini 则有意压缩为 run/step。

### 哪些不可变，哪些可变

应将已发生的 user message、model response、tool call/result、approval decision、error、cancel 和 terminal reason 视为追加事实；active queue、current policy、model selection、context projection、tool registry、UI state 和 process handles 是可变运行态。

高质量 runtime 不会通过静默修改历史解决新状态，而是追加 steer、rewind、compact、cancel 或 migration operation，再生成新的 projection。

### Environment 如何定义

Environment 是某个 Session/Turn/Step 在特定时间可访问的 workspace、process、capability、policy、credential、network 和 host 的组合。cwd 只是 workspace seed；如果没有 trust、sandbox、process、rollback 和 identity，不能称为完整的 Environment-owned execution。

### 动态工具是否影响 KV cache

可能，但不能一概而论：

- 改变 tools schema 或 system/developer instructions，可能改变请求前缀；
- 只改变本地 policy gate，可能不改变模型请求；
- 只追加 tool result，影响后续上下文长度但不等于工具注册导致 cache 失效；
- provider 的 tools cache key、prefix cache 和 KV cache 行为必须通过请求录制验证。

因此优秀的 capability plane 会把常驻工具、动态工具、announcement/catalog、policy 和 execution registry 分开，并明确何时冻结 request snapshot。Gemini、Kimi、OpenCode、ADK 已在不同程度上处理这个问题；mini 没有承诺动态会话，反而边界最简单。

## 十四、研究结论：主流 Coding Agent 的共性

主流 coding agent 已经形成相对稳定的共同骨架：

```text
长期任务身份
  + 输入 admission
  + 模型/上下文 projection
  + 动态工具能力
  + 权限与审批
  + Environment-owned execution
  + durable facts / events
  + cancellation / recovery
  + 多宿主 protocol
```

差异不在于是否拥有这些词，而在于它们是否真正进入同一个一致性边界：

- mini 把它们大多留在 loop 外部；
- Hermes 把它们围绕中心 Agent 组合；
- ADK 把它们围绕应用 Workflow 组合；
- Navi 试图从一开始显式拆分；
- Cline、Claude、OpenHands 把产品任务和多 host 加入核心；
- Gemini、Kimi、OpenCode、Codex、Pi 则进一步把状态、恢复和执行协调提升为一等 Runtime 原语。

## 十五、研究结论：产品能力与技术抽象的分野

直觉上 Codex 更具产品应用能力，Pi 更偏技术抽象和扩展，这个判断基本成立，但需要精确化：

- Codex 把产品所需的权限、环境、持续任务、恢复、宿主和多 Agent 一致性尽量内收进 Runtime，因此使用者得到更完整的产品语义；
- Pi 把 durable execution、session tree、lane、drive、extension 和 procedure 抽象出来，允许宿主按自己的产品需求组合，因此通用性更强但产品意见更少；
- OpenCode 位于两者之间偏产品平台一侧：通过 Server、Database、Protocol 和 Effect Runtime 提供多客户端产品基础，同时保留强扩展面；
- Gemini CLI 以 context、tool lifecycle 和 session recovery 为中心，产品与技术边界交织得很深；
- Kimi v2 试图用 Scope/Wire/Replay 把产品 runtime 重新工程化，但 v0.40 仍处迁移期；
- Cline、OpenHands、Claude Code 通过多 host、远程任务、连接器和后台任务体现产品化；
- Hermes 选择更宽的个人 Agent platform，coding 是其中一个重要 profile；
- ADK 是通用应用编排基础，不应被误判为完整 coding execution product；
- mini 是研究和评测控制组，刻意不承担产品 runtime 复杂度。
- DeepSeek Harness 把插件组合与事件溯源同时提升为核心机制，技术抽象很强；其产品可靠性取决于 profile/preset 组合与事件迁移能否持续保持一致。

## 十六、最终判断

### 判断一：Coding Agent 的下一阶段竞争是 Harness 竞争

模型能力仍重要，但 coding agent 的实际产品差异越来越由 harness 决定：谁能让任务在长时间、多工具、多权限、多环境、多宿主和异常恢复中保持一致，谁就更接近可靠的 coding product。

### 判断二：状态所有权是最核心的设计问题

Session、Turn、Step、Tool、Environment、Event、Projection 和 Host 如果没有明确 owner，系统就会在连续输入、审批、中断、重启和远程连接中出现隐性竞态。Codex、Kimi、OpenCode、Gemini、OpenHands 和 Pi 的重大演进，本质都是状态 ownership 的显式化。

### 判断三：Environment-owned execution 是产品化分水岭

从 cwd 到 workspace/runtime/sandbox/remote environment 的变化，标志着 coding agent 从“帮用户运行命令”走向“管理一个工程任务执行域”。但只有环境 identity、权限、进程、文件变更、checkpoint 和恢复协议闭合，Environment 才真正成为一等对象。

### 判断四：Context management 已从压缩升级为请求投影系统

成熟 Agent 不再简单截断 history，而是在 durable facts 上构造当前 API projection，处理 token budget、cache stability、tool schema、memory、summary、masking、branch 和恢复。Gemini 的 ContextManager、Kimi 的 ContextMemory、OpenCode 的 CodeMode、ADK 的 LLM flow 和 Pi 的 session/operation 都体现了这一趋势。

### 判断五：动态能力平面会成为下一轮架构分化点

MCP、skills、plugins、subagents、CodeMode、ACP 和 model capabilities 使工具集合不断变化。未来真正需要比较的是：能力在哪个边界冻结，policy 如何参与，context/cache 如何稳定，旧 Step 如何保持事实不变，以及扩展失败是否会击穿主 Runtime。

### 判断六：恢复的最高难度不是重放消息，而是治理副作用

事件 replay 可以重建状态，不能自动恢复已经产生的文件、进程、容器、浏览器和远程服务副作用。下一阶段研究应重点验证 coordinated rewind、process adoption、workspace checkpoint、approval expiration 和 duplicate effect，而不是只检查 `/resume` 是否能显示旧消息。

## 十七、证据边界与后续专题

本文是基于各项目固定版本源码、测试、commit history 和官方文档的综合解释，不等同于对所有项目做过端到端 runtime experiment。以下结论仍需实验验证：

- provider tools/schema 变化对真实 KV cache 的影响；
- 进程崩溃后的 active tool、workspace 和 task 恢复；
- checkpoint 是否覆盖 conversation 与 filesystem 的原子双状态；
- 远程 session 断线后的 approval、event replay 和 cancellation；
- 多 Agent parent-child 任务的资源和权限级联；
- dynamic capability 变化的 request snapshot 与 cache invalidation。

后续适合拆成机制级专题，而不是继续扩张总报告：

1. Session/Turn/Step 的一致性模型；
2. Prompt Queue、steer、interrupt 与 approval；
3. Context projection、compaction 与 prompt cache；
4. Environment-owned execution 与 workspace rollback；
5. Tool capability、MCP、plugin generation 与 policy；
6. Event sourcing、replay、checkpoint 与 crash recovery；
7. Subagent、background task 与 parent-child cancellation；
8. 多宿主 Server/SDK/ACP/IDE 的进程和协议边界。

这些专题应继续引用各项目的固定版本报告，而不是复制本总结中的概念。
