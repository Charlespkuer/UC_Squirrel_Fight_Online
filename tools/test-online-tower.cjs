'use strict';
/* ============================================================
 * tools/test-online-tower.cjs — 联机版无尽塔（零局外奖励）回归
 * ------------------------------------------------------------
 * 覆盖用户 2026-11 的五条口径：
 *   ① 联机版村庄右上角的小径 → 原版 4421 确认框 → 无尽塔页面；
 *   ② 无尽塔不要求「通关前 18 关」，但**新开局要 20 级**；
 *   ③ 对局进度只存本机（TowerLocal），不写账号存档 / 不发任何局外奖励；
 *   ④ 每日抽奖的十连抽在联机版恢复，服务端按 10 次逐次扣费开奖；
 *   ⑤ 村庄无尽塔 20 级解锁：19 级拒绝、20 级放行。
 *
 * 跑法：`node tools/test-online-tower.cjs`（无参数）
 * ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

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

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** 最小联机环境：只把塔真正用到的脚本装进来。 */
function boot() {
  const store = new Map();
  const c = {
    console,
    Date,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  c.window = c;
  c.self = c;
  c.__SSDZ_ONLINE__ = true;
  c.Net = { account: () => ({ accountId: 'tower-test-account' }) };
  c.Online = { ready: false, on: () => {}, emit: () => {} };
  c.UI = { classic: { btn: () => '', modal: () => {}, home: () => {}, toast: () => {} }, toast: () => {} };
  c.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    visibilityState: 'visible',
  };
  c.navigator = {};
  vm.createContext(c);
  for (const file of [
    'js/gamedict.js', 'js/engine.js', 'js/gamedata.js', 'js/tower-data.js', 'js/tower-rewards.js',
    'js/state.js', 'js/sim.js', 'js/tower-hero.js', 'js/tower.js', 'js/tower-online.js',
  ]) {
    vm.runInContext(read(file), c, { filename: file });
  }
  return c;
}

/** 开一局干净的无尽塔：不填任何关卡，验证联机版没有 18 关门槛。 */
function start(c) {
  c.State.newGame('联机塔回归' + Math.random());
  const s = c.State.state();
  s.level = 70;
  s.props[23] = 30;
  c.Tower.setStoryEnabled(false);
  c.Tower._debugSetNoFlowBuffs(true);
  c.Tower._debugSetNoMintShop(true);
  const out = c.Tower.startEndlessRun();
  assert.equal(out.ok, true, '联机版应当不要求前 18 关就能开局：' + (out.msg || ''));
  return s;
}

test('村庄小径：矢量入口 + 原版 4421 确认框（不自绘确定 / 取消）', () => {
  const ui = read('js/ssfight/ui-tower-path.js');
  assert.match(ui, /SfChallenge\.openOriginalConfirm/, '确认框要复用原版 4421 的 openOriginalConfirm');
  assert.match(ui, /swapButtons:\s*true/, '联机版要把原版按钮调成取消在左、确定在右');
  assert.match(ui, /el\('polygon'/, '小径用错落的石块铺路');
  assert.ok(ui.indexOf('tp-glow') < 0 && ui.indexOf('tp-trail') < 0, '小径不要再带塔 / 光晕 / 旧土路元素');
  assert.match(ui, /accept:\s*run/, '确认回调要真正进入无尽塔');
  assert.match(ui, /endlessUnlocked\(\)/, '点击小径前要检查 20 级解锁');
  assert.match(ui, /showLocked\(lock\.msg\)/, '未到 20 级只提示、不打开确认框');
  assert.match(ui, /UI\.toast\(message\)/, '等级不够要走临时飘字，不要弹窗');
  assert.ok(ui.indexOf("el('title')") < 0, '小径不要再挂原生 <title>，否则悬停会冒出「远方的无尽之塔」');
  const css = read('css/online.css');
  assert.match(css, /\.sf-tower-path\s*\{[^}]*outline:\s*none/s, '小径要清掉浏览器默认的黑色焦点框');
  assert.match(css, /\.sf-tower-path\s*\{[^}]*tap-highlight-color:\s*transparent/s, '小径要清掉移动端点击高亮');
  assert.match(ui, /TowerUI\.openEndless\(\{ from: 'village' \}\)/, '确认后从村庄进入无尽塔页面');
  assert.ok(ui.indexOf('data-tower-path') >= 0, '小径要带可测试的标记');
  const index = read('scripts/index-online.html');
  assert.match(index, /js\/ssfight\/ui-tower-path\.js/, '入口脚本要进联机版加载链');
  assert.match(index, /js\/tower-loader\.js/, '塔按需加载器要进联机版加载链');
  const loader = read('js/tower-loader.js');
  assert.match(loader, /css\/tower\.css/, '塔的样式要由加载器按需拉取');
  assert.match(loader, /js\/tower-online\.js/, '本机塔存档与塔状态机要加载');
  assert.match(loader, /js\/tower-ui\.js/, '无尽塔页面要加载');
  const main = read('js/ssfight/ui-main.js');
  assert.match(main, /SfTowerPath\.mount\(view, container\)/, '村庄挂载时要画出小径');
});

test('村庄无尽塔 20 级解锁：19 级拒绝、20 级放行', () => {
  const c = boot();
  c.State.newGame('等级门槛' + Math.random());
  const s = c.State.state();
  s.level = 19;
  assert.equal(c.Tower.endlessUnlocked().ok, false, '19 级不应解锁');
  const low = c.Tower.startEndlessRun();
  assert.equal(low.ok, false, '19 级不应能开局');
  assert.match(String(low.msg || ''), /20 级解锁/, '提示要写明 20 级解锁');
  s.level = 20;
  assert.equal(c.Tower.endlessUnlocked().ok, true, '20 级应解锁');
  const started = c.Tower.startEndlessRun();
  assert.equal(started.ok, true, '20 级应能开局：' + (started.msg || ''));
  c.Tower.abandon('endless');
});

test('移到小径会清除建筑悬停，点击仍打开确认框', () => {
  class Node {
    constructor() { this.handlers = {}; this.children = []; this.attrs = {}; this.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(n) { this.children.push(n); n.parentNode = this; return n; }
    removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parentNode = null; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.handlers[type] || []) fn({ stopPropagation() {} }); }
  }
  let hovered = true, confirms = 0;
  const svg = new Node();
  svg.__sfRouter = { clear() { hovered = false; } };
  const c = { document: { createElementNS: () => new Node(), activeElement: null },
    SfChallenge: { openOriginalConfirm() { confirms++; } }, Promise };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('js/ssfight/ui-tower-path.js'), c);
  const road = c.SfTowerPath.mount({ g: svg }, {});
  const outline = road.children.find(n => n.attrs.d && n.attrs.fill === '#626c50');
  const points = [...outline.attrs.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const nearLeft = points[0], nearRight = points[points.length - 1];
  const farLeft = points[points.length / 2 - 1], farRight = points[points.length / 2];
  assert.ok(Math.hypot(nearLeft[0] - nearRight[0], nearLeft[1] - nearRight[1]) > 15, '入口应保留宽阔的近景');
  const turn = Math.round((points.length / 2 - 1) * 0.25);
  const turnLeft = points[turn], turnRight = points[points.length - 1 - turn];
  assert.ok(Math.hypot(turnLeft[0] - turnRight[0], turnLeft[1] - turnRight[1]) < 8, '入弯后应快速收窄');
  assert.ok(Math.hypot(farLeft[0] - farRight[0], farLeft[1] - farRight[1]) < 3, '路尽头应收窄');
  road.fire('pointerenter');
  assert.equal(hovered, false);
  hovered = true;
  road.fire('pointermove');
  assert.equal(hovered, false);
  road.fire('click');
  assert.equal(confirms, 1);
});

test('塔战斗收尾不挂主界面：Main.startBattle 必须带 keepScreen', () => {
  const ui = read('js/tower-ui.js');
  const start = ui.indexOf('  function fight(mode) {');
  const end = ui.indexOf('  function winModal(', start);
  assert.ok(start > 0 && end > start, '应当能切出 fight()');
  assert.match(ui.slice(start, end), /keepScreen:\s*true/,
    '塔战斗结束由 reopen() 自己回塔页；不传 keepScreen 会先 showHome() 再被覆盖');
});

test('联机无尽塔：进度只存本机、不发任何局外奖励', () => {
  const c = boot();
  const s = start(c);
  const before = {
    props: JSON.stringify(s.props || {}),
    gold: Number(s.goldPoint) || 0,
    cup: Number(s.goldCup) || 0,
    free: Number(s.lotteryFree) || 0,
  };
  c.Tower._debugSetEndlessLayer(3);
  const nx = c.Tower.nextBattle('endless');
  assert.equal(nx.ok, true, '应当能取到下一场');
  const win = c.Tower.reportBattle('endless', nx.token, true, 800, 1000, { rounds: [] });
  assert.equal(win.ok, true, '这一场应当算赢');
  assert.ok(Number(win.coins) > 0, '局内试炼币照常产出');
  assert.equal(win.tickets, undefined, '单场胜利不发抽奖卷');
  assert.equal(win.milestone, undefined, '单场胜利不发里程碑道具');
  c.TowerLocal.flush();
  const saved = JSON.parse(c.localStorage.getItem('ssdz-online-tower:tower-test-account'));
  assert.equal(saved.v, 2, '本机塔存档要有版本号');
  assert.ok(saved.endless && saved.endless.run, '对局进度要落进本机存档');
  assert.equal(JSON.stringify(s.props || {}), before.props, '不能往账号道具里塞任何东西');
  assert.equal(Number(s.goldPoint) || 0, before.gold, '不能发金松果');
  assert.equal(Number(s.goldCup) || 0, before.cup, '不能发金杯');
  assert.equal(Number(s.lotteryFree) || 0, before.free, '不能送免费抽奖');
  const out = c.Tower.abandon('endless');
  assert.equal(out.ok, true);
  assert.equal(out.tickets, 0, '离场不产抽奖卷');
  assert.equal(out.online, true, '离场结算标记联机预览');
  assert.equal(JSON.stringify(s.props || {}), before.props, '离场也不能补发道具');
});

test('联机无尽塔：塔内临时技能只进本局战斗体，不写账号武技', () => {
  const c = boot();
  const s = start(c);
  const before = JSON.stringify(s.skills || []);
  c.Tower._debugSetEndlessLayer(3);
  const run = c.Tower._debugRun('endless');
  run.pendingPick = { kind: 'skill', id: 14, pct: 0.6, buffId: 'C33' };
  const picked = c.Tower.applyPickBuff('skill', 14);
  assert.equal(picked.ok, true, '小宇宙爆发应当能选：' + (picked.msg || ''));
  assert.equal(JSON.stringify(c.State.state().skills || []), before, '不能把技能永久写进账号');
  assert.ok(run.grantedSkills.includes(14), '临时技能要记在本局 run 上');
  const nx = c.Tower.nextBattle('endless');
  assert.equal(nx.ok, true, '应当能开下一场');
  const me = {
    name: 'p', level: 70, power: 100, agility: 100, speed: 100, maxHp: 5000, hp: 5000,
    baseStats: { power: 100, agility: 100, speed: 100 }, weapons: [], skills: [], wears: [],
    effects: {}, masterLevel: 0,
  };
  nx.adjustMe(me);
  assert.ok(me.skills.some((it) => Number(it && it.id) === 14), '本局战斗体里要带上这个技能');
});

test('联机无尽塔：勇者剧本同样可用，进度也只存本机', () => {
  const c = boot();
  c.State.newGame('勇者塔回归' + Math.random());
  c.State.state().level = 20;
  c.Tower.setStoryEnabled(false);
  c.Tower._debugSetNoFlowBuffs(true);
  const started = c.Tower.startEndlessRun({
    ruleset: 'hero',
    hero: { picks: [{ kind: 'weapon', id: 1 }, { kind: 'weapon', id: 2 }, { kind: 'skill', id: 7 }] },
  });
  assert.equal(started.ok, true, '联机版勇者剧本应当能开局：' + (started.msg || ''));
  const info = c.Tower.endlessInfo();
  assert.equal(info.run.ruleset, 'hero', '对局要标记为勇者剧本');
  assert.ok(info.run.hero && Array.isArray(info.run.hero.weapons), '勇者档案要随本局保存');
  c.TowerLocal.flush();
  const saved = JSON.parse(c.localStorage.getItem('ssdz-online-tower:tower-test-account'));
  assert.equal(saved.endless.run.ruleset, 'hero', '勇者对局也要落进本机存档');
  const before = JSON.stringify({ weapons: c.State.state().weapons, skills: c.State.state().skills });
  c.Tower.abandon('endless');
  assert.equal(JSON.stringify({ weapons: c.State.state().weapons, skills: c.State.state().skills }), before,
    '勇者对局不能改账号武技');
});

test('联机无尽塔：10 / 50 层里程碑、黑卡、失败保底都不发', () => {
  const c = boot();
  const s = start(c);
  const before = JSON.stringify(s.props || {});
  for (const layer of [10, 50]) {
    c.Tower._debugSetEndlessLayer(layer);
    const run = c.Tower._debugRun('endless');
    assert.ok(run && run.plan && run.plan.length > 0, '第 ' + layer + ' 层应当有对手计划');
    run.attempt = 'gate-' + layer;
    run.idx = run.plan.length - 1;
    const rw = c.Tower.reportBattle('endless', run.attempt, true, 900, 1000, { rounds: [] });
    assert.equal(rw.ok, true, '第 ' + layer + ' 层最后一战应当能结算');
    assert.equal(rw.layerComplete, true, '第 ' + layer + ' 层应当真正完成（走到层结算）');
    assert.equal(rw.milestone, undefined, '第 ' + layer + ' 层不发里程碑道具');
    assert.equal(rw.black, undefined, '第 ' + layer + ' 层不发黑色卡片');
    assert.equal(JSON.stringify(c.State.state().props || {}), before, '里程碑 / 黑卡不能写进账号背包');
    c.Tower.abandon('endless');
  }
  const preview = c.Tower.previewSettleTickets();
  assert.equal(preview.total, 0, '结算预览不承诺抽奖卷');
  assert.equal(preview.online, true, '结算预览走联机口径');
});

test('联机无尽塔奖励：每累计 10 层 1 张，周限仍 10 张', () => {
  const c = boot();
  const R = c.TowerRewards;
  assert.equal(R.LAYERS_PER_TICKET, 10, '本局层数奖励改成每 10 层 1 张');
  assert.equal(R.compute(9, 0).raw, 0, '第 9 层还没有层数奖励');
  assert.equal(R.compute(10, 0).raw, 1, '第 10 层给第 1 张');
  assert.equal(R.compute(99, 0).raw, 9, '第 99 层给 9 张');
  assert.equal(R.compute(100, 0).raw, 10, '第 100 层给 10 张');
  const first = R.settle({ week: '2026-11-16', box: R.emptyWeek('2026-11-16'), layer: 90, mint: 0, runId: 'ten-1' });
  assert.equal(first.result.granted, 9, '第 90 层给 9 张');
  const over = R.settle({ week: '2026-11-16', box: first.box, layer: 95, mint: 0, runId: 'ten-2' });
  assert.equal(over.result.granted, 1, '只剩 1 张额度时只补 1 张');
  const full = R.settle({ week: '2026-11-16', box: over.box, layer: 99, mint: 0, runId: 'ten-3' });
  assert.equal(full.result.granted, 0, '周上限仍是 10 张，超过不再发');
  assert.equal(full.result.weekLeft, 0);
});

test('联机无尽塔百层奖励：通过 >=100 层每周首次额外 +2 张，不占周限、同一周只发一次', () => {
  const c = boot();
  const R = c.TowerRewards;
  assert.equal(R.BONUS_MIN_LAYER, 100, '百层奖励门槛是 100 层');
  assert.equal(R.TRUE_END_BONUS_TICKETS, 2, '百层奖励固定 2 张');
  const below = R.settle({ week: '2026-11-16', box: R.emptyWeek('2026-11-16'), layer: 99, mint: 0, runId: 'bonus-0' });
  assert.equal(below.result.victoryBonus, 0, '第 99 层还没有百层奖励');
  // 周限先由非百层局填满，百层奖励仍未触发：101 层结算应当只补 2 张。
  const fill = R.settle({ week: '2026-11-16', box: R.emptyWeek('2026-11-16'), layer: 90, mint: 0, runId: 'bonus-1' });
  const capped = R.settle({ week: '2026-11-16', box: fill.box, layer: 95, mint: 0, runId: 'bonus-2' });
  assert.equal(capped.result.granted, 1);
  assert.equal(capped.result.weekUsed, 10);
  assert.equal(capped.box.trueEndBonus, false, '没到 100 层不触发百层奖励');
  // 旧客户端在 101 层仍会传 trueEnd:false；服务端按层数判定，照样发百层奖励。
  const at101 = R.settle({ week: '2026-11-16', box: capped.box, layer: 101, mint: 0, runId: 'bonus-3', trueEnd: false });
  assert.equal(at101.result.granted, 2, '周限已满时，第 101 层仍补发 2 张百层奖励');
  assert.equal(at101.result.victoryBonus, 2);
  assert.equal(at101.result.weekUsed, 10, '额外 2 张不占周限');
  assert.equal(at101.result.weekLeft, 0);
  assert.equal(at101.result.capped, true);
  assert.equal(at101.result.trueEnd, true);
  assert.equal(at101.box.trueEndBonus, true, '本周百层奖励要落账');
  assert.equal(R.normalizeWeek(at101.box).trueEndBonus, true, '读档清洗后百层奖励周标记不能丢');
  const duplicate = R.settle({ week: '2026-11-16', box: at101.box, layer: 101, mint: 0, runId: 'bonus-3', trueEnd: false });
  assert.equal(duplicate.result.duplicate, true);
  assert.equal(duplicate.result.granted, 2, '同一局重试仍返回含额外奖励的原结果，不重发');
  const again = R.settle({ week: '2026-11-16', box: at101.box, layer: 200, mint: 0, runId: 'bonus-4' });
  assert.equal(again.result.granted, 0, '本周周限与百层奖励都已用尽，不再发');
  assert.equal(again.result.victoryBonus, 0);
  assert.equal(again.result.victoryBonusUsed, true);
  const nextWeek = R.settle({ week: '2026-11-23', box: again.box, layer: 100, mint: 0, runId: 'bonus-5' });
  assert.equal(nextWeek.result.granted, 12, '跨周重置后百层奖励可再次触发');
  assert.equal(nextWeek.result.victoryBonus, 2);
  const towerOnline = read('js/tower-online.js');
  const towerUi = read('js/tower-ui.js');
  assert.match(towerOnline, /claim\.trueEnd === true/, '结算队列仍保留旧结局标记，断线重试不丢字段');
  assert.match(towerUi, /trueEnd: summary\.trueEnd === true \|\| summary\.outcome === 'win'/, '结算页仍把百层奖励标记交给服务端');
  assert.match(towerUi, /通过 100 层奖励/, '结算页要显示百层奖励');
});

test('联机无尽塔结算徽标：按剧本显示「联机版·经典模式 / 联机版·勇者模式」', () => {
  const ui = read('js/tower-ui.js');
  assert.match(ui, /ONLINE\s*\n\s*\?\s*\(summary\.ruleset === 'hero' \? '联机版·勇者模式' : '联机版·经典模式'\)/,
    '联机版结算徽标按 summary.ruleset 选择标签');
  assert.ok(!/勇者剧本 · ' : ''\) \+ mode/.test(ui), '联机版徽标不再追加「勇者剧本 · 」前缀');
});

test('联机每日抽奖：十连抽恢复，服务端按 10 次开奖并逐次扣费', () => {
  const c = boot();
  c.State.newGame('抽奖十连');
  const s = c.State.state();
  s.lotteryDate = c.State.localDate();
  s.lotteryFree = 10;
  s.goldPoint = 1000;
  s.props[50] = 10;
  const out = c.State.lotteryDraw(10);
  assert.equal(out.ok, true, '抽奖应当能开');
  assert.equal(out.count, 10, '联机版十连请求要开 10 次');
  assert.equal(out.draws.length, 10, '返回 10 个结果');
  assert.equal(Number(s.lotteryFree), 0, '先扣 10 次免费机会');
  assert.equal(Number(s.props[50]), 10, '免费次数够时不应扣抽奖卷');
  assert.ok(Number(s.goldPoint) >= 1000, '免费次数够时不应扣金松果（中奖金松果可增加）');
  const extras = read('js/classic-extras.js');
  assert.match(extras, /button\('\\u8fde\\u62bd 10 \\u6b21', 'lottery-spin10'/, '联机版要生成十连抽按钮');
  assert.ok(!/ONLINE \? '' : button/.test(extras), '十连抽按钮不能只给单机');
});

if (failures.length) {
  console.error('\n' + failures.length + ' 项失败');
  process.exit(1);
}
console.log('\n联机无尽塔回归：' + pass + ' 通过 / 0 失败');
