// net.js — 联机版唯一的网络出口
(function () {
  'use strict';

  const TOKEN_KEY = 'ssdz-online-token';
  const ACCOUNT_KEY = 'ssdz-online-account';
  const BASE_KEY = 'ssdz-online-base';

  const LAST_GOOD_KEY = 'ssdz-online-last-good';
  const DEVICE_KEY = 'ssdz-online-browser-device';
  let identityPromise = null;

  const state = {
    base: '',
    token: '',
    account: null,
    queue: Promise.resolve(),
    online: false,
    lastError: null,
    tried: [],

    discoveredAt: 0,
    discoveredResult: null,

    metaCache: null,
    metaAt: 0,
  };
  const DISCOVER_CACHE_MS = 30 * 1000;
  const META_CACHE_MS = 30 * 1000;
  // 同一屏会并发拉同一条只读接口（例如状态页同时请求好友 / 师徒 / 红点）。
  // 共享 in-flight Promise，弱网下少发一半请求，也避免多个响应互相覆盖。
  const inflightGets = new Map();

  function readStored(key) {
    try {
      const v = localStorage.getItem(key);
      if (v != null) return v;
    } catch (e) {}
    return '';
  }

  function writeStored(key, value) {
    try {
      if (value == null || value === '') localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch (e) {}
  }

  function validateIdentity(value) {
    const device = typeof value === 'string' ? JSON.parse(value) : value;
    if (!device || !/^[A-Za-z0-9_-]{32,128}$/.test(device.id || '') ||
      !['windows', 'android', 'ios', 'browser'].includes(device.platform) ||
      !['machine-guid', 'android-id', 'keychain', 'installation'].includes(device.provider)) {
      throw new Error('设备标识格式无效');
    }
    return { id: device.id, platform: device.platform, provider: device.provider };
  }


  function deviceIdentity() {
    if (identityPromise) return identityPromise;
    identityPromise = (async () => {
      const native = window.__TAURI_INTERNALS__;
      const android = window.SSDZAndroid;
      const packaged = !!native || !!android || /^tauri:/.test(String(window.location && location.protocol)) ||
        /^(tauri\.localhost|localhost\.tauri)$/i.test(String(window.location && location.hostname || ''));
      if (android && typeof android.deviceIdentity === 'function') return validateIdentity(android.deviceIdentity());
      if (native && typeof native.invoke === 'function') {
        let timer;
        try {
          return validateIdentity(await Promise.race([
            native.invoke('online_device_identity'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取设备标识超时')), 6000); }),
          ]));
        } finally { if (timer) clearTimeout(timer); }
      }
      if (packaged) throw new Error('当前安装包没有设备识别接口，请安装最新联机版本');
      let id = readStored(DEVICE_KEY);
      if (!/^[a-f0-9]{64}$/.test(id)) {
        if (!window.crypto || !crypto.getRandomValues) throw new Error('浏览器不支持设备标识生成');
        id = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
        writeStored(DEVICE_KEY, id);
      }
      return { id, platform: 'browser', provider: 'installation' };
    })().catch(error => {
      identityPromise = null;
      throw new NetError(0, 'DEVICE_UNAVAILABLE', '无法确认此设备：' + (error && error.message || '读取失败'));
    });
    return identityPromise;
  }

  function validBase(value) {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('服务器地址必须是 HTTP(S) 地址，不能包含账号或查询参数');
    }
    return url.href.replace(/\/+$/, '');
  }

  function resolveBase(explicit) {
    if (explicit) return validBase(explicit);
    const stored = readStored(BASE_KEY);
    if (stored) { try { return validBase(stored); } catch (_) { writeStored(BASE_KEY, ''); } }
    if (typeof window !== 'undefined' && window.__SSDZ_ONLINE_API__) return validBase(window.__SSDZ_ONLINE_API__);
    try {
      const loc = window.location || {};
      if (/^https?:$/.test(String(loc.protocol || '')) && loc.host) return String(loc.origin || (loc.protocol + '//' + loc.host)).replace(/\/+$/, '');
    } catch (e) {}
    return '';
  }

  // 候选服务地址（按优先级）。
  // 所以启动时并行探一次 `/api/health`，谁先答应用谁（并列时按这里的顺序取前面的）。
  // ② 安装包里的 `__SSDZ_ONLINE_API__`
  function candidates() {
    const out = [];
    const push = (value) => {
      if (!value) return;
      let v;
      try { v = validBase(value); } catch (_) { return; }
      if (!out.includes(v)) out.push(v);
    };
    const stored = readStored(BASE_KEY);
    if (stored) push(stored);
    if (typeof window !== 'undefined') {
      push(window.__SSDZ_ONLINE_API__);
      const extra = window.__SSDZ_ONLINE_API_FALLBACKS__;
      if (Array.isArray(extra)) extra.forEach(push);
    }
    try {
      const loc = window.location || {};
      if (/^https?:$/.test(String(loc.protocol || '')) && loc.host && !/^tauri:/.test(String(loc.protocol))) {
        // Tauri 的页面来自 `http://tauri.localhost`，那不是我们的服务器，不能当候选。
        if (!/^(tauri\.localhost|localhost\.tauri)$/i.test(String(loc.hostname || ''))) {
          push(String(loc.origin || (loc.protocol + '//' + loc.host)));
        }
      }
    } catch (e) {}
    return out;
  }

  function probeOnce(base, timeoutMs, path) {
    const url = base + (path || '/api/health');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, Math.max(800, timeoutMs || 1500)) : null;
    return fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    }).then((res) => {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(() => ({})).then((data) => {
        // 200 但返回 HTML/错误 JSON 的地址不能当成「服务器可用」；
        // 否则登录页会显示已连接，点登录才发现协议不对。
        if (!data || data.ok !== true) throw new Error('服务器没有返回有效的联机数据');
        return data;
      });
    }, (e) => { if (timer) clearTimeout(timer); throw e; });
  }


  function rememberDiscovery(result) {
    state.discoveredAt = Date.now();
    state.discoveredResult = result;
    return result;
  }

  function rememberMeta(data) {
    if (data && data.ok === true && data.actions) {
      state.metaCache = data;
      state.metaAt = Date.now();
      return data;
    }
    return null;
  }

  async function getMeta() {
    if (state.metaCache && Date.now() - state.metaAt < META_CACHE_MS) {
      // meta 是 discover 探测时拿到的；serverTime 要按缓存年龄推进，否则登录页停留
      // 十几秒再登录时，`Online.driftMs` 会把客户端时间拨回去。
      const age = Date.now() - state.metaAt;
      return Object.assign({}, state.metaCache, { serverTime: Number(state.metaCache.serverTime || Date.now()) + age });
    }
    const out = await request('GET', '/api/meta', undefined, { auth: false, device: false, timeoutMs: 8000 });
    rememberMeta(out);
    return out;
  }

  async function discover(opts) {
    const o = opts || {};
    const now = Date.now();
    if (!o.noCache && state.discoveredResult && now - state.discoveredAt < DISCOVER_CACHE_MS && state.online) {
      // `backgroundUpgrade` 可能已经把 base 切到 https；缓存只复用「连得上」这个结论，
      return Object.assign({}, state.discoveredResult, { base: state.base || state.discoveredResult.base });
    }
    const list = candidates();
    state.tried = list.slice();
    if (!list.length) {
      const err = new NetError(0, 'NETWORK', '没有配置服务器地址（安装包里缺 online-config.js）');
      state.lastError = err;
      throw err;
    }
    if (list.length === 1) {
      state.base = list[0];
      try {
        const health = await probeOnce(list[0], o.timeoutMs, '/api/meta');
        rememberMeta(health);
        state.online = true;
        rememberGood(list[0]);
        return rememberDiscovery({ base: list[0], health });
      } catch (e) {
        state.online = false;
        const err = new NetError(0, 'NETWORK',
          '连不上服务器 ' + list[0] + '（' + (e && e.message || '网络错误') + '）');
        state.lastError = err;
        throw err;
      }
    }
    // 快速通道：上次成功过的地址先单独试一次（~1 秒），命中就直接进游戏，
    // 免得每次启动都要等那个连不上的 https 超时。
    const lastGood = readStored(LAST_GOOD_KEY);
    if (!o.noCache && lastGood && list.includes(lastGood)) {
      try {
        const health = await probeOnce(lastGood, 900, '/api/meta');
        rememberMeta(health);
        state.base = lastGood;
        state.online = true;
        state.tried = [lastGood];
        backgroundUpgrade(list, lastGood);
        return rememberDiscovery({ base: lastGood, health, cached: true });
      } catch (e) {  }
    }
    const attempts = list.map((base) => probeOnce(base, o.timeoutMs, '/api/meta')
      .then((health) => ({ base, health }), (error) => ({ base, error })));
    // 并行探，但不等全部：只要「优先级最高的那个」有了结果就定案。
    // · https 被挡 → 头号候选在自身超时后失败，这时再看已经回来的其它候选（通常是 http）。
    const results = new Array(list.length);
    const hit = await new Promise((resolve) => {
      let settled = 0;
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(results.find((r) => r && r.health) || null); };
      const timer = setTimeout(() => { clearTimeout(timer); finish(); }, Math.max(1200, Number(o.timeoutMs) || 3000) + 200);
      list.forEach((base, i) => {
        attempts[i].then((r) => {
          results[i] = r;
          settled++;

          if (i === 0 || settled === list.length) { clearTimeout(timer); finish(); }
        });
      });
    });
    if (hit) {
      state.base = hit.base;
      state.online = true;
      state.tried = [hit.base];
      rememberGood(hit.base);
      rememberMeta(hit.health);

      backgroundUpgrade(list, hit.base);
      return rememberDiscovery({ base: hit.base, health: hit.health, candidates: list });
    }
    state.online = false;
    const detail = list.map((b, i) => b + ' → ' + ((results[i] && results[i].error && results[i].error.message) || '超时')).join('；');
    const err = new NetError(0, 'NETWORK', '连不上服务器（' + detail + '）');
    state.lastError = err;
    throw err;
  }

  function apiUrl(path) {
    const p = String(path || '');
    if (/^https?:\/\//i.test(p)) return p;
    return (state.base || '') + (p.charAt(0) === '/' ? p : '/' + p);
  }

  function rememberGood(base) {
    if (!base) return;
    writeStored(LAST_GOOD_KEY, base);
  }


  function backgroundUpgrade(list, current) {
    const at = list.indexOf(current);
    if (at <= 0) return;
    const prefer = list.slice(0, at).find((b) => /^https:/i.test(b));
    if (!prefer) return;
    probeOnce(prefer, 4000).then(() => {
      if (state.base !== current) return;
      state.base = prefer;
      state.tried = [prefer];
      rememberGood(prefer);
      console.info('[net] 已升级到 ' + prefer);
    }).catch(() => {});
  }

  class NetError extends Error {
    constructor(status, code, msg, body) {
      super(msg || code || ('HTTP ' + status));
      this.name = 'NetError';
      this.status = status;
      this.code = code || 'SERVER';
      this.body = body || null;
    }
  }

  function parseBody(text) {
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { return { raw: String(text).slice(0, 400) }; }
  }

  async function rawRequest(method, path, body, opts) {
    const o = opts || {};
    const headers = { accept: 'application/json' };
    if (o.device !== false) {
      const device = await deviceIdentity();
      headers['x-device-id'] = device.id;
      headers['x-device-platform'] = device.platform;
      headers['x-device-provider'] = device.provider;
    }
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    if (state.token && o.auth !== false) headers.authorization = 'Bearer ' + state.token;
    if (o.idemKey) headers['idempotency-key'] = o.idemKey;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(2000, Number(o.timeoutMs) || 15000);
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, timeout) : null;
    let res, text;
    try {
      res = await fetch(apiUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      text = await res.text();
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw new NetError(0, 'NETWORK', '连不上服务器（' + (e && e.message || '网络错误') + '）');
    }
    if (timer) clearTimeout(timer);
    const json = parseBody(text);
    if (!res.ok || (json && json.ok === false)) {
      const err = (json && json.error) || {};
      throw new NetError(res.status, err.code || 'SERVER', err.msg || (json && json.msg) || ('请求失败（HTTP ' + res.status + '）'), json);
    }
    if (!json || json.ok !== true) throw new NetError(res.status, 'PROTOCOL', '服务器没有返回有效的联机数据，请检查服务器地址');
    return json;
  }


  function request(method, path, body, opts) {
    const o = opts || {};
    // 轮询类只读请求传 `parallel`：不进全局串行队列，弱网下不会把玩家刚点的动作堵在身后。
    // 只有幂等的只读接口（红点 / 更新 / 征战状态）可用，写动作必须留在队列里保序。
    const run = async () => {
      try {
        const out = await rawRequest(method, path, body, o);
        state.lastError = null;
        state.online = true;
        return out;
      } catch (e) {
        state.lastError = e;
        if (e && (e.status === 0 || e.status >= 500)) state.online = false;
        // 只有「带着令牌去请求」才谈得上会话失效；登录/注册本身返回 401 是
        // 「账号或密码不对」，不能顺手把会话清掉，也不能把它显示成"登录已失效"。
        if (e && o.auth !== false && (e.status === 401 || /^DEVICE_(REQUIRED|MISMATCH|BOUND|UNSUPPORTED)$/.test(e.code))) {
          net.clearSession();
          if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('ssdz-online-session-expired', { detail: { message: e.message } }));
          }
        }
        throw e;
      }
    };
    if (o.parallel) return run();
    const next = state.queue.then(run, run);
    // 队列本身不能因为一次失败就断掉。
    state.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  // 只读 GET：同 URL 共享在途请求；网络错误 / 5xx 立即重试一次。
  // 写请求仍走串行队列，不能被重试掩盖服务端是否已执行。
  function getShared(path, opts) {
    const o = Object.assign({}, opts || {});
    if (o.timeoutMs == null) o.timeoutMs = 10000;
    const key = [state.base, path, o.auth !== false, o.device !== false].join('|');
    const current = inflightGets.get(key);
    if (current) return current;
    const task = (async () => {
      try {
        return await request('GET', path, undefined, o);
      } catch (e) {
        if (!e || !(e.status === 0 || e.status >= 500)) throw e;
        return request('GET', path, undefined, o);
      }
    })();
    inflightGets.set(key, task);
    task.then(() => { if (inflightGets.get(key) === task) inflightGets.delete(key); },
      () => { if (inflightGets.get(key) === task) inflightGets.delete(key); });
    return task;
  }

  const net = {
    NetError,
    deviceIdentity,
    state,
    configure({ base, token } = {}) {
      if (base !== undefined) {
        const nextBase = resolveBase(base);
        if (state.base && nextBase !== state.base) net.clearSession();
        state.base = nextBase;
        state.discoveredAt = 0;
        state.discoveredResult = null;
        state.metaCache = null;
        state.metaAt = 0;
        inflightGets.clear();
        writeStored(BASE_KEY, state.base);
      }
      if (token !== undefined) net.setToken(token);
      return state.base;
    },
    base: () => state.base,
    get: (path, opts) => getShared(path, opts),
    post: (path, body, opts) => request('POST', path, body || {}, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
    token: () => state.token,
    setToken(token) {
      state.token = String(token || '');
      inflightGets.clear();
      writeStored(TOKEN_KEY, state.token);
    },
    account() { return state.account; },
    setAccount(acc) {
      state.account = acc || null;
      try { writeStored(ACCOUNT_KEY, acc ? JSON.stringify(acc) : ''); } catch (e) {}
    },
    restoreAccount() {
      const raw = readStored(ACCOUNT_KEY);
      if (!raw) return null;
      try { state.account = JSON.parse(raw); } catch (e) { state.account = null; }
      return state.account;
    },
    restoreToken() {
      state.token = readStored(TOKEN_KEY) || '';
      return state.token;
    },
    clearSession() {
      state.token = '';
      state.account = null;
      inflightGets.clear();
      writeStored(TOKEN_KEY, '');
      writeStored(ACCOUNT_KEY, '');
    },
    online: () => !!state.online,
    lastError: () => state.lastError,

    health: () => request('GET', '/api/health', undefined, { auth: false, device: false, timeoutMs: 6000 }),
    meta: getMeta,
    candidates,
    discover,
    baseUrl: () => state.base,
    tried: () => state.tried.slice(),
  };

  state.base = resolveBase();
  if (typeof window !== 'undefined') window.Net = net;
  if (typeof module !== 'undefined' && module.exports) module.exports = net;
})();
