---
title: Coding Agent 的 Extension / Plugin Architecture
reviewed_at: 2026-09-18
status: complete
document_type: mechanism-series
---

# Coding Agent 的 Extension / Plugin Architecture

## 专题问题

Coding Agent 的扩展机制，不只是“增加几个工具”。它改变的是 Runtime 的能力边界：谁可以注册能力，能力运行在哪个进程和 Environment 中，模型如何看到它，用户如何批准它，以及扩展失败后由谁负责恢复。

本专题研究 MCP、Plugin、Skill、动态 Tool Registry 和 Capability Plane 在真实 Coding Agent 中的责任边界与演进方式。

核心问题包括：

- 扩展注册发生在启动时、Session 创建时、Turn 开始时，还是 Tool Call 期间；
- Tool schema、Skill instructions、Resource 和 Prompt 如何进入 Context；
- 扩展能力是否与普通内置 Tool 具有相同的权限；
- 扩展运行在 Agent 进程、子进程、远程服务还是独立 Sandbox；
- 扩展如何获得 Workspace、Network、Secret 和用户身份；
- 扩展版本、配置和状态如何持久化、恢复与失效；
- 扩展失败、超时、卸载和升级如何影响正在运行的 Turn；
- 动态能力变化如何影响 Context 一致性、Tool Call 合法性和 KV Cache；
- Capability Plane 是否已经成为独立的 Runtime 层。

## 文章计划

1. **[扩展模型：Tool、Skill、Plugin 与 MCP 的责任边界](01-extension-model-and-boundaries.md)**

   区分指令扩展、工具扩展、协议扩展和运行时扩展，建立统一生命周期模型。

2. **[动态能力如何进入 Runtime：注册、发现与 Context](02-registration-discovery-and-context.md)**

   研究 Tool Registry、schema、Skill instructions、Prompt 注入、Session/Turn/Step 边界，以及动态能力对模型请求和缓存的影响。

3. **[扩展的进程边界与 Environment 权限](03-process-boundary-and-environment.md)**

   研究本地 Plugin、MCP Server、子 Agent、远程 Connector 的进程和权限边界，重点分析 Workspace、Network、Secret 和审批如何传播。

4. **[扩展生命周期：版本、失败、恢复与卸载](04-extension-lifecycle-and-recovery.md)**

   研究扩展配置与 Runtime 状态的所有权、热更新、兼容性、失败收敛、取消和恢复。

5. **[Capability Plane：从工具注册到可治理能力](05-capability-plane.md)**

   综合比较各 Agent 是否形成独立的 Capability Plane，并分析它与 Policy、Approval、Environment、Observability 的关系。

专题已完成初步研究范围。后续如有新增源码证据，优先更新对应 Agent 的固定版本引用或补充实验记录，不再扩张为概念性文章。

## 研究方法

每篇文章都以固定版本源码为主要证据，回答四个问题：

1. 能力由谁创建、登记和撤销；
2. 能力在哪个进程和 Environment 中执行；
3. 能力如何进入模型可见的 Context；
4. 能力发生变化、失败或恢复时，哪些状态保持有效。

文档区分源码已确认的行为、基于实现的解释和需要运行实验才能确认的部署语义。不会把 MCP、Plugin、Skill 视为天然等价，也不会把 Tool schema 的动态变化直接等同于 KV Cache 必然失效。

## 重点分析对象

- Codex：Tool Registry、Policy、Connector、MCP 和 Environment 的组合；
- Pi：Extension、Tool preparation/execution hook 与轻量 Runtime 的关系；
- OpenCode：Plugin、Provider、Tool 和服务化 Workspace 的边界；
- Gemini CLI：Skill、MCP、Policy Engine 和动态 Context；
- Cline：Extension、MCP、Approval 与本地执行环境；
- Claude Code：Plugin、Skill、MCP 和第三方快照中的扩展机制；
- Kimi Code：Tool Policy、Connector、Subagent 和 Runtime Service；
- OpenHands：Agent skill、微服务、Remote Runtime 和 Connector；
- ADK Python：Tool、Plugin、Callback、Runner 和应用编排边界。
- DeepSeek Harness：Cordis 插件树、profile/bundle/preset、作用域注册和 capability seam。

## 当前限制

本专题首先研究扩展进入 Runtime 的机制，不把供应链安全、独立的安全专题和完整的可观测性专题重复展开。涉及权限传播时，引用 [Security / Trust Boundary](../09-security-trust-boundary/README.md)；涉及 Event、Trace 和 Evaluation 时，引用 [Observability / Evaluation](../11-observability-evaluation/README.md)。

项目补充：[DeepSeek Harness：一切皆插件与作用域化 Capability Plane](deepseek-harness.md)。
