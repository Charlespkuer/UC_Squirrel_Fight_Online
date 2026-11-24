// 无尽塔按需加载：村庄小径 / 关卡入口第一次打开时才拉脚本与样式。
(function () {
  'use strict';
  const CSS = 'css/tower.css';
  const SCRIPTS = [
    'js/tower-data.js',
    'js/tower-hero.js',
    'js/tower.js',
    'js/tower-plot.js',
    'js/tower-online.js',
    'js/tower-ui.js',
  ];
  let promise = null;

  function loadCss() {
    if (document.querySelector('link[data-tower-css]')) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS;
      link.setAttribute('data-tower-css', '1');
      link.onload = () => resolve();
      link.onerror = () => { link.remove(); reject(new Error('无尽塔样式加载失败：' + CSS)); };
      document.head.appendChild(link);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const old = document.querySelector('script[data-tower-src="' + src + '"]');
      if (old) {
        if (old.getAttribute('data-tower-loaded') === '1') resolve();
        else old.addEventListener('load', () => resolve(), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.setAttribute('data-tower-src', src);
      s.onload = () => { s.setAttribute('data-tower-loaded', '1'); resolve(); };
      s.onerror = () => { s.remove(); reject(new Error('无尽塔脚本加载失败：' + src)); };
      document.body.appendChild(s);
    });
  }

  function ensure() {
    if (window.TowerUI && window.Tower && window.TowerHero) return Promise.resolve(true);
    if (promise) return promise;
    promise = loadCss()
      .then(async () => { for (const src of SCRIPTS) await loadScript(src); return true; })
      .then(async (ok) => {
        // 无尽塔的勇者/幻兽动画同样读 AnimationStr；进塔前等帧表，避免首屏静止。
        if (window.Engine && Engine.loadAnim) { try { await Engine.loadAnim(); } catch (e) {} }
        return ok;
      })
      .catch((e) => { promise = null; throw e; });
    return promise;
  }

  window.TowerLoader = Object.freeze({
    ensure,
    loaded: () => !!(window.TowerUI && window.Tower),
  });
})();
