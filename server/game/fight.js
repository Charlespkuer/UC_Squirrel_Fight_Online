'use strict';
// server/game/fight.js — 所有战斗的服务端编排
// 客户端只负责播服务端返回的 `result`；胜负、经验、金币、金杯、积分、
// 掉落、每日次数全在服务端算。支持的种类：

const crypto = require('node:crypto');
const db = require('../db');
const runtime = require('./runtime');
const store = require('./store');
const battle = require('./battle');
const snapshots = require('./snapshot');
const visibility = require('./visibility');
const opponents = require('./opponents');
const apprentice = require('./apprentice');
const chests = require('./chests');
const settlement = require('./settlement');
const { fighterFromState, fighterFromSnapshot } = require('./fighter');
const { config, seasonId, localDate } = require('../config');

function newCombatId() {
  return 'c_' + crypto.randomBytes(10).toString('base64url');
}

// 战斗前把徒弟存档里的师父等级对齐到师父当前存档；客户端会主动请求一次，
// 这里兜底，避免旧客户端/请求失败时仍用拜师时的旧等级。
function refreshMasterFor(accountId, save) {
  try { apprentice.refreshMasterLevelInto(accountId, save); } catch (_) {}
}

function recordCombat(row) {
  chests.create(row);
  if (row.packet && !row.revenge && ['random', 'rank', 'stage', 'arena'].includes(row.kind)
    && !(row.settlement && row.settlement.practice)) {
    // 50 级以上的天梯战斗才把黑装碎片放进拾取池；等级随战斗记录落库，领取时用同一份重算。
    const pickupLevel = Number(row.settlement && row.settlement.pickupLevel) || 0;
    const pickupKind = row.kind === 'rank' ? 'rank' : row.kind === 'stage' ? 'stage' : 'challenge';
    row.packet.pickups = globalThis.BattleDrops.plan(battle.mulberry32(row.seed ^ 0x751278ab), pickupKind, { level: pickupLevel });
  }
  const saved = Object.assign({}, row.settlement || {});
  let repro = null;
  if (row.packet) {
    // 只留可复现面板；把 me/foe 从 settlement 里拆出来，避免重复存两份。
    // result 也不再入库，客户端拿到的完整 result 会由客户端本地缓存。
    const { me, foe, result: _result, rev: _rev, patch: _patch, save: _save, settlement, ...meta } = row.packet;
    if (me && foe) repro = store.encode({ me, foe });
    saved.__meta = Object.assign({}, meta, settlement ? { settlement } : {});
  }
  const result = row.result && typeof row.result === 'object'
    ? { winner: row.result.winner, maxHp: row.result.maxHp, names: row.result.names }
    : row.result;
  db.run(
    `INSERT INTO combats (id, idem_key, kind, season, attacker_id, defender_id, snapshot_id, seed, result, repro, hash,
       sim_version, winner, settlement, attacker_rev, defender_rev, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    String(row.id), String(row.idemKey || ''), String(row.kind), String(row.season || seasonId()),
    Number(row.attackerId), Number(row.defenderId || 0), String(row.snapshotId || ''),
    Number(row.seed), store.encode(result), repro, String(row.hash), String(row.simVersion || ''),
    Number(row.winner), JSON.stringify(saved),
    Number(row.attackerRev || 0), Number(row.defenderRev || 0), Date.now()
  );
}

// 用 seed + 双方面板复算；hash 校验能挡住 sim 版本/篡改导致的错录像。
function reproduceCombat(row, repro) {
  if (!repro || !repro.me || !repro.foe) return null;
  const result = simulate(Number(row.seed), repro.me, repro.foe);
  const hash = battle.hashResult(result);
  if (row.hash && String(hash) !== String(row.hash)) {

    const stored = (() => { try { return store.decode(row.result); } catch (_) { return null; } })();
    if (stored && Array.isArray(stored.rounds) && stored.rounds.length) return stored;
    const e = new Error('这场录像的模拟版本已变化，无法回放');
    e.code = 'CONFLICT';
    throw e;
  }
  return result;
}

function combatPacket(saved, row, result, repro) {
  const oldPacket = saved.__packet || null;
  const meta = cachedMeta(saved) || {};
  return {
    ...meta,
    me: repro ? repro.me : (oldPacket && oldPacket.me),
    foe: repro ? repro.foe : (oldPacket && oldPacket.foe),
    result,
    settlement: meta.settlement || (oldPacket && oldPacket.settlement) || cachedTopSettlement(saved),
  };
}

function cachedMeta(saved) {
  return saved.__meta || saved.__packet || null;
}

function cachedTopSettlement(saved) {
  const out = {};
  for (const key of Object.keys(saved || {})) {
    if (key === '__meta' || key === '__packet' || key === '__revenge') continue;
    out[key] = saved[key];
  }
  return out;
}

function idemFor(accountId, kind, key) { return key ? accountId + ':' + kind + ':' + key : ''; }
function duplicateCombat(accountId, kind, key) {
  if (!key) return null;
  const row = db.get(`SELECT * FROM combats WHERE attacker_id = ? AND kind = ? AND idem_key IN (?, ?) LIMIT 1`,
    Number(accountId), kind, idemFor(accountId, kind, key), String(key));
  if (!row) return null;
  const saved = JSON.parse(row.settlement || '{}');
  const { __packet, __meta, __revenged, ...settled } = saved;
  const repro = row.repro ? store.decode(row.repro) : null;
  const result = repro ? reproduceCombat(row, repro) : store.decode(row.result);
  const current = store.getRow(accountId);
  return {
    ...combatPacket(saved, row, result, repro),
    ok: true, duplicate: true, combatId: String(row.id), seed: Number(row.seed),
    chest: chests.status(row.id, accountId),
    simVersion: String(row.sim_version),
    rev: Number(current.revision), patch: null,
    save: settlement.syncIntegral(accountId, store.decode(current.payload)),
  };
}

function message(accountId, kind, text, opts) {
  const o = opts || {};
  db.run(
    `INSERT INTO messages (id, account_id, kind, combat_id, from_id, from_name, text, payload, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    'm_' + crypto.randomBytes(10).toString('base64url'), Number(accountId), String(kind),
    String(o.combatId || ''), Number(o.fromId || 0), String(o.fromName || ''),
    String(text), JSON.stringify(o.payload || {}), Date.now()
  );
}

function simulate(seed, me, foe) {
  return battle.simulate(seed, me, foe);
}

function simVersion() {
  try { return runtime.boot().simVersion; } catch (_) { return 'unknown'; }
}

function buildRandomFoe(S, myLevel) {
  return opponents.buildRandomFoe(S, myLevel);
}

function runRandom({ accountId, snapshotId, rev, idemKey, revengeOf }) {
  // ssfight 的复仇只认天梯战报（`getRankMessage` / `revenge.do`）；
  // 随机挑战的败绩没有复仇入口。旧客户端误传时明确拒绝，避免又开出一条无消耗重打。
  if (revengeOf) {
    const e = new Error('复仇只适用于天梯赛战报');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const combatKind = 'random';
  const duplicate = duplicateCombat(accountId, combatKind, idemKey);
  if (duplicate) return duplicate;
  const seed = battle.randomSeed();
  const id = newCombatId();
  let out, response;
  let myName = '';
  let selected = null;
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      if (!S.consumeEnergy(10)) { const e = new Error('体力不足（需要 10 点）'); e.code = 'CONFLICT'; throw e; }
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: true, cheerAccountId: accountId });
      // offer 或「查看」保存下来的原始快照号都能打：后者不受内存 offer 重启/TTL 影响。
      selected = snapshotId ? opponents.resolveTarget(snapshotId, accountId, 'random', me.level) : null;
      const foe = selected ? fighterFromSnapshot(selected.fighter) : battle.withSeed(seed, () => buildRandomFoe(S, me.level));
      const opponent = selected ? selected.public : {
        source: 'bot', player: false, bot: true, practice: false, kind: 'random', accountId: 0,
        snapshotId: '', name: foe.name, level: foe.level, tag: '', display: foe.name + '（AI对手）',
      };
      const result = simulate(seed, me, foe);
      const win = result.winner === 0;
      const reward = S.fightReward(win, { foeLevel: foe.level, useProps: true });
      const drop = null;
      myName = String(s.name || '');
      const entry = S.recordBattle({
        me, foe, result, region: 0, kind: 'challenge',
        online: {
          combatId: id,
          opponentId: opponent.accountId,
          snapshotId: opponent.snapshotId || '',
          source: opponent.source,
          revengeOf: '',
        },
      });
      return { me, foe, result, reward, win, drop, opponent, battleId: entry ? entry.id : null };
    }, { expectRev: rev, snapshotSource: 'random' });
    const v = out.value;
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(), me: v.me, foe: v.foe, result: v.result,
      opponent: v.opponent, reward: v.reward,
      settlement: {
        kind: 'random', win: v.win,
        exp: v.reward.exp, gold: v.reward.gold, ups: v.reward.ups || [], drop: v.drop,
        revenge: false, revengeOf: '',
      },
      battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, combatKind, idemKey), kind: combatKind, attackerId: accountId,
      defenderId: v.opponent ? v.opponent.accountId : 0,
      snapshotId: v.opponent ? v.opponent.snapshotId || '' : '',
      seed, result: v.result, hash: battle.hashResult(v.result), simVersion: simVersion(),
      winner: v.result.winner,
      settlement: {
        win: v.win, exp: v.reward.exp, gold: v.reward.gold, drop: v.drop,
        ups: (v.reward.ups || []).length, revengeOf: '',
      },
      attackerRev: out.rev,
      packet: response,
    });
    // 被真人挑战的防守快照：给防守方留一条消息（主动挑战方自己不写消息，
    // 所以主界面 NEW 红点不会被自己的战斗点亮）。消息带快照等级与胜负，
    // 客户端按 `defense_win/defense_loss` 选胜败印章，`combatId` 走防守视角回放。
    if (v.opponent && v.opponent.player && Number(v.opponent.accountId) > 0 && !visibility.isHidden(accountId)) {
      const defWin = v.result.winner !== 0;
      const level = Math.max(1, Number(selected && selected.fighter && selected.fighter.level) || (v.foe && v.foe.level) || 1);
      message(v.opponent.accountId, defWin ? 'defense_win' : 'defense_loss',
        '【' + (myName || '对手') + '】挑战了你 Lv.' + level + ' 的防守快照，你' + (defWin ? '获胜了' : '落败了') + '。',
        {
          combatId: id, fromId: accountId, fromName: myName,
          payload: {
            level,
            snapshotId: String((selected && (selected.playerSnapshotId || (selected.public && selected.public.snapshotId))) || ''),
            defenderWin: defWin,
            attackerWin: !!v.win,
          },
        });
    }
  });
  return response;
}

function loadSnapshotFor(accountId, snapshotId) {
  const snap = snapshots.snapshotById(snapshotId);
  if (!snap) { const e = new Error('对手不存在'); e.code = 'NOT_FOUND'; throw e; }
  if (snap.accountId === Number(accountId)) { const e = new Error('不能挑战自己'); e.code = 'BAD_REQUEST'; throw e; }
  return snap;
}

// 时间戳只作为兼容迁移（旧数据算一次）。
function revengeInfoFor(accountId, revengeOf) {
  const id = String(revengeOf || '');
  if (!id) return null;
  const row = db.get('SELECT attacker_id, defender_id, kind, winner, settlement, created_at FROM combats WHERE id = ?', id);
  if (!row || String(row.kind) !== 'rank') return null;
  // 隐身方发起的挑战不留下可复仇的战报；即使旧战报已经存在，也不让防守方进入复仇。
  if (visibility.isHidden(Number(row.attacker_id))) return null;
  const mine = Number(accountId);
  // 原版「被抢方可复仇」：只有被动方、原战斗输掉、且确实被抢过金杯，
  // 并且只在战报当天有效。主动挑战失败不产生复仇入口。
  if (Number(row.defender_id) !== mine || Number(row.winner) !== 0) return null;
  let saved;
  try { saved = JSON.parse(row.settlement || '{}'); } catch (_) { return null; }
  // 隐身方发起时写入的标记要永久生效：对方之后取消隐身，也不能把旧战报变成复仇入口。
  if (saved && saved.hiddenAttacker) return null;
  // 复仇战本身产生的战报不能再拿去复仇。
  if (saved && saved.revenge) return null;
  const robbed = Math.max(0, Number(saved && saved.defender && saved.defender.robbed) || 0);
  if (robbed <= 0) return null;
  if (localDate(Number(row.created_at) || 0) !== localDate()) return null;
  const key = String(mine);
  const rec = saved && saved.__revenge && saved.__revenge[key];
  let count = rec ? Math.max(0, Number(rec.count) || 0) : 0;
  if (!count && saved && saved.__revenged && Number(saved.__revenged[key]) > 0) count = 1;
  return {
    combatId: id,
    count,
    cost: (count + 1) * 20,
    cups: (count + 1) * 5 + 3,
    robbed,
    eligible: true,
    day: localDate(Number(row.created_at) || 0),
  };
}

function isRevengeOf(accountId, snap, revengeOf) {
  const info = revengeInfoFor(accountId, revengeOf);
  if (!info) return false;
  const row = db.get('SELECT attacker_id, defender_id FROM combats WHERE id = ?', info.combatId);
  const mine = Number(accountId), other = Number(snap.accountId);
  return !!row && Number(row.defender_id) === mine && Number(row.attacker_id) === other;
}

function markRevenge(combatId, accountId, win) {
  const id = String(combatId || '');
  if (!id) return;
  const row = db.get('SELECT settlement FROM combats WHERE id = ?', id);
  if (!row) return;
  let saved;
  try { saved = JSON.parse(row.settlement || '{}'); } catch (_) { saved = {}; }
  const key = String(Number(accountId));
  const rec = (saved.__revenge && saved.__revenge[key]) || {};
  const count = Math.max(0, Number(rec.count) || 0) + 1;
  saved.__revenge = Object.assign({}, saved.__revenge || {}, {
    [key]: { count, lastAt: Date.now(), lastWin: !!win },
  });
  // 兼容旧客户端/旧字段：胜利也写一次 `__revenged`，但新逻辑不再用它拦截重复复仇。
  if (win) saved.__revenged = Object.assign({}, saved.__revenged || {}, { [key]: Date.now() });
  db.run('UPDATE combats SET settlement = ? WHERE id = ?', JSON.stringify(saved), id);
}

function rankDefenderExp(defWin, defenderLevel, attackerLevel) {
  const base = defWin ? 3 : 2;
  const diff = Math.max(0, (Number(attackerLevel) || 1) - (Number(defenderLevel) || 1));
  return Math.min(4, base + (diff >= 10 ? 1 : 0));
}

function applyRating(accountId, win, score) {
  const week = settlement.weekKey();
  settlement.ensureRating(accountId, week);
  const row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), week);
  const streak = win ? Math.max(1, Number(row.streak) + 1) : Math.min(-1, Number(row.streak) - 1);
  db.run(
    'UPDATE ratings SET score = ?, wins = wins + ?, losses = losses + ?, streak = ?, updated_at = ? WHERE account_id = ? AND season = ?',
    Math.round(Number(score) || 0), win ? 1 : 0, win ? 0 : 1, streak, Date.now(), Number(accountId), week
  );
  settlement.invalidateDivisionRows();
}

function runRank({ accountId, snapshotId, rev, idemKey, revengeOf }) {
  const duplicate = duplicateCombat(accountId, 'rank', idemKey);
  if (duplicate) return duplicate;
  const selected = opponents.isOffer(snapshotId) ? opponents.resolve(snapshotId, accountId, 'rank') : null;
  if (selected && selected.source === 'bot') return runRankBot({ accountId, selected, rev, idemKey });

  // 后面 runOnSave 直接复用这行：同一个请求里同一份存档只解一次。
  const meRow = store.getRow(accountId);
  const meSave = meRow ? store.decode(meRow.payload) : null;
  if (!meSave) {
    const e = new Error('还没有存档'); e.code = 'CONFLICT'; throw e;
  }
  if (Number(meSave.level) < 30) {
    const e = new Error('天梯赛需要达到30级。'); e.code = 'CONFLICT'; throw e;
  }
  // 赛区制：真人对手必须和自己同一个赛区（10 级一档）。复仇是唯一例外 ——
  if (selected && !revengeOf) {
    const myDiv = settlement.divisionOf(Number(meSave.level));
    const foeDiv = settlement.divisionOf(Number(selected.fighter.level) || 0);
    if (!myDiv || !foeDiv || myDiv.key !== foeDiv.key) {
      const e = new Error('对手已经不在你的赛区（' + (myDiv ? myDiv.label : '未满30级') + '），请刷新对手。');
      e.code = 'CONFLICT';
      throw e;
    }
  }
  // 不收天梯入场金松果。费用在开打前由服务端扣，输赢都付。
  const revenge = revengeOf ? revengeInfoFor(accountId, revengeOf) : null;
  if (revengeOf && !revenge) {
    const e = new Error('这条天梯战报不能复仇（不是你的战报或已失效）');
    e.code = 'FORBIDDEN';
    throw e;
  }
  if (revenge && Math.max(0, Number(meSave.goldPoint) || 0) < revenge.cost) {
    const e = new Error('复仇需要 ' + revenge.cost + ' 个金松果，当前只有 ' + Math.max(0, Number(meSave.goldPoint) || 0) + ' 个。');
    e.code = 'CONFLICT';
    e.extra = { revenge };
    throw e;
  }
  const daily = settlement.rankDailyStatus(accountId);
  if (!revenge) {
    if (!daily.unlimited && daily.left <= 0) {
      const e = new Error('今天的 ' + daily.limit + ' 场天梯赛已经打完了，明天再来吧。');
      e.code = 'CONFLICT';
      e.extra = { daily };
      throw e;
    }
    if (daily.cost > 0) {
      if (Math.max(0, Number(meSave.goldPoint) || 0) < daily.cost) {
        const e = new Error('金松果不足：今天第 ' + daily.tierStart + ' 场起每场需要 ' + daily.cost + ' 金松果。');
        e.code = 'CONFLICT';
        e.extra = { daily };
        throw e;
      }
    }
  }
  let snap = selected ? { id: selected.playerSnapshotId, accountId: selected.accountId, fighter: selected.fighter } : loadSnapshotFor(accountId, snapshotId);
  // 不接受任意 snapshot 直连：普通挑战必须来自服务端候选；只有战报里的
  // 「再次挑战」可以用 raw snapshot，且必须能对上那条败绩。
  if (!selected && !isRevengeOf(accountId, snap, revengeOf)) {
    const e = new Error('请从对手列表选择对手（或从战报中再次挑战）。');
    e.code = 'FORBIDDEN'; throw e;
  }
  // 只用来确认「和谁再打一场」，真正上场的换成对方当前的 is_current 快照。
  // 这样低等级/过期的旧快照不会再被当成对手面板。
  if (!selected) {
    const current = snapshots.currentSnapshot(snap.accountId, 'classic');
    if (current && current.fighter) snap = { id: current.id, accountId: current.accountId, fighter: current.fighter };
  }
  const foeFighter = fighterFromSnapshot(snap.fighter);
  if (!foeFighter) { const e = new Error('对手快照已失效'); e.code = 'CONFLICT'; throw e; }
  // 候选是 10 分钟内发的票：对方这期间升过级、刚跨出赛区时，换完当前快照再核一次。
  if (!revenge) {
    const myDiv2 = settlement.divisionOf(Number(meSave.level));
    const foeDiv2 = settlement.divisionOf(Number(foeFighter.level) || 0);
    if (!myDiv2 || !foeDiv2 || myDiv2.key !== foeDiv2.key) {
      const e = new Error('对手已经不在你的赛区，请刷新对手。');
      e.code = 'CONFLICT';
      throw e;
    }
  }

  const seed = battle.randomSeed();
  const id = newCombatId();
  const myScore = settlement.ratingOf(accountId);
  const foeScore = settlement.ratingOf(snap.accountId);
  const target = db.get('SELECT name, tag FROM accounts WHERE id = ?', snap.accountId);
  const opponent = selected ? selected.public : {
    source: 'player', player: true, bot: false, practice: false, kind: 'rank',
    accountId: snap.accountId, snapshotId: snap.id, name: target.name, tag: target.tag,
    level: foeFighter.level, score: foeScore, display: target.name,
  };

  const defenderBefore = revenge ? store.peek(snap.accountId) : null;
  const defenderCups = revenge ? Math.max(0, Number(defenderBefore && defenderBefore.goldCup) || 0) : 0;
  let out, response;
  let defenderOut;
  let myName = '';
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: false, cheerAccountId: accountId });
      const result = simulate(seed, me, foeFighter);
      const win = result.winner === 0;
      if (revenge) {
        if (Math.max(0, Number(s.goldPoint) || 0) < revenge.cost) {
          const e = new Error('复仇需要 ' + revenge.cost + ' 个金松果，当前不足。');
          e.code = 'CONFLICT';
          throw e;
        }

        S.addGold(-revenge.cost, { count: false });
      } else if (daily.cost > 0) S.addGold(-daily.cost, { count: false });
      const pair = settlement.rankDeltaPair(myScore, foeScore, win);
      const delta = pair.attackerDelta;
      const newScore = settlement.clampScore(myScore + delta);
      const exp = revenge
        ? (win ? S.challengeExp(foeFighter.level, s.level) : 0)
        : (win ? S.challengeExp(foeFighter.level, s.level) : config.rankLoseExp);
      const ups = exp > 0 ? S.gainExp(exp) : [];
      const stolen = revenge && win ? Math.min(revenge.cups, defenderCups) : 0;
      S.addGoldCup(revenge ? stolen : (win ? config.rankWinCup : config.rankLoseCup));
      s.integral = newScore;

      const canRob = !revenge && win && Math.random() < config.rankRobChance;
      const drop = null;
      myName = String(s.name || '');
      const entry = S.recordBattle({
        me, foe: foeFighter, result, region: 0, kind: 'rank',
        online: {
          combatId: id, opponentId: snap.accountId, snapshotId: snap.id, rankScore: newScore, delta,
          revenge: !!revenge, revengeCount: revenge ? revenge.count : 0,
        },
      });
      if (revenge) {

        const old = (Array.isArray(s.battles) ? s.battles : [])
          .find((b) => b && b.online && String(b.online.combatId) === String(revengeOf));
        if (old) {
          old.revengeCount = revenge.count + 1;
          if (win) old.revenged = Date.now();
        }
      }
      return {
        me, foe: foeFighter, result, win, delta, defenderDelta: pair.defenderDelta, newScore, exp, ups, canRob, drop,
        stolen, revengeCost: revenge ? revenge.cost : 0, revengeCups: revenge ? revenge.cups : 0,
        battleId: entry ? entry.id : null,
      };
    }, { row: meRow, expectRev: rev, snapshotSource: 'rank' });

    const v = out.value;
    const won = v.win;
    // 防守方结算：积分固定 ±1（挑战方赢 → -1、挑战方输 → +1，见 `rankDefenderDelta`），
    // 另有金杯与原版被动经验 2~4 点；经验有上限，不能按主动挑战全额发。
    defenderOut = store.runOnSave(snap.accountId, ({ api: S2, save: s2 }) => {
      const defWin = !won;
      let robbed = 0;
      const defExp = rankDefenderExp(defWin, s2.level, foeFighter.level);
      const defUps = defExp > 0 ? S2.gainExp(defExp) : [];
      if (revenge) {

        robbed = won ? Math.min(v.stolen, Math.max(0, Number(s2.goldCup) || 0)) : 0;
        if (robbed > 0) s2.goldCup = Math.max(0, Number(s2.goldCup) - robbed);
        const dDelta = v.defenderDelta;
        s2.integral = settlement.clampScore(foeScore + dDelta);
        return { defWin, dDelta, robbed, newScore: s2.integral, goldCup: s2.goldCup, exp: defExp, ups: defUps };
      }
      if (won && v.canRob && Math.max(0, Number(s2.goldCup) || 0) >= config.rankRobCup) {
        s2.goldCup = Math.max(0, Number(s2.goldCup) - config.rankRobCup);
        robbed = config.rankRobCup;
      }
      const dDelta = v.defenderDelta;
      s2.integral = settlement.clampScore(foeScore + dDelta);
      S2.addGoldCup(defWin ? config.rankWinCup : config.rankLoseCup);
      return { defWin, dDelta, robbed, newScore: s2.integral, goldCup: s2.goldCup, exp: defExp, ups: defUps };
    }, { snapshotSource: 'defense' });

    applyRating(accountId, won, v.newScore);
    applyRating(snap.accountId, !won, defenderOut.value.newScore);

    if (!revenge) settlement.bumpDaily(accountId, 'rank', 1);

    const defenseLevel = Math.max(1, Number(foeFighter.level) || Number(snap.level) || 1);
    if (!visibility.isHidden(accountId)) {
      message(snap.accountId, won ? 'rank_loss' : 'rank_win',
        '【' + (myName || '对手') + '】在' + (revenge ? '复仇战' : '天梯赛') + (won ? '击败了' : '输给了') + '你（你 Lv.'
          + defenseLevel + ' 的防守快照），获得'
          + (defenderOut.value.exp || 0) + '点经验。',
        {
          combatId: id, fromId: accountId, fromName: myName,
          payload: {
            level: defenseLevel,
            defenderWin: !won,
            delta: defenderOut.value.dDelta, robbed: defenderOut.value.robbed, score: defenderOut.value.newScore,
            exp: defenderOut.value.exp || 0,
            revenge: !!revenge, revengeCount: revenge ? revenge.count : 0,
          },
        });
    }

    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(), me: v.me, foe: v.foe, result: v.result, opponent,
      settlement: {
        kind: 'rank', win: v.win, exp: v.exp, ups: v.ups || [],
        goldCup: revenge ? v.stolen : (v.win ? config.rankWinCup : config.rankLoseCup),
        integral: { old: myScore, new: v.newScore, delta: v.delta, season: seasonId() },
        robbed: defenderOut.value.robbed,
        defender: { delta: v.defenderDelta, exp: defenderOut.value.exp || 0, ups: defenderOut.value.ups || [] },
        drop: v.drop || null, revengeOf: revengeOf || '',
        revenge: revenge ? {
          count: revenge.count, cost: revenge.cost, cups: revenge.cups,
          stolen: v.stolen, win: v.win,
        } : null,
      },
      daily: settlement.rankDailyStatus(accountId), battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'rank', idemKey), kind: 'rank', season: seasonId(),
      attackerId: accountId, defenderId: snap.accountId, revenge: !!revenge,
      snapshotId: snap.id, seed, result: v.result, hash: battle.hashResult(v.result),
      simVersion: simVersion(), winner: v.result.winner,
      settlement: {
        win: won, delta: v.delta, score: v.newScore, exp: v.exp,
        goldCup: revenge ? v.stolen : (won ? config.rankWinCup : config.rankLoseCup),
        defender: { delta: defenderOut.value.dDelta, robbed: defenderOut.value.robbed, score: defenderOut.value.newScore, exp: defenderOut.value.exp || 0 },
        drop: v.drop || null,
        revengeOf: revengeOf || '',
        pickupLevel: Number(meSave.level) || 0,
        hiddenAttacker: visibility.isHidden(accountId),
        revenge: revenge ? { count: revenge.count, cost: revenge.cost, cups: revenge.cups, stolen: v.stolen } : null,
      },
      attackerRev: out.rev, defenderRev: defenderOut.rev,
      packet: response,
    });

    if (revenge) markRevenge(revengeOf, accountId, won);
  });

  return response;
}

function runRankBot({ accountId, selected, rev, idemKey }) {
  const meRow = store.getRow(accountId);
  const meSave = meRow ? store.decode(meRow.payload) : null;
  if (!meSave) { const e = new Error('还没有存档'); e.code = 'CONFLICT'; throw e; }
  if (Number(meSave.level) < 30) { const e = new Error('天梯赛需要达到30级。'); e.code = 'CONFLICT'; throw e; }
  const myDiv = settlement.divisionOf(Number(meSave.level));
  const botDiv = settlement.divisionOf(Number(selected.fighter.level) || 0);
  if (!myDiv || !botDiv || myDiv.key !== botDiv.key) {
    const e = new Error('这个对手已经不在你的赛区，请重新匹配。');
    e.code = 'CONFLICT'; throw e;
  }
  const daily = settlement.rankDailyStatus(accountId);
  if (!daily.unlimited && daily.left <= 0) {
    const e = new Error('今天的 ' + daily.limit + ' 场天梯赛已经打完了，明天再来吧。');
    e.code = 'CONFLICT'; e.extra = { daily }; throw e;
  }
  if (daily.cost > 0 && Math.max(0, Number(meSave.goldPoint) || 0) < daily.cost) {
    const e = new Error('金松果不足：今天第 ' + daily.tierStart + ' 场起每场需要 ' + daily.cost + ' 金松果。');
    e.code = 'CONFLICT'; e.extra = { daily }; throw e;
  }
  const foeFighter = fighterFromSnapshot(selected.fighter);
  if (!foeFighter) { const e = new Error('对手已失效，请刷新列表'); e.code = 'CONFLICT'; throw e; }
  const seed = battle.randomSeed();
  const id = newCombatId();
  const myScore = settlement.ratingOf(accountId);
  const bot = settlement.botById(selected.botId);
  const foeScore = bot ? Math.max(0, Number(bot.score) || 0) : config.rankBotBaseScore;
  let out, response;
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: false, cheerAccountId: accountId });
      const result = simulate(seed, me, foeFighter);
      const win = result.winner === 0;
      if (daily.cost > 0) S.addGold(-daily.cost, { count: false });
      const pair = settlement.rankDeltaPair(myScore, foeScore, win, null, config.rankBotFloor);
      const delta = win ? pair.attackerDelta : settlement.rankBotLoseDelta(pair.attackerDelta);
      const newScore = settlement.clampScore(myScore + delta);
      const exp = win ? S.challengeExp(foeFighter.level, s.level) : config.rankLoseExp;
      const ups = exp > 0 ? S.gainExp(exp) : [];
      S.addGoldCup(win ? config.rankWinCup : config.rankLoseCup);
      s.integral = newScore;
      const entry = S.recordBattle({
        me, foe: foeFighter, result, region: 0, kind: 'rank',
        online: {
          combatId: id, opponentId: 0, snapshotId: selected.id, source: 'bot',
          botId: bot ? String(bot.id) : '', rankScore: newScore, delta,
        },
      });
      return {
        me, foe: foeFighter, result, win, delta, newScore, exp, ups,
        defenderDelta: pair.defenderDelta, battleId: entry ? entry.id : null,
      };
    }, { row: meRow, expectRev: rev, snapshotSource: 'rank' });
    const v = out.value;
    applyRating(accountId, v.win, v.newScore);
    settlement.bumpDaily(accountId, 'rank', 1);

    if (bot) settlement.applyBotResult(bot.id, v.win, v.defenderDelta);
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(), me: v.me, foe: v.foe, result: v.result,
      opponent: selected.public,
      settlement: {
        kind: 'rank', win: v.win, exp: v.exp, ups: v.ups || [], practice: false, bot: true, fallback: false,
        goldCup: v.win ? config.rankWinCup : config.rankLoseCup,
        integral: { old: myScore, new: v.newScore, delta: v.delta, season: settlement.weekKey() },
        robbed: 0, drop: null, revengeOf: '',
        botScore: bot ? Math.max(0, Number(bot.score) || 0) : foeScore,
        defender: { delta: v.defenderDelta },
      },
      daily: settlement.rankDailyStatus(accountId), battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'rank', idemKey), kind: 'rank', season: seasonId(), attackerId: accountId,
      defenderId: 0, snapshotId: selected.id, seed, result: v.result, hash: battle.hashResult(v.result),
      simVersion: simVersion(), winner: v.result.winner,
      settlement: {
        win: v.win, delta: v.delta, score: v.newScore, exp: v.exp, fallback: false,
        goldCup: v.win ? config.rankWinCup : config.rankLoseCup, bot: true, drop: null, revengeOf: '',
        pickupLevel: Number(meSave.level) || 0,
        botId: bot ? String(bot.id) : '',
        defender: { delta: v.defenderDelta },
      },
      attackerRev: out.rev, packet: response,
    });
  });
  return response;
}

function mergePatch(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const set = Object.assign({}, a.set || {}, b.set || {});
  const del = Array.from(new Set([...(a.del || []), ...(b.del || [])])).filter((k) => !(k in set));
  return { set, del };
}

function runRecruit({ accountId, targetAccountId, rev, idemKey }) {
  const duplicate = duplicateCombat(accountId, 'recruit', idemKey);
  if (duplicate) return duplicate;
  const targetId = Number(targetAccountId) || 0;
  if (!targetId) { const e = new Error('缺少收徒对象'); e.code = 'BAD_REQUEST'; throw e; }
  if (targetId === Number(accountId)) { const e = new Error('不能收自己为徒'); e.code = 'BAD_REQUEST'; throw e; }
  if (apprentice.sameDevice(accountId, targetId)) {
    const e = new Error('不能收同一设备上的账号为徒'); e.code = 'FORBIDDEN'; throw e;
  }
  const meSave = store.peek(accountId);
  if (!meSave) { const e = new Error('还没有存档'); e.code = 'CONFLICT'; throw e; }
  const targetAccount = db.get('SELECT id, name, tag, banned FROM accounts WHERE id = ?', targetId);
  if (!targetAccount || Number(targetAccount.banned)) { const e = new Error('找不到这个玩家'); e.code = 'NOT_FOUND'; throw e; }
  const targetRow = apprentice.rowFor(targetId);
  if (targetRow && targetRow.master_kind === 'account' && Number(targetRow.master_id) === Number(accountId)) {
    const e = new Error('已经是你的徒弟了'); e.code = 'CONFLICT'; throw e;
  }
  const myMaster = apprentice.rowFor(accountId);
  if (myMaster && myMaster.master_kind === 'account' && Number(myMaster.master_id) === targetId) {
    const e = new Error('不能收自己的师父为徒'); e.code = 'CONFLICT'; throw e;
  }
  // 收徒只对好友开放：在扣费与开打之前拦，非好友连尝试都到不了对方的收徒消息。
  if (!apprentice.areFriends(accountId, targetId)) {
    const e = new Error('只能收好友为徒，请先加对方为好友'); e.code = 'FORBIDDEN'; throw e;
  }
  const prentices = apprentice.rowsForMaster(accountId);
  if (prentices.length >= apprentice.capFor(meSave.level)) {
    const e = new Error('收徒名额已满（' + apprentice.capFor(meSave.level) + '）'); e.code = 'CONFLICT'; throw e;
  }
  // 打谁由服务端决定：有师父先打师父（原版 text7841）；没有师父才打本人。
  const foeInfo = apprentice.recruitFoe(targetId);
  const foeFighter = foeInfo.fighter;
  const targetFighter = apprentice.targetStats(targetId) || { name: targetAccount.name, level: 1 };
  const cost = Math.max(0, Number(config.apprenticeRecruitCost) || 0);
  const energy = Math.max(0, Number(config.apprenticeRecruitEnergy) || 0);
  const seed = battle.randomSeed();
  const id = newCombatId();
  let out, response, committed;
  let myName = '';
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      if (Math.max(0, Number(s.goldPoint) || 0) < cost) {
        const e = new Error('收徒挑战需要 ' + cost + ' 金松果'); e.code = 'CONFLICT'; throw e;
      }
      if (!S.consumeEnergy(energy)) {
        const e = new Error('体力不足 ' + energy + ' 点，无法进行收徒挑战'); e.code = 'CONFLICT'; throw e;
      }

      if (cost > 0) S.addGold(-cost, { count: false });
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: false, cheerAccountId: accountId });
      const result = simulate(seed, me, foeFighter);
      const win = result.winner === 0;
      const exp = win ? 20 : 0;
      const ups = exp > 0 ? S.gainExp(exp) : [];
      myName = String(s.name || '');
      const entry = S.recordBattle({
        me, foe: foeFighter, result, region: 0, kind: 'master',
        online: {
          combatId: id, opponentId: targetId, snapshotId: foeInfo.snapshotId || '',
          source: foeInfo.via === 'master' ? 'master' : 'recruit', masterAccountId: foeInfo.masterAccountId || 0,
        },
      });
      return { me, foe: foeFighter, result, win, exp, ups, battleId: entry ? entry.id : null };
    }, { expectRev: rev, snapshotSource: 'recruit' });
    const v = out.value;
    // 关系与两边的存档在同一个事务里落地；失败只投递一条「被打退」的消息。
    committed = apprentice.commitRecruit(accountId, targetId, v.win, myName, id);
    const current = store.getRow(accountId);
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(), me: v.me, foe: v.foe, result: v.result,
      opponent: {
        source: 'player', player: true, bot: false, practice: false, kind: 'recruit',
        accountId: targetId, snapshotId: foeInfo.snapshotId || '', name: String(targetAccount.name),
        tag: String(targetAccount.tag || ''), level: targetFighter.level,
        display: String(targetAccount.name),
        via: foeInfo.via, masterAccountId: foeInfo.masterAccountId || 0,
      },
      settlement: {
        kind: 'recruit', win: v.win, exp: v.exp, ups: v.ups || [],
        recruited: !!(committed && committed.recruited),
        cost, energy, target: { accountId: targetId, name: String(targetAccount.name), level: targetFighter.level },
        via: foeInfo.via, masterAccountId: foeInfo.masterAccountId || 0,
      },
      battleId: v.battleId, rev: Number(current.revision), patch: mergePatch(out.patch, committed && committed.masterPatch),
      // 同时带整份存档：网络重试拿到 duplicate 时客户端也能一次性对齐（不会漏掉扣费/收徒）。
      save: settlement.syncIntegral(accountId, store.decode(current.payload)),
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'recruit', idemKey), kind: 'recruit', attackerId: accountId,
      defenderId: foeInfo.masterAccountId || targetId, snapshotId: foeInfo.snapshotId || '', seed,
      result: v.result, hash: battle.hashResult(v.result), simVersion: simVersion(), winner: v.result.winner,
      settlement: {
        win: v.win, exp: v.exp, cost, energy, recruited: !!(committed && committed.recruited),
        target: targetId, via: foeInfo.via,
      },
      attackerRev: Number(current.revision), packet: response,
    });
  });
  return response;
}

function runWood({ accountId, rev, idemKey }) {
  const duplicate = duplicateCombat(accountId, 'wood', idemKey);
  if (duplicate) return duplicate;
  const seed = battle.randomSeed(), id = newCombatId();
  const foe = { name:'测攻击木头人', level:1, npcType:'wood', power:0, agility:15, speed:0,
    hp:800, maxHp:800, baseStats:{power:0,agility:15,speed:0,hp:800},
    weapons:[], skills:[], gears:[], effects:{}, practice:true, practiceRounds:10 };
  let response;
  db.tx(() => {
    const out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps:false });
      const result = simulate(seed, me, foe);
      const record = S.recordWoodBattle(result);
      const entry = S.recordBattle({ me, foe, result, region:0, kind:'wood', online:{ combatId:id, source:'wood', opponentId:0 } });
      return { me, result, record, battleId: entry ? entry.id : null };
    }, { expectRev: rev });
    const v = out.value;
    response = { ok:true, combatId:id, seed, simVersion:simVersion(), me:v.me, foe, result:v.result,
      settlement:{ kind:'wood', record:v.record }, battleId:v.battleId, rev:out.rev, patch:out.patch };
    recordCombat({ id, idemKey:idemFor(accountId, 'wood', idemKey), kind:'wood', attackerId:accountId, defenderId:0,
      seed, result:v.result, hash:battle.hashResult(v.result), simVersion:simVersion(), winner:v.result.winner,
      settlement:response.settlement, attackerRev:out.rev, packet:response });
  });
  return response;
}

function isKin(accountId, targetId) {
  const a = Number(accountId), b = Number(targetId);
  if (!(a > 0 && b > 0) || a === b) return false;
  return !!db.get(
    `SELECT 1 AS x FROM apprenticeships
      WHERE status = 'active' AND master_kind = 'account'
        AND ((master_id = ? AND prentice_id = ?) OR (master_id = ? AND prentice_id = ?))`,
    a, b, b, a
  );
}

function runFriend({ accountId, snapshotId, rev, idemKey }) {
  const duplicate = duplicateCombat(accountId, 'friend', idemKey);
  if (duplicate) return duplicate;
  if (String(snapshotId).startsWith('ai_')) {
    const row = db.get('SELECT fighter FROM ai_friends WHERE id=? AND account_id=?', String(snapshotId), Number(accountId));
    if (!row) { const e = new Error('这位 AI 好友不存在'); e.code = 'NOT_FOUND'; throw e; }
    const foe = fighterFromSnapshot(JSON.parse(row.fighter)), seed = battle.randomSeed(), id = newCombatId();
    let response;
    db.tx(() => {
      const out = store.runOnSave(accountId, ({ api: S, save: s }) => {
        refreshMasterFor(accountId, s);
        const me = fighterFromState({ useProps: false, cheerAccountId: accountId }), result = simulate(seed, me, foe);
        const entry = S.recordBattle({ me, foe, result, region: 0, kind: 'friend', online: { combatId: id, source: 'bot', opponentId: 0 } });
        return { me, result, battleId: entry ? entry.id : null };
      }, { expectRev: rev });
      response = { ok: true, combatId: id, seed, simVersion: simVersion(), me: out.value.me, foe, result: out.value.result,
        opponent: { source: 'bot', bot: true, player: false, name: foe.name },
        settlement: { kind: 'friend', friendly: true, win: out.value.result.winner === 0, exp: 0, goldCup: 0, integral: null },
        battleId: out.value.battleId, rev: out.rev, patch: out.patch };
      recordCombat({ id, idemKey: idemFor(accountId, 'friend', idemKey), kind: 'friend', attackerId: accountId, defenderId: 0,
        snapshotId, seed, result: out.value.result, hash: battle.hashResult(out.value.result), simVersion: simVersion(),
        winner: out.value.result.winner, settlement: response.settlement, attackerRev: out.rev, packet: response });
    });
    return response;
  }
  let snap;
  if (/^\d+$/.test(String(snapshotId))) {
    // 师徒行有时只有账号 id（`masterView` 的旧档/快照缺失）：按当前快照开打。
    const targetId = Number(snapshotId);
    if (!isKin(accountId, targetId)) {
      const e = new Error('只能和好友或师徒切磋'); e.code = 'FORBIDDEN'; throw e;
    }
    snap = snapshots.currentSnapshot(targetId, 'classic');
    if (!snap || !snap.fighter) { const e = new Error('对方还没有战斗快照，稍后再试'); e.code = 'NOT_FOUND'; throw e; }
  } else {
    snap = loadSnapshotFor(accountId, snapshotId);
    const friend = db.get('SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?', Number(accountId), Number(snap.accountId));
    if (!friend && !isKin(accountId, snap.accountId)) {
      const e = new Error('只能和好友或师徒切磋'); e.code = 'FORBIDDEN'; throw e;
    }
  }
  const foeFighter = fighterFromSnapshot(snap.fighter);
  const seed = battle.randomSeed();
  const id = newCombatId();
  let out, response;
  let myName = '';
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: false, cheerAccountId: accountId });
      const result = simulate(seed, me, foeFighter);
      myName = String(s.name || '');
      const entry = S.recordBattle({ me, foe: foeFighter, result, region: 0, kind: 'friend', online: { combatId: id, opponentId: snap.accountId } });
      return { me, foe: foeFighter, result, battleId: entry ? entry.id : null };
    }, { expectRev: rev });
    const v = out.value;
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(),
      me: v.me, foe: v.foe, result: v.result,
      settlement: { kind: 'friend', friendly: true, win: v.result.winner === 0, exp: 0, goldCup: 0, integral: null },
      battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'friend', idemKey), kind: 'friend', attackerId: accountId, defenderId: snap.accountId, snapshotId: snap.id,
      seed, result: v.result, hash: battle.hashResult(v.result),
      simVersion: simVersion(), winner: v.result.winner, settlement: { friendly: true },
      attackerRev: out.rev, packet: response,
    });
    // 好友切磋也是被动事件：防守方收到消息，带快照等级与胜负，可回看防守视角录像。
    const friendDefWin = v.result.winner !== 0;
    message(snap.accountId, 'friend_spar',
      '【' + (myName || '好友') + '】找你切磋了一场（你 Lv.' + Math.max(1, Number(snap.level) || 1) + ' 的防守快照），你'
        + (friendDefWin ? '获胜了' : '落败了') + '。',
      {
        combatId: id, fromId: accountId, fromName: myName,
        payload: {
          level: Math.max(1, Number(snap.level) || 1),
          defenderWin: friendDefWin,
          win: friendDefWin,
        },
      });
  });
  return response;
}

function runStage({ accountId, stageId, rev, idemKey }) {
  const duplicate = duplicateCombat(accountId, 'stage', idemKey);
  if (duplicate) return duplicate;
  const seed = battle.randomSeed();
  const id = newCombatId();
  // 徒弟镜像只用于选谁先上阵；它的三维必须按徒弟当前存档刷新，不能停在收徒那一刻。
  // 在进入 runOnSave 前算好，回调里只赋值（嵌套 withState 会串档）。
  let livePrentices = null;
  try { livePrentices = apprentice.livePrenticeStats(accountId); } catch (_) { livePrentices = null; }
  let out, response;
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      apprentice.applyPrenticeStatsInto(s, livePrentices);
      const G = globalThis.GData;
      const started = S.beginStageBattle(stageId);
      if (!started.ok) {
        const e = new Error(started.msg || '现在不能挑战这一关');
        e.code = 'CONFLICT';
        e.extra = { needsBook: !!started.needsBook };
        throw e;
      }
      const npc = S.npcOf(stageId, started.npcIndex);
      if (!npc) {
        S.interruptStageBattle(stageId, started.token);
        const e = new Error('这一关没有这个对手');
        e.code = 'CONFLICT';
        throw e;
      }
      const type = G.stageTypeOf(stageId);
      const prenticeFighter = started.role === 'prentice' ? S.stagePrenticeFighter() : null;
      const prenticeRole = !!(started.role === 'prentice' && prenticeFighter);
      const prevRun = S.stageRun(stageId);
      const carryHp = prevRun && Number.isFinite(prevRun.carryHp)
        ? Math.min(1, prevRun.carryHp + 0.25) : undefined;
      const dailyCount = S.challengeDailyCount ? S.challengeDailyCount(stageId) : 0;
      const foe = G.stageFoe(npc, stageId, type.anim, dailyCount);
      // 徒弟战败后师父接手同一名对手：按徒弟打完时对手的剩余血量入场。
      if (started.role === 'master' && prevRun && Number.isFinite(prevRun.foeCarryHp)) {
        const fullHp = Math.max(1, Math.round(Number(foe.maxHp || foe.hp) || 1));
        foe.maxHp = fullHp;
        foe.hp = Math.max(1, Math.round(fullHp * prevRun.foeCarryHp));
      }
      let me;
      const ratio = carryHp == null ? 1 : Math.min(1, Math.max(0.01, carryHp));
      if (prenticeRole) {
        me = prenticeFighter;
        me.maxHp = Math.max(1, Math.round(Number(me.maxHp || me.hp) || 1));
        me.hp = Math.max(1, Math.round(Math.min(me.maxHp, Number(me.hp) || me.maxHp) * ratio));
      } else {
        refreshMasterFor(accountId, s);
        me = fighterFromState({ useProps: false, cheerAccountId: accountId });
        me.hp = Math.max(1, Math.round(me.maxHp * ratio));
      }
      const result = simulate(seed, me, foe);
      const win = result.winner === 0;
      const lastRound = result.rounds.length ? result.rounds[result.rounds.length - 1] : null;
      const hp = lastRound && Array.isArray(lastRound.hpAfter) ? lastRound.hpAfter[0] : me.hp;
      const cap = Array.isArray(result.maxHp) ? result.maxHp[0] : me.maxHp;
      const hpRatio = win && Number.isFinite(hp) && cap > 0 ? Math.max(0, Math.min(1, hp / cap)) : 0;
      let settle;
      let prenticeLost = false;
      if (prenticeRole && !win) {

        const foeHp = lastRound && Array.isArray(lastRound.hpAfter) ? lastRound.hpAfter[1] : null;
        const foeCap = Array.isArray(result.maxHp) ? result.maxHp[1] : 0;
        const foeRatio = Number.isFinite(foeHp) && foeCap > 0 ? Math.max(0, Math.min(1, foeHp / foeCap)) : null;
        S.stagePrenticeLost(stageId, started.token, foeRatio);
        prenticeLost = true;
        settle = { ok: true, win: false, prenticeLost: true, run: S.stageRun(stageId) };
      } else {
        settle = S.finishStageBattle(stageId, started.token, win, hpRatio);
      }
      const entry = S.recordBattle({
        me, foe, result, region: type.anim === 'tl' ? 3 : type.anim === 'xh' ? 4 : 1, kind: 'stage',
        online: { combatId: id, stageId, npcIndex: started.npcIndex },
      });
      return {
        me, foe, result, win, settle, prenticeLost,
        npc: { name: npc.name, idx: started.npcIndex, isBoss: npc.isBoss === 'true' },
        role: started.role, battleId: entry ? entry.id : null,
      };
    }, { expectRev: rev, snapshotSource: 'stage' });
    const v = out.value;
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(),
      me: v.me, foe: v.foe, result: v.result,
      stage: { stageId: Number(stageId), npc: v.npc, role: v.role,
        win: v.win, prenticeLost: v.prenticeLost, settle: v.settle },
      settlement: { kind: 'stage', ...summarizeStageSettle(v.settle) },
      battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'stage', idemKey), kind: 'stage', attackerId: accountId, defenderId: 0, seed,
      result: v.result, hash: battle.hashResult(v.result), simVersion: simVersion(),
      winner: v.result.winner,
      settlement: { stageId: Number(stageId), ...summarizeStageSettle(v.settle) },
      attackerRev: out.rev, packet: response,
    });
  });
  return response;
}

function summarizeStageSettle(settle) {
  if (!settle) return {};
  return {
    win: !!settle.win, complete: !!settle.complete,
    exp: Number(settle.exp) || 0, gold: Number(settle.gold) || 0,
    goldBase: Number(settle.goldBase) || 0, goldBuff: !!settle.goldBuff,
    drop: settle.drop || null, gem: settle.gem || null,
    ups: settle.ups || [], run: settle.run || null,
  };
}

const ARENA_FALLBACK = { exp: [150, 100, 50, 30], shards: [8, 6, 4, 3], hatch: [40, 35, 30, 25], entryCost: 30 };

function arenaTables() {
  const G = globalThis.GData || {};
  return {
    exp: Array.isArray(G.ARENA_EXP) ? G.ARENA_EXP : ARENA_FALLBACK.exp,
    shards: Array.isArray(G.ARENA_FRAGMENT_SHARDS) ? G.ARENA_FRAGMENT_SHARDS : ARENA_FALLBACK.shards,
    hatch: Array.isArray(G.ARENA_HATCH) ? G.ARENA_HATCH : ARENA_FALLBACK.hatch,
    entryCost: Number(G.ARENA_ENTRY_COST) || ARENA_FALLBACK.entryCost,
  };
}

function payArenaEntry(S, s, kind, need) {
  const admission = kind === 0 ? 36 : kind === 1 ? 39 : 82;
  const takeItem = (id) => {
    if (!(Number(s.props[id]) > 0)) return false;
    s.props[id] = Number(s.props[id]) - 1;
    if (s.props[id] <= 0) delete s.props[id];
    S.save();
    return true;
  };
  if (s.energy >= need) {
    if (!S.consumeEnergy(need)) return { ok: false, reason: 'energy' };
    return { ok: true, by: 'energy' };
  }
  if (takeItem(admission)) return { ok: true, by: 'item', itemId: admission };
  return { ok: false, reason: 'none' };
}

function arenaJoin({ accountId, kind, rev }) {
  const k = Math.max(0, Math.min(2, Number(kind) || 0));
  const tables = arenaTables();
  const seed = battle.randomSeed();
  let out;
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      const need = k === 0 ? 10 : 15;
      if (s.level < need) { const e = new Error('等级不足：' + need + ' 级才能参加'); e.code = 'CONFLICT'; throw e; }
      if (s.classicArenaRun) { const e = new Error('已经报过名了，先把这一轮打完'); e.code = 'CONFLICT'; throw e; }
      const pay = payArenaEntry(S, s, k, tables.entryCost);
      if (!pay.ok) { const e = new Error('体力不足 30，也没有可用的入场券'); e.code = 'CONFLICT'; throw e; }
      const foes = battle.withSeed(seed, () => [
        S.genAI(s.level, '', { statScale: S.RANDOM_FOE_SCALE || 1.08 }),
        S.genAI(s.level, '', { statScale: S.RANDOM_FOE_SCALE || 1.08 }),
        S.genAI(s.level, '', { statScale: S.RANDOM_FOE_SCALE || 1.08 }),
      ]);
      const otherSeed = seed ^ 0x5f3759df;
      const other = battle.withSeed(otherSeed, () => globalThis.Sim.simulate(foes[1], foes[2]));
      s.classicArenaRun = {
        kind: k, phase: 'semi', foe: foes[0],
        finalist: foes[other.winner === 0 ? 1 : 2],
        consolation: foes[other.winner === 0 ? 2 : 1],
        busy: false, settled: false, matching: true,
      };
      return { run: s.classicArenaRun, pay };
    }, { expectRev: rev, snapshotSource: 'arena-join' });
  });
  return { ok: true, run: out.value.run, paid: out.value.pay, tables, rev: out.rev, patch: out.patch };
}

function normalizeFoe(foe) {
  const f = JSON.parse(JSON.stringify(foe));
  f.maxHp = Math.max(1, Math.round(Number(f.maxHp) || Number(f.hp) || 1));
  f.hp = Math.max(1, Math.min(f.maxHp, Math.round(Number(f.hp) || f.maxHp)));
  if (!Array.isArray(f.pets)) f.pets = [];
  if (!Array.isArray(f.weapons)) f.weapons = [];
  if (!Array.isArray(f.skills)) f.skills = [];
  if (!f.effects || typeof f.effects !== 'object') f.effects = {};
  return f;
}

function arenaFight({ accountId, rev, idemKey }) {
  const duplicate = duplicateCombat(accountId, 'arena', idemKey);
  if (duplicate) return duplicate;
  const seed = battle.randomSeed();
  const id = newCombatId();
  const tables = arenaTables();
  let out, response;
  db.tx(() => {
    out = store.runOnSave(accountId, ({ api: S, save: s }) => {
      const run = s.classicArenaRun;
      if (!run || !run.foe || !run.finalist || !run.consolation) {
        const e = new Error('没有正在进行的竞技赛'); e.code = 'CONFLICT'; throw e;
      }
      const phase = run.phase;
      const foeRaw = phase === 'final' ? run.finalist : phase === 'third' ? run.consolation : run.foe;

      refreshMasterFor(accountId, s);
      const me = fighterFromState({ useProps: false, cheerAccountId: accountId });
      const foeF = normalizeFoe(foeRaw);
      const result = simulate(seed, me, foeF);      const win = result.winner === 0;
      let rewards;
      if (phase === 'semi') {
        run.phase = win ? 'final' : 'third';
        run.matching = false;

        rewards = { phase: 'semi', next: run.phase, win, gem: null };
      } else {
        const position = phase === 'final' ? (win ? 0 : 1) : (win ? 2 : 3);
        const kind = Number(run.kind) || 0;
        // 任一竞技场（经验 / 碎片 / 幻兽）的冠军都固定多给 1 个金杯，并计入席位「今日金杯」。
        const championCup = position === 0 ? 1 : 0;
        if (championCup) S.awardArenaCup(championCup);
        let baseExp = kind === 0 ? tables.exp[position] : 0;
        let shards = kind === 1 ? tables.shards[position] : 0;
        const hatch = kind === 2 ? tables.hatch[position] : 0;
        let buffNote = '';
        if (baseExp && S.activeBuildingBuff && S.activeBuildingBuff('arenaExp')) {
          const rate = S.buildingDoubleRate('altar', 'arenaExp');
          if (rate > 0 && Math.random() * 100 < rate) { baseExp *= 2; buffNote = '祭坛发出神秘的光芒，恭喜你获得了双倍经验奖励！'; }
        }
        if (shards && S.activeBuildingBuff && S.activeBuildingBuff('arenaProp')) {
          const rate = S.buildingDoubleRate('altar', 'arenaProp');
          if (rate > 0 && Math.random() * 100 < rate) { shards *= 2; buffNote = '祭坛发出神秘的光芒，恭喜你获得了双倍碎片奖励！'; }
        }
        const boostPct = baseExp ? S.expBoostPct() : 0;
        const boosted = baseExp ? S.gainExpWithBoost(baseExp) : { exp: 0, ups: [] };
        if (shards) s.props[26] = (Number(s.props[26]) || 0) + shards;
        if (hatch) s.hatchPoint = Math.max(0, (Number(s.hatchPoint) || 0) + hatch);

        // 45 级起：打完一轮（决赛/季军赛结算）额外 3% 掉 1~2 级宝石；半决赛不掷。
        // 客户端 `js/online-battle.js` 会读 `rewards.gem` 显示「获得 X 宝石 ×1」。
        const gem = S.rollGemDrop(3);
        if (baseExp) S.tickPropStates({ kind: 'exp' });
        s.classicArenaRun = null;
        rewards = {
          phase: 'final', position, win, exp: boosted.exp, ups: boosted.ups, shards, hatch, gem,
          goldCup: championCup,
          boostPct, buffNote, title: ['冠军', '亚军', '季军', '第四名'][position],
        };
      }
      const entry = S.recordBattle({ me, foe: foeF, result, region: 0, kind: 'arena', online: { combatId: id } });
      return { me, foe: foeF, result, win, rewards, battleId: entry ? entry.id : null, kind: Number(run.kind) || 0 };
    }, { expectRev: rev, snapshotSource: 'arena' });
    const v = out.value;
    response = {
      ok: true, combatId: id, seed, simVersion: simVersion(),
      me: v.me, foe: v.foe, result: v.result,
      arena: { win: v.win, rewards: v.rewards, kind: v.kind },
      settlement: Object.assign({ kind: 'arena' }, v.rewards || {}),
      battleId: v.battleId, rev: out.rev, patch: out.patch,
    };
    recordCombat({
      id, idemKey: idemFor(accountId, 'arena', idemKey), kind: 'arena', attackerId: accountId, defenderId: 0, seed,
      result: v.result, hash: battle.hashResult(v.result), simVersion: simVersion(),
      winner: v.result.winner, settlement: v.rewards || {}, attackerRev: out.rev, packet: response,
    });
  });
  return response;
}

function loadCombat(combatId, accountId, as) {
  const row = db.get('SELECT * FROM combats WHERE id = ?', String(combatId));
  if (!row) { const e = new Error('录像不存在'); e.code = 'NOT_FOUND'; throw e; }
  const saved = JSON.parse(row.settlement || '{}');
  const meta = cachedMeta(saved) || {};
  const isAttacker = Number(row.attacker_id) === Number(accountId);
  const isDefender = Number(row.defender_id) === Number(accountId);
  // 征战是四人接力：同房间成员要看得到其它座位（包括助战/人机）的战报。
  // 只放行同一 roomCode 的成员，不能凭 combatId 看陌生人的战斗。
  let spectator = false;
  if (!isAttacker && !isDefender) {
    const roomCode = String((meta.settlement && meta.settlement.roomCode) || '');
    if (row.kind === 'campaign' && roomCode) {
      spectator = !!db.get(
        'SELECT 1 AS x FROM campaign_members m JOIN campaign_rooms r ON r.id = m.room_id WHERE r.code = ? AND m.account_id = ?',
        roomCode, Number(accountId)
      );
    }
    if (!spectator) { const e = new Error('这不是你的战斗'); e.code = 'FORBIDDEN'; throw e; }
  }
  const repro = row.repro ? store.decode(row.repro) : null;
  const result = repro ? reproduceCombat(row, repro) : store.decode(row.result);
  const wantDefender = as === 'defender' ? true : as === 'attacker' ? false : (spectator ? false : isDefender);
  const view = wantDefender ? battle.swapResult(result) : result;
  const me = repro ? (wantDefender ? repro.foe : repro.me) : (wantDefender ? meta.foe : meta.me);
  const foe = repro ? (wantDefender ? repro.me : repro.foe) : (wantDefender ? meta.me : meta.foe);
  const attacker = repro ? repro.me : meta.me;
  return {
    ok: true,
    combatId: String(row.id),
    kind: String(row.kind),
    seed: Number(row.seed),
    simVersion: String(row.sim_version),
    winner: Number(view.winner),
    result: view,
    settlement: meta.settlement || cachedTopSettlement(saved),
    me: me || undefined,
    foe: foe || undefined,
    opponent: meta.opponent ? (wantDefender ? {
      source: 'player', player: true, bot: false, accountId: Number(row.attacker_id),
      name: (attacker && attacker.name) || '', level: (attacker && attacker.level) || 1,
    } : meta.opponent) : undefined,
    attackerId: Number(row.attacker_id),
    defenderId: Number(row.defender_id),
    snapshotId: String(row.snapshot_id || ''),
    createdAt: Number(row.created_at),
    view: wantDefender ? 'defender' : 'attacker',
  };
}

module.exports = {
  runRandom, runRank, runFriend, runWood, runStage, runRecruit,
  arenaJoin, arenaFight, arenaTables,
  loadCombat, recordCombat, message, newCombatId, revengeInfoFor,
};
