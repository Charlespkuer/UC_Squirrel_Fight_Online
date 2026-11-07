'use strict';
/* ============================================================
 * server/api/social.js — 消息 / 好友 / 留言板 / 师徒
 * ============================================================ */

const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../auth');
const store = require('../game/store');
const snapshots = require('../game/snapshot');
const settlement = require('../game/settlement');
const fight = require('../game/fight');
const serverMail = require('../game/server-mail');
const { fail, rateLimit, clientIp } = require('../http');
const { config } = require('../config');

/* 奖励邮件（全服公告 / `server/game/server-mail.js` 的模板邮件）：奖励是「领取才入账」，
 * 与旧的「发放即到账」公告区分。只认服务端自己写进 messages.payload 的 claimable 标记；
 * 老公告没有这个标记，不会因为新版领取接口上线而被重复发一次。 */
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

function messageRow(row, accountId) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
  /* 天梯复仇只认“被抢方 + 当天 + 原战报”：由服务端算 eligibility，客户端不再自己
   * 从本地 battleHistory 猜。每条 rank 消息多查一次原战斗，50 条上限下开销可接受。 */
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
    read: !!row.read_at,
    createdAt: Number(row.created_at),
  };
}

function friendRow(row) {
  const last = db.get('SELECT last_seen FROM accounts WHERE id = ?', Number(row.friend_id));
  const snap = snapshots.currentSnapshotMeta(row.friend_id, 'classic');
  const save = db.get('SELECT level, name FROM saves WHERE account_id = ? AND mode = ?', Number(row.friend_id), 'classic');
  const rating = settlement.scoreOf(row.friend_id);
  return {
    accountId: Number(row.friend_id),
    name: String(row.name || (save && save.name) || ''),
    tag: String(row.tag || ''),
    display: String(row.name || ''),
    level: save ? Number(save.level) : (snap ? snap.level : 1),
    score: rating,
    lastSeen: last ? Number(last.last_seen) : 0,
    snapshotId: snap ? snap.id : '',
    online: last ? (Date.now() - Number(last.last_seen) < 5 * 60 * 1000) : false,
  };
}

/** 一条好友申请 → 原版 `messages.do?type=3` 的字段（messageId / name / playerId / level）。 */
function friendRequestRow(row) {
  const prof = publicFrom(row.from_id) || { accountId: Number(row.from_id), playerId: 0, name: '', tag: '', display: '' };
  const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', Number(row.from_id), 'classic');
  return {
    messageId: String(row.id),
    accountId: Number(row.from_id),
    playerId: prof.playerId,
    name: prof.name,
    tag: prof.tag,
    display: prof.display,
    level: save ? Number(save.level) : 1,
    createdAt: Number(row.created_at),
  };
}

/** 把 `targetId` 作为好友写进 `ownerId` 的存档（经典挑战页/离线分支读这一份）。 */
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

/** 接受一条申请：双向 `friendships` + 两边存档好友列表 + 清掉两个方向的 pending。 */
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

module.exports = {
  /* ---------------- 消息 ---------------- */
  messages(ctx) {
    const me = Number(ctx.account.id);
    /* 模板奖励邮件（开服奖励等）在这里补投：等级已到 → 写一封待领取邮件。
     * 打开消息页就是玩家「能看到邮件」的那一刻，所以投递放在查询之前；
     * 投递幂等（固定 id），失败也不影响消息列表。 */
    try {
      const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', me, store.MODE);
      if (save) serverMail.deliver(me, save.level);
    } catch (e) { console.warn('[server-mail] 投递失败：' + ((e && e.message) || e)); }
    const since = Number(ctx.query.since) || 0;
    const limit = Math.max(1, Math.min(50, Number(ctx.query.limit) || 20));
    const rows = since > 0
      ? db.all('SELECT * FROM messages WHERE account_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?', me, since, limit)
      : db.all('SELECT * FROM messages WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', me, limit);
    const unread = db.get('SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND read_at IS NULL', me);
    return { ok: true, messages: rows.map(row => messageRow(row, me)), unread: Number(unread.c || 0), serverTime: Date.now() };
  },

  /** 主界面「消息」NEW 红点：只统计**被动到达且还没看过**的东西。
   *  · 消息：`messages.read_at IS NULL`（玩家自己在战斗里产生的记录不写 messages，
   *    所以主动挑战不会点亮红点）；
   *  · 好友验证：`friend_requests` 没有 read 标记，用 `notice_seen.requests_seen_at`
   *    记录「上一次打开消息页时已经看到哪」，只算之后新到的申请。
   *  返回 total 给 `SfUiMain.hasNewMessages()`，客户端每 15 秒轮询一次。 */
  badge(ctx) {
    const me = Number(ctx.account.id);
    /* 和 `/api/messages` 一样顺手补投模板奖励邮件：等级刚到的玩家不用等下一次 /api/state
     * 就能在 15 秒内看到红点。投递幂等，失败不影响计数。 */
    try {
      const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', me, store.MODE);
      if (save) serverMail.deliver(me, save.level);
    } catch (e) { console.warn('[server-mail] 投递失败：' + ((e && e.message) || e)); }
    const seen = db.get('SELECT requests_seen_at FROM notice_seen WHERE account_id = ?', me);
    const requestsSeenAt = Math.max(0, Number(seen && seen.requests_seen_at) || 0);
    /* 留言（friend_message）有独立的 leaveNew 红点；登录安全提醒（login_alert）
     * 有登录弹窗自己负责。两者都不混进主界面 NEW，避免同一个事件提示两遍。 */
    const unread = Number(db.get(
      "SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND read_at IS NULL AND kind NOT IN ('friend_message','login_alert')",
      me
    ).c || 0);
    const requests = Number(db.get('SELECT COUNT(*) AS c FROM friend_requests WHERE to_id = ? AND created_at > ?', me, requestsSeenAt).c || 0);
    return { ok: true, unread, requests, total: unread + requests, serverTime: Date.now() };
  },

  /** 打开消息页时调用：把已到达的普通消息标为已读，并记下好友验证看到哪。
   *  留言不动（它的未读状态由留言 tab 自己按 id 标记），否则 `leaveNew` 会一起熄灭。 */
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
    return { ok: true, unread: 0, requests: 0, total: 0, seenAt: ts };
  },

  readMessages(ctx) {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 200).map(String) : [];
    const before = Number(ctx.body.before) || 0;
    const ts = Date.now();
    if (ids.length) {
      for (const id of ids) {
        db.run('UPDATE messages SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL', ts, String(id), Number(ctx.account.id));
      }
    } else if (before > 0) {
      db.run('UPDATE messages SET read_at = ? WHERE account_id = ? AND created_at <= ? AND read_at IS NULL', ts, Number(ctx.account.id), before);
    } else {
      db.run('UPDATE messages SET read_at = ? WHERE account_id = ? AND read_at IS NULL', ts, Number(ctx.account.id));
    }
    return { ok: true };
  },

  /** 领取奖励邮件（`POST /api/messages/claim`）：同一封邮件只能成功入账一次。
   *  可领取类型 = 老的全服公告 + `server/game/server-mail.js` 模板声明的类型；
   *  模板邮件的 `payload.minLevel` 在这里再校验一次（没解锁消息功能前不许领）。
   *  老公告（payload 没有 claimable）返回 already，不发奖；新邮件在事务里
   *  「发奖 + 把 claimedAt 写回 payload」一起提交。 */
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
        if (rewards.gold) api.addGold(rewards.gold, { count: false });
        if (rewards.cup) save.goldCup = Math.max(0, Number(save.goldCup) || 0) + rewards.cup;
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

  /* ---------------- 好友 ---------------- */
  friends(ctx) {
    const rows = db.all(
      `SELECT f.friend_id, a.name, a.tag FROM friendships f JOIN accounts a ON a.id = f.friend_id
       WHERE f.account_id = ? ORDER BY f.created_at DESC`,
      Number(ctx.account.id)
    );
    const list = rows.map(friendRow);
    const aiRows = db.all('SELECT id,fighter,created_at FROM ai_friends WHERE account_id=? ORDER BY created_at DESC,id DESC', Number(ctx.account.id));
    /* 和 `/api/opponents` 同一个理由：列表里直接带战斗体，客户端不必每个好友再跑一次
     * `/api/fighter`（好友多的时候那是 N 次**串行**往返，Net 是全局串行队列）。
     * 预算是 `config.friendLimit`（50）：好友页一次请求就能翻完所有页。
     * ⚠ 再往上放（原版抓包 142 人）不能继续整包下发，要先把好友页改成分页/懒加载。 */
    const fighterFromSnapshot = require('../game/fighter').fighterFromSnapshot;
    const withFighter = String(ctx.query.withFighter || '1') !== '0';
    if (withFighter) {
      let budget = config.friendLimit;
      for (const item of list) {
        if (budget <= 0) break;
        if (!item.snapshotId) continue;
        const snap = snapshots.snapshotById(item.snapshotId);
        if (!snap || !snap.fighter) continue;
        item.fighter = fighterFromSnapshot(snap.fighter);
        item.hp = item.fighter.maxHp || item.fighter.hp;
        budget--;
      }
    }
    for (const row of aiRows) {
      const fighter = JSON.parse(row.fighter);
      list.push({ snapshotId: String(row.id), source: 'bot', bot: true, player: false, name: fighter.name,
        level: fighter.level, display: fighter.name + ' AI', fighter, createdAt: Number(row.created_at) });
    }
    return {
      ok: true, friends: list, limit: config.friendLimit, aiCount: aiRows.length, aiLimit: 10,
      /* 消息页「验证消息」红点（原版 `newMsgType.hasNewValidateMessage`）：没有单独的推送，
       * 客户端每次打开消息页/好友页时读这个数。 */
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

  /** 发送好友申请（原版 `addFriend.do?isFind=false`）：**只写申请，不写好友关系**。 */
  addFriend(ctx) {
    rateLimit('friend:' + ctx.account.id, 30, 60 * 1000);
    const me = Number(ctx.account.id);
    const internalId = Number(ctx.body.accountId) || 0;
    const target = internalId ? db.get('SELECT * FROM accounts WHERE id=?', internalId) : auth.findAccountStrict(ctx.body.target);
    if (!target) throw fail('NOT_FOUND', '找不到这个玩家（可写昵称或玩家 ID）');
    if (Number(target.id) === me) throw fail('BAD_REQUEST', '不能加自己');
    /* 已经是好友：原版服务端也会直接回成功；这里给 `already` 让客户端换文案。 */
    if (db.get('SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?', me, Number(target.id)))
      return { ok: true, already: true, friend: publicFrom(target.id), message: '你们已经是好友。' };
    if (Number(db.get('SELECT COUNT(*) AS c FROM friendships WHERE account_id = ?', me).c) >= config.friendLimit)
      throw fail('CONFLICT', '好友已满（' + config.friendLimit + ' 个）');
    /* 对方也申请过我 = 双方都同意 → 直接接受（等价于先到的那条申请被验证通过）。 */
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

  /** 我收到的待验证好友申请（原版 `messages.do?type=3`；红点用 `friends.requestCount`）。 */
  friendRequests(ctx) {
    const rows = db.all('SELECT * FROM friend_requests WHERE to_id = ? ORDER BY created_at DESC LIMIT 50', Number(ctx.account.id));
    return { ok: true, requests: rows.map(friendRequestRow), count: rows.length };
  },

  /** 同意 / 拒绝一条好友申请（原版 `validateFriend.do?messageId=&accept=`）。 */
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
      /* 删好友连两边还没处理的申请一起清掉，避免请求列表里残留“已经是好友”的条目。 */
      db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
        me, Number(target.id), Number(target.id), me);
      store.runOnSave(me, ({ api }) => { api.removeFriend(String(target.name)); });
    });
    return { ok: true };
  },

  /** 按昵称、玩家 ID 或旧格式“名字#编号”搜索玩家。 */
  search(ctx) {
    const q = String(ctx.query.q || '').trim();
    if (!q) return { ok: true, results: [] };
    const rows = db.all(
      "SELECT a.id, a.name, a.tag, p.player_id FROM accounts a JOIN player_ids p ON p.account_id=a.id WHERE a.banned = 0 AND (a.name LIKE ? OR (a.name = ?) OR CAST(p.player_id AS TEXT) = ? OR (a.name || '#' || a.tag) = ?) ORDER BY a.last_seen DESC LIMIT 20",
      '%' + q + '%', q, q, q
    );
    const results = rows.map((r) => {
      const save = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', Number(r.id), 'classic');
      const rating = settlement.scoreOf(r.id);
      return {
        accountId: Number(r.id), playerId: Number(r.player_id), name: String(r.name), tag: String(r.tag),
        display: String(r.name),
        level: save ? Number(save.level) : 1,
        score: rating,
      };
    });
    return { ok: true, results };
  },

  /* ---------------- 留言板 ---------------- */
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
    if (!friend) throw fail('FORBIDDEN', '只能给好友留言');
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

  /* ---------------- 天梯周奖励 ---------------- */
  rankAward(ctx) {
    return Object.assign({ ok: true }, settlement.rankAwardStatus(ctx.account.id));
  },

  claimRankAward(ctx) {
    const accountId = ctx.account.id;
    /* 领取记录与金杯必须在同一个事务里：以前先插 `rank_awards` 再单独 runOnSave，
     * 中途失败会留下「奖励记录已用、金杯没到」的死账（安全审计 R-12）。 */
    return db.tx(() => {
      const out = settlement.claimRankAward(accountId);
      if (!out.ok) {
        /* 这是正常的业务结果（已领过 / 没进前 100），不是协议错误；带上 `error.msg`
         * 让所有客户端（包括只认 error.msg 的旧版）显示服务端文案，而不是
         * 「请求失败（HTTP 200）」。 */
        const code = out.already ? 'ALREADY_CLAIMED' : 'NOT_ELIGIBLE';
        return Object.assign({
          ok: false, msg: out.msg, already: !!out.already,
          error: { code, msg: out.msg },
        }, settlement.rankAwardStatus(accountId));
      }
      const saved = store.runOnSave(accountId, ({ save }) => {
        save.goldCup = Math.max(0, Number(save.goldCup) || 0) + out.cups;
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
