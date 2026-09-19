---
title: Coding Agent 的 Capability Plane：从工具注册到可治理能力
series: Coding Agent 的 Extension / Plugin Architecture
part: 5
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Capability Plane：从工具注册到可治理能力

## 结论

Capability Plane 不是一个新的 `ToolRegistry` 类，也不是把所有 Tool 放进一个更大的目录。它表示 Runtime 已经把“能力”当作独立的治理对象来处理：能力有身份、有来源、有版本、有权限、有 Environment、有生命周期，并且能被投影到模型请求、执行到外部资源、记录到审计和恢复状态。

可以用一个判据判断 Agent 是否已经形成 Capability Plane：

> 如果 Runtime 能够独立回答“当前请求可见哪些能力、这些能力为什么可见、在哪里执行、由谁批准、失败后如何撤销和恢复”，那么它已经超出了简单 Tool Registry，接近 Capability Plane。

Capability Plane 的最小结构是：

```text
Discovery
    ↓
Admission / Policy
    ↓
Effective Capability Set
    ↓
Projection to Model
    ↓
Execution in Environment
    ↓
Observation / Persistence / Recovery
```

它连接了此前几个专题中的关键边界：

- 与 Context 的关系：决定能力如何进入模型请求；
- 与 Environment 的关系：决定能力在哪里执行；
- 与 Security 的关系：决定能力如何被授权和限制；
- 与 State 的关系：决定能力变化如何持久化和恢复；
- 与 Observability 的关系：决定一次调用能否被追踪和归因。

## 1. 从 Tool Registry 到 Capability Plane

### 1.1 Tool Registry 的能力边界

一个传统 Tool Registry 通常负责：

```text
register(name, schema, handler)
lookup(name)
call(name, arguments)
```

它能解决单进程 Agent Loop 的基本问题，但无法独立表达：

- Tool 来自哪个 Plugin 或 MCP Server；
- 该 Tool 需要什么权限；
- 它绑定哪个 Workspace 和 Network；
- 模型当前是否看到它；
- schema 是否已过期；
- 调用失败后外部副作用是否存在；
- 子 Agent 是否可以继承它。

### 1.2 Capability Plane 增加了治理维度

Capability Plane 至少把以下对象联系起来：

```text
Capability
Provider
Policy
Approval
Environment
Projection
Operation
Observation
```

它的核心不是“更多字段”，而是责任关系发生了变化：Tool 不再是孤立函数，而是一个需要被 Runtime admission、projection、execution 和 recovery 的实体。

### 1.3 Capability 是动作，不只是接口

一个 API schema 只能描述输入输出；Capability 还应描述：

```text
can_read
can_write
can_delete
can_execute
can_network
can_use_secret
can_spawn_process
can_create_remote_resource
```

两个输入输出相同的 Tool，可能因为 Environment 和身份不同而代表不同 Capability。`create_issue` 使用只读 token 和使用管理员 token，不是同一个安全能力。

## 2. Capability Plane 的七个子面

### 2.1 Discovery Plane

负责发现能力来源：内置代码、配置、Plugin、MCP Server、Skill、远程目录或子 Agent。

Discovery 的输出不是“Tool 列表”，而应是带来源、版本和信任信息的候选 Capability。

### 2.2 Admission Plane

负责判断能力能否进入当前 Runtime：

- 来源是否可信；
- 版本是否兼容；
- 用户是否启用；
- Policy 是否允许；
- Environment 是否满足；
- 依赖和身份是否可用。

Admission 不等于当前调用批准。它是“能力可以参与”，不是“任意动作都可以执行”。

### 2.3 Policy Plane

负责将 capability、scope、主体和资源组合为决策：

```text
principal + capability + resource + operation + environment
```

Policy 需要可以在 Tool Call 前重新评估，不能只在启动时执行一次。

Codex 的 permission profile、network approval、StepContext 体现了 Policy 与执行条件的结合；Gemini CLI 则将 policy engine 与 shell execution 分层。[^codex-permissions] [^codex-network] [^codex-step] [^gemini-policy] [^gemini-shell]

### 2.4 Projection Plane

负责决定哪些能力进入当前模型请求，以及以什么形态进入：

```text
Tool schema
Skill instruction
Resource
Prompt template
Capability summary
```

Projection 是模型可见世界的边界。一个能力已 admitted，但没有 projected，不代表模型当前可以调用它；一个能力曾经 projected，也不代表执行时仍然 authorized。

### 2.5 Execution Plane

负责把模型请求转换成实际操作，绑定：

- Environment；
- process/connector；
- credential；
- network；
- timeout；
- cancellation；
- operation identity。

OpenCode 将 Tool、Workspace provider 和 Session execution 分开，说明 Execution Plane 不能被 Tool Registry 代替。[^opencode-tools] [^opencode-workspace] [^opencode-execution]

### 2.6 Lifecycle Plane

负责能力的启用、升级、降级、撤销、排空和卸载。它处理的不是单次 Tool Call，而是能力提供者、连接和后台资源的长期状态。

### 2.7 Evidence Plane

负责记录：

- 能力来自哪里；
- 哪个版本进入了请求；
- 哪个 Policy 做了决定；
- 使用了哪个 Environment；
- 产生了哪个 Operation；
- 结果是否已确认；
- 恢复时依据了哪些事实。

没有 Evidence Plane，Capability Plane 只能运行，不能审计、评估和可靠恢复。

## 3. Capability 的统一数据模型

### 3.1 Capability descriptor

一个可治理的 Capability Descriptor 可以抽象为：

```text
CapabilityDescriptor {
  capability_id
  kind                  tool / skill / resource / prompt
  provider_id
  provider_version
  schema_version
  description
  input_schema
  output_contract
  side_effect_class
  required_permissions
  required_environment
  trust_level
  lifecycle_owner
  source
  health
}
```

### 3.2 Effective capability

当前请求的有效能力还需要叠加运行条件：

```text
EffectiveCapability {
  descriptor
  policy_decision
  approval_scope
  environment_binding
  visible_to_model
  executable_now
  expires_at
  projection_id
}
```

`visible_to_model` 与 `executable_now` 必须分开。模型可能看到一个 Tool，但在执行时因为网络审批、Workspace 变化或租约过期而被拒绝。

### 3.3 Capability snapshot

每次模型请求都应拥有一个能力快照：

```text
CapabilitySnapshot {
  snapshot_id
  session_id
  turn_id
  step_id
  effective_capabilities
  policy_version
  environment_id
  projection_hash
  created_at
}
```

它解决两个问题：

1. 解释模型当时为什么生成这个 Tool Call；
2. 恢复时避免使用变化后的全局 Registry 误解旧请求。

## 4. Capability Plane 与模型 Context

### 4.1 Context 不是 Capability Plane

模型 Context 只能表示模型当前可见的信息，不表示 Runtime 当前允许的全部能力。将所有能力都写入 Context 会带来：

- Context 膨胀；
- Tool 选择噪声；
- 高风险能力过度暴露；
- Prompt Injection 可见范围扩大；
- Tool schema 变化导致请求和缓存不稳定。

Capability Plane 应按任务、权限、Environment 和模型能力生成最小 Projection。

### 4.2 Projection 的最小性

最小 Projection 不等于只保留最少 Tool 数量。它还要考虑：

- Skill 是否解释了 Tool 的使用条件；
- Resource 是否是当前任务必要事实；
- Tool 是否依赖当前 workspace；
- 能力是否会造成高风险误用；
- 结果是否可以被模型正确理解。

一个 Tool 如果没有足够描述，模型可能误用；如果描述过多，Context 和缓存成本增加。Projection 是能力可用性与模型负担之间的控制面。

### 4.3 Context 变化与 KV Cache

Capability Plane 只能控制请求投影，不能直接决定 Provider 侧 KV Cache。需要区分：

```text
Capability set changes
  → projection changes
  → serialized request may change
  → provider cache behavior may change
```

前两步可以由 Agent Runtime 观察；最后一步需要 Provider 语义或实验确认。Capability Plane 应记录 projection hash 和请求边界，方便后续分析，但不能把缓存命中假设写成架构事实。

## 5. Capability Plane 与 Environment

### 5.1 同一 Capability 的不同实例

```text
capability: deploy
environment A: staging + test credential
environment B: production + admin credential
```

这两个实例不能共享同一个无条件批准。Capability 的真正对象应是：

```text
capability × scope × environment × principal
```

### 5.2 Environment binding

Capability Plane 至少要知道：

- workspace identity 和 revision；
- process identity；
- network policy；
- credential binding；
- resource limits；
- remote endpoint；
- lease 和 expiry。

OpenHands 的 agent-server context、workspace 和 sandbox 分离，正好体现了 Capability 执行不能脱离 Environment identity。[^openhands-adapter]

### 5.3 子 Agent 的能力投影

对子 Agent，安全默认应是：

```text
child_effective_set ⊆ parent_effective_set
```

但子集还需要受新 Environment 限制。复制父 Agent 的 Skill、消息或 Tool schema，不足以完成这个约束。Kimi Code 的 Task persistence 和 subagent metadata 是研究能力传播的重要状态入口。[^kimi-task] [^kimi-subagent]

## 6. Capability Plane 与 Policy

### 6.1 Policy 的输入

Policy 不应只接收 `tool_name`，而应接收：

```text
principal
capability_id
provider_id/version
arguments
resource scope
environment
approval
time / expiry
```

### 6.2 Policy 的输出

最小输出至少包括：

```text
allow
deny
ask
allow_with_scope
allow_once
allow_until
degraded
```

同时需要记录理由和匹配规则，否则无法解释为什么某个 Tool 在一个 Turn 中可用、在下一个 Turn 中不可用。

### 6.3 Approval 是 Policy 的一个输入

Approval 不是独立于 Policy 的 UI 事件。它应绑定：

```text
approval_id
principal
capability_id
scope
environment_id
expires_at
decision_source
```

“用户批准使用 GitHub”范围过宽；“用户批准在当前 Session 对当前仓库创建 issue”才具有可验证的边界。

## 7. Capability Plane 与状态恢复

### 7.1 需要恢复的不是 Tool 列表

恢复需要重建：

```text
candidate capabilities
admission decisions
projection snapshots
environment bindings
connector/process state
active operations
```

只恢复历史消息和 Tool Result，会丢失能力解释所需的上下文。

### 7.2 三种恢复场景

#### 能力未变

可以验证 snapshot 与当前 descriptor、Policy 和 Environment 一致后继续。

#### 能力实现变更

旧 Tool Call 不能直接交给新 schema，应重放、拒绝或人工确认。

#### 能力已撤销

新调用必须停止；已有 operation 需要查询状态，不能因为 capability record 消失就假设副作用不存在。

### 7.3 Capability 变化是状态事件

以下事件都应成为显式事实：

```text
capability_discovered
capability_admitted
capability_projected
capability_revoked
capability_version_changed
environment_binding_changed
operation_reconciled
```

这样可以区分“从未存在”与“曾经存在后被撤销”，也能支持后续的 Observability 和 Evaluation。

## 8. Capability Plane 与扩展类型

### 8.1 Skill 进入 Projection Plane

Skill 通常没有直接 Execution，但会改变模型对 Capability 的选择和组合。它应带有：

- source；
- trust level；
- scope；
- version；
- context budget；
- effective boundary。

### 8.2 Tool 进入 Execution Plane

Tool 是模型可请求的动作接口，但其执行还需要 Policy 和 Environment。Tool Registry 是 Tool 的登记入口，不是 Capability Plane 的全部。

### 8.3 Plugin 进入 Lifecycle Plane

Plugin 可以改变 Registry、Projection、Policy hook、Event 和持久化，因此需要更高层的 admission 和 lifecycle 控制。

### 8.4 MCP 贯穿多个子面

MCP Server 同时影响：

- Discovery：发现远程能力；
- Admission：判断是否允许连接；
- Projection：暴露 Tool/Resource/Prompt；
- Execution：跨进程或跨网络调用；
- Lifecycle：连接、重连、升级和断开；
- Evidence：记录远程身份和 operation。

这也是 MCP 不能被简单当作“远程函数调用”的原因。

## 9. 各 Agent 是否形成 Capability Plane

以下判断只基于固定版本源码中的责任位置，不等同于完整部署能力。

### 9.1 Codex：最接近显式的执行能力平面

Codex 将 Tool Router、Permission profile、Network approval 和 StepContext 放在执行链中，能力是否可用与具体 Step、Policy 和 Environment 条件关联。[^codex-step] [^codex-permissions] [^codex-network]

它的 Capability Plane 特征是执行约束明确、审批产品化、Environment 条件进入执行上下文。其代价是扩展必须服从既有 Harness，不容易以任意 Plugin 形式绕过执行边界。

### 9.2 Pi：Capability Plane 主要由宿主应用组装

Pi 提供 Tool preparation、execution hook 和 Node Environment，但没有强制要求宿主建立完整的能力 Admission、Projection Snapshot 和远程 operation 管理。[^pi-prepare] [^pi-execute] [^pi-env]

因此 Pi 更像可组合的能力构建底座：它提供插入点，是否形成 Capability Plane 取决于应用层如何组合。

### 9.3 OpenCode：服务化执行推动能力平面显式化

OpenCode 将 Tool、Workspace provider、Session execution 和 claim 分层，具备将 Capability 与 Worker、Workspace 和长期执行绑定的结构。[^opencode-tools] [^opencode-workspace] [^opencode-execution]

其主要挑战是跨 worker、远程 workspace 和扩展版本的一致性；Capability Plane 不能只存在于单个 API worker 的内存中。

### 9.4 Gemini CLI：Policy 与 Shell 构成局部能力平面

Gemini CLI 具备 Policy Engine、SessionContext 和 Shell execution 的分层。[^gemini-policy] [^gemini-shell] [^gemini-context]

它已经超出简单 Tool Registry，但 Capability Plane 是否覆盖 MCP、Skill、远程资源和恢复状态，需要继续结合扩展和 Session 实现确认。

### 9.5 OpenHands：Environment/Service 驱动的能力平面

OpenHands 的远程 sandbox、workspace、agent-server 和 service context 使 Capability 与 Environment 绑定更明显。[^openhands-adapter]

它的 Capability Plane 重点不是本地 Tool Registry，而是如何把 Agent 意图映射到远程可 provision、可销毁、可追踪的执行资源。

### 9.6 Kimi Code：任务和子 Agent 推动能力传播模型

Kimi Code 的 permission gate、tool policy、Task persistence 和 subagent metadata 形成了能力传播的骨架。[^kimi-permission] [^kimi-policy] [^kimi-task] [^kimi-subagent]

其关键判断点是：Task fork 是否生成新的 Effective Set，还是只复制父上下文。前者接近能力平面，后者更接近上下文复制。

### 9.7 mini-SWE-agent：有执行接口，没有完整能力平面

mini-SWE-agent 的 Environment protocol 和 LocalEnvironment 足以支持最小执行闭环，但没有复杂的 Admission、Projection、Lifecycle 和远程 operation 结构。[^mini-environment] [^mini-local]

它是重要基线：一个 Agent 可以有 Tool/Environment 而没有 Capability Plane；Capability Plane 是复杂 Runtime 为了治理动态能力而增加的结构，不是所有 Agent 的必需层。

## 10. 设计选择的代价

### 10.1 能力平面越显式，状态越多

新增 Capability Descriptor、Snapshot、Admission、Environment Binding 和 Operation Record，会提高一致性和恢复能力，也增加：

- 持久化成本；
- 状态迁移成本；
- 版本兼容复杂度；
- 调试和 UI 展示成本；
- Worker 协调成本。

### 10.2 全局注册简单，但动态场景脆弱

全局 Registry 适合单进程和固定 Tool 集；面对多 Session、子 Agent、远程 Connector 和热更新时，容易出现：

- 旧调用使用新 schema；
- 权限变化不能及时生效；
- 子 Agent 获得过多能力；
- 恢复无法解释历史请求；
- 缓存和请求边界不稳定。

### 10.3 每 Step 重建能力安全，但成本高

Step 级 Admission 和 Projection 能缩小权限和 Context，但连接、schema 获取、Policy 评估和缓存构造都可能重复执行。实际系统通常需要在 Session/Turn 稳定性与 Step 级安全之间取平衡。

## 11. 验证方案

### 11.1 Registry 与 Effective Set

创建一个已注册但不满足当前 Environment 的 Tool，确认它是否会进入模型请求；再改变 Network 或 Workspace 条件，确认 Effective Set 是否更新。

### 11.2 Policy 与 Projection

让一个 Tool 被 Registry 注册、被 Policy 允许、但被当前用户禁用，观察它是否仍进入 Context。再撤销审批，验证已有 Tool Call 如何处理。

### 11.3 Environment binding

使用相同 Tool name 绑定两个不同 workspace、credential 和 network scope，确认 Runtime 是否将它们视为不同执行能力。

### 11.4 Version and recovery

在模型看到 schema-v1 后升级到 schema-v2，重启并恢复旧 Tool Call，观察系统是否使用 projection snapshot、拒绝 stale call 或错误使用当前 Registry。

### 11.5 Child capability set

对父 Agent 和子 Agent 分别记录 Effective Set，验证：

```text
child_effective_set ⊆ parent_effective_set
```

并单独检查 Secret、Network、Workspace write 和远程 operation ownership，而不是只比较 Tool 名称。

### 11.6 Evidence completeness

选取一次有副作用的调用，尝试从记录中还原：

- 能力来源和版本；
- 模型看到的 schema；
- Policy 和 Approval；
- Environment identity；
- Connector/process；
- Operation status；
- 最终结果。

无法还原的字段就是 Capability Plane 的证据缺口。

## 设计原则

### 原则一：Capability 是治理对象，不是函数名

能力必须有身份、来源、版本、权限、Environment 和生命周期，不能只由 Tool name 标识。

### 原则二：模型可见、Runtime 可用、Environment 可执行分离

Projection、Policy 和 Environment 分别解决不同问题；任何一层都不能替代其他两层。

### 原则三：扩展能力以快照进入请求

模型请求和 Tool Call 应绑定 Capability Snapshot，避免动态 Registry 变化后重新解释旧输出。

### 原则四：能力变化必须进入状态和证据

发现、接纳、投影、撤销、版本变化和 Environment 变化都应成为可追踪事实。

### 原则五：能力平面必须服务于恢复

如果能力模型不能帮助 Runtime 在崩溃、断线、取消和版本升级后重建执行条件，它只是更复杂的注册表，而不是可治理的 Capability Plane。

## 未确认事项

- 各 Agent 是否拥有完整、独立的 Capability Plane，需要继续阅读其 Plugin/MCP/Skill 注册和持久化实现；
- Provider 侧 Tool schema 与 KV Cache 的关系仍需运行实验；
- 远程 Connector 的 operation、租约和取消语义通常需要服务端证据；
- 子 Agent 能力集合是否严格为父 Agent 子集，需要在真实运行环境中测试；
- Capability Plane 与 Observability 的交界将在下一个专题中进一步研究。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^gemini-context]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
