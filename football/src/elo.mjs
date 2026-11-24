/**
 * Elo 泊松模型（跨联赛候选模型，用于欧冠等不同联赛球队之间的比赛）：
 *   d = (Elo主 − Elo客) / 100
 *   λ主 = exp(αh + β·d)，λ客 = exp(αa − β·d)
 * Elo 来自 ClubElo（跨联赛可比）。参数在五大联赛训练段（开赛 < 2024-07-01）上用泊松极大似然（Newton 法）拟合，
 * 低比分修正 ρ 在同一训练段上网格估计。参数固定后才用于留出段回测与实盘，绝不回头调。
 *
 * 局限（写进规则登记）：只在联赛内比赛上校准过；欧冠的主场优势、强度分布与联赛不同，没有欧冠样本可回测。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT } from './dataset.mjs';
import { parseCsv } from './csv.mjs';
import { DEFAULT_PARAMS, dcTau, scoreMatrix, summarizeMatrix } from './poisson.mjs';

export const ELO_MODEL_NAME = 'elo-poisson';
export const ELO_MODEL_VERSION = '0.1.0';
export const ELO_TRAIN_FROM = '2017-07-01';
export const ELO_TRAIN_TO = '2024-06-30';
export const ELO_MODEL_FILE = path.join(FOOTBALL_ROOT, 'data', 'elo-model.json');
export const ELO_LATEST_FILE = path.join(FOOTBALL_ROOT, 'data', 'elo-latest.csv');

const r6 = (x) => Math.round(x * 1e6) / 1e6;

function solve3(H, g) {
  // 3x3 线性方程组（高斯消元，带主元）
  const m = H.map((row, i) => [...row, g[i]]);
  for (let c = 0; c < 3; c += 1) {
    let p = c;
    for (let r = c + 1; r < 3; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k += 1) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[3] / row[i]);
}

/** @param matches 含 ft 与 elo 的比赛 */
export function fitEloPoisson(matches, { from = ELO_TRAIN_FROM, to = ELO_TRAIN_TO, rhoGrid = DEFAULT_PARAMS.rhoGrid } = {}) {
  const rows = matches
    .filter((m) => m.ft && m.elo && m.date >= from && m.date <= to)
    .map((m) => ({ d: (m.elo.h - m.elo.a) / 100, hg: m.ft.h, ag: m.ft.a }));
  if (rows.length < 500) throw new RangeError(`Elo 模型训练样本不足：${rows.length}`);
  const meanH = rows.reduce((s, r) => s + r.hg, 0) / rows.length;
  const meanA = rows.reduce((s, r) => s + r.ag, 0) / rows.length;
  let theta = [Math.log(meanH), Math.log(meanA), 0];
  for (let iter = 0; iter < 50; iter += 1) {
    const g = [0, 0, 0];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const r of rows) {
      const lh = Math.exp(theta[0] + theta[2] * r.d);
      const la = Math.exp(theta[1] - theta[2] * r.d);
      g[0] += r.hg - lh;
      g[1] += r.ag - la;
      g[2] += r.d * (r.hg - lh) - r.d * (r.ag - la);
      H[0][0] += lh; H[0][2] += lh * r.d;
      H[1][1] += la; H[1][2] -= la * r.d;
      H[2][2] += lh * r.d * r.d + la * r.d * r.d;
    }
    H[2][0] = H[0][2];
    H[2][1] = H[1][2];
    const step = solve3(H, g);
    theta = theta.map((t, i) => t + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  const [alphaH, alphaA, beta] = theta;
  let rho = 0;
  let best = -Infinity;
  for (const candidate of rhoGrid) {
    let ll = 0;
    let ok = true;
    for (const r of rows) {
      if (r.hg > 1 || r.ag > 1) continue;
      const tau = dcTau(r.hg, r.ag, Math.exp(alphaH + beta * r.d), Math.exp(alphaA - beta * r.d), candidate);
      if (!(tau > 0)) { ok = false; break; }
      ll += Math.log(tau);
    }
    if (ok && ll > best) { best = ll; rho = candidate; }
  }
  return { model: `${ELO_MODEL_NAME}@${ELO_MODEL_VERSION}`, trainFrom: from, trainTo: to, n: rows.length, alphaH: r6(alphaH), alphaA: r6(alphaA), beta: r6(beta), rho };
}

export function loadEloModel(file = ELO_MODEL_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function predictElo(params, eloHome, eloAway) {
  const d = (eloHome - eloAway) / 100;
  const lam = { home: Math.exp(params.alphaH + params.beta * d), away: Math.exp(params.alphaA - params.beta * d), known: true };
  return { lam, ...summarizeMatrix(scoreMatrix(lam.home, lam.away, params.rho)) };
}

/** 最新 Elo 快照：team → { elo, date, division } */
export function loadEloLatest(file = ELO_LATEST_FILE) {
  return new Map(parseCsv(readFileSync(file, 'utf8')).map((r) => [r.team, { elo: Number(r.elo), date: r.date, division: r.division }]));
}
