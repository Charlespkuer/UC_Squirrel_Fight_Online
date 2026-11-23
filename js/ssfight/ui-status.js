// Classic status, weapon and skill tabs (symbol 7218, frames 1/2/3).
(function () {
  'use strict';


  const T = () => (window.SfUiMain && window.SfUiMain.toolkit) || null;
  const S = () => (window.State && State.state && State.state()) || null;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 原版四维的名字与显示顺序（第 1 帧里四个 4315 数字精灵的实例名，导出数据实测）：
  // ⚠ 第 4 格画的是「命」（生命值）。原版那一行是
  // 而复刻 `State.totalStats()` 返回的四个字段就叫 `power/agility/speed/hp`
  const STATS = [
    ['power', 'power'],
    ['agility', 'agility'],
    ['speed', 'speed'],
    ['hp', 'hp'],
  ];


  const FACE_PARTS = [
    { type: 0, cells: [['mc_head', 0]] },
    { type: 1, cells: [['mc_fistL', 0], ['mc_fistR', 1]] },
    { type: 2, cells: [['mc_body', 0], ['mc_handL', 1], ['mc_handR', 1]] },
    { type: 3, cells: [['mc_footL', 0], ['mc_footR', 0]] },
  ];

  let containerIds = null;
  let portraitContainerIds = null;

  // `expNum`（7182）是文本字段，落点由 render.js 的字段框公式算；这里在它自己的局部坐标里
  // 再上移 `EXP_DY` 个舞台单位（局部 = 舞台，这个字段的放置矩阵是 1:1 的平移）。
  const EXP_DY = -1.6;
  function nudgeExp(view) {
    const c = clipOf(view, 'expNum');
    const g = c && (c.g || c);
    if (!g || !g.querySelectorAll) return;
    for (const t of g.querySelectorAll('text')) {
      if (t.__expBaseY == null) t.__expBaseY = Number(t.getAttribute('y') || 0);
      t.setAttribute('y', t.__expBaseY + EXP_DY);
    }
  }

  let current = null;

  const friendView = () => !!(current && current.friend);
  const Friend = () => (current && current.friend) || null;
  // 勇者模式：同一颗状态页 7218，换一份数据源
  // （状态 / 武器 / 技能三个页签 + 查看/更换装备），不要另造一套 DOM。
  const HERO_PICK_LIMIT = 3;
  const heroView = () => !!(current && current.hero);
  const Hero = () => (current && current.hero) || null;
  const heroPickKey = (kind, id) => String(kind) + ':' + Number(id);
  function heroPickSet() {
    const set = new Set();
    for (const it of ((heroView() && Hero().picks) || [])) {
      if (it && it.kind && Number(it.id) > 0) set.add(heroPickKey(it.kind, it.id));
    }
    return set;
  }
  function heroPickCount() { return heroPickSet().size; }
  function heroStartEnabled() {
    const hero = Hero();
    return !!(hero && hero.mode === 'setup' && heroPickSet().size >= HERO_PICK_LIMIT);
  }

  function leaveFriendView() {
    const back = (current && current.backTo) || null;
    destroy();
    if (typeof back === 'function') { back(); return; }
    if (window.UI && UI.runAction) UI.runAction('challenge');
  }
  // 「查看装备」：原版 `friendEquipsInfo()`（:13821）= 库元件「状态1」的第 7 帧。
  // （数据是真的，版式是复刻的）。⚠ 定义在这里（文件后段）而不是紧挨着调用点 ——
  // `openFriendGearsOverlay` 是函数声明、靠"就近"容易看漏它与 `detailHost` 的依赖。
  function openFriendGears() {
    if (!Friend()) return;
    try { openFriendGearsOverlay(); } catch (e) { if (window.__errs) window.__errs.push('friendGears: ' + (e && e.message)); }
  }


  const clipOf = (host, name) => (host && host.byName ? host.byName(name) : null);
  // 让元件停在某一帧（不自己播）。状态页的按钮/格子都是"状态精灵"，只能停帧不能 play。
  function stopAt(clip, n) {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(n); } catch (e) {}
  }
  function setTextByName(host, name, str, opts) {
    const t = T();
    const n = clipOf(host, name);
    if (t && n) t.setText(n, str, opts);
    return n;
  }

  function refreshShell(clip) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    t.freezeDescendants(clip);
  }

  function wireClickable(clip, spec) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    spec = spec || {};
    const idleOf = () => (typeof spec.idle === 'function' ? spec.idle() : (spec.idle == null ? 1 : spec.idle));
    clip.__pinFrame = null;
    if (clip.__statusWired) {
      clip.__statusFire = spec.onFire;
      clip.__statusIdle = idleOf;
      pinIdle(clip);
      refreshShell(clip);
      return;
    }
    clip.__statusWired = true;
    clip.__statusFire = spec.onFire;
    clip.__statusIdle = idleOf;
    pinIdle(clip);
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    t.measureHitBox(clip);
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    clip.g.addEventListener('mouseenter', () => {
      if (!spec.hover) return;
      setPinned(clip, spec.hover);
      refreshShell(clip);
    });
    clip.g.addEventListener('mouseleave', () => { pinIdle(clip); refreshShell(clip); });
    clip.g.addEventListener('click', (e) => {
      e.stopPropagation();

      if (spec.press) t.pressFlash(clip, idleOf(), () => { pinIdle(clip); refreshShell(clip); },
        (f) => setPinned(clip, f));
      if (clip.__statusFire) clip.__statusFire();
    });
  }

  function setPinned(clip, frame) {
    if (!clip || !clip.gotoAndStop) return;
    const want = Math.max(1, Math.round(Number(frame) || 1));
    clip.__pinFrame = null;
    if (clip.frame !== want - 1) { try { clip.gotoAndStop(want); } catch (e) {} }
    clip.playing = false;
  }

  function pinIdle(clip) {
    if (!clip || !clip.__statusIdle) return;
    setPinned(clip, clip.__statusIdle());
  }

  function settleStatusButton(clip) {
    if (!clip || !clip.__statusIdle) return;
    if (clip.frame !== clip.__statusIdle() - 1) refreshShell(clip);
    pinIdle(clip);
  }

  function setVisible(clip, on) {
    if (clip && clip.g) clip.g.style.visibility = on ? '' : 'hidden';
  }


  // 切页签会换掉 7218 的 mc_* 实例；新实例没有挂件，但装备帧号签名可以完全一样。
  // 签名里带上宿主身份，换实例就重挂，宿主没换仍跳过每秒一次的 188 帧容器重跑。
  let dressHostSeq = 0;
  function dressHostKey(clip) {
    if (!clip) return 0;
    if (!clip.__dressHostKey) clip.__dressHostKey = ++dressHostSeq;
    return clip.__dressHostKey;
  }

  function dressParts(view, byType) {
    if (!view || !portraitContainerIds) return 0;
    // 每秒的 fillValues 只有数值会变；立绘帧号没变就不 detach/attach ——
    // 每次 attachChild 都会重跑 188 帧的容器，8 个部位就是每秒一次可见停顿。
    const sig = FACE_PARTS.map((row) => {
      const gear = byType[row.type];
      const info = gear ? wearInfo(gear) : null;
      return info ? info.frame : 0;
    }).join(',') + '|'
      + FACE_PARTS.map((row) => row.cells.map((pair) => dressHostKey(clipOf(view, pair[0]))).join(',')).join(';');
    if (view.__dressSig === sig) return 0;
    view.__dressSig = sig;
    let n = 0;
    for (const row of FACE_PARTS) {
      const gear = byType[row.type];
      const info = gear ? wearInfo(gear) : null;
      for (const pair of row.cells) {
        const clip = clipOf(view, pair[0]);
        if (!clip || !clip.detachAll) continue;
        clip.detachAll();
        if (!info) continue;
        const sym = portraitContainerIds[row.type] && portraitContainerIds[row.type][pair[1]];
        if (!sym) continue;
        if (clip.attachChild(sym, info.frame, 'wear')) n++;
      }
    }
    return n;
  }

  let frameTable = null;

  let orangeFrameTable = null;
  function gearToneKey(type, name) { return Number(type) + '|' + String(name || ''); }
  function wearInfo(gear) {
    if (!frameTable) return null;
    const base = frameTable.get(Number(gear.id));
    if (!base) return null;
    // 强化等级加成：原版 `_loc5 += (max(addr1Lv,addr2Lv,addr3Lv) - 1)`（有强化才加）。
    // ⚠ `gear.ext` 是附加属性数组（`[{id, level}]`），对它做 `Number()` 得 `NaN` ——
    const orange = gear.orange === true || Number(gear.quality) > 3;
    const orangeFrame = orange && orangeFrameTable ? orangeFrameTable.get(Number(gear.id)) : 0;

    const raw = gear.ext;
    let extMax = Array.isArray(raw)
      ? raw.reduce((m, e) => Math.max(m, Number(e && e.level) || 0), 0)
      : Math.max(0, Number(raw) || 0);
    extMax = Math.max(0, Math.min(3, extMax));
    const addr = (Number(gear.type) === 0 || Number(gear.type) === 1) && extMax > 0 ? extMax - 1 : 0;
    const frame = (orangeFrame || base) + addr;
    return { frame: frame, orange: !!orange };
  }
  async function loadFrameTable() {
    if (frameTable && containerIds && portraitContainerIds) return frameTable;
    const j = (f) => SfRender.loadTable(f).catch(() => null);
    const [r, slots] = await Promise.all([j('gear-frames.json'), j('gear-slots.json')]);
    if (r && !frameTable) {
      frameTable = new Map(r.gear.map((g) => [Number(g.id), g.frame]));

      const q4 = new Map();
      for (const g of r.gear) if (Number(g.quality) === 4) q4.set(gearToneKey(g.type, g.name), g.frame);
      orangeFrameTable = new Map();
      for (const g of r.gear) {
        if (Number(g.quality) !== 3) continue;
        const f = q4.get(gearToneKey(g.type, g.name));
        if (f) orangeFrameTable.set(Number(g.id), f);
      }
    }
    if (slots && !containerIds) {
      containerIds = {};
      for (const c of slots.container || []) containerIds[c.type] = c.ids;
    }
    if (slots && !portraitContainerIds) {
      portraitContainerIds = {};
      for (const c of slots.portraitContainer || []) portraitContainerIds[c.type] = c.ids;
    }
    return frameTable;
  }



  function showBigNumber(num, mc1, mc2) {
    const t = T();
    if (!t) return;
    const n = Math.max(0, Math.round(Number(num) || 0));
    if (n < 10000) {
      if (mc1) t.showNumber(n, mc1, 0, 0, 'left');
      setVisible(mc2, false);
      return;
    }
    setVisible(mc2, true);

    const highDigits = n > 9999999 ? 4 : n > 999999 ? 3 : n > 99999 ? 2 : 1;
    const p = Math.pow(10, highDigits);
    const low = n % p, hi = Math.floor(n / p);
    if (mc1) t.showNumber(hi, mc1, 0, 0, 'right');
    // 低位补几个前导 0（原版 `showZero = highDigits - lowDigits`），否则 10005 会显示成 "1  5"
    const lowDigits = low > 999 ? 4 : low > 99 ? 3 : low > 9 ? 2 : low > 0 ? 1 : 0;
    if (mc2) t.showNumber(low, mc2, 0, Math.max(0, highDigits - lowDigits), 'left');
  }

  function fillValues(view) {
    const s = S();
    const t = T();
    if (!s || !t) return;
    // 数据源：自己的话读存档；查看别人时整份换成对手那一套
    const foe = Friend();
    const hero = Hero();
    const other = foe || hero;

    const hs = hero ? ((typeof hero.stats === 'function' ? hero.stats() : hero.stats) || {}) : null;
    const src = foe ? {
      name: foe.name, level: Math.max(1, Math.round(Number(foe.level) || 1)),
      exp: 0, nextExp: 0, dailyWins: 0, dailyFails: 0, allWins: 0, allFails: 0,
      power: Number(foe.power) || 0, agility: Number(foe.agility) || 0,
      speed: Number(foe.speed) || 0, hp: Number(foe.hp) || 0,
    } : hero ? {
      name: '勇者', level: 1, exp: 0, nextExp: 0,

      dailyWins: Math.max(0, Number(hero.wins) || 0), dailyFails: 0,
      allWins: Math.max(0, Number(hero.wins) || 0), allFails: 0,
      power: Number(hs && hs.power) || 0,
      agility: Number(hs && hs.agility) || 0,
      speed: Number(hs && hs.speed) || 0,
      hp: Number(hs && (hs.maxHp || hs.hp)) || 0,
    } : s;
    const main = clipOf(view, 'main_mc') || view;
    const nextExp = other ? 0 : Math.max(1, (window.GData && GData.nextExp) ? GData.nextExp(s.level) : (s.nextExp || 1));

    // 经验条 `expMc`：101 帧（第 N 帧 = 蒙版右移 N×0.95），照村庄页 `refreshValues` 同一条公式。
    // 等级冻结时经验会超过本级需求：条收满，数字仍按真实 exp/need 显示（这里不做 99.9% 截断）。
    // 看别人时原版也没有他的经验数据（服务端有 `exp`，这里的对手对象没有）→ 条收空、数字清空。
    const ePct = other ? 0 : Math.ceil(s.exp * 100 / Math.max(1, nextExp));
    stopAt(main.byName ? main.byName('expMc') : null, s.exp >= nextExp && !other ? 101 : Math.max(1, Math.min(101, ePct + 1)));

    setTextByName(view, 'expNum', other ? '' : (s.exp + '/' + nextExp));


    const wins = Number(src.dailyWins) || 0, fails = Number(src.dailyFails) || 0;
    const fights = wins + fails;
    const rate = fights > 0 ? Math.ceil(wins * 100 / fights) : 100;
    const rateClip = clipOf(view, 'winRate');
    if (rateClip) t.showNumber(rate, rateClip, 0, 0, 'right');
    const allFights = (Number(src.allWins) || 0) + (Number(src.allFails) || 0);
    showBigNumber(allFights, clipOf(view, 'fightTimes1'), clipOf(view, 'fightTimes2'));


    const stats = other
      ? { power: src.power, agility: src.agility, speed: src.speed, hp: src.hp }
      : ((State.totalStats && State.totalStats()) || {});
    for (const row of STATS) {
      const c = clipOf(view, row[0]);
      if (c && window.SfUiMain && SfUiMain.showNumber) {
        SfUiMain.showNumber(Math.max(0, Math.round(Number(stats[row[1]]) || 0)), c, 0, 0, 'left', 4);
      }
    }


    settleStatusButton(clipOf(view, 'b_change'));
    settleStatusButton(clipOf(view, 'b_fusion'));


    let worn = [];
    if (foe) worn = Array.isArray(foe.gears) ? foe.gears : [];
    else if (hero) {

      worn = (Array.isArray(hero.appearance) ? hero.appearance : []).map((raw) => {
        const item = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
        const id = Number(item.id);
        if (!(id > 0)) return null;
        const type = Number(item.type != null ? item.type : (State.gearPart ? State.gearPart(id) : NaN));
        if (!Number.isFinite(type)) return null;
        return { id: id, type: type, ext: Array.isArray(item.ext) ? item.ext : [] };
      }).filter(Boolean);
    } else { try { worn = (State.myGears ? State.myGears() : []).filter((g) => g && g.used); } catch (e) { worn = []; } }
    const byType = [];
    for (const g of worn) {
      const ty = Number(g.type != null ? g.type : (State.gearPart ? State.gearPart(g.id) : NaN));
      if (!Number.isFinite(ty)) continue;
      if (byType[ty] === undefined) byType[ty] = g.type == null ? Object.assign({}, g, { type: ty }) : g;
    }
    dressParts(view, byType);

    nudgeExp(view);
  }

  // ⚠ 历史上这里有一个 `valueClips()`，作用是"把数值精灵连子树一起排除在钉帧之外"。

  // 武器 / 技能栏（原版页元件 7218 的第 2、3 帧）
  // 后续追加："武器与技能的贴图大小和位置不对，进行靠齐；贴图不要再使用旧素材，
  // ⚠ 名字→元件 id 必须走 `swfSymbolIds()`（读 SWF 自己配对）；那张
  const PAGE_FRAME = { status: 1, weapons: 2, skills: 3 };
  const GRID_CELLS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];


  function activeTab() { return current ? current.tab : 'status'; }
  function gridKind() { return activeTab() === 'skills' ? 'skill' : 'weapon'; }
  function gridInfo() {
    const C = window.UI && UI.classic;
    if (!C || !C.catalogInfo || !current) return null;

    const foe = Friend();
    if (foe) return friendGridInfo(foe, gridKind(), current.gridPage || 0);
    if (heroView()) return heroGridInfo(gridKind(), current.gridPage || 0);
    return C.catalogInfo(gridKind(), current.gridPage || 0);
  }
  // 把对手那一串 `["id:level", …]` 摊成状态页格子要的 `{items, page, pages}`。
  // ⚠ 图标必须自己补：`UI.classic.catalogItems()` 只给字典条目（id / 名字），
  // 那条路，所以要照 `catalogInfo` 的做法补一次，否则格子是空的（本批实测踩过）。
  function friendGridInfo(foe, kind, pg) {
    const C = window.UI && UI.classic;
    if (!C || !C.catalogItems) return null;
    const base = C.catalogItems(kind) || [];
    const own = (kind === 'skill' ? (foe.skills || []) : (foe.weapons || [])).map((w) => {
      if (w && typeof w === 'object') return { id: Number(w.id), level: Math.max(1, Number(w.level) || 1) };
      const parts = String(w).split(/[:,]/);
      return { id: Number(parts[0]), level: Math.max(1, Number(parts[1]) || 1) };
    });
    const items = base.map((it) => {
      const has = own.find((x) => x.id === it.id) || null;
      return {
        id: it.id, name: it.name, has: !!has,
        level: has ? has.level : 0,
        trueForm: !!has && Number(has.level) > 10,
        selected: false,
        label: '',
        icon: C.wsIconOf ? C.wsIconOf(kind, it.id) : null,

        lockedIcon: C.wsIconOf ? C.wsIconOf(kind, it.id, true) : null,
      };
    });
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.max(0, Math.min(pages - 1, pg | 0));
    return { items: items.slice(page * 10, page * 10 + 10), page: page, pages: pages };
  }
  // 勇者模式的武器 / 技能格：清单来自 `TowerHero.catalog()`（与准备页的可选范围同一份），
  // ⚠ 未点亮的项也要给 `lockedIcon`：`paintCell` 只认 `it.has ? it.icon : it.lockedIcon`，
  function heroGridInfo(kind, pg) {
    const C = window.UI && UI.classic;
    if (!current || !C || !C.wsIconOf || !window.TowerHero || typeof TowerHero.catalog !== 'function') return null;
    const hero = Hero();
    const base = TowerHero.catalog().filter((it) => it.kind === kind);
    const startLevel = Math.max(1, Number(window.TowerHero && TowerHero.CONFIG && TowerHero.CONFIG.startLevel) || 5);
    const picked = heroPickSet();
    const levels = new Map();
    for (const raw of ((kind === 'weapon' ? hero.weapons : hero.skills) || [])) {
      const parts = String(raw).split(/[:,]/);
      const id = Number(parts[0]);
      if (id > 0) levels.set(id, Math.max(levels.get(id) || 1, Number(parts[1]) || 1));
    }
    const items = base.map((it) => {
      const id = Number(it.id);
      const has = hero.mode === 'setup' ? picked.has(heroPickKey(kind, id)) : levels.has(id);
      const level = hero.mode === 'setup' ? (has ? startLevel : 0) : (levels.get(id) || 0);
      return {
        id: id, name: it.name || '', has: has, level: level,
        trueForm: hero.mode !== 'setup' && level > 10,
        selected: hero.mode === 'setup' && has,
        label: '',
        icon: C.wsIconOf(kind, id),
        lockedIcon: C.wsIconOf(kind, id, true),
      };
    });
    const pages = Math.max(1, Math.ceil(items.length / 10));
    const page = Math.max(0, Math.min(pages - 1, pg | 0));
    return { items: items.slice(page * 10, page * 10 + 10), page: page, pages: pages };
  }

  function heroTogglePick(kind, id) {
    const hero = Hero();
    if (!hero || hero.mode !== 'setup') return { ok: false };
    const key = heroPickKey(kind, id);
    const list = (Array.isArray(hero.picks) ? hero.picks : []).map((it) => ({ kind: it.kind, id: Number(it.id) }));
    const at = list.findIndex((it) => heroPickKey(it.kind, it.id) === key);
    if (at >= 0) list.splice(at, 1);
    else if (list.length >= HERO_PICK_LIMIT) {
      return { ok: false, msg: '最多点亮 ' + HERO_PICK_LIMIT + ' 个武技；先点暗一个再换。' };
    } else list.push({ kind: kind, id: Number(id) });
    hero.picks = list;
    if (typeof hero.onPicks === 'function') hero.onPicks(list.map((it) => Object.assign({}, it)));
    if (list.length === HERO_PICK_LIMIT && window.UI && UI.toast) {
      UI.toast('已点亮 ' + HERO_PICK_LIMIT + ' 个武技；回「状态」页点「开始挑战」出发。');
    }

    try { if (current && current.view) fillValues(current.view); } catch (e) {}
    try { applyTab(); } catch (e) { if (window.__errs) window.__errs.push('hero pick: ' + (e && e.message)); }
    refreshHeroChrome();
    return { ok: true };
  }
  // 单元格子上要显示的东西。
  // ⚠ 顺序必须是 先摆帧、再挂内容：`showFrame()` 在帧号真的变了的时候会
  // · 等级文字是真的文本字段（占位串 "Lv99"），原版由 `loadWeaponSkill` 的
  const ICON_LABEL_Y = 43;
  function localY(ma) {
    if (!ma) return 0;
    const a = String(ma).split(',');
    return a.length >= 6 ? (Number(a[5]) || 0) : 0;
  }
  function paintCell(cell, kind, it) {
    if (!cell || !cell.detachAll) return;
    // 原版 `showWeaponSkills`：有内容的格子 `gotoAndStop(2)`（内容帧），空槽 `gotoAndStop(1)`。
    // ⚠ 实测 `tags-status.json` 里格子元件 3636 只有 2 帧（f1 = 卡片画稿 3635 / f2 = 空），
    stopAt(cell, it ? 1 : (cell.frameCount ? cell.frameCount() : 2));
    // ⚠ 内容没变就别重挂：`fillValues()` 每秒会调一次 `applyTab()`，而每挂一颗图标都要
    const sel = !!(it && it.has && it.selected), tru = !!(it && it.trueForm);
    const sig = it ? [it.id, it.has ? 1 : 0, it.level, it.has ? it.icon : it.lockedIcon, tru ? 1 : 0, sel ? 1 : 0].join(':') : '';
    if (cell.__artSig === sig) return;
    cell.__artSig = sig;
    cell.detachAll();
    if (!it || !(it.has ? it.icon : it.lockedIcon)) return;
    // ⚠ 没获得的那一档是另一颗库元件（`it.lockedIcon` = 原版的名字 + "1"）：
    const clip = cell.attachChild(it.has ? it.icon : it.lockedIcon, sel ? 2 : 1, 'icon');
    if (!clip || !clip.g) return;

    if (!it.has && it.lockedIcon === it.icon) clip.g.classList.add('locked');
    if (it.has) dressIcon(clip, it, sel);
    else { paintIconLabel(clip, false, false); writeIconLevel(clip, it, false); }
  }

  function raiseAttached(host) {
    if (!host || !host.__attached || !host.__attached.length) return;
    const shell = host.g.querySelector(':scope > g.uc-pop') || host.g;
    for (const c of host.__attached) if (c.g && c.g.parentNode === shell) shell.appendChild(c.g);
  }

  function cellIconClip(cell) {
    for (const c of (cell && cell.__attached) || []) {
      if (c.g && c.g.getAttribute && c.g.getAttribute('attach-name') === 'icon') return c;
    }
    return null;
  }
  // 把一颗图标摆到"选中 / 常态"那一档：图标帧 + 名字/印章层帧 + 等级文字，一次到位。
  // ⚠ 选中时等级文字要让位：原版那张矢量名字（2137 那一类）压在卡片下方、和 `level`
  // 字段同一行（实测原版截图里选中那一格只有名字、没有 "LV1"）。
  function dressIcon(clip, it, sel) {
    if (!clip || !it) return;
    stopAt(clip, sel ? 2 : 1);
    paintIconLabel(clip, sel, !!it.trueForm);
    writeIconLevel(clip, it, sel);
  }
  // 把格子的外观切到"选中 / 悬停"那一档（只拨帧，不重建实例）。
  // ⚠ 未获得的那一档同样走这条路（用户 2026-10 口径："悬停未解锁的也显示名称，
  function setCellLook(cell, it, hovered) {
    if (!cell || !it) return false;
    const clip = cellIconClip(cell);
    if (!clip) return false;
    dressIcon(clip, it, !!it.selected || !!hovered);
    return true;
  }
  // 拨"卡片下方那一条"（名字 / 「真」印章）的帧，见 `paintCell` 的四档表。
  // ⚠ 判据用放置自己的局部 y（写在 `__baseMa` 里），不要用"实测包围盒占整体的比例"：
  // 有八个还挂着名字"就是这么来的）。`level` 那个文本字段留着不动（`writeIconLevel` 要写它）。
  function paintIconLabel(clip, selected, trueForm) {
    if (!clip || !clip.nodes) return;
    const frame = (selected ? (trueForm ? 2 : 1) : (trueForm ? 3 : 4));
    for (const rec of clip.nodes.values()) {
      if (/^level$/i.test(rec.na || '')) continue;
      if (localY(rec.node && rec.node.__baseMa) < ICON_LABEL_Y) continue;
      if (!rec.clip) continue;
      stopAt(rec.clip, frame);
    }
  }

  function writeIconLevel(clip, it, hide) {
    const g = clip && clip.g;
    if (!g || !g.querySelectorAll) return;
    const lv = Number(it.level) || 0;
    const text = (hide || !it.has || lv <= 0) ? '' : ('LV' + (lv > 10 ? lv - 10 : lv));
    for (const t of g.querySelectorAll('text')) t.textContent = text;
  }

  function showGridParts(on) {
    const view = current && current.view;
    if (!view) return;
    for (const n of GRID_CELLS.concat(['left', 'right', 'page'])) {
      const c = clipOf(view, n);
      const g = c && (c.g || c);
      if (g && g.style) g.style.visibility = on ? '' : 'hidden';
      if (g && g.style) g.style.display = on ? '' : 'none';
    }
  }
  // 勇者模式的按钮层 —— 把「装备融合」那一位换成「开始挑战」
  // ⚠ 状态页只有第 1 帧有这两颗键；武器 / 技能页要 `display:none`，否则会压在卡片上。
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const HERO_START_AT = { x: 268, y: 112.8, s: 0.7, sx: 0.64 };

  const HERO_TODO_BOX = { x: 148, y: 36, w: 150, h: 60, r: 7 };
  const HERO_TODO_FACTS = [
    { key: 'picks', x: 153, w: 43, label: '武技' },
    { key: 'stats', x: 199, w: 43, label: '四维' },
    { key: 'gears', x: 245, w: 43, label: '外观' },
  ];

  function heroChromeText(x, y, size, fill, weight, anchor) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x)); text.setAttribute('y', String(y));
    text.setAttribute('font-size', String(size)); text.setAttribute('fill', fill);
    text.setAttribute('font-weight', weight || '700');
    text.setAttribute('text-anchor', anchor || 'start');
    text.setAttribute('font-family', '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif');
    text.setAttribute('stroke', '#fff6df');
    text.setAttribute('stroke-width', '1.6');
    text.setAttribute('stroke-linejoin', 'round');
    text.setAttribute('paint-order', 'stroke');
    return text;
  }
  function heroSvgRect(x, y, w, h, r, fill, stroke, strokeWidth) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
    rect.setAttribute('rx', String(r == null ? 6 : r));
    rect.setAttribute('fill', fill); rect.setAttribute('stroke', stroke || 'none');
    if (strokeWidth) rect.setAttribute('stroke-width', String(strokeWidth));
    return rect;
  }

  function heroTodoEnsure(view) {
    let g = view.__heroTodo;
    if (g && g.isConnected) return g;
    g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('pointer-events', 'none');
    g.setAttribute('class', 'sf-hero-todo');
    const box = HERO_TODO_BOX;
    g.appendChild(heroSvgRect(box.x, box.y, box.w, box.h, box.r, '#fff9e9', '#d8bd86', 1.6));
    g.appendChild(heroSvgRect(box.x + 3, box.y + 3, box.w - 6, box.h - 6, box.r - 2, 'none', '#fffdf7', 1));
    const title = heroChromeText(box.x + 9, box.y + 12, 8.4, '#3d654e', '800', 'start');
    title.textContent = '出发准备';
    const badge = heroChromeText(box.x + box.w - 8, box.y + 11.6, 5.2, '#a37735', '700', 'end');
    badge.textContent = '勇者剧本';
    g.appendChild(badge);
    const facts = [];
    for (const f of HERO_TODO_FACTS) {
      g.appendChild(heroSvgRect(f.x, box.y + 16, f.w, 18, 4, '#fffdf6', '#e6d4ac', 1));
      const label = heroChromeText(f.x + 4, box.y + 21.5, 4.6, '#9a7b4e', '700', 'start');
      label.textContent = f.label;
      const value = heroChromeText(f.x + 4, box.y + 30.5, 6.8, '#3d654e', '800', 'start');
      value.textContent = '—';
      g.appendChild(label); g.appendChild(value);
      facts.push({ key: f.key, value: value });
    }

    g.appendChild(heroSvgRect(box.x + 9, box.y + 38, box.w - 18, 3.6, 2, '#eadfc6', '#dccbaa', 0.6));
    const meter = heroSvgRect(box.x + 9, box.y + 38, 0, 3.6, 2, '#7fb84d', 'none', 0);
    g.appendChild(meter);
    const footer = heroChromeText(box.x + box.w / 2, box.y + 51, 5.6, '#b06b1f', '700', 'middle');
    footer.textContent = '';
    g.appendChild(footer);
    g.appendChild(title);
    g.__facts = facts; g.__meter = meter; g.__footer = footer;
    view.g.appendChild(g);
    view.__heroTodo = g;
    return g;
  }
  function heroTodoRefresh(view) {
    const hero = Hero();
    let g = view.__heroTodo;
    // 出发准备只属于「状态」页；切到武器 / 技能必须消失。
    if (!hero || hero.mode !== 'setup' || activeTab() !== 'status') { if (g) g.style.display = 'none'; return; }
    g = heroTodoEnsure(view);
    g.style.display = '';
    const picks = heroPickCount();
    const state = heroStatState();
    const pool = state ? Math.max(0, Number(state.pool) || 0) : 0;
    const gears = heroGearSlots().filter((id) => Number(id) > 0).length;
    const ready = picks >= HERO_PICK_LIMIT && pool === 0;
    const values = {
      picks: picks + ' / ' + HERO_PICK_LIMIT,
      stats: pool > 0 ? ('待分 ' + pool) : '已分配',
      gears: gears + ' / 4',
    };
    for (const fact of (g.__facts || [])) {
      if (!fact.value) continue;
      fact.value.textContent = values[fact.key] || '—';
      fact.value.setAttribute('fill', fact.key === 'picks' && picks >= HERO_PICK_LIMIT ? '#2f7a4f'
        : fact.key === 'stats' && pool === 0 ? '#2f7a4f' : '#3d654e');
    }
    if (g.__meter) {
      const width = (HERO_TODO_BOX.w - 18) * Math.max(0, Math.min(1, picks / HERO_PICK_LIMIT));
      g.__meter.setAttribute('width', width.toFixed(2));
      g.__meter.setAttribute('fill', ready ? '#5ca33a' : '#8fc35d');
    }
    if (g.__footer) {
      g.__footer.textContent = picks < HERO_PICK_LIMIT
        ? ('还差 ' + (HERO_PICK_LIMIT - picks) + ' 个武技')
        : (pool > 0 ? ('还有 ' + pool + ' 点可分配') : '准备就绪，可以出发');
      g.__footer.setAttribute('fill', ready ? '#2f7a4f' : '#b06b1f');
    }
  }

  const HERO_BLADE_BOX = { x: 164, y: 38, w: 134, h: 54, r: 7 };
  function heroBladeCardEnsure(view) {
    let g = view.__heroBladeCard;
    if (g && g.isConnected) return g;
    g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('pointer-events', 'none');
    g.setAttribute('class', 'sf-hero-blade-card');
    const box = HERO_BLADE_BOX;
    g.appendChild(heroSvgRect(box.x, box.y, box.w, box.h, box.r, '#fff9e9', '#d8bd86', 1.6));
    g.appendChild(heroSvgRect(box.x + 3, box.y + 3, box.w - 6, box.h - 6, box.r - 2, 'none', '#fffdf7', 1));
    const title = heroChromeText(box.x + 9, box.y + 13, 7.6, '#3d654e', '800', 'start');
    title.textContent = '勇者之剑';
    const state = heroChromeText(box.x + box.w - 8, box.y + 12.4, 6.2, '#a37735', '700', 'end');
    state.textContent = '尚未持剑';
    const line1 = heroChromeText(box.x + 9, box.y + 27, 6.4, '#6b4a25', '700', 'start');
    line1.textContent = '';
    const line2 = heroChromeText(box.x + 9, box.y + 37, 5.2, '#6b4a25', '600', 'start');
    line2.textContent = '';
    const line3 = heroChromeText(box.x + 9, box.y + 46, 5.0, '#9a7b4e', '600', 'start');
    line3.textContent = '';
    g.appendChild(title); g.appendChild(state); g.appendChild(line1); g.appendChild(line2); g.appendChild(line3);
    g.__state = state; g.__line1 = line1; g.__line2 = line2; g.__line3 = line3;
    view.g.appendChild(g);
    view.__heroBladeCard = g;
    return g;
  }
  function heroBladeCardRefresh(view) {
    const hero = Hero();
    let g = view.__heroBladeCard;
    if (!hero || hero.mode !== 'run' || activeTab() !== 'status') { if (g) g.style.display = 'none'; return; }
    g = heroBladeCardEnsure(view);
    g.style.display = '';
    const blade = hero.blade || null;
    if (g.__state) {
      g.__state.textContent = blade ? ('破镜 ×' + blade.stacks) : '尚未持剑';
      g.__state.setAttribute('fill', blade ? '#2f7a4f' : '#a37735');
    }
    if (g.__line1) g.__line1.textContent = blade
      ? ('力量 −' + Math.round(blade.powerCut * 100) + '% · 生命上限 −' + Math.round(blade.hpCut * 100) + '%')
      : '首次巡逻胜利后可得';
    if (g.__line2) g.__line2.textContent = blade
      ? ('击败巡逻魔王成长 · 当前 ' + blade.stacks + ' / 10 层')
      : '跨百层保留 · 破镜克镜';
    if (g.__line3) g.__line3.textContent = blade
      ? '照影之境不会吞掉已成长层数'
      : '每次巡逻胜利 +1 层破镜';
  }


  function heroStartLabelEnsure(view) {
    let g = view.__heroStartLabel;
    if (!g || g.isConnected === false) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('pointer-events', 'none');
      g.setAttribute('transform', 'matrix(' + HERO_START_AT.s + ',0,0,' + HERO_START_AT.s + ',' + HERO_START_AT.x + ',' + HERO_START_AT.y + ')');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', '-1'); text.setAttribute('y', '8');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '16');
      text.setAttribute('font-family', '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif');
      text.setAttribute('font-weight', '900');
      text.setAttribute('fill', '#fffdf1');
      text.setAttribute('stroke', '#542201');
      text.setAttribute('stroke-width', '3');
      text.setAttribute('stroke-linejoin', 'round');
      text.setAttribute('paint-order', 'stroke');
      text.textContent = '开始挑战';
      g.appendChild(text);
      view.g.appendChild(g);
      view.__heroStartLabel = g;
    }
    return g;
  }
  function heroStartEnsure(view) {
    let start = view.__heroStart;
    if (start && start.g && start.g.isConnected) return start;
    try { start = view.attachChild('3911', 1, 'hero-start'); } catch (e) { start = null; }
    if (!start || !start.g) return null;
    view.__heroStart = start;
    start.g.classList.add('sf-hero-start');
    start.g.setAttribute('transform', 'matrix(' + HERO_START_AT.sx + ',0,0,' + HERO_START_AT.s + ',' + HERO_START_AT.x + ',' + HERO_START_AT.y + ')');

    const hit = start.g.querySelector('[data-hit="1"]');
    if (hit) {
      hit.setAttribute('x', '-55'); hit.setAttribute('y', '-11');
      hit.setAttribute('width', '108'); hit.setAttribute('height', '30');
    }
    return start;
  }

  function heroTrainEnsure(view) {
    let btn = view.__heroTrain;
    if (btn && btn.g && btn.g.isConnected) return btn;
    try { btn = view.attachChild('3911', 1, 'hero-train'); } catch (e) { btn = null; }
    if (!btn || !btn.g) return null;
    view.__heroTrain = btn;
    btn.g.classList.add('sf-hero-train');
    btn.g.setAttribute('transform', 'matrix(' + HERO_START_AT.sx + ',0,0,' + HERO_START_AT.s + ',' + HERO_START_AT.x + ',' + HERO_START_AT.y + ')');
    const hit = btn.g.querySelector('[data-hit="1"]');
    if (hit) {
      hit.setAttribute('x', '-55'); hit.setAttribute('y', '-11');
      hit.setAttribute('width', '108'); hit.setAttribute('height', '30');
    }
    return btn;
  }
  function heroTrainLabelEnsure(view) {
    let g = view.__heroTrainLabel;
    if (!g || g.isConnected === false) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('pointer-events', 'none');
      g.setAttribute('transform', 'matrix(' + HERO_START_AT.s + ',0,0,' + HERO_START_AT.s + ',' + HERO_START_AT.x + ',' + HERO_START_AT.y + ')');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', '-1'); text.setAttribute('y', '8');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '16');
      text.setAttribute('font-family', '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif');
      text.setAttribute('font-weight', '900');
      text.setAttribute('fill', '#fffdf1');
      text.setAttribute('stroke', '#542201');
      text.setAttribute('stroke-width', '3');
      text.setAttribute('stroke-linejoin', 'round');
      text.setAttribute('paint-order', 'stroke');
      text.textContent = '铸币修炼';
      g.appendChild(text);
      view.g.appendChild(g);
      view.__heroTrainLabel = g;
    }
    return g;
  }

  function heroTrainCandidates(hero) {
    const out = [];
    for (const kind of ['weapon', 'skill']) {
      for (const raw of ((kind === 'weapon' ? hero.weapons : hero.skills) || [])) {
        const hit = /^(\d+):(\d+)$/.exec(String(raw));
        if (!hit) continue;
        const id = Number(hit[1]), level = Math.max(1, Number(hit[2]) || 1);
        if (level >= 15 || (kind === 'skill' && [6, 13].includes(id))) continue;
        const inst = kind === 'weapon' ? State.weaponInst(id) : State.skillInst(id);
        out.push({ kind, id, level, ref: (kind === 'weapon' ? 'w:' : 's:') + id,
          name: (inst && inst.name) || ((kind === 'weapon' ? '武器 ' : '技能 ') + id) });
      }
    }
    return out;
  }
  function heroTrainLevelText(level) { return level > 10 ? '真' + (level - 10) : 'Lv.' + level; }

  function openHeroCoinTrain(hero, view) {
    if (!hero || typeof hero.onCoinTrain !== 'function') { if (window.UI && UI.toast) UI.toast('铸币修炼暂不可用。'); return; }
    if (Math.max(0, Number(hero.coins) || 0) <= 0) { if (window.UI && UI.toast) UI.toast('铸币不足（需要 1 枚）。'); return; }
    const all = heroTrainCandidates(hero);
    if (!all.length) { if (window.UI && UI.toast) UI.toast('没有可修炼的武技。'); return; }
    const modal = window.UI && UI.classic && UI.classic.modal;
    if (!modal) return;
    const rows = all.map((it) => '<button type="button" class="hero-coin-train-row" data-hero-train-ref="' + esc(it.ref) + '">' +
      '<b>' + esc(it.name) + '</b><span>' + esc(heroTrainLevelText(it.level)) + ' · 随机 +3~5 级</span><em>1 铸币</em></button>').join('');
    const m = modal('铸币修炼', '<div class="hero-coin-train-panel"><p>选择一门武技，必定提升 <b>3~5</b> 个小级（封顶真5）。' +
      '当前铸币 <b class="gold-text">' + Math.max(0, Number(hero.coins) || 0) + '</b> 枚。</p>' +
      '<div class="hero-coin-train-list">' + rows + '</div></div>', [{ label: '返回', cls: 'muted' }], { small: true });
    if (!m || !m.element) return;
    m.element.classList.add('hero-coin-train-modal');
    m.element.querySelectorAll('[data-hero-train-ref]').forEach((b) => {
      b.onclick = () => {
        const out = hero.onCoinTrain(b.dataset.heroTrainRef);
        m.close();
        if (!out || !out.ok) {
          modal('铸币修炼', '<p>' + esc((out && out.msg) || '修炼失败。') + '</p>',
            [{ label: '返回', cls: 'muted', run: () => { if (window.SfStatus && SfStatus.refresh) SfStatus.refresh(); } }], { small: true });
          return;
        }
        if (typeof out.left === 'number') hero.coins = Math.max(0, out.left);
        if (window.SfStatus && SfStatus.refresh) SfStatus.refresh();
        modal('修炼完成', '<div class="result-box"><div class="result-title win">武技精进</div><p>' + esc(out.msg) + '</p>' +
          '<p class="dim">消耗 1 枚铸币，剩余 ' + Math.max(0, Number(out.left) || 0) + ' 枚。</p></div>',
          [{ label: '继续修炼', cls: 'gold', run: () => openHeroCoinTrain(hero, view) },
           { label: '返回', cls: 'muted', run: () => { if (window.SfStatus && SfStatus.refresh) SfStatus.refresh(); } }], { small: true });
      };
    });
  }
  // 具体规则（预算 275 / 下限 55 / 上限 85）在 TowerHero；这里只画键与读 `hero.statState()`。
  const HERO_STAT_KEYS = ['power', 'agility', 'speed'];
  const HERO_STAT_NAMES = { power: '力量', agility: '敏捷', speed: '速度' };
  const HERO_STAT_CELL_RIGHT = { power: 84, agility: 153, speed: 222 };
  const HERO_STAT_ARROW_AT = { power: 66, agility: 136, speed: 207 };
  function heroStatState() {
    const hero = Hero();
    try { return (hero && typeof hero.statState === 'function') ? hero.statState() : null; } catch (e) { return null; }
  }

  function setHeroStatArrow(group, dir, enabled) {
    const btn = group && group.querySelector('[data-dir="' + dir + '"]');
    if (!btn) return;
    const rect = btn.__rect, path = btn.__path;
    btn.style.pointerEvents = enabled ? 'auto' : 'none';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    btn.style.opacity = enabled ? '1' : '.55';
    if (rect) {
      rect.setAttribute('fill', enabled ? '#fffaf0' : '#f0ece3');
      rect.setAttribute('stroke', enabled ? '#d6bd8c' : '#d8d2c6');
    }
    if (path) path.setAttribute('fill', enabled ? '#3b7255' : '#b7b0a4');
  }
  function heroStatArrowEnsure(view, stat) {
    const cache = view.__heroStatArrows || (view.__heroStatArrows = {});
    let group = cache[stat];
    if (group && group.isConnected) return group;
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'sf-hero-stat-arrow');
    group.setAttribute('data-stat', stat);
    group.setAttribute('transform', 'translate(' + HERO_STAT_ARROW_AT[stat] + ',142.5)');
    const make = (dir) => {
      const btn = document.createElementNS(SVG_NS, 'g');
      btn.setAttribute('data-dir', dir);
      btn.setAttribute('class', 'sf-hero-stat-step');
      btn.style.pointerEvents = 'auto';
      btn.style.cursor = 'pointer';
      const y = dir === 'up' ? 0 : 9;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', '0'); rect.setAttribute('y', String(y));
      rect.setAttribute('width', '10'); rect.setAttribute('height', '8');
      rect.setAttribute('rx', '2'); rect.setAttribute('fill', '#fffaf0');
      rect.setAttribute('stroke', '#d6bd8c'); rect.setAttribute('stroke-width', '0.9');
      const path = document.createElementNS(SVG_NS, 'path');
      if (dir === 'up') {
        path.setAttribute('d', 'M5 1.5 L1.4 6.4 L8.6 6.4 Z');
      } else {
        // 下键的矩形在 y=9..17，三角形也要跟着下移，否则会画到上键上。
        path.setAttribute('d', 'M5 6.5 L1.4 1.6 L8.6 1.6 Z');
        path.setAttribute('transform', 'translate(0,9)');
      }
      path.setAttribute('fill', '#3b7255');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = HERO_STAT_NAMES[stat] + (dir === 'up' ? ' +1' : ' −1');
      btn.appendChild(rect); btn.appendChild(path); btn.appendChild(title);
      btn.__rect = rect; btn.__path = path;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const hero = Hero();
        if (!hero || hero.mode !== 'setup' || typeof hero.adjustStat !== 'function') return;
        const out = hero.adjustStat(stat, dir);
        if (!out || !out.ok) return;
        try { if (current && current.view) fillValues(current.view); } catch (e) {}
        refreshHeroChrome();
      });
      return btn;
    };
    group.appendChild(make('up'));
    group.appendChild(make('down'));
    view.g.appendChild(group);
    cache[stat] = group;
    return group;
  }
  function wireHeroStatControls(view) {
    const hero = Hero();
    if (!hero || hero.mode !== 'setup' || !heroStatState()) return;
    for (const stat of HERO_STAT_KEYS) heroStatArrowEnsure(view, stat);
  }

  function stageRectOf(view, el) {
    const svg = view && view.root;
    if (!svg || !el || !el.getBoundingClientRect || !svg.getBoundingClientRect) return null;
    const sr = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!sr.width || !sr.height || !vb || !vb.width || !vb.height) return null;
    const par = String(svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    const scale = /slice/.test(par) ? Math.max(sr.width / vb.width, sr.height / vb.height)
      : Math.min(sr.width / vb.width, sr.height / vb.height);
    if (!scale) return null;
    const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
    const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
    const x0 = sr.left + (sr.width - vb.width * scale) * ax - vb.x * scale;
    const y0 = sr.top + (sr.height - vb.height * scale) * ay - vb.y * scale;
    const r = el.getBoundingClientRect();
    return { x: (r.left - x0) / scale, y: (r.top - y0) / scale, w: r.width / scale, h: r.height / scale };
  }

  function refreshHeroStatControls() {
    const hero = Hero();
    const state = heroStatState();
    const view = current && current.view;
    if (!view || !view.__heroStatArrows) return;
    const show = !!(hero && hero.mode === 'setup' && state && activeTab() === 'status');
    for (const stat of HERO_STAT_KEYS) {
      const group = view.__heroStatArrows[stat];
      if (!group) continue;
      group.style.display = show ? '' : 'none';
      if (!show) continue;

      const clip = clipOf(view, stat);
      const box = stageRectOf(view, clip && clip.g);
      let x = box ? (box.x + box.w + 1) : HERO_STAT_ARROW_AT[stat];
      let y = box ? (box.y + box.h / 2 - 8.5) : 142.5;
      x = Math.max(54, Math.min(HERO_STAT_CELL_RIGHT[stat] - 10, x));
      y = Math.max(140.5, Math.min(145, y));
      group.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')');
      const value = Number(state.values && state.values[stat]) || 0;
      const rules = state.rules || {};
      setHeroStatArrow(group, 'up', state.pool > 0 && value < Number(rules.cap || 0));
      setHeroStatArrow(group, 'down', value > Number(rules.floor || 0));
    }
  }




  function inStatusPortrait(el, root) {
    let at = el;
    while (at && at.parentNode && at.parentNode !== root) at = at.parentNode;
    const d = Number(at && at.getAttribute && at.getAttribute('depth'));
    return Number.isFinite(d) && d >= 129;
  }

  function hideHeroStatusFields(view, hide) {
    if (!view) return;
    const old = view.__heroFieldHidden;
    if (old) {
      for (const rec of old) { try { rec.el.style.display = rec.prev; } catch (e) {} }
      view.__heroFieldHidden = null;
    }
    if (!hide) return;
    if (!view.g || typeof view.g.querySelectorAll !== 'function') return;
    const region = { x: 106, y: 28, w: 208, h: 74 };
    const custom = [
      view.__heroTodo,
      view.__heroStart && view.__heroStart.g,
      view.__heroStartLabel,
      view.__heroTrain && view.__heroTrain.g,
      view.__heroTrainLabel,
      view.__heroBladeCard,
      ...Object.values(view.__heroStatArrows || {}),
    ].filter(Boolean);
    const hidden = [], seen = new Set();
    const hideOne = (el) => {
      if (!el || seen.has(el) || el.style.display === 'none') return;
      seen.add(el);
      hidden.push({ el: el, prev: el.style.display });
      el.style.display = 'none';
    };
    for (const el of view.g.querySelectorAll('*')) {
      if (custom.some((node) => node === el || (node.contains && node.contains(el)))) continue;

      if (inStatusPortrait(el, view.g)) continue;
      const r = stageRectOf(view, el);
      if (!r || !r.w || !r.h) continue;
      if (r.x < region.x || r.y < region.y || r.x + r.w > region.x + region.w || r.y + r.h > region.y + region.h) continue;
      if (el.tagName === 'g' && el.children.length > 2) continue;
      hideOne(el);
    }

    for (const name of ['expMc', 'expNum', 'winRate', 'fightTimes1', 'fightTimes2']) {
      const c = clipOf(view, name);
      if (c && c.g) hideOne(c.g);
    }
    view.__heroFieldHidden = hidden;
  }
  function refreshHeroChrome() {
    if (!heroView() || !current || !current.view) return;
    const hero = Hero(), view = current.view;
    const onStatus = activeTab() === 'status';
    const full = heroStartEnabled();
    const setup = hero.mode === 'setup';
    const statState = heroStatState();
    const pool = statState ? Math.max(0, Number(statState.pool) || 0) : 0;

    const ready = full && pool === 0;
    const startFilter = ready ? '' : 'grayscale(1) brightness(.94)';
    // 爬塔里点头像查看时也不要这三块，那一页只留立绘、四维与装备入口）。
    hideHeroStatusFields(view, onStatus);
    const start = view.__heroStart, label = view.__heroStartLabel;
    if (start && start.g) {
      start.g.style.display = setup && onStatus ? '' : 'none';
      start.g.style.opacity = '1';
      start.g.style.filter = startFilter;
      start.g.style.cursor = ready ? 'pointer' : 'not-allowed';
    }
    if (label) {
      label.style.display = setup && onStatus ? '' : 'none';
      label.style.opacity = '1';
      label.style.filter = startFilter;
    }

    const train = view.__heroTrain, trainLabel = view.__heroTrainLabel;
    const canTrain = Math.max(0, Number(hero.coins) || 0) > 0;
    const trainFilter = canTrain ? '' : 'grayscale(1) brightness(.94)';
    if (train && train.g) {
      train.g.style.display = !setup && onStatus ? '' : 'none';
      train.g.style.opacity = '1';
      train.g.style.filter = trainFilter;
      train.g.style.cursor = canTrain ? 'pointer' : 'not-allowed';
    }
    if (trainLabel) {
      trainLabel.style.display = !setup && onStatus ? '' : 'none';
      trainLabel.style.opacity = '1';
      trainLabel.style.filter = trainFilter;
    }
    const bladeCard = view.__heroBladeCard;
    if (bladeCard) bladeCard.style.display = (!setup && onStatus) ? '' : 'none';
    heroTodoRefresh(view);
    heroBladeCardRefresh(view);
    refreshHeroStatControls();
  }

  function wireHeroChrome() {
    if (!heroView() || !current || !current.view) return;
    const hero = Hero(), view = current.view;
    // 原版 3362「返回菜单」藏掉，换成随机挑战查看敌人那颗 3911「返回」。
    // 3911 不在包里时退回 3362 —— 否则整页没有返回键，玩家会被困在准备页。
    const oldBack = clipOf(view, 'back');
    const back = useStageBack(view, '3911', 1, 160.3, 175.5, 1, 'hero-back', '__heroBack');
    if (back) {
      wireClickable(back, { hover: 2, press: 2, idle: 1, onFire: () => { if (hero.onBack) hero.onBack(); } });
      if (oldBack && oldBack.g) oldBack.g.style.display = 'none';
    } else if (oldBack) {
      wireClickable(oldBack, { hover: 2, onFire: () => { if (hero.onBack) hero.onBack(); } });
    }
    if (hero.mode === 'setup') {
      const start = heroStartEnsure(view);
      if (start) {
        heroStartLabelEnsure(view);
        wireClickable(start, {
          hover: 2, press: 2, idle: 1,
          onFire: () => {
            if (!heroStartEnabled()) {
              if (window.UI && UI.toast) UI.toast('还需点亮 ' + Math.max(0, HERO_PICK_LIMIT - heroPickCount()) + ' 个武技。');
              return;
            }
            if (hero.onStart) hero.onStart();
          },
        });
      }
      heroTodoEnsure(view);
    } else {
      const train = heroTrainEnsure(view);
      if (train) {
        heroTrainLabelEnsure(view);
        wireClickable(train, {
          hover: 2, press: 2, idle: 1,
          onFire: () => openHeroCoinTrain(hero, view),
        });
      }
      heroBladeCardEnsure(view);
    }
    wireHeroStatControls(view);

    const arrows = view.__heroStatArrows || {};
    for (const node of [view.__heroTodo, view.__heroBladeCard, view.__heroStart && view.__heroStart.g,
      view.__heroStartLabel, view.__heroTrain && view.__heroTrain.g,
      view.__heroTrainLabel, arrows.power, arrows.agility, arrows.speed]) {
      if (node && node.parentNode === view.g) view.g.appendChild(node);
    }
    refreshHeroChrome();
  }


  function applyTab() {
    if (!current || !current.view) return;
    const view = current.view;
    const grid = activeTab() !== 'status';
    showGridParts(grid);
    if (!grid) { if (heroView()) refreshHeroChrome(); return; }
    const info = gridInfo();
    if (info && current) current.gridPage = info.page;
    const kind = gridKind();
    for (let i = 0; i < GRID_CELLS.length; i++) {
      const cell = clipOf(view, GRID_CELLS[i]);
      if (!cell) continue;
      cell.__cellName = GRID_CELLS[i];
      const it = info && info.items[i];
      paintCell(cell, kind, it || null);
      wireCell(cell, kind, it || null, i);
    }
    setTextByName(view, 'page', info ? ((info.page + 1) + '/' + info.pages) : '1/1');
    const canPrev = !!info && info.page > 0, canNext = !!info && info.page < info.pages - 1;
    stopAt(clipOf(view, 'left'), canPrev ? 1 : 2);
    stopAt(clipOf(view, 'right'), canNext ? 1 : 2);
    setVisible(clipOf(view, 'left'), canPrev);
    setVisible(clipOf(view, 'right'), canNext);
    wireClickable(clipOf(view, 'left'), {
      hover: 0, press: 0, idle: () => { const i = gridInfo(); return (i && i.page > 0) ? 1 : 2; },
      onFire: () => { const i = gridInfo(); if (i && i.page > 0) { current.gridPage = i.page - 1; applyTab(); } },
    });
    wireClickable(clipOf(view, 'right'), {
      hover: 0, press: 0, idle: () => { const i = gridInfo(); return (i && i.page < i.pages - 1) ? 1 : 2; },
      onFire: () => { const i = gridInfo(); if (i && i.page < i.pages - 1) { current.gridPage = i.page + 1; applyTab(); } },
    });
    if (heroView()) refreshHeroChrome();
  }
  // 二级页：武器 / 技能详情
  // ⚠ 为什么改成整页 DOM 画（原来借库元件 4886 的第 5 帧当底板）：
  // "底板是道具页的、字段靠 DOM 硬贴"，实测与参考截图（`references/screen`）差得远：

  const DETAIL = {
    panel: { x: 25, y: 8, w: 270, h: 172 },
    tab: { x: 46, y: 9, w: 86, h: 20 },
    name: { x: 33, y: 34, w: 122, h: 13 },
    icon: { x: 28, y: 46, w: 50, h: 50 },
    stat: { x: 80, y: 48, w: 96, h: 47 },
    desc: { x: 33, y: 100, w: 142, h: 42 },
    req: { x: 189, y: 38, w: 100, h: 78 },
    btn: { y: 146, h: 20, back: { x: 134, w: 46 }, ok: { x: 214, w: 64 } },
  };

  function detailHost() {
    if (current && current.detail && current.detail.host && current.detail.host.isConnected) return current.detail.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub ssfight-view';
    el.setAttribute('aria-label', '武器技能详情');
    ui.appendChild(el);
    if (current.container) current.container.classList.add('sf-detail-open');
    current.detail = { host: el, view: null, dom: null, kind: null, id: 0 };
    return el;
  }

  function stageMapper(view, container) {
    const svg = view && view.root;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const vb = String(svg.getAttribute('viewBox') || '0 0 320 196').split(/\s+/).map(Number);
    const k = (vb[2] && r.width) ? r.width / vb[2] : 0;
    if (!k) return null;
    const box = container.getBoundingClientRect();
    const hs = layoutScale(container) || 1;
    return {
      k: k,
      x: (sx) => (r.left - box.left + (sx - vb[0]) * k) / hs,
      y: (sy) => (r.top - box.top + (sy - vb[1]) * k) / hs,
      s: (n) => (n * k) / hs,
    };
  }
  function esc2(v) { return esc(v); }

  function heroOwnedItem(kind, id) {
    const hero = Hero();
    if (!hero) return null;
    const list = (kind === 'weapon' ? hero.weapons : hero.skills) || [];
    for (const raw of list) {
      const parts = String(raw).split(/[:,]/), sid = Number(parts[0]);
      if (sid !== Number(id)) continue;
      return { id: sid, level: Math.max(1, Number(parts[1]) || 1), ref: (kind === 'weapon' ? 'w:' : 's:') + sid };
    }
    return null;
  }

  function heroReadonlyUp(kind, id) {
    if (!window.TowerHero || typeof TowerHero.upgradeInfoOf !== 'function') return null;
    try { return TowerHero.upgradeInfoOf(Hero(), (kind === 'weapon' ? 'w:' : 's:') + Number(id)); }
    catch (e) { return null; }
  }

  function openItemDetail(kind, id) {
    const C = window.UI && UI.classic;
    const map = kind === 'weapon' ? window.weaponsMap : window.skillsMap;
    if (!current || !map) return;
    const host = detailHost();
    if (!host) return;
    const base = map.getValue ? map.getValue(id) : null;
    const hero = heroView() ? Hero() : null;
    let own = null, up = null, row = null;
    if (hero) {
      const item = heroOwnedItem(kind, id);
      if (!item) {
        // 未掌握：仍走“尚未获得”的详情，但绝不能用账号里的同名武技。
        const info = gridInfo();
        row = info ? info.items.filter((x) => x.id === Number(id))[0] : null;
        detailView(host, kind, id, base, null, null, row);
        return;
      }
      own = item;
      if (kind === 'weapon' && window.TowerHero && TowerHero.heroWeapon) {
        // `heroWeapon` 读的是 `id:level`（不是升级 API 的 `w:id` ref）。
        const w = TowerHero.heroWeapon(Number(id) + ':' + item.level);
        if (w) own = Object.assign({}, w, { level: item.level });
      }
      up = heroReadonlyUp(kind, id);
      const info = gridInfo();
      row = info ? info.items.filter((x) => x.id === Number(id))[0] : null;
    } else {
      own = (kind === 'weapon' ? State.myWeapons() : State.mySkills()).find((x) => x.id === Number(id)) || null;
      up = own && State.upgradeInfo ? State.upgradeInfo(kind, Number(id)) : null;
      const info = (C && C.catalogInfo) ? C.catalogInfo(kind, current.gridPage || 0) : null;
      row = info ? info.items.filter((x) => x.id === Number(id))[0] : null;
    }
    detailView(host, kind, id, base, own, up, row);
  }

  async function detailView(host, kind, id, base, own, up, row) {
    const t = T();
    if (!t || !current || !current.detail) return;
    if (!SfRender.loaded || !SfRender.tags || !SfRender.tags().length) return;
    try { await SfRender.loadExtra('tags-wsicon.json'); } catch (e) {}
    if (current.detail.host !== host) return;
    current.detail.kind = kind;
    current.detail.id = id;
    // ⑥ 主路径：原版那一页（库元件「状态1」= 4673 的第 1 帧）。
    // 挂不上（素材缺失 / 老缓存）就退回下面那套 DOM 面板，不会白屏。
    try {
      if (await buildDetailAsset(host, kind, id, base, own, up, row)) return;
    } catch (e) {
      if (window.__errs) window.__errs.push('detail asset: ' + (e && e.message));
    }
    buildDetailDom(host, kind, id, base, own, up, row);
  }
  // 「武器 / 技能详情」= 原版那一页（4673 的第 1 帧）
  // ⚠ 用户 2026-10 口径⑥："武器与技能详情页与ssfight版本差距甚远" —— 以前整页是复刻自绘的
  // DOM 面板（`.sf-detail`），现在改成挂原版帧 + 写字段。

  function weaponSpecialText(base, lv) {
    if (!base || !base.remark) return '';
    const id = Number(base.id);
    const n = Math.max(1, Math.min(15, Number(lv) || 1));
    if (id === 16) {
      const pct = 10 + 4 * (Math.min(n, 10) - 1) + 4 * Math.max(0, n - 10);
      return pct + '%几率使对手4个回合不能使用技能';
    }
    if (id === 14) {
      const pct = 10 + 4 * (Math.min(n, 10) - 1) + 2 * Math.max(0, n - 10);
      return '吸血' + pct + '%';
    }
    return String(base.remark).replace(/\s*[,，]?\s*(每级|升级)[\s\S]*$/, '').trim();
  }

  function weaponRemarkText(base, lv) {
    if (!base || !base.remark) return '';
    const id = Number(base.id);
    if (id !== 14 && id !== 16) return base.remark;
    const n = Math.max(1, Math.min(15, Number(lv) || 1));
    const pct = id === 14
      ? 10 + 4 * (Math.min(n, 10) - 1) + 2 * Math.max(0, n - 10)
      : 10 + 4 * (Math.min(n, 10) - 1) + 4 * Math.max(0, n - 10);
    return String(base.remark).replace(/10%/, pct + '%');
  }

  function ironCurrentText(lv) {
    const n = Math.max(1, Math.min(15, Number(lv) || 1));
    const cap = Math.min(n, 10);
    const lo = 5 + 4 * (cap - 1), hi = 20 + 4 * (cap - 1);
    const extra = window.GData && GData.trueSkillValue
      ? GData.trueSkillValue(18, n)
      : [0, 6, 14, 24, 36, 54][Math.max(0, Math.min(5, n - 10))];
    const pct = Math.min(100, 10 + 4 * (cap - 1) + extra);
    return lo + '-' + hi + '点伤害，' + pct + '%使对手4回合不能使用武器';
  }

  function skillRemarkText(base, lv) {
    if (!base || !base.remark) return '';
    if (Number(base.id) !== 18) return base.remark;
    const n = Math.max(1, Math.min(15, Number(lv) || 1));
    const cap = Math.min(n, 10);
    const extra = window.GData && GData.trueSkillValue ? GData.trueSkillValue(18, n) : 0;
    const pct = Math.min(100, 10 + 4 * (cap - 1) + extra);
    const lo = 5 + 4 * (cap - 1), hi = 20 + 4 * (cap - 1);
    return String(base.remark).replace(/^5-20/, lo + '-' + hi).replace(/10%/, pct + '%');
  }
  async function buildDetailAsset(host, kind, id, base, own, up, row) {
    const t = T();
    const isW = kind === 'weapon';
    const ownLv = own ? (Number(own.level) || 0) : 0;
    const weaponSpecial = isW ? weaponSpecialText(base, ownLv || 1) : '';
    // ⚠ 武器页与技能页是同一个元件的两帧（原版 `showWeaponSkillWin`：
    const view = await SfRender.mountSymbol(host, '4673', {
      frame: isW ? 1 : 2, label: '武器技能详情',

      blank: ['need1', 'current1', 'need2', 'current2'],
    });
    if (!view || !current || current.detail.host !== host) {
      if (view) { try { view.destroy(); } catch (e) {} }
      return false;
    }
    // 必须真的有那一帧的具名元件，否则说明素材版本不对 → 让调用方退回 DOM 面板。
    if (!view.byName || !view.byName('name')) {
      try { view.destroy(); } catch (e) {}
      return false;
    }
    if (current.detail) current.detail.assetView = view;
    try { t.freezeDescendants(view); } catch (e) {}
    const locked = !own;
    const maxed = !!(up && up.max);
    const heroDetail = heroView();
    const s = (S() || {});
    const set = (name, str) => { const c = view.byName(name); if (c && t) t.setText(c, str == null ? '' : String(str)); };
    // 这一页的坐标全在导出素材里（`name` / `levelText` / `harm` / `type` 都是文本字段，
    // 落点由 `textfields.json` 的字段框公式算出来），改素材不现实，所以在渲染后对节点做
    // ⚠ 图标那一档（原来的 `iconScale` / `iconDrop`）已经删掉：用户 2026-10 下一轮口径
    const DETAIL_SHIFT = {
      statsX: 3.2,
      // `requirement`（3670）f1 里右侧那两行"需要"的数字（`need1` 金松果 / `need2` 卷轴）。
      // 这两个字段是右对齐的，所以右移 = `text-anchor:end` 的墨迹往右贴一格。
      needX: 3.0,
      nameX: -2.6,
    };
    // 把一个文本字段的所有 `<text>` 沿基线下标平移（幂等：基准值只记一次）。
    const shiftText = (clip, dx, dy) => {
      const node = clip && (clip.g || clip);
      if (!node || !node.querySelectorAll) return 0;
      let n = 0;
      for (const el of node.querySelectorAll('text')) {
        if (el.__dx0 == null) el.__dx0 = Number(el.getAttribute('x') || 0);
        if (el.__dy0 == null) el.__dy0 = Number(el.getAttribute('y') || 0);
        el.setAttribute('x', el.__dx0 + (Number(dx) || 0));
        if (dy) el.setAttribute('y', el.__dy0 + (Number(dy) || 0));
        n++;
      }
      return n;
    };
    const trueOwn = ownLv > 10;

    const shownName = base ? ((trueOwn ? '真.' : '') + base.name) : '';

    set('levelText', String(ownLv > 10 ? ownLv - 10 : ownLv));
    set('type', base && base.type ? base.type : (isW ? '近战' : '被动'));
    // 比字段框（`harm`=4543 宽 52.5、一行 4 个全角字）长得多，横向顶出格子、
    const harm = isW
      ? (own ? (own.harmLo + '-' + own.harmHi) : (base && base.harm ? base.harm : ''))
      : '技能';
    setWrapped(view.byName('harm'), harm);

    let desText = isW ? weaponRemarkText(base, ownLv) : skillRemarkText(base, ownLv);
    if (own && !(up && up.fixed)) {
      const nextLv = Math.min(15, ownLv + 1);
      const curLine = isW
        ? ([14, 16].includes(Number(base && base.id)) ? '当前效果：' + weaponSpecial : '')
        : (Number(base && base.id) === 18 ? '当前效果：' + ironCurrentText(ownLv) : '');
      if (ownLv < 15 && nextLv > 10) {
        const idx = nextLv - 11;
        if (isW) {
          const add = String((base && base.harmAdd1) || '').split('|')[idx] || '';
          desText = base && base.remark1
            ? ('升至下一阶将额外' + base.remark1 + '和' + add + '点基本伤害')
            : ('升至下一阶将额外提升' + add + '点基本伤害');
          if (curLine) desText += '\n' + curLine;
        } else {
          const row = window.GData && GData.trueSkillRow ? GData.trueSkillRow(id) : null;
          if (row && row.text) {
            const n = window.GData && GData.trueSkillStep ? GData.trueSkillStep(id, nextLv) : '';
            desText = '升至下一阶' + String(row.text).replace('N', n);
          }
          if (curLine) desText += '\n' + curLine;
        }
      }
    }
    const desClip = setWrapped(view.byName('des'), desText);
    shrinkDetailDesc(desClip, 0.9);
    // 名字固定单行（真化名字见 `setDetailName` 的注释），不能按 5 字容量硬断行。
    setDetailName(view.byName('name'), shownName);
    // 图标位：挂原版矢量元件（与格子里那 10 颗同一套素材）。
    // ⚠ 原版这里是 `subFrame.c1.attachMovie(名字, "mc", 100, {_x:0,_y:0})`
    const iconBox = view.byName('c1');
    if (iconBox && row && row.icon) mountDetailIconClip(iconBox, row);
    // 右侧那一块 `requirement`（3670）—— 原版按局面选帧，不是永远 f1
    // · 技能 6 / 13（装死 / 师父驾到）→ f3「该技能不能升级」
    // ⚠ f1 里还有一格 `level`，素材占位串写的是「需要松鼠10级」——原版 `showLeveupInfo`
    const req = view.byName('requirement');
    if (req) {
      const noSkillUp = !isW && [6, 13].indexOf(Number(id)) >= 0;
      const reqFrame = locked ? (isW ? 4 : 5)
        : ((noSkillUp || (up && up.blocked)) ? 3 : (maxed ? 6 : 1));
      stopAt(req, reqFrame);
      const setReq = (n, v) => { const c = clipOf(req, n); if (c && t) t.setText(c, v == null ? '' : String(v)); };
      if (reqFrame === 1 && up) {
        if (heroDetail) {

          setReq('need1', '—');
          setReq('current1', '—');
          setReq('need2', '—');
          setReq('current2', '—');
          setReq('rate', (up.rate != null ? up.rate + '%' : '—'));
          setReq('level', '勇者 · 只读');
        } else {
          setReq('need1', up.coin);
          setReq('current1', s.goldPoint | 0);
          setReq('need2', up.book);
          setReq('current2', ((s.props || {})[up.bookId] | 0));
          setReq('rate', (up.rate != null ? up.rate + '%' : '100%'));
          setReq('level', '');

          shiftNeedValues(req, DETAIL_SHIFT.needX);
        }
      }
    }

    shiftText(view.byName('levelText'), DETAIL_SHIFT.statsX);
    shiftText(view.byName('harm'), DETAIL_SHIFT.statsX);
    shiftText(view.byName('type'), DETAIL_SHIFT.statsX);

    paintDetailName(view.byName('name'), base ? base.name : '', DETAIL_SHIFT.nameX);
    // 两颗键：`buttonsMc` 在武器页是 4539、技能页是 4553（各 3 帧，结构一样）：
    // ⚠ 父帧必须停 f1：只有 f1 里才有具名的 `button1` / `button2`（f2/f3 是匿名画稿），
    const bm = view.byName('buttonsMc');
    if (bm) stopAt(bm, 1);
    const backBtn = bm && clipOf(bm, 'button1');
    const okBtn = bm && clipOf(bm, 'button2');
    wireClickable(backBtn, {
      idle: 1, hover: 2,
      onFire: () => { if (current && current.detail) closeItemDetail(); },
    });
    // ⚠ 每一处都要判 `current && current.detail`：详情页是异步挂的，玩家可能在
    if (okBtn && !locked && !maxed && !heroDetail) {
      wireClickable(okBtn, {
        idle: 1, hover: 2,
        onFire: async () => {
          if (!current || !current.detail) return;
          // 联机版：升级成功率由服务端掷（async 动作），必须 await。
          const r = await StateCall('doUpgrade', kind, Number(id));
          if (window.UI && UI.toast) UI.toast(r.msg);

          destroyItemDetailOnly();
          openItemDetail(kind, id);
          refreshGridSoon();
        },
      });
    }

    if (okBtn && (locked || maxed || heroDetail)) {
      stopAt(okBtn, 3);
      okBtn.g.style.cursor = 'default';
      okBtn.g.style.pointerEvents = 'none';
    }
    return true;
  }
  // `requirement`（3670）f1 里"需要"那一列的两个数字右移一点。
  // 这两个字段（`need1` / `need2`）在导出里是右对齐的，平移 `<text>` 的基线 x 即可。
  function shiftNeedValues(req, dx) {
    if (!req || !dx) return 0;
    let n = 0;
    for (const name of ['need1', 'need2']) {
      const c = clipOf(req, name);
      const node = c && (c.g || c);
      if (!node || !node.querySelectorAll) continue;
      for (const el of node.querySelectorAll('text')) {
        if (el.__needX0 == null) {
          el.__needX0 = Number(el.getAttribute('x') || 0);

        }
        el.setAttribute('x', el.__needX0 + Number(dx));
        n++;
      }
    }
    return n;
  }

  function paintDetailName(clip, text, dx) {
    const node = clip && (clip.g || clip);
    if (!node || !node.querySelectorAll) return 0;
    let n = 0;
    for (const el of node.querySelectorAll('text')) {
      el.setAttribute('fill', '#000000');
      el.setAttribute('font-weight', 'bold');
      if (el.__nameX0 == null) el.__nameX0 = Number(el.getAttribute('x') || 0);
      el.setAttribute('x', el.__nameX0 + (Number(dx) || 0));
      n++;
    }
    void text;
    return n;
  }
  // 详情页图标位（原版 `c1` 那个格子）里挂图标元件。
  // ⚠ 原版 `c1` 是个空格子（`attachMovie(名字,"mc",100,{_x:0,_y:0})`），
  // 所以这里不要再传 `viewBox` 去裁切：留着元件自己的坐标系，
  async function mountDetailIconClip(clip, row) {
    try {
      // ⚠ 没获得的那一档挂的是另一颗库元件（原版 `showWeaponSkillWin` 的
      const sym = row.has ? row.icon : (row.lockedIcon || row.icon);
      // 图标元件的画稿从 y≈-1.7 起笔（卡片上沿的白色星芒/高光在 0 以上）。`mountSymbol`
      // 其余尺寸不变（198 对 196 的 1% 缩放肉眼不可见），卡片和两颗键都不动。
      const v = await SfRender.mountSymbol(clip.g, sym, {
        frame: 1, label: '武器图标', viewBox: '0 -2 320 198',
      });
      if (!clip.g.isConnected) { try { v.destroy(); } catch (e) {} return; }
      if (current && current.detail) current.detail.view = v;
      if (v.setStaticPolicy) v.setStaticPolicy({});
      paintIconLabel(v, false, false);
      // ⚠ 详情页这一格是空盒子，图标元件按自己的坐标系落进来 ——
      // ⚠ 上一批在这里加过 `scale(0.82) + translateY(...)`，反而把卡片推低约 18 个舞台单位、
      writeIconLevel(v, row, true);
    } catch (e) { if (window.__errs) window.__errs.push('detail icon clip: ' + (e && e.message)); }
  }
  // `render.js` 的文本容器只按框宽横向裁，纵向是放开的 ——
  // 原版那些字段的框宽在 `textfields.json` 里（例：`des`=4541 宽 150、字号 12
  const wrapCache = new WeakMap();
  // 把一个文本容器当尺子，把 `text` 断到它的框宽里（保留已有的 `\n`）。
  // ⚠ 别用 canvas 量（踩过）：`measureText('国').width / fontSize` 在无头 Chrome 里
  // 这里改成拿这个字段已经画出来的那一行当尺子：它的屏幕宽度 / 字符数
  function wrapToField(clip, text) {
    const src = String(text == null ? '' : text);
    if (!clip || !clip.__textBox) return src;
    const tb = clip.__textBox;
    if (!tb.meta || !tb.meta.bd) return src;
    const W = tb.meta.bd[1] - tb.meta.bd[0] - (tb.meta.lm || 0) - (tb.meta.rm || 0);
    if (!(W > 8)) return src;
    // ⚠ 文本容器的 DOM 就是那个 `<g type="text">` 本身（`__textBox` 挂在它上面），
    // 不能按 `clip.g.…` 取（踩过：`clip.g` 为 undefined，函数直接原样返回、等于没断行）。
    const el = clip.g || clip;
    const svg = el.ownerSVGElement || (el.ownerDocument && el.ownerDocument.querySelector('#ui svg')) || null;
    const vb = svg ? String(svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number) : null;
    const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const k = (rect && rect.width && vb && vb[2]) ? rect.width / vb[2] : 0;
    let unit = wrapCache.get(clip);
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
      wrapCache.set(clip, unit);
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
    return out.join('\n');
  }
  // `setText` + 按框宽断行（详情页那几段说明专用）。
  // ⚠ 传进来的 `clip` 是 `byName()` 拿到的那个具名子元件，它自己不是文本容器
  function setWrapped(clip, str) {
    const t = T();
    if (!clip || !t) return null;
    const node = textBoxOf(clip);
    const wrapped = node ? wrapToField(node, str) : String(str == null ? '' : str);
    t.setText(node || clip, wrapped);
    return clip;
  }

  function shrinkDetailDesc(clip, factor) {
    const box = textBoxOf(clip);
    const node = box && (box.g || box);
    if (!node || !node.querySelectorAll) return 0;
    const f = Math.max(0.5, Math.min(1, Number(factor) || 0.9));
    const list = [...node.querySelectorAll('text')];
    if (!list.length) return 0;
    const y0 = parseFloat(list[0].getAttribute('y'));
    const anchorY = Number.isFinite(y0) ? y0 : 0;
    let n = 0;
    for (const el of list) {
      if (el.__descShrunk) continue;
      const fs0 = parseFloat(el.getAttribute('font-size')) || 12;
      el.setAttribute('font-size', (fs0 * f).toFixed(2));
      const y = parseFloat(el.getAttribute('y'));
      if (Number.isFinite(y)) el.setAttribute('y', (anchorY + (y - anchorY) * f).toFixed(2));
      el.__descShrunk = true;
      n++;
    }
    return n;
  }

  function setDetailName(clip, text) {
    const t = T();
    const tb = textBoxOf(clip);
    if (!tb || !t) return null;
    const src = String(text == null ? '' : text);
    t.setText(tb, src);
    const meta = tb.__textBox && tb.__textBox.meta;
    const bd = meta && meta.bd;
    if (!bd) return clip;
    const W = bd[1] - bd[0] - (Number(meta.lm) || 0) - (Number(meta.rm) || 0);
    const units = [...src].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2E80 ? 0.55 : 1), 0);
    const fh = Number(meta.fh) || 13;
    if (W > 8 && units > 0 && units * fh > W * 0.98) {
      const size = Math.max(9, Math.floor((W * 0.98 / units) * 10) / 10);
      for (const el of (tb.g || tb).querySelectorAll('text')) el.setAttribute('font-size', size);
    }
    return clip;
  }
  // 在一个（可能是壳的）元件里找到真正的文本容器：自己有 `__textBox` 就用自己，
  // 否则往下（广度优先）找第一个有的。
  function textBoxOf(clip, depth) {
    if (!clip) return null;
    if (clip.__textBox) return clip;
    const d = depth || 0;
    if (d > 3) return null;

    if (clip.g && clip.g.querySelectorAll) {
      for (const g of clip.g.querySelectorAll('g[type="text"]')) {
        if (g.__textBox) return g;
      }
    }

    if (clip.names) {
      for (const v of clip.names.values()) {
        if (v && v !== clip && v.__textBox) return v;
        const hit = textBoxOf(v, d + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function buildDetailDom(host, kind, id, base, own, up, row) {
    let dom = host.querySelector('.sf-detail');
    if (!dom) {
      dom = document.createElement('div');
      dom.className = 'sf-detail';
      host.appendChild(dom);
    }
    current.detail.dom = dom;
    const m = detailMapper(host);
    if (!m) return;

    dom.style.setProperty('--u', m.s(1).toFixed(3) + 'px');
    const s = (S() || {});
    const isW = kind === 'weapon';
    const weaponSpecial = isW ? weaponSpecialText(base, own ? own.level : 1) : '';
    const locked = !own;
    const maxed = !!(up && up.max);
    const heroDetail = heroView();
    const ownLv = own ? (Number(own.level) || 0) : 0;
    const trueOwn = ownLv > 10;
    const shownName = base ? ((trueOwn ? '真.' : '') + base.name) : '';
    const lvText = own ? String(trueOwn ? ownLv - 10 : ownLv) : '0';
    const harm = own && isW ? (own.harmLo + '-' + own.harmHi)
      : (isW ? (base && base.harm ? base.harm : '') : '技能');

    let descText = locked ? (heroDetail ? '尚未掌握——在塔内学习新的武技'
      : '尚未获得——升级、开启礼包有机会获得')
      : (isW ? weaponRemarkText(base, ownLv) : skillRemarkText(base, ownLv));
    if (own && !(up && up.fixed)) {
      const curLine = isW
        ? ([14, 16].includes(Number(base && base.id)) ? '当前效果：' + weaponSpecial : '')
        : (Number(base && base.id) === 18 ? '当前效果：' + ironCurrentText(ownLv) : '');
      if (ownLv < 15 && ownLv + 1 > 10) {
        const nextLv = ownLv + 1;
        if (isW) {
          const add = String((base && base.harmAdd1) || '').split('|')[nextLv - 11] || '';
          descText = base && base.remark1
            ? ('升至下一阶将额外' + base.remark1 + '和' + add + '点基本伤害')
            : ('升至下一阶将额外提升' + add + '点基本伤害');
          if (curLine) descText += '\n' + curLine;
        } else {
          const row = window.GData && GData.trueSkillRow ? GData.trueSkillRow(id) : null;
          if (row && row.text) {
            const n = window.GData && GData.trueSkillStep ? GData.trueSkillStep(id, nextLv) : '';
            descText = '升至下一阶' + String(row.text).replace('N', n);
          }
          if (curLine) descText += '\n' + curLine;
        }
      }
    }
    const rows = [];
    if (!locked && !maxed && up && !heroDetail) {
      rows.push({ label: '金松果', need: up.coin, have: s.goldPoint | 0 });
      rows.push({ label: isW ? '卷轴' : '技能卷轴', need: up.book, have: ((s.props || {})[up.bookId] | 0) });
    }
    const pct = up && !maxed ? up.rate : null;
    const pos = (b) => 'left:' + m.x(b.x).toFixed(2) + 'px;top:' + m.y(b.y).toFixed(2) + 'px;width:' + m.s(b.w).toFixed(2) + 'px;' +
      (b.h ? 'height:' + m.s(b.h).toFixed(2) + 'px;' : '');
    const heroReq = heroDetail
      ? '<div class="sf-d-req" style="' + pos(DETAIL.req) + '">' +
          (pct != null ? '<div class="sf-d-req-rate"><b>下一级成功率</b><i>' + esc2(pct) + '%</i></div>' : '') +
          '<div class="small-label" style="margin-top:4px">本局勇者武技 · 无法直接升级</div>' +
        '</div>'
      : '';
    dom.innerHTML =
      '<div class="sf-d-panel" style="' + pos(DETAIL.panel) + '"></div>' +
      '<div class="sf-d-tab" style="' + pos(DETAIL.tab) + '">' + (isW ? '武器详情' : '技能详情') + '</div>' +
      '<div class="sf-d-name' + (locked ? ' locked' : '') + '" style="' + pos(DETAIL.name) + '">' + esc2(shownName) + '</div>' +
      '<div class="sf-d-icon' + (locked ? ' locked' : '') + '" style="' + pos(DETAIL.icon) + '"></div>' +
      '<div class="sf-d-stats" style="' + pos(DETAIL.stat) + '">' +
        statRow('阶段', lvText, m) + statRow(isW ? '伤害' : '等级', harm, m) + statRow('类型', base && base.type ? base.type : '被动', m) +
      '</div>' +
      '<div class="sf-d-desc" style="' + pos(DETAIL.desc) + '">' + esc2(descText) + '</div>' +
      (locked
        ? '<div class="sf-d-locked" style="' + pos(DETAIL.req) + '">' + (heroDetail ? '尚未掌握<br>该' : '尚未获得<br>该') + (isW ? '武器' : '技能') + '</div>'
        : (heroDetail
          ? heroReq
          : (rows.length || pct != null
            ? '<div class="sf-d-req" style="' + pos(DETAIL.req) + '">' +
                '<div class="sf-d-req-head"><span>需要</span><span>已有</span></div>' +
                rows.map((r) => '<div class="sf-d-req-row"><b>' + esc2(r.label) + '</b><i class="need">' + esc2(r.need) + '</i><i class="have">' + esc2(r.have) + '</i></div>').join('') +
                (pct != null ? '<div class="sf-d-req-rate"><b>成功率</b><i>' + esc2(pct) + '%</i></div>' : '') +
              '</div>'
            : ''))) +
      '<button class="sf-d-ok' + ((locked || maxed || heroDetail) ? ' off' : '') + '" style="' + pos({ x: DETAIL.btn.ok.x, y: DETAIL.btn.y, w: DETAIL.btn.ok.w, h: DETAIL.btn.h }) + '">' +
        (maxed ? (heroDetail ? '无法升级' : '已满级') : (heroDetail ? '勇者 · 只读' : (isW ? '升级武器' : '升级技能'))) + '</button>' +
      '<button class="sf-d-back" style="' + pos({ x: DETAIL.btn.back.x, y: DETAIL.btn.y, w: DETAIL.btn.back.w, h: DETAIL.btn.h }) + '">返回</button>';
    mountDetailIcon(dom.querySelector('.sf-d-icon'), row);
    const ok = dom.querySelector('.sf-d-ok');
    if (ok && !maxed && !locked && !heroDetail) ok.addEventListener('click', async () => {
      // 联机版：升级成功率由服务端掷（async 动作），必须 await。
      const r = await StateCall('doUpgrade', kind, Number(id));
      if (window.UI && UI.toast) UI.toast(r.msg);

      openItemDetail(kind, id);
      refreshGridSoon();
    });
    const bk = dom.querySelector('.sf-d-back');
    if (bk) bk.addEventListener('click', () => closeItemDetail());
  }
  // 详情页的图标位：挂原版矢量元件，viewBox 只框住卡片那一块（名字/等级那一条不要）。
  async function mountDetailIcon(box, row) {
    if (!box || !row || !row.icon) return;
    try {
      const v = await SfRender.mountSymbol(box, row.icon, {
        frame: 1, label: '武器图标', viewBox: '-2 -3 50 50',
      });
      if (!box.isConnected) { try { v.destroy(); } catch (e) {} return; }

      if (current && current.detail) current.detail.view = v;

      if (v.setStaticPolicy) v.setStaticPolicy({});
      if (!row.has && v.g) v.g.classList.add('locked');

      paintIconLabel(v, false, false);
      writeIconLevel(v, row, false);
    } catch (e) { if (window.__errs) window.__errs.push('detail icon: ' + (e && e.message)); }
  }

  function detailMapper(host) {
    const view = current && current.view;
    const p = stageMapper(view, host);
    if (p) return p;

    const box = host.getBoundingClientRect();
    const hs = layoutScale(host) || 1;
    const k = box.width ? box.width / 320 : 0;
    if (!k) return null;
    return { k: k, x: (sx) => (sx * k) / hs, y: (sy) => (sy * k) / hs, s: (n) => (n * k) / hs };
  }
  function statRow(label, value, m) {
    return '<span class="sf-d-stat"><b>' + esc2(label) + '</b><i>' + esc2(value) + '</i></span>';
  }
  // 只收详情页那一层（回状态页，格子还在）。
  // ⚠ 底层那一页一直在播：`render.js` 的播放注册表是按视图分开的，
  function destroyItemDetailOnly() {
    if (!current || !current.detail) return;
    // ⚠ 详情页现在是原版整页（`SfRender.mountSymbol('4673', …)`，4673 的宿主就是 `host` 这个
    // ——否则留下一个空壳 `<section>` 压着状态页（点哪都没反应）。
    if (current.detail.view) { try { current.detail.view.destroy(); } catch (e) {} }
    if (current.detail.assetView && current.detail.assetView !== current.detail.view) {
      try { current.detail.assetView.destroy(); } catch (e) {}
    }
    if (current.detail.host && current.detail.host.parentNode) current.detail.host.parentNode.removeChild(current.detail.host);
    current.detail = null;
    if (current.container) current.container.classList.remove('sf-detail-open');

    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
  }
  function closeItemDetail() {
    destroyItemDetailOnly();

    try { applyTab(); } catch (e) { if (window.__errs) window.__errs.push('detail close: ' + (e && e.message)); }
  }
  function refreshGridSoon() {
    const page = current;
    setTimeout(() => { if (current === page) { try { applyTab(); } catch (e) {} } }, 30);
  }

  async function loadIconTable() {
    try { await SfRender.loadExtra('tags-wsicon.json'); } catch (e) { if (window.__errs) window.__errs.push('wsicon: ' + (e && e.message)); }
  }

  // ⚠ 复刻曾经给"未获得"单独补过一条 DOM 名字条（`.sf-cellname`），2026-10 用户口径
  // ⚠ 这两样都是原版矢量元件自带的，不需要 DOM 补：


  function layoutScale(host) {
    if (!host.__probe) {
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:0;pointer-events:none;visibility:hidden';
      host.appendChild(p);
      host.__probe = p;
    }
    const w = host.__probe.getBoundingClientRect().width;
    return w ? w / 100 : 1;
  }

  function wireCell(cell, kind, it, i) {
    const t = T();
    if (!t || !cell || !cell.g) return;
    cell.__pinFrame = null;
    cell.__cellItem = it || null;
    cell.__cellIndex = i;
    cell.__cellKind = kind;
    if (!cell.__cellWired) {
      cell.__cellWired = true;
      cell.g.classList.add('sf-cell');
      cell.g.addEventListener('mouseenter', () => {
        const it0 = cell.__cellItem;
        if (!it0) return;

        setCellLook(cell, it0, true);
        cell.g.classList.add('lit');
      });
      cell.g.addEventListener('mouseleave', () => {
        setCellLook(cell, cell.__cellItem, false);
        cell.g.classList.remove('lit');
      });
      cell.g.addEventListener('click', (e) => {
        e.stopPropagation();
        const it2 = cell.__cellItem;
        if (!it2) return;
        // 勇者准备：点一下点亮、再点一下变暗；爬塔中回看：
        // · 已掌握的武技 → 打开只读详情（当前等级 / 下一级成功率，不能直接升级）；
        if (heroView()) {
          const hero = Hero();
          if (!hero) return;
          if (hero.mode === 'setup') {
            const out = heroTogglePick(cell.__cellKind, it2.id);
            if (out && out.ok === false && out.msg && window.UI && UI.toast) UI.toast(out.msg);
            return;
          }
          if (!it2.has) return;
          openItemDetail(cell.__cellKind, it2.id);
          return;
        }
        // ⚠ 查看别人时不许开详情：原版 `showWeaponSkillWin`（:16658-16790）整段被
        // 不拦这一下的话，点对手的武器会开出"我的"升级页，数据与权限都是错的。
        if (friendView()) return;

        openItemDetail(cell.__cellKind, it2.id);
      });
    }
    // ⚠ 换帧会重建格子元件 → 新实例没有接线。这里每次都补上（与 tab 同一个道理）。
    cell.g.style.cursor = it ? 'pointer' : 'default';
    cell.g.style.pointerEvents = it ? 'auto' : 'none';
    if (!it) { t.unregisterHit(cell); cell.g.classList.remove('lit'); return; }
    t.measureHitBox(cell);
    if (it) {
      t.popWrap(cell);
      const shell = cell.g.querySelector(':scope > g.uc-pop');
      if (shell) t.wirePopPress(shell);
      // ⚠ 画序：格子元件（3636）自己的那一帧画稿（`g[type=shape]`，卡片底 + 白色投影）
      // ⚠ 必须在 `popWrap()` 之后做：`popWrap` 会把 `<g>` 的子节点整个搬进 `.uc-pop` 壳，
      // 顺序会被重排一次（踩过一次：写完 `paintCell` 里挪、结果被 `popWrap` 又挪回去了）。
      raiseAttached(cell);
    }
  }


  function setTab(which) {
    if (!current) return;

    if (which !== current.tab && window.SfGuide && SfGuide.onStatusTab) {
      try { SfGuide.onStatusTab(which); } catch (e) {}
    }
    current.tab = which;
    current.gridPage = 0;
    stopAt(current.view, PAGE_FRAME[which] || 1);
    wireTabs();
    if (which === 'status') fillValues(current.view);
    applyTab();
  }

  function wireTabs() {
    const view = current && current.view;
    if (!view) return;
    for (const [nm, key] of [['tab', 'status'], ['tab1', 'weapons'], ['tab2', 'skills']]) {
      wireClickable(clipOf(view, nm), {
        // 悬停 = 原版"键盘光标停在 tab 那一行"：那一档原版停在第 3 帧（浅奶油底），
        // 否则 `gotoAndStop(3)`（奶油底）。`references/screen/…161800.png`（状态页，光标不在
        hover: 3,
        idle: () => (key === activeTab() ? 2 : 1),
        press: 0,                                   // 按下交给 CSS（第 3 帧是"光标在 tab 行"，不能闪它）
        onFire: () => setTab(key),
      });
    }
    wireFrameButtons();
  }


  function markFriendBackLabel(view) {
    const back = clipOf(view, 'back');
    if (!back || !back.g) return;
    const host = back.getContentHost ? back.getContentHost() : back.g;
    if (!host || !host.querySelectorAll) return;
    for (const n of host.querySelectorAll(':scope > [depth="6"]')) n.style.display = 'none';
    if (host.querySelector(':scope > text.sf-friend-back-label')) return;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'sf-friend-back-label');
    label.setAttribute('x', '0');
    label.setAttribute('y', '8.6');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '13.5');
    label.setAttribute('font-weight', '700');
    label.setAttribute('font-family', '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif');
    label.setAttribute('fill', '#fff8e0');
    label.setAttribute('stroke', '#5a2a12');
    label.setAttribute('stroke-width', '0.9');
    label.setAttribute('paint-order', 'stroke fill');
    label.setAttribute('pointer-events', 'none');
    label.textContent = '返回';
    host.appendChild(label);
  }
  // 关卡「挑战」页（4756 f5）那颗原版 3911「返回」。
  // ⚠ 3911 有 2 帧：第 1 帧是黄色（`3171` 黄/橙渐变），第 2 帧是绿色
  function useStageBack(view, symbol, frame, x, y, scale, name, cacheKey) {
    if (!view || !view.attachChild) return null;
    let btn = cacheKey && view[cacheKey] && view[cacheKey].g && view[cacheKey].g.isConnected ? view[cacheKey] : null;
    if (!btn) {
      const made = view.attachChild(symbol, frame, name);
      if (!made || !made.g) return null;
      btn = view[cacheKey] = made;
      const sc = Number(scale) > 0 ? Number(scale) : 1;
      btn.g.setAttribute('transform', 'matrix(' + sc + ',0,0,' + sc + ',' + x + ',' + y + ')');
      btn.g.style.cursor = 'pointer';
      btn.g.style.pointerEvents = 'auto';
    }
    return btn;
  }
  // 联机好友必须用账号 ID；名字相同的玩家不能互相替代。
  function onlineFriendId(f) {
    const id = Number(f && (f.accountId || f.remoteId));
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function removeFriendFromView() {
    const f = Friend();
    if (!f) return;
    const C = window.UI && UI.classic;
    const online = window.Online && Online.ready;
    const page = current;
    const token = window.Net && Net.token ? Net.token() : null;
    const active = () => current === page && Friend() === f && (!online || (Online.ready && (!window.Net || !Net.token || Net.token() === token)));
    const target = online ? (f && f.bot && /^ai_[A-Za-z0-9_-]+$/.test(String(f.snapshotId || '')) ? f.snapshotId : onlineFriendId(f)) : 0;
    if (online && !target) {
      if (window.UI && UI.toast) UI.toast('这位对手不是联机好友。');
      return;
    }
    if (!online && (!window.State || !State.removeFriend)) return;
    let busy = false;
    const doRemove = async () => {
      if (busy || !active()) return;
      if (online) {
        busy = true;
        try {
          await Online.del('/api/friends/' + target);
          if (!Online.ready || (window.Net && Net.token && Net.token() !== token)) return;
          await Online.syncState();
          if (!active()) return;
          if (window.UI && UI.toast) UI.toast('删除好友成功。');
          leaveFriendView();
          if (window.SfChallenge && SfChallenge.showTab) SfChallenge.showTab('friends');
        } catch (e) {
          if (active() && window.UI && UI.toast) UI.toast(Online.errText(e));
        } finally { busy = false; }
        return;
      }
      const r = State.removeFriend(f.name);
      if (window.UI && UI.toast) UI.toast(r.msg || (r.ok ? '删除好友成功。' : '删除失败'));
      if (!r.ok) return;
      leaveFriendView();
      try { if (window.SfChallenge && SfChallenge.showTab) SfChallenge.showTab('friends'); } catch (e) {}
    };
    if (C && C.modal) {
      C.modal('删除好友', '<p>确定要删除好友【' + esc(f.name) + '】吗？</p>', [
        { label: '删除', cls: 'muted', run: doRemove },
        { label: '取消', cls: 'gold' },
      ], { small: true });
      return;
    }
    if (typeof window.confirm === 'function' && !window.confirm('确定要删除好友【' + f.name + '】吗？')) return;
    doRemove();
  }
  async function openOnlineFriendMessage(f, C) {
    const target = onlineFriendId(f), page = current;
    if (!target || !C || !C.modal) {
      if (window.UI && UI.toast) UI.toast('这位对手暂不能接收联机留言。');
      return;
    }
    const token = window.Net && Net.token ? Net.token() : null;
    const request = page.friendMessageRequest = (page.friendMessageRequest || 0) + 1;
    const active = () => current === page && Friend() === f && page.friendMessageRequest === request && Online.ready && (!window.Net || !Net.token || Net.token() === token);
    if (page.friendMessageModal) page.friendMessageModal.close();
    try {
      const out = await Online.get('/api/board?accountId=' + target);
      if (!active()) return;
      const list = Array.isArray(out.messages) ? out.messages : [];
      const rows = list.length
        ? list.map((m) => '<li style="padding:4px 0;border-bottom:1px dashed #e2c68f"><b>' + esc(m.from && m.from.name) + '</b>：' + esc(m.text) +
            '<time style="display:block;color:#9a7a4a;font-size:12px">' + esc(new Date(m.createdAt).toLocaleString()) + '</time></li>').join('')
        : '<li style="padding:6px 0;color:#9a7a4a">还没有留言，写一句吧。</li>';
      const html = '<div style="max-height:150px;overflow:auto;margin:0 0 10px;padding:8px 10px;border:2px solid #c9a25a;border-radius:12px;background:#fffaf0;color:#5a3a1a"><ul style="margin:0;padding:0;list-style:none">' + rows + '</ul></div>' +
        '<textarea data-friend-msg maxlength="200" placeholder="写一句留言…（最多 200 字）" style="width:100%;min-height:64px;box-sizing:border-box;padding:8px;border:2px solid #c9a25a;border-radius:12px;font:inherit;color:#5a3a1a;background:#fffdf1"></textarea>';
      let m = null, busy = false;
      const send = async () => {
        if (busy || !active() || !m || !m.element.isConnected) return;
        const ta = m.element.querySelector('[data-friend-msg]');
        const text = String(ta && ta.value || '').slice(0, 200).trim();
        if (!text) { if (window.UI && UI.toast) UI.toast('留言不能为空。'); return; }
        busy = true;
        try {
          await Online.post('/api/board', { toId: target, text });
          if (!active() || !m.element.isConnected) return;
          if (window.UI && UI.toast) UI.toast('留言已发送。');
          m.close();
          openFriendMessage();
        } catch (e) {
          if (active() && m.element.isConnected && window.UI && UI.toast) UI.toast(Online.errText(e));
        } finally { busy = false; }
      };
      m = page.friendMessageModal = C.modal('给【' + f.name + '】留言', html, [
        { label: '发送', cls: 'gold', close: false, run: send },
        { label: '返回', cls: 'muted' },
      ], { small: true });
    } catch (e) {
      if (active() && window.UI && UI.toast) UI.toast(Online.errText(e));
    }
  }
  // 查看好友 → 右下「留言」：原版是 `openWap(leaveMsgUrl + playerId)` 的外链留言板；
  // 离线版落进存档（`State.friendMessages` / `leaveFriendMessage`），这里用经典弹窗补全界面。
  function openFriendMessage() {
    const f = Friend();
    if (!f) return;
    const C = window.UI && UI.classic;
    if (window.Online && Online.ready) return openOnlineFriendMessage(f, C);
    if (!C || !C.modal || !State.friendMessages || !State.leaveFriendMessage) {
      if (window.UI && UI.toast) UI.toast('本地怀旧版暂不支持留言。');
      return;
    }
    const list = State.friendMessages(f.name) || [];
    const rows = list.length
      ? list.map((m) => '<li style="display:flex;gap:8px;justify-content:space-between;padding:4px 0;border-bottom:1px dashed #e2c68f">' +
          '<span>' + esc(m.text) + '</span><time style="flex:none;color:#9a7a4a;font-size:12px">' + esc(new Date(m.at).toLocaleString()) + '</time></li>').join('')
      : '<li style="padding:6px 0;color:#9a7a4a">还没有留言，写一句吧。</li>';
    const html = '<div style="max-height:150px;overflow:auto;margin:0 0 10px;padding:8px 10px;border:2px solid #c9a25a;border-radius:12px;background:#fffaf0;color:#5a3a1a">' +
      '<ul style="margin:0;padding:0;list-style:none">' + rows + '</ul></div>' +
      '<textarea data-friend-msg maxlength="80" placeholder="写一句留言…（最多 80 字）" style="width:100%;min-height:64px;box-sizing:border-box;padding:8px;border:2px solid #c9a25a;border-radius:12px;font:inherit;color:#5a3a1a;background:#fffdf1"></textarea>' +
      '<p class="small-label" style="margin:8px 0 0">留言只保存在本机存档，不会上传到服务器。</p>';
    let m = null;
    const send = () => {
      const ta = m && m.element && m.element.querySelector('[data-friend-msg]');
      const r = State.leaveFriendMessage(f.name, ta ? ta.value : '');
      if (window.UI && UI.toast) UI.toast(r.msg || (r.ok ? '留言已保存' : '留言失败'));
      if (!r.ok) return;
      if (m) m.close();
      openFriendMessage();
    };
    m = C.modal('给【' + f.name + '】留言', html, [
      { label: '发送', cls: 'gold', close: false, run: send },
      { label: '返回', cls: 'muted' },
    ], { small: true });
  }
  function wireFrameButtons() {
    const view = current && current.view;
    if (!view) return;
    // 原版按等级决定停哪一帧（`MainMovie.as:13931-13974`）：
    // · `b_change`(7199)：`level >= 5`  → 第 1 帧（已开启）；否则第 2 帧（灰底 + "5级开启"）
    // · `b_fusion`(7207)：`level > 19` → 第 1 帧（已开启）；否则第 2 帧（灰底 + "20级开启"）
    const lv = () => Math.max(1, Math.round(Number((S() || {}).level) || 1));

    if (heroView()) {
      const hero = Hero();
      const outer = clipOf(view, 'b_change');
      if (outer) stopAt(outer, 1);
      const fusion = clipOf(view, 'b_fusion');
      if (fusion && fusion.g) fusion.g.style.display = 'none';
      // 与自己的状态页完全同一套：外层 `b_change` 在第 1 帧就是「更换装备」按钮本身，
      // 它自己的量盒/接线路子已经验证过；不要再往子键里找（子键可能是零尺寸的空壳）。
      if (outer && outer.g) {
        wireClickable(outer, { hover: 0, press: 0, idle: () => 1, onFire: () => {
          // 主路径：玩家自己的「更换装备」原版页（4673 第 3 帧），只是换成全部装备 / 0 加成。
          const p = openGearsPage();
          if (p && typeof p.then === 'function') {
            p.then((ok) => { if (!ok && hero.onGears) hero.onGears(); }).catch((e) => {
              if (window.__errs) window.__errs.push('hero gears: ' + (e && e.message));
              if (hero.onGears) hero.onGears();
            });
          }
        } });
      }
      wireHeroChrome();
      return;
    }

    if (friendView()) {
      const foe = Friend() || {};
      const kind = String(foe.kind || '');
      const isFriend = kind === 'friend';
      const isKin = kind === 'master' || kind === 'prentice';
      const online = !!(window.Online && Online.ready);
      const isSaveFriend = !!(window.State && State.friendOf && State.friendOf(foe.name));
      // 师徒行也占好友位（好友先加、后拜师/收徒时名册里只留师徒这一行），
      // 所以「留言」必须按同一档处理；`del_friend` 只给真正的好友关系。
      const canMessage = isFriend || (isKin && (online ? onlineFriendId(foe) > 0 : isSaveFriend));
      const canDelete = isFriend || (isKin && isSaveFriend);
      const outer = clipOf(view, 'b_change');
      if (outer) stopAt(outer, canMessage || canDelete ? 5 : 4);
      const changeBtn = outer && outer.byName ? outer.byName('b_change') : null;
      const delBtn = outer && outer.byName ? outer.byName('del_friend') : null;
      const leaveBtn = outer && outer.byName ? outer.byName('leaveMsg') : null;
      if (changeBtn) wireClickable(changeBtn, { hover: 2, press: 0, idle: 1, onFire: openFriendGears });
      if (delBtn) {
        if (canDelete) wireClickable(delBtn, { hover: 2, press: 0, idle: 1, onFire: removeFriendFromView });
        else setVisible(delBtn, false);
      }
      if (leaveBtn) {
        if (canMessage) wireClickable(leaveBtn, { hover: 2, press: 0, idle: 1, onFire: openFriendMessage });
        else setVisible(leaveBtn, false);
      }
      // 素材/帧异常时至少保留「查看装备」的旧入口，不能让整页点不动。
      if (!changeBtn) wireClickable(outer, { hover: 0, press: 0, idle: () => (canMessage || canDelete ? 5 : 4), onFire: openFriendGears });
      wireClickable(clipOf(view, 'b_fusion'), { hover: 0, press: 0, idle: () => 3, onFire: () => {} });

      const oldBack = clipOf(view, 'back');
      const stageBack = useStageBack(view, '3911', 1, 160.3, 175.5, 1, 'friend-view-back', '__friendViewBack');
      if (stageBack) {
        wireClickable(stageBack, { hover: 2, press: 2, idle: 1, onFire: leaveFriendView });
        if (oldBack && oldBack.g) oldBack.g.style.display = 'none';
      } else {
        wireClickable(oldBack, { hover: 0, press: 0, onFire: leaveFriendView });
        markFriendBackLabel(view);
      }
      return;
    }
    // ⚠ 「更换装备」走原版那一页（库元件「状态1」= 4673 的第 3 帧，`showEquipsWin()`）：
    wireClickable(clipOf(view, 'b_change'), {
      hover: 0, press: 0,
      idle: () => (lv() >= 5 ? 1 : 2),
      onFire: () => {
        if (lv() >= 5) {
          const p = openGearsPage();
          if (p && typeof p.catch === 'function') p.catch((e) => { if (window.__errs) window.__errs.push('gears page: ' + (e && e.message)); });
          return;
        }
        if (window.UI && UI.toast) UI.toast('你还没有达到5级，不能使用装备哦。多多挑战，多多使用道具，努力升级吧！');
      },
    });
    wireClickable(clipOf(view, 'b_fusion'), {
      hover: 0, press: 0,
      idle: () => (lv() > 19 ? 1 : 2),
      onFire: () => {
        if (lv() > 19) {

          const p = openFusionPage();
          if (p && typeof p.catch === 'function') p.catch((e) => { if (window.__errs) window.__errs.push('fusion page: ' + (e && e.message)); });
          return;
        }
        if (window.UI && UI.toast) UI.toast('20级就可以进行装备融合啦！高级装备任你做，亲手打造出极品！');
      },
    });

    wireClickable(clipOf(view, 'back'), {
      hover: 2,
      onFire: () => { destroy(); if (window.UI && UI.runAction) UI.runAction('home'); },
    });
  }
  // 接线：三个 tab + 翻页箭头 + 两颗功能键 + 返回
  // ⚠ 这一页没有"只接一次线"这回事：三颗 tab、两颗功能键、返回菜单分别挂在页元件
  // 否则 `gotoAndStop(3)`。导出数据实测（`tags-status.json` 的 7210/7212/7215，各 4 帧）：


  let seq = 0;

  let openTrace = '';
  async function open(container, opts) {
    openTrace = 'start';
    if (!window.SfRender || !window.SfRender.mountSymbol) throw new Error('SfRender 未加载（缺 js/ssfight/render.js）');
    const t = T();
    if (!t) throw new Error('SfUiMain.toolkit 不在（缺 js/ssfight/ui-main.js）');
    const o = opts || {};
    let host = container || (current && current.container);
    if (!host) {
      const ui = document.getElementById('ui');
      if (ui) {
        ui.innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠状态"></section>';
        host = ui.querySelector('.ssfight-home');
      }
    }
    if (!host) { openTrace = 'no-host'; return false; }
    // ⚠ 作废在途挂载用的是 `++seq`；这里必须领号再作废旧号：
    // 递增统一走 `invalidate()` —— 否则 `mine !== seq` 恒成立、函数直接返回 false，
    const mine = ++seq;
    destroyView();
    openTrace = 'destroyed mine=' + mine + ' seq=' + seq;
    await SfRender.loadExtra('tags-status.json');
    openTrace = 'bundle-status mine=' + mine + ' seq=' + seq;

    await loadIconTable();

    try { await SfRender.loadExtra('tags-gear.json'); } catch (e) {}
    // 不要自己给 3362 补字，直接用关卡「挑战它」那一页的返回键）。3911 在挑战包里。
    if (o.friend || o.hero) { try { await SfRender.loadExtra('tags-challenge.json'); } catch (e) {} }
    await loadFrameTable();
    if (mine !== seq) { openTrace = 'stale mine=' + mine + ' seq=' + seq; return false; }
    const view = await SfRender.mountSymbol(host, '7218', {
      frame: 1, label: '状态',
      blank: ['expNum'],
    });
    if (mine !== seq || host.isConnected === false) { view.destroy(); return false; }
    openTrace = 'mounted';
    const initialTab = (o.tab === 'weapons' || o.tab === 'skills') ? o.tab : 'status';
    current = { view: view, container: host, tab: initialTab, gridPage: 0,

      friend: o.friend || null, hero: o.hero || null, backTo: o.backTo || null, overlay: !!o.overlay };
    if (o.friend) setTextByName(view, 'playerName', String(o.friend.name || ''));

    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    // 这一页是静态页（原版靠键盘选中才切某一项的帧）：交给统一的「静态页策略」
    // ⚠ 老写法要在这里列一份"马上要接线的元件不许钉"的例外名单 —— 那是 `pinFrame` 时代
    t.freezeDescendants(view);
    try { fillValues(view); } catch (e) { if (window.__errs) window.__errs.push('status values: ' + e.message); }
    try { wireTabs(); } catch (e) { if (window.__errs) window.__errs.push('status wire: ' + (e && e.message)); }
    // 入口可以指定初始页签：勇者头像 → 直接进「技能」页；普通状态页仍是「状态」。
    try {
      if (initialTab !== 'status') setTab(initialTab);
      else applyTab();
    } catch (e) { if (window.__errs) window.__errs.push('status initial tab: ' + (e && e.message)); }

    current.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!current || current.view !== view || current.tab !== 'status') return;
      try { fillValues(view); } catch (e) {}
    }, 1000);
    openTrace = 'done';
    return true;
  }

  function destroyView() {

    destroyGearPage();
    destroyFusionPage();
    const overlayHost = current && current.overlay ? current.container : null;
    if (current) {
      if (current.timer) clearInterval(current.timer);
      if (current.detail) destroyItemDetailOnly();
      if (current.view) { try { current.view.destroy(); } catch (e) {} }
    }
    current = null;
    // 查看别人的状态页是盖在挑战页上的一层：拆完必须把这层空 section 也摘掉，
    // 否则挑战页还在下面但被一块不透明的空白层永远盖住。
    if (overlayHost && overlayHost.parentNode) {
      try { overlayHost.parentNode.removeChild(overlayHost); } catch (e) {}
    }
  }

  function destroy() {
    seq++;
    destroyView();
    if (window.SfRender && SfRender.releaseExtra) {
      SfRender.releaseExtra('tags-status.json');
      // 颜色表在途时先别放包：它完成后还会把表写回缓存，下次打开不能再依赖已释放的标签。
      if (!gearColorLoading) {
        SfRender.releaseExtra('tags-gear-color.json');
        gearColorTable = null;
      }
    }
  }

  // 「查看装备」—— 原版 `friendEquipsInfo()`（:13821）= 库元件「状态1」第 7 帧
  // ⚠ 以前这里根本走不通：`openFriendGears()` 先把状态页 `destroy()`、再调
  // ⚠ 版式用四行（每行一件：图标 / 名字 / 部位 / 强化）而不是"横着排四个"：
  const GEAR_PART_NAME = { 0: '头部', 1: '拳套', 2: '衣服', 3: '鞋子' };
  const FRIEND_GEAR_BOX = { x: 24, y: 18, w: 272, h: 158 };
  // 「查看装备」= 原版那一页（库元件「状态1」= 4673 的第 7 帧）
  // 提进了 `tags-status.json`）。所以这一页从"复刻自研的 DOM 面板"换成挂原版帧 + 写字段：
  // ⚠ 用户 2026-10 之前这里只能用 DOM 画 —— 那时 4673 还没进素材库；
  function openFriendGearsAsset() {
    const host = detailHost();
    if (!host) return null;
    if (current.detail && current.detail.assetView) {
      const v = current.detail.assetView;
      if (v.g && v.g.isConnected) return v;
    }
    current.detail = current.detail || {};
    const p = SfRender.mountSymbol(host, '4673', { frame: 7, label: '查看装备' });
    return p;
  }
  // 把一个好友的装备写进 `mc_tab1..4`（逐条照 `showFriendInfoWin`，MainMovie.as:19037-19091）。
  // ⚠ 复刻以前这里写的是部位名（头部/拳套…），和原版那一格对不上；
  // ⚠ 图标位以前完全没填：四格里只有字没有装备图（用户 2026-11 口径："查看装备页面的
  function fillFriendGearTabs(view, foe) {
    const t = T();
    if (!view || !foe) return false;
    const byType = [];

    const partOf = new Map();
    for (const g of (foe.gears || [])) {
      const ty = Number(g && g.type != null ? g.type : (State.gearPart ? State.gearPart(g.id) : NaN));
      if (!Number.isFinite(ty)) continue;
      if (byType[ty] === undefined) { byType[ty] = g; partOf.set(g, ty); }
    }
    const C = window.UI && UI.classic;
    const gearName = (g) => (g && C && C.gearName ? C.gearName(Number(g.id)) : ('装备' + (g ? g.id : '')));

    const GEAR_STAT_LABEL = ['敏捷', '力量', '生命', '速度'];
    const baseText = (ty, g) => {
      if (!g) return '';
      const label = GEAR_STAT_LABEL[ty] || '敏捷';
      let amount = 0;
      if (Number.isFinite(Number(g.attr)) && Number(g.attr) > 0) amount = Number(g.attr);
      if (!amount) { try { amount = Number(State.gearBaseAttr ? State.gearBaseAttr(Number(g.id)) : 0) || 0; } catch (e) { amount = 0; } }
      if (!amount) amount = Math.max(1, Number(g.ext) || 1);
      return label + '+' + amount;
    };

    const addrText = (g) => {
      if (!g) return '';
      let lines = [];
      try { lines = State.extTextForGear ? State.extTextForGear(g) : (State.extText ? State.extText(g.ext || []) : []); } catch (e) { lines = []; }
      lines = (lines || []).filter(Boolean);
      return lines.length ? lines.join('\n') : '无';
    };
    const gemText = (g) => {
      const gem = g && g.gem;
      const id = Number(gem && gem.id);
      if (!id) return '';
      try {
        const p = window.propMap && propMap.getValue(id);
        return p ? String(p.name || '') : '';
      } catch (e) { return ''; }
    };
    const qualityOf = (g) => {
      try { return State.gearQuality ? State.gearQuality(g) : (Number(g && g.quality) || 0); } catch (e) { return 0; }
    };
    let any = false;
    for (let i = 0; i < 4; i++) {
      const tab = clipOf(view, 'mc_tab' + (i + 1));
      if (!tab) continue;
      any = true;
      const g = byType[i];

      stopAt(tab, g ? 1 : 2);
      const set = (name, str) => { const c = clipOf(tab, name); if (c && t) t.setText(c, str == null ? '' : String(str)); };
      set('t_name', g ? gearName(g) : '');
      set('t_base', baseText(i, g));
      set('t_addr', addrText(g));
      set('stone', gemText(g));
      // 名字按品质上色（`setEquipTextColor`）—— 必须排在 `setText` 之后（见 `setGearTextColor`）。
      if (g) setGearTextColor(clipOf(tab, 't_name'), qualityOf(g));

      const slot = clipOf(tab, 'c1');
      if (slot && slot.detachAll) {
        slot.detachAll();

        let card = null;
        try { card = slot.g && slot.g.getBBox ? slot.g.getBBox() : null; } catch (e) { card = null; }
        if (g) {
          const part = partOf.has(g) ? partOf.get(g) : Number(g.type);

          const cg = Object.assign({}, g, { type: part, quality: qualityOf(g) });
          const sid = gearColorId(cg);
          if (sid && slot.attachChild) {
            slot.attachChild(String(sid), 1, 'gear');
          } else {
            const info = wearInfo(g);
            const sym = containerIds && containerIds[part] && containerIds[part][0];
            if (info && sym && slot.attachChild) {
              const child = slot.attachChild(sym, info.frame, 'wear');
              if (child) {
                if (card && card.width > 0 && card.height > 0) {
                  fitArtwork(child, 0.85 * Math.min(card.width, card.height),
                    card.x + card.width / 2, card.y + card.height / 2);
                } else {
                  fitArtwork(child, GEAR_CARD_ART, GEAR_CARD_MID, GEAR_CARD_MID);
                }
              }
            }
          }
        }
      }
      if (slot && slot.setExtraTransform) {
        slot.setExtraTransform('translate(' + FRIEND_GEAR_ICON_DX + ',0)');
      }
      tuneFriendGearText(tab);
    }

    return any;
  }

  const FRIEND_GEAR_TEXT = {
    name: { size: 11 },
    base: { size: 10.2 },
    addr: { size: 8.2, dx: 15, dy: 12, step: 13.4 },
    stone: { size: 9.5, dx: -6 },
  };

  const FRIEND_GEAR_ICON_DX = 2.4;
  function tuneFriendGearText(tab) {
    if (!tab) return;
    const tune = (field, spec) => {
      const clip = clipOf(tab, field);
      // 文本字段由 renderer 直接存成 `<g type="text">` 元素（没有 `.g`），
      // 精灵 clip 才有 `.g` —— 两种都要接住，否则这里的 nodes 永远是 0。
      const g = clip && (clip.g || clip);
      if (!g || !g.querySelectorAll) return;
      const nodes = [...g.querySelectorAll('text')];
      const box = clip.__textBox || g.__textBox;
      nodes.forEach((n, i) => {
        if (spec.size) n.setAttribute('font-size', String(spec.size));
        if (spec.dx) {
          const base = n.__sfBaseX != null ? n.__sfBaseX : (n.__sfBaseX = Number(n.getAttribute('x')) || 0);
          n.setAttribute('x', String(base + spec.dx));
        }
        if (spec.dy || spec.step != null) {
          const base = (box && Number.isFinite(box.base)) ? box.base : (Number(n.getAttribute('y')) || 0);
          const step = spec.step != null ? spec.step : ((box && box.step) || 0);
          n.setAttribute('y', String(base + (spec.dy || 0) + i * step));
        }
      });
    };
    tune('t_name', FRIEND_GEAR_TEXT.name);
    tune('t_base', FRIEND_GEAR_TEXT.base);
    tune('t_addr', FRIEND_GEAR_TEXT.addr);
    tune('stone', FRIEND_GEAR_TEXT.stone);
  }
  function openFriendGearsOverlay() {
    const foe = Friend();
    if (!foe || !current) return;
    const go = () => {
      if (!current || Friend() !== foe) return;
      // 主路径：原版那一页（4673 f7）。挂载是异步的，挂好之后回填四个格子。
      const p = openFriendGearsAsset();
      if (!p) { openFriendGearsDom(); return; }
      if (typeof p.then !== 'function') {
        try {
          T().freezeDescendants(p);
          if (!fillFriendGearTabs(p, foe)) openFriendGearsDom();
          wireFriendGearsBack(p);
        } catch (e) { openFriendGearsDom(); }
        return;
      }
      p.then((view) => {
        if (!view) { openFriendGearsDom(); return; }
        if (current.detail) current.detail.assetView = view;
        try {
          T().freezeDescendants(view);
          if (!fillFriendGearTabs(view, foe)) openFriendGearsDom();
        } catch (e) {
          if (window.__errs) window.__errs.push('friendGears fill: ' + (e && e.message));
          openFriendGearsDom();
        }
        wireFriendGearsBack(view);
      }).catch((e) => {
        if (window.__errs) window.__errs.push('friendGears asset: ' + (e && e.message));
        openFriendGearsDom();
      });
    };

    if (window.SfRender && SfRender.loadExtra) {
      Promise.all([
        SfRender.loadExtra('tags-challenge.json').catch(() => {}),
        loadGearColorTable().catch(() => {}),
      ]).then(() => { try { go(); } catch (e) { if (window.__errs) window.__errs.push('friendGears go: ' + (e && e.message)); } });
    } else {
      go();
    }
  }

  function closeFriendGearPage() {
    destroyItemDetailOnly();
    try { applyTab(); } catch (e) {}
  }

  function wireFriendGearsBack(view) {
    if (!view || !view.byName || !view.g) return;
    const oldParts = ['7', '9'].map((d) => view.g.querySelector(':scope > [depth="' + d + '"]')).filter(Boolean);
    let btn = view.__friendBackBtn && view.__friendBackBtn.g ? view.__friendBackBtn : null;
    if (!btn && view.attachChild) {
      const made = view.attachChild('3911', 1, 'friend-back');
      if (made && made.g) {
        btn = view.__friendBackBtn = made;
        btn.g.setAttribute('transform', 'matrix(1,0,0,1,160.3,175.5)');
        btn.g.style.cursor = 'pointer';
        btn.g.style.pointerEvents = 'auto';
        const t = T();
        if (t) {
          try { t.measureHitBox(btn); t.popWrap(btn); } catch (e) {}
          const shell = btn.g.querySelector(':scope > g.uc-pop');
          if (shell) t.wirePopPress(shell);
        }
        btn.g.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeFriendGearPage();
        });
      }
    }
    if (btn) {
      for (const n of oldParts) n.style.display = 'none';
      return;
    }
    // 兜底：3911 没进包时，绿按钮本身也要能返回上一页（不能点穿到底下状态页的返回键）。
    for (const n of oldParts) {
      n.style.display = '';
      n.style.cursor = 'pointer';
      n.style.pointerEvents = 'auto';
      if (n.__fgBack) continue;
      n.__fgBack = true;
      n.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeFriendGearPage(); });
    }
    for (const name of ['button1', 'back']) {
      const c = view.byName(name);
      if (!c || !c.g) continue;
      c.g.style.cursor = 'pointer';
      c.g.style.pointerEvents = 'auto';
      if (c.__fgBack) break;
      c.__fgBack = true;
      c.g.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeFriendGearPage(); });
      break;
    }
  }

  function openFriendGearsDom() {
    const foe = Friend();
    if (!foe || !current) return;
    const host = detailHost();
    if (!host) return;
    const m = detailMapper(host);
    if (!m) return;
    const b = FRIEND_GEAR_BOX;
    const pos = (r) => 'position:absolute;left:' + m.x(r.x).toFixed(2) + 'px;top:' + m.y(r.y).toFixed(2) + 'px;width:' + m.s(r.w).toFixed(2) + 'px;' +
      (r.h ? 'height:' + m.s(r.h).toFixed(2) + 'px;' : '');
    let dom = host.querySelector('.sf-detail');
    if (!dom) { dom = document.createElement('div'); dom.className = 'sf-detail'; host.appendChild(dom); }
    current.detail = current.detail || {};
    current.detail.dom = dom;
    dom.style.setProperty('--u', m.s(1).toFixed(3) + 'px');
    const byType = [];
    for (const g of (foe.gears || [])) {
      const ty = Number(g && g.type != null ? g.type : (State.gearPart ? State.gearPart(g.id) : NaN));
      if (!Number.isFinite(ty)) continue;
      if (byType[ty] === undefined) byType[ty] = g;
    }
    const C = window.UI && UI.classic;
    const gearName = (g) => (g && C && C.gearName ? C.gearName(Number(g.id)) : ('装备' + (g ? g.id : '')));
    const rows = [0, 1, 2, 3].map((ty) => {
      const g = byType[ty];
      const lv = g ? Math.max(1, Number(g.ext) || 1) : 0;
      const gearImg = g
        ? ((window.UI && UI.classic && UI.classic.gearIconSrc)
          ? UI.classic.gearIconSrc(g.id)
          : 'images/ui/icons/gear/gear-' + Number(g.id) + '.png')
        : '';
      return '<li class="' + (g ? '' : 'none') + '">' +
        '<span class="sf-fd-icon gear" data-img="' + gearImg + '"></span>' +
        '<b>' + esc2(g ? gearName(g) : '（未穿戴）') + '</b>' +
        '<i>' + esc2(GEAR_PART_NAME[ty] || '') + (g ? ('　+' + lv) : '') + '</i></li>';
    }).join('');
    const stats = ['力|power', '敏|agility', '速|speed', '命|hp'].map((pair) => {
      const kv = pair.split('|');
      return statRow(kv[0], Math.max(0, Math.round(Number(foe[kv[1]]) || 0)), m);
    }).join('') + statRow('战斗力', totalHarmOf(foe), m);
    dom.innerHTML =
      '<div class="sf-d-panel" style="' + pos(b) + '"></div>' +
      '<div class="sf-fg-head" style="' + pos({ x: b.x + 8, y: b.y + 6, w: b.w - 16, h: 24 }) + '">' +
        '<b>' + esc2(foe.name || '') + '</b><span>Lv' + esc2(foe.level || 1) + '　查看装备</span></div>' +
      '<div class="sf-fg-stats" style="' + pos({ x: b.x + 10, y: b.y + 34, w: b.w - 20, h: 20 }) + '">' + stats + '</div>' +
      '<div class="sf-fg-label" style="' + pos({ x: b.x + 12, y: b.y + 58, w: 60, h: 14 }) + '">身上穿的</div>' +
      '<ul class="sf-fg-list" style="' + pos({ x: b.x + 10, y: b.y + 74, w: b.w - 20, h: 60 }) + '">' + rows + '</ul>' +
      '<button class="sf-d-back" style="' + pos({ x: b.x + (b.w - 76) / 2, y: b.y + b.h - 24, w: 76, h: 18 }) + '">返回</button>';
    for (const box of dom.querySelectorAll('.sf-fd-icon')) {
      const img = box.getAttribute('data-img');
      if (img) box.innerHTML = '<img alt="" src="' + img + '">';
    }
    const bk = dom.querySelector('.sf-d-back');
    if (bk) bk.addEventListener('click', () => { destroyItemDetailOnly(); try { applyTab(); } catch (e) {} });
  }
  // 对手的战斗力（原版 `user.totalharm`）：所有武器伤害上限之和 —— 与挑战页同一份算法。
  function totalHarmOf(foe) {
    let sum = 0;
    for (const w of (foe && foe.weapons) || []) {
      try { const inst = State.weaponInst(w); if (inst) sum += Number(inst.harmHi) || 0; } catch (e) {}
    }
    return sum;
  }

  // 「更换装备」= 原版那一页（库元件「状态1」= 4673 的第 3 帧）
  // ⚠ `c1` 这个名字在导出里丢了：深度 33 那条放置没有 `na`，其余 5 格都有 ——
  // ⚠ `t_1`..`t_6` 的框只有 54~57 个单位宽、字号 12 → 一行只放得下 4 个全角字
  const GEAR_FRAME_LIST = 3, GEAR_FRAME_DETAIL = 4;
  const GEAR_PAGE_SIZE = 6;
  const GEAR_CELL_DEPTHS = [33, 35, 37, 39, 41, 43];

  const GEAR_DOLL_PARTS = [['mc_head', 0], ['mc_hand', 1], ['mc_body', 2], ['mc_foot', 3]];

  const GEAR_QUALITY_COLOR = ['#542201', '#65a844', '#2365c9', '#6544a8', '#ff9900', '#000000'];
  // `doShowEquipInfo`（:7926-7945）的部位文案 —— 注意这里叫「手部」，与状态页的 `GEAR_PART_NAME` 不同。
  const GEAR_DETAIL_PART = ['头部', '手部', '身体', '脚部'];

  const GEAR_NAME_COLS = 4;
  let gearPage = null;

  // 那种完整对象，并把数值字段清零；列表 / 详情 / 纸娃娃都复用玩家页的绘制函数。
  function heroGearSlots() {
    const hero = Hero();
    const slots = [0, 0, 0, 0];
    for (const raw of ((hero && hero.appearance) || [])) {
      const item = (raw && typeof raw === 'object') ? raw : { id: Number(raw) };
      const id = Number(item.id);
      if (!(id > 0)) continue;
      let type = Number.isFinite(Number(item.type)) ? Number(item.type) : NaN;
      if (!Number.isInteger(type) && window.State && State.gearPart) type = Number(State.gearPart(id));
      if (Number.isInteger(type) && type >= 0 && type <= 3 && !slots[type]) slots[type] = id;
    }
    return slots;
  }
  function heroGearRows() {
    const hero = Hero();
    if (!hero) return [];
    const slots = heroGearSlots();
    const sig = slots.join(',');
    if (hero.__gearRowsSig === sig && Array.isArray(hero.__gearRows)) return hero.__gearRows;
    const worn = new Set(slots.filter((id) => id > 0).map(Number));
    const base = Array.isArray(hero.gearList) ? hero.gearList : [];
    const rows = base.map((it) => {
      const id = Number(it && it.id);
      let inst = null;
      try { inst = (id > 0 && State.gearInst) ? State.gearInst(id) : null; } catch (e) { inst = null; }
      const g = Object.assign({}, inst || {}, it || {});
      g.key = 'hero:' + id;
      g.id = id;
      g.type = Number(it && it.type != null ? it.type : g.type);
      if (!Number.isFinite(g.type) && State.gearPart) g.type = Number(State.gearPart(id));
      g.quality = Math.max(0, Math.min(5, Number(it && it.quality != null ? it.quality : g.quality) || 0));
      g.setId = Number(it && it.setId != null ? it.setId : g.setId) || 0;
      g.name = String((it && it.name) || g.name || '');
      g.attrName = String((inst && inst.attrName) || g.attrName || '');
      g.useLevel = Math.max(1, Number((inst && inst.useLevel) || g.useLevel) || 1);

      g.abilityVal = 0;
      g.ext = [];
      g.gem = null;
      g.used = worn.has(id);
      return g;
    }).filter((g) => Number(g.id) > 0 && Number.isInteger(Number(g.type)));
    hero.__gearRows = rows;
    hero.__gearRowsSig = sig;
    return rows;
  }

  function heroGearEquip(id, equip) {
    const hero = Hero();
    if (!hero) return false;
    const gearId = Number(id);
    const rows = heroGearRows();
    const target = rows.find((g) => Number(g.id) === gearId);
    if (!target) return false;
    const slots = heroGearSlots();
    const type = Number(target.type);
    if (!Number.isInteger(type) || type < 0 || type > 3) return false;
    if (equip) slots[type] = gearId;
    else if (Number(slots[type]) === gearId) slots[type] = 0;
    const next = [];
    for (const slotId of slots) {
      if (!(slotId > 0)) continue;
      const g = rows.find((x) => Number(x.id) === Number(slotId));
      if (g) next.push({ id: g.id, type: g.type, quality: g.quality, ext: [] });
    }
    const out = typeof hero.onEquip === 'function' ? hero.onEquip(next) : next;
    if (Array.isArray(out)) hero.appearance = out;
    // 换装层是盖在状态页上的，底页一直开着：立绘（`fillValues`）和右上角
    // 「出发准备」卡里的外观 X / 4（`refreshHeroChrome`）都要当场重算。
    try {
      if (current && current.view) {
        fillValues(current.view);
        refreshHeroChrome();
      }
    } catch (e) {}
    return true;
  }
  function gearListOf() {
    if (heroView()) return heroGearRows();
    try { return State.gearsInDisplayOrder ? State.gearsInDisplayOrder() : State.myGears() || []; } catch (e) { return []; }
  }

  function gearWornOf() {
    const out = [null, null, null, null];
    if (heroView()) {
      const rows = heroGearRows();
      heroGearSlots().forEach((id, type) => {
        if (!(id > 0)) return;
        out[type] = rows.find((g) => Number(g.id) === Number(id)) ||
          { id: Number(id), type: type, quality: 0, ext: [] };
      });
      return out;
    }
    try {
      for (const g of (State.myGears() || [])) {
        const ty = Number(g.type);
        if (g.used && ty >= 0 && ty < 4 && !out[ty]) out[ty] = g;
      }
    } catch (e) {}
    return out;
  }
  function gearNameText(g) {
    const C = window.UI && UI.classic;
    let fallback = '';
    try {
      if (C && C.gearName) {
        const name = C.gearName(Number(g.id));

        if (name && !/^装备\s*\d+$/.test(String(name))) return name;
        fallback = String(name || '');
      }
    } catch (e) {}
    return String((g && g.name) || '') || fallback;
  }

  function gearNameLines(name) {
    const s = String(name == null ? '' : name);
    if (s.length <= GEAR_NAME_COLS) return s;
    const lines = [];
    for (let i = 0; i < s.length && lines.length < 2; i += GEAR_NAME_COLS) lines.push(s.slice(i, i + GEAR_NAME_COLS));
    return lines.join('\n');
  }
  // 改一个文本字段的字色（`setEquipTextColor`）。必须在 `setText` 之后调 ——
  function setGearTextColor(node, quality) {
    const g = node && (node.g || node);
    if (!g || !g.querySelectorAll) return;
    const color = GEAR_QUALITY_COLOR[Math.max(0, Math.min(5, Number(quality) || 0))];
    for (const t of g.querySelectorAll('text')) t.setAttribute('fill', color);
  }

  function fitArtwork(clip, box, cx, cy, retry) {
    if (!clip || !clip.setExtraTransform || !clip.g) return false;
    clip.setExtraTransform('');
    let b = null;
    try { b = clip.g.getBBox(); } catch (e) { b = null; }
    if (!b || !(b.width > 0) || !(b.height > 0)) {
      if (!retry && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { try { fitArtwork(clip, box, cx, cy, true); } catch (e) {} });
      }
      return false;
    }
    const s = Math.min(box / b.width, box / b.height);
    const mx = b.x + b.width / 2, my = b.y + b.height / 2;
    clip.setExtraTransform('translate(' + (cx - s * mx).toFixed(2) + ',' + (cy - s * my).toFixed(2) +
      ') scale(' + s.toFixed(4) + ')');
    return true;
  }

  const GEAR_CARD = 41.3, GEAR_CARD_ART = 34;
  const GEAR_SLOT_CARD = 34.1, GEAR_SLOT_ART = 29;
  const GEAR_CARD_MID = GEAR_CARD / 2, GEAR_SLOT_MID = GEAR_SLOT_CARD / 2;
  // 装备卡里的画稿 = 原版按品质预上色的库元件（`convertLink(equip)`，MainMovie.as:16114）。
  // ⚠ 这些符号是整张卡，不是单纯一件装备的画稿：第一层就是 41×41 见方的卡面
  // `gear-colors.json` 是生成器按原版规则算好的 `byGear[id][品质][强化档] → 元件号`，
  let gearColorTable = null;
  let gearColorLoading = null;
  async function loadGearColorTable() {
    if (gearColorTable !== null) return gearColorTable;

    if (gearColorLoading) return gearColorLoading;
    gearColorLoading = (async () => {
      const table = {};
      try {
        await SfRender.loadExtra('tags-gear-color.json');
        const j = await SfRender.loadTable('gear-colors.json');
        if (j && j.byGear) return j;
      } catch (e) { /* 素材没生成时退回通用容器 */ }
      return table;
    })();
    try { gearColorTable = await gearColorLoading; }
    finally { gearColorLoading = null; }
    return gearColorTable;
  }

  function gearExtMaxLevel(gear) {
    let max = 0;
    for (const e of (Array.isArray(gear && gear.ext) ? gear.ext : [])) {
      max = Math.max(max, Number(e && e.level) || 0);
    }
    return Math.max(0, Math.min(3, max));
  }
  function gearColorId(gear) {
    if (!gear || !gearColorTable || !gearColorTable.byGear) return null;
    const table = gearColorTable.byGear[String(gear.id)];
    if (!table) return null;

    const q = gear.orange === true ? 4 : Math.max(0, Math.min(5, Number(gear.quality) || 0));
    const levels = table[String(q)];
    if (!levels) return null;

    const lv = ((Number(gear.type) === 0 || Number(gear.type) === 1) && q > 1)
      ? gearExtMaxLevel(gear) : 0;
    return levels[String(lv)] || levels['0'] || levels['1'] || levels['2'] || levels['3'] || null;
  }

  function paintGearCard(cell, gear) {
    try {
      if (!cell || !cell.attachChild || !gear) return false;
      const g = Object.assign({}, gear);
      if (g.type == null) g.type = State.gearPart ? State.gearPart(Number(g.id)) : NaN;
      if (g.quality == null) g.quality = State.gearQuality ? State.gearQuality(gear) : 0;
      const sid = gearColorId(g);
      if (!sid) return false;
      if (cell.detachAll) cell.detachAll();
      return !!cell.attachChild(String(sid), 1, 'gear');
    } catch (e) { return false; }
  }

  function gearFallbackArt(cell, gear, box, cx, cy) {
    const info = wearInfo(gear);
    const sym = containerIds && containerIds[Number(gear.type)] && containerIds[Number(gear.type)][0];
    if (!info || !sym || !cell || !cell.attachChild) return null;
    const child = cell.attachChild(sym, info.frame, 'wear');
    if (child) fitArtwork(child, box, cx, cy);
    return child;
  }

  function gearArtIn(cell, gear, box, cx, cy, iconScale) {
    if (!cell || !cell.attachChild || !gear) return null;
    const sid = gearColorId(gear);
    if (sid) {
      const clip = cell.attachChild(String(sid), 1, 'gear');
      if (clip) {
        const s = Number(iconScale);
        if (Number.isFinite(s) && s > 0 && s !== 1) clip.setExtraTransform('scale(' + s + ')');
        return clip;
      }
    }
    return gearFallbackArt(cell, gear, box, cx, cy);
  }

  function boxInParent(clip) {
    if (!clip || !clip.g || !clip.g.getBBox) return null;
    let b = null;
    try { b = clip.g.getBBox(); } catch (e) { return null; }
    if (!b || !b.width || !b.height) return null;
    const m = String(clip.g.__baseMa || '').split(',').map(Number);
    const k = (m.length === 6 && isFinite(m[0]) && m[0]) ? Math.abs(m[0]) : 1;
    return { x: b.x * k, y: b.y * k, w: b.width * k, h: b.height * k };
  }

  function fitIntoCard(card, child, boxClip, ratio, fallback) {
    if (!card || !child) return;
    const b = boxInParent(boxClip);
    const w = (b && b.w) ? b.w : (fallback || GEAR_CARD);
    const h = (b && b.h) ? b.h : (fallback || GEAR_CARD);
    const cx = b ? b.x + b.w / 2 : w / 2;
    const cy = b ? b.y + b.h / 2 : h / 2;
    fitArtwork(child, ratio * Math.min(w, h), cx, cy);
  }

  function gearCell(i) {
    const view = gearPage && gearPage.view;
    if (!view) return null;
    const named = clipOf(view, 'c' + (i + 1));
    if (named) return named;
    const rec = view.nodes && view.nodes.get(GEAR_CELL_DEPTHS[i]);
    return (rec && rec.clip) || null;
  }
  // 「刚拿到的装备」焦点：融合产物是追加到 S.gears 末尾的，而这一页按
  // 「穿着中 > 获得顺序」排、每页只有 6 格、每次打开都从第 1 页开始 ——
  let pendingGearFocus = null;

  function gearPageHost() {
    if (gearPage && gearPage.host && gearPage.host.isConnected) return gearPage.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub ssfight-view';
    el.setAttribute('aria-label', '我的装备');
    ui.appendChild(el);
    return el;
  }

  function destroyGearPage() {
    const rec = gearPage;
    gearPage = null;

    pendingGearFocus = null;
    if (!rec) return;
    if (rec.view) { try { rec.view.destroy(); } catch (e) {} }
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
  }

  function closeGearPage() {
    destroyGearPage();
    try {
      const v = current && current.view;
      if (v && v.setStaticPolicy) T().setStaticPolicy(v, {});
      if (current && current.view) fillValues(current.view);
      if (heroView()) refreshHeroChrome();
    } catch (e) {}
  }

  async function mountGearFrame(frame) {

    try { await loadGearColorTable(); } catch (e) {}
    const host = gearPageHost();
    if (!host) return null;
    if (!gearPage) gearPage = { host: host, view: null, page: 0 };
    else gearPage.host = host;
    if (gearPage.view) { try { gearPage.view.destroy(); } catch (e) {} gearPage.view = null; }
    while (host.firstChild) host.removeChild(host.firstChild);
    const view = await SfRender.mountSymbol(host, '4673', {
      frame: frame, label: frame === GEAR_FRAME_DETAIL ? '装备详情' : '我的装备',
    });
    if (!gearPage || gearPage.host !== host || host.isConnected === false) { view.destroy(); return null; }

    T().freezeDescendants(view);
    gearPage.view = view;
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    return view;
  }

  function fillGearPage(view) {
    if (!view || !gearPage) return;
    const t = T();
    const list = gearListOf();
    const pages = Math.max(1, Math.ceil(list.length / GEAR_PAGE_SIZE));
    gearPage.page = Math.max(0, Math.min(Math.max(0, gearPage.page), pages - 1));
    const page = gearPage.page;
    let shown = 0;
    for (let i = 0; i < GEAR_PAGE_SIZE; i++) {
      const g = list[page * GEAR_PAGE_SIZE + i] || null;
      const cell = gearCell(i);
      const label = clipOf(view, 't_' + (i + 1));
      const icon = clipOf(view, 'icon' + (i + 1));

      if (cell && cell.g && cell.g.classList) {
        cell.g.classList.toggle('sf-gear-new', !!(gearPage.highlight && g && String(g.key) === String(gearPage.highlight)));
      }

      stopAt(icon, g && g.used ? 1 : 2);
      if (t && label) t.setText(label, g ? gearNameLines(gearNameText(g)) : '');
      if (label) setGearTextColor(label, g ? g.quality : 0);
      if (cell) cell.__gearKey = g ? String(g.key) : null;
      if (g) shown++;

      if (!cell || !cell.detachAll) continue;
      cell.detachAll();

      delete cell.__hitBox;
      if (t && t.measureHitBox) t.measureHitBox(cell);
      if (!g) continue;
      gearArtIn(cell, g, GEAR_CARD_ART, GEAR_CARD_MID, GEAR_CARD_MID);
    }
    // 纸娃娃：`showWears()` 把四件"穿着中"的预上色符号挂到四个部位上
    // ⚠ 部位格自己只有一帧（`buildFrames` 只切出 1 帧：`4558` + `tp:1` + 尾部的 remove），
    const worn = gearWornOf();
    for (const pair of GEAR_DOLL_PARTS) {
      const clip = clipOf(view, pair[0]);
      if (!clip || !clip.detachAll) continue;
      clip.detachAll();
      const g = worn[pair[1]];
      if (!g) continue;
      gearArtIn(clip, g, GEAR_SLOT_ART, GEAR_SLOT_MID, GEAR_SLOT_MID, 0.85);
    }
    setTextByName(view, 't_count', heroView()
      ? ('外观' + list.length + '件')
      : ('容量' + list.length + '/' + State.gearCapacity()));
    // 顶部那句提示（4673 f3 深度 85，没有实例名）：玩家页保留原版「附加属性不叠加」，
    // 勇者页改成「只改变造型、全部 0 加成」—— 装备数值在这里被清零，不能再让玩家误会。
    // 这颗文本字段没有 `na`、也不在 `view.nodes` 的具名表里，直接按 SVG 文本内容改。
    if (heroView() && view.root && view.root.querySelectorAll) {
      for (const node of view.root.querySelectorAll('text')) {
        if (String(node.textContent || '').indexOf('附加属性效果不叠加') >= 0) {
          node.textContent = '外观装备只改变造型，全部属性 0 加成！';
        }
      }
    }

    const canPrev = page > 0, canNext = page < pages - 1;
    stopAt(clipOf(view, 'left'), canPrev ? 1 : 2);
    stopAt(clipOf(view, 'right'), canNext ? 1 : 2);
    setVisible(clipOf(view, 'left'), canPrev);
    setVisible(clipOf(view, 'right'), canNext);
    void shown;
  }

  function wireGearPage(view) {
    const t = T();
    if (!t || !view || !gearPage) return;
    for (let i = 0; i < GEAR_PAGE_SIZE; i++) {
      const cell = gearCell(i);
      if (!cell || !cell.g) continue;
      const key = cell.__gearKey;
      if (!key) {
        t.unregisterHit(cell);
        cell.g.style.cursor = 'default';
        cell.g.style.pointerEvents = 'none';
        continue;
      }
      if (!cell.__gearWired) {
        cell.__gearWired = true;
        cell.g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cell.__gearKey) openGearDetail(cell.__gearKey);
        });
      }
      t.measureHitBox(cell);
      t.popWrap(cell);
      const shell = cell.g.querySelector(':scope > g.uc-pop');
      if (shell) t.wirePopPress(shell);
      // ⚠ 光标与 `pointer-events` 必须排在 `popWrap()` 之后：`popWrap` 把内容搬进
      cell.g.style.cursor = 'pointer';
      cell.g.style.pointerEvents = 'auto';
      raiseAttached(cell);
    }
    wireClickable(clipOf(view, 'left'), {
      hover: 0, press: 0, idle: () => (gearPage && gearPage.page > 0 ? 1 : 2),
      onFire: () => { if (gearPage && gearPage.page > 0) { gearPage.page--; renderGearPage(); } },
    });
    wireClickable(clipOf(view, 'right'), {
      hover: 0, press: 0,
      idle: () => {
        const pages = Math.max(1, Math.ceil(gearListOf().length / GEAR_PAGE_SIZE));
        return (gearPage && gearPage.page < pages - 1) ? 1 : 2;
      },
      onFire: () => {
        const pages = Math.max(1, Math.ceil(gearListOf().length / GEAR_PAGE_SIZE));
        if (gearPage && gearPage.page < pages - 1) { gearPage.page++; renderGearPage(); }
      },
    });
    wireClickable(clipOf(view, 'back'), { hover: 2, onFire: closeGearPage });
  }
  function renderGearPage() {
    if (!gearPage || !gearPage.view) return;
    fillGearPage(gearPage.view);
    wireGearPage(gearPage.view);
  }

  const GEAR_GEM_COST_NOTE = '宝石：镶嵌免费 / 卸下 5 金松果';

  const canSocketGear = (gear) => (State.canSocketGem ? State.canSocketGem(gear) : Number(gear && gear.quality) > 3);
  function currentGearByKey(key) {
    if (heroView()) return heroGearRows().find((g) => String(g.key) === String(key)) || null;
    try { return (State.myGears() || []).find((g) => String(g.key) === String(key)) || null; } catch (e) { return null; }
  }
  async function openGearDetail(key) {
    const g = currentGearByKey(key);
    if (!g) return;
    const view = await mountGearFrame(GEAR_FRAME_DETAIL);
    if (!view) return;
    if (gearPage) gearPage.detail = String(key);
    fillGearDetail(view, g);
    wireGearDetail(view, String(key));
  }

  function fillGearDetail(view, g) {
    const t = T();
    const hero = Hero();
    const ty = Math.max(0, Math.min(3, Number(g.type) || 0));
    // `b_on`：`isWear == "true"` → 第 2 帧（已穿 → 按下去是"卸下"），否则第 1 帧。
    stopAt(clipOf(view, 'b_on'), g.used ? 2 : 1);
    // `b1`：橙装 / 黑装（quality > 3）才有宝石键 —— 有宝石停第 2 帧（= 已镶嵌）、没有停第 1 帧（= 镶嵌）；
    // ⚠ 外层 `b1`（4590）的第 2 帧只是换成另一颗带「已镶嵌」字样的按钮（内层 4589），
    const b1 = clipOf(view, 'b1');
    const sell = clipOf(view, 'b_sell');
    if (b1 && b1.g) b1.g.style.display = hero ? 'none' : '';
    if (sell && sell.g) sell.g.style.display = hero ? 'none' : '';
    if (!hero) {
      const canGem = canSocketGear(g);
      stopAt(b1, canGem ? (g.gem ? 2 : 1) : 3);
      if (canGem && b1 && b1.byName) {
        const inner = b1.byName('b1');
        if (inner) stopAt(inner, g.gem ? 2 : 1);
      }
    }
    const name = clipOf(view, 't_name');
    if (t && name) t.setText(name, gearNameText(g));
    setGearTextColor(name, g.quality);
    setTextByName(view, 'type', GEAR_DETAIL_PART[ty]);
    setTextByName(view, 'level', hero ? '不限' : Math.max(1, Math.round(Number(g.useLevel) || 1)));
    setTextByName(view, 'base', hero ? '0 加成'
      : (String(g.attrName || '') + '+' + Math.max(0, Math.round(Number(g.abilityVal) || 0))));
    if (hero) {
      setTextByName(view, 'baseExtra', '');
      setTextByName(view, 'baseOther', '');
      setTextByName(view, 'baseOtherExtra', '');
    } else {

      let gemText = '';
      if (g.gem) {
        let lv = 0;
        try { lv = State.gemLevel ? State.gemLevel(g.gem.id) : 0; } catch (e) { lv = 0; }
        if (lv > 0) gemText = ' +' + State.gemPercent(lv) + '%';
      }
      setTextByName(view, 'baseExtra', gemText);
      // 附加属性两列（原版 `getAttachmentDesList`）：说明一列有数据，`extraStr` 那列复刻的字典里没有，
      // 所以留空（素材自带作者占位串，必须写空，不能留着）。
      let des = [];
      try { des = State.extText(g.ext) || []; } catch (e) { des = []; }
      let desExtra = [];
      try { desExtra = State.extExtraTextForGear ? State.extExtraTextForGear(g) : []; } catch (e) { desExtra = []; }
      setTextByName(view, 'baseOther', des.join('\n'));
      setTextByName(view, 'baseOtherExtra', desExtra.join('\n'));
    }

    const cell = clipOf(view, 'c1');
    if (cell && cell.detachAll) {
      cell.detachAll();
      gearArtIn(cell, g, GEAR_CARD_ART, GEAR_CARD_MID, GEAR_CARD_MID);
    }
  }
  function wireGearDetail(view, key) {
    const t = T();
    if (!t || !view) return;
    const hero = Hero();
    const backToList = () => { if (gearPage) gearPage.detail = null; void mountGearFrame(GEAR_FRAME_LIST).then(() => renderGearPage()); };

    const onClip = clipOf(view, 'b_on');
    wireClickable(onClip, {
      hover: 0, press: 0,
      idle: () => { const g = currentGearByKey(key); return g && g.used ? 2 : 1; },
      onFire: () => {
        const g = currentGearByKey(key);
        if (!g) { backToList(); return; }
        if (hero) {
          if (!heroGearEquip(g.id, !g.used)) {
            if (window.UI && UI.toast) UI.toast('这件外观暂时不能更换。');
            return;
          }
          // 不要停在详情页。列表重填后小勾 / 纸娃娃会立刻反映新外观。
          backToList();
          return;
        }
        if (g.used) { State.unwear(key); }
        else if (State.wear(key) === false) { if (window.UI && UI.toast) UI.toast('等级不足，暂时无法装备'); return; }

        if (gearPage && gearPage.view) { fillGearDetail(gearPage.view, currentGearByKey(key) || g); wireGearDetail(gearPage.view, key); }
      },
    });
    // 「装备 / 卸下」外层 `b_on` 的第 2 帧是另一颗按钮（装备 ⇄ 卸下），不能拿来做 hover；
    if (onClip && onClip.g && !onClip.__greenHoverWired) {
      onClip.__greenHoverWired = true;
      const setGreen = (on) => {
        const rec = onClip.nodes && onClip.nodes.get(1);
        if (rec && rec.clip) rec.clip.gotoAndStop(on ? 2 : 1);
      };
      onClip.g.addEventListener('mouseenter', () => setGreen(true));
      onClip.g.addEventListener('mouseleave', () => setGreen(false));
    }
    if (!hero) {

      wireClickable(clipOf(view, 'b_sell'), {
        hover: 2, press: 2, idle: 1,
        onFire: () => askSellEquipFromDetail(key, backToList),
      });

      const b1Outer = clipOf(view, 'b1');
      const b1Inner = b1Outer && b1Outer.byName ? (b1Outer.byName('b1') || b1Outer) : b1Outer;
      wireClickable(b1Inner, {
        hover: 2, press: 2,
        idle: () => {
          const g = currentGearByKey(key);
          if (!g || Number(g.quality) <= 3) return 3;
          return g.gem ? 2 : 1;
        },
        onFire: () => { askGemFromDetail(key); },
      });
    }
    wireClickable(clipOf(view, 'b_back'), { hover: 2, onFire: backToList });
  }
  // 详情页的出售确认：售价由 State 在品质区间内随机结算，这里只展示区间。
  function askSellEquipFromDetail(key, backToList) {
    const C = window.UI && UI.classic;
    const g = currentGearByKey(key);
    if (!g) { backToList(); return; }
    const range = State.gearSellRange(Number(g.quality) || 0);
    const after = () => { void mountGearFrame(GEAR_FRAME_LIST).then(() => renderGearPage()); };
    const sell = async () => {
      try {
        const got = await StateCall('sellGear', key, true);
        if (window.UI && UI.toast) UI.toast(got > 0
          ? '卖出【' + gearNameText(g) + '】，获得 ' + got + ' 金松果'
          : '这件装备已不在背包里');
      } catch (e) {
        if (window.UI && UI.toast) UI.toast('出售失败：' + ((e && e.message) || '网络异常'));
      }
      after();
    };
    if (!C || !C.modal) { void sell(); return; }
    C.modal('出售装备', '<p>出售该装备可获得 ' + (range[0] === range[1] ? range[0] : range[0] + '~' + range[1]) + ' 个金松果' + (window.__SSDZ_ONLINE__ ? '（服务器随机）' : '（随机）') + '，确定要继续么？</p>' +
      (g.used ? '<p class="small-label">这件装备正穿戴在身上。</p>' : ''),
      [{ label: '出售', cls: 'gold', run: sell }, { label: '返回', cls: 'muted' }], { small: true });
  }

  function askGemFromDetail(key) {
    const C = window.UI && UI.classic;
    const g = currentGearByKey(key);
    if (!g) return;
    const refresh = () => { if (gearPage && gearPage.view) { fillGearDetail(gearPage.view, currentGearByKey(key) || g); wireGearDetail(gearPage.view, key); } };
    if (!canSocketGear(g)) {
      if (window.UI && UI.toast) UI.toast('只有传说（橙色）或黑色装备才能镶嵌宝石。');
      return;
    }
    if (g.gem) {
      const r = State.unsocketGem(key);
      if (window.UI && UI.toast) UI.toast(r.msg);
      refresh();
      return;
    }
    // ⚠ 不能写 `const S = S() || {}`：局部 `S` 会遮住模块里的 `S()`，
    const save = S() || {};
    const gems = [101, 102, 103, 104, 105, 106, 107].filter((id) => (save.props && save.props[id] > 0));
    if (!gems.length) {
      if (window.UI && UI.toast) UI.toast(window.__SSDZ_ONLINE__
        ? '背包里没有宝石。45级后通关关卡（整轮）有几率获得。'
        : '背包里没有宝石。45级后通关关卡或竞技场获胜有几率获得。');
      return;
    }
    if (!C || !C.modal) return;
    const m = C.modal('选择宝石', '<p class="small-label">' + GEAR_GEM_COST_NOTE + '</p><div class="gem-pick">' +
      gems.map((id) => {
        const item = window.propMap && propMap.getValue ? propMap.getValue(id) : null;
        return '<button type="button" class="help-item" data-gem="' + id + '"><span class="item-icon">' +
          (window.UI && UI.propIcon ? UI.propIcon(id, 64) : '') + '</span><span>' + esc(item ? item.name : ('宝石' + id)) +
          ' ×' + save.props[id] + '</span></button>';
      }).join('') + '</div>', [{ label: '返回', cls: 'muted' }], { small: true });
    const host = m && m.element;
    if (!host) return;
    for (const b of host.querySelectorAll('[data-gem]')) {
      b.onclick = async () => {
        let r;
        try {
          const callGem = window.StateCall || ((name, ...args) => Promise.resolve(State[name](...args)));
          r = await callGem('socketGem', key, Number(b.dataset.gem));
        } catch (e) {
          if (window.UI && UI.toast) UI.toast('镶嵌失败：' + ((e && e.message) || e));
          return;
        }
        if (window.UI && UI.toast) UI.toast((r && r.msg) || '镶嵌失败');
        if (r && r.ok && m.close) m.close();
        refresh();
      };
    }
  }

  async function openGearsPage() {
    if (!current || !current.view) return false;

    if (!heroView()) {

      if (window.SfGuide && SfGuide.onGears) { try { await SfGuide.onGears(); } catch (e) { if (window.__errs) window.__errs.push('guide gears: ' + (e && e.message)); } }
      if (!current || !current.view) return false;
    }

    if (current.detail) destroyItemDetailOnly();
    if (!gearPage) gearPage = { host: null, view: null, page: 0, detail: null };
    gearPage.page = 0;
    gearPage.highlight = null;

    if (!heroView() && pendingGearFocus) {
      const list = gearListOf();
      const at = list.findIndex((g) => String(g.key) === String(pendingGearFocus));
      if (at >= 0) {
        gearPage.page = Math.floor(at / GEAR_PAGE_SIZE);
        gearPage.highlight = String(pendingGearFocus);
      }
      pendingGearFocus = null;
    }
    const view = await mountGearFrame(GEAR_FRAME_LIST);
    if (!view) return false;
    const host = gearPageHost();
    if (host) host.setAttribute('aria-label', heroView() ? '更换装备' : '我的装备');
    renderGearPage();
    return true;
  }

  function focusGear(key) {
    if (heroView()) return null;
    if (key == null || key === '') return null;
    const list = gearListOf();
    const at = list.findIndex((g) => String(g.key) === String(key));
    if (at < 0) return null;
    pendingGearFocus = String(key);
    const pages = Math.max(1, Math.ceil(list.length / GEAR_PAGE_SIZE));
    const page = Math.floor(at / GEAR_PAGE_SIZE) + 1;

    if (gearPage && gearPage.view) {
      gearPage.page = page - 1;
      gearPage.highlight = String(key);
      renderGearPage();
    }
    return { page: page, pages: pages };
  }

  // 「装备融合」= 原版 4673 的第 8 / 9 / 13 帧
  // ⚠ 复刻的融合规则与原件不同（原件按 composeType 分蓝/紫/橙三档、材料页每页 2 件；
  // 复刻经典页是"任意 3 件同品质 → 升一档（不要求同部位）"，费用与校验都在 `State.mergeGears`）——
  const FUSION_FRAME = { work: 8, pick: 9, confirm: 13 };
  const FUSION_QUALITY_NAMES = ['普通', '优秀', '杰出', '卓越', '传说', '黑色'];
  const FUSION_PICK_PER_PAGE = 2;
  let fusionPage = null;
  function fusionCostOf(q) {
    try { return (Number(State.fusionCostOf ? State.fusionCostOf(q) : State.gearCostOf(q)) || 0); } catch (e) { return 0; }
  }
  function fusionHost() {
    if (fusionPage && fusionPage.host && fusionPage.host.isConnected) return fusionPage.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub ssfight-view';
    el.setAttribute('aria-label', '装备融合');
    ui.appendChild(el);
    return el;
  }
  function destroyFusionPage() {
    const rec = fusionPage;
    fusionPage = null;
    destroyFusionOverlay();
    if (!rec) return;
    if (rec.view) { try { rec.view.destroy(); } catch (e) {} }
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
  }

  let fusionOver = null;
  let fusionExtraLoaded = false;
  async function loadFusionExtra() {
    if (fusionExtraLoaded) return true;
    try { await SfRender.loadExtra('tags-fusion.json'); fusionExtraLoaded = true; } catch (e) { return false; }
    return true;
  }
  function fusionOverlayHost() {
    if (!fusionPage) return null;
    if (fusionOver && fusionOver.host && fusionOver.host.isConnected) return fusionOver.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub ssfight-view';
    el.setAttribute('aria-label', '装备融合浮层');
    ui.appendChild(el);
    fusionOver = { host: el, view: null };
    return el;
  }
  async function mountFusionOverlay(host, sym, label) {
    await loadFusionExtra();
    if (!fusionOver || fusionOver.host !== host || host.isConnected === false) return null;
    if (fusionOver.view) { try { fusionOver.view.destroy(); } catch (e) {} fusionOver.view = null; }
    const view = await SfRender.mountSymbol(host, sym, { frame: 1, label: label });
    if (!fusionOver || fusionOver.host !== host) { view.destroy(); return null; }
    T().freezeDescendants(view);
    fusionOver.view = view;
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    return view;
  }
  function destroyFusionOverlay() {
    const rec = fusionOver;
    fusionOver = null;
    if (!rec) return;
    if (rec.view) { try { rec.view.destroy(); } catch (e) {} }
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
  }
  function closeFusionPage() {
    destroyFusionPage();
    try { if (current && current.view) fillValues(current.view); } catch (e) {}
  }
  async function mountFusionFrame(frame) {
    const host = fusionHost();
    if (!host) return null;

    try { await loadGearColorTable(); } catch (e) {}
    if (!fusionPage) fusionPage = { host: host, view: null, frame: frame, sel: [], page: 0 };
    else fusionPage.host = host;
    if (fusionPage.view) { try { fusionPage.view.destroy(); } catch (e) {} fusionPage.view = null; }
    while (host.firstChild) host.removeChild(host.firstChild);
    const view = await SfRender.mountSymbol(host, '4673', {
      frame: frame, label: frame === FUSION_FRAME.pick ? '选择融合材料' : '装备融合',
    });
    if (!fusionPage || fusionPage.host !== host || host.isConnected === false) { view.destroy(); return null; }
    T().freezeDescendants(view);
    fusionPage.view = view;
    fusionPage.frame = frame;
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    return view;
  }
  // 材料清单：未穿戴即可（经典模式没有星标；橙装也可以继续融合成黑装）。
  // 品质高的排前面（黑/橙优先），同品质内仍按获得顺序；否则 50 多件橙装会被
  function fusionMaterials() {
    try {
      return State.gearsInDisplayOrder()
        .filter((g) => !g.used)
        .sort((a, b) => Number(b.quality) - Number(a.quality));
    } catch (e) { return []; }
  }
  function fusionSelected() {
    if (!fusionPage) return [];
    const all = fusionMaterials();
    fusionPage.sel = fusionPage.sel.filter((k) => all.some((g) => g.key === k));
    return fusionPage.sel;
  }


  function rewriteFusionPrompt(view, text) {
    const root = view && (view.g || view);
    if (!root || !root.querySelectorAll) return;
    // 第一次按原画稿文字找；改过之后原文字已经不在了，用自己打的标记认。
    // 否则第二次调用（换材料 / 同套提示切换）会找不到这一组、提示永远停在第一句。
    // ⚠ 找过一次就把节点记在视图上：`textContent` 会把整棵子树拼成字符串，
    let prompt = view.__fusionPrompt;
    if (!prompt || prompt.isConnected === false || !root.contains(prompt)) {
      prompt = root.querySelector('g[data-fusion-prompt="1"]');
      if (!prompt) {
        for (const g of root.querySelectorAll('g')) {
          const txt = String(g.textContent || '').replace(/\s+/g, '');
          if (txt.indexOf('请先放入') >= 0 && txt.indexOf('装备') >= 0) { prompt = g; break; }
        }
      }
      view.__fusionPrompt = prompt || null;
    }
    if (!prompt) return;
    prompt.setAttribute('data-fusion-prompt', '1');
    const glyphs = [...prompt.querySelectorAll('text')];
    if (!glyphs.length) return;
    const first = glyphs[0];
    const keep = {};
    for (const a of ['font-family', 'font-size', 'font-weight', 'fill', 'letter-spacing', 'text-anchor']) {
      const v = first.getAttribute(a);
      if (v != null) keep[a] = v;
    }
    for (const g of glyphs) g.remove();
    const n = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    n.setAttribute('x', '0');
    n.setAttribute('y', '14');
    for (const [a, v] of Object.entries(keep)) n.setAttribute(a, v);
    n.textContent = text || '请先放入3件同品质装备';
    prompt.appendChild(n);
  }

  function fillFusionWork(view) {
    if (!view || !fusionPage) return;
    const all = fusionMaterials();
    const sel = fusionSelected();
    const picked = sel.map((k) => all.find((g) => g.key === k)).filter(Boolean);

    const sameSet = picked.length === 3 && State.fusionFamilyInfo ? State.fusionFamilyInfo(picked) : null;
    rewriteFusionPrompt(view, sameSet
      ? (window.__SSDZ_ONLINE__ ? '同套优先（2%变异）：' : '同套必得：') + sameSet.family
      : '');
    for (let i = 0; i < 3; i++) {
      const cell = clipOf(view, 'c' + (i + 1));
      const back = clipOf(view, 'cBack' + (i + 1));
      const g = picked[i];
      if (cell && cell.detachAll) {
        cell.detachAll();
        if (g) {

          const sid = gearColorId(g);
          const icon = sid ? cell.attachChild(String(sid), 1, 'gear') : null;
          if (icon) {
            icon.setExtraTransform('scale(1.46)');
          } else {
            const info = wearInfo(g);
            const sym = containerIds && containerIds[Number(g.type)] && containerIds[Number(g.type)][0];
            if (info && sym && cell.attachChild) {
              // ⚠ 不能照抄原版的 `c{i}._xscale = 120`：原版 `convertLink()` 给的是位图化的
              fitIntoCard(cell, cell.attachChild(sym, info.frame, 'wear'), back || cell, 0.85, 67);
            }
          }
        }
      }

      setVisible(back, picked.length === 0);
    }
    const tips = clipOf(view, 'mc_tips');
    if (tips) {
      if (!picked.length) {
        const q = 0;
        void q;
        stopAt(tips, 1);
      } else if (picked.length < 3) stopAt(tips, 2);
      else stopAt(tips, 3);
    }
    const cost = clipOf(view, 'mergeCost');
    if (cost) {
      stopAt(cost, 1);
      const q = picked.length ? Number(picked[0].quality) : 0;
      const line = picked.length ? (fusionCostOf(q) + '金松果') : '';
      const field = cost.byName ? cost.byName('cost') : null;
      if (field) setTextByName(cost, 'cost', line);
    }
  }
  function wireFusionWork(view) {
    const t = T();
    if (!t || !view || !fusionPage) return;
    wireClickable(clipOf(view, 'b_choose'), {
      hover: 2, onFire: () => { void openFusionPick(); },
    });
    wireClickable(clipOf(view, 'b_fusion'), {
      hover: 2,
      onFire: () => {
        const sel = fusionSelected();
        if (sel.length !== 3) {
          if (window.UI && UI.toast) UI.toast('请在下列装备中选定 3 件（当前 ' + sel.length + ' 件）');
          void openFusionPick();
          return;
        }
        void openFusionConfirm();
      },
    });
    wireClickable(clipOf(view, 'b_help'), { hover: 2, onFire: fusionHelp });
    wireClickable(clipOf(view, 'b_back'), { hover: 2, onFire: closeFusionPage });
  }
  // 「帮助」：原件是 `showFusionHelp()`（`MainMovie.as:8269`）→
  // 文案 `helpWords` 是服务端下发的（本地源码里没有内容），所以这里用复刻自己的融合规则写。

  function wrapFusionHelp(text) {
    const out = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
      if (!para) { out.push(''); continue; }
      for (let i = 0; i < para.length; i += 21) out.push(para.slice(i, i + 21));
    }
    return out.join('\n');
  }
  let fusionHelpPage = 0;
  async function fusionHelp() {
    try {
      return await fusionHelpOpen();
    } catch (e) {
      if (window.__errs) window.__errs.push('fusion help: ' + (e && e.message));
      return false;
    }
  }
  async function fusionHelpOpen() {
    const host = fusionOverlayHost();
    if (!host) return false;
    const view = await mountFusionOverlay(host, '3157', '装备融合帮助');
    if (!view) return;
    const C = window.UI && UI.classic;
    const extInherit = Math.round((Number(State.FUSION_EXT_INHERIT_RATE) || 0) * 100);
    const extUpgrade = Math.round((Number(State.FUSION_EXT_UPGRADE_RATE) || 0) * 100);
    const words = window.__SSDZ_ONLINE__ ? [
      '选 3 件同品质的未穿戴、未加星标装备，融合费用按材料品质：白 ' + fusionCostOf(0) + ' / 绿 ' + fusionCostOf(1) +
        ' / 蓝 ' + fusionCostOf(2) + ' / 紫 ' + fusionCostOf(3) + ' / 橙 ' + fusionCostOf(4) +
        ' / 黑 ' + fusionCostOf(5) + ' 金松果。',
      '产物部位从三件材料中随机选取；同套材料优先同套下一档；有可用变异目标时 2% 变异：紫「狂战/深海/机器猫」、橙/黑「狂战/怒战/深海/机器猫」。',
      '按星级从高到低继承前两条，同星级按选取材料和词条的顺序排列。',
      '第三条从其余材料词条中随机选取；每条继承后有 ' + extUpgrade + '% 概率升 1 星，最高三星。低品质装备按已有词条槽位继承。',
      '黑色装备可继续融合；同名词条只保留一条（取最高星），不会出现两行同名。',
    ] : [
      '选 3 件同品质的未穿戴装备，融合成 1 件更高品质的装备。',
      '费用按材料品质：白 ' + fusionCostOf(0) + ' / 绿 ' + fusionCostOf(1) + ' / 蓝 ' + fusionCostOf(2) +
        ' / 紫 ' + fusionCostOf(3) + ' / 橙 ' + fusionCostOf(4) + ' / 黑 ' + fusionCostOf(5) + ' 金松果。',
      '已穿戴的装备不能作为材料；部位和名字可以完全不同。',
      '3 件同品质的紫装可以融成一件传说装备；3 件橙色装备可以融成一件黑色装备；融合成功率 100%。',
      '三件材料同属一套（如狂战头盔/拳甲/铠甲）且该套有下一品质档时，产物必定是同套装的下一品质、首件材料部位；该套没有下一品质档（早期白/绿套）或材料跨套时按随机规则。品质 5 的黑装已是最高档，三件黑装仍按同部位洗练。融合时有低概率变异成紫/橙/黑档的狂战、怒战、深海、机器猫。',
      '部位和名字可以完全不同。产物的每个词条都有 ' + extInherit + '% 概率从三件材料的词条里继承；' +
        '继承到的词条取材料里的最高星级，另有 ' + extUpgrade + '% 概率再升 1 星（最高 3 星）。',
    ];
    fusionHelpPage = 0;
    const pager = (list) => {
      const page = Math.max(0, Math.min(fusionHelpPage, list.length - 1));
      fusionHelpPage = page;
      setTextByName(view, 'text1', wrapFusionHelp(list[page]));
      const l = clipOf(view, 'left'), r = clipOf(view, 'right');
      setVisible(l, page > 0);
      setVisible(r, page < list.length - 1);
      return { page: page, total: list.length };
    };
    pager(words);
    const turn = (dir) => {
      const next = fusionHelpPage + dir;
      if (next < 0 || next >= words.length) return;
      fusionHelpPage = next;
      pager(words);
    };
    for (const [name, dir] of [['left', -1], ['right', 1]]) {
      const clip = clipOf(view, name);
      if (!clip || !clip.g) continue;
      clip.g.style.cursor = 'pointer';
      clip.g.style.pointerEvents = 'auto';
      clip.g.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); turn(dir); });
    }
    const close = clipOf(view, 'button1');
    wireClickable(close, { hover: 2, press: 2, idle: 1, onFire: () => destroyFusionOverlay() });
    void C;
    return true;
  }

  function fillFusionPick(view) {
    if (!view || !fusionPage) return;
    const all = fusionMaterials();
    const pages = Math.max(1, Math.ceil(all.length / FUSION_PICK_PER_PAGE));
    fusionPage.page = Math.max(0, Math.min(fusionPage.page, pages - 1));
    const sel = fusionSelected();
    for (let i = 0; i < FUSION_PICK_PER_PAGE; i++) {
      const g = all[fusionPage.page * FUSION_PICK_PER_PAGE + i];
      const card = clipOf(view, 'c' + (i + 1));
      const tick = clipOf(view, 'cs' + (i + 1));
      const mark = clipOf(view, 'mc_' + (i + 1));
      const chosen = !!(g && sel.indexOf(g.key) >= 0);
      if (mark) {
        stopAt(mark, g ? (chosen ? 2 : 1) : 3);

        const inner = mark.byName ? mark.byName('mc_1') : null;
        if (inner) stopAt(inner, g ? (chosen ? 2 : 1) : 1);
      }
      if (tick) stopAt(tick, chosen ? 1 : 2);
      setTextByName(view, 't_name' + (i + 1), g ? gearNameText(g) : '');
      const label = clipOf(view, 't_name' + (i + 1));
      if (label) setGearTextColor(label, g ? g.quality : 0);
      // 原版 t_base 是单行字段，拆行会压住 t_addr 的第一条词条。框宽仍放开裁切。
      setTextByName(view, 't_base' + (i + 1), g ? State.gearAttrText(g, { name: true }) : '', { noClip: true });
      let addr = [];
      try { addr = (g && State.extTextForGear ? State.extTextForGear(g) : (g ? State.extText(g.ext) : [])) || []; } catch (e) { addr = []; }
      setTextByName(view, 't_addr' + (i + 1), addr.join('\n'));
      if (card) {
        card.__gearKey = g ? String(g.key) : null;
        if (card.detachAll) {
          card.detachAll();
          if (g) {

            const sid = gearColorId(g);
            const icon = sid ? card.attachChild(String(sid), 1, 'gear') : null;
            if (!icon) {
              const info = wearInfo(g);
              const sym = containerIds && containerIds[Number(g.type)] && containerIds[Number(g.type)][0];
              if (info && sym && card.attachChild) {
                fitIntoCard(card, card.attachChild(sym, info.frame, 'wear'), null, 0.87, GEAR_CARD);
              }
            }
          }
        }
      }
    }
    setTextByName(view, 'require', '请在下列装备中选定3件。已选 ' + sel.length + '/3');
    const canPrev = fusionPage.page > 0, canNext = fusionPage.page < pages - 1;
    stopAt(clipOf(view, 'left'), canPrev ? 1 : 2);
    stopAt(clipOf(view, 'right'), canNext ? 1 : 2);
    setVisible(clipOf(view, 'left'), canPrev);
    setVisible(clipOf(view, 'right'), canNext);
  }
  function wireFusionPick(view) {
    if (!view || !fusionPage) return;
    const back = () => { void mountFusionFrame(FUSION_FRAME.work).then(() => { fillFusionWork(fusionPage && fusionPage.view); wireFusionWork(fusionPage && fusionPage.view); }); };
    for (let i = 0; i < FUSION_PICK_PER_PAGE; i++) {
      const card = clipOf(view, 'c' + (i + 1));
      if (!card || !card.g) continue;
      if (!card.__fusionWired) {
        card.__fusionWired = true;
        card.g.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          const key = card.__gearKey;
          if (!key || !fusionPage) return;
          const at = fusionPage.sel.indexOf(key);
          if (at >= 0) fusionPage.sel.splice(at, 1);
          else if (fusionPage.sel.length >= 3) {
            if (window.UI && UI.toast) UI.toast('每次融合最多只能选择3个装备哦！');
            return;
          } else fusionPage.sel.push(key);
          fillFusionPick(fusionPage.view);
        });
      }
      // ⚠ 光标与 `pointer-events` 必须在工具件之后设：`popWrap()` 会把内容搬进
      const t = T();
      if (t) { t.measureHitBox(card); t.popWrap(card); const shell = card.g.querySelector(':scope > g.uc-pop'); if (shell) t.wirePopPress(shell); }
      card.g.style.cursor = card.__gearKey ? 'pointer' : 'default';
      card.g.style.pointerEvents = card.__gearKey ? 'auto' : 'none';
      const mark = clipOf(view, 'mc_' + (i + 1));
      if (mark && mark.g) {
        mark.g.style.cursor = 'pointer';
        mark.g.style.pointerEvents = 'auto';
        if (!mark.__fusionWired) {
          mark.__fusionWired = true;
          mark.g.addEventListener('mouseenter', () => {
            if (!card.__gearKey) return;
            const chosen = !!(fusionPage && fusionPage.sel.indexOf(card.__gearKey) >= 0);

            if (chosen) stopAt(mark, 2);
            const inner = mark.byName ? mark.byName('mc_1') : null;
            if (inner) stopAt(inner, 2);
          });
          mark.g.addEventListener('mouseleave', () => {
            if (!card.__gearKey) { stopAt(mark, 3); return; }
            const chosen = !!(fusionPage && fusionPage.sel.indexOf(card.__gearKey) >= 0);
            stopAt(mark, chosen ? 2 : 1);
            const inner = mark.byName ? mark.byName('mc_1') : null;
            if (inner) stopAt(inner, chosen ? 2 : 1);
          });
          mark.g.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            card.g.dispatchEvent(new MouseEvent('click', { bubbles: false }));
          });
        }
      }
    }
    const t2 = T();
    if (t2) {
      for (const [name, dir] of [['left', -1], ['right', 1]]) {
        const clip = clipOf(view, name);
        if (!clip || !clip.g) continue;
        if (!clip.__fusionWired) {
          clip.__fusionWired = true;
          clip.g.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            if (!fusionPage || !fusionPage.view) return;
            const pages = Math.max(1, Math.ceil(fusionMaterials().length / FUSION_PICK_PER_PAGE));
            const next = fusionPage.page + dir;
            if (next < 0 || next > pages - 1) return;
            fusionPage.page = next;
            fillFusionPick(fusionPage.view);
          });
        }

        clip.g.style.cursor = clip.g.style.visibility === 'hidden' ? 'default' : 'pointer';
        clip.g.style.pointerEvents = 'auto';
      }
    }
    wireClickable(clipOf(view, 'b_back'), { hover: 2, onFire: back });
  }
  async function openFusionPick() {
    const view = await mountFusionFrame(FUSION_FRAME.pick);
    if (!view) return false;
    fillFusionPick(view);
    wireFusionPick(view);
    return true;
  }

  async function openFusionConfirm() {
    const sel = fusionSelected();
    if (sel.length !== 3) return false;
    const view = await mountFusionFrame(FUSION_FRAME.confirm);
    if (!view) return false;
    const all = fusionMaterials();
    const picked = sel.map((k) => all.find((g) => g.key === k)).filter(Boolean);
    const q = picked.length ? Number(picked[0].quality) : 0;
    const cost = fusionCostOf(q);
    setTextByName(view, 't_tips', '融合即将开始，\n本次需要' + cost + '个金松果。');
    const sameSet = picked.length === 3 && State.fusionFamilyInfo ? State.fusionFamilyInfo(picked) : null;
    const exact = sameSet && State.gearInst ? State.gearInst(sameSet.id) : null;
    setTextByName(view, 'goal', sameSet
      ? (FUSION_QUALITY_NAMES[Math.min(5, sameSet.quality)] || '') + (exact && exact.name ? exact.name : sameSet.family) + '　'
      : (FUSION_QUALITY_NAMES[Math.min(5, q + 1)] || '') + '装备　');
    const back = () => { void mountFusionFrame(FUSION_FRAME.work).then(() => { fillFusionWork(fusionPage && fusionPage.view); wireFusionWork(fusionPage && fusionPage.view); }); };
    wireClickable(clipOf(view, 'b_back'), { hover: 2, onFire: back });
    wireClickable(clipOf(view, 'b_ok'), {
      hover: 2, press: 2,
      onFire: async () => {
        const keys = fusionSelected().slice();
        // 结算规则走 `State`（费用、同品质、穿戴都在那边；经典页不再要求同部位，
        // 也没有星标；橙装可以继续融合成黑装）。联机版融合结果由服务端掷。
        const r = await StateCall('mergeGears', keys, { allowMixedParts: true });
        if (r.ok) {

          destroyFusionOverlay();
          if (fusionPage) fusionPage.sel = [];
          const backToWork = () => mountFusionFrame(FUSION_FRAME.work).then(() => {
            fillFusionWork(fusionPage && fusionPage.view);
            wireFusionWork(fusionPage && fusionPage.view);
          });

          const afterResult = () => {
            const focus = focusGear(r.gear && r.gear.key);
            if (focus && window.UI && UI.toast) {
              UI.toast('【' + gearNameText(r.gear) + '】已放入装备背包（更换装备 第 ' + focus.page + '/' + focus.pages + ' 页）');
            }
            return backToWork();
          };
          if (window.SfCompose && SfCompose.showGearResult) {
            return SfCompose.showGearResult(r.gear, { onClose: afterResult, playCg: true }).then((ok) => {
              if (!ok) return afterResult();
            });
          }
          return afterResult();
        }
        if (window.UI && UI.toast) UI.toast(r.msg);
        back();
      },
    });
    return true;
  }

  async function openFusionPage() {
    if (!current || !current.view) return false;
    if (current.detail) destroyItemDetailOnly();
    if (!fusionPage) fusionPage = { host: null, view: null, frame: FUSION_FRAME.work, sel: [], page: 0 };
    fusionPage.sel = [];
    fusionPage.page = 0;
    const view = await mountFusionFrame(FUSION_FRAME.work);
    if (!view) return false;
    fillFusionWork(view);
    wireFusionWork(view);
    return true;
  }

  window.SfStatus = Object.freeze({
    open: open,

    openFriend: (foe, backTo) => {
      const ui = document.getElementById('ui');
      let host = null;
      if (ui) {
        host = document.createElement('section');
        host.className = 'classic-home ssfight-home sf-friend-view';
        host.setAttribute('aria-label', '松鼠状态');
        ui.appendChild(host);
      }
      const p = open(host, { friend: foe, backTo: backTo, overlay: true });
      if (p && typeof p.then === 'function') {
        return p.then((ok) => {
          if (!ok && host && host.parentNode) host.parentNode.removeChild(host);
          return ok;
        }, (err) => {
          if (host && host.parentNode) host.parentNode.removeChild(host);
          throw err;
        });
      }
      return p;
    },

    openHero: (hero, opts) => {
      const o = opts || {}, ui = document.getElementById('ui');
      if (!ui) return Promise.resolve(false);
      if (!o.overlay) ui.innerHTML = '';
      const host = document.createElement('section');

      host.className = 'classic-home ssfight-home sf-friend-view sf-hero-view ssfight-view';
      host.setAttribute('aria-label', o.label || '勇者');
      ui.appendChild(host);
      const p = open(host, { hero: hero, overlay: true, tab: o.tab });
      if (p && typeof p.then === 'function') {
        return p.then((ok) => {
          if (!ok && host && host.parentNode) host.parentNode.removeChild(host);
          return ok;
        }, (err) => {
          if (host && host.parentNode) host.parentNode.removeChild(host);
          throw err;
        });
      }
      return p;
    },
    // 当前状态页的宿主（调试 / 外部入口用）。
    container: () => (current ? current.container : null),

    gearView: () => (gearPage ? gearPage.view : null),

    showFriendGears: () => { try { openFriendGearsOverlay(); return true; } catch (e) { if (window.__errs) window.__errs.push('friendGears: ' + (e && e.message)); return false; } },

    openGears: () => { try { return openGearsPage(); } catch (e) {
      if (window.__errs) window.__errs.push('gears page: ' + (e && e.message)); return false; } },

    ensureGearColors: () => loadGearColorTable(),
    paintGearCard: (cell, gear) => paintGearCard(cell, gear),

    closeGears: () => { destroyGearPage(); },

    focusGear: (key) => { try { return focusGear(key); } catch (e) { return null; } },

    openFusion: () => { try { return openFusionPage(); } catch (e) {
      if (window.__errs) window.__errs.push('fusion page: ' + (e && e.message)); return false; } },
    closeFusion: () => { destroyFusionPage(); },
    // 融合页的状态快照（回归探针：看的是"这一刻停在哪一帧、选了几件、页号多少"）。
    fusionDebug: () => {
      if (!fusionPage || !fusionPage.view) return null;
      const texts = {};
      for (const n of ['require', 't_name1', 't_name2', 't_base1', 't_base2', 't_tips', 'goal']) {
        const c = clipOf(fusionPage.view, n);
        if (c) texts[n] = String(c.textContent == null ? '' : c.textContent);
      }
      const costClip = clipOf(fusionPage.view, 'mergeCost');
      const costField = costClip && costClip.byName ? costClip.byName('cost') : null;
      const sel = fusionSelected();
      return { frame: fusionPage.frame, page: fusionPage.page, sel: sel.slice(),
        cost: costField ? String(costField.textContent || '') : '',
        marks: [1, 2, 3].map((i) => { const c = clipOf(fusionPage.view, 'mc_' + i) || clipOf(fusionPage.view, 'c' + i); return c ? c.frame : null; }),
        texts: texts };
    },
    // 「更换装备」那一层的状态快照（回归探针：看的是"这一刻画的是哪 6 件、停在第几页"）。
    gearsDebug: () => {
      if (!gearPage || !gearPage.view) return null;
      const list = gearListOf();
      const pages = Math.max(1, Math.ceil(list.length / GEAR_PAGE_SIZE));
      const page = gearPage.page;
      const cells = [];
      for (let i = 0; i < GEAR_PAGE_SIZE; i++) {
        const g = list[page * GEAR_PAGE_SIZE + i] || null;
        cells.push({ key: g ? String(g.key) : null, name: g ? gearNameText(g) : '', used: !!(g && g.used),
          iconFrame: (clipOf(gearPage.view, 'icon' + (i + 1)) || {}).frame });
      }
      const doll = {};
      for (const pair of GEAR_DOLL_PARTS) {
        const clip = clipOf(gearPage.view, pair[0]);
        doll[pair[0]] = clip && clip.__attached ? clip.__attached.length : 0;
      }
      // 页面上的真实文案（文本字段节点自己带 `textContent`）——回归套件据此核对"写了什么"。
      const texts = {};
      for (const n of ['t_count', 't_1', 't_2', 't_3', 't_4', 't_5', 't_6',
        't_name', 'type', 'level', 'base', 'baseExtra', 'baseOther', 'baseOtherExtra']) {
        const c = clipOf(gearPage.view, n);
        if (c) texts[n] = String(c.textContent == null ? '' : c.textContent);
      }
      return { page: page, pages: pages, cells: cells, doll: doll, texts: texts,
        highlight: gearPage.highlight || null,
        detail: gearPage.detail, frame: (gearPage.view.frame | 0) + 1 };
    },
    destroy: destroy,
    refresh: () => { if (current) { fillValues(current.view); if (current.tab !== 'status') applyTab(); else if (heroView()) refreshHeroChrome(); } },
    view: () => (current ? current.view : null),
    current: () => (current ? { tab: current.tab, friend: current.friend ? { name: current.friend.name, level: current.friend.level } : null } : null),

    trace: () => openTrace,
    // 格子数据源快照（调试 / 回归探针）：看的是"这一刻要画哪 10 格"。
    debug: () => {
      if (!current) return null;
      const info = gridInfo();
      return {
        tab: current.tab, friend: current.friend ? current.friend.name : null,
        gridPage: current.gridPage || 0,
        pages: info ? info.pages : null, page: info ? info.page : null,
        items: info ? info.items.map((x) => (x ? (x.id + (x.has ? ':' + x.level : ':-') + (x.icon ? '#' + x.icon : '')) : null)) : null,
      };
    },
  });
})();
