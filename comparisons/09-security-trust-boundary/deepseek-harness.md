# DeepSeek Harness：Security / Trust Boundary

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。静态分析不能证明实际部署已正确隔离。

## 1. 模型的工具建议不携带 Authority

模型只产生 tool name 与 arguments。Runtime 再按 Agent scope 解析工具，执行 `pre-execute`、approval 和 monotonic guards；策略拒绝不能被后续 wrapper 重新放宽。[`ToolRuntime` policy pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1332-L1469)。

## 2. Approval 默认 fail closed

`ask` 没有可用 answerer 时得到 unavailable，`never` 自动拒绝；只有 `allowed-once` 是授权。问答对写入当前 Turn，防止无法归属的授权在恢复后漂移。[`ApprovalService`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/interaction/user-approval/src/index.ts#L41-L73)。

## 3. Sandbox 与 FS/Shell 是不同边界

Sandbox 包装进程启动不自动限制所有文件访问；FS policy、shell/subprocess provider、网络与凭据插件必须分别组合。仅看到 sandbox plugin 不能推断完整 Environment 已隔离。[包分层说明](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/AGENTS.md#L14-L61)。

## 4. 子 Agent 权限由 scope/filter 重新确定

delegation 请求可以建议模型、persona 和执行模式，但 Runtime 通过 model-selection policy、tool filter、preset setup 与最大深度限制 child；父 Agent 的活跃对象所有权不等于 child 继承父亲全部能力。[`tool-subagent`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subagent/tool-subagent/src/index.ts#L463-L530)。

## 5. 恢复拒绝伪造副作用结论

工具 call 已持久化但 result 缺失时，Runtime 标记 outcome unknown。它不因日志存在 call 就把操作视为失败、成功或安全可重试。[`repair.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/repair.ts#L78-L133)。
