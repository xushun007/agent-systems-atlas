# Agent Systems Atlas

开源 Agent 系统的源码分析知识库，记录架构、运行机制、跨项目比较和可复现实验。上游源码位于本仓库旁的独立 Git 仓库；研究成果保存在这里。

## 浏览内容

| 目录 | 内容 |
| --- | --- |
| [projects/](projects/) | 单个项目的实现分析与架构快照 |
| [patterns/](patterns/) | 有多个项目证据支持的共性机制 |
| [comparisons/](comparisons/) | 围绕具体问题的横向比较 |
| [experiments/](experiments/) | 运行验证、步骤与观察记录 |
| [concepts/](concepts/) | 概念与术语 |
| [templates/](templates/) | 分析、实验与架构文档模板 |

已收录：[Codex](projects/codex/README.md) · [Pi](projects/pi/README.md) · [Gemini CLI](projects/gemini-cli/README.md) · [OpenCode](projects/opencode/README.md) · [OpenHands](projects/openhands/README.md) · [Cline](projects/cline/README.md) · [Claude Code](projects/claude-code/README.md) · [Hermes Agent](projects/hermes-agent/README.md) · [Kimi Code](projects/kimi-code/README.md) · [Google ADK](projects/adk-python/README.md) · [Navi Agent](projects/navi-agent/README.md) · [mini-SWE-agent](projects/mini-swe-agent/README.md)。

## 开始使用

用 VS Code 同时打开 Atlas 与相邻的源码仓库：

```bash
code agent-research.code-workspace
```

新增项目后，在 `projects/<项目名>/project.yaml` 记录上游仓库和准确 commit，再使用[分析模板](templates/analysis.md)开展研究：

```bash
./scripts/add-project.sh <项目名> <仓库地址> <commit>
```

需要从源码目录进入对应笔记时，可运行 `./scripts/link-project.sh <项目名> ../<源码目录>`。实验请使用[实验模板](templates/experiment.md)记录环境、步骤、观察和未确认事项。

研究结论应附固定 commit 的源码位置，并区分源码事实、解释与运行观察。完整的工作规范和架构图要求见 [AGENTS.md](AGENTS.md)（[中文版](AGENTS-zh.md)）。
