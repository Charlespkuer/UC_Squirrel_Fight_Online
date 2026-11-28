'use strict';
// server/game/maintenance.js — 追加型表的保留期清理
// · 在单个事务里跑，失败整体回滚；

const db = require('../db');
const { config, localDate } = require('../config');
const settlement = require('./settlement');

const DAY = 86400000;

function cutDays(now, days) { return now - Math.max(1, Number(days) || 1) * DAY; }

function sweep(nowMs) {
  const now = Number(nowMs) || Date.now();
  const week = settlement.weekKey(now);
  const combatCut = cutDays(now, config.combatRetentionDays);
  const minorCombatCut = now - Math.max(1, Number(config.combatMinorRetentionMinutes) || 60) * 60000;
  const chestCut = cutDays(now, config.chestRetentionDays);
  const actionCut = cutDays(now, config.actionLogRetentionDays);
  const messageCut = cutDays(now, config.messageRetentionDays);
  const dailyCut = localDate(cutDays(now, config.dailyCountsRetentionDays));
  const awardCut = cutDays(now, config.rankAwardRetentionDays);
  const friendMessageCut = cutDays(now, config.friendMessageRetentionDays);
  const friendRequestCut = cutDays(now, config.friendRequestRetentionDays);
  const roomCut = cutDays(now, config.campaignRoomRetentionDays);
  const ipCut = cutDays(now, config.accountIpRetentionDays);
  const securityCut = cutDays(now, config.securityRetentionDays);
  const forumCut = Number(config.forumRetentionDays) > 0 ? cutDays(now, config.forumRetentionDays) : 0;
  const forumLogCut = cutDays(now, config.forumAdminLogRetentionDays);

  let changes = 0;
  db.tx(() => {
    changes += Number(db.run('DELETE FROM sessions WHERE expires_at < ?', now).changes || 0);
    changes += Number(db.run('DELETE FROM session_kicks WHERE created_at < ?', cutDays(now, 7)).changes || 0);

    // 天梯战报保留 7 天；其它战斗只在服务端留 60 分钟重试/领取窗口，
    // 完整普通战斗录像由客户端本地缓存。
    // ⚠ 有真人防守方的战斗（随机挑战/好友切磋）是防守方的消息入口，防守方本地
    changes += Number(db.run("DELETE FROM combats WHERE kind = 'rank' AND created_at < ?", combatCut).changes || 0);
    changes += Number(db.run("DELETE FROM combats WHERE kind <> 'rank' AND defender_id = 0 AND created_at < ?", minorCombatCut).changes || 0);
    changes += Number(db.run("DELETE FROM combats WHERE kind <> 'rank' AND defender_id <> 0 AND created_at < ?", combatCut).changes || 0);
    changes += Number(db.run('DELETE FROM combat_chests WHERE created_at < ?', chestCut).changes || 0);
    changes += Number(db.run('DELETE FROM combat_pickups WHERE claimed_at < ?', minorCombatCut).changes || 0);


    changes += Number(db.run('DELETE FROM action_log WHERE created_at < ?', actionCut).changes || 0);

    // 消息：带防守录像的条目跟录像同一个保留期，否则消息页还留着「查看录像」，
    changes += Number(db.run(
      `DELETE FROM messages
        WHERE created_at < ? AND kind IN ('rank_win', 'rank_loss', 'defense_win', 'defense_loss', 'friend_spar')`,
      combatCut
    ).changes || 0);
    // 其余消息（含未读）统一按 messageRetentionDays 删除，不再单独延长到一年。
    // ⚠ 服务端模板邮件 / 全服公告不能按保留期删：`servermail.deliver()` 的幂等键就是这行 id，
    // 领取状态也只在它的 payload 里 —— 删掉后下一次轮询会重新投一封可领取的邮件（重复发奖）。
    changes += Number(db.run(
      `DELETE FROM messages WHERE created_at < ?
         AND id NOT LIKE 'servermail:%' AND id NOT LIKE 'broadcast:%'
         AND kind NOT IN ('welcome', 'opening_gift', 'announcement')`,
      messageCut
    ).changes || 0);

    changes += Number(db.run('DELETE FROM daily_counts WHERE date < ?', dailyCut).changes || 0);

    changes += Number(db.run('DELETE FROM account_daily_actions WHERE date < ?', dailyCut).changes || 0);
    changes += Number(db.run('DELETE FROM rank_awards WHERE created_at < ?', awardCut).changes || 0);
    changes += Number(db.run('DELETE FROM rank_finals WHERE created_at < ?', awardCut).changes || 0);
    changes += Number(db.run('DELETE FROM friend_messages WHERE created_at < ?', friendMessageCut).changes || 0);
    changes += Number(db.run('DELETE FROM friend_requests WHERE created_at < ?', friendRequestCut).changes || 0);
    changes += Number(db.run('DELETE FROM account_ips WHERE last_seen < ?', ipCut).changes || 0);
    changes += Number(db.run('DELETE FROM security_events WHERE created_at < ?', securityCut).changes || 0);

    if (forumCut) changes += Number(db.run('DELETE FROM forum_posts WHERE created_at < ?', forumCut).changes || 0);
    changes += Number(db.run('DELETE FROM forum_admin_log WHERE created_at < ?', forumLogCut).changes || 0);

    // ratings：每个账号只保留「最新一周」一行。
    // 不能简单删 `season < week`：那会把休眠玩家的折算基准也删掉。
    changes += Number(db.run(
      `DELETE FROM ratings
        WHERE season < ?
          AND rowid NOT IN (
            SELECT rowid FROM ratings r
             WHERE r.season = (SELECT MAX(season) FROM ratings r2 WHERE r2.account_id = r.account_id)
          )`, week
    ).changes || 0);


    changes += Number(db.run(
      `DELETE FROM campaign_rooms
        WHERE status <> 'waiting'
          AND COALESCE(NULLIF(closed_at, 0), NULLIF(start_at, 0), created_at) < ?`, roomCut
    ).changes || 0);
  });
  return changes;
}

let timer = null;
function startScheduler() {
  if (timer) return timer;
  try { sweep(); } catch (e) { console.warn('[maintenance] startup sweep failed', e && e.message); }
  timer = setInterval(() => {
    try {
      const n = sweep();
      if (n > 0 && config.logLevel === 'debug') console.log('[maintenance] pruned ' + n + ' rows');
    } catch (e) { console.warn('[maintenance] sweep failed', e && e.message); }
  }, config.maintenanceIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { sweep, startScheduler, stopScheduler };
