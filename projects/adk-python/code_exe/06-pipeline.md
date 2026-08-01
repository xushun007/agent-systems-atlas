# 单流集成

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
