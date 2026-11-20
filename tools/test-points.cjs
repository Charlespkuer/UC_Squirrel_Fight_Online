/* Run: node tools/test-points.cjs. 升级成长、金宝箱自动分配与 25% 保底规则测试。
 * 用真实词典与 state.js，随机源固定，便于复现。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
/** 项目根：从脚本所在目录往上找含 index.html 的那一层（tools/ 放哪都能用）。 */
function findRoot(start) {
  const fsx = require('node:fs'), px = require('node:path');
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fsx.existsSync(px.join(d, 'index.html'))) return d;
    const up = px.dirname(d);
    if (up === d) break;
    d = up;
  }
  return px.resolve(start, '..');
}

const root = findRoot(__dirname);
const GAIN = { power: 1, agility: 1, speed: 1, hp: 5 };
function setup() {
  const storage = new Map(); let seed = 20260924;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [new Date(2026, 8, 24, 12).getTime()])); } static now() { return new Date(2026, 8, 24, 12).getTime(); } }
  const c = { Date: Clock, location: { search: '?qa=1' }, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) } };
  c.window = c; vm.createContext(c);
  for (const file of ['js/gamedict.js', 'js/gamedata.js', 'js/state.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), c, { filename: file });
  const math = vm.runInContext('Math', c); math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  c.State.newGame('加点测试');
  return { ...c, storage, math, s: () => c.State.state(), saved: () => JSON.parse(storage.get(c.State.saveKey)) };
}
const tests = [];
const test = (name, run) => tests.push([name, run]);
const total = (s) => s.power + s.agility + s.speed + s.maxHp / 5;
const shares = (s) => { const t = s.power + s.agility + s.speed; return { power: s.power / t, agility: s.agility / t, speed: s.speed / t }; };
const NAMES = { power: '力量', agility: '敏捷', speed: '速度', hp: '生命' };

test('每级升级预算不变：90 级上限，2 点随机 + 1 点系统分配，71~90 每级再发 1 个金宝箱', () => {
  const g = setup(), s = g.s();
  let auto = 0, chests = 0;
  for (let level = 2; level <= 90; level++) {
    const before = total(s);
    const ups = g.State.gainExp(g.GData.nextExp(level - 1));
    assert.equal(ups.length, 1);
    const u = ups[0];
    assert.equal(u.attributeBook, false, '53/59/65 不再发属性书（ssfight 没有这三个奖励）');
    assert.equal(total(s) - before, 4, '每级仍是 3 点属性 + 生命 5');
    assert.equal(u.freePoint, undefined, '升级不产生自由点字段');
    assert.equal(s.freePoints, undefined, '升级不产生待分配点');
    assert.ok(u.autoPoint, '第 3 点必须由系统分配');
    assert.equal(u.autoPointName, NAMES[u.autoPoint]);
    auto++;
    if (level > 70) { assert.equal(u.chest, 1, '71~90 每级 1 个金宝箱'); chests += u.chest; }
    else assert.equal(u.chest, 0, '70 级及以下不发金宝箱');
    // 系统分配若落在力/敏/速，补完必须回到 25% 以上；落在生命则按 5 血=1 点。
    if (u.autoPoint !== 'hp') {
      const sh = shares(s);
      assert.ok(sh[u.autoPoint] >= g.State.STAT_SHARE_MIN - 1e-9, u.autoPoint + ' 补过之后应回到 25% 以上：' + JSON.stringify(sh));
    }
  }
  assert.equal(auto, 89, '2~90 级共 89 次成长，全部系统分配');
  assert.equal(chests, 20, '71~90 共 20 个金宝箱');
  assert.equal(s.level, 90);
  assert.equal(total(s), 378, '初始 22 + 89×4 = 378（不含神迹/天梯丸/金宝箱）');
});

test('三项占比：力/敏/速低于 25% 必须补，正好 25% 不算过低；生命不参与', () => {
  const g = setup(), s = g.s();
  // 20/20/20 —— 三项各 33.3%，都达标
  s.power = 20; s.agility = 20; s.speed = 20; s.maxHp = 400;
  assert.equal(g.State.forcedStat(), null, '三项都达标');
  // 13/20/20 —— 力量 24.5%，低于 25%
  s.power = 13;
  assert.equal(g.State.forcedStat(), 'power');
  s.power = 30; s.agility = 15; s.speed = 30; s.maxHp = 250;
  assert.equal(g.State.forcedStat(), 'agility', '取最低的那一项');
  // 生命低不参与三项占比：三围 42.1/31.6/26.3 都达标，不强制补生命
  s.power = 40; s.agility = 30; s.speed = 25; s.maxHp = 50;
  assert.equal(g.State.forcedStat(), null);
  // 15/15/30 —— 力/敏正好 25%，不算过低
  s.power = 15; s.agility = 15; s.speed = 30; s.maxHp = 300;
  assert.equal(g.State.forcedStat(), null);
  // 也接受外部数据对象（genAI 的成长对象用 maxHp 存血）
  assert.equal(g.State.forcedStat({ power: 30, agility: 30, speed: 30, maxHp: 300 }), null);
  assert.equal(g.State.forcedStat({ power: 100, agility: 30, speed: 30, maxHp: 10 }), 'agility');
  assert.equal(g.State.lowestStat({ power: 100, agility: 30, speed: 31, maxHp: 10 }), 'hp');
});

test('金宝箱属性点直接自动随机分配，不再产生自由点', () => {
  const g = setup(), s = g.s();
  s.level = 90; s.exp = 0; s.props[90] = 1;
  s.power = 30; s.agility = 30; s.speed = 30; s.maxHp = 300; s.hp = 300;
  g.math.random = () => 0.52; // 金宝箱点数档（12 点）
  const before = total(s);
  const begin = g.State.beginChest(90);
  assert.equal(begin.ok, true);
  assert.equal(begin.pending.reward.kind, 'points', '本次开箱应命中属性点');
  assert.equal(begin.pending.reward.count, 12);
  const done = g.State.confirmChest();
  assert.equal(done.ok, true);
  assert.match(done.msg, /自动随机分配/);
  assert.equal(total(s), before + 12, '12 点全部直接落到四维');
  assert.equal(s.freePoints, undefined, '不再写 freePoints');
  assert.equal(g.State.pendingPoints, undefined, '不再有 pendingPoints 接口');
  assert.equal(g.State.allocatePoint, undefined, '不再有手工加点接口');
  assert.equal(g.State.allocateEvenly, undefined);
  assert.equal(g.State.undoPoint, undefined);
});

test('升级不再挂起自由点：全部由系统分配，力/敏/速过低时补最低项', () => {
  const g = setup(), s = g.s();
  s.level = 20; s.exp = 0; s.power = 100; s.agility = 40; s.speed = 40; s.maxHp = 100;
  const ups = g.State.gainExp(g.GData.nextExp(20));
  assert.equal(ups.length, 1);
  assert.ok(['agility', 'speed'].includes(ups[0].autoPoint), '三项过低时系统补最低项');
  assert.equal(ups[0].freePoint, undefined);
  assert.equal(s.maxHp, 100 + ups[0].hp, '系统点没有加到生命（生命不参与三项占比）');
  assert.equal(s.freePoints, undefined, '升级不产生待分配点');
  // 三项均衡时也由系统分配，不再挂起等玩家
  s.power = 30; s.agility = 30; s.speed = 30; s.maxHp = 300;
  const ups2 = g.State.gainExp(g.GData.nextExp(s.level));
  assert.ok(ups2[0].autoPoint, '三项均衡时仍由系统分配');
  assert.equal(ups2[0].freePoint, undefined);
  assert.equal(s.freePoints, undefined);
});

test('旧存档 freePoints 读档时自动分配并删除字段', () => {
  const g = setup(), s = g.s();
  s.power = 30; s.agility = 30; s.speed = 30; s.maxHp = 300; s.hp = 300;
  const raw = { ...s, freePoints: 4 };
  g.storage.set(g.State.saveKey, JSON.stringify(raw));
  const before = total(s);
  g.State.load();
  const after = g.s();
  assert.equal(total(after), before + 4, '4 点直接落到四维');
  assert.equal(after.freePoints, undefined, '读档后不再保留 freePoints');
  g.State.save();
  assert.equal(g.saved().freePoints, undefined, '写盘也不再带 freePoints');
  assert.equal(g.State.pendingPoints, undefined);
});

test('对手（genAI）与玩家共用同一套成长预算、三项口径与占比门槛', () => {
  const g = setup();
  for (const level of [5, 10, 15, 20, 25, 40, 53, 70, 90]) {
    for (let i = 0; i < 30; i++) {
      const foe = g.State.genAI(level, '', { levelJitter: 0, gearSelfLevel: true, gear: false });
      assert.equal(foe.baseStats.power + foe.baseStats.agility + foe.baseStats.speed + foe.baseStats.hp / 5,
        22 + (level - 1) * 4, '等级 ' + level);
      assert.equal(foe.baseStats.hp % 5, 0);
      const b = foe.baseStats;
      const t = b.power + b.agility + b.speed;
      const sh = { power: b.power / t, agility: b.agility / t, speed: b.speed / t };
      const sum = sh.power + sh.agility + sh.speed;
      assert.ok(Math.abs(sum - 1) < 1e-9, '三项占比相加为 1');
      // 25% 是「系统点只能这样加」的下限；随机成长仍可能把某一项压到 25% 以下，
      // 下一级系统点再补。这里只守住自然成长不会被饿到 15% 以下。
      for (const key of ['power', 'agility', 'speed']) assert.ok(sh[key] > 0.15, '等级 ' + level + ' ' + key + '=' + sh[key].toFixed(3));
    }
  }
});

test('随机敌人总属性夹在正常玩家与高配上限之间，且期望随等级增长', () => {
  const g = setup();
  let prevLo = -1, prevHi = -1;
  for (let level = 1; level <= 90; level++) {
    const lo = g.State.playerNormalTotal(level);
    const hi = g.State.playerMaxTotal(level);
    assert.ok(lo > 0 && hi > lo, level + ' 级上下限必须有效：' + lo + ' / ' + hi);
    assert.ok(lo >= prevLo, level + ' 级正常玩家下限倒退了');
    assert.ok(hi >= prevHi, level + ' 级高配上限倒退了');
    prevLo = lo;
    prevHi = hi;
  }
  const levels = [10, 20, 30, 40, 50, 60, 70, 90];
  let prevAvg = -1;
  for (const level of levels) {
    const lo = g.State.playerNormalTotal(level);
    const hi = g.State.playerMaxTotal(level);
    let sum = 0;
    for (let i = 0; i < 40; i++) {
      const foe = g.State.genAI(level, '', { levelJitter: 0, gearSelfLevel: true });
      const total = g.State.foeTotalStats(foe);
      assert.ok(total >= lo - 1e-6, level + ' 级总属性低于正常玩家：' + total + ' < ' + lo);
      assert.ok(total <= hi + 1e-6, level + ' 级总属性超过高配上限：' + total + ' > ' + hi);
      assert.equal(foe.hp, foe.maxHp, level + ' 级随机敌人必须满血生成');
      sum += total;
    }
    const avg = sum / 40;
    assert.ok(avg > prevAvg, level + ' 级总属性期望没有随等级增长：' + avg + ' <= ' + prevAvg);
    prevAvg = avg;
  }
  /* 上下限夹取本身也要能从极端值拉回来，不能只靠自然生成恰好落在区间里。 */
  const low = { level: 90, power: 1, agility: 1, speed: 1, hp: 5, maxHp: 5 };
  g.State.applyFoeTotalBounds(low);
  assert.ok(g.State.foeTotalStats(low) >= g.State.playerNormalTotal(90), '极低属性要被抬到正常玩家下限');
  assert.equal(low.hp, low.maxHp, '抬升后生命上限同步');
  const high = { level: 90, power: 99999, agility: 99999, speed: 99999, hp: 999999, maxHp: 999999 };
  g.State.applyFoeTotalBounds(high);
  assert.ok(g.State.foeTotalStats(high) <= g.State.playerMaxTotal(90), '极高属性要被压到高配上限');
  assert.equal(high.hp, high.maxHp, '压低后生命上限同步');
});

test('随机对手难度系数只放大最终战斗属性，不改成长预算', () => {
  const g = setup();
  for (const level of [15, 30, 50, 70, 90]) {
    for (let i = 0; i < 10; i++) {
      const foe = g.State.genAI(level, '', { levelJitter: 0, gearSelfLevel: true, gear: false, statScale: 1.08 });
      assert.equal(foe.baseStats.power + foe.baseStats.agility + foe.baseStats.speed + foe.baseStats.hp / 5,
        22 + (level - 1) * 4, '成长预算仍按原值');
      assert.equal(foe.statScale, 1.08);
      for (const key of ['power', 'agility', 'speed']) {
        assert.ok(foe[key] >= Math.round(foe.baseStats[key] * 1.08) - 1, '等级 ' + level + ' ' + key);
      }
      assert.ok(foe.hp >= Math.round(foe.baseStats.hp * 1.08) - 1, '等级 ' + level + ' hp');
    }
  }
});

test('90 级总获取额对齐 ssfight：378 + 20×12 + 神迹 29 + 天梯永久丸 4 = 651', () => {
  const g = setup(), s = g.s();
  for (let level = 2; level <= 90; level++) g.State.gainExp(g.GData.nextExp(level - 1));
  const base = total(s);
  assert.equal(base, 378, '1~90 每级 4 点：22 + 89×4');
  assert.equal(s.props[90], 20, '71~90 共 20 个金宝箱');
  /* 强制落在 12 点档（[0.51, 0.54)）：验证 20 箱的**上限**正好是 240。 */
  g.math.random = () => 0.52;
  for (let i = 0; i < 20; i++) {
    assert.equal(g.State.beginChest(90).ok, true, '第 ' + (i + 1) + ' 箱');
    assert.equal(g.State.confirmChest().ok, true, '第 ' + (i + 1) + ' 箱领取');
  }
  assert.equal(total(s) - base, 240, '20 箱 ×12 点');
  /* 神迹 1→30 共 29 次升级，每次 1 点；天梯商店力/敏/速/血永久丸各限 1 次 = 4 点。 */
  assert.equal(378 + 240 + 29 + 4, 651, 'ssfight 90 级理论上限');
});

test('71~90 金宝箱按账号累计 20 个：读档/继续升级都不会重复发', () => {
  const g = setup(), s = g.s();
  /* 已经发满 20 个的账号继续升到 90：不再发新箱子。 */
  s.level = 40; s.levelChests = 20;
  g.State.gainExp(100000000);
  assert.equal(s.level, 90);
  assert.equal(s.levelChests, 20, '账号累计仍是 20');
  assert.ok(!(s.props[90] > 0), '发满 20 个后重新升到 90 不再发金宝箱');
});

test('永久属性点 651 硬上限：正常可到顶，调试/旧档/属性道具都不能突破', () => {
  const g = setup(), s = g.s();
  assert.equal(g.State.STAT_HARD_CAP, 651, '硬上限常量');
  /* 直接模拟调试/控制台把四维写成天文数字：save 必须收口。 */
  s.power = 9999; s.agility = 9999; s.speed = 9999; s.maxHp = 99999; s.hp = 99999;
  g.State.save();
  assert.equal(g.State.permanentStatTotal(), 651, '收口后正好 651');
  assert.equal(s.maxHp % 5, 0, '生命按 5 点一格保存');
  assert.ok(s.hp <= s.maxHp, '当前生命不能高于上限');
  /* 顶到上限后，永久属性道具拒绝使用且不扣道具（调试无限发也没用）。 */
  s.props[16] = 2;
  assert.equal(g.State.useProp(16).ok, false);
  assert.equal(s.props[16], 2, '被上限拦下时不消耗道具');
  s.props[37] = 1;
  assert.equal(g.State.useProp(37, { power: 8, agility: 0, speed: 0 }).ok, false);
  assert.equal(s.props[37], 1, '属性书也不消耗');
  /* 留 1 点空间时，普通永久丸正好补到 651；再吃一颗被拒。 */
  s.power = 640; s.agility = 1; s.speed = 1; s.maxHp = 40;
  assert.equal(g.State.permanentStatTotal(), 650);
  s.props[16] = 2;
  assert.equal(g.State.useProp(16).ok, true);
  assert.equal(g.State.permanentStatTotal(), 651);
  assert.equal(g.State.useProp(16).ok, false, '第二颗不能越过 651');
  assert.equal(s.props[16], 1, '第二颗保留');
  /* 属性转化丸只搬运点数、不增加总额：到顶后必须照常可用，不能被硬上限误伤。 */
  s.power = 300; s.agility = 200; s.speed = 140; s.maxHp = 55; s.hp = 55;
  assert.equal(g.State.permanentStatTotal(), 651);
  s.props[10] = 1;
  const conv = g.State.useProp(10, 'agility');
  assert.equal(conv.ok, true, '到顶后力量转化丸仍可使用');
  assert.equal(s.power, 299, '力量 -1');
  assert.equal(s.agility, 201, '敏捷 +1');
  assert.equal(g.State.permanentStatTotal(), 651, '转化后总额不变，仍是 651');
  assert.equal(s.props[10], undefined, '转化丸正常消耗');
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.stack); }
}
console.log(`${tests.length - failed}/${tests.length} free point tests passed`);
process.exitCode = failed ? 1 : 0;
