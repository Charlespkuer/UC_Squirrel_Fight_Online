'use strict';
// server/game/store.js — 权威存档的读写原语
// 所有会改存档的服务端逻辑都从这里进出：
// 回调里不能 await（State 是单例，await 会让两个请求串档）。

const db = require('../db');
const runtime = require('./runtime');
const snapshots = require('./snapshot');
const vip = require('./vip');
const nickname = require('../../js/nickname');

const MODE = 'classic';
// 旧账号最多 12 个汉字（36 个“三分之一字”）：存档/快照里的旧名字保留原样，
const LEGACY_NAME_UNITS = 36;

function encode(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

// node:sqlite 的 BLOB 读回来是 Uint8Array（不是 Buffer）——统一成 Buffer 再解码，
// 否则 `String(blob)` 会得到 "123,34,..." 这种字节列表，JSON.parse 直接炸。
function toBuffer(blob) {
  if (blob == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof Uint8Array) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (typeof blob === 'string') return Buffer.from(blob, 'utf8');
  return Buffer.from(String(blob), 'utf8');
}

function decode(blob) {
  return JSON.parse(toBuffer(blob).toString('utf8'));
}

function getRow(accountId, mode) {
  return db.get('SELECT * FROM saves WHERE account_id = ? AND mode = ?', Number(accountId), mode || MODE);
}

function summaryOf(payload) {
  const s = payload || {};
  const num = (v) => Math.max(0, Math.round(Number(v) || 0));
  const v = s.vip && typeof s.vip === 'object' && !Array.isArray(s.vip) ? s.vip : {};
  return {
    level: Math.max(1, num(s.level) || 1),
    name: nickname.truncate(s.name || '', LEGACY_NAME_UNITS),
    power: num(s.power), agility: num(s.agility), speed: num(s.speed), hp: num(s.maxHp),
    gold: num(s.goldPoint), goldCup: num(s.goldCup), integral: num(s.integral),
    vipLevel: Math.max(0, Math.min(vip.MAX_LEVEL, Math.floor(Number(v.level) || 0))),
    vipUntil: Math.max(0, Math.floor(Number(v.until) || 0)),
  };
}

// 顶层键 diff：只把变了的键发回客户端。
function diffPayload(before, after) {
  const set = {};
  const del = [];
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  for (const key of Object.keys(b)) {
    const av = a[key], bv = b[key];
    if (!(key in a)) { set[key] = bv; continue; }
    if (av === bv) continue;
    if (typeof av !== 'object' || typeof bv !== 'object' || av === null || bv === null) { set[key] = bv; continue; }
    if (!deepEqual(av, bv)) set[key] = bv;
  }
  for (const key of Object.keys(a)) if (!(key in b)) del.push(key);
  return { set, del };
}

// JSON 可表示值的深比较。替代每个顶层键一次 `JSON.stringify`：
// 这里只做逐值比较，不分配大字符串；数组/对象顺序不影响结果。
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArray = Array.isArray(a), bArray = Array.isArray(b);
  if (aArray !== bArray) return false;
  if (aArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// 服务端时间推进：体力/每日/村庄日常。幂等，失败不影响主流程。
function housekeeping() {
  const S = globalThis.State;
  if (!S) return;

  try { S.tickEnergy(); } catch (_) {}
  try { S.settleBuildings(); } catch (_) {}
  try { if (S.syncLotteryDay) S.syncLotteryDay(); } catch (_) {}
}

// 在权威存档上执行同步回调并写回。
// 回调签名 `({ api, save })`：`api` 是 State 模块，`save` 是当前存档对象。
function runOnSave(accountId, fn, opts) {
  const o = opts || {};
  const mode = o.mode || MODE;

  const row = o.row || getRow(accountId, mode);
  if (!row) {
    const e = new Error('还没有存档');
    e.code = 'CONFLICT';
    throw e;
  }
  if (o.expectRev != null && Number(o.expectRev) > 0 && Number(o.expectRev) !== Number(row.revision)) {
    const e = new Error('存档版本不一致，请重新同步');
    e.code = 'CONFLICT';
    e.extra = { rev: Number(row.revision) };
    throw e;
  }
  const before = decode(row.payload);
  let value;
  let after;
  try {
    const out = runtime.withState(before, (ctx) => {
      housekeeping();
      return fn(ctx);
    }, { deferSettle: !!o.deferSettle });
    value = out.value;
    after = out.payload;
  } catch (e) {
    throw e;
  }
  return commit(accountId, mode, row, before, after, value, o);
}

function commit(accountId, mode, row, before, after, value, o) {
  const patch = diffPayload(before, after);
  const changed = Object.keys(patch.set).length > 0 || patch.del.length > 0;
  const summary = summaryOf(after);
  let rev = Number(row.revision);
  if (changed) {
    rev = Number(row.revision) + 1;
    db.run(
      `UPDATE saves SET revision = ?, payload = ?, level = ?, name = ?, power = ?, agility = ?, speed = ?, hp = ?,
        gold = ?, gold_cup = ?, integral = ?, vip_level = ?, vip_until = ?, updated_at = ? WHERE account_id = ? AND mode = ?`,
      rev, encode(after), summary.level, summary.name, summary.power, summary.agility, summary.speed, summary.hp,
      summary.gold, summary.goldCup, summary.integral, summary.vipLevel, summary.vipUntil, Date.now(),
      Number(accountId), mode
    );
    if (o.snapshotSource) snapshots.ensureCurrent(accountId, mode, o.snapshotSource);
  }
  return { value, patch: changed ? patch : null, rev, payload: after, summary, changed };
}

// 新建账号时的初始存档。
function createSave(accountId, name, mode) {
  const m = mode || MODE;
  const out = runtime.withState(null, ({ save }) => {
    save.name = nickname.truncate(name || '', LEGACY_NAME_UNITS) || '小松鼠';
    return save.name;
  });
  const payload = out.payload;
  const sum = summaryOf(payload);
  const ts = Date.now();
  db.run(
    `INSERT INTO saves (account_id, mode, revision, payload, level, name, power, agility, speed, hp, gold, gold_cup, integral, vip_level, vip_until, updated_at)
     VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    Number(accountId), m, encode(payload), sum.level, sum.name, sum.power, sum.agility, sum.speed, sum.hp,
    sum.gold, sum.goldCup, sum.integral, sum.vipLevel, sum.vipUntil, ts
  );
  snapshots.ensureCurrent(accountId, m, 'newgame');
  return payload;
}

// 改昵称：同步存档显示名 + 当前防守快照里的名字；返回和动作一样的 patch/rev。
function rename(accountId, name, mode) {
  const m = mode || MODE;
  if (!getRow(accountId, m)) return null;
  const clean = nickname.truncate(name || '', LEGACY_NAME_UNITS) || '小松鼠';
  const out = runOnSave(accountId, ({ save }) => { save.name = clean; }, { mode: m, snapshotSource: 'rename' });
  snapshots.renameCurrent(accountId, m, clean);
  return out;
}

// 读一份存档（不修改）。
function peek(accountId, mode) {
  const row = getRow(accountId, mode);
  return row ? decode(row.payload) : null;
}

module.exports = {
  MODE, encode, decode, toBuffer, getRow, summaryOf, diffPayload, deepEqual,
  housekeeping, runOnSave, createSave, rename, peek,
};
