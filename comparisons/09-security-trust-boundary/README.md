---
title: Coding Agent 的 Security / Trust Boundary
reviewed_at: 2026-09-18
status: active
document_type: mechanism-series
---

# Coding Agent 的 Security / Trust Boundary

## 专题问题

本专题研究 Coding Agent 如何在用户、模型、Runtime、工具、Environment、Provider 和外部资源之间建立安全边界。

重点讨论：

- Capability、Authority、Policy 和 Approval；
- Prompt Injection 与不可信 Tool Result；
- Sandbox、Workspace、网络和 Secret；
- 子 Agent、Plugin/MCP 的权限传播；
- 持久化、恢复和多 worker 场景下的安全状态；
- 事实、模型建议和外部输入的信任等级。

## 文章目录

1. [信任模型与能力边界](01-trust-model-and-capabilities.md)
2. [Prompt Injection 与不可信 Tool Result](02-prompt-injection-and-untrusted-results.md)
3. [Sandbox、Workspace、Network 与 Secret 隔离](03-sandbox-workspace-network-and-secrets.md)

本专题暂收束为三篇。后续不再通过增加概念性文章扩张范围，而是针对这三篇补充固定版本源码证据和可复现实验，重点验证权限是否真正落到执行边界、隔离是否能阻止越界、以及取消和恢复后资源是否收敛。
