'use strict';
/* ============================================================
 * server/api/state.js — 权威存档 / 动作 / 快照
 * ============================================================ */

const db = require('../db');
const store = require('../game/store');
const actions = require('../game/actions');
const snapshot = require('../game/snapshot');
const settlement = require('../game/settlement');
const serverMail = require('../game/server-mail');
const { fail, clientIp, rateLimit } = require('../http');
const { config } = require('../config');
const { fighterFromSnapshot } = require('../game/fighter');
const devices = require('../device');

function mySnapshot(accountId) {
  const snap = snapshot.currentSnapshot(accountId, 'classic');
  return snap ? {
    id: snap.id, level: snap.level, revision: snap.revision,
    createdAt: snap.createdAt, fighter: snap.fighter,
  } : null;
}

module.exports = {
  /** 登录后拉整份存档 + 当前快照 + 每日状态。 */
  getState(ctx) {
    const accountId = ctx.account.id;
    /* 每日任务由服务端生成并落库：登录/拉整档时先过一遍 `questStatus()`，
     * 缺题或换天会 `questState()` 重摇并提交，客户端拿到的就是稳定题面。 */
    const init = store.runOnSave(accountId, ({ api }) => {
      try { api.questStatus(); } catch (_) {}
    });
    const payload = init.payload;
    /* 服务端奖励邮件（开服奖励等，见 server/game/server-mail.js）：等级到了就补投一封待领取邮件。
     * 投递幂等；模板写错或道具表异常都不能把登录带崩，只记一条警告。 */
    try { serverMail.deliver(accountId, payload.level); } catch (e) {
      console.warn('[server-mail] 投递失败：' + ((e && e.message) || e));
    }
    /* 天梯积分以 ratings 为唯一真值（默认 0 分起步、换季会折算）。存档里的 integral
     * 只是给离线分支/战斗面板看的镜像，登录时用权威分覆盖，避免旧档带着 1500。 */
    settlement.syncIntegral(accountId, payload);
    return {
      ok: true,
      rev: init.rev,
      save: payload,
      snapshot: mySnapshot(accountId),
      daily: settlement.rankDailyStatus(accountId),
      season: settlement.weekKey(),
      serverTime: Date.now(),
      summary: store.summaryOf(payload),
      /* 新设备/新地点登录提醒：未读时随整档下发，客户端登录后弹一次。 */
      alerts: devices.unreadAlerts(accountId),
    };
  },

  /** 只拿摘要（天梯列表/消息页/好友页用，省流量）。 */
  summary(ctx) {
    const row = store.getRow(ctx.account.id);
    if (!row) return { ok: true, save: null };
    const summary = store.summaryOf(store.decode(row.payload));
    settlement.syncIntegral(ctx.account.id, summary);
    return {
      ok: true, rev: Number(row.revision), save: summary,
      daily: settlement.rankDailyStatus(ctx.account.id), season: settlement.weekKey(),
    };
  },

  /** 执行一个动作。 */
  act(ctx) {
    const accountId = ctx.account.id;
    rateLimit('action:' + accountId, config.actionRatePerMin, 60 * 1000);
    const name = String(ctx.body.name || '');
    const args = Array.isArray(ctx.body.args) ? ctx.body.args : [];
    const rev = ctx.body.rev;
    if (!Number.isSafeInteger(rev) || rev <= 0) throw fail('BAD_REQUEST', 'rev 必须是正整数，请重新同步存档');
    const out = actions.execute({ accountId, name, args, rev, ip: clientIp(ctx.req) });
    return {
      ok: true,
      name,
      result: out.result,
      rev: out.rev,
      patch: out.patch,
      summary: out.summary,
      daily: settlement.rankDailyStatus(accountId),
    };
  },

  /** 当前快照（含战斗体），调试与好友切磋预览用。 */
  snapshot(ctx) {
    const snap = mySnapshot(ctx.account.id);
    return { ok: true, snapshot: snap };
  },

  /**
   * 客户端主动上报一次「我现在这个面板」——用于同级换装后立刻刷新防守阵容。
   * 只在确实有变化时才写一条新 revision。
   */
  syncSnapshot(ctx) {
    const out = store.runOnSave(ctx.account.id, () => null, { snapshotSource: 'client-sync' });
    return { ok: true, rev: out.rev, snapshot: mySnapshot(ctx.account.id) };
  },
};
