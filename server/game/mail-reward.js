'use strict';
/* ============================================================
 * server/game/mail-reward.js — 奖励邮件的奖励口径（服务端共用）
 * ------------------------------------------------------------
 * 两个发信入口共用这一份，避免「正文后缀」各写一套后和客户端对不上：
 *   · `server/admin-broadcast.js`  —— 本机 CLI，一次性发给当时所有账号的公告；
 *   · `server/game/server-mail.js` —— 常驻模板，按等级给每个账号自动发一封。
 *
 * 口径（与 `js/state.js` 一致）：
 *   · `gold` = 金松果（`goldPoint`），`cup` = 金杯（`goldCup`），都可省略或设为 0；
 *   · `props` = { 道具id: 数量 }，数量 1–PROP_HARD_CAP；8/15/40 是货币/经验道具，
 *     必须走上面前两个字段，不能写进 props；
 *   · 正文后缀 `（可领取：金松果 300、挑战书 ×3）` 是**客户端契约**：
 *     `js/ssfight/ui-message.js` 的奖励弹窗按这个格式剥掉后缀、领取后替换成「已领取」。
 *     改这个格式要连客户端一起改。
 * ========================================================== */

const PROP_HARD_CAP = 9999;   // 与 js/state.js 的 PROP_HARD_CAP 一致
const CURRENCY_PROP = Object.freeze({ 8: 'gold', 15: 'exp', 40: 'cup' });

/** 道具奖励 → [[id, count, name], ...]，按 id 排序保证 digest / 文案稳定。 */
function propEntriesOf(input) {
  const props = input && input.props;
  if (props == null) return [];
  if (typeof props !== 'object' || Array.isArray(props)) throw Error('props 必须是 {"道具id": 数量} 对象');
  const map = globalThis.propMap;
  if (!map || typeof map.getValue !== 'function') throw Error('道具表未加载（先 runtime.boot）');
  const out = [];
  for (const key of Object.keys(props)) {
    const id = Number(key), count = props[key];
    if (!Number.isSafeInteger(id) || id <= 0) throw Error('道具 id 必须是正整数：' + key);
    if (!Number.isSafeInteger(count) || count < 1 || count > PROP_HARD_CAP) throw Error('道具数量须为 1–' + PROP_HARD_CAP + ' 的整数：' + key);
    if (CURRENCY_PROP[id]) throw Error('道具 ' + id + ' 是货币/经验，请改用 ' + CURRENCY_PROP[id] + ' 字段');
    const def = map.getValue(id);
    if (!def) throw Error('未知道具 id：' + id);
    out.push([id, count, String(def.name || ('道具' + id))]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** 奖励正文后缀（没有奖励返回空串）。 */
function rewardSuffix(payload, entries) {
  if (!payload.gold && !payload.cup && !entries.length) return '';
  const parts = [];
  if (payload.gold) parts.push('金松果 ' + payload.gold);
  if (payload.cup) parts.push('金杯 ' + payload.cup);
  for (const entry of entries) parts.push(entry[2] + ' ×' + entry[1]);
  return '（可领取：' + parts.join('、') + '）';
}

module.exports = { PROP_HARD_CAP, CURRENCY_PROP, propEntriesOf, rewardSuffix };
