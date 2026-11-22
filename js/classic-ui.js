// 经典 UC 界面：联机版里只保留 ssfight 没有对应元件的页面（背包 / 活动 / 帮助 / 弹窗）。

(function () {
  'use strict';
  const legacy = window.UI;
  const W = 1170, H = 690;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const vipBadge = () => { try { return State.vipActive() ? '<span class="vip-badge" title="超级松鼠">\u2605</span>' : ''; } catch (e) { return ''; } };

  const dailyAttention = () => {
    try {
      if (!State.dailyStatus().claimed) return true;
      if (State.questClaimable() > 0) return true;
      const t = (window.ClassicExtras && ClassicExtras.tributeStatus) ? ClassicExtras.tributeStatus() : null;
      return !!(t && t.claimable);
    } catch (e) { return false; }
  };
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
  // 按钮底色走 CSS 药丸；原版有对应元件的键（页脚返回菜单 / 翻页箭头 / 页签）由
  // `installVectorChrome()` 换成原版矢量图，矢量没到时才用 `.chev` 人字形兜底。
  const btn = (label, action, cls) => '<button type="button" class="uc-button ' + (cls || '') + '" data-action="' + esc(action) + '"' +
    ((label === '‹' || label === '›') ? ' aria-label="' + (label === '‹' ? '上一页' : '下一页') + '"' : '') + '>' +
    ((label === '‹' || label === '›') ? '<span class="reference-button-label">' + label + '</span><span class="page-arrow-art" aria-hidden="true"></span><i class="chev ' + (label === '‹' ? 'chev-l' : 'chev-r') + '" aria-hidden="true"></i>' : esc(label)) + '</button>';
  let screen = 'home', timer = 0, activePortrait = null, lastRefresh = 0;
  let catalogPage = 0, bagPage = 0;

  const touchUi = (() => {
    try {
      return !!(document.addEventListener && document.getElementById && window.matchMedia &&
        matchMedia('(pointer: coarse)').matches);
    } catch (e) { return false; }
  })();
  const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now());
  let navLockUntil = 0;
  const navLock = (ms) => { navLockUntil = Math.max(navLockUntil, nowMs() + (ms || 160)); };
  const navLockInteresting = (n) => !!(n && n.nodeType === 1 && n.classList && (
    n.classList.contains('classic-page') || n.classList.contains('classic-home') ||
    n.classList.contains('classic-modal-overlay') || n.classList.contains('ssfight-view') ||
    n.classList.contains('sf-rank-prep') || n.classList.contains('panel')));
  if (touchUi) {
    document.addEventListener('click', (e) => {
      if (nowMs() >= navLockUntil) return;

      if (!e.isTrusted && !e.__sfSynth) return;
      // 告诉 touch-fallback「这一下确实有可信 click，只是被换页锁吞了」：
      // 它的 420ms 兜底否则会以为 click 丢了，锁过期后再补发一次旧坐标的 click。
      // ⚠ 这里必须用 Date.now()：touch-fallback 的 began / lastTrustedClick 都是 Date.now，
      if (e.isTrusted) window.__sfTrustedClickAt = Date.now();
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
    const watchNavLock = () => {
      const ui = document.getElementById('ui');
      if (!ui || !window.MutationObserver) return;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) if (navLockInteresting(n)) { navLock(); return; }
          for (const n of r.removedNodes) if (navLockInteresting(n)) { navLock(); return; }
        }
      }).observe(ui, { childList: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchNavLock, { once: true });
    else watchNavLock();
  }
  // 当前背包页的「就地刷新」入口（合成页关掉时用它更新数量，不整页重建；见 openBag 里的 refreshBag）。
  let bagRefresh = null;

  const bagSort = (a, b) => {
    const pa = Number(a && a.id) === 89 ? 0 : 1;
    const pb = Number(b && b.id) === 89 ? 0 : 1;
    return pa - pb || (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
  };
  let selectedProp = 0;
  let selectedRankGood = 0;

  const ICON_DIRS = { gear: 'gear', weapon: 'weapon', skill: 'skill', prop: 'prop' };
  const selectedItems = {weapon:0,skill:0};

  const BUFF_PROPS = [[3, '力量+20%'], [4, '敏捷+20%'], [5, '速度+20%'], [7, '挑战经验+40%'], [41, '力量+40%'], [42, '敏捷+40%'], [43, '速度+40%'], [44, '挑战经验+60%']];
  let buffSignature = '';
  // 只服务 canvas 主界面 / DOM 回退头像；经典模式首屏由 SfUiMain 接管，不要在模块加载时
  // 先拉这三张图。用到哪张再建哪张。
  const PORTRAIT_SRC = {
    classic: 'images/ui/characters/squirrel-classic.png',
  };
  const portraits = Object.create(null);
  function portraitImage(key) {
    if (!portraits[key]) {
      const img = new Image();
      img.src = PORTRAIT_SRC[key];
      portraits[key] = img;
    }
    return portraits[key];
  }

  function bind(root, actions) {
    $$('[data-action]', root).forEach(b => {
      // ⚠ 没登记的动作不要碰：同一棵 DOM 可能被二次 bind —— 弹窗是先由 modal()
      const f = actions[b.dataset.action];
      if (!f) return;
      b.onclick = () => {

        if (b.classList && (b.classList.contains('uc-tab') || b.classList.contains('sf-feedback'))) popTap(b, () => f(b));
        else f(b);
      };
    });
  }

  // 注意与主界面那颗不是同一套画稿 —— 主界面（非 ssflight 的经典首页）用的是资源图集
  const GOLD_ICON = 'images/ui/icons/gold-acorn.svg';
  function goldIcon(cls) { return '<img alt="" class="' + (cls || '') + '" src="' + GOLD_ICON + '">'; }

  function giftIcon(id) { return Number(id) === 8 ? goldIcon() : icon('prop', id); }

  function goldPrice(n, title) {
    const num = Math.max(0, Number(n) || 0);
    return '<span class="gold-price"' + (title ? ' title="' + esc(title) + '"' : '') +
      ' role="img" aria-label="' + esc((title ? title + '：' : '') + num + ' 金松果') + '">' +
      goldIcon('gold-price-art') + '<b>' + num + '</b></span>';
  }
// 尺寸下边缘都干净（纯 CSS 百分背景在 Chrome 上切不出正确的字）。

  const NUM_SHEET = 'images/ui/numbers/num_28.png', NUM_W = 26, NUM_H = 23;
  const NUM_KEYS = '0123456789%×';
  const numImage = new Image(); numImage.src = NUM_SHEET;
  const numeral = (n) => String(n == null ? '' : n).replace(/[^0-9%×/.,:+-]/g, '');
  const numStretch = () => (window.Debug && Debug.numberStretch ? Debug.numberStretch() : 1.25);
// 字距：字形宽度保持不变（沿用上面的横向拉伸），只把推进距离收紧。
  const NUM_ADVANCE = 0.86;

  function renderNumbers(root) {
    if (!numImage.complete || !numImage.naturalWidth) return;
    const stretch = numStretch();
    const blocks = root?.matches?.('.num[data-text]') ? [root] : $$('.num[data-text]', root || document);
    for (const block of blocks) {
      const canvas = $('canvas', block), height = block.clientHeight;
      if (!canvas || !height) continue;
      const text = block.dataset.text;
// --uiscale 统一缩放。这里绝不能写 canvas 的显示尺寸，否则会二次缩放。
      const k = height / NUM_H;
      const glyph = NUM_W * k * stretch;
      const adv = glyph * NUM_ADVANCE;
      const width = Math.max(1, Math.round(Math.max(0, text.length - 1) * adv + glyph));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const cx = canvas.getContext('2d');
      cx.clearRect(0, 0, width, height);
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      for (let i = 0; i < text.length; i++) {
        const at = NUM_KEYS.indexOf(text[i]);
        if (at >= 0) {
          cx.drawImage(numImage, at * NUM_W, 0, NUM_W, NUM_H, i * adv, 0, glyph, height);
        } else {
          cx.font = 'bold ' + Math.round(height * 0.86) + 'px "Microsoft YaHei",sans-serif';
          cx.textAlign = 'center';
          cx.textBaseline = 'middle';
          cx.lineWidth = Math.max(1.5, height * 0.09);
          cx.strokeStyle = 'rgba(94,100,106,.95)';
          cx.fillStyle = '#fdfdfa';
          cx.strokeText(text[i], i * adv + glyph / 2, height * 0.55);
          cx.fillText(text[i], i * adv + glyph / 2, height * 0.55);
        }
      }
      const emWidth = ((Math.max(0, text.length - 1) * adv + glyph) / height).toFixed(4);
      block.style.setProperty('--w', emWidth + 'em');
    }
  }
  function bindNumImage() {
    if (numImage.complete && numImage.naturalWidth) renderNumbers();
    else numImage.addEventListener('load', () => renderNumbers(), { once: true });
  }
  bindNumImage();

  function num(value, plain) {
    const text = numeral(value);
    if (plain) return '<span class="num plain" data-text="' + esc(text) + '" style="--n:' + text.length + '" role="img" aria-label="' + esc(text) + '"><u>' + esc(text) + '</u></span>';
    return '<span class="num" data-text="' + esc(text) + '" style="--n:' + text.length + '" role="img" aria-label="' + esc(text) + '"><canvas></canvas><u>' + esc(text) + '</u></span>';
  }

  function setNum(host, value) {
    if (!host) return;
    const text = numeral(value);
    if (host.dataset.text === text) return;
    host.dataset.text = text;
    host.style.setProperty('--n', text.length);
    if (host.classList.contains('plain')) {
      const u = $('u', host);
      if (u) u.textContent = text;
      return;
    }
    renderNumbers(host);
  }

  // 原版道具库元件导出的无框矢量（`images/ui/icons/prop/prop-<id>.svg`）。
  const PROP_SVG_IDS = new Set([
    1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23,
    24, 25, 26, 28, 29, 30, 31, 32, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
    47, 48, 49, 50, 79, 82, 87, 90, 101, 102, 103, 104, 105, 106, 107,
  ]);
  // 去掉内嵌白底后换一次 URL：服务端对 /images/ 发 7 天 immutable，WebView 会继续用旧图。
  // 药丸/药剂也一起换：旧 URL 可能在 WebView 里还是重导前的错贴图（主界面/背包/使用窗共用这张表）。
  const PROP_SVG_REV = new Set([
    1, 2, 3, 4, 5, 7, 10, 11, 12, 13, 16, 17, 18, 19, 38, 41, 42, 43, 44, 50,
  ]);
  // 道具图标路径：有原版无框矢量就走 SVG，否则退回图集 PNG。
  function propIconSrc(id) {
    const n = Number(id);
    const file = 'images/ui/icons/prop/prop-' + n + (PROP_SVG_IDS.has(n) ? '.svg' : '.png');
    return PROP_SVG_REV.has(n) ? file + '?v=3' : file;
  }
  /* 把 <img src="*.svg"> 换成内联 <svg>，只给「需要按画面实际占位重设 viewBox」的地方用
   *（抽奖格子的道具图标：原版矢量各家留白差很多，同尺寸格子会一大一小）。
   * 渐变 id 必须加实例前缀，否则多个图标共用同名 id 会串色。 */
  const SVG_TEXT_CACHE = new Map();
  let svgInlineSeq = 0;
  function svgText(url) {
    const key = String(url);
    if (SVG_TEXT_CACHE.has(key)) return SVG_TEXT_CACHE.get(key);
    const pending = fetch(key, { cache: 'force-cache' })
      .then((r) => { if (!r || !r.ok) throw new Error('icon ' + key); return r.text(); })
      .catch((e) => { SVG_TEXT_CACHE.delete(key); throw e; });
    SVG_TEXT_CACHE.set(key, pending);
    return pending;
  }
  function namespaceSvgIds(svg, prefix) {
    const ids = [...svg.querySelectorAll('[id]')].map((n) => n.getAttribute('id')).filter(Boolean);
    for (const id of ids) {
      const safe = prefix + id.replace(/[^\w.-]/g, '_');
      for (const node of svg.querySelectorAll('[id]')) {
        if (node.getAttribute('id') === id) node.setAttribute('id', safe);
      }
      for (const node of svg.querySelectorAll('*')) {
        for (const attr of [...node.attributes]) {
          if (attr.value.indexOf('#' + id) < 0) continue;
          node.setAttribute(attr.name, attr.value.split('#' + id).join('#' + safe));
        }
      }
    }
  }
  /** 返回 Promise<svg>；失败/不需要内联时给 null。 */
  function inlineSvgIcon(img) {
    if (!img || img.tagName !== 'IMG' || img.dataset.svgInline) return Promise.resolve(null);
    const raw = img.getAttribute('src');
    if (!raw || /^(data|blob):/i.test(raw) || !/\.svg(?:$|[?#])/i.test(raw)) return Promise.resolve(null);
    const box = img.getBoundingClientRect();
    if (!(box.width > 1 && box.height > 1)) return Promise.resolve(null);
    img.dataset.svgInline = '1';
    const cs = getComputedStyle(img);
    const prev = img.style.visibility;
    img.style.visibility = 'hidden';
    return svgText(raw).then((text) => {
      if (!img.isConnected) return null;
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('bad svg ' + raw);
      namespaceSvgIds(svg, 'sfi' + (++svgInlineSeq) + '_');
      svg.setAttribute('class', (img.className || '') + ' sf-inline-icon');
      svg.setAttribute('role', 'img');
      if (img.alt) svg.setAttribute('aria-label', img.alt);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.cssText = 'width:' + cs.width + ';height:' + cs.height + ';position:' + cs.position +
        ';left:' + cs.left + ';top:' + cs.top + ';margin:' + cs.margin + ';display:' + cs.display +
        ';opacity:' + cs.opacity + ';visibility:' + prev + ';pointer-events:' + cs.pointerEvents +
        ';transform:' + cs.transform + ';filter:' + cs.filter + ';vertical-align:' + cs.verticalAlign + ';';
      img.replaceWith(svg);
      return svg;
    }).catch(() => { if (img.isConnected) img.style.visibility = prev; return null; });
  }
  function atlasIcon(kind, id, locked, trueForm) {
    // 图标按类型分了目录（images/ui/icons/<类型>/<类型>-<id>.png），而 kind 是运行时变量，
    // 所以查 ICON_DIRS 表 —— 不能再拼死路径（漏改这里会让背包/融合的图标全裂）。
    const dir = ICON_DIRS[kind] || 'misc';
    if (kind === 'weapon' && trueForm) return 'images/ui/icons/weapon/weapon-true-' + id + (locked ? '-locked' : '') + '.png';

    if (kind === 'gear' && [201, 202, 203, 204, 205, 206, 207, 208].includes(+id)) {
      // 205-208 换过画稿；/images/ 不带 ?v= 缓存 7 天、带 ?v= 是 1 年 immutable，必须换 URL 才能让旧缓存失效。
      return 'images/ui/icons/gear/gear-' + (+id) + '-classic.svg' + ([205, 206, 207, 208].includes(+id) ? '?v=3' : '');
    }

    if (kind === 'prop') return propIconSrc(id);
    return 'images/ui/icons/' + dir + '/' + kind + '-' + id + (locked ? '-locked' : '') +
      (kind === 'weapon' || kind === 'skill' ? '.svg' : '.png');
  }

  const levelLabel = (level, withPrefix) => {
    const t = (window.GData && GData.trueLevel) ? GData.trueLevel(level) : 0;
    if (t > 0) return '真' + t;
    return withPrefix === false ? String(level) : 'LV' + level;
  };
  const isTrueGear = (item) => !!item && (window.GData && GData.trueLevel ? GData.trueLevel(item.level) > 0 : Number(item.level) > 10);

  const TRUE_CARD_IDS = { weapon: [1, 5, 6, 8], skill: [1, 2, 4, 5, 6, 10, 11, 12, 13, 16, 17, 24] };
  function icon(kind, id, locked, selected, trueForm) {
    // 真形态优先走专属贴图 —— 必须放最前面：下面「参考卡」那几条会提前 return，
    if (trueForm && TRUE_CARD_IDS[kind] && TRUE_CARD_IDS[kind].includes(+id)) {
      return '<img alt="" class="reference-art" src="images/ui/cards/true/' + kind + '-' + id + '.png">';
    }
    if (kind === 'weapon' && trueForm) return '<img alt="" src="' + atlasIcon('weapon', id, locked, true) + '">';

    const reference = {
      weapon: { learned: [1,5,7,8,9,15], locked: [2,3,4,6,10,12,13,14] },
      skill: { learned: [2,3,4,7,9,13,15,18], locked: [1,5,6,8,10,11,12,14,17] }
    };
    const state = locked ? 'locked' : 'learned';
    if (reference[kind]?.[state].includes(+id) && !selected || kind==='skill' && +id===16 && !locked && selected) {
      return '<img alt="" class="reference-art" src="images/ui/cards/state/'+kind+'-'+id+'-'+state+'.png">';
    }
    const grey={weapon:[2,3,4,7,9,10],skill:[3,7,8,9,14,15,18,23]};
    const fromReference=(locked && grey[kind]?.includes(+id)) || (!locked && kind==='skill' && [6,13].includes(+id));
    return '<img alt="" '+(fromReference?'class="reference-art" ':'')+'src="'+(fromReference?'images/ui/cards/true/'+kind+'-'+id+'.png':atlasIcon(kind,id,locked))+'">';
  }
  function statsHtml(stats, cls, hero) {
    const allocation = hero && hero.mode === 'setup' && typeof hero.statState === 'function' ? hero.statState() : null;
    return '<div class="' + (cls || 'stat-strip') + '">' + [['力','power'],['敏','agility'],['速','speed'],['命','hp']].map(([s,k]) => {
      const editable = !!(allocation && k !== 'hp');
      let controls = '';
      if (editable) {
        const rules = allocation.rules || {}, base = Number((allocation.values || {})[k]) || 0;
        controls = '<span class="hero-stat-arrows">' +
          '<button type="button" class="hero-stat-step" data-hero-stat="' + k + ':up" aria-label="' + s + '加1"' +
            (Number(allocation.pool) > 0 && base < Number(rules.cap) ? '' : ' disabled') + '>▲</button>' +
          '<button type="button" class="hero-stat-step" data-hero-stat="' + k + ':down" aria-label="' + s + '减1"' +
            (base > Number(rules.floor) ? '' : ' disabled') + '>▼</button></span>';
      }
      return '<div class="stat-pill' + (editable ? ' hero-stat-pill' : '') + '"><b>' + s + '</b><span class="stat-value">' + esc(stats[k]) + '</span>' + controls + '</div>';
    }).join('') + '</div>';
  }
  const STAT_ICON = { power: 3, agility: 4, speed: 5 };
  const STAT_CHAR = { power: '力', agility: '敏', speed: '速', hp: '命' };

  const pointArt = (key) => {
    const id = STAT_ICON[key];
    return id ? '<img alt="" class="reward-icon-img" src="' + atlasIcon('prop', id) + '">' : '<b class="reward-badge">' + STAT_CHAR[key] + '</b>';
  };

  function upgradeReward(ups) {
    const list = (ups || []).filter(Boolean);
    if (!list.length) return '';
    return list.map((u) => {
      const stats = [
        ['power', '力量', u.power, 'red'],
        ['agility', '敏捷', u.agility, 'blue'],
        ['speed', '速度', u.speed, 'green'],
        ['hp', '生命', u.hp, 'pink'],
      ].filter(([, , v]) => Number(v) > 0);
      const cards = stats.map(([key, label, value, cls]) => {
        const id = STAT_ICON[key];
        const art = id
          ? '<img alt="" class="reward-icon-img" src="' + atlasIcon('prop', id) + '">'
          : '<b class="reward-badge">' + STAT_CHAR[key] + '</b>';
        return '<div class="reward-card ' + cls + '"><span class="reward-icon">' + art + '</span>' +
          '<span class="reward-text">' + label + '+' + esc(value) + '</span></div>';
      });
      const bonus = u.attributeBook ? '<div class="reward-card skill"><span class="reward-icon">'+icon('prop',37)+'</span><span class="reward-text">属性书 ×1</span></div>' : u.reward
        ? '<div class="reward-card skill"><span class="reward-icon">' + icon(u.rewardKind === 'weapon' ? 'weapon' : 'skill', u.rewardId) + '</span>' +
          '<span class="reward-text">' + esc(u.reward) + '</span></div>'
        : '';
      const point = u.autoPoint
        ? '<div class="reward-card point"><span class="reward-icon">' + pointArt(u.autoPoint) + '</span>' +
          '<span class="reward-text" title="' + STAT_CHAR[u.autoPoint] + '：系统分配（力/敏/速低于25%时优先补该项，否则四项随机）">' + STAT_CHAR[u.autoPoint] + '+' + State.STAT_GAIN[u.autoPoint] + '<span class="point-tag">系统分配</span></span></div>'
        : '';
      const wsPick = u.wsChoice
        ? '<div class="reward-card skill"><span class="reward-icon"><b class="reward-badge ws-badge">选</b></span>' +
          '<span class="reward-text">武器/技能 三选一</span></div>'
        : '';

      const chestCard = u.chest
        ? '<div class="reward-card gift"><span class="reward-icon">' + icon('prop', 90) + '</span>' +
          '<span class="reward-text">金宝箱 ×' + esc(u.chest) + '</span></div>'
        : '';
      const giftCards = (u.gifts || []).map((g) =>
        '<div class="reward-card gift"><span class="reward-icon">' + giftIcon(g.id) + '</span>' +
        '<span class="reward-text">' + esc(g.name) + ' ×' + esc(g.count) + '</span></div>').join('');
      return '<div class="reward-panel">' +
        '<div class="reward-title"><img alt="升级奖励" src="images/ui/icons/prop/prop-28.svg"></div>' +
        '<div class="reward-row">' + cards.join('') + point + wsPick + bonus + chestCard + giftCards + '</div>' +
        '<div class="reward-level">升到 ' + esc(u.level) + ' 级</div></div>';
    }).join('');
  }

  function upsHtml(ups) {
    const list = (ups || []).filter(Boolean);
    return list.length ? '<div class="reward-stack">' + upgradeReward(list) + '</div>' : '';
  }
  // ⚠ 经典模式不会走这里：原版战果页自己就写经验/金松果/战利品（见 main.js 的
  function pickupResult(loot, reward, winner) {
    loot = loot || {};
    const items = Array.isArray(loot.items) ? loot.items : [];
    const ups = [...(Array.isArray(loot.ups) ? loot.ups : []),
      ...((reward && Array.isArray(reward.ups)) ? reward.ups : [])];
    const exp = Math.max(0, Math.round(Number(reward && reward.exp) || 0));
    const gold = Math.max(0, Math.round(Number(reward && reward.gold) || 0));

    if (!items.length && !ups.length && !reward) return;
    const grouped = Object.create(null);
    items.forEach(item => { if(grouped[item.id])grouped[item.id].count+=item.count;else grouped[item.id]={...item}; });

    const lostList = Array.isArray(loot.lost) ? loot.lost : (loot.lost ? [loot.lost] : []);
    const lost = lostList.length ? '<div class="battle-loot-summary lost">跳过战斗：随机少收了 ' +
      lostList.map(x => esc(x.name) + ' ×' + x.count).join('　') + '</div>' : '';

    const rewardLine = reward
      ? '<div class="battle-loot-summary reward">战斗奖励：经验 +' + exp + '　金松果 +' + gold + '</div>'
      : '';
    const lootLine = items.length
      ? '<div class="battle-loot-summary">战斗拾取：' +
        Object.values(grouped).map(item => esc(item.name) + ' ×' + item.count).join('　') + '</div>'
      : '';

    const outcome = (winner === 0 || winner === 1)
      ? '<div class="result-title battle-outcome ' + (winner === 0 ? 'win' : 'lose') + '">' +
        (winner === 0 ? '胜 利！' : '战 败…') + '</div>'
      : '';
    const html = rewardLine + lootLine + lost + upsHtml(ups);
    const title = reward ? '战斗结算' : '战斗拾取';
    const bodies=$$('.classic-modal-overlay .modal-body');
    if (bodies.length) {
      const body = bodies[bodies.length-1];
      // 已经开着升级奖励 / 三选一弹窗时：胜负大字放在最上面，收益接在最下面，
      // 不另叠一层弹窗（否则玩家要连关两次）。
      // ⚠ 但关卡战果弹窗自己已经有「胜 利！」大字了（`stageResult` 的
      if (outcome && !body.querySelector('.result-title')) body.insertAdjacentHTML('afterbegin', outcome);
      body.insertAdjacentHTML('beforeend', html);
    } else {
      modal(title, outcome + html, [{label:'确定'}], {small:true});
    }
  }

  function closeOriginalResult() { if (window.SfFightResult) SfFightResult.destroy(); }
  function home() { Main.showHome(); }

  function popTap(el, run, now) {
    const f = window.SfUiFeedback;
    if (!f) { if (run) run(); return; }
    const page = el && el.closest && el.closest('.classic-page');
    const bag = page && /^(bag|shop|exchange)$/.test(page.dataset.screen);
    f.tap(el, run, { delay: bag || now ? 0 : 160, exit: !bag && !now, press: !bag });
  }

  function wirePopTaps(root, opts) {
    opts = opts || {};
    const nodes = [];
    if (opts.tabs) nodes.push(...$$('.classic-tabs .uc-tab', root));
    if (opts.cells) nodes.push(...$$('.catalog-cell:not(.empty-slot)', root));
    if (opts.footer) nodes.push(...$$('.page-footer .uc-button', root));
    if (opts.arrows) nodes.push(...$$('.page-arrow .uc-button', root));
    const f = window.SfUiFeedback;
    if (!f) return;
    for (const n of nodes) {
      f.bind(n, { selected: () => n.classList.contains('selected') || n.classList.contains('active') });
    }
  }
  // ⚠ 只在系统分组页调：分页签 / 设置键 / 帮助物品格 / 超级松鼠档位都覆盖，
  // 但不要把它接到道具页那张已经自己 wirePopTaps 的根上，避免重复挂。
  function wireSystemFeedback(root) {
    const f = window.SfUiFeedback;
    if (!f || !root || !root.querySelectorAll) return root;
    root.classList.add('sf-system-ui');
    for (const n of $$('.uc-tab, .uc-button, .music-toggle, .help-item, .vip-plan', root)) {
      f.bind(n, {
        selected: () => n.classList.contains('active') || n.classList.contains('on') ||
          !!(n.closest && n.closest('.music-setting.on')),
      });
    }
    if (!root.__sfPickWired) {
      root.__sfPickWired = true;
      root.addEventListener('click', (ev) => {
        // 滑条自己负责拖动/点轨道，不参与“点一下回弹”，否则拖一半会闪一下。
        if (ev.target && ev.target.closest && ev.target.closest('input')) return;
        const t = ev.target && ev.target.closest
          ? ev.target.closest('.uc-tab, .uc-button, .music-toggle, .help-item, .vip-plan') : null;
        if (!t || !root.contains(t) || t.disabled) return;
        f.pick(t);
      }, true);
    }
    return root;
  }

  function systemTabArt(label, active) {
    const stops = active ? ['#e9ffaf', '#a8e363', '#6ca52c'] : ['#fff9a7', '#ffdb54', '#eba611'];
    const edge = active ? '#365d25' : '#704719';
    const image = label === '系统' ? 'system-system-label.svg' :
      label === '帮助' ? 'system-help-label.svg' : 'system-vip-label.svg';
    const glyph = '<img class="system-tab-label" alt="" src="images/ui/buttons/' + image + '">';
    return '<span class="reference-button-label">' + esc(label) + '</span>' +
      '<svg class="system-tab-art" viewBox="0 0 220 76" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="system-tab-' + (active ? 'active' : 'normal') + '" x2="0" y2="1">' +
      '<stop stop-color="' + stops[0] + '"/><stop offset=".5" stop-color="' + stops[1] + '"/><stop offset="1" stop-color="' + stops[2] + '"/></linearGradient></defs>' +
      '<rect x="6" y="6" width="208" height="64" rx="32" fill="url(#system-tab-' + (active ? 'active' : 'normal') + ')" stroke="' + edge + '" stroke-width="11"/>' +
      '</svg>' + glyph;
  }
  function tabs(group, active) {
    const sets = {
      status: [['status','状态'],['weapons','武器'],['skills','技能']],
      challenge: [['challenge','随机'],['friends','好友'],['arena','竞技'],['stages','关卡']],
      message: [['messages','消息'],['chat','聊天'],['ranklog','天梯赛'],['revenge','复仇'],['toplist','排行榜']],
      bag: [['bag','背包'],['shop','商店'],['exchange','兑换']],
      system: [['system','系统'],['help','帮助'],['vip','超级松鼠']]
    };
    const labels=sets[group].map(([id,t])=>{
      const art=group==='system'?systemTabArt(t,id===active):t;
      // 道具页与状态组三颗页签：文字留给读屏，原版矢量图由 `installTabVectors()` 挂进这个壳；
      // 矢量包到达前按钮走 `.classic-tabs .uc-tab` 的金/绿药丸兜底。
      const vector=(group==='bag'||group==='status')?'<span class="tab-art" aria-hidden="true"></span>':'';
      return '<button class="uc-tab '+(id===active?'active':'')+'" data-action="'+id+'" aria-current="'+(id===active?'page':'false')+'">'+art+vector+'</button>';
    }).join('');
    return '<nav class="classic-tabs ' + (sets[group].length > 3 ? 'four' : group==='bag'?'bag-tabs':'') + '" data-group="' + group + '" aria-label="游戏分页">' + labels + (group === 'challenge' ? '<span class="tab-energy">体力 ' + State.state().energy + '/' + State.state().maxEnergy + '</span>' : group==='bag'?'<span class="bag-coins">'+goldIcon()+'<b>'+State.state().goldPoint+'</b></span>':'') + '</nav>';
  }

  function refreshHeader() {
    const S = State.state(); if (!S) return;
    $$('.bag-coins b').forEach((el) => { el.textContent = S.goldPoint; });
    $$('[data-live-gold]').forEach((el) => { el.textContent = S.goldPoint; });
    const home = $('.home-money .num u'); if (home) setNum($('.home-money .num'), S.goldPoint);
  }
  // 原版矢量键：每帧先渲染成静态 SVG 模板再克隆进页面 —— 页面换掉时跟着 DOM 走，
  // 挂载用的临时视图立刻销毁，不留在 SfRender 播放表里。
  // menu=3362「返回菜单」（f1 金=常态/f2 绿=悬停）；arrow=3156 翻页（f3 浅绿/f1 深绿，向右那颗水平镜像）。
  const CHROME_ART = {
    menu: { bundle: 'tags-daoju.json', symbol: '3362', frames: [1, 2] },
    arrow: { bundle: 'tags-daoju.json', symbol: '3156', frames: [1, 3] },
  };
  const chromeArtPromises = Object.create(null);
  function buildArtFrames(spec) {
    if (!window.SfRender || !SfRender.loadExtra || !SfRender.mountSymbol) return Promise.resolve(null);
    return (async () => {
      await SfRender.loadExtra(spec.bundle);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:196px;overflow:hidden;pointer-events:none';
      document.body.appendChild(host);
      try {
        const out = {};
        for (const frame of spec.frames) {
          const cell = document.createElement('div');
          host.appendChild(cell);
          const view = await SfRender.mountSymbol(cell, spec.symbol, { frame });
          let box = null;
          try { box = view.g.getBBox(); } catch (e) { box = null; }
          if (!box || !(box.width > 0) || !(box.height > 0)) { try { view.destroy(); } catch (e) {} return null; }
          const svg = view.g.cloneNode(true);
          svg.removeAttribute('style');
          svg.setAttribute('class', 'vector-art-svg');
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height);
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          out[frame] = svg;
          try { view.destroy(); } catch (e) {}
          cell.remove();
        }
        return out;
      } finally { host.remove(); }
    })();
  }
  function chromeArt(key) {
    if (!chromeArtPromises[key]) {
      chromeArtPromises[key] = buildArtFrames(CHROME_ART[key]).catch((e) => {
        if (window.__errs) window.__errs.push('vector art(' + key + '): ' + (e && e.message));
        return null;
      });
    }
    return chromeArtPromises[key];
  }
  function paintArt(host, frames, frame, mirror) {
    const tpl = frames && frames[frame];
    if (!host || !tpl) return false;
    while (host.firstChild) host.removeChild(host.firstChild);
    const svg = tpl.cloneNode(true);
    if (mirror) { svg.style.transform = 'scaleX(-1)'; svg.style.transformOrigin = 'center'; }
    host.appendChild(svg);
    return true;
  }
  // 页脚键的文案由页面自己决定（塔页会改成「返回」「返回村庄」）；一旦不是「返回菜单」，
  // 带字原版矢量键就撤掉，避免键面 baked 的四个字和真实文案对不上。
  function setHomeLabel(p, text) {
    const home = p && p.querySelector ? p.querySelector('.page-home-btn') : null;
    if (!home) return null;
    const label = home.querySelector('.page-home-label');
    if (label) label.textContent = text;
    if (text !== '返回菜单') {
      home.dataset.vector = '';
      home.__vectorDrop = true;
      const art = home.querySelector('.page-home-art');
      if (art) art.remove();
      home.classList.remove('has-vector-art');
    }
    return home;
  }
  function installVectorChrome(p) {
    if (!p || !p.querySelectorAll) return p;
    installTabVectors(p);
    const home = p.querySelector('.page-home-btn[data-vector="menu"]');
    if (home && !home.__vectorArt) {
      home.__vectorArt = true;
      chromeArt('menu').then((frames) => {
        if (!frames || !home.isConnected || home.__vectorDrop || home.dataset.vector !== 'menu') return;
        const host = home.querySelector('.page-home-art');
        if (!host) return;
        home.classList.add('has-vector-art');
        const idle = () => paintArt(host, frames, 1);
        const over = () => paintArt(host, frames, 2);
        idle();
        home.addEventListener('pointerenter', over);
        home.addEventListener('pointerleave', idle);
      });
    }
    const arrows = [...p.querySelectorAll('.page-arrow .uc-button')].filter((b) => !b.__vectorArt);
    if (!arrows.length) return p;
    chromeArt('arrow').then((frames) => {
      if (!frames) return;
      for (const button of arrows) {
        if (!button.isConnected || button.__vectorArt) continue;
        button.__vectorArt = true;
        let host = button.querySelector('.page-arrow-art');
        if (!host) {
          host = document.createElement('span');
          host.className = 'page-arrow-art';
          host.setAttribute('aria-hidden', 'true');
          button.appendChild(host);
        }
        const wrap = button.closest('.page-arrow');
        const mirror = !(wrap && wrap.classList.contains('prev'));
        // 塔页的武技面板是纯文字「‹ / ›」：矢量到了就把文字节点摘掉，只留 aria-label。
        for (const node of [...button.childNodes]) if (node.nodeType === 3) button.removeChild(node);
        button.classList.add('has-vector-art');
        const idle = () => paintArt(host, frames, 3, mirror);
        const over = () => paintArt(host, frames, 1, mirror);
        idle();
        button.addEventListener('pointerenter', over);
        button.addEventListener('pointerleave', idle);
      }
    });
    return p;
  }
  function page(group, active, content, opts) {
    closeOriginalResult();
    opts = opts || {}; screen = active; activePortrait = null;
    // 重画同一页时别把人弹回页首：先记住旧滚动容器的位置，新页面挂上去后再放回去。
    // 「把存档送过去 / 检查更新」这类原地动作会多次重画系统页 ——
    const oldBoard = (typeof document !== 'undefined')
      ? document.querySelector('#ui .classic-page[data-screen="' + active + '"] > .classic-board') : null;
    const keepTop = oldBoard ? oldBoard.scrollTop : 0;
    const keepLeft = oldBoard ? oldBoard.scrollLeft : 0;
    const old = $('#ui .classic-page'); if (old) old.remove();
    // ⚠ 主页那一层（`.classic-home`；ssflight 经典模式下的村庄页也是它）是整屏的，
    $$('#ui .classic-home').forEach(e => e.remove());
    $$('.classic-modal-overlay').forEach(e => e.remove());
    const p = document.createElement('section'); p.className = 'classic-page' + (opts.pageClass ? ' ' + opts.pageClass : ''); p.dataset.screen = active;
    // 经典二级页自己带底图：不依赖 canvas 是否已经画过首页背景（首次进游戏时 canvas 可能还是黑的）。
    if (currentUiMode() === 'classic') p.classList.add('classic-bg');
    // 经典塔页：不要现代顶部分页横条、不要底部「返回菜单」；由 TowerUI 自己塞一条
    const head = opts.noTabs ? '' : tabs(group, active);
    const homeLabel = opts.homeLabel || '返回菜单';
    // 原版 3362 的键面自带「返回菜单」四个字，只有这种标签才换矢量键；
    // 「返回」等自设文案仍走药丸，免得键面文字和 aria 对不上。
    const homeVector = homeLabel === '返回菜单';
    const homeBtn = '<button type="button" class="uc-button gold page-home-btn"' + (homeVector ? ' data-vector="menu"' : '') +
      ' data-action="home"><span class="page-home-label">' + esc(homeLabel) + '</span>' +
      (homeVector ? '<span class="page-home-art" aria-hidden="true"></span>' : '') + '</button>';
    const foot = opts.noFooter ? '' : '<footer class="page-footer">' + (opts.left || '') + homeBtn + (opts.right || '') + '</footer>';
    p.innerHTML = head + (opts.above || '') + '<div class="classic-board ' + (opts.cls || '') + '">' + content + '</div>' + foot + (opts.counter ? '<span class="page-counter' + (opts.counterPlace === 'board' ? ' in-board' : '') + '">' + opts.counter + '</span>' : '');
    $('#ui').appendChild(p);
    installVectorChrome(p);
    bind(p, Object.assign({}, actions, {home}));
    if(window.Main?.resizeLayout)Main.resizeLayout();
    if (keepTop || keepLeft) {
      const nb = Array.prototype.find.call(p.children, (el) => el && el.classList && el.classList.contains('classic-board'));
      if (nb) { nb.scrollTop = keepTop; nb.scrollLeft = keepLeft; }
    }
    if (!opts.noAccountPrompts) {
      if (window.SfGuide) { try { SfGuide.onPage(active); } catch (e) {} }
      promptLevelUpChoices();
    }
    return p;
  }
  function modal(title, content, buttons, opts) {
    opts = opts || {};
    const wrap = document.createElement('div'); wrap.className = 'classic-modal-overlay';
// locked=true 默认没有关闭叉（必须选完才能继续）；opts.showClose 可单独显示右上角 X。
    // 显式角色优先（可预测）：primary/muted 标记 > cls 里的 gold/muted > 标签语义。
    // 只按「角色」排序、同级保持原顺序，所以顺序完全由 cls 决定，好维护。
    const btnRank = (b, i) => {

      if (b.muted === true) return -2;
      const cls = String(b.cls || '').toLowerCase();
      if (cls.indexOf('muted') >= 0) return -2;
      const label = String(b.label || '');

      if (/返回|取消|关闭|放弃/.test(label)) return -2;
      // 延后/结束类居中偏左：注意它们里含有「继续」（如「稍后继续」），
      // 必须先于主操作规则判断，否则会被误当主操作排到最右。
      if (/稍后|暂不|待会|结束/.test(label)) return -1;
      if (/开始|继续|确定|确认|闯关|挑战|再战|知道了/.test(label)) return 2;
      if (b.primary === true) return 2;
      return 0;
    };
    // 排序会打乱顺序，所以仍然按原索引生成 data-action，保证 bind(map) 的映射不变。
    const orderedIdx = buttons.map((b, i) => ({ b, i }))
      .sort((x, y) => btnRank(x.b, x.i) - btnRank(y.b, y.i) || x.i - y.i)
      .map((x) => x.i);
    const closable = opts.showClose === true || !opts.locked;
    wrap.innerHTML = '<section class="classic-modal ' + (opts.small ? 'small-modal' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><h2 class="modal-title cartoon">' + esc(title) + '</h2>' + (closable ? '<button class="modal-close" aria-label="关闭">×</button>' : '') + '<div class="modal-body">' + content + '</div><div class="modal-buttons">' + orderedIdx.map((i) => btn(buttons[i].label, String(i), buttons[i].cls || '')).join('') + '</div></section>';
    $('#ui').appendChild(wrap);
    const previousFocus = document.activeElement;
    const close = () => {
      wrap.remove();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
      // 弹窗开着时 promptLevelUpChoices() 会直接返回；关掉后补一次，
      // 否则升级三选一/属性点会被这层弹窗永久挡住。
      setTimeout(() => {
        if ($$('.classic-modal-overlay').length) return;
        const pending = typeof State !== 'undefined' &&
          (typeof State.pendingWS === 'function' && State.pendingWS() > 0);
        if (pending) promptLevelUpChoices();
      }, 0);
    };
    const closeBtn = $('.modal-close',wrap);
    if (closeBtn) closeBtn.onclick = close;
    const map = {};
    buttons.forEach((b,i) => { map[i] = () => { if (b.close !== false) close(); if (b.run) b.run(); }; });
    bind(wrap,map);
    $('.modal-buttons button',wrap)?.focus({preventScroll:true});
    if (!opts.locked) promptLevelUpChoices();
    return {close,element:wrap};
  }
  function notice(msg, buttons) { return modal('提示', '<p>' + esc(msg) + '</p>', buttons || [{label:'确定'}], {small:true}); }
  function toast(msg) { legacy.toast(msg); }
  // 转化丸要让人看清「哪个属性转到哪个」；普通道具仍走居中 toast。
  function announcePropResult(r) {
    const msg = (r && (r.msg || (r.gear ? '合成成功：' + r.gear.name : '操作完成'))) || '操作完成';
    if (r && r.ok && r.conversion && legacy && typeof legacy.danmaku === 'function') {
      legacy.danmaku(msg);
      return;
    }
    toast(msg);
  }

  // 转生果解冻前先给玩家看预计等级；服务端只在参数为 confirm 时才真正消耗第二个果实。
  function confirmUnfreezeUse(preview) {
    const p = preview || {};
    const target = Math.max(1, Math.floor(Number(p.level) || 1));
    const levels = Math.max(0, Math.floor(Number(p.levels) || 0));
    const exp = Math.max(0, Math.floor(Number(p.exp) || 0));
    const need = Math.max(1, Math.floor(Number(p.need) || 1));
    const tail = levels > 1 ? '（连升 ' + levels + ' 级，升级奖励会逐级结算）'
      : levels === 1 ? '（升级奖励会结算）' : '（当前经验还不足以升级）';
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const box = modal('转生果 · 恢复等级提升',
        '<p>当前经验 <b>' + exp + '</b> / 本级需要 <b>' + need + '</b></p>' +
        '<p>使用后恢复等级提升，预计升到 <b>' + target + ' 级</b>' + tail + '。</p>',
        [
          { label: '取消', cls: 'muted', run: () => done(false) },
          { label: '确认使用', cls: 'gold', run: () => done(true) },
        ], { small: true });
      const close = box && box.element && box.element.querySelector('.modal-close');
      if (close) close.addEventListener('click', () => done(false), { once: true });
    });
  }

  // 升级奖励统一逐级展示；返回 true 表示结果里有 ups、调用方不要再切页。
  function showUseLevelUps(r, onDone) {
    const ups = r && r.ok && Array.isArray(r.ups) ? r.ups.filter(Boolean) : [];
    if (!ups.length) return false;
    showLevelUps(ups, onDone);
    return true;
  }

  // 「绝大多数时候只有一个深绿色的背景」。复现：经典主页的空壳 `.ssfight-home` 是不透明深绿底
  // （#203a27），`SfUiMain.mount()` 一旦因为素材请求失败 / 超时 throw，空壳留在页面上、里面没有 SVG，
  // 三次都失败就停在复刻主页。成功路径完全不变。
  let forceDomHome = false;
  const CLASSIC_HOME_MOUNT_TIMEOUT_MS = 9000;
  let classicHomeMountSeq = 0;

  function classicHomeHasArt(box) {
    try {
      const svg = box && box.querySelector && box.querySelector('svg');
      return !!(svg && svg.childElementCount > 0);
    } catch (e) { return false; }
  }
  function mountClassicHome(box, attempt) {
    attempt = attempt | 0;
    const seq = ++classicHomeMountSeq;
    const timeoutMs = CLASSIC_HOME_MOUNT_TIMEOUT_MS + attempt * 3000;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('挂载超时')), timeoutMs);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (seq !== classicHomeMountSeq) { resolve(); return; }
        if (!err && !classicHomeHasArt(box)) err = new Error('挂载结果为空');
        if (!err) {
          // 挂载期间壳是隐藏的（不透明深绿底不能盖住 canvas 主页），成了再交给 CSS 正常接管。
          try { box.style.visibility = ''; } catch (e) {}
          try { const dom = $('#ui .classic-home:not(.ssfight-home)'); if (dom) dom.remove(); } catch (e) {}
          resolve(); return;
        }
        if (window.__errs) window.__errs.push('SfUiMain: ' + (err && err.message ? err.message : err));
        if (screen !== 'home' || !box || box.isConnected === false) { resolve(); return; }
        // 空壳必须先摘：它会把 canvas 主界面整块盖住，留着就是「深绿屏」。
        if (!classicHomeHasArt(box)) {
          try { box.remove(); } catch (e) {}
          try { if (window.Main && Main.resumeHomeScene) Main.resumeHomeScene(); } catch (e) {}
        }

        let domHome = $('#ui .classic-home:not(.ssfight-home)');
        if (!domHome) {
          if (attempt === 0) toast('原版主界面加载失败，正在重试…');
          forceDomHome = true;
          try { renderHome(); } catch (e) { if (window.__errs) window.__errs.push('renderHome fallback: ' + (e && e.message)); }
          // 复刻主页是透明的：必须让 canvas 把村庄背景/主角画在它下面。
          try { if (window.Main && Main.resumeHomeScene) Main.resumeHomeScene(); } catch (e) {}
          domHome = $('#ui .classic-home:not(.ssfight-home)');
        }
        if (attempt < 2) {
          setTimeout(() => {
            if (seq !== classicHomeMountSeq || screen !== 'home') { resolve(); return; }
            let host = $('#ui .ssfight-home');
            if (!host) {
              host = document.createElement('section');
              host.className = 'classic-home ssfight-home';
              host.setAttribute('aria-label', '松鼠大战主页');

              host.style.visibility = 'hidden';
              $('#ui').appendChild(host);
            }
            mountClassicHome(host, attempt + 1).then(resolve);
          }, 800 * (attempt + 1));
          return;
        }

        toast('原版主界面加载失败，已切回复刻主页');
        resolve();
      }
      try {
        Promise.resolve(window.SfUiMain.mount(box)).then(() => finish(null), (e) => finish(e || new Error('挂载失败')));
      } catch (e) { finish(e || new Error('挂载失败')); }
    });
  }
  // 页签矢量 / 菜单条 / 翻页箭头都来自 tags-daoju（约 700KB 原始），
  // 主页第一帧用不到；等页面停稳再进空闲队列，别和 tags-home / tags-gear 抢首屏带宽。
  let chromeWarmTimer = 0;
  function scheduleChromeWarm() {
    if (chromeWarmTimer) return;
    const conn = (window.navigator && navigator.connection) || {};
    if (conn.saveData) return;
    chromeWarmTimer = setTimeout(() => {
      chromeWarmTimer = 0;
      const run = () => {
        void preloadTabVectors('bag');
        void chromeArt('menu');
        void chromeArt('arrow');
      };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 5000 });
      else run();
    }, 4000);
  }

  function renderHome() {
    closeOriginalResult();
    screen = 'home'; activePortrait = null;
    const S = State.state();

    if (!forceDomHome && currentUiMode() === 'classic' && window.SfUiMain) {
      // 回主界面 = 把上一棵原版页面收干净。`SfUiMain.mount()` 自己会拆自己那一棵，
      // 但状态页 / 挑战页是并列的两棵树（各自带 1s 重刷），必须在这里一起收掉 ——
      if (window.SfStatus && SfStatus.destroy) { try { SfStatus.destroy(); } catch (e) {} }
      if (window.SfChallenge && SfChallenge.destroy) { try { SfChallenge.destroy(); } catch (e) {} }
      if (window.SfVillage && SfVillage.destroy) { try { SfVillage.destroy(); } catch (e) {} }
      if (window.SfMessage && SfMessage.destroy) { try { SfMessage.destroy(); } catch (e) {} }

      $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠大战主页" style="visibility:hidden"></section>';
      const box = $('#ui .ssfight-home');
      if (box) mountClassicHome(box, 0);

      scheduleChromeWarm();
      promptLevelUpChoices();
      return;
    }
    forceDomHome = false;
    $('#ui').innerHTML = '<section class="classic-home" aria-label="松鼠大战主页"><div class="home-status"><span class="home-name">' + vipBadge() + esc(S.name) + '</span><span class="home-level">' + num(S.level, true) + '</span><span class="energy-label cartoon">体力</span><div class="uc-meter home-energy"><i></i><span class="home-energy-val">' + num(S.energy + '/' + S.maxEnergy, true) + '</span></div></div><div class="home-subbar"><span class="home-exp-label" role="img" aria-label="经验" title="经验">' + '<img alt="" class="home-exp-art" src="images/ui/icons/prop/prop-15.svg">' + '</span><div class="exp-meter"><i></i><span class="home-exp-val">' + num(S.exp + '/' + GData.nextExp(S.level), true) + '</span></div><div class="home-money">' + icon('prop',1) + '<button data-action="shop" aria-label="金松果商店">' + num(S.goldPoint, true) + '</button></div></div><div class="home-buffs" aria-label="生效中的限时用品"></div><div class="home-side"><button class="picture-button' + (dailyAttention() ? ' attention' : '') + '" data-action="daily" aria-label="活动' + (dailyAttention() ? '，有可领取的奖励' : '') + '">' + '<img alt="活动" src="images/ui/home/activity.png">' + '</button></div><button class="village-door" data-action="village" aria-label="村庄"><img alt="" src="images/ui/home/village.png"></button><nav class="home-menu" aria-label="主菜单">' + btn('道具','bag') + btn('状态','status') + btn('开始挑战','challenge','gold') + btn('消息','messages') + btn('系统','system') + '</nav></section>';
    bind($('.classic-home'),actions);buffSignature='';
    refreshHome();
    renderNumbers();
    promptLevelUpChoices();
  }
  function refreshHome() {
    const S = State.state(); if (!S) return;
    const h = $('.classic-home'); if (!h) return;

    if (h.classList && h.classList.contains('ssfight-home')) return;
    State.tickEnergy();
    $('.home-name',h).textContent = S.name;
    setNum($('.home-level .num',h), S.level);
// 药剂可以把体力顶到自然上限之上，这时按上限封顶显示并加个 over 标记。
    const over = S.energy > S.maxEnergy;
    $('.home-energy>i',h).style.width = Math.min(100, 100*S.energy/S.maxEnergy)+'%';
    $('.home-energy',h).classList.toggle('over', over);
    setNum($('.home-energy-val .num',h), S.energy + '/' + S.maxEnergy);
    $('.home-energy',h).title = over
      ? '体力已超过自然上限（' + S.energy + '/' + S.maxEnergy + '），不会自然回复'
      : '每5分钟恢复1点体力' + (State.energyCountdown() ? '，下一点 '+State.energyCountdown() : '');
    const needExp = GData.nextExp(S.level);
    const pct = Math.min(100,100*S.exp/needExp);
    $('.home-subbar .exp-meter>i',h).style.width = pct+'%';
    setNum($('.home-exp-val .num',h), S.exp + '/' + needExp);
    setNum($('.home-money .num',h), S.goldPoint);
    const moneyIcon = $('.home-money img', h); if (moneyIcon) moneyIcon.src = GOLD_ICON;
    const act = $('.home-side [data-action="daily"]', h);
    if (act) {
      const att = dailyAttention();
      if (act.classList.contains('attention') !== att) {
        act.classList.toggle('attention', att);
        act.setAttribute('aria-label', att ? '活动，有可领取的奖励' : '活动');
      }
    }
    const buffBox = $('.home-buffs',h);
    if (buffBox) {
      const states = S.propsStates || {};
      const sig = BUFF_PROPS.map(([id]) => states[id] > 0 ? id + ':' + states[id] : '').join();
      if (sig !== buffSignature) {
        buffSignature = sig;
        buffBox.innerHTML = BUFF_PROPS.filter(([id]) => states[id] > 0).map(([id, desc]) => {
          const prop = propMap.getValue(id);
          return '<span class="home-buff" title="' + esc((prop ? prop.name : '') + '：' + desc + '，剩余 ' + states[id] + ' 场战斗') + '">' + icon('prop', id) + '<i>' + states[id] + '</i></span>';
        }).join('');
      }
    }
  }
  function drawActor(ctx, box, options) {
    options = options || {};
    const player = options.player;
    const animate = !!options.anim;
    const forceLayers = options.forceLayers === true;
    const silhouetteFilter = options.silhouetteBlur ? 'grayscale(1) brightness(1.65) blur(7px)' : 'brightness(0)';
    const silhouetteAlpha = options.silhouetteBlur ? 0.18 : 0.23;
    const classicImage = animate || forceLayers ? null : portraitImage('classic');
    if (classicImage && classicImage.complete && classicImage.naturalWidth) {
      const k = Math.min(box.w/classicImage.width,box.h/classicImage.height);
      const w = classicImage.width*k,h=classicImage.height*k;
      const bob = options.still ? 0 : Math.sin(timer/370)*2;
      ctx.save();
      if(options.silhouette){ctx.filter=silhouetteFilter;ctx.globalAlpha=silhouetteAlpha;}
      ctx.drawImage(classicImage,box.x+(box.w-w)/2,box.y+box.h-h+bob,w,h);
      ctx.restore(); return;
    }
    const name = options.npc ? ({tl:'tl_rest',xh:'xh_rest',xm:'xm_rest'}[options.npc] || 'standby') : (animate ? options.anim : 'standby');
    const frames = Engine.anim(name); if(!frames)return;
    const sheets = options.npc ? ({tl:['tl'],xh:['xh1','xh2'],xm:['xm1','xm2']}[options.npc]) : (animate ? (options.sheets || ['SQ_01','SQ_02']) : ['SQ_01','SQ_02']);
    const frame = frames[options.still || !animate ? 0 : Math.floor(timer/90)%frames.length];

    let bounds = Engine.frameBounds ? Engine.frameBounds(frames[0],{sheets,exclude:['54','75','20001']}) : {x:60,y:320,w:410,h:340};
    // 随机挑战的对手预览：用裸角色包围盒定统一缩放，避免不同装备把角色越撑越小；
    // 但装备本身有外扩，再留一圈固定 padding，否则狂战披风/翅膀会顶出画布。
    if (bounds && options.uniformScale) {
      const pad = 0.19;
      bounds = { x: bounds.x - bounds.w * pad, y: bounds.y - bounds.h * pad,
        w: bounds.w * (1 + pad * 2), h: bounds.h * (1 + pad * 2) };
    }
    if(!bounds || !bounds.w)return;
    const k=Math.min(box.w/bounds.w,box.h/bounds.h);
    const origin={x:(box.x+(box.w-bounds.w*k)/2)/k-bounds.x,y:(box.y+(box.h-bounds.h*k)/2)/k-bounds.y};
    ctx.save();
    if(options.silhouette){ctx.filter=silhouetteFilter;ctx.globalAlpha=silhouetteAlpha;}
    if(player && player.list.length){
      for(const inst of player.list.slice().sort((a,b)=>a.layer-b.layer)){
        Engine.drawFrame(ctx,inst.frames[inst.frame],Object.assign({},inst,{scale:k,x:origin.x,y:origin.y}));
      }
    }else{
      Engine.drawFrame(ctx,frame,{sheets,scale:k,x:origin.x,y:origin.y});
    }
    ctx.restore();
  }
  function heroWalk() {
    const name = (Engine.hasAnim && Engine.hasAnim('mainWalk1')) ? 'mainWalk1' : 'standby';
    return { name: name, sheets: ['SQ_01','SQ_02'] };
  }
  function heroPlayer() {
    return Main.homePlayer ? Main.homePlayer() : null;
  }
  function drawHomeHud(ctx) {
    timer = performance.now();
    if(timer-lastRefresh>700){refreshHome();lastRefresh=timer;}
    if(screen==='home'){
      const walk=heroWalk();
      drawActor(ctx,{x:224,y:239,w:490,h:307},{anim:walk.name,sheets:walk.sheets,player:heroPlayer()});
    }
    if(activePortrait && activePortrait.canvas.isConnected){
      const c=activePortrait.canvas,cx=c.getContext('2d');cx.clearRect(0,0,c.width,c.height);
      drawActor(cx,{x:10,y:6,w:c.width-20,h:c.height-12},activePortrait.options);
    }
    return [{id:'bag',x:22,y:559,w:200,h:114},{id:'status',x:237,y:559,w:200,h:114},{id:'challenge',x:453,y:559,w:276,h:114},{id:'messages',x:746,y:559,w:200,h:114},{id:'system',x:961,y:559,w:200,h:114}];
  }
  function portrait(c,options){activePortrait={canvas:c,options:options||{}};}

  function openStatus() {

    if (currentUiMode() === 'classic' && window.SfStatus && SfStatus.open) {
      screen = 'status'; activePortrait = null;
      $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠状态"></section>';
      const box = $('#ui .ssfight-home');
      if (box) {
        SfStatus.open(box).then(() => {

          if (window.SfGuide) { try { SfGuide.onPage('status'); } catch (e) {} }
        }).catch((e) => {
          if (window.__errs) window.__errs.push('SfStatus: ' + (e && e.message));
          openStatusDom();
        });
        return;
      }
    }
    openStatusDom();
  }
  function openStatusDom(context) {
    const hero = context && context.hero;
    const S=hero ? null : State.state(),st=hero ? heroSourceStats(hero) : State.totalStats(),fights=S ? S.dailyWins+S.dailyFails : 0;
    const fields = hero ? heroStatusFields(hero) : '<div class="status-exp"><span class="home-exp-label">Exp</span><div class="exp-meter"><i style="width:'+Math.min(100,100*S.exp/GData.nextExp(S.level))+'%"></i><span>'+S.exp+'/'+GData.nextExp(S.level)+'</span></div></div><dl class="status-lines"><dt>今日胜率：</dt><dd>'+(fights?Math.round(S.dailyWins/fights*100):0)+'%</dd><dt>战斗场次：</dt><dd>'+(S.allWins+S.allFails)+'</dd></dl><div class="status-buttons">'+btn('更换装备','gears','gold',true)+btn('装备融合','merge','gold')+'</div>';
    const p=page('status','status','<canvas class="status-character" width="497" height="341" aria-label="'+(hero?'勇者':'我的松鼠')+'"></canvas><div class="status-right">'+fields+'</div>'+statsHtml(st, null, hero), hero ? {
      pageClass: 'hero-context-page', homeLabel: '返回', noAccountPrompts: true,
    } : undefined);
    if (hero) {
      if (hero.mode !== 'setup') $('.page-footer',p).insertAdjacentHTML('beforeend',
        '<button type="button" class="status-sell-link" data-action="hero-log">成长记录</button>' +
        '<button type="button" class="status-fusion-link" data-action="hero-blade">勇者之剑</button>');
      return p;
    }
    portrait($('.status-character',p));
    $('.page-footer',p).insertAdjacentHTML('beforeend',
      '<button class="status-sell-link" data-action="gear-sell" aria-label="装备出售：按品质回收背包里的装备"><span class="status-sell-icon" aria-hidden="true"><i class="status-sell-glyph">$</i></span><span class="status-sell-text">装备出售</span></button>' +
      '<button class="status-fusion-link" data-action="merge" aria-label="装备融合：三件同品质装备合成更高品质"><span class="status-fusion-icon" aria-hidden="true"><i class="status-fusion-glyph">⚒</i></span><span class="status-fusion-text">装备融合</span></button>');
    bind(p,{...actions,merge:openMerge,home});
    return p;
  }


  const HERO_PICK_LIMIT = 3;
  const heroLevelText = (level) => {
    const n = Math.max(1, Math.min(15, Math.floor(Number(level) || 1)));
    return n > 10 ? '真' + (n - 10) : 'Lv.' + n;
  };
  function heroSourceStats(hero) {
    const raw = (typeof hero.stats === 'function' ? hero.stats() : hero.stats) || {};
    const maxHp = Math.max(0, Math.round(Number(raw.maxHp != null ? raw.maxHp : raw.hp) || 0));
    return { power: Math.max(0, Math.round(Number(raw.power) || 0)),
      agility: Math.max(0, Math.round(Number(raw.agility) || 0)),
      speed: Math.max(0, Math.round(Number(raw.speed) || 0)), maxHp, hp: maxHp };
  }
  function heroRefItems(hero) {
    const out = [];
    for (const kind of ['weapon', 'skill']) {
      const list = Array.isArray(hero[kind === 'weapon' ? 'weapons' : 'skills'])
        ? hero[kind === 'weapon' ? 'weapons' : 'skills'] : [];
      for (const raw of list) {
        const hit = /^(\d+):(\d+)$/.exec(String(raw));
        if (!hit) continue;
        const id = Number(hit[1]), level = Math.max(1, Math.min(15, Number(hit[2]) || 1));
        const def = kind === 'weapon'
          ? (State.weaponInst ? State.weaponInst(id + ':' + level) : null)
          : (State.skillInst ? State.skillInst(id + ':' + level) : null);
        out.push({ kind, id, level, ref: (kind === 'weapon' ? 'w:' : 's:') + id,
          name: (def && def.name) || ((kind === 'weapon' ? '武器 ' : '技能 ') + id),
          desc: (def && (def.remark || def.desc)) || '' });
      }
    }
    return out;
  }
  function heroCatalogOf(kind) {
    try {
      if (!window.TowerHero || typeof TowerHero.catalog !== 'function') return [];
      return TowerHero.catalog().filter((it) => it.kind === kind);
    } catch (e) { return []; }
  }
  function heroPickRefs(hero) {
    return (Array.isArray(hero.picks) ? hero.picks : []).map((it) => ({ kind: it.kind, id: Number(it.id) }));
  }
  function heroPickKey(it) { return it.kind + ':' + Number(it.id); }
  function heroAppearanceSlots(hero) {
    const slots = [0, 0, 0, 0];
    for (const raw of (Array.isArray(hero.appearance) ? hero.appearance : [])) {
      const item = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
      const id = Number(item.id);
      if (!(id > 0)) continue;
      const type = Number.isFinite(Number(item.type)) ? Number(item.type)
        : (State.gearPart ? State.gearPart(id) : (State.gearInst(id) || {}).type);
      if (Number.isInteger(type) && type >= 0 && type <= 3 && !slots[type]) slots[type] = id;
    }
    return slots;
  }
  function heroStatusFields(hero) {
    const setup = hero.mode === 'setup', picks = heroPickRefs(hero);
    const allocation = setup && typeof hero.statState === 'function' ? hero.statState() : null;
    const pool = Math.max(0, Number(allocation && allocation.pool) || 0);
    const stats = heroSourceStats(hero), hp = hero.hp || {};
    const max = setup ? HERO_PICK_LIMIT : Math.max(1, Number(hp.maxHp) || stats.maxHp);
    const value = setup ? picks.length : Math.max(0, Number(hp.hp) || 0);
    const ready = picks.length === HERO_PICK_LIMIT && pool === 0;
    const coins = Math.max(0, Number(hero.coins) || 0);
    let action = btn(setup ? '开始冒险' : '铸币修炼', setup ? 'hero-start' : 'hero-train', 'gold');
    if (setup ? !ready : coins <= 0) action = action.replace('<button', '<button disabled');

    const lines = setup
      ? '<dt>武技：</dt><dd>' + picks.length + '/' + HERO_PICK_LIMIT + '</dd>' +
        '<dt>四维分配：</dt><dd>' + (pool ? '余' + pool + '点' : '已分配') + '</dd>' +
        '<dt>外观装备：</dt><dd>' + heroAppearanceSlots(hero).filter(Boolean).length + ' 件</dd>'
      : '<dt>累计胜利：</dt><dd>' + Math.max(0, Number(hero.wins) || 0) + '</dd>' +
        '<dt>当前铸币：</dt><dd>' + coins + '</dd>';
    const exp = setup ? '' : '<div class="status-exp"><span class="home-exp-label">生命</span>' +
      '<div class="exp-meter"><i style="width:' + Math.max(0, Math.min(100, value / max * 100)) + '%"></i><span>' + value + '/' + max + '</span></div></div>';
    return exp + '<dl class="status-lines">' + lines + '</dl><div class="status-buttons">' +
      btn('外观装备', 'hero-gear', 'gold', true) + action + '</div>';
  }
  function heroOwnedMap(hero) {
    const map = new Map();
    for (const it of heroPickRefs(hero)) map.set(heroPickKey(it), { kind: it.kind, id: it.id, level: 5 });
    for (const it of heroRefItems(hero)) map.set(heroPickKey(it), {
      kind: it.kind, id: it.id, level: it.level, name: it.name, ref: it.ref });
    return map;
  }
  function heroPageOpen(hero, opts, state) {
    const o = opts || {};
    const tab = state.tab || 'status';
    const context = { hero, state, redraw: () => heroPageOpen(hero, o, state) };
    const p = tab === 'status' ? openStatusDom(context)
      : openCatalog(tab === 'weapons' ? 'weapon' : 'skill', state.pages[tab === 'weapons' ? 'weapon' : 'skill'], context);
    const back = $('[data-action="home"]', p);
    if (back) {
      back.onclick = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); if (hero.onBack) hero.onBack(); else home(); };
    }
    $$('.classic-tabs .uc-tab', p).forEach((b) => {
      const key = b.dataset && b.dataset.action;
      if (key !== 'status' && key !== 'weapons' && key !== 'skills') return;
      b.onclick = () => {
        if (key === state.tab) return;
        state.tab = key;
        heroPageOpen(hero, o, state);
      };
    });
    $$('[data-hero-stat]', p).forEach((b) => {
      b.onclick = () => {
        if (!hero.onAdjustStat) return;
        const parts = String(b.dataset.heroStat || '').split(':');
        const out = hero.onAdjustStat(parts[0], parts[1]);
        if (out && out.ok === false) { toast(out.msg || '无法调整。'); return; }
        heroPageOpen(hero, o, state);
      };
    });
    const start = $('[data-action="hero-start"]', p);
    if (start) {
      start.onclick = () => {
        if (start.disabled) {
          const picks = heroPickRefs(hero).length;
          toast(picks < HERO_PICK_LIMIT ? ('还需点亮 ' + (HERO_PICK_LIMIT - picks) + ' 个武技。') : '先把可分配点分配完。');
          return;
        }
        if (hero.onStart) hero.onStart();
      };
    }
    const gear = $('[data-action="hero-gear"]', p);
    if (gear) gear.onclick = () => {
      if (hero.onEquip) openHeroGears(0, context);
      else if (hero.onGears) hero.onGears();
    };
    const train = $('[data-action="hero-train"]', p);
    if (train) train.onclick = () => openHeroTrainModal(hero, () => heroPageOpen(hero, o, state));
    const log = $('[data-action="hero-log"]', p);
    if (log) log.onclick = () => {
      const lines = (Array.isArray(hero.log) ? hero.log : []).slice(-20).reverse();
      modal('成长记录', '<p>累计胜利 ' + Math.max(0, Number(hero.wins) || 0) + ' 场 · 巡逻胜利 ' +
        Math.max(0, Number(hero.patrolWins) || 0) + ' 场 · 不占上限 ' + Math.max(0, Number(hero.uncapped) || 0) + ' 项</p>' +
        (lines.length ? '<ol>' + lines.map(line => '<li>' + esc(line) + '</li>').join('') + '</ol>' : '<p>每场胜利后获得一次勇者成长。</p>'),
        [{ label: '返回', cls: 'muted' }], { small: true });
    };
    const blade = $('[data-action="hero-blade"]', p);
    if (blade) blade.onclick = () => {
      const info = hero.blade;
      modal('勇者之剑', '<p>' + (info ? '破镜 ×' + Math.max(0, Number(info.stacks) || 0) + '：魔王·镜的力量 −' +
        Math.round(Number(info.powerCut) * 100) + '%、生命上限 −' + Math.round(Number(info.hpCut) * 100) + '%。' :
        '击败巡逻魔王后，断锋会在镜中回应你。') + '</p>', [{ label: '返回', cls: 'muted' }], { small: true });
    };
    const canvas = $('.status-character', p);
    if (canvas) portrait(canvas, { still: true });
    return p;
  }

  function heroGearListOf(hero) {
    if (hero && Array.isArray(hero.gearList) && hero.gearList.length) return hero.gearList;
    const rows = [];
    if (!window.gearMap || typeof gearMap.each !== 'function' || !State.gearInst) return rows;
    gearMap.each((key, row) => {
      const id = Number(row && row.id != null ? row.id : key);
      const gear = State.gearInst(id);
      if (!gear || !Number.isInteger(Number(gear.type))) return;
      rows.push({ id, name: gear.name || ('装备 ' + id), type: Number(gear.type),
        quality: Math.max(0, Math.min(5, Number(gear.quality) || 0)), setId: Number(gear.setId) || 0 });
    });
    rows.sort((a, b) => (b.quality - a.quality) || (a.setId - b.setId) || (a.type - b.type) || (a.id - b.id));
    return rows;
  }

  function heroGearPic(g) {
    const part = ['头', '拳', '衣', '鞋'][Number(g && g.type)] || '装';
    return '<i class="hero-gear-glyph" aria-hidden="true">' + part + '</i>' +
      '<img alt="" src="images/ui/icons/gear/gear-' + Number(g && g.id) + '.png' + ([205, 206, 207, 208].includes(Number(g && g.id)) ? '?v=3' : '') + '" ' +
      'onerror="this.style.display=\'none\';this.parentNode.classList.add(\'missing\')">';
  }

  function repaintHeroStatusAppearance(hero) {
    if (!hero) return;
    const canvas = $('.status-character');
    if (canvas) portrait(canvas, { still: true });
    const count = heroAppearanceSlots(hero).filter(Boolean).length;
    $$('.status-lines dt').forEach((dt) => {
      if (String(dt.textContent || '').indexOf('外观装备') < 0) return;
      const dd = dt.nextElementSibling;
      if (dd) dd.textContent = count + ' 件';
    });
  }

  function openHeroGears(pg, context) {
    const hero = context && context.hero;
    if (!hero) return null;
    const list = heroGearListOf(hero);
    if (!list.length) { notice('装备字典还没有加载。'); return null; }
    const total = Math.max(1, Math.ceil(list.length / 6));
    const page = Math.max(0, Math.min(total - 1, Number(pg) || 0));
    const slotNames = ['头部', '手部', '身体', '脚部'];
    const byId = new Map(list.map((g) => [Number(g.id), g]));
    const slots = heroAppearanceSlots(hero);
    const slotLabel = (g, fallback) => g
      ? '<span class="gear-slot-name q' + Number(g.quality || 0) + '">' + esc(g.name) + '</span>'
      : '<span class="gear-empty">' + fallback + '</span>';
    const slotCell = (part) => {
      const id = Number(slots[part]) || 0, g = id ? byId.get(id) : null;
      return '<button class="catalog-cell" data-hero-gear-slot="' + part + '"' + (g ? '' : ' disabled') +
        ' aria-label="' + slotNames[part] + '：' + (g ? esc(g.name) : '未穿戴') + '">' +
        '<span class="item-icon">' + (g ? heroGearPic(g) : '') + '</span>' + slotLabel(g, slotNames[part]) + '</button>';
    };
    const card = (g) => {
      const id = Number(g.id), used = Number(slots[Number(g.type)]) === id;
      return '<button class="catalog-cell' + (used ? ' selected' : '') + '" data-hero-gear-card="' + id + '"' +
        ' data-gear-type="' + Number(g.type) + '" aria-pressed="' + (used ? 'true' : 'false') + '"' +
        ' title="' + esc(g.name + (g.setLabel ? ' · ' + g.setLabel : '') + ' · ' + (['普通', '优秀', '杰出', '卓越', '传说', '黑色'][g.quality] || '') + '装 · ' + (['头部', '手部', '身体', '脚部'][g.type] || '') + ' · 仅外观') + '">' +
        '<span class="item-icon">' + heroGearPic(g) + (used ? '<span class="equipped-check">✓</span>' : '') + '</span>' +
        '<span class="item-caption q' + Number(g.quality || 0) + '">' + esc(g.name) + '</span></button>';
    };
    const shown = list.slice(page * 6, page * 6 + 6);
    const content = '<p class="gear-note">全部装备均可选；每套四件齐全，仅改变造型，所有属性 0 加成。</p>' +
      '<div class="gear-layout"><div class="gear-slots">' + [0, 1, 2, 3].map(slotCell).join('') + '</div>' +
      '<div class="gear-list">' + shown.map(card).join('') +
        Array.from({ length: 6 - shown.length }, () => '<div class="catalog-cell empty-slot" aria-hidden="true"><span class="item-icon"></span></div>').join('') +
      '</div></div>' +
      '<span class="gear-capacity">共 ' + list.length + ' 件　' + (page + 1) + '/' + total + '</span>' +
      (page > 0 ? '<div class="page-arrow prev">' + btn('‹', 'prev', 'arrow') + '</div>' : '') +
      (page < total - 1 ? '<div class="page-arrow">' + btn('›', 'next', 'arrow') + '</div>' : '');
    const m = modal('外观装备', content, [{ label: '返回', cls: 'gold', run: () => { if (context.redraw) context.redraw(); } }]);
    if (!m || !m.element) return m;
    installVectorChrome(m.element);
    m.element.classList.add('gear-overlay', 'hero-gear-overlay');
    const box = $('.classic-modal', m.element);
    if (box) box.classList.add('gear-modal', 'hero-gear-modal');
    const slotsHost = $('.gear-slots', m.element);
    const paintSlots = () => {
      if (!slotsHost) return;
      slotsHost.innerHTML = [0, 1, 2, 3].map(slotCell).join('');
      $$('[data-hero-gear-slot]', slotsHost).forEach((b) => {
        b.onclick = () => {
          const part = Number(b.dataset.heroGearSlot);
          if (!(Number(slots[part]) > 0)) return;
          slots[part] = 0;
          applySlots();
        };
      });
    };
    const sync = () => {
      paintSlots();
      $$('[data-hero-gear-card]', m.element).forEach((b) => {
        const id = Number(b.dataset.heroGearCard), type = Number(b.dataset.gearType);
        const used = Number(slots[type]) === id;
        b.classList.toggle('selected', used);
        b.setAttribute('aria-pressed', used ? 'true' : 'false');
        const icon = $('.item-icon', b);
        if (!icon) return;
        let check = $('.equipped-check', icon);
        if (used && !check) icon.insertAdjacentHTML('beforeend', '<span class="equipped-check">✓</span>');
        else if (!used && check) check.remove();
      });
    };
    const applySlots = () => {
      const next = slots.slice();
      let out;
      if (typeof hero.onEquip === 'function') out = hero.onEquip(next);
      else if (hero.mode === 'setup') { hero.appearance = next.slice(); out = { ok: true, appearance: next.slice() }; }
      else out = { ok: false, msg: '外观保存失败。' };
      if (!out || out.ok === false) {
        toast((out && out.msg) || '外观保存失败。');
        const old = heroAppearanceSlots(hero);
        for (let i = 0; i < 4; i++) slots[i] = old[i];
        sync();
        return;
      }
      if (out.appearance) hero.appearance = out.appearance;
      else if (hero.mode === 'setup') hero.appearance = next.slice();
      sync();
      repaintHeroStatusAppearance(hero);
    };
    paintSlots();
    $$('[data-hero-gear-card]', m.element).forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.heroGearCard), type = Number(b.dataset.gearType);
        if (!(id > 0) || !Number.isInteger(type)) return;
        slots[type] = Number(slots[type]) === id ? 0 : id;
        applySlots();
      };
    });
    $('[data-action="prev"]', m.element)?.addEventListener('click', () => { m.close(); openHeroGears(page - 1, context); });
    $('[data-action="next"]', m.element)?.addEventListener('click', () => { m.close(); openHeroGears(page + 1, context); });
    return m;
  }

  // 现代勇者页入口：返回 { refresh } 方便换外观层重画时保留当前页签。
  function openHeroPage(hero, opts) {
    if (!hero) return null;
    const state = { tab: (opts && opts.tab) || 'status', pages: { weapon: 0, skill: 0 } };
    const ctrl = {
      refresh: () => { ctrl.element = heroPageOpen(hero, opts || {}, state); return ctrl.element; },
      tab: () => state.tab,
      element: null,
    };
    ctrl.element = heroPageOpen(hero, opts || {}, state);
    return ctrl;
  }

  function openHeroTrainModal(hero, refresh) {
    const refs = heroRefItems(hero).filter((it) => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)));
    if (!refs.length) { toast('没有可修炼的武技。'); return; }
    const coins = Math.max(0, Math.floor(Number(hero.coins) || 0));
    if (coins <= 0) { toast('铸币不足（需要 1 枚）。'); return; }
    const rows = refs.map((it) => {
      const maxed = it.level >= 15;
      return '<button type="button" class="hero-train-row" data-hero-train-ref="' + esc(it.ref) + '"' + (maxed ? ' disabled' : '') + '>' +
        '<span class="hero-train-icon">' + icon(it.kind, it.id, false, false, it.level > 10) + '</span>' +
        '<span class="hero-train-name"><b>' + esc(it.name) + '</b><em>' + heroLevelText(it.level) + ' → ' +
          heroLevelText(Math.min(15, it.level + 3)) + '~' + heroLevelText(Math.min(15, it.level + 5)) + '</em></span>' +
        '<span class="hero-train-cost">1 铸币<br><i>+3~5 级</i></span></button>';
    }).join('');
    const m = modal('铸币修炼', '<div class="hero-train-panel"><p>选择一门武技，必定提升 <b>3~5</b> 个小级（封顶真5）。' +
      '当前铸币 <b class="gold-text">' + coins + '</b> 枚。</p><div class="hero-train-list">' + rows + '</div></div>',
      [{ label: '返回', cls: 'muted' }], { small: true });
    if (m && m.element) {
      m.element.classList.add('hero-train-modal');
      m.element.querySelectorAll('[data-hero-train-ref]').forEach((b) => {
        b.onclick = () => {
          const out = hero.onCoinTrain ? hero.onCoinTrain(b.dataset.heroTrainRef) : { ok: false, msg: '铸币修炼暂不可用。' };
          m.close();
          if (!out || !out.ok) { modal('铸币修炼', '<p>' + esc((out && out.msg) || '修炼失败。') + '</p>', [{ label: '返回', cls: 'muted', run: refresh }], { small: true }); return; }
          modal('修炼完成', '<div class="result-box"><div class="result-title win">武技精进</div><p>' + esc(out.msg) + '</p>' +
            '<p class="dim">消耗 1 枚铸币，剩余 ' + Math.max(0, Number(out.left) || 0) + ' 枚。</p></div>',
            [{ label: '继续修炼', cls: 'gold', run: () => { refresh(); openHeroTrainModal(hero, refresh); } },
             { label: '返回', cls: 'muted', run: refresh }], { small: true });
        };
      });
    }
  }
  function allItems(kind) {
    const a=[];(kind==='weapon'?weaponsMap:skillsMap).each((id,v)=>{if(v&&+id>0)a.push({...v,id:+id});});
    return a.sort((a,b)=>a.id-b.id);
  }

  function catalogInfo(kind, pg) {
    const own = kind === 'weapon' ? State.myWeapons() : State.mySkills();
    const items = allItems(kind);
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.max(0, Math.min(Math.max(0, (pg | 0)), pages - 1));
    const slice = items.slice(page * 10, page * 10 + 10).map((it) => {
      const has = own.find((x) => x.id === it.id) || null;
      return {
        id: it.id, name: it.name, has: !!has,
        level: has ? has.level : 0,
        trueForm: !!has && isTrueGear(has),
        // 原版那一格是不是"当前选中的那一项"：选中决定卡片用绿底那一帧、
        // 也决定卡片下方要不要显示名字（见 js/ssfight/ui-status.js 的 paintCell 四档表）。
        selected: !!has && selectedItems[kind] === it.id,
        label: has ? levelLabel(has.level) : '',
        // `iconRoots()`）。这张表由生成器产出、运行时只读。
        // ⚠ `locked` 是另一颗库元件（名字 + "1"）：原版 `showWeaponSkills`
        icon: wsIconOf(kind, it.id),
        lockedIcon: wsIconOf(kind, it.id, true),
      };
    });
    return { items: slice, page, pages };
  }

  let wsIcons = null, wsIconsTried = false;
  function wsIconOf(kind, id, locked) {
    if (!wsIconsTried) {
      wsIconsTried = true;
      // 同步 XHR：这张表只有几 KB，而且 `catalogInfo` 是同步接口（调用方在渲染循环里）。
      try {
        const x = new XMLHttpRequest();
        x.open('GET', 'images/ssfight/ui/weapon-skill-icons.json', false);
        x.send();
        if (x.status === 200 || x.status === 0) wsIcons = JSON.parse(x.responseText);
      } catch (e) { wsIcons = null; }
    }
    const row = wsIcons && wsIcons[kind] && wsIcons[kind][id];
    if (!row) return null;
    if (locked) return row.locked ? String(row.locked) : String(row.id);
    return String(row.id);
  }
  function openCatalog(kind,pg,context) {
    const hero=context && context.hero,setup=hero && hero.mode==='setup';
    const owned=hero ? heroOwnedMap(hero) : null;
    const own=hero ? Array.from(owned.values()).filter(it=>it.kind===kind)
      : kind==='weapon'?State.myWeapons():State.mySkills();
    const items=hero ? heroCatalogOf(kind) : allItems(kind),total=Math.max(1,Math.ceil(items.length/10)),key=kind==='weapon'?'weapons':'skills';
    const pageNo=Math.max(0,Math.min(Number(pg)||0,total-1));
    if (!hero) catalogPage=pageNo;
    else {
      context.state.pages[kind]=pageNo;
      if (!context.state.selected) context.state.selected={weapon:null,skill:null};
    }
    const shown=items.slice(pageNo*10,pageNo*10+10);
    const cells=shown.map(it=>{
      const has=own.find(x=>x.id===it.id);
      const selected=has && (setup || (hero ? context.state.selected[kind] : selectedItems[kind])===it.id);

      const trueForm = !!has && isTrueGear(has);

      return '<button class="catalog-cell '+(!has?'locked':selected?'selected':'')+(trueForm?' true-form':'')+'" data-item="'+it.id+'"'+
        (hero?' data-hero-cell="'+kind+':'+it.id+'" aria-pressed="'+(selected?'true':'false')+'"':'')+
        ' aria-label="'+esc(it.name)+(has?' '+levelLabel(has.level):' 尚未获得')+'"><span class="item-icon">'+icon(kind,it.id,!has,selected,trueForm)+'</span><span class="item-caption">'+(has?levelLabel(has.level):'')+'</span></button>';
    }).join('')+Array.from({length:10-shown.length},()=>'<div class="catalog-cell empty-slot" aria-hidden="true"><span class="item-icon"></span></div>').join('');
    const options={counter:(pageNo+1)+'/'+total,cls:'collection-board'};
    if (hero) Object.assign(options,{pageClass:'hero-context-page',homeLabel:'返回',noAccountPrompts:true,
      left:'<span class="hero-page-hint">'+(setup?'已点亮 '+heroPickRefs(hero).length+' / '+HERO_PICK_LIMIT+' · 点一下切换':'已掌握 '+own.length+' 项')+'</span>'});
    const p=page('status',key,'<div class="catalog-grid">'+cells+'</div>'+(pageNo?'<div class="page-arrow prev">'+btn('‹','prev','arrow')+'</div>':'')+(pageNo<total-1?'<div class="page-arrow">'+btn('›','next','arrow')+'</div>':''),options);
    $$('[data-item]',p).forEach(b=>b.onclick=()=>{
      const id=+b.dataset.item;
      if (setup) {
        const picks=heroPickRefs(hero),at=picks.findIndex(it=>it.kind===kind && it.id===id);
        if(at>=0)picks.splice(at,1);
        else if(picks.length<HERO_PICK_LIMIT)picks.push({kind,id});
        else {toast('已经点亮 3 个武技；先点暗一个再换。');return;}
        hero.picks=picks;
        if(hero.onPicks)hero.onPicks(picks.map(it=>Object.assign({},it)));
        context.redraw();return;
      }
      if(hero){context.state.selected[kind]=id;context.redraw();}
      else {selectedItems[kind]=id;openCatalog(kind,pageNo);}
      openItem(kind,id,context);
    });
    const turn=next=>{if(hero){context.state.pages[kind]=next;context.redraw();}else openCatalog(kind,next);};
    $('[data-action="prev"]',p)?.addEventListener('click',()=>turn(pageNo-1));
    $('[data-action="next"]',p)?.addEventListener('click',()=>turn(pageNo+1));
    return p;
  }
  function openItem(kind,id,context) {
    const hero=context && context.hero,isW=kind==='weapon',S=hero?null:State.state(),base=(isW?weaponsMap:skillsMap).getValue(id);
    const owned=hero ? heroOwnedMap(hero).get(kind+':'+id) : null;
    const it=hero ? (owned ? (isW?(window.TowerHero&&TowerHero.heroWeapon?TowerHero.heroWeapon(id+':'+owned.level):State.weaponInst(id+':'+owned.level)):State.skillInst(id+':'+owned.level)) : null)
      : (isW?State.myWeapons():State.mySkills()).find(x=>x.id===id);

    const heroUp=hero&&it&&window.TowerHero&&TowerHero.upgradeInfoOf
      ? TowerHero.upgradeInfoOf(hero, (isW?'w:':'s:')+id) : null;
    const up=hero ? heroUp : (it?State.upgradeInfo(kind,id):null);
    const description=base.remark||'';
    const locked=!it;
    const unupgradeable=hero ? !!(up && up.max) : !isW && (base.type==='被动' && up?.max || id===13);
    const extra=isW?'伤害 '+(it?it.harmLo+'-'+it.harmHi:base.harm):'类别 '+esc(base.type);
    const right=hero ? (locked ? '<div class="locked-message">尚未掌握<br><span class="small-label">在塔内学习新的武技</span></div>' :
      unupgradeable ? '<div class="locked-message">该武技<br>不能升级</div>' :
      '<h3>下一级成功率</h3><div><span>成功率</span><b>'+(up&&up.rate!=null?up.rate+'%':'—')+'</b></div>'+
        (up&&up.fails?'<span class="upgrade-pity">失败 '+up.fails+' 次，已加 '+up.fails*3+'%</span>':'')+
        '<p class="small-label">本局勇者武技 · 无法直接升级。</p>') :
      locked?'<div class="locked-message">尚未获得<br><span class="small-label">升级、开启礼包有机会获得</span></div>':up?.max||unupgradeable?'<div class="locked-message">该'+(isW?'武器':'技能')+'<br>不能升级</div>':'<h3>需要　<span class="muted-text">已有</span></h3><div><span>金松果 '+up.coin+'</span><b>'+S.goldPoint+'</b></div><div><span>卷轴 '+up.book+'</span><b>'+(S.props[up.bookId]||0)+'</b></div><span class="upgrade-rate">成功率 '+up.rate+'%'+(up.fails?'<i class="upgrade-pity">（失败 '+up.fails+' 次，已加 '+up.fails*State.UPGRADE_FAIL_BONUS+'%）</i>':'')+'</span>'+(up.isTrue?'<span class="upgrade-true-tip">真化第 '+up.trueAttempt+' 次（当日 24:00 次数与费用清零，真化不吃失败保底）</span>':'')+'<span class="small-label">需要角色 '+up.levelLimit+' 级</span>';
    const content='<div class="item-detail"><div><h3 class="detail-name">'+esc(base.name)+'</h3><div class="detail-summary"><span class="item-icon">'+icon(kind,id,locked,false,isTrueGear(it))+'</span><div class="detail-rows"><span class="detail-row">'+(isW?'阶段':'等级')+' '+(it?levelLabel(it.level,false):1)+(it&&isTrueGear(it)?'（真形态）':'')+'</span><span class="detail-row">'+extra+'</span><span class="detail-row">类型 '+esc(base.type)+'</span></div></div><div class="detail-description">'+esc(description)+(isW&&it?'<br>升至下一阶段额外提升'+esc(base.harmAdd)+'点基础伤害！':'')+'</div></div><div class="detail-upgrade">'+right+'</div></div>';
// 按钮顺序统一成「动作在前、返回在最后」，与其它弹窗一致
    modal(isW?'武器详情':'技能详情',content,[{label:locked?(hero?'尚未掌握':'尚未获得'):(hero?'勇者 · 只读':up?.max||unupgradeable?'不能升级':'立即升级'),cls:locked||up?.max||unupgradeable||hero?'muted':'gold',run:async()=>{
      if(hero||locked||up?.max||unupgradeable)return;
      // 联机版：升级成功率在服务端掷（`doUpgrade` 是 async 动作），必须 await。
      const r=await StateCall('doUpgrade',kind,id);toast(r.msg);openCatalog(kind,catalogPage);openItem(kind,id);
    }},{label:'返回',cls:'muted'}]);
  }

  function openChallenge() {
    if (!window.SfChallenge || !SfChallenge.open) { toast('挑战页还没加载，请刷新后再试。'); return; }
    screen = 'challenge'; activePortrait = null;
    $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠挑战"></section>';
    const box = $('#ui .ssfight-home');
    if (!box) { toast('挑战页加载失败，请刷新后再试。'); return; }
    SfChallenge.open(box).then(() => {
      if (screen === 'challenge' && window.SfGuide) { try { SfGuide.onPage('challenge'); } catch (e) {} }
    }).catch((e) => {
      if (window.__errs) window.__errs.push('SfChallenge: ' + (e && e.message));
      toast('挑战页加载失败，请刷新后重试。');
    });
  }

  function originalFightResult(spec) {
    if (currentUiMode() !== 'classic' || !window.SfFightResult) return false;
    SfFightResult.open(spec).catch(error => toast('战果界面加载失败：' + error.message));
    return true;
  }

  function resultModal(win,rw,extra,onOk,loot) {
    if (originalFightResult({ kind: 'result', title: win ? '战斗胜利' : '再接再厉', win,
      exp: rw.exp, gold: rw.gold || 0, ups: rw.ups, note: extra || '',
      items: (loot && loot.items) || [],
      text: '经验 +' + rw.exp + '　金松果 +' + (rw.gold || 0) + '\n' + (extra || '') + '\n' + upsHtml(rw.ups),
      actions: [{label:'确定',dismiss:true,run:onOk||home},{label:'查看录像',run:()=>openMessages()}] })) return;
    modal('战斗结果','<div class="result-box"><div class="result-title '+(win?'win':'lose')+'">'+(win?'胜 利！':'再接再厉')+'</div><div class="result-lines">经验 +'+rw.exp+'　金松果 +'+(rw.gold||0)+'</div>'+ (extra?'<p>'+esc(extra)+'</p>':'')+upsHtml(rw.ups)+'</div>',[{label:'确定',run:onOk||home},{label:'查看录像',cls:'gold',run:()=>openMessages()}]);
  }
  const NPC_FILE={tl:'mantis',xh:'crane',xm:'panda'};


  function stageUpsHtml(ups) {
    if (!ups || !ups.length) return '';
    return '<div class="reward-stack">' + ups.map(function (u) {
      const gifts = (u.gifts || []).map(function (g) {
        return '<div class="reward-card gift"><span class="reward-icon">' + giftIcon(g.id) + '</span>' +
          '<span class="reward-text">' + esc(g.name) + ' ×' + esc(g.count) + '</span></div>';
      }).join('');
      const rows = (u.reward ? '<div class="reward-card skill"><span class="reward-text">' + esc(u.reward) + '</span></div>' : '')
        + (u.wsChoice ? '<div class="reward-card skill"><span class="reward-icon"><b class="reward-badge ws-badge">选</b></span><span class="reward-text">武器/技能 三选一</span></div>' : '')
        + (u.autoPoint ? '<div class="reward-card point"><span class="reward-icon">' + pointArt(u.autoPoint) + '</span><span class="reward-text">' + STAT_CHAR[u.autoPoint] + '+' + State.STAT_GAIN[u.autoPoint] + '<span class="point-tag">系统分配</span></span></div>' : '')
        + (u.chest ? '<div class="reward-card gift"><span class="reward-icon">' + icon('prop', 90) + '</span><span class="reward-text">金宝箱 ×' + esc(u.chest) + '</span></div>' : '')
        + gifts;
      return '<div class="reward-panel"><div class="reward-level">升到 ' + esc(u.level) + ' 级</div>' +
        (rows ? '<div class="reward-row">' + rows + '</div>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function npcImage(type, elite) {
    const file = NPC_FILE[type.anim];
    return '<img alt="' + esc(type.name) + '" src="images/ui/characters/' + file + (elite ? '-elite-card' : '-classic-card') + '.png">';
  }
  function openStages() {

    const row = (from) => '<div class="npc-select">' + GData.STAGE_TYPES.slice(from, from + 3).map((t, i) => {
      const idx = from + i;
      return (i ? '<span class="npc-arrow">➜</span>' : '') + '<div class="npc-card">' + npcImage(t, !!t.super) + btn('挑战他', 'type' + idx, stageTypeAvailable(idx) ? 'gold small' : 'muted small') + '</div>';
    }).join('') + '</div>';
    const content = row(0) + row(3) + '<div class="npc-description">5级可挑战盖世五侠。依次通过六种难度，才能挑战下一位高手。每轮连续击败3名敌人，收集装备碎片！<br>后三扇门是超级大关：每关只有 1 个敌人，推荐 30 级以上。</div>' + towerEntryHtml();
    const p=page('challenge','stages',content,{cls:'stages-scroll-board'});
    GData.STAGE_TYPES.forEach((_,i)=>{ const b=$('[data-action="type'+i+'"]',p); if(b) b.onclick=()=>openDifficulty(i); });
    $('[data-action="tower-entry"]',p)?.addEventListener('click',()=>openTowerEntry('tower'));
    $('[data-action="endless-entry"]',p)?.addEventListener('click',()=>openTowerEntry('endless'));
  }
  // 无尽挑战塔入口（关卡页下滑可见）：通关前 18 关解锁（与村庄「征战」同一门槛）。
  function towerEntryHtml() {
    if (window.__SSDZ_ONLINE__ || !window.Tower) return '';
    const lock=window.Tower?Tower.unlocked():{ok:false,msg:'数据加载中…'};
    if(!lock.ok)return '<div class="tower-entries"><div class="tower-entry locked"><b>无尽挑战塔</b><span>'+esc(lock.msg)+'</span></div></div>';
    const t=Tower.towerInfo(),e=Tower.endlessInfo();
    return '<div class="tower-entries">'+
      '<button class="tower-entry" data-action="tower-entry"><b>挑战塔</b><span>已通关 '+t.maxLayer+' 层 · 下一层 '+t.nextLayer+'</span><span class="tower-entry-meta">挑战书×1 → 金松果 '+t.gold+'</span></button>'+
      '<button class="tower-entry endless" data-action="endless-entry"><b>无尽模式</b><span>最高分 '+e.best+' · 最深 '+e.bestLayer+' 层</span><span class="tower-entry-meta">免门票 · 赢抽奖卷（现有 '+e.tickets+' 张）</span></button>'+
      '</div>';
  }
  function openTowerEntry(mode) {
    if (window.__SSDZ_ONLINE__) { notice('联机版没有挑战塔/无尽塔。'); return; }
    if ((!window.Tower || !window.TowerUI) && window.TowerLoader) {
      TowerLoader.ensure().then(() => openTowerEntry(mode)).catch(() => notice('无尽塔加载失败，请刷新后重试。'));
      return;
    }
    if(!window.Tower||!window.TowerUI)return;
    const lock=Tower.unlocked();
    if(!lock.ok){notice(lock.msg);return;}
    if(mode==='tower')TowerUI.openTower({from:'stages'});else TowerUI.openEndless({from:'stages'});
  }
  function stageTypeAvailable(t) {
    return [1,2,3,4,5,6].some(st=>State.stageAccess(t*6+st).ok);
  }

  function backToStages(t) {
    if (currentUiMode() === 'classic' && window.SfChallenge && SfChallenge.openAt) {
      // 页面还在树上就直接拨 tab，不要再 `openChallenge()` 重建整页 ——
      const live = SfChallenge.view && SfChallenge.view();
      if (live && live.root && live.root.isConnected) {
        try {
          if (Number.isFinite(t)) SfChallenge.openGateAt(t);
          else SfChallenge.showTab('gates');
        } catch (e) {}
        return;
      }
      SfChallenge.openAt('gates');
      UI.runAction('challenge');
      // ⚠ `openChallenge()` 会先把 `#ui` 换成新的 `.ssfight-home` —— 战斗期间
      if (!classicSsflight()) return;
      if (Number.isFinite(t)) {
        // 直接落到某一扇门的难度页：挂载是异步的，等它挂完再点进去。
        let tries = 0;
        const tick = () => {
          if (window.SfChallenge && SfChallenge.view && SfChallenge.view()) {
            try { SfChallenge.openGateAt(t); } catch (e) {}
            return;
          }
          if (tries++ < 60) setTimeout(tick, 60);
        };
        setTimeout(tick, 60);
      }
      return;
    }
    if (Number.isFinite(t)) openDifficulty(t); else openStages();
  }
  function openDifficulty(t) {
    const type=GData.STAGE_TYPES[t];
    if(!type)return;
    if(!stageTypeAvailable(t)){notice(State.stageAccess(t*6+1).msg);return;}
    const content='<img class="difficulty-portrait" alt="'+type.name+'" src="images/ui/characters/'+NPC_FILE[type.anim]+(type.super?'-elite-card':'-classic-card')+'.png"><h2 class="difficulty-title">请选择难度</h2><div class="difficulty-grid">'+[1,2,3,4,5,6].map(st=>{const id=t*6+st,passed=State.stageProgress(id).passed,run=State.stageRun(id);return '<div class="star-challenge"><div>★ '+st+(passed?'　✓':'')+'</div>'+btn(run?'继续挑战':'挑战他','star'+st,State.stageAccess(id).ok?'small':'small muted')+'</div>';}).join('')+'</div>';
    const p=page('challenge','stages',content,{homeLabel:'返回'});
    $('[data-action="home"]',p).onclick=openStages;
    [1,2,3,4,5,6].forEach(st=>$('[data-action="star'+st+'"]',p).onclick=()=>stageConfirm(t*6+st));
  }
  function stageConfirm(stageId) {
    const access=State.stageAccess(stageId);
    if(!access.ok){notice(access.msg);return;}
    const S=State.state(),type=GData.stageTypeOf(stageId),run=State.stageRun(stageId),idx=run?run.npcIndex:1,npc=State.npcOf(stageId,idx),reward=State.stageReward(stageId);
    const exhausted=run&&run.needsRevive&&run.revives>=2;
    const cost=exhausted?'复活机会已用完':run?(run.needsRevive?'复活需1个挑战书':'不消耗挑战书'):'每轮1个挑战书';

    const dailyCount=State.challengeDailyCount?State.challengeDailyCount():0;
    const dailyPct=Math.round((GData.challengeDailyMul(dailyCount)-1)*100);
    const dailyHint='<br><span class="small-label">今日已通关 '+dailyCount+' 次常驻挑战：敌人全属性（力/敏/速/血）+'+
      (dailyPct>0?('+'+dailyPct+'%'):'+0%')+'（每通关一整次再 +5%，每日 0/12 点重置）</span>';
    const stagePrentice = !(run && (run.masterOnly || run.needsRevive)) ? State.stagePrentice() : null;
    const prenticeHint = stagePrentice
      ? '<br><span class="small-label">出战：徒弟「' + esc(stagePrentice.name) + '」先上阵；徒弟失败后师父再上阵（不消耗挑战书，也不占用复活次数）。</span>'
      : (run && run.masterOnly ? '<br><span class="small-label">本轮由师父上阵（徒弟已败下阵'+(Number.isFinite(run.foeCarryHp)?'，对手保留剩余血量':'')+'）。</span>' : '');
    const text='<div class="mission-guide"><img alt="向导" src="images/ui/characters/master-classic.png"><div>【消耗】：'+cost+'<br>【奖励】：每场经验 '+Array.from({length:GData.stageEnemyCount(stageId)},(_,k)=>GData.stageNpcExp(stageId,k+1)).join('/')+'<br>通关得金松果'+reward.gold+'，每场胜利有几率得碎片<br><span class="small-label">现有挑战书 '+(S.props[23]||0)+' 个</span></div></div><p class="mission-description">'+(GData.isSuperStage(stageId)?'超级大关：本关只有 1 个敌人。':'连续击败3名敌人，后两场战斗不回满血（继承剩余血量并回复25%）。')+'<br>当前对手：'+esc(npc.name)+'（'+idx+'/'+GData.stageEnemyCount(stageId)+'）<br>'+(run?'本轮已复活 '+run.revives+'/2 次。':type.recommend+'。')+prenticeHint+dailyHint+'</p>';
    const buttons=exhausted?[{label:'结束本轮',run:()=>stageAbandon(stageId)}]:[{label:run?(run.needsRevive?'复活再战':'继续战斗'):'开始战斗',run:()=>stageFight(stageId)}];
    buttons.push({label:run?'稍后继续':'返回',cls:'muted'});
    if (typeof originalFightResult === 'function' && originalFightResult({ kind: 'stage', title: '关卡挑战', win: true, text, actions: buttons })) return;
    modal('关卡挑战',text,buttons,{small:true});
  }
  function stageAbandon(stageId) {
    if (typeof originalFightResult === 'function' && originalFightResult({ kind: 'stage', title: '结束本轮',
      text: '结束本轮后，下次需1个挑战书从第一名对手重新开始。已通关的记录会保留。',
      actions: [{label:'结束本轮',run:()=>{State.abandonStageRun(stageId);backToStages(Math.floor((stageId-1)/6));}},
        {label:'继续本轮',dismiss:true,run:()=>stageConfirm(stageId)}] })) return;
    notice('结束本轮后，下次需1个挑战书从第一名对手重新开始。已通关的记录会保留。',[
      {label:'结束本轮',run:()=>{State.abandonStageRun(stageId);backToStages(Math.floor((stageId-1)/6));}},
      {label:'继续本轮',cls:'gold',run:()=>stageConfirm(stageId)}
    ]);
  }
  // 「现在这一屏是原版渲染的经典页吗」：经典模式 + ssfight 渲染层在场。
  // 战斗起止"要不要换页"全靠它判断（见 `stageFight` 的 `keepScreen`）。
  function classicSsflight() {
    return !!(currentUiMode() === 'classic' && window.SfChallenge);
  }
  function stageFight(stageId) {
    // 关卡连战的胜负、经验、金松果、碎片、挑战书与复活次数都在服务端。
    // 服务端一次跑完 begin→simulate→finish，客户端只播结果。
    if (window.Online && window.Online.ready && window.Online.battle) {
      window.Online.battle.stage(stageId, { target: { tab: 'gates', refreshGateAt: Math.floor((Number(stageId) - 1) / 6), keepSub: true } });
      return;
    }
    const started=State.beginStageBattle(stageId);
    if(!started.ok){
      // 没有联机内核时的兜底（以及经典确认页的失败提示）：复活次数用完、或没书复活时必须能
      const run=State.stageRun(stageId);
      const blocked=!!run && (run.needsRevive===true || run.revives>=2);
      const actions=[];
      if(started.needsBook) actions.push({label:'购买',run:()=>openProp(23,true)});
      if(blocked) actions.push({label:'结束本轮',run:()=>stageAbandon(stageId)});
      actions.push({label:'返回',cls:'gold',run:()=>stageConfirm(stageId)});
      notice(started.msg,actions);
      return;
    }
    const npc=State.npcOf(stageId,started.npcIndex),type=GData.stageTypeOf(stageId);
    // 原版 `fightType == 6` 的关卡战斗：徒弟先上阵；徒弟失败后 state 7 再让师父接手。
    // 这里把徒弟快照作为 `fighter` 交给 Main.startBattle，战败时不结算、不扣复活。
    const prenticeFighter = started.role === 'prentice' ? State.stagePrenticeFighter() : null;
    const prenticeRole = !!(started.role === 'prentice' && prenticeFighter);
    const prevRun=State.stageRun(stageId),carryHp=prevRun&&Number.isFinite(prevRun.carryHp)?Math.min(1,prevRun.carryHp+0.25):undefined;
    // 徒弟战败后由师父接手同一名对手：对手的剩余血量按比例带进这一场。
    // maxHp 必须一起给出，否则 Sim 会把当前血量当成上限、血条显示成满血。
    const foeCarryHp=started.role==='master'&&prevRun&&Number.isFinite(prevRun.foeCarryHp)?prevRun.foeCarryHp:null;

    const dailyCount=State.challengeDailyCount?State.challengeDailyCount():0;
    const foe=GData.stageFoe(npc,stageId,type.anim,dailyCount);
    if(foeCarryHp!=null){
      const fullHp=Math.max(1,Math.round(Number(foe.maxHp||foe.hp)||1));
      foe.maxHp=fullHp;
      foe.hp=Math.max(1,Math.round(fullHp*foeCarryHp));
    }
    const gateType=Math.floor((stageId-1)/6);
    const backToStage=()=>backToStages(gateType);

    let heldPage=null;
    try { if (classicSsflight() && window.SfChallenge && SfChallenge.holdPageForBattle) heldPage=SfChallenge.holdPageForBattle(); } catch(e) {}
    const restoreStage=()=>{
      if (heldPage && window.SfChallenge && SfChallenge.resumePageAfterBattle) {

        const keepSub=!!(heldPage.sub&&heldPage.sub.host);
        try {
          if (SfChallenge.resumePageAfterBattle(heldPage,'gates',{keepSub})) {
            try {
              if (keepSub && SfChallenge.refreshGateAt) SfChallenge.refreshGateAt(gateType);
              else SfChallenge.openGateAt(gateType);
            } catch (e) {}
            return true;
          }
        } catch (e) {}
      }
      backToStage();
      return false;
    };
    const interrupted=()=>{State.interruptStageBattle(stageId,started.token);restoreStage();notice('战斗播放中断，本轮进度已保留。重新进入关卡即可继续。');};
    try { Promise.resolve(Main.startBattle(foe,{region:type.anim==='tl'?3:type.anim==='xh'?4:1,kind:'stage',useProps:false,hpRatio:carryHp,skipChest:true,fighter:prenticeFighter||undefined,

      keepScreen: classicSsflight(),
      onError:()=>State.interruptStageBattle(stageId,started.token),
      onEnd:(w,r)=>{
        restoreStage();

        if (prenticeRole && w !== 0) {
          const foeHp=r&&Array.isArray(r.hpAfter)?r.hpAfter[1]:null,foeCap=r&&Array.isArray(r.maxHp)?r.maxHp[1]:0;
          const foeRatio=Number.isFinite(foeHp)&&foeCap>0?Math.max(0,Math.min(1,foeHp/foeCap)):null;
          const ok = State.stagePrenticeLost(stageId, started.token, foeRatio);
          if (ok) stagePrenticeDefeat(stageId, npc, started.npcIndex, started.prentice);
          return;
        }
// 连战按剩余血量比例继承；缺字段时退化为 0，绝不能在这里抛错，
// 否则异常会冒到 Battle 的 onError，把玩家直接丢回主界面且丢掉战果。
        const hp=r&&Array.isArray(r.hpAfter)?r.hpAfter[0]:null,cap=r&&Array.isArray(r.maxHp)?r.maxHp[0]:0;
        const ratio=w===0&&Number.isFinite(hp)&&cap>0?Math.max(0,Math.min(1,hp/cap)):0;
        const rw=State.finishStageBattle(stageId,started.token,w===0,ratio);
        if(!rw.ok)return;
        stageResult(stageId,npc,started.npcIndex,rw);
      }
    })).catch(interrupted); } catch(error) { interrupted(); }
  }

  function stagePrenticeDefeat(stageId, npc, idx, prenticeName) {
    const back = () => backToStages(Math.floor((stageId - 1) / 6));
    const buttons = [
      { label: '师父上阵', cls: 'gold', run: () => stageFight(stageId) },
      { label: '稍后继续', run: back },
    ];
    const text = '<b>徒弟无能，打不过它！该师父您亲自上阵了！</b>' +
      '<br><span class="small-label">徒弟「' + esc(prenticeName || (State.stagePrentice() || {}).name || '徒弟') +
      '」已败下阵；师父接手同一名对手（对方保留剩余血量），不消耗挑战书，也不占用本轮复活次数。</span>';
    if (typeof originalFightResult === 'function' && originalFightResult({
      kind: 'stage', title: '徒弟战败', win: false, text, actions: buttons,
    })) return;
    modal('徒弟战败', '<div class="result-box"><div class="result-title battle-outcome lose">徒弟战败</div><p>' + text + '</p></div>', buttons);
  }
  function stageResult(stageId,npc,idx,rw) {
    const back=()=>backToStages(Math.floor((stageId-1)/6));
    const reward='<div class="result-lines">经验 +'+rw.exp+(rw.complete?'　通关金松果 +'+rw.gold:'')+(rw.chest?'　金宝箱 ×1':'')+'</div>';

    const goldBuffNote=rw.goldBuff?'<p class="small-label">祭坛神秘光芒加成：本次金松果翻倍（+'+rw.goldBase+'）</p>':'';
    let message,buttons;
    if(rw.complete){
      message=GData.isSuperStage(stageId)?'恭喜通关！超级大关的强敌已被击败。':'恭喜通关！三名对手全部击败。';
      buttons=[{label:'继续闯关',run:back},{label:'返回菜单',cls:'muted',run:home}];
    }else if(rw.win){

      message='已击败 '+esc(npc.name)+'（'+idx+'/'+GData.stageEnemyCount(stageId)+'）<br>继续挑战<b>不再消耗挑战书</b><br>下一场不回满血：继承剩余血量并回复 25%';
      buttons=[{label:'继续挑战',run:()=>stageFight(stageId)},{label:'稍后继续',cls:'gold',run:back},{label:'结束本轮',cls:'muted',run:()=>stageAbandon(stageId)}];
    }else{
      const canRevive=rw.run.revives<2;
      message=canRevive?'挑战失败，可花1个挑战书复活自己，继续本轮挑战。剩余复活次数：'+(2-rw.run.revives)+'。':'本轮2次复活机会已用完。结束本轮后可以重新挑战。';
      buttons=canRevive?[{label:'复活再战',run:()=>stageConfirm(stageId)},{label:'稍后继续',cls:'gold',run:back}]:[];
      buttons.push({label:'结束本轮',cls:'muted',run:()=>stageAbandon(stageId)});
    }
    const drop=rw.drop?'<p>获得'+esc(rw.drop.name)+' ×'+rw.drop.count+'</p>':'';
    const gemDrop=rw.gem?'<p>获得'+esc(rw.gem.name)+' ×1</p>':'';

    const levelUpUi = !!(window.SfLevelUp && rw.ups && rw.ups.length);
    if (typeof originalFightResult === 'function' && originalFightResult({ kind: 'stage', title: rw.win ? '关卡胜利' : '关卡失利', win: rw.win,
      ups: rw.ups,
      text: '经验 +' + rw.exp + (rw.complete ? '　通关金松果 +' + rw.gold : '') + '\n' + message + '\n' + drop + gemDrop + goldBuffNote + (levelUpUi ? '' : stageUpsHtml(rw.ups)), actions: buttons })) return;
    modal('关卡战果','<div class="result-box"><div class="result-title battle-outcome '+(rw.win?'win':'lose')+'">'+(rw.win?'胜 利！':'再接再厉')+'</div>'+reward+'<p>'+message+'</p>'+drop+gemDrop+goldBuffNote+stageUpsHtml(rw.ups)+'</div>',buttons);
  }

  // 原版页签矢量：道具页 7180 的 tab/tab1/tab2（7150/7152/7156）、
  // 状态页 7218 的 tab/tab1/tab2（7210/7212/7215）。f1 金皮 = 未选中，f2 绿皮 = 选中；
  // viewBox 用原版画稿的公共尺寸，"状态/武器/技能"三颗才是同一档大小。
  const TAB_VECTOR = {
    bag: {
      bundle: 'tags-daoju.json',
      items: [
        { key: 'bag', id: '7150', viewBox: '-32.6 -1.2 63.2 20.9' },
        { key: 'shop', id: '7152', viewBox: '-58.7 -2.1 63.2 20.9' },
        { key: 'exchange', id: '7156', viewBox: '-32.6 -10.6 63.2 20.9' },
      ],
    },
    status: {
      bundle: 'tags-status.json',
      items: [
        { key: 'status', id: '7210', viewBox: '-6.9 0.2 69.5 20.3' },
        { key: 'weapons', id: '7212', viewBox: '12.35 3.1 69.5 20.3' },
        { key: 'skills', id: '7215', viewBox: '17.9 1.85 69.5 20.3' },
      ],
    },
  };
  const tabArtPromises = Object.create(null);
  async function buildTabVectors(group) {
    const spec = TAB_VECTOR[group];
    if (!spec || !window.SfRender || !SfRender.loadExtra || !SfRender.mountSymbol) return null;
    await SfRender.loadExtra(spec.bundle);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:196px;overflow:hidden;pointer-events:none';
    document.body.appendChild(host);
    try {
      const out = {};
      for (const item of spec.items) {
        out[item.key] = {};
        for (const frame of [1, 2]) {
          const cell = document.createElement('div');
          host.appendChild(cell);
          const view = await SfRender.mountSymbol(cell, item.id, { frame, viewBox: item.viewBox, label: '页签' });
          const svg = view.g.cloneNode(true);
          svg.removeAttribute('style');
          svg.setAttribute('class', 'vector-art-svg');
          svg.setAttribute('aria-hidden', 'true');
          out[item.key][frame] = svg;
          try { view.destroy(); } catch (e) {}
          cell.remove();
        }
      }
      return out;
    } finally { host.remove(); }
  }
  function preloadTabVectors(group) {
    if (!tabArtPromises[group]) {
      tabArtPromises[group] = buildTabVectors(group).catch((e) => {
        if (window.__errs) window.__errs.push(group + ' tab vector: ' + (e && e.message));
        return null;
      });
    }
    return tabArtPromises[group];
  }
  // 把缓存的矢量模板装进当前页的页签；页面被换掉时旧 SVG 跟着 DOM 一起回收。
  function installTabVectors(p) {
    const nav = p && p.querySelector('.classic-tabs[data-group="bag"], .classic-tabs[data-group="status"]');
    if (!nav || nav.__tabArt) return;
    const group = nav.dataset.group;
    const buttons = [...nav.querySelectorAll('.uc-tab')];
    if (!buttons.length) return;
    preloadTabVectors(group).then((art) => {
      if (!art || !nav.isConnected) return;
      nav.__tabArt = art;
      paintTabVectors(nav);
      for (const btn of buttons) {
        if (btn.__tabVectorWired) continue;
        btn.__tabVectorWired = true;
        btn.addEventListener('pointerenter', () => {
          const frames = art[btn.dataset.action];
          if (frames) paintArt(btn.querySelector('.tab-art'), frames, 2);
        });
        btn.addEventListener('pointerleave', () => {
          const frames = art[btn.dataset.action];
          if (frames) paintArt(btn.querySelector('.tab-art'), frames, btn.classList.contains('active') ? 2 : 1);
        });
      }
    });
  }
  function paintTabVectors(nav) {
    const art = nav && nav.__tabArt;
    if (!art) return;
    for (const btn of nav.querySelectorAll('.uc-tab')) {
      const frames = art[btn.dataset.action];
      const host = btn.querySelector('.tab-art');
      if (!frames || !host) continue;
      paintArt(host, frames, btn.classList.contains('active') ? 2 : 1);
      btn.classList.add('has-vector-tab');
    }
  }
  // 页签是就地切 class（不是整页重画）时，调用它把矢量图同步到当前选中态。
  function syncTabVectors(root) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    for (const nav of scope.querySelectorAll('.classic-tabs')) paintTabVectors(nav);
  }

  /* 详情栏的说明是固定高度的滚动区（.bag-description）。安卓没有宋体/雅黑，回退字体更宽，
   * 同一段说明会多折一行、被滚动区切成半行（金杯商店的「超级大力丸」就是这样）。
   * 这里按实际容纳行数把字号从 39 往下收到 24，收到底仍放不下才保留滚动。 */
  function fitDetailDescription(root) {
    const box = root && root.querySelector ? root.querySelector('.bag-detail .bag-description') : null;
    if (!box) return;
    // 同一段文案 + 同一块高度只量一次；逐级 39→24 的写-读循环最多 16 次强制布局。
    const key = (box.textContent || '') + '|' + box.clientWidth + 'x' + box.clientHeight;
    if (box.__fitKey === key) {
      if (box.style.fontSize !== box.__fitSize + 'px') box.style.fontSize = box.__fitSize + 'px';
      return;
    }
    const fits = (size) => { box.style.fontSize = size + 'px'; return box.scrollHeight <= box.clientHeight + 1; };
    let best = 24;
    if (fits(39)) best = 39;
    else if (fits(24)) {
      let lo = 24, hi = 39;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
    }
    box.style.fontSize = best + 'px';
    box.__fitKey = key;
    box.__fitSize = best;
  }
  /* 页脚两颗入口（每日抽奖 / 金杯商店）是定宽胶囊：安卓回退字体比 Windows 宽 1.4~1.5 倍时，
   * 四个字会顶到圆角甚至被裁掉半个字（上下也会顶到白圈）。按实际宽/高把字号从 26 收到 14，
   * 放得下就保持原样（Windows 上不会触发）。 */
  /* 页脚两颗入口（每日抽奖 / 金杯商店）是定宽胶囊。旧安卓 WebView（Chrome<100）在页面缩得很小、
   * 字的实际像素低于约 14px 时，会把文字按 ~1.3 倍**画**出来（布局不变），四个字就顶满胶囊。
   * 这里按「实际渲染像素」判断要不要先除一次 1.3，再按宽/高逐级收到放得下为止。 */
  const OLD_ANDROID_WEBVIEW = (() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const m = /Android/.test(ua) && /Chrome\/(\d+)/.exec(ua);
    return !!(m && Number(m[1]) < 100);
  })();
  function fitEntryPills(root) {
    if (!root || !root.querySelectorAll) return;
    const page = root && root.classList && root.classList.contains('classic-page')
      ? root : (root && root.querySelector ? root.querySelector('.classic-page') : null);
    const scale = page ? page.getBoundingClientRect().width / 1170 : 0;
    for (const pill of root.querySelectorAll('.entry-pill')) {
      pill.style.fontSize = '';
      let size = parseFloat(getComputedStyle(pill).fontSize) || 26;
      if (OLD_ANDROID_WEBVIEW && scale > 0 && size * scale < 14) size = Math.round(size / 1.3);
      pill.style.fontSize = size + 'px';
      while (size > 12 && (pill.scrollWidth > pill.clientWidth + 1 || pill.scrollHeight > pill.clientHeight + 1)) {
        size -= 1;
        pill.style.fontSize = size + 'px';
      }
    }
  }
  function openBag(shop,pg) {
    const exchange=shop==='exchange',mode=shop;shop=shop===true;bagPage=pg||0;
    const S=State.state(),items=[];

    const bagCount=(id)=>State.bagCountOf?State.bagCountOf(id):(S.props[id]||0);
    const bagHas=(id)=>bagCount(id)>0;

    const EXCHANGE_IDS = [24, 25, 26, 45, 46, 51];
    const EXCHANGE_GEMS = [101, 102, 103, 104, 105, 106];
    const EXCHANGE_BLACK_SHARDS = State.blackGearEnabled() ? [77, 78] : [];
    if (exchange) {
      bagPage = Math.max(0, Number(bagPage) || 0);
      for (const id of EXCHANGE_IDS.concat(EXCHANGE_GEMS, EXCHANGE_BLACK_SHARDS)) {
        const v = propMap.getValue(id);
        if (v) items.push({ ...v, id: +id });
      }
    } else {
      propMap.each((id,v)=>{
        if(!State.blackGearEnabled() && State.BLACK_PROP_IDS.includes(+id))return;
        if(shop?v.buy==='true':(bagHas(+id)))items.push({...v,id:+id});
      });
      // 金宝箱已经开出、结果还没领取时，箱子本身已经消耗掉（数量 0）；这里仍把它列进背包，
      // 点进去就是「待领取」的结果，避免玩家离开弹窗后找不到入口（读档也会自动结算）。
      if (!shop && State.chestState && State.chestState() && !items.some((it) => it.id === 90)) {
        const v = propMap.getValue(90);
        if (v) items.push({ ...v, id: 90 });
      }
      items.sort(bagSort);
    }
    const total=Math.max(1,Math.ceil(items.length/6));bagPage=Math.min(bagPage,total-1);
    const shown=items.slice(bagPage*6,bagPage*6+6);
    if(!shown.some(it=>it.id===selectedProp))selectedProp=shown[0]?.id||0;
    function detailMarkup(it) {
      if (!it) return '<h3>背包</h3><div class="bag-description">背包空空的，去商店看看吧！</div>';
      const status=shop?State.purchaseStatus(it.id):null;
      const meta=shop
        ? '售价 '+goldPrice(it.price)+'<br>今日剩余 '+status.remaining+'/'+status.limit
        : '拥有 '+bagCount(it.id)+' 个'+(State.isBagCurrencyProp&&State.isBagCurrencyProp(it.id)?'（货币，天梯赛获得；不能卖也不能使用）':'');

      const sellPrice = !shop && !exchange && currentUiMode() !== 'classic' && State.propSellPrice
        ? State.propSellPrice(it.id) : 0;
      const sell = sellPrice > 0 && bagCount(it.id) > 0
        ? '<button type="button" class="uc-button small gold" data-sell-prop="' + it.id + '">卖出 +' + sellPrice + '</button>'
        : '';
      return '<h3>'+esc(it.name)+'</h3><div class="bag-description">'+esc(it.remark||'')+'</div><div class="bag-item-meta">'+meta+'</div>'+sell;
    }
    const info=detailMarkup(shown.find(it=>it.id===selectedProp));
    const content='<div class="bag-layout"><div class="catalog-grid bag-grid">'+shown.map(it=>'<button class="catalog-cell '+(it.id===selectedProp?'selected':'')+'" data-prop="'+it.id+'" aria-label="'+esc(it.name)+(shop?'，'+it.price+'金松果':'，拥有'+bagCount(it.id)+'个')+'" aria-pressed="'+(it.id===selectedProp)+'"><span class="item-icon">'+icon('prop',it.id,false,it.id===selectedProp)+'</span><span class="item-caption">'+(shop?goldPrice(it.price,esc(it.name)):bagCount(it.id))+'</span></button>').join('')+Array.from({length:6-shown.length},()=>'<div class="catalog-cell empty-slot" aria-hidden="true"><span class="item-icon"></span></div>').join('')+'</div><aside class="bag-detail" aria-live="polite">'+info+'</aside></div>'+(bagPage?'<div class="page-arrow prev">'+btn('‹','prev','arrow')+'</div>':'')+(bagPage<total-1?'<div class="page-arrow bag-next">'+btn('›','next','arrow')+'</div>':'');
    const bagFooter=shop?{left:btn('每日抽奖','lottery','gold entry-pill'),right:btn('金杯商店','rank-shop','gold entry-pill')}:{};
    const p=page('bag',exchange?'exchange':shop?'shop':'bag',content,Object.assign({cls:'classic-bag-board'+(shop?' shop-board':''),pageClass:shop?'shop-entries':'',counter:(bagPage+1)+'/'+total},bagFooter));
    wirePopTaps(p, { tabs: true, cells: true, footer: true, arrows: true });
    // 经典合成入口：碎片 / 种子 / 转化丸 / 宝石点「合成」直接进原版 4886 f5，
    function openPropEntry(id) {
      const classic = !!(UI.currentUiMode && UI.currentUiMode() === 'classic');
      if (!shop && classic && window.SfCompose && SfCompose.isComposeProp(id)) {

        SfCompose.open(id, { onClose: () => { if (!(bagRefresh && bagRefresh())) openBag(mode, bagPage); } });
        return;
      }
      openProp(id, mode);
    }
    function wireDetail() {
      wirePopTaps(p, {});
      const sell = $('[data-sell-prop]', p);
      if (sell) {
        sell.onclick = () => {
          const id = Number(sell.dataset.sellProp);
          const r = State.sellProp(id, 1);
          toast(r.msg);
          if (r.ok) openBag(mode, bagPage);
        };
      }
    }
    function selectProp(id) {
      if (!p.isConnected || !shown.some(it=>it.id===id) || id===selectedProp) return;
      selectedProp=id;
      // 只重画"选中态真的变了"的两格（旧选中/新选中）：其余格子的图标每移动一次都重建
      // 一次 SVG 字符串，是背包悬停的主要开销。
      for (const cell of $$('[data-prop]',p)) {
        const on=+cell.dataset.prop===id;
        if (cell.classList.contains('selected') === on) continue;
        cell.classList.toggle('selected',on);
        cell.setAttribute('aria-pressed',String(on));
        $('.item-icon',cell).innerHTML=icon('prop',+cell.dataset.prop,false,on);
        if(window.SfUiFeedback)SfUiFeedback.bind(cell,{selected:on});
      }
      $('.bag-detail',p).innerHTML=detailMarkup(shown.find(it=>it.id===id));
      wireDetail();
      fitDetailDescription(p);
    }
    $$('[data-prop]',p).forEach(b=>{

      b.addEventListener('pointerenter',()=>selectProp(+b.dataset.prop));
      b.onclick=()=>{
        const id=+b.dataset.prop;
        const choose=()=>{ selectProp(id); openPropEntry(id); };
        if(window.SfUiFeedback)SfUiFeedback.tap(b,choose,{delay:0,press:false});
        else choose();
      };
    });
    wireDetail();
    // 合成结束回背包：就地刷新，不整页重建
    // （实测安卓 WebView 上 100~290 ms 的主线程停顿，连点合成时就是"一下一下地卡"）。
    function refreshBag() {
      if (!p.isConnected) return false;
      const ui = $('#ui');
      if (!ui || !ui.contains(p)) return false;
      const nextItems = [];
      propMap.each((id,v)=>{
        if(!State.blackGearEnabled() && State.BLACK_PROP_IDS.includes(+id))return;
        if(shop?v.buy==='true':bagHas(+id))nextItems.push({...v,id:+id});
      });
      if (!shop && State.chestState && State.chestState() && !nextItems.some((it) => it.id === 90)) {
        const v = propMap.getValue(90);
        if (v) nextItems.push({ ...v, id: 90 });
      }
      if (!shop) nextItems.sort(bagSort);
      const nextShown = nextItems.slice(bagPage*6, bagPage*6+6);
      const nowIds = $$('[data-prop]',p).map(b=>+b.dataset.prop).join(',');
      const nextIds = nextShown.map(it=>it.id).join(',');
      if (nowIds !== nextIds) return false;
      for (const cell of $$('[data-prop]',p)) {
        const id = +cell.dataset.prop;
        const def = nextShown.find(it=>it.id===id);
        if (!def) continue;
        const caption = shop ? goldPrice(def.price, esc(def.name)) : bagCount(id);
        const cap = $('.item-caption',cell);
        if (cap && cap.textContent !== String(caption)) cap.textContent = String(caption);
        cell.setAttribute('aria-label', esc(def.name)+(shop?'，'+def.price+'金松果':'，拥有'+bagCount(id)+'个'));
      }
      if (!nextShown.some(it=>it.id===selectedProp)) selectedProp = nextShown[0]?.id||0;
      const detail = $('.bag-detail',p);
      if (detail) { detail.innerHTML = detailMarkup(nextShown.find(it=>it.id===selectedProp)); wireDetail(); }
      try { refreshHeader(); } catch (e) {}
      return true;
    }
    bagRefresh = refreshBag;
    fitDetailDescription(p);
    fitEntryPills(p);
    $('[data-action="rank-shop"]',p)?.addEventListener('click',()=>ClassicExtras.rankShop(0,'shop'));
    $('[data-action="prev"]',p)?.addEventListener('click',(e)=>popTap(e.currentTarget,()=>openBag(mode,bagPage-1)));
    $('[data-action="next"]',p)?.addEventListener('click',(e)=>popTap(e.currentTarget,()=>openBag(mode,bagPage+1)));
    // 背包页的 f7 必须在整页 DOM 都挂好后再挂引导（page() 里那一次会被后面的重绘吞掉）。
    if (window.SfGuide) { try { SfGuide.onPage('bag'); } catch (e) {} }
  }


  function destroyRankShopBack(page) {
    const view = page && page.__rankBackView;
    if (page) page.__rankBackView = null;
    if (view) { try { view.destroy(); } catch (e) {} }
  }

  function mountRankShopBack(page, onBack) {
    const host = document.createElement('div');
    host.className = 'rank-shop-back';
    host.style.visibility = 'hidden';
    page.appendChild(host);
    const fallback = () => {
      if (!page.isConnected || $('.rank-shop-fallback-footer', page)) return;
      if (host.parentNode) host.remove();
      const foot = document.createElement('footer');
      foot.className = 'page-footer rank-shop-fallback-footer';
      foot.innerHTML = btn('返回', 'rank-shop-fallback', 'gold', true);
      page.appendChild(foot);
      const b = $('[data-action="rank-shop-fallback"]', foot);
      if (b) b.onclick = onBack;
    };
    const mount = () => {
      if (!window.SfRender || !SfRender.mountSymbol) { fallback(); return; }
      SfRender.mountSymbol(host, '3911', { frame: 1, label: '返回' }).then((view) => {
        if (!page.isConnected || !view || !view.g) { if (view) { try { view.destroy(); } catch (e) {} } fallback(); return; }
        let box = null;
        try { box = view.g.getBBox(); } catch (e) { box = null; }
        if (!box || !(box.width > 0) || !(box.height > 0)) {
          try { view.destroy(); } catch (e) {}
          fallback();
          return;
        }
        // 3911 的本地画稿不以 (0,0) 为左上角（实测 bbox 约 -54.8,-9.95,107.4×29.45）。
        // 宿主位置要把 bbox 的负偏移补回去，否则整颗键会往右下跑、还被舞台裁掉。
        view.g.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height);
        host.style.left = ((160.3 + box.x) / 320 * 100).toFixed(4) + '%';
        host.style.top = ((175.5 + box.y) / 196 * 100).toFixed(4) + '%';
        host.style.width = (box.width / 320 * 100).toFixed(4) + '%';
        host.style.height = (box.height / 196 * 100).toFixed(4) + '%';
        host.style.visibility = '';
        page.__rankBackView = view;
        view.g.style.pointerEvents = 'auto';
        view.g.style.cursor = 'pointer';
        view.g.setAttribute('role', 'button');
        view.g.setAttribute('tabindex', '0');
        view.g.setAttribute('aria-label', '返回');
        view.g.style.outline = 'none';
        const hover = (on) => { try { view.gotoAndStop(on ? 2 : 1); } catch (e) {} };
        view.g.addEventListener('pointerenter', () => hover(true));
        view.g.addEventListener('pointerleave', () => hover(false));
        const fire = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } onBack(); };
        view.g.addEventListener('click', fire);
        view.g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
      }).catch(() => fallback());
    };
    if (window.SfRender && SfRender.loadExtra) {
      SfRender.loadExtra('tags-challenge.json').catch(() => {}).then(mount);
    } else {
      mount();
    }
  }

  function openRankShop(pg, origin) {
    const CE = window.ClassicExtras;

    const backTo = origin === 'shop' ? 'shop' : 'ladder';

    destroyRankShopBack(document.querySelector('.rank-shop-page'));
    if (!CE || !CE.rankGoodsList) { toast('金杯商店数据未就绪'); return; }
    const goods = CE.rankGoodsList();
    const total = Math.max(1, Math.ceil(goods.length / 6));
    const pgNo = Math.max(0, Math.min(Number(pg) || 0, total - 1));
    const shown = goods.slice(pgNo * 6, pgNo * 6 + 6);
    if (!shown.some((g) => String(g.id) === String(selectedRankGood))) selectedRankGood = shown[0] ? shown[0].id : 0;
    const S = State.state();
    const iconOf = (g, selected) => icon(g.type === '2' ? 'gear' : 'prop', g.goodsId, false, selected);

    const CUP_ICON = atlasIcon('prop', 40);
    const priceMarkup = (g, detail) => {
      const cup = Math.max(0, Number(g.cup) || 0), gold = Math.max(0, Number(g.gold) || 0);
      const cls = detail ? 'rank-price rank-price-detail' : 'item-caption rank-caption rank-price';
      return '<span class="' + cls + '" role="img" aria-label="售价 ' + cup + ' 金杯、' + gold + ' 金松果">' +
        '<span class="rank-price-part"><b>' + cup + '</b><img class="rank-price-art" src="' + CUP_ICON + '" alt=""></span>' +
        '<span class="rank-price-part"><b>' + gold + '</b><img class="rank-price-art" src="' + GOLD_ICON + '" alt=""></span>' +
        '</span>';
    };
    const limitText = (g) => {
      const lim = CE.rankLimitInfo ? CE.rankLimitInfo(g) : { account: false, monthly: false, limit: Number(g.timesLimit) || 0, bought: Number((S.rankPurchases || {})[g.id]) || 0 };
      if (!(lim.limit > 0)) return '不限兑换次数';
      return (lim.monthly ? '每月限兑 ' : lim.account ? '账号限购 ' : '本周限兑 ') + lim.limit + ' 次（已' + (lim.account ? '购 ' : '兑 ') + lim.bought + '）';
    };
    const detailMarkup = (g) => {
      if (!g) return '<h3>金杯商店</h3><div class="bag-description">本周还没有可兑换的奖励。</div>';
      return '<h3>' + esc(g.name) + '</h3>' +
        '<div class="bag-description">' + esc(g.remark || '') + '</div>' +
        '<div class="bag-item-meta">售价 ' + priceMarkup(g, true) + '<br>' +
          '积分要求 ' + (Number(g.integral) || 0) + '<br>' +
          limitText(g) + '</div>' +
        '<div class="rank-wallet">当前：金杯 ' + (Number(S.goldCup) || 0) + '　金松果 ' + (Number(S.goldPoint) || 0) +
          '　积分 ' + (Number(S.integral) || 0) + '</div>';
    };
    const cells = shown.map((g) => {
      const on = String(g.id) === String(selectedRankGood);
      return '<button class="catalog-cell' + (on ? ' selected' : '') + '" data-rank-good="' + g.id + '" aria-label="' +
        esc(g.name) + '，' + (Number(g.cup) || 0) + ' 金杯 + ' + (Number(g.gold) || 0) + ' 金松果" aria-pressed="' + on + '">' +
        '<span class="item-icon">' + iconOf(g, on) + '</span>' + priceMarkup(g, false) + '</button>';
    }).join('') + Array.from({ length: 6 - shown.length }, () =>
      '<div class="catalog-cell empty-slot" aria-hidden="true"><span class="item-icon"></span></div>').join('');
    const content = '<div class="bag-layout"><div class="catalog-grid bag-grid">' + cells +
      '</div><aside class="bag-detail" aria-live="polite">' +
      detailMarkup(shown.find((g) => String(g.id) === String(selectedRankGood)) || shown[0]) + '</aside></div>' +
      (pgNo ? '<div class="page-arrow prev">' + btn('‹', 'rank-prev', 'arrow') + '</div>' : '') +
      (pgNo < total - 1 ? '<div class="page-arrow bag-next">' + btn('›', 'rank-next', 'arrow') + '</div>' : '');
    const p = page('bag', 'shop', content, {
      cls: 'classic-bag-board shop-board rank-shop-board',
      pageClass: 'rank-shop-page',
      counter: (pgNo + 1) + '/' + total,

      noFooter: true,
    });
    wirePopTaps(p, { tabs: true, cells: true, arrows: true });
    fitDetailDescription(p);
    const leave = () => {
      destroyRankShopBack(p);
      if (backTo === 'shop') {
        try { UI.runAction('shop'); } catch (e) { home(); }
      } else if (window.SfChallenge && SfChallenge.goArenaPage) {
        SfChallenge.goArenaPage('menu');
      } else {
        home();
      }
    };
    mountRankShopBack(p, leave);
    const select = (id) => {
      selectedRankGood = id;
      const g = shown.find((x) => String(x.id) === String(id));
      for (const cell of $$('[data-rank-good]', p)) {
        const on = String(cell.dataset.rankGood) === String(id);
        // ⚠ 每一格用自己的商品图标；以前这里用了当前选中的 `g`，鼠标扫过一格
        const own = shown.find((x) => String(x.id) === String(cell.dataset.rankGood));
        cell.classList.toggle('selected', on);
        cell.setAttribute('aria-pressed', String(on));
        $('.item-icon', cell).innerHTML = own ? iconOf(own, on) : '';
        if (window.SfUiFeedback) SfUiFeedback.bind(cell, { selected: on });
      }
      $('.bag-detail', p).innerHTML = detailMarkup(g);
      fitDetailDescription(p);
    };
    $$('[data-rank-good]', p).forEach((b) => {

      b.addEventListener('pointerenter', () => select(String(b.dataset.rankGood)));
      b.onclick = () => {
        const id = b.dataset.rankGood;
        const choose = () => {
          select(String(id));
          const g = shown.find((x) => String(x.id) === String(id));
          if (g && CE.rankBuy) CE.rankBuy(g.id, () => { try { openRankShop(pgNo, backTo); } catch (e) {} });
        };
        if (window.SfUiFeedback) SfUiFeedback.tap(b, choose, { delay: 0, press: false });
        else choose();
      };
    });
    wirePopTaps(p, {});
    $('[data-action="rank-prev"]', p)?.addEventListener('click', (e) => popTap(e.currentTarget, () => openRankShop(pgNo - 1, backTo)));
    $('[data-action="rank-next"]', p)?.addEventListener('click', (e) => popTap(e.currentTarget, () => openRankShop(pgNo + 1, backTo)));
    return p;
  }
  function openChestDetail(id, shop) {
    const pet = id === 79;
    const name = pet ? '魔法袋' : '金宝箱';

    const magicOdds = [
      '6 级宝石：3%（1 颗）',
      '5 级宝石：15%（1 颗）',
      '蓝色碎片：15%（5~10 个）',
      '召唤证：17%（1~2 个）',
      '金松果：25%（300 / 350 / 400 / 450 / 500）',
      '孵化点：25%（100 点）',
    ];
    const fixedChestPoints = Number(State.CHEST_FIXED_POINTS) || 0;
    const goldOtherOdds = State.chestOtherOdds ? State.chestOtherOdds() : [];
    const onlineChest = fixedChestPoints > 0 && goldOtherOdds.length > 0;
    const oddsSummary = (rows) => rows.map((row) => row.label + ' ' + (row.chance * 100).toFixed(2) + '%').join('、');
    const goldOdds = onlineChest
      ? ['其它奖励（随机 1 件）：' + oddsSummary(goldOtherOdds)]
      : (State.blackGearEnabled()
        ? [
          '6 级宝石：4%（1 颗）',
          '5 级宝石：22%（10% 开出 2 颗，12% 开出 1 颗）',
          '基础属性点：49%（6 点 24%、8 点 14%、10 点 8%、12 点 3%）',
          '金松果：15%（500 / 750 / 1000）',
          '黑色卡片：8%（1 张）',
          '完整黑装：2%（仅首开；凤凰/圣熊 10%、黑狂战 30%、黑怒战 60%）',
        ]
        : [
          '6 级宝石：4%（1 颗）',
          '5 级宝石：22%（10% 开出 2 颗，12% 开出 1 颗）',
          '基础属性点：49%（6 点 24%、8 点 14%、10 点 8%、12 点 3%）',
          '金松果：25%（500 / 750 / 1000）',
        ]);
    const oddsHtml = (rows, title) => '<p class="small-label">' + (title || '打开后随机获得其中一种：') + '</p><p class="small-label">' +
      rows.map((row) => '· ' + row).join('<br>') + '</p>';
    const rewardIcon = (reward) => reward.kind === 'prop' ? icon('prop', reward.id)
      : reward.kind === 'gear' ? icon('gear', reward.id)
        : reward.kind === 'gold' ? goldIcon()
          : reward.kind === 'points' ? '<b class="reward-badge">点</b>'
            : '<b class="reward-badge">蛋</b>';
    const rewardHtml = (reward) => '<div class="detail-summary"><span class="item-icon">' + rewardIcon(reward) + '</span><div>' +
      '<h3 class="detail-name">' + esc(reward.name) + ' ×' + esc(reward.count) + '</h3>' +
      '<div class="detail-description">' + (reward.kind === 'points'
        ? '点「确定领取」后自动随机分配到力/敏/速/生命。'
        : reward.kind === 'gear' ? '点「确定领取」后放入装备栏，可到状态页查看。'
          : '点「确定领取」后入账。') + '</div></div></div>';
    if (pet) {
      const m = modal(name, '<div class="detail-summary"><span class="item-icon">' + icon('prop', id) + '</span><div><h3 class="detail-name">' + name + '</h3>' +
        '<div class="detail-description">使用后有一定几率获得稀有道具：召唤证、5/6 级宝石、蓝色碎片、孵化点或金松果' +
        (State.blackGearEnabled() ? '；<b>额外获得黑色卡片 ×1</b>' : '') + '。</div></div></div>' +
        oddsHtml(magicOdds), [
        { label: '打开', cls: 'gold', run: async () => {
          const r = await StateCall('openChestProp', id);
          m.close();
          if (!r.ok) { toast(r.msg); return; }
          notice(r.msg, [{ label: '确定', run: () => { openBag(!!shop, bagPage); } }]);
          refreshHeader();
        } },
        { label: '取消', cls: 'muted' },
      ], { small: true });
      return;
    }

    const show = (stage) => {
      const state = State.state();
      const pending = State.chestState ? State.chestState() : null;
      if (!pending) {
        const count = Number(state.props[90] || 0);
        const actions = count > 0
          ? [{ label: '打开', cls: 'gold', run: async () => {
            const r = await StateCall('beginChest', 90);
            if (!r.ok) { toast(r.msg); return; }
            show();
          } }, { label: '取消', cls: 'muted' }]
          : [{ label: '确定', cls: 'gold' }];
        modal(name, '<div class="chest-detail"><div class="detail-summary"><span class="item-icon">' + icon('prop', 90) + '</span><div><h3 class="detail-name">' + name + '</h3>' +
          '<div class="detail-description">' + (onlineChest
            ? '固定获得 ' + fixedChestPoints + ' 点基础属性点（自动随机分配），并随机获得 1 件其它奖励；其它奖励池不含属性点。'
            : (State.blackGearEnabled()
              ? '内含基础属性点与高级宝石；原版的黑凤凰/黑圣熊装备在本版未开放，用金松果替代。'
              : '内含基础属性点与高级宝石。')) + '</div></div></div>' +
          oddsHtml(goldOdds, onlineChest ? '打开后：' : undefined) + '<p class="small-label">当前拥有 <b>' + count + '</b> 个；71~90 级每升 1 级获得 1 个。</p></div>',
        actions, { small: true });
        return;
      }
      const points = Number(pending.points) || 0;
      const gain = pending.pointsGain || null;
      const gainRows = [
        ['red', '力量', 16, gain ? Number(gain.power) || 0 : 0],
        ['blue', '敏捷', 17, gain ? Number(gain.agility) || 0 : 0],
        ['green', '速度', 18, gain ? Number(gain.speed) || 0 : 0],
        ['pink', '生命', 19, gain ? Number(gain.hp) || 0 : 0],
      ];
      const gainCards = gainRows.map(([cls, label, iconId, value]) =>
        '<div class="reward-card ' + cls + '"' + (value > 0 ? '' : ' style="opacity:.55"') + '>' +
          '<span class="reward-icon">' + icon('prop', iconId) + '</span>' +
          '<span class="reward-text">' + label + ' +' + value + '</span></div>').join('');
      const gainText = gainRows.filter((row) => row[3] > 0).map((row) => row[1] + '+' + row[3]).join(' / ');
      // 第一页只展示 10 点的实际分配；第二页才是其它奖励。
      if (points > 0 && stage !== 1) {
        const body = gain
          ? '<p><b>基础属性点 ×' + points + '</b>　本次分配</p>' +
            '<div class="reward-row chest-point-row">' + gainCards + '</div>'
          : '<p><b>基础属性点 ×' + points + '</b></p><p class="small-label">本次分配会在领取时随机生成。</p>';
        modal(name, '<div class="chest-detail chest-points-page">' + body + '</div>',
          [{ label: '下一步', cls: 'gold', run: () => show(1) }], { small: true, locked: true });
        return;
      }
      const pointsLine = points > 0
        ? (gain
          ? '<p class="small-label">基础属性点 ×' + points + ' 已分配：' + (gainText || '全部为 0') + '</p>'
          : '<p class="small-label">基础属性点 ×' + points + ' 已在上一页确认。</p>')
        : '';
      const actions = [{ label: '确定领取', cls: 'gold', run: async () => {
        const r = await StateCall('confirmChest');
        if (!r.ok) { toast(r.msg); return; }
        notice(r.msg, [{ label: '确定', run: () => { openBag(!!shop, bagPage); } }]);
        refreshHeader();
      } }];
      modal(name, '<div class="chest-detail">' +
        '<p><b>其它奖励</b></p>' + rewardHtml(pending.reward) + pointsLine + '</div>',
        actions, { small: true, locked: true });
    };
    show();
  }

  function openClassicUseProp(id, base, mode, backMode) {
    let handle = null;
    let using = false;
    let stale = false;
    // 素材失败时才回退 DOM；用户已经离开背包 / 又被另一个道具弹窗替代时不要回退，
    // 否则异步回来会把 DOM 弹窗盖到后来进入的页面上（经典页生命周期的老坑）。
    const canFallback = () => {
      const page = document.querySelector('.classic-page[data-screen="bag"]');
      return !!(!stale && page && page.isConnected && !(window.SfPropUse && SfPropUse.active())
        && UI.currentUiMode && UI.currentUiMode() === 'classic');
    };
    const fallback = () => { if (canFallback()) openProp(id, mode, { forceDom: true }); };
    const useOne = async () => {
      if (using || !handle) return;
      using = true;
      let r = null;
      try { r = await StateCall('useProp', id); }
      catch (e) {
        using = false;
        if (window.__errs) window.__errs.push('prop use: ' + (e && e.message));
        toast('使用失败');
        return;
      }
      if (!r) { using = false; return; }
      if (!r.ok && r.needsUnfreezeConfirm) {
        const ok = await confirmUnfreezeUse(r.preview);
        if (!ok) { using = false; return; }
        try { r = await StateCall('useProp', id, 'confirm'); }
        catch (e) {
          using = false;
          if (window.__errs) window.__errs.push('prop use: ' + (e && e.message));
          toast('使用失败');
          return;
        }
      }
      using = false;
      if (!r) return;
      if (!r.ok && r.needsFruitChoice) { handle.close(); fruitChoiceDialog(r); return; }
      if (!r.ok && r.needsBlackChoice) { handle.close(); blackCardDialog(r); return; }
      if (!r.ok && r.needsBlackGearChoice) { handle.close(); blackGearBoxDialog(r); return; }
      // 属性书不是普通「使用」：State.useProp(37) 需要 8 点分配参数，直接调用只会得到
      // needsAllocation。经典背包的 4886 使用窗必须把玩家接到分配弹窗，否则点了没反应。
      if (!r.ok && r.needsAllocation) { handle.close(); allocateAttributes(); return; }

      if (window.SfGuide && SfGuide.onPropUsed && SfGuide.onPropUsed(id, base.name, r, handle)) return;
      if (!r.ok) { toast(r.msg || '使用失败'); return; }
      announcePropResult(r);
      if (showUseLevelUps(r, () => openBag(backMode, bagPage))) { handle.close(); return; }
      if (id === 1 || id === 2) {
        try { handle.sync(); } catch (e) {}
        try { refreshHeader(); } catch (e) {}
        return;
      }
      handle.close();
      openBag(backMode, bagPage);
    };
    SfPropUse.open(id, {
      onUse: useOne,
      onCancel: () => openBag(backMode, bagPage),
      onStale: () => { stale = true; },
    }).then((h) => {
      if (!h) { fallback(); return; }
      handle = h;

      if (window.SfGuide && SfGuide.onPropDetail) {
        try { SfGuide.onPropDetail(id, mode); } catch (e) {}
      }
    }).catch((e) => {
      if (window.__errs) window.__errs.push('prop use open: ' + (e && e.message));
      fallback();
    });
  }

  function openClassicBuyProp(id, base, mode, backMode) {
    const pageAtOpen = document.querySelector('.classic-page[data-screen="shop"]');
    const status = State.purchaseStatus(id);
    let stale = false;
    SfPropUse.openBuy(id, {
      desc: base.remark || '',
      stock: status.remaining,
      max: Math.max(1, Math.min(50, status.remaining || 1)),
      onBuy: (qty, h) => {
        const r = State.buyProp(id, qty);
        if (!r.ok) {
          toast(r.msg);
          if (h && h.setReason) h.setReason(r.msg);
          return false;
        }
        toast(r.msg);
        refreshHeader();

        const next = State.purchaseStatus(id);
        if (h && h.sync) h.sync({ stock: next.remaining });
        if (next.remaining <= 0 && h && h.setReason) h.setReason('今日已经卖完了，明天再来。');
        return status.limit <= 1;
      },
      onClose: () => {
        if (!stale && pageAtOpen && pageAtOpen.isConnected && pageAtOpen.dataset.screen === 'shop') openBag(true, bagPage);
      },
      onStale: () => { stale = true; },
    }).then((h) => {
      if (h) {
        if (window.SfGuide && SfGuide.onPropDetail) {
          try { SfGuide.onPropDetail(id, mode); } catch (e) {}
        }
        return;
      }

      if (!stale && pageAtOpen && pageAtOpen.isConnected && pageAtOpen.dataset.screen === 'shop') {
        openProp(id, mode, { forceDom: true });
      }
    }).catch((e) => {
      if (window.__errs) window.__errs.push('shop buy window: ' + (e && e.message));
      if (!stale && pageAtOpen && pageAtOpen.isConnected && pageAtOpen.dataset.screen === 'shop') {
        openProp(id, mode, { forceDom: true });
      }
    });
  }

  function openClassicInfoProp(id, base, mode, backMode) {
    const pageAtOpen = document.querySelector('.classic-page');
    let stale = false;
    SfPropUse.openInfo(id, {
      onClose: () => {
        if (!stale && pageAtOpen && pageAtOpen.isConnected) openBag(backMode, bagPage);
      },
    }).then((h) => {
      if (!h && !stale && pageAtOpen && pageAtOpen.isConnected) openProp(id, mode, { forceDom: true });
    }).catch((e) => {
      if (window.__errs) window.__errs.push('prop info window: ' + (e && e.message));
      if (!stale && pageAtOpen && pageAtOpen.isConnected) openProp(id, mode, { forceDom: true });
    });
  }

  function openProp(id,mode,opts) {
    opts=opts||{};
    const shop=mode===true,exchange=mode==='exchange';
    const backMode=shop?true:exchange?'exchange':false;
    const base=propMap.getValue(id),S=State.state();
    if(!base)return;

    if(shop && !opts.forceDom && window.SfPropUse && SfPropUse.openBuy
        && UI.currentUiMode && UI.currentUiMode()==='classic') {
      openClassicBuyProp(id, base, mode, backMode);
      return;
    }
    if(id===79||id===90){ openChestDetail(id,shop); return; }
    const isFragment=[24,25,26].includes(id),isConvertShard=id===GData.CONVERT_SHARD_ID,isSeed=[45,46].includes(id),isGem=State.gemLevel(id)>0,canUse=base.useType==='1';

    if (!shop && !exchange && canUse && !opts.forceDom && window.SfPropUse
        && UI.currentUiMode && UI.currentUiMode() === 'classic') {
      openClassicUseProp(id, base, mode, backMode);
      return;
    }

    const infoOnly = !shop && !canUse && !isFragment && !isSeed && !isConvertShard && !isGem && id !== 37;
    if (infoOnly && !opts.forceDom && window.SfPropUse && SfPropUse.openInfo
        && UI.currentUiMode && UI.currentUiMode() === 'classic') {
      openClassicInfoProp(id, base, mode, backMode);
      return;
    }
    const status=shop?State.purchaseStatus(id):null;
// 注意：用 State.ownedWSCount()（它把「师父驾到」排除在外）——那是拜师剧情赠送的技能，
// 不占武器/技能上限位；旧写法直接加 S.skills.length 会在学了师父驾到后提前显示「已满」。
    const wsNow=State.ownedWSCount?State.ownedWSCount():S.weapons.length+S.skills.length,wsMax=State.wsLimit(),wsFull=wsNow>=wsMax;
    const seedNote=isSeed?('<p class="small-label">武器/技能：<b class="'+(wsFull?'ws-full':'ws-ok')+'">'+wsNow+'/'+wsMax+(wsFull?'（已满，果实仍可合成，等有空位时再使用）':'（未满，可继续获得）')+'</b></p>'):'';
    const shardNote=isConvertShard?('<p class="small-label">当前 <b>'+(S.props[id]||0)+'</b>/'+GData.CONVERT_SHARD_COST+' 个　天梯赛战斗里点飘出来的三角碎片获得</p>'):'';
    const isPotion=!shop&&(id===1||id===2);
    const cap=State.energyHardCap();
    const batchCost=isGem?3:10;
    const batchGold=isGem?10:50;
    const fruitId=(id===45)?47:48;
    const batchName=isFragment?'装备':isSeed?propMap.getValue(fruitId).name:isConvertShard?'转化丸（随机）':'更高一级宝石';
// 每种道具当前能不能再来一次（材料/金币/体力上限），用来说明按钮为什么变灰
    const blockReason=()=>{
      if(shop){
        if(!status.remaining)return '今日已经卖完了，明天再来。';
        if(id===47 && Number(State.state().level) < 30) return '需要达到30级后才可购买此道具！';
        return '';
      }
      const now=(State.state().props[id]||0);
      if(isPotion)return State.state().energy>=cap?'体力已经满了，无法继续使用。':(now<1?'背包里没有体力药剂了。':'');
      if(isFragment||isSeed||isConvertShard){
        if(now<batchCost)return '材料不足：还需要 '+(batchCost-now)+' 个'+base.name+'。';
        if(S.goldPoint<batchGold)return '金松果不足：每次合成需要 '+batchGold+' 个。';
        return '';
      }
      if(isGem){
        if(State.gemLevel(id)>=7)return '七级宝石已是最高等级。';
        if(now<3)return '需要 3 个同级宝石。';
        if(S.goldPoint<10)return '金松果不足 10 个。';
        return '';
      }
      if(canUse)return now<1?'背包里没有这个道具了。':'';
      return '';
    };
    const liveOwn=()=>String(State.state().props[id]||0);
    const potionNote=isPotion?('<p class="small-label">体力：<b data-live="potion" class="'+((S.energy>S.maxEnergy)?'ws-full':'ws-ok')+'">'+S.energy+'/'+S.maxEnergy+'</b>'+
      (S.energy>S.maxEnergy?'（超出部分不自然回复，仍可用于挑战）':'')+'</p>'):'';
    const batchNote=(isFragment||isSeed||isConvertShard||isGem)?('<p class="small-label">每次合成：'+base.name+' ×'+batchCost+' + 金松果 ×'+batchGold+'　→　'+batchName+'</p>'):'';
    const content='<div class="detail-summary"><span class="item-icon">'+icon('prop',id)+'</span><div><h3 class="detail-name">'+esc(base.name)+'</h3><div class="detail-description">'+esc(base.remark||'')+'</div>'+
      '<div class="small-label">拥有 <b data-live="own">'+(State.bagCountOf?State.bagCountOf(id):(S.props[id]||0))+'</b> 个'+(shop?'　售价 '+goldPrice(base.price)+'<br>每日限购 '+status.limit+' 件，今日剩余 <b data-live="stock">'+status.remaining+'</b> 件':'')+'</div></div></div>'+
      seedNote+shardNote+potionNote+batchNote+
      (isGem?'<p class="small-label">3 个同级宝石 + 10 金松果合成高一级，成功率 '+Math.round(State.gemMergeRate(State.gemLevel(id))*100)+'%（0.88 的材料等级次方）；失败有 50% 几率一颗材料降 1 级（1级则碎裂）。</p>':'')+
      '<p class="small-label use-preview" data-live="hint" role="status"></p>';
// 主按钮只在真的有动作时才给；否则会出现「返回」和尾部的「返回」两个按钮
    const label=shop?(status.remaining?'购买':'今日售罄'):isFragment?'合成装备':isConvertShard?'合成转化丸':isSeed?'合成果实':isGem?'合成宝石':id===37?'分配属性':canUse?'使用':'';
    const stayOpen=!shop&&(isPotion||isFragment);
    const keepOpen=stayOpen||(shop&&status&&status.limit!==1);
    const useOne=async()=>{
      if(!shop&&!canUse&&!isFragment&&!isConvertShard&&!isSeed&&!isGem)return;
      if(!shop&&id===37){m.close();allocateAttributes();return;}

      if(!shop&&window.SfCompose&&UI.currentUiMode&&UI.currentUiMode()==='classic'
          &&(isFragment||isSeed||isConvertShard||isGem)){
        m.close();
        SfCompose.open(id,{onClose:()=>openBag(backMode,bagPage)});
        return;
      }
// 注意顺序：宝石要先判断 isGem，否则「使用」类道具（礼包、果实、转生果…）会被当成宝石合成
      // 联机版：购买是 sync（守卫自动上行）；使用/合成/合成宝石含随机数，必须 await 服务端。
      let r=shop?State.buyProp(id,1)
        :isPotion?await StateCall('useProp',id)
        :isFragment?await StateCall('composeGear',id)
        :isSeed?State.composeSeed(id)
        :isConvertShard?await StateCall('composeConvertPill')
        :isGem?await StateCall('mergeGems',id)
        :await StateCall('useProp',id);
      if(!r.ok&&r.needsUnfreezeConfirm){
        const ok=await confirmUnfreezeUse(r.preview);
        if(!ok)return;
        r=await StateCall('useProp',id,'confirm');
      }
      if(!r.ok&&r.needsFruitChoice){m.close();fruitChoiceDialog(r);return;}
      if(!r.ok&&r.needsBlackChoice){m.close();blackCardDialog(r);return;}
      if(!r.ok&&r.needsBlackGearChoice){m.close();blackGearBoxDialog(r);return;}

      if(!shop&&window.SfGuide&&SfGuide.onPropUsed&&SfGuide.onPropUsed(id,base.name,r,m))return;
      announcePropResult(r);
      if(!r.ok)return;
      if(showUseLevelUps(r,()=>openBag(backMode,bagPage))){m.close();return;}
      if(keepOpen){syncLive();return;}
      m.close();
      openBag(backMode,bagPage);
    };
    const buttons=[];
    if(label)buttons.push({label,close:!keepOpen,run:useOne});
    buttons.push({label:'返回',cls:'muted',run:()=>openBag(backMode,bagPage)});
    const m=modal(shop?'道具商店':'道具详情',content,buttons,{small:true});

    if (window.SfGuide && SfGuide.onPropDetail) { try { SfGuide.onPropDetail(id, mode); } catch (e) {} }

    function syncLive(){
      const now=State.state();
      const set=(key,value)=>{const el=$('[data-live="'+key+'"]',m.element);if(el)el.textContent=value;};
      set('own',liveOwn()); set('gold',now.goldPoint);
      if(shop){const st=State.purchaseStatus(id);set('stock',st.remaining);status.remaining=st.remaining;}
      const potion=$('[data-live="potion"]',m.element);
      if(potion){
        potion.textContent=now.energy+'/'+now.maxEnergy;
        potion.className=now.energy>now.maxEnergy?'ws-full':'ws-ok';
        const note=$('[data-live="potion"]',m.element).parentElement;
        const extra=now.energy>now.maxEnergy?'（超出部分不自然回复，仍可用于挑战）':'';
        if(note)note.innerHTML='体力：<b data-live="potion" class="'+(now.energy>now.maxEnergy?'ws-full':'ws-ok')+'">'+now.energy+'/'+now.maxEnergy+'</b>'+extra;
      }
      const reason=blockReason();
      const hint=$('[data-live="hint"]',m.element);
      if(hint){hint.textContent=reason;hint.classList.toggle('full',!!reason);}
      const main=$('[data-action="0"]',m.element);
      if(main){main.disabled=!!reason;if(label)main.textContent=label;}
      if(shop&&!status.remaining)main.disabled=true;
      refreshHeader();
    }
    syncLive();
  }

  function mountVectorButton(footer, symbol, label, onFire, cls) {
    if (!footer) return;
    const host = document.createElement('div');
    host.className = 'sf-vector-button';
    host.style.visibility = 'hidden';
    footer.appendChild(host);
    const fallback = () => {
      if (host.parentNode) host.remove();
      if (!footer.isConnected) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uc-button ' + (cls || '');
      b.textContent = label;
      b.onclick = (e) => { if (e) e.preventDefault(); onFire(); };
      footer.appendChild(b);
    };
    const mount = () => {
      if (!window.SfRender || !SfRender.mountSymbol) { fallback(); return; }
      SfRender.mountSymbol(host, symbol, { frame: 1, label: label }).then((view) => {
        if (!footer.isConnected || !view || !view.g) {
          if (view) { try { view.destroy(); } catch (e) {} }
          fallback();
          return;
        }
        let box = null;
        try { box = view.g.getBBox(); } catch (e) { box = null; }
        if (!box || !(box.width > 0) || !(box.height > 0)) {
          try { view.destroy(); } catch (e) {}
          fallback();
          return;
        }
        view.g.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height);
        view.g.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        view.g.style.width = '100%'; view.g.style.height = '100%';
        view.g.style.pointerEvents = 'auto'; view.g.style.cursor = 'pointer'; view.g.style.outline = 'none';
        view.g.setAttribute('role', 'button');
        view.g.setAttribute('tabindex', '0');
        view.g.setAttribute('aria-label', label);
        host.style.width = '200px';
        host.style.height = Math.max(58, Math.round(200 * box.height / box.width * 100) / 100) + 'px';
        host.style.visibility = '';
        const hover = (on) => { try { view.gotoAndStop(on ? 2 : 1); } catch (e) {} };
        const pressed = (on) => host.classList.toggle('pressed', !!on);
        view.g.addEventListener('pointerenter', () => hover(true));
        view.g.addEventListener('pointerleave', () => { hover(false); pressed(false); });
        view.g.addEventListener('pointerdown', (e) => {
          if (e.button != null && e.button !== 0) return;
          pressed(true);
          try { view.g.setPointerCapture(e.pointerId); } catch (err) {}
        });
        view.g.addEventListener('pointerup', () => pressed(false));
        view.g.addEventListener('pointercancel', () => pressed(false));
        const fire = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } pressed(false); onFire(); };
        view.g.addEventListener('click', fire);
        view.g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
      }).catch(fallback);
    };
    if (window.SfRender && SfRender.loadExtra) SfRender.loadExtra('tags-social-dialog.json').catch(() => {}).then(mount);
    else mount();
  }
  // 天使果实 / 恶魔果实：一次只显示 1 个随机武技（天使=学会，恶魔=遗忘）。
  // 确定在右）。点取消照样消耗果实，只是不改变武技，并把这个武技记进存档，

  function fruitChoiceDialog(r) {
    const isGain = r.mode === 'gain';
    const c = r.options && r.options[0];
    if (!c) return;
    const card = '<div class="ws-choice is-static">' +
      '<span class="item-icon">' + icon(c.kind, c.id) + '</span>' +
      '<b class="ws-choice-name">' + esc(c.name) + '</b>' +
      '<span class="ws-choice-kind">' + (c.kind === 'weapon' ? '武器' : '技能') + (c.type ? ' · ' + esc(c.type) : '') + '</span>' +
      '<span class="ws-choice-desc">' + esc(c.remark || '—') + '</span></div>';
    const tip = (isGain ? '天使果实：这次随机到「' : '恶魔果实：这次随机到「') + esc(c.name) +
      '」（' + (c.kind === 'weapon' ? '武器' : '技能') + '）。' +
      (isGain ? '确定后学会；' : '确定后遗忘（不可撤销）；') +
      '取消不改变武技，但同样<b>消耗</b>这个果实。';
    const body = '<div class="ws-choice-box"><p class="free-point-tip">' + tip + '</p>' +
      '<div class="ws-choice-row few">' + card + '</div></div>';
    const m = modal(isGain ? '天使果实' : '恶魔果实', body, [], { small: true, locked: true });
    m.element.classList.add('ws-choice-dialog');
    const footer = $('.modal-buttons', m.element);
    let busy = false;
    const run = (make) => {
      if (busy) return;
      busy = true;
      make().then((res) => {
        toast(res.msg);
        if (res.ok) { m.close(); openBag(false, bagPage); }
        else busy = false;
      }).catch((e) => { busy = false; toast((e && e.message) || '操作失败'); });
    };
    mountVectorButton(footer, '4419', '取消', () => run(() => StateCall('cancelFruitChoice', r.fruit)));
    mountVectorButton(footer, '4399', '确定', () => run(() => StateCall('applyFruitChoice', r.fruit, c.kind, c.id)), 'gold');
  }

  function blackCardDialog(r) {
    const opts = (r && r.options) || [];
    const body = '<div class="ws-choice-box"><p class="free-point-tip">打开黑色卡片：选择凤凰或圣熊，获得对应碎片 1~2 个，并额外获得 100/200/400 金松果。</p>' +
      '<div class="ws-choice-row' + (opts.length < 3 ? ' few' : '') + '">' +
      opts.map((o) => '<button type="button" class="ws-choice" data-black-set="' + o.setId + '">' +
        '<span class="item-icon">' + icon('prop', o.shardId) + '</span>' +
        '<b class="ws-choice-name">' + esc(o.name) + '</b>' +
        '<span class="ws-choice-kind">黑装碎片</span>' +
        '<span class="ws-choice-desc">已有 ' + (State.state().props[o.shardId] || 0) + ' 个</span></button>').join('') +
      '</div></div>';
    const m = modal('黑色卡片', body, [{ label: '稍后', cls: 'muted' }], { small: true });
    m.element.classList.add('ws-choice-dialog');
    $$('[data-black-set]', m.element).forEach((b) => b.addEventListener('click', async () => {
      const res = await StateCall('useProp', 80, b.dataset.blackSet);
      toast(res.msg);
      if (res.ok) { m.close(); openBag(false, bagPage); }
    }));
  }

  function blackGearBoxDialog(r) {
    const opts = (r && r.options) || [];
    const body = '<div class="ws-choice-box"><p class="free-point-tip">打开黑装自选箱：任选 1 件黑色凤凰/圣熊装备（使用等级 60）。</p>' +
      '<div class="ws-choice-row' + (opts.length < 3 ? ' few' : '') + '">' +
      opts.map((o) => '<button type="button" class="ws-choice" data-black-gear="' + o.id + '">' +
        '<span class="item-icon">' + icon('gear', o.id) + '</span>' +
        '<b class="ws-choice-name">' + esc(o.name) + '</b>' +
        '<span class="ws-choice-kind">' + (o.setId === 71 ? '凤凰' : '圣熊') + '</span>' +
        '<span class="ws-choice-desc">' + ['头部', '手部', '身体', '脚部'][o.type] + '</span></button>').join('') +
      '</div></div>';
    const m = modal('黑装自选箱', body, [{ label: '稍后', cls: 'muted' }], { small: true });
    m.element.classList.add('ws-choice-dialog');
    $$('[data-black-gear]', m.element).forEach((b) => b.addEventListener('click', async () => {
      const res = await StateCall('useProp', 89, b.dataset.blackGear);
      toast(res.msg);
      if (res.ok) { m.close(); openBag(false, bagPage); }
    }));
  }
  // 属性书分配：原版「属性书弹出」3730（`SfPropUse.openAllocate`）。
  // 旧的自绘输入框已删；数字/箭头/确定/返回都在素材里，这里只接 State 动作。
  function allocateAttributes() {
    if (!window.SfPropUse || !SfPropUse.openAllocate) { toast('经典素材未加载，无法分配属性'); return; }
    const page = document.querySelector('.classic-page[data-screen="bag"]');
    let stale = false;
    const S = State.state();
    SfPropUse.openAllocate({
      stats: { power: S.power, agility: S.agility, speed: S.speed },
      onConfirm: async (allocation) => {
        const r = await StateCall('useProp', 37, allocation);
        toast(r.msg);
        return !!r.ok;
      },
      onClose: () => {
        if (!stale && page && page.isConnected) openBag(false, bagPage);
      },
      onStale: () => { stale = true; },
    }).then((h) => {
      if (h) return;
      if (!stale && page && page.isConnected) toast('属性书界面没有加载出来，请重新打开背包再试。');
    }).catch((e) => {
      if (window.__errs) window.__errs.push('attr book: ' + (e && e.message));
      toast('属性书界面打开失败');
    });
  }
  // 到 WS_LEVELS 的等级时发一组候选（最多 3 个），必须在弹窗里选一个才继续。
  let wsRandomPending = false;
  function wsChoiceDialog() {
    if (typeof State.pendingWS !== 'function' || State.pendingWS() <= 0) return null;
    if ($$('.classic-modal-overlay').some(o => o.querySelector('.ws-choice-box'))) return null;
    const list = State.currentWSChoices();
    if (!list.length) {
      if (!wsRandomPending) {
        wsRandomPending = true;
        StateCall('chooseWSRandom').then(() => {
          wsRandomPending = false;
          promptLevelUpChoices();
        }, e => { wsRandomPending = false; toast(e && e.message || '选择失败，请重试'); });
      }
      return null;
    }
    const card = (c, i) => '<button type="button" class="ws-choice" data-ws-pick="' + i + '">' +
      '<span class="item-icon">' + icon(c.kind, c.id) + '</span>' +
      '<b class="ws-choice-name">' + esc(c.name) + '</b>' +
      '<span class="ws-choice-kind">' + (c.kind === 'weapon' ? '武器' : '技能') + (c.type ? ' · ' + esc(c.type) : '') + '</span>' +
      '<span class="ws-choice-desc">' + esc(c.remark || '—') + '</span></button>';
    const body = '<div class="ws-choice-box"><p class="free-point-tip">升级奖励：从下面' + list.length + ' 个里选一个学会（' +
      (State.pendingWS() > 1 ? '还有 ' + (State.pendingWS() - 1) + ' 组在后面等着' : '最后一组') + '）。</p>' +
      '<div class="ws-choice-row' + (list.length < 3 ? ' few' : '') + '">' + list.map(card).join('') + '</div></div>';
    const m = modal('选择武器或技能', body, [
      { label: State.pendingWS() > 1 ? '全部随机' : '随便来一个', cls: 'muted', close: false, run: async () => {
        if (wsRandomPending) return;
        wsRandomPending = true;
        const controls = $$('button', m.element);
        controls.forEach(b => { b.disabled = true; });
        try {
          const r = await StateCall('chooseWSRandom');
          if (r && r.ok) refresh();
          else toast(r && r.msg || '选择失败');
        } catch (e) { toast(e && e.message || '选择失败，请重试'); }
        finally {
          wsRandomPending = false;
          controls.forEach(b => { b.disabled = false; });
        }
      } },
    ], { small: true, locked: true });
    m.element.classList.add('ws-choice-dialog');
    const refresh = () => {
      if (State.pendingWS() > 0 && State.currentWSChoices().length) {
        const next = State.currentWSChoices();
        m.element.querySelector('.modal-body').innerHTML = '<div class="ws-choice-box"><p class="free-point-tip">升级奖励：从下面' + next.length + ' 个里选一个学会（' +
          (State.pendingWS() > 1 ? '还有 ' + (State.pendingWS() - 1) + ' 组在后面等着' : '最后一组') + '）。</p>' +
          '<div class="ws-choice-row' + (next.length < 3 ? ' few' : '') + '">' + next.map(card).join('') + '</div></div>';
        bindPicks();
        return;
      }
      m.close();
      promptLevelUpChoices();
    };
    function bindPicks() {
      $$('[data-ws-pick]', m.element).forEach(b => b.addEventListener('click', () => {
        const c = State.currentWSChoices()[Number(b.dataset.wsPick)];
        if (!c) return;
        const r = State.chooseWS(c.kind, c.id);
        if (r.ok) toast('学会了【' + r.name + '】');
        else toast(r.msg || '选择失败');
        refresh();
      }));
    }
    bindPicks();
    return m;
  }

  function battleUiBusy() {
    try {
      if (window.Main && typeof Main.isBattle === 'function' && Main.isBattle()) return true;
      return !!(document.querySelector && document.querySelector('[aria-label="跳过战斗"],[aria-label="切换战斗速度"]'));
    } catch (e) { return false; }
  }
  // 升级奖励的统一入口：必选的「三选一」优先，其次 30 级支持作者提示。
  function promptLevelUpChoices() {
    if($('.ws-choice-dialog'))return null;
    // 升级奖励弹窗自己会接三选一；它开着时不要在外面再叠一层。
    if (window.SfLevelUp && typeof SfLevelUp.isOpen === 'function' && SfLevelUp.isOpen()) return null;
    // 战斗中、战果页和未收起的升级页都不能叠三选一；等它们收掉后由看门狗补弹。
    if (battleUiBusy()) return null;
    if (window.SfFightResult && typeof SfFightResult.isOpen === 'function' && SfFightResult.isOpen()) return null;
    if (document.querySelector && document.querySelector('#ui .sf-levelup-view:not(.sf-levelup-bg-only)')) return null;
    // 任何别的经典弹窗还开着都不要叠新的升级弹窗；关掉后 `modal()` 会再调一次。
    if($('.classic-modal-overlay'))return null;
    if(typeof State.pendingWS==='function'&&State.pendingWS()>0){
      if (window.SfLevelUp && typeof SfLevelUp.sync === 'function') { SfLevelUp.sync(); return null; }
      return wsChoiceDialog();
    }
    if (State.supportPromptPending && State.supportPromptPending() && maybeSupportPrompt()) {

      const tick = () => {
        if ($('.classic-modal-overlay')) { setTimeout(tick, 120); return; }
        promptLevelUpChoices();
      };
      setTimeout(tick, 150);
      return null;
    }
    maybeSupportPrompt();

    if (window.SfLevelUp && SfLevelUp.releaseBackground) SfLevelUp.releaseBackground();
    return null;
  }

  // 武技三选一是存档里的待办（`wsPicks`），不是一次性弹窗：战斗清屏、换页、
  // 战果页把它顶掉后，只要还没选，回到可展示的页面就补弹；战斗中不弹。
  let pendingChoiceWatch = 0;
  function watchPendingChoices() {
    if (pendingChoiceWatch || typeof setInterval !== 'function') return;
    pendingChoiceWatch = setInterval(() => {
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (typeof State === 'undefined' || typeof State.pendingWS !== 'function' || State.pendingWS() <= 0) return;
        if (document.querySelector('.ws-choice-dialog')) return;
        if (battleUiBusy()) return;
        if (window.SfFightResult && typeof SfFightResult.isOpen === 'function' && SfFightResult.isOpen()) return;
        if (document.querySelector('#ui .sf-levelup-view:not(.sf-levelup-bg-only)')) return;
        if (document.querySelector('.classic-modal-overlay')) return;
        if (!document.querySelector('#ui .classic-home, #ui .classic-page')) return;
        promptLevelUpChoices();
      } catch (e) {}
    }, 600);
    if (pendingChoiceWatch && typeof pendingChoiceWatch.unref === 'function') pendingChoiceWatch.unref();
  }
  watchPendingChoices();

  // 升级奖励的公共出口：任何拿到 `ups` 的流程都走这里。优先原版 7795 升级页，
  // 挂不出来就退回升级奖励卡弹窗 —— 不能因为素材/页面失败让玩家看不到属性增量。
  function showLevelUps(ups, onDone) {
    const list = (ups || []).filter(Boolean);
    if (!list.length) { if (onDone) onDone(); return false; }
    let closed = false, fallbackOpen = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      promptLevelUpChoices();
      if (onDone) onDone();
    };
    const fallback = () => {
      if (closed || fallbackOpen) return;
      fallbackOpen = true;
      modal('升级奖励', upsHtml(list), [{ label: '确定', run: finish }], { small: true });
    };
    if (currentUiMode() === 'classic' && window.SfLevelUp) {
      try { SfLevelUp.open(list, finish, fallback); return true; } catch (e) { fallback(); return true; }
    }
    fallback();
    return true;
  }

  function gearImg(g) {

    return '<img alt="" src="images/ui/icons/gear/gear-'+g.id+'.png'+([205, 206, 207, 208].includes(Number(g.id)) ? '?v=3' : '')+'" onerror="this.style.visibility=\'hidden\'">';
  }

  function openGears() {
    const S = State.state();
    if (!S || Number(S.level) < 5) { notice('5级后才能使用装备。多多挑战，升级后再来吧！'); return; }
    if (!window.SfStatus || !SfStatus.openGears) { toast('装备页还没加载，请刷新后再试。'); return; }
    screen = 'status'; activePortrait = null;
    const ui = $('#ui');
    if (!ui) { toast('装备页加载失败，请刷新后再试。'); return; }
    ui.innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠状态"></section>';
    const box = $('#ui .ssfight-home');
    if (!box) { toast('装备页加载失败，请刷新后再试。'); return; }
    SfStatus.open(box).then(() => SfStatus.openGears()).catch((e) => {
      if (window.__errs) window.__errs.push('SfStatus gears: ' + (e && e.message));
      toast('装备页加载失败，请刷新后重试。');
    });
  }

  let gearSellPage = 0;
  const GEAR_SELL_PER = 6;
  const QUALITY_LABEL = ['普通', '优秀', '杰出', '卓越', '传说', '黑色'];
  function openGearSell(pg) {
    gearSellPage = Math.max(0, typeof pg === 'number' ? pg : 0);
    const gears = State.myGears().slice().reverse(), S = State.state();
    const total = Math.max(1, Math.ceil(gears.length / GEAR_SELL_PER));
    gearSellPage = Math.min(gearSellPage, total - 1);
    const shown = gears.slice(gearSellPage * GEAR_SELL_PER, gearSellPage * GEAR_SELL_PER + GEAR_SELL_PER);
    const card = (g) => {
      const r = State.gearSellRange(g.quality);
      return '<button class="gear-sell-card q' + g.quality + '" data-sell="' + esc(g.key) +
        '" aria-label="出售' + esc(g.name) + '">' +
        '<span class="item-icon">' + gearImg(g) + (g.used ? '<span class="equipped-check">✓</span>' : '') + '</span>' +
        '<span class="gear-sell-info"><b class="q' + g.quality + '">' + esc(g.name) + '</b>' +
        '<span class="gear-sell-price">' + r[0] + '~' + r[1] + ' 金松果</span>' +
        '<span class="gear-sell-meta">' + QUALITY_LABEL[g.quality] + (g.used ? ' · 已装备' : '') + '</span></span></button>';
    };
    const sellLegend = ['白', '绿', '蓝', '紫', '橙', '黑'].map((name, q) => {
      const range = State.gearSellRange(q);
      return name + ' ' + range[0] + '-' + range[1];
    }).join(' · ');
    const head = '<div class="gear-sell-head">' +
      '<span>背包里共 <b>' + gears.length + '</b> 件装备（容量 ' + gears.length + '/' + State.gearCapacity() + '）</span>' +
      '<span>当前金松果 <b class="gold-text">' + S.goldPoint + '</b></span>' +
      '<span class="gear-sell-legend">回收价（随机）：' + sellLegend + '</span></div>';
    const body = gears.length
      ? '<div class="gear-sell-grid">' + shown.map(card).join('') + '</div>'
      : '<div class="empty-state">还没有装备<br><span class="small-label">挑战关卡获得碎片，10 个碎片可以合成一件装备</span></div>';
    const content = head + body +
      (gearSellPage ? '<div class="page-arrow prev">' + btn('‹', 'prev', 'arrow') + '</div>' : '') +
      (gearSellPage < total - 1 ? '<div class="page-arrow">' + btn('›', 'next', 'arrow') + '</div>' : '');
    const p = page('status', 'gear-sell', content, { cls: 'gear-sell-board', counter: (gearSellPage + 1) + '/' + total, homeLabel: '返回' });
    $('[data-action="home"]', p).onclick = openStatus;
    $$('[data-sell]', p).forEach((b) => { b.onclick = () => askSellGear(b.dataset.sell); });
    $('[data-action="prev"]', p)?.addEventListener('click', () => openGearSell(gearSellPage - 1));
    $('[data-action="next"]', p)?.addEventListener('click', () => openGearSell(gearSellPage + 1));
  }

  function askSellGear(key) {
    const g = State.myGears().find((x) => x.key === key);
    if (!g) { openGearSell(gearSellPage); return; }
    const r = State.gearSellRange(g.quality);
    modal('出售装备', '<p>将以 <b>' + r[0] + '~' + r[1] + '</b> 金松果随机出售【' + esc(g.name) + '】吗？</p>' +
      (g.used ? '<p class="small-label">这件装备正穿戴在身上。</p>' : ''),
      [{ label: '出售', cls: 'gold', run: async () => {
          try {
            const got = await StateCall('sellGear', key, true);
            if (got > 0) toast('卖出【' + g.name + '】，获得 ' + got + ' 金松果');
            else toast('这件装备已不在背包里');
          } catch (e) {
            toast('出售失败：' + ((e && e.message) || '网络异常'));
          }
          openGearSell(gearSellPage);
        } }, { label: '返回', cls: 'muted' }], { small: true });
  }
  function openGear(key) {
    const g=State.myGears().find(x=>x.key===key);if(!g)return;
    const socketable=State.canSocketGem(g);
    const gemUnits=g.gem?State.gemUnitsForGear(g):[];
    const gemTotal=g.gem?State.gemAffixTotal(State.gemLevel(g.gem.id)):0, gemApplied=gemUnits.reduce((a,b)=>a+b,0);
    const gemDetail=!gemUnits.length?'该装备没有附加属性':(gemApplied===gemTotal?gemUnits.join('/'):'本件可分 '+gemApplied+' 档：'+gemUnits.join('/')+'；总 '+gemTotal+' 档');
    const gemInfo=g.gem?'<br>镶嵌宝石：'+esc(propMap.getValue(g.gem.id).name)+'（主属性 +'+State.gemPercent(State.gemLevel(g.gem.id))+'%，附加属性 +'+gemApplied+' 档（'+gemDetail+'））':'';

    const gemCost=socketable?'<br><span class="small-label">宝石：镶嵌免费 / 卸下 5 金松果</span>':'';
    const content='<div class="gear-detail"><div class="catalog-cell"><h3 class="detail-name q'+g.quality+'">'+esc(g.name)+'</h3><span class="item-icon">'+gearImg(g)+'</span><span class="small-label">'+['普通','优秀','杰出','卓越','传说','黑色'][g.quality]+'</span></div><div>装备类别：'+['头部','手部','身体','脚部'][g.type]+'　使用等级：'+g.useLevel+'<br>基本属性：'+esc(g.attrName)+' +'+g.abilityVal+(g.attrBase&&g.attrBase!==g.abilityVal?'（基准 '+g.attrBase+'，本件有浮动）':'')+'<br>附加属性：<br>'+State.extTextForGear(g, true).map(esc).join('<br>')+gemInfo+gemCost+'</div></div>';
    // 装 / 卸之后列表会重排（穿着 > 获得顺序），所以跟着这一件翻到它新位置所在的那一页，
    // 否则在后面的页上点「装备」，东西会当场跳到第一页、看不见了。
    const buttons=[{label:g.used?'卸下':'装备',run:()=>{const ok=g.used?State.unwear(key):State.wear(key);if(ok===false)toast('等级不足，暂时无法装备');
      const idx=State.gearsInDisplayOrder().findIndex(x=>x.key===key);
      openGears();}}];
    // 不再依赖 orange 标记（橙色与黑色装备都可镶嵌，这里只是把它做得更稳、更好找）。
    if(g.gem)buttons.push({label:'卸下宝石',run:()=>{const r=State.unsocketGem(key);toast(r.msg);openGear(key);}});
    else if(socketable)buttons.push({label:'镶嵌宝石',cls:'gold',run:()=>socketGemDialog(key)});
    buttons.push({label:'出售',cls:'muted',run:()=>notice('将以 '+(State.gearSellRange(State.gearQuality(g))[0])+'~'+(State.gearSellRange(State.gearQuality(g))[1])+' 金松果随机出售【'+g.name+'】吗？',[{label:'出售',run:async()=>{try{const got=await StateCall('sellGear',key,true);if(got>0)toast('卖出【'+g.name+'】，获得 '+got+' 金松果');else toast('这件装备已不在背包里');}catch(e){toast('出售失败：'+((e&&e.message)||'网络异常'));}openGears();}},{label:'返回',cls:'muted'}])});
    buttons.push({label:'返回',cls:'muted'});
    const md=modal('我的装备', content, buttons);

    md.element.classList.add('gear-detail-overlay');
  }
  function socketGemDialog(key) {
    const S=State.state();
    const gems=[101,102,103,104,105,106,107].filter(id=>(S.props[id]||0)>0);
    if(!gems.length){notice('背包里没有宝石。45级后通关关卡或在竞技场获胜有几率获得。',[{label:'返回'}]);return;}
    modal('选择宝石','<div class="gem-pick">'+gems.map(id=>'<button type="button" class="help-item" data-gem="'+id+'"><span class="item-icon">'+icon('prop',id)+'</span><span>'+esc(propMap.getValue(id).name)+' ×'+S.props[id]+'</span></button>').join('')+'</div><p class="small-label">镶嵌免费；卸下 5 金松果。附加属性总档随机分到各条词条（单条最多 12 档），可先卸下再镶嵌来重随。</p>',[{label:'返回',cls:'muted'}],{small:true});
    const overlays=$$('.classic-modal-overlay'),m=overlays[overlays.length-1];
    const callGem=(window.StateCall||((name,...args)=>Promise.resolve(State[name](...args))));
    $$('[data-gem]',m).forEach(b=>b.onclick=async()=>{let r;try{r=await callGem('socketGem',key,+b.dataset.gem);}catch(e){toast('镶嵌失败：'+((e&&e.message)||e));return;}toast(r&&r.msg||'镶嵌失败');if(r&&r.ok){m.remove();openGear(key);}});
  }
  function openMerge() {
    if (window.ClassicFusion) window.ClassicFusion.open();
    else if (legacy && typeof legacy.runAction === 'function') legacy.runAction('gears');
  }

  function openMessages(tab, pg) {
    tab = typeof tab === 'string' ? tab : 'messages'; pg = pg || 0;
    if (!window.SfMessage || !SfMessage.open) { toast('消息页还没加载，请刷新后再试。'); return; }
    screen = 'message'; activePortrait = null;
    $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠消息"></section>';
    const box = $('#ui .ssfight-home');
    if (!box) { toast('消息页加载失败，请刷新后再试。'); return; }
    SfMessage.open(box, tab, pg + 1).then(() => {
      if (screen === 'message' && window.SfGuide) { try { SfGuide.onPage('message'); } catch (e) {} }
    }).catch((e) => {
      if (window.__errs) window.__errs.push('SfMessage: ' + (e && e.message));
      toast('消息页加载失败，请刷新后重试。');
    });
  }


  function openFriends() {
    if (!window.SfChallenge || !SfChallenge.openAt) { toast('好友页还没加载，请刷新后再试。'); return; }
    SfChallenge.openAt('friends');
    openChallenge();
  }


  function dailyData() {
    const d = State.dailyStatus();
    const quests = State.questStatus();
    const tribute = (window.ClassicExtras && ClassicExtras.tributeStatus)
      ? ClassicExtras.tributeStatus()
      : { rows: [], exp: 0, gold: 0, count: 0, claimable: false, claimed: false };
    return { d, quests, tribute };
  }

  function dailyRewardIcon(r) {
    return r.kind === 'gold' ? goldIcon()
      : r.kind === 'exp' ? '<img alt="" src="images/ui/icons/prop/prop-15.svg">'
        : icon('prop', r.id);
  }


  function activityRewardChip(r, card) {
    const art = dailyRewardIcon(r);
    const name = r.name || '奖励';
    const label = name + ' ×' + r.count;
    const chipStyle = card ? ' style="font-size:20px;gap:2px"' : '';
    const iconStyle = card ? ' style="width:40px;height:40px;flex:0 0 40px"' : '';
    const countStyle = card ? ' style="font-size:20px"' : '';
    return '<span class="activity-reward" role="img" title="' + esc(label) + '" aria-label="' + esc(label) + '"' + chipStyle + '>' +
      '<span class="activity-reward-icon"' + iconStyle + '>' + art + '</span><b' + countStyle + '>×' + r.count + '</b></span>';
  }
  // 右键：标签固定用栏目名；ready=亮黄可点，否则灰且禁用（个别入口另行放行）。
  // `inlineStyle` 只给顶部两张卡用，目的同上：压过可能被缓存的旧 CSS。
  function activityButton(label, action, ready, disabled, inlineStyle) {
    return '<button type="button" class="uc-button activity-claim ' + (ready ? 'gold' : 'muted') + '"' +
      ' data-action="' + esc(action) + '"' + (inlineStyle ? ' style="' + inlineStyle + '"' : '') +
      (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  function activityRow(cls, rewards, main, button) {
    return '<div class="activity-row ' + cls + '">' +
      '<div class="activity-rewards">' + rewards + '</div>' +
      '<div class="activity-main">' + main + '</div>' + button + '</div>';
  }
  // 顶部领取卡（礼包/日供左右各一张）：左奖励图标、右领按键、下面一行说明。
  // 被 WebView2/浏览器缓存；内联样式优先级高于旧 CSS，能保证压缩布局生效。
  function activityCard(cls, rewards, meta, button) {
    return '<div class="activity-card ' + cls + '" style="display:grid;grid-template-columns:minmax(0,1fr) 148px;' +
      'grid-template-rows:86px auto;column-gap:8px;row-gap:2px;align-content:center;padding:5px 7px 6px">' +
      '<div class="activity-card-main" style="grid-column:1;grid-row:1;display:flex;align-items:center;gap:8px;min-width:0;height:86px">' +
      '<div class="activity-rewards" style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;align-content:center;overflow:hidden;flex:1 1 auto;min-width:0">' +
      rewards + '</div></div>' + button +
      '<div class="activity-meta" style="grid-column:1 / span 2;grid-row:2;font-size:16px">' + meta + '</div></div>';
  }

  const ACTIVITY_CARD_BTN_STYLE = 'grid-column:2;grid-row:1 / span 2;align-self:center;height:64px;width:148px;min-width:148px;min-height:0;box-sizing:border-box;' +
    'padding:0 6px;border-width:3px;font-size:28px;line-height:1.1;letter-spacing:0;white-space:nowrap';

  function activityRowsHtml(d, tribute, quests) {

    const giftRewards = [activityRewardChip({ kind: 'gold', name: '金松果', count: Number(d.gold) || 0 }, true)];
    if (d.extra) giftRewards.push(activityRewardChip({ kind: 'prop', id: d.extra.id, name: d.extra.name, count: d.extra.count }, true));
    if (d.ticket) giftRewards.push(activityRewardChip({ kind: 'prop', id: 87, name: '征战令', count: d.ticket }, true));
    const giftCard = activityCard('gift' + (d.claimed ? ' claimed' : ' ready'),
      giftRewards.join(''),
      '连续登录 ' + (Number(d.streak) || 1) + ' 天 · ' + (d.claimed ? '今日已领取' : '今日礼包待领取'),
      activityButton('每日礼包', 'claim-gift', !d.claimed, d.claimed, ACTIVITY_CARD_BTN_STYLE));


    const tRows = Array.isArray(tribute.rows) ? tribute.rows : [];
    const tExp = tRows.reduce((n, x) => n + (Number(x.exp) || 0), 0) || (Number(tribute.exp) || 0);
    const tGold = tRows.reduce((n, x) => n + (Number(x.gold) || 0), 0) || (Number(tribute.gold) || 0);
    const tRewards = [];

    tRewards.push(activityRewardChip({ kind: 'exp', name: '经验', count: tExp }, true));
    tRewards.push(activityRewardChip({ kind: 'gold', name: '金松果', count: tGold }, true));
    const noTribute = !tribute.count;
    const tReady = !!tribute.claimable;
    const tClaimed = !!tribute.claimed;
    const tMeta = noTribute
      ? '还没有徒弟 · 好友页收徒后次日结算'
      : tribute.count + ' 个徒弟的昨日日供 · ' + (tClaimed ? '今日已领取' : tReady ? '今日可领取' : '明日结算');
    const tributeCard = activityCard('tribute' + (tReady ? ' ready' : tClaimed ? ' claimed' : ''),
      tRewards.join(''), tMeta,
      activityButton('徒弟日供', 'claim-tribute', tReady, !tReady, ACTIVITY_CARD_BTN_STYLE));


    const questRows = quests.map((q) => {
      const pct = Math.round(100 * q.progress / q.need);
      const ready = q.done && !q.claimed;
      const state = q.claimed ? '已领取' : q.done ? '可领取' : '进行中';
      const main = '<div class="activity-name">' + esc(q.name) + '</div>' +
        '<div class="activity-progress"><span class="activity-bar"><i style="width:' + pct + '%"></i></span>' +
        '<b>' + q.progress + '/' + q.need + '</b><span class="activity-meta">' + state + '</span></div>';
      return activityRow('quest' + (ready ? ' ready' : q.claimed ? ' claimed' : ''),
        q.rewards.map((r) => activityRewardChip(r)).join(''), main,
        activityButton('每日任务' + (q.index + 1), 'quest' + q.index, ready, !ready));
    }).join('');

    return '<div class="activity-list">' +
      '<div class="activity-top">' + giftCard + tributeCard + '</div>' +
      '<div class="activity-tasks">' + (questRows || '<p class="activity-empty">今日任务暂未刷新</p>') + '</div></div>';
  }

  function bindActivityRows(root, data, rerender) {
    const d = data.d, tribute = data.tribute, quests = data.quests;
    $('[data-action="claim-gift"]', root)?.addEventListener('click', async () => {
      if (d.claimed) return;
      const r = await StateCall('claimDaily');
      toast(r && r.msg);
      rerender();
    });

    $('[data-action="claim-tribute"]', root)?.addEventListener('click', () => {
      if (!tribute.count || !tribute.claimable) return;
      if (window.ClassicExtras && ClassicExtras.claimTribute) ClassicExtras.claimTribute(rerender, { silent: true });
    });
    quests.forEach((q) => {
      const b = $('[data-action="quest' + q.index + '"]', root);
      if (b) b.addEventListener('click', async () => {
        if (!q.done || q.claimed) return;
        // 联机版直接走服务端动作，等 patch 回来再重画；单机沿用本地 State。
        const r = (window.__SSDZ_ONLINE__ && window.StateCall)
          ? await StateCall('claimQuest', q.index)
          : State.claimQuest(q.index);
        toast(r && r.msg);
        // 任务奖励里的经验可能升级：升级奖励弹窗要接在这里，不能只弹一句 toast。
        if (r && Array.isArray(r.ups) && r.ups.length) showLevelUps(r.ups, rerender);
        else rerender();
      });
    });
  }

  function openSystem() {
    if (window.OnlineUI && OnlineUI.settingsPage) return OnlineUI.settingsPage();
    toast('设置页还没加载，请刷新后再试。');
  }

  function openVillageScene(key, fallbackAction) {

    if (window.SfGuide) { try { SfGuide.onPage(key); } catch (e) {} }
    if (currentUiMode() === 'classic' && window.SfVillage) {
      $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠村庄·' + key + '"></section>';
      // 从塔页（#ui 按 690 高）回来时，这里必须重新按原版 320×196 量一次；
      // 否则地点页的 SVG 只按高度铺满，左右会各空一条。
      if (window.Main?.resizeLayout) Main.resizeLayout();
      const box = $('#ui .ssfight-home');
      if (box) {
        SfVillage.open(box, key).catch((e) => {
          if (window.__errs) window.__errs.push('SfVillage(' + key + '): ' + e.message);
          fallbackAction();
        });
        return;
      }
    }
    fallbackAction();
  }
  function villageBuildingLock(key, label) {
    if (!(window.State && State.buildingUnlocked) || State.buildingUnlocked(key)) return '';
    return label + '需要达到 ' + (State.buildingUnlockLevel ? State.buildingUnlockLevel(key) : '') + ' 级才能使用。';
  }
  function villageAltar() {
    const lock = villageBuildingLock('altar', '祭坛');
    if (lock) { notice(lock); return; }
    openVillageScene('village-altar', () => fallback('arena'));
  }
  function villageBeast() {
    const lock = villageBuildingLock('beast', '幻兽牧场');
    if (lock) { notice(lock); return; }
    openVillageScene('village-beast', () => openMerge());
  }
  function villageMiracle() {
    const lock = villageBuildingLock('miracle', '神迹');
    if (lock) { notice(lock); return; }
    openVillageScene('village-miracle', () => fallback('lottery'));
  }
  // 村庄「征战」：联机版进原版 3437 四人组队副本；离线没有服务端撮合，只给说明。
  function villageWar() {
    // 35 级引导的「去村庄参加征战」到这里算完成；否则从征战页回来还会再弹。
    if (window.SfGuide) { try { SfGuide.onPage('village-war'); } catch (e) {} }
    // 征战恢复原版作用：四人组队副本（原版 `joinCopy.do` → 服务端凑人 → 掷骰分赃）。
    if (window.Online && window.Online.ready && window.OnlineUI && OnlineUI.campaignPage) {
      OnlineUI.campaignPage();
      return;
    }
    const S = State.state();
    const levelNeed = Number(State.WAR_UNLOCK_LEVEL) || 35;
    if (Number(S && S.level) < levelNeed) { notice('征战需要达到 ' + levelNeed + ' 级才能使用。'); return; }
    // 单机版（没有联机层）里征战没有服务端撮合，明确说明而不是弹两座塔。
    notice('征战是四人组队副本，需要连上服务器才能报名（单机版无法撮合队友）。');
  }
  function openVillage() {

    if (currentUiMode() === 'classic' && window.SfUiMain && SfUiMain.mountVillage) {
      if (window.SfVillage) { try { SfVillage.destroy(); } catch (e) {} }
      $('#ui').innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠村庄"></section>';
      // 同 openVillageScene：从塔页回来时先把 #ui 的高度切回村庄页，
      // 再异步挂 SVG；不然村庄立绘会按 690 高算宽度，左右出现黑边。
      if (window.Main?.resizeLayout) Main.resizeLayout();
      const box = $('#ui .ssfight-home');
      if (box) {
        SfUiMain.mountVillage(box).catch((e) => {
          if (window.__errs) window.__errs.push('mountVillage: ' + e.message);
          toast('村庄页加载失败，请刷新后重试。');
        });
        return;
      }
    }
    toast('村庄页还没加载，请刷新后再试。');
  }
  const GUIDE_ITEMS = [1,2,3,4,5,7,8,10,11,12,13,15,16,17,18,19,21,22,23,24,25,26,28,29,30,31,32,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,77,78,79,80,82,89,90,101,102,103,104,105,106,107];
  function guideSources(id) {
    const lines = [];
    if (!State.blackGearEnabled() && State.BLACK_PROP_IDS.includes(Number(id))) return lines;
    const pool = (window.BattleDrops && BattleDrops.pool) || [];
    const total = pool.reduce((n, p) => n + p.weight, 0);
    const drop = pool.find((p) => p.id === id);
    if (drop) {
      const per = drop.weight / total;
      lines.push('战斗拾取：每张拾取卡 ' + (per * 100).toFixed(1) + '%，每场战斗 3 张卡，期望 ' + (per * 3 * drop.count).toFixed(2) + (id === 15 ? ' 点/场' : ' 个/场'));
    }
    const ladderPool = (window.BattleDrops && BattleDrops.ladderPool) || [];
    const ladderTotal = ladderPool.reduce((n, p) => n + p.weight, 0);
    const ladderDrop = ladderPool.find((p) => p.id === id);
    if (ladderDrop) {
      const per = ladderDrop.weight / ladderTotal;
      lines.push('天梯赛拾取：每张拾取卡 ' + (per * 100).toFixed(1) + '%，每场 3 张卡，期望 ' + (per * 3 * ladderDrop.count).toFixed(2) + ' 个/场（战斗里点飘出来的碎片）');
    }
    const prop = propMap.getValue(id);
    if (prop && prop.buy === 'true') lines.push('道具商店：' + parseInt(prop.price) + ' 金松果/个，每日限购 ' + State.shopLimit(id) + ' 个');
    const prizes = (window.ClassicExtras && ClassicExtras.lotteryPrizes) || [];
    const mine = prizes.filter((p) => p.id === id && p.count);
    if (mine.length) {
      const expect = mine.reduce((n, p) => n + p.count * 0.1, 0);
      const lotteryPrice = (window.Online && Online.meta && Online.meta.limits && Online.meta.limits.lotteryPrice)
        || (window.GData && GData.LOTTERY_PRICE) || 25;
      lines.push('每日抽奖：' + mine.map((p) => p.label).join('、') + '，占 ' + mine.length + '/10 格，单次抽中概率 ' + mine.length * 10 + '%，期望 ' + expect.toFixed(1) + ' 个/次（每天免费 1 次，之后 ' + lotteryPrice + ' 金松果/次）');
    }
    if ([24, 25, 26].includes(id)) lines.push('关卡掉落：' + ({ 24: '螳螂关', 25: '仙鹤关', 26: '熊猫关' })[id] + '每场胜利 45%～60%（按星级）概率掉落 1～6 个，期望约 1.6～2.1 个/场；★3-4 有 28% 几率越 1 级、★5-6 越 2 级');
    if (id === 23) lines.push('每日礼包：每天 1 个（连续登录第 1 天 100 金松果，每多一天 +10，200 封顶；另在挑战书、英雄帖、勇气徽章、召唤证、三种超级药丸之间按日期轮换 1 个）');
    if (id === 28) lines.push('创建角色时获得 1 个');
    if (id === 29) lines.push('打开「1级礼包」获得');
    if (id === 30) lines.push('打开「5级礼包」获得');
    if (id === 31) lines.push('打开「10级礼包」获得');
    if (id === 32) lines.push('打开「15级礼包」获得');
    if (id === 37) lines.push(window.__SSDZ_ONLINE__
      ? '联机版 53、59、65 级各静默发 1 本（直接进背包，不占升级奖励卡）；使用后 8 点自由分配到力/敏/速。'
      : '离线版不随等级发放；旧库存仍可使用（8 点自由分配）。');
    if ([41, 42, 43, 44].includes(id)) lines.push('金杯商店（每天开放）：20 金杯 + 20 金松果，积分需 800，不限兑换次数');
    if ([16, 17, 18, 19].includes(id)) lines.push('金杯商店（每天开放）：500 金杯 + 100 金松果，积分需 1500，账号限兑 1 次（不随周重置）');
    if ([21, 22].includes(id)) lines.push('金杯商店（每天开放）：100 金杯 + 100 金松果兑换 100 个，积分需 1200，每周限兑 1 次（每周一重置）');
    if (id === 40) lines.push('天梯赛：胜利 +3 杯、落败 +1 杯，获胜有 25% 概率额外夺得 3 杯');
    if (id === 51) lines.push('合成：属性碎片 ×10 + 50 金松果 → 随机 1 个力量/敏捷/速度转化丸');
    if (id === 47) lines.push('合成：天使果实种子 ×10 + 50 金松果（背包中合成）');
    if (id === 48) lines.push('合成：恶魔果实种子 ×10 + 50 金松果（背包中合成）');
    if (id === 8) lines.push('挑战胜利：3～7 个/场；通关关卡整轮：25 个；各级礼包中也有');
    if (id === 77 || id === 78) {
      const setName = id === 77 ? '凤凰' : '圣熊';
      lines.push('合成：10 个' + (id === 77 ? '黑凤凰碎片' : '黑圣熊碎片') + ' + 1000 金松果 → 1 件黑色' + setName + '装备（随机部位；未集齐时重复会重摇，最多 2 次后给缺失部位）');
      lines.push('碎片来源：黑色卡片、魔法袋（必得 1 卡）、金宝箱（8% 黑卡 / 首开 2% 完整黑装）、黑装融合（20% 返 1 卡）');
    }
    if (id === 79) {
      lines.push('金杯商店：180 积分 + 2000 金杯 + 200 金松果，账号限兑 1 次（原版天梯商店的魔法袋）');
      lines.push('打开魔法袋（各档互斥）：6级宝石 3%、5级宝石 15%、蓝色碎片 15%（5~10）、召唤证 17%（1~2）、金松果 25%（300~500）、孵化点 25%（100）' + (State.blackGearEnabled() ? '；并额外获得黑色卡片 ×1' : ''));
    }
    if (id === 80) {
      lines.push('挑战塔：每 20 层 1 张、每 50 层再 +1 张（一次性）；第 100 层首通改为黑装自选箱（不发卡）');
      lines.push('无尽塔：每累计 50 层 1 张，每周最多 10 张（周一重置）');
      lines.push(window.__SSDZ_ONLINE__
        ? '金宝箱其它奖励：15.69% 开出 1 张；魔法袋：必得 1 张；黑装融合：20% 返 1 张'
        : '金宝箱：8% 开出 1 张；魔法袋：必得 1 张；黑装融合：20% 返 1 张');
      lines.push('打开：选择凤凰/圣熊，获得对应碎片 1~2 个 + 100/200/400 金松果');
    }
    if (id === 82) lines.push('魔法袋：有几率开出 1～2 个');
    if (id === 89) lines.push('挑战塔第 100 层首通获得 1 个；打开后任选 1 件黑色凤凰/圣熊装备');
    if (id === 90) {
      if (window.__SSDZ_ONLINE__) {
        lines.push('升级奖励：71～90 级每升 1 级获得 1 个，共 20 个');
        lines.push('打开：固定获得 10 点基础属性点（自动随机分配）+ 1 件随机其它奖励；其它奖励池不含属性点');
        lines.push('其它奖励：6级宝石 7.84%、5级宝石 43.14%、金松果 29.41%、黑色卡片 15.69%、完整黑装 3.92%');
      } else {
        lines.push('升级奖励：71～90 级每升 1 级获得 1 个，共 20 个（原版 70 级以上每级 1 个，最高 90 级）');
        lines.push(State.blackGearEnabled()
          ? '打开金宝箱（各档互斥）：6级宝石 4%、5级宝石 22%（10% 两颗 / 12% 一颗）、基础属性点 49%（6/8/10/12 点）、金松果 15%（500/750/1000）、黑色卡片 8%、完整黑装 2%'
          : '打开金宝箱（各档互斥）：6级宝石 4%、5级宝石 22%（10% 两颗 / 12% 一颗）、基础属性点 49%（6/8/10/12 点）、金松果 25%（500/750/1000）');
      }
    }
    if (id >= 101 && id <= 107) {
      const lv = id - 100;
      if (lv <= 2) lines.push('45 级起：通关关卡 20% 几率、竞技场（经验/碎片）获胜 15% 几率获得（一级 75% / 二级 25%）');
      if (lv < 7) lines.push('合成：3 个同级 + 10 金松果，成功率 ' + Math.round(State.gemMergeRate(lv) * 100) + '%（失败有 50% 几率一颗材料降 1 级，1级则碎裂）');
      lines.push('镶嵌：镶入橙色（3 件相同紫装融合而来）或黑色装备，主属性 +' + State.gemPercent(lv) + '%（原版曲线 5×(n²−n+2)），附加属性总增幅 ' + State.gemAffixTotal(lv) + ' 档随机分到各条词条（单条最多 12 档，拆下重镶可重随）；每件限 1 颗，镶嵌免费、卸下 5 金松果');
    }
    const visibleLines = window.__SSDZ_ONLINE__ ? lines.filter((line) => !/挑战塔|无尽塔/.test(line)) : lines;
    if (!visibleLines.length) visibleLines.push('当前版本暂无产出途径（图鉴预留物品）');
    return visibleLines;
  }
  function openGuideItem(id) {
    const prop = propMap.getValue(id);
    if (!prop) return;
    modal(prop.name, '<div class="guide-detail"><span class="item-icon">' + icon('prop', id) + '</span><div class="guide-info"><p><b>效果</b>：' + esc(prop.remark || '—') + '</p><p><b>获取方式与概率</b>：</p><ul>' + guideSources(id).map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></div></div>', [{ label: '返回帮助', cls: 'gold', run: openHelp }], { small: true });
  }
  function onlineGuideItem(id) { return !window.__SSDZ_ONLINE__ || Number(id) !== 89; }
  // 帮助页最下面的公告入口（联机版专用）：系统公告 + 更新公告。
  const HELP_NOTICE_FOOTER = '<div class="help-notice-footer">' +
    '<button type="button" class="uc-button gold" data-help-notice>系统公告</button>' +
    '<button type="button" class="uc-button" data-help-releases>更新公告</button>' +
    '<p class="small-label">系统公告说明玩法与规则；更新公告按版本记录改动，客户端更新后第一次打开游戏会自动弹出。</p></div>';
  // 帮助页词条总表（唯一真值）
  const HELP_TERMS = [
    { key: 'challenge', title: '挑战', text: '选择对手，再点「挑战他」。每场消耗10体力，战斗自动进行。挑战是获得经验与金松果的基本路径。' },
    { key: 'attributes', title: '属性', text: '力量影响伤害，敏捷影响闪避，速度影响出手次数。战斗中随机使用已获得的武器与技能。' },
    { key: 'growth', title: '成长', text: '战斗获得经验，升级有机会领悟武器与技能；71 级起每升 1 级还会获得 1 个金宝箱。' },
    { key: 'stamina', title: '体力', text: '每5分钟恢复1点，也可以在道具中使用体力药剂。消耗体力进行战斗以获取各种奖励。' },
    { key: 'stages', title: '关卡', text: '5 级开启。消耗挑战书进行挑战，是获取金松果与装备碎片的途径。' },
    { key: 'arena', title: '竞技场', text: '10级开启经验竞技场，15级开启碎片竞技场与幻兽竞技场。竞技场通过竞技获取各种道具。' },
    { key: 'beast', title: '幻兽', text: '村庄「幻兽牧场」孵化、编队、喂养、进化；孵化消耗 200 孵化点。幻兽竞技场用召唤证报名。' },
    { key: 'ladder', title: '天梯赛', text: '30 级开启，战斗中可拾取属性碎片；通过在天梯战斗来证明自己吧！' },
    { key: 'replay', title: '录像', text: '最近50场战斗保存在消息页，可通过回放进行查看。' },
    { key: 'gems', title: '宝石', text: '45 级后通关关卡或竞技场获胜有几率获得 1~2 级宝石；3 个同级宝石 + 10 金松果可合成高一级（可能失败）。宝石可镶入橙色或黑色装备，镶嵌免费、卸下 5 金松果。' },
    { key: 'tower', title: '无尽塔', text: '村庄右上角的小径进入（20 级解锁）。免门票的 Roguelike 无尽模式，可从中获取抽奖卷道具。' },
    { key: 'fusion', title: '装备融合', text: '3 件同品质、未穿戴的装备可融合成 1 件更高品质装备，黑装可继续融合洗词条。产物部位从三件材料中随机、优先同套；词条按星级从高到低继承前两条，第三条随机。',
      when: () => State.blackGearEnabled() },
  ];
  // 当前要显示的词条（顺序就是页面上的阅读顺序）。
  function helpTerms() { return HELP_TERMS.filter((t) => !t.when || t.when()); }
  // 按词条索引取一条（找不到 = null）：别处要引用帮助文案请走这里，不要抄一份。
  function helpTerm(key) {
    const k = String(key == null ? '' : key);
    return HELP_TERMS.find((t) => t.key === k) || null;
  }
  function helpTermsHtml() {
    return helpTerms().map((t) => '<p data-term="' + esc(t.key) + '"><b>' + esc(t.title) + '</b>：' + t.text + '</p>').join('');
  }

  function focusHelpTerm(p, key) {
    if (!key) return;
    const el = p.querySelector('[data-term="' + String(key).replace(/["\\]/g, '') + '"]');
    if (!el) return;
    el.classList.add('help-term-focus');
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 老 WebView 不接受参数，忽略 */ }
    }
  }
  function openHelp(termKey) {
    const guideIds = State.blackGearEnabled()
      ? GUIDE_ITEMS
      : GUIDE_ITEMS.filter((id) => !State.BLACK_PROP_IDS.includes(Number(id)));
    const items = guideIds.filter(onlineGuideItem).map((id) => '<button type="button" class="help-item" data-guide="' + id + '"><span class="item-icon">' + icon('prop', id) + '</span><span>' + esc(propMap.getValue(id).name) + '</span></button>').join('');
    const p = page('system', 'help', '<div class="help-box">' + helpTermsHtml() +
      '<h3 class="help-items-title">可获得物品一览</h3><div class="help-items">' + items + '</div>' +
      '<p class="small-label">点击物品可查看效果、获取方式以及具体的概率与期望；标注“暂无产出途径”的为图鉴预留物品。</p></div>', { cls: 'help-board' });
    $$('[data-guide]', p).forEach((b) => b.onclick = () => openGuideItem(+b.dataset.guide));
    wireSystemFeedback(p);
    // 公告入口放在帮助页最下面；在 wireSystemFeedback 之后再插入，
    const helpBox = p.querySelector('.help-box');
    if (helpBox && window.__SSDZ_ONLINE__) helpBox.insertAdjacentHTML('beforeend', HELP_NOTICE_FOOTER);
    const bindNotice = (sel, fn) => {
      const b = p.querySelector(sel);
      if (!b) return;
      b.onclick = () => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (e) {} };
      if (window.SfUiFeedback && SfUiFeedback.bind) SfUiFeedback.bind(b);
    };
    bindNotice('[data-help-notice]', () => (window.OnlineUI && OnlineUI.openNotice) ? OnlineUI.openNotice() : null);
    bindNotice('[data-help-releases]', () => (window.OnlineUI && OnlineUI.openReleases) ? OnlineUI.openReleases() : null);
    focusHelpTerm(p, termKey);
    return p;
  }

  function fallback(key){if(window.ClassicExtras && window.ClassicExtras[key])window.ClassicExtras[key]();else if(legacy && typeof legacy.runAction === 'function')legacy.runAction(key);}
  // ⚠ `merge` 必须在这个总表里：经典（ssfight）状态页的「装备融合」按钮走的是
  const actions={home,exchange:()=>openBag('exchange'),status:openStatus,weapons:()=>openCatalog('weapon'),skills:()=>openCatalog('skill'),challenge:()=>openChallenge(),battle:()=>openChallenge(),stages:openStages,bag:()=>openBag(),shop:()=>openBag(true),gears:()=>openGears(),merge:openMerge,messages:()=>openMessages(),ranklog:()=>openMessages('ranklog'),revenge:()=>openMessages('revenge'),friends:openFriends,'gear-sell':()=>openGearSell(0),daily:()=>{const S=State.state();if(S&&Number(S.level)<3){toast('3级后开放活动礼包');return;}if(window.SfUiMain&&SfUiMain.openActivity)SfUiMain.openActivity();},system:openSystem,village:openVillage,'village-altar':villageAltar,'village-beast':villageBeast,'village-miracle':villageMiracle,'village-war':villageWar,help:openHelp,arena:()=>fallback('arena'),rank:()=>fallback('rank'),lottery:()=>fallback('lottery'),toplist:()=>fallback('toplist'),vip:()=>fallback('vip')};

  function runAction(key, arg){if(actions[key]){closeOriginalResult();actions[key](arg);}}
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      const dialogs=$$('.classic-modal-overlay');
      if(dialogs.length){
// 没有关闭叉的锁定弹窗，Esc 也不放行
        const closeBtn=$('.modal-close',dialogs[dialogs.length-1]);
        if(closeBtn){closeBtn.click();return;}
        return;
      }
      if(window.SfFightResult&&SfFightResult.isOpen()){e.preventDefault();SfFightResult.dismiss();return;}
      const panels=$$('.panel-close');if(panels.length){panels[panels.length-1].click();return;}
      if(screen!=='home'&&$('.classic-page')&&!dialogs.length)home();
    }
    if(e.key==='Tab'){
      const dialogs=$$('.classic-modal-overlay');if(!dialogs.length)return;
      const root=dialogs[dialogs.length-1],focusable=$$('button:not(:disabled),input',root);
      const first=focusable[0],last=focusable[focusable.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  });

  function supportMeta() {
    const s = (window.Main && Main.SUPPORT) || {};
    return { url: s.url || 'https://ifdian.net/a/Charlespkuer', label: s.label || '爱发电' };
  }
  // 复制文本：优先 Clipboard API，失败退回「选中 + execCommand」。
  function copyText(text) {
    const okMsg = '链接已复制，去浏览器里粘贴打开就行';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast('复制失败，请手动选中复制'));
        return true;
      }
    } catch (e) {  }
    try {
      const el = document.createElement('textarea');
      el.value = text; el.setAttribute('readonly', 'readonly');
      el.style.position = 'fixed'; el.style.left = '-9999px'; el.style.opacity = '0';
      document.body.appendChild(el); el.select(); el.setSelectionRange(0, el.value.length);
      document.execCommand('copy'); el.remove(); toast(okMsg); return true;
    } catch (e) { toast('复制失败，请手动选中复制'); return false; }
  }

  function openSupportLink(url) {
    const u = url || supportMeta().url;
    const fail = () => showSupportFallback(u);
    let p;
    try { p = (window.Main && Main.openExternal) ? Main.openExternal(u) : Promise.resolve(false); }
    catch (e) { p = Promise.resolve(false); }
    return Promise.resolve(p).then((ok) => { if (!ok) fail(); return !!ok; }, () => { fail(); return false; });
  }

  function showSupportFallback(url) {
    const box = modal('用浏览器打开', '<div class="support-box"><p>没能自动打开浏览器 —— 复制下面的链接，' +
      '在浏览器地址栏粘贴打开即可：</p><p><input class="support-input" readonly value="' + esc(url) +
      '" aria-label="支持作者链接"></p></div>',
      [{ label: '复制链接', cls: 'gold', close: false, run: () => copyText(url) },
        { label: '返回', cls: 'muted' }], { small: true });
    const input = $('.support-input', box.element);
    if (input) { input.focus(); input.select(); }
    return box;
  }
  // 「支持作者」弹窗。`opts.fromLevel` = 30 级那次一次性提示（文案不同）。
  // 两个入口共用：系统页顶部的按钮、30 级提示。
  function openSupportModal(opts) {
    const o = opts || {};
    const meta = supportMeta();
    const lead = o.fromLevel
      ? '你已经 30 级了 —— 谢谢你玩到这里！'
      : '这个复刻版完全免费：没有内购、没有广告。';
    const body = '<div class="support-box">' +
      '<p class="support-lead">' + esc(lead) + '</p>' +
      '<p>如果它让你找回了一点当年的感觉，可以<b>自愿</b>请作者喝杯咖啡；' +
      '不打赏完全不影响游戏内容与平衡，也不解锁任何东西。bug反馈与内容讨论请加q群：1128710765</p>' +
      '<p class="support-link">' + esc(meta.label) + '：<span class="support-url">' + esc(meta.url) + '</span></p>' +
      '</div>';
    return modal('支持作者', body, [
      { label: '打开链接', cls: 'gold', run: () => openSupportLink(meta.url) },
      { label: '以后再说', cls: 'muted' },
    ], { small: true });
  }
  // 30 级的一次性提示。只在没有别的弹窗时触发（升级奖励 / 三选一 / 属性点都处理完之后），
  // 取提示权是原子的：取到就立刻落存档，不会重复打扰。
  function maybeSupportPrompt() {
    if (!window.State || typeof State.supportPromptTake !== 'function') return false;
    if ($('.classic-modal-overlay')) return false;
    if (!State.supportPromptTake()) return false;
    openSupportModal({ fromLevel: true });
    return true;
  }


  const VERSION_FALLBACK = '1.0.5';
  let gameVersion = String((typeof window !== 'undefined' && window.__SSDZ_VERSION) || VERSION_FALLBACK);
  let versionRequested = false;
  function versionLabel(v) {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
    return s ? 'v' + s : 'v' + VERSION_FALLBACK;
  }
  function syncVersionLabels() {
    try {
      document.querySelectorAll('[data-game-version]').forEach((el) => {
        el.textContent = versionLabel(gameVersion);
      });
    } catch (e) {}
  }

  function loadGameVersion() {
    if (versionRequested) return;
    versionRequested = true;
    try {
      if (typeof fetch !== 'function') return;
      fetch('scripts/version.json', { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          if (j && j.version) { gameVersion = String(j.version); syncVersionLabels(); }
        })
        .catch(() => {});
    } catch (e) {}
  }
  function supportPanelHtml() {
    const meta = supportMeta();
    const ver = versionLabel(gameVersion);
    loadGameVersion();
    return '<div class="support-panel">' +
      '<div class="support-panel-text"><div class="support-head"><h3 class="classic-section-title">关于复刻版</h3>' +
      '<span class="support-version" data-game-version="1" title="当前版本">' + esc(ver) + '</span></div>' +
      '<span><b>喜欢这个复刻版？</b>如果它让你找回了一点当年的感觉，可以自愿支持作者（不影响任何游戏内容）。bug反馈与内容讨论请加q群：1128710765</span></div>' +
      '<button type="button" class="uc-button gold support-btn" data-action="support" title="用系统浏览器打开' +
      esc(meta.label) + '">支持作者</button></div>';
  }

  // 联机版只有经典界面（State.UIMODES 也只有 classic）。保留 currentUiMode /
  // applyUiMode 两个兼容入口给 main.js 和存档载入用，不再提供切换 UI。
  const UI_MODE_LSKEY = 'ssdz_ui_mode';
  // 当前模式：优先读存档；存档还没载入（标题画面）时退回 localStorage。
  function currentUiMode() {
    try {
      if (window.State && State.settings && State.state && State.state()) {
        const m = State.settings().uiMode;
        if (m) return m;
      }
    } catch (e) {}
    try { return localStorage.getItem(UI_MODE_LSKEY) === 'modern' ? 'modern' : 'classic'; }
    catch (e) { return 'classic'; }
  }

  function applyUiMode() {
    const m = 'classic';
    try { document.documentElement.setAttribute('data-ui-mode', m); } catch (e) {}
    try { localStorage.setItem(UI_MODE_LSKEY, m); } catch (e) {}
    return m;
  }

  // 布局高度：菜单页按 920:560 参考比例（= 1170×712.174），战斗/首页场景按 690。
  // 这条判据原先硬编码在 main.js 的 fitCanvas 里；提到展示层之后，
  function layoutHeight(W, H) {
    // 经典模式的村庄页与状态页都是原版 320×196 的整页，必须按原版比例给高度：
    if (currentUiMode() === 'classic' && window.SfUiMain) return W * 196 / 320;
    return $('#ui .classic-page') ? W * 560 / 920 : H;
  }

  function smokeSelectors() {

    return { panel: '#ui .panel, #ui .classic-page, #ui .classic-modal, #ui .ssfight-sub, #ui .ssfight-view, #ui section[aria-label="松鼠挑战"], #ui section[aria-label="松鼠状态"], #ui section[aria-label="松鼠消息"]', close: '#ui .panel-close' };
  }
  // 启动即落一次模式：此时存档还没载入，用 localStorage 兜底；存档载入后 main.js 会再落一次。
  applyUiMode(currentUiMode());

  window.UI={...legacy,renderHome,drawHomeHud,drawActor,runAction,currentScreen:()=>screen,refreshHome,renderNumbers,refreshHeader,openHeroPage,
    currentUiMode,applyUiMode,UI_MODE_LSKEY,layoutHeight,smokeSelectors,
    classic:{page,modal,notice,btn,bind,inlineSvgIcon,icon,goldIcon,propIconSrc,statsHtml,portrait,resultModal,stageResult,home,toast,num,setNum,upgradeReward,upsHtml,pickupResult,promptLevelUpChoices,showLevelUps,wsChoiceDialog,openSupportModal,maybeSupportPrompt,supportPanelHtml,copyText,supportMeta,wireSystemFeedback,
      // 帮助页的词条：`help('gems')` 直接开到那条并高亮；`helpTerm('gems')` 取文案/标题，
      // 别的地方要引用帮助内容时走这两个，不要再抄一份文字。
      help:openHelp,helpTerm,openHeroPage,
      // 图鉴的数据画格子（原版那两个 tab 的图标是运行时 `attachMovie` 的库元件，素材库里没有），
      // 详情页用的还是复刻这一套（版式已对照原版截图核过），只是入口改成原版页里的格子。
      catalogInfo, openItem, wsIconOf, openRankShop,

      dailyData,

      activityRowsHtml, bindActivityRows,

      installTabVectors, syncTabVectors, setHomeLabel, wirePopTaps, mountClassicBack: mountRankShopBack, destroyClassicBack: destroyRankShopBack,

      catalogItems: allItems,

      weaponName:(id)=>{const v=weaponsMap.getValue(Number(id));return v?v.name:('武器'+id);},
      skillName:(id)=>{const v=skillsMap.getValue(Number(id));return v?v.name:('技能'+id);},
      gearName:(id)=>{const v=gearMap.getValue(Number(id));return v?v.name:('装备'+id);},

      stageFight, stageConfirm, stageTypeAvailable, towerEntryHtml},
    weaponIcon:(id,size)=>'<img class="icon" width="'+(size||56)+'" height="'+(size||56)+'" src="'+atlasIcon('weapon',id)+'">',
    skillIcon:(id,size)=>'<img class="icon" width="'+(size||56)+'" height="'+(size||56)+'" src="'+atlasIcon('skill',id)+'">',
    propIcon:(id,size)=>'<img class="icon" width="'+(size||56)+'" height="'+(size||56)+'" src="'+atlasIcon('prop',id)+'">'};
})();
