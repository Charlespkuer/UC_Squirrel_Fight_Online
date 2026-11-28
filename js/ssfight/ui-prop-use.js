// ui-prop-use.js — 经典背包「道具使用」弹窗（原版「道具1」4886 第 1 帧）
(function () {
  'use strict';

  const T = () => (window.SfUiMain && SfUiMain.toolkit) || null;
  const clipOf = SfUiMain.toolkit.clipOf;
  const stopAt = (clip, frame) => {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(frame); } catch (e) {}
  };
  // 兜底图标：与背包/商店共用同一张路径表（`UI.classic.propIconSrc`，全部是矢量图）。
  const iconSrc = (id) => {
    const classic = window.UI && window.UI.classic;
    if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(id);
    return 'images/ui/icons/prop/prop-' + Number(id) + '.svg';
  };

  let session = null;

  function createHost(extra) {
    return SfUiMain.toolkit.createSubviewHost('sf-prop-use-view', '道具使用', extra);
  }

  // 只拆这一份 session，不碰后来打开的那一份（异步/旧 handle 回来时尤其重要）。
  function dispose(rec) {
    if (!rec || rec.closed) return;
    rec.closed = true;
    if (rec.observer) { try { rec.observer.disconnect(); } catch (e) {} rec.observer = null; }
    if (rec.view) { try { rec.view.destroy(); } catch (e) {} }
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
  }

  function destroy() {
    const rec = session;
    session = null;
    dispose(rec);
  }

  function closeSession(rec) {
    if (!rec || rec.closed) return;
    if (session === rec) session = null;
    dispose(rec);
    if (typeof rec.onClose === 'function') {
      try { rec.onClose(); } catch (e) {}
    }
  }

  function close() { closeSession(session); }

  function setText(view, name, value) {
    const clip = clipOf(view, name);
    if (clip) SfRender.setText(clip, String(value == null ? '' : value));
  }


  function paintIcon(clip, src) { SfUiMain.toolkit.paintSvgIcon(clip, src, 'sf-prop-use-icon'); }


  let propIconMapPromise = null;
  function propIconMap() {
    if (!propIconMapPromise) {
      propIconMapPromise = (window.SfRender && typeof SfRender.loadTable === 'function')
        ? SfRender.loadTable('prop-icons.json').catch(() => null)
        : (typeof fetch === 'function'
          ? fetch('images/ssfight/ui/prop-icons.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
          : Promise.resolve(null));
    }
    return propIconMapPromise;
  }

  async function paintVectorIcon(clip, id) {
    if (!clip || !clip.g || !window.SfRender || !SfRender.mountSymbol) return;
    const map = await propIconMap();
    const rec = map && map.byId && map.byId[String(id)];
    const sym = rec && rec.id;
    if (!sym || clip.g.isConnected === false) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:64px;height:64px;overflow:hidden;pointer-events:none';
    document.body.appendChild(host);
    let view = null;
    try {
      view = await SfRender.mountSymbol(host, sym, {
        // 87（征战令）取的是 SWF 3105 红色战令本体；用 3105/3106 的包围盒，
        // 不能套 3107 带底卡时的 47×47 舞台坐标，否则底部会裁掉约 1px。
        frame: 1, label: '道具矢量图标',
        viewBox: String(id) === '87' ? '-3 -1 47 47' : '0 -2 47 47',
      });
      if (clip.g.isConnected === false) return;
      const src = view && (view.g || view.root);
      if (!src) return;
      const box = (() => { try { return clip.g.getBBox(); } catch (e) { return null; } })();
      const w = Math.max(24, Number(box && box.width) || 44);
      const h = Math.max(24, Number(box && box.height) || 44);
      const size = Math.min(w, h) * 0.92;
      const svg = src.cloneNode(true);
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('x', String((Number(box && box.x) || 0) + (w - size) / 2));
      svg.setAttribute('y', String((Number(box && box.y) || 0) + (h - size) / 2));
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('pointer-events', 'none');
      const target = clip.getContentHost ? clip.getContentHost() : clip.g;
      if (!target) return;
      for (const old of target.querySelectorAll('image.sf-prop-use-icon')) old.remove();
      target.appendChild(svg);
    } catch (e) {
      if (window.__errs) window.__errs.push('prop vector icon: ' + (e && e.message));
    } finally {
      if (view) { try { view.destroy(); } catch (e) {} }
      host.remove();
    }
  }


  function baseMatrix(clip) {
    const raw = clip && clip.g && clip.g.__baseMa;
    if (typeof raw !== 'string') return null;
    const p = raw.split(',').map(Number);
    return p.length === 6 && p.every((v) => Number.isFinite(v)) ? p : null;
  }

  // 画稿在舞台坐标里的水平中心。`getBBox()` 不含元件自身的放置矩阵，所以要先补 m[4]。
  function stageCenterX(clip) {
    if (!clip || !clip.g) return null;
    const m = baseMatrix(clip);
    if (!m) return null;
    let box = null;
    try { box = clip.g.getBBox(); } catch (e) { return null; }
    if (!box || !(box.width > 0)) return null;
    return m[4] + (box.x + box.width / 2) * m[0];
  }

  // （主路径现在走 `layoutActionButtons`；这里保留为拿不到几何时的兜底。）
  function swapButtons(use, cancel) {
    const a = baseMatrix(use), b = baseMatrix(cancel);
    if (!a || !b) return;
    const dx = b[4] - a[4];
    const sa = Math.abs(a[0]) || 1, sb = Math.abs(b[0]) || 1;
    if (use.setExtraTransform) use.setExtraTransform('translate(' + (dx / sa).toFixed(3) + ',0)');
    if (cancel.setExtraTransform) cancel.setExtraTransform('translate(' + (-dx / sb).toFixed(3) + ',0)');
  }


  const BUTTON_USE_SCALE = 1.03;
  const BUTTON_GAP_RATIO = 0.45;
  // 按钮排版只依赖画稿 bbox + 原版 base matrix，不依赖屏幕缩放；
  // 首帧未布局/窗口缩放都不会把两键挤到一起。先包反馈壳再调用，`__hitBox` 是画稿尺寸。
  // `centerAt`：舞台坐标里的对齐中心；不传时用舞台中心（4886 的弹窗面板本身居中）。
  function layoutActionButtons(view, right, cancel, mode, centerAt) {
    if (!right || !cancel || !right.g || !cancel.g || !right.setExtraTransform) return false;
    const svg = right.g.ownerSVGElement || view.g.ownerSVGElement;
    const vb = svg && svg.viewBox && svg.viewBox.baseVal;
    const wanted = centerAt == null ? NaN : Number(centerAt);
    const centerX = Number.isFinite(wanted) ? wanted : (vb && vb.width ? vb.x + vb.width / 2 : 160);
    const measure = (clip) => {
      const m = baseMatrix(clip);
      if (!m) return null;
      const s = Math.abs(m[0]) || 1;
      const k = mode === 'use' ? BUTTON_USE_SCALE / s : 1;
      let b = clip.__hitBox;
      if (!b || !b.w) {
        try {
          const box = clip.g.getBBox();
          b = { x: box.x, y: box.y, w: box.width, h: box.height };
        } catch (e) { return null; }
      }
      if (!b || !(b.w > 0)) return null;
      return {
        m, s, k, width: b.w * s * k,
        centerLocal: (Number(b.x) || 0) + (Number(b.w) || 0) / 2,
      };
    };
    const a = measure(cancel), b = measure(right);
    if (!a || !b) { swapButtons(right, cancel); return false; }
    const gap = Math.min(a.width, b.width) * BUTTON_GAP_RATIO;
    const place = (clip, info, targetCenter) => {
      const tx = (targetCenter - info.m[4]) / info.m[0] - info.k * info.centerLocal;
      clip.setExtraTransform('translate(' + tx.toFixed(3) + ',0) scale(' + info.k.toFixed(5) + ')');
    };
    place(cancel, a, centerX - gap / 2 - a.width / 2);
    place(right, b, centerX + gap / 2 + b.width / 2);
    return true;
  }

  // 商店购买窗：挂 4886 第 1 帧（与背包详情窗同一份画稿），再把第 2 帧的
  // f1 自带的「使用」(d9) 与「取消」(d13) 不能留，否则会和并入的两颗叠在一起。
  function mergeBuyFrame(view) {
    if (!view || !view.tag || !SfRender.buildFrames) return false;
    const all = SfRender.buildFrames(view.tag.Sf);
    const base = all[0], buy = all[1];
    if (!base || !buy) return false;
    const merged = new Map(base);
    merged.delete(9);
    merged.delete(13);
    for (const depth of [22, 26]) {
      const p = buy.get(depth);
      if (p) merged.set(depth, p);
    }
    view.frames = [merged];
    view.frame = 0;
    // ⚠ 帧数组被整体换掉了，必须强制重建显示列表：`showFrame()` 对“同帧重复调用”
    view.__shownFrame = -1;
    view.showFrame();
    return true;
  }


  function centerClip(clip, centerX) {
    if (!clip || !clip.g) return;
    const m = baseMatrix(clip);
    if (!m) return;
    const scale = Math.abs(m[0]) || 1;
    const b = (() => { try { return clip.g.getBBox(); } catch (e) { return null; } })();
    if (!b) return;
    const bx = Number(b.x) || 0, bw = Number(b.width) || 0;
    const current = m[4] + (bx + bw / 2) * m[0];
    const dx = (Number(centerX) - current) / scale;
    if (clip.setExtraTransform) clip.setExtraTransform('translate(' + dx.toFixed(3) + ',0)');
  }
  // 接一颗原版按钮：默认第 1 帧常态（奶油灰）/ 第 2 帧悬停（绿）。
  // `opts.idle` / `opts.hover` 可覆盖（合成页等也复用同一套约定）。
  function wireButton(clip, onFire, role, opts) {
    if (!clip || !clip.g) return;
    const idle = opts && opts.idle != null ? opts.idle : 1;
    const hover = opts && opts.hover != null ? opts.hover : 2;
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    if (role === 'use') {
      clip.g.classList.add('sf-prop-use-btn');
      clip.g.setAttribute('data-prop-use', '1');
    } else if (role === 'buy') {
      clip.g.classList.add('sf-prop-buy-btn');
      clip.g.setAttribute('data-prop-buy', '1');
    } else if (role === 'cancel') {
      clip.g.classList.add('sf-prop-cancel-btn');
      clip.g.setAttribute('data-prop-cancel', '1');
    }
    stopAt(clip, idle);
    const t = T();
    if (t) {
      try { t.measureHitBox(clip); t.popWrap(clip); } catch (e) {}
      const shell = clip.g.querySelector(':scope > g.uc-pop');
      if (shell) { try { t.wirePopPress(shell); } catch (e) {} }
    }
    clip.g.addEventListener('mouseenter', () => stopAt(clip, hover));
    clip.g.addEventListener('mouseleave', () => stopAt(clip, idle));
    clip.g.addEventListener('click', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();

      stopAt(clip, hover);
      onFire();
    });
  }

  // 道具说明：背包使用窗 / 不可使用道具的详情窗 / 商店购买窗共用同一套排版
  // 购买窗除两颗按钮外必须与背包详情逐项一致，所以这里只留一份实现。
  function writeRemark(view, text) {
    setWrappedField(clipOf(view, 'vipDes'), text == null ? '' : text, 10, 2);
  }

  function fill(view, id) {
    const base = propMap.getValue(Number(id));
    if (!base) return;
    setText(view, 'name', base.name);
    writeRemark(view, base.remark);
    const c1 = clipOf(view, 'c1');
    stopAt(c1, 2);
    paintIcon(c1, iconSrc(id));
    void paintVectorIcon(c1, id);
  }


  function hideClip(clip) {
    const node = clip && (clip.g || clip);
    if (node && node.style) node.style.display = 'none';
  }

  function fillBuy(view, id, base) {
    setText(view, 'name', base.name);
    writeRemark(view, base.remark);
    const c1 = clipOf(view, 'c1');
    stopAt(c1, 2);
    paintIcon(c1, iconSrc(id));
    void paintVectorIcon(c1, id);
  }


  async function openBuy(propId, opts) {
    opts = opts || {};
    const id = Number(propId);
    const base = propMap.getValue(id);
    if (!base) return null;
    destroy();
    const host = createHost('sf-prop-buy-view');
    if (!host) return null;
    const rec = {
      host: host, propId: id, view: null, observer: null, mode: 'buy',
      onBuy: opts.onBuy, onClose: opts.onClose, onStale: opts.onStale,
      max: Math.max(1, Math.min(50, Number(opts.max) || 50)),
      stock: Math.max(0, Number(opts.stock) || 0),
    };
    session = rec;
    if (window.MutationObserver) {
      try {
        rec.observer = new MutationObserver(() => {
          if (!host.isConnected && !rec.closed) closeSession(rec);
        });
        if (host.parentNode) rec.observer.observe(host.parentNode, { childList: true });
        rec.observer.observe(document.body, { childList: true });
      } catch (e) { rec.observer = null; }
    }
    let view = null;
    try {
      await SfRender.loadExtra('tags-daoju.json');
      if (session !== rec || !host.isConnected) {
        if (rec.onStale) { try { rec.onStale(); } catch (e) {} }
        if (session === rec) destroy();
        return null;
      }
      view = await SfRender.mountSymbol(host, '4886', { frame: 1, label: '购买道具', blank: ['name', 'vipDes'] });
      if (session !== rec || !host.isConnected) {
        if (rec.onStale) { try { rec.onStale(); } catch (e) {} }
        try { view.destroy(); } catch (e) {}
        view = null;
        if (session === rec) destroy();
        return null;
      }
      rec.view = view;

      mergeBuyFrame(view);
      fillBuy(view, id, base);
      const buy = clipOf(view, 'button2');
      const cancel = clipOf(view, 'button3');

      const setReason = (text) => writeRemark(view, text == null ? '' : text);
      const draw = () => {
        if (!buy) return;
        const off = rec.stock <= 0;
        // 售罄：把购买键从"点击路由"里摘掉（路由是按包围盒判归属的，只关
        // ⚠ 售罄时不压透明度：以前 `opacity:.65` 会把购买键整颗调浅，
        const t = T();
        if (t && t.unregisterHit && t.registerHit) {
          if (off && !rec.buyUnregistered) {
            try { t.unregisterHit(buy); rec.buyUnregistered = true; } catch (e) {}
          } else if (!off && rec.buyUnregistered) {
            try { t.registerHit(buy, false); rec.buyUnregistered = false; } catch (e) {}
          }
        }
        if (buy.g) buy.g.style.opacity = '';
        if (off) {
          // 路由一撤，mouseleave 不会再回来；把购买键拨回常态帧，
          // 否则点完最后一件时它会停在点击那一刻的悬停绿色。
          stopAt(buy, 1);
        }
        if (off && !rec.soldOutNoted) {
          rec.soldOutNoted = true;
          setReason('今日已经卖完了，明天再来。');
        } else if (!off && rec.soldOutNoted) {
          rec.soldOutNoted = false;
          setReason(base.remark || '');
        }
      };
      const handle = {
        close: () => closeSession(rec),
        sync: (next) => {
          if (next && Number.isFinite(Number(next.stock))) rec.stock = Math.max(0, Number(next.stock));
          draw();
        },
        setReason,
        element: host,
        get view() { return rec.view; },
        propId: id,
      };

      wireButton(buy, () => {
        if (rec.stock <= 0) return;
        let ok = false;
        try { ok = rec.onBuy ? rec.onBuy(1, handle) === true : false; } catch (e) {
          if (window.__errs) window.__errs.push('buy prop: ' + (e && e.message));
        }
        if (ok) closeSession(rec);
        else draw();
      }, 'buy', { idle: 1, hover: 2 });
      wireButton(cancel, () => closeSession(rec), 'cancel');
      // 必须等 popWrap 量完画稿再排版：先排版会把按钮旧宽度当成间距基准，
      // 反馈壳把按钮撑大后两键会挤在一起。见 open() 同一顺序。
      layoutActionButtons(view, buy, cancel, 'buy');
      draw();
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
      return handle;
    } catch (e) {
      if (window.__errs) window.__errs.push('buy prop: ' + (e && e.message));
      if (view) { try { view.destroy(); } catch (e2) {} }
      if (session === rec) destroy();
      return null;
    }
  }

  // 把 4886 的长文本字段（vipDes）压成小字号、按框宽断行；原版字段只有一两行。
  function setWrappedField(clip, text, size, maxLines, dy, maxCols) {
    if (!clip) return;
    size = Number(size) || 10;
    const box = clip.__textBox && clip.__textBox.box;
    const width = box ? Math.max(40, box.xmax - box.xmin) : 223;
    const cap = Math.max(8, Number(maxCols) || 20);
    const per = Math.max(8, Math.min(cap, Math.floor(width / (size * 1.08))));
    const lines = [];
    for (const para of String(text == null ? '' : text).split(/\r\n|\r|\n/)) {
      const chars = Array.from(para);
      if (!chars.length) { lines.push(''); continue; }
      for (let i = 0; i < chars.length; i += per) lines.push(chars.slice(i, i + per).join(''));
    }
    const max = Math.max(1, Number(maxLines) || 2);
    if (lines.length > max) {
      lines.length = max;
      lines[max - 1] = Array.from(lines[max - 1]).slice(0, Math.max(1, per - 1)).join('') + '…';
    }
    if (!SfRender.setText(clip, lines.join('\n'))) return;
    const texts = Array.from((clip.g || clip).querySelectorAll('text'));
    const baseY = texts.length ? Number(texts[0].getAttribute('y')) || 0 : 0;
    texts.forEach((t, i) => {
      t.setAttribute('fill', '#000000');
      t.setAttribute('font-size', String(size));
      t.setAttribute('y', String(Math.round((baseY + (Number(dy) || 0) + i * size * 1.25) * 100) / 100));
    });
  }


  function fillInfo(view, id, base) {
    setText(view, 'name', base.name);
    writeRemark(view, base.remark);
    const c1 = clipOf(view, 'c1');
    stopAt(c1, 2);
    paintIcon(c1, iconSrc(id));
    void paintVectorIcon(c1, id);
    hideClip(clipOf(view, 'button1'));
  }

  async function openInfo(propId, opts) {
    opts = opts || {};
    const id = Number(propId);
    const base = propMap.getValue(id);
    if (!base) return null;
    destroy();
    const host = createHost('sf-prop-info-view');
    if (!host) return null;
    const rec = { host, propId: id, view: null, observer: null, mode: 'info', onClose: opts.onClose };
    session = rec;
    if (window.MutationObserver) {
      try {
        rec.observer = new MutationObserver(() => { if (!host.isConnected && !rec.closed) closeSession(rec); });
        if (host.parentNode) rec.observer.observe(host.parentNode, { childList: true });
        rec.observer.observe(document.body, { childList: true });
      } catch (e) { rec.observer = null; }
    }
    let view = null;
    try {
      await SfRender.loadExtra('tags-daoju.json');
      if (session !== rec || !host.isConnected) { if (session === rec) destroy(); return null; }
      view = await SfRender.mountSymbol(host, '4886', { frame: 1, label: '道具详情', blank: ['name', 'vipDes'] });
      if (session !== rec || !host.isConnected) {
        try { view.destroy(); } catch (e) {}
        if (session === rec) destroy();
        return null;
      }
      rec.view = view;
      fillInfo(view, id, base);
      const cancel = clipOf(view, 'button2');
      wireButton(cancel, () => closeSession(rec), 'cancel');
      centerClip(cancel, 160.275);
      const handle = {
        close: () => closeSession(rec),
        element: host,
        get view() { return rec.view; },
        propId: id,
      };
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
      return handle;
    } catch (e) {
      if (window.__errs) window.__errs.push('prop info: ' + (e && e.message));
      if (view) { try { view.destroy(); } catch (e2) {} }
      if (session === rec) destroy();
      return null;
    }
  }

  function sync(rec) {
    if (!rec || session !== rec || !rec.view) return;
    const base = propMap.getValue(rec.propId);
    if (!base) return;
    setText(rec.view, 'name', base.name);
    writeRemark(rec.view, base.remark);
  }

  /* 属性书分配 = 原版「属性书弹出」3730（MainMovie_frame40.as:866 showPropertyAddWin）：
   * `text1` 剩余点数；`button1..3` = 力/敏/速三行（`text1` 当前值 / `text2` 已分配 / `left`·`right` 3156 箭头）；
   * `b_ok` 确定 / `b_back` 返回。只填数字与接线，版面全用素材。 */
  const ALLOCATE_SYMBOL = '3730';
  const ALLOCATE_ATTRS = ['power', 'agility', 'speed'];
  const ALLOCATE_POINTS = 8;

  // 本模块不依赖全局 `toast`（经典页把它包在 `UI.toast` 里）。
  function tipAllocate(msg) {
    try {
      if (window.UI && typeof UI.toast === 'function') { UI.toast(msg); return; }
      if (typeof window.toast === 'function') window.toast(msg);
    } catch (e) {}
  }

  // 剩余点数的文本框在自己的框里居中，但那个框和右侧棕色药丸（`f5` = 3708）不是同一中心：
  // 实测数字偏右 ~0.9、偏下 ~1.5 个舞台单位。按画稿屏幕矩形把文本中心对到药丸中心；
  // 位移只算一次（字号固定，数字宽窄不改变文本中心的定义），之后每次重填复用，避免累计漂移。
  function centerAllocateNumber(rec) {
    const view = rec && rec.view;
    if (!view) return;
    const pill = clipOf(view, 'f5');
    const num = clipOf(view, 'text1');
    const node = num && (num.g || num);
    if (!pill || !pill.g || !node || !node.__textBox) return;
    const box = node.__textBox;
    if (!box.__allocateBase) {
      const pr = pill.g.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      if (!(pr.width > 0) || !(nr.width > 0)) return;
      const ctm = node.getScreenCTM ? node.getScreenCTM() : null;
      const scale = ctm ? Math.hypot(ctm.c, ctm.d) : 1;
      if (!(scale > 0)) return;
      const dx = ((pr.left + pr.width / 2) - (nr.left + nr.width / 2)) / scale;
      const dy = ((pr.top + pr.height / 2) - (nr.top + nr.height / 2)) / scale;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      box.__allocateBase = { x: Number(box.x) || 0, base: Number(box.base) || 0 };
      box.__allocateShift = { dx: dx, dy: dy };
    }
    box.x = box.__allocateBase.x + box.__allocateShift.dx;
    box.base = box.__allocateBase.base + box.__allocateShift.dy;
    SfRender.setText(node, String(rec.remain));
  }

  function paintAllocate(rec) {
    if (!rec || !rec.view) return;
    setText(rec.view, 'text1', String(rec.remain));
    centerAllocateNumber(rec);
    ALLOCATE_ATTRS.forEach((key, i) => {
      const row = clipOf(rec.view, 'button' + (i + 1));
      if (!row) return;
      setText(row, 'text1', String(rec.stats[key]));
      setText(row, 'text2', String(rec.alloc[key]));
    });
  }

  // 三条提示照抄原版 addPropertyCount / reducePropertyCount / 确定键的判断文案。
  function bumpAllocate(rec, key, delta) {
    if (delta < 0 && rec.alloc[key] <= 0) { tipAllocate('该属性已无分配点数。'); return; }
    if (delta > 0 && rec.remain <= 0) { tipAllocate('属性点已用完，不能再分配了。'); return; }
    rec.alloc[key] += delta;
    rec.remain -= delta;
    paintAllocate(rec);
  }

  // 箭头 3156：f1 深绿常态 / f3 浅绿悬停（与道具页翻页箭头同一套帧）。
  function wireAllocateArrow(clip, onFire) {
    if (!clip || !clip.g) return;
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    stopAt(clip, 1);
    clip.g.addEventListener('pointerenter', () => stopAt(clip, 3));
    clip.g.addEventListener('pointerleave', () => stopAt(clip, 1));
    clip.g.addEventListener('click', (e) => {
      if (e) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); }
      onFire();
    });
  }

  async function openAllocate(opts) {
    opts = opts || {};
    destroy();
    const host = createHost('sf-prop-allocate-view');
    if (!host) return null;
    const S = (window.State && State.state) ? State.state() : {};
    const statOf = (key) => {
      const v = opts.stats && opts.stats[key] != null ? opts.stats[key] : S[key];
      return Math.max(0, Math.floor(Number(v) || 0));
    };
    const rec = {
      host: host, view: null, observer: null, mode: 'allocate',
      remain: ALLOCATE_POINTS,
      alloc: { power: 0, agility: 0, speed: 0 },
      stats: { power: statOf('power'), agility: statOf('agility'), speed: statOf('speed') },
      busy: false,
      onConfirm: opts.onConfirm, onClose: opts.onClose, onStale: opts.onStale,
    };
    session = rec;
    if (window.MutationObserver) {
      try {
        rec.observer = new MutationObserver(() => { if (!host.isConnected && !rec.closed) closeSession(rec); });
        if (host.parentNode) rec.observer.observe(host.parentNode, { childList: true });
        rec.observer.observe(document.body, { childList: true });
      } catch (e) { rec.observer = null; }
    }
    let view = null;
    try {
      await SfRender.loadExtra('tags-daoju.json');
      if (session !== rec || !host.isConnected) {
        if (opts.onStale) { try { opts.onStale(); } catch (e) {} }
        if (session === rec) destroy();
        return null;
      }
      // 静态策略必须传：不传时子元件保持 playing=true，三行 3718 会在常态/高亮两帧间自播，
      // 每帧重建文本、把已分配数字冲回素材占位串。
      view = await SfRender.mountSymbol(host, ALLOCATE_SYMBOL, { frame: 1, label: '属性书', blank: ['text1'], policy: {} });
      if (session !== rec || !host.isConnected) {
        if (opts.onStale) { try { opts.onStale(); } catch (e) {} }
        try { view.destroy(); } catch (e) {}
        view = null;
        if (session === rec) destroy();
        return null;
      }
      rec.view = view;
      paintAllocate(rec);

      ALLOCATE_ATTRS.forEach((key, i) => {
        const row = clipOf(view, 'button' + (i + 1));
        if (!row) return;
        // ⚠ 不要给整行挂 gotoAndStop(2)：换行帧会重建子节点，箭头上的监听和命中框一起失效。
        wireAllocateArrow(clipOf(row, 'left'), () => bumpAllocate(rec, key, -1));
        wireAllocateArrow(clipOf(row, 'right'), () => bumpAllocate(rec, key, 1));
      });

      const submit = () => {
        if (rec.busy) return;
        if (rec.remain > 0) { tipAllocate('还有未分配的属性点，请继续分配。'); return; }
        rec.busy = true;
        Promise.resolve(rec.onConfirm ? rec.onConfirm(Object.assign({}, rec.alloc)) : true)
          .then((done) => {
            rec.busy = false;
            if (done === false) return;
            closeSession(rec);
          }, (e) => {
            rec.busy = false;
            if (window.__errs) window.__errs.push('attr book: ' + (e && e.message));
            tipAllocate('分配失败，请重试');
          });
      };
      const ok = clipOf(view, 'b_ok');
      const back = clipOf(view, 'b_back');
      wireButton(ok, submit, 'use');
      wireButton(back, () => closeSession(rec), 'cancel');
      // 原版 3730 是「确定在左、返回在右」。按背包其它弹窗的口径把主键放右，两颗键对调；
      // 传 'swap'（不是 'use'）保持各自画稿缩放，只按舞台居中重新排一次。
      // 对齐到三行内容的中心而不是舞台中心：面板内容比 160 略偏左，按钮居 160 会看着偏右。
      const rowCenter = stageCenterX(clipOf(view, 'button1'));
      layoutActionButtons(view, ok, back, 'swap', rowCenter);
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
      return {
        close: () => closeSession(rec),
        element: host,
        get view() { return rec.view; },
        allocation: () => Object.assign({}, rec.alloc),
      };
    } catch (e) {
      if (window.__errs) window.__errs.push('attr book open: ' + (e && e.message));
      if (view) { try { view.destroy(); } catch (e2) {} }
      if (session === rec) destroy();
      return null;
    }
  }


  async function open(propId, opts) {
    const id = Number(propId);
    const base = propMap.getValue(id);
    if (!base) return null;
    destroy();
    const host = createHost();
    if (!host) return null;
    const rec = {
      host: host, propId: id, view: null, observer: null,
      onUse: opts && opts.onUse, onClose: opts && opts.onClose, onCancel: opts && opts.onCancel,
    };
    session = rec;

    if (window.MutationObserver) {
      try {
        rec.observer = new MutationObserver(() => {
          if (!host.isConnected && !rec.closed) closeSession(rec);
        });

        if (host.parentNode) rec.observer.observe(host.parentNode, { childList: true });
        rec.observer.observe(document.body, { childList: true });
      } catch (e) { rec.observer = null; }
    }
    let view = null;
    try {
      await SfRender.loadExtra('tags-daoju.json');
      if (session !== rec || !host.isConnected) {
        if (opts && opts.onStale) { try { opts.onStale(); } catch (e) {} }
        if (session === rec) destroy();
        return null;
      }
      view = await SfRender.mountSymbol(host, '4886', { frame: 1, label: '道具使用', blank: ['name', 'vipDes'] });
      if (session !== rec || !host.isConnected) {
        if (opts && opts.onStale) { try { opts.onStale(); } catch (e) {} }
        try { view.destroy(); } catch (e) {}
        view = null;
        if (session === rec) destroy();
        return null;
      }
      rec.view = view;
      fill(view, id);
      const use = clipOf(view, 'button1');
      const cancel = clipOf(view, 'button2');

      wireButton(use, () => { if (rec.onUse) rec.onUse(handle); }, 'use');
      wireButton(cancel, () => { closeSession(rec); if (rec.onCancel) rec.onCancel(); }, 'cancel');
      // popWrap 会加一层反馈壳；先包壳再排版，尺寸从画稿 bbox 读，不受屏幕缩放影响。
      layoutActionButtons(view, use, cancel, 'use');
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    } catch (e) {
      if (window.__errs) window.__errs.push('prop use: ' + (e && e.message));
      if (view) { try { view.destroy(); } catch (e2) {} }
      if (session === rec) destroy();
      return null;
    }
    const handle = {
      close: () => closeSession(rec),
      sync: () => sync(rec),
      element: host,
      get view() { return rec.view; },
      propId: id,
    };
    return handle;
  }

  window.SfPropUse = Object.freeze({
    open: open,
    openBuy: openBuy,
    openInfo: openInfo,
    openAllocate: openAllocate,
    close: close,
    destroy: destroy,
    active: () => !!session,

    frame: 1,
    buyFrame: 1,
    buyButtonsFrame: 2,
    allocateSymbol: ALLOCATE_SYMBOL,
    symbol: '4886',
  });
})();
