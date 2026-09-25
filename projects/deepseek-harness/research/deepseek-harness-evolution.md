# DeepSeek Harness：从插件式 Agent Loop 到可重建的 Coding Runtime

## 研究范围与结论

本文研究 DeepSeek Harness 从 2026 年 6 月的初始实现到 [`dsh-v0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.2) 的主要 Runtime 演进。分析终点固定为 [`fb2c4b9e698e30edb738bca4cf0618587db7d203`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)，提交日期 2026-09-10，复核日期 2026-09-21。这里只讨论已并入终点提交的架构，不把未并入分支上的设计当作当前事实。

结论：DeepSeek Harness 的演进主线是把一个可替换的 Loop，逐步扩展为“插件组合决定能力、Session 日志决定事实、Agent Loop 决定进程内执行”的系统。它不是让 `Agent` 类不断囊括更多职责。到本版本，最重要的设计约束是：**模型可见的输入必须能从 Session 事件历史重建**；进程内事件可供观察和拦截，却不能替代持久事实。[`Session.deriveMessages()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L811-L832) 与 [`ReactLoopAgent.buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L627) 是这条约束的实现锚点。

配套：[固定版本架构快照](../arch/runtime-architecture-2026-09-21-fb2c4b9.md)；[可编辑架构图](../diagrams/runtime-architecture-2026-09-21-fb2c4b9.excalidraw)。图是当前版本的组件关系，不是历史版本组件的叠加。

## 一、演进脉络：责任如何迁移

| 阶段 | 代表提交 | 责任变化 |
| --- | --- | --- |
| 2026-06：插件式骨架 | [`72688a3`](https://github.com/deepseek-ai/deepseek-harness/commit/72688a3888)、[`43f4258`](https://github.com/deepseek-ai/deepseek-harness/commit/43f425827781b95a1b66d7b3121b199e012ab9ad) | 引入 Cordis 与 Agent Loop 插件；Loop 从开始就不是不可替换的内核。 |
| 2026-08：部署与 Agent 组合分离 | [`92f8fb6`](https://github.com/deepseek-ai/deepseek-harness/commit/92f8fb6c4a8243bba786ab311dd13120f52ce044)、[`f94495e`](https://github.com/deepseek-ai/deepseek-harness/commit/f94495e527) | profile/bundle/patch 装配部署，Agent preset 决定单个 Agent 的可见插件世界；不是每个入口复制一棵硬编码服务树。 |
| 2026-08～09：持久化所有权收紧 | [`bec6805`](https://github.com/deepseek-ai/deepseek-harness/commit/bec6805d6af1cbb2a61f75c863d10a57371a58b3)、[`8b799cd`](https://github.com/deepseek-ai/deepseek-harness/commit/8b799cd7acd3dcc1bb7c5abd48f8ce364e3b1728) | Session 存储从宽泛服务演进为 handle-based 单写者接口，`flush` 成为明确的持久屏障。 |
| 2026-09：事件事实与恢复 | [`f99b06e`](https://github.com/deepseek-ai/deepseek-harness/commit/f99b06eaed81d6fe4fc64d44687450e18ef68a67)、[`b0a7d2c`](https://github.com/deepseek-ai/deepseek-harness/commit/b0a7d2ce3b4c19d7452e364b2d7acbfa87e707ed)、[`7b1c989`](https://github.com/deepseek-ai/deepseek-harness/commit/7b1c98933249c6618373e7a6f0529a12083f1fbe) | Assistant stream 的紧凑记录、durable inbox、Session v3 的 system surface 使恢复与请求重建越来越依赖规范化事件，而不是 UI 内存态。 |

这些提交只说明主要责任迁移，不构成逐提交的完整项目史。尤其 9 月阶段存在并行分支与合并提交；表中用已进入目标快照的提交定位功能落地，不能把表格顺序当作线性实现顺序。

## 二、当前系统的三种“所有权”

### 1. 部署组合归 profile 与 Cordis 插件树

启动器按 profile 所列的 bundle 顺序叠加 patch，随后应用 profile、home 与命令行 overlay。`web`、`headless`、`sdk`、`acp` 等只是不同的装配与入口形态。[`profile.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/boot/app-boot/src/profile.ts#L1-L23)；[基础 bundle](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/bundle/base/cordis.patch.yml)。

Cordis `ctx` 把服务、事件和副作用注册连在一起。模型适配器、Session、工具注册表、Loop 都作为插件挂载。卸载插件时，它注册的服务、监听器、工具与其他 effects 随拥有者撤销。这里的“扩展”不是往 Prompt 增加几行文字，而是可替换正在运行的服务提供方。源码中 `AgentLoop` 注册到 `ctx.agents` 的 factory，`ToolRuntime.register()` 返回 effect disposer，体现了实际边界。[`AgentLoop` 构造器](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L359-L424)；[`ToolRuntime.register()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1027-L1052)。

### 2. 单个 Agent 的能力范围归 preset 与作用域

profile 决定整个进程可用什么，preset 决定某个 Agent 实际看到什么。`AgentPresets` 让 Agent 在创建的 `setup(agentCtx)` 阶段加入一棵常驻 preset scope；tools、prompt section、限制策略因 scope 改变而可见或不可见。该阶段必须在 Agent/Session 对外发布之前完成，否则模型可能看到半配置的工具表或策略。[`AgentPresets` 模块说明](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21)；[`CreateAgentOptions.setup`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L97-L126)。

这也回答主/子 Agent 的限定问题：子 Agent 不必只靠系统提示词自觉遵守约束。创建时可以用 preset/scope 定义工具集合、prompt、限制，并用 `parentAgent` 建立进程内父子生命周期；持久 fork lineage 在 Session header 中另行记录。两者不是同一条关系。[`CreateAgentOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L95)；[preset scope](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21)。

### 3. 运行事实归 Session；执行控制归 Agent Loop

`AgentRegistry` 管活跃 Agent、创建工厂与拥有者；`AgentLoop` 提供默认工厂和 `ReactLoopAgent`。`Session` 不在 `Agent` 对象之外做一份重复的“聊天历史”：它持有 append-only 事件，`deriveMessages()` 从此投影模型历史；仓储后端通过单写者 handle 保存这些事件。[`AgentRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L245-L263)；[`Session`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L439-L467)。

Agent 创建不是先注册再补配置。`AgentRegistry.create()` 委派工厂；工厂完成 Session 准备与 `setup`，才发布可见身份。创建失败时回滚会话与作用域，避免外部观察者拿到半初始化对象。[`AgentFactory` 创建语义](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L171-L199)；[`resume.spec.ts` 的 setup/回滚测试](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/resume.spec.ts#L293-L315)。

## 三、一次交互如何成为可重建的请求

`ReactLoopAgent` 从 inbox 领取输入后先写 `turn/start`；一次 turn 可以包含多个 step。`agent/pre-step` 可以拦截或改写接纳的消息；首个输入若被拒绝或改为空，仍会关闭 turn，但不耗费模型 step。只有真正进入 step 才写 `step/start`。这使“用户送来消息”和“模型实际看到消息”成为可区分的事实。[`turn()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L269-L349)。

被接纳的 step 在发请求前依次完成提示词/工具 schema 组装、真实模型适配器准备、system surface 对齐、用户消息及请求头写入；之后从 Session 历史派生消息并冻结请求。真正的边界是 `prepareCall()` 后的已解析路由，而非 UI 上当前选择的模型字符串。若在准备阶段取消，本次 system/user 写入不会提前提交。重试复用本 step 的已接纳输入，不再重复投递用户消息。[`step()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L352-L392)；[`prepareRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L503-L548)；[`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L627)。

模型流的 UI 增量通过实时 `agent/assistant-stream` 传播；最后成功的 `assistant/message` 或失败的 `assistant/attempt` 才是持久 settlement。成功消息嵌入紧凑 stream；attempt 保留失败、重试或取消的观察证据，却不作为完整模型回复进入后续模型历史。硬中断如果发生在 settlement 之前，不应假定所有已显示流片段都持久存在。[`step()` 流处理](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L393-L486)；[`loop.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/loop.spec.ts#L63-L198)。

## 四、Session / Turn / Step 的一致性边界

| 对象 | 持有者 | 允许变化的内容 | 哪个时点稳定 |
| --- | --- | --- | --- |
| Session | `Session` 日志 + storage handle | 可追加事件、inbox splice、模型/审批策略切换；不能改写已提交历史 | 单条事件在 `append()` 后成为该 Session 的事实；`flush` 后跨进程持久 |
| Turn | `ReactLoopAgent` 的运行相位 + `turn/*` 事件 | 可含多个 Step；队列和取消会影响是否继续 | `turn/end` 后终态确定 |
| Step | Loop 的一次接纳和请求尝试 | 进入前可被 `agent/pre-step` 改写/拒绝；进入后工具和重试可延续 | 已准备模型路由、组装内容及日志前缀在 `buildRequest()` 时冻结，重试不重新接纳 |

这不是“整个 Session 在一次 Turn 开始时被冻结”。Session 可以继续收到用户输入与控制变更，但当前 Step 的模型请求不能同时混用切换前的 Prompt 和切换后的路由。`installModelSelection()` 在 prompt 组装阶段捕获选择，并把同一份捕获值交给 `agent/request`；并发模型切换只影响后续 Step。provider/model 改变还会在下一次被接纳请求里写入可追溯的用户角色通知；仅 effort 改变不增加同类通知。[`model-selection.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/model-selection.ts#L22-L118)。

inbox 也不只是进程内数组。`next-turn` 与 `next-step` 的插入/移除被记录为 `agent/inbox/spliced`，投影在每次已提交 splice 后更新；恢复时从事件重建待处理输入。因此“用户已提交但尚未被 Loop 领取”与“消息已成为模型历史”在持久层可区分。[`Agent` 的 inbox 事件定义](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/types.ts#L28-L82)；[`inbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/inbox.ts#L1-L75)。

Session 投影不是另一本事实账。`SessionProjectionRegistry` 的 unit 折叠已提交事件，为 host/client 提供 `stateOf()` 与同一 cut 的 `snapshot()`；其缓存可以重建，不能替代事件日志作为恢复权威。[`SessionProjectionRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-projection/src/index.ts#L182-L208)；[`snapshot()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-projection/src/index.ts#L330-L350)。

## 五、工具不是 Loop 的内置副作用

### 工具可见性与工具执行是两次独立解析

模型看到的工具 schema 来自当前作用域的注册视图；`ToolRuntime` 将这些 schema 放入 system prompt 组装。执行阶段则是另一条流水线：参数材料化 → `tools/pre-execute` → 审批/guard → `tools/execute` 包裹实际 dispatch → `tools/post-execute` → 规范化结果。某个环节可以拒绝、短路或替换，但不应绕过结果写入与错误归一。[`ToolRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L780-L838)；[`execute()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1332-L1352)；[流水线测试](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/tests/tools.spec.ts#L1048-L1099)。

并发工具执行仍要保持模型可重建的结果顺序：可并行的调用并发启动，但 `tool/result` 按模型原调用次序提交；独占调用形成 barrier，配置的并行上限约束每组。否则一次响应的工具结果会因宿主机调度而产生不同后续 Prompt。[`tool-calls.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/tool-calls.spec.ts#L102-L246)。

审批是工具策略之后、具体副作用之前的一道独立 seam。默认 `ask` 若无 answerer 则 fail closed；`never` 自动拒绝。申请和决议作为一对事件写入正在进行的 turn；离开 turn 的孤立审批会被拒绝，避免恢复时成为无法解释的尾部事实。[`ApprovalService`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/interaction/user-approval/src/index.ts#L41-L73)；[`request()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/interaction/user-approval/src/index.ts#L195-L251)。

工具注册可在 plugin 生命周期内变化，但已经发出的模型请求携带的是当次组装、已记录的 schema；不能把“registry 现在有哪些工具”直接等同于“模型上一步看到了哪些工具”。[`ToolRuntime` 的 schema 组装](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L825-L838)；[`buildRequest()` 的 header 记录](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L606)。这也意味着动态能力变化可能改变模型请求前缀；但对 KV cache 命中率的实际影响需要按 provider 与请求序列测量，不能仅由插件接口推出。

## 六、Environment 是能力提供方的组合，不是 cwd 别名

本版本没有一个唯一的 `EnvironmentRuntime` 类。`cwd` 记录在 Session header 中，并能进入 system prompt 变量；但文件、shell、进程、沙箱分别有服务定义与提供方。替换同一执行世界中的 FS 与 subprocess/shell 提供方，就能让工具落到本机、远程或隔离环境，而无需改写 Agent Loop。[`fs` 服务定义](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/fs/fs/src/index.ts)；[`subprocess` 服务定义](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subprocess/subprocess/src/index.ts)；[`sandbox` 服务定义](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/sandbox/sandbox/src/index.ts)；[`AgentLoop` 的 cwd 变量](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L419-L426)。

这里需要保留边界：替换一个 shell backend 不自动意味着所有路径访问都已隔离。实际环境一致性取决于所装配 FS、shell、subprocess 与 sandbox provider 是否指向同一执行世界；这是组合配置的责任，而不是 `cwd` 字符串保证。[源码的 package 分层](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/AGENTS.md#L14-L61)。

### 子 Agent：运行所有权、能力范围和 Session 血缘分开

`tool-subagent` 并非在父 Loop 内递归调用一次 Prompt。工具调用先确定父 Agent、子模型路由和选择策略，并在真正启动前做预检；请求携带 `parent`、可选 persona、tool filter 与最大深度。foreground 等待结果，one-shot background 交给 Jobs，continuable child 则在输入被接纳后独立拥有后续 turn。不同运行模式共享子 Agent provider seam，但父 Session 不直接写子 Session 的中间历史。[`tool-subagent` 调度](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subagent/tool-subagent/src/index.ts#L463-L567)。

因此至少有三条不同关系：`parentAgent` 是活跃对象的生命周期所有权；preset/scope 限制模型看见的能力；Session header 的 `parentSession`/`delegationDepth` 是持久血缘与预算。把它们压成一个“子 Agent 指针”，会误判恢复后哪些能力仍可用、谁能停止子 Agent，以及子任务结果应写入谁的日志。[`CreateAgentOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L95)。

## 七、恢复与失败：日志不等于外部副作用的精确回放

Session 是 append-only 事实日志，存储服务为每个 Session 提供 read/write handle；write handle 取得单写者所有权，`flush` 是持久屏障。Loop 创建与恢复前都要尊重这个拥有关系；不能由两个活跃 Agent 同时“修复”同一会话。[`SessionPersistence`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-persistence/src/index.ts#L105-L170)；[`resume.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/resume.spec.ts#L451-L535)。

`interruptedTurnClosers()` 为未结束的 step/turn 补充终态。若工具调用已记录但结果未持久化，它生成 `ToolOutcomeUnknownError`，明确告知后续 Agent：不能盲目重试有外部副作用的操作。这里提供的是可解释的恢复，而不是 exactly-once 执行。[`repair.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/repair.ts#L29-L133)。源码中的硬崩溃测试分别验证模型发出前已持久化完整请求，以及工具副作用发生后缺失结果的 unknown 修复；本次仅阅读测试，未亲自运行。[`crash-recovery.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L92-L125)。

持久屏障的安放位置尤其关键。`session-checkpoint-policy` 作为插件拦在 `llm/stream` 前，将已记录的完整请求 `flush` 后才调用适配器；对顶层工具调用，则在 `tools/execute` 前把调用意图 `flush`，随后才允许工具副作用开始；下一次 `agent/pre-step` 会把上一步已提交结果刷盘。也就是说，Loop 本身负责事件结构，checkpoint 插件负责“先持久化，再越过外部效果边界”的时序。[`session-checkpoint-policy/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/src/index.ts#L1-L89)。这比笼统说“Session 支持恢复”更能解释其失败语义。

Session 格式迁移与这套语义相关：旧格式读取时经相邻版本迁移得到当前逻辑事件；持久化提供方负责物理 framing、压缩和 generation 选择，迁移包负责解释事件语义。已提交 generation 不是任意覆盖的缓存。`v2` 把 Assistant stream 紧凑嵌入 settlement；`v3` 使 system prompt 成为历史中的 surface 节点。迁移是为了让新 Runtime 能读旧事实，而不应该被理解为旧日志自动拥有了新 Runtime 的全部行为。[`session-format` 的迁移链](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-format/src/chain.ts)；[`Session` 的 surface 管理](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L446-L465)。

取消也不只是 `AbortController.abort()`。inbox 的 `next-step`/`next-turn` 是记录到 Session 中的 splice 投影；取消可清空或保留尚未领取的工作，运行中的流和已开始工具需收敛到可记录的终态。[`inbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/inbox.ts#L1-L75)；[`cancel.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/cancel.spec.ts#L60-L178)。

## 八、设计原则及代价

1. **组合定义能力，运行时不复制产品分支。** profile 选部署服务，preset 选 Agent 可见能力，入口只驱动共享 Registry/Loop。收益是 Web/SDK/ACP 和子 Agent 复用同一能力边界；代价是诊断必须知道正在使用的 profile、overlay、scope 与服务提供方，单看一个类不足以解释行为。
2. **模型可见事实先记录，再请求。** Session 日志承担重建、审计、fork 和恢复的共同来源。收益是状态解释一致；代价是事件词汇表、格式迁移、投影和持久屏障都变成核心工程问题。
3. **副作用不能被日志伪装成确定结果。** 工具执行前后有策略与 checkpoint，未知结果被明确标为 unknown。收益是避免把崩溃后的未确认动作当作安全可重试；代价是外部副作用仍需工具幂等性、状态核查或人工判断。

上述“收益/代价”是根据源码机制做的架构推论，不是量化比较结论。

## 验证范围与未确认事项

- 已阅读目标提交源码、相关测试和选定历史提交；没有运行真实模型、完整测试套件或崩溃实验。因此测试所声称的行为在本文标为“测试覆盖”，不标为亲自复现。
- 未逐一核对所有 shipped profile、preset、具体 FS/shell/sandbox provider 的实际配置组合；不能据此保证所有部署形态拥有相同审批或隔离策略。
- 尚未测量插件热重载与大量 Session 投影对响应时间、内存和 prompt cache 的影响。
- `dsh-v0.1.5-rc.2` 是开发者预览快照，本文不推断它的 API 或 Session 格式会长期稳定。
