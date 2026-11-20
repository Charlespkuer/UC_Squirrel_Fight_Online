// online-campaign.js — 联机「征战」页与匹配 watcher
(function () {
  'use strict';
  const U = window.OnlineUI;
  if (!U || !U._) return;
  const { O, esc, toast, C, uiRoot, confirmBox } = U._;
  let pollTimer = null;
  let watchBusy = false;
  let seq = 0;
  // 后台不轮询征战，回前台立刻补一次（只在还有等待中的匹配时生效）。
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && pollTimer) void checkCampaignWatch();
    });
  }

  const WAR_TEXT = {
    wait: '正在等待队友，凑够人数后自动开始挑战。。。',
    ticket: '报名需扣除1个征战令',
  };

  function clipOf(view, name) {
    try {
      if (!view) return null;
      const item = (view.byName && view.byName(name)) || (view.byNameDeep && view.byNameDeep(name));
      return item ? (item.g ? item : { g: item }) : null;
    } catch (e) { return null; }
  }

  function setText(view, name, text) {
    const clip = clipOf(view, name);
    if (!clip) return false;
    try {
      if (window.SfRender && SfRender.setText && SfRender.setText(clip.g, text, { wrap: true })) return true;
      const tf = clip.g.querySelector('[data-text]') || clip.g;
      if (tf && tf.textContent != null) { tf.textContent = String(text); return true; }
    } catch (e) {}
    return false;
  }

  // 直接写一个文本节点（`clip` 本身就是文本字段，不是“父元件 + 字段名”）。
  function setNodeText(clip, text) {
    if (!clip) return false;
    const g = clip.g || clip;
    try {
      if (window.SfRender && SfRender.setText && SfRender.setText(g, text, { wrap: true })) return true;
      const t = (g && g.querySelector) ? g.querySelector('text') : null;
      if (t) { t.textContent = String(text); return true; }
      if (g && g.textContent != null) { g.textContent = String(text); return true; }
    } catch (e) {}
    return false;
  }

  function stopAt(clip, frame) {
    if (!clip) return;
    try { if (clip.gotoAndStop) clip.gotoAndStop(frame); } catch (e) {}
  }


  function freezeView(view) {
    const t = window.SfUiMain && SfUiMain.toolkit;
    if (t && t.freezeDescendants) {
      try { t.freezeDescendants(view); return true; } catch (e) {}
    }
    return false;
  }

  // 原版按钮接线：停在常态帧 + 铺透明热区 + 走公共点击路由。
  // ⚠ 翻页箭头 `3156` 的第 2 帧是空帧（画稿只在第 1 帧），所以箭头不能像普通按钮
  function wireButton(clip, onFire, opts) {
    if (!clip || !clip.g) return;
    const t = window.SfUiMain && SfUiMain.toolkit;
    const o = opts || {};
    const idle = o.idle != null ? Number(o.idle) : 1;
    const hover = o.hover != null ? Number(o.hover) : 0;
    const disabled = o.disabled === true;
    stopAt(clip, idle);
    clip.g.style.cursor = disabled ? 'default' : 'pointer';
    clip.__campaignFire = disabled ? null : onFire;

    // 和村庄页的 `keepWrapped` 同一顺序：popWrap → addHitArea → 把热区也挪进壳。
    let shell = null;
    if (t && t.popWrap) {
      try { t.popWrap(clip, !!o.animate); } catch (e) {}
      try { shell = clip.g.querySelector(':scope > g.uc-pop'); } catch (e) { shell = null; }
    }
    if (t && t.addHitArea) { try { t.addHitArea(clip, !!o.animate); } catch (e) {} }
    if (shell && clip.__hitArea && clip.__hitArea.parentNode !== shell) {
      try { shell.appendChild(clip.__hitArea); } catch (e) {}
    }
    if (shell && window.SfUiFeedback) {
      try { shell.setAttribute('aria-disabled', disabled ? 'true' : 'false'); } catch (e) {}
      try { SfUiFeedback.bind(shell, { hover: false }); } catch (e) {}
      if (disabled) shell.style.pointerEvents = 'none';
    }
    if (!disabled && hover > 0 && shell && !shell.__campaignHover) {
      shell.__campaignHover = true;
      shell.addEventListener('pointerenter', () => { if (clip.g.isConnected) stopAt(clip, hover); });
      shell.addEventListener('pointerleave', () => stopAt(clip, idle));
    }

    clip.g.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      if (disabled) return;
      const fire = clip.__campaignFire;
      if (!fire) return;
      if (shell && window.SfUiFeedback && SfUiFeedback.tap) {
        SfUiFeedback.tap(shell, fire, { delay: 70, press: true });
        return;
      }
      fire();
    };
  }


  let campaignRollSeq = 0;
  let campaignView = null;
  function closeCampaignView() {
    campaignRollSeq++;
    if (!campaignView) return;
    try { campaignView.destroy(); } catch (e) {}
    campaignView = null;
  }

  // 征战分奖页（原版 3437 第 5 帧 / `campaignRollMc`）
  // 服务端已经把公开版 roll 数据落库（`room.roll`），这里只负责照原版播：
  let campaignIconMap = null;

  async function campaignPropIcons() {
    if (campaignIconMap) return campaignIconMap;
    try { campaignIconMap = ((await SfRender.loadTable('prop-icons.json')) || {}).byId || {}; }
    catch (e) { campaignIconMap = {}; }
    return campaignIconMap;
  }

  function campaignPrizeCount(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    // 幻兽栏满时服务端折回 400 孵化点；分奖页按实际发放物显示。
    if (award && award.kind === 'hatch') return Math.max(1, Number(award.count) || 1);
    // 紫装格满时服务端会折算成 200 金松果；分奖页按实际发放物显示，避免“看到紫装、包里没有”。
    if (award && award.fallback && Number(award.gold) > 0) return Math.max(1, Number(award.gold));
    if (p.kind === 'gold') return Math.max(1, Number(p.gold) || Number(p.count) || 1);
    if (p.kind === 'gear') return 1;
    if (p.kind === 'pet') return 1;
    return Math.max(1, Number(p.count) || 1);
  }


  function campaignPrizeText(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    const pet = (award && award.kind === 'pet' && award.pet) || p.pet || null;
    if (p.kind === 'pet' && pet && !(award && award.kind === 'hatch')) {
      return 'Lv' + Math.max(1, Number(pet.level) || 1);
    }
    return 'x' + campaignPrizeCount(entry);
  }

  // 幻兽头像元件：直接用战斗 HUD 那 32 颗原版图标（`SfFight.PET_FRAMES.art`
  // 按幻兽 id 1..32 排列），不另画一套、也不依赖 4280 的大立绘。
  function campaignPetSymbol(petId) {
    const art = window.SfFight && SfFight.PET_FRAMES && SfFight.PET_FRAMES.art;
    if (!Array.isArray(art) || !art.length) return '';
    const id = Math.max(1, Math.min(art.length, Number(petId) || 1));
    return art[id - 1] || '';
  }

  function campaignArtFor(entry) {
    const p = (entry && entry.prize) || {};
    const award = entry && entry.award;
    if (award && award.kind === 'hatch') return { prop: 45 };
    if (award && award.fallback && Number(award.gold) > 0) return { prop: 8 };
    if (p.kind === 'gold') return { prop: 8 };
    if (p.kind === 'prop') return { prop: Number(p.id) || 0 };
    if (p.kind === 'gear') return { gear: Number(award && award.id) || 201 };
    if (p.kind === 'pet') {
      const pet = (award && award.kind === 'pet' && award.pet) || p.pet || null;
      return (pet && campaignPetSymbol(pet.id)) ? { pet: Number(pet.id) } : { prop: 45 };
    }

    if (p.kind === 'hatch') return { prop: 45 };
    return { prop: 0 };
  }

  function campaignClearArt(slot) {
    if (!slot || !slot.g) return;
    try { if (slot.detachAll) slot.detachAll(); } catch (e) {}
    const list = slot.g.querySelectorAll ? slot.g.querySelectorAll('.campaign-art') : [];
    for (const el of list) if (el.parentNode) el.parentNode.removeChild(el);
  }


  function campaignAttachArt(slot, art) {
    if (!slot || !slot.g || !art) return;
    campaignClearArt(slot);
    if (art.pet) {
      const symbol = campaignPetSymbol(art.pet);
      let clip = null;
      if (symbol && slot.attachChild) {
        try { clip = slot.attachChild(symbol, 1, 'campaign-art'); } catch (e) { clip = null; }
      }
      if (clip) { fitCampaignPetArt(clip); return; }

      art = { prop: 45 };
    }
    let href = '';
    if (art.gear) href = 'images/ui/icons/gear/gear-' + art.gear + '.png';
    else if (art.prop) {
      const c = C();
      href = (c && typeof c.propIconSrc === 'function')
        ? c.propIconSrc(art.prop)
        : ('images/ui/icons/prop/prop-' + art.prop + '.svg');
    }
    if (!href) return;
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.setAttribute('class', 'campaign-art');
    img.setAttribute('href', href);
    // iOS 15 / 老 WebView 的 SVG `<image>` 仍只认 xlink:href；两个都写，现代引擎取前者。
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    img.setAttribute('x', '3');
    img.setAttribute('y', '3');
    img.setAttribute('width', '36');
    img.setAttribute('height', '36');
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    slot.g.appendChild(img);
  }


  function fitCampaignPetArt(clip) {
    if (!clip || !clip.g) return;
    clip.playing = false;
    const box = 34;
    const center = 21.15;
    const fit = () => {
      if (!clip.g || clip.g.isConnected === false) return false;
      let b = null;
      try { b = clip.g.getBBox ? clip.g.getBBox() : null; } catch (e) { b = null; }
      if (!b || !b.width || !b.height) return false;
      const scale = Math.min(box / b.width, box / b.height);
      if (!Number.isFinite(scale) || scale <= 0) return false;
      const x = center - (b.x + b.width / 2) * scale;
      const y = center - (b.y + b.height / 2) * scale;
      if (clip.setExtraTransform) clip.setExtraTransform('translate(' + x + ',' + y + ') scale(' + scale + ')');
      return true;
    };
    if (fit() || typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => { fit(); });
  }


  function waitClipEnd(clip, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const step = () => {
        if (!clip || !clip.g || !clip.g.isConnected) { resolve(); return; }
        const last = Math.max(0, (clip.frameCount ? clip.frameCount() : 1) - 1);
        if (Number(clip.frame) >= last || clip.playing === false) { resolve(); return; }
        if (Date.now() - started >= (timeoutMs || 2600)) { resolve(); return; }
        setTimeout(step, 40);
      };
      step();
    });
  }


  async function showCampaignRoll(room, viewOverride) {
    const roll = room && room.roll;
    // `index` 去重：服务端已去重，这里再兜一层，避免旧房间/异常数据让底部多画一格。
    const seenPrize = new Set();
    const prizes = (roll && Array.isArray(roll.prizes) ? roll.prizes : []).filter((p) => {
      const index = Number(p && p.index);
      if (seenPrize.has(index)) return false;
      seenPrize.add(index);
      return true;
    }).slice(0, 5);
    if (!prizes.length) return false;
    if (!viewOverride && (!campaignView || !campaignView.g || !campaignView.g.isConnected)) {
      try { await campaignPage(); } catch (e) {}
    }
    const view = viewOverride || campaignView;
    if (!view || !view.g || !view.g.isConnected) return false;

    const token = ++campaignRollSeq;
    let skipped = false;
    const wake = [];
    const sleep = (ms) => {
      if (skipped) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          const i = wake.indexOf(done);
          if (i >= 0) wake.splice(i, 1);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
        wake.push(done);
      });
    };
    const skip = () => {
      if (skipped) return;
      skipped = true;
      while (wake.length) wake.pop()();
    };
    view.g.addEventListener('click', skip, true);

    try {
      view.gotoAndStop(5);
      const seats = (Array.isArray(room.seats) ? room.seats.slice() : [])
        .sort((a, b) => Number(a.seat) - Number(b.seat));
      for (let i = 1; i <= 4; i++) {
        const panel = clipOf(view, 'roll' + i);
        if (!panel) continue;
        const seat = seats[i - 1] || {};
        const name = String(seat.name || (seat.kind === 'empty' ? '虚位以待' : '队友'));
        setText(panel, 'name', name);
        const n1 = panel.byName && panel.byName('num1'), n2 = panel.byName && panel.byName('num2');
        if (n1) n1.gotoAndStop(1);
        if (n2) n2.gotoAndStop(1);
      }
      // 素材里的 `text1..5` / `prize.text1` 带作者占位串（实测是 x200）；
      // 在图标表异步回来之前先把它们清掉，避免开局闪一帧假数量。
      for (let i = 1; i <= 5; i++) {
        const slot = clipOf(view, 'c' + i);
        if (slot) { campaignClearArt(slot); slot.gotoAndStop(2); }
        setNodeText(clipOf(view, 'text' + i), '');
      }
      const emptyPrize = clipOf(view, 'prize');
      if (emptyPrize) {
        emptyPrize.gotoAndStop(1);
        for (let i = 1; i <= 4; i++) {
          const cell = emptyPrize.byName && emptyPrize.byName('c' + i);
          if (cell) { campaignClearArt(cell); cell.g.style.visibility = 'hidden'; }
        }
        setNodeText(emptyPrize.byName && emptyPrize.byName('text1'), '');
      }

      // 「随机幻兽」格要挂 HUD 那套原版头像；素材包按需拉一次（战斗里通常已经缓存）。
      const needsPetArt = prizes.some((entry) => {
        const p = (entry && entry.prize) || {};
        return p.kind === 'pet' && !(entry.award && entry.award.kind === 'hatch');
      });
      const petArt = (needsPetArt && window.SfRender && SfRender.loadExtra)
        ? Promise.resolve(SfRender.loadExtra('tags-fight-pets.json')).catch(() => {})
        : Promise.resolve();
      const [props] = await Promise.all([campaignPropIcons().catch(() => ({})), petArt]);
      if (token !== campaignRollSeq) return false;

      const paintStrip = (start) => {
        for (let i = 0; i < 5; i++) {
          const slot = clipOf(view, 'c' + (i + 1));
          const count = clipOf(view, 'text' + (i + 1));
          const entry = prizes[start + i];
          if (!entry) {
            if (slot) { campaignClearArt(slot); slot.gotoAndStop(2); }
            if (count) setNodeText(count, '');
            continue;
          }
          if (slot) {
            slot.gotoAndStop(1);
            const art = campaignArtFor(entry);

            campaignClearArt(slot);
            const hit = art.prop ? props[String(art.prop)] : null;
            const clip = (hit && hit.id && slot.attachChild) ? slot.attachChild(hit.id, 1, 'campaign-art') : null;
            if (!clip) campaignAttachArt(slot, art);
          }
          if (count) setNodeText(count, campaignPrizeText(entry));
        }
      };

      const paintPrize = (entry) => {
        const prize = clipOf(view, 'prize');
        if (!prize) return;
        prize.gotoAndStop(1);
        const winner = Math.max(0, Math.min(3, Number(entry.winnerSeat) || 0));

        prize.__frameFix = () => {
          for (let n = 1; n <= 4; n++) {
            const c = prize.byName && prize.byName('c' + n);
            if (c) c.g.style.visibility = (n - 1) === winner ? '' : 'hidden';
          }
        };
        for (let i = 1; i <= 4; i++) {
          const cell = prize.byName && prize.byName('c' + i);
          if (!cell) continue;
          const on = (i - 1) === winner;
          cell.g.style.visibility = on ? '' : 'hidden';
          if (!on) { campaignClearArt(cell); continue; }
          cell.gotoAndStop(1);
          const art = campaignArtFor(entry);
          campaignClearArt(cell);
          const hit = art.prop ? props[String(art.prop)] : null;
          const clip = (hit && hit.id && cell.attachChild) ? cell.attachChild(hit.id, 1, 'campaign-art') : null;
          if (!clip) campaignAttachArt(cell, art);
        }
        const text = prize.byName && prize.byName('text1');
        if (text) setNodeText(text, campaignPrizeText(entry));
        prize.g.style.visibility = '';
      };


      const clearPrizeBox = (node) => {
        if (!node) return;
        node.__frameFix = null;
        for (let n = 1; n <= 4; n++) {
          const cell = node.byName && node.byName('c' + n);
          if (cell) { campaignClearArt(cell); cell.g.style.visibility = 'hidden'; }
        }
        const text = node.byName && node.byName('text1');
        if (text) setNodeText(text, '');
        node.g.style.visibility = 'hidden';
      };

      const animate = async (panel, point) => {
        const n1 = panel.byName && panel.byName('num1');
        const n2 = panel.byName && panel.byName('num2');
        const end = Date.now() + 430;
        while (!skipped && Date.now() < end) {
          if (n1) n1.gotoAndStop(1 + Math.floor(Math.random() * 10));
          if (n2) n2.gotoAndStop(1 + Math.floor(Math.random() * 10));
          await sleep(55);
        }
        const final = String(Math.max(0, Math.min(99, Number(point) || 0))).padStart(2, '0');
        if (n1) n1.gotoAndStop(Number(final[0]) + 1);
        if (n2) n2.gotoAndStop(Number(final[1]) + 1);
      };

      for (let i = 0; i < prizes.length; i++) {
        if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
        const entry = prizes[i];

        paintStrip(i + 1);
        paintPrize(entry);
        const rolls = Array.isArray(entry.rolls) ? entry.rolls : [];
        for (let seat = 0; seat < 4; seat++) {
          if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
          const panel = clipOf(view, 'roll' + (seat + 1));
          if (panel) await animate(panel, rolls[seat] ? rolls[seat].point : 0);
          if (!skipped) await sleep(110);
        }
        if (token !== campaignRollSeq || skipped || !view.g.isConnected) break;
        await sleep(240);
        const prize = clipOf(view, 'prize');
        const isLast = i === prizes.length - 1;
        if (prize && !skipped) {
          prize.gotoAndPlay(2);

          await waitClipEnd(prize, 2600);
        }
        if (prize) {
          if (isLast) {

            clearPrizeBox(prize);
          } else prize.gotoAndStop(1);
        }
      }

      clearPrizeBox(clipOf(view, 'prize'));
      if (!skipped) await sleep(2000);
      return true;
    } finally {
      view.g.removeEventListener('click', skip, true);
    }
  }

  // 征战后台 watcher / 状态条
  // waiting → 更新页面上的剩余时间；到点由服务端判 failed（不扣票）
  // failed  → 提示超时、ack 清掉
  let campaignDeferred = false;

  function stopCampaignWatch() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    campaignDeferred = false;
  }

  function battleBusy() {
    try { if (window.SfFight && typeof SfFight.active === 'function' && SfFight.active()) return true; } catch (e) {}
    return !!document.querySelector('.classic-modal-overlay, .online-login-card');
  }

  function statusNode() { return document.querySelector('.online-campaign-status'); }

  function hideCampaignStatus() {
    const node = statusNode();
    if (node) { node.style.display = 'none'; node.innerHTML = ''; }
  }

  function paintCampaignStatus(room) {
    const node = statusNode();
    if (!node) return;
    if (!room || room.status !== 'waiting') { hideCampaignStatus(); return; }
    const ready = (room.members || []).filter((m) => !m.missed).length;
    const secs = Math.max(0, Math.ceil(Number(room.remainMs || 0) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    node.innerHTML = '<b>真人匹配中</b><span>' + ready + '/' + (room.partySize || 4) + '</span>' +
      '<span>剩余 ' + mm + ':' + ss + '</span>' +
      '<button type="button" class="online-campaign-cancel">取消匹配</button>';
    node.style.display = 'flex';
    const cancel = node.querySelector('.online-campaign-cancel');
    if (cancel) cancel.onclick = () => { void leaveCampaignQueue(); };
  }

  async function leaveCampaignQueue() {
    stopCampaignWatch();
    hideCampaignStatus();
    try { await O.post('/api/campaign/queue/leave', {}); toast('已取消征战匹配。'); }
    catch (e) { toast(O.errText(e)); }
    if (document.querySelector('section[aria-label="征战"]')) campaignPage();
  }

  // 征战接力回放：按 seat 顺序把四个座位的战报依次播一遍（助战座位也有服务端补录的
  async function playCampaignRelay(room, reward) {
    if (reward && reward.missed) return;
    const seats = Array.isArray(room && room.seats) ? room.seats.slice() : [];
    seats.sort((a, b) => Number(a.seat) - Number(b.seat));
    const plays = seats.filter((s) => s && s.combatId && !s.skipped);
    const ownId = String((reward && reward.combatId) || '');
    // 整条接力期间保留底板页面：`holdUnderlay` 会跳过 `clearUiForBattle`，
    // 战斗层只盖在征战页上面；否则每段录像之间会露出「只有背景与装备」的主界面。
    const replayOpts = { holdUnderlay: true };
    if (!plays.length) {
      if (ownId) { try { await O.battle.replay(ownId, null, replayOpts); } catch (e) {  } }
      return;
    }
    if (ownId && !plays.some((s) => String(s.combatId) === ownId)) {
      plays.push({ seat: Number((room.me && room.me.seat) || 0), name: '你的战斗', combatId: ownId });
    }
    for (let i = 0; i < plays.length; i++) {
      try { await O.battle.replay(plays[i].combatId, null, replayOpts); } catch (e) {  }
      if (i < plays.length - 1) {
        toast('征战接力 ' + (i + 2) + '/' + plays.length + '：' + (plays[i + 1].name || '队友') + ' 上场');
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
    }
  }

  let finishingCampaign = false;
  async function finishCampaign(room) {
    if (!room || finishingCampaign) return;
    if (battleBusy()) {
      if (!campaignDeferred) { toast('征战已匹配，当前界面结束后自动进入战斗。'); campaignDeferred = true; }
      // 随机匹配是请求内直接结算的，没有“等待 watcher”阶段；这里补一个轮询，
      // 否则关弹窗动画还没结束时 finish 会被 busy 挡掉、再也没人重试。
      if (!pollTimer) startCampaignWatch();
      return;
    }
    finishingCampaign = true;
    campaignDeferred = false;
    stopCampaignWatch();
    try {
      // 门票/经验/战利品都是服务端结算的；回放前先把权威存档拉回来。
      try { await O.syncState(); } catch (e) { O.markResync(); }
      const reward = (room.me && room.me.reward) || {};
      const win = room.teamResult === 'win' || !!reward.win;
      // 先按座位顺序播完整条接力（自己死了也继续看队友打），再进分奖页/结果。
      await playCampaignRelay(room, reward);
      const lines = [];
      lines.push(win ? '队伍胜利！' : '队伍失败');
      if (Number(room.bossMaxHp) > 0) lines.push('BOSS 剩余 ' + Math.max(0, Number(room.bossHp) || 0) + '/' + Number(room.bossMaxHp));
      if (reward.missed) {
        lines.push('本局未参战：' + String(reward.msg || '征战令不足'));
      } else {
        if (reward.exp) lines.push('经验 +' + reward.exp);
        if (reward.gold) lines.push('金松果 +' + reward.gold);
        const lootList = Array.isArray(reward.lootList) ? reward.lootList : (reward.loot ? [reward.loot] : []);
        for (const item of lootList) lines.push('获得 ' + item.name + ' ×' + item.count);
        if (!reward.gold && !lootList.length && win) lines.push('本场没有掉落');
        if (!reward.combatId) lines.push('BOSS 在队友回合被击败，你未出手');
        if (room.mode === 'random') lines.push('随机匹配 · 助战补位');
      }
      // 胜利局先播原版分奖页（3437 第 5 帧）；没有 roll 数据（老房间 / 失败局 /
      // 未参战）才回落到文字结果。分奖页不是“领奖按钮”，奖励在服务端结算时已入账。
      let rolled = false;
      if (win && !reward.missed && room.roll && Array.isArray(room.roll.prizes) && room.roll.prizes.length) {
        try { rolled = await showCampaignRoll(room); } catch (e) { rolled = false; }
      }
      try { await O.post('/api/campaign/rooms/' + room.code + '/ack', {}); } catch (e) {}
      try { await campaignPage(); } catch (e) {  }
      // 征战经验升级：和战斗战果同一条升级奖励出口（服务端把 ups 数组放在 reward 里）。
      const ups = Array.isArray(reward.ups) ? reward.ups : [];
      const showUps = () => {
        if (!ups.length) return;
        if (window.UI && UI.classic && UI.classic.showLevelUps) UI.classic.showLevelUps(ups);
      };
      if (rolled) {
        const bits = [];
        if (reward.exp) bits.push('经验 +' + reward.exp);
        if (reward.gold) bits.push('金松果 +' + reward.gold);
        const lootList = Array.isArray(reward.lootList) ? reward.lootList : (reward.loot ? [reward.loot] : []);
        for (const item of lootList.slice(0, 3)) bits.push(item.name + '×' + item.count);
        if (lootList.length > 3) bits.push('等 ' + lootList.length + ' 件');
        toast(bits.length ? bits.join(' · ') : '征战奖励已入账。');
        showUps();
        return;
      }
      const c = C();
      if (c && c.modal) {
        const m = c.modal('征战结果', '<p>' + lines.join('　') + '</p>', [{ label: '确定', primary: true }], { small: true });

        if (m && m.element && m.element.classList) m.element.classList.add('campaign-result-dialog');
        showUps();
      } else {
        toast(lines.join(' '));
        showUps();
      }
    } finally {
      finishingCampaign = false;
    }
  }

  // 慢网下 5s 轮询不能叠请求：`Net` 是全局串行的，排队的旧轮询会在恢复后一次涌出。
  async function checkCampaignWatch() {
    if (watchBusy) return;
    watchBusy = true;
    try { await checkCampaignWatchNow(); }
    finally { watchBusy = false; }
  }
  async function checkCampaignWatchNow() {
    if (typeof document !== 'undefined' && document.hidden) return; // 后台不轮询，回前台由 visibilitychange 补一次
    if (!O.ready) { stopCampaignWatch(); return; }
    let room;
    try { room = (await O.get('/api/campaign/current', { parallel: true, timeoutMs: 8000 })).room; }
    catch (e) { return; }
    if (!room) { stopCampaignWatch(); hideCampaignStatus(); return; }
    paintCampaignStatus(room);
    if (room.status === 'waiting') {
      if (!pollTimer) {
        pollTimer = setInterval(() => { void checkCampaignWatch(); }, 5000);
      }
      return;
    }
    if (room.status === 'done') {
      if (battleBusy()) {
        if (!campaignDeferred) { toast('征战已匹配，当前界面结束后自动进入战斗。'); campaignDeferred = true; }
        return;
      }
      stopCampaignWatch();
      await finishCampaign(room);
      return;
    }
    if (room.status === 'failed') {
      stopCampaignWatch();
      hideCampaignStatus();
      toast(room.failedReason === 'timeout' ? '征战匹配超时，未扣除征战令。' : '征战队伍已解散，未扣除征战令。');
      try { await O.post('/api/campaign/rooms/' + room.code + '/ack', {}); } catch (e) {}
      if (document.querySelector('section[aria-label="征战"]')) campaignPage().catch(() => {});
      return;
    }
    stopCampaignWatch();
    hideCampaignStatus();
  }

  function startCampaignWatch() {
    stopCampaignWatch();
    void checkCampaignWatch();
    if (!pollTimer) pollTimer = setInterval(() => { void checkCampaignWatch(); }, 5000);
  }

  async function resumeCampaignWatch() {
    if (!O.ready) return;
    let room = null;
    try { room = (await O.get('/api/campaign/current', { parallel: true, timeoutMs: 8000 })).room; } catch (e) { return; }
    if (!room) return;
    if (room.status === 'waiting' || room.status === 'done') startCampaignWatch();
  }

  async function campaignPage() {
    const root = uiRoot();
    if (!root) return false;
    const mine = ++seq;
    let data;
    try {
      data = await O.get('/api/campaign/bosses');
    } catch (e) {
      toast(O.errText(e));
      return false;
    }
    if (mine !== seq) return false;
    if (!window.SfRender || !SfRender.mountSymbol) { toast('经典素材未加载'); return false; }
    closeCampaignView();
    root.innerHTML = '<section class="classic-home ssfight-home" aria-label="征战"></section>';
    const host = root.querySelector('.ssfight-home');
    await SfRender.loadExtra('tags-campaign.json');
    if (mine !== seq) return false;
    const view = await SfRender.mountSymbol(host, '3437', { frame: 1, label: '征战' });
    if (mine !== seq) { try { view.destroy(); } catch (e) {} return false; }
    campaignView = view;

    let page = 1;
    // `main_mc` / `left` / `right` 在根时间轴换帧时会被重建，不能在挂载时抓一次
    const mainClip = () => clipOf(view, 'main_mc');

    const hideNewMark = () => { const news = clipOf(view, 'newMessage'); if (news) stopAt(news, 2); };

    const showPage = (n) => {
      page = n === 2 ? 2 : 1;

      stopAt(view, 1);
      stopAt(mainClip(), page === 1 ? 1 : 2);
      freezeView(view);
      hideNewMark();
      const left = clipOf(view, 'left'), right = clipOf(view, 'right');
      if (left) {
        left.g.style.visibility = page === 1 ? 'hidden' : 'visible';
        wireButton(left, () => showPage(1));
      }
      if (right) {
        right.g.style.visibility = page === 1 ? 'visible' : 'hidden';
        wireButton(right, () => showPage(2));
      }

      const record = clipOf(view, 'button1');
      if (record) wireButton(record, () => paintRecords(1), { hover: 2 });
      const back = clipOf(view, 'button2');
      if (back) wireButton(back, () => {
        closeCampaignView();
        if (window.UI && UI.runAction) UI.runAction('village');
      }, { hover: 2 });
      paintBosses(data.bosses || []);
    };

    function paintBosses(bosses) {
      const main = mainClip();
      for (let i = 1; i <= 5; i++) {
        const boss = bosses[i - 1];
        const card = clipOf(main, 'boss' + i);
        if (!card) continue;

        const locked = !!(boss && boss.locked);
        wireButton(card, () => { if (boss) openBoss(boss); }, { idle: locked ? 3 : 1, hover: locked ? 0 : 2 });
      }
      // 原版第 1 帧容器里没有 text1 字段（只有帧 2/4/5 有）；每日次数已经写在报名
      // 确认框里，这里不再往不存在的字段写占位值。
    }

    function paintRecords(number) {
      const list = data.records || [], pages = Math.max(1, Math.ceil(list.length / 2));
      const current = Math.max(1, Math.min(pages, number));
      stopAt(view, 4);
      freezeView(view);
      for (let i = 1; i <= 2; i++) {
        const r = list[(current - 1) * 2 + i - 1];
        let extra = '';
        if (r) {
          const bits = [];
          if (r.gold) bits.push('金松果+' + r.gold);
          const loots = Array.isArray(r.lootList) ? r.lootList : (r.loot ? [r.loot] : []);
          for (const item of loots) bits.push(item.name + '×' + item.count);
          if (bits.length) extra = '，获得' + bits.slice(0, 3).join('、') + (bits.length > 3 ? '…' : '');
        }
        const text = r ? '征战「' + r.bossName + '」' + (r.win ? '胜利' : '失败') + '，经验 +' + (r.exp || 0) + extra : '';
        setText(view, 'text' + i, text);
        setText(view, 'text' + i + i, r && r.at ? new Date(r.at).toLocaleDateString() : '');
        const win = clipOf(view, 'win' + i), action = clipOf(view, 'a' + i);
        if (win) stopAt(win, r ? 7 : win.frameCount());
        if (action && action.g) action.g.style.visibility = 'hidden';
      }
      if (!list.length) setText(view, 'text1', '还没有征战记录。');
      setText(view, 'page', current + '/' + pages);
      const left = clipOf(view, 'left'), right = clipOf(view, 'right');
      if (left) {
        left.g.style.visibility = current > 1 ? 'visible' : 'hidden';
        wireButton(left, () => paintRecords(current - 1));
      }
      if (right) {
        right.g.style.visibility = current < pages ? 'visible' : 'hidden';
        wireButton(right, () => paintRecords(current + 1));
      }

      const back = clipOf(view, 'back');
      if (back) wireButton(back, () => showPage(page));
    }

    function openBoss(boss) {
      if (boss.locked) { toast(boss.name + ' 暂未开放。'); return; }
      if (!boss.unlocked) { toast(boss.name + ' 需要 ' + boss.unlockLevel + ' 级才能报名。'); return; }
      if (data.pending && data.pending.status === 'waiting') { toast('正在征战匹配中，可以先取消当前匹配。'); return; }
      if (data.daily && data.daily.left <= 0) {
        toast('今天已经参加 ' + data.daily.limit + ' 次征战，明天再来吧。');
        return;
      }
      if (!boss.enoughTicket) { toast(WAR_TEXT.ticket); return; }
      const c = C();
      const dailyLine = data.daily ? '今日剩余 ' + data.daily.left + '/' + data.daily.limit + ' 次。' : '';
      const text = boss.name + '（LV:' + boss.level + '）\n' + boss.unlockLevel + ' 级以上可报名，4 人组队。\n' +
        dailyLine + '\n' + WAR_TEXT.ticket + '（进入战斗后才扣）。\n是否报名？';
      if (!c || !c.modal) { confirmBox('征战报名', text, () => joinQueue(boss)); return; }
      const html = '<p>' + esc(boss.name) + '（LV:' + boss.level + '） · 4 人组队</p>' +
        '<p class="small-label"><b>随机匹配</b>：立刻抽 3 个等级相近的玩家快照 / 人机助战，马上开打。</p>' +
        '<p class="small-label"><b>等待真人</b>：后台最多等 5 分钟，凑齐 4 个真人自动开打；可以先离开此页。</p>' +
        '<p class="small-label">门票只在进入战斗后扣除；匹配超时不扣。</p>' +
        (dailyLine ? '<p class="small-label">' + esc(dailyLine) + '</p>' : '');
      const m = c.modal('征战报名', html, [
        { label: '随机匹配', primary: true, close: false, run: () => { m.close(); void joinRandom(boss); } },
        { label: '等待真人（5分钟）', close: false, run: () => { m.close(); void joinQueue(boss); } },
      ], { small: true });

      try { m.element.classList.add('campaign-match-dialog'); } catch (e) {}
    }

    async function joinQueue(boss) {
      try {
        const out = await O.post('/api/campaign/queue', { bossId: boss.bossId });
        if (out.patch) O.applyPatch(out.patch);
        if (out.room && out.room.status === 'done') { await finishCampaign(out.room); return; }
        if (out.room && out.room.status === 'failed') { toast('匹配失败：' + (out.room.failedReason || '没有找到队友')); await campaignPage(); return; }
        toast(out.already ? '已经在征战匹配队列中。' : '已开始匹配，最多等待 5 分钟；可以先去做别的。');
        startCampaignWatch();
        await campaignPage();
      } catch (e) { toast(O.errText(e)); }
    }

    async function joinRandom(boss) {
      try {
        const out = await O.post('/api/campaign/random', { bossId: boss.bossId });
        if (out.patch) O.applyPatch(out.patch);
        try { await O.syncState(); } catch (e) { O.markResync(); }
        if (out.room && out.room.status === 'done') { await finishCampaign(out.room); return; }
        if (out.already) { toast('已经有进行中的征战。'); startCampaignWatch(); await campaignPage(); return; }
        toast('随机匹配失败，请稍后再试。');
      } catch (e) { toast(O.errText(e)); }
    }

    if (document.createElement && host.appendChild) {
      const status = document.createElement('div');
      status.className = 'online-campaign-status';
      status.style.display = 'none';
      host.appendChild(status);
    }
    showPage(1);
    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}
    // 登录/回页时可能正好有一局在等/已结束：等待就挂状态条 + watcher，
    // 已结束就直接进战斗；超时的提示一次并 ack。
    const pending = data.pending || null;
    if (pending && pending.status === 'waiting') {
      paintCampaignStatus(pending);
      startCampaignWatch();
    } else if (pending && pending.status === 'done' && !(pending.me && pending.me.acked)) {
      void finishCampaign(pending);
    } else if (pending && pending.status === 'failed' && !(pending.me && pending.me.acked)) {
      toast(pending.failedReason === 'timeout' ? '征战匹配超时，未扣除征战令。' : '征战队伍已解散，未扣除征战令。');
      try { await O.post('/api/campaign/rooms/' + pending.code + '/ack', {}); } catch (e) {}
    } else {
      hideCampaignStatus();
    }
    return true;
  }

  U.campaignPage = campaignPage;
  U.showCampaignRoll = showCampaignRoll;
  U.resumeCampaignWatch = resumeCampaignWatch;
  U.stopCampaignWatch = stopCampaignWatch;
  U.hideCampaignStatus = hideCampaignStatus;
  U.closeCampaignView = closeCampaignView;
  U.startCampaignWatch = startCampaignWatch;
})();
