# State 管理：前缀路由 + json_patch + Temp 状态

## State 类：内存中的状态容器

```python
class State:
    APP_PREFIX = "app:"
    USER_PREFIX = "user:"
    TEMP_PREFIX = "temp:"

    def __init__(self, value, delta, schema=None):
        self._value = value   # 当前已提交的值
        self._delta = delta   # 未提交的变更
        self._schema = schema # 可选的 Pydantic schema 校验
```

`State` 不是 dict 的子类，而是实现了 `__getitem__` / `__setitem__` / `__contains__` 的 dict-like 对象：

```python
def __getitem__(self, key):
    if key in self._delta:    # delta 优先（未提交变更）
        return self._delta[key]
    return self._value[key]   # 已提交值

def __setitem__(self, key, value):
    # schema 校验 (如果有)
    self._value[key] = value  # 同时写入 value (当前策略)
    self._delta[key] = value  # 写入 delta
```

## 前缀路由：`extract_state_delta()`

```python
def extract_state_delta(state: dict) -> dict:
    deltas = {"app": {}, "user": {}, "session": {}}
    if state:
        for key, value in state.items():
            if key.startswith("app:"):
                deltas["app"][key.removeprefix("app:")] = value
            elif key.startswith("user:"):
                deltas["user"][key.removeprefix("user:")] = value
            elif not key.startswith("temp:"):    # temp 被忽略
                deltas["session"][key] = value
    return deltas
```

**关键规则：**
- `app:xxx` → 去 `app_states` 表，key 为 `xxx`
- `user:xxx` → 去 `user_states` 表，key 为 `xxx`
- `temp:xxx` → **被忽略**（不会路由到任何存储）
- 其他 → session 表

## 合并：`_merge_state()`

```python
def _merge_state(app_state, user_state, session_state):
    merged = copy.deepcopy(session_state)
    for key, value in app_state.items():
        merged["app:" + key] = value      # 重新加上前缀
    for key, value in user_state.items():
        merged["user:" + key] = value     # 重新加上前缀
    return merged
```

**读取路径全景：**
```
get_session() → session_row["state"]  → session_state (无前缀)
                app_states.state      → app_state     (无前缀)
                user_states.state     → user_state    (无前缀)
                         │
                         ▼
                _merge_state()
                         │
                         ▼
                Session(state={
                    "key1": "v1",           ← session
                    "app:key2": "v2",       ← app 前缀重建
                    "user:key3": "v3",      ← user 前缀重建
                })
```

## `json_patch` — 原子部分更新

不是 `UPDATE SET state = new_value`（全量替换），而是：

```sql
INSERT INTO app_states (app_name, state, update_time) VALUES (?, ?, ?)
ON CONFLICT(app_name) DO UPDATE
SET state = json_patch(state, excluded.state),
    update_time = excluded.update_time
```

**`json_patch()` 是 SQLite 内置的 JSON 函数**：
- 原地合并：新 key 添加，已有 key 覆盖
- `json_patch({"a": 1}, {"b": 2})` → `{"a": 1, "b": 2}`
- `json_patch({"a": 1}, {"a": 2})` → `{"a": 2}`

**为什么用 json_patch 而非全量替换：**
1. **并发友好** — 两个请求同时修改不同 key 不会互相覆盖
2. **无需读-改-写** — 不需要先 SELECT 再 UPDATE
3. **原子操作** — INSERT ON CONFLICT + json_patch 是单条 SQL

## Temp 状态的生命周期

```
Agent A ────→ ctx.state["temp:signal"] = "ready"
                  ↓
            _apply_temp_state()      ← 注入 session.state 内存
                  ↓
            Agent B 读到 ctx.state["temp:signal"]  (同 invocation 内可见)
                  ↓
            Event.actions.state_delta = {"temp:signal": "ready"}
                  ↓
            _trim_temp_delta_state()  ← 持久化前剔除 temp: 前缀
                  ↓
            event.actions.state_delta = {}   (空)
                  ↓
            append_event → INSERT 到 events 表 (无 temp 数据)
```

**Temp 的用途：** 同一次 invocation 中，多个 agent/子节点需要临时共享数据，但不想污染持久化的会话状态。

例如 SequentialAgent 的 `output_key` 功能就依赖 temp state：
- Agent A 设置 `temp:my_output = result`
- Agent B 通过 `ctx.state["temp:my_output"]` 读取 A 的输出

## Schema 校验

```python
class StateSchemaError(TypeError):
    """Raised when a state mutation violates the declared state_schema."""

def _validate_state_entry(schema, key, value):
    if ":" in key:
        return                           # 前缀 key 绕过校验
    fields = schema.model_fields
    if key not in fields:
        raise StateSchemaError(...)
    TypeAdapter(fields[key].annotation).validate_python(value)
```

`State.__setitem__` 和 `State.update` 在 schema 存在时会校验每个 entry。
