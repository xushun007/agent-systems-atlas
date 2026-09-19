---
title: Coding Agent 的 Trace 层级：Session、Turn、Step、Tool Call 与 Operation
series: Coding Agent 的 Observability / Evaluation
part: 2
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Trace 层级：Session、Turn、Step、Tool Call 与 Operation

## 结论

Coding Agent 的 Trace 不是把所有日志加上一个 trace_id。它必须表达不同运行对象之间的包含、因果和关联关系：

~~~text
Session
  └─ Turn
      └─ Step
          ├─ Model Request
          ├─ Tool Call
          │    └─ Environment Execution
          │          └─ External Operation
          └─ Approval / Interrupt / Recovery
~~~

这棵树仍然不完整：一个 Turn 可以有多个 Step，一个 Step 可以产生并行 Tool Call，一个 Tool Call 可以启动跨越当前 Step 的 Operation，一个子 Agent 可以有独立 Session，一个远程 Worker 可以接管同一个 Session。

所以需要同时使用三种关系：

- containment：谁包含谁；
- causation：谁触发谁；
- correlation：哪些对象属于同一次业务运行。

如果只用父子树，会丢失异步 Operation 和跨进程因果；如果只用 correlation_id，则无法表达生命周期和资源归属。

## 1. Trace 的最小对象模型

### 1.1 Session

Session 表示一组可以持续、恢复或重新投影的交互和运行状态。它通常关联用户、workspace/environment、对话历史、模型配置、扩展能力、持久化记录、子 Agent 和后台任务。

Session 不应简单等于一个进程。服务化 Agent 中，Session 可以跨越多个 Worker；本地 Agent 中，进程退出后 Session 仍可能恢复。

### 1.2 Turn

Turn 表示一次用户输入或一次可归因的 Agent 处理回合。它通常包含用户输入、能力投影、模型请求序列、Tool Call、审批、中断和最终响应。

用户在 Turn 运行期间的 approval、interrupt 或 steering input，不一定新建 Session；是否新建 Turn 取决于 Runtime 如何处理控制事件。Trace 必须记录这一边界，而不能从消息数量猜测。

### 1.3 Step

Step 是一个可执行的一致性单元，通常包含一次模型请求、一次工具处理阶段或一次可恢复的执行边界。它需要关联 Context/Capability Snapshot、Policy snapshot、Environment binding、Model request、Tool Call 和结果提交。

Codex 的 StepContext 将当前 Step 的执行条件显式放入运行路径；这说明 Step 是执行归因和一致性边界，而不只是 UI 中的一行。[^codex-step]

### 1.4 Model Request

Model Request 是发送给 Provider 的一次请求，需记录 request identity、model/provider、input projection、Tool/schema projection、stream lifecycle、usage、finish reason 和 error/retry。

一次 Step 可能因网络错误或流式中断产生多个 Provider request，但它们不应被当作多个用户 Turn。

### 1.5 Tool Call

Tool Call 是模型提出的一次结构化动作请求。其状态至少包括 proposed、parsed、validated、awaiting_approval、approved、dispatched、running、result_received、committed，以及 rejected、failed、unknown。

Tool Call 是模型输出和 Runtime 执行之间的桥梁，但不必然等于一个外部副作用。

### 1.6 Environment Execution

Environment Execution 是 Runtime 在本地或远程 Environment 中执行 Tool 的实例。它关联 workspace/environment、process/worker、command/request、资源限制、输出、退出或协议结果、取消和清理。

一个 Tool Call 可以创建多个 Environment Execution，例如重试、分片或并行命令。

### 1.7 External Operation

External Operation 是脱离当前 Tool Call 生命周期仍可能继续的副作用，例如创建远程资源、部署、发布包、发送消息、运行远程任务或启动长期服务。

Operation 必须有自己的 identity 和状态查询。Tool Call 结束不代表 Operation 结束。

## 2. 三种关联关系

### 2.1 Containment

Containment 表示生命周期上的包含：

~~~text
Session contains Turn
Turn contains Step
Step contains Model Request
Step contains Tool Call
Tool Call contains local Environment Execution
~~~

它适合界面树、权限范围和聚合指标。

### 2.2 Causation

Causation 表示触发关系：

~~~text
user input
  → turn_accepted
  → model_request
  → tool_call_requested
  → approval_requested
  → tool_call_dispatched
  → process_started
  → tool_result_received
  → next_model_request
~~~

一个 Event 的因果父节点不一定是生命周期父节点。用户点击取消触发 Tool Call 的 cancellation_requested，但这个 UI 事件不一定属于 Tool Call 的子树。

### 2.3 Correlation

Correlation 表示业务归属：

~~~text
session_id
turn_id
step_id
task_id
operation_group_id
experiment_id
~~~

一个远程 Operation 可能由一个 Tool Call 创建、被另一个 Worker 查询、在下一个 Turn 中完成。它需要 correlation_id 连接多个 Trace，而不能强行挂在已结束的 Step 下。

## 3. 为什么一个 trace_id 不够

一个 Session 内可能同时存在 steering input、后台任务和并行 Tool Call。所有对象共享一个 trace_id 会无法回答：

- 哪个输入触发了哪个 Tool Call；
- 哪个后台 Operation 属于哪个 Turn；
- 哪个取消请求影响了哪个进程；
- 哪个子 Agent 结果被父 Agent 接受。

至少需要 session_id、turn_id、step_id、request_id、tool_call_id、execution_id、operation_id、parent_run_id 和 correlation_id。

线程关系不等于业务关系。一个 Tool 在另一个线程执行，不表示它属于另一个 Turn；一个远程请求在另一个服务执行，也不表示它脱离当前 Session。

Provider 请求重试可以有新的 request_id，但应保留 logical_model_call_id、attempt_id 和 retry_of。远程副作用重试还需要 operation identity 和 idempotency key。

## 4. Session、Turn、Step 的具体职责

### 4.1 Session 负责长期关联

Session 适合关联用户、workspace、长期扩展、模型配置、历史状态、子 Agent 和后台 Operation。它不应承担每个 Tool Call 的即时终态。

### 4.2 Turn 负责用户意图归因

Turn 适合回答用户这次输入是什么、Agent 发起了哪些 Model Request、使用了哪些 Tool、发生了哪些审批和中断、最终结果是什么。

一个 Turn 可以失败，但内部仍可能有成功的测试、已创建的远程资源或未完成的后台进程。

### 4.3 Step 负责执行一致性

Step 绑定 Context、能力投影、Policy、Environment、Model Request、Tool Call 和结果提交。

如果模型请求使用能力快照 A，Tool 执行时却使用全局能力集合 B，就产生 Step 内一致性错误。Step Trace 应能检测这种差异。

## 5. 审批、中断和 Steering 的 Trace 关系

### 5.1 Approval

Approval 是独立控制事件：

~~~text
tool_call_requested
  → approval_requested
  → user_decision
  → approval_recorded
  → dispatch or reject
~~~

它应记录 approval_id、actor、capability、scope、environment、decision、expires_at、applied_to 和 policy version。

Codex 的 Permission profile 和 Network approval 是独立执行条件，应作为 Trace 中的 Policy/Approval 节点，而不是隐藏在 Tool Result 中。[^codex-permissions] [^codex-network]

### 5.2 Interrupt

Interrupt 是控制请求，不是最终状态：

~~~text
interrupt_requested
  → cancellation_propagated
  → process/connector stopping
  → cancellation_confirmed
~~~

如果进程仍在运行，Trace 不能直接将 Tool Call 标记为 cancelled。

### 5.3 Steering input

Steering input 可能排队到下一个 Step、中断当前 Model Request，或作为当前 Tool Call 的控制信号。Trace 必须记录它最终影响了哪个对象。

## 6. 并行 Tool Call 和父子关系

模型一次返回多个 Tool Call 时，它们共享 Step 的 Context 和 Policy snapshot，但各自拥有 tool_call_id、execution_id、approval、output、side effect 和 final state。

一个并行批次可能出现：

~~~text
A = success
B = failed
C = unknown
~~~

Step 终态不能简单使用 success 或 failed，应保留子节点状态，并根据任务策略判定是否继续。

如果 B 依赖 A 的文件或资源，Trace 应表达 A completed → B dispatched 的 dependency，而不能仅把二者放在同一个 Step 下。

## 7. 子 Agent 和远程 Worker

### 7.1 子 Agent 的两种 Trace 模型

子 Agent 可以作为父 Turn 下的嵌套 Run，也可以拥有独立 Session，通过 delegation_id 和 parent_run_id 关联。

嵌套 Run 适合共享任务和成本归因；独立 Session 适合独立恢复和并行执行。两者都要求区分父子能力和 Environment。

### 7.2 Kimi Code 的具体观察入口

Kimi Code 的 Task persistence 和 subagent mirror/fork metadata 是分析父子 Trace 的具体代码入口。[^kimi-task] [^kimi-subagent]

应重点检查 fork 产生新 Task 还是新 Run、子 Agent 的 Tool Policy 是否重新计算、子结果如何回传、父 Agent 是否记录 acceptance，以及子 Agent 失败是否等于父 Task 失败。

### 7.3 OpenCode 的 Worker claim

OpenCode 的 Session execution claim 说明，同一个业务 Session 可能由不同 Worker 持有执行责任。[^opencode-execution]

Trace 需要区分 logical session owner、current execution claim、worker attempt 和 environment instance。Worker 断开后，新 Worker 可以接管 Session，但不能复用旧 Worker 的本地进程状态而不重新确认。

### 7.4 OpenHands 的跨服务关联

OpenHands 的 Agent Server、Sandbox、Workspace 和服务上下文构成跨进程/跨服务 Trace。[^openhands-adapter]

本地 Agent event、远程 Sandbox event 和外部服务状态必须使用可传递的 identity 关联，不能依赖本地内存对象或单个 HTTP request id。

## 8. Environment Operation 的异步边界

一个 Tool Call 返回时，Operation 可能是 completed、failed 或 accepted_but_running。第三种必须生成独立 operation_id，并由后续事件或查询更新。

~~~text
Turn 1 / Step 3
  → create deployment operation
Turn 1 ends
Turn 2
  → query deployment operation
  → operation completed
~~~

本地 watcher、服务器、长时间测试和后台编译也可能在 Tool Call 返回后继续。PID、process group、port 和 lease 需要作为 Operation 事实记录。

## 9. Trace 与指标聚合

### 9.1 延迟

至少区分 user_to_first_response、model_request_latency、tool_queue_latency、tool_execution_latency、environment_startup_latency、remote_operation_latency 和 turn_wall_time。

把所有时间压成 turn duration，会掩盖真正瓶颈。

### 9.2 成本

Token 和费用可以归因到 Session、Turn、Step、Model Request、Tool/Connector、子 Agent 和 Evaluation sample。父子 Agent 成本不能同时计入总成本和独立成本而造成重复计算，需要定义 inclusive 和 exclusive cost。

### 9.3 成功率

应分别计算 model request success rate、tool call success rate、environment execution success rate、operation completion rate、turn completion rate 和 task acceptance rate。

Tool 成功率高，不代表任务完成率高；Task 完成率高，也不代表安全拒绝和恢复质量好。

## 10. 各 Agent 的具体 Trace 机制

### 10.1 Codex

Codex 的 StepContext、Permission profile 和 Network approval 提供执行关联入口。[^codex-step] [^codex-permissions] [^codex-network]

Trace 应以 Step 为主要执行节点，把审批和 Tool Execution 作为同一 Step 下的可关联状态，而不是仅用消息顺序推导。

### 10.2 Pi

Pi 的 Agent Loop preparation/execution hook 和 Node Environment 给出了 Tool Call 到进程输出的调用链。[^pi-prepare] [^pi-execute] [^pi-env]

应用层若要支持 Trace，需要为 hook、Environment execution 和后台进程补充稳定的 execution identity。

### 10.3 OpenCode

OpenCode 的 Workspace provider 和 execution claim 要进入 Trace，否则服务化 Worker 的责任迁移无法归因。[^opencode-workspace] [^opencode-execution]

### 10.4 Gemini CLI

Gemini CLI 的 Policy Engine 和 Shell execution 是两条不同责任链。[^gemini-policy] [^gemini-shell]

Trace 需要同时记录 policy decision 和 process result，避免将权限允许误认为命令成功。

### 10.5 OpenHands

OpenHands 的 Trace 要跨越 Agent Server、Sandbox、Workspace 和外部服务。[^openhands-adapter]

它更接近分布式执行 Trace，而不是单进程聊天日志。

### 10.6 Kimi Code

Kimi Code 需要将 Task、Subagent、Tool Policy 和 Tool Result 关联。[^kimi-task] [^kimi-policy] [^kimi-subagent]

父任务评价必须保留子任务的独立状态和 acceptance 关系。

### 10.7 mini-SWE-agent

mini-SWE-agent 的 trajectory 适合最小链路，但主要是消息和 Environment output 的顺序记录。[^mini-environment] [^mini-local]

它缺少独立 Operation、Policy 和远程 Worker 时，不能直接作为复杂 Coding Agent Trace 的完整模型。

## 11. Trace 数据结构

~~~text
RunNode {
  run_id
  run_type
  parent_run_id
  session_id
  turn_id
  step_id
  started_at
  ended_at
  status
  environment_id
  worker_id
  claim_id
}

CausationEdge {
  from_id
  to_id
  edge_type
  event_id
  created_at
}

OperationRecord {
  operation_id
  created_by_tool_call
  provider
  environment_id
  idempotency_key
  status
  last_confirmed_at
  cancel_state
}
~~~

将节点和边分开，能表达并行、异步、重试和跨服务关系；强行嵌套为 JSON 树会让查询和恢复困难。

## 12. 验证方案

1. 触发一次需要多轮模型请求和多个 Tool Call 的任务，验证 Session、Turn、Step、Request 和 Tool Call 的数量与父子关系。
2. 让模型同时发起三个工具调用，制造一个成功、一个失败、一个超时，检查 Trace 是否保留独立节点和部分成功状态。
3. 在等待审批和工具执行中分别发送取消，比较 approval、Tool Call、process 和 Turn 的终态是否正确关联。
4. 在服务化 Agent 中让执行 Worker 失联，再由另一个 Worker 接管，验证 claim、Environment 和 Operation 是否重新确认。
5. 创建一个 accepted-but-running 的远程任务，在下一个 Turn 查询完成，检查两个 Turn 是否通过同一个 operation_id 关联。
6. 让父 Agent 委派子 Agent，分别统计父 Turn、子 Run、子 Tool Call 和子成本，验证不会重复计数。
7. 只使用节点、事件和因果边重建 UI timeline、Tool Call 状态、Turn 终态和 Operation 状态，检查是否仍需要隐藏的内存状态。

## 设计原则

### 原则一：同时建模包含、因果和关联

Session/Turn/Step 解决生命周期包含，Event 和 edge 解决因果，correlation identity 解决跨 Worker、跨 Turn 和远程 Operation。

### 原则二：Step 是执行一致性边界

Context、Policy、Environment、Model Request 和 Tool Call 应能关联到同一个 Step snapshot。

### 原则三：异步副作用拥有独立 Operation

Tool Call、进程和远程资源的生命周期不一致时，必须用独立 Operation identity 和状态查询连接它们。

### 原则四：并行和重试保持独立身份

并行 Tool Call 不能合并为一个成功结果；请求重试不能伪装成新的用户动作；副作用重试必须使用幂等和 reconciliation。

### 原则五：Trace 必须服务于恢复和评价

如果 Trace 只能生成时间线，不能解释责任、重建状态和归因副作用，它只是调试日志，不是 Runtime Trace。

## 未确认事项

- 各 Agent 是否显式持久化 causation 和 correlation edge，需要逐项目检查事件模型；
- 各远程系统是否提供可查询的 operation identity，需要服务端验证；
- 子 Agent 的父子 Trace 是嵌套 Run 还是独立 Session，需要固定版本源码确认；
- Provider request retry、Tool retry 和副作用 retry 的 identity 是否分离，需要运行实验；
- 各 Agent 的成本和延迟是否支持 inclusive/exclusive 归因，需要结合实际 telemetry 字段确认。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
