'use strict';
/* ============================================================
 * server/game/maintenance.js — 追加型表的保留期清理
 * ------------------------------------------------------------
 * 服务器里有一批「只追加、没人删」的表：
 *   combats / combat_chests / combat_pickups / messages / action_log /
 *   daily_counts / ratings / rank_awards / friend_messages / campaign_rooms /
 *   sessions / account_ips / security_events / forum_admin_log
 * 好友服跑得越久，它们越大：天梯换周只加新行、宝箱不领会一直堆、每次动作都记一条账。
 * 论坛帖子默认不删（forumRetentionDays=0）；设了保留期才按创建时间清旧帖。
 * 这里按保留期统一收口；所有阈值都可在 `server/config.js` 用环境变量覆盖。
 *
 * 设计约束：
 *  · 只删「确定过期」的行，不碰当前周 / 未领取 / 等待中的房间；
 *  · 在单个事务里跑，失败整体回滚；
 *  · 启动时跑一次，之后每 `maintenanceIntervalMs` 跑一次（定时器 unref，不阻塞退出）。
 * ============================================================ */

const db = require('../db');
const { config, localDate } = require('../config');
const settlement = require('./settlement');

const DAY = 86400000;

function cutDays(now, days) { return now - Math.max(1, Number(days) || 1) * DAY; }

/**
 * 清理一次。返回删除行数（测试/日志用）。
 * @param {number} [nowMs]
 */
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

    /* 天梯战报保留 7 天；其它战斗只在服务端留 60 分钟重试/领取窗口，
     * 完整普通战斗录像由客户端本地缓存。
     * ⚠ 有真人防守方的战斗（随机挑战/好友切磋）是**防守方的消息入口**，防守方本地
     * 没有这份录像，必须和天梯一样按 combatRetentionDays 保留，否则消息里的
     * 「查看录像」会在 60 分钟后 404。 */
    changes += Number(db.run("DELETE FROM combats WHERE kind = 'rank' AND created_at < ?", combatCut).changes || 0);
    changes += Number(db.run("DELETE FROM combats WHERE kind <> 'rank' AND defender_id = 0 AND created_at < ?", minorCombatCut).changes || 0);
    changes += Number(db.run("DELETE FROM combats WHERE kind <> 'rank' AND defender_id <> 0 AND created_at < ?", combatCut).changes || 0);
    changes += Number(db.run('DELETE FROM combat_chests WHERE created_at < ?', chestCut).changes || 0);
    changes += Number(db.run('DELETE FROM combat_pickups WHERE claimed_at < ?', minorCombatCut).changes || 0);

    /* 动作账本只用于回放/排查，保留最近两周足够。 */
    changes += Number(db.run('DELETE FROM action_log WHERE created_at < ?', actionCut).changes || 0);

    /* 消息：带防守录像的条目跟录像同一个保留期，否则消息页还留着「查看录像」，
     * 点进去 404。其它消息按保留期删。 */
    changes += Number(db.run(
      `DELETE FROM messages
        WHERE created_at < ? AND kind IN ('rank_win', 'rank_loss', 'defense_win', 'defense_loss', 'friend_spar')`,
      combatCut
    ).changes || 0);
    changes += Number(db.run('DELETE FROM messages WHERE read_at IS NOT NULL AND created_at < ?', messageCut).changes || 0);
    changes += Number(db.run('DELETE FROM messages WHERE created_at < ?', cutDays(now, 365)).changes || 0);

    changes += Number(db.run('DELETE FROM daily_counts WHERE date < ?', dailyCut).changes || 0);
    changes += Number(db.run('DELETE FROM rank_awards WHERE created_at < ?', awardCut).changes || 0);
    changes += Number(db.run('DELETE FROM friend_messages WHERE created_at < ?', friendMessageCut).changes || 0);
    changes += Number(db.run('DELETE FROM friend_requests WHERE created_at < ?', friendRequestCut).changes || 0);
    changes += Number(db.run('DELETE FROM account_ips WHERE last_seen < ?', ipCut).changes || 0);
    changes += Number(db.run('DELETE FROM security_events WHERE created_at < ?', securityCut).changes || 0);
    /* 论坛：默认不自动删帖（forumRetentionDays=0）；设了保留期才按创建时间清旧帖，
     * 回复由 forum_replies.post_id 的 ON DELETE CASCADE 一起收掉。 */
    if (forumCut) changes += Number(db.run('DELETE FROM forum_posts WHERE created_at < ?', forumCut).changes || 0);
    changes += Number(db.run('DELETE FROM forum_admin_log WHERE created_at < ?', forumLogCut).changes || 0);

    /* ratings：每个账号只保留「最新一周」一行。
     *  · 活跃玩家：本周行已由 rollWeekIfNeeded 写入，旧周行可以删；
     *  · 长期不登录的玩家：保留最后一次参赛行，等他回来时继续按周数折算。
     * 不能简单删 `season < week`：那会把休眠玩家的折算基准也删掉。 */
    changes += Number(db.run(
      `DELETE FROM ratings
        WHERE season < ?
          AND rowid NOT IN (
            SELECT rowid FROM ratings r
             WHERE r.season = (SELECT MAX(season) FROM ratings r2 WHERE r2.account_id = r.account_id)
          )`, week
    ).changes || 0);

    /* 已结束/过期的征战房：成员行由 campaign_members 的 ON DELETE CASCADE 收掉。
     * waiting 房由 campaign.reap() 按 TTL 处理，这里不抢。 */
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
