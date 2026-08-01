# Schema 迁移：旧 SQLAlchemy → 新 JSON

## 背景

ADK 早期版本使用 SQLAlchemy ORM 存储 session，Event 字段被拆为多个列（`author`、`branch`、`actions` 等）。v2 重构为单列 `event_data TEXT`（存储完整 Event JSON），提升扩展性。

## 迁移检测：`_is_migration_needed()`

```python
def _is_migration_needed(self) -> bool:
    db_path = self._db_path
    if not os.path.exists(db_path):
        return False                        # 新 DB，无需迁移

    conn = sqlite3.connect(db_path, uri=...)
    cursor = conn.cursor()

    # 1. 检查 events 表是否存在
    cursor.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'"
    )
    if not cursor.fetchone():
        return False                        # 没有 events 表，无需迁移

    # 2. 检查 event_data 列是否存在
    cursor.execute("PRAGMA table_info(events)")
    columns = [row[1] for row in cursor.fetchall()]
    if "event_data" in columns:
        return False                        # 已有 event_data → 新 schema
    else:
        return True                         # 有 events 表但无 event_data → 旧 schema
```

**检测逻辑：** 如果 events 表存在但缺少 `event_data` 列 → 旧 schema → 需要迁移。

在 `__init__` 中自动检查，如果检测到旧 schema 直接 `raise RuntimeError` 提示用户运行迁移。

## 迁移工具

位置: `src/google/adk/sessions/migration/migrate_from_sqlalchemy_sqlite.py`

```bash
python -m google.adk.sessions.migration.migrate_from_sqlalchemy_sqlite \
    --source_db_path old.db \
    --dest_db_path new.db
```

**流程：**

```
1. 连接源 DB (SQLAlchemy + v0 schema)
   ├─ create_engine(source_db_url)
   └─ 查询 v0 格式的 session/event

2. 连接目标 DB (新 schema)
   ├─ sqlite3.connect(dest_db_path)
   ├─ PRAGMA foreign_keys = ON
   └─ executescript(CREATE_SCHEMA_SQL)

3. 逐条迁移:
   ├─ sessions  →  INSERT INTO sessions (...)
   ├─ events    →  将旧多列转换为 event_data JSON → INSERT INTO events
   ├─ app_states →  INSERT INTO app_states
   └─ user_states → INSERT INTO user_states

4. commit()
```

## 旧 schema (v0) vs 新 schema 对比

| 维度 | 旧 (SQLAlchemy ORM) | 新 (纯 SQLite + JSON) |
|------|---------------------|------------------------|
| events 存储 | 多列 (`author`, `branch`, `actions`, `model_response`, ...) | 单列 `event_data TEXT` |
| Event 新增字段 | 需要 migration 加列 | 无需 schema 变更 |
| 依赖 | SQLAlchemy + ORM Session | 仅 aiosqlite |
| 查询复杂度 | ORM 表达式 | 原始 SQL（简单） |
| 序列化 | ORM 托管 | `model_dump_json(exclude_none=True)` |

## 迁移脚本使用方式

触发条件：`SqliteSessionService.__init__` 中 `_is_migration_needed()` 返回 `True` 时抛出 RuntimeError：

```
RuntimeError: Database /path/to/old.db seems to use an old schema.
Please run the migration command to migrate it to the new schema.
Example: python -m google.adk.sessions.migration.migrate_from_sqlalchemy_sqlite
    --source_db_path /path/to/old.db
    --dest_db_path /path/to/old.db.new
then backup /path/to/old.db and rename /path/to/old.db.new to /path/to/old.db.
```

## URL 转换

迁移脚本支持 `sqlite+aiosqlite://` URL → `sqlite://` 转换（SQLAlchemy 异步驱动 → 同步引擎）：

```python
source_sync_url = _schema_check_utils.to_sync_url(source_db_url)
```

这样用户可以用和运行时相同的 URL 格式做迁移。
