// Three-material equipment fusion in the classic UC visual shell.

(function () {
  'use strict';
  const PAGE_SIZE = 6;
  const qualities = ['普通', '优秀', '杰出', '卓越', '传说', '黑色'];

  const modernMode = () => !(UI.currentUiMode && UI.currentUiMode() === 'classic');
  const cannotMerge = (gear) => !!gear && (gear.quality > 5 || (modernMode() && gear.quality === 4));
  // 融合费用走 `State.fusionCostOf`：联机 30/40/50/100/200/200；单机按材料品质（白 30 / 绿 40 / 蓝 50 / 紫 60 / 橙 200 / 黑 1000）。
  // ⚠ 页面不要再用 `State.gearCostOf` 拼融合价格 —— 那只是碎片合成价，联机紫装会显示 60、实扣 100。
  const costOf = (gear) => (gear ? State.fusionCostOf(gear.quality) : 0);
  // 规则弹窗里的费用说明：按品质逐档列出；万一将来全同价就写「固定 N」。
  function fusionCostLine() {
    const costs = [0, 1, 2, 3, 4, 5].map((q) => State.fusionCostOf(q));
    return costs.every((c) => c === costs[0])
      ? '固定 ' + costs[0] + ' 金松果。'
      : '白 ' + costs[0] + ' · 绿 ' + costs[1] + ' · 蓝 ' + costs[2] + ' · 紫 ' + costs[3] +
        ' · 橙 ' + costs[4] + ' · 黑 ' + costs[5] + ' 金松果（按材料品质）。';
  }
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const art = (gear) => '<img alt="" src="images/ui/icons/gear/gear-' + Number(gear.id) +
    '.png' + ([205, 206, 207, 208].includes(Number(gear.id)) ? '?v=3' : '') + '" onerror="this.style.visibility=\'hidden\'">';


  function open() {
    const classic = UI.classic;
    if (!classic) return;
    let selected = [], pageIndex = 0, busy = false;
    const page = classic.page('status', 'status', '', {
      cls: 'fusion-board',
      left: '<span class="footer-left">' + classic.btn('我的装备', 'gears', 'small gold') + '</span>'
    });
    const board = page.querySelector('.fusion-board');
    page.setAttribute('aria-label', '装备融合');

    const PART_NAME = ['头巾', '手套', '衣服', '鞋子'];
    const partOf = (gear) => (gear ? State.gearPart(gear.id) : -1);
    const partLabel = (gear) => PART_NAME[partOf(gear)] || '装备';

    const extTags = (gear, compact) => {
      const list = gear ? State.extText(gear.ext) : [];
      return '<div class="fusion-ext-line' + (compact ? ' compact' : '') + '">' +
        (list.length ? list.map((x) => '<span class="fusion-ext-tag">' + esc(x) + '</span>').join('')
          : '<span class="fusion-ext-none">无词条</span>') + '</div>';
    };
    function validation(gears) {
      if (selected.length !== 3) return '请选择 3 件同品质的未穿戴装备';
      if (new Set(selected).size !== 3) return '同一件装备只能放入一次';
      const materials = selected.map((key) => gears.find((gear) => gear.key === key));
      if (materials.some((gear) => !gear)) return '材料已发生变化，请重新选择';
      if (materials.some((gear) => gear.used)) return '已穿戴的装备不能作为融合材料';
      if (materials.some(cannotMerge)) return modernMode() ? '现代界面已删除黑装，橙装不能再融合' : '该装备不能作为融合材料';
      if (materials.some((gear) => gear.quality !== materials[0].quality)) return '需要 3 件同品质的装备';
      const cost = State.fusionCostOf(materials[0].quality);
      if (State.state().goldPoint < cost) return '金松果不足，还需要 ' + (cost - State.state().goldPoint) + ' 个';
      return '';
    }


    function render(focus) {
      if (!page.isConnected) return;
      const gears = State.myGears();
      selected = selected.filter((key) => gears.some((gear) => gear.key === key && !gear.used && !cannotMerge(gear)));
      const first = gears.find((gear) => gear.key === selected[0]);
      const groups = Object.create(null);
      gears.forEach((gear) => {
        if (gear.used || cannotMerge(gear)) return;
        const key = String(gear.quality);
        groups[key] = (groups[key] || 0) + 1;
      });
      const groupKey = (gear) => String(gear.quality);
      const unusable = (gear) => gear.used || cannotMerge(gear);
      const inventory = gears.slice().sort((a, b) =>
        Number(unusable(a)) - Number(unusable(b)) ||
        (groups[groupKey(b)] || 0) - (groups[groupKey(a)] || 0) ||
        b.quality - a.quality ||
        State.gearPart(a.id) - State.gearPart(b.id) ||
        a.id - b.id || String(a.key).localeCompare(String(b.key)));
      const pages = Math.max(1, Math.ceil(inventory.length / PAGE_SIZE));
      pageIndex = Math.max(0, Math.min(pageIndex, pages - 1));
      const reason = validation(gears);
      const materials = [0, 1, 2].map((index) => {
        const gear = gears.find((item) => item.key === selected[index]);
        return (index ? '<span class="fusion-plus" aria-hidden="true">+</span>' : '') +
          '<button type="button" class="fusion-material ' + (gear ? 'filled q' + gear.quality : 'empty') +
          '" data-fusion-slot="' + index + '" aria-label="' + esc(gear ? '移除材料 ' + (index + 1) + '：' + gear.name : '材料 ' + (index + 1) + '，请在下方选择装备') + '"' + (gear ? '' : ' disabled') + '>' +
          '<span class="fusion-frame">' + (gear ? art(gear) + '<span class="fusion-remove" aria-hidden="true">×</span>' : '<span class="fusion-add" aria-hidden="true">+</span>') +
          '<span class="fusion-slot-number" aria-hidden="true">' + (index + 1) + '</span></span>' +
          '<span class="fusion-material-name">' + (gear ? esc(gear.name) : '放入装备') + '</span>' +
          (gear ? extTags(gear, true) : '') + '</button>';
      }).join('');
      const cards = inventory.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map((gear) => {
        const chosen = selected.includes(gear.key);
        const unavailable = gear.used ? '已穿戴' : cannotMerge(gear) ? '最高品质'
          : first && gear.quality !== first.quality ? '需同品质'
          : selected.length === 3 && !chosen ? '材料已放满' : '';
        const sameGroup = groups[groupKey(gear)] || 0;
        const caption = chosen ? '材料 ' + (selected.indexOf(gear.key) + 1)
          : unavailable || (sameGroup >= 3 ? '同品质 ' + sameGroup + ' 件' : '可放入');
        const effects = State.extText(gear.ext).join('，');
        const detail = gear.name + '，' + qualities[gear.quality] + '，' + gear.attrName + ' +' + gear.abilityVal + (effects ? '，' + effects : '');
        return '<button type="button" class="fusion-gear q' + gear.quality + (chosen ? ' selected' : '') +
          '" data-fusion-gear="' + esc(gear.key) + '" aria-pressed="' + chosen + '" aria-label="' + esc(detail + '，' + (chosen ? '已放入，点击移除' : unavailable || '点击放入')) + '" title="' + esc(detail) + '"' + (unavailable && !chosen ? ' disabled' : '') + '>' +
          '<span class="fusion-frame">' + art(gear) +
          '<span class="fusion-quality-tag q' + gear.quality + '">' + qualities[gear.quality] + '</span>' +
          '<span class="fusion-card-state">' + esc(caption) + '</span></span>' +
          '<span class="fusion-gear-name">' + esc(gear.name) + '</span>' + extTags(gear) + '</button>';
      }).join('');
      const pips = [0, 1, 2].map((i) => '<i class="' + (i < selected.length ? 'on' : '') + '"></i>').join('');
      const nextQuality = first ? (first.quality >= 5 ? 5 : first.quality + 1) : 0;
      const previewLabel = first
        ? (first.quality >= 5 ? '黑装洗练' : (window.__SSDZ_ONLINE__
          ? (qualities[nextQuality] || '') + '装备（部位随机）'
          : (qualities[nextQuality] || '') + partLabel(first)))
        : '更高品质';

      const pickedGears = selected.map((key) => gears.find((g) => g.key === key)).filter(Boolean);
      const sameSet = pickedGears.length === 3 && State.fusionFamilyInfo ? State.fusionFamilyInfo(pickedGears) : null;
      const online = !!window.__SSDZ_ONLINE__;
      const previewHint = sameSet
        ? (online ? '同套优先（2% 变异）：' : '同套必得：') + sameSet.family
        : (first ? (online ? '产物部位从三件材料随机' : '产物部位随首件材料') : '必得 1 件');
      const guaranteeText = sameSet ? (online ? '同套优先 · 品质提升一级' : '同套必得该套 · 品质提升一级')
        : first && first.quality >= 5 ? '同部位黑装洗练 · 材料会被消耗' : '品质提升一级 · 材料会被消耗';

      const pickedTags = new Set();
      pickedGears.forEach((g) => State.extText(g.ext).forEach((x) => pickedTags.add(x)));
      const pickedHtml = selected.length
        ? '<div class="fusion-picked-exts"><b>可继承词条</b><div class="fusion-ext-tags">' +
            ([...pickedTags].map((x) => '<span class="fusion-ext-tag">' + esc(x) + '</span>').join('') ||
              '<span class="fusion-ext-none">所选材料没有词条</span>') + '</div></div>'
        : '';
      board.innerHTML = '<header class="fusion-heading"><h2>装备融合</h2>' +
        '<ol class="fusion-steps"><li class="on"><b>1</b>选择材料</li><li' + (selected.length === 3 ? ' class="on"' : '') + '><b>2</b>融合</li><li><b>3</b>获得装备</li></ol>' +
        '<span class="fusion-wallet">' + classic.goldIcon() + '<span>金松果 <b>' + State.state().goldPoint + '</b></span></span></header>' +
        '<div class="fusion-workbench"><div class="fusion-materials" aria-label="融合材料">' + materials + '</div>' +
        '<span class="fusion-arrow" aria-hidden="true">➜</span><div class="fusion-preview ' + (first ? 'q' + nextQuality : 'missing') + '"><span class="fusion-frame"><span class="fusion-question">?</span></span><span class="fusion-preview-label">' + previewLabel + '</span><span class="fusion-preview-hint">' + previewHint + '</span></div>' +
        '<div class="fusion-operation"><span class="fusion-cost">' + (first ? '消耗 <b>' + costOf(first) + '</b> 金松果' : '按品质 ' + [0, 1, 2, 3, 4, 5].map((q) => State.fusionCostOf(q)).join(' / ')) + '</span><button type="button" class="uc-button gold" data-fusion-action="fuse"' + (reason || busy ? ' disabled' : '') + '>开始融合</button><span class="fusion-guarantee">' + guaranteeText + '</span>' + pickedHtml + '</div></div>' +

        '<p class="fusion-rules"><b>规则</b>' +
        '<span class="fusion-rules-text">' + (online
          ? '3 件<em>同品质</em>装备（部位/名字可不同）→ 品质高一级；同套优先、2% 变异；词条按星级继承。'
          : '3 件<em>同品质</em>装备（部位/名字可不同）→ 品质高一级；3 件同套且有下一品质档 → 必得该套；重合词条必继承。') + '</span>' +
        '<button type="button" class="uc-button tiny muted" data-fusion-action="rules">详细规则</button></p>' +
        '<div class="fusion-inventory-panel"><div class="fusion-inventory-heading"><h3>选择装备<span class="fusion-pips" aria-label="已放入 ' + selected.length + ' / 3">' + pips + '</span><span class="fusion-count">已放入 ' + selected.length + '/3</span></h3><button type="button" class="uc-button tiny muted" data-fusion-action="clear"' + (selected.length ? '' : ' disabled') + '>清空材料</button><div class="fusion-pagination"><button type="button" class="uc-button tiny" data-fusion-action="previous" aria-label="上一页装备"' + (pageIndex === 0 ? ' disabled' : '') + '><i class="chev chev-l" aria-hidden="true"></i></button><span>' + (pageIndex + 1) + ' / ' + pages + '</span><button type="button" class="uc-button tiny" data-fusion-action="next" aria-label="下一页装备"' + (pageIndex + 1 >= pages ? ' disabled' : '') + '><i class="chev chev-r" aria-hidden="true"></i></button></div></div>' +
        '<div class="fusion-inventory">' + (cards || '<div class="fusion-empty">还没有可以选择的装备。<br><span>收集装备碎片，可在道具中合成装备。</span></div>') + '</div></div>' +
        '<p class="fusion-status' + (!reason ? ' ready' : '') + '" role="status" aria-live="polite"><i aria-hidden="true">' + (reason ? '!' : '✓') + '</i>' + esc(reason || '材料已齐全，可以融合！') + '</p>';

      board.querySelectorAll('[data-fusion-slot]').forEach((button) => {
        button.onclick = () => { selected.splice(Number(button.dataset.fusionSlot), 1); render({ action: 'clear' }); };
      });
      board.querySelectorAll('[data-fusion-gear]').forEach((button) => {
        button.onclick = () => {
          const key = button.dataset.fusionGear;
          const current = State.myGears(), gear = current.find((item) => item.key === key);
          if (!gear || gear.used || cannotMerge(gear)) return;
          if (selected.includes(key)) selected = selected.filter((item) => item !== key);
          else {
            const material = current.find((item) => item.key === selected[0]);

            if (selected.length >= 3 || material && material.quality !== gear.quality) return;
            selected.push(key);
          }
          render({ key });
        };
      });
      const action = (name) => board.querySelector('[data-fusion-action="' + name + '"]');
      action('clear').onclick = () => { selected = []; render({ action: 'clear' }); };
      action('previous').onclick = () => { pageIndex--; render({ action: 'previous' }); };
      action('next').onclick = () => { pageIndex++; render({ action: 'next' }); };
      action('fuse').onclick = fuse;
      action('rules').onclick = showRules;
      if (focus) {
        const target = focus.key ? [...board.querySelectorAll('[data-fusion-gear]')].find((button) => button.dataset.fusionGear === focus.key) : action(focus.action);
        if (target && !target.disabled) target.focus({ preventScroll: true });
        else board.querySelector('[data-fusion-gear]:not(:disabled)')?.focus({ preventScroll: true });
      }
    }


    function showRules() {
      const pct = (v) => Math.round(v * 100) + '%';
      const mut = (k) => pct(Math.max(0, Number(State.FUSION_MUTANT_RATE[k]) || 0));
      const same = (k) => pct(Math.max(0, Number(State.FUSION_SAME_NAME_RATE[k]) || 0));
      const other = (k) => pct(Math.max(0, 1 - (Number(State.FUSION_MUTANT_RATE[k]) || 0) - (Number(State.FUSION_SAME_NAME_RATE[k]) || 0)));

      /* 联机版融合走 `State.mergeGears` 的 ONLINE_RULES 分支：部位从三件材料里随机取一件、
         同套优先但 2% 变异、词条按星级排序后继承。弹窗必须按这条链写，不能沿用单机的
         「首件材料 / 同名保名 / 50% 继承」旧文案。 */
      if (window.__SSDZ_ONLINE__) {
        classic.modal('融合规则', '<div class="fusion-help">' +
          '<p><b>材料</b>3 件同品质、未穿戴、未加星标的装备，会被消耗；部位和名字可以完全不同。</p>' +
          '<p><b>费用</b>' + fusionCostLine() + '</p>' +
          '<p><b>产物</b>品质高一级的 1 件，部位从三件材料中随机；3 紫 → 传说橙（可镶嵌宝石）；' +
          '3 橙 → 黑色装备；3 黑 → 同部位黑装洗练（词条重掷）。</p>' +
          '<p><b>套装与变异</b>产物优先取随机材料所属套装的下一档；三件同套且该套有下一档时最多 2% 变异（其余 98% 仍是同套）；' +
          '变异套为橙装「狂战」、黑装「深海 / 机器猫 / 怒战 / 狂战」。该套没有下一档时从其它套装随机。</p>' +
          '<p><b>名称</b>产物名称由目标套装的对应部位决定，没有保名规则；变异时换成变异套的对应装备。</p>' +
          '<p><b>词条</b>先按星级从高到低排序，前两条必继承（橙 / 黑共 3 槽）；两件以上材料共有的词条在超过槽位时随机保留槽位数条；' +
          '剩余槽位从其余材料词条里随机继承，材料词条不够时随机补一条；每条继承后有 ' +
          pct(State.FUSION_EXT_UPGRADE_RATE) + ' 升 1 星（上限 3 星），同名词条只保留最高星。</p>' +
          '</div>', [{ label: '知道了', cls: 'gold' }]);
        return;
      }

      classic.modal('融合规则', '<div class="fusion-help">' +
        '<p><b>材料</b>3 件同品质、未穿戴的装备，会被消耗；部位和名字可以完全不同。</p>' +
        '<p><b>费用</b>' + fusionCostLine() + '</p>' +
        '<p><b>产物</b>部位随第一件材料、品质高一级的 1 件；3 紫 → 传说橙（可镶嵌宝石）；' +
        (modernMode() ? '现代界面已删除黑装，橙装不能再融合。' : '3 橙 → 黑色装备（原版 composeType=3，材料就是橙装）。') + '</p>' +
        '<p><b>同套保底</b>三件材料同属一套（如狂战头盔/拳甲/铠甲）且该套有下一品质档时，产物必定是同套装的下一品质、首件材料部位；同套黑装 46/67、47/68 取 id 最小件。该套没有下一品质档（早期白/绿套）或材料跨套时按下面这条随机规则；品质 5 的黑装已是最高档，三件黑装仍按同部位洗练（97% 同家族）。</p>' +
        '<p><b>名称</b>三件同名 ' + same(3) + ' 保名 / ' + mut(3) + ' <em>变异</em>；' +
        '两件同名 ' + same(2) + ' 保名 / ' + mut(2) + ' <em>变异</em> / ' + other(2) + ' 随机其它装备；' +
        '三件全不同名则完全随机。橙→黑时变异池是深海/机器猫/怒战/狂战；品质太低（没有对应变异件）时不掷变异，那部分并入随机。</p>' +
        '<p><b>词条</b>同一个词条只要在两件以上材料里出现，产物<b>优先继承</b>（不同部位、不同名字也算）；' +
        '同名词条只保留一条（取最高星）。超过目标品质槽位时随机保留槽位数条（橙/黑最多 3 条，不会出 4 词条）；' +
        '其余每个词条槽有 ' + pct(State.FUSION_EXT_INHERIT_RATE || 0.5) +
        ' 概率从材料词条里继承，取最高星；继承后另有 ' +
        pct(State.FUSION_EXT_UPGRADE_RATE) + ' 升 1 星（上限 3），没掷中则随机。</p>' +
        '</div>', [{ label: '知道了', cls: 'gold' }]);
    }


    async function fuse() {
      if (busy || !page.isConnected) return;
      const gears = State.myGears(), reason = validation(gears);
      if (reason) { render(); classic.toast(reason); return; }
      const previousQuality = gears.find((gear) => gear.key === selected[0]).quality;
      const previousCost = State.fusionCostOf(previousQuality);
      busy = true;
      let result;
      // 联机版：融合产物（名称/变异/词条）由服务端掷，必须 await。
      try { result = await StateCall('mergeGears', selected.slice(), { allowMixedParts: true }); }
      finally { busy = false; }
      if (!result.ok) { render(); classic.toast(result.msg); return; }
      selected = []; pageIndex = 0; render();
      const gear = result.gear;
      const effects = State.extText(gear.ext);
      // 「卖出」：融合产物常是拿去变现的，介绍页直接给卖出入口（点不开确认就关弹窗，
      const success = classic.modal('融合成功', '<div class="fusion-success"><div class="fusion-success-item q' + gear.quality + '"><span class="fusion-frame">' + art(gear) + '</span><strong>' + esc(gear.name) + '</strong></div><div class="fusion-success-details"><div class="fusion-quality-change"><span class="q' + previousQuality + '">' + qualities[previousQuality] + '</span><span aria-hidden="true"> → </span><strong class="q' + gear.quality + '">' + qualities[gear.quality] + '</strong></div><p>基本属性：' + esc(gear.attrName) + ' +' + gear.abilityVal + '<br>使用等级：' + gear.useLevel + ' 级</p>' + (gear.mutant ? '<p class="fusion-mutant">⚡ <b>' + (gear.quality === 5 ? '黑装变异' : '狂战变异') + '</b>：这次没保住原名，变成了该部位的' + (gear.quality === 5 ? '深海/机器猫/怒战/狂战' : '狂战') + '装备</p>' : '') + (effects.length ? '<p class="fusion-effects">' + effects.map(esc).join('<br>') + '</p>' : '') + '</div></div><p class="fusion-success-note">已消耗 3 件材料和 ' + previousCost + ' 金松果，新装备（' + (PART_NAME[State.gearPart(gear.id)] || '装备') + '）已放入装备背包。</p>', [
        { label: '卖出', cls: 'muted', close: false, run: () => {
            const range = State.gearSellRange(State.gearQuality(gear));
            classic.modal('卖出装备', '<p>将以 <b>' + range[0] + '~' + range[1] + '</b> 金松果随机卖出【' + esc(gear.name) + '】吗？</p>', [
              { label: '卖出', cls: 'gold', run: async () => {
                  try {
                    const got = await StateCall('sellGear', gear.key, true);
                    success.close();
                    if (got > 0) { classic.toast('卖出【' + gear.name + '】，获得 ' + got + ' 金松果'); render(); }
                    else { classic.toast('这件装备已不在背包里'); render(); }
                  } catch (e) {
                    classic.toast('出售失败：' + ((e && e.message) || '网络异常'));
                  }
                } },
              { label: '返回', cls: 'muted' }
            ], { small: true });
          } },
        { label: '继续融合', run: () => render({ action: 'clear' }) },
        { label: '查看装备', cls: 'gold', run: () => UI.runAction('gears') }
      ]);
    }
    render();
    return page;
  }
  window.ClassicFusion = Object.freeze({ open });
})();
