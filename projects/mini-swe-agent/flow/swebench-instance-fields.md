# SWE-Bench instance 字段解析

以 `princeton-nlp/SWE-Bench_Verified` 第一条数据为例：

```python
from datasets import load_dataset
ds = load_dataset("princeton-nlp/SWE-Bench_Verified", split="test")
inst = ds[0]
```

## 各字段含义

| 字段 | 示例值 | 说明 |
|------|--------|------|
| `repo` | `astropy/astropy` | GitHub 仓库，也是 bug 所在的项目 |
| `instance_id` | `astropy__astropy-12907` | 唯一标识。格式为 `<org>__<repo>-<pr_number>`，其中 `__` 分隔 org 和 repo，后面的数字通常是 PR 编号 |
| `base_commit` | `d16bfe05a7...` | 需要修复的基准 commit。也就是 bug 还没修复时的代码状态 |
| `patch` | diff 内容 | 正确的修复 patch。运行时 agent 看不到，评测时用来对比 |
| `test_patch` | diff 内容 | 测试代码的 patch（比如新增的测试用例），评测时会先 apply 到代码上 |
| `problem_statement` | issue 描述 | 传给 agent 的任务描述。例如 "Modeling's `separability_matrix` does not compute separability correctly..." |
| `hints_text` | 空字符串 | 有时候会给一些提示，这里没有 |
| `created_at` | `2022-03-03T15:14:54Z` | issue/PR 创建时间 |
| `version` | `4.3` | 仓库版本（不是很严格，仅供参考） |
| `FAIL_TO_PASS` | 列表 | 修复前失败、修复后应该通过的测试用例 |
| `PASS_TO_PASS` | 列表 | 修复前就通过、修复后也应该保持通过的测试用例 |
| `environment_setup_commit` | `298ccb478e...` | 用于构建 Docker 镜像环境的 commit |
| `difficulty` | `15 min - 1 hour` | 人类修复该 issue 大约需要的时间 |

## 关键字段之间的关系

```
problem_statement  ->  agent 的输入（agent 看到的内容）
base_commit        ->  起点 commit，Docker 镜像里的代码就在这个状态
patch              ->  标准答案，评测时才用
FAIL_TO_PASS       ->  评分标准：这些测试从失败变成通过，算修复成功
PASS_TO_PASS       ->  评分标准：这些测试不能被破坏
```

## 评测时的流程

1. 检出 `repo` 对应的代码
2. checkout 到 `base_commit`
3. apply agent 提交的 patch
4. apply `test_patch` 新增测试
5. 运行 `FAIL_TO_PASS` 和 `PASS_TO_PASS` 中的测试
6. 全部通过则认为修复成功
