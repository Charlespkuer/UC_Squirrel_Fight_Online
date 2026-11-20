'use strict';
// server/dev.js — 开发者测试账号登记册（只读判断）
// 没有 HTTP 路由、不接受客户端参数，所以「开发者身份」伪造不了。
// 1. 登录/档案接口把 `account.dev` 发给客户端，界面可以据此显示开发标识；

const db = require('./db');

function isDev(accountId) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    return !!db.get('SELECT 1 AS x FROM dev_accounts WHERE account_id = ?', id);
  } catch (_) {
    return false;
  }
}

function list() {
  try {
    return db.all('SELECT account_id, label, note, created_at FROM dev_accounts ORDER BY created_at DESC')
      .map((r) => ({ accountId: Number(r.account_id), label: String(r.label || ''), note: String(r.note || ''), createdAt: Number(r.created_at) }));
  } catch (_) {
    return [];
  }
}

module.exports = { isDev, list };
