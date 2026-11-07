/* ============================================================
 * online-update.js — 服务器端版本通知
 * ------------------------------------------------------------
 * 服务端 `/api/update` 返回当前部署版本；客户端比对本地 EXE/APK 的
 * `window.__SSDZ_VERSION`（或 `scripts/version.json`），发现更高版本就弹窗。
 * 游戏内每 pollSeconds（默认 60 秒）检查一次；打开游戏/登录后立即检查。
 *
 * 重要：客户端资源是打包在本地的，本模块只负责“发现 + 引导更新”，
 * 不会直接替换正在运行的 EXE/APK。更新方式由服务端 update.json 的 url 决定
 * （默认 GitHub Releases），用户下载安装后重新打开即可。
 * ============================================================ */
(function () {
  'use strict';

  const O = window.Online;
  let timer = 0, pollMs = 60000, checking = false, localVersion = '';
  let shownVersion = '', dismissedVersion = '';
  const DEFAULT_URL = 'https://github.com/Charlespkuer/UC_Squirrel_Fight_remake/releases/latest';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function C() { return (window.UI && UI.classic) || null; }
  function toast(msg) {
    try { if (O && O.toast) O.toast(msg); else if (window.UI && UI.toast) UI.toast(msg); } catch (e) {}
  }
  function norm(v) { return String(v == null ? '' : v).trim().replace(/^v/i, ''); }
  function parseVersion(v) {
    const m = norm(v).match(/\d+(?:\.\d+)*/);
    return m ? m[0].split('.').map((n) => Number(n) || 0) : [];
  }
  function compareVersion(a, b) {
    const A = parseVersion(a), B = parseVersion(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i] || 0, y = B[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  async function readLocalVersion() {
    if (localVersion) return localVersion;
    if (window.__SSDZ_VERSION) { localVersion = norm(window.__SSDZ_VERSION); return localVersion; }
    try {
      const r = await fetch('scripts/version.json', { cache: 'no-store' });
      if (r && r.ok) {
        const j = await r.json();
        localVersion = norm(j && j.version);
      }
    } catch (e) { /* 取不到就等下一次 */ }
    return localVersion;
  }
  function openUrl(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return Promise.resolve(false);
    try {
      if (window.Main && typeof Main.openExternal === 'function') return Promise.resolve(Main.openExternal(u));
    } catch (e) {}
    try { return Promise.resolve(!!window.open(u, '_blank', 'noopener')); } catch (e) {}
    return Promise.resolve(false);
  }
  async function copyUrl(url) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(String(url));
        toast('下载地址已复制。');
        return true;
      }
    } catch (e) {}
    toast('请手动打开：' + url);
    return false;
  }

  function show(info, mine, force) {
    const version = norm(info.version), notes = String(info.notes || '').trim();
    const url = String(info.url || DEFAULT_URL);
    const title = '发现新版本 v' + version;
    const body = '<p>服务器已经更新到 <b>v' + esc(version) + '</b>，当前客户端是 <b>v' + esc(mine) + '</b>。</p>' +
      (notes ? '<p class="small-label">' + esc(notes).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p class="small-label">下载安装新版本后，请完全退出游戏并重新打开。</p>';
    const c = C();
    if (!c || !c.modal) {
      if (window.confirm(title + '\n' + notes + '\n\n去下载更新？')) void openUrl(url);
      return;
    }
    const buttons = [{
      label: '立即更新', cls: 'gold', run: () => {
        dismissedVersion = version;
        void openUrl(url).then((ok) => {
          if (!ok) void copyUrl(url);
        });
      },
    }];
    if (force) {
      buttons.push({ label: '复制下载地址', cls: 'muted', close: false, run: () => { void copyUrl(url); } });
    } else {
      buttons.push({ label: '稍后再说', cls: 'muted', run: () => { dismissedVersion = version; } });
    }
    try {
      /* 统一去掉右上角 ×：更新提示只能通过「立即更新 / 稍后再说」结束，
       * 避免点 × 后 60 秒又弹一次。 */
      c.modal(title, body, buttons, { small: true, locked: true });
    } catch (e) {
      if (window.confirm(title + '\n' + notes + '\n\n去下载更新？')) void openUrl(url);
    }
  }

  function schedule(ms) {
    const next = Math.max(20000, Math.min(600000, Number(ms) || 60000));
    if (next === pollMs && timer) return;
    pollMs = next;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void check(); }, pollMs);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
  }
  async function check() {
    if (checking || !O) return null;
    if (document.hidden) return null;
    /* 已经有经典弹窗时不要叠加；过几秒等它关掉再提醒。 */
    if (document.querySelector('.classic-modal-overlay')) {
      setTimeout(() => { void check(); }, 5000);
      return null;
    }
    checking = true;
    try {
      const info = await O.get('/api/update', { auth: false });
      if (!info || !info.ok || !info.version) return null;
      const mine = await readLocalVersion();
      if (!mine) return null;
      const newer = compareVersion(info.version, mine) > 0;
      const belowMin = !!info.minVersion && compareVersion(mine, info.minVersion) < 0;
      if (!newer && !belowMin) return null;
      const version = norm(info.version);
      if (dismissedVersion === version || shownVersion === version) return null;
      shownVersion = version;
      show(info, mine, info.force === true || belowMin);
      if (info.pollSeconds) schedule(info.pollSeconds);
      return info;
    } catch (e) {
      /* 离线/服务器老版本：不打扰玩家，下个周期再试 */
      return null;
    } finally {
      checking = false;
    }
  }
  function start() {
    if (!O) return;
    if (timer) return;
    void check();
    schedule(60000);
  }

  if (O) {
    const kick = () => { if (timer) void check(); else start(); };
    O.on('ready', kick);
    O.on('login', kick);
    O.on('logout', stop);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && O) void check();
  });
  if (O) start();

  window.OnlineUpdate = { start, stop, check, compareVersion, localVersion: readLocalVersion };
})();
