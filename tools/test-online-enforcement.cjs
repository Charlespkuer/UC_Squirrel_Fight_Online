'use strict';
/* 反作弊分级：警告 → 观察期 → 账号 / IP 封禁的纯数据库契约。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const OUT = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_enforcement-'));
process.env.DATA_DIR = DATA;
process.env.GAME_ROOT = path.resolve(__dirname, '..');

const db = require('../server/db');
db.open({ dir: DATA });
const enforcement = require('../server/game/enforcement');

function cleanup() {
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

try {
  const now = Date.now();
  db.run(`INSERT INTO accounts(name,tag,pass_hash,pass_salt,recovery_hash,created_at,last_seen,ip)
          VALUES (?,?,?,?,?,?,?,?)`, 'QA-ENF', '1', 'h', 's', 'r', now, now, '203.0.113.9');

  const base = enforcement.health();
  assert.equal(base.enabled, true);
  assert.equal(base.warned, 0);
  assert.equal(base.banned, 0);
  assert.equal(base.bannedIps, 0);

  const warned = enforcement.warnAccount(1, 6, ['测试风险'], { ua: 'HeadlessChrome' });
  assert.equal(warned.status, 'warned');
  assert.equal(warned.score, 6);
  assert.deepEqual(warned.reasons, ['测试风险']);
  assert.equal(enforcement.statusFor(1).status, 'warned');
  assert.equal(enforcement.alerts(1)[0].status, 'warned');
  assert.equal(enforcement.health().warned, 1);

  assert.equal(enforcement.ipBanFor('203.0.113.9'), null);
  db.run(`INSERT INTO banned_ips(ip,until,reason,account_id,created_at) VALUES (?,?,?,?,?)`,
    '203.0.113.9', now + 3600000, '自动化脚本', 1, now);
  const ban = enforcement.ipBanFor('203.0.113.9');
  assert.equal(ban.status, 'banned');
  assert.equal(ban.reason, '自动化脚本');
  assert.equal(enforcement.banExtra(ban).ban.qq, enforcement.QQ_GROUP);
  assert.equal(enforcement.health().bannedIps, 1);

  console.log('PASS enforcement warn / observe / IP ban / health');
} finally {
  cleanup();
}
