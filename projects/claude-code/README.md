# Claude Code

本项目研究 Claude Code 的 Runtime/Harness 架构。

- 上游研究材料：[freestylefly/claude-code](https://github.com/freestylefly/claude-code)
- 分析 commit：[`6e2f79c5b97ae619172a3e621e87dd0edb220619`](https://github.com/freestylefly/claude-code/commit/6e2f79c5b97ae619172a3e621e87dd0edb220619)
- 当前架构快照：[Claude Code Runtime / Harness 架构](arch/claude-code-runtime-architecture.md)
- 研究报告：[Claude Code Harness Runtime 分析](research/claude-code-harness-evolution.md)

重要边界：该仓库是第三方公开的泄漏源码快照，不是 Anthropic 官方 release，也没有连续官方版本历史。本报告只描述快照中可观察到的 QueryEngine、query loop、Task、Permission、Workspace 和 Remote Session 结构，不形成正式版本演进结论。
