// ui-levelup.js —— 升级奖励 + 武器/技能三选一（同一个不可被页面重建摘掉的弹窗）
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const SPLASH_SINGLE = 1100;
  const SPLASH_MULTI = 700;
  const LOAD_TIMEOUT = 7000;
  const ACTION_TIMEOUT = 15000;
  const STAGE_VIEWBOX = '11.3 6.25 320 196';

  const STAT = {
    hp: { name: '生命', prop: 19 },
    agility: { name: '敏捷', prop: 17 },
    power: { name: '力量', prop: 16 },
    speed: { name: '速度', prop: 18 },
  };
  const STAT_ORDER = ['hp', 'agility', 'power', 'speed'];   // 与原版 showReward 的数组顺序一致

  // 整个升级流程只有一个实例：奖励页、三选一、完成页都在这一个 root 里换阶段。
  // root 挂在 #app（不是 #ui）下，因此 page()/renderHome()/innerHTML 清页都摘不掉它。
  let state = null;
  let seq = 0;
  let watch = 0;
  let wsPendingSince = 0;
  const shownSigs = new Set();

  const $ = (sel, root) => (root || document).querySelector(sel);
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function err(e) {
    if (window.__errs) window.__errs.push('SfLevelUp: ' + (e && (e.stack || e.message) || e));
  }
  function clipText(value, max) {
    let s = String(value == null ? '' : value);
    if (s.length > max) s = s.slice(0, Math.max(1, max - 1)) + '…';
    return s;
  }

  function giftLabel(g) {
    let name = String(g.name || '道具').replace(/^(小|大|中)/, '');
    if (/礼包/.test(name)) name = '礼包';
    else if (/药剂|药水/.test(name)) name = name.replace(/(药剂|药水)$/, '药');
    const count = Number(g.count) > 1 ? '×' + g.count : '';
    return clipText(name + count, 5);
  }

  function statGain(key) {
    const g = window.State && State.STAT_GAIN && Number(State.STAT_GAIN[key]);
    return g > 0 ? g : (key === 'hp' ? 5 : 1);
  }
  // 一件升级奖励 → 一张原版四格卡（label + 图标）。
  // · 四维：随机成长 + 系统代分配点合并成本级总增量，按原版顺序
  function entriesFor(up) {
    const out = [];
    const gain = { hp: Number(up.hp) || 0, agility: Number(up.agility) || 0, power: Number(up.power) || 0, speed: Number(up.speed) || 0 };
    if (up.autoPoint && gain[up.autoPoint] != null) gain[up.autoPoint] += statGain(up.autoPoint);
    for (const key of STAT_ORDER) {
      if (gain[key] > 0) out.push({
        label: STAT[key].name + '+' + gain[key],
        icon: { kind: 'prop', id: STAT[key].prop, scale: 0.98 },
      });
    }
    if (up.attributeBook) out.push({ label: '属性书', icon: { kind: 'prop', id: 37 } });
    if (up.chest) out.push({ label: '金宝箱×' + up.chest, icon: { kind: 'prop', id: 90 } });
    (up.gifts || []).forEach((g) => {
      out.push({ label: giftLabel(g), icon: { kind: 'prop', id: g.id } });
    });
    if (up.reward) {
      out.push({
        label: clipText(up.reward, 5),
        icon: up.rewardId ? { kind: up.rewardKind === 'weapon' ? 'weapon' : 'skill', id: up.rewardId } : { badge: '!' },
      });
    }
    if (!out.length) out.push({ label: '等级提升', icon: { badge: 'UP' } });
    return out;
  }
  function chunks(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }
  function iconHref(icon) {
    if (!icon || !icon.kind || icon.id == null) return '';

    if (icon.kind === 'prop') {
      if (Number(icon.id) === 8) return 'images/ui/icons/gold-acorn.svg';
      const classic = window.UI && window.UI.classic;
      if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(icon.id);
      return 'images/ui/icons/prop/prop-' + icon.id + '.png';
    }
    return 'images/ui/icons/' + icon.kind + '/' + icon.kind + '-' + icon.id +
      (icon.kind === 'weapon' || icon.kind === 'skill' ? '.svg' : '.png');
  }

  function setCardArt(slot, icon) {
    if (!slot || !slot.g) return;
    try { if (slot.gotoAndStop) slot.gotoAndStop(1); } catch (e) {  }
    const host = (slot.getContentHost && slot.getContentHost()) || slot.g;
    if (!host) return;
    for (const old of host.querySelectorAll('.sf-levelup-cardart')) old.remove();
    const href = icon && iconHref(icon);
    let b = null;
    try { b = slot.g.getBBox(); } catch (e) { b = null; }
    if (!b || !(b.width > 0) || !(b.height > 0)) return;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    if (href) {
      const scale = Number(icon && icon.scale) > 0 ? Number(icon.scale) : 0.76;
      const size = Math.min(b.width, b.height) * scale;
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('class', 'sf-levelup-cardart');
      img.setAttribute('x', (cx - size / 2).toFixed(2));
      img.setAttribute('y', (cy - size / 2).toFixed(2));
      img.setAttribute('width', size.toFixed(2));
      img.setAttribute('height', size.toFixed(2));
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      img.setAttribute('href', href);
      img.setAttributeNS(XLINK, 'xlink:href', href);
      img.setAttribute('pointer-events', 'none');
      host.appendChild(img);
      return;
    }
    const badge = (icon && icon.badge) || '?';
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('class', 'sf-levelup-cardart');
    t.setAttribute('x', cx.toFixed(2));
    t.setAttribute('y', (cy + Math.min(b.width, b.height) * 0.15).toFixed(2));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'SimHei,Microsoft YaHei,sans-serif');
    t.setAttribute('font-size', (Math.min(b.width, b.height) * (badge.length > 1 ? 0.3 : 0.48)).toFixed(2));
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#fff6d8');
    t.setAttribute('stroke', '#5b2c12');
    t.setAttribute('stroke-width', '1.1');
    t.setAttribute('paint-order', 'stroke');
    t.setAttribute('pointer-events', 'none');
    t.textContent = badge;
    host.appendChild(t);
  }
  function setCard(fp, index, entry) {
    const p = fp && fp.byName ? fp.byName('p' + index) : null;
    const text = fp && fp.byName ? fp.byName('text' + index) : null;
    const slot = p && p.byName ? p.byName('c1') : null;
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (text && t) t.setText(text, entry.label || '');
    if (slot) setCardArt(slot, entry.icon);
  }

  function wireConfirm(view) {
    if (!view || !view.g) return false;
    let bound = false;
    for (const depth of ['20', '22']) {
      const n = view.g.querySelector(':scope > [depth="' + depth + '"]');
      if (!n) continue;
      bound = true;
      if (n.__sfLevelUpBound) continue;
      n.__sfLevelUpBound = true;
      n.style.pointerEvents = 'auto';
      n.style.cursor = 'pointer';
      n.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        confirmReward();
      });
      n.setAttribute('role', 'button');
      n.setAttribute('tabindex', '0');
      n.setAttribute('aria-label', '确定');
      n.addEventListener('keydown', (e) => {
        if (!e.repeat && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); confirmReward(); }
      });
      if (depth === '20') {
        n.addEventListener('mouseenter', () => { n.style.filter = 'brightness(1.08)'; });
        n.addEventListener('mouseleave', () => { n.style.filter = ''; });
      }
    }
    return bound;
  }
  // 原版「确定」是 SVG 里的 g：桌面 Chrome 能点到，但部分 WebView/Safari 的
  // pointer-events 继承和触摸兜底会把它算到背景上。再加一颗透明 DOM 按钮盖在
  // 同一个位置，作为唯一可靠的确认热区；视觉仍由原版按钮负责。
  function clearConfirmHotspot() {
    if (!state || !state.confirmHotspot) return;
    try { state.confirmHotspot.remove(); } catch (e) {  }
    state.confirmHotspot = null;
  }
  function placeConfirmHotspot(view) {
    if (!state || !state.stage || !view || !view.g) return;
    const node = view.g.querySelector(':scope > [depth="20"]') ||
      view.g.querySelector(':scope > [depth="22"]');
    if (!node) return;
    let stageRect, nodeRect;
    try {
      stageRect = state.stage.getBoundingClientRect();
      nodeRect = node.getBoundingClientRect();
    } catch (e) { return; }
    if (!(stageRect.width > 0 && stageRect.height > 0 && nodeRect.width > 0 && nodeRect.height > 0)) return;
    const sx = stageRect.width / (state.stage.offsetWidth || 1);
    const sy = stageRect.height / (state.stage.offsetHeight || 1);
    let btn = state.confirmHotspot;
    if (!btn || !btn.isConnected) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sf-levelup-confirm-hotspot';
      btn.setAttribute('aria-label', '确定');
      btn.setAttribute('data-levelup-confirm', '1');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        confirmReward();
      });
      state.stage.appendChild(btn);
      state.confirmHotspot = btn;
    }
    btn.style.left = ((nodeRect.left - stageRect.left) / sx).toFixed(2) + 'px';
    btn.style.top = ((nodeRect.top - stageRect.top) / sy).toFixed(2) + 'px';
    btn.style.width = (nodeRect.width / sx).toFixed(2) + 'px';
    btn.style.height = (nodeRect.height / sy).toFixed(2) + 'px';
  }

  function pageIndicator(view, page, total) {
    if (!view || !view.g) return;
    let t = view.g.querySelector(':scope > .sf-levelup-page');
    if (total <= 1) { if (t) t.remove(); return; }
    if (!t) {
      t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'sf-levelup-page');
      t.setAttribute('x', '281');
      t.setAttribute('y', '33');
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('font-family', 'SimHei,Microsoft YaHei,sans-serif');
      t.setAttribute('font-size', '10');
      t.setAttribute('font-weight', '700');
      t.setAttribute('fill', '#7a5528');
      t.setAttribute('pointer-events', 'none');
      view.g.appendChild(t);
    }
    t.textContent = (page + 1) + '/' + total;
  }
  function freeze(view) {
    try {
      if (window.SfUiMain && SfUiMain.toolkit && SfUiMain.toolkit.freezeDescendants) SfUiMain.toolkit.freezeDescendants(view);
    } catch (e) { err(e); }
    if (view) view.playing = false;
  }
  function setLevel(view, level) {
    const num = view && view.byName ? view.byName('level') : null;
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (num && t && t.showNumber) {
      try { t.showNumber(level, num, 0, 0, 'right'); } catch (e) { err(e); }
    }
  }

  function currentPages() {
    return chunks(entriesFor(state.ups[state.upIndex] || {}), 4);
  }
  function showSplash() {
    try { showSplashImpl(); }
    catch (e) { err(e); showFallback(); }
  }
  function showSplashImpl() {
    if (!state || !state.view) return;
    const up = state.ups[state.upIndex];
    if (!up) { afterRewards(); return; }
    clearConfirmHotspot();
    state.phase = 'reward';
    state.page = 0;
    state.pages = currentPages();
    state.ready = false;
    state.lock = false;
    state.rewardAt = Date.now();
    state.host.classList.remove('sf-levelup-bg-only');
    if (state.ws) state.ws.hidden = true;
    state.view.gotoAndStop(1);
    state.view.playing = false;
    freeze(state.view);
    setLevel(state.view, up.level);
    pageIndicator(state.view, 0, 0);
    clearTimeout(state.timer);
    const mine = state.seq;
    const wait = reduceMotion() ? 0 : (state.ups.length > 1 ? SPLASH_MULTI : SPLASH_SINGLE);
    state.timer = setTimeout(() => {
      if (!state || state.seq !== mine || state.phase !== 'reward') return;
      showReward();
    }, wait);
  }
  function showReward() {
    try { showRewardImpl(); }
    catch (e) { err(e); showFallback(); }
  }
  function showRewardImpl() {
    if (!state || !state.view) return;
    clearConfirmHotspot();
    const pages = currentPages();
    state.pages = pages;
    if (state.page >= pages.length) state.page = pages.length - 1;
    const cards = pages[state.page] || [];
    const view = state.view;
    state.phase = 'reward';
    state.rewardAt = Date.now();
    state.host.classList.remove('sf-levelup-bg-only');
    if (state.ws) state.ws.hidden = true;
    view.gotoAndStop(30);
    view.playing = false;
    freeze(view);
    const gear = view.byName ? view.byName('c1') : null;
    if (gear && gear.g) gear.g.style.display = 'none';
    const fp = view.byName ? view.byName('fourProperties') : null;
    if (fp) {
      try { fp.gotoAndStop(Math.max(1, Math.min(4, cards.length))); } catch (e) { err(e); }
      freeze(view);
      for (let i = 0; i < cards.length && i < 4; i++) setCard(fp, i + 1, cards[i]);
    }
    pageIndicator(view, state.page, pages.length);
    const bound = wireConfirm(view);
    markBackground(view);
    state.ready = true;
    if (!bound) {
      // 7795 结构在这一版素材/浏览器上找不到确认节点：直接退回有 DOM 确定键的奖励卡。
      showFallback();
      return;
    }
    placeConfirmHotspot(view);
    // WebView 刚切帧时 bbox 可能还要一拍；量不到就下一帧再补一次确认热区。
    if (!state.confirmHotspot) {
      const mine = state.seq;
      setTimeout(() => {
        if (state && state.seq === mine && state.phase === 'reward' && state.ready) placeConfirmHotspot(state.view);
      }, 50);
    }
  }

  function markBackground(view) {
    if (!view || !view.g) return;
    let cg = null;
    try { cg = view.g.querySelector(':scope > g > path[fill^="url(#f7775"]'); } catch (e) { cg = null; }
    if (cg && cg.parentNode && cg.parentNode.classList) cg.parentNode.classList.add('sf-levelup-cg');
  }
  function pendingWs() {
    try {
      return !!(window.State && typeof State.pendingWS === 'function' && State.pendingWS() > 0);
    } catch (e) { return false; }
  }
  // 升级响应先到、wsPicks 补丁后到时会短暂读到空候选：先拉一次权威存档，别把玩家还没看到的组随机掉。
  function resyncPendingChoices() {
    try {
      const O = window.Online;
      if (O && O.ready && typeof O.syncState === 'function') return Promise.resolve(O.syncState()).catch(() => {});
    } catch (e) {}
    return Promise.resolve();
  }

  // 奖励页收掉后仍留在同一个 root 里的 CG 背景；三选一/完成页盖在它上面。
  function holdBackground() {
    if (!state || !state.host) return false;
    state.backgroundHeld = true;
    if (state.host.classList) state.host.classList.add('sf-levelup-bg-only');
    // 7795 没挂出来时奖励卡是 DOM：清掉它，只留宿主自己的 CG 背景。
    if (state.fallback && state.host) state.host.innerHTML = '';
    markBackground(state.view);
    return true;
  }

  function releaseBackground() {
    return false;
  }

  function confirmReward() {
    if (!state || state.phase !== 'reward' || !state.ready) return;
    if (state.lock) return;
    if (state.fallback) { afterRewards(); return; }
    state.lock = true;
    setTimeout(() => { if (state) state.lock = false; }, 220);
    if (state.page < state.pages.length - 1) {
      state.page++;
      showReward();
      return;
    }
    if (state.upIndex < state.ups.length - 1) {
      state.upIndex++;
      showSplash();
      return;
    }
    afterRewards();
  }

  // 奖励页全部确认后：先接存档里必须选掉的三选一，再收弹窗。
  function afterRewards() {
    if (!state) return;
    state.ready = false;
    if (pendingWs()) { showChoice(); return; }
    if (state.deferredUps && state.deferredUps.length) { showDeferred(); return; }
    close();
  }

  function showDeferred() {
    if (!state || !state.deferredUps.length) { afterRewards(); return; }
    const list = state.deferredUps.splice(0, state.deferredUps.length);
    state.ups = list;
    state.upIndex = 0;
    state.page = 0;
    state.fallback = false;
    hideChoicePanel();
    if (state.view) { showSplash(); return; }
    // 之前走的是 DOM 兜底：重新用奖励卡显示新增的升级。
    showFallback();
  }

  function hideChoicePanel() {
    if (!state) return;
    clearConfirmHotspot();
    if (state.ws) { state.ws.hidden = true; state.ws.innerHTML = ''; }
    if (state.host) state.host.classList.remove('sf-levelup-bg-only');
  }

  function showChoice() {
    if (!state) return;
    clearConfirmHotspot();
    state.phase = 'choice';
    state.ready = true;
    state.lock = false;
    state.wsError = '';
    state.wsAutoTries = 0;
    state.phaseAt = Date.now();
    clearTimeout(state.timer);
    holdBackground();
    if (state.ws) {
      state.ws.hidden = false;
      renderChoice();
    }
  }

  function wsCountText() {
    const n = pendingWs() ? Number(State.pendingWS()) || 0 : 0;
    return n > 1 ? ('还有 ' + (n - 1) + ' 组在后面等着') : '最后一组';
  }

  function wsIconHtml(kind, id) {
    const c = window.UI && window.UI.classic;
    if (c && typeof c.icon === 'function') {
      try {
        const html = c.icon(kind, id);
        if (html) return html;
      } catch (e) { err(e); }
    }
    return '<b class="reward-badge">' + (kind === 'weapon' ? '武' : '技') + '</b>';
  }

  function wsCardHtml(c, i) {
    return '<button type="button" class="ws-choice" data-ws-pick="' + i + '">' +
      '<span class="item-icon">' + wsIconHtml(c.kind, c.id) + '</span>' +
      '<b class="ws-choice-name">' + esc(c.name) + '</b>' +
      '<span class="ws-choice-kind">' + (c.kind === 'weapon' ? '武器' : '技能') + (c.type ? ' · ' + esc(c.type) : '') + '</span>' +
      '<span class="ws-choice-desc">' + esc(c.remark || '—') + '</span></button>';
  }

  function renderChoice() {
    try { renderChoiceImpl(); }
    catch (e) {
      err(e);
      if (!state || !state.ws) return;
      state.wsBusy = false;
      state.wsError = '升级选择面板加载失败，请重试。';
      state.ws.hidden = false;
      state.ws.innerHTML = '<div class="classic-modal small-modal sf-levelup-ws-modal" role="dialog" aria-modal="true" aria-label="升级奖励">' +
        '<h2 class="modal-title cartoon">升级奖励</h2>' +
        '<div class="modal-body"><p class="sf-levelup-error" role="alert">升级选择面板加载失败，请重试。</p>' +
        '<div class="modal-buttons"><button type="button" class="uc-button gold" data-ws-random>重试</button></div></div></div>';
    }
  }
  function renderChoiceImpl() {
    if (!state || !state.ws) return;
    if (state.wsBusy) {
      state.ws.innerHTML = '<div class="classic-modal small-modal sf-levelup-ws-modal" role="dialog" aria-modal="true" aria-label="升级奖励">' +
        '<h2 class="modal-title cartoon">升级奖励</h2>' +
        '<div class="modal-body"><p class="free-point-tip">正在结算武器/技能，请稍候……</p></div></div>';
      return;
    }
    if (!pendingWs()) { showDone(); return; }
    const list = (window.State && typeof State.currentWSChoices === 'function') ? State.currentWSChoices() : [];
    if (!list.length) {
      const error = state.wsError
        ? '<p class="sf-levelup-error" role="alert">' + esc(state.wsError) + '</p>' +
          '<div class="modal-buttons"><button type="button" class="uc-button gold" data-ws-random>重试</button></div>'
        : '<p class="free-point-tip">正在挑选可用的武器/技能……</p>';
      state.ws.innerHTML = '<div class="classic-modal small-modal sf-levelup-ws-modal" role="dialog" aria-modal="true" aria-label="升级奖励">' +
        '<h2 class="modal-title cartoon">升级奖励</h2>' +
        '<div class="modal-body">' + error + '</div></div>';
      if (!state.wsError && !state.wsAutoPending) {
        if (state.wsAutoTries >= 3) {
          state.wsError = '没有可选的武器/技能，请重试';
          renderChoice();
          return;
        }
        state.wsAutoPending = true;
        // 升级响应里的 wsPicks 可能比升级页晚一拍：先等镜像对齐，别把玩家还没看到的组直接随机掉。
        setTimeout(() => {
          if (!state) return;
          state.wsAutoPending = false;
          if (state.phase !== 'choice' || state.wsBusy) return;
          resyncPendingChoices().then(() => {
            if (!state || state.phase !== 'choice' || state.wsBusy) return;
            if (!pendingWs()) { renderChoice(); return; }
            let now = [];
            try { now = State.currentWSChoices() || []; } catch (e) { now = []; }
            if (now.length) { renderChoice(); return; }
            chooseRandom();
          });
        }, 1200);
      }
      return;
    }
    state.wsAutoTries = 0;
    const n = Number(State.pendingWS()) || 1;
    const body = '<div class="ws-choice-box"><p class="free-point-tip">升级奖励：从下面' + list.length + ' 个里选一个学会（' +
      wsCountText() + '）。</p>' +
      '<div class="ws-choice-row' + (list.length < 3 ? ' few' : '') + '">' + list.map(wsCardHtml).join('') + '</div>' +
      (state.wsError ? '<p class="sf-levelup-error" role="alert">' + esc(state.wsError) + '</p>' : '') +
      '</div>';
    state.ws.innerHTML = '<div class="classic-modal small-modal sf-levelup-ws-modal" role="dialog" aria-modal="true" aria-label="选择武器或技能">' +
      '<h2 class="modal-title cartoon">选择武器或技能</h2>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-buttons"><button type="button" class="uc-button muted" data-ws-random>' +
      (n > 1 ? '全部随机' : '随便来一个') + '</button></div></div>';
  }

  function chooseCard(index) {
    if (!state || state.phase !== 'choice' || state.wsBusy) return;
    let c = null;
    try { c = State.currentWSChoices()[Number(index)]; } catch (e) { c = null; }
    if (!c) { state.wsError = '这组候选已变化，请重新选择'; renderChoice(); return; }
    let r = null;
    try { r = State.chooseWS(c.kind, c.id); } catch (e) { r = { ok: false, msg: e && e.message }; }
    if (!r || !r.ok) {
      state.wsError = (r && (r.msg || r.message)) || '选择失败，请重试';
      renderChoice();
      return;
    }
    state.wsError = '';
    if (state.wsLearned.indexOf(c.name) < 0) state.wsLearned.push(c.name);
    state.wsAutoPending = false;
    state.wsAutoTries = 0;
    renderChoice();
  }

  function chooseRandom() {
    if (!state || state.phase !== 'choice' || state.wsBusy) return;
    state.wsBusy = true;
    state.wsError = '';
    state.wsAutoPending = false;
    renderChoice();
    let settled = false;
    let timer = 0;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!state) return;
      state.wsBusy = false;
      if (!r || !r.ok) state.wsError = (r && (r.msg || r.message)) || '选择失败，请重试';
      else {
        state.wsError = '';
        // 服务端说成功但本地仍没有候选：最多自动重试 3 次，随后交给玩家点「重试」。
        let left = [];
        try { left = State.currentWSChoices() || []; } catch (e) { left = []; }
        if (pendingWs() && !left.length) {
          state.wsAutoTries = (state.wsAutoTries || 0) + 1;
          if (state.wsAutoTries >= 3) state.wsError = '没有可选的武器/技能，请重试';
        } else if (left.length) state.wsAutoTries = 0;
      }
      renderChoice();
    };
    timer = setTimeout(() => finish({ ok: false, msg: '连接超时，请重试' }), ACTION_TIMEOUT);
    try {
      if (typeof window.StateCall === 'function') {
        window.StateCall('chooseWSRandom').then(finish, (e) => finish({ ok: false, msg: (e && e.message) || '选择失败' }));
      } else if (window.State && typeof State.chooseWSRandom === 'function') {
        finish(State.chooseWSRandom());
      } else {
        finish({ ok: false, msg: '当前不能随机选择' });
      }
    } catch (e) {
      finish({ ok: false, msg: (e && e.message) || '选择失败' });
    }
  }

  function showDone() {
    try { showDoneImpl(); }
    catch (e) { err(e); close(); }
  }
  function showDoneImpl() {
    if (!state || !state.ws) return;
    clearConfirmHotspot();
    state.phase = 'done';
    state.phaseAt = Date.now();
    state.ready = true;
    holdBackground();
    const learned = state.wsLearned.length
      ? '<p class="free-point-tip">已学会：' + state.wsLearned.map(esc).join('、') + '</p>' : '';
    state.ws.hidden = false;
    state.ws.innerHTML = '<div class="classic-modal small-modal sf-levelup-ws-modal" role="dialog" aria-modal="true" aria-label="升级奖励已完成">' +
      '<h2 class="modal-title cartoon">升级奖励</h2>' +
      '<div class="modal-body"><p class="free-point-tip">本次升级的奖励已全部处理完。</p>' + learned + '</div>' +
      '<div class="modal-buttons"><button type="button" class="uc-button gold" data-lv-done>确定</button></div></div>';
  }

  function finishDone() {
    if (!state || state.phase !== 'done') return;
    if (pendingWs()) { showChoice(); return; }
    if (state.deferredUps && state.deferredUps.length) { showDeferred(); return; }
    close();
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fallbackHtml(list) {
    const c = window.UI && window.UI.classic;
    if (c && typeof c.upsHtml === 'function') {
      try { return c.upsHtml(list); } catch (e) { err(e); }
    }
    const rows = (list || []).map((u) => {
      const gains = [];
      for (const key of STAT_ORDER) {
        const value = Number(u[key]) || 0;
        if (value > 0) gains.push(STAT[key].name + '+' + value);
      }
      if (u.autoPoint) gains.push('系统分配 1 点');
      const extra = [];
      if (u.chest) extra.push('金宝箱×' + u.chest);
      if (u.attributeBook) extra.push('属性书×1');
      (u.gifts || []).forEach((g) => extra.push(g.name + '×' + g.count));
      return '<div class="reward-panel"><div class="reward-row"><div class="reward-card"><span class="reward-text">' +
        esc(gains.join('　') || '等级提升') + (extra.length ? '<br>' + esc(extra.join('　')) : '') +
        '</span></div></div><div class="reward-level">升到 ' + esc(u.level) + ' 级</div></div>';
    }).join('');
    return '<div class="reward-stack">' + rows + '</div>';
  }

  function showFallback() {
    if (!state) return;
    clearConfirmHotspot();
    state.loading = false;
    state.fallback = true;
    state.phase = 'reward';
    state.phaseAt = Date.now();
    state.ready = true;
    state.lock = false;
    state.pages = [];
    clearTimeout(state.timer);
    try { if (state.view) { state.view.destroy(); state.view = null; } } catch (e) {  }
    if (!state.host) return;
    state.host.classList.remove('sf-levelup-bg-only');
    if (state.ws) state.ws.hidden = true;
    state.host.innerHTML = '<div class="sf-levelup-fallback"><section class="classic-modal small-modal" role="dialog" aria-modal="true" aria-label="升级奖励">' +
      '<h2 class="modal-title cartoon">升级奖励</h2>' +
      '<div class="modal-body">' + fallbackHtml(state.ups) + '</div>' +
      '<div class="modal-buttons"><button type="button" class="uc-button gold" data-lv-dom-confirm>确定</button></div>' +
      '</section></div>';
    const button = state.host.querySelector('[data-lv-dom-confirm]');
    if (button) button.addEventListener('click', (e) => { e.preventDefault(); confirmReward(); });
  }

  function syncGeometry() {
    const ui = document.getElementById('ui');
    if (!state || !state.root || !ui || !ui.getBoundingClientRect) return;
    let rect = null;
    try { rect = ui.getBoundingClientRect(); } catch (e) { return; }
    const w = Number(ui.offsetWidth) || 0;
    const h = Number(ui.offsetHeight) || 0;
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(w > 0) || !(h > 0)) return;
    // root 直接铺在 #ui 的屏幕矩形上；stage 用左上角原点缩放到同一矩形。
    // 不能拿「未缩放中心」反推 left：stage 的 transform-origin 已经是 0 0。
    state.root.style.left = rect.left.toFixed(2) + 'px';
    state.root.style.top = rect.top.toFixed(2) + 'px';
    state.root.style.width = rect.width.toFixed(2) + 'px';
    state.root.style.height = rect.height.toFixed(2) + 'px';
    if (state.stage) {
      state.stage.style.width = w + 'px';
      state.stage.style.height = h + 'px';
      state.stage.style.transform = 'scale(' + (rect.width / w).toFixed(6) + ',' + (rect.height / h).toFixed(6) + ')';
    }
    if (state.phase === 'reward' && state.ready && state.view) placeConfirmHotspot(state.view);
  }

  function rootParent() {
    return document.getElementById('app') || document.body;
  }

  // 任何路径留下的空 root 都会整屏拦截点击，表现成「卡在升级页，只能刷新」。
  // 每次建窗、关窗和看门狗空转时都清一遍；只保留当前 state 的 root。
  function removeOrphanRoots(keep) {
    let list = [];
    try { list = document.querySelectorAll ? document.querySelectorAll('.sf-levelup-root') : []; } catch (e) { list = []; }
    for (const el of list) {
      if (keep && el === keep) continue;
      try { el.remove(); } catch (e) {  }
    }
  }

  function ensureRoot(st) {
    if (!st.root) {
      const root = document.createElement('section');
      root.className = 'sf-levelup-root';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', '升级奖励');
      root.tabIndex = 0;
      const stage = document.createElement('div');
      stage.className = 'sf-levelup-stage';
      const host = document.createElement('section');
      host.className = 'classic-home ssfight-home ssfight-view sf-levelup-view';
      host.setAttribute('aria-label', '升级奖励');
      const ws = document.createElement('div');
      ws.className = 'sf-levelup-ws ws-choice-dialog';
      ws.hidden = true;
      stage.appendChild(host);
      stage.appendChild(ws);
      root.appendChild(stage);
      root.addEventListener('keydown', (e) => {
        if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
        const t = e.target && e.target.closest ? e.target : null;
        if (t && t.closest('button,[data-ws-pick],[data-lv-done],[data-ws-random]')) return;
        if (!state || state.phase !== 'reward') return;
        e.preventDefault();
        confirmReward();
      });
      ws.addEventListener('click', (e) => {
        const target = e.target && e.target.closest ? e.target : null;
        if (!target) return;
        const pick = target.closest('[data-ws-pick]');
        if (pick) { e.preventDefault(); chooseCard(pick.dataset.wsPick); return; }
        if (target.closest('[data-ws-random]')) { e.preventDefault(); chooseRandom(); return; }
        if (target.closest('[data-lv-done]')) { e.preventDefault(); finishDone(); return; }
      });
      st.root = root;
      st.stage = stage;
      st.host = host;
      st.ws = ws;
      const parent = rootParent();
      if (!parent) return false;
      removeOrphanRoots(root);
      parent.appendChild(root);
      try { root.focus({ preventScroll: true }); } catch (e) {}
      syncGeometry();
      return true;
    }
    if (!st.root.isConnected) {
      const parent = rootParent();
      if (!parent) return false;
      removeOrphanRoots(st.root);
      parent.appendChild(st.root);
      syncGeometry();
    }
    return true;
  }

  function clearView(st) {
    if (!st || !st.view) return;
    try { st.view.destroy(); } catch (e) {  }
    st.view = null;
  }

  function mountReward() {
    if (!state) return;
    const st = state;
    st.phase = 'loading';
    st.ready = false;
    st.loading = true;
    st.fallback = false;
    st.loadStart = Date.now();
    st.host.classList.remove('sf-levelup-bg-only');
    if (st.ws) st.ws.hidden = true;
    st.host.innerHTML = '<div class="sf-levelup-loading" role="status">升级奖励加载中……</div>';
    if (!window.SfRender || !SfRender.mountSymbol || !SfRender.load) { showFallback(); return; }
    const mine = st.seq;
    const failTimer = setTimeout(() => {
      if (state === st && st.seq === mine && st.loading) showFallback();
    }, LOAD_TIMEOUT);
    st.loadTimer = failTimer;
    SfRender.load().then(() => {
      if (state !== st || st.seq !== mine) return null;
      // 已经切到 DOM 兜底就不要再 mount：mountSymbol 会先清空 host，
      // 慢网下 7795 读完后清掉兜底奖励卡，弹窗就只剩背景、没有确定键。
      if (st.fallback || !st.loading) return null;
      const host = st.host;
      if (!host || !host.isConnected) return null;
      return SfRender.mountSymbol(host, '7795', {
        frame: 1, label: '等级提升', viewBox: STAGE_VIEWBOX,
      });
    }).then((view) => {
      clearTimeout(failTimer);
      if (!view) return;
      if (state !== st || st.seq !== mine) { try { view.destroy(); } catch (e) {  } return; }
      // 加载超时已经切到 DOM 兜底：迟到的 7795 不能把兜底页顶掉；
      // 如果它已经清了 host，就重画一次兜底卡，保证按钮仍在。
      if (st.fallback) {
        try { view.destroy(); } catch (e) {  }
        // 只在仍在奖励页时重画兜底；玩家已经点进三选一/完成页时，
        // 迟到的 7795 不能把阶段倒回去。
        if (state.phase === 'reward' && state.ready) showFallback();
        return;
      }
      st.view = view;
      st.loading = false;
      freeze(view);
      showSplash();
    }).catch((e) => {
      clearTimeout(failTimer);
      if (state !== st) return;
      err(e);
      showFallback();
    });
  }

  function tick() {
    if (!state) return;
    const st = state;
    if (document.querySelector('.online-login') || document.querySelector('#ui .title-screen')) { close(); return; }
    if (st.root && !st.root.isConnected) {
      const parent = rootParent();
      if (parent) { parent.appendChild(st.root); }
    }
    syncGeometry();
    if (st.root) {
      let battling = false;
      try { battling = !!(window.Main && typeof Main.isBattle === 'function' && Main.isBattle()); } catch (e) { battling = false; }
      st.root.style.visibility = battling ? 'hidden' : '';
    }
    if (st.phase === 'loading' && st.loading && st.loadStart && Date.now() - st.loadStart > LOAD_TIMEOUT) {
      showFallback();
      return;
    }
    // 奖励页切帧后迟迟没有 ready（WebView 偶发 gotoAndStop 后布局不落地）：
    // 直接换 DOM 奖励卡，保证一定有可点的「确定」。
    if (st.phase === 'reward' && !st.ready && st.rewardAt && Date.now() - st.rewardAt > 5000) {
      showFallback();
      return;
    }
    if (st.phase === 'choice') {
      if (!pendingWs() && !st.wsBusy) { showDone(); return; }
      if (pendingWs() && !st.wsBusy) {
        let list = [];
        try { list = State.currentWSChoices() || []; } catch (e) { list = []; }
        // 面板被页面重建 / 异常清空时，别让玩家对着透明层干等。
        if (st.ws && !st.ws.innerHTML.trim() && st.phaseAt && Date.now() - st.phaseAt > 1500) {
          renderChoice();
          return;
        }
        if (!list.length && !st.wsAutoPending && !st.wsError && st.wsAutoTries < 3) {
          st.wsAutoPending = true;
          setTimeout(() => {
            if (state !== st) return;
            st.wsAutoPending = false;
            if (st.phase !== 'choice' || st.wsBusy) return;
            resyncPendingChoices().then(() => {
              if (state !== st || st.phase !== 'choice' || st.wsBusy) return;
              if (!pendingWs()) { renderChoice(); return; }
              let now = [];
              try { now = State.currentWSChoices() || []; } catch (e) { now = []; }
              if (now.length) { renderChoice(); return; }
              chooseRandom();
            });
          }, 1200);
        }
      }
    }
    if (st.phase === 'done' && st.ws && !st.ws.querySelector('[data-lv-done]') && st.phaseAt && Date.now() - st.phaseAt > 1200) {
      showDone();
    }
  }

  function close() {
    if (!state) return;
    const st = state;
    state = null;
    clearView(st);
    clearTimeout(st.timer);
    clearTimeout(st.loadTimer);
    if (st.confirmHotspot) { try { st.confirmHotspot.remove(); } catch (e) {  } }
    if (st.root && st.root.parentNode) {
      try { st.root.parentNode.removeChild(st.root); } catch (e) {  }
    }
    removeOrphanRoots(null);
    const callbacks = st.callbacks.slice();
    for (const cb of callbacks) {
      if (!cb || typeof cb.onDone !== 'function') continue;
      try { cb.onDone(); } catch (e) { err(e); }
    }
    setTimeout(() => {
      if (state) return;
      try {
        if (window.UI && UI.classic && typeof UI.classic.promptLevelUpChoices === 'function') UI.classic.promptLevelUpChoices();
      } catch (e) { err(e); }
    }, 0);
  }

  function fail(st, e) {
    err(e);
    if (state === st) state = null;
    if (!st) return;
    clearTimeout(st.timer);
    clearTimeout(st.loadTimer);
    clearView(st);
    if (st.confirmHotspot) { try { st.confirmHotspot.remove(); } catch (x) {  } }
    if (st.root && st.root.parentNode) {
      try { st.root.parentNode.removeChild(st.root); } catch (x) {  }
    }
    removeOrphanRoots(null);
    const callbacks = st.callbacks.slice();
    for (const cb of callbacks) {
      if (!cb) continue;
      try {
        if (typeof cb.onFail === 'function') cb.onFail(e);
        else if (typeof cb.onDone === 'function') cb.onDone();
      } catch (x) { err(x); }
    }
  }

  function upSig(u) {
    return [u.level, u.power, u.agility, u.speed, u.hp, u.autoPoint, u.wsChoice,
      u.chest, u.attributeBook, u.reward, u.rewardId, u.rewardKind,
      (u.gifts || []).map((g) => g.id + ':' + g.count).join(',')].join('|');
  }

  function createState(ups, callbacks) {
    return {
      seq: ++seq,
      ups: ups.slice(),
      upIndex: 0,
      page: 0,
      pages: [],
      phase: 'loading',
      ready: false,
      loading: true,
      fallback: false,
      lock: false,
      backgroundHeld: false,
      view: null,
      root: null,
      stage: null,
      host: null,
      ws: null,
      confirmHotspot: null,
      rewardAt: 0,
      phaseAt: 0,
      timer: 0,
      loadTimer: 0,
      loadStart: 0,
      callbacks: callbacks.slice(),
      deferredUps: [],
      wsBusy: false,
      wsError: '',
      wsLearned: [],
      wsAutoPending: false,
      wsAutoTries: 0,
    };
  }

  function begin(st) {
    if (!ensureRoot(st)) return false;
    if (!st.ups.length) {
      if (pendingWs()) { showChoice(); return true; }
      return false;
    }
    mountReward();
    return true;
  }

  // 所有入口都走这里：同一时间只有一个 root；后来的奖励接在队列后面。
  function enqueue(ups, opts) {
    const o = opts || {};
    const clean = [];
    for (const u of (ups || [])) {
      if (!u) continue;
      const sig = upSig(u);
      if (shownSigs.has(sig)) continue;
      shownSigs.add(sig);
      clean.push(u);
    }
    if (!clean.length) {
      if (state) {
        if (typeof o.onDone === 'function') state.callbacks.push({ onDone: o.onDone });
        return true;
      }
      if (pendingWs() && sync()) {
        if (typeof o.onDone === 'function' && state) state.callbacks.push({ onDone: o.onDone });
        return true;
      }
      if (typeof o.onDone === 'function') { try { o.onDone(); } catch (e) { err(e); } }
      return false;
    }
    if (state) {
      if (state.phase === 'choice' || state.phase === 'done') {
        state.deferredUps.push(...clean);
      } else {
        state.ups.push(...clean);
        // DOM 兜底是一次性把整批奖励卡画完的：后到的升级要重画，否则会漏掉。
        if (state.fallback) showFallback();
      }
      if (typeof o.onDone === 'function') state.callbacks.push({ onDone: o.onDone });
      if (typeof o.onFail === 'function') state.callbacks.push({ onFail: o.onFail });
      return true;
    }
    const callbacks = [{ onDone: o.onDone, onFail: o.onFail }];
    const st = createState(clean, callbacks);
    state = st;
    try {
      if (!begin(st)) {
        fail(st, new Error('升级弹窗无法挂载'));
        return false;
      }
    } catch (e) {
      fail(st, e);
      return false;
    }
    return true;
  }

  function canOpenWsOnly() {
    if (typeof State === 'undefined' || typeof State.state !== 'function') return false;
    try { if (!State.state()) return false; } catch (e) { return false; }
    try { if (window.Main && typeof Main.isBattle === 'function' && Main.isBattle()) return false; } catch (e) {  }
    if (document.querySelector('#ui .online-login, #ui .title-screen')) return false;
    if (!document.querySelector('#ui .classic-home, #ui .classic-page')) return false;
    const stale = !!(wsPendingSince && Date.now() - wsPendingSince > 8000);
    if (!stale) {
      if (window.SfFightResult && typeof SfFightResult.isOpen === 'function' && SfFightResult.isOpen()) return false;
      if (document.querySelector('.classic-modal-overlay')) return false;
      if (document.querySelector('#ui .sf-levelup-view:not(.sf-levelup-bg-only)')) return false;
    }
    return true;
  }

  function sync() {
    if (state) { tick(); return true; }
    if (!pendingWs()) { wsPendingSince = 0; return false; }
    if (!wsPendingSince) wsPendingSince = Date.now();
    if (!canOpenWsOnly()) return false;
    const st = createState([], []);
    state = st;
    try {
      if (!begin(st)) { fail(st, new Error('没有可展示的升级内容')); return false; }
    } catch (e) {
      fail(st, e);
      return false;
    }
    return true;
  }

  function open(ups, onDone, onFail) {
    return enqueue(ups, { onDone, onFail });
  }

  function startWatch() {
    if (watch || typeof setInterval !== 'function') return;
    watch = setInterval(() => {
      try {
        if (state) tick();
        else if (pendingWs()) {
          if (!wsPendingSince) wsPendingSince = Date.now();
          sync();
        } else {
          wsPendingSince = 0;
        }
        if (!state && document.querySelector('.sf-levelup-root')) removeOrphanRoots(null);
      } catch (e) { err(e); }
    }, 500);
    if (watch && typeof watch.unref === 'function') watch.unref();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', () => { try { syncGeometry(); } catch (e) {  } });
      if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener('resize', () => { try { syncGeometry(); } catch (e) {  } });
      }
      // 网页端从 bfcache / 切后台回来时补一拍：断网重连或页面被冻结后，
      // 不能让升级弹窗停在旧的布局/旧的阶段里。
      const recheck = () => {
        try {
          if (state) tick();
          else if (pendingWs()) sync();
          else removeOrphanRoots(null);
        } catch (e) { err(e); }
      };
      window.addEventListener('pageshow', recheck);
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
      }
    }
  }
  startWatch();

  window.SfLevelUp = Object.freeze({
    open,
    enqueue: (ups, opts) => enqueue(ups, opts),
    sync,
    destroy: close,
    close,
    releaseBackground,
    isOpen: () => !!state,
    // 诊断用：模拟器上直接看当前阶段 / 待处理数量，不参与业务判断。
    debug: () => state ? { phase: state.phase, ups: state.ups.length, upIndex: state.upIndex, page: state.page, pendingWS: pendingWs(), deferred: state.deferredUps.length, wsBusy: state.wsBusy, wsError: state.wsError } : null,
  });
})();
