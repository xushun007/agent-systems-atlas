# 事件生命周期

## 事件流全景

```
User Message
    │
    ▼
Runner.run_async()
    │
    ├─ _append_user_event()                    → yield (可选)
    │
    ├─ NodeRunner.run()                        → 后台 asyncio.Task
    │   │
    │   ├─ _create_child_context()             → child Context
    │   ├─ _execute_node()                     → 迭代 node.run()
    │   │   ├─ _track_event_in_context()       → 写入 ctx (output/route/interrupt_ids)
    │   │   ├─ _enrich_event()                 → 打上 metadata
    │   │   ├─ _flush_deltas()                 → 合并 pending state/artifact deltas
    │   │   └─ ic.enqueue_event(e, signal)     → 放入 _event_queue
    │   │
    │   └─ _flush_output_and_deltas()          → 发送 ctx.output Event
    │
    ├─ ic._event_queue.put((done_sentinel, None))  → 完成信号
    │
    ├─ _consume_event_queue()                  → 消费循环
    │   │
    │   ├─ ic._event_queue.get()
    │   ├─ 清除 message_as_output 重复
    │   ├─ run_on_event_callback()             → 插件修改
    │   ├─ _get_output_event()                 → 合并后的事件
    │   ├─ session_service.append_event()      → 持久化
    │   └─ yield event                         → 流式返回
    │
    ├─ _cleanup_root_task()
    ├─ run_after_run_callback()
    └─ _run_compaction_for_sliding_window()
```

## `_consume_event_queue()` — 事件消费循环

```python
async def _consume_event_queue(ic, done_sentinel):
    while True:
        event_or_done, processed_signal = await ic._event_queue.get()
        if event_or_done is done_sentinel:
            break                                    # 根节点执行完毕

        event = event_or_done

        # 特殊处理：message_as_output 时清除 event.output
        if not event.partial:
            if event.node_info.message_as_output and event.content:
                event = event.model_copy()
                event.output = None                  # 避免重复

        # 1. 应用 run_config 的 custom_metadata
        _apply_run_config_custom_metadata(event, ic.run_config)

        # 2. 插件 on_event 回调
        modified_event = await ic.plugin_manager.run_on_event_callback(...)

        # 3. 获取最终事件（合并插件修改）
        output_event = self._get_output_event(
            original_event=event,
            modified_event=modified_event,
            run_config=ic.run_config,
        )

        # 4. 持久化（非 partial 事件）
        if not event.partial:
            await self.session_service.append_event(session=ic.session, event=output_event)

        # 5. 流式返回给调用者
        yield output_event

        # 6. 通知 NodeRunner 事件已处理
        if isinstance(processed_signal, asyncio.Event):
            processed_signal.set()
```

## `_get_output_event()` — 插件事件合并

```
original_event ────────────────┐
                               ├──→ output_event
modified_event (from plugin) ──┘
```

合并策略：
1. 如果 `modified_event is None` → 返回 `original_event`
2. 遍历 `modified_event` 的所有 set 字段
3. 跳过 `id`、`invocation_id`、`timestamp`（不可覆盖）
4. 其他字段覆盖到 `original_event.model_copy(update={...})`
5. 如果 author 为空，保留原始 author

## `_append_user_event()` — 用户消息持久化

```
new_message (types.Content)
    │
    ├─ 创建 Event(author='user', content=...)
    ├─ _find_active_task_isolation_scope() → 如果有活跃 task，打上 isolation_scope
    ├─ _apply_run_config_custom_metadata()
    └─ session_service.append_event()     → 持久化
```

### `_find_active_task_isolation_scope()` — 任务隔离范围

遍历 session 事件（逆序），找到活跃的 task agent 的 isolation scope：

**两种 scope：**
1. **FC delegation:** `fc.id` — chat coordinator 通过 function call 委托 task agent
2. **Workflow node:** `<node_name>@<run_id>` — workflow 模式下的 task agent

**关闭条件：** 成功的 `finish_task` FunctionResponse（result == FINISH_TASK_SUCCESS_RESULT）。失败的 FR 不关闭 scope，task agent 仍在等待。

## `_exec_with_plugin()` — 插件包装执行（旧路径）

```
run_before_run_callback()
    │
    ├─ 返回 Content? → early exit, yield 作为 model 事件
    │
    └─ 返回 None → 正常执行
        └─ execute_fn(invocation_context)
            └─ for event in agen:
                ├─ _apply_run_config_custom_metadata()
                ├─ run_on_event_callback()
                ├─ _get_output_event()
                ├─ session_service.append_event()
                └─ yield output_event

run_after_run_callback()
```

## `_cleanup_root_task()` — 任务清理

```python
async def _cleanup_root_task(task, node_name):
    if not task.done():
        task.cancel()                           # 调用者提前停止迭代
    try:
        await task
    except asyncio.CancelledError:
        pass                                    # 正常取消
    except Exception:
        raise                                   # 异常传播
```

---

## `_isolation_scope` 机制

**目的：** 让 task sub-agent 只能看到属于自己的事件，实现多 agent 之间的上下文隔离。

**工作方式：**
- Chat coordinator 的事件 scope 为 None（全局可见）
- Task sub-agent 的事件 scope 为 `<fc_id>` 或 `<node_name>@<run_id>`
- Content builder 构建 LLM 上下文时，按 `isolation_scope` 过滤事件
- 用户发 FunctionResponse 时，新用户消息被标记为对应 task 的 scope
