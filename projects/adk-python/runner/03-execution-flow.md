# 执行流程详解

## `run_async()` — 主入口（异步）

```python
async def run_async(
    self,
    user_id: str,             # 用户 ID
    session_id: str,          # 会话 ID
    invocation_id: str = None, # 传入则恢复中断的调用
    new_message: Content = None, # 新用户消息
    state_delta: dict = None,  # 状态变更
    run_config: RunConfig = None, # 运行配置
    yield_user_message: bool = False, # 是否在 agent 事件前先 yield 用户消息
) -> AsyncGenerator[Event, None]:
```

**三种执行路径：**

### 路径 1: LlmAgent (mode='chat') → `_run_node_async()`

```python
if isinstance(self.agent, LlmAgent):
    self.agent.mode = 'chat'                      # 强制 chat 模式
    agent_to_run = self._find_agent_to_run(...)   # 找到要运行的子 agent
    agent_to_run = build_node(agent_to_run)       # 包装为 node
    → _run_node_async(node=agent_to_run, ...)     # 走 node runtime
```

### 路径 2: BaseNode (非 BaseAgent) → `_run_node_async()`

```python
if isinstance(self.agent, BaseNode) and not isinstance(self.agent, BaseAgent):
    → _run_node_async(...)                   # 直接执行 node
```

### 路径 3: 旧 BaseAgent → `_exec_with_plugin()`

```python
# 走旧路径，逐步迁移到 node runtime
→ _setup_context_for_new_invocation()        # 设置 invocation context
    ├─ _new_invocation_context()             # 创建 IC
    ├─ _handle_new_message()                 # 处理用户消息
    └─ _find_agent_to_run()                  # 路由到子 agent
→ _exec_with_plugin()                        # 插件包装执行
    ├─ run_before_run_callback()            # 前置回调
    ├─ ctx.agent.run_async(ctx)             # agent 自执行
    ├─ run_on_event_callback()              # 每个事件回调
    └─ run_after_run_callback()             # 后置回调
→ _run_compaction_for_sliding_window()       # 事件压缩（可选）
```

---

## `_run_node_async()` — 节点执行流程（核心）

```python
async def _run_node_async(
    self,
    user_id, session_id,         # 会话标识
    invocation_id,               # 恢复用
    new_message,                 # 用户消息
    state_delta,                 # 状态变更
    run_config,
    yield_user_message,
    node,                        # 要运行的节点
):
```

**执行 4 步：**

### Step 1: Setup

```
_get_or_create_session()         → session
_extract_resume_inputs()         → 从 FR 中提取恢复输入
_resolve_invocation_id_from_fr() → 从 FR 推断 invocation_id
_new_invocation_context()        → InvocationContext(session, ...)
ic._event_queue = asyncio.Queue() → 事件队列
```

### Step 2: 用户消息处理

```
FR 恢复路径:
  _find_original_user_content()  → 找回原始用户消息作为 node_input

新消息路径:
  plugin_manager.run_on_user_message_callback() → 修改用户消息
  _append_user_event()           → 追加用户事件到 session
  yield_user_message → yield 用户事件

plugin_manager.run_before_run_callback() → 前置回调
```

### Step 3: 启动根节点（后台任务）

```python
root_ctx = Context(ic)                              # 创建根 Context（无 node_path）
root_agent = node or self.agent

# 判断是否需要 DynamicNodeScheduler
is_agent = isinstance(self.agent, BaseAgent)
has_sub_agents = is_agent and bool(self.agent.sub_agents)
use_scheduler = is_agent and has_sub_agents
# 有子 agent 时，scheduler 负责协调 coordinator ↔ task sub-agent 的委托

if not use_scheduler:
    root_node_runner = NodeRunner(node=root_agent, parent_ctx=root_ctx)

async def _drive_root_node():
    if use_scheduler:
        scheduler = DynamicNodeScheduler(state=_LoopState())
        ctx = await scheduler(root_ctx, root_agent, node_input, run_id='1')
    else:
        ctx = await root_node_runner.run(node_input, resume_inputs)
    ic._event_queue.put((done_sentinel, None))  # 信号完成

task = asyncio.create_task(_drive_root_node())  # 后台运行
```

### Step 4: 主循环 — 消费事件

```python
async with aclosing(self._consume_event_queue(ic, done_sentinel)) as agen:
    async for event in agen:
        yield event  # 流式返回给调用者
```

**Finally 清理：**
```
_cleanup_root_task()              → 取消未完成的任务
plugin_manager.run_after_run_callback()
_run_compaction_for_sliding_window() → 可选事件压缩
```

---

## `run()` — 同步包装器

```python
def run(self, user_id, session_id, new_message, ...):
    event_queue = queue.Queue()                 # 线程安全队列

    async def _invoke_run_async():
        async for event in self.run_async(...):
            event_queue.put(event)

    thread = create_thread(target=_asyncio_thread_main)
    thread.start()

    while True:
        event = event_queue.get()              # 阻塞等待
        if event is None: break
        yield event                            # 同步 yield 给调用者
```

**注意：** 同步接口仅用于本地测试，生产环境应使用 `run_async`。

---

## `run_live()` — 实时音频模式

支持实时音频的 execution path，与 `run_async` 并行：
- 使用 `LiveRequestQueue` 处理实时请求
- 对音频 blob 做特殊处理（不持久化 inline_data，仅存 file_data 引用）
- 支持 partial transcription 事件
- 通过 `_run_node_live()` 或 `_exec_with_plugin(is_live_call=True)` 执行

---

## `rewind_async()` — 会话回退

```
1. 找到目标 invocation_id 对应的事件索引
2. _compute_state_delta_for_rewind()   → 计算状态回退 delta
3. _compute_artifact_delta_for_rewind() → 计算文件版本回退 delta
4. 创建 EventActions(rewind_before_invocation_id=..., state_delta=..., artifact_delta=...)
5. 追加 rewind 事件到 session
```

---

## `run_debug()` — 调试助手

便捷方法，自动处理 boilerplate：
```python
runner = InMemoryRunner(agent=my_agent)
await runner.run_debug("What is 2+2?")
await runner.run_debug(["Hello!", "What's my name?"])
```
- 自动创建 session
- 打印事件（可控制 quiet/verbose）
- 返回所有事件列表
