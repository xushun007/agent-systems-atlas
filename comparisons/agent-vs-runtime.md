# Coding Agent 的三层架构：Definition、Execution Engine 与 Environment Runtime

## 结论

主流 Coding Agent 通常都可以从三个抽象层次理解：

```text
Agent Definition
        ↓
Agent Execution Engine
        ↓
Environment Runtime
```

这不是要求所有项目都拥有同名的三个模块，而是一个用于比较架构责任的统一视图。不同项目的差异在于：三层是否独立、哪些层被合并、状态由哪一层拥有，以及层之间通过什么协议连接。

1. 三层分别承担哪些责任？
2. 哪些层被合并到同一个中心对象？
3. Session、Context、Capability 和 Recovery 由哪一层拥有？
4. Action、Observation 和真实副作用如何跨层流动？

因此，本文比较的不是“Agent 是否独立于 Runtime”，而是不同 Coding Agent 如何组织这三个核心抽象。

本文基于以下固定版本源码分析：ADK Python `v2.8.0`、Codex `rust-v0.154.0`、Gemini CLI `v0.59.0`、Hermes Agent `v2026.8.31`、Kimi Code `0.40.0`、mini-SWE-agent 固定分析 commit、OpenCode `v2.0.0`、OpenHands `v1.15.0`、Pi `v0.85.1`、DeepSeek Harness `dsh-v0.1.5-rc.2`。

## 一、主流 Coding Agent 的三层抽象

### 1. Agent Definition：行为与能力规范

本文将 `Agent Definition` 用于表示 Agent 的行为与能力规范。它回答：

> 这个 Agent 具有什么角色、行为倾向和能力要求？

它通常描述：

- 模型和模型参数选择；
- system prompt、developer instruction 和行为约束；
- 工具集合和能力配置；
- 当前任务的决策策略；
- 工具结果解释；
- 子 Agent 委派或任务转移；
- 扩展点、能力要求和可被 Runtime 解析的约束。

`Agent Definition` 不必是静态配置，也不必是不可变对象。它可以被配置、组合、解析、覆盖或在 Session 创建时特化。关键边界是：它描述 Agent 应该具有什么行为，不直接拥有某次执行的 Session、Tool Call、Environment 副作用或恢复状态。

因此，`Agent Definition` 与最终发送给模型的请求不是同一个对象。

### 2. Agent Execution Engine：一次执行的控制平面

`Agent Execution Engine` 将 Agent Definition 放入一次具体执行，负责：

- 创建或恢复 Session、Turn、Step；
- 通过 Context Engine 构建本次 Model Request；
- 根据 Runtime Policy 解析有效能力；
- 驱动 Agent Loop 和工具编排；
- 处理审批、中断、重试、持久化和恢复。

它形成的不是“最终 Agent”，而是一次执行上下文：

```text
Execution Context
  = Agent Definition
  + Session / Turn / Step
  + Context
  + Effective Capability
  + Runtime Policy
  + Environment Observation
```

### Session 不只是容器，也可能是执行门面

在不少 Coding Agent 中，`Session` 同时承担两种职责：

1. **长期身份和状态**：保存用户、对话、Workspace、配置和历史；
2. **交互入口和执行协调**：接收用户输入，创建下一次 Turn/Step，并委派给 Agent Loop、Tool Orchestrator 或 Environment。

因此，用户输入进入 Session 后，可能直接触发如下链路：

```text
user input
   ↓
Session.handle(input)
   ↓
create Turn / Step / Context
   ↓
delegate to Agent Loop
   ↓
Tool / Environment action
```

这不意味着 Session 等于 Agent，也不意味着 Session 一定是独立的 Runtime。需要区分两种实现：

| Session 形态 | Session 的责任 | 典型后果 |
| --- | --- | --- |
| 被动 Session | identity、history、state、persistence | 外部 Runner 负责创建 Invocation 和驱动执行 |
| 主动 Session | 除上述状态外，还接收输入、创建执行、委派下一步 | Session 成为 Runtime Facade，Agent Loop 可能被隐藏在 Session 内部 |

ADK 更接近被动 Session：[`Runner`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L600-L698) 以 Session 为状态依据创建 Invocation；Codex 的 [`Session`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L491-L565)、OpenCode 的 [`Session Runner`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/index.ts#L1-L35)、Hermes 的 [`conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/conversation_loop.py) 和 Pi 的 [`AgentSession`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L265-L352) 则更接近主动执行门面。这个判断需要看入口方法是否负责启动下一次执行，而不能只看类名。

### 3. Context Engine：Execution Engine 内的上下文子系统

Context Engine 是 Execution Engine 的一个子系统，而不是 Agent Definition 的组成部分。它负责将：

- Agent Definition 的基础指令；
- Session 历史和当前用户输入；
- Tool Observation；
- Environment Observation；
- Memory、Summary、Compaction 和 Branch；

组装为一次具体的 Model Request。

因此：

```text
Agent Definition ≠ Model Context ≠ Model Request
```

### 4. Effective Capability：从声明能力到当前可用能力

能力也需要区分两层：

```text
Declared Capability
  = Agent Definition 声明需要什么能力

Effective Capability
  = Execution Engine 根据 Policy、Approval、Session
    和 Environment 决定本次实际允许什么
```

例如 Agent Definition 可以声明 `shell`，但在当前 Environment 为只读沙箱、审批未通过时，Execution Engine 可以不把 `shell` 暴露给模型，或拒绝执行调用。

### 5. Environment Runtime：动作的真实执行域

Environment Runtime 回答：

> Agent 的动作在哪里执行，并由谁返回真实执行事实？

它通常包含：

- Shell、文件系统和进程；
- Browser、Computer、MCP 或外部 API；
- Sandbox、Container、Workspace 和远程 Runtime；
- Network、Credential 和后台资源；
- Action 的执行、取消、状态查询和 Observation。

Environment Runtime 不负责决定 Agent 的整体目标，也不应该把某次执行的历史伪装成当前事实。它是副作用和执行观察的归属边界。

### 6. 三层不是单向流水线

三层之间不是“定义向下调用”的单向关系：

```text
Agent Definition
        +
Session / Context / Effective Capability
        ↓
Agent Execution Engine
        ↓ action / tool call
Environment Runtime
        ↓ observation / effect / resource state
Agent Execution Engine 更新 Context
        ↺ 下一次 Model Request
```

因此，模型实际收到的不是一个固定的 Agent 对象，而是 Execution Engine 基于 Definition、Session、Policy、Capability 和 Environment Observation 生成的 Model Request。

### 7. 代码边界不能只按类名判断

Execution Engine 通常承担：

- 用户输入接纳；
- Session、Turn、Step 生命周期；
- 模型请求调度和流式响应；
- Tool Call、审批和 Policy；
- Environment 的选择和调用协调；
- 持久化、恢复、重试和取消；
- 后台任务、子 Agent 和 worker ownership；
- 与 UI、Gateway、API 或远程服务连接。

Execution Engine 更接近“执行控制 + 状态所有权”；Environment Runtime 更接近“真实副作用 + 当前环境事实”。UI、Gateway 和 API 通常构成相邻的 Control Plane，通过协议连接 Execution Engine，并不必然属于 Execution Engine 本身。一个名为 `Agent` 的类可能同时包含 Definition 和 Execution Engine；一个名为 `Runner` 的类也可能只是很薄的入口。判断边界时，应看责任、生命周期和状态所有权，而不是看类名。

Agent Definition 可以在 Session 创建时被解析、覆盖和特化；但当前 Session 历史、Tool Call 结果、Environment 状态和恢复 ownership 仍属于 Execution Engine 或 Environment Runtime。

## 二、整体对比

| Agent | Agent Definition / 行为规范 | Execution Engine / Context Engine | Environment Runtime | 分离判断 |
| --- | --- | --- | --- | --- |
| ADK Python | `BaseNode`、`LlmAgent`、Workflow Node、Toolset | `App`、`Runner`、`InvocationContext`、Workflow、SessionService、Event | CodeExecutor、Toolset、外部服务 | 分离最清楚，Agent/Node 是可调度定义 |
| Codex | model、instructions、tool specs、sub-agent policy 分散在 Core | `Session`、`Turn`、`StepContext`、history、Task、Tool Runtime | Unified Exec、Workspace、Sandbox、Network | 没有单一 Agent 定义，Runtime 是核心 |
| Gemini CLI | Core Client、Gemini Chat、Turn、Agent Loop Context | Session、Scheduler、Policy、Context Manager | Shell、MCP、Sandbox、文件系统 | Agent Loop 与 Core Runtime 仍有较强耦合 |
| Hermes Agent | profile、prompt、tool configuration、delegation | `AIAgent`、Conversation Loop、Turn Context、SessionDB、finalizer | Terminal、Browser、MCP、Docker/SSH/backend | 中心 Agent 同时承担部分 Execution Engine |
| Kimi Code | Agent 配置、Step 行为、动态工具选择 | Agent Core Loop、StepRequest、Permission、Task、Wire、Replay | OS Tools、Workspace、Shell、后台任务 | Agent Core 内含大量 Execution Engine 责任 |
| mini-SWE-agent | Default/Interactive Agent、model、prompt | Agent Loop、trajectory、termination | Local/Docker Environment | Agent Loop 基本等于 Execution Engine |
| OpenCode | Agent 配置、Prompt、Model、Tools、Permission | Session、Runner、Step、LLM projection、Execution Claim | Environment、Workspace Driver、Shell | Agent 是行为规范，Session Runner 是执行主体 |
| OpenHands | Agent Profile、OpenHands Agent、ACP Agent | Conversation、Agent Server、Event Contract、SDK Runtime | Sandbox、Workspace、Cloud Runtime | 三层跨 Control Plane 和后端分离 |
| Pi | model、prompt、tool definitions | Agent Loop、Agent Harness、Runtime Drive、Context、JSONL、Effect Gate | Node Environment、Shell、Coding Workspace | 通用 Agent Loop 与 Coding Harness 分层最明确 |
| DeepSeek Harness | Agent options + preset/scope 中的 Prompt、Tools、Policy | AgentRegistry、AgentLoop、ReactLoopAgent、Session log/projections | FS、Shell、Subprocess、Sandbox providers | 行为规范按 scope 组合，Loop 与能力提供方显式分离 |

这不是成熟度排名，而是责任放置方式的比较。

## 证据索引：三层在源码中的落点

下表不是根据类名推断，而是列出可以直接检查的固定版本文件。`Agent Definition` 一栏如果没有单一文件，会明确写成“分散”或“无统一对象”；这本身就是架构证据。

| Agent | Agent Definition / 行为规范证据 | Execution Engine / Context Engine 证据 | Environment Runtime / Adapter 证据 |
| --- | --- | --- | --- |
| ADK Python | [`_base_node.py`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_base_node.py#L43-L196)、[`_workflow.py`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_workflow.py#L145-L265) | [`runners.py`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L600-L698)、[`invocation_context.py`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py#L105-L143) | [`base_toolset.py`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/tools/base_toolset.py#L63-L166)；CodeExecutor 是可插拔后端，不收敛为单一 Environment 对象 |
| Codex | 没有单一 Agent Definition；入口和行为配置分散在 [`message_processor.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/message_processor.rs#L137-L150)、[`spec_plan.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L223-L265) | [`session/mod.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L491-L565)、[`turn.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L149-L170)、[`step_context.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35) | [`environment_selection.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/environment_selection.rs#L142-L202)、[`unified_exec.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110) |
| Gemini CLI | [`client.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/client.ts)、[`agent-loop-context.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/config/agent-loop-context.ts) | [`turn.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/turn.ts)、[`scheduler.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/scheduler.ts)、[`contextManager.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/context/contextManager.ts) | [`shell.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)、[`policy-engine.ts`](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825) |
| Hermes Agent | Agent profile、prompt 和 tool configuration 分散在 [`conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/conversation_loop.py) 与 [`registry.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/registry.py) | [`conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/conversation_loop.py)、[`turn_context.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_context.py)、[`turn_finalizer.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_finalizer.py) | [`registry.py`](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/registry.py) 与 [Tools Runtime](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/website/docs/developer-guide/tools-runtime.md)；Environment 由 terminal/backend/profile 组合解析 |
| Kimi Code | Agent 配置、Step 行为和动态工具选择分散在 [`stepRequest.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts) 与 [`dynamicTools.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolSelect/dynamicTools.ts) | [`loop.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loop.ts)、[`permissionGateService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts)、[`wireService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/wire/wireService.ts) | `agent-core-v2` 的 OS tools / Workspace 适配；工具边界由 [`toolRegistryService.ts`](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolRegistry/toolRegistryService.ts) 管理 |
| mini-SWE-agent | [`default.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py) 中 Agent、Prompt 和 Loop 基本合并 | [`default.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)、[`mini.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/run/mini.py) | [`local.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)、[`docker.py`](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/docker.py) |
| OpenCode | Agent 配置、Prompt、Model、Tools、Permission；Session 配置入口见 [`session/index.ts`](https://github.com/anomalyco/opencode/blob/b9a39b816c92592e824c68cdc9a48acf7717e2a2/packages/opencode/src/session/index.ts#L25-L91) | [`session.ts`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/session.ts#L1-L180)、[`runner/step.ts`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/step.ts#L64-L150)、[`execution.ts`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90) | [`environment.ts`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/environment/environment.ts#L1-L180)、[`driver.ts`](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65) |
| OpenHands | Agent Profile / Agent kind 由 Conversation 类型和 Agent Server 请求传递，见 [`agent-server-conversation-service.types.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/conversation-service/agent-server-conversation-service.types.ts) | [`agent-server-adapter.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts)、[`openhands-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/openhands-event.ts) | [`agent-server-runtime-service.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/runtime-service/agent-server-runtime-service.ts)、[`action-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/action-event.ts)、[`observation-event.ts`](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/observation-event.ts)；SDK 内部不在 OpenHands v1.15.0 前端仓库内 |
| Pi | model、prompt、tool definitions 由通用 Agent API 承载，见 [`agent.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485) | [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L1-L38)、[`runtime/harness.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L76)、[`runtime/drive.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive.ts#L28-L90) | [`execution/tools.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/tools.ts#L8-L157)、[`effect-gate.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/effect-gate.ts#L1-L63)、[`nodejs.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550) |
| DeepSeek Harness | [`CreateAgentOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L48-L126)、[`AgentPresets`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/preset/agent-presets/src/index.ts#L1-L21) | [`AgentRegistry`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent/src/index.ts#L245-L263)、[`AgentLoop`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/index.ts#L359-L424)、[`ReactLoopAgent`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/core/agent-loop/src/agent.ts#L269-L486) | [`fs`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/fs/fs/src/index.ts)、[`subprocess`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/subprocess/subprocess/src/index.ts)、[`sandbox`](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/sandbox/sandbox/src/index.ts) |

证据的解释也需要保持边界：文件存在只能证明该项目实现了某个组件或协议，不能仅凭静态源码证明生产环境中的 exactly-once、远程恢复或所有副作用都已经收敛。

## 三、十个 Coding Agent 如何实现三层架构

### 1. ADK Python：Agent/Node 定义由 Runner 驱动

ADK 是最接近“Agent Definition 由 Execution Engine 实例化和驱动”的设计。

Agent 侧描述可执行节点：

- [BaseNode](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_base_node.py#L43-L196)
- [Workflow](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/workflow/_workflow.py#L145-L265)
- [BaseLlm](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/models/base_llm.py#L45-L124)
- [BaseToolset](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/tools/base_toolset.py#L63-L166)

Runtime 侧负责把节点放入应用和调用上下文：

- [App](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/apps/app.py#L53-L104)
- [Runner 装配](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L209-L327)
- [Runner 执行循环](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/runners.py#L600-L698)
- [InvocationContext](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/agents/invocation_context.py#L105-L143)
- [Session](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/sessions/session.py#L28-L65)
- [Event](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/src/google/adk/events/event.py#L91-L167)

结构是：

```text
Agent / Node → App → Runner → InvocationContext / Workflow → Event / SessionService
```

这里 Agent 仍然是可执行节点，而不是纯 JSON 配置。它可以在 Workflow 中携带行为和转移逻辑，但不拥有整个应用的 Session、恢复和调度生命周期。

### 2. Codex：Harness Runtime 是核心，Agent 不是独立类

Codex 没有一个类似 ADK `LlmAgent` 的中心 Agent 类。Agent 行为由 instructions、model、tool specs、policy、sub-agent 和 Session/Turn loop 共同形成。

关键 Runtime 文件：

- [Session](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L491-L565)
- [Turn](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L149-L170)
- [Step Settings](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L21-L39)
- [StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
- [Environment Selection](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/environment_selection.rs#L142-L202)
- [Unified Execution](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)

Codex 的真实结构是：

```text
Session Runtime
  ├── Turn
  ├── StepContext
  ├── Model request
  ├── Tool Runtime
  ├── Approval
  └── Environment
```

这里 Agent 更像 Runtime 中的行为策略，而不是 Runtime 外部的声明对象。

### 3. Gemini CLI：Core Client 和 Session Runtime 共同承担 Agent Loop

Agent 行为主要落在：

- [Core Client](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/client.ts)
- [Gemini Chat](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/geminiChat.ts)
- [Turn](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/core/turn.ts)
- [Agent Loop Context](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/config/agent-loop-context.ts)

Runtime 主要落在：

- [Scheduler](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/scheduler.ts)
- [Scheduler State Manager](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/scheduler/state-manager.ts)
- [Policy Engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts)
- [Context Manager](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/context/contextManager.ts)
- [Shell Runtime](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)

Gemini CLI 是中间形态：有 Runtime 层，但 Agent Loop 仍然与 Core Client、Turn 紧密结合。

### 4. Hermes Agent：`AIAgent` 是中心编排对象

Hermes 的 Agent 并不是纯定义。当前 Turn 的上下文、工具循环、审批回调、中断和 finalizer 都由 Agent 路径直接参与。

关键文件：

- [入口](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/run_agent.py)
- [Conversation Loop](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/conversation_loop.py)
- [Turn Context](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_context.py)
- [Turn Finalizer](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/agent/turn_finalizer.py)
- [Hermes State](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/hermes_state.py)
- [Tool Registry](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/registry.py)

Hermes 的上游 Control Plane 包括 Gateway、ACP、Desktop、CLI 和 Cron；下游 Environment / Tool Adapter 包括 terminal backend、browser、MCP、Docker、SSH 和 remote environment。SessionDB 横跨两者，保存长期会话事实。

因此 Hermes 的架构是：

```text
AIAgent = Agent Loop + 当前 Turn 编排
Control Plane = Gateway + ACP + Desktop + CLI + Cron
Environment / Tool Adapter = terminal + browser + MCP + backend
Persistence = SessionDB
```

它的优点是易于扩展到不同平台；代价是 Step、Approval、Environment 和恢复责任没有完全集中到一个独立 Runtime 状态机。

### 5. Kimi Code：`agent-core-v2` 包承载多层责任

Kimi Code v2 的 `agent-core-v2` 不是单纯的 Agent Definition 库；它同时包含了 Definition 的解析、执行循环和大量 Runtime 服务。

关键文件：

- [Scope](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/app/scopes.ts)
- [StepRequest](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)
- [Agent Loop](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loop.ts)
- [Loop Service](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts)
- [Permission Gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts)
- [Tool Registry](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolRegistry/toolRegistryService.ts)
- [Wire Service](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/wire/wireService.ts)
- [Event Dispatcher](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/state/eventDispatcherService.ts)

Kimi 的 `agent-core-v2` 包实际包含：

```text
Loop + StepRequest + Permission + Tool Policy + Task State + Wire + Replay
```

所以从架构责任看，Kimi 将 Definition、Agent Loop 和大量 Execution Engine 能力组织在同一个核心包中；`Agent Core` 在这里是代码落点，不是额外的一层架构。

### 6. mini-SWE-agent：Agent Loop 基本就是 Runtime

关键文件：

- [Default Agent](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
- [Interactive Agent](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/interactive.py)
- [Mini Runner](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/run/mini.py)
- [LiteLLM Model](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/models/litellm_model.py)
- [Environment Protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
- [Local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
- [Docker Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/docker.py)

它的主要流程直接位于 Agent 中：

```text
model call → action parsing → Environment.execute() → observation → termination
```

Environment 是执行后端，不是拥有 Session、Checkpoint 和恢复责任的完整 Runtime。

### 7. OpenCode：Agent 配置由 Session Runner 驱动

OpenCode 中 Agent 主要提供 model、prompt、tools、permission 和 mode。实际执行由 Session Runtime 完成。

关键文件：

- [Session](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/session.ts#L1-L180)
- [Execution Claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90)
- [Session Runner](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/index.ts#L1-L35)
- [Step Runner](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/step.ts#L64-L150)
- [LLM Message Projection](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/runner/to-llm-message.ts#L210-L295)
- [Environment](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/environment/environment.ts#L1-L180)
- [Workspace Driver](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)

结构是：

```text
Agent Definition → Session → Runner → Step → Tool / Workspace / Environment
```

`execution.ts` 的 claim 机制尤其说明，Runtime 关注的是执行所有权和接管，而不是 Agent 的人格或 Prompt。

### 8. OpenHands：Control Plane 与 Execution Runtime 跨仓库分离

OpenHands 的前端仓库主要是 Conversation / Control Plane，不包含完整 Agent Loop。

控制平面关键文件：

- [Conversation Service 类型](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/conversation-service/agent-server-conversation-service.types.ts)
- [Agent Server Adapter](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts)
- [Event Store](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/stores/use-event-store.ts)
- [Conversation WebSocket](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/contexts/conversation-websocket-context.tsx)

Runtime Contract 关键文件：

- [OpenHands Event](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/openhands-event.ts)
- [Action Event](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/action-event.ts)
- [Observation Event](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/core/events/observation-event.ts)
- [Runtime Service](https://github.com/OpenHands/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/runtime-service/agent-server-runtime-service.ts)
- [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)

OpenHands 的结构是：

```text
Conversation / Control Plane
  → Agent Server
  → software-agent-sdk
  → Sandbox / Workspace / Tool Runtime
```

这里 Agent Profile / Agent implementation 是可替换的行为策略，Runtime 是承载它的后端执行域。二者通过 Conversation、Action、Observation 和 Runtime API 连接，而不是共享一个本地 Agent 对象。

### 9. Pi：通用 Agent Loop 与 Coding Harness 明确分层

Pi 的分层最清晰之一。

通用 Agent Loop：

- [Agent Loop](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L1-L38)
- [Agent Request Snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485)

Harness Runtime：

- [Agent Harness](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts#L518-L536)
- [Runtime Harness](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L76)
- [Runtime Drive](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive.ts#L28-L90)
- [Tool Execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/tools.ts#L8-L157)
- [Effect Gate](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/effect-gate.ts#L1-L63)
- [JSONL Session Repository](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/repo.ts#L49-L90)

Coding Agent 层：

- [AgentSession Runtime](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts#L17-L41)
- [Coding Agent Session](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L265-L352)

结构是：

```text
Generic Agent Loop
  → Agent Harness
  → Coding Agent Runtime
  → Session / Environment / Persistence / UI
```

### 10. DeepSeek Harness：Definition 由作用域组合，Execution Engine 由插件服务形成

DeepSeek Harness 没有一个固定 `AgentDefinition` 对象。模型选项由 Agent options 提供，Prompt、Tools、Policy 和 persona 由 profile/preset/Agent scope 组合；`setup(agentCtx)` 必须在 Agent 与 Session 发布前完成，使外部消费者看不到半配置实例。

执行引擎由 `AgentRegistry`、`AgentLoop`、`ReactLoopAgent`、Session event log 和 projection 共同组成。Loop 明确产生 Turn/Step 并构造冻结请求；Session 拥有模型可重建事实；Registry 拥有活跃 Agent 生命周期。FS、Shell、Subprocess 与 Sandbox 则是独立能力提供方，而不是 Loop 的内置方法。

```text
Profile / Preset / Agent Scope
  → Effective Agent Definition
  → AgentRegistry + AgentLoop + Session
  → Tool policy pipeline
  → FS / Shell / Subprocess / Sandbox providers
```

它属于显式 Execution Engine + Ports/Adapters 形态，但端口通过 Cordis service/event seam 表达，而不是集中在一个 Harness 类中。

## 四、同一三层模型的不同组织方式

形态一和形态二不应被理解成两套不同的架构。二者都包含：

```text
Agent Definition
  → Agent Execution Engine / Agent Loop
  → Environment Runtime
```

差异主要在于三层是否被显式建模，以及 Control Plane、Capability Adapter 和 Environment Adapter 是否通过稳定协议接入。形态一是边界清晰、端口明确的组织方式；形态二是以 Agent Loop 为中心、边界逐步演进出来的组织方式。

### 形态一：显式 Execution Engine + Ports / Adapters

代表：ADK、OpenCode、Pi；OpenHands 在 Control Plane / Runtime Contract 层面也接近这种形态。

这里的中心不是某个具体 Agent，而是一个可以独立运行和持有状态的 `Agent Execution Engine`。Agent Definition 被 Engine 实例化；交互入口和执行后端都通过明确的端口接入。

```text
                         REST / SDK / CLI
                               │
                         Control Adapter
                               │
Agent Definition ───────► Execution Engine ◄────── Environment Adapter
                               │                         │
                         Context / State                 │
                               │                    shell / sandbox /
                         Model Request              workspace / MCP
```

这里需要区分两类 Adapter：

- **Control Adapter**：REST、SDK、CLI、UI，以及把外部输入转换成 Session/Turn 请求的入口；
- **Environment Adapter**：Shell、Sandbox、Workspace、Browser、Container、远程执行后端，以及把 Action 转成真实副作用的适配器。

MCP 不能简单归入交互层。它通常是 Capability / Tool Adapter：把外部工具或资源接入 Execution Engine；如果 MCP Server 自己拥有 Sandbox 或远程进程，它的下游又会连接 Environment Runtime。

形态一的关键不是“外围组件更多”，而是 `Execution Engine` 对两类外围都有稳定协议：

- 换 CLI、REST 或 SDK，不应改变 Session/Step 的核心语义；
- 换 Shell、Sandbox 或 Workspace，不应改变 Agent Loop 的核心语义；
- Agent Definition 可以被不同入口和 Environment 重复实例化；
- Recovery、Approval、Context 和 Persistence 由 Engine 统一拥有。

这与六边形架构有相似之处：都强调核心执行逻辑通过 Port 连接外部 Adapter，并由核心持有业务状态。但它不是简单等同于六边形架构；这里的核心是一个会持续运行、调用模型、处理事件和恢复任务的 Execution Engine。

优点：

- Control Plane 和 Environment 可以独立替换；
- Execution Engine 可以独立处理恢复、权限和环境协调；
- 多入口、多模型、多 Agent 更容易复用；
- Session 和执行状态不依赖某个入口或 Environment Adapter 的内存。

代价：

- Definition、Engine、Control Adapter 和 Environment Adapter 之间需要明确协议；
- 状态所有权、事件顺序和错误传播更复杂；
- Agent 行为与 Runtime Policy 可能发生冲突。

### 形态二：隐式 Execution Engine + 中心 Agent Loop

代表：Codex、Gemini CLI、Hermes Agent。

这里的中心是一个主动运行的 `Agent Loop`。它同时掌握模型调用、上下文推进、工具选择和当前 Turn 的主要控制流。换句话说，Execution Engine 的职责没有消失，而是隐含在 Agent Loop、Session 对象、回调和工具调度中。

```text
REST / SDK / CLI / Gateway
          │ input / callback
          ▼
   ┌──────────────────────┐
   │  Agent Loop          │
   │  model + context     │
   │  turn + tool control │
   │  approval + finalize │
   └──────┬───────────────┘
          │ tool / action
          ▼
 Shell / Sandbox / MCP / Remote Backend
```

这里的“外围”包含两种不同东西：

- 上游的交互入口：REST、SDK、CLI、Gateway；
- 下游的执行后端：Shell、Sandbox、Workspace、MCP Server。

但它们共同的特点是：核心 Agent Loop 直接理解并编排这些调用，外围没有先经过一个独立、通用的 Execution Engine 协议。Session、Context、Approval、Tool Call 和 Recovery 可能分散在 Loop 对象、回调、数据库和宿主服务中。

这不必然意味着设计缺乏模块化思维。很多产品先以 Agent Loop 形成可用的交互闭环，再逐步把高频变化点抽取成 Session、Policy、Tool、Environment、Persistence 和 Recovery 模块。它更像一种以运行闭环为起点的演进式模块化。

形态二与形态一的真正差异是**依赖方向和状态中心是否显式**。Session 直接触发下一步执行并不自动属于形态二；形态一也可以提供主动 Session Facade。关键在于 Session 委派给一个独立的 Execution Engine，还是把 Loop、Context、Tool 和 Recovery 责任都包含在自身调用链中：

| 比较点 | 形态一：显式 Engine | 形态二：隐式 Engine |
| --- | --- | --- |
| 谁驱动一次执行 | 通用 Execution Engine | Agent Loop 本身 |
| Session / Step 所有权 | Engine 的一等状态 | Loop、Session 对象或宿主服务共同持有 |
| Session 的入口角色 | Facade 可主动接收输入，但将执行委派给 Engine | Session/Agent 对象直接推进 Loop 或通过内部回调推进 |
| 入口替换 | 通过 Control Adapter 接入 | 通常需要适配 Loop 的输入/回调接口 |
| Environment 替换 | 通过 Environment Port 接入 | 通常由 Tool、callback 或 backend 直接调用 |
| 恢复位置 | Engine 的统一 Recovery | Loop、SessionDB、finalizer 或平台服务 |
| 典型代价 | 协议和状态协调成本较高 | Loop 中心变重、边界逐步外溢 |

因此，形态二不是另一种语义架构，也不是“没有 Runtime”，而是把相当大部分 Execution Engine 责任放在 Agent Loop 内部，通过隐式边界逐步抽取能力。

### 形态三：三层责任合并到同一执行组件

代表：Kimi Code、mini-SWE-agent。

这里的“同一执行组件”是架构概念，不是要求项目存在一个名为 `Agent Core` 的模块。形态三比形态二更进一步：不仅 Agent Loop 是控制中心，Agent Definition、执行循环、状态和工具编排也集中在同一个 Agent 对象、Agent Loop 组件或核心包中。它仍然可以逐步演进为形态二，再进一步抽取出形态一的显式 Execution Engine。

```text
Agent / Loop Component
  ├── Definition / model / prompt
  ├── Agent Loop
  ├── Session-like state
  ├── Tool execution
  └── termination
             ↓
       Environment Adapter
```

Kimi 的 `agent-core-v2` 包将 Queue、Permission、Task、Wire、Replay 等 Runtime 服务组织在同一核心包中；mini-SWE-agent 则把模型调用、命令执行、trajectory 和终止条件集中在 Agent Loop。这里前者是代码组织形式，后者是运行时责任合并，二者不能直接等同。二者的差异仍然存在：Kimi 已经形成较强的 Runtime 服务集合，mini-SWE-agent 则保持最小 loop 和轻量 Environment。

优点是结构小、控制流直接；代价是当产品需要后台任务、跨进程恢复、多 worker 接管和复杂 Environment 时，必须继续向同一执行组件中添加 Execution Engine 责任，或者重新拆出独立层次。

## 五、从 Agent Definition 到 Model Request

三层架构不应被理解为单向调用链。Execution Engine 会把 Environment 的 Observation、Policy 结果和 Session Context 重新注入下一次模型请求。

```text
Agent Definition
        +
Session / Context / Effective Capability
        ↓
Execution Engine
        ↓
Model Request
        ↓
Action / Tool Call
        ↓
Environment Runtime
        ↓
Observation / Effect / Resource State
        ↺
Execution Engine 更新 Context
```

其中：

- Agent Definition 可以声明 `shell` 能力，但不能直接拥有 `process.spawn()`；
- Execution Engine 可以决定本次是否暴露 `shell`，但不能伪造文件系统已经发生了什么；
- Environment Runtime 返回命令、文件、进程和远程资源的事实，但不决定 Agent 的整体目标；
- Context Engine 将这些事实重新组织为下一次 Model Request。

## 六、最终判断

三层模型不是要求每个项目都实现三个独立模块，而是用来定位行为规范、执行控制和真实副作用的责任边界：

```text
Agent Definition
  = 模型、Prompt、Tools、Policy、行为身份和能力要求

Agent Loop
  = 模型调用、工具调用、结果处理、下一步决策

Agent Execution Engine / Harness
  = Session、Turn、Step、Environment、Approval、
    Persistence、Recovery、Process、UI、后台任务
```

这里的 `Agent Definition` 不必是静态对象；它可以被配置、解析、组合和特化。真正需要区分的是：它描述 Agent 的行为规范，而 Execution Engine 拥有一次具体执行的状态和生命周期。

十个项目只是把这三层放在了不同位置：

- ADK：Agent/Node 与 Runner/Workflow 分离最清楚；
- Pi：通用 Agent Loop 与 Coding Harness 分离最清楚；
- OpenCode：Agent 配置与 Session Runner 分离较清楚；
- OpenHands：Control Plane 与 Execution Backend 分离最明显；
- Codex：Execution Engine / Harness 是中心，Agent 是行为组合；
- Gemini CLI：Core Agent Loop 与 Scheduler/Policy 混合；
- Hermes：中心 Agent Loop 与平台执行层混合；
- Kimi：`agent-core-v2` 包内含大量 Execution Engine 责任；
- mini-SWE-agent：Agent Loop 基本覆盖 Definition 与 Execution Engine。
- DeepSeek Harness：Definition 由 profile/preset/scope 组合，Execution Engine 由 Registry、Loop、Session 和插件 seam 共同形成。

因此，coding agent 的架构演进并不是简单地“增加一个 Runtime 类”，而是在重新分配四种所有权：

```text
决策所有权
执行所有权
状态所有权
Environment / Recovery 所有权
```

这四种所有权越能被独立表达、持久化和接管，三层之间的协议就越清晰，系统也越接近长期运行的产品级 coding harness。

## 相关研究

- [Codex Harness 演进](../projects/codex/research/codex-harness-evolution.md)
- [Pi Runtime 架构](../projects/pi/arch/pi-runtime-architecture.md)
- [OpenCode Harness 演进](../projects/opencode/research/opencode-harness-evolution.md)
- [OpenHands Harness 演进](../projects/openhands/research/openhands-harness-evolution.md)
- [ADK Python Harness 演进](../projects/adk-python/research/adk-python-harness-evolution.md)
- [DeepSeek Harness 演进](../projects/deepseek-harness/research/deepseek-harness-evolution.md)
