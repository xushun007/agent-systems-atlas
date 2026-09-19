---
title: Coding Agent 的 Sandbox、Workspace、Network 与 Secret 隔离
series: Coding Agent 的 Security / Trust Boundary
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 的 Sandbox、Workspace、Network 与 Secret 隔离

## 结论

Coding Agent 的 Environment 安全，不是给进程套一个 Sandbox 就结束。一个 Agent 能造成的实际影响，取决于多个边界的组合：

```text
Workspace scope
  × process privileges
  × network egress
  × Secret visibility
  × resource lifetime
  × child process control
  × remote service identity
```

任何一项过宽，都可能使模型错误或 Prompt Injection 转化为真实副作用。

Sandbox 解决的是“进程能触及什么”，Workspace 解决的是“代码和文件属于哪个资源范围”，Network 解决的是“数据能流向哪里”，Secret 管理解决的是“敏感凭证是否可被读取和转发”。它们必须一起设计。

核心原则是：

> 让模型和工具可以完成任务所需的最小 Environment，同时使任何单次错误都不会自动扩大到整个主机、整个仓库、任意网络和全部凭证。

本文比较本地 cwd、Git worktree、容器、远程 Sandbox 和服务化 Workspace 的安全边界，并讨论 Network、Secret、后台进程和资源销毁的恢复语义。

## 1. cwd 不是安全边界

把 Agent 放在 `/repo` 目录下，只能说明当前进程的工作目录，不代表它只能访问 `/repo`：

- `..` 可能访问父目录；
- 绝对路径可以访问其他目录；
- symlink 可以跳出工作树；
- 环境变量可能指向用户目录或 Secret；
- 子进程可能继承更高权限；
- Git hooks、构建脚本和包管理器可能执行外部动作；
- 网络请求不受 cwd 限制。

真正的 Workspace boundary 需要在文件系统、工具参数、进程权限和 Environment runtime 中共同实施。

## 2. Workspace 的安全模型

### 2.1 Read scope

Agent 可以读取哪些路径、链接、Git 元数据和构建产物。只读任务也可能泄露 Secret，因此 read scope 不能等同于“没有写权限就安全”。

### 2.2 Write scope

Agent 可以修改哪些文件和资源。应区分源代码、测试、构建配置、CI workflow、Git hooks、用户配置和系统文件。

### 2.3 Delete scope

删除应当是比普通写入更高的风险等级。递归删除、清理构建目录和重置 Git 工作树可能造成不可逆损失。

### 2.4 Execute scope

Workspace 中的文件可能通过 shell、hook、构建工具和脚本被执行。允许写入一个脚本目录，可能间接影响后续 CI 或开发环境。

### 2.5 Share scope

多个 Agent、用户和后台进程是否共享同一个工作树。共享 Workspace 需要 ownership、版本和冲突控制。

OpenCode 将 Workspace provider 与 Session execution 分层；OpenHands 将 workspace 与 sandbox/session context 分开；Codex 将 Environment 条件绑定到 Step。[^opencode-workspace] [^opencode-execution] [^openhands-adapter] [^codex-step]

## 3. Workspace 隔离方式

### 3.1 共享本地工作树

所有操作直接发生在用户目录。

优点是低延迟、文件立即可见、无需合并；风险是权限边界弱、用户修改与 Agent 操作交错、并行 Agent 互相污染。

适合低风险、单 Agent、用户明确控制的本地任务，但不适合不可信输入和高风险自动化。

### 3.2 Git worktree / branch

每个任务使用独立 worktree 或 branch，结果通过 diff/commit 合并。

优点是修改范围可审计、并行隔离较清晰；风险是 hook、子模块、凭证和远程操作仍可能越过 worktree，合并时也会产生语义冲突。

### 3.3 Overlay / snapshot

Agent 在写时复制或 overlay filesystem 中工作，用户工作树保持不变，成功后再提交 patch。

优点是 rollback 和审查更容易；代价是大仓库性能、外部进程、文件权限和 snapshot 生命周期复杂。

### 3.4 Container / local sandbox

Agent 在容器或受限进程中执行，Workspace 以 volume 或 snapshot 暴露。

容器提供进程、文件和网络隔离，但 bind mount、Docker socket、宿主机目录和特权模式可能削弱边界。

### 3.5 Remote sandbox / service workspace

Agent 在远程服务中执行，Session 只保存 workspace、sandbox、租约和服务引用。

优点是隔离和资源控制；风险是远程身份、网络、artifact、数据区域、租约和销毁语义更加复杂。

OpenHands 的 agent-server、sandbox、workspace、service URL 和 session key 体现了远程 Environment 的多层边界。[^openhands-adapter]

## 4. Snapshot 与 rollback 的边界

Workspace snapshot 可以帮助恢复，但不是所有副作用都包含在快照中：

- 文件内容可能包含；
- 进程状态通常不包含；
- 网络请求已发生；
- 远程资源已创建；
- Secret 使用记录可能不完整；
- Git hook 或系统缓存可能产生外部变化。

因此：

```text
workspace rollback ≠ effect rollback
```

Rollback 文件只能恢复文件状态，不能自动撤销发送的邮件、创建的云资源或已发布的包。Environment API 应明确 snapshot scope 和 excluded effects。

## 5. Sandbox 的隔离维度

一个 Sandbox 至少需要说明：

| 维度 | 问题 |
| --- | --- |
| filesystem | 可见、可读、可写哪些路径 |
| process | 能否启动、终止、观察其他进程 |
| privilege | uid/gid、capabilities、sudo 是否可用 |
| network | 出站、入站、域名/IP、端口 |
| secret | 哪些变量、文件、token 可见 |
| resources | CPU、内存、磁盘、进程数、时间 |
| devices | 是否可访问 Docker socket、GPU、USB |
| persistence | 环境何时销毁、如何恢复 |
| identity | 以谁的身份访问外部服务 |

只声明“运行在 Sandbox 中”而不说明这些维度，无法比较安全边界。

## 6. Network 是独立的 Capability

网络能力应分层：

```text
no network
  → allowlist read-only destinations
  → allow API requests
  → allow package/download traffic
  → allow arbitrary egress
  → allow inbound service exposure
```

即使任务只要求运行测试，依赖下载、Git、编译脚本和测试 fixture 也可能访问网络。网络 policy 需要明确是按进程、域名、端口、协议还是 Environment 统一控制。

Codex 对 network approval 有独立机制；Gemini CLI 的 shell/policy 层也将工具策略与执行分开。[^codex-network-approval] [^gemini-policy] [^gemini-shell]

### 6.1 Egress 风险

出站网络可能泄露：

- 源代码；
- 环境变量；
- SSH/Git credentials；
- 测试数据；
- Provider request；
- 用户路径和系统信息。

Prompt Injection 常见目标就是诱导 Agent 执行 `curl`、上传文件或将 Secret 拼进 URL。

### 6.2 Ingress 风险

开放入站端口可能使：

- 本地开发服务被外部访问；
- Sandbox 暴露 debug endpoint；
- 子进程被远程控制；
- 临时 token 被扫描。

允许启动服务不等于允许公开服务。Workspace/Environment policy 应区分 loopback、内部网络和公网。

### 6.3 Package 和 Git 网络

包管理器、Git remote、submodule 和构建脚本都可能产生网络动作。若任务只允许读取代码，不应因为运行测试而自动授予任意出站网络。

## 7. Secret 隔离模型

### 7.1 Secret 不应进入模型 Context

工具可以在 Runtime/Environment 内部使用 Secret，而只返回脱敏结果：

```text
Model: “调用部署工具”
Runtime: 使用绑定 credential
Environment: 请求远程服务
Model: 只看到 status/resource id
```

这比把 token 写入 prompt、命令参数或环境变量后让 shell 自由继承更安全。

### 7.2 Secret 注入位置

Secret 可能出现在：

- provider authentication；
- tool process environment；
- mounted file；
- credential helper；
- remote service identity；
- Git config；
- cloud SDK 默认凭证。

每个注入位置都需要定义可见进程、生命周期、日志脱敏和子进程继承规则。

### 7.3 Secret 输出路径

即使模型没有直接读取 Secret，工具也可能将其输出到：

- stdout/stderr；
- exception message；
- generated file；
- trace/span；
- provider request；
- UI log；
- child Agent observation。

脱敏不能只做字符串替换。URL 编码、base64、分片输出和错误堆栈都可能绕过简单过滤。

## 8. Environment Variables 的特殊风险

环境变量同时承载配置、凭证和运行时元数据。Shell 工具可能读取所有变量并将其传递给子进程。

更安全的做法是：

- 默认使用最小环境变量集合；
- Secret 通过专用句柄或短期 credential 注入；
- 对命令输出做脱敏；
- 禁止模型直接请求环境变量 dump；
- 子 Agent 不继承不必要的变量；
- 记录使用了哪类 credential，而不是保存 Secret 内容。

## 9. Process 与后台服务

Agent 执行 `npm run dev`、测试 watcher 或部署命令后，后台进程可能继续运行。Sandbox 退出不一定终止脱离的子进程，容器重启也可能留下远程服务。

后台任务需要：

- operation identity；
- process group；
- owner/lease；
- cancellation semantics；
- port/resource scope；
- cleanup policy；
- final observation。

如果用户取消 Turn，正确状态可能是 `cancel_requested` 而不是 `cancelled`，直到进程和远程服务状态被确认。

## 10. Environment Identity 与恢复

恢复后不能只使用原来的 `cwd`：

```text
Environment reference = {
  workspace_id,
  snapshot/commit,
  sandbox_id,
  service endpoints,
  credential binding,
  lease/version
}
```

如果 sandbox 已销毁，Runtime 需要重新 provision 或进入 `waiting_environment`；如果工作树被用户修改，旧 Context 和验收 evidence 可能 stale；如果远程服务仍在运行，恢复器需要查询 ownership 和资源 identity。

## 11. Tool 与 Environment 的双重防线

Tool 层负责参数和能力语义，Environment 层负责硬限制：

```text
Tool policy: 允许写 /repo/src
Environment: 实际只挂载 /repo/src 的写权限
```

即使 Tool policy 出错，Environment 仍应阻止访问 `/home/user/.ssh`。反过来，Environment 允许访问某路径，也不代表当前 Tool Call 经过了授权。

mini-SWE-agent 的 Environment protocol 将动作执行抽象为独立层；OpenCode 的 Workspace provider 负责资源相关逻辑；Codex 的 StepContext 将环境选择绑定到请求。[^mini-environment] [^opencode-workspace] [^codex-step]

## 12. 各 Agent 的 Environment 安全取舍

### 12.1 Codex

Codex 将 permission profile、network approval、StepContext、ToolRouter 和 Environment 条件结合，形成较明确的本地执行策略。[^codex-permissions] [^codex-network-approval] [^codex-step]

它更强调产品级权限体验和逐调用控制；复杂点在于 shell、网络、子进程、后台任务和用户目录之间的组合语义。

### 12.2 Pi

Pi 的 Environment 层负责 Node/shell 执行、输出捕获和资源处理；工具 preparation/execution hook 提供策略插入点。[^pi-env] [^pi-prepare] [^pi-execute]

底层库提供灵活性，但 Sandbox、Secret 注入、网络隔离和 Workspace rollback 主要需要应用层配置。

### 12.3 OpenCode

OpenCode 将 Workspace provider、工具责任、Session execution 和 claim 分开。[^opencode-workspace] [^opencode-tools] [^opencode-execution]

它适合服务化和多运行者场景，但具体安全边界取决于 Workspace driver 和部署资源，不能只从 Session 层判断。

### 12.4 OpenHands

OpenHands 将 agent-server、sandbox、workspace、service URL 和 session context 分离，天然面对远程 Environment 的生命周期和多服务身份。[^openhands-adapter]

安全重点是 sandbox provision、workspace scope、远程服务认证、artifact 传输和资源销毁。

### 12.5 Kimi Code

Kimi Code 的 permission gate、tool policy、task persistence、tool dedupe 和 subagent context 为执行边界提供结构。[^kimi-permission] [^kimi-policy] [^kimi-task] [^kimi-subagent]

实际文件、网络和 Secret 隔离仍取决于底层 Environment 和工具实现。

### 12.6 Gemini CLI

Gemini CLI 的 policy engine、shell policy 和 SessionContext 将动态上下文、策略和 shell 执行分层。[^gemini-policy] [^gemini-shell] [^gemini-types]

它可以在 CLI 侧做细粒度策略判断，但本地用户目录、环境变量和网络的硬边界仍需执行环境配合。

### 12.7 mini-SWE-agent

mini-SWE-agent 的 LocalEnvironment 主要负责 cwd、subprocess 和 command output；它提供清晰的执行抽象，但默认不构成完整 Sandbox/Secret/Network 安全系统。[^mini-local] [^mini-environment]

## 13. Security Invariants

```text
cwd is not filesystem isolation
workspace rollback is not effect rollback
network access is an independent capability
secret use does not require secret visibility to the model
child processes inherit only explicit capabilities
cancel request is not confirmed cancellation
environment reference includes identity, not only path
tool policy and environment restriction must both hold
remote resources require separate ownership and lifetime
```

## 14. 验证方案

### 14.1 Workspace escape

尝试通过 `..`、绝对路径、symlink、Git hook、子进程和构建脚本访问 scope 外资源，验证 Tool 和 Environment 是否同时阻止。

### 14.2 Network egress

让测试命令访问允许、未允许和动态重定向的域名，验证 DNS、IP、代理和子进程是否绕过 policy。

### 14.3 Secret leakage

注入标记 Secret，分别测试环境变量、文件、stdout、stderr、trace、Context、UI、child Agent 和 provider request 的泄露路径。

### 14.4 Background process

启动 watcher、daemon 和远程任务后取消父 Turn，验证进程组、租约、端口和远程资源是否最终收敛。

### 14.5 Snapshot/restore

在文件 effect、进程启动、网络请求和远程资源创建后分别恢复 Workspace，验证哪些状态被回滚、哪些仍然存在、哪些进入 unknown。

本文未在所有 Agent 上统一执行 Environment 隔离实验。源码可证明 Environment、Workspace、policy 和 tool 的责任位置；真实 Sandbox 强隔离、宿主机权限、网络和 Secret 生命周期需要部署级测试。

## 设计原则

### 原则一：最小 Environment

只提供任务需要的文件、进程、网络、Secret 和资源能力，并限制其生命周期。

### 原则二：Tool policy 与硬隔离双重约束

工具层做语义授权，Environment 层做不可绕过的资源限制，任何一层失误都不应直接导致越界副作用。

### 原则三：Secret 不随模型传播

模型只获得完成任务所需的 capability 和结果摘要，Secret 通过受控工具或短期凭证使用。

### 原则四：外部资源独立管理

网络、进程、远程服务和后台任务拥有自己的 identity、owner、lease、取消和终态，不能被 cwd 或 Session history 代替。

### 原则五：恢复重新验证 Environment

恢复时重新确认 workspace、sandbox、进程、网络和凭证绑定；旧 Context 和旧批准不能自动代表当前环境。

## 未确认事项

- 各项目 Sandbox 的真实内核/容器隔离配置，不能由 Agent 源码静态确认。
- OpenHands、Codex 和 OpenCode 的远程/本地 Environment 是否支持完整 effect 查询，需要运行验证。
- Secret 脱敏和 provider telemetry 的实际覆盖范围需要部署与网络层测试。
- 用户工作树、Git hook、子模块和包管理器造成的隐式副作用仍需更细的实验矩阵。

下一篇将研究 Plugin、MCP、Skill 和动态工具的安全边界：扩展如何获得能力，工具 schema 如何进入 Context，以及扩展如何影响权限、恢复和供应链安全。

## 参考源码

[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-network-approval]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^gemini-types]: [Gemini CLI SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/types.ts#L187-L245)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
