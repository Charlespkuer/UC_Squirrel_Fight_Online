#!/usr/bin/env node
/* 装备词条以 ssfight 原表为准后的对齐回归：
 *   · 48 条词条（32 空号、42~49 存在）、12 档 extraValue 与宝石单位阶梯；
 *   · 42/43 武器伤害、45 暴击倍率、46 暴击减伤、47 绝对防御反弹、48 幸运一击、49 反击率；
 *   · 44 龟甲术防降属性只在龟甲挡下时按比例削减三宝的降属性。
 * 数据只读 js/gamedict.js；不依赖 references/。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function findRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'index.html'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(start, '..');
}
const ROOT = findRoot(__dirname);

function game(online) {
  const ctx = { localStorage: { getItem: () => null, setItem: () => {} }, Date };
  ctx.window = ctx;
  if (online) { ctx.__SSDZ_ONLINE__ = true; ctx.__SSDZ_ONLINE_COMBAT__ = true; }
  vm.createContext(ctx);
  for (const file of ['js/gamedict.js', 'js/gamedata.js', 'js/state.js', 'js/sim.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext('let __seed = 1; Math.random = () => { __seed = (Math.imul(__seed, 1664525) + 1013904223) >>> 0; return __seed / 4294967296; };', ctx);
  ctx.State.newGame('词条回归');
  return ctx;
}
const fixedRandom = (g, v) => vm.runInContext('Math.random = () => ' + Number(v), g);
const SEEDED_RANDOM = 'Math.random = () => { __seed = (Math.imul(__seed, 1664525) + 1013904223) >>> 0; return __seed / 4294967296; };';
const reseed = (g, s) => vm.runInContext('__seed = ' + Number(s) + '; ' + SEEDED_RANDOM, g);

function fighter(o) {
  return Object.assign({
    name: 'x', side: 0, hp: 100000, maxHp: 100000, power: 100, agility: 100, speed: 100,
    baseStats: { power: 100, agility: 100, speed: 100, hp: 100000 }, skills: [], weapons: [],
    buffFlat: { power: 0, agility: 0, speed: 0 }, debuffs: { power: 0, agility: 0, speed: 0 },
    effects: {}, mods: {}, mech: [], mechState: {},
    petSeals: {}, petSealWeapons: {}, petSealSkills: {},
  }, o);
}
function run(g, me, foe, seed, opts) {
  reseed(g, seed);
  return g.Sim.simulate(me, foe, opts || {}).rounds;
}
const first = (rounds, pred) => rounds.find(pred);

test('ssfight 装备词条：48 条、32 空号、宝石总档 3~30 / 单条 12 档与 42~49 都按原表生效', () => {
  const g = game();
  const { State, Sim, attachmentMap } = g;

  /* ① 数据表：网页版的 32 已换成 ssfight 的 44，42~49 补齐。 */
  assert.equal(attachmentMap.keys.length, 48, 'ssfight 附件表应为 48 条');
  assert.equal(attachmentMap.hasKey(32), false, '32 在 ssfight 表里是空号');
  const a44 = attachmentMap.getValue(44);
  assert.equal(a44.ability, '10,20,30');
  assert.equal(a44.extra, '2.50,5,7.50,10,12.50,15,17.50,20,22.50,25,27.50,30');
  for (const id of [42, 43, 44, 45, 46, 47, 48, 49]) assert.ok(attachmentMap.hasKey(id), '缺少词条 ' + id);

  /* ② 宝石总档：1~7 级 = 3/5/8/12/17/23/30；词条值 = 星级 ability + 分到的 extra。 */
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((lv) => State.gemAffixTotal(lv)), [3, 5, 8, 12, 17, 23, 30]);
  const v0 = State.attachmentValue(44, 3, 0);
  assert.equal(v0.base, 30); assert.equal(v0.extra, 0); assert.equal(v0.total, 30);
  const v12 = State.attachmentValue(44, 3, 12);
  assert.equal(v12.base, 30); assert.equal(v12.extra, 30); assert.equal(v12.total, 60);

  /* ③ 穿一件三星 44 + 七级宝石：装备词条应到 60；卸下宝石回到 30。 */
  const s = State.state();
  s.level = 90; s.goldPoint = 1000; s.props[107] = 1;
  const gear = State.addGear(205, [{ id: 44, level: 3 }]);
  assert.ok(gear && State.wear(gear.key), '橙装应能穿上');
  assert.equal(State.equipmentEffects()[44], 30, '无宝石时取三星基础 30%');
  assert.equal(State.socketGem(gear.key, 107).ok, true);
  assert.equal(State.equipmentEffects()[44], 60, '七级宝石 +12 档增幅后应为 60%');
  assert.equal(State.unsocketGem(gear.key).ok, true);
  assert.equal(State.equipmentEffects()[44], 30);

  /* ③b 三词条：7 级总 30 档随机分配，单条不超过 12；战斗效果按各条档数各算各的。 */
  s.props[107] = 1;
  const multi = State.addGear(206, [{ id: 45, level: 3 }, { id: 46, level: 3 }, { id: 48, level: 3 }]);
  assert.ok(multi && State.wear(multi.key), '三词条橙装应能穿上');
  assert.equal(State.socketGem(multi.key, 107).ok, true);
  const units = State.state().gears.find((x) => x.key === multi.key).gem.units;
  assert.equal(units.length, 3, '三词条装备应存 3 个档数');
  assert.equal(units.reduce((a, b) => a + b, 0), 30, '7 级总档数应为 30');
  assert.ok(units.every((u) => u >= 0 && u <= 12), '单条最多 12 档');
  const effects = State.equipmentEffects();
  for (const [i, id] of [45, 46, 48].entries()) {
    assert.equal(effects[id], State.attachmentValue(id, 3, units[i]).total, '词条 ' + id + ' 应按自己的档数生效');
  }

  /* ④ 47 绝对防御：反弹加点（2012 攻略 76%+35%=111% 的同一口径）。 */
  fixedRandom(g, 0);
  const jue = Sim.dmgReduce({ skills: { 16: 10 }, effects: { 47: 30 }, silence: 0, side: 1 }, 1000, { action: 'weapon', weaponType: '近战' });
  assert.equal(jue.jueDui, 1000);
  assert.equal(jue.rebound, 1060, '76% 基础 + 30% 词条 = 106%');

  /* ⑤ 42/43 是吸血基数词条：+100% 只翻倍忍者镖吸血，不改最终伤害（视频 −558 / 回 +632 口径）。 */
  for (const [wid, effId] of [[16, 42], [17, 43]]) {
    const base = first(run(g, fighter({ weapons: [wid + ':10'] }), fighter({ side: 1, agility: 50 }), 7), (r) => r.action === 'weapon' && r.attacker === 0 && r.dmg > 0);
    const buff = first(run(g, fighter({ weapons: [wid + ':10'], effects: { [effId]: 100 } }), fighter({ side: 1, agility: 50 }), 7), (r) => r.action === 'weapon' && r.attacker === 0 && r.dmg > 0);
    assert.ok(base && buff, '应出现武器回合');
    assert.equal(buff.dmg, base.dmg, '武器 ' + wid + ' 的专属词条 ' + effId + ' 不改最终伤害');
  }
  const lsFoe = fighter({ side: 1, agility: 50, hp: 1e6, maxHp: 1e6 });
  const lsMe = fighter({ power: 450, hp: 50000, weapons: ['14:15'], skills: [{ id: 5, level: 15 }], effects: { 7: 100 } });
  const lsRound = first(run(g, lsMe, lsFoe, 7), (r) => r.action === 'weapon' && r.id === 14 && r.lifesteal > 0);
  assert.ok(lsRound && lsRound.lifesteal > 600, '真5忍者镖 +100% 词条吸血应按 (73+33+450×1.11)×2×56% 结算：' + (lsRound && lsRound.lifesteal));

  /* ⑥ 45 暴击倍率 +100%：同一暴击应 ×1.5；46 减暴伤 50%：同一暴击应 ×0.5。 */
  const critBase = first(run(g, fighter({ weapons: ['1:10'], skills: ['9:10'] }), fighter({ side: 1, agility: 50 }), 3), (r) => r.crit && r.attacker === 0 && r.dmg > 0);
  const crit45 = first(run(g, fighter({ weapons: ['1:10'], skills: ['9:10'], effects: { 45: 100 } }), fighter({ side: 1, agility: 50 }), 3), (r) => r.crit && r.attacker === 0 && r.dmg > 0);
  const crit46 = first(run(g, fighter({ weapons: ['1:10'], skills: ['9:10'] }), fighter({ side: 1, agility: 50, effects: { 46: 50 } }), 3), (r) => r.crit && r.attacker === 0 && r.dmg > 0);
  assert.ok(critBase && crit45 && crit46, '应出现暴击回合');
  assert.ok(crit45.dmg > critBase.dmg * 1.2, '45 +100% 应把 2.x 倍率抬到 3.x：' + critBase.dmg + ' → ' + crit45.dmg);
  assert.ok(crit46.dmg < critBase.dmg * 0.7, '46 -50% 应明显压低暴击伤害：' + critBase.dmg + ' → ' + crit46.dmg);

  /* ⑦ 48 幸运一击：+100 基础伤害，先加后乘 1~6 倍。 */
  const luckyBase = first(run(g, fighter({ skills: ['23:10'] }), fighter({ side: 1, agility: 50 }), 5), (r) => r.action === 'skill' && r.id === 23 && r.dmg > 0);
  const lucky48 = first(run(g, fighter({ skills: ['23:10'], effects: { 48: 100 } }), fighter({ side: 1, agility: 50 }), 5), (r) => r.action === 'skill' && r.id === 23 && r.dmg > 0);
  assert.ok(luckyBase && lucky48, '应出现幸运一击');
  assert.equal(lucky48.dmg - luckyBase.dmg, 100 * luckyBase.multiple, '48 的 +N 应在随机倍率之前加');

  /* ⑧ 44 龟甲防降属性：龟甲挡下时把降属性按 50% 削减；没挡下时不动。 */
  const dropRound = (effects) => first(run(g, fighter({ weapons: ['5:10'] }), fighter({ side: 1, skills: ['7:15'], agility: 10, effects }), 1, { collectStats: true }), (r) => r.action === 'weapon' && r.attacker === 0 && r.guiJia > 0);
  const plainDrop = dropRound({});
  const cutDrop = dropRound({ 44: 50 });
  assert.ok(plainDrop && cutDrop, '应出现龟甲挡下的三宝回合');
  assert.equal(plainDrop.debuffCut, undefined);
  assert.equal(cutDrop.debuffCut, 50);
  assert.ok(cutDrop.effStats[1].agility > plainDrop.effStats[1].agility, '50% 防降后守方敏捷应更高');

  /* ⑨ 49 反击率：固定随机 0.5 时 25% 不反击、+100 点后必反击。 */
  fixedRandom(g, 0.5);
  const counterCount = (effects) => g.Sim.simulate(fighter({ weapons: ['1:10'] }), fighter({ side: 1, agility: 100, speed: 1, effects }), {}).rounds.filter((r) => r.counterDmg > 0).length;
  assert.equal(counterCount({}), 0, '25% 反击在 0.5 随机下不应触发');
  assert.ok(counterCount({ 49: 100 }) > 0, '49 +100 点后应能反击');
});

test('同名词条只保留一条：旧档详情取最高星，在线融合产物不重复', () => {
  /* ① 旧档/任意入口的 ext 先收口：25 号分别 1/3 星时只留 3 星，不出现两行同名。 */
  const off = game();
  const gear = off.State.addGear(128, [{ id: 25, level: 1 }, { id: 25, level: 3 }, { id: 26, level: 2 }]);
  assert.ok(gear, 'addGear 应成功');
  assert.deepEqual(Array.from(gear.ext, (e) => [e.id, e.level]), [[25, 3], [26, 2]], '同名词条应合并为最高星');
  assert.deepEqual(Array.from(off.State.extText([{ id: 25, level: 1 }, { id: 25, level: 3 }])), ['忍者镖伤害+40%'],
    '详情页同一词条只显示最高星');
  off.State.state().level = 90;
  assert.equal(off.State.wear(gear.key), true, '橙装应能穿上');
  assert.equal(off.State.equipmentEffects()[25], 40, '合并后效果仍取最高星（战斗侧本来就按 id 取最大）');

  /* ② 在线融合：两件材料都有 25 号（3 星/2 星）时，前两条不能都取 25 号。 */
  const on = game(true);
  const s = on.State.state();
  s.level = 90; s.goldPoint = 10000;
  const ids = [];
  for (let id = 1; id <= 500 && ids.length < 3; id++) {
    const gi = on.State.gearInst(id, [], 0);
    if (gi && gi.quality === 4 && gi.type === 3) ids.push(id);
  }
  assert.equal(ids.length, 3, '应能找到三件同部位橙装');
  const exts = [[{ id: 25, level: 3 }], [{ id: 25, level: 2 }], [{ id: 26, level: 1 }]];
  const keys = ids.map((id, i) => {
    const made = on.State.addGear(id, exts[i]);
    assert.ok(made, '材料 ' + id + ' 应能加入');
    return made.key;
  });
  const res = on.State.mergeGears(keys, {});
  assert.equal(res.ok, true, '融合应成功');
  const ext = res.gear.ext;
  assert.equal(new Set(ext.map((e) => e.id)).size, ext.length, '融合产物不应有同名词条');
  const e25 = ext.find((e) => e.id === 25);
  assert.deepEqual([e25 && e25.id, e25 && e25.level], [25, 3], '同名词条取最高星');
});
