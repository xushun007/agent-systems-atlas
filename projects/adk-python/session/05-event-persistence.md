# Event 持久化

## 存储格式

Event 以完整 JSON 字符串存入 `events.event_data` 列：

```python
event_data = event.model_dump_json(exclude_none=True)
```

**选择 `exclude_none=True` 的原因：**
- 压缩存储空间（大部分 Optional 字段在非 LLM 事件中为 None）
- 例如用户事件：`{"id":"...", "author":"user", "invocation_id":"...", "content":{...}, "timestamp":...}` — 没有 `grounding_metadata`、`usage_metadata` 等 LLM 字段

## 反序列化

```python
Event.model_validate_json(event_data)
```

**注意：** 查询时 `ORDER BY timestamp DESC` 取最新，返回前 `reversed()` 恢复时间顺序。

## Partial 事件 — 不持久化

```python
async def append_event(self, session, event):
    if event.partial:
        return event        # 直接返回不存储
```

流式输出中的 partial（未完成）事件只 pass-through 给调用者，不写入 session。只有 `turn_complete` 的完整事件才持久化。

## Stale Session 检测

```python
# 读取存储的 update_time
async with db.execute(
    "SELECT update_time FROM sessions WHERE app_name=? AND user_id=? AND id=?",
    (session.app_name, session.user_id, session.id),
) as cursor:
    row = await cursor.fetchone()
    storage_update_time = row["update_time"]

# 检测过期
if storage_update_time > session.last_update_time:
    raise ValueError(
        "The last_update_time provided in the session object is"
        " earlier than the update_time in storage."
        " Please check if it is a stale session."
    )
```

**为什么需要：** 并发情况下，session 对象可能已过期（另一个请求先写入了更新），此时继续 append 会导致数据不一致。

## Event 写入事务

```python
async with self._get_db_connection() as db:
    # 1. 检查 stale session
    # 2. 处理 state_delta (app/user/session)
    # 3. INSERT INTO events
    # 4. UPDATE sessions SET update_time (如果没有 session state delta)

    await db.commit()  # 原子提交
```

整个事务在一个 `aiosqlite` 连接上下文内完成：失败自动回滚，成功 commit。

## 时间戳更新策略

```
有 session state delta？
  ├─ 是 → _update_session_state_in_db() 中已更新 session.update_time
  └─ 否 → 额外执行 UPDATE sessions SET update_time = event.timestamp
```

**设计原因：** `_update_session_state_in_db` 使用 `json_patch` 已携带 `update_time` 更新，如果无 state delta 则不会自动更新 session 时间戳，需手动 UPDATE。

## 事件 ID

```python
event.id  →  由应用层（event 创建时）通过 platform_uuid 生成
```

不是数据库自增 ID，原因：
- 分布式场景中跨节点唯一
- 迁移/复制时不依赖 DB 序列
- 恢复场景中事件 ID 不变

## 内存同步

```python
# super().append_event() — BaseSessionService 的默认实现
async def append_event(self, session, event):
    if event.partial:
        return event
    self._apply_temp_state(session, event)      # temp → 内存
    event = self._trim_temp_delta_state(event)   # 剔除 temp
    self._update_session_state(session, event)   # 持久 state → 内存
    session.events.append(event)                 # 事件追加到列表
    return event
```

`SqliteSessionService.append_event()` 在持久化到 DB 后也调用 `super().append_event()`，确保内存中的 `Session` 对象同步更新——这样同一次 invocation 内后续 agent 可以立即读到新事件和状态。
