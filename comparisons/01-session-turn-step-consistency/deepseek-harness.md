# DeepSeek Harness：Session / Turn / Step 一致性

分析版本：[`dsh-v0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.2)，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。结论来自源码与测试阅读，未运行真实模型。

## 1. Session 是事实日志和执行身份

`Session` 持有不可改写的事件序列；`Agent.id` 与 `SessionId` 一致。Agent 的进程内生命周期由 `AgentRegistry` 管理，Session 的持久生命周期由 storage handle 管理。恢复 Session 因而不等于恢复旧 Agent 对象，而是重新取得写所有权、修复日志并创建新的运行实例。[`Session`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L439-L467)；[`AgentFactory.resume`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L171-L208)。

## 2. Turn 与 Step 都是显式持久边界

一次 Turn 在领取首条输入前写入 `turn/start`，可包含多个 Step。Step 在输入通过 `agent/pre-step` 后才写入 `step/start`；模型无工具调用、工具声明结束或无法继续时关闭。首次输入被拒绝或改为空，会产生没有 Step 的完整 Turn。[`turn()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L269-L349)。

## 3. 持续输入通过两个 durable inbox 生效

`next-turn` 与 `next-step` 区分“下一轮再处理”和“当前 Turn 的下一步处理”。插入、替换和取消写成 `agent/inbox/spliced` 事件，恢复时由投影重建；消息入队不等于已经进入模型历史。[`inbox projection`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/inbox.ts#L1-L75)。

## 4. 当前 Step 在请求构造时冻结

Prompt 组装先捕获当前模型选择；`prepareCall()` 解析实际路由，随后 system/user/header/context 进入日志，`deriveMessages()` 生成并冻结请求。并发模型切换只影响后续 Step，不会让当前请求使用新模型与旧 Prompt 的混合状态。[`model-selection.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/model-selection.ts#L52-L118)；[`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L627)。

## 判断

DeepSeek Harness 属于显式 Session/Turn/Step 设计，而且把 inbox 也纳入持久事实。它比只保存 transcript 的 Loop 更容易解释恢复和持续输入，但一致性依赖事件词汇、投影与持久屏障共同正确。
