# API 设计：6 个核心方法

## 1. `create_session()` — 创建新会话

```
create_session(app_name, user_id, state=None, session_id=None) → Session
```

**流程：**
```
1. session_id 为空 → 生成 UUID
2. extract_state_delta(state) → app/user/session 三份 delta
3. 检查 session 是否已存在 → AlreadyExistsError
4. 原子操作:
   ├─ _upsert_app_state()    ← INSERT ON CONFLICT DO UPDATE SET state=json_patch(...)
   ├─ _upsert_user_state()   ← 同上
   ├─ 读取合并后的 app_state + user_state (json_patch 后的最新值)
   └─ INSERT INTO sessions(...)
5. _merge_state() → 返回 Session(state=merged)
```

**设计要点：**
- `session_id` 由 client 提供或自动生成，不是自增 int
- app_state 和 user_state 使用 `json_patch` 原地更新，而非全量替换
- 返回前重新读取 state，确保 client 拿到已合并的最新值

## 2. `get_session()` — 获取会话及事件

```
get_session(app_name, user_id, session_id, config=None) → Session | None
```

**流程：**
```
1. SELECT state, update_time FROM sessions WHERE (app, user, id)
   → 无记录返回 None
2. 构建 events 查询:
   WHERE (app, user, session_id)
   + AND timestamp >= after_timestamp   (可选)
   + ORDER BY timestamp DESC            (最新在前)
   + LIMIT num_recent_events            (可选)
3. num_recent_events == 0 → 跳过事件查询 (仅要 state)
4. 反序列化: Event.model_validate_json(event_data)
5. 读取 app_state + user_state
6. _merge_state()
7. 返回 Session
```

**`GetSessionConfig` 过滤：**

| 参数 | 效果 |
|------|------|
| `num_recent_events = None` | 不限制，返回全部 |
| `num_recent_events = N > 0` | 返回最近 N 条 |
| `num_recent_events = 0` | 不返回事件 |
| `after_timestamp = T` | 返回 timestamp >= T 的事件 |

## 3. `list_sessions()` — 列出会话

```
list_sessions(app_name, user_id=None) → ListSessionsResponse
```

**流程：**
```
1. 查询 sessions 表:
   - user_id 提供 → WHERE app_name=? AND user_id=?
   - user_id 为 None → WHERE app_name=?
2. 读取 app_state (一次)
3. 读取 user_states (逐 user 或按目标 user)
4. 逐 session 做 _merge_state()
5. 返回 ListSessionsResponse(sessions=[...])
   - 注意: events 字段为空列表 (不含事件)
```

**成本优化：** 批量操作只查一次 app_state / user_states，不在每个 session 内重复查询。

## 4. `delete_session()` — 删除会话及事件

```
delete_session(app_name, user_id, session_id)
```

```python
DELETE FROM sessions WHERE app_name=? AND user_id=? AND id=?
```

**外键级联：** `events` 表的 `ON DELETE CASCADE` 自动清除关联事件，无需单独 DELETE。

## 5. `get_user_state()` — 独立读取用户状态

```
get_user_state(app_name, user_id) → dict[str, Any]
```

与 `get_session()` 不同，此方法直接查 `user_states` 表而不需要 `session_id`。

```python
SELECT state FROM user_states WHERE app_name=? AND user_id=?
→ json.loads(row["state"]) if row else {}
```

**使用场景：** 新 session 创建前需要了解用户偏好（如语言、名称），但又不想为了取 state 而 `list_sessions`。

## 6. `append_event()` — 追加事件（核心写入路径）

```
append_event(session: Session, event: Event) → Event
```

### 完整流程

```
1. partial 事件 → 直接返回，不持久化

2. _apply_temp_state()           ← 将 temp: 前缀的 key 注入 session.state (内存)
   例: event.actions.state_delta = {"temp:draft": "hello"}
       → session.state["temp:draft"] = "hello"  (仅内存)

3. _trim_temp_delta_state()      ← 剔除 temp: 前缀 key，防止持久化
   例: 修剪后 state_delta 为空 {}

4. 获取 DB 连接:
   ├─ SELECT update_time FROM sessions → 检查 session 是否过期
   │   storage_update_time > session.last_update_time → raise ValueError
   │
   ├─ 处理 state_delta (如果有):
   │   ├─ extract_state_delta() → app/user/session 三份
   │   ├─ _upsert_app_state()      ← json_patch
   │   ├─ _upsert_user_state()     ← json_patch
   │   ├─ _update_session_state_in_db() ← json_patch
   │   └─ 标记 has_session_state_delta
   │
   ├─ INSERT INTO events (id, app, user, session, invocation, timestamp, event_data)
   │   event_data = event.model_dump_json(exclude_none=True)
   │
   ├─ 如果无 session state delta → UPDATE sessions SET update_time=?
   │   (有 session state delta 时 update_time 已在 _update_session_state_in_db 中更新)
   │
   ├─ commit()
   └─ session.last_update_time = event.timestamp

5. super().append_event()  ← 同步内存 Session
   ├─ _apply_temp_state() (再次应用，因为 client 可能已经拿到了修剪后 event)
   ├─ _trim_temp_delta_state()
   ├─ _update_session_state() → session.state.update(delta)
   └─ session.events.append(event)

6. 返回 event
```

### Stale Session 检测

```python
storage_update_time > session.last_update_time
→ ValueError("stale session")
```

这防止了竞态：如果 session 被并发请求更早更新（update_time 比当前 client 持有的更新），当前请求被拒绝。

### 原子性保证

- 整个 `append_event` 在一个 SQLite 事务中完成（aiosqlite `async with` 自动开启/提交）
- `json_patch` 的 INSERT ON CONFLICT DO UPDATE 是原子操作
- 如果中途失败，整个事务回滚（不 commit）
