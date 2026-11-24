/**
 * 竞彩接入：把竞彩场次（中文联赛/队名、北京时间、胜平负赔率）映射成 football 的 fixture。
 *
 * 口径：
 * - 联赛只认对照表里的五大联赛，其余记为 not_covered（模型没建模，不出预测，也不硬凑）。
 * - 队名精确匹配：NFKC 归一化 + 去空白后查表，查不到就是 unmapped，绝不模糊猜测。
 * - 胜平负（had）赔率只作对照基线写进 market，不进模型；让球胜平负不使用。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FOOTBALL_ROOT, LEAGUES } from './dataset.mjs';
import { foldLedger } from './ledger.mjs';

export const DEFAULT_TEAM_MAP = path.join(FOOTBALL_ROOT, 'data', 'jczq-teams.json');

export const normalizeName = (name) => String(name ?? '').normalize('NFKC').replace(/\s+/g, '');

/**
 * 校验并编译对照表。datasetTeams（可选）：{ league: Set<样本库队名> }，传入时校验队名真实存在。
 * @returns {{ leagues: Map<string,string>, teams: Map<string, Map<string,string>>, errors: string[] }}
 */
export function compileTeamMap(doc, datasetTeams = null) {
  const errors = [];
  const leagues = new Map();
  const teams = new Map();
  for (const [zh, code] of Object.entries(doc?.leagues ?? {})) {
    if (!(code in LEAGUES)) errors.push(`联赛 ${zh} → ${code}：不是已建模联赛`);
    leagues.set(normalizeName(zh), code);
  }
  for (const [code, table] of Object.entries(doc?.teams ?? {})) {
    if (!(code in LEAGUES)) {
      errors.push(`teams.${code}：不是已建模联赛`);
      continue;
    }
    const aliases = new Map();
    for (const [datasetName, zhNames] of Object.entries(table)) {
      if (datasetTeams && !datasetTeams[code]?.has(datasetName)) errors.push(`${code}.${datasetName}：样本库里没有这支球队`);
      if (!Array.isArray(zhNames) || zhNames.length === 0) {
        errors.push(`${code}.${datasetName}：至少需要一个中文名`);
        continue;
      }
      for (const zh of zhNames) {
        const key = normalizeName(zh);
        if (key === '') errors.push(`${code}.${datasetName}：中文名为空`);
        else if (aliases.has(key) && aliases.get(key) !== datasetName) {
          errors.push(`${code}：别名「${zh}」同时指向 ${aliases.get(key)} 与 ${datasetName}`);
        } else aliases.set(key, datasetName);
      }
    }
    teams.set(code, aliases);
  }
  return { leagues, teams, errors };
}

export function loadTeamMap(file = DEFAULT_TEAM_MAP, datasetTeams = null) {
  const compiled = compileTeamMap(JSON.parse(readFileSync(file, 'utf8')), datasetTeams);
  if (compiled.errors.length) throw new RangeError(`竞彩队名对照表非法：\n  ${compiled.errors.join('\n  ')}`);
  return compiled;
}

/** 样本库里每个联赛出现过的队名，用于校验对照表。 */
export function datasetTeamSets(matches) {
  const out = {};
  for (const m of matches) {
    out[m.league] ??= new Set();
    out[m.league].add(m.home);
    out[m.league].add(m.away);
  }
  return out;
}

/** 竞彩看板 fixture（scripts/jczq-board.mjs 的 schema）→ 全部场次（含单一市场未开售的 unclassified）。 */
export function boardMatches(boardFixture) {
  return [...(boardFixture.matches ?? []), ...(boardFixture.unclassified ?? [])];
}

/**
 * 逐场解析。status：
 *   ready        可出预测
 *   not_covered  非五大联赛，模型未覆盖
 *   unmapped     五大联赛但队名不在对照表
 *   locked       已开赛（now ≥ kickoff），禁止预测
 *   already      实盘台账里已有有效预测（不重复出，改判走 predict.mjs --replace）
 *   settled      实盘台账里已有赛果
 */
export function resolveJczq(boardFixture, teamMap, { liveEntries = [], now }) {
  const nowMs = Date.parse(now);
  const folded = new Map(foldLedger(liveEntries).map((item) => [item.id, item]));
  return boardMatches(boardFixture).map((m) => {
    const ref = { no: m.no, league: m.league, home: m.home, away: m.away, kickoff: m.kickoff };
    const code = teamMap.leagues.get(normalizeName(m.league));
    if (!code) return { status: 'not_covered', ref, reason: `联赛「${m.league}」未建模` };
    const aliases = teamMap.teams.get(code) ?? new Map();
    const home = aliases.get(normalizeName(m.home));
    const away = aliases.get(normalizeName(m.away));
    if (!home || !away) {
      const missing = [!home && m.home, !away && m.away].filter(Boolean);
      return { status: 'unmapped', ref, league: code, missing, reason: `${code} 队名不在对照表：${missing.join('、')}` };
    }
    const kickoffZ = new Date(Date.parse(m.kickoff)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const id = `${code}|${kickoffZ.slice(0, 10)}|${home}|${away}`;
    const fixture = { league: code, kickoff: m.kickoff, home, away, odds: Array.isArray(m.spf) ? m.spf : null };
    const existing = folded.get(id);
    if (existing?.result) return { status: 'settled', ref, id, fixture, reason: `已有赛果 #${existing.result.seq}` };
    if (existing?.prediction) return { status: 'already', ref, id, fixture, reason: `已有预测 #${existing.prediction.seq}` };
    if (!(nowMs < Date.parse(m.kickoff))) return { status: 'locked', ref, id, fixture, reason: `已开赛（${m.kickoff}），锁定` };
    return { status: 'ready', ref, id, fixture };
  });
}

export function summarize(rows) {
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

/**
 * 竞彩编号（如 周六001）每周复用，只在"尚未录赛果"的实盘预测里找；必须恰好命中一场，否则拒绝。
 */
export function resolveJczqNo(no, refs, liveEntries) {
  const open = new Set(foldLedger(liveEntries).filter((x) => x.prediction && !x.result).map((x) => x.id));
  const hits = Object.entries(refs).filter(([id, ref]) => ref.no === no && open.has(id)).map(([id]) => id);
  if (hits.length !== 1) {
    throw new RangeError(hits.length === 0 ? `没有待录赛果的竞彩场次 ${no}` : `竞彩编号 ${no} 对应多场未结算预测：${hits.join('、')}，请改用 --id`);
  }
  return hits[0];
}
