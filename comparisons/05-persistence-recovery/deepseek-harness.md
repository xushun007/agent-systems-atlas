# DeepSeek Harness：Persistence / Recovery

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. 事件日志是事实源，Projection 是可重建视图

Turn、Step、请求头、用户消息、Assistant settlement、工具调用与结果均进入 Session；`SessionProjectionRegistry` 从事件折叠 inbox、边界和客户端视图。Projection cache 可以重建，不获得事实权威。[`Session`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L439-L467)；[`SessionProjectionRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-projection/src/index.ts#L182-L208)。

## 2. 持久化用单写者 handle 表达所有权

`SessionPersistence.open(id, 'write')` 原子取得写所有权，已有 owner 时拒绝；read handle 不夺取所有权。`flush` 是持久屏障，而不是普通日志调用。[`SessionPersistence`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-persistence/src/index.ts#L105-L170)。

## 3. 恢复补齐终态，不盲目重放副作用

未闭合的 Turn/Step 获得 interrupted closer；已记录、结果缺失的工具调用被标为 `ToolOutcomeUnknownError`。恢复后的模型能看到不确定性，但 Runtime 不伪造失败或成功。[`interruptedTurnClosers()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/repair.ts#L29-L133)。

## 4. 外部效果前设置语义 checkpoint

模型请求前持久化完整请求，顶层工具副作用前持久化 call；硬崩溃测试覆盖这两个窗口。[checkpoint policy](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/src/index.ts#L50-L89)；[crash recovery tests](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L92-L125)。本次未运行该测试。

## 判断

DeepSeek Harness 是事件溯源型恢复设计，但不提供端到端 exactly-once。它明确记录未知效果，要求恢复者对账或依据幂等性决策。
