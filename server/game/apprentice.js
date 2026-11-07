'use strict';
/* ============================================================
 * server/game/apprentice.js — 联机师徒
 * ------------------------------------------------------------
 * 与原版 ssfight 对齐的口径（reference/ssfight 文本）：
 *   · 收徒需要打败他的师父；没有师父则打败他本人（text7841 / text4724）；
 *   · 收徒成功与否都花 10 个金松果（text4724）；
 *   · 收徒后徒弟学会「师父驾到」（技能 13）；
 *   · **只有真人徒弟**给师父产生日供：师父每天得到徒弟经验的 10%（text7843）。
 *     金松果在 ssfight 里查不到倍率，按用户 2026-10-29 口径固定为昨日金松果的 10%。
 *   · 人机师父（拜师人机）不产生日供，也不占真人师徒表里的 master_id。
 *
 * 真值：`apprenticeships` 一行 = 一个徒弟当前跟的师父。
 *   · 真人师父：master_kind='account'、master_id>0；
 *   · 人机师父：master_kind='bot'、master_id=0、master_json 存完整战斗体。
 * 存档里的 `save.master` / `save.prentices` 只是给界面和关卡「徒弟先上阵」用的镜像，
 * 每次关系变化都由这里同步更新。
 * ============================================================ */

const db = require('../db');
const store = require('./store');
const runtime = require('./runtime');
const battle = require('./battle');
const snapshots = require('./snapshot');
const { fighterFromSnapshot } = require('./fighter');
const { config, localDate } = require('../config');

const ACTIVE = 'active';

function error(code, text) { const e = new Error(text); e.code = code; return e; }

function previousDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
function yesterday() { return previousDate(localDate()); }

/** 与 `State.apprenticeCap` 同一口径：10 级前 1、10~19 级 2、20 级以上 3。 */
function capFor(level) {
  const lv = Math.max(1, Number(level) || 1);
  return Math.min(Math.max(1, config.apprenticeCap), lv >= 20 ? 3 : lv >= 10 ? 2 : 1);
}

function rowFor(prenticeId) {
  return db.get('SELECT * FROM apprenticeships WHERE prentice_id = ? AND status = ?', Number(prenticeId), ACTIVE);
}
function rowsForMaster(masterId) {
  return db.all(
    `SELECT ap.*, a.name AS acc_name, a.tag AS acc_tag
     FROM apprenticeships ap JOIN accounts a ON a.id = ap.prentice_id
     WHERE ap.master_id = ? AND ap.status = ? ORDER BY ap.since, ap.prentice_id`,
    Number(masterId), ACTIVE
  );
}
function accountOf(accountId) {
  return db.get('SELECT id,name,tag,banned FROM accounts WHERE id = ?', Number(accountId));
}

/** 战斗体 → 存档里师徒面板用的快照（武器/技能存 `id:level` 字符串）。 */
function displayStats(f) {
  const src = f || {};
  const ref = (list) => (Array.isArray(list) ? list : []).map((x) => {
    if (typeof x === 'string') return x;
    if (!x || x.id == null) return '';
    return Number(x.id) + ':' + Math.max(1, Number(x.level) || 1);
  }).filter(Boolean);
  const gears = (Array.isArray(src.gears) ? src.gears : []).filter((g) => g && g.id != null);
  return {
    name: String(src.name || '').slice(0, 20),
    level: Math.max(1, Math.round(Number(src.level) || 1)),
    power: Math.max(0, Math.round(Number(src.power) || 0)),
    agility: Math.max(0, Math.round(Number(src.agility) || 0)),
    speed: Math.max(0, Math.round(Number(src.speed) || 0)),
    hp: Math.max(0, Math.round(Number(src.maxHp) || Number(src.hp) || 0)),
    weapons: ref(src.weapons), skills: ref(src.skills), gears,
  };
}

function fighterOfAccount(accountId) {
  const snap = snapshots.currentSnapshot(accountId, 'classic');
  if (snap && snap.fighter) return fighterFromSnapshot(snap.fighter);
  const save = store.peek(accountId);
  if (!save) return null;
  return fighterFromSnapshot({
    name: save.name, level: save.level, power: save.power, agility: save.agility,
    speed: save.speed, hp: save.maxHp, maxHp: save.maxHp,
    weapons: save.weapons, skills: save.skills, gears: save.gears,
    effects: save.effects || {}, pets: [],
  });
}

function masterView(prenticeId) {
  const row = rowFor(prenticeId);
  if (!row) {
    /* 旧档/关系表被清掉时，存档里的 `master` 也要能显示出来（否则界面会以为没有师父，
     * 但服务端又因为 `save.master` 拒绝重新拜师）。 */
    const save = store.peek(prenticeId);
    if (!save || !save.master) return null;
    const stats = displayStats(save.master);
    return Object.assign(stats, {
      accountId: Math.max(0, Number(save.master.accountId) || 0), bot: !!save.master.bot,
      tag: String(save.master.tag || ''), since: '',
      display: stats.name || '师父',
      isMaster: true,
    });
  }
  if (row.master_kind === 'bot') {
    let f = null;
    try { f = JSON.parse(row.master_json || 'null'); } catch (_) { f = null; }
    const stats = displayStats(f || {});
    return Object.assign(stats, {
      accountId: 0, bot: true, tag: '', display: (stats.name || '人机师父') + ' AI',
      since: String(row.since_date || ''), isMaster: true,
    });
  }
  const acc = accountOf(row.master_id);
  const f = fighterOfAccount(row.master_id);
  const stats = displayStats(f || { name: acc ? acc.name : '', level: 1 });
  return Object.assign(stats, {
    accountId: Number(row.master_id), bot: false,
    name: stats.name || (acc ? String(acc.name) : ''),
    tag: acc ? String(acc.tag || '') : '',
    display: stats.name || (acc ? acc.name : '师父'),
    since: String(row.since_date || ''), isMaster: true,
  });
}

/** 单个徒弟的昨日日供（只有真人师父这一侧才有意义）。 */
function tributeOf(row) {
  const y = yesterday();
  const blank = { date: y, exp: 0, gold: 0, claimable: false, claimed: false, newPrentice: false };
  if (!row || row.master_kind !== 'account' || !(Number(row.master_id) > 0)) return blank;
  const claimed = String(row.last_tribute_date || '') === y;
  const since = String(row.since_date || '');
  /* 今天才进门的徒弟没有「昨天」，次日才开始结算。 */
  if (since && since >= y) return Object.assign({}, blank, { claimed, newPrentice: true });
  const save = store.peek(row.prentice_id);
  if (!save) return Object.assign({}, blank, { claimed });
  const earn = (Array.isArray(save.earnHistory) ? save.earnHistory : [])
    .find((d) => d && String(d.date) === y) || { exp: 0, gold: 0 };
  const exp = Math.floor(Math.max(0, Number(earn.exp) || 0) * config.apprenticeTributeExpRate);
  const gold = Math.floor(Math.max(0, Number(earn.gold) || 0) * config.apprenticeTributeGoldRate);
  return {
    date: y, exp, gold, claimed, newPrentice: false,
    claimable: !claimed && (exp > 0 || gold > 0),
  };
}

function prenticeView(row) {
  const snap = snapshots.currentSnapshot(row.prentice_id, 'classic');
  const save = store.peek(row.prentice_id);
  return {
    accountId: Number(row.prentice_id),
    name: String(row.acc_name || (save && save.name) || ''),
    tag: String(row.acc_tag || ''),
    level: Math.max(1, Number(save ? save.level : (snap ? snap.level : 1)) || 1),
    since: String(row.since_date || ''),
    snapshotId: snap ? snap.id : '',
    stats: displayStats(fighterOfAccount(row.prentice_id) || { name: row.acc_name, level: 1 }),
    tribute: tributeOf(row),
  };
}

/** 师徒页数据：我的师父 + 我的真人徒弟 + 名额与今日是否已逐出。 */
function list(accountId) {
  const save = store.peek(accountId);
  if (!save) throw error('CONFLICT', '还没有存档');
  const prentices = rowsForMaster(accountId).map(prenticeView);
  const claimable = prentices.reduce((sum, p) => sum + (p.tribute.claimable ? 1 : 0), 0);
  return {
    ok: true,
    master: masterView(accountId),
    prentices,
    cap: capFor(save.level),
    kickedToday: String(save.masterKickDate || '') === localDate(),
    tribute: {
      date: yesterday(),
      exp: prentices.reduce((n, p) => n + (p.tribute.claimable ? p.tribute.exp : 0), 0),
      gold: prentices.reduce((n, p) => n + (p.tribute.claimable ? p.tribute.gold : 0), 0),
      claimable,
    },
    config: {
      cap: config.apprenticeCap,
      expRate: config.apprenticeTributeExpRate, goldRate: config.apprenticeTributeGoldRate,
      recruitCost: config.apprenticeRecruitCost, recruitEnergy: config.apprenticeRecruitEnergy,
      leaveCost: config.apprenticeLeaveCost,
    },
  };
}

/** 稳定种子：同一天同一账号的人机师父候选不随刷新变化（选中后服务端还要重算校验）。 */
function seedOf(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** 人机师父候选：3 位，等级比玩家高 2~12 级（不超过 90）。 */
function botMasterCandidates(accountId, save) {
  const day = localDate();
  const level = Math.max(1, Math.min(90, Number(save.level) || 1));
  const seed = seedOf('master:' + Number(accountId) + ':' + day);
  return runtime.withState(save, ({ api: S }) => battle.withSeed(seed, () => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const lv = Math.min(90, Math.max(2, level + 2 + i * 4));
      out.push(Object.assign(displayStats(S.genAI(lv, '', { levelJitter: 0, gearSelfLevel: true })), {
        bot: true, accountId: 0, tag: '',
      }));
    }
    return out;
  })).value;
}

/** 同一设备上的账号不能互相收徒（防小号刷日供）。 */
function sameDevice(accountId, otherAccountId) {
  const a = Number(accountId), b = Number(otherAccountId);
  if (!(a > 0) || !(b > 0) || a === b) return false;
  const hashes = db.all('SELECT device_hash FROM account_devices WHERE account_id = ?', a)
    .map((r) => String(r.device_hash)).filter(Boolean);
  if (!hashes.length) return false;
  return hashes.some((hash) => !!db.get('SELECT 1 AS x FROM account_devices WHERE device_hash = ? AND account_id = ?', hash, b));
}

/** 可收的真人徒弟：等级相近、没有师父、不是我自己的师父/徒弟、不是同设备小号。 */
function recruitCandidates(accountId, save) {
  const level = Math.max(1, Math.min(90, Number(save.level) || 1));
  const mine = accountOf(accountId);
  const devices = db.all('SELECT device_hash FROM account_devices WHERE account_id = ?', Number(accountId))
    .map((r) => String(r.device_hash)).filter(Boolean);
  const sameDevice = new Set();
  for (const hash of devices) {
    for (const row of db.all('SELECT account_id FROM account_devices WHERE device_hash = ?', hash)) {
      sameDevice.add(Number(row.account_id));
    }
  }
  const masterRow = rowFor(accountId);
  /* 有师父的玩家也可以出现在候选里 —— 收徒挑战会先打他的师父（原版 text7841）；
   * 只排除「已经是我徒弟」的人，避免重复收同一个。 */
  const rows = db.all(
    `SELECT a.id, a.name, a.tag, s.level,
            (SELECT ap.master_id FROM apprenticeships ap WHERE ap.prentice_id = a.id AND ap.status = 'active') AS master_id,
            (SELECT ap.master_kind FROM apprenticeships ap WHERE ap.prentice_id = a.id AND ap.status = 'active') AS master_kind
     FROM accounts a JOIN saves s ON s.account_id = a.id AND s.mode = 'classic'
     WHERE a.id <> ? AND a.banned = 0 AND s.level BETWEEN ? AND ?
       AND a.last_seen >= ?
       AND NOT EXISTS (SELECT 1 FROM apprenticeships ap
                       WHERE ap.prentice_id = a.id AND ap.status = 'active' AND ap.master_id = ?)
     ORDER BY ABS(s.level - ?), a.last_seen DESC, a.id LIMIT 24`,
    Number(accountId), Math.max(1, level - 3), Math.min(90, level + 3),
    Date.now() - config.opponentIdleDays * 86400000, Number(accountId), level
  );
  const out = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (sameDevice.has(id)) continue;
    if (masterRow && Number(masterRow.master_id) === id) continue;
    if (mine && Number(mine.id) === id) continue;
    /* 服务端 SQL 已经排掉「我的徒弟」；这里再兜一次旧数据/并发写入。 */
    if (Number(row.master_id) === Number(accountId) && row.master_kind === 'account') continue;
    const master = masterView(id);
    const stats = displayStats(fighterOfAccount(id) || { name: row.name, level: row.level });
    out.push({
      accountId: id, name: String(row.name), tag: String(row.tag),
      level: Math.max(1, Number(row.level) || 1), display: String(row.name),
      stats,
      master: master ? { name: master.name, level: master.level, accountId: master.accountId, bot: master.bot } : null,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function candidates(accountId) {
  const save = store.peek(accountId);
  if (!save) throw error('CONFLICT', '还没有存档');
  return {
    ok: true,
    masters: botMasterCandidates(accountId, save),
    prentices: recruitCandidates(accountId, save),
    cap: capFor(save.level),
    config: { recruitCost: config.apprenticeRecruitCost, recruitEnergy: config.apprenticeRecruitEnergy },
  };
}

/** 拜人机为师。候选由服务端按「账号 + 日期」确定性生成，客户端只交下标。 */
function setBotMaster(accountId, index, rev) {
  const idx = Math.max(0, Math.min(2, Math.trunc(Number(index) || 0)));
  return db.tx(() => {
    const save = store.peek(accountId);
    if (!save) throw error('CONFLICT', '还没有存档');
    if (masterView(accountId) || save.master) throw error('CONFLICT', '已经有师父了，先出师再拜师');
    const cand = botMasterCandidates(accountId, save)[idx];
    if (!cand) throw error('BAD_REQUEST', '师父候选已失效，请刷新');
    const out = store.runOnSave(accountId, ({ api: S }) => {
      const r = S.setMaster(cand);
      if (!r || !r.ok) throw error('CONFLICT', (r && r.msg) || '拜师失败');
      return r;
    }, { expectRev: rev, snapshotSource: 'apprentice-master' });
    db.run(
      `INSERT INTO apprenticeships (prentice_id, master_id, master_kind, master_json, since, since_date, status, last_tribute_date)
       VALUES (?,0,'bot',?,?,?,'active','')
       ON CONFLICT(prentice_id) DO UPDATE SET master_id=0, master_kind='bot', master_json=excluded.master_json,
         since=excluded.since, since_date=excluded.since_date, status='active', last_tribute_date=''`,
      Number(accountId), JSON.stringify(cand), Date.now(), localDate()
    );
    return { ok: true, result: out.value, rev: out.rev, patch: out.patch, master: masterView(accountId) };
  });
}

/** 收徒挑战的对手：有师父打师父，没有师父打本人。 */
function recruitFoe(targetAccountId) {
  const target = accountOf(targetAccountId);
  if (!target) throw error('NOT_FOUND', '找不到这个玩家');
  const row = rowFor(targetAccountId);
  if (row && row.master_kind === 'account') {
    const snap = snapshots.currentSnapshot(row.master_id, 'classic');
    if (!snap || !snap.fighter) throw error('CONFLICT', '对方的师父还没有战斗快照，稍后再试');
    return { fighter: fighterFromSnapshot(snap.fighter), via: 'master', masterAccountId: Number(row.master_id), snapshotId: snap.id };
  }
  if (row && row.master_kind === 'bot') {
    let f = null;
    try { f = JSON.parse(row.master_json || 'null'); } catch (_) { f = null; }
    const fighter = fighterFromSnapshot(f || null);
    if (!fighter) throw error('CONFLICT', '对方的人机师父数据已失效，稍后再试');
    return { fighter, via: 'master', masterAccountId: 0, snapshotId: '' };
  }
  const snap = snapshots.currentSnapshot(targetAccountId, 'classic');
  if (!snap || !snap.fighter) throw error('CONFLICT', '对方还没有战斗快照，稍后再试');
  return { fighter: fighterFromSnapshot(snap.fighter), via: 'self', masterAccountId: Number(targetAccountId), snapshotId: snap.id };
}

function targetStats(targetAccountId) {
  const target = accountOf(targetAccountId);
  if (!target) return null;
  return displayStats(fighterOfAccount(targetAccountId) || { name: target.name, level: 1 });
}

/** 收徒成功：把师徒关系落到两边的存档与师徒表（旧师父那边同步摘掉）。 */
function commitRecruit(masterId, targetId, won, masterName, combatId) {
  const target = accountOf(targetId);
  if (!target) return { ok: false };
  if (!won) {
    notify(targetId, 'apprentice', '【' + (masterName || '对手') + '】想收你为徒，但被' +
      (rowFor(targetId) && rowFor(targetId).master_kind !== 'bot' ? '你的师父' : '你') + '打退了。',
      { combatId, fromId: masterId, fromName: masterName, payload: { win: true } });
    return { ok: true, recruited: false };
  }
  const old = rowFor(targetId);
  const masterSave = store.peek(masterId);
  const masterFighter = masterSave ? fighterOfAccount(masterId) : null;
  if (old && old.master_kind === 'account' && Number(old.master_id) > 0) {
    const oldMasterId = Number(old.master_id);
    try {
      store.runOnSave(oldMasterId, ({ save }) => {
        save.prentices = (Array.isArray(save.prentices) ? save.prentices : [])
          .filter((p) => !p || (Number(p.realId || p.accountId) !== Number(targetId) && String(p.name || '') !== String(target.name)));
      });
    } catch (_) { /* 旧师父存档异常不阻断收徒 */ }
    notify(oldMasterId, 'apprentice', '你的徒弟【' + target.name + '】被【' + (masterName || '别人') + '】收走了。', {
      combatId, fromId: masterId, fromName: masterName,
    });
  }
  db.run('DELETE FROM apprenticeships WHERE prentice_id = ?', Number(targetId));
  db.run(
    `INSERT INTO apprenticeships (prentice_id, master_id, master_kind, master_json, since, since_date, status, last_tribute_date)
     VALUES (?,?,'account','',?,?,'active','')`,
    Number(targetId), Number(masterId), Date.now(), localDate()
  );
  const stats = targetStats(targetId) || { name: target.name, level: 1 };
  /* 徒弟侧：记下师父（含真实账号 id，注销/逐出时好清理），并学会师父驾到。 */
  try {
    store.runOnSave(targetId, ({ api: S }) => {
      const r = S.setMaster(Object.assign(displayStats(masterFighter || { name: masterName, level: 1 }), {
        name: (masterSave && masterSave.name) || masterName, accountId: Number(masterId),
        tag: (accountOf(masterId) || {}).tag || '', bot: false,
      }));
      if (!r || !r.ok) throw error('CONFLICT', '写入师父失败');
      return r;
    }, { snapshotSource: 'apprentice-master' });
  } catch (_) {}
  /* 徒弟列表：真人徒弟带 accountId/realId，日供只认这个标记。 */
  let masterOut = null;
  const masterRow = rowFor(targetId);
  masterOut = store.runOnSave(masterId, ({ api: S, save: s }) => {
    /* 旧档里可能已经有一条同名/同账号的本地徒弟，先摘掉再按服务端口径重记。 */
    s.prentices = (Array.isArray(s.prentices) ? s.prentices : [])
      .filter((p) => !p || (Number(p.realId || p.accountId) !== Number(targetId) && String(p.name || '') !== String(target.name)));
    /* 线上只维护真人徒弟；旧版本留下的本地 AI 徒弟不占服务端名额，但会挡住 addPrentice，
     * 名额不够时先清掉这些没有 realId 的旧条目。 */
    const cap = typeof S.apprenticeCap === 'function' ? S.apprenticeCap(s.level) : 3;
    while (s.prentices.length >= cap) {
      const idx = s.prentices.findIndex((p) => !p || !(Number(p.realId || p.accountId) > 0));
      if (idx < 0) break;
      s.prentices.splice(idx, 1);
    }
    const r = S.addPrentice(Object.assign({}, stats, {
      accountId: Number(targetId), realId: Number(targetId), tag: target.tag || '',
      bot: false, since: masterRow ? (masterRow.since_date || localDate()) : localDate(),
    }));
    if (!r || !r.ok) throw error('CONFLICT', (r && r.msg) || '收徒失败');
    return r;
  });
  notify(targetId, 'apprentice', '你在收徒挑战中落败，【' + (masterName || '对手') + '】收你为徒，已学会「师父驾到」。', {
    combatId, fromId: masterId, fromName: masterName, payload: { win: false },
  });
  return {
    ok: true, recruited: true,
    masterPatch: masterOut ? masterOut.patch : null, masterRev: masterOut ? masterOut.rev : 0,
  };
}

/** 出师（徒弟主动离开师父），花 20 金松果。 */
function leaveMaster(accountId, rev) {
  return db.tx(() => {
    const row = rowFor(accountId);
    const save = store.peek(accountId);
    if (!save) throw error('CONFLICT', '还没有存档');
    if (!row && !save.master) throw error('CONFLICT', '还没有师父');
    const masterId = row && row.master_kind === 'account' ? Number(row.master_id)
      : (!row && save.master ? Math.max(0, Number(save.master.accountId) || 0) : 0);
    const out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      const cost = Math.max(0, Number(config.apprenticeLeaveCost) || 0);
      if (Math.max(0, Number(s.goldPoint) || 0) < cost) throw error('CONFLICT', '金松果不足 ' + cost + '，无法出师');
      if (cost > 0) S.addGold(-cost, { count: false });
      S.clearMaster();
      return { cost };
    }, { expectRev: rev, snapshotSource: 'apprentice-leave' });
    db.run('DELETE FROM apprenticeships WHERE prentice_id = ?', Number(accountId));
    if (masterId) {
      try {
        store.runOnSave(masterId, ({ save: s }) => {
          s.prentices = (Array.isArray(s.prentices) ? s.prentices : [])
            .filter((p) => !p || (Number(p.realId || p.accountId) !== Number(accountId) && String(p.name || '') !== String(save.name || '')));
        });
      } catch (_) {}
      notify(masterId, 'apprentice', '你的徒弟【' + (save.name || '') + '】出师了。', { fromId: accountId, fromName: save.name || '' });
    }
    return { ok: true, result: out.value, rev: out.rev, patch: out.patch };
  });
}

/** 逐出师门（每名师父每天 1 次）。 */
function kickPrentice(accountId, targetAccountId, rev) {
  return db.tx(() => {
    const today = localDate();
    const save = store.peek(accountId);
    if (!save) throw error('CONFLICT', '还没有存档');
    if (String(save.masterKickDate || '') === today) throw error('CONFLICT', '今天已经踢过一个徒弟了，明天再来');
    const row = db.get('SELECT * FROM apprenticeships WHERE prentice_id = ? AND master_id = ? AND status = ?',
      Number(targetAccountId), Number(accountId), ACTIVE);
    if (!row) throw error('NOT_FOUND', '没有这个徒弟');
    const target = accountOf(targetAccountId);
    const out = store.runOnSave(accountId, ({ save: s }) => {
      s.prentices = (Array.isArray(s.prentices) ? s.prentices : [])
        .filter((p) => !p || (Number(p.realId || p.accountId) !== Number(targetAccountId) && String(p.name || '') !== String(target ? target.name : '')));
      s.masterKickDate = today;
    }, { expectRev: rev });
    db.run('DELETE FROM apprenticeships WHERE prentice_id = ?', Number(targetAccountId));
    try {
      store.runOnSave(targetAccountId, ({ api: S, save: s }) => {
        if (s.master && Number(s.master.accountId || 0) === Number(accountId)) S.clearMaster();
      }, { snapshotSource: 'apprentice-kick' });
    } catch (_) {}
    notify(targetAccountId, 'apprentice', '你被师父【' + (save.name || '') + '】逐出师门。', {
      fromId: accountId, fromName: save.name || '',
    });
    return { ok: true, rev: out.rev, patch: out.patch, name: target ? target.name : '' };
  });
}

/** 领取真人徒弟的昨日日供（经验 10% + 金松果 10%，只有真人徒弟产生）。 */
function claimTribute(accountId, rev) {
  return db.tx(() => {
    const date = yesterday();
    const rows = rowsForMaster(accountId);
    const details = [];
    let totalExp = 0, totalGold = 0;
    for (const row of rows) {
      const t = tributeOf(row);
      if (!t.claimable) continue;
      details.push({ accountId: Number(row.prentice_id), name: String(row.acc_name || ''), exp: t.exp, gold: t.gold });
      totalExp += t.exp; totalGold += t.gold;
    }
    if (!details.length) return { ok: false, msg: '暂无可领取的昨日日供，新收徒要等次日结算。', date };
    const out = store.runOnSave(accountId, ({ api: S }) => {
      const ups = totalExp > 0 ? S.gainExp(totalExp, { noTrack: true }) : [];
      if (totalGold > 0) S.addGold(totalGold, { count: false });
      return { ups };
    }, { expectRev: rev, snapshotSource: 'apprentice-tribute' });
    for (const d of details) {
      db.run('UPDATE apprenticeships SET last_tribute_date = ? WHERE prentice_id = ? AND status = ?', date, d.accountId, ACTIVE);
    }
    return {
      ok: true, date, details, totalExp, totalGold,
      ups: out.value.ups || [], rev: out.rev, patch: out.patch,
      msg: '昨日日供：经验 +' + totalExp + '、金松果 +' + totalGold,
    };
  });
}

/** 与 fight.message 同一张表；这里只给师徒关系变化投递消息。 */
function notify(accountId, kind, text, opts) {
  const o = opts || {};
  const { message } = require('./fight');
  message(accountId, kind, text, o);
}

module.exports = {
  ACTIVE, yesterday, previousDate, capFor,
  rowFor, rowsForMaster, masterView, tributeOf, prenticeView,
  list, candidates, botMasterCandidates, recruitCandidates,
  setBotMaster, recruitFoe, targetStats, commitRecruit, sameDevice,
  leaveMaster, kickPrentice, claimTribute, displayStats, fighterOfAccount,
};
