'use strict';
/* ============================================================
 * server/dev.js — 开发者测试账号登记册（只读判断）
 * ------------------------------------------------------------
 * 这张表只由本机管理脚本（tools/seed-test-account.cjs）写入：
 * 没有 HTTP 路由、不接受客户端参数，所以「开发者身份」伪造不了。
 *
 * 用途有两个：
 *   1. 登录/档案接口把 `account.dev` 发给客户端，界面可以据此显示开发标识；
 *   2. 审计工具（server/admin-audit.js）把人名列出来，避免把测试账号的
 *      异常成长当成作弊数据去复核。
 * ============================================================ */

const db = require('./db');

/** 账号是否登记为开发者测试账号。表不存在时一律 false（旧库也能跑）。 */
function isDev(accountId) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    return !!db.get('SELECT 1 AS x FROM dev_accounts WHERE account_id = ?', id);
  } catch (_) {
    return false;
  }
}

/** 登记册内容（审计用）。 */
function list() {
  try {
    return db.all('SELECT account_id, label, note, created_at FROM dev_accounts ORDER BY created_at DESC')
      .map((r) => ({ accountId: Number(r.account_id), label: String(r.label || ''), note: String(r.note || ''), createdAt: Number(r.created_at) }));
  } catch (_) {
    return [];
  }
}

module.exports = { isDev, list };
