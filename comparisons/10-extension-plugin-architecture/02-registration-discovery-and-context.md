---
title: Coding Agent 的动态能力：注册、发现与 Context 投影
series: Coding Agent 的 Extension / Plugin Architecture
part: 2
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的动态能力：注册、发现与 Context 投影

## 结论

动态 Tool、Skill 或 MCP 能力不会因为被加入一个 Registry 就自动成为模型可用能力。中间至少存在四个不同阶段：

```text
Discovery       找到能力来源
Admission       判断是否允许进入当前 Runtime
Registration    保存能力及其元数据
Projection      决定当前模型请求看到什么
```

很多 Agent 把前两步和注册步骤合并，把“已发现”误认为“已启用”；另一些 Agent 把 Registry 内容直接转换成每次请求的 Tool schema，把“已注册”误认为“当前可调用”。这会造成三个问题：

1. 模型看到的能力与实际 Policy 不一致；
2. 当前 Turn 中途的能力变化无法定义生效边界；
3. 请求序列化发生变化时，无法判断是 Context 语义变化，还是 Provider 缓存复用变化。

因此，动态能力的核心不是“如何把 Tool 加入数组”，而是建立一个有时间边界的投影：

```text
Capability Registry
        ↓ policy / environment / task filter
Effective Capability Set
        ↓ request projection
Model-visible Tools / Skills / Resources
        ↓ model output
Runtime revalidation
        ↓
Execution
```

本文的一个重要边界是：本地 Runtime 可以确认请求中是否包含了 Tool schema 或 Skill 内容，但不能仅凭本地代码确认 Provider 服务端是否复用了 KV Cache。后者需要结合请求序列化、缓存键和运行实验判断。

## 1. Registry 保存什么

### 1.1 只有 name/handler 的 Registry 不够

最小 Registry 通常是：

```text
tools[name] = handler
```

这种结构适合单进程、静态、低风险的 Agent Loop，但无法支持可靠的扩展治理。至少需要保存：

```text
capability_id
kind                 tool / skill / resource / prompt / plugin
provider_id
provider_version
schema_or_content
source
trust_level
required_permissions
required_environment
visibility
lifecycle_owner
health
registered_at
effective_from
effective_until
```

这些字段不是为了让 Registry 变复杂，而是为了回答恢复和审计问题：

- 当前请求看到了哪个版本？
- 这个能力由哪个扩展提供？
- 它需要什么 Environment？
- 它为什么对当前 Session 可见？
- 它何时失效？
- 旧 Tool Call 是否还能执行？

### 1.2 能力身份与工具名称分离

Tool name 通常是给模型看的短标识，不适合作为长期身份。名称可能发生冲突、重命名或由不同 Server 提供。

更稳妥的身份关系是：

```text
capability_id = provider_id + provider_version + local_name
model_name    = projected alias
```

例如两个 MCP Server 都提供 `search`，模型侧可能需要通过命名空间暴露为 `github.search` 和 `linear.search`，Runtime 内部仍要保存各自的 provider identity。

如果只保存 `search`，恢复时无法判断旧调用对应哪个 Server；如果模型输出只携带短名称，Runtime 需要使用当时的 projection snapshot 进行解析，而不能依赖当前 Registry。

### 1.3 Registry 与 Effective Set

Registry 是候选能力全集；Effective Set 是当前 Runtime 实际允许使用的子集：

```text
effective = registry
           ∩ enabled_by_user
           ∩ compatible_with_model
           ∩ allowed_by_policy
           ∩ available_in_environment
           ∩ valid_for_task
```

这不是一次性的启动计算。Environment、权限批准、MCP 连接健康状态和任务类型都可能变化，所以 Runtime 需要明确重新计算的时机。

## 2. Discovery：能力从哪里来

### 2.1 静态内置能力

内置 Tool 通常在 Agent 启动时注册。优点是版本和实现与 Host 一致，缺点是无法独立升级，且容易让开发者忽略 Tool 的长期兼容性。

内置并不等于永远有效：Tool 仍可能依赖当前模型、当前权限或当前 Environment。

### 2.2 配置发现

扩展可以从用户配置、项目配置、workspace 文件或环境变量发现。配置发现需要区分：

```text
configuration exists
configuration is syntactically valid
configuration is enabled
configuration is trusted
configuration is authorized
```

尤其是 workspace 内的配置文件。它可能来自仓库、依赖包或 Prompt Injection，不应自动获得与用户配置相同的信任等级。

### 2.3 包和本地路径发现

从包管理器或本地路径发现 Plugin，会引入代码执行、依赖解析和版本漂移问题。Runtime 至少需要知道：

- 加载的是哪个绝对路径或包版本；
- 依赖是否锁定；
- 初始化发生在哪个进程；
- 加载失败是否阻止 Session；
- 后续启动是否得到同一个实现。

仅将 `import plugin` 放在启动代码中，会把发现、加载、执行和信任全部压缩在一个动作内。

### 2.4 MCP Discovery

MCP 的发现通常包括读取 Server 配置、建立连接、初始化协议、获取能力列表。Server 返回的能力列表不是永久事实：

- Server 可以升级；
- 连接可能切换到另一实例；
- Tool schema 可能变化；
- Resource 和 Prompt 可能新增或撤销；
- 远程身份可能变化。

因此 MCP discovery 应产生带版本和连接身份的 capability snapshot，而不是仅返回一个字符串到 Tool Registry。

### 2.5 延迟发现

按需连接或按需加载可以降低启动时间和 Context 成本，但把不确定性推迟到 Tool Call 阶段：

```text
模型先看到“可连接能力”
  → 用户或模型选择
  → Runtime 建立连接
  → 获取最新 schema
  → Policy 重新判断
  → 执行
```

此时模型最初看到的只能是能力目录或连接器描述，不能伪装成完整 Tool schema。否则模型生成的参数可能基于过期接口。

## 3. Admission：能力何时被 Runtime 接纳

### 3.1 Admission 不是用户开关

用户打开一个扩展，只表示它可以参与 Runtime，不表示当前所有 Session 和 Tool Call 都允许使用。

Admission 至少要检查：

- 扩展来源和身份；
- 版本和协议兼容性；
- 宿主支持的 capability 类型；
- Policy 是否允许；
- 当前 Environment 是否提供依赖；
- 所需 Secret 和 Network 是否可用；
- 是否需要用户批准；
- 是否与已有能力冲突。

Codex 将 permission profile、network approval 和 StepContext 关联到执行条件；这类结构体现的是“能力接纳后仍需在 Step 内重新满足环境和权限条件”，而不是单次注册后永久有效。[^codex-permissions] [^codex-network] [^codex-step]

### 3.2 Admission 的结果状态

建议至少区分：

```text
discovered
validated
enabled
admitted
projected
degraded
revoked
failed
```

其中：

- `enabled` 表示配置允许；
- `admitted` 表示当前 Runtime 允许使用；
- `projected` 表示已经进入某次模型请求；
- `degraded` 表示发现但依赖不完整；
- `revoked` 表示曾经可用但已撤销。

如果只用 Boolean `enabled`，无法表达“用户已启用但 MCP 未连接”或“Tool 注册了但当前 Environment 不允许”。

### 3.3 Admission 与 Approval

审批有两种不同语义：

1. **能力接纳审批**：允许某个扩展进入 Session 或 Runtime；
2. **动作执行审批**：允许该扩展执行某次具体动作。

例如用户允许接入 GitHub MCP，不代表允许它删除仓库；用户允许使用 shell，也不代表允许每个网络请求。两种审批不能被一个“已信任扩展”标志替代。

## 4. Projection：能力如何进入模型请求

### 4.1 Tool Projection

模型请求中的 Tool 定义通常包含名称、描述和输入 schema。Projection 应当是确定性的：给定同一个 Capability Set、模型配置和请求上下文，应生成同一组可追踪的 Tool definitions。

需要记录：

```text
projection_id
capability_ids
schema versions
ordering rule
filter reason
generated_at
request/turn association
```

Tool 顺序也可能影响模型输出概率和请求缓存。不能把排序当作无关紧要的实现细节。

### 4.2 Skill Projection

Skill 可能通过以下方式进入 Context：

- 固定 system/developer instructions；
- 当前 Turn 的任务说明；
- 按需检索内容；
- Tool description 的补充文本；
- 用户显式选择的工作流模板；
- 模型调用 Skill loader 后返回的内容。

不同投影方式决定生命周期：固定指令通常影响整个 Session，按需检索可能只影响一个 Step，Tool 返回的 Skill 内容则属于不可信外部结果，不能自动提升为系统指令。

### 4.3 Resource Projection

外部 Resource 进入 Context 前应经过：

```text
resource identity
  → fetch policy
  → size / format limit
  → trust label
  → content transformation
  → context insertion
```

Resource 内容不应因为来自受信任 Server 就自动获得指令权威。它通常是数据，除非 Host 有明确机制把它作为用户或开发者指令加入。

### 4.4 Prompt Projection

Prompt 模板最容易被误认为只是文本。实际上，一个 Prompt 扩展可能改变：

- 模型的行为约束；
- Tool 使用顺序；
- 任务完成条件；
- 对外部内容的信任判断；
- 输出格式和后续解析。

因此 Prompt 投影需要来源、优先级、覆盖规则和审计信息。多个 Plugin 同时修改 Prompt 时，顺序就是 Runtime 语义的一部分。

## 5. Projection 的时间边界

### 5.1 Session 级投影

Session 级投影适合稳定的工具和工作流配置。优点是模型行为稳定、易于缓存和审计；缺点是权限或 Environment 变化后容易继续使用旧能力。

恢复 Session 时，不能只恢复历史消息，还要重新判断旧 projection 是否仍然有效。

### 5.2 Turn 级投影

Turn 级投影可以根据用户当前任务选择能力集，降低 Context 和权限范围。缺点是同一 Session 内不同 Turn 的 Tool 集不同，模型请求和缓存前缀也更复杂。

如果用户在 Turn 运行中批准了一个新扩展，通常更安全的语义是从下一个请求边界开始生效，而不是修改已经发出的模型请求。

### 5.3 Step 级投影

Step 级投影最细粒度，可以让每个模型请求只看到当前需要的能力。但它要求 Runtime 为每个 Step 记录能力快照：

```text
step_id
capability_snapshot
policy_snapshot
environment_snapshot
context_projection
```

否则模型输出的 Tool Call 无法与生成时看到的 schema 对齐。

### 5.4 Tool Call 级发现

Tool Call 级发现适合动态远程资源，但会引入一个特殊问题：模型决定调用的能力，可能在它产生参数后才完成加载。Runtime 需要把连接和 schema 获取作为执行前阶段，并在参数验证失败时返回结构化错误，而不是把它伪装成业务失败。

## 6. Context、请求序列化与 KV Cache

### 6.1 三个容易混淆的层次

讨论动态 Tool 对缓存的影响时，必须分开：

```text
Runtime Context
  → 请求结构化对象
  → Provider 请求序列化
  → Provider tokenizer / prefix cache / KV cache
```

本地 Context 变化，不必然等于 Provider 端 KV Cache 一定失效；但只要请求序列化中对应前缀发生变化，缓存命中就可能受影响。

### 6.2 Tool schema 通常属于请求输入的一部分

对于支持原生 Tool Calling 的 Provider，Tool schema 往往作为请求字段传递，而不是普通聊天消息。它仍可能参与请求签名、token 计费、服务端前缀缓存或内部编译，但具体行为由 Provider 实现决定。

因此应区分以下事实：

- schema 是否被发送：可从客户端请求构造确认；
- schema 是否被 tokenization：需要 Provider 语义或实验确认；
- schema 变化是否改变缓存键：需要 Provider 文档或实验确认；
- 缓存是否实际命中：需要服务端指标或响应观测确认。

### 6.3 稳定前缀与动态后缀

一种常见优化是：

```text
stable system instructions
stable tool definitions
dynamic task context
dynamic tool results
```

但这只有在动态能力集合确实稳定、请求构造顺序固定时才成立。如果每次请求都重新排序 Tool、加入时间戳、插入连接状态或改变 schema 描述，稳定前缀就会缩短。

### 6.4 动态 Tool 的三种缓存策略

#### 策略 A：每次请求全量投影

每个请求重新生成全部 Tool definitions。语义最简单，能力变化最及时，但请求体和缓存前缀可能频繁变化。

#### 策略 B：Session 级固定投影

Session 开始时确定 Tool 集，后续只允许在下一个 Session 或显式重建边界变化。缓存和审计更稳定，但不适合临时能力和动态权限。

#### 策略 C：基础能力加动态增量

把常驻 Tool 放在稳定集合，临时 Tool 单独作为动态部分。这样可以减少基础前缀变化，但需要 Provider 支持或 Runtime 自己维护清晰的请求语义。

不能仅凭“使用了动态 Registry”推断采用了哪种策略，必须检查请求构造和 Turn/Step 生命周期。

## 7. 动态能力变化与已有模型输出

### 7.1 Schema stale

模型在请求 `t0` 看到 Tool schema `S1`，在 `t1` 产生调用；此时 Registry 已经变为 `S2`：

```text
S1 → model output → S2
```

Runtime 需要选择：

- 用 `S1` 验证并执行；
- 用 `S2` 验证，失败则返回 schema stale；
- 重新生成模型请求；
- 暂停并要求用户确认。

对于有副作用的 Tool，直接使用当前 `S2` 解释旧参数是危险的，因为同名字段可能已经改变含义。

### 7.2 Permission stale

模型看到 Tool 时用户已批准，但执行时权限被撤销：

```text
visible at generation time
≠ authorized at execution time
```

安全默认应是重新检查并拒绝旧批准，除非批准明确绑定到能力版本、Scope 和有效期。

### 7.3 Environment stale

Tool schema 仍然有效，但 Workspace、Network 或远程 Session 已变化。此时参数可以通过 schema 校验，却不应直接执行。

StepContext、Workspace identity、MCP connection identity 和 credential binding 都应参与执行前检查。Codex 将 Environment 条件放入 StepContext，是处理这类 stale execution 的一种结构化方式。[^codex-step]

## 8. 各 Agent 的动态能力取舍

### 8.1 Codex：以 Step/Policy 约束投影有效期

Codex 的权限配置和 network approval 与 Step 关联，说明能力能否执行并不是模型请求构造的一次性结果。[^codex-permissions] [^codex-network]

其主要取舍是：能力需要适配既有 Step、Tool Router 和 Environment 约束，扩展自由度较低，但旧请求和当前权限之间的边界更容易明确。

### 8.2 Pi：Tool hook 适合应用侧按需投影

Pi 的 preparation hook 可以在执行前检查或改变调用，execution hook 负责实际执行前后逻辑。[^pi-prepare] [^pi-execute]

这种结构适合应用自行实现动态 Tool 和 Skill，但如果应用没有保存 projection snapshot，hook 很容易只看到当前 Registry，而不是模型生成时看到的能力集合。

### 8.3 OpenCode：Workspace 与执行层影响有效能力集

OpenCode 的 Workspace provider 和 Session execution 分开，意味着“能力是否存在”和“当前执行 worker 能否使用”可以分离。[^opencode-workspace] [^opencode-execution]

服务化架构需要把 projection 与 worker claim 绑定，否则一个 Session 看到的 Tool 可能被另一个 Environment 执行。

### 8.4 Gemini CLI：Policy 和 SessionContext 共同决定可见性

Gemini CLI 的 Policy Engine、shell execution 和 SessionContext 位于不同模块。[^gemini-policy] [^gemini-shell] [^gemini-context]

因此分析动态扩展时，不能只看 SDK 返回了哪些 Tool，还要检查 Policy 是否在执行阶段重新评估，以及 SessionContext 是否记录了能力变化。

### 8.5 Kimi Code：能力与 Task/Subagent 上下文一起传播

Kimi Code 将 Tool Policy、Task 持久化和 Subagent context 结合，动态能力可能随着任务分叉进入子 Agent。[^kimi-policy] [^kimi-task] [^kimi-subagent]

关键问题是子 Agent 获得的是原始 Registry、父 Agent 的 Effective Set，还是经过新的 Projection。这个差别决定了权限是否会随上下文复制而扩大。

### 8.6 OpenHands：远程能力的 Projection 需要连接身份

OpenHands 的 sandbox、workspace 和 agent-server context 说明，远程能力的可见性不能脱离 Session、service URL 和 Environment identity。[^openhands-adapter]

同一个 Tool schema 可能在不同 sandbox 或远程服务上具有不同语义，因此 projection 需要绑定执行环境，而不是只绑定 Session。

### 8.7 mini-SWE-agent：没有动态能力平面的最小基线

mini-SWE-agent 的 LocalEnvironment 主要负责执行命令和返回输出，能力集相对固定。[^mini-local] [^mini-environment]

它没有复杂的动态 Projection，却提供一个重要基线：如果 Tool 集固定，很多 stale schema 和 KV Cache 问题根本不会出现；复杂 Runtime 的成本来自能力动态化后必须维护更多一致性状态。

## 9. 运行时应保存的快照

如果 Agent 支持动态能力，至少应在模型请求和 Tool 执行之间保存：

```text
RequestProjectionSnapshot {
  projection_id
  session_id
  turn_id
  step_id
  capability_ids
  provider_versions
  tool_schemas
  skill_sources
  resource_trust_labels
  policy_version
  environment_id
  created_at
}
```

Tool Call 解析时应优先使用对应的 projection snapshot，而不是重新从全局 Registry 查询。全局 Registry 适合发现当前状态，snapshot 负责解释历史请求。

### 9.1 为什么不能只保存消息

如果持久化只有：

```text
assistant: call github.search({ ... })
```

恢复器无法知道：

- 当时的 `github.search` 是哪个 provider 提供；
- schema 是否与当前版本相同；
- 当时是否已经批准；
- 调用使用哪个 Environment；
- Resource 内容是否被加入 Context；
- 结果是否来自真实调用还是重放。

动态能力使 Tool schema、Provider identity 和 Policy 成为执行事实的一部分，而不是仅仅是配置。

## 10. 验证方案

### 10.1 注册时机实验

分别在启动、Session 创建、Turn 开始、Step 开始和 Tool Call 前注册同一个 Tool，记录它首次出现在模型请求中的边界。

观察：

- 是否进入当前请求；
- 是否影响后续请求；
- 是否可以在当前 Step 中使用；
- 是否需要重新发起模型请求；
- 是否写入持久化状态。

### 10.2 Stale schema 实验

先让模型看到 `schema-v1`，再替换为 `schema-v2`，提交符合 v1 但不符合 v2 的参数。

需要区分：

- Runtime 使用 v1 执行；
- Runtime 拒绝为 stale；
- Runtime 按 v2 解析；
- Runtime 自动重试。

### 10.3 Context 投影实验

分别加入 Tool schema、Skill instructions、MCP Resource 和 Prompt，抓取实际 Provider 请求，比较：

- 内容进入哪个字段；
- 是否每个请求重复发送；
- 顺序是否稳定；
- 是否有裁剪或摘要；
- Tool Result 是否被标记为外部内容。

### 10.4 KV Cache 相关实验

在相同模型、相同系统指令和相同基础 Tool 集下，依次：

1. 保持 Tool 顺序不变；
2. 改变 Tool 顺序；
3. 增加一个 Tool；
4. 修改 Tool description；
5. 修改 schema 的非语义字段；
6. 改变 Skill 文本；
7. 改变 Tool Result。

只有在 Provider 暴露缓存命中、延迟或 token 统计时，才能对服务端缓存做有效结论。否则只能报告请求输入发生了变化，不能声称 KV Cache 一定失效。

### 10.5 恢复实验

在 Tool 已注册、已进入 Context、模型已生成调用但尚未执行、远程调用已发出四个时点分别中断并恢复。检查恢复器使用的是：

- 当前 Registry；
- 历史 Projection Snapshot；
- 当前 Policy；
- 历史 Environment；
- 重新发现的 MCP capability。

## 设计原则

### 原则一：候选能力与有效能力分离

Registry 保存候选能力，Effective Set 才代表当前 Runtime 允许使用的能力。

### 原则二：模型请求必须绑定能力快照

模型看到的 Tool、Skill、Resource 和 Prompt 应能追溯到具体 Projection；旧输出不能直接依赖变化后的全局 Registry。

### 原则三：能力变化在明确边界生效

注册、禁用、升级和断线应在 Session、Turn、Step 或 Tool Call 之一明确生效，不能依赖隐含的并发时序。

### 原则四：Context 变化与缓存结论分开验证

本地请求内容变化可以从客户端确认；Provider 侧 KV Cache 是否命中必须通过官方语义或运行实验确认。

### 原则五：动态能力必须可重放

持久化的不只是 Tool Call，还应包括 provider、schema、Policy、Environment 和 projection identity，使恢复和审计能够重建当时的执行条件。

## 未确认事项

- 各 Agent 是否在请求中发送完整 Tool schema，还是由 Provider/Connector 侧处理，需要抓取具体 Provider 请求；
- 各 Provider 如何计算 Tool schema、Skill 内容与 prefix cache 的关系，不能从 Agent 客户端源码确定；
- MCP Server 的能力列表变化是否触发当前 Session 的重新 Projection，需要运行时连接测试；
- 各 Agent 恢复时是否保存 Projection Snapshot，现有公开源码证据仍不足；
- 子 Agent 是继承父 Agent 的 Effective Set 还是重新 Admission，需要结合更多版本和运行实验确认。

## 参考源码

[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^gemini-context]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
