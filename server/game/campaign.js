'use strict';
// server/game/campaign.js — 征战（四人组队副本）
// · 4 人报名，服务端按报名顺序凑人；客户端 10 秒轮询 checkCopy.do；
// · 凑够 4 人后，服务端一次算完整队战斗，客户端按顺序播放；

const crypto = require('node:crypto');
const db = require('../db');
const store = require('./store');
const battle = require('./battle');
const apprentice = require('./apprentice');
const { fighterFromState } = require('./fighter');
const { config } = require('../config');
const settlement = require('./settlement');
const opponents = require('./opponents');

function Data() { return globalThis.CampaignData; }
function partySize() { return Math.max(2, Number(config.campaignPartySize) || 4); }
function now() { return Date.now(); }

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return s;
}

function newRoomId() { return 'cr_' + crypto.randomBytes(8).toString('base64url'); }
function gz(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }
function unz(blob) {
  try { return JSON.parse(store.toBuffer(blob).toString('utf8')); } catch (_) { return null; }
}
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function memberRow(roomId, accountId) {
  return db.get('SELECT * FROM campaign_members WHERE room_id = ? AND account_id = ?', String(roomId), Number(accountId));
}

function membersOf(roomId) {
  return db.all(
    'SELECT m.*, a.name, a.tag FROM campaign_members m JOIN accounts a ON a.id = m.account_id WHERE m.room_id = ? ORDER BY m.seat',
    String(roomId)
  );
}

function roomOf(roomId) {
  return db.get('SELECT * FROM campaign_rooms WHERE id = ?', String(roomId));
}

function levelOf(accountId) {
  const row = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', Number(accountId), 'classic');
  return row ? Number(row.level) : 1;
}

function realMembers(roomId) {
  return membersOf(roomId).filter((m) => !Number(m.missed));
}

function countReal(roomId) { return realMembers(roomId).length; }

// 把房间的 4 个座位拼出来：真人优先，空位看 seats_json 里的助战快照。
function seatList(room, members, accountId) {
  const stored = unz(room.seats_json) || [];
  const out = [];
  for (let seat = 0; seat < partySize(); seat++) {
    const storedSeat = stored.find((s) => Number(s.seat) === seat);
    const real = members.find((m) => Number(m.seat) === seat && !Number(m.missed));
    if (real) {
      const pub = storedSeat ? Object.assign({}, storedSeat) : {};
      delete pub.fighter;
      delete pub.result;
      delete pub.me;
      delete pub.foe;
      out.push(Object.assign(pub, {
        seat, kind: 'player', accountId: Number(real.account_id),
        name: String(real.name || ''), tag: String(real.tag || ''), level: levelOf(real.account_id),
        isMe: Number(real.account_id) === Number(accountId), missed: false,
      }));
      continue;
    }
    const ghost = storedSeat;
    if (ghost) {
      const pub = Object.assign({}, ghost);
      delete pub.fighter;
      delete pub.result;
      delete pub.me;
      delete pub.foe;
      pub.isMe = false;
      pub.missed = false;
      out.push(pub);
    } else {
      out.push({ seat, kind: 'empty', isMe: false, missed: false });
    }
  }
  return out;
}

function roomView(room, accountId) {
  if (!room) return null;
  const members = membersOf(room.id);
  const data = Data();
  const boss = data && data.bossFor(room.boss_id);
  const mine = members.find((m) => Number(m.account_id) === Number(accountId));
  const ts = now();
  const resolveAt = Number(room.resolve_at) || 0;
  const waiting = String(room.status) === 'waiting';
  return {
    id: String(room.id),
    code: String(room.code),
    bossId: Number(room.boss_id),
    bossName: boss ? boss.name : '征战首领',
    bossLevel: Number(room.boss_level),
    status: String(room.status),
    mode: String(room.mode || 'real'),
    hostId: Number(room.host_id),
    partySize: partySize(),
    createdAt: Number(room.created_at),
    resolveAt,
    remainMs: waiting && resolveAt > 0 ? Math.max(0, resolveAt - ts) : 0,
    startAt: Number(room.start_at),
    expiresAt: Number(room.created_at) + config.campaignRoomTtlMs,
    teamResult: String(room.team_result || ''),
    bossMaxHp: Number(room.boss_max_hp) || 0,
    bossHp: Number(room.boss_hp) || 0,
    failedReason: String(room.failed_reason || ''),
    members: members.map((m) => ({
      accountId: Number(m.account_id),
      name: String(m.name),
      tag: String(m.tag),
      seat: Number(m.seat),
      level: levelOf(m.account_id),
      dice: Number(m.dice),
      joinedAt: Number(m.joined_at),
      missed: !!Number(m.missed),
      isMe: Number(m.account_id) === Number(accountId),
    })),
    seats: seatList(room, members, accountId),
    // 原版 `rollDatas`（3437 第 5 帧）：只有已结算房间才有；老房间 / 失败房间为空，
    // 客户端会回落到文字结果。
    roll: String(room.status) === 'done' ? unz(room.roll_json) : null,
    me: mine ? {
      dice: Number(mine.dice),
      reward: unz(mine.reward) || {},
      acked: !!Number(mine.acked),
      missed: !!Number(mine.missed),
    } : null,
    combatIds: unz(room.combat_ids) || [],
  };
}

function ensureEligible(accountId, bossId) {
  const save = store.peek(accountId);
  if (!save) { const e = new Error('还没有存档'); e.code = 'CONFLICT'; throw e; }
  const data = Data();
  const boss = data && data.bossFor(bossId);
  if (!boss) { const e = new Error('没有这个征战首领'); e.code = 'NOT_FOUND'; throw e; }
  if (boss.locked) { const e = new Error(boss.name + ' 暂未开放'); e.code = 'CONFLICT'; throw e; }
  if (Number(save.level) < boss.unlockLevel) {
    const e = new Error(boss.name + ' 需要 ' + boss.unlockLevel + ' 级才能报名');
    e.code = 'CONFLICT';
    throw e;
  }
  if (settlement.todayCount(accountId, 'campaign') >= config.campaignDailyLimit) {
    const e = new Error('今天已经参加 ' + config.campaignDailyLimit + ' 次征战，明天再来吧。');
    e.code = 'CONFLICT';
    throw e;
  }
  if (Math.max(0, Number(save.props && save.props[data.TICKET_PROP]) || 0) <= 0) {
    const e = new Error('报名需扣除1个征战令');
    e.code = 'CONFLICT';
    throw e;
  }
  return { save, boss, level: Number(save.level) || 1 };
}

function consumeEntry(accountId) {
  const data = Data();
  const out = store.runOnSave(accountId, ({ api: S, save: s }) => {
    if (settlement.todayCount(accountId, 'campaign') >= config.campaignDailyLimit) {
      return { ok: false, msg: '今天已经参加 ' + config.campaignDailyLimit + ' 次征战，明天再来吧。' };
    }
    const id = data.TICKET_PROP;
    const have = Math.max(0, Number(s.props[id]) || 0);
    if (have < 1) return { ok: false, msg: '报名需扣除1个征战令' };
    s.props[id] = have - 1;
    if (s.props[id] <= 0) delete s.props[id];
    S.save();
    settlement.bumpDaily(accountId, 'campaign', 1);
    return { ok: true, left: Math.max(0, Number(s.props[id]) || 0) };
  });
  return out.value || { ok: false, msg: '报名需扣除1个征战令' };
}

function freeSeat(roomId) {
  const used = new Set(membersOf(roomId).filter((m) => !Number(m.missed)).map((m) => Number(m.seat)));
  for (let seat = 0; seat < partySize(); seat++) if (!used.has(seat)) return seat;
  throw Object.assign(new Error('房间已满'), { code: 'CONFLICT' });
}

function activeRoom(accountId) {
  return db.get(
    `SELECT r.* FROM campaign_rooms r JOIN campaign_members m ON m.room_id = r.id
      WHERE m.account_id = ? AND (r.status = 'waiting' OR (r.status IN ('done','failed') AND m.acked = 0))
      ORDER BY r.created_at DESC LIMIT 1`,
    Number(accountId)
  );
}

function message(accountId, text, payload) {
  db.run(
    'INSERT INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
    'm_' + crypto.randomBytes(8).toString('base64url'), Number(accountId), 'campaign',
    String(text), JSON.stringify(payload || {}), Date.now()
  );
}

function createRoom({ accountId, boss, mode, resolveAt, seats }) {
  const id = newRoomId();
  let code = roomCode();
  for (let i = 0; i < 20; i++) {
    const dup = db.get("SELECT 1 AS x FROM campaign_rooms WHERE code = ? AND status IN ('waiting','done')", code);
    if (!dup) break;
    code = roomCode();
  }
  const ts = now();
  db.run(
    `INSERT INTO campaign_rooms
      (id, code, boss_id, boss_level, status, mode, host_id, combat_ids, seats_json, team_result,
       boss_max_hp, boss_hp, failed_reason, resolve_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, code, Number(boss.bossId), Number(boss.level), 'waiting', mode,
    Number(accountId), '[]', JSON.stringify(seats || []), '', 0, 0, '', Number(resolveAt) || 0, ts
  );
  db.run(
    'INSERT INTO campaign_members (room_id, account_id, seat, snapshot_id, joined_at, missed) VALUES (?,?,?,?,?,0)',
    id, Number(accountId), 0, '', ts
  );
  return roomOf(id);
}

function enqueue({ accountId, bossId }) {
  pump();
  const active = activeRoom(accountId);
  if (active) return { ok: true, already: true, room: roomView(active, accountId) };
  const { boss } = ensureEligible(accountId, bossId);
  let roomId = '';
  db.tx(() => {
    const open = db.all(
      "SELECT * FROM campaign_rooms WHERE status = 'waiting' AND mode = 'real' AND boss_id = ? AND resolve_at > ? ORDER BY created_at ASC",
      Number(boss.bossId), now()
    );
    let room = null;
    for (const r of open) {
      if (countReal(r.id) < partySize()) { room = r; break; }
    }
    if (room) {
      db.run(
        'INSERT INTO campaign_members (room_id, account_id, seat, snapshot_id, joined_at, missed) VALUES (?,?,?,?,?,0)',
        String(room.id), Number(accountId), freeSeat(room.id), '', now()
      );
    } else {
      room = createRoom({
        accountId, boss, mode: 'real',
        resolveAt: now() + config.campaignMatchWaitMs, seats: [],
      });
    }
    roomId = String(room.id);
  });

  pump();
  return { ok: true, joined: true, room: roomView(roomOf(roomId), accountId) };
}

function randomMatch({ accountId, bossId }) {
  pump();
  const active = activeRoom(accountId);
  if (active) return { ok: true, already: true, room: roomView(active, accountId) };
  const { save, boss, level } = ensureEligible(accountId, bossId);
  const teammates = opponents.drawTeammates(
    accountId, save, level, Math.max(1, Math.min(Number(config.campaignRandomTeammates) || 3, partySize() - 1)),
    [accountId]
  );
  const seats = teammates.map((g, i) => ({
    seat: i + 1,
    kind: g.kind,
    accountId: g.accountId,
    snapshotId: g.snapshotId,
    name: g.name,
    tag: g.tag,
    level: g.level,
    fighter: g.fighter,
  }));
  let roomId = '';
  db.tx(() => {
    const room = createRoom({ accountId, boss, mode: 'random', resolveAt: 0, seats });
    roomId = String(room.id);
    const result = resolveRoom(room.id);
    if (!result || result.status !== 'done') {
      throw Object.assign(new Error('这场征战没有成功开打，请稍后再试'), { code: 'CONFLICT' });
    }
  });
  return { ok: true, joined: true, mode: 'random', room: roomView(roomOf(roomId), accountId) };
}

function lastHpAfter(result) {
  const rounds = Array.isArray(result && result.rounds) ? result.rounds : [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (Array.isArray(rounds[i].hpAfter)) return rounds[i].hpAfter;
  }
  return null;
}

function rewardText(gold, items) {
  const bits = [];
  if (gold) bits.push('金松果 +' + gold);
  for (const item of items || []) bits.push(String(item.name) + '×' + Number(item.count));
  return bits.length ? bits.join('、') : '没有获得战利品';
}

function applyPrize(S, save, prize, seed, index) {
  if (!prize) return null;
  if (prize.kind === 'gold') {
    const gold = Math.max(0, Number(prize.gold) || 0);
    if (gold) S.addGold(gold, { count: false });
    return { gold, value: Number(prize.value) || gold, item: null, name: String(prize.name || '金松果') };
  }
  if (prize.kind === 'prop') {
    const id = Number(prize.id);
    const count = Math.max(1, Number(prize.count) || 1);
    save.props[id] = (Number(save.props[id]) || 0) + count;
    return { gold: 0, value: Number(prize.value) || 0, item: { id, count, name: String(prize.name || '战利品'), kind: 'prop' } };
  }
  if (prize.kind === 'hatch') {
    const count = Math.max(1, Number(prize.count) || 1);
    save.hatchPoint = (Number(save.hatchPoint) || 0) + count;
    return { gold: 0, value: Number(prize.value) || 0, item: { id: 0, count, name: String(prize.name || '孵化点'), kind: 'hatch' } };
  }
  if (prize.kind === 'pet') {
    // 幻兽在 rewardPlan 时已经掷定（prize.pet 随公开 rollDatas 下发），这里只按
    // 那份结果入栏，不再重随机 —— 否则分奖页看到的幻兽和中奖拿到的会对不上。
    const spec = prize.pet || {};
    let got = null;
    try { got = S.grantPet({ id: spec.id, level: spec.level }); } catch (e) { got = null; }
    if (got && got.ok && got.pet) {
      const pet = got.pet;
      return {
        gold: 0, value: Number(prize.value) || 0,
        item: {
          id: pet.id, count: 1, name: '幻兽·' + pet.name + ' Lv.' + pet.level, kind: 'pet',
          pet: { id: pet.id, name: pet.name, grade: pet.grade, level: pet.level, maxLevel: pet.maxLevel },
        },
      };
    }
    // 幻兽栏满 / 未知幻兽：折回原版等价的 400 孵化点，不能吞掉一份奖励。
    save.hatchPoint = (Number(save.hatchPoint) || 0) + 400;
    return {
      gold: 0, value: 400, fallback: true,
      item: { id: 0, count: 400, name: '孵化点', kind: 'hatch' },
    };
  }
  if (prize.kind === 'gear') {
    let state = null;
    try { state = S.state(); } catch (_) {}
    const cap = Number(S.gearCapacity ? S.gearCapacity() : 0);
    if (state && Array.isArray(state.gears) && cap > 0 && state.gears.length < cap) {
      const part = Math.abs((Number(seed) + Number(index)) % 4);
      const quality = Math.max(0, Math.min(5, Number(prize.quality) || 3));
      const ids = S.gearIdsOf ? S.gearIdsOf(part, quality) : [];
      if (Array.isArray(ids) && ids.length) {
        const id = ids[Math.abs((Number(seed) + Number(index)) % ids.length)];
        // 装备奖励要和普通掉落一样按品质带随机词条；`addGear` 只负责基础属性浮动。
        const ext = S.randomExtForQuality ? S.randomExtForQuality(quality) : [];
        const gear = S.addGear(id, ext);
        if (gear) return {
          gold: 0, value: Number(prize.value) || 0,
          item: {
            id, count: 1, name: String(prize.name || '紫色装备'), kind: 'gear',
            key: gear.key, ext: gear.ext, attr: gear.attr, quality,
          },
        };
      }
    }
    // 装备格满或抽不到紫装时折 200 金松果，不能把一份奖励吞掉。
    S.addGold(200, { count: false });
    return { gold: 200, value: 200, item: null, fallback: true, name: '金松果（装备位已满折算）' };
  }
  return null;
}

function failRoom(room, reason) {
  if (!room || String(room.status) !== 'waiting') return null;
  db.run(
    "UPDATE campaign_rooms SET status = 'failed', failed_reason = ?, closed_at = ? WHERE id = ? AND status = 'waiting'",
    String(reason || 'timeout'), now(), String(room.id)
  );
  const text = reason === 'timeout'
    ? '征战匹配超时（5 分钟），没有凑齐 4 名真人；本局未扣除征战令和每日次数。'
    : '征战队伍已解散，本局未扣除征战令和每日次数。';
  for (const m of membersOf(room.id)) {
    if (Number(m.acked)) continue;
    message(m.account_id, text, { code: String(room.code), reason: String(reason || 'timeout') });
  }
  return roomOf(room.id);
}

function resolveRoom(roomId) {
  return db.tx(() => resolveRoomTx(roomId));
}

function resolveRoomTx(roomId) {
  const room = roomOf(roomId);
  if (!room || String(room.status) !== 'waiting') return room ? { ok: true, status: String(room.status) } : null;
  const data = Data();
  const boss = data && data.bossFor(room.boss_id);
  if (!boss) return null;
  const members = membersOf(room.id);
  const stored = unz(room.seats_json) || [];


  for (const m of members) {
    if (Number(m.missed)) continue;
    let pay;
    try { pay = consumeEntry(Number(m.account_id)); }
    catch (e) { pay = { ok: false, msg: e && e.message ? e.message : '扣费失败' }; }
    if (!pay.ok) {
      const missedReward = { missed: true, win: false, exp: 0, gold: 0, loot: null, msg: pay.msg, teamWin: false };
      db.run(
        'UPDATE campaign_members SET missed = 1, reward = ?, dice = -1 WHERE room_id = ? AND account_id = ?',
        gz(missedReward), String(room.id), Number(m.account_id)
      );
      m.missed = 1;
      message(m.account_id, '征战未参战：' + pay.msg + '；本局未扣除任何费用。', { code: String(room.code), missed: true });
    }
  }
  const live = members.filter((m) => !Number(m.missed));
  if (!live.length) {
    failRoom(room, 'no_player');
    return { ok: false, status: 'failed', reason: 'no_player' };
  }

  // 2) 排座位：真人按报名顺序占自己的 seat；空位用助战快照/人机。
  const seats = [];
  for (let seat = 0; seat < partySize(); seat++) {
    const real = live.find((m) => Number(m.seat) === seat);
    if (real) {
      seats.push({
        seat, kind: 'player', accountId: Number(real.account_id),
        name: String(real.name || ''), tag: String(real.tag || ''), level: levelOf(real.account_id),
      });
      continue;
    }
    const ghost = stored.find((s) => Number(s.seat) === seat);
    if (ghost && ghost.fighter) {
      seats.push(Object.assign({}, ghost, { seat, kind: ghost.kind || 'bot' }));
    } else {
      seats.push(null);
    }
  }
  const empty = seats.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
  if (empty.length) {
    const base = live[0];
    const save = store.peek(base.account_id) || store.peek(room.host_id);
    const ghosts = opponents.drawTeammates(
      base.account_id, save, levelOf(base.account_id), empty.length,
      live.map((m) => Number(m.account_id))
    );
    empty.forEach((seat, i) => {
      const g = ghosts[i] || { kind: 'bot', accountId: 0, snapshotId: '', name: '助战', tag: '', level: boss.level, fighter: data.buildFoe(globalThis.State, room.boss_id) };
      seats[seat] = {
        seat, kind: g.kind || 'bot', accountId: Number(g.accountId || 0), snapshotId: String(g.snapshotId || ''),
        name: String(g.name || '助战'), tag: String(g.tag || ''), level: Number(g.level) || boss.level, fighter: g.fighter,
      };
    });
  }


  const bossFull = data.buildFoe(globalThis.State, room.boss_id);
  const bossMaxHp = Math.max(1, Number(bossFull.maxHp) || 1);
  let bossHp = bossMaxHp;
  const seed = crypto.randomInt(0, 0x7fffffff);
  const seatResults = [];
  for (const seat of seats) {
    if (bossHp <= 0) {
      seatResults.push({ seat: Number(seat.seat), kind: seat.kind, accountId: Number(seat.accountId || 0), name: seat.name, level: seat.level, skipped: true, win: true, bossHpBefore: 0, bossHpAfter: 0 });
      continue;
    }
    let fighter;
    if (seat.kind === 'player') {
      const out = store.runOnSave(seat.accountId, ({ api: S, save }) => {
        try { apprentice.refreshMasterLevelInto(seat.accountId, save); } catch (_) {}
        return {
          fighter: fighterFromState({ useProps: false, cheerAccountId: seat.accountId }),
          level: Number(save.level) || 1,
        };
      });
      fighter = out.value.fighter;
      seat.level = out.value.level;
    } else {
      fighter = clone(seat.fighter);
    }
    const foe = clone(bossFull);
    foe.maxHp = bossMaxHp;
    foe.hp = Math.max(1, bossHp);
    const result = battle.withSeed(seed ^ (Number(seat.seat) * 2654435761), () => globalThis.Sim.simulate(fighter, foe));
    const after = lastHpAfter(result);
    const hpAfter = after ? Math.max(0, Number(after[1]) || 0) : (result.winner === 0 ? 0 : Math.max(1, bossHp));
    const before = bossHp;
    bossHp = Math.max(0, Math.min(bossHp, hpAfter));
    seatResults.push({
      seat: Number(seat.seat), kind: seat.kind, accountId: Number(seat.accountId || 0),
      name: seat.name, level: seat.level, skipped: false,
      win: bossHp <= 0, bossHpBefore: before, bossHpAfter: bossHp,
      fighter, foe, result,
    });
  }
  const teamWin = bossHp <= 0;
  const plan = teamWin ? data.rewardPlan(seed, seats, boss) : { count: 0, prizes: [] };

  const prizeAwards = new Map();


  const settled = [];
  const combatIds = [];
  // 同一份奖品（index）最多只发一次：plan 正常就唯一，这里防异常数据重复进入
  const awardedPrizeIndexes = new Set();
  for (const m of live) {
    const accountId = Number(m.account_id);
    const seatResult = seatResults.find((r) => r.kind === 'player' && Number(r.accountId) === accountId) || null;
    const wins = teamWin
      ? plan.prizes.filter((p) => p.winnerKind === 'player' && Number(p.winnerAccountId) === accountId)
      : [];
    const out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      const exp = teamWin ? Math.round(S.challengeExp(boss.level, s.level) * (boss.rewardExpRatio || 1)) : 0;
      const ups = exp > 0 ? S.gainExp(exp) : [];
      const gains = { gold: 0, value: 0, items: [], fallback: false };
      const awards = [];
      for (const win of wins) {
        const prizeIndex = Number(win.index);
        if (awardedPrizeIndexes.has(prizeIndex)) continue;
        awardedPrizeIndexes.add(prizeIndex);
        const got = applyPrize(S, s, win.prize, seed, prizeIndex);
        if (!got) continue;
        gains.gold += Number(got.gold) || 0;
        gains.value += Number(got.value) || 0;
        if (got.item) gains.items.push(got.item);
        if (got.fallback) gains.fallback = true;
        awards.push({
          index: Number(win.index), kind: got.item ? String(got.item.kind) : 'gold',
          id: got.item ? Number(got.item.id) || 0 : 0,
          count: got.item ? Math.max(1, Number(got.item.count) || 1) : Number(got.gold) || 0,
          name: got.item ? String(got.item.name) : String(got.name || '金松果'),
          gold: Number(got.gold) || 0, fallback: !!got.fallback,

          pet: got.item && got.item.pet ? got.item.pet : null,
        });
      }
      const loot = gains.items[0] || null;
      let combatId = '';
      let battleId = '';
      if (seatResult && !seatResult.skipped) {
        try {
          const fight = require('./fight');
          const id = fight.newCombatId();
          fight.recordCombat({
            id, kind: 'campaign', attackerId: accountId, defenderId: 0,
            seed: seed ^ (Number(m.seat) * 2654435761),
            result: seatResult.result, hash: battle.hashResult(seatResult.result),
            simVersion: '', winner: seatResult.result.winner,
            settlement: { boss: boss.name, win: teamWin, exp, gold: gains.gold, loot, lootList: gains.items, seat: Number(m.seat), teamWin, campaign: true, roomCode: String(room.code) },
            packet: { me: seatResult.fighter, foe: seatResult.foe,
              settlement: { boss: boss.name, win: teamWin, exp, gold: gains.gold, loot, lootList: gains.items, seat: Number(m.seat), teamWin, campaign: true, roomCode: String(room.code) } },
            attackerRev: 0,
          });
          combatId = id;
        } catch (e) {  }
        try {
          const entry = S.recordBattle({
            me: seatResult.fighter, foe: seatResult.foe, result: seatResult.result,
            region: 0, kind: 'campaign',
            online: { roomCode: String(room.code), bossId: room.boss_id, seat: Number(m.seat), combatId },
          });
          battleId = entry && entry.id ? entry.id : '';
        } catch (e) {  }
      }
      if (!Array.isArray(s.campaignRecords)) s.campaignRecords = [];
      s.campaignRecords.unshift({
        code: String(room.code), bossId: Number(room.boss_id), bossName: boss.name,
        win: teamWin, exp, gold: gains.gold, loot, lootList: gains.items, value: gains.value,
        seat: Number(m.seat), teamWin, bossHp, bossMaxHp,
        combatId, at: Date.now(),
      });
      s.campaignRecords = s.campaignRecords.slice(0, 20);
      return { exp, gold: gains.gold, loot, lootList: gains.items, value: gains.value,
        fallback: gains.fallback, prizeAwards: awards,
        ups: ups || [], combatId, battleId, seat: Number(m.seat) };
    }, { snapshotSource: 'campaign' });
    const v = out.value || {};
    const reward = {
      win: teamWin, exp: v.exp || 0, gold: v.gold || 0,
      loot: v.loot || null, lootList: Array.isArray(v.lootList) ? v.lootList : [],
      value: v.value || 0, fallback: !!v.fallback,
      ups: Array.isArray(v.ups) ? v.ups : [], combatId: v.combatId || '', battleId: v.battleId || '',
      prizeAwards: Array.isArray(v.prizeAwards) ? v.prizeAwards : [],
      seat: Number(m.seat), teamWin, bossHp, bossMaxHp, missed: false,
    };
    for (const award of reward.prizeAwards) prizeAwards.set(Number(award.index), award);
    db.run(
      'UPDATE campaign_members SET dice = -1, reward = ?, missed = 0 WHERE room_id = ? AND account_id = ?',
      gz(reward), String(room.id), accountId
    );
    if (v.combatId) combatIds.push({ seat: Number(m.seat), combatId: v.combatId });
    message(accountId,
      '征战「' + boss.name + '」已结束：' + (teamWin ? '队伍胜利' : '队伍失败') +
      '，' + rewardText(reward.gold, reward.lootList) + '。',
      { code: String(room.code), reward });
    settled.push({ accountId, reward, seat: Number(m.seat), member: m });
  }

  // 4b) 接力回放：助战/人机座位没有个人 `campaign_members`，补一份“旁观视角”战报；
  // 真人座位仍用自己那份（带真实奖励）。客户端按 seat 顺序依次回放整条接力。
  const seatByNo = new Map(seats.map((s) => [Number(s.seat), s]));
  const haveCombat = new Set(combatIds.map((c) => Number(c.seat)));
  for (const sr of seatResults) {
    if (!sr || sr.skipped || haveCombat.has(Number(sr.seat))) continue;
    const seat = seatByNo.get(Number(sr.seat));
    if (!seat) continue;
    try {
      const fight = require('./fight');
      const id = fight.newCombatId();
      const meta = {
        boss: boss.name, win: teamWin, exp: 0, gold: 0, loot: null, lootList: [],
        seat: Number(sr.seat), teamWin, campaign: true, roomCode: String(room.code),
      };
      fight.recordCombat({
        id, kind: 'campaign', attackerId: Number(seat.accountId) || 0, defenderId: 0,
        seed: seed ^ (Number(sr.seat) * 2654435761),
        result: sr.result, hash: battle.hashResult(sr.result), simVersion: '', winner: sr.result.winner,
        settlement: meta,
        packet: { me: sr.fighter, foe: sr.foe, settlement: meta },
        attackerRev: 0,
      });
      combatIds.push({ seat: Number(sr.seat), combatId: id });
      haveCombat.add(Number(sr.seat));
    } catch (e) {  }
  }

  // 公开版 `rollDatas`：界面只读这一份，别把内部 plan 原样丢给客户端。
  // `index` 去重：正常情况下 plan 就是唯一的，这一层只防旧数据/异常路径把同一份奖品
  // 带两遍，客户端不会因此多画一格。
  const seenPrize = new Set();
  const publicPrizes = (plan.prizes || []).filter((p) => {
    const index = Number(p.index);
    if (seenPrize.has(index)) return false;
    seenPrize.add(index);
    return true;
  }).map((p) => ({
    index: Number(p.index),
    prize: {
      key: String(p.prize.key || ''), kind: String(p.prize.kind || ''),
      name: String(p.prize.name || '战利品'),
      id: Number(p.prize.id) || 0, count: Math.max(1, Number(p.prize.count) || 1),
      gold: Number(p.prize.gold) || 0, quality: Number(p.prize.quality) || 0,
      value: Number(p.prize.value) || 0,

      pet: p.prize.pet ? {
        id: Number(p.prize.pet.id) || 0, name: String(p.prize.pet.name || '幻兽'),
        grade: Number(p.prize.pet.grade) || 1, level: Math.max(1, Number(p.prize.pet.level) || 1),
        maxLevel: Math.max(1, Number(p.prize.pet.maxLevel) || 1),
        skillId: Number(p.prize.pet.skillId) || 0,
        skillName: String(p.prize.pet.skillName || ''),
      } : null,
    },
    rolls: (p.rolls || []).map((r) => ({
      seat: Number(r.seat), accountId: Number(r.accountId) || 0,
      kind: String(r.kind || 'empty'), point: Number(r.point) || 0,
    })),
    winnerSeat: Number(p.winnerSeat), winnerAccountId: Number(p.winnerAccountId) || 0,
    winnerKind: String(p.winnerKind || 'empty'),
    forced: !!p.forced, discarded: !!p.discarded,
    award: prizeAwards.get(Number(p.index)) || null,
  }));
  const rollData = { seed, count: publicPrizes.length, prizes: publicPrizes };
  const publicSeats = seats.map((seat) => {
    const sr = seatResults.find((r) => Number(r.seat) === Number(seat.seat)) || {};
    return {
      seat: Number(seat.seat), kind: seat.kind, accountId: Number(seat.accountId || 0),
      snapshotId: String(seat.snapshotId || ''), name: seat.name, tag: String(seat.tag || ''),
      level: Number(seat.level) || 0, skipped: !!sr.skipped,
      win: !!sr.win, bossHpBefore: Number(sr.bossHpBefore) || 0, bossHpAfter: Number(sr.bossHpAfter) || 0,
      combatId: (combatIds.find((c) => Number(c.seat) === Number(seat.seat)) || {}).combatId || '',
    };
  });
  db.tx(() => {
    db.run(
      `UPDATE campaign_rooms SET status = 'done', team_result = ?, boss_max_hp = ?, boss_hp = ?,
         seats_json = ?, roll_json = ?, combat_ids = ?, start_at = ?, closed_at = ?, failed_reason = '' WHERE id = ? AND status = 'waiting'`,
      teamWin ? 'win' : 'lose', bossMaxHp, bossHp, JSON.stringify(publicSeats),
      JSON.stringify(rollData), JSON.stringify(combatIds), now(), now(), String(room.id)
    );
  });
  return { ok: true, status: 'done', seed, teamWin, bossHp, bossMaxHp, seats: publicSeats, roll: rollData, settled };
}

function pump() {
  reap(false);
  // 一次带出每个等待房的真实人数，避免每房一次 membersOf（50 房 = 50 次 JOIN）。
  const rows = db.all(
    `SELECT r.*, (SELECT COUNT(*) FROM campaign_members m
                    WHERE m.room_id = r.id AND m.missed = 0) AS real_count
       FROM campaign_rooms r WHERE r.status = 'waiting' ORDER BY r.created_at ASC LIMIT 50`
  );
  const ts = now();
  for (const room of rows) {
    const count = Number(room.real_count) || 0;
    if (!count) {
      db.run("UPDATE campaign_rooms SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'waiting'", ts, String(room.id));
      continue;
    }
    if (count >= partySize()) {
      try { resolveRoom(room.id); } catch (e) {  }
      continue;
    }
    if (String(room.mode) === 'random') {
      try { resolveRoom(room.id); } catch (e) {}
      continue;
    }
    const deadline = Number(room.resolve_at) || (Number(room.created_at) + config.campaignMatchWaitMs);
    if (deadline > 0 && ts >= deadline) failRoom(room, 'timeout');
  }
}

let lastReapAt = 0;
// 只做轻量清理：没有真人的等待房直接取消；到点的超时交给 pump。
function reap(force) {
  const ts = now();
  if (force === false && ts - lastReapAt < 5000) return;
  lastReapAt = ts;
  const rows = db.all(
    `SELECT r.id FROM campaign_rooms r
      WHERE r.status = 'waiting'
        AND NOT EXISTS (SELECT 1 FROM campaign_members m WHERE m.room_id = r.id AND m.missed = 0)`
  );
  for (const r of rows) {
    db.run("UPDATE campaign_rooms SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'waiting'", ts, String(r.id));
  }
}

function status({ accountId, code }) {
  pump();
  const room = db.get('SELECT * FROM campaign_rooms WHERE code = ? ORDER BY created_at DESC LIMIT 1', String(code).toUpperCase());
  if (!room) { const e = new Error('房间不存在'); e.code = 'NOT_FOUND'; throw e; }
  return { ok: true, room: roomView(room, accountId) };
}

function list({ accountId }) {
  reap();
  const rows = db.all("SELECT * FROM campaign_rooms WHERE status = 'waiting' AND mode = 'real' ORDER BY created_at DESC LIMIT 20");
  return { ok: true, rooms: rows.map((r) => roomView(r, accountId)) };
}

function current({ accountId }) {
  pump();
  const row = db.get(
    `SELECT r.* FROM campaign_rooms r JOIN campaign_members m ON m.room_id = r.id
      WHERE m.account_id = ? AND (r.status = 'waiting' OR (r.status IN ('done','failed') AND m.acked = 0))
      ORDER BY r.created_at DESC LIMIT 1`,
    Number(accountId)
  );
  return { ok: true, room: row ? roomView(row, accountId) : null };
}

function leave({ accountId, code }) {
  const room = db.get('SELECT * FROM campaign_rooms WHERE code = ?', String(code).toUpperCase());
  if (!room) { const e = new Error('房间不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (String(room.status) !== 'waiting') { const e = new Error('已经开打了，不能退出'); e.code = 'CONFLICT'; throw e; }
  const member = memberRow(room.id, accountId);
  if (!member) return { ok: true, left: false, refunded: false };
  db.tx(() => {
    db.run('DELETE FROM campaign_members WHERE room_id = ? AND account_id = ?', String(room.id), Number(accountId));
    const remaining = membersOf(room.id);
    if (!remaining.length) {
      db.run("UPDATE campaign_rooms SET status = 'cancelled', closed_at = ? WHERE id = ?", now(), String(room.id));
    } else if (Number(room.host_id) === Number(accountId)) {
      db.run('UPDATE campaign_rooms SET host_id = ? WHERE id = ?', Number(remaining[0].account_id), String(room.id));
    }
  });
  return { ok: true, left: true, refunded: false };
}

function ack({ accountId, code }) {
  const room = db.get('SELECT * FROM campaign_rooms WHERE code = ? ORDER BY created_at DESC LIMIT 1', String(code).toUpperCase());
  if (!room) { const e = new Error('房间不存在'); e.code = 'NOT_FOUND'; throw e; }
  db.run('UPDATE campaign_members SET acked = 1 WHERE room_id = ? AND account_id = ?', String(room.id), Number(accountId));
  return { ok: true };
}

// 兼容旧测试/管理入口：手动建房、按 code 加入、强制结算。
function create({ accountId, bossId }) {
  pump();
  const { boss } = ensureEligible(accountId, bossId);
  db.tx(() => {
    if (activeRoom(accountId)) { const e = new Error('已经报名其他征战队列'); e.code = 'CONFLICT'; throw e; }
    createRoom({ accountId, boss, mode: 'real', resolveAt: now() + config.campaignMatchWaitMs, seats: [] });
  });
  const room = db.get("SELECT * FROM campaign_rooms WHERE host_id = ? AND status = 'waiting' ORDER BY created_at DESC LIMIT 1", Number(accountId));
  return { ok: true, joined: true, room: roomView(room, accountId) };
}

function join({ accountId, code }) {
  const room = db.get("SELECT * FROM campaign_rooms WHERE code = ? AND status = 'waiting'", String(code).toUpperCase());
  if (!room) { const e = new Error('房间不存在或已经开始'); e.code = 'NOT_FOUND'; throw e; }
  if (memberRow(room.id, accountId)) return { ok: true, already: true, room: roomView(room, accountId) };
  ensureEligible(accountId, room.boss_id);
  db.tx(() => {
    if (countReal(room.id) >= partySize()) { const e = new Error('房间已满'); e.code = 'CONFLICT'; throw e; }
    db.run(
      'INSERT INTO campaign_members (room_id, account_id, seat, snapshot_id, joined_at, missed) VALUES (?,?,?,?,?,0)',
      String(room.id), Number(accountId), freeSeat(room.id), '', now()
    );
  });
  pump();
  return { ok: true, joined: true, room: roomView(roomOf(room.id), accountId) };
}

function runRoom(roomId) {
  const result = resolveRoom(roomId);
  const room = roomOf(roomId);
  const members = room ? membersOf(room.id) : [];
  const settled = members.map((m) => ({ member: m, reward: unz(m.reward) || {} }));
  return { ok: true, result, room: room ? roomView(room, room.host_id) : null, settled };
}

function dailyStatus(accountId) {
  const used = settlement.todayCount(accountId, 'campaign');
  const limit = config.campaignDailyLimit;
  return { used, limit, left: Math.max(0, limit - used) };
}

module.exports = {
  create, join, leave, list, status, enqueue, randomMatch, current, runRoom, ack, reap, pump,
  roomView, roomOf, dailyStatus, resolveRoom, failRoom,
};
