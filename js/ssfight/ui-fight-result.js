// Original Flash battle-dialog containers; callers retain all settlement rules.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SYMBOL = { arena: '3822', rank: '3776', stage: '4839', result: '4692', notice: '4692' };
  let current = null, generation = 0;
  const node = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const key in attrs || {}) n.setAttribute(key, attrs[key]);
    return n;
  };
  function plain(value) {
    return String(value == null ? '' : value).replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[k]));
  }
  const NO_LINE_START = /[，。！？；：、）》】”’…·]/;
  function lines(value, width) {
    const out = [];
    for (const paragraph of plain(value).split(/\r\n|\r|\n/)) {
      let row = '', used = 0;
      for (const ch of paragraph) {
        const size = ch.charCodeAt(0) < 128 ? .5 : 1;
        if (used + size > width && row) {
          // 行首禁则：标点跟着上一行走，宁可让这一行超半个字宽。
          if (NO_LINE_START.test(ch)) { row += ch; used += size; continue; }
          out.push(row); row = ''; used = 0;
        }
        row += ch; used += size;
      }
      if (row) out.push(row);
    }
    return out;
  }
  const FONT = 'SimHei,Microsoft YaHei,sans-serif';
  // 安卓 WebView 的 CJK 回退字体行框比桌面高约 1.45 倍（9px 字号的 getBBox 高 13），
  // 固定行距会让相邻行 / 下方按钮互相压住。按当前平台实测行框排基线；
  // 量不到时用 1.45em 的保守值，宁可多留一点缝。
  const cjkMetricsCache = new Map();
  function cjkMetrics(layer, size) {
    const key = Math.round(size * 10) / 10;
    const hit = cjkMetricsCache.get(key);
    if (hit) return hit;
    let metrics = { ascent: key * 1.16, height: key * 1.45 };
    const probe = node('text', { x: -9999, y: 0, 'font-family': FONT, 'font-size': key, fill: 'none' });
    probe.textContent = '国';
    layer.appendChild(probe);
    try {
      const box = probe.getBBox();
      if (box && box.height > 0 && box.y < 0) {
        metrics = { ascent: -box.y, height: box.height };
      }
    } catch (e) {}
    layer.removeChild(probe);
    cjkMetricsCache.set(key, metrics);
    return metrics;
  }
  function drawTextPage(layer, rows, opts) {
    const o = opts || {}, size = Number(o.size) || 10;
    const metrics = cjkMetrics(layer, size);
    const gap = Number.isFinite(Number(o.gap)) ? Number(o.gap) : 1;
    const step = metrics.height + gap;
    const used = rows.length ? rows.length * metrics.height + (rows.length - 1) * gap : 0;
    const room = Number.isFinite(Number(o.bottom)) ? Math.max(0, Number(o.bottom) - Number(o.top)) : 0;
    const start = o.valign === 'center' && room > used ? Number(o.top) + (room - used) / 2 : Number(o.top);
    rows.forEach((text, index) => {
      const n = node('text', {
        x: o.x, y: Math.round((start + metrics.ascent + index * step) * 100) / 100,
        'text-anchor': o.anchor || 'start', 'font-family': FONT, 'font-size': size, fill: o.fill || '#683b1a',
      });
      n.textContent = text;
      layer.appendChild(n);
    });
    return { step, metrics };
  }

  function hasReward(options) {
    const exp = Math.round(Number(options.exp) || 0);
    const gold = Math.round(Number(options.gold) || 0);
    return options.recruit === true || exp > 0 || gold > 0 ||
      !!(options.items && options.items.length) || !!(options.ups && options.ups.length);
  }

  function upsLines(ups) {
    return (ups || []).filter(Boolean).map((u) => {
      let text = '升到 ' + u.level + ' 级';
      if (u.reward) text += '，获得「' + u.reward + '」';
      if (u.wsChoice) text += '，武器/技能三选一';
      if (u.attributeBook) text += '，属性书 ×1';
      if (u.chest) text += '，金宝箱 ×' + u.chest;
      const gifts = (u.gifts || []).map((g) => g.name + '×' + g.count).join('、');
      if (gifts) text += '，' + gifts;
      if (u.autoPoint) text += '，系统分配了 1 点属性';
      return text;
    });
  }
  function rewardText(options) {
    const note = plain(options.note != null ? options.note : options.text);

    const upgrade = hasLevelUp(options) ? [] : upsLines(options.ups);
    return [note].concat(upgrade).filter((s) => String(s || '').trim()).join('\n');
  }
  function hasLevelUp(options) {
    // 有 `ups` 就会有升级奖励 UI（原版 7795 或兜底奖励卡），战果文字不再重复列升级行。
    return !!(options && options.ups && options.ups.length);
  }
  function promptLevelUpChoices() {
    if (window.UI && UI.classic && UI.classic.promptLevelUpChoices) UI.classic.promptLevelUpChoices();
  }

  function showLevelUp(options) {
    // 新手引导：等级事件（4/5/10/15/20/25/30/35 → nowPage 21/13/23/24/17/19/20/26，
    // 所以先通知再挂页（引导自己是异步挂的，加上重试能等到这个页）。
    if (window.SfGuide && SfGuide.onLevelup) { try { SfGuide.onLevelup(options && options.ups); } catch (e) {} }
    const ups = (options && options.ups) || [];
    if (!ups.length) { promptLevelUpChoices(); return false; }
    const done = () => {
      promptLevelUpChoices();
      if (window.SfGuide && SfGuide.onLevelupDone) { try { SfGuide.onLevelupDone(ups); } catch (e) {} }
    };
    try {
      // 统一走 `UI.classic.showLevelUps`：原版 7795 挂不出来时会退回升级奖励卡弹窗。
      if (window.UI && UI.classic && UI.classic.showLevelUps) {
        UI.classic.showLevelUps(ups, done);
        return true;
      }
      if (!hasLevelUp(options)) { promptLevelUpChoices(); return false; }
      SfLevelUp.open(ups, done);
      return true;
    } catch (e) {
      if (window.__errs) window.__errs.push('SfFightResult levelup: ' + (e && (e.stack || e.message) || e));
      promptLevelUpChoices();
      return false;
    }
  }
  let lootIcons = null;
  async function loadLootIcons() {
    if (lootIcons) return lootIcons;
    try { lootIcons = ((await SfRender.loadTable('loot-icons.json')) || {}).byId || {}; }
    catch (e) { lootIcons = {}; }
    return lootIcons;
  }

  function autoCloseMs(options) {
    const ms = Number(options && options.autoClose);
    return ms > 0 ? ms : 0;
  }

  function actionList(options) {
    if (options && options.actions && options.actions.length) return options.actions;
    return autoCloseMs(options) ? [] : [{ label: '确定', dismiss: true }];
  }
  function armAutoClose(record, options) {
    const ms = autoCloseMs(options);
    if (!ms) return;
    record.autoTimer = setTimeout(() => {
      record.autoTimer = 0;
      if (current !== record || record.settled || !record.host.isConnected) return;
      record.settled = true;
      destroy();
      if (typeof options.onAutoClose === 'function') {
        try { options.onAutoClose(); } catch (e) {
          if (window.__errs) window.__errs.push('SfFightResult autoClose: ' + (e && (e.stack || e.message) || e));
        }
      }
    }, ms);
  }
  // 提交一次动作；旧层迟到的回调由 `current` + `host` 双重校验挡住。
  function commit(record, host, actions, index) {
    if (!record || record.settled || current !== record || !host.isConnected) return false;
    if (!Number.isInteger(index) || !actions[index] || actions[index].disabled === true) return false;
    record.settled = true;
    const action = actions[index]; destroy();
    if (action && typeof action.run === 'function') action.run();
    return true;
  }
  function actionRank(action) {
    const label = String(action.label || ''), cls = String(action.cls || '').toLowerCase();
    if (action.muted === true || cls.includes('muted') || /返回|取消|关闭|放弃/.test(label)) return -2;
    if (/稍后|暂不|待会|结束/.test(label)) return -1;
    if (/开始|继续|确定|确认|闯关|挑战|再战|知道了/.test(label) || action.primary === true) return 2;
    return 0;
  }

  function makeButton(view, offset, record, host, label, centerX, centerY, run, name, disabled, width) {
    const clip = view.attachChild('3801', 1, name);
    const measured = clip.g.getBBox();
    const box = measured.width > 30 && measured.height > 5 ? measured : { x: 0, y: -.02, width: 67.3, height: 19.9 };
    const midX = box.x + box.width / 2, midY = box.y + box.height / 2;
    const scale = Math.min(1, (width || 76) / box.width);
    clip.setExtraTransform('translate(' + (centerX + offset[0] - midX * scale) + ',' +
      (centerY + offset[1] - midY * scale) + ') scale(' + scale + ')');
    const text = node('text', { x: midX, y: midY + 3.5, 'text-anchor': 'middle', 'font-family': 'SimHei,Microsoft YaHei,sans-serif', 'font-size': 10, fill: '#53341e', 'pointer-events': 'none' });
    text.textContent = label; clip.g.appendChild(text);
    clip.g.setAttribute('role', 'button'); clip.g.setAttribute('tabindex', disabled ? '-1' : '0'); clip.g.setAttribute('aria-label', label);
    if (disabled) { clip.g.setAttribute('aria-disabled', 'true'); clip.g.style.opacity = '.45'; }
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (t) t.popWrap(clip);
    if (window.SfUiFeedback && !disabled) SfUiFeedback.bind(clip.g, { shell: () => clip.getContentHost() });
    const fire = event => {
      if (event && event.stopPropagation) event.stopPropagation();
      if (record.settled || !host.isConnected || disabled) return;
      if (window.SfUiFeedback) SfUiFeedback.tap(clip.g, run, { delay: 0, press: false }); else run();
    };
    clip.g.addEventListener('click', fire);
    clip.g.addEventListener('keydown', e => { if (!e.repeat && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fire(e); } });
    return clip;
  }

  async function openReward(options, host, record, mine) {
    if (!window.SfRender || !SfRender.mountSymbol) return null;
    try {
      await SfRender.loadExtra('tags-fight-core.json');
      await SfRender.loadExtra('tags-fight-result.json');
    } catch (e) { return null; }
    if (mine !== generation || !host.isConnected) return null;
    let view;
    try {
      view = await SfRender.mountSymbol(host, '7772', {
        frame: options.win === false ? 3 : 2, label: options.title || '战斗结果', policy: {},
      });
    } catch (e) { return null; }
    if (mine !== generation || !host.isConnected) { view.destroy(); return null; }
    record.view = view;

    if (host.style) host.style.background = '#000';
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (t && t.freezeDescendants) t.freezeDescendants(view);
    const stop = (clip, n) => { if (clip && clip.gotoAndStop) { try { clip.gotoAndStop(n); } catch (e) {} } };
    const show = (clip, on) => { const g = clip && (clip.g || clip); if (g && g.style) g.style.display = on ? '' : 'none'; };
    stop(view.byName('backgd'), 1);
    stop(view.byName('maxlevel'), 4);

    stop(view.byName('shoutu'), options.recruit === true ? 1 : 3);
    const exp = Math.max(0, Math.round(Number(options.exp) || 0));
    let gold = Math.max(0, Math.round(Number(options.gold) || 0));
    const getExp = view.byName('getExp');
    if (getExp) {
      if (exp > 0) {
        stop(getExp, 1);
        const digits = getExp.byName && getExp.byName('exp');
        if (t && digits) t.showNumber(exp, digits, 0, 0, 0);
      } else stop(getExp, 3);
    }
    const icons = (await loadLootIcons()) || {};
    if (mine !== generation || !host.isConnected) { view.destroy(); return null; }
    const picks = [];
    for (const item of (options.items || [])) {
      if (!item || item.id == null) continue;
      const count = Math.max(1, Math.round(Number(item.count) || 1));
      // 战斗中飘到的金松果和结算金松果是两笔（`BattleDrops` 当场 `addGold`），
      // 合在同一格里显示总数，不能因为已经有一格金松果就把飘到的这份吞掉。
      if (Number(item.id) === 8) { gold += count; continue; }
      const hit = icons[String(item.id)];
      if (!hit || !hit.id) continue;
      picks.push({ count, icon: hit.id });
    }
    const rewards = [];
    if (gold > 0) rewards.push({ count: gold, icon: (icons['8'] || {}).id || '3131' });
    rewards.push(...picks);
    const cells = [['c1', 'num'], ['c2', 'num1'], ['c3', 'num3']];
    // 胜负两帧的格子数不一样：负场（frame 3）没有 `c2/num1`，只有 `c1` + `c3`。
    // 按当前帧真的存在的格子依次摆，不能因为缺一格就把后面的奖励丢掉。
    const slots = cells.map(([cellName, numName]) => ({ cell: view.byName(cellName), num: view.byName(numName) }))
      .filter((slot) => slot.cell);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i], reward = rewards[i];
      if (slot.cell) stop(slot.cell, reward ? 1 : 2);
      if (slot.num) show(slot.num, !!reward);
      if (!reward) continue;
      const digits = slot.num && slot.num.byName && slot.num.byName('num');
      const sign = slot.num && slot.num.byName && slot.num.byName('addOrReduce');
      if (sign) stop(sign, 2);
      if (t && digits) t.showNumber(reward.count, digits, 0, 0, 0);
      if (slot.cell && slot.cell.detachAll) slot.cell.detachAll();
      if (slot.cell && slot.cell.attachChild) slot.cell.attachChild(reward.icon, 1, 'prize');
    }
    const prize = view.byName('prizeBackg');
    if (prize) stop(prize, rewards.length ? 1 : 2);


    const text = rewardText(options);
    const rows = text ? lines(text, 30) : [];
    const perPage = 2;
    let page = 0;
    if (rows.length) {
      const footer = node('g');
      footer.appendChild(node('rect', { x: 14, y: 149.5, width: 292, height: 23, rx: 6,
        fill: '#fcf4e0', stroke: '#8b5a2b', 'stroke-width': 1.2, opacity: '.96', 'pointer-events': 'none' }));
      const textLayer = node('g', { 'pointer-events': 'none' });
      footer.appendChild(textLayer);
      view.g.appendChild(footer);
      const paint = () => {
        while (textLayer.firstChild) textLayer.removeChild(textLayer.firstChild);
        const slice = rows.slice(page * perPage, (page + 1) * perPage);
        drawTextPage(textLayer, slice, { x: 160, top: 150.5, bottom: 171.5, valign: 'center',
          size: 7, anchor: 'middle', fill: '#8b3a1a', gap: .8 });
      };
      if (rows.length > perPage) {
        const more = node('text', { x: 302, y: 169, 'text-anchor': 'end', 'font-family': FONT,
          'font-size': 7.5, fill: '#74552d', role: 'button', tabindex: '0', 'pointer-events': 'auto' });
        more.textContent = '更多 ›';
        const next = event => {
          if (event && event.stopPropagation) event.stopPropagation();
          page = (page + 1) % Math.ceil(rows.length / perPage); paint();
        };
        more.addEventListener('click', next);
        more.addEventListener('keydown', event => { if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); next(event); } });
        footer.appendChild(more);
      }
      paint();
      record.repaint = paint;
    }

    const actions = actionList(options);
    record.actions = actions;
    record.choose = index => commit(record, host, actions, index);
    const ordered = actions.map((action, index) => ({ action, index }))
      .sort((a, b) => actionRank(a.action) - actionRank(b.action) || a.index - b.index);
    const count = ordered.length;
    const step = count <= 1 ? 0 : count === 2 ? 160 : count === 3 ? 80 : 66.5;
    const width = count <= 2 ? 76 : 60;
    const actionY = rows.length ? 183 : 173;
    ordered.forEach(({ action, index }, position) => makeButton(view, [0, 0], record, host,
      action.label || '确定', 160 + (position - (count - 1) / 2) * step, actionY,
      () => record.choose(index), 'result-action-' + index, action.disabled === true, width));
    host.style.visibility = '';
    if (window.Main && Main.resizeLayout) Main.resizeLayout();
    // 同 3822：缩放落定后重画一次，避免 WebView 把 SVG 文本留在旧缩放布局里。
    if (record.repaint) record.repaint();
    showLevelUp(options);
    return { view, host, choose: record.choose, close: () => { if (current === record) destroy(); } };
  }
  function destroy() {
    generation++;
    const old = current; current = null;
    if (!old) return;
    if (old.autoTimer) { clearTimeout(old.autoTimer); old.autoTimer = 0; }
    if (old.view) old.view.destroy();
    if (old.host.parentNode) old.host.parentNode.removeChild(old.host);
    if (window.SfRender && SfRender.releaseExtra) {
      SfRender.queueExtraRelease('tags-fight-result.json', 800);
      // 低内存设备在战果关闭后回收 8.9 MB 的战斗包；下一场会按需重载。
      const nav = typeof navigator !== 'undefined' ? navigator : {};
      const lowMem = /Android/i.test(nav.userAgent || '') ||
        (Number(nav.deviceMemory) > 0 && Number(nav.deviceMemory) <= 4);
      if (lowMem && (!window.SfFight || !SfFight.active())) SfRender.queueExtraRelease('tags-fight-core.json', 2000);
    }
  }
  function dismiss() {
    const record = current;
    if (!record || !record.choose) return false;
    const index = record.actions.findIndex(action => action && action.disabled !== true &&
      (action.dismiss === true || /返回|稍后|取消|关闭/.test(String(action.label || ''))));
    return index >= 0 ? record.choose(index) : false;
  }
  async function open(spec) {
    const options = spec || {};
    destroy();
    const mine = generation, ui = document.getElementById('ui');
    if (!ui) return null;
    const host = document.createElement('section');
    host.className = 'sf-fight-result ssfight-view';
    host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', options.title || '战斗结果');
    host.style.visibility = 'hidden'; ui.appendChild(host);
    const record = { host, view: null, settled: false, repaint: null, options }; current = record;
    try {
      const kind = SYMBOL[options.kind] ? options.kind : 'result';
      // 有奖励的普通战果 = 原版 `fight` 战果页（经验 + 金松果 / 战利品三格）；
      // 关卡 / 竞技场 / 天梯有各自的续战容器（4839 / 3822 / 3776），不能抢走。
      if (kind === 'result' && hasReward(options)) {
        const reward = await openReward(options, host, record, mine);
        if (reward) { armAutoClose(record, options); return reward; }
        if (mine !== generation || !host.isConnected) return null;
        while (host.firstChild) host.removeChild(host.firstChild);
        if (host.style) host.style.background = '';
      }
      await SfRender.loadExtra('tags-fight-result.json');
      if (mine !== generation || !host.isConnected) return null;
      const offset = kind === 'stage' ? [-157.4, 43.9] : [0, 0];
      const view = await SfRender.mountSymbol(host, SYMBOL[kind], {
        frame: kind === 'stage' ? 7 : 1, label: options.title || '战斗结果', policy: {},
        viewBox: kind === 'stage' ? '-157.4 43.9 320 196' : '0 0 320 196',
      });
      if (mine !== generation || !host.isConnected) { view.destroy(); return null; }
      record.view = view;
      const set = (name, value) => { const c = view.byName(name); if (c) SfRender.setText(c, String(value == null ? '' : value)); };
      const hide = name => { const c = view.byName(name); if (c && (c.g || c).style) (c.g || c).style.display = 'none'; };
      // 3822 的胜负标题自带「进入下一轮争夺冠/亚军」副标题；决赛、季军赛没有下一轮，
      // 由调用方传 `arenaSubtitle` 盖掉（3779 / 3781 是那条逐字文本字段）。
      const arenaSubtitle = kind === 'arena' ? String(options.arenaSubtitle || '').trim() : '';
      // 只有最终名次结算（冠军/亚军/季军/第四名）用新页脚条；半决赛→决赛这层
      // 没有 subtitle，保持旧版左对齐正文和旧按钮位置。
      const arenaSettlement = kind === 'arena' && options.neutral !== true && !!arenaSubtitle;
      if (kind === 'arena') {
        const title = view.byName('title');
        if (title) {
          if (options.neutral === true) title.g.style.display = 'none';
          else title.gotoAndStop(options.win ? 1 : 2);
          if (arenaSubtitle && title.nodes) {
            for (const rec of title.nodes.values()) {
              if ((String(rec.id) === '3779' || String(rec.id) === '3781') && rec.node && rec.node.style) rec.node.style.display = 'none';
            }
          }
        }
        // 原版 3822 自带的提示行 / 返回键 / 按钮位都在卡片和正文区，和自绘战果文字抢同一块地方。
        hide('info'); hide('info1'); hide('back');
        hide('button1'); hide('button2'); hide('button3'); hide('buttonsMc');
        const player = options.player || {}, foe = options.foe || {};
        set('name1', player.name || '我'); set('level1', player.level || '');
        set('name2', foe.name || ''); set('level2', foe.level || '');
        // 3822 左右卡片的「LV:」画稿与数字字段间距相差 2 单位：左侧留 1.8、右侧 -0.2。
        // 把两侧都补到约 0.8，两个等级数字才不会一边贴着冒号、一边空一截；同时数字基线
        // 比画稿基线低约 2.8 单位，上提 2.5（局部坐标）让 LV: 和数字落在同一条基线上。
        for (const [field, dx] of [['level1', -1], ['level2', 1]]) {
          const target = view.byName(field);
          if (target && SfRender.nudge) SfRender.nudge(target, dx, -2.5);
        }

        for (const field of ['name1', 'name2']) {
          const target = view.byName(field);
          if (target && window.SfRender && SfRender.fitTextWidth) SfRender.fitTextWidth(target, { ascii: 0.5, min: 6 });
        }
        for (const rec of view.nodes.values()) {
          if (String(rec.id) === '3152') rec.node.style.display = 'none';
          if (String(rec.id) === '3784') for (const path of [...rec.node.childNodes].slice(0, 3)) path.style.display = 'none';
        }
      } else {
        hide('info'); hide('button1'); hide('buttonsMc');
        const win = view.byName('winmc'); if (win) win.gotoAndStop(options.win ? 2 : 1);
      }
      const layer = node('g', { transform: 'translate(' + offset.join(',') + ')' }); view.g.appendChild(layer);
      if (kind === 'arena' && arenaSubtitle && options.neutral !== true) {
        const sub = node('text', { x: 160, y: 64, 'text-anchor': 'middle', 'font-family': 'SimHei,Microsoft YaHei,sans-serif', 'font-size': 12, fill: '#663b19' });
        sub.textContent = arenaSubtitle;
        layer.appendChild(sub);
      }
      if (kind === 'arena' && options.neutral === true) {
        const title = node('text', { x: 160, y: 50, 'text-anchor': 'middle', 'font-family': 'SimHei,Microsoft YaHei,sans-serif', 'font-size': 14, fill: '#683b1a' });
        title.textContent = '竞技场 · ' + (options.title || '赛事对阵'); layer.appendChild(title);
      }
      if (kind === 'stage') {
        const title = node('text', { x: 160, y: 34, 'text-anchor': 'middle', 'font-family': 'SimHei,Microsoft YaHei,sans-serif', 'font-size': 12, fill: '#683b1a' });
        title.textContent = options.title || (options.win ? '战斗胜利' : '再接再厉'); layer.appendChild(title);
      }
      if (kind === 'result') {
        const outcome = node('text', { x: 160, y: 61, 'text-anchor': 'middle',
          'font-family': 'SimHei,Microsoft YaHei,sans-serif', 'font-size': 12, 'font-weight': 'bold', fill: '#683b1a' });
        outcome.textContent = options.win === true ? '战斗胜利' : options.win === false ? '再接再厉' : options.title || '战斗结果';
        layer.appendChild(outcome);
      }
      const body = node('g'); layer.appendChild(body);
      const layout = {
        // 3822 的卡片下沿约 y=130、原版返回键 y=157：最终结算的正文放 124–152 的横条，
        // 操作按钮下移到 163；半决赛/季军赛过渡仍用旧版的 y=130 / 10 行距 / 154 按钮位。
        arena: arenaSettlement
          ? { x: 160, top: 125.5, width: 23, size: 8.5, rows: 2, actionY: 163, pageY: 160, bottom: 151.5, anchor: 'middle' }
          : { x: 48, y: 130, width: 21, size: 9, leading: 10, rows: 2, actionY: 154, pageY: 139, legacy: true },
        rank: { x: 68, top: 58.5, width: 18, size: 9.5, rows: 5, actionY: 143, pageY: 131, bottom: 133 },

        stage: { x: 72, top: 50.5, width: 18, size: 9.5, rows: 5, actionY: 140, pageY: 128.5, bottom: 129 },
        result: { x: 66, top: 68.5, width: 17, size: 10, rows: 5, actionY: 164, pageY: 150, bottom: 147 },

        notice: { x: 66, top: 56.5, width: 17, size: 10, rows: 5, actionY: 164, pageY: 150, bottom: 147 },
      }[kind];
      let rows = lines(options.text, layout.width), perPage = layout.rows;
      // 有下一页时给「更多 ›」腾一行：rank/stage 的原版面板窄，按钮又靠下，
      // 多一行就会和链接/按钮叠在一起，宁可少排一行分两页。按平台实测行高决定能放几行。
      if (rows.length > perPage && (kind === 'rank' || kind === 'stage')) {
        const metrics = cjkMetrics(body, layout.size);
        const fit = Math.floor((layout.pageY - 9 - layout.top - metrics.height) / (metrics.height + 1)) + 1;
        perPage = Math.max(2, Math.min(perPage, fit));
      }
      let page = 0;
      if (kind === 'arena' && arenaSettlement && rows.length) {
        const panel = node('rect', { x: 34, y: 124, width: 252, height: 28, rx: 6,
          fill: '#fcf4e0', stroke: '#8b5a2b', 'stroke-width': 1.1, opacity: '.95', 'pointer-events': 'none' });
        layer.insertBefore(panel, body);
      }
      const paint = () => {
        while (body.firstChild) body.removeChild(body.firstChild);
        const slice = rows.slice(page * perPage, (page + 1) * perPage);
        if (layout.legacy) {
          slice.forEach((text, index) => {
            const n = node('text', { x: layout.x, y: layout.y + index * layout.leading,
              'font-family': FONT, 'font-size': layout.size, fill: '#683b1a' });
            n.textContent = text; body.appendChild(n);
          });
          return;
        }
        drawTextPage(body, slice, {
          x: layout.x, top: layout.top, bottom: layout.bottom, valign: arenaSettlement ? 'center' : 'top',
          size: layout.size, anchor: layout.anchor,
          fill: arenaSettlement ? '#6b3a12' : '#683b1a', gap: 1,
        });
      };
      const actions = actionList(options);
      record.actions = actions;
      record.choose = index => commit(record, host, actions, index);
      const ordered = actions.map((action, index) => ({ action, index }))
        .sort((a, b) => actionRank(a.action) - actionRank(b.action) || a.index - b.index);
      const step = ordered.length > 2 ? 66.5 : 90;

      const actionCX = (kind === 'stage' || kind === 'rank') ? 158 : 160;
      ordered.forEach(({ action, index }, position) => makeButton(view, offset, record, host,
        action.label || '确定',
        actionCX + (position - (ordered.length - 1) / 2) * step, layout.actionY,
        () => commit(record, host, actions, index), 'result-action-' + index,
        action.disabled === true, ordered.length > 2 ? 60 : 76));
      if (rows.length > perPage) {
        const tight = kind === 'result' || kind === 'notice';
        const moreX = layout.legacy ? 270 : kind === 'arena' ? 296 : kind === 'rank' ? 252 : kind === 'stage' ? 251 : 258;
        const more = node('text', { x: moreX, y: layout.pageY, 'text-anchor': 'end',
          'font-family': FONT, 'font-size': layout.legacy ? 8 : tight || kind === 'arena' ? 7.5 : 8, fill: '#74552d', role: 'button', tabindex: '0' });
        more.textContent = tight ? '更多›' : '更多 ›';
        const next = event => {
          if (event && event.stopPropagation) event.stopPropagation();
          page = (page + 1) % Math.ceil(rows.length / perPage); paint();
        };
        more.addEventListener('click', next);
        more.addEventListener('keydown', event => { if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); next(event); } });
        layer.appendChild(more);
      }
      paint();
      host.style.visibility = '';
      if (window.Main && Main.resizeLayout) Main.resizeLayout();
      // #ui 的缩放刚变过：安卓 WebView 会把已生成的 SVG 文本留在旧布局里。
      // 缩放落定后重画一次正文，保证字号/换行按最终尺寸排版。
      paint();
      showLevelUp(options);
      armAutoClose(record, options);
      return { view, host, choose: record.choose, close: () => { if (current === record) destroy(); } };
    } catch (error) {
      if (current === record) destroy();
      throw error;
    }
  }
  window.SfFightResult = Object.freeze({ open, destroy, dismiss, plain, isOpen: () => !!(current && current.host.isConnected) });
})();
