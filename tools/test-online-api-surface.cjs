#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/test-online-api-surface.cjs — 联机版 State 接口面回归
 *
 * 守两件事（都是 2026-11 真实踩过的）：
 *   1. 加载链里引用的 `State.<名字>` 必须真的在 `state.js` 的导出里。
 *      单机 1.1.8 的 `gearAttrText` 只同步了调用、没同步实现，联机版
 *      原版融合选材料页直接抛 TypeError —— 这条用例就是那次事故的守门。
 *   2. 融合价格只有一个真值 `State.fusionCostOf`：联机 30/40/50/100/200/200；
 *      `gearCostOf` 仍是碎片合成的按品质价（蓝 50），两者不能混用。
 *
 * 只读源码 + 最小 DOM 桩，不写任何文件、不依赖 references/。
 * ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 最小 DOM / BOM 桩（够 state.js 加载期用） ---------- */
function makeSandbox() {
  const s = { console };
  s.window = s;
  s.self = s;
  s.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  s.document = {
    createElement: () => ({ getContext: () => ({}), style: {} }),
    addEventListener() {}, getElementById: () => null, querySelector: () => null,
    head: { appendChild() {} },
  };
  s.navigator = { userAgent: 'node' };
  s.location = { protocol: 'http:', search: '', hostname: '127.0.0.1', port: '8080' };
  s.__SSDZ_ONLINE__ = true;
  vm.createContext(s);
  return s;
}

const sandbox = makeSandbox();
for (const file of ['js/gamedict.js', 'js/engine.js', 'js/gamedata.js', 'js/state.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
const State = sandbox.State;
assert.ok(State && typeof State === 'object', 'state.js 必须导出 window.State');

/* ---------- 1. 两个融合相关 API 必须存在且口径正确 ---------- */
assert.equal(typeof State.gearAttrText, 'function', 'State.gearAttrText 必须存在（原版融合页 t_base 在调用）');
assert.equal(State.gearAttrText({ abilityVal: 25, attrName: '力量' }, { name: true }), '力量 25',
  '没有 attrPct 的档只写「名字 数值」，不伪造 (+0%)');
assert.equal(State.gearAttrText({ abilityVal: 84, attrName: '生命', attrPct: -2 }, { name: true }), '生命 84(-2%)',
  '有 attrPct 时按单机版格式写百分比');
assert.equal(State.gearAttrText({ abilityVal: 84, attrName: '生命', attrPct: 3 }), '84(+3%)',
  '不传 name 时只写数值');

assert.equal(typeof State.fusionCostOf, 'function', 'State.fusionCostOf 必须存在（融合价格的唯一真值）');
assert.deepEqual([0, 1, 2, 3, 4, 5].map((q) => State.fusionCostOf(q)), [30, 40, 50, 100, 200, 200],
  '联机融合按材料品质：普通 30 / 优秀 40 / 杰出 50 / 卓越 100 / 传说 200 / 黑色 200');
assert.equal(State.gearCostOf(2), 50, 'gearCostOf 仍是碎片合成的按品质价（蓝 50），不要改它');

/* ---------- 2. 加载链里的 State.<名字> 必须都在导出里 ---------- */
const html = fs.readFileSync(path.join(ROOT, 'scripts/index-online.html'), 'utf8');
const loaded = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
assert.ok(loaded.length > 30, 'index-online.html 的脚本链异常：只有 ' + loaded.length + ' 个文件');

/* 现代界面页（原 js/ui.js）已退役，加载链里不再有会引用 `State.stageRuns` 的文件；
 * 这里保留空集合是为了以后再加「联机不加载的页面」时有个显式的口子。 */
const SKIP = new Set([]);
const exported = new Set(Object.keys(State));
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const missing = [];
for (const file of loaded) {
  if (SKIP.has(file)) continue;
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const m of src.matchAll(/\bState\.([A-Za-z_$][\w$]*)/g)) {
    if (!exported.has(m[1])) missing.push(file + ' → State.' + m[1]);
  }
}
assert.equal(missing.length, 0, '加载链引用了 State 里不存在的接口：\n  ' + missing.join('\n  '));

/* StateCall('名字') 是页面调 async 动作的统一入口；名字也必须在 State 导出里（或由服务端动作表提供）。
 * 这里只检查**本地 State 也有的**那几个：服务端专有动作不在 state.js 里，跳过。 */
const serverOnly = new Set(((() => {
  try {
    const shared = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/actions.json'), 'utf8'));
    return (shared.serverOnly || []).map(String);
  } catch (e) { return []; }
})()));

/* 祭坛领取由服务端掷 1~3 的 buffId；标成 sync 时客户端会先预测另一个值，
 * 随后整档重同步把界面换成服务端存档，玩家看到的就是「退出重进变了个奖励」。 */
const sharedActions = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/actions.json'), 'utf8'));
assert.equal(sharedActions.actions.claimBuildingBuff.mode, 'async', 'claimBuildingBuff 是随机动作，必须 async');
const villageSrc = fs.readFileSync(path.join(ROOT, 'js/ssfight/ui-village.js'), 'utf8');
assert.match(villageSrc, /StateCall\(\s*'claimBuildingBuff'\s*,\s*'altar'\s*\)/, '祭坛领取按钮必须 await 服务端结果');

const missingCalls = [];
for (const file of loaded) {
  if (SKIP.has(file)) continue;
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const m of src.matchAll(/StateCall\(\s*'([A-Za-z_$][\w$]*)'/g)) {
    if (!exported.has(m[1]) && !serverOnly.has(m[1])) missingCalls.push(file + ' → StateCall(' + m[1] + ')');
  }
}
assert.equal(missingCalls.length, 0, '加载链调用了不存在的 StateCall 动作：\n  ' + missingCalls.join('\n  '));

console.log('PASS State 接口面：' + loaded.length + ' 个脚本、' + exported.size + ' 个导出，gearAttrText / fusionCostOf 口径正确');
