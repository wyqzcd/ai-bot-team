/**
 * 模型 = 进球评分与射正评分的混合（1.1.0 起）：
 *   λ = w · λ_进球 + (1 − w) · λ_射正 · 转化率
 * - λ_进球：fitPoisson 在赛果上拟合（含 Dixon-Coles ρ）。
 * - λ_射正：同一套拟合跑在射正数上（射正比进球稳定，运气成分小）；转化率 = 窗口内加权进球 / 加权射正，主客分开。
 * - w（goalWeight）只在训练段（开赛 < 2024-07-01）选出，见 football/README.md 的实验记录。
 * 没有射正数据的比赛（例如实盘只录了比分的场次）只参与进球评分。
 *
 * 滚动前推（walk-forward）：每个联赛、每个比赛日，用"当天 00:00 UTC 之前"的已完赛比赛重新拟合，
 * 再预测当天所有场次。预测时点 = 当天 00:00 UTC，必然早于开赛。
 */
import { DEFAULT_PARAMS, fitPoisson, lambdas, scoreMatrix, summarizeMatrix } from './poisson.mjs';

export const MODEL_NAME = 'dc-poisson-sot';
export const MODEL_VERSION = '1.1.0';
export const DEFAULT_GOAL_WEIGHT = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {{ ok, reason?, goals, shots, conversion: {h, a}, goalWeight, params, attack: Map }}
 *   attack 暴露进球模型的球队集合，供"模型是否见过这支球队"的检查使用。
 */
export function fitModel(history, asOf, params = DEFAULT_PARAMS, goalWeight = DEFAULT_GOAL_WEIGHT) {
  const goals = fitPoisson(history, asOf, params);
  if (!goals.ok) return goals;
  const result = { ok: true, goals, shots: null, conversion: null, goalWeight: 1, params, attack: goals.attack, rho: goals.rho, n: goals.n };
  if (goalWeight >= 1) return result;

  const shotHistory = history.filter((m) => m.sot).map((m) => ({ ...m, ft: m.sot }));
  const shots = fitPoisson(shotHistory, asOf, { ...params, rhoGrid: [0] });
  if (!shots.ok) return result; // 射正样本不足时退化为纯进球模型

  const asOfMs = Date.parse(asOf);
  let gh = 0;
  let ga = 0;
  let sh = 0;
  let sa = 0;
  for (const m of history) {
    if (!m.ft || !m.sot) continue;
    const t = Date.parse(m.kickoff);
    if (!(t < asOfMs) || t < asOfMs - params.windowDays * DAY_MS) continue;
    const w = Math.exp((-Math.LN2 * ((asOfMs - t) / DAY_MS)) / params.halfLifeDays);
    gh += w * m.ft.h;
    ga += w * m.ft.a;
    sh += w * m.sot.h;
    sa += w * m.sot.a;
  }
  if (!(sh > 0 && sa > 0)) return result;
  return { ...result, shots, conversion: { h: gh / sh, a: ga / sa }, goalWeight };
}

export function blendedLambdas(model, home, away) {
  const g = lambdas(model.goals, home, away);
  if (!model.shots) return g;
  const s = lambdas(model.shots, home, away);
  const w = model.goalWeight;
  return {
    home: w * g.home + (1 - w) * s.home * model.conversion.h,
    away: w * g.away + (1 - w) * s.away * model.conversion.a,
    known: g.known,
  };
}

export function predictMatch(model, match) {
  const lam = blendedLambdas(model, match.home, match.away);
  const summary = summarizeMatrix(scoreMatrix(lam.home, lam.away, model.rho, model.params.maxGoals));
  return { lam, ...summary };
}

/** @returns {{ predictions: Array<{match, asOf, pred}>, skipped }} 样本不足的比赛日跳过并计数 */
export function walkForward(matches, { from, to, params = DEFAULT_PARAMS, goalWeight = DEFAULT_GOAL_WEIGHT, leagues } = {}) {
  const byLeague = new Map();
  for (const match of matches) {
    if (leagues && !leagues.includes(match.league)) continue;
    if (!byLeague.has(match.league)) byLeague.set(match.league, []);
    byLeague.get(match.league).push(match);
  }
  const out = [];
  const skipped = [];
  for (const [league, list] of [...byLeague.entries()].sort()) {
    const dates = [...new Set(list.map((m) => m.date))].filter((d) => (!from || d >= from) && (!to || d <= to)).sort();
    for (const date of dates) {
      const asOf = `${date}T00:00:00Z`;
      const model = fitModel(list, asOf, params, goalWeight);
      const todays = list.filter((m) => m.date === date);
      if (!model.ok) {
        skipped.push({ league, date, reason: model.reason, count: todays.length });
        continue;
      }
      for (const match of todays) out.push({ match, asOf, pred: predictMatch(model, match) });
    }
  }
  out.sort((a, b) => (a.match.kickoff < b.match.kickoff ? -1 : a.match.kickoff > b.match.kickoff ? 1 : a.match.id < b.match.id ? -1 : 1));
  return { predictions: out, skipped };
}
