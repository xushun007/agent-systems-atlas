# 三种 Session 存储实现对比

## InMemorySessionService

```python
class InMemorySessionService(BaseSessionService):
    def __init__(self):
        self.sessions: dict[str, dict[str, dict[str, Session]]] = {}
        # {app_name: {user_id: {session_id: Session}}}
        self._user_state: dict[str, dict[str, dict[str, Any]]] = {}
        # {app_name: {user_id: state}}
```

| 维度 | 详情 |
|------|------|
| 存储 | 嵌套 dict，进程重启丢失 |
| 持久性 | 无 |
| 状态分治 | 无（所有 state 平坦存 session.state dict） |
| 查询过滤 | 支持 `GetSessionConfig` (num_recent_events / after_timestamp) |
| 迁移 | 无需 |
| 适用场景 | 测试、开发、demo |

**特点：** 实现最简单的实现，所有数据在内存中。`events` 按 `get_session_config` 做切片返回但本身全量存储。

## SqliteSessionService

| 维度 | 详情 |
|------|------|
| 存储 | 单文件 SQLite (aiosqlite) |
| 持久性 | 文件级持久 |
| 依赖 | 仅 `aiosqlite` |
| 状态分治 | `app_states` / `user_states` / `sessions.state` 三层表 + prefix 路由 |
| Event 存储 | `event_data TEXT` (JSON，exclude_none) |
| 并发安全 | Stale session 检测 + 事务隔离 |
| 原子更新 | `json_patch` 原地 merge |
| 迁移 | 旧 SQLAlchemy → 新 JSON 的迁移脚本 |

**特点：** 轻量级持久存储方案，无需外部数据库服务。适合单机部署和小型应用。

## DatabaseSessionService

| 维度 | 详情 |
|------|------|
| 存储 | 多引擎：SQLite / PostgreSQL / Cloud Spanner / MySQL / Oracle |
| 持久性 | 取决于底层 DB |
| 依赖 | SQLAlchemy + async 驱动 |
| Event 存储 | 多列 ORM 模型 (旧 schema 方式) 或 JSON |
| 并发 | DB 级事务 + 行锁 |
| 适用场景 | 生产级多用户部署 |

**特点：** 最灵活但最重。支持水平扩展（通过不同 DB 引擎），适配 Google Cloud 生态。

## 核心差异总结

```
InMemory        Sqlite           Database
────────        ──────           ────────
dict            aiosqlite        SQLAlchemy
无持久           单文件           多引擎
无分治           三表分治          分表/JSON
测试用           单机部署          生产部署
0 依赖           1 依赖            重依赖
```

## 三者共同的契约

无论底层实现是什么，它们都遵循 `BaseSessionService` 的抽象：

```python
create_session()  → Session           # 创建
get_session()     → Session | None     # 查询
list_sessions()   → ListSessionsResponse # 列表
delete_session()  → None               # 删除
append_event()    → Event              # 写事件
get_user_state()  → dict               # 读用户状态
flush()           → None               # 刷新缓冲
```

上层代码（Runner、InvocationContext）不关心底层是哪种实现，只通过 `session_service` 接口操作。
