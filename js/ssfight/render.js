// Original ssfight timeline/SVG interpreter. Runtime assets: images/ssfight/ui/.
(function () {
  'use strict';

  const BASE = 'images/ssfight/ui/';
  // 主页/加载屏 3182 与村庄 7041 直连 WebP，素材表里也指向同一份，避免再拉 JPG。
  const BITMAP_WEBP = {
    'bitmap/3182_0.hd.jpg': 'bitmap/3182_0.hd.webp',
    'bitmap/7041_0.hd.jpg': 'bitmap/7041_0.hd.webp',
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';

  let bundle = null;
  let loadPromise = null;
  const extraPromises = new Map();
  const releaseTimers = new Map();


  // 网页端把构建号带在 URL 上：服务端注入 __SSDZ_WEB_VERSION__ 后，
  // UI JSON / 内嵌位图都能用一年缓存；原生包没有这个变量，保持原路径。
  function webVersion() {
    try { return String(window.__SSDZ_WEB_VERSION__ || ''); } catch (e) { return ''; }
  }
  function withVersion(url) {
    const u = String(url == null ? '' : url);
    if (!u || /^(data:|blob:|https?:|\/\/)/i.test(u)) return u;
    const v = webVersion();
    if (!v) return u;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(v);
  }


  // 取一份素材 JSON。网页端 URL 带构建号，走默认缓存（immutable 一年）；
  // 无构建号时服务端给 no-cache，`default` 会按 ETag 重新验证。
  // 失败再用 `no-store` 重取一次：WebView 里可能留着上一版 / 被截断的缓存响应。
  async function fetchJson(file, noCache) {
    const r = await fetch(withVersion(BASE + file), noCache ? { cache: 'no-store' } : { cache: 'default' });
    if (!r || !r.ok) throw new Error('素材包缺失：' + file);
    return r.json();
  }
  async function fetchJsonRetry(file) {
    try { return await fetchJson(file); }
    catch (e) { return fetchJson(file, true); }
  }
  async function load() {
    if (bundle) return bundle;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [tl, tags, textFields] = await Promise.all([
        fetchJsonRetry('timeline.json'),
        fetchJsonRetry('tags.json'),
        fetchJsonRetry('textfields.json').catch(() => ({})),
      ]);
      const hash = new Map();
      for (const t of tags) hash.set(String(t.id), t);
      bundle = { timeline: tl, tags, hash, textFields, extraLists: new Map() };
      return bundle;
    })();
    try { return await loadPromise; }
    finally { loadPromise = null; }
  }
  function loaded() { return !!bundle; }


  function rebuildHash(clearBBox) {
    const hash = new Map();
    for (const t of bundle.tags) hash.set(String(t.id), t);
    for (const [file, list] of bundle.extraLists) {
      const exactGear = file === 'tags-gear.json' || file === 'tags-gear-color.json';
      for (const t of list) {
        const k = String(t.id);
        if (exactGear || !hash.has(k)) hash.set(k, t);
      }
    }
    bundle.hash = hash;
    if (clearBBox) bboxCache.clear();
  }

  // 小体积静态表（装备帧号 / 挂点 / 图标映射）：多个页面共用，一次会话只取一次。
  // 与 `loadExtra` 分开：tags 包会按页面释放，这些表不参与释放。
  const tablePromises = new Map();
  function loadTable(file) {
    const key = String(file);
    const hit = tablePromises.get(key);
    if (hit) return hit;
    const pending = fetchJsonRetry(key).catch((e) => {
      tablePromises.delete(key);
      throw e;
    });
    tablePromises.set(key, pending);
    return pending;
  }

  async function loadExtra(file) {
    cancelExtraRelease(file);
    if (loaded() && bundle.extra && bundle.extra.has(file)) return bundle;
    if (extraPromises.has(file)) return extraPromises.get(file);
    const pending = (async () => {
      // 基础 tags 与该页的额外包互不依赖：慢网下先各发一条请求，别让 450KB 的
      // `tags.json` 把 `tags-gear.json` 这类整页素材排到后面。
      const baseP = load();
      // 下一拍再发：基础 tags 先占住同一批连接，extra 紧随其后，不和基础包抢首个请求；
      // 两者仍然并行，而不是等 `tags.json` 下载完再排队。
      const extraP = Promise.resolve().then(() => fetchJsonRetry(file));
      extraP.catch(() => {});
      let b;
      try { b = await baseP; }
      catch (e) { extraP.catch(() => {}); throw e; }
      if (b.extra && b.extra.has(file)) { extraP.catch(() => {}); return b; }
      const list = await extraP;
      const exactGear = file === 'tags-gear.json' || file === 'tags-gear-color.json';
      b.extraLists.set(file, list);
      rebuildHash(exactGear);
      if (!b.extra) b.extra = new Set();
      b.extra.add(file);
      return b;
    })();
    extraPromises.set(file, pending);
    try { return await pending; }
    finally { if (extraPromises.get(file) === pending) extraPromises.delete(file); }
  }

  function cancelExtraRelease(file) {
    const timer = releaseTimers.get(file);
    if (!timer) return;
    releaseTimers.delete(file);
    if (timer.kind === 'idle') {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(timer.id);
    } else clearTimeout(timer.id);
  }

  /** 释放一个按需素材包：只保留基础 tags 与仍加载的包，供页面销毁时回收堆内存。 */
  function releaseExtra(file) {
    cancelExtraRelease(file);
    if (!bundle || !bundle.extraLists || !bundle.extraLists.has(file)) return false;
    bundle.extraLists.delete(file);
    if (bundle.extra) bundle.extra.delete(file);
    rebuildHash(true);
    return true;
  }

  /** 延后到空闲帧再释放：给离场动画 / 返回首页让出主线程；同一包再次 loadExtra 会取消。 */
  function queueExtraRelease(file, delayMs) {
    if (!bundle || !bundle.extraLists || !bundle.extraLists.has(file)) return false;
    cancelExtraRelease(file);
    const timer = setTimeout(() => {
      releaseTimers.delete(file);
      const run = () => {
        const hold = releaseTimers.get(file);
        if (!hold || hold.kind !== 'idle') return;
        releaseExtra(file);
      };
      if (typeof requestIdleCallback === 'function') {
        const idle = requestIdleCallback(run, { timeout: 2000 });
        releaseTimers.set(file, { kind: 'idle', id: idle });
      } else releaseExtra(file);
    }, Math.max(0, Number(delayMs) || 0));
    releaseTimers.set(file, { kind: 'timeout', id: timer });
    return true;
  }

  const warmedUrls = new Set();
  let prefetchGen = 0;
  let prefetchCtrl = null;
  // 预热只把响应灌进 HTTP 缓存，不保留解析结果；之后 loadExtra 用同一 URL 直接命中。
  // `?v=` 必须与 loadExtra 一致，否则缓存键不同、等于没预热。
  function warmUrl(url, signal) {
    const u = String(url || '');
    if (!u || warmedUrls.has(u)) return Promise.resolve(!!u);
    if (typeof fetch !== 'function') return Promise.resolve(false);
    warmedUrls.add(u);
    return fetch(u, { cache: 'default', signal })
      .then((r) => (r && r.ok ? r.arrayBuffer() : null))
      .then(() => true, () => { warmedUrls.delete(u); return false; });
  }
  function prefetchExtra(file, signal) {
    if (bundle && bundle.extraLists && bundle.extraLists.has(String(file))) return Promise.resolve(true);
    return warmUrl(withVersion(BASE + file), signal);
  }
  // 列表串行预热：一条下载完再发下一条，避免和玩家刚点的请求抢满连接。
  // 玩家点了页面先 `cancelPrefetch()`：在途那条会 abort，把带宽让给真正要显示的素材。
  function prefetch(files) {
    cancelPrefetch();
    const gen = prefetchGen;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    prefetchCtrl = ctrl;
    const signal = ctrl ? ctrl.signal : undefined;
    const list = Array.isArray(files) ? files : [];
    return list.reduce((chain, file) => {
      const f = String(file || '');
      if (!f) return chain;
      return chain.then(() => {
        if (gen !== prefetchGen) return false;
        return prefetchExtra(f, signal);
      });
    }, Promise.resolve(true));
  }
  function cancelPrefetch() {
    prefetchGen++;
    if (prefetchCtrl) {
      try { prefetchCtrl.abort(); } catch (e) {}
      prefetchCtrl = null;
    }
  }

  const el = (name, attrs) => {
    const n = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    return n;
  };
  // 每个 SVG 根一个 `<defs>`，排在最前：旧 WebView / WebKit 对「内容之后才追加的
  // 渐变」可能不参与首帧绘制（url(#…) 解析不到 → 露出底下的纯色）。
  function defsHost(root) {
    if (!root || String(root.tagName || '').toLowerCase() !== 'svg') return root;
    const old = root.__sfDefs;
    if (old && old.parentNode === root) return old;
    const defs = el('defs');
    root.insertBefore(defs, root.firstChild);
    root.__sfDefs = defs;
    return defs;
  }
  // 同一页的 `<defs>` 会挂几百个渐变 / 滤镜；逐个 querySelector 是 O(n²)。
  // 用挂在 defs 节点上的表记账；节点被摘掉（换帧/销毁）时要认账失效并补回。
  function defIds(rootDefs) {
    if (!rootDefs.__defIds) rootDefs.__defIds = new Map();
    return rootDefs.__defIds;
  }
  function hasDef(rootDefs, id) {
    const hit = defIds(rootDefs).get(id);
    if (!hit) return false;
    if (!hit.isConnected) {
      defIds(rootDefs).delete(id);
      if (hit.parentNode) hit.parentNode.removeChild(hit);
      return false;
    }
    return true;
  }
  function addDef(rootDefs, id, node) {
    defIds(rootDefs).set(id, node);
    rootDefs.appendChild(node);
  }


  // 官方的 processShape 会把渐变/图案/纯色分别注册到 <defs> 再让 path 去 url(#…) 引用；
  // 这里同样做，只是按 id 缓存，避免重复生成。

  // 轴对齐的 `gradientTransform`（只有缩放/平移）烘进坐标，不再让渲染器算矩阵：
  // 旧 WebKit 对 radialGradient + matrix 的焦点/半径处理不一致，会整块不画。
  // 非等比（椭圆）或带旋转/斜切时保留矩阵，避免把椭圆渐变烘成圆形。
  function bakeGradientTransform(kind, spec) {
    if (spec.gradientUnits !== 'userSpaceOnUse') return spec;
    const m = /^matrix\(([^)]*)\)$/.exec(String(spec.gradientTransform || '').trim());
    if (!m) return spec;
    const a = m[1].split(/[\s,]+/).map(Number);
    if (a.length < 6 || !a.every((v) => Number.isFinite(v))) return spec;
    const A = a[0], B = a[1], C = a[2], D = a[3], E = a[4], F = a[5];
    if (B || C || !A || !D) return spec;
    if (Math.abs(Math.abs(A) - Math.abs(D)) / Math.max(Math.abs(A), Math.abs(D)) > 0.1) return spec;
    // 缺省坐标不是 0（linear 默认 0%/100%、radial 默认 50%），不能按 0 烘。
    if (kind === 3 ? (spec.cx === undefined || spec.cy === undefined || spec.r === undefined)
      : (spec.x1 === undefined || spec.y1 === undefined || spec.x2 === undefined || spec.y2 === undefined)) return spec;
    const out = Object.assign({}, spec);
    delete out.gradientTransform;
    const tx = (v) => Math.round((A * Number(v || 0) + E) * 1000) / 1000;
    const ty = (v) => Math.round((D * Number(v || 0) + F) * 1000) / 1000;
    if (kind === 3) {
      out.cx = tx(spec.cx);
      out.cy = ty(spec.cy);
      out.fx = tx(spec.fx !== undefined ? spec.fx : spec.cx);
      out.fy = ty(spec.fy !== undefined ? spec.fy : spec.cy);
      out.r = Math.round(Number(spec.r || 0) * Math.sqrt(Math.abs(A * D)) * 1000) / 1000;
      if (![out.cx, out.cy, out.fx, out.fy, out.r].every(Number.isFinite)) return spec;
    } else {
      out.x1 = tx(spec.x1);
      out.y1 = ty(spec.y1);
      out.x2 = tx(spec.x2);
      out.y2 = ty(spec.y2);
      if (![out.x1, out.y1, out.x2, out.y2].every(Number.isFinite)) return spec;
    }
    return out;
  }
  // 不透明渐变的平均色：作为同一条路径的纯色兜底。渐变解析不到时（旧内核 / 被摘掉的
  // `<defs>`）画出来的是垫在下面的纯色（例：武器卡从米色变纯黄），兜底能保住主色。
  function solidOfGradient(f) {
    const stops = (f && f.sp) || [];
    if (!stops.length) return null;
    if (f['fill-opacity'] !== undefined && Number(f['fill-opacity']) < 0.999) return null;
    let r = 0, g = 0, b = 0, n = 0;
    for (const s of stops) {
      if (s['stop-opacity'] !== undefined && Number(s['stop-opacity']) < 0.999) return null;
      const c = parseSolidColor(s['stop-color']);
      if (!c) return null;
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    if (!n) return null;
    return 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
  }

  function gradientNode(kind, spec, id) {
    const g = el(kind === 3 ? 'radialGradient' : 'linearGradient', { id });
    spec = bakeGradientTransform(kind, spec);
    for (const k in spec) {
      if (k === 'sp' || k === 'tp' || k === 'image') continue;
      if (typeof spec[k] === 'object') continue;
      g.setAttribute(k, spec[k]);
    }
    for (const s of spec.sp || []) {
      const st = el('stop');
      for (const k in s) if (typeof s[k] !== 'object') st.setAttribute(k, s[k]);
      g.appendChild(st);
    }
    return g;
  }

  function patternNode(spec, id) {
    const p = el('pattern', { id });
    for (const k in spec) {
      if (k === 'image' || k === 'tp') continue;
      if (typeof spec[k] === 'object') continue;
      p.setAttribute(k, spec[k]);
    }
    const img = el('image');
    for (const k in spec.image || {}) {
      const v = spec.image[k];
      if (k === 'xlink:href' || k === 'href') img.setAttributeNS(XLINK, 'href', withVersion(BASE + (BITMAP_WEBP[v] || v)));
      else img.setAttribute(k, v);
    }
    p.appendChild(img);
    return p;
  }


  function shapeNode(rootDefs, tag) {
    const g = el('g', { type: 'shape' });
    for (const seg of tag.pt || []) {
      const path = el('path', { d: seg.da, fill: 'none' });
      if (seg.fi !== undefined) {
        const f = (tag.Fs || [])[seg.fi];
        if (f) {
          if (f.tp === 1) {
            path.setAttribute('fill', f.c || '#000000');
            if (f['fill-opacity'] !== undefined) path.setAttribute('fill-opacity', f['fill-opacity']);
          } else {
            const id = 'f' + tag.id + ':' + seg.fi;
            const solid = solidOfGradient(f);
            if (solid) {
              const fb = el('path', { d: seg.da, fill: solid });
              if (f['fill-opacity'] !== undefined) fb.setAttribute('fill-opacity', f['fill-opacity']);
              g.appendChild(fb);
            }
            if (!hasDef(rootDefs, id)) {
              addDef(rootDefs, id, f.tp === 3
                ? gradientNode(3, f, id)
                : f.tp === 2 ? gradientNode(2, f, id) : patternNode(f, id));
            }
            path.setAttribute('fill', 'url(#' + id + ')');
          }
        }
      }
      if (seg.ln !== undefined) {
        const l = (tag.Ls || [])[seg.ln];
        if (l) {
          for (const k in l) if (typeof l[k] !== 'object') path.setAttribute(k, l[k]);
          if (l.fi) {
            const id = 'l' + tag.id + ':' + seg.ln;
            if (!hasDef(rootDefs, id)) {
              addDef(rootDefs, id, l.fi.tp === 3 ? gradientNode(3, l.fi, id) : gradientNode(2, l.fi, id));
            }
            path.setAttribute('stroke', 'url(#' + id + ')');
          }
          // ⚠ 只有这段本来就没有填充时才能写 fill:none。
          if (seg.fi === undefined || !(tag.Fs || [])[seg.fi]) path.setAttribute('fill', 'none');
        }
      }
      g.appendChild(path);
    }
    return g;
  }

  // 不实现 CSS 的 `white-space` 断行（官方导出给每个 `<text>` 写了 `white-space:pre`，
  // 实测一样不断），所以照搬官方那条路的话，"1.…\r2.…\r3.…" 会连成一行冲出字段框。
  // 这类必须按 rs 自己的 x/y 摆，不能当行叠起来。
  const FONT_MAP = { 2030: 'SimHei', 3146: 'Microsoft YaHei' };
  function fontFamily(fd) {
    const s = String(fd == null ? '' : fd);
    const base = /^\d+$/.test(s) ? (FONT_MAP[s] || ('ft' + s)) : (s || 'sans-serif');
    return `'${base}', 'Microsoft YaHei', 'PingFang SC', sans-serif`;
  }

  function textLines(tag) {
    const rs = tag.rs || [];
    if (!rs.length) return [{ tx: '', h: null }];
    const xs = new Set(rs.map((r) => Number(r.x || 0)));
    const perRun = rs.length > 1 && xs.size > 1;
    if (perRun) {
      return rs.map((r) => ({ tx: r.tx, h: r.h || r.fs, c: r.c, b: r.b, fd: r.fd, x: r.x, y: r.y, run: true }));
    }
    const out = [];
    for (const r of rs) {
      for (const tx of String(r.tx == null ? '' : r.tx).split(/\r\n|\r|\n/)) {
        out.push({ tx, h: r.h || r.fs, c: r.c, b: r.b, fd: r.fd });
      }
    }
    return out.length ? out : [{ tx: '', h: null }];
  }
  // SVG `<text>` 不会按字段框宽自动折行；`setText` 只认显式 \r/\n。技能说明这类
  const NO_LINE_START = /[，。！？；：、）》】”’…·]/;
  let measureCanvas = null;
  let measureCanvasTried = false;
  function measureContext() {
    if (measureCanvasTried) return measureCanvas;
    measureCanvasTried = true;
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      const c = document.createElement('canvas');
      measureCanvas = c && c.getContext ? c.getContext('2d') : null;
    } catch (e) { measureCanvas = null; }
    return measureCanvas;
  }
  function charWidth(ch, em) {
    if (ch === ' ') return em * 0.34;
    return /[\x20-\x7e]/.test(ch) ? em * 0.56 : em;
  }
  function measureTextWidth(text, em, fd) {
    const ctx = measureContext();
    if (ctx) {
      try {
        ctx.font = em + 'px ' + fontFamily(fd);
        const w = ctx.measureText(String(text)).width;
        if (w > 0) return w;
      } catch (e) {  }
    }
    let w = 0;
    for (const ch of String(text)) w += charWidth(ch, em);
    return w;
  }
  // 经典界面的中文标签是 SWF 里烘成矢量的黑体，动态数值却必须用系统字体画：
  // Windows 落到 Microsoft YaHei / SimHei（数字墨高实测 ≈0.775em），安卓 WebView
  // 参考值 0.775 取自原版/Windows 的字体，所以那边差量为 0、完全不动；
  const DIGIT_REF_ASCENT = 0.775;
  const digitAscentCache = new Map();
  function digitAscent(fd) {
    const key = String(fd == null ? '' : fd);
    if (digitAscentCache.has(key)) return digitAscentCache.get(key);
    let ratio = DIGIT_REF_ASCENT;
    const ctx = measureContext();
    if (ctx) {
      try {
        ctx.font = '100px ' + fontFamily(fd);
        const m = ctx.measureText('0123456789');
        const asc = Number(m && m.actualBoundingBoxAscent);
        if (asc > 0) ratio = Math.min(0.9, Math.max(0.6, asc / 100));
      } catch (e) {  }
    }
    digitAscentCache.set(key, ratio);
    return ratio;
  }

  function digitLift(text, fd) {
    if (!/^\d{1,4}$/.test(String(text == null ? '' : text).trim())) return 0;
    return Math.max(0, Math.min(0.05, DIGIT_REF_ASCENT - digitAscent(fd)));
  }

  function wrapTokens(text) {
    const tokens = [];
    let ascii = '';
    const flush = () => { if (ascii) { tokens.push(ascii); ascii = ''; } };
    for (const ch of String(text)) {
      if (/[A-Za-z0-9.%+\-]/.test(ch)) { ascii += ch; continue; }
      flush();
      if (NO_LINE_START.test(ch) && tokens.length) tokens[tokens.length - 1] += ch;
      else tokens.push(ch);
    }
    flush();
    return tokens;
  }
  function wrapParagraph(text, maxWidth, em, fd) {
    const tokens = wrapTokens(text);
    const lines = [];
    let line = '';
    for (const token of tokens) {
      if (!line) { line = token; continue; }
      if (measureTextWidth(line + token, em, fd) <= maxWidth) { line += token; continue; }
      lines.push(line);
      line = token;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }
  // 把一段文案按文本框宽度拆成多行（保留显式换行）；节点没有字段元数据时原样返回。
  function wrapText(node, str) {
    const b = node && node.__textBox;
    const meta = b && b.meta;
    const text = String(str == null ? '' : str);
    if (!b || b.perRun || !meta || !meta.bd) return text;
    const width = Math.max(24, (meta.bd[1] - meta.bd[0]) - (meta.lm || 0) - (meta.rm || 0) - 1);
    const em = (b.lines[0] && b.lines[0].h) || meta.fh || 12;
    return text.split(/\r\n|\r|\n/)
      .flatMap((p) => (p ? wrapParagraph(p, width, em, meta.fd) : ['']))
      .join('\n');
  }
  // 按 `g.__textBox` 重新生成 `<text>` 子节点（`setText` 换文案时也走这里）。
  // ⚠ 生成出来的 `<text>` 一律塞进一层没有 transform 的内层 `<g>` 里，并把
  // 「字段框宽度的水平裁剪」挂在那层上 —— Flash 的 EditText 本来就会把超出字段框的字裁掉，
  // 原版素材里的占位串：作者在文本字段里写死的假数据，真值由界面运行时写进去。
  function isPlaceholderRun(tx) {
    const s = String(tx == null ? '' : tx).trim();
    if (s.length < 5) return false;

    if (s === '900000' || s === '999999/999999' || s === '9999/9999') return true;
    if (/^(\d)\1{3,}$/.test(s)) return true;
    const parts = s.split(/[\/\s%×x-]+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => /^(\d)\1{3,}$/.test(p));
  }
  function drawLines(g) {
    const b = g.__textBox;
    if (!b) return;
    const signature = JSON.stringify([b.lines, b.perRun, b.x, b.anchor, b.base, b.step,
      b.tag && b.tag.tf, b.meta && b.meta.fh, b.box]);
    if (b.renderSignature === signature && b.renderHost && b.renderHost.parentNode === g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    const host = el('g');
    b.lines.forEach((L, i) => {

      if (isPlaceholderRun(L.tx)) return;
      const t = el('text');
      t.textContent = L.tx == null ? '' : String(L.tx);
      if (L.b) t.setAttribute('font-weight', 'bold');
      t.setAttribute('font-size', L.h || (b.meta && b.meta.fh) || 12);
      t.setAttribute('font-family', fontFamily(L.fd));
      t.setAttribute('fill', L.c || '#000000');
      t.setAttribute('fill-rule', 'nonzero');
      t.setAttribute('style', 'white-space:pre');
      // 文本标签自带的 `tf` 变换必须应用（官方 processText 里 `h.setAttribute("transform", a.tf)`）。
      if (b.tag && b.tag.tf) t.setAttribute('transform', b.tag.tf);
      if (b.perRun) {

        if (L.x !== undefined) t.setAttribute('x', L.x);
        if (L.y !== undefined) t.setAttribute('y', L.y);
      } else {
        if (b.anchor === 'middle' || b.anchor === 'end') t.setAttribute('text-anchor', b.anchor);
        t.setAttribute('x', b.x);

        const lift = digitLift(L.tx, L.fd) * (Number(L.h) || Number((b.meta && b.meta.fh) || 12));
        t.setAttribute('y', Math.round((b.base + i * b.step - lift) * 100) / 100);
      }
      host.appendChild(t);
    });

    if (b.box && g.__defs) {
      if (!g.__clipId) {
        g.__clipId = 'sftxt' + (++cpSeq);
        const cp = el('clipPath', { id: g.__clipId, clipPathUnits: 'userSpaceOnUse' });
        cp.appendChild(el('rect', {
          x: b.box.xmin - 0.5, y: -600,
          width: Math.max(1, b.box.xmax - b.box.xmin + 1), height: 1200,
        }));
        g.__defs.appendChild(cp);
      }
      host.setAttribute('clip-path', 'url(#' + g.__clipId + ')');
    }
    g.appendChild(host);
    b.renderSignature = signature;
    b.renderHost = host;
  }

  function textNode(tag, rootDefs) {
    const g = el('g', { type: 'text' });
    const meta = bundle && bundle.textFields ? bundle.textFields[String(tag.id)] : null;
    const lines = textLines(tag);
    const rs = tag.rs || [];
    const perRun = lines.length > 0 && !!lines[0].run;
    // Flash 的 EditText 语义：html5 导出的 rs.x/rs.y 是字段框左下角而非字形位置，
    // 真正的水平对齐方式与字段框在 textfields.json（SWF 提取）里。
    let box = null, x = 0, anchor = 'start', base = 0, step = 0;
    if (meta && meta.bd) {
      const xmin = meta.bd[0], xmax = meta.bd[1], ymin = meta.bd[2], ymax = meta.bd[3];
      const firstH = lines[0].h || meta.fh || 12;

      const ind = (meta.ind && meta.ind < (xmax - xmin) / 2) ? meta.ind : 0;
      box = { xmin, xmax, ymin, ymax };
      anchor = meta.al === 2 ? 'middle' : meta.al === 1 ? 'end' : 'start';
      x = meta.al === 2 ? (xmin + xmax) / 2
        : meta.al === 1 ? (xmax - (meta.rm || 0))
          : (xmin + (meta.lm || 0) + ind);
      base = ymin + 2 + (meta.lead || 0) + 0.88 * firstH;

      step = 1.15 * firstH + (meta.lead || 0);
    } else if (rs[0]) {
      // 没有字段元数据（textfields.json 缺失）：退回导出里的 rs 坐标（官方那条路）
      x = rs[0].x !== undefined ? rs[0].x : 0;
      base = rs[0].y !== undefined ? rs[0].y : 0;
    }
    g.__textBox = { tag, meta, lines, perRun, box, x, anchor, base, step };
    g.__defs = rootDefs || null;
    drawLines(g);
    return g;
  }

  function estimateTextWidth(text, opts) {
    const o = opts || {};
    const ascii = Number.isFinite(Number(o.ascii)) ? Number(o.ascii) : 0.56;
    const spacing = Number.isFinite(Number(o.spacing)) ? Number(o.spacing) : 0;
    const em = Number.isFinite(Number(o.em)) ? Number(o.em) : 1;
    let units = 0, chars = 0;
    for (const ch of String(text == null ? '' : text)) {
      units += /^[\x20-\x7e]$/.test(ch) ? ascii : 1;
      chars++;
    }
    return units * em + chars * spacing;
  }
  // 一个字的一小截；英文昵称（按 1/3 权重最多 21 个字母）更宽。这里按字段框宽度
  // `width`（覆盖字段框宽度，例如主界面昵称框）。
  function fitTextWidth(node, opts) {
    if (!node || !node.__textBox) return 0;
    const b = node.__textBox;
    const meta = b.meta || {};
    const host = node.g || node;
    const list = host && host.querySelectorAll ? [...host.querySelectorAll('text')] : [];
    if (!list.length) return 0;
    const measured = Number(list[0].getAttribute('font-size')) || (b.lines[0] && b.lines[0].h) || meta.fh || 12;

    const KEY = '__sfFitBase';
    if (!(b[KEY] > 0)) b[KEY] = measured;
    const base = b[KEY];
    const W = Number(opts && opts.width) || (b.box ? (b.box.xmax - b.box.xmin - (meta.lm || 0) - (meta.rm || 0)) : 0);
    if (!(W > 0)) return base;
    const spacing = Number.isFinite(Number(opts && opts.spacing)) ? Number(opts.spacing) : 0;
    const min = Number.isFinite(Number(opts && opts.min)) ? Number(opts.min) : 6;
    let widest = 0, widestUnits = 0, widestChars = 0;
    for (const el of list) {
      const text = String(el.textContent == null ? '' : el.textContent);
      const units = estimateTextWidth(text, { ascii: opts && opts.ascii, em: 1 });
      const chars = [...text].length;
      const w = units * base + chars * spacing;
      if (w > widest) { widest = w; widestUnits = units; widestChars = chars; }
    }
    if (!(widest > W + 0.01) || !(widestUnits > 0)) return base;

    const avail = W - widestChars * spacing;
    const size = Math.max(min, Math.floor((avail / widestUnits) * 10) / 10);
    for (const el of list) el.setAttribute('font-size', String(size));
    return size;
  }
  // 按指定字号重排一个多行文本容器（`setText` 只换文案，字号/行距仍是素材值）。
  // 结果页、装备详情这类字段是上下紧挨着的：只缩 `<text>` 的 font-size 而不动行距，
  // 多出来的行仍按原字号的行高往下排，第二行就会压到下一个字段上。
  // 这里按 `textNode` 的同一套公式重算：
  //   首行基线 = 框顶 + 2 + leading + 0.88×字号，行距 = 1.15×字号 + leading。
  // `opts.size` 生效字号；返回最终字号。
  function layoutText(node, opts) {
    if (!node || !node.__textBox) return 0;
    const b = node.__textBox;
    const meta = b.meta || {};
    const natural = (b.lines[0] && b.lines[0].h) || meta.fh || 12;
    const size = Math.max(4, Number(opts && opts.size) || natural);
    b.lines = b.lines.map((L) => Object.assign({}, L, { h: size }));
    if (meta.bd) {
      b.base = meta.bd[2] + 2 + (meta.lead || 0) + 0.88 * size;
      b.step = 1.15 * size + (meta.lead || 0);
    }
    b.renderSignature = null;
    drawLines(node);
    return size;
  }
  // 换掉一个文本容器的内容（`SfRender.setText`）。
  // `opts.wrap = true` 时再按当前字段框宽自动折行（详情页的长技能说明用）。
  function setText(node, str, opts) {
    if (!node || !node.__textBox) return false;
    const b = node.__textBox;
    // `noClip`：战斗 HUD 的血量数字框只有 59 单位宽，六位数以上的生命会被字段框裁掉。
    // 只对明确要求放开的字段生效（`refreshBlood`），其它界面仍按原版 EditText 裁切。
    if (opts && opts.noClip) { b.box = null; b.renderSignature = null; }
    const text = (opts && opts.wrap) ? wrapText(node, str) : String(str == null ? '' : str);
    const h0 = (b.lines[0] && b.lines[0].h) || null;
    if (b.perRun) {
      // 逐字定位的字段（"正在等待队友…"那种一个字一个 rs）：只写第一个 rs，其余清空 ——
      b.lines = b.lines.map((L, i) => Object.assign({}, L, { tx: i === 0 ? text : '' }));
    } else {
      b.lines = text.split(/\r\n|\r|\n/).map((tx, i) => {
        const proto = b.lines[Math.min(i, b.lines.length - 1)] || {};
        return { tx, h: h0 || proto.h, c: proto.c, b: proto.b, fd: proto.fd };
      });

    }
    drawLines(node);
    return true;
  }


  // cx = {Rm,Ra,Gm,Ga,Bm,Ba,Am,Aa}（乘/加，0~256 体系），官方是逐个改写 fill 的颜色；
  // ⚠ 导出数据里颜色变换就挂在放置的 `cx` 上（`p.cx = {...}`），没有 `p.cx.cx` 这一层；
  function cxOf(p) {
    const c = p && p.cx;
    if (!c) return null;
    return (c.cx && typeof c.cx === 'object') ? c.cx : c;
  }
  function cxKey(c) {
    return ['Rm', 'Ra', 'Gm', 'Ga', 'Bm', 'Ba', 'Am', 'Aa']
      .map((k) => (c[k] === undefined ? '' : String(c[k]))).join('_');
  }
  function cxFilterFor(rootDefs, tagId, depth, c) {
    const id = 'cx' + tagId + '_' + depth + '_' + cxKey(c);
    if (!hasDef(rootDefs, id)) cxFilter(rootDefs, id, c);
    return id;
  }
  function cxFilter(rootDefs, id, c) {
    const f = el('filter', { id, x: '-20%', y: '-20%', width: '140%', height: '140%',
      'color-interpolation-filters': 'sRGB' });
    // 用 feColorMatrix 而不是 feComponentTransfer：后者在 iOS Safari / 部分 GPU 上
    // 会把整块滤镜区域画黑。矩阵与线性 feFunc 完全等价（乘 / 加都按 0~256、0~255 换算）。
    const mul = (k) => (c[k] === undefined ? 256 : Number(c[k])) / 256;
    const add = (k) => (c[k] === undefined ? 0 : Number(c[k])) / 255;
    const values = [
      mul('Rm'), 0, 0, 0, add('Ra'),
      0, mul('Gm'), 0, 0, add('Ga'),
      0, 0, mul('Bm'), 0, add('Ba'),
      0, 0, 0, mul('Am'), add('Aa'),
    ].join(' ');
    const m = el('feColorMatrix', { type: 'matrix', values: values });
    f.appendChild(m);
    addDef(rootDefs, id, f);
    return id;
  }

  // cx 是 SWF 的 ColorTransform。能改画稿的纯色填充/描边和渐变停靠点就直接改，
  // 不再挂 feComponentTransfer：这个滤镜在 iOS / 部分 GPU 上会把整块滤镜区域画黑。
  const COLOR_RGB = /^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i;
  const COLOR_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function parseSolidColor(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    let m = COLOR_RGB.exec(s);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    m = COLOR_HEX.exec(s);
    if (m) {
      const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }

  function cxChannel(c, mk, ak, value) {
    const slope = c[mk] === undefined ? 1 : Number(c[mk]) / 256;
    const intercept = c[ak] === undefined ? 0 : Number(c[ak]);
    return Math.max(0, Math.min(255, Math.round(slope * value + intercept)));
  }
  // 父级 cx 作用于子级已经染过色的画稿：Flash 里两层 ColorTransform 是串联的。
  function composeCx(parent, child) {
    if (!parent) return child;
    if (!child) return parent;
    const mul = (c, k) => (c[k] === undefined ? 256 : Number(c[k]));
    const add = (c, k) => (c[k] === undefined ? 0 : Number(c[k]));
    const out = {};
    for (const [m, a] of [['Rm', 'Ra'], ['Gm', 'Ga'], ['Bm', 'Ba'], ['Am', 'Aa']]) {
      out[m] = mul(parent, m) * mul(child, m) / 256;
      out[a] = mul(parent, m) * add(child, a) / 256 + add(parent, a);
    }
    return out;
  }
  // 这个 cx 是否只改 RGB、且 alpha 恒等（否则还是交给滤镜处理整组合成）。
  function cxRgbOnly(c) {
    if (!c) return false;
    const am = c.Am === undefined ? 256 : Number(c.Am);
    const aa = c.Aa === undefined ? 0 : Number(c.Aa);
    return am === 256 && aa === 0;
  }
  const PAINT_TAGS = { path: 1, rect: 1, circle: 1, ellipse: 1, polygon: 1, polyline: 1, text: 1 };

  function walkElements(node, fn) {
    for (const c of node.childNodes || []) {
      if (!c || c.nodeType !== 1) continue;
      fn(c);
      walkElements(c, fn);
    }
  }
  function attrsOf(node) {
    const out = [];
    if (node.attributes && node.attributes.length) {
      for (let i = 0; i < node.attributes.length; i++) out.push([node.attributes[i].name, node.attributes[i].value]);
    } else if (node.attrs) {
      for (const k of Object.keys(node.attrs)) out.push([k, node.attrs[k]]);
    }
    return out;
  }
  function defById(rootDefs, id) {
    return hasDef(rootDefs, id) ? defIds(rootDefs).get(id) : null;
  }
  // 渐变/图案里只有「所有 stop 都是纯色」才能烘焙；图案（位图）和 href 继承仍走滤镜。
  function gradientOf(rootDefs, id) {
    const def = defById(rootDefs, id);
    if (!def) return null;
    const tag = String(def.tagName || '').toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;
    // 没有 id 的渐变无法生成稳定的烘焙 id（多个匿名 def 会串色），交给滤镜。
    if (!def.getAttribute('id')) return null;
    for (const attr of ['href', 'xlink:href']) if (def.getAttribute(attr) != null) return null;
    try { if (def.getAttributeNS && def.getAttributeNS(XLINK, 'href') != null) return null; } catch (e) { return null; }
    let stops = 0;
    for (const s of def.childNodes || []) {
      if (!s || s.nodeType !== 1 || String(s.tagName || '').toLowerCase() !== 'stop') continue;
      stops++;
      if (!parseSolidColor(s.getAttribute('stop-color'))) return null;
    }
    return stops ? def : null;
  }
  function fillUrlId(v) {
    const m = /^url\(\s*#([^)\s]+)\s*\)$/i.exec(String(v || '').trim());
    return m ? m[1] : '';
  }
  function colorPaintList(node, rootDefs, allowAnimated) {
    if (!node || !node.childNodes) return null;
    // ⚠ 节点自己就是一个多帧 MovieClip 时，正常路径不能把父级 cx 烘进它当前的画稿：
    // 它下一帧会换掉内部节点，烘过的颜色当场丢失。这里允许逐帧重烘（`allowAnimated`），
    // 由 showFrame 在每帧建完后重做；换帧的子树不再走一次性的烘焙。
    if (!allowAnimated && node.__clip && node.__clip.frames && node.__clip.frames.length > 1) return null;

    let blocked = false;
    walkElements(node, (p) => {
      if (blocked) return;
      if (p.getAttribute('filter') != null) { blocked = true; return; }
      if (p.__sfBakedBy && p.__sfBakedBy !== node) {
        // 子级已经染过的纯色可以在这里再串上父级；带渐变的子级交给滤镜。
        for (const attr of ['fill', 'stroke']) {
          const base = p.__sfBasePaint && p.__sfBasePaint[attr];
          if (!base) continue;
          if (/^url\(/i.test(base) || !parseSolidColor(base) || !p.__sfCx) { blocked = true; return; }
        }
      }
      // 子树里还有会自己换帧的 MovieClip：一次烘焙跟不上换帧，必须逐帧重烘或保留滤镜。
      if (!allowAnimated && p.__clip && p.__clip.frames && p.__clip.frames.length > 1) { blocked = true; return; }
      if (!PAINT_TAGS[String(p.tagName || '').toLowerCase()]) return;
      for (const attr of ['fill', 'stroke']) {
        const raw = p.getAttribute(attr);
        if (raw == null || raw === 'none') continue;
        const base = (p.__sfBasePaint && p.__sfBasePaint[attr]) || raw;
        if (/^url\(/i.test(base)) {
          if (!gradientOf(rootDefs, fillUrlId(base))) { blocked = true; return; }
          continue;
        }
        if (/^(inherit|currentColor|context-fill|context-stroke)$/i.test(base)) { blocked = true; return; }
        if (!parseSolidColor(base)) { blocked = true; return; }
      }
    });
    if (blocked) return null;
    const paints = [];
    walkElements(node, (p) => {
      if (!PAINT_TAGS[String(p.tagName || '').toLowerCase()]) return;
      for (const attr of ['fill', 'stroke']) {
        const raw = p.getAttribute(attr);
        if (raw == null || raw === 'none') continue;
        const base = (p.__sfBasePaint && p.__sfBasePaint[attr]) || raw;
        const gradient = /^url\(/i.test(base) ? gradientOf(rootDefs, fillUrlId(base)) : null;
        paints.push({ el: p, attr: attr, base: base, rgb: gradient ? null : parseSolidColor(base), gradient: gradient });
      }
    });
    return paints;
  }
  function bakeGradient(rootDefs, def, c) {
    const srcId = def.getAttribute('id') || '';
    const id = 'cxg' + srcId + '_' + cxKey(c);
    if (hasDef(rootDefs, id)) return 'url(#' + id + ')';
    // WHY: 克隆出来的渐变必须自己带 id，`addDef` 只记账不写属性；
    // 少了 id 的 `url(#cxg…)` 在浏览器里是悬空引用，那一层画稿整片不画。
    const out = el(def.tagName, { id });
    for (const [k, v] of attrsOf(def)) if (k !== 'id') out.setAttribute(k, v);
    for (const s of def.childNodes || []) {
      if (!s || s.nodeType !== 1 || String(s.tagName || '').toLowerCase() !== 'stop') continue;
      const stop = el('stop');
      for (const [k, v] of attrsOf(s)) {
        if (k === 'stop-color') {
          const rgb = parseSolidColor(v);
          stop.setAttribute(k, 'rgb(' + cxChannel(c, 'Rm', 'Ra', rgb[0]) + ','
            + cxChannel(c, 'Gm', 'Ga', rgb[1]) + ',' + cxChannel(c, 'Bm', 'Ba', rgb[2]) + ')');
        } else stop.setAttribute(k, v);
      }
      out.appendChild(stop);
    }
    addDef(rootDefs, id, out);
    return 'url(#' + id + ')';
  }
  // 同一张画稿可能被父子两级 cx 轮流接管；只保留最近 8 层，避免逐帧 push 无界增长。
  function rememberPrevCx(el, owner) {
    const stack = el.__sfPrev || (el.__sfPrev = []);
    const top = stack[stack.length - 1];
    if (top && top.by === owner) return;
    stack.push({ cx: el.__sfCx, by: owner });
    if (stack.length > 8) stack.splice(0, stack.length - 8);
  }
  // 把 cx 烘到纯色填充/描边和渐变停靠点上。成功返回 true（不要再挂 filter）。
  // `paints` 可由调用方先算好，避免同一棵子树在一次 applyCx 里走两遍。
  function bakeColorTransform(node, c, rootDefs, allowAnimated, paints) {
    if (!cxRgbOnly(c)) return false;
    if (!paints) paints = colorPaintList(node, rootDefs, allowAnimated);
    if (!paints || !paints.length) return false;
    for (const p of paints) {
      const owner = p.el.__sfBakedBy;
      let eff = c;
      if (owner && owner !== node) {
        eff = composeCx(c, p.el.__sfCx);
        rememberPrevCx(p.el, owner);
      }
      if (!p.el.__sfBasePaint) p.el.__sfBasePaint = {};
      p.el.__sfBasePaint[p.attr] = p.base;
      p.el.__sfBakedBy = node;
      p.el.__sfCx = eff;
      p.el.setAttribute('data-sf-baked', '1');
      if (p.rgb) {
        p.el.setAttribute(p.attr, 'rgb(' + cxChannel(eff, 'Rm', 'Ra', p.rgb[0]) + ','
          + cxChannel(eff, 'Gm', 'Ga', p.rgb[1]) + ',' + cxChannel(eff, 'Bm', 'Ba', p.rgb[2]) + ')');
      } else {
        p.el.setAttribute(p.attr, bakeGradient(rootDefs, p.gradient, eff));
      }
    }
    return true;
  }

  function restoreColorTransform(node) {
    if (!node || !node.childNodes) return;
    walkElements(node, (p) => {
      if (p.__sfBakedBy !== node) return;
      const b = p.__sfBasePaint;
      const stack = p.__sfPrev;
      const prev = stack && stack.length ? stack.pop() : null;
      if (stack && !stack.length) p.__sfPrev = null;
      if (prev && prev.cx && b) {
        // 父级撤掉时把子级原来的染色重新贴回去（只处理纯色；渐变子级本来就不会被串色）。
        p.__sfBakedBy = prev.by;
        p.__sfCx = prev.cx;
        for (const k of Object.keys(b)) {
          const rgb = parseSolidColor(b[k]);
          if (!rgb) continue;
          p.setAttribute(k, 'rgb(' + cxChannel(prev.cx, 'Rm', 'Ra', rgb[0]) + ','
            + cxChannel(prev.cx, 'Gm', 'Ga', rgb[1]) + ',' + cxChannel(prev.cx, 'Bm', 'Ba', rgb[2]) + ')');
        }
        return;
      }
      if (b) for (const k of Object.keys(b)) p.setAttribute(k, b[k]);
      p.__sfCx = null;
      p.__sfBakedBy = null;
      p.removeAttribute('data-sf-baked');
    });
  }

  function clearBakeHooks(node) {
    const cfg = node && node.__bakeCfg;
    if (!cfg) return;
    for (const h of cfg.hooks) {
      const arr = h.clip.__bakeParents;
      if (!arr) continue;
      const i = arr.indexOf(cfg);
      if (i >= 0) arr.splice(i, 1);
    }
    cfg.hooks.length = 0;
    node.__bakeCfg = null;
    node.__bakeCx = null;
  }
  // 逐帧烘焙：换帧会重建内部节点，所以把「谁在换帧后要重烘」登记到每个会换帧的 clip 上。
  function registerBakeHooks(node, cfg) {
    const clips = [];
    if (node.__clip && node.__clip.frames && node.__clip.frames.length > 1) clips.push(node.__clip);
    walkElements(node, (p) => {
      if (p.__clip && p.__clip.frames && p.__clip.frames.length > 1) clips.push(p.__clip);
    });
    for (const clip of clips) {
      if (!clip.__bakeParents) clip.__bakeParents = [];
      if (clip.__bakeParents.indexOf(cfg) < 0) clip.__bakeParents.push(cfg);
      cfg.hooks.push({ clip: clip });
    }
  }
  function rebakeCfg(cfg) {
    if (!cfg || !cfg.node || !cfg.node.childNodes) return;
    if (bakeColorTransform(cfg.node, cfg.c, cfg.rootDefs, true)) {
      updateAttribute(cfg.node, 'filter', null);
    } else {
      // 逐帧烘焙失效（新帧出现位图/嵌套 cx）：先撤掉上一帧烘过的颜色，再挂滤镜，
      // 否则滤镜会在已经乘过一次的画稿上再乘一次。
      if (cfg.node.__sfBaked) { restoreColorTransform(cfg.node); cfg.node.__sfBaked = false; }
      updateAttribute(cfg.node, 'filter', 'url(#' + cxFilterFor(cfg.rootDefs, cfg.tagId, cfg.depth, cfg.c) + ')');
    }
  }

  function applyCx(node, c, rootDefs, tagId, depth) {
    if (!node) return;
    if (!c) {
      // 只有真烘过才遍历子树；绝大多数没有 cx 的节点每帧都走这里，不能退化成 O(N²)。
      clearBakeHooks(node);
      if (node.__sfBaked) { restoreColorTransform(node); node.__sfBaked = false; }
      updateAttribute(node, 'filter', null);
      return;
    }
    if (node.__bakeCfg && node.__bakeCfg.c === c) {
      rebakeCfg(node.__bakeCfg);
      return;
    }
    clearBakeHooks(node);
    if (bakeColorTransform(node, c, rootDefs)) {
      node.__sfBaked = true;
      updateAttribute(node, 'filter', null);
      return;
    }
    // 纯色/渐变的逐帧画稿：登记换帧重烘，避免 iOS 上 feComponentTransfer 整块画黑。
    const animatedPaints = colorPaintList(node, rootDefs, true);
    if (animatedPaints) {
      const cfg = { node: node, c: c, rootDefs: rootDefs, tagId: tagId, depth: depth, hooks: [] };
      node.__bakeCfg = cfg;
      node.__bakeCx = c;
      registerBakeHooks(node, cfg);
      if (bakeColorTransform(node, c, rootDefs, true, animatedPaints)) {
        node.__sfBaked = true;
        updateAttribute(node, 'filter', null);
        return;
      }
      clearBakeHooks(node);
    }
    // 烘不了（位图/嵌套滤镜）：先把本节点上一帧烘过的纯色还原，再挂滤镜，
    // 否则滤镜会把已经乘过一次的颜色再乘一次。
    if (node.__sfBaked) { restoreColorTransform(node); node.__sfBaked = false; }
    updateAttribute(node, 'filter', 'url(#' + cxFilterFor(rootDefs, tagId, depth, c) + ')');
  }


  // 官方那条 diff 逻辑写得很绕（h/j/g/e/o 一堆数组）；这里用等价但直观的做法：
  // 维护 深度→放置 的表，遇到 tp:1 就快照一份，遇到 remove 就删该深度。
  // · 快照里跨帧携带的放置必须剥掉 rp，否则每一帧都被当成"替换"，
  function buildFrames(Sf) {
    const frames = [];
    let cur = new Map();
    let seg = new Set();
    const snap = () => {
      const f = new Map();
      for (const [d, p] of cur) {
        const c = Object.assign({}, p);
        if (seg.has(d)) c.placedHere = true;
        else { delete c.rp; delete c.placedHere; }
        f.set(d, c);
      }
      // 缓存在帧对象上：排序后的深度表 / 蒙版表 / 「这一帧有没有具名放置」。
      const depths = [...f.keys()].sort((a, b) => a - b);
      const masks = [];
      for (const d of depths) {
        const q = f.get(d);
        if (q && q.cD !== undefined) masks.push({ d: d, cD: q.cD, p: q });
      }
      f.__depths = depths;
      f.__masks = masks;
      f.__maskDepths = new Set(masks.map((m) => m.d));
      f.__hasNames = depths.some((d) => { const q = f.get(d); return !!(q && q.na); });
      frames.push(f);
      seg = new Set();
    };
    for (const p of Sf || []) {
      if (p.tp === 1) { snap(); continue; }
      if (p.remove) { cur.delete(p.d); seg.delete(p.d); continue; }
      if (p.id === undefined) continue;
      const prev = cur.get(p.d);
      const merged = Object.assign({}, prev || {}, p);
      // 导出器以 opacity 表示显式 ColorTransform；RGB 为恒等时省略 cx。
      // 只有矩阵更新时仍继承颜色，显式重置颜色时则不能留下上一帧的灰化滤镜。
      if (p.opacity !== undefined && p.cx === undefined) delete merged.cx;
      if (p.ma === undefined && prev && prev.ma !== undefined) merged.ma = prev.ma;
      if (p.rp === undefined) delete merged.rp;
      delete merged.placedHere;
      cur.set(p.d, merged);
      seg.add(p.d);
    }
    if (!frames.length) snap();
    return frames;
  }

  // Flash 里没有任何"动画系统"：每个 MovieClip 各自维护播放头，舞台按帧率统一走帧。
  // ⚠ 注册表按视图分开（`opts.live`），不是全剧一个：
  const views = new Set();
  let ticker = 0, tickCount = 0;
  // 失焦暂停：macOS 切到别的 App 时 `window` 会 blur，但 `document.hidden` 仍是 false。
  // 部分 WebView 会一开始就报 false，那样动画会永远不动。
  let pageBlurred = false;
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('blur', () => { pageBlurred = true; });
    window.addEventListener('focus', () => { pageBlurred = false; });
  }
  let clipSeq = 0;
  let cpSeq = 0;                 // clipPath 的全局唯一 id 计数（蒙版用）


  function regOf(clip) { return clip && clip.opts && clip.opts.live; }
  function unregisterDeep(clip) {
    const reg = regOf(clip);
    if (reg) reg.delete(clip);
    for (const v of clip.nodes.values()) if (v.clip) unregisterDeep(v.clip);
    for (const c of clip.__attached || []) unregisterDeep(c);
  }

  function rootVisible(root) {
    try {
      if (!root) return false;
      if (root.style && root.style.display === 'none') return false;
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(root);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      }
    } catch (e) {  }
    return true;
  }
  function startTicker(fps) {
    // ⚠ 这里不能清注册表：mount 是先建完整棵实例树（全部注册）再启节拍的，
    if (ticker) clearInterval(ticker);
    const ms = Math.max(16, 1000 / (fps || 14));
    ticker = setInterval(() => {
// timeline; otherwise Android keeps timers running but every clip stalls.
      const runInBackground = !!(window.Main && Main.settings && Main.settings().backgroundRun);
      if (typeof document !== 'undefined' && (document.hidden || pageBlurred) && !runInBackground) return;
      tickCount++;
      for (const view of [...views]) {
        if (!view.root || !view.root.isConnected) {
          view.live.clear(); views.delete(view); continue;
        }

        if (view.__visible === undefined || tickCount % 10 === 0) view.__visible = rootVisible(view.root);
        if (view.__visible === false) continue;
        for (const c of [...view.live]) {

          if (c.__pinFrame != null) {
            if (c.frame !== c.__pinFrame) { c.frame = c.__pinFrame; try { c.showFrame(); } catch (e) {} }
            continue;
          }
          if (!c.playing || c.frames.length < 2) continue;
          if (!c.g.isConnected) { unregisterDeep(c); continue; }

          const st = c.g.style;
          if (st && (st.visibility === 'hidden' || st.display === 'none')) {
            c.frame = (c.frame + 1) % c.frames.length;
            continue;
          }
          c.frame = (c.frame + 1) % c.frames.length;
          try { c.showFrame(); } catch (e) {}
        }
        // 每拍结束后的视图钩子：页面用它把"必须压在角色上面的装备骨"重新提到末尾
        if (typeof view.onTick === 'function') { try { view.onTick(); } catch (e) {} }
      }
      if (!views.size) stopTicker();
    }, ms);
  }
  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = 0; }
  }
  // iOS / Android 16 切后台回来时，WebView 可能丢掉 SVG 内嵌位图的解码结果
  function repaintRaster() {
    for (const view of views) {
      const root = view.root;
      if (!root || !root.isConnected) continue;
      const images = root.querySelectorAll ? root.querySelectorAll('image') : [];
      for (const img of images) {
        const href = img.getAttributeNS(XLINK, 'href') || img.getAttribute('href');
        if (!href) continue;
        try {
          img.removeAttributeNS(XLINK, 'href');
          img.removeAttribute('href');
          const restore = () => {
            try { if (img.isConnected) img.setAttributeNS(XLINK, 'href', href); } catch (e) {}
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore); else restore();
        } catch (e) {}
      }
      try {
        const prev = root.style.transform;
        root.style.transform = 'translateZ(0)';
        void root.getBoundingClientRect();
        root.style.transform = prev;
        // 再原地摘挂一次 SVG：节点、子元素、事件与当前帧都保留，只让内核重建
        // 这一层的合成缓存。iOS / Android 16 整层位图丢失时，这一步比只改 transform 更可靠。
        const parent = root.parentNode;
        if (parent) {
          const next = root.nextSibling;
          parent.removeChild(root);
          parent.insertBefore(root, next);
        }
      } catch (e) {}
    }
  }

  // 静态页策略 —— "UI 在自己所有可达帧之间乱跳"的统一解法
  // （每个页面文件里都有一段"必须先摘 `__pinFrame`"的注释）。`playing = false` 只是

  function makePolicy(spec) {
    const s = spec || {};
    const toSet = (v) => new Set((v ? (Array.isArray(v) || v instanceof Set ? [...v] : [v]) : []).map(String));
    return { keepName: toSet(s.keepNames), keepId: toSet(s.keepIds), blankName: toSet(s.blankNames) };
  }

  function policyKeeps(pol, name, id) {
    if (!pol) return false;
    return pol.keepId.has(String(id)) || !!(name && pol.keepName.has(String(name)));
  }
  // 出生 / 重建之后按策略处理一颗实例：命中白名单的整棵子树免冻，其余 `playing = false`。
  // ⚠ 冻结不碰帧号（帧号永远由界面代码做主，冻结 ≠ 钉帧，见上面那段注释）—— 唯一例外是
  function applyStatic(clip, name) {
    if (!clip || !clip.gotoAndStop) return;
    const pol = clip.__policy;
    if (!pol || clip.__keepAnim || clip.__playLock) return;
    if (policyKeeps(pol, name, clip.tag && clip.tag.id)) { clip.__keepAnim = true; return; }
    clip.playing = false;
    if (name && pol.blankName.has(String(name)) && clip.frames.length > 1
      && clip.frame !== clip.frames.length - 1) {
      clip.frame = clip.frames.length - 1;
      try { clip.showFrame(); } catch (e) {}
    }
  }
  // 递归把策略应用到一棵已经存在的子树上（含 `attachChild` 挂上来的那一支）。
  // ⚠ 必须沿着树往下写 `__policy`，不能只 `applyStatic()`：`applyStatic` 读的是
  function walkStatic(clip) {
    const pol = clip.__policy, keep = clip.__keepAnim;
    for (const rec of clip.nodes.values()) {
      if (rec.clip) {
        rec.clip.__policy = pol;
        rec.clip.__keepAnim = rec.clip.__keepAnim || keep;
        applyStatic(rec.clip, rec.na);
        walkStatic(rec.clip);
      }
    }
    for (const c of clip.__attached || []) {
      c.__policy = pol;
      c.__keepAnim = c.__keepAnim || keep;
      applyStatic(c, c.g && c.g.getAttribute ? c.g.getAttribute('attach-name') : null);
      walkStatic(c);
    }
  }


  function MovieClip(tag, rootDefs, opts) {
    this.tag = tag;
    this.uid = ++clipSeq;            // 实例唯一号（`debug()` 用；跨采样认同一颗实例）
    this.rootDefs = rootDefs;
    this.opts = opts || {};
    this.frames = buildFrames(tag.Sf);
    this.frame = 0;
    this.__shownFrame = -1;
    this.playing = true;
    this.names = new Map();
    this.nodes = new Map();
    // 换帧会重建文本节点；先登记真值，节点出生时就写进去，避免先画一帧作者占位串。
    this.__pendingText = new Map();
    this.g = el('g', { type: 'sprite' });
    this.g.setAttribute('sid', String(tag.id));
    this.__cps = new Map();

    this.__policy = null;
    this.__keepAnim = false;
    this.__playLock = false;
    const reg = this.opts && this.opts.live;
    if (reg) reg.add(this);
  }

  MovieClip.prototype.setStaticPolicy = function (spec) {
    this.__policy = spec ? makePolicy(spec) : null;
    this.__keepAnim = false;
    applyStatic(this, null);
    walkStatic(this);
    return this;
  };

  MovieClip.prototype.setContentHost = function (host) {
    this.__contentHost = host;
    return this;
  };
  // 给具名文本字段登记真值：当前帧已经有这个节点就先写，后续换帧重建时在出生处写。
  // 只对文本字段生效；数字精灵/其它元件遇到同名忽略。
  MovieClip.prototype.setPendingText = function (name, value) {
    const key = String(name || '');
    if (!key) return false;
    this.__pendingText.set(key, value == null ? '' : String(value));
    const node = this.byName(key);
    if (node && node.__textBox) setText(node, value);
    return true;
  };
  MovieClip.prototype.getContentHost = function () {
    const host = this.__contentHost;
    return host && host.parentNode === this.g ? host : this.g;
  };
  MovieClip.prototype.placeFrameNode = function (node) {
    const host = this.getContentHost();
    const attached = (this.__attached || []).find((c) => c.g.parentNode === host);
    host.insertBefore(node, attached ? attached.g : null);
  };
  // 蒙版（SWF `cD` 裁剪深度）的 clipPath 宿主：挂在本实例的 <g> 里，
  // 这样 id 唯一、作用域也只在本实例内。
  MovieClip.prototype.clipHost = function () {
    if (!this.__clipHost) {
      this.__clipHost = el('defs');
      this.__clipHost.setAttribute('type', 'clip');
      this.g.insertBefore(this.__clipHost, this.g.firstChild);
    }
    return this.__clipHost;
  };

  MovieClip.prototype.clipFor = function (m) {
    let cp = this.__cps.get(m.d);
    if (!cp) {
      cp = { id: 'sfc' + (++cpSeq), el: el('clipPath'), sig: null };
      cp.el.setAttribute('id', cp.id);
      cp.el.setAttribute('clipPathUnits', 'userSpaceOnUse');
      this.clipHost().appendChild(cp.el);
      this.__cps.set(m.d, cp);
    }
    const sig = String(m.p.id) + '|' + (m.p.ma || '');
    if (cp.sig !== sig) {
      cp.sig = sig;
      while (cp.el.firstChild) cp.el.removeChild(cp.el.firstChild);
      const child = this.tagFor(m.p.id);
      // 只有形状能直接当蒙版；tp 39 精灵当蒙版的情况村庄页没有，遇到就退回不裁
      // （宁可多画一层，也不要裁错整块界面）。
      // ⚠ 路径必须直接放进 <clipPath>：SVG 规定 clipPath 的子元素只能是形状元素，
      if (child && child.tp === 2) {
        for (const seg of child.pt || []) {
          const path = el('path', { d: seg.da });
          if (m.p.ma) path.setAttribute('transform', 'matrix(' + m.p.ma + ')');
          cp.el.appendChild(path);
        }
      } else {
        cp.sig = null;
        return null;
      }
    }
    return cp.id;
  };
  MovieClip.prototype.showFrame = function () {
    // 里不会重建显示列表；这里同样什么都不用做 —— 文本、装备、额外变换各有自己的入口，
    if (this.__shownFrame === this.frame) return this;
    const frame = this.frames[this.frame] || new Map();

    const frameAdvanced = true;
    if (frame.__hasNames || this.names.size) this.names.clear();
    const depths = frame.__depths || (frame.__depths = [...frame.keys()].sort((a, b) => a - b));

    let keepOrder = depths.length === this.nodes.size;
    const ordered = [];
    if (keepOrder) {
      for (const d of depths) {
        const p = frame.get(d), old = this.nodes.get(d);
        if (!old || old.id !== String(p.id) || (frameAdvanced && p.rp && p.placedHere)) { keepOrder = false; break; }
        ordered.push(old.wrap || old.node);
      }
    }
    if (keepOrder) {
      const host = this.getContentHost(), nodes = new Set(ordered);
      const attached = new Set((this.__attached || []).map(c => c.g));
      let at = 0, pastAttachment = false;
      for (const node of host.childNodes) {
        if (attached.has(node)) pastAttachment = true;
        if (nodes.has(node) && (pastAttachment || node !== ordered[at++])) { keepOrder = false; break; }
      }
      if (at !== ordered.length) keepOrder = false;
    }

    const masks = frame.__masks || (frame.__masks = (() => {
      const out = [];
      for (const d of depths) {
        const q = frame.get(d);
        if (q && q.cD !== undefined) out.push({ d: d, cD: q.cD, p: q });
      }
      return out;
    })());
    const maskDepths = frame.__maskDepths || (frame.__maskDepths = new Set(masks.map((m) => m.d)));
    const isMaskDepth = (d) => maskDepths.has(d);
    const maskOf = (d) => { for (const m of masks) if (d > m.d && d <= m.cD) return m; return null; };
    const next = new Map();
    for (const d of depths) {
      const p = frame.get(d);
      const prev = this.nodes.get(d);
      // 实例复用（动画的关键）：同深度、同元件 → 保留原实例，只更新变换，
      // 唯一的例外：帧推进后，该深度有一条"这一帧段里真正出现"的 rp 放置 ——
      const replace = frameAdvanced && !!(p.rp && p.placedHere);
      if (prev && prev.id === String(p.id) && !replace) {
        prev.node.__baseMa = p.ma || null;
        applyNodeXform(prev.node);
        updateAttribute(prev.node, 'opacity', p.opacity);
        applyCx(prev.node, cxOf(p), this.rootDefs, this.tag.id, d);
        // 蒙版可以在后续帧出现、撤销或改变覆盖深度，不能只更新已有 wrapper。
        updateAttribute(prev.node, 'clip-depth', p.cD);
        const oldTarget = prev.wrap || prev.node;
        const mReuse = maskOf(d);
        const cpId = mReuse && this.clipFor(mReuse);
        if (cpId) {
          if (!prev.wrap) {
            prev.wrap = el('g');
            if (prev.node.parentNode) prev.node.parentNode.insertBefore(prev.wrap, prev.node);
            prev.wrap.appendChild(prev.node);
          }
          updateAttribute(prev.wrap, 'clip-from', mReuse.d);
          updateAttribute(prev.wrap, 'clip-path', 'url(#' + cpId + ')');
        } else if (prev.wrap) {
          const wrap = prev.wrap;
          if (wrap.parentNode) wrap.parentNode.insertBefore(prev.node, wrap);
          else wrap.removeChild(prev.node);
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          prev.wrap = null;
        }
        const target = prev.wrap || prev.node;
        const isMask = isMaskDepth(d);
        if (prev.isMask && oldTarget !== target) updateAttribute(oldTarget, 'visibility', null);
        if (isMask) updateAttribute(target, 'visibility', 'hidden');
        else if (prev.isMask) updateAttribute(target, 'visibility', null);
        prev.isMask = isMask;
        if (p.na) this.names.set(p.na, prev.clip || prev.node);
        if (!keepOrder) this.placeFrameNode(prev.wrap || prev.node);
        next.set(d, prev);
        continue;
      }

      if (prev) {
        if (prev.clip) unregisterDeep(prev.clip);
        // ⚠ 必须按自己的实际父节点摘，不能只认 `this.g`：`popWrap()` 会把可见内容
        const oldHost = prev.wrap || prev.node;
        if (oldHost.parentNode) oldHost.parentNode.removeChild(oldHost);
      }
      const child = this.tagFor(p.id);
      if (!child) continue;
      let node, clip;
      if (child.tp === 39) {
        clip = new MovieClip(child, this.rootDefs, this.opts);
        clip.parent = this;

        clip.__policy = this.__policy;
        clip.__keepAnim = this.__keepAnim;
        clip.showFrame();
        applyStatic(clip, p.na);
        node = clip.g;
        node.__clip = clip;
      } else if (child.tp === 11) {
        node = textNode(child, this.rootDefs);
        if (p.na && this.__pendingText.has(p.na)) setText(node, this.__pendingText.get(p.na));
      } else {
        node = shapeNode(this.rootDefs, child);
      }
      node.setAttribute('depth', d);
      node.__baseMa = p.ma || null;
      applyNodeXform(node);
      if (p.opacity !== undefined) node.setAttribute('opacity', p.opacity);
      applyCx(node, cxOf(p), this.rootDefs, this.tag.id, d);
      if (p.cD !== undefined) node.setAttribute('clip-depth', p.cD);
      if (p.na) this.names.set(p.na, clip || node);

      let wrap = null;
      const m = maskOf(d);
      if (m) {
        const cpId = this.clipFor(m);
        if (cpId) {
          wrap = el('g');
          wrap.setAttribute('clip-from', String(m.d));
          wrap.setAttribute('clip-path', 'url(#' + cpId + ')');
          wrap.appendChild(node);
        }
      }
      const target = wrap || node;
      if (isMaskDepth(d)) target.setAttribute('visibility', 'hidden');
      this.placeFrameNode(target);
      // 新实例出生回调：必须在节点进文档之后再调。
      // ⚠ 以前回调放在 `placeFrameNode` 之前，`setSymbol` → `anchorToBBox` 里的
      if (clip && this.opts && typeof this.opts.onClip === 'function') {
        try { this.opts.onClip(clip); } catch (e) {}
      }
      next.set(d, { id: String(p.id), node, clip, wrap, isMask: isMaskDepth(d), na: p.na || null });
    }
    // 新帧里不存在的深度：移除（并注销子树）
    // ⚠ 与上面"替换"那一支同理：按自己的实际父节点摘。`popWrap()` 的 `<g class="uc-pop">`
    for (const [d, old] of this.nodes) {
      if (next.has(d)) continue;
      if (old.clip) unregisterDeep(old.clip);
      const host = old.wrap || old.node;
      if (host.parentNode) host.parentNode.removeChild(host);
    }
    this.nodes = next;
    this.__shownFrame = this.frame;
    // 页面可选的帧后处理；素材自身的深度和蒙版由上面的显示列表维护。
    // 回调异常不能中断整棵动画树。
    if (typeof this.__frameFix === 'function') {
      try { this.__frameFix(this); } catch (e) {}
    }
    const selfCfg = this.g && this.g.__bakeCx ? this.g.__bakeCfg : null;
    if (selfCfg) rebakeCfg(selfCfg);
    if (this.__bakeParents && this.__bakeParents.length) {
      // 自己的 cfg 也可能登记在 __bakeParents 里，别再烘第二遍。
      for (const cfg of this.__bakeParents.slice()) if (cfg !== selfCfg) rebakeCfg(cfg);
    }
    return this;
  };
  MovieClip.prototype.tagFor = function (id) {
    if (!bundle) return null;
    return bundle.hash.get(String(id)) || null;
  };

  MovieClip.prototype.byName = function (name) { return this.names.get(name) || null; };
  MovieClip.prototype.byNameDeep = function (name) {
    let hit = this.names.get(name);
    if (hit) return hit;
    for (const v of this.names.values()) {
      if (v instanceof MovieClip) { hit = v.byNameDeep(name); if (hit) return hit; }
    }
    return null;
  };
  MovieClip.prototype.gotoAndStop = function (n) {
    const i = Math.max(0, Math.min(this.frames.length - 1, (n | 0) - 1));
    this.frame = i; this.playing = false; this.showFrame(); return this;
  };
  MovieClip.prototype.gotoAndPlay = function (n) {
    const i = Math.max(0, Math.min(this.frames.length - 1, (n | 0) - 1));
    this.frame = i; this.playing = true; this.showFrame(); return this;
  };
  MovieClip.prototype.play = function () { this.playing = true; return this; };
  MovieClip.prototype.stop = function () { this.playing = false; return this; };

  MovieClip.prototype.pinFrame = function (n) {
    const idx = Math.max(0, Math.min(this.frames.length - 1, (n || 1) - 1));
    this.__pinFrame = idx;
    if (this.frame !== idx) { this.frame = idx; try { this.showFrame(); } catch (e) {} }
    return this;
  };
  MovieClip.prototype.frameCount = function () { return this.frames.length; };

  MovieClip.prototype.setExtraTransform = function (t) {
    this.g.__extra = t || '';
    this.applyXform();
    return this;
  };

  function updateAttribute(node, name, value) {
    const next = value == null || value === '' ? null : String(value);
    if (node.getAttribute(name) === next) return;
    if (next === null) node.removeAttribute(name);
    else node.setAttribute(name, next);
  }
  function applyNodeXform(node) {
    const t = ((node.__baseMa ? 'matrix(' + node.__baseMa + ')' : '') + ' ' + (node.__extra || '')
      + ' ' + (node.__nudge || '')).trim();
    updateAttribute(node, 'transform', t);
  }
  // 素材矩阵之外的父坐标平移（`opts.nudge`）；切帧重建节点后不会保留。
  function nudgeNode(node, dx, dy) {
    const g = node && (node.g || node);
    if (!g) return;
    g.__nudge = 'translate(' + (Number(dx) || 0) + ',' + (Number(dy) || 0) + ')';
    applyNodeXform(g);
  }
  function nudge(node, dx, dy) { nudgeNode(node, dx, dy); return true; }
  MovieClip.prototype.applyXform = function () { applyNodeXform(this.g); };

  MovieClip.prototype.setDepthExtra = function (depth, extra) {
    const v = this.nodes.get(depth);
    if (!v) return false;
    v.node.__extra = extra || '';
    applyNodeXform(v.node);
    return true;
  };

  MovieClip.prototype.setSymbol = function (symbolId, frame, scale, anchorBBox, tail) {
    const tag = this.tagFor(symbolId);
    if (!tag || tag.tp !== 39) return false;
    if (String(this.tag.id) !== String(symbolId)) {
      this.detachAll();
      // 旧子树先注销，否则它们会留在播放注册表里空转
      for (const v of this.nodes.values()) if (v.clip) unregisterDeep(v.clip);
      this.nodes.clear();
      this.names.clear();
      const content = this.getContentHost();
      for (const c of [...content.childNodes]) if (c !== this.__clipHost) content.removeChild(c);
      this.tag = tag;
      this.g.setAttribute('sid', String(tag.id));
      this.frames = buildFrames(tag.Sf);
      this.__shownFrame = -1;
    }
    this.gotoAndStop(frame || 1);
    const s = (scale && scale !== 1) ? scale : 1;
    // `tail`（画稿自身偏移）必须在 anchorToBBox 里面拼，不能在调用方 append —— 见那边的注释
    if (anchorBBox) this.anchorToBBox(s, anchorBBox === true ? 'topleft' : anchorBBox, tail);
    else this.setExtraTransform(('scale(' + s + ')' + (tail ? ' ' + tail : '')).trim());

    this.__keepAnim = false;
    applyStatic(this, null);
    return true;
  };

  MovieClip.prototype.attachChild = function (symbolId, frame, name) {
    const tag = this.tagFor(symbolId);
    if (!tag || tag.tp !== 39) return null;
    const clip = new MovieClip(tag, this.rootDefs, this.opts);
    clip.parent = this;
    clip.__policy = this.__policy;
    clip.__keepAnim = this.__keepAnim;
    clip.gotoAndStop(frame || 1);
    applyStatic(clip, name);
    clip.g.setAttribute('type', 'attached');
    if (name) clip.g.setAttribute('attach-name', name);
    this.getContentHost().appendChild(clip.g);
    if (!this.__attached) this.__attached = [];
    this.__attached.push(clip);
    return clip;
  };

  MovieClip.prototype.holdAnim = function (on) { this.__playLock = on !== false; return this; };
  MovieClip.prototype.detachAll = function () {
    for (const c of this.__attached || []) {
      unregisterDeep(c);
      if (c.g.parentNode) c.g.parentNode.removeChild(c.g);
    }
    this.__attached = [];
    // `attachImage` 挂的联机自建道具矢量图不参与播放注册，但换奖/重画时要一起收掉。
    for (const img of this.__images || []) if (img.parentNode) img.parentNode.removeChild(img);
    this.__images = [];
  };
  // 没有 SWF 库导出的联机自建道具：用背包同一张 SVG 补进战利品格（走这条路的
  // `loot-icons.json` 条目只有 `svg`）。尺寸取格子的实际 bbox，避免不同战果页的格子缩放不一。
  MovieClip.prototype.attachImage = function (href, opts) {
    const src = String(href || '');
    if (!src) return null;
    const host = this.getContentHost();
    if (!host) return null;
    let b = null;
    try { b = this.g.getBBox(); } catch (_) { b = null; }
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    const pad = Math.max(0, Math.min(0.3, Number(opts && opts.pad) || 0)) * Math.min(b.width, b.height);
    const img = el('image', {
      x: b.x + pad, y: b.y + pad,
      width: Math.max(1, b.width - pad * 2), height: Math.max(1, b.height - pad * 2),
      preserveAspectRatio: 'xMidYMid meet', class: 'sf-loot-svg',
    });
    img.setAttribute('href', src);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', src);
    host.appendChild(img);
    if (!this.__images) this.__images = [];
    this.__images.push(img);
    return img;
  };
  // 把内容缩放 `s` 后，再平移到「缩放后的包围盒 <mode> 点 = 本实例原点」。
  // 必须从这里拼进去：实例刚建出来时还没进文档，`getBBox()` 拿不到，会安排下一帧重算，
  // 装备容器的包围盒只跟「元件号 + 帧号」有关，量一次就能一直用。
  // 缓存它之后，战斗里每回合重建身体/挂点时不必再等下一帧量 bbox ——
  const bboxCache = new Map();
  MovieClip.prototype.anchorToBBox = function (s, mode, tail, retry) {
    const self = this, sc = (s && s !== 1) ? s : 1, md = mode || 'topleft';
    const after = tail ? ' ' + tail : '';

    const seq = (this.__anchorSeq = (this.__anchorSeq || 0) + 1);
    const cacheKey = this.tag ? String(this.tag.id) + '@' + this.frame : '';
    let b = cacheKey ? bboxCache.get(cacheKey) : null;
    const restore = () => {
      if (seq !== this.__anchorSeq || !this.__anchorHidden || !this.g || !this.g.style) return;
      this.__anchorHidden = false;
      this.g.style.visibility = this.__anchorPrevVisibility || '';
    };
    if (!b) {
      if (!this.__anchorHidden && this.g && this.g.style) {
        this.__anchorHidden = true;
        this.__anchorPrevVisibility = this.g.style.visibility;
        this.g.style.visibility = 'hidden';
      }
      this.g.__extra = '';
      this.applyXform();
      try { b = this.g.getBBox(); } catch (e) { b = null; }
      if (b && b.width && b.height && cacheKey) bboxCache.set(cacheKey, { x: b.x, y: b.y, width: b.width, height: b.height });
    }
    if (!b || (!b.width && !b.height)) {
      // 子树还在同一个同步任务里构建：`showFrame()` 先 `new MovieClip` + `showFrame()`、
      // 6532，再逐层建动作片断）正是这条路径 —— 只靠下面的 rAF 补锚点在隐藏标签页
      if (!retry && this.g && this.g.isConnected === false && typeof Promise !== 'undefined') {
        Promise.resolve().then(() => {
          if (self.__anchorSeq !== seq) return;
          try { self.anchorToBBox(sc, md, tail, true); } catch (e) {}
        });
        return;
      }
      if (!retry && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          // 这一帧里如果已经换了符号 / 重新锚定过，旧回调不能再拿旧包围盒摆一次。
          if (self.__anchorSeq !== seq) return;
          try { self.anchorToBBox(sc, md, tail, true); } catch (e) {}
        });
      } else {

        restore();
      }
      return;
    }
    const px = md === 'center' ? b.x + b.width / 2 : md === 'bottom' ? b.x + b.width / 2 : b.x;
    const py = md === 'center' ? b.y + b.height / 2 : md === 'bottom' ? b.y + b.height : b.y;
    this.g.__extra = 'translate(' + (-px * sc) + ',' + (-py * sc) + ') scale(' + sc + ')' + after;
    this.applyXform();
    restore();
  };



  function svgRoot(rootHost, viewBox, preserve) {
    const svg = el('svg', {
      viewBox: viewBox,

      preserveAspectRatio: preserve || 'xMidYMid meet',
      width: '100%', height: '100%',
    });
    rootHost.appendChild(svg);
    return svg;
  }
  // 把一块 `<svg>` 的「屏幕坐标 ↔ 用户坐标」关系算出来。
  // 为什么不用 `getScreenCTM()`：WebKit 209220（iOS 15.5/15.6 仍复现）的 CTM 不含
  // 也不能假设 sx === sy：系统设置「全面屏」时 `fitCanvas()` 让两轴各自铺满窗口
  function svgScreenMap(svg) {
    if (!svg || !svg.getBoundingClientRect || !svg.viewBox) return null;
    let box;
    try { box = svg.getBoundingClientRect(); } catch (e) { return null; }
    const vb = svg.viewBox.baseVal;
    if (!box || !(box.width > 0) || !(box.height > 0) || !vb || !(vb.width > 0) || !(vb.height > 0)) return null;
    // 需要的是 CSS 布局尺寸（不含 #ui transform），用它把屏幕像素折回设计像素。
    // 而且不会像 SVG 的 clientWidth/clientHeight 那样在个别 WKWebView 版本里
    let cw = 0, ch = 0;
    try {
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(svg);
        cw = parseFloat(cs && cs.width) || 0;
        ch = parseFloat(cs && cs.height) || 0;
      }
    } catch (e) {  }
    if (!(cw > 0) || !(ch > 0)) { cw = Number(svg.clientWidth) || 0; ch = Number(svg.clientHeight) || 0; }
    if (!(cw > 0) || !(ch > 0)) { cw = box.width; ch = box.height; }
    if (!(cw > 0) || !(ch > 0)) return null;
    const kx = box.width / cw, ky = box.height / ch;
    const par = String(svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
    const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
    let offX = 0, offY = 0, mx, my;
    if (/\bnone\b/.test(par)) {
      mx = cw / vb.width; my = ch / vb.height;
    } else {
      const s = /\bslice\b/.test(par)
        ? Math.max(cw / vb.width, ch / vb.height)
        : Math.min(cw / vb.width, ch / vb.height);
      const cwScaled = vb.width * s, chScaled = vb.height * s;
      offX = (cw - cwScaled) * ax;
      offY = (ch - chScaled) * ay;
      mx = my = s;
    }
    const scaleX = mx * kx, scaleY = my * ky;
    const x0 = box.left + offX * kx - vb.x * scaleX;
    const y0 = box.top + offY * ky - vb.y * scaleY;
    return {
      svg: svg, box: box, viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height },
      scaleX: scaleX, scaleY: scaleY, x0: x0, y0: y0,

      content: { x: offX, y: offY, width: vb.width * mx, height: vb.height * my },
      toUser: (sx, sy) => ({ x: (sx - x0) / scaleX, y: (sy - y0) / scaleY }),
      toClient: (ux, uy) => ({ x: x0 + ux * scaleX, y: y0 + uy * scaleY }),
    };
  }

  // 建一棵挂在 `root`（一个 `<svg>`）上的时间轴：共用 mount / mountSymbol 的收尾。
  // `framesOverride` 给根时间轴用（它的帧快照在 `timeline.frames` 里已经切好了）。
  function buildView(root, tag, tl, o, frame, framesOverride) {
    if (!o.live) o.live = new Set();
    const view = new MovieClip(tag, defsHost(root), o);
    view.g = root;
    view.live = o.live;
    if (framesOverride) view.frames = framesOverride;
    view.frame = Math.max(0, Math.min(view.frames.length - 1, (frame || 1) - 1));

    view.playing = false;

    view.__policy = o.policy ? makePolicy(o.policy) : null;
    view.showFrame();
    startTicker(tl.Fr);
    views.add(view);
    view.timeline = tl;
    view.labels = tl.labels;
    view.gotoLabel = function (name) {
      const f = tl.labels[name];
      if (!f) return null;
      view.frame = f - 1;
      view.showFrame();
      return view;
    };
    view.root = root;
    view.destroy = function () {
      views.delete(view);
      if (o.live) o.live.clear();
      if (root.parentNode) root.parentNode.removeChild(root);
      // ⚠ 不再无条件 `stopTicker()`：别的视图（盖在下面的那一页）还在播。
      if (!views.size) stopTicker();
    };
    return view;
  }
  async function mount(container, opts) {
    const b = await load();
    // ⚠ 复制一份 opts：播放注册表（`live`）与静态页策略（`policy`）要写在这一次挂载自己的
    const o = Object.assign({}, opts || {});
    const tl = b.timeline;
    container.classList.add('ssfight-view');
    while (container.firstChild) container.removeChild(container.firstChild);

    const viewBox = tl.Ft.xi + ' ' + tl.Ft.yi + ' ' + (tl.Fw || 320) + ' ' + (tl.Fh || 196);
    const root = svgRoot(container, viewBox, o.preserveAspectRatio);
    if (tl.Bg && tl.Bg !== '#FFFFFF') {
      root.appendChild(el('rect', { x: tl.Ft.xi, y: tl.Ft.yi, width: tl.Fw, height: tl.Fh, fill: tl.Bg }));
    }

    // 根时间轴也是一条 SWF 标签流，同一个 MovieClip 概念；
    // 只是它的帧快照在导出里已经切好了（timeline.frames），直接用。
    const rootTag = { id: 'root', tp: 39, Sf: null };
    const frames = tl.frames.map((placements) => {
      const m = new Map();
      for (const p of placements) m.set(p.d, p);
      return m;
    });
    return buildView(root, rootTag, tl, o, o.frame === undefined ? 1 : o.frame, frames);
  }

  // 原版有一大批页面不是根时间轴的帧，而是运行时 `_root.attachMovie("家园弹出", …)` 挂上去的
  // · 根元件必须 `playing=false`：这类容器本身就是"11 页共用一条时间轴"，
  async function mountSymbol(container, id, opts) {
    const b = await load();
    const tag = b.hash.get(String(id));
    if (!tag) throw new Error('素材库里没有元件 ' + id + '（对应的 tags-*.json 没加载？）');
    if (tag.tp !== 39) throw new Error('元件 ' + id + ' 不是精灵（tp' + tag.tp + '），挂不了');
    const o = Object.assign({}, opts || {});
    const tl = b.timeline;
    // ⚠ 挂库元件的都是"二级/整页展开"的那一层（挑战页 7638 / 状态页 7218 /
    container.classList.remove('ssfight-home-page');
    while (container.firstChild) container.removeChild(container.firstChild);
    const viewBox = o.viewBox || (tl.Ft.xi + ' ' + tl.Ft.yi + ' ' + (tl.Fw || 320) + ' ' + (tl.Fh || 196));
    const root = svgRoot(container, viewBox, o.preserveAspectRatio);
    const view = buildView(root, tag, tl, o, o.frame === undefined ? 1 : o.frame);
    // `opts.blank`：建树的那一刻就把几个字段清空。
    // 原版素材里的文本字段带作者的占位串（状态页的 `expNum` 写的是
    // 或 00000000 持续 1 秒左右"）。这些字段的值百分百由界面提供，
    if (o.blank && o.blank.length) {
      for (const name of o.blank) {
        const hit = view.byName ? view.byName(name) : null;
        if (hit) { try { setText(hit, ''); } catch (e) {} }
      }
    }
    // `opts.nudge`：按元件名在父坐标里平移（原版文本字段整体偏上时用，不动素材矩阵和字段框）。
    if (o.nudge) {
      for (const name of Object.keys(o.nudge)) {
        const hit = view.byName ? view.byName(name) : null;
        const delta = o.nudge[name];
        if (hit && delta) nudgeNode(hit, delta[0], delta[1]);
      }
    }
    view.symbolId = String(id);
    view.label = o.label || '';
    return view;
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let lootIconsTable = null;
  async function loadLootIcons() {
    if (lootIconsTable) return lootIconsTable;
    try { lootIconsTable = ((await loadTable('loot-icons.json')) || {}).byId || {}; }
    catch (e) { lootIconsTable = {}; }
    return lootIconsTable;
  }

  // 停帧的两种口径：`stopAt` 只拨帧；`setPinned` 还清掉 `__pinFrame` 并钉住播放头。
  function stopAt(clip, n) {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(n); } catch (e) {}
  }
  function setPinned(clip, frame) {
    if (!clip || !clip.gotoAndStop) return;
    const want = Math.max(1, Math.round(Number(frame) || 1));
    clip.__pinFrame = null;
    if (clip.frame !== want - 1) { try { clip.gotoAndStop(want); } catch (e) {} }
    clip.playing = false;
  }

  window.SfRender = {
    load, loaded, loadExtra, loadTable, releaseExtra, queueExtraRelease, mount, mountSymbol, buildFrames, stopTicker,
    stopAt, setPinned, loadLootIcons, esc,
    prefetch, cancelPrefetch,
    // 网页端构建号 / 给直接加载的图片加 `?v=`（原生包无构建号时原样返回）。
    webVersion, assetUrl: withVersion,
    // iOS / Android 16 回前台重解码 SVG 位图 + 强制图层重绘（main.js 的恢复钩子调用）。
    repaintRaster,
    // 换掉一个文本容器的内容（会真的按换行断行；`opts.wrap=true` 时按字段框宽自动折行）。返回是否认出来了。
    setText,

    fitTextWidth,

    // 在素材矩阵之后追加一个局部平移；用于原版左右卡片把同一个数字留在不同起始位的情况。
    nudge,

    // 按最终字号重算多行文本的首行基线与行距（缩字号后必须一起收，避免第二行压到下一个字段）。
    layoutText,

    estimateTextWidth,
    // 屏幕坐标 ↔ SVG 用户坐标（两轴分别换算；全面屏/`#ui` 非等比缩放也正确）。
    // 页面覆盖物（引导金环、三侠图集层）用它，避免 iOS 15 的 `getScreenCTM` 209220。
    svgScreenMap,
    BASE,
    // 素材库是否已就绪（页面里可以先探测再决定要不要走经典模式）
    tags: () => (bundle ? bundle.tags : null),
    timeline: () => (bundle ? bundle.timeline : null),

    liveCount: () => { let n = 0; for (const v of views) n += v.live.size; return n; },

    viewCount: () => views.size,

    setStaticPolicy: (view, spec) => (view && view.setStaticPolicy ? view.setStaticPolicy(spec) : null),

    debug: () => {
      const clips = [];
      for (const v of views) {
        for (const c of v.live) {
          clips.push({
            uid: c.uid, sid: String(c.tag.id), frame: c.frame, frames: c.frames.length,
            playing: c.playing, connected: c.g.isConnected,
          });
        }
      }
      return { tickCount, views: views.size, clips };
    },
  };
})();
