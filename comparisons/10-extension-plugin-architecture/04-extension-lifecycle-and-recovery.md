---
title: Coding Agent 扩展生命周期：版本、失败、恢复与卸载
series: Coding Agent 的 Extension / Plugin Architecture
part: 4
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 扩展生命周期：版本、失败、恢复与卸载

## 结论

扩展生命周期的真正难点，不在于实现 `load()` 和 `unload()`，而在于处理以下事实：扩展可能已经被模型看到、已经被用户批准、已经启动了进程、已经产生了外部副作用，但 Host 在任意一个阶段崩溃或断线。

因此，扩展不能只拥有一个 `active/inactive` 标志。至少需要同时跟踪三条状态线：

```text
Admission state   是否被 Runtime 接纳
Execution state   当前调用和进程是否运行
Effect state      外部副作用是否已确认
```

这三者可能不一致：

```text
Plugin revoked
  ≠ child process stopped
  ≠ remote operation cancelled
```

本文的核心结论是：

> 扩展升级、禁用和恢复必须围绕“能力版本 + Environment identity + operation identity”设计，而不能只围绕 Plugin package 或当前连接设计。

## 1. 扩展生命周期与 Agent 生命周期的关系

### 1.1 三条生命周期

Coding Agent 至少有三种相关生命周期：

```text
Host lifecycle       Agent 进程启动到退出
Session lifecycle    会话创建、暂停、恢复、结束
Extension lifecycle  扩展发现、接纳、执行、撤销、卸载
```

它们不应假设一一对应：

- Host 退出时，远程扩展可能继续运行；
- Session 暂停时，MCP 连接可能仍然存活；
- Extension 禁用时，正在执行的 Tool Call 可能尚未结束；
- Session 恢复时，扩展版本可能已经变化。

### 1.2 Extension state 不应覆盖 Tool Call state

一个扩展可以处于 `active`，但某次调用已经 `timed_out`；也可以处于 `revoked`，但远程 operation 仍然 `running`。

建议分离：

```text
ExtensionRecord
ToolCallRecord
OperationRecord
EnvironmentBinding
```

其中 ExtensionRecord 描述“提供能力的对象”，ToolCallRecord 描述“模型提出的一次调用”，OperationRecord 描述“实际产生副作用的执行”，EnvironmentBinding 描述“在哪里和以什么身份执行”。

## 2. 从发现到卸载的完整状态机

### 2.1 Extension admission state

```text
unknown
  → discovered
  → validated
  → enabled
  → admitted
  → projected
  → active
  → draining
  → revoked
  → unloaded
```

失败分支：

```text
discovered → invalid
validated  → incompatible
admitted   → failed
active     → degraded
draining   → stuck
```

这里的 `active` 只表示扩展可以参与新的调用，不表示已有调用和外部 operation 都已结束。

### 2.2 Tool Call state

```text
projected
  → requested
  → validated
  → awaiting_approval
  → admitted
  → dispatched
  → running
  → result_received
  → committed
```

失败分支：

```text
rejected
timeout
transport_failed
process_crashed
result_unknown
cancel_requested
```

`result_unknown` 不等于 `failed`。它表示 Host 不知道外部副作用是否发生，恢复器必须先查询或要求用户处理。

### 2.3 Operation state

```text
not_started
  → accepted
  → started
  → effect_possible
  → effect_confirmed
  → completed
```

异常分支：

```text
effect_possible → effect_unknown
started         → cancel_requested
cancel_requested → cancel_confirmed
cancel_requested → cancel_failed
```

这个状态机适用于创建 PR、部署、发送消息、启动远程任务等动作。对于纯本地只读 Tool，可以简化，但不能把所有 Tool 都假设为无副作用。

## 3. Version：扩展版本到底影响什么

### 3.1 Package version 不等于 capability version

同一个 Plugin package 可能：

- 提供多个 Tool；
- 改变某个 Tool 的 schema；
- 改变 Skill 文本；
- 改变权限需求；
- 改变 MCP Server endpoint；
- 改变结果格式和错误语义。

因此需要区分：

```text
package_version
provider_version
capability_version
schema_version
environment_image_version
```

升级包但不改变 Tool schema，可能只影响实现；修改 schema 或权限需求，则至少影响 Projection 和 Admission。

### 3.2 版本应进入执行事实

一次 Tool Call 至少应记录：

```text
extension_id
package_version
capability_id
capability_version
schema_hash
policy_version
environment_image
```

这样恢复器才能判断旧调用是否能由新实现安全解释。

### 3.3 Schema compatibility

常见兼容变化：

- 增加可选参数；
- 增加结果字段；
- 改善错误信息。

高风险变化：

- 删除或重命名参数；
- 改变参数含义；
- 改变默认值；
- 改变副作用；
- 改变权限范围；
- 将同步调用改为异步 operation。

模型已经生成的 Tool Call 应绑定当时的 schema，而不是用“当前最新 schema”重新解释。

## 4. 初始化与部分成功

### 4.1 初始化不是原子动作

一个 Plugin 初始化可能依次完成：

```text
load code
→ read config
→ connect service
→ authenticate
→ discover capabilities
→ register tools
→ start background worker
```

任意一步失败，都可能留下部分资源：

- 已建立的网络连接；
- 已启动的子进程；
- 已注册但未投影的 Tool；
- 已取得但未清理的临时凭证；
- 已创建但未记录的远程订阅。

### 4.2 注册回滚

注册多个能力时，需要定义部分成功语义：

```text
register A → success
register B → failure
register C → not attempted
```

可选策略：

1. 全部回滚；
2. 保留 A，标记 Plugin degraded；
3. 保留安全的只读能力，撤销高风险能力；
4. 允许当前 Session 使用旧版本，下一 Session 切换。

每种策略都要记录结果，不能让“返回初始化错误”掩盖已完成的注册和外部副作用。

### 4.3 配置错误与运行错误分离

配置缺失、协议不兼容、认证失败、远程服务不可用和 Tool handler 崩溃，不应都显示为“Plugin failed”。恢复策略不同：

| 错误 | 通常动作 |
| --- | --- |
| 配置缺失 | 等待用户修复 |
| 版本不兼容 | 禁止接纳或选择兼容版本 |
| 认证失败 | 重新授权，不应无限重试 |
| 连接失败 | 重连或降级 |
| Tool 参数错误 | 返回模型修正 |
| handler 崩溃 | 隔离进程并标记能力失败 |
| 远程结果未知 | 查询 operation，不直接重试 |

## 5. 热更新与生效边界

### 5.1 为什么热更新危险

热更新可能同时改变：

- Tool schema；
- Skill 文本；
- Policy；
- Connector endpoint；
- Secret binding；
- Environment image；
- 结果解析器。

如果在一个 Turn 中途替换这些内容，模型生成时使用的假设可能立即失效。

### 5.2 四种更新策略

#### 立即生效

新请求立即使用新版本，旧 Tool Call 按当前版本重新校验。

简单但容易产生 stale schema 和权限错配。

#### 下一个 Step 生效

当前模型请求和其 Tool Call 使用旧 projection，下一次模型请求使用新版本。

适合 Step 级 Runtime，但需要保存旧 projection。

#### 下一个 Turn 生效

当前 Turn 内保持一致，用户下一次输入时切换。

一致性较强，但扩展修复或撤销不能立即影响正在执行的危险操作。

#### 新 Session 生效

把扩展版本视为 Session immutable configuration。

最容易恢复和审计，但动态能力和长会话体验较弱。

### 5.3 撤销与更新不是同一个操作

更新通常追求继续提供能力；撤销追求立即阻止新的能力使用。撤销应至少阻止：

- 新的 Projection；
- 新的 Tool Call；
- 新的子进程；
- 新的远程 operation。

但是否终止已运行的 operation，需要根据副作用和取消能力单独处理。

## 6. Disable、Drain、Revoke、Unload

### 6.1 Disable

禁止新 Session 或新 Turn 使用扩展，但不一定影响当前调用。

### 6.2 Drain

不再接收新调用，等待已有 Tool Call、进程和 operation 结束或进入明确终态。

### 6.3 Revoke

撤销能力授权。新的调用必须拒绝，已有调用是否继续取决于安全策略和 operation 类型。

### 6.4 Unload

释放 Host 中的代码、连接、监听器和进程资源。卸载不等于撤销远程副作用，也不等于删除扩展产生的文件。

完整的卸载路径应类似：

```text
disable
  → stop projection
  → drain new calls
  → request cancellation
  → wait/query operations
  → stop child processes
  → close connections
  → revoke temporary credentials
  → remove registry entries
  → persist final state
```

如果某一步无法完成，应进入 `stuck` 或 `state_unknown`，而不是强行标记 `unloaded`。

## 7. 失败恢复的关键分支

### 7.1 初始化期间崩溃

Host 在 Plugin 初始化中崩溃，恢复时不能直接再次运行初始化。需要检查：

- 是否已有同名进程；
- 是否建立了远程连接；
- 是否取得临时凭证；
- 是否创建远程订阅；
- 是否完成部分 Tool 注册。

初始化最好使用 operation identity 和幂等 key，使重复恢复不会重复创建资源。

### 7.2 Tool Call 前崩溃

模型已经输出 Tool Call，但 Host 尚未 dispatch。恢复器可以重新校验 schema、Policy 和 Environment，然后决定继续、请求批准或标记为 stale。

### 7.3 Dispatch 后无结果

Host 已把请求发送给 MCP Server 或远程 Connector，但没有结果。此时状态是 `result_unknown`，不能自动把调用放回模型上下文并重试。

恢复顺序应是：

```text
query operation status
  → confirmed success: commit result
  → confirmed failure: expose failure
  → confirmed cancelled: expose cancellation
  → still running: resume monitoring
  → unknown: ask user or enter manual recovery
```

### 7.4 扩展进程崩溃

本地子进程崩溃后，Host 需要区分：

- 调用尚未开始；
- 调用可能已开始；
- 结果已产生但传输失败；
- 后台任务仍由脱离的子进程运行。

只重启进程并重试，可能重复副作用。重启应与 operation 查询、幂等 key 和资源清理结合。

### 7.5 Host 崩溃后恢复

恢复需要重建的不是“Plugin 对象”，而是：

```text
extension version
admission decision
projection snapshot
environment binding
child process / connector
operation status
```

如果无法重建其中任何一项，应该降级为等待或人工确认，而不是假装恢复成功。

## 8. Session、Turn、Step 中的生命周期边界

### 8.1 Session 级扩展

Session 级扩展适合稳定能力，例如项目工具、固定 MCP Server 或长期 Connector。它需要：

- Session 配置快照；
- 版本固定或升级策略；
- 恢复时的重新 Admission；
- 连接和租约管理。

### 8.2 Turn 级扩展

Turn 级扩展适合按任务启用能力。其生命周期可以是：

```text
Turn start → discover → admit → project → execute → drain → end
```

Turn 结束不一定可以立即销毁扩展，如果它创建了后台进程或远程 operation。

### 8.3 Step 级扩展

Step 级扩展需要最强的一致性：每个 Step 都应知道使用了哪个能力集合和 Environment。优点是权限范围小，代价是注册、连接和缓存成本较高。

### 8.4 用户输入触发的变更

用户在 Tool approval、模型切换、切换工作目录或增加可信目录时改变的是 Runtime 条件，不应直接修改已经发出的模型请求。更稳妥的边界通常是：

```text
当前 Tool Call 完成/取消
  → 更新 Session/Turn 条件
  → 创建新的 Projection
  → 下一 Step 或下一 Turn 生效
```

具体边界取决于 Agent，但必须显式定义。

## 9. 各 Agent 的生命周期取舍

### 9.1 Codex：执行条件与 Step 生命周期结合

Codex 将权限、网络批准和 Environment 条件放在 Step 相关执行路径中。[^codex-step] [^codex-permissions] [^codex-network]

这适合在每个执行单元重新判断能力是否有效；代价是扩展必须适应明确的 Step 边界，无法只依靠全局 Plugin 状态。

### 9.2 Pi：Hook 生命周期短，宿主负责长期资源

Pi 的 preparation/execution hook 适合对单次 Tool Call 做扩展，但子进程、后台服务、Secret 和远程 operation 的长期生命周期更多由应用负责。[^pi-prepare] [^pi-execute] [^pi-env]

因此 Pi 的扩展模型容易组合，但如果宿主不补充 operation identity 和恢复记录，长期副作用很难收敛。

### 9.3 OpenCode：Session execution 需要 claim 和恢复

OpenCode 的 Workspace provider 与 durable execution claim 使扩展生命周期和 worker ownership 相关。[^opencode-workspace] [^opencode-execution]

当 worker 失效时，另一个 worker 是否可以接管扩展进程、远程连接和 operation，是服务化 Runtime 的核心恢复问题。

### 9.4 OpenHands：远程 sandbox 销毁不等于效果撤销

OpenHands 的远程 agent-server、sandbox 和 workspace 使扩展生命周期跨越本地 Agent 和远程服务。[^openhands-adapter]

销毁 sandbox 可以回收执行资源，但不一定撤销已创建的远程服务、artifact 或外部任务。因此恢复和清理需要服务端 operation identity。

### 9.5 Gemini CLI：本地策略变化与 Shell 执行分离

Gemini CLI 的 Policy Engine 和 shell execution 分层，扩展或动态上下文的变化需要在策略和实际命令执行之间保持一致。[^gemini-policy] [^gemini-shell]

如果策略更新只改变模型可见信息，却没有影响 Shell 层，撤销就只是 Context 变化而不是权限变化。

### 9.6 Kimi Code：Task persistence 使扩展状态进入恢复路径

Kimi Code 的 Task persistence 和 subagent metadata 使任务、分叉和恢复成为扩展生命周期的一部分。[^kimi-task] [^kimi-subagent]

重点是持久化是否包含扩展版本、Policy 和 Environment，而不只是消息和 Tool Result。

### 9.7 mini-SWE-agent：最小生命周期基线

mini-SWE-agent 的 LocalEnvironment 主要围绕命令执行和输出返回，没有复杂的扩展状态机。[^mini-local] [^mini-environment]

它适合作为基线：当能力固定、没有远程 operation、没有长期 Connector 时，恢复可以主要依赖 trajectory；一旦引入 Plugin 和远程副作用，trajectory 就不再足够。

## 10. 恢复记录的最小结构

建议扩展生命周期至少持久化：

```text
ExtensionRuntimeRecord {
  extension_id
  package_version
  capability_versions
  admission_state
  projection_ids
  environment_bindings
  connector_identity
  child_processes
  credential_bindings
  active_operations
  last_health
  disable_reason
  lease_expiry
  updated_at
}
```

### 10.1 为什么不能只保存配置

配置说明“下次可以如何加载”，但不说明“上次已经产生了什么”。恢复还需要知道：

- 哪些 Tool 已经进入模型请求；
- 哪个版本解释了参数；
- 哪些进程已经启动；
- 哪些操作可能已经发生；
- 哪个凭证已经被绑定；
- 哪个 workspace revision 被修改。

### 10.2 为什么不能只保存事件日志

事件日志能表达时间顺序，但恢复需要当前物化状态：扩展是否有效、连接是否存活、operation 是否完成、Environment 是否仍然存在。

更可靠的设计是：

```text
append-only lifecycle events
        +
current extension/runtime projection
        +
external operation reconciliation
```

## 11. 验证方案

### 11.1 Version switch

在一个 Session 中依次运行版本 A、切换版本 B，分别检查：

- 当前 Turn 是否继续使用 A；
- 新 Step 使用哪个版本；
- 旧 Tool Call 如何解释；
- Skill 文本何时变化；
- Policy 和 Secret 是否同步变化。

### 11.2 Partial initialization

在加载、认证、能力发现、Tool 注册、后台进程启动的每一步注入失败，记录：

- 已创建资源；
- 已注册能力；
- 是否自动回滚；
- 重启是否重复创建；
- Session 是否进入可恢复状态。

### 11.3 Mid-call crash

在本地 handler 执行前、执行中、产生副作用后、返回结果前杀死扩展进程。恢复时验证系统是否查询 operation，而不是无条件重试。

### 11.4 Disable and drain

在扩展有并发 Tool Call、后台进程和远程任务时禁用扩展，检查新调用是否停止、旧调用是否排空、后台资源是否清理、远程操作是否可查询。

### 11.5 Host restart

在 Session、Turn、Step 和远程 operation 的不同时间点重启 Host，验证 Projection、Environment、Connector 和 Operation 是否能够重建。

### 11.6 Lease expiry

让容器、临时 token、MCP 连接或远程 workspace 租约过期，观察 Runtime 是重新 provision、等待用户，还是错误地继续使用旧身份。

## 设计原则

### 原则一：扩展、调用和副作用分开建模

Plugin active、Tool Call completed 和外部 operation completed 是三个不同事实，不能用一个生命周期状态替代。

### 原则二：版本绑定执行事实

schema、Policy、Environment 和 Connector 版本必须随调用保存，避免恢复时用新实现解释旧请求。

### 原则三：撤销先阻止新能力，再收敛旧资源

Disable、Revoke、Drain 和 Unload 的语义不同；停止新调用不代表已有进程和远程副作用已经结束。

### 原则四：未知结果不得自动重试

如果副作用是否发生无法确认，Runtime 应查询、等待或请求人工处理，而不是把 timeout 当作安全失败。

### 原则五：恢复必须重建外部事实

配置和消息不足以恢复扩展；必须重新确认进程、连接、Environment、凭证、租约和 operation 状态。

## 未确认事项

- 各 Agent 是否真正保存扩展版本、Projection 和 Environment binding，需要固定版本源码逐项确认；
- 远程 MCP/Connector 的幂等和 operation reconciliation 能力，通常需要服务端和运行实验；
- 热更新在各 Agent 中的实际生效边界，不能仅由配置加载代码推断；
- 子进程退出后是否存在脱离的后台资源，需要操作系统级测试；
- 各 Agent 的错误 UI 是否准确区分 rejected、failed、timeout 和 unknown，需要交互实验验证。

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
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
