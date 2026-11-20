// web-shell.js — 纯网页端的浏览器适配（只在 http(s) 页面生效；安装包会加载但直接返回）
(function () {
  'use strict';

  const native = !!window.__TAURI_INTERNALS__ || !!window.SSDZAndroid;
  if (native || !/^https?:$/.test(String(window.location && location.protocol || ''))) return;

  const hint = document.getElementById('rotate-hint');
  if (!hint) return;
  const KEY = 'ssdz-web-portrait-ok';
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const button = hint.querySelector('[data-rotate-continue]');

  function dismissed() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function sync() {
    const portrait = window.innerHeight > window.innerWidth && window.innerWidth <= 900;
    const show = coarse && portrait && !dismissed();
    hint.classList.toggle('show', show);
    hint.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  if (button) {
    button.addEventListener('click', function () {
      try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
      sync();
    });
  }
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', function () { setTimeout(sync, 120); });
  sync();
})();
