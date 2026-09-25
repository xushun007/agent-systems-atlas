# DeepSeek Harness：Planning 与 Task Decomposition

分析版本：`dsh-v0.1.5-rc.2`，提交 [`fb2c4b9`](https://github.com/deepseek-ai/deepseek-harness/commit/fb2c4b9e698e30edb738bca4cf0618587db7d203)。

## 1. 自然语言计划不自动成为 Runtime 工作项

计划文本只有经 plan/tool 插件记录或转化后才具有运行时意义；Agent Loop 的执行权威仍是 inbox、Step 和 tool call。系统因此可以要求“展示计划”与“执行计划”位于不同 Step，而不把模型 prose 当作已调度任务。[base bundle 的 plan policy](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/bundle/base/cordis.patch.yml#L300-L320)。

## 2. 子 Agent 是独立 Session/Agent，而非父 Prompt 的嵌套消息

subagent tool 构造含 parent、persona、tool filter、model options 与最大深度的请求，并由 provider 创建 child。父子活跃生命周期、Session 血缘和能力 scope 是三条独立关系。[`tool-subagent`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subagent/tool-subagent/src/index.ts#L463-L530)；[`CreateAgentOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L95)。

## 3. foreground、background、continuable 是不同所有权模式

foreground 父调用等待 child settlement；one-shot background 交给 Jobs；continuable child 在输入接纳后独立拥有后续 Turn。不能用一个“异步工具调用”状态统一解释三者。[`subagent dispatch`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subagent/tool-subagent/src/index.ts#L530-L567)。

## 4. 模型选择与能力限制在启动前预检

Runtime 在创建 child 前校验模型选择策略、真实路由和 provider 是否仍是同一实例；tool filter/preset 在 child 的 setup 阶段形成能力边界。模型提出的 delegation 参数不能直接扩大权限。[`subagent route preflight`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subagent/tool-subagent/src/index.ts#L479-L525)。

## 判断

DeepSeek Harness 对“计划”保持轻约束，对“委派”则给出明确运行时对象和所有权。任务验收仍依赖具体 workflow/goal/tool 插件，并非核心 Loop 的统一 DAG。
