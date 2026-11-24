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

test('HTML 文字描边只在 text-outline.css 出口，安卓统一走 text-shadow 回退', () => {
  for (const f of fs.readdirSync(cssDir).filter((x) => x.endsWith('.css') && x !== 'text-outline.css')) {
    const text = fs.readFileSync(path.join(cssDir, f), 'utf8');
    const re = /-webkit-text-stroke(?:-width|-color)?\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const value = m[1].trim();
      assert.match(value, /^(?:0|0px|var\()/, `${f} 不要直接写描边宽度/颜色（改设 --sw/--ol-c，见 text-outline.css）：${value}`);
    }
  }
  const central = read('css/text-outline.css');
  assert.match(central, /html\.is-android[\s\S]{0,600}text-shadow/, '安卓回退必须是 text-shadow，不能继续用 -webkit-text-stroke');
  assert.match(central, /-webkit-text-stroke-width:\s*0/, '安卓回退要把真描边关掉');
  assert.match(central, /var\(--ol\)[^\n]*var\(--ol-c\)/, '回退阴影要用 --ol/--ol-c 生成外扩描边');
  const html = read('scripts/index-online.html');
  assert.match(html, /css\/text-outline\.css/, '入口页必须加载 text-outline.css');
  assert.match(html, /classList\.add\('is-android'\)/, '入口页要在首帧前给安卓加 is-android');
});

test('深色系统不压暗游戏：WebView 关掉自动深色，入口页只声明浅色', () => {
  const activity = read('src-tauri/android/MainActivity.kt');
  const apkBuild = read('tools/build-online-apk.cjs');
  const html = read('scripts/index-online.html');
  const style = read('css/style.css');
  assert.match(activity, /isAlgorithmicDarkeningAllowed\s*=\s*false/, 'WebView 133 要显式关闭算法深色');
  assert.match(activity, /WebSettings\.FORCE_DARK_OFF/, '旧 WebView 要关掉 forceDark');
  assert.match(apkBuild, /Theme\.MaterialComponents\.Light\.NoActionBar/, 'APK 主题不能再用 DayNight');
  assert.match(apkBuild, /android:forceDarkAllowed/, '主题要显式禁用 forceDarkAllowed');
  assert.match(html, /<meta name="color-scheme" content="light">/, '入口页要声明只支持浅色');
  assert.match(style, /color-scheme:\s*light/, '全局 CSS 要声明 color-scheme: light');
});

test('绿屏兜底链路：原生软件图层开关 + 纯绿取样 + 页面开关与重挂栅格入口', () => {
  const activity = read('src-tauri/android/MainActivity.kt');
  const mainJs = read('js/main.js');
  const settingsJs = read('js/online-settings.js');
  assert.match(activity, /fun setRenderMode\(mode: String\)[\s\S]{0,700}LAYER_TYPE_SOFTWARE/, '原生要能把 WebView 切到软件图层');
  assert.match(activity, /fun probeScreen\(\)[\s\S]{0,1600}isPureGreen\(pixels, probeArea\)/, '原生要抽查画面是不是整块纯绿');
  // 探针常驻 UI 线程：逐点 getPixel 会让低端机每拍掉帧，必须批量取色并按时间退避。
  assert.match(activity, /bitmap\.getPixels\(pixels, 0, probeArea/, '纯绿取样必须一次 getPixels 批取，不能逐点 getPixel');
  assert.doesNotMatch(activity, /\.getPixel\(/, '探针里不要再用逐点 getPixel');
  assert.match(activity, /fun probeDelayMs\(\)[\s\S]{0,400}30_000L/, '探针间隔要随时间退到 30 秒，不能一直高频抓屏');
  assert.match(activity, /setBackgroundColor\(Color\.BLACK\)/, 'WebView 底色必须是不透明黑，不能露出未初始化的合成层');
  assert.match(mainJs, /function applyRenderCompat\(\)[\s\S]{0,300}setRenderMode/, '页面的「画面兼容」要落到原生');
  assert.match(mainJs, /function setRenderCompat\(on\)[\s\S]{0,300}applyRenderCompat\(\)/, '切换开关后要立刻重落一次渲染模式');
  assert.match(mainJs, /window\.__ssdzRepairSurface\s*=/, '页面要暴露重挂栅格的入口给原生');
  assert.match(settingsJs, /render-compat/, '设置页要有「画面兼容」开关');
});

test('静态 SVG 的渐变 id 不能带冒号（WebView 83 的 <img> 解析不到 url(#f2015:2)，填色整块丢失）', () => {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.svg$/i.test(ent.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'images'));
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const refs = [...text.matchAll(/(?:url\(|href=")#([^)"']+)/g)].map((m) => m[1]);
    if (refs.some((id) => id.includes(':'))) bad.push(path.relative(ROOT, file));
  }
  assert.deepEqual(bad, [], '这些 SVG 的渐变/裁剪 id 还带冒号，旧 WebView 会丢掉整层填色：' + bad.join('、'));
  assert.ok(files.length > 100, '静态 SVG 扫描数量异常：' + files.length);
});

console.log('');
if (failed) { console.log(`${passed} passed, ${failed} failed`); process.exit(1); }
console.log(`全部通过：${passed}/${passed}`);
