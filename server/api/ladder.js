'use strict';

const settlement = require('../game/settlement');

module.exports = {
  ladder(ctx) {
    const limit = Number(ctx.query.limit) || 20;
    const out = settlement.ladder(ctx.account.id, limit);
    return Object.assign({ ok: true }, out, {
      daily: settlement.rankDailyStatus(ctx.account.id),
      serverTime: Date.now(),
    });
  },
};
