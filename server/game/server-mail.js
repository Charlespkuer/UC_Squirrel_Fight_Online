'use strict';
// server/game/server-mail.js — 开发者定义的服务端奖励邮件（按等级自动投递）
// 开发者只改下面的 TEMPLATES；投递、幂等、领取入账都由服务端处理。
// ⚠ 默认停用：模板必须显式写 `enabled: true` 才会投递，新建模板时先写 `false`

const db = require('../db');
const { propEntriesOf, rewardSuffix } = require('./mail-reward');

// 模板（改这里）
// 字段：
// kind      必填，邮件类型（小写字母开头，3–31 位）；领取接口按它判断「是不是奖励邮件」
const TEMPLATES = Object.freeze([
  {
    id: 'open-server-2026-11',
    // ⚠ 激活开关：现在是关闭的。确认文案/奖励无误、准备正式发放时改成 true 再部署；
    enabled: false,
    kind: 'welcome',
    minLevel: 2,
    title: '开服奖励邮件',
    text: '【开服奖励】欢迎来到松鼠大战，这份礼包送给每一位新玩家。',
    gold: 300,
    props: { 23: 3, 2: 3 },

  },
  {
    id: 'open-celebration-2026-11-17',
    // 2 级解锁消息后自动投递：500 金松果 + 大体力药剂×10 + 超级经验丸×5 +
    // 超级大力丸/敏捷丸/速度丸各×3 + 征战令×3 + 挑战书/英雄帖/勇气徽章/召唤证各×3。
    enabled: true,
    kind: 'opening_gift',
    minLevel: 2,
    title: '庆祝联机版开服',
    text: '【开服庆祝】感谢每一位玩家！联机版正式开服，这份礼包送给达到 2 级的你。',
    gold: 500,
    props: { 2: 10, 23: 3, 36: 3, 39: 3, 41: 3, 42: 3, 43: 3, 44: 5, 82: 3, 87: 3 },
  },
]);

// 领取接口允许的邮件类型：老的全服公告 + 模板声明的类型。
const CLAIMABLE_KINDS = new Set(['announcement']);
for (const tpl of TEMPLATES) {
  const kind = String((tpl && tpl.kind) || '');
  if (kind) CLAIMABLE_KINDS.add(kind);
}

const MAX_LEVEL = 90;

// 校验一份模板；道具名要 `propMap`（runtime.boot 之后才有），所以只在运行期调用。
function prepare(tpl) {
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw Error('模板必须是对象');
  const id = String(tpl.id || '');
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(id)) throw Error('id 必须是 3–60 位字母、数字、下划线或连字符');
  const kind = String(tpl.kind || '');
  if (!/^[a-z][a-z0-9_]{2,30}$/.test(kind)) throw Error('kind 必须是 3–31 位小写字母、数字或下划线');
  const minLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(tpl.minLevel) || 1)));
  // 只认显式 true：新建模板忘记写开关时宁可不发，也不要在部署那一刻把奖励泼出去。
  const enabled = tpl.enabled === true;
  const title = String(tpl.title || '奖励邮件').slice(0, 20);
  const text = String(tpl.text || '').trim();
  if (!text || text.length > 200) throw Error('text 须为 1–200 字');
  const gold = tpl.gold === undefined ? 0 : tpl.gold;
  const cup = tpl.cup === undefined ? 0 : tpl.cup;
  if (!Number.isSafeInteger(gold) || gold < 0 || gold > 100000) throw Error('gold 须为 0–100000 的整数');
  if (!Number.isSafeInteger(cup) || cup < 0 || cup > 100000) throw Error('cup 须为 0–100000 的整数');
  const registeredAfter = Number(tpl.registeredAfter) || 0;
  const entries = propEntriesOf(tpl);
  const rewards = { gold, cup };
  if (entries.length) rewards.props = Object.fromEntries(entries.map(([pid, count]) => [pid, count]));
  const payload = Object.assign({ mailId: id, title, minLevel }, rewards, { claimable: true });
  return {
    id, enabled, kind, minLevel, registeredAfter, payload,
    message: text + rewardSuffix(rewards, entries),
  };
}

let prepared = null;

// 已校验的模板表（缓存一次；道具表没加载时不缓存，避免把「暂时失败」记成永久失败）。
function templateList() {
  if (prepared) return prepared;
  if (!globalThis.propMap) return [];
  const out = [];
  for (const tpl of TEMPLATES) {
    try {
      const item = prepare(tpl);
      if (out.some((o) => o.id === item.id)) throw Error('id 与前面的模板重复');
      out.push(item);
    } catch (e) { console.warn('[server-mail] 模板 ' + ((tpl && tpl.id) || '?') + ' 跳过：' + e.message); }
  }
  prepared = out;
  return prepared;
}

// 重新读取模板（改了 `TEMPLATES` / 开关后让缓存生效；正常运行时模板是静态常量，不必调用）。
function reload() { prepared = null; return templateList(); }

// 给一个账号补投所有「已启用且等级已到」的模板邮件（幂等）。
// @param {number} level 当前等级（调用方已从存档/存档行读到，省一次查询）
function deliver(accountId, level) {
  const list = templateList();
  if (!list.length) return 0;
  const id = Number(accountId);
  const lv = Math.max(1, Math.round(Number(level) || 0));
  if (!Number.isSafeInteger(id) || id <= 0) return 0;
  const due = list.filter((tpl) => tpl.enabled && lv >= tpl.minLevel);
  if (!due.length) return 0;
  let account = null, inserted = 0;
  for (const tpl of due) {
    if (tpl.registeredAfter) {
      if (!account) account = db.get('SELECT created_at FROM accounts WHERE id = ?', id) || {};
      if (Number(account.created_at) < tpl.registeredAfter) continue;
    }
    const messageId = 'servermail:' + tpl.id + ':' + id;

    if (db.get('SELECT 1 AS hit FROM messages WHERE id = ?', messageId)) continue;
    const res = db.run(
      'INSERT OR IGNORE INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
      messageId, id, tpl.kind, tpl.message, JSON.stringify(tpl.payload), Date.now()
    );
    inserted += Number((res && res.changes) || 0);
  }
  return inserted;
}

module.exports = { TEMPLATES, CLAIMABLE_KINDS, templateList, reload, deliver };
