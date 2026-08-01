# BaseCodeExecutor 详解

## 抽象基类

```python
class BaseCodeExecutor(BaseModel):
    optimize_data_file: bool = False          # 是否自动处理 CSV 数据文件
    stateful: bool = False                    # 是否保留执行会话
    error_retry_attempts: int = 2             # 连续错误后放弃执行
    code_block_delimiters: list[tuple]        # 如何从 text 中提取代码块
    execution_result_delimiters: tuple        # 如何格式化执行结果
    timeout_seconds: int | None = None        # 超时秒数

    @abc.abstractmethod
    def execute_code(
        self,
        invocation_context: InvocationContext,
        code_execution_input: CodeExecutionInput,
    ) -> CodeExecutionResult:
        ...
```

## code_block_delimiters — 代码块提取

```python
# 默认配置，支持两种格式
code_block_delimiters = [
    ('```tool_code\n', '\n```'),    # ADK 内部格式
    ('```python\n', '\n```'),       # 标准 Markdown
]
```

后处理中按 delimiters 顺序扫描 LLM 返回的 text，提取**第一个匹配的代码块**。

## execution_result_delimiters — 结果格式化

```python
execution_result_delimiters = ('```tool_output\n', '\n```')
```

前处理中把 `code_execution_result` Part 转为 text 时的包裹符。

## execute_code 协议

所有实现必须覆盖这个方法：

```python
def execute_code(
    self,
    invocation_context: InvocationContext,   # 含 session、artifact、memory 等
    code_execution_input: CodeExecutionInput, # {code, input_files, execution_id}
) -> CodeExecutionResult:                     # {stdout, stderr, output_files}
```

这是一个**同步**方法（不是 async），因为代码执行通常不需要网络 I/O。

## error_retry_attempts — 错误策略

连续执行错误达到 `error_retry_attempts` 次后，整个 invocation 内不再尝试执行代码。

错误计数存储在 `CodeExecutorContext` → session state `_code_executor_error_counts[invocation_id]` 中。每次成功执行 reset 计数。
