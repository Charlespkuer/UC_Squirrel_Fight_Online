// Additional classic UC screens. All progression stays in the current State save.

(function () {
  'use strict';
  const C = () => UI.classic;
  // 每日抽奖只保留单抽：十连抽选项在联机版取消（服务端也只按 1 次开奖）。
  const ONLINE = typeof window !== 'undefined' && !!window.__SSDZ_ONLINE__;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const find = (root, selector) => root.querySelector(selector);
  const image = (src, alt, cls) => '<img class="' + (cls || '') + '" src="' + src + '" alt="' + esc(alt) + '">';
  const sprite = (id) => image('images/ui/sprites/resource_6-' + id + '.png', '', 'extra-arena-picture');
  const button = (label, action, cls) => C().btn(label, action, cls || 'small');
  const note = (text) => '<p class="extra-note">' + esc(text) + '</p>';
  function on(root, action, handler) {
    const element = find(root, '[data-action="' + action + '"]');
    if (element) element.onclick = handler;
    return element;
  }
  function back(root, handler, label) {
    const element = on(root, 'home', handler);
    if (!element) return;
    const text = label || '\u8fd4\u56de';
    if (window.UI && UI.classic && UI.classic.setHomeLabel) UI.classic.setHomeLabel(root, text);
    else element.textContent = text;
  }
  function alert(text) {
    const msg = String(text == null ? '' : text);

    if (window.SfFightResult && window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic') {
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        C().modal('提示', '<p>' + esc(msg) + '</p>', [{ label: '确定' }], { small: true });
      };
      try {
        Promise.resolve(SfFightResult.open({ kind: 'notice', title: '提示', text: msg, actions: [{ label: '确定' }] }))
          .then((view) => { if (!view) fallback(); }).catch(fallback);
        return;
      } catch (e) { fallback(); return; }
    }
    C().modal('提示', '<p>' + esc(msg) + '</p>', [{ label: '确定' }], { small: true });
  }

  // ⚠ 这一页（`campaign()`，整页现代外壳）已经撤掉：用户 2026-10 口径
  // "点开村庄的征战界面时，单独做一个挑战塔与无尽塔的界面，不要套用现代 ui 的背景等，
  // `openEndless()` —— 就是现代版关卡页那两颗入口进去的界面。

  const ARENA_EXP = [150, 100, 50, 30];

  const ARENA_HATCH = [40, 35, 30, 25];

  const ARENA_FRAGMENT_SHARDS = [8, 6, 4, 3];
  function addProp(id, count) { const s = State.state(); s.props[id] = (s.props[id] || 0) + count; }
  function originalResult(spec) {
    if (!window.SfFightResult || !UI.currentUiMode || UI.currentUiMode() !== 'classic') return false;
    SfFightResult.open(spec).catch(error => { if (C().toast) C().toast('战果界面加载失败：' + error.message); });
    return true;
  }
  function outcome(win, reward, text, again, label, extra, display) {
    const buttons = (extra || []).concat([
      { label: '\u67e5\u770b\u5f55\u50cf', muted: true, run: () => UI.runAction('messages') },
      { label: label || '\u8fd4\u56de', primary: true, run: again },
    ]);
    if (originalResult({ kind: display && display.kind || 'result', title: display && display.title || '战斗结果', win,
      exp: reward.exp, gold: reward.gold || 0, ups: reward.ups, note: text,
      text: text + '\n经验 +' + reward.exp + '　金松果 +' + (reward.gold || 0) + '\n' + C().upsHtml(reward.ups), actions: buttons })) return;
    C().modal('\u6218\u6597\u7ed3\u679c', '<div class="extra-result"><strong class="cartoon">' + (win ? '\u80dc\u5229\uff01' : '\u518d\u63a5\u518d\u5389') + '</strong><p>' + esc(text) + '</p><div>\u7ecf\u9a8c +' + reward.exp + '\u3000\u91d1\u677e\u679c +' + (reward.gold || 0) + '</div>' + C().upsHtml(reward.ups) + '</div>', buttons);
  }

  let arenaRun = null;
  function saveArenaRun(run) {
    const s = State.state();
    s.classicArenaRun = run ? { kind: run.kind, phase: run.phase, foe: run.foe, finalist: run.finalist, consolation: run.consolation } : null;
    State.save();
  }
  function activeArenaRun() {
    const s = State.state();
    if (arenaRun && arenaRun.owner !== s) arenaRun = null;
    if (!arenaRun && s.classicArenaRun) {
      const saved = s.classicArenaRun;
      if ([0, 1, 2].includes(saved.kind) && ['semi', 'final', 'third'].includes(saved.phase) && saved.foe && saved.finalist && saved.consolation) {
        arenaRun = Object.assign({}, saved, { owner: s, busy: false, settled: false });
      } else { s.classicArenaRun = null; State.save(); }
    }
    return arenaRun;
  }
  // 把"打了一半"的 `busy` 抹掉。`ui-challenge` 回到赛事页时调它 —— 否则刷新 / 关掉页面之后
  // 存档里一直留着 `busy: true`，挑战页那一层永远被判成"战斗中"，再也画不出来（满屏墨绿）。
  function clearArenaBusy() {
    if (arenaRun && arenaRun.busy) arenaRun.busy = false;
    return !!arenaRun;
  }

  function showHint(msg) {
    try {
      if (typeof toast === 'function') { toast(msg); return; }
      if (typeof window !== 'undefined' && window.C && C().toast) C().toast(msg);
    } catch (_) {}
  }

  function claimRankCup() {
    const s = State.state();
    if (s.integral == null) s.integral = 0;
    const cap = State.MAX_PLAYER_LEVEL || 90;
    const mine = Math.max(0, Math.round(Number(s.integral) || 0));
    const entries = [];
    for (let n = 0; n < 4; n++) {
      const name = (window.GData && GData.AI_NAMES && GData.AI_NAMES[n * 4]) || ('鼠王' + (n + 1));
      entries.push({ name, points: 1350 + n * 83, level: Math.min(cap, 34 + n * 6) });
    }
    entries.push({ name: s.name || '我', points: mine, level: Math.round(Number(s.level) || 1), mine: true });
    entries.sort((a, b) => b.points - a.points);
    const rank = entries.findIndex((e) => e.mine) + 1;
    const week = rankWeekKey();
    if (s.rankCupClaimWeek === week) {
      return { ok: false, already: true, rank, cups: 0, goldCup: s.goldCup, msg: '本周的天梯奖励已经领取过了。' };
    }
    if (!(rank > 0 && rank <= 100)) {
      return { ok: false, already: false, rank, cups: 0, goldCup: s.goldCup, msg: '本赛季没有进入前100名，暂时没有金杯奖励。' };
    }
    s.goldCup = Math.max(0, Number(s.goldCup) || 0) + 50;
    s.rankCupClaimWeek = week;
    State.save();
    return { ok: true, already: false, rank, cups: 50, goldCup: s.goldCup, msg: '恭喜进入前100名，成功获得50个金杯奖励！' };
  }


  function arenaRules() {

    if (UI.currentUiMode && UI.currentUiMode() === 'classic' && window.SfChallenge && SfChallenge.goArenaPage) {
      SfChallenge.goArenaPage('rules'); return;
    }
    arena();
  }
  // 「报名参赛」——经典模式竞技场那一页的「开始比赛」走的就是它（见 ui-challenge 的
  // `showArenaRules`）。原版那一下是 `joinArena.do` 开房 → 服务端回 `showRacing2` 落赛事页；
  // 复刻没有服务端，所以在这里本地抽三个对手 + 定赛事局面，再交给 `fightArena` 打第一场。
  function startArenaCompete(kind) {
    const existing = activeArenaRun();
    if (existing) { resumeArena(existing); return; }
    confirmArena(kind || 0);
  }

  function mountArenaCancel(m, onCancel) {
    const footer = find(m.element, '.modal-buttons');
    if (!footer) return;
    const host = document.createElement('div');
    host.className = 'arena-original-back';
    host.style.visibility = 'hidden';
    footer.appendChild(host);
    const fallback = () => {
      if (!footer.isConnected) return;
      if (host.parentNode) host.remove();
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'uc-button gold'; b.textContent = '取消';
      b.onclick = onCancel; footer.appendChild(b);
    };
    const mount = () => {
      if (!window.SfRender || !SfRender.mountSymbol) { fallback(); return; }
      SfRender.mountSymbol(host, '4419', { frame: 1, label: '取消' }).then((view) => {
        if (!footer.isConnected || !view || !view.g) {
          if (view) { try { view.destroy(); } catch (e) {} }
          fallback();
          return;
        }
        let box = null;
        try { box = view.g.getBBox(); } catch (e) { box = null; }
        if (!box || !(box.width > 0) || !(box.height > 0)) {
          try { view.destroy(); } catch (e) {}
          fallback();
          return;
        }
        view.g.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height);
        view.g.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        view.g.style.width = '100%'; view.g.style.height = '100%';
        view.g.style.pointerEvents = 'auto'; view.g.style.cursor = 'pointer';
        view.g.style.outline = 'none';
        view.g.setAttribute('role', 'button');
        view.g.setAttribute('tabindex', '0');
        view.g.setAttribute('aria-label', '取消');

        host.style.width = '200px';
        host.style.height = Math.max(58, Math.round(200 * box.height / box.width * 100) / 100) + 'px';
        host.style.visibility = '';
        const hover = (on) => {
          try { view.gotoAndStop(on ? 2 : 1); } catch (e) {}
        };
        const pressed = (on) => host.classList.toggle('pressed', !!on);
        view.g.addEventListener('pointerenter', () => hover(true));
        view.g.addEventListener('pointerleave', () => { hover(false); pressed(false); });
        view.g.addEventListener('pointerdown', (e) => {
          if (e.button != null && e.button !== 0) return;
          pressed(true);
          try { view.g.setPointerCapture(e.pointerId); } catch (err) {}
        });
        view.g.addEventListener('pointerup', () => pressed(false));
        view.g.addEventListener('pointercancel', () => pressed(false));
        const fire = (e) => {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          pressed(false);
          onCancel();
        };
        view.g.addEventListener('click', fire);
        view.g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
      }).catch(fallback);
    };
    if (window.SfRender && SfRender.loadExtra) {
      SfRender.loadExtra('tags-social-dialog.json').catch(() => {}).then(mount);
    } else {
      mount();
    }
  }

  function chooseArena() {
    const C = () => UI.classic;
    const s = State.state();
    const icon = (id) => (C().icon ? C().icon('prop', id) : '');
    const count = (id) => Math.max(0, Number(s.props[id]) || 0);
    const html = '<div class="arena-pick">' +
      '<button type="button" class="arena-pick-btn" data-arena-kind="0" aria-label="经验竞技场">' +
        '<span class="item-icon">' + icon(36) + '<span class="item-count">×' + count(36) + '</span></span>' +
      '</button>' +
      '<button type="button" class="arena-pick-btn" data-arena-kind="1" aria-label="碎片竞技场">' +
        '<span class="item-icon">' + icon(39) + '<span class="item-count">×' + count(39) + '</span></span>' +
      '</button>' +
      '<button type="button" class="arena-pick-btn" data-arena-kind="2" aria-label="幻兽竞技场">' +
        '<span class="item-icon">' + icon(82) + '<span class="item-count">×' + count(82) + '</span></span>' +
      '</button>' +
      '</div>';
    const m = C().modal('竞技场', html + '<p class="small-label" style="text-align:center;margin-top:10px">召唤证：道具商店 10 金松果/个，或开启魔法袋获得；体力不足 30 时自动使用。</p>', [], { small: true });
    m.element.classList.add('arena-pick-dialog');
    mountArenaCancel(m, m.close);
    m.element.querySelectorAll('[data-arena-kind]').forEach((btn) => {
      btn.onclick = () => {
        if (!btn.isConnected) return;
        m.close();
        startArenaCompete(Number(btn.dataset.arenaKind) || 0);
      };
    });
  }
  function arena() {
    // 经典模式下完全是经典模式。" 报名/开打的流程仍走本文件（原版那套要服务端）。
    if (UI.currentUiMode && UI.currentUiMode() === 'classic' && window.SfChallenge && SfChallenge.goArenaPage) {
      SfChallenge.goArenaPage('home'); return;
    }
    State.tickEnergy();
    const s = State.state(), run = activeArenaRun();

    const cards = [
      { art: 28, name: '\u7ecf\u9a8c\u7ade\u6280\u573a', text: '10\u7ea7\u5f00\u542f\uff0c\u51a0\u519b150\uff0f\u4e9a\u519b100\uff0f\u5b63\u519b50\uff0f\u6bbf\u519b30\u7ecf\u9a8c', action: 'arena-exp' },
      { art: 29, name: '\u788e\u7247\u7ade\u6280\u573a', text: '15\u7ea7\u5f00\u542f\uff0c\u56db\u540d\u4f9d\u6b21\u83b7\u5f978\uff0f6\uff0f4\uff0f3\u84dd\u8272\u788e\u7247', action: 'arena-fragment' },
      { art: 30, name: '\u5929\u68af\u8d5b', text: '30\u7ea7\u5f00\u542f\uff0c\u8d62\u79ef\u5206\u3001\u4e89\u91d1\u676f', action: 'arena-rank' },
    ];
    const resume = run ? '<div class="extra-resume">\u4f60\u5df2\u62a5\u540d\uff0c\u65e0\u9700\u518d\u6b21\u6d88\u8017\u4f53\u529b\u3002' + button(run.phase === 'final' ? '\u7ee7\u7eed\u51b3\u8d5b' : run.phase === 'third' ? '\u7ee7\u7eed\u5b63\u519b\u8d5b' : '\u7ee7\u7eed\u6bd4\u8d5b', 'arena-resume', 'tiny gold') + '</div>' : '';
    let potionHint = '';
    if (s.energy < 30) {
      const deficit = 30 - s.energy;
      const small = s.props[1] || 0, big = s.props[2] || 0;
      const useId = (deficit <= 10 && small) ? 1 : (big ? 2 : (small ? 1 : 0));
      potionHint = useId
        ? '<div class="extra-arena-hint">' + esc('体力不足 30：报名时会自动使用「') + propMap.getValue(useId).name + esc('」补足体力（不需要手动操作）。') + '</div>'
        : '<div class="extra-arena-hint warn">' + esc('体力不足 30：先用本场入场券（经验场英雄帖 / 碎片场勇气徽章，缺了用另一张），最后才喝体力药。') + '</div>';
    }
    const p = C().page('challenge', 'arena', '<div class="extra-arena-cards">' + cards.map(card => '<article>' + sprite(card.art) + '<h2>' + card.name + '</h2><p>' + card.text + '</p>' + button(card.action === 'arena-rank' ? '\u8fdb\u5165\u5929\u68af' : '\u53c2\u52a0\u6bd4\u8d5b', card.action, 'small gold') + '</article>').join('') + '</div><div class="extra-arena-cost">经验场 / 碎片场：4\u4eba\u4e24\u8f6e\u6bd4\u8d5b\uff0c\u534a\u51b3\u8d5b\u80dc\u8005\u4e89\u51a0\u519b\u3001\u8d25\u8005\u4e89\u5b63\u519b\u3002<br>\u62a5\u540d\u6d88\u801730\u4f53\u529b\uff0c\u4f53\u529b\u4e0d\u8db3\u53ef\u4f7f\u7528\u82f1\u96c4\u5e16\u6216\u52c7\u6c14\u5fbd\u7ae0\u3002<br>\u4f53\u529b ' + s.energy + '/' + s.maxEnergy + '\u3000\u82f1\u96c4\u5e16 ' + (s.props[36] || 0) + '\u3000\u52c7\u6c14\u5fbd\u7ae0 ' + (s.props[39] || 0) + '</div>' + resume, { cls: 'extra-board arena-extra-board' });
    on(p, 'arena-exp', () => confirmArena(0));
    on(p, 'arena-fragment', () => confirmArena(1));
    on(p, 'arena-rank', rank);
    on(p, 'arena-resume', () => resumeArena(activeArenaRun()));
  }
  function arenaAccess(kind) {

    const level = kind === 0 ? 10 : 15;
    if (State.state().level >= level) return true;
    const name = kind === 0 ? '\u7ecf\u9a8c\u7ade\u6280\u573a' : kind === 1 ? '\u788e\u7247\u7ade\u6280\u573a' : '\u5e7b\u517d\u7ade\u6280\u573a';
    alert(name + '\u9700\u8981\u8fbe\u5230' + level + '\u7ea7\u3002'); return false;
  }
  function payArenaEntry(s, kind) {
    const NEED = 30;
    const admission = kind === 0 ? 36 : kind === 1 ? 39 : 82;
    const other = kind === 0 ? 39 : 36;
    const freeEnergyDebug = () => !!(typeof window !== 'undefined' && window.Debug && window.Debug.enabled('infiniteEnergy'));
    // 与现代版 `joinArena` 的扣费顺序对齐：
    const takeItem = (id) => {
      const before = Number(s.props[id]) || 0;
      if (!(before > 0)) return false;
      s.props[id] = before - 1;
      if (Number(s.props[id]) !== before - 1) return false;
      State.save();
      return true;
    };
    const payEnergy = () => {
      const before = Number(s.energy) || 0;
      if (!State.consumeEnergy(NEED)) return false;
      const after = Number(s.energy) || 0;
      return after <= before - NEED || freeEnergyDebug();
    };
    if (s.energy >= NEED) {
      if (!payEnergy()) return { ok: false, reason: 'energy-not-deducted' };
      return { ok: true, by: 'energy' };
    }
    if (takeItem(admission)) return { ok: true, by: 'item', itemId: admission };
    if (takeItem(other)) return { ok: true, by: 'item', itemId: other, fallback: true };
    const deficit = NEED - Math.max(0, Number(s.energy) || 0);
    const order = deficit <= 10 ? [1, 2] : [2, 1];
    const per = { 1: 10, 2: 30 };
    let useId = 0;
    for (const id of order) {
      if (!(Number(s.props[id]) > 0)) continue;
      if (s.energy + per[id] >= NEED) { useId = id; break; }
    }
    if (!useId) return { ok: false, reason: 'no-energy-no-item' };
    const potion = State.autoEnergyPotion ? State.autoEnergyPotion(NEED) : { ok: false };
    if (!(potion.ok && s.energy >= NEED)) return { ok: false, reason: 'no-energy-no-item' };
    if (!payEnergy()) return { ok: false, reason: 'energy-not-deducted' };
    return { ok: true, by: 'energy', potionUsed: potion.used || useId };
  }
  function confirmArena(kind) {
    // 报名（体力/入场券/对手抽取/赛事局面）全在服务端做，本地只拿回 `classicArenaRun`。
    if (window.Online && window.Online.ready && window.Online.battle) {
      if (!arenaAccess(kind)) return;
      window.Online.battle.arenaJoin(kind).then((resp) => {
        if (!resp) return;
        arenaRun = null;
        if (window.SfChallenge && SfChallenge.goArenaPage) SfChallenge.goArenaPage('match');
        else arena();
        if (resp.paid && resp.paid.potionUsed && showHint) {
          showHint('体力不足，已自动使用体力药（体力 ' + State.state().energy + '/' + State.state().maxEnergy + '）');
        }
      });
      return;
    }
    const existing = activeArenaRun();
    if (existing) { fightArena(existing); return; }
    if (!arenaAccess(kind)) return;
    const owner = State.state();
    const showConfirm = (title, html, actions, options) => {
      if (UI.currentUiMode && UI.currentUiMode() === 'classic' && window.SfChallenge && SfChallenge.openOriginalConfirm) {
        const ticket = kind === 0 ? '英雄帖' : kind === 1 ? '勇气徽章' : '召唤证';
        const text = (kind === 0 ? '经验竞技场' : kind === 1 ? '碎片竞技场' : '幻兽竞技场') + '\n' +
          '报名消耗30体力，两轮比赛只扣一次。体力不足时使用入场券（' + ticket + '），最后自动补充体力药。\n是否报名参赛？';

        SfChallenge.openOriginalConfirm({ label: title, text, accept: actions[0].run, swapButtons: true, extraGap: 20 })
          .catch(() => showHint('报名确认界面加载失败，请重试。'));
        return;
      }
      return C().modal(title, html, actions, options);
    };
    showConfirm('\u7ade\u6280\u573a\u62a5\u540d', '<p>' + (kind === 0 ? '\u7ecf\u9a8c\u7ade\u6280\u573a' : kind === 1 ? '\u788e\u7247\u7ade\u6280\u573a' : '\u5e7b\u517d\u7ade\u6280\u573a') + '\uff1a\u534a\u51b3\u8d5b\u80dc\u8005\u8fdb\u5165\u51b3\u8d5b\uff0c\u8d25\u8005\u8fdb\u884c\u5b63\u519b\u8d5b\u3002</p><p>\u62a5\u540d\u4e00\u6b21\u6d88\u801730\u4f53\u529b\uff0c\u7b2c\u4e8c\u6218\u4e0d\u518d\u6263\u9664\u3002\u4f53\u529b\u4e0d\u8db3\u65f6\u4f7f\u75281\u5f20\u82f1\u96c4\u5e16/\u52c7\u6c14\u5fbd\u7ae0/\u53ec\u5524\u8bc1\u3002</p>' + note('\u79bb\u7ebf\u5bf9\u624b\u7531\u672c\u5730\u751f\u6210\u3002\u5c5e\u6027\u4e38\u5728\u7ade\u6280\u573a\u65e0\u6548\uff0c\u4e5f\u4e0d\u6263\u6b21\u6570\u3002'), [{ label: '\u62a5\u540d\u53c2\u8d5b', run: () => {
      if (State.state() !== owner || activeArenaRun() || !arenaAccess(kind)) return;
      const s = owner;
      State.tickEnergy();

      const pay = payArenaEntry(s, kind);
      if (!pay.ok) {
        if (pay.reason === 'no-energy-no-item') {
          alert('\u4f53\u529b\u4e0d\u8db330\u70b9\uff0c\u4e5f\u6ca1\u6709\u672c\u573a\u5165\u573a\u5238\uff08\u82f1\u96c4\u5e16/\u52c7\u6c14\u5fbd\u7ae0/\u53ec\u5524\u8bc1\uff09\u3002');
        } else {
          alert('\u7ade\u6280\u573a\u62a5\u540d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002');
        }
        return;
      }
      if (pay.potionUsed) {
        const usedName = propMap.getValue(pay.potionUsed).name;
        showHint('\u4f53\u529b\u4e0d\u8db3\uff0c\u5df2\u81ea\u52a8\u4f7f\u7528 ' + usedName + '\uff08\u4f53\u529b ' + s.energy + '/' + s.maxEnergy + '\uff09\uff0c\u7ee7\u7eed\u53c2\u8d5b');
      }
      const foes = [State.genAI(s.level, '', { statScale: State.RANDOM_FOE_SCALE || 1.08 }), State.genAI(s.level, '', { statScale: State.RANDOM_FOE_SCALE || 1.08 }), State.genAI(s.level, '', { statScale: State.RANDOM_FOE_SCALE || 1.08 })];
      const other = Sim.simulate(foes[1], foes[2]);

      arenaRun = { owner: s, kind, phase: 'semi', foe: foes[0], finalist: foes[other.winner === 0 ? 1 : 2], consolation: foes[other.winner === 0 ? 2 : 1], busy: false, settled: false, matching: true };
      saveArenaRun(arenaRun);
      if (!resumeArena(arenaRun)) fightArena(arenaRun);
    } }, { label: '\u8fd4\u56de', cls: 'muted' }], { small: true });
  }
  function arenaMatchPage() {
    if (window.SfChallenge && SfChallenge.goArenaPage) { SfChallenge.goArenaPage('match'); return true; }
    return false;
  }

  function resumeArena(run) {
    if (!run) return false;
    const classic = !!(window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic');
    if (classic && !run.busy && !run.settled && arenaMatchPage()) return true;
    fightArena(run);
    return false;
  }
  function fightArena(run) {
    // 竞技赛的服务端流程：半决赛→决赛/季军赛，服务端算完把奖励一起发下来。
    if (window.Online && window.Online.ready && window.Online.battle) {
      if (run && run.busy) return;
      window.Online.battle.arenaFight({ target: { arenaPage: 'rules' } }).then((resp) => {
        if (!resp) return;
        arenaRun = null;
        if (resp.arena && resp.arena.rewards && resp.arena.rewards.phase === 'semi') {
          if (window.SfChallenge && SfChallenge.goArenaPage) SfChallenge.goArenaPage('match');
        } else if (window.SfChallenge && SfChallenge.goArenaPage) {
          SfChallenge.goArenaPage('rules');
        } else {
          arena();
        }
      });
      return;
    }
    if (!run || run.busy || run.settled || run.owner !== State.state()) return;
    run.busy = true;
    const phase = run.phase, foe = phase === 'final' ? run.finalist : phase === 'third' ? run.consolation : run.foe;
    let finished = false;
    const interrupted = () => {
      if (finished || run.settled || run.owner !== State.state()) return;
      finished = true; run.busy = false;
      C().toast('\u6bd4\u8d5b\u6682\u65f6\u4e2d\u65ad\uff0c\u672c\u8f6e\u5df2\u4fdd\u5b58\uff0c\u53ef\u56de\u7ade\u6280\u573a\u7ee7\u7eed\u3002');
      arenaMatchPage();
    };

    Main.startBattle(foe, { cost: 0, kind: 'arena', useProps: false, region: 0, skipChest: true, onError: interrupted,

      keepScreen: !!(window.SfChallenge && SfChallenge.goArenaPage),
      onEnd: winner => {
      if (finished || run.settled || run.owner !== State.state()) return;
      finished = true; run.busy = false;

      if (phase === 'semi') {
        const won = winner === 0;
        run.phase = won ? 'final' : 'third'; saveArenaRun(run);
        const gem = won ? State.rollGemDrop(15) : null;
        if (gem) State.save();
        const opponent = won ? run.finalist : run.consolation, title = won ? '\u664b\u7ea7\u51b3\u8d5b' : '\u4e89\u593a\u5b63\u519b';
        arena();
        arenaMatchPage();

        try {

          if (originalResult({ kind: 'arena', title, win: won, player: State.state(), foe: opponent,
            text: gem ? '获得 ' + gem.name + ' ×1。' : '',
            actions: [{ label: won ? '开始决赛' : '开始季军赛', run: () => fightArena(run) }, { label: '稍后继续', run: arena }] })) return;
          C().modal(title, '<div class="extra-finalist">' + image('images/ui/characters/squirrel-classic.png', '\u4e0b\u4e00\u573a\u5bf9\u624b') + '<div><h3>' + (won ? '\u534a\u51b3\u8d5b\u83b7\u80dc\uff01' : '\u8fd8\u6709\u5b63\u519b\u8d5b\uff0c\u7ee7\u7eed\u52a0\u6cb9\uff01') + '</h3><p>\u4e0b\u4e00\u573a\u5bf9\u624b\uff1a' + esc(opponent.name) + '<br>\u7b49\u7ea7 ' + opponent.level + '</p></div></div>' + (gem ? note('\u83b7\u5f97 ' + gem.name + ' \u00d71\uff01') : ''), [{ label: won ? '\u5f00\u59cb\u51b3\u8d5b' : '\u5f00\u59cb\u5b63\u519b\u8d5b', run: () => fightArena(run) }, { label: '\u7a0d\u540e\u7ee7\u7eed', cls: 'muted', run: arena }]);
        } catch (e) { if (window.__errs) window.__errs.push('arena modal: ' + (e && e.message)); }
        return;
      }
      run.settled = true; arenaRun = null;
      const position = phase === 'final' ? (winner === 0 ? 0 : 1) : (winner === 0 ? 2 : 3);

      const kind = Number(run.kind) || 0;
      let baseExp = kind === 0 ? ARENA_EXP[position] : 0;
      let shards = kind === 1 ? ARENA_FRAGMENT_SHARDS[position] : 0;
      const hatch = kind === 2 ? ARENA_HATCH[position] : 0;
      // 领到经验/碎片双倍状态之后，参加竞技场时有几率双倍（几率 = 祭坛当前等级那一档，
      // ⚠ 翻倍必须发生在入账之前：
      // 所以乘的是 `baseExp`，不能等 `boosted.exp` 出来再乘（那样升级结算就对不上了）；
      let buffNote = '';
      if (baseExp && State.activeBuildingBuff && State.activeBuildingBuff('arenaExp')) {
        const rate = State.buildingDoubleRate('altar', 'arenaExp');
        if (rate > 0 && Math.random() * 100 < rate) { baseExp *= 2; buffNote = '祭坛发出神秘的光芒，恭喜你获得了双倍经验奖励！'; }
      }
      if (shards && State.activeBuildingBuff && State.activeBuildingBuff('arenaProp')) {
        const rate = State.buildingDoubleRate('altar', 'arenaProp');
        if (rate > 0 && Math.random() * 100 < rate) { shards *= 2; buffNote = '祭坛发出神秘的光芒，恭喜你获得了双倍碎片奖励！'; }
      }
      const boostPct = baseExp ? State.expBoostPct() : 0;
      const boosted = baseExp ? State.gainExpWithBoost(baseExp) : { exp: 0, ups: [] };
      const exp = boosted.exp;
      if (shards) addProp(26, shards);
      if (hatch) { const st = State.state(); st.hatchPoint = Math.max(0, (Number(st.hatchPoint) || 0) + hatch); }
      const gem = winner === 0 ? State.rollGemDrop(15) : null;
      const ups = boosted.ups;
      if (baseExp) State.tickPropStates({ kind: 'exp' });
      const boostNote = boostPct ? '\uff08\u542b\u7ecf\u9a8c\u4e38 +' + boostPct + '%\uff09' : '';
      // ⚠ `exp` 已经在上面按祭坛状态翻过倍了，这里只负责显示，不能再加一次。
      const buffTail = buffNote ? '\uff01' + buffNote.replace(/！/g, '') : '';
      saveArenaRun(null);
      // ⚠ `arenaMatchPage()` 不要再调：它是"回赛事页"，正是要避开的那一屏。
      arenaRules();
      const backHome = () => arenaRules();
      outcome(winner === 0, { exp, gold: 0, ups, hatch }, '获得' + ['冠军', '亚军', '季军', '第四名'][position] + '！' + (hatch ? '孵化点 ×' + hatch + '。' : (shards ? '蓝色碎片 ×' + shards + (exp ? '、经验 ' + exp + boostNote : '') + '。' : '奖励' + exp + '经验' + boostNote + '。')) + (gem ? '获得 ' + gem.name + ' ×1！' : '') + buffTail, backHome, '返回竞技场');
    } }).catch(interrupted);
  }

  let rankAttempt = null;

  // 每 +25 分 +1 级」换算；联机版的真人匹配由服务端按积分段找，不看这张本地表。
  const RANK_LEVEL_BASE = 30, RANK_INTEGRAL_BASE = 0, RANK_INTEGRAL_PER_LEVEL = 25, RANK_LEVEL_SPREAD = 4;
  function rankFoeLevel(integral, cap) {
    const top = Math.max(1, Math.min(State.MAX_PLAYER_LEVEL || 90, Number(cap) || 90));
    const expect = RANK_LEVEL_BASE + Math.max(0, (Number(integral) || 0) - RANK_INTEGRAL_BASE) / RANK_INTEGRAL_PER_LEVEL;
    const jitter = (Math.random() * 2 - 1) * RANK_LEVEL_SPREAD;
    return Math.max(1, Math.min(top, Math.round(expect + jitter)));
  }

  function rankFoeExpectLevel(integral, cap) {
    const top = Math.max(1, Math.min(State.MAX_PLAYER_LEVEL || 90, Number(cap) || 90));
    return Math.max(1, Math.min(top, Math.round(
      RANK_LEVEL_BASE + Math.max(0, (Number(integral) || 0) - RANK_INTEGRAL_BASE) / RANK_INTEGRAL_PER_LEVEL)));
  }
  function rankWeekKey() {
    const d = new Date(Date.now());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function refreshRankShopDay() {
    // State 是唯一判定源：周账、月度账（永久属性丸）、账号累计账都在这里统一刷新。
    if (State.refreshRankShopDay) return State.refreshRankShopDay();
    State.save();
  }

  const RANK_ACCOUNT_LIMIT_GOODS = Object.freeze(window.__SSDZ_ONLINE__ ? [19] : [7, 8, 9, 10, 19]);
  const RANK_MONTHLY_LIMIT_GOODS = Object.freeze(window.__SSDZ_ONLINE__ ? [7, 8, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23] : []);
  function rankLimitInfo(goods) {
    if (State.rankLimitInfo) return State.rankLimitInfo(goods || {});
    const item = goods || {};
    const s = State.state() || {};
    const id = String(item.id);
    const account = RANK_ACCOUNT_LIMIT_GOODS.includes(Number(item.id));
    const monthly = RANK_MONTHLY_LIMIT_GOODS.includes(Number(item.id));
    const limit = Math.max(0, Math.floor(Number(item.timesLimit) || 0));
    const bag = monthly ? (s.rankMonthPurchases || {}) : account ? (s.rankPurchaseTotals || {}) : (s.rankPurchases || {});
    const bought = Math.max(0, Math.floor(Number(bag[id]) || 0));
    return { account, monthly, limit, bought, remaining: limit > 0 ? Math.max(0, limit - bought) : Infinity };
  }
  // 联机版天梯场次/费用以服务端 `daily` 为真值：存档里的 `joinRankCount` 只给离线分支用，
  function rankDailyNow() {
    const o = window.Online;
    return (o && o.ready && o.daily) ? o.daily : null;
  }
  function rankPlayedNow(s) {
    const d = rankDailyNow();
    if (d) return Math.max(0, Number(d.played) || 0);
    return Math.max(0, Number(s && s.joinRankCount) || 0);
  }
  function rankLimitNow() {
    const d = rankDailyNow();
    if (d) {
      // 让「打满」判断永远不成立；只有显式配了正上限才恢复封顶。
      const limit = Math.max(0, Number(d.limit) || 0);
      return limit > 0 ? limit : Infinity;
    }

    return 20;
  }
  function rankFeeNow(s) {
    const d = rankDailyNow();
    if (d) return Math.max(0, Number(d.cost) || 0);
    const played = Number(s && s.joinRankCount) || 0;
    return played < 10 ? 0 : played < 20 ? 5 : 10;
  }
  function rank() {

    if (window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic' && window.SfChallenge && SfChallenge.goArenaPage) {
      SfChallenge.goArenaPage('ladder');
      return;
    }
    const s = State.state(); State.tickEnergy();
    if (rankAttempt && rankAttempt.owner !== s) rankAttempt = null;

    if (s.integral == null) { s.integral = 0; State.save(); }
    if (s.level < 30) {
      C().modal('\u5929\u68af\u8d5b', '<div class="extra-finalist">' + sprite(30) + '<div><h3>30\u7ea7\u5f00\u542f\u5929\u68af\u8d5b</h3><p>\u5f53\u524d\u7b49\u7ea7\uff1a' + s.level + '<br>\u5148\u53bb\u6311\u6218\u79ef\u7d2f\u7ecf\u9a8c\u5427\uff01</p></div></div>', [{ label: '\u53bb\u6311\u6218', run: () => UI.runAction('challenge') }, { label: '\u8fd4\u56de', cls: 'muted', run: arena }]); return;
    }
    refreshRankShopDay();
    const playedRank = rankPlayedNow(s), rankLimit = rankLimitNow(s);
    const cap = State.MAX_PLAYER_LEVEL || 90;
    const entries = window.__SSDZ_ONLINE__ ? [] : [0, 1, 2, 3, 4, 5].map((n) => ({
      name: GData.AI_NAMES[n * 4], points: 1350 + n * 83, level: Math.min(cap, 34 + n * 6),
    }));
    entries.push({ name: s.name, points: s.integral, level: s.level, mine: true }); entries.sort((a, b) => b.points - a.points);
    const p = C().page('challenge', 'arena', '<div class="extra-rank-layout"><div class="extra-rank-self">' + sprite(30) + '<h2>\u5929\u68af\u8d5b</h2><div class="extra-score">\u79ef\u5206 <b>' + s.integral + '</b></div><div class="extra-score">\u91d1\u676f <b>' + s.goldCup + '</b></div><div class="extra-score">\u5339\u914d\u6863\u4f4d <b>Lv' + rankFoeExpectLevel(s.integral) + '</b></div><p>\u4eca\u65e5\u5df2\u53c2\u8d5b ' + playedRank + ' \u573a' + (Number.isFinite(rankLimit) ? ' / ' + rankLimit : '\uff08\u6bcf\u65e5\u4e0d\u9650\uff09') + '<br>' + (playedRank >= rankLimit ? '\u4eca\u65e5\u53c2\u8d5b\u6b21\u6570\u5df2\u7528\u5b8c' : playedRank < 10 ? '\u672c\u6b21\u514d\u8d39\uff0c\u524d10\u573a\u514d\u8d39' : '\u672c\u6b21\u6d88\u8017' + rankFeeNow(s) + '\u91d1\u677e\u679c') + '</p>' + button('\u5f00\u59cb\u5339\u914d', 'rank-fight', 'small gold') + button('\u91d1\u676f\u5546\u5e97', 'rank-shop', 'small') + '</div><div class="extra-rank-list"><h3>\u672c\u5730\u6a21\u62df\u6392\u884c\u699c</h3>' + entries.map((entry, i) => '<div class="extra-rank-row ' + (entry.mine ? 'mine' : '') + '"><span>' + (i + 1) + '</span><b>' + esc(entry.name) + (entry.mine ? '\uff08\u4f60\uff09' : '') + ' Lv' + (entry.level || 1) + '</b><strong>' + entry.points + '</strong></div>').join('') + note('\u5929\u68af\u8d5b\u6bcf\u5929\u90fd\u53ef\u4ee5\u8fdb\u884c\uff1b\u91d1\u676f\u5546\u5e97\u6bcf\u5929\u5f00\u653e\u3002\u6bcf\u65e5\u6700\u591a20\u573a\uff0c\u524d10\u573a\u514d\u8d39\uff0c\u5176\u540e\u6bcf\u573a5\u91d1\u677e\u679c\u3002\u80dc\u5229\u5f973\u676f\uff0c\u843d\u8d25\u5f971\u676f\u3002\u79ef\u5206\u4e0e\u593a\u676f\u4e3a\u79bb\u7ebf\u6a21\u62df\uff1b\u83b7\u80dc\u670925%\u673a\u4f1a\u989d\u5916\u593a\u5f973\u676f\u3002\u5339\u914d\u5bf9\u624b\u7684\u7b49\u7ea7\u53ea\u8ddf\u79ef\u5206\u6302\u94a9\uff080 \u5206\u5bf9\u5e94 30 \u7ea7\u6863\u3001\u6bcf +25 \u5206 +1 \u7ea7\u3001\u4e0a\u9650 70 \u7ea7\uff09\uff0c\u79ef\u5206\u4e0d\u4f1a\u88ab\u82b1\u6389\uff0c\u6240\u4ee5\u6863\u4f4d\u53ea\u4f1a\u8ddf\u7740\u6218\u7ee9\u8d70\u3002') + '</div></div>', { cls: 'extra-board rank-extra-board' });
    back(p, arena, '\u8fd4\u56de');
    on(p, 'rank-shop', () => rankShop(0));
    const match = on(p, 'rank-fight', () => {
      if (!p.isConnected || State.state() !== s || rankAttempt) return;
      rankMatch();
    });
    match.disabled = playedRank >= rankLimit || !!rankAttempt;
  }
  let rankPrepPending = false;

  function startRankFlow(after, opts) {
    const back = (typeof after === 'function') ? after : rank;
    const o = opts || {};
    const s = State.state();
    if (rankAttempt || rankPrepPending) return;
    State.tickEnergy();
    if (s.level < 30) { alert('天梯赛需要达到30级。'); return; }
    const played = rankPlayedNow(s), limit = rankLimitNow(s);
    if (Number.isFinite(limit) && played >= limit) {
      alert('今天的 ' + limit + ' 场天梯赛已经打完了，明天再来吧！'); return;
    }
    const fee = rankFeeNow(s);
    if (s.goldPoint < fee) { alert('金松果不足：本场需要 ' + fee + ' 个金松果。'); return; }
    if (!o.confirmed && (played === 0 || played > 9)) {

      const seen = Number.isFinite(limit) ? '今日已赛 ' + played + '/' + limit + '。' : '今日已赛 ' + played + ' 场（每日次数不限）。';
      const text = played === 0
        ? '每天前10场免费；第11-20场每场扣除5金松果，第21场起每场扣除10金松果。\n' + seen
        : '本日免费场已打完，本场将扣除' + fee + '金松果。\n' + seen;

      if (window.SfChallenge && SfChallenge.openOriginalConfirm
          && window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic') {
        let fellBack = false;
        const fallback = () => {
          if (fellBack) return;
          fellBack = true;
          C().modal('天梯赛', '<p>' + text.replace(/\n/g, '<br>') + '</p>', [
            { label: '开始比赛', cls: 'gold', run: begin },
            { label: '返回', cls: 'muted' },
          ], { small: true });
        };
        try {
          Promise.resolve(SfChallenge.openOriginalConfirm({
            label: '天梯赛', text, accept: begin, swapButtons: true, extraGap: 20,
          })).then((view) => { if (!view) fallback(); }).catch(fallback);
          return;
        } catch (e) { fallback(); return; }
      }
      C().modal('天梯赛', '<p>' + text.replace(/\n/g, '<br>') + '</p>', [
        { label: '开始比赛', cls: 'gold', run: begin },
        { label: '返回', cls: 'muted' },
      ], { small: true });
      return;
    }
    begin();
    function begin() {
      if (rankAttempt || rankPrepPending || State.state() !== s) return;
      rankPrepPending = true;
      // 联机版对手由服务端匹配（真人 / 500 分以下的 AI），不再弹选人页；
      const online = !!(window.Online && window.Online.ready);
      const go = (foe) => {
        showRankPrep(s, foe).then(() => {
          rankPrepPending = false;
          if (rankAttempt || State.state() !== s) return;
          rankMatch(back, { foe: foe });
        }).catch(() => {
          rankPrepPending = false;
          if (!rankAttempt && State.state() === s) rankMatch(back, { foe: foe });
        });
      };
      if (online) {
        if (!window.OnlineUI || !window.OnlineUI.autoMatch) { rankPrepPending = false; rankMatch(back); return; }
        Promise.resolve(window.OnlineUI.autoMatch()).then((foe) => {
          if (!foe || rankAttempt || State.state() !== s) { rankPrepPending = false; return; }
          go(foe);
        }, () => { rankPrepPending = false; });
        return;
      }
      go(State.genAI(rankFoeLevel(s.integral), '', { statScale: State.RANDOM_FOE_SCALE || 1.08 }));
    }
  }

  async function showRankPrep(s, foe) {
    const ui = document.getElementById('ui');
    if (!ui || !window.SfRender || !SfRender.mountSymbol) { await new Promise((r) => setTimeout(r, 300)); return; }
    const host = document.createElement('section');
    host.className = 'sf-rank-prep ssfight-view';
    host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', '战斗准备中');
    ui.appendChild(host);
    let view = null;
    try {
      try { await SfRender.loadExtra('tags-fight-core.json'); } catch (e) {  }
      if (!host.isConnected || State.state() !== s) return;
      view = await SfRender.mountSymbol(host, '3464', {
        frame: 1, label: '战斗准备中',
        viewBox: '-20 -35 360 250',
        blank: ['name1', 'rank1', 'inte1', 'name2', 'rank2', 'inte2'],
      });
      const set = (name, value) => { const c = view.byName(name); if (c) SfRender.setText(c, String(value == null ? '' : value)); };
      const online = !!(window.Online && window.Online.ready);
      set('name1', s.name || '我'); set('rank1', '—'); set('inte1', s.integral == null ? '—' : s.integral);
      set('name2', foe && foe.name ? foe.name : (online ? '匹配中' : '对手')); set('rank2', '—');
      set('inte2', foe && foe.player && foe.score != null ? foe.score : '—');
      const title = view.byName('title'); if (title && title.gotoAndStop) title.gotoAndStop(1);
    } catch (e) {
      if (window.__errs) window.__errs.push('rank prep: ' + (e && e.message));
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (view) { try { view.destroy(); } catch (e) {} }
    if (host.parentNode) host.parentNode.removeChild(host);
  }
  function rankMatch(after, options) {

    const back = (typeof after === 'function') ? after : rank;
    const opts = options || {};
    // 天梯赛的匹配、积分、金杯、每日 30 场全在服务端。
    // 客户端不再展示「选择对手」页：服务端已按积分/冷却筛好，直接取一位开打；
    if (window.Online && window.Online.ready && window.Online.battle) {
      const s0 = State.state();
      if (s0 && s0.level < 30) { alert('\u5929\u68af\u8d5b\u9700\u8981\u8fbe\u523030\u7ea7\u3002'); return; }
      const target = { tab: 'arena', arenaPage: 'menu' };
      const start = (foe) => {
        if (!foe || !foe.snapshotId) { if (C().toast) C().toast('对手已失效，请重新匹配。'); return; }
        // 战后由 `Online.battle.rank` 自己恢复到天梯菜单（f7），不要再调 `back()`
        window.Online.battle.rank(foe.snapshotId, {
          target,

          again: () => startRankFlow(back, { confirmed: true }),
        }).catch(() => {});
      };
      if (opts.foe && opts.foe.snapshotId) { start(opts.foe); return; }
      if (!window.OnlineUI || !window.OnlineUI.autoMatch) { if (C().toast) C().toast('匹配模块未加载，请重新登录。'); return; }
      window.OnlineUI.autoMatch().then(start).catch((e) => { if (C().toast) C().toast(window.Online.errText(e)); });
      return;
    }
    {
      const s = State.state();
      if (rankAttempt) return;
      State.tickEnergy();
      if (s.level < 30) { alert('\u5929\u68af\u8d5b\u9700\u8981\u8fbe\u523030\u7ea7\u3002'); return; }
      if (s.joinRankCount >= 20) { alert('\u4eca\u5929\u5df2\u7ecf\u53c2\u52a020\u573a\uff0c\u660e\u5929\u518d\u6765\u5427\uff01'); return; }
      const fee = s.joinRankCount < 10 ? 0 : 5;
      if (s.goldPoint < fee) { alert('\u7b2c11\u81f320\u573a\u6bcf\u573a\u9700\u89815\u91d1\u677e\u679c\uff0c\u5f53\u524d\u91d1\u677e\u679c\u4e0d\u8db3\u3002'); return; }
      const classicFlow = !!(window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic' &&
        window.SfChallenge && SfChallenge.goArenaPage);
      const attempt = { owner: s, date: State.localDate(), fee, settled: false };
      rankAttempt = attempt; s.joinRankCount++; s.goldPoint -= fee; State.save();
      const foe = opts.foe || State.genAI(rankFoeLevel(s.integral), '', { statScale: State.RANDOM_FOE_SCALE || 1.08 });
      const interrupted = () => {
        if (attempt.settled || rankAttempt !== attempt || State.state() !== s) return;
        attempt.settled = true; rankAttempt = null;
        State.tickEnergy();
        if (State.localDate() === attempt.date) s.joinRankCount = Math.max(0, s.joinRankCount - 1);
        State.addGold(attempt.fee, { count: false });
        State.save();
        C().toast('\u6bd4\u8d5b\u4e2d\u65ad\uff0c\u672c\u6b21\u53c2\u8d5b\u6b21\u6570\u548c\u8d39\u7528\u5df2\u9000\u8fd8\u3002');
      };
      Main.startBattle(foe, { cost: 0, kind: 'rank', useProps: false, region: 2, skipChest: true, onError: interrupted,
        // 不传这个开关的话 `startBattle` 会先 `showHome()`，而首页的 `renderHome()` 会
        // ⚠ `keepScreen` 分支里 `startBattle` 会把 `mode` 拨回 `home`（见 main.js 那段注释），
        keepScreen: !!(window.SfChallenge && SfChallenge.goArenaPage),
        onEnd: async winner => {
        if (attempt.settled || rankAttempt !== attempt || State.state() !== s) return;
        attempt.settled = true; rankAttempt = null;
        const win = winner === 0, delta = win ? 20 + Math.floor(Math.random() * 15) : -(10 + Math.floor(Math.random() * 10));
        const robbed = win && Math.random() < 0.25 ? 3 : 0, cups = (win ? 3 : 1) + robbed;
        s.integral = Math.max(0, s.integral + delta); s.goldCup += cups; State.save();
        try { await back(); } catch (e) {}
        outcome(win, { exp: 0, gold: 0, ups: [] }, '\u79ef\u5206 ' + (delta > 0 ? '+' : '') + delta + '\uff0c\u91d1\u676f +' + cups + (robbed ? '\uff08\u542b\u593a\u5f973\u676f\uff09' : '') + '\u3002\u5f53\u524d\u79ef\u5206 ' + s.integral + '\u3002', back, '\u8fd4\u56de\u5929\u68af\u8d5b',
          [{ label: '\u7ee7\u7eed\u6311\u6218', cls: 'gold', run: () => (classicFlow ? startRankFlow(back, { confirmed: true }) : rankMatch(back)) }], { kind: 'rank', title: win ? '天梯赛胜利' : '天梯赛失利' });
      } }).catch(interrupted);
    }
  }

  function rankGoodsList() {
    refreshRankShopDay();
    const goods = [];
    rankgoodsMap.each((id, item) => goods.push(item));
    return goods;
  }

  function rankBuy(goodsId, onDone) {
    const s = State.state();
    if (!s) return;
    if (s.level < 30) { alert('天梯商店需要达到30级。'); return; }
    refreshRankShopDay();
    const item = rankgoodsMap.getValue(String(goodsId)) || rankgoodsMap.getValue(Number(goodsId));
    if (!item) return;
    const needCup = Number(item.cup) || 0, needGold = Number(item.gold) || 0, needIntegral = Number(item.integral) || 0;
    const lim = rankLimitInfo(item);
    if (Number(s.integral) < needIntegral) { alert('天梯积分尚未达到兑换要求。'); return; }
    if (Number(s.goldCup) < needCup || Number(s.goldPoint) < needGold) { alert('金杯或金松果不足。'); return; }
    if (lim.limit > 0 && lim.bought >= lim.limit) {
      alert(lim.monthly
        ? '该奖励本月只能兑换 ' + lim.limit + ' 次，下个月 1 号 0 点重置。'
        : lim.account
          ? '该奖励每个账号累计只能兑换 ' + lim.limit + ' 次，已经兑换完了。'
          : '该奖励本周的兑换次数已用完，下周一重置后可再兑换。');
      return;
    }
    const icon = item.type === '2' ? C().icon('gear', +item.goodsId) : C().icon('prop', +item.goodsId);
    let redeemed = false;
    C().modal('金杯兑换',
      '<div class="classic-rank-buy"><span class="item-icon">' + icon + '</span><div>' +
        '<p><b>' + esc(item.name) + '</b></p>' +
        '<p>' + esc(item.remark || '') + '</p>' +
        '<p>需要：<span class="rank-price rank-price-detail"><span class="rank-price-part"><b>' + needCup + '</b>' + C().icon('prop', 40) + '</span><span class="rank-price-part"><b>' + needGold + '</b>' + C().goldIcon() + '</span></span></p>' +
        '<p class="small-label">积分要求 ' + needIntegral +
          (lim.limit > 0 ? ' · ' + (lim.monthly ? '每月限兑 ' : lim.account ? '账号限购 ' : '每周限兑 ') + lim.limit + ' 次（已' + (lim.account ? '购 ' : '兑 ') + lim.bought + '）' : '') + '</p>' +
      '</div></div>',
      [{ label: '返回', cls: 'muted' }, { label: '确认兑换', cls: 'gold', run: () => {
        if (redeemed || State.state() !== s) return;
        // 本地只做展示，不在这里扣账（扣了也会被 patch 回滚）。
        if (window.Online && window.Online.ready) {
          redeemed = true;
          window.StateCall('rankBuy', Number(item.id)).then((r) => {
            if (!r || !r.ok) { redeemed = false; alert((r && r.msg) || '兑换失败'); return; }
            C().toast(r.msg || ('兑换成功：' + item.name));
            if (typeof onDone === 'function') onDone();
          }).catch((e) => { redeemed = false; alert(window.Online.errText(e)); });
          return;
        }
        // 离线兜底也走 State 的唯一购买入口：限购/货币/容量/字典校验只维护一份。
        const r = State.rankBuy(item.id);
        if (!r.ok) { alert(r.msg); return; }
        redeemed = true;
        C().toast(r.msg || ('兑换成功：' + item.name));
        if (typeof onDone === 'function') onDone();
      } }], { small: true });
  }
  function rankShop(pg, origin) {

    if (window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic'
        && UI.classic && UI.classic.openRankShop) {
      UI.classic.openRankShop(pg || 0, origin || 'ladder');
      return;
    }
    const s = State.state();
    if (s.level < 30) { alert('\u5929\u68af\u5546\u5e97\u9700\u8981\u8fbe\u523030\u7ea7\u3002'); return; }
    refreshRankShopDay();
    const goods = []; rankgoodsMap.each((id, item) => goods.push(item));
    const total = Math.ceil(goods.length / 6); pg = Math.max(0, Math.min(pg || 0, total - 1));
    const selected = goods.slice(pg * 6, pg * 6 + 6);
    const limitOf = (item) => {
      const lim = rankLimitInfo(item);
      return lim.limit > 0 ? (lim.monthly ? '每月限兑 ' : lim.account ? '账号限购 ' : '每周限兑 ') + lim.limit + ' 次（已' + (lim.account ? '购 ' : '兑 ') + lim.bought + '）' : '';
    };
    const p = C().page('bag', 'shop', '<div class="extra-shop-balance">\u91d1\u676f ' + s.goldCup + '\u3000\u91d1\u677e\u679c ' + s.goldPoint + '\u3000\u79ef\u5206 ' + s.integral + '</div><div class="extra-shop-grid">' + selected.map(item => '<button class="extra-shop-item" data-goods="' + item.id + '">' + (item.type === '2' ? image('images/ui/icons/gear/gear-' + item.goodsId + '.png', item.name) : C().icon('prop', +item.goodsId)) + '<b>' + esc(item.name) + '</b><span>' + item.cup + '\u91d1\u676f + ' + item.gold + '\u91d1\u677e\u679c</span><small>\u79ef\u5206\u9700 ' + item.integral + (limitOf(item) ? ' \u00b7 ' + limitOf(item) : '') + '</small></button>').join('') + '</div><div class="extra-pagination">' + button('\u4e0a\u4e00\u9875', 'rank-shop-prev', 'tiny muted') + '<span>' + (pg + 1) + '/' + total + '</span>' + button('\u4e0b\u4e00\u9875', 'rank-shop-next', 'tiny muted') + '</div>', { cls: 'extra-board extra-cup-shop' });
    back(p, rank, '\u8fd4\u56de\u5929\u68af\u8d5b');
    on(p, 'rank-shop-prev', () => rankShop(Math.max(0, pg - 1)));
    on(p, 'rank-shop-next', () => rankShop(Math.min(total - 1, pg + 1)));
    p.querySelectorAll('[data-goods]').forEach(element => element.onclick = () => {
      const item = rankgoodsMap.getValue(element.dataset.goods);
      let redeemed = false;
      C().modal('\u91d1\u676f\u5151\u6362', '<p>\u5151\u6362\u3010' + esc(item.name) + '\u3011</p><p>' + esc(item.remark) + '</p><p>\u9700\u8981\uff1a' + item.cup + '\u91d1\u676f\u3001' + item.gold + '\u91d1\u677e\u679c\uff0c\u79ef\u5206\u8fbe\u5230' + item.integral + '\u3002</p>', [{ label: '\u786e\u8ba4\u5151\u6362', run: () => {
        if (redeemed || State.state() !== s) return;
        const r = State.rankBuy(item.id);
        if (!r.ok) { alert(r.msg); return; }
        redeemed = true;
        C().toast(r.msg || ('\u5151\u6362\u6210\u529f\uff1a' + item.name)); rankShop(pg);
      } }, { label: '\u8fd4\u56de', cls: 'muted' }], { small: true });
    });
  }


  const NORMAL_PILLS = [3, 4, 5, 7];

  const SUPER_PILLS = [41, 42, 43, 44];
  const SUPER_PILL_CHANCE = 0.05;
  // 奖池的权威副本在 `GData.LOTTERY_PRIZES`（服务端开奖只认它）；这里保留一份
  // 同内容的 fallback，防止老资源快照/单机包没加载到新字段时抽奖页直接空掉。
  const prizes = [
    { id: 22, count: 10, label: '\u6b66\u5668\u5377\u8f74 \u00d710' }, { id: 21, count: 10, label: '\u6280\u80fd\u5377\u8f74 \u00d710' },
    { id: 26, count: 3, label: '\u84dd\u8272\u788e\u7247 \u00d73' }, { id: 15, exp: 50, label: '\u7ecf\u9a8c +50' },
    { id: 15, exp: 100, label: '\u7ecf\u9a8c +100' }, { id: 8, gold: 40, label: '\u91d1\u677e\u679c +40' },

    { id: 23, count: 2, label: '\u6311\u6218\u4e66 \u00d72' }, { id: 2, count: 2, label: '\u5927\u4f53\u529b\u836f\u5242 \u00d72' },

    { id: 7, pills: 1, superChance: SUPER_PILL_CHANCE, label: '\u968f\u673a\u836f\u4e38 \u00d71' }, { id: 36, count: 2, label: '\u82f1\u96c4\u5e16 \u00d72' },
  ];
  const lotteryPrizeTable = () => (window.GData && Array.isArray(GData.LOTTERY_PRIZES) && GData.LOTTERY_PRIZES.length)
    ? GData.LOTTERY_PRIZES : prizes;
  let spinning = false, lotteryVersion = 0, lotteryBackPage = null;

  const lotteryIcon = (id) => (Number(id) === 8 && C().goldIcon) ? C().goldIcon() : C().icon('prop', id);
  /* 奖品格里的道具图标：原版矢量的 viewBox 松紧差很多（蓝色碎片留白一半、金松果几乎贴边），
   * 同样是 94×84 的格子会一大一小。这里把每个图标重设成「以画面实际占位为准」的正方形 viewBox，
   * 十个奖品格视觉尺寸才一致；先内联成 <svg> 再量 getBBox（联机版没有旧安卓那条替换路径）。 */
  function fitPrizeArt(svg) {
    if (!svg || String(svg.tagName).toLowerCase() !== 'svg' || svg.__artBox) return;
    let box; try { box = svg.getBBox(); } catch (e) { return; }
    if (!box || !(box.width > 0) || !(box.height > 0)) return;
    svg.__artBox = 1;
    const span = Math.max(box.width, box.height) * 1.08;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    svg.setAttribute('viewBox', (cx - span / 2) + ' ' + (cy - span / 2) + ' ' + span + ' ' + span);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  function normalizePrizeArt(root) {
    if (!root || !root.querySelectorAll) return;
    for (const icon of root.querySelectorAll('.extra-prize > img, .extra-prize > svg, .extra-lottery-win > img, .extra-lottery-win > svg')) {
      if (String(icon.tagName).toLowerCase() === 'svg') { fitPrizeArt(icon); continue; }
      const api = C();
      if (!api || !api.inlineSvgIcon) continue;
      api.inlineSvgIcon(icon).then(fitPrizeArt).catch(() => {});
    }
  }
  function refreshLotteryDay() {
    const s = State.state(), today = State.localDate(), legacyToday = new Date(Date.now()).toDateString();
    if (s.lotteryDate === today) return;
    if (s.lotteryDate !== legacyToday) s.lotteryFree = 1;
    s.lotteryDate = today; State.save();
  }
  function refreshTickets() {
    const s = State.state(); if (!s) return;
    const n = s.props[50] || 0;
    // 注意：`$$` 是 classic-ui.js 内部的局部函数、不是全局，所以这里自己查 DOM。
    // 没有真实 DOM 时（单测的沙箱）静默跳过 —— 刷新展示失败不该中断存档流程。
    const paint = (sel) => {
      const root = (typeof document !== 'undefined' && document) ? document : null;
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll(sel).forEach((el) => { el.textContent = n; });
    };
    paint('[data-lottery-ticket]');
    paint('[data-live-ticket]');
    if (window.UI && UI.refreshHeader) { try { UI.refreshHeader(); } catch (e) {  } }
  }
  function lottery() {
    // 客户端只播放动画、展示服务端返回的结果。单机版仍在本地结算。
    const online = !!(window.Online && window.Online.ready);
    const table = lotteryPrizeTable();
    const version = ++lotteryVersion;
    spinning = false;

    if (lotteryBackPage && C().destroyClassicBack) {
      try { C().destroyClassicBack(lotteryBackPage); } catch (e) {}
    }
    lotteryBackPage = null;
    refreshLotteryDay();
    const s = State.state();
    const TICKET = 50;


    const affordable = (n) => Math.max(0, s.lotteryFree || 0) + Math.max(0, s.props[TICKET] || 0)
      + Math.floor(Math.max(0, s.goldPoint) / 20) >= n;
    const spinLabel = () => (s.lotteryFree > 0 ? '免费抽奖'
      : (s.props[TICKET] || 0) > 0 ? '用抽奖卷抽奖' : '20 金松果抽奖');
    // 一次抽奖的立即结算（扣费顺序：每日免费 → 抽奖卷 → 20 金松果）。
    const settleOne = () => {
      if (s.lotteryFree > 0) s.lotteryFree--;
      else if (s.props[TICKET] > 0) { s.props[TICKET]--; if (s.props[TICKET] <= 0) delete s.props[TICKET]; }
      else s.goldPoint -= 20;
      const selected = Math.floor(Math.random() * table.length), prize = table[selected] || table[0];
      let label = prize.label, icon = prize.id, superPill = false;
      if (prize.pills) {
        superPill = Math.random() < (Number(prize.superChance) || 0);
        const pillPool = superPill ? SUPER_PILLS : NORMAL_PILLS;
        const pid = pillPool[Math.floor(Math.random() * pillPool.length)];
        addProp(pid, prize.pills);
        label = (propMap.getValue(pid) || { name: pid }).name + ' \u00d7' + prize.pills +
          (superPill ? '\uff08\u9ad8\u7ea7\uff01\uff09' : '');
        icon = pid;
      }
      if (prize.gold) State.addGold(prize.gold);
      if (prize.count) addProp(prize.id, prize.count);
      const ups = prize.exp ? State.gainExp(prize.exp) : [];
      if (State.bumpDaily) State.bumpDaily('lottery', 1);
      return { label, icon, selected, ups, superPill };
    };
    // 联机：一次请求抽 n 次（1~10），服务端按免费→抽奖卷→20 金松果扣费并开奖。
    const serverDraw = (n) => {
      if (!window.StateCall) return Promise.reject(new Error('联机抽奖未就绪'));
      return window.StateCall('lotteryDraw', n);
    };

    const content = '<h2 class="extra-lottery-heading cartoon">\u6bcf\u65e5\u5e78\u8fd0\u62bd\u5956</h2>' +
      '<div class="lottery-ticket-corner">\u62bd\u5956\u5377 <b data-lottery-ticket>' + (s.props[TICKET] || 0) + '</b> \u5f20</div>' +
      '<div class="extra-lottery-prizes">' +
      table.map((prize, i) => '<div class="extra-prize" data-prize="' + i + '">' + lotteryIcon(prize.id) + '<span>' + prize.label + '</span></div>').join('') +
      '</div>' +
      '<div class="extra-lottery-footer"><div><b data-lottery-status>\u4eca\u65e5\u514d\u8d39 ' + s.lotteryFree + ' \u6b21</b></div>' +
      '<div class="lottery-buttons">' +
      button(spinLabel(), 'lottery-spin', 'gold') + (ONLINE ? '' : button('\u8fde\u62bd 10 \u6b21', 'lottery-spin10', 'gold')) + '</div></div>';

    const p = C().page('bag', 'bag', content, { cls: 'extra-board lottery-extra-board', noFooter: true });
    lotteryBackPage = p;
    normalizePrizeArt(p);
    if (C().installTabVectors) C().installTabVectors(p);
    if (C().wirePopTaps) C().wirePopTaps(p, { tabs: true });
    const leaveLottery = () => {
      if (C().destroyClassicBack) { try { C().destroyClassicBack(p); } catch (e) {} }
      lotteryBackPage = null;
      UI.runAction('bag');
    };
    if (C().mountClassicBack) C().mountClassicBack(p, leaveLottery);
    // 从顶部页签切走时也收掉 3911 的视图（否则旧页面被移除后它还在播放表里）。
    if (p.addEventListener) {
      p.addEventListener('click', (ev) => {
        const hit = ev.target && ev.target.closest ? ev.target.closest('.classic-tabs .uc-tab') : null;
        if (!hit) return;
        if (C().destroyClassicBack) { try { C().destroyClassicBack(p); } catch (e) {} }
        lotteryBackPage = null;
      }, true);
    }


    const animateThen = (steps, done) => {
      let step = 0;
      const walk = () => {
        if (version !== lotteryVersion) return;
        if (!p.isConnected) { spinning = false; return; }
        p.querySelectorAll('[data-prize]').forEach((cell) => cell.classList.toggle('lit', +cell.dataset.prize === step % table.length));
        if (step++ < steps) { setTimeout(walk, step > steps - 5 ? 125 : 55); return; }
        done();
      };
      walk();
    };
    const setBusy = (busy) => {
      p.querySelectorAll('.lottery-buttons .uc-button').forEach((b) => { b.disabled = busy; });
      const one = find(p, '[data-action="lottery-spin"]');
      if (one) one.textContent = busy ? '\u62bd\u5956\u4e2d\u2026' : spinLabel();
      const ten = find(p, '[data-action="lottery-spin10"]');
      if (ten) ten.textContent = busy ? '\u62bd\u5956\u4e2d\u2026' : '\u8fde\u62bd 10 \u6b21';
    };

    const afterDraw = () => {
      spinning = false; setBusy(false);
      const fresh = State.state() || s;
      const st = find(p, '[data-lottery-status]');
      if (st) st.textContent = '\u4eca\u65e5\u514d\u8d39 ' + Math.max(0, Number(fresh.lotteryFree) || 0) + ' \u6b21';
      refreshTickets();
      if (UI.refreshHeader) UI.refreshHeader();
    };

    const spin = on(p, 'lottery-spin', async () => {
      if (version !== lotteryVersion || !p.isConnected || spinning) return;
      refreshLotteryDay();
      if (!affordable(1)) { alert('\u91d1\u677e\u679c\u4e0d\u8db320\u4e14\u6ca1\u6709\u62bd\u5956\u5377\uff0c\u660e\u5929\u8fd8\u6709\u4e00\u6b21\u514d\u8d39\u673a\u4f1a\u3002'); return; }
      spinning = true; setBusy(true);
      let got;
      if (online) {
        let out;
        try { out = await serverDraw(1); }
        catch (e) { spinning = false; setBusy(false); alert(window.Online.errText(e)); return; }
        if (!out || !out.ok || !out.draws || !out.draws.length) {
          spinning = false; setBusy(false); alert((out && out.msg) || '抽奖失败，请稍后再试。'); return;
        }
        got = out.draws[0];
      } else {
        got = settleOne();
        State.save();
      }
      if (version !== lotteryVersion || !p.isConnected) { spinning = false; return; }
      animateThen(20 + Number(got.selected || 0), () => {
        afterDraw();
        const win = C().modal('\u83b7\u5f97\u5956\u52b1', '<div class="extra-lottery-win">' + lotteryIcon(got.icon) + '<strong>' + esc(got.label) + '</strong></div>' + C().upsHtml(got.ups || []), [{ label: '\u786e\u5b9a' }], { small: true });
        normalizePrizeArt(win && win.element);
      });
    });
    spin.disabled = spinning;

    // 十连抽入口与逻辑都不出现（服务端也只按单抽开奖）。
    if (!ONLINE) {
    const spin10 = on(p, 'lottery-spin10', async () => {
      if (version !== lotteryVersion || !p.isConnected || spinning) return;
      refreshLotteryDay();
      if (!affordable(10)) {
        alert('\u8fde\u62bd 10 \u6b21\u9700\u8981 10 \u6b21\u7684\u8d44\u6e90\uff1a\u4eca\u65e5\u514d\u8d39 ' + Math.max(0, s.lotteryFree || 0) +
          ' \u6b21 + \u62bd\u5956\u5377 ' + Math.max(0, s.props[TICKET] || 0) + ' \u5f20 + \u91d1\u677e\u679c ' +
          Math.max(0, s.goldPoint) + '\uff08\u6bcf\u6b21 20\uff09\u3002');
        return;
      }
      spinning = true; setBusy(true);
      let got = [];
      if (online) {
        let out;
        try { out = await serverDraw(10); }
        catch (e) { spinning = false; setBusy(false); alert(window.Online.errText(e)); return; }
        if (!out || !out.ok || !out.draws || !out.draws.length) {
          spinning = false; setBusy(false); alert((out && out.msg) || '抽奖失败，请稍后再试。'); return;
        }
        got = out.draws;
        if (got.length < 10 && C().toast) C().toast('资源只够抽 ' + got.length + ' 次。');
      } else {
        for (let i = 0; i < 10; i++) got.push(settleOne());
        State.save();
      }
      if (version !== lotteryVersion || !p.isConnected) { spinning = false; return; }
      animateThen(24, () => {
        afterDraw();
        const cells = got.map((g) => '<div class="extra-prize won">' + lotteryIcon(g.icon) +
          '<span>' + esc(g.label) + '</span></div>').join('');
        const ups = [];
        for (const g of got) if (g.ups && g.ups.length) ups.push.apply(ups, g.ups);
        const winTen = C().modal('\u8fde\u62bd ' + got.length + ' \u6b21', '<div class="extra-lottery-win grid"><div class="lottery-result-grid">' +
          cells + '</div></div>' + C().upsHtml(ups), [{ label: '\u786e\u5b9a' }], { small: true });
        normalizePrizeArt(winTen && winTen.element);
      });
    });
    spin10.disabled = spinning;
    }
  }

  const MASTER_CANDIDATE_COUNT = 3;
  const RECRUIT_CANDIDATE_COUNT = 3;


  function rollMasterCandidates() {
    const s = State.state();
    const cap = State.MAX_PLAYER_LEVEL || 90;
    const base = Math.max(3, Math.min(s.level, cap));
    return Array.from({ length: MASTER_CANDIDATE_COUNT }, () => {
      const level = Math.min(cap, Math.max(2, base + 2 + Math.floor(Math.random() * 11)));
      return State.genAI(level, '', { levelJitter: 0, gearSelfLevel: true });
    });
  }

  function rollRecruitCandidates() {
    const s = State.state();
    const cap = State.MAX_PLAYER_LEVEL || 90;
    return Array.from({ length: RECRUIT_CANDIDATE_COUNT }, () => {
      const base = Math.max(1, s.level + (Math.random() < 0.5 ? -2 : 0));
      const foe = State.genAI(base, '', { levelJitter: 2, gearSelfLevel: true });
      foe.level = Math.max(1, Math.min(cap, Math.min(foe.level, s.level + 1)));
      return foe;
    });
  }

  function profileStats(row) {
    const pills = [['\u529b', row.power], ['\u654f', row.agility], ['\u901f', row.speed], ['\u547d', row.hp]]
      .map(([k, v]) => '<div class="stat-pill"><b>' + k + '</b>' + esc(v == null ? '-' : v) + '</div>').join('');
    return '<div class="mini-stats">' + pills + '</div>';
  }
  function profileGear(row) {
    const w = (row.weapons || []).map((x) => {
      const inst = State.weaponInst(x);
      return inst ? esc(inst.name) + ' Lv' + inst.level : null;
    }).filter(Boolean);
    const sk = (row.skills || []).map((x) => {
      const inst = State.skillInst(x);
      return inst ? esc(inst.name) + ' Lv' + inst.level : null;
    }).filter(Boolean);
    return '<div class="profile-gear"><span class="profile-gear-label">\u6b66\u5668</span><div>' + (w.length ? w.join('\u3001') : '<em>\u7a7a\u624b</em>') + '</div>' +
      '<span class="profile-gear-label">\u6280\u80fd</span><div>' + (sk.length ? sk.join('\u3001') : '<em>\u65e0</em>') + '</div></div>';
  }
  function masterProfile(row) {
    if (!row) return '\u9009\u62e9\u4e00\u4f4d\u67e5\u770b\u5c5e\u6027';
    return '<div class="profile-panel">' + profileStats(row) + profileGear(row) + '</div>';
  }
  function apprenticeProfile(row) {
    const daily = State.apprenticeDailyStatus(row);
    const sum = State.apprenticeLevelSum(State.state().prentices);
    const pct = (v) => (Math.round(v * 1000) / 10) + '%';
    return '<div class="profile-panel">' +
      '<p class="profile-meta">入门：' + esc(row.since) + '</p>' +

      '<p class="profile-meta">徒弟等级之和 <b>' + sum + '</b> → 日供系数：经验 <b>' +
        pct(daily.expRatio != null ? daily.expRatio : daily.ratio) + '</b> · 金松果 <b>' +
        pct(daily.goldRatio != null ? daily.goldRatio : daily.ratio) + '</b>' +
        '（线性插值：经验 5%~15%、金松果 5%~25%，三个满级徒弟封顶）</p>' +
      '<p class="profile-meta">我 ' + esc(daily.date) + ' 赚到：经验 ' + daily.mine.exp + ' · 金松果 ' + daily.mine.gold + '</p>' +
      '<p class="profile-meta">这个徒弟的份额 ' + pct(daily.weight) + ' → 昨日日贡：' +
        (daily.claimed ? '<b class="done">已领取</b>' : '<b>经验 ' + daily.exp + ' · 金松果 ' + daily.gold + '</b>') +
        (daily.newApprentice ? '（今日新收，次日才开始结算）' : '') + '</p>' +
      profileStats(row) + profileGear(row) + '</div>';
  }

  let masterCandidates = [], recruitCandidates = [];
  let masterSel = 0, recruitSel = 0, apprenticeSel = 0, recruitBusy = false, recruitOwner = null;
  let masterTab = 'master';
  // 师徒页的数据全在服务端：真人关系、人机师父候选、真人徒弟候选与日供。
  let onlineMasterData = null, onlineMasterCands = null, onlineMasterFetching = false, onlineMasterSeq = 0;

  // 活动页（每日礼包那一屏）与师徒页共用这一条路径 —— 两边按钮都调 claimTribute()，

  function tributeRows() {
    if (window.Online && window.Online.ready) {
      return ((onlineMasterData && onlineMasterData.prentices) || []).map((p) => ({
        name: p.name, level: p.level, exp: p.tribute.exp, gold: p.tribute.gold,
        claimable: p.tribute.claimable, claimed: p.tribute.claimed,
      }));
    }
    return (State.state().prentices || []).map((p) => {
      const d = State.apprenticeDailyStatus(p);
      return { name: p.name, level: p.level, exp: d.exp, gold: d.gold, claimable: d.claimable, claimed: d.claimed };
    });
  }
  // 活动页那张日供卡要显示的状态：能不能领 / 领过了 / 还没徒弟。
  function tributeStatus() {
    if (window.Online && window.Online.ready) {
      dropStaleOnlineMaster();
      if (!onlineMasterData && !onlineMasterPromise) fetchOnlineMaster();
      const rows = tributeRows();
      const exp = rows.reduce((n, r) => n + (r.claimable ? r.exp : 0), 0);
      const gold = rows.reduce((n, r) => n + (r.claimable ? r.gold : 0), 0);
      const claimable = exp > 0 || gold > 0;
      // 还没拉到服务端数据时至少用存档镜像的徒弟数，别把「有徒弟」显示成「去收徒」。
      const mirrorCount = (State.state().prentices || []).length;
      return {
        rows, exp, gold, count: rows.length || mirrorCount, claimable,
        claimed: rows.length > 0 && !claimable && rows.every((r) => r.claimed),
        online: true,
      };
    }
    const rows = tributeRows(), total = State.apprenticeDailyTotal();
    const claimable = (total.exp > 0 || total.gold > 0);
    return {
      rows, exp: total.exp, gold: total.gold, count: rows.length, claimable,
      claimed: rows.length > 0 && !claimable && rows.every((r) => r.claimed),
    };
  }
  // 领日供 + 结算弹窗。`after` 在玩家确认后回调（活动页用它重画弹窗，师徒页用它回页）。
  // `opts.silent=true` 时不弹结算面板（活动页一屏直领）：刷新师徒缓存后只弹一条汇总 toast。
  function claimTribute(after, opts) {
    const silent = !!(opts && opts.silent);
    const done = () => { if (after) after(); };
    // 日供由服务端按真人徒弟昨日的收益结算；客户端只展示结果。
    if (window.Online && window.Online.ready) {
      const c = C();
      if (c && c.toast) c.toast('正在结算昨日日供…');
      window.Online.post('/api/apprentice/tribute', { rev: window.Online.rev }, { preserveMirror: true })
        .then(async (r) => {
          onlineMasterData = null;
          if (!r || !r.ok) { if (c && c.toast) c.toast((r && r.msg) || '暂无可领取的昨日日供'); done(); return; }
          if (silent) {

            if (onlineMasterPromise) { try { await onlineMasterPromise; } catch (_) {} }
            onlineMasterData = null;
            await fetchOnlineMaster();
            const parts = [];
            if (Number(r.totalExp) > 0) parts.push('经验 +' + r.totalExp);
            if (Number(r.totalGold) > 0) parts.push('金松果 +' + r.totalGold);
            if (c && c.toast) c.toast('徒弟日供：' + (parts.join('，') || '已结算'));
            done();
            return;
          }
          const card = (cls, art, label, value) => value > 0
            ? '<div class="reward-card ' + cls + '"><span class="reward-icon">' + art + '</span>' +
              '<span class="reward-text">' + label + ' +' + esc(value) + '</span></div>' : '';
          const cards = card('green', '<img alt="" class="reward-icon-img" src="images/ui/icons/prop/prop-15.svg">', '经验', r.totalExp) +
            card('gift', c && c.goldIcon ? c.goldIcon() : (c ? c.icon('prop', 8) : ''), '金松果', r.totalGold);
          const detail = (r.details || []).length
            ? '<div class="tribute-rows">' + r.details.map((x) =>
                '<div class="tribute-row"><b class="tribute-name">' + esc(x.name) + '</b>' +
                '<span class="tribute-gain">经验 +' + esc(x.exp) + '　金松果 +' + esc(x.gold) + '</span></div>').join('') +
              '<p class="tribute-foot">共 ' + (r.details || []).length + ' 位真人徒弟的昨日日供</p></div>'
            : '';
          if (c && c.modal) {
            c.modal('徒弟日供', '<div class="tribute-claim">' +
              '<div class="reward-panel"><div class="reward-row">' + (cards || '<span class="tribute-none">昨日没有可结算的收益</span>') + '</div></div>' +
              detail + '</div>' + (c.upsHtml ? c.upsHtml(r.ups) : ''),
              [{ label: '确定', run: done }], { small: true });
          }
        })
        .catch((e) => { if (c && c.toast) c.toast(window.Online.errText(e)); done(); });
      return { ok: true, pending: true };
    }
    const rows = tributeRows().filter((r) => r.claimable);
    const r = State.claimApprenticeExp();
    if (!r.ok) { C().toast(r.msg); done(); return r; }
    if (silent) {
      const parts = [];
      if (Number(r.total) > 0) parts.push('经验 +' + r.total);
      if (Number(r.gold) > 0) parts.push('金松果 +' + r.gold);
      C().toast('徒弟日供：' + (parts.join('，') || '已结算'));
      done();
      return r;
    }

    const card = (cls, art, label, value) => value > 0
      ? '<div class="reward-card ' + cls + '"><span class="reward-icon">' + art + '</span>' +
        '<span class="reward-text">' + label + ' +' + esc(value) + '</span></div>' : '';
    const cards = card('green', '<img alt="" class="reward-icon-img" src="images/ui/icons/prop/prop-15.svg">', '经验', r.total) +
      card('gift', C().goldIcon ? C().goldIcon() : C().icon('prop', 8), '金松果', r.gold);
    const detail = rows.length
      ? '<div class="tribute-rows">' + rows.map((x) =>
          '<div class="tribute-row"><b class="tribute-name">' + esc(x.name) + '</b>' +
          '<span class="tribute-level">Lv' + esc(x.level) + '</span>' +
          '<span class="tribute-gain">经验 +' + esc(x.exp) + '　金松果 +' + esc(x.gold) + '</span></div>').join('') +
        '<p class="tribute-foot">共 ' + rows.length + ' 位徒弟的昨日日供</p></div>'
      : '';
    C().modal('徒弟日供', '<div class="tribute-claim">' +
        '<div class="reward-panel"><div class="reward-row">' + (cards || '<span class="tribute-none">昨日没有可结算的收益</span>') + '</div></div>' +
        detail +
      '</div>' + C().upsHtml(r.ups),
      [{ label: '确定', run: done }], { small: true });
    return r;
  }
  // · 拜师人机：候选由服务端按「账号 + 日期」确定性生成，客户端只交下标；
  // · 日供只由真人徒弟产生（昨日经验 10% + 金松果 10%），服务端结算；
  // · 逐出/出师同步两边的存档与服务端师徒表。
  let onlineMasterPromise = null;
  let onlineMasterOwner = '';
  function onlineMasterOwnerId() {
    try { return String((window.Net && Net.account && Net.account() || {}).accountId || ''); } catch (_) { return ''; }
  }
  // 账号切换/退出后旧账号的师徒缓存必须作废，否则新账号会看到上一个人的徒弟。
  function dropStaleOnlineMaster() {
    if (onlineMasterData && onlineMasterOwner !== onlineMasterOwnerId()) {
      onlineMasterData = null; onlineMasterCands = null;
    }
  }
  function fetchOnlineMaster() {
    if (onlineMasterPromise) return onlineMasterPromise;
    const s = State.state(), seq = ++onlineMasterSeq, owner = onlineMasterOwnerId();
    const O = window.Online;
    onlineMasterPromise = Promise.all([
      O.get('/api/apprentice'),
      O.get('/api/apprentice/candidates'),
    ]).then(([data, cands]) => {
      if (seq !== onlineMasterSeq || State.state() !== s || owner !== onlineMasterOwnerId()) return null;
      onlineMasterData = data; onlineMasterCands = cands; onlineMasterOwner = owner;
      return data;
    }).catch((e) => {
      const c = C();
      if (c && c.toast) c.toast(O.errText(e));
      return null;
    }).finally(() => { onlineMasterPromise = null; });
    return onlineMasterPromise;
  }
  function cheerName(stat) {
    return ({ power: '力量', agility: '敏捷', speed: '速度' })[stat] || '';
  }
  function cheerText(summary) {
    const counts = (summary && summary.counts) || {};
    const parts = ['power', 'agility', 'speed'].filter((k) => Number(counts[k]) > 0)
      .map((k) => cheerName(k) + ' +' + Number(counts[k]) * 5 + '%');
    return parts.length ? parts.join(' · ') : '暂无';
  }
  function onlinePrenticeDetail(p) {
    if (!p) return '选择一位徒弟查看详情';
    const d = p.tribute || {};
    const c = p.cheer;
    return '<div class="profile-panel">' +
      '<p class="profile-meta">入门：' + esc(p.since || '—') + '</p>' +
      '<p class="profile-meta">加油：' + (c && c.stat ? '<b>' + cheerName(c.stat) + ' +5%</b>' + (c.active ? '（生效中）' : '（等待新师父）') : '未加油') + '</p>' +
      '<p class="profile-meta">昨日日供：' +
        (d.claimed ? '<b class="done">已领取</b>' : '<b>经验 ' + esc(d.exp || 0) + ' · 金松果 ' + esc(d.gold || 0) + '</b>') +
        (d.newPrentice ? '（今日新收，次日才开始结算）' : '') + '</p>' +
      profileStats(p.stats || p) + profileGear(p.stats || p) + '</div>';
  }
  function onlineRecruitDetail(c) {
    if (!c) return '选择一位可收服的徒弟';
    return '<div class="profile-panel">' +
      '<p class="profile-meta">' + (c.master
        ? '他的师父：' + esc(c.master.name) + '（Lv' + esc(c.master.level) + (c.master.bot ? ' · 人机' : '') +
          '）—— 收徒挑战要先打败他'
        : '他没有师父 —— 收徒挑战直接挑战他本人') + '</p>' +
      profileStats(c.stats || c) + profileGear(c.stats || c) + '</div>';
  }
  async function onlineMaster(tab, opts) {
    const o = opts || {};
    if (tab === 'master' || tab === 'apprentice') masterTab = tab;
    dropStaleOnlineMaster();
    const s = State.state();
    if (o.refresh || !onlineMasterData || !onlineMasterCands) {
      if (o.refresh) { const c = C(); if (c && c.toast) c.toast('正在刷新师徒数据…'); }
      const data = await fetchOnlineMaster();
      if (!data || State.state() !== s) return;
    }
    renderOnlineMaster();
  }
  function renderOnlineMaster() {
    if (!window.Online || !window.Online.ready || !onlineMasterData) return;
    dropStaleOnlineMaster();
    if (!onlineMasterData) return;
    const c = C();
    if (!c || !c.page) return;
    const md = onlineMasterData, cands = onlineMasterCands || { masters: [], prentices: [] };
    const bots = Array.isArray(cands.masters) ? cands.masters : [];
    const recruits = Array.isArray(cands.prentices) ? cands.prentices : [];
    const prentices = Array.isArray(md.prentices) ? md.prentices : [];
    const cap = Number(md.cap) || 3;
    const master = md.master;
    const cfg = md.config || {};
    if (masterSel >= bots.length) masterSel = 0;
    if (recruitSel >= recruits.length) recruitSel = 0;
    if (apprenticeSel >= prentices.length) apprenticeSel = 0;

    const masterBlock = master
      ? '<h2>我的师父</h2><div class="extra-master-current"><div class="master-head"><b>' + esc(master.name) + '</b>' +
        '<span>等级 ' + esc(master.level) + (master.bot ? ' · 人机' : '') + '</span></div>' +
        masterProfile(master) +
        (master.bot ? '' : '<p class="extra-master-tip">你为师父加油：' +
          (md.myCheer && md.myCheer.active ? '<b>' + cheerName(md.myCheer.stat) + ' +5%</b>（已生效）' : '还没有加油') +
          '。每个徒弟一次，随机一项属性 +5%，只在师父主动战斗时生效。</p>') +
        '<div class="master-actions">' +
        (master.bot || (md.myCheer && md.myCheer.active) ? '' : button('为师父加油', 'master-cheer', 'tiny gold')) +
        button('出师（' + Number(cfg.leaveCost || 20) + '金松果）', 'master-leave', 'tiny muted') + '</div></div>' +
        '<p class="extra-master-tip">已学会「师父驾到」：发动时恢复师父等级 ×4 的生命，且下一次攻击必中。' +
        (master.bot ? '人机师父不产生日供，只负责技能与面板。' : '') + '</p>'
      : '<h2>拜师学艺</h2>' +
        '<p class="extra-master-tip">可以拜一位人机师父；别的玩家也可以在天梯/好友里对你发起收徒挑战。拜师成功后自动学会「师父驾到」。</p>' +
        '<div class="candidate-row">' + bots.map((c, i) =>
          '<div class="candidate-card' + (masterSel === i ? ' active' : '') + '" data-master="' + i + '">' +
          '<b class="candidate-name">' + esc(c.name) + '</b>' +
          '<span class="candidate-level">等级 ' + esc(c.level) + '</span>' +
          '<span class="candidate-hp">生命 ' + esc(c.hp) + '</span>' +
          '<span class="candidate-hp">装备 ' + ((c.gears || []).length) + '</span></div>').join('') + '</div>' +
        '<div class="candidate-detail">' + masterProfile(bots[masterSel]) + '</div>' +
        '<div class="master-actions">' + button('刷新师父', 'master-refresh') +
        (bots[masterSel] ? button('拜他为师', 'master-join', 'gold') : '') + '</div>';

    const total = md.tribute || { exp: 0, gold: 0, claimable: 0 };
    const claimable = Number(total.claimable || 0) > 0;
    const apprenticeBlock =
      '<div class="extra-apprentice-title"><h3>我的徒弟（' + prentices.length + '/' + cap + '）</h3>' +
      (claimable ? button('领取昨日日供 +' + Number(total.exp || 0) + '经验 +' + Number(total.gold || 0) + '金松果', 'master-claim', 'tiny gold')
        : '<span class="daily-done">' + (prentices.length ? '暂无可领昨日日供' : '还没有徒弟') + '</span>') + '</div>' +
      '<p class="extra-master-tip">日供只由真人徒弟产生：徒弟昨日经验的 ' +
        Math.round(Number(cfg.expRate || 0.1) * 100) + '% 与金松果的 ' + Math.round(Number(cfg.goldRate || 0.1) * 100) +
        '%，次日领取；人机徒弟不产生日供。</p>' +
      '<p class="extra-master-tip">徒弟加油：' + cheerText(md.oiling) +
        '（只影响你的主动战斗；被动/防守快照无效，最高 +15%）</p>' +
      '<div class="apprentice-row">' + (prentices.length
        ? prentices.map((a, i) => '<div class="candidate-card small' + (apprenticeSel === i ? ' active' : '') + '" data-prentice="' + i + '">' +
            '<b class="candidate-name">' + esc(a.name) + '</b><span class="candidate-level">等级 ' + esc(a.level) + '</span>' +
            '<span class="candidate-hp">' + (a.tribute.claimed ? '昨日日供已领' : '昨日 经验+' + Number(a.tribute.exp || 0) + ' 金松果+' + Number(a.tribute.gold || 0)) + '</span></div>').join('')
        : '<p class="empty-hint">还没有徒弟，先在下方对可收服的徒弟发起收徒挑战。</p>') + '</div>' +
      (prentices[apprenticeSel] ? '<div class="candidate-detail">' + onlinePrenticeDetail(prentices[apprenticeSel]) + '</div>' : '') +
      (prentices[apprenticeSel] ? '<div class="master-actions">' + button('让他离开师门', 'prentice-leave', 'tiny muted') + '</div>' : '') +
      '<div class="extra-apprentice-title"><h3>可收服的徒弟</h3>' + button('刷新徒弟', 'recruit-refresh', 'tiny') + '</div>' +
      '<div class="candidate-row">' + recruits.map((c, i) =>
        '<div class="candidate-card' + (recruitSel === i ? ' active' : '') + '" data-recruit="' + i + '">' +
        '<b class="candidate-name">' + esc(c.name) + '</b>' +
        '<span class="candidate-level">等级 ' + esc(c.level) + '</span>' +
        '<span class="candidate-hp">' + (c.master ? (c.master.bot ? '人机师父' : '有师父') : '无师父') + '</span></div>').join('') + '</div>' +
      '<div class="candidate-detail">' + onlineRecruitDetail(recruits[recruitSel]) + '</div>' +
      '<div class="master-actions">' +
      (recruits[recruitSel] ? button('收徒挑战（' + Number(cfg.recruitCost || 10) + '金松果）', 'master-recruit', 'gold') : '') +
      (prentices.length >= cap ? '<span class="daily-done">收徒名额已满（' + cap + '）</span>' : '') +
      '</div>';

    const p = c.page('system', 'village', '<div class="extra-master-layout">' +
      image('images/ui/characters/master-classic.png', '师父', 'extra-master-portrait') +
      '<div class="extra-master-main">' +
      '<div class="master-tabs">' +
        '<button type="button" class="uc-tab' + (masterTab === 'master' ? ' active' : '') + '" data-mtab="master">师父</button>' +
        '<button type="button" class="uc-tab' + (masterTab === 'apprentice' ? ' active' : '') + '" data-mtab="apprentice">徒弟</button>' +
      '</div>' +
      '<div class="master-panel">' + (masterTab === 'apprentice' ? apprenticeBlock : masterBlock) + '</div>' +
      note('联机版师徒关系保存在服务器；收真人徒弟需要先击败对方的师父（没有师父则击败本人），' +
        '成功与否都会花费 ' + Number(cfg.recruitCost || 10) + ' 个金松果。') + '</div></div>',
      { cls: 'extra-board master-extra-board' });
    back(p, () => UI.runAction('village'), '返回村庄');

    p.querySelectorAll('[data-mtab]').forEach((el) => el.onclick = () => { masterTab = el.dataset.mtab; renderOnlineMaster(); });
    p.querySelectorAll('[data-master]').forEach((el) => el.onclick = () => { masterSel = Number(el.dataset.master); renderOnlineMaster(); });
    p.querySelectorAll('[data-recruit]').forEach((el) => el.onclick = () => { recruitSel = Number(el.dataset.recruit); renderOnlineMaster(); });
    p.querySelectorAll('[data-prentice]').forEach((el) => el.onclick = () => { apprenticeSel = Number(el.dataset.prentice); renderOnlineMaster(); });

    const O = window.Online;
    const reload = (after) => { onlineMasterData = null; fetchOnlineMaster().then(() => { if (after) after(); else renderOnlineMaster(); }); };
    on(p, 'master-refresh', () => { if (c && c.toast) c.toast('正在刷新师父候选…'); reload(); });
    on(p, 'master-cheer', () => {
      if (!O || !O.ready) return;
      if (c && c.toast) c.toast('正在为师父加油…');
      O.post('/api/apprentice/cheer', {}, { preserveMirror: true })
        .then((r) => {
          if (!r || !r.ok) { if (c && c.toast) c.toast((r && r.msg) || '加油失败'); return; }
          if (c && c.toast) c.toast(r.msg || '为师父加油成功！');
          reload();
        })
        .catch((e) => { if (c && c.toast) c.toast(O.errText(e)); });
    });
    on(p, 'recruit-refresh', () => { reload(); });
    on(p, 'master-join', () => {
      if (!O || !p.isConnected) return;
      const busy = p.dataset.busy; if (busy) return; p.dataset.busy = '1';
      O.post('/api/apprentice/master', { index: masterSel, rev: O.rev }, { preserveMirror: true })
        .then((r) => {
          p.dataset.busy = '';
          if (!r || !r.ok) { if (c.toast) c.toast((r && r.msg) || '拜师失败'); return; }
          onlineMasterData = null;
          fetchOnlineMaster().then(() => renderOnlineMaster());
          c.modal('拜师成功', '<div class="extra-finalist">' + image('images/ui/characters/master-classic.png', '师父') +
            '<div><h3>师父：' + esc((r.master && r.master.name) || '人机师父') + '（' + esc((r.master && r.master.level) || 1) + '级）</h3>' +
            '<p>已学会【师父驾到】</p><p class="extra-master-tip">发动「师父驾到」可恢复师父等级 ×4 的生命，且下一次攻击必中。</p></div></div>',
            [{ label: '看师父', run: () => onlineMaster('master') }]);
        })
        .catch((e) => { p.dataset.busy = ''; c.toast(O.errText(e)); });
    });
    on(p, 'master-leave', () => {
      if (!O || !p.isConnected) return;
      const cost = Number(cfg.leaveCost || 20);
      if (Number(State.state().goldPoint || 0) < cost) { alert('金松果不足 ' + cost + '，无法出师。'); return; }
      c.modal('出师', '<p>确定离开【' + esc((master && master.name) || '师父') + '】的师门吗？需要花费 ' + cost +
        ' 金松果，之后可以重新拜师。</p>', [{ label: '确认出师', run: () => {
          O.post('/api/apprentice/leave', { rev: O.rev }, { preserveMirror: true })
            .then(() => { onlineMasterData = null; c.toast('已离开师门'); reload(); })
            .catch((e) => c.toast(O.errText(e)));
        } }, { label: '返回', cls: 'muted' }], { small: true });
    });
    on(p, 'master-claim', () => claimTribute(() => reload()));
    on(p, 'prentice-leave', () => {
      const a = prentices[apprenticeSel];
      if (!a || !O) return;
      c.modal('让徒弟离开', '<p>让【' + esc(a.name) + '】离开师门，空出一个收徒位置？</p>' +
        (md.kickedToday ? '<p class="extra-master-tip">今天已经踢过一个徒弟了，要等明天。</p>' : ''),
        md.kickedToday ? [{ label: '确定', cls: 'muted' }] : [
          { label: '确认', run: () => {
            O.post('/api/apprentice/kick', { targetAccountId: a.accountId, rev: O.rev }, { preserveMirror: true })
              .then((r) => { c.toast('已让【' + a.name + '】离开师门'); onlineMasterData = null; reload(); })
              .catch((e) => c.toast(O.errText(e)));
          } }, { label: '返回', cls: 'muted' }], { small: true });
    });
    on(p, 'master-recruit', () => {
      const cand = recruits[recruitSel];
      if (!cand || !O || recruitBusy) return;
      const need = cand.master ? (cand.master.bot ? '先击败对方的人机师父' : '先击败对方的师父【' + cand.master.name + '】') : '对方没有师父，直接挑战本人';
      c.modal('收徒挑战', '<p>收【' + esc(cand.name) + '】为徒：' + esc(need) + '。</p>' +
        '<p class="extra-master-tip">花费 ' + Number(cfg.recruitCost || 10) + ' 金松果与 ' +
        Number(cfg.recruitEnergy || 10) + ' 体力，成功与否都不退还。</p>',
        [{ label: '发起挑战', cls: 'gold', run: () => {
          if (recruitBusy) return;
          recruitBusy = true;
          Promise.resolve(O.battle && O.battle.recruit ? O.battle.recruit(cand.accountId, { target: { action: 'master' } }) : null)
            .finally(() => { recruitBusy = false; });
        } }, { label: '返回', cls: 'muted' }], { small: true });
    });
  }

  function master(tab) {
    // 师徒关系、候人与日供都在服务端；整页数据从 `/api/apprentice` 拉。
    if (window.Online && window.Online.ready) { onlineMaster(tab); return; }
    if(recruitOwner !== State.state()){recruitBusy=false;recruitOwner=State.state();masterCandidates=[];recruitCandidates=[];}
    if (tab === 'master' || tab === 'apprentice') masterTab = tab;
    const s = State.state();
    if (!masterCandidates.length) masterCandidates = rollMasterCandidates();
    if (!recruitCandidates.length) recruitCandidates = rollRecruitCandidates();
    const cap = State.apprenticeCap(s.level);
    const hasMasterSkill = s.skills.some((x) => Number(String(x).split(':')[0]) === State.MASTER_SKILL_ID);

    const masterBlock = s.master
      ? '<h2>\u6211\u7684\u5e08\u7236</h2><div class="extra-master-current"><div class="master-head"><b>' + esc(s.master.name) + '</b>' +
        '<span>\u7b49\u7ea7 ' + esc(s.master.level) + '</span></div>' +
        masterProfile(s.master) +
        '<div class="master-actions">' + button('\u51fa\u5e08\uff0820\u91d1\u677e\u679c\uff09', 'master-leave', 'tiny muted') + '</div></div>' +
        '<p class="extra-master-tip">\u5df2\u5b66\u4f1a\u300c\u5e08\u7236\u9a7e\u5230\u300d\uff1a\u53d1\u52a8\u65f6\u6062\u590d\u5e08\u7236\u7b49\u7ea7 \u00d74 \u7684\u751f\u547d\uff0c\u4e14\u4e0b\u4e00\u6b21\u653b\u51fb\u5fc5\u4e2d\u3002' +
        (hasMasterSkill ? '' : ' <b>\uff08\u6280\u80fd\u7f3a\u5931\uff0c\u91cd\u65b0\u62dc\u5e08\u53ef\u8865\u56de\uff09</b>') + '</p>'
      : '<h2>\u62dc\u5e08\u5b66\u827a</h2>' +
        '<p class="extra-master-tip">\u62dc\u5e08\u6210\u529f\u540e\u81ea\u52a8\u5b66\u4f1a\u300c\u5e08\u7236\u9a7e\u5230\u300d\u3002\u70b9\u5217\u8868\u91cc\u7684\u5e08\u7236\u53ef\u67e5\u770b\u4ed6\u7684\u5c5e\u6027\u4e0e\u6b66\u5668\u6280\u80fd\u3002</p>' +
        '<div class="candidate-row">' + masterCandidates.map((c, i) =>
          '<div class="candidate-card' + (masterSel === i ? ' active' : '') + '" data-master="' + i + '">' +
          '<b class="candidate-name">' + esc(c.name) + '</b>' +
          '<span class="candidate-level">\u7b49\u7ea7 ' + c.level + '</span>' +
          '<span class="candidate-hp">\u751f\u547d ' + c.hp + '</span>' +
          '<span class="candidate-hp">\u88c5\u5907 ' + (c.gears || []).length + '</span></div>').join('') + '</div>' +
        '<div class="candidate-detail">' + masterProfile(masterCandidates[masterSel]) + '</div>' +
        '<div class="master-actions">' + button('\u5237\u65b0\u5e08\u7236', 'master-refresh') +
        (masterCandidates[masterSel] ? button('\u62dc\u4ed6\u4e3a\u5e08', 'master-join', 'gold') : '') + '</div>';

    const dailyTotal = State.apprenticeDailyTotal();
    const unclaimed = dailyTotal.exp > 0 || dailyTotal.gold > 0;
    const apprenticeBlock =
      '<div class="extra-apprentice-title"><h3>\u6211\u7684\u5f92\u5f1f\uff08' + s.prentices.length + '/' + cap + '\uff09</h3>' +
      (unclaimed ? button('\u9886\u53d6\u6628\u65e5\u65e5\u8d21 +' + dailyTotal.exp + '\u7ecf\u9a8c +' + dailyTotal.gold + '\u91d1\u677e\u679c', 'master-claim', 'tiny gold') : '<span class="daily-done">\u6682\u65e0\u53ef\u9886\u6628\u65e5\u65e5\u8d21</span>') + '</div>' +
      '<p class="extra-master-tip">\u65e5\u4f9b = \u5f92\u5f1f\u7b49\u7ea7\u4e4b\u548c\u51b3\u5b9a\u7684\u7cfb\u6570 \u00d7 \u6211\u81ea\u5df1\u6628\u65e5\u8d5a\u5230\u7684\u603b\u7ecf\u9a8c\u4e0e\u91d1\u677e\u679c\uff0c\u6b21\u65e5\u9886\u53d6\uff1a\u4fdd\u5e95 10%\uff0c\u5f92\u5f1f\u7b49\u7ea7\u4e4b\u548c 210\uff08\u4e09\u4e2a\u6ee1\u7ea7\uff09\u5c01\u9876 50%\uff0c\u4e2d\u95f4\u7ebf\u6027\u9012\u589e\u3002</p>' +
      '<div class="apprentice-row">' + (s.prentices.length
        ? s.prentices.map((a, i) => '<div class="candidate-card small' + (apprenticeSel === i ? ' active' : '') + '" data-prentice="' + i + '">' +
            '<b class="candidate-name">' + esc(a.name) + '</b><span class="candidate-level">\u7b49\u7ea7 ' + a.level + '</span>' +
            '<span class="candidate-hp">\u6628\u65e5 \u7ecf\u9a8c+' + State.apprenticeDailyExp(a) + ' \u91d1\u677e\u679c+' + State.apprenticeDailyGold(a) + '</span></div>').join('')
        : '<p class="empty-hint">\u8fd8\u6ca1\u6709\u5f92\u5f1f\uff0c\u5148\u5728\u4e0b\u65b9\u5bf9\u53ef\u6536\u670d\u7684\u5f92\u5f1f\u53d1\u8d77\u6536\u5f92\u6311\u6218\u3002</p>') + '</div>' +
      (s.prentices[apprenticeSel] ? '<div class="candidate-detail">' + apprenticeProfile(s.prentices[apprenticeSel]) + '</div>' : '') +
      (s.prentices[apprenticeSel] ? '<div class="master-actions">' + button('\u8ba9\u4ed6\u79bb\u5f00\u5e08\u95e8', 'prentice-leave', 'tiny muted') + '</div>' : '') +
      '<div class="extra-apprentice-title"><h3>\u53ef\u6536\u670d\u7684\u5f92\u5f1f</h3>' + button('\u5237\u65b0\u5f92\u5f1f', 'recruit-refresh', 'tiny') + '</div>' +
      '<div class="candidate-row">' + recruitCandidates.map((c, i) =>
        '<div class="candidate-card' + (recruitSel === i ? ' active' : '') + '" data-recruit="' + i + '">' +
        '<b class="candidate-name">' + esc(c.name) + '</b>' +
        '<span class="candidate-level">\u7b49\u7ea7 ' + c.level + '</span>' +
        '<span class="candidate-hp">\u751f\u547d ' + c.hp + '</span>' +
        '<span class="candidate-hp">\u88c5\u5907 ' + (c.gears || []).length + '</span></div>').join('') + '</div>' +
      '<div class="candidate-detail">' + masterProfile(recruitCandidates[recruitSel]) + '</div>' +
      '<div class="master-actions">' +
      (recruitCandidates[recruitSel] ? button('\u6536\u5f92\u6311\u6218\uff0810\u91d1\u677e\u679c\uff09', 'master-recruit', 'gold') : '') +
      (s.prentices.length >= cap ? '<span class="daily-done">\u6536\u5f92\u540d\u989d\u5df2\u6ee1\uff08' + cap + '\uff09</span>' : '') +
      '</div>';

    const p = C().page('system', 'village', '<div class="extra-master-layout">' +
      image('images/ui/characters/master-classic.png', '\u5e08\u7236', 'extra-master-portrait') +
      '<div class="extra-master-main">' +
      '<div class="master-tabs">' +
        '<button type="button" class="uc-tab' + (masterTab === 'master' ? ' active' : '') + '" data-mtab="master">\u5e08\u7236</button>' +
        '<button type="button" class="uc-tab' + (masterTab === 'apprentice' ? ' active' : '') + '" data-mtab="apprentice">\u5f92\u5f1f</button>' +
      '</div>' +
      '<div class="master-panel">' + (masterTab === 'apprentice' ? apprenticeBlock : masterBlock) + '</div>' +
      note('\u5e08\u5f92\u5173\u7cfb\u4fdd\u5b58\u4e8e\u672c\u5730\uff1b\u5e08\u7236\u4e0e\u5f92\u5f1f\u5747\u7531\u672c\u5730\u968f\u673a\u751f\u6210\u3002') + '</div></div>',
      { cls: 'extra-board master-extra-board' });
    back(p, () => UI.runAction('village'), '\u8fd4\u56de\u6751\u5e84');

    p.querySelectorAll('[data-mtab]').forEach((el) => el.onclick = () => { masterTab = el.dataset.mtab; master(); });
    p.querySelectorAll('[data-master]').forEach((el) => el.onclick = () => { masterSel = Number(el.dataset.master); master(); });
    p.querySelectorAll('[data-recruit]').forEach((el) => el.onclick = () => { recruitSel = Number(el.dataset.recruit); master(); });
    p.querySelectorAll('[data-prentice]').forEach((el) => el.onclick = () => { apprenticeSel = Number(el.dataset.prentice); master(); });
    on(p, 'master-refresh', () => { masterCandidates = rollMasterCandidates(); masterSel = 0; C().toast('\u5df2\u5237\u65b0\u5e08\u7236\u5217\u8868'); master(); });
    on(p, 'recruit-refresh', () => { recruitCandidates = rollRecruitCandidates(); recruitSel = 0; C().toast('\u5df2\u5237\u65b0\u53ef\u6536\u670d\u5f92\u5f1f'); master(); });
    on(p, 'master-join', () => {
      const cand = masterCandidates[masterSel];
      if (!cand || s.master) return;
      const r = State.setMaster(cand);
      if (!r.ok) { alert(r.msg); return; }
      masterCandidates = [];
      C().modal('\u62dc\u5e08\u6210\u529f', '<div class="extra-finalist">' + image('images/ui/characters/master-classic.png', '\u5e08\u7236') +
        '<div><h3>\u5e08\u7236\uff1a' + esc(cand.name) + '\uff08' + cand.level + '\u7ea7\uff09</h3>' +
        '<p>' + esc((r.learned && r.learned.msg) || '\u5df2\u5b66\u4f1a\u3010\u5e08\u7236\u9a7e\u5230\u3011') + '</p>' +
        '<p class="extra-master-tip">\u53d1\u52a8\u300c\u5e08\u7236\u9a7e\u5230\u300d\u53ef\u6062\u590d\u5e08\u7236\u7b49\u7ea7 \u00d74 \u7684\u751f\u547d\uff0c\u4e14\u4e0b\u4e00\u6b21\u653b\u51fb\u5fc5\u4e2d\u3002</p></div></div>',
        [{ label: '\u770b\u5e08\u7236', run: () => master('master') }, { label: '\u8fd4\u56de', cls: 'muted', run: () => master('master') }]);
    });
    on(p, 'master-leave', () => {
      if(!p.isConnected || State.state()!==s || !s.master)return;
      const cost = 20;
      const leavingMaster=s.master;
      let left=false;
      if (s.goldPoint < cost) { alert('\u9000\u5e08\u95e8\u9700\u8981 ' + cost + ' \u91d1\u677e\u679c\uff0c\u73b0\u5728\u53ea\u6709 ' + s.goldPoint + '\u3002'); return; }
      C().modal('\u51fa\u5e08', '<p>\u786e\u5b9a\u79bb\u5f00\u3010' + esc(s.master.name) + '\u3011\u7684\u5e08\u95e8\u5417\uff1f\u9700\u8981\u82b1\u8d39 ' + cost + ' \u91d1\u677e\u679c\uff0c\u4e4b\u540e\u53ef\u4ee5\u91cd\u65b0\u62dc\u5e08\u3002</p>',
        [{ label: '\u786e\u8ba4\u51fa\u5e08', run: () => {
          if(left || State.state()!==s || s.master!==leavingMaster)return;
          if(s.goldPoint<cost){alert('\u91d1\u677e\u679c\u4e0d\u8db320\uff0c\u65e0\u6cd5\u51fa\u5e08\u3002');return;}
          left=true;s.goldPoint-=cost;State.clearMaster();State.save();C().toast('\u5df2\u79bb\u5f00\u5e08\u95e8');master();
        } },
         { label: '\u8fd4\u56de', cls: 'muted' }], { small: true });
    });
    on(p, 'master-claim', () => claimTribute(() => master('apprentice')));
    on(p, 'prentice-leave', () => {
      const a = s.prentices[apprenticeSel];
      if (!a) return;
      const canKick = State.canKickToday();
      C().modal('\u8ba9\u5f92\u5f1f\u79bb\u5f00', '<p>\u8ba9\u3010' + esc(a.name) + '\u3011\u79bb\u5f00\u5e08\u95e8\uff0c\u7a7a\u51fa\u4e00\u4e2a\u6536\u5f92\u4f4d\u7f6e\uff1f</p>' +
        (canKick ? '' : '<p class="extra-master-tip">\u4eca\u5929\u5df2\u7ecf\u8e22\u8fc7\u4e00\u4e2a\u5f92\u5f1f\u4e86\uff0c\u8981\u7b49\u660e\u5929\u3002</p>'),
        canKick
          ? [{ label: '\u786e\u8ba4', run: () => { const r = State.kickPrentice(a.name); C().toast(r.msg); apprenticeSel = 0; master('apprentice'); } },
             { label: '\u8fd4\u56de', cls: 'muted' }]
          : [{ label: '\u786e\u5b9a', cls: 'muted' }], { small: true });
    });
    on(p, 'master-recruit', () => {
      if (recruitBusy || !p.isConnected || State.state()!==s) return;
      const started=State.beginRecruitChallenge(recruitCandidates[recruitSel]);
      if(!started.ok){alert(started.msg);return;}
      recruitBusy = true;
      let settled = false;
      const interrupted=()=>{
        if(settled)return;settled=true;recruitBusy=false;
        if(State.state()!==s)return;
        State.cancelRecruitChallenge(started.token);C().toast('\u6536\u5f92\u6311\u6218\u4e2d\u65ad\uff0c\u5df2\u9000\u8fd810\u91d1\u677e\u679c\u3002');
      };
      try { Promise.resolve(Main.startBattle(started.foe, {
        kind: 'master', useProps: true, region: 0,
        onError:interrupted,
        onEnd: (winner) => {
          if (settled) return; settled = true; recruitBusy = false;
          if(State.state()!==s)return;
          const result=State.finishRecruitChallenge(started.token,winner===0);
          if(!result.ok)return;
          if (result.recruited) { recruitCandidates = rollRecruitCandidates(); recruitSel = 0; apprenticeSel = s.prentices.length - 1; masterTab = 'apprentice'; }
          master(masterTab);
          outcome(result.win, result, result.msg, () => master('apprentice'), '\u8fd4\u56de\u5e08\u5f92');
        },
      })).catch(interrupted); } catch(error){interrupted();}
    });
  }


  let toplistTab = 'level';

  const RANK_LEVEL = 30;
  const TOPLIST_TABS = [['level', '\u7b49\u7ea7'], ['cup', '\u91d1\u676f'], ['integral', '\u79ef\u5206']];
  const TOPLIST_TITLES = ['\u677e\u9f20\u5c0f\u9738', '\u68ee\u6797\u4e00\u9738', '\u98ce\u901f\u4f20\u5947', '\u575a\u679c\u5927\u738b',
    '\u677e\u9f20\u5c0f\u9738\u4e8c\u4e16', '\u68a6\u5e7b\u6a61\u5b50', '\u91d1\u677e\u679c\u5b88\u62a4\u8005', '\u6708\u5149\u98de\u9f20',
    '\u96fe\u6797\u730e\u624b', '\u96ea\u539f\u65c5\u4eba', '\u53e4\u6811\u5b88\u671b\u8005', '\u661f\u8fb0\u4e4b\u5f71'];
  let toplistCache = Object.create(null);
  function rankWeekSeed() {
    const d = new Date(Date.now());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function toplistRows() {
    const s = State.state(), seed = rankWeekSeed(), key = seed + ':' + s.level + ':' + s.goldCup + ':' + (s.integral || 0);
    if (toplistCache[key]) return toplistCache[key];
    const rnd = mulberry(seed);
    const ladderTab = toplistTab !== 'level';
    const cap = State.MAX_PLAYER_LEVEL || 90;
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const base = Math.max(5, Math.min(cap, Math.round(s.level + (rnd() * 26 - 12))));
      const lv = ladderTab ? Math.max(RANK_LEVEL, base) : base;
      const inLadder = lv >= RANK_LEVEL;
      rows.push({
        name: TOPLIST_TITLES[i % TOPLIST_TITLES.length],
        level: lv,
        cup: inLadder ? 2 + Math.floor(rnd() * Math.max(6, lv)) : 0,
        integral: inLadder ? 900 + Math.floor(rnd() * Math.max(400, lv * 70)) : 0,
        inLadder: inLadder,
        npc: true,
      });
    }
    const qualified = s.level >= RANK_LEVEL;
    rows.push({
      name: s.name, level: s.level,
      cup: qualified ? (s.goldCup || 0) : 0,
      integral: qualified ? (s.integral || 0) : 0,
      inLadder: qualified, npc: false,
    });
    const sortKey = toplistTab === 'cup' ? 'cup' : toplistTab === 'integral' ? 'integral' : 'level';
    rows.sort((a, b) => (b[sortKey] - a[sortKey]) || a.name.localeCompare(b.name));
    toplistCache[key] = rows;
    return rows;
  }
  function toplist() {
    State.tickEnergy();
    const s = State.state();
    const key = toplistTab === 'cup' ? 'cup' : toplistTab === 'integral' ? 'integral' : 'level';
    const rows = toplistRows();
    const ladderTab = key === 'cup' || key === 'integral';
    const qualified = s.level >= RANK_LEVEL;
    const mine = ladderTab && !qualified ? null : rows.findIndex((r) => !r.npc) + 1;
    const rankText = mine ? '<b>' + mine + '</b> / ' + rows.length
      : '<span class="toplist-locked">\u672a\u53c2\u8d5b</span>';
    const header = '<div class="toplist-head"><span class="toplist-me">\u6211\u7684\u540d\u6b21\uff1a' + rankText +
      '</span><span class="toplist-week">' + (ladderTab ? '\u5929\u68af\u8d5b ' + RANK_LEVEL + ' \u7ea7\u5f00\u542f' : '\u6bcf\u5468\u4e00\u91cd\u7f6e') + '\u00b7\u79bb\u7ebf\u6a21\u62df</span></div>';
    const locked = ladderTab && !qualified
      ? '<div class="toplist-locked-note">\u5929\u68af\u8d5b\u9700\u8981 ' + RANK_LEVEL + ' \u7ea7\u624d\u80fd\u53c2\u52a0\uff0c\u4f60\u73b0\u5728 ' + s.level +
        ' \u7ea7\uff0c\u8fbe\u5230\u540e\u624d\u4f1a\u62e5\u6709\u91d1\u676f\u4e0e\u5929\u68af\u79ef\u5206\u3002</div>'
      : '';
    const tabs = '<div class="master-tabs toplist-tabs">' + TOPLIST_TABS.map(([id, label]) =>
      '<button class="uc-tab ' + (id === toplistTab ? 'active' : '') + '" data-action="' + id + '" aria-current="' + (id === toplistTab ? 'page' : 'false') + '">' + label + '</button>').join('') + '</div>';
    const list = '<div class="toplist-rows">' + rows.slice(0, 15).map((r, i) => {
      const rank = i + 1, medal = rank <= 3 ? '\u2460\u2461\u2462'[rank - 1] : String(rank);
      const shown = r.inLadder !== false;
      const cupText = ladderTab && r.npc === false && !qualified ? '\u2014' : (shown ? r.cup + ' \u91d1\u676f' : '\u2014');
      const scoreText = ladderTab && r.npc === false && !qualified ? '\u2014' : (shown ? String(r.integral) : '\u2014');
      return '<div class="toplist-row' + (r.npc ? '' : ' me') + (shown ? '' : ' unranked') + '"><span class="toplist-rank">' + medal + '</span>' +
        '<span class="toplist-name">' + esc(r.name) + (r.npc ? '' : '\uff08\u6211\uff09') + '</span>' +
        '<span class="toplist-lv">Lv ' + r.level + '</span>' +
        '<span class="toplist-cup">' + cupText + '</span>' +
        '<span class="toplist-score">' + scoreText + '</span></div>';
    }).join('') + '</div>';
    const foot = '<div class="extra-note">\u6392\u884c\u699c\u4e3a\u5355\u673a\u79bb\u7ebf\u6a21\u62df\uff1a\u5bf9\u624b\u540d\u5355\u6bcf\u5468\u56fa\u5b9a\uff0c\u4e0d\u8fde\u63a5\u771f\u5b9e\u73a9\u5bb6\u3002\u5f53\u524d\u6392\u5e8f\uff1a' +
      (key === 'cup' ? '\u91d1\u676f' : key === 'integral' ? '\u5929\u68af\u79ef\u5206' : '\u7b49\u7ea7') +
      (ladderTab && !qualified ? '\uff08\u4f60\u672a\u53c2\u8d5b\uff09' : '') + '\u3002</div>';
    const p = C().page('message', 'toplist', header + locked + tabs + list + foot, { cls: 'extra-board toplist-board' });
    on(p, 'level', () => { toplistTab = 'level'; toplistCache = Object.create(null); toplist(); });
    on(p, 'cup', () => { toplistTab = 'cup'; toplistCache = Object.create(null); toplist(); });
    on(p, 'integral', () => { toplistTab = 'integral'; toplistCache = Object.create(null); toplist(); });
  }



  const VIP_PRIVILEGES = [
    '\u89d2\u8272\u7b49\u7ea710\u7ea7\u4ee5\u4e0a\u7684VIP\u53ef\u4ee5\u8df3\u8fc7\u6218\u6597\uff08\u53ef\u81ea\u52a8\u83b7\u5f97\u70b9\u51fb\u7c7b\u9053\u5177\uff09',
    '\u88ab\u52a8\u7ecf\u9a8c\u4e0a\u9650\u5927\u5e45\u63d0\u9ad8\uff0c\u6700\u9ad8\u53ef\u8fbe400\u7ecf\u9a8c/\u5929',
    '\u4f53\u529b\u6062\u590d\u901f\u5ea6\u5927\u5e45\u52a0\u5feb\uff0c\u6700\u5feb\u53ef\u8fbe1.5\u500d',
    '\u6635\u79f0\u4ee5\u5c0a\u8d35\u6807\u8bc6\u5c55\u793a\uff0c\u5f70\u663e\u8eab\u4efd',
    '\u9996\u6b21\u5f00\u901a\uff0c\u6c38\u4e45\u8d60\u90016\u4e2a\u88c5\u5907\u683c\u5b50',
    '\u5e08\u5085\u5982\u679c\u662fVIP\uff0c\u5f92\u5f1f\u6bcf\u5929\u767b\u9646\u5c06\u989d\u5916\u83b7\u5f975-15\u4e2a\u91d1\u677e\u679c',
    '\u4e3b\u52a8\u6311\u6218VIP\u73a9\u5bb6\u6240\u5f97\u7ecf\u9a8c\u4e0a\u6da830%',
    '\u4f53\u529b\u4e0a\u9650 +60\uff08\u5f53\u524d\u7b49\u7ea7\u4e0a\u9650\u4e4b\u4e0a\uff09',
  ];
  function vip() {
    State.tickEnergy();
    const s = State.state();
    const active = State.vipActive(), level = State.vipLevel();
    const days = State.vipDaysLeft(), mul = State.vipRegenMul();
    const need = active ? State.vipExpNeed() : 0;
    const status = active
      ? '<div class="vip-status on"><span class="vip-crown">\u2605</span><div><h2>\u8d85\u7ea7\u677e\u9f20 Lv ' + level + '</h2>' +
        '<p>\u5269\u4f59 ' + days + ' \u5929\u3000\u4f53\u529b\u6062\u590d ' + mul.toFixed(1) + ' \u500d\u3000\u4f53\u529b\u4e0a\u9650 +' + State.VIP_ENERGY_BONUS + '\u3000\u88c5\u5907\u683c\u5b50 +' + State.VIP_GEAR_BONUS + '</p>' +
        '<p class="vip-exp">\u5347\u7ea7\u7ecf\u9a8c ' + s.vip.exp + ' / ' + need + '\uff08\u6bcf\u65e5\u9996\u6b21\u767b\u9646 +1\uff09</p></div></div>'
      : '<div class="vip-status off"><span class="vip-crown muted">\u2606</span><div><h2>\u5c1a\u672a\u5f00\u901a\u8d85\u7ea7\u677e\u9f20</h2>' +
        '<p>' + (Number(s.vip && s.vip.level) > 1 ? '\u4e0a\u6b21\u7b49\u7ea7 Lv ' + Number(s.vip.level) + '\uff0c\u7eed\u8d39\u540e\u4ece\u8fd9\u4e00\u7ea7\u7ee7\u7eed\u3002' : '') + '\u5f00\u901a\u540e\u7acb\u5373\u751f\u6548\uff0c\u5230\u671f\u540e\u7b49\u7ea7\u4e0e\u7ecf\u9a8c\u4fdd\u7559\uff08\u4e0d\u4f1a\u91cd\u7f6e\uff09\uff0c\u518d\u6b21\u8d2d\u4e70\u5373\u53ef\u7ee7\u7eed\u4eab\u53d7\u3002</p></div></div>';
    const priv = '<div class="vip-priv"><h3>\u7279\u6743</h3><ol>' + VIP_PRIVILEGES.map((t) => '<li>' + t + '</li>').join('') + '</ol></div>';
    const table = '<div class="vip-table"><h3>\u6210\u957f\u4f53\u7cfb</h3><table><thead><tr><th>\u7b49\u7ea7</th><th>\u88ab\u52a8\u7ecf\u9a8c\u4e0a\u9650</th><th>\u4f53\u529b\u6062\u590d</th></tr></thead><tbody>' +
      State.VIP_LEVELS.map(([lv, cap, m], i) => '<tr class="' + (active && i + 1 === level ? 'me' : '') + '"><td>' + lv + '</td><td>' + cap + '</td><td>' + Number(m).toFixed(1) + ' \u500d</td></tr>').join('') +
      '</tbody></table><p class="small-label">\u6210\u4e3a\u8d85\u7ea7\u677e\u9f20\u540e\uff0c\u6bcf\u65e5\u9996\u6b21\u767b\u9646\u5373\u53ef\u83b7\u5f971\u70b9\u7ecf\u9a8c\uff0c\u7d2f\u79ef\u7ecf\u9a8c\u81ea\u52a8\u63d0\u5347\u7b49\u7ea7\u3002</p></div>';
    const plans = '<div class="vip-plans">' + State.VIP_PLANS.map((p) =>
      '<button class="vip-plan" data-action="buy' + p.days + '"><b>' + p.days + ' \u5929</b><span>' + p.gold + ' \u91d1\u677e\u679c</span></button>').join('') +
      '</div><div class="extra-note">\u539f\u7248\u6309\u5929\u552e\u5356\uff08buyVIP.do\uff09\uff1b\u5355\u673a\u7248\u6539\u4e3a\u91d1\u677e\u679c\u8d2d\u4e70\uff0c\u4ef7\u683c\u4e3a\u672c\u9879\u76ee\u7ecf\u6d4e\u7684\u5e73\u8861\u503c\u3002\u73b0\u6709\u91d1\u677e\u679c ' + s.goldPoint + ' \u4e2a\u3002</div>';
    const p = C().page('system', 'vip', status + plans + priv + table, { cls: 'extra-board vip-board' });
    for (const plan of State.VIP_PLANS) {
      on(p, 'buy' + plan.days, () => {
        const r = State.buyVip(plan.days);
        C().toast(r.msg);
        if (r.ok) vip();
      });
    }

    if (C().wireSystemFeedback) C().wireSystemFeedback(p);
  }


  window.ClassicExtras = {
    payArenaEntry, arena, startArenaCompete, chooseArena, startRankFlow, rank, rankShop: (pg, origin) => rankShop(pg || 0, origin), rankGoodsList, rankBuy, rankLimitInfo, rankMatch, lottery, refreshTickets, master, toplist, vip, lotteryPrizes: prizes,
    claimTribute, tributeStatus,
    // 登录后预取一次师徒数据：活动页的「徒弟日供」卡要显示服务端数值，不用等玩家先开师徒页。
    prefetchApprentice: () => {
      dropStaleOnlineMaster();
      if (!window.Online || !window.Online.ready || onlineMasterData || onlineMasterPromise) return;
      void fetchOnlineMaster();
    },
    invalidateApprentice: () => { onlineMasterData = null; onlineMasterCands = null; },
    // 竞技场赛事页（`js/ssfight/ui-challenge.js` 的 `match` 子页）要用这两个：
    // 当前这轮的赛事快照，以及"打下一场"的入口。
    arenaRun: () => activeArenaRun(), saveArenaRun, fightArena: (run) => fightArena(run || activeArenaRun()),

    clearArenaBusy,
    rankFoeLevel, rankFoeExpectLevel, claimRankCup };
})();
