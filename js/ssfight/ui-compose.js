// ui-compose.js — 经典模式的道具合成（碎片 / 种子 / 宝石 / 转化丸）
(function () {
  'use strict';

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = () => (window.SfUiMain && SfUiMain.toolkit) || null;
  const C = () => (window.UI && UI.classic) || null;
  const clipOf = SfUiMain.toolkit.clipOf;
  const stopAt = (clip, frame) => {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(frame); } catch (e) {}
  };
  const GEAR_QUALITY_COLOR = ['#542201', '#65a844', '#2365c9', '#6544a8', '#ff9900', '#000000'];
  // 空闲回调：没有 requestIdleCallback（老 WebView）就退到 300 ms 后。
  const idle = (fn) => {
    try {
      if (typeof requestIdleCallback === 'function') { requestIdleCallback(fn, { timeout: 2500 }); return; }
    } catch (e) {}
    setTimeout(fn, 300);
  };
  // 4402「合成中」播到结果帧的时长；道具合成与装备融合共用同一段 CG。
  // ⚠ 它是总时长，不是"等一会儿就跳到结果帧"：以前这里直接 `gotoAndPlay(1)` +
  // 总时长不变、动画每一帧都会被看到、慢设备上也不会停在中途。
  const COMPOSE_CG_MS = 1400;

  const COMPOSE_RESULT_FRAME = 44;

  const cgStepMs = (frames) => Math.max(16, Math.round(COMPOSE_CG_MS / Math.max(1, frames - 1)));

  let session = null;

  // 不能缓存「已加载」：destroy() 会 releaseExtra('tags-compose.json')，下一轮再合成/看融合结果
  // 时如果直接 return true，4402/4886 已经不在素材库里，会报「合成界面出错」。
  function loadComposeExtra() {
    return Promise.resolve(SfRender.loadExtra('tags-compose.json')).then(() => true).catch(() => false);
  }

  function createHost() {
    return SfUiMain.toolkit.createSubviewHost('sf-compose-view', '道具合成');
  }

  function destroy() {
    const rec = session;
    session = null;
    if (!rec) return;
    if (rec.resultView) { try { rec.resultView.destroy(); } catch (e) {} }
    if (rec.pageView) { try { rec.pageView.destroy(); } catch (e) {} }
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
    if (window.SfRender && SfRender.releaseExtra) SfRender.releaseExtra('tags-compose.json');
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
  }


  function liveSession() {
    const rec = session;
    if (!rec) return null;
    if (rec.host && rec.host.isConnected) return rec;
    const stale = session;
    session = null;
    if (stale.resultView) { try { stale.resultView.destroy(); } catch (e) {} }
    if (stale.pageView) { try { stale.pageView.destroy(); } catch (e) {} }
    return null;
  }

  function close() {
    const rec = session;
    destroy();
    if (rec && typeof rec.onClose === 'function') { try { rec.onClose(); } catch (e) {} }
  }

  function setText(view, name, value) {
    const clip = clipOf(view, name);
    if (clip) SfRender.setText(clip, String(value == null ? '' : value));
  }

  function setTextColor(view, name, color) {
    const clip = clipOf(view, name);
    const g = clip && (clip.g || clip);
    if (!g || !g.querySelectorAll) return;
    for (const t of g.querySelectorAll('text')) t.setAttribute('fill', color);
  }


  function paintIcon(clip, src) { SfUiMain.toolkit.paintSvgIcon(clip, src, 'sf-compose-icon'); }

  function wireButton(clip, onFire, opts) {
    if (!clip || !clip.g) return;
    const o = opts || {};
    const idle = o.idle == null ? 1 : o.idle;
    const hover = o.hover == null ? 2 : o.hover;
    const press = o.press == null ? 1 : o.press;
    const t = T();
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    stopAt(clip, idle);
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
      stopAt(clip, press);
      onFire();
    });
  }

  function isComposeProp(id) {
    return [24, 25, 26, 45, 46, 77, 78].includes(id) || id === (window.GData && GData.CONVERT_SHARD_ID) || !!(window.State && State.gemLevel(id));
  }

  // 碎片合成在服务端只有「背包满 / 材料不足 / 金松果不足」会拒绝；进合成页前先拦掉，
  // 避免玩家点了「合成」才看到「无法合成」，也避免把可预期的前置检查当成合成失败。
  function composeBlockedReason(id) {
    if (![24, 25, 26, 77, 78].includes(id)) return '';
    if (!window.State || !State.state) return '';
    const s = State.state();
    if (!s || !Array.isArray(s.gears)) return '';
    if (s.gears.length >= State.gearCapacity()) return '装备已满（' + s.gears.length + '/' + State.gearCapacity() + '），先卖掉或融合几件';
    if ((s.props[id] || 0) < 10) return '碎片不足10个！';
    const quality = { 24: 0, 25: 1, 26: 2, 77: 5, 78: 5 }[id];
    const cost = State.gearCostOf ? State.gearCostOf(quality) : 50;
    if (s.goldPoint < cost) return '金松果不足' + cost + '！';
    return '';
  }

  function costText(id) {
    const lv = State.gemLevel(id);
    if (lv) {
      return '合成成功率:' + Math.round(State.gemMergeRate(lv) * 100) + '%\n合成费用:10金松果\n合成条件:\n3个同级宝石';
    }
    const base = propMap.getValue(id);
    const isFragment = [24, 25, 26, 77, 78].includes(id);
    const gold = isFragment ? (State.gearCostOf ? State.gearCostOf({ 24: 0, 25: 1, 26: 2, 77: 5, 78: 5 }[id]) : 50) : 50;
    return '每次合成消耗\n' + gold + '个金松果。\n合成条件:\n10个' + (base ? base.name : '材料');
  }

  function iconSrc(kind, id) {
    if (kind === 'gear') {
      const classic = window.UI && window.UI.classic;
      if (classic && typeof classic.gearIconSrc === 'function') return classic.gearIconSrc(id);
      return 'images/ui/icons/gear/gear-' + Number(id) + '-classic.svg?v=5';
    }
    // 道具：背包/商店同一张路径表（`UI.classic.propIconSrc`，全部是矢量图）。
    const classic = window.UI && window.UI.classic;
    if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(id);
    return 'images/ui/icons/prop/prop-' + Number(id) + '.svg';
  }

  function fillPage(view, id) {
    const base = propMap.getValue(id);
    if (!base) return;
    setText(view, 'name', base.name);
    setText(view, 'cost', costText(id));
    const c1 = clipOf(view, 'c1');
    stopAt(c1, 2);
    paintIcon(c1, iconSrc('prop', id));
  }

  // ⚠ 两颗按钮是不同元件（4878 合成 / 4419 取消），画稿原点也不一样，
  // 不能像使用窗那样只按 `__baseMa` 的 x 差平移（实测会叠在一起）。
  // （不用 getScreenCTM：iOS 15 会漏掉祖先 CSS transform 的 scale，WebKit 209220）。
  function swapComposeButtons(view) {
    const compose = clipOf(view, 'b_hc');
    const cancel = clipOf(view, 'b_back');
    if (!compose || !cancel || !compose.g || !cancel.g) return false;
    const cr = compose.g.getBoundingClientRect(), br = cancel.g.getBoundingClientRect();
    const cCenter = (cr.left + cr.right) / 2, bCenter = (br.left + br.right) / 2;
    const scaleOf = (clip) => {
      try {
        // 屏幕矩形 ÷ 本地包围盒 = 含所有祖先 CSS transform 的总比例。
        // iOS 15 的 getScreenCTM 漏掉祖先 scale（WebKit 209220），不能再拿 m.a 折回。
        const rr = clip.g.getBoundingClientRect();
        const bb = clip.g.getBBox();
        const s = bb && bb.width ? rr.width / bb.width : (bb && bb.height ? rr.height / bb.height : 0);
        return s > 1e-6 ? s : 1;
      } catch (e) { return 1; }
    };
    const dxC = (bCenter - cCenter) / scaleOf(compose);
    const dxB = (cCenter - bCenter) / scaleOf(cancel);
    if (compose.setExtraTransform) compose.setExtraTransform('translate(' + dxC.toFixed(3) + ',0)');
    if (cancel.setExtraTransform) cancel.setExtraTransform('translate(' + dxB.toFixed(3) + ',0)');
    return true;
  }

  function wirePage(view, rec) {
    wireButton(clipOf(view, 'b_hc'), () => {
      if (rec.busy) return;
      rec.busy = true;
      runCompose(rec).catch((e) => {
        if (window.__errs) window.__errs.push('compose: ' + (e && e.message));
        rec.busy = false;
        showFailure('合成界面出错，请稍后再试。');
      });
    }, { idle: 1, hover: 2, press: 1 });
    wireButton(clipOf(view, 'b_back'), close, { idle: 1, hover: 2, press: 1 });
  }

  // 联机版：合成含随机数（装备词条 / 宝石成败 / 转化丸产物），一律等服务端。
  async function composeAction(id) {
    if ([24, 25, 26, 77, 78].includes(id)) return StateCall('composeGear', id);
    if ([45, 46].includes(id)) return State.composeSeed(id);
    if (id === (window.GData && GData.CONVERT_SHARD_ID)) return StateCall('composeConvertPill');
    if (State.gemLevel(id)) return StateCall('mergeGems', id);
    return { ok: false, msg: '这个道具不能合成' };
  }

  // 道具说明这类长文案按固定字数硬折（原版服务端会断好行，这里自己断）。
  // ⚠ 装备结果不要走这里：基础属性带 `(+10%)` 后一折就断在括号中间，第二行会压到
  // 附加属性上（用户 2026-11 安卓实拍）；装备结果见 `layoutResultFields`。
  function wrapText(value, cols) {
    const s = String(value == null ? '' : value);
    const width = Math.max(4, cols || 11);
    const out = [];
    for (const para of s.split('\n')) {
      if (!para) { out.push(''); continue; }
      for (let i = 0; i < para.length; i += width) out.push(para.slice(i, i + width));
    }
    return out.join('\n');
  }

  function resultOf(r, id) {
    const kind = State.gemLevel(id) ? 'gem' : 'prop';
    if (r.gear) {
      const info = State.gearInst ? State.gearInst(r.gear.id, r.gear.ext, r.gear.attr) : null;
      const name = (window.UI && UI.classic && UI.classic.gearName)
        ? UI.classic.gearName(Number(r.gear.id)) : ((info && info.name) || '装备');
      const quality = State.gearQuality ? State.gearQuality(r.gear) : ((info && info.quality) || 0);
      const extra = (State.extText ? (State.extText(r.gear.ext) || []) : []).filter(Boolean);
      // 基础属性**不硬折**（`(+10%)` 会被劈成两行）；附加属性**每条一行**，
      // 不再用 " / " 串成一段再按 11 字硬折（那正是安卓截图里压字的两处来源）。
      // 字号与行距由 `layoutResultFields` 按实际行数统一收。
      const temp = info ? ('基本属性:' + State.gearAttrText(info, { name: true })) : '';
      const extraText = extra.length ? '附加属性:' + extra[0] + (extra.length > 1 ? '\n' + extra.slice(1).join('\n') : '') : '';
      return { name: name, temp: temp, extra: extraText, icon: 'gear', id: r.gear.id, gear: r.gear, quality: quality };
    }
    if (kind === 'gem') {
      const gid = id + 1;
      const def = propMap.getValue(gid);
      return { name: def ? def.name : '宝石', temp: '橙色装备可镶嵌宝石。\n宝石等级越高，功效越好！', extra: '', icon: 'prop', id: gid, quality: -1 };
    }
    if (r.propId) {
      const def = propMap.getValue(r.propId);
      return { name: (def && def.name) || r.name || '道具', temp: wrapText((def && def.remark) || ''), extra: '', icon: 'prop', id: r.propId, quality: -1 };
    }
    if (r.prop) {
      const def = propMap.getValue(r.prop);
      return { name: (def && def.name) || r.name || '道具', temp: wrapText((def && def.remark) || ''), extra: '', icon: 'prop', id: r.prop, quality: -1 };
    }
    return { name: '合成成功', temp: '', extra: '', icon: '', id: 0, quality: -1 };
  }

  // 结果页两段文本的排版（`t_temp` = 基础属性，`t_baseOther` = 附加属性）。
  // 用户 2026-11 安卓实拍：`t_temp` 把「基本属性:速度 11(+10%)」按 11 字硬折成两行，
  // 第二行 `+10%)` 正好压在 `t_baseOther` 第一行「附加属性:…」上；附加词条又被
  // " / " 拼成一段折成 5 行，末尾已经贴到「确定」。这里统一按“先内容、后字号”处理：
  //   · 基础属性保持**一行**；附加属性**每条一行**（由 `resultOf` 拼好）；
  //   · 字号先按两段里最宽的字段缩到框内，再按各自行数与框高收一档；
  //   · 最后用 `SfRender.layoutText` 按最终字号重算基线/行距，两段共用同一字号，
  //     这样第一条附加属性不会落回基础属性第二行的位置。
  function layoutResultFields(view, tempLines, extraLines) {
    const prep = (name, lines) => {
      const clip = clipOf(view, name);
      if (!clip || !clip.__textBox) return null;
      const b = clip.__textBox;
      const meta = b.meta || {};
      // 同一视图二次填充时，上一轮缩过的字号会留在 lines[0].h 里 —— 先回素材字号。
      b.lines[0].h = meta.fh || (b.lines[0] && b.lines[0].h) || 12;
      SfRender.setText(clip, lines.join('\n'));
      return clip;
    };
    const fields = [
      { clip: prep('t_temp', tempLines), lines: tempLines },
      { clip: prep('t_baseOther', extraLines), lines: extraLines },
    ].filter((f) => f.clip);
    if (!fields.length) return 0;
    let size = 12;
    for (const f of fields) {
      const b = f.clip.__textBox;
      const meta = b.meta || {};
      // 估算里的 ASCII 字宽按 0.56 会偏窄（实测 Chrome 的 `+30%` 约 0.6em）；
      // 再留 3% 余量，保证最后一位 `％` 不会探出框外。
      const boxW = meta.bd ? (meta.bd[1] - meta.bd[0]) : 0;
      const fitOpts = { ascii: 0.62, min: 8 };
      if (boxW > 0) fitOpts.width = boxW * 0.97;
      const fit = SfRender.fitTextWidth ? SfRender.fitTextWidth(f.clip, fitOpts) : 0;
      if (fit > 0) size = Math.min(size, fit);
      // 纵向：末行基线不能越过字段框底（框高 = 原版给这一列留的行数）。
      const H = meta.bd ? (meta.bd[3] - meta.bd[2]) : 0;
      if (H > 0 && f.lines.length > 1) {
        const lead = meta.lead || 0;
        const byHeight = (H - 2 - lead * f.lines.length) / (0.88 + 1.15 * (f.lines.length - 1));
        if (byHeight > 0) size = Math.min(size, byHeight);
      }
    }
    size = Math.max(8, Math.floor(size * 10) / 10);
    for (const f of fields) {
      if (SfRender.layoutText) SfRender.layoutText(f.clip, { size: size });
    }
    return size;
  }

  function paintResultIcon(view, result) {
    const c1 = clipOf(view, 'c1');
    if (!c1) return false;
    stopAt(c1, 2);
    let painted = false;
    if (result.icon === 'gear' && result.gear && window.SfStatus && SfStatus.paintGearCard) {
      painted = !!SfStatus.paintGearCard(c1, result.gear);
    }
    if (!painted && result.icon) paintIcon(c1, iconSrc(result.icon, result.id));
    return painted;
  }

  // 结果帧的原版画稿自带「痘痘拳套 / 两条基本属性 / 三颗叠放按钮」占位内容。
  // 必须先在隐藏状态切到结果帧、填完文本和按钮再显示；先显示会露出占位与重影。
  function fillResultPage(view, result) {
    const layer = view && view.g;
    const previous = layer && layer.style ? layer.style.visibility : '';
    if (layer && layer.style) layer.style.visibility = 'hidden';
    try {
      stopAt(view, COMPOSE_RESULT_FRAME);
      const c1 = clipOf(view, 'c1');
      stopAt(c1, 2);
      setText(view, 't_name', result.name);
      const tempLines = String(result.temp == null ? '' : result.temp).split(/\r\n|\r|\n/);
      const extraLines = String(result.extra == null ? '' : result.extra).split(/\r\n|\r|\n/);
      layoutResultFields(view, tempLines, extraLines);
      if (result.quality >= 0) setTextColor(view, 't_name', GEAR_QUALITY_COLOR[Math.max(0, Math.min(5, result.quality))]);

      paintResultIcon(view, result);
      for (const n of ['button2', 'button3']) {
        const b = clipOf(view, n);
        if (b && b.g) b.g.style.display = 'none';
      }
      const ok = clipOf(view, 'button1');
      if (ok && ok.g) ok.g.style.display = '';
      wireButton(ok, close, { idle: 2, hover: 2, press: 1 });
    } finally {
      if (layer && layer.style) layer.style.visibility = previous;
    }
  }

  // 装备卡配色是可选装饰；网络慢时不能挡住结果页，先画道具图标，表到了再补原版卡面。
  function preloadGearColors() {
    try {
      if (window.SfStatus && SfStatus.ensureGearColors) return Promise.resolve(SfStatus.ensureGearColors()).catch(() => {});
    } catch (e) {}
    return null;
  }
  function refreshGearIcon(rec, view, result, colors) {
    if (!colors) return;
    colors.then(async () => {
      if (session !== rec || rec.resultView !== view || !view.g || !view.g.isConnected) return;
      if (result.icon !== 'gear' || !result.gear) return;
      try {
        if (!paintResultIcon(view, result) && SfRender.loadExtra) {
          // 配色表缓存可能比 tags 包活得久：符号被释放时补拉一次再重画卡面。
          await SfRender.loadExtra('tags-gear-color.json');
          if (session === rec && rec.resultView === view && view.g && view.g.isConnected) {
            paintResultIcon(view, result);
          }
        }
      } catch (e) {}
    });
  }

  // 把 4402 的「合成中」按 COMPOSE_CG_MS 的总时长逐帧推到结果帧前一帧；
  // 结果帧由 `fillResultPage` 隐藏填充后再显示。中途关页 / 换页立刻停，不碰已销毁实例。
  async function playComposeCg(view, rec) {
    if (!view || !view.showFrame) return false;
    const total = Math.max(1, Math.min(COMPOSE_RESULT_FRAME, view.frames ? view.frames.length : COMPOSE_RESULT_FRAME));
    const step = cgStepMs(total);
    if (view.holdAnim) view.holdAnim(true);
    stopAt(view, 1);
    for (let f = 2; f <= total; f++) {
      await new Promise((r) => setTimeout(r, step));
      if (session !== rec || rec.resultView !== view || !view.g || !view.g.isConnected) return false;
      try { view.frame = f - 1; view.showFrame(); } catch (e) {}
    }
    if (session !== rec || rec.resultView !== view || !view.g || !view.g.isConnected) return false;
    // 结果帧（44）带原版占位文字和三颗叠放按钮，只由 `fillResultPage` 隐藏后切帧再显示；
    // 这里停在结果前一帧，慢网络 / 配色表未到也不能把占位页露出来。
    if (view.holdAnim) view.holdAnim(false);
    return true;
  }

  async function playResult(rec, result) {
    const host = rec.host;
    if (!host || !host.isConnected) return;
    if (rec.pageView && rec.pageView.g) rec.pageView.g.style.display = 'none';
    const view = await SfRender.mountSymbol(host, '4402', { frame: 1, label: '合成中' });
    if (session !== rec || !host.isConnected) { try { view.destroy(); } catch (e) {} return; }
    rec.resultView = view;
    const colors = result.icon === 'gear' ? preloadGearColors() : null;
    if (!(await playComposeCg(view, rec))) return;
    fillResultPage(view, result);
    refreshGearIcon(rec, view, result, colors);
  }

  async function playFailure(rec, msg) {
    const host = rec.host;
    if (host && host.isConnected) {
      if (rec.pageView && rec.pageView.g) rec.pageView.g.style.display = 'none';
      try {
        const view = await SfRender.mountSymbol(host, '4402', { frame: 1, label: '合成中' });
        if (session === rec && host.isConnected) {
          rec.resultView = view;
          try { view.gotoAndPlay(1); } catch (e) {}
          await new Promise((r) => setTimeout(r, 900));
        }
      } catch (e) {}
    }
    if (session === rec) { destroy(); showFailure(msg); }
  }

  function showFailure(msg, title) {
    const text = msg || '合成失败';
    const c = C();
    if (c && c.modal) {
      c.modal(title || '合成失败', '<div class="extra-result"><p>' + esc(text) + '</p></div>',
        [{ label: '知道了', cls: 'gold' }], { small: true });
      return;
    }
    if (window.UI && UI.toast) UI.toast(text);
  }

  async function runCompose(rec) {
    const r = await composeAction(rec.propId);
    if (!r || r.ok === false) {
      rec.busy = false;
      destroy();
      // 背包已满 / 材料或金松果不足 / 数据异常：不是本次随机失败，标题不能写「合成失败」。
      showFailure((r && r.msg) || '无法合成', r && r.ok === false ? '无法合成' : '合成失败');
      return;
    }
    if (r.success === false) {
      await playFailure(rec, r.msg || '合成失败');
      return;
    }
    const result = resultOf(r, rec.propId);
    try {
      await playResult(rec, result);
    } catch (e) {
      // 服务端已经扣材料并发出装备；这时只是结果页素材加载失败，不能报「合成失败」让玩家再合一次。
      if (window.__errs) window.__errs.push('compose result: ' + (e && e.message));
      destroy();
      showFailure('合成已完成：' + (result.name || '新装备') + '，但结果页加载失败，请回背包查看。', '合成完成');
    }
  }


  async function showGearResult(gear, opts) {
    if (!gear) return false;
    destroy();
    const host = createHost();
    if (!host) return false;
    const rec = { host: host, propId: 0, pageView: null, resultView: null, busy: true,
      onClose: opts && opts.onClose };
    session = rec;
    const playCg = !!(opts && opts.playCg);
    try {
      await SfRender.loadExtra('tags-status.json');
      const extra = await loadComposeExtra();
      if (!extra) throw new Error('tags-compose.json');
      if (session !== rec || !host.isConnected) return false;
      const view = await SfRender.mountSymbol(host, '4402', {
        frame: 1, label: playCg ? '合成中' : '融合结果',
      });
      if (session !== rec || !host.isConnected) { try { view.destroy(); } catch (e) {} return false; }
      rec.resultView = view;
      const colors = preloadGearColors();
      if (playCg) {
        // 与道具合成同一段逐帧 CG（见 `playComposeCg`）：总时长不变，但不会再停在半路。
        if (!(await playComposeCg(view, rec))) return false;
      }
      const result = resultOf({ gear: gear }, 0);
      fillResultPage(view, result);
      refreshGearIcon(rec, view, result, colors);
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
      return true;
    } catch (e) {
      if (window.__errs) window.__errs.push('compose gear result: ' + (e && e.message));
      destroy();
      showFailure('融合结果界面加载失败，请稍后再试。');
      return false;
    }
  }

  async function open(propId, opts) {
    const id = Number(propId);
    if (!propMap.getValue(id) || !isComposeProp(id)) return false;
    destroy();
    const blocked = composeBlockedReason(id);
    if (blocked) { showFailure(blocked, '无法合成'); return false; }
    const host = createHost();
    if (!host) return false;
    const rec = { host: host, propId: id, pageView: null, resultView: null, busy: false,
      onClose: opts && opts.onClose };
    session = rec;
    try {
      await SfRender.loadExtra('tags-status.json');
      const extra = await loadComposeExtra();
      if (!extra) throw new Error('tags-compose.json');
      if (session !== rec || !host.isConnected) return false;
      const view = await SfRender.mountSymbol(host, '4886', { frame: 5, label: '道具合成' });
      if (session !== rec || !host.isConnected) { try { view.destroy(); } catch (e) {} return false; }
      rec.pageView = view;
      fillPage(view, id);

      swapComposeButtons(view);
      wirePage(view, rec);

      if ([24, 25, 26, 77, 78].includes(id)) {
        idle(() => { try { if (window.SfStatus && SfStatus.ensureGearColors) SfStatus.ensureGearColors(); } catch (e) {} });
      }
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
      return true;
    } catch (e) {
      if (window.__errs) window.__errs.push('compose open: ' + (e && e.message));
      destroy();
      showFailure('合成界面加载失败，请稍后再试。');
      return false;
    }
  }

  window.SfCompose = Object.freeze({
    open: open,
    showGearResult: showGearResult,
    close: close,
    destroy: destroy,
    // 只有宿主还在页面上才算开着：宿主被整页重建清掉之后不能继续报告 active
    // （否则背包那边的入口会以为合成页还开着而不再开新的）。
    active: () => !!liveSession(),
    isComposeProp: isComposeProp,
  });
})();
