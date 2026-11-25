#!/usr/bin/env node
'use strict';
/* 天梯周奖励新口径：换周时冻结上周日 23:59 的最终名次，下一周只按这份快照结算。
   覆盖：名次/场次/超过人机、隐身双榜、旧周已领过不重复、没参赛无记录、积分照常减半。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'out', '_ladder-award-' + process.pid + '-' + Date.now().toString(36));
process.env.DATA_DIR = dir;
process.env.GAME_ROOT = ROOT;

const db = require(path.join(ROOT, 'server', 'db.js'));
db.open({ dir });
const runtime = require(path.join(ROOT, 'server', 'game', 'runtime.js'));
const store = require(path.join(ROOT, 'server', 'game', 'store.js'));
const settlement = require(path.join(ROOT, 'server', 'game', 'settlement.js'));
const visibility = require(path.join(ROOT, 'server', 'game', 'visibility.js'));
runtime.boot();

let seq = 0;
function makeAccount(name, level) {
  const ts = Date.now();
  db.run(`INSERT INTO accounts (name,tag,pass_hash,pass_salt,recovery_hash,created_at,last_seen)
          VALUES (?,?,?,?,?,?,?)`, name, String(++seq).padStart(4, '0'), 'x', 'y', 'z', ts, ts);
  const id = Number(db.get('SELECT id FROM accounts WHERE name = ?', name).id);
  store.createSave(id, name);
  store.runOnSave(id, ({ save }) => { save.level = level; });
  return id;
}
function setRating(id, week, score, wins, losses) {
  db.run('DELETE FROM ratings WHERE account_id = ?', id);
  db.run('INSERT INTO ratings (account_id, season, score, wins, losses, streak, updated_at) VALUES (?,?,?,?,?,0,?)',
    id, week, score, wins, losses, Date.now());
}

try {
  const current = settlement.weekKey();
  const prev = settlement.previousWeekKey(current);
  assert.ok(current > prev, '周键必须递增');
  const A = makeAccount('终榜甲', 40);
  const B = makeAccount('终榜乙', 40);
  const C = makeAccount('终榜丙', 40);
  const D = makeAccount('终榜隐身', 40);
  const E = makeAccount('终榜新号', 40);

  // 周一第一次请求时人机还是旧周的 300 分；capture 必须看到这份，而不是新周重置后的分数。
  settlement.ensureBots(current);
  db.run('UPDATE rank_bots SET week = ?, score = 300, wins = 0, losses = 0', prev);
  setRating(A, prev, 800, 3, 1);
  setRating(B, prev, 500, 1, 0);
  setRating(C, prev, 450, 2, 2);
  setRating(D, prev, 900, 2, 1);
  visibility.setHidden([D], Date.now() + 86400000, 'test');
  db.run("UPDATE meta SET value = ? WHERE key = 'rank_week'", prev);
  // 旧口径下已经领过这一周的奖：换周后同一周不能再发一次。
  db.run('INSERT INTO rank_awards (account_id, week, rank, cups, created_at) VALUES (?,?,1,?,?)',
    C, prev, 50, Date.now());

  // 第一次读取触发换周：先 capture 旧周终榜，再迁移积分 / 重置人机。
  const aAward = settlement.rankAwardStatus(A);
  assert.equal(aAward.mode, 'final');
  assert.equal(aAward.week, prev);
  assert.equal(aAward.currentWeek, current);
  assert.equal(aAward.rank, 1, 'A 的普通视角排第 1（隐身 D 不占普通榜名额）');
  assert.equal(aAward.played, 4);
  assert.equal(aAward.eligible, true);
  assert.equal(aAward.claimed, false);
  assert.match(aAward.msg, /^$/);

  const finals = db.get('SELECT * FROM rank_finals WHERE account_id = ? AND week = ?', A, prev);
  assert.ok(finals, '换周时必须写 rank_finals');
  assert.deepEqual(
    [finals.division, finals.rank, finals.rank_hidden, finals.played, finals.surpassed_bot, finals.surpassed_bot_hidden],
    ['d40', 1, 2, 4, 1, 1],
    '终榜要同时记普通视角名次与隐身视角名次：' + JSON.stringify(finals)
  );

  const dHidden = settlement.rankAwardStatus(D);
  assert.equal(dHidden.rank, 1, '隐身账号按含隐身的全榜算，D 是第 1');
  assert.equal(dHidden.eligible, true);
  // 取消隐身后仍按 D 的分数（900）排在 A 前面；两种视角下 D 都是第 1。
  visibility.clearHidden([D]);
  assert.equal(settlement.rankAwardStatus(D).rank, 1);

  const eAward = settlement.rankAwardStatus(E);
  assert.equal(eAward.mode, 'final');
  assert.equal(eAward.noRecord, true);
  assert.equal(eAward.eligible, false);
  assert.equal(settlement.claimRankAward(E).ok, false);

  assert.equal(settlement.rankAwardStatus(C).claimed, true, '旧周已领过要显示已领取');
  assert.equal(settlement.claimRankAward(C).already, true);

  const claim = settlement.claimRankAward(A);
  assert.equal(claim.ok, true);
  assert.equal(claim.week, prev);
  assert.equal(claim.rank, 1);
  assert.equal(claim.cups, 50);
  assert.equal(settlement.claimRankAward(A).already, true, '同周只能领一次');

  const currentRating = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', A, current);
  assert.ok(currentRating && currentRating.score === 400 && currentRating.wins === 0 && currentRating.losses === 0,
    '换周仍照常把积分减半、胜负清零：' + JSON.stringify(currentRating));
  const bot = db.get('SELECT * FROM rank_bots LIMIT 1');
  assert.equal(String(bot.week), current, '人机重置到新周');

  console.log('PASS 天梯周奖励：上周日 23:59 终榜快照 / 隐身双榜 / 旧周已领不重复 / 下周结算一次');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
