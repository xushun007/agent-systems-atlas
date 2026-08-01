# Runner 架构概述

## 三层职责分离

```
Runner (生命周期编排)          → InvocationContext 创建、session 管理、plugin 回调
  └── NodeRunner (任务调度)    → 驱动 node.run()、事件 enrich/persist、返回 ctx
       └── Workflow (图引擎)   → 边遍历、节点排序、条件路由
```

**为何分离：** 如果 Runner 和 NodeRunner 合并，嵌套 workflow 会导致死锁（内层 workflow 的 NodeRunner 会阻塞外层的 Runner）。

## 核心概念

| 概念 | 类 | 职责 |
|------|------|------|
| 调用上下文 | `InvocationContext` | 单次调用级单例，持有 session、服务、事件队列 |
| 节点上下文 | `Context` | 每个节点执行独有，1:1 映射，存储 output/route/interrupt_ids |
| 事件队列 | `ic._event_queue = asyncio.Queue()` | 跨线程/协程通信，NodeRunner 写入，Runner 消费 |
| 完成信号 | `done_sentinel = object()` | 唯一标记，表示根节点执行完毕 |

## 两种执行路径

```
run_async()
  │
  ├── LlmAgent (mode='chat') ──→ _run_node_async()    [新路径 - node runtime]
  ├── BaseNode (非 BaseAgent)  ──→ _run_node_async()    [新路径 - node runtime]
  └── 旧 BaseAgent            ──→ _exec_with_plugin()  [旧路径 - 兼容]
       ├─ _setup_context_for_new_invocation()
       └─ ctx.agent.run_async(ctx)
```

新路径（node runtime）是 ADK 2.0 的推荐方式，支持 Workflow、BaseNode、DynamicNodeScheduler。
