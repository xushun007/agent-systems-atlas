# Gemini CLI

本项目研究 Gemini CLI `v0.59.0` 的 Runtime/Harness 演进。

- 上游仓库：[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- 分析版本：`v0.59.0`
- 分析 commit：[`fb0d535af931b27c51e87e5e6ade72905b1e8390`](https://github.com/google-gemini/gemini-cli/commit/fb0d535af931b27c51e87e5e6ade72905b1e8390)
- 研究报告：[Gemini CLI Harness Runtime 演进](research/gemini-cli-harness-evolution.md)

研究重点是 ContextManager/AgentChatHistory、Tool Scheduler、Policy/Sandbox、Session Bundle、Subagent、Rollback、Workspace Trust 与动态工具的请求/cache 边界。
