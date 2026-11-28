'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../auth');
const store = require('../game/store');
const snapshots = require('../game/snapshot');
const settlement = require('../game/settlement');
const fight = require('../game/fight');
const vip = require('../game/vip');
const serverMail = require('../game/server-mail');
const { fail, rateLimit, clientIp } = require('../http');
const { config } = require('../config');

// 奖励邮件（全服公告 / `server/game/server-mail.js` 的模板邮件）：奖励是「领取才入账」，
// 与旧的「发放即到账」公告区分。只认服务端自己写进 messages.payload 的 claimable 标记；
// 老公告没有这个标记，不会因为新版领取接口上线而被重复发一次。
const PROP_HARD_CAP = 9999;
function mailRewards(payload) {
  const gold = Math.max(0, Math.min(100000, Math.floor(Number(payload && payload.gold) || 0)));
  const cup = Math.max(0, Math.min(100000, Math.floor(Number(payload && payload.cup) || 0)));
  const props = [];
  const raw = payload && payload.props;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      const id = Number(key), count = Math.floor(Number(raw[key]) || 0);
      if (Number.isInteger(id) && id > 0 && count > 0) props.push({ id, count: Math.min(PROP_HARD_CAP, count) });
    }
  }
  props.sort((a, b) => a.id - b.id);
  return { gold, cup, props };
}

function publicFrom(accountId) {
  const row = db.get('SELECT a.id,a.name,a.tag,p.player_id FROM accounts a JOIN player_ids p ON p.account_id=a.id WHERE a.id = ?', Number(accountId));
  return row ? { accountId: Number(row.id), playerId: Number(row.player_id), name: String(row.name), tag: String(row.tag), display: String(row.name) } : null;
}

// 开发者礼包：服务端模板邮件（`servermail:`）与全服公告（`broadcast:`）。
// 未领取前固定在最前；领取后 payload.claimedAt 出现，自动回到普通时间排序。
function isDeveloperGift(row) {
  const id = String((row && row.id) || '');
  const kind = String((row && row.kind) || '');
  return id.startsWith('servermail:') || id.startsWith('broadcast:') || kind === 'welcome' || kind === 'opening_gift';
}
function pinnedMail(row, payload) {
  let p = payload;
  if (p === undefined) {
    try { p = JSON.parse((row && row.payload) || '{}'); } catch (_) { p = {}; }
  }
  return isDeveloperGift(row) && p && p.claimable === true && !p.claimedAt;
}

// SQL 版本：未领取的开发者礼包排最前；`claimedAt` 一写入就恢复普通时间序。
const PIN_SQL = `((id LIKE 'servermail:%' OR id LIKE 'broadcast:%' OR kind IN ('welcome','opening_gift'))
  AND payload LIKE '%"claimable":true%' AND payload NOT LIKE '%"claimedAt"%')`;
const PIN_ORDER = `CASE WHEN ${PIN_SQL} THEN 0 ELSE 1 END`;

function messageRow(row, accountId) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
  // 天梯复仇只认“被抢方 + 当天 + 原战报”：由服务端算 eligibility，客户端不再自己
  // 从本地 battleHistory 猜。每条 rank 消息多查一次原战斗，50 条上限下开销可接受。
  if (/^rank_/.test(String(row.kind)) && row.combat_id) {
    const info = fight.revengeInfoFor(accountId, row.combat_id);
    if (info) payload.revenge = info;
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    combatId: String(row.combat_id || ''),
    from: row.from_id ? { accountId: Number(row.from_id), name: String(row.from_name || '') } : null,
    text: String(row.text || ''),
    payload,
    pinned: pinnedMail(row, payload),
    read: !!row.read_at,
    createdAt: Number(row.created_at),
  };
}

// 多路径 json_extract 返回 JSON 数组文本 → battleStatsOfRow 需要的列名。
function battleStatsColumns(row) {
  const raw = row && row.battle_stats;
  if (typeof raw !== 'string') return {};
  let arr = null;
  try { arr = JSON.parse(raw); } catch (_) { return {}; }
  if (!Array.isArray(arr)) return {};
  return { daily_wins: arr[0], daily_fails: arr[1], all_wins: arr[2], all_fails: arr[3], daily_stats_date: arr[4] };
}

// 好友列表一次取齐快照 / 积分，避免每个好友各查 3 条（50 好友 ≈ 150 次查询）。
function friendRows(rows) {
  const ids = rows.map((row) => Number(row.friend_id)).filter((id) => id > 0);
  const snaps = new Map(), ratings = new Map();
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const snapRows = db.all(
      `SELECT account_id, id, level FROM battle_snapshots
        WHERE account_id IN (${marks}) AND mode = ? AND is_current = 1
        ORDER BY level DESC, revision DESC`, ...ids, 'classic'
    );
    for (const snap of snapRows) {
      const id = Number(snap.account_id);
      if (!snaps.has(id)) snaps.set(id, { id: String(snap.id), level: Number(snap.level) });
    }
    const ratingRows = db.all(
      `SELECT account_id, score FROM ratings WHERE season = ? AND account_id IN (${marks})`,
      settlement.weekKey(), ...ids
    );
    for (const rating of ratingRows) ratings.set(Number(rating.account_id), Math.max(0, Number(rating.score) || 0));
  }
  const now = Date.now();
  return rows.map((row) => {
    const accountId = Number(row.friend_id);
    const snap = snaps.get(accountId) || null;
    const lastSeen = Number(row.last_seen) || 0;
    return {
      accountId,
      name: String(row.name || row.save_name || ''),
      tag: String(row.tag || ''),
      display: String(row.name || ''),
      level: row.save_level != null ? Number(row.save_level) : (snap ? snap.level : 1),
      vipLevel: vip.levelAt(row.vip_level, row.vip_until),
      score: ratings.get(accountId) || 0,
      lastSeen,
      snapshotId: snap ? snap.id : '',
      online: lastSeen > 0 && now - lastSeen < 5 * 60 * 1000,
      ...store.battleStatsOfRow(battleStatsColumns(row)),
    };
  });
}

// 一条好友申请 → 原版 `messages.do?type=3` 的字段（messageId / name / playerId / level）。
function friendRequestRow(row) {
  const prof = publicFrom(row.from_id) || { accountId: Number(row.from_id), playerId: 0, name: '', tag: '', display: '' };
  const save = db.get('SELECT level, vip_level, vip_until FROM saves WHERE account_id = ? AND mode = ?', Number(row.from_id), 'classic');
  return {
    messageId: String(row.id),
    accountId: Number(row.from_id),
    playerId: prof.playerId,
    name: prof.name,
    tag: prof.tag,
    display: prof.display,
    level: save ? Number(save.level) : 1,
    vipLevel: save ? vip.levelAt(save.vip_level, save.vip_until) : 0,
    createdAt: Number(row.created_at),
  };
}

// 把 `targetId` 作为好友写进 `ownerId` 的存档（经典挑战页/离线分支读这一份）。
function addFriendToSave(ownerId, targetId) {
  const prof = publicFrom(targetId);
  if (!prof) return;
  const snap = snapshots.currentSnapshot(targetId, 'classic');
  const save = store.peek(targetId);
  const foe = Object.assign({ name: prof.name, level: save ? save.level : 1 }, save ? {
    power: save.power, agility: save.agility, speed: save.speed, hp: save.maxHp,
  } : {});
  store.runOnSave(ownerId, ({ api }) => {
    api.addFriend(Object.assign({}, prof, foe, { remoteId: Number(targetId), snapshotId: snap ? snap.id : '' }));
  });
}

// 接受一条申请：双向 `friendships` + 两边存档好友列表 + 清掉两个方向的 pending。
function acceptFriendRequest(request) {
  const fromId = Number(request.from_id), toId = Number(request.to_id);
  if (Number(db.get('SELECT COUNT(*) AS c FROM friendships WHERE account_id = ?', toId).c) >= config.friendLimit)
    throw fail('CONFLICT', '好友已满（' + config.friendLimit + ' 个）');
  if (Number(db.get('SELECT COUNT(*) AS c FROM friendships WHERE account_id = ?', fromId).c) >= config.friendLimit)
    throw fail('CONFLICT', '对方好友已满（' + config.friendLimit + ' 个）');
  db.tx(() => {
    db.run('INSERT OR IGNORE INTO friendships (account_id, friend_id, created_at) VALUES (?,?,?)', toId, fromId, Date.now());
    db.run('INSERT OR IGNORE INTO friendships (account_id, friend_id, created_at) VALUES (?,?,?)', fromId, toId, Date.now());
    db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', fromId, toId, toId, fromId);
    addFriendToSave(toId, fromId);
    addFriendToSave(fromId, toId);
  });
  return publicFrom(fromId);
}

// 主界面 NEW / 消息页红点共用的一份计数：`leave` 是留言板未读，仍计入 `unread`；
// 登录安全提醒有独立弹窗，不参与主界面 NEW。
function badgeCounts(accountId) {
  const me = Number(accountId);
  const seen = db.get('SELECT requests_seen_at FROM notice_seen WHERE account_id = ?', me);
  const requestsSeenAt = Math.max(0, Number(seen && seen.requests_seen_at) || 0);
  const row = db.get(
    `SELECT COUNT(*) AS c,
            SUM(CASE WHEN kind = 'friend_message' THEN 1 ELSE 0 END) AS board
       FROM messages
      WHERE account_id = ? AND read_at IS NULL AND kind <> 'login_alert'`,
    me
  );
  const unread = Number(row && row.c || 0);
  const leave = Number(row && row.board || 0);
  const requests = Number(db.get(
    'SELECT COUNT(*) AS c FROM friend_requests WHERE to_id = ? AND created_at > ?',
    me, requestsSeenAt
  ).c || 0);
  return { unread, leave, requests, total: unread + requests };
}

module.exports = {

  messages(ctx) {
    const me = Number(ctx.account.id);

    try {
      const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', me, store.MODE);
      if (save) serverMail.deliver(me, save.level);
    } catch (e) { console.warn('[server-mail] 投递失败：' + ((e && e.message) || e)); }
    const since = Number(ctx.query.since) || 0;
    const limit = Math.max(1, Math.min(50, Number(ctx.query.limit) || 20));
    const rows = since > 0
      ? db.all(`SELECT * FROM messages WHERE account_id = ? AND (created_at > ? OR ${PIN_SQL}) ORDER BY ${PIN_ORDER}, created_at DESC LIMIT ?`, me, since, limit)
      : db.all(`SELECT * FROM messages WHERE account_id = ? ORDER BY ${PIN_ORDER}, created_at DESC LIMIT ?`, me, limit);
    const unread = db.get('SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND read_at IS NULL', me);
    return { ok: true, messages: rows.map(row => messageRow(row, me)), unread: Number(unread.c || 0), serverTime: Date.now() };
  },

  // 主界面「消息」NEW 红点：只统计被动到达且还没看过的东西。
  // 返回 total 给 `SfUiMain.hasNewMessages()`，客户端每 15 秒轮询一次。
  badge(ctx) {
    const me = Number(ctx.account.id);

    try {
      const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', me, store.MODE);
      if (save) serverMail.deliver(me, save.level);
    } catch (e) { console.warn('[server-mail] 投递失败：' + ((e && e.message) || e)); }
    return Object.assign({ ok: true }, badgeCounts(me), { serverTime: Date.now() });
  },

  // 打开消息页时调用：把已到达的普通消息标为已读，并记下好友验证看到哪。
  // 留言不动（它的未读状态由留言 tab 自己按 id 标记），否则主界面 NEW 和 `leaveNew` 会一起熄灭。
  seenMessages(ctx) {
    const me = Number(ctx.account.id), ts = Date.now();
    db.tx(() => {
      db.run('UPDATE messages SET read_at = ? WHERE account_id = ? AND read_at IS NULL AND kind <> ?', ts, me, 'friend_message');
      db.run(
        `INSERT INTO notice_seen (account_id, requests_seen_at, updated_at) VALUES (?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET requests_seen_at = excluded.requests_seen_at, updated_at = excluded.updated_at`,
        me, ts, ts
      );
    });
    return Object.assign({ ok: true }, badgeCounts(me), { seenAt: ts });
  },

  readMessages(ctx) {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 200).map(String) : [];
    const before = Number(ctx.body.before) || 0;
    const ts = Date.now();
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      db.run(`UPDATE messages SET read_at = ? WHERE account_id = ? AND read_at IS NULL AND id IN (${marks})`,
        ts, Number(ctx.account.id), ...ids);
    } else if (before > 0) {
      db.run('UPDATE messages SET read_at = ? WHERE account_id = ? AND created_at <= ? AND read_at IS NULL', ts, Number(ctx.account.id), before);
    } else {
      db.run('UPDATE messages SET read_at = ? WHERE account_id = ? AND read_at IS NULL', ts, Number(ctx.account.id));
    }
    return Object.assign({ ok: true }, badgeCounts(Number(ctx.account.id)));
  },

  // 领取奖励邮件（`POST /api/messages/claim`）：同一封邮件只能成功入账一次。
  // 模板邮件的 `payload.minLevel` 在这里再校验一次（没解锁消息功能前不许领）。
  claimMail(ctx) {
    const me = Number(ctx.account.id), id = String(ctx.body && ctx.body.id || '');
    if (!id) throw fail('BAD_REQUEST', '邮件编号无效');
    return db.tx(() => {
      const row = db.get('SELECT id,kind,payload FROM messages WHERE id = ? AND account_id = ?', id, me);
      if (!row) throw fail('NOT_FOUND', '邮件不存在或不属于当前账号');
      if (!serverMail.CLAIMABLE_KINDS.has(String(row.kind))) throw fail('BAD_REQUEST', '这不是奖励邮件');
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
      const rewards = mailRewards(payload);
      if (!payload.claimable) return { ok: true, already: true, claimed: false, rewards, message: '这条公告没有待领取的奖励。' };
      const needLevel = Math.max(0, Math.floor(Number(payload.minLevel) || 0));
      if (needLevel > 1) {
        const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', me, store.MODE);
        if (!save || Number(save.level) < needLevel)
          throw fail('FORBIDDEN', '达到 ' + needLevel + ' 级后才能领取这封邮件');
      }
      if (payload.claimedAt) return { ok: true, already: true, claimed: true, rewards, message: '奖励已经领取过了。' };
      if (!rewards.gold && !rewards.cup && !rewards.props.length) {
        payload.claimedAt = Date.now();
        db.run('UPDATE messages SET payload = ? WHERE id = ? AND account_id = ?', JSON.stringify(payload), id, me);
        return { ok: true, already: true, claimed: true, rewards, message: '这条公告没有可领取的奖励。' };
      }
      store.runOnSave(me, ({ api, save }) => {
        // 邮件金松果是赠送，不是当日个人收益：不写 earnHistory，徒弟日供（按昨日收益 10%）
        // 不能把它算进师傅进贡。只有战斗/关卡/礼包/任务等默认 addGold 的收益才计入。
        if (rewards.gold) api.addGold(rewards.gold, { count: false });
        if (rewards.cup) api.addGoldCup(rewards.cup);
        if (!rewards.props.length) return;
        if (!save.props || typeof save.props !== 'object' || Array.isArray(save.props)) save.props = {};
        for (const item of rewards.props) {
          save.props[item.id] = Math.min(PROP_HARD_CAP, Math.max(0, Number(save.props[item.id]) || 0) + item.count);
        }
      }, { deferSettle: true });
      payload.claimedAt = Date.now();
      db.run('UPDATE messages SET payload = ? WHERE id = ? AND account_id = ?', JSON.stringify(payload), id, me);
      return { ok: true, already: false, claimed: true, rewards };
    });
  },


  friends(ctx) {
    // ⚠ 一次多路径 json_extract：逐字段写 5 条会让同一份 payload 被整解析 10 遍（50 好友 ≈ 5 ms）。
    const rows = db.all(
      `SELECT f.friend_id, a.name, a.tag, a.last_seen, s.level AS save_level, s.name AS save_name,
              s.vip_level AS vip_level, s.vip_until AS vip_until,
              CASE WHEN json_valid(s.payload) THEN json_extract(s.payload,
                '$.dailyWins', '$.dailyFails', '$.allWins', '$.allFails', '$.dailyStatsDate') END AS battle_stats
         FROM friendships f
         JOIN accounts a ON a.id = f.friend_id
         LEFT JOIN saves s ON s.account_id = f.friend_id AND s.mode = ?
        WHERE f.account_id = ?
        ORDER BY f.created_at DESC`,
      store.MODE, Number(ctx.account.id)
    );
    const list = friendRows(rows);
    const aiRows = db.all('SELECT id,fighter,created_at FROM ai_friends WHERE account_id=? ORDER BY created_at DESC,id DESC', Number(ctx.account.id));
    // 和 `/api/opponents` 同一个理由：列表里直接带战斗体，客户端不必每个好友再跑一次
    // ⚠ 再往上放（原版抓包 142 人）不能继续整包下发，要先把好友页改成分页/懒加载。
    const fighterFromSnapshot = require('../game/fighter').fighterFromSnapshot;
    const withFighter = String(ctx.query.withFighter || '1') !== '0';
    if (withFighter) {
      const snaps = snapshots.snapshotByIds(list.map((item) => item.snapshotId).filter(Boolean));
      let budget = config.friendLimit;
      for (const item of list) {
        if (budget <= 0) break;
        const snap = item.snapshotId ? snaps.get(String(item.snapshotId)) : null;
        if (!snap || !snap.fighter) continue;
        item.fighter = fighterFromSnapshot(snap.fighter);
        item.hp = item.fighter.maxHp || item.fighter.hp;
        budget--;
      }
    }
    for (const row of aiRows) {
      const fighter = JSON.parse(row.fighter);
      list.push({ snapshotId: String(row.id), source: 'bot', bot: true, player: false, name: fighter.name,
        level: fighter.level, vipLevel: 0, display: fighter.name + ' AI', fighter, createdAt: Number(row.created_at) });
    }
    return {
      ok: true, friends: list, limit: config.friendLimit, aiCount: aiRows.length, aiLimit: 10,
      // 消息页「验证消息」红点（原版 `newMsgType.hasNewValidateMessage`）：没有单独的推送，
      // 客户端每次打开消息页/好友页时读这个数。
      requestCount: Number(db.get('SELECT COUNT(*) AS c FROM friend_requests WHERE to_id = ?', Number(ctx.account.id)).c),
    };
  },

  addAiFriend(ctx) {
    const owner = Number(ctx.account.id), key = String(ctx.body.requestKey || '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw fail('BAD_REQUEST', '请求标识无效');
    const existing = db.get('SELECT id,fighter FROM ai_friends WHERE account_id=? AND request_key=?', owner, key);
    if (existing) return { ok: true, friend: { snapshotId: existing.id, fighter: JSON.parse(existing.fighter) } };
    rateLimit('friend-ai:' + owner, 20, 60000);
    let friend;
    db.tx(() => {
      if (Number(db.get('SELECT COUNT(*) AS n FROM ai_friends WHERE account_id=?', owner).n) >= 10)
        throw fail('CONFLICT', 'AI 好友已满 10 位，请先删除一位');
      const save = store.peek(owner);
      if (!save) throw fail('CONFLICT', '账号存档不存在');
      const runtime = require('../game/runtime'), battle = require('../game/battle'), opponents = require('../game/opponents');
      let fighter;
      runtime.withState(save, ({ api }) => battle.withSeed(battle.randomSeed(), () => {
        fighter = require('../game/fighter').fighterFromSnapshot(opponents.buildRandomFoe(api, Math.max(1, Number(save.level) || 1)));
      }));
      const id = 'ai_' + crypto.randomBytes(15).toString('base64url');
      db.run('INSERT INTO ai_friends(id,account_id,request_key,fighter,created_at) VALUES (?,?,?,?,?)', id, owner, key, JSON.stringify(fighter), Date.now());
      friend = { snapshotId: id, fighter };
    });
    return { ok: true, friend };
  },


  addFriend(ctx) {
    rateLimit('friend:' + ctx.account.id, 30, 60 * 1000);
    const me = Number(ctx.account.id);
    const internalId = Number(ctx.body.accountId) || 0;
    const target = internalId ? db.get('SELECT * FROM accounts WHERE id=?', internalId) : auth.findAccountStrict(ctx.body.target);
    if (!target) throw fail('NOT_FOUND', '找不到这个玩家（可写昵称或玩家 ID）');
    if (Number(target.id) === me) throw fail('BAD_REQUEST', '不能加自己');
    // 已经是好友：原版服务端也会直接回成功；这里给 `already` 让客户端换文案。
    if (db.get('SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?', me, Number(target.id)))
      return { ok: true, already: true, friend: publicFrom(target.id), message: '你们已经是好友。' };
    if (Number(db.get('SELECT COUNT(*) AS c FROM friendships WHERE account_id = ?', me).c) >= config.friendLimit)
      throw fail('CONFLICT', '好友已满（' + config.friendLimit + ' 个）');

    const reverse = db.get('SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ?', Number(target.id), me);
    if (reverse) {
      const friend = acceptFriendRequest(reverse);
      return { ok: true, accepted: true, friend, message: '已成功添加好友。' };
    }
    const dup = db.get('SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ?', me, Number(target.id));
    if (dup) return { ok: true, pending: true, duplicate: true, request: friendRequestRow(dup), message: '已发送好友申请！在其验证通过后双方即自动成为好友。' };
    if (Number(db.get('SELECT COUNT(*) AS c FROM friend_requests WHERE from_id = ?', me).c) >= 50)
      throw fail('CONFLICT', '待验证的好友申请太多了，等对方处理后再试');
    const id = 'fr_' + crypto.randomBytes(12).toString('base64url');
    db.run('INSERT INTO friend_requests (id, from_id, to_id, created_at) VALUES (?,?,?,?)', id, me, Number(target.id), Date.now());
    return {
      ok: true, pending: true, request: friendRequestRow(db.get('SELECT * FROM friend_requests WHERE id = ?', id)),
      message: '已发送好友申请！在其验证通过后双方即自动成为好友。',
    };
  },


  friendRequests(ctx) {
    const rows = db.all(
      `SELECT fr.*, a.name, a.tag, p.player_id, s.level AS save_level
         FROM friend_requests fr
         LEFT JOIN accounts a ON a.id = fr.from_id
         LEFT JOIN player_ids p ON p.account_id = fr.from_id
         LEFT JOIN saves s ON s.account_id = fr.from_id AND s.mode = ?
        WHERE fr.to_id = ?
        ORDER BY fr.created_at DESC LIMIT 50`,
      store.MODE, Number(ctx.account.id)
    );
    const requests = rows.map((row) => ({
      messageId: String(row.id),
      accountId: Number(row.from_id),
      playerId: Number(row.player_id) || 0,
      name: String(row.name || ''),
      tag: String(row.tag || ''),
      display: String(row.name || ''),
      level: row.save_level != null ? Number(row.save_level) : 1,
      createdAt: Number(row.created_at),
    }));
    return { ok: true, requests, count: requests.length };
  },


  respondFriendRequest(ctx) {
    const me = Number(ctx.account.id);
    const id = String(ctx.params.id || '');
    const request = db.get('SELECT * FROM friend_requests WHERE id = ? AND to_id = ?', id, me);
    if (!request) throw fail('NOT_FOUND', '这条好友申请不存在或已经处理');
    const accept = ctx.body.accept === true || ctx.body.accept === 'true' || Number(ctx.body.accept) === 1;
    if (!accept) {
      db.run('DELETE FROM friend_requests WHERE id = ?', id);
      return { ok: true, rejected: true };
    }
    const friend = acceptFriendRequest(request);
    return { ok: true, accepted: true, friend, message: '已成功添加好友。' };
  },

  removeFriend(ctx) {
    const me = Number(ctx.account.id);
    const ref = String(ctx.params.id || '');
    if (/^ai_[A-Za-z0-9_-]+$/.test(ref)) {
      const found = db.run('DELETE FROM ai_friends WHERE id=? AND account_id=?', ref, me);
      if (!found.changes) throw fail('NOT_FOUND', '没有这位 AI 好友');
      return { ok: true };
    }
    const target = /^\d+$/.test(ref) ? db.get('SELECT * FROM accounts WHERE id=?', Number(ref)) : auth.findAccountStrict(ref);
    if (!target) throw fail('NOT_FOUND', '没有这个好友');
    db.tx(() => {
      db.run('DELETE FROM friendships WHERE account_id = ? AND friend_id = ?', me, Number(target.id));
      db.run('DELETE FROM friendships WHERE account_id = ? AND friend_id = ?', Number(target.id), me);

      db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
        me, Number(target.id), Number(target.id), me);
      store.runOnSave(me, ({ api }) => { api.removeFriend(String(target.name)); });
      // 好友是双向关系：两边存档镜像都摘掉（师徒是另一套关系，这里不碰）。
      try {
        const mine = store.peek(me);
        if (mine && mine.name) store.runOnSave(Number(target.id), ({ api }) => { api.removeFriend(String(mine.name)); });
      } catch (_) {}
    });
    return { ok: true };
  },

  // 按昵称、玩家 ID 或旧格式“名字#编号”搜索玩家。
  search(ctx) {
    const q = String(ctx.query.q || '').trim();
    if (!q) return { ok: true, results: [] };
    const rows = db.all(
      `SELECT a.id, a.name, a.tag, p.player_id FROM accounts a JOIN player_ids p ON p.account_id=a.id
        WHERE a.banned = 0 AND (a.name LIKE ? OR (a.name = ?) OR CAST(p.player_id AS TEXT) = ? OR (a.name || '#' || a.tag) = ?)
        ORDER BY a.last_seen DESC LIMIT 20`,
      '%' + q + '%', q, q, q
    );
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(',');
    const levels = new Map(), scores = new Map();
    if (ids.length) {
      for (const row of db.all(
        `SELECT account_id, level FROM saves WHERE mode = ? AND account_id IN (${marks})`, 'classic', ...ids
      )) levels.set(Number(row.account_id), Number(row.level) || 1);
      for (const row of db.all(
        `SELECT account_id, score FROM ratings WHERE season = ? AND account_id IN (${marks})`,
        settlement.weekKey(), ...ids
      )) scores.set(Number(row.account_id), Math.max(0, Number(row.score) || 0));
    }
    const results = rows.map((r) => ({
      accountId: Number(r.id), playerId: Number(r.player_id), name: String(r.name), tag: String(r.tag),
      display: String(r.name),
      level: levels.get(Number(r.id)) || 1,
      score: scores.get(Number(r.id)) || 0,
    }));
    return { ok: true, results };
  },


  friendMessages(ctx) {
    const toId = Number(ctx.query.accountId) || Number(ctx.account.id);
    const rows = db.all('SELECT * FROM friend_messages WHERE to_id = ? ORDER BY created_at DESC LIMIT 50', toId);
    const account = db.get('SELECT name, tag FROM accounts WHERE id = ?', toId);
    return {
      ok: true,
      owner: account ? { accountId: toId, name: String(account.name), tag: String(account.tag) } : null,
      messages: rows.map((r) => ({
        id: String(r.id), text: String(r.text), createdAt: Number(r.created_at),
        from: { accountId: Number(r.from_id), name: String(r.from_name) },
      })),
    };
  },

  leaveFriendMessage(ctx) {
    rateLimit('fmsg:' + ctx.account.id, 20, 60 * 1000);
    const toId = Number(ctx.body.toId) || 0;
    const text = String(ctx.body.text || '').slice(0, 200).trim();
    if (!toId) throw fail('BAD_REQUEST', '缺少收件人');
    if (!text) throw fail('BAD_REQUEST', '留言不能为空');
    if (toId === Number(ctx.account.id)) throw fail('BAD_REQUEST', '不能给自己留言');
    const target = db.get('SELECT id FROM accounts WHERE id = ?', toId);
    if (!target) throw fail('NOT_FOUND', '没有这个玩家');
    const friend = db.get('SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?', Number(ctx.account.id), toId);
    // 师徒也是社交关系：好友→拜师/收徒后名册只保留师徒行，留言入口不能因此 403。
    const kin = db.get(
      `SELECT 1 AS x FROM apprenticeships
        WHERE status = 'active' AND master_kind = 'account'
          AND ((master_id = ? AND prentice_id = ?) OR (master_id = ? AND prentice_id = ?))`,
      Number(ctx.account.id), toId, toId, Number(ctx.account.id)
    );
    if (!friend && !kin) throw fail('FORBIDDEN', '只能给好友或师徒留言');
    const meAccount = db.get('SELECT name FROM accounts WHERE id = ?', Number(ctx.account.id));
    db.tx(() => {
      db.run('INSERT INTO friend_messages (id, to_id, from_id, from_name, text, created_at) VALUES (?,?,?,?,?,?)',
        'fm_' + crypto.randomBytes(8).toString('base64url'), toId, Number(ctx.account.id), String(meAccount.name || ''), text, Date.now());
      db.run('INSERT INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
        'm_' + crypto.randomBytes(8).toString('base64url'), toId, 'friend_message', '【' + String(meAccount.name || '') + '】给你留言：' + text,
        JSON.stringify({ fromId: Number(ctx.account.id) }), Date.now());
    });
    return { ok: true };
  },


  rankAward(ctx) {
    return Object.assign({ ok: true }, settlement.rankAwardStatus(ctx.account.id));
  },

  claimRankAward(ctx) {
    const accountId = ctx.account.id;
    // 中途失败会留下「奖励记录已用、金杯没到」的死账（安全审计 R-12）。
    return db.tx(() => {
      const out = settlement.claimRankAward(accountId);
      if (!out.ok) {
        // 这是正常的业务结果（已领过 / 没进前 100），不是协议错误；带上 `error.msg`
        const code = out.already ? 'ALREADY_CLAIMED' : 'NOT_ELIGIBLE';
        return Object.assign({
          ok: false, msg: out.msg, already: !!out.already,
          error: { code, msg: out.msg },
        }, settlement.rankAwardStatus(accountId));
      }
      const saved = store.runOnSave(accountId, ({ api, save }) => {
        api.addGoldCup(out.cups);
        return save.goldCup;
      }, { snapshotSource: 'rank-award' });
      return {
        ok: true, msg: out.msg, cups: out.cups, rank: out.rank,
        rev: saved.rev, patch: saved.patch,
        award: settlement.rankAwardStatus(accountId),
      };
    });
  },
};
