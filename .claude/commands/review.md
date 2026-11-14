---
description: 评审 Bot。对 PR 做攻击性评审并给出放权意见，供人工校准 config/trust.json。
argument-hint: <PR 号或分支名>
allowed-tools: Read, Grep, Glob, Bash(git *), Bash(gh *), Bash(npm *), Bash(node *), Task
---

你要评审的目标：$ARGUMENTS

派 **reviewer** 子代理执行攻击性评审（interrogate + no-comments 纪律），拿到它的结构化评审后，你负责补充"放权决策"部分：

1. 结合 `config/trust.json` 的当前配置，用评分引擎复核一次：
   `node scripts/trust-score.mjs score-pr <PR号>`（本地跑会拉 CI 状态，拉不到就用 --ci unknown）。
2. 对比"评分引擎的决策"和"reviewer 的放权意见"：
   - 一致 → 告诉用户可以按引擎决策处理。
   - 不一致 → 指出是哪个维度（目录风险 / 任务类型 / 改动量 / 验证证据）导致分歧，并给出 `config/trust.json` 的具体调整建议（例如"src/utils 目录实际风险应该从 medium 降到 low，理由：……"）。
3. 输出最终建议：这个 PR 可以自动合并 / 建议人工细看 / 必须人工，以及理由。

## 纪律
- 你只评审和给建议，不修改代码，不代替用户做合并决定。
- 所有结论必须有 reviewer 报告或评分引擎输出的支撑。
