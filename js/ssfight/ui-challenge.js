// 原版挑战页（tiaozhan 帧 7638）：素材来自 images/ssfight/ui/tags-challenge.json。
(function () {
  'use strict';


  const T = () => (window.SfUiMain && window.SfUiMain.toolkit) || null;
  const S = () => (window.State && State.state && State.state()) || null;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


  const TABS = [['tab', 'random'], ['tab1', 'friends'], ['tab2', 'arena'], ['tab3', 'gates']];

  const PAGE = { friends: 1, random: 2, gates: 3, arena: 6 };

  const ARENA = { rules: 4, join: 5, home: 6, menu: 7, ladder: 8 };

  let current = null;
  // 只缓存随机页那一批，和 `current.roster`（各 tab 共用）分开。
  let randomCache = null;
  function onlineAccountId() {
    try { return (window.Net && Net.account && Net.account()) ? String(Net.account().accountId || '') : ''; } catch (e) { return ''; }
  }
  function randomCacheMatches(cache, s) {
    if (!cache) return false;
    const account = onlineAccountId();
    if (account) return String(cache.account || '') === account;
    return cache.state === s;
  }
  let seq = 0;

  const REFRESH_LIMIT = 10;
  const REFRESH_WINDOW = 10 * 60 * 1000;
  let refreshTimer = 0;
  function clearRefreshTimer() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = 0; }
  }
  function refreshState() {
    const s = S(), now = Date.now();
    let rf = (s && s.challengeRefresh) || {};
    if (!Number.isFinite(rf.count) || !Number.isFinite(rf.ts) || now - rf.ts > REFRESH_WINDOW) {
      rf = { count: 0, ts: now };
      if (s) s.challengeRefresh = rf;
    }
    rf.count = Math.max(0, Math.min(REFRESH_LIMIT, Number(rf.count) || 0));
    return rf;
  }
  function refreshRemaining(rf) {
    return Math.max(0, REFRESH_LIMIT - Math.max(0, Number(rf && rf.count) || 0));
  }

  // 关系（原版服务端下发的 `relation`）→ 两套帧号
  // 复刻没有服务端，但存档里本来就有这三种关系（师父 / 徒弟 / 好友），
  const REL = { friend: 0, prentice: 1, master: 2, stranger: 3, dummy: 4 };
  const relOf = (foe) => {
    if (foe && foe.dummy) return REL.dummy;
    // 随机页的对手在原版一律是陌生人：服务端 `getFriends("random")` 把每一条
    if (current && current.tab === 'random') return REL.stranger;
    if (foe && foe.kind === 'master') return REL.master;
    if (foe && foe.kind === 'prentice') return REL.prentice;
    return REL.friend;
  };
  // `s1..s4` 关系标志停哪一帧（原版 `doShowFriends` :13366-13385）。
  // ⚠ 木人走第 3 帧（= 原版那一档的「邀请」话术）：原版把 `relation == 4` 与
  const RELATION_BADGE = { '-2': 5, '-1': 4, '0': 3, '1': 2, '2': 1, '3': 3, '4': 3 };
  function relationFrame(foe) {
    return RELATION_BADGE[String(relOf(foe))] || 3;
  }
  // 动作菜单 `subframe`（4723）的分支（= 原版 `actionType`）
  // ⚠ 复刻以前把两个世界的编号混在一张表里（"case" 用的是自己排的顺序：徒弟 2 / 师父 5 /
  // ⚠ 用 `switch` 而不是查表：`REL` 的取值（friend 0 / prentice 1 / master 2 / stranger 3 /
  const MENU_CASE = (rel) => {
    switch (rel) {
      case REL.master: return 2;
      case REL.prentice: return 3;
      case REL.stranger: return 5;
      case REL.dummy: return 6;
      default: return 1;
    }
  };



  const clipOf = (host, name) => (host && host.byName ? host.byName(name) : null);
  function stopAt(clip, n) {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(n); } catch (e) {}
  }
  function setText(clip, str) {
    const t = T();
    if (t && clip) t.setText(clip, str == null ? '' : String(str));
  }

  function tabClip(view, name) {
    const direct = clipOf(view, name);
    if (direct) return direct;
    const tap = clipOf(view, 'tiaozhanTap');
    return tap && tap.byName ? tap.byName(name) : null;
  }
  // 行内两段文字的落点校正（原版截图逐像素量过，见 docs/更新记录）
  // 复刻的 `<text>` 走的是 `textfields.json` 的字段框公式（见 render.js 的 textNode）。
  // ⚠ 换帧（`gotoAndStop`）会重建文本节点（导出数据里这两条放置带 `rp`），
  const ROW_BADGE = { x0: -1, x1: 18.05, y0: -8.95, y1: 9.45 };
  const LEVEL_MA = { x: 1.9, y: -6.95 };
  const LEVEL_FONT = 14;
  const LEVEL_INK = 0.714;

  const NAME_DY = 3.4;                                            // 昵称相对字段框的下移量（舞台单位）
  const NAME_DX = 1.2;
  const VIP_MAX_LEVEL = 10;
  // 超级松鼠角标在原版里贴著名牌右缘；「玩家 / AI」标签隐藏后把它右移，
  // 让角标落在标签空出来的位置，不再和昵称挤在一起。
  const VIP_BADGE_DX = 12;
  // 「师/徒」行右侧还有关系徽章，角标按 12 右移会盖住它；只有师徒行回到贴边位置，
  // 同一页里的普通好友行仍保持 12。
  const VIP_BADGE_DX_KIN = 0;
  // 带 VIP 角标时昵称要停在角标左边（宽度随角标右移一起放宽）；只对真正超宽的昵称缩字号。
  const VIP_NAME_WIDTH = 90;
  function resetNameFit(clip) {
    const b = clip && clip.__textBox;
    const node = clip && (clip.g || clip);
    if (!b || !(b.__sfFitBase > 0) || !node || !node.querySelectorAll) return;
    for (const t of node.querySelectorAll('text')) t.setAttribute('font-size', String(b.__sfFitBase));
  }
  // `vip1..vip4`（7252）：超级松鼠生效时停第 1 帧，`num` 按等级停 level+1；否则第 2 帧空。
  // 等级来自名单里的实时字段：玩家战斗快照只冻结战斗面板，不冻结 VIP。
  function setRowVip(view, index, item) {
    const clip = clipOf(view, 'vip' + (index + 1));
    if (!clip) return;
    const level = Math.max(0, Math.min(VIP_MAX_LEVEL, Math.floor(Number(item && item.vipLevel) || 0)));
    if (!level) { stopAt(clip, 2); setVisible(clip, false); return; }
    stopAt(clip, 1);
    const num = clip.byName ? clip.byName('num') : null;
    if (num) stopAt(num, Math.min(11, level + 1));
    setVisible(clip, true);
    // 每次显示都重挂偏移：切 tab 会重建 7638 的放置，旧的 __extra 不会跟过来。
    if (clip.setExtraTransform) {
      const kin = !!(item && (item.kind === 'master' || item.kind === 'prentice'));
      clip.setExtraTransform('translate(' + (kin ? VIP_BADGE_DX_KIN : VIP_BADGE_DX) + ',0)');
    }
  }
  function alignRowText(row) {
    if (!row || !row.byName) return;
    const lg = row.byName('flevel');
    const lnode = lg && (lg.g || lg);
    if (lnode && lnode.querySelectorAll) {
      const x = (ROW_BADGE.x0 + ROW_BADGE.x1) / 2 - LEVEL_MA.x;
      const y = (ROW_BADGE.y0 + ROW_BADGE.y1) / 2 - LEVEL_MA.y + (LEVEL_INK * LEVEL_FONT) / 2;
      for (const t of lnode.querySelectorAll('text')) {
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('x', x);
        t.setAttribute('y', y);
      }
    }
    const ng = row.byName('friendname');
    const nnode = ng && (ng.g || ng);
    if (nnode && nnode.querySelectorAll) {
      for (const t of nnode.querySelectorAll('text')) {

        if (t.__rowBaseY == null) t.__rowBaseY = Number(t.getAttribute('y') || 0);
        if (t.__rowBaseX == null) t.__rowBaseX = Number(t.getAttribute('x') || 0);
        t.setAttribute('y', t.__rowBaseY + NAME_DY);
        t.setAttribute('x', t.__rowBaseX + NAME_DX);
      }
    }
  }

  function setVisible(clip, on) {
    if (clip && clip.g) clip.g.style.visibility = on ? '' : 'hidden';
  }

  function refreshShell(clip) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
  }

  function wireClickable(clip, spec) {
    const t = T();
    if (!t || !clip || !clip.g) return;
    spec = spec || {};
    const idleOf = () => (typeof spec.idle === 'function' ? spec.idle() : (spec.idle == null ? 1 : spec.idle));
    clip.__pinFrame = null;
    clip.__chFire = spec.onFire || null;
    clip.__chIdle = idleOf;
    clip.__chAfter = spec.after || null;
    clip.__chHover = Number(spec.hover) || 0;
    clip.__chPress = Number(spec.press) || 0;
    // `onHover`：指针一进来就执行的回调（原版是键盘光标走到哪就选到哪，
    // ⚠ 回调每次 `wireClickable` 都刷新（闭包捕获的行号会变），监听只挂一次。
    clip.__chHoverCb = spec.onHover || null;
    if (!clip.__chListeners) {
      clip.__chListeners = true;
      clip.g.addEventListener('mouseenter', () => {
        if (clip.__chHoverCb) clip.__chHoverCb();
        if (!clip.__chHover) return;
        stopAt(clip, clip.__chHover);
        refreshShell(clip);
        if (clip.__chAfter) clip.__chAfter();
      });
      clip.g.addEventListener('mouseleave', () => {
        stopAt(clip, clip.__chIdle ? clip.__chIdle() : 1);
        refreshShell(clip);
        if (clip.__chAfter) clip.__chAfter();
      });
      clip.g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (clip.__chPress) t.pressFlash(clip, clip.__chIdle ? clip.__chIdle() : 1, () => refreshShell(clip));
        if (clip.__chAfter) clip.__chAfter();
        if (clip.__chFire) clip.__chFire();
      });
    }
    // ⚠ 下面这一段每次调用都要跑：`unwire()` 会把元件从点击路由里摘掉，
    stopAt(clip, idleOf());
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    t.measureHitBox(clip);
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
    if (clip.__chAfter) clip.__chAfter();
  }

  function resetHits(svg) {
    const t = T();
    if (!t || !svg) return;
    const r = t.routerOf(svg);
    r.list.length = 0;
    r.hovered = null;
  }

  // 右侧那块「对手展示」（`rightBg` = 7232）
  // ⚠ 复刻之前从没给 rightBg 拨过帧、也没把它钉住（它在 `skip` 名单里，不参与静默），
  const FACE_PARTS = [
    { type: 0, cells: [['mc_head', 0]] },
    { type: 1, cells: [['mc_fistL', 0], ['mc_fistR', 1]] },
    { type: 2, cells: [['mc_body', 0], ['mc_handL', 1], ['mc_handR', 1]] },
    { type: 3, cells: [['mc_footL', 0], ['mc_footR', 0]] },
  ];
  let gearTables = null;
  async function loadGearTables() {
    if (gearTables) return gearTables;
    const j = (f) => SfRender.loadTable(f).catch(() => null);
    const [frames, slots] = await Promise.all([j('gear-frames.json'), j('gear-slots.json')]);
    if (!frames || !slots) return null;
    const cont = {};
    // showFace 的 mc_head/mc_hand 等挂点使用非 B 立绘容器；B 容器服务战斗骨骼，
    // 注册原点不同，不能共用。缺失立绘表时不拿战斗稿补位。
    for (const c of slots.portraitContainer || []) cont[c.type] = c.ids;
    // 橙装现在有原版 q4 id；旧档的实例 `orange:true` 仍兼容。橙稿帧按同部位同名字的 q4 帧查，
    const keyOf = (g) => Number(g.type) + '|' + String(g.name || '');
    const q4 = new Map();
    for (const g of frames.gear || []) if (Number(g.quality) === 4) q4.set(keyOf(g), g.frame);
    const orangeFrameById = new Map();
    for (const g of frames.gear || []) {
      if (Number(g.quality) !== 3) continue;
      const f = q4.get(keyOf(g));
      if (f) orangeFrameById.set(Number(g.id), f);
    }
    gearTables = { frameById: new Map((frames.gear || []).map((g) => [Number(g.id), g.frame])), orangeFrameById, cont: cont };
    return gearTables;
  }

  // 立绘帧号的唯一映射：showFace 挂装备、悬停签名做短路都读这里。
  // 强化档/橙装规则只改这一处，避免两套帧号算出不同画面。
  function faceFrameOf(type, g) {
    if (!g || !gearTables) return 0;
    const orange = !!(g.orange === true || Number(g.quality) > 3);
    const base = (orange && gearTables.orangeFrameById && gearTables.orangeFrameById.get(Number(g.id))) ||
      gearTables.frameById.get(Number(g.id));
    const raw = g.ext;
    const extMax = Math.max(0, Math.min(3, Array.isArray(raw)
      ? raw.reduce((m, e) => Math.max(m, Number(e && e.level) || 0), 0)
      : Number(raw) || 0));
    const addr = (type === 0 || type === 1) && extMax > 0 ? extMax - 1 : 0;
    return base ? base + addr : 0;
  }
  function showFace(bg, byType) {
    if (!bg || !gearTables) return 0;
    let n = 0;
    for (const row of FACE_PARTS) {
      const g = byType[row.type];
      const frame = faceFrameOf(row.type, g);
      for (const pair of row.cells) {
        const clip = bg.byName ? bg.byName(pair[0]) : null;
        if (!clip || !clip.detachAll) continue;
        clip.detachAll();
        if (!frame) continue;
        const sym = gearTables.cont[row.type] && gearTables.cont[row.type][pair[1]];
        if (!sym) continue;
        if (clip.attachChild(sym, frame, 'wear')) n++;
      }
    }
    return n;
  }
  // 战力（原版 `user.totalharm`）：对手所有武器的伤害上限之和 —— 与战斗里用的同一份数据。
  // 联机快照里的武器是 `{id, level, harmHi}` 对象，存档镜像/离线好友是 `"id:level"` 字符串。
  function totalHarm(foe) {
    let sum = 0;
    for (const w of (foe && foe.weapons) || []) {
      if (w && typeof w === 'object' && Number.isFinite(Number(w.harmHi))) {
        sum += Math.max(0, Number(w.harmHi) || 0);
        continue;
      }
      const raw = (w && typeof w === 'object')
        ? (Number(w.id) + ':' + Math.max(1, Number(w.level) || 1)) : w;
      try { const inst = State.weaponInst(raw); if (inst) sum += Number(inst.harmHi) || 0; } catch (e) {}
    }
    return sum;
  }
  // 右面板的四个数值：原版 `showPic2` 用的是 setText（这四个是文本字段 7220-7223），
  function paintStats(view, foe) {
    const bg = clipOf(view, 'rightBg');
    if (!bg || !bg.byName) return;
    const fields = [['power', 'power'], ['agility', 'agility'], ['speed', 'speed'], ['hp', 'hp']];
    for (const f of fields) {
      const c = bg.byName(f[0]);
      if (c) setText(c, foe ? String(Math.max(0, Math.round(Number(foe[f[1]]) || 0))) : '');
    }
    if (window.SfUiMain) SfUiMain.showNumber(foe ? totalHarm(foe) : 0, bg, 0, 0, 'left', 5);
  }
  // 木桩那一档专用：`rightBg` 的第 3 帧里没有四维字段与战斗力数字精灵，
  // 所以只在字段确实存在时才写（拿不到就什么都不做，不要去 `paintStats` 里空转）。
  function paintStatsIfPresent(view, bg, foe) {
    const hasField = bg.byName && bg.byName('power');
    if (!hasField) return;
    paintStats(view, foe || null);
  }

  // 悬停换行时立绘要挂 8 个装备子元件（每次 attachChild 都要重跑一遍 188 帧的容器），
  // 跟着 pointermove 同步做会把 4 行切换拖成每步几十毫秒。高亮/数值先落地，立绘等指针停一拍。
  let faceSeq = 0, faceTimer = 0;
  function cancelFace() {
    faceSeq++;
    if (faceTimer) { clearTimeout(faceTimer); faceTimer = 0; }
  }
  function scheduleFace(bg, byType, sig) {
    if (faceTimer) { clearTimeout(faceTimer); faceTimer = 0; }
    if (bg.__faceSig === sig) return;
    const seq = ++faceSeq;
    faceTimer = setTimeout(() => {
      faceTimer = 0;
      if (seq !== faceSeq || !bg.g || !bg.g.isConnected) return;
      bg.__faceSig = sig;
      showFace(bg, byType);
    }, 45);
  }
  function showUserPic(view, foe) {
    const bg = clipOf(view, 'rightBg');
    if (!bg) return;
    // ⚠ 测攻击木头人那一行也得走木桩那一档（用户 2026-10 口径："好友页面的测攻击木头人，
    // ⚠ 我最初按"每一帧都是从第 1 帧累积"去读，误以为 f4 才是木桩 —— 那是错的：
    const dummy = !!(foe && (foe.dummy || foe.kind === 'dummy' || foe.kind === 'wood'));
    stopAt(bg, dummy ? 3 : (foe ? 1 : 3));
    refreshShell(bg);
    if (!foe || dummy) {
      // 木桩那一档没有四维字段、也没有战斗力那一排位图数字（f3 里 `hp`/`power`/`num1..5`
      // 都已经被 `rm` 掉了），所以这里不能照常写值 —— `byName` 拿不到就什么也不写。
      cancelFace();
      bg.__faceSig = '';
      paintStatsIfPresent(view, bg, foe);
      return;
    }
    const byType = [];
    for (const g of foe.gears || []) {

      const ty = Number(g.type != null ? g.type : (State.gearPart ? State.gearPart(g.id) : NaN));
      if (!Number.isFinite(ty)) continue;
      if (byType[ty] === undefined) byType[ty] = g;
    }
    // `rightBg` 的帧 + 四个部位的画稿帧 = 立绘是否真的变了；同一行重复进出不重挂。
    const sig = bg.frame + '|' + FACE_PARTS.map((row) => faceFrameOf(row.type, byType[row.type])).join(',');
    scheduleFace(bg, byType, sig);
    paintStats(view, foe);
  }

  // 存档侧的取值（复刻自己的数据模型；原版这些都由服务端下发）

  function rollRoster() {
    const s = S();
    const out = [];
    for (let i = 0; i < 3; i++) {
      try { out.push(State.genAI(Math.max(1, (s ? s.level : 1) + i - 1), '', { levelJitter: 2, minLevel: 1, statScale: State.RANDOM_FOE_SCALE || 1.08 })); }
      catch (e) { out.push(null); }
    }
    return out;
  }
  function friendRoster() {
    const list = (State.friendList ? State.friendList() : []) || [];
    // `gears` / `weapons` 是 `State.addFriend` 存下来的好友自己那套（原版由服务端下发）：
    // 右侧立绘按它贴装备、战斗力按它的武器伤害上限求和。
    // 老档里的好友没有这两个字段 → `ensureFriendLoadout()` 按等级就地补一份并写回存档，
    const friends = list.map((f) => {
      const fr = (State.ensureFriendLoadout ? State.ensureFriendLoadout(f) : f) || f;
      return {
        name: fr.name, level: fr.level, power: fr.power, agility: fr.agility, speed: fr.speed, hp: fr.hp,
        gears: fr.gears || [], weapons: fr.weapons || [], kind: 'friend', friend: true,
      };
    });
    // 这一页的名单 = 师徒 → 木头人 → 好友。师徒与好友是两套关系：
    // 同一个人可以同时出现在「师徒行」和后面的「好友行」（删好友不会拆师徒）。
    const out = [];
    const s = (S() || {});
    const seen = new Set();
    const kinNames = new Map();
    const push = (row, key) => {
      if (!row || !row.name) return;
      const k = key || ('name:' + String(row.name).trim());
      if (seen.has(k)) return;
      seen.add(k);
      out.push(row);
    };
    const markKin = (row, kind) => {
      if (row && row.name) kinNames.set(String(row.name).trim(), kind);
    };
    if (s.master && s.master.name) {
      markKin(s.master, 'master');
      push(foeRow(s.master, 'master'), 'master:' + String(s.master.name).trim());
    }
    for (const p of (s.prentices || [])) {
      markKin(p, 'prentice');
      push(foeRow(p, 'prentice'), 'prentice:' + String(p.name || '').trim());
    }
    push(dummyRow(s), 'dummy');
    for (const f of friends) {
      const kind = kinNames.get(String(f.name || '').trim());
      push(kind ? Object.assign({}, f, { kin: kind }) : f, 'friend:' + String(f.name || '').trim());
    }
    return out;
  }
  // 联机好友页名单：与原版 `friendsArray` / 单机 `friendRoster` 同一排序。
  // 师徒行优先用 `/api/apprentice` 的当前快照（`kin`），拉不到才退回存档镜像。
  function onlineFriendRoster(friends, kin) {
    const s = S() || {};
    const out = [];
    const seen = new Set();
    const kinIds = new Map(), kinNames = new Map();
    const push = (row, key) => {
      if (!row || !row.name) return;
      const k = key || ('name:' + String(row.name).trim());
      if (seen.has(k)) return;
      seen.add(k);
      out.push(row);
    };
    const markKin = (row, kind) => {
      if (!row) return;
      const id = Math.max(0, Math.round(Number(row.accountId != null ? row.accountId : row.realId) || 0));
      if (id) kinIds.set(id, kind);
      if (row.name) kinNames.set(String(row.name).trim(), kind);
    };
    // 以 `/api/apprentice` 的当前快照为准；拉不到才退回存档镜像。
    const known = kin && kin.ok !== false ? kin : null;
    const master = known ? known.master : s.master;
    if (master && master.name) {
      markKin(master, 'master');
      push(foeRow(master, 'master'), 'master:' + (Math.max(0, Number(master.accountId) || 0) || String(master.name).trim()));
    }
    const prentices = known
      ? (Array.isArray(known.prentices) ? known.prentices : [])
      : (s.prentices || []);
    for (const p of prentices) {
      if (!p) continue;
      markKin(p, 'prentice');
      const key = 'prentice:' + (Math.max(0, Number(p.accountId) || 0) || String(p.name || '').trim());
      if (p.stats) {
        push(foeRow(Object.assign({}, p.stats, {
          name: String(p.name || p.stats.name || ''), level: p.level, tag: p.tag,
          accountId: p.accountId, since: p.since, snapshotId: p.snapshotId, vipLevel: p.vipLevel,
        }), 'prentice'), key);
      } else push(foeRow(p, 'prentice'), key);
    }
    push(dummyRow(s), 'dummy');
    // 师徒与好友是两套关系：师徒行照常排在最前，好友行里同一个人再出现一次。
    // 删掉好友只会少这一行，不会拆师徒。
    for (const f of (friends || [])) {
      const id = Math.max(0, Number(f.accountId) || 0);
      const kind = (id && kinIds.get(id)) || kinNames.get(String(f.name || '').trim());
      push(kind ? Object.assign({}, f, { kin: kind }) : f, 'friend:' + (id || String(f.name || '').trim()));
    }
    return out;
  }
  // 师徒条目 → 一行的数据。
  // ⚠ 这里以前有两个真 bug（用户 2026-10 报的"在随机与好友之间切换后，敌我数据全变成 1"）：
  // 再把整套字段（含 `gears` 与装备容器要的 `type`）取出来。
  function foeRow(src, kind) {
    if (!src || !src.name) return null;
    const s = S() || {};
    const lv = Math.max(1, Math.round(Number(src.level) || Number(s.level) || 1));
    // 联机师徒行要能回到真实账号：师父/徒弟的快照与账号 id 在拜师、收徒时就写进存档了。
    const accountId = Math.max(0, Math.round(Number(src.accountId != null ? src.accountId : src.realId) || 0));
    const extra = {
      accountId, realId: accountId, tag: String(src.tag || ''), bot: !!src.bot,
      snapshotId: String(src.snapshotId || ''),
      vipLevel: Math.max(0, Math.min(VIP_MAX_LEVEL, Math.floor(Number(src.vipLevel) || 0))),
    };
    // 师父 / 徒弟是老档里可能只有 `{name, level}` —— 那种情况才现算一份三维
    // （不写回存档：师徒的三维在拜师 / 收徒那一刻就定下来了，
    // 后来补出来的这份只用于显示，不能反过来覆盖存档）。
    if (src.power == null) {
      const rolled = (State.ensureFriendLoadout
        ? State.ensureFriendLoadout({ name: src.name, level: lv })
        : null) || { name: src.name, level: lv };
      return Object.assign({}, rolled, extra, {
        name: src.name, level: lv, kind: kind, friend: kind !== 'dummy', row: src,
        weapons: (rolled.weapons || []).slice(), skills: (rolled.skills || []).slice(),
        gears: (rolled.gears || []).slice(),
      });
    }
    // 有三维（正常路径）：装备按需就地补 —— 补齐的是同一个对象，返回的也是它。
    const full = (State.ensureFriendLoadout ? State.ensureFriendLoadout(src) : src) || src;
    return Object.assign({}, extra, {
      name: src.name, level: lv,
      power: Number(full.power) || 1, agility: Number(full.agility) || 1,
      speed: Number(full.speed) || 1, hp: Number(full.hp) || 1,
      weapons: (full.weapons || []).slice(), skills: (full.skills || []).slice(),
      gears: (full.gears || []).slice(),
      kind: kind, friend: kind !== 'dummy', row: src,
    });
  }
  // 原版那一行就叫 测攻击木头人（`showLevelUp` :7045-7059 在 5 级时塞进好友表）：
  // ⚠ 血量口径：真实抓包 `friends.do` 里是 800；`exercise.do` 里的 200 是本地 stub
  // 生成器（`_analysis/tools/gen_battle*.py`）伪造的示例，不是原版战斗数据。
  const DUMMY = {
    id: 400, name: '测攻击木头人', level: 1,
    power: 0, agility: 15, speed: 0, hp: 800,
    rounds: 10,
  };
  function dummyRow(s) {
    return {
      name: DUMMY.name, level: DUMMY.level,
      power: DUMMY.power, agility: DUMMY.agility, speed: DUMMY.speed, hp: DUMMY.hp,
      gears: [], weapons: [], skills: [],
      kind: 'dummy', npcType: 'wood', dummy: true, friend: true, count: 10000,
      record: {
        count: Number((s || {}).woodCount) || 0,
        rounds: DUMMY.rounds,
        damage: Number((s || {}).woodDamage) || 0,
      },
    };
  }

  // 原版的文本字段不会自动折行（SVG 的 `<text>` 更不会）—— 导出数据里每个字段的
  // 原版那些文案是服务端按框宽断好行下发的，复刻得自己断，否则长句会直接冲出对话框。
  function wrap(text, per) {
    const out = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
      let line = '';
      for (const ch of para) {
        line += ch;
        if (line.length >= per) { out.push(line); line = ''; }
      }
      out.push(line);
    }
    return out.join('\n');
  }
  // 按字段框的真实宽度断行（`fitText`）
  // 现在改成：用 canvas 量一次这个字段的每单位字号的字符宽（只量一次、缓存在字段上），
  const charWCache = new WeakMap();
  let measureCtx = null;

  function charUnit(clip) {
    const tb = clip && clip.__textBox;
    if (!tb || !tb.meta || !tb.meta.bd) return null;
    if (charWCache.has(clip)) return charWCache.get(clip);
    let w = 1, font = '', fontSize = 12;
    try {

      const t = clip.g && clip.g.querySelector ? clip.g.querySelector('text') : null;
      if (t && window.getComputedStyle) {
        const cs = getComputedStyle(t);
        fontSize = parseFloat(cs.fontSize) || 12;
        font = fontSize + 'px ' + (cs.fontFamily || 'SimHei');
      }
      if (!font) {
        fontSize = (tb.lines[0] && tb.lines[0].h) || tb.meta.fh || 12;
        font = fontSize + 'px SimHei,"Microsoft YaHei",sans-serif';
      }
      if (!measureCtx) {
        const cv = document.createElement('canvas');
        measureCtx = cv.getContext && cv.getContext('2d');
      }
      if (measureCtx) {
        measureCtx.font = font;
        w = measureCtx.measureText('国').width / fontSize;
      }
    } catch (e) {  }
    if (!(w > 0.2 && w < 3)) w = 1;
    charWCache.set(clip, w);
    return w;
  }
  // 字段框的可用宽度（舞台单位）；量不到就返回 null。
  function fieldWidth(clip) {
    const tb = clip && clip.__textBox;
    if (!tb || !tb.meta || !tb.meta.bd) return null;
    const w = tb.meta.bd[1] - tb.meta.bd[0] - (tb.meta.lm || 0) - (tb.meta.rm || 0);
    return w > 8 ? w : null;
  }

  function fitText(clip, text) {
    const W = fieldWidth(clip);
    const u = charUnit(clip);
    if (!W || !u) return wrap(text, 12);
    const tb = clip.__textBox;
    const fontSize = (tb.lines[0] && tb.lines[0].h) || tb.meta.fh || 12;
    const per = Math.max(4, Math.floor(W / (u * fontSize)));
    const out = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
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
  // 按指定字号重排一个文本字段：字号同时改行高、行距与首行基线，再交给 `fitText` 断行。
  function setFieldText(clip, text, size) {
    if (!clip || !clip.__textBox || !size) return setText(clip, text);
    const tb = clip.__textBox;
    const lead = (tb.meta && tb.meta.lead) || 0;
    tb.lines = tb.lines.map((L) => Object.assign({}, L, { h: size }));
    tb.step = 1.15 * size + lead;
    if (tb.box) tb.base = tb.box.ymin + 2 + lead + 0.88 * size;
    return setText(clip, fitText(clip, text));
  }


  function fillChrome(view) {
    const s = S(), t = T();
    if (!s || !t) return;

    SfUiMain.showNumber(s.energy, clipOf(view, 'energy'), 0, 0, 'right');
    SfUiMain.showNumber(s.maxEnergy, clipOf(view, 'maxEnergy'), 0, 0, 'left');
    fitEnergy(view);
    const pct = Math.ceil(s.energy * 100 / Math.max(1, s.maxEnergy));
    stopAt(clipOf(view, 'energyMc'), Math.max(1, Math.min(101, pct + 1)));
  }

  const ENERGY_FIT = { left: 255, right: 303, centerY: 20.45, height: 5.1, scale: 0.405, gap: 1.15 };
  function fitEnergy(view) {
    const energy = clipOf(view, 'energy'), max = clipOf(view, 'maxEnergy');
    const slash = view.nodes && Array.from(view.nodes.values()).find((r) => r.id === '7254');
    const nodes = [energy && energy.g, slash && slash.node, max && max.g];
    if (nodes.some((g) => !g || !g.getBBox || !g.setAttribute)) return;
    let boxes;
    try { boxes = nodes.map((g) => g.getBBox()); } catch (e) { return; }
    if (boxes.some((b) => !(b.width > 0 && b.height > 0))) return;
    const f = ENERGY_FIT;
    const slashScale = f.height / boxes[1].height;
    const numberScale = Math.min(f.scale, f.height / Math.max(boxes[0].height, boxes[2].height),
      (f.right-f.left-boxes[1].width*slashScale-2*f.gap) / (boxes[0].width+boxes[2].width));
    if (!(numberScale > 0 && isFinite(numberScale))) return;
    const scales = [numberScale, slashScale, numberScale];
    const widths = boxes.map((b, i) => b.width * scales[i]);
    let x = (f.left+f.right-widths.reduce((a, b) => a+b, 0)-2*f.gap) / 2;
    nodes.forEach((g, i) => {
      const b = boxes[i], k = scales[i];
      // getBBox不含自身放置矩阵，因此重复刷新不会累计缩小，也不依赖窗口偏移。
      applyMatrix(g, {
        a: k, b: 0, c: 0, d: k,
        e: x-b.x*k, f: f.centerY-(b.y+b.height/2)*k,
      });
      x += widths[i]+f.gap;
    });
  }
  function applyMatrix(g, m) {
    g.setAttribute('transform', 'matrix(' + m.a + ',' + m.b + ',' + m.c + ',' + m.d + ',' + m.e + ',' + m.f + ')');
  }
  // `matrix(a,b,c,d,e,f)` → `{a,b,c,d,e,f}`；不是这个写法就返回 null（不动它，宁可不动也不要画歪）。
  function parseMatrix(str) {
    const m = /matrix\(\s*([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)[,\s]+([-\d.eE]+)\s*\)/.exec(String(str || ''));
    if (!m) return null;
    return { a: +m[1], b: +m[2], c: +m[3], d: +m[4], e: +m[5], f: +m[6] };
  }
  function setTabs(view, active) {
    for (const row of TABS) stopAt(tabClip(view, row[0]), row[1] === active ? 2 : 1);
  }
  function wireChrome(view, host) {
    const t = T();
    // 返回（`showRandomFriends` 的 mc.back.onFire / `showMyFriends` 的 _loc2.back.onFire）：
    // ⚠ 竞技场那几帧（f4/f6/f7/f8）的「返回」是回上一级竞技页，所以由各自的分支
    wireClickable(clipOf(view, 'back'), { hover: 2, onFire: () => { destroy(); if (window.UI && UI.runAction) UI.runAction('home'); } });
    for (const row of TABS) {
      const key = row[1];
      wireClickable(tabClip(view, row[0]), {

        hover: 3, press: 0,
        idle: () => (current && current.tab === key ? 2 : 1),
        onFire: () => showTab(key),
      });
    }
    void t;
  }


  // 把一个元件从"可点"摘掉（换页之后空槽位不该还接着上一次的对手）。
  // ⚠ 不动 `__chListeners`：监听器留着（只是什么都不做），否则之后再 `wireClickable`
  function unwire(clip) {
    const t = T();
    if (!t || !clip) return;
    clip.__chFire = null;
    clip.__chIdle = () => 1;
    if (clip.g && clip.g.style) clip.g.style.cursor = 'default';
    t.unregisterHit(clip);
  }

  function setRowTexts(row, item, idx) {
    if (!row || !row.byName) return;
    const index = Number.isFinite(idx) ? idx : -1;
    // 换帧会重建文本节点，所以签名必须含当前帧；同一帧同一行数据重复调用直接跳过。
    let whoLabel = '';
    try { if (item && window.__SSDZ_ONLINE__ && window.OnlineUI && OnlineUI.identity) whoLabel = OnlineUI.identity(item).label || ''; } catch (e) {}
    const rowSig = (row.__shownFrame == null ? '' : row.__shownFrame) + '|' + (item
      ? [item.name, item.level, item.vipLevel, item.accountId, item.realId, whoLabel].join('|') : '');
    if (row.__rowSig === rowSig) return;
    row.__rowSig = rowSig;
    const vipLevel = item ? Math.max(0, Math.min(VIP_MAX_LEVEL, Math.floor(Number(item.vipLevel) || 0))) : 0;
    const nameClip = row.byName('friendname');
    setText(nameClip, item ? item.name : '');

    if (item && window.SfRender && SfRender.fitTextWidth) {
      resetNameFit(nameClip);
      SfRender.fitTextWidth(nameClip, { ascii: 0.5, min: 7 });
      // 6 个汉字以内不压角标；更长的昵称（含 7 个汉字 / 长英文）缩到角标左边。
      if (vipLevel && SfRender.estimateTextWidth && SfRender.estimateTextWidth(item.name, { ascii: 0.5 }) > 6) {
        SfRender.fitTextWidth(nameClip, { ascii: 0.5, min: 7, width: VIP_NAME_WIDTH });
      }
    }
    setText(row.byName('flevel'), item ? item.level : '');
    alignRowText(row);
    if (window.__SSDZ_ONLINE__ && window.OnlineUI && row.g) {
      // 徽标挂在行自己的组里：随机页 f1..f3 的 matrix 只有平移和 0.93 的 x 缩放，行坐标系一致。
      // ⚠ y 必须用行内常量：部分 WebKit/WebView 的 `getScreenCTM()` 不含祖先 `#ui` 的 CSS 缩放
      // （iOS 15 WebKit 209220），反算会得到负值、把徽标甩到行外；`getBBox()` 也因拳套卡带 matrix 而不可用。
      const ONLINE_BADGE_X = 141.27, ONLINE_BADGE_Y = 3.6;
      const host = row.g;
      const view = current && current.view;
      const selector = '[data-online-source][data-row="' + index + '"]';

      const scope = (view && view.g) || host;
      for (const old of (scope.querySelectorAll ? scope.querySelectorAll(selector) : [])) old.remove();
      if (item) {
        const who = OnlineUI.identity(item);
        // VIP 角标本身只可能出现在玩家行上，再叠「玩家」会压住角标数字；保留 aria-label 即可。
        if (!vipLevel) {
          const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          badge.setAttribute('data-online-source', who.bot ? 'bot' : who.player ? 'player' : 'unknown');
          badge.setAttribute('data-row', String(index));
          badge.setAttribute('x', ONLINE_BADGE_X.toFixed(2));
          badge.setAttribute('y', ONLINE_BADGE_Y.toFixed(2));
          badge.setAttribute('text-anchor', 'end');
          badge.setAttribute('font-size', '9');
          badge.setAttribute('font-family', 'SimHei, sans-serif'); badge.setAttribute('fill', '#673c1a');
          badge.setAttribute('pointer-events', 'none'); badge.textContent = who.label; host.appendChild(badge);
        }
        row.g.setAttribute('aria-label', item.name + '，' + who.label +
          (vipLevel ? '，超级松鼠 Lv' + vipLevel : '') + '，等级' + item.level);

        const name = row.byName('friendname'), node = name && (name.g || name);
        if (node) for (const text of node.querySelectorAll('text')) {
          text.removeAttribute('textLength');
          text.removeAttribute('lengthAdjust');
        }
      }
    }
  }

  function repaintRows() {
    if (!current || !current.view) return;
    const rows = current.rows || [];
    for (let i = 0; i < 4; i++) {
      if (current.refreshRow && i === 3) continue;
      setRowTexts(clipOf(current.view, 'f' + (i + 1)), rows[i] || null, i);
      setRowVip(current.view, i, rows[i] || null);
    }
  }

  function fillRows(view, rows, sel, pageOff) {
    const off = Number(pageOff) || 0;
    if (current) {
      const padded = [];
      for (let i = 0; i < 4; i++) padded.push(rows[i] || null);
      current.rows = padded;
      current.pageOff = off;
    }
    for (let i = 0; i < 4; i++) {
      const row = clipOf(view, 'f' + (i + 1));
      const card = clipOf(view, 's' + (i + 1));
      const item = rows[i];
      setRowTexts(row, item || null, i);
      // 拳套卡：原版按 `relation` 切 1~5 帧，末帧 = 空白（`_totalframes`，见 §relationFrame）。
      // ⚠ 复刻多一个原版没有的坑：随机页只有 3 行，第 4 行那颗 `s4` 不归 `fillRows` 管
      const blank = card && card.frameCount ? card.frameCount() : 1;
      if (card) stopAt(card, item ? relationFrame(item) : blank);
      // `vip1..vip4`（7252）是服务端下发的实时 VIP 角标，不是快照字段。
      setRowVip(view, i, item || null);
      if (!item) { unwire(row); unwire(card); continue; }
      const idx = i;

      const idleFrame = () => (current && current.sel === idx ? 2 : 1);
      // `onHover`：鼠标一进来就选中这一行（绿胶囊 + 右侧立绘/数值都跟着换），
      // ⚠ 拳套卡 `s{i}` 也算这一行的命中面（原版点立绘 = 点这一行），所以它也要挂同一个回调。
      const hoverSelect = () => { if (current && current.sel !== idx) selectRow(idx); };
      wireClickable(row, {
        hover: 0, press: 0,
        idle: idleFrame,
        after: repaintRows,
        onHover: hoverSelect,

        onFire: () => { selectRow(idx); openFriendMenu(idx); },
      });
      wireClickable(card, {
        hover: 0, press: 0,
        idle: () => relationFrame(item),
        onHover: hoverSelect,
        onFire: () => { selectRow(idx); openFriendMenu(idx); },
      });
    }
    showUserPic(view, rows[sel] || null);
  }
  // 选中一行：右面板 `rightBg` 换成这位对手的立绘 + 装备 + 力/敏/速/命
  // ⚠ 用户 2026-10 口径（本批）："选择敌人高亮的绿条会直接随着鼠标移动而移动，而不是点击后才切换，
  function selectRow(i) {
    if (!current) return;
    current.sel = i;
    if (current.tab === 'random' && randomCacheMatches(randomCache, S())) randomCache.sel = i;
    const touched = [];
    for (let k = 0; k < 4; k++) {
      const row = clipOf(current.view, 'f' + (k + 1));
      if (!row || !row.gotoAndStop) continue;
      const want = k === i ? 2 : 1;
      // 只有真的换帧的行才重建了子树：其余行的文字/反馈壳都还在，不必跟着重画。
      const changed = row.frame !== want - 1;
      stopAt(row, want);
      if (changed) { refreshShell(row); touched.push(k); }
    }
    // 换帧会重建该行的文本节点（导出数据里昵称/等级带 rp），只补这几行。
    for (const k of touched) {
      const row = clipOf(current.view, 'f' + (k + 1));
      const item = (current.rows || [])[k] || null;
      setRowTexts(row, item, k);
      setRowVip(current.view, k, item);
    }
    showUserPic(current.view, foeAt(i));
    prefetchFoe(foeAt(i));
  }
  function fightRow(i) {
    const foe = foeAt(i);
    if (!foe) return;

    if (foe.dummy) { startDummyFight(foe); return; }

    startFight(foe, (current && current.tab === 'friends') ? 'friend' : 'challenge');
  }

  function startDummyFight(foe) {
    const s = S();
    if (!s || !window.Main || !Main.startBattle) return;
    if (window.Online && Online.ready && Online.battle) { void Online.battle.wood({ target:{ tab:'friends' } }); return; }
    const dummy = Object.assign({}, foe, {
      npcType: 'wood', name: DUMMY.name, level: DUMMY.level,
      power: DUMMY.power, agility: DUMMY.agility, speed: DUMMY.speed, hp: DUMMY.hp,
      baseStats: { power: DUMMY.power, agility: DUMMY.agility, speed: DUMMY.speed, hp: DUMMY.hp },
      weapons: [], skills: [], gears: [], effects: {},

      practice: true, practiceRounds: DUMMY.rounds,
    });

    const back = () => { SfChallenge.openAt('friends'); if (window.UI && UI.runAction) UI.runAction('challenge'); };
    Main.startBattle(dummy, {
      cost: 0, kind: 'wood', useProps: false, keepScreen: true,

      collectDrops: false, skipChest: true,

      skipResultPanel: true,
      // 经典/现代两套播放器的剩余回合数都按这一场自己的上限显示（默认 60）。
      maxRounds: DUMMY.rounds,
      onEnd: (winner, result) => {
        const record = State.recordWoodBattle(result);
        if (!record) { back(); return; }
        destroy();
        back();
        const extra = '本次总伤害 ' + record.current.total + '　固定 ' + DUMMY.rounds + ' 回合<br>' +
          '武器伤害 ' + record.current.weaponDamage + '　技能伤害 ' + record.current.skillDamage +
          '　徒手伤害 ' + record.current.handDamage + '<br>' +
          '历史最高伤害 ' + record.totalBest + '　累计训练 ' + record.count + ' 次<br>' +
          '木桩每回合恢复满血（800），生命最低为 1，伤害按实际数值记录';
        if (window.UI && window.UI.classic && UI.classic.resultModal) {
          UI.classic.resultModal(winner === 0, { exp: 0, gold: 0, ups: [] }, extra, null);
        }
      },
      onError: () => { back(); },
    }).catch(() => { back(); });
  }

  // 动作菜单 —— 用原版那一页（库元件「挑战1」= 4756 的第 1 帧）
  // ⚠ 帧表要按 `actionType`（= `seeFriend` :23228-23257 由 `relation` 翻出来的那一档）读，
  // 行落点由实测（无头 Chrome 探针，量 `subframe` 各帧里那几颗画稿的舞台矩形）量出：

  const MENU_LAYOUT = {

    1: { base: 1, rows: [
      { d: 0, box: [88.4, 41.9, 231.8, 65.8], act: 'fight', key: 'fight', label: '挑战Ta！' },
      { d: 1, box: [88.4, 70.2, 231.8, 94.1], act: 'back', key: 'back', label: '返回' },
      { d: 2, box: [88.4, 99.0, 231.8, 122.9], act: 'view', key: 'view', label: '查看' },
      { d: 3, box: [88.4, 127.9, 231.8, 151.8], act: 'add', key: 'add', label: '收为徒弟' },
    ] },

    2: { base: 20, rows: [
      { d: 0, box: [88.4, 41.9, 231.8, 65.8], act: 'fight', key: 'fight', label: '挑战Ta！' },
      { d: 1, box: [88.4, 70.6, 231.8, 94.5], act: 'cheer', key: 'cheer', label: '为师父加油' },
      { d: 2, box: [88.4, 99.0, 231.8, 122.9], act: 'quitmaster', key: 'quitmaster', label: '退出师门' },
      { d: 3, x2: true, box: [88.4, 127.9, 156, 151.8], box2: [164, 127.9, 231.8, 151.8],
        act: 'view', act2: 'back', key: 'view', label: '查看', label2: '返回', d2: 4 },
    ] },

    3: { base: 6, rows: [
      { d: 0, box: [88.4, 41.9, 231.8, 65.8], act: 'fight', key: 'fight', label: '挑战Ta！' },
      { d: 1, box: [88.4, 70.2, 231.8, 94.1], act: 'back', key: 'back', label: '返回' },
      { d: 2, box: [88.4, 99.0, 231.8, 122.9], act: 'view', key: 'view', label: '查看' },
      { d: 3, box: [88.4, 127.9, 231.8, 151.8], act: 'eject', key: 'eject', label: '逐出师门' },
    ] },

    4: { base: 15, rows: [
      { d: 0, box: [88.4, 62.3, 231.8, 86.2], act: 'fight', key: 'fight', label: '挑战Ta！' },
      { d: 1, box: [88.4, 108.9, 231.8, 132.8], act: 'back', key: 'back', label: '返回' },
    ] },
    // case 5（actionType 5）：关系 3 陌生人（4 项，面板更高：x 80.5..241.8 / y 17.5..180.6），
    // 复刻没有服务端 uid，不写；底部因此空一块 —— 随机页改用 case 1 面板 + 这里的「加好友」字形。
    5: { base: 11, rows: [
      { d: 0, box: [88.4, 31.9, 231.8, 55.8], act: 'fight', key: 'fight', label: '挑战Ta！' },
      { d: 1, box: [88.4, 61.6, 231.8, 85.5], act: 'back', key: 'back', label: '返回' },
      { d: 2, box: [88.4, 95.2, 231.8, 119.1], act: 'view', key: 'view', label: '查看' },
      { d: 3, box: [88.4, 127.1, 231.8, 151.0], act: 'add', key: 'add', label: '加好友' },
    ] },
    // case 6（actionType 6）：关系 4（木人 / 练功木桩）—— 只有 3 项：测攻击 / 查看记录 / 关闭。
    // ⚠ 这一档没有「加好友」（用户 2026-10 口径："点开测攻击木头人不应该出现加好友选项"）——
    6: { base: 26, rows: [
      { d: 0, box: [88.4, 41.9, 231.8, 65.8], act: 'fight', key: 'fight', label: '测攻击' },
      { d: 1, box: [88.4, 82.6, 231.8, 106.5], act: 'record', key: 'record', label: '查看记录' },
      { d: 2, box: [88.4, 123.2, 231.8, 147.1], act: 'back', key: 'back', label: '关闭' },
    ] },
  };

  function menuHost() {
    if (current && current.sub && current.sub.host && current.sub.host.isConnected) return current.sub.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub';
    el.setAttribute('aria-label', '对手动作');
    ui.appendChild(el);
    current.sub = { host: el, view: null, dom: true, menu: false };
    return el;
  }
  function currentFoe() {
    return foeAt(Number(current && current.sel) || 0);
  }
  // ⚠ 这里以前是各写各的：`fillRows` 用 `rows[sel]` 填右侧展示，
  function foeAt(i) {
    if (!current) return null;
    // `current.rows` 就是这一页显示的那 4 行（`fillRows` 写的），界面行号直接查它。
    // ⚠ 不要在这里再加 `pageOff`：`fillRows` 已经按页偏移切过一刀，
    return (current.rows || [])[Number(i) || 0] || null;
  }
  // 选中对手 / 进入随机页时先预热本场动作包；真正开打只等解析与服务端录像。
  function prefetchFoe(foe) {
    try { if (foe && window.SfFight && SfFight.prefetchMatch) SfFight.prefetchMatch(foe); } catch (e) {}
  }


  function routerOfHost(host) {
    const t = T();
    const svg = host && host.querySelector ? host.querySelector('svg') : null;
    return (t && svg) ? t.routerOf(svg) : null;
  }

  function setBaseRouterEnabled(host, on) {
    const r = routerOfHost(host || (current && current.host));
    if (!r || !r.setEnabled) return false;
    return r.setEnabled(!!on);
  }

  function openFriendMenu(i) {

    current.sel = Number(i) || 0;
    // 新的一次选行要作废还在路上的「查看」请求，避免旧响应盖到新菜单上。
    current.detailRequest = (current.detailRequest || 0) + 1;
    if (current.tab === 'random' && randomCacheMatches(randomCache, S())) randomCache.sel = current.sel;
    const foe = foeAt(current.sel);
    if (!foe) return;
    const host = menuHost();
    if (!host) return;

    guard(showFriendMenu(host, foe, current.sel));
  }
  async function showFriendMenu(host, foe, rowIndex) {
    const page = current;
    const view = await openSub(1);
    if (!isCurrentSub(view, page)) return;
    resetHits(view.g.ownerSVGElement);
    page.sub.menu = true;
    const rel = relOf(foe);

    const c = MENU_CASE(rel);
    const sub = clipOf(view, 'subframe');
    let compactRandom = c === 5 && page.tab === 'random';
    let layout = MENU_LAYOUT[c] || MENU_LAYOUT[3];
    if (compactRandom) {
      const glyph = captureAddFriendGlyph(sub);
      if (glyph && glyph.length) {
        const fr = MENU_LAYOUT[1];
        layout = Object.assign({}, fr, {
          rows: fr.rows.map((row, i) => (i === 3 ? Object.assign({}, row, { label: '加好友' }) : row)),
        });
      } else {

        compactRandom = false;
      }
    }
    const setFrame = (d) => {
      menuSetFrame(sub, layout, d);
      if (compactRandom) paintAddFriendGlyph(sub);
    };
    // 行热区铺在DOM 层（不动原版显示列表）：悬停就把 `subframe` 拨到"那一行被选中"的帧
    // ⚠ 菜单一出生就先拨到第 1 行被选中的那一帧：原版进来时 `jiantou_WZ_Y2 = 1`
    // ⚠ 用户 2026-10 口径（本批 ②-其二）："不要设 挑战ta 为默认选中……直接固定最后一个
    let lastD = 0;
    host.querySelectorAll('.sf-mrow').forEach((n) => n.remove());
    const mp = menuMap(view, host);
    const put = (row, box, act, label, d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sf-mrow';
      b.setAttribute('data-m', act);
      b.setAttribute('aria-label', label || act);
      b.style.left = mp.x(box[0]) + 'px';
      b.style.top = mp.y(box[1]) + 'px';
      b.style.width = mp.s(box[2] - box[0]) + 'px';
      b.style.height = mp.s(box[3] - box[1]) + 'px';
      b.addEventListener('mouseenter', () => { lastD = d; setFrame(d); });
      // 触摸下 WebView 可能只在 touchend 后才补 mouseenter；按下就拨选中帧，
      // 否则菜单行要等松手才变色（安卓实感是“点了没反馈”）。
      let pressed = false;
      const press = () => {
        if (pressed) return;
        pressed = true;
        lastD = d;
        setFrame(d);
      };
      b.addEventListener('pointerdown', press);
      b.addEventListener('touchstart', press, { passive: true });
      for (const type of ['pointerup', 'pointercancel', 'touchend']) {
        b.addEventListener(type, () => { pressed = false; });
      }

      b.addEventListener('click', (e) => { e.stopPropagation(); menuFire(act, foe, rowIndex); });
      host.appendChild(b);
    };
    for (const row of layout.rows) {
      put(row, row.box, row.act, row.label, row.d);
      if (row.x2 && row.box2) put(row, row.box2, row.act2, row.label2, row.d2 != null ? row.d2 : row.d);
    }
    setFrame(lastD);
  }

  function menuMap(view, host) {
    const svg = view && view.root;
    const r = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const vb = svg ? String(svg.getAttribute('viewBox') || '0 0 320 196').split(/[\s,]+/).map(Number) : null;
    const box = host && host.getBoundingClientRect ? host.getBoundingClientRect() : null;

    const hs = host ? (Number(getComputedStyle(host).getPropertyValue('--uiscale')) || 1) : 1;
    const k = (r && r.width && vb && vb[2]) ? r.width / vb[2] : 3.577;
    const ox = r && box ? (r.left - box.left) / hs : 0;
    const oy = r && box ? (r.top - box.top) / hs : 0;
    const vx = vb ? vb[0] : 0, vy = vb ? vb[1] : 0;
    return {
      k: k / hs,
      x: (sx) => ox + (sx - vx) * k / hs,
      y: (sy) => oy + (sy - vy) * k / hs,
      s: (n) => n * k / hs,
    };
  }

  function menuSetFrame(sub, layout, d) {
    if (!sub || !layout) return;
    const n = sub.frameCount ? sub.frameCount() : 29;
    const off = Math.max(0, Number(d) || 0);
    try { sub.gotoAndStop(Math.max(1, Math.min(n, layout.base + off))); } catch (e) {}
  }
  // 随机页第四颗：「好友档紧凑面板」+「陌生人档的原版加好友字形」
  // "这个界面下部的留白太多了，参考好友中这个二级界面的格式进行调整。"
  let addFriendGlyph = null;

  function fourthRowGlyphPaths(sub) {
    const out = [];
    if (!sub || !sub.g || !sub.g.querySelectorAll) return out;
    for (const p of sub.g.querySelectorAll('path')) {
      let b = null;
      try { b = p.getBBox(); } catch (e) { b = null; }
      if (b && b.y >= 75 && b.y <= 85 && b.height >= 14 && b.height <= 17) out.push(p);
    }
    return out;
  }

  function captureAddFriendGlyph(sub) {
    if (addFriendGlyph && addFriendGlyph.length) return addFriendGlyph;
    if (!sub || !sub.gotoAndStop) return null;
    const back = (sub.frame || 0) + 1;
    try {
      sub.gotoAndStop(14);
      addFriendGlyph = fourthRowGlyphPaths(sub).map((p) => p.cloneNode(true));
    } catch (e) { addFriendGlyph = null; }
    try { sub.gotoAndStop(back); } catch (e) {}
    return addFriendGlyph;
  }
  // 每次拨帧后重贴：好友档画稿自带「收为徒弟」，先藏掉再把「加好友」贴到同一层。
  // ⚠ 必须先复原上一次再重新找原字形：真实点击打开菜单后，指针落在菜单首行上会再
  function paintAddFriendGlyph(sub) {
    if (!addFriendGlyph || !addFriendGlyph.length || !sub || !sub.g) return false;
    for (const n of sub.g.querySelectorAll('[data-sf-addfriend-glyph]')) n.remove();
    for (const n of sub.g.querySelectorAll('[data-sf-addfriend-hide]')) {
      n.style.display = '';
      n.removeAttribute('data-sf-addfriend-hide');
    }
    const cur = fourthRowGlyphPaths(sub);
    if (!cur.length) return false;
    const parent = cur[0].parentNode;
    for (const p of cur) {
      p.style.display = 'none';
      p.setAttribute('data-sf-addfriend-hide', '1');
    }
    for (const p of addFriendGlyph) {
      const n = p.cloneNode(true);
      n.setAttribute('data-sf-addfriend-glyph', '1');
      parent.appendChild(n);
    }
    return true;
  }
  // 收徒 / 逐出 / 出师：原版确认帧
  // 联机版把这一场交给服务端 `/api/apprentice/recruit`：目标有师父先打师父
  // 菜单行是 DOM 热区；换到原版确认帧时必须摘掉，否则会盖住「确定/取消」把点击截走。
  function clearMenuDom(host) {
    const el = host || (current && current.sub && current.sub.host);
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('.sf-mrow').forEach((n) => n.remove());
  }
  // 收徒/逐出要交服务端的真实账号 id：好友行来自 `/api/friends`，师徒行来自存档镜像。
  function onlineTargetId(foe) {
    if (!foe) return 0;
    const row = foe.row || {};
    const raw = foe.accountId != null ? foe.accountId
      : (row.accountId != null ? row.accountId : row.realId);
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : 0;
  }
  function openRecruitConfirm(foe) {
    const page = current;
    if (!page || !foe) return;
    clearMenuDom(page.sub && page.sub.host);
    const pending = openSub(2);
    guard(Promise.resolve(pending).then((view) => {
      if (!isCurrentSub(view, page)) return;
      const confirm = clipOf(view, 'button1');
      const cancel = clipOf(view, 'button2');
      wireClickable(confirm, {
        hover: 2, press: 2, idle: 1,
        onFire: () => {
          if (current !== page) return;
          const tab = page.tab || 'friends';
          closeSub();
          startRecruitChallenge(foe, tab);
        },
      });
      wireClickable(cancel, { hover: 2, press: 2, idle: 1, onFire: () => closeSub() });
    }));
  }
  // 逐出师门：原版 `showEjectWin()` 挂的是 4756 第 3 帧
  // （画稿里烤好了「不能享受徒弟贡献的经验和道具，确定要将他逐出么？」）。
  function openEjectConfirm(foe) {
    const page = current;
    if (!page || !foe) return;
    const target = onlineTargetId(foe);
    if (!target) { if (window.UI && UI.toast) UI.toast('找不到这个徒弟的账号。'); return; }
    clearMenuDom(page.sub && page.sub.host);
    const pending = openSub(3);
    guard(Promise.resolve(pending).then((view) => {
      if (!isCurrentSub(view, page)) return;
      let busy = false;
      const confirm = clipOf(view, 'button1');
      const cancel = clipOf(view, 'button2');
      wireClickable(confirm, {
        hover: 2, press: 2, idle: 1,
        onFire: () => {
          if (busy || current !== page || !window.Online || !Online.ready) return;
          busy = true;
          Online.post('/api/apprentice/kick', { targetAccountId: target, rev: Online.rev }, { preserveMirror: true })
            .then((r) => {
              if (current !== page) return;
              closeSub();
              current.onlineFriends = null;
              showTab(page.tab || 'friends');
              if (window.UI && UI.toast) UI.toast('已让【' + ((r && r.name) || foe.name) + '】离开师门');
            })
            .catch((e) => { busy = false; if (window.UI && UI.toast) UI.toast(Online.errText(e)); });
        },
      });
      wireClickable(cancel, { hover: 2, press: 2, idle: 1, onFire: () => closeSub() });
    }));
  }
  function waitChallengeView(limit) {
    const max = Number(limit) || 120;
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        const view = window.SfChallenge && SfChallenge.view ? SfChallenge.view() : null;
        if ((view && view.g && view.g.isConnected) || n++ >= max) { resolve(); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  function startRecruitChallenge(foe, tab) {
    const s = State.state();

    if (window.Online && window.Online.ready) {
      const target = onlineTargetId(foe);
      if (!target) { if (window.UI && UI.toast) UI.toast('只能收真人玩家为徒：AI好友不能收徒。'); return; }
      if (!window.Online.battle || !Online.battle.recruit) { if (window.UI && UI.toast) UI.toast('收徒挑战暂不可用。'); return; }
      const hold = holdPageForBattle();
      Promise.resolve(Online.battle.recruit(target, { target: { tab: tab || 'friends' }, hold }))
        .catch((e) => { if (window.UI && UI.toast) UI.toast(Online.errText(e)); });
      return;
    }
    const started = State.beginRecruitChallenge ? State.beginRecruitChallenge(foe) : { ok: false, msg: '收徒挑战不可用' };
    if (!started.ok) {
      if (window.UI && UI.toast) UI.toast(started.msg || '收徒挑战失败');
      return;
    }
    const token = started.token;
    let settled = false;
    const restore = async () => {
      closeSub();
      SfChallenge.openAt(tab || 'friends');
      if (window.UI && UI.runAction) UI.runAction('challenge');
      await waitChallengeView();
    };
    const interrupted = () => {
      if (settled) return;
      settled = true;
      if (State.state() !== s) return;
      State.cancelRecruitChallenge(token);
      restore();
      if (window.UI && UI.toast) UI.toast('收徒挑战中断，已退还10金松果。');
    };
    try {
      Promise.resolve(Main.startBattle(started.foe, {
        kind: 'master', useProps: true, region: 0, skipResultPanel: true,
        keepScreen: true,
        onError: interrupted,
        onEnd: async (winner) => {
          if (settled) return;
          settled = true;
          if (State.state() !== s) { await restore(); return; }
          const result = State.finishRecruitChallenge(token, winner === 0);
          await restore();
          if (!result.ok) return;
          if (window.SfFightResult) {
            SfFightResult.open({
              kind: 'result', title: result.win ? '收徒成功' : '收徒失败',
              win: result.win, exp: result.exp, ups: result.ups, text: result.msg,
              actions: [{ label: '返回', run: () => {} }],
            }).catch((error) => { if (window.UI && UI.toast) UI.toast(error.message); });
          } else if (window.UI && UI.toast) UI.toast(result.msg);
        },
      })).catch(interrupted);
    } catch (e) { interrupted(); }
  }


  function menuFire(action, foe, rowIndex) {
    // 陌生人（随机页 relation 3）那一档第四颗才是「加好友」；
    // 好友档（relation 0）第四颗是「收为徒弟」，不能也落到加好友接口。
    if (window.Online && Online.ready && action === 'add' && window.OnlineUI && relOf(foe) === REL.stranger) {
      if (!OnlineUI.identity(foe).player) { Online.toast('AI对手不能添加为玩家好友。'); return; }
      OnlineUI.addFriendPage(foe, () => { closeSub(); if (current) { current.onlineFriends = null; showTab(current.tab); } });
      return;
    }
    switch (action) {
      case 'fight':
        closeSub();
        fightRow(rowIndex);
        return;
      case 'view':
      case 'record':
        openFriendDetail(foe);
        return;
      case 'add': {
        // relation 0（好友）那一档原版是「收为徒弟」（`doAction(4)` → `showGetStuWin`），
        // 确认后 `getStudent` 扣 10 金松果并打一场收徒挑战；复刻不能直接 `addPrentice`。
        if (foe.kin) {
          if (window.Online && Online.toast) Online.toast('你们已经是师徒关系。');
          else if (window.UI && UI.toast) UI.toast('你们已经是师徒关系。');
          return;
        }
        if (foe.dummy) { closeSub(); return; }
        if (window.Online && window.Online.ready) {
          if (!onlineTargetId(foe)) { Online.toast('AI好友不能收为徒弟，只能收真人玩家。'); return; }
          openRecruitConfirm(foe);
          return;
        }
        if (foe.kind === 'friend' && !foe.stranger) { openRecruitConfirm(foe); return; }
        const r = State.addFriend ? State.addFriend(foe) : { ok: false, msg: '不能添加' };
        if (window.UI && UI.toast) UI.toast(r.msg || (r.ok ? '已添加好友' : '添加失败'));
        if (r.ok) { closeSub(); showTab(current.tab); }
        return;
      }
      case 'cheer':
        // 原版 `doAction(5)` → `fighting()`（`MainMovie.as:3249`）：POST 一次 fighting.do，
        // 成功后只出一行「为师父加油成功！」。联机版由服务端随机锁一项属性 +5%。
        if (window.Online && Online.ready) {
          Online.post('/api/apprentice/cheer', {}, { preserveMirror: true })
            .then((r) => {
              if (window.UI && UI.toast) UI.toast((r && (r.msg || (r.ok ? '为师父加油成功！' : '加油失败'))) || '加油失败');
              if (r && r.ok && window.ClassicExtras && ClassicExtras.invalidateApprentice) ClassicExtras.invalidateApprentice();
            })
            .catch((e) => { if (window.UI && UI.toast) UI.toast(Online.errText(e)); });
          return;
        }
        if (window.UI && UI.toast) UI.toast('加油！加油！师父必胜！');
        return;
      case 'quitmaster': {
        // 原版 `showQuitWin()` 的原文：退出师门需要花费 20 个金松果（:23400）。
        // 联机版由服务端扣费并清关系；两边都用原版「二次确认」4421。
        const cost = 20;
        const online = !!(window.Online && window.Online.ready);
        const leaveLocal = () => {
          const s = S() || {};
          if (Number(s.goldPoint) < cost) { if (window.UI && UI.toast) UI.toast('金松果不足'); return; }
          s.goldPoint -= cost;
          if (State.clearMaster) State.clearMaster();
          try { State.save(); } catch (e) {}
          closeSub();
          showTab(current.tab);
        };
        const leaveOnline = () => {
          if (!window.Online || !Online.ready) return;
          Online.post('/api/apprentice/leave', { rev: Online.rev }, { preserveMirror: true })
            .then(() => {
              if (!current) return;
              closeSub();
              current.onlineFriends = null;
              showTab(current.tab);
              if (window.UI && UI.toast) UI.toast('已退出师门');
            })
            .catch((e) => { if (window.UI && UI.toast) UI.toast(Online.errText(e)); });
        };
        const accept = online ? leaveOnline : leaveLocal;
        if (online && Number((S() || {}).goldPoint) < cost) {
          if (window.UI && UI.toast) UI.toast('金松果不足 ' + cost);
          return;
        }

        closeSub();
        const text = '退出师门需要花费' + cost + '个金松果，是否确定？';
        const fallback = () => {
          if (window.UI && UI.classic && UI.classic.modal) {
            UI.classic.modal('退出师门', '<p>' + text + '</p>', [
              { label: '确定', run: accept },
              { label: '返回', cls: 'muted' },
            ], { small: true });
          }
        };
        if (online) {
          try {
            Promise.resolve(openOriginalConfirm({ label: '退出师门', text, accept }))
              .then((view) => { if (!view) fallback(); }).catch(fallback);
          } catch (e) { fallback(); }
          return;
        }
        fallback();
        return;
      }
      case 'eject': {
        // 联机版逐出要交服务端 targetAccountId；原版确认帧 = 4756 第 3 帧。
        if (window.Online && window.Online.ready) { openEjectConfirm(foe); return; }
        if (State.kickPrentice) {
          const r = State.kickPrentice(foe.name);
          if (window.UI && UI.toast) UI.toast(r.msg || (r.ok ? '已逐出师门' : '不能逐出'));
          if (r.ok) { closeSub(); showTab(current.tab); }
        }
        return;
      }
      default:
        closeSub();
    }
  }

  // 列表里的 `fighter` 是进页那一刻的快照，师徒行甚至只有拜师时的存档镜像。
  // 随机/天梯的对手是「抽签时发给你的那一颗快照」：`查看` 必须按 `snapshotId` 取回同一颗，
  // 按 `accountId` 取会拿到对方当前存档 —— 面板和这一场的对手都会被换成实时属性。
  // 好友页例外：看的是好友当前面板（换装后也要最新），继续按 `accountId` 取。
  function freshOnlineFoe(foe, opts) {
    const id = Number(foe && foe.accountId || 0);
    const snapshotId = String(foe && foe.snapshotId || '');
    if (!window.Online || !Online.ready) return Promise.resolve(foe);
    const frozen = !!(opts && opts.frozen) && !!snapshotId;
    if (!frozen && !(id > 0)) return Promise.resolve(foe);
    const url = frozen
      ? '/api/fighter?snapshotId=' + encodeURIComponent(snapshotId)
      : '/api/fighter?accountId=' + encodeURIComponent(id);
    return Online.get(url, { timeoutMs: 5000 }).then((info) => {
      const f = info && info.fighter;
      if (!f) return foe;
      const out = Object.assign({}, f, foe);
      out.name = String(f.name || foe.name || '');
      out.level = Math.max(1, Math.round(Number(f.level) || Number(foe.level) || 1));
      out.power = Math.max(0, Math.round(Number(f.power) || 0));
      out.agility = Math.max(0, Math.round(Number(f.agility) || 0));
      out.speed = Math.max(0, Math.round(Number(f.speed) || 0));
      out.hp = Math.max(1, Math.round(Number(f.maxHp) || Number(f.hp) || 0));
      out.maxHp = Math.max(out.hp, Math.round(Number(f.maxHp) || 0));
      out.weapons = Array.isArray(f.weapons) ? f.weapons.slice() : [];
      out.skills = Array.isArray(f.skills) ? f.skills.slice() : [];
      out.gears = Array.isArray(f.gears) ? f.gears.slice() : [];
      // 查看后保存原始快照号：内存 offer 10 分钟过期/服务重启后，仍能打同一颗快照。
      const ref = String(info.snapshotRef || '');
      out.snapshotRef = String(frozen ? ref : (ref || foe.snapshotRef || ''));
      out.snapshotId = String(frozen ? (out.snapshotRef || snapshotId) : (info.snapshotId || foe.snapshotId || ''));
      delete out.previewUnavailable;
      return out;
    }).catch(() => foe);
  }
  function replaceFoeRow(page, before, after) {
    for (const list of [page.rows, page.roster, page.onlineFriends && page.onlineFriends.roster]) {
      if (!Array.isArray(list)) continue;
      const at = list.indexOf(before);
      if (at >= 0) list[at] = after;
    }
  }
  async function openFriendDetail(foe) {
    closeSub();
    if (!foe) return;
    if (foe.dummy) { openDummyRecord(foe); return; }
    const page = current;
    // 随机页的真人对手要按抽到的那颗快照取；`page.tab` 在等待期间可能已经切走，
    // 只认「点击时所在的那一页」；写死 `friends` 会让随机页的「查看」静默失败。
    const tab = page && page.tab;
    if (page && Number(foe.accountId) > 0 && window.Online && Online.ready) {
      const request = page.detailRequest = (page.detailRequest || 0) + 1;
      const fresh = await freshOnlineFoe(foe, { frozen: tab !== 'friends' });
      if (current !== page || page.detailRequest !== request || page.tab !== tab) return;
      if (fresh && fresh !== foe) {
        replaceFoeRow(page, foe, fresh);
        try { showUserPic(page.view, fresh); } catch (e) {}
        foe = fresh;
      }
    }
    if (window.SfStatus && SfStatus.openFriend) {
      // 不要拆挑战页：状态页是盖在它上面的一层。返回时只摘掉那一层，好友名单、
      let p = null;
      try {
        p = SfStatus.openFriend(foe, () => {

          if (!current && window.UI && UI.runAction) UI.runAction('challenge');
        });
      } catch (e) {

        if (window.__errs) window.__errs.push('SfStatus friend throw: ' + (e && e.message));
        openFriendGears(foe);
        return;
      }
      if (p && typeof p.catch === 'function') {
        p.catch((e) => { if (window.__errs) window.__errs.push('SfStatus friend: ' + (e && e.message)); });
      }
      return;
    }
    openFriendGears(foe);
  }

  function openFriendGears(foe) {
    const host = menuHost();
    if (!host || !foe) return;
    const C = window.UI && UI.classic;
    const gearNames = { 0: '头部', 1: '拳套', 2: '衣服', 3: '鞋子' };
    const gears = (foe.gears || []).map((g) => {
      const gid = Number(g && g.id != null ? g.id : g);
      const ty = Number(g && g.type != null ? g.type : (State.gearPart ? State.gearPart(g.id) : -1));
      const orange = !!(g && (g.orange === true || Number(g.quality) === 4));
      const gemLv = g && g.gem && State.gemLevel ? State.gemLevel(g.gem.id) : 0;
      const extra = [gearNames[ty] || '', orange ? '橙装' : '', gemLv ? '宝石 Lv' + gemLv : '']
        .filter(Boolean).join(' · ');
      const gearSrc = (window.UI && UI.classic && UI.classic.gearIconSrc)
        ? UI.classic.gearIconSrc(gid)
        : 'images/ui/icons/gear/gear-' + gid + '-classic.svg?v=4';
      return '<li><span class="sf-fd-icon gear" data-img="' + gearSrc + '"></span>' +
        '<b' + (orange ? ' style="color:#c45a12"' : '') + '>' + esc(C && C.gearName ? C.gearName(gid) : ('装备' + gid)) + (orange ? '（橙）' : '') + '</b>' +
        '<i>' + esc(extra) + '</i></li>';
    }).join('') || '<li class="none">（未穿戴）</li>';
    const stat = (k, v, cls) => '<span class="sf-fd-stat ' + cls + '"><b>' + k + '</b><i>' + v + '</i></span>';
    host.querySelectorAll('.sf-mrow').forEach((n) => n.remove());
    host.innerHTML =
      '<div class="sf-fdetail">' +
        '<div class="sf-fd-head"><b>' + esc(foe.name) + '</b><span>Lv' + esc(foe.level) + ' · 装备</span></div>' +
        '<div class="sf-fd-stats">' + stat('力', foe.power, 'p') + stat('敏', foe.agility, 'a') + stat('速', foe.speed, 's') + stat('命', foe.hp, 'h') + '</div>' +
        '<h4>身上穿的</h4><ul class="sf-fd-list gears">' + gears + '</ul>' +
        '<button type="button" class="sf-fmenu-btn" data-m="back">返回</button>' +
      '</div>';
    for (const box of host.querySelectorAll('.sf-fd-icon')) {
      const img = box.getAttribute('data-img');
      if (img) box.innerHTML = '<img alt="" src="' + img + '">';
    }
    const bk = host.querySelector('[data-m="back"]');
    if (bk) bk.addEventListener('click', () => openFriendMenu(Number(current && current.sel) || 0));
  }
  // 原版 MainMovie.as:18221..18223 的顺序：武器、技能、徒手。
  function openDummyRecord(foe) {
    if (!current) return;
    const s = S() || {};
    const n = Number(s.woodCount) || 0, best = Number(s.woodDamage) || 0;
    guard(openOriginalDialog('3535', { owner: current.host, label: '个人记录', paint(view, close) {
      stopAt(clipOf(view, 'title'), 2);
      for (const [i, key] of ['weaponDamage', 'skillDamage', 'handDamage'].entries()) {
        const value = s.woodBest && Number(s.woodBest[key]);
        setText(clipOf(view, 'text' + (i + 1)), value == null ? '未记录' : String(value || 0));
      }
      for (let i = 1; i <= 4; i++) stopAt(clipOf(view, 'newRecord' + i), 3);
      if (best < 100000) {
        T().showNumber(best, view, 0, 0, 'left', 5);
      } else {
        T().showNumber(88888, view, 0, 0, 'left', 5);
        const digits = Array.from({ length: 5 }, (_, i) => clipOf(view, 'num' + (i + 1)));
        const svg = view.g.ownerSVGElement || view.g;
        const points = [];
        const inverse = view.g.getCTM().inverse();
        for (const digit of digits) {
          const box = digit.g.getBBox(), transform = inverse.multiply(digit.g.getCTM());
          for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y + box.height]]) {
            const point = svg.createSVGPoint(); point.x = x; point.y = y;
            points.push(point.matrixTransform(transform));
          }
          digit.g.style.visibility = 'hidden';
        }
        const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
        const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const size = bottom - top;
        for (const [key, value] of Object.entries({ x: (left + right) / 2, y: (top + bottom) / 2,
          'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size,
          'font-family': '"Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif', 'font-weight': '900',
          fill: '#fffaf0', stroke: '#55290e', 'stroke-width': 1.5, 'paint-order': 'stroke fill',
          'stroke-linejoin': 'round', 'data-dummy-damage': String(best) })) text.setAttribute(key, value);
        text.textContent = String(best);
        view.g.appendChild(text);
        const width = text.getComputedTextLength();
        if (width > right - left - 3) text.setAttribute('font-size', size * (right - left - 3) / width);
      }
      setText(clipOf(view, 'text4'), fitText(clipOf(view, 'text4'),
        '最高总伤害 ' + best + '；训练 ' + n + ' 次\n三项为各场分项最佳，可能来自不同场次'));
      const back = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      back.setAttribute('data-name', 'recordBack');
      for (const rec of view.nodes.values()) {
        if (['3152', '3190'].includes(String(rec.id)) && rec.node) back.appendChild(rec.node);
      }
      view.g.appendChild(back);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const bounds = back.getBBox();
      for (const [key, value] of Object.entries({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fill: 'transparent', 'pointer-events': 'all' })) hit.setAttribute(key, value);
      back.appendChild(hit); back.style.cursor = 'pointer';
      back.addEventListener('click', e => { e.stopPropagation(); close(); });
      if (window.SfUiFeedback) SfUiFeedback.bind(back);
    } }));
    void foe;
  }
  // 「查看装备」—— 由状态页上的那一颗（`b_change` 第 4/5 帧，原版 `friendEquipsInfo()`
  // ⚠ 这里以前根本没有这个函数：`ui-status.js` 的 `openFriendGears()` 是
  function showFriendGears(foe) {
    const target = foe || currentFoe();
    // 主路径：状态页自己盖一层（原版那一页的返回就是回状态页，所以不拆任何东西）。
    // ⚠ 这里不要先 `SfStatus.openFriend()` —— 那是"重开一整页状态页"，
    if (window.SfStatus && SfStatus.showFriendGears && SfStatus.current && SfStatus.current()) {
      SfStatus.showFriendGears();
      return;
    }

    if (current) { current.sel = Number(current.sel) || 0; openFriendGears(target); return; }
    if (window.SfStatus && SfStatus.openFriend) {
      try {
        const p = SfStatus.openFriend(target, () => { if (window.UI && UI.runAction) UI.runAction('challenge'); });
        if (p && typeof p.catch === 'function') p.catch((e) => { if (window.__errs) window.__errs.push('SfStatus gears: ' + (e && e.message)); });
        return;
      } catch (e) {
        if (window.__errs) window.__errs.push('SfStatus gears throw: ' + (e && e.message));
      }
    }
    destroy();
    if (window.UI && UI.runAction) UI.runAction('challenge');
  }


  const BATTLE_HOLD_ATTR = 'data-sf-battle-hold';
  const BATTLE_UNDERLAY_ATTR = 'data-sf-battle-underlay';

  function holdPageForBattle() {
    const page = current;
    const host = page && page.host;
    if (!host || !host.parentNode) return null;
    // ⚠ 不要 `closeSub()`：关卡的三级页（难度页 / 出战确认）如果在这里拆掉，
    // sub host 同样留在树上，战后按原顺序还原。
    // 加载期间保持可见；战斗页挂好后 Main.hideHeldForBattle 再隐藏并转成 hold 标记。
    const sub = (page.sub && page.sub.host) ? page.sub : null;
    const mark = (el) => {
      if (!el || !el.setAttribute) return;
      el.setAttribute(BATTLE_UNDERLAY_ATTR, '');
      // 子元素常把 pointer-events 写成 auto，父级的 none 拦不住；`inert` 连键盘焦点一起挡。
      el.setAttribute('inert', '');
      el.style.pointerEvents = 'none';
    };
    mark(host);
    if (sub) mark(sub.host);
    return { page: page, host: host, sub: sub };
  }
  function unmarkHeld(el) {
    if (!el || !el.removeAttribute) return;
    el.removeAttribute(BATTLE_HOLD_ATTR);
    el.removeAttribute(BATTLE_UNDERLAY_ATTR);
    el.removeAttribute('inert');
    if (el.style) {
      el.style.visibility = '';
      el.style.pointerEvents = '';
    }
  }

  function resumePageAfterBattle(hold, tab, opts) {
    if (!hold || !hold.host || !hold.page) return false;
    if (current !== hold.page || current.host !== hold.host) return false;
    const ui = document.getElementById('ui');

    if (!hold.host.isConnected) {
      if (!ui) return false;
      ui.appendChild(hold.host);
    }
    if (hold.host.isConnected === false) return false;
    unmarkHeld(hold.host);
    // 隐藏期间 `SfRender` 的节拍器会把这一视图标记为不可见而跳过；还原后强制它
    // 下一拍重新量一次，否则页面里还在播的装饰动画要等最多 10 拍（≈0.7 s）才恢复。
    try { if (hold.page.view) hold.page.view.__visible = undefined; } catch (e) {}
    // 三级页要按原顺序还原：主页面之后 = 仍然盖在上面。
    if (opts && opts.keepSub && hold.sub && hold.sub.host) {
      if (!hold.sub.host.isConnected && ui) ui.appendChild(hold.sub.host);
      unmarkHeld(hold.sub.host);
      try { if (hold.sub.view) hold.sub.view.__visible = undefined; } catch (e) {}
      if (current.sub && current.sub.view) setBaseRouterEnabled(current.host, false);
    }
    hold.page.roster = null;
    randomCache = null;            // 同上：战斗结束后的随机页要重抽，不吃旧缓存
    hold.page.sel = 0;
    hold.page.page = 1;
    // 竞技场：先把子页放好再 `showTab`，否则会先画一次随机页 / 赛事页再切过去。
    if (opts && opts.arenaPage) hold.page.arenaPage = opts.arenaPage;
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    if (opts && opts.keepSub && hold.sub && hold.sub.host && hold.sub.host.isConnected) {
      return true;
    }
    try { showTab(tab || 'random'); } catch (e) {
      if (window.__errs) window.__errs.push('challenge resume: ' + (e && e.message));
      return false;
    }
    return true;
  }
  // 请求在开打前就被服务端拒掉（体力不足 / 快照失效 / 网络失败）时用：
  function resumePageAfterFailedRequest(hold) {
    if (!hold || !hold.host || !hold.page) return false;
    if (current !== hold.page || current.host !== hold.host) return false;
    if (!hold.host.isConnected) return false;
    unmarkHeld(hold.host);
    if (hold.sub && hold.sub.host) unmarkHeld(hold.sub.host);

    try { if (hold.page.view) hold.page.view.__visible = undefined; } catch (e) {}
    try { if (hold.sub && hold.sub.view) hold.sub.view.__visible = undefined; } catch (e) {}
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    return true;
  }
  function startFight(foe, kind) {
    prefetchFoe(foe);
    // 客户端这里只发一个请求、然后把服务端返回的录像播出来（`Online.battle`）。
    if (window.Online && window.Online.ready && window.Online.battle) {
      if (kind === 'friend') {
        const target = foe && (foe.snapshotId || foe.remoteId);
        if (!target) { if (window.UI && UI.toast) UI.toast('这位好友还没有战斗快照。'); return; }
        window.Online.battle.friend(String(target), { target: { tab: 'friends' } });
        return;
      }
      const target = foe && (foe.snapshotRef || foe.snapshotId);
      if (!target) { Online.toast('对手尚未加载完成，请刷新后再试。'); return; }
      // 本地先挡一次体力不足：服务端 `consumeEnergy` 必然拒绝，没必要发请求、更没必要
      try { if (State.tickEnergy) State.tickEnergy(); } catch (e) {}
      const s = S();
      if (Number(s && s.energy) < 10) {
        if (window.UI && UI.toast) UI.toast('体力不足（需要 10 点），每 5 分钟恢复 1 点，也可以使用体力药剂');
        return;
      }
      window.Online.battle.random({ snapshotId: target, target: { tab: 'random' } });
      return;
    }
    const s = S();
    if (!s || !window.Main || !Main.startBattle) return;
    const friend = kind === 'friend';
    if (!friend && Number(s.energy) < 10) {
      if (window.UI && UI.toast) UI.toast('体力不足（需要 10 点），每 5 分钟恢复 1 点，也可以使用体力药剂');
      return;
    }

    if (!friend) {
      clearRefreshTimer();
      s.challengeRefresh = { count: 0, ts: Date.now() };
      try { State.save(); } catch (e) {}
    }
    // 经验/金松果在第一张战果页出现前算好：战果页直接写"经验 + 金松果 + 悬浮物品"，
    // 开完宝箱就回随机挑战页，不再弹第三张结算。`settle` 自己缓存，SfFight 与 onEnd
    let reward = null;
    const settle = friend ? null : (winner) => {
      if (reward) return reward;
      const win = winner === 0;
      if (win) { s.dailyWins++; s.allWins++; } else { s.dailyFails++; s.allFails++; }
      reward = State.fightReward(win, { foeLevel: foe.level });
      return reward;
    };
    const go = () => {

      const hold = holdPageForBattle();
      const restore = (tab) => {
        if (resumePageAfterBattle(hold, tab)) return true;
        destroy();
        if (window.SfChallenge && SfChallenge.openAt) SfChallenge.openAt(tab);
        if (window.UI && UI.runAction) UI.runAction('challenge');
        return false;
      };
      Main.startBattle(foe, {
        cost: friend ? 0 : 10, kind: kind || 'challenge', useProps: !friend,
        collectDrops: !friend,

        skipChest: friend,
        // 原版打完回到 `tiaozhan` 的那一页（:2814-2819 `gotoAndStop("temp")` 之后由服务端
        keepScreen: true,
        rewardFor: settle,

        skipResultPanel: friend,
        onEnd: (winner) => {
          const backToFriends = () => { restore('friends'); };
          if (friend) {
            restore('friends');

            const C = window.UI && UI.classic;
            const body = '<p>' + (winner === 0 ? '切磋胜利！' : '再接再厉——') + '和【' + esc(foe.name || '好友') + '】的切磋结束。</p>'
              + '<p class="small-label">切磋不消耗体力、不结算经验与金松果，也不会有战利品；<br>想赚奖励请去「随机」或「关卡」。</p>';
            if (window.SfFightResult && window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic') {
              SfFightResult.open({ kind: 'result', title: '切磋结果', win: winner === 0, text: body,
                actions: [{ label: '确定', run: backToFriends }] }).catch(error => { if (UI.toast) UI.toast(error.message); });
              return;
            }
            if (C && C.modal) C.modal('切磋结果', body, [{ label: '确定', run: backToFriends }], { small: true });
            else if (window.UI && UI.toast) UI.toast('切磋结束：不消耗体力、不结算奖励。');
            return;
          }
          settle(winner);
          restore('random');
          if (window.UI && UI.classic && UI.classic.promptLevelUpChoices) UI.classic.promptLevelUpChoices();
        },
      }).catch(() => { restore(friend ? 'friends' : 'random'); });
    };
    go();
  }

  function showTab(key, keepPage) {
    if (!current) return;
    current.detailRequest = (current.detailRequest || 0) + 1;
    clearRefreshTimer();
    const view = current.view;
    // 随机页回到上次选中的那一行（名单缓存还在时）；其它 tab 仍从头开始。
    current.sel = (key === 'random' && randomCacheMatches(randomCache, S()))
      ? Math.max(0, Number(randomCache.sel) || 0) : 0;
    current.refreshRow = false;
    current.tab = key;
    if (current.onlineLoading && current.onlineLoading !== key) { current.onlineRequest = (current.onlineRequest || 0) + 1; current.onlineLoading = null; }
    // 页码归位第一页：`current.page` 是跨 tab 共用的一份状态，不重置的话
    // ⚠ `keepPage`：翻页箭头自己调 `showTab` 时不能再归位 —— 以前这里无条件写回 1，
    if (!keepPage) {
      current.page = 1;
      // 每次进好友页都重取名单：好友/师徒可能刚换过装备，缓存只留给翻页。
      if (key === 'friends') current.onlineFriends = null;
    }
    // 战斗正在播的时候不要重画（见 `goArenaPage` 的注释）：这一页的显示树是给
    if (inBattle()) { current.tab = key; return; }
    closeSub();
    resetHits(view.g.ownerSVGElement);

    stopAt(view, PAGE[key] || PAGE.random);
    wireChrome(view, current.host);
    if (key === 'gates') showGates();
    else if (key === 'arena') showArena();
    else if (key === 'friends') showFriends();
    else showRandom();
    // ⚠ 收尾必须重新静音 + 重写顶栏数值：`stopAt(view, 帧)` 会重建整棵子树，
    settleFrame(view);
    fillChrome(view);
    setTabs(view, key);
    if (key === 'arena' && current && current.arenaPage === 'menu') paintLadderDailyHint(view);
  }
  // 把左右翻页箭头摆到"名单列两侧"（舞台坐标，实测）。
  // · 真正的坑是箭头元件的原点不在画稿中心：`3156` 的透明热区在局部
  const ARROW_Y = 80.8;
  const ARROW_POS = { left: { x: 8.6, y: ARROW_Y }, right: { x: 208.1, y: ARROW_Y } };

  const ARROW_SPEC = (onFire) => ({ hover: 0, press: 0, idle: 1, onFire: onFire });
  function placeArrows(view) {
    for (const k of ['left', 'right']) {
      const c = clipOf(view, k);
      const g = c && (c.g || c);
      if (!g || !g.setAttribute) continue;
      const m = parseMatrix(g.getAttribute('transform'));
      if (!m) continue;
      const p = ARROW_POS[k];
      g.setAttribute('transform', 'matrix(' + m.a + ',' + m.b + ',' + m.c + ',' + m.d + ',' + p.x + ',' + p.y + ')');
    }
  }

  function settleFrame(view) { applySilence(view); }
  // 把这一页"静"下来：按钮 / 箭头 / 行 / 拳套卡都是状态精灵，不冻住会各自循环播。
  // ⚠ 老的写法要列两张例外表（`skip` 里"我们自己拨帧的" + `protect` 里"数字精灵不许钉"）——
  function applySilence(view) {
    const t = T();
    if (!t) return;
    t.freezeDescendants(view);
  }


  function onlineHint(view, text) {
    if (!window.__SSDZ_ONLINE__ || !view || !view.g) return;
    let hint = view.g.querySelector('[data-online-roster-note]');
    if (!hint) {
      hint = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      hint.setAttribute('data-online-roster-note', ''); hint.setAttribute('x', '18'); hint.setAttribute('y', '159');
      hint.setAttribute('font-size', '7'); hint.setAttribute('fill', '#673c1a'); hint.setAttribute('pointer-events', 'none'); view.g.appendChild(hint);
    }
    hint.textContent = text;
  }
  function loadOnlineRoster(kind, accept) {
    const page = current;
    if (!page || page.onlineLoading === kind) return;
    const request = page.onlineRequest = (page.onlineRequest || 0) + 1;
    page.onlineLoading = kind; page.roster = []; page.refreshRow = kind === 'random';
    fillRows(page.view, [], 0, 0); showUserPic(page.view, null); onlineHint(page.view, '正在读取服务器对手…');
    if (kind === 'random') {
      const refresh = clipOf(page.view, 'f4');
      wireClickable(refresh, { hover: 2, press: 2, idle: 1, onFire: () => { if (!page.onlineLoading) showRandom(); } });
    }
    OnlineUI.roster(kind).then(data => {
      if (current !== page || page.tab !== kind || page.onlineRequest !== request || inBattle()) return;
      page.onlineLoading = null; accept(data); if (kind === 'random') showRandom(); else showFriends();
    }).catch(error => {
      if (current !== page || page.tab !== kind || page.onlineRequest !== request) return;
      page.onlineLoading = null; onlineHint(page.view, '读取失败，请返回后重试。'); Online.toast(Online.errText(error));
    });
  }
  function showRandom() {
    const view = current.view;
    const s = S();
    if (randomCache && window.Online && Online.ready && randomCache.roster.some(r => r.expiresAt && r.expiresAt <= Online.serverNow())) randomCache = null;
    clearRefreshTimer();
    // 名单缓存和 `current.roster` 分开：`current.roster` 是各 tab 共用的，好友页会把它
    if (!randomCacheMatches(randomCache, s) || !randomCache.roster || !randomCache.roster.length) {
      if (window.Online && Online.ready && window.OnlineUI) {
        loadOnlineRoster('random', data => { randomCache = { state: S(), account: onlineAccountId(), roster: data.opponents }; }); return;
      }
      randomCache = { state: s, account: '', roster: rollRoster() };
    }
    current.roster = randomCache.roster;
    current.page = 1;
    current.refreshRow = true;
    current.sel = Math.max(0, Math.min(randomCache.roster.length - 1, Number(randomCache.sel) || 0));
    randomCache.sel = current.sel;
    fillRows(view, current.roster.slice(0, 3), current.sel, 0);
    // 随机页只有 3 行：第 4 行是「刷新玩家」按钮，那颗拳套卡 `s4` 不归 `fillRows` 管。
    // 原版 `doShowFriends`（:13353）每一行都先清到末帧，这里补上 —— 否则从好友页切回来时
    const s4 = clipOf(view, 's4');
    if (s4) { stopAt(s4, s4.frameCount ? s4.frameCount() : 1); unwire(s4); }
    const vip4 = clipOf(view, 'vip4');
    if (vip4) { stopAt(vip4, 2); setVisible(vip4, false); }
    const refresh = clipOf(view, 'f4');
    const rf = refreshState();
    const left = refreshRemaining(rf);
    const exhausted = left <= 0;
    if (refresh && refresh.byName) {
      setText(refresh.byName('friendname'), '刷新玩家');
      setText(refresh.byName('flevel'), '');
    }
    if (refresh && refresh.g) {
      refresh.g.style.opacity = exhausted ? '0.42' : '';
      refresh.g.setAttribute('aria-disabled', exhausted ? 'true' : 'false');
    }
    wireClickable(refresh, {
      hover: 2, press: 2, idle: 1,
      onFire: () => {
        const sNow = S();
        const rfNow = refreshState();
        if (refreshRemaining(rfNow) <= 0) {
          if (window.UI && UI.toast) UI.toast('刷新次数已用完：挑战一个随机敌人或等待10分钟后再刷新');
          return;
        }
        sNow.challengeRefresh = { count: rfNow.count + 1, ts: Date.now() };
        try { State.save(); } catch (e) {}
        // 手动刷新：作废缓存，只重取名单 + 重画那三行。
        randomCache = null;
        showRandom();
      },
    });
    if (refresh && refresh.g) {
      refresh.g.style.cursor = exhausted ? 'not-allowed' : 'pointer';
      refresh.g.style.pointerEvents = exhausted ? 'none' : 'auto';
      refresh.g.style.outline = 'none';
      refresh.g.style.webkitTapHighlightColor = 'transparent';
    }

    if (exhausted) {
      const wait = Math.max(1000, REFRESH_WINDOW - (Date.now() - rf.ts) + 50);
      refreshTimer = setTimeout(() => {
        refreshTimer = 0;
        if (current && current.tab === 'random' && !current.sub) showTab('random');
      }, wait);
    }
    setText(clipOf(view, 'page'), '1/1');
    setVisible(clipOf(view, 'left'), false);
    setVisible(clipOf(view, 'right'), false);
    showUserPic(view, current.roster[current.sel || 0] || null);
    prefetchFoe(current.roster[current.sel || 0] || null);

    onlineHint(view, '玩家为异步快照；AI 一样消耗体力、结算奖励。');
  }


  function rollAddFriendCandidates() {
    const s = S() || {};
    const cap = State.MAX_PLAYER_LEVEL || 90;
    const base = Math.max(3, Math.min(Number(s.level) || 1, cap));
    return Array.from({ length: 3 }, () => State.genAI(
      Math.min(cap, Math.max(2, base + 2 + Math.floor(Math.random() * 11))), '',
      { levelJitter: 0, gearSelfLevel: true }));
  }

  function openAddFriendPage() {
    if (window.Online && Online.ready && window.OnlineUI) { OnlineUI.addFriendPage(null, () => { if (current) { current.onlineFriends = null; showTab('friends'); } }); return; }
    const C = window.UI && UI.classic;
    if (!C || !C.modal) { if (window.UI && UI.toast) UI.toast('添加好友界面不可用'); return; }
    let cands = rollAddFriendCandidates(), selected = 0, added = new Set();
    const body = () => '<div class="sf-addfriend">' +
      '<p class="sf-addfriend-tip">选中一位推荐好友，添加好友。</p>' +
      '<div class="sf-addfriend-list">' + cands.map((c, i) => {
        const has = !!(State.friendOf && State.friendOf(c.name) || added.has(c.name));
        return '<div class="sf-addfriend-row' + (i === selected ? ' active' : '') + '" data-add-i="' + i + '">' +
          '<span class="sf-addfriend-identity"><span class="sf-addfriend-lv">Lv.' + esc(c.level) + '</span>' +
          '<b class="sf-addfriend-name">' + esc(c.name) + '</b></span>' +
          '<span class="sf-addfriend-stats"><i>力 ' + esc(c.power) + '</i><i>敏 ' + esc(c.agility) + '</i><i>速 ' + esc(c.speed) + '</i><i>血 ' + esc(c.hp) + '</i></span>' +
          '<button type="button" class="uc-button tiny ' + (has ? 'muted' : 'gold') + '" data-add-friend="' + i + '"' + (has ? ' disabled' : '') + '>' + (has ? '已是好友' : '加好友') + '</button>' +
          '</div>';
      }).join('') + '</div>' +
      '<div class="sf-addfriend-foot"><button type="button" class="uc-button tiny" data-add-refresh>换一批</button></div></div>';
    const m = C.modal('添加好友', body(), [
      { label: '关闭', cls: 'muted' },
    ], { small: false });
    const root = m && m.element;
    if (!root) return;
    root.classList.add('sf-addfriend-dialog');
    const repaint = () => {
      const box = root.querySelector('.modal-body');
      if (box) box.innerHTML = body();
    };
    root.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-friend]');
      if (add) {
        e.preventDefault(); e.stopPropagation();
        const c = cands[Number(add.dataset.addFriend)];
        if (!c) return;
        const r = State.addFriend(c);
        if (r.ok) { added.add(c.name); if (window.UI && UI.toast) UI.toast(r.msg); }
        else if (window.UI && UI.toast) UI.toast(r.msg || '添加失败');
        repaint();
        return;
      }
      if (e.target.closest('[data-add-refresh]')) {
        e.preventDefault(); e.stopPropagation();
        cands = rollAddFriendCandidates(); selected = 0; added = new Set(); repaint();
        return;
      }
      const row = e.target.closest('[data-add-i]');
      if (row) { selected = Number(row.dataset.addI) || 0; repaint(); }
    });
  }


  function showFriends() {
    const view = current.view;
    const online = window.Online && Online.ready && window.OnlineUI;
    if (online && (!current.onlineFriends || current.onlineFriends.state !== S())) {
      loadOnlineRoster('friends', data => { current.onlineFriends = { state: S(), roster: data.opponents, kin: data.kin || null }; }); return;
    }
    const all = online ? onlineFriendRoster(current.onlineFriends.roster, current.onlineFriends.kin) : friendRoster();
    const pages = Math.max(1, Math.ceil(all.length / 4));
    current.page = Math.min(Math.max(1, current.page || 1), pages);
    const slice = all.slice((current.page - 1) * 4, current.page * 4);

    current.roster = all;
    current.refreshRow = false;
    fillRows(view, slice, current.sel || 0, (current.page - 1) * 4);
    setText(clipOf(view, 'page'), current.page + '/' + pages);
    setVisible(clipOf(view, 'left'), current.page > 1);
    setVisible(clipOf(view, 'right'), current.page < pages);
    // ⚠ 翻页箭头在这一帧里的落点是导出数据里的样子（实测 `left` 在舞台 x≈10、
    placeArrows(view);
    // 翻页箭头：`showTab(key, true)` —— 不能让 `showTab` 把页码拨回第 1 页。
    wireClickable(clipOf(view, 'left'), ARROW_SPEC(() => { current.page--; current.sel = 0; showTab('friends', true); }));
    wireClickable(clipOf(view, 'right'), ARROW_SPEC(() => { current.page++; current.sel = 0; showTab('friends', true); }));
    wireClickable(clipOf(view, 'addfriend'), {
      hover: 2,
      onFire: openAddFriendPage,
    });
    if (!all.length) setText(clipOf(view, 'page'), '1/1');
    showUserPic(view, slice[current.sel || 0] || null);
    onlineHint(view, all.length ? '玩家为异步快照；AI 好友可免费切磋。' : '还没有好友，可输入玩家 ID 或随机添加 AI。');
  }

  // 关卡（`showGate` :1015 / `MainMovie.as:23267`）—— 一级页 = fubenSub 的 3 个门
  // ⚠ 三条都是对着原版改回来的（用户 2026-10 报的"关卡界面没有对齐"）：
  // ⚠ 门卡（`button1..3`，4748）的帧号是逐帧渲染实测出来的（素材 4748 只有 3 帧）：
  const GATE_CARD = { open: 1, running: 2, locked: 3 };
  // `_loc2 <= getMaxGate()+1` → `gotoAndStop(1)`（金「挑战他」），否则 `gotoAndStop(3)`（灰）。
  // 而 `stageRuns` 里只要还留着一份没打完的存档，整扇门就永远写着「继续挑战」——
  function gateState(t) {
    const types = (window.GData && GData.STAGE_TYPES) || [];
    if (!types[t]) return 'locked';
    let open = false;
    for (let st = 1; st <= 6; st++) {
      if (State.stageAccess(t * 6 + st).ok) { open = true; break; }
    }
    return open ? 'open' : 'locked';
  }
  function gateCardFrame(t) {
    return gateState(t) === 'locked' ? GATE_CARD.locked : GATE_CARD.open;
  }
  function showGates() {

    const view = current.view;
    const types = (window.GData && GData.STAGE_TYPES) || [];
    const sub = clipOf(view, 'fubenSub');
    const level = Number((S() || {}).level) || 1;
    if (!sub) return;

    stopAt(sub, level > 4 ? 1 : 2);
    if (level <= 4) { wireClickable(clipOf(view, 'back'), { hover: 2, onFire: () => { destroy(); UI.runAction('home'); } }); return; }
    const pageCount = Math.max(1, Math.ceil(types.length / 3));
    const page = Math.max(0, Math.min(pageCount - 1, Number(current.gatePage) || 0));
    current.gatePage = page;
    let sel = Math.max(0, Math.min(types.length - 1, Number(current.gateSel) || 0));
    if (sel < page * 3 || sel >= page * 3 + 3) sel = page * 3;
    current.gateSel = sel;
    stopAt(sub.byName ? sub.byName('newYearMc') : null, 2);
    for (let i = 0; i < 3; i++) {
      const t = page * 3 + i;
      const card = sub.byName ? sub.byName('button' + (i + 1)) : null;
      const bg = sub.byName ? sub.byName('bg' + (i + 1)) : null;
      if (!types[t]) { setVisible(card, false); setVisible(bg, false); continue; }
      setVisible(card, true); setVisible(bg, true);
      stopAt(card, gateCardFrame(t));
      stopAt(bg, t * 2 + 1);
      wireClickable(card, {
        hover: 0, press: 0,
        idle: () => gateCardFrame(t),
        onFire: () => {
          if (gateState(t) === 'locked') { lockedNotice(t); return; }
          current.gateSel = t;
          guard(openGate(t));
        },
      });

      if (card && card.g) {
        card.g.addEventListener('mouseenter', () => {
          if (!current || current.gateSel === t) return;
          current.gateSel = t;
          writeGateDesc(sub, types, t);
        });
      }
    }
    writeGateDesc(sub, types, sel);

    const left = sub.byName ? sub.byName('left_btn') : null;
    const right = sub.byName ? sub.byName('right_btn') : null;
    setVisible(left, page > 0);
    setVisible(right, page < pageCount - 1);
    setText(clipOf(view, 'page'), (page + 1) + '/' + pageCount);
    const flip = (delta) => {
      const next = Math.max(0, Math.min(pageCount - 1, page + delta));
      if (next === page) return;
      current.gatePage = next;
      current.gateSel = next * 3;
      showGates();
    };
    wireClickable(left, { hover: 0, onFire: () => flip(-1) });
    wireClickable(right, { hover: 0, onFire: () => flip(1) });
    wireClickable(clipOf(view, 'back'), { hover: 2, onFire: () => { destroy(); if (window.UI && UI.runAction) UI.runAction('home'); } });
  }

  function writeGateDesc(sub, types, i) {
    const type = types[i];
    const text = type ? (type.name + type.desc + '，' + type.recommend + '。') : '';
    setText(sub.byName ? sub.byName('desc') : null, wrap(text, 22));
  }
  function lockedNotice(t) {
    const msg = State.stageAccess(t * 6 + 1).msg;
    if (window.UI && UI.toast) UI.toast(msg);
  }

  // 竞技场（原版 `showMyRacing` :13265 → `showRacing0/1/2` + `showRank`）
  // 原版这一套完全建立在服务端上：开房、报名、掷骰子、天梯积分排名。
  // 复刻没有服务端，所以界面用原版的帧（6 / 4 / 7 / 8 / 9），玩法接复刻自己的实现
  function arenaGo(page) {
    if (!current) return;
    if (page !== 'match') cancelArenaAutoFight();
    current.arenaPage = page;
    showTab('arena');
  }

  function goArenaPage(page) {
    if (page) {
      arenaPage = page;
      if (current) current.arenaPage = page;
      if (page !== 'match') cancelArenaAutoFight();
    }
    // ⚠ 挑战页那一层可能已经不在 DOM 上了：`Main.startBattle` 一开打就
    if (!current || !viewAttached()) {
      if (page) pendingArenaPage = page;
      pendingTab = 'arena';
      SfChallenge.openAt('arena');
      if (window.UI && UI.runAction) UI.runAction('challenge');
      // 页面是异步挂的：战果弹窗必须等背景真的回来再开，否则会被 openChallenge
      return waitArenaView();
    }
    // ⚠ 开打的那一瞬间也会走到这里（`fightArena` 里是 `Main.startBattle(...)` 之后紧跟
    if (inBattle()) { closeArenaHint(); return; }
    // ⚠ "当时正在打"和"存档里 `busy` 还是 true"（打一半关掉页面 / 刷新）是两回事：
    ClassicExtrasClearBusy();
    showTab('arena');
    return Promise.resolve();
  }
  function waitArenaView(limit) {
    const max = Number(limit) || 120;
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        if (!current || viewAttached() || n++ >= max) { resolve(); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function viewAttached() {
    return !!(current && current.view && current.view.g && current.view.g.isConnected && current.host && current.host.isConnected);
  }
  // 现在有没有一场战斗正在播。
  // ⚠ 只按 `busy` 判会在"打一半刷新"之后永远为真，那一页就再也画不出来了。
  function inBattle() {
    const CE = window.ClassicExtras;
    if (!CE || !CE.arenaRun) return false;
    const run = CE.arenaRun();
    if (!(run && run.busy)) return false;
    return battleOnStage();
  }

  function battleOnStage() {
    return !!document.querySelector('[aria-label="跳过战斗"],[aria-label="切换战斗速度"]');
  }
  // 把存档里"打了一半"的 `busy` 抹掉（回到赛事页时用；不抹会一直卡在"战斗中"）。
  function ClassicExtrasClearBusy() {
    const CE = window.ClassicExtras;
    if (CE && CE.clearArenaBusy) { try { CE.clearArenaBusy(); } catch (e) {} }
  }
  // 竞技场报名后的"赛事页"：原版是 7638 的第 5 帧（`join1..4` 四个席位 + `statu`），
  // 由服务端开房后 `showRacing2` 拨过去。复刻的对手在本地生成，所以这一页照原版帧摆席位：
  // · `join1..4`（席位卡 3385）第 1 帧 = 有人（带 `name` / `level` 两个字段），第 2 帧 = 空位；
  function showArenaMatch() {
    const view = current && current.view;
    if (!view) return;
    closeArenaHint();
    stopAt(view, ARENA.join);
    wireClickable(clipOf(view, 'back'), { hover: 2, onFire: () => arenaGo('home') });
    const run = (window.ClassicExtras && ClassicExtras.arenaRun) ? ClassicExtras.arenaRun() : null;
    paintArenaSeats(view, run);
    // 赛事页只亮 3 秒就自动开打：半决赛/决赛都不再弹「进入/开始」确认，和天梯一致。
    if (run && !run.busy && !run.settled) scheduleArenaAutoFight(run);
  }

  // 升级奖励/三选一/属性点还开着时，竞技场不能自动开下一场：
  // `clearUiForBattle` 会把升级页和三选一弹窗一起从 #ui 摘掉；存档里的 wsPicks 还在，
  // 战斗结束后由经典 UI 的待选看门狗补弹。
  function arenaRewardPending() {
    try {
      if (typeof State !== 'undefined') {
        if (typeof State.pendingWS === 'function' && State.pendingWS() > 0) return true;
      }
      if (window.SfLevelUp && typeof SfLevelUp.isOpen === 'function' && SfLevelUp.isOpen()) return true;
      if (document.querySelector && document.querySelector('.classic-modal-overlay, .ws-choice-dialog')) return true;
    } catch (e) {}
    return false;
  }
  function promptArenaChoices() {
    try {
      if (window.SfLevelUp && typeof SfLevelUp.isOpen === 'function' && SfLevelUp.isOpen()) return;
      if (window.SfFightResult && typeof SfFightResult.isOpen === 'function' && SfFightResult.isOpen()) return;
      if (typeof State === 'undefined') return;
      const pending = typeof State.pendingWS === 'function' && State.pendingWS() > 0;
      if (pending && window.UI && UI.classic && typeof UI.classic.promptLevelUpChoices === 'function') {
        UI.classic.promptLevelUpChoices();
      }
    } catch (e) {}
  }

  const ARENA_AUTO_FIGHT_MS = 3000;
  let arenaAutoTimer = null;
  function cancelArenaAutoFight() {
    if (arenaAutoTimer) { clearTimeout(arenaAutoTimer); arenaAutoTimer = null; }
  }
  function scheduleArenaAutoFight(run) {
    cancelArenaAutoFight();
    if (!run || run.busy || run.settled) return;
    const phase = run.phase;
    arenaAutoTimer = setTimeout(() => {
      arenaAutoTimer = null;
      if (!current || current.tab !== 'arena' || current.arenaPage !== 'match' || inBattle()) return;
      const CE = window.ClassicExtras;
      if (!CE || !CE.arenaRun || !CE.fightArena) return;
      const live = CE.arenaRun();

      if (!live || live !== run || live.busy || live.settled || live.phase !== phase) return;
      // 先把「匹配中」清掉再等弹窗：否则宝箱 / 升级弹窗一直开着时，整页会永远停在匹配动画。
      // ⚠ 这里不再重画赛事页：临开打前整页重建会顿一下，而这一页马上就会被战斗页盖住。
      if (live.matching) {
        live.matching = false;
        if (CE.saveArenaRun) { try { CE.saveArenaRun(live); } catch (e) {} }
      }
      if (arenaRewardPending()) { scheduleArenaAutoFight(live); return; }
      if (window.SfFightResult && SfFightResult.destroy) {
        try { SfFightResult.destroy(); } catch (e) {}
      }
      closeArenaHint();
      // 不要 `destroy()`：撕掉挑战页后 `#ui` 只剩空壳，战斗素材加载的整段时间都会露绿底。
      // `fightArena` 自己会 `holdPageForBattle()`，战斗页挂好后再由 `SfFight` 清屏。
      CE.fightArena(live);
    }, ARENA_AUTO_FIGHT_MS);
  }

  function closeArenaHint() {
    cancelArenaAutoFight();
  }
  // 竞技场赛事页的四个席位（原版 `showRacing2` 摆 `join1..4`，写 `name` / `level` / `cup.rate`）。
  // 所以只填"玩家 + 已确定的对手"，其余留空位 —— 不编服务端才会有的对手数据。
  const ARENA_NAME_SIZE = 11;          // 素材字号 12；小一号才不压头像
  const ARENA_NAME_DX = 2.5;           // 整体右移，离开左侧头像
  const ARENA_NAME_WIDTH = 73.5;       // 右移后仍留在 3385 的 76.2 字段框内
  function setArenaSeatName(clip, name) {
    if (!clip) return;
    setText(clip, String(name == null ? '' : name));
    const R = window.SfRender;
    if (R && R.layoutText) R.layoutText(clip, { size: ARENA_NAME_SIZE });
    // 席位只有一行：超宽继续缩字号，折行会压到下面的「今日金杯」。
    if (R && R.fitTextWidth) R.fitTextWidth(clip, { width: ARENA_NAME_WIDTH, min: 8 });
    const node = clip.g || clip;
    if (node && node.querySelectorAll) {
      for (const t of node.querySelectorAll('text')) {
        t.setAttribute('x', (Number(t.getAttribute('x')) || 0) + ARENA_NAME_DX);
      }
    }
  }
  function selfCupToday() {
    try { return Math.max(0, Number(State.goldCupToday && State.goldCupToday()) || 0); } catch (e) { return 0; }
  }
  function paintArenaSeats(view, run) {
    const s = S() || {};
    const rows = [null, null, null, null];
    if (run) {
      rows[0] = { name: s.name || '我', level: s.level };
      if (run.phase === 'semi') {

        rows[1] = run.foe || null;
        rows[2] = run.finalist || null;
        rows[3] = run.consolation || null;
      } else {
        rows[1] = run.foe || null;
        rows[2] = (run.phase === 'final' ? run.finalist : run.consolation) || null;
        rows[3] = run.consolation || null;
      }
    }
    for (let i = 0; i < 4; i++) {
      const card = clipOf(view, 'join' + (i + 1));
      if (!card) continue;
      const who = rows[i];
      stopAt(card, who ? 1 : 2);
      const cup = clipOf(card, 'cup');
      if (!who) { setVisible(cup, false); continue; }
      setArenaSeatName(clipOf(card, 'name'), who.name);
      setText(clipOf(card, 'level'), String(who.level == null ? '' : who.level));
      // 今日金杯：本人读账号当日累计；AI 补位统一 0。真人快照对手只能由服务端带 `cupToday`，
      // 不能拿快照里的旧值。
      const cups = i === 0 ? selfCupToday() : Math.max(0, Math.floor(Number(who.cupToday) || 0));
      if (!cup) continue;
      stopAt(cup, 1);
      setVisible(cup, true);
      const rate = clipOf(cup, 'rate');
      if (!rate) continue;
      setText(rate, String(cups));
      if (window.SfRender && SfRender.fitTextWidth) SfRender.fitTextWidth(rate, { width: 33 });
    }
    const statu = clipOf(view, 'statu');
    if (!statu) return;
    // `statu`（7572）是两帧状态精灵：f1 =「匹配对手…」，f2 =「竞技即将开始」。
    // ⚠ 这颗是矢量画稿，没有文本字段，`setText` 写了也不会显示。
    // ⚠ 不放行里面 7570 的 12 帧省略号动画：赛事页是整页大 SVG，每帧重建会让
    // WebView 整层重绘，匹配等待时肉眼可见地卡。只停静态帧。
    if (!run) { stopAt(statu, 2); return; }
    stopAt(statu, run.matching ? 1 : 2);
  }
  function showArena() {
    const view = current.view;
    promptArenaChoices();
    const lv = Math.max(1, Math.round(Number((S() || {}).level) || 1));
    const page = current.arenaPage || 'home';
    if (page === 'rules') return showArenaRules();
    if (page === 'menu') return showArenaMenu();
    if (page === 'match') return showArenaMatch();
    if (page === 'ladder') return showArenaLadder();

    stopAt(view, ARENA.home);
    const compete = clipOf(view, 'compete');
    stopAt(compete, lv >= 10 ? 1 : 2);
    wireClickable(compete && compete.byName ? compete.byName('button1') : null, {
      hover: 0, press: 0, idle: 1,
      onFire: () => {
        if (lv < 10) { if (window.UI && UI.toast) UI.toast('10级以上才可进入！'); return; }
        arenaGo('rules');
      },
    });
    wireClickable(compete && compete.byName ? compete.byName('button2') : null, {
      hover: 0, press: 0, idle: 1,
      onFire: () => { if (lv < 30) { if (window.UI && UI.toast) UI.toast('天梯赛需要达到30级。'); return; } arenaGo('menu'); },
    });
    wireClickable(clipOf(view, 'back'), {
      hover: 2,
      onFire: () => { destroy(); if (window.UI && UI.runAction) UI.runAction('home'); },
    });
  }
  // 冠军赛规则页（`showRacing1` :15179 的 arenaType==1 分支 → 帧 4）。
  // ⚠ 不新造按钮画稿，也不把整页换成现代 DOM；仍然只动原版 7638 第 4 帧。
  function showArenaRules() {
    const view = current.view;
    stopAt(view, ARENA.rules);
    // 说明按真实框宽断行，写清两场名次奖励与门槛；选择弹窗只放两个道具图标。
    // ⚠ 这一块是右侧圆角面板里唯一的正文（字段框 215 宽、行距 13.8、字号 12）。
    const desc = clipOf(view, 'desc');
    if (desc) setText(desc, fitText(desc,
      '【名次奖励】经验、蓝碎片、孵化点\n' +
      '冠军　150 / 8 / 40\n亚军　100 / 6 / 35\n' +
      '季军　 50 / 4 / 30\n殿军　 30 / 3 / 25\n' +
      '【报名】30体力/入场券\n' +
      '经验场10级；碎片场/幻兽场15级'));
    const descNode = desc && (desc.g || desc);
    if (descNode) for (const text of descNode.querySelectorAll('text')) text.setAttribute('x', '7');
    const start = clipOf(view, 'startCompete');
    wireClickable(start, {
      hover: 0, press: 0, idle: 1,
      // 原版这一颗是 `joinArena.do`（开房 → 服务端回 `showRacing2` 落赛事页）。
      // 复刻没有服务端，等价物是 `ClassicExtras.chooseArena()`：先选经验场 / 碎片场，
      onFire: () => {
        const CE = window.ClassicExtras;
        if (CE && CE.chooseArena) CE.chooseArena();
        else if (CE && CE.startArenaCompete) CE.startArenaCompete(0);
        else if (CE && CE.arena) CE.arena();
      },
    });
    wireClickable(clipOf(view, 'back'), { hover: 0, onFire: () => arenaGo('home') });
  }


  // 今日天梯场次：服务端 `Online.daily` 是唯一真值；离线分支退回存档计数。
  // 必须等 `settleFrame` 把整页铺完后再追加，否则会被原版背景盖住。
  function paintLadderDailyHint(view) {
    if (!view || !view.g) return;
    const d = (window.Online && Online.ready) ? Online.daily : null;
    const s = S() || {};
    const played = d ? Math.max(0, Number(d.played) || 0) : Math.max(0, Number(s.joinRankCount) || 0);
    let hintText = '今日已赛 ' + played + ' 场';
    if (d) {
      const left = d.unlimited ? null : Number(d.left);
      const cost = Math.max(0, Number(d.cost) || 0);
      if (left != null && left <= 0) hintText += '（今日次数已用完）';
      else if (cost > 0) hintText += '（本场消耗 ' + cost + ' 金松果）';
      else if (Number(d.freeLeft) > 0) hintText += '（前10场免费）';
    } else {
      const cost = played < 10 ? 0 : played < 20 ? 5 : played < 30 ? 10 : 20;
      if (cost > 0) hintText += '（本场消耗 ' + cost + ' 金松果）';
    }
    let hint = view.g.querySelector('[data-ladder-daily]');
    if (!hint) {
      hint = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      hint.setAttribute('data-ladder-daily', '');
      hint.setAttribute('x', '52');
      hint.setAttribute('y', '128');
      hint.setAttribute('font-size', '8');
      hint.setAttribute('fill', '#673c1a');
      hint.setAttribute('pointer-events', 'none');
    }
    hint.textContent = hintText;
    // 每次重挂都挪到最后：它必须在背景/按钮之后，才能稳定显示在原版画稿上。
    view.g.appendChild(hint);
  }
  function showArenaMenu() {
    const view = current.view;
    stopAt(view, ARENA.menu);
    wireClickable(clipOf(view, 'button1'), {
      hover: 0, press: 0, idle: 1,
      onFire: () => { const CE = window.ClassicExtras; if (CE && CE.rankShop) CE.rankShop(0, 'ladder'); else arenaGo('ladder'); },
    });
    wireClickable(clipOf(view, 'button2'), {
      hover: 0, press: 0, idle: 1,
      onFire: () => startLadderMatch(),
    });
    wireClickable(clipOf(view, 'button3'), { hover: 0, press: 0, idle: 1, onFire: () => arenaGo('ladder') });
    wireClickable(clipOf(view, 'back'), { hover: 0, onFire: () => arenaGo('home') });
  }
  // 「开始比赛」：直接开一场天梯对局。打完之后回原版这一页（天梯菜单），
  // 不是复刻自研的 DOM 天梯页 —— 否则整块背景又从原版 ui 换成现代 ui
  function startLadderMatch() {
    const CE = window.ClassicExtras;
    if (!CE) { arenaGo('ladder'); return; }
    // 原版 `alertRank`（:23720）→ 二次确认 → `rank()` → `beforeRank`（:18149）的
    // 「战斗准备中」3 秒 → 开打；`startRankFlow` 就是这套流程的经典页入口。
    if (CE.startRankFlow) CE.startRankFlow(() => goArenaPage('menu'));
    else if (CE.rankMatch) CE.rankMatch(() => { arenaGo('menu'); });
    else arenaGo('ladder');
  }
  // 天梯榜（`showRank` → 帧 8）：本赛区榜。
  // 原版 `rankList.do` 不带参数，服务端按玩家等级回 `type`（1..6 帧 = 30-39 … 80-90）；
  function showArenaLadder() {
    const view = current.view;
    const s = S() || {};
    stopAt(view, ARENA.ladder);
    stopAt(clipOf(view, 'type'), 1);
    setVisible(clipOf(view, 'left'), false);
    setVisible(clipOf(view, 'right'), false);
    const online = !!(window.Online && window.Online.ready);
    let ladderTop = [], ladderPage = 0, ladderScore = s.integral, ladderRank = 0;

    const paintRows = (rows, myScore, myRank) => {
      for (let i = 0; i < 4; i++) {
        const e = rows[i];
        setText(clipOf(view, 'rank' + (i + 1)), e ? String(e.rank || i + 1) : '');
        setText(clipOf(view, 'name' + (i + 1)), e ? String(e.name || '') : '');
        setText(clipOf(view, 'inte' + (i + 1)), e ? String(e.score) : '');
      }
      setText(clipOf(view, 'myinte'), String(Math.max(0, Math.round(Number(myScore) || 0))));
      setText(clipOf(view, 'myrank'), myRank > 0 ? String(myRank) : '-');
    };


    const renderRows = (rows, myScore, myRank) => {
      ladderTop = Array.isArray(rows) ? rows : [];
      ladderScore = myScore; ladderRank = myRank;
      const pages = Math.max(1, Math.ceil(ladderTop.length / 4));
      ladderPage = Math.max(0, Math.min(ladderPage, pages - 1));
      paintRows(ladderTop.slice(ladderPage * 4, ladderPage * 4 + 4), myScore, myRank);
      setVisible(clipOf(view, 'left'), pages > 1 && ladderPage > 0);
      setVisible(clipOf(view, 'right'), pages > 1 && ladderPage < pages - 1);
    };
    // 单机版：本地模拟榜（保持原行为）；联机版天梯榜只显示真人，没拿到服务端数据时留空。
    const localRows = () => {
      if (window.__SSDZ_ONLINE__) { renderRows([], s.integral, 0); return; }
      const cap = (State.MAX_PLAYER_LEVEL || 90);
      const mine = Math.max(0, Math.round(Number(s.integral) || 0));
      const entries = [];
      for (let n = 0; n < 4; n++) {
        const name = (window.GData && GData.AI_NAMES && GData.AI_NAMES[n * 4]) || ('鼠王' + (n + 1));
        entries.push({ name: name, score: 1350 + n * 83, level: Math.min(cap, 34 + n * 6) });
      }
      entries.push({ name: s.name || '我', score: mine, level: Math.round(Number(s.level) || 1), mine: true });
      entries.sort((a, b) => b.score - a.score);
      const myIdx = entries.findIndex((e) => e.mine);
      renderRows(entries, mine, myIdx + 1);
    };

    if (!online) {
      localRows();
    } else {
      // 先摆一份占位，等服务器回来再填；请求返回时页面可能已经切走，必须核对身份。
      paintRows([], s.integral, 0);
      let awardState = null;

      const showAwardNotice = (info) => {
        const C = window.UI && UI.classic;
        if (!C || !C.modal) return;
        const icon = C.icon ? C.icon('prop', 40) : '';
        const rank = Number(info && info.rank) || 0;
        const granted = !!(info && info.ok && Number(info.cups) > 0);
        const body = '<div class="rank-claim">' +
          '<div class="rank-claim-line"><span>当前排名</span><b>' + (rank > 0 ? '第 ' + rank + ' 名' : '未参赛') + '</b>' +
            '<span>积分</span><b>' + Math.max(0, Math.round(Number(State.state().integral) || 0)) + '</b></div>' +
          (granted
            ? '<div class="rank-claim-reward"><span class="reward-icon">' + icon + '</span><b>金杯 +' + Number(info.cups || 0) + '</b><span>当前 ' + Number(State.state().goldCup || 0) + '</span></div>'
            : '<p class="rank-claim-note">' + esc((info && info.msg) || '暂时不能领取') + '</p>') +
          '<p class="small-label">每周一 0 点积分减半（人机回到 300 分）；赛区前30名、且至少超过一个人机，才能领取 50 金杯。</p>' +
          '</div>';
        C.modal('天梯奖励', body, [{ label: '知道了', cls: 'gold' }], { small: true });
      };
      const load = () => Promise.all([
        Online.get('/api/ladder?limit=200'),
        Online.get('/api/ladder/award'),
      ]).then(([ladder, award]) => {
        if (!current || current.view !== view) return null;
        awardState = award;
        ladderPage = 0;
        // 赛区帧由服务端给（1..6 = 30-39 … 80-90）；不在赛区（<30 级）时保持第 1 帧。
        const frame = Math.max(0, Math.min(6, Number(ladder && ladder.frame) || 0));
        if (frame > 0) stopAt(clipOf(view, 'type'), frame);
        renderRows(ladder.top || [], ladder.me && ladder.me.score, ladder.me && ladder.me.rank);
        return { ladder, award };
      }).catch((e) => {
        if (current && current.view === view && window.UI && UI.toast) UI.toast(window.Online.errText(e));
        return null;
      });
      load();
      // 奖励按钮：先取状态只为了「已领取/没进赛区前30」的提示更准确；
      // 真正的判定仍在服务端 `POST /api/ladder/award`。
      wireClickable(clipOf(view, 'button1'), {
        hover: 0, press: 0, idle: 1,
        onFire: async () => {
          const C = window.UI && UI.classic;
          if (!C) return;
          // 已经领过就直接弹「已经领取过了」，不再发一次请求让服务端回 200+ok:false。
          if (awardState && awardState.claimed) {
            showAwardNotice({ rank: awardState.rank, msg: '本周的天梯奖励已经领取过了。' });
            return;
          }
          let r;
          try {
            r = await window.Online.post('/api/ladder/award', {}, { preserveMirror: true });
          } catch (e) {
            // 服务端把「已领过 / 没进前30 / 没超过人机」作为正常业务结果回 200+ok:false；
            const b = e && e.body;
            if (b && (b.already || b.msg)) {
              awardState = b;
              showAwardNotice({ rank: b.rank, msg: b.msg, already: !!b.already });
              return;
            }
            if (C.toast) C.toast(window.Online.errText(e));
            return;
          }
          awardState = r.award || Object.assign({}, awardState, { claimed: true });
          showAwardNotice({ ok: true, rank: r.rank, cups: r.cups });
          // 服务端状态已写入；重新拉一次把名次/积分/金杯再对一遍。
          if (r && r.ok) await load();
        },
      });

    }
    if (!online) {

      wireClickable(clipOf(view, 'button1'), {
        hover: 0, press: 0, idle: 1,
        onFire: () => {
          const CE = window.ClassicExtras;
          const C = window.UI && UI.classic;
          if (!CE || !CE.claimRankCup || !C) { if (CE && CE.rankShop) CE.rankShop(); return; }
          const r = CE.claimRankCup();
          const icon = C.icon ? C.icon('prop', 40) : '';
          const body = '<div class="rank-claim">' +
            '<div class="rank-claim-line"><span>当前排名</span><b>第 ' + (r.rank || '-') + ' 名</b>' +
              '<span>积分</span><b>' + Math.max(0, Math.round(Number(s.integral) || 0)) + '</b></div>' +
            (r.ok
              ? '<div class="rank-claim-reward"><span class="reward-icon">' + icon + '</span><b>金杯 +' + r.cups + '</b><span>当前 ' + r.goldCup + '</span></div>'
              : '<p class="rank-claim-note">' + esc(r.msg) + '</p>') +
            '<p class="small-label">' + (r.ok ? '每周一 0 点积分减半；赛区前30名且超过至少一个人机即可领取50金杯。' : '每周结算后赛区前30名可领取一次（需要先超过一个人机）。') + '</p>' +
            '</div>';
          C.modal('天梯奖励', body, [{ label: '知道了', cls: 'gold' }], { small: true });
        },
      });
    }

    wireClickable(clipOf(view, 'left'), { hover: 0, onFire: () => {
      if (ladderPage <= 0) return;
      ladderPage -= 1;
      renderRows(ladderTop, ladderScore, ladderRank);
    } });
    wireClickable(clipOf(view, 'right'), { hover: 0, onFire: () => {
      if (ladderPage >= Math.ceil(ladderTop.length / 4) - 1) return;
      ladderPage += 1;
      renderRows(ladderTop, ladderScore, ladderRank);
    } });
    wireClickable(clipOf(view, 'back'), { hover: 0, onFire: () => arenaGo('menu') });
  }

  let originalDialog = null;
  function closeOriginalDialog(owner, expected) {
    const dialog = originalDialog;
    if (!dialog || (owner && dialog.owner !== owner) || (expected && dialog !== expected)) return false;
    originalDialog = null;
    if (dialog.view) dialog.view.destroy();
    dialog.host.remove();
    if (dialog.owner && dialog.owner.isConnected) {
      dialog.owner.style.pointerEvents = dialog.pointerEvents;
      setBaseRouterEnabled(dialog.owner, true);
    }
    return true;
  }
  async function openOriginalDialog(symbol, options) {
    options = options || {};
    closeOriginalDialog();
    const owner = options.owner || (current && current.host);
    const ui = document.getElementById('ui');
    if (!owner || !owner.isConnected || !ui) return null;
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-home ssfight-sub sf-original-dialog';
    host.setAttribute('aria-label', options.label || '确认');
    host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true');
    ui.appendChild(host);
    const dialog = { host, owner, view: null, pointerEvents: owner.style.pointerEvents };
    originalDialog = dialog;
    owner.style.pointerEvents = 'none'; setBaseRouterEnabled(owner, false);
    try {
      await SfRender.loadExtra('tags-social-dialog.json');
      if (originalDialog !== dialog || !owner.isConnected) { closeOriginalDialog(owner, dialog); return null; }
      const view = await SfRender.mountSymbol(host, symbol, { frame: 1, label: options.label || '确认' });
      if (originalDialog !== dialog || !owner.isConnected) { view.destroy(); closeOriginalDialog(owner, dialog); return null; }
      dialog.view = view;
      T().freezeDescendants(view);
      hideSubBackdrop(view);
      options.paint(view, () => closeOriginalDialog(owner, dialog));
      return view;
    } catch (e) { closeOriginalDialog(owner, dialog); throw e; }
  }
  function openOriginalConfirm(options) {
    options = options || {};
    return openOriginalDialog('4421', { owner: options.owner, label: options.label || '确认', paint(view, close) {
      setText(clipOf(view, 'info'), fitText(clipOf(view, 'info'), options.text || ''));
      const ok = clipOf(view, 'button1');
      const cancel = clipOf(view, 'button2');
      // 竞技场报名确认：原版 4421 是「确定在左、取消在右」，用户要求调换。
      // 必须在 wireClickable 之前换，热区才会按新位置量。其他确认框不传 swapButtons，保持原版。
      if (options.swapButtons && ok && cancel && ok.g && cancel.g) {
        const ma = (clip) => {
          const p = String((clip && clip.g && clip.g.__baseMa) || '').split(',').map(Number);
          return p.length === 6 && p.every((v) => Number.isFinite(v)) ? p : null;
        };
        const a = ma(ok), b = ma(cancel);
        if (a && b) {
          const dx = b[4] - a[4];
          const sa = Math.abs(a[0]) || 1, sb = Math.abs(b[0]) || 1;
          const halfGap = Math.max(0, Number(options.extraGap) || 0) / 2;
          if (ok.setExtraTransform) ok.setExtraTransform('translate(' + ((dx + halfGap) / sa).toFixed(3) + ',0)');
          if (cancel.setExtraTransform) cancel.setExtraTransform('translate(' + ((-dx - halfGap) / sb).toFixed(3) + ',0)');
        }
      }

      const buttonSpec = { idle: 1, hover: 2, press: 2 };
      wireClickable(ok, Object.assign({}, buttonSpec, { onFire: () => { if (close() && options.accept) options.accept(); } }));
      wireClickable(cancel, Object.assign({}, buttonSpec, { onFire: close }));
    } });
  }
  function subHost() {
    if (!current) return null;
    if (current.sub && current.sub.host && current.sub.host.isConnected) return current.sub.host;
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const el = document.createElement('section');
    el.className = 'classic-home ssfight-home ssfight-sub';
    el.setAttribute('aria-label', '挑战二级页');
    ui.appendChild(el);
    current.sub = { host: el, view: null };
    return el;
  }
  async function openSub(frame) {
    const page = current;
    if (!page) return null;
    const host = subHost();
    if (!host) return null;

    setBaseRouterEnabled(page.host, false);
    const sub = page.sub, mine = (sub.request || 0) + 1;
    sub.request = mine;
    let view = sub.view;
    if (!view) {
      view = await SfRender.mountSymbol(host, '4756', { frame: frame || 5, label: '挑战二级页' });
      if (current !== page || page.sub !== sub || sub.request !== mine || host.isConnected === false) {
        try { view.destroy(); } catch (e) {}
        return null;
      }
      sub.view = view;
      T().freezeDescendants(view);
    } else {
      resetHits(view.g.ownerSVGElement);
      stopAt(view, frame || 5);
    }
    hideSubBackdrop(view);
    return view;
  }
  function isCurrentSub(view, page) {
    return !!(view && page && current === page && page.sub && page.sub.view === view &&
      page.sub.host.isConnected !== false && view.g && view.g.isConnected !== false);
  }

  function hideSubBackdrop(view) {
    if (!view || !view.nodes) return false;
    for (const rec of view.nodes.values()) {
      if (rec && String(rec.id) === '3142' && rec.node) {
        rec.node.style.display = 'none';
        return true;
      }
    }
    return false;
  }
  // 二级/三级页的点击入口统一走它：挂载失败要留下痕迹（`window.__errs`），
  // 否则异步挂载的拒绝会变成"点了没反应"。
  function guard(promise) {
    if (promise && typeof promise.catch === 'function') {
      promise.catch((e) => { if (window.__errs) window.__errs.push('SfChallenge sub: ' + (e && e.message)); });
    }
  }
  function closeSub() {
    closeArenaHint();
    if (current) closeOriginalDialog(current.host);

    if (current && current.host) setBaseRouterEnabled(current.host, true);
    if (!current || !current.sub) return;
    if (current.sub.view) { try { current.sub.view.destroy(); } catch (e) {} }
    if (current.sub.host && current.sub.host.parentNode) current.sub.host.parentNode.removeChild(current.sub.host);
    current.sub = null;
  }
  // 三级页 = 难度选择（`showhardWin` :23409：`tiaozhanSub.gotoAndStop(5)` + `style` 按门号切帧
  // ⚠ 「继续挑战」只在六级页的这一档（用户 2026-10 口径："参考 ssfight 给出正确的显示逻辑"）。
  // 复刻的 `State.stageRun(id)` 就是那份 `keep`：一轮打到一半还留着存档（没通关时
  async function openGate(t) {
    const page = current;
    const view = await openSub(5);
    if (!isCurrentSub(view, page)) return;
    resetHits(view.g.ownerSVGElement);
    stopAt(clipOf(view, 'style'), t + 1);
    const starFrame = (id) => (State.stageRun(id) ? 2 : (State.stageAccess(id).ok ? 1 : 3));
    for (let st = 1; st <= 6; st++) {
      const id = t * 6 + st;
      const card = clipOf(view, 'button' + st);

      stopAt(card, starFrame(id));
      wireClickable(card, {
        hover: 0, press: 0,
        idle: () => starFrame(id),
        onFire: () => ((State.stageRun(id) || State.stageAccess(id).ok) ? guard(openGateConfirm(t, st)) : lockedNotice(t)),
      });
    }
    wireClickable(clipOf(view, 'back'), { hover: 0, onFire: () => { closeSub(); showTab('gates'); } });
  }
  // 三级页 = 出战确认（`showFightWin` :1192：`gotoAndStop(4)` + `info1`/`info2` + 两颗键）。
  // ⚠ 用户 2026-10 口径："关卡界面点击挑战后的界面中的介绍文字排版有大问题，严重超出屏幕范围。"
  // ⚠ 换位必须在 `wireClickable` 之前，热区才会按新位置重新量。
  async function openGateConfirm(t, st) {
    const id = t * 6 + st;
    const page = current;
    const view = await openSub(4);
    if (!isCurrentSub(view, page)) return;
    resetHits(view.g.ownerSVGElement);
    const s = S(), type = GData.stageTypeOf(id), run = State.stageRun(id);
    const npc = State.npcOf(id, run ? run.npcIndex : 1);
    const reward = State.stageReward(id);
    const exhausted = run && run.needsRevive && run.revives >= 2;
    const cost = exhausted ? '复活机会已用完' : run ? (run.needsRevive ? '复活需1个挑战书' : '不消耗挑战书') : '每轮1个挑战书';
    const info1 = clipOf(view, 'info1'), info2 = clipOf(view, 'info2');
    const enemyCount = GData.stageEnemyCount ? GData.stageEnemyCount(id) : 3;
    const expText = enemyCount === 1 ? String(GData.stageNpcExp(id, 1))
      : [1, 2, 3].map((i) => GData.stageNpcExp(id, i)).join('/');

    setFieldText(info1, '【消耗】' + cost + '\n【奖励】经验' + expText + '、金松果' + reward.gold + '、几率得碎片', 11);
    setFieldText(info2,
      '对手：' + npc.name + '（' + (run ? run.npcIndex : 1) + '/' + enemyCount + '）\n' +
      (enemyCount === 1 ? '超级大关只有1个敌人\n中途失败可用挑战书复活'
        : '连续击败3名敌人\n中途失败可用挑战书复活'), 11);
    const ok = clipOf(view, 'button1'), no = clipOf(view, 'button2');
    // button1=战斗 / button2=返回；必须在 `wireClickable` 之前换，热区才会按新位置重新量。
    if (ok && no && ok.g && no.g) {
      const ma = (clip) => {
        const p = String((clip && clip.g && clip.g.__baseMa) || '').split(',').map(Number);
        return p.length === 6 && p.every((v) => Number.isFinite(v)) ? p : null;
      };
      const a = ma(ok), b = ma(no);
      if (a && b) {
        const dx = b[4] - a[4], halfGap = 13;
        const sa = Math.abs(a[0]) || 1, sb = Math.abs(b[0]) || 1;
        if (ok.setExtraTransform) ok.setExtraTransform('translate(' + ((dx + halfGap) / sa).toFixed(3) + ',0)');
        if (no.setExtraTransform) no.setExtraTransform('translate(' + ((-dx - halfGap) / sb).toFixed(3) + ',0)');
      }
    }
    wireClickable(ok, {
      hover: 0, press: 0, idle: 1,
      onFire: () => {
        const c = window.UI && UI.classic;
        // ⚠ 不要先 `closeSub()` / `destroy()`：`stageFight()` 会把整棵挑战页（连同这颗
        if (c && c.stageFight) { c.stageFight(id); return; }
        // 没有经典关卡入口（现代/素材缺失）才退回"先拆页再走 UI 路由"。
        closeSub();
        destroy();
        if (window.UI && UI.runAction) UI.runAction('stages');
      },
    });
    wireClickable(no, { hover: 0, press: 0, idle: 1, onFire: () => { closeSub(); showTab('gates'); } });
    if (exhausted) stopAt(ok, 3);
    void type;
  }


  let openTrace = '';
  // 下一次 `open()` 直接落到哪个 tab（`openAt` 用；`open()` 是异步的，
  let pendingTab = null;

  let pendingGate = null;

  let arenaPage = null;
  let pendingArenaPage = null;
  async function open(container) {
    openTrace = 'start';
    if (!window.SfRender || !window.SfRender.mountSymbol) throw new Error('SfRender 未加载（缺 js/ssfight/render.js）');
    const t = T();
    if (!t) throw new Error('SfUiMain.toolkit 不在（缺 js/ssfight/ui-main.js）');
    let host = container || (current && current.host);
    if (!host) {
      const ui = document.getElementById('ui');
      if (ui) {
        ui.innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠挑战"></section>';
        host = ui.querySelector('.ssfight-home');
      }
    }
    if (!host) { openTrace = 'no-host'; return false; }

    const mine = ++seq;
    destroyView();
    openTrace = 'destroyed mine=' + mine;
    await SfRender.loadExtra('tags-challenge.json');
    if (mine !== seq || host.isConnected === false) { openTrace = 'stale'; return false; }

    try { await SfRender.loadExtra('tags-gear.json'); } catch (e) {}
    await loadGearTables();
    if (mine !== seq || host.isConnected === false) { openTrace = 'stale'; return false; }
    const view = await SfRender.mountSymbol(host, '7638', { frame: PAGE.random, label: '挑战' });
    if (mine !== seq || host.isConnected === false) {
      try { view.destroy(); } catch (e) {}
      return false;
    }
    openTrace = 'mounted';
    const wantArena = pendingArenaPage || arenaPage;
    current = { view: view, host: host, tab: 'random', page: 1, sel: 0, gateSel: 0, roster: null, rows: [], refreshRow: false, arenaPage: wantArena || 'home', sub: null };
    pendingArenaPage = null;
    arenaPage = null;
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    applySilence(view);
    try { showTab(pendingTab || 'random'); } catch (e) { if (window.__errs) window.__errs.push('challenge showTab: ' + (e && e.message)); }
    pendingTab = null;
    if (pendingGate != null && current) {
      const g = pendingGate; pendingGate = null;
      current.gatePage = Math.floor(g / 3);
      current.gateSel = g;
      try { guard(openGate(g)); } catch (e) {}
    }
    // 挑战页就是战斗入口：进页后就把核心包拉起来，别等主页 6s 后的空闲预热。
    try {
      if (window.SfFight && SfFight.preloadCore) {
        setTimeout(() => { try { SfFight.preloadCore(); } catch (e) {} }, 250);
      }
    } catch (e) {}
    openTrace = 'done';
    return true;
  }
  function destroyView() {
    clearRefreshTimer();
    cancelFace();
    if (current) {
      closeSub();
      if (current.view) { try { current.view.destroy(); } catch (e) {} }
    }
    closeArenaHint();
    current = null;
  }
  function destroy() {
    seq++;
    destroyView();
    const statusOpen = !!(window.SfStatus && SfStatus.current && SfStatus.current());
    if (!statusOpen && window.SfRender && SfRender.releaseExtra) SfRender.releaseExtra('tags-challenge.json');
  }

  window.SfChallenge = Object.freeze({
    open: open,
    destroy: destroy,
    showTab: (k) => showTab(k),
    // 打开挑战页并直接落到某个 tab（`open()` 是异步的，挂完再切会落到还没建好的树上）。
    openAt: (k) => { pendingTab = k || 'random'; },
    // 战斗前把当前挑战页从 `#ui` 摘下来、打完原样挂回去（同一棵 SVG，不重挂）。
    // `resumePageAfterBattle(hold, tab)` 返回 false 时调用方才退回重挂路径。
    holdPageForBattle: holdPageForBattle,
    resumePageAfterBattle: resumePageAfterBattle,

    resumePageAfterFailedRequest: resumePageAfterFailedRequest,
    // 竞技场里的子页（`home` / `rules` / `menu` / `ladder`）——给回归用例与
    // 外部入口用，不用真的去点那几颗按钮。
    setArenaPage: (p) => { arenaGo(p || 'home'); },

    goArenaPage: (p) => goArenaPage(p),

    openGateAt: (t) => {
      const n = Math.max(0, Math.min(5, Number(t) || 0));
      if (!current) { pendingGate = n; return; }
      current.gatePage = Math.floor(n / 3);
      current.gateSel = n;
      showTab('gates');
      guard(openGate(n));
    },

    refreshGateAt: (t) => {
      const n = Math.max(0, Math.min(5, Number(t) || 0));
      if (!current) { pendingGate = n; return; }
      current.gatePage = Math.floor(n / 3);
      current.gateSel = n;
      guard(openGate(n));
    },
    resetRoster: () => { randomCache = null; if (current) { current.roster = null; current.sel = 0; current.arenaPage = 'home'; } },
    // 打开某一行的动作菜单（探针 / 外部入口用；等价于点那一行）。
    openFriendMenu: (i) => openFriendMenu(Number(i) || 0),
    openAddFriendPage,
    openOriginalConfirm,
    closeOriginalDialog,
    openDummyRecord,
    // 「查看装备」（原版 `friendEquipsInfo()`）：状态页上那颗 `b_change` 的 4/5 帧调它。
    // ⚠ 以前没有这个导出 —— 状态页调 `SfChallenge.showFriendGears` 永远拿到 undefined，
    showFriendGears: (foe) => showFriendGears(foe),
    selectRow: (i) => selectRow(i),
    view: () => (current ? current.view : null),
    subView: () => (current && current.sub ? current.sub.view : null),
    current: () => (current ? { tab: current.tab, page: current.page, sel: current.sel, arenaPage: current.arenaPage } : null),
    // 内部状态快照（调试 / 回归探针用）：行数据、名单、右面板写进去的文本。
    debug: () => {
      if (!current) return null;
      const bg = clipOf(current.view, 'rightBg');
      const btext = (n) => {
        const c = bg && bg.byName ? bg.byName(n) : null;
        return c && c.g ? [...c.g.querySelectorAll('text')].map((t) => t.textContent) : null;
      };
      return {
        tab: current.tab, page: current.page, sel: current.sel, refreshRow: current.refreshRow,
        rows: (current.rows || []).map((r) => (r ? { name: r.name, level: r.level, power: r.power, agility: r.agility, speed: r.speed, hp: r.hp, kind: r.kind, snapshotId: r.snapshotId, snapshotRef: r.snapshotRef } : null)),
        roster: (current.roster || []).map((r) => (r ? { name: r.name, level: r.level, power: r.power, hp: r.hp, kind: r.kind, snapshotId: r.snapshotId, snapshotRef: r.snapshotRef } : null)),
        rightBgFrame: bg ? bg.frame : null,
        stats: { power: btext('power'), agility: btext('agility'), speed: btext('speed'), hp: btext('hp') },
        rowNames: [1, 2, 3, 4].map((i) => {
          const r = clipOf(current.view, 'f' + i);
          const nm = r && r.byName ? r.byName('friendname') : null;
          const lv = r && r.byName ? r.byName('flevel') : null;
          const tx = (c) => (c && c.g ? [...c.g.querySelectorAll('text')].map((t) => t.textContent).join('') : null);
          return { row: 'f' + i, name: tx(nm), level: tx(lv) };
        }),
      };
    },
    trace: () => openTrace,
  });
})();
