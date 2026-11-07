'use strict';
/* ============================================================
 * tools/test-online-swap.cjs — 防守视角交换的可执行尺子
 * ------------------------------------------------------------
 * 服务端只存 canonical（挑战者 side 0）。防守方看录像时把 `result` 左右对调，
 * 对调必须满足三条（docs/联机实现方案.md §4.8 的验收口径）：
 *   ① `swapResult(swapResult(r))` 与原值**逐字段相等**（随机 200 场）；
 *   ② 对调后每回合 `hpAfter` 仍是「自己/对手」两列，且与原来互换；
 *   ③ 对调后 `winner` 翻转，其它标量字段不被误伤。
 * 另外核对 `Sim` 新增的「带 side 语义」的字段都进了交换表 —— 漏一个就会把
 * 「装死/提示」画在错的人身上。
 * ============================================================ */
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'server', 'game', 'runtime.js'));
const battle = require(path.join(ROOT, 'server', 'game', 'battle.js'));

runtime.boot();
const State = globalThis.State;
const Sim = globalThis.Sim;

/* 一份可以长出各种字段的随机存档（武器/技能/幻兽/装备都随机） */
function randomFighter(name, level) {
  const stats = { power: 10 + Math.random() * 60, agility: 10 + Math.random() * 60, speed: 10 + Math.random() * 60, hp: 120 + Math.random() * 900 };
  const weapons = [];
  for (let i = 0; i < 4; i++) {
    const id = 1 + Math.floor(Math.random() * 17);
    weapons.push({ id, level: 1 + Math.floor(Math.random() * 15) });
  }
  const skills = [];
  for (let i = 0; i < 5; i++) {
    const id = 1 + Math.floor(Math.random() * 24);
    skills.push({ id, level: 1 + Math.floor(Math.random() * 15) });
  }
  return {
    name, level,
    power: stats.power, agility: stats.agility, speed: stats.speed,
    hp: stats.hp, maxHp: stats.hp,
    baseStats: { power: 20, agility: 20, speed: 20, hp: 100 },
    weapons, skills, gears: [], effects: {}, pets: [],
  };
}

function deepEqual(a, b, label) {
  try { assert.deepStrictEqual(a, b); } catch (e) {
    console.log('FAIL ' + label);
    throw e;
  }
}

let fails = 0;
function run(name, fn) {
  try { fn(); console.log('PASS ' + name); } catch (e) { fails++; console.log('FAIL ' + name + ' — ' + e.message); }
}

/* ---------- ① 交换两次回原值（随机 200 场） ---------- */
run('交换两次逐字段回原值（随机 200 场）', () => {
  for (let i = 0; i < 200; i++) {
    const me = randomFighter('甲', 1 + Math.floor(Math.random() * 80));
    const foe = randomFighter('乙', 1 + Math.floor(Math.random() * 80));
    const result = Sim.simulate(me, foe);
    const back = battle.swapResult(battle.swapResult(result));
    deepEqual(back, result, '第 ' + i + ' 场：swap 两次与原值不一致');
  }
});

/* ---------- ② 两列血量真的互换了 ---------- */
run('两列血量/护盾/剥衣与 maxHp/names 互换', () => {
  for (let i = 0; i < 60; i++) {
    const result = Sim.simulate(randomFighter('甲', 30), randomFighter('乙', 30));
    const swapped = battle.swapResult(result);
    assert.deepStrictEqual(swapped.maxHp, [result.maxHp[1], result.maxHp[0]]);
    assert.deepStrictEqual(swapped.names, [result.names[1], result.names[0]]);
    assert.deepStrictEqual(swapped.startShell, [result.startShell[1], result.startShell[0]]);
    for (let k = 0; k < result.rounds.length; k++) {
      const a = result.rounds[k], b = swapped.rounds[k];
      assert.deepStrictEqual(b.hpAfter, [a.hpAfter[1], a.hpAfter[0]], 'hpAfter 没互换');
      assert.strictEqual(b.attacker, 1 - a.attacker, 'attacker 没翻转');
      if (a.shellAfter) assert.deepStrictEqual(b.shellAfter, [a.shellAfter[1], a.shellAfter[0]]);
      if (a.stripLeft) assert.deepStrictEqual(b.stripLeft, [a.stripLeft[1], a.stripLeft[0]]);
    }
  }
});

/* ---------- ③ winner 翻转 ---------- */
run('winner 翻转、非边字段不动', () => {
  const result = Sim.simulate(randomFighter('甲', 40), randomFighter('乙', 40));
  const swapped = battle.swapResult(result);
  assert.strictEqual(swapped.winner, 1 - result.winner);
  assert.strictEqual(swapped.rounds.length, result.rounds.length);
  for (const key of Object.keys(result)) {
    if (['rounds', 'winner', 'maxHp', 'names', 'startShell'].includes(key)) continue;
    assert.deepStrictEqual(swapped[key], result[key], '不该动的字段被改了：' + key);
  }
});

/* ---------- ④ 带 side 语义的字段表要和 sim 对得上 ---------- */
run('交换表覆盖 sim 里所有「按边编号」的字段', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'js', 'sim.js'), 'utf8');
  const found = new Set();
  /* 形如 `r.<name> = <someone>.side` / `noteSide: x.side` / `fakeDieSide = target.side` */
  for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_$])([A-Za-z_$][\w$]*)\s*[:=]\s*[A-Za-z_$][\w$.]*\.side\b/g)) {
    found.add(m[1]);
  }
  const known = new Set(battle.SIDE_SCALARS.concat(['drainSide']));
  const missing = [...found].filter((name) => !known.has(name));
  assert.deepStrictEqual(missing, [], '这些字段带 side 语义却没进交换表：' + missing.join(', '));
});

/* ---------- ⑤ 客户端必须把服务端 result 交给播放器 ----------
 * 少了这一步，`SfFight.run` / `Battle.run` 会走 `o.result || Sim.simulate(...)`
 * 用**客户端自己的随机流**再算一遍：录像是赢、服务端结算却是输（2026-10 用户报的
 * 「胜利的战斗会被结算为失败」就是这个）。这条是源码断言，改坏了会立刻红。 */
run('main.js 把服务端 result 传给播放器（否则客户端会自己重算）', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  assert.ok(/result:\s*opts\.result/.test(main), 'main.js 的 runBattle 调用必须带 result: opts.result');
  const ob = fs.readFileSync(path.join(ROOT, 'js', 'online-battle.js'), 'utf8');
  assert.ok(/缺少服务端录像/.test(ob), 'online-battle 必须拒绝没有 result 的响应，而不是播一场本地自算的比赛');
});

console.log('');
if (fails) { console.log(fails + ' 条失败'); process.exit(1); }
console.log('5/5 passed');
