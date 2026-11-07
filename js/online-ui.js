/* ============================================================
 * online-ui.js — 联机版新增/改造的界面
 * ------------------------------------------------------------
 * 原则（用户 2026-10 口径）：**能用 ssfight 原版元件就用原版，不自绘**。
 *   · 登录页：原版没有表单（原版是 UC 渠道登录），所以只做**一层**表单，
 *     背景复用原版载入画面位图 6835，不挂其中的断线提示与刷新按钮。
 *   · 征战：整页 = 原版「征战」容器 `3437`（5 帧），报名/等待/战绩全部在
 *     它自己的 `boss1..boss5`、`main_mc`、文本字段里表达，不新造页面。
 *   · 弹确认/提示：优先 `SfChallenge.openOriginalConfirm`（原版 4421），
 *     其次 `UI.classic.modal`，都拿不到才 toast。
 * ============================================================ */
(function () {
  'use strict';

  const O = window.Online;
  let pollTimer = null;
  let seq = 0;
  let loginSeq = 0, loginView = null, loginElement = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  function ui() { return window.UI || null; }
  function C() { return (window.UI && UI.classic) || null; }
  function classic() { return window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic'; }
  function uiRoot() { return document.getElementById('ui'); }

  function toast(msg) { O.toast(msg); }

  /** 新密码规范（与服务端 `auth.normalizePassword` 保持一致）：
   *  至少 6 位，且同时包含字母和数字。登录旧账号不受这条限制。 */
  function passwordProblem(pass) {
    const s = String(pass == null ? '' : pass);
    const length = [...s].length;
    if (length < 6) return '密码至少 6 位。';
    if (length > 128) return '密码太长。';
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return '密码必须同时包含字母和数字。';
    return '';
  }
  /** 昵称规范（与服务端 `auth.normalizeName` 共用 `js/nickname.js`）：
   *  最多 7 个汉字，英文/数字按 1/3 个汉字计。 */
  function nameProblem(name) {
    const rules = window.NicknameRules;
    if (!rules || typeof rules.check !== 'function') return '';
    const out = rules.check(name);
    return out.ok ? '' : out.reason || '昵称不可用';
  }

  /* ============================================================
   * 游戏公告 / 首次启动
   * ------------------------------------------------------------
   * 首次打开且本机没有已保存账号时：
   *   · 登录页默认进「注册」而不是「登录」；
   *   · 自动弹出游戏公告。
   * 公告本身来自 js/online-notice.js，之后可在「系统 → 帮助」最下面再看。
   * ========================================================== */
  const FIRST_RUN_KEY = 'ssdz-online-first-run-done';
  let firstRunRegister = false;
  let firstRunNoticeShown = false;
  /* 本次启动是不是「全新安装的第一次」：首登公告已经弹过，就不再叠更新公告。 */
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
    } catch (e) { /* 隐私模式/无 localStorage：退回普通登录页 */ }
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

  /** 「更新公告」的模型：一条版本一个分页，标题是「v版本号 · 日期」，正文 1~2 句。
   *  数据在 `js/online-notice.js` 的 `releases`（发版时在最上面补一条）。 */
  function releasesModel(currentVersion) {
    const n = window.OnlineNotice;
    let list = (n && Array.isArray(n.releases)) ? n.releases.slice() : [];
    if (!list.length) return null;
    /* 只展示「不高于本机版本」的条目：旧客户端不该提前看到还没装上的版本说明。 */
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
    /* 登录页在 #app 里 z-index:80；公告在 #ui 里，默认会被登录页盖住。 */
    root.style.zIndex = '95';
    const host = document.createElement('section');
    /* 不要带 `classic-home`：`#ui:has(.classic-page) .classic-home` 会把帮助页上
     * 叠的公告直接 visibility:hidden。公告是独立覆盖层，只用 ssfight-home 的舞台定位。 */
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
      /* 4406 = 原版「公告」：3142 遮罩 + 4403/4404 底板 + 3152 按钮 + 4405 文本。 */
      await SfRender.loadExtra('tags-notice.json');
      view = await SfRender.mountSymbol(host, '4406', { frame: 1, label: '游戏公告' });
      if (closed) return null;
      /* 用户口径：公告显示时不要遮住背景。素材 4406 自带的 3142 是 40% 黑遮罩，
       * 把它隐藏；公告 host 的底色也在 CSS 里置透明。 */
      try {
        const shade = view.nodes && view.nodes.get(1);
        if (shade && shade.node) shade.node.style.display = 'none';
      } catch (e) {}
      try {
        const info = view.byName('info');
        if (info) { const g = info.g || info; g.style.visibility = 'hidden'; }
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
      place = () => {
        if (!svg || !body) return;
        const hr = host.getBoundingClientRect(), sr = svg.getBoundingClientRect();
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const vw = (vb && vb.width) || 320, vh = (vb && vb.height) || 196;
        /* ⚠ 公告挂在 #ui 里，而 #ui 整体带 `transform: scale(--uiscale)` 适配窗口。
         * 直接拿**屏幕像素**写进这里的 CSS，会被 #ui 再放大一次 —— 正文按比例冲出
         * 公告底板（桌面窗口 uiscale >1 时最明显）。先把偏移折回 #ui 的设计像素，
         * 再按 svg 自己的布局尺寸（clientWidth/Height，不含祖先 transform）算
         * 「1 个舞台单位 = 多少设计像素」。 */
        const uiscale = (host.clientWidth > 0 && hr.width > 0) ? hr.width / host.clientWidth : 1;
        const sx = (svg.clientWidth || sr.width / uiscale) / vw;
        const sy = (svg.clientHeight || sr.height / uiscale) / vh;
        /* 4406 的底板内沿：x≈88..236；y 从标题「公告栏」下沿 62 到按钮 150。
         * ⚠ 左沿从 86 收到 89：底板内侧还有一圈深色斜边，正文再留 8px padding 后，
         * 首字正好落在斜边上（实测「松」「v」看起来像被裁掉）。 */
        body.style.left = ((sr.left - hr.left) / uiscale + 89 * sx) + 'px';
        body.style.top = ((sr.top - hr.top) / uiscale + 58 * sy) + 'px';
        /* 右边缘收窄一点，上下各放一点；正文再小一档。 */
        body.style.width = ((231 - 89) * sx) + 'px';
        body.style.height = ((140 - 58) * sy) + 'px';
        body.style.fontSize = Math.max(11, Math.round(5.4 * sy)) + 'px';
      };
      place();
      setTimeout(place, 60);
      window.addEventListener('resize', place);
      /* 登录页 → 经典主页、切全面屏、转屏时 #ui 的 uiscale 会变，但窗口尺寸没变 ——
       * 只监听 resize 会漏掉这一拍（正文按旧缩放落在底板外面）。跟住 svg 自己的尺寸。 */
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => place());
        ro.observe(svg);
        ro.observe(host);
      }
      /* 原版 3152 是底板底部那颗绿色「确定」按钮；直接复用它关闭。
       * 它是 shape（不是 sprite），不一定有 `sid` 属性；按 4406 的 depth 12 取节点。 */
      const rec = view.nodes && view.nodes.get(12);
      const btn = view.g.querySelector('[sid="3152"]') || (rec && rec.node);
      if (btn) {
        btn.style.cursor = 'pointer';
        btn.setAttribute('aria-label', '关闭公告');
        btn.onclick = close;
        /* 原版按钮在 4404 底板下方，直接点在绿色「确定」上会被底板接走；
         * 在按钮矩形上盖一块**透明**热区（不画任何新 UI），保证点击落到关闭。 */
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
      /* 素材包缺失时退回经典提示，至少不挡登录。 */
      const c = C();
      if (c && c.modal) {
        c.modal(data.title || '游戏公告', '<div class="game-notice-text">' +
          data.pages.map((p) => '<h3>' + esc(p.title) + '</h3>' + p.html).join('<hr>') + '</div>',
          [{ label: '知道了', primary: true }], { small: false });
      } else toast(data.title);
      return null;
    }
  }

  /** 「更新公告」：帮助页入口与「客户端更新后自动弹出」共用。
   *  数据在 `js/online-notice.js` 的 `releases`（发版时在最上面补一条，1~2 句）。 */
  async function openReleases(currentVersion) {
    const version = currentVersion || await localBuildVersion();
    const model = releasesModel(version);
    if (!model) { toast('还没有更新记录。'); return null; }
    return openNotice(model);
  }

  /* ============================================================
   * 客户端更新后：下一次打开游戏自动弹「更新公告」
   * ------------------------------------------------------------
   * 只看**客户端自己的版本号**（EXE/APK 里的 `__SSDZ_VERSION`，其次 `scripts/version.json`）：
   * 用「一键同步更改」或装了新包后版本变了，下一次启动就会命中一次。
   *  · 有历史记录：版本比上次新，且 releases 里确有更新的条目 → 弹；
   *  · 没有历史记录：老玩家（本机有账号）视为刚更新，弹一次；全新安装只看首登公告；
   *  · 热修包没写公告条目不弹，只把版本基线记下来。
   * ========================================================== */
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
    /* 新装机：首登公告已经弹过，只把当前版本记成基线。 */
    if (firstRunSession) { try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {} return; }
    if (seen && versionCompare(current, seen) <= 0) return;
    if (!seen) {
      /* 没有历史版本：老玩家（有账号）当作刚更新，弹一次；否则只记基线。 */
      let hasAccount = false;
      try { hasAccount = !!localStorage.getItem('ssdz-online-username') || !!(window.Net && Net.token && Net.token()); } catch (e) {}
      if (!hasAccount) { try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {} return; }
    }
    /* 只看本机能装到的版本（不提前播报更高版本）；没有更新的条目就静默记基线。 */
    const visible = list.filter((r) => versionCompare((r && r.version) || '', current) <= 0);
    const hasNew = visible.some((r) => versionCompare((r && r.version) || '', seen || '0') > 0);
    try { localStorage.setItem(RELEASE_SEEN_KEY, current); } catch (e) {}
    if (!hasNew) return;
    if (document.querySelector('.online-notice-original')) return;
    /* 等首页画出来；如果正好有经典弹窗（安全提醒、宝箱等）在，等它关掉再叠公告板。 */
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

  /** 原版确认框（4421）优先；没有就走经典弹窗。 */
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

  /* ============================================================
   * 登录页
   * ============================================================ */
  function loginHost() {
    const root = uiRoot();
    if (!root) return null;
    stopCampaignWatch();
    hideCampaignStatus();
    closeCampaignView();
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

  /** 6843 同时包含断线警告；仅复用其中的原版背景位图。 */
  async function mountLoginBackdrop(host, mine) {
    if (mine !== loginSeq || !host.isConnected) return null;
    const image = document.createElement('img');
    image.src = 'images/ssfight/ui/bitmap/6835_0.hd.jpg';
    image.alt = '';
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
      (mode === 'register' ? '<p class="online-login-hint" data-name-hint></p>' : '') +
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

    /* 注册页昵称失焦时查一次重名（服务端注册时仍会再查一遍，防并发）。 */
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

    /** 探一次服务器：成功就把地址写到页脚，失败就把试过的地址全列出来。 */
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
    /* 打开登录页就先探一次，玩家不用等点登录才知道服务器在不在。 */
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
      if (!window.confirm('永久注销账号？角色进度和好友关系将被删除，无法恢复。')) return;
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
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        await OnlineUI.enterGame();
        if (Number(out.kickedSessions) > 0) {
          toast('已登录；其他 ' + Number(out.kickedSessions) + ' 个设备的登录已失效');
        }
        if (out.recoveryCode) showRecoveryCode(out.recoveryCode);
      } catch (err) {
        /* 连不上时的最常见原因是「这一轮换了网络/防火墙刚放行」：先重探一次再报错，
         * 这样玩家不用关掉程序重开。 */
        if (!recovering && err && err.code === 'NETWORK') {
          setNote('连不上服务器，正在重试…', true);
          const ok = await checkServer();
          if (ok) {
            try {
              // A lost registration reply may already have created the account.
              // Try its credentials; never silently create a second account.
              await O.login(name, password);
              try { localStorage.setItem('ssdz-online-username', name); } catch (e) {}
              if (!card.isConnected) return;
              setNote('');
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
    /* 首次启动：没有已保存账号 → 默认注册页。
     * 玩家点「返回登录」/「恢复码」时传 explicit，之后不再强制注册。 */
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
      /* 等登录页先挂好，再叠公告；#ui 层级在 openNotice 里临时抬高。 */
      setTimeout(() => {
        if (!host.isConnected) return;
        try { openNotice().catch(() => {}); } catch (e) { /* 公告失败不能挡登录 */ }
      }, 120);
    }
  }

  /* ============================================================
   * 征战（原版 3437 整页）
   * ============================================================ */
  function showRecoveryCode(code) {
    const c = C(); if (!c) return;
    const m = c.modal('保存账号恢复码', '<p>忘记密码时，可用此码重置密码。请妥善保存，不要告诉其他人。</p>' +
      '<input class="online-recovery-code" readonly aria-label="账号恢复码" value="' + esc(code) + '">' +
      '<p class="small-label">恢复码不会保存到本机。使用后会生成新的恢复码。</p>', [
      { label: '已妥善保存', cls: 'gold' },
    ], { small: true, locked: true });
    const input = m.element.querySelector('input'); input.onclick = () => { input.select(); input.setSelectionRange(0, input.value.length); };
  }

  const WAR_TEXT = {
    wait: '正在等待队友，凑够人数后自动开始挑战。。。',
    ticket: '报名需扣除1个征战令',
  };

  function clipOf(view, name) {
    try {
      if (!view) return null;
      const item = (view.byName && view.byName(name)) || (view.byNameDeep && view.byNameDeep(name));
      return item ? (item.g ? item : { g: item }) : null;
    } catch (e) { return null; }
  }

  function setText(view, name, text) {
    const clip = clipOf(view, name);
    if (!clip) return false;
    try {
      if (window.SfRender && SfRender.setText && SfRender.setText(clip.g, text, { wrap: true })) return true;
      const tf = clip.g.querySelector('[data-text]') || clip.g;
      if (tf && tf.textContent != null) { tf.textContent = String(text); return true; }
    } catch (e) {}
    return false;
  }

  /** 直接写一个文本节点（`clip` 本身就是文本字段，不是“父元件 + 字段名”）。
   *  分奖页的底部 `text1..text5` 与中间 `prize.text1` 都是这种。 */
  function setNodeText(clip, text) {
    if (!clip) return false;
    const g = clip.g || clip;
    try {
      if (window.SfRender && SfRender.setText && SfRender.setText(g, text, { wrap: true })) return true;
      const t = (g && g.querySelector) ? g.querySelector('text') : null;
      if (t) { t.textContent = String(text); return true; }
      if (g && g.textContent != null) { g.textContent = String(text); return true; }
    } catch (e) {}
    return false;
  }

  function stopAt(clip, frame) {
    if (!clip) return;
    try { if (clip.gotoAndStop) clip.gotoAndStop(frame); } catch (e) {}
  }

  /** 征战页的静态策略：容器 `3437` 的根帧由界面自己 `gotoAndStop`，但 `main_mc`、
   *  翻页箭头 `3156`、按钮和首领光圈都是多帧元件，一出生就按 14fps 自播 ——
   *  整页看起来就是"所有 UI 都在频闪"。这里走 `ui-main` 的公共静态策略：
   *  子树里所有实例出生即冻结，**换帧重建出来的新实例也会继承**，不在页面里另写补丁。 */
  function freezeView(view) {
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (t && t.freezeDescendants) {
      try { t.freezeDescendants(view); return true; } catch (e) {}
    }
    return false;
  }

  /** 原版按钮接线：停在常态帧 + 铺透明热区 + 走公共点击路由。
   *  ⚠ 翻页箭头 `3156` 的第 2 帧是**空帧**（画稿只在第 1 帧），所以箭头不能像普通按钮
   *  那样悬停切帧；`opts.hover` 只在确实有高亮帧时才传。
   *  反馈统一走 `SfUiMain.toolkit.popWrap` + `SfUiFeedback`：和其他经典页面一样，
   *  悬停有暖金光/轻微放大，按下有回弹，不再只是一块没有反应的透明热区。
   *  没有 `SfUiMain.toolkit`（极端降级）时仍保留原生 click，不会比旧行为更坏。 */
  function wireButton(clip, onFire, opts) {
    if (!clip || !clip.g) return;
    const t = window.SfUiMain && SfUiMain.toolkit;
    const o = opts || {};
    const idle = o.idle != null ? Number(o.idle) : 1;
    const hover = o.hover != null ? Number(o.hover) : 0;
    const disabled = o.disabled === true;
    stopAt(clip, idle);
    clip.g.style.cursor = disabled ? 'default' : 'pointer';
    clip.__campaignFire = disabled ? null : onFire;

    /* 把画稿/热区放进 `g.uc-pop` 壳里：反馈只缩放壳，不覆盖原版放置矩阵。
     * 和村庄页的 `keepWrapped` 同一顺序：popWrap → addHitArea → 把热区也挪进壳。 */
    let shell = null;
    if (t && t.popWrap) {
      try { t.popWrap(clip, !!o.animate); } catch (e) {}
      try { shell = clip.g.querySelector(':scope > g.uc-pop'); } catch (e) { shell = null; }
    }
    if (t && t.addHitArea) { try { t.addHitArea(clip, !!o.animate); } catch (e) {} }
    if (shell && clip.__hitArea && clip.__hitArea.parentNode !== shell) {
      try { shell.appendChild(clip.__hitArea); } catch (e) {}
    }
    if (shell && window.SfUiFeedback) {
      try { shell.setAttribute('aria-disabled', disabled ? 'true' : 'false'); } catch (e) {}
      try { SfUiFeedback.bind(shell, { hover: false }); } catch (e) {}
      if (disabled) shell.style.pointerEvents = 'none';
    }
    if (!disabled && hover > 0 && shell && !shell.__campaignHover) {
      shell.__campaignHover = true;
      shell.addEventListener('pointerenter', () => { if (clip.g.isConnected) stopAt(clip, hover); });
      shell.addEventListener('pointerleave', () => stopAt(clip, idle));
    }
    /* 用 `onclick` 而不是 `addEventListener`：文件可能被重复接线，属性赋值天然去重；
     * 路由派发的合成 click 与降级时的原生 click 都会走到这里。 */
    clip.g.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (disabled) return;
      const fire = clip.__campaignFire;
      if (!fire) return;
      if (shell && window.SfUiFeedback && SfUiFeedback.tap) {
        SfUiFeedback.tap(shell, fire, { delay: 70, press: true });
        return;
      }
      fire();
    };
  }

  /* 当前挂着的征战视图。以前每次 `campaignPage()` 都只换 `#ui` 的 DOM，旧视图还留在
   * `SfRender` 的播放注册表里（离开/重进征战会越积越多）。这里显式收掉。 */
  let campaignRollSeq = 0;
  let campaignView = null;
  function closeCampaignView() {
    campaignRollSeq++;
    if (!campaignView) return;
    try { campaignView.destroy(); } catch (e) {}
    campaignView = null;
  }

  /* ============================================================
   * 征战分奖页（原版 3437 第 5 帧 / `campaignRollMc`）
   * ------------------------------------------------------------
   * 原版 `showCampaignWin()` 打赢后 `gotoAndStop(5)`：四名队员轮流摇点，
   * 每份奖品点数最高者得；底部 5 格是这一局的 `rollDatas`，中间是当前奖品。
   * 服务端已经把公开版 roll 数据落库（`room.roll`），这里只负责照原版播：
   *   · 名字写进 `roll1..4.name`，点数写进 `num1/num2`（3430 的第 1 帧 = 0）；
   *   · `c1..c5` 是底部奖品格，`text1..text5` 是 `xN`；
   *   · 中间 `prize.c1..c4` 只显示赢家那一格，`prize.text1` 是 `xN`。
   * 动画与素材全部来自 3437 自己的闭包，不新造页面；点到页面任意处可跳过。
   * ========================================================== */
  let campaignIconMap = null;

  async function campaignPropIcons() {
    if (campaignIconMap) return campaignIconMap;
    try {
      const r = await fetch(SfRender.BASE + 'prop-icons.json', { cache: 'force-cache' });
      campaignIconMap = (r && r.ok) ? ((await r.json()).byId || {}) : {};
    } catch (e) { campaignIconMap = {}; }
    return campaignIconMap;
  }

  function campaignPrizeCount(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    /* 幻兽栏满时服务端折回 400 孵化点；分奖页按实际发放物显示。 */
    if (award && award.kind === 'hatch') return Math.max(1, Number(award.count) || 1);
    /* 紫装格满时服务端会折算成 200 金松果；分奖页按实际发放物显示，避免“看到紫装、包里没有”。 */
    if (award && award.fallback && Number(award.gold) > 0) return Math.max(1, Number(award.gold));
    if (p.kind === 'gold') return Math.max(1, Number(p.gold) || Number(p.count) || 1);
    if (p.kind === 'gear') return 1;
    if (p.kind === 'pet') return 1;
    return Math.max(1, Number(p.count) || 1);
  }

  /** 分奖页那一格的角标：幻兽显示「LvN」（等级是这一档的重点），其余仍是 xN。 */
  function campaignPrizeText(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    const pet = (award && award.kind === 'pet' && award.pet) || p.pet || null;
    if (p.kind === 'pet' && pet && !(award && award.kind === 'hatch')) {
      return 'Lv' + Math.max(1, Number(pet.level) || 1);
    }
    return 'x' + campaignPrizeCount(entry);
  }

  /** 幻兽头像元件：直接用战斗 HUD 那 32 颗原版图标（`SfFight.PET_FRAMES.art`
   * 按幻兽 id 1..32 排列），不另画一套、也不依赖 4280 的大立绘。 */
  function campaignPetSymbol(petId) {
    const art = window.SfFight && SfFight.PET_FRAMES && SfFight.PET_FRAMES.art;
    if (!Array.isArray(art) || !art.length) return '';
    const id = Math.max(1, Math.min(art.length, Number(petId) || 1));
    return art[id - 1] || '';
  }

  function campaignArtFor(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    if (award && award.kind === 'hatch') return { prop: 45 };
    if (award && award.fallback && Number(award.gold) > 0) return { prop: 8 };
    if (p.kind === 'gold') return { prop: 8 };
    if (p.kind === 'prop') return { prop: Number(p.id) || 0 };
    if (p.kind === 'gear') return { gear: Number(award && award.id) || 201 };
    if (p.kind === 'pet') {
      const pet = (award && award.kind === 'pet' && award.pet) || p.pet || null;
      return (pet && campaignPetSymbol(pet.id)) ? { pet: Number(pet.id) } : { prop: 45 };
    }
    /* 孵化点在本版没有原版图标；原版金蛋道具 86 也没接入道具表。
     * 借用同属“幻兽”语义的天使果实种子（45）作为可识别占位，不新画。 */
    if (p.kind === 'hatch') return { prop: 45 };
    return { prop: 0 };
  }

  function campaignClearArt(slot) {
    if (!slot || !slot.g) return;
    try { if (slot.detachAll) slot.detachAll(); } catch (e) {}
    const list = slot.g.querySelectorAll ? slot.g.querySelectorAll('.campaign-art') : [];
    for (const el of list) if (el.parentNode) el.parentNode.removeChild(el);
  }

  /** 把奖品画进 3414 格子：原版是 `attachMovie(<道具名>, "mc", 100)`；
   *  这里用同名图标的无框 SVG（`propIconSrc`）贴进格子，避免为 5 个图标再拉 635 KB
   *  的 `tags-daoju.json`。装备格用背包同款 PNG；幻兽格直接挂 HUD 的原版头像元件。 */
  function campaignAttachArt(slot, art) {
    if (!slot || !slot.g || !art) return;
    campaignClearArt(slot);
    if (art.pet) {
      const symbol = campaignPetSymbol(art.pet);
      let clip = null;
      if (symbol && slot.attachChild) {
        try { clip = slot.attachChild(symbol, 1, 'campaign-art'); } catch (e) { clip = null; }
      }
      if (clip) { fitCampaignPetArt(clip); return; }
      /* 素材包没加载/元件缺失时退回同属“幻兽”语义的天使果实种子占位。 */
      art = { prop: 45 };
    }
    let href = '';
    if (art.gear) href = 'images/ui/icons/gear/gear-' + art.gear + '.png';
    else if (art.prop) {
      const c = C();
      href = (c && typeof c.propIconSrc === 'function')
        ? c.propIconSrc(art.prop)
        : ('images/ui/icons/prop/prop-' + art.prop + '.svg');
    }
    if (!href) return;
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.setAttribute('class', 'campaign-art');
    img.setAttribute('href', href);
    /* iOS 15 / 老 WebView 的 SVG `<image>` 仍只认 xlink:href；两个都写，现代引擎取前者。 */
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    img.setAttribute('x', '3');
    img.setAttribute('y', '3');
    img.setAttribute('width', '36');
    img.setAttribute('height', '36');
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    slot.g.appendChild(img);
  }

  /** 把幻兽头像缩放进 3414 格子（画稿内框约 42.25 单位，留 4 单位边）。
   *  头像元件本身按 HUD 格子大小画的，直接挂会偏大/偏原点；这里按实际包围盒居中。 */
  function fitCampaignPetArt(clip) {
    if (!clip || !clip.g) return;
    clip.playing = false;
    const box = 34;
    const center = 21.15;
    const fit = () => {
      if (!clip.g || clip.g.isConnected === false) return false;
      let b = null;
      try { b = clip.g.getBBox ? clip.g.getBBox() : null; } catch (e) { b = null; }
      if (!b || !b.width || !b.height) return false;
      const scale = Math.min(box / b.width, box / b.height);
      if (!Number.isFinite(scale) || scale <= 0) return false;
      const x = center - (b.x + b.width / 2) * scale;
      const y = center - (b.y + b.height / 2) * scale;
      if (clip.setExtraTransform) clip.setExtraTransform('translate(' + x + ',' + y + ') scale(' + scale + ')');
      return true;
    };
    if (fit() || typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => { fit(); });
  }

  /** 等一颗 MovieClip 播到末帧（或自己停下）。比按 14fps 估算固定 `sleep` 可靠：
   *  后台/低帧率时不会提前把动画腰斩，也不会在末帧多冻 1~2 秒。 */
  function waitClipEnd(clip, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const step = () => {
        if (!clip || !clip.g || !clip.g.isConnected) { resolve(); return; }
        const last = Math.max(0, (clip.frameCount ? clip.frameCount() : 1) - 1);
        if (Number(clip.frame) >= last || clip.playing === false) { resolve(); return; }
        if (Date.now() - started >= (timeoutMs || 2600)) { resolve(); return; }
        setTimeout(step, 40);
      };
      step();
    });
  }

  /** 播 3437 第 5 帧；返回 true = 已经完整播完（或跳过），false = 没有可播的数据。
   *  `viewOverride` 只给本地渲染探针用（传一颗已挂好的 3437），正式流程不传。 */
  async function showCampaignRoll(room, viewOverride) {
    const roll = room && room.roll;
    /* `index` 去重：服务端已去重，这里再兜一层，避免旧房间/异常数据让底部多画一格。 */
    const seenPrize = new Set();
    const prizes = (roll && Array.isArray(roll.prizes) ? roll.prizes : []).filter((p) => {
      const index = Number(p && p.index);
      if (seenPrize.has(index)) return false;
      seenPrize.add(index);
      return true;
    }).slice(0, 5);
    if (!prizes.length) return false;
    if (!viewOverride && (!campaignView || !campaignView.g || !campaignView.g.isConnected)) {
      try { await campaignPage(); } catch (e) {}
    }
    const view = viewOverride || campaignView;
    if (!view || !view.g || !view.g.isConnected) return false;

    const token = ++campaignRollSeq;
    let skipped = false;
    const wake = [];
    const sleep = (ms) => {
      if (skipped) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          const i = wake.indexOf(done);
          if (i >= 0) wake.splice(i, 1);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
        wake.push(done);
      });
    };
    const skip = () => {
      if (skipped) return;
      skipped = true;
      while (wake.length) wake.pop()();
    };
    view.g.addEventListener('click', skip, true);

    try {
      view.gotoAndStop(5);
      const seats = (Array.isArray(room.seats) ? room.seats.slice() : [])
        .sort((a, b) => Number(a.seat) - Number(b.seat));
      for (let i = 1; i <= 4; i++) {
        const panel = clipOf(view, 'roll' + i);
        if (!panel) continue;
        const seat = seats[i - 1] || {};
        const name = String(seat.name || (seat.kind === 'empty' ? '虚位以待' : '队友'));
        setText(panel, 'name', name);
        const n1 = panel.byName && panel.byName('num1'), n2 = panel.byName && panel.byName('num2');
        if (n1) n1.gotoAndStop(1);
        if (n2) n2.gotoAndStop(1);
      }
      /* 素材里的 `text1..5` / `prize.text1` 带作者占位串（实测是 x200）；
       * 在图标表异步回来之前先把它们清掉，避免开局闪一帧假数量。 */
      for (let i = 1; i <= 5; i++) {
        const slot = clipOf(view, 'c' + i);
        if (slot) { campaignClearArt(slot); slot.gotoAndStop(2); }
        setNodeText(clipOf(view, 'text' + i), '');
      }
      const emptyPrize = clipOf(view, 'prize');
      if (emptyPrize) {
        emptyPrize.gotoAndStop(1);
        for (let i = 1; i <= 4; i++) {
          const cell = emptyPrize.byName && emptyPrize.byName('c' + i);
          if (cell) { campaignClearArt(cell); cell.g.style.visibility = 'hidden'; }
        }
        setNodeText(emptyPrize.byName && emptyPrize.byName('text1'), '');
      }

      /* 「随机幻兽」格要挂 HUD 那套原版头像；素材包按需拉一次（战斗里通常已经缓存）。 */
      const needsPetArt = prizes.some((entry) => {
        const p = (entry && entry.prize) || {};
        return p.kind === 'pet' && !(entry.award && entry.award.kind === 'hatch');
      });
      const petArt = (needsPetArt && window.SfRender && SfRender.loadExtra)
        ? Promise.resolve(SfRender.loadExtra('tags-fight-pets.json')).catch(() => {})
        : Promise.resolve();
      const [props] = await Promise.all([campaignPropIcons().catch(() => ({})), petArt]);
      if (token !== campaignRollSeq) return false;

      const paintStrip = (start) => {
        for (let i = 0; i < 5; i++) {
          const slot = clipOf(view, 'c' + (i + 1));
          const count = clipOf(view, 'text' + (i + 1));
          const entry = prizes[start + i];
          if (!entry) {
            if (slot) { campaignClearArt(slot); slot.gotoAndStop(2); }
            if (count) setNodeText(count, '');
            continue;
          }
          if (slot) {
            slot.gotoAndStop(1);
            const art = campaignArtFor(entry);
            /* 有原版矢量就直接挂；拿不到矢量时退回 `<image>`（同一套无框 SVG）。 */
            campaignClearArt(slot);
            const hit = art.prop ? props[String(art.prop)] : null;
            const clip = (hit && hit.id && slot.attachChild) ? slot.attachChild(hit.id, 1, 'campaign-art') : null;
            if (!clip) campaignAttachArt(slot, art);
          }
          if (count) setNodeText(count, campaignPrizeText(entry));
        }
      };

      const paintPrize = (entry) => {
        const prize = clipOf(view, 'prize');
        if (!prize) return;
        prize.gotoAndStop(1);
        const winner = Math.max(0, Math.min(3, Number(entry.winnerSeat) || 0));
        /* 3417 的飞出动画每帧都会重放 c1..c4（不看当前的 visibility）。给这个实例挂
         * 帧后处理，保证整段动画里只留赢家那一格，不会飞出 4 个/2 个空框。 */
        prize.__frameFix = () => {
          for (let n = 1; n <= 4; n++) {
            const c = prize.byName && prize.byName('c' + n);
            if (c) c.g.style.visibility = (n - 1) === winner ? '' : 'hidden';
          }
        };
        for (let i = 1; i <= 4; i++) {
          const cell = prize.byName && prize.byName('c' + i);
          if (!cell) continue;
          const on = (i - 1) === winner;
          cell.g.style.visibility = on ? '' : 'hidden';
          if (!on) { campaignClearArt(cell); continue; }
          cell.gotoAndStop(1);
          const art = campaignArtFor(entry);
          campaignClearArt(cell);
          const hit = art.prop ? props[String(art.prop)] : null;
          const clip = (hit && hit.id && cell.attachChild) ? cell.attachChild(hit.id, 1, 'campaign-art') : null;
          if (!clip) campaignAttachArt(cell, art);
        }
        const text = prize.byName && prize.byName('text1');
        if (text) setNodeText(text, campaignPrizeText(entry));
        prize.g.style.visibility = '';
      };

      const animate = async (panel, point) => {
        const n1 = panel.byName && panel.byName('num1');
        const n2 = panel.byName && panel.byName('num2');
        const end = Date.now() + 430;
        while (!skipped && Date.now() < end) {
          if (n1) n1.gotoAndStop(1 + Math.floor(Math.random() * 10));
          if (n2) n2.gotoAndStop(1 + Math.floor(Math.random() * 10));
          await sleep(55);
        }
        const final = String(Math.max(0, Math.min(99, Number(point) || 0))).padStart(2, '0');
        if (n1) n1.gotoAndStop(Number(final[0]) + 1);
        if (n2) n2.gotoAndStop(Number(final[1]) + 1);
      };

      for (let i = 0; i < prizes.length; i++) {
        if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
        const entry = prizes[i];
        /* 中间 prize 已经在放当前这一份；底部从**下一份**开始列，
         * 避免同一份奖品同时出现在中间和底部第一格（用户 2026-11 报“多出来一份”）。 */
        paintStrip(i + 1);
        paintPrize(entry);
        const rolls = Array.isArray(entry.rolls) ? entry.rolls : [];
        for (let seat = 0; seat < 4; seat++) {
          if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
          const panel = clipOf(view, 'roll' + (seat + 1));
          if (panel) await animate(panel, rolls[seat] ? rolls[seat].point : 0);
          if (!skipped) await sleep(110);
        }
        if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
        await sleep(240);
        const prize = clipOf(view, 'prize');
        const isLast = i === prizes.length - 1;
        if (prize && !skipped) {
          prize.gotoAndPlay(2);
          /* 等真正到末帧再收尾；固定 sleep 会既可能腰斩动画、又可能在末帧多冻 1~2 秒。 */
          await waitClipEnd(prize, 2600);
        }
        if (prize) {
          if (isLast) {
            prize.g.style.visibility = 'hidden';
            /* 最后一份收尾：中间藏掉后把最后一份放回底部，别让整条奖励区空 2 秒。 */
            paintStrip(i);
          } else prize.gotoAndStop(1);
        }
      }
      /* 原版 `endCampaignRolls()` 先把中间奖品藏掉，再等 2 秒回主页面。 */
      const donePrize = clipOf(view, 'prize');
      if (donePrize) {
        donePrize.__frameFix = null;
        donePrize.g.style.visibility = 'hidden';
      }
      if (!skipped) await sleep(2000);
      return true;
    } finally {
      view.g.removeEventListener('click', skip, true);
    }
  }

  /* ============================================================
   * 征战后台 watcher / 状态条
   * ------------------------------------------------------------
   * 报名后玩家不需要停在征战页：每 5 秒查一次 `/api/campaign/current`。
   *   waiting → 更新页面上的剩余时间；到点由服务端判 failed（不扣票）
   *   done    → 自动进入战斗（正在别的战斗/弹窗时等它结束）
   *   failed  → 提示超时、ack 清掉
   * ========================================================== */
  let campaignDeferred = false;
  let campaignFinishing = false;

  function stopCampaignWatch() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    campaignDeferred = false;
  }

  function battleBusy() {
    try { if (window.SfFight && typeof SfFight.active === 'function' && SfFight.active()) return true; } catch (e) {}
    return !!document.querySelector('.classic-modal-overlay, .online-login-card');
  }

  function statusNode() { return document.querySelector('.online-campaign-status'); }

  function hideCampaignStatus() {
    const node = statusNode();
    if (node) { node.style.display = 'none'; node.innerHTML = ''; }
  }

  function paintCampaignStatus(room) {
    const node = statusNode();
    if (!node) return;
    if (!room || room.status !== 'waiting') { hideCampaignStatus(); return; }
    const ready = (room.members || []).filter((m) => !m.missed).length;
    const secs = Math.max(0, Math.ceil(Number(room.remainMs || 0) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    node.innerHTML = '<b>真人匹配中</b><span>' + ready + '/' + (room.partySize || 4) + '</span>' +
      '<span>剩余 ' + mm + ':' + ss + '</span>' +
      '<button type="button" class="online-campaign-cancel">取消匹配</button>';
    node.style.display = 'flex';
    const cancel = node.querySelector('.online-campaign-cancel');
    if (cancel) cancel.onclick = () => { void leaveCampaignQueue(); };
  }

  async function leaveCampaignQueue() {
    stopCampaignWatch();
    hideCampaignStatus();
    try { await O.post('/api/campaign/queue/leave', {}); toast('已取消征战匹配。'); }
    catch (e) { toast(O.errText(e)); }
    if (document.querySelector('section[aria-label="征战"]')) campaignPage();
  }

  /** 征战接力回放：按 seat 顺序把四个座位的战报依次播一遍（助战座位也有服务端补录的
   *  spectator 战报）。旧房间没有 seat.combatId 时才退回只播自己的那一场。 */
  async function playCampaignRelay(room, reward) {
    if (reward && reward.missed) return;
    const seats = Array.isArray(room && room.seats) ? room.seats.slice() : [];
    seats.sort((a, b) => Number(a.seat) - Number(b.seat));
    const plays = seats.filter((s) => s && s.combatId && !s.skipped);
    const ownId = String((reward && reward.combatId) || '');
    if (!plays.length) {
      if (ownId) { try { await O.battle.replay(ownId); } catch (e) { /* 录像失败就直接看结果 */ } }
      return;
    }
    if (ownId && !plays.some((s) => String(s.combatId) === ownId)) {
      plays.push({ seat: Number((room.me && room.me.seat) || 0), name: '你的战斗', combatId: ownId });
    }
    for (let i = 0; i < plays.length; i++) {
      try { await O.battle.replay(plays[i].combatId); } catch (e) { /* 单场录像坏了继续播下一场 */ }
      if (i < plays.length - 1) {
        toast('征战接力 ' + (i + 2) + '/' + plays.length + '：' + (plays[i + 1].name || '队友') + ' 上场');
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
    }
  }

  let finishingCampaign = false;
  async function finishCampaign(room) {
    if (!room || finishingCampaign) return;
    if (battleBusy()) {
      if (!campaignDeferred) { toast('征战已匹配，当前界面结束后自动进入战斗。'); campaignDeferred = true; }
      /* 随机匹配是请求内直接结算的，没有“等待 watcher”阶段；这里补一个轮询，
       * 否则关弹窗动画还没结束时 finish 会被 busy 挡掉、再也没人重试。 */
      if (!pollTimer) startCampaignWatch();
      return;
    }
    finishingCampaign = true;
    campaignDeferred = false;
    stopCampaignWatch();
    try {
      /* 门票/经验/战利品都是服务端结算的；回放前先把权威存档拉回来。 */
      try { await O.syncState(); } catch (e) { O.markResync(); }
      const reward = (room.me && room.me.reward) || {};
      const win = room.teamResult === 'win' || !!reward.win;
      /* 先按座位顺序播完整条接力（自己死了也继续看队友打），再进分奖页/结果。 */
      await playCampaignRelay(room, reward);
      const lines = [];
      lines.push(win ? '队伍胜利！' : '队伍失败');
      if (Number(room.bossMaxHp) > 0) lines.push('BOSS 剩余 ' + Math.max(0, Number(room.bossHp) || 0) + '/' + Number(room.bossMaxHp));
      if (reward.missed) {
        lines.push('本局未参战：' + String(reward.msg || '征战令不足'));
      } else {
        if (reward.exp) lines.push('经验 +' + reward.exp);
        if (reward.gold) lines.push('金松果 +' + reward.gold);
        const lootList = Array.isArray(reward.lootList) ? reward.lootList : (reward.loot ? [reward.loot] : []);
        for (const item of lootList) lines.push('获得 ' + item.name + ' ×' + item.count);
        if (!reward.gold && !lootList.length && win) lines.push('本场没有掉落');
        if (!reward.combatId) lines.push('BOSS 在队友回合被击败，你未出手');
        if (room.mode === 'random') lines.push('随机匹配 · 助战补位');
      }
      /* 胜利局先播原版分奖页（3437 第 5 帧）；没有 roll 数据（老房间 / 失败局 /
       * 未参战）才回落到文字结果。分奖页不是“领奖按钮”，奖励在服务端结算时已入账。 */
      let rolled = false;
      if (win && !reward.missed && room.roll && Array.isArray(room.roll.prizes) && room.roll.prizes.length) {
        try { rolled = await showCampaignRoll(room); } catch (e) { rolled = false; }
      }
      try { await O.post('/api/campaign/rooms/' + room.code + '/ack', {}); } catch (e) {}
      try { await campaignPage(); } catch (e) { /* 底页恢复失败也要把结果告诉玩家 */ }
      if (rolled) {
        const bits = [];
        if (reward.exp) bits.push('经验 +' + reward.exp);
        if (reward.gold) bits.push('金松果 +' + reward.gold);
        const lootList = Array.isArray(reward.lootList) ? reward.lootList : (reward.loot ? [reward.loot] : []);
        for (const item of lootList.slice(0, 3)) bits.push(item.name + '×' + item.count);
        if (lootList.length > 3) bits.push('等 ' + lootList.length + ' 件');
        toast(bits.length ? bits.join(' · ') : '征战奖励已入账。');
        return;
      }
      const c = C();
      if (c && c.modal) {
        const m = c.modal('征战结果', '<p>' + lines.join('　') + '</p>', [{ label: '确定', primary: true }], { small: true });
        /* 结果页只有一颗确定键：按用户 2026-11 截图口径放大并下移（见 online.css）。 */
        if (m && m.element && m.element.classList) m.element.classList.add('campaign-result-dialog');
      } else toast(lines.join(' '));
    } finally {
      finishingCampaign = false;
    }
  }

  async function checkCampaignWatch() {
    if (!O.ready) { stopCampaignWatch(); return; }
    let room;
    try { room = (await O.get('/api/campaign/current')).room; }
    catch (e) { return; }
    if (!room) { stopCampaignWatch(); hideCampaignStatus(); return; }
    paintCampaignStatus(room);
    if (room.status === 'waiting') {
      if (!pollTimer) {
        pollTimer = setInterval(() => { void checkCampaignWatch(); }, 5000);
      }
      return;
    }
    if (room.status === 'done') {
      if (battleBusy()) {
        if (!campaignDeferred) { toast('征战已匹配，当前界面结束后自动进入战斗。'); campaignDeferred = true; }
        return;
      }
      stopCampaignWatch();
      await finishCampaign(room);
      return;
    }
    if (room.status === 'failed') {
      stopCampaignWatch();
      hideCampaignStatus();
      toast(room.failedReason === 'timeout' ? '征战匹配超时，未扣除征战令。' : '征战队伍已解散，未扣除征战令。');
      try { await O.post('/api/campaign/rooms/' + room.code + '/ack', {}); } catch (e) {}
      if (document.querySelector('section[aria-label="征战"]')) campaignPage().catch(() => {});
      return;
    }
    stopCampaignWatch();
    hideCampaignStatus();
  }

  function startCampaignWatch() {
    stopCampaignWatch();
    void checkCampaignWatch();
    if (!pollTimer) pollTimer = setInterval(() => { void checkCampaignWatch(); }, 5000);
  }

  async function resumeCampaignWatch() {
    if (!O.ready) return;
    let room = null;
    try { room = (await O.get('/api/campaign/current')).room; } catch (e) { return; }
    if (!room) return;
    if (room.status === 'waiting' || room.status === 'done') startCampaignWatch();
  }

  async function campaignPage() {
    const root = uiRoot();
    if (!root) return false;
    const mine = ++seq;
    let data;
    try {
      data = await O.get('/api/campaign/bosses');
    } catch (e) {
      toast(O.errText(e));
      return false;
    }
    if (mine !== seq) return false;
    if (!window.SfRender || !SfRender.mountSymbol) { toast('经典素材未加载'); return false; }
    closeCampaignView();
    root.innerHTML = '<section class="classic-home ssfight-home" aria-label="征战"></section>';
    const host = root.querySelector('.ssfight-home');
    await SfRender.loadExtra('tags-campaign.json');
    if (mine !== seq) return false;
    const view = await SfRender.mountSymbol(host, '3437', { frame: 1, label: '征战' });
    if (mine !== seq) { try { view.destroy(); } catch (e) {} return false; }
    campaignView = view;

    let page = 1;
    /* `main_mc` / `left` / `right` 在根时间轴换帧时会被重建，**不能**在挂载时抓一次
     * 句柄就一直用（从战绩页回主页面时旧句柄已经脱离文档，翻页/报名会全部失效）。 */
    const mainClip = () => clipOf(view, 'main_mc');
    /* 原版 `showCampaign` 在没有新战绩时把 newMessage 停在 2（隐藏）。 */
    const hideNewMark = () => { const news = clipOf(view, 'newMessage'); if (news) stopAt(news, 2); };

    const showPage = (n) => {
      page = n === 2 ? 2 : 1;
      /* 从记录页（根帧 4）回来时先把根时间轴拨回主页面，再重新取 main_mc。 */
      stopAt(view, 1);
      stopAt(mainClip(), page === 1 ? 1 : 2);
      freezeView(view);
      hideNewMark();
      const left = clipOf(view, 'left'), right = clipOf(view, 'right');
      if (left) {
        left.g.style.visibility = page === 1 ? 'hidden' : 'visible';
        wireButton(left, () => showPage(1));
      }
      if (right) {
        right.g.style.visibility = page === 1 ? 'visible' : 'hidden';
        wireButton(right, () => showPage(2));
      }
      /* 记录页会切到根帧 4，再回来时这两个按钮是**新实例**，所以每次重画主页都重接一遍
       *（重复接线只会覆盖同一个 `onclick`，不会叠加触发）。 */
      const record = clipOf(view, 'button1');
      if (record) wireButton(record, () => paintRecords(1), { hover: 2 });
      const back = clipOf(view, 'button2');
      if (back) wireButton(back, () => {
        closeCampaignView();
        if (window.UI && UI.runAction) UI.runAction('village');
      }, { hover: 2 });
      paintBosses(data.bosses || []);
    };

    function paintBosses(bosses) {
      const main = mainClip();
      for (let i = 1; i <= 5; i++) {
        const boss = bosses[i - 1];
        const card = clipOf(main, 'boss' + i);
        if (!card) continue;
        /* 3165 的 1/2/3 帧 = 常态 / 高亮 / 锁定灰；原版键盘选中也是 `gotoAndStop(2)`。
         * 这里鼠标移入同样切 2 帧，锁定首领停在 3 帧（点击仍会提示“暂未开放”）。 */
        const locked = !!(boss && boss.locked);
        wireButton(card, () => { if (boss) openBoss(boss); }, { idle: locked ? 3 : 1, hover: locked ? 0 : 2 });
      }
      /* 原版第 1 帧容器里没有 text1 字段（只有帧 2/4/5 有）；每日次数已经写在报名
       * 确认框里，这里不再往不存在的字段写占位值。 */
    }

    function paintRecords(number) {
      const list = data.records || [], pages = Math.max(1, Math.ceil(list.length / 2));
      const current = Math.max(1, Math.min(pages, number));
      stopAt(view, 4); // 原版征战记录页；每页两条。
      freezeView(view);
      for (let i = 1; i <= 2; i++) {
        const r = list[(current - 1) * 2 + i - 1];
        let extra = '';
        if (r) {
          const bits = [];
          if (r.gold) bits.push('金松果+' + r.gold);
          const loots = Array.isArray(r.lootList) ? r.lootList : (r.loot ? [r.loot] : []);
          for (const item of loots) bits.push(item.name + '×' + item.count);
          if (bits.length) extra = '，获得' + bits.slice(0, 3).join('、') + (bits.length > 3 ? '…' : '');
        }
        const text = r ? '征战「' + r.bossName + '」' + (r.win ? '胜利' : '失败') + '，经验 +' + (r.exp || 0) + extra : '';
        setText(view, 'text' + i, text);
        setText(view, 'text' + i + i, r && r.at ? new Date(r.at).toLocaleDateString() : '');
        const win = clipOf(view, 'win' + i), action = clipOf(view, 'a' + i);
        if (win) stopAt(win, r ? 7 : win.frameCount());
        if (action && action.g) action.g.style.visibility = 'hidden'; // 奖励已自动入账。
      }
      if (!list.length) setText(view, 'text1', '还没有征战记录。');
      setText(view, 'page', current + '/' + pages);
      const left = clipOf(view, 'left'), right = clipOf(view, 'right');
      if (left) {
        left.g.style.visibility = current > 1 ? 'visible' : 'hidden';
        wireButton(left, () => paintRecords(current - 1));
      }
      if (right) {
        right.g.style.visibility = current < pages ? 'visible' : 'hidden';
        wireButton(right, () => paintRecords(current + 1));
      }
      /* 原版记录页的返回键是 `back`（3362，底部「返回菜单」），不是 `back1/back2`
       * （那两个是原版别的版本里的分类页签，当前素材里没有动作）。 */
      const back = clipOf(view, 'back');
      if (back) wireButton(back, () => showPage(page));
    }

    function openBoss(boss) {
      if (boss.locked) { toast(boss.name + ' 暂未开放。'); return; }
      if (!boss.unlocked) { toast(boss.name + ' 需要 ' + boss.unlockLevel + ' 级才能报名。'); return; }
      if (data.pending && data.pending.status === 'waiting') { toast('正在征战匹配中，可以先取消当前匹配。'); return; }
      if (data.daily && data.daily.left <= 0) {
        toast('今天已经参加 ' + data.daily.limit + ' 次征战，明天再来吧。');
        return;
      }
      if (!boss.enoughTicket) { toast(WAR_TEXT.ticket); return; }
      const c = C();
      const dailyLine = data.daily ? '今日剩余 ' + data.daily.left + '/' + data.daily.limit + ' 次。' : '';
      const text = boss.name + '（LV:' + boss.level + '）\n' + boss.unlockLevel + ' 级以上可报名，4 人组队。\n' +
        dailyLine + '\n' + WAR_TEXT.ticket + '（进入战斗后才扣）。\n是否报名？';
      if (!c || !c.modal) { confirmBox('征战报名', text, () => joinQueue(boss)); return; }
      const html = '<p>' + esc(boss.name) + '（LV:' + boss.level + '） · 4 人组队</p>' +
        '<p class="small-label"><b>随机匹配</b>：立刻抽 3 个等级相近的玩家快照 / 人机助战，马上开打。</p>' +
        '<p class="small-label"><b>等待真人</b>：后台最多等 5 分钟，凑齐 4 个真人自动开打；可以先离开此页。</p>' +
        '<p class="small-label">门票只在进入战斗后扣除；匹配超时不扣。</p>' +
        (dailyLine ? '<p class="small-label">' + esc(dailyLine) + '</p>' : '');
      const m = c.modal('征战报名', html, [
        { label: '随机匹配', primary: true, close: false, run: () => { m.close(); void joinRandom(boss); } },
        { label: '等待真人（5分钟）', close: false, run: () => { m.close(); void joinQueue(boss); } },
      ], { small: true });
      /* 两个按钮默认会被 `.modal-buttons{flex-wrap:wrap}` 折成两行，第二行掉到弹窗外；
       * 这个弹窗用专用样式压小正文、让按钮保持一行。 */
      try { m.element.classList.add('campaign-match-dialog'); } catch (e) {}
    }

    async function joinQueue(boss) {
      try {
        const out = await O.post('/api/campaign/queue', { bossId: boss.bossId });
        if (out.patch) O.applyPatch(out.patch);
        if (out.room && out.room.status === 'done') { await finishCampaign(out.room); return; }
        if (out.room && out.room.status === 'failed') { toast('匹配失败：' + (out.room.failedReason || '没有找到队友')); await campaignPage(); return; }
        toast(out.already ? '已经在征战匹配队列中。' : '已开始匹配，最多等待 5 分钟；可以先去做别的。');
        startCampaignWatch();
        await campaignPage();
      } catch (e) { toast(O.errText(e)); }
    }

    async function joinRandom(boss) {
      try {
        const out = await O.post('/api/campaign/random', { bossId: boss.bossId });
        if (out.patch) O.applyPatch(out.patch);
        try { await O.syncState(); } catch (e) { O.markResync(); }
        if (out.room && out.room.status === 'done') { await finishCampaign(out.room); return; }
        if (out.already) { toast('已经有进行中的征战。'); startCampaignWatch(); await campaignPage(); return; }
        toast('随机匹配失败，请稍后再试。');
      } catch (e) { toast(O.errText(e)); }
    }

    if (document.createElement && host.appendChild) {
      const status = document.createElement('div');
      status.className = 'online-campaign-status';
      status.style.display = 'none';
      host.appendChild(status);
    }
    showPage(1);
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    /* 登录/回页时可能正好有一局在等/已结束：等待就挂状态条 + watcher，
     * 已结束就直接进战斗；超时的提示一次并 ack。 */
    const pending = data.pending || null;
    if (pending && pending.status === 'waiting') {
      paintCampaignStatus(pending);
      startCampaignWatch();
    } else if (pending && pending.status === 'done' && !(pending.me && pending.me.acked)) {
      void finishCampaign(pending);
    } else if (pending && pending.status === 'failed' && !(pending.me && pending.me.acked)) {
      toast(pending.failedReason === 'timeout' ? '征战匹配超时，未扣除征战令。' : '征战队伍已解散，未扣除征战令。');
      try { await O.post('/api/campaign/rooms/' + pending.code + '/ack', {}); } catch (e) {}
    } else {
      hideCampaignStatus();
    }
    return true;
  }

  /* ============================================================
   * 天梯对手页（复用挑战页的竞技场帧，不另造页面）
   * ============================================================ */
  function identity(item) {
    const it = item || {}, bot = it.source === 'bot' || it.bot === true || it.isAI === true || it.dummy === true;
    const player = !bot && (it.source === 'player' || it.player === true || Number(it.accountId || it.remoteId) > 0);
    /* 徽标只用最短的串：AI 生成的就写「AI」，真人写「玩家」（用户 2026-10 口径：
     * 「AI 生成的时候，仅提示 AI 即可」）。以前写「AI对手 / AI陪练 / 往期玩家」，
     * 4 个字挤在名字右边，观感很差。完整说明仍然在 `detail` 里，展开/弹窗才看。 */
    return { bot, player, label: bot ? 'AI' : player ? '玩家' : '?',
      detail: bot ? (it.kind === 'friend' ? 'AI 好友：免费切磋，不结算奖励。'
        : it.practice ? 'AI 陪练：免费，不计排名、次数与奖励。'
          : '赛区人机：按天梯规则结算积分、次数与奖励；300 分以后匹配权重降到 1/3。') :
        player ? '玩家战斗快照，异步挑战，不代表此刻在线。' : '对手来源尚未确认。' };
  }
  async function roster(kind) {
    const data = kind === 'friends' ? await O.get('/api/friends') : await O.battle.opponents({ kind: kind || 'rank' });
    const entries = kind === 'friends' ? data.friends || [] : data.opponents || [];
    /* 服务端已经把战斗体塞在列表里了（原版 `randomfriends.do` 也是这么做的）：
     * 一页 3 个对手 = **1 次**请求。只有老服务端/超出预算的好友才回落到 `/api/fighter`。 */
    const opponents = await Promise.all(entries.map(async entry => {
      const isBot = entry && (entry.source === 'bot' || entry.bot === true);
      const row = Object.assign({}, entry, kind === 'friends' ? { source: isBot ? 'bot' : 'player', player: !isBot, kind: 'friend', friend: true } : {});
      const embedded = entry && entry.fighter;
      if (embedded && typeof embedded === 'object') {
        return Object.assign({}, embedded, row, { hp: embedded.maxHp || embedded.hp });
      }
      if (!row.snapshotId) return Object.assign(row, { previewUnavailable: true });
      try {
        const info = await O.get('/api/fighter?snapshotId=' + encodeURIComponent(row.snapshotId));
        return Object.assign({}, info.fighter, row, { hp: info.fighter.maxHp || info.fighter.hp });
      } catch (e) { return Object.assign(row, { previewUnavailable: true }); }
    }));
    return Object.assign({}, data, { opponents });
  }
  /** 我收到的待验证好友申请（原版 `messages.do?type=3`）。 */
  async function friendRequests() {
    return await O.get('/api/friends/requests');
  }
  /** 同意 / 拒绝一条好友申请（原版 `validateFriend.do?messageId=&accept=`）。 */
  async function respondFriendRequest(id, accept) {
    const out = await O.post('/api/friends/requests/' + encodeURIComponent(String(id)), { accept: !!accept });
    /* 处理掉一条验证消息后主界面 NEW 可能该熄了：立即问一次，不等 15 秒轮询。 */
    try { if (O.refreshBadge) void O.refreshBadge(); } catch (e) {}
    return out;
  }
  function addFriendPage(player, done) {
    if (player && !identity(player).player) { toast('AI对手不能添加为玩家好友。'); return; }
    const c = C(); if (!c || !c.modal) return;
    let busy = false;
    const requestKey = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const m = c.modal('添加好友', '<p>输入玩家昵称或玩家 ID，也可随机添加 AI 好友（最多 10 位）。</p><input class="online-player-input" data-player-name aria-label="玩家昵称或玩家 ID" value="' + esc(player && (player.display || player.name) || '') + '" placeholder="玩家昵称或玩家 ID">',
      [{ label: '添加好友', close: false, run: async () => {
        if (busy) return;
        const input = m.element.querySelector('[data-player-name]'), target = input.value.trim();
        if (!target) { toast('请输入玩家昵称或玩家 ID。'); return; }
        busy = true;
        try {
          const out = await O.post('/api/friends', player && player.accountId ? { accountId: player.accountId } : { target });
          /* 原版 `showAddOneFriend`：发出去只是**好友申请**，要等对方在「验证消息」里同意。 */
          const accepted = !!(out && (out.accepted || out.already));
          if (accepted) await O.syncState();
          toast(out && out.accepted ? '已成功添加好友。' : out && out.already ? '你们已经是好友。'
            : '已发送好友申请！在其验证通过后双方即自动成为好友。');
          if (m.element.isConnected) { m.close(); if (accepted && done) done(); }
        }
        catch (e) { toast(O.errText(e)); } finally { busy = false; }
      } }, { label: '随机添加 AI', close: false, run: async () => {
        if (busy) return; busy = true;
        try { const out = await O.post('/api/friends/ai', { requestKey }); if (m.element.isConnected) { toast('已添加 AI 好友【' + out.friend.fighter.name + '】。'); m.close(); if (done) done(); } }
        catch (e) { if (m.element.isConnected) toast(O.errText(e)); } finally { busy = false; }
      } }, { label: '返回', cls: 'muted' }], { small: true });
  }
  /** 天梯开打：服务端已按积分/冷却筛好候选（真人优先补满；300 分以后人机候选位的
   *  权重降到 1/3），这里像单机版一样**直接取一位**，不再弹「选择对手」页
   *  （ssfight 原版 `rank.do` 也是自动匹配，text7585：「根据积分自动匹配对手」）。 */
  async function autoMatch() {
    let data;
    try { data = await roster('rank'); } catch (e) { toast(O.errText(e)); return null; }
    const list = data.opponents || [];
    if (!list.length) { toast('现在没有可挑战的对手，过一会儿再来。'); return null; }
    return list[Math.floor(Math.random() * list.length)];
  }

  function accountDialog(remove) {
    const c = C(); if (!c) return;
    if (!remove) {
      const m = c.modal('退出登录', '<p>角色进度保存在服务器，重新登录后可以继续游戏。</p>', [
        { label: '退出登录', cls: 'gold', close: false, run: async () => {
          if (m.element.dataset.busy) return;
          m.element.dataset.busy = '1';
          m.element.querySelectorAll('button').forEach(b => { b.disabled = true; });
          try { await OnlineUI.logout(); } catch (e) { showLogin('login'); }
        } }, { label: '返回', cls: 'muted' },
      ], { small: true });
      return;
    }
    const account = Net.account() || {};
    c.modal('注销账号', '<p>将永久删除 <b>' + esc(account.name || State.state().name) + '</b> 的账号、角色进度及好友关系。</p>' +
      '<p>此操作无法撤销。若只是换账号，请使用「退出登录」。</p>', [
      { label: '继续注销', cls: 'gold', run: () => {
        const m = c.modal('确认永久注销', '<form class="online-account-form"><label>输入当前账号口令<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label>' +
          '<p class="online-account-error" role="alert"></p></form>', [
          { label: '永久注销', cls: 'gold', close: false, run: submit }, { label: '返回', cls: 'muted' },
        ], { small: true });
        async function submit() {
          if (m.element.dataset.busy) return;
          const input = m.element.querySelector('input'), note = m.element.querySelector('[role="alert"]');
          if (!input.value) { note.textContent = '请输入当前账号的口令。'; input.focus(); return; }
          m.element.dataset.busy = '1';
          m.element.querySelectorAll('button').forEach(b => { b.disabled = true; });
          note.textContent = '正在注销…';
          try {
            await O.deleteAccount(input.value);
            input.value = ''; m.close(); showLogin('login'); toast('账号已注销。');
          } catch (e) {
            if (m.element.isConnected) note.textContent = O.errText(e);
          } finally {
            delete m.element.dataset.busy;
            m.element.querySelectorAll('button').forEach(b => { b.disabled = false; });
          }
        }
        m.element.querySelector('form').onsubmit = e => { e.preventDefault(); void submit(); };
        m.element.querySelector('input').focus();
      } }, { label: '保留账号', cls: 'muted' },
    ], { small: true });
  }

  /** 原版论坛是外部网页；此处用经典弹窗承载本服的帖子和回复。
   *  2026-11 细化：接近整屏的弹窗、关键词/编号搜索、帖子与回复编号、
   *  管理员标识与管理页、违禁词、每日额度与容量水位。 */
  function forum() {
    const c = C();
    if (!c || !c.modal || !O.ready) return;
    const token = Net.token(), accountId = Number((Net.account() || {}).accountId);
    const modal = c.modal('松鼠论坛', '<div class="online-forum" aria-live="polite"></div>', [], { small: false });
    if (modal.element && modal.element.classList) modal.element.classList.add('forum-dialog');
    const panel = modal.element.querySelector('.online-forum');
    const active = () => modal.element.isConnected && O.ready && Net.token() === token;
    const key = () => window.crypto && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    const stamp = t => { const d = new Date(Number(t)); return Number.isFinite(d.getTime()) ? d.toLocaleString() : ''; };
    const badge = a => a && a.role ? '<span class="online-forum-badge" title="论坛管理员">管理员</span>' : '';
    const who = a => esc(a && a.name || '玩家') + badge(a);
    const sizeText = bytes => {
      const n = Math.max(0, Number(bytes) || 0);
      if (n < 1024) return n + ' B';
      if (n < 1048576) return Math.round(n / 1024) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    };
    let view = 'list', listPage = 1, threadId = 0, replyPage = 1, request = 0, busy = false, requestKey = key();
    let search = { q: '', no: '' };
    const account = Net.account() || {};
    let forumMe = { admin: !!account.forumAdmin, role: account.forumRole || '', postsToday: 0, repliesToday: 0, postLimit: 20, replyLimit: 100 };
    let capacity = null;

    function quotaText() {
      const f = (used, limit) => (Number(limit) > 0 ? used + '/' + limit : used + '/不限');
      return '今日发帖 ' + f(forumMe.postsToday || 0, forumMe.postLimit) + ' · 回复 ' + f(forumMe.repliesToday || 0, forumMe.replyLimit);
    }
    function capPercent(cap) { return Math.min(100, Math.max(0, Number(cap && cap.percent) || 0)); }
    function capLabel(cap) { return cap.level === 'full' ? '已满' : cap.level === 'warn' ? '偏高' : '充足'; }
    function capacityChip() {
      if (!capacity) return '';
      const pct = capPercent(capacity);
      return '<span class="online-forum-cap-mini ' + capacity.level + '" title="帖子 ' + capacity.posts + '/' + capacity.maxPosts +
        '，回复 ' + capacity.replies + '/' + capacity.maxReplies + '">容量 <b>' + pct.toFixed(1) + '%</b>' +
        '<span class="online-forum-cap-bar"><i class="' + capacity.level + '" style="width:' + pct + '%"></i></span></span>';
    }
    function capacityPanel(cap) {
      if (!cap) return '';
      const pct = capPercent(cap);
      return '<section class="online-forum-cap-panel ' + cap.level + '">' +
        '<div class="online-forum-cap-title"><b>论坛容量</b><span>' + capLabel(cap) + ' · ' + pct.toFixed(1) + '%</span></div>' +
        '<div class="online-forum-cap-bar big"><i class="' + cap.level + '" style="width:' + pct + '%"></i></div>' +
        '<p>帖子 <b>' + cap.posts + '</b> / ' + cap.maxPosts + '（' + Number(cap.postPercent).toFixed(1) + '%） · 回复 <b>' + cap.replies + '</b> / ' + cap.maxReplies + '（' + Number(cap.replyPercent).toFixed(1) + '%） · 单帖回复上限 ' + cap.maxRepliesPerPost + '</p>' +
        '<p>正文约 ' + sizeText(cap.contentBytes) + '，估算占用 ' + sizeText(cap.estimatedBytes) + '，数据库 ' + sizeText(cap.dbBytes) + '。告警线 ' + cap.warnPercent + '%；到 100% 会暂停新帖和新回复。</p>' +
        '<p class="online-forum-hint">' + (cap.retentionDays > 0 ? '自动保留期：' + cap.retentionDays + ' 天。' : '自动清理：关闭，可在下方手动清理旧帖。') + '</p></section>';
    }
    function searchHtml() {
      return '<form class="online-forum-search" data-forum-form="search">' +
        '<label class="online-forum-search-q"><span>关键词</span><input name="q" maxlength="50" value="' + esc(search.q) + '" placeholder="标题 / 正文 / 作者"></label>' +
        '<label class="online-forum-search-no"><span>帖子编号</span><input name="no" inputmode="numeric" maxlength="15" value="' + esc(search.no) + '" placeholder="如 12"></label>' +
        '<button type="submit" class="uc-button gold">查找</button>' +
        (search.q || search.no ? '<button type="button" class="uc-button" data-forum="clear-search">清除</button>' : '') +
        '</form>';
    }
    function toolsHtml(opts) {
      opts = opts || {};
      const full = capacity && capacity.level === 'full';
      let html = '<div class="online-forum-tools">';
      if (opts.newPost) html += '<button class="uc-button gold" data-forum="new"' + (full ? ' disabled title="论坛容量已满，请联系管理员清理"' : '') + '>发布帖子</button>';
      if (opts.admin) html += '<button class="uc-button" data-forum="admin">管理</button>';
      if (opts.back) html += '<button class="uc-button" data-forum="list">返回列表</button>';
      if (opts.cancel) html += '<button class="uc-button" data-forum="cancel">返回</button>';
      if (opts.reply) html += '<button class="uc-button gold" data-forum="compose-reply"' + (full ? ' disabled title="论坛容量已满"' : '') + '>回复</button>';
      if (opts.deletePost) html += '<button class="uc-button" data-forum="delete-post">删除帖子</button>';
      if (opts.refresh) html += '<button class="uc-button" data-forum="refresh">刷新</button>';
      html += '<button class="uc-button muted" data-forum="close">返回消息</button>';
      html += '<span class="online-forum-quota">' + quotaText() + '</span></div>';
      return html;
    }
    function pager(page, pages) {
      if (Number(pages) <= 1) return '<div class="online-forum-pager"><span>' + page + ' / ' + pages + '</span></div>';
      return '<div class="online-forum-pager"><button class="uc-button gold" data-forum="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button><span>' + page + ' / ' + pages + '</span><button class="uc-button gold" data-forum="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button></div>';
    }
    function loading(text) { panel.innerHTML = '<div class="online-forum-loading">' + esc(text) + '</div>'; }
    function noteOf(form) { return form && form.querySelector ? form.querySelector('[role="alert"]') : null; }
    function setNote(form, text) { const el = noteOf(form); if (el) el.textContent = text || ''; }
    function setFormBusy(form, on) {
      if (!form) return;
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = !!on;
    }
    function syncAccountRole() {
      if (window.Net && Net.setAccount) Net.setAccount(Object.assign({}, Net.account() || {}, { forumAdmin: !!forumMe.admin, forumRole: forumMe.role || '' }));
    }

    async function loadList(page) {
      view = 'list'; const n = ++request;
      loading('正在读取论坛…');
      let query = '/api/forum/posts?page=' + encodeURIComponent(page);
      if (search.q) query += '&q=' + encodeURIComponent(search.q);
      if (search.no) query += '&no=' + encodeURIComponent(search.no);
      try {
        const data = await O.get(query);
        if (!active() || n !== request) return;
        listPage = data.page; forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        if (data.search) search = { q: String(data.search.q || ''), no: data.search.no ? String(data.search.no) : '' };
        const title = data.search && (data.search.q || data.search.no)
          ? '搜索到 ' + data.total + ' 篇帖子' + (data.search.no ? '（编号 #' + data.search.no + '）' : '')
          : '共 ' + data.total + ' 篇帖子';
        const rows = data.posts.length ? '<div class="online-forum-list">' + data.posts.map(p =>
          '<button class="online-forum-row" data-forum="open" data-id="' + p.id + '">' +
          '<span class="online-forum-no" title="帖子编号 ' + p.id + '">#' + p.id + '</span>' +
          '<b title="' + esc(p.title) + '">' + esc(p.title) + '</b>' +
          '<span class="online-forum-row-meta">' + who(p.author) + ' · ' + esc(stamp(p.updatedAt)) + ' · ' + p.replies + ' 回复</span>' +
          '</button>').join('') + '</div>'
          : '<p class="online-forum-empty">' + (data.search && (data.search.q || data.search.no) ? '没有找到匹配的帖子。' : '还没有帖子，来发布第一篇吧。') + '</p>';
        panel.innerHTML = '<div class="online-forum-head"><div class="online-forum-search-row">' + searchHtml() + capacityChip() + '</div>' +
          toolsHtml({ newPost: true, admin: !!forumMe.admin }) + '</div>' +
          '<div class="online-forum-scroll"><div class="online-forum-summary">' + title + '</div>' + rows + '</div>' +
          pager(data.page, data.pages);
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ refresh: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    async function loadThread(id, page) {
      view = 'thread'; threadId = id; const n = ++request;
      loading('正在读取帖子…');
      try {
        const data = await O.get('/api/forum/posts/' + encodeURIComponent(id) + '?page=' + encodeURIComponent(page));
        if (!active() || n !== request) return;
        replyPage = data.page; forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        const p = data.post, own = p.author.accountId === accountId, admin = !!forumMe.admin;
        const canDeletePost = own || admin;
        const replies = data.replies.length ? data.replies.map(r => {
          const canDelete = r.author.accountId === accountId || admin;
          return '<article class="online-forum-reply"><div class="online-forum-reply-head">' +
            '<span class="online-forum-no" title="回复编号 ' + r.id + '">回复 #' + r.id + '</span>' +
            '<span class="online-forum-meta">' + who(r.author) + ' · ' + esc(stamp(r.createdAt)) + '</span>' +
            (canDelete ? '<button type="button" class="online-forum-delete" data-forum="delete-reply" data-id="' + r.id + '">删除</button>' : '') +
            '</div><div class="online-forum-content">' + esc(r.body) + '</div></article>';
        }).join('') : '<p class="online-forum-empty">暂无回复。</p>';
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true, reply: true, deletePost: canDeletePost, admin: admin }) + '</div>' +
          '<div class="online-forum-scroll">' +
          '<article class="online-forum-post"><div class="online-forum-post-head">' +
          '<span class="online-forum-no" title="帖子编号 ' + p.id + '">帖子 #' + p.id + '</span><h3>' + esc(p.title) + '</h3></div>' +
          '<div class="online-forum-meta">' + who(p.author) + ' · ' + esc(stamp(p.createdAt)) + '</div>' +
          '<div class="online-forum-content">' + esc(p.body) + '</div></article>' +
          '<div class="online-forum-replies">' + replies + '</div></div>' +
          pager(data.page, data.pages);
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    function editor(reply) {
      ++request; view = reply ? 'reply' : 'new'; requestKey = key();
      panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ cancel: true }) + '</div>' +
        '<div class="online-forum-scroll"><h3 class="online-forum-editor-title">' + (reply ? '回复帖子 #' + threadId : '发布新帖') + '</h3>' +
        '<form class="online-forum-form" data-forum-form="editor">' +
        (reply ? '' : '<label>标题<input name="title" maxlength="80" required placeholder="帖子标题"></label>') +
        '<label>' + (reply ? '回复内容' : '帖子正文') + '<textarea name="body" maxlength="' + (reply ? 1000 : 2000) + '" required placeholder="写下你的内容"></textarea></label>' +
        '<p class="online-forum-hint">发布前会自动检查违禁词；' + quotaText() + '。</p>' +
        '<p class="online-forum-error" role="alert"></p>' +
        '<div class="online-forum-form-actions"><button type="submit" class="uc-button gold">' + (reply ? '发送回复' : '发布') + '</button></div></form></div>';
      const input = panel.querySelector('textarea');
      if (input) input.focus();
    }

    function actionLabel(action) {
      return ({
        'forum.post.delete': '删除帖子', 'forum.reply.delete': '删除回复',
        'forum.word.add': '添加违禁词', 'forum.word.remove': '删除违禁词',
        'forum.admin.grant': '授予管理员', 'forum.admin.revoke': '撤销管理员',
        'forum.prune': '清理旧帖',
      })[action] || action;
    }
    function adminBody(data) {
      const words = data.words || [], admins = data.admins || [], latest = data.latestPosts || [], recent = data.recent || [];
      const wordHtml = words.length ? words.map(w =>
        '<span class="online-forum-word"><b>' + esc(w.word) + '</b><small>' + esc(w.category) + '</small>' +
        '<button type="button" class="online-forum-word-del" data-forum="word-del" data-word="' + esc(w.word) + '" title="删除这个违禁词">×</button></span>').join('')
        : '<span class="online-forum-hint">还没有违禁词。</span>';
      const adminHtml = admins.length ? admins.map(a =>
        '<div class="online-forum-admin-row"><span class="online-forum-admin-name">' + esc(a.name) +
        ' <small>玩家编号 ' + (a.playerId || '—') + '</small></span>' +
        (admins.length > 1 ? '<button type="button" class="online-forum-delete" data-forum="admin-del" data-id="' + a.accountId + '" data-name="' + esc(a.name) + '">撤销</button>' : '<span class="online-forum-hint">至少保留一位</span>') +
        '</div>').join('') : '';
      const postHtml = latest.length ? latest.map(p =>
        '<div class="online-forum-admin-row"><button type="button" class="online-forum-link" data-forum="open" data-id="' + p.id + '">#' + p.id + ' ' + esc(p.title) + '</button>' +
        '<span class="online-forum-meta">' + who(p.author) + ' · ' + p.replies + ' 回复</span>' +
        '<button type="button" class="online-forum-delete" data-forum="admin-post-del" data-id="' + p.id + '">删除</button></div>').join('')
        : '<p class="online-forum-hint">还没有帖子。</p>';
      const recentHtml = recent.length ? recent.map(x =>
        '<li><span class="online-forum-log-time">' + esc(stamp(x.createdAt)) + '</span>' +
        '<b>' + esc(x.actor && x.actor.name || '未知') + '</b> ' + esc(actionLabel(x.action)) +
        (x.detail ? '：' + esc(x.detail) : '') + '</li>').join('') : '<li class="online-forum-hint">暂无管理操作。</li>';
      return capacityPanel(data.capacity) +
        '<section class="online-forum-admin-section"><h3>违禁词 <small>' + words.length + ' 条</small></h3>' +
        '<p class="online-forum-hint">命中任意词会拒绝发帖/回复；匹配时忽略空格、标点、全半角和零宽字符。</p>' +
        '<div class="online-forum-words">' + wordHtml + '</div>' +
        '<form class="online-forum-admin-form" data-forum-form="word"><input name="word" maxlength="32" placeholder="新增违禁词">' +
        '<select name="category"><option>辱骂</option><option>广告</option><option>其他</option></select>' +
        '<button type="submit" class="uc-button gold">添加</button><p class="online-forum-error" role="alert"></p></form></section>' +
        '<section class="online-forum-admin-section"><h3>管理员 <small>' + admins.length + ' 位</small></h3>' +
        '<div class="online-forum-admins">' + adminHtml + '</div>' +
        '<form class="online-forum-admin-form" data-forum-form="admin"><input name="account" maxlength="32" placeholder="玩家编号或昵称">' +
        '<button type="submit" class="uc-button gold">授予管理员</button><p class="online-forum-error" role="alert"></p></form>' +
        '<p class="online-forum-hint">管理员可以删除任意帖子/回复、管理违禁词和清理旧帖；所有操作都会留痕。</p></section>' +
        '<section class="online-forum-admin-section"><h3>帖子管理 <small>最新 20 篇</small></h3>' +
        '<div class="online-forum-admin-posts">' + postHtml + '</div>' +
        '<p class="online-forum-hint">在论坛列表的搜索框里按关键词或帖子编号找到目标，再打开帖子删除。</p></section>' +
        '<section class="online-forum-admin-section"><h3>清理旧帖</h3>' +
        '<form class="online-forum-admin-form" data-forum-form="prune"><label>删除创建时间早于 <input name="days" type="number" min="7" max="3650" value="180"> 天的帖子</label>' +
        '<button type="submit" class="uc-button">清理旧帖</button><p class="online-forum-error" role="alert"></p></form>' +
        '<p class="online-forum-hint">回复会随帖子一起删除，操作不可撤销；日常自动清理默认关闭。</p></section>' +
        '<section class="online-forum-admin-section"><h3>最近管理操作</h3><ul class="online-forum-admin-log">' + recentHtml + '</ul></section>';
    }

    async function loadAdmin() {
      view = 'admin'; const n = ++request;
      loading('正在读取管理数据…');
      try {
        const data = await O.get('/api/forum/admin/overview');
        if (!active() || n !== request) return;
        forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        panel.innerHTML = '<div class="online-forum-head"><div class="online-forum-admin-head"><b>论坛管理</b>' + capacityChip() + '</div>' +
          toolsHtml({ back: true, refresh: true }) + '</div>' +
          '<div class="online-forum-scroll">' + adminBody(data) + '</div>';
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取管理数据失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    function confirmDelete(type, id, adminSurface) {
      const isPost = type === 'post', label = isPost ? '删除帖子 #' + id : '删除回复 #' + id;
      const extra = isPost ? '帖子下的全部回复也会一起删除。' : '';
      const audit = adminSurface ? '管理员删除会写入管理日志。' : '';
      c.modal(label, '<p>确定删除吗？' + extra + audit + '</p>', [
        { label: '取消', cls: 'muted' }, { label: '删除', cls: 'gold', run: async () => {
          try {
            await O.del('/api/forum/' + (isPost ? 'posts/' : 'replies/') + encodeURIComponent(id));
            if (!active()) return;
            toast(isPost ? '帖子已删除。' : '回复已删除。');
            if (adminSurface) await loadAdmin();
            else if (isPost) await loadList(listPage);
            else await loadThread(threadId, replyPage);
          } catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmWord(word) {
      c.modal('删除违禁词', '<p>删除「' + esc(word) + '」后，包含它的内容可以再次发布。</p>', [
        { label: '取消', cls: 'muted' }, { label: '删除', cls: 'gold', run: async () => {
          try { await O.post('/api/forum/admin/words/delete', { word }); if (active()) { toast('违禁词已删除。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmRevoke(admin) {
      c.modal('撤销管理员', '<p>撤销 <b>' + esc(admin.name) + '</b> 的论坛管理员权限？</p>', [
        { label: '取消', cls: 'muted' }, { label: '撤销', cls: 'gold', run: async () => {
          try { await O.post('/api/forum/admin/admins/delete', { accountId: Number(admin.accountId) }); if (active()) { toast('管理员已撤销。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmPrune(days) {
      c.modal('清理旧帖', '<p>将删除创建时间早于 <b>' + days + '</b> 天的帖子及其全部回复，无法恢复。</p>', [
        { label: '取消', cls: 'muted' }, { label: '确认清理', cls: 'gold', run: async () => {
          try { const out = await O.post('/api/forum/admin/prune', { days }); if (active()) { toast('已清理 ' + out.posts + ' 篇旧帖。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }

    panel.addEventListener('submit', async ev => {
      const form = ev.target.closest('form[data-forum-form]');
      if (!form || !panel.contains(form)) return;
      ev.preventDefault();
      const kind = form.dataset.forumForm;
      if (kind === 'search') {
        const q = String(form.elements.q.value || '').trim(), no = String(form.elements.no.value || '').trim();
        if (no && !/^\d+$/.test(no)) { setNote(form, '帖子编号只能是数字。'); return; }
        search = { q: q.slice(0, 50), no };
        await loadList(1);
        return;
      }
      if (busy) return;
      if (kind === 'editor') {
        const reply = view === 'reply';
        const title = reply ? '' : String(form.elements.title.value || '').trim();
        const body = String(form.elements.body.value || '').trim();
        if ((!reply && !title) || !body) { setNote(form, '请填写完整内容。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在发布…');
        try {
          const result = await O.post(reply ? '/api/forum/posts/' + encodeURIComponent(threadId) + '/replies' : '/api/forum/posts',
            reply ? { body, requestKey } : { title, body, requestKey });
          if (!active()) return;
          if (result.quota) Object.assign(forumMe, result.quota);
          if (result.capacity) capacity = result.capacity;
          toast(reply ? '回复已发布。' : '帖子已发布。');
          if (reply) await loadThread(threadId, 100000);
          else await loadThread(result.post.id, 1);
        } catch (e) {
          if (active() && form.isConnected) setNote(form, O.errText(e));
        } finally {
          busy = false;
          if (form.isConnected) setFormBusy(form, false);
        }
        return;
      }
      if (kind === 'word') {
        const word = String(form.elements.word.value || '').trim();
        if (!word) { setNote(form, '请填写违禁词。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在添加…');
        try {
          await O.post('/api/forum/admin/words', { word, category: String(form.elements.category.value || '其他') });
          if (active()) { toast('违禁词已添加。'); await loadAdmin(); }
        } catch (e) { if (active() && form.isConnected) setNote(form, O.errText(e)); }
        finally { busy = false; if (form.isConnected) setFormBusy(form, false); }
        return;
      }
      if (kind === 'admin') {
        const accountKey = String(form.elements.account.value || '').trim();
        if (!accountKey) { setNote(form, '请填写玩家编号或昵称。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在授予…');
        try {
          const out = await O.post('/api/forum/admin/admins', { account: accountKey });
          if (active()) { toast('已授予 ' + (out.account && out.account.name || accountKey) + ' 管理员。'); await loadAdmin(); }
        } catch (e) { if (active() && form.isConnected) setNote(form, O.errText(e)); }
        finally { busy = false; if (form.isConnected) setFormBusy(form, false); }
        return;
      }
      if (kind === 'prune') {
        const days = Number(form.elements.days.value);
        if (!Number.isFinite(days) || days < 7 || days > 3650) { setNote(form, '天数须为 7 至 3650。'); return; }
        confirmPrune(Math.floor(days));
      }
    });

    panel.addEventListener('click', ev => {
      const b = ev.target.closest('[data-forum]');
      if (!b || b.disabled || !panel.contains(b)) return;
      const action = b.dataset.forum;
      if (action === 'close') { modal.close(); return; }
      if (action === 'new') editor(false);
      else if (action === 'compose-reply') editor(true);
      else if (action === 'cancel') { if (view === 'reply') void loadThread(threadId, replyPage); else void loadList(listPage); }
      else if (action === 'list') void loadList(listPage);
      else if (action === 'open') void loadThread(Number(b.dataset.id), 1);
      else if (action === 'prev' || action === 'next') {
        const delta = action === 'prev' ? -1 : 1;
        if (view === 'list') void loadList(listPage + delta);
        else if (view === 'thread') void loadThread(threadId, replyPage + delta);
      } else if (action === 'clear-search') { search = { q: '', no: '' }; void loadList(1); }
      else if (action === 'refresh') { if (view === 'admin') void loadAdmin(); else void loadList(listPage); }
      else if (action === 'admin') void loadAdmin();
      else if (action === 'delete-post') confirmDelete('post', threadId, false);
      else if (action === 'delete-reply') confirmDelete('reply', Number(b.dataset.id), false);
      else if (action === 'admin-post-del') confirmDelete('post', Number(b.dataset.id), true);
      else if (action === 'admin-del') confirmRevoke({ accountId: Number(b.dataset.id), name: String(b.dataset.name || '该账号') });
      else if (action === 'word-del') confirmWord(String(b.dataset.word || ''));
    });

    void loadList(1);
    return modal;
  }

  /** 设置页「修改密码」：当前密码 + 新密码 + 确认。
   *  服务端换 salt/hash 并撤销其它设备会话，当前 Bearer 继续有效。 */
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

  /** 设置页「修改昵称」：新昵称全服唯一，成功后账号名、存档与当前防守快照一起更新。 */
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
        /* 账号缓存与存档镜像都换成新昵称：设置页标题、首页名字和之后拉取的资料保持一致。 */
        if (window.Net && Net.setAccount) Net.setAccount(Object.assign({}, Net.account() || {}, out.account || {}, { name: next, display: next }));
        try { if (window.State && State.state()) State.state().name = next; } catch (e) {}
        /* 登录页会记住上次成功登录的昵称：不同步的话退出后还会拿旧昵称去登，必然失败。 */
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

  /* ============================================================
   * 服务器主人：设置页「一键同步更改」
   * ------------------------------------------------------------
   * 可见性由服务端按 TCP 对端 IP 判定（/api/owner/sync/preview）；非主人只拿到
   * owner:false，页面连按钮都不挂。预览接口按版本清单给出**文件级差异**：
   * 本机 vX → 服务器 vY、新增/修改/删除了多少个文件、总大小、分类和明细。
   * Windows 轻壳调用 Rust 命令整包替换 exe；浏览器 / 安卓只打开下载页。
   * ========================================================== */
  function clientVersion() { return String(window.__SSDZ_VERSION || '').replace(/^v/i, ''); }
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
  /** 预览的一句话摘要：文件数 / 新增 / 修改 / 删除 / 总大小。 */
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
  function showSyncFiles(info) {
    const c = C();
    if (!c || typeof c.modal !== 'function') { toast(syncDiffText(info)); return; }
    const d = info && info.diff;
    const body = '<p>本机 <b>v' + esc(clientVersion() || '未知') + '</b> → 服务器 <b>v' + esc((info && info.version) || '?') + '</b></p>' +
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
  function openOwnerSync(info) {
    if (!info || !info.version) { toast('服务器还没有可同步的客户端包。'); return; }
    const mine = clientVersion();
    if (mine && versionCompare(info.version, mine) <= 0) { toast('已经是最新版本 v' + mine + '。'); return; }
    const android = /Android/i.test(String(navigator.userAgent || ''));
    const native = window.__TAURI_INTERNALS__;
    const canReplace = !!(!android && native && typeof native.invoke === 'function' && info.exe);
    let body = '<p>本机 <b>v' + esc(mine || '未知') + '</b> → 服务器 <b>v' + esc(info.version) + '</b></p>';
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
  /** 设置页挂载后异步问服务端「我是不是主人 + 这次会改哪些文件」；不是就保持面板隐藏。 */
  function loadOwnerPanel(p) {
    return O.get('/api/owner/sync/preview?from=' + encodeURIComponent(clientVersion() || '')).then((info) => {
      if (!p || !p.isConnected || !info || !info.owner) return;
      const panel = p.querySelector('[data-owner-panel]');
      if (!panel) return;
      panel.style.display = '';
      const mine = clientVersion();
      const note = panel.querySelector('[data-owner-note]');
      if (note) {
        if (!info.version) note.textContent = '服务器还没有可下载的客户端包。';
        else if (mine && versionCompare(info.version, mine) <= 0) {
          note.textContent = '已是最新版本 v' + mine + (info.notes ? '。' + info.notes : '');
        } else {
          note.textContent = '本机 v' + (mine || '未知') + ' → 服务器 v' + info.version + '；' +
            syncDiffText(info) + (info.notes ? '。更新说明：' + info.notes : '');
        }
      }
      const preview = panel.querySelector('[data-owner-preview]');
      if (preview) {
        const d = info.diff;
        preview.textContent = d && d.count ? ('查看将同步的内容（' + d.count + ' 个文件）') : '查看将同步的内容';
        preview.onclick = () => showSyncFiles(info);
      }
      const sync = panel.querySelector('[data-owner-sync]');
      if (sync) sync.onclick = () => openOwnerSync(info);
      const dl = panel.querySelector('[data-owner-download]');
      if (dl) dl.onclick = () => openExternalUrl(ownerDownloadUrl(info));
      if (window.SfUiFeedback) [preview, sync, dl].filter(Boolean).forEach((b) => SfUiFeedback.bind(b));
    }).catch(() => {});
  }

  /** Reuse the classic system page and controls, with account actions instead of local-save tools. */
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
      button('修改昵称', 'rename') + button('修改密码', 'password') + button('退出登录', 'logout') + button('注销账号', 'delete') + '</div><p class="online-server-address">服务器：' + esc(Net.base()) + '</p></section>' +
      /* 主人专属；服务端按 IP 确认前一直 display:none，普通玩家看不到。 */
      '<section class="online-account-panel online-owner-panel" data-owner-panel style="display:none">' +
      '<div class="online-account-heading"><h3 class="classic-section-title">开发者同步</h3><b>仅服务器主人可见</b></div>' +
      '<p class="small-label">把客户端同步到服务器当前版本；只替换客户端，不改账号存档。</p>' +
      '<div class="settings-grid online-settings-grid"><button type="button" class="uc-button" data-owner-preview>查看将同步的内容</button>' +
      '<button type="button" class="uc-button gold" data-owner-sync>一键同步更改</button>' +
      '<button type="button" class="uc-button" data-owner-download>下载页</button></div>' +
      '<p class="small-label" data-owner-note>正在读取服务器清单…</p></section>');
    const bind = (name, fn) => { p.querySelector('[data-online-setting="' + name + '"]').onclick = fn; };
    const quotaEl = p.querySelector('[data-device-quota]');
    if (quotaEl) {
      O.get('/api/device/quota').then((q) => {
        if (!p.isConnected || !q) return;
        if (q.creator) { quotaEl.textContent = '本设备为创作者设备 · 账号数不限'; return; }
        let text = '本设备已创建账号：' + Number(q.created || 0) + '/' + Number(q.limit || 3);
        if (Number(q.ipLimit) > 0) text += '（本网络 IP：' + Number(q.ipCreated || 0) + '/' + Number(q.ipLimit) + '）';
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

  /* ============================================================
   * 登录安全提醒：新设备/新地点登录只提醒，不拒绝登录。
   * 多条未读合并成一个弹窗；点「知道了」后把消息标为已读，避免每次登录重复弹。
   * ============================================================ */
  function showSecurityAlerts() {
    const alerts = (O.alerts || []).filter((a) => a && a.id).slice(0, 5);
    if (!alerts.length) return Promise.resolve();
    const ids = alerts.map((a) => String(a.id));
    const finish = async () => {
      O.clearAlerts(ids);
      try { await O.post('/api/messages/read', { ids }); } catch (e) { /* 下次登录还会提醒，不影响游戏 */ }
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

  const OnlineUI = {
    forum,
    settingsPage,
    /** 探针/设置页共用：传入 /api/owner/status 的响应。 */
    ownerSync: openOwnerSync,
    showLogin,
    enterGame: async function enterGame() {
      firstRunRegister = false;
      closeLogin();
      try { if (window.Main && Main.showHome) Main.showHome();
        else if (window.UI && UI.runAction) UI.runAction('home'); } catch (e) {}
      /* 安全提醒优先于宝箱提示：让玩家先看到“新设备登录”，再继续日常流程。 */
      try { await showSecurityAlerts(); } catch (e) { /* 提醒失败不能挡进游戏 */ }
      /* 客户端更新后的第一次启动：叠一张「更新公告」（是否弹由本地版本号决定）。 */
      try { await maybeShowReleaseNotice(); } catch (e) { /* 公告失败不能挡进游戏 */ }
      /* 活动页「徒弟日供」卡要读服务端数值；登录后先拉一次，失败不打断进游戏。 */
      try { if (window.ClassicExtras && ClassicExtras.prefetchApprentice) ClassicExtras.prefetchApprentice(); } catch (e) {}
      /* 上次报名/匹配完的征战可能在玩家离线时已经结算：稍后接回 watcher，
       * 不要和安全提醒弹窗抢输入。 */
      setTimeout(() => { void resumeCampaignWatch(); }, 1200);
      try {
        const pending = await O.get('/api/battle/chest');
        if (O.ready && pending.pendingCount && O.battle) {
          const session = Net.token();
          const offer = () => {
            if (!O.ready || Net.token() !== session) return;
            /* 更新公告是独立覆盖层，不是 classic-modal；它开着的时候先不弹宝箱。 */
            if (document.querySelector('.classic-modal-overlay') || document.querySelector('.online-notice-original')) { setTimeout(offer, 1000); return; }
            void O.battle.pendingChests();
          };
          setTimeout(offer, 500);
        }
      } catch (e) { /* Login remains available during an API upgrade. */ }
    },
    campaignPage,
    showCampaignRoll,
    openNotice,
    openReleases,
    resumeCampaign: resumeCampaignWatch,
    autoMatch,
    roster, identity, addFriendPage, friendRequests, respondFriendRequest,
    logout: async function logout() {
      try { await O.logout(); } catch (e) {}
      showLogin('login');
    },
  };

  window.OnlineUI = OnlineUI;
})();
