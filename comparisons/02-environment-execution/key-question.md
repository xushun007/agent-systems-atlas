---
title: Coding Agent 的 Environment：关键问题
topic: environment-execution
reviewed_at: 2026-09-18
status: active
document_type: key-questions
---

# Coding Agent 的 Environment：关键问题

本专题只讨论四个问题。核心不是 Environment 的定义，而是不同 Coding Agent 如何把执行世界变成可控制、可观察、可恢复的 Runtime 边界。

## Q1：Environment 为什么不等于 cwd？

### A：cwd 只是位置，Environment 是动作发生的完整执行世界

一次工具执行至少依赖：

~~~text
Workspace state
+ Process state
+ Network policy
+ Secret / identity
+ Resource limits
+ External operation
+ Observation / evidence
~~~

cwd 无法说明绝对路径、symlink、子进程、环境变量、网络和远程资源。

### 经典设计对比

- Codex：将 Environment 选择和 capability roots 放入 StepContext，并与权限和网络策略共同决定执行条件。[^codex-step] [^codex-permissions]
- OpenCode：将 Session location、Workspace、SessionExecution 和 Worker claim 分开；目录是定位信息，执行所有权由更高层 Runtime 管理。[^opencode-session] [^opencode-execution]
- mini-SWE-agent：把 Environment 明确定义为可替换执行协议，保持核心 Loop 简单，但不自动提供完整的 workspace identity 和恢复能力。[^mini-environment]

### 判断

如果 Runtime 只能回答“命令在哪个目录执行”，而不能回答“哪个身份、哪个进程、哪些资源和哪些约束参与执行”，它只有 cwd 抽象，没有完整 Environment。

## Q2：Environment 的边界由谁强制？

### A：Tool 提出动作，Policy 决定是否允许，Environment 负责不可绕过的执行约束

可靠链路应当是：

~~~text
Model / Tool intent
  → Policy / Approval
  → Environment binding
  → Process / Sandbox / Remote execution
  → Observation
~~~

Tool schema 不是权限，Prompt 中的说明也不是 Sandbox。真正的边界必须落在执行器、容器、网络、凭证和资源管理上。

### 经典设计对比

- Codex：Permission profile、Network approval 和 StepContext 形成产品级的执行条件；模型可见能力和实际可执行能力分离。[^codex-permissions] [^codex-network]
- Gemini CLI：Policy Engine 与 Shell execution 分层，策略允许不等于进程已经完成，更不等于文件和远程资源达到目标状态。[^gemini-policy] [^gemini-shell]
- Pi：Node Environment 负责 cwd、shell、输出、超时和 child process；更强 Sandbox、Secret 和 Network 约束主要由宿主应用承担。[^pi-env]

### 判断

好的 Environment 设计至少有两道边界：Tool/Policy 的语义授权，以及 Environment 的硬约束。只有第一道，扩展或模型错误就可能越界；只有第二道，用户无法理解和控制能力。

## Q3：Environment 如何处理后台进程、远程资源和取消？

### A：Tool Call 结束不等于 Environment 已经收敛

命令返回后，后台服务、watcher、远程任务和网络请求可能仍然存在。因此需要独立记录：

~~~text
process / operation identity
+ owner / lease
+ cancellation state
+ final observation
+ cleanup result
~~~

取消也必须区分请求和确认：

~~~text
cancel_requested
  → stopping
  → cancel_confirmed / cancel_failed / unknown
~~~

### 经典设计对比

- OpenHands：Sandbox、Workspace、Agent Server 和远程服务分离；销毁 Sandbox 不自动撤销已经创建的远程资源。[^openhands-context]
- OpenCode：SessionExecution claim 处理当前 Worker 的执行所有权和接管；恢复不能只重建消息，还要处理未释放执行。[^opencode-execution]
- Pi：底层 Environment 跟踪 child PID 并尝试终止进程树；这解决本地进程取消，但不自动解决跨进程或远程 Operation。[^pi-env]

### 判断

Environment 只有在能回答“取消后哪些资源已经停止、哪些仍在运行、哪些状态未知”时，才具备完整的生命周期语义。

## Q4：Environment 如何恢复，Workspace rollback 能恢复什么？

### A：恢复 Environment 需要重新验证身份和外部事实，rollback 只能覆盖它拥有的状态

恢复至少要确认：

~~~text
workspace identity / revision
+ sandbox / process identity
+ credential binding
+ network policy
+ remote operation status
+ lease / ownership
~~~

文件 rollback 不能撤销已经发送的请求、创建的云资源、发布的包或仍在运行的进程。

### 经典设计对比

- Codex：Step 绑定 Environment 条件，恢复时应重新确认当前 Step 是否仍能使用原条件，而不是只恢复 transcript。[^codex-step]
- OpenCode：执行 claim 和 Session history 支持 Worker 接管，但 Workspace 和执行实例仍需重新解析。[^opencode-execution] [^opencode-workspace]
- OpenHands：远程 Runtime 的 workspace、sandbox 和 service URL 必须分别恢复；文件状态与服务状态不能合并。[^openhands-context]
- mini-SWE-agent：trajectory 和 Environment output 适合分析，但不等于 workspace checkpoint 或 effect rollback。[^mini-environment] [^mini-local]

### 判断

可靠恢复不是“重新设置 cwd”，而是重新建立 Environment binding，并对账进程、文件和外部 Operation 的当前状态。

## 四个关键判断

1. Environment 是执行世界，不是目录字符串；
2. Tool、Policy 和 Environment 必须形成分层控制；
3. 后台进程和远程 Operation 必须拥有独立身份；
4. 恢复必须重新验证 Environment，rollback 不等于 effect rollback。

## 参考源码

[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^codex-permissions]: [Codex permission profiles](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/permissions.rs#L200-L230)
[^codex-network]: [Codex network approval ownership](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/network_approval.rs#L595-L725)
[^opencode-session]: [OpenCode v2 Session service](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/session.ts#L1-L180)
[^opencode-execution]: [OpenCode durable execution claim](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L59-L90)
[^opencode-workspace]: [OpenCode Workspace provider](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/workspace/driver.ts#L20-L65)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
[^openhands-context]: [OpenHands agent-server context and workspace payload](https://github.com/All-Hands-AI/OpenHands/blob/ab23be62ad724fe83483036a0900bed7b7859166/src/api/agent-server-adapter.ts#L220-L310)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-SWE-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^mini-local]: [mini-SWE-agent local Environment](https://github.com/SWE-agent/mini-SWE-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/environments/local.py#L13-L80)
