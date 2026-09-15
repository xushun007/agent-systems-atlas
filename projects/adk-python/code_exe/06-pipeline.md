# 单流集成

> **版本基线（v2.8.0）**：本文依据官方 commit [`76a96e6221f1e2758a1ff82fde199cd079e9c654`](https://github.com/google/adk-python/commit/76a96e6221f1e2758a1ff82fde199cd079e9c654)。该版本的处理器链仍是 Code Execution 的主集成点；恢复、工具确认和后台任务生命周期由更上层 Runtime 协同完成。

## 管线位置

`_code_execution.py` 通过两个全局 processor 实例嵌入 LLM 流：

```python
# single_flow.py
_request_processors = [
    basic.request_processor,
    instructions.request_processor,
    contents.request_processor,
    _code_execution.request_processor,   # ← 在 LLM 调用前
]

_response_processors = [
    _nl_planning.response_processor,
    _code_execution.response_processor,  # ← 在 LLM 返回后
]
```

## Request Processor 流程

```
_CodeExecutionRequestProcessor.run_async()
    │
    ├─ agent 无 code_executor → 跳过
    │
    ├─ _run_pre_processor(invocation_context, llm_request)
    │   │
    │   ├─ BuiltInCodeExecutor?
    │   │   └─ code_executor.process_llm_request(llm_request)
    │   │      → 注入 code_execution tool 到 config.tools
    │   │      → return
    │   │
    │   ├─ 无 optimize_data_file → 跳过
    │   │
    │   ├─ error_count >= error_retry_attempts → 跳过
    │   │
    │   ├─ _extract_and_replace_inline_files()
    │   │   → 扫描所有 user content，提取 text/csv inline_data
    │   │   → 替换为 "Available file: `data_1_1.csv`" 占位符
    │   │   → 存入 CodeExecutorContext
    │   │
    │   └─ 对每个新文件执行 explore_df()
    │       ├─ execute_code() → CodeExecutionResult
    │       ├─ yield Event(code_content)
    │       ├─ yield Event(code_execution_result)
    │       └─ 结果 append 到 llm_request.contents
    │
    └─ 反向转换: executable_code Part → text Part
       (对 LLM request 中的历史内容做 format 转换)
```

## Response Processor 流程

```
_CodeExecutionResponseProcessor.run_async()
    │
    ├─ partial 响应 → 跳过（流式输出中间件）
    │
    └─ _run_post_processor(invocation_context, llm_response)
        │
        ├─ 无 code_executor → 跳过
        │
        ├─ BuiltInCodeExecutor?
        │   ├─ 扫描 inline_data (image/...)
        │   ├─ save_artifact() → artifact_delta
        │   └─ inline_data → text("Saved as artifact: {name}.")
        │
        ├─ error_count >= error_retry_attempts → 跳过
        │
        ├─ extract_code_and_truncate_content()
        │   → 无代码块 → 跳过（正常结束）
        │
        ├─ yield Event(response_content)  # 原始模型响应(已截断)
        │
        ├─ execute_code()
        │
        ├─ _post_process_code_execution_result()
        │   ├─ stderr → increment_error_count()
        │   ├─ stdout → reset_error_count()
        │   ├─ output_files → save_artifact()
        │   └─ yield Event(result_content, artifact_delta, state_delta)
        │
        └─ llm_response.content = None  # 标记：进入下一轮代码生成循环
```

## 循环机制

设置 `llm_response.content = None` 后，BaseLlmFlow 发现响应为空，会继续下一轮 LLM 调用。这样就形成了：

```
LLM 生成代码 → execute → LLM 看到结果 → LLM 再生成代码 → execute → ...
```

直到 LLM 不再生成代码块为止。

## 反向转换：Part 格式化

Request 阶段最后一步，对 llm_request.contents 中的历史内容做格式转换：

```python
for content in llm_request.contents:
    CodeExecutionUtils.convert_code_execution_parts(
        content,
        code_block_delimiters[0],     # ('```python\n', '\n```')
        execution_result_delimiters,  # ('```tool_output\n', '\n```')
    )
```

把 `executable_code` Part → text Part（用 code_block_delimiter 包裹），`code_execution_result` Part → text Part（用 execution_result_delimiters 包裹）。这确保传给模型的 prompt 是纯文本格式。

## v2.8.0 与恢复/缓存的边界

处理器每轮都会重新构造或修改 `LlmRequest`，因此动态工具、代码执行结果和 context cache 都可能影响请求前缀。v2.8.0 的运行时修复重点不是把工具永久注入 prompt，而是保证动态工具、恢复请求和历史 Event 不造成重复执行或错误 resume。缓存相关变化见 [`2.7.0 CHANGELOG`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L180-L431) 和 [`2.8.0 CHANGELOG`](https://github.com/google/adk-python/blob/76a96e6221f1e2758a1ff82fde199cd079e9c654/CHANGELOG.md#L1-L171)。
