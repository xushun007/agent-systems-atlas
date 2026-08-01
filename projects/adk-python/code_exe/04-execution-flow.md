# 核心执行流程

## 执行流程全景

```
用户消息(含 CSV inline data)
    │
    ▼
┌─ _run_pre_processor (Request) ─────────────────────────────────┐
│                                                                 │
│  BuiltInCodeExecutor?  ──→ 给 LLM request 注入 code_execution  │
│                            tool，直接返回（Gemini 自己执行代码）│
│                                                                 │
│  optimize_data_file=True?                                       │
│  ├─ 从 llm_request.contents 提取 inline data 文件               │
│  │   (text/csv → data_1_1.csv)                                  │
│  ├─ 生成 explore_df() 代码                                      │
│  ├─ execute_code() 执行                                          │
│  ├─ 替换 inline data → 文件名占位符文本                          │
│  └─ Yield 代码 + 结果 Event                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ LLM 调用 ────────────────────────────────────────────────────┐
│  Gemini 返回:                                                  │
│  "Let me analyze this data..."                                 │
│  ```python                                                     │
│  import pandas as pd                                           │
│  df = pd.read_csv('data_1_1.csv')                              │
│  print(df.head())                                              │
│  ```                                                           │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ _run_post_processor (Response) ───────────────────────────────┐
│                                                                 │
│  BuiltInCodeExecutor?                                           │
│  ├─ 提取图片 inline_data → 保存到 artifact_service              │
│  └─ 返回                                                       │
│                                                                 │
│  error_retry 检查（超限则跳过）                                  │
│                                                                 │
│  Step 1: extract_code_and_truncate_content()                    │
│          → 从 text 中提取第一个代码块                            │
│          → 截断 content，只保留代码块之前的内容                   │
│                                                                 │
│  Step 2: execute_code()                                         │
│          → CodeExecutionInput(code, input_files, execution_id)  │
│          → CodeExecutionResult(stdout, stderr, output_files)    │
│                                                                 │
│  Step 3: _post_process_code_execution_result()                  │
│          ├─ 构建 code_execution_result Part (ok/error)           │
│          ├─ 输出文件 → artifact_service.save_artifact()          │
│          ├─ 错误计数 update                                      │
│          └─ 返回 Event(content=result, actions=artifact_delta)  │
│                                                                 │
│  Step 4: llm_response.content = None   ← 禁止原始返回继续传播   │
│          使 LLM 引擎知道结果已处理，进入下一轮                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Request 预处理的两种模式

### 模式 A：BuiltInCodeExecutor — 模型托管

```python
if isinstance(code_executor, BuiltInCodeExecutor):
    code_executor.process_llm_request(llm_request)
    # → 给 llm_request.config.tools 追加 types.Tool(code_execution=...)
    # → Gemini 自己调用 code_execution 工具，结果直接以 code_execution_result Part 返回
    return
```

代码执行由 Gemini 服务端完成，ADK 不参与实际执行。仅对 Gemini 2.0+ 模型有效。

### 模式 B：其他 Executor — 本地/SaaS 执行

```python
if code_executor.optimize_data_file:
    # 1. 扫描 llm_request 中所有 user message 的 inline_data
    # 2. CSV 文件 → 提取为 File(name='data_1_1.csv', content=base64...)
    # 3. 替换 inline data Part → text Part("Available file: `data_1_1.csv`")
    # 4. 对每个新文件执行 explore_df() 代码
    # 5. Yield 代码 Event + 结果 Event
```

`optimize_data_file=True` 会在 LLM 看到消息**之前**，自动把用户上传的 CSV 文件转换并探索，这样 LLM 收到的已经是 pandas DataFrame 的摘要信息。

## Response 后处理的关键步骤

### Step 1: 代码提取

```python
code_str = CodeExecutionUtils.extract_code_and_truncate_content(
    response_content, code_executor.code_block_delimiters
)
```

优先提取 `executable_code` Part（Gemini 原生），其次扫描 text 中的 ` ```python ` 或 ` ```tool_code ` 块。

### Step 2: 执行

```python
code_execution_result = code_executor.execute_code(
    invocation_context,
    CodeExecutionInput(
        code=code_str,
        input_files=code_executor_context.get_input_files(),
        execution_id=_get_or_set_execution_id(...),
    ),
)
```

### Step 3: 后处理 + 持久化

```python
_post_process_code_execution_result(...):
    # 构建结果 Content
    result_content = Content(parts=[CodeExecutionUtils.build_code_execution_result_part(...)])

    # 输出文件 → artifact_service
    for output_file in code_execution_result.output_files:
        version = await artifact_service.save_artifact(...)
        event_actions.artifact_delta[output_file.name] = version

    # 错误计数
    if stderr:
        code_executor_context.increment_error_count(...)
    else:
        code_executor_context.reset_error_count(...)

    return Event(content=result_content, actions=event_actions)
```

### Step 4: 阻断原始消息

```python
llm_response.content = None  # 标记已处理 → LLM 引擎进入下一轮 → 可能再次生成代码
```

## 误差重试机制

```
invocation 生命周期:
  execute_code → stdout ok  → reset_error_count()  → 计数器 0
  execute_code → stderr     → increment_error_count() → 计数器 +1

  每次预/后处理前检查:
  if error_count >= error_retry_attempts:
      return  # 跳过，不再尝试执行
```

计数器按 `invocation_id` 独立，跨 invocation 不互相影响。

## 有状态执行 (stateful)

通过 `code_executor.stateful=True` 开启，对应 `execution_id` 机制：

```python
def _get_or_set_execution_id(...):
    if not code_executor.stateful:
        return None          # 无状态 → 每次独立执行

    execution_id = context.get_execution_id()
    if not execution_id:
        execution_id = session.id   # 首次：用 session_id 作为 execution_id
        context.set_execution_id(execution_id)
    return execution_id
```

**作用：** 同一 session 连续多轮代码执行共享同一个会话（如 Colab notebook），上一轮的变量在下一轮仍然可用。
