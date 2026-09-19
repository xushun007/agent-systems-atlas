---
title: Claude Code Runtime / Harness Architecture
snapshot_id: 2026-09-18.6e2f79c
reviewed_at: 2026-09-18
upstream_repository: https://github.com/freestylefly/claude-code
upstream_commit: 6e2f79c5b97ae619172a3e621e87dd0edb220619
upstream_commit_date: 2026-03-31
status: current
change_level: baseline
verification:
  source_reading: true
  tests_read: false
  runtime_experiment: false
diagram: ../diagrams/claude-code-runtime-architecture-2026-09-18-6e2f79c.excalidraw
---

# Claude Code Runtime / Harness 架构

> 结论：这份源码快照中的 Claude Code 不是一个单体 REPL，而是由 `QueryEngine` conversation runtime、turn 内 `queryLoop`、工具/权限执行管线、并发 `Task` supervisor、可恢复 session/workspace 状态以及 remote control plane 共同构成的 coding-agent harness。最关键的所有权边界是：主对话完成状态、后台任务状态、文件工作区状态和持久化 transcript 彼此关联，但不属于同一个生命周期对象。

## 视图边界

本视图回答 Claude Code 如何从 CLI、REPL、SDK 或远程控制入口进入同一套 agent runtime，以及模型请求、工具执行、后台任务、持久化和 workspace 如何分工。

图中刻意隐藏以下细节：具体 UI 组件、每个内置工具的参数、MCP 传输变体、完整 hook 事件矩阵、分析/遥测实现和全部 feature gate。它也不声称覆盖 Anthropic 官方当前版本；上游仓库将自身描述为第三方公开的泄漏源码备份。

可编辑图源：[claude-code-runtime-architecture-2026-09-18-6e2f79c.excalidraw](../diagrams/claude-code-runtime-architecture-2026-09-18-6e2f79c.excalidraw)。

## 与上一快照相比

### 新增

- 首次建立版本化架构基线。
- 把 `Task` supervisor 作为与主 query loop 并列的生命周期边界。
- 把 JSONL transcript、file history/checkpoint、能力扩展和 remote bridge 分开表达。

### 删除

- 无；这是首个快照。

### 职责迁移

- 无可比较的上一快照。

### 保持不变

- 无上一快照；本次记录以下基线不变量：一个 `QueryEngine` 对应一个 conversation；一次 `submitMessage()` 开启一个 user turn；turn 内可以有多次模型—工具迭代；后台 task 可以超出单次 turn 的生命周期。

## 架构说明

### 1. 入口与控制面

交互式 REPL/TUI、`--print` headless 模式、Agent SDK/stream-json、IDE integration 与 remote-control/bridge 并不各自实现一套 agent loop。CLI 入口负责选择模式；交互路径由 `App`/REPL 承担呈现，headless/SDK 路径由 `print.ts` 与 `StructuredIO` 处理结构化输入输出，远程路径则通过 bridge 和 remote session 组件转发消息、事件与权限决定。源码入口见 [`entrypoints/cli.tsx`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/entrypoints/cli.tsx)、[`cli/print.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/cli/print.ts) 和 [`remote/RemoteSessionManager.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/remote/RemoteSessionManager.ts)。

### 2. Conversation runtime 与 turn loop

[`QueryEngine`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/QueryEngine.ts) 明确声明一个实例对应一个 conversation；mutable messages、usage、permission denials、read-file cache、已发现 skill 与 nested memory 状态跨 turn 保持。`submitMessage()` 接受一次用户输入、构造 prompt/context、提前记录用户消息以保证中途终止后仍可 resume，再进入 query 执行。

[`query.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/query.ts) 中的 `queryLoop` 是单个 user turn 内部的迭代状态机。它反复执行模型请求、解析 tool use、运行工具、追加 tool result，并处理 compact、retry、max-output recovery、stop hooks、budget、abort 与 max-turns。没有 tool call 且 stop hook 不要求继续时才自然收敛；因此“一个 turn”不能等同于“一次模型 API 请求”。

### 3. 模型与 API 后端

[`services/api/claude.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/services/api/claude.ts) 负责把系统提示、消息、工具定义和 thinking 配置投影到 Anthropic Messages API，消费流式事件，并在超时、空流或部分失败时执行重试/非流式 fallback。[`services/api/client.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/services/api/client.ts) 装配 first-party、AWS Bedrock、Google Vertex AI 和 Microsoft Foundry 客户端。

### 4. 工具、权限与 Environment-owned execution

[`Tool.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/Tool.ts) 中的 `ToolUseContext` 同时携带工具集合、MCP clients、agent definitions、cwd 相关状态、abort controller、permission context、hooks、file history 和动态 `refreshTools()`。因此工具调用不是孤立函数调用，而是 capability、policy、workspace 与 execution 的交叉点。

[`utils/permissions/permissions.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/utils/permissions/permissions.ts) 组合 allow/deny/ask rules、tool-specific checks、permission mode、hooks 与无交互环境下的 auto-deny；Bash 等执行器再结合 sandbox 和路径规则。工具结果必须作为 observation 返回 loop；中断或异常路径也会补齐缺失的 tool result，维持 provider history 的协议合法性。

### 5. Task supervisor 与并发生命周期

[`Task.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/Task.ts) 将 `local_bash`、`local_agent`、`remote_agent`、`in_process_teammate`、`local_workflow`、`monitor_mcp` 和 `dream` 统一为带 `status`、`AbortController`、`outputFile`、`outputOffset` 与通知标记的 task state。具体实现位于 [`src/tasks`](https://github.com/freestylefly/claude-code/tree/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/tasks)。

主 query loop 可以创建或观察 task，但 task 不等同于当前 turn：后台任务可能在 turn 返回后继续运行，下一 turn 再消费其增量输出。父子取消、terminal status 与 orphan cleanup 因而必须独立于主对话的完成状态。

### 6. 能力与扩展平面

CLAUDE.md/memory、skills、slash commands、plugins、hooks、MCP、agents/teams、LSP、web 与 IDE context 共同影响 system prompt、可用工具和运行时 attachment。`print.ts` 中的 MCP、plugin 与 skill refresh 路径，以及 `ToolUseContext.options.refreshTools`，表明能力集合可以在 session 运行期间变化；它们不是仅在进程启动时固化的一张静态工具表。

### 7. Session、工作区与恢复

[`utils/sessionStorage.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/utils/sessionStorage.ts) 使用 JSONL transcript 和 parent UUID 关系记录可恢复消息链，并为 resume/fork 等操作提供事实基础。[`utils/fileHistory.ts`](https://github.com/freestylefly/claude-code/blob/6e2f79c5b97ae619172a3e621e87dd0edb220619/src/utils/fileHistory.ts) 单独维护文件快照、备份、diff 与 rewind。

这两个状态面不能合并：conversation projection 可以 compact 或 fork，而工作区 mutation 必须通过 checkpoint/backup 恢复；正在运行的进程、审批句柄与 task abort controller 也不能仅凭 transcript 自动重建。

## 验证依据

- 源码阅读：`QueryEngine.submitMessage`、`queryLoop`、`ToolUseContext`、permission pipeline、Task 状态模型、API client、session storage、file history、headless/SDK 与 remote bridge。
- 测试阅读：仓库中未发现 `test`、`tests`、`__tests__`、`*.test.*` 或 `*.spec.*` 文件，因此 `tests_read` 为 `false`，不能声称测试验证。
- 运行实验：未执行。所有“确认”均指当前 commit 的源码结构，不是运行时观测。

## 设计解读

以下是基于源码事实的解释，而不是上游声明：

1. Claude Code 的核心抽象更接近 conversation runtime，而不是每个 prompt 新建一个 agent。
2. `Task` supervisor 让并发/后台工作脱离主 loop，但增加 parent-child cancellation、orphan cleanup 和恢复一致性成本。
3. Permission 与 workspace 是同一个执行决策的两个维度；增加可访问目录既改变能力范围，也改变安全边界。
4. JSONL transcript 是可重建事实，mutable messages 是 provider-facing 投影；compact、resume 与 fork 可以重建投影，但不应伪造已经发生的工具执行。
5. Remote bridge 复用 session/control semantics，而不是在本地复制一套独立 agent runtime。

## 未确认事项

- 上游不是 Anthropic 官方仓库，其源码来源、完整性和与正式版本的对应关系无法由本研究确认。
- 未运行 Bun/TypeScript runtime；stream recovery、permission 等待、task kill、resume/fork 与 remote reconnect 的真实时序仍未验证。
- 仓库没有可识别的测试文件，关键不变量只有实现代码证据，没有测试证据。
- SDK 类型与 feature-gated 路径中可能存在尚未启用或只用于特定部署的能力；图只表达源码中可见的职责边界，不断言所有路径默认启用。
