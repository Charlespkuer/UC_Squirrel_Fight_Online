// online-ui.js — 联机版新增/改造的界面
(function () {
  'use strict';

  const O = window.Online;
  let loginSeq = 0, loginView = null, loginElement = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  function ui() { return window.UI || null; }
  function C() { return (window.UI && UI.classic) || null; }
  function classic() { return window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic'; }
  function uiRoot() { return document.getElementById('ui'); }

  function toast(msg) { O.toast(msg); }

  // 新密码规范（与服务端 `auth.normalizePassword` 保持一致）：
  function passwordProblem(pass) {
    const s = String(pass == null ? '' : pass);
    const length = [...s].length;
    if (length < 6) return '密码至少 6 位。';
    if (length > 128) return '密码太长。';
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return '密码必须同时包含字母和数字。';
    return '';
  }
  // 昵称规范（与服务端 `auth.normalizeName` 共用 `js/nickname.js`）：
  function nameProblem(name) {
    const rules = window.NicknameRules;
    if (!rules || typeof rules.check !== 'function') return '';
    const out = rules.check(name);
    return out.ok ? '' : out.reason || '昵称不可用';
  }


  const FIRST_RUN_KEY = 'ssdz-online-first-run-done';
  let firstRunRegister = false;
  let firstRunNoticeShown = false;

  let firstRunSession = false;

  function claimFirstRun() {
    let first = false;
    try {
      if (localStorage.getItem(FIRST_RUN_KEY) !== '1') {
        const hasName = !!localStorage.getItem('ssdz-online-username');
        const hasToken = !!(window.Net && Net.token && Net.token());
        first = !hasName && !hasToken;
        localStorage.setItem(FIRST_RUN_KEY, '1');
      }
    } catch (e) {  }
    return first;
  }

  function noticeModel() {
    const n = window.OnlineNotice;
    if (n && Array.isArray(n.pages) && n.pages.length) return n;
    return {
      title: '游戏公告',
      version: '',
      pages: [{ title: '游戏公告', html: '<p>公告内容没有加载成功，请更新客户端后重试。</p>' }],
    };
  }

  function versionCompare(a, b) {
    if (window.OnlineUpdate && typeof OnlineUpdate.compareVersion === 'function') return OnlineUpdate.compareVersion(a, b);
    const A = String(a || '').split('.').map((n) => Number(n) || 0);
    const B = String(b || '').split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const x = A[i] || 0, y = B[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }


  function releasesModel(currentVersion) {
    const n = window.OnlineNotice;
    let list = (n && Array.isArray(n.releases)) ? n.releases.slice() : [];
    if (!list.length) return null;
    // 只展示「不高于本机版本」的条目：旧客户端不该提前看到还没装上的版本说明。
    const cur = String(currentVersion || '').replace(/^v/i, '');
    if (cur) {
      const visible = list.filter((r) => versionCompare((r && r.version) || '', cur) <= 0);
      if (visible.length) list = visible;
    }
    const newest = list[0] || {};
    return {
      title: '更新公告',
      version: String(currentVersion || newest.version || ''),
      updatedAt: String(newest.date || ''),
      pages: list.map((r) => ({
        title: 'v' + String(r.version || '') + (r.date ? ' · ' + r.date : ''),
        html: '<p>' + String(r.notes || '') + '</p>',
      })),
    };
  }

  async function openNotice(model) {
    const data = (model && Array.isArray(model.pages) && model.pages.length) ? model : noticeModel();
    if (document.querySelector('.online-notice-original')) return null;
    const root = uiRoot();
    if (!root || !window.SfRender || !SfRender.mountSymbol) { toast(data.title); return null; }
    const prevZ = root.style.zIndex;

    root.style.zIndex = '95';
    const host = document.createElement('section');
    // 不要带 `classic-home`：`#ui:has(.classic-page) .classic-home` 会把帮助页上
    host.className = 'ssfight-home online-notice-original';
    host.setAttribute('aria-label', data.title || '游戏公告');
    root.appendChild(host);
    let view = null;
    let closed = false;
    let place = null;
    let ro = null;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      if (place) window.removeEventListener('resize', place);
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      try { if (view) view.destroy(); } catch (e) {}
      host.remove();
      if (root) root.style.zIndex = prevZ;
    }
    document.addEventListener('keydown', onKey);
    try {

      await SfRender.loadExtra('tags-notice.json');
      view = await SfRender.mountSymbol(host, '4406', { frame: 1, label: '游戏公告' });
      if (closed) return null;

      try {
        const shade = view.nodes && view.nodes.get(1);
        if (shade && shade.node) shade.node.style.display = 'none';
      } catch (e) {}
      let infoNode = null;
      try {
        const info = view.byName('info');
        if (info) { infoNode = info.g || info; infoNode.style.visibility = 'hidden'; }
      } catch (e) {}
      const body = document.createElement('div');
      body.className = 'online-notice-original-body';
      body.innerHTML =
        '<div class="online-notice-original-kicker">松鼠大战 Online' +
        (data.version ? ' · ' + esc(data.version) : '') +
        (data.updatedAt ? ' · ' + esc(data.updatedAt) : '') + '</div>' +
        data.pages.map((p) => '<h3>' + esc(p.title) + '</h3><div class="online-notice-original-copy">' + p.html + '</div>').join('<hr>');
      host.appendChild(body);
      const svg = host.querySelector('svg');

      const paperNode = svg && [...svg.querySelectorAll('path')].find((p) =>
        p.getAttribute('fill') === 'rgb(249,241,218)' &&
        !p.closest('clipPath,defs,mask'));
      place = () => {
        if (!svg || !body) return;
        const hr = host.getBoundingClientRect(), sr = svg.getBoundingClientRect();
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const vw = (vb && vb.width) || 320, vh = (vb && vb.height) || 196;
        // ⚠ 公告挂在 #ui 里，而 #ui 整体带 `transform: scale(--uiscale)` 适配窗口。
        const uiscale = (host.clientWidth > 0 && hr.width > 0) ? hr.width / host.clientWidth : 1;
        const sx = (svg.clientWidth || sr.width / uiscale) / vw;
        const sy = (svg.clientHeight || sr.height / uiscale) / vh;
        // 安卓 Tauri WebView 的窄屏会把 4406 包装层整体右移，纸面 path 的 bbox
        const androidShell = !!(typeof window !== 'undefined' && window.__TAURI_INTERNALS__) &&
          /Android/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
        const narrow = (window.innerWidth || 0) < 1000 || (window.innerHeight || 0) < 500;
        const useStage = androidShell && narrow;
        let pr = null;
        try { if (paperNode && paperNode.getBoundingClientRect) pr = paperNode.getBoundingClientRect(); } catch (e) {}
        let bodyLeft, bodyWidth;
        if (useStage) {
          // 安卓窄屏：纸面 path 会被木轴挤偏，但“可见米色纸面”仍以 path 宽度为上限；
          if (pr) {
            const widthScreen = pr.width * 0.8;
            const centerScreen = (pr.left + pr.right) / 2;
            bodyLeft = (centerScreen - widthScreen / 2 - hr.left) / uiscale;
            bodyWidth = widthScreen / uiscale;
          } else {
            let br = null;
            try {
              const node = (view.nodes && view.nodes.get(12) && view.nodes.get(12).node) ||
                svg.querySelector('[sid="3152"]');
              if (node && node.getBoundingClientRect) br = node.getBoundingClientRect();
            } catch (e) {}
            if (br && br.width > 0) {
              const widthScreen = br.width * 1.8;
              const centerScreen = (br.left + br.right) / 2;
              bodyLeft = (centerScreen - widthScreen / 2 - hr.left) / uiscale;
              bodyWidth = widthScreen / uiscale;
            } else {
              bodyLeft = (sr.left - hr.left) / uiscale + 140 * sx;
              bodyWidth = (237 - 140) * sx;
            }
          }
        } else if (!pr) {
          bodyLeft = (sr.left - hr.left) / uiscale + 140 * sx;
          bodyWidth = (237 - 140) * sx;
        } else {
          const widthScreen = pr.width * 0.9;
          const centerScreen = (pr.left + pr.right) / 2;
          bodyLeft = (centerScreen - widthScreen / 2 - hr.left) / uiscale;
          bodyWidth = widthScreen / uiscale;
        }
        body.style.left = bodyLeft + 'px';
        body.style.top = ((sr.top - hr.top) / uiscale + 54 * sy) + 'px';
        body.style.width = bodyWidth + 'px';
        body.style.height = ((140 - 54) * sy) + 'px';
        body.style.fontSize = Math.max(11, Math.round(5.4 * sy)) + 'px';
      };
      place();
      setTimeout(place, 60);
      window.addEventListener('resize', place);

      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => place());
        ro.observe(svg);
        ro.observe(host);
      }

      const rec = view.nodes && view.nodes.get(12);
      const btn = view.g.querySelector('[sid="3152"]') || (rec && rec.node);
      if (btn) {
        btn.style.cursor = 'pointer';
        btn.setAttribute('aria-label', '关闭公告');
        btn.onclick = close;

        const br = btn.getBoundingClientRect(), hr = host.getBoundingClientRect();
        const hit = document.createElement('button');
        hit.type = 'button';
        hit.className = 'online-notice-original-hit';
        hit.setAttribute('aria-label', '关闭公告');
        hit.style.left = (br.left - hr.left) + 'px';
        hit.style.top = (br.top - hr.top) + 'px';
        hit.style.width = br.width + 'px';
        hit.style.height = br.height + 'px';
        hit.onclick = close;
        host.appendChild(hit);
      }
      try { localStorage.setItem('ssdz-online-notice-seen', '1'); } catch (e) {}
      return { close, element: host };
    } catch (e) {
      close();

      const c = C();
      if (c && c.modal) {
        c.modal(data.title || '游戏公告', '<div class="game-notice-text">' +
          data.pages.map((p) => '<h3>' + esc(p.title) + '</h3>' + p.html).join('<hr>') + '</div>',
          [{ label: '知道了', primary: true }], { small: false });
      } else toast(data.title);
      return null;
    }
  }

  // 「更新公告」：帮助页入口与「客户端更新后自动弹出」共用。
  async function openReleases(currentVersion) {
    const version = currentVersion || await localBuildVersion();
    const model = releasesModel(version);
    if (!model) { toast('还没有更新记录。'); return null; }
    return openNotice(model);
  }

  // 客户端更新后：下一次打开游戏自动弹「更新公告」
  // 只看客户端自己的版本号（EXE/APK 里的 `__SSDZ_VERSION`，其次 `scripts/version.json`）：
  const RELEASE_SEEN_KEY = 'ssdz-online-release-seen';
  let releaseCheckStarted = false;
  async function localBuildVersion() {
    if (window.OnlineUpdate && typeof OnlineUpdate.readLocalVersion === 'function') {
      try {
        const v = await OnlineUpdate.readLocalVersion();
        if (v) return String(v).replace(/^v/i, '');
      } catch (e) {}
    }
    if (window.__SSDZ_VERSION) return String(window.__SSDZ_VERSION).replace(/^v/i, '');
    try {
      const r = await fetch('scripts/version.json', { cache: 'no-store' });
      const j = await r.json();
      return String((j && j.version) || '').replace(/^v/i, '');
    } catch (e) { return ''; }
  }
  async function maybeShowReleaseNotice() {
    if (releaseCheckStarted) return;
    releaseCheckStarted = true;
    const n = window.OnlineNotice;
    const list = (n && Array.isArray(n.releases)) ? n.releases : [];
    if (!list.length) return;
    const current = await localBuildVersion();
    if (!current) return;
    let seen = '';
    try { seen = String(localStorage.getItem(RELEASE_SEEN_KEY) || ''); } catch (e) {}

    if (firstRunSession) { try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {} return; }
    if (seen && versionCompare(current, seen) <= 0) return;
    if (!seen) {
      // 没有历史版本：老玩家（有账号）当作刚更新，弹一次；否则只记基线。
      let hasAccount = false;
      try { hasAccount = !!localStorage.getItem('ssdz-online-username') || !!(window.Net && Net.token && Net.token()); } catch (e) {}
      if (!hasAccount) { try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {} return; }
    }

    const visible = list.filter((r) => versionCompare((r && r.version) || '', current) <= 0);
    const hasNew = visible.some((r) => versionCompare((r && r.version) || '', seen || '0') > 0);
    try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {}
    if (!hasNew) return;
    if (document.querySelector('.online-notice-original')) return;
    // 等首页画出来；如果正好有经典弹窗（安全提醒、宝箱等）在，等它关掉再叠公告板。
    const tryOpen = (left) => {
      if (document.querySelector('.online-notice-original')) return;
      if (document.querySelector('.classic-modal-overlay')) {
        if (left > 0) setTimeout(() => tryOpen(left - 1), 800);
        return;
      }
      try { openReleases(current).catch(() => {}); } catch (e) {}
    };
    setTimeout(() => tryOpen(15), 500);
  }


  function confirmBox(label, text, accept, cancel) {
    if (classic() && window.SfChallenge && SfChallenge.openOriginalConfirm) {
      return SfChallenge.openOriginalConfirm({
        owner: document.querySelector('section[aria-label="征战"]'),
        label, text, accept: accept || (() => {}), swapButtons: true, extraGap: 20,
      }).catch(() => { const c = C(); if (c && c.modal) c.modal(label, text.replace(/\n/g, '<br>'), [
        { label: '确定', primary: true, run: accept }, { label: '取消', cls: 'muted', run: cancel },
      ], { small: true }); });
    }
    const c = C();
    if (c && c.modal) {
      c.modal(label, '<p>' + String(text).replace(/\n/g, '<br>') + '</p>', [
        { label: '确定', primary: true, run: accept }, { label: '取消', cls: 'muted', run: cancel },
      ], { small: true });
      return Promise.resolve();
    }
    if (accept) accept();
    return Promise.resolve();
  }


  function loginHost() {
    const root = uiRoot();
    if (!root) return null;
    if (OnlineUI.stopCampaignWatch) OnlineUI.stopCampaignWatch();
    if (OnlineUI.hideCampaignStatus) OnlineUI.hideCampaignStatus();
    if (OnlineUI.closeCampaignView) OnlineUI.closeCampaignView();
    closeLogin(); root.innerHTML = '';
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-home online-login';
    host.setAttribute('aria-label', '登录');
    (document.getElementById('app') || document.body).appendChild(host);
    loginElement = host;
    return host;
  }
  function closeLogin() {
    loginSeq++;
    if (loginView) { try { loginView.destroy(); } catch (e) {} loginView = null; }
    if (loginElement) { loginElement.remove(); loginElement = null; }
  }


  async function mountLoginBackdrop(host, mine) {
    if (mine !== loginSeq || !host.isConnected) return null;
    const image = document.createElement('img');
    const asset = (p) => (window.SfRender && SfRender.assetUrl) ? SfRender.assetUrl(p) : p;
    image.src = asset('images/ssfight/ui/bitmap/6835_0.hd.webp');
    image.alt = '';
    image.onerror = () => {
      image.onerror = null;
      image.src = asset('images/ssfight/ui/bitmap/6835_0.hd.jpg');
    };
    host.appendChild(image);
    return null;
  }

  function loginForm(host, mode) {
    const recovering = mode === 'recover';
    const strong = mode === 'register' || recovering;
    const card = document.createElement('form');
    card.className = 'online-login-card';
    card.setAttribute('autocomplete', 'off');
    card.innerHTML =
      '<h1 class="online-login-title">松鼠大战 Online</h1>' +
      '<p class="online-login-sub">' + (recovering ? '使用注册时保存的恢复码找回账号' : mode === 'register' ? '新建一个账号' : '用账号密码登录') + '</p>' +
      '<label>' + (recovering ? '恢复码' : '名字') + '<input name="name" maxlength="' + (recovering ? '128' : '21') + '" autocomplete="' + (recovering ? 'off' : 'username') + '" required></label>' +
      (mode === 'register' ? '<p class="online-login-hint" data-name-hint></p>' +
        '<p class="online-login-hint">同一网络每天的注册 / 注销次数有限，超出需等次日 0 点。</p>' : '') +
      '<label>' + (recovering ? '新密码' : '密码') + '<input name="password" type="password" maxlength="128" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" required></label>' +
      (strong ? '<p class="online-login-hint">至少 6 位，且同时包含字母和数字。</p>' : '') +
      '<p class="online-login-note" data-note></p>' +
      '<div class="online-login-actions">' +
      '<button type="submit" class="online-btn primary">' + (recovering ? '重置并登录' : mode === 'register' ? '注册并进入' : '登录') + '</button>' +
      '<button type="button" class="online-btn" data-switch>' + (mode === 'register' || recovering ? '返回登录' : '注册新账号') + '</button>' +
      '</div>' +
      (mode === 'login' ? '<button type="button" class="online-recover-link" data-recover>忘记密码？使用恢复码</button><button type="button" class="online-recover-link" data-delete>注销该机账号</button>' : '') +
      '<p class="online-login-foot" data-server>服务器：' + esc(window.Net.base() || window.Net.baseUrl() || '同源') + '</p>' +
      '<p class="online-login-note" data-conn></p>';
    host.appendChild(card);

    if (mode === 'login') { try { card.elements.name.value = localStorage.getItem('ssdz-online-username') || ''; } catch (e) {} }
    const note = card.querySelector('[data-note]');
    const conn = card.querySelector('[data-conn]');
    const serverLine = card.querySelector('[data-server]');
    const setNote = (t, bad) => { note.textContent = t || ''; note.className = 'online-login-note' + (bad ? ' bad' : ''); };
    const setConn = (t, bad) => { conn.textContent = t || ''; conn.className = 'online-login-note' + (bad ? ' bad' : ''); };

    // 注册页昵称失焦时查一次重名（服务端注册时仍会再查一遍，防并发）。
    const nameHint = card.querySelector('[data-name-hint]');
    if (mode === 'register' && nameHint) {
      const input = card.elements.name;
      let nameSeq = 0;
      const NAME_HINT = '最多 7 个汉字（英文/数字按 1/3 个汉字计，最多 21 个）。';
      const setNameHint = (text, bad) => {
        nameHint.textContent = text || (bad ? '' : NAME_HINT);
        nameHint.className = 'online-login-hint' + (bad ? ' bad' : '');
      };
      setNameHint('');
      input.addEventListener('input', () => {
        nameSeq++;
        const problem = nameProblem(input.value);
        setNameHint(problem, !!problem);
      });
      input.addEventListener('blur', async () => {
        const value = String(input.value || '').trim();
        const mine = ++nameSeq;
        if (!value) { setNameHint(''); return; }
        const problem = nameProblem(value);
        if (problem) { setNameHint(problem, true); return; }
        setNameHint('正在检查昵称…');
        try {
          const out = await O.get('/api/check-name?name=' + encodeURIComponent(value));
          if (mine !== nameSeq || !card.isConnected) return;
          setNameHint(out && out.available === false ? ((out.reason || '这个昵称不可用') + '。') : '', out && out.available === false);
        } catch (e) {
          if (mine === nameSeq) setNameHint('');
        }
      });
    }


    async function checkServer() {
      setConn('正在连接服务器…');
      try {
        const out = await window.Net.discover();
        serverLine.textContent = '服务器：' + out.base;
        setConn('已连接 · 版本 ' + ((out.health && (out.health.gameVersion || out.health.version)) || '?'));
        return true;
      } catch (err) {
        const tried = (window.Net.tried && window.Net.tried()) || [];
        setConn((err && err.message) || '连不上服务器', true);
        if (tried.length) serverLine.textContent = '尝试过：' + tried.join('　');
        return false;
      }
    }
    card.__checkServer = checkServer;

    checkServer();

    card.querySelector('[data-switch]').onclick = () => {
      firstRunRegister = false;
      showLogin(mode === 'register' || recovering ? 'login' : 'register', null, { explicit: true });
    };
    const recoverButton = card.querySelector('[data-recover]');
    if (recoverButton) recoverButton.onclick = () => {
      firstRunRegister = false;
      showLogin('recover', null, { explicit: true });
    };
    const deleteButton = card.querySelector('[data-delete]');
    if (deleteButton) deleteButton.onclick = async () => {
      const name = String(card.elements.name.value || '').trim(), password = String(card.elements.password.value || '');
      if (!name || !password) { setNote('请填写本机账号的名字和密码', true); return; }
      if (!window.confirm('永久注销账号？角色进度和好友关系将被删除，无法恢复。\n同一网络每天的注销次数有限，超出需等次日 0 点。')) return;
      if (card.__busy) return;
      card.__busy = true; card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        setNote('正在注销…');
        await O.login(name, password);
        await O.deleteAccount(password);
        try { localStorage.removeItem('ssdz-online-username'); } catch (e) {}
        if (card.isConnected) showLogin('register');
      } catch (err) { if (card.isConnected) setNote(O.errText(err), true); }
      finally { card.__busy = false; card.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    card.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(card.elements.name.value || '').trim();
      const password = String(card.elements.password.value || '');
      if (!name || !password) { setNote((recovering ? '恢复码和新密码' : '名字和密码') + '都要填', true); return; }
      if (mode === 'register') {
        const problem = nameProblem(name);
        if (problem) { setNote(problem, true); card.elements.name.focus(); return; }
      }
      if (strong) {
        const problem = passwordProblem(password);
        if (problem) { setNote(problem, true); card.elements.password.focus(); return; }
      }
      if (card.__busy) return;
      card.__busy = true;
      card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      setNote('正在连接服务器…');
      try {
        const out = recovering ? await O.recover(name, password) : mode === 'register' ? await O.register(name, password) : await O.login(name, password);
        if (!card.isConnected) return;
        const rememberedName = recovering ? out.profile && out.profile.account && out.profile.account.name : name;
        if (rememberedName) { try { localStorage.setItem('ssdz-online-username', rememberedName); } catch (e) {} }
        setNote('');
        if (OnlineUI.stopCampaignWatch) OnlineUI.stopCampaignWatch();
        await OnlineUI.enterGame();
        if (Number(out.kickedSessions) > 0) {
          toast('已登录；其他 ' + Number(out.kickedSessions) + ' 个设备的登录已失效');
        }
        if (out.recoveryCode) showRecoveryCode(out.recoveryCode);
      } catch (err) {

        if (!recovering && err && err.code === 'NETWORK') {
          setNote('连不上服务器，正在重试…', true);
          const ok = await checkServer();
          if (ok) {
            try {
              await O.login(name, password);
              try { localStorage.setItem('ssdz-online-username', name); } catch (e) {}
              if (!card.isConnected) return;
              setNote('');
              if (OnlineUI.stopCampaignWatch) OnlineUI.stopCampaignWatch();
              await OnlineUI.enterGame();
              return;
            } catch (err2) { if (card.isConnected) setNote(O.errText(err2), true); return; }
          }
        }
        if (card.isConnected) setNote(O.errText(err), true);
      } finally {
        card.__busy = false;
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    };
    try { card.elements.name.focus(); } catch (e) {}
  }

  async function showLogin(mode, message, opts) {
    const first = claimFirstRun();
    if (first) { firstRunRegister = true; firstRunSession = true; }

    if (firstRunRegister && !(opts && opts.explicit) && (!mode || mode === 'login')) mode = 'register';
    const host = loginHost();
    if (!host) return;
    const mine = loginSeq, backdrop = document.createElement('div');
    backdrop.className = 'online-login-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    host.appendChild(backdrop);
    loginForm(host, mode || 'login');
    if (message) {
      const note = host.querySelector('[data-note]');
      note.textContent = message; note.classList.add('bad');
    }
    await mountLoginBackdrop(backdrop, mine);
    if (first && !firstRunNoticeShown) {
      firstRunNoticeShown = true;

      setTimeout(() => {
        if (!host.isConnected) return;
        try { openNotice().catch(() => {}); } catch (e) { /* 公告失败不能挡登录 */ }
      }, 120);
    }
  }


  function showRecoveryCode(code) {
    const c = C(); if (!c) return;
    const m = c.modal('保存账号恢复码', '<p>忘记密码时，可用此码重置密码。请妥善保存，不要告诉其他人。</p>' +
      '<input class="online-recovery-code" readonly aria-label="账号恢复码" value="' + esc(code) + '">' +
      '<p class="small-label">恢复码不会保存到本机。使用后会生成新的恢复码。</p>', [
      { label: '已妥善保存', cls: 'gold' },
    ], { small: true, locked: true });
    const input = m.element.querySelector('input'); input.onclick = () => { input.select(); input.setSelectionRange(0, input.value.length); };
  }


  // 登录安全提醒：新设备/新地点登录只提醒，不拒绝登录。
  function showSecurityAlerts() {
    const alerts = (O.alerts || []).filter((a) => a && a.id).slice(0, 5);
    if (!alerts.length) return Promise.resolve();
    const ids = alerts.map((a) => String(a.id));
    const finish = async () => {
      O.clearAlerts(ids);
      try { await O.post('/api/messages/read', { ids }); } catch (e) {  }
      try { if (O.refreshBadge) void O.refreshBadge(); } catch (e) {}
    };
    const c = C();
    if (!c || typeof c.modal !== 'function') {
      toast(alerts[0].text || '账号安全提醒：检测到新设备或新地点登录。');
      void finish();
      return Promise.resolve();
    }
    const body = alerts.map((a) => '<p>' + esc(a.text || '账号在新设备或新地点登录。') + '</p>').join('');
    return new Promise((resolve) => {
      try {
        c.modal('账号安全提醒', '<div class="result-box">' + body + '</div>',
          [{ label: '知道了', primary: true, run: async () => { await finish(); resolve(); } }],
          { small: true, locked: true });
      } catch (e) {
        toast(alerts[0].text || '账号安全提醒');
        void finish();
        resolve();
      }
    });
  }

  // 上次大退/杀进程时没结算完的果实与升级三选一：登录后替玩家默认落定。
  // 必须在 showHome 之前跑：此时 #ui 里还没有 classic-home/classic-page，补弹看门狗不会抢状态。
  let bootChoiceSettle = null;
  function pendingFruitChoices() {
    try {
      return (window.State && typeof State.pendingFruitChoices === 'function') ? State.pendingFruitChoices() : [];
    } catch (e) { return []; }
  }
  function pendingWsCount() {
    try {
      return (window.State && typeof State.pendingWS === 'function') ? Number(State.pendingWS()) || 0 : 0;
    } catch (e) { return 0; }
  }
  function settlePendingChoicesOnBoot() {
    if (bootChoiceSettle) return bootChoiceSettle;
    bootChoiceSettle = (async () => {
      const notes = [];
      if (!O.ready) return notes;
      for (const item of pendingFruitChoices()) {
        const c = item && Array.isArray(item.options) ? item.options[0] : null;
        if (!item || !c) continue;
        const label = item.fruit === 48 ? '恶魔果实' : '天使果实';
        try {
          const r = await O.call('applyFruitChoice', item.fruit, c.kind, c.id);
          if (r && r.ok) notes.push('上次未完成的' + label + '已自动使用：' + (r.msg || '结算完成'));
          else {
            // 候选失效（例如大退期间通过别的途径拿到了同一招）时按取消消耗，别让它永远挂着。
            try {
              const c2 = await O.call('cancelFruitChoice', item.fruit);
              if (c2 && c2.ok) notes.push('上次未完成的' + label + '：' + (c2.msg || '已结算'));
            } catch (e2) {}
          }
        } catch (e) {
          // 网络失败：保留待选，下次登录再结算。
        }
      }
      if (pendingWsCount() > 0) {
        try {
          const r = await O.call('chooseWSRandom');
          if (r && r.ok && Array.isArray(r.got) && r.got.length) {
            notes.push('上次未选择的升级武技已自动随机：' + r.got.join('、'));
          }
        } catch (e) {}
      }
      return notes;
    })().finally(() => { bootChoiceSettle = null; });
    return bootChoiceSettle;
  }

  const OnlineUI = {
    showLogin,
    enterGame: async function enterGame() {
      firstRunRegister = false;
      closeLogin();
      let settleNotes = [];
      const hasPending = pendingFruitChoices().length > 0 || pendingWsCount() > 0;
      if (hasPending) toast('正在结算上次未完成的选择…');
      try { settleNotes = await settlePendingChoicesOnBoot(); } catch (e) {}
      try { if (window.Main && Main.showHome) Main.showHome();
        else if (window.UI && UI.runAction) UI.runAction('home'); } catch (e) {}
      if (settleNotes.length) setTimeout(() => toast(settleNotes.join('；')), 600);
      // 安全提醒优先于宝箱提示：让玩家先看到“新设备登录”，再继续日常流程。
      try { await showSecurityAlerts(); } catch (e) { /* 提醒失败不能挡进游戏 */ }
      // 客户端更新后的第一次启动：叠一张「更新公告」（是否弹由本地版本号决定）。
      try { await maybeShowReleaseNotice(); } catch (e) { /* 公告失败不能挡进游戏 */ }
      // 活动页「徒弟日供」卡要读服务端数值；登录后先拉一次，失败不打断进游戏。
      try { if (window.ClassicExtras && ClassicExtras.prefetchApprentice) ClassicExtras.prefetchApprentice(); } catch (e) {}
      // 上次报名/匹配完的征战可能在玩家离线时已经结算：稍后接回 watcher，
      // 不要和安全提醒弹窗抢输入。
      setTimeout(() => { if (OnlineUI.resumeCampaignWatch) void OnlineUI.resumeCampaignWatch(); }, 1200);
      try {
        const pending = await O.get('/api/battle/chest');
        if (O.ready && pending.pendingCount && O.battle) {
          const session = Net.token();
          const offer = () => {
            if (!O.ready || Net.token() !== session) return;

            if (document.querySelector('.classic-modal-overlay') || document.querySelector('.online-notice-original')) { setTimeout(offer, 1000); return; }
            void O.battle.pendingChests(pending);
          };
          setTimeout(offer, 500);
        }
      } catch (e) { /* Login remains available during an API upgrade. */ }
    },
    openNotice,
    openReleases,
    resumeCampaign: () => (OnlineUI.resumeCampaignWatch ? OnlineUI.resumeCampaignWatch() : null),
    logout: async function logout() {
      try { await O.logout(); } catch (e) {}
      showLogin('login');
    },
  };

  OnlineUI._ = { O, esc, toast, C, uiRoot, confirmBox, showLogin, passwordProblem, nameProblem, versionCompare,
    settlePendingChoicesOnBoot };
  window.OnlineUI = OnlineUI;
})();
