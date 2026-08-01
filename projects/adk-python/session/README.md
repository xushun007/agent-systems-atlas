# Session 存储模块深度解析

源码位置: `src/google/adk/sessions/`

## 文件索引

| 文件 | 内容 |
|------|------|
| [01-architecture.md](01-architecture.md) | 三层状态分治模型、类继承、identity 三元组 |
| [02-sqlite-schema.md](02-sqlite-schema.md) | 四表 DDL、键设计、外键级联、connection 管理 |
| [03-api-design.md](03-api-design.md) | 6 个核心方法逐方法解析 + stale session 检测 |
| [04-state-management.md](04-state-management.md) | 前缀路由、json_patch 原子更新、temp 状态生命周期 |
| [05-event-persistence.md](05-event-persistence.md) | JSON 序列化策略、partial 事件、事务保证 |
| [06-migration.md](06-migration.md) | 旧 SQLAlchemy → 新 JSON 的迁移检测与执行 |
| [07-comparison.md](07-comparison.md) | InMemory / Sqlite / Database 三种实现对比 |

## 核心设计精华

### 三层状态分治

```
state = {"locale": "en", "app:theme": "dark", "user:lang": "zh"}

extract_state_delta()  →  app_states / user_states / sessions 分流

_merge_state()         →  读取时重新组合还原
```

### json_patch — 无锁原子更新

```sql
INSERT INTO app_states ... ON CONFLICT DO UPDATE
SET state = json_patch(state, excluded.state)
```

两个并发请求写不同 key 不会互相覆盖。

### Event 全量 JSON 存储

```python
event_data = event.model_dump_json(exclude_none=True)
```

字段增删不需要 schema migration。

### Stale session 检测

```python
if storage_update_time > session.last_update_time:
    raise ValueError("stale session")
```

防止并发写覆盖。

### Temp 状态

`temp:` 前缀 → 单次 invocation 内的 agent 间通信 → 持久化前剔除 → 不污染存储。

## 测试入口

```bash
# SqliteSessionService 测试
uv run pytest tests/unittests/sessions/ -v

# 迁移测试
uv run pytest tests/unittests/sessions/migration/ -v
```

## 类关系

```
BaseSessionService (ABC)
├── InMemorySessionService
│   └── 嵌套 dict，测试用
├── SqliteSessionService
│   ├── app_states 表
│   ├── user_states 表
│   ├── sessions 表
│   └── events 表 (ON DELETE CASCADE)
├── DatabaseSessionService
│   └── SQLAlchemy 多引擎
└── VertexAiSessionService
    └── GCP Vertex AI
```
