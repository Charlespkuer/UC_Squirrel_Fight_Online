// ui-tower-path.js — 村庄右上角的「远方的无尽之塔」蜿蜒石板小径
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  let mounted = null;

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const key of Object.keys(attrs || {})) {
      if (attrs[key] == null) continue;
      node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }


  function sampleCurve(points, per) {
    const out = [];
    const ps = [points[0]].concat(points, [points[points.length - 1]]);
    for (let i = 0; i < ps.length - 3; i++) {
      const p0 = ps[i], p1 = ps[i + 1], p2 = ps[i + 2], p3 = ps[i + 3];
      for (let j = 0; j < per; j++) {
        const t = j / per, u = t * t, v = u * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * v),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * v),
        ]);
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  function at(center, t) {
    const n = center.length - 1;
    const i = Math.max(0, Math.min(n, Math.round(t * n)));
    const prev = center[Math.max(0, i - 1)], next = center[Math.min(n, i + 1)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    return { p: center[i], tx: dx / len, ty: dy / len, nx: -dy / len, ny: dx / len };
  }


  function ribbon(center, widthAt) {
    const left = [], right = [];
    for (let i = 0; i < center.length; i++) {
      const t = i / Math.max(1, center.length - 1), q = at(center, t);
      const w = widthAt(t);
      left.push([q.p[0] + q.nx * w / 2, q.p[1] + q.ny * w / 2]);
      right.push([q.p[0] - q.nx * w / 2, q.p[1] - q.ny * w / 2]);
    }
    return { left, right };
  }

  function ribbonPath(edges) {
    const L = edges.left, R = edges.right;
    return 'M' + L.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') +
      'L' + R.slice().reverse().map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z';
  }

  function fallbackModal(run) {
    const C = window.UI && UI.classic;
    if (!C || !C.modal) { if (window.UI && UI.toast) UI.toast('无尽塔尚未就绪。'); return; }
    C.modal('远方的无尽之塔', '<p>将前往远方的无尽之塔。</p><p class="small-label">此去只问能走多远；联机版不产出任何局外奖励。</p>', [
      { label: '确定', cls: 'gold', run },
      { label: '取消', cls: 'muted' },
    ], { small: true });
  }


  function endlessLock() {
    const T = window.Tower;
    if (!T || typeof T.endlessUnlocked !== 'function') return { ok: true };
    return T.endlessUnlocked();
  }
  // 等级不够时走临时飘字（与征战等限制同一观感），不要弹窗挡住村庄页。
  function showLocked(message) {
    if (window.UI && typeof UI.toast === 'function') { UI.toast(message); return; }
    if (window.UI && UI.classic && typeof UI.classic.toast === 'function') { UI.classic.toast(message); return; }
    if (window.console) console.warn(message);
  }

  function openConfirm(owner, run) {
    if (window.SfChallenge && typeof SfChallenge.openOriginalConfirm === 'function') {
      try {
        return Promise.resolve(SfChallenge.openOriginalConfirm({
          owner,
          label: '远方的无尽之塔',

          swapButtons: true,
          extraGap: 26,
          text: '蜿蜒的石板小径，道路尽头的远方若隐若现着无尽之塔。\n挑战与财富在塔中呼唤着你，要动身前往吗？',
          accept: run,
        })).catch(() => fallbackModal(run));
      } catch (e) {
        fallbackModal(run);
        return null;
      }
    }
    fallbackModal(run);
    return null;
  }


  function paint(root) {
    const need = (window.Tower && window.Tower.ENDLESS_UNLOCK_LEVEL) || 20;
    const label = '无尽塔入口（' + need + ' 级解锁）';
    const g = el('g', {
      class: 'sf-tower-path',
      role: 'button',
      tabindex: '0',
      'aria-label': label,
      'data-tower-path': '1',
    });



    g.appendChild(el('rect', {
      x: 232, y: 59, width: 68, height: 27,
      fill: '#000', 'fill-opacity': '0.001', 'pointer-events': 'all',
    }));


    const center = sampleCurve([
      [242.2, 82], [243.7, 79], [248, 75], [255, 74], [262, 79],
      [267, 82], [272, 79], [276, 72], [280, 69], [285, 72],
      [289, 73], [292, 69], [295, 64],
    ], 18);

    const widths = [[0, 15.85], [0.08, 14.2], [0.20, 6.7], [0.29, 4.0],
      [0.36, 4.6], [0.47, 3.0], [0.56, 3.7], [0.67, 2.1],
      [0.77, 2.4], [0.88, 1.25], [1, 0.8]];
    const widthAt = (t) => {
      for (let i = 1; i < widths.length; i++) {
        if (t <= widths[i][0]) {
          const a = widths[i - 1], b = widths[i], u = (t - a[0]) / (b[0] - a[0]);
          const smooth = u * u * (3 - 2 * u);
          return a[1] + (b[1] - a[1]) * smooth;
        }
      }
      return widths[widths.length - 1][1];
    };
    const base = ribbon(center, (t) => widthAt(t) + 1.1);

    g.appendChild(el('path', {
      d: ribbonPath(base), fill: '#344b30', 'fill-opacity': '0.42',
      transform: 'translate(0,0.8)', 'pointer-events': 'none',
    }));
    g.appendChild(el('path', {
      d: ribbonPath(base), fill: '#626c50', 'fill-opacity': '0.90',
      stroke: '#46563a', 'stroke-width': '0.55', 'stroke-opacity': '0.82',
      'stroke-linejoin': 'round', 'pointer-events': 'none',
    }));
    g.appendChild(el('path', {
      d: ribbonPath(ribbon(center, (t) => widthAt(t))),
      fill: '#a39879', 'fill-opacity': '0.92', 'pointer-events': 'none',
    }));

    for (const side of [-1, 1]) {
      for (let i = 0; i < 17; i++) {
        const u = (i + 0.45) / 17, t = 1 - Math.pow(1 - u, 1.5);
        const q = at(center, t), scale = Math.min(1 - 0.8 * t, Math.max(0.16, widthAt(t) / 12));
        const w = widthAt(t) / 2 - 0.12 * scale;
        const x = q.p[0] + q.nx * w * side, y = q.p[1] + q.ny * w * side;
        const along = (1.25 + (i % 3) * 0.14) * scale, across = 0.48 * scale;
        const point = (a, b, dy) => [x + q.tx * a + q.nx * b, y + q.ty * a + q.ny * b + dy];
        const poly = (dy) => [[-along, -across * 0.6], [-along * 0.6, -across],
          [along * 0.65, -across], [along, across * 0.5], [along * 0.5, across],
          [-along * 0.7, across]].map(p => point(p[0], p[1], dy).map(v => v.toFixed(2)).join(',')).join(' ');
        g.appendChild(el('polygon', { points: poly(0.38 * scale), fill: '#4d5941',
          'fill-opacity': '0.9', 'pointer-events': 'none' }));
        g.appendChild(el('polygon', { class: 'tp-band', points: poly(0),
          fill: i % 3 === 0 ? '#a09b80' : '#8b8d73', stroke: '#59654d',
          'stroke-width': (0.22 * scale).toFixed(2), 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      }
    }

    const colors = ['#d8d0ae', '#c8c5a6', '#d5c4a0', '#bfc4a6', '#e1d5b4'];
    const rows = 28;
    for (let row = rows - 1; row >= 0; row--) {
      const u = (row + 0.5) / rows;
      const t = 1 - Math.pow(1 - u, 1.55), q = at(center, t);
      const scale = Math.min(1 - 0.84 * t, Math.max(0.13, widthAt(t) / 9));
      const count = widthAt(t) > 7 ? 3 : widthAt(t) > 2.6 ? 2 : 1;
      for (let col = 0; col < count; col++) {
        const offset = (col - (count - 1) / 2) * widthAt(t) * 0.28 + (((row * 7 + col * 5) % 7) - 3) * 0.16 * scale;
        const along = ((row * 7 + col * 3) % 5 - 2) * 0.28 * scale;
        const x = q.p[0] + q.nx * offset + q.tx * along;
        const y = q.p[1] + q.ny * offset + q.ty * along;
        const rx = (1.9 + ((row + col) % 3) * 0.15) * scale;
        const ry = (1.15 + ((row * 3 + col) % 3) * 0.09) * scale;
        const jitter = ((row + col) % 3 - 1) * 0.18 * scale;
        const skew = ((row * 5 + col * 3) % 5 - 2) * 0.09;
        const points = [
          [x - rx, y - ry * (0.25 + skew)], [x - rx * (0.68 - skew), y - ry * 0.88],
          [x + rx * (0.55 + skew), y - ry + jitter], [x + rx, y - ry * (0.28 - skew)],
          [x + rx * (0.82 - skew), y + ry * 0.55], [x - rx * (0.42 + skew), y + ry * 0.85],
        ];
        const polygon = (dy) => points.map((p) => p[0].toFixed(2) + ',' + (p[1] + dy).toFixed(2)).join(' ');
        g.appendChild(el('polygon', { points: polygon(0.58 * scale), fill: '#656a53',
          'fill-opacity': '0.9', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
        g.appendChild(el('polygon', { class: 'tp-band', points: polygon(0),
          fill: colors[(row * 3 + col) % colors.length], stroke: '#85856d',
          'stroke-width': (0.20 * scale).toFixed(2), 'stroke-opacity': '0.65', 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
        if (t < 0.65) g.appendChild(el('path', {
          d: 'M' + (x - rx * 0.55).toFixed(2) + ' ' + (y - ry * 0.7).toFixed(2) +
            'l' + (rx * 0.75).toFixed(2) + ' ' + (-ry * 0.08).toFixed(2),
          fill: 'none', stroke: '#f4e9cf', 'stroke-opacity': '0.65',
          'stroke-width': (0.24 * scale).toFixed(2), 'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
      }
    }
    for (const [t, side] of [[0.05, 1], [0.24, -1], [0.43, 1], [0.65, -1], [0.84, 1]]) {
      const q = at(center, t), w = widthAt(t) / 2 + 1.1, s = 1 - 0.55 * t;
      const x = q.p[0] + q.nx * w * side, y = q.p[1] + q.ny * w * side;
      g.appendChild(el('path', {
        d: 'M' + x.toFixed(2) + ' ' + y.toFixed(2) + 'q' + (0.3*s).toFixed(2) + ' ' + (-1.2*s).toFixed(2) + ' ' + (0.9*s).toFixed(2) + ' ' + (-1.7*s).toFixed(2),
        fill: 'none', stroke: '#607d4c', 'stroke-width': (0.45*s).toFixed(2),
        'stroke-linecap': 'round', 'pointer-events': 'none',
      }));
    }

    root.appendChild(g);
    return g;
  }

  function mount(view, owner) {
    if (!view || !view.g) return null;
    if (mounted && mounted.parentNode) mounted.parentNode.removeChild(mounted);
    const g = paint(view.g);
    mounted = g;
    // 路径拦截 pointermove 时，村庄路由不会收到离开建筑的移动事件。
    const clearVillageHover = () => {
      const router = view.g && view.g.__sfRouter;
      if (router && router.clear) router.clear();
    };
    g.addEventListener('pointerenter', clearVillageHover);
    g.addEventListener('pointermove', clearVillageHover);

    const run = () => {
      try {
        const lock = endlessLock();
        if (!lock.ok) { showLocked(lock.msg); return; }
        if (!window.TowerUI || typeof TowerUI.openEndless !== 'function') {
          if (window.UI && UI.toast) UI.toast('无尽塔尚未就绪。');
          return;
        }
        TowerUI.openEndless({ from: 'village' });
      } catch (e) {
        if (window.__errs) window.__errs.push('tower path: ' + (e && e.message));
        if (window.UI && UI.toast) UI.toast('无尽塔打开失败。');
      }
    };
    const fire = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();

      try { if (g.blur) g.blur(); } catch (e) {}
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      const proceed = () => {
        const lock = endlessLock();
        if (!lock.ok) { showLocked(lock.msg); return; }
        openConfirm(owner || (window.document && document.querySelector('#ui .ssfight-home')), run);
      };
      if (!window.Tower && window.TowerLoader) {
        let tip = null;
        try { if (window.UI && UI.toast) tip = UI.toast('正在加载无尽塔…'); } catch (e) {}
        window.TowerLoader.ensure().then(() => {
          if (tip && tip.remove) tip.remove();
          proceed();
        }).catch((e) => {
          if (tip && tip.remove) tip.remove();
          if (window.__errs) window.__errs.push('tower load: ' + (e && e.message));
          showLocked('无尽塔加载失败，请刷新后重试。');
        });
        return;
      }
      proceed();
    };
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click']) {
      g.addEventListener(type, (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); });
    }
    g.addEventListener('click', fire);
    g.addEventListener('keydown', (ev) => {
      if (!ev.repeat && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); fire(ev); }
    });
    if (window.SfUiFeedback && typeof SfUiFeedback.bind === 'function') {
      SfUiFeedback.bind(g, { shell: () => g });
    }
    return g;
  }

  function destroy() {
    if (mounted && mounted.parentNode) mounted.parentNode.removeChild(mounted);
    mounted = null;
  }

  window.SfTowerPath = Object.freeze({ mount, destroy });
})();
