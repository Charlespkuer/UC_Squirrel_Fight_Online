/* ============================================================
 * online-battle.js — 联机战斗流程（客户端）
 * ------------------------------------------------------------
 * 一场联机战斗固定三步：
 *   ① `POST /api/battle`（服务端算完，返回 me / foe / result / settlement）；
 *   ② `Main.startBattle(foe, { me, result, sheetsReady: true, skipRecord: true, … })`
 *      只负责**播**，不跑 Sim、不发奖、不记录；
 *   ③ 随机挑战在同一场 `SfFight` 内展示服务端战果，停 1.5 s 后自动开宝箱；
 *      竞技/关卡的续战动作仍走各自原版结果容器。
 *
 * `sheetsReady` 很关键：服务端返回的 me/foe 已经做过套装与幻兽加成，
 * `startBattle` 必须跳过那一段，否则面板会被算两遍、回放和结算对不上。
 * ============================================================ */
(function () {
  'use strict';

  const O = window.Online;
  const Net = window.Net || {};
  let activeFlow = null;

  /* 普通战斗录像默认只保留在客户端，服务端只留 60 分钟的重试窗口。
   * 每个账号一份，最多 30 场，避免 localStorage 无限增长。 */
  const LOCAL_COMBAT_LIMIT = 30;
  function localCombatKey() {
    try {
      const a = typeof Net.account === 'function' ? Net.account() : null;
      return 'ssdz-online-local-battles:' + String((a && a.accountId) || 'anonymous');
    } catch (_) { return 'ssdz-online-local-battles:anonymous'; }
  }
  function readLocalCombats() {
    try {
      const raw = localStorage.getItem(localCombatKey());
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((x) => x && x.combatId && x.result) : [];
    } catch (_) { return []; }
  }
  function rememberCombat(kind, out) {
    if (!out || !out.combatId || !out.result || !Array.isArray(out.result.rounds)) return;
    try {
      const list = readLocalCombats().filter((x) => x.combatId !== String(out.combatId));
      list.unshift({
        combatId: String(out.combatId), kind: String(kind || 'combat'),
        result: out.result, me: out.me || null, foe: out.foe || null,
        opponent: out.opponent || null, settlement: out.settlement || null,
        createdAt: Date.now(),
      });
      localStorage.setItem(localCombatKey(), JSON.stringify(list.slice(0, LOCAL_COMBAT_LIMIT)));
    } catch (_) { /* 配额/隐私模式：只是不能本地回放，不影响战斗 */ }
  }
  function findLocalCombat(combatId) {
    const id = String(combatId || '');
    return readLocalCombats().find((x) => x.combatId === id) || null;
  }

  function oneBattle(fn) {
    return function (...args) {
      if (activeFlow) return activeFlow;
      const flow = Promise.resolve().then(() => fn(...args));
      activeFlow = flow;
      flow.then(() => { if (activeFlow === flow) activeFlow = null; }, () => { if (activeFlow === flow) activeFlow = null; });
      return flow;
    };
  }
  async function requestMatch(body) {
    const key = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try {
      const out = await O.post('/api/battle', body, { idemKey: key });
      rememberCombat(body.kind, out);
      return out;
    } catch (e) {
      if (!e || e.code !== 'NETWORK' || !O.ready) throw e;
      // Retry the same intent, never pay for or generate a second battle.
      const out = await O.post('/api/battle', body, { idemKey: key });
      rememberCombat(body.kind, out);
      return out;
    }
  }

  async function requestChest(combatId, index) {
    const body = { combatId, index };
    try { return await O.post('/api/battle/chest', body, { preserveMirror: true }); }
    catch (e) {
      if (!e || e.code !== 'NETWORK' || !O.ready) throw e;
      // The server records the chosen chest atomically, so this retry cannot grant twice.
      return O.post('/api/battle/chest', body, { preserveMirror: true });
    }
  }

  function ui() { return window.UI || null; }
  function classic() { return window.UI && UI.currentUiMode && UI.currentUiMode() === 'classic'; }

  function toast(msg) { O.toast(msg); }

  /* 原版普通战斗的战果 CG 只停 1.5 s（`fight` 第 2/3 帧 → 第 5 帧开宝箱），
   * 没有「确定 / 领取宝箱」这类额外按钮。联机的战果页同样让它自己走掉。 */
  const RESULT_AUTO_CLOSE_MS = 1500;

  /** 战斗前把当前页按住（挑战页/关卡页都实现了），打完原样放回。 */
  function holdPage() {
    try {
      if (window.SfChallenge && SfChallenge.holdPageForBattle) return SfChallenge.holdPageForBattle();
    } catch (e) {}
    return null;
  }

  function restorePage(hold, target) {
    const t = target || {};
    try {
      if (hold && window.SfChallenge && SfChallenge.resumePageAfterBattle
        && SfChallenge.resumePageAfterBattle(hold, t.tab, { keepSub: !!t.keepSub })) {
        if (t.arenaPage && SfChallenge.goArenaPage) SfChallenge.goArenaPage(t.arenaPage);
        else if (t.refreshGateAt != null && SfChallenge.refreshGateAt && hold.sub) SfChallenge.refreshGateAt(t.refreshGateAt);
        return true;
      }
    } catch (e) {}
    try {
      if (t.arenaPage && window.SfChallenge && SfChallenge.goArenaPage) { SfChallenge.goArenaPage(t.arenaPage); return true; }
      if (t.action && ui() && UI.runAction) { UI.runAction(t.action); return true; }
      if (t.tab && window.SfChallenge && SfChallenge.open) { SfChallenge.openAt(t.tab); UI.runAction('challenge'); return true; }
    } catch (e) {}
    return false;
  }

  /** 请求在**开打前**就被拒（体力不足 / 快照失效 / 网络失败）：只把按住的页面放出来。
   *  不能走 `restorePage()` —— 它会按“打完一场”的语义清掉随机挑战名单，玩家去喝药再回来
   *  就会看到一批新对手（用户 2026-11 报的“体力不足后回来刷新了”）。 */
  function restorePageAfterRejectedRequest(hold, target) {
    try {
      if (hold && window.SfChallenge && SfChallenge.resumePageAfterFailedRequest
        && SfChallenge.resumePageAfterFailedRequest(hold)) return true;
    } catch (e) {}
    return restorePage(hold, target);
  }

  /** 战果弹窗前等底页真的挂回 `#ui`：消息页/师徒页等是异步 fetch + render 的，
   *  `restorePage()` 只负责发起，同步返回；不等就会在底页回来前露出启动 95% 深色 canvas。 */
  function waitForUiPage(limitMs) {
    const end = Date.now() + (Number(limitMs) || 1500);
    return new Promise((resolve) => {
      const tick = () => {
        const doc = (typeof document !== 'undefined' && document) ? document : null;
        const root = doc && typeof doc.getElementById === 'function' ? doc.getElementById('ui') : null;
        if (!root) { resolve(false); return; }
        if (root.firstElementChild) { resolve(true); return; }
        if (Date.now() > end) { resolve(false); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** 播一场服务端结果。`onSettle` 在播完后调用（弹战果页/回页面）。 */
  function play(resp, opts) {
    const o = opts || {};
    const foe = resp && resp.foe;
    const me = resp && resp.me;
    const result = resp && resp.result;
    /* 服务端没给整场录像就**不要开打**：`SfFight` 会自己 `Sim.simulate` 一遍，
     * 于是"客户端播的胜负"和"服务端结算的胜负"可能相反（这就是用户报的
     * 「胜利的战斗被结算为失败」）。宁可报错，也不要播一场假比赛。 */
    if (!me || !foe || !result || !Array.isArray(result.rounds) || !result.rounds.length) {
      toast('这场战斗缺少服务端录像，已取消。请重新发起。');
      if (window.__errs) window.__errs.push('online-battle: 响应缺少 result（' + (o.kind || '') + '）');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (winner, loot) => {
        if (settled) return;
        settled = true;
        if (loot && loot.ups && loot.ups.length) (o.extraUps || []).push(...loot.ups);
        resolve(winner);
      };
      if (!window.Main || !Main.startBattle) { done(null); return; }
      try {
        Promise.resolve(Main.startBattle(foe, {
          me, result, sheetsReady: true, skipRecord: true, cost: 0,
          kind: o.kind || 'challenge',
          useProps: false, collectDrops: !!resp.pickups, pickupPlan: resp.pickups,
          claimPickup: resp.pickups ? async index => {
            const body = { combatId: resp.combatId, index };
            try { return await O.post('/api/battle/pickup', body, { preserveMirror: true }); }
            catch (e) { if (!e || e.code !== 'NETWORK' || !O.ready) throw e; return O.post('/api/battle/pickup', body, { preserveMirror: true }); }
          } : undefined,
          skipChest: typeof o.claimChest !== 'function',
          rewardFor: o.rewardFor,
          claimChest: o.claimChest,
          onClaimError: o.onClaimError,
          /* 随机挑战与单机共用这一张自动战果；续战页仍由对应流程接管。 */
          skipResultPanel: !o.resultInBattle,
          onCancel: () => done(null),
          keepScreen: true,
          allowSkip: o.allowSkip !== false,
          speedToggle: true,
          maxRounds: o.maxRounds,
          region: o.region,
          onEnd: (winner, result, loot) => done(winner, loot),
          onError: () => done(null),
        })).catch(() => done(null));
      } catch (e) {
        done(null);
      }
    });
  }

  /** 原版战果页：`SfFightResult` 在经典模式下就是原版 4692/3776 那一套。 */
  function resultPanel(spec) {
    const s = spec || {};
    if (window.SfFightResult && classic()) {
      const actions = Array.isArray(s.actions) ? s.actions
        : (s.autoClose ? [] : [{ label: '确定', run: s.onClose || (() => {}) }]);
      return SfFightResult.open({
        kind: s.kind || 'result',
        title: s.title || '战斗结果',
        win: !!s.win,
        recruit: s.recruit === true,
        exp: Number(s.exp) || 0,
        gold: Number(s.gold) || 0,
        ups: s.ups || [],
        note: s.note || '',
        text: s.text || '',
        actions,
        autoClose: s.autoClose,
        onAutoClose: s.onAutoClose,
      }).catch((e) => { toast('战果界面加载失败：' + (e && e.message)); });
    }
    /* 没有原版容器（素材没加载出来）时的兜底：只写文字，不做新界面。
     * 自动收尾的页面在兜底里仍留一颗「确定」，否则弹窗永远关不掉。 */
    const C = ui() && UI.classic;
    const body = '<p>' + (s.text || '') + '</p>';
    const actions = (s.actions && s.actions.length) ? s.actions
      : [{ label: '确定', run: s.onClose || (() => {}) }];
    if (C && C.modal) C.modal(s.title || '战斗结果', body, actions, { small: true });
    else toast(s.text || '战斗结束');
    return Promise.resolve();
  }

  function lootLine(drop, loot) {
    const d = drop || loot;
    if (!d) return '';
    return '获得 ' + (d.name || '战利品') + ' ×' + (d.count || 1);
  }

  let chestBusy = false;
  async function claimChest(chest, win) {
    if (chestBusy || !chest || !chest.combatId) return false;
    chestBusy = true;
    try {
      if (!window.SfFight || !SfFight.openOnlineChest) throw new Error('宝箱界面未加载，请重新打开游戏');
      await SfFight.openOnlineChest({
        win,
        claimChest: async index => {
          const out = await requestChest(chest.combatId, index);
          return out;
        },
        onClaimError: e => toast(O.errText(e) + '；宝箱已保留，可以重试领取。'),
      });
      return true;
    } catch (e) { toast(O.errText(e)); return false; }
    finally { chestBusy = false; }
  }

  async function pendingChests() {
    try {
      const data = await O.get('/api/battle/chest'), list = data.chests || [], c = ui() && UI.classic;
      if (!list.length) { toast('所有战斗宝箱都已领取。'); return; }
      if (!c) return;
      const m = c.modal('待领战斗宝箱', '<p>共有 ' + Number(data.pendingCount || list.length) + ' 个宝箱未领取。断线或退出后，宝箱仍会保留。</p>' +
        '<p class="small-label">先领取最早一场的宝箱；每场只能获得一次奖励。</p>', [
        { label: '领取宝箱', cls: 'gold', run: async () => {
          await claimChest(list[0]);
          if (O.ready && window.Main && Main.showHome) Main.showHome();
        } }, { label: '返回', cls: 'muted' },
      ], { small: true });
      return m;
    } catch (e) { toast(O.errText(e)); }
  }

  /* ============================================================
   * 随机挑战
   * ============================================================ */
  async function random(opts) {
    const o = opts || {};
    const hold = holdPage();
    let resp;
    try {
      resp = await requestMatch({ kind: 'random', snapshotId: o.snapshotId || '', rev: O.rev });
    } catch (e) {
      restorePageAfterRejectedRequest(hold, o.target);
      toast(O.errText(e));
      return null;
    }
    if (resp.patch) O.applyPatch(resp.patch);
    const st = resp.settlement || {};
    const chest = resp.chest && !resp.chest.claimed ? resp.chest : null;
    const extraUps = [];
    const winner = await play(resp, {
      kind: 'challenge', resultInBattle: true, extraUps,
      // This only displays the settlement already granted by the server.
      rewardFor: () => st,
      claimChest: chest ? async index => { const out = await requestChest(chest.combatId, index); if (out.ups) extraUps.push(...out.ups); return out; } : undefined,
      onClaimError: e => toast(O.errText(e) + '；宝箱已保留，可以重试领取。'),
    });
    if (winner == null || !O.ready) return resp;
    restorePage(hold, o.target || { tab: 'random' });
    // Match the standalone challenge flow: use its existing level-up choices,
    // after the original result and chest have finished, without another result page.
    const ups = [...(st.ups || []), ...extraUps].sort((a, b) => a.level - b.level);
    if (ups.length && window.SfGuide) SfGuide.onLevelup(ups);
    if (ups.length && window.SfLevelUp) await new Promise(resolve => SfLevelUp.open(ups, resolve));
    if (ups.length && window.SfGuide) SfGuide.onLevelupDone(ups);
    if (ui() && UI.classic && UI.classic.promptLevelUpChoices) UI.classic.promptLevelUpChoices();
    O.emit('battle', resp);
    return resp;
  }

  /* ============================================================
   * 天梯赛
   * ============================================================ */
  async function opponents(query) {
    const q = query || {};
    const qs = [];
    if (q.kind) qs.push('kind=' + encodeURIComponent(q.kind));
    if (q.levelSpread != null) qs.push('levelSpread=' + encodeURIComponent(q.levelSpread));
    if (q.ratingSpread != null) qs.push('ratingSpread=' + encodeURIComponent(q.ratingSpread));
    return O.get('/api/opponents' + (qs.length ? '?' + qs.join('&') : ''));
  }

  async function rank(snapshotId, opts) {
    const o = opts || {};
    const hold = holdPage();
    let resp;
    try {
      resp = await requestMatch({ kind: 'rank', snapshotId, rev: O.rev, revengeOf: o.revengeOf || '' });
    } catch (e) {
      restorePage(hold, o.target);
      toast(O.errText(e));
      return null;
    }
    if (resp.patch) O.applyPatch(resp.patch);
    const st = resp.settlement || {};
    const pickupUps = [];
    /* 战果面板要盖在**天梯菜单**上：`keepScreen` 不换页，战斗页撤掉后 `#ui` 是空的，
     * 露出来的是 canvas 上启动加载的 95% 深色底 —— 这就是「天梯胜利弹窗背景一片黑」。
     * 先恢复天梯挑战页，再弹战果；close 做成幂等，自动收尾/按钮还会再调它。
     * 原版 `rank.do` 也没有战后宝箱（只有积分/金杯/经验），所以这里不再开宝箱。 */
    let closed = false;
    const close = () => {
      if (closed) return true;
      closed = true;
      return restorePage(hold, o.target || { tab: 'arena', arenaPage: 'menu' });
    };
    const played = await play(resp, { kind: 'rank', resultInBattle: true, extraUps: pickupUps });
    if (played == null) { if (O.ready) close(); return resp; }
    if (!O.ready) return resp;
    close();
    await waitForUiPage();
    const lines = [];
    const rv = st.revenge || o.revenge || null;
    if (rv) {
      lines.push(st.win ? '复仇成功！' : '复仇失败');
      lines.push('复仇消耗 ' + Number(rv.cost || 0) + ' 金松果');
      if (st.exp) lines.push('经验 +' + st.exp);
      if (st.integral) lines.push('积分 ' + (st.integral.delta >= 0 ? '+' : '') + st.integral.delta + '（' + st.integral.new + '）');
      if (st.win) {
        const got = Number(st.revenge && st.revenge.stolen != null ? st.revenge.stolen : st.goldCup) || 0;
        lines.push(got > 0 ? ('抢夺 ' + got + ' 个金杯（原版应抢 ' + Number(rv.cups || 0) + '）') : '本次没有抢到金杯');
      } else {
        lines.push('复仇失败没有额外补偿');
      }
    } else {
      lines.push(st.win ? '天梯赛胜利！' : '天梯赛失利');
      if (st.bot || (resp.opponent && resp.opponent.bot)) {
        lines.push('赛区人机 · 按天梯规则结算积分');
      } else {
        lines.push('同赛区玩家快照 · 异步挑战');
      }
      if (st.exp) lines.push('经验 +' + st.exp);
      if (st.integral) lines.push('积分 ' + (st.integral.delta >= 0 ? '+' : '') + st.integral.delta + '（' + st.integral.new + '）');
      if (st.goldCup) lines.push('金杯 +' + st.goldCup);
      if (st.robbed) lines.push('抢走对方 ' + st.robbed + ' 个金杯');
      if (st.drop) lines.push(lootLine(st.drop));
    }
    /* 与单机版 `outcome()` 同样的三选一：继续挑战 / 查看录像 / 返回天梯赛。
     * 复仇回到消息页，不把「继续挑战」误接成普通天梯。 */
    const again = typeof o.again === 'function' ? o.again : () => {
      const backMenu = () => { try { if (window.SfChallenge && SfChallenge.goArenaPage) SfChallenge.goArenaPage('menu'); } catch (e) {} };
      if (window.ClassicExtras && ClassicExtras.startRankFlow) ClassicExtras.startRankFlow(backMenu, { confirmed: true });
      else close();
    };
    const actions = rv ? [
      { label: '返回消息', primary: true, run: close },
      { label: '查看录像', muted: true, run: () => { try { UI.runAction('messages'); } catch (e) {} } },
    ] : [
      { label: '继续挑战', primary: true, run: () => { again(); } },
      { label: '查看录像', muted: true, run: () => { try { UI.runAction('messages'); } catch (e) {} } },
      { label: '返回天梯赛', run: close },
    ];
    resultPanel({
      /* 天梯用原版 3776 的「天梯赛」战果容器；以前误传 `arena` 会套 3822 的
       * 竞技场标题帧，失败时显示成「争夺季军」。 */
      kind: 'rank', title: st.win ? '天梯赛胜利' : '天梯赛失利', win: !!st.win,
      exp: st.exp, gold: 0, ups: [...(st.ups || []), ...pickupUps].sort((a, b) => a.level - b.level),
      text: lines.join('\u3000'),
      actions, onClose: close,
    });
    O.emit('battle', resp);
    return resp;
  }

  /* ============================================================
   * 关卡连战
   * ============================================================ */
  /** 服务端拒绝关卡（挑战书不足 / 复活次数用完）时的出口。以前只 toast 一句就把玩家丢回
   *  确认页，而经典确认页只有「战斗 / 返回」——这一轮永远结束不了，看起来就是「进不去挑战」。
   *  （用户 2026-11：「复活的挑战书用完后会进不去挑战」） */
  function stageBlocked(stageId, e) {
    const err = e && e.body && e.body.error ? e.body.error : {};
    const extra = err.extra || {};
    let run = null;
    try { run = window.State && State.stageRun ? State.stageRun(stageId) : null; } catch (_) {}
    const blocked = !!(run && (run.needsRevive || run.revives >= 2));
    const msg = O.errText(e);
    if (!extra.needsBook && !blocked) { toast(msg); return; }
    const tab = Math.floor((Number(stageId) - 1) / 6);
    const actions = [];
    if (extra.needsBook) {
      actions.push({ label: '购买挑战书', run: () => { try { if (window.UI && UI.runAction) UI.runAction('shop'); } catch (_) {} } });
    }
    if (blocked) {
      actions.push({ label: '结束本轮', primary: true, run: () => {
        try { State.abandonStageRun(stageId); } catch (_) {}
        try { if (window.SfChallenge && SfChallenge.refreshGateAt) SfChallenge.refreshGateAt(tab); } catch (_) {}
      } });
    }
    actions.push({ label: '返回', run: () => {} });
    resultPanel({ kind: 'stage', title: '关卡无法继续', win: false, text: msg, actions });
  }

  async function stage(stageId, opts) {
    const o = opts || {};
    const hold = holdPage();
    let resp;
    try {
      resp = await requestMatch({ kind: 'stage', stageId: Number(stageId), rev: O.rev });
    } catch (e) {
      restorePage(hold, o.target);
      stageBlocked(stageId, e);
      return null;
    }
    if (resp.patch) O.applyPatch(resp.patch);
    const st = resp.stage || {};
    const settle = st.settle || {};
    const tab = Math.floor((Number(stageId) - 1) / 6);
    const pickupUps = [];
    /* 战果页要盖在**挑战页**上：`keepScreen` 不换页，战斗页撤掉后 `#ui` 是空的，
     * 露出来的是 canvas 上最后一帧（启动加载 95%）—— 就是「关卡胜利背景一片深色」。
     * 先把按住的挑战页放回来，再弹战果；close 做成幂等，下面的按钮还会再调它。 */
    let closed = false;
    const close = () => {
      if (closed) return true;
      closed = true;
      return restorePage(hold, o.target || { tab: 'gates', refreshGateAt: tab, keepSub: true });
    };
    const winner = await play(resp, { kind: 'stage', extraUps: pickupUps });
    if (winner == null) { if (O.ready) close(); return resp; }
    if (!O.ready) return resp;
    close();
    await waitForUiPage();
    if (st.prenticeLost) {
      resultPanel({
        kind: 'stage', title: '徒弟战败', win: false, ups: pickupUps,
        text: '徒弟无能，打不过它！该师父您亲自上阵了！',
        actions: [{ label: '师父上阵', primary: true, run: () => { close(); stage(stageId); } },
          { label: '稍后继续', run: close }],
        onClose: close,
      });
      return resp;
    }
    const lines = [];
    if (settle.win) {
      lines.push(settle.complete ? '恭喜通关！' : '已击败 ' + ((st.npc && st.npc.name) || '对手'));
      if (settle.exp) lines.push('经验 +' + settle.exp);
      if (settle.gold) lines.push('金松果 +' + settle.gold + (settle.goldBuff ? '（祭坛双倍）' : ''));
      if (settle.drop) lines.push(lootLine(settle.drop));
      if (settle.gem) lines.push('获得 ' + settle.gem.name + ' ×1');
    } else {
      lines.push('挑战失败');
      const revives = settle.run && settle.run.revives != null ? Number(settle.run.revives) : 0;
      lines.push(revives < 2 ? '可花 1 个挑战书复活，剩余复活次数 ' + (2 - revives) : '本轮 2 次复活机会已用完');
    }
    const actions = [{ label: '确定', primary: true, run: close }];
    /* 用户 2026-10 口径：关卡胜利页「确定 / 继续挑战」位置对调（确定在左、继续挑战在右）。
     * `SfFightResult` 按 actions 顺序摆键（同 rank 时保持数组顺序），所以用 push 而不是 unshift。 */
    if (settle.win && !settle.complete) actions.push({ label: '继续挑战', run: () => { close(); stage(stageId); } });
    if (!settle.win) {
      /* 复活次数用完时不能还给「复活再战」——服务端会拒绝，玩家点了只弹一句提示、没有出口；
       * 直接给「结束本轮」，与单机版经典确认页的兜底一致。 */
      const revivesDone = settle.run && settle.run.revives != null ? Number(settle.run.revives) : 0;
      if (revivesDone < 2) actions.unshift({ label: '复活再战', run: () => { close(); stage(stageId); } });
      else actions.unshift({ label: '结束本轮', primary: true, run: () => {
        try { State.abandonStageRun(stageId); } catch (_) {}
        close();
        try { if (window.SfChallenge && SfChallenge.refreshGateAt) SfChallenge.refreshGateAt(tab); } catch (_) {}
      } });
    }
    resultPanel({
      kind: 'stage', title: settle.win ? '关卡胜利' : '关卡失利', win: !!settle.win,
      exp: settle.exp, gold: settle.gold, ups: [...(settle.ups || []), ...pickupUps].sort((a, b) => a.level - b.level),
      text: lines.join('\u3000'), actions, onClose: close,
    });
    O.emit('battle', resp);
    return resp;
  }

  /* ============================================================
   * 竞技场
   * ============================================================ */
  async function arenaJoin(kind, opts) {
    const o = opts || {};
    try {
      const resp = await O.post('/api/arena/join', { kind: Number(kind) || 0, rev: O.rev });
      if (resp.patch) O.applyPatch(resp.patch);
      O.emit('arena', resp);
      return resp;
    } catch (e) {
      toast(O.errText(e));
      return null;
    }
  }

  async function arenaFight(opts) {
    const o = opts || {};
    const hold = holdPage();
    let resp;
    try {
      resp = await requestMatch({ kind: 'arena', rev: O.rev });
    } catch (e) {
      restorePage(hold, o.target);
      toast(O.errText(e));
      return null;
    }
    if (resp.patch) O.applyPatch(resp.patch);
    const arena = resp.arena || {};
    const rw = arena.rewards || {};
    const pickupUps = [];
    /* 与天梯/关卡同一条：先把按住的挑战页恢复，再弹竞技场战果，
     * 否则 `#ui` 空着会露出 canvas 的启动 95% 深色底。 */
    let closed = false;
    const back = () => {
      if (closed) return true;
      closed = true;
      return restorePage(hold, o.target || { arenaPage: 'rules' });
    };
    const played = await play(resp, { kind: 'arena', extraUps: pickupUps });
    if (played == null) { if (O.ready) back(); return resp; }
    if (!O.ready) return resp;
    back();
    await waitForUiPage();
    const lines = [];
    lines.push(arena.win ? '胜利！' : '再接再厉');
    if (rw.phase === 'semi') {
      lines.push(rw.next === 'final' ? '晋级决赛' : '争夺季军');
      if (rw.gem) lines.push('获得 ' + rw.gem.name + ' ×1');
    } else {
      lines.push('获得' + (rw.title || '名次'));
      if (rw.exp) lines.push('经验 +' + rw.exp);
      if (rw.shards) lines.push('蓝色碎片 +' + rw.shards);
      if (rw.hatch) lines.push('孵化点 +' + rw.hatch);
      if (rw.gem) lines.push('获得 ' + rw.gem.name + ' ×1');
      if (rw.buffNote) lines.push(rw.buffNote);
    }
    const actions = [];
    if (rw.phase === 'semi') actions.push({ label: rw.next === 'final' ? '开始决赛' : '开始季军赛', primary: true, run: () => { back(); arenaFight({ target: o.target }); } });
    actions.push({ label: '确定', primary: rw.phase !== 'semi', run: back });
    resultPanel({
      kind: 'arena', title: rw.phase === 'semi' ? (rw.next === 'final' ? '晋级决赛' : '争夺季军') : '竞技场',
      win: !!arena.win, exp: rw.exp, gold: 0, ups: [...(rw.ups || []), ...pickupUps].sort((a, b) => a.level - b.level),
      text: lines.join('\u3000'), actions, onClose: back,
    });
    O.emit('battle', resp);
    return resp;
  }

  /* ============================================================
   * 收徒（异步：有师父打师父，没有师父打本人）
   * ============================================================ */
  async function recruit(targetAccountId, opts) {
    const o = opts || {};
    /* 从「好友」页发起时页面还在底下（本函数不自己挂页）：
     *  `o.hold` 是 `SfChallenge.holdPageForBattle()` 按住的挑战页，打完原样还原；
     *  从师徒 DOM 页发起则没有 hold，回落成 `action:'master'` 回师徒页。 */
    const hold = o.hold || null;
    const fromFriends = !!(o.target && o.target.tab);
    const key = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    let resp;
    const body = { targetAccountId: Number(targetAccountId) || 0, rev: O.rev };
    try {
      try {
        resp = await O.post('/api/apprentice/recruit', body, { idemKey: key });
      } catch (e) {
        /* 同一个幂等键重试：服务器已经扣费/收徒时只回原结果，不会重复收费。 */
        if (!e || e.code !== 'NETWORK' || !O.ready) throw e;
        resp = await O.post('/api/apprentice/recruit', body, { idemKey: key });
      }
    } catch (e) {
      restorePageAfterRejectedRequest(hold, o.target);
      toast(O.errText(e));
      return null;
    }
    if (resp.patch && !resp.save) O.applyPatch(resp.patch);
    try { if (window.ClassicExtras && ClassicExtras.invalidateApprentice) ClassicExtras.invalidateApprentice(); } catch (e) {}
    const st = resp.settlement || {};
    const pickupUps = [];
    let closed = false;
    const close = () => {
      if (closed) return true;
      closed = true;
      return restorePage(hold, o.target || { action: 'master' });
    };
    const played = await play(resp, { kind: 'challenge', extraUps: pickupUps });
    if (played == null) { if (O.ready) close(); return resp; }
    if (!O.ready) return resp;
    /* 先把挑战页/师徒页放回，再弹收徒结果；否则结果框背后是启动 95% 的深色 canvas。 */
    close();
    await waitForUiPage();
    const lines = [];
    lines.push(st.recruited ? '收徒成功！' : '收徒挑战失败');
    /* 有师父时服务端打的是师父（`via:'master'`）；输赢文案不能都写成「击败了师父」。 */
    lines.push(st.win
      ? (st.via === 'master' ? '击败了对方的师父' : '对方没有师父，直接挑战本人')
      : (st.via === 'master' ? '被对方的师父打退了' : '被对方打退了'));
    if (st.exp) lines.push('经验 +' + st.exp);
    if (st.cost || st.energy) lines.push('花费 ' + Number(st.cost || 0) + ' 金松果与 ' + Number(st.energy || 0) + ' 体力');
    /* 原版 `showFightResult`：`fightType == 2/3`（收徒）时把战果页的 `shoutu` 拨到第 1 帧，
     * 即原版「收徒」收益栏；普通战果仍是第 3 帧空档。 */
    resultPanel({
      kind: 'result', title: st.recruited ? '收徒成功' : '收徒挑战',
      win: !!st.win, recruit: true,
      exp: st.exp, gold: 0, ups: [...(st.ups || []), ...pickupUps].sort((a, b) => a.level - b.level),
      text: lines.join('\u3000'),
      actions: [{ label: fromFriends ? '返回好友' : '返回师徒', primary: true, run: close }], onClose: close,
    });
    O.emit('apprentice', resp);
    return resp;
  }

  /* ============================================================
   * 好友切磋
   * ============================================================ */
  async function wood(opts) {
    const o = opts || {}, hold = holdPage();
    let resp;
    try { resp = await requestMatch({ kind:'wood', rev:O.rev }); }
    catch (e) { restorePage(hold, o.target); toast(O.errText(e)); return null; }
    if (resp.patch) O.applyPatch(resp.patch);
    if (await play(resp, { kind:'wood', maxRounds:10 }) == null || !O.ready) return resp;
    restorePage(hold, o.target || { tab:'friends' });
    await waitForUiPage();
    const record = resp.settlement && resp.settlement.record;
    if (record && ui() && UI.classic && UI.classic.resultModal) {
      const now = record.current;
      const extra = '本次总伤害 ' + now.total + '　固定 10 回合<br>' +
        '武器伤害 ' + now.weaponDamage + '　技能伤害 ' + now.skillDamage + '　徒手伤害 ' + now.handDamage + '<br>' +
        '历史最高伤害 ' + record.totalBest + '　累计训练 ' + record.count + ' 次<br>' +
        '木桩每回合恢复满血（800），生命最低为 1，伤害按实际数值记录';
      UI.classic.resultModal(resp.result.winner === 0, { exp:0, gold:0, ups:[] }, extra, () => {});
    }
    return resp;
  }

  async function friend(snapshotId, opts) {
    const o = opts || {};
    const hold = holdPage();
    let resp;
    try {
      resp = await requestMatch({ kind: 'friend', snapshotId, rev: O.rev });
    } catch (e) {
      restorePage(hold, o.target);
      toast(O.errText(e));
      return null;
    }
    if (resp.patch) O.applyPatch(resp.patch);
    /* 与天梯/竞技同一条：切磋战果框要盖在好友页上，先把按住的挑战页恢复，
     * 否则 `#ui` 空着会露出启动 95% 深色底。 */
    let closed = false;
    const close = () => {
      if (closed) return true;
      closed = true;
      return restorePage(hold, o.target || { tab: 'friends' });
    };
    const winner = await play(resp, { kind: 'challenge' });
    if (winner == null) { if (O.ready) close(); return resp; }
    if (!O.ready) return resp;
    close();
    await waitForUiPage();
    const win = resp.settlement && resp.settlement.win;
    resultPanel({
      kind: 'result', title: '切磋结果', win: !!win,
      text: (win ? '切磋胜利！' : '再接再厉——') + '和【' + ((resp.foe && resp.foe.name) || '好友') + '】的切磋结束。切磋不消耗体力、不结算奖励。',
      actions: [{ label: '确定', primary: true, run: close }], onClose: close,
    });
    return resp;
  }

  /* ============================================================
   * 录像回放
   * ============================================================ */
  async function replay(combatId, as, opts) {
    const o = opts || {};
    let data;
    try {
      data = await O.get('/api/combat/' + encodeURIComponent(combatId) + (as ? '?as=' + as : ''));
    } catch (e) {
      /* 服务端只长期保留天梯；普通战斗超过 60 分钟后从本地缓存回放。 */
      data = findLocalCombat(combatId);
      if (!data) {
        toast(O.errText(e));
        return null;
      }
    }
    /* 优先使用服务器保存的战斗体，旧录像缺少面板时才退回空外观。 */
    const foe = o.foe || data.foe || { name: (data.result.names && data.result.names[1]) || '对手', level: 1, hp: 1, maxHp: 1,
      weapons: [], skills: [], gears: [], pets: [], effects: {} };
    const maxHp = Array.isArray(data.result.maxHp) ? data.result.maxHp : [1, 1];
    const names = Array.isArray(data.result.names) ? data.result.names : ['我', '对手'];
    const me = o.me || data.me || { name: names[0], level: 1, hp: maxHp[0], maxHp: maxHp[0], weapons: [], skills: [], gears: [], pets: [], effects: {} };
    /* 征战是共享血量接力：这一场 BOSS 的起始血量可能低于 maxHp，回放必须保留
     * `foe.hp`，否则每段录像都会从满血开始、和战斗过程对不上。旧录像没有 hp 时回落满血。 */
    const foeHp = Math.max(1, Math.min(maxHp[1], Number(foe.hp) || maxHp[1]));
    const meHp = Math.max(1, Math.min(maxHp[0], Number(me.hp) || maxHp[0]));
    const f = Object.assign({}, foe, { name: names[1], hp: foeHp, maxHp: maxHp[1] });
    const self = Object.assign({}, me, { name: names[0], hp: meHp, maxHp: maxHp[0] });
    const played = await play({ me: self, foe: f, result: data.result }, { kind: 'replay', allowSkip: true });
    if (played != null && O.ready && o.onDone) o.onDone(data);
    return data;
  }

  const randomFlow = oneBattle(random), rankFlow = oneBattle(rank);
  O.battle = { random: randomFlow, rank: rankFlow, rankFight: rankFlow, opponents,
    stage: oneBattle(stage), arenaJoin, arenaFight: oneBattle(arenaFight), friend: oneBattle(friend), wood: oneBattle(wood), replay: oneBattle(replay),
    recruit: oneBattle(recruit),
    play, resultPanel, claimChest, pendingChests };
})();
