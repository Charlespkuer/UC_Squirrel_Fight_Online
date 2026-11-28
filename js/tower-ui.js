// tower-ui.js — 无尽挑战塔界面（经典 UI 壳内）
(function () {
  'use strict';

  const C = () => UI.classic;
  // 对局进度存本机；结算时由服务端发抽奖卷（每 10 层 1 张、铸币 >10 再 +1、
  const ONLINE = typeof window !== 'undefined' && !!window.__SSDZ_ONLINE__;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const find = (root, sel) => root.querySelector(sel);
  function on(root, action, handler) { const el = find(root, '[data-action="' + action + '"]'); if (el) el.onclick = handler; return el; }
  function back(root, handler, label) {
    const el = on(root, 'home', handler);
    if (!el) return;
    const text = label || '返回';
    if (C().setHomeLabel) C().setHomeLabel(root, text); else el.textContent = text;
  }
  // （挑战塔与无尽塔本来就是关卡页里那两颗入口进来的：`[data-action="tower-entry"]` /
  function backToStages() {
    try {
      if (typeof UI !== 'undefined' && UI && typeof UI.runAction === 'function') { UI.runAction('stages'); return; }
    } catch (e) {}
    C().home();
  }
  function notice(text, buttons) { modal('提示', '<p>' + esc(text) + '</p>', buttons || [{ label: '知道了' }], { small: true }); }

  function achievementToast(item) {
    if (!item || typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.className = 'achieve-toast';
    el.innerHTML = '<b>' + esc(item.name) + '</b><i>隐藏成就 · 分数 +' + esc(item.points || 0) + '</i>';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('out'); }, 2600);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3400);
  }

  function flushAchievements(list) {
    for (const it of (list || [])) achievementToast(it);
  }

  function flushRunToasts() {
    let list = [];
    try { list = Tower.takeRunToasts ? Tower.takeRunToasts() : []; } catch (e) { list = []; }
    for (const t of list) {

      if (t && typeof t === 'object') achievementToast(t);
      else runToast(t);
    }
  }

  function flushPendingAchievements() {
    let list = [];
    try { list = Tower.takeAchievementToasts ? Tower.takeAchievementToasts() : []; } catch (e) { list = []; }
    flushAchievements(list);
  }

  function runToast(text, hold) {
    const el = document.createElement('div');
    el.className = 'run-toast' + (hold ? ' hold' : '');
    el.textContent = String(text || '');

    let live = 0;
    try { live = document.querySelectorAll('[class~="run-toast"]:not(.out)').length; } catch (e) { live = 0; }
    if (live > 0) el.style.bottom = (120 + live * 56) + 'px';
    document.body.appendChild(el);
    const stay = hold ? 7000 : 2400;
    setTimeout(() => { el.classList.add('out'); }, stay);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, stay + 800);
  }

  const RARITY = TowerData.RARITY_NAME || ['普通', '稀有', '史诗', '传奇'];

  const SCOPE = { limited: '限次', permanent: '永久', instant: '即时', inscription: '铭文' };

  let replaceTarget = null;

  let pendingMilestone = null;
  // 当前正在显示的「无尽塔本局战报」对象：联机奖励异步回包后只刷新这一页。
  let activeSummary = null;
  // 上一场失利的「重新挑战 / 放弃本局」窗是不是已经开着：openEndless 会被多次调用，
  // 不能让同一个必选窗叠出两层（它没有关闭叉，只能二选一）。
  let retryOfferOpen = false;
  let retryOfferEl = null;
  // 必选窗还在不在：真实 DOM 里它被整页导航移除时 `isConnected === false`，
  // 标志也要跟着复位，否则玩家返回再进来会看不到这个窗、又走不了「重新挑战」。
  function retryOfferVisible() {
    if (!retryOfferOpen) return false;
    if (retryOfferEl && retryOfferEl.isConnected === false) retryOfferOpen = false;
    return retryOfferOpen;
  }

  let bladeOfferOpen = false;
  let bladeOfferEl = null;
  function bladeOfferVisible() {

    return bladeOfferOpen;
  }

  let heroGearPickerEl = null;

  let towerOrigin = 'stages';
  function setTowerOrigin(opts) { if (opts && opts.from) towerOrigin = String(opts.from); }
  function classicTower() {
    try { return towerOrigin === 'village' && window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic'; }
    catch (e) { return false; }
  }
  function backToVillageWar() {
    try {

      if (window.UI && UI.runAction) { UI.runAction('village'); return; }
    } catch (e) {}
    C().home();
  }
  function towerBack() { return classicTower() ? backToVillageWar() : backToStages(); }
  function classicTowerBar() {
    let b = '';
    const label = ONLINE ? '返回村庄' : '返回征战';
    try { b = C().btn(label, 'home', 'gold'); } catch (e) { b = '<button type="button" class="uc-button gold" data-action="home">' + label + '</button>'; }

    return '<div class="classic-tower-bar">' + b + '</div>';
  }

  function classicHeroUi() {
    try {
      return !!(window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic' &&
        window.SfStatus && typeof SfStatus.openHero === 'function');
    } catch (e) { return false; }
  }

  function classicTowerBackground(mode, layer) {
    if (!classicTower()) return null;
    if (mode !== 'endless') return { color: '#4c7c50', t: 0 };

    const cycle = ((Math.max(1, Number(layer) || 1) - 1) % 100) + 1;
    const t = Math.max(0, Math.min(1, (cycle - 1) / 99));
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return {
      color: 'rgb(' + mix(76, 67) + ',' + mix(124, 8) + ',' + mix(80, 8) + ')',
      t: t,
    };
  }

  function applyClassicTowerBg(p, mode, layer) {
    if (!p || !p.style) return;
    const bg = classicTowerBackground(mode, layer);
    if (bg) p.style.setProperty('--tower-bg', bg.color);
  }


  function orderPermanent(list) {
    const arr = (list || []).slice();
    const isFree = (b) => !!(b && b.slotFree === true);
    // ⚠ 这里用 `window.TowerData` 而不是裸的 `TowerData`：本函数的源码片段会被单测截出来
    const TD = (typeof window !== 'undefined' && window && window.TowerData) ? window.TowerData : null;
    const isStory = (b) => {
      const def = (TD && TD.BUFF_BY_ID && b) ? TD.BUFF_BY_ID[b.id] : null;
      return !!(def && TD.hasTag && TD.hasTag(def, 'story'));
    };
    return arr.map((b, i) => ({ b: b, i: i, s: isStory(b) ? 0 : 1, f: isFree(b) ? 0 : 1 }))
      .sort((x, y) => (x.s - y.s) || (x.f - y.f) || (x.i - y.i))
      .map((x) => x.b);
  }

  const rowRef = (b) => (b && b.uid != null && Number(b.uid) > 0 ? String(b.uid) : (b ? String(b.id) : ''));



  function carryBar(hp, maxHp, label, cls, tip) {
    const cap = Math.max(0, Math.round(Number(maxHp) || 0));
    const cur = Math.max(0, Math.round(Number(hp) || 0));
    const pct = cap > 0 ? Math.max(0, Math.min(100, Math.round(cur / cap * 100))) : 0;
    const tipAttr = tip ? ' data-tip="' + esc(tip) + '" title="' + esc(tip) + '" tabindex="0"' : '';
    return '<div class="tower-carry' + (cls ? ' ' + cls : '') + '"' + tipAttr + '><span>' + (label || '血量') + '</span>' +
      '<div class="tower-carry-bar"><i style="width:' + pct + '%"></i></div><b>' +
      (cap > 0 ? (cur + ' / ' + cap) : '—') + '</b></div>';
  }
  // 本局当前的血量上限 / 当前血量（血条悬停用）。
  function hpTip(run) {
    // curMaxHp / curHp 都在 tower.js 里现算（拿到增益、抬上限立刻反映）。
    const maxHp = Number(run && run.curMaxHp) || Number(run && run.lastMaxHp) || 0;
    if (!(maxHp > 0)) return '血量上限：打完第一场后显示';
    const hp = Math.max(0, Math.round(Number(run && run.curHp != null ? run.curHp : run.lastHp) || 0));
    return '当前血量 ' + hp + ' / 上限 ' + maxHp;
  }
  let tipEl = null;

  let tipAnchor = null;
  // 安卓端点开 buff 具体效果后，点其它地方必须能取消，不能只能再点一次原 buff）。
  let tipPinned = false;

  let tipPointerType = 'mouse';
  function showTip(text, anchor) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tower-tip-float'; document.body.appendChild(tipEl); }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    tipAnchor = anchor || null;
    const r = anchor.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    // 气泡默认挂在行下方；但无尽塔右下角固定着「继续战斗 / 放弃本局」两颗键，
    // 放不下就翻到上方（同一套判据，只是提前了上限）。
    let bottomLimit = window.innerHeight - 8;
    try {
      const actions = document.querySelector('.endless-actions');
      if (actions) {
        const ar = actions.getBoundingClientRect();
        if (ar.height > 0 && ar.top > 0) bottomLimit = Math.min(bottomLimit, ar.top - 8);
      }
    } catch (e) {  }
    let top = r.bottom + 8;
    if (top + t.height > bottomLimit) top = Math.max(8, r.top - t.height - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - t.width - 8));
    tipEl.style.left = Math.round(left) + 'px';
    tipEl.style.top = Math.round(top) + 'px';
  }
  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
    tipAnchor = null;
    tipPinned = false;
  }

  function bindTipDismiss() {
    if (typeof document === 'undefined') return;
    // 回归套件用的是最小 DOM（没有 addEventListener）—— 没有就不注册，
    // 悬停/点击气泡本身照常工作，测试也不会因为缺 API 整个挂掉。
    if (typeof document.addEventListener !== 'function') return;
    if (document.__towerTipDismiss) return;
    document.__towerTipDismiss = true;
    document.addEventListener('pointerdown', (e) => {
      tipPointerType = (e && e.pointerType) || 'mouse';
      if (!tipPinned) return;
      const t = e.target;
      if (tipAnchor && (tipAnchor === t || (tipAnchor.contains && tipAnchor.contains(t)))) return;
      hideTip();
    }, true);
    document.addEventListener('keydown', (e) => { if (e && e.key === 'Escape') hideTip(); });
  }
  // 把带 data-tip 的行绑上悬停/聚焦气泡。
  // ⚠ 这里用 `addEventListener`，不再覆盖 `el.onclick` —— 无尽塔的永久增益卡
  function bindTips(root) {
    bindTipDismiss();
    // 纯触屏：去掉原生 title，避免安卓 WebView 弹出的系统提示框盖住/收不掉，
    const touchOnly = !!(window.matchMedia && matchMedia('(hover: none)').matches);
    root.querySelectorAll('[data-tip]').forEach((el) => {
      const text = el.getAttribute('data-tip');
      if (touchOnly) el.removeAttribute('title');
      el.onmouseenter = () => { if (!tipPinned) showTip(text, el); };
      el.onmouseleave = () => { if (!tipPinned) hideTip(); };
      el.onfocus = () => { if (!tipPinned) showTip(text, el); };
      el.onblur = () => { if (!tipPinned) hideTip(); };
      el.addEventListener('pointerdown', (e) => {
        const type = (e && e.pointerType) || 'mouse';
        if (type !== 'touch' && type !== 'pen') return;
        if (tipPinned && tipAnchor === el) hideTip();
        else { showTip(text, el); tipPinned = true; }
      });
      el.addEventListener('click', () => {
        if (tipPointerType === 'touch' || tipPointerType === 'pen') return;
        hideTip();
      });
    });
  }
  function modal(title, content, buttons, opts) {
    const m = C().modal(title, content, buttons, opts);
    if (m && m.element) bindTips(m.element);
    return m;
  }

  function envChip(e, opts) {
    const o = opts || {};
    const tip = [
      e.text || e.desc || '',
      e.rangeText ? ('数值区间：' + e.rangeText) : '',
      '剩余 ' + e.left + ' 场',
    ].filter(Boolean).join('\n');
    const cls = 'mech-chip env-chip' + (e.bad ? ' env-bad' : ' env-good') + (e.mech ? ' env-mech' : '');
    return '<span class="' + cls + '" data-tip="' + esc(tip) + '" title="' + esc(tip) + '" tabindex="0">' +
      esc(e.name || e.id) +
      '<i>' + (o.compact ? ('剩' + e.left) : ('剩 ' + e.left + ' 场')) + '</i></span>';
  }
  // 环境面板：当前生效的全部环境（唯一常驻负面机制）。没有环境时给一句提示。
  function envPanelHtml(run, opts) {
    const o = opts || {};
    const list = (run && run.env) || [];
    // 「当前没有环境词缀（每轮第 5 层起可能出现）」的说明，用户不要这条提示：
    if (!list.length) return '';
    const chips = list.map((e) => envChip(e, o)).join('');
    return '<div class="tower-rule mech-bar env-bar"><b>' + (o.label || '当前环境') + '</b>' + chips + '</div>';
  }
  function mechTip(info, mechs) {
    const parts = [];
    if (info.mechDesc) parts.push(info.mechDesc);
    if (info.patternDesc) parts.push(info.patternDesc);
    // 生效中的环境词缀（唯一常驻负面机制）也写进气泡。调用方传进来的就是渲染好的文案。
    if (mechs && mechs.length) {
      parts.push('当前环境：' + mechs.join('；'));
    }
    return parts.join('\n') || '没有特殊机制';
  }


  const CHAR_FILE = { tl: 'mantis', xh: 'crane', xm: 'panda' };
  const SQ_SHEETS = ['SQ_01', 'SQ_02'];

  const NPC_SHEETS = { tl: ['tl'], xh: ['xh1', 'xh2'], xm: ['xm1', 'xm2'] };
  const NPC_IDLE = { tl: 'tl_rest', xh: 'xh_rest', xm: 'xm_rest' };
  const AVATAR_SIZE = 104;
  function foePortraitHtml(index, info) {

    if (info.kind === 'campaign') {
      return '<span class="foe-portrait"><span class="sf-classic-campaign" data-campaign-foe="' +
        index + '"></span></span>';
    }

    if (classicTower()) {
      const file = (info.kind === 'hero' || info.kind === 'npc') ? (CHAR_FILE[info.anim] || 'mantis') : null;
      if (file) return '<span class="foe-portrait"><img alt="" src="images/ui/characters/' + file + '-classic-card.png"></span>';

      return '<span class="foe-portrait"><span class="sf-classic-foe" data-classic-foe="' + index + '"></span></span>';
    }
    if (info.kind === 'hero') {
      const file = CHAR_FILE[info.anim] || 'mantis';
      return '<span class="foe-portrait"><img alt="" src="images/ui/characters/' + file + '-classic-card.png"></span>';
    }
    return '<span class="foe-portrait"><canvas width="' + AVATAR_SIZE + '" height="' + AVATAR_SIZE +
      '" data-foe-art="' + index + '" aria-hidden="true"></canvas></span>';
  }

  let classicGearTables = null;
  const CLASSIC_FACE_PARTS = [
    { type: 0, cells: [['mc_head', 0]] },
    { type: 1, cells: [['mc_fistL', 0], ['mc_fistR', 1]] },
    { type: 2, cells: [['mc_body', 0], ['mc_handL', 1], ['mc_handR', 1]] },
    { type: 3, cells: [['mc_footL', 0], ['mc_footR', 0]] },
  ];
  async function loadClassicGear() {
    if (classicGearTables) return classicGearTables;
    try { await SfRender.loadExtra('tags-challenge.json'); } catch (e) {}
    try { await SfRender.loadExtra('tags-gear.json'); } catch (e) {}
    const j = (f) => SfRender.loadTable(f).catch(() => null);
    const [frames, slots] = await Promise.all([j('gear-frames.json'), j('gear-slots.json')]);
    if (!frames || !slots) return null;
    const cont = {};

    for (const c of slots.portraitContainer || []) cont[c.type] = c.ids;
    classicGearTables = { frameById: new Map((frames.gear || []).map((g) => [Number(g.id), g.frame])), cont: cont };
    return classicGearTables;
  }
  function classicGearType(g) {
    const ty = Number(g && g.type);
    if (Number.isFinite(ty) && ty >= 0 && ty <= 3) return ty;
    try {
      if (window.State && State.gearPart) {
        const t2 = Number(State.gearPart(Number(g && g.id)));
        if (Number.isFinite(t2) && t2 >= 0 && t2 <= 3) return t2;
      }
    } catch (e) {}
    return NaN;
  }

  function classicGearFrame(g) {
    if (!classicGearTables || !g) return 0;
    const base = classicGearTables.frameById.get(Number(g.id));
    if (!base) return 0;
    const raw = g.ext;
    let level = Array.isArray(raw)
      ? raw.reduce((m, e) => Math.max(m, Number(e && e.level) || 0), 0)
      : Math.max(0, Number(raw) || 0);
    level = Math.max(level, Math.max(0, Math.min(3, Number(g.tier) || 0)));
    level = Math.max(0, Math.min(3, level));
    const type = classicGearType(g);
    const addr = (type === 0 || type === 1) && level > 0 ? level - 1 : 0;
    return base + addr;
  }
  function attachClassicGear(bg, info) {
    if (!bg || !classicGearTables || !info) return 0;
    const gearList = Array.isArray(info.gear)
      ? info.gear
      : (typeof info.gear === 'string' && window.TowerData && TowerData.wearsOf ? TowerData.wearsOf(info.gear) : []);
    if (!gearList.length) return 0;
    const byType = new Map();
    for (const raw of gearList) {
      const g = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
      const ty = classicGearType(g);
      if (Number.isFinite(ty) && !byType.has(ty)) byType.set(ty, g);
    }
    let n = 0;
    for (const row of CLASSIC_FACE_PARTS) {
      const g = byType.get(row.type);
      const frame = g ? classicGearFrame(g) : 0;
      for (const pair of row.cells) {
        const clip = bg.byName ? bg.byName(pair[0]) : null;
        if (!clip || !clip.detachAll) continue;
        clip.detachAll();
        if (!frame) continue;
        const sym = classicGearTables.cont[row.type] && classicGearTables.cont[row.type][pair[1]];
        if (sym && clip.attachChild(sym, frame, 'wear')) n++;
      }
    }
    return n;
  }

  // 外观格画稿：`gear-frames.json` 的容器帧 → 原版矢量（头 1919 / 外拳 1915 / 身体 1909 / 鞋 1912）。
  // 强化差分靠 `classicGearFrame` 加帧，和纸娃娃同一套 frame 口径；不再走 PNG 缩略图。
  let heroGearArtToken = 0;
  function stopHeroGearArt(root) {
    heroGearArtToken++;
    if (!root) return;
    if (root.__heroGearArtIO) {
      try { root.__heroGearArtIO.disconnect(); } catch (e) {}
      root.__heroGearArtIO = null;
    }
    if (!root.querySelectorAll) return;
    root.querySelectorAll('[data-hero-gear-art]').forEach((host) => {
      const view = host.__heroGearArtView;
      host.__heroGearArtView = null;
      if (view && typeof view.destroy === 'function') { try { view.destroy(); } catch (e) {} }
    });
  }
  async function mountHeroGearArt(host, tables, token) {
    if (!host || host.__heroGearArtDone) return;
    const box = host.closest ? host.closest('.hero-gear-icon') : null;
    const fallback = () => { if (box) box.classList.add('missing'); };
    const id = Number(host.dataset.heroGearArt);
    const tier = Math.max(1, Math.min(3, Number(host.dataset.heroTier) || 1));
    const type = heroGearTypeOf(id);
    const cont = tables && tables.cont && tables.cont[type] && tables.cont[type][0];
    if (!(id > 0) || !Number.isInteger(type) || type < 0 || type > 3 || !cont) { fallback(); return; }
    const frame = classicGearFrame({ id: id, type: type, tier: tier, ext: [] });
    if (!(frame > 0)) { fallback(); return; }
    host.__heroGearArtDone = true;
    try {
      const view = await SfRender.mountSymbol(host, cont, { frame: frame, label: '' });
      if (token !== heroGearArtToken || !host.isConnected) {
        try { view.destroy(); } catch (e) {}
        return;
      }
      host.__heroGearArtView = view;
      const svg = host.querySelector('svg');
      if (svg && view && view.g && view.g.getBBox) {
        try {
          const bb = view.g.getBBox();
          if (bb && bb.width > 0 && bb.height > 0) {
            const padX = Math.max(0.4, bb.width * 0.04);
            const padY = Math.max(0.4, bb.height * 0.04);
            svg.setAttribute('viewBox', (bb.x - padX) + ' ' + (bb.y - padY) + ' ' +
              (bb.width + padX * 2) + ' ' + (bb.height + padY * 2));
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          }
        } catch (e) {}
      }
    } catch (e) {
      fallback();
    }
  }
  async function hydrateHeroGearArt(root) {
    if (!root || !window.SfRender || typeof SfRender.mountSymbol !== 'function') return;
    const tables = await loadClassicGear().catch(() => null);
    if (!root.isConnected) return;
    const hosts = Array.from(root.querySelectorAll('[data-hero-gear-art]'));
    if (!hosts.length) return;
    if (!tables) {
      root.querySelectorAll('.hero-gear-icon').forEach((box) => box.classList.add('missing'));
      return;
    }
    const token = ++heroGearArtToken;
    const run = (host) => { mountHeroGearArt(host, tables, token); };
    if (typeof IntersectionObserver === 'function') {
      const scroll = root.querySelector('.hero-gear-picker-scroll');
      const io = new IntersectionObserver((entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          io.unobserve(ent.target);
          run(ent.target);
        }
      }, { root: scroll || null, rootMargin: '240px 0px' });
      hosts.forEach((host) => io.observe(host));
      root.__heroGearArtIO = io;
    } else {
      hosts.forEach(run);
    }
  }

  // 把人物/SVG 的屏幕矩形反算到用户坐标，取直接根层的并集当裁切框。
  // ⚠ 不用 getScreenCTM：iOS 15 会漏掉祖先 CSS transform 的 scale（WebKit 209220）。
  function fitSvgToModel(svg, view, opts) {
    if (!svg || !view || !view.g) return;
    const o = opts || {};
    const pad = Number.isFinite(Number(o.pad)) ? Number(o.pad) : 7;
    const zoom = Number.isFinite(Number(o.zoom)) ? Number(o.zoom) : 1.08;
    let bb = null;
    try {
      const sr = svg.getBoundingClientRect();
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (!sr || !vb || !sr.width || !sr.height || !vb.width || !vb.height) throw new Error('no rect');
      const par = String(svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
      const scale = /slice/.test(par) ? Math.max(sr.width / vb.width, sr.height / vb.height)
        : Math.min(sr.width / vb.width, sr.height / vb.height);
      const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
      const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
      const x0 = sr.left + (sr.width - vb.width * scale) * ax - vb.x * scale;
      const y0 = sr.top + (sr.height - vb.height * scale) * ay - vb.y * scale;
      const toUser = (sx, sy) => ({ x: (sx - x0) / scale, y: (sy - y0) / scale });
      // 只量隐藏完非松鼠元件后的直接根层（人物 + 尾巴 + 装备）；整棵 v.g 会带舞台空白。
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
      for (const child of Array.from(view.g.children || [])) {
        if (String(child.tagName || '').toLowerCase() !== 'g') continue;
        if (child.style && child.style.display === 'none') continue;
        const rr = child.getBoundingClientRect();
        if (!rr.width || !rr.height) continue;
        const a = toUser(rr.left, rr.top);
        const z = toUser(rr.right, rr.bottom);
        x1 = Math.min(x1, a.x, z.x); y1 = Math.min(y1, a.y, z.y);
        x2 = Math.max(x2, a.x, z.x); y2 = Math.max(y2, a.y, z.y);
        n++;
      }
      if (n) {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const side = Math.max(x2 - x1, y2 - y1) * zoom + pad * 2;
        bb = { x: cx - side / 2, y: cy - side / 2, width: side, height: side };
      }
    } catch (e) { bb = null; }
    if (!bb || !bb.width || !bb.height) bb = { x: -35, y: -60, width: 90, height: 90 };
    svg.setAttribute('viewBox', bb.x + ' ' + bb.y + ' ' + bb.width + ' ' + bb.height);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%'; svg.style.height = '100%';
  }

  async function mountClassicSquirrel(host, info, opts) {
    const o = opts || {};
    await loadClassicGear();
    let v = null;
    for (let attempt = 0; attempt < 2 && !v; attempt++) {
      try {
        if (attempt) await SfRender.loadExtra('tags-challenge.json');
        v = await SfRender.mountSymbol(host, '7232', { frame: 1, label: o.label || '经典对手' });
      } catch (e) {
        if (attempt) throw e;
      }
    }
    if (!v) return null;
    if (!host.isConnected) { try { v.destroy(); } catch (e) {} return null; }
    SfUiMain.toolkit.freezeDescendants(v);
    v.playing = false;
    attachClassicGear(v, info);

    const hasGear = !!(info && info.gear && (Array.isArray(info.gear) ? info.gear.length > 0 : true));
    if (hasGear) {
      // 装备版（黑色/紫色狂战套等）不能只留挂点祖先：7232 的填充/阴影分布在其它根层，
      for (const child of Array.from(v.g.children || [])) {
        if (!child.querySelector) continue;
        // 只隐藏奶油底框 / 地面影子 / 花饰；它们是非松鼠元件，
        // 不能整层清空，否则紫色狂战的填色层会一起没掉。
        if (child.querySelector('path[d^="M10.35,-52.85"]') ||
            child.querySelector('path[d^="M-0.15,-9Q"]') ||
            child.querySelector('path[d^="M-48.65,-50.85"]')) {
          child.style.display = 'none';
        }
      }
    } else {
      const parts = ['mc_head', 'mc_body', 'mc_fistL', 'mc_fistR', 'mc_handL', 'mc_handR', 'mc_footL', 'mc_footR', 'ikNode_9'];
      const keepRoots = new Set();
      for (const name of parts) {
        const c = v.byName(name);
        if (!c || !c.g) continue;
        let node = c.g;
        while (node && node.parentNode && node.parentNode !== v.g) node = node.parentNode;
        if (node && node.parentNode === v.g) keepRoots.add(node);
      }
      for (const child of Array.from(v.g.children || [])) {
        if (String(child.tagName || '').toLowerCase() === 'defs') continue;
        if (!keepRoots.has(child)) child.style.display = 'none';
      }
    }
    // 7232 里除了人物，还带战力图标、属性条、背景板等根级元件；只把人物挂点
    // 的祖先链留下来，其余根级子元素全部隐藏，否则它们会从裁切框下方露出来。
    for (const f of ['power', 'agility', 'speed', 'hp', 'num1', 'num2', 'num3', 'num4', 'num5']) {
      const c = v.byName(f); if (c && c.g) c.g.style.display = 'none';
    }
    for (const t of v.g.querySelectorAll('text')) { try { t.style.display = 'none'; } catch (e) {} }
    fitSvgToModel(host.querySelector('svg'), v, o);
    host.classList.add('ready');
    return v;
  }
  async function fillClassicFoeArt(root, preview) {
    const hosts = root.querySelectorAll('[data-classic-foe]');
    if (!hosts.length) return;
    for (const host of hosts) {
      const info = preview[Number(host.dataset.classicFoe)];
      if (!info || !host.isConnected) continue;
      try {
        await mountClassicSquirrel(host, info, { label: '经典对手' });
      } catch (e) {
        if (window.__errs) window.__errs.push('classic foe art: ' + (e && e.message));
      }
    }
  }
  // 经典塔里原版征战动物 boss 的小立绘：6833 按 mcFrame 拨到动物形态，裁成头像尺寸。
  // ⚠ 与 `fillClassicFoeArt` 同一套套路（挂载 → 冻结 → 只留角色根层 → 用屏幕矩形反算
  async function fillClassicCampaignArt(root, preview) {
    const hosts = root.querySelectorAll('[data-campaign-foe]');
    if (!hosts.length) return;
    try {
      await SfRender.loadExtra('tags-campaign-boss.json');
    } catch (e) {
      if (window.__errs) window.__errs.push('classic campaign art load: ' + (e && e.message));
      return;
    }
    for (const host of hosts) {
      const info = preview[Number(host.dataset.campaignFoe)];
      if (!info || !host.isConnected) continue;
      try {
        const v = await SfRender.mountSymbol(host, '6833', {
          frame: Math.max(1, Math.min(7, Number(info.mcFrame) || 1)), label: '征战首领',
        });
        if (!host.isConnected) { try { v.destroy(); } catch (e) {} continue; }
        SfUiMain.toolkit.freezeDescendants(v);
        v.playing = false;
        const model = v.byName('playerMc');

        const keep = new Set();
        if (model && model.g) {
          let node = model.g;
          while (node && node.parentNode && node.parentNode !== v.g) node = node.parentNode;
          if (node && node.parentNode === v.g) keep.add(node);
        }
        for (const child of Array.from(v.g.children || [])) {
          if (String(child.tagName || '').toLowerCase() === 'defs') continue;
          if (keep.size && !keep.has(child)) child.style.display = 'none';
        }
        fitSvgToModel(host.querySelector('svg'), v);
        host.classList.add('ready');
      } catch (e) {
        if (window.__errs) window.__errs.push('classic campaign art: ' + (e && e.message));
      }
    }
  }
  function fallbackPortrait(canvas, info) {
    const kind = info && info.kind;
    const file = CHAR_FILE[info && info.anim];
    let src = null;
    if (kind === 'hero') src = file ? 'images/ui/characters/' + file + '-classic-card.png' : null;
    else if (kind === 'npc') src = null;
    else src = 'images/ui/characters/squirrel-classic.png';
    if (!src) { canvas.remove(); return; }
    const img = document.createElement('img');
    img.alt = ''; img.src = src;
    canvas.replaceWith(img);
  }

  async function drawFoeArt(canvas, info) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !window.Engine) return;
    const npc = info.kind === 'npc';
    const sheets = npc ? (NPC_SHEETS[info.anim] || null) : SQ_SHEETS;
    const animName = npc ? (NPC_IDLE[info.anim] || 'tl_rest') : 'standby';
    try {
      await Engine.loadSheets(sheets || []);
      const p = Engine.makePlayer();
      const inst = Engine.playAnim(p, animName, { fps: 20, loop: true, sheets: sheets, holdLast: true });
      if (!inst || !inst.frames.length) { fallbackPortrait(canvas, info); return; }
      const box = Engine.frameBounds(inst.frames[0], { sheets: sheets }) || { x: 0, y: 0, w: 1, h: 1 };
      const size = canvas.width, pad = 4;
      const s = Math.min((size - pad * 2) / Math.max(1, box.w), (size - pad * 2) / Math.max(1, box.h)) * 1.04;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.setTransform(s, 0, 0, s, size / 2 - (box.x + box.w / 2) * s, size / 2 - (box.y + box.h / 2) * s);
      Engine.drawPlayer(ctx, p);
      canvas.dataset.drawn = '1';
    } catch (e) {  }
  }
  // 预告里所有需要 canvas 的对手头像一起画（异步，画完就算）。
  function fillFoeArt(root, preview) {
    const list = [];
    root.querySelectorAll('[data-foe-art]').forEach((c) => {
      const info = preview[Number(c.dataset.foeArt)];
      if (info && c.getContext) list.push(drawFoeArt(c, info));
    });
    return Promise.all(list);
  }


  function buffTag(b, stacks) {

    const mul = Number(b && b.enchMul) || 1;
    const free = !!(b && b.slotFree === true);
    const crys = mul > 1;
    const marks = [];
    if (free) marks.push('虚空铭文 · 不占位');
    if (crys) marks.push('水晶铭文 · 效果 ×' + mul);
    const tip = String(b.desc || '') + (marks.length ? '（' + marks.join('　') + '）' : '');
    return '<span class="buff-tag r' + b.rarity + enchCls(b) + '" title="' + esc(tip) + '">' + esc(b.name) +
      '<i>' + SCOPE[b.kind] + '</i>' + (stacks > 1 ? '<em>×' + stacks + '</em>' : '') + '</span>';
  }
  // 铭文附魔的类名出口（画 .buff-tag 的地方都必须走这里）：
  // ⚠ 教训：无尽塔主面板（`buffPanelsHtml`，玩家一直盯着的那块「永久增益 / 限次增益」）
  function enchCls(b) {
    const free = !!(b && b.slotFree === true);
    const crys = (Number(b && b.enchMul) || 1) > 1;
    return (free && crys) ? ' ench-both' : (crys ? ' ench-crystal' : (free ? ' slot-free' : ''));
  }
  function ownedBuffsHtml(mode) {
    const list = Tower.ownedBuffs(mode);
    if (!list.length) return '';
    return '<div class="tower-buffs"><h4>本局构筑</h4><div class="buff-tags">' +
      list.map((b) => buffTag(b, b.stacks)).join('') + '</div></div>';
  }
  function permTip(b, mirrorSnapshot, run) {
    const buff = TowerData.BUFF_BY_ID[b.id];
    if (!buff) return b.name;
    const mul = Number(b.enchMul) || 1;
    // 正确显示附魔后的效果。" 附魔时直接改用按附魔值生成的完整效果清单。
    const parts = [buff.name + '（' + RARITY[buff.rarity] + ' · 永久）'];
    if (mul > 1) parts.push('水晶铭文附魔：本条效果 ×' + mul + '（下列数值已含；栏位 / 掉落 / 经济类 / 全局倍率本身不随铭文变化）');
    else parts.push(buff.desc);
    if (b.id === TowerData.MIRROR.id && mirrorSnapshot && mirrorSnapshot.source) {
      const s = mirrorSnapshot.source;
      parts.push('已封存至第 ' + mirrorSnapshot.absorbedThrough + ' 层的首回合属性');
      parts.push('攻击 ' + Math.round(s.power) + ' · 敏捷 ' + Math.round(s.agility) + ' · 速度 ' + Math.round(s.speed));
      parts.push('生命上限 ' + Math.round(s.maxHp) + '（封存时数值；后续装备变化仍生效）');
      const c = mirrorSnapshot.combat || {};
      const pct = (n) => String(Math.round(n * 10000) / 100) + '%';
      const combat = [];
      if (c.critBonus) combat.push('暴击 +' + c.critBonus + '%');
      if (c.critDmgBonus) combat.push('暴伤 +' + c.critDmgBonus + '%');
      if (c.dodgeBonus) combat.push('闪避 +' + c.dodgeBonus + '%');
      if (c.dodgeMul) combat.push('闪避倍率加成 ' + pct(c.dodgeMul));
      if (c.takenMul) combat.push('受伤修正 ' + pct(c.takenMul));
      if (c.lifestealPct) combat.push('吸血 ' + pct(c.lifestealPct));
      if (c.regenPct) combat.push('每回合回复 ' + pct(c.regenPct));
      if (c.shellPct) combat.push('开战护盾 ' + pct(c.shellPct));
      if (c.thornsPct) combat.push('反伤 ' + pct(c.thornsPct));
      if (c.dmgMul) combat.push('伤害 ×' + c.dmgMul);
      if (c.healMul) combat.push('治疗 ×' + c.healMul);
      if (c.reflectImmune) combat.push('反伤免疫');
      if (c.mustHitAll) combat.push('攻击必中');
      if (combat.length) parts.push('封存战斗加成：' + combat.join(' · '));
      parts.push('不占永久位；旧增益的成长、限次及经济效果不再触发');
    }
    parts.push(b.id === TowerData.MIRROR.id ? '镜界印记：×' + b.stacks
      : '当前叠层：×' + b.stacks + (b.stacks > 1 ? '（按层数累加）' : ''));

    const raw = buff.mods || {};
    // 只有会随铭文倍率结算的键才乘；下面这些是「获得时一次性生效 / 经济类」，
    // tower.js 的 addBuff / 成长 / 掉落走的还是基础值（悬停必须与结算一致）：
    const RAW_KEYS = new Set(['lowHpAt', 'lowHpRegenAt', 'permSlot', 'pickWeaponPct', 'pickSkillPct',
      'rarityBoost', 'epicMul', 'legendMul', 'commonMul', 'sellValue', 'sellGrowthPerWin',
      'shopEnterCoins', 'globalMul', 'kingMirrorBlade',

      'shopSpendStat', 'shopSpendHp']);
    const COST_KEYS = new Set(['shopSpendStep', 'shopSpendLimited', 'limitedDefaultRerollPaid']);
    const m = (mul === 1) ? raw : Object.keys(raw).reduce((o, k) => {
      const v = raw[k];
      if (typeof v === 'number') {
        if (COST_KEYS.has(k)) {

          o[k] = (window.Tower && Tower.enchCostOf) ? Tower.enchCostOf(v, mul) : Math.max(1, Math.round(v * 0.75));
        } else if (RAW_KEYS.has(k)) o[k] = v;
        else o[k] = v * mul;
      } else if (k === 'shopSpendTiers' && Array.isArray(v)) {
        o[k] = v.map((x) => ((window.Tower && Tower.enchCostOf) ? Tower.enchCostOf(x, mul) : Math.max(1, Math.round(x * 0.75))));
      } else {
        o[k] = v;
      }
      return o;
    }, {});
    if (b.slotFree === true) parts.push('铭文附魔：虚空铭文 · 不占位');
    // 百分比统一保留一位小数再显示：0.15×1.5=22.5% 不能因为浮点尾巴被四舍五入成 22%
    const p1 = (v) => { const n = Math.round(Number(v || 0) * 10) / 10; return String(n).replace(/\.0$/, ''); };
    if (m.powerMul) parts.push('攻击合计 +' + p1(m.powerMul * b.stacks * 100) + '%');
    if (m.maxHpMul) parts.push('生命上限合计 ' + (m.maxHpMul * b.stacks >= 0 ? '+' : '') + p1(m.maxHpMul * b.stacks * 100) + '%');
    if (m.critBonus) parts.push('暴击合计 +' + p1(m.critBonus * b.stacks) + '%');
    if (m.critDmgBonus) parts.push('暴击伤害合计 +' + p1(m.critDmgBonus * b.stacks) + '%');
    if (m.dodgeBonus) {
      const dodgeCap = (window.Tower && Tower.dodgeCapPct) ? Tower.dodgeCapPct() : 55;
      const dodgeSum = m.dodgeBonus * b.stacks;
      parts.push('闪避合计 +' + p1(Math.min(dodgeSum, dodgeCap)) + '%' +
        (dodgeSum > dodgeCap ? '（已达上限）' : '') +
        '；所有闪避来源合计上限 ' + dodgeCap + '%');
    }
    if (m.lifestealPct) parts.push('吸血合计 ' + p1(m.lifestealPct * b.stacks * 100) + '%');
    if (m.thornsPct) parts.push('反伤合计 ' + p1(m.thornsPct * b.stacks * 100) + '%');
    if (m.shellPct) parts.push('每场战斗开局护盾 ' + p1(m.shellPct * b.stacks * 100) + '% 最大生命');
    if (m.takenMul) parts.push('受到伤害 ' + (m.takenMul < 0 ? '−' : '+') + p1(Math.abs(m.takenMul) * b.stacks * 100) + '%');
    if (m.speedMul) parts.push('速度合计 +' + p1(m.speedMul * b.stacks * 100) + '%');
    if (m.agilityMul) parts.push('敏捷合计 +' + p1(m.agilityMul * b.stacks * 100) + '%');

    if (m.startHealPct) parts.push('每场战斗开始回血合计 ' + p1(m.startHealPct * b.stacks * 100) + '%');
    if (m.killPowerPct) parts.push('每击杀攻击 +' + p1(m.killPowerPct * b.stacks * 100) + '%' +
      (m.killPowerCap ? '（上限 +' + p1(m.killPowerCap * b.stacks * 100) + '%）' : ''));
    // 换成真正在用的「每胜利生命上限」字段（C07 吞噬成长）。

    if (m.lowHpPowerMul || m.lowHpAgilityMul || m.lowHpSpeedMul || m.lowHpFinalMul) {
      const low = '生命低于 ' + Math.round((m.lowHpAt || 0.5) * 100) + '% 时';
      const bits = [];
      if (m.lowHpPowerMul) bits.push('攻击 +' + p1(m.lowHpPowerMul * b.stacks * 100) + '%');
      if (m.lowHpFinalMul) bits.push('最终伤害 ×' + (1 + m.lowHpFinalMul * b.stacks).toFixed(2));
      if (m.lowHpAgilityMul) bits.push('最终敏捷 ×' + (1 + m.lowHpAgilityMul * b.stacks).toFixed(2));
      if (m.lowHpSpeedMul) bits.push('最终速度 ×' + (1 + m.lowHpSpeedMul * b.stacks).toFixed(2));
      parts.push(low + bits.join('、'));
    }
    if (m.winMaxHpPct) parts.push('每胜利生命上限 +' + p1(m.winMaxHpPct * b.stacks * 100) + '%' +
      (m.winMaxHpCap ? '（上限 +' + p1(m.winMaxHpCap * b.stacks * 100) + '%）' : ''));
    if (m.winMaxHpFlat) parts.push('每胜利生命上限 +' + p1(m.winMaxHpFlat * b.stacks));
    if (m.winStatAfter10) parts.push('第 10 层起每胜利 力/敏/速 各 +' + (m.winStatAfter10 * b.stacks));
    if (m.revivePct) {
      parts.push('复活回血 ' + Math.round(m.revivePct * 100) + '%' +
        (m.reviveStatMul ? '，复活后本场力/敏/速 +' + Math.round(m.reviveStatMul * 100) + '%' : ''));

      const rev = (window.Tower && Tower.reviveInfoOf) ? Tower.reviveInfoOf(run) : null;
      const perLayer = rev ? rev.perLayer : Math.max(1, Math.floor(Number(b.stacks) || 1));
      const left = rev ? rev.left : perLayer;
      parts.push(left > 0
        ? ('本层复活机会：' + left + ' 次' + (rev && rev.used > 0 ? '（本层已用 ' + rev.used + '/' + perLayer + '）' : '') +
          '；被打死或回合耗尽判负时触发')
        : ('本层复活机会：已用尽（' + perLayer + '/' + perLayer + '）'));
    }
    if (m.globalMul) parts.push('全局增幅 ×' + m.globalMul + '（同名多张加算，且与水晶铭文加算）');
    if (m.powerPerEmptySlot) parts.push('每个空的永久增益位 攻击 +' + Math.round(m.powerPerEmptySlot * 100) + '%');
    if (m.powerPerPermBuff) parts.push('每拥有 1 个永久增益 攻击 +' + Math.round(m.powerPerPermBuff * 100) + '%');

    if (m.shopSpendStep) {
      const steps = (Array.isArray(m.shopSpendTiers) && m.shopSpendTiers.length)
        ? m.shopSpendTiers : [m.shopSpendStep];
      parts.push('每消费 ' + steps.join(' / ') + ' 试炼币 → 随机获得 力+' + (m.shopSpendStat || 1) +
        ' / 敏+' + (m.shopSpendStat || 1) + ' / 速+' + (m.shopSpendStat || 1) +
        ' / 生命上限+' + (m.shopSpendHp || 5) + ' 其中一项');
    }
    if (m.firstDodge) parts.push('每场战斗中敌方对我方的第一次攻击必定闪避' + (m.firstDodgeFreeTurn ? '，且我方立刻额外行动一次' : ''));
    if (m.firstHitZero) parts.push('每场战斗中我方第一次受到的伤害降低为 0' + (m.firstHitZeroFreeTurn ? '，且我方立刻额外行动一次' : ''));
    if (m.envIgnore || m.envReflect || m.envDenyGood) parts.push('无视负面环境词缀；敌方无法获得环境词缀加成');

    if (m.roundStatPct) parts.push('战斗中每回合开始 力/敏/速 各 +' +
      (Math.round(m.roundStatPct * b.stacks * 1000) / 10) + '%' + (b.stacks > 1 ? '（可叠 ' + b.stacks + ' 层）' : '') +
      '；每场战斗结束时清零');
    if (m.catchUpPct) parts.push('战斗中每回合把「落后对手最多」的那一项补上差距的 ' + Math.round(m.catchUpPct * 100) +
      '%，并让对手那一项减少同样的数值；每场战斗结束时清零');
    if (m.roundMaxHpMul) parts.push('战斗中每回合双方生命上限 ×' + Math.round(m.roundMaxHpMul * 100) + '%（向下取整）；每场战斗结束时清零');
    if (m.shopSpendLimited) parts.push('每在试炼商店买货或买铸币消费 ' + m.shopSpendLimited + ' 试炼币 → 立即获得 1 个随机限次增益（刷新不算）');
    if (m.rerollTiltMul) parts.push('本局商店刷新的稀有度提升速度 ×' + m.rerollTiltMul +
      '（每花 10 试炼币带来的提升翻倍）');
    if (m.shopEnterCoins) parts.push('每进入一次商店 +' + m.shopEnterCoins + ' 试炼币' +
      (b.stacks > 1 ? '（可叠 ' + b.stacks + ' 层）' : ''));
    if (m.mustHitAll) parts.push('这一场所有攻击必中');
    if (m.mustHitFirst) parts.push('首次攻击必中');
    if (m.pickPermanentFree) parts.push('可给一个已有的永久增益附魔免占位（铭文）');
    if (m.pickPermanentMul) parts.push('可给一个已有的永久增益附魔：这一条效果 ×' + Number(m.pickPermanentMul) + '（铭文）');
    if (m.pickBrandBreak) parts.push('可从已有的烙印里选一个，让它立刻全部破碎（铭文）');
    if (m.pickLimitedUses) parts.push('可从已有的限次增益里选一个（烙印除外），剩余场次 +' + Number(m.pickLimitedUses) + '（铭文）');
    if (m.breakAllBrands) parts.push('立即使持有的所有烙印破碎');
    if (m.brandGate != null) parts.push('只在未破碎的烙印超过 ' + Number(m.brandGate) + ' 份时才会上架');
    if (m.fragileStat) parts.push('本局永久保留：' + ({ power: '力量', agility: '敏捷', speed: '速度' }[m.fragileStat] || m.fragileStat) +
      ' +' + Math.round((m.fragilePct || 0) * 100) + '%；每场 ' + (m.fragileBreakPct || 5) + '% 损毁');

    const pctOf = (v) => Math.round(Number(v || 0) * 1000) / 10;
    if (m.emptyMaxHpMul) parts.push('每场战斗开始获得 ' + pctOf(m.emptyMaxHpMul * b.stacks) + '% 的空生命上限');
    if (m.lowHpRegenPct) parts.push('生命低于 ' + Math.round((m.lowHpRegenAt || 0.5) * 100) + '% 时每回合回复 ' +
      pctOf(m.lowHpRegenPct * b.stacks) + '% 生命上限');
    if (m.lowHpTakenMul) parts.push('生命低于 ' + Math.round((m.lowHpAt || 0.5) * 100) + '% 时受到伤害 −' +
      pctOf(Math.abs(m.lowHpTakenMul) * b.stacks) + '%');
    if (m.lowHpLifestealPct) parts.push('生命低于 ' + Math.round((m.lowHpAt || 0.5) * 100) + '% 时吸血 +' +
      pctOf(m.lowHpLifestealPct * b.stacks) + '%');
    if (m.layerFirstHealPct) parts.push('每进入新的一层，该层第一场战斗开战回复 ' + pctOf(m.layerFirstHealPct * b.stacks) + '% 生命');
    if (m.dmgMulType) parts.push('对螳螂 / 仙鹤 / 熊猫伤害 +' + pctOf(m.dmgMulType * b.stacks) + '%');
    if (m.dmgMulMech) parts.push('对带专属机制的敌人伤害 +' + pctOf(m.dmgMulMech * b.stacks) + '%');
    if (m.dmgMulElite) parts.push('对精英伤害 +' + pctOf(m.dmgMulElite * b.stacks) + '%');
    if (m.eliteHealAfter || m.eliteMaxHpAfter) {
      const bits = [];
      if (m.eliteHealAfter) bits.push('回复 ' + pctOf(m.eliteHealAfter * b.stacks) + '% 最大生命');
      if (m.eliteMaxHpAfter) bits.push('生命上限 +' + pctOf(m.eliteMaxHpAfter * b.stacks) + '%');
      parts.push('击败精英后' + bits.join('，'));
    }
    if (m.x10Boost) parts.push('每到 5 的倍数层，攻击与生命上限各 +' + pctOf(m.x10Boost * b.stacks) + '%');
    if (m.winTakenMulPct) parts.push('本局每胜利一场受到伤害额外 −' + pctOf(m.winTakenMulPct * b.stacks) +
      '%（上限 −' + pctOf((m.winTakenMulCap || 0.25) * b.stacks) + '%）');
    if (m.choiceCount) parts.push('战斗胜利后的选择项 +' + Math.round(m.choiceCount * b.stacks));

    if (m.permSlot) parts.push('本局永久增益槽位 +' + Math.round(m.permSlot * b.stacks) + '（获得时生效，不随铭文变化）');
    if (m.pickWeaponPct) parts.push('可立即从已有武器中三选一，该武器伤害 +' + pctOf(m.pickWeaponPct) + '%（获得时生效）');
    if (m.pickSkillPct) parts.push('可立即从已有主动技能中三选一，该技能触发概率 +' + pctOf(m.pickSkillPct) + '%（获得时生效）');
    if (m.rarityBoost) parts.push('商店史诗 / 传奇出率 ×' + (m.legendMul || 2) + '、普通 ×' + (m.commonMul || 0.5) + '（获得时生效）');
    if (m.sellValue) parts.push('售出获得 ' + Math.round(m.sellValue) + ' 试炼币' +
      (m.sellGrowthPerWin ? '，每胜利一场 +' + Math.round(m.sellGrowthPerWin) : '') + '（经济类，不随铭文变化）');
    if (m.kingMirrorBlade) parts.push('对镜之魔王额外生效：其力量 −20%、生命上限 −30%（每层献祭再各 −2%）');
    if (b.progress) parts.push('当前进度：' + b.progress);
    if (buff.mods && buff.mods.shopDiscount) parts.push('下个商店 ' + Math.round((1 - buff.mods.shopDiscount) * 100) / 10 + ' 折');
    if (buff.mods && buff.mods.postBattleShop) parts.push('下一场战斗后开一次商店');
    // 只有 ①剧情藏品（永远不能拆）②当前已经选中要拿掉的那一条（点一下取消）才写。
    if (TowerData.hasTag(buff, 'story')) parts.push('剧情藏品，不可替换、出售或献祭');
    else if (replaceTarget === rowRef(b)) parts.push('（当前已选为要拿掉的那个，点一下取消）');
    return parts.join('\n');
  }

  function limitTip(b) {
    const buff = TowerData.BUFF_BY_ID[b.id];
    if (!buff) return b.name;
    // 渴血之剑：阶段 / 献祭层数 / 剩余场次 / 强制苏醒都要写清，不能套普通限次文案。
    if (TowerData.isBladeId && TowerData.isBladeId(b.id)) {
      const info = Tower.bladeInfoOf ? Tower.bladeInfoOf() : null;
      const stage = info ? info.stage : (TowerData.bladeStageOf ? TowerData.bladeStageOf(b.id) : 0);
      const stageName = info && info.final ? '最终形态' : (info && info.dead ? '失活形态' : '第 ' + stage + ' 阶段');
      const usesText = b.unlimited
        ? '永续：不再消耗次数，也不再需要献祭'
        : '剩余 ' + b.uses + ' 场；用尽后进化为下一阶段';
      const mirror = info && info.final && info.on
        ? '对镜之魔王：力量 −' + Math.round((info.powerCut || 0) * 100) + '%、生命上限 −' + Math.round((info.hpCut || 0) * 100) + '%'
        : '';
      return [
        buff.name + '（传奇 · 限次装备 · ' + stageName + '）',
        TowerData.descOf(buff, 'endless'),
        '献祭成长：×' + Math.max(1, Number(b.stacks) || 1) + ' 层（每件祭品 +1 层，最多 5 层）',
        usesText,
        mirror,
        b.forced ? '强制苏醒中 · 无法关闭' : (b.on ? '当前生效中 · 点一下可以关掉' : '当前已关闭 · 点一下重新开启'),
      ].filter(Boolean).join('\n');
    }
    const fragile = buff.mods && buff.mods.fragileBreakPct;
    if (fragile) {
      return [buff.name + '（' + RARITY[buff.rarity] + ' · 易碎）', buff.desc,
        '当前未破碎叠层：×' + (b.stacks || 1) +
          ((b.stacks || 1) > 1 ? '（每层独立计时，各自有 ' + fragile + '% 概率损毁）' : '（1 层，' + fragile + '% 概率损毁）'),
        '每打完一场有 ' + fragile + '% 概率损毁；损毁后加成仍然保留',
        b.on ? '当前生效中 · 点一下可以关掉' : '当前已关闭 · 点一下重新开启'].join('\n');
    }
    // 只有挑战塔专属的限次增益才「只服务下一场战斗」，卡面与悬停都不显示「N 场」。
    // 注意判据是 towerOnly 而不是 nextBattle —— 后者只是「下一场战斗生命周期」，
    // 必须照常显示总次数与当前剩余次数（否则玩家只看到「下一场」，
    if (isTowerNext(buff, 'endless')) {
      return [buff.name + '（' + RARITY[buff.rarity] + ' · 挑战塔 · 下一场战斗）', buff.desc,
        '打完这一场就消失（挑战塔的增益只服务下一场）',
        b.on ? '当前生效中 · 点一下可以关掉' : '当前已关闭 · 点一下重新开启'].join('\n');
    }
    return [buff.name + '（' + RARITY[buff.rarity] + ' · 限次 ' + (buff.uses || 1) + ' 场）',
      TowerData.descOf(buff, 'endless'),
      '剩余 ' + b.uses + ' 场（每打完一场扣 1，扣完自动消失）',
      b.on ? '当前生效中 · 点一下可以关掉（关掉不扣次数）' : '当前已关闭 · 点一下重新开启'].join('\n');
  }

  function bladeBadgeText(b) {
    const head = b.forced ? '强制苏醒 · ' : '';
    const stackTag = b.stacks > 1 ? '×' + b.stacks + ' 层 · ' : '';
    return head + stackTag + (b.unlimited ? '永续' : '剩 ' + b.uses + ' 场');
  }
  function limitBadgeText(b) {
    const def = TowerData.BUFF_BY_ID[b.id] || {};
    const stackTag = b.stacks > 1 ? '×' + b.stacks + ' 层 · ' : '';
    if (TowerData.isBladeId && TowerData.isBladeId(b.id)) return bladeBadgeText(b);
    if (isTowerNext(def, 'endless')) return stackTag + '下一场';
    if (def.mods && def.mods.fragileBreakPct) return stackTag + '易碎 ' + def.mods.fragileBreakPct + '%';
    if (TowerData.hasTag(def, 'nextBattle')) return stackTag + '无尽塔 · 剩 ' + b.uses + ' 场';
    return stackTag + '剩 ' + b.uses + ' 场';
  }
  function buffPanelsHtml(mode) {
    const run = mode === 'tower' ? Tower.towerInfo().run : Tower.endlessInfo().run;
    if (!run || mode !== 'endless') return '';
    const list = Tower.ownedBuffs('endless');

    const perm = orderPermanent(list.filter((b) => b.kind === 'permanent'));

    const isBladeBuff = (b) => !!(b && TowerData.isBladeId && TowerData.isBladeId(b.id));
    // 限次增益排布：关闭的沉到最底部、打开的全部在上；同组内剑系（渴血之剑）置顶。
    // 数组顺序就是 `.buff-tags` 的排布顺序，所以关掉一条后下一次重画它自己就落到下面。
    const lim = list.filter((b) => b.kind === 'limited')
      .sort((a, b) => {
        const offA = a.on === false ? 1 : 0;
        const offB = b.on === false ? 1 : 0;
        if (offA !== offB) return offA - offB;
        return Number(isBladeBuff(b)) - Number(isBladeBuff(a));
      });
    const cap = Number(run.permCap) || ((TowerData.PERMANENT_SLOTS || 5) + Math.max(0, Number(run.permSlots || 0)));   // 槽位上限含扩容类加成
    const permHtml = perm.length
      ? perm.map((b, i) => {
          const free = b.slotFree === true;
          const em = enchMark(b);
          const tip = permTip(b, run.mirrorSnapshot, run);
          const canReplace = !TowerData.hasTag(TowerData.BUFF_BY_ID[b.id], 'story');
          const nextFree = i + 1 < perm.length && perm[i + 1].slotFree === true;
          const divider = (free && !nextFree) ? '<span class="buff-sep" aria-hidden="true"></span>' : '';
          // `enchCls(b)` 是附魔外框的唯一出口（虚空=青框 / 水晶=红框 / 两个都吃=半红半青）。
          return '<span class="buff-tag r' + b.rarity + (rowRef(b) === replaceTarget ? ' replacing' : '') +
            enchCls(b) + '"' + (canReplace ? ' data-replace="' + esc(rowRef(b)) + '"' : '') +
            ' data-tip="' + esc(tip) + '" title="' + esc(tip) + '">' +
            esc(b.name) + '<i>' + (free ? '不占位' : '永久') + (em.crys ? ' · ×' + em.mul : '') + '</i>' +
            (b.stacks > 1 ? '<em>×' + b.stacks + '</em>' : '') + '</span>' + divider;
        }).join('')
      : '<span class="buff-empty">还没有永久增益（每层的休整点可以拿）</span>';
    const progList = perm.filter((b) => b.progress);
    const progHtml = progList.length
      ? '<div class="buff-progress-list">' + progList.map((b) =>
          '<span class="buff-progress-item"><b>' + esc(b.name) + '</b>' + esc(b.progress) + '</span>').join('') + '</div>'
      : '';
    const limHtml = lim.length
      ? lim.map((b) => {

          const king = !!(TowerData.BLADE && b.id === TowerData.BLADE.finalId);
          return '<button type="button" class="limit-tag r' + b.rarity +
            (king ? ' legendary' : '') + (b.on ? '' : ' off') + '" data-toggle="' + esc(rowRef(b)) +
            '" data-tip="' + esc(limitTip(b)) + '" title="' + esc(limitTip(b)) + '">' +
            '<b>' + esc(b.name) + '</b><i>' + (b.forced ? '强制苏醒' : (b.on ? '生效中' : '已关闭')) + '</i><em>' +
            limitBadgeText(b) + '</em></button>';
        }).join('')
      : '<span class="buff-empty">还没有限次增益</span>';

    const halfPending = Math.max(0, Number(run.shopHalfPending) || 0);
    const halfHtml = halfPending > 0
      ? '<div class="buff-pending"><span class="pending-chip" data-tip="' +
        esc('讨价还价 ×' + halfPending + '：下一次进入商店（试炼商店或铸币商店）时，那一页有 ' +
          halfPending + ' 件随机商品价格减半（向下取整）、不会重复打同一件') + '">讨价还价 ×' + halfPending +
        '<i>下次进店 ' + halfPending + ' 件对折</i></span></div>'
      : '';
    return '<div class="tower-buffs endless-buffs">' +
      '<h4>永久增益 <span class="buff-slot-count">' + (run.permUsed == null ? perm.length : run.permUsed) + '/' + cap + '</span>' +
      (replaceTarget ? '<span class="replace-hint">选一个要拿掉的（再点增益卡确认）</span>' : '') + '</h4>' +
      '<div class="buff-tags">' + permHtml + '</div>' + progHtml + halfHtml +
      '<h4>限次增益 <span class="buff-slot-count">点一下开关</span></h4>' +
      '<div class="buff-tags">' + limHtml + '</div></div>';
  }
  function debuffPanel(debuffs) {
    if (!debuffs || !debuffs.length) return '';
// 每张卡带上「是哪位大侠给的」小头像 + 来源色，一眼就能对上本层的对手顺序
    return '<div class="tower-debuffs"><h4>本层已被削弱（贯穿本层）</h4><div class="debuff-cards">' +
      debuffs.map((d) => {
        const file = CHAR_FILE[d.from] || null;
        const face = file ? '<img class="debuff-face" alt="" src="images/ui/characters/' + file + '-classic-card.png">' : '';
        return '<div class="debuff-card" style="--hero-color:' + esc(d.color || '#7a4a18') + '">' + face +
          '<span class="debuff-from">' + esc(d.short || d.hero || '大侠') + '</span>' +
          '<b class="debuff-name">' + esc(d.name || '削弱') + '</b>' +
          '<span class="debuff-text">' + esc(d.text || '') + '</span></div>';
      }).join('') +
      '</div></div>';
  }

  function envPreviewHtml(nextLayer) {
    const TD = window.TowerData;
    if (!TD || !TD.envPoolFor) return '';
    const startLayer = Math.max(1, Number(TD.ENV_START_LAYER) || 5);
    if (Number(nextLayer) < startLayer) {
      return '<div class="tower-rule mech-bar env-bar"><b>本层可能的环境</b>' +
        '<span class="mech-none">第 ' + startLayer + ' 层起可能出现（每层随机、持续 4~8 场）</span></div>';
    }
    const pool = TD.envPoolFor('tower');
    const chips = pool.map((raw) => {

      const def = TD.envDefFor ? TD.envDefFor(raw, 'tower') : raw;
      const text = TD.envPreviewText ? TD.envPreviewText(raw, 'tower') : String(def.desc || '');
      const range = TD.envRangeText ? TD.envRangeText(raw, 'tower') : '';
      const tip = text + (range ? '\n数值区间：' + range : '');
      return '<span class="mech-chip env-chip env-bad" data-tip="' + esc(tip) + '" title="' + esc(tip) + '" tabindex="0">' +
        esc(def.name) + '</span>';
    }).join('');
    return '<div class="tower-rule mech-bar env-bar"><b>本层可能的环境</b>' + chips + '</div>';
  }
  function heroDebuffPreviewHtml() {
    const TD = window.TowerData;
    if (!TD || !TD.HERO_DEBUFF) return '';
    const chips = ['tl', 'xh', 'xm'].map((k) => TD.HERO_DEBUFF[k]).filter(Boolean).map((d) => {
      const file = CHAR_FILE[d.anim];
      const face = file ? '<img class="mech-chip-face" alt="" src="images/ui/characters/' + file + '-classic-card.png">' : '';
      const tip = d.hero + '「' + d.ult + '」命中后：' + d.name + '\n' + d.desc +
        '\n（只有大招真的打到才会留下；速杀 / 闪避 / 弹反可以规避）';
      return '<span class="mech-chip debuff-chip" data-tip="' + esc(tip) + '" title="' + esc(tip) + '" tabindex="0">' +
        face + esc(d.hero || '大侠') + ' · ' + esc(d.name) + '</span>';
    }).join('');
    return chips ? '<div class="tower-rule mech-bar"><b>三侠大招会留下</b>' + chips + '</div>' : '';
  }
  // 无尽塔的敌人面板 = 属性基数（目标等级，40 层封顶 70 级）× 段位倍率（31 层封顶 ×10）
  // ⚠ 用户口径：这一档不出现在界面上（局内主界面与开局页都不放）——

  function shopTierHint(layer, count) {
    if (!window.TowerData || !TowerData.endlessShopSlots) return '';
    const n = Math.max(1, Math.floor(Number(layer) || 1));
    const have = Math.max(0, Math.floor(Number(count != null ? count : TowerData.endlessShopSlots(n)) || 0));
    const cycle = Math.max(1, Math.floor(Number(TowerData.LAYER_CYCLE) || 100));
    const c = ((n - 1) % cycle) + 1;
    const band = c <= 20 ? '1-20 层每页 5 件' : c <= 40 ? '21-40 层每页 4 件' : '41-100 层每页 3 件';
    const nextAt = c <= 20 ? 21 : c <= 40 ? 41 : null;
    const tail = '；规则每 ' + cycle + ' 层重来一轮（第 ' + (cycle + 1) + ' 层回到每页 5 件）' +
      (nextAt ? '，第 ' + nextAt + ' 层起每页 ' + (nextAt === 21 ? 4 : 3) + ' 件' : '');
    const tip = '商店每页件数按层分档：' + band + tail +
      '。\n无尽塔每 ' + cycle + ' 层重来一轮（第 ' + (cycle + 1) +
      ' 层回到与第 1 层相同的规则），但敌人的数值继续接着长。';
    return '<p class="shop-tier" data-tip="' + esc(tip) + '" title="商店每页件数按层分档" tabindex="0">' +
      '本层商店 · 每页 <b>' + have + '</b> 件（' + band + '）</p>';
  }
  function syncTickets() {
    if (window.ClassicExtras && ClassicExtras.refreshTickets) { try { ClassicExtras.refreshTickets(); } catch (e) {  } }
    if (window.UI && UI.refreshHeader) { try { UI.refreshHeader(); } catch (e) {  } }
  }

  const CURRENCY_PROP = { book: 23 };
  function currencyHtml(mode) {
    const S = State.state();
    if (mode === 'endless') {
      const run = Tower.endlessInfo().run;
      const items = [];

      if (run) {
        const gained = Math.max(0, Math.floor(Number(run.lastCoinsGained) || 0));
        const bk = run.lastCoinBreak || null;
        const coinLine = bk
          ? ('上一场战斗获得 ' + gained + ' 枚（基础 ' + bk.base + '（' + bk.band + '）' +
             (bk.boosts || []).map((b) => ' × ' + b.name + ' +' + Math.round((Number(b.pct) || 0) * 100) + '%').join('') +
             (bk.elite ? ' × 精英 ×' + bk.eliteMul : '') + '）')
          : (gained ? ('上一场战斗获得 ' + gained + ' 枚') : '');
        items.push({
          name: '试炼币',
          value: run.coins,
          delta: gained || 0,
          tip: '本局持有 ' + Math.max(0, Math.floor(Number(run.coins) || 0)) + ' 试炼币' +
            (coinLine ? ('\n' + coinLine) : '')
        });
      }
      // 抽奖卷的账挪到玩家真的要结算的时候算 —— 见「放弃本局」弹窗（abandon 分支）
      // ⚠ 别把 `endlessInfo` 的 ticketsOnExit / ticketsIfSettle 删掉：弹窗要用它们。
      const tokens = run ? Math.max(0, Math.floor(Number(run.retryToken) || 0)) : 0;
      // 铸币（原名「重新挑战币」）：无尽塔主界面右上角直接标出本场拥有多少枚，
      // 鼠标悬停说明用途（失败时回滚本场 / 退出时 1:1 折成抽奖卷 / 商店售价）。
      const mintGained = run ? Math.max(0, Math.floor(Number(run.lastMintGained) || 0)) : 0;
      items.push({
        name: '铸币',
        value: run ? tokens : 0,
        delta: mintGained || 0,
        tip: run
          ? ('本场拥有 ' + tokens + ' 枚铸币。\n' +
             (mintGained > 0 ? '上一场通过第 10 层倍数，获得 ' + mintGained + ' 枚。\n' : '') +
             '· 每 10 层通关固定 +1 枚\n' +
             '· 战斗失败时可花费 1 枚重新挑战\n' +
             (ONLINE
               ? '· 联机版：结算时持有超过 10 枚铸币，额外得 1 张抽奖卷\n· 抽奖卷按本局通过层数结算：每 10 层 1 张，每周最多 10 张（周一 0 点重置）'
               : '· 退出本局时剩余的铸币按 1:1 折成抽奖卷（最多折 ' +
                 Math.max(0, Math.floor(Number(TowerData.TICKET_FROM_MINT_CAP) || 0)) + ' 枚）'))
          : (ONLINE
            ? '铸币：失败时回滚本场再打一次；结算时超过 10 枚额外得 1 张抽奖卷（周限 10 张）'
            : '铸币：失败时回滚本场再打一次；退出时 1:1 折成抽奖卷')
      });
      return '<div class="tower-currency text-only">' + items.map((it) =>
        '<span class="currency-item"' + (it.tip ? ' data-tip="' + esc(it.tip) + '" title="' + esc(it.tip) + '"' : '') + '><b>' + it.value + '</b>' +
        (it.delta ? '<em class="currency-delta">+' + it.delta + '</em>' : '') +
        '<i>' + it.name + '</i></span>').join('') + '</div>';
    }

    const items = [{ icon: 'images/ui/icons/prop/prop-23.svg', name: '挑战书', value: S.props[CURRENCY_PROP.book] || 0 },
      { icon: 'images/ui/icons/gold-acorn.svg', name: '金松果', value: S.goldPoint }];
    return '<div class="tower-currency">' + items.map((it) =>
      '<span class="currency-item" data-live-gold="' + (it.name === '金松果' ? '1' : '') + '">' +
      '<img alt="" src="' + it.icon + '"><b>' + it.value + '</b><i>' + it.name + '</i></span>').join('') + '</div>';
  }
  // 无尽主界面右上角的「离场结算」一行：
  // · 铸币 ×M —— 失败后可回滚本场再打一次（不折现，不并进上面那个数字）

  // 卡片/悬停用的判据：挑战塔专属的「下一场战斗」限次类。
  // 但它们是 10 次限次，必须照常显示总次数。
  function isTowerNext(b, mode) {
    // 无尽塔里同样的条目（C57 玉石俱焚）是 10 次限次，必须照常显示「限次 10 / 剩余 N 场」。
    return !!(b && (mode === undefined || mode === 'tower') &&
      TowerData.hasTag(b, 'tower') && TowerData.hasTag(b, 'nextBattle'));
  }
  function buffCatalogHtml() {

    const list = TowerData.BUFFS.filter((b) => TowerData.hasTag(b, 'endless') &&
      (!TowerData.hasTag(b, 'hidden') || TowerData.hasTag(b, 'catalog') || b.kind === 'inscription'));
    const byRarity = [0, 1, 2, 3].map((r) => list.filter((b) => b.rarity === r));
    const kindName = { limited: '限次', permanent: '永久', instant: '即时', inscription: '铭文' };
    return '<div class="tower-buffs buff-catalog"><h4>增益集锦 <span class="buff-slot-count">共 ' + list.length + ' 种 · 悬停看效果</span></h4>' +
      byRarity.map((group, r) => group.length
        ? '<div class="catalog-row"><b class="catalog-rarity r' + r + '">' + (RARITY[r] || '') + '</b>' +
          '<div class="buff-tags">' + group.map((b) => '<span class="buff-tag r' + b.rarity + '" data-tip="' +
            esc(b.name + '（' + (RARITY[b.rarity] || '') + ' · ' +
              (isTowerNext(b, 'endless') ? '下一场' : (kindName[b.kind] || '')) +
              (b.kind === 'limited' ? (isTowerNext(b, 'endless') ? ' 下一场战斗' : ' ' + (b.uses || 1) + ' 场') : '') + '）\n' +
              TowerData.descOf(b, 'endless')) +
            '" title="' + esc(TowerData.descOf(b, 'endless')) + '">' + esc(b.name) + '<i>' + (kindName[b.kind] || '') + '</i></span>').join('') +
          '</div></div>' : '').join('') + '</div>';
  }
  // 介绍清楚，再列首领池；顺序固定为「三侠 → 征战首领 → 首领池」。
  const HERO_ORDER = ['tl', 'xh', 'xm'];

  function heroCatalogHtml() {
    const HD = TowerData.HERO_DEBUFF;
    if (!HD) return '';
    const keys = HERO_ORDER.filter((k) => HD[k]);
    if (!keys.length) return '';
    return '<div class="boss-group"><b class="boss-group-title">三侠' +
      '<i>每层第 1~3 场 · 顺序随机</i></b>' +
      '<ol class="tower-plan boss-grid">' + keys.map((k) => {
        const h = HD[k];
        const tip = h.hero + ' · 大招「' + h.ult + '」（' + h.name + '）\n' + h.desc;
        return '<li class="hero" tabindex="0" data-tip="' + esc(tip) + '">' +
          '<b>' + esc(h.hero) + '</b>' +
          '<span class="tower-plan-type">第 1~3 场</span></li>';
      }).join('') + '</ol></div>';
  }

  function campaignCatalogHtml() {
    const list = TowerData.CAMPAIGN_BOSSES;
    if (!Array.isArray(list) || !list.length) return '';
    const layerOf = {};
    for (let L = 10; L <= 990; L += 10) {
      const b = TowerData.campaignBossFor ? TowerData.campaignBossFor(L) : null;
      if (b && layerOf[b.id] == null) layerOf[b.id] = L;
    }
    const layers = Object.values(layerOf).sort((a, b) => a - b);
    const rows = list.map((b) => {
      const L = layerOf[b.id] || 0;
      const tip = [b.name + (L ? ' · 第 ' + L + ' 层（Lv' + b.level + '）' : ''),
        b.patternDesc || '', b.mechDesc || ''].filter(Boolean).join('\n');
      return '<li class="campaign" tabindex="0" data-tip="' + esc(tip) + '">' +
        '<b>' + esc(b.bigName || b.name) + '</b>' +
        '<span class="tower-plan-type">' + esc((L ? '第 ' + L + ' 层' : '征战首领') + ' · Lv' + b.level) + '</span></li>';
    }).join('');
    return '<div class="boss-group"><b class="boss-group-title">四雄' +
      '<i>' + (layers.length ? '征战副本 · 第 ' + layers.join(' / ') + ' 层最后一战' : '征战副本首领') + '</i></b>' +
      '<ol class="tower-plan boss-grid">' + rows + '</ol></div>';
  }

  function demonCatalogHtml(king) {
    if (!king) return '';
    return '<div class="boss-group"><b class="boss-group-title">魔王</b>' +
      '<ol class="tower-plan boss-grid">' +
      '<li class="patrol king" tabindex="0" data-tip="？？？">' +
      '<b>' + esc(king.name) + '</b>' +
      '<span class="tower-plan-type">魔王</span>' +
      '<span class="boss-rarity hidden">？？？</span>' +
      '</li></ol></div>';
  }
  function bossCatalogHtml() {
    const pool = Tower.bossPool ? Tower.bossPool() : [];

    const king = pool.find((b) => b && b.king) || null;
    const rest = pool.filter((b) => b && !b.king);
    const heroes = heroCatalogHtml();
    const campaigns = campaignCatalogHtml();
    const demon = demonCatalogHtml(king);
    if (!rest.length && !heroes && !campaigns && !demon) return '';
    const HD = TowerData.HERO_DEBUFF || {};
    const counts = [];
    if (heroes) counts.push('三侠 ' + HERO_ORDER.filter((k) => HD[k]).length);
    if (rest.length) counts.push('首领 ' + rest.length);
    if (campaigns) counts.push('四雄 ' + (TowerData.CAMPAIGN_BOSSES || []).length);
    if (demon) counts.push('魔王 1');
    return '<div class="tower-buffs boss-catalog"><h4>BOSS 一览 <span class="buff-slot-count">' +
      counts.join(' · ') + '</span></h4>' + heroes +
      (rest.length
        ? '<b class="boss-group-title">首领<i>第 4 场 / 10 层守关</i></b>' +
          '<ol class="tower-plan boss-grid">' + rest.map((b, i) => {
            const tier = b.tier == null ? null : b.tier;

            const secret = !!b.secret;
            const tip = secret ? '？？？' : ((b.rarity ? '装备稀有度：' + b.rarity + '。' : '') + mechTip(b));
            const rarity = secret ? '？？？' : ((b.rarity || '') + '装备');
            return '<li class="' + (b.elite ? 'elite ' : '') + (b.squirrel ? 'squirrel ' : '') + (b.king ? 'king ' : '') +
              (tier == null ? '' : 'tier-' + tier) + '" tabindex="0" data-tip="' + esc(tip) + '">' +
              '<b>' + esc(b.name) + '</b>' +
              (b.type ? '<span class="tower-plan-type">' + esc(b.type) + '</span>' : '') +
              '<span class="boss-rarity' + (secret ? ' hidden' : ' r' + tier) + '">' + esc(rarity) + '</span>' +
              '</li>';
          }).join('') + '</ol>'
        : '') + campaigns + demon + '</div>';
  }
  // 左侧塔身：当前层附近的一段楼层，自上而下。
  // 注意 mode==='tower' 时，历史最高层以下是「已通关」，再上面才是「待爬」；
  // 无尽塔没有上限（maxLayer 传 0），所以整列都算「待爬」，不能标成已通关。
  function towerVisual(layer, maxLayer, mode) {

    const ABOVE = 8, BELOW = 4;
    const top = layer + ABOVE, bottom = Math.max(1, layer - BELOW);
    let floors = '';
    for (let i = top; i >= bottom; i--) {

      const done = mode === 'tower' && i !== layer && (i < layer || i <= maxLayer);
      const cls = done ? 'done' : i === layer ? 'now' : 'todo';
      floors += '<div class="tower-floor ' + cls + (i % 10 === 0 ? ' elite-floor' : i % 5 === 0 ? ' fifth-floor' : '') + '">' +
        (i === layer ? '<span class="tower-marker" aria-hidden="true"></span>' : '') +
        '<b class="tower-floor-no">' + i + '</b></div>';
    }
    return '<div class="tower-visual" aria-label="塔层进度"><div class="tower-floors">' + floors + '</div></div>';
  }
  function planHtml(preview, extraCls) {
    return '<ol class="tower-plan' + (extraCls || '') + '">' + preview.map((b, i) =>
      '<li class="' + (b.elite ? 'elite' : '') + (b.squirrel ? ' squirrel' : '') + '" tabindex="0" data-tip="' + esc(mechTip(b)) + '">' +
      '<span class="tower-plan-no">' + (i + 1) + '</span>' +
      foePortraitHtml(i, b) +
      '<b>' + esc(b.name) + '</b>' +
      (b.type ? '<span class="tower-plan-type">' + esc(b.type) + '</span>' : '') +
      (b.elite ? '<em class="elite-tag">精英</em>' : '') +
      '</li>').join('') + '</ol>';
  }



  function openTower(opts) {
    setTowerOrigin(opts);
    const info = Tower.towerInfo();
    let main, footer = null;
    if (info.run) {
      const run = info.run;
      main = '<div class="tower-head"><h2 class="tower-title">第 ' + run.layer + ' 层 · 第 ' + run.battleNo + '/' + run.battleCount + ' 场</h2>' +
        '<div class="tower-stats">已累积松果 <b class="gold-text">' + run.pot + '</b>（失败只保底 30%）</div></div>' +
        currencyHtml('tower') +
        // 环境词缀与「三侠削弱」都摆在这一屏（与无尽塔同一套组件）：
        // 环境是挑战塔里唯一会临时改变敌我数值的东西，第 5 层起可能在层内抽到；
        carryBar(run.curHp, run.curMaxHp, '血量', '', hpTip(run)) +
        envPanelHtml(run, { label: '当前环境' }) + debuffPanel(run.debuffs) + ownedBuffsHtml('tower') +
        '<div class="tower-actions">' + C().btn('继续战斗', 'fight', 'gold') + C().btn('放弃本层', 'abandon', 'muted small') + '</div>';
    } else {
      main = '<div class="tower-head"><h2 class="tower-title">挑战塔 · 第 ' + info.nextLayer + ' 层</h2>' +
        '<div class="tower-stats">目标等级 ' + info.level + ' · 强度 ×' + info.mult.toFixed(2) + ' · ' + info.battles + ' 场连战 · 通关金松果 <b class="gold-text">' + info.gold + '</b></div></div>' +
        currencyHtml('tower') +
        // 对手顺序每层随机 · 三侠大招会留削弱 · 第 5 层起有环境词缀 · 通关另补 3 场掉落」），

        envPreviewHtml(info.nextLayer) + heroDebuffPreviewHtml() +
        '<h4 class="tower-plan-title">本层对手预告</h4>' + planHtml(info.preview, ' horizontal');
      footer = '<div class="tower-actions tower-footer">' +
        '<span class="tower-book-count">现有挑战书 ' + info.books + ' 张</span>' +

        C().btn('开始挑战', 'fight', 'gold') + '</div>';
    }
    const content = '<div class="tower-page' + (footer ? ' has-footer' : '') + '">' + towerVisual(info.nextLayer, info.maxLayer, 'tower') +
      '<div class="tower-main">' + main + '</div>' + (footer || '') + '</div>';
    const ct = classicTower();
    const p = C().page('challenge', 'stages', content, ct
      ? { cls: 'tower-board', noTabs: true, noFooter: true, pageClass: 'classic-tower', above: classicTowerBar() }
      : { cls: 'tower-board' });
    bindTips(p);
    if (!info.run) { fillFoeArt(p, info.preview); fillClassicFoeArt(p, info.preview); }
    back(p, towerBack, ct ? (ONLINE ? '返回村庄' : '返回征战') : '返回');

    if (ct) applyClassicTowerBg(p, 'tower', info.run ? info.run.layer : info.nextLayer);
    on(p, 'fight', () => {
      if (info.run) {
        if (info.run.choices) { offerChoice('tower', info.run.choices); return; }
        fight('tower');
        return;
      }
      const started = Tower.startTowerRun();
      if (!started.ok) {
        notice(started.msg, started.needsBook ? [{ label: '买挑战书', run: () => UI.runAction('shop') }, { label: '返回', cls: 'gold' }] : undefined);
        return;
      }
      fight('tower');
    });
    on(p, 'abandon', () => {
      modal('放弃挑战', '<p>放弃后本局已累积的松果将全部失去（也没有安慰奖），确定吗？</p>', [
        { label: '放弃', cls: 'muted', run: () => { Tower.abandon('tower'); syncTickets(); openTower(); } },
        { label: '继续挑战', cls: 'gold' },
      ], { small: true });
    });
  }



  let heroSetupDraft = null;

  let heroPageCtrl = null;

  let heroSetupTab = 'status';
  let heroSetupPage = { weapon: 0, skill: 0 };

  function heroStatRules() {
    try {
      if (window.TowerHero && typeof TowerHero.statRules === 'function') return TowerHero.statRules();
    } catch (e) {  }
    return { floor: 55, cap: 85, total: 195, poolMax: 30,
      initial: { power: 65, agility: 65, speed: 65 } };
  }
  function heroAdjustStat(draft, key, dir) {
    if (window.TowerHero && typeof TowerHero.adjustStat === 'function') {
      return TowerHero.adjustStat(draft.stats, draft.statPool, key, dir);
    }
    return { ok: false, msg: '属性调整暂不可用。' };
  }
  // 准备页草稿：武技 / 外观 / 四维分配 / 可分配池。旧草稿缺字段时补默认值。
  function ensureHeroSetupDraft() {
    const initial = (window.TowerHero && TowerHero.initialStats) ? TowerHero.initialStats()
      : { power: 65, agility: 65, speed: 65 };
    if (!heroSetupDraft) heroSetupDraft = { picks: [], appearance: [null, null, null, null], stats: initial, statPool: 0 };
    const draft = heroSetupDraft;
    if (!Array.isArray(draft.picks)) draft.picks = [];

    draft.appearance = heroAppearanceSlots(draft.appearance);
    const rules = heroStatRules();
    const keys = ['power', 'agility', 'speed'];
    const src = (draft.stats && typeof draft.stats === 'object') ? draft.stats : initial;
    const values = {};
    let sum = 0, valid = true;
    for (const key of keys) {
      const n = Math.floor(Number(src[key]));
      if (!Number.isFinite(n) || n < rules.floor || n > rules.cap) { valid = false; break; }
      values[key] = n; sum += n;
    }
    if (!valid || !rules || sum > rules.total || sum < rules.total - rules.poolMax) {
      draft.stats = initial;
      draft.statPool = 0;
    } else {
      draft.stats = values;
      draft.statPool = Math.max(0, Math.min(rules.poolMax, rules.total - sum));
    }
    return draft;
  }
  // 无尽塔开局页选择的剧本：'default' = 常规无尽塔；'hero' = 勇者剧本。
  // 只影响「开始攀登」这一颗键的分流；选择本身不落存档（下次进页面回到默认剧本）。
  let endlessScript = 'default';

  function scriptPickerHtml() {
    // 经典常规剧本 + 勇者剧本都开放；挑战塔入口仍不出现。
    const hero = endlessScript === 'hero';
    const heroLabel = '勇者剧本 <em class="script-demo">DEMO</em>';
    const option = (key, label, desc) => '<button type="button" class="script-option' +
      (key === endlessScript ? ' is-active' : '') + '" role="option" aria-selected="' +
      (key === endlessScript ? 'true' : 'false') + '" data-script="' + key + '">' +
      '<b>' + label + '</b><small>' + desc + '</small></button>';
    return '<div class="endless-script-picker" data-script-picker>' +
      '<button type="button" class="uc-button hero-entry script-trigger" data-action="script-toggle"' +
      ' aria-haspopup="listbox" aria-expanded="false">' +
      '<span data-script-label>' + (hero ? heroLabel : '默认剧本') + '</span>' +
      '<span class="script-caret" aria-hidden="true">▾</span></button>' +
      '<div class="script-menu" role="listbox" aria-label="选择剧本" hidden>' +
      option('default', '默认剧本', '常规无尽塔') +
      option('hero', heroLabel, '开局调四维 · 局内成长') +
      '</div></div>';
  }
  const HERO_PARTS = ['头部', '拳套', '衣服', '鞋子'];
  const HERO_QUALITY = ['白', '绿', '蓝', '紫', '橙', '黑'];
  function heroCatalog() {
    return window.TowerHero && typeof TowerHero.catalog === 'function' ? TowerHero.catalog() : [];
  }
  function heroGrowthText(value) {
    if (typeof value === 'string') return value;
    return value && (value.label || value.msg || value.text) || '';
  }
  function heroLevelText(level) {
    const lv = Math.max(1, Math.round(Number(level) || 1));
    return lv > 10 ? '真' + (lv - 10) + '级' : 'Lv.' + lv;
  }
  function heroWsIcon(kind, id, size) {
    try {
      const n = Number(size) || 44;
      if (window.UI && typeof UI.weaponIcon === 'function' && kind === 'weapon') return UI.weaponIcon(Number(id), n);
      if (window.UI && typeof UI.skillIcon === 'function' && kind === 'skill') return UI.skillIcon(Number(id), n);
    } catch (e) { /* 素材入口没挂上也别让整页挂掉 */ }
    return '';
  }
  // 外观格走原版容器帧（`gear-frames.json` → 1919/1915/1909/1912 等符号），不请求静态 gear 图标。
  function heroGearIcon(id, size, tier) {
    const n = Number(size) || 48;
    const t = Math.max(1, Math.min(3, Number(tier) || 1));
    return '<span class="hero-gear-art" data-hero-gear-art="' + (Number(id) || 0) +
      '" data-hero-tier="' + t + '" aria-hidden="true" style="width:' + n + 'px;height:' + n + 'px"></span>';
  }
  const HERO_PART_CHAR = ['头', '拳', '衣', '鞋'];
  function heroGearName(id) {
    try { return C().gearName(Number(id)); } catch (e) { return '装备' + Number(id); }
  }


  function heroGearTypeOf(id) {
    const n = Number(id);
    if (!(n > 0)) return NaN;
    try {
      if (window.State && State.gearPart) {
        const type = Number(State.gearPart(n));
        // `State.gearPart` 对不在 gearMap 里的 q5 黑装上位 / 深海·机器猫返回 -1；
        // 不能把 -1 当成有效部位，继续从 GEAR_BASE 补真实 type。
        if (Number.isInteger(type) && type >= 0 && type <= 3) return type;
      }
    } catch (e) {}
    const rows = (window.GData && Array.isArray(GData.GEAR_BASE)) ? GData.GEAR_BASE : null;
    const row = rows ? rows.find((r) => Number(r && r[0]) === n) : null;
    return row ? Number(row[3]) : NaN;
  }
  // 外观 id / 运行中 hero.appearance → 7232 穿衣链路认识的 `{id,type,tier,quality,ext}`。
  // `tier` 是外观差分（1~3，原版头 / 拳套的强化档画稿），四个绘制入口都认它。
  function heroGearForPaint(appearance) {
    return (Array.isArray(appearance) ? appearance : []).map((raw) => {
      const item = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
      const id = Number(item.id);
      if (!(id > 0)) return null;
      const type = Number.isFinite(Number(item.type)) ? Number(item.type) : heroGearTypeOf(id);
      if (!Number.isFinite(type)) return null;
      const tier = Math.max(1, Math.min(3, Number(item.tier) || 1));
      const out = { id: id, type: type, tier: tier,
        ext: Array.isArray(item.ext) ? item.ext : [] };
      if (item.quality != null) out.quality = Number(item.quality) || 0;
      return out;
    }).filter(Boolean);
  }

  function heroAppearanceSlots(appearance) {
    const slots = [null, null, null, null];
    for (const raw of (Array.isArray(appearance) ? appearance : [])) {
      const item = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
      const id = Number(item.id);
      if (!(id > 0)) continue;
      const rawType = Number(item.type);
      const type = Number.isInteger(rawType) && rawType >= 0 && rawType <= 3 ? rawType : heroGearTypeOf(id);
      if (Number.isInteger(type) && type >= 0 && type <= 3 && !slots[type]) {
        slots[type] = { id: id, tier: Math.max(1, Math.min(3, Number(item.tier) || 1)) };
      }
    }
    return slots;
  }
  // 外观数据 → `Tower.setHeroAppearance` 要的对象数组（丢掉空格；带上差分档与品质）。
  // · ui-status 交回的 `[{id,type,tier}]` 列表（空部位被跳过，不能按下标当部位）。
  function heroAppearancePaint(appearance) {
    const slots = [null, null, null, null];
    (Array.isArray(appearance) ? appearance : []).forEach((raw, index) => {
      if (!raw) return;
      const item = (typeof raw === 'object') ? raw : { id: Number(raw) };
      const id = Math.max(0, Number(item.id) || 0);
      if (!(id > 0)) return;
      const typed = Number.isFinite(Number(item.type)) ? Number(item.type)
        : (index >= 0 && index < 4 ? index : NaN);
      if (!Number.isInteger(typed) || typed < 0 || typed > 3 || slots[typed]) return;
      slots[typed] = { id: id, tier: Math.max(1, Math.min(3, Number(item.tier) || 1)) };
    });
    const all = heroAllGear();
    const out = [];
    for (let part = 0; part < 4; part++) {
      const slot = slots[part];
      if (!slot) continue;
      const item = { id: slot.id, type: part, tier: slot.tier, ext: [] };

      const row = all.find((g) => Number(g.id) === slot.id);
      if (row) item.quality = Math.max(0, Math.min(5, Number(row.quality) || 0));

      if (isModernUi()) item.tier = 1;
      out.push(item);
    }
    return out;
  }

  function heroDraftStats(picks, stats) {
    const base = (window.TowerHero && TowerHero.CONFIG && TowerHero.CONFIG.base) ||
      { power: 65, agility: 65, speed: 65, maxHp: 800 };
    const chosen = (stats && typeof stats === 'object') ? stats : {};
    const pick = (key) => {
      const n = Number(chosen[key]);
      return Number.isFinite(n) ? n : base[key];
    };
    const out = { power: pick('power'), agility: pick('agility'), speed: pick('speed'), maxHp: base.maxHp };
    const level = Math.max(1, Number(window.TowerHero && TowerHero.CONFIG && TowerHero.CONFIG.startLevel) || 5);
    for (const it of (Array.isArray(picks) ? picks : [])) {
      if (!it || it.kind !== 'skill') continue;
      const key = { 1: 'power', 2: 'agility', 3: 'speed', 4: 'maxHp' }[Number(it.id)];
      if (key && window.GData && typeof GData.passiveBonus === 'function') {
        out[key] += Number(GData.passiveBonus(Number(it.id), level)) || 0;
      }
    }
    return out;
  }
  function heroStatsHtml(stats) {
    const rows = [['力量', 'power'], ['敏捷', 'agility'], ['速度', 'speed'], ['生命', 'maxHp']];
    return '<div class="hero-demo-stats">' + rows.map(([label, key]) =>
      '<div><span>' + label + '</span><b>' + esc(Math.max(0, Math.round(Number(stats && stats[key]) || 0))) + '</b></div>').join('') + '</div>';
  }

  function heroDraftStatsHtml(stats, draft) {
    const rules = heroStatRules();
    const pool = Math.max(0, Number(draft && draft.statPool) || 0);
    const rows = [['力', 'power'], ['敏', 'agility'], ['速', 'speed'], ['命', 'maxHp']];
    return rows.map(([label, key]) => {
      const value = Math.max(0, Math.round(Number(stats && stats[key]) || 0));
      if (key === 'maxHp') return '<div class="stat-pill"><b>' + label + '</b><span class="stat-value">' + value + '</span></div>';
      const base = Number(draft && draft.stats && draft.stats[key]) || 0;
      const up = pool > 0 && base < rules.cap;
      const down = base > rules.floor;
      return '<div class="stat-pill hero-stat-pill"><b>' + label + '</b><span class="stat-value">' + value + '</span>' +
        '<span class="hero-stat-arrows">' +
          '<button type="button" class="hero-stat-step" data-stat-step="' + key + ':up" aria-label="' + label + '加1"' + (up ? '' : ' disabled') + '>▲</button>' +
          '<button type="button" class="hero-stat-step" data-stat-step="' + key + ':down" aria-label="' + label + '减1"' + (down ? '' : ' disabled') + '>▼</button>' +
        '</span></div>';
    }).join('');
  }
  // 运行中勇者 → 查看状态用的“对手”快照（四维 + 武技 + 外观）。
  function heroFoeOf(hero) {
    if (!hero) return null;
    const fighter = window.TowerHero && TowerHero.fighter ? TowerHero.fighter(hero) : null;
    const base = (window.TowerHero && TowerHero.CONFIG && TowerHero.CONFIG.base) ||
      { power: 65, agility: 65, speed: 65, maxHp: 800 };
    const stats = fighter || base;
    return {
      name: '勇者', level: 1,
      power: Number(stats.power) || 0, agility: Number(stats.agility) || 0,
      speed: Number(stats.speed) || 0, hp: Number(stats.maxHp || stats.hp) || 0,
      maxHp: Number(stats.maxHp || stats.hp) || 0,
      gears: heroGearForPaint(hero.appearance),
      weapons: Array.isArray(hero.weapons) ? hero.weapons.slice() : [],
      skills: Array.isArray(hero.skills) ? hero.skills.slice() : [],
    };
  }
  // 全部装备按稀有度 → 套装 → 部位分组（外观 0 加成，只用于换装）。
  // 与深海 / 机器猫 q3）；`State.gearInst` 只用来补已登记装备的完整字段。
  const HERO_GEAR_PART_SUFFIX = /(头巾|头饰|头盔|护额|手套|拳套|拳甲|服|铠甲|衣服|短靴|鞋|头|拳)$/;

  const HERO_GEAR_DUP_SET_IDS = new Set([67, 68]);
  // 头 / 拳套的画稿跟着词条最高档变（原版 `constructBpData` 的
  // `tier` 记住玩家选的是哪一档（见 TowerHero.cleanAppearance / 各绘制入口）。
  const HERO_GEAR_SINGLE_TIER_SETS = new Set([46, 47, 48, 49, 50, 51, 52, 53, 67, 68, 69, 70, 71, 72]);
  const HERO_GEAR_TIER_CAPS = new Map([[126, 2], [142, 2]]);

  function heroGearSetIndexOf(item) {
    const row = item || {};
    const id = Math.max(0, Number(row.id) || 0);
    let setId = Number(row.setId);
    if (!(setId > 0) && id > 0) {
      try {
        const inst = State.gearInst ? State.gearInst(id) : null;
        setId = Number(inst && inst.setId) || 0;
      } catch (e) { setId = 0; }
      if (!(setId > 0)) {
        const rows = (window.GData && Array.isArray(GData.GEAR_BASE)) ? GData.GEAR_BASE : null;
        const base = rows ? rows.find((r) => Number(r && r[0]) === id) : null;
        setId = Number(base && base[1]) || 0;
      }
    }
    if (!(setId > 0)) return NaN;
    try {
      const set = window.gearSetMap && gearSetMap.getValue(String(setId));
      return set ? Number(set.index) : NaN;
    } catch (e) { return NaN; }
  }
  function isModernUi() {
    try { return !!(window.UI && UI.currentUiMode && UI.currentUiMode() === 'modern'); } catch (e) { return false; }
  }
  function heroGearTierCount(item) {
    const type = Number(item && item.type);
    if (type !== 0 && type !== 1) return 1;

    if (isModernUi()) return 1;
    if (HERO_GEAR_SINGLE_TIER_SETS.has(Number(item && item.setId))) return 1;
    const cap = HERO_GEAR_TIER_CAPS.get(Number(item && item.id));
    if (cap) return cap;
    const q = Math.max(0, Math.min(5, Number(item && item.quality) || 0));
    return q <= 1 ? 1 : q === 2 ? 2 : 3;
  }
  function heroGearTiers(item) {
    const n = heroGearTierCount(item);
    return Array.from({ length: n }, (_, i) => i + 1);
  }


  function heroGearVisible(item) {
    if (!isModernUi()) return true;
    try {
      if (!(window.UI && UI.classic && typeof UI.classic.gearIconId === 'function')) return true;
      return UI.classic.gearIconId(item) > 0;
    } catch (e) { return true; }
  }
  function heroGearCatalog() {
    const rows = [];
    if (!window.State || !State.gearInst) return [];
    const base = (window.GData && Array.isArray(GData.GEAR_BASE)) ? GData.GEAR_BASE : null;
    if (base && base.length) {
      for (const row of base) {
        const id = Number(row && row[0]);
        if (!(id > 0)) continue;
        let inst = null;
        try { inst = State.gearInst(id); } catch (e) { inst = null; }
        const name = String((inst && inst.name) || row[4] || '');
        const type = Number(inst && inst.type != null ? inst.type : row[3]);
        if (!Number.isInteger(type)) continue;
        const quality = Math.max(0, Math.min(5,
          Number(inst && inst.quality != null ? inst.quality : row[2]) || 0));
        const setId = Number(inst && inst.setId != null ? inst.setId : row[1]) || 0;
        const family = (State.gearSetFamily ? State.gearSetFamily(id) : '') ||
          name.replace(HERO_GEAR_PART_SUFFIX, '') || ('套装 ' + setId);
        const item = { id: id, name: name, type: type, quality: quality, setId: setId, family: family };
        item.tiers = heroGearTiers(item);
        if (!heroGearVisible(item)) continue;
        rows.push(item);
      }
    } else {
      if (!window.gearMap || typeof gearMap.each !== 'function') return [];
      gearMap.each((key, row) => {
        const id = Number(row && row.id != null ? row.id : key);
        const gear = State.gearInst(id);
        if (!gear || !Number.isInteger(Number(gear.type))) return;
        const item = { id: id, name: gear.name || '', type: Number(gear.type),
          quality: Math.max(0, Math.min(5, Number(gear.quality) || 0)), setId: Number(gear.setId) || 0,
          family: (State.gearSetFamily ? State.gearSetFamily(id) : '') || ('套装 ' + (Number(gear.setId) || 0)) };
        item.tiers = heroGearTiers(item);
        if (!heroGearVisible(item)) return;
        rows.push(item);
      });
    }
    // 合并重复黑装套（见 HERO_GEAR_DUP_SET_IDS）：否则外观页会显示两套一模一样的
    for (let i = rows.length - 1; i >= 0; i--) {
      if (HERO_GEAR_DUP_SET_IDS.has(rows[i].setId)) rows.splice(i, 1);
    }
    rows.sort((a, b) => (b.quality - a.quality) || (a.setId - b.setId) || (a.type - b.type) || (a.id - b.id));
    const groups = [];
    for (const item of rows) {
      let group = groups[groups.length - 1];
      if (!group || group.quality !== item.quality) {
        group = { quality: item.quality, label: HERO_QUALITY[item.quality] || '特殊', sets: [] };
        groups.push(group);
      }
      let set = group.sets[group.sets.length - 1];
      if (!set || set.setId !== item.setId) {
        set = { setId: item.setId, family: item.family, items: [] };
        group.sets.push(set);
      }
      set.items.push(item);
    }

    for (const group of groups) {
      const seen = new Map();
      for (const set of group.sets) seen.set(set.family, (seen.get(set.family) || 0) + 1);
      for (const set of group.sets) {
        if (seen.get(set.family) > 1) set.label = set.family + ' · 套' + set.setId;
      }
    }
    return groups;
  }
  // 一格外观 → `{id, tier}`（兼容老调用直接塞 id / 0 的情况）。
  function heroGearSlotOf(slots, part) {
    const raw = Array.isArray(slots) ? slots[part] : null;
    if (raw && typeof raw === 'object') {
      const id = Math.max(0, Number(raw.id) || 0);
      return id > 0 ? { id: id, tier: Math.max(1, Math.min(3, Number(raw.tier) || 1)) } : null;
    }
    const id = Math.max(0, Number(raw) || 0);
    return id > 0 ? { id: id, tier: 1 } : null;
  }

  function heroGearCardHtml(item, tier, equipped) {
    const title = item.name + ' · ' + (HERO_QUALITY[item.quality] || '') + '装 · ' +
      (HERO_PARTS[item.type] || '') + (tier > 1 ? ' · 外观差分 ' + tier : '') + ' · 仅外观';
    return '<button type="button" class="hero-gear-item' + (equipped ? ' is-equipped' : '') + '"' +
      ' data-hero-gear="' + item.id + '" data-gear-part="' + item.type + '" data-hero-tier="' + tier + '"' +
      ' aria-pressed="' + (equipped ? 'true' : 'false') + '" title="' + esc(title) + '">' +
      '<span class="hero-gear-icon" data-part="' + esc(HERO_PART_CHAR[item.type] || '装') + '">' + heroGearIcon(item.id, 48, tier) + '</span>' +
      '<b>' + esc(item.name) + '</b><i>' + esc(HERO_PARTS[item.type] || '') + '</i>' +
      '<span class="hero-gear-zero">0 加成</span></button>';
  }
  // 全部装备的分组网格（准备页的「更换装备」与爬塔中的装备选择层共用这一份）。
  // ⚠ 所有卡片都写「0 加成」：勇者模式的外观件不参与数值，别在这里接属性。
  function heroGearGroupsHtml(slots, groups) {
    const list = groups || heroGearCatalog();
    if (!list.length) return '<p class="hero-status-empty">装备字典还没有加载。</p>';
    return list.map((group) =>
      '<section class="hero-gear-rarity q' + group.quality + '"><h4>' + esc(group.label) + '装' +
        '<span>' + group.sets.length + ' 套</span></h4>' +
        group.sets.map((set) => '<div class="hero-gear-set"><h5>' + esc(set.label || set.family) + '</h5>' +
          '<div class="hero-gear-parts">' + set.items.map((item) => {
            const slot = heroGearSlotOf(slots, item.type);
            return (item.tiers || [1]).map((tier) => heroGearCardHtml(item, tier,
              !!slot && slot.id === Number(item.id) && slot.tier === tier)).join('');
          }).join('') + '</div></div>').join('') +
      '</section>').join('');
  }

  function heroAllGear() {
    const out = [];
    for (const group of heroGearCatalog()) {
      for (const set of group.sets) {

        for (const item of set.items) out.push(Object.assign({}, item, {
          setLabel: set.label || set.family, setFamily: set.family,
          tiers: (item.tiers || [1]).slice(),
        }));
      }
    }
    return out;
  }

  async function paintHeroArtModern(host, appearance, opts) {
    const o = opts || {};
    const token = (host.__heroArtSeq = (Number(host.__heroArtSeq) || 0) + 1);
    const old = host.__heroView;
    host.__heroView = null;
    if (old) { try { old.destroy(); } catch (e) {} }
    if (host.classList) host.classList.remove('ready');
    host.innerHTML = '';
    try {
      const sheets = ['SQ_01', 'SQ_02'];
      await Engine.loadSheets(sheets);
      if (host.__heroArtSeq !== token || host.isConnected === false) return null;
      const frames = Engine.anim('standby');
      if (!frames || !frames.length) return null;
      const frame = frames[0];
      const box = Engine.frameBounds(frame, { sheets: sheets, exclude: ['54', '75', '91', '20001'] });
      if (!box || !(box.w > 0) || !(box.h > 0)) return null;
      const canvas = document.createElement('canvas');
      const rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
      const cssW = Math.max(1, Math.round((rect && rect.width) || host.clientWidth || o.width || 160));
      const cssH = Math.max(1, Math.round((rect && rect.height) || host.clientHeight || o.height || cssW));
      const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
      const size = Math.max(128, Math.min(640, Math.round(Math.max(cssW, cssH) * dpr)));
      canvas.width = canvas.height = size;
      canvas.className = 'modern-hero-art';
      canvas.style.width = '100%'; canvas.style.height = '100%';
      canvas.style.display = 'block';
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return null;
      const pad = Math.max(2, Math.min(14, Number(o.pad) || 5));
      const zoom = Number(o.zoom) || 1.04;
      const scale = Math.min((size - pad * 2) / box.w, (size - pad * 2) / box.h) * zoom;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.setTransform(scale, 0, 0, scale,
        size / 2 - (box.x + box.w / 2) * scale, size / 2 - (box.y + box.h / 2) * scale);
      Engine.drawFrame(ctx, frame, { sheets: sheets });
      host.appendChild(canvas);
      host.classList.add('ready');
      return { canvas: canvas, destroy: () => { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); } };
    } catch (e) {
      if (window.__errs) window.__errs.push('modern hero art: ' + (e && e.message));
      return null;
    }
  }

  async function paintHeroArt(host, appearance, opts) {
    if (!host) return null;
    if (isModernUi() && window.Engine) {
      const modern = await paintHeroArtModern(host, appearance, opts);
      if (modern) return modern;
      // 现代图集没挂上 / 画失败时退回经典元件，至少不要留一块空白。
    }
    const token = (host.__heroArtSeq = (Number(host.__heroArtSeq) || 0) + 1);
    const old = host.__heroView;
    host.__heroView = null;
    if (old) { try { old.destroy(); } catch (e) {} }
    if (host.classList) host.classList.remove('ready');
    host.innerHTML = '';
    try {
      const v = await mountClassicSquirrel(host, { gear: heroGearForPaint(appearance) },
        Object.assign({ label: '勇者' }, opts || {}));
      if (!v) return null;
      if (host.__heroArtSeq !== token || host.isConnected === false) { try { v.destroy(); } catch (e) {} return null; }
      host.__heroView = v;
      return v;
    } catch (e) {
      if (window.__errs) window.__errs.push('hero art: ' + (e && e.message));
      return null;
    }
  }

  function heroPortraitButtonHtml(run) {
    if (!run || run.ruleset !== 'hero' || !run.hero) return '';
    return '<button type="button" class="endless-hero-portrait" data-action="hero-status" ' +
      'title="查看勇者武技" aria-label="查看勇者武技">' +
      '<span class="endless-hero-portrait-art" data-hero-portrait="small" aria-hidden="true"></span>' +
      '<b>勇者</b></button>';
  }
  function heroLoadoutRows(hero) {
    const lines = { weapon: [], skill: [] };
    for (const kind of ['weapon', 'skill']) {
      const list = Array.isArray(hero[kind === 'weapon' ? 'weapons' : 'skills']) ? hero[kind === 'weapon' ? 'weapons' : 'skills'] : [];
      for (const raw of list) {
        const parts = String(raw).split(':'), id = Number(parts[0]), level = Math.max(1, Number(parts[1]) || 1);
        const inst = kind === 'weapon'
          ? (State.weaponInst ? State.weaponInst(id) : null) : (State.skillInst ? State.skillInst(id) : null);
        const trueMul = window.TowerHero && TowerHero.trueBaseMulFor
          ? TowerHero.trueBaseMulFor(kind, id, level)
          : (window.TowerHero && TowerHero.trueBaseMul ? TowerHero.trueBaseMul(level) : 1);
        lines[kind].push('<li><span class="hero-status-ws-icon">' + heroWsIcon(kind, id, 36) + '</span>' +
          '<b>' + esc((inst && inst.name) || ((kind === 'weapon' ? '武器 ' : '技能 ') + id)) + '</b>' +
          '<em>' + esc(heroLevelText(level)) + (trueMul > 1 ? ' · 白值×' + trueMul : '') + '</em></li>');
      }
    }
    return lines;
  }
  function heroStatusHtml(hero, run) {
    const foe = heroFoeOf(hero) || {};
    const lines = heroLoadoutRows(hero);
    const paintGears = heroGearForPaint(hero.appearance);
    const gearRows = HERO_PARTS.map((label, part) => {
      const g = paintGears.find((x) => Number(x && x.type) === part);
      return '<span class="hero-status-gear-slot"><i>' + label + '</i>' +
        '<b>' + esc(g ? heroGearName(g.id) : '未穿戴') + '</b><em>0 加成</em></span>';
    }).join('');
    const hp = run && Number(run.curMaxHp) > 0
      ? '<span class="hero-status-hp">当前血量 ' + Math.max(0, Math.round(Number(run.curHp) || 0)) +
        ' / ' + Math.max(1, Math.round(Number(run.curMaxHp) || 1)) + '</span>' : '';
    const log = (Array.isArray(hero.log) ? hero.log : []).slice(-4).reverse().map(heroGrowthText).filter(Boolean);
    const list = (kind, title, empty) => '<section class="hero-status-loadout"><h4>' + title + ' <span>' +
      lines[kind].length + '</span></h4>' + (lines[kind].length
        ? '<ul' + (lines[kind].length > 4 ? ' class="is-many"' : '') + '>' + lines[kind].join('') + '</ul>'
        : '<p class="hero-status-empty">' + empty + '</p>') + '</section>';
    return '<div class="hero-status-card">' +
      '<div class="hero-status-side"><div class="hero-status-portrait"><span data-hero-status-art aria-hidden="true"></span></div>' +
      '<div class="hero-status-name">勇者</div>' + hp + '</div>' +
      '<div class="hero-status-main">' + heroStatsHtml(foe) +
      '<p class="hero-base-note">四维在开局时分配；每通过 5 层额外获得 生命上限 +50、力/敏/速 +5。不继承账号、套装或幻兽加成，外观装备只改变造型、属性 0 加成。</p>' +
      '<div class="hero-status-gears">' + gearRows + '</div>' +
      '<div class="hero-status-loadouts">' + list('weapon', '武器', '空手') + list('skill', '技能', '尚未学习') + '</div>' +
      '<section class="hero-status-log"><h4>成长记录</h4>' + (log.length
        ? '<ol>' + log.map((text) => '<li>' + esc(text) + '</li>').join('') + '</ol>'
        : '<p class="hero-status-empty">每场胜利后获得一次勇者成长。</p>') + '</section>' +
      '</div></div>';
  }

  function openHeroStatusModern(tab) {
    const info = Tower.endlessInfo();
    const run = info && info.run;
    if (!run || run.ruleset !== 'hero' || !run.hero) { notice('当前不是勇者模式。'); return; }
    const fighter = window.TowerHero && TowerHero.fighter ? TowerHero.fighter(run.hero) : null;
    const blade = Tower.heroBladeOf ? Tower.heroBladeOf() : null;
    const hero = {
      mode: 'run',
      stats: fighter || { power: 65, agility: 65, speed: 65, maxHp: 800 },
      weapons: (run.hero.weapons || []).slice(),
      skills: (run.hero.skills || []).slice(),
      // 只读详情要显示失败保底后的实时成功率：context 必须带上本局失败计数，
      upgradeFails: Object.assign({}, run.hero.upgradeFails || {}),

      appearance: heroGearForPaint(run.hero.appearance).map((g) => Object.assign({}, g)),
      wins: Math.max(0, Number(run.hero.wins) || 0),
      patrolWins: Math.max(0, Number(run.hero.patrolWins) || 0),
      uncapped: window.TowerHero && TowerHero.uncappedCount ? TowerHero.uncappedCount(run.hero) : 0,
      log: (Array.isArray(run.hero.log) ? run.hero.log : []).slice(),
      coins: Math.max(0, Number(run.retryToken) || 0),
      hp: { hp: Math.max(0, Math.round(Number(run.curHp) || 0)), maxHp: Math.max(1, Math.round(Number(run.curMaxHp) || 1)) },
      blade: blade,
      onCoinTrain: (ref) => {
        const out = Tower.coinTrainHero ? Tower.coinTrainHero(ref) : { ok: false, msg: '铸币修炼暂不可用。' };
        if (out && out.ok) {
          const latest = Tower.endlessInfo();
          const r = latest && latest.run;
          if (r) {
            hero.coins = Math.max(0, Number(r.retryToken) || 0);
            hero.hp = { hp: Math.max(0, Math.round(Number(r.curHp) || 0)), maxHp: Math.max(1, Math.round(Number(r.curMaxHp) || 1)) };
            hero.stats = (window.TowerHero && TowerHero.fighter) ? (TowerHero.fighter(r.hero) || hero.stats) : hero.stats;
            hero.weapons = (r.hero.weapons || []).slice();
            hero.skills = (r.hero.skills || []).slice();
            hero.upgradeFails = Object.assign({}, r.hero.upgradeFails || {});
            hero.log = (Array.isArray(r.hero.log) ? r.hero.log : []).slice();
            if (Tower.heroBladeOf) hero.blade = Tower.heroBladeOf();
          }
          runToast(out.msg);
        }
        return out;
      },

      gearList: heroAllGear(),
      onEquip: (slots) => {
        const next = heroAppearancePaint(slots);
        const res = window.Tower && Tower.setHeroAppearance ? Tower.setHeroAppearance(next) : null;
        if (!res || !res.ok) return res || { ok: false, msg: '外观保存失败。' };
        hero.appearance = (res.appearance || []).map((g) => Object.assign({}, g));
        return { ok: true, appearance: hero.appearance };
      },
      onGears: () => {
        openHeroGearPicker({
          slots: heroAppearanceSlots(hero.appearance),
          onChange: (next) => {
            const res = window.Tower && Tower.setHeroAppearance
              ? Tower.setHeroAppearance(heroAppearancePaint(next)) : null;
            if (!res || !res.ok) { notice((res && res.msg) || '外观保存失败。'); return; }
            hero.appearance = (res.appearance || []).map((g) => Object.assign({}, g));
            if (heroPageCtrl && heroPageCtrl.refresh) heroPageCtrl.refresh();
          },
        });
      },
      onBack: () => { closeHeroGearPicker(); heroPageCtrl = null; openEndless(); },
    };
    closeHeroGearPicker();
    if (!C() || typeof C().openHeroPage !== 'function') { openHeroStatusDom(); return; }
    heroPageCtrl = C().openHeroPage(hero, { tab: tab === 'skills' ? 'skills' : 'status' });
  }

  function openHeroStatus(tab) {
    const info = Tower.endlessInfo();
    const run = info && info.run;
    if (!run || run.ruleset !== 'hero' || !run.hero) { notice('当前不是勇者模式。'); return; }
    if (classicHeroUi()) { openHeroStatusClassic(tab); return; }
    openHeroStatusModern(tab);
  }
  function openHeroStatusDom() {
    const info = Tower.endlessInfo();
    const run = info && info.run;
    if (!run || run.ruleset !== 'hero' || !run.hero) { notice('当前不是勇者模式。'); return; }
    const hero = run.hero;
    const m = modal('勇者 · 状态', heroStatusHtml(hero, run), [{ label: '返回', cls: 'gold' }]);
    if (m && m.element) {
      m.element.classList.add('hero-status-modal');
      paintHeroArt(find(m.element, '[data-hero-status-art]'), hero.appearance, { label: '勇者', pad: 8 });
    }
  }

  function openHeroStatusClassic(tab) {
    const info = Tower.endlessInfo();
    const run = info && info.run;
    if (!run || run.ruleset !== 'hero' || !run.hero) { notice('当前不是勇者模式。'); return; }
    const fighter = window.TowerHero && TowerHero.fighter ? TowerHero.fighter(run.hero) : null;
    const hero = {
      mode: 'run',
      stats: fighter || { power: 65, agility: 65, speed: 65, maxHp: 800 },
      appearance: (run.hero.appearance || []).map((g) => Object.assign({}, g)),
      weapons: (run.hero.weapons || []).slice(),
      skills: (run.hero.skills || []).slice(),
      upgradeFails: Object.assign({}, run.hero.upgradeFails || {}),
      wins: Math.max(0, Number(run.hero.wins) || 0),
      patrolWins: Math.max(0, Number(run.hero.patrolWins) || 0),
      uncapped: window.TowerHero && TowerHero.uncappedCount ? TowerHero.uncappedCount(run.hero) : 0,
      blade: Tower.heroBladeOf ? Tower.heroBladeOf() : null,
      coins: Math.max(0, Number(run.retryToken) || 0),
      onCoinTrain: (ref) => {
        const out = Tower.coinTrainHero ? Tower.coinTrainHero(ref) : { ok: false, msg: '铸币修炼暂不可用。' };
        if (out && out.ok) {
          const latest = Tower.endlessInfo(), r = latest && latest.run;
          if (r) {
            hero.coins = Math.max(0, Number(r.retryToken) || 0);
            hero.weapons = (r.hero.weapons || []).slice();
            hero.skills = (r.hero.skills || []).slice();
            hero.upgradeFails = Object.assign({}, r.hero.upgradeFails || {});
            hero.stats = (window.TowerHero && TowerHero.fighter) ? (TowerHero.fighter(r.hero) || hero.stats) : hero.stats;
            hero.log = (Array.isArray(r.hero.log) ? r.hero.log : []).slice();
            if (Tower.heroBladeOf) hero.blade = Tower.heroBladeOf();
          }
          runToast(out.msg);
        }
        return out;
      },

      gearList: heroAllGear(),
      onEquip: (next) => {

        const res = window.Tower && Tower.setHeroAppearance ? Tower.setHeroAppearance(heroAppearancePaint(next)) : null;
        if (!res || !res.ok) { notice((res && res.msg) || '外观保存失败。'); return null; }
        return (res.appearance || []).map((g) => Object.assign({}, g));
      },
      onGears: () => {
        openHeroGearPicker({
          slots: heroAppearanceSlots(hero.appearance),
          onChange: (next) => {
            const res = window.Tower && Tower.setHeroAppearance
              ? Tower.setHeroAppearance(heroAppearancePaint(next)) : null;
            if (!res || !res.ok) { notice((res && res.msg) || '外观保存失败。'); return; }
            hero.appearance = (res.appearance || []).map((g) => Object.assign({}, g));
            if (SfStatus.refresh) SfStatus.refresh();
          },
        });
      },
      onBack: () => { closeHeroGearPicker(); try { SfStatus.destroy(); } catch (e) {} openEndless(); },
    };
    closeHeroGearPicker();
    const p = SfStatus.openHero(hero, { overlay: true, label: '勇者', tab: tab === 'skills' ? 'skills' : 'status' });
    if (p && typeof p.then === 'function') {
      p.then((ok) => { if (!ok) openHeroStatusDom(); }).catch((e) => {
        if (window.__errs) window.__errs.push('hero status classic: ' + (e && e.message));
        openHeroStatusDom();
      });
    }
  }

  function closeHeroGearPicker() {
    const el = heroGearPickerEl;
    heroGearPickerEl = null;
    stopHeroGearArt(el);
    if (el && typeof el.__close === 'function') el.__close();
    else if (el && el.parentNode) el.parentNode.removeChild(el);

    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('[data-hero-gear-picker]').forEach((node) => node.remove());
  }
  // 勇者模式的外观装备选择层：全部装备按稀有度 → 套装 → 部位排；全部 0 加成。
  // `slots` = `[{id,tier}]`（也兼容旧调用直接给 id 数组），`onChange` 回传同样四格。
  // ⚠ 挂到 `document.body`、用 `position:fixed`：状态页宿主在 `#ui` 里，
  function openHeroGearPicker(opts) {
    const o = opts || {};
    closeHeroGearPicker();
    const groups = heroGearCatalog();
    const slots = [0, 1, 2, 3].map((part) => heroGearSlotOf(o.slots, part));
    const el = document.createElement('div');
    el.className = 'hero-gear-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '更换装备');
    el.innerHTML = '<div class="hero-gear-picker-panel">' +
      '<header class="hero-gear-picker-head"><div><h3>更换装备</h3>' +
        '<p>全部装备按稀有度 → 套装 → 部位排列；每件都是 <b>0 加成</b>，只改变外观。' +
        (isModernUi()
          ? '现代模式每件装备只列一张卡，点一下穿上、再点一下脱下。'
          : '头 / 拳套会按原版画稿列出 2~3 张同名卡（随词条档变化），点哪张穿哪张。') + '</p></div>' +
        '<span class="hero-gear-picker-total">共 ' +
          groups.reduce((n, g) => n + g.sets.reduce((m, s) => m + s.items.reduce((k, it) => k + (it.tiers || [1]).length, 0), 0), 0) + ' 款</span></header>' +
      '<div class="hero-gear-picker-slots" data-hero-gear-slots></div>' +
      '<div class="hero-gear-picker-scroll">' + heroGearGroupsHtml(slots, groups) + '</div>' +
      '<footer class="hero-gear-picker-foot"><span>点一下穿上，再点一下脱下；同一部位只保留一件。</span>' +
        '<button type="button" class="hero-gear-picker-back" data-hero-gear-close>返回</button></footer>' +
      '</div>';
    el.setAttribute('data-hero-gear-picker', '');
    document.body.appendChild(el);
    heroGearPickerEl = el;
    hydrateHeroGearArt(el);
    const slotsHost = el.querySelector('[data-hero-gear-slots]');
    const paintSlots = () => {
      if (!slotsHost) return;
      slotsHost.innerHTML = HERO_PARTS.map((label, part) => {
        const slot = heroGearSlotOf(slots, part);
        return '<span class="hero-gear-slot"><i>' + esc(label) + '</i><b>' +
          esc(slot ? heroGearName(slot.id) : '未穿戴') + '</b><em>0 加成</em></span>';
      }).join('');
    };
    const sync = () => {
      el.querySelectorAll('[data-hero-gear]').forEach((btn) => {
        const part = Number(btn.dataset.gearPart), tier = Number(btn.dataset.heroTier) || 1;
        const slot = heroGearSlotOf(slots, part);
        btn.classList.toggle('is-equipped',
          !!slot && slot.id === Number(btn.dataset.heroGear) && slot.tier === tier);
        btn.setAttribute('aria-pressed', btn.classList.contains('is-equipped') ? 'true' : 'false');
      });
      paintSlots();
    };
    el.querySelectorAll('[data-hero-gear]').forEach((btn) => {
      btn.onclick = () => {
        const id = Number(btn.dataset.heroGear), part = Number(btn.dataset.gearPart);
        const tier = Math.max(1, Math.min(3, Number(btn.dataset.heroTier) || 1));
        if (!(id > 0) || !Number.isInteger(part) || part < 0 || part > 3) return;
        const now = heroGearSlotOf(slots, part);

        slots[part] = now && now.id === id && now.tier === tier ? null : { id: id, tier: tier };
        sync();
        if (o.onChange) o.onChange(slots.map((s) => (s ? { id: s.id, tier: s.tier } : null)));
      };
    });
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
    const close = () => {
      stopHeroGearArt(el);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (heroGearPickerEl === el) heroGearPickerEl = null;
      document.removeEventListener('keydown', onKey, true);
      if (o.onClose) o.onClose();
    };
    el.__close = close;
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (ev) => { if (ev.target === el) close(); });
    const back = el.querySelector('[data-hero-gear-close]');
    if (back) back.onclick = close;
    paintSlots();
    const first = el.querySelector('[data-hero-gear]');
    if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
    return el;
  }

  function openHeroSetupClassic(opts) {
    const draft = heroSetupDraft;
    const hero = {
      mode: 'setup',
      stats: () => heroDraftStats(draft.picks, draft.stats),
      picks: draft.picks.map((it) => Object.assign({}, it)),
      appearance: heroAppearancePaint(draft.appearance),
      wins: 0,

      statState: () => ({
        values: Object.assign({}, draft.stats),
        pool: Math.max(0, Number(draft.statPool) || 0),
        rules: heroStatRules(),
      }),
      adjustStat: (key, dir) => {
        const out = heroAdjustStat(draft, key, dir);
        if (!out.ok) { if (window.UI && UI.toast) UI.toast(out.msg); return out; }
        draft.stats = out.values;
        draft.statPool = out.pool;
        return out;
      },

      gearList: heroAllGear(),
      onEquip: (next) => {
        // ui-status 交回的是扁平外观列表（空部位被跳过，元素带 type），
        // 不能按下标当部位 —— 否则连点几件同一部位会依次塞进头/手/身/脚四格
        draft.appearance = heroAppearanceSlots(next);
        hero.appearance = heroAppearancePaint(draft.appearance);
        return hero.appearance;
      },
      onPicks: (list) => { draft.picks = list.map((it) => ({ kind: it.kind, id: Number(it.id) })); },
      onGears: () => {
        openHeroGearPicker({
          slots: draft.appearance.slice(),
          onChange: (next) => {
            draft.appearance = heroAppearanceSlots(next);
            // 状态页里的 `hero.appearance` 是开局时拷的一份快照；装备层改的是草稿，
            // 必须同步回这一份，否则关掉选择层后立绘还是旧外观。
            hero.appearance = heroAppearancePaint(draft.appearance);
            if (SfStatus.refresh) SfStatus.refresh();
          },
        });
      },
      onStart: () => startHeroRunFromSetup(),
      onBack: () => { closeHeroGearPicker(); try { SfStatus.destroy(); } catch (e) {} openEndless(); },
    };
    closeHeroGearPicker();
    const p = SfStatus.openHero(hero, { overlay: false, label: '勇者准备' });
    if (p && typeof p.then === 'function') {
      p.then((ok) => {
        if (!ok) { openHeroSetupDom(opts); return; }
      }).catch((e) => {
        if (window.__errs) window.__errs.push('hero setup classic: ' + (e && e.message));
        openHeroSetupDom(opts);
      });
    }
  }

  function startHeroRunFromSetup() {
    const draft = heroSetupDraft;
    if (!draft || draft.picks.length !== 3) { notice('请点亮 3 个起始武技。'); return; }
    const pool = Math.max(0, Number(draft.statPool) || 0);
    if (pool > 0) { notice('还有 ' + pool + ' 点可分配，先把力/敏/速分配完再加入。'); return; }
    const options = { ruleset: 'hero', hero: {
      picks: draft.picks.map((item) => Object.assign({}, item)),
      appearance: heroAppearancePaint(draft.appearance),
      stats: Object.assign({}, draft.stats),
    } };
    closeHeroGearPicker();
    try { if (window.SfStatus && SfStatus.destroy) SfStatus.destroy(); } catch (e) {}
    if (beginEndlessRun(options)) heroSetupDraft = null;
    else setTimeout(() => { if (!Tower.endlessInfo().run) openHeroSetup(); }, 30);
  }

  function openHeroSetupModern(opts) {
    if (Tower.endlessInfo().run) { openEndless(); return; }
    const draft = ensureHeroSetupDraft();
    const hero = {
      mode: 'setup',
      stats: () => heroDraftStats(draft.picks, draft.stats),
      picks: draft.picks.map((it) => Object.assign({}, it)),
      appearance: heroAppearancePaint(draft.appearance),
      statState: () => ({
        values: Object.assign({}, draft.stats),
        pool: Math.max(0, Number(draft.statPool) || 0),
        rules: heroStatRules(),
      }),
      onAdjustStat: (key, dir) => {
        const out = heroAdjustStat(draft, key, dir);
        if (!out.ok) { if (window.UI && UI.toast) UI.toast(out.msg); return out; }
        draft.stats = out.values;
        draft.statPool = out.pool;
        return out;
      },
      onPicks: (list) => {
        draft.picks = list.map((it) => ({ kind: it.kind, id: Number(it.id) }));
        hero.picks = draft.picks.map((it) => Object.assign({}, it));
      },
      gearList: heroAllGear(),
      onEquip: (slots) => {
        draft.appearance = heroAppearanceSlots(slots);
        hero.appearance = heroAppearancePaint(draft.appearance);
        return { ok: true, appearance: hero.appearance };
      },
      onGears: () => {
        openHeroGearPicker({
          slots: draft.appearance.slice(),
          onChange: (next) => {
            draft.appearance = heroAppearanceSlots(next);
            hero.appearance = heroAppearancePaint(draft.appearance);
            if (heroPageCtrl && heroPageCtrl.refresh) heroPageCtrl.refresh();
          },
        });
      },
      onStart: () => startHeroRunFromSetup(),
      onBack: () => { closeHeroGearPicker(); heroPageCtrl = null; openEndless(); },
    };
    closeHeroGearPicker();
    if (!C() || typeof C().openHeroPage !== 'function') { openHeroSetupDom(opts); return; }
    heroPageCtrl = C().openHeroPage(hero, { tab: 'status' });
  }
  function openHeroSetup(opts) {
    setTowerOrigin(opts);

    endlessScript = 'hero';
    if (Tower.endlessInfo().run) { openEndless(); return; }
    if (!window.TowerHero || !TowerHero.CONFIG) { notice('勇者模式尚未加载，请刷新后重试。'); return; }
    ensureHeroSetupDraft();

    heroSetupTab = 'status';
    heroSetupPage = { weapon: 0, skill: 0 };
    if (classicHeroUi()) { openHeroSetupClassic(opts); return; }
    openHeroSetupModern(opts);
  }
  // 准备页只切 `hidden` 属性（不碰元素上的业务字段）。
  function heroNodeHidden(node, on) {
    if (!node) return;
    try {
      if (on) { if (node.setAttribute) node.setAttribute('hidden', ''); }
      else if (node.removeAttribute) node.removeAttribute('hidden');
    } catch (e) {  }
  }

  function heroPrepStatusHtml(draft, count) {
    const picks = Math.max(0, (draft.picks || []).length);
    const pool = Math.max(0, Number(draft.statPool) || 0);
    const gears = (draft.appearance || []).filter((slot) => !!heroGearSlotOf([slot], 0)).length;
    const note = picks < count ? ('还需点亮 ' + Math.max(0, count - picks) + ' 个武技')
      : (pool > 0 ? ('还有 ' + pool + ' 点可分配') : ('已点亮 ' + count + ' 个武技，准备出发'));
    return '<div class="hero-prep-status-pane" data-hero-pane="status">' +
        '<div class="hero-prep-portrait"><span class="hero-prep-portrait-art" data-hero-setup-art aria-hidden="true"></span></div>' +
        '<div class="hero-prep-summary">' +
          '<h2 class="hero-prep-title">出发准备</h2>' +
          '<p class="hero-prep-kicker"><span class="hero-demo-badge">勇者剧本</span> 塑造本局勇者</p>' +
          '<div class="hero-prep-facts">' +
            '<div class="hero-prep-fact"><i>武技</i><b data-hero-count>' + picks + ' / ' + count + '</b></div>' +
            '<div class="hero-prep-fact"><i>四维</i><b data-hero-pool>' + (pool > 0 ? '可分配 ' + pool + ' 点' : '已分配') + '</b></div>' +
            '<div class="hero-prep-fact"><i>外观</i><b data-hero-look>' + gears + ' 件' + (gears ? '' : '（可选）') + '</b></div>' +
          '</div>' +
          '<p class="hero-prep-todo" data-hero-start-note>' + note + '</p>' +
          '<div class="hero-prep-actions">' + C().btn('更换装备', 'hero-gear', 'gold') +
            C().btn('开始挑战', 'hero-start', 'gold') + '</div>' +
          '<p class="hero-base-note">开局前可调整力量 / 敏捷 / 速度（20% 下限）；每通过 5 层生命上限 +50、力/敏/速 +5。装备只改变外观、属性 0 加成，被动技能与塔内增益另计。</p>' +
        '</div>' +
      '</div>' +
      '<div class="stat-strip hero-prep-stats" data-hero-preview-stats' + (heroSetupTab === 'status' ? '' : ' hidden') + '>' +
        heroDraftStatsHtml(heroDraftStats(draft.picks, draft.stats), draft) + '</div>';
  }

  function heroPrepCatalogHtml(catalog, draft, kind, count, level) {
    const pane = kind + 's';
    const items = (catalog || []).filter((item) => item.kind === kind);
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.max(0, Math.min(pages - 1, Number(heroSetupPage[kind]) || 0));
    heroSetupPage[kind] = page;
    const selected = new Set((draft.picks || []).map((item) => item.kind + ':' + item.id));
    const cells = items.length ? items.map((item, index) => {
      const key = item.kind + ':' + item.id, picked = selected.has(key), pageNo = Math.floor(index / 10);
      return '<button type="button" class="catalog-cell hero-ws-cell' +
        (picked ? ' is-lit is-selected' : '') + '" data-hero-pick="' + esc(key) + '"' +
        ' data-hero-kind="' + esc(item.kind) + '" data-hero-page="' + pageNo + '"' +
        (pageNo === page ? '' : ' hidden') + ' aria-pressed="' + (picked ? 'true' : 'false') + '"' +
        ' title="' + esc(item.name + (item.desc ? '：' + item.desc : '')) + '">' +
        '<span class="item-icon">' + heroWsIcon(item.kind, item.id, 132) + '</span>' +
        '<span class="item-caption"><b>' + esc(item.name) + '</b><em>Lv.' + level + '</em></span></button>';
    }).join('') : '<p class="hero-ws-empty">武技字典还没有加载。</p>';
    return '<div class="hero-ws-pane" data-hero-pane="' + pane + '"' + (heroSetupTab === pane ? '' : ' hidden') + '>' +
        '<div class="hero-ws-head"><h3>' + (kind === 'weapon' ? '武器' : '技能') + ' · 点亮 ' + count + ' 个</h3>' +
          '<span class="hero-ws-count" data-hero-count-cat>已点亮 ' + selected.size + ' / ' + count + '</span></div>' +
        '<div class="hero-ws-grid">' + cells + '</div>' +
        '<p class="hero-ws-desc" data-hero-ws-desc>点一下点亮，再点一下取消；正好 ' + count + ' 个即可出发。</p>' +
        (pages > 1
          ? '<div class="page-arrow prev"><button type="button" class="uc-button arrow" data-hero-page-step="' + kind + ':-1" aria-label="上一页">‹</button></div>' +
            '<div class="page-arrow"><button type="button" class="uc-button arrow" data-hero-page-step="' + kind + ':1" aria-label="下一页">›</button></div>'
          : '') +
        '<span class="hero-ws-page" data-hero-page-label>' + (page + 1) + ' / ' + pages + '</span>' +
      '</div>';
  }

  function heroPrepSyncTabs(p, tab) {
    heroSetupTab = tab;
    if (!p || typeof p.querySelectorAll !== 'function') return;
    p.querySelectorAll('[data-hero-pane]').forEach((pane) => {
      heroNodeHidden(pane, pane.dataset.heroPane !== tab);
    });
    p.querySelectorAll('[data-hero-preview-stats]').forEach((el) => { heroNodeHidden(el, tab !== 'status'); });
    const tabKeys = { status: true, weapons: true, skills: true };
    p.querySelectorAll('.classic-tabs .uc-tab').forEach((btn) => {
      const key = btn.dataset && btn.dataset.action;
      if (!tabKeys[key]) return;
      const on = key === tab;
      btn.classList.toggle('active', on);
      if (btn.setAttribute) btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
    // 页签矢量图按 `.active` 换帧，就地切页时补一次；整页重画时 `page()` 自己装。
    if (window.UI && UI.classic && UI.classic.syncTabVectors) UI.classic.syncTabVectors(p);
  }

  function heroPrepSyncPage(p, kind, catalog) {
    if (!p) return;
    const items = (catalog || []).filter((item) => item.kind === kind);
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.max(0, Math.min(pages - 1, Number(heroSetupPage[kind]) || 0));
    heroSetupPage[kind] = page;
    if (typeof p.querySelectorAll !== 'function') return;
    p.querySelectorAll('[data-hero-kind="' + kind + '"]').forEach((cell) => {
      heroNodeHidden(cell, (Number(cell.dataset.heroPage) || 0) !== page);
    });
    const pane = typeof p.querySelector === 'function' ? p.querySelector('[data-hero-pane="' + kind + 's"]') : null;
    if (!pane || typeof pane.querySelectorAll !== 'function') return;
    const label = pane.querySelector('[data-hero-page-label]');
    if (label) label.textContent = (page + 1) + ' / ' + pages;
    pane.querySelectorAll('[data-hero-page-step]').forEach((btn) => {
      const dir = String(btn.dataset.heroPageStep || '').split(':')[1];
      const can = dir === '-1' ? page > 0 : page < pages - 1;
      btn.disabled = !can;
      const arrow = btn.parentNode;
      if (arrow && arrow.style) arrow.style.display = can ? '' : 'none';
    });
  }
  function openHeroSetupDom(opts) {
    setTowerOrigin(opts);
    if (Tower.endlessInfo().run) { openEndless(); return; }
    if (!window.TowerHero || !TowerHero.CONFIG) { notice('勇者模式尚未加载，请刷新后重试。'); return; }
    const config = TowerHero.CONFIG, catalog = heroCatalog();
    const count = Math.max(1, Number(config.initialCount) || 3), level = Math.max(1, Number(config.startLevel) || 5);
    const draft = ensureHeroSetupDraft();
    const selected = new Set(draft.picks.map((item) => item.kind + ':' + item.id));
    closeHeroGearPicker();

    const content = heroPrepStatusHtml(draft, count) +
      heroPrepCatalogHtml(catalog, draft, 'weapon', count, level) +
      heroPrepCatalogHtml(catalog, draft, 'skill', count, level);

    const p = C().page('status', heroSetupTab, content, { cls: 'hero-prep-board', pageClass: 'hero-setup-page', homeLabel: '返回' });
    back(p, () => { closeHeroGearPicker(); openEndless(); }, '返回');
    const defaultDesc = '点一下点亮，再点一下取消；正好 ' + count + ' 个即可出发。';
    const setDesc = (text) => {
      if (!p || typeof p.querySelectorAll !== 'function') return;
      p.querySelectorAll('[data-hero-ws-desc]').forEach((el) => { el.textContent = text || defaultDesc; });
    };
    const bindStatSteps = (host) => {
      if (!host || typeof host.querySelectorAll !== 'function') return;
      host.querySelectorAll('[data-stat-step]').forEach((btn) => {
        btn.onclick = () => {
          const parts = String(btn.dataset.statStep || '').split(':');
          const out = heroAdjustStat(draft, parts[0], parts[1]);
          if (!out.ok) { if (window.UI && UI.toast) UI.toast(out.msg); return; }
          draft.stats = out.values;
          draft.statPool = out.pool;
          update();
        };
      });
    };
    const update = () => {
      const full = selected.size === count;
      const pool = Math.max(0, Number(draft.statPool) || 0);
      const gears = (draft.appearance || []).filter((slot) => !!heroGearSlotOf([slot], 0)).length;
      const counter = find(p, '[data-hero-count]');
      const poolEl = find(p, '[data-hero-pool]');
      const lookEl = find(p, '[data-hero-look]');
      const start = find(p, '[data-action="hero-start"]');
      const note = find(p, '[data-hero-start-note]');
      if (counter) counter.textContent = selected.size + ' / ' + count;
      if (poolEl) poolEl.textContent = pool > 0 ? ('可分配 ' + pool + ' 点') : '已分配';
      if (lookEl) lookEl.textContent = gears + ' 件' + (gears ? '' : '（可选）');
      p.querySelectorAll('[data-hero-count-cat]').forEach((el) => { el.textContent = '已点亮 ' + selected.size + ' / ' + count; });
      if (start) start.disabled = !full || pool > 0;
      if (note) note.textContent = !full ? ('还需点亮 ' + Math.max(0, count - selected.size) + ' 个武技')
        : (pool > 0 ? ('还有 ' + pool + ' 点可分配') : ('已点亮 ' + count + ' 个武技，准备出发'));
      p.querySelectorAll('[data-hero-pick]').forEach((btn) => {
        const on = selected.has(btn.dataset.heroPick);
        btn.classList.toggle('is-lit', on);
        btn.classList.toggle('is-selected', on);
        btn.classList.toggle('is-locked', !on && full);
        if (btn.setAttribute) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const statsHost = find(p, '[data-hero-preview-stats]');
      if (statsHost) {
        statsHost.innerHTML = heroDraftStatsHtml(heroDraftStats(draft.picks, draft.stats), draft);
        bindStatSteps(statsHost);
      }
    };
    p.querySelectorAll('[data-hero-pick]').forEach((btn) => {
      const key = btn.dataset.heroPick;
      const info = catalog.find((item) => item.kind + ':' + item.id === key);
      btn.onclick = () => {
        if (selected.has(key)) selected.delete(key);
        else if (selected.size < count) selected.add(key);
        else {

          setDesc('已点亮 ' + count + ' 个武技；先点暗一个再换。');
          return;
        }
        draft.picks = catalog.filter((item) => selected.has(item.kind + ':' + item.id))
          .map((item) => ({ kind: item.kind, id: Number(item.id) }));
        update();

        if (info) setDesc(info.name + (info.desc ? '：' + info.desc : ''));
      };
      if (info) {
        const show = () => setDesc(info.name + (info.desc ? '：' + info.desc : ''));
        btn.onmouseenter = show;
        btn.onfocus = show;
        btn.onmouseleave = () => setDesc('');
        btn.onblur = () => setDesc('');
      }
    });
    p.querySelectorAll('[data-hero-page-step]').forEach((btn) => {
      btn.onclick = () => {
        const parts = String(btn.dataset.heroPageStep || '').split(':');
        const kind = parts[0], dir = Number(parts[1]) || 0;
        if (kind !== 'weapon' && kind !== 'skill') return;
        const items = catalog.filter((item) => item.kind === kind);
        const pages = Math.max(1, Math.ceil(items.length / 10));
        const next = Math.max(0, Math.min(pages - 1, (Number(heroSetupPage[kind]) || 0) + dir));
        if (next === heroSetupPage[kind]) return;
        heroSetupPage[kind] = next;
        heroPrepSyncPage(p, kind, catalog);
      };
    });
    p.querySelectorAll('.classic-tabs .uc-tab').forEach((btn) => {
      const key = btn.dataset && btn.dataset.action;
      if (key !== 'status' && key !== 'weapons' && key !== 'skills') return;
      // 顶层三颗页签归准备页自己管：不能落到状态页 / 图鉴页的 `actions` 上。
      btn.onclick = () => {
        if (key === heroSetupTab) return;
        const run = () => { heroPrepSyncTabs(p, key); setDesc(''); };
        if (window.SfUiFeedback && SfUiFeedback.tap) SfUiFeedback.tap(btn, run, { delay: 150, press: true, exit: true });
        else run();
      };
    });
    on(p, 'hero-gear', () => {
      openHeroGearPicker({
        slots: draft.appearance.slice(),
        onChange: (next) => {
          draft.appearance = heroAppearanceSlots(next);
          update();
          paintHeroArt(find(p, '[data-hero-setup-art]'), draft.appearance, { label: '勇者', pad: 4, zoom: 1.1 });
        },
      });
    });
    on(p, 'hero-start', () => {
      if (draft.picks.length !== count) { notice('请点亮 ' + count + ' 个起始武技。'); return; }
      const pool = Math.max(0, Number(draft.statPool) || 0);
      if (pool > 0) { notice('还有 ' + pool + ' 点可分配，先把力/敏/速分配完再加入。'); return; }
      const options = { ruleset: 'hero', hero: { picks: draft.picks.map((item) => Object.assign({}, item)),
        appearance: heroAppearancePaint(draft.appearance),
        stats: Object.assign({}, draft.stats) } };
      closeHeroGearPicker();
      if (beginEndlessRun(options)) heroSetupDraft = null;
    });
    update();
    heroPrepSyncTabs(p, heroSetupTab);
    heroPrepSyncPage(p, 'weapon', catalog);
    heroPrepSyncPage(p, 'skill', catalog);
    paintHeroArt(find(p, '[data-hero-setup-art]'), draft.appearance, { label: '勇者', pad: 4, zoom: 1.1 });
  }
  // 勇者货品自选（HS02 / HS03）
  // 这两件是「即时类」，但效果必须由玩家点选目标。界面在真正购买前把目标收齐，
  function heroRunOwned(run) {
    if (!run || !run.hero) return [];
    const out = [];
    for (const kind of ['weapon', 'skill']) {
      for (const raw of (kind === 'weapon' ? run.hero.weapons : run.hero.skills) || []) {
        const hit = /^(\d+):(\d+)$/.exec(String(raw));
        if (!hit) continue;
        const id = Number(hit[1]), level = Math.max(1, Number(hit[2]) || 1);
        const inst = kind === 'weapon'
          ? (State.weaponInst ? State.weaponInst(id) : null)
          : (State.skillInst ? State.skillInst(id) : null);
        out.push({ kind, id, level, ref: (kind === 'weapon' ? 'w:' : 's:') + id,
          name: (inst && inst.name) || ((kind === 'weapon' ? '武器 ' : '技能 ') + id),
          desc: (inst && inst.remark) || '' });
      }
    }
    return out;
  }
  function openHeroGoodsPicker(opts) {
    const o = opts || {};
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) { notice(o.empty || '没有可选目标。'); return; }
    const el = document.createElement('div');
    el.className = 'hero-goods-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', o.title || '选择武技');
    el.innerHTML = '<div class="hero-goods-panel">' +
      '<header class="hero-goods-head"><div><h3>' + esc(o.title || '选择武技') + '</h3>' +
        '<p>' + esc(o.note || '点一下选择。') + '</p></div>' +
        '<span class="hero-goods-count">' + items.length + ' 项</span></header>' +
      '<div class="hero-goods-list">' + items.map((it, i) =>
        '<button type="button" class="hero-goods-item" data-hero-goods="' + i + '">' +
          '<span class="hero-goods-icon">' + heroWsIcon(it.kind, it.id, 42) + '</span>' +
          '<span class="hero-goods-text"><b>' + esc(it.name) + '</b><em>' + esc(it.meta || '') + '</em>' +
            (it.desc ? '<span>' + esc(it.desc) + '</span>' : '') + '</span>' +
          '<i class="hero-goods-arrow">›</i></button>').join('') + '</div>' +
      '<footer class="hero-goods-foot"><span>' + esc(o.foot || '选择后才会消耗货品。') + '</span>' +
        '<button type="button" class="uc-button gold" data-hero-goods-close>返回</button></footer></div>';
    document.body.appendChild(el);
    const close = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
      document.removeEventListener('keydown', onKey, true);
      if (o.onClose) o.onClose();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (ev) => { if (ev.target === el) close(); });
    el.querySelectorAll('[data-hero-goods]').forEach((btn) => {
      btn.onclick = () => {
        const item = items[Number(btn.dataset.heroGoods)];
        if (!item) return;
        close();
        if (o.onPick) o.onPick(item);
      };
    });
    const back = el.querySelector('[data-hero-goods-close]');
    if (back) back.onclick = close;
    return el;
  }
  function openHeroGoodsFlow(slotId, run, done) {
    if (!run || !run.hero) { notice('当前不是勇者模式。'); return; }
    if (slotId === 'HS03') {
      const pool = heroRunOwned(run).filter((it) => it.level < 15 &&
        !(it.kind === 'skill' && [6, 13].includes(it.id)));
      openHeroGoodsPicker({
        title: '大师传承 · 选择武技',
        note: '选中的武技等级提高5级（最高真5 / 15级）。',
        items: pool.map((it) => Object.assign({}, it, {
          meta: '当前 ' + heroLevelText(it.level) + ' → ' + heroLevelText(Math.min(15, it.level + 5)),
        })),
        empty: '没有未满级的武技可选。',
        onPick: (it) => done({ ref: it.ref }),
      });
      return;
    }
    if (slotId === 'HS02') {
      const owned = heroRunOwned(run);
      openHeroGoodsPicker({
        title: '遗忘与新生 · 遗忘',
        note: '先选一个要遗忘的武技；新武技会继承它的等级。',
        items: owned.map((it) => Object.assign({}, it, { meta: '当前 ' + heroLevelText(it.level) })),
        empty: '还没有已学武技可以遗忘。',
        onPick: (forget) => {
          const known = new Set(owned.map((it) => it.kind + ':' + it.id));
          const pool = heroCatalog().filter((it) => !known.has(it.kind + ':' + it.id));
          openHeroGoodsPicker({
            title: '遗忘与新生 · 学习',
            note: '学习后将继承【' + forget.name + '】的 ' + heroLevelText(forget.level) + '。',
            items: pool.map((it) => Object.assign({}, it, { meta: '新学 · 继承 ' + heroLevelText(forget.level) })),
            empty: '已经掌握所有可学习的武技。',
            onPick: (learn) => done({ forgetRef: forget.ref, learnRef: (learn.kind === 'weapon' ? 'w:' : 's:') + learn.id }),
          });
        },
      });
    }
  }

  function heroGoodsBeforeBuy(slotId, run, onChoice) {
    if (slotId !== 'HS02' && slotId !== 'HS03') return false;
    openHeroGoodsFlow(slotId, run, onChoice);
    return true;
  }

  function openHeroEvent(event, info) {
    const run = info && info.run, layer = run ? run.layer : 1;

    if (!window.TowerPlot || typeof TowerPlot.eventHtml !== 'function') {
      notice('剧情模板尚未加载，暂时无法显示勇者际遇。');
      return null;
    }
    const main = TowerPlot.eventHtml(event);
    const ct = classicTower();
    const content = '<div class="tower-page hero-event-page">' + towerVisual(layer, 0, 'endless') + '<div class="tower-main">' + main + '</div></div>';
    const p = C().page('challenge', 'stages', content, ct
      ? { cls: 'tower-board', noTabs: true, noFooter: true, pageClass: 'classic-tower', above: classicTowerBar() }
      : { cls: 'tower-board' });
    back(p, towerBack, ct ? (ONLINE ? '返回村庄' : '返回征战') : '返回');
    if (ct) applyClassicTowerBg(p, 'endless', layer);
    const finish = (choice, extra) => {
      const out = Tower.resolveHeroEvent(choice.id, extra);
      if (!out || !out.ok) { notice(out && out.msg || '当前无法作出选择。'); return; }
      openEndless();
      const text = heroGrowthText(out);
      if (text) runToast(text);
    };
    p.querySelectorAll('[data-hero-event-choice]').forEach(button => {
      button.onclick = () => {
        const choiceId = button.dataset.heroEventChoice;
        const choice = (event.choices || []).find(it => it.id === choiceId) || (event.choices || [])[Number(choiceId)];
        if (!choice) return;
        // 钟声之前：选项一要先自选一个武技升满，不能像其它事件一样点了直接结算。
        if (event.id === 'last-lesson' && choice.effect === 'maximize') {
          const pool = run && run.hero
            ? heroRunOwned(run).filter((it) => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)))
            : [];
          if (!pool.length) { notice('没有未满级的武技可以升级。'); return; }
          openHeroGoodsPicker({
            title: '钟声之前 · 选择武技',
            note: '选中的武技会直接升到真5满级（15级）。',
            items: pool.map((it) => Object.assign({}, it, { meta: '当前 ' + heroLevelText(it.level) + ' → 真5' })),
            foot: '选择后才会结算这次际遇；也可以返回改选另一项。',
            onPick: (it) => finish(choice, { heroChoice: { ref: it.ref } }),
          });
          return;
        }
        finish(choice);
      };
    });
  }

  // 三层结构（顺序就是 z 序）：
  // ⚠ 黑幕挂在 body 上而不是页面里：中间要重画一次主界面（拾取屏 → 主界面），
  const MIRROR_WHITE_MS = 1500;
  const MIRROR_BLACK_MS = 1500;
  const MIRROR_BACK_MS = 850;
  let mirrorBlackVeilEl = null;

  function mirrorPickupHtml(run) {
    const def = (TowerData.MIRROR && TowerData.BUFF_BY_ID[TowerData.MIRROR.id]) || null;
    const owned = Math.max(0, Number(run && run.mirrorStacks) || 0);
    const rarity = def ? (Number(def.rarity) || 0) : 3;
    return '<div class="tower-mirror" data-mirror-stage>' +
        '<div class="mirror-veil" aria-hidden="true"></div>' +
        '<div class="mirror-card-wrap">' +
          // ⚠ 卡片必须是 `data-action="mirror-pick"`：界面的点击绑定走 `on(p, 'mirror-pick')`，
          '<button type="button" class="mirror-card r' + rarity + '" data-action="mirror-pick" ' +
            'aria-label="拾取' + esc(def ? def.name : '照影之境') + '">' +
            '<span class="mirror-ribbon r' + rarity + '">' + esc(RARITY[rarity] || '传奇') + '</span>' +
            '<span class="mirror-emblem" aria-hidden="true"></span>' +
            '<b class="mirror-name">' + esc(def ? def.name : '照影之境') + '</b>' +
            '<span class="mirror-flavor">' + esc(def && def.flavor ? def.flavor : '映出一具完美的躯壳') + '</span>' +
            (owned > 0 ? '<span class="mirror-stacks">已在镜中 ×' + owned + ' → ×' + (owned + 1) + '</span>' : '') +
            '<span class="mirror-prompt">点击拾取</span>' +
          '</button>' +
        '</div></div>';
  }

  function mirrorBlackVeil(on) {
    if (typeof document === 'undefined' || !document || !document.body) return;
    if (on) {
      if (!mirrorBlackVeilEl) {
        mirrorBlackVeilEl = document.createElement('div');
        mirrorBlackVeilEl.className = 'mirror-black-veil';
        document.body.appendChild(mirrorBlackVeilEl);
      }
      // 先以 opacity:0 入 DOM，再在下一帧加 `.on` —— 否则「插入 + 变 1」会被合并成一次，
      setTimeout(() => { if (mirrorBlackVeilEl && mirrorBlackVeilEl.classList) mirrorBlackVeilEl.classList.add('on'); }, 20);
      return;
    }
    const el = mirrorBlackVeilEl;
    mirrorBlackVeilEl = null;
    if (!el) return;
    if (el.classList) el.classList.add('out');
    setTimeout(() => { if (el && el.remove) el.remove(); }, MIRROR_BACK_MS + 140);
  }
  // 点卡片拾取：状态先落地（存档按这一刻算），再放三段过场动画。
  function pickMirror() {
    const res = Tower.takeMirrorReward ? Tower.takeMirrorReward() : { ok: false, msg: '当前版本没有这个接口。' };
    if (!res || !res.ok) { notice((res && res.msg) || '现在不能拾取。'); openEndless(); return; }
    const stage = (typeof document !== 'undefined' && document && typeof document.querySelector === 'function')
      ? document.querySelector('[data-mirror-stage]') : null;    if (stage && stage.classList) stage.classList.add('mirror-white');
    setTimeout(() => {
      mirrorBlackVeil(true);
      setTimeout(() => {
        openEndless();
        mirrorBlackVeil(false);
        runToast('获得传奇增益「' + (res.name || '照影之境') + '」' + (res.stacks > 1 ? ' ×' + res.stacks : ''));
      }, MIRROR_BLACK_MS);
    }, MIRROR_WHITE_MS);
  }

  function openMirrorConfirm() {
    const carryPct = Math.round(TowerData.ENDLESS_CYCLE_DISCOUNT * 100);
    modal('镜中世界',
      '<div class="mirror-confirm"><p>无尽之塔中的魔王已被击败，继续在镜中世界进行挑战吗？</p>' +
      '<p>本轮只封存静态四维与暴击、吸血、减伤等数值，成为不占位的永久基础。</p>' +
      '<p class="dim">后发制人、战斗续航、天命所归等纯局内触发不保留；旧构筑清空，成长、限次、经济与武器/技能选取强化停止，原增益重新入池；已有货币与累计战报保留。</p>' +
      '<p class="dim">新一轮敌人的基础属性降至上一轮末值的 ' + carryPct + '%，再按第 1—100 层的相对曲线成长。层内规则与构筑从头开始。</p></div>',
      [

        { label: '进入', cls: 'gold', run: () => {
            const r = Tower.enterMirrorWorld ? Tower.enterMirrorWorld() : { ok: false };
            if (!r || !r.ok) notice((r && r.msg) || '现在还不能进镜中世界。');
            else replaceTarget = null;
            openEndless();
          } },
        { label: '取消', cls: 'muted' },
      ], { small: true });
  }

  function openEndless(opts) {
    setTowerOrigin(opts);
    activeSummary = null;
    // 这一屏会整页重画 #ui，已经挂着的献祭 / 活性弹层会随 DOM 一起消失。
    // 开关必须同步复位：否则页面末尾的 `bladeOfferVisible()` 仍为 true，
    if (bladeOfferOpen) { bladeOfferOpen = false; bladeOfferEl = null; }
    const heroEvent = typeof Tower.heroEventInfo === 'function' ? Tower.heroEventInfo() : null;
    if (heroEvent) { openHeroEvent(heroEvent, Tower.endlessInfo()); return; }
    // `Tower.autoPlayStory` 是「现在该播吗」的唯一判定（判定在 tower-plot 的 `due()`）：
    // ⚠ 必须问在 `endlessInfo()` 之前（info 是快照，问晚了这一屏还是普通界面）。
    // 这一条覆盖所有「进到这一屏」的路径：层通关推进、离店 / 结算点继续、读档重进、
    try { if (Tower.autoPlayStory) Tower.autoPlayStory('endless'); } catch (e) {  }
    const info = Tower.endlessInfo();
    let main, footer = null;
    // 这一屏有没有「右下角固定动作条」（继续战斗 / 放弃本局）：
    // 剧情屏、拾取屏没有，不能给它们加底部留白。
    let runBoard = false;

    let foeCount = 0;

    const notStarted = !!(info.run && info.run.layer === 1 && !(info.run.score > 0) && !(info.run.lastCoinsGained > 0));
    if (info.run) {
      const run = info.run;

      const storyId = TowerPlot.pending(run);
      if (storyId) {
        main = TowerPlot.modeHtml(TowerPlot.begin(storyId), run.layer);
      } else if (run.pendingStoryId && run.pendingStoryHold) {

        const lost = (run.lostMarks && run.lostMarks.length)
          ? run.lostMarks[run.lostMarks.length - 1].label : '';
        main = TowerPlot.noticeHtml('烙印失效',
          '<p class="tower-story-line">碎掉的烙印失效：' + esc(lost || '一道烙印') + '</p>' +
          '<p class="tower-story-line done">它从你的存在中被抹去了。</p>');
      } else if (run.mirrorPending) {
        // 剧情屏的优先级在它上面（刚刚那一段 `storyId`），所以顺序是：终章剧情 → 拾取屏。
        main = mirrorPickupHtml(run);
      } else if (run.phase === 'mirror' && !pendingMilestone &&
        Tower.canSettleEndlessVictory && Tower.canSettleEndlessVictory()) {
        return openEndlessSummary(Tower.previewEndlessSummary('win'));
      } else {
      const nextLabel = run.choices ? '先选一张增益'
        : run.phase === 'shop' ? (run.mintShop ? '进入铸币商店' : '进入试炼商店')
        : run.phase === 'checkpoint' ? '前往结算点'
        : run.phase === 'sacrifice' ? '放弃一个永久增益'
        // 整百层本来也不开店），点它才问「要不要进镜中世界」。
        : run.phase === 'mirror' ? '继续挑战' : '继续战斗';

      const foes = (Tower.planInfo ? Tower.planInfo('endless') : []).length
        ? Tower.planInfo('endless')
        : Tower.preview(run.layer, run.salt, true);
      const clearing = (run.phase === 'shop' || run.phase === 'checkpoint' || run.phase === 'sacrifice' || run.phase === 'mirror') && run.finished && run.finished.layer === run.layer;
      const beatenCount = clearing ? foes.length : Math.max(0, (run.battleNo || 1) - 1);
      foeCount = foes.length;
      const foeRows = foes.map((b, i) =>
        '<li class="' + (b.elite ? 'elite ' : '') + (b.patrol ? 'patrol ' : '') + (b.squirrel ? 'squirrel ' : '') +
        (i < beatenCount ? 'beaten' : '') +
        '" tabindex="0" data-tip="' + esc(mechTip(b, (run.env || []).map((e) => e.text || e.desc || e.name))) + '">' +
        foePortraitHtml(i, b) +
        '<b>' + esc(b.name) + '</b>' + (b.type ? '<span class="tower-plan-type">' + esc(b.type) + '</span>' : '') +
        (b.elite ? '<em class="elite-tag">精英</em>' : '') +
        (i < beatenCount ? '<em class="beaten-tag">✓ 已战胜</em>' : '') + '</li>').join('');
      const choicesTitle = run.choicesKind === 'patrolLegendary'
        ? '巡视战利品 · 传奇三选一'
        : '休整点 · 选一张带走';
      const choicesHtml = run.choices
        ? '<div class="tower-buffs choice-onpage"><h4>' + choicesTitle + '</h4>' +

          (run.env && run.env.length
            ? '<div class="hex-seg-mechs inline"><span class="hex-next-label">当前环境</span>' +
              run.env.map((e) => envChip(e, { compact: true })).join('') + '</div>'
            : '') +
          '<div class="hex-row">' +
          // 注意不要写成裸 mode —— openEndless() 作用域里没有 mode，
          run.choices.map((c, i) => choiceCard(c, i, 'endless')).join('') + '</div></div>' : '';

      runBoard = true;
      main = '<div class="endless-run">' +
        // 右上角：药丸槽 + 试炼币/抽奖卷 + 分数框（横向一行，位置不变）。
        '<div class="endless-topright">' + (notStarted ? '' : currencyHtml('endless')) +
        '<span class="endless-score-box"><i>分数</i><b>' + run.score + '</b></span></div>' +
        '<div class="endless-left">' +
        '<div class="endless-title-row"><h2 class="tower-title">' + (run.ruleset === 'hero' ? '勇者剧本' : '无尽塔') + ' · 第 ' + run.layer + ' 层</h2>' +
        '</div>' +
        carryBar(run.curHp, run.curMaxHp, '血量', 'endless-hp', hpTip(run)) +
        // 环境词缀（唯一常驻负面机制）：
        envPanelHtml(run, { label: '当前环境' }) +
          (run.enemyMaxHpDown > 0 || run.enemyPowerDown > 0
            ? '<div class="tower-rule mech-bar"><b>本局全局减益</b>' +
              (run.enemyMaxHpDown > 0
                ? '<span class="mech-chip debuff-chip enemy-down" data-tip="' +
                  esc('挫锐 / 卸甲：本局所有敌人的生命上限都按这个比例扣') + '">敌人生命上限 −' +
                  Math.round(run.enemyMaxHpDown * 100) + '%<i>本局全程</i></span>' : '') +
              (run.enemyPowerDown > 0
                ? '<span class="mech-chip debuff-chip enemy-down" data-tip="' +
                  esc('挫锋：立刻让本局所有敌人的攻击力 −15%') + '">敌人攻击力 −' +
                  Math.round(run.enemyPowerDown * 100) + '%<i>本局全程</i></span>' : '') +
              '</div>'
            : '') +
          (run.debuffs && run.debuffs.length
            ? '<div class="tower-rule mech-bar"><b>本层削弱（贯穿本层）</b>' +
              run.debuffs.map((d) => '<span class="mech-chip debuff-chip" style="--hero-color:' + esc(d.color || '#a8453a') +
                '" data-tip="' + esc(d.text || '') + '">' +
                esc(d.short || d.hero || '大侠') + esc(d.name || '削弱') + '<i>本层</i></span>').join('') + '</div>'
            : '') +
        choicesHtml + buffPanelsHtml('endless') + '</div>' +
        '<div class="endless-foes' + (foeCount >= 5 ? ' foes-many' : '') + '">' +
        '<ol class="tower-plan vertical">' + foeRows + '</ol></div></div>' +
        '<div class="endless-actions tower-actions">' +
        '<span class="endless-action-btns">' +
        C().btn('放弃本局', 'abandon', 'muted tiny') +
        C().btn(nextLabel, 'fight', 'gold') + '</span></div>';
      }
    } else {


      const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
      const allBest = Math.max(num(info.allBest), num(info.best), num(info.heroBest));
      const allWeekBest = Math.max(num(info.allWeekBest), num(info.weekBest), num(info.heroWeekBest));
      const allBestLayer = Math.max(num(info.allBestLayer), num(info.bestLayer), num(info.heroBestLayer));
      main = '<h2 class="tower-title">无尽塔</h2>' +
        '<div class="tower-stats">历史最高 <b class="gold-text">' + allBest + '</b> 分 · 本周最高 ' + allWeekBest + ' 分 · 最深 ' + allBestLayer + ' 层' +
          '<span class="tower-stats-sub">' + (ONLINE
            ? '经典 ' + num(info.best) + ' 分 / ' + num(info.bestLayer) + ' 层'
            : '经典 ' + num(info.best) + ' 分 / ' + num(info.bestLayer) + ' 层 · 勇者 ' +
              num(info.heroBest) + ' 分 / ' + num(info.heroBestLayer) + ' 层') + '</span></div>' +
        (ONLINE ? '<p class="small-label">从村庄的小径来到远方的无尽之塔。' +
          '每累计通过 10 层得 1 张抽奖卷；结算时铸币超过 10 枚再额外得 1 张；' +
          '本周已获得 ' + Math.max(0, Math.floor(Number(info.weekTickets) || 0)) + '/' +
          (Math.max(0, Math.floor(Number(info.weekCap) || 0)) || 10) + ' 张。</p>' : '') +

        buffCatalogHtml() + bossCatalogHtml();
      footer = '<div class="tower-actions tower-footer">' +

        (info.lastSummary ? C().btn('上局战报', 'last-summary', 'muted') : '') +
        scriptPickerHtml() +
        C().btn('开始攀登', 'fight', 'gold') + '</div>';
    }
    // 刚播完剧情 → 整页带一个淡入类，不要硬切。
    // ⚠️ 动画只作用在 .tower-main（见 CSS）：塔身不参与，否则左侧塔 UI 会跟着闪一下。
    const fadeIn = TowerPlot.takeFadeIn();
    const content = '<div class="tower-page' + (runBoard ? ' endless-page' : '') +
      (footer ? ' has-footer' : '') + (fadeIn ? ' tower-fade-in' : '') + '">' +
      towerVisual(info.run ? info.run.layer : 1, 0, 'endless') +
      '<div class="tower-main">' + main + '</div>' + (footer || '') +
      // 也就是塔身那一列的下方）—— 不要塞进「放弃本局 / 继续战斗」那一行。
      TowerPlot.modeButtonHtml() + heroPortraitButtonHtml(info.run) + '</div>';
    const ct = classicTower();
    const p = C().page('challenge', 'stages', content, ct
      ? { cls: 'tower-board', noTabs: true, noFooter: true, pageClass: 'classic-tower', above: classicTowerBar() }
      : { cls: 'tower-board' });

    if (typeof TowerPlot.afterRender === 'function') TowerPlot.afterRender();
    bindTips(p);
    if (info.run) {
      const pv = Tower.planInfo ? Tower.planInfo('endless') : Tower.preview(info.run.layer, info.run.salt, true);
      fillFoeArt(p, pv); fillClassicFoeArt(p, pv); fillClassicCampaignArt(p, pv);
      if (info.run.ruleset === 'hero' && info.run.hero) {
        paintHeroArt(find(p, '[data-hero-portrait]'), info.run.hero.appearance, { label: '勇者', pad: 5, zoom: 1.04 });
      }
    }
    back(p, towerBack, ct ? (ONLINE ? '返回村庄' : '返回征战') : '返回');
    if (ct) applyClassicTowerBg(p, 'endless', info.run ? info.run.layer : 1);
    // （语义就是 `TowerPlot.next()` —— 正在打字时点一下＝立刻补完这一行，打完了再点＝下一行）。
    // ⚠ 点在按钮 / 带悬停气泡的元素上不接管：左下的「剧情/挑战模式」开关与「返回菜单」
    if (TowerPlot.showing()) {
      p.onclick = (ev) => {
        const t = ev && ev.target;
        if (t && typeof t.closest === 'function' && t.closest('button, a, input, select, textarea, [data-tip]')) return;
        TowerPlot.next();
      };
    }

    on(p, 'story-mode', () => { Tower.setStoryEnabled(!Tower.storyEnabled()); openEndless(); });
    on(p, 'hero-status', () => openHeroStatus('status'));
    on(p, 'last-summary', () => openEndlessSummary(info.lastSummary));

    const scriptPicker = p.querySelector ? p.querySelector('[data-script-picker]') : null;
    if (scriptPicker && scriptPicker.querySelector) {
      const trigger = scriptPicker.querySelector('[data-action="script-toggle"]');
      const menu = scriptPicker.querySelector('.script-menu');
      if (trigger && menu) {
        trigger.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          const open = menu.hidden !== false;
          menu.hidden = !open;
          trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
      }
      const options = scriptPicker.querySelectorAll ? scriptPicker.querySelectorAll('[data-script]') : [];
      options.forEach((el) => {
        el.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          endlessScript = el.getAttribute('data-script') === 'hero' ? 'hero' : 'default';
          openEndless();
        };
      });
    }
    on(p, 'fight', () => {
      if (info.run) {

        if (info.run.pendingRetry) { if (!retryOfferVisible()) endlessRetryOffer(info.run); return; }
        // 渴血之剑的献祭 / 活性事件同样是必选：先处理，不能直接开下一场。
        if (info.run.bladeSacrificePending) { if (!bladeOfferVisible()) openBladeSacrifice(); return; }
        if (info.run.bladeEventPending) { if (!bladeOfferVisible()) openBladeEvent(); return; }
        if (info.run.choices) { notice('先在下面选一张增益（休整点）。'); return; }
        if (info.run.phase === 'shop') { openShop(); return; }
        if (info.run.phase === 'checkpoint') { openCheckpoint(); return; }
        if (info.run.phase === 'sacrifice') { openPermSacrifice(); return; }
        // 「巡逻」收缴（2026-10 第六十二批）：输了必须交出一个最高稀有度的增益才能继续。
        if (info.run.phase === 'patrolToll') { openPatrolToll(); return; }
        if (info.run.phase === 'patrolDiscard') { openPatrolDiscard(); return; }
        // 整百层拾取完照影之境 → 这颗按钮是「继续挑战」：问一句要不要进镜中世界。
        if (info.run.phase === 'mirror') { openMirrorConfirm(); return; }
        fight('endless');
        return;
      }

      if (endlessScript === 'hero') { openHeroSetup(); return; }
      beginEndlessRun();
    });
    p.querySelectorAll('[data-choice]').forEach((el) => {
      el.onclick = () => {
        const index = Number(el.dataset.choice);
        const res = Tower.pickChoice('endless', index, replaceTarget);
        if (res && res.needsReplace) { offerReplace(index, res.buff); return; }
        if (!res || !res.ok) { notice((res && res.msg) || '这张选不了。'); openEndless(); return; }
        replaceTarget = null;
        if (res.pendingPick) { openPickBuff(res.pendingPick); return; }
        openEndless();
      };
    });
    p.querySelectorAll('[data-toggle]').forEach((el) => {
      el.onclick = () => {
        const res = Tower.toggleLimited(el.dataset.toggle);
        if (res && !res.ok) notice(res.msg || '现在不能切换这个增益。');
        openEndless();
      };
    });
    p.querySelectorAll('[data-replace]').forEach((el) => {
      el.onclick = () => {
        replaceTarget = replaceTarget === el.dataset.replace ? null : el.dataset.replace;
        openEndless();
      };
    });
    on(p, 'shop', () => openShop(true));

    on(p, 'mirror-pick', () => pickMirror());

    if (info.run && info.run.pendingPick) setTimeout(() => openPickBuff(info.run.pendingPick), 60);

    if (!TowerPlot.showing()) { flushRunToasts(); flushPendingAchievements(); }

    const bladeBlocking = !!(info.run && (info.run.bladeSacrificePending || info.run.bladeEventPending));
    // 20 起每 10 层：出商店后必须放弃一个永久增益（不可取消）。
    // 剧情屏上不能弹这个窗，否则剧情和弹窗叠在一起。剧情播完回主界面时这里会再跑一次。
    if (info.run && info.run.phase === 'sacrifice' && !TowerPlot.showing() && !bladeBlocking) setTimeout(() => openPermSacrifice(), 60);

    if (pendingMilestone && !TowerPlot.showing() && !bladeBlocking) {
      const pm = pendingMilestone;
      pendingMilestone = null;
      setTimeout(() => milestoneModal(pm.rw, pm.cont), 60);
    }

    if (info.run && info.run.pendingRetry && !TowerPlot.showing() && !retryOfferVisible()) {
      endlessRetryOffer();
    }

    if (info.run && !TowerPlot.showing() && !bladeOfferVisible()) {
      if (info.run.bladeSacrificePending) openBladeSacrifice();
      else if (info.run.bladeEventPending) openBladeEvent();
    }
    on(p, 'rest-shop', () => {
      const res = Tower.openRestShop();
      if (!res.ok) { notice(res.msg || '现在不能开商店。'); return; }
      openShop();
    });
    on(p, 'abandon', () => {
      const doAbandon = () => {
        const res = Tower.abandon('endless');
        if (!res || !res.ok) { notice('当前无法结算，请先完成正在进行的战斗。'); return; }
        settleResult(res);
      };
      if (ONLINE) {
        const pv = Tower.previewSettleTickets ? Tower.previewSettleTickets() : null;
        modal('放弃本局',
          '<p>放弃后按<b>本局已通过层数</b>结算抽奖卷（分数照常入账）：</p>' +
          onlineTicketBlock(pv) +
          '<p class="small-label">抽奖卷由服务器结算后入包；每周最多 10 张，周一 0 点重置。</p>',
          [
            { label: '放弃', cls: 'muted', run: doAbandon },
            { label: '继续冲塔', cls: 'gold' },
          ], { small: true });
        return;
      }

      const pv = Tower.previewSettleTickets ? Tower.previewSettleTickets() : null;
      const fmt = (v) => Math.max(0, Math.floor(Number(v) || 0));
      const lines = pv ? [
        '<li><span>按第 ' + pv.layer + ' 层应得</span><b class="gold-text">' + fmt(pv.layerTickets) + ' 张</b></li>',
        pv.mint > 0
          ? '<li><span>铸币折现（' + fmt(pv.mint) + ' 枚 ×1:1' +
            (pv.mintForfeited > 0 ? ('，上限 ' + pv.mintCap + ' 枚，超出 ' + fmt(pv.mintForfeited) + ' 枚作废') : '') +
            '）</span><b class="gold-text">+' + fmt(pv.mintConverted) + ' 张</b></li>'
          : '',
        '<li class="total"><span>结算到手</span><b>共 ' + fmt(pv.total) + ' 张抽奖卷</b></li>',
      ].filter(Boolean).join('') : '';
      modal('放弃本局',
        '<p>放弃后<b>按当前层结算抽奖卷</b>（分数照常入账）：</p>' +
        (lines ? '<ul class="settle-calc">' + lines + '</ul>' : '')
        , [
        { label: '放弃', cls: 'muted', run: doAbandon },
        { label: '继续冲塔', cls: 'gold' },
      ], { small: true });
    });
  }

  function beginEndlessRun(opts) {
    const options = opts && opts.ruleset === 'hero' ? opts : null;
    if (!options) endlessScript = 'default';
    const started = options ? Tower.startEndlessRun(options) : Tower.startEndlessRun();
    if (!started.ok) { notice(started.msg); return false; }
    if (Tower.storyEnabled()) Tower.setRunStory('endless', 'intro');
    openEndless();
    return true;
  }



  function reopen(mode) { if (mode === 'tower') openTower(); else openEndless(); }
  // 开战前的最后一道闸：现在该先播剧情 → 不开打。
  // ⚠ 别改成「调 nextBattle 看看有没有剧情」：那会建出一枚 attempt 令牌，
  function pendingStoryBlocksBattle(mode) {
    let blocked = false;
    try { blocked = Tower.storyPendingForBattle ? !!Tower.storyPendingForBattle(mode) : false; } catch (e) { blocked = false; }
    if (!blocked) return false;

    if (typeof Tower.storyEnabled === 'function' && !Tower.storyEnabled()) return false;

    try { Tower.autoPlayStory && Tower.autoPlayStory(mode); } catch (e) {  }
    reopen(mode);
    return true;
  }
  function fight(mode) {
    if (pendingStoryBlocksBattle(mode)) return;
    const nx = Tower.nextBattle(mode);
    if (!nx.ok) { reopen(mode); if (nx.msg) notice(nx.msg); return; }
    flushAchievements(nx.achievements);
    const interrupted = () => {
      Tower.interruptBattle(mode, nx.token);
      reopen(mode);
      notice('战斗播放中断，进度已保留，可重新挑战这一场。');
    };

    const runNow = mode === 'tower' ? Tower.towerInfo().run : Tower.endlessInfo().run;
    const layerNow = runNow ? Math.max(1, Math.floor(Number(runNow.layer) || 1)) : 1;
    const skipAllowed = Tower.skipPlaybackAllowed(mode, layerNow);
    try {
      Promise.resolve(Main.startBattle(nx.foe, {
        region: nx.region, kind: mode, useProps: false,
        // 塔战斗结束由 afterBattle/reopen 自己回塔页；不传 keepScreen 会先 showHome()
        // 挂一遍经典主页，再被塔页覆盖（Android 上就是主页反复挂载 / 渲染器抖动）。
        keepScreen: true,

        ...(ONLINE ? { skipRecord: true, skipChest: true } : {}),
        ...(nx.fighter ? { fighter: nx.fighter, hpRatio: 1 } : { hpRatio: nx.hpRatio, adjustMe: nx.adjustMe }),
        debuffs: nx.debuffs || [],
        trial: nx.info && nx.info.mechDesc ? { text: nx.info.mechDesc } : null,
        allowSkip: skipAllowed, speedToggle: true, speedMax: 3,
        // 经典塔：胜利后不展示原版战果 CG。
        // 无尽塔不管从哪进都不要 —— 打完一场直接回塔页，不要那张全屏胜利图
        // 注意 `hideVictoryCg` 只影响胜利：失败面板照旧（见 SfFight 的 `perform`）。
        hideVictoryCg: mode === 'endless' || classicTower(),
// 否则免门票的无尽模式可以无限刷飘物松果与经验。
        collectDrops: false,
        onError: () => Tower.interruptBattle(mode, nx.token),
        onEnd: (w, r) => {
          const hp = r && Array.isArray(r.hpAfter) ? r.hpAfter[0] : null;
          const cap = r && Array.isArray(r.maxHp) ? r.maxHp[0] : (nx.effMaxHp ? nx.effMaxHp() : 0);
          const abs = w === 0 && Number.isFinite(hp) ? Math.max(1, Math.round(hp)) : 0;
          // 必须把战斗结果 `r` 一起交给状态机：报告里的 rounds 里有 deathSave / revive 标记，
          const rw = Tower.reportBattle(mode, nx.token, w === 0, abs, cap, r);
          reopen(mode);
          if (!rw.ok) return;
          afterBattle(mode, rw);
        },
      })).catch(interrupted);
    } catch (error) { interrupted(); }
  }

  function winModal(mode, rw) {
    modal('战斗胜利', '<div class="result-box"><div class="result-title win">胜 利！</div>' +
      '<p>' + (mode === 'tower' ? '已累积松果 ' + rw.potGold : '分数 ' + rw.score + ' · 试炼币 ' + rw.coins) + '</p></div>',
      [{ label: '下一场', cls: 'gold', run: () => fight(mode) }], { small: true });
  }
  function afterBattle(mode, rw) {
    flushAchievements(rw.achievements);
    const growthText = heroGrowthText(rw.heroGrowth);

    const layerBonusText = rw.heroLayerBonus
      ? ('第 ' + rw.heroLayerBonus.layer + ' 层通过：生命上限 +50 · 回复 50 · 力/敏/速 +5')
      : '';
    const growthToast = [growthText, layerBonusText].filter(Boolean).join('　');
    if (growthToast) runToast(growthToast);
    // 这里必须先处理它 —— 否则会掉进下面的 `!rw.win` 分支，弹出失败结算
    if (rw.patrol) { openPatrolToll(); return; }
    if (!rw.win) {
      if (mode === 'tower') towerDefeat(rw);
      else if (rw.retryable) { if (!retryOfferVisible()) endlessRetryOffer(rw); }
      else endlessDefeat(rw);
      return;
    }

    if (mode === 'endless') {
      if (rw.bladeGranted) runToast('获得「渴血之剑」：已放入限次增益');
      if (rw.bladeEvolved) runToast('渴血之剑进化为「' + (rw.bladeEvolved.name || '下一阶段') + '」');
      if (rw.bladeForced) runToast('渴血之剑强制苏醒：这一次无法关闭');
      if (Tower.bladePendingOf && Tower.bladePendingOf()) {
        if (rw.milestone) pendingMilestone = { rw: rw, cont: () => openEndless() };
        return;
      }
    }
    if (mode === 'endless') {

      const cont = () => openEndless();
      // 时间回廊（E15）：这一场打完就从本层第 1 场重开 —— 必须明确告诉玩家，
      // 否则「怎么又回到第 1 场了」会很懵。
      if (rw.layerRestart) {
        const lr = rw.layerRestart;
        modal('时间回廊', '<div class="result-box"><div class="result-title">回 廊</div>' +
          '<p>本层重新开始 —— 回到第 <b>1</b> 场再打一遍。</p>' +
          '<p class="dim">手上的增益、试炼币、分数与血量都<b>原样保留</b>，敌人的数值也不会提升' +
          '（第 ' + lr.layer + ' 层 · 第 ' + lr.battleNo + '/' + lr.battleCount + ' 场的收益照常入账）。</p>' +
          (lr.patrolSkipped ? '<p class="dim">本 10 层区块的魔王巡视已经结束 —— 本层<b>不会再刷新魔王</b>。</p>' : '') +
          '</div>',
          [{ label: '回到开头', cls: 'gold', run: () => openEndless() }], { small: true });
        return;
      }
      if (rw.milestone) {

        if (TowerPlot.showing()) pendingMilestone = { rw: rw, cont: cont };
        else milestoneModal(rw, cont);
        return;
      }
      if (rw.repeat) {
        const rp = rw.repeat;
        // 立即进货 / 铸币商队本来跟着这一场开店，被回响顶掉后由状态机还回来了：
        // 这里要说一句，否则玩家会以为「限次扣了却没开店」。
        const keptCredit = Math.max(0, Number(rp.shopCreditKept) || 0);
        modal(rp.name || '幻影回响',
          '<div class="result-box"><div class="result-title">回 响</div>' +
          '<p>三侠的幻影尚未散去 —— 立刻再战第 ' + Math.max(1, Number(rp.battleNo) || 1) + ' 场（同一对手）。</p>' +
          '<p class="dim">触发概率 ' + Math.round((Number(rp.chance) || 0) * 100) + '% · 这一场同样计入叠层</p>' +
          (keptCredit ? '<p class="dim">「下一场战斗后开店」的增益留到这场之后兑现 —— 这一场不会白扣。</p>' : '') +
          '</div>',
          [{ label: '再战一场', cls: 'gold', run: () => fight(mode) }], { small: true });
        return;
      }
      cont();
      return;
    }
    if (rw.choices) { offerChoice(mode, rw.choices); return; }
    if (rw.layerComplete) { towerClear(rw); return; }
    winModal(mode, rw);
  }



  const RARITY_CLASS = ['r0', 'r1', 'r2', 'r3'];

  const RARITY_EMBLEM = ['●', '◆', '★', '◆'];
  function choiceCard(c, i, mode) {
    const b = TowerData.BUFF_BY_ID[c.id];
    if (!b) return '';
    const towerNext = isTowerNext(b, mode);
    return '<button type="button" class="hex-card ' + RARITY_CLASS[b.rarity] + '" data-choice="' + i + '">' +
      '<span class="hex-ribbon">' + RARITY[b.rarity] + '</span>' +
      '<span class="hex-emblem">' + (RARITY_EMBLEM[b.rarity] || '●') + '</span>' +
      '<b class="hex-name">' + esc(b.name) + '</b>' +
      '<span class="hex-scope">' + (towerNext ? '挑战塔' : SCOPE[b.kind]) +
        (b.kind === 'limited'
          ? (towerNext ? ' · 下一场战斗' : ' · 限次 ' + (b.uses || 1) + ' 场')
          : '') + '</span>' +
      '<span class="hex-desc">' + esc(TowerData.descOf(b, mode)) + '</span></button>';
  }
  function offerChoice(mode, choices) {
    const info = mode === 'tower' ? Tower.towerInfo() : Tower.endlessInfo();
    const run = info.run || {};
    const debuffs = (run.debuffs || []);
    const next = run.next;
    const nextHtml = next
      ? '<div class="hex-next"><span class="hex-next-label">下一场</span>' +
        '<b class="hex-next-name">' + esc(next.name) + '</b>' +
        (next.type ? '<span class="hex-next-type">' + esc(next.type) + '</span>' : '') +
        '<span class="hex-next-mech">' + esc(next.mechDesc || '没有特殊机制') + '</span>' +
        (next.patternDesc ? '<span class="hex-next-pattern">' + esc(next.patternDesc) + '</span>' : '') +
        '</div>'
      : '';
    const cut = mode === 'endless' && window.TowerData && TowerData.choiceCut ? TowerData.choiceCut(run.layer) : 0;
    const head = '<div class="hex-pick-head"><h2 class="hex-title">整装待发</h2>' +
      '<p class="hex-sub">' + (mode === 'tower'
        ? '第 ' + (run.battleNo || 4) + ' 场之前最后一次整备 —— 选一张带进去。'
        : '场间休整 —— 选一张带进去。' +

          (cut > 0 ? '（21-40 层选项 −1、41-100 层选项 −2：本层是 ' + cut + ' 项；第 ' +
            (Math.floor((Math.max(1, run.layer) - 1) / 100) * 100 + 101) + ' 层起恢复）' : '')) + '</p>' +
      nextHtml +

      (mode === 'endless' && run.env && run.env.length
        ? '<div class="hex-seg-mechs"><span class="hex-next-label">当前环境</span>' +
          run.env.map((e) => envChip(e, { compact: true })).join('') + '</div>'
        : '') +
      (debuffs.length
        ? '<div class="hex-debuffs"><span class="hex-debuff-label">本层已被削弱（贯穿本层）</span>' +
          debuffs.map((d) => '<span class="hex-debuff" style="--hero-color:' + esc(d.color || '#7a4a18') + '">' +
            '<i>' + esc(d.short || d.hero || '大侠') + '</i>' + esc(d.text || d.name) + '</span>').join('') + '</div>'
        : '') +
      '</div>';
    const nSlots = Math.max(1, Math.min(6, choices.length));
    // 注意要显式传 mode：Array.map 会把「数组本身」当第三个参数塞进来，
    const body = head + '<div class="hex-cards n' + nSlots + '">' + choices.map((c, i) => choiceCard(c, i, mode)).join('') + '</div>';
    const m = modal('', body, [], { locked: true });
    m.element.classList.add('choice-dialog', 'hex', 'hex-n' + nSlots);
    m.element.querySelectorAll('[data-choice]').forEach((el) => {
      el.onclick = () => {
        const picked = Tower.pickChoice(mode, Number(el.dataset.choice));
        m.close();
        if (!picked.ok) { reopen(mode); return; }
        flushAchievements(picked.achievements);
        const text = '获得增益「' + picked.buff.name + '」：' + TowerData.descOf(picked.buff, mode);
        const bonus = picked.score ? '<p class="gold-text">得分 +' + picked.score + '（获取增益）</p>' : '';
        modal('休整完毕', '<p>' + esc(text) + '</p>' + bonus,
          [{ label: '继续战斗', cls: 'gold', run: () => fight(mode) }], { small: true });
      };
    });
  }



  function towerClear(rw) {
    const prizes = (rw.prizes && rw.prizes.items) || [];
    const prizeLine = prizes.length
      ? '<div class="result-lines">悬浮奖品（3 场挑战的量）：' +
        prizes.map((p) => esc(p.name) + ' ×' + p.count).join('　') + '</div>'
      : '';

    const lostList = (rw.prizes && rw.prizes.lost) || [];
    const lostLine = lostList.length
      ? '<div class="result-lines lost">跳过战斗：随机少收了 ' +
        lostList.map((p) => esc(p.name) + ' ×' + p.count).join('　') + '</div>'
      : '';

    const boxNote = rw.blackBox ? '（背包第一页）' : '';
    const blackLine = !State.blackGearEnabled() ? '' : ((rw.black && rw.black.cards)
      ? '<div class="result-lines">黑装：黑色卡片 ×' + rw.black.cards + (rw.blackBox ? '、黑装自选箱 ×' + rw.blackBox + boxNote : '') + '</div>'
      : (rw.blackBox ? '<div class="result-lines">黑装：黑装自选箱 ×' + rw.blackBox + boxNote + '</div>' : ''));
    modal('层数通关', '<div class="result-box"><div class="result-title win">第 ' + rw.layer + ' 层通关！</div>' +
      '<div class="result-lines">金松果 +' + rw.gold + '</div>' +
      (rw.drop ? '<p>获得 ' + esc(rw.drop.name) + ' ×' + rw.drop.count + '</p>' : '') +
      prizeLine + lostLine + blackLine +
      '<p class="small-label">层数 +1，下一层对手更强、松果更多。</p></div>',
      [{ label: '继续爬塔', cls: 'gold', run: openTower }, { label: '返回', run: () => C().home() }], { small: true });
    if (rw.prizes && rw.prizes.ups && rw.prizes.ups.length) {
      // 和战斗结算同一条升级奖励出口：优先原版 7795 升级页，缺素材时退回奖励卡。
      if (UI.classic && UI.classic.showLevelUps) UI.classic.showLevelUps(rw.prizes.ups);
      else if (UI.classic && UI.classic.pickupResult) UI.classic.pickupResult({ items: [], ups: rw.prizes.ups });
    }
  }

  function towerDefeat(rw) {
    modal('倒下在第 ' + (rw.battleNo || '?') + ' 场', '<div class="result-box"><div class="result-title lose">再接再厉</div>' +
      '<p>第 ' + rw.layer + ' 层第 ' + (rw.battleNo || '?') + '/' + (rw.battleCount || 4) + ' 场失败。</p>' +
      '<p class="gold-text">进度已保留：再战一次不用再花挑战书，也可以换一张增益。</p>' +
      '<div class="result-lines">收手的话，已累积的 ' + rw.potGold + ' 松果可换 30% 安慰奖</div></div>',
      [{ label: '再战一次', cls: 'gold', run: () => { if (rw.choices && rw.choices.length) offerChoice('tower', rw.choices); else fight('tower'); } },
       { label: '结束本层', cls: 'muted', run: () => {
          const out = Tower.giveUp('tower');
          modal('本层结束', '<p>安慰奖：金松果 +' + (out.consolation || 0) + '</p>',
            [{ label: '返回', cls: 'gold', run: () => C().home() }], { small: true });
        } },
       { label: '返回', run: () => C().home() }], { small: true });
  }


  function openPickBuff(pending) {
    const cands = Tower.pickCandidates(pending.kind);
    const isPerm = pending.kind === 'permBuff';
    const isBrand = pending.kind === 'brandBuff';
    const isLimited = pending.kind === 'limitedBuff';
    const label = isPerm ? '永久增益' : isBrand ? '烙印' : isLimited ? '限次增益' : (pending.kind === 'skill' ? '技能' : '武器');

    const inscriptionId = (isPerm && pending.buffId) || (isPerm ? Tower.activeInscriptionId('permBuff', null, pending) : null) || 'C37';
    const inscriptionName = (TowerData.BUFF_BY_ID[inscriptionId] || {}).name || '铭文';
    const inscriptionMul = isPerm ? Number(pending.mul) || 0 : 0;

    const inscDef = TowerData.BUFF_BY_ID[inscriptionId] || {};
    const inscFreeKind = !!(inscDef.mods && inscDef.mods.pickPermanentFree);

    const inscIdsOf = (c) => {
      const out = [];
      const ench = (c && Array.isArray(c.enchants)) ? c.enchants : [];
      if (c && c.slotFree === true && ench.indexOf('C37') < 0) out.push('C37');
      for (const id of ench) if (id && out.indexOf(id) < 0) out.push(id);
      return out;
    };

    const hasThisInsc = (c) => isPerm && (inscFreeKind
      ? (c.slotFree === true || inscIdsOf(c).indexOf(inscriptionId) >= 0)
      : inscIdsOf(c).indexOf(inscriptionId) >= 0);
    if (!cands.length) {
      // 候选 0 个 —— 必须把 pendingPick 收走（状态机那边已经尽量不挂它了，这里是第二道防线：
      // 老存档 / 目标刚被卖掉或碎掉）。不收走的话，每次回到这一屏都会重新弹这个空弹窗，
      Tower.deferPendingPick();
      notice('你还没有任何' + label + '可选，这次强化先替你留着（之后拿到' + label + '会自动弹出）。',
        [{ label: '知道了', cls: 'gold', run: () => openEndless() }]);
      return;
    }



    const doneCount = isPerm ? cands.filter((c) => hasThisInsc(c)).length : 0;
    // 按钮只写名字，副标题换行显示（modal 按钮是 esc() 输出，用 \n + white-space:pre-line 换行）。
    // 「×N 层 · 已附魔」，不要再跟括号（哪张铭文、什么效果）与「再选没有额外收益」这类解释；
    const buttons = cands.map((c) => {
      const done = hasThisInsc(c);
      return {
        label: c.name + '\n' + (isPerm
          ? ('×' + (c.stacks || 1) + ' 层' + (done ? ' · 已附魔' : ''))
          : (isBrand ? ('×' + (c.stacks || 1) + ' 份（未破碎）' + (c.off ? ' · 已关闭' : ''))
            : (isLimited ? ('剩余 ' + (c.uses || 1) + ' 场 → +' + (Number(pending.addUses) || 5) + (c.off ? ' · 已关闭' : ''))
              : (c.note || ('Lv' + (c.level || 1)))))),
        cls: 'small pick-buff-btn' + (done ? ' pick-done' : ((pending.kind === 'skill' || isBrand) ? '' : ' gold')),
        run: () => {

          const byUid = (isPerm || isBrand || isLimited) && c.uid;
          const r = Tower.applyPickBuff(pending.kind, byUid ? c.uid : c.id);
          if (!r.ok) notice(r.msg || '强化失败。');
          openEndless();
        },
      };
    });
    const title = isPerm ? (inscriptionMul ? (inscriptionName + ' · 选一个永久增益') : '附魔 · 选一个永久增益')
      : isBrand ? (inscriptionName + ' · 选一个烙印')
        : isLimited ? (inscriptionName + ' · 选一个限次增益')
          : ('三选一 · ' + label + '强化');

    const body = isPerm
      ? (inscriptionMul
        ? '选一个永久增益：被选中的这一条本局效果 ×' + inscriptionMul + '。'
        : '选一个永久增益：被选中的这一条本局不再占用永久位。')
        + (doneCount ? '标着「已附魔」的再选没有收益。' : '')
      : isBrand ? '从下面这些烙印里选一个：它**立刻破碎**（同一烙印有几份就一起破碎；破碎是升级 —— 每份都变成全额并永久保留）。'
        : isLimited ? '从下面这些限次增益里选一个：它的**剩余场次 +' + (Number(pending.addUses) || 5) +
          '**（烙印类不参与：它们没有「场次」这个概念）。'
          : (pending.kind === 'skill'
            ? '从下面三个技能里选一个：主动技的触发概率大幅提升；防御技（绝对防御 / 龟甲术）另按被动触发概率加成；'
              + '小宇宙爆发则是「战斗开始后第一招必定放它」（本局有效）。'
            : '从下面三把武器里选一个：它的伤害 +100%（本局有效）。');
    modal(title, '<p>' + esc(body) + '</p>', buttons, { small: true });
  }

  const RARITY_SHORT = ['普通', '稀有', '史诗', '传奇'];
  // ⚠ 位置有约束：`test-fixes-round.cjs` 的「需求38」按两个源码锚点切一段出来单独跑
  // 挪到 buffTag 旁边会让那段切片缺依赖，那条用例会直接红。
  function enchMark(b) {
    const free = !!(b && b.slotFree === true);
    const mul = Number(b && b.enchMul) || 1;
    return {
      free: free, mul: mul, crys: mul > 1,
      freeHtml: free ? '<b class="rp-free">虚空铭文 · 不占位</b>' : '',
      crysHtml: mul > 1 ? '<b class="rp-crys">水晶铭文 · 效果 ×' + mul + '</b>' : '',
      freeHint: free ? '<em class="slot-free-hint">虚空铭文 · 不占位</em>' : '',
      crysHint: mul > 1 ? '<em class="crystal-hint">水晶铭文 · 效果 ×' + mul + '</em>' : '',
    };
  }

  function offerPermanentReplace(opts) {
    const o = opts || {};

    const list = orderPermanent(Tower.ownedBuffs('endless').filter((b) => b.kind === 'permanent'));
    if (!list.length) { notice('没有可以拿掉的永久增益。'); if (o.onCancel) o.onCancel(); return null; }
    const rows = list.map((b, i) => {
      const em = enchMark(b);
      return '<button type="button" class="replace-pick r' + b.rarity + '" data-action="rp' + i + '"' +
        ' title="' + esc(b.name + '：' + (b.desc || '')) + '">' +
        '<span class="rp-name">' + esc(b.name) + '</span>' +
        '<span class="rp-meta">' + (RARITY_SHORT[b.rarity] || '') +
          (b.stacks > 1 ? ' · ×' + b.stacks + ' 层' : '') +
          (em.free ? ' · ' + em.freeHtml : '') +
          (em.crys ? ' · ' + em.crysHtml : '') + '</span>' +
        '<span class="rp-desc">' + esc(b.desc || '') + '</span>' +
        '</button>';
    }).join('');
    const m = modal(o.title || '永久增益已满',
      '<p>' + o.prompt + '</p>' +
      '<div class="replace-pick-list">' + rows + '</div>' +
      '<p class="small-label">点一行把它拿掉' + (o.footNote ? '　·　' + o.footNote : '') + '</p>',
      [{ label: '取消', cls: 'muted', run: () => { if (o.onCancel) o.onCancel(); } }], { small: true });

    if (m && m.element) {
      const actions = {};
      list.forEach((b, i) => { actions['rp' + i] = () => { m.close(); o.onPick(b); }; });
      C().bind(m.element, actions);
    }
    return m;
  }


  function patrolRowHtml(c, idx) {

    const em = enchMark(c);

    const cat = c.cat === 'insc' ? '铭文'
      : (c.kind === 'limited' ? '限次' : '永久');
    const bits = [RARITY_SHORT[c.rarity] || '', cat];
    if (c.cat === 'insc') {
      bits.push('已附魔 ' + Math.max(1, Number(c.alive) || 1) + ' 条');
    } else if (c.cat === 'brand') {
      bits.push('已损毁 ×' + Math.max(1, Number(c.broken) || 1) + '（交出掉 1 层）');
    } else {
      if (c.stacks > 1) bits.push('×' + c.stacks + ' 层' + (Number(c.broken) > 0 ? '（含已损毁 ' + c.broken + '）' : '') + '（只掉 1 层）');
      if (em.free) bits.push(em.freeHtml);
      if (em.crys) bits.push(em.crysHtml);
    }
    return '<button type="button" class="replace-pick r' + c.rarity + '" data-action="pt' + idx + '"' +
      ' title="' + esc(c.name + '（' + bits.filter((x) => x && x.indexOf('<') < 0).join('·') + '）') + '">' +
      '<span class="rp-name">' + esc(c.name) + '</span>' +
      '<span class="rp-meta">' + bits.join(' · ') + '</span>' +
      '</button>';
  }

  function patrolListHtml(list) {
    return '<div class="replace-pick-list">' + list.map((c, i) => patrolRowHtml(c, i)).join('') + '</div>';
  }
  function openPatrolToll() {
    const info = Tower.endlessInfo();
    const run = info && info.run;
    const got = Tower.patrolTollCandidates();
    if (!got || !got.list.length) {
      Tower.finishPatrolToll();
      openEndless();
      return null;
    }
    const draw = () => {
      const body = '<p>巡逻失手 —— 交出一个<b>' + (RARITY_SHORT[got.top] || '') + '</b>增益' +
        patrolListHtml(got.list);
      const m = modal('巡逻 · 上交一个增益', body, [{ label: '稍后再说', cls: 'muted', run: () => openEndless() }], { small: true });
      if (!m || !m.element) return;
      const actions = {};
      got.list.forEach((c, idx) => {
        actions['pt' + idx] = () => {
          const r = Tower.payPatrolToll(c.ref);
          if (!r.ok) { notice(r.msg || '上交失败。'); return; }
          m.close();
          if (r.needDiscard) { openPatrolDiscard(); return; }
          Tower.finishPatrolToll();

          const what = c.cat === 'insc' ? '（随机取消一份附魔）'
            : (r.broken ? '（已损毁层 -1' + (r.backToPool ? '，并退回增益池' : '') + '）'
              : (r.removed ? '（整栏交出）' : '（掉 1 层）'));
          notice('【' + (r.name || '增益') + '】已上交' + what + '，继续巡逻。',
            [{ label: '继续', cls: 'gold', run: () => openEndless() }]);
        };
      });
      C().bind(m.element, actions);
    };
    draw();
    return run;
  }
  function openPatrolDiscard() {
    const list = orderPermanent(Tower.ownedBuffs('endless').filter((b) => b.kind === 'permanent'));
    if (!list.length) { Tower.finishPatrolToll(); openEndless(); return null; }
    const draw = () => {
      const rows = list.map((b, i) => {
        const em = enchMark(b);
        return '<button type="button" class="replace-pick r' + b.rarity + '" data-action="pd' + i + '"' +
          ' title="' + esc(b.name + '：' + (b.desc || '')) + '">' +
          '<span class="rp-name">' + esc(b.name) + '</span>' +
          '<span class="rp-meta">' + (RARITY_SHORT[b.rarity] || '') + (b.stacks > 1 ? ' · ×' + b.stacks + ' 层' : '') +
            (em.free ? ' · ' + em.freeHtml : '') + (em.crys ? ' · ' + em.crysHtml : '') + '</span>' +
          '<span class="rp-desc">' + esc(b.desc || '') + '</span></button>';
      }).join('');
      const m = modal('背包满了 · 丢一个',
        '<p>虚空铭文被收走了，它的「不占位」也随之失效 —— 永久位装不下了，丢掉一个：</p>' +
        '<div class="replace-pick-list">' + rows + '</div>', [{ label: '稍后再说', cls: 'muted', run: () => openEndless() }], { small: true });
      if (!m || !m.element) return;
      const actions = {};
      list.forEach((b, i) => {
        actions['pd' + i] = () => {
          const r = Tower.debugLoseBuff(b.uid);
          m.close();
          Tower.finishPatrolToll();
          notice('丢掉了【' + b.name + '】' + (r && r.ok ? '' : '（失败）'), [{ label: '继续', cls: 'gold', run: () => openEndless() }]);
        };
      });
      C().bind(m.element, actions);
    };
    draw();
    return null;
  }

  function offerShopReplace(index, buff) {
    offerPermanentReplace({
      prompt: '要买下【' + esc(buff.name) + '】，先拿掉下面哪一个？',
      footNote: '被换掉的那个会从构筑里移除（成长类增益的累计也一起清零）',
      onPick: (b) => {
        const r = Tower.buyShopSlot(index, rowRef(b));
        if (!r.ok) notice(r.msg || '买不了。');
        openShop(true);
      },
      onCancel: () => openShop(true),
    });
  }

  function offerReplace(index, buff) {
    offerPermanentReplace({
      prompt: '要拿下【' + esc(buff.name) + '】，先拿掉下面哪一个？',
      footNote: '被换掉的那个会从构筑里移除（成长类增益的累计也一起清零）',
      onPick: (b) => { Tower.pickChoice('endless', index, rowRef(b)); openEndless(); },
      onCancel: () => openEndless(),
    });
  }


  function milestoneModal(rw, next) {
    const m = rw.milestone;
    const icon = C().icon ? C().icon('prop', m.propId) : '';
    const blackLine = (!State.blackGearEnabled() || !rw.black)
      ? ''
      : (rw.black.gain
        ? '<div class="result-lines">黑装：黑色卡片 ×' + rw.black.gain + '（本周剩 ' + rw.black.left + '/' + rw.black.cap + '）</div>'
        : '<div class="result-lines">黑装：本周黑色卡片已达上限（' + rw.black.cap + '/' + rw.black.cap + '）</div>');
    modal('第 ' + rw.layer + ' 层 · 里程碑奖励', '<div class="result-box"><div class="result-title win">再进一步</div>' +
      '<p>你爬到了第 ' + rw.layer + ' 层，结算奖励随机抽取：</p>' +
      '<p class="milestone-reward">' + icon + '<b>' + esc(m.name) + '</b> ×' + m.count + '</p>' +
      blackLine +
      '<div class="result-lines">已放入背包（每 10 层一次）</div></div>',
      [{ label: '继续', cls: 'gold', run: next }], { small: true });
  }
  // 上一场失利的唯一出口：只能重新挑战或放弃本局（没有右上角关闭叉）。
  // ⚠ 这里不能给「关闭」这条路：关掉之后 `run` 还在、`nextBattle` 以前会直接放行，
  function endlessRetryOffer(rw) {
    const run = (Tower.endlessInfo().run) || {};
    const layer = Math.max(1, Math.floor(Number(rw && rw.layer) || Number(run.layer) || 1));
    const battleNo = Math.max(1, Math.floor(Number(rw && rw.battleNo) || Number(run.battleNo) || 1));
    const battleCount = Math.max(1, Math.floor(Number(rw && rw.battleCount) || Number(run.battleCount) || 4));
    const score = Math.max(0, Math.floor(Number(rw && rw.score != null ? rw.score : run.score) || 0));
    const retryLeft = Math.max(0, Math.floor(Number(rw && rw.retryLeft != null ? rw.retryLeft : run.retryToken) || 0));
    const m = modal('本场失利 · 可以重新挑战',
      '<div class="result-box"><div class="result-title lose">再试一次？</div>' +
      '<p>倒在第 ' + layer + ' 层第 ' + battleNo + '/' + battleCount + ' 场。</p>' +
      '<p class="gold-text">消耗 1 枚铸币，回滚到本场开始前（血量 / 试炼币 / 分数 / 增益次数全部还原），' +
      '回到开战前的准备页 —— 敌人、环境与构筑都能重新看一遍，确认后再点「继续战斗」。</p>' +
      '<div class="result-lines">现有铸币 <b>' + retryLeft + '</b> 枚 · 本局分数 ' + score +
      ' · ' + (ONLINE ? '联机版放弃本局按已通过层数结算抽奖卷（每 10 层 1 张，周限 10 张）' : '选「放弃本局」也一样按当前层应得 + 试炼币折现结算') + '</div></div>',
      [{ label: '重新挑战', cls: 'gold', run: () => {
          retryOfferOpen = false; retryOfferEl = null;
          const r = Tower.retryBattle();
          if (!r.ok) {
            notice(r.msg || '回滚失败。');
            return;
          }
          // （敌人预告 / 血量 / 增益 / 环境 / 分数都能重新看），玩家确认构筑后再自己点
          // ⚠ 别在这里补 `fight('endless')`：上一版就是回滚后立刻开打，玩家没有调整余地。
          reopen('endless');
          runToast('已回滚到本场开始前，确认敌人与构筑后再点「继续战斗」。');
        } },
       { label: '放弃本局', cls: 'muted', run: () => {
          retryOfferOpen = false; retryOfferEl = null;
          const out = Tower.declineRetry();
          endlessDefeat(out);
        } }], { small: true, locked: true });
    retryOfferEl = (m && m.element) || null;
    retryOfferOpen = !!retryOfferEl;
  }
  function endlessDefeat(rw) {
    settleResult(rw);
  }

  function closeBladeOffer() {
    bladeOfferOpen = false;
    bladeOfferEl = null;
  }

  // 挨饿：剑吞掉 1 次使用次数（没有祭品或玩家选择不给时的老口径）。
  function bladeStarveToast(r, info) {
    const name = (r && r.name) || (info && info.name) || '渴血之剑';
    const msg = r && r.ok
      ? ('没有献祭：' + name + ' 吞噬 ' + Math.max(1, Number(r.consumed) || 1) + ' 次使用次数' +
        (r.evolved ? ('，进化为「' + r.evolved.name + '」')
          : (r.uses > 0 ? ('（剩余 ' + r.uses + ' 场）') : '')) + '。')
      : ((r && r.msg) || '献祭失败。');
    notice(msg, [{ label: '继续', cls: 'gold', run: openEndless }]);
  }

  function openBladeSacrifice() {
    if (bladeOfferVisible()) return;
    // 先占坑再建弹层：`modal()` 挂到 #ui 之后，若是重画触发的第二轮 openEndless
    bladeOfferOpen = true;
    const got = Tower.bladeSacrificeCandidates();
    const list = (got && got.list) || [];
    const info = (got && got.blade) || (Tower.bladeInfoOf ? Tower.bladeInfoOf() : null) || {};
    // 献祭武技：10 级以上、且不是最后一招；只在这里当「额外选项」。
    const skills = (got && got.skills) || [];
    if (!list.length && !skills.length) {
      bladeStarveToast(Tower.sacrificeBlade(null), info);
      bladeOfferOpen = false;
      bladeOfferEl = null;
      return;
    }
    const rows = list.map((c, i) => {
      const bits = [RARITY_SHORT[c.rarity] || '', c.kind === 'limited' ? '限次' : '永久'];
      if (c.meta) bits.push(c.meta);
      return '<button type="button" class="replace-pick r' + c.rarity + '" data-action="bl' + i + '"' +
        ' title="' + esc(c.name + '：' + (c.meta || '')) + '">' +
        '<span class="rp-name">' + esc(c.name) + '</span>' +
        '<span class="rp-meta">' + bits.join(' · ') + '</span>' +
        (c.inscription ? '<span class="rp-desc">优先消耗铭文，增益本身保留</span>' : '') +
        '</button>';
    }).join('');
    // 武技行与增益行同列：一块列表比两个分区省高度，也不会把某一类选项整块推到视区外。
    const skillRows = skills.map((c, i) =>
      '<button type="button" class="replace-pick blade-skill-pick" data-action="bs' + i + '"' +
      ' title="' + esc(c.name + '：' + (c.meta || '')) + '">' +
      '<span class="rp-name">' + esc(c.name) + '</span>' +
      '<span class="rp-meta">' + esc(c.meta || '') + '</span>' +
      '<span class="rp-desc">献祭武技：这一招从本局消失，且永远不会再被领悟</span>' +
      '</button>').join('');
    const offers = rows + skillRows;
    const runHero = ((Tower.endlessInfo() || {}).run || {}).hero;
    const bannedNames = (got && got.heroMode && runHero && window.TowerHero && TowerHero.bannedSkills
      ? TowerHero.bannedSkills(runHero) : [])
      .map((id) => { try { const inst = State.skillInst ? State.skillInst(Number(id)) : null; return inst && inst.name; } catch (e) { return null; } })
      .filter(Boolean);
    const tips = ['当前成长 ×' + Math.max(1, Number(info.stacks) || 1) + ' 层 · 剩余 ' +
      (info.unlimited ? '永续' : (info.uses + ' 场')) + '。'];
    if (list.length) tips.push('叠层只吃一件；带铭文的永久增益先吃铭文。');
    if (skills.length) tips.push('武技献祭后本局永久移除。');
    if (!list.length) tips.push('不想给就让它挨饿（吞 1 次使用次数）。');
    if (bannedNames.length) tips.push('已献祭：' + bannedNames.join('、') + '。');
    const m = modal('渴血之剑 · 献祭',
      '<div class="result-box"><div class="result-title lose">它饿了</div>' +
      '<p>剑脊上的暗红仍未褪去，它要一件祭品。</p></div>' +
      '<div class="replace-pick-list">' + offers + '</div>' +
      '<p class="small-label">' + esc(tips.join(' ')) + '</p>',
      (!list.length ? [{ label: '让它挨饿', cls: 'muted', run: () => {
        const r = Tower.sacrificeBlade(null);
        m.close();
        closeBladeOffer();
        bladeStarveToast(r, info);
      } }] : []), { small: true, locked: true });
    if (m && m.element) {
      // 这个弹窗要同时装下增益 + 武技两排选项：给足高度，别让选项落在滚动区外面。
      m.element.classList.add('blade-sacrifice-modal');
      const actions = {};
      list.forEach((c, i) => {
        actions['bl' + i] = () => {
          const r = Tower.sacrificeBlade(c.ref);
          if (!r.ok) { notice(r.msg || '献祭失败。'); return; }
          m.close();
          closeBladeOffer();
          notice('【' + c.name + '】已献祭 · 渴血之剑成长至 ×' + r.stacks + ' 层' +
            (r.used && r.used.partial ? '（消耗 ' + r.used.consumed + ' 场，剩余 ' + r.used.uses + ' 场）' : '') +
            (r.used && r.used.kind === 'inscription' ? '（铭文被吞掉，增益保留）' : '') + '。',
            [{ label: '继续', cls: 'gold', run: openEndless }]);
        };
      });
      skills.forEach((c, i) => {
        actions['bs' + i] = () => {
          const r = Tower.sacrificeBlade(c.ref);
          if (!r.ok) { notice(r.msg || '献祭失败。'); return; }
          m.close();
          closeBladeOffer();
          notice('武技【' + c.name + '】已献祭 · 渴血之剑成长至 ×' + r.stacks + ' 层' +
            '。这一招已从本局移除，不会再被领悟。',
            [{ label: '继续', cls: 'gold', run: openEndless }]);
        };
      });
      C().bind(m.element, actions);
    }
    bladeOfferEl = (m && m.element) || null;
    if (!bladeOfferEl) bladeOfferOpen = false;
  }

  function openBladeEvent() {
    if (bladeOfferVisible()) return;
    bladeOfferOpen = true;
    const info = Tower.bladeInfoOf ? Tower.bladeInfoOf() : null;
    if (!info) { bladeOfferOpen = false; openEndless(); return; }
    const streak = Math.max(0, Number(info.suppressStreak) || 0);
    const m = modal('渴血之剑 · 活性',
      '<div class="result-box"><div class="result-title">剑在呼吸</div>' +
      '<p>「' + esc(info.name) + '」在鞘中一下一下地搏动，暗红的光沿着裂纹游走。</p>' +
      '<p>你可以压住它，也可以再喂它一口。</p>' +
      '<div class="result-lines">当前成长 ×' + info.stacks + ' 层 · 剩余 ' +
      (info.unlimited ? '永续' : info.uses + ' 场') + ' · 连续抑制 ' + streak + '/3</div></div>',
      [{ label: '抑制活性', cls: 'muted', run: () => {
          const r = Tower.resolveBladeEvent('suppress');
          closeBladeOffer();
          notice(r && r.ok
            ? (r.dead ? '连续三次抑制：渴血之剑彻底失活，化为「涸血之剑」。'
              : '你压住了剑的活性（' + r.streak + '/3）。')
            : ((r && r.msg) || '无法抑制。'), [{ label: '继续', cls: 'gold', run: openEndless }]);
        } },
       { label: '增强活性', cls: 'gold', run: () => {
          const r = Tower.resolveBladeEvent('enhance');
          closeBladeOffer();
          notice(r && r.ok
            ? (r.evolved ? ('剑的活性大增，进化为「' + r.evolved.name + '」。')
              : ('你增强了剑的活性：使用次数 −' + (TowerData.BLADE ? TowerData.BLADE.enhanceUses : 3) + '。'))
            : ((r && r.msg) || '无法增强。'), [{ label: '继续', cls: 'gold', run: openEndless }]);
        } }], { small: true, locked: true });
    bladeOfferEl = (m && m.element) || null;
    if (!bladeOfferEl) bladeOfferOpen = false;
  }




  function shopSpendToast(spend) {
    if (!spend) return;
    const got = spend.limited;
    if (got && got.length) {
      runToast('豪掷千金：获得「' + got.map((id) => (TowerData.BUFF_BY_ID[id] || {}).name || id).join('」「') + '」');
    }
    const gained = spend.gained;
    if (gained && gained.length) {
      const mm = (TowerData.BUFF_BY_ID.C36 || {}).mods || {};
      const add = { power: 0, agility: 0, speed: 0, hp: 0 };
      for (const k of gained) {
        if (add[k] === undefined) continue;
        add[k] += (k === 'hp' ? Number(mm.shopSpendHp) || 5 : Number(mm.shopSpendStat) || 1);
      }
      const label = { power: '力量', agility: '敏捷', speed: '速度', hp: '生命上限' };
      const txt = ['power', 'agility', 'speed', 'hp'].filter((k) => add[k] > 0)
        .map((k) => label[k] + ' +' + add[k]).join('、');
      if (txt) runToast('挥金如土：' + txt);
    }
  }
  function openShop(revisit) {
    const shop = Tower.shopState();
    if (!shop) { notice('商店还没开张：每通过 5 层开放一次。'); return; }

    if (shop.mint) { openMintShop(); return; }
    // 门庭若市（C59）：进门就给试炼币 —— 由 Tower 领取并清零，保证只飘一次字
    // （shopState() 是快照，往它上面写标记不会生效）。
    const enterCoins = Tower.claimShopEnterCoins ? Tower.claimShopEnterCoins() : 0;
    if (enterCoins > 0) runToast('门庭若市：进店获得 ' + enterCoins + ' 试炼币');
    const rarityCls = (r) => 'r' + r;
    // 注意：这是商店槽位上报行的字段 canStack（由 tower.js 用标签算好），
    // 不是增益数据里的字段 —— 旧数据字段 stackable 已经删掉、只留标签。
    const stackableOwned = (s) => s.ownedStacks > 0 && s.canStack;
    const slots = shop.slots.map((s, i) =>
      '<div class="shop-slot ' + rarityCls(s.rarity) + (s.sold ? ' sold' : '') +
        (stackableOwned(s) ? ' owned-stack' : '') + (s.half ? ' half' : '') + '"' +
        (s.half ? ' title="讨价还价：对折（原价 ' + s.listPrice + ' 币）"' : '') + '><b>' + esc(s.name) + '</b>' +
      '<i>' + RARITY[s.rarity] + ' · ' + (SCOPE[s.kind] || '增益') + '</i>' +

      (s.half ? '<em class="half-badge" title="原价 ' + s.listPrice + ' 币">对折</em>' : '') +

      '<span class="shop-desc" title="' + esc(s.desc) + '">' + esc(s.desc) + '</span>' +
      (stackableOwned(s) ? '<em class="stack-hint">已有 ×' + s.ownedStacks + ' · 可叠层</em>' : '') +
      (s.sold ? '<em>已购入</em>' : C().btn(s.price + ' 币', 'buy' + i, 'small gold')) + '</div>').join('');

    const owned = Tower.sellListOf('endless');
    const sellRows = owned.length ? owned.map((b) =>
      '<div class="shop-sell-row' + (b.slotFree ? ' slot-free' : '') + '">' + buffTag(b, b.stacks) +
      enchMark(b).freeHint + enchMark(b).crysHint +
      C().btn('卖出 +' + b.sellPrice, 'sell' + rowRef(b), 'tiny muted') + '</div>').join('') :
      '<div class="small-label">还没有可出售的增益</div>';
    const content = '<div class="tower-shop">' +
      '<h2 class="tower-title">试炼商店 <span class="shop-coins">试炼币 ' + shop.coins + '</span></h2>' +

      shopTierHint(shop.layer, shop.slots.length) +
      '<div class="shop-shelf">' + slots + '</div>' +
      '<div class="shop-extra">' +
      '<div class="shop-slot retry' + (shop.retrySold ? ' sold' : '') + '"><b>铸币</b>' +
      '<i>每次商店限购 1 枚 · 已有 ' + shop.retryToken + ' 枚</i>' +
      '<span>失败时消耗 1 枚，回滚到该场战斗开始前再打一次</span>' +
      (shop.retrySold ? '<em>已购买</em>' : C().btn(shop.retryPrice + ' 币', 'retry', 'small gold')) + '</div>' +
      '<div class="shop-slot reroll"><b>刷新货架</b>' +
      '<i>第 ' + (shop.rerollCount + 1) + ' 次刷新 · ' +
      (shop.rerollFree ? '本次免费' : '本次 ' + shop.rerollNextPrice + ' 币') + '</i>' +

      '<span>' + (shop.halfPerPage > 0
        ? '新一页同样有 ' + shop.halfPerPage + ' 件对折'
        : '已售出的不再出现；限次可重复刷出') + '</span>' +
      C().btn(shop.rerollFree ? '免费刷新' : shop.rerollNextPrice + ' 币刷新', 'reroll', 'small') + '</div></div>' +
      '<h4>出售增益（回收 40%，限次与永久都可卖）</h4>' +
      '<div class="shop-sell">' + sellRows + '</div>' +
      '</div>';
    const ct = classicTower();
    const p = C().page('challenge', 'stages', content, Object.assign({
      cls: 'tower-board',
      pageClass: 'tower-shop-page',
      left: (!revisit && !shop.rest)
        ? '<span class="footer-left">' + C().btn('结算离场', 'settle', 'small gold') + '</span>' : '',
      right: '<span class="footer-right">' + C().btn(revisit || shop.rest ? '返回' : '继续挑战', 'leave', 'gold') + '</span>',
    }, ct ? { noTabs: true, pageClass: 'classic-tower tower-shop-page', homeLabel: '返回' } : {}));
    back(p, () => openEndless(), '返回');

    if (ct) applyClassicTowerBg(p, 'endless', shop.layer);
    const buyTrial = (i, heroChoice) => {
      const r = Tower.buyShopSlot(i, undefined, heroChoice ? { heroChoice: heroChoice } : undefined);
      if (r && r.needsReplace) { offerShopReplace(i, r.buff); return; }
      if (!r.ok) { notice(r.msg || '买不了。'); return; }
      shopSpendToast(r.shopSpend);
      if (r.msg && Tower.endlessInfo().run && Tower.endlessInfo().run.ruleset === 'hero') runToast(r.msg);
      openShop(revisit);
    };
    shop.slots.forEach((s, i) => on(p, 'buy' + i, () => {
      const run = Tower.endlessInfo().run;
      if (heroGoodsBeforeBuy(s.id, run, (choice) => buyTrial(i, choice))) return;
      buyTrial(i);
    }));
    on(p, 'retry', () => {
      const r = Tower.buyRetryToken();
      if (!r.ok) notice(r.msg || '买不了。');
      else {
        notice('已购买铸币（现有 ' + r.left + ' 枚）。失败时可以选择回滚本场再打一次。');
        shopSpendToast(r.shopSpend);
      }
      openShop(revisit);
    });
    on(p, 'reroll', () => {
      const r = Tower.rerollShop();
      if (!r.ok) notice(r.msg || '刷新失败。');
      else {

        if (r.paid > 0) notice('已花 ' + r.paid + ' 币刷新' +
          (r.nextPrice !== r.paid ? ' · 下次 ' + r.nextPrice + ' 币' : ''));
        shopSpendToast(r.shopSpend);
      }
      openShop(revisit);
    });
    owned.forEach((b) => on(p, 'sell' + rowRef(b), () => { Tower.sellBuff(rowRef(b)); openShop(revisit); }));
    on(p, 'leave', () => {
      // 休整商店 / 战后立即进货（E01）/ 立即开店 —— 关掉后回去继续打这一层；
      // 必须真的把店关掉（Tower.closeShop / continueFromShop 都会收摊）：
      if (revisit || shop.rest || shop.postBattle || !shop.boundary) {
        Tower.closeShop();
        openEndless();
        return;
      }
      Tower.continueFromShop();
      openEndless();
    });
    bindShopSettle(p);
  }


  function bindShopSettle(p) {
    on(p, 'settle', () => {
      const out = Tower.settleFromShop();
      if (!out || !out.ok) { notice('现在还不能结算。'); return; }
      settleResult(out);
    });
  }




  function afterMintAction(text, r) {
    openEndless();
    runToast(text);
    if (r && r.pendingPick) openPickBuff(r.pendingPick);
  }

  function offerMintReplace(index, buff) {
    offerPermanentReplace({
      prompt: '要买下【' + esc(buff.name) + '】，先拿掉下面哪一个？',
      footNote: '被换掉的那个会从构筑里移除（成长类增益的累计也一起清零）',
      onPick: (b) => {
        const r = Tower.buyMintSlot(index, b.id);
        if (!r.ok) { notice(r.msg || '买不了。'); openMintShop(); return; }
        afterMintAction('买下了【' + r.buff.name + '】（铸币 −' + r.price + '）', r);
      },
      onCancel: () => openMintShop(),
    });
  }
  // 「等价交换」的确认：换回什么是当场摇的，所以这里只确认「要不要拿它去换」。
  function confirmMintSwap(b) {
    modal('等价交换', '<p>把【' + esc(b.name) + '】（' + (RARITY[b.rarity] || '') + '）拿出去，换回一件新的？</p>' +
      '<p class="small-label">大概率换回**同稀有度的运营类**增益（普通件有 50% 升成稀有件），' +
      '小概率换回同稀有度的非运营增益。换完之后这家铸币商店立刻就走。</p>',
      [{ label: '再想想', cls: 'muted', run: () => openMintShop() },
       { label: '交换', cls: 'gold', run: () => {
         const r = Tower.swapMintBuff(rowRef(b));
         if (!r.ok) { notice(r.msg || '换不了。'); openMintShop(); return; }
         openEndless();
         modal('交换成功', '<div class="result-box"><div class="result-title win">换到了</div>' +
           '<p class="dim">拿出去：' + esc(r.fromName) + '（' + (RARITY[r.fromRarity] || '') + '）</p>' +
           '<p>换回：<b class="q' + (r.buff.rarity || 0) + '">' + esc(r.buff.name) + '</b>' +
           '（' + (RARITY[r.buff.rarity] || '') + (TowerData.hasTag(r.buff, 'ops') ? ' · 运营类' : '') + '）</p>' +
           '<p class="small-label">' + esc(TowerData.descOf(r.buff, 'endless')) + '</p></div>',
           [{ label: '继续冲塔', cls: 'gold', run: () => { if (r.pendingPick) openPickBuff(r.pendingPick); } }], { small: true });
       } }], { small: true });
  }
  function openMintShop(flash) {
    const shop = Tower.shopState();
    if (!shop || !shop.mint) { openEndless(); return; }

    const enterCoins = Tower.claimShopEnterCoins ? Tower.claimShopEnterCoins() : 0;
    if (enterCoins > 0) runToast('门庭若市：进店获得 ' + enterCoins + ' 试炼币');
    const rarityCls = (r) => 'r' + r;
    const slots = shop.slots.map((s, i) =>
      '<div class="shop-slot ' + (s.swap ? 'swap' : rarityCls(s.rarity)) + (s.ops ? ' ops' : '') +
        (s.sold ? ' sold' : '') + (s.half ? ' half' : '') + '">' +
      '<b>' + esc(s.name) + '</b>' +
      (s.swap
        ? '<i>服务 · 售价 0 铸币 · 仅在铸币商店出现</i>'
        : '<i>' + (RARITY[s.rarity] || '') + ' · ' + (SCOPE[s.kind] || '增益') + (s.ops ? ' · 运营' : '') + '</i>') +
      '<span class="shop-desc" title="' + esc(s.desc) + '">' + esc(s.desc) + '</span>' +
      (s.half ? '<em class="half-hint">讨价还价 · 对折（原价 ' + s.listPrice + ' 铸币）</em>' : '') +
      (s.sold ? '<em>已购入</em>'
        : s.swap && !shop.swapCandidates ? '<em class="mint-locked">暂无可交换的增益</em>'
        : C().btn(s.swap ? '免费交换' : (s.price > 0 ? (s.price + ' 铸币') : '免费拿走'), 'mintbuy' + i, 'small gold')) + '</div>').join('');

    const owned = shop.swapOpen ? Tower.sellListOf('endless') : [];
    const swapRows = owned.length ? owned.map((b) =>
      '<div class="shop-sell-row' + (b.slotFree ? ' slot-free' : '') + '">' + buffTag(b, b.stacks) +
      enchMark(b).freeHint + enchMark(b).crysHint +
      C().btn('拿它交换', 'mintswap' + rowRef(b), 'tiny') + '</div>').join('')
      : (shop.swapOpen ? '<div class="small-label">还没有可以交换的永久 / 限次增益</div>' : '');
    const content = '<div class="tower-shop mint">' +
      '<h2 class="tower-title">铸币商店 <span class="shop-coins">铸币 ' + shop.retryToken + '</span>' +
        '<span class="mint-coins">试炼币 ' + Math.max(0, Math.floor(Number(shop.coins) || 0)) + '</span></h2>' +
      '<p class="mint-lead">战后偶遇的流动商人：第一格固定是 <b>0 铸币的「等价交换」</b> —— ' +
        '买下它，挑一件自己的永久 / 限次增益换一件新的；或者直接花铸币买别的货。' +
        '任意一次成交后他立刻就走（也可以直接送客）。</p>' +

      (shop.byBuff ? '<p class="mint-flash">限次增益「铸币商队」触发的商队' +
        (shop.boundary ? '：它顶掉了这一段的结算商店，送客后照旧前往结算点' : '') + '。</p>' : '') +
      (flash ? '<p class="mint-flash">' + esc(flash) + '</p>' : '') +

      '<p class="shop-tier">铸币商店货架固定 <b>' + Math.max(1, Number((TowerData.MINT_SHOP || {}).shelf) || 5) +
        '</b> 件（不吃试炼商店的按层分档）</p>' +
      '<div class="shop-shelf">' + slots + '</div>' +
      '<div class="shop-extra">' +
      '<div class="shop-slot reroll' + (shop.rerollFree ? '' : ' sold') + '"><b>刷新货架</b>' +
      '<i>' + (shop.rerollFree ? '免费刷新 · 还剩 1 次' : '免费刷新已用掉') + '</i>' +
      '<span>' + (shop.rerollFree
        ? '重新摇一车货（稀有度分布不变，普通档概率依旧被压低）。<b>刷新后「等价交换」不再固定第一格，' +
          '只会按概率洗进随机货架。</b>'
        : '这支商队不再刷新，只能挑货、交换或送客。') +
        (shop.halfPerPage > 0 ? '<b>讨价还价：新一页同样有 ' + shop.halfPerPage + ' 件对折。</b>' : '') + '</span>' +
      (shop.rerollFree ? C().btn('免费刷新', 'mintreroll', 'small') : '<em>已刷新</em>') + '</div>' +
      '<div class="shop-slot price"><b>价格表</b><i>按稀有度固定 · 不吃折扣</i>' +
      '<span>普通 ' + shop.mintPrices[0] + ' / 稀有 ' + shop.mintPrices[1] + ' / 史诗 ' + shop.mintPrices[2] +
        ' / 传奇 ' + shop.mintPrices[3] + ' 铸币。' +
        '「等价交换」固定 0 铸币；铸币可在试炼商店左下角用 50 试炼币换取1。</span></div>' +
      '</div>' +
      (shop.swapOpen
        ? '<h4>等价交换：选择一件拿出去的增益</h4>' +
          '<p class="small-label">大概率换回同稀有度的<b>运营类</b>增益（普通件有 50% 升成稀有件），' +
          '小概率换回同稀有度的非运营增益，永久与限次都能进行交换。</p>' +
          '<div class="shop-sell">' + swapRows + '</div>'
        : '') +
      '</div>';

    const ct = classicTower();
    const p = C().page('challenge', 'stages', content, Object.assign({ cls: 'tower-board',
      pageClass: 'tower-shop-page',
      left: shop.boundary
        ? '<span class="footer-left">' + C().btn('结算离场', 'settle', 'small gold') + '</span>' : '',
      right: '<span class="footer-right">' + C().btn('继续战斗', 'mintleave', 'gold') + '</span>' },
    ct ? { noTabs: true, pageClass: 'classic-tower tower-shop-page', homeLabel: '返回' } : {}));
    bindTips(p);

    back(p, () => openEndless(), '返回');
    if (ct) applyClassicTowerBg(p, 'endless', shop.layer);
    if (shop.boundary) bindShopSettle(p);
    const buyMint = (i, heroChoice) => {
      const r = Tower.buyMintSlot(i, undefined, heroChoice ? { heroChoice: heroChoice } : undefined);
      if (r && r.needsReplace) { offerMintReplace(i, r.buff); return; }
      if (r && r.swap) { openMintShop('已选中【等价交换】：挑一件自己的增益拿出去。'); return; }
      if (!r.ok) { notice(r.msg || '买不了。'); openMintShop(); return; }
      const text = '买下了【' + r.buff.name + '】（铸币 −' + r.price + '，剩 ' + r.left + ' 枚）' +
        (r.msg && Tower.endlessInfo().run && Tower.endlessInfo().run.ruleset === 'hero' ? ' · ' + r.msg : '');
      afterMintAction(text, r);
    };
    shop.slots.forEach((s, i) => on(p, 'mintbuy' + i, () => {
      const run = Tower.endlessInfo().run;
      if (heroGoodsBeforeBuy(s.id, run, (choice) => buyMint(i, choice))) return;
      buyMint(i);
    }));
    on(p, 'mintreroll', () => {
      const r = Tower.rerollMintShop();
      if (!r.ok) { notice(r.msg || '刷新失败。'); return; }
      openMintShop('货架换了一批 —— 「等价交换」不再固定第一格，只有洗到才会出现。');
    });
    owned.forEach((b) => on(p, 'mintswap' + rowRef(b), () => confirmMintSwap(b)));

    on(p, 'mintleave', () => { Tower.leaveMintShop(); openEndless(); });
  }



  function openPermSacrifice() {
    const info = Tower.endlessInfo();
    const run = info.run;
    if (!run || run.phase !== 'sacrifice') return;
    const candsAll = Tower.sacrificeCandidatesOf();
    if (!candsAll.length) {
      // 不能只 openEndless()：phase 还是 sacrifice 时它会再排一次这个函数，
      // 每次重画都重来一遍（旧档只有 C32/C33/C63 这类隐藏永久增益时必现）。
      const skipped = Tower.skipEmptySacrifice ? Tower.skipEmptySacrifice() : null;
      if (skipped && skipped.ok) runToast('没有可放弃的永久增益，本层代价已跳过。');
      openEndless();
      return;
    }

    const cands = orderPermanent(candsAll);
    const rows = cands.map((x) => {
      const b = x.buff;
      const stack = x.stacks > 1 ? ' <em class="sac-stack">×' + x.stacks + '</em>' : '';
      return '<button class="sac-card" data-sac="' + esc(rowRef(x)) + '">' +
        '<b class="q' + (b.rarity || 0) + '">' + esc(b.name) + '</b>' + stack +
        '<span class="sac-desc">' + esc(b.desc || '') + '</span></button>';
    }).join('');
    const p = modal('放弃一个永久增益',
      '<p class="sac-lead">你必须从随身藏品中选出一件，投入贡井。</p>' +
      '<p class="sac-lead dim">第 ' + esc(run.layer) + ' 层已通过。作为代价，必须永久放弃<b>一个</b>永久增益' +
      '（叠层的会先掉一层）。选中的增益会立刻从本局移除。</p>' +
      '<div class="sac-grid">' + rows + '</div>',
      [], { small: false, cls: 'sac-board' });
    p.element.querySelectorAll('[data-sac]').forEach((el) => {
      el.onclick = () => {
        const res = Tower.sacrificePerm(el.dataset.sac);
        if (!res.ok) { notice(res.msg || '放弃失败'); return; }
        p.close();
        if (res.lostMark) notice('碎掉的烙印失效：' + res.lostMark.label);
        openEndless();
      };
    });
  }



  function openCheckpoint() {
    const info = Tower.checkpointInfo();
    if (!info) { openEndless(); return; }
    if (ONLINE) {

      const pv = Tower.previewSettleTickets ? Tower.previewSettleTickets() : null;
      modal('结算点 · 第 ' + info.layer + ' 层', '<div class="checkpoint-box">' +
        '<div class="checkpoint-option"><b>结算离场</b><span>结束本局并结算抽奖卷（分数入账）。</span></div>' +
        '<div class="checkpoint-option"><b>继续挑战</b><span>继续向上攀登；结算时按本局最终通过层数一起算，' +
          '中途失败也按同一口径结算。</span></div>' +
        onlineTicketBlock(pv) +
        '<p class="small-label">本局分数 ' + info.score + ' · 试炼币 ' + info.coins + '</p></div>',
        [
          { label: '结算离场', cls: 'gold', run: () => { const r = Tower.settleEndless(); if (r.ok) settleResult(r); else openEndless(); } },
          { label: '继续挑战', run: () => { Tower.continueEndless(); fight('endless'); } },
        ], { locked: true });
      return;
    }
    modal('结算点 · 第 ' + info.layer + ' 层', '<div class="checkpoint-box">' +
      '<div class="checkpoint-option"><b>结算离场</b><span>立刻领取 <b class="gold-text">' + info.ticketsNowTotal + '</b> 张抽奖卷' +
        '（本层应得 ' + info.ticketsNow +
        (info.retryToken ? ' + 铸币 ' + info.retryToken + ' 枚 1:1 折现' : '') + '），本局结束（分数入账）</span></div>' +
      '<div class="checkpoint-option"><b>继续挑战</b><span>撑到第 ' + info.nextCheckpoint + ' 层本层应得升到 <b class="gold-text">' + info.ticketsNext + '</b> 张（试炼币照常折现）；中途失败也按同一口径结算</span></div>' +
      '<p class="small-label">本局分数 ' + info.score + ' · 试炼币 ' + info.coins + '</p></div>',
      [
        { label: '结算离场', cls: 'gold', run: () => { const r = Tower.settleEndless(); if (r.ok) settleResult(r); else openEndless(); } },
        { label: '继续挑战', run: () => { Tower.continueEndless(); fight('endless'); } },
      ], { locked: true });
  }
  // 每周最多 10 张（周一 0 点重置）。塔对局只在本机，真正的发奖必须等服务端
  function onlineTicketNumber(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  function onlineTicketBlock(pv) {
    if (!pv) return '';
    const n = onlineTicketNumber;
    const cap = n(pv.weekCap) || 10;
    const victoryBonus = n(pv.victoryBonus);
    const rows = [
      '<li><span>本局已通过 ' + n(pv.bestLayer) + ' 层（每 10 层 1 张）</span><b class="gold-text">' + n(pv.layerTickets) + ' 张</b></li>',
      n(pv.mint) > 10
        ? '<li><span>结算时铸币 ' + n(pv.mint) + ' 枚（超过 10 枚）</span><b class="gold-text">+1 张</b></li>'
        : '',
      victoryBonus > 0
        ? '<li><span>通过 100 层奖励（每周一次，不占周限）</span><b class="gold-text">+' + victoryBonus + ' 张</b></li>'
        : '',
      '<li><span>本周额度 ' + n(pv.weekTickets) + '/' + cap + '</span><b>' +
        (pv.capped ? '只剩 ' + n(pv.total - victoryBonus) + ' 张' : '可领 ' + n(pv.total - victoryBonus) + ' 张') + '</b></li>',
      '<li class="total"><span>结算到手</span><b>共 ' + n(pv.total) + ' 张抽奖卷</b></li>',
    ].filter(Boolean);
    return '<ul class="settle-calc">' + rows.join('') + '</ul>' +
      (pv.capped && n(pv.total - victoryBonus) === 0
        ? '<p class="small-label">本周 ' + cap + ' 张已满；百层奖励不占这 ' + cap + ' 张。</p>' : '') +
      (pv.victoryBonusUsed && victoryBonus === 0 && pv.trueEnd === true
        ? '<p class="small-label">本周百层奖励额外 2 张已领取。</p>' : '');
  }
  function applyOnlineClaim(summary, result) {
    if (!summary || !result) return summary;
    summary.onlineClaimDone = true;
    summary.onlineClaimState = 'done';
    summary.onlineClaimError = '';
    summary.tickets = onlineTicketNumber(result.granted);
    summary.rawTickets = onlineTicketNumber(result.raw);
    summary.layerTickets = onlineTicketNumber(result.layerTickets);
    summary.bonusTickets = onlineTicketNumber(result.mintBonus);
    summary.weekTickets = onlineTicketNumber(result.weekUsed);
    summary.weekCap = onlineTicketNumber(result.weekCap) || 10;
    summary.weekLeft = onlineTicketNumber(result.weekLeft);
    summary.ticketsCapped = result.capped === true;
    summary.trueEnd = result.trueEnd === true;
    summary.victoryBonus = onlineTicketNumber(result.victoryBonus);
    summary.victoryBonusUsed = result.victoryBonusUsed === true;
    if (result.ticketsTotal != null) summary.ticketsTotal = onlineTicketNumber(result.ticketsTotal);
    if (result.duplicate) summary.onlineClaimDuplicate = true;
    return summary;
  }
  // 把服务端结果写回本机保存的「上局战报」，下次从大厅重看也是实际到手。
  function persistOnlineClaim(summary) {
    if (!summary || !summary.id || !Tower.updateLastSummary) return false;
    return Tower.updateLastSummary(summary.id, {
      onlineClaimDone: true,
      onlineClaimState: 'done',
      onlineClaimError: '',
      tickets: summary.tickets,
      rawTickets: summary.rawTickets,
      layerTickets: summary.layerTickets,
      bonusTickets: summary.bonusTickets,
      weekTickets: summary.weekTickets,
      weekCap: summary.weekCap,
      weekLeft: summary.weekLeft,
      ticketsCapped: summary.ticketsCapped === true,
      trueEnd: summary.trueEnd === true,
      victoryBonus: summary.victoryBonus,
      victoryBonusUsed: summary.victoryBonusUsed === true,
      ticketsTotal: summary.ticketsTotal,
      onlineClaimDuplicate: summary.onlineClaimDuplicate === true,
    });
  }
  function summaryPageActive(summary) {
    if (!summary || activeSummary !== summary) return false;
    try { return !!(document && document.querySelector && document.querySelector('.endless-summary')); }
    catch (e) { return false; }
  }
  // 结算一次本局周奖励：先落本机队列（TowerOnline），再等服务端回包。
  function claimSummaryRewards(summary) {
    if (!ONLINE || !summary || summary.settled !== true || summary.onlineClaimDone) return false;
    if (summary.onlineClaimState === 'pending' || summary.onlineClaimState === 'error') return false;
    const raw = onlineTicketNumber(summary.rawTickets) + onlineTicketNumber(summary.victoryBonus);
    if (!raw) {
      summary.onlineClaimDone = true;
      summary.onlineClaimState = 'done';
      return false;
    }
    if (!window.TowerOnline || typeof TowerOnline.claimRun !== 'function') {
      summary.onlineClaimState = 'error';
      summary.onlineClaimError = '联机奖励模块尚未加载';
      return false;
    }
    const id = String(summary.id || ('run:' + onlineTicketNumber(summary.endedAt) + ':' + onlineTicketNumber(summary.layer)));
    summary.onlineClaimState = 'pending';
    summary.onlineClaimError = '';
    TowerOnline.claimRun({
      id,
      layer: onlineTicketNumber(summary.bestLayer),
      mint: onlineTicketNumber(summary.mintLeft),
      trueEnd: summary.trueEnd === true || summary.outcome === 'win',
    }).then((result) => {
      applyOnlineClaim(summary, result);
      persistOnlineClaim(summary);
      syncTickets();
      if (summaryPageActive(summary)) openEndlessSummary(summary);
      if (onlineTicketNumber(result && result.granted) > 0) {
        const bonus = onlineTicketNumber(result && result.victoryBonus);
        runToast('获得 ' + onlineTicketNumber(result.granted) + ' 张抽奖卷' +
          (bonus > 0 ? '（含百层奖励 +' + bonus + ' 张）' : '') +
          '（本周 ' + onlineTicketNumber(result.weekUsed) + '/' + (onlineTicketNumber(result.weekCap) || 10) + '）');
      }
    }).catch((err) => {
      summary.onlineClaimState = 'error';
      summary.onlineClaimError = (err && err.message) || '网络错误';
      if (summaryPageActive(summary)) openEndlessSummary(summary);
    });
    return true;
  }

  function onTowerClaimEvent(event) {
    const result = event && event.detail;
    if (!ONLINE || !result || !result.runId) return;
    const summary = Tower.endlessInfo().lastSummary;
    if (!summary || String(summary.id) !== String(result.runId) || summary.onlineClaimDone) return;
    applyOnlineClaim(summary, result);
    persistOnlineClaim(summary);
    syncTickets();
    if (summaryPageActive(summary)) openEndlessSummary(summary);
    if (onlineTicketNumber(result.granted) > 0) {
      runToast('无尽塔奖励补发：+' + onlineTicketNumber(result.granted) + ' 张抽奖卷');
    }
  }
  if (ONLINE && typeof window.addEventListener === 'function') {
    window.addEventListener('ssdz-tower-claim', onTowerClaimEvent);
  }

  function settleResult(r) {
    syncTickets();
    const summary = r && r.summary || Tower.endlessInfo().lastSummary;
    if (summary) openEndlessSummary(summary);
    else openEndless();
  }

  // 战报只读取状态机的快照；打开、滚动和重看都不重新结算奖励。
  function summaryNumber(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Math.max(0, Math.floor(Number(value))).toLocaleString('zh-CN');
  }
  function summaryStat(label, value, note) {
    return '<div class="summary-stat"><span>' + esc(label) + '</span><strong>' + summaryNumber(value) +
      '</strong>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
  }
  function openEndlessSummary(summary) {
    if (!summary) { openEndless(); return; }
    activeSummary = summary;
    // 联机版：结算页一打开就把本局周奖励提交给服务端（先落本机队列，断线可补发）。
    // 预览先画出来，服务端回包后本函数会以实际到手重画。
    if (ONLINE && summary.settled === true) claimSummaryRewards(summary);
    hideTip();
    const victory = summary.outcome === 'win';
    const settled = summary.settled === true;
    const layer = Math.max(1, Number(summary.layer) || 1);
    const buffs = Array.isArray(summary.buffs) ? summary.buffs : [];
    const achievements = Array.isArray(summary.achievements) ? summary.achievements : [];
    const kinds = { permanent: '永久', limited: '限次', instant: '即时' };
    const totals = { permanent: 0, limited: 0, instant: 0 };
    for (const buff of buffs) if (totals[buff.kind] !== undefined) totals[buff.kind] += Math.max(0, Number(buff.count) || 0);
    const buffTotals = Object.keys(kinds).filter(k => totals[k] > 0)
      .map(k => kinds[k] + ' ' + summaryNumber(totals[k]) + ' 份').join(' · ');
    // 联机版只有经典界面：结算徽标按剧本显示「联机版·经典模式 / 联机版·勇者模式」。
    const mode = ONLINE
      ? (summary.ruleset === 'hero' ? '联机版·勇者模式' : '联机版·经典模式')
      : (summary.ruleset === 'hero' ? '勇者剧本 · ' : '') +
        (summary.uiMode === 'classic' ? '经典界面' : summary.uiMode === 'modern' ? '现代界面' : '界面未记录');
    const subtitle = victory
      ? ('第 ' + layer + ' 层魔王已击败' + (settled ? ' · 本局已结算' : ' · 新的镜界仍在前方'))
      : ('征途止于第 ' + layer + ' 层 · ' + (summary.reason === 'defeat' ? '战斗失利' : '离场结算'));
    const buffRows = buffs.map(buff => {
      const def = TowerData.BUFF_BY_ID[buff.id];
      const desc = def ? TowerData.descOf(def, 'endless') : '';
      const rarity = Math.max(0, Math.min(3, Number(buff.rarity) || 0));
      return '<li class="summary-buff" data-rarity="' + rarity + '"' +
        (desc ? ' tabindex="0" data-tip="' + esc(desc) + '"' : '') + '>' +
        '<span class="summary-buff-name">' + esc(buff.name || (def && def.name) || buff.id) + '</span>' +
        '<span class="summary-buff-kind">' + esc((RARITY[rarity] || '') + ' · ' + (kinds[buff.kind] || '特殊')) + '</span>' +
        '<b class="summary-buff-count">×' + summaryNumber(buff.count) + '</b></li>';
    }).join('');
    const earnedAchievementPoints = item => item.earnedPoints != null ? Number(item.earnedPoints)
      : String(item.key || '').startsWith('revive:') ? null : Number(item.points);
    const achievementRows = achievements.map(item => {
      const points = earnedAchievementPoints(item);
      return '<li class="summary-achievement"><b>' + esc(item.name) + '</b><span>' +
        (points == null ? '计分档位 ' + summaryNumber(item.points) : '+' + summaryNumber(points)) + ' 分' +
        (item.layer ? ' · 第 ' + summaryNumber(item.layer) + ' 层' : '') + '</span></li>';
    }).join('');
    const allAchievementPointsKnown = achievements.every(item => earnedAchievementPoints(item) != null);
    const achievementPoints = achievements.reduce((total, item) => total + (earnedAchievementPoints(item) || 0), 0);
    const onlineClaimState = ONLINE
      ? String(summary.onlineClaimState || (summary.onlineClaimDone ? 'done' : '')) : '';
    const onlineWeekUsed = ONLINE ? onlineTicketNumber(summary.weekTickets) : 0;
    const onlineWeekCap = ONLINE ? (onlineTicketNumber(summary.weekCap) || 10) : 0;
    const summaryVictoryBonus = Math.max(0, onlineTicketNumber(summary.victoryBonus));
    const ticketStatLabel = ONLINE
      ? (onlineClaimState === 'pending' ? '抽奖卷（结算中）'
        : onlineClaimState === 'error' ? '抽奖卷（待领取）'
        : (settled ? '获得抽奖卷' : '离场可得抽奖卷'))
      : (settled ? '获得抽奖卷' : '离场可得抽奖卷');
    const rewardNote = ONLINE
      ? (onlineClaimState === 'pending' ? '服务器结算中…'
        : onlineClaimState === 'error' ? '结算失败，可重试'
        : '本周 ' + onlineWeekUsed + '/' + onlineWeekCap + ' 张')
      : '层数奖励 ' + summaryNumber(summary.layerTickets) + ' 张' +
        (summary.bonusTickets > 0 ? ' · 百层奖励额外 ' + summaryNumber(summary.bonusTickets) + ' 张' : '') +
        (summary.mintConverted > 0 ? ' · 铸币折券 ' + summaryNumber(summary.mintConverted) + ' 张' : '');
    const notes = (ONLINE ? [
      '每累计通过 10 层得 1 张抽奖卷；结算时铸币超过 10 枚再额外得 1 张。',
      '本局层数奖励 ' + summaryNumber(summary.layerTickets) + ' 张' +
        (summary.bonusTickets > 0 ? ' + 铸币奖励 1 张（结算时 ' + summaryNumber(summary.mintLeft) + ' 枚）' : '') + '。',
      '抽奖卷每周最多 ' + onlineWeekCap + ' 张，周一 0 点重置；本局结算后本周 ' + onlineWeekUsed + '/' + onlineWeekCap + ' 张。',
      summary.trueEnd === true
        ? (summaryVictoryBonus > 0
          ? '通过 100 层：每周首次结算额外 +' + summaryNumber(summaryVictoryBonus) + ' 张抽奖卷，不占每周 ' + onlineWeekCap + ' 张上限。'
          : '本周百层奖励已领取；本局只结算周限内的层数奖励。')
        : '',
      onlineClaimState === 'pending' ? '抽奖卷正在由服务器结算，完成后会自动更新本页。' : '',
      onlineClaimState === 'error'
        ? '服务器结算失败：' + (summary.onlineClaimError || '网络错误') + '；可点「重试领奖」，或下次进入时自动补发。' : '',
      summary.ticketsCapped
        ? '本局周限内应得 ' + summaryNumber(summary.rawTickets) + ' 张，受本周上限影响实际只发 ' +
          summaryNumber(summary.tickets - summaryVictoryBonus) + ' 张' +
          (summaryVictoryBonus > 0 ? '；百层奖励不占上限。' : '。') : '',
      summary.trialCoinsLeft > 0 && settled ? '离场剩余 ' + summaryNumber(summary.trialCoinsLeft) + ' 枚试炼币随本局结束，不折券。' : '',
      summary.complete === false ? '本局开始于战报记录启用之前，未记录的累计项显示为「—」，增益仅列出可确认的记录。' : '',
    ] : [
      settled ? '抽奖卷已放入背包，可用于每日幸运抽奖。' : '继续挑战将保留本局进度；离场时一次领取奖励。',
      summary.bonusTickets > 0 ? '通过 100 层后结算额外获得 ' + summaryNumber(summary.bonusTickets) + ' 张抽奖卷；每周一次。' : '',
      summary.mintForfeited > 0 ? '铸币折券上限 ' + summaryNumber(summary.mintTicketCap) + ' 枚，超出 ' + summaryNumber(summary.mintForfeited) + ' 枚不再折券。' : '',
      summary.trialCoinsLeft > 0 && settled ? '离场剩余 ' + summaryNumber(summary.trialCoinsLeft) + ' 枚试炼币随本局结束，不折券。' : '',
      summary.freeDraws > 0 ? '保底奖励：另获 ' + summaryNumber(summary.freeDraws) + ' 次免费抽奖。' : '',
      summary.complete === false ? '本局开始于战报记录启用之前，未记录的累计项显示为「—」，增益仅列出可确认的记录。' : '',
    ]).filter(Boolean).map(note => '<p>' + esc(note) + '</p>').join('');
    const actions = settled
      ? (ONLINE
        ? C().btn('返回', 'summary-lobby', 'muted') +
          (onlineClaimState === 'error'
            ? C().btn('重试领奖', 'summary-claim-retry', 'muted')
            : (summary.tickets > 0 ? C().btn('去抽奖', 'summary-lottery', '') : '')) +
          C().btn('再次攀登', 'summary-restart', 'gold')
        : C().btn('返回', 'summary-lobby', 'muted') + C().btn('去抽奖', 'summary-lottery', '') + C().btn('再次攀登', 'summary-restart', 'gold'))
      : C().btn(ONLINE ? '结算离场' : '领奖离场', 'summary-settle', 'muted') + C().btn('继续挑战', 'summary-continue', 'gold');
    const report = '<article class="endless-summary" data-outcome="' + (victory ? 'win' : 'lose') + '" aria-label="无尽塔本局战报">' +
      '<header class="summary-heading"><span class="summary-kicker">无尽之塔 · ' + (victory ? '胜利结局' : '未竟结局') + '</span>' +
      '<h2 class="summary-ending">' + (victory ? '破晓登临' : '星火未熄') + '</h2>' +
      '<p class="summary-subtitle">' + esc(subtitle) + '</p><span class="summary-mode">' + mode + '</span></header>' +
      '<div class="summary-score"><span>本局总分</span><strong>' + summaryNumber(summary.score) + '</strong>' +
      '<small>' + (settled ? '本次攀登的最终得分' : '截至本次百层胜利的累计得分') + '</small></div>' +
      '<div class="summary-body"><section class="summary-section"><h3 class="summary-section-heading">增益足迹<small>' +
      (summary.complete === false ? '已记录 ' : '共 ') + summaryNumber(buffs.length) + ' 种 · ' + summaryNumber(summary.buffCount) + ' 份</small></h3>' +
      (buffRows ? '<ul class="summary-buffs">' + buffRows + '</ul>' : '<p class="summary-empty">' +
        (summary.complete === false ? '旧局未保留可确认的增益记录。' : '本局尚未获得增益。') + '</p>') +
      (buffTotals ? '<p class="summary-buff-totals">' + esc(buffTotals) + ' · 包含已用尽、售出及献祭的增益</p>' : '') + '</section>' +
      '<section class="summary-section"><h3 class="summary-section-heading">攀登战绩</h3><div class="summary-stats">' +
      summaryStat('击败敌人', summary.enemiesDefeated, '本局胜利场次') +
      summaryStat('通关层数', summary.layersCleared, '实际完成层数') +
      summaryStat('最深抵达', Math.max(layer, Number(summary.bestLayer) || 0), '层') +
      summaryStat('累计铸币', summary.mintEarned, '累计获得，含已使用') +
      summaryStat('累计试炼币', summary.trialCoinsEarned, '累计获得，含已使用') +
      summaryStat(ticketStatLabel, summary.tickets, rewardNote) + '</div></section>' +
      '<section class="summary-section"><h3 class="summary-section-heading">隐藏成就<small>' + summaryNumber(achievements.length) +
      ' 项' + (achievements.length && allAchievementPointsKnown ? ' · +' + summaryNumber(achievementPoints) + ' 分' : '') + '</small></h3>' +
      (achievementRows ? '<ul class="summary-achievements">' + achievementRows + '</ul>' : '<p class="summary-empty">本局暂无已记录的隐藏成就。</p>') +
      '</section><div class="summary-notes">' + notes + '</div></div><footer class="summary-actions">' + actions + '</footer></article>';
    const ct = classicTower();
    const content = '<div class="tower-page endless-summary-page">' + towerVisual(layer, 0, 'endless') +
      '<div class="tower-main">' + report + '</div></div>';
    const p = C().page('challenge', 'stages', content, ct
      ? { cls: 'tower-board', noTabs: true, noFooter: true, pageClass: 'classic-tower', above: classicTowerBar() }
      : { cls: 'tower-board' });
    if (ct) applyClassicTowerBg(p, 'endless', layer);
    back(p, towerBack, ct ? (ONLINE ? '返回村庄' : '返回征战') : '返回');
    bindTips(p);
    on(p, 'summary-lobby', () => openEndless());
    on(p, 'summary-restart', () => summary.ruleset === 'hero' ? openHeroSetup() : beginEndlessRun());
    on(p, 'summary-lottery', () => {
      syncTickets();
      if (window.ClassicExtras && ClassicExtras.lottery) ClassicExtras.lottery(); else UI.runAction('lottery');
    });
    on(p, 'summary-claim-retry', () => {
      if (!summary) return;
      summary.onlineClaimState = '';
      summary.onlineClaimError = '';
      claimSummaryRewards(summary);
      openEndlessSummary(summary);
    });
    on(p, 'summary-continue', openMirrorConfirm);
    on(p, 'summary-settle', () => {
      const out = Tower.settleEndlessVictory();
      if (!out || !out.ok) { notice(out && out.msg || (ONLINE ? '现在还不能结算。' : '现在还不能领取奖励。')); return; }
      settleResult(out);
    });
  }


  window.TowerUI = { openTower, openEndless, openHeroSetup, openHeroStatus, openMintShop, openShop, openPickBuff, openPatrolToll, openPatrolDiscard,

    _heroAppearanceSlots: heroAppearanceSlots, _openHeroGearPicker: openHeroGearPicker };

  if (window.TowerPlot && TowerPlot.setMainOpener) TowerPlot.setMainOpener(openEndless);
})();
