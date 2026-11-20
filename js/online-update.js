// online-update.js — 服务器端版本通知
(function () {
  'use strict';

  const O = window.Online;
  let timer = 0, retryTimer = 0, pollMs = 60000, checking = false, localVersion = '';
  let dismissedVersion = '';
  // 待展示的更新提示 + 展示泵：启动阶段 #ui 还没挂好页面，这时弹窗会被下一次
  // innerHTML 抹掉（玩家看到的就是「闪一下」）；等界面稳定后再弹，被抹掉就补弹。
  let pending = null, pumpTimer = 0, pumpSig = '', pumpStable = 0, painted = false;
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
    } catch (e) {  }
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

  // 设置页的「从服务器更新」按平台走原生通道：
  // - Windows 完整包：下载同版本整包 exe，由 Rust 校验 MZ / 体积后原地替换，重开即新版；
  // - Android：由 MainActivity 下载 APK，校验包名后打开系统安装器（系统仍会要求用户确认）；
  // - 开发轻壳：本机重新打包 + 自动重启；没有原生桥时退回下载页。
  function nativeBridge() {
    const n = window.__TAURI_INTERNALS__;
    return n && typeof n.invoke === 'function' ? n : null;
  }
  function isWindowsShell() {
    return !!window.__SSDZ_ONLINE_SHELL__ && /Windows/i.test(String((window.navigator && navigator.userAgent) || ''));
  }
  function isAndroid() {
    return !!(window.SSDZAndroid && typeof window.SSDZAndroid.startApkUpdate === 'function') ||
      /Android/i.test(String((window.navigator && navigator.userAgent) || ''));
  }
  // iOS App 的页面同样来自 WKWebView；未签名 IPA 只能交给系统浏览器下载后再安装。
  function isIos() {
    return !isAndroid() && /iPhone|iPad|iPod/i.test(String((window.navigator && navigator.userAgent) || ''));
  }
  function iosMajor() {
    const m = /(?:OS|CPU OS) (\d+)[_.]/.exec(String((window.navigator && navigator.userAgent) || ''));
    return m ? Number(m[1]) || 0 : 0;
  }
  function androidAbi() {
    try {
      if (window.SSDZAndroid && typeof SSDZAndroid.abi === 'function') return String(SSDZAndroid.abi() || '');
    } catch (e) {}
    return String((window.navigator && navigator.userAgent) || '');
  }
  // 选包只看主 ABI：部分设备的 SUPPORTED_ABIS 会同时列 arm64-v8a 和 x86_64，
  // 按整串搜 x86_64 会把 ARM 机带到 x86_64 包（系统报 CPU 不兼容）。
  function androidAbiFamily() {
    const raw = String(androidAbi() || '').toLowerCase();
    // 没有原生 abi() 时退回 UA：按整串判断（UA 里的设备型号不是独立 ABI 字段）。
    if (raw.indexOf('mozilla') >= 0) {
      if (raw.indexOf('x86_64') >= 0) return 'x86_64';
      if (raw.indexOf('arm64') >= 0 || raw.indexOf('aarch64') >= 0) return 'arm64';
      return '';
    }
    const list = raw.split(/[,\s]+/).filter(Boolean);
    const has = (prefix) => list.some((abi) => abi.indexOf(prefix) === 0);
    const primary = list[0] || '';
    if (primary.indexOf('arm64') === 0 || primary.indexOf('aarch64') === 0) return 'arm64';
    if (primary.indexOf('x86_64') === 0) return 'x86_64';
    if (has('arm64') || has('aarch64')) return 'arm64';
    if (has('x86_64')) return 'x86_64';
    return '';
  }
  function androidAbiSupported() {
    return !isAndroid() || !nativeBridge() || !!androidAbiFamily();
  }
  function updateBase() {
    const net = window.Net && typeof Net.base === 'function' ? Net.base() : '';
    const origin = window.location && location.origin ? location.origin : '';
    return String(net || origin).replace(/\/+$/, '');
  }
  function androidPackageRel(info) {
    const family = androidAbiFamily();
    const rel = family === 'x86_64' && info && info.apkX86 ? info.apkX86
      : family === 'arm64' && info && info.apk ? info.apk
        : '';
    return String(rel || '');
  }
  function androidPackageSize(info) {
    const family = androidAbiFamily();
    return Number((family === 'x86_64' && info && info.apkX86Size)
      || (family === 'arm64' && info && info.apkSize)) || 0;
  }
  // iOS 26+ 用默认包，iOS 15~25 用 legacy 包；服务端只给当前版本的 IPA 地址。
  function iosPackageRel(info) {
    const major = iosMajor();
    const rel = major && major < 26 ? (info && info.ipaLegacy) : (info && (info.ipa || info.ipaLegacy));
    return String(rel || '');
  }
  function iosPackageVersion(info) {
    const major = iosMajor();
    return String((major && major < 26 ? (info && info.ipaLegacyVersion) : (info && info.ipaVersion)) || '');
  }
  function iosPackageSize(info) {
    return Number((info && (info.ipaSize || info.ipaLegacySize))) || 0;
  }
  function directUpdateUrl(info) {
    if (!nativeBridge()) return '';
    const base = updateBase();
    if (isAndroid()) {
      const rel = androidPackageRel(info);
      if (!/^\/download\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/i.test(rel)) return '';
      return base + rel;
    }
    if (isIos()) {
      const rel = iosPackageRel(info);
      if (!/^\/download\/[A-Za-z0-9][A-Za-z0-9._-]*\.ipa$/i.test(rel)) return '';
      /* iOS 包可能落后于 EXE/APK：只有确实比本机新时才直接拉，否则交给下载页。 */
      const available = iosPackageVersion(info);
      if (localVersion && available && compareVersion(available, localVersion) <= 0) return '';
      return base + rel;
    }
    if (!/Windows/i.test(String((window.navigator && navigator.userAgent) || ''))) return '';
    if (window.__SSDZ_ONLINE_SHELL__) return '';
    const rel = String((info && info.exe) || '');
    if (!/^\/download\/[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(rel)) return '';
    return base + rel;
  }
  function openSettingsPage() {
    try {
      if (window.OnlineUI && typeof OnlineUI.settingsPage === 'function') {
        const page = OnlineUI.settingsPage();
        if (page) return true;
      }
      if (window.UI && typeof UI.runAction === 'function') {
        UI.runAction('settings');
        return true;
      }
    } catch (e) {}
    toast('请打开「设置 → 联机账号 → 检查更新」下载新版本。');
    return false;
  }
  // 设置页「从服务器更新」走这里；自动提示弹窗只有用户点「复制下载地址」时才按同一流程同步。
  function startUpdate(info, url) {
    if (!androidAbiSupported()) {
      toast('当前设备是 32 位 CPU，新版只提供 64 位安装包；已打开下载页。');
      void openUrl(url).then((ok) => { if (!ok) void copyUrl(url); });
      return;
    }
    const direct = directUpdateUrl(info);
    if (isIos() && nativeBridge()) { void runIosUpdate(info, direct || url); return; }
    if (direct) { void runNativeUpdate(info, direct); return; }
    if (isWindowsShell() && nativeBridge()) { void runShellRebuild(info); return; }
    void openUrl(url).then((ok) => { if (!ok) void copyUrl(url); });
  }
  function apkStatusOf() {
    try {
      const raw = window.SSDZAndroid && typeof SSDZAndroid.apkUpdateStatus === 'function'
        ? SSDZAndroid.apkUpdateStatus() : '';
      return raw ? JSON.parse(String(raw)) : null;
    } catch (e) { return null; }
  }
  function setApkStatusText(box, text) {
    try {
      const el = box && box.element && box.element.querySelector
        ? box.element.querySelector('[data-apk-status]') : null;
      if (el) el.textContent = text;
    } catch (e) {}
  }
  async function runAndroidUpdate(info, url) {
    const version = norm(info.version);
    const c = C();
    const bridge = window.SSDZAndroid;
    const page = String(info.url || DEFAULT_URL);
    if (!bridge || typeof bridge.startApkUpdate !== 'function') {
      void openUrl(page).then((ok) => { if (!ok) void copyUrl(page); });
      return;
    }
    const size = androidPackageSize(info);
    const box = c && c.modal ? c.modal('正在更新 v' + version,
      '<p data-apk-status>正在下载安装包' + (size ? '（约 ' + (size / 1048576).toFixed(1) + ' MB）' : '') + '…</p>' +
      '<p class="small-label">下载完成后会打开系统安装界面；请点「安装」，装好后重新打开游戏。</p>',
      [], { small: true, locked: true }) : null;
    try {
      const res = JSON.parse(String(bridge.startApkUpdate(url, version) || '{}'));
      if (!res.ok) throw new Error(res.msg || '无法开始下载');
      const done = (st) => {
        if (!st) return false;
        if (st.status === 'downloading') {
          setApkStatusText(box, '正在下载安装包… ' + Math.max(0, Math.min(100, Number(st.progress) || 0)) + '%');
          return false;
        }
        if (st.status === 'permission') {
          if (box) box.close();
          if (c && c.modal) c.modal('需要允许安装', '<p>系统还没有允许本应用安装 APK。请在设置里打开「允许来自此来源的应用」，然后再次点检查更新。</p>',
            [{ label: '知道了', cls: 'gold' }], { small: true });
          return true;
        }
        if (st.status === 'ready') {
          if (box) box.close();
          dismissedVersion = version;
          clearPending();
          if (c && c.modal) c.modal('安装包已下载',
            '<p>已经打开系统安装界面（v' + esc(version) + '）。</p>' +
            '<p class="small-label">请点「安装」；安装完成后重新打开游戏即可。</p>',
            [{ label: '知道了', cls: 'gold' }], { small: true });
          return true;
        }
        if (st.status === 'error') throw new Error(st.error || '下载失败');
        return false;
      };
      if (done(apkStatusOf())) return;
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (done(apkStatusOf())) return;
      }
      throw new Error('下载超时，请检查网络后重试');
    } catch (e) {
      if (box) box.close();
      toast('自动更新失败：' + String((e && (e.message || e)) || e));
      void openUrl(page).then((ok) => { if (!ok) void copyUrl(page); });
    }
  }
  // iOS 不能原地替换 App 包：打开系统浏览器下载未签名 IPA，用户再用 TrollStore / AltStore 安装。
  // 自动更新弹窗只在用户点「复制下载地址」后进入；普通提示不下载。
  async function runIosUpdate(info, url) {
    const version = norm(info.version);
    const c = C();
    const page = String(info.url || DEFAULT_URL);
    const target = url || page;
    const size = iosPackageSize(info);
    const legacy = iosMajor() && iosMajor() < 26;
    const open = () => {
      void openUrl(target).then((ok) => {
        if (!ok) { void copyUrl(target); return; }
        dismissedVersion = version;
        clearPending();
        toast('已打开下载地址；用 TrollStore / AltStore 安装后重新打开游戏。');
      });
    };
    if (!c || !c.modal) {
      if (window.confirm('从服务器下载 iOS 更新包？\n\n下载完成后用 TrollStore / AltStore 安装。')) open();
      return;
    }
    c.modal('iOS 更新 v' + version,
      '<p>将从服务器打开发布页下载未签名 IPA' + (size ? '（约 ' + (size / 1048576).toFixed(1) + ' MB）' : '') +
      (legacy ? '（当前系统使用 legacy 包）' : '') + '。</p>' +
      '<p class="small-label">下载完成后用 TrollStore、AltStore 或 Sideloadly 安装；请保持同一 Bundle ID（com.ssdz.online），服务器账号与进度不会丢。</p>' +
      '<p class="small-label">如果浏览器没有自动下载，请在下载页点对应的 IPA 文件名。</p>',
      [{ label: '打开下载地址', cls: 'gold', run: open },
        { label: '复制地址', cls: 'muted', run: () => { void copyUrl(target); } },
        { label: '稍后再说', cls: 'muted' }], { small: true });
  }
  async function runNativeUpdate(info, url) {
    if (isAndroid()) return runAndroidUpdate(info, url);
    if (isIos()) return runIosUpdate(info, url);
    const version = norm(info.version);
    const c = C();
    const size = Number(info.exeSize) || 0;
    const box = c && c.modal ? c.modal('正在更新 v' + version,
      '<p>正在从服务器下载新客户端' + (size ? '（约 ' + (size / 1048576).toFixed(1) + ' MB）' : '') + '，请保持网络连接。</p>' +
      '<p class="small-label">下载完成后会自动替换游戏文件；替换完成后重新打开游戏即可。</p>',
      [], { small: true, locked: true }) : null;
    try {
      await nativeBridge().invoke('online_sync_client', { url, version });
      if (box) box.close();
      dismissedVersion = version;
      clearPending();
      if (c && c.modal) {
        c.modal('更新完成',
          '<p>新客户端已经下载并替换完成（v' + esc(version) + '）。</p>' +
          '<p class="small-label">请完全退出游戏再重新打开，之后运行的就是新版本。</p>',
          [{ label: '知道了', cls: 'gold' }], { small: true });
      }
    } catch (e) {
      if (box) box.close();
      toast('自动更新失败：' + String((e && (e.message || e)) || e));
      const page = String(info.url || DEFAULT_URL);
      void openUrl(page).then((ok) => { if (!ok) void copyUrl(page); });
    }
  }
  // 开发轻壳：整包替换会把它换成玩家版（以后改代码不再即时生效），
  // 所以按本机仓库重新打包轻壳并自动重启；不在开发目录时才退回下载页。
  async function runShellRebuild(info) {
    const bridge = nativeBridge();
    const c = C();
    const page = String(info.url || DEFAULT_URL);
    let dev = null;
    try { dev = await bridge.invoke('online_dev_status'); } catch (e) { dev = null; }
    if (!dev || !dev.ok) {
      toast('当前轻壳不在开发目录，无法本机打包；已打开下载页。');
      void openUrl(page).then((ok) => { if (!ok) void copyUrl(page); });
      return;
    }
    const version = norm(info.version);
    const box = c && c.modal ? c.modal('正在重新打包客户端',
      '<p>当前是开发轻壳：按本机仓库重新打包轻壳（服务器 v' + esc(version) + '）并自动重启。</p>' +
      '<p class="small-label">构建日志在新开的命令窗口里，通常 10~60 秒；游戏会先关闭，完成后自动打开。</p>',
      [], { small: true, locked: true }) : null;
    try {
      await bridge.invoke('online_dev_rebuild');
      clearPending();
    } catch (e) {
      if (box) box.close();
      toast('本机打包启动失败：' + String((e && (e.message || e)) || e));
      void openUrl(page).then((ok) => { if (!ok) void copyUrl(page); });
    }
  }

  function show(info, mine, force, options) {
    const opts = options || {};
    const allowDownload = opts.allowDownload === true;
    const version = norm(info.version), notes = String(info.notes || '').trim();
    const url = String(info.url || DEFAULT_URL);
    const title = '发现新版本 v' + version;
    const archUnsupported = !androidAbiSupported();
    const archNote = archUnsupported
      ? '<p class="small-label">当前设备是 32 位 CPU；新版只提供 64 位（arm64 / x86_64）安装包，系统会报「CPU 不兼容」。请换用 64 位设备、直接用网页版，或加入 QQ 群获取适配包。</p>'
      : '';
    const qq = '推荐优先加入 QQ 群 1128710765 下载最新版本，速度更快、也更稳定。';
    const hint = allowDownload
      ? qq + '也可以点「从服务器更新」下载安装包。'
      : '更新入口已移到「设置 → 联机账号 → 检查更新」；' + qq;
    const iosNote = isIos()
      ? '<p class="small-label">iOS 越狱用户：在设置里选「从服务器更新」下载对应 IPA，再用 TrollStore / AltStore 安装；保持同一 Bundle ID 即可保留服务器账号与进度。</p>'
      : '';
    const body = '<p>服务器已经更新到 <b>v' + esc(version) + '</b>，当前客户端是 <b>v' + esc(mine) + '</b>。</p>' +
      (notes ? '<p class="small-label">' + esc(notes).replace(/\n/g, '<br>') + '</p>' : '') +
      archNote + iosNote + '<p class="small-label">' + hint + '</p>';
    const c = C();
    if (!c || !c.modal) {
      // 没有经典弹窗可挂（正常路径不会走到）：自动弹窗仍只提示，复制按钮走 copyThenSync。
      clearPending();
      if (!allowDownload) {
        if (force) openSettingsPage();
        else dismissedVersion = version;
        try { window.alert(title + '\n' + notes + '\n\n' + hint); } catch (e) {}
        return true;
      }
      if (window.confirm(title + '\n' + notes + '\n\n' + hint + '\n\n从服务器下载更新？')) {
        startUpdate(info, url);
      } else if (!force) {
        dismissedVersion = version;
      }
      return true;
    }
    const dismiss = () => { dismissedVersion = version; clearPending(); };
    let handle = null;
    const closeSelf = () => { try { if (handle && handle.close) handle.close(); } catch (e) {} };
    // 复制地址后立刻收起弹窗；设置页/原生通道能直更时马上走同步更新。
    const copyThenSync = () => {
      closeSelf();
      if (force) clearPending(); else dismiss();
      const go = () => {
        toast('正在同步更新…');
        try { startUpdate(info, url); } catch (e) {}
      };
      void copyUrl(url).then(go, go);
    };
    const buttons = [];
    if (allowDownload && !archUnsupported) {
      buttons.push({
        // 设置页是唯一允许从服务器下载整包的入口。
        label: '从服务器更新', cls: 'gold', close: !force, run: () => {
          if (force) clearPending(); else dismiss();
          closeSelf();
          startUpdate(info, url);
        },
      });
      buttons.push(force
        ? { label: '复制下载地址', cls: 'muted', close: true, run: copyThenSync }
        : { label: '稍后再说', cls: 'muted', run: dismiss });
    } else if (allowDownload) {
      buttons.push({ label: '打开下载页', cls: 'gold', close: !force, run: () => {
        if (force) clearPending(); else dismiss();
        closeSelf();
        void openUrl(url).then((ok) => { if (!ok) void copyUrl(url); });
      } });
      buttons.push(force
        ? { label: '复制下载地址', cls: 'muted', close: true, run: copyThenSync }
        : { label: '稍后再说', cls: 'muted', run: dismiss });
    } else if (force) {
      // 强制更新也不在自动弹窗里下载：只引导到设置，或提供手动下载地址。
      buttons.push({ label: '前往设置', cls: 'gold', close: true, run: () => { dismiss(); closeSelf(); openSettingsPage(); } });
      buttons.push({ label: '复制下载地址', cls: 'muted', close: true, run: copyThenSync });
    } else {
      buttons.push({ label: '前往设置', cls: 'gold', close: true, run: () => { dismiss(); closeSelf(); openSettingsPage(); } });
      buttons.push({ label: '知道了', cls: 'muted', run: dismiss });
    }
    try {
      handle = c.modal(title, body, buttons, { small: true, locked: true, showClose: true });
      // 版本说明可能很长：给弹窗单独一个类，CSS 把高度压住、正文自己滚，按钮不会顶到屏幕底。
      const box = handle && handle.element && handle.element.querySelector ? handle.element.querySelector('.classic-modal') : null;
      if (box) box.classList.add('update-modal');
      // 右上角 X 直接忽视本次更新：与「知道了 / 稍后再说」同口径，同一版本本局不再弹。
      const closeX = handle && handle.element && handle.element.querySelector ? handle.element.querySelector('.modal-close') : null;
      if (closeX) closeX.addEventListener('click', () => { dismiss(); });
      return true;
    } catch (e) {
      clearPending();
      if (!allowDownload) {
        if (force) openSettingsPage();
        else dismissedVersion = version;
        try { window.alert(title + '\n' + notes + '\n\n' + hint); } catch (err) {}
        return true;
      }
      if (window.confirm(title + '\n' + notes + '\n\n' + hint + '\n\n从服务器下载更新？')) {
        startUpdate(info, url);
      } else if (!force) {
        dismissedVersion = version;
      }
      return true;
    }
  }

  function clearPending() {
    pending = null;
    painted = false;
    pumpSig = '';
    pumpStable = 0;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = 0;
  }
  // 登录页不算「进入游戏」：那时弹出来，登录成功换页会把它抹掉（先闪一下再消失）。
  function uiScreen() {
    if (document.querySelector('#ui .classic-page')) return true;
    const home = document.querySelector('#ui .classic-home');
    return !!home && !home.classList.contains('online-login');
  }
  function busyDialog() { return !!document.querySelector('.classic-modal-overlay, .online-notice-original'); }
  function uiSignature() {
    const ui = document.getElementById('ui');
    const first = ui && ui.firstElementChild;
    return (first ? String(first.className) : '') + '|' + (ui ? ui.childElementCount : 0);
  }
  // 500ms 一拍：界面稳定两拍才第一次弹（躲开启动阶段的重绘）；
  // 之后只要弹窗被换页抹掉就立刻补上，强制更新不会因为切页而消失。
  function pump() {
    if (!pending) { clearPending(); return; }
    if (document.hidden || busyDialog() || !uiScreen()) { pumpSig = ''; pumpStable = 0; return; }
    if (!painted) {
      const sig = uiSignature();
      if (sig !== pumpSig) { pumpSig = sig; pumpStable = 0; return; }
      if (++pumpStable < 2) return;
    }
    pumpStable = 0;
    if (show(pending.info, pending.mine, pending.force)) painted = true;
  }
  function startPump() {
    if (pumpTimer) return;
    pumpTimer = setInterval(pump, 500);
  }

  function schedule(ms) {
    const next = Math.max(180000, Math.min(600000, Number(ms) || 180000)); // 移动端每次唤醒都要付主线程 + 网络代价，3 分钟一查足够发现新版本
    if (next === pollMs && timer) return;
    pollMs = next;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void check(); }, pollMs);
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (retryTimer) clearTimeout(retryTimer);
    timer = 0;
    retryTimer = 0;
  }
  async function check() {
    if (checking || !O) return null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
    if (document.hidden) return null;
    if (pending) return null;
    // 已经有经典弹窗时不要叠加；过几秒等它关掉再提醒。
    if (document.querySelector('.classic-modal-overlay')) {
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; void check(); }, 5000);
      return null;
    }
    checking = true;
    try {
      const info = await O.get('/api/update', { auth: false, parallel: true, timeoutMs: 8000 });
      if (!info || !info.ok || !info.version) return null;
      const mine = await readLocalVersion();
      if (!mine) return null;
      const newer = compareVersion(info.version, mine) > 0;
      const belowMin = !!info.minVersion && compareVersion(mine, info.minVersion) < 0;
      if (!newer && !belowMin) return null;
      const version = norm(info.version);
      if (dismissedVersion === version) return null;
      pending = { info, mine, force: info.force === true || belowMin };
      startPump();
      pump();
      if (info.pollSeconds) schedule(info.pollSeconds);
      return info;
    } catch (e) {

      return null;
    } finally {
      checking = false;
    }
  }
  // 设置页「检查更新」：手动检查不受“稍后再说”/启动阶段影响，有新版本立刻弹更新框。
  async function checkNow() {
    if (!O) return { ok: false, error: '联机模块还没有准备好' };
    if (checking) return { ok: false, busy: true };
    if (busyDialog()) return { ok: false, busy: true };
    checking = true;
    try {
      const info = await O.get('/api/update', { auth: false, parallel: true, timeoutMs: 8000 });
      const mine = await readLocalVersion();
      if (!info || !info.ok || !info.version) return { ok: false, error: '服务器没有返回版本信息' };
      const version = norm(info.version);
      const newer = compareVersion(version, mine) > 0;
      const belowMin = !!info.minVersion && compareVersion(mine, info.minVersion) < 0;
      if (!newer && !belowMin) return { ok: true, latest: true, version, mine };
      dismissedVersion = '';
      clearPending();
      const shown = show(info, mine, info.force === true || belowMin, { allowDownload: true });
      return { ok: true, latest: false, version, mine, shown };
    } catch (e) {
      return { ok: false, error: (O && O.errText ? O.errText(e) : String((e && (e.message || e)) || e)) };
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

  window.OnlineUpdate = { start, stop, check, checkNow, compareVersion, localVersion: readLocalVersion };
})();
