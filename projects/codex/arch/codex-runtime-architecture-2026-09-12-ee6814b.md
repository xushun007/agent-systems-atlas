---
title: Codex Runtime 架构
snapshot_id: 2026-09-12.ee6814b
reviewed_at: 2026-09-12
upstream_repository: https://github.com/openai/codex
upstream_commit: ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8
upstream_commit_date: 2026-09-12
previous_snapshot: 2026-08-14.7750465
status: current
change_level: major
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
diagram: ../diagrams/codex-runtime-architecture-2026-09-12-ee6814b.excalidraw
---

# Codex Runtime 架构

> 结论：Codex 仍以 `Session → Submission → SessionTask → Turn Loop` 作为控制主链；本版本最重要的变化，是在 Turn 内明确形成 Step 级设置与能力快照，并把工具执行扩展为 Environment-aware 执行。Storage 和 app-server 也从辅助设施演进为恢复与宿主控制面的重要边界。

- [可编辑 Excalidraw 图](../diagrams/codex-runtime-architecture-2026-09-12-ee6814b.excalidraw)
- [版本演进索引](codex-runtime-architecture-history.md)
- [上一快照](codex-runtime-architecture-2026-08-14-7750465.md)

## 视图边界

本视图解释一次持续会话如何接纳请求、建立 Turn、捕获 Step 快照、调用模型、执行工具并记录/恢复状态。它刻意弱化 `ThreadManager`、具体 Task 类型和平台实现类；多 Agent、Guardian、权限策略及 Context 构造分别由机制视图展开。

## 与上一快照相比

### 新增或增强

- **Step Snapshot**：模型、reasoning、service tier、reviewer、Environment、MCP binding、工具计划和 `AGENTS.md` 观察值在 sampling request 前被捕获。
- **Execution Environment**：工具不再只面向隐含的本地 cwd，而是经过选定环境连接本地/远程 executor、Worktree、Sandbox、Shell 和文件系统。
- **持久化治理**：Rollout 支持按需要物化；Thread 状态增加迁移、队列、附件、实时历史与 daemon recovery。
- **应用宿主**：app-server 增加 daemon、turn admission、线程队列、恢复和 user verification 等控制职责。

### 删除

- 独立 `codex mcp-server` 命令和 `codex-rs/mcp-server` crate 已删除。MCP 仍是 Session Runtime 的外部能力，不再作为与 TUI/Exec 并列的产品入口。

### 保持不变

- Submission 由单消费者串行分发。
- Session 同时只拥有一个前台 Task，审批、steer 和 interrupt 可在 Task 运行期间进入。
- `RegularTask` 可以多次调用 `run_turn()` 吸收边界时到达的 pending input。
- Turn 仍在模型采样、工具调用和 Observation 之间迭代，直到不再需要 follow-up。
- 事件流仍连接 Core 与客户端；Rollout Log 和 State DB 仍构成 record/restore 边界。

## 1. 接入与应用宿主

TUI、Exec 和 SDK 经嵌入式或远程 app-server client 进入 JSON-RPC 边界。app-server 将协议请求转换为 Core 操作，并把 Core 事件发布为通知；新版还承担 turn admission、排队、daemon 恢复和用户验证，因此它更接近 Application Host，而不是薄转发器。

`ThreadManager` 继续负责线程创建、恢复与 fork，`CodexThread` 暴露 Submission/Event 通道，但这些对象在高层图中被收进 Core 边界，避免把生命周期入口误画成 Runtime 的中心理念。[源码：`ThreadManager`](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/thread_manager.rs#L228) [源码：`CodexThread`](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/codex_thread.rs#L180) [源码：turn admission](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/app-server/src/turn_admission.rs#L18)

## 2. Session、Submission 与 Task

`Session` 是持续对话和运行资源的所有权边界。`submission_loop()` 串行消费用户输入、中断、审批响应和设置更新；需要执行的操作通过 `spawn_task` 进入统一的 `SessionTask` 生命周期，而不是阻塞 Submission consumer。[源码：Submission loop](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/handlers.rs#L411) [源码：SessionTask](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/tasks/mod.rs#L178)

这条外层控制链仍可以概括为：

`Submission Processing → spawn_task → SessionTask → run_turn`

`SessionServices` 继续内聚运行所需的横切服务，包括 Auth、Skills、Plugins、MCP、Extensions、Hooks、Telemetry、Environment、执行进程、网络审批和持久化句柄。[源码：SessionServices](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/state/service.rs#L46)

## 3. Turn 内新增 Step Snapshot 边界

上一快照把 Turn 级不可变 `TurnContext` 作为主要一致性边界。现在应区分三层：

1. `TurnContext` 保存 Turn 身份、初始设置、环境快照和生命周期状态；它还持有可替换的 `current_settings`。
2. `ResolvedStepSettings` 固定本次 Step 的模型元数据、reasoning、service tier 和审批 reviewer。
3. `StepContext` 再把 Environment、MCP binding、capability discovery、ToolRouter 和 `AGENTS.md` 观察值组合成一次 sampling request 的一致视图。

设置更新不会回写已经捕获的 Step；后续 Step 才读取新快照。这使一个 Turn 内可以安全切换模型或 reviewer，同时避免“模型看到的工具定义”和“实际执行能力”在同一次请求中漂移。[源码：StepSettings](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/step_settings.rs#L24-L68) [源码：StepContext](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/step_context.rs#L18-L43) [源码：TurnContext](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/turn_context.rs#L282-L338)

## 4. 模型—工具循环

`RegularTask` 仍负责发送 Turn started、接纳预热的模型 session，并循环调用 `run_turn()` 处理 pending input。[源码：RegularTask](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/tasks/regular.rs#L21-L92)

`run_turn()` 在每个安全边界捕获或刷新 Step，构建 Prompt，调用 Responses stream，收集工具 Future，把结果按顺序写回上下文，再由 follow-up、steer、Hook、压缩或 mailbox 决定是否继续。[源码：run_turn](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/turn.rs#L163-L280)

图中的 Reason、Act、Observe 是稳定语义，而非三个具体 Rust 类：

- **Reason**：用 Step Snapshot 构造 Prompt 并消费模型流；
- **Act**：ToolRouter 将模型调用交给授权和执行管线；
- **Observe**：工具结果、模型消息和事件写入历史，成为下一 Step 输入。

## 5. Environment-aware 工具执行

`build_tool_router()` 以当前 Step 的 Environment、MCP 和能力发现结果建立模型可见且可执行的工具面。[源码：Tool plan](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/tools/spec_plan.rs#L125-L180)

工具调用先经过路由、Policy/Approval 与 Guardian/Hook 扩展决策，再进入选定 Execution Environment。Environment 持有 cwd、workspace roots、文件系统、Shell、平台和 Sandbox context，因此执行目标可以是本地环境、远程 executor 或受管理的 Worktree，而安全策略仍在环境内收敛到具体平台执行器。

高层关系应表达为：

`Tool Routing → Authorization → Execution Environment → Shell / Files / MCP / Interaction`

而不是把整个工具执行层等同于 Sandbox。

## 6. Runtime Services

Runtime Services 是 Session 的横切能力集合，不是新的控制中心。当前高层视图列出：

- Auth 与 Model Catalog；
- Skills、Plugins、MCP 与 Extensions；
- Hooks、Guardian 与 User Verification；
- Environment、Memory 与 Telemetry。

具体实现可以拆到独立 crate，但其共同特征是为 Session/Step 提供能力或治理，并不替代 Submission/Task/Turn 的所有权关系。

## 7. Storage：记录、派生状态与恢复

Storage 仍保留两个稳定层次：

- **Rollout Log**：对话、事件和执行事实；
- **State DB**：线程元数据、索引、队列、附件和派生读取状态。

新版通过 `PersistContext` 和 `ensure_rollout_materialized()` 支持按操作需要创建持久化 writer，而不是假设所有 Session 从启动开始都立即拥有完整 Rollout。[源码：PersistContext / ThreadStore](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/thread-store/src/store.rs#L66-L110) [源码：lazy materialization](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/session/mod.rs#L1334-L1353)

Thread Store 还承担 legacy rollout migration、revert、历史物化和附件等职责；app-server daemon 可以记录并恢复被管理进程中断的线程。这些细节不进入主图节点，但改变了“record / restore”箭头背后的语义：它现在包含事实写入、索引派生、延迟物化、格式迁移和宿主恢复。

## 8. 关键设计解读

- **Turn 是生命周期，Step 是一致性单元**：Turn 管理用户可见任务，Step 固定一次模型请求及其工具能力。
- **执行环境成为能力边界**：工作目录、文件系统、平台与权限随 Environment 绑定，工具名不再隐含唯一执行位置。
- **宿主与 Agent Core 分工更清晰**：app-server 管连接、队列和恢复，Core 管 Submission、Task、Turn 与执行语义。
- **持久化支持运行形态差异**：延迟物化允许临时/内部 Session 与需要长期恢复的线程共享 Core，而不强制相同写入成本。

## 验证依据

- 源码阅读覆盖 `thread_manager.rs`、`codex_thread.rs`、`session/`、`tasks/`、`state/service.rs`、`tools/`、`thread-store/`、`rollout/`、`app-server/` 和 `app-server-daemon/`。
- 测试阅读覆盖 Step settings、Session lifecycle、Turn、Tool plan、rollout migration、thread recovery 与 app-server v2 thread/turn 场景。
- 本次没有执行端到端运行实验；所有行为结论均属于源码与测试验证。

## 未确认事项

- 尚未实测 live settings update 与正在运行的工具调用在真实客户端下的可见时序。
- 尚未实测本地、远程 executor 和 Worktree 三种环境下的权限等价性。
- daemon crash recovery、rollout migration 和历史物化只阅读了实现与测试，没有制造真实中断进行验证。
- Guardian、Context、Multi-Agent 和 Permission 独立机制文档仍基于较早 commit，需要逐一建立自己的版本索引。
