import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFootballData } from '../src/sources.mjs';

const HEAD = 'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,HTHG,HTAG,HST,AST,B365H,B365D,B365A,B365>2.5,B365<2.5';
const csv = (...lines) => `﻿${HEAD}\n${lines.join('\n')}\n`;
const base = [{ league: 'E0', date: '2026-09-01', time: '15:00', home: 'Arsenal', away: 'Chelsea', fthg: '2', ftag: '1', hthg: '1', htag: '0', odd_h: '1.9', odd_d: '3.6', odd_a: '4.2', odd_over25: '1.8', odd_under25: '2.0', hst: '6', ast: '3', home_elo: '2000', away_elo: '1850' }];
const OVERLAP = 'E0,01/09/2026,15:00,Arsenal,Chelsea,2,1,1,0,6,3,1.9,3.6,4.2,1.8,2.0';
const NEW = 'E0,20/11/2026,20:00,Liverpool,Everton,3,0,2,0,8,1,1.3,5.5,9,1.5,2.6';
const OLD_GAP = 'E0,15/08/2026,15:00,Fulham,Brentford,1,1,0,0,3,3,2.5,3.3,2.9,1.9,1.9';
const UNPLAYED = 'E0,30/11/2026,15:00,Spurs,Wolves,,,,,,,2.0,3.5,3.8,1.7,2.1';

test('双源一致、重叠一致：只追加样本库最后一天之后的已完场比赛', () => {
  const text = csv(OVERLAP, NEW, OLD_GAP, UNPLAYED);
  const r = mergeFootballData(base, { E0: [text, text] });
  assert.equal(r.overlap, 1);
  assert.equal(r.appended, 1, '历史缺口（08-15）不补，未完场不收');
  const added = r.rows.at(-1);
  assert.deepEqual([added.date, added.home, added.fthg, added.ftag, added.hst, added.odd_h, added.home_elo], ['2026-11-20', 'Liverpool', '3', '0', '8', '1.3', '']);
  assert.deepEqual(r.rows[0], base[0], '历史行原样保留');
});

test('两个镜像内容不一致：整批拒绝', () => {
  assert.throws(() => mergeFootballData(base, { E0: [csv(OVERLAP, NEW), csv(OVERLAP, NEW.replace(',3,0,', ',2,0,'))] }), /双源核验失败/);
});

test('重叠场次与样本库不一致：整批拒绝', () => {
  const text = csv(OVERLAP.replace(',6,3,', ',7,3,'), NEW);
  assert.throws(() => mergeFootballData(base, { E0: [text, text] }), /hst 不一致/);
  const odds = csv(OVERLAP.replace(',1.9,3.6,', ',2.1,3.6,'), NEW);
  assert.throws(() => mergeFootballData(base, { E0: [odds, odds] }), /odd_h 不一致/);
});
