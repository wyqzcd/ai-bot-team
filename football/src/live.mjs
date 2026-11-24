/**
 * 实盘流程（纯函数，CLI 只做读写）：
 *   planPredictions  赛前出预测 → 只在 now < kickoff 时允许；同场已有有效预测须 replace + 理由（先撤回再改判）
 *   planResult       录赛果 → 只在 now ≥ kickoff + 105 分钟时允许；不得重复
 *   planRetraction   撤回 → 任何时候可撤，赛后撤回只留痕、照样计入命中率
 * 每个 plan 返回待追加的条目；写盘前统一用 G1~G4 对"追加后的台账"预检，任一 ERROR 拒绝写入。
 */
import { LEAGUES } from './dataset.mjs';
import { MIN_RESULT_MINUTES, g1Structure, g2HashChain, g3Probability, g4Lock } from './gates.mjs';
import { foldLedger, predictionEntry, resultEntry, retractionEntry, seal } from './ledger.mjs';
import { DEFAULT_PARAMS, fitPoisson } from './poisson.mjs';
import { MODEL_NAME, MODEL_VERSION, predictMatch } from './walkforward.mjs';

export class LiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveError';
  }
}

const toZ = (iso) => new Date(Date.parse(iso)).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function normalizeFixture(raw, index = 0) {
  const at = `fixtures[${index}]`;
  if (!raw || typeof raw !== 'object') throw new LiveError(`${at}: 必须是对象`);
  if (!(raw.league in LEAGUES)) throw new LiveError(`${at}: league 必须是 ${Object.keys(LEAGUES).join('/')}（当前只建模五大联赛）`);
  if (typeof raw.kickoff !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(raw.kickoff) || Number.isNaN(Date.parse(raw.kickoff))) {
    throw new LiveError(`${at}: kickoff 必须是带时区 ISO，如 2026-11-28T23:00:00+08:00`);
  }
  for (const key of ['home', 'away']) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '' || /[|,]/.test(raw[key])) throw new LiveError(`${at}: ${key} 为空或含 | ,`);
  }
  if (raw.home === raw.away) throw new LiveError(`${at}: 主客队相同`);
  let odds = null;
  if (raw.odds !== undefined && raw.odds !== null) {
    if (!Array.isArray(raw.odds) || raw.odds.length !== 3 || !raw.odds.every((o) => typeof o === 'number' && Number.isFinite(o) && o > 1)) {
      throw new LiveError(`${at}: odds 必须是 [主胜, 平, 客胜] 三个 > 1 的赔率，或省略`);
    }
    odds = raw.odds;
  }
  const kickoff = toZ(raw.kickoff);
  const date = kickoff.slice(0, 10);
  return { id: `${raw.league}|${date}|${raw.home}|${raw.away}`, league: raw.league, date, kickoff, home: raw.home, away: raw.away, odds };
}

/** 历史 = 样本库已完赛 + 实盘台账里已录赛果的场次（同一场以样本库为准）。 */
export function buildHistory(datasetMatches, liveEntries) {
  const history = datasetMatches.filter((m) => m.ft);
  const known = new Set(history.map((m) => m.id));
  for (const item of foldLedger(liveEntries)) {
    const p = item.prediction ?? item.voided.at(-1);
    if (!p || !item.result || known.has(item.id)) continue;
    history.push({ id: item.id, league: p.league, date: p.kickoff.slice(0, 10), kickoff: p.kickoff, home: p.home, away: p.away, ft: { h: item.result.ft[0], a: item.result.ft[1] } });
  }
  return history;
}

function precheck(existing, additions) {
  let previous = existing.at(-1) ?? null;
  const sealed = additions.map((entry) => {
    previous = seal(entry, previous);
    return previous;
  });
  const combined = [...existing, ...sealed];
  const problems = [g1Structure(combined, 'live'), g2HashChain(combined, 'live'), g3Probability(combined, 'live'), g4Lock(combined, 'live')].flatMap((g) => g.errors);
  if (problems.length) throw new LiveError(`预检未通过，拒绝写入：\n  ${problems.join('\n  ')}`);
  return sealed;
}

/**
 * @param {object} opts
 * @param {Array} opts.fixtures 原始 fixture 数组
 * @param {Array} opts.dataset loadDataset() 结果
 * @param {Array} opts.liveEntries 现有实盘台账
 * @param {string} opts.now ISO
 * @param {boolean} [opts.replace] 允许改判（自动先写赛前撤回）
 * @param {string} [opts.reason] 改判理由
 * @param {boolean} [opts.allowUnknown] 允许模型没见过的球队（默认拒绝，防止队名拼错被当成联赛平均队）
 */
export function planPredictions({ fixtures, dataset, liveEntries, now, replace = false, reason, allowUnknown = false, params = DEFAULT_PARAMS }) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new LiveError('fixtures 为空');
  const normalized = fixtures.map(normalizeFixture);
  const ids = new Set();
  for (const f of normalized) {
    if (ids.has(f.id)) throw new LiveError(`fixtures 内重复：${f.id}`);
    ids.add(f.id);
  }
  const nowMs = Date.parse(now);
  const folded = new Map(foldLedger(liveEntries).map((item) => [item.id, item]));
  const history = buildHistory(dataset, liveEntries);
  const models = new Map();
  const additions = [];
  for (const fixture of normalized) {
    if (!(nowMs < Date.parse(fixture.kickoff))) throw new LiveError(`${fixture.id}: 已开赛（${fixture.kickoff}），锁定，禁止预测/改判`);
    const existing = folded.get(fixture.id);
    if (existing?.result) throw new LiveError(`${fixture.id}: 已有赛果，禁止改判`);
    if (existing?.prediction) {
      if (!replace) throw new LiveError(`${fixture.id}: 已有有效预测 #${existing.prediction.seq}；改判请加 --replace --reason "<理由>"`);
      if (typeof reason !== 'string' || reason.trim().length < 4) throw new LiveError(`${fixture.id}: 改判必须写明理由（--reason，≥4 字）`);
      additions.push(retractionEntry({ target: existing.prediction.seq, id: fixture.id, reason: `赛前改判：${reason.trim()}`, createdAt: now }));
    }
    if (!models.has(fixture.league)) models.set(fixture.league, fitPoisson(history.filter((m) => m.league === fixture.league), now, params));
    const model = models.get(fixture.league);
    if (!model.ok) throw new LiveError(`${fixture.league}: 无法拟合（${model.reason}）`);
    for (const team of [fixture.home, fixture.away]) {
      if (!model.attack.has(team) && !allowUnknown) {
        const hint = [...model.attack.keys()].filter((name) => name.toLowerCase().includes(team.toLowerCase().slice(0, 4))).slice(0, 5);
        throw new LiveError(`${fixture.id}: 模型近 ${params.windowDays} 天没见过球队「${team}」（队名须与样本库一致${hint.length ? `，可能是：${hint.join(' / ')}` : ''}）；确认是升班马请加 --allow-unknown`);
      }
    }
    const pred = predictMatch(model, fixture);
    additions.push(predictionEntry({ match: fixture, createdAt: now, mode: 'live', model: `${MODEL_NAME}@${MODEL_VERSION}`, pred, market: fixture.odds }));
  }
  return precheck(liveEntries, additions);
}

export function parseScore(text, label) {
  const m = typeof text === 'string' ? /^(\d{1,2})-(\d{1,2})$/.exec(text.trim()) : null;
  if (!m) throw new LiveError(`${label} 必须形如 2-1`);
  return [Number(m[1]), Number(m[2])];
}

export function planResult({ liveEntries, id, ft, ht = null, now, source }) {
  const item = foldLedger(liveEntries).find((x) => x.id === id);
  if (!item || (!item.prediction && item.voided.length === 0)) throw new LiveError(`${id}: 台账里没有这场的预测`);
  if (item.result) throw new LiveError(`${id}: 赛果已入账 #${item.result.seq}，禁止覆盖`);
  const kickoff = (item.prediction ?? item.voided.at(-1)).kickoff;
  if (Date.parse(now) < Date.parse(kickoff) + MIN_RESULT_MINUTES * 60000) throw new LiveError(`${id}: 开赛 ${kickoff} 后 ${MIN_RESULT_MINUTES} 分钟内不能录完场赛果`);
  if (typeof source !== 'string' || source.trim() === '') throw new LiveError('必须写明赛果来源 --source');
  return precheck(liveEntries, [resultEntry({ id, ft, ht, recordedAt: now, source: source.trim() })]);
}

export function planRetraction({ liveEntries, seq, reason, now }) {
  const target = liveEntries.find((e) => e.seq === seq);
  if (!target || target.type !== 'prediction') throw new LiveError(`#${seq} 不存在或不是预测`);
  if (typeof reason !== 'string' || reason.trim().length < 4) throw new LiveError('撤回必须写明原因（≥4 字）');
  return precheck(liveEntries, [retractionEntry({ target: seq, id: target.id, reason: reason.trim(), createdAt: now })]);
}
