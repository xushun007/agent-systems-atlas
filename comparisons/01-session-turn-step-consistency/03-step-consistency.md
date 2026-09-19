---
title: 一次 Step 究竟需要固定什么
series: Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型
part: 3
reviewed_at: 2026-09-16
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# 一次 Step 究竟需要固定什么

一个模型请求开始后，Runtime 仍可能收到新输入、刷新权限、切换模型或更新工具。问题不是“所有状态是否都不可变”，而是：**哪些状态必须在 Step 的边界内保持一致，哪些状态必须在执行前重新检查，哪些状态允许在执行中变化。**

结论是，Step 不应被理解为对整个 Session 的冻结。更可行的设计是建立分层快照：请求所依据的配置和能力集合固定；对安全性负责的实时约束在激活工具前重新验证；外部环境作为可观察状态而非自动获得一致性快照。不同层若没有明确区分，就会出现工具已经按旧策略执行、请求却被解释为新策略的歧义。

## 1. “固定”所要解决的三个问题

### 1.1 请求重现

模型请求至少需要知道当时使用了哪个模型、系统提示、消息前缀、工具声明和推理参数。若请求开始后直接读取共享可变对象，审计记录可能无法回答“模型为什么看到这个工具”以及“这个结果属于哪一组配置”。

请求重现不意味着模型输出可重现。随机性、提供商状态和外部内容仍可能变化；这里要求的是 Runtime 对输入条件的归属可解释。

### 1.2 执行授权

能力声明与实际授权不是同一件事。工具可以出现在请求的 schema 中，但在真正执行前，目录信任、审批策略或组织级限制可能已经改变。因此安全相关约束不能只在组装 prompt 时读取一次。

### 1.3 外部事实

工作区文件、进程、网络资源和远程任务不是普通内存字段。Runtime 可以记录 cwd、环境变量或工具参数，但这不等于把文件系统拍成快照。对外部事实的保证必须来自沙箱、版本控制、事务存储或工具自身的协议。

## 2. Step 快照的最小结构

可以把一次 Step 的执行条件抽象为：

```text
StepSnapshot = {
  turn_identity,
  context_prefix,
  resolved_model_settings,
  advertised_capabilities,
  execution_environment_reference,
  live_authorization_constraints
}
```

其中前四项通常在请求激活时固定；`live_authorization_constraints` 不是快照，而是执行前的验证输入。环境引用记录“在哪个环境执行”和“如何访问”，但不宣称环境内容未发生变化。

### 2.1 Codex：捕获解析后的 Step 条件

Codex 的 `StepContext` 将 Turn、解析后的 `ResolvedStepSettings`、环境信息、能力根目录、MCP 绑定、工具路由和已加载的指令文件放入一次 Step 的上下文。`ResolvedStepSettings` 使用共享指针保存已经解析的模型与策略选择；设置更新会形成新的解析结果，已捕获的 Step 不会因为 Turn 的当前设置变化而被重定向。[^codex-step-context]

对应测试在模型查找和 MCP 刷新被延迟时，同时启动的 Step 仍持有原模型设置；之后激活的 Step 才看到新模型、推理强度和优先级。这证明了“发布新设置”和“已激活 Step 使用什么设置”是两个边界。[^codex-activation]

这不是全局不可变性。测试还显示，受企业管理的授权约束会在延迟激活时重新检查；如果约束已经不再允许原先的设置，激活被拒绝。也就是说，Codex 将“请求配置的稳定性”和“活授权的有效性”分开处理。[^codex-live-auth]

### 2.2 Pi：顶层数组快照不等于深层不可变

Pi 底层 `Agent` 在创建循环配置时调用 `createContextSnapshot()`，复制 system prompt、messages 和 tools 的顶层数组。它能阻止后续替换 `state.tools` 数组直接改变本次循环引用的数组；但工具对象本身仍是共享引用。因此，若在实验中直接修改同一个工具对象的 `execute` 函数，本次执行可能观察到该修改。

这个细节具有重要含义：Pi 的快照是“容器级快照”，不是能力对象的深拷贝。它足以隔离普通的状态数组更新，却不能单独提供工具定义和执行函数的不可变审计边界。底层 Agent 也没有由此推导出工作区内容的快照。[^pi-agent]

### 2.3 Kimi：请求物化是条件汇合点

Kimi v2 将 Step 请求排队、出队和物化分开。`materializeRequest` 在请求转为可执行请求时追加 context、更新请求状态，并形成提交给模型层的输入。由此，队列中的对象不是已经固定的模型请求；请求物化才是上下文和执行条件汇合的边界。[^kimi-materialize]

这类设计允许在等待期间撤回尚未应用初始消息的请求，但也要求明确撤回发生在“请求已物化”之前还是之后。若只根据队列项的名称判断状态，容易把已出队但尚未发出的请求误当成可安全删除的消息。

## 3. 工具声明、工具选择与工具执行

工具至少经历三个阶段：

| 阶段 | 主要问题 | 适合读取的状态 |
| --- | --- | --- |
| 声明 | 模型可选择哪些能力 | 工具名、schema、描述、可见范围 |
| 准备 | 本次调用是否有效、是否获批 | 参数校验、审批、当前策略、目标环境 |
| 执行 | 外部动作如何结束 | signal、进程状态、结果、错误和副作用证据 |

将工具动态注入 prompt 只解决第一阶段。它会改变请求的输入前缀，并可能影响提供商的 KV cache 命中；但它不能代替第二阶段的审批，也不能证明第三阶段的执行结果。一个可靠 Runtime 通常会复用稳定的工具描述前缀，把易变授权放在工具执行前检查，从而减少无必要的上下文变化，但这属于性能策略而非安全保证。

Pi 的 `prepareToolCall` 会从当前上下文选择工具、验证参数并调用 `beforeToolCall`；随后再次检查取消信号，再进入执行。Codex 则通过 `ToolRouter` 将声明的工具路由到实际执行器，并把 Step 的能力绑定带入执行上下文。两者都说明“模型声明了工具”与“Runtime 允许工具执行”是不同判断。[^pi-prepare] [^codex-tool-router]

## 4. 一致性保证的边界

从强到弱可以区分四种常被混淆的保证：

1. **输入归属**：能证明输入被哪个 Turn 接纳。
2. **请求条件固定**：能证明某次请求使用了哪份配置和能力声明。
3. **执行前授权有效**：能证明动作开始前满足当时策略。
4. **外部状态一致**：能证明动作看到或改变的环境状态没有被并发修改。

前两项主要由内存快照和请求记录解决；第三项需要实时校验；第四项需要环境级协议。把前三项完成，并不能声称第四项成立。

## 5. 可复现验证

一个不需要模型 API 的最小测试可以固定一个脚本化模型，在第一次响应工具调用后暂停，然后分别执行：替换工具数组、修改共享工具对象、变更模型设置、改变审批返回值。观察模型请求捕获到的 context、实际执行的函数及执行前的授权结果。

该测试能够验证 Runtime 的引用边界，但不能证明真实 CLI 的插件注册、提供商请求序列或文件系统并发语义。当前研究已完成源码和上游测试阅读；本篇没有把这个局部测试冒充端到端实验。

## 6. 设计含义

Step 的正确抽象不是“所有东西都复制一份”，而是明确哪些状态属于请求事实、哪些状态属于安全约束、哪些状态属于外部世界。复制过少会造成请求条件漂移；复制过多则会让撤销权限、切换环境和处理新输入变得迟钝。

因此，较稳健的规则是：**配置按 Step 固定，授权在动作前确认，环境以引用加证据描述，外部副作用由独立恢复协议处理。** 这条规则同时解释了 Codex 的解析设置与实时管理约束，也解释了 Pi 顶层快照为何只能提供有限隔离。

## 未确认事项

- 尚未在真实提供商请求中测量工具集合变化对 KV cache 命中率的影响。
- 尚未运行 Pi CLI 层的插件热更新或审批集成测试；本文只讨论 v0.85.1 底层 Agent/loop。
- Step 快照无法自动保证工作区文件、远程 MCP 服务或后台进程的一致性。

[^codex-step-context]: [Codex `step_context.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs)
[^codex-activation]: [Codex step activation tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_activation_tests.rs#L272-L435)
[^codex-live-auth]: [Codex live authorization recheck](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_activation_tests.rs#L667-L770)
[^pi-agent]: [Pi context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)
[^kimi-materialize]: [Kimi `materializeRequest`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)
[^pi-prepare]: [Pi tool preparation and execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L608-L718)
[^codex-tool-router]: [Codex tool router](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/router.rs)
