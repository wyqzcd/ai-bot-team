#!/usr/bin/env node
/**
 * 混合信任评分引擎：评分 + 目录风险 + 任务类型 三合一放权判定。
 * 零依赖，Node >= 18，本地 PowerShell 与 GitHub Actions 通用。
 *
 * 用法：
 *   node scripts/trust-score.mjs score --files "docs/a.md,src/b.js" --type fix --ci success --verified true
 *   node scripts/trust-score.mjs score-pr 12 [--repo owner/repo] [--ci success] [--verified true] [--format markdown]
 *   node scripts/trust-score.mjs score --help
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, '..', 'config', 'trust.json');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

// ---------- 配置 ----------
function loadConfig(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- glob 匹配（** 跨目录，* 单段）----------
function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function dirRisk(file, directories) {
  // 首个匹配优先：具体条目放前面，兜底 ** 放最后
  for (const d of directories) {
    if (globToRegex(d.path).test(file)) return d.risk;
  }
  return 'high';
}

// ---------- 核心评分 ----------
function computeScore(evidence, cfg) {
  const reasons = [];
  let s = 60;

  const files = (evidence.files || []).map(f => String(f).trim()).filter(Boolean);
  const additions = Number(evidence.additions || 0);
  const deletions = Number(evidence.deletions || 0);

  // 1. CI
  const ciOk = ['success', 'green', 'pass', 'true', true].includes(evidence.ci);
  if (ciOk) { s += 15; reasons.push('CI 全绿 +15'); }
  else { s -= 40; reasons.push('CI 未通过或未知 -40'); }

  // 2. 验证报告（CI 复现验证）
  const verified = ['true', true, 'pass'].includes(evidence.verified);
  if (verified) { s += 10; reasons.push('验证报告通过 +10'); }
  else { s -= 10; reasons.push('缺少验证报告 -10'); }

  // 3. 任务类型
  const tt = (cfg.taskTypes || []).find(t => t.type === evidence.type)
    || { type: evidence.type || 'unknown', base: 0 };
  s += tt.base;
  if (tt.base !== 0) reasons.push(`任务类型 ${tt.type} ${tt.base >= 0 ? '+' : ''}${tt.base}`);

  // 4. 目录风险（取最高风险文件）
  const risks = files.map(f => dirRisk(f, cfg.directories || []));
  const worst = risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : 'low';
  const riskAdj = { low: 8, medium: -5, high: -15 }[worst];
  s += riskAdj;
  reasons.push(`目录风险 ${worst} ${riskAdj >= 0 ? '+' : ''}${riskAdj}`);

  // 5. 改动量
  const limits = cfg.limits || { maxFiles: {}, maxLines: {} };
  const maxFiles = (limits.maxFiles || {})[worst] ?? 99999;
  const maxLines = (limits.maxLines || {})[worst] ?? 999999;
  let sizeOk = true;
  if (files.length > maxFiles) {
    s -= 10; sizeOk = false;
    reasons.push(`文件数 ${files.length} 超出 ${worst} 风险上限 ${maxFiles} -10`);
  }
  if (additions + deletions > maxLines) {
    s -= 10; sizeOk = false;
    reasons.push(`改动行数 ${additions + deletions} 超出 ${worst} 风险上限 ${maxLines} -10`);
  }
  if (sizeOk) { s += 5; reasons.push('改动量在安全上限内 +5'); }

  // 6. 带测试
  const hasTest = files.some(f => /(^|\/)(test|tests|__tests__|spec)\//.test(f) || /\.(test|spec)\.[^.]+$/.test(f));
  if (hasTest) { s += 5; reasons.push('改动包含测试 +5'); }

  s = Math.max(0, Math.min(100, s));

  // 强制人工标签
  const labels = evidence.labels || [];
  const forced = labels.some(l => (cfg.blockedLabels || []).includes(l));
  if (forced) reasons.push('命中强制人工 review 标签（' + labels.filter(l => (cfg.blockedLabels || []).includes(l)).join(', ') + '）');

  // 信任等级
  let level = 0;
  for (const lv of [...(cfg.levels || [])].sort((a, b) => a.level - b.level)) {
    if (s >= lv.minScore) level = lv.level;
  }
  const rule = (cfg.levels || []).find(l => l.level === level)?.rule || '';

  // 决策（渐进放权阶梯）
  let decision = 'request_review';
  if (!forced) {
    if (level >= 1 && worst === 'low') decision = 'auto_merge';
    else if (level >= 2 && worst !== 'high' && ['docs', 'test', 'chore', 'fix'].includes(evidence.type)) decision = 'auto_merge';
    else if (level >= 3 && sizeOk) decision = 'auto_merge';
  }
  if (decision === 'auto_merge') {
    if (cfg.autoMergeEnabled !== true) { decision = 'dry_run'; reasons.push('autoMergeEnabled=false：仅演练，不真实合并'); }
    else if (cfg.dryRun === true) { decision = 'dry_run'; reasons.push('dryRun=true：仅演练，不真实合并'); }
  }

  return {
    score: s,
    level,
    decision,
    rule,
    reasons,
    dirRisk: worst,
    taskType: evidence.type || 'unknown',
    files: files.length,
    additions,
    deletions,
    hasTest,
    botAuthored: labels.some(l => (cfg.botLabels || []).includes(l))
  };
}

// ---------- 通过 gh 收集 PR 证据 ----------
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  } catch {
    return null;
  }
}

function collectPrEvidence(prNumber, repo) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const view = run('gh', ['pr', 'view', String(prNumber), ...repoArgs, '--json', 'files,additions,deletions,labels,title,author,headRefOid']);
  if (!view) throw new Error('无法获取 PR 信息：请确认 gh 已安装并登录（gh auth login），且 PR 存在。');
  const data = JSON.parse(view);

  const files = (data.files || []).map(f => f.path);
  const labels = (data.labels || []).map(l => l.name);

  // CI 状态：head commit 的 check-runs
  let ci = 'unknown';
  const apiArgs = repo ? [`repos/${repo}/commits/${data.headRefOid}/check-runs`] : [`repos/{owner}/{repo}/commits/${data.headRefOid}/check-runs`];
  const checks = run('gh', ['api', ...apiArgs, '--jq', '[.check_runs[] | {name, conclusion}]']);
  if (checks) {
    try {
      const list = JSON.parse(checks);
      if (list.length === 0) ci = 'unknown';
      else {
        const bad = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];
        ci = list.every(c => !bad.includes(c.conclusion) && c.conclusion !== null) ? 'success' : 'failure';
      }
    } catch { ci = 'unknown'; }
  }

  return { files, additions: data.additions || 0, deletions: data.deletions || 0, labels, title: data.title || '', author: (data.author || {}).login || 'unknown' };
}

// ---------- 输出 ----------
const DECISION_TEXT = {
  auto_merge: '自动合并',
  dry_run: '自动合并（演练，不真实合并）',
  request_review: '需人工 review'
};

function markdownReport(r) {
  const lines = [];
  lines.push('## 信任评分报告');
  lines.push('');
  lines.push('| 项目 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 评分 | ${r.score}/100 |`);
  lines.push(`| 信任等级 | L${r.level}：${r.rule} |`);
  lines.push(`| 决策 | ${DECISION_TEXT[r.decision] || r.decision} |`);
  lines.push(`| 目录风险 | ${r.dirRisk} |`);
  lines.push(`| 任务类型 | ${r.taskType} |`);
  lines.push(`| 改动 | ${r.files} 个文件，+${r.additions}/-${r.deletions} 行${r.hasTest ? '，含测试' : ''} |`);
  lines.push('');
  lines.push('**判定理由**');
  for (const reason of r.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('> 评分引擎：`node scripts/trust-score.mjs score-pr <PR号>` 可本地复核。配置见 `config/trust.json`。');
  return lines.join('\n');
}

// ---------- 主入口 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const configPath = args.config || DEFAULT_CONFIG;

  if (!existsSync(configPath)) {
    console.error(`找不到配置文件：${configPath}`);
    process.exit(2);
  }
  const cfg = loadConfig(configPath);

  if (cmd === 'score') {
    const evidence = {
      files: String(args.files || '').split(','),
      additions: args.additions,
      deletions: args.deletions,
      type: args.type || 'unknown',
      ci: args.ci || 'unknown',
      verified: args.verified || false,
      labels: String(args.labels || '').split(',').filter(Boolean)
    };
    const r = computeScore(evidence, cfg);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'score-pr') {
    const prNumber = args._[1];
    if (!prNumber) { console.error('用法：node scripts/trust-score.mjs score-pr <PR号> [--repo owner/repo] [--format markdown]'); process.exit(2); }
    const ev = collectPrEvidence(prNumber, args.repo);
    ev.type = args.type || classifyType(ev.title, cfg);
    if (args.ci) ev.ci = args.ci;
    if (args.verified !== undefined) ev.verified = args.verified;
    else ev.verified = existsSync(path.join(__dirname, '..', 'config', 'verification', `pr-${prNumber}.json`));

    const r = computeScore(ev, cfg);
    r.pr = prNumber;
    r.author = ev.author;
    if (args.format === 'markdown') console.log(markdownReport(r));
    else console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log([
    '用法：',
    '  node scripts/trust-score.mjs score --files "docs/a.md,src/b.js" --type fix --ci success --verified true',
    '  node scripts/trust-score.mjs score-pr 12 [--repo owner/repo] [--format markdown]',
    '  node scripts/trust-score.mjs score-pr 12 --labels "bot-review-needed"'
  ].join('\n'));
}

// 从 PR 标题猜任务类型（依赖 config/routing.json 的 hints）
function classifyType(title, cfg) {
  const routingPath = path.join(__dirname, '..', 'config', 'routing.json');
  if (!existsSync(routingPath)) return 'unknown';
  const routing = JSON.parse(readFileSync(routingPath, 'utf8'));
  const hints = routing.classificationHints || [];
  const lower = title.toLowerCase();
  // conventional commits 前缀优先
  const m = lower.match(/^(feat|fix|test|docs|chore|refactor|perf)[(:]/);
  if (m) return m[1] === 'perf' ? 'feat' : m[1];
  for (const h of hints) {
    if (new RegExp(h.pattern, 'i').test(title)) return h.type;
  }
  return 'unknown';
}

main();
