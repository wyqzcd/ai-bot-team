/**
 * 泊松建模（Maher / Dixon-Coles 族，只用赛果，不用赔率）：
 *   λ_主 = μ · 主场系数 γ · 进攻_主 · 防守_客
 *   λ_客 = μ · 进攻_客 · 防守_主
 * - 时间衰减权重 w = exp(-ln2 · Δ天 / 半衰期)，越近的比赛越重要。
 * - 球队参数向 1 收缩（伪样本 shrink 场），升班马/样本少的球队不会被极端估计。
 * - 低比分修正 ρ（Dixon-Coles τ 函数）在训练样本上用网格最大似然估计。
 * - 拟合只使用严格早于 asOf 的比赛：回测里每个比赛日都重新拟合，杜绝未来数据泄漏。
 */

export const DEFAULT_PARAMS = Object.freeze({
  halfLifeDays: 180,
  windowDays: 730,
  shrink: 4,
  iterations: 30,
  maxGoals: 10,
  rhoGrid: [-0.2, -0.16, -0.12, -0.08, -0.04, 0, 0.04],
  minMatches: 120,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Array<{home,away,ft:{h,a},kickoff}>} history 已完赛比赛（同一联赛）
 * @param {string} asOf ISO 时间；只用 kickoff < asOf 的比赛
 */
export function fitPoisson(history, asOf, params = DEFAULT_PARAMS) {
  const asOfMs = Date.parse(asOf);
  const windowStart = asOfMs - params.windowDays * DAY_MS;
  const games = [];
  for (const match of history) {
    if (!match.ft) continue;
    const t = Date.parse(match.kickoff);
    if (!(t < asOfMs) || t < windowStart) continue;
    const ageDays = (asOfMs - t) / DAY_MS;
    games.push({ home: match.home, away: match.away, hg: match.ft.h, ag: match.ft.a, w: Math.exp((-Math.LN2 * ageDays) / params.halfLifeDays) });
  }
  if (games.length < params.minMatches) {
    return { ok: false, reason: `样本不足：${games.length} < ${params.minMatches}`, n: games.length };
  }

  const teams = new Set();
  for (const game of games) {
    teams.add(game.home);
    teams.add(game.away);
  }
  const attack = new Map([...teams].map((team) => [team, 1]));
  const defense = new Map([...teams].map((team) => [team, 1]));

  let totalW = 0;
  let homeGoalsW = 0;
  let awayGoalsW = 0;
  for (const game of games) {
    totalW += game.w;
    homeGoalsW += game.w * game.hg;
    awayGoalsW += game.w * game.ag;
  }
  let mu = awayGoalsW / totalW;
  let gamma = homeGoalsW / Math.max(awayGoalsW, 1e-9);
  const k = params.shrink;

  for (let iteration = 0; iteration < params.iterations; iteration += 1) {
    const scored = new Map();
    const expectedScored = new Map();
    const conceded = new Map();
    const expectedConceded = new Map();
    const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
    for (const game of games) {
      const expHomeUnitAttack = mu * gamma * defense.get(game.away);
      const expAwayUnitAttack = mu * defense.get(game.home);
      add(scored, game.home, game.w * game.hg);
      add(expectedScored, game.home, game.w * expHomeUnitAttack);
      add(scored, game.away, game.w * game.ag);
      add(expectedScored, game.away, game.w * expAwayUnitAttack);
    }
    for (const team of teams) {
      attack.set(team, (scored.get(team) + k) / (expectedScored.get(team) + k));
    }
    for (const game of games) {
      add(conceded, game.away, game.w * game.hg);
      add(expectedConceded, game.away, game.w * mu * gamma * attack.get(game.home));
      add(conceded, game.home, game.w * game.ag);
      add(expectedConceded, game.home, game.w * mu * attack.get(game.away));
    }
    for (const team of teams) {
      defense.set(team, (conceded.get(team) + k) / (expectedConceded.get(team) + k));
    }
    // 归一：进攻/防守几何均值 = 1，尺度全部交给 μ 与 γ。
    const geo = (map) => Math.exp([...map.values()].reduce((sum, value) => sum + Math.log(value), 0) / map.size);
    const ga = geo(attack);
    const gd = geo(defense);
    for (const team of teams) {
      attack.set(team, attack.get(team) / ga);
      defense.set(team, defense.get(team) / gd);
    }
    let expHome = 0;
    let expAway = 0;
    for (const game of games) {
      expHome += game.w * attack.get(game.home) * defense.get(game.away);
      expAway += game.w * attack.get(game.away) * defense.get(game.home);
    }
    const muNew = awayGoalsW / expAway;
    gamma = homeGoalsW / (muNew * expHome);
    const converged = Math.abs(muNew - mu) < 1e-10;
    mu = muNew;
    if (converged) break;
  }

  const model = { ok: true, asOf, n: games.length, mu, gamma, attack, defense, rho: 0, params };
  model.rho = estimateRho(model, games);
  return model;
}

function estimateRho(model, games) {
  let best = 0;
  let bestLl = -Infinity;
  for (const rho of model.params.rhoGrid) {
    let ll = 0;
    let valid = true;
    for (const game of games) {
      if (game.hg > 1 || game.ag > 1) continue;
      const { home, away } = lambdas(model, game.home, game.away);
      const tau = dcTau(game.hg, game.ag, home, away, rho);
      if (!(tau > 0)) {
        valid = false;
        break;
      }
      ll += game.w * Math.log(tau);
    }
    if (valid && ll > bestLl) {
      bestLl = ll;
      best = rho;
    }
  }
  return best;
}

export function dcTau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** 未知球队（新升级且窗口内无比赛）按联赛平均（参数=1）处理，并在输出里标记。 */
export function lambdas(model, home, away) {
  const known = model.attack.has(home) && model.attack.has(away);
  const ah = model.attack.get(home) ?? 1;
  const dh = model.defense.get(home) ?? 1;
  const aa = model.attack.get(away) ?? 1;
  const da = model.defense.get(away) ?? 1;
  return { home: model.mu * model.gamma * ah * da, away: model.mu * aa * dh, known };
}

function poissonPmf(lambda, maxGoals) {
  const out = new Array(maxGoals + 1);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxGoals; k += 1) out[k] = (out[k - 1] * lambda) / k;
  return out;
}

/** 比分矩阵 → 方向 / 比分 TOP3 / 总进球 / 大小 2.5；矩阵整体归一化到 1。 */
export function scoreMatrix(lh, la, rho = 0, maxGoals = DEFAULT_PARAMS.maxGoals) {
  const ph = poissonPmf(lh, maxGoals);
  const pa = poissonPmf(la, maxGoals);
  const matrix = [];
  let total = 0;
  for (let x = 0; x <= maxGoals; x += 1) {
    const row = [];
    for (let y = 0; y <= maxGoals; y += 1) {
      const p = ph[x] * pa[y] * dcTau(x, y, lh, la, rho);
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }
  for (const row of matrix) for (let y = 0; y < row.length; y += 1) row[y] /= total;
  return matrix;
}

export function summarizeMatrix(matrix) {
  let h = 0;
  let d = 0;
  let a = 0;
  let over25 = 0;
  const totals = { '0-1': 0, '2-3': 0, '4+': 0 };
  const scores = [];
  matrix.forEach((row, x) => {
    row.forEach((p, y) => {
      if (x > y) h += p;
      else if (x === y) d += p;
      else a += p;
      if (x + y >= 3) over25 += p;
      totals[x + y <= 1 ? '0-1' : x + y <= 3 ? '2-3' : '4+'] += p;
      scores.push([`${x}-${y}`, p]);
    });
  });
  scores.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  return { probs: { h, d, a }, over25, totals, top3: scores.slice(0, 3) };
}
