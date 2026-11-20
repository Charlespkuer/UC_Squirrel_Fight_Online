'use strict';
// server/game/actions.js — 动作白名单 + 服务端执行器
// 客户端只发「动作名 + 参数」，服务端在自己的权威存档上跑同一个 `State` API，
// 1. 白名单：`shared/actions.json` 是唯一真值，客户端从 `/api/meta` 拿同一份；

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

// 金宝箱 begin/confirm：读档时必须保留 `chestPending`，否则确认前那次读档会先把结果自动入账。
const CHEST_PENDING_ACTIONS = new Set(['beginChest', 'confirmChest', 'openChestProp']);

// 会改变战斗面板的动作：跑完保证「当前等级」有一条 is_current 快照。
const LOADOUT_TOUCHING = new Set([
  'doUpgrade', 'wear', 'unwear', 'composeGear', 'mergeGears', 'socketGem', 'unsocketGem',
  'mergeGems', 'chooseWS', 'chooseWSRandom', 'gainRandomWS', 'applyFruitChoice', 'learnSkill',
  'setWS', 'forgetWS', 'composeSeed',
  'hatchPet', 'setPetTeam', 'feedPet', 'evolvePet', 'buyProp', 'rankBuy', 'useProp', 'usePropMany',
  'openChestProp', 'confirmChest', 'miracleRecord', 'claimQuest', 'claimDaily',
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
      if (value === undefined) return null;
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

// 果实候选只由服务器抽取并随权威存档持久化，重复打开不能重抽。
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
  if (name === 'cancelFruitChoice') {
    // 取消这次随机结果：果实照常消耗，服务端把它记进 fruitSeen（下一次不重复给）。
    const pending = save.__onlineFruitChoices && save.__onlineFruitChoices[id];
    if (!pending || !Array.isArray(pending.options) || !pending.options.length) {
      const e = new Error('这次随机结果已经结算过了'); e.code = 'BAD_REQUEST'; throw e;
    }
    return api.cancelFruitChoice(...args);
  }
  if (['fruitOptions', 'useProp', 'usePropMany'].includes(name) && (id === 47 || id === 48)) {
    if (!(save.props[id] > 0)) return name === 'fruitOptions' ? null : { ok: false, msg: '没有该道具' };
    const choices = { ...save.__onlineFruitChoices };
    const pending = choices[id] || api.fruitOptions(id);
    if (!pending || !Array.isArray(pending.options) || !pending.options.length) {
      return name === 'fruitOptions' ? null : { ok: false, msg: '没有可选择的武器或技能' };
    }
    choices[id] = pending;
    save.__onlineFruitChoices = choices;
    return name === 'fruitOptions' ? pending : {
      ok: false, needsFruitChoice: true, fruit: id, mode: pending.mode, options: pending.options, msg: '请确认这次随机结果',
    };
  }
  // 无尽塔结算：塔对局在本机，服务端只收「通过层数 + 结算时铸币数 + 对局编号」。
  // 周上限是经济闸门（最多 10 张/周，通过 >=100 层每周另加 2 张），同一 runId 重复提交幂等。
  // 第 4 个参数只为兼容仍带结局标记的旧客户端；百层奖励在 TowerRewards.settle 里按层数判定。
  if (name === 'claimEndlessTower') {
    const rewards = globalThis.TowerRewards;
    if (!rewards || typeof rewards.settle !== 'function') {
      const e = new Error('无尽塔奖励模块未加载'); e.code = 'SERVER_ERROR'; throw e;
    }
    const runId = String(args[2] || '').slice(0, 64);
    if (!/^[A-Za-z0-9:_-]{4,64}$/.test(runId)) {
      const e = new Error('对局编号不合法'); e.code = 'BAD_REQUEST'; throw e;
    }
    // 塔内过程只在客户机，服务端无法复算；这里只拒绝「层数/铸币明显对不上」的提交，
    // 真正的经济闸门仍是周上限（见 tower-rewards 的 WEEK_CAP）。
    if (typeof rewards.plausible === 'function' && !rewards.plausible(args[0], args[1])) {
      const e = new Error('无尽塔结算数据不合理，已拒绝'); e.code = 'BAD_REQUEST'; throw e;
    }
    const out = rewards.settle({
      box: save.towerWeek,
      // 传当前时刻，不走 `weekKey()` 的 5 秒缓存：周一 0 点后的第一笔结算要立刻换周。
      week: settlement.weekKey(Date.now()),
      layer: args[0],
      mint: args[1],
      runId,
    });
    save.towerWeek = out.box;
    // 同一 runId 的重试只返回上次结果：duplicate 时不能再往背包加一遍。
    if (!out.result.duplicate && out.result.granted > 0) {
      if (!save.props || typeof save.props !== 'object' || Array.isArray(save.props)) save.props = {};
      save.props[50] = Math.max(0, Math.floor(Number(save.props[50]) || 0)) + out.result.granted;
    }
    out.result.ticketsTotal = Math.max(0, Math.floor(Number(save.props && save.props[50]) || 0));
    return out.result;
  }
  const fn = api[name];
  if (typeof fn !== 'function') throw new Error('State 里没有这个动作：' + name);
  return fn.apply(api, args);
}

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
      // 天梯商店按积分限购：积分真值在 ratings（每周一重置），存档镜像可能落后。
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
