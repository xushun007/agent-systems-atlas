# Claude Code Runtime / Harness 架构演进索引

> 本文记录架构判断如何随上游源码演进。版本化快照不可被下一次分析覆盖；无架构变化的复核也应留下记录。

## 版本

| Review date | Snapshot | Upstream commit | Change level | 主要变化 | 文档 | 图 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-18 | `2026-09-18.6e2f79c` | `6e2f79c5b97ae619172a3e621e87dd0edb220619` | baseline | 建立 QueryEngine、queryLoop、Task、权限/环境与持久化的总体架构基线 | [快照](claude-code-runtime-architecture-2026-09-18-6e2f79c.md) | [图](../diagrams/claude-code-runtime-architecture-2026-09-18-6e2f79c.excalidraw) |

## 2026-09-18 · `6e2f79c`

### 变化

- 首次建立版本化 Runtime / Harness 架构快照。
- 明确区分 conversation、user turn、query-loop iteration 与后台 task 四种生命周期。
- 将 session transcript、file history、task output 与远程控制面分别表达，避免合并成单一“状态存储”。

### 保持不变

- 这是首个基线快照，没有上一版本可比较。

### 验证范围

- 已阅读 `QueryEngine`、`queryLoop`、Tool/Permission、Task、session storage、file history、model client、headless/SDK 与 remote bridge 相关实现。
- 仓库快照中未发现测试文件，因此没有可读取的上游测试证据。
- 未执行 Bun/TypeScript runtime 或端到端实验。
- 上游是第三方公开的泄漏源码备份，其来源完整性和与正式 Claude Code 版本的对应关系未确认。
