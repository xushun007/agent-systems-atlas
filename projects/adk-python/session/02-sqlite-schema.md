# SQLite Schema

## 四表设计

`SqliteSessionService` 使用 4 张表，全部通过 `CREATE TABLE IF NOT EXISTS` 自创建。

### `app_states` — App 级全局状态

```sql
CREATE TABLE IF NOT EXISTS app_states (
    app_name TEXT PRIMARY KEY,
    state TEXT NOT NULL,          -- JSON 字符串
    update_time REAL NOT NULL     -- Unix 秒
);
```

- 主键: `app_name`
- 每个 app 仅一条记录，跨所有 user/session 共享

### `user_states` — 用户级状态

```sql
CREATE TABLE IF NOT EXISTS user_states (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL,          -- JSON 字符串
    update_time REAL NOT NULL,
    PRIMARY KEY (app_name, user_id)
);
```

- 复合主键: `(app_name, user_id)`
- 同一 app 下同一用户跨 session 共享

### `sessions` — 会话记录

```sql
CREATE TABLE IF NOT EXISTS sessions (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,             -- session_id
    state TEXT NOT NULL,          -- session 级 state (JSON)
    create_time REAL NOT NULL,
    update_time REAL NOT NULL,
    PRIMARY KEY (app_name, user_id, id)
);
```

- 复合主键: `(app_name, user_id, id)`
- `state` 仅存储 session 级 key（无 `app:` / `user:` / `temp:` 前缀）
- `update_time` 同时用于过期 session 检测

### `events` — 事件日志

```sql
CREATE TABLE IF NOT EXISTS events (
    id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    event_data TEXT NOT NULL,     -- Event.model_dump_json(exclude_none=True)
    PRIMARY KEY (app_name, user_id, session_id, id),
    FOREIGN KEY (app_name, user_id, session_id)
        REFERENCES sessions(app_name, user_id, id)
        ON DELETE CASCADE
);
```

- 复合主键: `(app_name, user_id, session_id, id)`
- **外键级联删除**: session 被删除时其事件自动清除
- `event_data` 为完整 Event 的 JSON 序列化（排除 None 值）

## 建表 SQL 聚合

```python
CREATE_SCHEMA_SQL = "\n".join([
    APP_STATES_TABLE_SCHEMA,
    USER_STATES_TABLE_SCHEMA,
    SESSIONS_TABLE_SCHEMA,
    EVENTS_TABLE_SCHEMA,
])
```

在每次 `_get_db_connection()` 时执行 `PRAGMA foreign_keys = ON` + `executescript(CREATE_SCHEMA_SQL)`。

## 关键设计选择

### 为什么 event 存整行 JSON 而非拆列？

旧 schema (v0) 把 Event 字段拆成多列 (`author`, `branch`, `actions`, 等)，导致：
- 每增加一个 Event 字段就要 migration
- SQLAlchemy ORM 的序列化开销大

新 schema 的 `event_data TEXT` + `model_dump_json(exclude_none=True)`:
- 字段增加不需要改表
- 查询/写入简化为 JSON 字符串
- `exclude_none=True` 压缩 None 值

### 为什么 event 不是 `AUTOINCREMENT` 主键？

事件 ID 由应用层（`event.id`）生成，不走 DB 自增。原因：
- 事件 ID 可能在恢复场景中复用
- 便于跨存储迁移

### 为什么 `sessions.state` 不含 `app:` / `user:` 前缀？

- `app:` state 落在 `app_states` 表 → 全局共享
- `user:` state 落在 `user_states` 表 → 用户级共享
- session 表只存自身 state → 查询 Session 时动态 merge

这样避免了在 N 个 session 中复制同一份 app_state。

## Connection 管理

```python
@asynccontextmanager
async def _get_db_connection(self):
    async with aiosqlite.connect(
        self._db_connect_path, uri=self._db_connect_uri
    ) as db:
        db.row_factory = aiosqlite.Row        # 支持按列名访问
        await db.execute(PRAGMA_FOREIGN_KEYS)
        await db.executescript(CREATE_SCHEMA_SQL)
        yield db
```

每次操作获取新连接（aiosqlite 内部有连接复用），自动执行 schema 检查和 foreign key 启用。

## DB Path 解析

`_parse_db_path()` 兼容三种路径格式：

| 输入 | 解析结果 |
|------|----------|
| `"mydb.db"` | 文件路径，直接 connect |
| `"sqlite:///relative.db"` | URL 格式，取 path 部分 |
| `"sqlite:////absolute/path.db?mode=ro"` | URL + query string 转 `file:` URI |

遵循 SQLAlchemy 的 SQLite URL 规范。
