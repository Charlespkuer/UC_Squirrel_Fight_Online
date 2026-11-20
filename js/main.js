// main.js — 启动引导、主界面场景、战斗调度

(function () {
  'use strict';

  // 安卓 WebView 的 `html.is-android` 在入口页脚本里置位（描边回退必须早于首帧）。
  try {
    const noHover = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
    if (noHover) document.documentElement.classList.add('is-touch');
  } catch (e) {}


  const $ = (s) => document.querySelector(s);
  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');
  const W = 1170, H = 690;
  canvas.width = W; canvas.height = H;

  let mode = 'loading';
  let mainPlayer = Engine.makePlayer();
  let rafId = null;
  let bgm = null, fightBgm = null;
  let mainBg = null, mainBgSoft = false;

  let mainBgSsfight = null;
  const HOME_BG_BLUR = 1.1;

  // 主界面背景：等比铺满 1170×690，可加轻微虚化与淡化作纱。
  // 现在按「尺寸 + 底图 + 虚化强度」缓存到离屏 canvas，主循环只 `drawImage` 一次。
  let homeBgCache = null, homeBgCacheKey = '';
  function paintHomeBg(c, bg, blur) {
    const scale = Math.max(W / bg.width, H / bg.height);
    const dw = bg.width * scale, dh = bg.height * scale;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    c.save();
    if (blur) c.filter = 'blur(' + blur + 'px)';
    c.drawImage(bg, ox, oy, dw, dh);
    if (blur) c.filter = 'none';
    if (blur) {
      c.fillStyle = 'rgba(255,250,236,0.09)';
      c.fillRect(0, 0, W, H);
      const g = c.createLinearGradient(0, H * 0.62, 0, H);
      g.addColorStop(0, 'rgba(40,60,35,0)');
      g.addColorStop(1, 'rgba(30,48,28,0.11)');
      c.fillStyle = g;
      c.fillRect(0, H * 0.62, W, H * 0.38);
    }
    c.restore();
  }
  function drawHomeBg(ctx, blur) {
    const bg = homeBgImage();
    if (!bg) { ctx.fillStyle = '#3d6b35'; ctx.fillRect(0, 0, W, H); return; }
    if (typeof document !== 'undefined' && document.createElement) {
      if (!homeBgCache) homeBgCache = document.createElement('canvas');
      const key = W + 'x' + H + '|' + blur + '|' + (bg.src || '') + '|' + (bg.naturalWidth || 0);
      if (homeBgCacheKey !== key) {
        homeBgCache.width = W; homeBgCache.height = H;
        paintHomeBg(homeBgCache.getContext('2d'), bg, blur);
        homeBgCacheKey = key;
      }
      ctx.drawImage(homeBgCache, 0, 0);
      return;
    }
    paintHomeBg(ctx, bg, blur);
  }
  // 现在是不是「经典」界面模式（读存档；存档还没载入时按当前偏好，默认经典）。
  function uiModeIsClassic() {
    try {
      if (!window.State || !State.settings) return true;
      if (!State.state()) {
        return window.UI && UI.currentUiMode ? UI.currentUiMode() === 'classic' : true;
      }
      return State.settings().uiMode === 'classic';
    } catch (e) { return true; }
  }

  function ssfightHomeActive() {
    if (!uiModeIsClassic() || !window.SfUiMain) return false;
    const el = document.querySelector('.ssfight-home');
    // 只有壳不算数：挂载失败 / 还没挂完时壳里没有 SVG（壳本身是不透明深绿底）。这时必须让
    // canvas 主页继续画，否则整屏只剩一块深绿 —— 2026-11 红米 K90 Pro Max / HyperOS 3.0.23
    return !!(el && el.querySelector('svg'));
  }

  function homeBgImage() {
    if (uiModeIsClassic() && mainBgSsfight) return mainBgSsfight;
    return mainBg;
  }

  function homeBgBlur() {
    if (uiModeIsClassic()) return 0;
    return mainBgSoft ? HOME_BG_BLUR : 0;
  }
  let homeT = 0;
  let muted = localStorage.getItem('ssdz_music_muted') === '1';
  let activeBattle = null;

  // 上一次真正落地的缩放参数：新平台（Android 16 / 折叠屏 / 分屏）会连续补发多拍
  let fitSignature = '';
  function fitCanvas(force) {
    const layoutHeight = (window.UI && UI.layoutHeight) ? UI.layoutHeight(W, H)
      : ($('#ui .classic-page') ? W * 560 / 920 : H);
// 而 window.innerWidth/Height 含。Windows 的滚动条占位会让 innerWidth 在
// 「弹窗出现/消失」时变化，导致整屏缩放跳一下；macOS 的覆盖式滚动条不占位，
// 所以在 mac 上看不出来 —— 这里统一按不含滚动条的尺寸算，两个平台就一致了。
    const de = document.documentElement || {};
    const vw = Math.max(1, de.clientWidth || window.innerWidth || W);
    const vh = Math.max(1, de.clientHeight || window.innerHeight || layoutHeight);
    const st = settingsSnapshot();

    const tightHome = !!(window.SfUiMain && document.querySelector('.ssfight-home:not([data-sf-battle-hold])'));
    const uiHeight = tightHome ? layoutHeight : H;
    let sx, sy;
    if (st.fullscreen) {
      sx = vw / W; sy = vh / layoutHeight;
    } else {
      const fit = Math.min(vw / W, vh / layoutHeight);
      const target = (window.State && State.resolutionHeight) ? State.resolutionHeight(st.resolution) : 0;
      sx = sy = target ? Math.min(fit, target / layoutHeight) : fit;
    }
    const signature = [vw, vh, layoutHeight, uiHeight, sx.toFixed(6), sy.toFixed(6),
      st.fullscreen === true, st.resolution || 'auto'].join('|');
    if (!force && signature === fitSignature) return;
    fitSignature = signature;
    canvas.style.width = W * sx + 'px';
    canvas.style.height = H * sy + 'px';
    const ui = $('#ui');
    ui.style.width = W + 'px';
    ui.style.height = uiHeight + 'px';
    ui.style.transform = 'scale(' + sx + ',' + sy + ')';
    ui.style.setProperty('--uiscale', Math.min(sx, sy));
    ui.style.fontSize = (16 * Math.min(sx, sy)) + 'px';
    if (window.UI && UI.renderNumbers) UI.renderNumbers();
    if (mode === 'title') { try { drawHomeBg(ctx, homeBgBlur()); } catch (e) {} }
  }
  window.addEventListener('resize', () => fitCanvas());

  // 存档里的本机偏好（音量/静音/分辨率/全面屏）；存档还没载入时用 localStorage 兜底。
  function settingsSnapshot() {
    try {
      if (window.State && State.settings && State.state && State.state()) return State.settings();
    } catch (e) {}
    return {
      volume: clampVolume(localStorage.getItem('ssdz_music_volume')),
      muted: localStorage.getItem('ssdz_music_muted') === '1',
      resolution: 'auto',
      fullscreen: false,
      hideStatusBar: true,
      backgroundRun: false,
    };
  }
  // 把偏好写回存档：换浏览器/换机器（含双机同步）后设置还在。
  function persistSettings(patch) {
    if (patch && patch.volume != null) localStorage.setItem('ssdz_music_volume', String(patch.volume));
    if (patch && patch.muted != null) localStorage.setItem('ssdz_music_muted', patch.muted ? '1' : '0');
    try {
      if (window.State && State.setSettings && State.state && State.state()) { State.setSettings(patch); return true; }
    } catch (e) {}
    return false;
  }
  // 安卓沉浸模式：只调原生壳；桌面/浏览器没有 SSDZAndroid 桥就当无操作。
  function applySystemBars() {
    let hide = true;
    try { hide = settingsSnapshot().hideStatusBar !== false; } catch (e) {}
    try {
      const bridge = window.SSDZAndroid;
      if (bridge && typeof bridge.setSystemBarsHidden === 'function') {
        bridge.setSystemBarsHidden(hide ? '1' : '0');
      }
    } catch (e) {}
    return hide;
  }

  function setHideStatusBar(on) {
    persistSettings({ hideStatusBar: on !== false });
    applySystemBars();
    setTimeout(fitCanvas, 0);
    return on !== false;
  }
  function backgroundRunOn() { return settingsSnapshot().backgroundRun === true; }
  function applyBackgroundRun() {
    const on = backgroundRunOn();
    try { if (window.SSDZAndroid && SSDZAndroid.setBackgroundRun) SSDZAndroid.setBackgroundRun(on ? '1' : '0'); } catch (e) {}
    return on;
  }
  function setBackgroundRun(on) { persistSettings({ backgroundRun: on === true }); applyBackgroundRun(); return on === true; }
  // 存档载入后把偏好接过来：存档优先，并回写 localStorage 供下次启动（标题画面）用。
  let appliedSettingsSig = '';
  function applyStoredSettings(force) {
    try {
      if (!window.State || !State.settings || !State.state || !State.state()) return;
      const st = State.settings();
      applySystemBars();
      applyBackgroundRun();
      const sig = [st.volume, st.muted === true, st.uiMode, st.resolution, st.fullscreen === true, st.hideStatusBar !== false, st.backgroundRun === true].join('|');
      if (!force && sig === appliedSettingsSig) return;
      appliedSettingsSig = sig;
      volume = clampVolume(st.volume);
      muted = st.muted === true || volume <= 0;
      localStorage.setItem('ssdz_music_volume', String(volume));
      localStorage.setItem('ssdz_music_muted', muted ? '1' : '0');
      applyVolume();
      // 界面模式：存档载入后以存档为准再落一次 <html data-ui-mode>
      if (window.UI && UI.applyUiMode) UI.applyUiMode(st.uiMode);
      try { if (window.Debug && Debug.refresh) Debug.refresh(); } catch (e) {}
      fitCanvas();
    } catch (e) {}
  }

  function setFullscreen(on) {
    persistSettings({ fullscreen: !!on });
    try {
      const el = document.documentElement;
      if (on) {
        if (!document.fullscreenElement && el.requestFullscreen) {
          const r = el.requestFullscreen();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        }
      } else if (document.fullscreenElement && document.exitFullscreen) {
        const r = document.exitFullscreen();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
    } catch (e) {}
    fitCanvas();
    return !!on;
  }

  function setResolution(key) {
    persistSettings({ resolution: String(key) });
    fitCanvas();
    return String(key);
  }
// 进出系统全屏（含按 Esc）后重新算一次缩放；精简 DOM 环境（自检脚本）里没有这个 API
  if (document.addEventListener) document.addEventListener('fullscreenchange', () => fitCanvas());


  const BASE_VOLUME = 0.35;
  function clampVolume(v) {
    const n = Number(v);
    return Number.isFinite(n) && v !== null && v !== '' ? Math.max(0, Math.min(1, n)) : 1;
  }
  let volume = clampVolume(localStorage.getItem('ssdz_music_volume'));
  // 主 BGM 在战斗里不暂停，只压成静音（桌面写 volume=0；iOS 忽略 volume，
  // 同时写 muted=true）：这样打完回随机挑战页时不用等 iOS/WebKit 重新起播
  // 静音即可无缝接上。`applyVolume()` 是唯一写音量的地方，静音/后台/战斗三条路径
  let bgmDucked = false;
  // 浏览器不允许无手势自动播放；首次手势前不创建 <audio>，避免启动就拉 470KB 的 BGM。
  let audioUnlocked = false;

  function volumeValue() { return volume; }
  function setVolume(value) {
    volume = clampVolume(value);
    if (volume <= 0) muted = true;
    else if (muted) muted = false;
    persistSettings({ volume: volume, muted: muted });
    applyVolume();

    playBgm(mode === 'battle' ? 'fight' : 'main');
    return volume;
  }
  function applyVolume() {
    const base = BASE_VOLUME * volume;
    if (bgm) {
      // iOS Safari 会忽略 `HTMLMediaElement.volume`（读取永远是 1），真正能静音的是
      // `muted`。所以战斗里压低主 BGM 不能只写 volume：两个都写 —— 桌面按音量平滑，
      // iOS 按 muted 仍能保持播放头继续走，返回时一开就接上，不用重新 play()。
      bgm.muted = bgmDucked;
      bgm.volume = bgmDucked ? 0 : base;
    }
    if (fightBgm) {
      fightBgm.muted = false;
      fightBgm.volume = base;
    }
  }

  function playBgm(which) {

    if (bgSuspended) return;
    if (!audioUnlocked) armFirstGesture();
    if (muted || volume <= 0) {
      bgmDucked = false;
      if (bgm) bgm.pause();
      if (fightBgm) fightBgm.pause();
      return;
    }
    if (!audioUnlocked) return;
    try {
      let audio;
      if (which === 'main') {
        if (!bgm) { bgm = new Audio('audio/main_bg.mp3'); bgm.loop = true; }
        bgmDucked = false;
        applyVolume();
        if (fightBgm) fightBgm.pause();
        audio = bgm;
      } else {
        if (!fightBgm) { fightBgm = new Audio('audio/fight_bg.mp3'); fightBgm.loop = true; }
        bgmDucked = true;
        applyVolume();

        audio = fightBgm;
      }
      // 已经在播就不要重复 play()：iOS 上重复 play 会多一次起播/解码，
      if (!audio.paused) return;
      const started = audio.play();
      if (started && typeof started.catch === 'function') {
        started.then(() => setAudioBlocked(false)).catch(armAudioUnlock);
      }
    } catch (e) {}
  }

  let audioBlocked = false;
  // 切后台冻结：音乐 + 游戏进度
  // 安卓 WebView 的 <audio> 不会跟着应用生命周期走：实测（API 35 模拟器，
  // · 页面自己收到 visibilitychange（实测安卓 WebView 会发，且只发一次）；
  let bgSuspended = false;
  let inBackground = false;
  // iOS / iPadOS WKWebView（iPadOS 13+ 的 UA 可能伪装成 Macintosh）。
  function iosWebKit() {
    try {
      const ua = String(navigator.userAgent || '');
      return /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    } catch (e) { return false; }
  }
  // 安卓系统大版本（UA 里的 `Android 16` → 16）；识别不出按 0 处理。
  function androidMajorVersion() {
    try {
      const m = /Android\s+(\d+)/i.exec(String(navigator.userAgent || ''));
      return m ? Number(m[1]) || 0 : 0;
    } catch (e) { return 0; }
  }

  let relayoutFrame = 0;
  function fireWindowResize() {
    try {
      window.dispatchEvent(new Event('resize'));
    } catch (e) {
      try {
        const ev = document.createEvent('Event');
        ev.initEvent('resize', false, false);
        window.dispatchEvent(ev);
      } catch (e2) {}
    }
  }
  function relayoutNow() {

    if (relayoutFrame) return;
    try {
      relayoutFrame = requestAnimationFrame(() => {
        relayoutFrame = 0;
        try { fitCanvas(); } catch (e) {}
        fireWindowResize();
      });
    } catch (e) {
      try { fitCanvas(); } catch (e2) {}
      fireWindowResize();
    }
  }
  // iOS 切后台回来：WKWebView 会释放 canvas 的绘制缓冲，也可能丢掉 SVG 内嵌位图 /
  // Android 16 的 WebView 也会丢同一类栅格层（Chromium 在 Adreno / Vulkan 合成路径上
  // 只在 iOS / Android 16+ 上按当前屏幕补一次，不改变游戏状态。
  let foregroundRepaintSeq = 0;
  function scheduleForegroundRepaint() {
    const ios = iosWebKit();
    const android16 = androidMajorVersion() >= 16;
    if (!ios && !android16) return;
    const seq = ++foregroundRepaintSeq;
    const paint = () => {
      if (seq !== foregroundRepaintSeq) return;
      try { fitCanvas(); } catch (e) {}
      if (mode === 'title') {
        try { drawHomeBg(ctx, homeBgBlur()); } catch (e) {}
      } else if (mode === 'home' && !ssfightHomeActive()) {
        try { drawHomeBg(ctx, homeBgBlur()); } catch (e) {}

        if (!rafId) { try { startHomeScene(); } catch (e) {} }
      }
      try { if (window.SfRender && SfRender.repaintRaster) SfRender.repaintRaster(); } catch (e) {}
      try { repaintCssBackgrounds(); } catch (e) {}
      if (android16) {

        try { if (window.Engine && Engine.retryFailedImages) Engine.retryFailedImages(); } catch (e) {}
        relayoutNow();
      }
    };

    requestAnimationFrame(() => { paint(); setTimeout(paint, 180); });
  }

  function repaintCssBackgrounds() {
    const list = document.querySelectorAll('#ui .classic-page, #ui .ssfight-home, #ui .classic-board, #ui .tower-page');
    for (const el of list) {
      let bg = 'none', color = '';
      try {
        const cs = getComputedStyle(el);
        bg = cs.backgroundImage || 'none';
        color = cs.backgroundColor || '';
      } catch (e) {}
      if (bg && bg !== 'none') {
        const previous = el.style.backgroundImage;
        el.style.backgroundImage = 'none';
        void el.offsetHeight;
        el.style.backgroundImage = previous;
      } else if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {

        const previous = el.style.backgroundColor;
        el.style.backgroundColor = 'transparent';
        void el.offsetHeight;
        el.style.backgroundColor = previous;
      }
    }
  }
  function enterBackground() {
    if (inBackground) return;
    inBackground = true;
    if (backgroundRunOn()) return;
    bgSuspended = true;
    try { if (bgm) bgm.pause(); } catch (e) {}
    try { if (fightBgm) fightBgm.pause(); } catch (e) {}
  }
  function enterForeground() {

    try { if (document.readyState !== 'loading') relayoutNow(); } catch (e) {}
    if (!inBackground) return;
    inBackground = false;
    applySystemBars();
    applyBackgroundRun();
    if (!bgSuspended) return;
    bgSuspended = false;
    playBgm(mode === 'battle' ? 'fight' : 'main');
  }
  try {
    window.__ssdzEnterBackground = enterBackground;
    window.__ssdzEnterForeground = enterForeground;

    window.__ssdzRelayout = relayoutNow;
    window.__ssdzIsBackgrounded = () => inBackground;
    window.addEventListener('ssdz-native-pause', enterBackground);
    window.addEventListener('ssdz-native-resume', () => { enterForeground(); scheduleForegroundRepaint(); });
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') enterBackground();
        else { enterForeground(); scheduleForegroundRepaint(); }
      });
    }
    // iOS 从后台回前台有时只补发 pageshow、不发 visibilitychange（PWA 尤其常见）。
    window.addEventListener('pageshow', () => scheduleForegroundRepaint());
  } catch (e) {}
  function setAudioBlocked(on) {
    if (audioBlocked === !!on) return;
    audioBlocked = !!on;
    document.body.classList.toggle('audio-blocked', audioBlocked);
    let hint = document.getElementById('audio-hint');
    if (audioBlocked && !hint) {
      hint = document.createElement('div');
      hint.id = 'audio-hint';
      hint.className = 'audio-hint';
      hint.setAttribute('role', 'status');
      hint.innerHTML = '<span aria-hidden="true">♪</span>点击画面任意处开启音乐';
      document.body.appendChild(hint);
    }
  }

  let audioUnlockArmed = false;
  let firstGestureArmed = false;
  function armFirstGesture() {
    if (audioUnlocked || firstGestureArmed) return;
    firstGestureArmed = true;
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const unlock = () => {
      firstGestureArmed = false;
      audioUnlocked = true;
      for (const name of events) window.removeEventListener(name, unlock, true);
      if (audioUnlockArmed) return;
      playBgm(mode === 'battle' ? 'fight' : 'main');
    };
    for (const name of events) window.addEventListener(name, unlock, true);
  }
  function armAudioUnlock() {
    setAudioBlocked(true);
    if (audioUnlockArmed) return;
    audioUnlockArmed = true;
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const retry = () => {
      audioUnlockArmed = false;
      audioUnlocked = true;
      for (const name of events) window.removeEventListener(name, retry, true);
      playBgm(mode === 'battle' ? 'fight' : 'main');
    };
    for (const name of events) window.addEventListener(name, retry, true);
  }


  function drawLoading(pct, note) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#22303a';
    ctx.fillRect(0, 0, W, H);
    // 加载屏只用经典素材：原版 3182 载入图（松鼠小屋）到位后铺满。
    // ⚠ 不要再画 `loadingp`：那是一张 sprite 图集（绿圆盘 + 旋转环 + 两只现代松鼠头像），
    if (mainBgSsfight && mainBgSsfight.complete && mainBgSsfight.naturalWidth) {
      const iw = mainBgSsfight.naturalWidth, ih = mainBgSsfight.naturalHeight;
      const k = Math.max(W / iw, H / ih);
      const w = iw * k, h = ih * k;
      ctx.drawImage(mainBgSsfight, (W - w) / 2, (H - h) / 2, w, h);
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.fillRect(0, 0, W, H);
    }
    const bx = W / 2 - 250, by = H - 110, bw = 500, bh = 34;
    const bar = Engine.SHEETS['tanchutiao'];
    if (bar && bar.frames['0']) {
      const f = bar.frames['0'];
      ctx.drawImage(bar.img, f.sx, f.sy, f.sw, f.sh, bx, by, bw, bh);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(bx, by, bw, bh);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(bx + 4, by + 4, (bw - 8) * pct, bh - 8); ctx.clip();
    ctx.fillStyle = '#f5a623'; ctx.fillRect(bx + 4, by + 4, bw - 8, bh - 8);
    ctx.restore();
    Engine.text(ctx, note || '正在加载素材…', W / 2, by - 22, { size: 24, align: 'center', color: '#ffe066' });
    Engine.text(ctx, Math.round(pct * 100) + '%', W / 2, by + bh + 34, { size: 22, align: 'center', color: '#fff' });
  }


  const BATTLE_SHEETS = Object.freeze(['effectCommonAttack', 'weaponEffect', 'throwEffect', 'win_effect', 'die', 'runAround',
    'hurtRunBack', 'beatBack', 'think',
    'skill_6', 'skill_7', 'skill_8', 'skill_9', 'skill_13', 'skill_14', 'skill_15', 'skill_16_1', 'skill_16_2',
    'skill_17', 'skill_18', 'skill_23', 'skill_8_d', 'skill_9_d', 'skill_15_d', 'skill_18_d_1', 'skill_18_d_2',
    'fightBack', 'fightMid', 'fightFront']);
  const BATTLE_PIN = Object.freeze(['effectCommonAttack', 'weaponEffect', 'throwEffect', 'win_effect', 'die', 'runAround',
    'hurtRunBack', 'beatBack', 'think',
    'skill_6', 'skill_7', 'skill_8', 'skill_8_d', 'skill_9', 'skill_9_d', 'skill_13', 'skill_14', 'skill_15', 'skill_15_d',
    'skill_16_1', 'skill_16_2', 'skill_17', 'skill_18', 'skill_18_d_1', 'skill_18_d_2', 'skill_23',
    'tl', 'tl_effect', 'xh1', 'xh2', 'xh_effect1', 'xh_effect2', 'xm1', 'xm2', 'xm_effect',
    'woodman1', 'woodman2', 'woodman_effect']);
  let battleAssetsPromise = null;
  // 角色/特效图集必须优先于场景图集，否则同名标签会被场景图元抢走。
  function pinBattleAssets() {
    try { Engine.pinSheets(BATTLE_PIN); } catch (e) { return false; }
    return true;
  }

  function preloadBattleAssets() {
    if (battleAssetsPromise) return battleAssetsPromise;
    battleAssetsPromise = Engine.loadSheets(BATTLE_SHEETS)
      .then(() => { pinBattleAssets(); return true; })
      .catch(() => false);
    return battleAssetsPromise;
  }

  function scheduleBattleAssets() {
    if (battleAssetsPromise || uiModeIsClassic()) return;
    const start = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      preloadBattleAssets();
    };
    setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 2000 });
      else start();
    }, 600);
  }

  // 经典战斗核心包 636KB gzip：主页停稳、空闲时再拉，第一场战斗不用现等。
  // 2G / 省流量模式不预取；玩家提前开战也没关系，`loadExtra` 会复用同一个 Promise。
  let classicCoreScheduled = false;
  function scheduleClassicFightCore() {
    if (classicCoreScheduled || !uiModeIsClassic()) return;
    classicCoreScheduled = true;
    const conn = (window.navigator && navigator.connection) || {};
    if (conn.saveData || /(^|-)2g/.test(String(conn.effectiveType || ''))) return;
    const start = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try { if (window.SfFight && SfFight.preloadCore) SfFight.preloadCore(); } catch (e) {}
    };
    setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 5000 });
      else start();
    }, 6000);
  }

  async function boot() {
    const setStatus = (m) => {
      try { document.title = m; } catch (e) {}
      const el = document.getElementById('boot-note');
      if (el) el.textContent = m;
    };
    fitCanvas();
    // 标题页也要沉浸：`applyStoredSettings()` 要等存档载入之后才跑，旧机（Android 11 /
    applySystemBars();
    armFirstGesture();
    playBgm('main');
    drawLoading(0.05, '松鼠大战 · 怀旧复刻版');
    setStatus('加载背景…');

    const assetUrl = (p) => (window.SfRender && SfRender.assetUrl) ? SfRender.assetUrl(p) : p;
    const [mainImg, ssfImg] = await Promise.all([
      window.__SSDZ_ONLINE__
        ? Promise.resolve(null)
        : Engine.loadImage('images/ui/screens/main.jpg').then((img) => img || Engine.loadImage('images/ui/screens/village.svg')),
      Engine.loadImage(assetUrl('images/ssfight/ui/bitmap/3182_0.hd.webp'))
        .then((img) => img || Engine.loadImage(assetUrl('images/ssfight/ui/bitmap/3182_0.hd.jpg'))),
    ]);
    mainBg = mainImg || null;
    mainBgSoft = !!mainBg && /main\.jpg$/i.test(mainBg.src || '');
    mainBgSsfight = ssfImg || null;
    drawLoading(0.25, '正在加载角色素材…');
    setStatus('加载角色素材…');

    const coreSheets = ['SQ_01', 'SQ_02', 'weaponAttack', 'throwweaponAttack', 'main_e1', 'main_e2', 'main_e3',
      'wuqi', 'wuqi2', 'jineng', 'daoju', 'jinbeidaoju', 'tudi', 'go', 'starter_effect', 'loadingp',
      'fightNum_r', 'fightNum_g', 'fightNum_y', 'tilishuzi', 'energyNum', 'expNum', 'jingyanshuzi', 'num_28', 'num_36',
      'resource_1', 'resource_6', 'resource_13', 'resource_15', 'resource_16', 'resource_3', 'resource_4',
      'resource_5', 'resource_9', 'resource_10', 'resource_11', 'resource_12', 'resource_14', 'resource_2', 'resource_7', 'resource8',
      'new', 'shengbai', 'tanchutiao', 'loadingShadow', 'substarate', 'substarate0', 'draw', 'activity', 'plus', 'minus'];
    // 只有「首屏 + 首页」这批必须等。战斗图集（BATTLE_SHEETS）不在这里等 ——
    await Engine.loadSheets(window.__SSDZ_ONLINE__ ? ['tanchutiao'] : coreSheets);
    drawLoading(0.85, '正在加载界面素材…');
    setStatus('加载界面素材…');
// 角色/特效图集必须优先于场景图集，否则同名标签会被场景图元抢走
    Engine.pinSheets(['SQ_01', 'SQ_02', 'weaponAttack', 'throwweaponAttack']);
    drawLoading(0.95, '准备完成');
    setStatus(window.__SSDZ_ONLINE__ ? '松鼠大战 Online' : '松鼠大战 · 怀旧单机版');
    UI.installFavicon();
    await new Promise((r) => setTimeout(r, 150));
    if (window.__SSDZ_ONLINE__) {
// Installed clients have local assets, but their progress comes only from the API.
      bootDone = true;
      const note = document.getElementById('boot-note');
      if (note) note.style.display = 'none';
      try {
        const profile = await Online.resume();
        if (profile) await OnlineUI.enterGame();
        else await OnlineUI.showLogin('login');
      } catch (e) {
        await OnlineUI.showLogin('login');
        if (UI.toast) UI.toast(Online.errText(e));
      }
      return;
    }
// 存档：主存档永远是游戏目录下的 save/progress.json（本地服务器提供）。
// **磁盘存档优先**：只要服务器的存档接口能用，就一定读它；
// 只有读不到文件时才退回浏览器 localStorage，而且必须把原因明明白白摆出来
    let loaded = false;
    // 95% 守护：`fileLoad()` 走本地 HTTP/文件通道，若启动器/同步服务在返回页面时卡住，
    // 这里会永远停在「准备完成」那一条 95% 进度上。等 4 秒仍没结果就先按本地存档进游戏，
    let loadTimedOut = false;
    try {
      const result = await loadFileWithTimeout();
      if (result === '__timeout__') loadTimedOut = true;
      else loaded = !!result;
    } catch (e) { loaded = false; }
    if (loadTimedOut) {
      setStatus('存档读取超时，先用本地存档进入…');
      const local = !!(State.hasLocalSave && State.hasLocalSave() && State.load && State.load());
      if (local) showHome(); else showTitle();
      if (UI && UI.toast) UI.toast('磁盘存档读取超时，已先用本地存档进入；连上之后会自动重载。');
      // 超时不能等于放弃：安卓上 Tauri 的 save_* 命令是异步 IPC，桥接慢的时候
      showSaveWarning();
      retryFileSave();
      bootDone = true;
      return;
    }
    // 浏览器兜底档只在「磁盘上确实没有更高进度」时才允许顶上来。
    // 「初始存档与有进度的存档横跳」。现在磁盘档的等级更高时直接不回落。
    const bootInfo = State.fileInfo ? (State.fileInfo() || {}) : {};
    const bootLocal = State.localSaveMeta ? State.localSaveMeta() : null;
    const bootLevel = Number(bootInfo.fileLevel) || 0;
    const localSafe = !!bootLocal && (!bootInfo.fileExists
      || bootLocal.level > bootLevel
      || (bootLocal.level === bootLevel && bootLocal.savedAt > (Number(bootInfo.fileAt) || 0) + 1000));
    const fellBack = !loaded && localSafe && !!State.hasLocalSave();
    if (loaded || (fellBack && State.load())) showHome();
    else showTitle();
    if (loaded) {
      // 正式存档读进来了，但本机浏览器镜像比文件还新：说明上一次退出时那次文件写入
      // 没落盘（安卓切后台 → 异步 IPC 被系统回收打断，是这台设备上最常见的一种）。
      // 顺序很重要：先比时间，再看等级不低于文件里的那份，最后才 load() 覆盖内存状态。
      const local = State.localSaveMeta ? State.localSaveMeta() : null;
      const fileAt = (State.fileInfo() || {}).fileAt || 0;
      const fileLevel = ((State.state() || {}).level) || 1;
      // 只有「镜像里记的文件 mtime == 文件当前 mtime」才认：说明文件在那次写失败之后
      // base 对不上 → 文件是权威，镜像留给「系统 → 导入存档」处理，绝不自动覆盖。
      const mirrorNewer = !!local && local.base != null && Number(local.base) === Number(fileAt)
        && (local.pending || local.savedAt > fileAt + 1500);
      const recovered = mirrorNewer && local.level >= fileLevel && !!(State.load && State.load());
      if (recovered) {
        if (UI && UI.toast) UI.toast('已用本机最后一次自动存档恢复进度（上一次写文件没完成）');
        Promise.resolve(State.fileWriteNow && State.fileWriteNow()).catch(() => {});
      } else if (!!local && local.savedAt > fileAt + 1000 && local.level >= fileLevel) {

        if (UI && UI.toast) UI.toast('浏览器里还有一份更新的存档，已先保留；要换用它请到「系统 → 导入存档」');
      } else {
        try {
          localStorage.removeItem(State.saveKey);
          localStorage.removeItem(State.saveKey + '_sync');
          localStorage.removeItem(State.saveKey + '_base');
          localStorage.removeItem(State.saveKey + '_pending');
        } catch (e) {}
      }
    } else {
// 没读到磁盘存档：立刻把原因摆出来，同时后台重试（服务器晚一步起来也能自己恢复）
      showSaveWarning();
      retryFileSave();
    }
    if (window.UI && UI.renderNumbers) UI.renderNumbers();
    if (/[?&]test=1(?:&|$)/.test(location.search)) runSelfTest();
    if (/[?&]test=2(?:&|$)/.test(location.search)) runBattleLoop();
    bootDone = true;
  }

  // 存档告警与自动重连
  // 此时绝不能静默退回 localStorage 里残留的旧档——必须挂红横幅明示并自动重连。
  // 现在：① 磁盘存档永远是第一优先，读不到才回落，并且立刻在画面顶部
  let pageHiddenAt = 0;
  let saveBanner = null;

  // 顶部告警横幅：一直挂着，直到成功连上磁盘存档（或玩家自己关掉）。
  function showSaveWarning() {
    if (window.__SSDZ_ONLINE__) return;
    if (saveBanner) return saveBanner;
    const info = (State.fileInfo && State.fileInfo()) || {};
    const inFile = location.protocol === 'file:';
    // 原生外壳（桌面安装版 / iOS / Android）：首次运行还没有存档文件是正常的，
    // 路径是应用私有目录（iOS 上是 .../Application Support/com.ssdz.classic/save/progress.json），
    // 没必要把内部路径和「重试连线」挂给玩家看；第一笔存档写成功后文件自然会出现。
    if (info.transportReady && !inFile && window.__SSDZ_TAURI_APP__) return null;
    const noApi = Number(info.code) === 404 || /404/.test(String(info.reason || ''));
    let how, color;
    if (info.transportReady && !inFile) {
// 通道是好的，只是还没有存档文件（首次运行最常见）——不用红色报错吓人，
      color = '#1d5c3a';
      how = '还没有存档文件，第一次保存后就会自动写到这里：' + (info.path || 'save/progress.json') +
        '。现在可以直接开始玩。';
    } else if (inFile) {
      color = '#7a1010';
      how = '页面是 file:// 打开的，浏览器不允许读写存档文件。请关掉本窗口，用启动器重新打开游戏（Windows：双击根目录的 squirrel_fight.exe；macOS：双击 scripts/启动游戏.command）。';
    } else if (noApi) {
      color = '#8a4b00';
      how = '这个服务器没有 /__save 存档接口（多半是 python -m http.server 之类的静态服务器）。请先把它关掉，再用启动器打开（Windows：squirrel_fight.exe；macOS：scripts/启动游戏.command）。';
    } else {
      color = '#7a1010';
      how = '本地游戏服务没连上（多半是启动器还没把服务器拉起来，或者被别的程序占了端口）。请关掉本窗口，用启动器重新打开（Windows：squirrel_fight.exe；macOS：scripts/启动游戏.command）；也可以点上面的「重试连线」。';
    }
    const el = document.createElement('div');
    el.id = 'save-warning';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483000;background:' + color +
      ';color:#fff8ec;font:13px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:9px 14px;' +
      'display:flex;gap:10px;align-items:flex-start;box-shadow:0 2px 10px rgba(0,0,0,.35)';
    saveBanner = el;
    const text = document.createElement('div');
    text.style.cssText = 'flex:1 1 auto';
    const firstRun = !!info.transportReady && !inFile;
    text.innerHTML = (firstRun ? '<b>存档通道正常，还没有存档文件</b><br>' :
      '<b>⚠ 现在用的是浏览器兜底存档，' +
      'save/progress.json（磁盘上的正式存档）没有被读写。</b><br>') +
      '<span style="opacity:.92">' + (firstRun ? '' : '原因：' + esc(info.reason || info.error || '未知') + '<br>') +
      esc(how) + '</span>';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = '重试连线';
    retryBtn.style.cssText = 'flex:0 0 auto;padding:5px 12px;cursor:pointer';
    retryBtn.onclick = async () => {
      retryBtn.textContent = '正在重试…';
      if (await retryFileSave(true)) return;
      retryBtn.textContent = '重试连线';
      if (UI && UI.toast) UI.toast('还是连不上本地服务器，确认启动器（scripts/启动游戏.cmd 或 squirrel_fight.exe）的窗口没报错后再试');
    };
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '先这样玩';
    closeBtn.style.cssText = 'flex:0 0 auto;padding:5px 12px;cursor:pointer';
    closeBtn.onclick = () => { el.remove(); saveBanner = null; };
    el.appendChild(text); el.appendChild(retryBtn); el.appendChild(closeBtn);
    document.body.appendChild(el);
    return el;
  }
  function hideSaveWarning() { if (saveBanner) { saveBanner.remove(); saveBanner = null; } }
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }


  if (document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { pageHiddenAt = Date.now(); return; }
      const hiddenFor = pageHiddenAt ? Date.now() - pageHiddenAt : 0;
      pageHiddenAt = 0;
      if (hiddenFor > 10000) retryFileSave();
    });
  }

  let retryFileSaveTask = null;
  function retryFileSave(immediate) {
    if (retryFileSaveTask) return retryFileSaveTask;
    retryFileSaveTask = runRetryFileSave(immediate).finally(() => { retryFileSaveTask = null; });
    return retryFileSaveTask;
  }
  async function runRetryFileSave(immediate) {
    if (State.fileLoadedThisBoot()) { hideSaveWarning(); return true; }
// 首次运行没有存档文件：只要第一笔存档写成功，这条横幅就该消失
    if (((State.fileInfo() || {}).lastWrite || 0) > 0) { hideSaveWarning(); return true; }
    const delays = immediate ? [0, 300, 600, 1000, 1500, 2000, 2500, 3000] : [300, 600, 1000, 1500, 2000, 2500, 3000];
    for (let i = 0; i < delays.length; i++) {
      await new Promise((r) => setTimeout(r, delays[i]));
      if (State.fileLoadedThisBoot()) { hideSaveWarning(); return true; }
      if (((State.fileInfo() || {}).lastWrite || 0) > 0) { hideSaveWarning(); return true; }
      try {
        const available = await State.fileProbe();
        if (!available) continue;
        const ok = await loadFileWithTimeout();
        if (ok === true) { location.reload(); return true; }   // 连上了就以磁盘存档为准，重开一遍
      } catch (e) {  }
    }
    if (!State.fileLoadedThisBoot() && !((State.fileInfo() || {}).lastWrite || 0)) showSaveWarning();
    return false;
  }
  // 启动还没走完（还在拉素材/还没读档）时，桥接就绪只把存档读进内存，
  let bootDone = false;
  let fileLoadTask = null;
  function loadFileWithTimeout() {
    if (fileLoadTask) return fileLoadTask;
    const request = { cancelled: false };
    let timer;
    fileLoadTask = Promise.race([
      State.fileLoad(request),
      new Promise((resolve) => { timer = setTimeout(() => { request.cancelled = true; resolve('__timeout__'); }, 4000); }),
    ]).finally(() => { clearTimeout(timer); fileLoadTask = null; });
    return fileLoadTask;
  }
  async function preloadFileSave() {
    try {
      if (!(await State.fileProbe())) return false;
      return (await loadFileWithTimeout()) === true;
    } catch (e) { return false; }
  }
  // 部分国产 ROM 的 WebView 会把 Tauri 的全局对象晚十几秒才注入。桥一到就再试一次读写，
  // 不要因为启动时那 7 次重试已经跑完就永远停在“浏览器兜底存档”。
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('ssdz-save-transport-ready', function () {
      if (!bootDone) { void preloadFileSave(); return; }
      if (!State.fileLoadedThisBoot() && !((State.fileInfo() || {}).lastWrite || 0)) retryFileSave();
    });
  }


  async function runBattleLoop() {
    await new Promise((r) => setTimeout(r, 600));
    State.newGame('观察鼠');
    const S = State.state();
    S.weapons = ['1:5', '6:8', '15:11']; S.skills = ['1:3', '5:2', '8:1'];
    S.power = 20; S.agility = 15; S.speed = 15; S.maxHp = 300;
    showHome();
    const foes = [
      () => State.genAI(3),
      () => Object.assign(State.genAI(5), { npcType: 'tl' }),
      () => Object.assign(State.genAI(8), { npcType: 'xm' }),
      () => Object.assign(State.genAI(6), { npcType: 'xh' }),
    ];
    let i = 0;
    const again = () => {
      const foe = foes[i % foes.length]();
      const region = (i >> 2) % 5;
      i++;
      startBattle(foe, { region: region, onEnd: () => setTimeout(again, 1400) });
    };
    again();
  }


  async function runSelfTest() {
    const log = [];
    const ok = (name, cond, extra) => {
      log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''));
      document.title = (log.some((l) => l.startsWith('FAIL')) ? 'TEST FAIL' : 'TEST RUNNING') + ' (' + log.length + ')';
    };
    window.__testlog = log;
    try {
      await new Promise((r) => setTimeout(r, 400));
      State.newGame('测试鼠');
      ok('newGame', State.state().name === '测试鼠' && State.state().level === 1);
      ok('sheets-loaded', Object.keys(Engine.SHEETS).length >= 40, Object.keys(Engine.SHEETS).length + ' sheets');
      showHome();
      await new Promise((r) => setTimeout(r, 700));
      // 新号默认经典模式：首页是 `SfUiMain.mount()` 异步挂出来的原版 SVG 页，
      // 否则 ?test=1 在默认（经典）档下会假红（2026-10 审计实测）。
      for (let i = 0; i < 30 && !document.querySelector('#ui .ssfight-home svg'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const classicHome = document.querySelector('#ui .ssfight-home svg');
      const regs = window.__homeRegions || [];
      const modernHome = regs.length === 5 && document.querySelectorAll('.home-menu button').length === 5;
      ok('home-render', mode === 'home' && (!!classicHome || modernHome),
        classicHome ? 'classic svg' : 'regions=' + regs.length);
      ok('home-canvas', (() => {
        const c = document.getElementById('stage').getContext('2d');
        const d = c.getImageData(0, 0, W, H).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4 * 211) if (d[i] > 20 || d[i + 1] > 20) n++;
        return n > 200;
      })());
      State.state().weapons = ['1:1'];
      const up = State.upgradeInfo('weapon', 1, 1);
      ok('upgradeInfo', up && up.rate > 0, JSON.stringify(up));
      const foe = State.genAI(1);
      const simRes = Sim.simulate(
        { name: 'A', level: 1, power: 8, agility: 8, speed: 8, hp: 50, weapons: [{ id: 1, level: 1 }], skills: [] }, foe);
      ok('simulate', simRes && (simRes.winner === 0 || simRes.winner === 1) && simRes.rounds.length > 0,
        'rounds=' + (simRes && simRes.rounds.length));
      const frozenState = State.state();
      const savedLevel = frozenState.level, savedExp = frozenState.exp, savedFrozen = frozenState.levelFrozen;
      frozenState.level = 20; frozenState.exp = 0; frozenState.levelFrozen = 0; frozenState.props[13] = 2;
      const freeze = State.useProp(13);
      frozenState.exp = GData.nextExp(20);
      const preview = State.levelUpPreview();
      const ask = State.useProp(13);
      const unfreeze = ask && ask.needsUnfreezeConfirm ? State.useProp(13, 'confirm') : { ok: false };
      const freezeOk = freeze.ok === true && frozenState.levelFrozen === 1 && frozenState.level === 20 && frozenState.props[13] === 1;
      const unfreezeOk = ask && ask.needsUnfreezeConfirm === true && preview.level === 21
        && unfreeze.ok === true && frozenState.levelFrozen === 0 && frozenState.level === 21
        && Array.isArray(unfreeze.ups) && unfreeze.ups.length === 1;
      ok('rebirth-fruit-freezes-and-restores', freezeOk && unfreezeOk,
        'freeze=' + JSON.stringify(freeze) + ' preview=' + JSON.stringify(preview) + ' unfreeze=' + JSON.stringify(unfreeze));
      frozenState.level = savedLevel; frozenState.exp = savedExp; frozenState.levelFrozen = savedFrozen;
      const battleDone = new Promise((resolve) => {
        // `skipChest`：经典模式的原版战斗在战果后会开「四选一宝箱」并等玩家点，
        // 冒烟只看战斗能不能跑完，宝箱流程由 ui-fight 自己的用例覆盖。
        Main.startBattle(State.genAI(1), { region: 0, skipChest: true, onEnd: (w, r) => resolve({ w: w, rounds: r.rounds.length }) });
      });
      // 跳过键在经典模式里是 SVG 节点（而且要等 8.7 MB 的 tags-fight 包挂完才出现），
      // 所以不能只等 2.5 s 点一次；轮询到它出现为止。有 `click` 就点，没有（SVG）
      for (let i = 0; i < 60; i++) {
        const skipBtn = document.querySelector('[aria-label="跳过战斗"]');
        if (skipBtn) {
          if (typeof skipBtn.click === 'function') skipBtn.click();
          else skipBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const res = await Promise.race([battleDone, new Promise((r) => setTimeout(() => r(null), 45000))]);
      ok('battle', !!res, res ? ('winner=' + res.w + ' rounds=' + res.rounds)
        : 'timeout sheets=' + Object.keys(Engine.SHEETS).length + ' errs=' + (window.__errs || []).slice(0, 6).join(';'));
      await new Promise((r) => setTimeout(r, 900));
      ok('back-home', mode === 'home');
      State.state().level = Math.max(30, State.state().level);
      State.state().integral = 500;
      const keys = ['challenge', 'stages', 'arena', 'rank', 'weapons', 'skills', 'bag', 'gears', 'shop', 'lottery', 'help'];
// 查哪些选择器由展示层给（UI.smokeSelectors）；否则换一套界面实现就没法自检了。
      const smoke = (window.UI && UI.smokeSelectors) ? UI.smokeSelectors()
        : { panel: '#ui .panel, #ui .classic-page, #ui .classic-modal', close: '#ui .panel-close' };
      for (const k of keys) {
        try {
          UI.runAction(k);
          // 经典页面是异步挂载的（要拉 1~2 MB 的 tags 包），固定等 160 ms 会假红；
          let panel = null, ready = false;
          for (let i = 0; i < 50; i++) {
            panel = document.querySelector(smoke.panel);

            if (panel && (panel.textContent.length > 10 || !!panel.querySelector('svg'))) { ready = true; break; }
            await new Promise((r) => setTimeout(r, 100));
          }
          ok('panel:' + k, ready);
          const close = document.querySelector(smoke.close);
          if (close) close.click();
          document.querySelectorAll('.classic-modal-overlay').forEach(e => e.remove());
          await new Promise((r) => setTimeout(r, 40));
        } catch (e) { ok('panel:' + k, false, e.message); }
      }
    } catch (e) {
      ok('exception', false, e.message + ' ' + (e.stack || '').split('\n')[1]);
    }
    const fails = log.filter((l) => l.startsWith('FAIL'));
    showHome();
    document.title = fails.length ? ('TEST FAIL x' + fails.length) : 'TEST PASS (' + log.length + ')';
    const div = document.createElement('div');
    div.id = 'test-report';
    div.style.cssText = 'position:absolute;left:8px;top:170px;z-index:99;background:rgba(0,0,0,.78);color:#7f7;font:12px monospace;padding:8px;max-width:560px;white-space:pre-wrap;border-radius:6px';
    div.textContent = log.join('\n');
    document.getElementById('ui').appendChild(div);
  }


  function showTitle() {
    mode = 'title';
    cancelAnimationFrame(rafId);
    playBgm('main');
    // 没有「本地存档 → 开始游戏」这条路：进游戏必须先登录。
    if (window.__SSDZ_ONLINE__ && window.OnlineUI && OnlineUI.showLogin) {
      try { OnlineUI.showLogin('login'); return; } catch (e) { if (window.__errs) window.__errs.push('login: ' + (e && e.message)); }
    }
    const ui = $('#ui');
    ui.innerHTML = `
      <div class="title-screen">
        <div class="title-logo">松鼠大战</div>
        <div class="title-sub">UC乐园 · 熟悉的松鼠回来了</div>
        <img class="classic-portrait" src="images/ui/characters/squirrel-classic.png" alt="经典松鼠">
        <div class="title-form"><input id="name-input" maxlength="21" aria-label="松鼠昵称" placeholder="给你的松鼠起个名字" value="小松鼠">
        <button id="start-btn" class="uc-button gold">开始游戏</button></div>
        <div class="title-tip">怀旧单机版 · 进度自动保存</div>
      </div>`;

    drawHomeBg(ctx, homeBgBlur());
    $('#start-btn').onclick = () => {
      const raw = String($('#name-input').value || '').trim() || '小松鼠';
      const rules = window.NicknameRules;
      const check = rules ? rules.check(raw) : { ok: true, name: raw };
      if (!check.ok) { if (window.UI && UI.toast) UI.toast(check.reason); return; }
      State.newGame(check.name);

      try { if (window.UI && UI.applyUiMode) UI.applyUiMode(State.settings().uiMode); } catch (e) {}
      playBgm('main');
      showHome();
    };
    $('#name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#start-btn').click(); });
  }


  let homeRegions = [];
  // 只启动主界面 canvas 场景（背景 + 松鼠 + HUD 循环）：不碰 `#ui`、不碰引导。
  // 那一支的页面 DOM 由调用方自己恢复，但 canvas 必须从战斗终帧切回主界面场景：
  function startHomeScene(forceCanvas) {
    mode = 'home';
    playBgm('main');

    // 经典模式的首屏由 SfUiMain 异步挂载；挂载前不要先起 canvas 场景 ——
    // 那会白拉一套装备图层（6 张）和 DOM 回退用的头像，随后又被 SVG 盖掉。
    // `forceCanvas` 只给经典壳挂载失败、已切到 DOM 回退时用。
    const classicShell = !forceCanvas && uiModeIsClassic() && !!window.SfUiMain &&
      !document.querySelector('#ui .classic-home:not(.ssfight-home)');
    const classicHome = classicShell || ssfightHomeActive();
    if (!classicHome) buildHomeScene();
    else { mainPlayer = null; homeBgPlayer = null; }
    let last = performance.now();
    cancelAnimationFrame(rafId);
    (function loop(now) {
      if (mode !== 'home') return;
      if (classicHome || ssfightHomeActive()) {
        homeRegions = [];
        window.__homeRegions = homeRegions;
        rafId = 0;
        return;
      }
      const dt = Math.min(50, now - last); last = now;
      homeT += dt;
      Engine.updatePlayer(mainPlayer, dt);
      if (homeBgPlayer) Engine.updatePlayer(homeBgPlayer, dt);
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      drawHomeBg(ctx, homeBgBlur());
      if (homeBgPlayer) Engine.drawPlayer(ctx, homeBgPlayer);
      homeRegions = UI.drawHomeHud(ctx, W, H);
      window.__homeRegions = homeRegions;
      rafId = requestAnimationFrame(loop);
    })(performance.now());
  }

  // 回首页：重建 `#ui` 里的页面（`renderHome()` 会顺带清掉挑战页等覆盖层）＋启动场景。
  // 需要"页面别动"的战斗收尾（`keepScreen`）只调 `startHomeScene()`，不要调它。
  function showHome() {
    applyStoredSettings();
    UI.renderHome();
    fitCanvas();
    startHomeScene();

    scheduleBattleAssets();
    scheduleClassicFightCore();
    if (window.SfGuide) { try { SfGuide.onHome(); } catch (e) { if (window.__errs) window.__errs.push('SfGuide home: ' + (e && e.message)); } }
  }
  // 恢复钩子：只有确实停在首页、且主界面循环已经退出时，才重新起一次 canvas 场景。
  // 但那时 `startHomeScene()` 早已因为「壳在」返回过，必须靠这里把画面接回来。
  function resumeHomeScene() {
    if (mode !== 'home') return false;
    try { if (!rafId) startHomeScene(true); } catch (e) { return false; }
    return true;
  }

  canvas.addEventListener('click', (e) => {
    if (mode !== 'home') return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / r.width);
    const y = (e.clientY - r.top) * (H / r.height);
    const key = UI.hitRegion(homeRegions, x, y);
    if (key) UI.runAction(key);
  });

  // 主界面场景：原版 mainWalk1 循环跑动（88 帧，含翻滚与拖影）。
  // 需要临时调回快/更慢：`Main.setHomeFps(帧率)`（调试入口）。
  const HOME_WALK_FPS = 14;
  function buildHomeScene() {
    mainPlayer = Engine.makePlayer();
    homeBgPlayer = null;
    homeT = 0;
    const SQ = ['SQ_01', 'SQ_02'];
    const walkName = ['mainWalk1', 'mainWalk2', 'mainWalk3'].find((n) => Engine.hasAnim(n)) || 'standby';
    homeWalk = Engine.playAnim(mainPlayer, walkName, { loop: true, fps: HOME_WALK_FPS, layer: 2, sheets: SQ });
    if (Engine.hasAnim(walkName + '_e')) {
      Engine.playAnim(mainPlayer, walkName + '_e', { loop: true, fps: HOME_WALK_FPS, layer: 4, sheets: ['main_e1'] });
    }
  }
  let homeBgPlayer = null, homeWalk = null;


  // 这一场由谁来播：经典模式 = 原版 fight 帧（`js/ssfight/ui-fight.js`）。
  // `SfFight` 的核心包 + 本场动作包按需加载；加载失败会向上抛，这里退回 canvas。
  function battleRenderer() {
    try {
      if (window.SfFight && SfFight.ready()
        && UI.currentUiMode && UI.currentUiMode() === 'classic') return SfFight;
    } catch (e) {}

    return window.Battle || null;
  }

  async function runBattle(opts) {
    const first = opts && opts.classicFight && window.SfFight && SfFight.ready()
      ? SfFight : battleRenderer();
    if (!first) throw new Error('没有可用的战斗渲染器');
    if (first === window.Battle) return window.Battle.run(opts);
    try {
      return await SfFight.run(opts);
    } catch (error) {
      if (window.__errs) window.__errs.push('SfFight: ' + (error && error.message));

      if (window.__SSDZ_ONLINE__ || !window.Battle) throw error;
      return window.Battle.run(opts);
    }
  }

  function clearUiForBattle(keep) {
    const ui = document.getElementById('ui');
    if (!ui) return;
    for (const node of Array.from(ui.childNodes)) {
      if (node === keep) continue;
      if (node.nodeType === 1 && node.hasAttribute
        && (node.hasAttribute('data-sf-battle-hold') || node.hasAttribute('data-sf-battle-underlay'))) continue;
      ui.removeChild(node);
    }
  }
  // 战斗页已经可见：把加载期一直露着的底页转成「按住并隐藏」。
  function hideHeldForBattle() {
    const ui = document.getElementById('ui');
    if (!ui) return;
    for (const el of ui.querySelectorAll('[data-sf-battle-underlay]')) {
      el.setAttribute('data-sf-battle-hold', '');
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
    }
  }
  async function startBattle(foe, opts) {
    opts = opts || {};
    if (mode === 'battle') return;
    const S = State.state();
    if (opts.cost && !State.consumeEnergy(opts.cost)) { UI.toast('体力不足，无法开始战斗'); return; }
    // 关卡「徒弟先上阵」：调用方传 `fighter` 时，这一场直接使用徒弟快照作为玩家侧，
    // 不再套玩家自己的装备/幻兽乘区（那些属于师父，不能偷偷帮徒弟加面板）。
    const useFighter = !!(opts.fighter && typeof opts.fighter === 'object');
    // 这里不能再套一次加成，否则回放里的伤害与结算对不上。
    const sheetsReady = opts.sheetsReady === true;
    const stats = (useFighter || sheetsReady) ? null : State.totalStats({ useProps: opts.useProps !== false });
// hpRatio 是关卡连战的入场血量比例：hp 按比例继承，maxHp 仍是不变的上限。
    const startRatio = opts.hpRatio == null ? 1 : Math.min(1, Math.max(0.01, Number(opts.hpRatio) || 0));
    const me = useFighter ? Object.assign({}, opts.fighter)
      : sheetsReady && opts.me && typeof opts.me === 'object' ? Object.assign({}, opts.me)
        : (() => {
          const maxHp = Math.max(1, Math.round(stats.hp));
          return {
            name: S.name, level: S.level,
            power: stats.power, agility: stats.agility, speed: stats.speed,
            hp: Math.max(1, Math.round(maxHp * startRatio)), maxHp,
            baseStats: { power: S.power, agility: S.agility, speed: S.speed },
            weapons: State.myWeapons().map((w) => ({ id: w.id, level: w.level, harmLo: w.harmLo, harmHi: w.harmHi })),
            skills: State.mySkills().map((s) => ({ id: s.id, level: s.level })),
            npcType: opts.myNpcType || null,
            effects: State.equipmentEffects(), masterLevel: S.master ? S.master.level : 0,
          };
        })();
    if (useFighter || sheetsReady) {
      me.maxHp = Math.max(1, Math.round(Number(me.maxHp || me.hp) || 1));
      me.hp = Math.max(1, Math.round(Math.min(me.maxHp, Number(me.hp) || me.maxHp) * startRatio));
    } else {
      if (typeof opts.adjustMe === 'function') opts.adjustMe(me);

      // 幻兽出战队伍：先把宠物加成落到玩家面板，再给随机 AI 对手生成 1~3 只幻兽。
      try {
        me.pets = State.petTeam ? State.petTeam() : [];
        if (window.State && State.applyPetBonuses) State.applyPetBonuses(me, me.pets);
      } catch (e) { if (window.__errs) window.__errs.push('pet battle: ' + (e && e.message)); }
    }
    try {
      if (!sheetsReady && foe && foe.isAI && !Array.isArray(foe.pets) && opts.pets !== false && State.randomPetLoadout) {
        foe.pets = State.randomPetLoadout(foe.level);
      }
      if (!sheetsReady && foe && Array.isArray(foe.pets) && State.applyPetBonuses) State.applyPetBonuses(foe, foe.pets);
    } catch (e) { if (window.__errs) window.__errs.push('pet battle: ' + (e && e.message)); }
    mode = 'battle';
    cancelAnimationFrame(rafId);
    // 不在开打前清 #ui / 改缩放：底页继续露在加载过程中，SfFight 挂好后再自己清屏并 resizeLayout。
    const renderer = battleRenderer();
    playBgm('fight');
    if (opts.region != null && foe && foe.region == null) foe.region = opts.region;
    let settled = false;
    // 这一场走的是不是原版 fight 帧（`SfFight`）。它决定战斗结束后要不要再弹复刻那层
    const campaignClassic = !!(foe && foe.campaign && window.SfFight && SfFight.ready());
    const classicFight = campaignClassic || renderer === SfFight;
    let controller = null;
    controller = await runBattle({
      classicFight: campaignClassic,

      holdUnderlay: opts.holdUnderlay === true,
      canvas, me, foe, region: opts.region, kind: opts.kind, collectDrops: opts.collectDrops !== false,
      // 把服务端算好的整场 `result` 原样交给播放器。
      // ⚠ 少了这一行，`SfFight.run` / `Battle.run` 会走
      // —— 客户端用自己的随机流再算一遍，录像里可能赢、服务端结算却是输。
      result: opts.result,
      // 联机版双方面板已由服务端算好，跳过幻兽二次加成（见上面 sheetsReady）。
      sheetsReady,
      // 普通战斗的倍速上限是 2×（不给 3×），塔自己传 speedMax: 3 才拿得到 3×。
      allowSkip: opts.allowSkip !== false && (State.skipButtonEnabled ? State.skipButtonEnabled() : State.unlockedSkip()),
      speedToggle: opts.speedToggle !== false && State.unlockedSpeed(),
      speedMax: Number(opts.speedMax) > 0 ? Number(opts.speedMax) : 2,
      // 训练木桩等特殊战斗的回合上限（默认 0 = 播放器自己的 60）。只影响 HUD 的剩余
      maxRounds: Number(opts.maxRounds) > 0 ? Math.floor(Number(opts.maxRounds)) : 0,
      trial: opts.trial,
      debuffs: opts.debuffs,
      dropRandom: (window.QA_FIXTURE && QA_FIXTURE.dropRandom) || opts.dropRandom,
      pickupPlan: opts.pickupPlan,
      claimPickup: opts.claimPickup,
      // 挑战页在战果页出现前算经验/金松果（`State.fightReward`），让第一张战果页就能
      // 写全"经验 + 金松果 + 悬浮物品"；算过的结果由调用方缓存，`onEnd` 不重复发。
      rewardFor: opts.rewardFor,

      resultNote: opts.resultNote,

      skipResultPanel: opts.skipResultPanel === true,
      hideVictoryCg: opts.hideVictoryCg === true,

      skipChest: opts.skipChest === true,
      claimChest: opts.claimChest,
      onClaimError: opts.onClaimError,
      onCancel: typeof opts.onCancel === 'function' ? () => {
        if (settled) return;
        settled = true;
        if (!controller || activeBattle === controller) {
          activeBattle = null;
          if (mode === 'battle') mode = 'home';
        }
        opts.onCancel();
      } : undefined,
      onEnd: (winner, result, loot, reward) => {
        if (settled) return;
        settled = true;
        activeBattle = null;
        // 切了档：这一场作废，回首页（原行为）。
        // ⚠ 顺序不能反：`State.state() !== S` 时绝不能去调 `opts.onEnd`，
        if (State.state() !== S) { showHome(); return; }
        // 回到镜像里）；客户端再记一次会变成两条，所以调用方传 `skipRecord` 时这里不记。
        if (opts.skipRecord !== true) {
          State.recordBattle({ me, foe, result, region: opts.region != null ? opts.region : foe.region || 0, kind: opts.kind || 'challenge' });
        }
        playBgm('main');
        // ⚠ `keepScreen`：经典模式的连战 / 竞技场要"打完直接回原来那一页"。
        // 就是这个顺序造成的。传 `keepScreen: true` 时这里不换页，由调用方自己恢复。
        // ⚠ 但模式必须自己拨回 `home`：`mode` 只在 `showHome()` 里被重置，
        if (!opts.keepScreen) showHome();
        // 接力回放的底板是原页面，不能再让 canvas 画主界面；
        else if (opts.holdUnderlay) { mode = 'home'; playBgm('main'); }
        else startHomeScene();
        // 现代 canvas 播放器不认 `rewardFor`（经典 SfFight 才在战果页出现前自己算）。
        // 这里在确认还是同一个存档之后再补算一次，交给调用方和收益弹窗：
        // 发给新档（`State.fightReward` 读写的是当前全局存档）。`settle` 自己缓存，
        let finalReward = reward;
        if (!classicFight && finalReward == null && typeof opts.rewardFor === 'function') {
          try { finalReward = opts.rewardFor(winner); } catch (e) {
            if (window.__errs) window.__errs.push('battle rewardFor: ' + (e && (e.stack || e.message) || e));
          }
        }
        opts.onEnd && opts.onEnd(winner, result, loot, finalReward);
        // ⚠ 两座塔（挑战塔 / 无尽塔）也不走这里：塔的产出全部由
        // 战斗结束不能再叠一层空的「战斗拾取」（`collectDrops:false` 时它只有
        const towerFight = opts.kind === 'tower' || opts.kind === 'endless';
        if (!classicFight && !towerFight && UI.classic && UI.classic.pickupResult) UI.classic.pickupResult(loot, finalReward, winner);
      },
      onError: () => {
        if (settled) return;
        settled = true; activeBattle = null; showHome();
        if (State.state() !== S) return;
        UI.toast('战斗播放中断，请重新挑战'); if (opts.onError) opts.onError();
      },
    });
    if (!settled) activeBattle = controller;
    if (!settled && window.SfGuide) {
      try { SfGuide.onBattleStart(); } catch (e) { if (window.__errs) window.__errs.push('SfGuide battle: ' + (e && e.message)); }
    }
  }

  async function replayBattle(entry, onEnd) {
    if (!entry || mode === 'battle') return;
    const owner = State.state();
    let settled = false;
    mode = 'battle'; cancelAnimationFrame(rafId); playBgm('fight');
    const controller = await runBattle({ canvas, me: entry.me, foe: entry.foe, region: entry.region, result: entry.result, collectDrops: false,

      allowSkip: State.skipButtonEnabled ? State.skipButtonEnabled() : true,
      onEnd: () => {
        if (settled) return;
        settled = true; activeBattle = null; showHome();
        if (State.state() === owner && onEnd) onEnd();
      },
      onError: () => {
        if (settled) return;
        settled = true; activeBattle = null; showHome();
        if (State.state() === owner) UI.toast('录像播放中断');
      },
    });
    if (!settled) activeBattle = controller;
  }
  function setMuted(value) {
    muted = !!value;
    if (!muted && volume <= 0) volume = clampVolume(localStorage.getItem('ssdz_music_volume')) || 1;
    persistSettings({ volume: volume, muted: muted });
    playBgm(mode === 'battle' ? 'fight' : 'main');
  }

  function setHomeFps(fps) {
    const value = Math.max(1, Math.min(60, Number(fps) || 22));
    for (const inst of mainPlayer.list) inst.fps = value;
    return value;
  }


  const SUPPORT = Object.freeze({
    url: 'https://ifdian.net/a/Charlespkuer',
    label: '爱发电',
  });

  function viaOwnLocalServer() {
    try {
      const h = String((window.location && window.location.hostname) || '').toLowerCase();
      const p = String((window.location && window.location.port) || '');
      return !!p && (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]');
    } catch (e) { return false; }
  }
  function plainWindowOpen(url) {
    try {
      // 注意：不能在 features 里写 'noopener' —— 按规范那样 window.open 一律返回 null，
      const w = window.open(url, '_blank');
      if (!w) return false;
      try { w.opener = null; } catch (e) {  }
      return true;
    } catch (e) { return false; }
  }
  // 用系统默认浏览器打开一个 http(s) 链接。返回 Promise<boolean>（true = 已交给浏览器）。
  // iOS 的 WKWebView 会把 window.open 吞掉，必须优先走 Rust `open_external`（tauri-plugin-opener）。
  function openExternal(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return Promise.resolve(false);
    // 安卓：Kotlin 桥。必须排在最前面 —— IPC 路径也会「成功」返回、实际没打开，
    const android = typeof window !== 'undefined' ? window.SSDZAndroid : null;
    if (android && typeof android.openExternal === 'function') {
      try {
        const r = JSON.parse(String(android.openExternal(u) || '{}'));
        if (r && r.ok) return Promise.resolve(true);
        if (r && r.msg) console.warn('[openExternal] 安卓端打开链接失败：' + r.msg);
        return Promise.resolve(false);
      } catch (e) {
        console.warn('[openExternal] 安卓桥不可用，改用其它方式', e);
      }
    }
    const ownServer = viaOwnLocalServer();
    const fallback = () => {
      const T = window.__TAURI__;
      if (T && !ownServer) {
        if (T.opener && typeof T.opener.openUrl === 'function') {
          try { return Promise.resolve(T.opener.openUrl(u)).then(() => true, () => false); } catch (e) {  }
        }
        if (T.core && typeof T.core.invoke === 'function') {
          return Promise.resolve(T.core.invoke('open_external', { url: u })).then(() => true, () => false);
        }
      }
      if (T && ownServer && typeof fetch === 'function') {
        return fetch('/__open?url=' + encodeURIComponent(u), { cache: 'no-store' })
          .then((r) => (r && r.ok ? r.json() : null))
          .then((j) => (j && j.ok ? true : plainWindowOpen(u)))
          .catch(() => plainWindowOpen(u));
      }
      // 便携版 / 网页版：直接同步 window.open。
      // 不能先 await fetch（哪怕只是探测 /__open）—— 那样会丢掉「用户点击」这个手势，
      return Promise.resolve(plainWindowOpen(u));
    };
    const native = window.__TAURI_INTERNALS__;
    if (native && typeof native.invoke === 'function' && !ownServer) {
      return Promise.resolve(native.invoke('open_external', { url: u })).then(() => true, fallback);
    }
    return fallback();
  }
  // 便捷入口：尽力打开「支持作者」页（失败不弹窗）。
  function openSupport() { return openExternal(SUPPORT.url); }


  window.Main = { showHome, showTitle, startBattle, replayBattle, clearUiForBattle, hideHeldForBattle, isBattle: () => mode === 'battle', resizeLayout:fitCanvas, setMuted, isMuted: () => muted,

    resumeHomeScene,
    volume: volumeValue, setVolume, homePlayer: () => mainPlayer, setHomeFps, W, H,
    settings: settingsSnapshot, setResolution, setFullscreen, setHideStatusBar, applySystemBars, setBackgroundRun, applyBackgroundRun,
    isFullscreen: () => !!document.fullscreenElement,

    preloadBattleAssets, pinBattleAssets, battleAssetsReady: () => !!battleAssetsPromise,

    SUPPORT, openExternal, openSupport };

  window.addEventListener('DOMContentLoaded', boot);
})();
