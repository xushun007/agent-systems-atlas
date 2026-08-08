# Codex 上下文生命周期：增量构建、窗口预算与压缩恢复

## 结论

Codex 的上下文不是每轮重新拼接的一段字符串，而是由三个相互配合的平面构成：

1. **稳定指令面**：模型基础指令和本 Step 可见的工具定义，通过 `Prompt` 独立传给模型。
2. **对话历史面**：`ContextManager` 保存用户消息、模型输出、工具调用及结果，并在发起请求前修复调用配对和输入模态。
3. **动态状态面**：`WorldState` 把模型、`AGENTS.md`、权限、环境、扩展等状态结构化；首次注入完整快照，之后只写入相对基线的差异。

历史通常只追加，但压缩、回滚和新建上下文窗口会重写它。每次重写都必须同时处理上下文基线、窗口标识、token 统计和 Rollout checkpoint，否则内存态与恢复态会分叉。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有运行长对话、压缩 API 或恢复实验，实际 Provider 行为仍需实验验证。

## 机制图

- [Codex 上下文生命周期与压缩恢复](../diagrams/codex-context-lifecycle.excalidraw)
- [符号级源码索引](../source-map.md)

图中蓝色是输入与模型协议，紫色是上下文组装，橙色是预算和触发决策，绿色是压缩后的新窗口，灰色是持久化与恢复。

## 1. StepContext 冻结一次采样所需的运行状态

`StepContext` 不是完整对话，而是一次 sampling step 的执行视图。它固定模型信息、权限、执行环境、能力选择、MCP 绑定、工具 Router 以及当前请求加载到的 `AGENTS.md`。Turn 可以包含多个 step；工具执行或环境变化后，下一次 step 会重新建立这份视图。

`build_world_state_for_step()` 再把会影响模型判断的动态信息组织为有稳定 ID 的 section，主要包括：

- 模型、人格和 token guidance；
- 当前时间、执行环境与协作模式；
- `AGENTS.md` 和开发者指令；
- 文件系统、审批和执行策略；
- Apps、Plugins、Extensions、Deferred tools 与多 Agent 状态。

每个 `WorldStateSection` 能渲染完整内容，也能与旧 snapshot 生成 RFC 7386 merge patch。这使 Codex 能区分“当前状态是什么”和“从上一采样点到现在改变了什么”。

## 2. 首次完整注入，后续按基线写入差异

`build_initial_context_with_world_state()` 汇总开发者 fragments、扩展贡献、token budget 元数据、完整 World State 和其他启动提示，形成规范的初始上下文。

`record_context_updates_and_set_reference_context_item()` 决定写入方式：

- 没有 `reference_context_item` 时，写入完整初始上下文，并保存 World State 与 Turn Context 基线；
- 已有引用基线时，只写入 World State diff 和发生变化的 turn contributors；
- 每个 sampling step 前，`record_step_world_state_if_changed()` 再检查并记录 step 内变化。

模型可见的 context item 会先进入 History/Rollout，然后才推进基线。这个顺序保证异常中断后不会出现“基线已经更新，但对应上下文从未持久化”的状态。

## 3. ContextManager 保存事实，for_prompt 生成合法请求

`ContextManager` 以 oldest-first 的 `Vec<ResponseItem>` 保存会话事实，并使用 copy-on-write clone 支持构建临时 Prompt。`record_items()` 只接收可作为 API 消息的项目，并按模型截断策略处理过大的工具输出。

真正发给模型之前，`for_prompt()` 会在克隆历史上做协议级规范化：

- 保持 function/custom tool call 与 output 成对；
- 删除失去对应调用的孤立 output；
- 对不支持的图片或音频输入降级或移除；
- 不把 `System` 和内部 `CompactionTrigger` 当作普通历史消息发送。

因此 Rollout 中的原始记录、内存中的规范历史和最终 API input 是三个相关但不完全相同的表示。

## 4. Prompt 由历史、基础指令和工具面组成

每个 sampling step 的核心路径为：

```text
刷新 StepContext / World State
→ 克隆 ContextManager
→ for_prompt() 规范化历史
→ build_prompt()
→ Prompt { input, base_instructions, tools, parallel_tool_calls }
→ ModelClientSession.stream()
```

模型输出和工具结果通过 `record_conversation_items()` 追加回 History 与 Rollout，再驱动下一次 sampling。运行期间到达的 steer/pending input 只在受控边界排入历史，避免打断正在进行的模型—工具闭环。

`ModelClientSession` 只在一个 turn 内复用 WebSocket、sticky routing token 和 `previous_response_id`。只有当新请求保留前一次请求的属性且 input 是其增量扩展时，才发送增量 payload；跨 turn 会创建新 session，防止把上一 turn 的路由状态带入下一 turn。这是传输优化，不是对话历史的权威存储。

## 5. token 预算结合服务端统计与本地估算

`ContextManager::get_total_token_usage()` 以最近一次服务端 token usage 为锚点，再估算此后本地追加项目的 token。若服务端没有纳入旧 reasoning 内容，本地统计会补上对应估算。

窗口判定同时受两个上限约束：

- **模型完整 context window**：始终是硬上限；
- **auto compact limit**：可以按 `Total` 计算，也可以按 `BodyAfterPrefix` 扣除本窗口的 prefill baseline 后计算正文。

`context_window_status()` 取两个剩余量中的较小值。Token Budget 还可以在窗口内一次性注入提醒或 fallback prompt；这些标志与 prefill baseline 都保存在 `AutoCompactWindow`，进入新窗口后重置。

## 6. 压缩可能发生在 turn 前，也可能发生在 turn 中

Codex 有多条压缩入口：

| 触发点 | 原因 | 初始上下文处理 | 后续行为 |
| --- | --- | --- | --- |
| Pre-turn | 已达到 token limit | `DoNotInject` | 下一次正常构建重新完整注入 |
| Pre-turn | 模型 `comp_hash` 不兼容或切换到更小窗口 | `DoNotInject` | 必要时先尝试旧模型压缩，再回退当前模型 |
| Mid-turn | 模型/工具仍需 follow-up 且达到上限 | `BeforeLastUserMessage` | 先恢复压缩后的 continuation，再接收 steer |
| Manual | 用户显式请求 compact | `DoNotInject` | 形成新窗口 |
| New context | 显式请求空白窗口 | 只构建规范初始上下文 | 不保留摘要或旧消息 |

Pre-turn 检查发生在本轮新输入写入之前，源码中的 TODO 也明确指出：当前判定尚未把 pending user input 纳入估算。这个边界可能造成接近上限时的短暂低估。

## 7. 三种压缩策略共享同一个安装边界

### 7.1 Local compaction

Local 路径把当前历史和总结提示交给模型。若请求超过 context limit，会成对移除最旧的 call/output 后重试。得到 summary 后，它保留最近的真实用户消息（最多约 20k token），再以 user message 形式追加带前缀的 summary。

### 7.2 Remote compaction

Remote 路径调用 `/responses/compact`，过滤陈旧的 developer item 和非真实 user 内容，并可在 Provider/模型允许时使用 fallback model。服务端返回的 compacted items 成为新的历史候选。

### 7.3 Remote compaction v2

V2 先按约 64k token 预算从新到旧保留 user/system/developer 及符合条件的 agent message，再追加一个 `Compaction` item，请求远端压缩；流式失败最多重试两次。

三条路径最终都进入 `replace_compacted_history()`。差别在“如何生产新历史”，而不是“如何安装新历史”。

## 8. Mid-turn 压缩必须把规范上下文放回正确位置

`InitialContextInjection` 显式表达两个时序：

- `DoNotInject`：pre-turn/manual 压缩后暂不注入；下一次普通 turn 因基线被清除而注入完整上下文；
- `BeforeLastUserMessage`：mid-turn 压缩时，把当前规范初始上下文插入最后一条真实 user message 或 summary 之前，使 summary/用户目标仍位于输入尾部并能立即 continuation。

这不是简单的“summary 替换全部历史”。压缩后的排列需要同时兼顾长期指令、最近用户意图和下一次采样位置。

## 9. 历史重写是一个事务式边界

`replace_compacted_history()` 执行一组必须同步发生的状态变化：

1. 为缺少 ID 的 item 分配稳定 ID；
2. 替换内存中的 `ContextManager` 历史并增加 `history_version`；
3. 推进 auto compact window，记录 previous/current window ID 与窗口序号；
4. 持久化包含完整 replacement history 的 `RolloutItem::Compacted`；
5. 保存新的 World State baseline 和 Turn Context snapshot；
6. 重新计算 token usage，并排入来源为 Compact 的 session-start 事件。

Rollout 恢复遇到 `Compacted` 时以 replacement history 为 checkpoint，而不是把压缩当作普通追加事件。`history_version` 也让 Guardian 等持有 transcript cursor 的消费者识别缓存是否因历史重写而失效。

## 10. 新建上下文窗口不等于压缩

`start_new_context_window()` 只保留当前规范初始上下文，不生成 summary，也不携带旧对话；随后仍通过 `replace_compacted_history()` 安装新的窗口状态。两者共享窗口切换和持久化机制，但语义不同：

- compact：保留一份对过去的压缩表示；
- new context：主动放弃过去，只继承当前配置和运行环境。

## 关键设计约束

1. **历史与状态分离**：对话事实存于 History，易变运行状态存于 World State。
2. **完整快照与差异共存**：首次注入可独立理解，后续 diff 降低重复上下文成本。
3. **传输缓存不是事实来源**：`previous_response_id` 只优化同一 turn 的增量请求，Rollout/History 才负责恢复。
4. **压缩是历史重写**：必须同步失效游标、更新基线、推进窗口并写 checkpoint。
5. **自动压缩仍受模型硬窗口约束**：配置的 compact limit 不能越过模型完整 context window。
6. **新窗口与摘要语义分离**：共享安装机制不意味着保留相同信息。

## 测试证据

本次重点核对了以下测试区域：

- `core/src/session/tests.rs`：初始上下文注入、基线清除后的重新注入、新窗口 ID 与持久化；
- `core/src/context_manager/history.rs` 内测试：call/output 配对、模态清理、token 估算和历史移除；
- `core/src/compact_tests.rs`：local summary、最近用户消息保留和 mid-turn 初始上下文位置；
- `core/src/compact_remote_v2.rs` 内测试：retained history 的 token 预算与消息筛选；
- `core/src/session/rollout_reconstruction.rs` 内测试：Compacted checkpoint 与恢复后的 live history 一致性；
- `core/src/client.rs` 内测试：WebSocket 请求属性匹配、增量 input 和跨 turn session 边界。

这些测试作为源码行为证据被阅读，本次没有在本地执行。

## 未确认事项

- 尚未测量真实长会话中 World State diff、prompt cache 命中率与 token 节省比例。
- 尚未对比 local、remote、remote-v2 摘要的信息保真度和延迟。
- Provider 对 `previous_response_id`、缓存 token 与远端 compaction 的具体实现属于服务端边界，源码只能确认客户端契约。
- Realtime、Guardian review 和子 Agent 对父会话 Context 的投影需要分别展开分析。
