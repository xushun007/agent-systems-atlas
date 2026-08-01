# Code Execution 源码分析速查

源码位置: `src/google/adk/code_executors/` + `src/google/adk/flows/llm_flows/_code_execution.py`

## 文件索引

| 文件 | 内容 |
|------|------|
| [01-architecture.md](01-architecture.md) | 架构总览、六种执行器、双处理器管道 |
| [02-base-executor.md](02-base-executor.md) | BaseCodeExecutor 抽象基类、字段、协议 |
| [03-data-structures.md](03-data-structures.md) | CodeExecutionInput/Result、File、CodeExecutorContext |
| [04-execution-flow.md](04-execution-flow.md) | 完整执行链：预处理器 → LLM → 后处理器 |
| [05-implementations.md](05-implementations.md) | 六种执行器详细对比 |
| [06-pipeline.md](06-pipeline.md) | 在 LLM 流中的集成点和循环机制 |

## 核心文件清单

```
src/google/adk/code_executors/
├── base_code_executor.py           # 抽象基类 (97 行)
├── built_in_code_executor.py       # Gemini 内置 code_execution tool (57 行)
├── unsafe_local_code_executor.py   # multiprocessing 子进程 (116 行)
├── vertex_ai_code_executor.py      # Vertex AI Code Interpreter (242 行)
├── container_code_executor.py      # Docker 容器 (200 行)
├── gke_code_executor.py            # GKE (继承 container)
├── agent_engine_sandbox_code_executor.py  # Agent Engine 沙箱
├── code_execution_utils.py         # 工具类 + 数据类 (272 行)
└── code_executor_context.py        # 持久化上下文 (204 行)

src/google/adk/flows/llm_flows/
└── _code_execution.py              # 集成点：RequestProcessor + ResponseProcessor (542 行)
```

## 核心调用链

```
用户发送 CSV 文件
    → _CodeExecutionRequestProcessor
        → _run_pre_processor()
            → data_file_optimize:
                extract inline → execute explore_df() → 注入结果到 LLM context
            → BuiltInCodeExecutor:
                process_llm_request() → 注入 code_execution tool

模型返回代码块
    → _CodeExecutionResponseProcessor
        → _run_post_processor()
            → extract_code_and_truncate_content()
            → execute_code() → CodeExecutionResult
            → _post_process_code_execution_result()
                → build_code_execution_result_part()
                → save_artifact() (输出文件)
                → Event(content=result, actions=artifact_delta)
            → llm_response.content = None → 下一轮
```

## 测试入口

```bash
uv run pytest tests/unittests/code_executors/ -v
```

## 快速接入

```python
from google.adk import Agent
from google.adk.code_executors import BuiltInCodeExecutor

agent = Agent(
    name='data_analyst',
    model='gemini-2.5-flash',
    code_executor=BuiltInCodeExecutor(),
    instruction='You can execute Python code to analyze data.'
)
```
