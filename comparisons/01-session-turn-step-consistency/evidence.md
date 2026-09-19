# 版本与证据索引

复核日期：2026-09-16。适用范围：[第一篇：状态所有权与执行边界](01-state-ownership.md)、[第二篇：输入接纳、排队与生效边界](02-input-admission.md)、[第三篇：Step 一致性](03-step-consistency.md)、[第四篇：中断与终态收敛](04-interruption-and-convergence.md)、[第五篇：持久化与恢复](05-persistence-and-recovery.md)。

本文档维护证据范围，不作为单项目架构快照，也不修改已有快照的版本归属。

## 版本基线

| 项目 | 版本标识 | 本次读取的 commit |
| --- | --- | --- |
| Codex | `rust-v0.154.0` | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Kimi Code | `v0.40.0`，仅讨论相关 v2 路径 | `e27ee60894d714e5844db75da69f29120a2bce43` |
| mini-SWE-agent | `v2.4.5-2-g38c01a1`，沿用已有研究的历史标识，不冒充发布 tag | `38c01a19ed1a58dd17dd7c95010e4f69d059c777` |
| Pi | `v0.85.1`，第二篇限于底层 Agent 与 loop，不扩展到 v4 durable harness | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| OpenCode | `v2.0.0` | `63f7ceecbed2d7d9a627518d935dd963b9d4ac9f` |

本地 HEAD 均已核对。针对正文所引用的实现与测试文件执行 `git diff --exit-code HEAD -- <files>`，未发现偏离 HEAD 的修改。上游其他已有工作区修改与本研究无关，保留原状。

Codex 的 `project.yaml` 原有 `analyzed_commit` 属于此前架构快照；本次机制复核版本单独记录在 `mechanism_reviews` 中，避免把旧快照静默改成新版本。

## 第一篇：主张与依据

| 主张 | 源码 / 测试 | 本次证据等级及限制 |
| --- | --- | --- |
| Codex steer 校验目标 Turn 并写入该 Turn 的 pending input | [turn_input.rs](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input.rs#L510-L619) | 已读源码；未运行实际客户端 |
| Codex 请求级上下文与 Turn 可变状态分离 | [step_context.rs](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs)、[state/turn.rs](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/state/turn.rs) | 已读字段与约定；不推出全局原子快照 |
| Codex 任务结束可以将尚未消费的输入写入历史 | [task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/tests.rs#L11720-L11837) | 已读测试；测试核对 history，不单独证明磁盘 durability |
| Kimi 请求出队与请求物化是不同状态 | [StepRequest](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequest.ts)、[StepRequestQueue](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/stepRequestQueue.ts) | 已直接运行这两个原始类，断言通过 |
| Kimi 实际物化时先追加 context，再改变请求状态 | [materializeRequest](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/loop/loopService.ts#L818-L832) | 已读源码；轻量实验没有执行此函数 |
| Kimi 测试规定排队 Turn 可在未开始、未应用初始消息时撤回 | [loop.test.ts](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/test/agent/loop/loop.test.ts#L794-L819) | 已读测试；本地收集失败，运行测试数为零 |
| mini 默认 Step 组合 query 与 actions，Agent 持有消息及执行依赖 | [default.py](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/src/minisweagent/agents/default.py) | 已读实现和[确定性模型测试](https://github.com/SWE-agent/mini-swe-agent/blob/38c01a19ed1a58dd17dd7c95010e4f69d059c777/tests/agents/test_default.py)；未运行 |

实验脚本、步骤、结果及失败信息见 [Kimi 实验记录](../../experiments/session-turn-step-consistency/kimi-admission/README.md)。

## 第二篇：主张与依据

| 主张 | 依据 | 本次证据范围 |
| --- | --- | --- |
| Pi steer 与 follow-up 进入不同模型调用 | [原始循环](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L154-L271)；实验场景 1、2 | 实测；观察点为模型适配函数入口 |
| Pi 普通工具批次不会因本实验中的 steer 而取消剩余调用 | 同上；[上游对应测试](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/agent-loop.test.ts#L679-L783) | 专题实验运行通过，上游测试只阅读 |
| Pi 排空模式影响同一次请求中的输入集合 | [队列实现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L125-L160)；实验场景 3、4 | 实测，不评价模型输出质量 |
| Pi 在准备阶段后按条件重新读取 steering 输入 | 原始循环；实验场景 5 | 实测；不覆盖晚于最终检查的输入 |
| 更新 Agent 模型字段与更新循环模型配置是不同操作 | [循环配置构造](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L445-L485)；实验场景 6、7 | 实测底层 Agent；不代表 CLI 行为 |
| Kimi steer 校验原目标并在分配失败时恢复队列顺序 | [Prompt 服务](https://github.com/MoonshotAI/kimi-code/blob/e27ee60894d714e5844db75da69f29120a2bce43/packages/agent-core-v2/src/agent/prompt/promptService.ts#L394-L443) 和第二篇引用的测试 | 源码及 stub-loop 测试阅读；没有本地运行这些测试 |
| Codex 输入接纳与 pending input 消费分离，后者存在继续执行门控 | [接纳逻辑](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn_input.rs#L510-L603)、[采样循环](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L290-L404) | 源码及相关测试阅读 |
| Codex 特定等待工具可响应新输入提前返回 | [wait_agent](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L159) 和[请求捕获测试](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/tests/suite/pending_input.rs#L574-L639) | 源码、测试阅读；不是通用进程取消证明 |

Pi 的七场景完整产物见 [results.json](../../experiments/session-turn-step-consistency/pi-input-boundaries/artifacts/results.json)，加载适配、受控模型与工具、复现命令及限制见[实验记录](../../experiments/session-turn-step-consistency/pi-input-boundaries/README.md)。模型响应是预设的，因此本实验验证 Runtime 可见性，不验证真实模型推理或指令遵循。

## 第三至第五篇：主张与依据

| 主张 | 依据 | 本次证据范围 |
| --- | --- | --- |
| Codex 将解析后的 Step 设置固定，并在延迟激活时重新检查管理授权 | [`StepContext`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_context.rs)、[activation tests](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/step_activation_tests.rs#L272-L770) | 源码与测试阅读 |
| Pi 的 Agent 快照复制顶层数组，但不深拷贝工具对象 | [Agent context snapshot](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L436-L485) | 源码阅读；未将对象突变实验写入本次正式产物 |
| Pi 取消通过 AbortSignal 合作式传播，idle 晚于 agent_end | [loop](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L430-L718)、[Agent lifecycle](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L319-L337) | 源码阅读；未运行本篇新增的取消实验 |
| Codex 在取消时先传播 token，等待 100ms 后强制 abort，并尝试先 flush 中断标记 | [task abort](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tasks/mod.rs#L900-L990) | 源码阅读 |
| OpenCode 用持久 claim 发现未结算执行，shutdown 保留 claim、用户中断释放 claim | [execution service](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/src/session/execution.ts#L70-L185)、[tests](https://github.com/anomalyco/opencode/blob/63f7ceecbed2d7d9a627518d935dd963b9d4ac9f/packages/core/test/session-execution.test.ts#L79-L146) | 源码与上游测试阅读 |
| Pi v4 恢复 assistant generation 时补写恢复终态，不重新调用 provider；工具只有 replay-safe 条件满足时才重放 | [recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)、[tool recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts#L515-L543) | 源码与上游测试阅读 |
| Pi JSONL storage 丢弃无换行撕裂尾部，但拒绝换行结束的内部损坏行 | [JSONL storage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts#L90-L290)、[storage tests](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/harness/jsonl-storage.test.ts#L258-L341) | 源码与上游测试阅读 |

第三至第五篇的实验边界是刻意保守的：没有 API key 也可以验证底层顺序和 JSONL 撕裂处理，但本次正文只把已经核对的源码/测试作为依据，未把真实 provider、shell 进程或服务重启写成已实测事实。

## 解释与未确认事项

“身份归属、写入责任、可见性边界、生命周期与保存”是作者提出的分析框架；“历史、配置、活跃执行、派生视图、外部状态”也是比较维度，不声称项目内都存在五个对应组件。

开篇修复接口场景是用于提出问题的假设场景，没有标注为任何产品的实际故障。本文的普遍性判断限定于支持执行中交互的 Runtime，不提供使用频率或缺陷发生率结论。

第二篇已验证 Pi 模型适配函数入口的可见性；实际网络请求、客户端与核心事件顺序、工具进程取消、文件副作用与历史保存的一致性仍待验证。两组局部实验均不能替代端到端验证。

GitHub URL 均由本地仓库来源、固定 SHA 和真实文件路径组成。浏览工具对 Codex 对应页面返回 cache miss，因此当前复核以本地 Git 内容为准，不宣称所有远程链接已通过在线访问检查。

第一至第五篇完成后检查专题内部链接、脚注与已有实验 JSON，并以本地 `git show <sha>:<path>` 核对固定版本源码路径和行号范围；`git diff --check` 通过。
