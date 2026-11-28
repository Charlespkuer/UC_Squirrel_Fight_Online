'use strict';
// server/api/state.js — 权威存档 / 动作 / 快照

const db = require('../db');
const store = require('../game/store');
const actions = require('../game/actions');
const snapshot = require('../game/snapshot');
const visibility = require('../game/visibility');
const enforcement = require('../game/enforcement');
const settlement = require('../game/settlement');
const serverMail = require('../game/server-mail');
const apprentice = require('../game/apprentice');
const { fail, clientIp, rateLimit, pace } = require('../http');
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
  // 登录后拉整份存档 + 当前快照 + 每日状态。
  getState(ctx) {
    const accountId = ctx.account.id;
    // 每日任务由服务端生成并落库：登录/拉整档时先过一遍 `questStatus()`，
    // 缺题或换天会 `questState()` 重摇并提交，客户端拿到的就是稳定题面。
    const init = store.runOnSave(accountId, ({ api }) => {
      try { api.questStatus(); } catch (_) {}
    });
    const payload = init.payload;
    /* 只把实时师徒面板写进这次响应，不落库：客户端打开关卡确认页时就能看到
     * 徒弟当前等级；真正写师父存档镜像是关卡/征战开打时由 applyPrenticeStatsInto 做。 */
    try { apprentice.applyPrenticeStatsInto(payload, apprentice.livePrenticeStats(accountId)); } catch (_) {}
    // 服务端奖励邮件（开服奖励等，见 server/game/server-mail.js）：等级到了就补投一封待领取邮件。
    // 投递幂等；模板写错或道具表异常都不能把登录带崩，只记一条警告。
    try { serverMail.deliver(accountId, payload.level); } catch (e) {
      console.warn('[server-mail] 投递失败：' + ((e && e.message) || e));
    }
    // 天梯积分以 ratings 为唯一真值（默认 0 分起步、换季会折算）。存档里的 integral
    settlement.syncIntegral(accountId, payload);
    return {
      ok: true,
      rev: init.rev,
      save: payload,
      snapshot: mySnapshot(accountId),
      daily: settlement.rankDailyStatus(accountId),
      season: settlement.weekKey(),
      hidden: visibility.isHidden(accountId),
      hiddenUntil: visibility.hiddenUntil(accountId),
      enforcement: enforcement.statusFor(accountId),
      alerts: enforcement.alerts(accountId),
      serverTime: Date.now(),
      summary: store.summaryOf(payload),
      // 新设备/新地点登录提醒：未读时随整档下发，客户端登录后弹一次。
      alerts: devices.unreadAlerts(accountId),
    };
  },


  summary(ctx) {
    const row = store.getRow(ctx.account.id);
    if (!row) return { ok: true, save: null };
    const summary = store.summaryOf(store.decode(row.payload));
    settlement.syncIntegral(ctx.account.id, summary);
    return {
      ok: true, rev: Number(row.revision), save: summary,
      daily: settlement.rankDailyStatus(ctx.account.id), season: settlement.weekKey(),
      hidden: visibility.isHidden(ctx.account.id), hiddenUntil: visibility.hiddenUntil(ctx.account.id),
    };
  },


  act(ctx) {
    const accountId = ctx.account.id;
    rateLimit('action:' + accountId, config.actionRatePerMin, 60 * 1000);
    const name = String(ctx.body.name || '');
    const def = actions.actionDef(name);
    // 服务端连点闸门：买/升级/使用道具这类 async 动作，同一账号两次至少间隔
    // actionIntervalMs（默认 80ms）。sync 动作是客户端预测后的廉价补发（教学步骤 /
    // 消息已读），不拦，避免一次操作里连发补确认被误伤；它们仍受 240 次/分限制。
    // 闸门不依赖客户端设置，抛错的请求不提交，下一次动作不会被它拖慢。
    const commitPace = def && def.mode === 'async'
      ? pace('action:' + accountId, config.actionIntervalMs) : () => {};
    const args = Array.isArray(ctx.body.args) ? ctx.body.args : [];
    const rev = ctx.body.rev;
    if (!Number.isSafeInteger(rev) || rev <= 0) throw fail('BAD_REQUEST', 'rev 必须是正整数，请重新同步存档');
    const out = actions.execute({ accountId, name, args, rev, ip: clientIp(ctx.req) });
    commitPace();
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

  // 当前快照（含战斗体），调试与好友切磋预览用。
  snapshot(ctx) {
    const snap = mySnapshot(ctx.account.id);
    return { ok: true, snapshot: snap };
  },

  // 客户端主动上报一次「我现在这个面板」——用于同级换装后立刻刷新防守阵容。
  syncSnapshot(ctx) {
    const out = store.runOnSave(ctx.account.id, () => null, { snapshotSource: 'client-sync' });
    return { ok: true, rev: out.rev, snapshot: mySnapshot(ctx.account.id) };
  },
};
