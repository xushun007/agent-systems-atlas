# Kimi 请求状态与队列边界实验

实验日期：2026-09-16。关联文章：[Session、Turn 与 Step：Coding Agent 的状态所有权与执行边界](../../../comparisons/01-session-turn-step-consistency/01-state-ownership.md)

## 问题与基线

请求进入队列、被取出、被物化为上下文输入，是否是同一次状态变化？多个请求是否必然对应多个执行批次？

- 上游：https://github.com/MoonshotAI/kimi-code
- 版本：`v0.40.0`。
- Commit：`e27ee60894d714e5844db75da69f29120a2bce43`。
- 环境：macOS arm64，Node `v26.5.0`，tsx `4.21.0`；完整测试尝试使用 Vitest `4.1.4`。
- 无模型 API、网络工具、用户凭据或真实工作区修改。

## 直接运行原始实现

[probe.mjs](probe.mjs) 动态导入上游的 `MessageStepRequest` 和 `StepRequestQueue`，没有复制或重写这两个类。脚本检查 HEAD，并检查三个相关源文件相对 HEAD 无修改。该检查不覆盖整个依赖树。

从 Atlas 根目录运行，假定上游源码是同级的 `kimi-code`，且其 tsx 依赖已安装：

```sh
../kimi-code/node_modules/.bin/tsx experiments/session-turn-step-consistency/kimi-admission/probe.mjs ../kimi-code
```

可替换源码参数及 tsx 的安装路径。源码需处于上述 commit。测试只读取源码；输出到标准输出。本次 stdout 的结构化内容保留在 [probe-results.json](artifacts/probe-results.json)，由运行输出转录，未包含进程号和弃用警告。

脚本依次断言：

1. 入队后，请求状态仍为 `pending`，队列报告有待处理项。
2. `takeNextBatch()` 取出请求后，请求状态仍为 `pending`，队列已经为空。
3. 显式调用 `markMaterialized()` 后状态才变成 `materialized`；此时请求的 `abort()` 返回 `false`。
4. 另一个仍在等待的请求可以被 `abort()`，随后不会被队列返回。
5. 一个普通请求和一个 `mergeable` 请求可以组成一个 batch；取出时两者仍为 `pending`。

观察：以上断言全部通过，进程退出码为 `0`。

结论：这两个原始类确实区分队列位置、请求物化状态和批次合并。请求已取出不等于已物化，一个 batch 也不等于一个输入。

边界：本脚本显式调用 `markMaterialized()`，没有运行真正的上下文追加、AgentLoopService、模型请求或持久化。实际物化时先追加 context 再标记状态的行为来自源码阅读。`abort()` 返回 `false` 仅表示该请求不能再按 pending request 撤回，不表示其所属 Step/Turn 不能被取消。实验不能证明用户输入在 UI 中的生效时间，也不能证明崩溃恢复行为。

## 完整 Loop 测试尝试

为了进一步检查 admission、取消与 context 的关系，尝试运行以下四个上游测试：

- `holds new admissions until an idle quiescence lease is released`
- `can abort an admission while quiescence holds it`
- `cancels a running step without cancelling its turn and continues the next step`
- `cancels a queued turn without starting or materializing its initial request`

在 `kimi-code/packages/agent-core-v2` 目录运行：

```sh
../../node_modules/.bin/vitest run test/agent/loop/loop.test.ts \
  --config vitest.config.ts --configLoader runner --no-cache \
  --testNamePattern 'holds new admissions until|can abort an admission while|cancels a running step without|cancels a queued turn without' \
  --reporter=json \
  --outputFile=../../../agent-systems-atlas/experiments/session-turn-step-consistency/kimi-admission/artifacts/vitest-results.json
```

结果：测试收集阶段失败，`fileService.ts` 无法解析 `zod`，实际运行的测试数为 `0`。保留的原始报告为 [vitest-results.json](artifacts/vitest-results.json)。报告包含本机源文件绝对路径，属于实验原始产物，不作为文章链接或可移植项目配置。

这不是 assertion 失败，也不是上游行为不满足预期。四项测试目前只能作为已阅读的测试规格，不能列为本地验证通过。

其他尝试：Node 26.5.0 不接受 `--experimental-transform-types`；直接运行 Node 又无法处理参数属性；Bun 1.3.12 未解析该包的 `#/*` 导入。最终使用现有 tsx 成功。tsx 首次在沙箱内创建 IPC 管道遭遇 `EPERM`，获得执行许可后成功运行。未改动上游源码及依赖配置。

## 后续验证

在完整隔离依赖环境中重跑四项 Loop 测试，再添加工具屏障和请求内容捕获。先观察“追加要求何时进入真实模型请求”，然后再验证 CLI 的展示与控制行为。当前实验只支持请求与队列层的结论。
