---
title: Tool Invocation 的生命周期：从模型意图到 Runtime 动作
series: Coding Agent 的 Tool Invocation：从能力声明到外部副作用
part: 1
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Tool Invocation 的生命周期：从模型意图到 Runtime 动作

## 结论

模型输出一个 Tool Call，只表示它提出了一个动作意图。它还没有证明工具存在、参数有效、目标 Environment 正确、权限已经批准、动作已经开始，甚至没有证明调用一定会被执行。

一个成熟的 Tool Runtime 至少要经过以下阶段：

```text
advertise
   ↓
select
   ↓
parse / validate
   ↓
resolve environment
   ↓
authorize / approve
   ↓
preflight
   ↓
execute
   ↓
observe / commit
   ↓
settle / recover
```

这条链不是形式上的分层，而是决定 Coding Agent 是否可靠的核心状态机。任何阶段被省略，都会把一个不同的问题伪装成“工具调用失败”：工具不存在、参数错误、权限拒绝、Environment 失效、进程超时、结果部分提交和外部副作用未知，其恢复策略完全不同。

本文比较 Codex `rust-v0.154.0`、Pi `v0.85.1`、Gemini CLI `v0.59.0`、OpenCode `v2.0.0`、OpenHands `v1.15.0`、Kimi Code `v0.40.0` 和 mini-SWE-agent 当前研究版本，聚焦一次 Tool Invocation 如何穿过 Runtime，而不是比较工具数量。

## 1. Tool Call 不是函数调用

普通程序中的函数调用通常假定：函数地址已知，参数类型由编译器约束，调用者拥有执行权，返回值只与函数本身相关。模型工具调用缺少这些前提：

- 工具名来自不完全可靠的模型输出；
- 参数是需要运行时解析的 JSON 或结构化对象；
- 工具定义可能随 Session、Model、Environment 和 Policy 变化；
- 工具执行可能需要用户审批；
- 工具可能启动进程、访问网络或修改文件；
- 返回值可能只是外部世界的部分观察。

因此更准确的抽象是：

```text
(tool_call, step_context, environment, policy)
        -> prepared_action | rejection

(prepared_action)
        -> observation + effect_status + lifecycle_events
```

`prepared_action` 是经过解析、绑定和授权的动作，不应与原始模型 JSON 混为一谈。它应携带稳定的 call ID、具体工具实现、解析后的参数、Environment 引用、取消信号和授权结果。

## 2. 八个生命周期阶段

### 2.1 Advertise：向模型声明能力

Runtime 将工具名、描述和 schema 放入模型请求。此时只建立“模型可以提出什么请求”的边界，不建立执行授权。工具可能因为模型、Session、Environment 或 Policy 被过滤。

### 2.2 Select：模型选择工具

模型返回工具名和参数。模型选择受到 schema、描述和历史影响，但 Runtime 不能把选择视为许可。工具名别名、旧版本名称和 provider-specific 格式都可能需要规范化。

### 2.3 Parse / Validate：解析与参数校验

Runtime 解析 JSON、填充兼容字段、验证 schema 和工具特有约束。解析失败通常不应启动副作用；有些系统会把错误作为 tool result 送回模型，让模型修正参数。

### 2.4 Resolve：解析 Environment 资源

参数中的相对路径、仓库、远程任务或进程 ID 必须绑定到当前 Environment。解析阶段应确定目标资源和执行器，不能只依赖模型提供的字符串。

### 2.5 Authorize / Approve：授权与审批

Policy 判断动作是否允许；若需要用户审批，调用进入等待状态。用户批准的是当前 call 在当前 Environment 中的动作，不应自动扩大所有后续调用的权限，除非产品明确赋予更大作用域。

### 2.6 Preflight：执行前检查

执行器再次确认取消状态、策略、资源存在性、进程能力和工具版本。对于会产生副作用的动作，preflight 是最后一个不产生外部 effect 的边界。

### 2.7 Execute：执行动作

工具可以是内存函数、本地 shell、PTY、容器、MCP、远程 API 或子 Agent。执行期间可能产生增量输出、部分副作用和新的控制事件；取消通常是合作式的，不能保证任意外部动作立即停止。

### 2.8 Observe / Commit / Settle：记录、观察与结算

Runtime 将输出、错误、退出状态、外部句柄和 effect 状态投影给模型、UI 和持久化层。只有在生命周期达到明确终态后，调用才算 settle。一个 Tool Call 的 promise 结束，不一定等于远程资源或后台进程已经结束。

## 3. Pi：prepare 与 execute 的清晰分界

Pi v0.85.1 的 `agent-loop.ts` 对工具调用提供了较清楚的两阶段结构。`prepareToolCall` 从当前 Context 查找工具、规范化参数、执行 `validateToolArguments`，调用 `beforeToolCall` hook，并在进入执行前检查取消信号；如果 hook 返回 block，调用不会进入工具实现。[^pi-prepare]

`executePreparedToolCall` 接收已经准备好的工具调用，向工具传入 call ID、参数、signal 和 update callback；它处理增量更新、成功结果、异常以及 update listener 的生命周期。[^pi-execute]

这条边界很重要：

```text
raw model tool call --prepare--> prepared tool call --execute--> result
```

工具对象、参数校验和审批 hook 位于 effect 之前；工具实现及其 signal/update 协议位于 effect 期间。Pi 的结构允许应用在 `beforeToolCall` 中加入审批或资源检查，但也意味着应用必须正确实现这些 hook，底层 Agent 本身并不提供完整的 Workspace policy。

Pi 还分别发布 `tool_execution_start` 和 `tool_execution_end`，并维护 pending tool calls。事件可以服务 UI 和诊断，但不能仅凭 start 事件断言外部动作已完成。

## 4. Codex：ToolRouter、MCP 与审批归属

Codex `rust-v0.154.0` 在 Step Context 中绑定 `ToolRouter`、MCP binding、Environment snapshot 和 capability roots，使模型请求看到的工具计划与实际执行路由具有同一个 Step 归属。[^codex-step]

工具执行上下文还包含 Turn、call ID、runtime tool call ID、Environment 和权限信息。Codex 对 shell、MCP、网络和 apply patch 等能力分别处理审批和执行策略；网络 approval service 会根据 call 的 owner、Turn 和触发 cwd 关联等待中的审批。[^codex-approval]

这体现了产品级 Runtime 的一个特征：审批不是一个 UI 回调，而是一个带 call/Turn/Environment 归属的挂起状态。若用户在等待期间取消 Turn，审批 waiter、pending input、工具结果和 Turn 终态必须共同收敛，不能让“队列被清空”被误判为“用户拒绝”。

Codex 还保留 executed tool call metadata，用于在上下文受限时维持调用关联和必要的参数摘要。工具输出、调用事实和模型可见文本因而分成不同层次。[^codex-recorder]

## 5. Gemini CLI：SDK 层的完整 agentic loop

Gemini CLI v0.59.0 的 SDK Session 将 send stream 描述为完整 agentic loop：发送用户 prompt、流式接收模型响应、执行模型请求的工具调用，并持续到模型产生没有工具调用的最终响应。[^gemini-session]

实现中会收集模型返回的 tool call request，绑定当前 SessionContext，再调度工具执行；没有待执行工具时结束本次 stream。SessionContext 提供 session ID、transcript、cwd、timestamp、filesystem、shell 和 parent session 等信息，说明工具执行并非脱离 Session 的普通函数。[^gemini-types]

Gemini 的 shell SDK 在执行命令前通过 ShellTool 检查 policy；如果需要确认但当前没有交互 Session，会直接返回不能执行，而不是假设用户批准。[^gemini-shell]

这条路径把 headless SDK 的权限语义明确化：同一个工具，在交互 CLI 中可以等待审批，在无交互 Session 中则应失败或由调用方预先配置。Tool Runtime 的可用性因此依赖控制平面，而不只依赖 tool schema。

## 6. OpenCode：工具注册、权限和副作用顺序分离

OpenCode v2 的工具文档明确规定：工具注册表不负责执行授权；工具叶节点负责资源解析、权限和副作用顺序，Permission assert 的拒绝以类型化错误向上层传播。[^opencode-tools]

这形成了三层责任：

| 层 | 责任 |
| --- | --- |
| Registry | 定义工具、名称、schema 和可见性过滤 |
| Permission | 判断当前动作是否获准 |
| Leaf tool | 解析资源并执行实际副作用 |

Session Model Request 负责把工具调用接入模型循环和错误投影；工具叶节点不能通过宽泛 catch 把用户拒绝吞掉，否则模型会看到一个普通失败而失去审批语义。这个设计把权限拒绝、工具失败和 Runtime interruption 保持为不同错误类别。

OpenCode 的 SessionExecution 又在更高层管理 active execution、interrupt、settlement 和 idle。工具调用的终态需要同时满足工具层结果和 Session execution 的生命周期，不应只看工具 promise。

## 7. Kimi Code：工具策略、审批和重复调用检测

Kimi Code v0.40.0 的 v2 Runtime 将 tool policy、permission gate 和 tool dedupe 分开。Tool policy 决定工具是否 active；permission gate 评估具体 tool call，并可等待用户 approval；tool dedupe 依据 call ID、工具名和参数检测同一 Step 或跨 Step 的重复调用。[^kimi-policy] [^kimi-permission] [^kimi-dedupe]

这几个服务解决不同问题：

- policy：模型是否可以看到/选择工具；
- permission gate：当前选择是否可以执行；
- dedupe：调用是否可能是重复意图，是否应提醒或停止。

尤其是 dedupe，它不是幂等执行保证。检测到模型重复请求只能减少明显的循环，不能证明第一次调用没有外部副作用，也不能安全决定所有 retry 都应取消。

Kimi 的任务持久化状态还包括 `awaiting_approval`，说明审批等待是任务生命周期的一种持久状态，而不是只存在于 UI 内存。[^kimi-task]

## 8. OpenHands：Action 与 Observation 的事件化边界

OpenHands v1.15.0 的 agent-server 事件模型将 Agent 发出的 ActionEvent 与 Environment 返回的 ObservationEvent 分开；终端、浏览器、文件编辑和 Canvas UI 有不同的 action/observation 结构。[^openhands-events]

这种设计将一次调用的事实链表达为：

```text
agent action -> agent-server dispatch -> environment execution -> observation
```

Observation 中可以携带命令、路径、输出、错误和 action ID；前端据此刷新 workspace file changes 或展示执行结果。[^openhands-observation]

Action/Observation 分离的收益是可观测性和多消费者投影；代价是必须处理 action 已发出但 observation 尚未到达、前端断线以及 agent-server 重启等情况。没有 action ID 和 conversation/environment identity，迟到 observation 可能被错误地归入新的调用。

## 9. mini-SWE-agent：最小 action/observation 闭环

mini-SWE-agent 将 Agent loop 简化为模型输出 action、Environment 执行 action、返回 observation，再把结果交给下一次模型请求。Environment 协议接收 action 和 cwd，后端可以是 Local、Docker、Singularity 或远程执行器。[^mini-environment]

这个闭环非常适合作为最小基线，但它没有自动提供企业级 Tool Runtime 的所有阶段。参数解析、审批、dedupe、后台句柄、持久 intent 和恢复策略通常由外层配置或具体 Environment 后端承担。

它的优势是责任清晰：Agent 不假装拥有执行环境，Environment 不假装理解模型意图。代价是若使用 LocalEnvironment，action 之间的新 subshell 不会自动继承目录和环境变量状态；若需要持续 shell、权限审批或跨进程恢复，必须扩展协议。[^mini-local]

## 10. 工具错误与 Runtime 终态

工具调用不应只有 success/error 两个结果。至少需要区分：

| 终态 | 语义 |
| --- | --- |
| rejected | 未获得权限或策略不允许，未开始 effect |
| invalid | 参数或工具请求格式无效，通常未开始 effect |
| interrupted | Runtime 请求停止，外部 effect 可能未知 |
| timeout | 执行器超时，动作是否生效需看工具协议 |
| failed | 执行器观察到明确失败 |
| partial | 已产生部分输出或部分 effect |
| succeeded | 结果满足工具定义的成功条件 |
| unknown | 无法确认外部 effect 状态 |

将所有非零退出码都写成 failed，会让恢复器错误重试 timeout 或 partial 动作；将用户拒绝写成工具错误，则会破坏下一次模型请求对授权的理解。

## 11. 并行工具调用的边界

模型可能在一次响应中发出多个 Tool Call。Runtime 需要决定：

- 参数是否顺序校验；
- 审批是否逐个进行；
- 工具是否并行执行；
- 结果是否按完成顺序或调用顺序进入 Context；
- 一个调用失败是否取消其他调用；
- 共享 Workspace 是否允许并发写入。

Pi 的 loop 将工具准备和执行区分开，支持 sequential/parallel 两种模式；并行执行可以等待所有 promise，但不能保证外部动作按调用顺序完成。[^pi-loop]

这也是 Tool Runtime 不能只看模型响应数组的原因。数组顺序是请求语义，完成顺序是 Environment 事实，二者必须同时记录。

## 12. Tool Call 的状态机不应隐藏在异常里

异常是表达失败的手段，但不应成为唯一的生命周期协议。Runtime 需要可以观察：

```text
created → prepared → awaiting_approval → running
       → streaming → completed / failed / interrupted / unknown
```

Kimi 的 `awaiting_approval` 持久状态、OpenHands 的 Action/Observation 事件、Pi 的 tool start/end 事件以及 Codex 的 approval request 都说明，调用阶段需要可观察。[^kimi-task] [^openhands-events]

可观察状态对用户界面、恢复器和测试都重要：用户需要知道动作是在排队、等待批准还是已经运行；恢复器需要知道是否可以重试；测试需要确认拒绝没有启动副作用。

## 13. 可复现验证设计

不需要 API key，可以用脚本化模型和受控工具验证完整生命周期：

1. 返回不存在的工具名，确认 Runtime 不执行任意 fallback；
2. 返回非法参数，确认校验失败发生在 effect 之前；
3. 在审批 hook 中暂停，验证取消后不进入工具实现；
4. 让工具产生增量输出后超时，检查 partial 和 timeout 语义；
5. 同时发出两个工具调用，记录准备、开始、结束和结果进入 Context 的顺序；
6. 在工具完成后延迟提交 observation，确认迟到结果不能覆盖终态；
7. 模拟 Environment 句柄失效，区分 resource unavailable 与 tool failure。

实验应记录 call ID、Turn/Step ID、Environment ID、policy version、工具版本和事件时间线。只看最终模型回答，无法确认 Runtime 是否在正确阶段执行了动作。

## 14. 设计原则

### 原则一：原始意图与准备动作分离

模型 JSON 是不可信输入；只有完成解析、资源绑定和授权后的 prepared action 才能进入执行器。

### 原则二：声明、授权和执行分层

模型可见工具、策略允许工具和实际执行能力不是同一集合。每一层都需要有明确拒绝语义。

### 原则三：副作用前必须存在可观察边界

Runtime 应能区分尚未执行、已开始、部分完成和结果未知。没有这个边界，恢复和审计都只能猜测。

### 原则四：Tool Result 是状态投影

返回给模型的文本只是 canonical execution record 的一个投影，不能承担完整审计和恢复责任。

### 原则五：事件身份贯穿全生命周期

call ID、Turn/Step ID、Environment ID 和 parent/child identity 应贯穿请求、审批、工具、结果和恢复。

## 15. 结论

Tool Invocation 是 Coding Agent Runtime 的执行主干。它把模型意图转换成受控动作，再把外部世界的部分结果投影回 Context。这个转换过程包含参数校验、Environment 解析、策略授权、审批、执行、流式观察、持久化和终态收敛；任何一步都可能改变后续恢复语义。

Pi 展示了轻量 Agent 中清晰的 prepare/execute 边界；Codex 将 ToolRouter、MCP、审批和 Turn 归属整合为产品级控制面；Gemini CLI 将 SessionContext、policy 和工具 loop 结合；OpenCode 分离 Registry、Permission 和工具叶节点；Kimi Code 将 tool policy、permission gate、dedupe 和持久任务状态拆开；OpenHands 通过 Action/Observation 事件连接 Agent 与 agent-server；mini-SWE-agent 则提供最小 action/observation 基线。

后续研究需要进一步回答：审批如何成为策略化能力平面，流式和并行工具如何收敛，外部副作用何时可以安全重试。那将决定一个 Tool Runtime 是“能够调用工具”，还是“能够可靠地管理动作”。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Gemini CLI | `v0.59.0` | `fb0d535af931b27c51e87e5e6ade72905b1e8390` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| Kimi Code | `v0.40.0` | `e27ee60894d714e5844db75da69f29120a2bce43` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文完成源码和相关测试阅读，未运行真实 provider、审批 UI、远程工具或跨进程恢复实验。

[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-loop]: [Pi sequential and parallel tool loop](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L430-L565)
[^codex-step]: [Codex StepContext tool and environment binding](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-approval]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^codex-recorder]: [Codex executed tool call retention](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^gemini-session]: [Gemini CLI SDK agentic session loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^openhands-events]: [OpenHands Action and Observation events](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^openhands-observation]: [OpenHands observation structures](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/base/observation.ts#L55-L140)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
