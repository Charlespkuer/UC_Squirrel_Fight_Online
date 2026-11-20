// tower-online.js — 联机版无尽塔的本机对局存档 + 周奖励领取队列
(function () {
  'use strict';

  const PREFIX = 'ssdz-online-tower:';
  const VERSION = 2;
  const FIELDS = ['tower', 'endless'];
  const CLAIM_ACTION = 'claimEndlessTower';
  const MAX_CLAIMS = 20;
  const Net = window.Net || null;
  const Online = window.Online || null;

  let data = { tower: null, endless: null, claims: [] };
  let key = '';
  let timer = 0;
  let attachedTo = null;
  let loadedKey = '';
  const inflight = new Map();

  function accountId() {
    try {
      const a = Net && typeof Net.account === 'function' ? Net.account() : null;
      return String((a && a.accountId) || 'anonymous');
    } catch (e) { return 'anonymous'; }
  }

  function storageKey() { return PREFIX + accountId(); }

  function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function claimNumber(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // 领取队列里只放「服务端结算所需的最小信息」，不缓存奖励结果。
  function cleanClaim(raw) {
    if (!plain(raw)) return null;
    const id = String(raw.id == null ? '' : raw.id).slice(0, 64);
    if (!id) return null;
    return {
      id,
      layer: Math.min(1000000000, claimNumber(raw.layer)),
      mint: Math.min(1000000000, claimNumber(raw.mint)),
      trueEnd: raw.trueEnd === true,
      at: claimNumber(raw.at),
    };
  }

  function read(keyName) {
    try {
      const raw = localStorage.getItem(keyName);
      if (!raw) return { tower: null, endless: null, claims: [] };
      const box = JSON.parse(raw);
      if (!plain(box)) return { tower: null, endless: null, claims: [] };
      const clean = (run) => {
        // 否则关页面 / 杀进程时留下的 attempt 会让下一次「继续战斗」永远被挡住。
        if (run && typeof run === 'object' && run.run && typeof run.run === 'object') delete run.run.attempt;
        return run;
      };
      return {
        tower: plain(box.tower) ? clean(box.tower) : null,
        endless: plain(box.endless) ? clean(box.endless) : null,
        claims: (Array.isArray(box.claims) ? box.claims : []).map(cleanClaim).filter(Boolean).slice(-MAX_CLAIMS),
      };
    } catch (e) { return { tower: null, endless: null, claims: [] }; }
  }

  function write() {
    try {
      const box = { v: VERSION, savedAt: Date.now(), tower: data.tower, endless: data.endless, claims: data.claims || [] };
      localStorage.setItem(key, JSON.stringify(box));
    } catch (e) {

    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (key) write();
  }

  function schedule() {
    if (timer || typeof setTimeout !== 'function') return;
    timer = setTimeout(() => { timer = 0; if (key) write(); }, 120);
  }


  function refreshAccount() {
    const next = storageKey();
    if (next === loadedKey) return;
    if (loadedKey) flush();
    key = next;
    loadedKey = next;
    data = read(key);
  }


  function attach() {
    const s = window.State && State.state ? State.state() : null;
    if (!s) return null;
    refreshAccount();
    const installed = FIELDS.every((field) => {
      const d = Object.getOwnPropertyDescriptor(s, field);
      return !!(d && typeof d.get === 'function' && typeof d.set === 'function');
    });
    if (installed) { attachedTo = s; return s; }
    attachedTo = s;
    for (const field of FIELDS) {
      try {
        Object.defineProperty(s, field, {
          configurable: true,
          enumerable: true,
          get() { return data[field]; },
          set(value) {
            data[field] = plain(value) ? value : null;
            schedule();
          },
        });
      } catch (e) { /* 冻结对象等极端情况：退回普通字段，不影响本局 */ }
    }
    return s;
  }


  function state() { return attach(); }

  // 塔代码的 `save()` 从这里落盘（服务端存档不被触碰）。
  function save() { refreshAccount(); schedule(); }

  function reset() {
    data = { tower: null, endless: null, claims: [] };
    flush();
  }

  function snapshot() {
    try { return JSON.parse(JSON.stringify({ tower: data.tower, endless: data.endless })); }
    catch (e) { return { tower: null, endless: null }; }
  }




  function queueClaim(raw) {
    const claim = cleanClaim(raw);
    if (!claim) return false;
    refreshAccount();
    const list = Array.isArray(data.claims) ? data.claims : (data.claims = []);
    const at = Date.now();
    const row = list.find((x) => x.id === claim.id);
    if (row) Object.assign(row, claim, { at });
    else list.push(Object.assign({}, claim, { at }));
    if (list.length > MAX_CLAIMS) list.splice(0, list.length - MAX_CLAIMS);
    schedule();
    return true;
  }

  function dropClaim(id) {
    const claimId = String(id == null ? '' : id);
    if (!claimId) return false;
    const list = Array.isArray(data.claims) ? data.claims : [];
    const at = list.findIndex((x) => x.id === claimId);
    if (at < 0) return false;
    list.splice(at, 1);
    schedule();
    return true;
  }

  function pendingClaims() {
    refreshAccount();
    return (Array.isArray(data.claims) ? data.claims : []).map((x) => Object.assign({}, x));
  }

  function emitClaim(result) {
    if (!result || !(Number(result.granted) > 0)) return;
    try {
      if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('ssdz-tower-claim', { detail: result }));
      }
    } catch (e) {  }
  }

  // 结算一局：本机队列 → `claimEndlessTower` → 成功后出队。
  // 同一 runId 在飞行中去重；服务端本身也按 runId 幂等。
  function claimRun(raw) {
    const claim = cleanClaim(raw);
    if (!claim) return Promise.reject(new Error('缺少对局编号'));
    if (inflight.has(claim.id)) return inflight.get(claim.id);
    refreshAccount();
    const owner = loadedKey;
    const task = (async () => {
      queueClaim(claim);
      if (!Online || !Online.ready) throw new Error('还没有连上服务器');
      const result = await Online.call(CLAIM_ACTION, claim.layer, claim.mint, claim.id, claim.trueEnd === true);
      // 请求期间切了账号：旧账号的队列已在 refreshAccount 时 flush，
      // 这里不能再动新账号的 data。
      if (loadedKey === owner) dropClaim(claim.id);
      return result || {};
    })().finally(() => { inflight.delete(claim.id); });
    inflight.set(claim.id, task);
    return task;
  }

  let retrying = false;

  async function retryClaims() {
    if (retrying || !Online || !Online.ready) return 0;
    refreshAccount();
    retrying = true;
    let done = 0;
    try {
      for (const claim of pendingClaims()) {
        try {
          const result = await claimRun(claim);
          done += 1;
          emitClaim(result);
        } catch (e) {
          break;              // 网络/服务端还没恢复：保留队列，下次 ready 再试
        }
      }
    } finally {
      retrying = false;
    }
    return done;
  }

  window.TowerLocal = Object.freeze({
    state, save, flush, reset, snapshot, attach,
    claimRun, retryClaims, queueClaim, dropClaim,
    get pendingClaims() { return pendingClaims(); },
    get key() { return key || storageKey(); },
    get data() { return snapshot(); },

    noRewards: false,
  });
  // 界面侧只认这个窄接口（领奖 / 补发 / 查看队列），不碰本机对局存档。
  window.TowerOnline = Object.freeze({ claimRun, retryClaims, queueClaim, dropClaim, pendingClaims });

  if (Online && typeof Online.on === 'function') {
    const onAccount = () => { refreshAccount(); attach(); };
    Online.on('login', onAccount);
    Online.on('logout', onAccount);
    Online.on('state', attach);
    Online.on('ready', () => {
      if (typeof setTimeout === 'function') setTimeout(() => { void retryClaims(); }, 0);
    });
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }
})();
