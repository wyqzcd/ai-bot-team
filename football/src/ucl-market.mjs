/**
 * 欧冠赔率对照：竞彩欧冠场次（scripts/jczq-board.mjs 抓的官方胜平负赔率）→ 欧冠候选台账里的预测。
 *
 * 口径：
 * - 赔率只作对照，不进模型、不进哈希链台账；存在 ledger/ucl-market.json（旁注文件）。
 * - 只记开赛前抓到的赔率：capturedAt 必须早于开赛时间，开赛后一律拒绝；读取时也再过滤一次。
 * - 去水：p_i = (1/odds_i) / Σ(1/odds_j)（与 jczq-board 同一公式）。
 * - 队名精确匹配：五大联赛球队查 data/jczq-teams.json，其余查 data/jczq-ucl-teams.json；查不到就是未映射，不猜。
 * - 只给已经有候选预测的场次记赔率（台账 id = UCL|开赛 UTC 日期|主队|客队）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';
import { normalizeName } from './jczq.mjs';
import { boardMatches } from './jczq.mjs';
import { foldLedger } from './ledger.mjs';

export const UCL_TEAM_MAP = path.join(FOOTBALL_ROOT, 'data', 'jczq-ucl-teams.json');
export const UCL_MARKET_FILE = path.join(FOOTBALL_ROOT, 'ledger', 'ucl-market.json');
/** 模型与市场去水概率的差（同一方向）超过这个值，报告里标"分歧大"。只是展示口径，不参与任何统计。 */
export const DIVERGENCE_FLAG = 0.1;

export function devig(odds) {
  const inv = odds.map((o) => 1 / o);
  const sum = inv.reduce((s, x) => s + x, 0);
  return inv.map((x) => Math.round((x / sum) * 1e4) / 1e4);
}

/** 编译对照表：中文名（归一化）→ Elo 队名。big5Doc = jczq-teams.json，uclDoc = jczq-ucl-teams.json。 */
export function compileUclTeamMap(big5Doc, uclDoc) {
  const errors = [];
  const teams = new Map();
  const put = (zh, name) => {
    const key = normalizeName(zh);
    if (!key) errors.push(`${name}：中文名为空`);
    else if (teams.has(key) && teams.get(key) !== name) errors.push(`别名「${zh}」同时指向 ${teams.get(key)} 与 ${name}`);
    else teams.set(key, name);
  };
  for (const table of Object.values(big5Doc?.teams ?? {})) for (const [name, zhs] of Object.entries(table)) for (const zh of zhs) put(zh, name);
  for (const [name, zhs] of Object.entries(uclDoc?.teams ?? {})) {
    if (!Array.isArray(zhs) || !zhs.length) errors.push(`${name}：至少需要一个中文名`);
    else for (const zh of zhs) put(zh, name);
  }
  const leagues = new Set((uclDoc?.leagues ?? []).map(normalizeName));
  if (!leagues.size) errors.push('leagues 为空');
  return { leagues, teams, errors };
}

export function loadUclTeamMap(big5File = path.join(FOOTBALL_ROOT, 'data', 'jczq-teams.json'), uclFile = UCL_TEAM_MAP) {
  const compiled = compileUclTeamMap(JSON.parse(readFileSync(big5File, 'utf8')), JSON.parse(readFileSync(uclFile, 'utf8')));
  if (compiled.errors.length) throw new RangeError(`欧冠竞彩队名对照表非法：\n  ${compiled.errors.join('\n  ')}`);
  return compiled;
}

const utc = (iso) => new Date(Date.parse(iso)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 逐场解析竞彩看板 fixture。status：
 *   ready          可记赔率（有候选预测、开赛前、胜平负赔率齐全）
 *   not_ucl        不是欧冠
 *   unmapped       欧冠但队名不在对照表
 *   no_prediction  候选台账里没有这场的预测（模型没出，或日期/队名对不上）
 *   no_odds        官方未开售胜平负
 *   locked         抓取时已开赛（或抓取时间不早于开赛），拒绝
 */
export function resolveUclMarket(boardFixture, teamMap, { predictions, capturedAt }) {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  return boardMatches(boardFixture).map((m) => {
    const ref = { no: m.no, league: m.league, home: m.home, away: m.away, kickoff: m.kickoff };
    if (!teamMap.leagues.has(normalizeName(m.league))) return { status: 'not_ucl', ref };
    const home = teamMap.teams.get(normalizeName(m.home));
    const away = teamMap.teams.get(normalizeName(m.away));
    if (!home || !away) return { status: 'unmapped', ref, missing: [!home && m.home, !away && m.away].filter(Boolean) };
    const id = `UCL|${utc(m.kickoff).slice(0, 10)}|${home}|${away}`;
    const prediction = byId.get(id);
    if (!prediction) return { status: 'no_prediction', ref, id };
    if (!Array.isArray(m.spf)) return { status: 'no_odds', ref, id };
    if (!(Date.parse(capturedAt) < Date.parse(prediction.kickoff))) return { status: 'locked', ref, id, reason: `抓取时间 ${capturedAt} 不早于开赛 ${prediction.kickoff}` };
    return { status: 'ready', ref, id, prediction, odds: m.spf, market: devig(m.spf) };
  });
}

export function readMarketFile(file = UCL_MARKET_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** 追加一次快照（同一赔率不重复记）。返回新对象，不改入参。 */
export function addSnapshot(doc, row, { capturedAt, oddsUpdatedAt, source }) {
  const out = structuredClone(doc);
  const item = out[row.id] ?? { no: row.ref.no, zh: { home: row.ref.home, away: row.ref.away }, kickoff: row.prediction.kickoff, snapshots: [] };
  const last = item.snapshots.at(-1);
  if (last && last.odds.join('/') === row.odds.join('/')) return { doc: out, added: false };
  item.snapshots.push({ capturedAt, oddsUpdatedAt: oddsUpdatedAt ?? null, odds: row.odds, market: row.market, source });
  out[row.id] = item;
  return { doc: out, added: true };
}

/** 开赛前最后一次快照（开赛后抓的一律忽略），没有则 null。 */
export function preKickoffMarket(item) {
  if (!item) return null;
  const ok = item.snapshots.filter((s) => Date.parse(s.capturedAt) < Date.parse(item.kickoff));
  return ok.at(-1) ?? null;
}

const PICKS = ['h', 'd', 'a'];
const argmax = (xs) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

/** 模型与市场对照：每个方向的差（模型 − 市场）、市场热门、最大分歧。 */
export function compare(prediction, snapshot) {
  if (!snapshot) return null;
  const diff = prediction.probs.map((p, i) => Math.round((p - snapshot.market[i]) * 1e4) / 1e4);
  const biggest = argmax(diff.map(Math.abs));
  return {
    market: snapshot.market,
    marketPick: PICKS[argmax(snapshot.market)],
    agrees: PICKS[argmax(snapshot.market)] === prediction.pick,
    diff,
    biggest: { pick: PICKS[biggest], value: diff[biggest] },
    flagged: Math.abs(diff[biggest]) >= DIVERGENCE_FLAG,
  };
}

/** 已结算场次：模型方向 vs 市场热门，谁对。 */
export function marketScoreboard(items, marketDoc) {
  let n = 0;
  let model = 0;
  let market = 0;
  for (const { id, prediction, result } of items) {
    if (!prediction || !result) continue;
    const snap = preKickoffMarket(marketDoc[id] ? { ...marketDoc[id], kickoff: prediction.kickoff } : null);
    if (!snap) continue;
    const actual = result.ft[0] > result.ft[1] ? 'h' : result.ft[0] === result.ft[1] ? 'd' : 'a';
    n += 1;
    if (prediction.pick === actual) model += 1;
    if (PICKS[argmax(snap.market)] === actual) market += 1;
  }
  return { n, model, market };
}

export const uclPredictions = (entriesList) => entriesList.flatMap((entries) => foldLedger(entries).filter((x) => x.prediction && !x.result).map((x) => x.prediction));
