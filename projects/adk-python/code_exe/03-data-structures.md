# 关键数据结构

> **版本基线（v2.8.0）**：源码 commit [`76a96e6221f1e2758a1ff82fde199cd079e9c654`](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654)。本页的数据结构解释的是 v2.8.0 与 Session/Event/Artifact Runtime 的关系。

## File

```python
@dataclasses.dataclass(frozen=True)
class File:
    name: str              # 文件名（含扩展名）
    content: str | bytes   # base64 编码的 bytes 或原始 bytes
    mime_type: str = 'text/plain'  # MIME 类型
```

## CodeExecutionInput

```python
@dataclasses.dataclass
class CodeExecutionInput:
    code: str                          # 待执行的 Python 代码
    input_files: list[File] = []       # 输入文件
    execution_id: Optional[str] = None # 有状态执行会话 ID
```

## CodeExecutionResult

```python
@dataclasses.dataclass
class CodeExecutionResult:
    stdout: str = ''                   # 标准输出
    stderr: str = ''                   # 标准错误
    output_files: list[File] = []      # 输出文件（图片、数据等）
```

## CodeExecutorContext — 跨 invocation 持久化

```python
class CodeExecutorContext:
    _context: dict[str, Any]  # 从 session.state['_code_execution_context'] 读写

    # 执行会话 ID
    get_execution_id() → str | None
    set_execution_id(id)

    # 输入文件管理
    get_input_files() → list[File]
    add_input_files(files)
    clear_input_files()

    # 已处理文件追踪（避免重复 explore_df）
    get_processed_file_names() → list[str]
    add_processed_file_names(names)

    # 错误计数
    get_error_count(invocation_id) → int
    increment_error_count(invocation_id)
    reset_error_count(invocation_id)

    # 执行结果追踪
    update_code_execution_result(invocation_id, code, stdout, stderr)

    # 获取 state delta（用于 EventActions）
    get_state_delta() → dict
```

存储位置：`session.state['_code_execution_context']`，包含 `execution_session_id` 和 `processed_input_files` 等。

`session.state['_code_executor_input_files']` 存储文件列表。

`session.state['_code_executor_error_counts']` 存储 `{invocation_id: count}` 错误计数。

## CodeExecutionUtils — 静态工具方法

| 方法 | 作用 |
|------|------|
| `get_encoded_file_content(bytes)` | 确保文件内容是 base64 编码 |
| `extract_code_and_truncate_content(content, delimiters)` | 从 Content 中提取第一个代码块 |
| `build_executable_code_part(code)` | 构建 `executable_code` Part |
| `build_code_execution_result_part(result)` | 构建 `code_execution_result` Part |
| `convert_code_execution_parts(content, ...)` | `executable_code` → text Part（反向转换） |

## v2.8.0 持久化边界

`CodeExecutorContext` 的执行会话、输入文件、错误计数和结果追踪最终通过 state delta 进入 Event/Session；它不是独立的 durable execution database。`File` 的二进制内容还可能转移到 ArtifactService，Event 只保留可供后续 LLM flow 识别的引用或结果 Part。恢复时必须同时考虑 Event、session state 和 artifact identity。
