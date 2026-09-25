# DeepSeek Harness：Observability / Evaluation

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. Session event 是事实，`agent/*` 是运行观察

`turn/*`、`step/*`、request、message 和 tool events 进入 Session；`agent/pre-step`、`agent/request`、`agent/assistant-stream` 等是进程内扩展点。流式 chunk 可用于 UI，但只有 settlement 进入持久日志。[`turn()`/`step()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L269-L486)。

## 2. 关联主键来自 Session、Turn、Step 和 call identity

SessionId 也是 Agent identity；Turn/Step 序号写入事件，tool call/result 通过 call id 配对，Assistant attempt 具有独立 attempt/stream revision。这样可以重建一条执行轨迹，但进程 trace span 仍是另一种观察结构。

## 3. Projection 是客户端观察，不是第二套事实

投影 registry 增量折叠同一日志，并提供一致 cut 的 snapshot。UI、API 和统计可以共享投影，但不应把 projection cache 当 recovery checkpoint。[`snapshot()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-projection/src/index.ts#L330-L350)。

## 4. Snapshot tests 验证产品输出，crash tests 验证恢复窗口

上游区分单元测试、录制 Session snapshot 与硬崩溃恢复测试。后者验证请求在模型 dispatch 前、tool call 在副作用前已持久化。[`crash-recovery.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L92-L125)。

## 5. Evaluation 仍需外部验收事实

Session 能解释模型与工具发生了什么，却不能仅凭轨迹证明代码正确、Workspace 达到目标或外部副作用成功。任务级评价仍需测试、diff、服务查询或人工标准；本文未发现核心 Loop 把这些统一为一个权威成功分数。
