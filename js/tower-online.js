/* ============================================================
 * tower-online.js — 联机版无尽塔的**本机对局存档**
 * ------------------------------------------------------------
 * 联机版的无尽塔是「零局外奖励」的局内 roguelike：
 *   · 不往账号存档写 tower / endless（服务端根本不知道这两个字段）；
 *   · 不发抽奖卷 / 黑卡 / 金松果 / 道具，也不消耗账号资源；
 *   · 战斗用本机 Sim 播，只有分数 / 最深层数 / 对局进度落在本机。
 *
 * 实现方式：在 `State.state()` 上装一对**可枚举访问器** `tower` / `endless`，
 * 指向本模块里按账号隔离的一份 localStorage 数据。塔代码仍然读写
 * `State.state().tower / .endless`，但值永远不会跟着服务端 patch 走。
 *
 * 为什么要重新 attach：`Online.adoptSave()` / `applyPatch()` 可能整档替换
 * 或删掉未知字段，把访问器一起收走；每次 `Online` 发出 `state` 事件后补一次
 * 即可。数据本身在闭包里，不随 State 对象替换而丢失。
 * ============================================================ */
(function () {
  'use strict';

  const PREFIX = 'ssdz-online-tower:';
  const VERSION = 1;
  const FIELDS = ['tower', 'endless'];
  const Net = window.Net || null;
  const Online = window.Online || null;

  let data = { tower: null, endless: null };
  let key = '';
  let timer = 0;
  let attachedTo = null;
  let loadedKey = '';

  function accountId() {
    try {
      const a = Net && typeof Net.account === 'function' ? Net.account() : null;
      return String((a && a.accountId) || 'anonymous');
    } catch (e) { return 'anonymous'; }
  }

  function storageKey() { return PREFIX + accountId(); }

  function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function read(keyName) {
    try {
      const raw = localStorage.getItem(keyName);
      if (!raw) return { tower: null, endless: null };
      const box = JSON.parse(raw);
      if (!plain(box)) return { tower: null, endless: null };
      const clean = (run) => {
        /* 与单机版 state.js 的 runShape 同口径：读档时作废「正在战斗」令牌，
         * 否则关页面 / 杀进程时留下的 attempt 会让下一次「继续战斗」永远被挡住。 */
        if (run && typeof run === 'object' && run.run && typeof run.run === 'object') delete run.run.attempt;
        return run;
      };
      return {
        tower: plain(box.tower) ? clean(box.tower) : null,
        endless: plain(box.endless) ? clean(box.endless) : null,
      };
    } catch (e) { return { tower: null, endless: null }; }
  }

  function write() {
    try {
      const box = { v: VERSION, savedAt: Date.now(), tower: data.tower, endless: data.endless };
      localStorage.setItem(key, JSON.stringify(box));
    } catch (e) {
      /* 隐私模式 / 配额满：本局仍可继续玩，只是关掉页面后进度不保留。 */
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

  /** 切账号 / 首次进入时，换到该账号自己的那份本机进度。 */
  function refreshAccount() {
    const next = storageKey();
    if (next === loadedKey) return;
    if (loadedKey) flush();
    key = next;
    loadedKey = next;
    data = read(key);
  }

  /** 把 tower / endless 访问器装到当前 State 上。重复调用是幂等的。 */
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

  /** 塔代码的 `S()` 从这里取：就是带本机 tower / endless 的 State 对象。 */
  function state() { return attach(); }

  /** 塔代码的 `save()` 从这里落盘（服务端存档不被触碰）。 */
  function save() { refreshAccount(); schedule(); }

  function reset() {
    data = { tower: null, endless: null };
    flush();
  }

  function snapshot() {
    try { return JSON.parse(JSON.stringify({ tower: data.tower, endless: data.endless })); }
    catch (e) { return { tower: null, endless: null }; }
  }

  window.TowerLocal = Object.freeze({
    state, save, flush, reset, snapshot, attach,
    get key() { return key || storageKey(); },
    get data() { return snapshot(); },
    noRewards: true,
  });

  if (Online && typeof Online.on === 'function') {
    const onAccount = () => { refreshAccount(); attach(); };
    Online.on('login', onAccount);
    Online.on('logout', onAccount);
    Online.on('state', attach);
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
