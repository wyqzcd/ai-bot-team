/**
 * 第二数据源：football-data.co.uk 的 GitHub 镜像（样本库原始来源的上游，每周更新两次）。
 *
 * 接入规则（任何一条不满足就拒绝，不做部分接入）：
 *   1. 双源核验：两个互相独立的镜像，同一联赛文件必须逐字节一致。
 *   2. 重叠核验：与现有样本库重叠的场次，比分、射正、Bet365 胜平负与大小球赔率必须完全一致。
 *   3. 只追加：只接入现有样本库最后一天之后的比赛，历史部分一行不动（回测台账因此不受影响）。
 * 新接入的场次没有 ClubElo（该源不提供），home_elo/away_elo 留空。
 */
import { createHash } from 'node:crypto';
import { parseCsv } from './csv.mjs';
import { LEAGUES, canonicalTeam } from './dataset.mjs';

export const FD_MIRRORS = [
  'https://raw.githubusercontent.com/Char2mant/futbol-veri-aynasi/main/data/fd',
  'https://raw.githubusercontent.com/maparan1903-bit/futbol-veri-deposu/main/data/fd',
];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const intText = (value) => (value === undefined || value === '' ? '' : String(Math.round(Number(value))));

function isoDate(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy ?? '');
  if (!m) throw new RangeError(`football-data 日期格式非法：${dmy}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** football-data 一行 → 样本库列 */
export function fdRowToDataset(league, r) {
  return {
    league,
    date: isoDate(r.Date),
    time: r.Time ? r.Time.slice(0, 5) : '',
    home: canonicalTeam(r.HomeTeam),
    away: canonicalTeam(r.AwayTeam),
    fthg: intText(r.FTHG),
    ftag: intText(r.FTAG),
    hthg: intText(r.HTHG),
    htag: intText(r.HTAG),
    odd_h: r.B365H ?? '',
    odd_d: r.B365D ?? '',
    odd_a: r.B365A ?? '',
    odd_over25: r['B365>2.5'] ?? '',
    odd_under25: r['B365<2.5'] ?? '',
    hst: intText(r.HST),
    ast: intText(r.AST),
    home_elo: '',
    away_elo: '',
  };
}

const sameNumber = (a, b) => (a === '' && b === '') || (a !== '' && b !== '' && Math.abs(Number(a) - Number(b)) < 1e-9);

/**
 * @param {object[]} baseRows 现有样本库行（DATASET_COLUMNS）
 * @param {{ [key]: [textA, textB] }} files 键为 "<联赛>" 或 "<联赛>@<赛季>"（如 E0@2627），值为两个镜像的原文
 * @returns {{ rows, appended, overlap, sources }} rows = base + 追加（已排序）
 */
export function mergeFootballData(baseRows, files) {
  const errors = [];
  const sources = {};
  const baseById = new Map(baseRows.map((r) => [`${r.league}|${r.date}|${r.home}|${r.away}`, r]));
  const baseMax = baseRows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const appended = [];
  let overlap = 0;
  for (const [key, [a, b]] of Object.entries(files)) {
    const league = key.split('@')[0];
    if (!(league in LEAGUES)) throw new RangeError(`未建模联赛：${league}`);
    if (a !== b) errors.push(`${key}：两个镜像内容不一致（双源核验失败）`);
    sources[key] = sha256(a);
    for (const raw of parseCsv(a.replace(/^﻿/, ''))) {
      if (raw.FTHG === '' || raw.FTAG === '' || raw.FTHG === undefined) continue; // 未完场
      const row = fdRowToDataset(league, raw);
      const id = `${row.league}|${row.date}|${row.home}|${row.away}`;
      const base = baseById.get(id);
      if (base) {
        overlap += 1;
        for (const k of ['fthg', 'ftag', 'hst', 'ast']) if (base[k] !== row[k]) errors.push(`${id}：${k} 不一致（样本库 ${base[k]}，镜像 ${row[k]}）`);
        for (const k of ['odd_h', 'odd_d', 'odd_a']) if (!sameNumber(base[k], row[k])) errors.push(`${id}：${k} 不一致（样本库 ${base[k]}，镜像 ${row[k]}）`);
        continue;
      }
      if (row.date > baseMax) appended.push(row);
    }
  }
  if (errors.length) throw new RangeError(`football-data 镜像接入被拒绝：\n  ${errors.slice(0, 20).join('\n  ')}${errors.length > 20 ? `\n  ……另有 ${errors.length - 20} 条` : ''}`);
  const rows = [...baseRows, ...appended].sort((x, y) => (x.date + x.time + x.league + x.home < y.date + y.time + y.league + y.home ? -1 : 1));
  return { rows, appended: appended.length, overlap, sources, baseMax };
}
