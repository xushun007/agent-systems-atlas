---
title: Coding Agent 的 Tool Invocation：关键问题
topic: tool-invocation
reviewed_at: 2026-09-18
status: active
document_type: key-questions
---

# Coding Agent 的 Tool Invocation：关键问题

本专题只讨论四个问题。重点是一次模型 Tool Call 如何经过 Runtime，最终成为可授权、可执行、可观察和可恢复的动作。

## Q1：Tool Call 什么时候从模型意图变成 Runtime 动作？

### A：必须经过准备阶段，不能把模型 JSON 直接交给工具

最小生命周期是：

~~~text
advertise
→ select
→ parse / validate
→ resolve Environment
→ authorize / approve
→ preflight
→ execute
→ observe / settle
~~~

模型只提出工具名和参数；Runtime 还需要解析参数、绑定 Environment、确定具体实现、检查权限和生成稳定 call identity。

### 经典设计对比

- Pi：明确拆分 prepare 与 execute；prepare 阶段查找 Tool、校验参数、调用 hook 和检查取消，execute 阶段才进入具体工具实现。[^pi-prepare] [^pi-execute]
- Codex：ToolRouter、StepContext、Permission 和 Environment 共同决定实际执行条件，不把 Tool schema 当成最终授权。[^codex-router] [^codex-step]
- mini-SWE-agent：把 action 交给 Environment protocol 执行，保留最小控制流，但解析、策略和恢复能力主要由上层提供。[^mini-environment]

### 判断

如果模型输出可以直接调用 handler，系统缺少真正的 Tool Runtime；至少应存在一个不可产生副作用的 prepare/preflight 边界。

## Q2：谁决定 Tool Call 是否允许？

### A：Tool 描述能力，Policy/Approval 授权，Environment 执行硬限制

三者不能合并：

~~~text
Tool schema       能做什么
Policy            在当前条件下是否允许
Approval          用户是否批准这次范围
Environment       实际能触及什么资源
~~~

审批必须绑定 Tool Call、能力范围、Environment 和有效期。一次批准不应无条件扩大到所有后续调用。

### 经典设计对比

- Codex：Permission profile 和 Network approval 处于执行路径，并与 Step/Environment 条件结合。[^codex-permissions] [^codex-network]
- Gemini CLI：Policy Engine 与 Shell execution 分层，策略允许不等于命令已经执行。[^gemini-policy] [^gemini-shell]
- Kimi Code：Permission gate 与 Tool Policy 分离，分别处理权限决策和工具策略。[^kimi-permission] [^kimi-policy]
- OpenCode：Tool responsibility 与 Session execution/Workspace 分开，最终边界由执行服务和 Workspace provider 共同决定。[^opencode-tools] [^opencode-workspace]

### 判断

好的设计让用户能回答“我批准了什么”，让 Runtime 能回答“当前调用为什么允许”，让 Environment 能保证“即使模型或 Tool 出错，也不能越过硬边界”。

## Q3：并行、流式和取消如何保持 Tool Call 语义？

### A：每个 Tool Call 独立结算，批次只负责调度，不吞掉子调用状态

一个模型响应可能包含多个 Tool Call：

~~~text
Tool batch
  ├─ Call A → success
  ├─ Call B → failed
  └─ Call C → unknown
~~~

每个调用都需要独立的 call ID、参数、审批、执行状态、输出和副作用状态。流式 update 是观察，不是最终结算；取消请求也不是取消确认。

### 经典设计对比

- Pi：execute 阶段通过 update callback 输出增量状态，并分别处理 start/end、异常和 AbortSignal。[^pi-execute]
- Gemini CLI：SDK stream loop 将模型流、Tool Call 和后续消息处理串起来；Shell policy 与执行结果仍需分开观察。[^gemini-session] [^gemini-shell]
- Codex：Executed Tool Call metadata 和 unified execution manager 支持工具执行记录、后台状态和后续恢复。[^codex-recorder] [^codex-unified]

### 判断

并行不是把多个调用合成一个结果；流式不是完成状态；取消不是已停止。Runtime 必须保留每个调用的独立终态。

## Q4：失败和重试如何避免重复副作用？

### A：先区分失败与未知，再决定重试还是对账

关键状态至少包括：

~~~text
not_started
running
completed
failed_before_effect
effect_confirmed
effect_unknown
cancel_confirmed
~~~

如果请求已经发出但结果丢失，不能把 timeout 直接当作 failed 并重新执行。正确流程是：

~~~text
unknown
→ query / reconcile
→ confirmed success / confirmed failure / still running / manual recovery
~~~

### 经典设计对比

- Pi：对恢复中的 Tool Call 区分 replay-safe 和不可安全重放的调用。[^pi-recovery]
- Kimi Code：Tool dedupe 和 stale guard 防止重复调用或在运行时条件变化后继续使用旧动作。[^kimi-dedupe] [^kimi-glob]
- OpenCode：Session execution claim 将未结算执行留给恢复和 Worker 接管，而不是让上层重新猜测。[^opencode-execution]
- Codex：执行记录和工具管理器保留调用身份、状态和运行资源，为后续 settlement 提供事实。[^codex-recorder]

### 判断

Tool Runtime 的可靠性，不在于失败后重试得多快，而在于能否知道副作用是否已经发生。

## 四个关键判断

1. Tool Call 必须经过 prepare/preflight，模型输出不是可执行动作；
2. Tool、Policy、Approval 和 Environment 是四个不同责任层；
3. 并行、流式和取消必须保留每个调用的独立终态；
4. 未知副作用必须先对账，再决定重试。

## 参考源码

[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^codex-router]: [Codex ToolRouter](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/router.rs#L1-L120)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-SWE-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^pi-recovery]: [Pi replay-safe tool recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^kimi-glob]: [Kimi runtime stale guard](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts#L90-L135)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90)
[^codex-recorder]: [Codex executed tool call metadata](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/executed_tool_calls.rs#L280-L470)
[^codex-unified]: [Codex unified execution manager](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^gemini-session]: [Gemini CLI SDK stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
