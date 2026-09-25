# DeepSeek Harness：Extension / Plugin Architecture

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. 插件不是外围机制，而是 Runtime 的组织方式

模型适配器、Agent Loop、Session、工具、审批和 Environment providers 都是 Cordis 插件；不存在必须修改的特权工具内核。注册项是由 fiber/effect 拥有的副作用，卸载拥有者会撤销服务、监听器和工具。[`AgentLoop` 注册 factory](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L359-L424)；[`ToolRuntime.register()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/src/index.ts#L1027-L1052)。

## 2. profile、bundle、preset 解决不同组合问题

profile 选择进程级 bundle 和 overlay；bundle 分发一组 patch；preset 将一组常驻插件能力作用到特定 Agent scope。三者不能统一叫“插件配置”。[profile](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/boot/app-boot/src/profile.ts#L1-L23)；[preset](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21)。

## 3. Capability seam 要同时具备定义、提供方和消费方

FS、shell、subagent 等能力以 service definition 约束接口，由 local/remote/sandbox provider 实现，再由模型工具或 Host 消费。只注册工具 schema 不构成完整能力边界。[架构包目录](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/AGENTS.md#L14-L61)。

## 4. 动态能力在 Step 边界进入模型请求

工具和 Prompt 注册可热变化，但当前请求使用组装时的 schema 与已记录 header；调用到达时执行层还会重新检查当前工具实现。动态注册可能改变请求前缀与 cache 行为，但实际 KV cache 命中需 Provider 数据验证。[`SystemPrompt.assemble`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/system-prompt/src/index.ts#L399-L455)；[`buildRequest()`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L548-L606)。

## 5. 热卸载有结构保障，但仍需处理中途调用

effect disposer 能撤销注册；Tool Runtime 在执行和结果处理阶段对实现消失、schema 变化、取消和策略失败做结构化收敛。它能避免悬空注册，不等价于任意远程 plugin 都能无损热升级。[tool disappearance tests](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/tools/tests/tools.spec.ts#L480-L539)。
