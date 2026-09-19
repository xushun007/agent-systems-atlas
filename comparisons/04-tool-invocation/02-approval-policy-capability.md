---
title: Approval、Policy 与 Capability：Tool Runtime 的动态授权
series: Coding Agent 的 Tool Invocation：从能力声明到外部副作用
part: 2
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Approval、Policy 与 Capability：Tool Runtime 的动态授权

## 结论

Coding Agent 的授权不是一个布尔值。至少需要区分四个集合：模型可以看到的工具、策略允许选择的工具、当前用户批准的动作，以及执行器在当前 Environment 中真正能够完成的动作。它们可能重叠，但不应默认相等。

最重要的运行时边界是：**Tool schema 决定模型可以提出什么；Policy 决定调用是否进入候选；Approval 决定一次具体动作是否获得交互授权；Capability/Sandbox 决定动作最终能否触达资源。** 其中任何一层发生变化，都不应未经定义地影响其他层。

本篇比较 Codex `rust-v0.154.0`、Pi `v0.85.1`、Gemini CLI `v0.59.0`、OpenCode `v2.0.0`、OpenHands `v1.15.0`、Kimi Code `v0.40.0` 和 mini-SWE-agent 当前研究版本。文章关注授权决策的架构边界，不把源码阅读等同于完整安全审计。

## 1. 四层授权模型

可以把一次调用的授权过程写成：

```text
visible(tool, model, context)
        ↓
selectable(tool, policy)
        ↓
approved(call, user / managed policy)
        ↓
enforceable(action, environment / sandbox)
```

四层的失败含义不同：

| 层 | 失败含义 | 模型通常看到什么 |
| --- | --- | --- |
| visible | 工具不出现在请求中 | 模型无法选择 |
| selectable | 工具存在但当前策略禁用 | 工具被过滤或拒绝 |
| approved | 具体动作未获批准 | 拒绝/等待/请求修正 |
| enforceable | 执行器无法触达资源 | sandbox、路径或运行时错误 |

把它们都实现为 `allowed: boolean` 会丢失大量语义。用户拒绝一次 `rm`，与容器不允许访问路径，和工具 schema 不支持参数，并不是同一种错误，也不应有相同的恢复方式。

## 2. Policy 与 Approval 的区别

Policy 是可重复计算的约束，输入通常包括工具名、参数、路径、网络目标、Environment、用户身份和当前模式。Approval 是对某个待执行动作的交互决策，可以是用户同意、拒绝、修改参数或授予有限期限的持续批准。

一个合理的流程是：

```text
policy precheck
    ├── deny → rejected
    ├── allow → preflight
    └── ask → approval pending
                    ├── deny → rejected
                    ├── correct → re-evaluate
                    └── allow → preflight
```

审批返回后仍需执行 preflight。等待期间 Environment、Workspace、权限规则、工具版本和取消状态都可能改变；审批不能自动冻结这些状态，除非系统为 approval 明确创建了 capability lease。

## 3. Codex：profile、sandbox 和动态授权

Codex `rust-v0.154.0` 将文件系统 Sandbox policy 与网络 policy 分开，并通过 permission profile 形成 read-only、workspace-write 等执行范围。workspace-write 仍受 writable roots 和路径约束，不能理解为整个主机可写。[^codex-permissions]

安全测试覆盖 writable roots、父目录、外部 sandbox 自动审批和显式不可读路径等组合。这显示 Codex 的 authorization 不是单看 `approval_policy`，而是结合文件、网络、Environment 和当前动作。[^codex-safety]

### 3.1 Approval 的归属

Codex 的 network approval service 维护 pending approval owner，并关联 Turn、call ID、触发 cwd、权限 profile 和取消连接。等待中的 approval 不是全局弹窗，而是属于某个执行调用的状态。[^codex-network-approval]

这让 Runtime 能处理几个竞态：

- 同一 Host 的多个调用是否共享一个待审请求；
- 原调用 Turn 被取消后，谁负责关闭 waiter；
- 用户批准后原 Environment 是否仍有效；
- 同一权限决定是否可以被当前 Session 后续调用复用。

Codex 的 step activation tests 还验证管理授权约束在延迟激活时重新检查。已接纳的 Turn 设置可以保留，但如果管理策略刷新后不再允许该设置，后续激活会被拒绝。[^codex-live-auth]

这形成一种精细的语义：请求配置按 Step 固定，活跃授权在动作激活前重新验证。它避免了两种错误：执行中悄悄改变模型请求条件，以及已撤销的管理约束继续生效。

## 4. Pi：Hook 作为应用级授权插槽

Pi v0.85.1 底层 Agent 在 `prepareToolCall` 中调用 `beforeToolCall` hook；hook 可以返回 block 或修改准备结果，之后 Runtime 再检查 signal 才进入工具执行。[^pi-prepare]

这为应用集成提供了灵活的授权插槽：CLI 可以用 hook 实现询问，测试可以实现确定性策略，嵌入式应用可以将请求交给自己的权限服务。

但灵活性也意味着底层 Agent 不知道 hook 是否真正完成了安全检查。Tool object 的 schema、hook 决策和 `NodeExecutionEnv` 的进程能力属于不同层次。若应用只依赖 hook，而 Environment 没有沙箱，hook 失效或被绕过时，动作可能直接作用于宿主资源。

Pi 的设计更像“可组合的执行内核”，而不是内置完整 policy plane。研究 Pi 时必须把 Agent API、coding-agent 应用层和 durable harness 的权限责任分别标记。

## 5. Gemini CLI：Policy Engine 与交互 Session

Gemini CLI v0.59.0 的 Policy Engine 会根据 tool call 名称、参数和 approval mode 评估工具请求；规则可以包含工具别名、命令和目录等匹配条件。policy evaluation 还会处理特殊的 Agent/subagent 工具。[^gemini-policy]

SDK shell 在执行命令前使用 ShellTool 进行 policy 检查；如果当前调用需要确认而没有 interactive session，会明确返回“需要确认但不存在交互 Session”，而不是默认允许。[^gemini-shell]

这体现了一个重要的 headless 设计原则：非交互模式不是交互模式的“自动批准版”。它应当有独立的 default policy，明确拒绝无法完成的 approval，而不是因为没有 UI 就跳过保护。

Gemini 的 policy 规则还需要稳定地规范化参数。仓库中的 stable stringify 说明策略匹配需要处理对象属性顺序、循环引用和序列化稳定性；否则同一个逻辑调用可能因为 JSON 表示不同而得到不同决策。[^gemini-stable]

## 6. OpenCode：Permission Service 不属于工具注册表

OpenCode v2 的工具边界文档明确指出，工具 registry 不依赖 Permission Service，也不负责执行授权。注册可以附带 permission action，用于工具定义过滤；真正的资源解析、权限检查和副作用顺序属于工具叶节点。[^opencode-tools]

这是一种有意的责任分离：

```text
registry: what exists
    ↓
model request: what was selected
    ↓
permission: whether this call is allowed
    ↓
leaf tool: how the resource is touched
```

用户拒绝以类型化错误向 Session Model Request 传播，工具叶节点不能通过宽泛 catch 把拒绝转换为普通错误。这样模型可以收到可解释的失败，Runtime 也能保持 interruption、defect 和 permission decline 的差异。[^opencode-tools]

OpenCode 的设计还提醒一个常见风险：Permission action 过滤了工具定义，不等于执行时 permission assert 已经通过。工具注册、模型 Context 和实际副作用必须在同一个 Session/Environment 作用域内重新关联。

## 7. Kimi Code：Tool Policy、Permission Gate 与动态环境

Kimi Code v0.40.0 的 v2 Runtime 将 tool policy 和 permission gate 分成独立服务。Tool policy 通过 allow/disallow 列表决定工具是否 active；permission gate 以具体 tool call 为输入进行评估、记录 telemetry，并在需要时等待 approval。[^kimi-policy] [^kimi-permission]

Kimi 的某些工具在执行时还会检查 Runtime 是否发生变化。例如 glob 工具在策略要求的运行时状态失效时返回“Runtime changed before execution”，让模型重新发起调用，而不是继续使用旧授权。[^kimi-glob]

这说明 Kimi 将“审批时允许”与“实际执行时仍然允许”区分开。等待期间工具策略、Workspace、文件系统或 Session 状态变化，都可能使原调用失效。

Kimi task persistence 将 `awaiting_approval` 作为任务状态，说明审批等待属于可恢复任务生命周期，而非单纯 UI 状态。[^kimi-task] 进程重启后，系统需要决定等待中的审批是恢复、取消还是重新评估；直接恢复一个旧 approval 可能越过新的策略。

## 8. OpenHands：安全策略与 agent-server 的执行边界

OpenHands v1.15.0 将 Agent action 通过 agent-server 发往 Environment，Conversation workspace、sandbox 状态和 session API key 共同决定执行上下文。前端可以知道 Cloud sandbox 是否 paused、workspace working directory 和 agent-server 地址，但这些字段本身不等于授权结果。[^openhands-adapter]

OpenHands 的 action/observation 事件带有 action ID、tool name 和 observation status；这使 Runtime 可以将用户确认、工具执行和 Environment 观察关联起来。[^openhands-events]

在此架构中，安全检查可能跨越前端、agent-server 和 Cloud sandbox。前端允许用户选择 workspace 模式，不代表 agent-server 允许任意路径；agent-server 接受 action，也不代表 sandbox 允许网络。跨进程的最终强制点必须位于真正拥有资源访问权的执行环境。

## 9. Capability 是最小可执行授权单元

Permission 更接近“是否允许”，Capability 更接近“允许执行什么”。一个 capability 可以描述：

```text
Capability = {
  action: write_file,
  resource: workspace://repo-a/src/x.ts,
  environment: env-17,
  principal: session-42,
  constraints: { mode: append, expires: ... }
}
```

它比工具名细，因为同一个 `write_file` 在不同文件、不同 Environment 和不同模式下风险不同。Capability 也比 approval 稳定，因为 approval 是获得 capability 的过程，而非 capability 本身。

Codex 的 capability roots、文件策略和 network policy，OpenCode 的 permission action，Gemini 的 policy matching，以及 Kimi 的 active tool policy，都可以从这个角度分析：它们在不同层次定义了工具的可执行范围。[^codex-step] [^opencode-tools] [^gemini-policy] [^kimi-policy]

## 10. 权限等待期间的竞态

Approval pending 时，至少可能发生以下变化：

- 用户取消 Turn；
- Session 切换 Environment；
- Workspace 文件被其他进程修改；
- 管理策略刷新；
- 工具实现或 MCP connection 失效；
- 当前 call 已经被其他恢复器接管；
- 用户同时提交新的输入。

所以批准操作必须绑定 call ID、Step/Turn ID、Environment revision 和 policy version。一个孤立的“approve command”不足以安全执行。

批准后的最小流程应是：

```text
approval received
    ↓
identity check
    ↓
policy recheck
    ↓
environment/resource recheck
    ↓
execute or reject as stale
```

拒绝旧调用为 stale 往往比强行执行更安全。若产品允许用户在审批界面修改参数，修改后的动作应生成新的 canonical call 或新的 policy evaluation，而不是覆盖原始模型意图。

## 11. 权限作用域与持久化

“允许这一次”“允许当前 Session”“允许当前 Workspace”“允许以后所有调用”是四种不同作用域。持久批准必须记录 scope、创建者、原因、匹配条件和失效时间。

Codex 的 approval store 和 reviewer/approval policy 区分一次执行的决策与更高层设置；Kimi 的 permission gate 和持久 task state 也将具体 call 与 Session Runtime 关联。[^codex-network-approval] [^kimi-permission]

若把用户对一个 `npm install` 的批准永久扩展为所有 shell 命令，Permission 就退化为全局开关。反过来，若每个安全的只读操作都弹窗，产品会迫使用户选择过宽的信任模式。能力平面应支持细粒度和可解释的复用。

## 12. 可复现验证设计

不需要 API key，可以使用脚本化模型和受控工具验证授权时序：

1. 工具不出现在 Context 中，确认模型无法选择；
2. 工具可见但被 policy 禁用，确认不会进入执行；
3. 工具进入 approval pending，期间改变 policy，观察是否重新评估；
4. 用户批准后改变 Environment revision，确认调用变为 stale 或重新检查；
5. 用户拒绝，确认没有外部 effect，且拒绝语义进入下一次 Context；
6. 在无交互 Session 中触发需审批工具，确认不会隐式 auto-approve；
7. 两个不同 call 使用相同命令，确认 approval 作用域是否按设计复用；
8. 模拟一个被取消的 approval waiter，确认不会在迟到批准后执行。

实验需要记录 tool visibility、policy version、approval ID、call ID、Environment revision、preflight result 和 effect marker。只验证最终返回文本，无法证明权限真正作用在外部动作之前。

## 13. 设计原则

### 原则一：拒绝语义必须分层

不可见、策略禁用、用户拒绝、参数非法、Sandbox 拒绝和资源失效不应都变成普通 tool error。

### 原则二：Approval 不替代执行强制

用户批准只能决定是否允许继续；真正的文件、网络、凭据和进程边界必须由执行器或 Sandbox 强制。

### 原则三：批准后仍需 preflight

审批等待期间状态可能变化。身份、策略、Environment 和资源必须在副作用前重新检查。

### 原则四：Capability 需要明确作用域

每次、Session、Workspace、用户和组织级授权必须显式区分，持久批准应可撤销、可过期、可审计。

### 原则五：Headless 模式必须有明确拒绝路径

没有交互 UI 时，不能把缺少用户响应当成自动批准。调用方应预先提供符合策略的 capability，或让动作失败。

## 14. 结论

Tool Runtime 的授权是一个动态决策平面，而不是一个 `allowed` 字段。模型可见性、工具策略、用户审批、Environment capability 和 Sandbox 强制分别处理不同的风险。

Codex 将 profile、文件/网络 Sandbox、Turn/Call approval ownership 和动态管理约束组合起来；Pi 以 hook 暴露应用级授权插槽；Gemini CLI 将 policy matching 与交互 Session 分开；OpenCode 把 Registry、Permission 和 Tool Leaf 明确分层；Kimi Code 将 Tool Policy、Permission Gate、运行时重新检查和持久审批状态拆开；OpenHands 通过 agent-server 和 sandbox 形成跨进程执行边界；mini-SWE-agent 则把策略责任留给 Environment 后端和外层应用。

安全的 Tool Invocation 不是“用户点了允许”，而是 Runtime 能证明：这个 call 属于正确的 Step，目标资源属于正确的 Environment，当前 policy 仍然允许，执行器确实在强制边界内开始了动作。

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

本文完成源码和相关测试阅读，未运行真实审批 UI、跨进程授权接管或 Sandbox 越界实验。

[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-safety]: [Codex sandbox and approval safety tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/safety_tests.rs#L120-L275)
[^codex-network-approval]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^codex-live-auth]: [Codex live authorization recheck](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_activation_tests.rs#L667-L770)
[^codex-step]: [Codex Step capability binding](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-prepare]: [Pi tool preparation hook](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^gemini-stable]: [Gemini CLI stable policy stringify](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/stable-stringify.ts#L1-L45)
[^opencode-tools]: [OpenCode tool and permission responsibility](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^openhands-adapter]: [OpenHands agent-server and workspace context](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^openhands-events]: [OpenHands action and observation identity](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^kimi-policy]: [Kimi tool policy](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-glob]: [Kimi runtime-changed tool guard](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts#L90-L135)
[^kimi-task]: [Kimi persisted approval task state](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
