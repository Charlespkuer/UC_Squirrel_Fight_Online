// js/ssfight/ui-main.js —— 原版村庄主界面（main 帧）的 DOM/SVG 等价实现
(function () {
  'use strict';


  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  };



  function showNumber(num, mc, type, showZero, rightMove, numCount) {
    if (!mc || !mc.byName) return;
    if ((num === 0 || num == null) && showZero === 0) showZero = 1;
    if (numCount == null) numCount = 4;
    const str = String(num == null ? 0 : num);
    const len = str.length;
    if (rightMove == null || rightMove === 'right') {
      rightMove = numCount - len;
      if (num > 0) rightMove -= showZero;
    } else if (rightMove === 'left') {
      rightMove = 0;
    } else if (rightMove === 'center') {
      rightMove = ((numCount + len) % 2 === 0)
        ? (numCount - len) / 2
        : (numCount - (len + 1)) / 2 + 1;
      if (num > 0) rightMove -= showZero;
    }
    if (rightMove < 0) rightMove = 0;

    let digits = str.split('');
    const pad = numCount - digits.length;
    for (let i = 0; i < pad; ++i) digits.splice(0, 0, '0');

    let started = 0;
    for (let i = 0; i < digits.length; ++i) {
      digits[i] = Number(digits[i]);
      if (digits[i] === 0) {
        if (started === 0 && i + 1 > showZero) started = 1;
        if (started === 1) { digits.splice(i, 1); --i; }
        continue;
      }
      started = 2;
    }

    const clips = [];
    for (let i = 0; i < numCount; ++i) clips.push(mc.byName('num' + (i + 1)));
    for (let i = 0; i < rightMove; ++i) setFrame(clips[i], null);
    for (let i = 0; i < clips.length - rightMove; ++i) {
      const clip = clips[i + rightMove];
      if (i < digits.length) { setFrame(clip, digits[i] + 1 + type * 10); continue; }
      setFrame(clip, null);
    }
  }


  const VIP_TEXT_DX = 2.5;
  const VIP_TEXT_DY = -1.8;
  const VIP_NUM_SIGMA = 0.61;
  const VIP_LV_DEPTH = 18;
  const VIP_NUM_DEPTH = 19;


  function syncVipBadge(main) {
    const vip = main && main.byName ? main.byName('viplevel') : null;
    if (!vip || !vip.gotoAndStop) return false;
    const level = (window.State && State.vipLevel) ? Math.max(0, Number(State.vipLevel()) || 0) : 0;
    if (level > 0) {
      vip.gotoAndStop(1);
      const num = vip.byName('num');
      if (num && num.gotoAndStop) num.gotoAndStop(Math.min(num.frameCount(), level + 1));
      const type = vip.byName('vipType');
      if (type && type.gotoAndStop) type.gotoAndStop(1);

      if (vip.setDepthExtra) {
        vip.setDepthExtra(VIP_LV_DEPTH, 'translate(' + VIP_TEXT_DX + ',' + VIP_TEXT_DY + ')');
        vip.setDepthExtra(VIP_NUM_DEPTH, 'translate(' +
          (VIP_TEXT_DX / VIP_NUM_SIGMA).toFixed(3) + ',' +
          (VIP_TEXT_DY / VIP_NUM_SIGMA).toFixed(3) + ')');
      }
    } else {
      vip.gotoAndStop(2);
    }
    return true;
  }


  function setFrame(clip, frame) {
    if (!clip) return;
    let n = frame;
    if (n == null) {
      if (typeof clip.frameCount === 'function') n = clip.frameCount();
      else return;
    }
    if (typeof clip.gotoAndStop === 'function') clip.gotoAndStop(n);
  }
  // 联机自建页面共用的宿主壳与 SVG 小图标（合成 / 道具使用等页）。
  function createSubviewHost(className, aria, extra) {
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-sub ssfight-view ' + className + (extra ? ' ' + extra : '');
    host.setAttribute('aria-label', aria || '');
    ui.appendChild(host);
    return host;
  }
  function paintSvgIcon(clip, src, className) {
    if (!clip || !clip.g || !src) return;
    const host = clip.getContentHost ? clip.getContentHost() : clip.g;
    if (!host) return;
    for (const old of host.querySelectorAll('image.' + className)) old.remove();
    let box = { x: 0, y: 0, width: 44, height: 44 };
    try { if (clip.g.getBBox) box = clip.g.getBBox(); } catch (e) {}
    const base = Math.min(Math.max(24, Number(box.width) || 44), Math.max(24, Number(box.height) || 44));
    const size = Math.round(base * 0.86);
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.setAttribute('class', className);
    img.setAttribute('href', src);
    img.setAttribute('xlink:href', src);
    img.setAttribute('x', String((Number(box.x) || 0) + ((Number(box.width) || 44) - size) / 2));
    img.setAttribute('y', String((Number(box.y) || 0) + ((Number(box.height) || 44) - size) / 2));
    img.setAttribute('width', String(size));
    img.setAttribute('height', String(size));
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    img.setAttribute('pointer-events', 'none');
    host.appendChild(img);
  }
  function clipOf(host, name) {
    return host && host.byName ? host.byName(name) : null;
  }
  function setTextByName(host, name, str, opts) {
    const n = host && host.byName ? host.byName(name) : null;
    if (n) setText(n, str, opts);
    return n;
  }
  function freezeView(view) {
    freezeDescendants(view);
    if (view) view.playing = false;
  }
  function layoutScale(host, key) {
    if (!host) return 1;
    const prop = key || '__layoutProbe';
    let p = host[prop];
    if (!p || !p.isConnected) {
      p = document.createElement('div');
      p.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:0;pointer-events:none;visibility:hidden';
      host.appendChild(p);
      host[prop] = p;
    }
    const w = p.getBoundingClientRect().width;
    return w ? w / 100 : 1;
  }


  // 原版的 setText(文本框, 字符串)：把文本占位换成真实内容（村庄页用它写昵称）。
  // ⚠ 换行必须交给显示层（`SfRender.setText`）：SVG 的 `<text>` 不会把 `\r`/`\n` 当断行，
  // 自己写 `textContent` 的话多行文案会连成一行冲出字段框（祭坛那三行双倍几率就是这么坏的）。
  function setText(node, str, opts) {
    if (!node) return;
    if (window.SfRender && SfRender.setText && SfRender.setText(node, str, opts)) return;

    const list = node.querySelectorAll ? node.querySelectorAll('text') : null;
    if (list && list.length) {
      for (const t of list) t.textContent = str == null ? '' : String(str);
      return;
    }
    if (node.textContent !== undefined) node.textContent = str == null ? '' : String(str);
  }

  // 文本容器只按框宽横向裁，纵向放开：用字段已经画出来的那一行当尺子，把 `text`
  // 断进框宽（保留已有 `\n`）。`maxLines` 有值时末行加省略号，避免冲进下一条记录。
  const wrapToFieldCache = new WeakMap();
  function wrapToField(clip, text, maxLines) {
    const src = String(text == null ? '' : text);
    if (!clip || !clip.__textBox) return src;
    const tb = clip.__textBox;
    if (!tb.meta || !tb.meta.bd) return src;
    const W = tb.meta.bd[1] - tb.meta.bd[0] - (tb.meta.lm || 0) - (tb.meta.rm || 0);
    if (!(W > 8)) return src;
    // ⚠ 文本容器的 DOM 就是那个 `<g type="text">` 本身（`__textBox` 挂在它上面），不是 MovieClip。
    const el = clip.g || clip;
    const svg = el.ownerSVGElement || (el.ownerDocument && el.ownerDocument.querySelector('#ui svg')) || null;
    const vb = svg ? String(svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number) : null;
    const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const k = (rect && rect.width && vb && vb[2]) ? rect.width / vb[2] : 0;
    let unit = wrapToFieldCache.get(clip);
    if (!unit) {
      unit = 0;
      try {
        const node = el.querySelector && el.querySelector('text');
        const r = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        const n = node && node.textContent ? node.textContent.length : 0;
        if (k && r && r.width > 1 && n > 0) unit = (r.width / k) / n;
      } catch (e) { unit = 0; }
      if (!(unit > 0.2 && unit < 8)) {
        const h = parseFloat(tb.meta.fh) || 12;
        unit = h > 0 ? h : 12;
      }
      wrapToFieldCache.set(clip, unit);
    }
    const per = Math.max(3, Math.floor(W / unit));
    const out = [];
    for (const para of src.split('\n')) {
      let line = '', wid = 0;
      for (const ch of para) {
        const adv = ch.charCodeAt(0) < 0x2E80 ? 0.55 : 1;
        if (wid + adv > per && line) { out.push(line); line = ''; wid = 0; }
        line += ch; wid += adv;
      }
      out.push(line);
    }
    if (maxLines && out.length > maxLines) {
      out.length = maxLines;
      out[maxLines - 1] = out[maxLines - 1].slice(0, Math.max(1, per - 1)) + '…';
    }
    return out.join('\n');
  }

  // 悬停/点按切帧后重建的 `uc-pop` 壳：四个页面共用这一份，`freeze` 只差在
  // 状态/村庄页要把新壳重新按静态页策略冻结。
  function refreshShell(clip, freeze) {
    if (!clip || !clip.g) return;
    popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) wirePopPress(shell);
    if (freeze) freezeDescendants(clip);
  }

  // 昵称是 `main`（7039）里那个文本字段 `name`（7018，框宽 100.65 / 字号 14 / 居中）。
  // ⚠ `paint-order:stroke fill` 必须写：不写的话描边会画在填充之上，
  // 笔画细的中文字会被描边"吃"掉笔画（观感是字变糊、变细），这是 SVG 文本描边的经典坑。
  const NAME_STROKE = { ratio: 0.16, min: 1.4, color: '#000000' };
  function paintNicknameStroke(clip) {
    const node = clip && (clip.g || clip);
    if (!node || !node.querySelectorAll) return 0;
    // 字号从这个字段自己量：屏幕墨高 / 舞台→屏幕倍数 = 舞台字号。
    const svg = node.ownerSVGElement;
    const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const vb = svg ? String(svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number) : null;
    const unit = (rect && rect.width && vb && vb[2]) ? rect.width / vb[2] : 0;
    let n = 0;
    for (const t of node.querySelectorAll('text')) {
      let font = Number(t.getAttribute('font-size') || 0);
      if (!(font > 0)) {
        const box = t.getBoundingClientRect ? t.getBoundingClientRect() : null;
        font = (box && box.height && unit) ? (box.height / unit) : 14;
      }
      const w = Math.max(NAME_STROKE.min, font * NAME_STROKE.ratio);
      t.setAttribute('stroke', NAME_STROKE.color);
      t.setAttribute('stroke-width', w.toFixed(2));
      // `paint-order` 要同时写 CSS 与属性：Chrome 两条都认，属性那条在导出成图片时也留得住。
      t.setAttribute('paint-order', 'stroke fill');
      t.style.paintOrder = 'stroke fill';
      t.style.strokeLinejoin = 'round';
      n++;
    }
    return n;
  }

    const BUTTON_ACTIONS = {
    button1: 'bag',
    button2: 'status',
    button3: 'challenge',
    button4: 'messages',
    button5: 'system',
    homeButton: 'village',
  };


  const PRENTICE_FX = { filter: 'saturate(.9) brightness(.97)' };

  // 原版自带、本来就该一直播的装饰动画（白名单，见 `freezeDescendants`）：
  // "村庄 ui 本身的动态效果要保留，不要取消" —— 之前"整棵子树静音"把它一起冻住了。
  const KEEP_ANIMATED = new Set(['3586']);

  // 给主角穿装备 —— 原版 MainMovie.as:6737 chooseEquipLoader / :6785 getEquipBpData
  // 三张表都是生成器从原版抠出来的：tags-gear.json（容器素材）/ gear-frames.json（id→帧号）/
  const GEAR_BASE = 'images/ssfight/ui/';
  const MY_SELF_ID = '6988';
  let slotPlan = null;


  const DRESS_ENABLED = (() => {
    try {
      if (/[?&]dress=0\b/.test(location.search)) return false;
      if (localStorage.getItem('ssdz_classic_dress') === '0') return false;
    } catch (e) {}
    return true;
  })();
  // 原版 c 版穿戴链路：B 容器在装备帧上生成位图，持有者停在 frame + 1，
  // 容器号由 SWF 导出名核对，不能用错位的旧 TSV，更不能把大护肩换成普通袖口。
  function gearOpts() {
    const o = { scale: 1, anchor: 'topleft', mode: 'slot', odx: null, ody: 0 };
    try {
      const q = window.__gear || {};
      if (q.scale != null) o.scale = Number(q.scale);
      if (q.anchor != null) o.anchor = q.anchor;
      if (q.mode != null) o.mode = q.mode;
      if (q.odx != null) o.odx = Number(q.odx);
      if (q.ody != null) o.ody = Number(q.ody);
    } catch (e) {}
    return o;
  }
  // 每个部位的「画稿自身偏移」（局部单位，不是舞台单位）：锚点定下来之后，
  // ⚠ 2026-10 结论：上一批那两条"按部位/按装备"的偏移（type0 = [40,6]、117 = [-33,6]）
  const GEAR_OFFSET_BY_ID = {};
  const GEAR_OFFSET = { 0: [0, 0], 1: [0, 0], 2: [0, 0], 3: [0, 0] };
  function gearOffset(type, gearId, go) {
    if (go && go.odx != null) return [Number(go.odx), Number(go.ody || 0)];
    const byId = GEAR_OFFSET_BY_ID[Number(gearId)];
    if (byId) return byId;
    const o = GEAR_OFFSET[type] || [0, 0];
    return (o[0] || o[1]) ? o : null;
  }

  function attachWears(mainView, plan, host) {
    const me = mainView && mainView.byName && mainView.byName('main');
    const target = host || (me && me.byName && me.byName('myself'));
    if (!target || !target.attachChild) return 0;
    target.detachAll();
    const go = gearOpts();
    let n = 0;
    for (const p of plan) {
      const c = target.attachChild(p.symbol, p.frame, p.symbol);
      if (!c) continue;
      if (go.scale && go.scale !== 1) c.setExtraTransform('scale(' + go.scale + ')');
      n++;
    }
    return n;
  }


  async function loadGearTables() {
    if (slotPlan) return slotPlan;
    await SfRender.loadExtra('tags-gear.json');
    const j = (f) => SfRender.loadTable(f).catch(() => null);
    const [frames, slots] = await Promise.all([j('gear-frames.json'), j('gear-slots.json')]);
    if (!frames || !slots) return null;
    // 容器 id 从 gear-slots.json 的 container 声明里取（生成器同时写了名字与数字 id）
    const containerIds = {};
    for (const c of slots.container || []) containerIds[c.type] = c.ids;
    const portraitContainerIds = {};
    for (const c of slots.portraitContainer || []) portraitContainerIds[c.type] = c.ids;

    const keyOf = (g) => Number(g.type) + '|' + String(g.name || '');
    const q4 = new Map();
    for (const g of frames.gear) if (Number(g.quality) === 4) q4.set(keyOf(g), g.frame);
    const orangeFrameById = new Map();
    for (const g of frames.gear) {
      if (Number(g.quality) !== 3) continue;
      const f = q4.get(keyOf(g));
      if (f) orangeFrameById.set(Number(g.id), f);
    }
    slotPlan = {
      frameById: new Map(frames.gear.map((g) => [Number(g.id), g.frame])),
      orangeFrameById: orangeFrameById,
      slots: slots.slots, holders: slots.holders || [],
      containerIds: containerIds, portraitContainerIds: portraitContainerIds,
    };
    return slotPlan;
  }

  // 按当前存档里"穿戴中"的装备，算出：① 每个挂点该贴哪个容器的第几帧（slot 模式用）；
  function planWears(tables) {
    if (!tables || !(window.State && State.state && State.state() && State.myGears)) return null;
    const byType = new Map();
    for (const g of State.myGears()) {
      if (!g || !g.used) continue;
      const ty = Number(g.type);
      if (!byType.has(ty)) byType.set(ty, g);
    }
    if (!byType.size) return null;
    const bySlot = new Map();
    const parts = [];
    const holders = new Map();

    const frameFor = (g) => {
      const base = tables.frameById.get(Number(g.id));
      if (!base) return 0;
      const orange = g.orange === true || Number(g.quality) > 3;
      const of = orange && tables.orangeFrameById ? tables.orangeFrameById.get(Number(g.id)) : 0;
      // 强化档必须取 `ext` 数组里的最大 level：原版 `constructBpData` 用的是
      const raw = g.ext;
      let extMax = Array.isArray(raw)
        ? raw.reduce((m, e) => Math.max(m, Number(e && e.level) || 0), 0)
        : Math.max(0, Number(raw) || 0);
      extMax = Math.max(0, Math.min(3, extMax));
      const addr = (Number(g.type) === 0 || Number(g.type) === 1) && extMax > 0 ? extMax - 1 : 0;
      return (of || base) + addr;
    };
    for (const [ty, g] of byType) {
      const fr = frameFor(g);
      if (!fr) continue;
      for (const which of [0, 1]) {
        const sym = tables.containerIds[ty] && tables.containerIds[ty][which];
        if (!sym) continue;
        parts.push({ type: ty, which: which, symbol: String(sym), frame: fr, quality: Number(g.quality) || 0 });
      }
    }
    // 持有者：每个部位一个 189 帧的精灵，帧号 = 装备帧号 + 1，每帧放一个挂点。
    // ⚠ 这个 +1 是原版的写法，不是凑数：`chooseEquipLoader`（MainMovie.as:6767）里
    for (const h of tables.holders || []) {
      const g = byType.get(Number(h.type));
      const fr = g ? frameFor(g) : 0;
      if (fr) holders.set(String(h.id), fr + 1);
    }
    for (const s of tables.slots) {
      const g = byType.get(Number(s.type));
      const fr = g ? frameFor(g) : 0;
      if (fr) bySlot.set(String(s.id), { symbol: String(s.containerId), frame: fr, type: Number(s.type), gearId: Number(g.id), quality: Number(g.quality) || 0 });
    }
    if (!bySlot.size && !parts.length) return null;
    return { bySlot: bySlot, parts: parts, holders: holders, hasSlots: bySlot.size > 0 };
  }


  function inMyself(clip) {
    for (let c = clip; c; c = c.parent) if (c.tag && String(c.tag.id) === MY_SELF_ID) return true;
    return false;
  }


  const PCT_S = 0.92;
  const PCT_DX = 8;
  const PCT_RIGHT = 106.4;
  const PCT_CX = PCT_RIGHT * (1 - PCT_S) - PCT_DX;
  const PCT_CY = 39.2 - PCT_S * 40.45;
  const pctExtra = (sigma, tx, ty) => 'translate(' +
    (((PCT_S - 1) * tx + PCT_CX) / sigma).toFixed(3) + ',' +
    (((PCT_S - 1) * ty + PCT_CY) / sigma).toFixed(3) + ') scale(' + PCT_S + ')';

  const PCT_PCT_S = 1.22;
  const PCT_GLYPH_L = 108, PCT_GLYPH_CY = 39.05;
  const pctPctExtra = 'translate(' +
    ((PCT_RIGHT - PCT_DX) - PCT_GLYPH_L * PCT_PCT_S).toFixed(3) + ',' +
    (39.2 - PCT_GLYPH_CY * PCT_PCT_S).toFixed(3) + ') scale(' + PCT_PCT_S + ')';

  const PCT_NUM = { name: 'expNum', sigma: 0.68, tx: 81.75, ty: 35.05 };
  const PCT_DOT = { depth: 311, sigma: 0.84, tx: 98.5, ty: 44.95 };
  const PCT_PCT = { depth: 310 };
  // ⚠ 符号别写反：SVG 的 +y 是向下，所以"往下"是正数、"上移"是负数。
  const GOLD_NUM_DY_STAGE = -1.0;
  const GOLD_NUM_DY = (GOLD_NUM_DY_STAGE / 0.53).toFixed(3);

  // 主界面的金松果和胶囊是同一颗原版形状（7023）：导出时画稿被裁到元件包围盒，
  // 阴影左下角留下一条直边（帮助页/包裹里那颗 3131 是完整的）。这里把该形状里
  // 属于图标的路径藏掉，按它们的外框改贴同一颗无框矢量 `prop-8.svg`。
  const GOLD_ART = 'images/ui/icons/prop/prop-8.svg';
  // `prop-8.svg` 的 viewBox 不是画稿包围盒（四周约 6 单位留白），要对齐的是 ink 框；
  // 换素材时这两个框要一起量、一起改。
  const GOLD_ART_VB = { x: -0.6, y: -1.9, w: 46.7, h: 46.7 };
  const GOLD_ART_INK = { x: 6.05, y: 4.15, w: 33.4, h: 35.0 };

  const ENERGY_DX_STAGE = -1.5;
  const ENERGY_DX = (ENERGY_DX_STAGE / 0.75).toFixed(3);
  // ⚠ 不要用 `filter:drop-shadow()` 给昵称加柔影：Android 16（HyperOS 3 / WebView 133）
  const NAME_STYLE = [
    "font-family:'Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif",
    'font-weight:700',
    'fill:#fffdf0',
    'stroke:#4a290d',
    'stroke-width:.42',
    'stroke-linejoin:round',
    'paint-order:stroke fill',
    'letter-spacing:.4px',
    'text-shadow:0 .5px .55px rgba(58,28,4,.85)',
  ].join(';');
  function styleName(main) {
    const box = main.byName('name');
    if (!box || !box.querySelectorAll) return;
    for (const t of box.querySelectorAll('text')) {
      if (t.getAttribute('data-name-style') === '1') continue;
      t.setAttribute('style', (t.getAttribute('style') || '') + ';' + NAME_STYLE);
      t.setAttribute('data-name-style', '1');
    }
  }
  function applyHudTweaks(main) {
    const ex = main.byName('expNum');
    if (ex && ex.setExtraTransform) ex.setExtraTransform(pctExtra(PCT_NUM.sigma, PCT_NUM.tx, PCT_NUM.ty));
    if (main.setDepthExtra) {
      main.setDepthExtra(PCT_DOT.depth, pctExtra(PCT_DOT.sigma, PCT_DOT.tx, PCT_DOT.ty));
      main.setDepthExtra(PCT_PCT.depth, pctPctExtra);
    }
    for (let i = 1; i <= 8; i++) {
      const c = main.byName('num' + i);
      if (c && c.setExtraTransform) c.setExtraTransform('translate(0,' + GOLD_NUM_DY + ')');
    }
    for (const n of ['energy', 'maxEnergy']) {
      const c = main.byName(n);
      if (c && c.setExtraTransform) c.setExtraTransform('translate(' + ENERGY_DX + ',0)');
    }
    styleName(main);
  }

  // 形状路径的外框（只处理导出数据里的绝对坐标命令，够判断"这一段是胶囊还是图标"）。
  function pathBox(d) {
    const nums = String(d == null ? '' : d).match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = Number(nums[i]), y = Number(nums[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return x1 >= x0 ? { x0, x1, y0, y1 } : null;
  }

  function paintGoldArt(main) {
    const root = main && (main.g || main);
    if (!root || !root.querySelectorAll) return false;
    if (main.__goldArt && main.__goldArt.parentNode) return true;
    // 主界面里横条形状不止一颗（体力/经验条），所以认到胶囊后还要认出左边的图标再动手。
    for (const shape of root.querySelectorAll('g[type="shape"]')) {
      const paths = [];
      for (const n of shape.childNodes || []) {
        if (n.nodeName === 'path' || n.tagName === 'path') paths.push(n);
      }
      if (paths.length < 20) continue;
      const boxes = paths.map((p) => pathBox(p.getAttribute('d')));
      const pill = boxes.find((b) => b && b.x1 - b.x0 > 50 && b.y1 - b.y0 > 8 && b.y1 - b.y0 < 22);
      if (!pill) continue;
      const hide = [], icon = [];
      for (let i = 0; i < paths.length; i++) {
        const b = boxes[i];
        if (!b) continue;
        if (b.x1 < pill.x0 + 18 && b.y0 > pill.y0 - 8) { hide.push(paths[i]); icon.push(b); }
      }
      if (icon.length < 20) continue;
      const u = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const b of icon) {
        u.x0 = Math.min(u.x0, b.x0); u.x1 = Math.max(u.x1, b.x1);
        u.y0 = Math.min(u.y0, b.y0); u.y1 = Math.max(u.y1, b.y1);
      }
      const s = Math.min((u.x1 - u.x0) / GOLD_ART_INK.w, (u.y1 - u.y0) / GOLD_ART_INK.h);
      if (!Number.isFinite(s) || s <= 0) continue;
      for (const p of hide) p.style.display = 'none';
      const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      img.setAttribute('href', GOLD_ART);
      img.setAttribute('xlink:href', GOLD_ART);
      img.setAttribute('x', ((u.x0 + u.x1) / 2 - (GOLD_ART_INK.x + GOLD_ART_INK.w / 2 - GOLD_ART_VB.x) * s).toFixed(2));
      img.setAttribute('y', ((u.y0 + u.y1) / 2 - (GOLD_ART_INK.y + GOLD_ART_INK.h / 2 - GOLD_ART_VB.y) * s).toFixed(2));
      img.setAttribute('width', (GOLD_ART_VB.w * s).toFixed(2));
      img.setAttribute('height', (GOLD_ART_VB.h * s).toFixed(2));
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      img.setAttribute('pointer-events', 'none');
      shape.appendChild(img);
      main.__goldArt = img;
      return true;
    }
    return false;
  }

  // 生效中的药丸 → 主界面右上角三个状态格（原版 showStates）
  // 再把生效中的药丸按顺序 `attachMovie("大力丸2"…)` 挂进槽里、逐个 `_width/_height *= 0.71`。
  // ⚠ 2026-11 用户口径（本批）：去掉药丸外面的框、贴图放大，并保留剩余场次角标。
  const STATE_PILLS = [
    { id: 3, label: '大力丸' },
    { id: 4, label: '敏捷丸' },
    { id: 5, label: '速度丸' },
    { id: 7, label: '经验丸' },
    { id: 41, label: '超级大力丸' },
    { id: 42, label: '超级敏捷丸' },
    { id: 43, label: '超级速度丸' },
    { id: 44, label: '超级经验丸' },
  ];
  // 槽的画稿边长（用户单位）。原版 c1/c2/c3 都是 3414，画稿 42.3×42.3。
  // 所以槽的位置与大小只能算，不能量（量出来是 0 就把图标缩没了）。
  const STATE_SLOT = 42.3;

  const STATE_ICON_SCALE = 1.5;

  const STATE_ICON_NUDGE = {
    3: [0.0075, -0.0161],
    4: [0.0021, 0.0064],
    5: [-0.0075, -0.0343],
    7: [-0.0021, -0.0032],
    41: [0, 0],
    42: [0, 0],
    43: [0, 0],
    44: [0, -0.001],
  };

  const STATE_ICON_BASE = 'images/ui/icons/prop/prop-';
  // 主界面药丸只认自己 id 的矢量文件，并换一代 URL：WebView 对 /images/ 是 7 天 immutable，
  // 旧地址可能还留着重导前的错贴图（经验丸/大力丸串图、渐变 id 带冒号丢填色）。
  const STATE_PILL_BY_ID = new Map(STATE_PILLS.map((p) => [Number(p.id), p]));
  function pillIconSrc(id) {
    return STATE_ICON_BASE + Number(id) + '.svg?v=4';
  }
  function stateIconSrc(id) {
    if (STATE_PILL_BY_ID.has(Number(id))) return pillIconSrc(id);
    const classic = window.UI && window.UI.classic;
    if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(id);
    return STATE_ICON_BASE + Number(id) + '.png';
  }
  // 上一次真正写进宿主 DOM 的那个签名。
  // ⚠ 这不能当成"当前该显示什么"的缓存 —— 它必须跟着宿主 DOM 一起失效。
  let stateSig = '';

  const STATE_STAMP = 'stateStamp';

  function placementOf(clip) {
    const m = String((clip && clip.g && clip.g.__baseMa) || '').split(',').map(Number);
    if (m.length === 6 && m.every((v) => isFinite(v))) return m;
    return [1, 0, 0, 1, 0, 0];
  }

  function localScale(clip) {
    const m = placementOf(clip);
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  }
  // svg 的「用户单位 → 屏幕像素」比例：按根 viewBox 宽与实测宽算。
  // ⚠ 不逐层乘矩阵：`getScreenCTM` 的参考系在根时间轴那几层里对不上父级坐标系
  function unitScale(view) {
    const svg = view && view.root;
    if (!svg) return 0;
    const r = svg.getBoundingClientRect();
    const vb = String(svg.getAttribute('viewBox') || '0 0 320 196').split(/\s+/).map(Number);
    return (vb[2] && r.width) ? r.width / vb[2] : 0;
  }
  // SVG 用户坐标 → 屏幕坐标：用 SVG 的实测矩形 + clientWidth/Height + viewBox +
  // ⚠ 不走 getScreenCTM：iOS 15 的 WebKit 209220 会漏掉祖先 `#ui` 的 CSS scale，
  // ⚠ 也不能假设 x/y 缩放相同：全面屏下 `#ui` 的 `sx !== sy`，只用一个比例
  function userToClient(svg, x, y) {
    try {
      const map = (window.SfRender && SfRender.svgScreenMap) ? SfRender.svgScreenMap(svg) : null;
      if (map) return map.toClient(x, y);
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (!r || !vb || !r.width || !r.height || !vb.width || !vb.height) return null;
      const par = String(svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
      const scale = /\bslice\b/.test(par) ? Math.max(r.width / vb.width, r.height / vb.height)
        : Math.min(r.width / vb.width, r.height / vb.height);
      if (!(scale > 0)) return null;
      const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
      const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
      return {
        x: r.left + (r.width - vb.width * scale) * ax + (x - vb.x) * scale,
        y: r.top + (r.height - vb.height * scale) * ay + (y - vb.y) * scale,
      };
    } catch (e) { return null; }
  }
  function stateIconsHost(container) {
    if (!container) return null;
    let host = container.querySelector('.ssfight-states');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ssfight-states';
      host.setAttribute('aria-live', 'polite');
      container.appendChild(host);
    }
    return host;
  }
  // 当前生效的药丸（propsStates>0），按 STATE_PILLS 的顺序。
  function activeStatePills() {
    let states = {};
    try { states = (State.state() || {}).propsStates || {}; } catch (e) { return []; }
    return STATE_PILLS.filter((p) => states[p.id] > 0)
      .map((p) => ({ id: p.id, label: p.label, count: states[p.id] }));
  }
  function renderStateIcons(container, view) {
    const host = stateIconsHost(container);
    if (!host) return;
    const pills = activeStatePills();
    // 绝大多数时候没有生效中的限时用品：不要为了 0 颗药丸每秒量一次布局。
    if (!pills.length) {
      if (stateSig || host.firstChild) {
        stateSig = '';
        host.innerHTML = '';
        host.removeAttribute(STATE_STAMP);
        host.__posKey = '';
      }
      return;
    }
    const sig = pills.map((p) => p.id + ':' + p.count).join(',');

    if (sig !== stateSig || host.getAttribute(STATE_STAMP) !== sig) {
      stateSig = sig;
      host.setAttribute(STATE_STAMP, sig);
      host.innerHTML = pills.map((p) => '<span class="ssfight-state" data-pill="' + p.id + '" role="img"' +
        ' aria-label="' + esc(p.label + '：剩余 ' + p.count + ' 场战斗') + '"' +
        ' title="' + esc(p.label + '（剩余 ' + p.count + ' 场战斗）') + '">' +
        '<img alt="" src="' + stateIconSrc(p.id) + '">' +
        '<b>' + p.count + '</b></span>').join('');
      // 药丸节点是新建的，位置缓存必须失效，否则同一秒会跳过写样式。
      host.__posKey = '';
    }
    positionStateIcons(host, view);
  }
  // 把药丸块摆到原版槽位上（块中心 = 槽中心），大小按 svg 的实测缩放比换算。
  // ⚠ 坐标系里有个坑：`.ssfight-states` 这层是按设计尺寸 1170 排版的，
  function positionStateIcons(host, view) {
    const main = view && view.byName ? view.byName('main') : null;
    const boxEl = (view && view.el) || (host && host.parentNode);
    if (!main || !boxEl || !host) return;
    const hostRect = host.getBoundingClientRect();
    const k = unitScale(view);
    if (!k) return;

    const probe = stateLayoutProbe(host);
    const hostScale = probe.scale || 1;
    const fix = (screenPx) => (hostScale ? screenPx / hostScale : screenPx);
    // 原版三个槽（c1/c2/c3）的屏幕中心与边长 —— 它们是 `showStates` 的固定落点。
    // ⚠ 别拿 `getScreenCTM` 的行列式当总比例（`main` 7039 是单位矩阵，混乘会量成 61/383px）。
    const slots = ['c1', 'c2', 'c3'].map((name) => {
      const clip = main.byName(name);
      if (!clip || !clip.g) return null;
      const m = placementOf(clip);
      const px = m[4] + m[0] * sx0(clip) + m[2] * sy0(clip);
      const py = m[5] + m[1] * sx0(clip) + m[3] * sy0(clip);
      const p = (clip.parent === main && userToClient(view.root, px, py)) || toScreen(clip.parent, px, py);
      // k 已经是「SVG 用户单位 → 屏幕像素」，所以 slotSide 本身就是屏幕像素；
      // 不要再乘 hostScale（那是 CSS→屏幕的缩放）。多乘一次会让药丸再缩小 0.55 倍。
      const slotSide = STATE_SLOT * k * localScale(clip.parent) * localScale(clip);
      if (!(slotSide > 0)) return null;
      return { cx: p.x + slotSide / 2, cy: p.y + slotSide / 2, side: slotSide };
    }).filter(Boolean);
    if (!slots.length) return;
    const base = slots[0];
    const nodes = host.querySelectorAll('.ssfight-state');
    const n = nodes.length;

    const dx = slots.length >= 3 ? (slots[2].cx - slots[0].cx) / 2 : base.side;
    const dy = slots.length >= 3 ? (slots[2].cy - slots[0].cy) / 2 : 0;
    // 位置没变就不要每秒重写 8 个 style：写一次就会让下一次读布局重新排版。
    const posKey = [n, hostRect.left, hostRect.top, hostRect.width, hostRect.height, hostScale, k,
      slots.map((s) => [s.cx, s.cy, s.side].map((v) => Math.round(v * 100) / 100).join(',')).join('|')].join('|');
    if (host.__posKey === posKey) return;
    host.__posKey = posKey;

    // 超过原版 3 个槽时（力/敏/速/经验四颗全吃）：整行向左让位，最右一颗仍钉在 c3、
    // 顺序不变 —— 第 4 颗不会被吞掉，也不会把格子顶出右边界。
    const overflow = Math.max(0, n - slots.length);
    nodes.forEach((el, i) => {
      const slot = slots[Math.min(i, slots.length - 1)] || base;
      const center = overflow > 0
        ? { cx: base.cx + dx * (i - overflow), cy: base.cy + dy * (i - overflow), side: base.side }
        : slot;

      const pillSide = center.side;
      // `pillSide` 是屏幕像素目标；写进 DOM 的 width/height/--icon/--u 是 CSS px，
      // 这里把尺寸统一折回设计像素，桌面 hostScale=1 时结果不变。
      const sideCss = fix(pillSide);
      const iconCss = sideCss * STATE_ICON_SCALE;
      el.style.display = '';
      el.style.left = fix(center.cx - hostRect.left - pillSide / 2) + 'px';
      el.style.top = fix(center.cy - hostRect.top - pillSide / 2) + 'px';
      el.style.width = sideCss + 'px';
      el.style.height = sideCss + 'px';
      el.style.setProperty('--icon', iconCss.toFixed(3) + 'px');

      el.style.setProperty('--u', (sideCss / 80).toFixed(4) + 'px');

      const img = el.querySelector('img');
      const svg = img && /\.svg(?:$|\?)/i.test(img.getAttribute('src') || '');
      const nudge = svg ? (STATE_ICON_NUDGE[Number(el.getAttribute('data-pill'))] || [0, 0]) : [0, 0];
      el.style.setProperty('--nx', (iconCss * nudge[0]).toFixed(2) + 'px');
      el.style.setProperty('--ny', (iconCss * nudge[1]).toFixed(2) + 'px');
    });
  }

  function stateLayoutProbe(host) {
    // renderStateIcons() 重建 innerHTML 时会把探针一起清掉；只检查 `host.__probe` 是否存在
    // 安卓上药丸又缩回 17px。必须确认它仍然挂在当前 host 下。
    if (!host.__probe || host.__probe.parentNode !== host) {
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:0;pointer-events:none;visibility:hidden';
      host.appendChild(p);
      host.__probe = p;
    }
    const w = host.__probe.getBoundingClientRect().width;
    return { scale: w ? w / 100 : 1 };
  }

  function sx0(clip) { return clip && clip.__stateOrigin ? clip.__stateOrigin[0] : 0; }
  function sy0(clip) { return clip && clip.__stateOrigin ? clip.__stateOrigin[1] : 0; }

  function toScreen(node, lx, ly) {
    const g = node && node.g;
    const ctm = g && g.getScreenCTM && g.getScreenCTM();
    if (ctm) return { x: ctm.a * lx + ctm.c * ly + ctm.e, y: ctm.b * lx + ctm.d * ly + ctm.f };
    return { x: lx, y: ly };
  }


  function refreshValues(view) {
    const main = view && view.byName ? view.byName('main') : null;
    if (!main) return false;
    if (!(window.State && State.state && State.state())) return false;
    // 经典主界面没有服务端推送，也没有现代首页的 `drawHomeHud` 轮询；
    if (State.tickEnergy) { try { State.tickEnergy(); } catch (e) {} }
    const S = State.state();
    const nextExp = Math.max(1, (window.GData && GData.nextExp) ? GData.nextExp(S.level)
      : (S.nextExp || 1));

    const nameClip = main.byName('name');
    // 昵称一秒重写一次会反复重建文本/量宽度/写描边；只有名字或字段节点换了才做。
    if (view.__nameSig !== S.name || view.__nameClip !== nameClip) {
      view.__nameSig = S.name;
      view.__nameClip = nameClip;
      setText(nameClip, S.name);
      // 昵称最多 7 个汉字（英文/数字按 1/3 计，最多 21 个字母）。原版字段框只有
      styleName(main);
      if (window.SfRender && SfRender.fitTextWidth) {
        SfRender.fitTextWidth(nameClip, { ascii: 0.72, spacing: 0.4, min: 6 });
      }
      paintNicknameStroke(nameClip);
    }
    // 等级冻结 / 满级时经验会超过本级需求：主界面固定显示 99.9%（999‰），
    // 经验条本身仍拉到满格；真实 exp/need 只在状态页显示。
    const expOver = S.exp >= nextExp;
    setFrame(main.byName('expMc'), expOver ? 101 : Math.min(101, Math.ceil(S.exp * 100 / nextExp) + 1));
    const pct = expOver ? 999 : Math.floor(S.exp * 1000 / nextExp);
    // ⚠ 经验数字写进的是 main.expNum（原版 :9385/:9389/:9393/:9397 传的都是 main.expNum）。
    const expMc = main.byName('expNum');
    setFrame(main.byName('point'), 1);
    if (pct > 9) {
      showNumber(pct, expMc, 0, 0, 'right');
    } else if (pct > 0) {
      showNumber(pct, expMc, 0, 1, 'right');
    } else {
      showNumber(pct, expMc, 0, 1, 'center');
      setFrame(main.byName('point'), 2);
    }
    const ePct = Math.ceil(S.energy * 100 / Math.max(1, S.maxEnergy));
    setFrame(main.byName('energyMc'), ePct + 1);
    showNumber(S.energy, main.byName('energy'), 0, 0, 'right');
    showNumber(S.maxEnergy, main.byName('maxEnergy'), 0, 0, 'left');
    showNumber(Math.max(0, S.goldPoint | 0), main, 0, 0, 'left', 8);
    showNumber(S.level, main.byName('level'), 0, 0, 'left');
    const door = main.byName('homeButton');
    if (door && door.style) door.style.display = S.level > 19 ? '' : 'none';
    // :9430-9436 徒弟栏：按徒弟数切帧 —— 第 1/2/3 帧分别摆 1/2/3 个徒弟；
    // 复刻的徒弟上限就是 3（State.apprenticeCap），与原版帧正好对齐。
    const pr = main.byName('prentices');
    if (pr && pr.gotoAndStop) {
      const n = Math.min(3, ((S.prentices || []).length) | 0);
      pr.gotoAndStop(n > 0 ? n : pr.frameCount());
    }

    if (pr && pr.g) {
      pr.g.style.filter = PRENTICE_FX.filter;
      pr.g.style.opacity = '';
    }
    // :9440-9464 showNewMessage：原版默认 gotoAndStop(2)＝隐藏红点，服务器说有新消息才 gotoAndStop(1)。
    // 这个"看到哪了"记在存档（`State.msgSeenAt`，见 js/state.js）：单机写 save/progress.json，
    // 联机版由 `markMessagesSeen` 这个 sync 动作写到服务端存档（shared/actions.json）。
    const nm = main.byName('newMessage');
    // 所以红点也必须等到 level >= 2 才允许点亮，否则它会悬在隐藏的消息键位置。
    const canSeeMessages = Number(S.level) >= 2;
    if (nm && nm.gotoAndStop) nm.gotoAndStop(canSeeMessages && hasNewMessages() ? 1 : 2);


    for (const cn of ['c1', 'c2', 'c3']) {
      const c = main.byName(cn);
      if (c && c.gotoAndStop) c.gotoAndStop(2);
      if (c && c.g && c.g.style) c.g.style.display = 'none';
    }

    if (main.byName('c1')) renderStateIcons(view.el, view);
    // :15947-15966 showViplevel：超级松鼠（VIP）生效 → 等级标；未开通/到期 → 空帧。
    // 联机版和单机版共用：`State.vipLevel()` 读存档里的 `vip`，服务端 patch 回来后
    syncVipBadge(main);

    const bits = S.level <= 1 ? [0, 0, 1, 0, 0] : S.level === 2 ? [0, 0, 1, 1, 1] : [1, 1, 1, 1, 1];
    ['button1', 'button2', 'button3', 'button4', 'button5'].forEach((bn, i) => {
      const bc = main.byName(bn);
      const bnode = bc && (bc.g || bc);
      if (bnode && bnode.style) bnode.style.display = bits[i] ? '' : 'none';
      // ⚠ 每次重刷（1s 一次）都要把这五键重新"静默"一遍：换帧会重建子树，新出生的装饰默认会自己播。
      // 但指针正停在上面的那一颗不能动 —— 它的装饰正在放"选中"那一遍动画，
      if (bc && bc.gotoAndStop && !hoveredButtons.has(bn)) { if (bc.frame !== 0) { try { bc.gotoAndStop(1); } catch (e) {} } settleButton(bc); }
    });
    applyHudTweaks(main);
    // 礼包/活动图标的有奖动效要跟着可领取状态走：领完奖回到主界面就停，不能一直闪。
    syncActivityVisibility(view);
    syncActivityAttention(view);
    updateEnergyTip(view);
    return true;
  }

  // 主界面体力条悬停提示：距下次自然恢复 1 点体力还有多久。
  // - 文案每秒随 refreshValues 刷新；体力满/超出上限时明确说“不恢复”。
  function updateEnergyTip(view) {
    const host = view && view.el;
    const main = view && view.byName ? view.byName('main') : null;
    if (!host || !main || !host.isConnected) return;
    let hit = host.querySelector('.ssfight-energy-hover');
    let tip = hit && hit.querySelector('.ssfight-energy-tip');
    if (!hit) {
      hit = document.createElement('div');
      hit.className = 'ssfight-energy-hover';
      tip = document.createElement('span');
      tip.className = 'ssfight-energy-tip';
      tip.setAttribute('role', 'status');
      hit.appendChild(tip);
      host.appendChild(hit);
    }
    const s = State.state();
    let text;
    if (s.energy > s.maxEnergy) text = '体力已超过自然上限（' + s.energy + '/' + s.maxEnergy + '），不会自然恢复';
    else if (s.energy >= s.maxEnergy) text = '体力已满';
    else {
      const cd = State.energyCountdown ? State.energyCountdown() : '';
      text = cd ? ('距离恢复 1 点体力还有 ' + cd) : '正在恢复体力…';
    }
    if (tip.textContent !== text) tip.textContent = text;
    // 位置只跟布局/体力上限有关；倒计时文字每秒在变，但不必每秒量 5 个包围盒。
    const posKey = [s.energy, s.maxEnergy, host.clientWidth, host.clientHeight].join('|');
    if (hit.__tipKey === posKey) return;
    const nodes = ['energyMc', 'energy', 'maxEnergy']
      .map((n) => { const c = main.byName(n); return c && (c.g || c); })
      .filter(Boolean);
    if (!nodes.length) { hit.style.display = 'none'; return; }
    hit.__tipKey = posKey;
    const hr = host.getBoundingClientRect();
    const hs = (stateLayoutProbe(host).scale) || 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    hit.style.display = '';
    hit.style.left = (((x0 - hr.left) / hs) - 2) + 'px';
    hit.style.top = (((y0 - hr.top) / hs) - 2) + 'px';
    hit.style.width = (((x1 - x0) / hs) + 4) + 'px';
    hit.style.height = (((y1 - y0) / hs) + 4) + 'px';
  }

  // 把按钮接上复刻版的动作 + 原版 showButton 的悬停选中态（MainMovie.as:5804-5835：
  // 映射成鼠标悬停。绝不能让按钮元件自己播放：那 2 帧来回切就是用户看到的"图标闪烁"。
  // ⚠ 2026-10 用户口径（第一百四十六批）：选中帧里的装饰动画要照原样播。
  function wireButtons(view) {
    const main = view.byName('main');
    if (!main) return;

    const rewrap = (c) => {
      if (c && c.g && c.g.querySelector('g.uc-pop')) popWrap(c, true);
      else addHitArea(c, true);
    };

    setupHomeBar(main);
    for (const name in BUTTON_ACTIONS) {
      const clip = main.byName(name);
      const node = clip && (clip.g || clip);
      if (!node || !node.style) continue;
      if (clip.gotoAndStop) clip.gotoAndStop(1);
      settleButton(clip);
      node.style.cursor = 'pointer';
      node.style.pointerEvents = 'auto';
      // setupHomeBar 已经给了固定命中框；再量一次当前帧只是多一次 getBBox。
      if (!clip.__fixedHit) measureHitBox(clip);
      // 热区按所有帧的并集铺：这五键的四个帧是"常态/选中/禁用/空"，
      // `addHitArea` 内部有缓存（`__frameBoxes`），下面两次重铺不会重新量。
      addHitArea(clip, true);
      // ⚠ 每次换帧（悬停进/出）都会重建这个元件的子树，补的那块点击矩形会被一起清掉 ——
      node.addEventListener('mouseenter', () => {
        hoveredButtons.add(name);
        if (clip.gotoAndStop) { clip.gotoAndStop(2); settleButton(clip); rewrap(clip); playButtonDeco(clip); }
      });
      node.addEventListener('mouseleave', () => {
        hoveredButtons.delete(name);
        if (clip.gotoAndStop) { clip.gotoAndStop(1); stopPlayDecos(clip); settleButton(clip); rewrap(clip); }
      });
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        pressFlash(clip, 1, null);
        if (window.UI && UI.runAction) UI.runAction(BUTTON_ACTIONS[name]);
      });
    }

    wireActivityButton(view);
  }
  // 「消息」红点（new）
  // 这个"看到哪了"记在存档里（`State.msgSeenAt`，见 js/state.js 的 normalizeSave）。
  // ⚠ 2026-10 用户口径：以前记在 localStorage，必须改掉。
  function newestMessageAt() {
    try {
      const list = (window.State && State.battleHistory) ? State.battleHistory() : [];
      return list && list.length ? (Number(list[0].createdAt) || 0) : 0;
    } catch (e) { return 0; }
  }
  function hasNewMessages() {
    if (window.__SSDZ_ONLINE__) {
      // 联机版只认服务端的「被动消息未读」：主动挑战写在本地战报里、不写服务端消息，
      const badge = window.Online && Online.badge;
      return !!(window.Online && Online.ready && badge && Number(badge.total) > 0);
    }
    const t = newestMessageAt();
    if (!t) return false;
    const seen = (window.State && State.msgSeenAt) ? State.msgSeenAt() : 0;
    return t > seen;
  }
  // 打开消息页时调一次：把"看到哪了"推到最新（红点随即熄灭，并写进存档 / 服务端）。
  // 联机版还要让服务端把已到达的被动消息标已读（`/api/messages/seen`）。
  function markMessagesSeen() {
    try { if (window.State && State.markMessagesSeen) State.markMessagesSeen(); } catch (e) {}
    if (window.__SSDZ_ONLINE__ && window.Online && Online.markMessagesSeen) {
      try { void Online.markMessagesSeen(); } catch (e) {}
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 量一次并记住（用常态帧的包围盒）：悬停帧可能更大，跟着变会让点击区忽大忽小、边缘发飘。
  // ⚠ 这里存的是 `{x,y,w,h}`；`addHitArea` 必须按同一套键名读 —— 2026-10 之前两边一个读
  function measureArtwork(clip) {
    const host = clip.getContentHost ? clip.getContentHost() : clip.g;
    const hits = Array.from(host.querySelectorAll('rect[data-hit]'));
    const displays = hits.map((hit) => hit.style.display);
    for (const hit of hits) hit.style.display = 'none';
    try { return host.getBBox(); }
    finally { hits.forEach((hit, i) => { hit.style.display = displays[i]; }); }
  }
  function measureHitBox(clip) {

    if (clip.__hitBox && clip.__hitBoxFrame === clip.__shownFrame) return clip.__hitBox;
    try {
      const b = measureArtwork(clip);
      if (b && b.width && b.height) {
        clip.__hitBox = { x: b.x, y: b.y, w: b.width, h: b.height };
        clip.__hitBoxFrame = clip.__shownFrame;
      }
    } catch (e) {}
    return clip.__hitBox || null;
  }

  const HIT_PAD = 0.1;
  const HIT_PAD_MIN = 2.5;
  // ⚠ 量"所有帧的并集"必须先量、再包动效壳：拨帧会重建 `<g>` 的子节点。
  const HOME_BAR = ['button1', 'button2', 'button3', 'button4', 'button5'];
  const HOME_BAR_PAD = 3;

  // 同一元件号/帧数的按钮并集是静态几何；主页每次重挂都重测 15 次 getBBox 是白烧。
  const frameUnionCache = new Map();
  function measureFrameUnion(clip) {
    const key = (clip && clip.tag && clip.tag.id ? String(clip.tag.id) : '') + '|' + (clip && clip.frames ? clip.frames.length : 1);
    if (clip && clip.tag && clip.tag.id && frameUnionCache.has(key)) return frameUnionCache.get(key);
    let box = null;
    const absorb = (b) => { if (b && b.width && b.height) box = unionBox(box, { x: b.x, y: b.y, w: b.width, h: b.height }); };
    const keep = clip.frame;
    const n = clip.frames ? clip.frames.length : 1;
    for (let i = 0; i < n; i++) {
      clip.frame = i;
      try { clip.showFrame(); } catch (e) { continue; }
      try { absorb(measureArtwork(clip)); } catch (e) {}
    }
    if (clip.frame !== keep) { clip.frame = keep; try { clip.showFrame(); } catch (e) {} }
    if (clip && clip.tag && clip.tag.id && box) frameUnionCache.set(key, box);
    return box;
  }

  function toParentBox(clip, box) {
    const m = placementOf(clip);
    if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) return null;
    return { x: m[0] * box.x + m[4], y: m[3] * box.y + m[5], w: m[0] * box.w, h: m[3] * box.h };
  }

  function toLocalBox(clip, box) {
    const m = placementOf(clip);
    const a = m[0] || 1, d = m[3] || 1;
    return { x: (box.x - m[4]) / a, y: (box.y - m[5]) / d, w: box.w / a, h: box.h / d };
  }

  function setupHomeBar(main) {
    try {
      const clips = [], boxes = [];
      for (const n of HOME_BAR) {
        const c = main.byName(n);
        if (!c || !c.g) return;
        clips.push(c);
        boxes.push(measureFrameUnion(c));
      }
      const par = [];
      for (let i = 0; i < clips.length; i++) {
        if (!boxes[i]) return;
        const b = toParentBox(clips[i], boxes[i]);
        if (!b) return;
        par.push(b);
      }
      let y0 = Infinity, y1 = -Infinity;
      for (const b of par) { y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h); }
      for (let i = 0; i < clips.length; i++) {
        const left = i === 0 ? par[i].x - HOME_BAR_PAD : (par[i - 1].x + par[i - 1].w + par[i].x) / 2;
        const right = i === clips.length - 1 ? par[i].x + par[i].w + HOME_BAR_PAD
          : (par[i].x + par[i].w + par[i + 1].x) / 2;
        clips[i].__fixedHit = toLocalBox(clips[i], { x: left, y: y0, w: right - left, h: y1 - y0 });
      }
    } catch (e) {  }
  }

  function addHitArea(clip, animate) {
    try {
      let box = null;
      const merge = (b) => {
        if (!b || !b.width || !b.height) return;
        if (!box) { box = { x: b.x, y: b.y, w: b.width, h: b.height }; return; }
        const x = Math.min(box.x, b.x), y = Math.min(box.y, b.y);
        const x2 = Math.max(box.x + box.w, b.x + b.width), y2 = Math.max(box.y + box.h, b.y + b.height);
        box = { x: x, y: y, w: x2 - x, h: y2 - y };
      };

      const fixed = clip.__fixedHit;
      if (fixed) box = { x: fixed.x, y: fixed.y, w: fixed.w, h: fixed.h };
      else {
        const base = measureHitBox(clip);
        if (base) merge({ x: base.x, y: base.y, width: base.w, height: base.h });

        else { try { merge(measureArtwork(clip)); } catch (e) {} }
        if (animate && clip.frames && clip.frames.length > 1) {
          const keep = clip.frame;
          const union = (clip.__frameBoxes) || (clip.__frameBoxes = measureFrameBoxes(clip));
          for (const b of union) merge(b);
          if (clip.frame !== keep) { clip.frame = keep; try { clip.showFrame(); } catch (e) {} }
        }
      }
      if (!box || !box.w || !box.h) return;

      const padX = fixed ? 0 : Math.max(box.w * HIT_PAD, HIT_PAD_MIN);
      const padY = fixed ? 0 : Math.max(box.h * HIT_PAD, HIT_PAD_MIN);
      let r = clip.__hitArea;
      if (r && !r.parentNode) r = null;
      if (!r) {
        r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('fill', 'transparent');
        r.setAttribute('pointer-events', 'all');
        r.setAttribute('data-hit', '1');
        clip.__hitArea = r;
        clip.g.appendChild(r);
      }
      r.setAttribute('x', box.x - padX); r.setAttribute('y', box.y - padY);
      r.setAttribute('width', box.w + padX * 2); r.setAttribute('height', box.h + padY * 2);
      // 铺完就把这颗元件登记进"点击路由"（见上面那一大段注释）：热区只当尺子，
      // 真正判定归属的是路由器 —— 否则相邻元件重叠的热区会互相抢，谁画得晚谁赢。
      registerHit(clip, animate);
    } catch (e) {  }
  }
  // 把一个多帧元件每一帧的包围盒量出来（只量一次，结果缓存在 `__frameBoxes` 上）。
  function measureFrameBoxes(clip) {
    const out = [];
    const keep = clip.frame;
    const n = clip.frames ? clip.frames.length : 0;
    for (let i = 0; i < n; i++) {
      clip.frame = i;
      try { clip.showFrame(); } catch (e) { continue; }
      let b = null;
      try { b = measureArtwork(clip); } catch (e) { b = null; }
      if (b && b.width && b.height) out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
    if (clip.frame !== keep) { clip.frame = keep; try { clip.showFrame(); } catch (e) {} }
    return out;
  }
  // 为什么不能再让每个元件各铺一块透明矩形就完事：
  // ⚠ 元件自己的指针事件关掉之后 CSS 的 `:hover` 不再触发，悬停观感改由
  const ROUTER_KEY = '__sfRouter';
  // 触摸设备判定（只用于放行“没有 pointerdown 的原生 click”这一条 iOS 兜底）。
  function touchCapable() {
    try {
      return ('ontouchstart' in window) ||
        ((window.navigator && window.navigator.maxTouchPoints) || 0) > 0 ||
        !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) { return false; }
  }

  function unionBox(a, b) {
    if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x, y: y, w: x2 - x, h: y2 - y };
  }
  const inBox = (b, x, y) => !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

  function routerOf(svg) {
    if (svg[ROUTER_KEY]) return svg[ROUTER_KEY];
    const list = [];
    const r = { svg: svg, list: list, hovered: null, downOn: null };
    // 元件在屏幕坐标里的框：直接问浏览器，不再经 `getScreenCTM()` 换算。
    // WebKit 209220（iOS 15.5/15.6 仍复现）：getScreenCTM 漏掉祖先 CSS transform 的
    // `useHit` = 量透明热区（底栏五键的固定选择面积）；否则先暂时藏掉热区，
    const screenBox = (clip, useHit) => {
      try {
        const hit = clip.__hitArea;
        if (useHit && hit && hit.getBoundingClientRect) {
          const r = hit.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        const old = hit && hit.style ? hit.style.display : null;
        if (hit && hit.style) hit.style.display = 'none';
        let r = null;
        try { r = clip.g.getBoundingClientRect(); } finally {
          if (hit && hit.style) hit.style.display = old;
        }
        if (r && r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
      } catch (e) {}
      return null;
    };
    // 指针直接落在某个已登记元件的画面像素上：用浏览器的命中测试找归属。
    // 比“按包围盒猜”更准，也不依赖 CTM；透明热区/空白处再由下面的盒子逻辑兜底。
    const domPick = (cx, cy) => {
      if (typeof document === 'undefined' || !document.elementFromPoint) return null;
      let el = null;
      try { el = document.elementFromPoint(cx, cy); } catch (e) { return null; }
      if (!el || !(el === svg || svg.contains(el))) return null;
      for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
        for (const e of list) {
          if (e.clip && e.clip.g === n && e.clip.g.isConnected !== false) return e;
        }
        if (n === svg) break;
      }
      return null;
    };
    // 按当前布局刷新每个元件的"内容框 / 热区"（屏幕坐标）。
    // 命中框按「视图矩形 + 元件当前帧」缓存：pointermove 每帧重算会让每个登记件都
    // 先改 display 再 getBoundingClientRect（同步 flush 布局），鼠标一滑就是十几次强制布局。
    const refresh = () => {
      let viewKey = '';
      try {
        const sr = svg.getBoundingClientRect();
        viewKey = sr.left + '|' + sr.top + '|' + sr.width + '|' + sr.height;
      } catch (e) { viewKey = ''; }
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e.clip.g || e.clip.g.isConnected === false) {
          if (r.hovered === e) r.hovered = null;
          if (r.downOn === e) r.downOn = null;
          list.splice(i, 1);
        }
      }
      for (const e of list) {
        let hidden = false;
        for (let n = e.clip.g; n && n !== svg; n = n.parentNode) {
          if ((n.style && (n.style.display === 'none' || n.style.visibility === 'hidden')) ||
              (n.getAttribute && n.getAttribute('visibility') === 'hidden')) { hidden = true; break; }
        }
        if (hidden) { e.content = e.pad = null; e.__boxKey = ''; continue; }

        // `__shownFrame` 换了才可能改包围盒；缩放/窗口变化由 viewKey 兜住。
        const boxKey = viewKey + '|' + (e.clip.__shownFrame == null ? '' : e.clip.__shownFrame) +
          '|' + (e.clip.__hitBoxFrame == null ? '' : e.clip.__hitBoxFrame) +
          '|' + (e.clip.__fixedHit ? 'f' : '');
        if (e.content && e.__boxKey === boxKey) continue;
        e.__boxKey = boxKey;
        if (e.clip.__fixedHit) {
          e.content = screenBox(e.clip, true);
          e.pad = null;
          continue;
        }
        const box = screenBox(e.clip, false);
        e.content = box;
        if (box) {
          const px = Math.max(box.w * HIT_PAD, HIT_PAD_MIN * 2), py = Math.max(box.h * HIT_PAD, HIT_PAD_MIN * 2);
          e.pad = { x: box.x - px, y: box.y - py, w: box.w + px * 2, h: box.h + py * 2 };
        } else e.pad = null;
      }
    };
    const pick = (cx, cy) => {

      if (r.enabled === false) return null;
      // 指针直接落在可见画稿上时走浏览器命中测试，不必先把所有元件的屏幕框重算一遍。
      const dom = domPick(cx, cy);
      if (dom) return dom;
      refresh();

      for (const e of list) {
        if (!e.clip.g || e.clip.g.isConnected === false) continue;
        if (!e.clip.__fixedHit) continue;
        if (inBox(e.content, cx, cy)) return e;
      }

      let best = null, bestArea = Infinity;
      for (const e of list) {
        if (!e.clip.g || e.clip.g.isConnected === false) continue;
        if (!inBox(e.content, cx, cy)) continue;
        const area = e.content.w * e.content.h;
        if (area < bestArea) { bestArea = area; best = e; }
      }
      if (best) return best;
      let bestDist = Infinity;
      for (const e of list) {
        if (!e.clip.g || e.clip.g.isConnected === false) continue;
        if (!inBox(e.pad, cx, cy)) continue;
        const dx = cx - (e.content.x + e.content.w / 2), dy = cy - (e.content.y + e.content.h / 2);
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = e; }
      }
      return best;
    };
    const shellOf = (e) => (e && e.clip.g ? e.clip.g.querySelector(':scope > g.uc-pop') : null);
    const fire = (e, type, extra) => {
      if (!e || !e.clip.g || typeof MouseEvent !== 'function') return;
      const init = Object.assign({ bubbles: false, cancelable: true, view: window }, extra || {});
      try { e.clip.g.dispatchEvent(new MouseEvent(type, init)); } catch (err) {}
    };
    const enter = (e) => {
      const sh = shellOf(e);
      if (sh) sh.classList.add('sf-hover');
      fire(e, 'mouseenter', { clientX: r.lastX, clientY: r.lastY });
    };
    const leave = (e, toNode) => {
      const sh = shellOf(e);
      if (sh) { sh.classList.remove('sf-hover'); sh.classList.remove('pressed'); }
      fire(e, 'mouseleave', { clientX: r.lastX, clientY: r.lastY, relatedTarget: toNode || null });
    };
    r.move = (cx, cy) => {
      r.lastX = cx; r.lastY = cy;
      if (r.enabled === false) return;
      const win = pick(cx, cy);
      if (win === r.hovered) return;
      const prev = r.hovered;
      r.hovered = win;
      if (prev) leave(prev, win ? win.clip.g : null);
      if (win) enter(win);
    };
    r.clear = () => {
      if (r.hovered) { leave(r.hovered, null); r.hovered = null; }
      const sh = shellOf(r.downOn);
      if (sh) sh.classList.remove('pressed');
      r.downOn = null;
    };
    r.hit = (cx, cy) => pick(cx, cy);

    r.setEnabled = (on) => {
      const want = on !== false;
      if (r.enabled === want) return false;
      r.enabled = want;
      if (!want) r.clear();          // 关掉时先把当前悬停态收干净，否则会留一行亮着
      return true;
    };
    r.isEnabled = () => r.enabled !== false;

    svg.style.pointerEvents = 'auto';
    svg.addEventListener('pointermove', (ev) => r.move(ev.clientX, ev.clientY));
    svg.addEventListener('pointerleave', () => {
      if (!r.releasedOn) r.cancelled = true;
      r.clear();
    });
    svg.addEventListener('pointercancel', () => { r.cancelled = true; r.releasedOn = null; r.clear(); });
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      r.cancelled = false;
      r.releasedOn = null;
      r.move(ev.clientX, ev.clientY);
      r.downOn = r.hovered;
      const sh = shellOf(r.hovered);
      if (sh) { sh.classList.remove('pressed'); void sh.getBoundingClientRect(); sh.classList.add('pressed'); }
    });
    const release = (ev) => {
      r.move(ev.clientX, ev.clientY);
      const sh = shellOf(r.downOn);
      if (sh) sh.classList.remove('pressed');
      r.releasedOn = r.downOn === r.hovered ? r.downOn : null;
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('click', (ev) => {

      if (ev.__sfSynth) return;
      r.move(ev.clientX, ev.clientY);
      const e = r.hovered;
      const down = r.releasedOn || r.downOn;
      r.downOn = null;
      r.releasedOn = null;
      if (!e) return;
      // ⚠ iOS 15 的 WKWebView 有一类“只合成 click、不派发 pointerdown/up”的轻点
      // （Safari 在 SVG 上的既有行为，见 touch-fallback 的注释）。这时 down 为空，
      // 鼠标拖拽仍保留 down === e 的校验（down 非空且不一致时下面照样 return）。
      const touchClickWithoutDown = ev.detail > 0 && !down && !r.cancelled && touchCapable();
      if (ev.detail > 0 && !touchClickWithoutDown && (r.cancelled || down !== e)) return;
      fire(e, 'click', { clientX: ev.clientX, clientY: ev.clientY, button: 0, detail: 1 });
    });
    svg[ROUTER_KEY] = r;
    return r;
  }

  function registerHit(clip, animate) {
    const svg = (clip && clip.g && clip.g.ownerSVGElement) || null;
    if (!svg) return null;
    const r = routerOf(svg);
    clip.g.style.pointerEvents = 'none';
    const hit = clip.__hitArea;
    if (hit) hit.setAttribute('pointer-events', 'none');
    const existing = r.list.find((e) => e.clip === clip);
    if (existing) { existing.animate = !!animate; return r; }
    // ⚠ 已经登记过的元件的子孙不再单独登记。反过来的情况（先登记了子孙、再登记祖先）
    // 为什么必须这么做：`popWrap()` 会顺带给被包的元件量一次热区 —— 底栏五键选中帧上那颗
    const isAncestor = (a, b) => { for (let c = b; c; c = c.parent) if (c === a) return true; return false; };
    if (r.list.some((e) => e.clip && e.clip !== clip && isAncestor(e.clip, clip))) return r;
    for (let i = r.list.length - 1; i >= 0; i--) {
      const e = r.list[i];
      if (!e.clip || e.clip.g.isConnected === false || isAncestor(clip, e.clip)) {
        if (r.hovered === e) r.clear();
        r.list.splice(i, 1);
      }
    }
    r.list.push({ clip: clip, animate: !!animate, content: null, pad: null });

    return r;
  }

  function unregisterHit(clip) {
    const svg = (clip && clip.g && clip.g.ownerSVGElement) || null;
    const r = svg && svg[ROUTER_KEY];
    if (!r) return;
    const i = r.list.findIndex((e) => e.clip === clip);
    if (r.hovered && r.hovered.clip === clip) r.clear();
    if (r.downOn && r.downOn.clip === clip) r.downOn = null;
    if (i >= 0) r.list.splice(i, 1);
  }

  const PRESS_MS = 170;
  // `onFrame`（可选）：每拨到一帧就回调一次 —— 给"状态精灵"用，
  // 那边需要把闪的这一帧也钉住（否则节拍器下一拍就把它推走，见 ui-status.js 的注释）。
  function pressFlash(clip, idle, after, onFrame) {
    if (!clip || !clip.gotoAndStop) return;
    const back = (idle == null) ? 1 : idle;
    try { clip.gotoAndStop(2); } catch (e) {}
    if (onFrame) { try { onFrame(2); } catch (e) {} }
    addHitArea(clip);
    playButtonDeco(clip);
    if (after) after();
    if (clip.__pressTimer) clearTimeout(clip.__pressTimer);
    clip.__pressTimer = setTimeout(() => {
      clip.__pressTimer = 0;
      try { clip.gotoAndStop(back); } catch (e) {}
      if (onFrame) { try { onFrame(back); } catch (e) {} }

      if (back === 1) { stopPlayDecos(clip); settleButton(clip); }
      else { settleButton(clip); playButtonDeco(clip); }
      addHitArea(clip);
      if (after) after();
    }, PRESS_MS);
  }

  function pinFrame(clip, n) {
    if (!clip) return;
    try {
      if (clip.pinFrame) clip.pinFrame(n);
      else if (clip.gotoAndStop) { clip.playing = false; clip.gotoAndStop(n); }
    } catch (e) {}
  }
  // 把一棵子树立成静态页：子树里所有多帧元件"出生即冻结"，而且换帧重建出来的新实例
  // ⚠ 这是"UI 在自己所有可达帧之间乱跳"的唯一正解。历史写法是"事后把当时的实例
  // ⚠ 也不再需要"例外名单"（老的 `skip` / `protect` 两个参数已删除）：那时候要列例外，
  function freezeDescendants(clip) {
    if (!clip || !clip.setStaticPolicy) return;
    clip.setStaticPolicy({ keepIds: [...KEEP_ANIMATED] });
  }
  // 收集某个元件子树里所有多帧子元件（不含它自己）。返回实例数组。
  // ⚠ `nodes` 里存的是 `{node, clip, wrap}`，只有 `clip` 才是可拨帧的元件；形状没有 `clip`。
  function multiFrameKids(clip, out) {
    const list = out || [];
    if (!clip || !clip.nodes) return list;
    for (const rec of clip.nodes.values()) {
      const c = rec.clip;
      if (!c) continue;
      if (c.frames && c.frames.length > 1) list.push(c);
      multiFrameKids(c, list);
    }
    return list;
  }

  function settleButton(clip, skip) {
    for (const c of multiFrameKids(clip)) {
      if (skip && skip.has(c)) continue;
      pinFrame(c, 1);
    }
  }
  // 把这个按钮的那颗"选中帧装饰"从头放一遍（放完停在末帧，移开时由 `settleButton` 拨回第 1 帧）。
  // ⚠ `playOnce` 内部会把这一颗的 `__pinFrame` 摘掉（它要自己推帧），所以"停"必须显式来一遍 ——
  function playButtonDeco(clip) {
    for (const c of multiFrameKids(clip)) playOnce(c, { loop: true });
  }

  function stopPlayDecos(clip) {
    for (const c of multiFrameKids(clip)) stopPlay(c);
  }

  // 主界面松鼠的「说话板子」（原版库元件 3704）
  // `wordsArray` 的 19 条原文在 `MainMovie_frame1.as:19139`；服务端 `config.xml` 的
  // 说明原版允许服务端覆盖这批文案。复刻没有这条下发通道，所以内置同一份。
  const TALK_BOARD = '3704';

  const TALK_AT = { x: 107, y: 24 };

  const TALK_FRAME = 40;
  // `MainMovie_frame1.as:19139` 的 wordsArray 原文（顺序、标点照抄，半角逗号也是原版如此）
  const WALK_WORDS = [
    '武器和技能可以升级,升级后会变得更强。',
    '体力是随时间恢复的哦~',
    '招收徒弟可以给你带来额外的收获。',
    '吃药可以补充体力,提升各种属性。',
    '升级武器需要金松果和武器卷轴。',
    '升级技能需要金松果和技能卷轴。',
    '闲着真无聊,快去挑战吧！',
    '带着徒弟去打关卡要轻松得多哦~',
    '关卡的星级代表难度,星星越多越困难哦~',
    '10级就可以去挑战关卡了！',
    '我每天都想见到你,记得来看我哦~',
    '关卡通过后有经验和金松果的奖励。',
    '关卡通过以后，还有几率获得装备碎片哦！',
    '装备可以增加基本属性，让你变得更强大！',
    '20级就可以融合装备啦，神兵利器亲手打造！',
    '30级以上的松鼠可以参加天梯赛！',
    '我要当超级松鼠，享受特权~',
    '想要极品装备和超强道具，就去参加天梯赛！',
    '带我去挑战木头人，看看我有多强！',
    // ⚠ 下面这条不是原版 wordsArray（原版 19 条到上一条为止）：用户 2026-11 点名加的一条，
    '本复刻版本的作者在github上人称Charlespkuer哦',
  ];

  // `squirrelTalk()` 的复刻：把 3704 挂到 `main` 的 (107,24)、停在气泡那帧并先藏起来。
  // ⚠ 为什么气泡不挂在 main 里（2026-11-05 用户口径「对话框提示要能遮住药丸提示」）：
  async function initTalkBoard(view, container) {
    const main = view && view.byName ? view.byName('main') : null;
    const me = main && main.byName ? main.byName('myself') : null;
    if (!main || !me || typeof me.frameCount !== 'function') return null;
    // 素材换了 / 帧数不够时宁可不显示，也不要在错误帧上闪一下。
    if (me.frameCount() < TALK_FRAME) return null;
    if (!container || !window.SfRender || !SfRender.mountSymbol) return null;
    const host = document.createElement('div');
    host.className = 'ssfight-talk';
    host.setAttribute('aria-hidden', 'true');
    container.appendChild(host);
    // 落点 = 把 viewBox 左上角挪到 (−107,−24)：`translate(107,24)` 与「viewBox 反向平移」
    // 在画面上是等价的，而后者不需要给外层 `<svg>` 写 transform（老 WebView 对
    const tl = (SfRender.timeline && SfRender.timeline()) || {};
    const w = Number(tl.Fw) || 320, h = Number(tl.Fh) || 196;
    const xi = ((tl.Ft && Number(tl.Ft.xi)) || 0) - TALK_AT.x;
    const yi = ((tl.Ft && Number(tl.Ft.yi)) || 0) - TALK_AT.y;
    let board = null;
    try {
      board = await SfRender.mountSymbol(host, TALK_BOARD, { viewBox: xi + ' ' + yi + ' ' + w + ' ' + h });
    } catch (e) {
      if (window.__errs) window.__errs.push('talk board: ' + (e && e.message));
      if (host.parentNode) host.parentNode.removeChild(host);
      return null;
    }
    if (!board) { if (host.parentNode) host.parentNode.removeChild(host); return null; }
    pinFrame(board, 1);
    if (board.root) board.root.classList.add('sf-talk-board');
    return { me: me, board: board, host: host, shown: false };
  }


  function tickTalkBoard(talk) {
    if (!talk || !talk.board || !talk.host) return;
    if (!talk.host.isConnected) return;
    const show = talk.me.frame >= TALK_FRAME - 1;
    if (show === talk.shown) return;
    talk.shown = show;
    if (show) {
      const words = WALK_WORDS[Math.floor(Math.random() * WALK_WORDS.length)];
      setText(talk.board.byName('words'), words, { wrap: true });
    }
    talk.host.classList.toggle('on', show);
    talk.host.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  // 收起整层（离开主界面 / 重新挂载时）：视图要 `destroy()`，否则它会留在播放注册表里空转。
  function destroyTalkBoard(talk) {
    if (!talk) return;
    if (talk.board && typeof talk.board.destroy === 'function') { try { talk.board.destroy(); } catch (e) {} }
    if (talk.host && talk.host.parentNode) talk.host.parentNode.removeChild(talk.host);
  }

  // 主界面「只看风景」：点舞台中央那块透明热区把 HUD 与按钮淡出，展开后点任意位置淡回。
  // 只淡 depth >= 157 的那批；背景 1 / 徒弟 2 / 主角 91 / 地面阴影 155,156 与气泡不在名单里。
  const FOCUS_UI_MIN_DEPTH = 157;
  // 左右各留 ~50 舞台单位：活动键与村门键的可点区比画稿略宽，中央热区不能压到它们。
  const FOCUS_HIT = { x: 98, y: 74, w: 124, h: 62 };
  const FOCUS_HIDE_CLASS = 'sf-focus-hide';

  function setHomeRouterEnabled(svg, on) {
    const r = svg && svg[ROUTER_KEY];
    return !!(r && r.setEnabled && r.setEnabled(on !== false));
  }

  function setupFocusMode(view, container) {
    const main = view && view.byName ? view.byName('main') : null;
    const svg = view && view.root;
    if (!main || !main.nodes || !svg || !container) return null;
    const ui = document.getElementById('ui');
    const tl = view.timeline || {};
    const stageW = Number(tl.Fw) || 320, stageH = Number(tl.Fh) || 196;
    const hit = document.createElementNS(SVGNS, 'rect');
    hit.setAttribute('class', 'ssfight-focus-hit');
    hit.setAttribute('fill', '#000');
    hit.setAttribute('fill-opacity', '0');
    hit.setAttribute('pointer-events', 'all');
    hit.setAttribute('role', 'button');
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('aria-label', '隐藏界面，只看风景');
    hit.setAttribute('aria-pressed', 'false');
    hit.style.cursor = 'pointer';
    hit.style.touchAction = 'manipulation';
    hit.style.outline = 'none';
    // 收起时只在舞台中央铺；展开后铺满整屏，点任意位置都能淡回。
    const setHitBox = (full) => {
      hit.setAttribute('x', full ? 0 : FOCUS_HIT.x);
      hit.setAttribute('y', full ? 0 : FOCUS_HIT.y);
      hit.setAttribute('width', full ? stageW : FOCUS_HIT.w);
      hit.setAttribute('height', full ? stageH : FOCUS_HIT.h);
    };
    setHitBox(false);
    // 挂在根 svg 最后：盖过 main 的所有子元件，但不进 main 的显示列表，切帧不会重建它。
    svg.appendChild(hit);

    const nodes = [];
    for (const [depth, rec] of main.nodes) {
      if (depth < FOCUS_UI_MIN_DEPTH) continue;
      const node = rec && rec.node;
      if (!node || !node.classList) continue;
      node.classList.add(FOCUS_HIDE_CLASS);
      nodes.push(node);
    }

    let active = false;
    const apply = (on) => {
      active = !!on;
      container.classList.toggle('sf-focus', active);
      if (ui) ui.classList.toggle('sf-home-focus', active);
      setHitBox(active);
      hit.setAttribute('aria-pressed', active ? 'true' : 'false');
      hit.setAttribute('aria-label', active ? '恢复主界面' : '隐藏界面，只看风景');
      // 路由是按包围盒判定的，透明度变 0 不会自己失效；不关掉的话点空白处还能点开按钮。
      setHomeRouterEnabled(svg, !active);
    };
    const toggle = () => apply(!active);
    const onClick = (e) => {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      toggle();
    };
    const onKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };
    const stopBubble = (e) => e.stopPropagation();
    const onDocKey = (e) => { if (active && e.key === 'Escape') { e.preventDefault(); apply(false); } };
    hit.addEventListener('click', onClick);
    hit.addEventListener('keydown', onKey);
    hit.addEventListener('pointerdown', stopBubble);
    hit.addEventListener('pointerup', stopBubble);
    document.addEventListener('keydown', onDocKey, true);

    return {
      isActive: () => active,
      toggle,
      apply,
      destroy: () => {
        hit.removeEventListener('click', onClick);
        hit.removeEventListener('keydown', onKey);
        hit.removeEventListener('pointerdown', stopBubble);
        hit.removeEventListener('pointerup', stopBubble);
        document.removeEventListener('keydown', onDocKey, true);
        if (hit.parentNode) hit.parentNode.removeChild(hit);
        if (active) {
          if (ui) ui.classList.remove('sf-home-focus');
          container.classList.remove('sf-focus');
          setHomeRouterEnabled(svg, true);
        }
        for (const node of nodes) node.classList.remove(FOCUS_HIDE_CLASS);
      },
    };
  }

  // `refreshValues()` 每秒重刷一次，会把五键重新"静默"（换帧会重建子树，新出生的装饰默认会自己播）。
  // 指针正停在上面那一颗的装饰正在放"选中"那一遍动画，不能被动 —— 所以记一份名字名单跳过它
  const hoveredButtons = new Set();


  let current = null;
  let timer = 0;
  let viewSeq = 0;

  let talkOverlay = null;
  let focusMode = null;

  async function mount(container) {
    if (!window.SfRender) throw new Error('SfRender 未加载');
    destroy();
    const mine = viewSeq;
    // ⚠ 这一层是村庄主页，要打上 `ssfight-home-page` 标记：`classic.css` 有一条
    container.classList.add('ssfight-home-page');
    // 装备表要在建树之前备好：挂点是在建树过程中实例化的，plan 必须那一刻就绪。
    let plan = null;
    if (DRESS_ENABLED) {
      try { plan = planWears(await loadGearTables()); }
      catch (e) { if (window.__errs) window.__errs.push('装备表加载失败：' + (e && e.message)); }
    }
    if (mine !== viewSeq || container.isConnected === false) return null;
    const view = await SfRender.mount(container, {
      frame: 20,
      onClip: (plan && gearOpts().mode === 'slot') ? (clip) => {
        // ⚠ 只给主角自己穿。原版这两条链路都先判 `targetPath(mc).split(".")[2] == "myself"`
        if (!inMyself(clip)) return;

        const hf = plan.holders.get(String(clip.tag.id));
        if (hf != null) { clip.pinFrame(hf); return; }
        const p = plan.bySlot.get(String(clip.tag.id));
        if (p) {

          if (clip.g && clip.g.setAttribute) clip.g.setAttribute('slot', String(clip.tag.id));
          const go = gearOpts();
          const off = gearOffset(p.type, p.gearId, go);
          // 锚点：`'none'` = 按"容器原点对齐挂点原点"落地（原版 attachBitmap 的语义，见 gearOpts），
          // 这时不能把 'none' 传进 anchorToBBox —— 它只认 center/bottom/topleft，
          const anchor = (!go.anchor || go.anchor === 'none') ? null : go.anchor;

          const tail = off ? ('translate(' + off[0] + ',' + off[1] + ')') : '';
          clip.setSymbol(p.symbol, p.frame, go.scale, anchor, tail);
          // 挂点留在原版骨骼的深度。骨头还带着裸臂/拳头，整体提升会改掉前后手顺序；
        }
      } : null,
    });
    if (mine !== viewSeq || container.isConnected === false) { view.destroy(); return null; }
    if (plan && gearOpts().mode === 'attach') { try { attachWears(view, plan.parts); } catch (e) {} }

    if (plan && gearOpts().mode === 'root') { try { attachWears(view, plan.parts, view); } catch (e) {} }
    view.el = container;
    refreshValues(view);
    try { paintGoldArt(view.byName('main')); } catch (e) { if (window.__errs) window.__errs.push('gold art: ' + (e && e.message)); }
    wireButtons(view);

    const talk = await initTalkBoard(view, container);
    if (mine !== viewSeq || container.isConnected === false) {
      destroyTalkBoard(talk);
      view.destroy();
      return null;
    }
    talkOverlay = talk;
    focusMode = setupFocusMode(view, container);
    if (talk) {
      const prevTick = view.onTick;
      view.onTick = () => {
        if (typeof prevTick === 'function') { try { prevTick(); } catch (e) {} }
        try { tickTalkBoard(talk); } catch (e) { if (window.__errs) window.__errs.push('talk board: ' + (e && e.message)); }
      };
    }

    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}

    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (view.root.isConnected === false) { if (current === view) destroy(); return; }
      // refreshValues 内部已经调过 renderStateIcons；不要再每秒重排一次药丸。
      try { refreshValues(view); } catch (e) { if (window.__errs) window.__errs.push('ui-main tick: ' + (e && e.message)); }
    }, 1000);
    current = view;
    return {
      view,
      refresh: () => refreshValues(view),
      showNumber,
      destroy: () => { if (current === view) destroy(); else view.destroy(); },

      byName: (n) => view.byName(n),
    };
  }

  function destroy() {
    closeActivityDialog();
    viewSeq++;
    if (timer) { clearInterval(timer); timer = 0; }
    // 药丸那层 DOM 跟着宿主一起被摘掉了 —— 缓存也要一起失效，否则下次挂载会以为
    stateSig = '';

    hoveredButtons.clear();

    for (const t of playingTimers.values()) clearTimeout(t);
    playingTimers.clear();
    villagePlaying.clear();
    // 气泡那一层是独立视图（自己在播放注册表里），必须显式 destroy ——
    destroyTalkBoard(talkOverlay);
    talkOverlay = null;
    if (focusMode) { try { focusMode.destroy(); } catch (e) {} focusMode = null; }
    if (current) {
      try { if (current.destroy) current.destroy(); } catch (e) {}
      current = null;
    }
  }

  // 经典主页「活动」按钮（原版 3963）
  // 原版 `MainMovie.as:8586 showActivity()` 在服务端活动公告非空时：
  // 生成器（`gen-ssfight-ui.cjs --activity`）按原版 attachMovie 的语义补了一条
  const ACTIVITY_BTN = 'activityBtn';

  function activityClip(view) {
    const main = view && view.byName ? view.byName('main') : null;
    return main && main.byName ? main.byName(ACTIVITY_BTN) : null;
  }


  function activityAttention() {
    try {
      if (!State.dailyStatus().claimed) return true;
      if (State.questClaimable() > 0) return true;
      const t = (window.ClassicExtras && ClassicExtras.tributeStatus) ? ClassicExtras.tributeStatus() : null;
      return !!(t && t.claimable);
    } catch (e) { return false; }
  }

  function activityUnlocked() {
    try { return Number(State.state().level) >= 3; } catch (e) { return false; }
  }
  function syncActivityAttention(view) {
    const b = activityClip(view);
    if (!b || !b.g) return false;
    // 1~2 级按钮被隐藏时不挂 attention；否则读屏/调试里会看到一个"可领取"的隐藏按钮。
    if (b.g.style.display === 'none') {
      b.g.classList.remove('attention');
      b.g.setAttribute('aria-label', '活动');
      return false;
    }
    const att = activityAttention();
    b.g.classList.toggle('attention', att);
    b.g.setAttribute('aria-label', att ? '活动，有可领取的奖励' : '活动');
    return att;
  }
  function syncActivityVisibility(view) {
    const b = activityClip(view);
    if (!b || !b.g) return false;
    const on = activityUnlocked();
    b.g.style.display = on ? '' : 'none';
    b.g.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) {
      b.g.setAttribute('tabindex', '0');
      addHitArea(b);
    } else {
      b.g.removeAttribute('tabindex');
      unregisterHit(b);
    }
    return on;
  }

  function wireActivityButton(view) {
    const b = activityClip(view);
    if (!b || !b.g) return;
    const inner = b.byName ? b.byName('button1') : null;
    const idle = () => { if (inner && inner.gotoAndStop) { try { inner.gotoAndStop(1); } catch (e) {} } };
    b.g.classList.add('sf-activity-btn');
    b.g.setAttribute('role', 'button');
    b.g.setAttribute('aria-label', '活动');
    b.g.style.cursor = 'pointer';
    idle();
    measureHitBox(b);
    addHitArea(b);
    b.g.addEventListener('mouseenter', () => { if (inner && inner.gotoAndStop) { try { inner.gotoAndStop(2); } catch (e) {} } });
    b.g.addEventListener('mouseleave', idle);
    b.g.addEventListener('click', (e) => { e.stopPropagation(); openActivityDialog(); });
    b.g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openActivityDialog(); }
    });
    syncActivityVisibility(view);
    syncActivityAttention(view);
  }

  // 「活动」弹窗：原版 `对话框`（4692）第 8 帧
  // 原版是服务端公告分页，这里只有一页，写当天的活动/奖励摘要。
  let activityDialog = null;

  function closeActivityDialog() {
    const d = activityDialog;
    if (!d) return;
    activityDialog = null;
    if (d.onKey) { try { document.removeEventListener('keydown', d.onKey, true); } catch (e) {} }
    if (d.onResize) { try { window.removeEventListener('resize', d.onResize); } catch (e) {} }
    if (d.view) { try { d.view.destroy(); } catch (e) {} }
    if (d.host && d.host.parentNode) d.host.parentNode.removeChild(d.host);
    if (d.prevFocus && d.prevFocus.isConnected) {
      try { d.prevFocus.focus({ preventScroll: true }); } catch (e) {}
    }
  }


  function wireActivityDialogButton(clip, onFire) {
    if (!clip || !clip.g) return;
    const idle = () => {
      try { clip.gotoAndStop(1); } catch (e) {}
      addHitArea(clip);
    };
    clip.g.setAttribute('role', 'button');
    clip.g.setAttribute('aria-label', '返回');
    clip.g.setAttribute('tabindex', '0');
    clip.g.style.cursor = 'pointer';
    idle();
    clip.g.addEventListener('mouseenter', () => {
      try { clip.gotoAndStop(2); } catch (e) {}
      addHitArea(clip);
    });
    clip.g.addEventListener('mouseleave', idle);
    clip.g.addEventListener('click', (e) => { e.stopPropagation(); pressFlash(clip, 1, onFire); });
    clip.g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFire(); }
    });
  }

  // 4692 第 8 帧的画稿是 320×196，正文按舞台的百分比铺在画稿内侧。
  const ACTIVITY_STAGE_RATIO = 320 / 196;
  function fitActivityStage(host, stage) {
    const h = Math.max(0, Math.round(host.clientHeight));
    if (!h) return;
    stage.style.height = h + 'px';
    stage.style.width = Math.round(h * ACTIVITY_STAGE_RATIO) + 'px';
  }

  async function openActivityDialog() {
    if (activityDialog) return;
    const ui = document.getElementById('ui');
    if (!ui || !window.SfRender || !SfRender.mountSymbol) return;
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-home ssfight-sub sf-activity-dialog';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', '活动');
    const stage = document.createElement('div');
    stage.className = 'sf-activity-stage';
    host.appendChild(stage);
    ui.appendChild(host);
    const dialog = { host, stage, view: null, prevFocus: document.activeElement, onKey: null, onResize: null };
    activityDialog = dialog;
    // `aspect-ratio` 在老 WebView（如 WebView 83）无效，舞台宽度会退回 SVG 默认的 300px，
    // 正文被挤成竖条；这里按宿主高度直接定宽，`clientHeight` 不受 #ui 的 CSS 缩放影响。
    fitActivityStage(host, stage);
    dialog.onResize = () => { if (activityDialog === dialog) fitActivityStage(host, stage); };
    window.addEventListener('resize', dialog.onResize);
    dialog.onKey = (e) => {
      if (e.key !== 'Escape') return;

      if (document.querySelector('.classic-modal-overlay')) return;
      closeActivityDialog();
    };
    document.addEventListener('keydown', dialog.onKey, true);
    try {
      await SfRender.loadExtra('tags-fight-result.json');
      // 联机版每日任务由服务端按天生成：打开面板先拉一次权威存档，
      // 跨天/换号时拿到的是服务端今天的题面，不是本机残留的旧列表。
      if (window.Online && Online.ready && Online.syncState) {
        try { await Online.syncState(); } catch (e) {}
      }
      if (activityDialog !== dialog || !host.isConnected) { closeActivityDialog(); return; }
      const view = await SfRender.mountSymbol(stage, '4692', { frame: 8, label: '活动' });
      if (activityDialog !== dialog || !host.isConnected) { view.destroy(); closeActivityDialog(); return; }
      dialog.view = view;
      fitActivityStage(host, stage);
      const info = view.byName('info');

      if (info && info.g) info.g.style.visibility = 'hidden';

      for (const n of ['left', 'right']) {
        const c = view.byName(n);
        if (c && c.g) c.g.style.visibility = 'hidden';
        if (c) unregisterHit(c);
      }

      const body = document.createElement('div');
      body.className = 'sf-activity-body';
      stage.appendChild(body);

      const dailyApi = (window.UI && UI.classic && UI.classic.dailyData) ? UI.classic : null;
      let data = dailyApi ? dailyApi.dailyData() : null;

      function renderBody() {
        if (!dailyApi || !data) {
          body.innerHTML = '<p class="sf-activity-empty">活动数据暂不可用</p>';
          return;
        }
        body.innerHTML = dailyApi.activityRowsHtml(data.d, data.tribute, data.quests);
        dailyApi.bindActivityRows(body, data, () => { data = dailyApi.dailyData(); renderBody(); });
      }

      renderBody();

      const back = view.byName('button1');
      if (back) wireActivityDialogButton(back, closeActivityDialog);


      host.setAttribute('tabindex', '-1');
      try { host.focus({ preventScroll: true }); } catch (e) {}
    } catch (e) {
      if (window.__errs) window.__errs.push('activity dialog: ' + (e && e.message));
      closeActivityDialog();
    }
  }

  // 真正的村庄页（根时间轴帧 30 / 根元件 `homeMc` 7140）
  // 注意别和主菜单页搞混：帧 20 的 `main`（7039）才是底栏五键那个主界面；
  const VILLAGE_BUTTONS = {
    button6: 'village-altar',
    button8: 'village-beast',
    button9: 'village-miracle',
    button10: 'village-war',
  };
  const VILLAGE_LABEL = {
    'village-altar': '祭坛', 'village-beast': '幻兽牧场',
    'village-miracle': '神迹', 'village-war': '征战',
  };

  const VILLAGE_MC_ACTIONS = { mc1: 'village-altar', mc4: 'village-beast', mc3: 'village-miracle', mc5: 'village-war' };

  const VILLAGE_PILL_OF = {};
  for (const [pill, act] of Object.entries(VILLAGE_BUTTONS)) VILLAGE_PILL_OF[act] = pill;
  // 带 CSS 悬停/按下动效的村庄元件：四个地点胶囊 + 「回家」，以及四处立绘。
  // ⚠ 用途分两档（别混）：胶囊 / 「回家」那几颗的"常态/选中"两帧是静态图，
  // CSS 那记微放大就是它们唯一的悬停动效；四处立绘则是真有多帧动画的（见下），
  const VILLAGE_POP_TARGETS = {};
  for (const n of Object.keys(VILLAGE_BUTTONS)) VILLAGE_POP_TARGETS[n] = 1;
  for (const n of Object.keys(VILLAGE_MC_ACTIONS)) VILLAGE_POP_TARGETS[n] = 1;
  VILLAGE_POP_TARGETS.mainButton = 1;
  // 这些立绘是状态帧（祭坛/幻兽/神迹的等级外观，征战的开/关），原版是
  // ⚠ 用户 2026-10 进一步澄清："鼠标移动到 ui 上的时候会播放连续的 ui 变化图像，但这个图像

  // 正在放自带动画的村庄元件（= 立绘 mc1/mc3/mc4/mc5）。
  // ⚠ 用实例而不是名字做键：`popWrap` / 换帧都会重建 `<g>`，但 `MovieClip` 实例是稳定的。
  const villagePlaying = new Set();

  const VILLAGE_PLAY_MS = 72;

  const REPAIR_SYMBOL = '5614';
  const REPAIR_BUNDLE = 'tags-repair.json';
  const REPAIR_AT = {
    mc1: { x: 450, y: 250, scale: 1 },
    mc3: { x: 190, y: 120, scale: 0.7 },
    mc4: { x: 400, y: 100, scale: 1 },
  };
  let repairBundle = 0;
  let repairBundlePromise = null;
  function ensureRepairBundle() {
    if (repairBundle === 2) return Promise.resolve(true);
    if (repairBundlePromise) return repairBundlePromise;
    repairBundle = 1;
    repairBundlePromise = SfRender.loadExtra(REPAIR_BUNDLE).then(() => {
      repairBundle = 2; repairBundlePromise = null; return true;
    }, () => {
      repairBundle = -1; repairBundlePromise = null; return false;
    });
    return repairBundlePromise;
  }
  // 把元件从头播一遍（放完停在最后一帧；`loop` 为真则循环播，直到 `stopPlay` 叫停）。
  // 但这里必须自己走：一是立绘要"放完停在最后一帧"（节拍器只管循环推进），
  const playingTimers = new Map();
  function playOnce(clip, opts) {
    if (!clip || !clip.gotoAndStop) return false;
    const o = opts || {};
    const last = Math.max(1, clip.frameCount ? clip.frameCount() : 1);
    if (last < 2) return false;
    const first = Math.max(1, Math.min(last, o.from || 1));
    stopPlay(clip);
    clip.playing = false;
    // ⚠ 这里必须把"钉帧"摘掉 —— 这是上一批"立绘一动不动"的真正原因。
    clip.__pinFrame = null;
    if (clip.holdAnim) clip.holdAnim(true);
    villagePlaying.add(clip);
    clip.gotoAndStop(first);
    keepWrapped(clip);
    let f = first;
    const step = () => {
      if (f >= last) {
        playingTimers.delete(clip);
        villagePlaying.delete(clip);
        if (o.loop) { f = first; clip.gotoAndStop(first); keepWrapped(clip); playingTimers.set(clip, setTimeout(step, VILLAGE_PLAY_MS)); }
        return;
      }
      f++;
      try { clip.gotoAndStop(f); } catch (e) {}
      keepWrapped(clip);
      playingTimers.set(clip, setTimeout(step, VILLAGE_PLAY_MS));
    };
    playingTimers.set(clip, setTimeout(step, VILLAGE_PLAY_MS));
    return true;
  }

  function stopPlay(clip) {
    const t = playingTimers.get(clip);
    if (t) { clearTimeout(t); playingTimers.delete(clip); }
    villagePlaying.delete(clip);
    if (clip && clip.holdAnim) clip.holdAnim(false);
  }

  function keepWrapped(clip) {
    if (!clip || !clip.g || !clip.g.isConnected) return;
    popWrap(clip, true);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) wirePopPress(shell);
  }

  function popWrap(clip, animate) {
    if (!clip || !clip.g) return false;
    let pop = clip.g.querySelector(':scope > g.uc-pop');
    if (!pop) {
      pop = el('g');
      pop.setAttribute('class', 'uc-pop');
      clip.g.appendChild(pop);
    }
    clip.setContentHost(pop);
    for (const n of Array.from(clip.g.childNodes)) {
      if (n === pop) continue;
      if (n.nodeType === 1 && n.tagName && String(n.tagName).toLowerCase() === 'defs') continue;
      pop.appendChild(n);
    }

    addHitArea(clip, animate);
    const hit = clip.__hitArea;
    if (hit && hit.parentNode !== pop) pop.appendChild(hit);
    return true;
  }

  function popPick(clip) {
    const shell = clip && clip.g && clip.g.querySelector(':scope > g.uc-pop');
    if (shell && window.SfUiFeedback) SfUiFeedback.pick(shell);
  }
  function wirePopPress(node) {
    if (node && window.SfUiFeedback) SfUiFeedback.bind(node, { hover: false });
  }
  async function mountVillage(container) {
    destroy();
    const mine = viewSeq;
    await SfRender.loadExtra('tags-home.json');
    if (mine !== viewSeq || container.isConnected === false) return null;
    const view = await SfRender.mount(container, { frame: 30 });
    if (mine !== viewSeq || container.isConnected === false) { view.destroy(); return null; }
    // 与 mount() 同一条：村庄页是 320×196 整页，#ui 的高度必须按它重算。
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    // ⚠ 这里不调 refreshValues：那是主菜单页（`main` 7039）的数值刷新，
    current = view;
    wireVillage(view);
    // 村庄右上角的「远方小径」：联机版无尽塔的唯一入口（原版 4421 确认框）。
    if (window.SfTowerPath) {
      try { SfTowerPath.mount(view, container); } catch (e) {
        if (window.__errs) window.__errs.push('tower path: ' + (e && e.message));
      }
    }

    let settled = [];
    try { settled = settleVillageBuildings() || []; } catch (e) { if (window.__errs) window.__errs.push('village buildings: ' + (e && e.message)); }
    // `wireVillage` 在上面已经按结算前的 `upgrading` 挂过「松鼠修房子」并写了倒计时；
    // 结算真的完成了升级时立刻重画一遍，否则建筑会停在旧档、松鼠也还在敲。
    if (settled.length) { try { refreshVillageBuildings(); } catch (e) {} }
    // 新手引导 f17/f19/f20/f26 都在村庄页（原版 HOME_LAND :9480-9670）。
    // ⚠ UI.currentScreen() 在村庄页仍是 'home'（openVillage 不改 screen），
    if (window.SfGuide) { try { SfGuide.onPage('village'); } catch (e) {} }
    return view;
  }
  // 进村庄时结算"升级完成"（原版 `checkUpgraded` :9763）并把结果告诉玩家。
  // 返回 `State.settleBuildings()` 的完成列表（调用方据此决定要不要重画）。
  function settleVillageBuildings() {
    if (!(window.State && State.settleBuildings)) return [];
    const done = State.settleBuildings() || [];
    if (!done.length) return [];
    const names = { altar: '祭坛', miracle: '神迹', beast: '幻兽牧场' };
    const lines = done.map((d) => {
      if (d.key === 'altar') return '祭坛升级完成啦，特殊状态的触发几率提高了！';
      if (d.key === 'miracle') {
        const add = ['1点力量！', '1点敏捷！', '1点速度！', '5点生命！'][d.addType] || '1个属性点！';
        return '神迹升级完成啦，它为你提高了' + add;
      }
      return '幻兽牧场升级完成啦，松鼠的领导力增加了，并获得了1个存储格和200孵化点！';
    });
    lines.forEach((t) => { try { if (window.UI && UI.toast) UI.toast(t); } catch (e) {} });
    void names;
    return done;
  }

  function refreshVillageBuildings() {
    const view = current;
    if (!view || !view.setStaticPolicy) return false;

    try {
      const home = view.byName ? view.byName('homeMc') : null;
      if (!home) return false;
      wireVillage(view);
      return true;
    } catch (e) { return false; }
  }
  function wireVillage(view) {
    // ⚠ 这个函数会被再调一次（地点页里升级成功 → `refreshVillageBuildings()` 重画）。
    const already = !!view.__villageWired;
    view.__villageWired = true;
    // 根时间轴帧 30 的子元件就叫 `homeMc`（= 7140），按钮都在它下面。
    // ⚠ 别用 `byNameDeep`：它内部按 `instanceof MovieClip` 递归，而 `names` 表里存的是节点，
    const home = (view.byName && view.byName('homeMc')) || view;
    const rel = (name) => (home && home.byName ? home.byName(name) : null);
    // ① 村庄页也走静态页策略（与状态页 / 挑战页 / 地点弹窗页同一套机制，见 render.js）：
    // ⚠ 建筑等级牌子（mc1/mc3/mc4 里的 `num` → `num1`/`num2`）不能进 `blankNames`：
    // ⚠ 为什么不再用"事后扫一遍再 pinFrame"：`measureFrameBoxes()`（量热区时会临时把元件
    if (view.setStaticPolicy) {
      // `blankNames` 只列位图数字精灵（`num` → 里面那对 `num1`/`num2`）：
      // ⚠ 建筑等级不写进牌子是有意的 —— 实测原版 mc1 只在第 1 帧里放了 `num`，
      view.setStaticPolicy({ keepIds: [...KEEP_ANIMATED], blankNames: [] });
    }

    const settleVillage = () => {

      for (const name in VILLAGE_MC_ACTIONS) {
        const c = rel(name);
        if (!c || villagePlaying.has(c)) continue;
        pinFrame(c, villageFrameOf(name));
      }
      for (const name in VILLAGE_POP_TARGETS) {
        const c = rel(name);
        if (c) popWrap(c, !!VILLAGE_MC_ACTIONS[name]);
      }
    };

    const buildingOf = (name) => {
      if (!(window.State && State.building)) return null;
      const key = name === 'mc1' ? 'altar' : name === 'mc3' ? 'miracle' : name === 'mc4' ? 'beast' : null;
      return key ? State.building(key) : null;
    };

    const lockOf = (action) => {
      if (!(window.State && State.state)) return '';
      const lv = Math.max(1, Number(State.state().level) || 1);
      if (action === 'village-war') {
        // 原版 `showHomeLand` 只按等级：`oldMyInfo.player.level > 34` 才显示征战建筑/按钮；
        // `copyStart` 只是服务端下发的“开/关”外观帧，不是前置关卡数。
        // `Tower.unlocked()` 的「通关前 18 关」是挑战塔的门槛，不要套到征战上。
        const need = Number(State.WAR_UNLOCK_LEVEL) || 35;
        return lv < need ? 'Lv' + need + ' 解锁' : '';
      }
      const key = action === 'village-altar' ? 'altar' : action === 'village-miracle' ? 'miracle' : action === 'village-beast' ? 'beast' : '';
      if (!key || !State.buildingUnlocked) return '';
      return State.buildingUnlocked(key) ? '' : 'Lv' + (State.buildingUnlockLevel(key) || 0) + ' 解锁';
    };
    const villageFrameOf = (name) => {
      const c = rel(name);
      const last = c && c.frameCount ? c.frameCount() : 1;
      // 未解锁：原版 `showUpgrading()` 对 level 0 是 `gotoAndStop(_totalframes)`，
      // 末帧就是那块“坟墓/空档”外观；不要再停在基础建筑帧上。
      if (name === 'mc5') return lockOf('village-war') ? last : 1;
      const key = name === 'mc1' ? 'altar' : name === 'mc3' ? 'miracle' : name === 'mc4' ? 'beast' : null;
      if (!key || lockOf('village-' + key)) return last;
      const b = buildingOf(name);
      if (!b) return last;
      const tier = (State.buildingTier ? State.buildingTier(b.level) : Math.ceil(b.level / 5));
      return Math.max(1, Math.min(last, tier));
    };
    // 等级牌子上的位图数字（原版 `showNumber(level, mc.num, 0, 0, "left", 2)`）。
    // ⚠ 只在牌子真的存在的那一档写：mc1 的 `num` 只在第 1 帧里（其余 5 档的建筑画稿
    const removeHomeLevelBadge = (v, key) => {
      const host = v && (v.el || (v.root && v.root.parentNode) || (v.g && v.g.parentNode));
      const badge = host && host.querySelector('.ssfight-home-level[data-building="' + key + '"]');
      if (badge) badge.remove();
    };
    const paintBuildingNumbers = () => {
      if (!(window.State && State.building)) return;

      const altar = State.building('altar');
      const altarNum = rel('num1');
      if (altarNum) {
        if (altar) showNumber(String(altar.level), altarNum, 0, 0, 'left', 2);
        else blankDigits(altarNum);
      }
      const pairs = [['mc1', 'altar'], ['mc3', 'miracle'], ['mc4', 'beast']];
      for (const [mc, key] of pairs) {
        const c = rel(mc);
        let numClip = null;
        for (const rec of (c && c.nodes ? c.nodes.values() : [])) if (rec.na === 'num' && rec.clip) numClip = rec.clip;
        const b = State.building(key);
        removeHomeLevelBadge(view, key);
        if (!numClip) {
          // 高等级画稿里 num 图层被导出丢了（mc3/mc4 只有第 1 帧有 num）。
          // ⚠ 不要再补一个 DOM 数字：`getBoundingClientRect()` 返回的是屏幕坐标，
          // 但 CSS 的 left/top 写在 #ui 的设计坐标里；iOS / 全面屏缩放后会把
          continue;
        }
        if (!b) { blankDigits(numClip); continue; }

        if (mc === 'mc1' && (State.buildingTier ? State.buildingTier(b.level) : 1) !== 1) { blankDigits(numClip); continue; }
        showNumber(String(b.level), numClip, 0, 0, 'left', 2);
      }
      // 数字画完后按实际字宽重排等级牌子（字宽会随 1/2 位数变化）。
      try { centerAltarLabel(); } catch (e) {}
      try { nudgeBeastLabel(); } catch (e) {}
    };
    // 等级牌子由「底板 / 祭坛字 / 内嵌 Lv / 数字」几件素材拼成，原版底板按两位等级留宽：
    // 祭坛拿到 1 位数时整组字偏左。按底板与整组字的包围盒把字在框内居中（每次重画都重算）。
    const labelBase = (node) => {
      if (!node) return '';
      if (node.__labelBase == null) node.__labelBase = node.getAttribute('transform') || '';
      return node.__labelBase;
    };
    const moveLabelPart = (node, dx, dy, extra) => {
      if (!node) return;
      const base = labelBase(node);
      node.setAttribute('transform', 'translate(' + dx + ',' + dy + ')' + (extra ? ' ' + extra : '') + (base ? ' ' + base : ''));
    };
    const resetLabelPart = (node) => { if (node) node.setAttribute('transform', labelBase(node)); };
    const placementOf = (clip, id) => {
      if (!clip || !clip.nodes) return null;
      for (const rec of clip.nodes.values()) if (String(rec.id) === String(id)) return rec;
      return null;
    };
    // 祭坛牌子是 homeMc 下的独立放置（7117 底板 / num1 数字 / 7118 祭坛字），
    // 不在 mc1 里；按原深度顺序返回，稍后整组搬进 mc1 的 uc-pop 壳。
    const altarSignNodes = () => {
      const plateRec = placementOf(home, 7117);
      const wordRec = placementOf(home, 7118);
      const num = rel('num1');
      return [
        plateRec && (plateRec.wrap || plateRec.node),
        num && num.g,
        wordRec && (wordRec.wrap || wordRec.node),
      ].filter(Boolean);
    };
    // 牌子原本按 homeMc 坐标摆放；搬进 mc1 后要先套一层 mc1 逆矩阵，
    // 视觉位置才不变，之后才会跟本体一起缩放。
    const bridgeAltarSign = () => {
      const mc1 = rel('mc1');
      const pop = mc1 && mc1.g && mc1.g.querySelector(':scope > g.uc-pop');
      if (!pop) return false;
      const base = String(mc1.g.__baseMa || '').split(',').map(Number);
      if (base.length !== 6 || !base.every((v) => Number.isFinite(v))) return false;
      const [a, b, c, d, e, f] = base;
      const det = a * d - b * c;
      if (!det) return false;
      let bridge = pop.querySelector(':scope > g.sf-village-sign-bridge');
      if (!bridge) {
        bridge = el('g');
        bridge.setAttribute('class', 'sf-village-sign-bridge');
        bridge.setAttribute('transform', 'matrix(' + [d / det, -b / det, -c / det, a / det,
          (c * f - d * e) / det, (b * e - a * f) / det].join(',') + ')');
      }
      // 永远把桥接组放到最后：mc1 切帧时新节点会追加到 pop 里，牌子不能被盖住。
      pop.appendChild(bridge);
      for (const node of altarSignNodes()) {
        if (node.parentNode !== bridge) bridge.appendChild(node);
        node.classList.add('sf-village-sign');
        node.style.cursor = 'pointer';
        node.style.pointerEvents = 'auto';
      }
      return true;
    };
    const centerAltarLabel = () => {
      const plateRec = placementOf(home, 7117);
      const wordRec = placementOf(home, 7118);
      const numClip = rel('num1');
      if (!plateRec || !wordRec || !numClip) return;
      const plate = plateRec.wrap || plateRec.node;
      const word = wordRec.wrap || wordRec.node;
      const num = numClip.g || numClip;
      if (!plate || !word || !num) return;
      const frame = plate.getBoundingClientRect();
      if (!(frame.width > 0)) return;
      // 底板的两条大路径是框，其余小路径是内嵌的 Lv 字：按宽度区分，素材重导也不会认错。
      const glyphs = [...plate.children].filter((node) => {
        if (!node || String(node.tagName).toLowerCase() !== 'path') return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.width < frame.width * 0.5;
      });
      const parts = [word, num, ...glyphs];
      parts.forEach(resetLabelPart);
      const boxes = parts.map((node) => node.getBoundingClientRect());
      const left = Math.min(...boxes.map((r) => r.left));
      const right = Math.max(...boxes.map((r) => r.right));
      const dxScreen = ((frame.left + frame.right) - (left + right)) / 2;
      if (!(Math.abs(dxScreen) >= 0.5)) return;
      const ctm = plate.getScreenCTM ? plate.getScreenCTM() : null;
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 0;
      if (!(scale > 0)) return;
      const dx = dxScreen / scale;
      parts.forEach((node) => moveLabelPart(node, dx, 0));
    };
    // 幻兽牌子（mc4 第 1 帧的底板 + 数字）在原画里略偏右下且带约 1.2° 倾斜：
    // 整体往左上挪，再以底板中心转回水平。位移是 mc4 内的局部单位（mc4 本身 0.32 缩放）。
    const BEAST_LABEL_SHIFT = [-25, -17];
    const BEAST_LABEL_TILT = 1.2;
    const nudgeBeastLabel = () => {
      const mc4 = rel('mc4');
      if (!mc4) return;
      const plateRec = placementOf(mc4, 7102);
      const plate = plateRec && (plateRec.wrap || plateRec.node);
      const num = mc4.byName ? mc4.byName('num') : null;
      if (!plate || !num || !num.g) return;
      let rot = '';
      try {
        const b = plate.getBBox();
        if (b && b.width > 0) {
          const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
          rot = 'rotate(' + BEAST_LABEL_TILT + ',' + cx + ',' + cy + ')';
        }
      } catch (e) {}
      moveLabelPart(plate, BEAST_LABEL_SHIFT[0], BEAST_LABEL_SHIFT[1], rot);
      moveLabelPart(num.g, BEAST_LABEL_SHIFT[0], BEAST_LABEL_SHIFT[1], rot);
    };
    // 把一对位图数字留在末帧（空白档）（第 1 帧是数字 0，不能留）。
    const blankDigits = (numClip) => {
      for (const n of ['num1', 'num2']) {
        const c = numClip && numClip.byName ? numClip.byName(n) : null;
        if (c && c.gotoAndStop) c.gotoAndStop(c.frameCount ? c.frameCount() : 1);
      }
    };

    const paintBuildTimers = () => {
      if (!(window.State && State.building)) return;
      const show = (mins) => (mins > 0 ? (Math.floor(mins / 60) + '时' + (mins % 60) + '分') : '');
      const a = State.building('altar'), m = State.building('miracle'), b = State.building('beast');
      setText(rel('time1'), a && a.upgrading ? show(a.remainTime) : '');
      setText(rel('time3'), m && m.upgrading ? show(m.remainTime) : '');
      setText(rel('time4'), b && b.upgrading ? show(b.remainTime) : '');
    };

    const repairClips = view.__repairClips || (view.__repairClips = new Map());
    const detachRepair = (name) => {
      const c = repairClips.get(name);
      if (!c) return;
      repairClips.delete(name);
      c.playing = false;
      if (view.live) view.live.delete(c);
      const host = rel(name);
      if (host && host.g) {
        host.g.classList.remove('sf-repairing-host');
        const shell = host.g.querySelector(':scope > g.uc-pop');
        if (shell) shell.classList.remove('sf-repairing');
      }
      if (host && host.detachAll) host.detachAll();
      else if (c.g && c.g.parentNode) c.g.parentNode.removeChild(c.g);
    };
    const repairWanted = () => Object.keys(REPAIR_AT).filter((name) => {
      const b = buildingOf(name);
      return !!(b && b.upgrading && rel(name));
    });
    const attachRepair = () => {
      if (current !== view) return;
      const want = repairWanted();
      for (const name of [...repairClips.keys()]) if (want.indexOf(name) < 0) detachRepair(name);
      for (const name of want) {
        if (repairClips.has(name)) continue;
        const host = rel(name);
        const at = REPAIR_AT[name];
        let clip = null;
        try { clip = host.attachChild(REPAIR_SYMBOL, 1, 'repair'); } catch (e) { clip = null; }
        if (!clip) continue;

        clip.setExtraTransform('matrix(' + (-at.scale) + ',0,0,' + at.scale + ',' + at.x + ',' + at.y + ')');
        clip.holdAnim(true);
        clip.play();
        // ⚠ 建筑壳在动画期间禁止 CSS filter / transform：逐帧变化的子树会让
        // Android WebView / 部分 Chromium 复用旧滤镜区域，背景上出现矩形色块。
        if (host.g) {
          const shell = host.g.querySelector(':scope > g.uc-pop');
          if (shell) shell.classList.add('sf-repairing');
          // 宿主也一并摘掉 filter，避免动画结束后残留滤镜区域。
          host.g.classList.add('sf-repairing-host');
        }
        repairClips.set(name, clip);
      }
    };
    const syncRepair = () => {
      const want = repairWanted();
      for (const name of [...repairClips.keys()]) if (want.indexOf(name) < 0) detachRepair(name);
      if (!want.length) return;
      if (repairBundle === 2) attachRepair();
      else ensureRepairBundle().then((ok) => { if (ok) attachRepair(); });
    };
    settleVillage();
    paintBuildingNumbers();
    paintBuildTimers();

    if (view.__villagePaintTimer) clearTimeout(view.__villagePaintTimer);
    view.__villagePaintTimer = setTimeout(() => {
      if (current !== view) return;
      try { paintBuildingNumbers(); paintBuildTimers(); } catch (e) {}
    }, 80);

    if (already) {
      // 升级后重绘可能把 mc1 的新节点插到牌子之后；把桥接组再放回最上，
      // 保证牌子和本体仍按原深度盖在建筑上。
      try { bridgeAltarSign(); } catch (e) {}
      syncRepair();
      return;
    }

    try {
      const back = rel('mainButton');
      if (back && back.g) {
        back.gotoAndStop(1);
        back.g.style.cursor = 'pointer';
        back.g.style.pointerEvents = 'auto';
        measureHitBox(back); popWrap(back);
        const shell = back.g.querySelector(':scope > g.uc-pop');
        if (shell) wirePopPress(shell);
        settleVillage();
        back.g.addEventListener('mouseenter', () => { back.gotoAndStop(2); settleVillage(); });
        back.g.addEventListener('mouseleave', () => { back.gotoAndStop(1); settleVillage(); });
        back.g.addEventListener('click', (e) => {
          e.stopPropagation();
          pressFlash(back, 1, settleVillage);
          if (window.UI && UI.runAction) UI.runAction('home');
        });
      }
    } catch (e) {}

    const GROUP_ACTIVE = {};
    const mcNameOf = (key) => {
      for (const n in VILLAGE_MC_ACTIONS) if (VILLAGE_MC_ACTIONS[n] === key) return n;
      return null;
    };
    const groupNodes = (key) => {
      const mcName = mcNameOf(key);
      const pill = rel(VILLAGE_PILL_OF[key]);
      const mc = mcName ? rel(mcName) : null;
      const nodes = [];
      if (pill && pill.g) nodes.push(pill.g);
      if (mc && mc.g) nodes.push(mc.g);
      return { pill: pill, mc: mc, nodes: nodes };
    };
    const nodeIn = (nodes, node) => !!node && nodes.some((n) => n === node || (n.contains && n.contains(node)));
    const groupEnter = (key) => {
      const g = groupNodes(key);
      if (g.pill && g.pill.gotoAndStop) g.pill.gotoAndStop(2);
      settleVillage();
      GROUP_ACTIVE[key] = true;
      for (const clip of [g.pill, g.mc]) {
        const shell = clip && clip.g.querySelector(':scope > g.uc-pop');
        if (shell) shell.classList.add('sf-hover');
      }
    };

    const groupLeave = (key, to) => {
      const g = groupNodes(key);
      if (nodeIn(g.nodes, to)) return;
      if (!GROUP_ACTIVE[key]) return;
      GROUP_ACTIVE[key] = false;
      for (const clip of [g.pill, g.mc]) {
        const shell = clip && clip.g.querySelector(':scope > g.uc-pop');
        if (shell && window.SfUiFeedback) SfUiFeedback.clear(shell);
      }
      if (g.pill && g.pill.gotoAndStop) g.pill.gotoAndStop(1);
      settleVillage();
    };

    const idleFrameOf = (key) => (GROUP_ACTIVE[key] ? 2 : 1);
    // ③ 四处地点的胶囊（button6/8/9/10）：常态第 1 帧，鼠标移上去切 positive（第 2 帧，金色），
    // ⚠ 胶囊 3 帧是三个状态不是动画（第 3 帧是"禁用/空"），所以悬停只能 `gotoAndStop(2)`；
    for (const name of Object.keys(VILLAGE_BUTTONS)) {
      try {
        const clip = rel(name);
        if (!clip || !clip.g) continue;
        clip.gotoAndStop(1);
        clip.g.style.cursor = 'pointer';
        clip.g.style.pointerEvents = 'auto';
        measureHitBox(clip); popWrap(clip);
        const shell = clip.g.querySelector(':scope > g.uc-pop');
        if (shell) wirePopPress(shell);
        const key = VILLAGE_BUTTONS[name];

        clip.g.addEventListener('mouseenter', () => groupEnter(key));
        clip.g.addEventListener('mouseleave', (e) => groupLeave(key, e.relatedTarget));
        clip.g.addEventListener('click', (e) => {
          e.stopPropagation();
          pressFlash(clip, idleFrameOf(key), settleVillage);
          const lock = lockOf(key);
          if (lock) { if (window.UI && UI.toast) UI.toast((VILLAGE_LABEL[key] || '这里') + '：' + lock); return; }
          if (window.UI && UI.runAction) UI.runAction(key);
        });
      } catch (e) {}
    }
    // ④ 建筑也可点击，与胶囊共用悬停组。多帧表示建筑等级/征战开关，
    // 热区仍取所有状态帧的并集。measureFrameBoxes必须在popWrap前执行，
    for (const name in VILLAGE_MC_ACTIONS) {
      try {
        const clip = rel(name);
        if (!clip || !clip.g) continue;
        clip.g.style.cursor = 'pointer';
        clip.g.style.pointerEvents = 'auto';
        measureHitBox(clip);
        // 拨帧量"所有帧的并集"必须在 `popWrap()` 之前：它每拨一帧都会重建 `<g>` 的子节点，
        // 会把动效壳与已经铺好的热区一起清掉。量完结果缓存在 `__frameBoxes` 上，后面重铺不再重量。
        measureFrameBoxes(clip);
        popWrap(clip);
        addHitArea(clip, true);
        const shell = clip.g.querySelector(':scope > g.uc-pop');
        if (shell) wirePopPress(shell);
        const key = VILLAGE_MC_ACTIONS[name];
        clip.g.addEventListener('mouseenter', () => groupEnter(key));
        clip.g.addEventListener('mouseleave', (e) => groupLeave(key, e.relatedTarget));
        clip.g.addEventListener('click', (e) => {
          e.stopPropagation();
          const pill = rel(VILLAGE_PILL_OF[key]);
          if (pill) pressFlash(pill, idleFrameOf(key), settleVillage);
          const lock = lockOf(key);
          if (lock) { if (window.UI && UI.toast) UI.toast((VILLAGE_LABEL[key] || '这里') + '：' + lock); return; }
          if (window.UI && UI.runAction) UI.runAction(key);
        });
      } catch (e) {}
    }
    // 祭坛牌子搬进 mc1 的 uc-pop 壳，和神迹/幻兽一样随本体一起缩放、点按。
    try { bridgeAltarSign(); } catch (e) {}
    // ⚠ 关键：上面每一步 `measureFrameBoxes()` / `popWrap()` / 悬停切帧都会重建立绘子树，
    try { paintBuildingNumbers(); paintBuildTimers(); } catch (e) {}

    try { syncRepair(); } catch (e) {}
  }

  window.SfUiMain = { mount, mountVillage, destroy, refreshValues, showNumber, setText, syncVipBadge, BUTTON_ACTIONS,
    loadGearTables,
    markMessagesSeen, hasNewMessages,

    openActivity: () => openActivityDialog(),
    closeActivity: () => closeActivityDialog(),

    refreshVillageBuildings,

    settleVillageBuildings,

    renderStateIcons, activeStatePills, positionStateIcons,

    currentView: () => current,
    // 那些场景页也是同一套编译出来的元件（按钮是 3~4 帧的状态精灵、"可点区域"要自己铺），
    // ⚠ 只导出"与具体页面无关"的通用件：页面逻辑一律留在各自的文件里。
    toolkit: {
      // 量包围盒（缓存到 `__hitBox`；用常态帧，免得悬停时热区忽大忽小）
      measureHitBox,
      // 按包围盒铺一块透明点击区；`animate` = 按所有帧的并集铺（多帧状态精灵用）。
      // ⚠ 铺完会把这颗元件登记进"点击路由"（见 ui-main.js 里那段注释）：热区只是尺子，
      addHitArea,

      registerHit,

      unregisterHit,

      routerOf,
      // 把一个多帧元件每一帧的包围盒量出来（结果缓存在 `__frameBoxes`）
      measureFrameBoxes,

      popWrap,

      refreshShell,

      popPick,

      wirePopPress,

      pressFlash,

      pinFrame,

      freezeDescendants,

      setText,

      wrapToField,

      showNumber,

      setFrame,

      createSubviewHost,

      paintSvgIcon,

      layoutScale,

      freezeView,

      setTextByName,

      clipOf,
    } };
})();
