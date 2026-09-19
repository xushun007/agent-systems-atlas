---
title: 后台任务、远程执行与多 Agent：Environment 的进程边界
series: Coding Agent 的 Environment：执行世界的抽象、控制与恢复
part: 3
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# 后台任务、远程执行与多 Agent：Environment 的进程边界

## 结论

工具调用返回后，Environment 可能仍在继续变化。后台进程、持久 PTY、远程 sandbox、子 Agent 和共享 Workspace 都会把一次短暂的 Tool Call 延伸为一个跨生命周期的执行关系。此时，工具调用不再是“请求—结果”二元交互，而是：**创建一个具有身份的执行资源，并由某个控制面持续拥有、观察、停止或移交它。**

本文的核心判断是：Environment 的成熟度，取决于 Runtime 能否区分四个边界：

1. 前台工具调用何时结束；
2. 背景资源是否仍然存在；
3. 哪个 Session、Turn 或 Agent 拥有该资源；
4. 资源如何跨进程、跨网络或跨子 Agent 被重新找到。

如果没有这些边界，`background: true` 只是 UI 标记，远程 sandbox 只是另一台机器，子 Agent 只是另一个模型循环，三者都无法形成可靠的 Environment 语义。

## 1. 从 Tool Call 到长生命周期资源

前台调用可以近似表示为：

```text
call -> execute -> observe -> settle
```

后台或远程调用则更接近：

```text
admit -> provision/start -> attach handle
      -> observe or detach
      -> interrupt/query/reconnect
      -> settle/release/recover
```

`handle` 是关键。它可以是 PID、PTY ID、容器 ID、sandbox ID、远程 conversation ID 或数据库 claim。没有稳定 handle，后续控制只能依赖模糊的命令名、目录或最近一条消息，容易把不同执行混在一起。

### 1.1 前台结束不等于资源结束

一个 shell 工具若启动开发服务器并立即返回，前台调用已经结束，但端口、进程树、日志文件和网络连接仍然属于 Environment。下一次 Step 可能依赖这个服务；取消原 Turn 时，又必须决定它是否随 Turn 终止。

因此，Runtime 要分别记录：

| 状态 | 事实 |
| --- | --- |
| call settled | 调用方不再等待该 promise |
| process alive | 进程或远程任务仍然存在 |
| resource attached | 当前 runner 仍持有控制句柄 |
| environment idle | 没有属于该环境的活动资源 |

这四个状态可能在不同时间发生。

## 2. Codex：Turn 任务与统一进程管理

Codex `rust-v0.154.0` 的任务抽象把 Turn 运行在 Session 管理的后台 Tokio task 中。任务拥有自己的 Turn 上下文和取消 token；后续输入不能任意改变已经拥有该 Turn 的后台工作。[^codex-task]

对于 unified exec，Codex 维护由执行器管理的进程，能够列出和终止后台 terminal。工具上下文可以携带 process ID，后续操作通过这个身份继续查看或控制进程，而不是重新按命令文本猜测目标。[^codex-unified]

这形成了两层所有权：

- Session task 拥有当前 Turn 的模型和工具流程；
- unified exec manager 拥有具体 terminal/process 资源。

取消 Turn 时，前者传播 token 并收敛任务；后者需要独立终止进程树。Turn 终态不能自动证明后台 terminal 已消失，除非执行器报告了这一事实。

Codex 还将多 Agent 能力接入工具路由。父 Agent 可以拥有管理子 Agent 的工具，但子 Agent 的执行条件、Turn 身份和输出生命周期必须独立记录。[^codex-router] “能启动子 Agent”不等于“子 Agent 与父 Agent 共享同一 Environment”；共享 Workspace、共享 Session 历史和共享进程管理需要分别证明。

## 3. Pi：本地 child PID 与 durable handle 的两种层次

Pi 的 `NodeExecutionEnv` 保存活动 child PID，并在 abort 时调用进程树终止逻辑。它适合处理同一 Node 进程内创建的本地子进程，能够把取消信号传递到当前调用的 child。[^pi-env]

但 PID 是本机、短生命周期的资源标识。进程重启后，PID 可能复用；跨机器或跨容器则完全失效。因此，PID 只能作为本地执行适配器的控制句柄，不能直接作为 Session 恢复身份。

Pi v4 harness 通过 lane、operation、deferred handle 和持久 frame 把执行关系提升到 durable runtime。恢复逻辑能够读取未完成 operation，并针对远程 deferred 句柄尝试取消；若取消结果不可确认，则发布 aborted/unknown 终态，而不是假设资源已经不存在。[^pi-reconcile]

这两层的差异值得保留：底层环境负责“如何杀本机进程”，durable harness 负责“如何识别未结算操作及其恢复策略”。将二者合并为一个 `Environment.stop()` 接口，会隐藏本地强制终止和远程尽力取消之间的语义差距。

## 4. OpenCode：持久 PTY 与 Session execution

OpenCode v2 提供 persistent PTY 能力，并对 PTY ID 做格式和数值校验；这表明持久 shell 资源拥有不同于一次性 `exec` 的身份和生命周期。[^opencode-pty]

SessionExecution 则管理 Session 级运行所有权：它区分 process-local active execution、interrupt、settlement 和 idle；数据库 claim 用于在进程退出后发现仍未结算的 Session execution。[^opencode-execution]

这两个机制不能互相替代：PTY ID 能找到一个终端资源，claim 能找到一个未完成 Session 执行。前者回答“哪个进程通道”，后者回答“哪个 Session 需要恢复”。一个 Session 可能拥有多个 PTY，一个 PTY 也可能在模型请求结束后继续存活。

OpenCode 的 Workspace driver 还要求 provider backing resource 按 workspace ID 幂等创建；注释明确考虑了“创建成功但绑定持久化前进程崩溃”和多个进程竞争同一 workspace ID 的情况。[^opencode-workspace-driver] 这把远程 Workspace 从一次 API 调用提升为可重试、可关联的 Environment resource。

## 5. OpenHands：本地 child、Cloud sandbox 与异步发现

OpenHands v1.15.0 的 child conversation 流程区分 local 和 cloud target。local child 可以在父 conversation workspace 中使用共享模式或新 Git worktree；cloud child 则运行在独立 sandbox 中。Cloud sandbox 的 ID 需要异步 provision，前端或服务层不能假设创建请求返回时资源已经可连接。[^openhands-child]

这种架构把子 Agent 的边界从模型循环扩展到资源编排：

```text
parent conversation
       |
       +-- child conversation identity
       |
       +-- workspace mode: shared / new worktree
       |
       +-- target: local / cloud
       |
       +-- sandbox or agent-server handle
```

父子关系、Workspace 关系和 sandbox 关系是三个不同的边。父 Agent 可以知道 child 的任务和结果，却不一定能直接读取 child 的进程；两个 child 可以共享文件，但不共享 sandbox；Cloud child 可能因暂停、冷启动或网络连接变化而暂时不可达。

实现中还存在两个容易被忽略的控制流：如果父 workspace 没有可用于创建 worktree 的 Git 提交，worktree 隔离会失败；如果 agent-server 不支持 parent/child link 持久化，child 可能已经创建但无法形成完整关联。[^openhands-child] 这些不是 UI 细节，而是 Environment identity 建立失败后的降级语义。

## 6. 共享 Workspace 的一致性问题

多个 Agent 或后台任务共享 Workspace 时，至少存在三类冲突：

| 冲突 | 例子 | 需要的控制 |
| --- | --- | --- |
| 文件写写 | 两个 Agent 同时修改同一文件 | worktree、锁、patch 合并或串行化 |
| 文件读写 | 测试读取到半写入内容 | 原子写入、版本标记或重试 |
| 文件与进程 | watcher/服务器继续读取旧配置 | 进程重启、reload 协议或环境版本 |

Git worktree 只能处理一部分文件视图隔离。它不能阻止两个进程访问共享数据库，也不能自动协调端口和临时目录。共享模式必须是显式的产品选择，不应因为 worktree 创建失败而在无提示的情况下悄悄升级为共享写入。

Environment 还应记录 workspace generation 或 revision。一个 Step 读取文件时，若后台 child 已经修改了文件，Runtime 至少需要知道这次观察属于哪个 revision；否则模型上下文中的“当前代码”没有明确时间点。

## 7. 子 Agent 的 Environment 传递

子 Agent 通常继承父 Agent 的部分上下文，但不应默认继承全部执行能力。可以将继承项分为四类：

1. **任务语义**：目标、约束、输出格式；
2. **资源引用**：Workspace、文件路径、远程服务地址；
3. **能力授权**：可执行工具、网络、凭据和审批范围；
4. **运行所有权**：谁可以取消、恢复或销毁 child。

任务语义可以复制，资源引用需要验证，能力授权需要显式委托，运行所有权需要建立父子控制协议。把父 Agent 的完整 token、环境变量或 root 权限直接传给 child，会使隔离失去意义。

OpenHands 的 local/shared、local/worktree 和 cloud 模式提供了不同的资源继承选择；Codex 的工具路由和 Session task 则提供了父 Session 管理子 Agent 的入口，但具体 Workspace 是否共享仍需查看对应调用路径。本文不把存在 child-management tool 推导为完整的父子 Environment 隔离。

## 8. Remote Environment 的三种身份

远程执行常见的三个标识不应混淆：

| 标识 | 作用 |
| --- | --- |
| logical environment ID | 用户和 Session 看到的稳定资源身份 |
| provider resource ID | 云平台、容器或 sandbox 的实际资源身份 |
| connection/session handle | 当前进程连接远程资源的短期凭据或通道 |

provider resource 可能被销毁后按同一 logical ID 重建；connection handle 可能过期但 Environment 仍然存在；Session 可以持久化而远程资源处于 paused。恢复时应先恢复 logical identity，再重新获取 provider binding 和 connection。

OpenCode workspace driver 的 idempotent provider resource 约束和 OpenHands Cloud sandbox 的异步 provision 分别体现了这两个问题：资源创建和资源绑定不是一个原子步骤，连接可用也不代表资源生命周期已经完成。[^opencode-workspace-driver] [^openhands-child]

## 9. 取消、移交和销毁

后台与远程资源需要至少三个控制操作：

- `interrupt`：请求动作停止，结果可能仍未知；
- `handoff`：将控制权移交给另一个 runner；
- `destroy`：释放资源并阻止继续使用。

它们不能用同一个 `abort` 替代。interrupt 可能保留 Workspace 和日志；handoff 需要保证旧 owner 不再提交新动作；destroy 需要处理子进程、远程资源和持久绑定。

当服务重启时，最安全的顺序通常是：发现持久 intent，检查 owner 是否仍然有效，查询资源状态，再决定恢复、接管或标记 unknown。若旧 owner 只是网络断开而不是已死亡，直接恢复可能造成双重控制；若远程资源已经销毁，盲目重试可能重复外部 effect。

## 10. 可复现验证设计

不需要 API key 就可以测试本地部分：

1. 启动一个前台命令和一个后台 child，记录调用完成与进程退出的时间差；
2. 取消父 Turn，检查后续模型请求、工具调用和后台进程是否分别停止；
3. 让两个执行器共享目录，故意并发写同一文件，记录 Runtime 是否有冲突检测；
4. 模拟远程 handle 断线，区分“连接丢失”和“资源已销毁”；
5. 重启控制进程，使用持久 intent 判断是否能够找到原执行资源；
6. 让 worktree 创建失败，确认 fallback 是否被记录并对用户可见。

这些实验应同时记录 logical ID、process/provider ID、connection handle 和 workspace revision。只验证命令输出，无法验证 Environment 的所有权和生命周期。

## 11. 设计原则

### 原则一：长生命周期资源必须拥有稳定 handle

PID 和 WebSocket 不是跨重启的 Environment identity。Runtime 需要持久 logical ID，并记录它与本地/远程资源的绑定关系。

### 原则二：前台结算与环境空闲分离

工具 promise 结束不代表子进程、PTY、sandbox 或远程任务结束。用户界面、取消逻辑和恢复器必须使用正确的状态。

### 原则三：资源共享必须显式声明

共享 Workspace、共享进程或共享凭据都会改变风险和一致性语义。隔离失败后的 fallback 必须可追踪，不能伪装成原计划仍然成立。

### 原则四：父子 Agent 继承能力而非默认继承所有权

子 Agent 可以被授予完成任务所需的最小资源和能力；取消、恢复和销毁权限则需要单独委托。

### 原则五：远程控制要容忍连接与资源状态分离

连接中断只说明观察通道失效，不说明远程动作停止。恢复器必须查询资源状态或保守标记未知。

## 12. 结论

后台任务、远程 sandbox 和子 Agent 把 Environment 从“工具运行时”扩展为“长期资源系统”。它要求稳定身份、明确 owner、可查询状态、独立的取消和恢复协议，以及共享与隔离的显式模式。

Codex 将 Turn task 与统一进程管理分层，并通过 process ID 管理后台 terminal；Pi 从本地 child PID 进一步发展出 durable harness 的 operation/handle 恢复语义；OpenCode 将 persistent PTY、Session execution claim 和 Workspace provider resource 分开；OpenHands 将 child conversation、Git worktree、agent-server 与 Cloud sandbox 组合；mini-SWE-agent 则主要把远程和容器差异封装在可替换 Environment 后端中。

这些实现共同说明：Environment 的边界不是“命令在哪执行”，而是“动作结束后，谁仍然拥有一个可能继续变化的世界”。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文基于固定版本源码与已有测试阅读，未运行真实 Cloud sandbox、远程 provider、跨进程抢占或多 Agent 并发实验。

[^codex-task]: [Codex Session tasks and cancellation ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L170-L300)
[^codex-unified]: [Codex unified execution process management](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/runtimes/unified_exec.rs#L60-L110)
[^codex-router]: [Codex ToolRouter child management](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/router.rs#L110-L170)
[^pi-env]: [Pi NodeExecutionEnv child process lifecycle](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-reconcile]: [Pi durable harness reconciliation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/reconcile.ts#L1-L190)
[^opencode-pty]: [OpenCode persistent PTY](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/persistent-pty/index.ts#L400-L430)
[^opencode-execution]: [OpenCode SessionExecution ownership](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L20-L185)
[^opencode-workspace-driver]: [OpenCode Workspace provider driver](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^openhands-child]: [OpenHands child conversation and sandbox selection](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/services/child-conversation-launch.ts#L253-L430)
