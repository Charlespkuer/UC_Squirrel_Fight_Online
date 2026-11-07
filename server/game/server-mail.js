'use strict';
/* ============================================================
 * server/game/server-mail.js — 开发者定义的服务端奖励邮件（按等级自动投递）
 * ------------------------------------------------------------
 * 用途：开服奖励、版本福利这类「每个玩家各发一封」的奖励邮件。
 * 开发者只改下面的 TEMPLATES；投递、幂等、领取入账都由服务端处理。
 *
 * ⚠ **默认停用**：模板必须显式写 `enabled: true` 才会投递，新建模板时先写 `false`
 *   （或者干脆不写）—— 写完、确认文案与奖励无误，再把那个模板打开重新部署。
 *   停用期间不会有任何邮件写入；已经发出去的那封（如果有人领了/没领）不受影响，
 *   仍然可以正常打开和领取（领取白名单不按 enabled 过滤）。
 *
 * 投递时机：账号等级达到模板的 `minLevel` 之后，下一次
 * `GET /api/state`（登录 / 断线重连拉整档）或 `GET /api/messages`（打开消息页）
 * 会把邮件写进 `messages` 表。所以「2 级解锁消息功能后都能看到开服奖励」
 * 不需要任何人工操作 —— 经典界面 2 级才出现「消息」键，见
 * `js/ssfight/ui-main.js` 里 constructMainMenu 的 bits。
 *
 * 口径（和 `server/admin-broadcast.js` 的全服公告同一套「领取才入账」）：
 *   · 只写**待领取**的邮件，不碰存档；玩家在消息页点开 →「领取」→
 *     `POST /api/messages/claim` 才入账，同一封只能领一次（payload.claimedAt）；
 *   · 邮件 id 固定 `servermail:<模板id>:<账号id>`：重复投递不会写第二条，
 *     所以「什么时候投递」「投递几次」都不影响幂等；
 *   · 换一个模板 `id` 就是一次**新的发放**（每个账号会收到新 id 的那一封）。
 *
 * 与 admin-broadcast 的分工：
 *   · admin-broadcast = 本机 CLI，一次性给**当时所有账号**发公告（有 admin_broadcasts 台账）；
 *   · 本文件 = 常驻规则，**每个达到等级的账号各发一份**，之后注册的账号也会自动收到。
 * ========================================================== */

const db = require('../db');
const { propEntriesOf, rewardSuffix } = require('./mail-reward');

/* ============================================================
 * 模板（改这里）
 * ------------------------------------------------------------
 * 字段：
 *   id        必填，稳定编号（3–60 位字母/数字/下划线/连字符）；换编号 = 新的一轮发放
 *   enabled   必填项，**只认显式的 `true`**；写 false / 不写 = 停用，一封都不发
 *   kind      必填，邮件类型（小写字母开头，3–31 位）；领取接口按它判断「是不是奖励邮件」
 *   minLevel  达到这个等级才投递（1–90）；开服奖励用 2 = 消息功能解锁
 *   title     奖励弹窗标题（≤ 20 字）
 *   text      正文（1–200 字）；「（可领取：…）」由服务端自动追加
 *   gold/cup  金松果 / 金杯，可省略
 *   props     { 道具id: 数量 }，可省略；8/15/40 是货币道具，必须用 gold / cup
 *   registeredAfter  可选时间戳（ms）：只发给这之后注册的账号；不填 = 所有账号
 * ========================================================== */
const TEMPLATES = Object.freeze([
  {
    id: 'open-server-2026-11',
    /* ⚠ 激活开关：**现在是关闭的**。确认文案/奖励无误、准备正式发放时改成 true 再部署；
     * 想撤回就改回 false（已发出去的邮件仍可领取，不会回收）。 */
    enabled: false,
    kind: 'welcome',
    minLevel: 2,
    title: '开服奖励邮件',
    text: '【开服奖励】欢迎来到松鼠大战，这份礼包送给每一位新玩家。',
    gold: 300,
    props: { 23: 3, 2: 3 },
    /* 只想发给「某个时间之后注册」的账号时打开这一行（默认所有账号各一封）：
     * registeredAfter: Date.parse('2026-11-06T00:00:00+08:00'), */
  },
]);

/** 领取接口允许的邮件类型：老的全服公告 + 模板声明的类型。 */
const CLAIMABLE_KINDS = new Set(['announcement']);
for (const tpl of TEMPLATES) {
  const kind = String((tpl && tpl.kind) || '');
  if (kind) CLAIMABLE_KINDS.add(kind);
}

const MAX_LEVEL = 90;

/** 校验一份模板；道具名要 `propMap`（runtime.boot 之后才有），所以只在运行期调用。 */
function prepare(tpl) {
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) throw Error('模板必须是对象');
  const id = String(tpl.id || '');
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(id)) throw Error('id 必须是 3–60 位字母、数字、下划线或连字符');
  const kind = String(tpl.kind || '');
  if (!/^[a-z][a-z0-9_]{2,30}$/.test(kind)) throw Error('kind 必须是 3–31 位小写字母、数字或下划线');
  const minLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(tpl.minLevel) || 1)));
  /* 只认显式 true：新建模板忘记写开关时宁可不发，也不要在部署那一刻把奖励泼出去。 */
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

/** 已校验的模板表（缓存一次；道具表没加载时不缓存，避免把「暂时失败」记成永久失败）。 */
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

/** 重新读取模板（改了 `TEMPLATES` / 开关后让缓存生效；正常运行时模板是静态常量，不必调用）。 */
function reload() { prepared = null; return templateList(); }

/**
 * 给一个账号补投所有「已启用且等级已到」的模板邮件（幂等）。
 * @param {number} accountId
 * @param {number} level 当前等级（调用方已从存档/存档行读到，省一次查询）
 * @returns {number} 本次新写入的邮件条数
 */
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
    /* 先查后写：`/api/state` 是热点，已投递时只走一次主键读，不制造写事务。 */
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
