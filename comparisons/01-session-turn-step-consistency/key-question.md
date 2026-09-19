---
title: Coding Agent 的 Session / Turn / Step：关键问题
topic: session-turn-step-consistency
reviewed_at: 2026-09-18
status: active
document_type: key-questions
---

# Coding Agent 的 Session / Turn / Step：关键问题

本专题只讨论四个问题。每个问题先给出结论，再比较经典实现。重点不是统计每个 Agent 是否有同名类，而是判断它是否解决了相同的 Runtime 语义。

## Q1：Session 是什么？

### A：Session 不是对话容器，而是持续执行主题

Session 的最小含义不是一组消息，而是：

~~~text
持续的用户/任务身份
+ 对话与运行状态
+ 执行环境引用
+ 能力与权限条件
+ 可恢复的执行关系
~~~

因此，Session 应能够回答当前工作属于谁、使用哪个 Workspace/Environment、当前是否有活动执行、已经产生哪些状态和副作用，以及进程或 Worker 消失后如何继续。

### 经典设计一：Session 作为产品级执行根

OpenCode v2 将 Session 与 Workspace、SessionExecution、数据库、Bus 和执行 claim 组合起来；Session 不只是消息存储，还需要处理 active execution、resume 和 Worker ownership。[^opencode-session] [^opencode-execution]

OpenHands 则把 Agent Server、Sandbox、Workspace 和 Session context 放在跨服务执行链中。Session 的实际边界由远程 Runtime 和资源身份共同决定。[^openhands-context]

这类设计适合持续协作和服务化执行，代价是必须管理 claim、租约、恢复和远程资源。

### 经典设计二：Session 作为轻量 Agent Host

Pi 的 AgentSession 在通用 Agent Loop 之上管理 cwd、模型、工具、输入、steering、扩展事件、压缩和会话持久化。它仍然是执行主题，但很多 Sandbox、远程资源和长期副作用责任由宿主应用承担。[^pi-session] [^pi-storage]

这类设计灵活、易嵌入，但产品必须自行补充 Environment 和恢复治理。

### 判断

只保存 transcript 的对象不是完整 Session。只要恢复需要重新确认 Environment、执行 claim、后台任务或外部 Operation，Session 就已经是 Runtime 的执行根。

## Q2：Turn 和 Step 为什么需要分开？

### A：Turn 负责用户意图，Step 负责执行一致性

两者不是简单的层级编号：

~~~text
Turn：围绕一次用户意图的连续处理
Step：一次使用固定 Context、Policy、Capability、Environment 的执行单元
~~~

一个 Turn 可以包含多个 Step；一个 Step 通常对应一次模型请求及其 Tool 处理，但也可以是一次可恢复的执行尝试。

### 经典设计一：显式 Step 边界

Codex 将 StepContext 放入执行路径，并把 Permission、Network approval 和 Environment 条件绑定到 Step。[^codex-step] [^codex-permissions] [^codex-network]

这种设计的优势是模型看到的条件和工具执行条件可以绑定，权限和网络批准可以在执行前重新检查，中断、恢复和终态可以落到明确的执行单元。代价是 Runtime 需要维护更多快照和状态。

### 经典设计二：Session Runner 中的隐式 Step

OpenCode 的 SessionRunner/step execution 将模型请求、Context overflow、retry、interrupt、Tool Result 和 settlement 组织在执行循环中。即使 Step 不是用户主要看到的对象，它仍然是内部一致性边界。[^opencode-step]

这种设计保留了产品层的 Session/Turn 体验，同时在 Runtime 内部引入 Step 级控制。

### 经典设计三：Loop iteration 作为隐式 Step

Pi 的 Agent Loop 通过 preparation、execution、Tool Result 和下一次模型请求形成迭代边界。[^pi-prepare] [^pi-execute]

它的 Step 语义更轻：应用可以将一次 iteration 视为 Step，也可以把多个 iteration 归入一次 Turn。灵活性更高，但快照和恢复责任不由通用 Loop 自动完成。

### 判断

没有显式 Step 类并不代表没有 Step。只要 Runtime 在某个边界上同时确定了 Context、Tool、Policy、Environment 和 Model Request，就已经存在 Step 语义。

## Q3：用户输入、审批和模型变化何时生效？

### A：控制输入可以立即被接纳，但不应修改已经发出的请求

最稳妥的边界是：

~~~text
接纳控制输入
  → 更新 Session/Turn 状态
  → 等待或取消当前 Step
  → 从下一个 Model Request / Step 生效
~~~

这里需要区分：

- User input：通常开启新的 Turn，或排队到下一个可接纳边界；
- Approval：授权某个 Tool Call 或 Capability，不是修改历史请求；
- Interrupt：请求停止，不等于执行已停止；
- Model change：通常从下一个请求边界生效；
- Environment change：必须让旧 Step 失效或重新验证。

### 经典设计：执行前重新授权

Codex 的 Permission profile 和 Network approval 位于执行条件中，而不是只写入模型提示。这样用户批准的是具体执行能力，Runtime 仍可在 Step 激活和 Tool 执行时重新判断。[^codex-permissions] [^codex-network]

### 经典设计：输入排队和 steering

Pi 的 AgentSession 管理 steering/follow-up 输入，并把它们接入 Agent Loop，而不是让外部输入直接改写已经发出的 Provider 请求。[^pi-session]

### 经典设计：持久化输入和状态投影

Kimi Code v2 将事件、状态投影、Wire/Journal 和 Context 视图分层；输入和状态变化先进入 Runtime 状态，再由 Context 视图影响后续模型请求。[^kimi-wire] [^kimi-context]

### 判断

关键不在于“输入属于 Session、Turn 还是 Step”的命名，而在于 Runtime 是否能回答输入何时被接纳、它影响哪个请求、旧请求是否仍然有效，以及审批和 Environment 是否需要重新验证。

如果一个新输入可以无记录地改变当前请求条件，说明 Runtime 的一致性边界不清晰。

## Q4：Session / Turn / Step 如何恢复？

### A：恢复不是重载 transcript，而是重建执行条件并对账副作用

可靠恢复至少需要重新确认：

~~~text
逻辑状态
+ 能力 / Policy snapshot
+ Environment identity
+ Tool Call state
+ 进程或 Worker ownership
+ 外部 Operation status
~~~

### 经典设计一：事件与状态投影

Kimi Code v2 的 EventDispatcher、Wire 和 Context Memory 将 durable event、append log、checkpoint、状态投影和模型可见 Context 分开。[^kimi-wire] [^kimi-context]

优势是可以 replay 和恢复；代价是事件版本、状态迁移和损坏日志处理更复杂。

### 经典设计二：执行 claim 与接管

OpenCode 用 durable execution claim 表达 Session 当前由哪个 Worker 执行。Worker 崩溃后，恢复不是重新猜下一步，而是根据未释放 claim 和 Session history 进行接管。[^opencode-execution] [^opencode-runner]

这适合服务化 Agent，但恢复必须同时验证 Workspace 和 Worker Environment。

### 经典设计三：工具调用重放策略

Pi 的 Runtime 对恢复中的 Tool Call 有明确的 replay-safe 处理路径；但这种策略主要解决 Tool 调用重建，长期远程 Operation 和宿主级 Environment 仍由应用负责。[^pi-recovery]

### 经典设计四：最小 trajectory

mini-SWE-agent 保存模型消息、命令和 Environment output，足以做 trajectory 分析和 benchmark 评价，但它没有完整 Session Store、远程 Operation reconciliation 或通用 Checkpoint。[^mini-trajectory]

这不是缺陷，而是产品定位不同：它选择最小、可读、可评估的控制流，而不是持续协作 Runtime。

### 判断

恢复必须区分：

~~~text
未执行
执行失败
执行成功
仍在执行
取消已确认
副作用未知
~~~

如果 Runtime 只有“成功/失败”两个结果，无法安全处理“副作用已经发生但完成事件丢失”的窗口。

## 五个关键判断

### 1. 语义趋同，不代表结构趋同

Codex、OpenCode、Pi、Kimi Code 和 OpenHands 的类名、事件和持久化方式不同，但都必须解决持续会话、用户意图、执行边界和恢复问题。

### 2. Session 的核心是执行所有权

Session 是否拥有 Environment、活动执行、后台任务和恢复责任，比它是否保存消息更重要。

### 3. Turn 的核心是输入生效边界

Turn 规定一次用户意图何时被接纳、何时结束，以及审批、中断、steering 和模型变化如何作用于运行。

### 4. Step 的核心是条件一致性

Step 将 Context、Capability、Policy、Environment、Model Request 和 Tool Execution 绑定在一个可验证边界内。

### 5. 恢复的核心是外部事实对账

Transcript 可以恢复上下文，Event 可以恢复状态，Checkpoint 可以恢复执行条件，但外部副作用必须查询和对账。

## 参考源码

[^opencode-session]: [OpenCode v2 Session service](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/session.ts#L1-L180)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90)
[^openhands-context]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^pi-session]: [Pi AgentSession runtime](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L265-L352)
[^pi-storage]: [Pi JSONL session storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^opencode-step]: [OpenCode v2 step execution](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/step.ts#L64-L150)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^kimi-wire]: [Kimi Code v2 Wire and durable state](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/wire/wireService.ts#L1-L180)
[^kimi-context]: [Kimi Code v2 context memory](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts#L1-L180)
[^opencode-runner]: [OpenCode v2 runner continuation](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/index.ts#L1-L35)
[^pi-recovery]: [Pi replay-safe tool recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^mini-trajectory]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
