# mini-SWE-agent SWE-Bench 单条 issue 处理流程

## 1. 入口：`swebench_single.py`

命令行入口：

```bash
python -m minisweagent.run.benchmarks.swebench_single \
  --subset princeton-nlp/SWE-Bench_Verified \
  --split test \
  --instance 0 \
  -c swebench.yaml \
  -c environment.environment_class=local \
  -c model.model_name=openai/deepseek-chat \
  -c model.model_kwargs.api_base=https://api.deepseek.com \
  -c model.model_kwargs.api_key=<key>
```

主要步骤：

1. 用 `datasets.load_dataset()` 加载 SWE-Bench 数据集
2. 根据 `--instance` 选择 instance（支持索引或 instance_id）
3. 合并配置文件：`swebench.yaml` + 命令行 `-c` 覆盖
4. 调用 `get_sb_environment(config, instance)` 创建环境
5. 调用 `get_agent(get_model(...), env, config)` 创建 agent
6. 调用 `agent.run(instance["problem_statement"])` 开始运行

## 2. 环境创建：`swebench.py::get_sb_environment`

```python
env_config = {**config.get("environment", {})}
env_config["environment_class"] = env_config.get("environment_class", "docker")
image_name = get_swebench_docker_image_name(instance)
if env_config["environment_class"] == "docker":
    env_config["image"] = image_name
```

- 默认 `environment_class` 是 `docker`
- 从 instance 构造 docker image 名：`docker.io/swebench/sweb.eval.x86_64.<instance_id>:latest`
- 然后调用 `get_environment(env_config)` 实例化对应环境类
- 如果配置里有 `run.env_startup_command`，会先用 Jinja2 渲染并执行

### 2.1 Docker 环境

`DockerEnvironment.__init__` 直接调用 `_start_container()`：

```bash
docker run -d --name minisweagent-<uuid> -w /testbed --rm <image> sleep 2h
```

`execute()` 时用 `docker exec` 在容器里执行 bash 命令。

### 2.2 Local 环境

`LocalEnvironment.execute()` 直接用 `subprocess.Popen(shell=True, cwd=...)` 在本地执行命令，不创建容器。

**注意**：swebench.yaml 默认 `cwd: "/testbed"`，这是 Docker 镜像里的路径。本地跑必须改成实际存在的目录。

## 3. Agent 主循环：`DefaultAgent.run()`

初始化消息：

1. system message：用 `system_template` 渲染
2. user message：用 `instance_template` 渲染，其中 `{{task}}` 是 issue 的 `problem_statement`

然后进入 `while True` 循环：

```python
while True:
    self.step()
    if self.messages[-1].get("role") == "exit":
        break
```

### 3.1 `step()`

```python
def step(self):
    return self.execute_actions(self.query())
```

### 3.2 `query()`

1. 检查限制：`step_limit`、`cost_limit`、`wall_time_limit_seconds`
2. 调用 `self.model.query(self.messages)`
3. 累加 cost 和调用次数
4. 把模型返回消息加入历史

### 3.3 `execute_actions()`

1. 从模型消息的 `extra.actions` 取出 action 列表
2. 对每个 action 调用 `self.env.execute(action)`
3. 用 `model.format_observation_messages()` 把输出格式化为 observation 消息
4. 加入历史

## 4. 模型调用：`LitellmModel.query()`

1. `_prepare_messages_for_api()`：去掉 `extra` 字段，处理 Anthropic thinking blocks 和 cache control
2. 调用 `litellm.completion(model=..., messages=..., tools=[BASH_TOOL], **model_kwargs)`
3. 用 tenacity 做重试
4. `_parse_actions()` 解析返回的 tool_calls

只有一个 tool：`bash`，参数是 `{"command": "..."}`。

### 4.1 配置覆盖关系

- `swebench.yaml` 默认：`model_name: "anthropic/claude-sonnet-4-5-20250929"`
- 命令行 `-c model.model_name=openai/deepseek-chat` 覆盖的是 `model.model_name`
- **不是** `model.model`，也不是 `--model` 短选项（短选项等价于 `model.model_name`）

## 5. 提交检测

环境 `execute()` 会检查输出：

```python
if lines[0].strip() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" and returncode == 0:
    raise Submitted({...})
```

agent 收到 `Submitted` 异常后，会把最后一条消息 role 设为 `"exit"`，从而结束循环。

batch 模式（`swebench.py`）下会把 `submission` 写入 `preds.json` 的 `model_patch` 字段。

## 6. 配置合并规则

`get_config_from_spec()` 支持三种 spec：

- 文件路径：如 `swebench.yaml`
- 内置文件名：如 `swebench.yaml` 会解析到 `src/minisweagent/config/benchmarks/swebench.yaml`
- key-value：如 `model.model_name=openai/deepseek-chat`

多个 `-c` 按顺序用 `recursive_merge()` 合并，后面的覆盖前面的。

## 7. 常见坑

| 问题 | 原因 | 解决 |
|------|------|------|
| `FileNotFoundError: docker` | 没装 Docker | 安装 Docker Desktop 或用 `environment.environment_class=local` |
| `/testbed` 不存在 | 本地环境没改 cwd | `-c environment.cwd=<实际目录>` |
|  AnthropicException / 404 | `model.model_name` 没覆盖成功 | 检查 `-c model.model_name=...`，不是 `model.model` |
| tools[0] unknown variant `custom` | 用了 DeepSeek 的 Anthropic 兼容接口 | 用 OpenAI 兼容接口：`openai/deepseek-chat` + `api_base=https://api.deepseek.com` |
| 成本计算报错 | LiteLLM 没注册该模型价格 | `-c model.model_kwargs.cost_tracking=ignore_errors` 或设置 `MSWEA_COST_TRACKING=ignore_errors` |
