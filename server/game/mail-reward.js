'use strict';
// 两个发信入口共用这一份，避免「正文后缀」各写一套后和客户端对不上：
// 必须走上面前两个字段，不能写进 props；
// · 正文后缀 `（可领取：金松果 300、挑战书 ×3）` 是客户端契约：

const PROP_HARD_CAP = 9999;
const CURRENCY_PROP = Object.freeze({ 8: 'gold', 15: 'exp', 40: 'cup' });

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

function rewardSuffix(payload, entries) {
  if (!payload.gold && !payload.cup && !entries.length) return '';
  const parts = [];
  if (payload.gold) parts.push('金松果 ' + payload.gold);
  if (payload.cup) parts.push('金杯 ' + payload.cup);
  for (const entry of entries) parts.push(entry[2] + ' ×' + entry[1]);
  return '（可领取：' + parts.join('、') + '）';
}

module.exports = { PROP_HARD_CAP, CURRENCY_PROP, propEntriesOf, rewardSuffix };
