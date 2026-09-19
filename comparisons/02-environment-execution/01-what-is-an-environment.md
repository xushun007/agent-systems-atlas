---
title: Coding Agent 的 Environment：执行世界的抽象、控制与恢复
series: Coding Agent 的 Environment：执行世界的抽象、控制与恢复
part: 1
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Environment：执行世界的抽象、控制与恢复

## 摘要

把 Coding Agent 的 Environment 定义为当前工作目录，能够解释最简单的 shell 调用，却无法解释现代 Agent Runtime 的大部分行为。一个 Agent 不只是进入目录、调用工具、读取字符串结果；它会启动进程、访问凭据、连接网络、修改文件、留下后台任务，并在下一次模型请求中继续观察这些变化。Environment 是这些动作发生的执行世界，也是 Runtime 施加能力限制、收集观察结果、管理生命周期和处理恢复的边界。

本文提出一个用于分析 Coding Agent 的工作定义：

> Environment 是 Agent 执行动作时所依赖的、可被观察、约束、改变并在一定条件下恢复的完整执行世界。

在这个定义下，`cwd` 是定位信息，Workspace 是状态域，Sandbox 是约束机制，Tool 是作用于 Environment 的动作，Observation 是 Runtime 对环境变化的可见投影。它们可以由同一个对象实现，也可以分布在 Session、执行器、容器管理器和持久化服务中；概念上不能混为一谈。

本文研究 Codex `rust-v0.154.0`、Pi `v0.85.1`、OpenCode `v2.0.0`、OpenHands `v1.15.0` 和 mini-SWE-agent 当前分析版本中的 Environment 语义。本文关注抽象边界，不评价具体产品的安全强度或执行效果。版本和 commit 以本文末尾的证据表为准。

## 1. 为什么 `cwd` 不是 Environment

最小的工具模型通常写成：

```text
result = execute(command, cwd)
```

这个模型隐藏了至少六个前提：命令由哪个进程执行、继承哪些环境变量、可以访问哪些文件、网络是否开放、超时如何处理、命令结束后还留下了什么。如果这些前提没有成为 Runtime 的显式状态，工具结果就缺少可解释的执行上下文。

更准确的模型应当是：

```text
(E, C, I, P) -> (E', O, F)
```

其中：

- `E` 是执行前的 Environment；
- `C` 是本次调用可使用的 Capability；
- `I` 是工具输入；
- `P` 是适用于本次动作的 Policy；
- `E'` 是动作之后可能已经改变的 Environment；
- `O` 是 Runtime 能观察到的结果；
- `F` 是与动作相关的执行证据。

`cwd` 只参与描述 `E` 的一个位置属性。它不能说明文件是否属于某个 Workspace、进程是否在容器中、凭据来自哪里、网络请求是否已经提交，也不能说明工具退出后是否仍有子进程运行。

### 1.1 一个可复现的反例

假设 Agent 执行：

```sh
echo ready > result.txt
curl -X POST https://example.invalid/deploy
```

工具返回 exit code `0`，只证明执行器观察到了一个成功退出状态。要回答“这个动作发生了什么”，还需要知道：

1. `result.txt` 写入的是哪个文件系统；
2. shell 是否继承了部署凭据；
3. 网络请求是否经过代理或 Sandbox；
4. 子进程是否在返回后仍然存在；
5. 后续恢复时是否可以重新发送部署请求；
6. 返回结果是否已经持久化。

如果 Runtime 只保留 `cwd` 和输出文本，以上事实无法从历史中可靠重建。

## 2. Environment 的组成

本文使用六个维度描述 Environment。它们不是要求实现必须有六个类，而是判断一个实现是否把执行世界的关键责任显式化的分析框架。

| 维度 | 需要回答的问题 | 典型实现载体 |
| --- | --- | --- |
| 身份与位置 | 当前执行属于哪个项目、目录或远程实例 | Session location、workspace ID、container ID |
| 文件状态 | 哪些文件可见、可写、可回滚 | workspace、mount、Git worktree、checkpoint |
| 进程状态 | 子进程、后台任务和服务是否存活 | process manager、job registry、PID/remote handle |
| 能力与策略 | 文件、网络、凭据和资源配额如何限制 | sandbox policy、approval、capability binding |
| 观察与证据 | 工具看到什么、改变了什么、如何记录 | stdout/stderr、events、diff、execution record |
| 生命周期与恢复 | 环境何时创建、复用、销毁和重建 | runner、container lifecycle、claim、replay policy |

这六个维度之间有依赖关系。没有身份，文件状态可能无法归属；没有进程所有权，取消无法收敛；没有策略快照，工具结果无法解释；没有执行证据，恢复只能猜测外部副作用。

### 2.1 Environment identity

Environment identity 不是路径字符串，而是 Runtime 能用来回答“这是哪个执行世界”的稳定引用。它可以包含项目、workspace、主机或容器、用户身份和版本信息。一个 Session 可以在同一 Environment 中经历多个 Turn，也可以被移动到新的 Environment；反过来，多个 Session 也可能共享同一个 Workspace。

因此，以下两个判断必须分开：

```text
Session.current_directory == /repo
Session.owns_environment == true
```

前者是位置事实，后者是生命周期和权限事实。仅设置 cwd 并不会自动获得后者。

### 2.2 Workspace state

Workspace 是 Agent 主要修改的状态域，但不一定等于整个 Environment。文件可能通过 mount 进入容器，Git worktree 可能只是源仓库的一份派生视图，构建缓存和系统目录则可能位于 Workspace 之外。研究 Workspace 时要区分可见、可写、可提交和可恢复四种属性。

一个文件“可写”并不意味着修改可以回滚；一个 Git worktree“可回滚”也不意味着数据库、网络服务或后台进程会回滚。Workspace rollback 只能覆盖它拥有的状态。

### 2.3 Process state

`exec` 返回后，命令的前台进程通常已经结束，但后台服务、孙进程、文件 watcher 和远程任务可能仍然运行。它们会改变后续 Step 观察到的环境，甚至占用端口、锁定文件或继续上传数据。

这使进程所有权成为 Environment 的一等属性。没有进程注册表的执行器只能说“这次调用的 child process 已等待结束”，不能说“这个 Environment 已经空闲”。

### 2.4 Capability and policy

能力不是工具名称的同义词。`bash` 可能在只读目录、受限网络或完整主机权限下执行，三者是不同能力。更准确的 capability 是动作、目标资源和执行上下文的组合。

策略也不是只在 prompt 中告诉模型的自然语言。模型可以被告知不能访问某路径，但真正的边界必须在执行器或环境层强制实施。Prompt 是意图和用户体验的一部分，Policy 才是 Runtime 的约束。

### 2.5 Observation and evidence

Agent 看到的工具输出是 Environment 的观察，不是 Environment 的完整状态。输出可能被截断、脱敏、压缩或延迟；文件变化可能没有出现在 stdout 中；远程服务的实际结果可能晚于本地命令退出。

因此，执行记录至少应将输入、工具身份、环境引用、策略、输出、退出状态和时间顺序关联起来。对高风险动作，还需要保存 diff、远程句柄或提交确认等额外证据。

## 3. 五个概念的严格区分

### 3.1 Environment 与 Session

Session 是交互和历史的归属边界；Environment 是动作发生的执行边界。Session 可以持久化而 Environment 已销毁，Environment 也可以继续运行而 Session 当前没有活跃模型请求。

把二者绑定得过紧，会导致恢复时只能恢复“聊天记录”，无法恢复执行世界；把二者完全分离，又需要显式处理 Session 如何重新取得环境所有权。

### 3.2 Environment 与 Turn

Turn 是一次工作意图的生命周期；Environment 是承载该意图的执行世界。一个 Turn 可能调用多个工具，工具可以共享同一 Environment。Turn 结束不必销毁 Environment，因为后续 Turn 可能继续使用文件、缓存和服务。

这也是为什么取消 Turn 不等于销毁 Environment。取消需要停止或标记属于该 Turn 的动作，同时决定后台任务是否转为 Session 级任务。

### 3.3 Environment 与 Step

Step 使用 Environment，但通常不拥有整个 Environment。Step 可以捕获环境引用、能力策略和当时可见的指令文件；文件和进程本身仍是外部可变状态。Step 快照保证的是“本次请求依据什么执行”，不是“世界在整个执行期间保持不变”。这与前一专题的结论一致：配置可固定，外部事实只能被观察或通过更强协议隔离。

### 3.4 Environment 与 Tool

Tool 是一个动作接口，Environment 是动作的承载者。工具描述“可以做什么”，环境决定“在什么资源上、以什么约束、由哪个身份做”。同一个工具在两个 Environment 中可能具有完全不同的实际语义。

### 3.5 Environment 与 Observation

Observation 是对 `E -> E'` 的部分投影。它可能包括文本、结构化结果、文件列表、diff、事件和错误。Observation 不等于 effect；一个命令没有输出不代表没有修改文件，一个 HTTP 200 也不代表业务操作已经被持久化。

## 4. 五个项目中的实现形态

### 4.1 Codex：Environment 进入 Step 的执行条件

在 Codex `rust-v0.154.0` 中，`StepContext` 包含 `TurnEnvironmentSnapshot`、已准备好的 capability roots、executor capability discovery、MCP binding、ToolRouter 和加载的 `AGENTS.md`。这说明 Environment 在 Codex 中不是 shell 工具的附属参数，而是被纳入请求级 Step 上下文的执行条件。[^codex-step]

Codex 的权限模型还区分文件系统 Sandbox 和网络策略，并根据 workspace-write、read-only、restricted 等配置形成不同能力。[^codex-permissions] 这类设计将“工具可见”与“工具能否对目标资源产生作用”拆开，Environment 因而同时承担资源选择和能力约束两个责任。

需要保持边界意识：`TurnEnvironmentSnapshot` 是对 Step 所依据环境选择的快照，不是文件系统的内容快照。它可以记录选中了哪些环境和能力根目录，却不能单独证明目录中的文件在执行期间没有变化。

### 4.2 Pi：从底层 Agent 的本机执行器到 durable harness

Pi v0.85.1 同时存在两种分析层次。底层 `NodeExecutionEnv` 是注入式 `ExecutionEnv` 实现：它以 `cwd` 解析路径和启动 shell，组合 shell 环境变量，跟踪活动 child PID，并在 abort 时尝试杀掉进程树。[^pi-env]

这已经超过“调用 `child_process`”的简单封装：超时、输出 capture、spill 文件、abort signal、child process tracking 都属于环境执行语义。但这个对象仍主要是本地执行适配器，不自动拥有 workspace identity、跨进程恢复或完整权限策略。

Pi v4 durable harness 则进一步把环境引用、lane 状态、执行记录和恢复策略纳入持久运行时。它能够在恢复 assistant generation 时重建可见历史，在工具 replay 时依据安全声明决定是否重放；这说明 Environment 的持久化问题已经从“目录在哪里”升级为“未完成动作作用于哪个执行世界”。[^pi-recovery]

### 4.3 OpenCode：Session location、Workspace 与执行服务分层

OpenCode v2 的 Session 信息包含 project、location 和可选 workspace ID；Session 的 location 目录与 workspace 关系由 Session context、move 和 projector 等模块维护。shell 服务使用 session location directory 作为执行 cwd，但执行服务本身又由 SessionExecution、runner、job 和数据库 claim 协调。[^opencode-session] [^opencode-execution]

这形成了一个清晰的分层：目录是命令定位，workspace ID 是更稳定的项目/环境关联，SessionExecution 负责当前进程的执行所有权，数据库 claim 负责跨重启发现未结算工作。单独读取 shell 的 cwd，无法得到 OpenCode 的完整 Environment 语义。

### 4.4 OpenHands：Conversation workspace 与 agent-server 边界

OpenHands v1.15.0 的 Conversation 对象携带 workspace 的 `working_dir`，文件 API、文件浏览和工具调用围绕该工作目录展开；child conversation 还可以在 workspace 中创建独立 Git worktree，失败时存在共享 workspace fallback。[^openhands-workspace]

这一形态显示了 Environment 的两个层次：对用户而言，workspace 是可浏览、可修改的项目空间；对 Runtime 而言，Conversation、agent-server、容器或 worktree 决定动作在哪个进程和文件边界内发生。worktree 只隔离 Git 文件视图，不自动隔离网络、凭据或外部服务。

### 4.5 mini-SWE-agent：明确的执行环境协议

mini-SWE-agent 将 Environment 定义为一个执行协议，核心接口接收 action 和 cwd 并返回结构化结果；实现可以是 local、Docker、Singularity、bubblewrap、SWE-ReX 或 Modal 等。[^mini-environment]

它的优点是边界直接：Agent 负责提出 action，Environment 负责执行。代价是核心协议不自动包含完整 Session identity、后台任务管理、工作区 checkpoint 或恢复语义。配置还明确指出，每个 action 在新 subshell 中执行，目录和环境变量变化不会自动持久化到下一次 action。[^mini-local]

这不是缺陷，而是一个有意选择：mini-SWE-agent 将 Environment 作为可替换执行后端，保持 Agent loop 简洁；需要持久 shell 状态或复杂恢复的系统必须在协议外增加能力。

## 5. Environment 的所有权问题

“谁拥有 Environment”应至少分解为四种所有权：

| 所有权 | 含义 | 典型问题 |
| --- | --- | --- |
| 资源所有权 | 谁决定文件、进程、网络资源属于哪个环境 | Session 结束后进程是否销毁 |
| 执行所有权 | 谁可以在此环境启动动作 | 两个 Turn 是否能并发执行 |
| 策略所有权 | 谁决定允许哪些动作 | 用户设置能否绕过组织策略 |
| 恢复所有权 | 谁决定未完成动作是否重试 | 崩溃后由哪个进程接管 |

一个 Runtime 可能让 Session 拥有资源，让当前 runner 暂时拥有执行权，让管理策略拥有最终否决权，让恢复服务拥有重建权。若文档只写“Session owns workspace”，并不能说明这些责任如何分配。

### 5.1 并发与租约

当一个 Environment 同时被多个 Turn 使用时，问题就从路径解析升级为并发控制。最简单的做法是串行化所有动作；更复杂的做法是按文件、工具或任务类别并发，并为执行权设置 claim 或 lease。

OpenCode 的持久 claim 主要表达 Session 有未结算执行，不等于一个分布式文件锁；Codex 的 Step snapshot 主要保证请求条件的归属，不等于独占目录；Pi 的 child PID 集合主要服务本地取消，不等于跨进程资源所有权。它们解决的是不同层次的问题。

### 5.2 Environment 移动

允许用户增加可信目录、切换 cwd 或把 Session 移到另一个 workspace 时，Runtime 不能只修改一个字符串。至少要决定：已有 Step 是否继续使用旧环境，新输入何时使用新环境，旧环境中的后台任务如何处理，权限和工具能力是否重新解析，历史如何记录迁移。

因此，Environment 迁移应视为一次受控的状态转换，而非普通配置更新。迁移事件应该带有旧环境引用、新环境引用、生效边界和失败处理。

## 6. Environment 是控制平面，不只是执行平面

Environment 的深层价值在于它把几个原本分散的问题汇合起来：

```text
用户意图
   ↓
Session / Turn 归属
   ↓
Capability 与 Policy 决策
   ↓
Environment admission
   ↓
Tool / Process / Remote action
   ↓
Observation + Effect evidence
   ↓
持久化、取消、恢复与审计
```

如果 Environment 只暴露 `exec(command, cwd)`，上层必须自己拼接权限、进程、文件和恢复逻辑；如果 Environment 还负责所有业务状态，又会变成无法替换的巨型对象。较好的边界是：Environment 拥有资源访问和执行语义，Session/Turn 拥有交互归属，持久化层拥有记录，策略层拥有约束；四者通过稳定引用和事件连接。

## 7. 研究判断标准

后续横向研究各 Coding Agent 时，可以用以下问题判断它的 Environment 抽象是否成熟：

1. 是否能区分目录、Workspace ID 和执行实例身份？
2. 文件、进程、网络和凭据是否具有不同的能力边界？
3. 工具执行前是否能重新检查实时策略？
4. 工具返回后，Runtime 是否记录外部副作用的证据？
5. 后台进程是否有明确的所有者和取消路径？
6. Session 重启后能否发现未结算动作？
7. 恢复器是否区分可安全重放与结果未知？
8. Workspace rollback 的范围是否明确排除数据库、网络和远程任务？
9. Environment 迁移是否留下可追溯的版本边界？
10. 测试是否覆盖了跨 Step、跨 Turn 和跨进程的状态变化？

这些问题比“是否支持 Docker”更有区分度。Docker 可能只是执行载体；真正的抽象质量体现在资源身份、策略约束、观察证据和恢复语义能否闭合。

## 8. 结论

Environment 是 Coding Agent 的执行世界，而不是工具参数的集合。它至少应能表达资源身份、文件状态、进程状态、能力策略、观察证据和生命周期。`cwd` 只是其中最容易暴露的一项；Workspace 只是主要状态域；Sandbox 只是约束手段；Tool 只是作用；Observation 只是部分投影。

不同项目的实现取舍不同：Codex 把环境选择和能力绑定带入 Step；Pi 从本地执行适配器逐步扩展到 durable harness；OpenCode 将 Session location、Workspace 和持久执行 claim 分层；OpenHands 将 Conversation workspace、agent-server 和 worktree 结合；mini-SWE-agent 则保持 Environment 协议小而明确，把复杂隔离交给可替换后端。

这些实现共同揭示一个架构事实：Coding Agent 的可靠性不只取决于模型能否产生正确命令，还取决于 Runtime 能否把命令放入正确的执行世界，并对世界发生的变化建立可解释、可限制、可取消和可恢复的关系。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文完成了源码和上游测试阅读，没有运行真实提供商、容器、远程执行或故障注入实验。因此，“代码路径具备某种能力”不等于“所有部署方式都已验证该能力”。下一篇应专门研究 Workspace、Sandbox 与权限控制，并通过可控本地环境验证资源边界。

[^codex-step]: [Codex `StepContext`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs)
[^codex-permissions]: [Codex permission configuration](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs)
[^pi-env]: [Pi `NodeExecutionEnv`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-recovery]: [Pi durable harness recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)
[^opencode-session]: [OpenCode Session location and workspace](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/info.ts#L1-L70)
[^opencode-execution]: [OpenCode SessionExecution](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L20-L185)
[^openhands-workspace]: [OpenHands child conversation workspace isolation](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62/src/services/child-conversation-launch.ts#L300-L350)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
