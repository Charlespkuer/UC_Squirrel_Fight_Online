// Shared UI feedback for DOM cards and SVG pop shells. No work at import time.
(function () {
  'use strict';

  const states = new WeakMap();
  const live = (node) => !!(node && node.classList && node.isConnected !== false);
  const disabled = (node) => !live(node) || node.disabled ||
    (node.getAttribute && node.getAttribute('aria-disabled') === 'true');
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // 触屏 / 新平台没有真正的悬停：`pointerenter` 只在点下那一拍来一次，`pointerleave`
  const noHover = () => !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  function state(node) {
    let s = states.get(node);
    if (!s) { s = { options: {}, pickTimer: 0, pressTimer: 0, actionTimer: 0, pending: false }; states.set(node, s); }
    return s;
  }
  function target(node, s) {
    const shell = s.options.shell;
    return (typeof shell === 'function' ? shell() : shell) || node;
  }
  function selected(node, s) {
    const value = s.options.selected;
    return typeof value === 'function' ? !!value() : !!value;
  }
  function refresh(node, s) {
    const host = target(node, s);
    if (!live(host)) return null;
    host.classList.add('sf-feedback');
    host.classList.toggle('sf-selected', selected(node, s));
    if (noHover()) host.classList.remove('sf-hover');
    return host;
  }
  function unpress(node, s) {
    if (s.pressTimer) clearTimeout(s.pressTimer);
    s.pressTimer = 0;
    const host = target(node, s);
    if (host && host.classList) host.classList.remove('pressed');
  }
  function press(node, s) {
    if (disabled(node)) return;
    const host = refresh(node, s);
    if (!host) return;
    unpress(node, s);
    void host.getBoundingClientRect();
    host.classList.add('pressed');
    s.pressTimer = setTimeout(() => unpress(node, s), 180);
  }
  function bind(node, options) {
    if (!node || !node.addEventListener || !node.classList) return node;
    const s = state(node);
    s.options = Object.assign({}, s.options, options || {});
    refresh(node, s);
    if (s.bound) return node;
    s.bound = true;
    node.addEventListener('pointerenter', () => {
      if (s.options.hover === false || noHover() || disabled(node)) return;
      const host = refresh(node, s);
      if (host) host.classList.add('sf-hover');
    });
    node.addEventListener('pointerleave', () => {
      const host = target(node, s);
      if (s.options.hover !== false && host && host.classList) host.classList.remove('sf-hover');
      unpress(node, s);
    });
    node.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      press(node, s);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
      node.addEventListener(event, () => unpress(node, s));
    }
    node.addEventListener('keydown', (event) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) press(node, s);
    });
    node.addEventListener('keyup', () => unpress(node, s));
    return node;
  }
  function pick(node) {
    if (!live(node)) return;
    const s = state(node), host = refresh(node, s);
    if (!host) return;
    if (s.pickTimer) clearTimeout(s.pickTimer);
    host.classList.remove('picked');
    void host.getBoundingClientRect();
    host.classList.add('picked');
    s.pickTimer = setTimeout(() => {
      s.pickTimer = 0;
      if (host.classList) host.classList.remove('picked');
    }, reduced() ? 0 : 500);
  }
  function tap(node, run, options) {
    if (disabled(node)) return false;
    const s = state(node);
    if (s.pending) return false;
    const opts = options || {}, host = refresh(node, s);
    s.pending = true;
    if (opts.press !== false) press(node, s);
    if (opts.pick) pick(node);
    if (opts.exit && host) host.classList.add('sf-leaving');
    const delay = reduced() ? 0 : Math.max(0, opts.delay == null ? 160 : Number(opts.delay) || 0);
    s.actionTimer = setTimeout(() => {
      s.actionTimer = 0;
      s.pending = false;
      if (host && host.classList) host.classList.remove('sf-leaving');
      if (!disabled(node) && typeof run === 'function') run();
    }, delay);
    return true;
  }
  function clear(node) {
    const s = node && states.get(node);
    if (!s) return;
    unpress(node, s);
    if (s.pickTimer) clearTimeout(s.pickTimer);
    if (s.actionTimer) clearTimeout(s.actionTimer);
    s.pickTimer = s.actionTimer = 0;
    s.pending = false;
    const host = target(node, s);
    if (host && host.classList) host.classList.remove('sf-hover', 'pressed', 'picked', 'sf-leaving');
  }

  // SVG 元件（`clip.g`）的唯一接线通道：监听器、热区/壳、按下闪帧都在这里，
  // 页面只传 idle/hover/press 与 freeze/css 等策略，不再有“重接模式”。
  const svgStates = new WeakMap();
  function svgToolkit() { return window.SfUiMain && window.SfUiMain.toolkit; }
  function pinSvg(clip, frame) {
    if (window.SfRender && SfRender.setPinned) SfRender.setPinned(clip, frame);
  }
  function refreshSvg(clip, s) {
    const t = svgToolkit();
    if (t && t.refreshShell) t.refreshShell(clip, s.options.freeze !== false);
  }
  function idleFrame(o) {
    return typeof o.idle === 'function' ? o.idle() : (o.idle == null ? 1 : o.idle);
  }
  function armSvg(clip, s) {
    const t = svgToolkit();
    if (!t) return;
    t.measureHitBox(clip);
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    if (s.options.css) bind(clip.g, { hover: false, shell: () => clip.g.querySelector(':scope > g.uc-pop') });
    s.armed = true;
    s.armFrame = clip.frame;
  }
  function wireSvg(clip, options) {
    const g = clip && clip.g;
    const t = svgToolkit();
    if (!g || !g.addEventListener || !t) return;
    let s = svgStates.get(clip);
    if (!s) { s = { bound: false, armed: false, armFrame: null, hovering: false, options: {} }; svgStates.set(clip, s); }
    const wasArmed = s.armed;
    s.options = Object.assign({}, s.options, options || {});
    const o = s.options;
    o.hover = Number(o.hover) || 0;
    o.press = Number(o.press) || 0;
    if (!s.bound) {
      s.bound = true;
      g.addEventListener('mouseenter', () => {
        const x = s.options;
        s.hovering = true;
        if (typeof x.onHover === 'function') x.onHover();
        if (!x.hover) return;
        pinSvg(clip, x.hover);
        refreshSvg(clip, s);
        if (typeof x.after === 'function') x.after();
      });
      g.addEventListener('mouseleave', () => {
        const x = s.options;
        s.hovering = false;
        pinSvg(clip, idleFrame(x));
        refreshSvg(clip, s);
        if (typeof x.after === 'function') x.after();
      });
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const x = s.options;
        if (x.press) {
          t.pressFlash(clip, idleFrame(x), () => { pinSvg(clip, idleFrame(x)); refreshSvg(clip, s); },
            (f) => pinSvg(clip, f));
        }
        if (typeof x.after === 'function') x.after();
        const fire = () => { if (typeof x.onFire === 'function') x.onFire(); };
        if (x.css) {
          if (window.SfUiFeedback) SfUiFeedback.tap(g, fire, { delay: 0, press: false });
          else fire();
        } else fire();
      });
    }
    g.style.cursor = 'pointer';
    g.style.pointerEvents = 'auto';
    if (!s.hovering) pinSvg(clip, idleFrame(o));
    const shell = g.querySelector(':scope > g.uc-pop');
    if (!s.armed || !shell || (!s.hovering && clip.frame !== s.armFrame)) armSvg(clip, s);
    if (typeof o.after === 'function') o.after();
    // 状态页重接后要把新壳重新钉住；第一次接线不走这一步（与原页一致）。
    if (wasArmed && o.refreshOnWire) refreshSvg(clip, s);
  }
  function idleOfSvg(clip) {
    const s = clip && svgStates.get(clip);
    return s ? idleFrame(s.options) : null;
  }
  function pinIdleSvg(clip) {
    const s = clip && svgStates.get(clip);
    if (!s) return false;
    pinSvg(clip, idleFrame(s.options));
    return true;
  }
  function unwireSvg(clip) {
    const s = clip && svgStates.get(clip);
    if (!s) return;
    s.armed = false;
    s.armFrame = null;
    s.hovering = false;
    s.options.onFire = null;
    s.options.idle = () => 1;
    if (clip.g) clear(clip.g);
  }

  window.SfUiFeedback = Object.freeze({
    bind: bind, tap: tap, pick: pick, clear: clear,
    wireSvg: wireSvg, unwireSvg: unwireSvg, idleOfSvg: idleOfSvg, pinIdleSvg: pinIdleSvg,
  });
})();
