/* ============================================================
 * online.js — 联机版的「权威层」：镜像 / 动作流水线 / 战斗流程
 * ------------------------------------------------------------
 * 一条铁律：**进度只有服务端说得算。**
 * 客户端做两件互不越界的事：
 *   ① `sync` 动作允许本地先算一遍（省一次等待），算完立刻把同一动作发给服务端；
 *      服务端算完如果和本地不一样（说明有分叉），会回一个非空 patch → 这里安排整档重同步。
 *   ② `async` 动作（含随机数）**不许本地算**，必须等 `POST /api/action` 回来，
 *      拿到权威结果与 patch 再改镜像并把结果返回给页面。
 *
 * 页面只跟 `State` 打交道；本文件负责让 `State` 的产物和服务端保持一致。
 * ============================================================ */
(function () {
  'use strict';

  const Net = window.Net;
  const PREF_KEY = 'ssdz-online-settings';
  const PREF_FIELDS = ['volume', 'muted', 'resolution', 'fullscreen', 'hideStatusBar', 'showSkip', 'backgroundRun'];

  function localPreferences() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      const prefs = { uiMode: 'classic' };
      for (const key of PREF_FIELDS) if (raw && Object.prototype.hasOwnProperty.call(raw, key)) prefs[key] = raw[key];
      return prefs;
    } catch (e) { return { uiMode: 'classic' }; }
  }

  const bus = new Map();
  function on(evt, fn) {
    if (!bus.has(evt)) bus.set(evt, []);
    bus.get(evt).push(fn);
    return () => off(evt, fn);
  }
  function off(evt, fn) {
    const list = bus.get(evt) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  function emit(evt, payload) {
    for (const fn of (bus.get(evt) || []).slice()) {
      try { fn(payload); } catch (e) { if (window.__errs) window.__errs.push('online ' + evt + ': ' + (e && e.message)); }
    }
  }

  const S = {
    ready: false,
    booting: false,
    discovered: false,
    meta: null,
    rev: 0,
    summary: null,
    daily: null,
    season: '',
    serverTime: 0,
    drift: 0,
    alerts: [],
    actions: {},          // name → def
    resyncPending: false,
    guardInstalled: false,
    /* 主界面「消息」NEW 红点：服务端被动消息（好友验证 / 邮件 / 被挑战 / 师徒）
     * 的未读计数。由 `refreshBadge()` 轮询，打开消息页时清零。 */
    badge: { unread: 0, requests: 0, total: 0, at: 0 },
    /* 已本地执行、还没收到服务端确认的 sync 动作数。用来判断服务端 patch 能不能安全落盘：
     * 队列里还有后续预测时，patch 会把它们刚改的字段回滚。 */
    pendingPredict: 0,
  };

  function toast(msg) {
    try {
      if (typeof window.toast === 'function') { window.toast(msg); return; }
      if (window.UI && UI.toast) { UI.toast(msg); return; }
    } catch (e) {}
    console.warn('[online]', msg);
  }

  function errText(e) {
    if (!e) return '未知错误';
    const msg = String(e.message || '');
    /* `AUTH` 既可能是「会话过期」，也可能是「账号或密码不对」——后者要原样显示，
     * 否则登录页永远只会说一句「登录已失效」，玩家不知道该改什么。 */
    if (e.code === 'AUTH') return /失效|过期|重新登录/.test(msg) ? '登录已失效，请重新登录' : (msg || '账号或密码不对');
    if (e.code === 'NETWORK' || e.status === 0) return msg || '连不上服务器';
    return msg || String(e.code || e);
  }

  /* ============================================================
   * 镜像
   * ============================================================ */
  function localState() { return window.State ? State.state() : null; }

  /** 用服务端整档替换客户端镜像（读档/重连/分叉修复都走它）。 */
  function adoptSave(save) {
    if (!window.State || !save) return false;
    /* 联机镜像不能像单机读档那样把 `chestPending` 自动入账：
     * 服务端还留着 pending 等玩家「重开/领取」，客户端先结算会让界面以为箱子没了。
     * 真正的入账只由服务端 `confirmChest` 动作完成。 */
    const ok = State.restorePayload(save, { deferSettle: true });
    if (!ok) { console.error('[online] restorePayload 拒绝服务端存档'); return false; }
    // Volume, display and skip-button preferences belong to this device, not a server mirror.
    State.setSettings(localPreferences());
    emit('state', State.state());
    return true;
  }

  function applyPatch(patch) {
    if (!patch) return false;
    const s = localState();
    if (!s) return false;
    // Device preferences must not be overwritten by a server-side save patch.
    for (const [k, v] of Object.entries(patch.set || {})) if (k !== 'settings') s[k] = v;
    for (const k of patch.del || []) if (k !== 'settings') delete s[k];
    emit('state', s);
    return true;
  }

  /** Battle/campaign responses advance the same authoritative save as actions. */
  function acceptResponse(out, options) {
    if (!out) return out;
    const opts = options || {};
    if (opts.preserveMirror && typeof Net.account === 'function' && String((Net.account() || {}).accountId || '') !== opts.owner) {
      throw new Error('账号已切换，忽略上一账号的战斗响应');
    }
    if (Number.isSafeInteger(out.rev) && out.rev > 0) S.rev = out.rev;
    if (out.summary) S.summary = out.summary;
    if (out.daily) S.daily = out.daily;
    if (opts.preserveMirror) {
      if (out.patch) applyPatch(out.patch);
      else if (out.save && typeof out.save === 'object' && !Array.isArray(out.save)) {
        const current = localState();
        if (!current) throw new Error('当前账号存档尚未就绪');
        const settings = current.settings;
        for (const key of Object.keys(current)) if (key !== 'settings' && !Object.prototype.hasOwnProperty.call(out.save, key)) delete current[key];
        for (const [key, value] of Object.entries(out.save)) if (key !== 'settings' && key !== '__proto__') current[key] = value;
        current.settings = settings;
        emit('state', current);
      }
    } else if (out.save) adoptSave(out.save);
    return out;
  }

  async function syncState() {
    const out = await Net.get('/api/state');
    S.rev = Number(out.rev) || 0;
    S.summary = out.summary || null;
    S.daily = out.daily || null;
    S.season = out.season || '';
    S.serverTime = Number(out.serverTime) || Date.now();
    S.drift = S.serverTime - Date.now();
    S.alerts = Array.isArray(out.alerts) ? out.alerts : [];
    adoptSave(out.save);
    S.ready = true;
    emit('ready', out);
    return out;
  }

  function markResync() {
    if (S.resyncPending) return;
    S.resyncPending = true;
    Promise.resolve().then(async () => {
      S.resyncPending = false;
      try { await syncState(); } catch (e) { toast('同步失败：' + errText(e)); }
    });
  }

  /* ============================================================
   * 消息 NEW 红点（被动事件）
   * ------------------------------------------------------------
   * 用户 2026-11 口径：玩家**主动发起**的挑战不亮 NEW；只有被动到达的东西
   * （好友验证、邮件、被真人挑战、被收徒/逐出等）才亮。服务端 `messages`
   * 只写被动消息，所以红点直接读 `/api/messages/badge`，不再看本地战报。
   * 轮询而不是推送：同一账号的 Net 是全局串行队列，15 秒一次很轻；
   * 打开消息页时 `markMessagesSeen()` 立即清零，并让服务端把已到达的普通消息标已读。
   * ========================================================== */
  const BADGE_POLL_MS = 15000;
  let badgeTimer = null;
  let badgeInFlight = false;
  let badgeSeq = 0;

  function setBadge(out, at) {
    const unread = Math.max(0, Number(out && out.unread) || 0);
    const requests = Math.max(0, Number(out && out.requests) || 0);
    S.badge = {
      unread,
      requests,
      total: Math.max(0, Number(out && out.total) || (unread + requests)),
      at: Number(at) || Date.now(),
    };
    emit('badge', S.badge);
    return S.badge;
  }

  async function refreshBadge() {
    if (!S.ready) return S.badge;
    if (badgeInFlight) return S.badge;
    const seq = ++badgeSeq;
    badgeInFlight = true;
    try {
      const out = await Net.get('/api/messages/badge');
      /* `markMessagesSeen()` 在请求期间清过场 → 这份响应已经过期，不能把它又点亮。 */
      if (seq === badgeSeq) setBadge(out, Date.now());
    } catch (e) {
      /* 红点失败不能打断游戏；下一次轮询再试。 */
    } finally {
      badgeInFlight = false;
    }
    return S.badge;
  }

  /** 打开消息页：本地先熄红点，再让服务端记录「看到哪了」。
   *  服务端同时把普通消息标已读（留言除外，它有独立的 leaveNew 红点）。 */
  async function markMessagesSeen() {
    if (!S.ready) return null;
    badgeSeq++;
    setBadge({ unread: 0, requests: 0, total: 0 }, Date.now());
    try {
      const out = await Net.post('/api/messages/seen', {});
      return setBadge(out, Date.now());
    } catch (e) {
      /* 失败就重新问一次服务端，别让红点停在错误的清零状态。 */
      void refreshBadge();
      return null;
    }
  }

  function startBadgeWatch() {
    if (badgeTimer) return badgeTimer;
    /* Node/vm 自检环境没有 setInterval：红点轮询是纯界面增强，不能因此让登录失败。 */
    if (typeof setInterval !== 'function') return null;
    void refreshBadge();
    badgeTimer = setInterval(() => { void refreshBadge(); }, BADGE_POLL_MS);
    return badgeTimer;
  }

  function stopBadgeWatch() {
    if (!badgeTimer) return;
    if (typeof clearInterval === 'function') clearInterval(badgeTimer);
    badgeTimer = null;
  }

  /* ============================================================
   * 动作
   * ============================================================ */
  /** 队列里的每个动作：服务端按到达顺序执行，所以这里也只需 FIFO。 */
  let chain = Promise.resolve();

  function enqueue(task) {
    const next = chain.then(task, task);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * 权威动作（async）：等服务端算完，拿结果 + patch。
   * @returns {Promise<any>} 服务端里那次 `State.<name>()` 的返回值
   */
  function call(name, ...args) {
    const key = String(name);
    if (!S.ready) return Promise.reject(new Error('还没有连上服务器'));
    return enqueue(async () => {
      let out;
      try {
        out = await Net.post('/api/action', { name: key, args, rev: S.rev });
      } catch (e) {
        if (e && e.code === 'NETWORK' && S.ready) markResync();
        if (e && e.code === 'CONFLICT' && e.body && e.body.error && e.body.error.extra && e.body.error.extra.rev != null) {
          markResync();
        }
        throw e;
      }
      S.rev = Number(out.rev) || S.rev;
      S.summary = out.summary || S.summary;
      S.daily = out.daily || S.daily;
      if (out.patch) applyPatch(out.patch);
      emit('action', { name: key, result: out.result });
      return out.result;
    });
  }

  function sameResult(a, b) {
    if (a == null && b == null) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }

  /**
   * 预测动作（sync）：本地先算（页面照旧同步拿返回值），再发给服务端确认。
   *
   * 服务端回 patch 是**正常现象**：patch 是「服务端动作前后」的 diff，不是「和客户端不一致」。
   * 以前这里只要看到 patch 就整档重同步，于是每次穿装备/买道具/领任务都要多一次
   * `GET /api/state`（几十 KB）。现在：
   *  · 先比服务端返回值与本地预测值，不一致才认为分叉 → 整档重同步；
   *  · 一致时，本地预测已经把镜像改对了；只有在队列里没有后续预测（`pendingPredict <= 1`）
   *    时才把 patch 落下来补 housekeeping 字段，避免回滚玩家刚做的下一步操作。
   */
  function predict(name, args, localResult) {
    if (!S.ready) return localResult;
    S.pendingPredict += 1;
    enqueue(async () => {
      try {
        const out = await Net.post('/api/action', { name, args, rev: S.rev });
        S.rev = Number(out.rev) || S.rev;
        S.summary = out.summary || S.summary;
        S.daily = out.daily || S.daily;
        /* 这两个动作在战斗播放期间也会发生，而且本地状态可能已经领先于服务端
         * （教程步骤/已读时间戳）；不走「返回值不一致就整档重同步」的判定。 */
        if (name === 'setTutorialStep') {
          // Tutorial transitions can occur during a running battle. Keep
          // the same save object so its playback owner remains valid.
          if (!out.patch) return;
          const set = Object.assign({}, out.patch.set || {});
          // A later local step may already be queued; do not roll it back.
          delete set.tutorial;
          applyPatch({ set, del: (out.patch.del || []).filter(key => key !== 'tutorial') });
          return;
        }
        if (name === 'markMessagesSeen') {
          /* 消息红点记账：本地已把 `msgSeenAt` 推到最新，服务端 patch 就是同一个值。
           * 不安排整档重同步 —— 玩家正停在消息页/回放上时，重同步会白闪一次。 */
          if (out.patch) applyPatch(out.patch);
          return;
        }
        if (!sameResult(out.result, localResult)) {
          if (window.__errs) window.__errs.push('online: sync 分叉 ' + name);
          markResync();
          return;
        }
        if (!out.patch) return;
        /* 本地预测已经把镜像改对了；只有在队列里没有后续预测（`pendingPredict <= 1`）
         * 时才把 patch 落下来补 housekeeping 字段，避免回滚玩家刚做的下一步操作。 */
        if (S.pendingPredict <= 1) applyPatch(out.patch);
      } catch (e) {
        if (S.ready) markResync();
        if (!e || e.code !== 'CONFLICT') toast('同步失败：' + errText(e));
      } finally {
        S.pendingPredict = Math.max(0, S.pendingPredict - 1);
      }
    });
    return localResult;
  }

  /* ============================================================
   * 把 State 的口子收好
   * ============================================================ */
  function installGuards() {
    if (S.guardInstalled || !window.State) return;
    if (!S.meta) {
      /* 守卫依赖 `/api/meta` 的白名单；没有就**先不装**（否则会把整套 State 误锁或误放）。
       * 正常流程是 `bootMeta()` → `installGuards()`，见 afterAuth/resume。 */
      if (window.__errs) window.__errs.push('online: installGuards 在 meta 之前被调用，已跳过');
      return;
    }
    S.guardInstalled = true;
    const api = window.State;
    const setLocalSettings = api.setSettings;
    api.setSettings = function setOnlinePreferences(patch) {
      const settings = setLocalSettings.call(api, Object.assign({}, patch, { uiMode: 'classic' }));
      const prefs = {};
      for (const key of PREF_FIELDS) prefs[key] = settings[key];
      try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
      return settings;
    };

    /* 1) 白名单里的 sync 动作：本地算 + 上行确认。 */
    for (const [name, def] of Object.entries(S.actions)) {
      if (def.mode !== 'sync') continue;
      const orig = api[name];
      if (typeof orig !== 'function') continue;
      api[name] = function patchedSyncAction(...args) {
        const result = orig.apply(api, args);
        predict(name, args, result);
        return result;
      };
    }

    /* 2) async / local 动作：不许本地直调（async 必须 await Online.call）。
     *    `local` 那几支本来就不该上行，保持原样。 */
    for (const [name, def] of Object.entries(S.actions)) {
      if (def.mode !== 'async') continue;
      api[name] = function blockedAsyncAction() {
        const msg = 'online: State.' + name + ' 必须走 Online.call（含随机数，不能本地算）';
        if (window.__errs) window.__errs.push(msg);
        throw new Error(msg);
      };
    }

    /* 3) 服务端专有：**发奖 / 存档 IO** 一律不准客户端碰。
     * ⚠ 这里只放「产生资源 / 写存档」的函数；`clampPermanentStats`、`normalizeSettings`、
     *   `applySetBonuses`、`foeLoadout` 这类**纯函数**读路径天天在用，锁了会让面板直接崩。 */
    const noop = new Set(['save', 'markLocalFresh']);
    const list = (S.meta && S.meta.serverOnly) || [];
    for (const name of list) {
      if (!(name in api)) continue;
      if (noop.has(name)) { api[name] = function noopSave() {}; continue; }
      api[name] = function blockedServerOnly() {
        const msg = 'online: State.' + name + ' 是服务端专有';
        if (window.__errs) window.__errs.push(msg);
        throw new Error(msg);
      };
    }

    /* 4) 读档/建档/切界面/导入导出：联机版一律禁用（存档只有服务端一份）。
     *    `restorePayload` 例外 —— 镜像换档要用它（`adoptSave` 就是调它）。 */
    const disabled = ['newGame', 'switchMode', 'load', 'importFileRaw', 'readFileRaw', 'prepareImport',
      'verifyImport', 'exportPayload', 'fileProbe', 'fileLoad', 'fileWrite', 'fileWriteNow'];
    for (const name of disabled) {
      if (typeof api[name] !== 'function') continue;
      api[name] = function disabledInOnline() { return name === 'exportPayload' ? '' : false; };
    }
    /* `save()` 变成纯内存写入（服务端才落库）。 */
    api.save = function saveNoop() {};

    /* 5) 每日时间源：一律用服务端时间，客户端时钟只做显示。 */
    window.__ssdzServerNow = () => Date.now() + S.drift;
  }

  /* ============================================================
   * 未接入的 async 动作：把「按钮点了没反应」变成一句看得懂的话
   * ------------------------------------------------------------
   * `installGuards` 把 async 动作换成抛错，是为了**逼页面走 Online.call**。
   * 还没接完的地方会抛 `online: State.xxx 必须走 Online.call`；这里统一弹一条提示，
   * 至少玩家知道是"这个功能还没接服务器"，而不是"界面坏了"。
   * ============================================================ */
  function installErrorToast() {
    if (typeof window.addEventListener !== 'function') return;
    window.addEventListener('error', (e) => {
      const msg = String((e && e.message) || '');
      if (!/^online: /.test(msg)) return;
      const name = (msg.match(/State\.([A-Za-z_$][\w$]*)/) || [])[1] || '';
      toast('「' + (name || '这个功能') + '」还没接入服务器，这一版暂不可用。');
    });
  }

  /* ============================================================
   * 账号
   * ============================================================ */
  async function bootMeta() {
    /* ⚠ 一定要先探测，不能看 `Net.baseUrl()` 有没有值就跳过：
     * `net.js` 在加载时就会把安装包里的 `__SSDZ_ONLINE_API__`（通常是 https）填进 base，
     * 而云防火墙可能只放行 80 —— 那一跳会让 https 直接超时。
     * `discover()` 自己有快速通道（上次成功的地址先试一次），正常启动 ~100 ms。 */
    if (!S.discovered) {
      await Net.discover();
      S.discovered = true;
    }
    S.meta = await Net.meta();
    S.actions = S.meta.actions || {};
    S.season = S.meta.season || '';
    S.serverTime = Number(S.meta.serverTime) || Date.now();
    S.drift = S.serverTime - Date.now();
    emit('meta', S.meta);
    return S.meta;
  }

  async function login(name, password) {
    const out = await Net.post('/api/login', { name, password }, { auth: false });
    Net.setToken(out.token);
    Net.setAccount(out.profile ? out.profile.account : null);
    await afterAuth(out);
    return out;
  }

  async function register(name, password) {
    const out = await Net.post('/api/register', { name, password }, { auth: false });
    Net.setToken(out.token);
    Net.setAccount(out.profile ? out.profile.account : null);
    await afterAuth(out);
    return out;
  }

  async function recover(recoveryCode, password) {
    const out = await Net.post('/api/recover', { recoveryCode, password }, { auth: false });
    Net.setToken(out.token);
    Net.setAccount(out.profile ? out.profile.account : null);
    await afterAuth(out);
    return out;
  }

  async function afterAuth(out) {
    if (!S.meta) await bootMeta();
    installGuards();
    installErrorToast();
    const st = await syncState();
    /* 消息红点：登录后立即拉一次，之后 15 秒轮询（被动消息到达时不用等下次操作）。 */
    startBadgeWatch();
    /* 每日礼包/村庄这些「登录就该结一次」的东西，服务端已经在 housekeeping 里推进，
     * 这里只把状态同步回界面。 */
    emit('login', { profile: out.profile, state: st });
    return st;
  }

  async function resume() {
    if (!Net.restoreToken()) return null;
    if (!S.meta) await bootMeta();
    installGuards();
    try {
      const prof = await Net.get('/api/profile');
      Net.setAccount(prof.profile.account);
      await syncState();
      startBadgeWatch();
      emit('login', { profile: prof.profile });
      return prof.profile;
    } catch (e) {
      if (e && e.code === 'AUTH') Net.clearSession();
      throw e;
    }
  }

  function clearSession() {
    if (window.SfFight && SfFight.cancelOnlineChest) SfFight.cancelOnlineChest();
    stopBadgeWatch();
    Net.clearSession(); S.ready = false; S.rev = 0; S.summary = null; S.daily = null; S.alerts = [];
    S.pendingPredict = 0;
    badgeSeq++;
    badgeInFlight = false;
    S.badge = { unread: 0, requests: 0, total: 0, at: 0 };
    emit('logout', null);
  }

  function logout() {
    return enqueue(async () => {
      try { await Net.post('/api/logout', {}); } finally { clearSession(); }
    });
  }

  function deleteAccount(password) {
    return enqueue(async () => {
      const out = await Net.post('/api/account/delete', { password });
      clearSession();
      return out;
    });
  }

  /* ============================================================
   * 对外
   * ============================================================ */
  const Online = {
    get ready() { return S.ready; },
    get rev() { return S.rev; },
    get meta() { return S.meta; },
    get daily() { return S.daily; },
    get season() { return S.season; },
    get summary() { return S.summary; },
    get badge() { return S.badge; },
    get actions() { return S.actions; },
    get alerts() { return (S.alerts || []).slice(); },
    clearAlerts(ids) {
      const drop = new Set((Array.isArray(ids) ? ids : []).map(String));
      S.alerts = (S.alerts || []).filter((a) => !drop.has(String(a && a.id)));
    },
    get driftMs() { return S.drift; },
    serverNow: () => Date.now() + S.drift,
    on, off, emit,
    bootMeta, login, register, recover, resume, logout, deleteAccount, syncState, applyPatch, adoptSave,
    call, predict, markResync, installGuards, installErrorToast,
    /* 消息红点（被动消息）：主界面 `SfUiMain.hasNewMessages()` 读 `Online.badge`；
     * 打开消息页调 `markMessagesSeen()`。 */
    refreshBadge, markMessagesSeen,
    /** 读接口的薄封装（不带动作语义）。 */
    get: (path, opts) => Net.get(path, opts),
    post: (path, body, opts) => enqueue(async () => {
      const options = Object.assign({}, opts, { owner: typeof Net.account === 'function' ? String((Net.account() || {}).accountId || '') : '' });
      // Read revision when this mutation reaches the queue, after earlier actions.
      const payload = body && Object.prototype.hasOwnProperty.call(body, 'rev')
        ? Object.assign({}, body, { rev: S.rev }) : body;
      try { return acceptResponse(await Net.post(path, payload, opts), options); }
      catch (e) {
        if (S.ready && e && (e.code === 'NETWORK' || e.code === 'CONFLICT')) markResync();
        throw e;
      }
    }),
    del: (path, opts) => Net.del(path, opts),
    toast,
    errText,
  };

  window.Online = Online;
  if (window.addEventListener) window.addEventListener('ssdz-online-session-expired', event => {
    clearSession();
    if (window.OnlineUI) OnlineUI.showLogin('login', event && event.detail && event.detail.message);
  });

  /* ============================================================
   * `StateCall(name, ...args)` — 页面调动作的统一入口
   * ------------------------------------------------------------
   * 联机版里 `async` 动作必须等服务端，返回的是 Promise；单机版是同步的。
   * 页面统一写成 `const r = await StateCall('useProp', id);` 就能两边都跑，
   * 不必到处判断 `Online.ready`。**只用于 async 类动作**；sync 类照旧直接调
   * `State.xxx()`（守卫会自动上行确认）。
   * ============================================================ */
  window.StateCall = function StateCall(name, ...args) {
    const key = String(name);
    if (S.ready) return Online.call(key, ...args);
    const api = window.State;
    if (!api || typeof api[key] !== 'function') return Promise.reject(new Error('没有这个动作：' + key));
    try { return Promise.resolve(api[key](...args)); } catch (e) { return Promise.reject(e); }
  };
})();
