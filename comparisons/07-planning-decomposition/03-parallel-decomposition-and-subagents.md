---
title: Coding Agent 的并行任务分解与子 Agent 委派
series: Coding Agent 的 Planning 与 Task Decomposition
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的并行任务分解与子 Agent 委派

## 结论

把任务交给多个子 Agent，不等于把多个模型请求同时发出去。真正的并行分解需要同时定义：任务如何切分、依赖如何表达、每个执行者拥有什么 Environment、结果如何汇聚、冲突如何处理，以及父 Agent 是否有权接受子任务的副作用。

并行执行的核心关系是：

```text
Parent plan
   ↓ decomposition
Child work items
   ↓ admission / assignment
Child Agent runs
   ↓ observations / artifacts / proposed changes
Integration boundary
   ↓ validation
Parent plan revision
```

并行的主要收益是降低等待时间、隔离探索、利用不同模型或工具能力；主要代价是共享状态冲突、结果验证成本、权限传播和恢复复杂度。

因此，Coding Agent 的并行不是简单的 `Promise.all`，而是一个带有 ownership、Environment scope 和 integration gate 的 Runtime 协议。

## 1. 为什么任务可以或不能并行

### 1.1 可并行的条件

两个工作项通常在以下条件同时满足时可以并行：

- 目标和验收条件相对独立；
- 不写入同一资源，或有明确的合并协议；
- 一个工作项不需要另一个的中间结果；
- Environment 能够隔离或提供版本条件；
- 权限范围可以分别审批；
- 结果可以在 integration gate 汇聚和验证。

例如：

```text
Agent A: 分析现有 API 使用点，只读
Agent B: 分析测试覆盖，只读
Agent C: 阅读构建配置，只读
```

这三个任务可以并行，因为它们主要产生观察和建议。

### 1.2 不适合并行的条件

以下情况通常需要串行或锁定：

- 两个 Agent 修改同一个文件；
- 后一个任务依赖前一个生成的接口；
- 两个任务都会迁移同一数据库或资源；
- 一个 Agent 的结果会改变另一个 Agent 的 Context；
- 需要共享一个不可分叉的进程或设备；
- 无法验证哪个结果先提交。

把不具备独立性的任务强行并行，往往只是把冲突从模型决策阶段推迟到 Environment 和 Git 合并阶段。

## 2. 分解的三种粒度

### 2.1 Exploration split

多个子 Agent 只读地探索不同区域，返回 observation、风险和建议。它们不直接修改共享 Workspace，父 Agent 负责综合。

这是最安全的并行形式：

```text
parent goal
  ├── inspect implementation
  ├── inspect tests
  └── inspect build/dependencies
       ↓
    parent synthesis
```

### 2.2 Implementation split

不同 Agent 修改不同文件、不同模块或不同分支。它需要明确文件 ownership、依赖关系和合并方式。

### 2.3 Verification split

主 Agent 完成修改后，多个子 Agent 并行运行测试、审查 diff、检查安全和检查文档。验证任务通常不应修改代码，或者修改必须作为 proposal 返回。

不同粒度不应使用同一套结果协议。探索返回观察，实施返回 patch/artifact，验证返回 verdict 和 evidence。

## 3. 子 Agent 的最小契约

父 Agent 委派一个子任务时，至少需要提供：

```text
child_run_id
parent_session / turn / work_id
goal
scope
constraints
Environment reference
allowed tools and permissions
input snapshot
acceptance criteria
deadline / cancellation policy
result schema
```

子 Agent 返回的结果也需要结构化：

```text
status
summary
observations
artifacts
proposed changes
tests/evidence
environment version
unresolved risks
next recommendation
```

只返回一段自然语言摘要，会让父 Agent 无法判断子任务是否真的完成、哪些文件发生变化、哪些结论仍是假设。

Codex 的多 Agent wait/steer 路径说明父任务需要订阅子任务的输入活动和结果；Kimi Code 的 subagent context 与 task persistence 则把父子运行关系作为显式状态。[^codex-wait] [^kimi-subagent] [^kimi-task]

## 4. Parent 与 Child 的状态关系

父任务不能简单地把子 Agent 当成一个同步函数。至少要区分：

```text
Parent work item
  ├── child admitted
  ├── child running
  ├── child waiting
  ├── child completed
  ├── child failed
  ├── child cancelled
  └── child result accepted / rejected
```

子 Agent completed 不等于父计划项 completed。父 Agent 仍然需要检查：

- 结果是否符合 acceptance criteria；
- 结果是否基于正确的 Environment；
- artifact 是否实际存在；
- 子 Agent 是否越过权限边界；
- 与其他子任务是否冲突；
- 是否需要额外的集成测试。

父 Agent 对子结果的接受本身是一个 integration event，应当被记录。

## 5. Environment 隔离模型

### 5.1 共享 Environment

所有 Agent 在同一个工作树或容器中读写。

优点：结果即时可见，合并成本低。

风险：

- 文件覆盖；
- 中间状态被其他 Agent 读取；
- 测试和构建互相干扰；
- 一个 Agent 的 cleanup 影响另一个；
- 无法判断某个结果由谁产生。

共享 Environment 适合只读探索或严格分区的写操作，不适合无约束的并行修改。

### 5.2 分支/Worktree 隔离

每个 Agent 使用自己的 Git worktree、branch 或 snapshot。结果以 patch、commit 或 artifact 返回父 Agent。

优点是副作用隔离和审计清晰；代价是合并冲突、依赖安装重复、环境初始化和跨分支测试成本。

### 5.3 容器或远程 sandbox 隔离

每个 Agent 拥有独立容器、远程 workspace 或 ephemeral sandbox。适合高风险代码执行和不同依赖版本，但需要额外的 artifact transfer、租约和生命周期管理。

OpenHands 的 agent-server、sandbox、workspace 和 session context 展示了远程环境下父子任务的复杂边界：子 Agent 的结果不能只用一段消息表达，还要说明 artifact 在哪个 workspace 中产生。[^openhands-adapter]

### 5.4 只读镜像 + 结果存储

探索 Agent 可以使用只读代码镜像，结果存入独立 artifact store。这种结构降低共享工作树冲突，适合代码搜索、架构分析和安全审查。

## 6. 依赖图与执行顺序

并行计划通常不是平面的列表，而是有依赖的 DAG：

```text
inspect API ──────┐
inspect tests ────┼──> design change ──> implement ──> verify
inspect build ────┘             │
                                └──> security review
```

调度器需要区分：

- hard dependency：前置任务未完成不能开始；
- soft dependency：可以先开始，但结果可能改变；
- artifact dependency：需要特定文件或报告；
- Environment dependency：需要同一个 workspace version；
- approval dependency：需要用户授权。

如果只按创建顺序运行，系统可能把尚未准备好的子任务交给 Agent，导致大量无效重试。

## 7. 结果汇聚不是字符串拼接

父 Agent 汇聚子结果时，需要做三件事：

1. **归属**：结果属于哪个 child run 和 work item；
2. **验证**：结果是否满足 acceptance 和 Environment 条件；
3. **投影**：哪些结果进入父 Agent Context，哪些只保留在 artifact/audit 中。

一个子 Agent 返回“测试通过”，父 Agent 至少要知道：

- 执行的测试命令；
- 测试运行的 commit/worktree；
- 返回码和输出摘要；
- 执行时间；
- 是否有未提交文件；
- 是否与其他 Agent 并行修改冲突。

结果汇聚应生成新的 `ChildResultAccepted` 或 `ChildResultRejected` 事件，而不是直接把摘要写入父 Agent 的消息历史。

## 8. 共享 Workspace 的冲突

共享 Workspace 中至少存在三种冲突：

### 8.1 写写冲突

两个 Agent 修改同一个文件或同一区域。可以通过 file ownership、锁、patch merge 或 revision check 处理。

### 8.2 读写冲突

一个 Agent 基于旧文件读取结果规划，另一个 Agent 在它执行前修改文件。旧 Context 变得过期，结果可能覆盖新修改。

### 8.3 语义冲突

文件没有直接冲突，但两个修改改变了相同接口、测试假设或配置语义。只能通过集成测试、类型检查和父 Agent review 发现。

Environment identity 不仅是路径；还需要 workspace version、branch、commit 或 snapshot。否则父 Agent 无法判断子结果是在什么代码状态下产生的。

## 9. 权限如何传播

父 Agent 的权限不应自动成为子 Agent 的全部权限。需要定义：

```text
child_capability =
  parent_grant
  ∩ task_scope
  ∩ environment_scope
  ∩ policy
```

例如父 Agent 获准读取仓库，子 Agent 可以获得只读能力；父 Agent 获准修改一个文件，不代表子 Agent 可以删除目录或访问网络。

审批可以发生在三个层次：

- 委派审批：是否允许创建子 Agent；
- 能力审批：子 Agent 可以使用什么工具；
- 动作审批：子 Agent 的具体写入、网络或发布动作。

Codex 的 permission/approval 绑定调用身份；Gemini CLI policy engine 和 Kimi permission gate 在工具执行前进行能力判断。[^codex-approval] [^gemini-policy] [^kimi-permission]

如果子 Agent 返回 patch，父 Agent 接受 patch 也应重新检查目标文件和权限，而不是把子 Agent 已经执行过的动作视为父 Agent 的授权事实。

## 10. 取消与超时

取消父任务时，不能简单 kill 父模型请求后假设子 Agent 也停止。父子任务需要明确取消传播：

```text
parent cancel requested
  ├── stop admitting new children
  ├── send cancellation to active children
  ├── wait for child acknowledgement
  ├── reconcile child Environment effects
  └── finalize parent state
```

如果某个子 Agent 不可达，父任务应将其标记为 orphaned 或 unknown，而不是 completed/cancelled。远程 sandbox、后台服务和外部 API 可能继续产生副作用。

Codex 的 abort-all、wait_agent 和输入活动处理展示了父任务与子任务等待、取消和 steer 的边界；OpenCode 的 execution claim 则说明 worker 接管和任务终止需要独立协调。[^codex-abort-all] [^codex-wait] [^opencode-execution]

## 11. 子 Agent 的模型与 Context

子 Agent 不应默认继承父 Agent 的完整 Context。应根据任务 scope 选择：

- 用户目标和不可违反约束；
- 相关文件和工具结果；
- 当前 Environment identity；
- 子任务 acceptance criteria；
- 必要的父任务事实；
- 不应泄露的其他子任务或内部策略。

Kimi Code 的 subagent context 和 fork metadata 体现了父子运行需要显式边界；Codex 的子 Agent 工具则通过 wait/steer 等接口把父任务订阅关系表达出来。[^kimi-subagent] [^codex-wait]

完整复制父 Context 的代价是 token、隐私和状态耦合；只传一句任务描述的代价是子 Agent 缺少必要约束。更好的方式是根据 child work item 生成最小充分 Context。

## 12. 子 Agent 结果的可信度

子 Agent 输出可以分成：

```text
Observation       读取到的文件、测试和命令结果
Proposal          建议的修改或下一步
Artifact          patch、commit、报告或生成文件
Claim             子 Agent 对完成状态的描述
```

父 Agent 应优先验证 Observation 和 Artifact，不能只接受 Claim。一个子 Agent 说“已修复”，需要父 Agent 重新检查 diff 或运行验收测试。

对于只读分析任务，父 Agent 可以将多个结果作为候选证据汇聚；对于写入任务，必须先在 integration Environment 验证 artifact。

## 13. 子任务失败与部分成功

并行任务中，一个 child 失败不一定导致 parent 全部失败：

```text
child A: completed
child B: failed
child C: completed
```

父计划可以：

- 继续使用 A/C，重新规划 B；
- 将 B 标记 blocked，等待用户；
- 因 B 是 hard dependency 而暂停全部后续工作；
- 取消其他 children 并回滚/对账 Environment。

关键是依赖图和 acceptance criteria，而不是固定的 `Promise.all` 语义。

如果子 Agent 已产生部分副作用，失败结果还需要包含 effect state。父 Agent 不能仅因为 child 返回 error 就再次分派同一个写操作。

## 14. 各 Agent 的并行与子 Agent 边界

### 14.1 Codex：父任务等待与 steer

Codex 提供多 Agent 工具、等待子 Agent、订阅输入活动和 steer 相关控制。父任务可以等待子任务结果，同时处理新的用户输入，但这要求明确 child run 的身份、状态和结果归属。[^codex-wait]

它更强调产品交互和任务控制：子 Agent 是父 Turn 中可管理的运行单元，而不只是并行函数。

### 14.2 Pi：可组合 loop 与 harness operation

Pi 底层 Agent loop 可以被应用组合成多个运行实例；durable harness 的 lane、operation 和恢复机制为并行执行提供了更高层的状态边界。[^pi-loop] [^pi-harness]

Pi 不强制统一的 parent/child product protocol，应用需要自己定义 Environment 隔离、结果汇聚和权限传播。

### 14.3 OpenCode：execution claim 与 Session 运行责任

OpenCode 的 execution claim、Session execution 和 workspace provider 体现了多运行者协调的责任边界。[^opencode-execution] [^opencode-workspace]

并行任务能否安全运行，取决于 operation claim、workspace scope 和结果集成，而不是 Session message 中是否出现多个 assistant/tool 消息。

### 14.4 OpenHands：远程 Agent/Workspace 分离

OpenHands 的 agent-server、sandbox、workspace 和 conversation 使子任务可能位于不同服务或执行环境。[^openhands-adapter]

其并行执行重点是远程资源、artifact 和服务生命周期；父 Agent 需要知道子结果在哪个 workspace 产生，以及环境是否仍然可访问。

### 14.5 Kimi Code：Subagent run 与持久 task state

Kimi Code v2 将 subagent context、mirror run、task persistence、prompt/step request 和 tool dedupe 分层。[^kimi-subagent] [^kimi-task] [^kimi-dedupe]

这为父子任务、请求取消和恢复提供了较清晰的身份边界，但结果是否已被父任务接受仍需要独立 integration 状态。

### 14.6 Gemini CLI：Agent loop 与工具并发

Gemini CLI 的 Session loop、动态 instructions 和工具执行支持模型驱动的连续任务，但子 Agent 和跨 Environment 的并行委派通常需要更高层应用协议。[^gemini-session]

### 14.7 mini-SWE-agent：最小对照基线

mini-SWE-agent 默认是单 Agent trajectory；并行和子 Agent 不是核心运行时责任。[^mini-default]

它提供一个重要基线：如果没有 child identity、Environment scope 和 integration gate，多 Agent 只是多个独立进程，无法自动形成可靠的父子任务系统。

## 15. 设计原则

### 原则一：并行的前提是可验证的独立性

不能因为两个任务在语言上不同，就假设它们在文件、资源和语义上独立。

### 原则二：每个子 Agent 都有独立身份和 Environment 引用

共享 Session 不等于共享 Workspace，也不等于共享权限。

### 原则三：父 Agent 负责接受结果，不盲信结果

子 Agent 的 completed 是候选状态，父 Agent 通过 integration gate 验证后才进入父计划。

### 原则四：权限沿任务范围收缩传播

父权限是上限，不是子 Agent 的默认全部权限。

### 原则五：副作用要在集成边界发生

能返回 patch 或 artifact 的子任务，应尽量隔离执行，把共享 Workspace 的写入放到父级集成阶段。

### 原则六：取消必须传播并可对账

停止父模型请求不等于停止子 Agent 或回滚子 Environment。

### 原则七：部分成功是一等结果

父计划需要能够接受部分 child 完成，同时显式处理失败、阻塞和未知副作用。

## 16. 验证方案

### 16.1 独立性实验

构造四个子任务：两个只读探索、一个独立文件修改、一个共享文件修改。验证调度器是否：

- 识别可并行和不可并行任务；
- 为每个 child 分配唯一身份；
- 阻止共享文件的无协调写入；
- 将结果汇聚到 integration gate。

### 16.2 Environment 隔离实验

分别使用共享工作树、Git worktree 和独立容器，比较：

- 观察是否可复现；
- 修改是否相互污染；
- artifact 如何返回；
- 合并冲突如何处理；
- 恢复后能否识别副作用来源。

### 16.3 取消与 worker 丢失实验

在 child 的模型请求前、工具执行中、effect 完成后、结果回传前分别终止 worker，观察父任务是否进入正确的 waiting、orphaned、reconciled 或 failed 状态。

### 16.4 父结果接受实验

让 child 返回错误的“测试通过”声明，但实际 artifact 不满足验收条件，验证父 Agent 是否重新运行检查，而不是直接把 child claim 写入 completed。

本文没有在各 Agent 上统一执行上述多 Agent 实验。源码和测试可以证明 wait、claim、task、Action/Observation 或 subagent context 的结构，但不能自动证明真实部署中的并行冲突和远程 Environment 隔离。

## 未确认事项

- 各 Agent 的 parent/child plan 是否共享同一持久化 store，需继续检查实际运行路径。
- 子 Agent 的权限是否由父 Agent 自动继承，还是由服务端重新解析，需要结合部署配置确认。
- 共享 Workspace 下的文件锁、Git worktree 和远程 sandbox 行为不能从模型调用代码直接推断。
- 子 Agent 结果的 acceptance 是否由父模型、Runtime policy 还是用户共同决定，各项目可能不同。

下一篇将研究计划恢复与验收：父 Agent 如何从子任务、工具轨迹和 Environment 状态重建计划，并判断一个复杂任务是否真正完成。

## 参考源码

[^codex-wait]: [Codex wait_agent input activity](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^codex-approval]: [Codex approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L3034-L3085)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^codex-abort-all]: [Codex abort-all queue handling](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L509-L535)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^pi-loop]: [Pi agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)
[^pi-harness]: [Pi durable harness lanes and restoration](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts#L28-L110)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^gemini-session]: [Gemini CLI SDK Session and stream loop](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L150-L300)
[^kimi-dedupe]: [Kimi tool call deduplication](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts#L1-L80)
[^openhands-events]: [OpenHands Action and Observation event types](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/types/agent-server/type-guards.ts#L65-L150)
[^mini-default]: [mini-SWE-agent default loop](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py)
