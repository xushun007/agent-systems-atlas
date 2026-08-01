# Runner 模块深度解析

源码位置: `src/google/adk/runners.py` (2200 行)

## 目录

| 文件 | 内容 |
|------|------|
| [01-overview.md](01-overview.md) | 架构总览 — 三层职责分离、核心概念、两种执行路径 |
| [02-runner-class.md](02-runner-class.md) | Runner 类详解 — 字段、构造函数、入口归一化、InMemoryRunner |
| [03-execution-flow.md](03-execution-flow.md) | 执行流程 — run_async、_run_node_async、run、run_live、rewind_async、run_debug |
| [04-event-lifecycle.md](04-event-lifecycle.md) | 事件生命周期 — 从 NodeRunner 到 consumer 的完整链路 |
| [05-node-vs-agent.md](05-node-vs-agent.md) | 新旧路径对比 — BaseNode vs BaseAgent、路由、恢复 |
| [06-internal-helpers.md](06-internal-helpers.md) | 内部辅助函数 — isolation_scope、FR 推断、rewind、toolset 清理 |

## 核心调用链速查

```
用户消息 → Runner.run_async()
    → _get_or_create_session() → Session
    → _new_invocation_context() → InvocationContext
    → plugin.user_message_callback()
    → _append_user_event() → 持久化用户消息
    → NodeRunner(node=root_agent).run()
        → _create_child_context() → Context
        → node._run_impl(ctx, node_input) → yield Events
        → ic._event_queue.put(event)
    → _consume_event_queue() → 消费、插件回调、持久化、yield
    → _cleanup_root_task()
    → plugin.after_run_callback()
    → compaction (可选)
```

## 测试入口

```bash
# Runner + Node 测试
uv run pytest tests/unittests/runners/test_runner_node.py -v

# Runner 调试测试
uv run pytest tests/unittests/runners/test_runner_debug.py -v

# 恢复/中断测试
uv run pytest tests/unittests/runners/test_resume_invocation.py -v

# 回退测试
uv run pytest tests/unittests/runners/test_runner_rewind.py -v
```

## 调试断点建议

| 位置 | 行号 | 观察内容 |
|------|------|------|
| `runners.py:933` | `run_async()` 入口 | 三种路径分发 |
| `runners.py:455` | `_run_node_async()` 开头 | node runtime 开始 |
| `runners.py:541` | `_drive_root_node()` | scheduler vs node_runner 选择 |
| `runners.py:759` | `_consume_event_queue()` | 事件消费循环 |
| `runners.py:170` | `__init__()` | 构造函数入口 |
| `_node_runner.py:112` | `NodeRunner.run()` | 节点执行开始 |
