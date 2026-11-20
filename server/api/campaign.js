'use strict';

const campaign = require('../game/campaign');
const snapshots = require('../game/snapshot');
const store = require('../game/store');
const { fail, rateLimit } = require('../http');
const { config } = require('../config');

function bossView(boss, level, tickets) {
  return {
    id: boss.id, bossId: boss.bossId, mcFrame: boss.mcFrame, name: boss.name, bigName: boss.bigName,
    level: boss.level, type: boss.type, desc: boss.desc, patternDesc: boss.patternDesc,
    unlockLevel: boss.unlockLevel, locked: !!boss.locked,
    unlocked: !boss.locked && level >= boss.unlockLevel,
    enoughTicket: tickets > 0,
  };
}

module.exports = {
  bosses(ctx) {
    const data = globalThis.CampaignData;
    if (!data) throw fail('SERVER', '征战数据未加载');
    const save = store.peek(ctx.account.id);
    const level = save ? Number(save.level) : 1;
    const tickets = save && save.props ? Math.max(0, Number(save.props[data.TICKET_PROP]) || 0) : 0;
    return {
      ok: true,
      level,
      tickets,
      minLevel: data.MIN_LEVEL,
      partySize: data.PARTY_SIZE,
      daily: campaign.dailyStatus(ctx.account.id),
      ticketProp: data.TICKET_PROP,
      ticketPrice: data.TICKET_SHOP_PRICE,
      bosses: data.bossList().map((b) => bossView(b, level, tickets)),
      pending: campaign.current({ accountId: ctx.account.id }).room,
      records: Array.isArray(save && save.campaignRecords) ? save.campaignRecords.slice(0, 10) : [],
    };
  },

  // 真人匹配：后台等最多 5 分钟，4 人齐直接结算；超时不扣票。
  joinQueue(ctx) {
    rateLimit('cqueue:' + ctx.account.id, 30, 60 * 1000);
    if (!ctx.body.bossId) throw fail('BAD_REQUEST', '缺少 bossId');
    return campaign.enqueue({ accountId: ctx.account.id, bossId: ctx.body.bossId });
  },

  // 随机匹配：立刻抽 3 个等级相近的玩家快照/人机助战并结算（抽签同随机挑战）。
  randomMatch(ctx) {
    rateLimit('crandom:' + ctx.account.id, 30, 60 * 1000);
    if (!ctx.body.bossId) throw fail('BAD_REQUEST', '缺少 bossId');
    return campaign.randomMatch({ accountId: ctx.account.id, bossId: ctx.body.bossId });
  },

  current(ctx) {
    return campaign.current({ accountId: ctx.account.id });
  },


  leaveQueue(ctx) {
    const cur = campaign.current({ accountId: ctx.account.id });
    if (!cur.room || cur.room.status !== 'waiting') return { ok: true, left: false };
    return campaign.leave({ accountId: ctx.account.id, code: cur.room.code });
  },

  create(ctx) {
    rateLimit('croom:' + ctx.account.id, 20, 60 * 1000);
    campaign.reap();
    if (!ctx.body.bossId) throw fail('BAD_REQUEST', '缺少 bossId');
    return campaign.create({ accountId: ctx.account.id, bossId: ctx.body.bossId });
  },

  list(ctx) {
    campaign.reap();
    return campaign.list({ accountId: ctx.account.id });
  },

  join(ctx) {
    rateLimit('cjoin:' + ctx.account.id, 30, 60 * 1000);
    return campaign.join({ accountId: ctx.account.id, code: ctx.params.code });
  },

  status(ctx) {
    campaign.reap();
    return campaign.status({ accountId: ctx.account.id, code: ctx.params.code });
  },

  leave(ctx) {
    return campaign.leave({ accountId: ctx.account.id, code: ctx.params.code });
  },


  roll(ctx) {
    const room = campaign.status({ accountId: ctx.account.id, code: ctx.params.code });
    return { ok: true, room: room.room, rolled: true };
  },

  ack(ctx) {
    return campaign.ack({ accountId: ctx.account.id, code: ctx.params.code });
  },
};
