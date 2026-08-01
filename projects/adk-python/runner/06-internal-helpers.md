# Runner 内部辅助函数详解

## `_find_active_task_isolation_scope(session)`

**功能：** 从 session 事件历史中找到当前活跃（未完成）的 task agent 的 isolation scope。

**算法：**
```
逆序遍历 session.events:
    跳过 scope 为空的事件
    如果是 finish_task 的 FR 且 result == FINISH_TASK_SUCCESS_RESULT:
        → 记录 finished_scopes.add(scope)
    如果 scope 不在 finished_scopes 中:
        → 返回 scope  # 找到了活跃的 scope
返回 None
```

**用途：** 在 `_append_user_event` 中为新的用户消息打上正确 scope，确保 task agent 在下一个 turn 能看到这条消息。

---

## `_get_function_responses_from_content(content)`

提取 Content 中所有的 FunctionResponse Part。

---

## `_apply_run_config_custom_metadata(event, run_config)`

将 `run_config.custom_metadata` 合并到 event 上（event 的 metadata 优先）。

---

## `_extract_resume_inputs(message)`

从 FunctionResponse 消息中提取恢复输入：
```python
{ fr_id: fr_response, ... }
```

---

## `_validate_new_message(message, resume_inputs)`

验证：消息不能同时包含 FR 和文本 Part。**FR 恢复已有 invocation，文本则开始新 invocation。**

---

## `_resolve_invocation_id_from_fr(session, new_message)`

从 FR 消息中推断 invocation_id：
1. 提取所有 FR 的 id
2. 在 session events 中逆序查找匹配的 FC
3. 收集所有匹配到 FC 的 invocation_id
4. 如果匹配到多个不同 invocation → raise ValueError
5. 返回唯一的 invocation_id

---

## `_find_original_user_content(session, invocation_id)`

找到一个 invocation 的原始用户文本消息。用于恢复场景：FR 不是用户消息，需要回头找到最初触发 invocation 的文本。

---

## `_get_output_event(original_event, modified_event, run_config)`

合并插件修改到原始事件上：

```
遍历 modified_event.model_fields_set:
    跳过 id / invocation_id / timestamp（不允许覆盖）
    其他字段覆盖到 original_event.model_copy(update=...)
如果 author 为空，保留原始 author
```

**目的：** 确保流给调用者的事件和持久化到 session 的事件一致。

---

## `_is_transferable_across_agent_tree(agent_to_run)`

检查 agent 能否 transfer 到 agent tree 中的任何其他 agent。
条件：从当前 agent 向上遍历所有祖先，都没有 `disallow_transfer_to_parent`。

---

## `_should_append_event(event, is_live_call)`

判断事件是否应该持久化到 session：
- 在 live mode 中，inline_data 的音频事件不持久化（太大了）
- 但 file_data 引用的事件会持久化

---

## `_collect_toolset(agent)`

递归收集 agent 及所有 sub_agents 中的所有 BaseToolset 实例。

---

## `_cleanup_toolsets(toolsets_to_close)`

清理工具集：
- 对每个 toolset 调用 `toolset.close()`（带 10 秒超时）
- 处理 `CancelledError`（Python 3.10/3.11 的 anyio CancelScope 跨 task 问题）
- 错误不阻断其他 toolset 的清理

---

## `_compute_state_delta_for_rewind(session, rewind_event_index)`

计算回退所需的状态 delta：
1. 遍历 rewind 点之前所有事件，重建 `state_at_rewind_point`（跳过 `app:` 和 `user:` 前缀的 key）
2. 对比当前 state，计算需恢复的 key/value
3. 当前 state 中有但 rewind 点没有的 key → 设为 None（删除）

---

## `_compute_artifact_delta_for_rewind(session, rewind_event_index)`

计算回退所需的文件版本 delta：
1. 遍历 rewind 点之前所有事件，记录各文件的版本号
2. 对比当前版本号，对变化的文件递增版本号
3. 恢复旧版本数据（通过 artifact_service 加载），保存为新版本
4. 如果旧版本不存在 → 保存空 blob
