# DeepSeek Harness：Model Runtime

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. Provider 路由在模型可见输入提交前解析

`agent/request` 先提出配置，`llm.prepareCall()` 解析实际 adapter、默认值、context window 与 system-prompt 能力；之后 Loop 才提交 system/user 输入和 request header。准备阶段取消不会留下一个模型从未看到的已接纳请求。[`prepareRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L503-L548)。

## 2. 请求冻结由 Session 历史提供证明

resolved header 与 request context 写入日志，`deriveMessages()` 得到历史，所有消息和请求对象随后被冻结。重试保留首次接纳内容，但生成新的 Assistant attempt。[`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L627)。

## 3. 流式 UI 与持久 settlement 分离

`agent/assistant-stream` 提供 start/chunk/end 的实时观察；完整 `assistant/message` 或失败的 `assistant/attempt` 才持久化。未 settlement 的硬崩溃流片段不能假定已保存。[`Assistant stream loop`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L393-L486)。

## 4. 模型切换在下一 Step 生效

模型选择在 Prompt 组装时捕获，同一捕获值进入 request waterfall；并发切换不会拆分当前 Step。provider/model 改变会向下一次接纳请求增加持久切换通知。[`installModelSelection()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/model-selection.ts#L52-L118)。

## 判断

其 Model Runtime 把“选择”“路由准备”“请求冻结”“流 settlement”分成四个时点。源码可证明请求前缀变化，不能证明具体 Provider 的 KV cache 命中率。
