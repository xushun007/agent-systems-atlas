---
title: Coding Agent 扩展的进程边界与 Environment 权限
series: Coding Agent 的 Extension / Plugin Architecture
part: 3
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-comparison
verification:
  source_reading: true
  tests_read: true
  runtime_experiment: false
---

# Coding Agent 扩展的进程边界与 Environment 权限

## 结论

扩展的真实权限，不由它在模型请求中暴露了几个 Tool 决定，而由它最终运行在哪个进程、继承了哪些资源、以什么身份访问外部系统决定。

同一个 `search` Tool，可以分别运行在：

```text
Agent 主进程
  → 本地 Plugin 子进程
  → MCP Server 进程
  → 容器中的 Worker
  → 远程 Connector
  → 子 Agent 持有的独立 Runtime
```

这些形态对 Workspace、Network、Secret、进程控制、失败恢复和审计的含义完全不同。把它们统一称为“Tool 扩展”，会隐藏最关键的责任迁移：

```text
模型提出调用
  → Host 选择 provider
  → Connector 建立进程/网络边界
  → Environment 绑定资源和身份
  → Policy 决定是否允许
  → Extension 执行外部动作
  → Host 接收并标记结果
```

本文的核心判断是：

> Extension 的能力边界必须绑定到 Environment identity，而不是只绑定到 Tool name、Session 或 Plugin package。

如果同一个扩展可以在不同 workspace、不同用户身份、不同网络和不同凭证下运行，那么它们实际上是不同的执行能力，不能共用一个无版本的全局信任判断。

## 1. 从 Tool 调用到进程执行

### 1.1 模型只生成意图

模型输出通常只能表达：

```text
provider/tool/name/arguments
```

它不应该决定：

- 使用哪个操作系统用户；
- 连接哪个 socket；
- 挂载哪个 workspace；
- 继承哪些环境变量；
- 使用哪一个云端身份；
- 是否允许访问公网；
- 子进程如何清理。

这些选择属于 Host Runtime 和 Environment。模型可以提出“调用 GitHub 的创建 PR 能力”，但不能通过参数决定将宿主机的 `~/.ssh` 挂载给 MCP Server。

### 1.2 Provider、Connector、Environment 的区分

三个概念经常被混用：

| 概念 | 负责的问题 |
| --- | --- |
| Provider | 谁提供模型或外部能力 |
| Connector | Host 如何连接该能力 |
| Environment | 能力在哪些资源和身份中运行 |

例如：

```text
GitHub MCP Server       = provider
stdio / HTTP client     = connector
workspace + token scope = environment
```

Connector 能建立连接，但不应天然拥有全部 Host 权限；Environment 决定连接之后实际可见的文件、网络和凭证。

### 1.3 调用上下文必须向下传递

一个完整的 ExtensionCallContext 至少需要包含：

```text
session_id
turn_id
step_id
extension_id
extension_version
capability_id
policy_snapshot
approval_snapshot
workspace_id
environment_id
credential_binding
network_policy
deadline
cancellation_token
```

如果只传 `arguments`，扩展无法安全地参与恢复、审计和取消；如果把全部 Host 对象直接传入扩展，又会造成权限不可控和隐式状态共享。

## 2. 四种进程边界

### 2.1 In-process Plugin

Plugin 与 Agent Runtime 运行在同一个进程：

```text
Agent Host
 ├─ Agent loop
 ├─ Policy
 ├─ Plugin code
 └─ Tool handlers
```

优点：

- 调用延迟低；
- 可以直接访问 Host API；
- 状态共享简单；
- Tool 注册和 Event 监听方便。

代价：

- Plugin 可以访问进程内对象；
- 内存隔离不存在；
- Plugin 崩溃可能影响整个 Agent；
- Secret、Session 和用户配置容易被读取；
- 很难限制 Plugin 访问宿主文件系统和网络。

In-process Plugin 的“权限声明”如果没有操作系统或专用 Runtime 支持，通常只是自律约定，不能视为硬隔离。

### 2.2 Local child process

Plugin 或 MCP Server 运行在本地子进程：

```text
Agent Host ──stdio / pipe── Extension Process
```

进程边界提高了故障隔离能力，但默认继承仍可能包括：

- 当前用户身份；
- 当前工作目录；
- 大量环境变量；
- 网络访问；
- 父进程可见文件；
- 信号和进程组控制。

所以“独立进程”不等于“独立权限”。Host 需要显式构造命令、cwd、env、stdio、uid/gid、resource limit 和 process group。

### 2.3 Container / Sandbox process

扩展运行在容器或其他 Sandbox：

```text
Agent Host
  → Sandbox manager
      → container / restricted process
          → Extension
```

此时边界从进程控制扩大到：

- filesystem mount；
- user namespace；
- capabilities；
- network namespace；
- DNS 和 proxy；
- device access；
- CPU、内存、磁盘和进程数；
- 生命周期和销毁。

容器若挂载宿主 workspace、Docker socket、SSH agent 或云凭证，隔离可能再次被削弱。Sandbox 的安全性必须从配置和运行时行为验证，不能只依据“使用了容器”这一名称。

### 2.4 Remote Connector

扩展运行在远程服务：

```text
Agent Host ──authenticated protocol── Remote Extension Service
```

此时 Host 不再直接控制执行环境，必须依赖远程服务提供：

- service identity；
- tenant/workspace scope；
- credential binding；
- operation identity；
- cancellation；
- artifact transfer；
- retention and deletion；
- audit record。

远程 Connector 的最大风险不是“网络不稳定”，而是本地 Session 对远程副作用缺少事实性控制：连接断开后，远程任务可能仍在运行，本地恢复器却只看到一个 timeout。

## 3. Workspace 权限如何传播

### 3.1 cwd 只能表达位置

把 Plugin 或 MCP Server 的 cwd 设置为 `/repo`，并不能自动保证它只能访问 `/repo`。它可能通过：

- 绝对路径；
- `..`；
- symlink；
- Git submodule；
- 工具缓存；
- 环境变量；
- 父进程可见挂载；
- 子进程或外部服务；

访问 scope 外资源。

OpenCode 将 Workspace provider 与 Session execution 分开；OpenHands 的 context payload 也把 workspace、sandbox 和 service 信息分开表达。这类结构说明 workspace identity 不是简单的 cwd 字符串。[^opencode-workspace] [^opencode-execution] [^openhands-adapter]

### 3.2 Workspace capability 的四个层次

扩展对 workspace 的权限至少应拆成：

```text
discover   知道哪些资源存在
read       读取内容和元数据
write      修改内容
execute    通过脚本/构建/Hook 执行内容
```

再加上：

```text
delete
share
export
```

一个扩展即使没有 `write`，只要拥有 `read + export`，仍可能泄露源代码和 Secret。一个扩展即使只能写入 workspace，也可能通过写 CI 配置、Git hook 或启动脚本影响后续系统。

### 3.3 Parent 与 child workspace

子 Agent、MCP Server 和后台 Worker 可能出现三种关系：

1. 共享同一个 workspace；
2. 使用父 workspace 的 snapshot；
3. 使用独立 workspace，通过 patch 或 artifact 回传。

三种关系对并发和恢复完全不同：

| 关系 | 优点 | 主要风险 |
| --- | --- | --- |
| 共享 | 延迟低、结果立即可见 | 并发写冲突、权限扩大、难以回滚 |
| snapshot | 隔离清晰、可审查 | 合并冲突、快照成本、结果延迟 |
| 独立 workspace | 边界最清晰 | artifact/patch 传输和身份管理复杂 |

父 Agent 不能只传一个 `cwd` 给子 Agent，然后假设它自动继承正确的 workspace 语义。需要传递 workspace identity、版本、可写范围和回传协议。

## 4. Network 权限的传播

### 4.1 Connector 不应自动继承 Host 网络

一个 MCP Server 或 Plugin 可能只需要访问某个 API，但如果它继承宿主网络，就可能访问：

- 本地 metadata service；
- 内网控制面；
- 用户局域网；
- 任意公网目标；
- 代理和 DNS 服务。

Host 应将 Network policy 作为 Environment 绑定的一部分，而不是依赖扩展自行遵守。

### 4.2 出站能力至少分五种

```text
none
  → fixed domain/API allowlist
  → package/Git access
  → arbitrary outbound
  → inbound service exposure
```

MCP Server 需要访问远程 API，不表示它需要任意出站；开发服务器需要监听 loopback，不表示它应该暴露公网；包管理器需要下载依赖，不表示构建脚本可以访问所有目标。

Codex 对 network approval 采用独立控制；Gemini CLI 将 Policy Engine 与 shell execution 分层。[^codex-network] [^gemini-policy] [^gemini-shell]

### 4.3 网络身份不等于用户身份

一个远程 Connector 可能使用：

- 用户 OAuth token；
- Agent service account；
- workspace service identity；
- Plugin 自带 API key；
- 临时 delegation token。

这些身份需要分别记录。不能因为请求由用户启动，就把远程副作用都标记为“用户本人执行”；也不能因为使用 Agent service account，就认为用户已经批准所有范围。

## 5. Secret 如何进入扩展进程

### 5.1 Secret 的四种注入方式

```text
环境变量
挂载文件
标准输入/专用句柄
远程身份绑定
```

风险从低到高不只取决于形式，而取决于扩展进程能否枚举、复制、输出和传给子进程。

环境变量尤其容易被 shell、debug log、错误堆栈和子进程继承。挂载文件需要限制路径、权限和生命周期。专用句柄需要避免被序列化到 Tool Result。远程身份绑定则需要服务端确认 scope 和租约。

### 5.2 Secret visibility 与 capability use 分离

理想路径是：

```text
Model requests “create issue”
  → Host authorizes capability
  → Connector uses bound credential
  → Remote service returns issue id
  → Model sees result, not token
```

如果必须让扩展使用 Secret，也不应让模型通过 shell 读取它。扩展只需要“使用凭证完成动作”的能力，不需要“读取凭证内容”的能力。

### 5.3 子 Agent 的 Secret 继承

子 Agent 是否继承父 Agent 的 Secret，是能力传播中最危险的默认值之一。应区分：

```text
inherit none
inherit named capability
inherit short-lived token
inherit full environment
```

继承完整环境变量通常是最容易实现、也是最难审计的方案。Kimi Code 的 Subagent context 与 Task persistence 提供了分析能力传播的状态入口，但实际 Secret 继承仍需结合部署和运行测试确认。[^kimi-subagent] [^kimi-task]

## 6. Process 与资源生命周期

### 6.1 扩展失败不是只有返回错误

扩展可能在不同阶段失败：

```text
spawn failure
initialize failure
registration failure
authorization failure
execution failure
transport failure
timeout
crash after side effect
```

最后一种尤其重要：远程或本地副作用已经发生，但 Host 没有收到结果。此时不能简单重试，否则可能重复创建资源。

### 6.2 Operation identity

每个有副作用的扩展调用都应拥有 operation identity：

```text
operation_id
extension_id
environment_id
request_id
idempotency_key
owner
created_at
status
```

`request_id` 标识一次模型请求，`operation_id` 标识一次实际副作用，二者不能混为一谈。一次模型请求可能重试，不能因此创建多个同义远程操作。

### 6.3 取消的真实语义

取消 Host Turn 只代表停止继续生成或停止等待，不代表扩展动作已经撤销。至少需要区分：

```text
cancel_requested
connector_stopping
operation_cancel_sent
cancel_confirmed
cancel_failed
state_unknown
```

远程 API 没有取消接口时，Runtime 只能记录 `state_unknown`，不能把本地 UI 状态写成已取消。

### 6.4 进程组和后台任务

本地 Plugin 可能启动 watcher、编译器、浏览器或服务进程。Host 必须明确：

- 子进程是否加入独立 process group；
- 父进程退出是否杀死整个 group；
- 端口由谁拥有；
- 日志和 stdout 如何收集；
- 取消时是否等待清理；
- Session 恢复后是否重新发现这些进程。

只保存一个 PID 不足以表达后台任务身份。PID 可能复用，子进程可能脱离父进程，服务可能已经转移到远程环境。

## 7. 子 Agent 是能力边界还是上下文复制

### 7.1 三种委派模型

#### 共享 Host

子 Agent 只是父 Agent Loop 的另一个调用者，共享 Tool Registry 和 Environment。

优点是简单；缺点是子 Agent 很容易获得父 Agent 的全部权限，且调用难以独立审计。

#### 能力子集

父 Agent 根据任务创建子集：

```text
child_capabilities ⊆ parent_effective_capabilities
```

这是更可控的模型，但需要显式声明子集、Environment 和结果回传。

#### 独立 Runtime

子 Agent 拥有独立 Session、Tool Registry、Environment 和持久化，通过 artifact 或事件与父 Agent 通信。

隔离最好，但协调、恢复和成本归因最复杂。

### 7.2 上下文复制不等于权限继承

将父 Agent 的消息、Tool schema 或 Skill 复制给子 Agent，只能复制信息，不应自动复制：

- 用户审批；
- Secret；
- Network allowlist；
- Workspace write scope；
- 远程连接；
- 后台 operation ownership。

Kimi Code 的 subagent mirror/fork metadata 提供了研究“上下文如何传播”的入口；真正安全的设计还需要额外的能力子集和重新授权语义。[^kimi-subagent]

### 7.3 子 Agent 结果的信任等级

子 Agent 输出应默认视为外部运行结果，而不是新的系统指令。父 Agent 可以使用其事实和建议，但不应因为子 Agent 的消息中包含“已批准”就自动继承批准状态。

## 8. 各 Agent 的边界取舍

### 8.1 Codex：Host 控制执行条件

Codex 的 StepContext、权限 profile 和 network approval 将执行条件放入 Runtime，而不是让 Tool handler 自行决定。[^codex-step] [^codex-permissions] [^codex-network]

这适合产品级本地执行和逐步审批。扩展接入时，必须回答如何映射到 Step、Policy 和 Environment；优点是边界统一，代价是 Connector 不能绕过既有执行模型。

### 8.2 Pi：宿主应用决定隔离强度

Pi 的 Node Environment、Tool preparation 和 execution hook 提供了执行和插入点，但不替宿主完成完整的 Sandbox、Network 和 Secret 隔离。[^pi-env] [^pi-prepare] [^pi-execute]

它适合作为可组合 Agent Loop，但应用开发者需要承担扩展进程、凭证、后台任务和恢复责任。Pi 的灵活性正是它没有强制统一 Environment 的结果。

### 8.3 OpenCode：Workspace 与 Worker 边界成为关键

OpenCode 将 Workspace provider、Session execution 和 Tool 责任分开。[^opencode-workspace] [^opencode-execution] [^opencode-tools]

因此 Plugin 或 Connector 的最终权限取决于被哪个 Worker claim、绑定哪个 Workspace driver，以及执行服务怎样配置。扩展层不能独立决定自己的隔离边界。

### 8.4 OpenHands：远程 Runtime 是一等 Environment

OpenHands 的 agent-server、sandbox、workspace 和服务上下文使远程 Environment 成为核心执行边界。[^openhands-adapter]

扩展分析需要同时追踪本地 Agent、远程 sandbox、服务 URL、artifact 和 session identity。单看 Agent 层 Tool 注册会低估真实资源和身份传播。

### 8.5 Gemini CLI：本地 Shell 是扩展边界的现实落点

Gemini CLI 的 Policy Engine 与 shell 执行分层，但如果扩展最终通过本地 shell 运行，其真实权限仍由进程环境、用户目录、环境变量和网络决定。[^gemini-policy] [^gemini-shell]

因此，Prompt 或 MCP 层的“允许调用”不能代替操作系统层的限制。

### 8.6 Kimi Code：任务和子 Agent 是传播边界

Kimi Code 的 permission gate、tool policy、Task persistence 和 subagent context 让权限传播与任务分叉相互关联。[^kimi-permission] [^kimi-policy] [^kimi-task] [^kimi-subagent]

重点不是是否支持子 Agent，而是分叉时是否生成新的能力、Environment 和批准边界。

### 8.7 mini-SWE-agent：执行边界简单但不强

mini-SWE-agent 的 LocalEnvironment 直接管理 cwd、subprocess 和 command output，边界清晰但默认隔离能力有限。[^mini-local] [^mini-environment]

它显示了一个最小实现的真实含义：Environment 是执行接口，不自动等于 Sandbox、租约管理器或 Secret Broker。

## 9. Environment Binding 应保存什么

扩展执行不能只记录 `cwd` 和 `command`。建议至少记录：

```text
EnvironmentBinding {
  environment_id
  workspace_id
  workspace_revision
  filesystem_scope
  process_identity
  network_policy
  credential_binding
  extension_process_id
  service_endpoint
  lease_id
  resource_limits
  created_at
  expires_at
}
```

### 9.1 为什么 revision 重要

同一个 workspace path 在不同时间可能指向不同内容。Tool Call 读取或修改文件时，应能知道它针对哪个 revision、snapshot 或 claim。

### 9.2 为什么 credential binding 重要

同一个远程 endpoint 可以使用不同身份。恢复时如果只重连 endpoint，可能错误地用当前用户凭证重放旧操作。

### 9.3 为什么 lease 重要

容器、MCP 进程、临时 token 和远程服务都可能有租期。Session 恢复时需要确认租约仍有效，过期则重新 provision 或进入等待状态，而不是假设原 Environment 仍存在。

## 10. 验证方案

### 10.1 进程继承实验

让同一扩展分别以 in-process、local child process、container 和 remote connector 运行，记录：

- uid/gid；
- cwd；
- 可见环境变量；
- 可读写路径；
- 可见进程；
- 网络目标；
- Secret 入口；
- 子进程继承规则。

### 10.2 Workspace escape 实验

在扩展中测试绝对路径、`..`、symlink、Git hook、submodule、构建脚本和子进程，确认 Tool policy 与 Environment hard boundary 是否同时生效。

### 10.3 Secret propagation 实验

注入标记 Secret，检查它是否出现在：

- Plugin 环境变量；
- MCP Server 文件系统；
- 子进程；
- stdout/stderr；
- Tool Result；
- Trace/日志；
- 子 Agent Context；
- Provider request。

### 10.4 Remote disconnect 实验

在远程操作已发出但结果未返回时断开 Connector，随后恢复 Session。验证 Runtime 是否能查询 operation 状态、避免重复执行，并正确标记 `unknown`。

### 10.5 Child Agent capability 实验

给父 Agent 文件写权限、网络权限和一个 Secret capability，委派子 Agent 分别执行读、写、网络和凭证操作，观察它获得的是完整继承、能力子集还是重新审批。

### 10.6 Cancellation 实验

让扩展启动 watcher、长时间构建和远程任务，在不同阶段取消 Turn，检查进程组、端口、远程 operation、租约和 Session 状态是否最终收敛。

## 设计原则

### 原则一：扩展权限绑定 Environment identity

Tool name 和 Plugin package 不能代表完整权限；workspace、进程、网络、凭证和租约必须共同确定一次执行能力。

### 原则二：进程隔离与权限隔离分开验证

子进程、容器和远程服务可以改善故障边界，但只有显式的 filesystem、network、secret 和 identity 限制才能形成权限边界。

### 原则三：上下文传播不自动传播授权

父 Agent 的消息、Tool schema 和 Skill 可以作为信息传递，但审批、Secret、Workspace 写权限和远程 operation ownership 必须重新定义。

### 原则四：副作用拥有独立身份和终态

Extension operation 不能依赖一个 Tool Call 或 Turn 的结束来表示完成；它需要自己的 identity、取消、查询、租约和恢复语义。

### 原则五：恢复先重建 Environment，再恢复执行

恢复时应重新确认 workspace、进程、连接、凭证和租约，不能仅凭历史 cwd 或历史消息继续执行。

## 未确认事项

- 各 Agent 的 Plugin/MCP 子进程是否清理完整进程组，需要运行时检查；
- 各远程 Connector 的 operation identity、幂等和取消能力，公开客户端源码通常无法完全确认；
- 各 Agent 的子 Agent 是否真正缩减 Secret、Network 和 Workspace 权限，需要部署级实验；
- 容器、宿主机挂载、代理和云凭证的实际隔离效果不能由 Agent 层源码单独证明；
- OpenHands、OpenCode 和 Codex 的 Environment 租约及后台资源收敛，需要结合服务端运行实验。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^pi-prepare]: [Pi tool call preparation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L607-L676)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)
[^opencode-tools]: [OpenCode tool responsibility boundary](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/tool/AGENTS.md#L20-L55)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^openhands-adapter]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^kimi-permission]: [Kimi permission gate](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L1-L90)
[^kimi-policy]: [Kimi tool policy evaluation](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts#L1-L75)
[^kimi-task]: [Kimi persisted task states](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/task/persist.ts#L190-L270)
[^kimi-subagent]: [Kimi subagent context and fork metadata](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/session/subagent/mirrorAgentRun.ts#L70-L180)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
