'use strict';
/* 登录时结算上次大退遗留的果实 / 升级三选一（js/online-ui.js）。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'online-ui.js'), 'utf8');

function sandbox(state, handle) {
  const calls = [];
  const ctx = {
    console, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  ctx.window = ctx;
  ctx.Online = {
    ready: true,
    toast() {},
    async call(name, ...args) {
      calls.push([name, ...args]);
      return handle(name, ...args);
    },
  };
  ctx.State = state;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, calls };
}

function runners() {
  const out = [];
  out.push(['果实默认使用 + 三选一随机', async () => {
    const { ctx, calls } = sandbox({
      pendingFruitChoices: () => [{ fruit: 47, mode: 'gain', options: [{ kind: 'skill', id: 18 }] }],
      pendingWS: () => 1,
    }, (name) => {
      if (name === 'applyFruitChoice') return { ok: true, msg: '获得了 吸铁大法！' };
      if (name === 'chooseWSRandom') return { ok: true, got: ['移形换位'] };
      return { ok: false, msg: '不该调用 ' + name };
    });
    const notes = await ctx.OnlineUI._.settlePendingChoicesOnBoot();
    assert.deepEqual(calls, [['applyFruitChoice', 47, 'skill', 18], ['chooseWSRandom']]);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /天使果实已自动使用/);
    assert.match(notes[1], /移形换位/);
  }]);
  out.push(['候选失效时按取消消耗，不清空待选', async () => {
    const { ctx, calls } = sandbox({
      pendingFruitChoices: () => [{ fruit: 48, mode: 'lose', options: [{ kind: 'weapon', id: 7 }] }],
      pendingWS: () => 0,
    }, (name) => {
      if (name === 'applyFruitChoice') return { ok: false, msg: '请选择服务器给出的果实候选' };
      if (name === 'cancelFruitChoice') return { ok: true, msg: '已取消（果实已消耗）' };
      return { ok: false };
    });
    const notes = await ctx.OnlineUI._.settlePendingChoicesOnBoot();
    assert.deepEqual(calls, [['applyFruitChoice', 48, 'weapon', 7], ['cancelFruitChoice', 48]]);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /恶魔果实/);
  }]);
  out.push(['网络失败不取消，留给下次登录', async () => {
    const { ctx, calls } = sandbox({
      pendingFruitChoices: () => [{ fruit: 47, mode: 'gain', options: [{ kind: 'skill', id: 18 }] }],
      pendingWS: () => 0,
    }, () => { throw new Error('network'); });
    const notes = await ctx.OnlineUI._.settlePendingChoicesOnBoot();
    assert.deepEqual(calls, [['applyFruitChoice', 47, 'skill', 18]]);
    assert.equal(notes.length, 0);
  }]);
  out.push(['没有待选时一次也不调用', async () => {
    const { ctx, calls } = sandbox({ pendingFruitChoices: () => [], pendingWS: () => 0 }, () => ({ ok: true }));
    const notes = await ctx.OnlineUI._.settlePendingChoicesOnBoot();
    assert.deepEqual(calls, []);
    assert.equal(notes.length, 0);
  }]);
  return out;
}

(async () => {
  for (const [name, run] of runners()) { await run(); console.log('PASS ' + name); }
  console.log('PASS 登录时自动结算果实与升级三选一');
})().catch((e) => { console.error(e); process.exitCode = 1; });
