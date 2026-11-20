'use strict';
// 超级松鼠（原版 VIP）的实时等级：名单/战斗体只认账号存档，战斗快照里没有也不该有这一项。
const db = require('../db');

const MAX_LEVEL = 10;

function levelAt(level, until, now) {
  const lv = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(level) || 0)));
  return lv > 0 && Number(until) > (Number(now) || Date.now()) ? lv : 0;
}

function levelOf(accountId, now) {
  const row = db.get(
    'SELECT vip_level, vip_until FROM saves WHERE account_id = ? AND mode = ?',
    Number(accountId), 'classic'
  );
  return row ? levelAt(row.vip_level, row.vip_until, now) : 0;
}

module.exports = { MAX_LEVEL, levelAt, levelOf };
