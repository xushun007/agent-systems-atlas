# Codex Runtime：Session / Turn / Step、Environment 与工具能力平面

> 研究笔记，2026-09-14
>
> 分析版本：`rust-v0.154.0`
>
> 上游提交：[`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`](https://github.com/openai/codex/commit/6b9826e3aa83b1a5947db50f4332cb9c65f1b340)

这份笔记集中提炼三个问题：

1. Session、Turn、Step 如何共同处理持续的用户输入；
2. Environment 如何取代单纯的本地 `cwd`；
3. 动态工具如何从注册表演进为策略化能力平面，以及它与 prompt/KV cache 的关系。

## 一、核心结论

Codex 的 runtime 可以概括为：

```text
Thread（持久化历史）
  └── Session（运行时实例）
        └── Turn（一次用户工作单元）
              ├── Step 1：模型采样
              ├── Step 2：工具执行
              ├── Step 3：工具结果进入下一次采样
              └── Step 4：最终响应
```

真正保证执行一致性的不是 Turn，而是 Step：Turn 中可变的设置在每个 Step 开始前被捕获成不可变快照。快照包含模型、权限、Environment、MCP binding、工具计划、AGENTS/world state 等请求范围状态。

因此 Codex 能够在一个持续运行的 Turn 中处理审批、中断、模型变更和环境变更，同时不修改已经发出的模型请求或正在执行的工具步骤。

## 二、Session、Turn、Step 的边界

### 2.1 四个层次

| 层级 | 作用 | 生命周期 | 主要可变性 |
| --- | --- | --- | --- |
| Thread | 持久化对话、工具结果、Turn 边界和恢复/fork 历史 | 可跨进程恢复 | 以追加为主，可 compaction、fork |
| Session | 输入队列、事件流、当前任务及共享 runtime services | 一次运行时连接或进程生命周期 | 高度可变 |
| Turn | 一次用户意图对应的工作单元 | 从接收输入到完成、中断或失败 | 当前设置和控制状态可变 |
| Step | 一次模型请求及其对应执行上下文 | 单次模型请求范围 | 捕获后基本不可变 |

相关实现：

- [`Session::spawn`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L491-L565)
- [`run_turn`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L149-L285)
- [`StepContext`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs#L15-L35)
- [`StepSettings`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_settings.rs#L21-L68)

### 2.2 Step 快照解决的竞态

如果整个 Turn 直接共享一份可变配置，下面的操作会产生歧义：

```text
模型请求已经发出
用户同时修改模型、cwd、权限或 MCP
工具执行应该使用修改前还是修改后的上下文？
```

Codex 的解决方式是：

```text
Turn.current_settings（可变）
Environment / MCP / world state
              │
              ▼
      capture_step_context()
              │
              ▼
StepContext / ResolvedStepSettings（不可变）
```

`capture_step_context()` 在异步规划前捕获一次动态状态。当前请求的消费者继续使用这个版本，即使 Turn 后续被更新。后续变化只影响未来 Step。

### 2.3 用户操作的归属

| 用户操作 | 运行时归属 | 对当前 Step 的影响 | 对后续 Step 的影响 |
| --- | --- | --- | --- |
| 普通 user input | Session 接收，通常启动 Turn | 不修改已发请求 | 成为当前或下一 Turn 的输入 |
| steer / 持续输入 | Session 控制事件，可能并入活动 Turn | 不修改已捕获快照 | 影响后续采样 |
| 权限审批 | 当前 Turn 的 pending tool call | 唤醒/继续挂起调用，不重写旧 Step | 可形成 session-scoped approval cache |
| `acceptForSession` | Session 范围的审批缓存 | 不修改历史 Step | 在匹配上下文中减少未来审批 |
| interrupt | Session/Turn 控制事件 | 取消当前 Step | 持久化中断边界，后续输入开始新工作 |
| 模型变更 | Thread/Turn settings override | 当前 Step 保持旧模型 | 后续 Step 使用新模型 |
| 增加可信 workspace | Environment/permission 配置 | 当前 Step 保持旧 Environment snapshot | 后续 Step 使用新 root 和权限 |
| MCP/plugin refresh | Session runtime services 与未来 tool plan | 当前快照不自动改变 | 后续 Step 可能获得不同工具集 |

审批不是一个新的普通 Turn，而是当前 Turn 内工具调用的控制状态：

```text
Turn → Step → Tool call → Pending approval → Approval response → Continue
```

中断也不是把当前 Step 改成新配置，而是终止当前执行并记录 `TurnAborted` 或等价的中断边界。相关恢复/fork 逻辑见 [`thread_manager.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/thread_manager.rs#L2251-L2352)。

### 2.4 可变性与不可变性

不可变或追加式事实：

- Thread、Turn、Step 的 identity 和 lineage；
- 已提交的用户输入；
- 已完成的工具调用和工具结果；
- 已经发出的模型请求；
- 已结束 Step 的设置和执行上下文。

可变控制状态：

- Session 输入队列和活动任务；
- Turn 的 `current_settings`；
- pending approval、cancellation 和 environment readiness；
- 后续 Step 的模型、权限、环境和工具计划；
- session-scoped approval cache 与部分 runtime service cache。

这里的关键不是“所有历史绝对不可变”，而是：**已提交的执行事实不被原地改写；变化通过新的控制事件、更新消息、追加历史或新快照表达。**

## 三、Environment：从 cwd 到执行所有权

### 3.1 Environment 的定义

Environment 不是当前进程的 `cwd`，而是：

> 一个拥有执行目标、位置、执行器、能力和安全策略的运行时实体。

它通常包括：

- identity：environment ID；
- location：`cwd`、workspace roots；
- executor：本地、远程或 managed worktree 执行器；
- platform：OS、home、shell 和平台能力；
- filesystem：可读、可写和禁止访问路径；
- network：网络访问策略；
- command policy：命令执行规则；
- runtime services：shell、MCP、workspace/worktree；
- lifecycle：启动、连接、ready、失败和恢复状态；
- configuration ownership：配置由 Thread 还是 Environment owner 管理。

因此：

```text
cwd 是 Environment 的一个坐标字段
Environment 是完整的执行边界
```

### 3.2 Environment 的选择和解析

运行时大致分为两步：

```text
TurnEnvironmentSelection
  ├── environment_id
  ├── cwd
  ├── workspace_roots
  └── config ownership
          │
          ▼
Environment resolution
  ├── executor connection
  ├── shell
  ├── platform
  ├── home directory
  ├── sandbox / permissions
  └── readiness
          │
          ▼
TurnEnvironmentSnapshot
```

`turn/start` 会把 cwd、workspace roots、environment selections、permission profile 和 sandbox policy 一起转换成 Environment override，而不是只修改进程当前目录：

[`turn_processor.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/request_processors/turn_processor.rs#L580-L653)

`TurnEnvironmentSnapshot` 保留所有选中的环境，包括失败环境，并维持原始顺序：

[`TurnEnvironmentSnapshot`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/environment_selection.rs#L783-L790)

这说明 Environment 是可解析、可等待和可失败的对象，而不是一个静态路径字符串。

### 3.3 Thread-owned 与 Environment-owned 配置

Codex 区分两类配置来源：

- `Thread`：随 Thread 默认设置更新；
- `Owner`：由具体 Environment attachment 或 owner 管理。

这样可以避免 Thread 默认权限变化时，意外覆盖已经由远程执行器、managed worktree 或其它 Environment owner 管理的配置。

相关类型：[`EnvironmentConfigOrigin`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/environment_selection.rs#L40-L61)

## 四、工具：从注册表到能力平面

### 4.1 五个不同层次

“工具存在”与“模型可以调用工具”不是同一件事。当前 runtime 可以拆成：

```text
Tool implementation
      ↓
Tool registry
      ↓
Exposure / policy
      ↓
Model-visible tool spec
      ↓
Authorization + execution
```

含义分别是：

1. 实现：shell、patch、MCP、web search、extension、dynamic tool 等；
2. 注册：运行时知道有哪些能力；
3. Exposure：决定 direct、deferred、code mode 或 hidden；
4. Model-visible spec：当前 Step 的模型请求实际能看到什么；
5. 执行授权：调用时仍需经过 permission、sandbox、approval 和 Environment executor。

因此：

```text
注册存在 ≠ 当前可见
当前可见 ≠ 已授权
已授权 ≠ 可以脱离 Environment 执行
```

### 4.2 动态工具如何进入请求

Codex 的工具通常不是简单拼接到普通 prompt 文本里，而是作为 Responses API 请求的 `tools` 字段传入；同时，权限、Environment、AGENTS/world state 等上下文可能以 instructions 或消息形式进入模型上下文。

因此更准确的描述是：

> 动态工具会参与构造当前 Step 的完整模型请求，但不等于被拼成一段普通文本 prompt。

`build_tool_router()` 会综合：

- core tools；
- MCP tools；
- extension tools；
- dynamic tools；
- hosted model tools；
- 当前 model；
- Environment；
- Tool Search；
- Code Mode；
- MCP exposure 配置。

相关实现：

- [`build_tool_router`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L125-L180)
- [`apply_mcp_tool_exposure_policy`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L180-L265)
- [`build_model_visible_specs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs#L531-L573)

### 4.3 Deferred tools 与 Tool Search

并非所有注册工具都会进入每个请求。大量或低频工具可以作为 deferred tool：

```text
初始模型请求
  ├── 核心工具
  └── Tool Search
          │
          ▼
模型需要额外能力
  └── 搜索工具目录
          │
          ▼
后续请求使用匹配工具
```

这同时降低了：

- 初始请求大小；
- 工具选择空间；
- schema 对上下文的占用；
- 不常用工具对 prompt cache 稳定性的影响。

## 五、动态工具与 prompt/KV cache

### 5.1 Codex 明确控制的部分

Codex 为 Responses 请求设置稳定的 `prompt_cache_key`。普通 Session 通常使用 session ID；内部 session 可以使用 parent thread 作用域：

[`ModelClient::prompt_cache_key`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/client.rs#L504-L518)

测试还验证了：即使改变模型、权限、Environment 或其它 per-turn settings，cache key 仍保持不变，旧请求的稳定前缀仍可以作为后一个请求的前缀：

[`prompt_caching.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/tests/suite/prompt_caching.rs#L438-L550)

其设计类似：

```text
稳定前缀
  ├── system/developer instructions
  ├── 历史上下文
  └── 稳定能力描述

变化后缀
  ├── 新 user input
  ├── permission update
  ├── model switch
  ├── environment update
  └── tool result
```

### 5.2 动态工具的影响

| 变化 | 对缓存的潜在影响 |
| --- | --- |
| 本地实现变化，工具名/schema 不变 | 请求输入可能不变，缓存仍可能复用 |
| 工具描述或参数 schema 变化 | 从工具定义变化处开始可能无法复用 |
| 工具加入、删除、namespace 变化 | `tools` 请求内容变化，可能破坏工具定义之后的前缀复用 |
| 工具从 direct 变成 deferred | 初始请求工具列表变化，但可能由 Tool Search 延迟恢复能力 |
| 新工具调用结果 | 通常增加对话后缀，不代表整个前缀都失效 |
| Environment/permission context 变化 | 可能增加新的上下文消息，并使审批缓存失效 |

需要特别区分：

- `prompt_cache_key` 是请求的逻辑作用域；
- stable prefix 是客户端请求内容的可复用前缀；
- KV cache 是模型服务端内部的实现细节。

Codex 源码能证明前两点，不能完全证明服务端 KV cache 的具体分段和命中算法。因此最准确的结论是：

> Codex 通过稳定 cache key、不可变 Step 上下文和追加式设置更新，尽量保持稳定前缀。动态工具、Environment 和权限变化会改变后续请求内容，可能缩短可复用 prefix；但实际 KV cache 命中率和边界由模型服务端决定。

## 六、统一的架构解释

三个变化实际上是同一个 runtime 演进过程：

```text
早期模型：
Session
  └── cwd
        └── tool registry
              └── model request

当前模型：
Thread
  └── Session
        └── Turn control plane
              └── Step immutable snapshot
                    ├── Environment snapshot
                    ├── Permission snapshot
                    ├── MCP binding
                    ├── Tool exposure plan
                    ├── World state
                    └── Model request / cache key
```

其核心能力是：

1. 用 Step 快照隔离可变控制面和正在执行的请求；
2. 用 Environment 表达完整的执行边界，而不是只传递 cwd；
3. 用 Tool Plan 将能力注册、模型可见性、延迟发现和执行授权拆开；
4. 用稳定前缀和增量更新支持恢复、审计、缓存和低延迟。

## 七、仍需进一步确认

- Responses 服务端对 `tools` 字段和消息前缀的精确 cache boundary；
- MCP/plugin refresh 发生在不同 Turn/Step 边界时的具体工具计划重建策略；
- 多 Environment 并行选择时，工具调用如何绑定到单一 Environment；
- compaction 后历史、tool schema 和 prompt cache key 的长期关系；
- Session approval cache 的完整 key 组成以及所有失效条件。

这份笔记只将源码阅读结论与解释分开记录；没有把 provider 内部 KV cache 行为误写成已验证事实。
