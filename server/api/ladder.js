'use strict';
/* ============================================================
 * server/api/ladder.js — 天梯排行榜
 * ============================================================ */

const settlement = require('../game/settlement');

module.exports = {
  ladder(ctx) {
    const limit = Number(ctx.query.limit) || 20;
    const out = settlement.ladder(ctx.account.id, limit);
    return Object.assign({ ok: true }, out, {
      award: settlement.rankAwardStatus(ctx.account.id),
      daily: settlement.rankDailyStatus(ctx.account.id),
      serverTime: Date.now(),
    });
  },
};
