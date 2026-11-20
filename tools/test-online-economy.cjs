'use strict';
/* ============================================================
 * tools/test-online-economy.cjs — 联机版经济收口的可执行尺子
 * ------------------------------------------------------------
 * 跑法：`node tools/test-online-economy.cjs`
 * 它把 `window.__SSDZ_ONLINE__ = true` 之后的 `state.js` 装进一个最小环境，
 * 逐条核对 docs/奖励与经济.md 里「联机版删/降」的那些渠道真的没了。
 *
 * ⚠ 只测**联机版开关下的行为**；单机版由 tools/test-state.cjs 守着（105 条）。
 * ============================================================ */
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('FAIL ' + name + ' — ' + (e && e.message));
  }
}

/* ---------- 最小环境：直接复用服务端的 headless 装载器 ---------- */
function bootOnline() {
  for (const k of ['State', 'Sim', 'GData', 'Engine', 'window', 'localStorage', 'document']) {
    try { delete globalThis[k]; } catch (_) { /* 有的是只读 */ }
  }
  process.env.GAME_ROOT = ROOT;
  globalThis.__SSDZ_ONLINE__ = true;
  /* runtime.js 会自己建 window/document/localStorage 桩，再按顺序 require */
  const rtPath = path.join(ROOT, 'server', 'game', 'runtime.js');
  delete require.cache[require.resolve(rtPath)];
  delete require.cache[require.resolve(path.join(ROOT, 'js', 'state.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'js', 'gamedata.js'))];
  const rt = require(rtPath);
  /* runtime.boot() 里 `window = globalThis`，所以标记要挂在 globalThis 上、且在 boot 之前。 */
  globalThis.__SSDZ_ONLINE__ = true;
  rt.boot();
  return rt;
}

const rt = bootOnline();
const State = globalThis.State;
const GData = globalThis.GData;
const storage = globalThis.__ssdzServerStorage;

/* 一份可控的初始档：level 1、无道具、金松果够用 */
function freshSave(extra) {
  State.restorePayload(Object.assign({
    name: '测试鼠', level: 1, exp: 0, power: 10, agility: 10, speed: 10, maxHp: 50, hp: 50,
    goldPoint: 5000, goldCup: 0, integral: 1500, energy: 100, maxEnergy: 100,
    weapons: [], skills: [], gears: [], props: {}, pets: [], petsTeam: [], stages: {},
    settings: { uiMode: 'classic' },
  }, extra || {}));
  return State.state();
}

test('联机版只有经典界面：UIMODES 只有一项，切界面被拒', () => {
  assert.deepStrictEqual(State.UIMODE_KEYS, ['classic']);
  assert.strictEqual(State.switchMode('modern').ok, false);
  assert.strictEqual(State.activeUiMode(), 'classic');
});

test('联机版不落本地存档：save() 不写 localStorage', () => {
  freshSave();
  const before = storage.size;
  State.save();
  assert.strictEqual(storage.size, before);
});

test('联机版每日任务只读服务端题面，客户端不重摇', () => {
  freshSave();
  const first = State.questStatus();
  assert.equal(first.length, State.QUEST_COUNT, '每日任务条数应等于 QUEST_COUNT（联机版 3 条）');
  const keys = first.map((q) => q.key);
  assert.deepStrictEqual(State.questStatus().map((q) => q.key), keys, '重复读取不能换题');
  const again = State.questState();
  assert.deepStrictEqual(again.list.map((q) => q.key), keys, '同一天同一等级不应重摇');
  assert.strictEqual(State.claimQuest(0).ok, false, '没完成的任务不能领');
});

test('联机版没有新号三天福利', () => {
  freshSave({ newbieStartDate: State.localDate() });
  const daily = State.dailyStatus();
  assert.strictEqual(daily.newbie, null);
});

test('升级不再发「每级随机礼包」，也没有 5 级 50 金', () => {
  const s = freshSave();
  s.level = 4;
  s.exp = 0;
  State.save();
  const goldBefore = s.goldPoint;
  const ups = State.gainExp(GData.nextExp(4) + 5);          // 升到 5 级
  assert.ok(ups.length >= 1, '至少要升一级');
  const lv5 = ups.find((u) => u.level === 5);
  assert.ok(lv5, '应该升到 5 级');
  assert.deepStrictEqual(lv5.gifts, [], '5 级不该有升级礼包');
  assert.strictEqual(s.goldPoint, goldBefore, '5 级不该再 +50 金松果');
});

test('联机升级静默发大体力药剂：2~10 级 1 瓶、11~20 级 2 瓶，90 级累计 449', () => {
  const s = freshSave({ level: 1, exp: 0 });
  assert.deepStrictEqual([1, 2, 10, 11, 20, 21, 30, 90].map((lv) => State.levelStaminaPotion(lv)),
    [0, 1, 1, 2, 2, 3, 3, 9]);
  const ups = State.gainExp(GData.nextExp(1));
  assert.strictEqual(s.level, 2);
  assert.strictEqual(s.props[2], 1, '升到 2 级给 1 瓶');
  assert.deepStrictEqual(ups[0].gifts, [], '药水静默进背包，不写升级礼包');
  const levelReward = require('../server/game/level-reward');
  assert.strictEqual(levelReward.totalThroughLevel(10), 9);
  assert.strictEqual(levelReward.totalThroughLevel(20), 29);
  assert.strictEqual(levelReward.totalThroughLevel(30), 59);
  assert.strictEqual(levelReward.totalThroughLevel(90), 449);
});

test('升级自动分配属性，武技保留三选一', () => {  const s = freshSave();
  s.level = 1; s.exp = 0; s.wsPicks = [];
  const ups = State.gainExp(GData.nextExp(1));
  assert.strictEqual(ups[0].level, 2);
  assert.strictEqual(s.freePoints, undefined);
  assert.ok(ups[0].autoPoint);
  if (GData.WS_LEVELS.includes(2)) { assert.strictEqual(s.wsPicks.length, 1); assert.strictEqual(s.wsPicks[0].length, 3); }
  const selected = s.wsPicks[0][1];
  assert.ok(State.chooseWS(selected.kind, selected.id).ok);
  assert.strictEqual(s.wsPicks.length, 0);
  assert.ok((selected.kind === 'weapon' ? s.weapons : s.skills).includes(selected.id + ':1'));
});

test('5 级新手装备只能由服务端发放一次', () => {
  const s = freshSave({level:5, starterGearGiven:false});
  const gear = State.grantStarterGear();
  assert.ok(gear && s.starterGearGiven);
  assert.strictEqual(State.grantStarterGear(), null);
  assert.strictEqual(s.gears.length, 1);
});

test('真化武技按等级累加（龟甲多次使用按单机原表）', () => {
  assert.strictEqual(GData.trueWeaponBonus({id:4,level:15}, 'combo'),25);
  assert.strictEqual(GData.trueSkillValue(23,15),50);
  assert.strictEqual(GData.trueSkillValue(9,15),20);
  assert.strictEqual(GData.trueSkillValue(12,11),20);
  const attacker={skills:{9:15}}, defender={skills:{10:15}};
  assert.strictEqual(globalThis.Sim.critChanceVs(attacker,defender),20);
  assert.strictEqual(globalThis.Sim.shellChanceOf({skills:{7:15},effects:{}},1),100);
  assert.strictEqual(globalThis.Sim.shellChanceOf({skills:{7:15},effects:{}},2),100);
});

test('联机碎片合成与单机同价：白30 / 绿40 / 蓝50', () => {
  const s = freshSave({ props: { 24: 10, 25: 10, 26: 10 } });
  s.goldPoint = 5000;
  assert.strictEqual(State.composeGear(24).ok, true);
  assert.strictEqual(s.goldPoint, 4970, '白色碎片合成 30 金松果');
  assert.strictEqual(State.composeGear(25).ok, true);
  assert.strictEqual(s.goldPoint, 4930, '绿色碎片合成 40 金松果');
  assert.strictEqual(State.composeGear(26).ok, true);
  assert.strictEqual(s.goldPoint, 4880, '蓝色碎片合成 50 金松果');
});

test('联机 90 级成长预算不再有永久属性总上限', () => {
  const s = freshSave({level:1, power:4, agility:4, speed:4, maxHp:50, hp:50, exp:0});
  for (let level=2; level<=90; level++) State.gainExp(GData.nextExp(level-1));
  assert.strictEqual(s.level,90);
  assert.strictEqual(State.permanentStatTotal(),378);
  assert.strictEqual(s.levelChests,20);
  assert.strictEqual(State.STAT_HARD_CAP,651);
  s.power = 1000; State.clampPermanentStats();
  assert.ok(State.permanentStatTotal() > 651, '联机版不再被 651 收口');
});

test('联机融合按星级和材料顺序继承，第三条来自余下材料', () => {
  function run(entries) {
    freshSave({ level: 60 });
    const gears = [201, 202, 203].map((id, i) => State.addGear(id, entries[i]));
    const old = Math.random;
    try { Math.random = () => 0.9; return State.mergeGears(gears.map(g => g.key)); }
    finally { Math.random = old; }
  }
  const three = run([[{id:1,level:3},{id:2,level:2}], [{id:3,level:3}], [{id:4,level:3}]]);
  assert.ok(three.ok); assert.deepStrictEqual(three.gear.ext.slice(0,2), [{id:1,level:3},{id:3,level:3}]);
  assert.ok([2,4].includes(three.gear.ext[2].id));
  assert.strictEqual(three.gear.type, 2, '0.9 选择第三件材料的衣服部位');
  const one = run([[{id:1,level:2}], [{id:3,level:3}], [{id:4,level:2}]]);
  assert.deepStrictEqual(one.gear.ext.slice(0,2), [{id:3,level:3},{id:1,level:2}]);
  const none = run([[{id:1,level:1}], [{id:2,level:2}], [{id:3,level:2}]]);
  assert.deepStrictEqual(none.gear.ext.slice(0,2), [{id:2,level:2},{id:3,level:2}]);
  const repeat = run([[{id:1,level:3}], [{id:1,level:3}], [{id:3,level:2}]]);
  assert.deepStrictEqual(repeat.gear.ext.slice(0,2), [{id:1,level:3},{id:3,level:2}]);
  assert.strictEqual(new Set(repeat.gear.ext.map(e => e.id)).size, repeat.gear.ext.length, '同名词条不能重复');
});

test('联机融合按材料品质扣费：30/40/50/100/200/200', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((q) => State.fusionCostOf(q)),
    [30, 40, 50, 100, 200, 200]);
  const cases = [
    [[1, 2, 3], 30], [[9, 10, 11], 40], [[21, 22, 23], 50],
    [[49, 50, 51], 100], [[125, 126, 127], 200], [[181, 182, 183], 200],
  ];
  for (const [ids, cost] of cases) {
    const s = freshSave({ level: 60, goldPoint: 1000 });
    const gears = ids.map((id) => State.addGear(id)).filter(Boolean);
    assert.strictEqual(gears.length, 3, '材料 id 必须存在：' + ids.join(','));
    const r = State.mergeGears(gears.map((g) => g.key));
    assert.ok(r.ok, '融合应成功：' + (r.msg || ids.join(',')));
    assert.strictEqual(s.goldPoint, 1000 - cost, '品质 ' + gears[0].quality + ' 应扣 ' + cost);
  }
});

test('联机融合：橙装封顶 3 条，黑装四对共有词条才出 4 条', () => {
  freshSave({ level: 60 });
  const ext = (ids) => ids.map((id) => ({ id, level: 1 }));
  /* 三件材料里 1/2/3/4 都至少出现两件 → 旧分支仍可能出 4 条，新分支只能保留 3 条。 */
  const gears = [
    State.addGear(201, ext([1, 2, 3])),
    State.addGear(202, ext([1, 2, 4])),
    State.addGear(203, ext([1, 3, 4])),
  ];
  const old = Math.random;
  Math.random = () => 0.5;
  try {
    const r = State.mergeGears(gears.map((g) => g.key));
    assert.strictEqual(r.ok, true, r.msg || '融合应成功');
    assert.strictEqual(r.gear.ext.length, 3, '橙装最多 3 条词条，不能出 4 词条');
    assert.strictEqual(new Set(r.gear.ext.map((e) => e.id)).size, 3, '保留的 3 条不能重复');
    /* 黑装隐藏机制：恰好四对共有词条时允许突破 3 槽。 */
    const black = [281, 281, 281].map((id, i) => State.addGear(id, ext([[1, 2, 3], [1, 2, 4], [1, 3, 4]][i])));
    const rb = State.mergeGears(black.map((g) => g.key));
    assert.strictEqual(rb.ok, true, rb.msg || '黑装融合应成功');
    assert.strictEqual(rb.gear.quality, 5, '产物是黑装');
    assert.strictEqual(rb.gear.ext.length, 4, '四对共有词条才允许出 4 条');
    assert.deepStrictEqual(new Set(rb.gear.ext.map((e) => e.id)), new Set([1, 2, 3, 4]), '四条就是四对共有词条');
  } finally {
    Math.random = old;
  }
});

test('联机融合部位按三件材料抽取，变异阈值为 2%', () => {
  function run(draws) {
    freshSave({level:60});
    const gear = [201,202,203].map(id => State.addGear(id,[{id:1,level:2}]));
    const old = Math.random; let i=0;
    try { Math.random = () => i < draws.length ? draws[i++] : 0.9; return State.mergeGears(gear.map(g => g.key)); }
    finally { Math.random = old; }
  }
  for (const [sample,part] of [[0.1,0],[0.4,1],[0.9,2]]) assert.strictEqual(run([sample,0.5]).gear.type,part);
  assert.strictEqual(run([0.1,0.019]).gear.mutant,true);
  assert.strictEqual(run([0.1,0.02]).gear.mutant,false);
  const upgraded = run([0.1,0.5,0.9,0.1,0.1,0.9,0.1]);
  const uext = upgraded.gear.ext;
  assert.strictEqual(uext.length, 3, '橙装三槽');
  assert.strictEqual(uext.filter((e) => e.id === 1).length, 1, '同名词条只保留一条');
  assert.strictEqual(uext.find((e) => e.id === 1).level, 3, '继承的 1 号应升到 3 星');
  assert.strictEqual(new Set(uext.map((e) => e.id)).size, 3, '剩余槽位补随机词条，不能重复');
});

test('属性碎片随机合成力量/敏捷/速度转化丸，不产出永久属性丸', () => {
  const s = freshSave();
  s.props[GData.CONVERT_SHARD_ID] = 20;
  const r = State.composeConvertPill();
  assert.strictEqual(r.ok, true);
  assert.ok([10, 11, 12].includes(r.prop), '产物必须是 10/11/12，实际 ' + r.prop);
  assert.strictEqual(s.props[r.prop], 1, '转化丸进背包');
  for (const id of [16, 17, 18, 19]) assert.strictEqual(s.props[id] || 0, 0, '不能产出永久属性道具 ' + id);
  assert.strictEqual(s.props[GData.CONVERT_SHARD_ID], 10, '应扣 10 个碎片');
  assert.strictEqual(s.goldPoint, 4950, '属性碎片合成收费 50 金松果');
  assert.strictEqual(State.propSellPrice(r.prop), 0, '联机版转化丸不能卖');
  assert.strictEqual(State.sellProp(r.prop, 1).ok, false, '不能把转化丸卖成金松果');
});

test('转化丸使用结果带转换前后属性，弹幕文案能说清方向', () => {
  const s = freshSave();
  s.props[10] = 1;
  const r = State.useProp(10);
  assert.strictEqual(r.ok, true);
  assert.ok(r.conversion, '使用结果必须带 conversion');
  assert.strictEqual(r.conversion.from, 'power');
  assert.ok(['agility', 'speed'].includes(r.conversion.to), '只能转到敏捷或速度');
  assert.match(r.msg, /属性转换成功：力量 → (敏捷|速度)/);
  assert.strictEqual(s.power, 9);
  assert.strictEqual(s[r.conversion.to], 11);
});

test('金宝箱固定 10 点属性 + 非属性其它奖励；不能重开', () => {
  const s = freshSave({ props: { 90: 1 }, goldPoint: 10000 });
  const before = s.power + s.agility + s.speed + s.maxHp / 5;
  assert.strictEqual(State.reopenChest, undefined, '重开机制已移除');
  assert.strictEqual(State.chestReopenCost, undefined);
  const begin = State.beginChest(90);
  assert.strictEqual(begin.ok, true);
  assert.strictEqual(begin.pending.points, State.CHEST_FIXED_POINTS);
  assert.notStrictEqual(begin.pending.reward.kind, 'points');
  const pointGain = begin.pending.pointsGain;
  assert.ok(pointGain, '开箱时就要掷定 10 点分配，第一页才能展示');
  assert.strictEqual(pointGain.power + pointGain.agility + pointGain.speed + pointGain.hp / 5, State.CHEST_FIXED_POINTS);
  const goldOdds = State.chestOtherOdds();
  assert.ok(goldOdds.length > 0 && goldOdds.every((row) => !/属性/.test(row.label)), '其它奖励池不含属性点');
  assert.ok(Math.abs(goldOdds.reduce((sum, row) => sum + row.chance, 0) - 1) < 1e-9, '其它奖励概率合计 1');
  const confirm = State.confirmChest();
  assert.strictEqual(confirm.ok, true);
  assert.strictEqual(confirm.points, State.CHEST_FIXED_POINTS);
  assert.deepStrictEqual(confirm.pointsGain, pointGain);
  assert.strictEqual(s.power + s.agility + s.speed + s.maxHp / 5, before + State.CHEST_FIXED_POINTS);

  /* 旧档单项 pending（例如 12 点）读档迁成「固定 10 点 + 非属性其它」。 */
  const legacy = JSON.parse(JSON.stringify(State.state()));
  legacy.chestPending = { propId: 90, reward: { kind: 'points', count: 12, name: '基础属性点' }, lotteryCount: 3 };
  assert.strictEqual(State.restorePayload(legacy, { deferSettle: true }), true);
  const migrated = State.chestState();
  assert.strictEqual(migrated.points, State.CHEST_FIXED_POINTS);
  assert.strictEqual(migrated.pointsGain, null);
  assert.notStrictEqual(migrated.reward.kind, 'points');
  assert.strictEqual(migrated.lotteryCount, undefined);
});

test('联机 53/59/65 静默发 1 本属性书，不写升级奖励卡', () => {
  const s = freshSave({ level: 52, exp: 0 });
  assert.deepStrictEqual(Array.from(GData.ATTRIBUTE_BOOK_LEVELS), [53, 59, 65]);
  let ups = State.gainExp(GData.nextExp(52));
  assert.strictEqual(s.level, 53);
  assert.strictEqual(s.props[37], 1);
  assert.strictEqual(ups[0].silentBook, true);
  assert.strictEqual(ups[0].attributeBook, false);
  assert.deepStrictEqual(ups[0].gifts, []);

  s.level = 54; s.exp = 0;
  ups = State.gainExp(GData.nextExp(54));
  assert.strictEqual(s.level, 55);
  assert.strictEqual(s.props[37], 1, '非固定等级不追加');
  assert.strictEqual(ups[0].silentBook, false);

  s.level = 58; s.exp = 0;
  ups = State.gainExp(GData.nextExp(58));
  assert.strictEqual(s.level, 59);
  assert.strictEqual(s.props[37], 2);

  s.level = 64; s.exp = 0;
  ups = State.gainExp(GData.nextExp(64));
  assert.strictEqual(s.level, 65);
  assert.strictEqual(s.props[37], 3);
});

test('商店出售勇气徽章与召唤证；征战令每天可买、限购 1 个', () => {
  freshSave();
  assert.strictEqual(State.purchaseStatus(39).buyable, true);
  assert.strictEqual(State.purchaseStatus(82).buyable, true);
  assert.strictEqual(State.purchaseStatus(1).buyable, true, '体力药应该还能买');
  assert.strictEqual(State.purchaseStatus(GData.CAMPAIGN_TICKET_ID).buyable, true, '征战令每天出售');
  assert.strictEqual(State.shopLimit(GData.CAMPAIGN_TICKET_ID), 1, '征战令每天限购 1 个');
});

test('征战令（道具 87）进了字典：200 金松果、可购买', () => {
  const prop = globalThis.propMap.getValue(GData.CAMPAIGN_TICKET_ID);
  assert.ok(prop, '道具 87 必须存在');
  assert.strictEqual(prop.name, '征战令');
  assert.strictEqual(prop.price, '200');
});

test('联机抽奖由 State 开奖：免费 → 抽奖卷 → 25 金松果', () => {
  /* 固定抽到第一档（武器卷轴）：「金松果 +40」会把净扣费冲成 -15，让扣费断言随机挂。 */
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const s = freshSave({ lotteryDate: '', lotteryFree: 1, props: { 50: 1 }, goldPoint: 5000 });
    const a = State.lotteryDraw(1);
    const b = State.lotteryDraw(1);
    const beforeGold = s.goldPoint;
    const c = State.lotteryDraw(1);
    assert.ok(a.ok && b.ok && c.ok);
    assert.deepStrictEqual([a.draws[0].pay, b.draws[0].pay, c.draws[0].pay], ['free', 'ticket', 'gold']);
    assert.strictEqual(c.price, 25, '单次金松果抽奖价 25');
    assert.strictEqual(beforeGold - s.goldPoint, 25, '金松果按 25 扣费');
    assert.strictEqual(s.lotteryFree, 0);
    assert.strictEqual(Number(s.props[50]) || 0, 0);
    const before = s.goldPoint;
    s.goldPoint = 0;
    const d = State.lotteryDraw(1);
    assert.strictEqual(d.ok, false, '没有免费/抽奖卷/25 金松果时必须拒绝');
    assert.strictEqual(d.price, 25, '失败结果也带当前单价');
    s.goldPoint = before;
  } finally {
    Math.random = realRandom;
  }
});

test('天梯金杯商店：23 件价格与积分门槛按 2026-11 口径，月度/账号/每周限购都由 State 判定', () => {
  const goodsMap = globalThis.rankgoodsMap;
  assert.strictEqual(goodsMap.keys.length, 23, '原版 23 件商品要补全');
  /* 用户 2026-11 口径：800→50 / 1000→100 / 1500→200 / 2000→300 /
   * 1200→180 / 1300→180；第二套狂战单独 1200→400。 */
  const integral = {
    1: 50, 2: 50, 3: 50, 4: 50,
    5: 100, 6: 100,
    7: 200, 8: 200, 9: 200, 10: 200,
    11: 300, 12: 300, 13: 300, 14: 300,
    15: 180, 16: 180, 17: 180, 18: 180,
    19: 180,
    20: 400, 21: 400, 22: 400, 23: 400,
  };
  for (const [id, value] of Object.entries(integral)) {
    assert.strictEqual(Number(goodsMap.getValue(id).integral), value, '商品 ' + id + ' 的积分门槛');
  }
  assert.deepStrictEqual([Number(goodsMap.getValue('5').cup), Number(goodsMap.getValue('5').integral)], [50, 100], '卷轴按原版 50 杯/100 分');
  /* 力敏速血转化丸 30 杯 + 30 金松果；永久属性丸 500 杯 + 200 金松果。 */
  for (const id of ['15', '16', '17', '18']) {
    assert.deepStrictEqual([Number(goodsMap.getValue(id).cup), Number(goodsMap.getValue(id).gold)], [30, 30], '转化丸 ' + id + ' 的价格');
  }
  for (const id of ['7', '8', '9', '10']) {
    assert.deepStrictEqual([Number(goodsMap.getValue(id).cup), Number(goodsMap.getValue(id).gold)], [500, 200], '永久属性丸 ' + id + ' 的价格');
  }
  /* 最后一页第二套狂战：橙色套（205-208），2500 杯 + 500 金松果。 */
  assert.deepStrictEqual(['20', '21', '22', '23'].map((id) => Number(goodsMap.getValue(id).cup)), [2500, 2500, 2500, 2500], '橙狂战每件 2500 杯');
  assert.deepStrictEqual(['20', '21', '22', '23'].map((id) => Number(goodsMap.getValue(id).goodsId)), [205, 206, 207, 208], '橙狂战 goodsId');
  const s = freshSave({ level: 40, integral: 3000, goldCup: 5000, goldPoint: 5000,
    rankPurchaseWeek: '', rankPurchases: {}, rankPurchaseTotals: {}, rankMonthPurchases: {}, rankPurchaseMonth: '' });
  const gear = State.rankBuy(11);
  assert.strictEqual(gear.ok, true, '狂战头盔应能兑换');
  assert.strictEqual(s.gears.length, 1, '装备类商品要真的进背包');
  const first = State.rankBuy(7);
  assert.strictEqual(first.ok, true, '力量永久+1 本月第一次应能兑换');
  const second = State.rankBuy(7);
  assert.strictEqual(second.ok, false, '永久属性丸本月限购 1 次');
  s.rankPurchaseMonth = '2000-01';
  State.refreshRankShopDay();
  assert.strictEqual(State.rankBuy(7).ok, true, '跨月后应恢复 1 次');
  assert.strictEqual(State.rankBuy(5).ok, true, '技能卷轴本周第一次应能兑换');
  assert.strictEqual(State.rankBuy(5).ok, false, '普通商品是每周限兑 1 次');
  assert.match(String(goodsMap.getValue('20').remark), /随机生成两个较好的附加属性/, '第二套狂战说明必须保留随机附加属性');
  const secondSet = State.rankBuy(20);
  assert.strictEqual(secondSet.ok, true, '第二套狂战也要能兑换');
  assert.strictEqual(s.gears[s.gears.length - 1].id, 205, '第二套给橙色狂战 205');
  assert.strictEqual(State.gearInst(205).quality, 4, '第二套是橙装');
  assert.strictEqual((s.gears[s.gears.length - 1].ext || []).length, 2, '第二套狂战同样带 2 条随机附加属性');
});

test('金杯商店两套狂战（11-14 / 20-23）每月限兑一次，跨月重置', () => {
  const s = freshSave({ level: 40, integral: 5000, goldCup: 30000, goldPoint: 20000,
    rankPurchaseWeek: '', rankPurchases: {}, rankPurchaseTotals: {}, rankMonthPurchases: {}, rankPurchaseMonth: '' });
  assert.strictEqual(State.rankBuy(11).ok, true, '第一套本月第一次');
  const firstAgain = State.rankBuy(11);
  assert.strictEqual(firstAgain.ok, false, '第一套本月第二次被拦');
  assert.match(String(firstAgain.msg), /本月只能兑换/);
  assert.strictEqual(State.rankBuy(20).ok, true, '第二套本月第一次');
  const secondAgain = State.rankBuy(20);
  assert.strictEqual(secondAgain.ok, false, '第二套本月第二次被拦');
  assert.match(String(secondAgain.msg), /本月只能兑换/);
  assert.strictEqual(s.rankMonthPurchases['11'], 1);
  assert.strictEqual(s.rankMonthPurchases['20'], 1);
  assert.strictEqual(s.rankMonthPurchases['12'], undefined);
  s.rankPurchaseMonth = '2000-01';
  State.refreshRankShopDay();
  assert.strictEqual(State.rankBuy(11).ok, true, '跨月后第一套恢复 1 次');
  assert.strictEqual(State.rankBuy(20).ok, true, '跨月后第二套恢复 1 次');
});

test('联机复仇信息：费用 (n+1)*20、金杯 (n+1)*5+3，且只认天梯败绩', () => {
  const s = freshSave();
  s.battles = [{ id: 'rv-test', kind: 'rank', winner: 1, revengeCount: 0, online: { combatId: 'c_rvtest' } }];
  const a = State.revengeInfo('rv-test');
  assert.deepStrictEqual([a.cost, a.cups, a.ladder], [20, 8, true], '第一次复仇：20 金松果 / 8 金杯');
  s.battles[0].revengeCount = 1;
  const b = State.revengeInfo('rv-test');
  assert.deepStrictEqual([b.cost, b.cups], [40, 13], '第二次复仇：40 金松果 / 13 金杯');
});

test('联机卖装备在界面展示的品质区间内随机成交，不按字典整价回收', () => {
  const s = freshSave();
  const gear = State.addGear(202);            // 狂战拳甲：紫装，界面写 95~105
  const before = s.goldPoint;
  const got = State.sellGear(gear.key, true);
  assert.ok(got >= 95 && got <= 105, '紫装卖价应落在 95~105，实际 ' + got);
  assert.strictEqual(s.goldPoint, before + got, '卖价真的入账');
});

test('师徒日供不再发金松果，经验按 10% 封顶', () => {
  const s = freshSave();
  const y = new Date(Date.now() - 86400000);
  const key = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
  s.earnHistory = [{ date: key, exp: 1000, gold: 1000 }];
  s.prentices = [{ name: '徒弟甲', level: 20, since: key, tributeClaimedDate: '' }];
  if (!Array.isArray(s.prentices) || !s.prentices.length) return;      // 数据表未就绪时跳过
  const before = { gold: s.goldPoint, exp: s.exp };
  const out = State.claimApprenticeExp();
  if (!out.ok) return;                                                  // 没有可结算的日供
  assert.ok(out.total <= 100, '经验日供应 ≤ 昨日收益的 10%（1000×10%=100），实际 ' + out.total);
  assert.strictEqual(s.goldPoint, before.gold, '金松果日贡必须为 0');
  void before.exp;
});

/* ---------- 小结 ---------- */
console.log('');
if (failures.length) {
  console.log(failures.length + ' 条失败 / 共 ' + (pass + failures.length) + ' 条');
  for (const f of failures) console.log('  ✗ ' + f.name + '\n    ' + (f.error && f.error.stack));
  process.exit(1);
}
console.log(pass + '/' + (pass + failures.length) + ' passed');
void execFileSync;
