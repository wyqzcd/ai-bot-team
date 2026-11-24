/**
 * 发布页渲染（零依赖静态 HTML）。原则：
 * - 只把 active 规则当结论展示，每个数字旁边必须同时给出 n、覆盖率、同样本基线。
 * - 候选规则单列且明确"不作结论"；撤回规则与实盘撤回单列留痕，不得省略。
 */
import path from 'node:path';
import { LEAGUES } from './dataset.mjs';
import { foldLedger } from './ledger.mjs';
import { computeStats, coverageCurve, review } from './metrics.mjs';
import { effectiveStatus } from './rules.mjs';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`);
const PICK_LABEL = { h: '主胜', d: '平', a: '客胜' };
const CAUSE_LABEL = {
  draw_blind: '平局盲区（赛果平、模型未选平）',
  market_upset: '同向爆冷（模型与市场同向且都错）',
  model_contrary: '模型逆市场且错（优先排查）',
  both_contrary: '模型逆市场，两者都错',
  no_market: '无赔率，无法对照',
};

function table(head, rows) {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="muted">（无）</td></tr>`
  }</tbody></table>`;
}

export function renderReport({ generatedAt, gates, registry, ledgers, model, jczqRefs = {} }) {
  const byLabel = Object.fromEntries(ledgers.map((l) => [l.label, l.entries]));
  const backtest = ledgers.find((l) => l.role === 'backtest')?.entries ?? null;
  const rules = registry.rules.map((rule) => ({ rule, status: effectiveStatus(rule) }));
  const active = rules.filter((r) => r.status === 'active');
  const ruleRows = active.map(({ rule }) => {
    const gate = gates.gates.find((g) => g.id === 'G7');
    const recomputed = gate.rules.find((r) => r.id === rule.id);
    const stats = computeStats(byLabel[path.basename(rule.sample.ledger, '.jsonl')] ?? [], rule.sample.filter);
    return [
      `<b>${esc(rule.id)}</b><br><span class="muted">${esc(rule.title)}</span>`,
      `<b>${pct(recomputed?.rate)}</b>`,
      esc(recomputed?.n),
      pct(stats.coverage),
      rule.claim.metric === 'direction_hit' ? pct(stats.baselines.market_fav.rate) : '<span class="muted">—（基线只对方向）</span>',
      rule.claim.metric === 'direction_hit' ? pct(stats.baselines.always_home.rate) : '<span class="muted">—</span>',
      `<code>${esc(rule.recompute)}</code>`,
    ];
  });

  // 高置信档口径只从登记表的 active 规则读，不在这里硬编码阈值。
  const backtestLabel = ledgers.find((l) => l.role === 'backtest')?.label;
  const tiers = active.filter(({ rule }) => rule.tier === 'high-confidence').map(({ rule }) => rule);
  const highTier = tiers.find((rule) => path.basename(rule.sample.ledger, '.jsonl') === backtestLabel) ?? tiers.at(-1) ?? null;
  const holdoutFrom = highTier?.sample.filter.from ?? '2024-07-01';
  const curve = backtest ? coverageCurve(backtest, { mode: 'backtest', from: holdoutFrom }) : [];
  const live = ledgers.find((l) => l.role === 'live')?.entries ?? [];
  const liveFold = foldLedger(live);
  const ucl = foldLedger(ledgers.find((l) => l.role === 'candidate')?.entries ?? []).filter((x) => x.prediction).sort((a, b) => (a.prediction.kickoff < b.prediction.kickoff ? -1 : a.prediction.kickoff > b.prediction.kickoff ? 1 : a.id < b.id ? -1 : 1));
  const upcoming = liveFold.filter((x) => x.prediction && !x.result).sort((a, b) => (a.prediction.kickoff < b.prediction.kickoff ? -1 : 1));
  const liveStats = computeStats(live, { mode: 'live' });
  const liveReview = review(live, { mode: 'live' });
  const recentReview = backtest && highTier ? review(backtest, highTier.sample.filter) : null;
  const liveRetractions = live.filter((e) => e.type === 'retraction');
  const retractedRules = rules.filter((r) => r.status === 'retracted');
  const candidates = rules.filter((r) => r.status === 'candidate');

  const gateList = gates.gates.map((g) => `<li class="${g.ok ? 'ok' : 'bad'}">${g.ok ? '✔' : '✘'} ${esc(g.id)} ${esc(g.name)}${g.warnings.length ? ` <span class="muted">（${g.warnings.length} 条提示）</span>` : ''}</li>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>足球泊松台账</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#6b6a65; --line:#e3e1da; --card:#ffffff; --ok:#2f7a4a; --bad:#b3402e; --accent:#2c5d8f; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ecebe6; --muted:#9d9b94; --line:#2f2e2b; --card:#1d1d1b; --ok:#6cc08b; --bad:#e8836f; --accent:#8ab8e6; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
main { max-width:1040px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:18px; margin:32px 0 8px; border-bottom:1px solid var(--line); padding-bottom:6px; }
.muted { color:var(--muted); font-size:13px; } .ok { color:var(--ok); } .bad { color:var(--bad); }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin:12px 0; }
.scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; white-space:nowrap; }
code { font-size:12px; word-break:break-all; color:var(--accent); } ul.gates { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:6px 18px; margin:0; }
</style>
</head>
<body><main>
<h1>足球泊松台账 · 发布页</h1>
<div class="muted">生成于 ${esc(generatedAt)} · 模型 ${esc(model)} · 五大联赛（${Object.values(LEAGUES).join(' / ')}）</div>

<div class="card"><b>7 道机械门禁</b>：${gates.ok ? '<span class="ok">全部通过</span>' : '<span class="bad">未通过</span>'}<ul class="gates">${gateList}</ul></div>

<div class="card"><b>怎么读这些数字</b>：方向 = 胜/平/负三选一。每个命中率都必须和<b>样本量 n、覆盖率、同样本的市场热门命中</b>一起看。
五大联赛赛前赔率热门全样本只命中约 53.6%；任何高于此的数字都只是"挑了更一边倒的比赛"，覆盖率会相应下降。</div>

<h2>已登记结论（active 规则，现场复算）</h2>
<div class="scroll">${table(['规则', '复算命中', 'n', '覆盖率', '同样本·市场热门', '同样本·永远主胜', '复算命令'], ruleRows)}</div>

<h2>置信度-覆盖率曲线（留出段 ${esc(holdoutFrom)} 起）</h2>
<div class="scroll">${table(['conf ≥', 'n', '覆盖率', '模型方向命中', '同样本·市场热门'], curve.map((c) => [c.minConf.toFixed(2), c.n, pct(c.coverage), pct(c.direction), pct(c.market_fav_same_sample)]))}</div>

<h2>实盘：待开赛预测（开赛即锁定）</h2>
<div class="scroll">${table(['竞彩', '开赛 (北京时间)', '联赛', '对阵', '方向', 'conf', '高置信档', '胜/平/负', 'λ', '比分 TOP3', '#'], upcoming.map(({ prediction: p }) => {
    const ref = jczqRefs[p.id];
    const kickoff08 = new Date(Date.parse(p.kickoff) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    const high = highTier && p.conf >= highTier.sample.filter.minConf;
    return [
      ref ? esc(ref.no) : '<span class="muted">—</span>', esc(kickoff08), esc(LEAGUES[p.league] ?? p.league),
      ref ? `${esc(ref.home)} vs ${esc(ref.away)}<br><span class="muted">${esc(p.home)} vs ${esc(p.away)}</span>` : `${esc(p.home)} vs ${esc(p.away)}`,
      PICK_LABEL[p.pick], pct(p.conf), high ? `<b>是</b>（≥ ${highTier.sample.filter.minConf}）` : '<span class="muted">否</span>',
      p.probs.map(pct).join(' / '), p.lam.join(' / '), p.top3.map((s) => esc(s[0])).join(', '), p.seq,
    ];
  }))}</div>

<h2>候选：欧冠方向（不作结论）</h2>
<div class="card muted">Elo 泊松模型（R-012/R-013 在五大联赛联赛内校准），没有任何欧冠样本回测；Elo 快照约 3 个月前，伤停首发未进模型。只作为候选记录（R-014），开赛即锁定。</div>
<div class="scroll">${table(['开赛 (北京时间)', '对阵', '方向', 'conf', '胜/平/负', 'λ', '赛果', '#'], ucl.map(({ prediction: p, result: r }) => [
    esc(new Date(Date.parse(p.kickoff) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')), `${esc(p.home)} vs ${esc(p.away)}`, PICK_LABEL[p.pick], pct(p.conf),
    p.probs.map(pct).join(' / '), p.lam.join(' / '), r ? `${r.ft[0]}-${r.ft[1]}` : '<span class="muted">未赛</span>', p.seq,
  ]))}</div>

<h2>实盘战绩</h2>
<div class="card">已结算 ${liveStats.n} 场 · 方向命中 ${pct(liveStats.direction_hit.rate)} · 同样本市场热门 ${pct(liveStats.baselines.market_fav.rate)}（n=${liveStats.baselines.market_fav.n}） · 比分 TOP3 ${pct(liveStats.score_top3_hit.rate)}
${liveStats.n < 200 ? '<br><span class="muted">实盘样本 &lt; 200，命中率波动很大，只作记录，不作结论（见候选规则 R-004）。</span>' : ''}</div>

<h2>赛后归因（机械分类）</h2>
<div class="scroll">${table(['原因', '实盘', `回测高置信档（${highTier ? esc(highTier.id) : '—'}）`], Object.keys(CAUSE_LABEL).map((k) => [esc(CAUSE_LABEL[k]), liveReview.buckets[k] ?? 0, recentReview?.buckets[k] ?? 0]))}</div>

<h2>撤回留痕</h2>
<div class="scroll">${table(['对象', '撤回日期', '原因'], [
    ...retractedRules.map(({ rule }) => [`规则 ${esc(rule.id)}：${esc(rule.title)}`, esc(rule.retraction?.date), esc(rule.retraction?.reason)]),
    ...liveRetractions.map((e) => [`实盘预测 #${e.target}（${esc(e.id)}）`, esc(e.createdAt), esc(e.reason)]),
  ])}</div>

<h2>候选规则（不作结论）</h2>
<div class="scroll">${table(['规则', '缺什么', '说明'], candidates.map(({ rule }) => [`${esc(rule.id)} ${esc(rule.title)}`, rule.claim ? '' : '可复算的 claim', esc(rule.note ?? '')]))}</div>

<p class="muted">数据：football-data.co.uk 口径的公开赛果与赛前赔率（经 xgabora/Club-Football-Match-Data-2000-2025 汇编）。赔率只用于对照基线，不进模型。本页仅为统计方法演示，不构成任何投注建议。</p>
</main></body>
</html>
`;
}
