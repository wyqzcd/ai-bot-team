/**
 * 滚动前推（walk-forward）：每个联赛、每个比赛日，用"当天 00:00 UTC 之前"的全部已完赛比赛重新拟合，
 * 再预测当天所有场次。预测时点 = 当天 00:00 UTC，必然早于开赛。
 */
import { DEFAULT_PARAMS, fitPoisson, lambdas, scoreMatrix, summarizeMatrix } from './poisson.mjs';

export const MODEL_NAME = 'dc-poisson';
export const MODEL_VERSION = '1.0.0';

export function predictMatch(model, match) {
  const lam = lambdas(model, match.home, match.away);
  const summary = summarizeMatrix(scoreMatrix(lam.home, lam.away, model.rho, model.params.maxGoals));
  return { lam, ...summary };
}

/** @returns {Array<{match, asOf, pred}>} 每场一条；样本不足的比赛日跳过并计数 */
export function walkForward(matches, { from, to, params = DEFAULT_PARAMS, leagues } = {}) {
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
      const model = fitPoisson(list, asOf, params);
      const todays = list.filter((m) => m.date === date);
      if (!model.ok) {
        skipped.push({ league, date, reason: model.reason, count: todays.length });
        continue;
      }
      for (const match of todays) out.push({ match, asOf, model, pred: predictMatch(model, match) });
    }
  }
  out.sort((a, b) => (a.match.kickoff < b.match.kickoff ? -1 : a.match.kickoff > b.match.kickoff ? 1 : a.match.id < b.match.id ? -1 : 1));
  return { predictions: out, skipped };
}
