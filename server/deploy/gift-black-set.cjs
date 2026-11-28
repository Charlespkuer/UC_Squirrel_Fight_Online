#!/usr/bin/env node
'use strict';
// 黑色套装四件发放模式：狂战/凤凰/圣熊合计 5%，怒战/深海/机器猫平分 95%；
// 每件 3 条 3 星词条，直接进装备背包并发到账通知邮件（非领取邮件）。

const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || '/var/lib/ssdz';
process.env.GAME_ROOT = process.env.GAME_ROOT || path.resolve(__dirname, '../..');
const runtime = require('../game/runtime');
runtime.boot();
const db = require('../db');
db.open();
const store = require('../game/store');

const AFFIX_COUNT = 3;
const AFFIX_LEVEL = 3;
const SETS = Object.freeze([
  { id: 67, name: '狂战', pieces: [265, 266, 267, 268], weight: 5 / 3 },
  { id: 71, name: '凤凰', pieces: [281, 282, 283, 284], weight: 5 / 3 },
  { id: 72, name: '圣熊', pieces: [285, 286, 287, 288], weight: 5 / 3 },
  { id: 68, name: '怒战', pieces: [269, 270, 271, 272], weight: 95 / 3 },
  { id: 69, name: '深海', pieces: [273, 274, 275, 276], weight: 95 / 3 },
  { id: 70, name: '机器猫', pieces: [277, 278, 279, 280], weight: 95 / 3 },
]);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes('--' + name); }

const MODE = flag('apply') ? 'apply' : flag('verify') ? 'verify' : 'dry-run';
const DATE = arg('date', new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()));
const TITLE = arg('title', '感谢支持');
const ACCOUNTS = String(arg('accounts', '')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

function pickSet() {
  const total = SETS.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const set of SETS) {
    roll -= set.weight;
    if (roll < 0) return set;
  }
  return SETS[SETS.length - 1];
}

function accountOf(id) {
  const row = db.get('SELECT id,name,tag,banned FROM accounts WHERE id = ?', id);
  if (!row) throw new Error('账号 #' + id + ' 不存在');
  if (Number(row.banned) !== 0) throw new Error('账号 #' + id + ' 已封禁');
  if (db.get('SELECT 1 AS hit FROM simulated_accounts WHERE account_id = ?', id)) throw new Error('账号 #' + id + ' 是模拟号');
  if (db.get('SELECT 1 AS hit FROM dev_accounts WHERE account_id = ?', id)) throw new Error('账号 #' + id + ' 是开发号');
  const save = db.get("SELECT 1 AS hit FROM saves WHERE account_id = ? AND mode = 'classic'", id);
  if (!save) throw new Error('账号 #' + id + ' 没有 classic 存档');
  return row;
}

function mailIdOf(id) { return 'gift-thanks:' + id + ':' + DATE + ':set'; }

function buildPreview(id) {
  const row = accountOf(id);
  const saveRow = db.get("SELECT payload FROM saves WHERE account_id = ? AND mode = 'classic'", id);
  const res = runtime.withState(JSON.parse(Buffer.from(saveRow.payload).toString('utf8')), ({ api, save }) => {
    const set = pickSet();
    if (save.gears.length + set.pieces.length > api.gearCapacity()) {
      throw new Error('装备背包不足（' + save.gears.length + '/' + api.gearCapacity() + '）');
    }
    const pieces = set.pieces.map((gid) => {
      const attr = api.rollGearAttr(gid);
      const ext = api.randomExt(AFFIX_COUNT, 3).map((e) => ({ id: e.id, level: AFFIX_LEVEL }));
      const info = api.gearInst(gid, ext, attr);
      return { id: gid, name: info ? info.name : String(gid), attr, ext };
    });
    return { account: row.name, level: save.level, gearCount: save.gears.length, capacity: api.gearCapacity(), set: set.name, setId: set.id, pieces };
  });
  return res.value;
}

function applyOne(id) {
  const row = accountOf(id);
  const mid = mailIdOf(id);
  if (db.get('SELECT 1 AS hit FROM messages WHERE id = ?', mid)) {
    return { account: row.name, id, skipped: true, reason: '邮件已存在' };
  }
  const res = store.runOnSave(id, ({ api, save }) => {
    const set = pickSet();
    if (save.gears.length + set.pieces.length > api.gearCapacity()) {
      throw new Error('装备背包不足（' + save.gears.length + '/' + api.gearCapacity() + '）');
    }
    const granted = set.pieces.map((gid) => {
      const attr = api.rollGearAttr(gid);
      const ext = api.randomExt(AFFIX_COUNT, 3).map((e) => ({ id: e.id, level: AFFIX_LEVEL }));
      const info = api.addGear(gid, ext, attr);
      if (!info) throw new Error('addGear 失败：' + gid);
      return { id: gid, key: info.key, name: info.name, attr, ext };
    });
    return { set: set.name, setId: set.id, granted };
  }, { snapshotSource: 'admin-black-set-gift' });

  const info = res.value;
  const text = '感谢支持！黑色套装四件已放入装备背包：' + info.set +
    '（' + info.granted.map((g) => g.name).join('、') + '），每件 ' + AFFIX_COUNT + ' 条 ' + AFFIX_LEVEL + ' 星词条。请到装备背包查看。';
  const payload = JSON.stringify({
    title: TITLE,
    gearSet: info.setId,
    gears: info.granted.map((g) => ({ id: g.id, key: g.key, attr: g.attr, ext: g.ext })),
    granted: true,
  });
  db.run(
    'INSERT INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
    mid, id, 'announcement', text, payload, Date.now()
  );
  return { account: row.name, id, rev: res.rev, mailId: mid, set: info.set, setId: info.setId, granted: info.granted };
}

function verifyOne(id) {
  const row = accountOf(id);
  const mid = mailIdOf(id);
  const msg = db.get('SELECT id,text,payload,created_at,read_at FROM messages WHERE id = ? AND account_id = ?', mid, id);
  if (!msg) return { account: row.name, id, ok: false, error: '邮件不存在' };
  const payload = JSON.parse(msg.payload || '{}');
  const saveRow = db.get("SELECT payload FROM saves WHERE account_id = ? AND mode = 'classic'", id);
  const save = JSON.parse(Buffer.from(saveRow.payload).toString('utf8'));
  const checks = (payload.gears || []).map((g) => {
    const gear = (save.gears || []).find((x) => String(x.key) === String(g.key));
    const extOk = Array.isArray(g.ext) && g.ext.length === AFFIX_COUNT && g.ext.every((e) => Number(e.level) === AFFIX_LEVEL);
    return { id: g.id, key: g.key, present: !!gear, extOk };
  });
  return { account: row.name, id, ok: checks.every((c) => c.present && c.extOk), mailId: mid, set: payload.gearSet, checks };
}

try {
  if (!ACCOUNTS.length) throw new Error('用法：--accounts 161,87,153,213 [--date 2026-11-28] [--dry-run|--apply|--verify]');
  const out = ACCOUNTS.map((id) => {
    if (MODE === 'verify') return verifyOne(id);
    if (MODE === 'apply') return applyOne(id);
    return buildPreview(id);
  });
  console.log(JSON.stringify({ mode: MODE, date: DATE, title: TITLE, out }, null, 1));
} catch (e) {
  console.error('[gift-black-set] ' + ((e && e.message) || e));
  process.exitCode = 1;
} finally {
  db.close();
}
