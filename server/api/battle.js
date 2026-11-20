'use strict';

const db = require('../db');
const store = require('../game/store');
const fight = require('../game/fight');
const snapshots = require('../game/snapshot');
const opponents = require('../game/opponents');
const chests = require('../game/chests');
const settlement = require('../game/settlement');
const apprentice = require('../game/apprentice');
const vip = require('../game/vip');
const { fail, clientIp, rateLimit, pace } = require('../http');
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

  pendingChests(ctx) { return chests.pending(ctx.account.id); },

  claimChest(ctx) {
    rateLimit('chest:' + ctx.account.id, 60, 60 * 1000);
    return chests.claim(ctx.account.id, ctx.body.combatId, ctx.body.index);
  },


  battle(ctx) {
    const accountId = ctx.account.id;
    rateLimit('fight:' + accountId, config.fightRatePerMin, 60 * 1000);
    const kind = String(ctx.body.kind || '');
    if (!KINDS.has(kind)) throw fail('BAD_REQUEST', '未知的战斗类型：' + kind);
    if (!Number.isSafeInteger(ctx.body.rev) || ctx.body.rev < 1) throw fail('BAD_REQUEST', '战斗需要有效的存档版本，请先同步');
    const rev = ctx.body.rev;
    const idemKey = String(ctx.headers['idempotency-key'] || ctx.body.idemKey || '').slice(0, 120);
    // 同一账号连点开战：正常播放一场战斗远超过这个间隔；同一 idemKey 的重试放行。
    // token 带上 kind：同一个人拿旧 idemKey 换个战斗类型不能绕过冷却；没有 idemKey 就不算重试。
    const markFight = pace('fight:' + accountId, config.fightIntervalMs, idemKey ? kind + ':' + idemKey : '');
    let out;
    if (kind === 'random') out = fight.runRandom({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey, revengeOf: String(ctx.body.revengeOf || '') });
    else if (kind === 'rank') out = fight.runRank({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey, revengeOf: String(ctx.body.revengeOf || '') });
    else if (kind === 'friend') out = fight.runFriend({ accountId, snapshotId: String(ctx.body.snapshotId || ''), rev, idemKey });
    else if (kind === 'wood') out = fight.runWood({ accountId, rev, idemKey });
    else if (kind === 'stage') out = fight.runStage({ accountId, stageId: Number(ctx.body.stageId) || 0, rev, idemKey });
    else if (kind === 'arena') out = fight.arenaFight({ accountId, rev, idemKey });
    else throw fail('BAD_REQUEST', '战斗类型未实现');
    markFight();
    return out;
  },


  arenaJoin(ctx) {
    const accountId = ctx.account.id;
    rateLimit('arena:' + accountId, 30, 60 * 1000);
    if (!Number.isSafeInteger(ctx.body.rev) || ctx.body.rev < 1) throw fail('BAD_REQUEST', '报名需要有效的存档版本，请先同步');
    return fight.arenaJoin({ accountId, kind: Number(ctx.body.kind) || 0, rev: ctx.body.rev });
  },


  arenaState(ctx) {
    const save = store.peek(ctx.account.id);
    const run = save && save.classicArenaRun ? save.classicArenaRun : null;
    return { ok: true, run, tables: fight.arenaTables() };
  },

  // 服务端候选：玩家快照优先，AI 补位；不以活跃时间冒称同时在线。
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

      db.tx(() => {
        db.run('INSERT OR IGNORE INTO random_refresh_state(account_id,refresh_no) VALUES (?,0)', accountId);
        db.run('UPDATE random_refresh_state SET refresh_no=refresh_no+1 WHERE account_id=?', accountId);
        randomSeq = Number(db.get('SELECT refresh_no FROM random_refresh_state WHERE account_id=?', accountId).refresh_no);
        db.run('DELETE FROM random_refresh_exclusions WHERE account_id=? AND through_refresh<?', accountId, randomSeq);
        recentIds = db.all('SELECT opponent_id FROM random_refresh_exclusions WHERE account_id=? AND through_refresh>=?', accountId, randomSeq)
          .map((x) => Number(x.opponent_id));
      });
    } else {

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
    // 天梯匹配页要显示双方名次：人机只给积分，真人给赛区名次（一次算齐，避免逐人扫全表）。
    let myRank = 0;
    if (kind === 'rank') {
      const real = picked.filter((row) => row && row.player && Number(row.accountId) > 0);
      const info = settlement.rankPositions(accountId, real.map((row) => row.accountId));
      myRank = info.rank;
      for (const row of real) row.rank = info.ranks.get(Number(row.accountId)) || 0;
    }
    const realCount = picked.filter((row) => row && row.player).length;
    const botCount = picked.length - realCount;
    const threshold = config.rankRealMatchScoreLimit;

    const weighted = kind === 'rank' && myScore >= threshold;
    return {
      ok: true, kind, week, season: week, myScore, myRank, opponents: picked,
      daily: settlement.rankDailyStatus(accountId),
      refreshCooldownMs: config.opponentRefreshCooldownMs,
      match: {
        threshold, myScore, weighted, realCount, botCount,
        botWeight: weighted ? opponents.ratingWeight(myScore, 0) : 1,
        ratingSpread: config.opponentRatingSpread,
        ratingWeightFloor: config.opponentRatingWeightFloor,
        recentExclude: config.rankRealRecentMatches,
      },
    };
  },


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
      return { ok: true, fighter: f, level: snap.level, vipLevel: vip.levelOf(snap.accountId), snapshotId: snap.id, source: 'player', player: true, bot: false, accountId: snap.accountId };
    }
    const accountId = Number(ctx.query.accountId || 0);
    if (!accountId) throw fail('BAD_REQUEST', '缺少 accountId 或 snapshotId');
    const snap = snapshots.currentSnapshot(accountId, 'classic');
    const live = apprentice.liveFighterOfAccount(accountId);
    if (!live) throw fail('NOT_FOUND', '对方还没有战斗快照');
    return {
      ok: true,
      snapshotId: snap ? snap.id : '', level: live.level,
      vipLevel: vip.levelOf(accountId),
      source: 'player', player: true, bot: false, accountId,
      fighter: live,
    };
  },


  combat(ctx) {
    return fight.loadCombat(ctx.params.id, ctx.account.id, String(ctx.query.as || ''));
  },


  replay(ctx) {
    const accountId = Number(ctx.account.id);
    // loadCombat 自己会取录像并核对攻击/防守/同房间旁观权限；这里不再先查一遍。
    const data = fight.loadCombat(ctx.params.id, accountId, String(ctx.query.as || ''));
    const snap = data.snapshotId ? snapshots.snapshotById(data.snapshotId) : null;
    const mySide = data.attackerId === accountId ? 0 : 1;
    const asDefender = data.view === 'defender';
    return {
      ok: true,
      combatId: data.combatId,
      kind: data.kind,
      result: data.result,
      me: data.me || (snap ? (asDefender ? require('../game/fighter').fighterFromSnapshot(snap.fighter) : null) : null),
      foe: data.foe || null,
      opponent: data.opponent,
      foeSnapshotId: data.snapshotId,
      mySide, asDefender,
      settlement: data.settlement,
    };
  },
};
