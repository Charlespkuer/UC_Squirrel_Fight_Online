'use strict';
// server/game/visibility.js — 临时隐身账号
// 影响其他玩家看到的天梯榜/公开匹配/直连挑战候选；隐身账号自己的榜仍包含所有隐身账号
// （见 settlement.divisionRows 的 viewer 口径）。搜索、好友、师徒等社交关系不受隐身影响。
// `hidden_until` 到点自动失效，读路径一律用 hidden_until > now 判断，不需要定时任务。

const db = require('../db');

const MAX_DAYS = 365;

function nowMs(now) {
  const t = now == null ? Date.now() : Number(now);
  return Number.isFinite(t) ? t : Date.now();
}

function isHidden(accountId, now) {
  const id = Number(accountId) || 0;
  if (!id) return false;
  return !!db.get('SELECT 1 AS x FROM hidden_accounts WHERE account_id = ? AND hidden_until > ?', id, nowMs(now));
}

function hiddenUntil(accountId, now) {
  const id = Number(accountId) || 0;
  if (!id) return 0;
  const row = db.get('SELECT hidden_until FROM hidden_accounts WHERE account_id = ? AND hidden_until > ?', id, nowMs(now));
  return row ? Number(row.hidden_until) || 0 : 0;
}

function hiddenInfo(accountId, now) {
  const id = Number(accountId) || 0;
  if (!id) return null;
  const row = db.get('SELECT hidden_until, reason, created_at, updated_at FROM hidden_accounts WHERE account_id = ? AND hidden_until > ?', id, nowMs(now));
  if (!row) return null;
  return {
    accountId: id,
    until: Number(row.hidden_until) || 0,
    reason: String(row.reason || ''),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

// SQL 片段：`column` 必须是账号 id 列（如 `b.account_id` / `r.account_id`）。
// 调用方要把 `Date.now()` 作为紧邻的参数传入；返回片段只含一个 `?`。
function notHiddenSql(column) {
  const col = String(column || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(col)) {
    throw new Error('visibility.notHiddenSql: 非法列名 ' + col);
  }
  return 'NOT EXISTS (SELECT 1 FROM hidden_accounts h WHERE h.account_id = ' + col + ' AND h.hidden_until > ?)';
}

// 隐身账号自己看榜/候选时不做过滤（含所有隐身账号，可互相看到/匹配）；
// 非隐身视角才用 notHiddenSql。
function hiddenSqlFor(column, viewerHidden) {
  return viewerHidden ? '1=1' : notHiddenSql(column);
}
function hiddenParamsFor(viewerHidden, now) {
  return viewerHidden ? [] : [nowMs(now)];
}

function setHidden(accountIds, until, reason) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [accountIds]).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const expireAt = Math.floor(Number(until));
  if (!ids.length) throw new Error('没有有效的账号 ID');
  if (!Number.isSafeInteger(expireAt) || expireAt <= 0) throw new Error('hidden_until 必须是毫秒时间戳');
  const maxUntil = Date.now() + MAX_DAYS * 86400000;
  if (expireAt > maxUntil) throw new Error('隐身时长不能超过 ' + MAX_DAYS + ' 天');
  const text = String(reason || '').slice(0, 200);
  const stamp = Date.now();
  db.tx(() => {
    for (const id of ids) {
      db.run(
        `INSERT INTO hidden_accounts (account_id, hidden_until, reason, created_at, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           hidden_until = excluded.hidden_until,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
        id, expireAt, text, stamp, stamp
      );
    }
  });
  return ids.map((id) => Object.assign({ accountId: id }, hiddenInfo(id) || {}));
}

function clearHidden(accountIds) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [accountIds]).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return 0;
  let changed = 0;
  db.tx(() => {
    for (const id of ids) changed += Number(db.run('DELETE FROM hidden_accounts WHERE account_id = ?', id).changes) || 0;
  });
  return changed;
}

function listHidden(opts) {
  const o = opts || {};
  const includeExpired = o.includeExpired === true;
  const now = nowMs(o.now);
  return db.all(
    `SELECT h.account_id, h.hidden_until, h.reason, h.created_at, h.updated_at,
            a.name, a.tag, p.player_id, s.level
       FROM hidden_accounts h
       JOIN accounts a ON a.id = h.account_id
       LEFT JOIN player_ids p ON p.account_id = h.account_id
       LEFT JOIN saves s ON s.account_id = h.account_id AND s.mode = 'classic'
      WHERE (? = 1 OR h.hidden_until > ?)
      ORDER BY h.hidden_until DESC, h.account_id`,
    includeExpired ? 1 : 0, now
  ).map((row) => ({
    accountId: Number(row.account_id),
    playerId: Number(row.player_id) || 0,
    name: String(row.name || ''),
    tag: String(row.tag || ''),
    level: Number(row.level) || 1,
    until: Number(row.hidden_until) || 0,
    reason: String(row.reason || ''),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    active: (Number(row.hidden_until) || 0) > now,
  }));
}

module.exports = {
  isHidden, hiddenUntil, hiddenInfo, notHiddenSql, hiddenSqlFor, hiddenParamsFor,
  setHidden, clearHidden, listHidden,
};
