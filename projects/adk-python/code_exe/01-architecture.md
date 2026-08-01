# Code Executor 架构总览

## 什么是 Code Executor

ADK 允许 agent 执行 LLM 生成的代码并将结果注入对话上下文。`CodeExecutor` 就是这个"执行环境"的抽象。

## 六种实现

```
BaseCodeExecutor (ABC)
├── BuiltInCodeExecutor           ← Gemini 2.0+ 内置 code_execution tool
├── UnsafeLocalCodeExecutor       ← 本地 multiprocessing 子进程执行
├── VertexAiCodeExecutor          ← Vertex AI Code Interpreter Extension
├── ContainerCodeExecutor         ← Docker 容器执行
├── GkeCodeExecutor               ← GKE (Google Kubernetes Engine)
└── AgentEngineSandboxCodeExecutor ← Agent Engine 沙箱
```

| 实现 | 执行环境 | 安全性 | 适用场景 |
|------|----------|--------|----------|
| BuiltIn | Gemini 内部 | 安全（模型托管） | Gemini 2.0+ 模型 |
| UnsafeLocal | 本地子进程 | **不安全**（本地环境） | 本地调试 |
| VertexAI | GCP 托管沙箱 | 安全 | 生产级代码执行 |
| Container | Docker 容器 | 隔离 | 自托管沙箱 |
| GKE | K8s Pod | 隔离 | 生产级集群 |
| AgentEngine | ADK 托管沙箱 | 安全 | ADK 平台 |

## 核心数据流

```
                    ┌─ Request Pre-Processor ─┐
  用户消息           │  - 提取数据文件          │
  (带 CSV inline)    │  - 执行 explore_df()     │
                     │  - 替换 inline → 占位符  │
                     └─────────────────────────┘
                                 │
                                 ▼
                     ┌─ LLM 调用 ─────────────┐
                     │  - Gemini 返回代码块     │
                     │  - 或 text 中的代码      │
                     └─────────────────────────┘
                                 │
                                 ▼
                     ┌─ Response Post-Processor┐
                     │  - 提取代码块 (```python)│
                     │  - execute_code()        │
                     │  - 生成结果 Part           │
                     │  - 保存输出文件到 artifact │
                     └─────────────────────────┘
```

## 双处理器架构

在 LLM 流中，code executor 以两个 **processor** 形式嵌入，位于 `single_flow.py` 的管道中：

```python
# Request 管道（代码执行排最后，因为需要修改内容）
_request_processors = [
    basic,
    instructions,
    contents,
    _code_execution.request_processor,  # ← 数据文件预处理 + BuiltIn 工具注入
]

# Response 管道
_response_processors = [
    _nl_planning,
    _code_execution.response_processor,  # ← 提取代码 + 执行 + 结果包装
]
```

## 核心数据结构

| 类型 | 定义 | 用途 |
|------|------|------|
| `CodeExecutionInput` | `{code, input_files, execution_id}` | 执行输入 |
| `CodeExecutionResult` | `{stdout, stderr, output_files}` | 执行输出 |
| `File` | `{name, content, mime_type}` | 文件数据 |
| `CodeExecutorContext` | session state 包装 | 跨 invocation 持久化上下文 |
