# Runner 类详解

## 字段一览

```python
class Runner:
    app_name: str                           # 应用名
    agent: Optional[BaseAgent | BaseNode]   # 根 agent 或 node
    artifact_service: BaseArtifactService   # 文件存储
    session_service: BaseSessionService     # 会话存储（必须）
    memory_service: BaseMemoryService       # 长期记忆
    credential_service: BaseCredentialService  # 认证凭据
    plugin_manager: PluginManager           # 插件管理
    context_cache_config: ContextCacheConfig # 上下文缓存
    resumability_config: ResumabilityConfig  # 可恢复性配置
```

## 构造函数 `__init__`

**三种入口（互斥，三选一）：**

| 参数 | 场景 |
|------|------|
| `app=App(...)` | 推荐方式，包含完整配置（name、agent、plugins） |
| `agent=BaseAgent(...)` | 旧接口，需同时传 `app_name` |
| `node=BaseNode(...)` | 直接传 workflow 节点 |

三者通过 `_resolve_app()` 统一归一化为 `App` 实例。

**关键操作：**
1. `_resolve_app()` → 验证互斥性，包装为 App
2. 从 App 提取所有配置字段
3. `_infer_agent_origin()` → 推断 agent 来源目录路径
4. `_enforce_app_name_alignment()` → 检查 app_name 与 agent 目录名是否一致

## `_resolve_app()` — 入口归一化

```
app ─────────────────────────────→ App (直接使用)
agent + app_name ────────────────→ App.model_construct(...) [绕过验证，兼容旧 API]
node ────────────────────────────→ App.model_construct(name=node.name, ...)
```

使用 `model_construct` 而非 `App(name=...)` 是为了绕过新版 App 的严格校验，兼容 v1 的任意命名和 root_agent 类型。

## `_infer_agent_origin()` — 来源推断

**优先级：**
1. `agent._adk_origin_app_name` / `_adk_origin_path`（AgentLoader 设置的最可靠来源）
2. 从 `inspect.getmodule(agent.__class__)` 推断模块路径
3. 如果是 `google.adk.*` 内部模块 → 返回 None（跳过）
4. 路径中必须包含 `agents` 目录 → 否则返回 None

**返回值：** `(origin_app_name, origin_path)` 或 `(None, None)`

## `_enforce_app_name_alignment()` — 命名对齐检查

如果 agent 来源目录名与 `app_name` 不一致，记录 warning 并生成 `_app_name_alignment_hint`，在 session not found 时输出提示信息。

---

## InMemoryRunner

```python
class InMemoryRunner(Runner):
    # 自动使用内存实现的服务
    artifact_service → InMemoryArtifactService()
    session_service  → InMemorySessionService()
    memory_service   → InMemoryMemoryService()
```

用于测试和开发的轻量版本，无需外部存储。
