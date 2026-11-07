'use strict';
/* ============================================================
 * server/game/runtime.js — 把浏览器端游戏代码装进 Node 进程
 * ------------------------------------------------------------
 * `State` / `Sim` / `GData` 都是按浏览器环境写的：加载期只用到
 * `window` / `localStorage` / `document.createElement` 这类很浅的接口，
 * 真正的画面代码在 `Engine` / `ui*.js` 里，服务端**不加载**它们。
 *
 * 三条硬约束（踩过的坑，改之前先读）：
 *  1. `State` 是模块级单例。`restorePayload → 动作 → savePayload` 必须**同步**
 *     跑完，中间不能 `await`，否则两个请求会串档。
 *  2. `saveMode` 也是模块级状态：每次进存档前都要把 `ssdz_ui_mode` 写成
 *     `'classic'`，否则黑装/星标等按界面分流的规则会沿用上一个请求。
 *  3. `Math.random` 是 `Sim` 里唯一的随机源；联机战斗必须换成按 seed 的
 *     mulberry32，且用完立刻还原（见 `game/battle.js`）。
 * ============================================================ */

const path = require('node:path');
const fs = require('node:fs');

const GAME_ROOT = process.env.GAME_ROOT
  ? path.resolve(process.env.GAME_ROOT)
  : path.resolve(__dirname, '..', '..');

/* 服务端要加载的脚本。顺序和 `scripts/index-online.html` 里这几支必须一致：
 * nickname（昵称长度规则）→ campaign-data（征战静态表）→ gamedict（字典）→ engine（外观/装备映射）
 * → gamedata（派生规则）→ state → sim。`campaign-data.js` / `nickname.js` 只放常量与纯函数，
 * 加载顺序对它没有硬依赖，但必须在 `state.js` 之前（newGame 用得到）。 */
const SCRIPTS = ['js/nickname.js', 'js/campaign-data.js', 'js/gamedict.js', 'js/engine.js', 'js/gamedata.js', 'js/state.js', 'js/sim.js', 'js/battle-drops.js'];

let booted = false;
let bootInfo = null;

/* ---------------- 最小 DOM / BOM 桩 ---------------- */
function makeClassList() {
  return {
    add() {}, remove() {}, toggle() {}, contains() { return false; },
    item() { return null; }, forEach() {}, get length() { return 0; },
  };
}

function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    classList: makeClassList(),
    children: [],
    childNodes: [],
    parentNode: null,
    innerHTML: '',
    textContent: '',
    innerText: '',
    width: 0,
    height: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    className: '',
    id: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    insertBefore(c) { this.children.unshift(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    replaceChild(c) { return c; },
    remove() {},
    setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; },
    removeAttribute() {}, setAttributeNS() {}, getAttributeNS() { return null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    append() {}, prepend() {}, before() {}, after() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    closest() { return null; },
    cloneNode() { return makeElement(tag); },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    },
    getContext() { return makeCanvasContext(); },
    toDataURL() { return 'data:,'; },
    focus() {}, blur() {}, click() {},
    load() {}, play() {}, pause() {},
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get nextSibling() { return null; },
    get previousSibling() { return null; },
    get offsetLeft() { return 0; },
    get offsetTop() { return 0; },
  };
  return el;
}

function makeCanvasContext() {
  const noop = () => {};
  return new Proxy({
    canvas: makeElement('canvas'),
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save: noop, restore: noop,
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function installGlobals() {
  const g = globalThis;
  g.window = g;
  /* Server-authoritative saves execute the same State module as the client.
   * The online flag must be set here too: otherwise State falls back to the
   * offline economy branches (daily quests / newbie gift / chest reopen pool)
   * even though every mutation is still happening on the server. */
  g.__SSDZ_ONLINE__ = true;
  /* 服务端标记：每日任务必须由服务端 `questState()` 生成并落库，客户端只读下发结果。 */
  g.__SSDZ_SERVER__ = true;
  // Combat-only flag is kept for callers that explicitly ask for online combat rules.
  g.__SSDZ_ONLINE_COMBAT__ = true;
  g.self = g;
  g.global = g;

  /* 内存版 localStorage：服务端**不**把存档留在浏览器存储里，
   * 但 State 内部会用它记 uiMode 偏好和调试镜像，必须有个能读能写的地方。 */
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(String(k)); },
    clear: () => mem.clear(),
    key: (i) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
  g.localStorage = storage;
  g.__ssdzServerStorage = mem;

  g.sessionStorage = storage;
  if (!g.navigator) {
    try { g.navigator = { userAgent: 'ssdz-online-server', language: 'zh-CN', platform: 'node' }; } catch (_) {}
  }
  g.location = {
    href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1',
    port: '', pathname: '/', search: '', hash: '', origin: 'http://127.0.0.1',
    reload() {}, replace() {}, assign() {}, toString() { return this.href; },
  };

  const body = makeElement('body');
  const documentElement = makeElement('html');
  const head = makeElement('head');
  const doc = {
    nodeType: 9,
    body, head, documentElement,
    cookie: '',
    readyState: 'complete',
    createElement: (tag) => makeElement(tag),
    createElementNS: (ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentNode: null, remove() {} }),
    getElementById: () => null,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  g.document = doc;

  g.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;
  g.setInterval = setInterval;
  g.clearInterval = clearInterval;
  g.Image = function Image() { return makeElement('img'); };
  g.Audio = function Audio() { return makeElement('audio'); };
  g.HTMLCanvasElement = function HTMLCanvasElement() {};
  g.OffscreenCanvas = function OffscreenCanvas() { return makeElement('canvas'); };
  g.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  g.devicePixelRatio = 1;
  g.innerWidth = 1170;
  g.innerHeight = 690;
  g.alert = () => {};
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  if (!g.performance) g.performance = { now: () => Date.now() };
  g.fetch = g.fetch || (() => Promise.reject(new Error('server has no outbound fetch')));
  /* `state.js` 用 `location.search` 判断 `?test=1`；服务端必须是干净的。 */
  try { Object.defineProperty(g.location, 'search', { value: '', writable: true }); } catch (_) {}
}

/** 加载游戏内核脚本；重复调用幂等。 */
function boot(opts) {
  if (booted) return bootInfo;
  installGlobals();
  const files = [];
  for (const rel of SCRIPTS) {
    const abs = path.join(GAME_ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('runtime: 缺少 ' + rel + '（GAME_ROOT=' + GAME_ROOT + '）');
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(abs);
    files.push(rel);
  }
  if (!globalThis.State || !globalThis.Sim || !globalThis.GData || !globalThis.Engine) {
    throw new Error('runtime: 脚本已加载，但全局对象不全（State/Sim/GData/Engine）');
  }
  /* 联机版只有经典界面：把模块级的界面偏好钉死，黑装/星标等分流才稳定。 */
  globalThis.localStorage.setItem('ssdz_ui_mode', 'classic');
  booted = true;
  bootInfo = {
    gameRoot: GAME_ROOT,
    files,
    levelCap: globalThis.State.MAX_PLAYER_LEVEL,
    simVersion: detectSimVersion(),
  };
  return bootInfo;
}

/** 结算/审计里记的版本串：优先读 scripts/version.json，没有就用文件 mtime。 */
function detectSimVersion() {
  try {
    const p = path.join(GAME_ROOT, 'scripts', 'version.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return String(v.version || v.build || 'unknown');
  } catch (_) {
    try {
      const st = fs.statSync(path.join(GAME_ROOT, 'js', 'sim.js'));
      return 'mtime.' + Math.round(st.mtimeMs);
    } catch (_) { return 'unknown'; }
  }
}

/** 服务端的存档槽位：永远是经典单槽。 */
const SLOT_MODE = 'classic';

/**
 * 把库里的存档对象装进 `State`，同步执行 `fn`，再把结果写回来。
 *
 * **回调签名的约定（很容易搞混，写死在这里）**：
 *   `fn({ api, save })`
 *     · `api` = `window.State` 这**一整个模块**（`State.gainExp` / `State.totalStats` …）
 *     · `save` = 当前存档对象（`State.state()` 的返回值，直接改字段用）
 * 回调**必须是同步函数**；返回值会被原样带回。
 *
 * @template T
 * @param {object} raw        存档对象（已解开 gzip / 已解析 JSON）
 * @param {(ctx:{api:object, save:object}) => T} fn
 * @param {{deferSettle?:boolean}} [opts]
 * @returns {{ value:T, payload:object|null }}
 */
function withState(raw, fn, opts) {
  const State = globalThis.State;
  const slot = normalizeSlotPayload(raw);
  /* 先钉界面偏好，再进存档 —— 顺序反了会按上一个请求的界面分流。 */
  globalThis.localStorage.setItem('ssdz_ui_mode', SLOT_MODE);
  if (slot && Object.keys(slot).length) {
    /* `deferSettle`：金宝箱的 begin/reopen/confirm 动作必须把 `chestPending`
     * 原样带进回调；否则读档时的自动结算会把「刚开出的结果」提前入账，
     * 重开永远拿不到 pending。其它动作仍沿用原版「下次进游戏自动入账」。 */
    const ok = State.restorePayload(slot, opts && opts.deferSettle ? { deferSettle: true } : undefined);
    if (!ok) throw badSave('存档结构不合法');
  } else {
    /* 空档：建一个全新的 1 级角色（服务端只在「新号」那一刻这么做）。 */
    State.newGame('小松鼠', { uiMode: SLOT_MODE });
  }
  const value = fn({ api: State, save: State.state() });
  /* `savePayload` 没有导出（它是内部函数），`exportPayload` 返回同一份 JSON 字符串。 */
  const text = State.exportPayload();
  let payload = null;
  try { payload = normalizeSlotPayload(JSON.parse(text)); } catch (_) { payload = null; }
  return { value, payload };
}

/** 规范化一个槽位：删掉双槽字段，uiMode 固定 classic。 */
function normalizeSlotPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.assign({}, raw);
  delete out.__dualMode;
  delete out.__dualOther;
  delete out.__dualSaves;
  out.settings = Object.assign({}, out.settings || {}, { uiMode: SLOT_MODE });
  return out;
}

function badSave(msg) {
  const e = new Error(msg || '存档不合法');
  e.code = 'SAVE_INVALID';
  return e;
}

module.exports = { boot, withState, normalizeSlotPayload, GAME_ROOT, SLOT_MODE, badSave };
