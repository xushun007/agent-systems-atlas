# Session 存储架构

## 核心模型

```
BaseSessionService (ABC)          ← 抽象契约
  ├── SqliteSessionService        ← 单文件 SQLite (aiosqlite + JSON)
  ├── InMemorySessionService      ← 纯内存 dict
  ├── DatabaseSessionService      ← 多引擎 SQLAlchemy (SQLite/PostgreSQL/Spanner...)
  └── VertexAiSessionService      ← GCP Vertex AI
```

## Session 就是对话容器

```python
class Session(BaseModel):
    id: str                      # 唯一标识
    app_name: str                # 属主 App
    user_id: str                 # 属主用户
    state: dict[str, Any]        # 会话级状态
    events: list[Event]          # 有序事件历史
    last_update_time: float      # 最后更新时间戳 (Unix 秒)
```

`Session` 是纯数据模型，不关心存储细节。

## 三层状态分治

状态按 scope 前缀路由到不同存储位置：

```
┌──────────────────────────────────────────────────────┐
│  state = {                                           │
│    "locale": "en-US",                  → session 表  │
│    "app:theme": "dark",               → app_states   │ (全局共享)
│    "user:name": "Alice",              → user_states  │ (用户级共享)
│    "temp:draft": "...",               → 内存不持久   │
│  }                                                   │
└──────────────────────────────────────────────────────┘
```

| Scope | 前缀 | 存储位置 | 生命周期 | 共享范围 |
|-------|------|----------|----------|----------|
| **Session** | 无前缀 | `sessions.state` | 会话存活 | 单 session |
| **App** | `app:` | `app_states.state` | 永久 | 同一 app 内所有 session/user |
| **User** | `user:` | `user_states.state` | 永久 | 同一 (app, user) 的所有 session |
| **Temp** | `temp:` | 仅内存 | 单次 invocation | 同 invocation 的 agent 间 |

**为什么要三层分治：**
- `app:` 前缀 → 跨用户全局共享（如主题、版本号），不需要复制到每个 session
- `user:` 前缀 → 用户级别的偏好/认证信息，跨 session 可用
- `temp:` 前缀 → 单次调用内 agent 间临时通信，不污染存储
- 无前缀 → session 自身状态，与其他 session 隔离

## 路由机制

`_session_util.extract_state_delta()` 按前缀拆分为 3 份 delta：

```python
def extract_state_delta(state):
    deltas = {"app": {}, "user": {}, "session": {}}
    for key, value in state.items():
        if key.startswith("app:"):
            deltas["app"][key.removeprefix("app:")] = value
        elif key.startswith("user:"):
            deltas["user"][key.removeprefix("user:")] = value
        elif not key.startswith("temp:"):
            deltas["session"][key] = value
    return deltas
```

反过来，`_merge_state()` 在读取时重新合并：

```python
def _merge_state(app_state, user_state, session_state):
    merged = copy.deepcopy(session_state)
    for k, v in app_state.items():
        merged["app:" + k] = v
    for k, v in user_state.items():
        merged["user:" + k] = v
    return merged
```

## Identity 三元组

所有存储操作按 `(app_name, user_id, session_id)` 定位：

```
PRIMARY KEY (app_name, user_id, id)   -- sessions 表
PRIMARY KEY (app_name)                -- app_states 表
PRIMARY KEY (app_name, user_id)       -- user_states 表
PRIMARY KEY (app_name, user_id, session_id, id)  -- events 表
```

## 类继承关系

```
BaseSessionService (ABC)
├── 抽象方法:
│     create_session() → Session
│     get_session()    → Session | None
│     list_sessions()  → ListSessionsResponse
│     delete_session()
│
├── 非抽象方法:
│     get_user_state()       (默认 raise NotImplementedError)
│     append_event()         (内存 + temp 处理)
│     flush()                (默认 no-op)
│     _apply_temp_state()    (temp 状态注入内存)
│     _trim_temp_delta_state() (temp 持久化前剔除)
│     _update_session_state() (事件状态合并到 session)
│
└── 管理类:
      GetSessionConfig       (查询过滤: num_recent_events, after_timestamp)
      ListSessionsResponse   (批量返回包装)
```
