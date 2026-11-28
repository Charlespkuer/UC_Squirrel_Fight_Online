// ui-guide.js —— ssfight 新手引导（原版 3625，25 帧）
(function () {
  'use strict';
  const GUIDE_FILE = 'tags-guide.json';
  const SYMBOL = '3625';

  const STEPS = {
    1: { frame: 1, ms: 0 },
    2: { frame: 2, ms: 2600, next: 3, stay: false },
    3: { frame: 3, ms: 4200, next: 4, stay: true },
    4: { frame: 4, ms: 4200, next: 5, stay: true },
    5: { frame: 5, ms: 4200, next: 6, stay: true },
    6: { frame: 6, ms: 4200, next: 7, stay: false },
    7: { frame: 7, ms: 0 },
    8: { frame: 8, ms: 0, above: true },
    9: { frame: 9, ms: 0, above: true },
    10: { frame: 10, ms: 0 },
    11: { frame: 11, ms: 4200, next: 12, stay: false },
    12: { frame: 12, ms: 3000, next: 99 },
    13: { frame: 13, ms: 0, above: true },
    14: { frame: 14, ms: 4200, next: 15, stay: false },
    15: { frame: 15, ms: 0 },
    17: { frame: 17, ms: 0 },
    19: { frame: 19, ms: 0 },
    20: { frame: 20, ms: 0 },
    21: { frame: 21, ms: 4000, next: 99 },
    22: { frame: 22, ms: 0, clickDismiss: true },
    23: { frame: 16, ms: 4000, next: 99 },
    24: { frame: 23, ms: 4000, next: 99 },
    25: { frame: 24, ms: 4000, next: 99 },
    26: { frame: 25, ms: 0 },
  };

  const LEVEL_STEPS = { 4: 21, 5: 13, 10: 23, 15: 24, 20: 17, 25: 19, 30: 20, 35: 26 };
  let current = null;
  let generation = 0;
  // 35 级征战提示是否真的在村庄页露过面：只露面之后再切页才把 26 标成完成，
  // 否则玩家一登录主页就被当成「已经看过」，提示再也出不来。
  let campaignHintShown = false;

  function classic() {
    return !!(window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic');
  }
  function state() {
    return window.State && State.state ? State.state() : null;
  }
  // 新档 / 旧档的引导进度。旧档（>1 级）没有这个字段时直接视为已完成，
  function tutorial() {
    const S = state();
    if (!S) return null;
    if (!S.tutorial || typeof S.tutorial.step !== 'number') {
      S.tutorial = { step: Number(S.level) <= 1 ? 1 : 99 };
    }
    return S.tutorial;
  }
  function step() {
    const t = tutorial();
    return t ? t.step : 99;
  }
  function setStep(n) {
    const t = tutorial();
    if (!t) return;
    if (State.setTutorialStep) { try { State.setTutorialStep(n); return; } catch (e) { err(e); } }
    t.step = n;
    try { State.save(); } catch (e) {}
  }
  function err(e) {
    if (window.__errs) window.__errs.push('SfGuide: ' + (e && (e.stack || e.message) || e));
  }
  function escText(s) { return SfRender.esc(s); }

  const TARGET_ART = new Set(['3589', '3590', '3591', '3592', '3593', '3595', '3596', '3597', '3598', '3599', '3602', '3609']);

  const DOM_TARGETS = {
    7: () => {
      const page = document.querySelector('.classic-page[data-screen="bag"]');
      return page && (page.querySelector('.catalog-cell[data-prop="1"] .item-icon') ||
        page.querySelector('.catalog-cell[data-prop="2"] .item-icon') ||
        page.querySelector('.catalog-cell[data-prop] .item-icon'));
    },

    8: () => document.querySelector('.sf-prop-use-view [data-prop-use]') ||
      document.querySelector('.classic-modal-overlay .modal-buttons button[data-action="0"]'),
    9: () => document.querySelector('.classic-modal-overlay .modal-buttons button[data-action="0"]'),
    10: () => document.querySelector('.classic-page[data-screen="bag"] footer [data-action="home"]'),
    13: () => document.querySelector('.sf-levelup-view [depth="20"]'),
    // 22：「去穿上刚送的白色装备」指状态页那颗真实的「更换装备」按钮
    // 不能用 f22 里烘焙在左下角的 3595 —— 那是原版另一种状态页版式的坐标，
    22: () => {
      try {
        const view = window.SfStatus && SfStatus.view ? SfStatus.view() : null;
        const clip = view && view.byName ? view.byName('b_change') : null;
        if (clip && clip.g && clip.g.isConnected) return clip.g;
      } catch (e) {}
      return document.querySelector('g[attach-name="b_change"]') ||
        document.querySelector('g[sid="7199"]');
    },
  };

  const HOME_TARGETS = {
    1: ['7006', 'challenge'],
    3: ['7006', 'challenge'],
    4: ['7011', 'messages'],
    5: ['7006', 'challenge'],
    6: ['6994', 'bag'],
    11: ['7006', 'challenge'],
    14: ['6999', 'status'],
  };

  function homeTargetRect(stepNo) {
    const spec = HOME_TARGETS[stepNo];
    if (!spec) return null;
    try {
      const page = document.querySelector('.ssfight-home') || document;
      const svg = page.querySelector('svg');

      const g = (svg && (svg.querySelector('g[sid="' + spec[0] + '"]') || svg.querySelector('g[name="' + spec[0] + '"]'))) ||
        document.querySelector('g[sid="' + spec[0] + '"]') ||
        document.querySelector('g[name="' + spec[0] + '"]');
      if (g) {
        const r = g.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return r;
      }
      const btn = document.querySelector('button[data-action="' + spec[1] + '"]');
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return r;
      }
    } catch (e) {}
    return null;
  }
  function highlightTargets(view, stepNo) {
    if (!view || !view.g) return;
    const svg = view.g;
    // 屏幕坐标 → SVG 用户坐标不能只信 getScreenCTM：WebKit 209220 在 iOS 15.5/15.6
    const map = (window.SfRender && SfRender.svgScreenMap) ? SfRender.svgScreenMap(svg) : null;
    if (!map) return;
    const toPoint = map.toUser;
    const toRect = (r) => {
      const p1 = toPoint(r.left, r.top);
      const p2 = toPoint(r.left + r.width, r.top + r.height);
      return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
    };
    const nodes = [...svg.querySelectorAll('g[type="sprite"]')].filter((n) => TARGET_ART.has(String(n.getAttribute('sid'))));
    const rects = nodes.map((n) => { try { return n.getBoundingClientRect(); } catch (e) { return null; } });
    const rings = new Set();
    const addRing = (r, dxScreen) => {
      const shifted = dxScreen ? { left: r.left + dxScreen, top: r.top, width: r.width, height: r.height } : r;
      const box = toRect(shifted);
      if (!box) return;
      const key = [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)].join(',');
      if (rings.has(key)) return;
      rings.add(key);
      const pad = Math.max(1.5, Math.min(4, box.h * 0.08));
      // 目标贴着屏幕底边时（f10 的「返回菜单」就在页面最底部），金环的 padding
      // Windows 上看到的就是「框歪了、没框住返回菜单」。这里把矩形夹在当前窗口的
      let vw = 0, vh = 0;
      try {
        vw = Math.max(0, Number(window.innerWidth) || 0);
        vh = Math.max(0, Number(window.innerHeight) || 0);
      } catch (e) {}
      let x = box.x - pad, y = box.y - pad, w = box.w + pad * 2, h = box.h + pad * 2;
      if (vw > 1 && vh > 1) {
        const vp1 = toPoint(0, 0), vp2 = toPoint(vw, vh);
        const insetX = 1.5 / (map.scaleX || 1), insetY = 1.5 / (map.scaleY || 1);
        const minX = Math.min(vp1.x, vp2.x) + insetX, maxX = Math.max(vp1.x, vp2.x) - insetX;
        const minY = Math.min(vp1.y, vp2.y) + insetY, maxY = Math.max(vp1.y, vp2.y) - insetY;
        if (x < minX) { w -= minX - x; x = minX; }
        if (y < minY) { h -= minY - y; y = minY; }
        if (x + w > maxX) w = maxX - x;
        if (y + h > maxY) h = maxY - y;
        if (!(w > 1) || !(h > 1)) return;       // 目标整个在屏外：宁可不画，也不要画一条残边
      }
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      ring.setAttribute('class', 'sf-guide-target');
      ring.setAttribute('x', x.toFixed(2));
      ring.setAttribute('y', y.toFixed(2));
      ring.setAttribute('width', w.toFixed(2));
      ring.setAttribute('height', h.toFixed(2));
      ring.setAttribute('rx', Math.max(2, Math.min(10, h / 2)).toFixed(2));
      ring.setAttribute('fill', 'rgba(255,237,120,.20)');
      ring.setAttribute('stroke', '#ffe45c');
      ring.setAttribute('stroke-width', '1.6');
      ring.setAttribute('pointer-events', 'none');

      if (hand && hand.parentNode === svg) svg.insertBefore(ring, hand);
      else svg.appendChild(ring);
    };
    const hand = svg.querySelector('g[type="sprite"][sid="3586"]');
    if (hand && hand.dataset.guideT === undefined) hand.dataset.guideT = hand.getAttribute('transform') || '';
    const moveHand = (target) => {
      if (!hand) return null;
      try {

        const hr = hand.getBoundingClientRect();
        const a = toPoint(hr.left, hr.top);
        const b = toPoint(hr.right, hr.bottom);
        const c = toPoint(target.left + target.width / 2, target.top + target.height / 2);
        const addX = c.x - (a.x + b.x) / 2;
        const addY = c.y - b.y;
        // 手指可能已经因为窗口 resize 被移动过一次：在已累计的位移上再加本次差值，
        // 不能拿本次差值直接覆盖旧 translate（否则第二次重算会跳回半个原位）。
        const dx = (Number(hand.dataset.guideDx) || 0) + addX;
        const dy = (Number(hand.dataset.guideDy) || 0) + addY;
        hand.dataset.guideDx = String(dx);
        hand.dataset.guideDy = String(dy);
        hand.setAttribute('transform', 'translate(' + dx.toFixed(2) + ',' + dy.toFixed(2) + ') ' + (hand.dataset.guideT || ''));
        return hand;
      } catch (e) { return null; }
    };

    for (const node of nodes) node.style.display = 'none';
    // DOM 目标（弹窗按钮 / 升级页确定）是异步挂的：没出现就等一会儿再画，
    let tries = 0;
    const paint = () => {
      for (const r of [...svg.querySelectorAll('rect.sf-guide-target')]) r.remove();
      rings.clear();
      const domOf = DOM_TARGETS[stepNo];
      if (domOf) {
        const el = domOf();
        if (el && el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0) {
          const ir = el.getBoundingClientRect();
          moveHand(ir);
          addRing(ir, 0);
          return;
        }
        if (tries++ < 12) { setTimeout(paint, 120); return; }
        if (stepNo === 8 || stepNo === 9 || stepNo === 10) return;
      }

      const homeRect = homeTargetRect(stepNo);
      if (homeRect) {
        moveHand(homeRect);
        addRing(homeRect, 0);
        return;
      }
      if (HOME_TARGETS[stepNo] && tries++ < 12) { setTimeout(paint, 120); return; }
      nodes.forEach((node, i) => {
        const r = rects[i];
        if (!r || !r.width || !r.height) return;

        if (stepNo === 3) return;
        addRing(r, 0);
      });
    };
    paint();

    if (stepNo === 10) setTimeout(() => { if (svg.isConnected) paint(); }, 300);
  }

  function freeze(view) {
    try { SfUiMain.toolkit.freezeView(view); } catch (e) { err(e); }
  }
  function hide() {
    generation++;
    if (!current) return;
    const old = current;
    current = null;
    clearTimeout(old.timer);
    clearTimeout(old.reflowTimer);
    if (old.reflow) {
      try { window.removeEventListener('resize', old.reflow); } catch (e) {}
      try { if (window.visualViewport) window.visualViewport.removeEventListener('resize', old.reflow); } catch (e) {}
    }
    if (old.dismiss) {
      try { document.removeEventListener('pointerdown', old.dismiss, true); } catch (e) {}
      try { document.removeEventListener('touchstart', old.dismiss, true); } catch (e) {}
    }
    try { if (old.view) old.view.destroy(); } catch (e) {}
    try { if (old.host && old.host.parentNode) old.host.parentNode.removeChild(old.host); } catch (e) {}
  }
  function samePage(ctx) {
    if (!ctx || ctx === 'battle') return true;
    if (!window.UI || !UI.currentScreen) return true;
    const now = UI.currentScreen();
    return ctx === 'home' ? (!now || now === 'home') : now === ctx;
  }
  function schedule(record, spec) {
    if (!spec.ms) return;
    const mine = record.seq;
    record.timer = setTimeout(() => {
      if (!current || current.seq !== mine) return;

      if (!current.host.isConnected || !samePage(record.ctx)) { hide(); return; }
      setStep(spec.next);
      if (spec.stay && step() === spec.next) show(spec.next, record.ctx);
      else hide();
    }, spec.ms);
  }

  function armClickDismiss(record, stepNo) {
    setTimeout(() => {
      if (!current || current !== record || record.step !== stepNo) return;
      const onDown = () => {
        try { document.removeEventListener('pointerdown', onDown, true); } catch (e) {}
        try { document.removeEventListener('touchstart', onDown, true); } catch (e) {}
        if (current !== record || record.step !== stepNo) return;
        setStep(99);
        hide();
      };
      record.dismiss = onDown;
      document.addEventListener('pointerdown', onDown, true);
      // iOS 15 的 WKWebView 可能只在 SVG 上派发 touch 事件、不派发 pointerdown；
      document.addEventListener('touchstart', onDown, { capture: true, passive: true });
    }, 80);
  }
  // 等主页 SVG 真的挂上（最多 maxMs）：引导要按已挂好的页面算高亮位置。
  function homePainted(maxMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const step = () => {
        const home = document.querySelector('#ui .ssfight-home svg') || document.querySelector('#ui .classic-home');
        if (home || Date.now() - t0 >= maxMs) { resolve(); return; }
        setTimeout(step, 60);
      };
      step();
    });
  }
  function show(stepNo, ctx) {
    if (!classic()) { hide(); return; }
    const spec = STEPS[stepNo];
    if (!spec) { hide(); return; }
    if (!state() || step() !== stepNo) return;

    const level = Number(state().level) || 1;
    if (ctx === 'home' && ((stepNo === 4 || stepNo === 5) && level < 2)) { hide(); return; }
    if (ctx === 'home' && stepNo === 6 && level < 3) { hide(); return; }
    if (current && current.step === stepNo && current.ctx === ctx && current.host && current.host.isConnected) return;
    hide();
    const ui = document.getElementById('ui');
    if (!ui) return;
    const host = document.createElement('section');
    // `sf-clickthrough`：整层只负责“讲”，不能吃掉目标按钮的轻点。不能只靠父级的
    // `pointer-events:none` 继承进 SVG —— iOS 15 的 WKWebView 在这条继承上不可靠，
    host.className = 'sf-guide-view sf-clickthrough stage' + (spec.above ? ' above' : '') + (ctx === 'battle' ? ' battle' : '');
    host.setAttribute('aria-hidden', 'true');
    host.dataset.guideStep = String(stepNo);
    ui.appendChild(host);
    const seq = ++generation;
    current = { seq, host, view: null, timer: 0, step: stepNo, ctx, dismiss: null };
    const mine = seq;
    Promise.resolve()
      // 首页引导是覆盖层：等主页 SVG 落定再拉 194 KB 的 tags-guide，别和首页素材抢带宽。
      .then(() => (ctx === 'home' ? homePainted(1200) : null))
      .then(() => SfRender.load())
      .then(() => SfRender.loadExtra(GUIDE_FILE))
      .then(() => {
        if (!current || current.seq !== mine) return null;
        return SfRender.mountSymbol(host, SYMBOL, { frame: spec.frame, label: '新手引导' });
      })
      .then((view) => {
        if (!view) return;
        if (!current || current.seq !== mine) { try { view.destroy(); } catch (e) {} return; }
        current.view = view;
        freeze(view);
        highlightTargets(view, spec.frame);

        const reflow = () => {
          if (!current || current.seq !== mine || !current.view) return;
          clearTimeout(current.reflowTimer);
          current.reflowTimer = setTimeout(() => {
            if (!current || current.seq !== mine || !current.view) return;
            try { highlightTargets(current.view, spec.frame); } catch (e) { err(e); }
          }, 120);
        };
        current.reflow = reflow;
        try { window.addEventListener('resize', reflow); } catch (e) {}
        try { if (window.visualViewport) window.visualViewport.addEventListener('resize', reflow); } catch (e) {}
        if (spec.clickDismiss) armClickDismiss(current, stepNo);
        schedule(current, spec);
      })
      .catch((e) => { err(e); if (current && current.seq === mine) hide(); });
  }

  function onHome() {
    if (!classic()) { hide(); return; }
    const n = step();
    if (n === 1) { show(1, 'home'); return; }
    if (n === 2) { setStep(3); show(3, 'home'); return; }
    if (n === 3 || n === 4 || n === 5 || n === 6) { show(n, 'home'); return; }
    if (n === 10) { setStep(11); show(11, 'home'); return; }
    if (n === 11 || n === 14) { show(n, 'home'); return; }

    if (n === 13) { setStep(14); show(14, 'home'); return; }
    if (n === 21 || n === 23 || n === 24 || n === 25) { show(n, 'home'); return; }
    // 35 级的征战提示没有后续自动步进；已经露过面后再离开村庄就完成本步。
    if (n === 26 && campaignHintShown) { campaignHintShown = false; setStep(99); }
    hide();
  }

  function onBattleStart() {
    if (!classic()) { hide(); return; }
    const n = step();
    if (n === 1) { setStep(2); show(2, 'battle'); return; }
    if (n === 2) { show(2, 'battle'); return; }
    if (n === 26 && campaignHintShown) { campaignHintShown = false; setStep(99); }
    hide();
  }

  function onPage(name) {
    if (!classic()) { hide(); return; }
    if (name === 'home') { onHome(); return; }
    const n = step();
    // 35 级提示只在村庄主页展示；露过面后切到任何其它页面就完成本步，避免回来又冒出来。
    if (n === 26 && name !== 'village' && campaignHintShown) {
      campaignHintShown = false;
      setStep(99);
      hide();
      return;
    }
    // 点中下一处入口就算完成当前一步，不必等计时：
    if (name === 'challenge' && n === 3) { setStep(4); hide(); return; }
    if (name === 'message' && n === 4) { setStep(5); hide(); return; }
    if (name === 'challenge' && n === 5) { setStep(6); hide(); return; }

    if (name === 'challenge' && (n === 11 || n === 12)) {
      if (n === 11) setStep(12);
      show(12, 'challenge');
      return;
    }
    if (name === 'bag') {
      if (n === 6) { setStep(7); show(7, 'bag'); return; }

      if (n === 7 || n === 8 || n === 10) { show(n, 'bag'); return; }
      if (n === 9) return;
    }
    if (name === 'status') {
      if (n === 14) { setStep(15); show(15, 'status'); return; }
      if (n === 15 || n === 22) { show(n, 'status'); return; }
    }
    if (name === 'village' && (n === 17 || n === 19 || n === 20 || n === 26)) {
      if (n === 26) campaignHintShown = true;
      show(n, 'village');
      return;
    }

    if (name === 'village-altar' && n === 17) { setStep(99); hide(); return; }
    if (name === 'village-beast' && n === 19) { setStep(99); hide(); return; }
    if (name === 'village-miracle' && n === 20) { setStep(25); hide(); return; }
    if (name === 'village-war' && n === 26) { setStep(99); hide(); return; }
    hide();
  }

  function onGears() {
    if (!classic()) return;
    const t = tutorial();
    const S = state();
    if (!t || !S || Number(S.level) < 5) return;
    if (step() < 13) return;
    // 一次性标记在 State 里（`starterGearGiven`，随存档走）；`t.gearsGift` 只作旧档兼容。
    if (S.starterGearGiven || t.gearsGift) return;
    if (window.__SSDZ_ONLINE__ && window.StateCall) {
      if (onGears.pending) return;
      onGears.pending = true;
      return StateCall('grantStarterGear').then(gear => {
        if (gear && window.UI && UI.toast) UI.toast('新手福利：获得【' + gear.name + '】，已放入装备背包');
      }).catch(err).finally(() => { onGears.pending = false; });
    }
    let gear = null;
    try { gear = State.grantStarterGear && State.grantStarterGear(); } catch (e) { err(e); }
    if (gear) {
      t.gearsGift = true;
      if (window.UI && UI.toast) UI.toast('新手福利：获得【' + gear.name + '】，已放入装备背包');
    }
  }

  function onPropDetail(id, mode) {
    if (!classic() || mode) return;
    const n = step();
    if (n === 7) { setStep(8); show(8, 'bag'); return; }
    if (n === 8) { show(8, 'bag'); return; }
    if (n === 9) { setStep(10); show(10, 'bag'); }
  }

  function onPropUsed(id, name, r, detail) {
    if (!classic() || step() !== 8 || !r || !r.ok) return false;
    if (!(window.UI && UI.classic && UI.classic.modal)) return false;
    setStep(9);
    try { if (detail && detail.close) detail.close(); } catch (e) {}
    UI.classic.modal('提示', '<p>' + escText('使用' + name + '成功。' + (r.msg || '')) + '</p>', [
      { label: '确定', run: () => { setStep(10); onPage('bag'); } },
    ], { small: true });
    show(9, 'bag');
    return true;
  }
  // 状态页页签：原版 tab1/tab2.onFire 只在 nowPage==15 才 doMission+showStatusTab
  // （:13721-13760）→ guideMap 15→22。本版不能让 f22 跟着「离开状态页」那一下弹出来：
  function onStatusTab(key) {
    if (!classic()) return;
    const n = step();
    if (key === 'status') {
      if (n === 22) show(22, 'status');
      return;
    }
    if (n === 15) { setStep(22); hide(); return; }
    if (n === 22) hide();
  }

  function onLevelup(ups) {
    if (!classic() || !ups || !ups.length) return;
    let max = 0;
    for (const u of ups) max = Math.max(max, Number(u && u.level) || 0);
    const page = LEVEL_STEPS[max];
    if (!page) return;
    setStep(page);
    if (page === 13) show(13, 'levelup');
  }

  function onLevelupDone() {
    if (!classic()) return;
    if (step() === 13) { setStep(14); hide(); }
  }
  function skip() {
    const t = tutorial();
    if (t) setStep(99);
    hide();
  }
  window.SfGuide = Object.freeze({
    onHome, onBattleStart, onPage, onPropDetail, onPropUsed, onStatusTab, onLevelup, onLevelupDone,
    onGears,
    hide, skip, step: () => step(),
  });
})();
