---
title: Coding Agent 的 Context Engineering：关键问题
topic: context-engineering
reviewed_at: 2026-09-18
status: active
document_type: key-questions
---

# Coding Agent 的 Context Engineering：关键问题

本专题只讨论四个问题。重点是 Context 如何被具体 Runtime 选择、组装、压缩和重新验证，而不是泛泛讨论 Prompt。

## Q1：Context 是什么，谁拥有它？

### A：Context 是一次 Model Request 的派生输入，不是 Session transcript

Context 通常由以下来源选择和组装：

~~~text
History
+ Runtime facts
+ Environment observations
+ Capability descriptions
+ Instruction layers
+ Model constraints
→ Model Request
~~~

Session 负责保存长期事实，Context Builder 决定本次请求让模型看到什么。

### 经典设计对比

- Codex：区分 parent model history、host-owned context facts、retained context、world state 和 prompt projection。[^codex-history] [^codex-step]
- Pi：底层 Agent 在 loop 中创建 system prompt、messages 和 tools 的 Context snapshot；持久化和复杂恢复由上层 harness 负责。[^pi-snapshot] [^pi-loop]
- Gemini CLI：Session transcript 与动态 instructions 分开，cwd、session ID 和运行时信息进入 SessionContext。[^gemini-session]

### 判断

如果系统只能把完整 transcript 直接发送给模型，没有独立的选择、裁剪和 Environment observation 处理，它有消息历史，但没有成熟的 Context Runtime。

## Q2：哪些内容进入当前请求，何时冻结？

### A：Context 必须在 Model Request 边界形成快照，Tool 执行前仍需重新验证外部事实

请求至少有三个时间点：

~~~text
选择历史与事实
  → 组装 Model Request
  → 执行 Tool / 观察 Environment
~~~

模型请求发出后，新的用户输入、Tool schema、权限和 Environment 变化不应无记录地修改该请求。下一次请求可以重新组装 Context，但必须知道哪些内容是新增、过期或被撤销的。

### 经典设计对比

- Codex：StepContext 将模型设置、MCP、ToolRouter、Environment 和项目指令绑定到请求级执行条件。[^codex-step]
- Pi：steer/follow-up 按 Agent Loop 的不同边界进入当前工具推进或下一次模型请求。[^pi-loop]
- Gemini CLI：动态 instructions 在请求阶段刷新，而不是把所有运行变化伪装成历史消息。[^gemini-session]

### 判断

核心问题不是“Prompt 是否动态”，而是 Runtime 能否回答：

1. 模型当时看到了什么；
2. 这些内容由谁提供；
3. 哪些内容已经过期；
4. Tool 执行前是否重新验证。

## Q3：Context 压缩后，什么必须保留？

### A：压缩可以改变模型可见表示，但不能丢失决定执行正确性的事实

必须优先保留：

- 用户不可违反的目标和约束；
- 当前 Workspace/Environment identity；
- 未完成的 Tool Call 和 Operation；
- 权限、审批和能力边界；
- 已确认的文件、测试和外部资源事实；
- 当前失败、重试和恢复状态。

可以压缩或外置：

- 重复的自然语言；
- 大段日志；
- 已被新事实取代的观察；
- 可重新读取的文件内容；
- 已完成且与当前决策无关的中间过程。

### 经典设计对比

- Codex：history version、retained context、world-state baseline 和 payload truncation 分层，压缩不是简单截断字符串。[^codex-history]
- Pi：底层 Agent 的 Context snapshot 较轻，应用层需要决定 compact、memory 和持久化边界。[^pi-snapshot]
- mini-SWE-agent：保持最小 trajectory，不提供复杂的 Context compaction；优点是可读，代价是长任务能力有限。[^mini-environment]

### 判断

压缩是否安全，不看 token 减少了多少，而看恢复后模型是否仍知道：

~~~text
要完成什么
当前在哪里
已经做了什么
还有什么未完成
哪些动作被允许
~~~

## Q4：Tool Result 和 Environment Observation 如何进入 Context？

### A：Tool Result 是观察，不是无条件事实；Context 必须保留来源、时效和可信度

Tool Result 进入下一次 Model Request 前，需要知道：

- 来自哪个 Tool、进程或远程服务；
- 发生在哪个 Environment；
- 是否被截断、脱敏或摘要；
- 是本地确认、外部报告还是模型解释；
- 是否可能已经过期；
- 是否包含新的指令或不可信内容。

### 经典设计对比

- Codex：工具输出有 payload truncation、历史 metadata 和 world-state 关联；工具输出不是脱离来源的字符串。[^codex-history]
- Pi：Tool execution 结果由 Agent Loop 回写消息，底层 Environment 负责 stdout/stderr；宿主应用需要补充文件和远程资源事实。[^pi-execute] [^pi-env]
- Gemini CLI：Shell 返回结果属于工具观察，Policy 结果和 Shell/Environment 结果必须分开。[^gemini-policy] [^gemini-shell]

### 判断

Context Builder 不能把所有 Tool Result 都提升为高优先级指令。它应当把外部内容作为带来源的观察，并在需要时重新查询 Environment。

## 四个关键判断

1. Context 是请求级派生视图，不是 transcript 别名；
2. Model Request 边界决定 Context 何时冻结；
3. 压缩可以改变表示，不能删除执行关键事实；
4. Tool Result 是带来源和时效的 Observation，不是天然真相。

## 参考源码

[^codex-history]: [Codex context manager history](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context_manager/history.rs#L1-L105)
[^codex-step]: [Codex StepContext](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L1-L35)
[^pi-snapshot]: [Pi Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L220-L280)
[^pi-loop]: [Pi Agent loop and input boundaries](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L420-L580)
[^gemini-session]: [Gemini CLI SDK Session and SessionContext](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/session.ts#L191-L300)
[^mini-environment]: [mini-SWE-agent Environment protocol](https://github.com/SWE-agent/mini-SWE-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/__init__.py#L55-L75)
[^pi-execute]: [Pi prepared tool execution](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L677-L776)
[^pi-env]: [Pi shell output capture and Environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts#L371-L550)
[^gemini-policy]: [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/core/src/policy/policy-engine.ts#L600-L825)
[^gemini-shell]: [Gemini CLI shell policy and execution](https://github.com/google-gemini/gemini-cli/blob/fb0d535af931b27c51e87e5e6ade72905b1e8390/packages/sdk/src/shell.ts#L20-L80)
