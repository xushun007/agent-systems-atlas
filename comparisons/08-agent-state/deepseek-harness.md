# DeepSeek Harness：Agent State

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. 事实状态属于 Session log

已接纳消息、Turn/Step 边界、请求头、Assistant settlement、tool call/result 和审批均以 Session event 表达。模型上下文与客户端状态从它投影，不反向成为权威。[`Session`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/index.ts#L439-L467)。

## 2. 活跃控制状态属于 ReactLoopAgent

running/idle、当前 AbortController、正在运行的 turn/step、wake latch 和 driver promise 是进程内控制状态；它们不被当作完整对象序列化。恢复时由日志边界和 durable inbox 重建新的控制实例。[`kick()`/`turn()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L213-L349)。

## 3. Capability state 属于插件树与作用域

profile/preset/Agent scope 决定模型看到的工具、Prompt 和策略。Session 可以记录选中的 preset 或策略，但不能仅靠事件恢复已卸载插件代码；恢复时必须重新组装兼容能力。[`AgentPresets`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21)。

## 4. Projection state 是有版本的派生状态

`SessionProjectionRegistry` 增量折叠事件，提供 host state 与 wire snapshot；projection cache 可重建，注册项卸载后相应 key 也从视图消失。[`SessionProjectionRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-projection/src/index.ts#L182-L208)。

## 判断

该项目对事实、控制、能力和投影状态的所有权区分清楚。Environment 外部状态仍不在 Session 内；工具结果只能证明 Runtime 观察到了什么，不能永久证明外部世界仍保持相同状态。
