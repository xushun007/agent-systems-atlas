# DeepSeek Harness：Context Engineering

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. Context 由作用域化注册项组装

`SystemPrompt` 管理有序 section、动态 context、工具 schema 与变量；全局注册、preset scope 和 Agent scope 共同决定当次组装结果。Context 因而是一次请求的 projection，不是 Session 上持续修改的字符串。[`SystemPrompt`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/system-prompt/src/index.ts#L359-L455)。

## 2. 模型历史来自 Session surface

Loop 先把接纳的 system/user 输入和请求头写入 Session，再通过 `deriveMessages()` 得到模型历史。模型可见信息必须能从日志重建；实时 UI stream 和插件内部对象不能悄悄成为模型输入。[`deriveMessages()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L811-L832)；[`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L627)。

## 3. 动态 Context 以快照进入 Step

`preStep()` 组装 Prompt，并把 runtime context 投影为一条待接纳消息。当前 Step 完成组装后，模型、工具和历史在请求构造时冻结；后续 registry 或模型选择变化影响后续 Step。[`preStep()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L232-L267)。

## 4. Tool result 与额外 Context 分开排序

并行工具可以并发执行，但结果和工具产生的 additional contexts 按模型调用顺序进入历史，避免宿主机完成顺序改变下一次 Prompt。[`tool-calls.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/tests/tool-calls.spec.ts#L223-L409)。

## 判断

其 Context Engine 的关键不是摘要算法，而是“作用域组合—日志接纳—请求冻结”三段式边界。Compaction 仍是插件能力；压缩质量与信息损失不能仅由核心 Loop 源码证明。
