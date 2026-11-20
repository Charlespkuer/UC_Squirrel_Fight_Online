#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { config } = require('./config');
const db = require('./db');
const runtime = require('./game/runtime');
const { propEntriesOf, rewardSuffix } = require('./game/mail-reward');

// 全服奖励邮件（本机 CLI）：只写待领取的邮件，不直接改存档。
// 奖励字段的校验与正文后缀在 `server/game/mail-reward.js`（与按等级自动投递的
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('需要 JSON 对象');
  const id = String(input.id || '');
  const text = String(input.text || '').trim();
  const gold = input.gold === undefined ? 0 : input.gold;
  const cup = input.cup === undefined ? 0 : input.cup;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw Error('id 必须是 8–80 位字母、数字、下划线或连字符');
  if (!text || text.length > 200) throw Error('通知文字须为 1–200 字');
  if (!Number.isSafeInteger(gold) || gold < 0 || gold > 100000) throw Error('gold 须为 0–100000 的整数');
  if (!Number.isSafeInteger(cup) || cup < 0 || cup > 100000) throw Error('cup 须为 0–100000 的整数');
  const entries = propEntriesOf(input);
  // 老的金松果公告 payload 保持 {id,text,gold} 的字段顺序和形状：
  const payload = { id, text, gold };
  if (cup) payload.cup = cup;
  if (entries.length) payload.props = Object.fromEntries(entries.map(([pid, count]) => [pid, count]));
  return { payload, entries };
}

function broadcast(input) {
  const { payload, entries } = validate(input), encoded = JSON.stringify(payload);
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  return db.tx(() => {
    const existing = db.get('SELECT digest,recipients FROM admin_broadcasts WHERE id=?', payload.id);
    if (existing) {
      if (existing.digest !== digest) throw Error('此 id 已用于不同内容，拒绝重复发放');
      return { duplicate: true, recipients: Number(existing.recipients) };
    }
    const recipients = db.all("SELECT a.id FROM accounts a JOIN saves s ON s.account_id=a.id AND s.mode='classic' WHERE a.banned=0 ORDER BY a.id");
    const now = Date.now();
    db.run('INSERT INTO admin_broadcasts(id,digest,created_at,recipients,payload) VALUES(?,?,?,?,?)', payload.id, digest, now, recipients.length, encoded);
    const claimable = !!(payload.gold || payload.cup || entries.length);
    for (const row of recipients) {
      const accountId = Number(row.id);
      // 只写邮件，不碰存档：等玩家在消息页点开并确认「领取」再入账。
      const messageId = 'broadcast:' + payload.id + ':' + accountId;
      const message = '【全服公告】' + payload.text + rewardSuffix(payload, entries);
      const messagePayload = { broadcastId: payload.id, gold: payload.gold };
      if (payload.cup) messagePayload.cup = payload.cup;
      if (entries.length) messagePayload.props = payload.props;
      if (claimable) messagePayload.claimable = true;
      db.run('INSERT INTO messages(id,account_id,kind,text,payload,created_at) VALUES(?,?,?,?,?,?)', messageId, accountId, 'announcement', message, JSON.stringify(messagePayload), now);
    }
    return { duplicate: false, recipients: recipients.length };
  });
}

function main() {
  if (process.argv.length !== 3) throw Error('用法：node server/admin-broadcast.js 公告.json；字段 id、text、gold / cup / props（可选）');
  const file = path.join(config.dataDir, 'ssdz.db');
  if (!fs.existsSync(file)) throw Error('未找到现有数据库：' + file);
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  runtime.boot(); db.open();
  try { console.log(JSON.stringify(broadcast(input))); } finally { db.close(); }
}
if (require.main === module) { try { main(); } catch (e) { console.error('[admin-broadcast] ' + e.message); process.exitCode = 1; } }
module.exports = { validate, broadcast };

