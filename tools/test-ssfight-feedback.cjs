#!/usr/bin/env node
// tools/test-ssfight-feedback.cjs — SfUiFeedback.wireSvg 的唯一接线通道
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const hits = { measure: 0, wrap: 0, shell: 0, refresh: 0, press: 0 };
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  SfUiMain: {
    toolkit: {
      measureHitBox() { hits.measure++; },
      popWrap(clip) { clip.g.__shell = clip.g.__shell || {}; hits.wrap++; },
      wirePopPress() { hits.shell++; },
      refreshShell() { hits.refresh++; },
      setPinned(clip, frame) {
        const want = Math.max(1, Math.round(Number(frame) || 1));
        clip.__pinFrame = null;
        if (clip.frame !== want - 1) clip.gotoAndStop(want);
        clip.playing = false;
      },
      pressFlash(clip, idle, after, onFrame) {
        hits.press++;
        if (onFrame) onFrame(2);
        if (after) after();
        if (onFrame) onFrame(idle);
        if (after) after();
      },
    },
  },
};
sandbox.window = sandbox;
sandbox.SfRender = {
  setPinned(clip, frame) {
    const want = Math.max(1, Math.round(Number(frame) || 1));
    clip.__pinFrame = null;
    if (clip.frame !== want - 1) clip.gotoAndStop(want);
    clip.playing = false;
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/ssfight/ui-feedback.js'), 'utf8'), sandbox);
const F = sandbox.SfUiFeedback;

function makeClip() {
  const listeners = new Map();
  const g = {
    style: {},
    __shell: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    querySelector(sel) { return String(sel).indexOf('uc-pop') >= 0 ? g.__shell : null; },
  };
  const clip = {
    g,
    frame: 0,
    playing: false,
    gotoAndStop(n) { this.frame = n - 1; this.playing = false; },
  };
  return {
    clip,
    count(type) { return (listeners.get(type) || []).length; },
    emit(type, event) { for (const fn of listeners.get(type) || []) fn(event || { stopPropagation() {} }); },
  };
}

/* ① 基础：初始 idle / 悬停 / 离开 / 点击顺序 */
{
  const c = makeClip();
  const calls = [];
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  F.wireSvg(c.clip, {
    idle: () => 1,
    hover: 2,
    press: 0,
    onHover: () => calls.push('hover'),
    after: () => calls.push('after'),
    onFire: () => calls.push('fire'),
  });
  assert.equal(c.clip.frame, 0, '首次接线先停 idle 帧');
  assert.deepEqual(calls, ['after']);
  assert.equal(hits.measure, 1);
  assert.equal(hits.wrap, 1);
  assert.equal(hits.shell, 1);
  assert.equal(c.count('mouseenter'), 1);
  assert.equal(c.count('mouseleave'), 1);
  assert.equal(c.count('click'), 1);
  calls.length = 0;
  c.emit('mouseenter');
  assert.deepEqual(calls, ['hover', 'after'], '悬停先回调 onHover，切帧/刷壳由核心做');
  assert.equal(c.clip.frame, 1, '悬停切到 hover 帧');
  calls.length = 0;
  c.emit('mouseleave');
  assert.deepEqual(calls, ['after']);
  assert.equal(c.clip.frame, 0, '离开回到 idle 帧');
  calls.length = 0;
  c.emit('click', event);
  assert.deepEqual(calls, ['after', 'fire']);
  assert.equal(event.stopped, true, '点击要 stopPropagation');
}

/* ② press：统一走 toolkit.pressFlash，页面不再自己拼按下回调 */
{
  const c = makeClip();
  let fired = 0;
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, press: 2, onFire: () => { fired++; } });
  hits.press = 0;
  c.emit('click');
  assert.equal(hits.press, 1, 'press > 0 时调用一次 pressFlash');
  assert.equal(fired, 1);
  assert.equal(c.clip.frame, 0, '按下结束后回到 idle');
}

/* ③ 重接：同帧不重复 measure/popWrap，换 idle 帧才重新装壳；监听器只有一份 */
{
  const c = makeClip();
  const fired = [];
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, onFire: () => fired.push('old') });
  const measure0 = hits.measure, wrap0 = hits.wrap;
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, onFire: () => fired.push('new') });
  assert.equal(hits.measure, measure0, '同帧重接不重复 measureHitBox');
  assert.equal(hits.wrap, wrap0, '同帧重接不重复 popWrap');
  assert.equal(c.count('click'), 1, '监听器只挂一次');
  c.emit('click');
  assert.deepEqual(fired, ['new'], '重接换掉 onFire');

  F.wireSvg(c.clip, { idle: () => 3, hover: 2, onFire: () => fired.push('three') });
  assert.equal(c.clip.frame, 2, '重接的 idle 帧变化要重新钉帧');
  assert.equal(hits.measure, measure0 + 1, '换帧后重新量热区');
}

/* ④ 悬停中的重接不能把 hover 帧打回 idle */
{
  const c = makeClip();
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, press: 0, onFire: () => {} });
  c.emit('mouseenter');
  assert.equal(c.clip.frame, 1);
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, press: 0, onFire: () => {} });
  assert.equal(c.clip.frame, 1, '悬停时重接保留 hover 帧');
}

/* ⑤ unwireSvg：摘掉业务回调并标记重新装壳；下一次 wire 恢复 */
{
  const c = makeClip();
  let fired = 0;
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, onFire: () => { fired++; } });
  const measure0 = hits.measure;
  F.unwireSvg(c.clip);
  c.emit('click');
  assert.equal(fired, 0, 'unwire 后点击不触发');
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, onFire: () => { fired++; } });
  assert.equal(hits.measure, measure0 + 1, 'unwire 后下一次 wire 重新装壳');
  c.emit('click');
  assert.equal(fired, 1, '重新接线后点击恢复');
}

/* ⑥ refreshOnWire：只在“已接线后的重接”刷新，首次接线不额外刷 */
{
  const c = makeClip();
  const refresh0 = hits.refresh;
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, refreshOnWire: true, onFire: () => {} });
  assert.equal(hits.refresh, refresh0, '首次接线不额外 refresh');
  F.wireSvg(c.clip, { idle: () => 1, hover: 2, refreshOnWire: true, onFire: () => {} });
  assert.equal(hits.refresh, refresh0 + 1, '重接时 refresh 一次');
}

console.log('PASS test-ssfight-feedback（wireSvg 接线 / press / 重接 / unwire / refreshOnWire）');
