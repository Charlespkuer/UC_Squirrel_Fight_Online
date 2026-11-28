// Classic in-battle presentation rendered from the original ssfight fight frame.
(function () {
  'use strict';

  const T = () => (window.SfUiMain && window.SfUiMain.toolkit) || null;
  const S = () => (window.State && State.state && State.state()) || null;

  const raf = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16));
  const caf = (id) => { try { (window.cancelAnimationFrame || clearTimeout)(id); } catch (e) {} };
  const timeNow = () => ((window.performance && performance.now) ? performance.now() : Date.now());

  const SYM = {
    fight: '7772', fighter: '7689', hero: '6532', fightSub: '4847',
    skip: '4528', talk: '3704', gain: '3960',
  };

  const F = { scene: 1, win: 2, lose: 3, harm: 4, chest: 5, blank: 6 };

  const SIDE_MATRIX = ['0.453003,0,0,0.452866,17.05,107.45', '-0.453003,0,0,0.452866,303.4,107.45'];
  const BG_FRAMES = 5;
  const HUD_FRAME = 8;
  const BLOOD_BAR_FRAMES = 101;
  const RANGED = new Set([5, 6, 7, 8, 9, 10, 13, 14]);
  // `Player.specialEffect()` 的四档 → `statu.propty` 的第几帧。
  // 战斗里真正会用到的就是 4/5/6/8，与原版客户端逐条对得上：
  const STATU_ICON = { 1: 5, 2: 6, 3: 4, 4: 8 };

  const STATU_ICON_SYMS = new Set([7640, 7641, 7642, 7645, 7647, 7649, 7653, 7656,

    5940, 5952, 5956]);
  // 每颗图标的正字帧（两帧互为镜像，`showReverse` 就是按左右选一帧）。
  // ⚠ 各颗的约定并不一致，逐帧独立渲染核对（2026-10-17 复核；2026-11 再核）：
  const STATU_ICON_FRAME = { 7640: 1, 7641: 1, 7642: 1, 7645: 1, 7647: 1, 7649: 1, 7653: 1, 7656: 1,
    5940: 1, 5952: 1, 5956: 1 };


  let gearTables = null;
  async function loadGearTables() {
    if (!gearTables) gearTables = await SfUiMain.loadGearTables();
    return gearTables;
  }
  // 一件装备的部位号（0 头 / 1 拳套 / 2 衣服 / 3 鞋）。
  // ⚠ 对手身上那套（`State.genAI()` → `randomAIGears()`）只存 `{id, used, ext, attr}`，
  // 没有 `type` 字段 —— 直接读 `g.type` 会得 `NaN`，`byType` 里就会出现一个 `NaN` 键、
  function gearTypeOf(g) {
    const ty = Number(g && g.type);
    if (Number.isFinite(ty) && ty >= 0 && ty <= 3) return ty;
    try {
      if (window.State && State.gearPart) {
        const t2 = Number(State.gearPart(Number(g && g.id)));
        if (Number.isFinite(t2) && t2 >= 0 && t2 <= 3) return t2;
      }
    } catch (e) {}
    try {
      if (typeof gearMap !== 'undefined' && gearMap.getValue) {
        const d = gearMap.getValue(Number(g && g.id));
        if (d && d.type != null) return Number(d.type);
      }
    } catch (e) {}
    return NaN;
  }

  function planSide(wears) {
    const t = gearTables;
    if (!t) return null;
    const byType = new Map();
    for (const g of wears || []) {
      if (!g) continue;
      const ty = gearTypeOf(g);
      if (!Number.isFinite(ty)) continue;
      if (!byType.has(ty)) byType.set(ty, g);
    }
    if (!byType.size) return null;
    const frameFor = (g) => {
      const base = t.frameById.get(Number(g.id));
      if (!base) return 0;
      const orange = g.orange === true || Number(g.quality) > 3;
      const of = orange && t.orangeFrameById ? t.orangeFrameById.get(Number(g.id)) : 0;

      const raw = g.ext;
      let extMax = Array.isArray(raw)
        ? raw.reduce((m, e) => Math.max(m, Number(e && e.level) || 0), 0)
        : Math.max(0, Number(raw) || 0);
      extMax = Math.max(0, Math.min(3, extMax));

      const gtype = Number.isFinite(Number(g.type)) ? Number(g.type) : gearTypeOf(g);
      const addr = (gtype === 0 || gtype === 1) && extMax > 0 ? extMax - 1 : 0;
      return (of || base) + addr;
    };
    const bySlot = new Map(), holders = new Map();
    for (const h of t.holders || []) {
      const g = byType.get(Number(h.type));
      const fr = g ? frameFor(g) : 0;
      if (fr) holders.set(String(h.id), fr + 1);
    }
    for (const s of t.slots || []) {
      const g = byType.get(Number(s.type));
      const fr = g ? frameFor(g) : 0;
      if (fr) bySlot.set(String(s.id), { symbol: String(s.containerId), frame: fr, quality: Number(g.quality) || 0 });
    }
    if (!bySlot.size && !holders.size) return null;
    return { bySlot: bySlot, holders: holders };
  }

  // 这一侧身上穿的装备（经典战斗穿的是原版装备素材，不是复刻图集那套）。
  // 显式 `gears`（空数组也算）属于参战者自己的外观；左侧未传时才读存档里"穿戴中"的。
  // 右侧读对手自带的 `gears`（好友/关卡数据里的原始字段）。
  function wearsOf(side, player) {
    // 徒弟代打：绝不能退回师父的 `State.myGears()`。
    // 新构建的 fighter 带 `gears`（空数组也算），但旧存档 / 旧调用可能没有 ——
    if (side === 0 && player && player.isPrentice === true && !Array.isArray(player.gears)) return [];
    if (side === 0 && !(player && Array.isArray(player.gears))) {
      try { return (State.myGears() || []).filter((g) => g && g.used); } catch (e) { return []; }
    }
    const list = player && (player.gears || player.wears);
    if (!Array.isArray(list)) return [];
    return list.filter((g) => g && typeof g === 'object' && g.id != null && g.src == null);
  }

  const NPC_FRAME = { tl: 2, xh: 3, xm: 4, wood: 5 };

  function npcTypeOf(foe) {

    if (foe && foe.campaign) return 'campaign';
    const raw = String((foe && foe.npcType) || '').toLowerCase();
    if (!raw) return null;
    if (NPC_FRAME[raw]) return raw;
    try {
      const T = window.TowerData;
      if (T && Array.isArray(T.NPCS)) {
        const hit = T.NPCS.find((n) => 'tw_' + n.id === raw);
        if (hit && NPC_FRAME[hit.anim]) return hit.anim;
      }
    } catch (e) {}
    const tower = {
      tw_berserker: 'xm', tw_assassin: 'tl', tw_medic: 'xh', tw_ironwall: 'xm', tw_bramble: 'xh',
      tw_frostmage: 'xh', tw_tamer: 'tl', tw_vampire: 'tl', tw_golem: 'xm', tw_devourer: 'xm',
    };
    return tower[raw] || null;
  }

  // 这一侧的技能表（id → 等级）。真形态那一档（`attackerWeaponLevel` / `defenderWeaponLevel
  // > 10`）就是从这里读的：原版是服务端在回合流水里带过来的，复刻的 `Sim` 只在
  function skillsOf(side, player) {
    let list = (player && Array.isArray(player.skills)) ? player.skills : null;
    if (!list && side === 0) { try { list = State.mySkills() || []; } catch (e) { list = []; } }
    const out = {};
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s) continue;
      const p = typeof s === 'string' ? s.split(/[:,]/) : null;
      const id = Number(p ? p[0] : s.id);
      const lv = Number(p ? (p[1] || 1) : s.level);
      if (Number.isFinite(id)) out[id] = Number.isFinite(lv) && lv > 0 ? lv : 1;
    }
    return out;
  }


  function weaponsOf(side, player) {
    let list = (player && Array.isArray(player.weapons)) ? player.weapons : null;
    if (!list && side === 0) { try { list = State.myWeapons() || []; } catch (e) { list = []; } }
    const out = {};
    for (const w of (Array.isArray(list) ? list : [])) {
      if (!w) continue;
      const p = typeof w === 'string' ? w.split(/[:,]/) : null;
      const id = Number(p ? p[0] : w.id);
      const lv = Number(p ? (p[1] || 1) : w.level);
      if (Number.isFinite(id)) out[id] = Number.isFinite(lv) && lv > 0 ? lv : 1;
    }
    return out;
  }


  let lootIcons = null;
  function attachLootIcon(target, item) {
    if (!target || !target.attachChild || !item || item.id == null) return null;
    const hit = lootIcons && lootIcons[Number(item.id)];
    if (!hit) return null;
    if (hit.id) return target.attachChild(hit.id, 1, 'prize');
    // 没有 SWF 库元件的联机自建道具（`loot-icons.json` 里只有 `svg`）：走背包同一张矢量图。
    if (hit.svg && target.attachImage) {
      const C = window.UI && UI.classic;
      const href = (C && typeof C.propIconSrc === 'function') ? C.propIconSrc(Number(item.id)) : ('images/ui/icons/prop/' + hit.svg);
      return target.attachImage(href, { pad: 0.08 });
    }
    return null;
  }

  // 幻兽「整蛊专家」封住的武器/技能：把原版库元件里的那张武技卡挂出来。
  // 卡面元件按武器/技能 id 查 `weapon-skill-icons.json`，实际图标在 tags-wsicon。
  let sealIcons = null;
  async function loadSealIcons() {
    if (sealIcons) return sealIcons;
    try {
      await SfRender.loadExtra('tags-wsicon.json');
      sealIcons = (await SfRender.loadTable('weapon-skill-icons.json')) || {};
    } catch (e) {
      if (window.__errs) window.__errs.push('[SfFight] seal icons: ' + (e && e.message));
      return null;
    }
    return sealIcons;
  }
  function sealIconOf(seal) {
    if (!seal || !sealIcons) return null;
    const kind = seal.kind === 'weapon' ? 'weapon' : 'skill';
    const row = sealIcons[kind] && sealIcons[kind][Number(seal.id)];
    return row && row.id ? row : null;
  }
  // 卡面晚到不能把整场战斗卡住；超时就放弃这一张，后台请求继续跑。
  function waitSealIcons(ms, signal) {
    if (sealIcons) return Promise.resolve(sealIcons);
    const wait = [
      loadSealIcons(),
      new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, Number(ms) || 0))),
    ];
    if (signal) wait.push(signal);
    return Promise.race(wait);
  }
  const SEAL_CARD_HALF = 23;
  const SEAL_CARD_SCALE = 0.95;
  const SEAL_CARD_POS = [[70, 85], [250, 85]];
  function showSealCard(rec, seal, side) {
    const row = sealIconOf(seal);
    if (!row || !rec || !rec.view) return null;
    let clip = null;
    try { clip = rec.view.attachChild(row.id, 1, 'seal'); } catch (e) { clip = null; }
    if (!clip || !clip.g || !clip.setExtraTransform) return null;
    // 卡面上的等级/名字是状态页的占位字；战斗里只保留这张“被吸走的武技”图。
    for (const name of ['level', 'sname', 'sname1']) {
      const field = clip.byName && clip.byName(name);
      if (field) visible(field, false);
    }
    clip.g.setAttribute('role', 'img');
    clip.g.setAttribute('aria-label', '吸取了' + (seal.name || '武技'));
    clip.g.style.filter = 'drop-shadow(0 0 3px rgba(196,108,255,.95)) drop-shadow(0 0 9px rgba(255,110,230,.4))';
    const center = SEAL_CARD_POS[side === 1 ? 1 : 0];
    const start = timeNow();
    const draw = (now) => {
      if (!clip || !clip.g || rec.stopped) return;
      const t = Math.min(1, (now - start) / 280);
      const ease = 1 - Math.pow(1 - t, 3);
      const s = SEAL_CARD_SCALE * (0.55 + 0.45 * ease);
      const cy = center[1] + 12 * (1 - ease);
      clip.setExtraTransform('translate(' + (center[0] - SEAL_CARD_HALF * s).toFixed(2) + ',' +
        (cy - SEAL_CARD_HALF * s).toFixed(2) + ') scale(' + s.toFixed(3) + ')');
      clip.g.style.opacity = String(Math.min(1, t * 1.6));
      if (t < 1) rec.rafs.push(raf(draw));
    };
    draw(start);
    return clip;
  }
  function fadeSealCard(rec, clip) {
    if (!clip || !clip.g) return;
    const start = timeNow();
    const draw = (now) => {
      if (!clip || !clip.g) return;
      const t = Math.min(1, (now - start) / 180);
      clip.g.style.opacity = String(1 - t);
      if (t < 1) rec.rafs.push(raf(draw));
      else { try { clip.destroy(); } catch (e) {} }
    };
    rec.rafs.push(raf(draw));
  }

  // 原版「获取道具」3960 的拾取卡：悬浮奖励不再用 DOM 图+边框拼，改成库元件 + 原版图标。
  // 3960 的卡面/提示是固定矢量，动态的只有 `daoju.c1` 里那一枚道具图标。
  const GAIN_VIEWBOX = '134 56 50 63';
  function createDropPresenter(rec) {
    let layer = null, view = null, closed = false;
    function clear() {
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      layer = null;
      if (view) { try { view.destroy(); } catch (e) {} view = null; }
    }
    function show(reward, pick) {
      clear();
      closed = false;
      const host = rec && rec.host;
      if (!host || !window.SfRender) return;
      const wrap = document.createElement('div');
      wrap.className = 'sf-gain-layer';
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sf-gain';
      card.setAttribute('aria-label', '拾取' + reward.name + ' ×' + reward.count);
      const pop = document.createElement('span'); pop.className = 'sf-gain-pop';
      const bob = document.createElement('span'); bob.className = 'sf-gain-bob';
      const glow = document.createElement('span'); glow.className = 'sf-gain-glow';
      const art = document.createElement('span'); art.className = 'sf-gain-art';
      bob.appendChild(glow); bob.appendChild(art);
      pop.appendChild(bob); card.appendChild(pop); wrap.appendChild(card);
      host.appendChild(wrap);
      layer = wrap;
      card.onclick = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (closed) return;
        const fn = pick;
        clear();
        if (fn) fn();
      };
      SfRender.mountSymbol(art, SYM.gain, { viewBox: GAIN_VIEWBOX, policy: {} }).then((v) => {
        if (closed || layer !== wrap) { try { v.destroy(); } catch (e) {} return; }
        view = v;
        const icon = lootIcons && lootIcons[Number(reward.id)];
        const daoju = v.byName && v.byName('daoju');
        const c1 = daoju && daoju.byName && daoju.byName('c1');
        if (c1 && icon && icon.id) {
          try { c1.attachChild(icon.id, 1, 'mc'); c1.gotoAndStop(2); } catch (e) {}
        }
      }).catch((e) => {
        if (window.__errs) window.__errs.push('[SfFight] gain card: ' + (e && e.message));
      });
    }
    return { show, hide: clear, close: () => { closed = true; clear(); } };
  }


  let live = null;
  let seq = 0;

  const stopAt = (clip, n) => SfRender.stopAt(clip, n);
  function play(clip, n) {
    if (!clip || !clip.gotoAndPlay) return;
    allowNestedAnim(clip);
    try { clip.gotoAndPlay(n || 2); } catch (e) {}
  }
  function setText(node, str, opts) {
    const t = T();
    if (t && node) { t.setText(node, str, opts); return; }
    if (node && node.textContent !== undefined) node.textContent = str == null ? '' : String(str);
  }
  // 血条上的两个昵称：按字段框宽度缩字号，保证「7 个汉字」和英文昵称都能完整显示。
  function setNameText(node, text) {
    setText(node, text);
    if (window.SfRender && SfRender.fitTextWidth) SfRender.fitTextWidth(node, { ascii: 0.5, min: 6 });
  }
  function visible(clip, on) {
    const g = clip && (clip.g || clip);
    if (g && g.style) g.style.visibility = on ? '' : 'hidden';
  }

  function arm(fn) {
    const rec = live;
    if (!rec) return;
    const id = raf(() => {
      const i = rec.rafs.indexOf(id);
      if (i >= 0) rec.rafs.splice(i, 1);
      fn();
    });
    rec.rafs.push(id);
  }
  // 播一条动作片断，在帧脚本写的停止帧上停住（`opts.stop` 缺省 = 末帧）。
  // ⚠ 这一条是"动画会播两遍 / 胜利失败动作重复播放"的根因所在。
  // ⚠ 还有一条必须在这里做：放行这条片断内部的"嵌套动画"。
  // 递归放行一棵子树里的嵌套动画；`self` = 连这颗自己一起拨回第 1 帧开始播
  // ⚠ 只有 `self === true` 那一档才会"拨帧开始播"，子树一律只放行不拨帧：
  // 动作片断里显式 stop 在第 1 帧的特效（5785 = 色诱之术那张脸/特效），
  // 只能按原版停在第一帧，不能被“重启动画”顺手放走。
  const EXPLICIT_STOP_IN_ACTION = new Set(['5785']);
  function startNestedAnim(clip, self, inGear, deep, force) {
    if (!clip) return;
    const g = clip.g;
    const tagId = clip.tag && String(clip.tag.id);
    if (tagId && EXPLICIT_STOP_IN_ACTION.has(tagId)) return;
    const gear = !!inGear || clip.__pinFrame != null
      || !!(g && g.getAttribute && g.getAttribute('slot'));
    if (!gear) {
      clip.__keepAnim = true;
      if (self && clip.frames && clip.frames.length > 1 && !clip.__playLock
          && (force || !clip.playing)) {
        try { clip.gotoAndPlay(1); } catch (e) {}
      }
    }

    const nextSelf = deep === true;
    for (const rec of clip.nodes ? clip.nodes.values() : []) {
      if (rec && rec.clip) startNestedAnim(rec.clip, nextSelf, gear, deep, force);
    }
    for (const c of clip.__attached || []) startNestedAnim(c, nextSelf, gear, deep, force);
  }

  function allowNestedAnim(clip) { startNestedAnim(clip, false, false); }
  // 角色动作播完后把嵌套表情/眼睛停在最后一个有内容的帧。
  // 父动作停在受击/胜利的最后一帧，子表情却还在转（Android 的低帧率/节拍会让它更显眼）。
  function freezeNestedAnim(clip, inGear, keepIds) {
    if (!clip) return;
    const g = clip.g;
    const tagId = clip.tag && String(clip.tag.id);
    if (tagId && EXPLICIT_STOP_IN_ACTION.has(tagId)) return;
    if (keepIds && keepIds.has(Number(clip.tag && clip.tag.id))) return;
    const gear = !!inGear || clip.__pinFrame != null
      || !!(g && g.getAttribute && g.getAttribute('slot'));
    const children = [];
    for (const rec of clip.nodes ? clip.nodes.values() : []) if (rec && rec.clip) children.push(rec.clip);
    for (const c of clip.__attached || []) if (c) children.push(c);
    for (const child of children) {
      if (keepIds && keepIds.has(Number(child.tag && child.tag.id))) continue;
      const cg = child.g;
      const childGear = gear || child.__pinFrame != null
        || !!(cg && cg.getAttribute && cg.getAttribute('slot'));
      if (!childGear) {
        const end = lastContentFrame(child);
        if (end > 0) stopAt(child, end);
      }
      freezeNestedAnim(child, childGear, keepIds);
    }
  }
  // 脸部保留原版深度：5615 眼白必须低于头装；6062 思考眼睛由动态蒙版裁剪。
  // 原 SWF/Ruffle 逐帧对照 5843/6127 的睁眼、闭眼与侧脸后，确认不能按固定
  // 蒙版与颜色变换的继承/撤销由显示层处理，不能通过把眼白抬到脸皮上方补偿。

  function lastContentFrame(clip) {
    const frames = clip && clip.frames;
    if (!frames || !frames.length) return 0;
    for (let i = frames.length - 1; i >= 0; i--) {
      const fr = frames[i];
      if (!fr) continue;

      const size = (typeof fr.size === 'number') ? fr.size : (fr.nodes ? fr.nodes.size : 0);
      if (size > 0) return i + 1;
    }
    return frames.length;
  }
  function playClip(clip, opts) {
    const o = opts || {};
    if (!clip || !clip.gotoAndPlay || !clip.frameCount || !live) return Promise.resolve();
    const rec = live, combat = !rec.settling;
    const interrupted = () => live !== rec || rec.stopped || (combat && rec.skipped);
    if (interrupted()) return Promise.resolve();
    // `deep`：这一条是角色动作（攻击 / 受击 / 闪避 / 归位 / 胜利姿势），
    // 片断里的表情、眼睛、身体嵌套层要按原版从第 1 帧重新播；否则它们可能停在上一拍
    if (o.deep) startNestedAnim(clip, true, false, true, true);
    else allowNestedAnim(clip);
    const last = clip.frameCount() - 1;

    const endIdx = Math.max(0, Math.min(last, lastContentFrame(clip) - 1));
    const stopIdx = (o.stop != null) ? Math.max(0, Math.min(last, Number(o.stop) - 1)) : endIdx;
    const fire = (n) => { if (o.onFrame) { try { o.onFrame(n); } catch (e) {} } };

    let seen = o.resume ? clip.frame + 1 : 1;
    if (!o.resume) { play(clip, 2); fire(1); }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        rec.sleepers.delete(finish);
        if (clip.stop) clip.stop();
        resolve();
      };
      const settleAtStop = () => {
        stopAt(clip, stopIdx + 1);
        if (o.keepNestedIds) freezeNestedAnim(clip, false, new Set(o.keepNestedIds.map(Number)));
        else if (o.deep && !o.keepNested) freezeNestedAnim(clip);
        finish();
      };
      rec.sleepers.add(finish);
      const tick = () => {
        if (done) return;
        if (interrupted() || !clip.g || clip.g.isConnected === false) { finish(); return; }
        const n = clip.frame + 1;
        // 渲染节拍是 setInterval 取模推进，playClip 用 rAF 采样；低帧率安卓上
        // rAF 可能整帧跳过 stopIdx，帧号回绕后永远等不到 >= stopIdx（倒地/胜利动作无限重播）。
        if (n < seen) { settleAtStop(); return; }
        if (n !== seen && n > seen) { for (let k = seen + 1; k <= n; k++) fire(k); }
        seen = n;
        if (clip.frame >= stopIdx) { settleAtStop(); return; }
        arm(tick);
      };
      arm(tick);
    });
  }


  // 把一侧的 `7689` 挂到战斗视图上并摆到原版位置。
  // ⚠ 原版链路是 `player1.playerMc.attachMovie("松鼠","playerMc")` —— 也就是
  // （`gotoAndStop(2)`）。`attachChild` 不会写进 `byName` 表，所以主角本体必须由这里回传，
  function buildFighter(view, side, wears, npcType, campaign, mutant) {
    const plan = planSide(wears);
    const holder = view.attachChild(SYM.fighter, 1, 'player' + (side + 1));
    if (!holder) return null;
    holder.setExtraTransform('matrix(' + SIDE_MATRIX[side] + ')');

    if (campaign) {

      stopAt(holder, 6);

      const slot = holder.byName('playerMc');
      if (slot) {
        stopAt(slot, 2);

        if (slot.detachAll) { try { slot.detachAll(); } catch (e) {} }
        const set = slot.attachChild('6833', 1, 'playerMc');
        const frame = Math.max(1, Math.min(7, Number(campaign.mcFrame) || 1));
        if (set) {
          stopAt(set, frame);
          const model = set.byName('playerMc');
          if (model) {
            holder.__hero = model;
            holder.__campaign = campaign;
            live.plans[side] = null;
            holderPlan.set(holder, null);
            return holder;
          }
        }
      }
      // 模型缺失时也停在这条分支：绝不能掉进下面的三侠分支，否则 campaign 会被当成
      return holder;
    }

    if (npcType) {
      const frame = NPC_FRAME[npcType] || 1;
      stopAt(holder, frame);

      const statu = holder.byName('statu');
      if (statu) stopAt(statu, statu.frameCount ? statu.frameCount() : 20);
      const model = holder.byName('playerMc') || null;
      holder.__npc = npcType;
      holder.__mutant = !!mutant;
      holder.__hero = model || null;
      if (model) prepareNpcModel(model);
      if (model) visible(model, true);
      live.plans[side] = null;
      holderPlan.set(holder, null);
      return holder;
    }
    // ⚠ 装备的 plan 必须在建树那一刻就绪：挂点是在 `showFrame()` 里实例化的。
    const prev = building;
    building = plan;
    let hero = null;
    try {
      const slot = holder.byName('playerMc');
      if (slot) {
        stopAt(slot, 1);
        hero = slot.attachChild(SYM.hero, 1, 'playerMc');
        stopAt(slot, 2);
        const statu = holder.byName('statu');
        if (statu) stopAt(statu, statu.frameCount());
        if (hero) heroPlan.set(hero, plan);
      }
    } finally { building = prev; }
    live.plans[side] = plan;
    holderPlan.set(holder, plan);
    holder.__hero = hero || null;
    return holder;
  }
  let building = null;
  const holderPlan = new WeakMap();
  const heroPlan = new WeakMap();

  function fighterOf(clip) {
    for (let c = clip; c; c = c.parent) if (c.__fighter) return c.__fighter;
    return null;
  }

  const TEXT_ART_SYMS = new Set([5864, 6431, 6438]);
  const TEXT_ART_BAKED_MIRROR = new Set();

  function mirrorInPlace(clip, retry) {
    if (!clip || !clip.g || !clip.setExtraTransform) return false;
    if (clip.__mirroredInPlace) return true;
    let b = null;
    try { b = clip.g.getBBox(); } catch (e) { b = null; }
    if (!b || !(b.width > 0)) {
      if (!retry && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { try { mirrorInPlace(clip, true); } catch (e) {} });
      }
      return false;
    }
    const cx = b.x + b.width / 2;
    clip.__mirroredInPlace = true;
    clip.setExtraTransform('translate(' + (2 * cx).toFixed(2) + ',0) scale(-1,1)');
    return true;
  }

  function retryOrientation(clip, apply, tries) {
    const fighter = fighterOf(clip);
    if (fighter) { apply(clip, fighter); return; }
    if ((tries || 0) < 12 && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { try { retryOrientation(clip, apply, (tries || 0) + 1); } catch (e) {} });
    }
  }
  function orientStatu(clip, fighter) {
    if (clip.__oriented) return;
    clip.__oriented = true;
    stopAt(clip, STATU_ICON_FRAME[Number(clip.tag.id)] || 1);
    if (Number(fighter.side) !== 0 && clip.setExtraTransform) clip.setExtraTransform('scale(-1,1)');
  }
  function orientTextArt(clip, fighter) {

    stopAt(clip, 1);
    const parentMirrored = Number(fighter.side) !== 0;
    const bakedMirrored = TEXT_ART_BAKED_MIRROR.has(Number(clip.tag.id));
    if (bakedMirrored !== parentMirrored) mirrorInPlace(clip);
  }

  function showLuckyResult(clip, fighter) {
    if (!clip || !fighter || fighter.luckyCount == null) return;
    stopAt(clip, Number(fighter.side) === 0 ? 1 : 2);
    const num = clip.byName && clip.byName('num');
    if (num) stopAt(num, Math.max(1, Math.min(6, Math.round(Number(fighter.luckyCount) || 1))));
  }

  function onClip(clip) {

    const fighter = fighterOf(clip);
    if (Number(clip.tag.id) === 6362) {

      playClip(clip, { resume: true, stop: 9, keepNested: true });
      return;
    }
    if (Number(clip.tag.id) === 6091) {
      if (fighter) showLuckyResult(clip, fighter);
      else retryOrientation(clip, showLuckyResult);
      return;
    }
    const art = fighter && fighter.weaponNow;
    if (art) {
      const cont = WEAPON_ART_CONTAINERS[Number(clip.tag.id)];
      if (cont) {
        const fr = cont.frames[art.id];
        if (fr) { stopAt(clip, fr); return; }
      } else if (WEAPON_ART_SYMS.has(Number(clip.tag.id))) {
        paintWeaponArtClip(clip, fighter);
        refreshWeaponArt(clip, fighter);
        return;
      }
    }
    // 状态图标的正字 / 朝向：图标容器（7640…7656）自己的第 1 帧脚本是
    // ⚠ 但敌方那一侧整个 `7689` 本身就是镜像的（原版就这么摆：面朝左），挂在它里面的
    // 位置不动、箭头也照旧朝下），而不是去挑那颗"预先镜像好"的帧 —— 后者各颗约定不一致
    if (STATU_ICON_SYMS.has(Number(clip.tag.id))) {
      if (fighter) orientStatu(clip, fighter);
      else retryOrientation(clip, orientStatu);
      return;
    }

    if (TEXT_ART_SYMS.has(Number(clip.tag.id))) {
      if (fighter) orientTextArt(clip, fighter);
      else retryOrientation(clip, orientTextArt);
      return;
    }
    let plan = null;
    for (let c = clip; c && !plan; c = c.parent) plan = holderPlan.get(c) || heroPlan.get(c) || plan;
    if (!plan) plan = building;
    if (!plan) return;
    if (clip.parent) holderPlan.set(clip, plan);
    const hf = plan.holders.get(String(clip.tag.id));
    if (hf != null) { try { clip.pinFrame(hf); } catch (e) {} return; }
    const p = plan.bySlot.get(String(clip.tag.id));
    if (p && clip.setSymbol) {
      if (clip.g && clip.g.setAttribute) clip.g.setAttribute('slot', String(clip.tag.id));
      clip.setSymbol(p.symbol, p.frame, 1, 'topleft');
      clip.__gearSlot = true;
      // ⚠ 身体装备（`gearBody` / `gearArm`，type 2）不能在战斗层再 `mirrorInPlace` 一次。
      if (fighter && live && live.strip && live.strip[Number(fighter.side)]) setGearClipHidden(clip, true);
    }
  }

  // 回合 → 动作帧：`Squirrel.as` 的选择逻辑
  // 原版 `currentRound` 由服务端给，字段是 `attackType` / `weaponSkillId` / `defenseType` /
  // ⚠ 四档 attackType 对应的是四组完全不同的动画（`Squirrel.as:8-149`）：

  const SKILL_ATTACK_FRAME = {
    8: [4, 15], 12: [5, 16], 13: [6, 6], 14: [7, 17],
    15: [8, 18], 17: [9, 19], 18: [10, 20], 23: [12, 21],
  };
  function isTrueForm(r) {
    return r.trueForm === true || r.isTrue === true || Number(r.level) > 10;
  }

  const PET_ATTACK_ACTS = {
    1: { sym: 6203, hit: 22 }, 2: { sym: 6207, hit: 19 }, 3: { sym: 6210, hit: 18 }, 4: { sym: 6216, hit: 16 },
    5: { sym: 6223, hit: 18 }, 6: { sym: 6224, hit: 27 }, 7: { sym: 6225, hit: 23 }, 8: { sym: 6233, hit: 25 },
    9: { sym: 6236, hit: 22 }, 10: { sym: 6241, hit: 19 }, 11: { sym: 6256, hit: 23 }, 12: { sym: 6261, hit: 21 },
    13: { sym: 6262, hit: 19 }, 14: { sym: 6265, hit: 16 }, 15: { sym: 6284, hit: 15 }, 16: { sym: 6291, hit: 22 },
    17: { sym: 6296, hit: 30 }, 18: { sym: 6299, hit: 30 }, 19: { sym: 6302, hit: 17 }, 20: { sym: 6305, hit: 22 },
    21: { sym: 6312, hit: 22 }, 22: { sym: 6317, hit: 17 }, 23: { sym: 6318, hit: 22 }, 24: { sym: 6324, hit: 21 },
    25: { sym: 6325, hit: 16 }, 26: { sym: 6326, hit: 22 }, 27: { sym: 6327, hit: 22 }, 28: { sym: 6328, hit: 22 },
    29: { sym: 6330, hit: 22 }, 30: { sym: 6331, hit: 17 }, 31: { sym: 6332, hit: 22 }, 32: { sym: 6338, hit: 22 },
  };

  const PET_DEFENSE_FRAME = {
    1: 11, 2: 12, 3: 13, 4: -1, 5: -1, 6: 16, 7: 17, 8: -1, 9: 18, 10: -1, 11: -1,
    12: 19, 13: 23, 14: 24, 15: 25, 16: -1, 17: -1, 18: 26, 19: 29, 20: 30,
    21: -1, 22: 32, 23: -1, 24: -1, 25: 35, 26: -1, 27: -1, 28: -1, 29: 39, 30: 40, 31: -1, 32: -1,
  };
  // 原版出手动画里真的握着这一拍用的那把武器，靠的还是"帧脚本"：
  // ⚠ 复刻以前一条都没接，于是近战一律停在容器第 1 帧 = 方天画戟、投掷一律第 1 帧 = 死老鼠：
  const MELEE_WEAPON_ART = { sym: 5734, frames: { 1: 1, 2: 2, 3: 3, 4: 4, 11: 5, 12: 6, 15: 7, 16: 8, 17: 9 } };
  const THROW_WEAPON_ART = { sym: 5776, frames: { 5: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6, 13: 7, 14: 8 } };

  const WEAPON_ART_CONTAINERS = { 5734: MELEE_WEAPON_ART, 5776: THROW_WEAPON_ART };

  const WEAPON_SIZE_FRAMES = { 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 13: 7, 14: 9, 15: 8 };

  function weaponTrueGlow(level) {
    return (window.GData && GData.trueWeaponGlow) ? GData.trueWeaponGlow(level) : '';
  }
  const WEAPON_ART_SYMS = new Set([5666, 5670, 5674, 5679, 5686, 5697, 5706, 5724, 5733,
    5753, 5757, 5760, 5763, 5766, 5769, 5772, 5775]);

  function weaponArtLevel(fighter, art) {
    const id = Number(art && art.id);
    const owned = fighter && typeof fighter.weaponLevel === 'function' ? fighter.weaponLevel(id) : 0;
    const lv = owned || Number(art && art.level) || 1;
    return Math.max(1, Math.min(15, Math.round(lv)));
  }

  function eachClipTree(root, fn) {
    if (!root || typeof fn !== 'function') return;
    fn(root);
    if (root.nodes) for (const rec of root.nodes.values()) if (rec && rec.clip) eachClipTree(rec.clip, fn);
    for (const c of root.__attached || []) eachClipTree(c, fn);
  }
  // 给武器美术拨型号帧 / 真化外发光，并处理它身上那两层闪电（5649 / 5660）。
  // ⚠ 5649 / 5660 是 5 帧的辉光/闪电叠层，原版靠父级放置的 `cx` 染成
  function paintWeaponArtClip(clip, fighter) {
    if (!clip || !clip.tag) return;
    const sid = Number(clip.tag.id);
    const art = fighter && fighter.weaponNow;
    if (!art) return;
    const lv = weaponArtLevel(fighter, art);
    if (WEAPON_ART_SYMS.has(sid)) {
      stopAt(clip, WEAPON_SIZE_FRAMES[lv] || 1);
      const glow = weaponTrueGlow(lv);
      if (clip.g && clip.g.style) clip.g.style.filter = glow ? 'drop-shadow(0 0 5px ' + glow + ')' : '';
      return;
    }
    if (sid === 5649 || sid === 5660) {
      const trueN = (window.GData && GData.trueLevel)
        ? GData.trueLevel(lv) : (lv > 10 ? Math.min(5, lv - 10) : 0);
      if (trueN <= 0) { clip.playing = false; visible(clip, false); }
      else { visible(clip, true); stopAt(clip, 1); }
    }
  }

  function refreshWeaponArt(root, fighter) {
    if (!root || !fighter || !fighter.weaponNow) return;
    eachClipTree(root, (clip) => paintWeaponArtClip(clip, fighter));
  }
  function attackPlan(r) {

    if (r.action === 'pet') {
      const id = Math.max(1, Math.min(32, Number(r.petId) || 0));
      return { frame: 29 + id, petId: id };
    }
    if (r.action === 'weapon') return { frame: RANGED.has(Number(r.id)) ? 3 : 2 };
    if (r.action === 'skill') {
      const pair = SKILL_ATTACK_FRAME[Number(r.id)];
      if (!pair) return { frame: 1 };
      return { frame: isTrueForm(r) ? pair[1] : pair[0] };
    }

    if (r.action === 'rest' || r.action === 'stunned') return { frame: 11 };
    return { frame: 1 };
  }
  // 防御技能（`useSkillDefense` / `Player.specialEffect` 的 `defenseSkillId`）。
  // ⚠ 龟甲术（7）与绝对防御（16）各有一档真形态：`Squirrel.useSkillDefense` 里按
  const DEFENSE_SKILL_FRAME = { 6: 1, 7: 2, 16: 3 };
  const DEFENSE_SKILL_TRUE_FRAME = { 7: 4, 16: 5 };

  function defenseSkillFrame(id, lvl) {
    const k = Number(id);
    if (Number(lvl) > 10 && DEFENSE_SKILL_TRUE_FRAME[k]) return DEFENSE_SKILL_TRUE_FRAME[k];
    return DEFENSE_SKILL_FRAME[k];
  }
  // 这一回合要给受击方飘哪一颗状态图标 —— 返回 `Player.specialEffect()` 的 statu 档位。
  // ⚠ 2026-11 用户口径："给敌人施加 debuff 的时候飘的 debuff ui 是错误的 ui"。原因就是这里
  function effectStatu(r) {
    if (r.stunApplied || r.freezeApplied) return 4;
    const stat = r.debuffStat || (/力量/.test(r.debuffText || '') ? 'power'
      : /敏捷/.test(r.debuffText || '') ? 'agility'
        : /速度/.test(r.debuffText || '') ? 'speed' : '');
    if (stat === 'power') return 3;
    if (stat === 'agility') return 1;
    if (stat === 'speed') return 2;
    return 0;
  }

  const SKILL_DEFENSE_FRAME = { 8: [7, 9], 12: [2, 2], 15: [6, 6], 18: [8, 3], 23: [1, 1] };
  // 这一拍受击方该播哪一段。`side` = 正在演出的这一侧（0/1）：
  // ⚠ `r.fakeDie` 说的是"有人装了死"，装死的是 `r.fakeDieSide`（普通受击 = 挨打那位；
  function defensePlan(r, hasEquip, lvl, side) {

    const fakeSide = r.fakeDieSide == null ? r.attacker : Number(r.fakeDieSide);
    if (r.fakeDie && (side == null || Number(side) === Number(fakeSide))) {
      return { kind: 'skill', frame: defenseSkillFrame(6, lvl) };
    }

    if (r.action === 'pet') {
      const pf = PET_DEFENSE_FRAME[Number(r.petId)];
      return pf > 0 ? { kind: 'hit', frame: pf, pet: true } : { kind: 'none', pet: true };
    }
    if (r.dodge) return { kind: 'dodge' };
    if (r.guiJia) return { kind: 'skill', frame: defenseSkillFrame(7, lvl) };
    if (r.jueDui) return { kind: 'skill', frame: defenseSkillFrame(16, lvl) };
    if (r.action === 'skill') {
      const pair = SKILL_DEFENSE_FRAME[Number(r.id)];
      if (pair) {

        const special = Number(r.specialEffect) === 1;
        const frame = (special && (Number(r.id) !== 8 || hasEquip !== false)) ? pair[1] : pair[0];
        return { kind: 'hit', frame: frame, replay: Number(r.id) === 23 };
      }
    }
    return { kind: 'hit' };
  }

  // 原版没有"时间轴控制器"：整套战斗演出是动画片断自己的帧动作在关键帧上回调 `_root`
  // `defenseType == 2` 才有动作）。注意它在 `beAttack` 之前好几帧：原版是先在
  // `attacks`(6339) 选择帧 → 该动画元件在第几帧干什么。
  // ⚠ `guard`（原版帧脚本里提前调 `_root.useSkillDefense()` 的那一帧）现在只留作取证：
  const ATTACK_ACTS = {
    1: { sym: 5630, guard: 3, hit: 9 },
    2: { sym: 5748, guard: 3, hit: 9 },
    3: { sym: 5778, guard: 8, hit: 14 },
    4: { sym: 5843, guard: 8, hit: 14 },
    5: { sym: 5855, guard: 3, hit: 9 },
    6: { sym: 5922, heal: 37 },
    7: { sym: 5957 },
    8: { sym: 5991, guard: 16, hit: 22 },
    9: { sym: 6026, heal: 37 },
    10: { sym: 6057, guard: 12, hit: 18 },
    11: { sym: 6067 },
    12: { sym: 6122, guard: 25, hit: 31 },
    15: { sym: 6127, guard: 8, hit: 14 },
    16: { sym: 6129, guard: 3, hit: 9 },
    17: { sym: 6134 },
    18: { sym: 6145, guard: 16, hit: 22 },
    19: { sym: 6169, heal: 37 },
    20: { sym: 6175, guard: 12, hit: 18 },
    21: { sym: 6185, guard: 25, hit: 31 },
  };
  // 幻兽帧 30..61 并进同一张表：`attack()` 只读 `hit` / `heal` 两个钩子，
  // 这样不用在回放主路径里再分一次「这一拍是不是幻兽」。
  for (const [id, acts] of Object.entries(PET_ATTACK_ACTS)) ATTACK_ACTS[29 + Number(id)] = acts;

  const DEFENSE_ACTS = {
    1: { sym: 6347, back: 10 },
    2: { sym: 6350 },
    3: { sym: 6354 },
    4: { sym: 6366 },
    5: { sym: 6366 },
    6: { sym: 6379 },
    7: { sym: 6393 },
    8: { sym: 6395 },
    9: { sym: 6415 },
    // 幻兽协战的受击帧（`squirrelAttackConfig` attackType 4 段；11..40）。
    // `onlyChildClip()` 兜底，不能因为 `byName('defense')` 为空就整段跳过。
    11: { sym: 6416 }, 12: { sym: 6418 }, 13: { sym: 6347 }, 16: { sym: 6421 },
    17: { sym: 6421 }, 18: { sym: 6347 }, 19: { sym: 6424 }, 22: { sym: 6421 },
    23: { sym: 6421 }, 24: { sym: 6421 }, 25: { sym: 6347 }, 26: { sym: 6347 },
    28: { sym: 6421 }, 29: { sym: 6347 }, 30: { sym: 6421 }, 32: { sym: 6425 },
    35: { sym: 6425 }, 39: { sym: 6421 }, 40: { sym: 6421 },
  };

  const DEFENSE_SKILL_ACTS = {
    1: { sym: 6440, back: 36 },
    2: { sym: 6464, back: 31 },
    3: { sym: 6497, back: 31 },
    4: { sym: 6504, back: 31 },
    5: { sym: 6511, back: 31 },
    6: { sym: 6511, back: 31 },
  };
  const DODGE_ACTS = { sym: 6432, back: 10 };

  const ATTACKBACK_ACTS = { sym: 6516, hit: 5 };

  const COMEBACK_ACTS = { 1: { sym: 6521 }, 2: { sym: 6522 }, 3: { sym: 6523 } };
  const HUD_STOP = 8;

  const ROUND_GAP = 170;

  const backHook = (acts, hooks, key) => {
    const at = acts && acts.back;
    if (!at || !hooks || !hooks[key || 'back']) return undefined;
    return (n) => { if (n >= at) hooks[key || 'back'](); };
  };



  const NPC_NS = 'http://www.w3.org/2000/svg';
  function prepareNpcModel(model) {
    if (!model || !model.g || model.__npcBob) return model;
    const bob = document.createElementNS(NPC_NS, 'g');
    bob.setAttribute('class', 'sf-npc-bob');
    for (const n of Array.from(model.g.childNodes)) {
      if (n.nodeType === 1 && String(n.tagName).toLowerCase() === 'defs') continue;
      bob.appendChild(n);
    }
    model.g.appendChild(bob);
    model.__npcBob = bob;
    return model;
  }
  function npcPose(api, o) {
    const mc = api && api.mc;
    if (!mc || !mc.setExtraTransform || !mc.g) return;
    const opt = o || {};
    if (!api.__npcBox) {
      try { const b = mc.g.getBBox(); if (b && b.width) api.__npcBox = { x: b.x, y: b.y, w: b.width, h: b.height }; }
      catch (e) { api.__npcBox = null; }
    }
    const b = api.__npcBox;
    const cx = b ? b.x + b.w / 2 : 0, cy = b ? b.y + b.h / 2 : 0;
    const parts = [];
    if (opt.dx || opt.dy) parts.push('translate(' + (Number(opt.dx) || 0).toFixed(2) + ',' + (Number(opt.dy) || 0).toFixed(2) + ')');
    if (cx || cy) parts.push('translate(' + cx.toFixed(2) + ',' + cy.toFixed(2) + ')');
    if (opt.scale && opt.scale !== 1) parts.push('scale(' + Number(opt.scale).toFixed(3) + ')');
    if (opt.rotate) parts.push('rotate(' + Number(opt.rotate).toFixed(2) + ')');
    if (cx || cy) parts.push('translate(' + (-cx).toFixed(2) + ',' + (-cy).toFixed(2) + ')');
    mc.setExtraTransform(parts.join(' '));
    if (opt.opacity != null) mc.g.style.opacity = String(opt.opacity);
  }
  function npcPause(api) {
    if (!api) return;
    if (api.mc && api.mc.__npcBob) api.mc.__npcBob.style.animation = 'none';
    npcPose(api, {});
  }
  function npcResume(api) {
    if (!api) return;
    if (api.mc && api.mc.__npcBob) api.mc.__npcBob.style.animation = '';
    npcPose(api, {});
    if (api.mc && api.mc.g) api.mc.g.style.opacity = '';
  }

  const NPC_SHEETS = { tl: ['tl'], xh: ['xh1', 'xh2'], xm: ['xm1', 'xm2'], wood: ['woodman1', 'woodman2'] };
  const NPC_EFFECT_SHEETS = { tl: ['tl_effect'], xh: ['xh_effect1', 'xh_effect2'], xm: ['xm_effect'], wood: ['woodman_effect'] };
  const NPC_ACTION = {
    idle: 'rest', common: 'common_attack', skill: 'skill_attack', hit: 'hitMe',
    dodge: 'runAround', back: 'runBack', die: 'die', win: 'win', counter: 'beatBack',
  };

  const NPC_HIT_FRAME = {
    tl_common_attack: 6, tl_skill_attack: 10,
    xh_common_attack: 6, xh_skill_attack: 10,
    xm_common_attack: 6, xm_skill_attack: 8,
  };
  const NPC_FRAME_MS = 1000 / 20;
  // 图集按现代 1170×690 舞台的脚线画；经典 7689 矢量身体的脚线更低。
  // 数值是待机帧脚底与原版矢量模型的差（1170×690 坐标，正数 = 下移）。
  const NPC_ATLAS_DY = { tl: 4, xh: 31, xm: 19 };

  function npcAnimName(npc, action) {
    if (npc === 'wood') return action === 'hit' ? 'wood_hitMe' : 'wood_rest';
    return npc + '_' + (NPC_ACTION[action] || action);
  }
  function npcEffectName(npc, key) {
    if (!npc || npc === 'wood') return null;
    return npc + '_effect_' + key;
  }
  // 图集动画这一帧该画哪一张。
  // 三侠的待机/攻击/受击都走这条路径，玩家看到的就是“回合开始（或新动作起手）
  function atlasPaintFrame(anim) {
    const frames = anim && anim.frames;
    if (!frames || !frames.length) return null;
    const idx = Number(anim.idx);
    return frames[idx > 0 ? Math.min(idx, frames.length - 1) : 0] || null;
  }
  function npcAtlasReady(npc) {
    if (!npc || npc === 'wood' || !window.Engine || !Engine.hasAnim || !Engine.has) return false;
    const sheets = NPC_SHEETS[npc];
    if (!sheets || !sheets.length) return false;
    if (!sheets.some((id) => Engine.has(id))) return false;
    return Engine.hasAnim(npcAnimName(npc, 'idle')) && Engine.hasAnim(npcAnimName(npc, 'common'));
  }

  // 把一层 HTML/SVG 覆盖物铺到经典舞台 SVG 的显示区域上（两者都在 `#ui` 的设计坐标里）。
  // 这样完全不需要把屏幕矩形除回来，也不会被 iOS 15 的 `getScreenCTM` 209220 或
  function layoutStageOverlay(el, root, host) {
    if (!el || !root || !host) return null;
    const svg = root.ownerSVGElement || root;
    const vb = svg && svg.viewBox && svg.viewBox.baseVal;
    if (!svg || !vb || !(vb.width > 0) || !(vb.height > 0) || !svg.getBoundingClientRect) return null;
    const hr = host.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    if (!(hr.width > 0) || !(hr.height > 0) || !(sr.width > 0) || !(sr.height > 0)) return null;
    // 屏幕 → 设计单位：x、y 分别用宿主自己的布局尺寸折算。`host` 是普通 div，
    // clientWidth/Height 在 WKWebView 上可靠；不能再用一个 k 同时除两轴
    if (!(host.clientWidth > 0) || !(host.clientHeight > 0)) return null;
    const kx = host.clientWidth / hr.width;
    const ky = host.clientHeight / hr.height;
    const dw = sr.width * kx;
    const dh = sr.height * ky;
    const par = String(svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
    const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
    let offX = 0, offY = 0, contentW, contentH;
    if (/\bnone\b/.test(par)) {
      contentW = dw; contentH = dh;
    } else {
      const s = /\bslice\b/.test(par) ? Math.max(dw / vb.width, dh / vb.height)
        : Math.min(dw / vb.width, dh / vb.height);
      contentW = vb.width * s; contentH = vb.height * s;
      offX = (dw - contentW) * ax;
      offY = (dh - contentH) * ay;
    }
    const left = (sr.left - hr.left) * kx + offX;
    const top = (sr.top - hr.top) * ky + offY;
    const width = contentW, height = contentH;
    const sig = [left, top, width, height].map((n) => Math.round(n * 100) / 100).join('|');
    if (el.__sfStageSig !== sig) {
      el.__sfStageSig = sig;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.width = width + 'px';
      el.style.height = height + 'px';
    }
    return { left: left, top: top, width: width, height: height };
  }

  // 战斗最上层的一层空 SVG：目前只放「跳过」按钮。
  // 三侠的现代图集画布是 HTML canvas（见 `makeAtlasNpcFighter`），按 DOM 顺序会盖住
  function makeBattleTopLayer(rec, root) {
    if (!rec || !rec.host || !root || !window.document || !document.createElementNS) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const main = root.ownerSVGElement || root;
    const top = document.createElementNS(NS, 'svg');
    top.setAttribute('viewBox', (main && main.getAttribute && main.getAttribute('viewBox')) || '0 0 320 196');
    top.setAttribute('preserveAspectRatio', (main && main.getAttribute && main.getAttribute('preserveAspectRatio')) || 'xMidYMid meet');
    top.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'z-index:3;overflow:visible;';
    rec.host.appendChild(top);
    const relayout = () => layoutStageOverlay(top, root, rec.host);
    relayout();
    if (window.addEventListener) window.addEventListener('resize', relayout);
    let ro = null;
    if (window.ResizeObserver) {
      try { ro = new ResizeObserver(relayout); ro.observe(main); ro.observe(rec.host); } catch (e) { ro = null; }
    }
    rec.topLayer = top;
    rec.topLayerRelayout = relayout;
    rec.topLayerRO = ro;
    return top;
  }


  function makeBattleBackLayer(rec, root) {
    if (!rec || !rec.host || !root || !window.document || !document.createElementNS) return null;
    if (rec.bgLayer) return rec.bgLayer;
    const view = rec.view;
    const bg = view && view.byName ? view.byName('backGround') : null;
    const node = bg && (bg.g || bg);
    const main = root.ownerSVGElement || root;
    if (!node || !main) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const layer = document.createElementNS(NS, 'svg');
    layer.setAttribute('class', 'sf-battle-bg-layer');
    layer.setAttribute('viewBox', (main && main.getAttribute && main.getAttribute('viewBox')) || '0 0 320 196');
    layer.setAttribute('preserveAspectRatio', (main && main.getAttribute && main.getAttribute('preserveAspectRatio')) || 'xMidYMid meet');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'z-index:0;overflow:visible;';
    if (main.parentNode) main.parentNode.insertBefore(layer, main);
    else rec.host.appendChild(layer);
    // 主 SVG 必须压回 canvas 上面；只把底图挪走，角色、状态图标、飘字和特效都留在主 SVG。
    main.style.position = 'relative';
    main.style.zIndex = '2';
    layer.appendChild(node);
    const relayout = () => layoutStageOverlay(layer, root, rec.host);
    relayout();
    if (window.addEventListener) window.addEventListener('resize', relayout);
    let ro = null;
    if (window.ResizeObserver) {
      try { ro = new ResizeObserver(relayout); ro.observe(main); ro.observe(rec.host); } catch (e) { ro = null; }
    }
    rec.bgLayer = layer;
    rec.bgLayerRelayout = relayout;
    rec.bgLayerRO = ro;
    return layer;
  }


  function makeStatuApi(statu) {
    const s = statu || null;
    const c = {
      statu: s,
      statuCode: 0,
      setStatu(code) { c.statuCode = Number(code) || 0; },

      specialEffect() {
        const icon = STATU_ICON[c.statuCode];
        c.statuCode = 0;
        if (!icon || !c.statu) return;
        stopAt(c.statu, 1);
        const prop = c.statu.byName('propty');
        if (prop) stopAt(prop, icon);
        playClip(c.statu, { stop: c.statu.frameCount ? c.statu.frameCount() : 20 });
      },
    };
    return c;
  }

  // 现代图集版：透明 canvas 铺在底图与主 SVG 之间，按现代 1170×690 坐标画三侠。
  // ⚠ 不要把 canvas 放进 `<foreignObject>`。WebKit / iOS 有一条 17 年未修的
  // 普通 HTML canvas 的 CSS 缩放 iOS 支持得很好，也不会触发那条 foreignObject bug。
  function makeAtlasNpcFighter(side, holder, info, npcType, mutant) {
    const battle = live;
    const view = live && live.view;
    const root = view && (view.g || view);
    const host = live && live.host;
    if (!root || !host || !window.document || !document.createElement) return null;

    makeBattleBackLayer(battle, root);
    // CONTRACT: 层序 = 底图(0) < 图集 canvas(1) < 主 SVG(2，飘字/状态/特效) < 顶部覆盖(3)。
    // canvas 必须压在主 SVG 之下，否则伤害数字会被 NPC 挡住；它又在拆出来的底图之上。
    const canvas = document.createElement('canvas');
    canvas.className = 'sf-npc-atlas-layer';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = 1170; canvas.height = 690;
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;display:block;' +
      'pointer-events:none;z-index:1;';
    host.appendChild(canvas);
    if (holder) holder.__npcLayer = canvas;
    const ctx = canvas.getContext('2d');
    const staticBody = holder.__hero;
    const restoreStatic = () => {
      if (staticBody && staticBody.g) staticBody.g.style.visibility = '';
      else if (holder && holder.g) holder.g.style.visibility = '';
    };
    // 只收掉原版 7689 的静态身体：`holder` 里的 `statu`（状态图标）等 SVG 必须留着，
    // 否则它们会跟着整棵 holder 一起被隐藏，NPC 头顶的眩晕/减益图标就永远不出现。
    if (holder) {
      if (staticBody && staticBody.g) staticBody.g.style.visibility = 'hidden';
      else if (holder.g) holder.g.style.visibility = 'hidden';
    }
    let isDead = false;
    let anim = null;
    let rafId = 0;
    let disposed = false;
    let verifyTimer = 0;
    let layoutDirty = true, layoutReady = false, layoutRetryAt = 0, nextLayoutCheck = 0;
    let paintDirty = true, paintedFrame = null;
    let resizeObserver = null, layoutObserver = null;
    const effects = [];

    // CONTRACT: 图集层没挂上 / 画布是空的就恢复静态 7689，否则整只 NPC 不可见。
    const canvasPainted = () => {
      try {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < d.length; i += 64) if (d[i]) return true;
      } catch (e) {}
      return false;
    };
    verifyTimer = setTimeout(() => {
      if (disposed || live !== battle) return;
      const attached = canvas.isConnected != null ? canvas.isConnected
        : !!(canvas.parentNode && document.documentElement.contains(canvas));
      if (!attached || canvas.width < 8 || canvas.height < 8 || !canvasPainted()) {
        restoreStatic();
        try { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (e) {}
        if (holder) holder.__npcLayer = null;
      }
    }, 1500);

    const bodySheets = mutant && Engine.mutantSheets ? (Engine.mutantSheets(npcType) || NPC_SHEETS[npcType]) : NPC_SHEETS[npcType];
    const atlasDy = NPC_ATLAS_DY[npcType] || 0;
    const now = () => (window.performance && performance.now ? performance.now() : Date.now());

    function layoutCanvas(stamp) {
      const rec = battle;
      if (disposed || live !== rec || !rec || !rec.host || !canvas.parentNode) return false;
      // 舞台没有逐 rAF 移动；尺寸/布局变化时再量。旧 WebView 无 ResizeObserver 时
      // 每 250ms 兜底一次，隐藏后初次布局失败也会重试，不能把零尺寸永久缓存。
      if (!layoutDirty && (resizeObserver || stamp < nextLayoutCheck)) return layoutReady;
      if (stamp < layoutRetryAt) return layoutReady;
      const box = layoutStageOverlay(canvas, root, rec.host);
      if (!box) {
        layoutReady = false;
        layoutRetryAt = stamp + 100;
        return false;
      }
      layoutDirty = false; layoutReady = true; layoutRetryAt = 0;
      nextLayoutCheck = stamp + 250;
      const bw = Math.max(1, Math.round(box.width)), bh = Math.max(1, Math.round(box.height));
      if (canvas.width !== bw) { canvas.width = bw; paintDirty = true; }
      if (canvas.height !== bh) { canvas.height = bh; paintDirty = true; }
      return true;
    }
    function invalidateLayout() {
      layoutDirty = true; layoutRetryAt = 0;
      schedule();
    }
    function schedule() {
      const rec = battle;
      if (disposed || live !== rec || !rec || rafId) return;
      const id = raf((stamp) => {
        const at = rec.rafs.indexOf(id);
        if (at >= 0) rec.rafs.splice(at, 1);
        if (rafId === id) rafId = 0;
        tick(stamp);
      });
      rafId = id;
      rec.rafs.push(id);
    }
    function stopRaf() { if (rafId) { caf(rafId); if (live) { const i = live.rafs.indexOf(rafId); if (i >= 0) live.rafs.splice(i, 1); } rafId = 0; } }
    function clear() {
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch (e) {}
    }
    function draw(stamp) {
      const t = stamp == null ? now() : stamp;
      if (!layoutCanvas(t)) return;
      const frame = atlasPaintFrame(anim);
      if (frame !== paintedFrame) paintDirty = true;
      // 保留 rAF 节拍和命中回调，只省掉相同 20fps 素材帧的清屏/重画。
      // 特效有独立的帧和寿命；即使角色帧不变，特效切帧/结束也必须刷新。
      for (let i = effects.length - 1; i >= 0; i--) {
        const eff = effects[i];
        const idx = Math.floor((t - eff.start) * Math.max(1, battle.speed || 1) / NPC_FRAME_MS);
        if (idx >= eff.frames.length) { effects.splice(i, 1); paintDirty = true; }
        else if (idx !== eff.idx) { eff.idx = idx; paintDirty = true; }
      }
      if (!paintDirty) return;
      clear();

      ctx.setTransform(canvas.width / 1170, 0, 0, canvas.height / 690, 0, 0);
      if (frame) { try { Engine.drawFrame(ctx, frame, { sheets: bodySheets, y: atlasDy }); } catch (e) {} }
      for (let i = effects.length - 1; i >= 0; i--) {
        const eff = effects[i];
        try { Engine.drawFrame(ctx, eff.frames[eff.idx], { sheets: eff.sheets, y: atlasDy }); } catch (e) {}
      }
      paintedFrame = frame; paintDirty = false;
    }
    function finishAnim() {
      const a = anim;
      anim = null;
      if (a && a.finish) a.finish();
    }
    function tick(stamp) {
      if (disposed || live !== battle || !live || live.stopped) { finishAnim(); return; }
      const a = anim;
      if (a && a.combat && battle.skipped) { finishAnim(); return; }
      if (!a) { draw(stamp); if (effects.length || !layoutReady) schedule(); return; }
      const at = (stamp - a.start) * Math.max(1, live.speed || 1);
      const raw = Math.floor(at / NPC_FRAME_MS);
      let idx = Math.min(a.frames.length - 1, Math.max(0, raw));
      if (a.loop) idx = ((raw % a.frames.length) + a.frames.length) % a.frames.length;
      if (idx !== a.idx) {
        a.idx = idx;
        if (a.onFrame) { try { a.onFrame(idx + 1); } catch (e) {} }
      }
      draw(stamp);
      if (!a.loop && raw >= a.frames.length) { finishAnim(); return; }
      schedule();
    }
    function play(name, opts) {
      const o = opts || {};
      if (disposed || live !== battle || !live || live.stopped) return Promise.resolve();
      const combat = !battle.settling;
      if (combat && battle.skipped) return Promise.resolve();
      const frames = window.Engine && Engine.anim ? Engine.anim(name) : null;
      if (!frames || !frames.length) return Promise.resolve();
      if (rafId) stopRaf();
      if (anim && anim.finish) anim.finish();
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          battle.sleepers.delete(finish);
          if (anim && anim.finish === finish) { anim = null; stopRaf(); }
          resolve();
        };
        battle.sleepers.add(finish);
        anim = { name: name, frames: frames, start: now(), idx: -1, loop: !!o.loop, onFrame: o.onFrame, finish: finish, combat: combat };
        draw();
        schedule();
      });
    }
    function effect(key) {
      const name = npcEffectName(npcType, key);
      const frames = name && window.Engine && Engine.anim ? Engine.anim(name) : null;
      if (!frames || !frames.length) return;
      effects.push({ frames: frames, start: now(), sheets: NPC_EFFECT_SHEETS[npcType] || [] });
    }
    if (window.addEventListener) window.addEventListener('resize', invalidateLayout);
    if (window.ResizeObserver) {
      try {
        resizeObserver = new ResizeObserver(invalidateLayout);
        resizeObserver.observe(root.ownerSVGElement || root);
        resizeObserver.observe(host);
      } catch (e) { if (resizeObserver) resizeObserver.disconnect(); resizeObserver = null; }
    }
    if (window.MutationObserver) {
      try {
        layoutObserver = new MutationObserver(invalidateLayout);
        layoutObserver.observe(root.ownerSVGElement || root, {
          attributes: true, attributeFilter: ['viewBox', 'preserveAspectRatio', 'width', 'height', 'style', 'class'],
        });
        for (const el of [host, host.parentNode]) if (el) layoutObserver.observe(el, {
          attributes: true, attributeFilter: ['style', 'class'],
        });
      } catch (e) { if (layoutObserver) layoutObserver.disconnect(); layoutObserver = null; }
    }
    function disposeLayout() {
      disposed = true;
      if (window.removeEventListener) window.removeEventListener('resize', invalidateLayout);
      if (resizeObserver) resizeObserver.disconnect();
      if (layoutObserver) layoutObserver.disconnect();
      if (battle.atlasCleanups) battle.atlasCleanups.delete(disposeLayout);
    }
    if (!battle.atlasCleanups) battle.atlasCleanups = new Set();
    battle.atlasCleanups.add(disposeLayout);
    const statuApi = makeStatuApi(holder && holder.byName ? holder.byName('statu') : null);
    const api = {
      side: side, holder: holder, mc: holder && holder.__hero, statu: statuApi.statu, info: info, npc: npcType,
      blood: { totalBlood: 1, leftBlood: 1, finalBlood: 1 },
      statuCode: 0, weaponNow: null,
      skills: (info && info.skills) || {},
      skillLevel(id) { return Number(api.skills[Number(id)]) || 0; },
      defenseSkillLevel() { return 0; },
      dress() {}, setStatu: statuApi.setStatu, specialEffect: statuApi.specialEffect,
      attacks: () => null, defenses: () => null, playSub: () => null,
      async attack(r, hooks) {
        const h = hooks || {};
        const skill = !!(r && r.action === 'skill');
        const name = npcAnimName(npcType, skill ? 'skill' : 'common');
        api.lastAttack = { frame: 0, action: String(r && r.action || ''), id: Number(r && r.id) || 0 };
        effect(skill ? 'skillAttack' : 'commonAttack');
        let hit = false;
        const frames = Engine.anim(name) || [];
        const at = NPC_HIT_FRAME[name] || Math.max(1, Math.floor(frames.length * 0.55));
        await play(name, { onFrame: (n) => { if (!hit && n >= at) { hit = true; if (h.hit) h.hit(); } } });
        if (!hit && h.hit && live && !live.skipped) h.hit();
        api.lastAttack.frame = frames.length;
      },
      async beAttack(r, hooks) {
        const h = hooks || {};
        const dodge = !!(r && r.dodge);
        const name = npcAnimName(npcType, dodge ? 'dodge' : 'hit');
        effect(dodge ? 'runAround' : 'hitMe');
        let backed = false;
        const frames = Engine.anim(name) || [];
        const backAt = Math.max(1, frames.length - 1);
        await play(name, { onFrame: (n) => { if (!backed && n >= backAt) { backed = true; if (h.back) h.back(); } } });
        if (!backed && h.back && live && !live.skipped) h.back();
      },
      async attackBack(hooks) {
        effect('beatBack');
        const h = hooks || {};
        let hit = false;
        await play(npcAnimName(npcType, 'counter'), { onFrame: (n) => { if (!hit && n >= 4) { hit = true; if (h.hit) h.hit(); } } });
        if (!hit && h.hit && live && !live.skipped) h.hit();
      },
      async comeBack() {
        const name = npcAnimName(npcType, 'back');
        if (!Engine.hasAnim(name) || isDead) { api.idle(); return; }
        effect('runBack');
        await play(name);
      },
      async dead() { isDead = true; effect('die'); await play(npcAnimName(npcType, 'die')); },
      async congratulate() { effect('win'); await play(npcAnimName(npcType, 'win')); },
      isDead: () => isDead,
      idle() {
        if (isDead) return;
        if (anim && anim.loop && anim.name === npcAnimName(npcType, 'idle')) return;
        play(npcAnimName(npcType, 'idle'), { loop: true });
      },
      useSkillDefense() { return false; },
      hide() {
        disposeLayout();
        stopRaf();
        if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = 0; }
        if (anim && anim.finish) anim.finish();
        anim = null;
        clear();
        restoreStatic();
        if (holder) holder.__npcLayer = null;
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
      debug: () => ({
        hasMc: true, hasAttacks: false, npc: npcType,
        anim: anim ? anim.name : null, frame: anim ? anim.idx + 1 : null,
        frames: anim ? anim.frames.length : 0,
        atk: null, def: null, lastAttack: api.lastAttack || null,
      }),
    };
    if (holder) holder.__fighter = api;
    if (api.mc) api.mc.__fighter = api;
    api.idle();
    return api;
  }


  function makeStaticNpcFighter(side, holder, info, npcType) {
    const mc = holder && holder.__hero;
    if (mc && mc.g) mc.g.style.visibility = '';
    let isDead = false;
    const statuApi = makeStatuApi(holder && holder.byName ? holder.byName('statu') : null);
    const api = {
      side: side, holder: holder, mc: mc, statu: statuApi.statu, info: info, npc: npcType,
      blood: { totalBlood: 1, leftBlood: 1, finalBlood: 1 },
      statuCode: 0, weaponNow: null,
      skills: (info && info.skills) || {},
      skillLevel(id) { return Number(api.skills[Number(id)]) || 0; },
      defenseSkillLevel() { return 0; },
      dress() {}, setStatu: statuApi.setStatu, specialEffect: statuApi.specialEffect,
      attacks: () => null, defenses: () => null, playSub: () => null,
      async attack(r, hooks) {
        const h = hooks || {};
        api.lastAttack = { frame: 0, action: String(r && r.action || ''), id: Number(r && r.id) || 0 };
        npcPause(api);
        const skill = !!(r && r.action === 'skill');
        npcPose(api, { dx: 12, dy: -4, scale: skill ? 1.05 : 1.02, rotate: skill ? -3 : -1.5 });
        await wait(skill ? 170 : 120);
        if (h.hit) h.hit();
        if (h.heal) h.heal();
        await wait(skill ? 240 : 130);
        npcResume(api);
      },
      async beAttack(r, hooks) {
        const h = hooks || {};
        npcPause(api);
        if (r && r.dodge) {
          npcPose(api, { dx: -24, dy: 0, rotate: -5 });
          await wait(110);
          npcPose(api, { dx: -34, dy: 0, rotate: -7 });
          await wait(120);
        } else {
          for (let i = 0; i < 4; i++) {
            npcPose(api, { dx: i % 2 ? 5 : -5, dy: i % 2 ? 1 : -1, rotate: i % 2 ? 2 : -2 });
            await wait(45);
          }
          if (h.back) h.back();
          await wait(70);
        }
        npcResume(api);
      },
      async attackBack(hooks) {
        npcPause(api);
        npcPose(api, { dx: 10, dy: -3, scale: 1.02, rotate: -2 });
        await wait(150);
        if (hooks && hooks.hit) hooks.hit();
        await wait(130);
        npcResume(api);
      },
      async comeBack() { npcResume(api); },
      async dead() {
        isDead = true;
        npcPause(api);
        npcPose(api, { dx: -10, dy: 14, scale: 0.96, rotate: -14, opacity: 0.55 });
        await wait(320);
      },
      async congratulate() {
        npcPause(api);
        npcPose(api, { dy: -6, scale: 1.04, rotate: 2 });
        await wait(160);
        npcPose(api, { dy: 0, scale: 1, rotate: 0 });
        await wait(120);
        npcResume(api);
      },
      isDead: () => isDead,
      idle() { npcResume(api); },
      useSkillDefense() { return false; },
      hide() {},
      debug: () => ({
        hasMc: !!mc, hasAttacks: false, npc: npcType,
        frame: mc ? mc.frame : null, frames: mc && mc.frameCount ? mc.frameCount() : 0,
        atk: null, def: null, lastAttack: api.lastAttack || null,
      }),
    };
    if (holder) holder.__fighter = api;
    if (mc) mc.__fighter = api;
    api.idle();
    return api;
  }

  function makeNpcFighter(side, holder, info, npcType, mutant) {
    if (npcAtlasReady(npcType)) {
      try {
        const atlas = makeAtlasNpcFighter(side, holder, info, npcType, mutant);
        if (atlas) return atlas;
      } catch (e) {
        if (window.__errs) window.__errs.push('[SfFight] npc atlas: ' + (e && e.message));
        if (holder && holder.__npcLayer) {
          try { holder.__npcLayer.parentNode && holder.__npcLayer.parentNode.removeChild(holder.__npcLayer); } catch (e2) {}
          holder.__npcLayer = null;
        }
        if (holder && holder.__hero && holder.__hero.g) holder.__hero.g.style.visibility = '';
        if (holder && holder.g) holder.g.style.visibility = '';
      }
    }
    return makeStaticNpcFighter(side, holder, info, npcType);
  }
  function makeFighter(side, holder, info) {
    if (holder && holder.__npc) return makeNpcFighter(side, holder, info, holder.__npc, !!holder.__mutant);
    const slot = holder && holder.byName('playerMc');

    const mc = (holder && holder.__hero) || (slot && slot.byName('playerMc')) || null;
    const statu = holder && holder.byName('statu');
    // ⚠ "倒过了没有"必须放在闭包变量里：`api` 的字面量里曾经同时有 `dead: false`
    let isDead = false;
    const campaign = !!(holder && holder.__campaign);
    const api = {
      side: side, holder: holder, mc: mc, statu: statu, info: info,
      campaign: campaign,
      blood: { totalBlood: 1, leftBlood: 1, finalBlood: 1 },
      statuCode: 0,

      weaponNow: null,

      skills: (info && info.skills) || {},

      weapons: (info && info.weapons) || {},
      skillLevel(id) { return Number(api.skills[Number(id)]) || 0; },
      weaponLevel(id) { return Number(api.weapons[Number(id)]) || 0; },

      defenseSkillLevel(r) {
        if (r && r.fakeDie) return api.skillLevel(6);
        if (r && r.guiJia) return api.skillLevel(7);
        if (r && r.jueDui) return api.skillLevel(16);
        return 0;
      },
      // 每次换帧后重贴一遍装备的兜底入口（正常路径由 `onClip` 在建树那一刻接管）。
      dress() { if (mc) dressTree(mc, side); },
      setStatu(code) { api.statuCode = code; },
      // `Player.specialEffect()`：把这一拍中的状态图标从自己头顶升起来。
      // ⚠ 复刻以前是裸 `play(statu, 2)`：渲染器的节拍器会一直循环它，图标升上去又从头来，
      specialEffect() {
        const icon = STATU_ICON[api.statuCode];
        api.statuCode = 0;
        if (!icon || !statu) return;
        stopAt(statu, 1);
        const prop = statu.byName('propty');
        if (prop) stopAt(prop, icon);
        playClip(statu, { stop: statu.frameCount ? statu.frameCount() : 20 });
      },
      attacks: () => mc && mc.byName('attacks'),
      defenses: () => mc && mc.byName('defenses'),
      playSub(name, inner, frame) {
        const sel = mc && mc.byName(name);
        if (!sel) return null;
        stopAt(sel, frame);
        const child = sel.byName(inner);
        return child || null;
      },

      async attack(r, hooks) {
        const sel = mc && mc.byName('attacks');
        if (!sel) return;
        visible(sel, true);

        if (campaign) {
          if (api.stopBreath) api.stopBreath();
          const h = hooks || {};
          const frame = (r && r.action === 'skill') ? 2
            : (r && r.action === 'pet') ? 3 : 1;
          stopAt(sel, frame);
          api.weaponNow = null;
          api.lastAttack = { frame: frame, action: String(r && r.action), id: Number(r && r.id) || 0,
            petId: Number(r && r.petId) || 0, petSkillId: Number(r && r.petSkillId) || 0 };
          const inner = sel.byName('attack') || onlyChildClip(sel);
          if (!inner) return;
          const total = inner.frameCount ? inner.frameCount() : 10;
          const hitAt = Math.max(1, Math.floor(total * 0.45));
          await playClip(inner, { deep: true, onFrame: (n) => { if (n >= hitAt && h.hit) h.hit(); } });
          return;
        }
        const plan = attackPlan(r);
        // 出手前先记下"这一拍用的是哪把武器"：武器容器是在拨帧那一刻建出来的
        // （`stopAt` → `showFrame()` → 建子件 → `onClip`），所以必须写在它前面。
        api.weaponNow = (r && r.action === 'weapon')
          ? { id: Number(r.id) || 0, level: Number(r.level) || 1 } : null;
        api.luckyCount = (r && r.action === 'skill' && Number(r.id) === 23)
          ? Math.max(1, Math.min(6, Math.round(Number(r.boomCount) || 1))) : null;
        stopAt(sel, plan.frame);

        refreshWeaponArt(sel, api);

        api.lastAttack = { frame: plan.frame, action: String(r.action), id: Number(r.id) || 0,
          petId: Number(r.petId) || 0, petSkillId: Number(r.petSkillId) || 0 };
        const acts = ATTACK_ACTS[plan.frame] || {};
        const h = hooks || {};
        // `attacks` 选择器换帧后，子件有时不是具名 `attack`（导出里少数帧只有一颗
        // 站着、没有跑过去攻击”。退回当前帧唯一子件，保证普攻/武器至少播一条动作。
        const inner = sel.byName('attack') || onlyChildClip(sel);
        if (!inner) return;
        await playClip(inner, {
          deep: true, onFrame: (n) => {
            if (acts.guard && n >= acts.guard && h.guard) h.guard();
            if (acts.heal && n >= acts.heal && h.heal) h.heal();
            if (acts.hit && n >= acts.hit && h.hit) h.hit();
          },
        });
      },

      debug: () => {
        const innerOf = (selName, kid) => {
          const sel = mc && mc.byName(selName);
          const inner = sel && sel.byName ? sel.byName(kid) : null;
          return inner ? { frame: inner.frame + 1, frames: inner.frameCount ? inner.frameCount() : 0 } : null;
        };
        let box = null, atkBox = null;
        try {
          const b = mc && mc.g ? mc.g.getBBox() : null;
          if (b) box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
          const a = mc && mc.byName('attacks');
          const ab = a && a.g ? a.g.getBBox() : null;
          if (ab) atkBox = { x: Math.round(ab.x), y: Math.round(ab.y), w: Math.round(ab.width), h: Math.round(ab.height) };
        } catch (e) {}
        return { hasMc: !!mc, hasAttacks: !!(mc && mc.byName('attacks')),
          frame: mc ? mc.frame : null, frames: mc && mc.frameCount ? mc.frameCount() : 0,
          atk: innerOf('attacks', 'attack'),
          def: innerOf('defenses', 'defense') || innerOf('dodges', 'dodge') || innerOf('defenseSkills', 'deSkill'),
          box, atkBox, lastAttack: api.lastAttack || null };
      },
      // `useSkillDefense()`：防御技起手（`Squirrel.useSkillDefense`）。
      // ⚠ 征战动物 boss 走 `Animals.useSkillDefense()` —— 空函数（`Animals.as:56`），
      // 而且动物模型第 4 帧是空帧（没有 `defenseSkills` 层）。这里必须先返回 false，
      useSkillDefense(r) {
        if (campaign) return false;
        const d = defensePlan(r, !!(live && live.plans[side]), api.defenseSkillLevel(r), side);
        if (d.kind !== 'skill') return false;
        stopAt(mc, 4);
        const sel = mc && mc.byName('defenseSkills');
        if (!sel) return false;
        stopAt(sel, d.frame || 1);
        const inner = sel.byName('deSkill');
        if (inner) play(inner, 2);
        return true;
      },
      // `beAttack()`：受击 / 闪避 / 技能防御。
      // ⚠ 顺序必须照原版：先把身体拨到那一档、再在里面找子动作。
      // `hooks.guarded` = 防御技已经由 `useSkillDefense()` 起手过（不要再从头播一遍）。
      async beAttack(r, hooks) {
        if (api.stopBreath) api.stopBreath();
        const h = hooks || {};
        const d = defensePlan(r, !!(live && live.plans[side]), api.defenseSkillLevel(r), side);
        const frame = d.frame || 1;

        if (r && r.stripApplied && Number(r.specialEffect) === 1) setGearStripped(side, true);

        if (d.kind === 'none') return;
        if (d.kind === 'dodge') {
          stopAt(mc, 3);
          const sel = mc && mc.byName('dodges');
          if (sel) {
            stopAt(sel, 1);
            await playClip(sel.byName('dodge'), { deep: true, onFrame: backHook(DODGE_ACTS, h) });
          }
          return;
        }
        if (d.kind === 'skill') {

          if (campaign) {
            stopAt(mc, 2);
            const hitSel = mc && mc.byName('defenses');
            if (hitSel) {
              stopAt(hitSel, 1);
              const inner = hitSel.byName('defense') || onlyChildClip(hitSel);
              if (inner) await playClip(inner, { deep: true, onFrame: backHook(DEFENSE_ACTS[1], h) });
            }
            return;
          }
          if (h.guarded) {

            const cur = mc && mc.byName('defenseSkills');
            const inner = cur && cur.byName('deSkill');
            if (inner) await playClip(inner, { resume: true, onFrame: backHook(DEFENSE_SKILL_ACTS[frame], h) });
            return;
          }
          stopAt(mc, 4);
          const sel = mc && mc.byName('defenseSkills');
          if (sel) {
            stopAt(sel, frame);
            await playClip(sel.byName('deSkill'), { deep: true, onFrame: backHook(DEFENSE_SKILL_ACTS[frame], h) });
          }
          return;
        }
        stopAt(mc, 2);
        const sel = mc && mc.byName('defenses');
        if (sel) {

          const hitFrame = campaign ? 1 : frame;
          stopAt(sel, hitFrame);

          const inner = sel.byName('defense') || onlyChildClip(sel);
          if (inner) {
            const acts = DEFENSE_ACTS[hitFrame];
            let backed = false;
            await playClip(inner, {
              deep: true,
              onFrame: (n) => {
                if (acts && acts.back && n >= acts.back) { backed = true; if (h.back) h.back(); }
              },
            });

            if (campaign && !backed && h.back) h.back();
          } else await wait(320);
        }
      },

      async attackBack(hooks) {
        const h = hooks || {};
        const back = () => { if (h.hit) h.hit(); };
        stopAt(mc, 5);
        const sel = mc && mc.byName('attackbacks');
        if (!sel) { back(); return; }
        stopAt(sel, 1);
        const inner = sel.byName('attackback');
        if (!inner) { back(); return; }
        await playClip(inner, { deep: true, onFrame: (n) => { if (n >= ATTACKBACK_ACTS.hit) back(); } });
      },
      // `comeBack(type)`：被反击击退之后归位（`type` 决定播哪一档，见 `COMEBACK_ACTS`）。
      // ⚠ 原版 `Animals.comeBack`（`Animals.as:101-122`）第一句就是
      async comeBack(type) {
        const f = Math.max(1, Math.min(3, (Number(type) || 0) + 1));
        if (!COMEBACK_ACTS[f]) return;
        if (campaign && !campaignHasLayer(mc, 'comeBacks')) return;
        stopAt(mc, 6);
        const sel = mc && mc.byName('comeBacks');
        if (sel) {
          stopAt(sel, f);
          await playClip(sel.byName('comeBack'), { deep: true });
        }
      },

      async dead(distance) {
        isDead = true;
        if (api.stopBreath) api.stopBreath();
        stopAt(mc, 2);
        const sel = mc && mc.byName('defenses');
        if (!sel) return;

        if (campaign) {
          stopAt(sel, distance === 1 ? 3 : 2);
          const inner = sel.byName('defense') || onlyChildClip(sel);
          if (inner) await playClip(inner, { deep: true });
          return;
        }
        stopAt(sel, distance === 1 ? 5 : 4);
        // `defenses` 第 5 帧的子件没有 `defense` 实例名（只有第 4 帧有），
        // 距离档 1 时退回当前帧唯一子件，别让整段倒地动画静默不播。
        const deadClip = sel.byName('defense') || onlyChildClip(sel);

        if (deadClip) await playClip(deadClip, { deep: true, keepNestedIds: [6362, 6365] });
      },

      async congratulate() {
        stopAt(mc, 7);
        const sel = mc && mc.byName('winPoses');
        if (sel) { stopAt(sel, 1); await playClip(sel.byName('winPose'), { deep: true }); }
      },
      isDead: () => isDead,

      idle() {
        stopAt(mc, 1);
        // 色诱之术 5843 的末段带着「道场」场景，它挂在 `attacks` 选择器里；
        // ⚠ 这里不能把 `attacks` 整层 `visibility:hidden` —— 战斗身体第 1 帧
        const atk = mc && mc.byName('attacks');
        if (atk) {
          stopAt(atk, 1);
          const inner = atk.byName('attack');
          if (inner) stopAt(inner, 1);
        }
        startIdlePose(mc);

        if (campaign) startCampaignIdle(api);
      },
    };

    if (holder) holder.__fighter = api;
    if (mc) mc.__fighter = api;
    return api;
  }
  // 兜底穿搭：把子树里还没贴过的挂点/持有者补一遍（正常路径由 `onClip` 在建树那一刻接管）。
  function dressTree(clip, side) {
    const plan = live && live.plans[side];
    if (!plan || !clip || !clip.nodes) return;
    for (const rec of clip.nodes.values()) {
      if (!rec.clip) continue;
      const hf = plan.holders.get(String(rec.clip.tag.id));
      if (hf != null && rec.clip.__pinFrame == null) { try { rec.clip.pinFrame(hf); } catch (e) {} }
      const p = plan.bySlot.get(String(rec.clip.tag.id));
      if (p && !rec.clip.__dressed) {
        rec.clip.__dressed = true;
        try {
          rec.clip.setSymbol(p.symbol, p.frame, 1, 'topleft');
          rec.clip.__gearSlot = true;
          if (live && live.strip && live.strip[side]) setGearClipHidden(rec.clip, true);
        } catch (e) {}
      }
      dressTree(rec.clip, side);
    }
  }

  function setGearClipHidden(clip, on) {
    const node = clip && (clip.g || clip);
    if (node && node.style) node.style.display = on ? 'none' : '';
  }
  function walkClips(clip, fn) {
    if (!clip) return;
    fn(clip);
    if (!clip.nodes) return;
    for (const rec of clip.nodes.values()) if (rec.clip) walkClips(rec.clip, fn);
  }

  function setGearStripped(side, on) {
    if (!live || !live.strip) return;
    live.strip[side] = !!on;
    const f = live.fighters[side];
    if (!f || !f.mc) return;
    walkClips(f.mc, (clip) => { if (clip.__gearSlot) setGearClipHidden(clip, on); });
  }

  function syncStrip(rec, r) {
    if (!r || !Array.isArray(r.stripLeft)) return;
    for (let i = 0; i < 2; i++) {
      const on = Number(r.stripLeft[i]) > 0;
      if (!!rec.strip[i] !== on) setGearStripped(i, on);
    }
  }


  const IDLE_POSE_SYM = '5616';

  // 这只模型有没有某一层（例：`comeBacks`）。
  // ⚠ 不能用 `mc.byName(name)` 判断：`byName` 只反映当前帧，而"这一层存不存在"要在
  function campaignHasLayer(mc, name) {
    if (!mc || !mc.frames) return false;
    for (const fr of mc.frames) {
      for (const p of fr.values()) if (p && p.na === name) return true;
    }
    return false;
  }
  // 待机呼吸片断（原版无脚本 → 一直循环）：`6533` 狡兔 / `6603` 狼王 / `6636` 妖狐 / `6685` 猿将。
  // 它们嵌在每只动物出手动画的第 1 帧里（6540/6604/6639/6686 的第 1 帧唯一那颗 depth 1
  function campaignIdleClip(f) {
    const mc = f && f.mc;
    const sel = mc && mc.byName ? mc.byName('attacks') : null;
    const atk = sel && sel.byName ? sel.byName('attack') : null;
    const rec = atk && atk.nodes ? atk.nodes.get(1) : null;
    const clip = rec && rec.clip;
    return (clip && clip.frames && clip.frames.length > 1) ? clip : null;
  }

  function startCampaignIdle(f) {
    const clip = campaignIdleClip(f);
    if (!clip) return false;
    startNestedAnim(clip, true, false, true);
    return true;
  }
  // 兜底用的"假呼吸"：模型缺待机片断时（素材包不全）才用。
  // ⚠ 幅度只有舞台宽的 1/300，肉眼几乎看不出来 —— 321GO 期间"敌人是纯静态"就是因为它
  function startCampaignBreath(rec, f) {
    if (!rec || !f || !f.campaign || !f.mc || !f.mc.setExtraTransform) return null;
    if (campaignIdleClip(f)) return null;
    let tick = 0, stopped = false;
    const apply = () => {
      if (stopped || rec.stopped || !f.mc || !f.mc.g || f.mc.g.isConnected === false) return;
      const dy = Math.sin(tick) * 1.1;
      tick += 0.45;
      try { f.mc.setExtraTransform('translate(0,' + dy.toFixed(2) + ')'); } catch (e) {}
    };
    apply();
    const timer = setInterval(apply, 90);
    rec.timers.push(timer);
    f.stopBreath = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try { f.mc.setExtraTransform(''); } catch (e) {}
    };
    return f.stopBreath;
  }

  function startIdlePose(mc) {
    if (!mc) return false;
    if (String(mc.tag && mc.tag.id) === IDLE_POSE_SYM) {

      startNestedAnim(mc, true, false, true);
      return true;
    }
    for (const rec of mc.nodes ? mc.nodes.values() : []) {
      if (rec && rec.clip && startIdlePose(rec.clip)) return true;
    }
    for (const c of mc.__attached || []) if (startIdlePose(c)) return true;
    return false;
  }


  // 这一场的幻兽队伍（最多 3 只，保持编队顺序）。
  function hudPetList(f) {
    return (Array.isArray(f && f.pets) ? f.pets : []).filter((p) => p && Number(p.id) > 0).slice(0, 3)
      .map((p) => ({ id: Number(p.id), name: String(p.name || '幻兽'), grade: Number(p.grade) || 1,
        level: Number(p.level) || 1, skillId: Number(p.skillId) || 0 }));
  }
  const FIGHT_CORE_FILE = 'tags-fight-core.json';
  const fightChunkFile = (sym) => 'tags-fight-' + String(sym) + '.json';
  /* 本场可能出现的攻击动作：服务端录像里的每一拍 + 双方武器/技能/幻兽的静态可能。
   * 只加载这些动作包，核心包（受击/闪避/防御技/HUD/战果）常驻。 */
  function fightAttackSymbols(o) {
    const syms = new Set();
    const addFrame = (frame) => {
      const acts = ATTACK_ACTS[Number(frame)];
      if (acts && acts.sym) syms.add(String(acts.sym));
    };
    addFrame(1); addFrame(11);
    const rounds = (o && o.result && Array.isArray(o.result.rounds)) ? o.result.rounds : [];
    for (const r of rounds) addFrame(attackPlan(r).frame);
    for (const f of [o && o.me, o && o.foe]) {
      if (!f) continue;
      for (const w of (Array.isArray(f.weapons) ? f.weapons : [])) addFrame(RANGED.has(Number(w && w.id)) ? 3 : 2);
      for (const s of (Array.isArray(f.skills) ? f.skills : [])) {
        const pair = SKILL_ATTACK_FRAME[Number(s && s.id)];
        if (pair) { addFrame(pair[0]); addFrame(pair[1]); }
      }
      for (const p of hudPetList(f)) addFrame(29 + Number(p.id));
    }
    return [...syms];
  }
  // 主页空闲时预取核心包；失败只返回 null，不影响后续开战自己再拉。
  function preloadCore() {
    try { return SfRender.loadExtra(FIGHT_CORE_FILE).catch(() => null); } catch (e) { return Promise.resolve(null); }
  }
  // 挑战页选中对手后预算本场动作包并预热 HTTP 缓存；`loadFightAssets` 开打时只做解析。
  // 只按双方面板算静态可能（录像里的随机拍是它的子集），同一套对手不重复发起。
  let prefetchedMatchKey = '';
  function prefetchMatch(foe) {
    const f = foe && (foe.fighter || foe);
    if (!f || !window.SfRender || !SfRender.prefetch) return false;
    const me = {
      weapons: (window.State && State.myWeapons) ? State.myWeapons() : [],
      skills: (window.State && State.mySkills) ? State.mySkills() : [],
      pets: (window.State && State.petTeam) ? State.petTeam() : [],
    };
    const sig = (list) => (Array.isArray(list) ? list : [])
      .map((v) => Number(v && v.id) + ':' + Number(v && v.level)).join(',');
    const key = [sig(me.weapons), sig(me.skills), sig(me.pets), sig(f.weapons), sig(f.skills), sig(f.pets)].join('|');
    if (key === prefetchedMatchKey) return false;
    prefetchedMatchKey = key;
    const files = [];
    if (hudPetList(me).length || hudPetList(f).length) files.push('tags-fight-pets.json');
    files.push(...fightAttackSymbols({ me, foe: f }).map(fightChunkFile));
    if (foe && foe.campaign) files.push('tags-campaign-boss.json');
    files.push('tags-fight-result.json');
    // 核心包优先：先等它下完再预热动作包，别让十几包把核心挤慢。
    Promise.resolve(preloadCore()).then(() => {
      if (key !== prefetchedMatchKey || live) return;
      try { SfRender.prefetch(files); } catch (e) {}
    }, () => {});
    return true;
  }
  async function loadFightAssets(o) {
    // 开打后立刻停掉串行预热：它占着缓存锁，会让 Promise.all 的动作包排队。
    try { if (SfRender.cancelPrefetch) SfRender.cancelPrefetch(); } catch (e) {}
    // 核心包先落地：动作包等它下完再并行，避免核心和十几包抢同一条带宽。
    let anim = Promise.resolve(false);
    try { if (window.Engine && Engine.loadAnim) anim = Engine.loadAnim().catch(() => false); } catch (e) {}
    await Promise.all([anim, SfRender.loadExtra(FIGHT_CORE_FILE)]);
    const syms = fightAttackSymbols(o);
    const files = syms.map(fightChunkFile);
    if (files.length) {
      try { await Promise.all(files.map((f) => SfRender.loadExtra(f))); }
      catch (e) {
        for (const f of files) { try { if (SfRender.releaseExtra) SfRender.releaseExtra(f); } catch (releaseError) {} }
        throw e;
      }
    }
    return files;
  }
  const HUD_PET_SYMBOLS = ['2565','2494','2961','2664','2483','2734','2883','2465',
    '2898','2687','2809','2947','2828','2854','2442','2972','2744','2634','2721','2710',
    '2518','2926','2841','2456','2578','2621','2781','2432','2907','2796','2689','2542'];

  const DEFENDER_PET_DX = -12;
  function mountPetSlot(slot, pet, dx) {
    if (!slot || !slot.attachChild) return;
    if (slot.setExtraTransform) slot.setExtraTransform(dx ? 'translate(' + dx + ',0)' : '');
    try { if (slot.detachAll) slot.detachAll(); } catch (e) {}
    const id = HUD_PET_SYMBOLS[Number(pet.id) - 1];
    let clip = null;
    try { if (id) clip = slot.attachChild(id, 1, 'summonsImgMc'); } catch (e) { clip = null; }
    if (!clip || !clip.g) { visible(slot, false); return; }
    clip.playing = false;
    clip.setExtraTransform('scale(1.4)');
  }
  // HUD 素材的文本字段带作者占位串（`9999/9999` / `李二强李二强`），昵称/血量节点第 8 帧才出生。
  // 真值先登记在 HUD 上，节点出生即写入；否则先画出的占位串会在部分安卓 WebView 上留成残影。
  function applyHudStats(hud, names, opts) {
    setNameText(hud.byName('name1'), names[0]);
    setNameText(hud.byName('name2'), names[1]);
    // 状态格 `c1..c3`（3414）由 `showStates` 管药丸；这一场还没接药丸，照旧收掉。
    // 左侧 1→2→3，右侧 3→2→1（原版对右方传入的顺序就是反的）。
    for (let i = 0; i < 3; i++) visible(hud.byName('c' + (i + 1)), false);
    // 换帧后文本节点可能重建，签名相同就跳过会让新节点停在占位串上。
    if (live) live.bloodSig = null;
    refreshBlood(hud, opts);
  }
  function showFightInfo(hud, names) {
    stopAt(hud, HUD_FRAME);
    applyHudStats(hud, names);
    const teams = (live && live.petTeams) || [[], []];
    for (const side of [0, 1]) {
      const slots = side === 0 ? ['attackerS1', 'attackerS2', 'attackerS3'] : ['defenderS3', 'defenderS2', 'defenderS1'];
      const pets = teams[side] || [];
      for (let i = 0; i < 3; i++) {
        const slot = hud.byName(slots[i]);
        if (!slot) continue;
        if (!pets[i]) { visible(slot, false); continue; }
        visible(slot, true);
        stopAt(slot, 2);
        mountPetSlot(slot, pets[i], side === 1 ? DEFENDER_PET_DX : 0);
      }
    }
  }
  function refreshBlood(hud, opts) {
    const t = T();
    if (!live || !hud) return;
    const textOnly = !!(opts && opts.textOnly);
    // 才重写血条帧与文本（`stopAt` 会走 showFrame），否则这一拍纯属重复劳动。
    const sig = [live.fighters[0] && live.fighters[0].blood.leftBlood,
      live.fighters[0] && live.fighters[0].blood.totalBlood,
      live.fighters[1] && live.fighters[1].blood.leftBlood,
      live.fighters[1] && live.fighters[1].blood.totalBlood,
      live.shields && live.shields[0], live.shields && live.shields[1], live.roundsLeft].join('|');
    if (live.bloodSig === sig) return;
    live.bloodSig = sig;
    for (let i = 0; i < 2; i++) {
      const f = live.fighters[i];
      if (!f) continue;
      const total = Math.max(1, f.blood.totalBlood || 1);
      const left = Math.max(0, Math.min(total, f.blood.leftBlood));
      const shield = Math.max(0, Math.round(Number(live.shields && live.shields[i]) || 0));
      const bar = hud.byName('bloodbar' + (i + 1));
      if (!textOnly) stopAt(bar, Math.max(1, Math.min(BLOOD_BAR_FRAMES, Math.floor((total - left) * 100 / total) || 1)));
      const txt = hud.byName('bloodtext' + (i + 1));
      // 血量数字不按原版 59 单位字段框裁切：高层/高 buff 的生命会超过六位，
      // 裁掉后看起来像“数字被血条边界挡住”。只放开这两条字段。
      // 护盾算进分子：x = 血量+护盾，y = 生命上限。
      if (txt) setText(txt, (left + shield) + '/' + total + ' ', { noClip: true });
      if (!textOnly) drawShieldBar(live, i, bar, left, total, shield);
    }
    if (!textOnly && t) t.showNumber(Math.max(0, live.roundsLeft), hud, 0, 0, 'right', 2);
  }
  // 护盾条：画在血条自己的 SVG 子树里（不再用按屏幕 px 定位的 DOM 小牌 ——
  // Android 上主机缩放/留边会让那块「盾 N」明显偏移）。淡蓝色压在黄色血条最左一段，
  // 条的总长仍按生命上限；数字已由 `refreshBlood` 改成 `血量+护盾/上限`。
  function drawShieldBar(rec, side, bar, left, total, shield) {
    if (!rec || !bar) return;
    if (!rec.shieldRects) rec.shieldRects = [null, null];
    let rect = rec.shieldRects[side];
    const host = bar.getContentHost ? bar.getContentHost() : null;
    if (!shield || !host) {
      if (rect && rect.parentNode) rect.parentNode.removeChild(rect);
      rec.shieldRects[side] = null;
      return;
    }

    let box = null, clipAttr = '';
    if (bar.nodes) {
      for (const v of bar.nodes.values()) {
        if (!v) continue;
        if (String(v.id) === '7695' && v.node && v.node.getBBox) {
          try { const b = v.node.getBBox(); if (b && b.width > 0) box = b; } catch (e) {  }
        }
        if (v.wrap && v.wrap.getAttribute) {
          const cp = v.wrap.getAttribute('clip-path');
          if (cp) clipAttr = cp;
        }
      }
    }
    if (!box) return;
    if (!rect || !rect.parentNode) {
      rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('fill', '#78e2ff');
      rect.setAttribute('fill-opacity', '0.95');
      rect.setAttribute('pointer-events', 'none');
      rec.shieldRects[side] = rect;
    }

    host.appendChild(rect);
    const pct = Math.max(0, Math.min(1, left / Math.max(1, total)));
    const sp = Math.max(0, Math.min(1, shield / Math.max(1, total)));
    let mirrored = false;
    try {
      const m = bar.g && bar.g.getCTM && bar.g.getCTM();
      if (m) mirrored = m.a < 0;
    } catch (e) {  }
    const width = box.width * sp;
    const x = mirrored ? box.x + box.width * (pct - sp) : box.x;
    rect.setAttribute('x', x.toFixed(2));
    rect.setAttribute('y', box.y.toFixed(2));
    rect.setAttribute('width', Math.max(0, width).toFixed(2));
    rect.setAttribute('height', box.height.toFixed(2));
    if (clipAttr) rect.setAttribute('clip-path', clipAttr); else rect.removeAttribute('clip-path');
  }
  // `showBlood()`（`MainMovie.as:15756`）：把那一侧的伤害数字模板复制一份再播。
  // 这就是飘字落点（装备包之外唯一一处能拿到它的地方，`run()` 里量一次存进
  // ⚠ 没有纵向随机抖动 —— `±(random(50)+10)` / `±random(60)` 那是 `duplicateMc()`
  const FLOAT_KIND = {
    hit: { frame: 1, symbol: 1, font: 2 },
    dot: { frame: 1, symbol: 1, font: 2 },
    heal: { frame: 1, symbol: 2, font: 3 },

    back: { frame: 2, symbol: 1, font: 2 },

    berserk: { frame: 1, symbol: 3, font: 4 },
  };

  const DAMAGE_FLOAT_MAX = 0x7fffffff;
  const FLOAT_DIGIT_MAX = 10;
  const FLOAT_DIGIT_SYMBOL = '3529';
  const FLOAT_DIGIT_SCALE = 0.71;
  const FLOAT_DIGIT_X = -14.55;
  const FLOAT_DIGIT_STEP = 12.85;
  const FLOAT_DIGIT_Y = -0.05;
  // 一个伤害数字要显示成什么样：钳到 int 上限、要几个 digit 槽、特效档（封顶第 3 档）。
  // 单独拎出来是为了让回归能直接核对 9999 / 10000 / int 上限这三个边界。
  function damageFloatPlan(value) {
    const mag = Math.min(DAMAGE_FLOAT_MAX, Math.max(0, Math.round(Math.abs(Number(value) || 0))));
    const digits = Math.max(4, Math.min(FLOAT_DIGIT_MAX, String(mag).length));
    const tier = mag > 20 ? 3 : mag > 10 ? 2 : 1;
    return { mag: mag, digits: digits, tier: tier };
  }

  function ensureFloatDigits(digits, want) {
    if (!digits || !digits.attachChild || !digits.names || typeof digits.names.set !== 'function') return;
    const count = Math.max(4, Math.min(FLOAT_DIGIT_MAX, Math.floor(Number(want) || 0)));
    for (let i = 5; i <= count; i++) {
      const name = 'num' + i;
      if (digits.byName(name)) continue;
      const clip = digits.attachChild(FLOAT_DIGIT_SYMBOL, 1, name);
      if (!clip || !clip.setExtraTransform) break;
      try { digits.names.set(name, clip); } catch (e) { break; }
      const x = (FLOAT_DIGIT_X + FLOAT_DIGIT_STEP * (i - 1)).toFixed(2);
      clip.setExtraTransform('matrix(' + FLOAT_DIGIT_SCALE + ',0,0,' + FLOAT_DIGIT_SCALE + ',' + x + ',' + FLOAT_DIGIT_Y + ')');
    }
  }
  function floatNumber(side, value, kind) {
    const view = live && live.view;
    if (!view || !view.attachChild) return;
    const plan = damageFloatPlan(value), mag = plan.mag;
    if (!mag) return;
    const spec = FLOAT_KIND[kind] || FLOAT_KIND.hit;
    const base = (live && live.bloodBase && live.bloodBase[side]) || (side === 0 ? [1.05, 56.25, 62.7] : [1.05, 244.25, 62.7]);
    const clip = view.attachChild(side === 0 ? '4845' : '4846', spec.frame, 'float');
    if (!clip) return;

    const jx = (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * 30);
    const stack = (live.floats[side] = (live.floats[side] || 0) + 1);
    clip.setExtraTransform('matrix(' + base[0] + ',0,0,' + base[0] + ',' + (base[1] + jx) + ',' + (base[2] + stack * 20) + ')');
    const bloodMc = clip.byName('bloodMc');
    if (bloodMc) {
      const t = T();
      const digitCount = plan.digits;

      const applyNumber = () => {
        const bm = clip.byName('bloodMc');
        const num = bm && bm.byName('num');
        if (!num) return;

        stopAt(num, plan.tier);
        stopAt(num.byName('addOrReduce'), spec.symbol);
        const digits = num.byName('num');
        if (digits) ensureFloatDigits(digits, digitCount);
        if (t && digits) t.showNumber(mag, digits, spec.font, 0, 0, digitCount);
      };
      applyNumber();

      playClip(bloodMc, { onFrame: (n) => { if (n <= 3) applyNumber(); } }).then(() => {
        if (clip.destroy) clip.destroy();
        else if (clip.g && clip.g.parentNode) clip.g.parentNode.removeChild(clip.g);
        if (live) live.floats[side] = Math.max(0, (live.floats[side] || 1) - 1);
      });
    }
  }

  // `boom(mc, num)`（`MainMovie.as:15710`）：幸运一击的多球分裂。
  // · `count = currentRound.boomCount`（协议第 15 字段；`sprite7850` 的 `mc.attacks.attack.count`）；
  // ⚠ 原来这里根本不做分裂：伤害一次飘完、也没有多出来的球（第 257 批自标的「功能缺口」）。

  const BOOM_BALL_JITTER = { xMin: 10, xSpan: 50, ySpan: 60 };

  const LUCKY_BALL = Object.freeze({ id: '6116', ma: '-0.75,0,0,0.75,392.65,89.85' });
  function boomSplit(rec, attacker, r, side, aborted, amount) {
    const view = rec && rec.view;
    const total = Math.max(0, Math.round(Math.abs(Number(amount != null ? amount : r.dmg) || 0)));
    const n = Math.max(2, Math.min(8, Math.round(Number(r.boomCount) || 0)));
    if (!total) return false;
    const share = Math.floor(total / n);
    const first = total - share * (n - 1);

    floatNumber(side, first, r.crit ? 'berserk' : 'hit');
    const sel = attacker && attacker.attacks ? attacker.attacks() : null;
    const attack = sel && sel.byName ? sel.byName('attack') : null;
    const sourceBall = attack && attack.byName ? attack.byName('ball') : null;
    if (!view || !sel || !sel.attachChild) return true;
    const ballId = (sourceBall && sourceBall.tag && sourceBall.tag.id) || LUCKY_BALL.id;
    const base = (sourceBall && sourceBall.g && sourceBall.g.__baseMa) ? String(sourceBall.g.__baseMa) : LUCKY_BALL.ma;
    const balls = [];
    for (let i = 1; i < n; i++) {
      const timer = setTimeout(() => {
        if (aborted()) return;
        const dx = (Math.random() < 0.5 ? -1 : 1) * (BOOM_BALL_JITTER.xMin + Math.floor(Math.random() * BOOM_BALL_JITTER.xSpan));
        const dy = (Math.random() < 0.5 ? -1 : 1) * Math.floor(Math.random() * BOOM_BALL_JITTER.ySpan);

        const clip = sel.attachChild(ballId, 1, 'boom');
        if (clip) {
          clip.setExtraTransform((base ? 'matrix(' + base + ') ' : '') + 'translate(' + dx + ',' + dy + ')');
          balls.push(clip);
          play(clip, 2);
        }
        if (share > 0) floatNumber(side, share, r.crit ? 'berserk' : 'hit');
      }, i * 100);
      if (rec.timers) rec.timers.push(timer);
    }

    const cleanup = setTimeout(() => {
      for (const c of balls) { try { if (c.destroy) c.destroy(); } catch (e) {} }
    }, n * 100 + 600);
    if (rec.timers) rec.timers.push(cleanup);
    return true;
  }


  function clean() {
    const rec = live;
    if (!rec) return;
    const onCancel = !rec.finished && rec.o && typeof rec.o.onCancel === 'function' ? rec.o.onCancel : null;
    rec.finished = true;
    if (rec.o && rec.o.claimChest) {
      rec.stopped = true;
      if (rec.chestPick) rec.chestPick(0);
      if (rec.confirmChest) rec.confirmChest();
    }
    for (const id of rec.timers) clearTimeout(id);
    for (const id of rec.rafs) caf(id);
    if (rec.atlasCleanups) for (const dispose of [...rec.atlasCleanups]) dispose();
    for (const wake of [...rec.sleepers]) wake();
    rec.sleepers.clear();
    if (rec.pickups) { try { rec.pickups.close(); } catch (e) {} }
    if (rec.topLayerRelayout && window.removeEventListener) window.removeEventListener('resize', rec.topLayerRelayout);
    if (rec.topLayerRO) { try { rec.topLayerRO.disconnect(); } catch (e) {} }
    if (rec.bgLayerRelayout && window.removeEventListener) window.removeEventListener('resize', rec.bgLayerRelayout);
    if (rec.bgLayerRO) { try { rec.bgLayerRO.disconnect(); } catch (e) {} }
    if (rec.skipButton) rec.skipButton.remove();
    if (rec.speedButton) rec.speedButton.remove();
    if (rec.host && rec.host.parentNode) rec.host.parentNode.removeChild(rec.host);
    if (rec.view) { try { rec.view.destroy(); } catch (e) {} }
    if (window.SfRender && SfRender.releaseExtra) {
      for (const file of (rec.fightChunks || [])) SfRender.queueExtraRelease(file, 1200);
      SfRender.queueExtraRelease('tags-fight-pets.json', 1200);
      // 征战接力会连续开四场，boss 包留到本局结束再回收。
      if (!(rec.o && rec.o.kind === 'campaign')) SfRender.queueExtraRelease('tags-campaign-boss.json', 1200);
    }
    if (live === rec) live = null;
    if (onCancel) onCancel();
  }
  function wait(ms) {
    const rec = live;
    if (!rec || rec.stopped || (rec.skipped && !rec.settling)) return Promise.resolve();
    const scaled = rec.speed > 1 ? ms / rec.speed : ms;
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); rec.sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, scaled);
      rec.sleepers.add(wake);
    });
  }

  async function run(opts) {
    const o = opts || {};
    const s = S();
    if (!s || !window.SfRender) throw new Error('SfFight 需要 State 与 SfRender');
    if (live && live.controller) live.controller.cancel();
    clean();
    const mine = ++seq;
    const ui = document.getElementById('ui');
    if (!ui) throw new Error('SfFight 找不到 #ui');
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-home';
    host.setAttribute('aria-label', '战斗');
    host.style.visibility = 'hidden';
    // 不立刻插进 #ui：素材没到之前保留原页面，避免先黑屏再挂载。

    const rec = {
      host: host, view: null, fighters: [null, null], plans: [null, null], speeds: 1,

      strip: [false, false],
      rounds: [], index: 0, round: 0, roundsLeft: 0, floats: [0, 0], hps: [1, 1], maxHp: [1, 1],
      shields: [0, 0], speed: 1, stopped: false, skipped: false, ended: false,

      petTeams: [hudPetList(o.me), hudPetList(o.foe)],
      timers: [], rafs: [], sleepers: new Set(), settling: false,
      // 「跳过」的即时信号：开打前奏（血条滑入 / 3-2-1-GO）不是回合演出，玩家按跳过时
      // 不能等它自己播完 —— `perform` 在每段前奏上都和这个 Promise 赛跑（见 `controller.skip`）。
      skipSignal: null, wakeSkip: null,

      o: o,
    };
    live = rec;
    rec.skipSignal = new Promise((resolve) => { rec.wakeSkip = resolve; });
    // 战斗中悬浮奖励（与复刻其它战斗同一份机制、同一份掉落规则）：
    // ⚠ 真正的创建放到 `Sim.simulate()` 之后（见下方 RNG 顺序说明）：这里先占位，
    // 让 `skip()` / `clean()` 在加载素材期间被调用时也能安全拿到 null。
    let pickups = null;

    try {
      rec.fightChunks = await loadFightAssets(o);
    } catch (e) {
      // 任一动作包缺失都不能把 live / mode 卡在“战斗中”；先清干净再让上层报错。
      try { clean(); } catch (cleanError) { if (window.__errs) window.__errs.push('SfFight clean: ' + (cleanError && cleanError.message)); }
      try { if (SfRender.queueExtraRelease) SfRender.queueExtraRelease(FIGHT_CORE_FILE, 2000); } catch (releaseError) {}
      throw e;
    }

    if (o.foe && o.foe.campaign) {
      try { await SfRender.loadExtra('tags-campaign-boss.json'); }
      catch (e) {  }
    }

    if (rec.petTeams.some((list) => list.length)) {
      try { await SfRender.loadExtra('tags-fight-pets.json'); } catch (e) {  }
    }
    // 已知录像里有整蛊专家时先偷偷预取卡面；随机对战等出结果再取，别让每只小丑都把 wsicon 拉一遍。
    if (o.result && Array.isArray(o.result.rounds) && o.result.rounds.some((r) => r && r.petSeal)) loadSealIcons();

    if (window.Engine && Engine.loadSheets) {
      const kinds = new Set();
      for (const src of [o.me, o.foe]) {
        const kind = npcTypeOf(src);
        if (kind && kind !== 'wood' && NPC_SHEETS[kind]) kinds.add(kind);
      }
      if (kinds.size) {
        const ids = [];
        for (const kind of kinds) ids.push(...NPC_SHEETS[kind], ...NPC_EFFECT_SHEETS[kind]);
        try {
          await Promise.race([
            Engine.loadSheets([...new Set(ids)]),
            new Promise((resolve) => setTimeout(resolve, 1200)),
          ]);
        } catch (e) {  }
        // 变异三侠的换色图集在普通图集之后生成；失败时 makeAtlasNpcFighter 会退回普通版。
        for (const src of [o.me, o.foe]) {
          if (!src || !src.mutant) continue;
          const kind = npcTypeOf(src);
          if (kind && NPC_SHEETS[kind]) { try { await Engine.ensureMutantSheets(kind); } catch (e) {} }
        }
      }
    }
    try { await loadGearTables(); } catch (e) {  }
    try { lootIcons = await SfRender.loadLootIcons(); } catch (e) {  }
    if (mine !== seq || rec.stopped) return null;
    // 先把（隐藏的）战斗页压上去再挂载；底页留到战斗页可见的那一帧，加载期间不会露出 canvas 首页。
    ui.appendChild(host);
    const view = await SfRender.mountSymbol(host, SYM.fight, {
      frame: F.scene, label: '战斗', policy: {}, onClip: onClip,
    });
    if (mine !== seq || rec.stopped) {
      try { view.destroy(); } catch (e) {}
      if (host.parentNode) host.parentNode.removeChild(host);
      return null;
    }
    rec.view = view;
    host.style.visibility = '';
    // 战斗播放期间把战果页素材拉好：结算时不再等 60KB，也不会和战斗动作包抢。
    try { SfRender.loadExtra('tags-fight-result.json').catch(() => null); } catch (e) {}
    // 同一帧内隐藏底页并清掉旧的 #ui；holdUnderlay 的接力回放要留着底页，不能在段与段之间露首页。
    if (!o.holdUnderlay) {
      if (window.Main && typeof Main.hideHeldForBattle === 'function') Main.hideHeldForBattle();
      if (window.Main && typeof Main.clearUiForBattle === 'function') Main.clearUiForBattle(host);
      else {
        for (const node of Array.from(ui.childNodes)) {
          if (node === host) continue;
          if (node.nodeType === 1 && node.hasAttribute
            && (node.hasAttribute('data-sf-battle-hold') || node.hasAttribute('data-sf-battle-underlay'))) continue;
          ui.removeChild(node);
        }
      }
    }
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    const t = T();
    if (t) t.freezeDescendants(view);

    const result = o.result || (window.Sim && Sim.simulate ? Sim.simulate(o.me, o.foe) : null);
    if (!result) throw new Error('SfFight 需要战斗结果');
    rec.result = result;

    // 悬浮掉落必须在 `Sim.simulate()` 之后创建（与现代 `Battle.run` 同一顺序）。
    // `dropRandom`（QA 夹具）只替掉落那一包随机，不会替 Sim 的随机，所以顺序必须一致。
    pickups = (o.collectDrops !== false && (!o.result || o.pickupPlan) && window.BattleDrops)
      ? BattleDrops.create({ root: ui, random: o.dropRandom, kind: o.kind, plan: o.pickupPlan,
        onCollect: o.claimPickup, onError: o.onClaimError, presenter: createDropPresenter(rec) }) : null;
    rec.pickups = pickups;


    const bg = view.byName('backGround');
    const bgFrame = (o.region != null && Number(o.region) >= 0 && Number(o.region) < BG_FRAMES)
      ? Number(o.region) + 1 : (1 + Math.floor(Math.random() * BG_FRAMES));
    stopAt(bg, bgFrame);

    // `fightSub`(4847) = 原版 `loadMcs([["战斗1","fightSub",currentFrame]])`（MainMovie.as:24110）：
    // 落点直接读模板自己的放置矩阵（飘字位置全靠它，不要再拍脑袋写坐标）。
    const sub = view.attachChild(SYM.fightSub, 1, 'fightSub');
    if (sub) {
      const kl = sub.byName('keepFight');
      if (kl) visible(kl, false);
      rec.bloodBase = [0, 1].map((i) => {
        const c = sub.byName(i === 0 ? 'leftBlood' : 'rightBlood');
        const m = String((c && c.g && c.g.__baseMa) || '').split(',').map(Number);
        if (m.length === 6 && m.every((v) => isFinite(v))) return [m[0], m[4], m[5]];
        return i === 0 ? [1.05, 56.25, 62.7] : [1.05, 244.25, 62.7];
      });
      for (const n of ['leftBlood', 'rightBlood']) {
        const c = sub.byName(n);
        if (c && c.frameCount) stopAt(c, c.frameCount());
        // 模板只用来读落点矩阵；真正的飘字是 `floatNumber` 现挂的副本。
        // 模板本身必须藏掉：它停在空档帧只是"看不见"，一旦因为换帧/节拍把它
        if (c) visible(c, false);
      }
      rec.fightSub = sub;
    }

    const sources = [o.me, o.foe];
    const names = sources.map((f, i) => String((f && f.name) || (i ? '对手' : '小松鼠')));
    const hpOf = (f) => Math.max(1, Math.round(Number(f && f.hp) || 1));
    for (let i = 0; i < 2; i++) {
      rec.maxHp[i] = Math.max(hpOf(sources[i]), Math.round(Number(sources[i] && sources[i].maxHp) || 0) || 0);
      rec.hps[i] = Math.min(hpOf(sources[i]), rec.maxHp[i]);
    }
    if (Array.isArray(result.startShell) && result.startShell.length === 2) rec.shields = result.startShell.map((v) => Math.max(0, Math.round(Number(v) || 0)));
    rec.rounds = Array.isArray(result.rounds) ? result.rounds : [];
    // 预取失败不能挡住战斗；真到整蛊那一拍会再试一次。
    if (rec.rounds.some((r) => r && r.petSeal)) { try { await waitSealIcons(1000, rec.skipSignal); } catch (e) {} }

    rec.roundsLeft = Math.max(1, Math.floor(Number(o.maxRounds) || 60));


    const hud = view.byName('blood');
    const winWords = view.byName('winWords');
    stopAt(winWords, winWords && winWords.frameCount ? winWords.frameCount() : 6);
    for (let i = 0; i < 2; i++) {
      const npc = npcTypeOf(sources[i]);
      const campaign = sources[i] && sources[i].campaign ? sources[i].campaign : null;
      rec.fighters[i] = makeFighter(i, buildFighter(view, i, wearsOf(i, sources[i]), npc, campaign, !!(sources[i] && sources[i].mutant)), {
        name: names[i], maxHp: rec.maxHp[i], skills: skillsOf(i, sources[i]),
        weapons: weaponsOf(i, sources[i]),
      });
      const f = rec.fighters[i];
      if (f) { f.blood.totalBlood = rec.maxHp[i]; f.blood.leftBlood = rec.hps[i]; f.blood.finalBlood = rec.hps[i]; }
      // 开打倒计时那几秒里，两个人就该在待机呼吸（原版 `5616` 是一直循环的），
      // 不能像木头一样杵着 —— 见 `startIdlePose`。NPC 的呼吸由图集动画自己起。
      if (f && f.mc && !f.npc && !f.campaign) startIdlePose(f.mc);
      if (f && f.campaign && !startCampaignIdle(f)) startCampaignBreath(rec, f);
    }
    if (hud) {
      // 名字/血量字段在第 8 帧才新建；先在 HUD 上登记真值，节点出生时就带真值。
      if (hud.setPendingText) {
        hud.setPendingText('name1', names[0]);
        hud.setPendingText('name2', names[1]);
        for (let i = 0; i < 2; i++) {
          const f = live && live.fighters[i];
          if (!f) continue;
          const total = Math.max(1, f.blood.totalBlood || 1);
          const left = Math.max(0, Math.min(total, f.blood.leftBlood));
          const shield = Math.max(0, Math.round(Number(live.shields && live.shields[i]) || 0));
          hud.setPendingText('bloodtext' + (i + 1), (left + shield) + '/' + total + ' ');
        }
      }
      applyHudStats(hud, names, { textOnly: true });
      rec.hudReady = playClip(hud, {
        stop: HUD_STOP,
        onFrame: (n) => { if (n >= HUD_STOP && live === rec) showFightInfo(hud, names); },
      });
    }
    rec.hud = hud; rec.names = names;


    addSpeedKey(rec, o);
    // 跳过键显示：系统页 `showSkip` 关闭时 `State.skipButtonEnabled()` 为 false；
    // 老测试桩没有这个入口时退回 `unlockedSkip()`。
    const skipEnabled = !window.State || !State.unlockedSkip
      || (State.skipButtonEnabled ? State.skipButtonEnabled() : State.unlockedSkip());
    if (o.allowSkip !== false && skipEnabled) {

      const topLayer = makeBattleTopLayer(rec, view.g || view);
      const sk = view.attachChild(SYM.skip, 1, 'skip');
      if (sk && sk.g) {
        // 原版 `showSkip()` 是 `attachMovie("跳过","skipmc",100,{_x:0,_y:0})`（不缩放），
        // 这里按自己的中心缩 0.8（不是按原点缩，否则整颗会往左上跑）。
        sk.setExtraTransform('translate(271.5,172.5) scale(0.8) translate(-271.5,-172.5)');
        // 按下回弹）。⚠ 壳只包画稿：`sk.g` 上的 transform 是原版落点，给 g 加
        const NS = 'http://www.w3.org/2000/svg';
        const shell = document.createElementNS(NS, 'g');
        shell.setAttribute('class', 'sf-feedback');
        shell.style.transformBox = 'fill-box';
        shell.style.transformOrigin = 'center';
        const box = t && t.measureHitBox ? t.measureHitBox(sk) : null;
        for (const child of Array.from(sk.g.childNodes)) {
          if (child.nodeType === 1 && String(child.tagName).toLowerCase() === 'defs') continue;
          shell.appendChild(child);
        }
        sk.g.appendChild(shell);
        // 热区不能走 `popWrap` / 点击路由：路由会把 `sk.g` 的 pointer-events 关掉，
        if (box && box.w && box.h) {
          const pad = Math.max(Math.min(box.w, box.h) * 0.04, 2);
          const hit = document.createElementNS(NS, 'rect');
          hit.setAttribute('x', String(box.x - pad));
          hit.setAttribute('y', String(box.y - pad));
          hit.setAttribute('width', String(box.w + pad * 2));
          hit.setAttribute('height', String(box.h + pad * 2));
          hit.setAttribute('fill', 'transparent');
          hit.setAttribute('pointer-events', 'all');

          hit.setAttribute('data-hit', '1');
          sk.g.appendChild(hit);
        }
        sk.g.style.pointerEvents = 'auto';
        sk.g.style.cursor = 'pointer';
        // Chrome 会把按到的 SVG `<g>` 设为 activeElement 并画一圈 UA 蓝色焦点框
        sk.g.style.outline = 'none';
        sk.g.setAttribute('aria-label', '跳过战斗');
        const fireSkip = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          const runSkip = () => { if (rec.controller) rec.controller.skip(true); };
          if (window.SfUiFeedback) SfUiFeedback.tap(sk.g, runSkip, { delay: 0, press: false });
          else runSkip();
        };
        sk.g.addEventListener('click', fireSkip);
        if (window.SfUiFeedback) SfUiFeedback.bind(sk.g, { shell: shell });
        // 移到最上层覆盖 SVG：图集 canvas 是 HTML 层，按 DOM 顺序会盖住主 SVG 里的跳过键。
        if (topLayer) topLayer.appendChild(sk.g);
        rec.skipSprite = sk;
      }
    }

    const controller = {
      result: result,
      cancel() { rec.stopped = true; clean(); },
      skip(byButton) {
        if (rec.settling || rec.skipped || rec.stopped) return;
        rec.skipped = true;
        rec.skippedByButton = !!byButton;

        if (rec.countdown) {
          const cd = rec.countdown;
          rec.countdown = null;
          try { if (cd.stop) cd.stop(); } catch (e) {}
        }
        if (rec.wakeSkip) { const wake = rec.wakeSkip; rec.wakeSkip = null; wake(); }

        if (pickups) pickups.skip(!!byButton);
        for (const wake of [...rec.sleepers]) wake();
      },
    };
    rec.controller = controller;

    if (pickups) {
      let last = (window.performance && performance.now) ? performance.now() : Date.now();
      const pump = (now) => {
        if (rec.stopped) return;
        const dt = Math.min(100, Math.max(0, now - last)) * rec.speed;
        last = now;
        if (!rec.settling && !rec.skipped && !document.hidden) { try { pickups.tick(dt); } catch (e) {} }
        rec.rafs.push(raf(pump));
      };
      rec.rafs.push(raf(pump));
    }
    perform(rec, o, result, controller).catch((error) => {

      if (window.__errs) window.__errs.push('[SfFight] ' + (error && (error.stack || error.message)));
      controller.cancel();
      console.error('[sf-fight]', error);
      if (o.onError) o.onError(error);
    });
    return controller;
  }


  function addSpeedKey(rec, o) {
    if (o.speedToggle === false) return;
    if (window.State && State.unlockedSpeed && !State.unlockedSpeed()) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', '切换战斗速度（当前 ' + rec.speed + '×）');
    b.textContent = rec.speed + '×';
    b.style.cssText = 'position:absolute;left:16px;bottom:15px;width:150px;height:64px;padding:0;' +
      'border:0;background:transparent;color:transparent;cursor:pointer;pointer-events:auto;z-index:20;';
    rec.host.appendChild(b);
    rec.speedButton = b;
    b.onclick = () => {
      const max = Math.max(1, Math.min(3, Math.floor(Number(o.speedMax) || 2)));
      rec.speed = rec.speed >= max ? 1 : rec.speed + 1;
      b.textContent = rec.speed + '×';
      b.setAttribute('aria-label', '切换战斗速度（当前 ' + rec.speed + '×）');
    };
  }



  function hideFightKeys(rec) {
    if (rec.skipSprite) {
      const g = rec.skipSprite.g || rec.skipSprite;
      if (g && g.parentNode) g.parentNode.removeChild(g);
      rec.skipSprite = null;
    }
    if (rec.speedButton) { try { rec.speedButton.remove(); } catch (e) {} rec.speedButton = null; }
    // 顶层覆盖 SVG 只是跳过键的宿主；键收掉后空壳也必须一起收掉。
    if (rec.topLayer) {
      const top = rec.topLayer;
      try {
        if (top.parentNode) top.parentNode.removeChild(top);
        else if (top.remove) top.remove();
      } catch (e) {}
      rec.topLayer = null;
      if (rec.topLayerRO) { try { rec.topLayerRO.disconnect(); } catch (e) {} rec.topLayerRO = null; }
      if (rec.topLayerRelayout && window.removeEventListener) {
        window.removeEventListener('resize', rec.topLayerRelayout);
        rec.topLayerRelayout = null;
      }
    }
  }
  // 开打倒计时「3 → 2 → 1 → GO」—— 原版那颗 `3750`，不是另造的过场
  // 接在"血条滑进来之后、第一拍之前"——与 `playRound` 的顺序天然一致。
  // ⚠ 复刻以前另造了一颗 `gocd`（按 H5 客户端 `assets.js` 的 go 图集裁 4 帧）挂在场景中央，
  const COUNTDOWN_TAG = '3750';
  const COUNTDOWN_END = 30;

  function clipByTag(clip, id, depth) {
    if (!clip || depth > 12) return null;
    if (clip.tag && String(clip.tag.id) === String(id)) return clip;
    for (const rec of clip.nodes ? clip.nodes.values() : []) {
      const hit = rec && rec.clip ? clipByTag(rec.clip, id, depth + 1) : null;
      if (hit) return hit;
    }
    for (const c of clip.__attached || []) {
      const hit = clipByTag(c, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  async function playHudCountdown(rec, aborted) {
    if (!rec.hud) return;
    const clip = clipByTag(rec.hud, COUNTDOWN_TAG, 0);
    if (!clip || !clip.gotoAndPlay) return;
    rec.countdown = clip;

    await playClip(clip, { stop: COUNTDOWN_END });
    if (rec.countdown === clip) rec.countdown = null;
    void aborted;
  }


  function onlyChildClip(clip) {
    if (!clip || !clip.nodes) return null;
    for (const rec of clip.nodes.values()) if (rec && rec.clip) return rec.clip;
    return null;
  }
  // `fight.winWords.gotoAndStop(1|2)` —— 并把里面那段字播出来。
  // 从第 1 帧开始播（Flash 嵌套 clip 自动播），复刻里所有 clip 都被冻结、必须显式播 ——
  function showWinWords(ww, winner) {
    if (!ww) return;
    stopAt(ww, winner === 0 ? 1 : 2);
    const inner = onlyChildClip(ww);
    if (inner) playClip(inner);
  }

  async function perform(rec, o, result, controller) {
    const aborted = () => rec.stopped || rec.skipped;
    // 开打倒计时（3 → 2 → 1 → GO）：原版那一颗就在血条 HUD 第 8 帧里（见 `playHudCountdown`），
    // ⚠ 两段前奏都和 `rec.skipSignal` 赛跑：玩家按跳过时倒计时/血条不等它们播完，
    if (rec.hudReady) {
      try { await Promise.race([rec.hudReady, rec.skipSignal]); } catch (e) {}
    }
    if (!aborted()) await Promise.race([playHudCountdown(rec, aborted), rec.skipSignal]);
    for (let i = 0; i < rec.rounds.length && !aborted(); i++) {
      rec.round = Math.max(0, 99 - i);
      // 涅槃加时（`Sim` 在 60 手判负前复活玩家）：这一拍之后是新的 60 手窗口，
      // 剩余回合要重新从满格开始走，否则玩家会看到「回合已经 0 了还在打」。
      if (rec.rounds[i] && rec.rounds[i].timeoutRevive) {
        rec.roundsLeft = Math.max(1, Math.floor(Number(o.maxRounds) || 60));
      }

      if (!rec.rounds[i] || Number(rec.rounds[i].isRound) !== 0) rec.roundsLeft = Math.max(0, rec.roundsLeft - 1);
      if (rec.hud) refreshBlood(rec.hud);
      await playRound(rec, rec.rounds[i], aborted);
    }
    if (rec.stopped) return;

    const last = [...rec.rounds].reverse().find((r) => r && Array.isArray(r.hpAfter) && r.hpAfter.length === 2);
    result.hpAfter = last ? [Math.max(0, last.hpAfter[0]), Math.max(0, last.hpAfter[1])] : null;
    const winner = Number(result.winner) === 1 ? 1 : 0;
    // ⚠ 原版 `congratulate()`（:6468）与 `clearFrames()`（:15626）都有一句
    hideFightKeys(rec);
    if (!rec.skipped) {
      const loser = 1 - winner;
      const loserF = rec.fighters[loser], winnerF = rec.fighters[winner];
      // 两个格斗者没建出来（素材包缺件 / 挂载失败）时不能卡在这里 —— 直接进战果页，
      // 让结算照常走完（宁可少一段演出，也不能让玩家打完一场却拿不到结算）。
      rec.phase = 'ending';
      // 倒地多半已经在本回合"血见底"那一刻起过了（见 `playRound` 的 `impact`）——
      // 这里只补没起过的。⚠ `dead()` 是方法、恒为真，判"演过没有"要问 `isDead()`。
      if (loserF && !loserF.isDead()) await loserF.dead(0);

      if (!aborted()) {
        showWinWords(rec.view && rec.view.byName('winWords'), winner);
        if (winnerF) await winnerF.congratulate();
      }
      if (!aborted()) await wait(700);
    }
    if (rec.stopped) return;
    rec.settling = true;
    rec.phase = 'result';

    if (rec.pickups && rec.pickups.flush) await rec.pickups.flush();
    const loot = rec.pickups ? rec.pickups.summary() : { items: [], ups: [] };

    if (rec.pickups) { try { rec.pickups.close(); } catch (e) {} }
    result.skipped = !!rec.skippedByButton;
    if (loot.items && loot.items.length) result.pickups = loot.items;
    // 结算方可以在战果页出现之前把这一场的经验 / 金松果算出来（`rewardFor`），
    // 挑战页传的就是 `State.fightReward`；算过一次后调用方自己缓存，`onEnd` 不会重复扣/发。
    let reward = null;
    if (typeof o.rewardFor === 'function') {
      try { reward = o.rewardFor(winner); } catch (e) {
        if (window.__errs) window.__errs.push('SfFight rewardFor: ' + (e && (e.stack || e.message) || e));
      }
    }

    // 经典塔：胜利后不要原版战果 CG 停一下，直接交给塔的结算/下一场；
    const hideVictoryCg = !!(o.hideVictoryCg && winner === 0);
    if (!hideVictoryCg) showResultPanel(rec, o, result, winner, loot, reward);

    if (!hideVictoryCg && !o.skipResultPanel) await wait(1500);
    if (rec.stopped || live !== rec) return;

    if ((rec.pickups || typeof o.claimChest === 'function') && !rec.o.skipChest) await openChest(rec, loot);
    if (rec.stopped) return;
    rec.finished = true;
    rec.stopped = true;
    clean();
    if (o.onEnd) o.onEnd(winner, result, loot, reward);
  }

  // 把练功木桩这一拍欠下的回血补上（见 `playRound` 开头那段说明）。
  // 必须等这一拍的终值 `applyHp(rec, r, { final: true })` 写完再调。
  // ⚠ 只补血条、不飘绿字：绿字会反复盖住/挤走这一拍的红伤害数字
  function settlePractice(rec) {
    const p = rec && rec.practicePending;
    if (!p) return;
    rec.practicePending = null;
    if (rec.hud) refreshBlood(rec.hud);
  }

  async function playRound(rec, r, aborted) {
    if (!r) return;
    rec.curRound = r;

    if (!r.stripApplied) syncStrip(rec, r);
    const att = Number(r.attacker) === 1 ? 1 : 0, def = 1 - att;
    // `attack(round)` 开头会把两侧都归位（`attacker.gotoAndStop(1)` / `defender.gotoAndStop(1)`，
    // ⚠ 这正是"方天画戟没有准备的前摇回合"的根因：Sim 明明推了一拍
    for (const side of [att, def]) {
      const f = rec.fighters[side];
      if (f) f.idle();
    }

    settlePractice(rec);
    const practiceHeal = Math.max(0, Number(r.practiceHeal) || 0);
    if (practiceHeal > 0) rec.practicePending = { def: def, heal: practiceHeal, shown: false };
    if (r.action === 'dot' || r.action === 'buff' || r.action === 'regen' || r.action === 'rest' || r.action === 'stunned') {
      applyHp(rec, r);
      if (r.dmg) floatNumber(r.selfDot ? att : def, r.dmg, 'dot');
      if (r.heal) floatNumber(att, r.heal, 'heal');
      if (rec.hud) refreshBlood(rec.hud);

      let beat = r.action === 'dot' ? 400 : r.action === 'buff' ? 320 : r.action === 'regen' ? 420 : 0;
      if (r.action === 'rest' && Number(r.preparingWeapon) > 0) {

        const who = rec.fighters[att];
        if (who) {
          await who.attack(r, {});
          if (aborted()) return;
        }
        beat = 0;
      } else if (r.action === 'stunned') {
        // 眩晕：不播 6067 —— 那一段的气泡画的是"在想一把方天画戟"，
        // 原版客户端对 attackType 0 只认 6067 一段，但它那套里根本没有眩晕的图形 ——
        const who = rec.fighters[att];
        if (who) { who.setStatu(4); who.specialEffect(); }
        beat = 700;
      }
      await wait(beat || ROUND_GAP);
      return;
    }
    const attacker = rec.fighters[att];
    const defender = rec.fighters[def];
    if (!attacker || !defender) { applyHp(rec, r); await wait(300); return; }
    let sealCard = null;
    if (r.action === 'pet' && r.petSeal) {
      if (!sealIcons) { try { await waitSealIcons(800, rec.skipSignal); } catch (e) {} }
      sealCard = showSealCard(rec, r.petSeal, def);
    }

    // ⚠ 出手这一拍原版只按 `currentRound.specialEffectType` 给受击方拨状态图标
    defender.setStatu(effectStatu(r));

    const acts = ATTACK_ACTS[attackPlan(r).frame] || {};
    let hit = false, guarded = false, healed = false;
    let defend = null, back = null;
    // 归位 / 反击：原版是受击动画自己在 `_root.attackBack()` 那一帧起手的
    // · 否则 `canBeAttackBack == "true"` → 出手方播归位动画 `comeBack(0)`。
    // ⚠ `Sim` 给普通攻击的动作名是 `'common'`（`sim.js` 的 `r.action = 'common'`），
    const normalAttack = r.action === 'common' || r.action === 'attack';
    const canBack = normalAttack || (r.action === 'weapon' && !RANGED.has(Number(r.id)));
    const startBack = () => {
      if (back || aborted()) return;
      if (r.counterDmg || r.counterFakeDie || r.counterRebound || r.counterBlocked) {
        back = runCounter(rec, r, att, def, attacker, defender, aborted);
        return;
      }
      // ⚠ 出手动画的末帧是留在对面身边的（`5630` 第 17 帧把静止姿势 `5616` 摆在
      if (canBack) back = attacker.comeBack(0);
    };
    // 命中那一拍（`_root.beAttack()`）：扣血 + 飘字 + 血条，并让受击方起手。
    // `via` 只做取证：`'hook'` = 出手动画放到命中帧（正常路径，及时）；
    const impact = (via) => {
      if (hit || aborted()) return;
      hit = true;
      rec.impactVia = via || 'hook';
      // 防御技（绝对防御 16 / 龟甲术 7）的起手：照现代播放器，落在挨打那一刻
      // 原版客户端是出手动画第 3~25 帧的帧脚本提前调 `_root.useSkillDefense()`（`ATTACK_ACTS.guard`），
      if (!guarded) guarded = defender.useSkillDefense(r);
      // 这一拍如果还带着反击，先把血条停在「主攻击命中后、反击结算前」：
      // "敌人触发反击的时候，扣血条的显示与动画同步，不要提前触发扣血条的显示"。
      applyHp(rec, r, { beforeCounter: true });

      const shownDmg = (Number(r.dmg) || 0) + (Number(r.shellAbsorb) || 0);
      if (shownDmg && !r.dodge) {

        if (!(Number(r.boomCount) > 1 && boomSplit(rec, attacker, r, def, aborted, shownDmg))) {
          floatNumber(def, shownDmg, r.crit ? 'berserk' : 'hit');
        }
      }
      if (r.healSelf) floatNumber(att, r.healSelf, 'heal');

      if (r.dodgeHeal) floatNumber(def, r.dodgeHeal, 'heal');
      if (r.lifesteal) floatNumber(att, r.lifesteal, 'heal');
      if (r.reboundHurt) floatNumber(att, r.reboundHurt, 'back');
      if (r.selfBurn) floatNumber(att, r.selfBurn, 'back');
      if (rec.hud) refreshBlood(rec.hud);

      if (rec.hps[def] <= 0 && !r.fakeDie && !defender.isDead()) {
        defend = defender.dead(0);

        if (canBack) back = wait(500).then(() => (aborted() || attacker.isDead() ? null : attacker.comeBack(0)));
      } else {
        defend = defender.beAttack(r, { guarded: guarded, back: startBack });
      }
      defender.specialEffect();
    };

    const onHeal = () => {
      if (healed || aborted()) return;
      healed = true;
      applyHp(rec, r);
      if (r.healSelf) floatNumber(att, r.healSelf, 'heal');
      if (rec.hud) refreshBlood(rec.hud);
    };

    await attacker.attack(r, { heal: onHeal, hit: () => impact('hook') });

    if (!hit && !aborted()) {
      if (acts.hit) impact('fallback');
      else { applyHp(rec, r, { final: true }); settlePractice(rec); if (rec.hud) refreshBlood(rec.hud); }
    }
    if (defend) await defend;

    if (!aborted() && r.fakeDie && Number(r.fakeDieSide == null ? def : r.fakeDieSide) === att
      && rec.hps[att] > 0 && !attacker.isDead()) {
      await attacker.beAttack({ fakeDie: true, fakeDieSide: att });
    }
    if (back) await back;
    if (aborted()) return;
    applyHp(rec, r, { final: true });
    settlePractice(rec);
    // ⚠ 收尾的这次 `applyHp` 也必须重画血条：以前只写 `rec.hps` / `blood.leftBlood`，
    if (rec.hud) refreshBlood(rec.hud);

    const fakeSide = r.fakeDie ? Number(r.fakeDieSide == null ? def : r.fakeDieSide) : -1;
    if (!attacker.isDead() && att !== fakeSide) attacker.idle();
    if (!defender.isDead() && def !== fakeSide) defender.idle();

    // 武技卡要停够一眼能看清的时间；原版锁定后整场都不能再用，值得多给这一拍。
    if (sealCard) {
      await wait(900);
      fadeSealCard(rec, sealCard);
    }
    await wait(ROUND_GAP);
  }

  // `attackBack()` + `beBttackBack()`：反击那一路（`Squirrel.as:369` / `MainMovie.as:6418`）。
  // 原版顺序：受击方的 `attackback`(6516) 放到第 5 帧 → 出手方 `reduceBlood(harmToSelf, 5)`
  // ⚠ 0 伤害的反击也不能播「被闪避」（2026-11-06 用户反馈，无尽塔 1.1.5 实拍，同步单机版）：
  async function runCounter(rec, r, att, def, attacker, defender, aborted) {
    let done = false, reaction = null, reactionStarted = false;

    const startReaction = () => {
      if (reactionStarted || aborted()) return;
      reactionStarted = true;
      if (r.counterFakeDie) {
        const who = r.counterFakeDieSide == null ? att : Number(r.counterFakeDieSide);
        if (who === att) {
          const f = rec.fighters[who];
          if (f && !f.isDead()) reaction = f.beAttack({ fakeDie: true, fakeDieSide: who });
        }
        return;
      }

      if (rec.hps[att] <= 0 && !attacker.isDead()) { reaction = attacker.dead(1); return; }
      // 反击不可闪避：0 伤害只可能是被护盾/龟甲术挡住，绝不能用 `comeBack(2)`
      if (!attacker.isDead()) reaction = attacker.comeBack(1);
    };
    const settle = () => {
      if (done || aborted()) return;
      done = true;
      applyHp(rec, r);

      const shown = (Number(r.counterDmg) || 0) + (Number(r.counterAbsorb) || 0);
      if (shown) floatNumber(att, shown, 'back');
      if (r.counterRebound) floatNumber(def, r.counterRebound, 'back');
      if (rec.hud) refreshBlood(rec.hud);
      startReaction();
    };
    await defender.attackBack({ hit: settle });
    settle();
    if (reaction) await reaction;
    if (aborted()) return;
    if (r.counterFakeDie) {
      const who = r.counterFakeDieSide == null ? att : Number(r.counterFakeDieSide);
      if (who === att) return;
      const f = rec.fighters[who];
      if (f && !f.isDead()) await f.beAttack({ fakeDie: true, fakeDieSide: who });
      return;
    }

    if (rec.hps[att] <= 0 && !attacker.isDead()) { await attacker.dead(1); return; }
  }


  function applyHp(rec, r, opts) {
    if (Array.isArray(r.shellAfter) && r.shellAfter.length === 2) {
      for (let i = 0; i < 2; i++) rec.shields[i] = Math.max(0, Math.round(Number(r.shellAfter[i]) || 0));
    }
    if (Array.isArray(r.maxHp) && r.maxHp.length === 2) {
      for (let i = 0; i < 2; i++) {
        const next = Math.max(1, Math.round(Number(r.maxHp[i]) || rec.maxHp[i]));
        if (next < rec.maxHp[i]) { rec.maxHp[i] = next; if (rec.fighters[i]) rec.fighters[i].blood.totalBlood = next; }
      }
    }
    if (Array.isArray(r.hpAfter) && r.hpAfter.length === 2) {
      const att = Number(r.attacker) === 1 ? 1 : 0;
      const deferCounter = !!(opts && opts.beforeCounter) &&
        !!(r.counterDmg || r.counterFakeDie || r.counterRebound || r.counterThorns || r.counterBlocked);
      for (let i = 0; i < 2; i++) {
        let v;
        if (deferCounter) {

          const before = Math.max(0, Number(rec.hps[i]) || 0);
          if (i === att) {
            v = before + (Number(r.healSelf) || 0) + (Number(r.lifesteal) || 0)
              - (Number(r.selfBurn) || 0) - (Number(r.reboundHurt) || 0)
              - (Number(r.thornsDmg) || 0);
          } else {
            v = before - (Number(r.dmg) || 0);
          }
        } else {
          v = Number(r.hpAfter[i]) || 0;
        }

        const pend = rec.practicePending;
        if (pend && i === pend.def && !(opts && opts.final) && !pend.shown) {
          const total = Math.max(1, rec.maxHp[i] || 1);
          const before = Math.max(0, Number(rec.hps[i]) || 0);
          const applied = Math.max(0, Math.min(total, before + pend.heal) - before);
          v = Math.max(1, Math.min(total, v - applied));
          pend.shown = true;
        }
        v = Math.max(0, Math.min(rec.maxHp[i], v));
        rec.hps[i] = v;
        if (rec.fighters[i]) rec.fighters[i].blood.leftBlood = v;
      }
    }
  }

  // 逐条照 `MainMovie.as:18703-18848`。帧里的具名元件（导出实测）：
  // f2 =「您的等级已达上限，无法获得经验。」/ f3 = 增益提示 / f4 = 不带文案）
  // ⚠ 数字要写进 `num.num`（4315 才是那排位图数字）而不是 `num`（4843 是它的外壳）：
  function showResultPanel(rec, o, result, winner, loot, reward) {
    const view = rec.view;
    if (!view) return;

    for (const f of rec.fighters) {
      if (!f || !f.holder) continue;

      if (f.hide) { try { f.hide(); } catch (e) {} }
      const last = f.holder.frameCount ? f.holder.frameCount() : 8;
      stopAt(f.holder, last);
    }
    for (let i = 0; i < 2; i++) {
      const f = rec.fighters[i];
      if (f) f.blood.finalBlood = rec.hps[i];
    }
    stopAt(view, winner === 0 ? F.win : F.lose);
    const backgd = view.byName('backgd'); if (backgd) stopAt(backgd, winner === 0 ? 1 : 2);
    const prizeBackg = view.byName('prizeBackg');
    const getExp = view.byName('getExp');
    const maxlevel = view.byName('maxlevel');
    const shoutu = view.byName('shoutu');
    const t = T();

    const rewardExp = reward && reward.exp != null ? reward.exp : null;
    const expKnown = rewardExp != null || o.expGain != null || result.exp != null;
    const exp = Math.max(0, Math.round(Number(rewardExp != null ? rewardExp
      : (o.expGain != null ? o.expGain : (result.exp || 0))) || 0));
    let gained = 0;
    if (getExp) {
      if (exp > 0) {
        stopAt(getExp, 1);

        const digits = getExp.byName ? getExp.byName('exp') : null;
        if (t && digits) t.showNumber(exp, digits, 0, 0, 0);
        gained++;
      } else stopAt(getExp, 3);
    }
    // `maxlevel` 的每一帧都烤着一条具体文案（f1 说的是"本关经验已在上次掉线前获得"）——
    // 只有真的知道"这一场经验是 0"时才敢用 f1/f2，否则一律走 f4（不带文案），
    if (maxlevel) stopAt(maxlevel, exp > 0 || !expKnown ? 4 : 1);
    if (shoutu) stopAt(shoutu, 3);
    // 奖励格：金松果（结算 + 战斗中飘到的合并）+ 本场悬浮物品。
    // 负场（frame 3）没有 `c2/num1`，按当前帧真的存在的格子依次摆，不能因为缺一格
    const items = (loot && loot.items) || [];
    let gold = Math.max(0, Math.round(Number(reward && reward.gold) || 0));
    const picks = [];
    for (const item of items) {
      if (!item || item.id == null) continue;
      const count = Math.max(1, Math.round(Number(item.count) || 1));
      if (Number(item.id) === 8) { gold += count; continue; }
      picks.push({ id: item.id, name: item.name, count });
    }
    const rewards = [];
    // 竞技场冠军的金杯和飘到的战利品同格显示：金杯走原版 3061（2015 卡面 + 本体），
    // 不再写进底部正文（正文在经验数字下面会互相压住，且只有文字没有图标）。
    const cup = Math.max(0, Math.round(Number(reward && reward.goldCup) || 0));
    if (cup > 0) rewards.push({ id: 40, name: '金杯', count: cup });
    if (gold > 0) rewards.push({ id: 8, name: '金松果', count: gold });
    rewards.push(...picks);
    const cells = [['c1', 'num'], ['c2', 'num1'], ['c3', 'num3']];
    const slots = cells.map(([cellName, numName]) => ({ cell: view.byName(cellName), num: view.byName(numName) }))
      .filter((slot) => slot.cell);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i], it = rewards[i];
      if (slot.cell) stopAt(slot.cell, it ? 1 : 2);
      if (slot.num) visible(slot.num, !!it);
      if (it && slot.num) {
        const digits = slot.num.byName ? slot.num.byName('num') : null;
        const sign = slot.num.byName ? slot.num.byName('addOrReduce') : null;
        if (sign) stopAt(sign, 2);
        if (t && digits) t.showNumber(Math.max(1, Math.round(Number(it.count) || 1)), digits, 0, 0, 0);
      }

      if (it && slot.cell && slot.cell.detachAll) { slot.cell.detachAll(); attachLootIcon(slot.cell, it); }
      if (it) gained++;
    }

    const note = String(o.resultNote || '').trim();
    if (note && typeof document !== 'undefined' && document.createElementNS) {
      if (prizeBackg) stopAt(prizeBackg, 1);
      const NS = 'http://www.w3.org/2000/svg';
      const wrap = document.createElementNS(NS, 'g');
      wrap.setAttribute('class', 'sf-result-note');
      const text = document.createElementNS(NS, 'text');
      const compact = gained > 0;
      text.setAttribute('x', '16');
      text.setAttribute('y', compact ? '56' : '92');
      text.setAttribute('font-family', 'SimHei,Microsoft YaHei,sans-serif');
      text.setAttribute('font-size', compact ? '10' : '13');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('fill', '#683b1a');
      text.textContent = note;
      wrap.appendChild(text);
      view.g.appendChild(wrap);
    } else if (prizeBackg && gained === 0) stopAt(prizeBackg, 2);
  }

  // 逐条照 `MainMovie.as:18595-18702`，元件结构照导出实测：
  // 奖品分配照原版：先 `lotArray.shift()` 取第一件给选中的那一格，其余按格子顺序
  // · 收尾（state 5）：按一下 fire → `setState(2)`（复刻这边等价于点任意位置 / 超时）。
  // 宝箱四选一的稳定热区层（2026-10 修复 iOS 点第二个及以后箱子没反应）。
  // 原实现把 `mouseenter` / `click` 直接挂在四颗 `k`(7767) 的 `<g>` 上。iOS 的轻点会先合成
  // `k` 的子元件 —— 触点下的 DOM 在事件派发中途被换掉，WKWebView 有时就不再补发 click：
  function mountChestHitLayer(view, keys, handlers) {
    const svg = view && (view.g || view.el);
    if (!svg || !svg.ownerDocument || typeof svg.appendChild !== 'function') return null;
    const NS = 'http://www.w3.org/2000/svg';
    let map = null;
    try { map = window.SfRender && SfRender.svgScreenMap ? SfRender.svgScreenMap(svg) : null; } catch (e) { map = null; }
    let box = null;
    try { box = svg.viewBox && svg.viewBox.baseVal; } catch (e) { box = null; }
    if (!box || !(box.width > 0) || !(box.height > 0)) box = { x: 0, y: 0, width: 320, height: 196 };
    const toUser = (cx, cy) => {
      if (map && map.toUser) return map.toUser(cx, cy);
      const r = svg.getBoundingClientRect();
      const s = Math.min(r.width / box.width, r.height / box.height) || 1;
      const ox = r.left + (r.width - box.width * s) / 2;
      const oy = r.top + (r.height - box.height * s) / 2;
      return { x: box.x + (cx - ox) / s, y: box.y + (cy - oy) / s };
    };
    const layer = document.createElementNS(NS, 'g');
    layer.setAttribute('class', 'sf-chest-hits');
    // `getBoundingClientRect()` 在个别 iOS 首帧还没布局时会返回 0；这里按 7771 第 1 帧
    const FALLBACK = [
      { x: 28.85, y: 75.78, w: 65.69, h: 87.87 },
      { x: 94.75, y: 75.78, w: 65.69, h: 75.10 },
      { x: 160.55, y: 75.78, w: 65.69, h: 75.10 },
      { x: 226.40, y: 75.78, w: 65.69, h: 75.10 },
    ];
    const hits = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k || !k.g) continue;
      let r = null;
      try { r = k.g.getBoundingClientRect(); } catch (e) { r = null; }
      let x = 0, y = 0, w = 0, h = 0;
      if (r && r.width > 0 && r.height > 0) {
        const a = toUser(r.left, r.top), b = toUser(r.right, r.bottom);
        x = Math.min(a.x, b.x) - 3; y = Math.min(a.y, b.y) - 3;
        w = Math.abs(b.x - a.x) + 6; h = Math.abs(b.y - a.y) + 6;
      }
      if (w <= 2 || h <= 2) {
        const f = FALLBACK[i];
        x = f.x; y = f.y; w = f.w; h = f.h;
      }
      const hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('x', x.toFixed(2));
      hit.setAttribute('y', y.toFixed(2));
      hit.setAttribute('width', w.toFixed(2));
      hit.setAttribute('height', h.toFixed(2));
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('pointer-events', 'all');
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label', '选择第' + (i + 1) + '个宝箱');
      hit.style.cursor = 'pointer';
      hit.style.outline = 'none';
      hit.style.webkitTapHighlightColor = 'transparent';
      layer.appendChild(hit);
      hits.push({ hit: hit, index: i });
    }
    if (!hits.length) return null;
    svg.appendChild(layer);
    let down = null, touch = null;
    const pick = (i, event) => {
      if (event) {
        if (event.stopPropagation) event.stopPropagation();
        if (event.cancelable && event.type !== 'keydown') { try { event.preventDefault(); } catch (e) {} }
      }
      if (handlers && typeof handlers.pick === 'function') handlers.pick(i);
    };
    for (const { hit, index } of hits) {
      hit.addEventListener('pointerenter', () => {
        if (handlers && typeof handlers.hover === 'function') handlers.hover(index);
      });
      hit.addEventListener('pointerdown', (event) => {
        if (event.button != null && event.button !== 0) return;
        down = { id: event.pointerId, x: event.clientX, y: event.clientY, t: Date.now() };
      });
      hit.addEventListener('pointerup', (event) => {
        if (!down) return;
        if (down.id != null && event.pointerId != null && down.id !== event.pointerId) return;
        const dx = event.clientX - down.x, dy = event.clientY - down.y;
        const moved = Math.sqrt(dx * dx + dy * dy), dt = Date.now() - down.t;
        down = null;
        if (moved <= 14 && dt <= 900) pick(index, event);
      });
      hit.addEventListener('pointercancel', () => { down = null; });
      hit.addEventListener('touchstart', (event) => {
        const t = event.changedTouches && event.changedTouches[0];
        if (t) touch = { x: t.clientX, y: t.clientY, t: Date.now() };
      }, { passive: true });
      hit.addEventListener('touchend', (event) => {
        const t = event.changedTouches && event.changedTouches[0];
        if (!t || !touch) return;
        const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
        const moved = Math.sqrt(dx * dx + dy * dy), dt = Date.now() - touch.t;
        touch = null;
        if (moved <= 14 && dt <= 900) pick(index, event);
      }, { passive: false });
      hit.addEventListener('touchcancel', () => { touch = null; });
      hit.addEventListener('click', (event) => pick(index, event));
      hit.addEventListener('keydown', (event) => {
        if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); pick(index, event); }
      });
    }
    return {
      remove: () => { if (layer.parentNode) layer.parentNode.removeChild(layer); },
    };
  }

  async function openChest(rec, loot) {
    const view = rec.view;
    if (!view) return;
    const winner = Number(rec.result && rec.result.winner) === 1 ? 1 : 0;
    stopAt(view, F.chest);
    const chest = view.byName('openChest');
    if (!chest) return;

    stopAt(chest, 1);

    if (winner === 1) {
      try {
        const root = view.g || view.el;
        const imgs = root && root.querySelectorAll ? root.querySelectorAll('image') : [];
        for (const img of imgs) {
          const href = img.getAttribute('href') || img.getAttribute('xlink:href') || '';
          if (href.indexOf('7748_0') < 0) continue;
          img.setAttribute('href', 'images/ssfight/ui/bitmap/7741_0.hd.jpg');
          img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'images/ssfight/ui/bitmap/7741_0.hd.jpg');
        }
      } catch (e) {
        if (window.__errs) window.__errs.push('chest defeat bg: ' + (e && (e.stack || e.message) || e));
      }
    }
    const keys = [1, 2, 3, 4].map((i) => chest.byName('k' + i));
    const boards = [1, 2, 3, 4].map((i) => chest.byName('b' + i));
    const text0 = chest.byName('text0');

    let sel = 0;
    const paint = () => keys.forEach((k, i) => { if (k) stopAt(k, i === sel ? 2 : 1); });
    paint();
    await wait(260);
    if (rec.stopped) return;
    // `phase = 'chest'` 要在箱子可点之后才置位：`pickChest` 靠 `rec.chestPick` 生效，
    // 提前置位会让探针在"还不能点"的那 260ms 里点到空气（第一次跑就是这么挂的）。
    rec.phase = 'chest';
    let picked, serverPrize = null;
    do {
      picked = await new Promise((resolve) => {
      let done = false, layer = null;
      const finish = (i) => {
        if (done) return;
        done = true;
        if (layer) layer.remove();
        resolve(Math.max(0, Math.min(3, Number(i) || 0)));
      };

      layer = mountChestHitLayer(view, keys, {
        hover: (i) => { if (!done && i !== sel) { sel = i; paint(); } },
        pick: (i) => finish(i),
      });
      rec.chestPick = finish;
      });
      rec.chestPick = null;
      if (rec.stopped) return;
      if (rec.o && rec.o.claimChest) {
        if (text0) setText(text0, '正在领取…');
        try {
          serverPrize = await rec.o.claimChest(picked);
          if (rec.stopped || live !== rec) return;
          if (!serverPrize || !Array.isArray(serverPrize.items) || serverPrize.items.length !== 4 ||
            !Number.isInteger(serverPrize.picked) || serverPrize.picked < 0 || serverPrize.picked > 3) throw new Error('服务器宝箱数据不完整');
          picked = serverPrize.picked;
          rec.claimResponse = serverPrize;
        } catch (e) {
          if (rec.stopped || live !== rec) return;
          serverPrize = null;
          if (text0) setText(text0, '领取未完成，请再选一次重试');
          if (rec.o.onClaimError) rec.o.onClaimError(e);
        }
      }
    } while (rec.o && rec.o.claimChest && !serverPrize && !rec.stopped);
    if (rec.stopped) return;

    // 每一条都要各自停在自己的末帧（导出里没有帧动作，`stop()` 得由这里补）：
    // ⚠ `7769` 的第 5/6 帧是空帧：`playClip` 的缺省停帧会按 `lastContentFrame` 停到第 4 帧，
    for (const b of boards) if (b) playClip(b, { stop: 5 });
    const opening = [];
    keys.forEach((k, i) => {
      if (!k) return;
      stopAt(k, i === picked ? 2 : 1);
      const inner = k.byName('k');
      if (inner) opening.push(playClip(inner, { stop: 10 }));
    });
    // 选中的那颗 `7765` 停在第 10 帧时，帧脚本就是 `_root.showLottery2()` —— 四颗一样长，
    // ⚠ 兜底：`playClip` 靠 rAF 观察帧号；iOS WKWebView 在触摸/合成层切换时可能长时间
    // 一个 2.5s 上限，超时后显式把四颗 k 停到第 10 帧（奖品槽那一帧），照常揭晓。
    let opened = true;
    if (opening.length) {
      opened = await Promise.race([
        Promise.all(opening).then(() => true),
        wait(2500).then(() => false),
      ]);
    } else {
      await wait(900);
    }
    if (rec.stopped) return;
    if (!opened) {
      for (let i = 0; i < keys.length; i++) {
        const inner = keys[i] && keys[i].byName ? keys[i].byName('k') : null;
        if (inner && inner.frameCount) stopAt(inner, Math.min(10, inner.frameCount()));
      }
    }

    // ⚠ 原版这四格的内容是服务端 `flash/lottery.do` 下发的 `fightResult.lotArray`
    stopAt(chest, 2);
    const revealedKeys = [1, 2, 3, 4].map(i => chest.byName('k' + i));
    const revealedText = chest.byName('text0');
    for (let i = 1; i <= 4; i++) {
      const board = chest.byName('b' + i); if (board) stopAt(board, 5);
    }
    const items = serverPrize
      ? [serverPrize.items[picked], ...serverPrize.items.filter((_, i) => i !== picked)]
      : planChestPrizes(rec.o ? rec.o.kind : 'challenge', rec.o ? rec.o.dropRandom : null, loot.items);
    const first = items[0] || null;
    let rest = items.slice(1);
    let label = '';
    if (revealedText) setText(revealedText, '恭喜你获得');
    for (let i = 0; i < revealedKeys.length; i++) {
      const k = revealedKeys[i];
      if (!k) continue;
      const isPrize = i === picked;
      stopAt(k, isPrize ? 2 : 1);
      // 选中的那一格拿第一件；其余按顺序取剩下的（照 `showLottery2` 的 `lotArray.shift()`）。
      const it = isPrize ? first : rest.shift();
      if (!it) continue;
      const inner = k.byName('k');
      if (inner) stopAt(inner, 10);
      const slot = inner && inner.byName ? inner.byName('c1') : null;
      const n = Math.max(1, Math.round(Number(it.count) || 1));
      if (slot) {
        if (slot.detachAll) slot.detachAll();
        attachLootIcon(slot, it);
        stopAt(slot, 2);
      }
      const cnt = k.byName ? k.byName('count') : null;
      if (cnt) setText(cnt, 'X' + n);
      if (isPrize) {
        label = ' ' + (it.name || it.label || '奖励') + '×' + n;
        if (!serverPrize) grantChestPrize(rec, it, loot);
      }
    }
    if (revealedText && label) setText(revealedText, '恭喜你获得' + label);

    // 翻奖之后要等玩家点一下才继续（原版 `state == 5` 按 fire → `setState(2)`）。
    // ⚠ 用户 2026-11 口径："开宝箱后的界面不许自动回退到随机挑战页" —— 不再挂 3.2s 兜底
    // 定时器，必须由玩家点「确定」或点这一层其它位置才继续。
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      const g = (chest.g || chest);
      const inConfirm = (target) => !!(target && target.closest && target.closest('.sf-chest-confirm'));
      if (g && g.addEventListener) {
        g.addEventListener('click', (event) => {

          if (inConfirm(event && event.target)) return;
          finish();
        });
        // 安卓 WebView 在 SVG 变换层上偶尔不补发合成 click（项目里 iOS 的同类问题
        // `js/touch-fallback.js`）。宝箱页不能只靠 click：这里再给整层补一条
        // touchend —— 点画面其它位置一样继续，正好保留"必须玩家点一下"的原意，
        let tap = null;
        g.addEventListener('touchstart', (event) => {
          const pt = event.touches && event.touches[0];
          if (inConfirm(event.target) || !pt) { tap = null; return; }
          tap = { x: pt.clientX, y: pt.clientY, t: Date.now() };
        }, { passive: true });
        g.addEventListener('touchend', (event) => {
          const start = tap; tap = null;
          if (!start || inConfirm(event.target)) return;
          const pt = event.changedTouches && event.changedTouches[0];
          if (!pt) return;
          const dx = pt.clientX - start.x, dy = pt.clientY - start.y;
          const moved = Math.sqrt(dx * dx + dy * dy), dt = Date.now() - start.t;
          if (moved <= 14 && dt <= 900) {
            if (event.cancelable) { try { event.preventDefault(); } catch (e) {} }
            finish();
          }
        }, { passive: false });
        g.addEventListener('touchcancel', () => { tap = null; });
      }
      try { mountChestConfirm(chest, finish); } catch (e) { if (window.__errs) window.__errs.push('chest confirm: ' + (e && e.message)); }
      rec.confirmChest = finish;
    });
  }

  function mountChestConfirm(chest, finish) {
    if (!chest || !chest.nodes) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const picked = [];
    for (const [depth, rec] of chest.nodes) {
      if (rec && ['3152', '4659'].includes(String(rec.id))) picked.push({ depth, rec });
    }
    if (!picked.length) return null;
    picked.sort((a, b) => a.depth - b.depth);
    const host = chest.getContentHost ? chest.getContentHost() : chest.g;
    if (!host) return null;
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'sf-feedback sf-chest-confirm');
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', '确定');
    // CSS 的 transform-origin:center 对 SVG 默认按 view-box 算；改成 fill-box 才会绕
    // 这颗按钮自己的包围盒中心缩放（否则整颗会从屏幕中心甩出去）。
    group.style.transformBox = 'fill-box';
    group.style.transformOrigin = 'center';
    // 鼠标点这颗 SVG 按钮时 Chrome 会把它设为 activeElement 并画一圈 UA 蓝框
    // `.sf-feedback` 的按下 / 回弹承担，不要 UA 焦点框。
    group.style.outline = 'none';
    // 整颗按钮都接事件（不只是那块透明矩形）：路径 / 文字 / 投影上按下也算「确定」。
    group.style.pointerEvents = 'auto';
    host.appendChild(group);
    for (const { rec } of picked) {
      const node = rec.wrap || rec.node;
      if (node) group.appendChild(node);
    }
    // 3152 的路径包围盒约 -62..62 × -22..23，放置矩阵 0.47 + (-0.75,64.5) → 舞台
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', '-31'); hit.setAttribute('y', '53');
    hit.setAttribute('width', '62'); hit.setAttribute('height', '23');
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('pointer-events', 'all');
    hit.setAttribute('data-hit', '1');
    group.appendChild(hit);
    if (window.SfUiFeedback) SfUiFeedback.bind(group, { shell: group });
    // 这颗「确定」不再只认 click：宝箱选择页早就有 pointerup / touchend 兜底
    // 安卓 WebView 在 SVG 变换层上偶尔不补发合成 click 时，画面就永久停在
    let armed = false, down = null, touch = null;
    const fire = (event) => {
      if (armed) return;
      if (event) {
        if (event.stopPropagation) event.stopPropagation();
        if (event.cancelable && event.type !== 'keydown') { try { event.preventDefault(); } catch (e) {} }
      }
      if (!window.SfUiFeedback) { armed = true; finish(); return; }
      const run = () => { armed = false; finish(); };
      if (SfUiFeedback.tap(group, run, { delay: 120, press: true, pick: true })) armed = true;
    };
    group.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY, t: Date.now() };
    });
    group.addEventListener('pointerup', (event) => {
      const start = down; down = null;
      if (!start || (start.id != null && event.pointerId != null && start.id !== event.pointerId)) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.sqrt(dx * dx + dy * dy) <= 14 && Date.now() - start.t <= 900) fire(event);
    });
    group.addEventListener('pointercancel', () => { down = null; });
    group.addEventListener('touchstart', (event) => {
      const pt = event.changedTouches && event.changedTouches[0];
      touch = pt ? { x: pt.clientX, y: pt.clientY, t: Date.now() } : null;
    }, { passive: true });
    group.addEventListener('touchend', (event) => {
      const start = touch; touch = null;
      const pt = event.changedTouches && event.changedTouches[0];
      if (!start || !pt) return;
      const dx = pt.clientX - start.x, dy = pt.clientY - start.y;
      if (Math.sqrt(dx * dx + dy * dy) <= 14 && Date.now() - start.t <= 900) fire(event);
    }, { passive: false });
    group.addEventListener('touchcancel', () => { touch = null; });
    group.addEventListener('click', fire);
    group.addEventListener('keydown', (event) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fire(event); }
    });
    return group;
  }


  function planChestPrizes(kind, random, fallback) {
    const pool = (window.BattleDrops && BattleDrops.poolFor) ? BattleDrops.poolFor(kind || 'challenge') : null;
    const rnd = typeof random === 'function' ? random : Math.random;
    const given = (fallback || []).slice(0, 4);
    if (!pool || !pool.length) return given;
    const total = pool.reduce((n, p) => n + Number(p.weight || 0), 0);
    if (!(total > 0)) return given;
    const out = [];
    const take = () => {
      let value = rnd() * total, hit = pool[pool.length - 1];
      for (const p of pool) { value -= Number(p.weight || 0); if (value < 0) { hit = p; break; } }
      return hit;
    };
    for (let i = 0; i < 4; i++) {

      let hit = take();
      for (let k = 0; k < 2 && out.some((x) => x.id === hit.id); k++) hit = take();
      out.push({ id: hit.id, name: hit.name, count: hit.count });
    }
    return out;
  }
  // 另外三件纯展示。入账走 `BattleDrops.grant`（与悬浮掉落同一套规则、同一份存档写入）。
  function grantChestPrize(rec, prize, loot) {
    if (!prize || rec.chestPrize) return;
    rec.chestPrize = { id: prize.id, name: prize.name, count: prize.count };
    if (window.BattleDrops && BattleDrops.grant) {
      try { BattleDrops.grant([rec.chestPrize]); } catch (e) {}
    }

    if (loot && Array.isArray(loot.items)) loot.items.push({ ...rec.chestPrize });
  }


  async function openOnlineChest(opts) {
    const o = opts || {};
    if (!window.__SSDZ_ONLINE__ || typeof o.claimChest !== 'function') throw new Error('联机宝箱缺少服务器领取接口');
    clean();
    const mine = ++seq, ui = document.getElementById('ui');
    const host = document.createElement('section');
    host.className = 'classic-home ssfight-home ssfight-view online-chest-page';
    host.setAttribute('aria-label', '领取战斗宝箱');
    ui.appendChild(host);
    const rec = { host, view: null, o, result: { winner: o.win === false ? 1 : 0 },
      timers: [], rafs: [], sleepers: new Set(), speed: 1, settling: true, stopped: false,
      fighters: [null, null], plans: [null, null], shields: [0, 0], phase: 'chest-loading' };
    live = rec;
    try {
      await SfRender.loadExtra(FIGHT_CORE_FILE);
      lootIcons = await SfRender.loadLootIcons();
      if (mine !== seq || rec.stopped) return null;
      rec.view = await SfRender.mountSymbol(host, SYM.fight, { frame: F.chest, label: '战斗宝箱', policy: {}, onClip });
      if (mine !== seq || rec.stopped) return null;
      try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}

      const t = T();
      if (t) t.freezeDescendants(rec.view);
      await openChest(rec, { items: [] });
      if (!rec.stopped) rec.finished = true;
      return rec.claimResponse;
    } finally {
      rec.stopped = true;
      if (live === rec) clean();
      else { if (rec.view) rec.view.destroy(); host.remove(); }
    }
  }

  function cancelOnlineChest() {
    const rec = live;
    if (!rec || !rec.o || !rec.o.claimChest) return;
    rec.stopped = true;
    if (rec.chestPick) rec.chestPick(0);
    if (rec.confirmChest) rec.confirmChest();
    clean();
  }


  function countDressed(clip, seen) {
    if (!clip || !clip.nodes) return 0;
    const mark = seen || new Set();
    if (mark.has(clip)) return 0;
    mark.add(clip);
    let n = 0;
    for (const rec of clip.nodes.values()) {
      if (!rec.clip) continue;
      if (rec.clip.g && rec.clip.g.getAttribute && rec.clip.g.getAttribute('slot')) n++;
      n += countDressed(rec.clip, mark);
    }
    for (const c of clip.__attached || []) {
      if (c.g && c.g.getAttribute && c.g.getAttribute('slot')) n++;
      n += countDressed(c, mark);
    }
    return n;
  }

  window.SfFight = Object.freeze({
    run,
    openOnlineChest,
    cancelOnlineChest,

    active: () => (live ? { speed: live.speed, round: live.round, stopped: live.stopped,
      phase: live.phase || 'fight', chest: !!live.chestPick, names: live.names,

      countdown: live.countdown ? live.countdown.frame + 1 : 0,

      cur: live.curRound ? { action: String(live.curRound.action || ''), id: Number(live.curRound.id) || 0, attacker: Number(live.curRound.attacker) || 0 } : null,
      impact: live.impactVia || null,
      weapon: live.fighters.map((f) => (f && f.weaponNow) ? { id: f.weaponNow.id, level: f.weaponNow.level } : null),

      shields: live.shields.slice(),
      plans: live.plans.map((p) => (p ? { slots: p.bySlot.size, holders: p.holders.size } : null)),
      dressed: live.fighters.map((f) => (f && f.mc ? countDressed(f.mc) : 0)),
      fighters: live.fighters.map((f) => (f ? Object.assign({ hp: f.blood.leftBlood }, f.debug()) : null)) } : null),
    // 开宝箱那一步是等玩家点的（原版 `jiantou_WZ_X1` 选一个箱子再按 Fire）。
    // 这个入口给回归用例与探针用：等价于"玩家点了第 i 个宝箱"（0 基）。
    pickChest: (i) => { if (live && live.chestPick) { live.chestPick(Math.max(0, Math.min(3, Number(i) || 0))); return true; } return false; },

    confirmChest: () => { if (live && live.confirmChest) { live.confirmChest(); return true; } return false; },

    ready: () => !!(window.SfRender && window.State),
    SYM, FRAME: F, SIDE_MATRIX,

    NPC_SHEETS: Object.freeze(NPC_SHEETS), NPC_ACTION: Object.freeze(NPC_ACTION), NPC_HIT_FRAME: Object.freeze(NPC_HIT_FRAME),
    _npcAnim: (npc, action) => npcAnimName(String(npc || ''), action),

    _attackFrame: (r) => attackPlan(r).frame,
    _fightFiles: (o) => fightAttackSymbols(o).map(fightChunkFile),
    _loadFightAssets: loadFightAssets,
    preloadCore,
    prefetchMatch,

    _petAttackFrame: (petId) => 29 + Math.max(1, Math.min(32, Number(petId) || 1)),
    _petDefenseFrame: (petId) => PET_DEFENSE_FRAME[Number(petId)] || -1,
    _defenseKind: (r, hasEquip, lvl, side) => defensePlan(r, hasEquip, lvl, side).kind,

    _weaponArt: (ranged, id) => {
      const t = ranged ? THROW_WEAPON_ART : MELEE_WEAPON_ART;
      return t.frames[Number(id)] || 0;
    },
    _weaponSize: (level) => WEAPON_SIZE_FRAMES[Number(level)] || 1,
    _defenseSkillFrame: (id, lvl) => defenseSkillFrame(id, lvl) || 0,

    _attackActs: (r) => ATTACK_ACTS[attackPlan(r).frame] || null,
    _floatKind: (kind) => FLOAT_KIND[kind] || FLOAT_KIND.hit,
    // 伤害飘字的上限 / 位数 / 特效档（纯函数）：`{ mag, digits, tier }`。
    _damageFloatPlan: (value) => damageFloatPlan(value),

    _ensureFloatDigits: (digits, want) => ensureFloatDigits(digits, want),

    _luckyBall: LUCKY_BALL,
    _showLuckyResult: showLuckyResult,
    _freezeNestedAnim: freezeNestedAnim,
    // 三侠图集新动作起手时先画哪一帧（idx=-1 也不能清成空白）。
    _atlasPaintFrame: (anim) => atlasPaintFrame(anim),

    _effectStatu: (r) => effectStatu(r),
    WEAPON_ART: Object.freeze({ melee: MELEE_WEAPON_ART, ranged: THROW_WEAPON_ART, size: WEAPON_SIZE_FRAMES }),

    PET_FRAMES: Object.freeze({
      attack: PET_ATTACK_ACTS, defense: PET_DEFENSE_FRAME, art: Object.freeze(HUD_PET_SYMBOLS.slice()), slot: '3414',
    }),

    COUNTDOWN: Object.freeze({ tag: COUNTDOWN_TAG, holder: '7703', holderFrame: HUD_STOP,
      frames: 41, endFrame: COUNTDOWN_END }),
    ACTS: Object.freeze({
      attack: ATTACK_ACTS, defense: DEFENSE_ACTS, defenseSkill: DEFENSE_SKILL_ACTS,
      dodge: DODGE_ACTS, attackBack: ATTACKBACK_ACTS, comeBack: COMEBACK_ACTS, hudStop: HUD_STOP,
    }),
  });
})();
