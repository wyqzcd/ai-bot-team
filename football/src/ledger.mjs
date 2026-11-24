/**
 * 台账：JSONL，一行一条，只追加。三种条目：
 *   prediction  赛前预测（createdAt 必须早于 kickoff）
 *   result      赛果（recordedAt 不得早于 kickoff）
 *   retraction  撤回（指向某条 prediction 的 seq，写明原因；原条目不删不改）
 * 每条带 prev（上一条 hash）与 hash（本条规范序列化的 sha256 前 16 位），
 * 任何静默改写/删除/插入都会让哈希链断裂，被门禁 G2 拦下。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const GENESIS = '0'.repeat(16);

export const FIELD_ORDER = {
  prediction: [
    'seq', 'type', 'id', 'league', 'kickoff', 'home', 'away', 'createdAt', 'mode', 'model',
    'lam', 'probs', 'pick', 'conf', 'over25', 'totals', 'top3', 'known', 'market', 'prev', 'hash',
  ],
  result: ['seq', 'type', 'id', 'ft', 'ht', 'recordedAt', 'source', 'prev', 'hash'],
  retraction: ['seq', 'type', 'target', 'id', 'reason', 'createdAt', 'prev', 'hash'],
};

export const PICKS = ['h', 'd', 'a'];

export function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

/** 按规范字段序重建对象；缺字段抛错，多字段抛错。 */
export function canonical(entry) {
  const order = FIELD_ORDER[entry.type];
  if (!order) throw new RangeError(`未知条目类型：${entry.type}`);
  const extra = Object.keys(entry).filter((key) => !order.includes(key));
  if (extra.length) throw new RangeError(`条目含未登记字段：${extra.join(',')}`);
  const out = {};
  for (const key of order) {
    if (key === 'hash') continue;
    if (!(key in entry)) throw new RangeError(`条目缺字段：${key}`);
    out[key] = entry[key];
  }
  return out;
}

export function hashEntry(entry) {
  return createHash('sha256').update(JSON.stringify(canonical(entry))).digest('hex').slice(0, 16);
}

export function serialize(entry) {
  const body = canonical(entry);
  body.hash = entry.hash;
  return JSON.stringify(body);
}

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new RangeError(`台账第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
}

/** 给一条不含 seq/prev/hash 的条目补链路字段。 */
export function seal(entry, previous) {
  const sealed = { seq: previous ? previous.seq + 1 : 1, ...entry, prev: previous ? previous.hash : GENESIS, hash: '' };
  sealed.hash = hashEntry(sealed);
  return JSON.parse(serialize(sealed));
}

export function writeLedger(file, entries) {
  writeFileSync(file, entries.length ? `${entries.map(serialize).join('\n')}\n` : '');
}

export function appendEntries(file, entries) {
  const existing = readLedger(file);
  let previous = existing.at(-1) ?? null;
  const sealed = [];
  for (const entry of entries) {
    previous = seal(entry, previous);
    sealed.push(previous);
  }
  if (sealed.length) appendFileSync(file, `${sealed.map(serialize).join('\n')}\n`);
  return sealed;
}

/** 由模型输出构造 prediction 条目（未封链）。 */
export function predictionEntry({ match, createdAt, mode, model, pred, market = null }) {
  const raw = pred.probs;
  const pick = PICKS.reduce((best, key) => (raw[key] > raw[best] ? key : best), 'h');
  return {
    type: 'prediction',
    id: match.id,
    league: match.league,
    kickoff: match.kickoff,
    home: match.home,
    away: match.away,
    createdAt,
    mode,
    model,
    lam: [round4(pred.lam.home), round4(pred.lam.away)],
    probs: PICKS.map((key) => round4(raw[key])),
    pick,
    conf: round4(raw[pick]),
    over25: round4(pred.over25),
    totals: ['0-1', '2-3', '4+'].map((key) => round4(pred.totals[key])),
    top3: pred.top3.map(([score, p]) => [score, round4(p)]),
    known: pred.lam.known,
    market,
  };
}

export function resultEntry({ id, ft, ht = null, recordedAt, source }) {
  return { type: 'result', id, ft, ht, recordedAt, source };
}

export function retractionEntry({ target, id, reason, createdAt }) {
  return { type: 'retraction', target, id, reason, createdAt };
}

/**
 * 折叠台账为"每场一个视图"。口径：
 * - 开赛前撤回的预测：视为作废，不计入统计（允许赛前改判，但必须先撤回留痕）。
 * - 开赛后撤回的预测：只留痕，照样计入统计——防止赛后挑掉错的。
 * - 同一场只取最后一条"未被赛前撤回"的预测。
 */
export function foldLedger(entries) {
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const voided = new Set();
  const lateRetractions = new Map();
  for (const entry of entries) {
    if (entry.type !== 'retraction') continue;
    const target = bySeq.get(entry.target);
    if (!target || target.type !== 'prediction') continue;
    if (Date.parse(entry.createdAt) < Date.parse(target.kickoff)) voided.add(target.seq);
    else lateRetractions.set(target.seq, entry);
  }
  const matches = new Map();
  const view = (id) => {
    if (!matches.has(id)) matches.set(id, { id, prediction: null, result: null, voided: [], lateRetraction: null });
    return matches.get(id);
  };
  for (const entry of entries) {
    if (entry.type === 'prediction') {
      const item = view(entry.id);
      if (voided.has(entry.seq)) item.voided.push(entry);
      else {
        item.prediction = entry;
        item.lateRetraction = lateRetractions.get(entry.seq) ?? null;
      }
    } else if (entry.type === 'result') {
      view(entry.id).result = entry;
    }
  }
  return [...matches.values()];
}
