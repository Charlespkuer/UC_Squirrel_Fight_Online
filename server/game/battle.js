'use strict';
// server/game/battle.js — 种子、模拟、结果哈希、视角交换
// `Sim.simulate` 只依赖 `Math.random`，所以「同 seed 可复算」的实现就是
// 临时换掉 `Math.random`。三件事必须一起做完：换 → 跑 → 立刻还原。

const crypto = require('node:crypto');

function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  return crypto.randomInt(0, 0x7fffffff);
}

function withSeed(seed, fn) {
  const old = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = old; }
}

function simulate(seed, me, foe, opts) {
  const Sim = globalThis.Sim;
  return withSeed(seed, () => Sim.simulate(me, foe, opts));
}

function hashResult(result) {
  return crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

// 结果里按边编号的字段。新增 sim 字段时，若它带 side 语义，必须加到这里，
// 否则防守方视角会把提示画在错的人身上（`tools/test-online-swap.cjs` 会兜住）。
const SIDE_SCALARS = ['attacker', 'noteSide', 'fakeDieSide', 'counterFakeDieSide'];
const SIDE_PAIRS = ['hpAfter', 'shellAfter', 'stripLeft'];

function swapRound(round) {
  const out = Object.assign({}, round);
  for (const key of SIDE_SCALARS) {
    if (out[key] != null) out[key] = 1 - Number(out[key]);
  }
  for (const key of SIDE_PAIRS) {
    if (Array.isArray(out[key])) out[key] = [out[key][1], out[key][0]];
  }
  if (out.aura && typeof out.aura === 'object' && out.aura.drainSide != null) {
    out.aura = Object.assign({}, out.aura, { drainSide: 1 - Number(out.aura.drainSide) });
  }
  return out;
}

// 把 canonical（挑战者 side 0）结果换成防守方视角。
// 交换两次必须回到原值 —— `tools/test-online-swap.cjs` 用随机 200 场守这条。
function swapResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = Object.assign({}, result);
  out.rounds = (Array.isArray(result.rounds) ? result.rounds : []).map(swapRound);
  if (result.winner != null) out.winner = 1 - Number(result.winner);
  for (const key of ['maxHp', 'startShell', 'names']) {
    if (Array.isArray(result[key]) && result[key].length === 2) {
      out[key] = [result[key][1], result[key][0]];
    }
  }
  return out;
}

module.exports = { mulberry32, randomSeed, withSeed, simulate, hashResult, swapResult, SIDE_SCALARS, SIDE_PAIRS };
