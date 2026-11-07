'use strict';
/* ============================================================
 * server/api/battle.js — 战斗 / 对手 / 回放 / 竞技场
 * ============================================================ */

const db = require('../db');
const store = require('../game/store');
const fight = require('../game/fight');
const snapshots = require('../game/snapshot');
const opponents = require('../game/opponents');
const chests = require('../game/chests');
const settlement = require('../game/settlement');
const { fail, clientIp, rateLimit } = require('../http');
const { config } = require('../config');

const KINDS = new Set(['random', 'stage', 'rank', 'friend', 'arena', 'wood']);

module.exports = {
  claimPickup(ctx) {
    const id = String(ctx.body.combatId || ''), index = ctx.body.index;
    if (!/^c_[A-Za-z0-9_-]{10,80}$/.test(id) || !Number.isInteger(index) || index < 0 || index > 2)
      throw fail('BAD_REQUEST', '无效的战斗奖励');
    return db.tx(() => {
      const combat = db.get('SELECT seed, kind, settlement FROM combats WHERE id=? AND attacker_id=?', id, Number(ctx.account.id));
      if (!combat || !['random', 'rank', 'stage', 'arena'].includes(combat.kind) || JSON.parse(combat.settlement || '{}').practice)
        throw fail('NOT_FOUND', '这场战斗没有可领取的悬浮奖励');
      const battle = require('../game/battle');
      const prize = globalThis.BattleDrops.plan(battle.mulberry32(Number(combat.seed) ^ 0x751278ab), combat.kind === 'rank' ? 'rank' : 'challenge')[index];
      const exists = db.get('SELECT ups FROM combat_pickups WHERE combat_id=? AND pickup_index=?', id, index);
      let out = null;
      if (!exists) {
        out = store.runOnSave(ctx.account.id, ({ api, save }) => {
          let ups = [];
          if (prize.id === 15) ups = api.gainExp(prize.count);
          else if (prize.id === 8) api.addGold(prize.count);
          else save.props[prize.id] = (Number(save.props[prize.id]) || 0) + prize.count;
          if (api.bumpDaily) api.bumpDaily('pickup', 1, true);
          return { ups };
        }, { snapshotSource: 'battle-pickup' });
        db.run('INSERT INTO combat_pickups(combat_id,account_id,pickup_index,claimed_at,ups) VALUES (?,?,?,?,?)', id, Number(ctx.account.id), index, Date.now(), store.encode(out.value.ups));
      }
      const current = out ? null : store.getRow(ctx.account.id);
      return { ok:true, duplicate:!!exists, prize, ups:out ? out.value.ups : (exists.ups ? store.decode(exists.ups) : []), rev:out ? out.rev : Number(current.revision), patch:out ? out.patch : null, save:exists ? settlement.syncIntegral(ctx.account.id, store.decode(current.payload)) : undefined };
    });
  },
  /** 只列未领取票据，不公开四格奖池；重连后可继续选择。 */
  pendingChests(ctx) { return chests.pending(ctx.account.id); },

  claimChest(ctx) {
    rateLimit('chest:' + ctx.account.id, 60, 60 * 1000);
    return chests.claim(ctx.account.id, ctx.body.combatId, ctx.body.index);
  },

  /** 一次战斗请求。 */
  battle(ctx) {
    const accountId = ctx.account.id;
    rateLimit('fight:' + accountId, config.fightRatePerMin, 60 * 1000);
    const kind = String(ctx.body.kind || '');
    if (!KINDS.has(kind)) throw fail('BAD_REQUEST', '未知的战斗类型：' + kind);
    if (!Number.isSafeInteger(ctx.body.rev) || ctx.body.rev < 1) throw fail('BAD_REQUEST', '战斗需要有效的存档版本，请先同步');
    const rev = ctx.body.rev;
    const idemKey = String(ctx.headers['idempotency-key'] || ctx.body.idemKey || '').slice(0, 120);
    if (kind === 'random') return fight.runRandom({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey, revengeOf: String(ctx.body.revengeOf || '') });
    if (kind === 'rank') return fight.runRank({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey, revengeOf: String(ctx.body.revengeOf || '') });
    if (kind === 'friend') return fight.runFriend({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey });
    if (kind === 'wood') return fight.runWood({ accountId, rev, idemKey });
    if (kind === 'stage') return fight.runStage({ accountId, stageId: Number(ctx.body.stageId) || 0, rev, idemKey });
    if (kind === 'arena') return fight.arenaFight({ accountId, rev, idemKey });
    throw fail('BAD_REQUEST', '战斗类型未实现');
  },

  /** 竞技场报名。 */
  arenaJoin(ctx) {
    const accountId = ctx.account.id;
    rateLimit('arena:' + accountId, 30, 60 * 1000);
    if (!Number.isSafeInteger(ctx.body.rev) || ctx.body.rev < 1) throw fail('BAD_REQUEST', '报名需要有效的存档版本，请先同步');
    return fight.arenaJoin({ accountId, kind: Number(ctx.body.kind) || 0, rev: ctx.body.rev });
  },

  /** 竞技场当前这一轮（断线重进时用来恢复页面）。 */
  arenaState(ctx) {
    const save = store.peek(ctx.account.id);
    const run = save && save.classicArenaRun ? save.classicArenaRun : null;
    return { ok: true, run, tables: fight.arenaTables() };
  },

  /** 服务端候选：玩家快照优先，AI 补位；不以活跃时间冒称同时在线。 */
  opponents(ctx) {
    const accountId = ctx.account.id;
    const q = ctx.query;
    const kind = String(q.kind || 'rank');
    if (kind !== 'random' && kind !== 'rank') throw fail('BAD_REQUEST', '未知的对手用途');
    rateLimit('opponents:' + accountId, 60, 60 * 1000);
    const week = settlement.weekKey();
    const myScore = settlement.ratingOf(accountId, week);
    const save = store.peek(accountId);
    if (!save) throw fail('CONFLICT', '还没有存档');
    let recentIds = [];
    let randomSeq = 0;
    if (kind === 'random') {
      /* 随机挑战仍用「刷新序号 + 屏蔽到第 N 次」的冷却（与天梯无关）。 */
      db.tx(() => {
        db.run('INSERT OR IGNORE INTO random_refresh_state(account_id,refresh_no) VALUES (?,0)', accountId);
        db.run('UPDATE random_refresh_state SET refresh_no=refresh_no+1 WHERE account_id=?', accountId);
        randomSeq = Number(db.get('SELECT refresh_no FROM random_refresh_state WHERE account_id=?', accountId).refresh_no);
        db.run('DELETE FROM random_refresh_exclusions WHERE account_id=? AND through_refresh<?', accountId, randomSeq);
        recentIds = db.all('SELECT opponent_id FROM random_refresh_exclusions WHERE account_id=? AND through_refresh>=?', accountId, randomSeq)
          .map((x) => Number(x.opponent_id));
      });
    } else {
      /* 天梯：同一个真人至少隔 `rankRealRecentMatches` 场才会再遇到（用户 2026-11 口径）。 */
      recentIds = settlement.recentRealOpponents(accountId, config.rankRealRecentMatches);
    }
    const picked = opponents.candidates(accountId, save, { kind, week, myScore, recentIds });
    if (kind === 'random') {
      db.tx(() => {
        for (const row of picked) {
          if (!row.player || !row.accountId) continue;
          db.run(`INSERT INTO random_refresh_exclusions(account_id,opponent_id,through_refresh) VALUES (?,?,?)
            ON CONFLICT(account_id,opponent_id) DO UPDATE SET through_refresh=excluded.through_refresh`,
            accountId, row.accountId, randomSeq + config.randomRealRecentRefreshes);
        }
      });
    }
    const realCount = picked.filter((row) => row && row.player).length;
    const botCount = picked.length - realCount;
    const threshold = config.rankRealMatchScoreLimit;
    /* 赛区制：真人先补满候选位；300 分以后人机候选位的权重降到 1/3
     * （`opponents.botSlotsFor`），真人因此更容易被匹配到。人机不会再「整段消失」，
     * 也不会再有「回落人机不结算积分」的场次。 */
    const weighted = kind === 'rank' && myScore >= threshold;
    const divisor = Math.max(1, Number(config.rankBotWeightDivisor) || 3);
    return {
      ok: true, kind, week, season: week, myScore, opponents: picked,
      daily: settlement.rankDailyStatus(accountId),
      refreshCooldownMs: config.opponentRefreshCooldownMs,
      match: {
        threshold, myScore, weighted, realCount, botCount,
        botWeight: weighted ? 1 / divisor : 1,
        recentExclude: config.rankRealRecentMatches,
      },
    };
  },

  /** 单个玩家的公开面板（好友页/查看对手）。 */
  fighter(ctx) {
    const target = String(ctx.query.snapshotId || '');
    if (target) {
      if (opponents.isOffer(target)) {
        const offer = opponents.resolve(target, ctx.account.id);
        return { ok: true, fighter: offer.fighter, level: offer.fighter.level, ...offer.public };
      }
      const snap = snapshots.snapshotById(target);
      if (!snap) throw fail('NOT_FOUND', '这个快照不存在');
      const f = require('../game/fighter').fighterFromSnapshot(snap.fighter);
      return { ok: true, fighter: f, level: snap.level, snapshotId: snap.id, source: 'player', player: true, bot: false, accountId: snap.accountId };
    }
    const accountId = Number(ctx.query.accountId || 0);
    if (!accountId) throw fail('BAD_REQUEST', '缺少 accountId 或 snapshotId');
    const snap = snapshots.currentSnapshot(accountId, 'classic');
    if (!snap) throw fail('NOT_FOUND', '对方还没有战斗快照');
    return {
      ok: true,
      snapshotId: snap.id, level: snap.level,
      source: 'player', player: true, bot: false, accountId: snap.accountId,
      fighter: require('../game/fighter').fighterFromSnapshot(snap.fighter),
    };
  },

  /** 录像（按 combatId）。 */
  combat(ctx) {
    return fight.loadCombat(ctx.params.id, ctx.account.id, String(ctx.query.as || ''));
  },

  /** 战斗消息里「查看录像」用：返回这一场双方的战斗体 + 结果。 */
  replay(ctx) {
    const row = db.get('SELECT * FROM combats WHERE id = ?', String(ctx.params.id));
    if (!row) throw fail('NOT_FOUND', '录像不存在');
    const accountId = Number(ctx.account.id);
    if (Number(row.attacker_id) !== accountId && Number(row.defender_id) !== accountId) {
      throw fail('FORBIDDEN', '这不是你的战斗');
    }
    const snap = row.snapshot_id ? snapshots.snapshotById(String(row.snapshot_id)) : null;
    const data = fight.loadCombat(ctx.params.id, accountId, String(ctx.query.as || ''));
    const mySide = Number(row.attacker_id) === accountId ? 0 : 1;
    const asDefender = data.view === 'defender';
    return {
      ok: true,
      combatId: data.combatId,
      kind: data.kind,
      result: data.result,
      me: data.me || (snap ? (asDefender ? require('../game/fighter').fighterFromSnapshot(snap.fighter) : null) : null),
      foe: data.foe || null,
      opponent: data.opponent,
      foeSnapshotId: String(row.snapshot_id || ''),
      mySide, asDefender,
      settlement: data.settlement,
    };
  },
};
