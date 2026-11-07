'use strict';
/* ============================================================
 * server/api/apprentice.js — 联机师徒路由
 * ------------------------------------------------------------
 *   GET  /api/apprentices            师徒页数据（兼容旧路径）
 *   GET  /api/apprentice             同上
 *   GET  /api/apprentice/candidates  人机师父候选 + 可收真人徒弟
 *   POST /api/apprentice/master      拜人机师父
 *   POST /api/apprentice/recruit     收真人徒弟（异步战斗）
 *   POST /api/apprentice/kick        逐出师门（每天 1 次）
 *   POST /api/apprentice/leave       出师（20 金松果）
 *   POST /api/apprentice/tribute     领取真人徒弟昨日日供
 * ============================================================ */

const apprentice = require('../game/apprentice');
const fight = require('../game/fight');
const { fail, rateLimit } = require('../http');

function needRev(ctx) {
  const rev = ctx.body && ctx.body.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw fail('BAD_REQUEST', '操作需要有效的存档版本，请先同步');
  return rev;
}

module.exports = {
  list(ctx) {
    return apprentice.list(ctx.account.id);
  },

  candidates(ctx) {
    rateLimit('apprentice-candidates:' + ctx.account.id, 60, 60 * 1000);
    return apprentice.candidates(ctx.account.id);
  },

  master(ctx) {
    rateLimit('apprentice-master:' + ctx.account.id, 20, 60 * 1000);
    return apprentice.setBotMaster(ctx.account.id, Number(ctx.body && ctx.body.index) || 0, needRev(ctx));
  },

  recruit(ctx) {
    rateLimit('apprentice-recruit:' + ctx.account.id, 20, 60 * 1000);
    const rev = needRev(ctx);
    const targetAccountId = Number(ctx.body && ctx.body.targetAccountId) || 0;
    const idemKey = String(ctx.headers['idempotency-key'] || (ctx.body && ctx.body.idemKey) || '').slice(0, 120);
    return fight.runRecruit({ accountId: ctx.account.id, targetAccountId, rev, idemKey });
  },

  kick(ctx) {
    rateLimit('apprentice-kick:' + ctx.account.id, 20, 60 * 1000);
    const rev = needRev(ctx);
    const targetAccountId = Number(ctx.body && ctx.body.targetAccountId) || 0;
    if (!targetAccountId) throw fail('BAD_REQUEST', '缺少徒弟账号');
    return apprentice.kickPrentice(ctx.account.id, targetAccountId, rev);
  },

  leave(ctx) {
    rateLimit('apprentice-leave:' + ctx.account.id, 20, 60 * 1000);
    return apprentice.leaveMaster(ctx.account.id, needRev(ctx));
  },

  tribute(ctx) {
    rateLimit('apprentice-tribute:' + ctx.account.id, 30, 60 * 1000);
    return apprentice.claimTribute(ctx.account.id, needRev(ctx));
  },
};
