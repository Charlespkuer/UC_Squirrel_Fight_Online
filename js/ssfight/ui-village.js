// js/ssfight/ui-village.js —— 原版村庄四个地点的场景页实现
(function () {
  'use strict';


  const T = () => (window.SfUiMain && window.SfUiMain.toolkit) || null;

  // 复刻侧的提示：走经典界面那套 toast，拿不到就退回 console（不能静默什么都不发生）。
  function toast(msg) {
    try {
      if (window.UI && UI.classic && UI.classic.toast) { UI.classic.toast(msg); return; }
    } catch (e) {}
    try { console.log('[村庄场景] ' + msg); } catch (e) {}
  }




  const NOTE = {
    miracleRecord: '这里显示「神迹当前共为你提升了——」那四行累计值。',
    warBoss: '原版点 BOSS 是「报名 / 查看对局」（要征战令与匹配服务），复刻还没有这套数据。',
    warRecord: '原版「战绩」是向服务器要报名与对战记录，复刻还没有这套数据。',
  };

  // 页表：地点 → 库元件 + 帧号 + 接线函数
  // 点那些"还没接功能"的按钮会再把它叫出来。没接完的页面必须写清楚，免得看着像坏了。
  // ⚠ 文案尽量压到一行：这条说明是盖在弹窗自己的按钮上的（`pointer-events:none`，
  const PAGES = {
    altar: {
      scene: 'village-altar', bundle: 'tags-homeland.json', symbol: '3957', frame: 1, title: '祭坛',
      wire: wireAltar,
      note: '「领取」每天一次，「升级」扣金松果并开始倒计时 —— 都照原版。',
    },
    'altar-up': {
      scene: 'village-altar', bundle: 'tags-homeland.json', symbol: '3957', frame: 5, title: '祭坛 · 升级',
      wire: wireLandLevelUp, build: 'altar',
      note: '升级需要金松果，升完要等倒计时；完成时间到了再进村庄就会结算。',
    },
    miracle: {
      scene: 'village-miracle', bundle: 'tags-homeland.json', symbol: '3957', frame: 3, title: '神迹',
      wire: wireMiracle,
      note: '每次升级给 1 个随机属性点，「记录」里能看到历年加了多少。',
    },
    'miracle-record': {
      scene: 'village-miracle', bundle: 'tags-homeland.json', symbol: '3957', frame: 4, title: '神迹 · 记录',
      wire: wireMiracleRecord,
      note: NOTE.miracleRecord,
    },
    'miracle-up': {
      scene: 'village-miracle', bundle: 'tags-homeland.json', symbol: '3957', frame: 5, title: '神迹 · 升级',
      wire: wireLandLevelUp, build: 'miracle',
      note: '升级需要金松果，升完要等倒计时；完成时间到了再进村庄就会结算。',
    },
    beast: {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 1, title: '幻兽牧场',
      wire: wireBeast,
      note: '孵化 / 编队 / 喂养 / 进化都已接上存档数据；点格子查看详情。',
    },
    'beast-hatch': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 8, title: '幻兽牧场 · 孵化',
      wire: wireBeastHatch,
      note: '消耗200孵化点随机孵化一只幻兽；星级越高领导力需求越高。',
    },
    'beast-team': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 4, title: '幻兽牧场 · 编队',
      wire: wireBeastTeam,
      note: '勾选最多3只幻兽，领导力总和不能超过牧场等级提供的上限。',
    },
    'beast-feed': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 5, title: '幻兽牧场 · 喂养',
      wire: wireBeastFeed,
      note: '喂养会消耗其它幻兽与金松果，出战队伍里的幻兽不会被消耗。',
    },
    'beast-evolve': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 7, title: '幻兽牧场 · 进化',
      wire: wireBeastEvolve,
      note: '点格子自由选择目标与两只同星级材料；出战幻兽不能当材料，随机进化成高一星幻兽。',
    },
    'beast-detail': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 3, title: '幻兽 · 详情',
      wire: wireBeastDetail,
      note: '查看这只幻兽的等级、经验、领导力与技能。',
    },
    'beast-choose': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 2,
      title: '幻兽选择', wire: wireBeastChoose,
    },
    'beast-hatched': {
      scene: 'village-beast', bundle: 'tags-summons.json', symbol: '4381', frame: 9,
      title: '孵化结果', wire: wireBeastHatched,
    },
    'beast-up': {
      scene: 'village-beast', bundle: ['tags-summons.json', 'tags-homeland.json'], symbol: '3957', frame: 5,
      title: '幻兽牧场 · 升级', wire: wireLandLevelUp, build: 'beast',
      note: '幻兽牧场的「升级」原版挂在「家园弹出」的第 5 帧上（`homeLandLevelUp(building)`），复刻照同一条走。',
    },
    war: {
      scene: 'village-war', bundle: 'tags-campaign.json', symbol: '3437', frame: 1, title: '征战',
      wire: wireWar,
      note: '页面与左右翻页照原版：「征战令 / 报名 / 战绩」这套数据复刻还没有 —— 下一批接。',
    },
  };

  const LOCATION_PAGE = {
    'village-altar': 'altar',
    'village-miracle': 'miracle',
    'village-beast': 'beast',
    'village-war': 'war',
  };

  let current = null;
  let beastPage = 1;
  let selectedPetKey = '';
  let petChooser = null;
  let teamDraft = [];
  let feedDraft = [];

  let evolveDraft = ['', '', ''];

  async function mountPetArt(host, pet) {
    if (!host || !pet || !window.SfRender || !SfRender.mountSymbol) return false;
    const seq = (host.__petArtSeq || 0) + 1;
    host.__petArtSeq = seq;
    if (host.__petArtView) host.__petArtView.destroy();
    host.__petArtView = null;
    host.innerHTML = '<span class="loading">…</span>';
    try {
      const v = await SfRender.mountSymbol(host, '4280', { frame: Math.max(1, Number(pet.id) || 1), label: '幻兽' });
      if (seq !== host.__petArtSeq || !host.isConnected) { try { v.destroy(); } catch (e) {} return false; }
      host.__petArtView = v;
      if (window.SfUiMain && SfUiMain.toolkit) SfUiMain.toolkit.freezeDescendants(v);
      v.playing = false;
      const svg = host.querySelector('svg');
      let b = null;
      try { b = v.g.getBBox(); } catch (e) { b = null; }
      if (svg && b && b.width > 0 && b.height > 0) {

        const pad = Math.max(0.8, Math.min(2, Math.max(b.width, b.height) * 0.02));
        svg.setAttribute('viewBox', (b.x - pad) + ' ' + (b.y - pad) + ' ' + (b.width + pad * 2) + ' ' + (b.height + pad * 2));
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.width = '100%';
        svg.style.height = '100%';
      }
      host.classList.add('ready');
      return true;
    } catch (e) {
      host.innerHTML = '';
      if (window.__errs) window.__errs.push('pet art: ' + (e && e.message));
      return false;
    }
  }
  function clearPetArt(container) {
    if (!container) return;
    for (const n of container.querySelectorAll('.ssfight-pet-art')) {
      n.__petArtSeq = (n.__petArtSeq || 0) + 1;
      if (n.__petArtView) n.__petArtView.destroy();
      n.remove();
    }
  }

  function layoutScale(host) {
    if (!host) return 1;
    // ⚠ 缓存探针必须判 `isConnected`：重挂牧场页时 `SfRender.mountSymbol(host, …)` 会把
    // 只在探针还连着时复用，否则重建一颗。
    let p = host.__petProbe;
    if (!p || !p.isConnected) {
      p = document.createElement('div');
      p.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:0;pointer-events:none;visibility:hidden';
      host.appendChild(p);
      host.__petProbe = p;
    }
    const w = p.getBoundingClientRect().width;
    return w ? w / 100 : 1;
  }
  // 收掉幻兽格画稿里自带的 `level` 文本（4276，占位串固定是 "lv23"）。
  // ⚠ 它是 tp11 文本 `<g>`，不是 MovieClip：老的 `lv.g.style.display` 对文本节点无效，
  function hidePetLevel(cell) {
    if (!cell || !cell.g) return;
    const lv = cell.byName ? cell.byName('level') : null;
    const node = lv && (lv.g || lv);
    if (node) {
      node.style.display = 'none';
      node.setAttribute('visibility', 'hidden');
      if (window.SfRender && SfRender.setText && lv.__textBox) SfRender.setText(lv, '');
    }

    for (const t of cell.g.querySelectorAll('g[type="text"]')) {
      t.style.display = 'none';
      t.setAttribute('visibility', 'hidden');
    }
  }




  const clipOf = (host, name) => (host && host.byName ? host.byName(name) : null);
  // 换掉某个文本字段（tp11 的放置存的是 `<g type="text">` 元素，不是 MovieClip）。
  // `opts.wrap` 透传给显示层：按字段框宽自动折行（详情页的长技能说明）。
  function setTextByName(host, name, str, opts) {
    const t = T();
    const n = clipOf(host, name);
    if (t && n) t.setText(n, str, opts);
    return n;
  }
  // 幻兽技能数值的显示格式：整数不带小数点，半档（10.5 这类）保留一位。
  function skillValueText(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  }

  function fillSkillValue(text, value) {
    return String(text == null ? '' : text).replace(/X/g, skillValueText(value));
  }
  // 让元件停在某一帧（不自己播）。这些按钮是"状态精灵"，只能停帧不能 play。
  function stopAt(clip, n) {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(n); } catch (e) {}
  }

  function refreshShell(clip) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    t.freezeDescendants(clip);
  }


  function wireClickable(clip, onFire, opts) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    const hoverFrame = (opts && opts.hover != null) ? Number(opts.hover) : 2;
    const idleFrame = (opts && opts.idle != null) ? Number(opts.idle) : 1;
    clip.__sceneFire = onFire;
    if (clip.__sceneWired) return;
    clip.__sceneWired = true;
    clip.__sceneHover = false;
    stopAt(clip, idleFrame);
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    t.measureHitBox(clip);
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    if (window.SfUiFeedback) SfUiFeedback.bind(clip.g, {
      hover: false, shell: () => clip.g.querySelector(':scope > g.uc-pop'),
    });
    clip.g.addEventListener('mouseenter', () => {
      clip.__sceneHover = true;
      if (hoverFrame > 0) stopAt(clip, hoverFrame);
      refreshShell(clip);
    });
    clip.g.addEventListener('mouseleave', () => { clip.__sceneHover = false; stopAt(clip, idleFrame); refreshShell(clip); });
    clip.g.addEventListener('click', (e) => {
      e.stopPropagation();
      const fire = () => {
        if (clip.__sceneFire) clip.__sceneFire();
      };
      if (window.SfUiFeedback) SfUiFeedback.tap(clip.g, fire, { delay: 0, press: false });
      else fire();
    });
  }

  function setVisible(clip, on) {
    if (clip && clip.g) clip.g.style.visibility = on ? '' : 'hidden';
  }
  // 回村庄页：走 classic-ui 的动作表，与「回家」键同一个出口。
  // ⚠ 先 `destroy()` 再跳：不然 `SfVillage.current()` 会一直指着已经被换掉的那棵树
  function backToVillage() {
    destroy();
    if (window.UI && UI.runAction) UI.runAction('village');
  }
  // 页面底部那行说明（复刻侧补的，不是原版内容）。用 DOM 盖在 SVG 上：
  // ⚠ 只停一会儿就自动收起，而且是 `pointer-events:none`（见 CSS）：
  const NOTE_MS = 5000;
  // 建筑等级角标：页面里 text1 字段在导出的 3957/4381 里被省略了，原版是
  function showBuildingLevel(container, key, label, style) {
    if (!container) return null;
    for (const old of container.querySelectorAll('.ssfight-building-level')) old.remove();
    const b = building(key);
    if (!b) return null;
    const d = document.createElement('div');
    d.className = 'ssfight-building-level sf-clickthrough';
    d.textContent = (label || BUILDING_LABEL[key] || key) + ' Lv' + b.level + (b.upgrading ? ' · 升级中' : '');
    if (style) d.style.cssText = style;
    container.appendChild(d);
    return d;
  }
  const BUILDING_LABEL = { altar: '祭坛', miracle: '神迹', beast: '幻兽牧场' };

  function showNote(container, text) {
    if (!container) return;
    let n = container.querySelector('.ssfight-note');
    if (!text) { if (n) n.style.display = 'none'; return; }
    if (!n) {
      n = document.createElement('div');
      n.className = 'ssfight-note sf-clickthrough';
      container.appendChild(n);
    }
    n.textContent = text;
    n.style.display = '';
    n.classList.remove('flash');
    if (n.__hide) clearTimeout(n.__hide);
    n.__hide = setTimeout(() => { n.style.display = 'none'; n.__hide = 0; }, NOTE_MS);
  }

  function pendingFlash(msg) {
    toast(msg);
    const cur = current;
    if (cur && cur.container) showNote(cur.container, cur.page.note || '');
    try {
      const n = cur && cur.container && cur.container.querySelector('.ssfight-note');
      if (n) {
        n.classList.remove('flash');
        void n.getBoundingClientRect();
        n.classList.add('flash');
        if (n.__unflash) clearTimeout(n.__unflash);
        n.__unflash = setTimeout(() => n.classList.remove('flash'), 900);
      }
    } catch (e) {}
  }


  function hideAllPetLevels(host) {
    if (!host || !host.g) return;
    for (const cell of host.g.querySelectorAll('g[sid="4279"]')) {
      for (const t of cell.querySelectorAll('g[type="text"]')) {
        t.style.display = 'none';
        t.setAttribute('visibility', 'hidden');
      }
    }
  }
  // 取当前建筑的快照（`State.building(key)`；没有存档或没这套数据时返回 null）。
  function building(key) {
    if (!(window.State && State.building)) return null;
    try { return State.building(key); } catch (e) { return null; }
  }

  // ① 祭坛 —— MainMovie.as:9814 `showTemple()`
  // setText(text1, "LV" + building.level)           // ⚠ 第 1 帧里没有 text1 这个字段
  function wireAltar(view, page, container) {
    const t = T();
    const b = building('altar');
    showBuildingLevel(container, 'altar', '祭坛', 'right:18px;top:64px');
    // text1：原版 `setText(text1, "LV" + building.level)` —— 第 1 帧里没有这个字段

    if (t && b) {
      const info = State.buildingUpInfo(b.level);
      t.setText(clipOf(view, 'text2'),
        '1.参加竞技场时有' + info.expRate + '%几率获得双倍经验奖励\n'
        + '2.参加竞技场时有' + info.propRate + '%几率获得双倍碎片奖励\n'
        + '3.挑战关卡时有' + info.goldRate + '%几率获得双倍金松果奖励');
    }
    // text3：当日状态（原版 `showTempleBuff` :9858；没有 buff 就清空）。
    // ⚠ 必须连同 `buffDate` 一起判：buffId 是跨天保留的存档字段，
    const claimed = b ? State.buildingBuffClaimed('altar') : false;
    const buffText = !claimed ? '' : b.buffId === 1 ? '本日特殊状态：竞技场经验双倍奖励！'
      : b.buffId === 2 ? '本日特殊状态：竞技场碎片双倍奖励！'
        : b.buffId === 3 ? '本日特殊状态：关卡金松果双倍！' : '';
    setTextByName(view, 'text3', buffText);
    // 「领取当日状态」：原版 `gainBuff`（一天一次，服务端判定）。按钮在已经领过时
    wireClickable(clipOf(view, 'button1'), () => {
      const r = State.claimBuildingBuff('altar');
      toast(r.msg);
      if (r.ok) openPage('altar');
    });
    if (claimed) setVisible(clipOf(view, 'button1'), false);
    wireClickable(clipOf(view, 'button2'), () => openPage('altar-up'));
    wireClickable(clipOf(view, 'button3'), backToVillage);
    showNote(container, PAGES.altar.note);
  }

  // 通用「升级确认」页 —— 原版 `homeLandLevelUp(building)`（:10875）
  // `家园弹出.gotoAndStop(5)` + 写六个字段：
  function buildingOf(page) {
    const key = page && page.build;
    if (!key) return null;
    return building(key);
  }
  // 两颗按钮交换视觉中心（缩放不同，不能只换矩阵的 e），y 保持原版。
  // 不能用屏幕矩形 + getScreenCTM 反算：iOS WebKit 的 CTM 不含祖先 #ui 的 CSS 缩放，
  // 会把两颗键都挪到对方位置附近、叠在一起。只读画稿的局部 bbox 与 base matrix。
  function baseMatrixOf(clip) {
    const p = String(clip && clip.g && clip.g.__baseMa || '').split(',').map(Number);
    return p.length === 6 && p.every((v) => Number.isFinite(v)) && p[0] ? p : null;
  }
  function visualCenterX(clip, m) {
    try {
      const b = clip.g.getBBox();
      if (b && b.width > 0) return m[4] + (b.x + b.width / 2) * m[0];
    } catch (e) {}
    return m[4];
  }
  function swapUpgradeButtons(view) {
    const up = clipOf(view, 'button1'), back = clipOf(view, 'button2');
    if (!up || !back || !up.g || !back.g || !up.setExtraTransform || !back.setExtraTransform) return false;
    const mu = baseMatrixOf(up), mb = baseMatrixOf(back);
    if (!mu || !mb) return false;
    const dx = visualCenterX(back, mb) - visualCenterX(up, mu);
    if (!Number.isFinite(dx) || Math.abs(dx) < 1) return false;
    up.setExtraTransform('translate(' + (dx / mu[0]).toFixed(3) + ',0)');
    back.setExtraTransform('translate(' + (-dx / mb[0]).toFixed(3) + ',0)');
    return true;
  }
  function wireLandLevelUp(view, page, container) {
    const t = T();
    swapUpgradeButtons(view);
    const b = buildingOf(page);
    if (page && page.build) showBuildingLevel(container, page.build, BUILDING_LABEL[page.build], 'right:18px;top:64px');
    const key = page.build;
    const label = (window.State && State.BUILDING_LABEL) ? State.BUILDING_LABEL[key] : key;
    if (!b) { wireClickable(clipOf(view, 'button2'), backToVillage); return; }
    const info = State.buildingUpInfo(b.level);
    const next = State.buildingUpInfo(Math.min(State.BUILDING_MAX_LEVEL, b.level + 1));
    const atMax = b.level >= State.BUILDING_MAX_LEVEL;

    const st = State.state() || {};
    const capNow = Math.max(1, Number(st.petsCapacity) || 6);
    const leadNow = State.petLeadership ? State.petLeadership() : (b.level * 3 + 7);
    const leadNext = b.level * 3 + 7;
    if (t) {
      t.setText(clipOf(view, 'text1'), atMax ? '—' : String(info.gold));
      t.setText(clipOf(view, 'text11'), atMax ? '' : '金松果');
      t.setText(clipOf(view, 'text2'), atMax ? '—' : String(info.hour));
      t.setText(clipOf(view, 'text22'), atMax ? '' : '小时');
      // text3 是 3957 f5 的字段（3845，约 207×35，12 号字）：短行 + 显式换行，
      const desc = atMax ? '已达最高等级'
        : key === 'altar' ? ('三项双倍几率 ' + info.expRate + '%→' + next.expRate + '%')
          : key === 'miracle' ? '随机属性点 +1'
            : ('升级后领导力 ' + leadNow + '→' + leadNext + '\n存储格 ' + capNow + '→' + (capNow + 1) + '　孵化点 +200');
      t.setText(clipOf(view, 'text3'), desc);
    }
    wireClickable(clipOf(view, 'button1'), async () => {
      // 联机版：建筑升级是 async 动作（服务端校验金松果与等级），必须 await。
      const r = await StateCall('upgradeBuilding', key);
      if (!r.ok) { toast(r.msg); return; }
      toast(label + '开始升级：' + r.gold + ' 金松果，' + r.hour + ' 小时后完成。');

      if (window.SfUiMain && SfUiMain.refreshVillageBuildings) {
        try { SfUiMain.refreshVillageBuildings(); } catch (e) {}
      }
      openPage(key);
    });
    wireClickable(clipOf(view, 'button2'), () => openPage(key));
    showNote(container, key === 'beast'
      ? (atMax ? '幻兽牧场已达最高等级。'
        : ('升级后领导力 ' + leadNow + '→' + leadNext + '，存储格 +1，孵化点 +200。'))
      : page.note);
  }

  // ② 神迹 —— MainMovie.as:9892 `showMiracle()`
  // 原版：gotoAndStop(3)；setText(text1, "LV"+level)（第 3 帧同样没有 text1 字段）；
  function wireMiracle(view, page, container) {
    showBuildingLevel(container, 'miracle', '神迹', 'right:18px;top:64px');
    wireClickable(clipOf(view, 'button1'), () => openPage('miracle-record'));
    wireClickable(clipOf(view, 'button2'), () => openPage('miracle-up'));
    wireClickable(clipOf(view, 'button3'), backToVillage);
    showNote(container, PAGES.miracle.note);
  }

  // ③ 神迹记录 —— MainMovie.as:9928 `showMiracleRecord(rsp)`
  // button1 = 回神迹页。四行累计值来自服务端 `miracleRecord.do` 的
  // `hpAdd/powerAdd/agilityAdd/speedAdd`，复刻直接读存档里攒下来的那一份。
  function wireMiracleRecord(view, page, container) {
    showBuildingLevel(container, 'miracle', '神迹', 'right:18px;top:64px');
    const t = T();
    const rec = (window.State && State.miracleRecord) ? State.miracleRecord() : { power: 0, agility: 0, speed: 0, hp: 0 };
    if (t) {
      t.setText(clipOf(view, 'text1'),
        '神迹当前共为你提升了——\n' + rec.hp + '点生命\n' + rec.power + '点力量\n' +
        rec.agility + '点敏捷\n' + rec.speed + '点速度');
    }
    wireClickable(clipOf(view, 'button1'), () => openPage('miracle'));
    showNote(container, PAGES['miracle-record'].note);
  }

  // ④ 幻兽牧场 —— MainMovie.as:10950 `showSummons()`（本批只渲染页面）
  // 复刻按存档里的 `pets` 填格子；没有幻兽时显示空列表提示，左右翻页按页数显示。

  function statePets() { return (window.State && State.pets) ? State.pets() : []; }
  function ensureSelectedPet() {
    const list = statePets();
    if (!list.some((p) => p.key === selectedPetKey)) selectedPetKey = list[0] ? list[0].key : '';
    return list;
  }
  function openHatch() {
    return openPage('beast-hatch');
  }
  function openPetDetail(pet) {
    if (!pet) return toast('还没有幻兽，先去孵化一只吧');
    selectedPetKey = pet.key;
    return openPage('beast-detail');
  }
  function openTeam() {
    teamDraft = ((State.state() || {}).petsTeam || []).slice(0, 3);
    return openPage('beast-team');
  }
  function openFeed() {
    const list = statePets();
    if (!list.length) return toast('还没有幻兽，先去孵化一只吧');
    choosePet('请选择要喂养的召唤兽', list, (pet) => {
      selectedPetKey = pet.key;
      feedDraft = [];
      openPage('beast-feed');
    }, backBeast);
  }

  function normalizeEvolveDraft() {
    if (!Array.isArray(evolveDraft)) evolveDraft = ['', '', ''];
    const list = statePets();
    const byKey = new Map(list.map((p) => [p.key, p]));
    const team = new Set((State.state() || {}).petsTeam || []);
    const out = ['', '', ''];
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const key = String(evolveDraft[i] || '');
      const pet = byKey.get(key);
      if (!pet || seen.has(key)) continue;
      // 目标可以在出战队伍里（进化后由 State 把新幻兽补回队伍）；材料不能出战。
      if (i > 0 && (team.has(key) || (out[0] && pet.grade !== byKey.get(out[0]).grade))) continue;
      out[i] = key;
      seen.add(key);
    }

    if (!out[0]) out[1] = out[2] = '';
    evolveDraft = out;
    return out;
  }

  function openEvolve() {
    const list = statePets();
    if (!list.length) return toast('还没有幻兽，先去孵化一只吧');
    normalizeEvolveDraft();
    return openPage('beast-evolve');
  }


  function choosePet(title, list, choose, back, hint) {
    petChooser = { title, list, choose, back, hint: hint || '', page: 1 };
    return openPage('beast-choose');
  }
  // 时间轴会合法复用上一帧的 c1 等元件，不能按 placedHere 一律隐藏。
  function preparePetPage(view, names) {
    const keep = new Set(names.split(' '));
    for (const rec of view.nodes.values()) {
      if (!rec.na) continue;
      const node = rec.wrap || rec.node;
      if (node && node.style) {
        node.style.display = keep.has(rec.na) ? '' : 'none';
        node.style.visibility = keep.has(rec.na) ? '' : 'hidden';
      }
    }
    hideAllPetLevels(view);
  }

  function paintPetCell(view, name, pet, container, onFire) {
    const cell = clipOf(view, name);
    if (!cell || !cell.g) return;
    stopAt(cell, 1);
    hidePetLevel(cell);
    if (onFire) wireClickable(cell, onFire, { idle: 1, hover: 1 });
    if (!pet) return;
    const hr = container.getBoundingClientRect(), cr = cell.g.getBoundingClientRect();
    const scale = layoutScale(container) || 1;
    const art = document.createElement('div');
    art.className = 'ssfight-pet-art sf-clickthrough';
    art.style.cssText = 'left:' + ((cr.left - hr.left + cr.width * 0.09) / scale) + 'px;top:' +
      ((cr.top - hr.top + cr.height * 0.16) / scale) + 'px;width:' + (cr.width * 0.82 / scale) +
      'px;height:' + (cr.height * 0.68 / scale) + 'px';
    container.appendChild(art);
    mountPetArt(art, pet).then((ok) => {
      if (!ok || !art.isConnected) return;
      const lv = document.createElement('span');
      lv.className = 'ssfight-pet-level sf-clickthrough';
      lv.textContent = 'Lv' + pet.level;
      art.appendChild(lv);
      // ⚠ 必须等 `mountPetArt` 完成后再加：它开头会 `host.innerHTML = '…'` 清楼，
      if (onFire) {
        const grade = Math.max(0, Math.min(5, Math.round(Number(pet.grade) || 0)));
        if (grade > 0) {
          const stars = document.createElement('span');
          stars.className = 'ssfight-pet-star sf-clickthrough';
          stars.textContent = '★'.repeat(grade);
          stars.setAttribute('aria-label', grade + ' 星');
          art.appendChild(stars);
        }
      }
    });
  }
  function wireBeastChoose(view, page, container) {
    preparePetPage(view, 'title1 title2 c1 c2 c3 c4 c5 c6 text1 text2 text3 text4 text5 text6 left right page button1');
    const picker = petChooser;
    if (!picker) { wireClickable(clipOf(view, 'button1'), backBeast); return; }
    const pages = Math.max(1, Math.ceil(picker.list.length / 6));
    picker.page = Math.max(1, Math.min(pages, picker.page));
    setTextByName(view, 'title1', picker.title);
    setTextByName(view, 'title2', picker.list.length ? '' : '没有可选择的召唤兽');
    if (picker.hint) view.g.setAttribute('aria-description', picker.hint);
    setTextByName(view, 'page', picker.page + '/' + pages);
    for (let i = 1; i <= 6; i++) {
      const pet = picker.list[(picker.page - 1) * 6 + i - 1];
      setTextByName(view, 'text' + i, pet ? pet.name : '');
      if (pet) paintPetCell(view, 'c' + i, pet, container, () => picker.choose(pet));
      else setVisible(clipOf(view, 'c' + i), false);
    }
    const left = clipOf(view, 'left'), right = clipOf(view, 'right');
    wireClickable(left, () => { if (picker.page > 1) { picker.page--; openPage('beast-choose'); } }, { hover: 1 });
    wireClickable(right, () => { if (picker.page < pages) { picker.page++; openPage('beast-choose'); } }, { hover: 1 });
    setVisible(left, picker.page > 1);
    setVisible(right, picker.page < pages);
    wireClickable(clipOf(view, 'button1'), picker.back || backBeast);
  }

  function alignBeastHint(view, container) {
    const text = clipOf(view, 'text12');

    const textNode = text && (text.g || text.node) ? (text.g || text.node) : (text && text.__textBox ? text : null);
    const top = clipOf(view, 'c1');
    const bottom = clipOf(view, 'c4');
    if (!textNode || !textNode.__textBox || !top || !top.g || !bottom || !bottom.g) return;
    const tr = top.g.getBoundingClientRect();
    const br = bottom.g.getBoundingClientRect();
    const hr = textNode.getBoundingClientRect();
    const gapTop = tr.bottom;
    const gapBottom = br.top;
    if (!(gapBottom > gapTop + 1)) return;
    const want = (gapTop + gapBottom) / 2 - (hr.top + hr.height / 2);

    const ctm = textNode.getScreenCTM ? textNode.getScreenCTM() : null;
    const scale = ctm ? Math.hypot(ctm.c, ctm.d) : 1;
    const dy = want / (scale || 1);
    if (!Number.isFinite(dy) || Math.abs(dy) < 0.5) return;
    // 文本字段的裁剪只有横向、纵向是放开的（`render.js` 的 clip rect 固定 -600..600），
    const box = textNode.__textBox;
    if (box.__beastBase == null) box.__beastBase = Number(box.base) || 0;
    box.base = box.__beastBase + dy;
    const str = (box.lines || []).map((line) => line && line.tx != null ? line.tx : '').join('\n');
    if (window.SfRender && SfRender.setText) SfRender.setText(textNode, str);
  }
  function wireBeast(view, page, container) {
    const t = T();
    clearPetArt(container);
    showBuildingLevel(container, 'beast', '幻兽牧场', 'left:18px;top:96px');
    const list = ensureSelectedPet();
    const cap = Math.max(1, Number((State.state() || {}).petsCapacity) || 6);
    // 格子数按「牧场容量」算，不按已有幻兽数算：空位也要画出来。
    // 老存档若已有超出容量的幻兽，仍按实际数量补足，避免把已有幻兽藏掉。
    const slotCount = Math.max(cap, list.length);
    const pageCount = Math.max(1, Math.ceil(slotCount / 6));
    beastPage = Math.max(1, Math.min(pageCount, Number(beastPage) || 1));
    const start = (beastPage - 1) * 6;
    const beastBadge = container && container.querySelector('.ssfight-building-level');
    if (beastBadge) beastBadge.textContent = 'Lv' + ((building('beast') || {}).level || 1) + ' · 格子 ' + list.length + '/' + cap;
    const hs = layoutScale(container) || 1;
    if (t) {
      t.setText(clipOf(view, 'text11'), '孵化点：' + (Number((State.state() || {}).hatchPoint) || 0));
      t.setText(clipOf(view, 'page'), beastPage + '/' + pageCount);
      t.setText(clipOf(view, 'text12'), list.length ? '' : '还没有召唤兽，快去孵化吧！');
    }
    for (let i = 1; i <= 6; i++) {
      const idx = start + i - 1;
      const inRange = idx < slotCount;
      const pet = inRange ? (list[idx] || null) : null;
      const cell = clipOf(view, 'c' + i);
      const nameNode = clipOf(view, 'text' + i);
      if (!inRange) {

        setVisible(cell, false);
        if (cell) {
          stopAt(cell, 1);
          hidePetLevel(cell);
          if (cell.g) cell.g.style.cursor = 'default';
        }
        if (t) t.setText(nameNode, '');
        continue;
      }
      setVisible(cell, true);
      if (pet) {
        if (cell) {
          stopAt(cell, 1);
          hidePetLevel(cell);
          wireClickable(cell, () => { selectedPetKey = pet.key; openPetDetail(pet); });

          if (cell.g) {
            cell.g.addEventListener('mouseenter', () => hidePetLevel(cell));
            cell.g.addEventListener('mouseleave', () => hidePetLevel(cell));
          }
        }
        if (t) t.setText(nameNode, pet.name);
        if (cell && cell.g && container) {
          const hr = container.getBoundingClientRect();
          const cr = cell.g.getBoundingClientRect();

          // ⚠ 垂直要"上下各余 16%"居中（0.16 = (1−0.68)/2）：2026-10-19 用户口径
          const cw = cr.width / hs;
          const ch = cr.height / hs;
          const art = document.createElement('div');
          art.className = 'ssfight-pet-art sf-clickthrough';
          art.style.left = ((cr.left - hr.left) / hs + cw * 0.09) + 'px';
          art.style.top = ((cr.top - hr.top) / hs + ch * 0.16) + 'px';
          art.style.width = (cw * 0.82) + 'px';
          art.style.height = (ch * 0.68) + 'px';
          container.appendChild(art);
          mountPetArt(art, pet).then(() => {
            if (!art.isConnected) return;

            hidePetLevel(cell);
            const lv = document.createElement('span');
            lv.className = 'ssfight-pet-level sf-clickthrough';
            lv.textContent = 'Lv' + pet.level;
            art.appendChild(lv);
          });
        }
      } else {
        if (cell) {
          stopAt(cell, 1);
          hidePetLevel(cell);
          if (cell.g) cell.g.style.cursor = 'default';
        }
        if (t) t.setText(nameNode, '');
      }
    }
    if (!list.length) alignBeastHint(view, container);
    const left = clipOf(view, 'left'), right = clipOf(view, 'right');
    setVisible(left, beastPage > 1);
    setVisible(right, beastPage < pageCount);
    // 3156 的第 2 帧是空帧：悬停必须保持第 1 帧，否则箭头会“消失”。
    wireClickable(left, () => { if (beastPage > 1) { beastPage--; openPage('beast'); } }, { hover: 1 });
    wireClickable(right, () => { if (beastPage < pageCount) { beastPage++; openPage('beast'); } }, { hover: 1 });
    wireClickable(clipOf(view, 'button5'), backToVillage);
    wireClickable(clipOf(view, 'button1'), openHatch);
    wireClickable(clipOf(view, 'button2'), openTeam);
    wireClickable(clipOf(view, 'button3'), openFeed);
    wireClickable(clipOf(view, 'button4'), openEvolve);
    wireClickable(clipOf(view, 'levelup'), () => openPage('beast-up'));
    showNote(container, PAGES.beast.note);
  }


  function wireBeastHatch(view, page, container) {
    preparePetPage(view, 'textMc egg button1 button2');
    setTextByName(clipOf(view, 'textMc'), 'text1', '孵化点：' + (Number((State.state() || {}).hatchPoint) || 0));
    wireClickable(clipOf(view, 'button1'), async () => {
      // 联机版：孵化星级由服务端掷（async 动作）。
      const r = await StateCall('hatchPet');
      toast(r.ok ? ('孵化成功：' + r.pet.name + '（' + r.pet.grade + '★）') : r.msg);
      if (r.ok) { selectedPetKey = r.pet.key; openPage('beast-hatched'); }
    });
    wireClickable(clipOf(view, 'button2'), backBeast);
  }
  function wireBeastHatched(view, page, container) {
    preparePetPage(view, 'text1 text2 c1 star button1');
    const pet = ensureSelectedPet().find((p) => p.key === selectedPetKey);
    if (pet) {
      setTextByName(view, 'text1', '恭喜你获得' + pet.grade + '星召唤兽');
      setTextByName(view, 'text2', pet.name);
      stopAt(clipOf(view, 'star'), pet.grade);
      paintPetCell(view, 'c1', pet, container);
    }
    wireClickable(clipOf(view, 'button1'), () => openPage('beast-hatch'));
  }


  function wireBeastDetail(view, page, container) {
    const t = T();
    preparePetPage(view, 'c1 star text1 text2 text3 text4 text5 levelMc expMc expText button1');
    const list = ensureSelectedPet();
    const pet = list.find((p) => p.key === selectedPetKey);
    if (!pet) { wireClickable(clipOf(view, 'button1'), backBeast); toast('还没有幻兽，先去孵化一只吧'); return; }
    setTextByName(view, 'text1', pet.name);
    setTextByName(view, 'text2', '领导力需求：' + pet.leadership);
    setTextByName(view, 'text3', '（上限' + pet.maxLevel + '）');
    // 原版 `doShowSummonsDeTail`：技能说明里的 X 要换成当前等级的实际值；
    // 下一级提示也把 X 换成下一级的数值。技能说明单行太长，交给显示层按字段宽折行。
    const skillNow = fillSkillValue(pet.skillRemark, pet.skillValue);
    const skillNext = pet.skillLevelupRemark ? fillSkillValue(pet.skillLevelupRemark, pet.skillNextValue) : '';
    setTextByName(view, 'text4', '技能：' + pet.skillName + '\n' + skillNow, { wrap: true });
    setTextByName(view, 'text5', pet.level >= pet.maxLevel ? '已达到最高等级'
      : (skillNext ? '下一级：' + skillNext : '喂养召唤兽可获得经验并升级'));
    setTextByName(view, 'expText', pet.level >= pet.maxLevel ? '' : pet.exp + '/' + pet.nextExp);
    paintPetCell(view, 'c1', pet, container);
    stopAt(clipOf(view, 'star'), pet.grade);

    const levelMc = clipOf(view, 'levelMc');
    if (levelMc && t && t.showNumber) t.showNumber(String(pet.level), levelMc, 0, 0, 'left', 4);
    const expMc = clipOf(view, 'expMc');
    if (expMc) stopAt(expMc, pet.level >= pet.maxLevel ? (expMc.frameCount ? expMc.frameCount() : 1) : Math.min(expMc.frameCount ? expMc.frameCount() : 100, 1 + Math.ceil(pet.exp * 100 / Math.max(1, pet.nextExp))));
    wireClickable(clipOf(view, 'button1'), backBeast);
  }


  function wireBeastTeam(view, page, container) {
    preparePetPage(view, 'text1 c1 c2 c3 button1 button2 button3');
    const list = statePets();
    const used = list.filter((p) => teamDraft.includes(p.key)).reduce((n, p) => n + p.leadership, 0);
    const cap = State.petLeadership ? State.petLeadership() : 0;
    for (const rec of view.nodes.values()) if (rec.na === 'text1') {
      const node = rec.node;
      if (T()) T().setText(node, String(rec.id) === '4321' ? ('领导力：' + used + '/' + cap) : '小贴士：出阵幻兽将在战斗中使用特技协助你！');
    }
    for (let i = 0; i < 3; i++) {
      const pet = list.find((p) => p.key === teamDraft[i]);
      paintPetCell(view, 'c' + (i + 1), pet, container, () => {
        const choices = list.filter((p) => !teamDraft.includes(p.key) || p.key === teamDraft[i]);
        choosePet('请选择出阵召唤兽', choices, (picked) => {
          const next = teamDraft.slice(); next[i] = picked.key;
          const need = list.filter((p) => next.includes(p.key)).reduce((n, p) => n + p.leadership, 0);
          if (need > cap) { toast('领导力不足（需要 ' + need + ' / 当前 ' + cap + '）'); return; }
          teamDraft = next;
          openPage('beast-team');
        }, () => openPage('beast-team'), '点击格子选择；清空按钮可重新编队');
      });
    }
    wireClickable(clipOf(view, 'button1'), () => {
      teamDraft = [];
      openPage('beast-team');
    });
    wireClickable(clipOf(view, 'button2'), () => {
      const r = State.setPetTeam(teamDraft.filter(Boolean));
      toast(r.ok ? ('编队已保存：领导力 ' + r.need + '/' + r.cap) : r.msg);
      if (r.ok) openPage('beast');
    });
    wireClickable(clipOf(view, 'button3'), backBeast);
  }


  function wireBeastFeed(view, page, container) {
    preparePetPage(view, 'cc c1 c2 c3 text1 button1 button2');
    const list = ensureSelectedPet();
    const pet = list.find((p) => p.key === selectedPetKey);
    if (!pet) { wireClickable(clipOf(view, 'button2'), backBeast); return; }
    const team = (State.state() || {}).petsTeam || [];
    feedDraft = feedDraft.filter((k) => k !== pet.key && !team.includes(k) && list.some((p) => p.key === k));
    const materials = feedDraft.map((k) => list.find((p) => p.key === k)).filter(Boolean);
    setTextByName(view, 'text1', materials.length ? ('已选食材：' + materials.length + '/3　确认后按实际材料结算') : '请选择食材（最多3只，出阵幻兽不会被消耗）');
    paintPetCell(view, 'cc', pet, container);
    for (let i = 0; i < 3; i++) paintPetCell(view, 'c' + (i + 1), materials[i], container, () => {
      const choices = list.filter((p) => p.key !== pet.key && !team.includes(p.key) && (!feedDraft.includes(p.key) || p.key === feedDraft[i]));
      choosePet('食材选择', choices, (picked) => {
        feedDraft[i] = picked.key;
        feedDraft = feedDraft.filter(Boolean);
        openPage('beast-feed');
      }, () => openPage('beast-feed'), '喂养会消耗所选幻兽，费用和经验按实际材料结算');
    });
    wireClickable(clipOf(view, 'button1'), () => {
      if (!feedDraft.length) { toast('当前还没有选择食材'); return; }
      const r = State.feedPet(pet.key, feedDraft);
      toast(r.ok ? ('喂养成功：' + r.target.name + ' 获得' + r.gained + '经验，消耗 ' + r.gold + ' 金松果') : r.msg);
      if (r.ok) { feedDraft = []; openPage('beast-detail'); }
    });
    wireClickable(clipOf(view, 'button2'), backBeast);
  }



  function chooseEvolveSlot(index) {
    const slots = normalizeEvolveDraft();
    const list = statePets();
    const byKey = new Map(list.map((p) => [p.key, p]));
    const team = new Set((State.state() || {}).petsTeam || []);
    const target = byKey.get(slots[0]);
    if (index > 0 && !target) { toast('请先选择第 1 格的目标幻兽'); return; }
    const used = new Set(slots.filter((k, i) => i !== index && k));
    // 第 1 格是目标：出战中的幻兽也可以当目标（进化后会留在队伍里）；
    // 后两格是材料，出战幻兽不能当材料。
    let choices = index === 0 ? list.slice() : list.filter((p) => !team.has(p.key));
    if (index > 0) {
      choices = choices.filter((p) => p.key !== target.key && !used.has(p.key) && p.grade === target.grade);
    }
    if (!choices.length) {
      toast(index > 0 ? '没有同星级的可用材料（出战幻兽不能当材料）' : '没有可合成的幻兽');
      return;
    }
    choosePet(index === 0 ? '选择进化目标' : '选择同星级材料', choices, (picked) => {
      if (index === 0) {
        evolveDraft[0] = picked.key;

        for (let i = 1; i < 3; i++) {
          const p = byKey.get(evolveDraft[i]);
          if (!p || p.grade !== picked.grade || evolveDraft[i] === picked.key) evolveDraft[i] = '';
        }
      } else {
        evolveDraft[index] = picked.key;
      }
      openPage('beast-evolve');
    }, () => openPage('beast-evolve'), index === 0
      ? '第1格是进化目标；后两格要选同星级材料'
      : '材料必须与目标同星级，出战幻兽不能当材料');
  }
  function wireBeastEvolve(view, page, container) {
    preparePetPage(view, 'text1 toSummons formulas button1 button3');
    const list = statePets();
    if (!list.length) { wireClickable(clipOf(view, 'button3'), backBeast); return; }
    normalizeEvolveDraft();
    const byKey = new Map(list.map((p) => [p.key, p]));
    const slots = evolveDraft.slice(0, 3);
    const pets = slots.map((k) => byKey.get(k) || null);
    const target = pets[0];
    const picked = pets.filter(Boolean).length;
    const cost = (target && window.GData && GData.PET_GRADE_COST && GData.PET_GRADE_COST[target.grade + 1]) || 200;
    const desc = !target ? '点击格子选择3只同星级幻兽\n第1格目标，后两格材料'
      : target.grade >= 4 ? '四星幻兽已是最高星级'
        : picked < 3 ? ('还需选 ' + (3 - picked) + ' 只同星级幻兽\n第1格目标，后两格材料')
          : ('本次进化将花费' + cost + '金松果\n产物：随机' + (target.grade + 1) + '星幻兽');
    setTextByName(view, 'text1', desc);
    const formulas = clipOf(view, 'formulas');
    stopAt(formulas, 3);
    for (let i = 0; i < 3; i++) paintPetCell(formulas, 'c' + (i + 1), pets[i], container, () => chooseEvolveSlot(i));
    const output = clipOf(view, 'toSummons');
    stopAt(output, 1);
    hidePetLevel(output);
    wireClickable(clipOf(view, 'button1'), async () => {
      const current = normalizeEvolveDraft();
      if (!current[0] || !current[1] || !current[2]) { toast('请先选满3只同星级幻兽'); return; }
      // 联机版：进化产物由服务端掷（async 动作）。
      const r = await StateCall('evolvePet', current[0], current.slice(1));
      toast(r.ok ? ('进化成功：' + r.pet.name + '（' + r.pet.grade + '★）') : r.msg);
      if (r.ok) {
        evolveDraft = ['', '', ''];
        selectedPetKey = r.pet.key;
        openPage('beast-detail');
      }
    });
    wireClickable(clipOf(view, 'button3'), backBeast);
  }

  function backBeast() { openPage('beast'); }


  function wireWar(view, page, container) {
    const t = T();
    stopAt(clipOf(view, 'newMessage'), 2);
    const main = clipOf(view, 'main_mc');
    stopAt(main, 1);
    const left = clipOf(view, 'left');
    const right = clipOf(view, 'right');
    const showCampaignPage = (n) => {
      stopAt(main, n);
      setVisible(left, n !== 1);
      setVisible(right, n === 1);
      // 换页会重建 main_mc 的子树 → 页里那 5 个 BOSS 可能是新实例（也可能被复用），
      // ⚠ 这里以前要传一份 `skipBosses`（"BOSS 要响应悬停切帧，别钉它们"）—— 那是
      if (t) t.freezeDescendants(main);
      if (main) for (let i = 1; i <= 5; i++) wireClickable(clipOf(main, 'boss' + i), () => pendingFlash(NOTE.warBoss));
    };
    if (left) { setVisible(left, false); left.playing = false; }
    if (right) right.playing = false;
    wireClickable(left, () => showCampaignPage(1), { hover: 1 });
    wireClickable(right, () => showCampaignPage(2), { hover: 1 });
    wireClickable(clipOf(view, 'button1'), () => pendingFlash(NOTE.warRecord));
    wireClickable(clipOf(view, 'button2'), backToVillage);
    showCampaignPage(1);
    // ⚠ `wireClickable` 里 `stopAt(clip, 1)` 会把 left/right 也切回第 1 帧，
    setVisible(left, false);
    setVisible(right, true);
    showNote(container, PAGES.war.note);
  }



  let seq = 0;
  async function openPage(pageId, container) {
    const id = PAGES[pageId] ? pageId : LOCATION_PAGE[pageId];
    const page = PAGES[id];
    if (!page) return false;
    if (!window.SfRender || !window.SfRender.mountSymbol) throw new Error('SfRender 未加载（缺 js/ssfight/render.js）');
    const t = T();
    if (!t) throw new Error('SfUiMain.toolkit 不在（缺 js/ssfight/ui-main.js）');
    // 挂载点：调用方给的容器 → 当前场景的容器 → `#ui`（真的从别处直接深链进来时用）。
    // ⚠ 必须在 `destroyView()` 之前定下来（那一步会把 `current` 清掉）。
    let host = container || (current && current.container);
    if (!host) {
      const ui = document.getElementById('ui');
      if (ui) {
        ui.innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠村庄·地点"></section>';
        host = ui.querySelector('.ssfight-home');
      }
    }
    if (!host) return false;
    const mine = ++seq;
    const nextBundle = bundleList(page);
    destroyView(nextBundle);
    await Promise.all(nextBundle.map((b) => SfRender.loadExtra(b)));
    if (mine !== seq || host.isConnected === false) return false;
    const view = await SfRender.mountSymbol(host, page.symbol, { frame: page.frame, label: page.title });
    if (mine !== seq || host.isConnected === false) {
      try { view.destroy(); } catch (e) {}
      return false;
    }
    current = { key: id, page: page, view: view, container: host };

    t.freezeDescendants(view);

    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    try { page.wire(view, page, host); } catch (e) { if (window.__errs) window.__errs.push('village ' + id + ': ' + e.message); }
    return true;
  }


  function bundleList(page) {
    return Array.isArray(page && page.bundle) ? page.bundle : (page && page.bundle ? [page.bundle] : []);
  }
  function destroyView(keepBundles) {
    const keep = new Set(keepBundles || []);
    if (current && current.container) {
      clearPetArt(current.container);
      const note = current.container.querySelector('.ssfight-note');
      if (note && note.__hide) clearTimeout(note.__hide);
    }
    if (current && current.view) { try { current.view.destroy(); } catch (e) {} }
    if (current && window.SfRender && SfRender.releaseExtra) {
      for (const file of bundleList(current.page)) if (!keep.has(file)) SfRender.releaseExtra(file);
    }
    current = null;
  }
  function destroy() {
    seq++;
    destroyView();
  }

  window.SfVillage = {

    open: (container, key) => openPage(key, container),
    openPage: (id) => openPage(id),
    destroy: destroy,

    current: () => (current ? { key: current.key, symbol: current.page.symbol, frame: current.page.frame } : null),

    view: () => (current ? current.view : null),
    PAGES: PAGES,
    LOCATION_PAGE: LOCATION_PAGE,
  };
})();
