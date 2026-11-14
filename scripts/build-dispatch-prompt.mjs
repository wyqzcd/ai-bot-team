#!/usr/bin/env node
/**
 * CI 派活提示词构建：把 issue/手动输入 + 路由配置拼成首席 Bot 的提示词。
 * 供 .github/workflows/bot-dispatch.yml 调用，输出到 stdout 后交给 claude -p。
 * 环境变量：TASK（任务标题）、TASK_BODY（任务描述）、DRY_RUN（true 只出计划）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routing = JSON.parse(readFileSync(path.join(__dirname, '..', 'config', 'routing.json'), 'utf8'));
const trust = JSON.parse(readFileSync(path.join(__dirname, '..', 'config', 'trust.json'), 'utf8'));

const task = (process.env.TASK || '').trim();
const body = (process.env.TASK_BODY || '').trim();
const dryRun = process.env.DRY_RUN === 'true';
const issueNumber = process.env.ISSUE_NUMBER || '';

const routesTable = routing.routes
  .map(r => `- ${r.type} → 子代理 [${r.agents.join(', ')}]，pstack playbook: ${r.playbook}`)
  .join('\n');

const prompt = `你是本仓库的首席 Bot（Chief of Staff），运行在 GitHub Actions 的无头环境里。
任务来源：${task}
任务描述：
${body || '（无补充描述，按标题自行理解）'}

路由配置（config/routing.json）：
${routesTable}

目录风险配置（config/trust.json）：${JSON.stringify(trust.directories)}

执行模式：${dryRun ? 'DRY RUN（只做计划，不写代码不开 PR）' : '完整执行（实现 + 验证 + 开 PR）'}

流程：
1. 收集上下文：读仓库结构与相关代码（Read/Grep/Glob），读 config/routing.json 与 config/trust.json。
2. 分类任务：按 classificationHints 判定类型（fix/feat/test/docs/chore/refactor）。
3. 派活：按路由表顺序用 Task 派子代理（pm → engineer → qa，需要 reviewer 的再派 reviewer）。
   - 子代理定义在 .claude/agents/ 下；engineer 会按 pstack 纪律干活，qa 会把验证报告写入 config/verification/。
4. ${dryRun
    ? `DRY RUN：把计划（分类结论、规格摘要、验证方案、预估评分）写成 Markdown 文件 plan.md，不要改代码。${issueNumber ? `若环境变量 ISSUE_NUMBER=${issueNumber} 存在，用 gh issue comment ${issueNumber} --body-file plan.md 把计划评论到该 issue。` : '任务不来自 issue，计划保留在 CI 日志即可。'}`
    : '开 PR：git 提交（conventional commits）→ push 分支 → gh pr create（标题 conventional commits，正文含做了什么/为什么/怎么验证/已知限制，加标签 bot-authored）→ 用 gh pr comment 汇报验证结论。'}
5. 最后输出：任务分类、子代理编排、验证结论、PR 链接${dryRun ? '' : '、预估信任评分'}。

纪律：不跳过 qa；不在主干堆细节；验证不了就说验证不了。`;

console.log(prompt);
