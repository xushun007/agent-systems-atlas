# Pi Agent Runtime

结论：Pi 的整体设计不是一个庞大的 Runtime Core，而是“轻量 Agent 循环 + 会话编排层 + 可插拔运行时服务”。`Agent` 只维护消息状态、模型流和工具循环；`AgentSession` 承接 coding agent 的产品语义；入口模式、恢复能力和工作目录绑定服务则由更外层的 Runtime Host 统一管理。

- 上游仓库：`https://github.com/earendil-works/pi`
- 分析版本：`coding-agent-0.79.8`
- 分析提交：[`1287b69fe026a9c3f9cec8a220ad9405851f7dc3`](https://github.com/earendil-works/pi/commit/1287b69fe026a9c3f9cec8a220ad9405851f7dc3)
- 提交日期：2026-06-19
- 复核日期：2026-08-14
- 架构图：[Pi Agent Runtime（Excalidraw）](../diagrams/pi-runtime-architecture.excalidraw)
- 历史对照：[Agent Runtime（HTML）](agent-runtime.html)，聚焦 `packages/agent` 内部循环，不代表完整 coding-agent runtime

## 架构边界

本图覆盖从 Interactive TUI、Print/JSON、RPC 和 SDK 到 `AgentSession`、Agent Loop、模型网关、工具运行时及会话存储的主干。TUI 组件树、具体 Provider 协议实现、扩展示例和打包发布流程不在图中展开。

图中名称优先表达职责，不要求与类名一一对应。对应关系如下：

| 架构职责 | 主要实现锚点 |
| --- | --- |
| Runtime Host | `AgentSessionRuntime` |
| Session Orchestration | `AgentSession` |
| Agent Core | `Agent`、`agentLoop()`、`agentLoopContinue()` |
| Model Gateway | `@earendil-works/pi-ai`、`streamSimple()`、`ModelRegistry` |
| Tool Runtime | built-in tools、extension tools、SDK custom tools |
| Runtime Services | resources、settings、auth、extensions、compaction、retry |
| Session Store | `SessionManager` 与 JSONL session tree |

## 关键设计

### 1. 多种入口共享同一个会话运行时

CLI 创建一次 Runtime Host，再根据模式将它交给 RPC、Interactive 或 Print；SDK 也围绕同一个 `AgentSession` 抽象工作。入口层负责 I/O 形态，运行语义不会在各模式中复制。[`main.ts#L725-L732`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/main.ts#L725-L732) [`main.ts#L792-L825`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/main.ts#L792-L825)

Runtime Host 持有当前 `AgentSession` 及其 cwd-bound services。执行 `/new`、resume 或 fork 时，旧会话先触发 shutdown 并失效，再针对目标 cwd 重建服务和 Session，最后重新绑定宿主 UI/RPC。[`agent-session-runtime.ts#L74-L119`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session-runtime.ts#L74-L119) [`agent-session-runtime.ts#L167-L215`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session-runtime.ts#L167-L215)

### 2. `AgentSession` 是产品语义中心

`AgentSession` 在 Agent Core 之外处理输入扩展、skills 和 prompt templates、模型与工具选择、steering/follow-up、扩展事件、自动重试、压缩和会话持久化。它不是另一个模型循环，而是对通用 `Agent` 的 coding-agent 编排。[`agent-session.ts#L265-L352`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L265-L352) [`agent-session.ts#L997-L1149`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L997-L1149)

事件流是 Session 的运行时脊柱。`AgentSession` 订阅 Agent 事件后，依次桥接 extension hooks、通知 UI/RPC，并在 `message_end` 将最终消息写入 Session Store。因此界面更新、扩展观察和持久化看到的是同一组生命周期事件。[`agent-session.ts#L352-L417`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L352-L417) [`agent-session.ts#L493-L536`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L493-L536)

### 3. Agent Core 保持小而通用

一次运行由 `Agent` 创建上下文快照并进入 Agent Loop。循环在每个 turn 中转换上下文、调用模型流、识别 tool calls、执行工具并把 tool results 回注；无工具调用且没有 queued follow-up 时结束。Steering 在下一个 assistant response 前注入，follow-up 只在本应停止时继续运行。[`agent-loop.ts#L123-L227`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/agent/src/agent-loop.ts#L123-L227)

Agent Core 只在模型调用边界把 `AgentMessage[]` 转为 Provider 可接受的 `Message[]`。这使 UI/扩展可以保留自定义消息，而 Provider 层仍面对统一协议。[`agent-loop.ts#L232-L286`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/agent/src/agent-loop.ts#L232-L286)

### 4. 模型与工具都是可替换边界

模型侧由 `pi-ai` 统一模型、消息、工具 schema 和流式事件，coding-agent 再注入鉴权、Provider 设置、重试/超时及请求响应 hooks。[`sdk.ts#L293-L358`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/sdk.ts#L293-L358)

工具侧同时容纳 built-in、extension 和 SDK custom tools。默认 coding tools 是 `read`、`bash`、`edit`、`write`，另有 `grep`、`find`、`ls` 等发现工具；Session 统一建立 registry、选择 active tools、生成相应 system prompt，并通过 hooks 包裹执行。[`tools/index.ts#L96-L194`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/tools/index.ts#L96-L194) [`agent-session.ts#L2289-L2437`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/agent-session.ts#L2289-L2437)

多工具调用默认可以并行完成，但 tool-result 消息仍按模型原始调用顺序回注，保证后续上下文稳定；单个工具可要求整批顺序执行。对应测试明确验证了“完成事件按完成顺序、持久化结果按来源顺序”。[`agent-loop.test.ts#L452-L535`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/agent/test/agent-loop.test.ts#L452-L535)

### 5. 存储与恢复是同一个 Session Tree 的双向关系

Session Store 使用 append-only JSONL。消息、模型切换、thinking level、label、compaction 和 extension data 都是带 `id` / `parentId` 的 entry；当前 leaf 决定活动分支。正常执行持续 record，resume 则读取文件并从当前分支重建模型上下文。[`session-manager.ts#L757-L833`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/session-manager.ts#L757-L833) [`session-manager.ts#L950-L1010`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/session-manager.ts#L950-L1010) [`session-manager.ts#L1150-L1168`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/session-manager.ts#L1150-L1168)

Branch 不改写历史，只移动 leaf，让后续 entry 成为旧节点的新子节点；fork 则把选定 leaf 的根路径复制到新的 session 文件。树遍历测试验证了 parent chain、leaf 推进、分支和 compaction entry 都在同一数据模型中。[`session-manager.ts#L1241-L1305`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/src/core/session-manager.ts#L1241-L1305) [`tree-traversal.test.ts#L8-L89`](https://github.com/earendil-works/pi/blob/1287b69fe026a9c3f9cec8a220ad9405851f7dc3/packages/coding-agent/test/session-manager/tree-traversal.test.ts#L8-L89)

## 主执行链

1. Entry Surface 把输入交给 Runtime Host 当前绑定的 `AgentSession`。
2. Session 完成 command/input hooks、skill/template 展开、鉴权和上下文准备。
3. `Agent` 建立当前 state 的快照并启动事件驱动 Agent Loop。
4. Context 经 `transformContext` 与 `convertToLlm` 后进入 Model Gateway。
5. 模型流持续产生 assistant message events；Session 将事件转发给界面和 extensions。
6. 若响应包含 tool calls，Tool Runtime 校验参数、执行 hooks 和工具，把结果回注到下一 turn。
7. `message_end` 触发 record；Session 在 run 结束后处理 retry、compaction 和由 extension 新增的队列消息。
8. 没有 tool calls、steering 或 follow-up 时运行结束；之后仍可从 JSONL tree 恢复、分支或 fork。

## Runtime Services

- Resources & Prompt：发现 AGENTS/context files、skills、prompt templates 和 extensions，并组装 system prompt。
- Model & Auth：管理模型目录、API key/OAuth、Provider 注册、thinking 与 transport 设置。
- Extension Runtime：提供 lifecycle hooks、commands、custom tools、Provider 注册及 UI integration。
- Context Control：处理自动/手动 compaction、branch summary、overflow recovery 和 auto retry。
- Session Store：持久化 append-only tree，并为 resume、branch、fork 和模型上下文恢复提供统一来源。

这些能力中，一部分在源码中由独立对象实现，一部分由 `AgentSession` 协调。图中把它们合并为横切服务，是为了表达设计职责，而不是建立类图。

## 设计解读

Pi 的可组合性来自两条刻意保持的边界：一是 `AgentMessage` 到 Provider `Message` 的转换只发生在模型边界；二是 coding-agent 的持久化、扩展和资源语义不进入通用 Agent Loop。这样既能让 SDK 直接复用 Agent Core，也能让完整 CLI 在不复制循环逻辑的前提下增加丰富的 Session 行为。

`packages/agent/src/harness/` 提供另一套更通用的 durable harness，但在本提交的 coding-agent CLI 主链中，实际创建的是 `Agent` + `AgentSession`。因此它没有进入本图，避免把可选框架能力误画成产品主链。

## 未确认事项

- 本次结论来自提交 `1287b69fe026a9c3f9cec8a220ad9405851f7dc3` 的源码与测试阅读，未执行真实 Provider、交互 TUI 或跨 cwd 恢复实验。
- 该提交对应 `packages/coding-agent/package.json` 的 `0.79.8`；版本名称用于阅读，完整 commit 仍是证据边界。
- 上游工作区存在未提交修改，本次分析只读取 Git 提交对象，未把工作区改动作为证据。
- 图中 Runtime Services 是职责归纳；它们不应被理解为一组固定的一对一实现类。
