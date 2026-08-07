# Agent Systems Atlas

开源 Agent 系统架构与实现机制研究库。

本仓库用于长期沉淀源码分析、架构设计、运行机制、横向比较和实验记录。它不是源码集合，也不承载上游项目的开发工作；它是独立于各个源码仓库的知识库。

## 为什么建立这个仓库

直接把 `notes/` 放在被分析的源码仓库中存在两个问题：

- 笔记通常是未跟踪文件，可能被清理工作区等操作误删；
- 笔记可能被意外加入上游项目的提交。

本仓库通过物理隔离解决这两个问题：源码留在各自的 Git 仓库中，所有研究成果统一保存在 Atlas，并单独提交和备份。

## 本地布局

当前各仓库位于同一个父目录，无需额外建立 `sources/`：

```text
<workspace>/agent/
├── agent-systems-atlas/   # 研究成果的唯一真实来源
├── kimi-code/             # 独立的上游源码仓库
├── codex/                 # 独立的上游源码仓库
├── hermes-agent/          # 独立的上游源码仓库
├── OpenHands/             # 独立的上游源码仓库
└── ...
```

这些项目是彼此独立的 Git 仓库，因此整体组织方式不是 Git Worktree。Worktree 只适合管理同一个源码仓库的多个版本或隔离实验环境。

## 仓库结构

```text
agent-systems-atlas/
├── projects/       # 单个开源项目的源码分析
├── patterns/       # 多个项目共同呈现的架构模式
├── comparisons/    # 围绕具体机制的横向比较
├── experiments/    # 可复现的运行验证和实验产物
├── concepts/       # Agent 相关概念与术语
├── templates/      # 分析文档和实验记录模板
├── assets/         # 跨文档共享的附件
└── scripts/        # 项目初始化和本地链接工具
```

不同目录回答不同层次的问题：

- `projects/`：某个项目具体如何实现。
- `patterns/`：多个项目背后有哪些共同规律。
- `comparisons/`：不同项目如何解决同一个明确问题。
- `experiments/`：代码在真实运行时表现如何。

## 已收录项目

| 项目 | 当前内容 |
| --- | --- |
| [Kimi Code](projects/kimi-code/README.md) | 核心架构、执行循环、与 Hermes Agent 和 OpenCode 的对比 |
| [Codex](projects/codex/README.md) | 项目全局架构、Runtime 执行链、工具系统与安全边界 |
| [Google ADK](projects/adk-python/README.md) | 整体架构、代码执行、Runner、Session 存储 |
| [mini-SWE-agent](projects/mini-swe-agent/README.md) | SWE-Bench 处理流程、用例与字段分析 |
| [Pi](projects/pi/README.md) | Agent Runtime 分析 |

每个项目通过 `project.yaml` 记录上游仓库地址、已分析的 commit 和复查日期，避免源码更新后分析结论失去版本上下文。

## 研究原则

1. 源码仓库只用于阅读、运行和隔离实验。
2. Markdown、架构图和实验记录只保存在 Atlas。
3. 重要结论应标注源码入口、核心实现和相关测试。
4. 明确区分代码事实、个人解释、实验观察和未确认事项。
5. 跨项目模式至少由两个具体实现或实验支持。
6. 横向比较围绕具体问题展开，避免宽泛的“项目 A 对比项目 B”。

适合横向研究的问题包括：

- Agent Loop 如何推进和终止；
- 工具如何注册、暴露、审批和执行；
- 上下文如何构建、压缩与恢复；
- Session 和事件如何持久化；
- 工作空间如何隔离；
- Agent 如何验证任务已经完成。

## 架构图规范

新增或大幅修改的架构图必须使用 `excalidraw-diagram-generator` skill 构建，并提交可继续编辑的 `.excalidraw` 源文件。

- 项目专属图放在 `projects/<project>/diagrams/`。
- 跨项目图放在对应的 `patterns/` 或 `comparisons/` 主题目录下。
- 文件名采用描述性的 kebab-case，例如 `agent-loop-runtime.excalidraw`。
- Markdown 文档必须链接对应的 `.excalidraw` 文件。
- PNG 或 SVG 可以作为预览，但不能替代 `.excalidraw` 源文件。
- Mermaid、截图和位图不能作为正式架构图源文件的替代品。

完整的 Agent 工作约束见 [AGENTS.md](AGENTS.md)，工作机制的中文说明见 [AGENTS-zh.md](AGENTS-zh.md)。

## 开始使用

### 同时打开 Atlas 和源码

仓库提供了 VS Code 多根工作区：

```bash
code agent-research.code-workspace
```

在一个窗口中即可阅读源码仓库，并在 Atlas 中编辑对应的分析文档。

### 新增分析项目

```bash
./scripts/add-project.sh <项目名> <仓库地址> <commit>
```

例如：

```bash
./scripts/add-project.sh codex https://github.com/openai/codex.git <commit>
```

创建后应检查 `projects/<项目名>/project.yaml`，并按照 [分析模板](templates/analysis.md) 记录问题、结论、机制、源码映射和未确认事项。

### 创建源码侧快捷入口

如需从源码目录快速进入 Atlas，可选择创建 `.analysis` 软链接：

```bash
./scripts/link-project.sh <项目名> ../<源码目录>
```

脚本会：

1. 创建指向 `projects/<项目名>` 的 `.analysis` 软链接；
2. 将 `.analysis` 写入源码仓库本地的 `.git/info/exclude`；
3. 保持上游 `.gitignore` 不变。

软链接只是访问入口，笔记的真实文件仍在 Atlas 中。

### 记录实验

实验应从 [实验模板](templates/experiment.md) 开始，并至少记录：

- 要验证的问题；
- 上游仓库和准确 commit；
- 环境与配置；
- 可复现步骤；
- 实际观察；
- 结论和未确认事项。

源码阅读只能说明“代码看起来如何工作”，实验用于验证“它实际如何工作”。

## 防丢失策略

物理隔离可以防止笔记进入上游提交，但不能替代版本控制和备份。完成或阶段性完成分析后，应及时：

```bash
git add <相关文件>
git commit -m "docs: add <topic> analysis"
git push
```

只有当研究成果进入 Git 历史并推送到远端后，才能同时抵御误删、工作区清理和本地磁盘故障。
