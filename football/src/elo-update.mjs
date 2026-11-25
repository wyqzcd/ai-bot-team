/**
 * Elo 推算：ClubElo 快照之后，用样本库里的五大联赛比分把评分往后推。
 *
 * 为什么需要：ClubElo 快照（data/elo-latest.csv）截至原始样本库的最后一天，此后各队状态变化模型看不到。
 * football-data 镜像有五大联赛的新比分，但没有 Elo。这里用标准 Elo 更新把评分推到最新：
 *   E主 = 1 / (1 + 10^(−(R主 − R客 + H) / 400))
 *   Δ = K · G(净胜球) · (W − E主)，R主 += Δ，R客 −= Δ（W：主胜 1 / 平 0.5 / 负 0）
 *   G = 1（净胜 ≤1）、1.5（净胜 2）、(11 + 净胜) / 8（净胜 ≥3）；margin=false 时 G 恒为 1
 * K、H、margin 只在训练段（窗口全部早于 2024-07-01）上选出，留出段只报告一次，见 bin/elo-update.mjs。
 *
 * 局限：只有五大联赛的联赛比分。欧战、杯赛不进推算；五大联赛之外的球队保持快照原值（会继续变旧）。
 * 联赛内更新是零和的，所以各联赛之间的相对强弱停留在快照时的水平。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';
import { parseCsv } from './csv.mjs';
import { predictElo } from './elo.mjs';

export const ELO_UPDATE_NAME = 'elo-prop';
export const ELO_UPDATE_VERSION = '1.0.0';
export const ELO_UPDATE_FILE = path.join(FOOTBALL_ROOT, 'data', 'elo-update.json');
export const ELO_CURRENT_FILE = path.join(FOOTBALL_ROOT, 'data', 'elo-current.csv');
export const ELO_CURRENT_COLUMNS = ['team', 'division', 'date', 'elo', 'basis', 'snapshot', 'snapshotElo', 'games'];

/** 选参网格与窗口：固定写在这里，改动即新版本。 */
export const GRID = {
  k: [0, 5, 10, 15, 20, 25, 30, 35, 40, 50],
  hfa: [0, 25, 50, 75, 100],
  margin: [false, true],
};
export const WINDOW_DAYS = 90;
const CUTOFF_DAYS = ['09-01', '11-01', '01-01', '03-01'];
const cutoffsFor = (seasons) => seasons.flatMap((y) => CUTOFF_DAYS.map((md) => (md >= '07-01' ? `${y}-${md}` : `${y + 1}-${md}`)));
/** 训练段：2017-18 ~ 2023-24 赛季，每季 4 个截断日，窗口 90 天，全部在 2024-07-01 之前结束。 */
export const TRAIN_CUTOFFS = cutoffsFor([2017, 2018, 2019, 2020, 2021, 2022, 2023]);
/** 留出段：2024-25、2025-26 赛季（窗口都在 ClubElo 覆盖内，可同时和真实 ClubElo 对照）。 */
export const HOLDOUT_CUTOFFS = cutoffsFor([2024, 2025]);

export function marginMultiplier(goalDiff) {
  const g = Math.abs(goalDiff);
  if (g <= 1) return 1;
  if (g === 2) return 1.5;
  return (11 + g) / 8;
}

/** 单场更新，返回 [新主队评分, 新客队评分]。 */
export function eloStep(rh, ra, hg, ag, { k, hfa, margin }) {
  const expected = 1 / (1 + 10 ** (-(rh - ra + hfa) / 400));
  const w = hg > ag ? 1 : hg === ag ? 0.5 : 0;
  const delta = k * (margin ? marginMultiplier(hg - ag) : 1) * (w - expected);
  return [rh + delta, ra - delta];
}

const byKickoff = (a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : a.id < b.id ? -1 : 1);

/**
 * 从快照往后推。只用两队快照日（含当天：快照值是那天赛前评分）及之后、有比分的比赛。
 * @param snapshot Map team → { elo, date, division? }
 * @param matches 样本库比赛（含 ft）
 * @param onMatch 可选回调 (match, ratingsBefore[h,a])：在更新前调用，供评估用
 * @returns Map team → { elo, date, division, snapshot, snapshotElo, games, basis }
 */
export function propagateElo(snapshot, matches, params, onMatch = null) {
  const state = new Map([...snapshot].map(([team, s]) => [team, { elo: s.elo, date: s.date, division: s.division ?? '', snapshot: s.date, snapshotElo: s.elo, games: 0 }]));
  const sorted = matches.filter((m) => m.ft).sort(byKickoff);
  for (const m of sorted) {
    const h = state.get(m.home);
    const a = state.get(m.away);
    if (!h || !a || m.date < h.snapshot || m.date < a.snapshot) continue;
    onMatch?.(m, [h.elo, a.elo]);
    const [nh, na] = eloStep(h.elo, a.elo, m.ft.h, m.ft.a, params);
    Object.assign(h, { elo: nh, date: m.date, games: h.games + 1 });
    Object.assign(a, { elo: na, date: m.date, games: a.games + 1 });
  }
  for (const s of state.values()) s.basis = s.games > 0 ? 'propagated' : 'clubelo';
  return state;
}

/** 截断日 C 的快照：每队在 C 之前最后一场比赛的赛前 ClubElo（与 data/elo-latest.csv 的构造一致）。 */
export function snapshotAt(matches, cutoff) {
  const snap = new Map();
  for (const m of matches) {
    if (!m.elo || m.date >= cutoff) continue;
    for (const [team, elo] of [[m.home, m.elo.h], [m.away, m.elo.a]]) {
      const prev = snap.get(team);
      if (!prev || m.date >= prev.date) snap.set(team, { elo, date: m.date, division: m.league });
    }
  }
  return snap;
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const outcome = (m) => (m.ft.h > m.ft.a ? 'h' : m.ft.h === m.ft.a ? 'd' : 'a');
const pickOf = (p) => ['h', 'd', 'a'].reduce((x, y) => (p[y] > p[x] ? y : x), 'h');

/**
 * 一个窗口 [C, C+90) 的准备工作（与参数无关，只算一次）：快照 + 需要推算的比赛（已排序）。
 * 评估样本：窗口内两队都在快照里的比赛；requireOracle 时还要求比赛本身带真实赛前 ClubElo。
 */
export function prepareWindow(matches, cutoff, { requireOracle = true } = {}) {
  const snap = snapshotAt(matches, cutoff);
  const end = addDays(cutoff, WINDOW_DAYS);
  const games = matches.filter((m) => m.ft && m.date < end).sort(byKickoff);
  return { cutoff, snap, games, requireOracle };
}

const probsCache = new Map();
function probsFor(model, eh, ea) {
  const key = `${model.model}|${eh}|${ea}`;
  let p = probsCache.get(key);
  if (!p) {
    p = predictElo(model, eh, ea).probs;
    if (probsCache.size > 2e5) probsCache.clear();
    probsCache.set(key, p);
  }
  return p;
}

/** 逐场对数损失：frozen（快照不动）、propagated（推算）、oracle（真实赛前 ClubElo，有才算）。三者同一批比赛。 */
export function evaluatePrepared({ cutoff, snap, games, requireOracle }, model, params) {
  const rows = [];
  propagateElo(snap, games, params, (m, [rh, ra]) => {
    if (m.date < cutoff) return;
    if (requireOracle && !m.elo) return;
    const o = outcome(m);
    const score = (p) => ({ ll: -Math.log(p[o]), hit: pickOf(p) === o });
    rows.push({
      id: m.id,
      frozen: score(probsFor(model, snap.get(m.home).elo, snap.get(m.away).elo)),
      propagated: score(predictElo(model, rh, ra).probs),
      oracle: m.elo ? score(probsFor(model, m.elo.h, m.elo.a)) : null,
    });
  });
  return rows;
}

export const evaluateWindow = (matches, cutoff, model, params, options) => evaluatePrepared(prepareWindow(matches, cutoff, options), model, params);

const r4 = (x) => (x === null ? null : Math.round(x * 1e4) / 1e4);

/** 汇总：平均对数损失、方向命中，以及 propagated 相对 frozen 的配对 z（正数 = 推算更好）。 */
export function summarizeRows(rows) {
  const n = rows.length;
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  const diffs = rows.map((r) => r.frozen.ll - r.propagated.ll);
  const md = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - md) ** 2, 0) / (n - 1));
  const full = rows.every((r) => r.oracle);
  return {
    n,
    logloss: { frozen: r4(mean((r) => r.frozen.ll)), propagated: r4(mean((r) => r.propagated.ll)), oracle: full ? r4(mean((r) => r.oracle.ll)) : null },
    direction: { frozen: r4(mean((r) => (r.frozen.hit ? 1 : 0))), propagated: r4(mean((r) => (r.propagated.hit ? 1 : 0))), oracle: full ? r4(mean((r) => (r.oracle.hit ? 1 : 0))) : null },
    pairedZ: r4(md / (sd / Math.sqrt(n))),
  };
}

export function evaluateCutoffs(matches, cutoffs, model, params, options) {
  return cutoffs.flatMap((c) => evaluateWindow(matches, c, model, params, options));
}

/** 在训练窗口上选参：平均对数损失最小；并列按网格顺序（margin=false、K 小、H 小优先）。 */
export function selectParams(matches, model, grid = GRID, cutoffs = TRAIN_CUTOFFS) {
  const windows = cutoffs.map((c) => prepareWindow(matches, c));
  let best = null;
  const table = [];
  for (const margin of grid.margin) {
    for (const k of grid.k) {
      for (const hfa of grid.hfa) {
        const params = { k, hfa, margin };
        const rows = windows.flatMap((w) => evaluatePrepared(w, model, params));
        const ll = rows.reduce((s, r) => s + r.propagated.ll, 0) / rows.length;
        table.push({ ...params, logloss: r4(ll) });
        if (!best || ll < best.ll - 1e-12) best = { params, ll };
      }
    }
  }
  return { params: best.params, table };
}

export function loadEloUpdate(file = ELO_UPDATE_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 推算后的评分：team → { elo, date, division, basis, snapshot, snapshotElo, games }。文件不存在返回 null。 */
export function loadEloCurrent(file = ELO_CURRENT_FILE) {
  if (!existsSync(file)) return null;
  return new Map(parseCsv(readFileSync(file, 'utf8')).map((r) => [r.team, { elo: Number(r.elo), date: r.date, division: r.division, basis: r.basis, snapshot: r.snapshot, snapshotElo: Number(r.snapshotElo), games: Number(r.games) }]));
}
