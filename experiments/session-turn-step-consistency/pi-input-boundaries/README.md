# Pi 执行中输入的可见性实验

实验日期：2026-09-16。关联文章：[输入接纳、排队与生效边界](../../../comparisons/01-session-turn-step-consistency/02-input-admission.md)。

## 研究问题

在同一批工具执行期间提交的 steer 与 follow-up，分别进入哪一次后续模型调用？单批次排空与逐条排空是否影响可见时点？配置对象更新是否自动改变活跃循环的模型选择？

## 版本与环境

- 上游：https://github.com/earendil-works/pi
- 版本：`v0.85.1`。
- Commit：`d981de1229ef899957bbe968bc8dcda02a21f477`。
- 环境：macOS arm64，Node `v26.5.0`，TypeBox `1.3.7`。
- 执行模式：原始 `Agent`、原始 agent loop、原始事件流与工具参数校验；顺序执行两个内存工具调用。
- 模型：通过 `streamFn` 注入确定性响应。没有访问真实模型服务，模型名称 `model-a`、`model-b` 是实验标识。
- 观察点：`streamFn` 被调用时传入的 model 和 context；这属于模型适配函数入口，不是网络发送或服务端接收。

## 加载方式与隔离范围

[probe.mjs](probe.mjs) 直接导入上游 TypeScript 文件，未复制或修改控制流。Node 的模块解析钩子将 `@earendil-works/pi-ai` 映射为一个窄导出模块，只重新导出原始 `EventStream` 和原始 `validateToolArguments`，避免加载无关模型提供商依赖。TypeBox 从实验依赖目录解析。

这个适配不替换循环、排队、模型参数选取、事件流或工具校验实现，但没有验证 Pi 包入口及完整依赖集的集成行为。它也未运行 CLI、v4 durable harness、网络协议、真实审批或文件写入。

脚本核对 HEAD、所加载的五个实现文件相对 HEAD 未修改，以及 TypeBox 的版本。模型响应与工具是受控替身；没有 stub 输入调度逻辑。15 秒超时只用于防止实验挂起，正常时序由 Promise 屏障决定。

## 复现方法

需要一个固定在上述 commit 的 Pi 源码仓库和支持 `module.registerHooks()`、原生 TypeScript 类型擦除的 Node 环境。本次使用 Node 26.5.0；未验证其他 Node 版本。

从 Atlas 根目录执行以下准备命令，将唯一额外依赖下载到临时目录：

```sh
probe_deps=$(mktemp -d)
curl -L --fail https://registry.npmjs.org/typebox/-/typebox-1.3.7.tgz -o "$probe_deps/typebox-1.3.7.tgz"
shasum -a 256 "$probe_deps/typebox-1.3.7.tgz"
tar -xzf "$probe_deps/typebox-1.3.7.tgz" -C "$probe_deps"
```

本次依赖归档的 SHA-256 为：

```text
b1d0942560e64936ca9ce328949b5a6c8258e8d08511addb7eebb54cfda0863a
```

运行实验。假设源码位于同级 `pi`；输出写到临时目录，避免覆盖本次保留记录：

```sh
node experiments/session-turn-step-consistency/pi-input-boundaries/probe.mjs \
  ../pi "$probe_deps/package" "$probe_deps/results.json"
```

没有第三个参数时仅输出摘要。保留的本次完整结果为 [artifacts/results.json](artifacts/results.json)，由脚本直接生成，包含全部调用输入、工具执行顺序和生命周期事件，不包含本机源码路径。

## 实验设计

每个场景创建独立 Agent。首次模型响应返回两个工具调用。第一个工具开始时发出信号，并等待实验驱动释放；第二个工具只有在第一个结束后执行。追加输入在第一个工具等待期间提交。后续模型响应固定为无工具调用的结束文本。

准备阶段实验稍有不同：先完成工具批次，再阻塞 `prepareNextTurn`，在此期间提交 steer，最后释放准备阶段。模型配置实验则在第一个工具等待期间将 `agent.state.model` 替换为另一个模型对象，分别设置和不设置返回新模型的 `prepareNextTurn` 回调。

模型适配函数一经调用，即对输入做深拷贝。后续上下文追加不会改变已经保存的请求观察结果。实验分别保留消息的原始格式，仅在摘要和断言中归一化纯文本内容。

## 观察结果

七个场景全部通过，进程退出码为 `0`。以下请求编号只属于各个独立场景。

| 场景 | 观察 |
| --- | --- |
| 工具期间提交 steer | 第一次请求无追加输入；第二次请求包含追加输入；两个工具均在第二次请求之前完成 |
| 工具期间提交 follow-up | 第二次请求仍无追加输入；第二次响应无工具调用后，第三次请求才包含追加输入 |
| 两条 steer，`all` | 两条输入同时进入第二次请求，总计两次请求 |
| 两条 steer，`one-at-a-time` | 第一条进入第二次请求；第二条到第三次请求才加入，总计三次请求 |
| 准备阶段提交 steer | `prepareNextTurn` 返回后被重新读取，进入第二次请求 |
| 更新模型，无准备回调 | Agent 状态已变为 `model-b`，本次运行的两个请求仍使用 `model-a` |
| 更新模型，准备回调返回新模型 | 第一次请求使用 `model-a`，第二次请求使用 `model-b` |

脚本还断言：初始请求只含初始输入；两个工具均执行成功；第二个工具完成早于第二次模型调用；最终队列为空；运行以 `agent_end` 结束。

## 结论与限制

在被测 Pi 底层 Agent 中，steer 与 follow-up 的可见边界不同，steer 不会取消这个普通工具批次的剩余调用。队列排空策略会影响同时提交的要求是否共同进入下一次模型调用。Agent 状态配置和运行中循环配置也不自动保持同步，准备回调提供了显式更新路径。

这些结果不证明模型遵循了追加指令，因为响应是预设的；也不证明真实提供商收到相同输入，因为没有运行适配器或网络传输。配置实验不代表 Pi CLI 的模型切换行为：宿主可以安装额外更新回调，v4 harness 也有独立调度与配置路径。

本实验没有覆盖：输入晚于最后一次队列检查到达、多个客户端同时写入、真实中断及审批、持久化、恢复和文件副作用。这里的“请求”均指模型适配函数调用。

## 执行记录与失败处理

准备阶段使用独立临时目录。此前 npm 安装遇到 DNS 失败，后续改用固定版本 tarball 下载成功，未改变上游依赖或源码。

初始实验脚本的两个接入问题已修正：`Agent.prompt(string)` 将初始输入转换为内容数组，需要在断言时归一化；该版本通过 `agent.state.model` 更新模型，没有 `setModel()` 方法。这两次失败属于实验驱动错误，不作为上游缺陷或行为结论。当前保留结果来自修正后的完整七场景运行。
