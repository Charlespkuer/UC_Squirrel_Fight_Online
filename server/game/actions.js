'use strict';
/* ============================================================
 * server/game/actions.js — 动作白名单 + 服务端执行器
 * ------------------------------------------------------------
 * 客户端只发「动作名 + 参数」，服务端在自己的权威存档上跑同一个 `State` API，
 * 再把**变更 patch** 发回去。三条保证它当得了权威：
 *  1. 白名单：`shared/actions.json` 是唯一真值，客户端从 `/api/meta` 拿同一份；
 *  2. 参数校验：只接受原语/小数组/浅对象，超限直接拒；
 *  3. 同步执行：载入 → 跑 → 写回 中间**不能 await**（`State` 是模块级单例）。
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const store = require('./store');
const snapshots = require('./snapshot');
const settlement = require('./settlement');

const DEFS_PATH = path.resolve(__dirname, '..', '..', 'shared', 'actions.json');
const DEFS = JSON.parse(fs.readFileSync(DEFS_PATH, 'utf8'));
const ACTIONS = DEFS.actions;
const SERVER_ONLY = new Set(DEFS.serverOnly || []);
const LIMITS = DEFS.limits || {};

/* 金宝箱三连：读档时必须保留 `chestPending`，否则 `reopenChest` 永远拿不到箱子，
 * 联机版 10 次重开上限也就不可达。见 `runtime.withState` 的 `deferSettle`。 */
const CHEST_PENDING_ACTIONS = new Set(['beginChest', 'reopenChest', 'confirmChest', 'openChestProp']);

/** 会改变战斗面板的动作：跑完保证「当前等级」有一条 is_current 快照。 */
const LOADOUT_TOUCHING = new Set([
  'doUpgrade', 'wear', 'unwear', 'composeGear', 'mergeGears', 'socketGem', 'unsocketGem',
  'mergeGems', 'chooseWS', 'chooseWSRandom', 'gainRandomWS', 'applyFruitChoice', 'learnSkill',
  'setWS', 'forgetWS', 'composeSeed', 'allocatePoint', 'allocateEvenly',
  'undoPoint', 'hatchPet', 'setPetTeam', 'feedPet', 'evolvePet', 'buyProp', 'rankBuy', 'useProp', 'usePropMany',
  'openChestProp', 'confirmChest', 'reopenChest', 'miracleRecord', 'claimQuest', 'claimDaily',
  'upgradeBuilding', 'claimBuildingBuff', 'sellGear', 'lotteryDraw', 'grantStarterGear', 'buyVip',
]);

function actionDef(name) {
  const key = String(name || '');
  if (SERVER_ONLY.has(key)) return null;
  const def = ACTIONS[key];
  if (!def) return null;
  if (def.mode === 'local') return null;
  return def;
}

/* ---------------- 参数校验 ---------------- */
function checkValue(value, depth) {
  if (depth > (LIMITS.maxObjectDepth || 3)) return false;
  const t = typeof value;
  if (value === null || t === 'boolean' || t === 'number' || t === 'string') return true;
  if (Array.isArray(value)) {
    if (value.length > (LIMITS.maxArrayLength || 32)) return false;
    return value.every((v) => checkValue(v, depth + 1));
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length > (LIMITS.maxObjectKeys || 24)) return false;
    return keys.every((k) => checkValue(value[k], depth + 1));
  }
  return false;
}

function coerce(type, value) {
  const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_REQUEST'; return e; };
  switch (type) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw bad('参数必须是整数');
      const v = Math.trunc(n);
      if (!Number.isSafeInteger(v)) throw bad('整数超出范围');
      return v;
    }
    case 'num': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw bad('参数必须是数字');
      return n;
    }
    case 'str': {
      const s = String(value == null ? '' : value);
      if (s.length > (LIMITS.maxStringLength || 64)) throw bad('字符串太长');
      return s;
    }
    case 'bool': return !!value;
    case 'keys': {
      const list = Array.isArray(value) ? value : (value == null ? [] : [value]);
      if (list.length > (LIMITS.maxArrayLength || 32)) throw bad('列表太长');
      return list.map((x) => String(x == null ? '' : x).slice(0, 128));
    }
    case 'any':
    default: {
      if (value === undefined) return null; // useProp 的可选第二参数。
      if (!checkValue(value, 0)) throw bad('参数结构不合法');
      return value;
    }
  }
}

function coerceArgs(def, args) {
  const list = Array.isArray(args) ? args : [];
  const spec = def.args || [];
  if (list.length > spec.length) {
    const e = new Error('参数过多（期望 ' + spec.length + ' 个）');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  return spec.map((type, i) => coerce(type, list[i]));
}

/* ---------------- 执行 ---------------- */
/** 果实候选只由服务器抽取并随权威存档持久化，重复打开不能重抽。 */
function invokeAction(api, save, name, args) {
  const id = args[0];
  if (name === 'applyFruitChoice') {
    const pending = save.__onlineFruitChoices && save.__onlineFruitChoices[id];
    if (!pending || !Array.isArray(pending.options) || !pending.options.some(c => c.kind === args[1] && Number(c.id) === args[2])) {
      const e = new Error('请选择服务器给出的果实候选'); e.code = 'BAD_REQUEST'; throw e;
    }
    const value = api.applyFruitChoice(...args);
    if (value && value.ok) {
      save.__onlineFruitChoices = { ...save.__onlineFruitChoices };
      delete save.__onlineFruitChoices[id];
    }
    return value;
  }
  if (['fruitOptions', 'useProp', 'usePropMany'].includes(name) && (id === 47 || id === 48)) {
    if (!(save.props[id] > 0)) return name === 'fruitOptions' ? null : { ok: false, msg: '没有该道具' };
    const choices = { ...save.__onlineFruitChoices };
    const pending = choices[id] || api.fruitOptions(id);
    if (!pending || !Array.isArray(pending.options) || !pending.options.length) {
      return name === 'fruitOptions' ? null : { ok: false, msg: '没有可选择的武器或技能' };
    }
    choices[id] = pending;
    save.__onlineFruitChoices = choices; // 不修改 runOnSave 用来计算 diff 的旧档嵌套对象。
    return name === 'fruitOptions' ? pending : {
      ok: false, needsFruitChoice: true, fruit: id, mode: pending.mode, options: pending.options, msg: '请从三个里选一个',
    };
  }
  const fn = api[name];
  if (typeof fn !== 'function') throw new Error('State 里没有这个动作：' + name);
  return fn.apply(api, args);
}

/**
 * @returns {{ok:boolean, result:any, rev:number, patch:object|null, summary:object}}
 */
function execute({ accountId, name, args, rev, ip }) {
  if (!Number.isSafeInteger(rev) || rev <= 0) {
    const e = new Error('rev 必须是正整数，请重新同步存档'); e.code = 'BAD_REQUEST'; throw e;
  }
  const def = actionDef(name);
  if (!def) {
    const e = new Error('动作不在白名单里：' + name);
    e.code = 'FORBIDDEN';
    throw e;
  }
  const callArgs = coerceArgs(def, args);
  const row = store.getRow(accountId);
  if (!row) {
    const e = new Error('还没有存档，请先创建角色');
    e.code = 'CONFLICT';
    throw e;
  }
  const revBefore = Number(row.revision);
  if (rev !== revBefore) {
    const e = new Error('存档版本不一致（可能另开了一个窗口）');
    e.code = 'CONFLICT';
    e.extra = { rev: revBefore };
    throw e;
  }
  let out;
  try {
    out = store.runOnSave(accountId, ({ api, save }) => {
      /* 天梯商店按积分限购：积分真值在 ratings（每周一重置），存档镜像可能落后。
       * 行动前先对齐，避免拿旧档的分数通过积分门槛。 */
      if (name === 'rankBuy') save.integral = settlement.ratingOf(accountId);
      const value = invokeAction(api, save, name, callArgs);
      return value === undefined ? null : value;
    }, {
      expectRev: rev,
      row,
      snapshotSource: LOADOUT_TOUCHING.has(name) ? 'action:' + name : '',
      deferSettle: CHEST_PENDING_ACTIONS.has(name),
    });
  } catch (e) {
    db.run(
      'INSERT INTO action_log (account_id, name, args, rev_before, rev_after, ok, msg, ip, created_at) VALUES (?,?,?,?,?,0,?,?,?)',
      Number(accountId), String(name), JSON.stringify(callArgs).slice(0, 2000),
      revBefore, revBefore, String((e && e.message) || '').slice(0, 300), String(ip || ''), Date.now()
    );
    throw e;
  }
  if (out.changed) {
    db.run(
      'INSERT INTO action_log (account_id, name, args, rev_before, rev_after, ok, msg, ip, created_at) VALUES (?,?,?,?,?,1,?,?,?)',
      Number(accountId), String(name), JSON.stringify(callArgs).slice(0, 2000),
      revBefore, out.rev, '', String(ip || ''), Date.now()
    );
  }
  return { ok: true, result: out.value, rev: out.rev, patch: out.patch, summary: out.summary };
}

module.exports = { actionDef, execute, ACTIONS, SERVER_ONLY, DEFS, coerceArgs };
