# DeepSeek Harness：Environment 与执行世界

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. Environment 不是一个类，而是一组能力 seam

上游把 filesystem、shell、subprocess、sandbox 分成服务定义、提供方与消费工具。Agent Loop 只调度工具，不直接操作本地进程。[`fs`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/fs/fs/src/index.ts)、[`subprocess`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subprocess/subprocess/src/index.ts)、[`sandbox`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/sandbox/sandbox/src/index.ts)。

## 2. `cwd` 是 Session 元数据，不是完整执行身份

Session header 保存经验证的 `cwd`，Prompt 可以读取它；实际可见文件、进程与隔离规则仍由当前装配的 providers 决定。相同 `cwd` 配合不同 FS/shell backend，可以对应不同执行世界。[`CreateAgentOptions.meta`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L95)；[`cwd` prompt variable](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L419-L426)。

## 3. 环境一致性由组合保证

profile 与 preset 决定服务提供方及 Agent 可见工具。如果 FS 指向远端而 shell 仍指向本机，系统没有一个 `Environment` 对象自动修复这种分裂；组合配置必须确保相关 providers 指向同一执行世界。[profile 装配](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/boot/app-boot/src/profile.ts#L1-L23)。

## 4. 恢复不等于环境回滚

Session 可修复未闭合 Turn 和工具结果，但外部副作用可能已经发生。工具结果缺失时，恢复器写入 unknown outcome，并要求依据幂等性或外部状态判断是否重试，而不是假设 Workspace 已回滚。[`repair.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/session/src/repair.ts#L29-L133)。

## 判断

DeepSeek Harness 采用 capability-oriented Environment：边界清晰、提供方可替换，但没有把多个 provider 自动绑定成一个原子的 workspace identity。部署级环境一致性仍需单独验证。
