---
title: Coding Agent 的扩展模型：Tool、Skill、Plugin 与 MCP 的责任边界
series: Coding Agent 的 Extension / Plugin Architecture
part: 1
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的扩展模型：Tool、Skill、Plugin 与 MCP 的责任边界

## 结论

Coding Agent 的扩展机制不能按名称分类。`Tool`、`Skill`、`Plugin` 和 `MCP` 经常被放在同一个“扩展”目录下，但它们改变 Runtime 的方式不同：

| 机制 | 主要改变 | 典型边界 | 是否直接执行副作用 |
| --- | --- | --- | --- |
| Tool | 模型可请求的动作接口 | Tool Registry / Tool Call | 通常是 |
| Skill | 模型解决任务时可使用的知识、流程和约束 | Context / Prompt | 通常不是 |
| Plugin | Agent 的代码、配置或生命周期 | Host Runtime / Extension Runtime | 取决于插件内容 |
| MCP | 外部能力的协议化连接 | Connector / Client / Server | 通常是 |

这四者的共同点是“改变 Agent 可完成的任务集合”，但责任位置不同：

```text
Skill     → 改变模型如何理解和规划
Tool      → 改变模型可以请求什么动作
Plugin    → 改变 Runtime 如何组织和实现能力
MCP       → 改变能力如何跨进程、跨服务被发现和调用
```

因此，判断一个扩展设计是否成熟，不能只问“能不能注册一个工具”，而要追踪完整链路：

```text
source/config
  → discover
  → validate
  → register
  → expose to model
  → authorize
  → execute
  → observe result
  → persist/recover
```

如果扩展只实现了 `register` 和 `execute`，却没有定义权限、进程边界、失败和恢复，它只是一个能力注入点，还不是完整的 Runtime 扩展模型。

## 1. 为什么“扩展”不是一个概念

### 1.1 能力、知识和实现是三个不同问题

扩展通常同时包含三类内容：

1. **能力（capability）**：可以执行某种动作，例如读数据库、创建 PR、运行浏览器；
2. **知识（instruction/knowledge）**：告诉模型什么时候使用、如何组合、有哪些限制；
3. **实现（implementation）**：负责参数校验、认证、执行、重试和结果转换。

把三者混在一起会导致几个典型问题：

- 一个 Skill 被误认为拥有执行权限；
- 一个 Tool schema 被误认为已经完成了授权；
- 一个 Plugin 被认为只是提示词文件，实际上它可以改写 Runtime 行为；
- 一个 MCP server 被认为只是远程 Tool，实际上它还可能暴露 Resource、Prompt 和初始化能力。

成熟的 Runtime 会把“模型可见”“模型可请求”“Runtime 可执行”“Environment 允许执行”分开处理。

### 1.2 扩展至少有四条进入路径

扩展可以在不同时间进入 Runtime：

```text
启动时       → 进程级能力
Session 创建 → Session 级能力和配置
Turn 开始    → 当前任务级能力
Tool Call 时 → 延迟发现或按需连接能力
```

这四条路径的语义不同。

- 启动时加载的扩展通常影响整个进程，适合静态配置，但隔离较弱；
- Session 级扩展需要跟随会话恢复和多 worker 路由；
- Turn 级扩展需要定义当前 Turn 的请求快照；
- Tool Call 时发现的能力需要处理 schema 变化、权限重新确认和模型上下文过期。

因此，“支持动态 Tool”并不只意味着一个 Map 可以在运行时追加字段，而意味着 Runtime 要定义能力变化何时生效。

## 2. Tool：模型可请求的动作接口

### 2.1 Tool 的最小组成

一个可被模型调用的 Tool 至少包含：

```text
name
description
input schema
call handler
result shape
error semantics
permission semantics
```

其中只有前四项通常能让一次演示运行起来。真正决定生产行为的是后面三项：

- 返回结果是事实、日志、错误还是建议；
- 失败是让模型继续、暂停、重试还是结束 Turn；
- 调用是否需要用户批准、网络批准或 Environment 检查。

OpenCode 将 Tool responsibility 与 Session execution 分开；Codex 则把 Tool Router、权限配置和 StepContext 组合到一次执行中。这表明 Tool 不是独立的“函数列表”，而是 Runtime 控制面与执行面的交汇点。[^opencode-tools] [^codex-step] [^codex-permissions]

### 2.2 Tool schema 不是权限

Schema 描述“允许模型提交什么形状的参数”，并不表示：

- 用户已经允许调用；
- Environment 具有对应资源；
- 参数中的路径安全；
- 网络目标可访问；
- Tool 可以把 Secret 暴露给模型。

实际调用应当经过至少三层：

```text
model arguments
  → schema validation
  → policy / approval
  → Environment enforcement
  → handler
```

如果只有 schema validation，攻击者可以通过合法格式的参数请求非法资源。例如 `path` 是合法字符串，不代表它指向的路径位于 workspace 内。

### 2.3 Tool 的责任边界

Tool 层适合负责：

- 输入结构校验；
- 能力名称和描述；
- 将 Runtime 请求转换为具体操作；
- 将底层异常转换为模型可理解的结果；
- 标记副作用类型和审批需求。

Tool 层不应独自负责：

- 绝对文件系统隔离；
- Secret 的最终保护；
- 网络的硬阻断；
- 子进程的全部生命周期；
- Session 恢复后的资源真实性。

这些责任属于 Policy、Environment 和外部资源管理器。Tool 只能提出执行意图，不能凭自身代码约束整个系统。

## 3. Skill：模型可使用的知识和流程

### 3.1 Skill 改变的是 Context，不是执行权限

Skill 常见内容包括：

- 某类任务的操作步骤；
- 代码风格和仓库约定；
- 工具选择建议；
- 输出格式和验收标准；
- 领域术语和约束；
- 对特定文件、目录或服务的说明。

它们通常以指令、文档、模板或可检索内容的形式进入模型 Context。Skill 可以让模型更频繁地请求某个 Tool，但不应因为 Skill 中写了“可以部署”就自动获得部署权限。

可以用下式区分：

```text
Skill influence = model behavior influence
Tool authority  = Runtime capability
```

一个 Skill 可能影响规划，但不能绕过 Tool policy；一个 Tool 可能存在于 Registry 中，但没有合适的 Skill 时模型未必知道何时使用。

### 3.2 Skill 的风险不是零权限

Skill 不直接执行命令，并不等于没有安全影响。它可能：

- 诱导模型读取不必要的文件；
- 让模型把低可信内容当成操作指令；
- 改变 Tool 选择顺序；
- 增加 Context 长度和成本；
- 让模型在未经用户确认时规划高风险动作。

因此，Skill 需要来源、版本、适用范围和信任等级。尤其不能把工作区中的任意 `README`、配置文件或生成文档自动视为高优先级 Skill。

### 3.3 Skill 与 Tool 的组合

可靠的组合关系是：

```text
Skill: “完成发布前检查，并在变更风险较高时请求确认”
Tool:  “读取 diff、运行测试、创建发布请求”
Policy: “发布动作必须得到用户批准”
Environment: “只能访问指定 workspace 和允许的远程服务”
```

Skill 负责表达工作方法，Tool 负责表达可请求动作，Policy 负责授权，Environment 负责硬约束。将这四项压缩成一个插件入口，后续很难判断越权究竟发生在哪里。

## 4. Plugin：改变 Host Runtime 的扩展单元

### 4.1 Plugin 比 Tool 更宽

Plugin 的典型能力可能包括：

- 注册 Tool；
- 注册 Skill 或 Prompt；
- 加载配置；
- 添加 UI 命令或交互组件；
- 监听 Event；
- 改写请求或结果处理；
- 创建子进程或连接外部服务；
- 安装其他扩展；
- 修改 Session、日志或持久化行为。

所以 Plugin 不是“Tool 的另一种名字”，而是 Host Runtime 的可扩展代码边界。它可能位于能力平面，也可能位于控制平面。

### 4.2 Plugin 的权限面更大

Tool 通常在调用时获得一次能力；Plugin 可能在加载时就拥有长期能力。至少要区分：

```text
load permission
registration permission
invocation permission
data access permission
process permission
configuration permission
```

例如，一个 Plugin 可能不提供任何模型可调用 Tool，但它可以监听所有 Tool Result 或修改 Prompt。这样的 Plugin 仍然具有很高的安全和一致性影响。

### 4.3 Plugin 的生命周期

Plugin 至少需要定义：

```text
discover → load → initialize → register → active
                                      ↓
                           disable ← failure
                                      ↓
                                  unload
```

关键问题包括：

- 初始化失败是否阻止 Session 启动；
- 注册一半失败时已注册的 Tool 如何回滚；
- Plugin 升级是否影响正在运行的 Turn；
- 禁用后旧 Tool Call 是否仍然有效；
- Plugin 的后台进程由谁终止；
- 恢复 Session 时加载的是旧版本还是当前版本。

如果这些问题没有答案，Plugin 的行为就不能被纳入可恢复的 Agent 状态模型。

## 5. MCP：协议化的外部能力边界

### 5.1 MCP 解决的是连接问题

MCP 的价值不只是“远程 Tool schema”。它把能力提供者与 Agent Host 之间的发现、初始化、能力声明和调用协议化，使一个 Server 可以被多个 Host 连接。

从 Runtime 角度，MCP 至少引入：

- Client/Host 与 Server 的进程边界；
- 初始化和能力协商；
- 传输层和连接生命周期；
- 外部身份和认证；
- Server 侧的资源与状态；
- 网络、超时、重连和版本兼容。

因此，MCP Tool 的安全语义不能只由 Agent 的本地 Tool Registry 决定。Host 需要把远程能力映射到本地的 Policy 和 Environment 模型。

### 5.2 MCP Server 不是被动函数库

从 Host 看，MCP Server 可能同时提供：

```text
tools     → 可调用动作
resources → 可读取内容
prompts   → 可复用提示模板
```

三者对模型和 Runtime 的影响不同：

- Tool 通常产生副作用；
- Resource 可能把外部数据带入 Context；
- Prompt 可能改变模型行为和工具选择。

如果 Host 只对 `tools` 做审批，而默认信任 `resources` 或 `prompts`，安全边界是不完整的。

### 5.3 MCP 的两种状态

MCP 连接通常同时拥有两种状态：

1. **协议状态**：连接是否建立、能力列表是什么、请求是否完成；
2. **服务状态**：外部系统中创建了哪些资源、任务、订阅或修改。

重新连接可以恢复协议状态，但不一定恢复服务状态。断开连接也不等于取消远程任务。Runtime 必须为外部 operation 保存 identity、owner、状态查询和取消语义。

## 6. 四种机制的统一生命周期

### 6.1 Discover：发现来源

来源可能是：

- 内置代码；
- 配置文件；
- 用户目录；
- workspace 文件；
- 包管理器；
- MCP endpoint；
- 远程服务目录；
- 当前任务动态返回的能力列表。

发现阶段决定信任根。如果从工作区文件读取扩展配置，就不能自动把配置内容视为用户授权。

### 6.2 Validate：验证身份和兼容性

验证至少包括：

- 名称和版本；
- schema 是否有效；
- 依赖是否满足；
- 协议版本是否兼容；
- 入口文件和签名是否可信；
- 运行时权限是否允许；
- 是否与已有能力冲突。

Tool 名称冲突、Skill 覆盖、Plugin hook 顺序和 MCP capability mismatch 都应成为显式状态，而不是静默覆盖。

### 6.3 Register：登记能力和责任

Registry 不应只保存 `name → handler`。更完整的登记信息是：

```text
capability_id
provider_id
version
schema
required_environment
required_permissions
trust_level
source
lifecycle_owner
```

这样 Runtime 才能回答：某次 Tool Call 使用了哪个版本、由哪个扩展提供、使用了什么 Environment、批准来自哪里。

### 6.4 Expose：决定模型看到什么

所有已注册能力不一定都应该进入当前模型请求。Expose 阶段可以按以下维度筛选：

- 当前任务类型；
- 当前 Session 权限；
- 当前 Environment；
- 当前模型能力；
- Context 预算；
- 用户是否已启用；
- Tool 是否可用或正在恢复。

这一步是“注册表”与“能力平面”的分界：Registry 保存可能存在的能力，Capability Plane 决定当前请求可见且可执行的能力。

### 6.5 Authorize and Execute：调用时重新验证

模型看到 Tool schema 后，实际调用仍需要重新检查：

```text
exposed schema
  ≠ valid authorization
  ≠ current Environment
  ≠ successful execution
```

如果 Tool 在模型请求生成后被禁用，Runtime 应拒绝旧调用或将其标记为 stale，而不是盲目执行。否则动态注册会产生“模型看到的能力”和“Runtime 当前允许的能力”不一致。

### 6.6 Observe and Recover：扩展结果进入状态模型

扩展调用的结果至少要区分：

- 成功结果；
- 业务失败；
- 参数错误；
- 权限拒绝；
- 超时；
- 连接断开；
- 远程 operation 已创建但结果未知；
- Plugin 已失效。

这些结果不能都压成一段 Tool output。恢复器需要知道失败发生在本地调用、远程请求还是外部副作用之后。

## 7. 各 Agent 的责任边界比较

### 7.1 Codex：扩展被纳入产品级执行控制

Codex 的 Tool、Permission profile、Network approval 和 StepContext 形成了较强的执行控制链。扩展或外部连接要真正执行，必须落入既有的 Tool Router、Policy 和 Environment 语义，而不是只在模型请求中添加 schema。[^codex-step] [^codex-network-approval] [^codex-permissions]

这种设计的优势是批准、执行和环境条件更容易统一；代价是任何新扩展都需要适配较多的 Runtime 约束，不能把一个远程能力直接当成本地函数。

### 7.2 Pi：轻量 Host 提供高自由度 Hook

Pi 的 Tool preparation/execution hook 允许应用在调用前后插入逻辑，Node Environment 负责执行和输出捕获。[^pi-prepare] [^pi-execute] [^pi-env]

它的边界更接近“可组合的 Agent Loop 库”：扩展可以很灵活地改变工具调用，但 Sandbox、Secret、远程连接和持久化责任更多落到宿主应用。灵活性和安全默认值之间的取舍较明显。

### 7.3 OpenCode：扩展边界与服务化执行结合

OpenCode 将 Tool responsibility、Workspace provider 和 Session execution 分开，使扩展能力可以与服务化 workspace 和执行 claim 结合。[^opencode-tools] [^opencode-workspace] [^opencode-execution]

这类结构更适合多运行者和远程 Session，但扩展真正拥有什么权限，仍取决于 Workspace driver、执行 worker 和部署配置。不能只查看 Plugin 注册代码就判断最终安全边界。

### 7.4 Gemini CLI：策略、Skill 和 MCP 需要共同治理

Gemini CLI 的 Policy Engine、Shell 执行和 SessionContext 分属不同层。[^gemini-policy] [^gemini-shell] [^gemini-types]

这说明动态能力进入模型上下文后，仍需经过本地 policy 和 shell execution。Skill 或 MCP 提供的描述可以影响模型行为，但不能替代 shell 的执行检查。实际扩展的安全程度取决于能力发现、Context 注入和 Policy 是否共享同一份信任信息。

### 7.5 OpenHands：扩展往往跨越 Agent 与远程服务

OpenHands 的 agent-server、sandbox、workspace 和 service context 使扩展问题天然带有远程资源和服务身份。[^openhands-adapter]

在这种模型中，Plugin 或 Connector 的关键问题不只是“注册了什么 Tool”，还包括：服务 URL 属于哪个 Session、凭证绑定到哪个 Environment、远程任务如何取消、sandbox 销毁后外部资源是否仍存在。

### 7.6 Kimi Code：Tool Policy 和 Subagent 形成能力传播链

Kimi Code 的 permission gate、tool policy、task persistence 和 subagent context 表明，能力会随着 Task 和子 Agent 上下文传播。[^kimi-permission] [^kimi-policy] [^kimi-task] [^kimi-subagent]

这类结构需要明确：子 Agent 是继承父 Agent 的能力、获得能力子集，还是重新经过 Policy 评估。仅复制 tool schema 或 context metadata，都不能自动完成权限隔离。

### 7.7 mini-SWE-agent：扩展面小，但边界更容易看清

mini-SWE-agent 将 Environment 抽象为执行命令和返回结果的协议，LocalEnvironment 直接管理 cwd、subprocess 和 command output。[^mini-environment] [^mini-local]

它没有复杂的 Plugin/Capability Plane，反而清楚展示了最小 Runtime 的基线：扩展能力本质上就是向执行环境增加新的动作或改变 Prompt。其缺失的注册、权限、恢复和远程连接机制，正是大型 Coding Agent 后续不断增加层次的原因。

## 8. “扩展能力”与“能力平面”的分界

一个简单 Registry 通常回答：

```text
有哪些 Tool？
```

能力平面还需要回答：

```text
哪些能力对当前请求可见？
谁提供它？
它需要什么权限？
它绑定哪个 Environment？
它当前是否健康？
它由谁负责撤销和恢复？
```

因此，Capability Plane 至少包含四个子面：

| 子面 | 责任 |
| --- | --- |
| Discovery | 找到扩展和能力来源 |
| Admission | 判断是否允许进入 Runtime |
| Projection | 决定当前模型请求看到什么 |
| Execution | 在授权 Environment 中执行并收敛状态 |

Plugin、MCP 和 Skill 可以分别进入不同子面，但不应默认拥有全部能力。例如，一个 Skill 可以进入 Projection，一个 MCP server 可以进入 Discovery 和 Execution，一个 Plugin 可能影响四个子面。

## 9. 需要固定回答的实现问题

分析任何 Agent 的扩展系统时，应逐项回答：

### 注册与版本

- Tool 名称冲突如何处理？
- Schema 变化如何兼容旧的模型请求？
- Plugin 版本是否进入 Session/Turn 状态？
- MCP Server 重新连接后能力列表变化如何处理？

### 权限与 Environment

- 扩展获得的是宿主进程权限还是独立 Environment 权限？
- Skill 是否能间接触发高风险 Tool？
- 子 Agent 继承哪些能力？
- Secret 是否进入扩展进程和模型 Context？

### 一致性与生命周期

- Tool 被禁用时，已经生成的 Tool Call 怎么办？
- Plugin 卸载时，后台进程和远程 operation 谁负责清理？
- Session 恢复时是否重新验证扩展版本和权限？
- 扩展失败是否影响整个 Turn，还是只影响一次调用？

### 可观察性

- 能否知道一次调用由哪个扩展版本提供？
- 能否区分本地 handler 失败和远程服务失败？
- 能否重放调用时使用的 schema、policy 和 Environment？

## 10. 验证方案

本文的源码分析可以确认扩展责任被放在哪些模块，但不能仅凭源码确认部署后的隔离效果。后续应为每个 Agent 建立相同的验证矩阵：

1. **动态注册**：在模型请求生成前后注册、禁用和替换 Tool，观察旧 schema 是否仍可调用；
2. **权限传播**：让父 Agent 委派子 Agent，检查 Tool、Network、Secret 和 Workspace 能力是否缩减；
3. **扩展失败**：在初始化、注册、执行、返回结果和卸载阶段分别注入失败；
4. **断线恢复**：中断 MCP 连接或远程 Connector，观察协议状态和外部 operation 是否分离；
5. **Context 影响**：比较 Skill、Tool schema、Resource 和 Prompt 进入请求前后的 token、请求边界和缓存行为；
6. **版本切换**：在 Session 中升级或禁用扩展，确认后续 Turn 使用哪个版本以及旧调用如何收敛。

## 设计原则

### 原则一：区分知识、能力和实现

Skill 改变模型理解，Tool 暴露可请求动作，Plugin 改变 Host Runtime，MCP 解决跨进程能力连接；四者不能互相替代。

### 原则二：注册不等于授权

Registry 保存候选能力，当前请求是否可见、可调用，仍需经过 Policy、Approval 和 Environment 检查。

### 原则三：扩展必须拥有明确的责任边界

每个扩展都应明确其进程、Environment、Secret、网络、生命周期和失败责任，而不是继承宿主的全部隐含权限。

### 原则四：能力变化必须有一致性语义

注册、禁用、升级和断线会改变模型看到的能力；Runtime 必须定义这些变化对当前 Turn、已有 Tool Call 和恢复的影响。

### 原则五：外部能力必须可追溯

一次调用应能追溯到扩展来源、版本、schema、Policy、Environment 和外部 operation，而不是只留下一个 Tool name。

## 未确认事项

- 各 Agent 对 Skill、MCP Resource 和 Prompt 的实际 Context 注入时机，需要运行时抓取请求才能确认；
- 动态 Tool 变化是否导致 Provider 侧 KV Cache 失效，取决于请求序列化和服务端缓存实现，不能由本地 Registry 直接推断；
- 各项目 Plugin 的真实宿主权限、Secret 继承和子进程行为，需要部署级测试；
- MCP Server 断线后的远程 operation 语义，通常不能仅由客户端源码确定；
- 各 Agent 是否已经形成独立 Capability Plane，仍需结合后续注册、Policy、Environment 和 Observability 代码共同判断。

## 参考源码

[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-network-approval]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
