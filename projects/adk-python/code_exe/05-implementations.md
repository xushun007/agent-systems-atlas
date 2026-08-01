# 六种实现对比

## 1. BuiltInCodeExecutor

```python
class BuiltInCodeExecutor(BaseCodeExecutor):
    def execute_code(self, ...):
        pass  # 不执行代码

    def process_llm_request(self, llm_request):
        # 给 llm_request 注入 code_execution tool
        llm_request.config.tools.append(
            types.Tool(code_execution=types.ToolCodeExecution())
        )
```

**特点：**
- `execute_code()` 是空方法 — 代码由 Gemini 服务端执行
- 在 Request 阶段给 LLM 请求加 code_execution tool，Gemini 自动识别代码块
- Response 阶段只处理图片（inline_data → artifact），其余交给模型
- **仅支持 Gemini 2.0+**（`is_gemini_eap_or_2_or_above` 校验）

## 2. UnsafeLocalCodeExecutor

```python
class UnsafeLocalCodeExecutor(BaseCodeExecutor):
    stateful = False (frozen)        # 不可设为 True
    optimize_data_file = False (frozen) # 不可设为 True

    def execute_code(self, ...):
        process = ctx.Process(target=_execute_in_process, args=(code, globals_, queue))
        process.start()
        output, err = queue.get(timeout=...)   # 带超时
        return CodeExecutionResult(stdout=output, stderr=err)
```

**特点：**
- 使用 `multiprocessing.spawn` 子进程隔离执行
- 带 `timeout_seconds` 超时终止
- `exec(code, globals_, globals_)` — 直接解释执行
- **不安全** — 代码运行在宿主机上，仅用于本地调试
- 不可 stateful，不可 optimize_data_file

## 3. VertexAiCodeExecutor

```python
class VertexAiCodeExecutor(BaseCodeExecutor):
    resource_name: str  # 可复用已有 Code Interpreter Extension

    def execute_code(self, ...):
        # 1. 拼接预置 import (numpy, pandas, scipy, matplotlib)
        # 2. 调用 Vertex AI Code Interpreter Extension
        # 3. 输出文件分类（image/png → artifact, text/csv → artifact）
```

**特点：**
- 使用 Vertex AI Code Interpreter Extension — 托管沙箱
- 自动注入库：`numpy`, `pandas`, `matplotlib`, `scipy`
- 支持数据文件处理（`optimize_data_file`）
- 支持 stateful 执行
- 输出文件按 MIME 类型分类保存到 artifact

**预置库：**
```python
import io, math, re
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy
# 还有 explore_df() 和 crop() 等辅助函数
```

## 4. ContainerCodeExecutor

```python
class ContainerCodeExecutor(BaseCodeExecutor):
    container_image: str = 'adk-code-executor:latest'
    container_host: str       # Docker host
    environment_vars: dict    # 环境变量
    volumes: list             # 挂载卷

    def execute_code(self, ...):
        # 1. 创建 Docker 容器
        # 2. 注入代码 + 输入文件
        # 3. 执行 python 脚本
        # 4. 收集 stdout/stderr/output_files
```

**特点：**
- 通过 Docker SDK 启动隔离容器执行
- `stateful=True` 时容器复用（同一 session 的后续执行共享同一容器）
- 支持 `code_block_delimiters` / `execution_result_delimiters` 配置
- 容器通过 `docker run` 和 `docker cp` 注入代码与文件

## 5. GkeCodeExecutor

```python
class GkeCodeExecutor(ContainerCodeExecutor):
    # 继承 ContainerCodeExecutor
    # 将容器执行迁移到 GKE (Google Kubernetes Engine)
```

**特点：** 基于 `ContainerCodeExecutor`，将执行从单机 Docker 迁移到 GKE 集群，适合生产级多租户场景。

## 6. AgentEngineSandboxCodeExecutor

```python
class AgentEngineSandboxCodeExecutor(BaseCodeExecutor):
    # 使用 Agent Engine 的托管沙箱执行
```

**特点：** 使用 ADK 平台的 Agent Engine 沙箱能力，无需自行管理执行环境。

## 对比速查

| 特性 | BuiltIn | UnsafeLocal | VertexAI | Container | GKE | AgentEngine |
|------|---------|-------------|----------|-----------|-----|-------------|
| 执行环境 | Gemini 内部 | 本机子进程 | GCP 沙箱 | Docker | K8s | 平台托管 |
| stateful | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| optimize_data_file | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 代码提取 | 模型自带 | ` ```python ``` ` | ` ```python ``` ` | delimiters | delimiters | delimiters |
| 输出文件 | 图片 → artifact | ❌ | 图片/CSV → artifact | 文件 → artifact | 文件 → artifact | ❌ |
| 适用 | Gemini 2.0+ | 本地调试 | GCP 生产 | 自托管 | 集群生产 | ADK 平台 |
