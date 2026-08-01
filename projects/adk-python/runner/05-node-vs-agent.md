# Node 路径 vs 旧 Agent 路径

## 对比总览

| 维度 | 旧路径 (BaseAgent) | 新路径 (BaseNode/NodeRunner) |
|------|-------------------|------|
| 执行入口 | `ctx.agent.run_async(ctx)` | `NodeRunner(node).run()` |
| 事件持久化 | `_exec_with_plugin` 内部 | `_consume_event_queue` |
| 子节点调度 | agent 自行管理 sub_agents | `DynamicNodeScheduler` / `ctx.run_node()` |
| 上下文模型 | InvocationContext 单例 | Context 树 (1:1 node mapping) |
| 输出路由 | agent 内部逻辑 | `ctx.output` / `ctx.route` / `ctx.interrupt_ids` |
| 图编排 | 无原生支持 | `Workflow` (图引擎) |
| 恢复 | `_setup_context_for_resumed_invocation` | NodeRunner `resume_inputs` + `prior_output` |

## `_run_node_async()` — 新路径入口

`run_async()` 中三条路径的前两条都通向这里：

### 当 agent 有 sub_agents 时启用 DynamicNodeScheduler

```python
is_agent = isinstance(self.agent, BaseAgent)
has_sub_agents = is_agent and bool(self.agent.sub_agents)
use_scheduler = is_agent and has_sub_agents

if use_scheduler:
    # Chat coordinator + task sub-agents 模式
    scheduler = DynamicNodeScheduler(state=_LoopState())
    root_ctx._workflow_scheduler = scheduler
    ctx = await scheduler(root_ctx, root_agent, node_input, run_id='1')
else:
    # 简单节点模式
    root_node_runner = NodeRunner(node=root_agent, parent_ctx=root_ctx)
    ctx = await root_node_runner.run(node_input=node_input, resume_inputs=resume_inputs)
```

### DynamicNodeScheduler 的作用

处理 chat coordinator 通过 `ctx.run_node()` 委托给 task sub-agent 的场景：
1. Coordinator 调用 `ctx.run_node(task_agent, input)` → 创建动态节点
2. Scheduler 在 session 中有对应事件时恢复，否则执行
3. Task agent 执行完毕，通知 scheduler
4. Scheduler 唤醒 coordinator 继续执行

## `_find_agent_to_run()` — Agent 路由

```python
def _find_agent_to_run(session, root_agent) -> BaseAgent:
    # 1. Workflow → 返回自身（内部自行路由）
    if isinstance(root_agent, Workflow):
        return root_agent

    # 2. 最后一个事件是 FR → 找到对应的 agent
    event = find_matching_function_call(session.events)
    if event and event.author and is_resumable:
        if agent := root_agent.find_agent(event.author):
            return agent

    # 3. 逆序扫描事件，找最近活跃的可 transfer agent
    for event in reversed(session.events):
        if event.author == root_agent.name:
            return root_agent
        if agent := root_agent.find_sub_agent(event.author):
            if _is_transferable_across_agent_tree(agent):
                return agent

    return root_agent  # fallback
```

## `_find_agent_to_run()` 选择逻辑

**优先级：**
1. **Workflow** → 直接返回（Workflow 有内部中断恢复机制）
2. **FunctionResponse 匹配** → 找到发出对应 FC 的 agent（需 is_resumable）
3. **Root agent 事件** → 返回 root
4. **最近活跃的可 transfer sub-agent** → 返回该 agent
5. **Fallback** → root agent

## 恢复逻辑对比

### 旧路径恢复

```
_setup_context_for_resumed_invocation():
    1. _find_user_message_for_invocation() → 找回原始用户消息
    2. _new_invocation_context()           → 创建 IC (复用 invocation_id)
    3. _handle_new_message()               → 处理 FR
    4. populate_invocation_agent_states()  → 填充 agent 状态
    5. _find_agent_to_run()                → 确定要继续的 agent
```

### 新路径恢复 (NodeRunner)

```
NodeRunner.run(node_input, resume_inputs):
    _create_child_context(resume_inputs):
        ├─ prior_output = session 中的上次 output
        ├─ prior_interrupt_ids = 未解决的 interrupt IDs
        └─ resume_inputs = FR 的 response 数据
    _execute_node():
        → node._run_impl(ctx, node_input)
        → 用户代码通过 ctx.resume_inputs 获取 FR 响应

关键：如果 node.rerun_on_resume=True，_run_impl 会重新执行
```

---

## `isolation_scope` 与 task agent

当 chat coordinator 有 task-mode sub-agent 时：

```
run_async():
    # 如果有 task sub-agent，不使用 _find_agent_to_run
    # 因为 coordinator 通过 ctx.run_node() 处理委托
    if has_task_subagent:
        agent_to_run = self.agent            # coordinator 自己
    else:
        agent_to_run = self._find_agent_to_run(session, self.agent)
```

**Root coordinator 的 isolation_scope 始终为 None**，这样 content builder 的 scope filter 能让 coordinator 看到所有事件。Task sub-agent 的事件被 scope filter 过滤，对 coordinator 不可见。
