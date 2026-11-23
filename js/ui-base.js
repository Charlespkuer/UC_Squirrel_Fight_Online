// ui-base.js — 联机/单机共用的界面基础件
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const escHtml = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const iconUrlCache = Object.create(null);
  function frameDataUrl(sheetId, label, size) {
    const key = sheetId + '#' + label + '@' + size;
    if (iconUrlCache[key] !== undefined) return iconUrlCache[key];
    const sh = Engine.SHEETS[sheetId];
    let url = '';
    if (sh && sh.img && sh.img.naturalWidth) {
      const f = sh.frames[String(label)];
      if (f) {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const cx = c.getContext('2d');
        const s = Math.min(size / f.sw, size / f.sh);
        const w = f.sw * s, h = f.sh * s;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(sh.img, f.sx, f.sy, f.sw, f.sh, (size - w) / 2, (size - h) / 2, w, h);
        url = c.toDataURL('image/png');
      }
    }
    iconUrlCache[key] = url;
    return url;
  }

  function gridDataUrl(sheetId, index, size) {
    const key = sheetId + '#' + index + '@' + size;
    if (iconUrlCache[key] !== undefined) return iconUrlCache[key];
    const sh = Engine.SHEETS[sheetId];
    let url = '';
    const def = sh && sh.def;
    if (sh && sh.img && sh.img.naturalWidth && def && def.w) {
      const cols = Math.max(1, Math.floor(sh.img.width / def.w));
      const n = def.n || (cols * Math.floor(sh.img.height / def.h));
      const i = ((index % n) + n) % n;
      const sx = (i % cols) * def.w, sy = Math.floor(i / cols) * def.h;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(sh.img, sx, sy, def.w, def.h, 0, 0, size, size);
      url = c.toDataURL('image/png');
    }
    iconUrlCache[key] = url;
    return url;
  }
  function imgTag(url, cls, size) {
    if (!url) return '<span class="icon-ph"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') + '></span>';

    return '<img class="' + (cls || 'icon') + '" src="' + url + '"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') +
      ' onerror="this.style.visibility=\'hidden\'">';
  }
  function weaponIcon(id, size) { return imgTag('images/ui/icons/weapon/weapon-' + id + '.svg?v=4', 'icon', size || 56); }
  function skillIcon(id, size) { return imgTag('images/ui/icons/skill/skill-' + id + '.svg?v=4', 'icon', size || 56); }
  // 道具图标：经典界面会把原版无框矢量路径表挂在 `UI.classic.propIconSrc` 上；
  function propIcon(id, size) {
    const classic = window.UI && window.UI.classic;
    const url = classic && typeof classic.propIconSrc === 'function'
      ? classic.propIconSrc(id)
      : 'images/ui/icons/prop/prop-' + id + '.png';
    return imgTag(url, 'icon', size || 56);
  }
  function gearIcon(g, size) {
    return imgTag('images/ui/icons/gear/gear-' + g.id + '.png', 'icon', size || 56);
  }

  let equipSheetAsked = false;
  function ensureEquipSheet() {
    if (equipSheetAsked) return;
    equipSheetAsked = true;
    const ids = Object.keys(Engine.SRC_MAP).filter((k) => /^(Head|HandO|HandI|Body|Arm|Foot)_/.test(k));
    Engine.loadSheets(ids).then(() => {
      const list = document.querySelectorAll('#ui img[data-equip]');
      for (const img of list) {
        const name = img.getAttribute('data-equip');
        const size = parseInt(img.style.width) || 56;
        const url = frameDataUrl(name, '1', size) || frameDataUrl(name, '2', size);
        if (url) img.src = url;
      }
    });
  }

  function hitRegion(regions, x, y) {
    for (const r of regions) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    return null;
  }

  function toast(msg, ms) {
    const t = el('div', 'toast', msg);
    $('#ui').appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms || 2200);
    return t;
  }

  let danmakuLayer = null;
  // 单行弹幕：只给「需要说清前后变化」的提示用（如转化丸的 力量 → 敏捷）。
  function danmaku(msg, ms) {
    const ui = $('#ui');
    if (!ui) return null;
    if (!danmakuLayer || !danmakuLayer.isConnected) {
      danmakuLayer = el('div', 'danmaku-layer');
      ui.appendChild(danmakuLayer);
    }
    while (danmakuLayer.firstChild) danmakuLayer.removeChild(danmakuLayer.firstChild);
    const t = el('div', 'danmaku', escHtml(msg));
    danmakuLayer.appendChild(t);
    setTimeout(() => t.classList.add('show'), 20);
    setTimeout(() => t.remove(), ms || 4600);
    return t;
  }


  function installFavicon() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const cx = c.getContext('2d');
      const f = Engine.anim('standby');
      if (!f) return;
      const box = [64, 360, 400, 640];
      const bw = box[2] - box[0], bh = box[3] - box[1];
      const k = Math.min(56 / bw, 56 / bh);
      Engine.drawFrame(cx, f[3], {
        x: 32 - (bw * k) / 2 - box[0] * k, y: 32 - (bh * k) / 2 - box[1] * k,
        scale: k, sheets: ['SQ_01', 'SQ_02'],
      });
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = c.toDataURL('image/png');
      document.head.appendChild(link);
    } catch (e) {}
  }

  // 导出：window.UIBase（模块间取件） + window.UI（兼容 classic-ui 的 legacy）
  const UIBase = Object.freeze({
    $, el, escHtml,
    frameDataUrl, gridDataUrl, imgTag,
    weaponIcon, skillIcon, propIcon, gearIcon, ensureEquipSheet,
    hitRegion, toast, danmaku, installFavicon,
  });
  window.UIBase = UIBase;
  window.UI = Object.assign(window.UI || {}, UIBase);
})();
