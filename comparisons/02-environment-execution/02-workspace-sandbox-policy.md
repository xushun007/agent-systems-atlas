---
title: Workspace、Sandbox 与权限：Environment 的资源边界
series: Coding Agent 的 Environment：执行世界的抽象、控制与恢复
part: 2
reviewed_at: 2026-09-17
status: draft
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Workspace、Sandbox 与权限：Environment 的资源边界

## 结论

Workspace、Sandbox 和权限解决的是三个不同问题：Workspace 定义 Agent 主要操作的资源域，Sandbox 限制执行动作能够触达的资源，权限系统决定某个具体动作是否被接受。三者可以由一个执行器同时实现，但不能互相替代。

最常见的错误是把“目录在 workspace 内”当成“动作安全”，或者把“命令在容器中运行”当成“workspace 已隔离”。前者忽略了网络、凭据、进程和外部服务；后者忽略了共享挂载、宿主机通信、持久卷和子任务。可靠的 Environment 必须把资源身份、访问范围、授权时点和副作用边界明确分开。

本文研究 Codex `rust-v0.154.0`、Pi `v0.85.1`、OpenCode `v2.0.0`、OpenHands `v1.15.0` 和 mini-SWE-agent 当前研究版本，重点分析资源边界，不把源码阅读等同于安全审计或运行时证明。

## 1. 四个容易混淆的概念

### 1.1 Workspace：主要状态域

Workspace 是 Agent 预期读取和修改的项目状态域。它通常包含源码、测试、构建文件和 Git 元数据，但不必覆盖命令会接触的全部资源。

Workspace 要至少标记四种属性：

| 属性 | 问题 |
| --- | --- |
| 可见 | Agent 能否读取该路径 |
| 可写 | Agent 能否创建或修改内容 |
| 可提交 | 变化能否通过 Git 或其他版本系统记录 |
| 可恢复 | 是否有明确机制恢复到先前状态 |

一个目录可以可写但不可恢复；一个 Git worktree 可以回滚文件，但无法回滚数据库、上传请求或启动的后台服务。因此 workspace 是资源范围，不是完整事务。

### 1.2 Sandbox：执行约束

Sandbox 是对执行动作施加的约束集合，可能限制文件路径、网络、系统调用、进程、资源用量和凭据。容器、虚拟机、macOS sandbox、bubblewrap 和远程执行服务都是可能的承载机制，但“使用了容器”本身不是 Sandbox 语义的完整定义。

Sandbox 的核心问题不是 Agent 运行在哪台机器，而是：当工具试图访问资源时，哪个层拒绝它，拒绝结果是否可观察，策略是否覆盖子进程和间接访问。

### 1.3 Permission：动作授权

Permission 处理“这一次动作是否允许”。它可能由用户确认、组织策略、路径规则、工具级规则和当前会话模式共同决定。Permission 可以在 Sandbox 之外提前拒绝，也可以在执行器中作为最后一道检查；但 prompt 中的说明不构成强制授权。

### 1.4 Trust：资源关系

“可信目录”通常表达用户愿意让 Agent 在某个资源域内工作，但 trust 不应自动等同于完整主机访问。可信 workspace 可能仍然禁止网络、读取密钥或访问父目录。信任是一种策略输入，Sandbox 才是实际约束。

## 2. 资源边界的组合模型

可以把一次工具调用的允许条件写成：

```text
Allowed(action) =
  InWorkspace(action.target)
  AND SandboxAllows(action)
  AND PolicyAllows(action, current_authority)
  AND EnvironmentOwns(action.resource)
```

这不是某个项目的代码公式，而是分析时需要分别检查的四个问题。它们的失败语义也不同：

- 不在 Workspace：目标资源归属错误；
- Sandbox 拒绝：执行载体不允许触达；
- Policy 拒绝：动作尚未取得授权；
- 不拥有资源：当前 Session 或 runner 无权代表该环境执行。

如果四个条件在一个 `exec` 函数中全部隐式完成，代码可能很短，但审计和恢复会很困难。若四个条件都显式化，又需要处理它们在目录迁移、权限刷新和子进程启动之间的竞态。

## 3. Codex：路径策略、网络策略与审批的组合

Codex 在 `rust-v0.154.0` 中将文件系统 Sandbox 和网络 Sandbox 分开建模。内置权限 profile 可以形成 read-only、workspace-write 等文件策略，并根据配置决定网络受限或启用。workspace-write 不等于任意路径写入，而是带有 writable roots 等范围约束。[^codex-permissions]

对应安全测试覆盖了 workspace-only writable roots、父目录关系、外部 Sandbox 的自动审批以及显式不可读路径对自动审批的影响。测试的重要价值不在于证明所有平台行为一致，而在于显示授权判定依赖路径和网络策略的组合，而不是只看一个全局模式名。[^codex-safety]

Codex 的执行条件还会进入 Step Context：环境选择、能力根目录和工具路由与本次模型请求绑定。这样做使模型请求所宣称的能力与实际执行路径具有共同的 Step 归属；但文件系统策略仍由执行层强制，不能由 Step Context 的记录替代。[^codex-step]

一个关键区分是：权限 profile 是策略，sandbox policy 是编译后的执行约束，approval 是某个动作或策略冲突的交互处理。用户批准一次越界动作，不应被解释成永久扩大 Workspace；它通常只改变当前动作的准入结果，除非产品明确将其提升为信任配置。

## 4. Pi：注入式执行环境与本地进程边界

Pi v0.85.1 的 `NodeExecutionEnv` 将执行环境注入 Agent harness。它保存基础 `cwd`、可选 shell path 和 shell 环境，负责相对路径解析、启动 shell、捕获输出、超时和 child PID 管理。收到 abort signal 时，它尝试终止进程树。[^pi-env]

这说明 Pi 的 Environment 抽象已经超过直接调用 Node `spawn`：

1. 相对路径由环境的 cwd 统一解析；
2. shell 环境可以由注入配置决定；
3. 输出过大时写入 spill 文件，保持结果可读性；
4. 超时和取消进入同一个 child 生命周期；
5. 活动 child PID 被环境记录并在 settle 时移除。

但该实现的边界也必须明确。`NodeExecutionEnv` 不是完整的权限策略引擎，也不是 Workspace transaction manager。它可以启动和停止本地进程，却不自动知道某个目录属于哪个 Session，不自动建立 Git checkpoint，也不自动证明子进程产生的外部副作用已经撤销。

这是一种有意的分层：底层 Environment 提供可替换的本地执行能力，上层应用决定哪些工具能够得到它、何时请求审批以及如何持久化结果。若把该类直接暴露给不受信任的模型调用方，安全责任就会落在更上层的工具注册和策略代码中。

## 5. OpenCode：目录、Workspace ID 和 Permission Service 分离

OpenCode v2 的 Session 信息同时包含 `directory` 和可选 `workspaceID`。Session store 可以按目录和 workspace ID 查询；shell 服务使用 session location directory 作为命令 cwd。[^opencode-session]

这两个字段分别承担不同责任：directory 是执行定位，workspace ID 是更稳定的资源关联。它们不能简单互换。移动 Session 时，Runtime 需要决定是改变目录引用、改变 Workspace 归属，还是创建新的执行环境并保留历史关联。

OpenCode 的工具注册表明确不负责执行授权；工具叶节点负责资源解析、权限和副作用顺序，Permission 服务在工具执行流程中处理用户拒绝及修正错误。[^opencode-tool-boundary] 这是一条重要的架构边界：注册表负责“有哪些工具及其定义过滤”，权限层负责“当前调用是否允许”，工具叶节点负责“被允许后如何触达资源”。

因此，OpenCode 的 permission check 不是 prompt 中动态列出一个允许列表那么简单。工具 schema 可以影响模型选择，Permission assert 决定执行准入，文件解析和副作用顺序仍由具体工具控制。三者必须共享当前 Session/Environment 的资源上下文，否则同一条规则可能在描述阶段和执行阶段得出不同结果。

## 6. OpenHands：Workspace、worktree 与 sandbox 的不同层次

OpenHands v1.15.0 的 Conversation workspace 对外暴露 `working_dir`，文件浏览和修改以该目录为主要边界。child conversation 可以选择在父 workspace 中创建新的 Git worktree，也可以选择共享 workspace；Cloud child 则运行在独立 sandbox 中。创建 worktree 失败时，当前实现允许回退到共享 workspace，并向用户保留相应说明。[^openhands-child]

这段流程揭示了三个经常被混淆的层次：

| 层次 | OpenHands 中的含义 | 不能自动推出的保证 |
| --- | --- | --- |
| working directory | 工具和文件 API 的路径基准 | 不代表独占资源 |
| Git worktree | 文件版本视图的隔离 | 不隔离网络和进程 |
| Cloud sandbox | 远程执行与资源承载边界 | 不代表所有外部服务可回滚 |

worktree fallback 是一个产品层取舍：保证 child conversation 仍能开始工作，代价是隔离强度可能下降。此时最重要的不是把 fallback 隐藏起来，而是让 Environment 模式成为会话可见、可审计的状态。否则用户可能以为 child 修改的是独立分支，实际却改变了共享 workspace。

## 7. mini-SWE-agent：把 Environment 做成窄协议

mini-SWE-agent 的核心 `Environment` 协议接收 action 和 cwd，返回执行结果；Local、Docker、Singularity、bubblewrap、SWE-ReX 和 Modal 等后端通过同一类接口接入。[^mini-protocol]

这种设计把 Agent loop 与执行承载解耦。Agent 不需要知道命令是在本机、容器还是远程 Modal 中执行，只需要处理 action/observation。对研究和基准运行而言，这种窄接口非常有价值：替换环境不会迫使模型循环重写。

代价是资源边界的复杂语义不会自动出现在核心 Agent 中。LocalEnvironment 使用配置中的 cwd、环境变量和 timeout 执行命令；文本配置明确说明，每个 action 在新的 subshell 中执行，目录和环境变量的变化不会持久到下一个 action。[^mini-local]

这意味着 mini-SWE-agent 的 `cwd` 是每次 action 的执行参数，而不是一个拥有长期 shell 状态的 Environment identity。DockerEnvironment 可以提供容器级隔离，但是否保留容器、如何处理后台进程、如何恢复未完成动作，要由后端配置和外部运行器决定。

## 8. Permission 的时序：声明、询问、强制

一次工具调用的权限流程可以抽象为：

```text
tool advertised
       ↓
resource resolved
       ↓
policy evaluated
       ↓
approval requested if needed
       ↓
capability/sandbox enforced
       ↓
external effect
```

这条链中最容易被省略的是 `resource resolved`。例如 `write("config.json")` 不能在未解析符号链接、父目录和当前 Environment 的情况下判断是否越界。网络请求也不能只按工具名判断，目标主机、代理和凭据会改变实际风险。

审批的时机也影响一致性。若审批发生在模型请求前，模型可以只看到获准的工具；若审批发生在工具执行前，模型可能已经产生一个尚未执行的调用；若审批发生在 shell 启动后，Sandbox 必须保证等待期间没有副作用。三种方案都可成立，但必须记录调用处于哪个阶段。

权限变化同样不能简单覆盖已激活 Step。前一篇已经说明，稳定请求设置可以绑定到 Step，而管理授权等实时约束需要在动作激活前重新检查。这样既避免请求条件漂移，又避免已撤销的管理约束继续生效。

## 9. 为什么 Workspace rollback 不是 Environment rollback

Git reset 或 worktree 删除可以恢复一部分文件状态，但以下资源通常不在其范围内：

- 已发送的网络请求；
- 已写入的数据库或云端对象；
- 已发布的包和镜像；
- 已启动的服务和后台任务；
- 被修改的系统配置；
- 通过凭据产生的审计记录。

因此，Runtime 需要把“workspace diff”与“environment effect”分开记录。一个工具可以报告 `git diff` 为空，但仍然已经启动了一个后台服务；也可以回滚文件成功，但无法撤销已发送的部署请求。

更强的恢复需要为动作定义 effect class：纯读取、workspace-local 写入、可回滚 Git 写入、外部可查询动作、不可撤销动作。只有前几类适合由通用 Runtime 自动恢复；越靠近外部系统，越需要工具专属确认或人工介入。

## 10. 可复现验证设计

不需要模型 API 就可以构造一组资源边界实验：

1. 在 workspace 内外各放置一个文件，验证路径解析和写入结果；
2. 通过符号链接访问 workspace 外路径，验证策略按逻辑目标还是字符串路径判断；
3. 启动前台和后台子进程，观察 abort 后哪些进程仍存在；
4. 修改 shell 环境变量，验证新 action 是否继承；
5. 在权限等待期间改变策略，观察调用是按旧策略还是新策略准入；
6. 对 Git 文件和独立副作用文件分别回滚，记录回滚覆盖范围。

实验结果必须分为“路径边界”“进程边界”“策略边界”和“恢复边界”。一个本地测试通过，不能推出容器、远程执行和 Cloud sandbox 具有相同语义。当前本文完成源码及上游测试阅读，尚未运行这些故障和权限实验。

## 11. 设计原则

### 原则一：资源身份先于路径判断

先确定 Workspace、Environment 和执行所有者，再判断相对路径。路径是资源定位手段，不是资源身份本身。

### 原则二：策略必须在强制点生效

Prompt 和 UI 可以解释策略，不能承担最终约束。文件、网络、凭据和进程边界必须在执行器或受信任的远程环境中强制。

### 原则三：授权是动作级状态

用户批准的是某个动作在某个环境中的执行，不应无意中变成永久全局信任。若产品需要记住批准，必须明确其作用域和失效条件。

### 原则四：回滚范围必须可声明

“支持回滚”应明确是回滚文件、Git 引用、容器层，还是连同进程和远程副作用一起回滚。不能用 workspace rollback 暗示 Environment rollback。

### 原则五：降级路径必须可见

共享 workspace fallback、网络受限变更、外部 Sandbox 关闭和权限策略降级都会改变执行语义。Runtime 应将降级记录为 Environment 状态，而不是只写日志。

## 12. 结论

Workspace 是 Agent 主要修改的状态域，Sandbox 是执行载体的约束集合，Permission 是具体动作的授权结果，Trust 是这些决策的策略输入。四者只有组合起来，才能定义 Environment 的资源边界。

Codex 将文件、网络和路径策略编译为执行约束，并把环境能力带入 Step；Pi 将 cwd、shell、输出、超时和 child process 管理封装进注入式执行环境；OpenCode 把目录、Workspace ID、Permission Service 和执行所有权分层；OpenHands 将 Conversation workspace、Git worktree 和 Cloud sandbox 组合成可选择的隔离模式；mini-SWE-agent 则用窄 Environment 协议换取后端可替换性。

横向比较时，真正需要问的不是“是否支持 sandbox”，而是：Agent 能否识别自己正在操作的资源，Runtime 能否在正确的时点阻止越界，执行后能否说明改变了什么，以及恢复时能否区分可回滚、可重试和不可确定的副作用。

## 版本与证据范围

| 项目 | 版本 | commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |
| OpenHands | `v1.15.0` | `ab23be62ad724fe83483036a0900bed7b7859166` |
| mini-SWE-agent | 当前研究版本 | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |

本文没有运行真实 shell、容器、远程 sandbox 或权限交互实验；源码和测试证据只能证明实现路径与测试覆盖范围，不能替代部署环境中的安全验证。

[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-safety]: [Codex sandbox and approval safety tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/safety_tests.rs#L120-L275)
[^codex-step]: [Codex Step environment context](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-env]: [Pi `NodeExecutionEnv`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^opencode-session]: [OpenCode Session location and workspace](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/info.ts#L1-L70)
[^opencode-tool-boundary]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^openhands-child]: [OpenHands child conversation workspace modes](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/services/child-conversation-launch.ts#L253-L350)
[^mini-protocol]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local execution semantics](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
