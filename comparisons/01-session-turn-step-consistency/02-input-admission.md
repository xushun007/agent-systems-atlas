---
title: 执行中的用户输入：Coding Agent 的接纳、排队与生效边界
series: Coding Agent 的 Session / Turn / Step：状态所有权与一致性模型
part: 2
reviewed_at: 2026-09-16
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: true
  runtime_experiment_scope: Pi original Agent and loop with scripted model responses and controlled in-memory tools
  provider_transport_experiment: false
  end_to_end_experiment: false
---

# 执行中的用户输入：Coding Agent 的接纳、排队与生效边界

Coding Agent 在执行期间接收新输入，需要解决两个独立问题：这项操作应当影响哪一轮工作，以及它应当从哪个执行边界开始生效。接收成功只能说明某个入口接受了操作，不能单独证明正在进行的推理或工具调用已经采用它。

[第一篇](01-state-ownership.md)将状态所有权分解为身份归属、写入责任、可见性边界和生命周期。本篇沿着一条输入进入执行的过程，研究接纳、排队、steer、撤回及配置更新的具体语义。

本文使用三组实现证据：Pi `v0.85.1` 的底层 Agent 与循环、Kimi Code `v0.40.0` 的 v2 Prompt 服务，以及 Codex `rust-v0.154.0` 的 Turn 输入处理。Pi 部分包含七组已运行的受控实验；Kimi 与 Codex 部分依据源码和上游测试阅读。

## 1. 输入生效需要明确观察边界

“新要求已经生效”至少可以指三件不同的事：Runtime 已经把要求分配给目标执行，模型请求已经包含该要求，或工具行为已经符合该要求。研究时需要分别判断。

本文以**输入首次进入目标模型调用**作为文本要求可见性的观察边界。对于网络模型，还需继续核对提供商适配、序列化和实际发送过程。模型是否遵循要求属于后续行为，不能由输入可见性直接推导。

接纳（admission）则发生在更早的控制阶段。它决定输入能否进入执行系统，以及采用哪种处理方式：启动新工作、等待现有工作结束、补充活跃工作，或拒绝当前不适用的操作。接纳时至少涉及目标身份、活跃状态和操作类型；具体校验项由实现决定。

假设模型已提出两个工具调用，用户在第一个工具运行时追加“不要继续修改文件”。Runtime 可以接受这条消息并安排后续推理，但第二个工具是否继续执行，还取决于工具调度和取消机制。文本内容本身不能替代一个明确的取消操作。

因此，需要区分两条路径：输入进入模型的路径，以及控制信号改变当前执行的路径。二者可以协作，但不必具有相同的生效时点。

## 2. 排队、steer 与 interrupt 的不同语义

在持续交互中，普通消息、审批回复和停止操作可能由同一个界面提交，进入 Runtime 后却作用于不同对象。

| 操作 | 主要作用对象 | 典型生效条件 |
| --- | --- | --- |
| 排队输入 / follow-up | 后续工作或后续推理序列 | 当前工作达到允许接续的边界 |
| steer | 活跃执行的后续上下文 | 到达可读取追加输入的推理边界 |
| 撤回待处理输入 | 尚未应用的队列项 | 队列项仍处于可撤回状态 |
| interrupt / cancel | 活跃执行及其取消信号 | 执行路径观察并处理取消 |
| 审批或提问回复 | 已登记的等待对象 | 回复与等待对象成功匹配 |
| 配置更新 | 会话设置或执行设置 | 后续执行重新读取或捕获配置 |

表中是分析分类，不是各项目统一遵守的协议。尤其需要避免把 steer 一律解释为“立即中断”：它可以只改变下一次推理输入，也可以配合特定工具的提前返回机制。

Pi 的底层 Agent 明确提供 `steer()` 与 `followUp()` 两个入口，分别写入不同队列；`abort()` 则触发活跃运行的取消信号。三个方法没有合并为同一种消息处理。[^pi-agent]

这一区分直接影响用户意图的表达。“后续工作补充一项要求”与“停止当前动作”是不同操作。若产品希望一条输入同时承担两种作用，需要在接纳和执行层明确规定组合语义。

## 3. Pi 实验：同一提交时点，不同可见时点

### 3.1 实验方法与观察范围

实验直接调用 Pi 原始 `Agent`、执行循环、事件流和工具参数校验实现，以预设响应替代模型服务。首次响应固定返回两个工具调用，工具按顺序执行。第一个工具启动后停在一个 Promise 屏障上；实验驱动此时提交追加输入，再释放工具。第二次及后续模型响应固定为不含工具调用的结束文本。

每次模型适配函数 `streamFn` 被调用时，实验立即复制其 model 与 context 参数。记录内容因此不受后续消息追加影响。工具只写入实验内存日志，不修改文件。

该方法验证 Runtime 传给模型适配函数的输入及调用顺序，无需 API Key。它没有运行真实提供商适配器或网络传输，也不验证模型遵循指令的能力。完整脚本、环境和结果见[实验记录](../../experiments/session-turn-step-consistency/pi-input-boundaries/README.md)。

Pi 此处的底层 `turn` 对应一次 assistant 响应及其工具处理，不能直接等同于 Codex 中可以包含多次采样的用户可见 Turn。以下统一使用“第几次模型调用”和“当前运行”，避免名称造成误解。

### 3.2 steer 在工具批次完成后进入下一次调用

在第一个工具等待期间调用 `steer()`，实验观察到以下顺序：

| 顺序 | 事件 | 追加要求的状态 |
| --- | --- | --- |
| 1 | 第一次模型调用产生两个工具调用 | 尚未提交 |
| 2 | 第一个工具进入等待 | 尚未提交 |
| 3 | 提交 steer | 已进入 steering 队列 |
| 4 | 释放第一个工具，随后第二个工具完成 | 尚未交给模型适配函数 |
| 5 | 第二次模型调用 | 输入包含追加要求及前一批工具结果 |

两个工具均在第二次模型调用前完成。steer 没有取消尚未开始的第二个工具，也没有重新解释已经生成的工具参数。

源码解释了这一顺序：循环先完成 assistant 响应中的工具调用，记录工具结果并发出 `turn_end`，再读取 steering 队列；下一轮循环将读取的消息追加到上下文，随后构造模型调用。上游也有“所有工具完成后注入排队消息”的对应测试。[^pi-loop] [^pi-test]

这一结果限定于本次被测的普通工具批次及调度路径，不代表所有工具都必须等到自然结束，更不能推导出其他项目的 steer 行为。

### 3.3 follow-up 等待当前工作达到结束边界

在相同位置改用 `followUp()`，前两个工具仍然完成，但第二次模型调用没有包含追加输入。该调用消费工具结果并返回结束文本，随后循环才读取 follow-up 队列，发起包含追加输入的第三次调用。

Pi 的内层循环负责工具继续执行和 steering 输入，外层在内层退出后检查 follow-up。由此形成了两种不同的接续规则：steer 可以改变当前工作的后续推理；follow-up 保留当前工作的推进，等其本来可以结束时再处理新输入。[^pi-loop]

这里的等待条件是循环状态，而不是“已经等待若干秒”。响应时间取决于到达该边界之前尚需完成多少工作。

同时，这一接续以循环继续运行并检查队列为前提。源码中的错误、取消和 `shouldStopAfterTurn` 路径可以在队列检查之前退出；不能从正常路径实验推导出所有已排队输入都必然在同一次运行中被消费。[^pi-loop]

## 4. 队列策略同时影响顺序与输入组合

接纳顺序只解决先后关系，还需要决定一次执行消费多少输入。

Pi 的队列支持 `all` 与 `one-at-a-time`。实验在同一个工具屏障处依次提交两条 steer：保持接口兼容、增加回归测试。结果如下：

| 排空策略 | 第二次模型调用 | 第三次模型调用 |
| --- | --- | --- |
| `all` | 同时包含两条要求 | 未发生 |
| `one-at-a-time` | 仅加入第一条要求 | 在已有上下文上加入第二条要求 |

消息在两个策略下都保持原来的相对顺序，但第一次继续推理时可见的要求集合不同。对于相互依赖或相互修正的要求，逐条消费与批量消费可能产生不同的推理过程。实验只证明输入组合不同，不评价哪种方式生成结果更好。

Pi 默认底层队列使用 `one-at-a-time`；宿主可以显式选择其他模式。队列的 `drain()` 要么取出全部待处理消息，要么只取出最早的一条。[^pi-queue]

因此，产品若声称“按顺序处理输入”，还应明确顺序适用于哪个范围，以及是否允许合并。单一队列内部的 FIFO 不等于多个客户端之间的全局顺序，也不意味着输入接纳顺序与工具完成顺序一致。

## 5. Kimi：steer 是一次执行归属转换

Pi 的独立队列便于观察可见性。Kimi v2 的 Prompt 服务则展示了另一项责任：已经排队的输入如何转入活跃执行。

`AgentPromptService.enqueue()` 为输入维护身份、状态及启动和完成句柄。已有活跃 Prompt 时，后续输入保存在 pending 队列；`steer(promptIds)` 可以选择其中若干输入，交给活跃 Turn。[^kimi-prompt]

### 5.1 选择输入不等于直接拼接上下文

Kimi 的 steer 路径包含以下控制步骤：

1. 检查活跃 Prompt，校验被选 ID 均属于 pending 队列且没有重复。
2. 按原队列顺序选取输入，准备合并消息及相关附件。
3. 异步准备完成后，再次确认被选输入仍在队列中，活跃 Prompt 也未变化。
4. 暂时移出所选输入，提交 `SteerStepRequest`，等待 Loop 分配执行归属。
5. 分配失败或目标发生变化时，恢复原队列位置；成功后才更新所选 Prompt 的状态及归属。

二次检查用于处理异步准备期间的状态变化。恢复原位置则避免一次失败的归属转换顺带改变后续执行顺序。这里的原子性只应在具体检查和状态转换范围内讨论，不能扩大为整个流程具有存储事务保证。

上游测试分别覆盖了目标 ID 校验、按 FIFO 顺序选择输入、失败后恢复队列位置，以及活跃 Turn 恰好结束时重新推进队列。本专题阅读了这些测试，但没有把它们计为本地运行通过。[^kimi-tests]

### 5.2 分配完成仍然早于上下文应用

`SteerStepRequest` 默认要求活跃 Turn，支持合并。在请求被物化时，回调记录 `TurnSteer`；Loop 随后解析并追加上下文消息，再标记请求已物化。[^kimi-request]

因此，Prompt 层归属转换与 Loop 层上下文应用仍是两个边界。记录 steer 意图、得到 Turn 身份或观察到某个控制事件，都不能单独证明模型适配函数已经收到该输入。

事件名称也不能替代源码中的发出位置。一个事件可以标记开始处理、完成分配或准备应用；只有沿着调用顺序核对其含义，才能用它解释输入可见性。

## 6. Codex：目标身份与输入消费时点分别约束

Codex 的 `steer_input()` 检查活跃任务和目标 Turn。调用方提供预期 Turn ID 时，如果当前活跃身份不一致，操作会被拒绝；成功时则将输入加入该 Turn 的待处理队列。[^codex-admission]

预期身份检查解决的是“这条输入是否仍然作用于原目标”。客户端观察到 Turn A 后提交 steer，而处理该操作时活跃执行已经变化，不能仅以“目前有一个任务在运行”作为正确归属的依据。此处应按入口约定拒绝、排队或重新提交，不能隐式假设新目标与旧目标等价。

目标确定之后，`run_turn()` 仍然决定何时消费 pending input。源码在构造下一次模型请求之前读取输入并执行相关 Hook，但通过 `can_drain_pending_input` 对读取时点作限制。Turn 初始输入通常先被采样；自动压缩后，如果模型和工具还需要继续衔接，也可能先恢复该继续路径，再读取追加输入。[^codex-drain]

因此，“已接纳到当前 Turn”不能无条件改写为“下一次模型请求一定包含它”。需要检查接纳之后实际经过的采样、压缩及继续执行分支。

### 6.1 特定工具可以缩短等待时间

steer 不自动取消普通工具批次，但工具也可以主动监听输入变化。Codex 的 `wait_agent` 订阅输入活动，在收到新输入后结束等待，返回相应结果。上游测试进一步检查：后续模型请求同时包含追加输入和“等待被新输入打断”的工具结果。[^codex-wait]

这个例子表明，可见性延迟不仅取决于循环在哪里检查队列，还取决于当前工具能否及时返回。它不证明任意 shell 命令都采用相同机制，也不证明新输入触发了通用的进程取消。

从架构上看，循环消费边界和工具响应机制共同决定执行中交互的延迟。只分析 Prompt 队列，会遗漏后一部分。

## 7. 准备阶段和配置更新也具有生效边界

### 7.1 输入可能在两次推理之间到达

准备上下文、压缩历史或刷新能力可能耗时。若只在准备阶段之前读取一次队列，期间到达的输入就可能错过即将发起的请求。

Pi 在 `prepareNextTurn` 返回后，如果先前尚未取得 steering 消息，会再次读取队列。本次实验将准备回调暂停，在此期间提交 steer，释放后观察到追加输入进入第二次模型调用。[^pi-loop]

源码还限制了重复读取：如果之前已经取到了消息，准备阶段之后就不再额外取一批。这使 `one-at-a-time` 不会因为一次请求前发生两次队列检查而实际注入两条输入。

因此，增加输入检查点也需要保留队列策略的约束。检查频率与每次请求允许消费的数量是两个独立参数。

### 7.2 配置对象更新不等于活跃执行重新读取

在工具等待期间，将 Pi 的 `agent.state.model` 从 `model-a` 替换为 `model-b`，实验得到两种结果：

| 实验设置 | 状态对象中的模型 | 下一次模型调用 |
| --- | --- | --- |
| 未提供准备回调 | `model-b` | 仍使用 `model-a` |
| 准备回调显式返回更新后的模型 | `model-b` | 使用 `model-b` |

原因是 Agent 创建活跃循环时构造了一份配置；后续推进通过 `prepareNextTurn` 的返回值更新循环配置。状态对象的字段替换本身不会重写先前捕获的配置。[^pi-config]

该实验描述的是底层 Agent 的更新路径，不能作为 Pi CLI 模型切换失效的证据。宿主可以安装更新回调，其他 Runtime 层也可能采用不同的设置同步机制。

Codex 则明确使用 `ResolvedStepSettings` 表达捕获的设置版本，源码说明替换该快照不会改变已经捕获旧版本的 Step 或动作。[^codex-settings] 两种实现都要求区分“修改可供选择的配置”和“某次执行实际选择了该配置”，但具体捕获边界需要分别核对。

## 8. 审批、撤回和取消需要独立的控制路径

文本输入通过后续推理生效；审批回复的直接作用通常是解除一个具体执行等待。两者即使最终都会进入会话记录，也不适合仅用同一条消息队列解释。

Codex 的 Turn 状态分别保存审批、权限申请、用户提问等等待对象。权限回复路径按调用身份取回原等待项，并依据原申请绑定的环境处理结果。[^codex-approval] 这类身份关联是解释“本次回复授权了哪项操作”的起点；仅在聊天历史中出现“允许”不足以证明对应等待对象已经获得授权。

撤回与取消也不同。Kimi 的 `abort(promptId)` 对 pending Prompt 从队列移除并完成其取消状态；对活跃 Prompt 则调用 Loop 的取消入口。[^kimi-abort] 前者阻止尚未启动的输入继续推进，后者需要执行层处理已经开始的工作。

本文只讨论这些操作如何进入控制路径。取消信号如何传递到工具进程、迟到结果如何归属、哪些副作用仍会保留，属于后续中断专题，不能根据“取消入口返回成功”直接推断。

增加可信目录或改变权限模式同样应按配置和策略更新分析。目录更新是否影响已经生成的工具调用、是否重新触发检查，以及模型上下文何时反映变化，需要检查具体的执行前策略逻辑；本文没有验证这些行为。

## 9. 输入处理应向调用方提供什么保证

上述实现差异可以归纳为四项需要明确的接口约定。这些是比较与设计要求，不表示所有项目均已提供对应保证。

**接纳结果应说明目标。** 调用方需要能够区分新执行、活跃执行追加、排队和拒绝。若操作指定了目标身份，应定义目标失效后的处理方式。

**排队规则应说明消费方式。** 顺序、合并和优先级分别影响哪些要求共同进入一次推理。队列顺序还应与重定向失败后的恢复规则保持一致。

**完成通知应说明所处阶段。** 已接收、已分配、已应用到上下文、已调用模型适配器、已产生结果具有不同语义。通知不必覆盖全部阶段，但不能以含混的“成功”代替其实际承诺。

**退出路径应说明未消费输入的处置。** 当前工作结束、失败或取消之后，队列项是保留、转交、撤回还是报错，需要能够被调用方观察。本文的正常路径实验不覆盖所有退出情况。

输入标识、目标执行身份和顺序信息为这些保证提供追踪依据，但它们本身不构成去重协议。多客户端重试、重复提交和持久化接管仍需单独分析。

## 10. 结论与验证范围

执行中输入的可见性由接纳规则和执行边界共同决定。Pi 的受控实验显示，steer、follow-up 以及不同队列排空策略会使同一时点提交的要求进入不同模型调用；模型配置更新也需要明确的读取路径。

Kimi 的实现进一步展示了排队输入转入活跃执行时的身份检查、顺序保持和失败恢复；Codex 则分别约束目标 Turn 和 pending input 的消费时点，并允许特定等待工具提前响应新输入。这些机制解决的问题相关，但不能直接互换为同一种“即时输入”语义。

本篇验证的是原始 Runtime 在受控条件下的输入调度。它没有使用真实模型 API，也没有验证生产客户端到模型服务的完整链路。后续可在相同屏障时序下接入真实提供商，分别捕获适配函数参数、实际出站请求和工具结果；模型遵循指令的质量需要另设评价标准。

第三篇将进一步讨论一次 Step 应捕获哪些执行条件，以及模型看到的能力与工具实际执行的条件如何保持对应。

## 版本与证据

研究日期：2026-09-16。源码链接固定到以下 commit。

| 项目 | 版本与 Commit | 本篇证据范围 |
| --- | --- | --- |
| Pi | `v0.85.1` / `d981de1229ef899957bbe968bc8dcda02a21f477` | 原始底层 Agent 与 loop 的七组受控实验；源码和上游测试阅读 |
| Kimi Code | `v0.40.0` / `e27ee60894d714e5844db75da69f29120a2bce43` | v2 Prompt 与 Loop 源码、测试阅读；未运行完整 Prompt 测试 |
| Codex | `rust-v0.154.0` / `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` | 接纳、采样、等待工具、设置及权限回复源码和相关测试阅读 |

Pi 实验通过窄导出适配加载原始工具校验和事件流，未运行完整包入口、CLI 或 v4 durable harness。模型和工具行为由实验驱动固定；详细适配方式和未验证范围见[实验记录](../../experiments/session-turn-step-consistency/pi-input-boundaries/README.md)。

本篇没有重跑第一篇被依赖加载阻断的 Kimi 完整 Loop 测试，不改变其验证状态。其他证据见[专题索引](evidence.md)。

[^pi-agent]: Pi [`steer()`、`followUp()` 与 `abort()`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L282-L321)。
[^pi-loop]: Pi [`runLoop()`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)，以及[模型适配函数调用前的上下文转换](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L279-L311)。
[^pi-test]: Pi [工具批次完成后注入消息的测试](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/agent-loop.test.ts#L679-L783)。本篇运行的是专题实验脚本，上游测试作为源码证据阅读。
[^pi-queue]: Pi [`PendingMessageQueue`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L125-L160)，以及[构造时的默认模式](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L214-L238)。
[^pi-config]: Pi [`createLoopConfig()`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L445-L485) 和[准备快照测试](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/agent-loop.test.ts#L1031-L1105)。
[^kimi-prompt]: Kimi [`enqueue()` 与 `steer()`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L299-L443)。
[^kimi-tests]: Kimi [身份与 FIFO 测试](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/test/agent/prompt/promptService.test.ts#L187-L231)、[失败后恢复原位置](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/test/agent/prompt/promptService.test.ts#L388-L402)、[活跃 Turn 结束与 steer 分配交错的测试](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/test/agent/prompt/promptService.test.ts#L520-L552)。测试使用 stub loop，不等同于完整模型链路测试。
[^kimi-request]: Kimi [`SteerStepRequest`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptStepRequests.ts#L64-L94) 和[`materializeRequest()`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832)。
[^kimi-abort]: Kimi [pending 与 active Prompt 的取消处理](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L445-L459)。
[^codex-admission]: Codex [`steer_input()`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input.rs#L510-L603)，以及[steer 要求活跃 Turn 的测试](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input_tests.rs#L838-L866)。
[^codex-drain]: Codex [`run_turn()` 的输入消费门控](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404)，以及[压缩后的继续条件](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L530-L550)。
[^codex-wait]: Codex [`wait_agent` 对输入活动的订阅与结果处理](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)，以及[steer 提前结束等待并进入后续请求的测试](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/tests/suite/pending_input.rs#L574-L639)。
[^codex-settings]: Codex [`ResolvedStepSettings`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L20-L51)。
[^codex-approval]: Codex [Turn 级等待对象](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/state/turn.rs#L88-L124)，以及[按调用身份处理权限回复](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)。
