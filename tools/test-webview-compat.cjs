#!/usr/bin/env node
/* ============================================================
 * tools/test-webview-compat.cjs —— 老 WebView（Android 11 / Chromium 8x）兼容契约
 *
 * 与单机版同源的界面代码共用一套规则：
 *   · `inset:` 简写是 Chromium 87+ 才有的；`.classic-home / .classic-page / #app / .title-screen`
 *     这类整屏绝对层在老内核上会因为没有 top/right/bottom/left 塌成 0×0 —— 玩家看到的是
 *     「贴图混乱 / 加载不出来」。所以每条 `inset` 前都必须有长写回退（保留 inset 本身）。
 *   · 经典主页的 `.ssfight-home` 是不透明深绿底：挂载失败/超时不能让它留在页面上，
 *     要摘壳、重试，并退回可点的复刻主页（单机版第四百五十一/四百五十三批）。
 *   · 素材 JSON 先 force-cache、失败再 no-store 重取；标题页要先落一次沉浸。
 *
 * 用法：node tools/test-webview-compat.cjs
 * ============================================================ */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const cssDir = path.join(ROOT, 'css');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.message || e)); }
}

console.log('老 WebView 兼容');

test('CSS 的 inset 都有 top/right/bottom/left 长写回退（Chromium <87 整层塌成 0×0）', () => {
  const declRe = /(^|[;{\n]\s*)inset\s*:\s*([^;}]+)(;?)/g;
  const valueRe = /^-?\d+(?:\.\d+)?(?:px|%)?(?:\s+-?\d+(?:\.\d+)?(?:px|%)?){0,3}$/;
  let checked = 0;
  for (const f of fs.readdirSync(cssDir).filter((x) => x.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(cssDir, f), 'utf8');
    let m;
    while ((m = declRe.exec(text))) {
      if (!valueRe.test(m[2].trim())) continue;      // 注释里的 "inset:0` —— …" 不算声明
      checked++;
      const before = text.slice(Math.max(0, m.index - 240), m.index);
      assert.match(before, /(^|[;{\s])top\s*:/, `${f} 的 inset:${m[2].trim()} 缺 top 长写回退`);
      assert.match(before, /(^|[;{\s])left\s*:/, `${f} 的 inset:${m[2].trim()} 缺 left 长写回退`);
    }
  }
  assert.ok(checked >= 25, 'inset 声明数量异常：只检查到 ' + checked + ' 条');
});

test('经典主页挂载失败/超时能自愈：看门狗 + 重试 + 空壳摘除 + 可点兜底', () => {
  const classic = read('js/classic-ui.js');
  const mainJs = read('js/main.js');
  assert.match(classic, /function mountClassicHome\(box, attempt\)/, '经典主页挂载必须走带恢复的 mountClassicHome');
  assert.match(classic, /setTimeout\(\(\) => finish\(new Error\('挂载超时'\)\)/, '挂载必须有看门狗，不能无限等');
  assert.match(classic, /box\.remove\(\)/, '失败时先摘掉不透明空壳，否则 canvas 主页永远被盖住');
  assert.match(classic, /attempt < 2[\s\S]{0,600}mountClassicHome\(host, attempt \+ 1\)/, '挂载失败要重试');
  assert.match(classic, /forceDomHome = true[\s\S]{0,120}renderHome\(\)/, '首次失败就要退回可点的复刻主页（后台继续重试）');
  assert.match(classic, /style="visibility:hidden"/, '挂载期间空壳必须隐藏（不透明深绿底不能盖住 canvas）');
  assert.match(mainJs, /function ssfightHomeActive\(\)[\s\S]{0,400}querySelector\('svg'\)/, 'ssfightHomeActive 不能只看壳在不在');
  assert.match(mainJs, /function resumeHomeScene\(\)/, 'main.js 必须导出恢复钩子');
  assert.match(mainJs, /async function boot\(\) \{[\s\S]{0,600}applySystemBars\(\)/, '标题页也要先落一次沉浸');
});

test('素材 JSON 失败绕开缓存重取一次（换包后坏缓存不能让主页永久挂不出来）', () => {
  const renderJs = read('js/ssfight/render.js');
  assert.match(renderJs, /async function fetchJson\(file, noCache\)[\s\S]{0,200}no-store/, '素材 JSON 失败要用 no-store 重取');
  assert.match(renderJs, /async function fetchJsonRetry\(file\)/, '必须有重取包装');
});

console.log('');
if (failed) { console.log(`${passed} passed, ${failed} failed`); process.exit(1); }
console.log(`全部通过：${passed}/${passed}`);
