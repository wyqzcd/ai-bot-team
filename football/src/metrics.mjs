/**
 * 复算口：所有命中率都从台账现算，不读任何缓存数字。
 *
 * 命中定义（登记在 rules/registry.json 的 metric 字段里引用）：
 *   direction_hit  方向（胜/平/负三选一）：pick 与赛果方向一致。
 *   score_top3_hit 比分：真实比分落在模型概率前三的比分里。
 *   totals_hit     总进球档位（0-1 / 2-3 / 4+ 三选一）：概率最大档与真实总进球一致。
 *   over25_hit     大小 2.5：P(总进球≥3) ≥ 0.5 判大，否则判小。
 *
 * 每次复算都在同一样本上附带三条对照基线，避免只报一个孤立的数字：
 *   market_fav  赛前赔率去水后的热门方向（无赔率的场次不计入此基线，n 单列）
 *   always_home 永远选主胜
 *   coverage    该口径样本占同期全部已结算预测的比例
 */
import { PICKS, foldLedger } from './ledger.mjs';

export const METRICS = ['direction_hit', 'score_top3_hit', 'totals_hit', 'over25_hit'];

export function outcomeOf(ft) {
  if (ft[0] > ft[1]) return 'h';
  if (ft[0] === ft[1]) return 'd';
  return 'a';
}

function totalsBand(ft) {
  const total = ft[0] + ft[1];
  return total <= 1 ? 0 : total <= 3 ? 1 : 2;
}

function argmax(values) {
  let best = 0;
  values.forEach((value, index) => {
    if (value > values[best]) best = index;
  });
  return best;
}

export function marketPick(odds) {
  if (!odds) return null;
  return PICKS[argmax(odds.map((o) => 1 / o))];
}

/** 第一选择与第二选择的概率差（"不下判断"规则用）。 */
export function marginOf(probs) {
  const sorted = [...probs].sort((a, b) => b - a);
  return Math.round((sorted[0] - sorted[1]) * 1e6) / 1e6;
}

/** 样本口径过滤器：所有字段可选，全部满足才入样本。 */
export function matchesFilter(prediction, filter = {}) {
  const date = prediction.kickoff.slice(0, 10);
  if (filter.mode && prediction.mode !== filter.mode) return false;
  if (filter.from && date < filter.from) return false;
  if (filter.to && date > filter.to) return false;
  if (filter.leagues && !filter.leagues.includes(prediction.league)) return false;
  if (filter.minConf !== undefined && !(prediction.conf >= filter.minConf)) return false;
  if (filter.maxConf !== undefined && !(prediction.conf < filter.maxConf)) return false;
  if (filter.picks && !filter.picks.includes(prediction.pick)) return false;
  if (filter.minMargin !== undefined && !(marginOf(prediction.probs) >= filter.minMargin)) return false;
  if (filter.maxMargin !== undefined && !(marginOf(prediction.probs) < filter.maxMargin)) return false;
  if (filter.knownOnly && !prediction.known) return false;
  return true;
}

export function settled(entries) {
  return foldLedger(entries).filter((item) => item.prediction && item.result);
}

export function evaluate(item) {
  const { prediction: p, result: r } = item;
  const actual = outcomeOf(r.ft);
  const score = `${r.ft[0]}-${r.ft[1]}`;
  const truth = PICKS.map((key) => (key === actual ? 1 : 0));
  const mPick = marketPick(p.market);
  return {
    direction_hit: p.pick === actual,
    score_top3_hit: p.top3.some(([s]) => s === score),
    totals_hit: argmax(p.totals) === totalsBand(r.ft),
    over25_hit: (p.over25 >= 0.5) === (r.ft[0] + r.ft[1] >= 3),
    brier: p.probs.reduce((sum, prob, index) => sum + (prob - truth[index]) ** 2, 0),
    logloss: -Math.log(Math.max(p.probs[PICKS.indexOf(actual)], 1e-12)),
    market_fav_hit: mPick === null ? null : mPick === actual,
    always_home_hit: actual === 'h',
    agrees_with_market: mPick === null ? null : mPick === p.pick,
    actual,
  };
}

const rate = (hits, n) => (n === 0 ? null : hits / n);
const r4 = (value) => (value === null ? null : Math.round(value * 1e4) / 1e4);

export function computeStats(entries, filter = {}) {
  const all = settled(entries);
  const universe = all.filter((item) => matchesFilter(item.prediction, { ...filter, minConf: undefined, maxConf: undefined, picks: undefined, minMargin: undefined, maxMargin: undefined }));
  const sample = universe.filter((item) => matchesFilter(item.prediction, filter));
  const evals = sample.map(evaluate);
  const count = (key) => evals.filter((e) => e[key] === true).length;
  const withMarket = evals.filter((e) => e.market_fav_hit !== null);
  const out = { n: sample.length, universe: universe.length, coverage: r4(rate(sample.length, universe.length)) };
  for (const metric of METRICS) out[metric] = { hits: count(metric), rate: r4(rate(count(metric), sample.length)) };
  out.brier = r4(sample.length ? evals.reduce((s, e) => s + e.brier, 0) / sample.length : null);
  out.logloss = r4(sample.length ? evals.reduce((s, e) => s + e.logloss, 0) / sample.length : null);
  out.baselines = {
    market_fav: { n: withMarket.length, hits: withMarket.filter((e) => e.market_fav_hit).length, rate: r4(rate(withMarket.filter((e) => e.market_fav_hit).length, withMarket.length)) },
    always_home: { n: sample.length, hits: count('always_home_hit'), rate: r4(rate(count('always_home_hit'), sample.length)) },
    agreement_with_market: r4(rate(withMarket.filter((e) => e.agrees_with_market).length, withMarket.length)),
  };
  out.lateRetractedCounted = sample.filter((item) => item.lateRetraction).length;
  return out;
}

/** 置信度-覆盖率曲线：说明"66%"必须连同覆盖率一起报。 */
export function coverageCurve(entries, filter = {}, thresholds = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  return thresholds.map((minConf) => {
    const stats = computeStats(entries, { ...filter, minConf });
    return { minConf, n: stats.n, coverage: stats.coverage, direction: stats.direction_hit.rate, market_fav_same_sample: stats.baselines.market_fav.rate };
  });
}

/**
 * 赛后归因（机械分类，不写主观解释）：
 *   draw_blind     赛果是平局，模型选的不是平（泊松模型几乎从不把平局排第一）
 *   market_upset   模型与市场同向且都错（爆冷，信息面没人看到）
 *   model_contrary 模型与市场不同向，市场对、模型错（模型自身的偏差，优先排查）
 *   both_contrary  模型与市场不同向，且两者都错
 *   no_market      无赛前赔率，无法对照
 */
export function attributeMiss(item) {
  const e = evaluate(item);
  if (e.direction_hit) return null;
  if (e.actual === 'd') return 'draw_blind';
  if (e.market_fav_hit === null) return 'no_market';
  if (e.agrees_with_market) return 'market_upset';
  return e.market_fav_hit ? 'model_contrary' : 'both_contrary';
}

export function review(entries, filter = {}) {
  const sample = settled(entries).filter((item) => matchesFilter(item.prediction, filter));
  const buckets = {};
  const misses = [];
  for (const item of sample) {
    const cause = attributeMiss(item);
    if (!cause) continue;
    buckets[cause] = (buckets[cause] ?? 0) + 1;
    misses.push({ id: item.id, pick: item.prediction.pick, conf: item.prediction.conf, ft: item.result.ft, cause });
  }
  return { n: sample.length, misses: misses.length, buckets, detail: misses };
}
