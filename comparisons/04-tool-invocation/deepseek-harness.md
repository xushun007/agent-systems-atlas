# DeepSeek Harness：Tool Invocation

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. 模型可见工具与可执行工具都按 scope 解析

`ToolRuntime` 维护全局与作用域层；schema 在 Prompt 组装时生成，执行前仍按当前注册与限制解析工具。模型上一步看到工具，不等于工具调用到达时该实现仍存在。[`ToolRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L780-L838)；[`register()`/`restrict()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1027-L1088)。

## 2. 执行是策略流水线

调用经过参数材料化、`tools/pre-execute`、approval/guard、`tools/execute`、工具体、`tools/post-execute` 与结果规范化。策略可以拒绝或短路，工具抛错会转成结构化错误结果，而非直接破坏整个 Loop。[`execute()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1332-L1352)；[流水线测试](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/tests/tools.spec.ts#L1048-L1099)。

## 3. 并行执行不改变提交顺序

并行安全的兄弟调用可并发启动，独占调用形成 barrier；`tool/result` 与附加 Context 按模型调用顺序提交，而非按完成顺序提交。[`tool-calls.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/tool-calls.spec.ts#L102-L246)。

## 4. 审批是可审计且 fail-closed 的 seam

`ask` 无 answerer 时返回 unavailable 并拒绝；`never` 自动拒绝。审批申请和结果必须处于开放 Turn 内并写入 Session；唯一授权结果是 `allowed-once`。[`ApprovalService.request()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/interaction/user-approval/src/index.ts#L195-L251)。

## 5. checkpoint 缩小未知副作用窗口

顶层工具调用在工具体执行前 `flush` 已记录的调用意图。崩溃后若只有 call 没有 result，恢复器标记 outcome unknown，不承诺 exactly-once。[`session-checkpoint-policy`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/src/index.ts#L50-L89)。
