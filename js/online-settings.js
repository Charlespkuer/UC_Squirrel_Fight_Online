// online-settings.js — 联机设置 / 账号弹窗 / 主人同步
(function () {
  'use strict';
  const U = window.OnlineUI;
  if (!U || !U._) return;
  const { O, esc, toast, C, uiRoot, confirmBox, passwordProblem, nameProblem, versionCompare } = U._;
  const accountDialog = (...args) => U.accountDialog(...args);

  function passwordDialog() {
    const c = C(); if (!c || !c.modal) return;
    let busy = false;
    const m = c.modal('修改密码', '<form class="online-account-form">' +
      '<label>当前密码<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label>' +
      '<label>新密码<input type="password" name="newPassword" autocomplete="new-password" maxlength="128" required></label>' +
      '<label>确认新密码<input type="password" name="confirm" autocomplete="new-password" maxlength="128" required></label>' +
      '<p class="small-label">新密码至少 6 位，且同时包含字母和数字；修改后其它设备需重新登录。</p>' +
      '<p class="online-account-error" role="alert"></p></form>', [
      { label: '确认修改', cls: 'gold', close: false, run: () => { void submit(); } },
      { label: '返回', cls: 'muted' },
    ], { small: true });
    if (m && m.element && m.element.classList) m.element.classList.add('password-dialog');
    const form = m && m.element ? m.element.querySelector('form') : null;
    if (!form) return m;
    const note = form.querySelector('[role="alert"]');
    const field = (name) => form.querySelector('input[name="' + name + '"]');
    const buttons = m.element.querySelectorAll('.modal-buttons button');
    const setBusy = (on) => {
      busy = on;
      buttons.forEach((b) => { b.disabled = on; });
    };
    async function submit() {
      if (busy) return;
      const password = field('password').value, next = field('newPassword').value, confirm = field('confirm').value;
      if (!password) { note.textContent = '请输入当前密码。'; field('password').focus(); return; }
      const problem = passwordProblem(next);
      if (problem) { note.textContent = problem; field('newPassword').focus(); return; }
      if (next !== confirm) { note.textContent = '两次输入的新密码不一致。'; field('confirm').focus(); return; }
      if (next === password) { note.textContent = '新密码不能与当前密码相同。'; field('newPassword').focus(); return; }
      setBusy(true); note.textContent = '正在修改…';
      try {
        await O.post('/api/account/password', { password, newPassword: next });
        m.close();
        toast('密码已修改，其它设备需要重新登录。');
      } catch (e) {
        if (m.element.isConnected) { note.textContent = O.errText(e); setBusy(false); }
      }
    }
    form.onsubmit = (e) => { e.preventDefault(); void submit(); };
    field('password').focus();
    return m;
  }

  // 设置页「修改昵称」：新昵称全服唯一，成功后账号名、存档与当前防守快照一起更新。
  function renameDialog() {
    const c = C(); if (!c || !c.modal) return;
    let busy = false;
    const account = Net.account() || {};
    const current = String(account.name || (window.State && State.state() ? State.state().name : '') || '');
    const rules = window.NicknameRules;
    const tip = rules ? '最多 ' + rules.MAX_WEIGHT + ' 个汉字（英文/数字按 1/3 个汉字计）。' : '';
    const m = c.modal('修改昵称', '<form class="online-account-form">' +
      '<label>新昵称<input type="text" name="name" maxlength="21" autocomplete="nickname" value="' + esc(current) + '" required></label>' +
      '<p class="small-label">' + esc(tip) + '昵称全服唯一，修改后好友搜索、战报和排行都会显示新昵称。</p>' +
      '<p class="online-account-error" role="alert"></p></form>', [
      { label: '确认修改', cls: 'gold', close: false, run: () => { void submit(); } },
      { label: '返回', cls: 'muted' },
    ], { small: true });
    if (m && m.element && m.element.classList) m.element.classList.add('rename-dialog');
    const form = m && m.element ? m.element.querySelector('form') : null;
    if (!form) return m;
    const note = form.querySelector('[role="alert"]');
    const input = form.querySelector('input[name="name"]');
    const buttons = m.element.querySelectorAll('.modal-buttons button');
    const setBusy = (on) => {
      busy = on;
      buttons.forEach((b) => { b.disabled = on; });
    };
    async function submit() {
      if (busy) return;
      const raw = input.value;
      const problem = nameProblem(raw);
      if (problem) { note.textContent = problem; input.focus(); return; }
      const name = rules && typeof rules.check === 'function' ? rules.check(raw).name : raw.trim();
      if (!name) { note.textContent = '名字不能为空。'; input.focus(); return; }
      if (name.toLowerCase() === current.toLowerCase()) { note.textContent = '新昵称与当前昵称相同。'; input.focus(); return; }
      setBusy(true); note.textContent = '正在修改…';
      try {
        const out = await O.post('/api/account/name', { name }, { preserveMirror: true });
        const next = out && out.name ? String(out.name) : name;
        // 账号缓存与存档镜像都换成新昵称：设置页标题、首页名字和之后拉取的资料保持一致。
        if (window.Net && Net.setAccount) Net.setAccount(Object.assign({}, Net.account() || {}, out.account || {}, { name: next, display: next }));
        try { if (window.State && State.state()) State.state().name = next; } catch (e) {}

        try { localStorage.setItem('ssdz-online-username', next); } catch (e) {}
        m.close();
        toast('昵称已修改为「' + esc(next) + '」。');
        settingsPage();
      } catch (e) {
        if (m.element.isConnected) { note.textContent = O.errText(e); setBusy(false); }
      }
    }
    form.onsubmit = (e) => { e.preventDefault(); void submit(); };
    input.focus();
    if (input.select) input.select();
    return m;
  }

  // 服务器主人：设置页「一键同步更改」
  // 可见性由服务端按 TCP 对端 IP 判定（/api/owner/sync/preview）；非主人只拿到
  // owner:false，页面连按钮都不挂。预览接口按版本清单给出文件级差异：
  function clientVersion() { return String(window.__SSDZ_VERSION || '').replace(/^v/i, ''); }
  function fmtSyncSize(n) {
    const v = Number(n) || 0;
    return v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(v / 1024)) + ' KB';
  }
  function openExternalUrl(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return;
    try { if (window.Main && typeof Main.openExternal === 'function') { void Main.openExternal(u); return; } } catch (e) {}
    try { window.open(u, '_blank', 'noopener'); } catch (e) {}
  }
  function ownerDownloadUrl(info) {
    const base = String(Net.base()).replace(/\/+$/, '');
    const android = /Android/i.test(String(navigator.userAgent || ''));
    const rel = info && (android ? (info.apk || info.exe) : (info.exe || info.apk));
    return base + (rel || '/download');
  }

  function syncDiffText(info) {
    const d = info && info.diff;
    if (!d) return (info && info.diffReason) || '服务器没有文件清单，只能整包更新。';
    if (!d.count) return '与当前客户端文件一致。';
    const bits = [];
    if (d.added) bits.push('新增 ' + d.added);
    if (d.changed) bits.push('修改 ' + d.changed);
    if (d.removed) bits.push('删除 ' + d.removed);
    return '将改动 ' + d.count + ' 个文件（' + bits.join(' / ') + '，约 ' + fmtSyncSize(d.bytes) + '）';
  }
  function syncCategoriesText(info) {
    const cats = info && info.diff && info.diff.categories;
    if (!cats) return '';
    return Object.keys(cats).sort().map((k) => k + ' ' + cats[k]).join(' · ');
  }
  function syncFilesHtml(info) {
    const d = info && info.diff;
    if (!d) return '<p class="small-label">' + esc((info && info.diffReason) || '没有文件清单。') + '</p>';
    if (!d.count) return '<p class="small-label">与当前客户端文件一致，没有文件差异。</p>';
    const labels = { added: '新增', changed: '修改', removed: '删除' };
    const rows = (d.files || []).map((f) =>
      '<div class="owner-sync-file"><span class="st ' + esc(f.status) + '">' + esc(labels[f.status] || f.status) +
      '</span><code>' + esc(f.path) + '</code><span>' + fmtSyncSize(f.size) + '</span></div>').join('');
    return '<div class="owner-sync-files">' + rows + '</div>' +
      (d.truncated ? '<p class="small-label">只列出前 500 个，共 ' + d.count + ' 个。</p>' : '');
  }

  function syncTargetText(info) {
    const mine = clientVersion() || (info && info.localVersion) || '';
    return '本机 <b>v' + esc(mine || '未知') + '</b>' +
      (info && info.localBuild ? '（构建 ' + esc(shortBuild(info.localBuild)) + '）' : '') +
      ' → 服务器 <b>v' + esc((info && info.version) || '?') + '</b>' +
      (info && info.build ? '（构建 ' + esc(shortBuild(info.build)) + '）' : '');
  }
  function showSyncFiles(info) {
    const c = C();
    if (!c || typeof c.modal !== 'function') { toast(syncDiffText(info)); return; }
    const d = info && info.diff;
    const body = '<p>' + syncTargetText(info) + '</p>' +
      '<p class="small-label">' + esc(syncDiffText(info)) + '</p>' +
      (syncCategoriesText(info) ? '<p class="small-label">' + esc(syncCategoriesText(info)) + '</p>' : '') +
      (d ? syncFilesHtml(info) : '');
    c.modal('将同步的文件', body, [{ label: '返回', cls: 'muted' }], { small: false });
  }
  async function runOwnerSync(info, canReplace) {
    if (!canReplace) { openExternalUrl(ownerDownloadUrl(info)); return; }
    const native = window.__TAURI_INTERNALS__;
    const url = String(Net.base()).replace(/\/+$/, '') + info.exe;
    toast('正在下载 v' + info.version + '，请稍候…');
    try {
      await native.invoke('online_sync_client', { url, version: info.version });
      toast('已同步到 v' + info.version + '，关闭游戏后重新打开即可生效。');
    } catch (e) { toast('同步失败：' + String((e && (e.message || e)) || e)); }
  }
  // 开发机：本机重新打包客户端（前端快照 + EXE）并自动重启。
  function openDevRebuild() {
    const native = window.__TAURI_INTERNALS__;
    if (!native || typeof native.invoke !== 'function') { toast('只有 Windows 桌面客户端支持本机打包。'); return; }
    const go = () => {
      toast('正在重新打包，完成后会自动重启…');
      Promise.resolve(native.invoke('online_dev_rebuild')).catch((e) => {
        toast('打包启动失败：' + String((e && (e.message || e)) || e));
      });
    };
    const body = '<p>在本机重新编译 Windows 轻壳客户端，完成后自动重启游戏。</p>' +
      '<p class="small-label">轻壳的页面直接读仓库里的 js/css/images（改完刷新窗口即可），' +
      '只有改了 Rust / 窗口配置才需要这一步；通常 10~60 秒（第一次或 Rust 缓存被清掉时更久）。' +
      '游戏会先关闭，构建进度显示在新打开的命令窗口里；失败时旧客户端不会被替换。</p>';
    const c = C();
    if (!c || typeof c.modal !== 'function') {
      if (window.confirm('在本机重新打包并重启客户端？')) go();
      return;
    }
    c.modal('一键打包并重启', body, [
      { label: '开始打包', cls: 'gold', run: go },
      { label: '取消', cls: 'muted' },
    ], { small: true });
  }
  function openOwnerSync(info) {
    if (!info || !info.version) { toast('服务器还没有可同步的客户端包。'); return; }
    const mine = clientVersion() || (info && info.localVersion) || '';
    // 版本号没变、只改了代码时 `stale` 由构建号 / 文件清单给出；
    // 老服务端没有这个字段时才退回版本比较。
    const stale = info.stale != null ? !!info.stale : !!(mine && versionCompare(info.version, mine) > 0);
    if (!stale) { toast('已经是最新构建 v' + mine + '。'); return; }
    const android = /Android/i.test(String(navigator.userAgent || ''));
    const native = window.__TAURI_INTERNALS__;
    const canReplace = !!(!android && native && typeof native.invoke === 'function' && info.exe);
    let body = '<p>' + syncTargetText(info) + '</p>';
    if (info.notes) body += '<p class="small-label">更新说明：' + esc(info.notes) + '</p>';
    body += '<p class="small-label">' + esc(syncDiffText(info)) + '</p>';
    if (syncCategoriesText(info)) body += '<p class="small-label">' + esc(syncCategoriesText(info)) + '</p>';
    body += '<p class="small-label">客户端是整包替换' +
      (info.exeSize ? '（约 ' + fmtSyncSize(info.exeSize) + '）' : '') +
      '，不是逐文件下载；账号存档与设置不动。' +
      (canReplace ? '同步完成后关闭游戏、重新打开即可生效。' : '当前平台会打开下载页。') + '</p>';
    const c = C();
    if (!c || typeof c.modal !== 'function') {
      if (window.confirm('同步到 v' + info.version + '？\n' + syncDiffText(info))) void runOwnerSync(info, canReplace);
      return;
    }
    const buttons = [];
    if (info.diff && info.diff.count) {
      buttons.push({ label: '查看文件清单', cls: 'muted', close: false, run: () => showSyncFiles(info) });
    }
    buttons.push({ label: canReplace ? '开始同步' : '打开下载页', cls: 'gold', run: () => { void runOwnerSync(info, canReplace); } });
    buttons.push({ label: '取消', cls: 'muted' });
    c.modal('一键同步更改', body, buttons, { small: false });
  }
  // 客户端包里自带 `web-manifest.json`（构建脚本写到客户端根），里面是这个客户端构建
  // 的逐文件 sha256；服务器 `server/web-manifest.json` 是当前构建的同一份格式。
  // 两边都算一个构建号：新清单直接读 `build`（整份快照的 SHA-256），旧清单用原始文本
  function manifestHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function shortBuild(build) { return String(build || '').slice(0, 8); }
  // 读客户端自己包里的清单。浏览器（开发页）没有这个文件 → 返回 null，走服务端旧逻辑。
  // 清单在本次启动内不会变；设置页每次切换开关都重建，不能每次重读 140 KB。
  let localManifestCache = null, localManifestLoading = null;
  function localManifest() {
    if (localManifestCache) return Promise.resolve(localManifestCache);
    if (localManifestLoading) return localManifestLoading;
    localManifestLoading = (async () => {
      try {
        const res = await fetch('web-manifest.json', { cache: 'no-store' });
        if (!res || !res.ok) return null;
        const text = await res.text();
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.files)) return null;
        localManifestCache = {
          version: String(data.version || ''),
          files: data.files,
          build: String(data.build || (manifestHash(text) + '-' + data.files.length)),
        };
        return localManifestCache;
      } catch (e) { return null; }
      finally { localManifestLoading = null; }
    })();
    return localManifestLoading;
  }

  function diffManifests(oldFiles, newFiles) {
    const oldMap = new Map((oldFiles || []).map((f) => [String(f.path), f]));
    const newMap = new Map((newFiles || []).map((f) => [String(f.path), f]));
    const files = [];
    const categories = {};
    let added = 0, changed = 0, removed = 0, bytes = 0;
    const bump = (filePath) => {
      const key = filePath.includes('/') ? filePath.split('/')[0] : '根目录';
      categories[key] = (categories[key] || 0) + 1;
    };
    for (const f of newFiles || []) {
      const before = oldMap.get(String(f.path));
      if (!before) {
        files.push({ path: f.path, status: 'added', size: Number(f.size) || 0 });
        added++; bytes += Number(f.size) || 0; bump(String(f.path));
      } else if (String(before.sha256) !== String(f.sha256)) {
        files.push({ path: f.path, status: 'changed', size: Number(f.size) || 0 });
        changed++; bytes += Number(f.size) || 0; bump(String(f.path));
      }
    }
    for (const f of oldFiles || []) {
      if (newMap.has(String(f.path))) continue;
      files.push({ path: f.path, status: 'removed', size: Number(f.size) || 0 });
      removed++; bump(String(f.path));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const shown = files.slice(0, 500);
    return {
      added, changed, removed, count: files.length, bytes, categories,
      files: shown, truncated: files.length > shown.length,
    };
  }
  // 设置页挂载后异步问服务端「我是不是主人 + 这次会改哪些文件」；不是就保持面板隐藏。
  function loadOwnerPanel(p) {
    return (async () => {
      const local = await localManifest();
      const query = '/api/owner/sync/preview?from=' + encodeURIComponent(clientVersion() || '') +
        (local ? '&build=' + encodeURIComponent(local.build) : '');
      const info = await O.get(query);
      if (!p || !p.isConnected || !info || !info.owner) return;
      // 客户端自己有一份清单：以逐文件差异为准（版本号相同也能看出代码改动）。
      if (local) {
        info.localVersion = local.version;
        if (Array.isArray(info.manifest)) {
          info.diff = diffManifests(local.files, info.manifest);
          info.stale = info.diff.count > 0;
        }
        info.localBuild = local.build;
      }
      const panel = p.querySelector('[data-owner-panel]');
      if (!panel) return;
      panel.style.display = '';
      const mine = clientVersion() || (local && local.version) || '';
      const note = panel.querySelector('[data-owner-note]');
      if (note) {
        const stale = info.stale != null ? !!info.stale : (mine && versionCompare(info.version, mine) > 0);
        if (!info.version) note.textContent = '服务器还没有可下载的客户端包。';
        else if (!stale) note.textContent = '已是最新构建 v' + mine + (info.notes ? '。' + info.notes : '');
        else note.textContent = '本机 v' + (mine || '未知') +
          (info.localBuild ? '（构建 ' + shortBuild(info.localBuild) + '）' : '') +
          ' → 服务器 v' + info.version +
          (info.build ? '（构建 ' + shortBuild(info.build) + '）' : '') + '；' +
          syncDiffText(info) + (info.notes ? '。更新说明：' + info.notes : '');
      }
      const preview = panel.querySelector('[data-owner-preview]');
      if (preview) {

        preview.textContent = '查看文件清单';
        preview.onclick = () => showSyncFiles(info);
      }
      const sync = panel.querySelector('[data-owner-sync]');
      if (sync) {

        if (window.__SSDZ_ONLINE_SHELL__) sync.style.display = 'none';
        else sync.onclick = () => openOwnerSync(info);
      }
      const dl = panel.querySelector('[data-owner-download]');
      if (dl) dl.onclick = () => openExternalUrl(ownerDownloadUrl(info));
      const rebuild = panel.querySelector('[data-owner-rebuild]');
      if (rebuild) {
        const native = window.__TAURI_INTERNALS__;
        const android = /Android/i.test(String(navigator.userAgent || ''));
        if (!native || typeof native.invoke !== 'function' || android) {
          rebuild.style.display = 'none';
        } else {
          // 只有当前客户端确实在开发目录里才挂这颗键：普通玩家的机器上没有
          Promise.resolve(native.invoke('online_dev_status')).then((status) => {
            if (!panel.isConnected || !rebuild.isConnected) return;
            if (!status || !status.ok) { rebuild.style.display = 'none'; return; }
            rebuild.style.display = '';
            rebuild.onclick = () => openDevRebuild();
          }).catch(() => { rebuild.style.display = 'none'; });
        }
      }
      if (window.SfUiFeedback) [preview, sync, dl, rebuild].filter(Boolean).forEach((b) => SfUiFeedback.bind(b));
    })().catch(() => {});
  }


  function settingsPage() {
    const c = C(); if (!c || !c.page) return;
    const st = Main.settings(), account = Net.account() || {}, music = !Main.isMuted() && Main.volume() > 0;
    const resolutions = State.RESOLUTIONS || [], ri = Math.max(0, resolutions.findIndex(r => r.key === st.resolution));
    const button = (label, action, value, on) => '<button type="button" class="uc-button gold' + (on ? ' on' : '') + '" data-online-setting="' + action + '">' +
      label + (value ? '<span class="btn-badge">' + esc(value) + '</span>' : '') + '</button>';
    const p = c.page('system', 'system', (c.supportPanelHtml ? c.supportPanelHtml() : '') + '<div class="settings-head"><h3 class="classic-section-title">游戏设置</h3>' +
      '<div class="setting-slider music-setting' + (music ? ' on' : '') + '"><button type="button" class="music-toggle" aria-pressed="' + music + '"><span class="slider-label">音乐</span>' +
      '<b class="slider-value">' + (music ? Math.round(Main.volume() * 100) + '%' : '已静音') + '</b></button>' +
      '<input type="range" min="0" max="100" value="' + Math.round(Main.volume() * 100) + '" aria-label="音乐音量"><span class="music-hint">点击开关</span></div></div>' +
      '<div class="settings-grid system-grid online-settings-grid">' +
      button('跳过按钮', 'skip', st.showSkip !== false ? '开' : '关', st.showSkip !== false) +
      button('分辨率', 'resolution', (resolutions[ri] || {}).label || '自动') +
      button('全面屏', 'fullscreen', st.fullscreen ? '开' : '关', st.fullscreen) +
      button('状态栏', 'statusbar', st.hideStatusBar !== false ? '隐藏' : '显示', st.hideStatusBar !== false) +
      button('后台运行', 'background-run', st.backgroundRun === true ? '开' : '关', st.backgroundRun === true) + '</div>' +
      '<section class="online-account-panel"><div class="online-account-heading"><h3 class="classic-section-title">联机账号</h3><b>' + esc(account.name || State.state().name) +
      '</b>' + (account.forumAdmin ? '<span class="online-forum-badge" title="论坛管理员">管理员</span>' : '') +
      '</div><p class="small-label">玩家搜索 ID：<b>' + esc(account.playerId || '') + '</b>（昵称全服唯一，也可直接搜索昵称）</p><p class="small-label">' +
      (O.meta && O.meta.devicePolicy && O.meta.devicePolicy.required ? '本设备最多创建 3 个账号；同一账号同时只允许一台设备在线。' : '') + '</p>' +
      '<p class="small-label" data-device-quota>本设备已创建账号：读取中…</p><p class="small-label">' +
      '进度自动保存，声音与画面设置保存在本机。</p>' +
      '<div class="settings-grid online-settings-grid">' + button('同步进度', 'refresh') +
      button('检查更新', 'update') + button('修改昵称', 'rename') + button('修改密码', 'password') + button('退出登录', 'logout') + button('注销账号', 'delete') + '</div><p class="online-server-address">服务器：' + esc(Net.base()) + '</p></section>' +
      // 主人专属；服务端按 IP 确认前一直 display:none，普通玩家看不到。
      '<section class="online-account-panel online-owner-panel" data-owner-panel style="display:none">' +
      '<div class="online-account-heading"><h3 class="classic-section-title">开发者同步</h3><b>仅服务器主人可见</b></div>' +
      '<p class="small-label">把客户端同步到服务器当前版本；只替换客户端，不改账号存档。开发机还能在本机重新打包并重启。</p>' +
      '<div class="settings-grid online-settings-grid"><button type="button" class="uc-button" data-owner-preview>查看将同步的内容</button>' +
      '<button type="button" class="uc-button gold" data-owner-sync>一键同步更改</button>' +
      '<button type="button" class="uc-button" data-owner-download>下载页</button>' +
      // 只有当前客户端确实在开发目录里才显示（loadOwnerPanel 里问 online_dev_status）。
      '<button type="button" class="uc-button" data-owner-rebuild style="display:none">一键打包并重启</button></div>' +
      '<p class="small-label" data-owner-note>正在读取服务器清单…</p></section>');
    const bind = (name, fn) => { p.querySelector('[data-online-setting="' + name + '"]').onclick = fn; };
    const quotaEl = p.querySelector('[data-device-quota]');
    if (quotaEl) {
      O.get('/api/device/quota').then((q) => {
        if (!p.isConnected || !q) return;
        let text = q.creator
          ? '本设备为创作者设备 · 账号数不限'
          : '本设备已创建账号：' + Number(q.created || 0) + '/' + Number(q.limit || 3);
        if (!q.creator && Number(q.ipLimit) > 0) {
          text += '（本网络 IP：' + Number(q.ipCreated || 0) + '/' + Number(q.ipLimit) + '）';
        }
        const daily = q.daily || {};
        if (Number(daily.limit) > 0) {
          text += ' · 今日注册 ' + Number(daily.register || 0) + '/' + Number(daily.limit) +
            '、注销 ' + Number(daily.delete || 0) + '/' + Number(daily.limit);
        }
        quotaEl.textContent = text;
      }).catch(() => { if (p.isConnected) quotaEl.textContent = '账号额度暂时读取不到'; });
    }
    const support = p.querySelector('[data-action="support"]');
    if (support && c.openSupportModal) support.onclick = () => c.openSupportModal();
    bind('skip', () => { State.setSettings({ showSkip: st.showSkip === false }); settingsPage(); });
    bind('resolution', () => { if (resolutions.length) Main.setResolution(resolutions[(ri + 1) % resolutions.length].key); settingsPage(); });
    bind('fullscreen', () => { Main.setFullscreen(!st.fullscreen); settingsPage(); });
    bind('statusbar', () => { Main.setHideStatusBar(st.hideStatusBar === false); settingsPage(); });
    bind('background-run', () => { Main.setBackgroundRun(st.backgroundRun !== true); settingsPage(); });
    bind('logout', () => accountDialog(false)); bind('delete', () => accountDialog(true));
    bind('rename', () => renameDialog());
    bind('password', () => passwordDialog());
    bind('update', async () => {
      const b = p.querySelector('[data-online-setting="update"]');
      if (!window.OnlineUpdate || typeof OnlineUpdate.checkNow !== 'function') { toast('更新模块未加载，请重新打开游戏。'); return; }
      if (b) b.disabled = true;
      try {
        const out = await OnlineUpdate.checkNow();
        if (!out || !out.ok) { toast((out && out.busy) ? '正在检查更新，请稍候。' : ((out && out.error) || '检查更新失败。')); return; }
        if (out.latest) toast('已是最新版本 v' + out.version + '。');
      } finally { if (p.isConnected && b) b.disabled = false; }
    });
    bind('refresh', async () => {
      const b = p.querySelector('[data-online-setting="refresh"]'); b.disabled = true;
      try { await O.syncState(); if (p.isConnected) { settingsPage(); toast('进度已同步。'); } }
      catch (e) { toast(O.errText(e)); } finally { b.disabled = false; }
    });
    const row = p.querySelector('.music-setting'), range = row.querySelector('input');
    const paint = () => {
      const volume = Math.round(Main.volume() * 100), on = !Main.isMuted() && volume > 0;
      row.classList.toggle('on', on); row.querySelector('button').setAttribute('aria-pressed', String(on));
      row.querySelector('.slider-value').textContent = on ? volume + '%' : '已静音';
      range.style.setProperty('--fill', volume + '%'); range.style.setProperty('--fillN', String(volume / 100));
    };
    row.querySelector('button').onclick = () => { Main.setMuted(!Main.isMuted()); paint(); };
    range.oninput = () => { Main.setVolume(Number(range.value) / 100); paint(); };
    paint();
    if (window.SfUiFeedback) p.querySelectorAll('.uc-button, .music-toggle').forEach(b => SfUiFeedback.bind(b));
    void loadOwnerPanel(p);
    return p;
  }

  U.passwordDialog = passwordDialog;
  U.renameDialog = renameDialog;
  U.openOwnerSync = openOwnerSync;
  U.settingsPage = settingsPage;
  U.ownerSync = openOwnerSync;
})();
