---
title: Coding Agent 的 Trajectory、Checkpoint 与 Replay
series: Coding Agent 的 Observability / Evaluation
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Trajectory、Checkpoint 与 Replay

## 结论

Trajectory、Checkpoint 和 Replay 经常被当作同一件事，实际上它们回答不同问题：

| 对象 | 回答的问题 |
| --- | --- |
| Trajectory | Agent 依次看到了什么、提出了什么、工具返回了什么 |
| Checkpoint | 在某个边界，Runtime 的可恢复状态是什么 |
| Replay | 能否用保存的数据重新执行或重建某段运行 |

一条完整 trajectory 不等于恢复 checkpoint；一个 checkpoint 也不等于可以安全重放副作用；一次 replay 成功也不等于原任务可以被确定性复现。

最小的正确关系是：

~~~text
Trajectory = interaction history
Checkpoint = runtime state boundary
Replay = reconstruction or re-execution procedure
~~~

Coding Agent 的恢复需要同时面对三类状态：

1. Agent 内部状态：消息、计划、Tool Call、Policy、模型配置；
2. Environment 状态：文件、进程、Sandbox、workspace revision；
3. 外部副作用：远程资源、部署、发布、消息和长期任务。

前两类可以部分保存和重建，第三类通常必须通过 operation identity 查询，不能依赖 trajectory 中的一段文字。

## 1. Trajectory 是什么

### 1.1 最小 trajectory

最小 trajectory 通常是：

~~~text
user message
→ model response
→ tool call
→ tool result
→ next model response
~~~

它适合：

- 调试模型行为；
- 训练或离线分析；
- 展示 Agent 如何完成任务；
- 比较不同 Prompt 或模型；
- 复现部分上下文。

### 1.2 完整 trajectory 还需要什么

若要用于 Runtime 分析，还需要记录：

- Session/Turn/Step identity；
- Model Request 和 Provider response；
- Tool schema 和 capability projection；
- Policy 和 approval；
- Environment binding；
- Tool execution identity；
- Process/remote operation；
- 截断、超时和取消；
- 用户中途输入；
- 子 Agent 和并行关系。

只保存 assistant message、Tool Call 和 Tool Result，无法判断当时模型看到了哪个工具版本、使用了哪个 Environment，以及调用是否真的产生了外部副作用。

### 1.3 Trajectory 的来源

Trajectory 可能来自：

- Provider message history；
- Agent Event log；
- UI timeline；
- Tool execution log；
- Evaluation recorder；
- 事后根据多个来源拼接。

这些来源的完整性不同。UI timeline 可能合并事件；Provider history 可能没有 Environment facts；Tool log 可能没有用户 steering input。必须标明 trajectory 的来源和缺失部分。

## 2. Checkpoint 是什么

### 2.1 Checkpoint 不是一份消息快照

Checkpoint 是一个可恢复边界，至少需要包含：

~~~text
logical state
projection state
execution state
environment reference
external operation references
~~~

例如，一个正在等待审批的 Checkpoint 需要知道：

- 哪个 Tool Call 在等待；
- 模型当时看到什么 schema；
- 用户审批范围是什么；
- 当前 Environment 是否仍然有效；
- 恢复后应等待、拒绝还是重新生成请求。

### 2.2 Checkpoint 的一致性边界

常见边界包括：

- Turn 接受后；
- Model Request 完成后；
- Tool Call 创建后；
- Approval 等待时；
- Tool Result 提交后；
- Step 完成后；
- 远程 Operation 被确认后。

边界越细，恢复越精确，但持久化和状态迁移成本越高。边界越粗，恢复越简单，但丢失中间副作用的风险越大。

### 2.3 Checkpoint 需要引用，不要复制全部资源

Checkpoint 可以保存 workspace_id、revision、sandbox_id、operation_id 和 credential binding 的引用，不应把全部 Environment 内容复制进状态记录。

恢复器需要先验证引用仍然有效：

~~~text
checkpoint
  → resolve environment
  → verify revision/lease/identity
  → reconcile operation
  → restore logical state
~~~

如果 Environment 已经销毁，Checkpoint 应进入 waiting_environment 或 state_unknown，而不是假设 cwd 仍然代表原环境。

## 3. Replay 的三种含义

### 3.1 Message replay

重新把历史消息送给模型，观察模型下一步输出。

它可以研究模型行为，但不能保证：

- Tool schema 相同；
- Policy 相同；
- Environment 相同；
- Tool Result 相同；
- Provider sampling 相同；
- 外部资源仍然存在。

### 3.2 Event replay

重新读取 Event，重建 Session/Turn/Step/Tool 状态和 UI projection。

它适合：

- 恢复逻辑；
- UI 重建；
- 指标重算；
- 状态 reducer 测试。

Event replay 不应自动重新执行外部副作用。

### 3.3 Effect replay

重新执行 Tool、命令或远程 Operation。这是风险最高的 Replay。

它需要：

- 幂等 key；
- operation identity；
- side-effect classification；
- Environment version；
- approval 重新验证；
- 外部资源查询；
- 用户确认或 dry-run。

把 event replay 和 effect replay 混在一起，会造成恢复时重复部署、重复发送或重复写入。

## 4. 影响 Replay 的变量

### 4.1 模型变量

- Provider 和 model version；
- system/developer instructions；
- Tool schema；
- Skill 和 Resource；
- sampling 参数；
- 上下文压缩方式；
- Tool Result；
- 当前时间和随机性。

### 4.2 Runtime 变量

- Policy version；
- approval；
- Tool Registry；
- capability projection；
- retry policy；
- timeout；
- cancellation；
- 并发调度；
- 子 Agent 版本。

### 4.3 Environment 变量

- workspace revision；
- 操作系统；
- 依赖和环境变量；
- 网络可达性；
- Secret binding；
- 进程和服务；
- 远程资源状态；
- Sandbox image。

因此，Replay 的结果应声明是：

~~~text
exact replay
deterministic reconstruction
best-effort reproduction
counterfactual evaluation
~~~

大多数 Coding Agent 只能做到后面三种之一，不能默认宣称 exact replay。

## 5. Trajectory、Checkpoint 与状态所有权

### 5.1 消息归 Agent 状态

模型消息和 Tool Result 可以作为 trajectory，但不包含所有 Runtime 状态。恢复器还需要知道请求是否已发送、审批是否已批准、工具是否已派发和结果是否已提交。

### 5.2 文件归 Environment 状态

文件修改是 Environment effect，不能只从 edit Tool 的参数推断最终状态。用户可能并发修改，formatter 可能继续改写，脚本可能生成其他文件。

Checkpoint 应保存 workspace revision、文件 hash 或 snapshot identity，而不是只保存一组编辑命令。

### 5.3 远程资源归 External Operation

部署、PR、Issue、云资源和后台任务属于外部系统。Trajectory 中的“请求已发送”不等于远程资源已经成功。

恢复时应先查询 operation_id 或 resource identity，再决定是否继续。

## 6. 具体 Agent 机制

### 6.1 Codex：Step 边界适合作为 Checkpoint 入口

Codex 的 StepContext 将 Step 级执行条件显式化，Permission profile 和 Network approval 参与执行决策。[^codex-step] [^codex-permissions] [^codex-network]

因此 Codex 的 Checkpoint 不能只保存消息；至少要保留当时的 Step 条件、Policy、Approval 和 Environment reference。恢复旧 Tool Call 时，应验证这些条件，而不是从当前全局配置重新推导。

### 6.2 Pi：Trajectory 依赖 Agent Loop 和宿主持久化

Pi 的 Agent Loop preparation/execution hook 和 Node Environment 可以形成 Tool Call 到输出的 trajectory。[^pi-prepare] [^pi-execute] [^pi-env]

但长期 Checkpoint 是否包含后台进程、workspace revision、扩展状态和远程 operation，更多取决于宿主应用。Pi 的轻量设计使 trajectory 容易获得，但完整 recovery checkpoint 不是自动产生的。

### 6.3 OpenCode：Checkpoint 必须绑定 Workspace 和 execution claim

OpenCode 将 Workspace provider 与 Session execution claim 分开。[^opencode-workspace] [^opencode-execution]

因此恢复时不仅要读取 Session history，还要确认：

- 当前 Worker 是否持有 claim；
- Workspace provider 是否指向相同资源；
- 原 Environment 是否仍然有效；
- execution 是否可以接管。

如果只 replay Session Event，可能在错误 Workspace 上继续执行。

### 6.4 Gemini CLI：Shell output 不能独立证明恢复安全

Gemini CLI 将 Policy Engine 与 Shell execution 分层。[^gemini-policy] [^gemini-shell]

恢复 Shell Tool Call 时，需要重新判断 Policy、cwd、Environment variables 和当前 workspace，而不能仅凭历史命令和 exit code 重放。历史 shell output 只是 observation，不是当前环境事实。

### 6.5 OpenHands：远程 Sandbox 和服务状态不能由 trajectory 替代

OpenHands 的 agent-server context、Sandbox、Workspace 和服务信息跨越多个运行边界。[^openhands-adapter]

Session 恢复需要分别处理：

- Agent history；
- Sandbox 是否仍存在；
- Workspace 是否仍是同一 revision；
- service URL 和身份是否仍有效；
- 外部 operation 是否完成。

销毁 Sandbox 不等于远程副作用回滚。

### 6.6 Kimi Code：Task persistence 与子 Agent 恢复

Kimi Code 的 Task persistence 和 subagent metadata 是恢复父子执行关系的具体入口。[^kimi-task] [^kimi-subagent]

恢复时需要区分：

- 父 Task 的逻辑状态；
- 子 Agent 的执行状态；
- Tool Policy 是否仍然有效；
- 子结果是否已经被父 Agent 接受。

复制父消息不能替代子 Run 和 Tool 状态。

### 6.7 mini-SWE-agent：Trajectory 是基线，不是 Checkpoint

mini-SWE-agent 的 Environment protocol 和 LocalEnvironment 形成清晰的最小 trajectory：模型消息、命令和输出。[^mini-environment] [^mini-local]

它没有天然提供完整的 Session Store、远程 operation 或 workspace snapshot，因此 trajectory 更适合作为离线样本和调试记录，不能直接视为恢复协议。

## 7. Checkpoint 的最小数据结构

~~~text
Checkpoint {
  checkpoint_id
  session_id
  turn_id
  step_id
  logical_state
  trajectory_cursor
  capability_snapshot_id
  policy_snapshot_id
  environment_binding
  pending_tool_calls
  active_operations
  user_control_state
  last_confirmed_effect
  created_at
}
~~~

其中 last_confirmed_effect 很重要。它表示恢复器知道哪些副作用已经确认，哪些仍然未知。

## 8. 恢复决策表

| 检查结果 | 恢复动作 |
| --- | --- |
| 历史能力、Policy、Environment 均一致 | 继续或重建下一 Step |
| Schema 变化但未产生副作用 | 重新验证或重新请求模型 |
| Tool 已派发，结果未知 | 查询 Operation，不自动重试 |
| Workspace revision 改变 | 标记旧 Context stale，重新检查 |
| 凭证/租约过期 | 重新授权或等待 Environment |
| 远程资源已完成 | 写入确认结果，避免重复执行 |
| 无法确认副作用 | 保留 unknown，等待查询或人工处理 |

## 9. Replay 与 Evaluation

### 9.1 Replay 作为评估输入

Trajectory 可以用于比较：

- 不同模型；
- 不同 Prompt；
- 不同 Tool 描述；
- 不同 Policy；
- 不同模型路由。

但比较必须固定或显式记录 Environment、Tool Result 和验收标准。

### 9.2 Replay 作为回归测试

回归测试可以重放：

- Event reducer；
- Tool argument parser；
- Policy decision；
- Context builder；
- State reconstruction。

不应默认重放真实副作用。副作用应使用 mock、sandbox、dry-run 或隔离租户。

### 9.3 Counterfactual replay

如果改变模型或 Prompt，生成的是 counterfactual run，不是原运行恢复。它应拥有新的 run_id，并通过 parent_sample_id 关联原样本，而不是覆盖原 trajectory。

## 10. 验证方案

1. 在 Model Request 完成、Tool Call 已生成、Approval 等待、Tool 已派发、结果未知和 Step 完成六个时点中断 Host，验证每个边界能否形成有效 Checkpoint。
2. 修改 Tool schema 后恢复旧 Tool Call，观察系统是否使用历史 Projection、拒绝 stale call 或错误使用当前 Registry。
3. 在文件写入后让用户并发修改 workspace，恢复时比较 revision、hash 和旧 Context 的有效性。
4. 在远程 operation 已接受但未完成时断开 Connector，恢复时验证是否查询 operation 而不是重复创建。
5. 对同一 trajectory 使用不同模型或 Prompt 做 counterfactual replay，检查是否创建新的 run identity。
6. 删除 UI、Metric 和 Trace projection，只保留 canonical event 和 Environment fact，验证是否能重建当前状态。
7. 重复执行恢复流程，验证 Checkpoint reducer 和 operation reconciliation 是否幂等。

## 设计原则

### 原则一：Trajectory 记录交互，Checkpoint 记录可恢复状态

消息和 Tool Result 是交互历史，不自动包含能力、Policy、Environment 和外部副作用状态。

### 原则二：Replay 区分重建与重执行

Event replay 可以重建状态；Effect replay 可能产生真实副作用，必须有幂等、隔离和审批。

### 原则三：恢复以外部事实为准

文件、进程和远程 Operation 的当前状态必须重新验证，不能只相信历史消息或 Tool Result。

### 原则四：不确定性必须随 Checkpoint 保存

已确认、失败、取消、正在运行和未知不能压成同一个终态；未知状态是恢复输入，不是异常日志。

### 原则五：Counterfactual run 不覆盖原运行

改变模型、Prompt、Tool 或 Policy 后的运行应创建新身份，并与原样本关联，保证评估可比较。

## 未确认事项

- 各 Agent 是否将能力、Policy 和 Environment snapshot 纳入 Checkpoint，需要逐项目检查持久化代码；
- 各远程系统是否支持 operation reconciliation，需要服务端验证；
- Workspace snapshot 是否包含进程、网络和远程资源，不能由文件快照功能推断；
- 各 Agent 是否区分恢复、重试和 counterfactual replay，需要结合 CLI 和测试实现确认；
- Trajectory 的脱敏、采样和长期保留策略需要部署级验证。

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
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
