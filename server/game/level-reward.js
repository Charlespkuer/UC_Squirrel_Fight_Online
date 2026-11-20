'use strict';
// 联机版升级奖励：每级静默发大体力药剂 + 上线前已升级部分的差额补偿邮件。
// 单级数量唯一真值在 `State.levelStaminaPotion`（js/state.js），这里不写第二份公式。

const db = require('../db');
const { rewardSuffix } = require('./mail-reward');

const POTION_ID = 2;
const POTION_NAME = '大体力药剂';
const BACKFILL_KEY = 'level-reward-potion-backfill:2026-11-17';
const MAIL_ID_PREFIX = 'servermail:level-reward-potion-2026-11-17:';
const MAIL_TITLE = '升级奖励优化，差额补偿';
const MAIL_TEXT = '升级奖励优化，差额补偿。';

function levelCap() {
  const cap = Number(globalThis.State && globalThis.State.MAX_PLAYER_LEVEL);
  return Number.isFinite(cap) && cap > 0 ? cap : 90;
}

function countAtLevel(level) {
  const State = globalThis.State;
  if (!State || typeof State.levelStaminaPotion !== 'function') throw Error('State.levelStaminaPotion 未加载');
  return Math.max(0, Math.floor(Number(State.levelStaminaPotion(level)) || 0));
}

// 从 2 级逐级累加，和 gainExp 实际发奖走同一个单级函数。
function totalThroughLevel(level) {
  const lv = Math.max(1, Math.min(levelCap(), Math.round(Number(level) || 1)));
  let total = 0;
  for (let i = 2; i <= lv; i++) total += countAtLevel(i);
  return total;
}

// 只在升级奖励上线的第一次启动跑一次（meta 标记 + 固定邮件 id 双重幂等）。
// 模拟账号是天梯人机，不发；封禁账号不发；已缺档账号跳过。
function backfill() {
  if (db.get('SELECT 1 AS hit FROM meta WHERE key = ?', BACKFILL_KEY)) {
    return { skipped: true, recipients: 0, bottles: 0 };
  }
  const rows = db.all(
    `SELECT s.account_id, s.level
       FROM saves s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.mode = 'classic' AND a.banned = 0
        AND NOT EXISTS (SELECT 1 FROM simulated_accounts x WHERE x.account_id = a.id)
      ORDER BY s.account_id`
  );
  const now = Date.now();
  let recipients = 0, bottles = 0;
  db.tx(() => {
    for (const row of rows) {
      const count = totalThroughLevel(row.level);
      if (!count) continue;
      const messageId = MAIL_ID_PREFIX + Number(row.account_id);
      const payload = { mailId: messageId, title: MAIL_TITLE, props: { [POTION_ID]: count }, claimable: true };
      const text = MAIL_TEXT + rewardSuffix(payload, [[POTION_ID, count, POTION_NAME]]);
      const res = db.run(
        'INSERT OR IGNORE INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
        messageId, Number(row.account_id), 'announcement', text, JSON.stringify(payload), now
      );
      if (Number((res && res.changes) || 0) > 0) {
        recipients++;
        bottles += count;
      }
    }
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', BACKFILL_KEY, String(now));
  });
  return { skipped: false, recipients, bottles };
}

module.exports = {
  POTION_ID, POTION_NAME, BACKFILL_KEY, MAIL_ID_PREFIX,
  countAtLevel, totalThroughLevel, backfill,
};
