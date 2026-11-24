// Classic message page (message frame / page-root symbol 7819, one frame only).
(function () {
  'use strict';


  const T = () => (window.SfUiMain && window.SfUiMain.toolkit) || null;
  const clipOf = (host, name) => (host && host.byName ? host.byName(name) : null);
  const toast = (msg) => { try { if (window.UI && UI.toast) UI.toast(msg); } catch (e) {} };
  // 异步失败要留痕：`window.__errs` 是回归探针唯一能看见"点了没反应"的地方。
  const pushErr = (what, e) => { if (window.__errs) window.__errs.push(what + ': ' + (e && e.message)); };

  const htmlEscape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // 这一页的原版出处：`MainMovie_frame100.as`（帧 100 的键盘逻辑）
  // ⚠ 原版 AS 里写的是 `message.msgTab.gotoAndStop(tab_wz)`，但导出数据实测这一帧的
  const TABS = [['tab', 'messages'], ['tab1', 'ranklog'], ['tab2', 'revenge'], ['tab3', 'chat']];

  const TAB_NUM = { messages: 1, ranklog: 2, revenge: 3, chat: 4 };

  const ONE_PAGE = 2;


  const WIN_FRAME = { win: 1, lose: 2, unknown: 3, rank: 4, leave: 5 };
  const WIN_FRAME_EMPTY = 8;
  // 验证消息（原版 `doShowQualifyMsg`）：`win` 第 6 帧、`a` 第 3 帧（同意加好友）、
  // `b` 第 3 帧（拒绝）；正文是服务端写死的固定招呼，第二行是 `lv{等级} {名字}`。
  const QUALIFY_FRAME = 6;
  const QUALIFY_ACCEPT_FRAME = 3;
  const QUALIFY_REJECT_FRAME = 3;
  const QUALIFY_BODY = '你好，请问可以加个好友吗？';
  const KEY_FRAME_EMPTY = 4;
  const REVENGE_FRAME = 2;
  const REPLAY_FRAME = 1;
  const REPLY_FRAME = 2;

  // ⚠ `State.recordBattle` 在缺 kind 时写的是中文 '挑战'（js/state.js:3488），
  // 所以这张表里必须同时有 'challenge' 与 '挑战'，否则那种记录会显示成"挑战 · 挑战"。
  const KIND_LABEL = {
    challenge: '挑战', '挑战': '挑战', stage: '关卡', tower: '挑战塔', endless: '无尽塔',
    arena: '竞技场', rank: '天梯赛', friend: '切磋', wood: '测攻击', master: '师徒', apprentice: '师徒', revenge: '复仇', leave: '留言',
    defense_win: '防守', defense_loss: '防守',
  };

  const REVENGE_EXCLUDED_KINDS = ['tower', 'endless', 'stage'];
  // 这条记录能不能复仇：败绩 + 不是复仇自己 + 不在排除名单里。
  function canRevenge(r) {
    if (window.__SSDZ_ONLINE__) {
      // 原版复仇只来自被抢方收到的当天战报，不是自己主动打输的战报。
      // eligibility 由服务端 `revengeInfoFor` 计算，客户端不再自己猜。
      if (!r || !r.serverMessage || !r.revenge || !r.revenge.eligible) return false;
      if (!r.online || !r.online.combatId) return false;
      return !!(r.online.opponentId || r.online.snapshotId);
    }
    return !!r && r.winner !== 0 && r.kind !== 'revenge' && REVENGE_EXCLUDED_KINDS.indexOf(r.kind) < 0;
  }

  // 本地没有服务端：留言页（tab 4）按 `doShowLeaveMsg` 的排版写一句说明，
  // 而不是留一页空白（原版这一档的正文是服务端下发的 leaveMessages）。
  const CHAT_NOTICE_BODY = '本地怀旧版暂不连接公共聊天与留言服务，这里保留原版留言页的排版。';
  const CHAT_NOTICE_HEAD = '本地怀旧版';

  const EMPTY_HINT = {
    messages: '暂时没有战斗消息。去打一场挑战，战报就会记在这里。',
    ranklog: '还没有天梯赛记录。到竞技场参加天梯赛，胜负都会记在这里。',
    revenge: '还没有可以复仇的当天战报。只有天梯赛被抢走金杯后，当天才能复仇。',
  };



  function stopAt(clip, n) {
    if (!clip || !clip.gotoAndStop) return;
    try { clip.gotoAndStop(n); } catch (e) {}
  }
  // 原版的 `mc.left._visible = false`（不是切禁用帧）—— 照抄成 CSS `visibility`。
  // ⚠ 点击路由会把 `visibility:hidden` 的元件判成"谁都没命中"（见 ui-main.js 的 refresh），
  function setVisible(clip, on) {
    if (clip && clip.g) clip.g.style.visibility = on ? '' : 'hidden';
  }
  function setTextByName(host, name, str) {
    const t = T();
    const n = clipOf(host, name);
    if (n && t) t.setText(n, str == null ? '' : String(str));
    return n;
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
    clip.__msgFire = spec.onFire || null;
    clip.__msgIdle = idleOf;
    clip.__msgHover = Number(spec.hover) || 0;
    clip.__msgPress = Number(spec.press) || 0;
    // 监听器只挂一次：重画时同一颗实例会被重新接线（新的 idle / onFire），不能重复 addEventListener。
    if (!clip.__msgListeners) {
      clip.__msgListeners = true;
      clip.g.addEventListener('mouseenter', () => {
        if (!clip.__msgHover) return;
        setPinned(clip, clip.__msgHover);
        refreshShell(clip);
      });
      clip.g.addEventListener('mouseleave', () => { pinIdle(clip); refreshShell(clip); });
      clip.g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (clip.__msgPress) {
          t.pressFlash(clip, idleOf(), () => { pinIdle(clip); refreshShell(clip); }, (f) => setPinned(clip, f));
        }
        if (clip.__msgFire) clip.__msgFire();
      });
    }
    pinIdle(clip);
    clip.g.style.cursor = 'pointer';
    clip.g.style.pointerEvents = 'auto';
    t.measureHitBox(clip);
    t.popWrap(clip);
    const shell = clip.g.querySelector(':scope > g.uc-pop');
    if (shell) t.wirePopPress(shell);
  }

  function setPinned(clip, frame) {
    if (!clip || !clip.gotoAndStop) return;
    const want = Math.max(1, Math.round(Number(frame) || 1));
    clip.__pinFrame = null;
    if (clip.frame !== want - 1) { try { clip.gotoAndStop(want); } catch (e) {} }
    clip.playing = false;
  }

  function pinIdle(clip) {
    if (!clip || !clip.__msgIdle) return;
    setPinned(clip, clip.__msgIdle());
  }

  // `render.js` 的文本容器只按框宽横向裁、纵向放开：一整句塞进去会被切掉右半截，
  // 全角字的步进用这个字段已经画出来的那一行实测；量不到（`blank` 把占位串清掉了，
  // ⚠ 不查 `textfields-index.json` 的 `charsPerLine`：那份索引是生成期快照，目前还没把
  const wrapCache = new WeakMap();
  function wrapToField(clip, text, maxLines) {
    const src = String(text == null ? '' : text);
    if (!clip || !clip.__textBox) return src;
    const tb = clip.__textBox;
    if (!tb.meta || !tb.meta.bd) return src;
    const W = tb.meta.bd[1] - tb.meta.bd[0] - (tb.meta.lm || 0) - (tb.meta.rm || 0);
    if (!(W > 8)) return src;
    // ⚠ 文本容器的 DOM 就是那个 `<g type="text">` 本身（`__textBox` 挂在它上面），不是 MovieClip。
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
    // 行数上限：正文那格放不下第 4 行，宁可截断也不要冲进下一条记录。
    if (maxLines && out.length > maxLines) {
      out.length = maxLines;
      out[maxLines - 1] = out[maxLines - 1].slice(0, Math.max(1, per - 1)) + '…';
    }
    return out.join('\n');
  }

  function writeField(node, text, maxLines) {
    const t = T();
    if (!node || !t) return;
    t.setText(node, wrapToField(node, text, maxLines));
  }

  // 数据：四个 tab 各自的清单（`showMessageTab` 的四档）
  // ②天梯赛 = `kind === 'rank'`；③复仇 = 败绩且可复仇；④留言 = 本地说明（没有服务端）。
  // 原版这四份数据是服务端接口（getMessages / getRankMessage / getLeaveMessages），
  function listOf(tab, all) {
    if (tab === 'ranklog') return all.filter((r) => r && r.kind === 'rank');
    if (tab === 'revenge') return all.filter(canRevenge);
    if (tab === 'chat') return window.__SSDZ_ONLINE__ ? ((current && current.board) || []) : [{ notice: true }];
    return all.filter((r) => r && r.kind !== 'rank');
  }

  function timeText(ts) {
    const d = new Date(Number(ts) || 0);
    if (!Number.isFinite(d.getTime()) || !d.getTime()) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function bodyOf(r) {
    if (!r) return '';
    if (r.notice) return CHAT_NOTICE_BODY;
    if (r.boardMessage) return '【' + String(r.from && r.from.name || '玩家') + '】：' + String(r.text || '');
    if (r.serverMessage) {
      const text = r.text || '';

      return r.claimed ? text.replace('（可领取：', '（已领取：') : text;
    }
    const label = KIND_LABEL[r.kind] || String(r.kind || '挑战');
    const foe = (r.foe && r.foe.name) ? String(r.foe.name) : '对手';
    return label + ' · 你挑战了【' + foe + '】，' + (r.winner === 0 ? '获得胜利！' : '遗憾落败。');
  }
  function timeOf(r) {
    if (!r) return '';
    if (r.notice) return CHAT_NOTICE_HEAD;
    return timeText(r.createdAt);
  }
  // 这一条能不能播录像（原版 `msg.combatId > 0`）。本地每条战斗记录都带 `result.rounds`。
  function replayable(r) {
    if (window.__SSDZ_ONLINE__ && r && r.online && r.online.combatId) return true;
    return !!(r && r.result && Array.isArray(r.result.rounds) && r.result.rounds.length);
  }

  // 奖励邮件（联机版新增，原版消息页没有附件）
  // 两类发信入口共用这套展示：`server/admin-broadcast.js` 的全服公告，以及
  // 服务端把奖励写在消息 `payload`（gold / cup / props / title），并标 `claimable`。
  function rewardItems(rec) {
    const payload = (rec && rec.payload) || {};
    const classic = window.UI && UI.classic;
    const out = [];
    const gold = Math.floor(Number(payload.gold) || 0);
    const cup = Math.floor(Number(payload.cup) || 0);
    const iconFor = (id) => {
      if (classic && typeof classic.propIconSrc === 'function') return classic.propIconSrc(id);
      return 'images/ui/icons/prop/prop-' + id + '.svg';
    };
    const art = (src) => '<img class="mail-reward-art" alt="" src="' + htmlEscape(src) + '">';
    if (gold > 0) {
      out.push({
        name: '金松果', count: gold,
        html: classic && typeof classic.goldIcon === 'function'
          ? classic.goldIcon('mail-reward-art')
          : art('images/ui/icons/gold-acorn.svg'),
      });
    }
    if (cup > 0) out.push({ name: '金杯', count: cup, html: art(iconFor(40)) });
    const props = payload.props;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const key of Object.keys(props)) {
        const id = Number(key), count = Math.floor(Number(props[key]) || 0);
        if (!(id > 0) || !(count > 0)) continue;
        const def = window.propMap && typeof propMap.getValue === 'function' ? propMap.getValue(id) : null;
        out.push({
          name: def ? String(def.name || ('道具' + id)) : ('道具' + id),
          count: count,
          html: art(iconFor(id)),
        });
      }
    }
    return out;
  }
  function rewardText(rec) {
    const items = rewardItems(rec);
    return items.length ? items.map((it) => it.name + ' ×' + it.count).join('、') : '无';
  }
  async function claimRewardMail(rec, modal) {
    if (!rec || rec.claiming || rec.claimed) return;
    if (!window.Online || !Online.ready) { toast('还没有连上服务器。'); return; }
    rec.claiming = true;
    try {
      const out = await Online.post('/api/messages/claim', { id: rec.id });
      if (!out || out.ok !== true) { toast((out && out.message) || '领取失败'); return; }
      rec.claimed = true;
      rec.claimable = false;
      rec.pinned = false;
      rec.payload = Object.assign({}, rec.payload || {}, { claimedAt: Date.now() });
      if (current && Array.isArray(current.all)) current.all.sort(sortMessages);
      try { await Online.syncState(); } catch (e) { pushErr('reward mail sync', e); }
      toast(out.already ? '奖励已经领取过了。' : '已领取：' + rewardText(rec));
      if (modal && typeof modal.close === 'function') modal.close();
      paint();
    } catch (e) {
      toast(Online.errText ? Online.errText(e) : '领取失败');
      pushErr('reward mail claim', e);
    } finally {
      rec.claiming = false;
    }
  }
  function openRewardMail(rec) {
    const c = window.UI && UI.classic;
    if (!c || typeof c.modal !== 'function') { toast('奖励弹窗加载失败，请稍后再试。'); return; }
    const items = rewardItems(rec);

    const list = items.map((it) => {
      const label = htmlEscape(it.name + ' ×' + it.count);
      return '<li title="' + label + '" aria-label="' + label + '">' + it.html +
        '<b class="mail-reward-count">×' + it.count + '</b></li>';
    }).join('');
    // 弹窗里已经有奖励清单，正文去掉服务端拼的「（可领取：…）」后缀，避免重复。
    const headline = String(rec.text || '全服奖励').replace(/（可领取：[^）]*）\s*$/, '');
    const body = '<p>' + htmlEscape(headline) + '</p>' +
      (list ? '<ul class="mail-reward-list">' + list + '</ul>' : '<p class="small-label">这条公告没有可领取的奖励。</p>') +
      '<p class="small-label">领取后奖励直接进入存档；同一封邮件只能领一次。</p>';
    // 标题由服务端模板给（`payload.title`，例如「开服奖励邮件」）；老的全服公告没有这个字段。
    const title = String((rec.payload && rec.payload.title) || '全服奖励邮件');
    const modal = c.modal(title, body, [
      { label: '领取', cls: 'gold', close: false, run: () => { void claimRewardMail(rec, modal); } },
      { label: '取消', cls: 'muted' },
    ], { small: true });
  }

  // 一条记录 → 各元件的档位 / 动作
  // 收徒（复刻没有这份服务端字段 → 恒停空档），`b` 只有 `combatId > 0` 才是查看录像。
  function planOf(r, tab) {
    if (!r) {
      return { win: WIN_FRAME_EMPTY, a: KEY_FRAME_EMPTY, b: KEY_FRAME_EMPTY,
        onA: null, onB: null, fallback: true, body: '', time: '' };
    }
    const body = bodyOf(r), time = timeOf(r);
    if (tab === 'chat') {
      if (r.boardMessage) return { win: WIN_FRAME.leave, a: KEY_FRAME_EMPTY, b: REPLY_FRAME, body, time,
        fallback: false, onB: () => replyBoard(r) };
      return { win: WIN_FRAME.leave, a: KEY_FRAME_EMPTY, b: REPLY_FRAME, body, time,
        fallback: false, onB: () => toast('本地怀旧版暂不连接公共聊天与留言服务，无法回复留言。') };
    }
    const rankTab = tab === 'ranklog' || tab === 'revenge';
    const win = rankTab ? WIN_FRAME.rank : (r.winner === 0 ? WIN_FRAME.win : r.winner === 1 ? WIN_FRAME.lose : WIN_FRAME.unknown);

    const rev = rankTab && canRevenge(r);
    const rec = replayable(r);
    return {
      win: win,
      a: rev ? REVENGE_FRAME : KEY_FRAME_EMPTY,
      b: rec ? REPLAY_FRAME : KEY_FRAME_EMPTY,
      body: body, time: time,

      fallback: !rev && !rec,
      onRow: r && r.claimable ? () => openRewardMail(r) : null,
      onA: rev ? () => startRevenge(r) : null,
      onB: rec ? () => playReplay(r) : null,
    };
  }

  // 验证消息（原版 `showQualifyMsg` / `showAddFriendMc` 第 4 帧）
  // 入口是消息页底栏 `button2`（7816）+ 红点 `qualifyNew`（3180）。原版这段单独
  // 数据走服务端 `/api/friends/requests`（原版 `messages.do?type=3`）；
  function qualifyPlan(req) {
    if (!req) {
      return { win: WIN_FRAME_EMPTY, a: KEY_FRAME_EMPTY, b: KEY_FRAME_EMPTY,
        onA: null, onB: null, fallback: true, body: '', time: '' };
    }
    return {
      win: QUALIFY_FRAME, a: QUALIFY_ACCEPT_FRAME, b: QUALIFY_REJECT_FRAME,
      body: QUALIFY_BODY,
      time: 'lv' + (Number(req.level) || 1) + ' ' + String(req.name || ''),
      fallback: false,
      onA: () => respondQualify(req, true),
      onB: () => respondQualify(req, false),
    };
  }

  async function loadQualify(page) {
    if (!page || !window.__SSDZ_ONLINE__ || !window.Online || !Online.ready) return;
    const token = (window.Net && Net.token) ? Net.token() : '';
    page.qualifyLoading = true;
    try {
      const out = await Online.get('/api/friends/requests');
      if (current !== page || !page.view || (window.Net && Net.token && Net.token() !== token)) return;
      page.requests = Array.isArray(out && out.requests) ? out.requests : [];
      page.requestCount = Number(out && out.count != null ? out.count : page.requests.length) || 0;
      page.qualifyLoading = false;
      if (current === page) paint();
    } catch (e) {
      if (current === page) { page.qualifyLoading = false; paint(); }
    }
  }
  // 点底栏「好友验证」：切到验证列表（联机）；单机没有服务端来源，按未接入提示。
  function openQualify() {
    if (!current) return;
    if (!window.__SSDZ_ONLINE__) { toast('好友验证未接入：本地怀旧版没有加好友请求这类服务端消息。'); return; }
    current.mode = 'qualify';
    current.page = 1;
    paint();
    void loadQualify(current);
  }

  function respondQualify(req, accept) {
    const page = current;
    if (!page || page.mode !== 'qualify' || page.qualifyBusy) return;
    if (!window.__SSDZ_ONLINE__ || !window.Online || !Online.ready || !window.OnlineUI || !OnlineUI.respondFriendRequest) return;
    const id = req && req.messageId;
    if (!id) return;
    page.qualifyBusy = true;
    void (async () => {
      try {
        await OnlineUI.respondFriendRequest(id, accept);
        if (current !== page) return;
        page.qualifyBusy = false;
        if (accept) toast('已成功添加好友。');
        void loadQualify(page);
      } catch (e) {
        page.qualifyBusy = false;
        if (current === page) toast(window.Online && Online.errText ? Online.errText(e) : '操作失败，请稍后再试。');
      }
    })();
  }


  let pending = null;
  // 落点的有效期：它是"刚打完一场、马上回本页"用的，过期不候 ——
  // 否则某次回调没跑成（战斗被中断）会把它留到下一次进页面，把玩家丢到别的 tab / 页码上。
  const PENDING_MS = 15000;

  function reopen(spot) {
    pending = spot ? { tab: spot.tab, page: spot.page, at: Date.now() } : null;
    if (window.UI && UI.runAction) { UI.runAction('messages'); return; }
    guard(open(null, spot && spot.tab, spot && spot.page));
  }
  function playReplay(record) {
    const spot = current ? { tab: current.tab, page: current.page } : null;
    if (window.__SSDZ_ONLINE__) {
      if (window.Online && Online.battle && record.online && record.online.combatId)
        void Online.battle.replay(record.online.combatId, '', { onDone: () => { if (Online.ready) reopen(spot); } });
      else toast('录像不可用。');
      return;
    }
    if (!(window.Main && Main.replayBattle)) { toast('录像回放暂不可用'); return; }

    Main.replayBattle(record, () => reopen(spot));
  }
  // 复仇：拿录像里记下的对手快照再打一场。
  // ⚠ `js/classic-ui.js` 的 `revengeFight` 没有导出到 `UI.classic` 上（2026-10 实测），
  // 所以这里按它那份逻辑写一份最小实现，用的是同一批 `State` / `Main` 接口与同一套文案。
  function startRevenge(record) {
    if (window.__SSDZ_ONLINE__) {
      const modal = window.UI && UI.classic && UI.classic.modal;
      const page = current;
      if (!modal || !window.Online || !Online.battle || !canRevenge(record)) { toast('暂不能再次挑战该玩家。'); return; }
      const S = State.state();
      const info = record.revenge || null;
      if (!info || !info.eligible) { toast('这条战报已过了复仇时间，或没有可复仇的抢杯记录。'); return; }
      const cost = Math.max(1, Math.floor(Number(info.cost) || 20));
      const cups = Math.max(0, Math.floor(Number(info.cups) || 8));
      if (Math.max(0, Number(S.goldPoint) || 0) < cost) {
        modal('金松果不足', '<div class="result-box"><p>你的金松果不足，你不能向他复仇。赶快去兑换吧！</p><p class="small-label">复仇需要 <b>' + cost + '</b> 个金松果，当前只有 <b>' + Math.max(0, Number(S.goldPoint) || 0) + '</b> 个。</p></div>', [{ label: '知道了' }], { small: true });
        return;
      }
      const go = async () => {
        if (current !== page || !Online.ready) return;
        try {
          // 服务端用对方当前快照重打；费用、金杯与战后宝箱/飘物都由服务端结算。
          let snapshot = record.online.snapshotId;
          if (record.online.opponentId) snapshot = (await Online.get('/api/fighter?accountId=' + encodeURIComponent(record.online.opponentId))).snapshotId;
          if (current !== page || !Online.ready) return;
          await Online.battle.rank(snapshot, {
            revengeOf: record.online.combatId || '', target: { action: 'messages' },
            revenge: { cost, cups },
          });
        } catch (e) { if (current === page) toast(Online.errText(e)); }
      };

      const plain = '复仇需要' + cost + '个金松果，胜利后抢夺' + cups + '个金杯，确定复仇吗？';
      const wallet = '当前金松果：' + Math.max(0, Number(S.goldPoint) || 0) + '　金杯：' + Math.max(0, Number(S.goldCup) || 0);
      if (window.SfChallenge && SfChallenge.openOriginalConfirm && current) {
        SfChallenge.openOriginalConfirm({
          owner: current.host, label: '复仇确认', text: plain + '\n' + wallet, accept: go,
        }).catch((e) => { toast('确认界面加载失败，请重试。'); if (window.__errs) window.__errs.push(String(e)); });
      } else {
        modal('复仇确认', '<div class="result-box"><p>' + plain + '</p><p class="small-label">' + wallet + '</p></div>',
          [{ label: '确定复仇', cls: 'gold', run: go }, { label: '取消', cls: 'muted' }], { small: true });
      }
      return;
    }
    if (!record || !(window.Main && Main.startBattle)) { toast('战斗模块未加载'); return; }
    if (record.revenged) { toast('这条败绩已经复仇过了。'); return; }
    const info = State.revengeInfo ? State.revengeInfo(record.id) : { cost: 20, cups: 0, cupsMin: 0, ladder: false, count: 0 };

    const ladder = !!(info.ladder || record.kind === 'rank');
    const cupRoll = ladder && Math.random() < 0.5 ? 1 : 0;
    const modal = (window.UI && UI.classic && UI.classic.modal) || null;
    const resultModal = (window.UI && UI.classic && UI.classic.resultModal) || null;
    const S = State.state();
    if (S.goldPoint < info.cost) {
      if (modal) modal('金松果不足', '<div class="result-box"><p>复仇需要 <b>' + info.cost + '</b> 个金松果，当前只有 <b>' + S.goldPoint + '</b> 个。<br>先去攒够金松果再来吧。</p></div>', [{ label: '知道了' }]);
      return;
    }
    const go = () => {
      if (State.state() !== S) return;
      if (S.goldPoint < info.cost) { toast('金松果不足，复仇取消。'); return; }
      State.addGold(-info.cost);
      State.noteRevenge(record.id);
      const cups = cupRoll;
      const spot = current ? { tab: current.tab, page: current.page } : null;
      const foe = Object.assign({}, record.foe || {});
      Main.startBattle(foe, {
        region: record.region || 0, kind: 'revenge', useProps: false, collectDrops: false, skipResultPanel: true,
        onEnd: (winner) => {
          reopen(spot);
          if (winner !== 0) {
            if (modal) modal('复仇失败', '<div class="result-box"><div class="result-title lose">又输了</div><p>复仇消耗了 ' + info.cost + ' 个金松果，失败没有额外补偿。</p></div>', [{ label: '返回' }]);
            return;
          }
          if (!(window.State && State.markRevenged && State.markRevenged(record.id))) {
            if (modal) modal('复仇成功', '<div class="result-box"><div class="result-title win">胜 利！</div><p>这条败绩之前已经复仇过了，本次不再重复发补偿。</p></div>', [{ label: '返回' }]);
            return;
          }
          if (cups > 0) State.addGoldCup(cups);
          const rw = State.revengeReward(foe.level);
          State.save();
          const cupText = ladder
            ? (cups > 0 ? '，抢夺 ' + cups + ' 个金杯' : '，本次没有抢到金杯')
            : '';
          if (resultModal) resultModal(true, rw, '复仇成功：' + (foe.name || '对手') + ' 已被击败' + cupText + '，补回少量经验与金松果。', () => {});
        },
      });
    };

    if (modal) {
      const reward = ladder
        ? '，胜利后抢夺 <b>0~1</b> 个金杯（本场随机：<b>' + cupRoll + '</b> 个）'
        : '，胜利后补回少量经验与金松果';
      const wallet = ladder
        ? '当前金松果：' + S.goldPoint + '　金杯：' + (S.goldCup || 0)
        : '当前金松果：' + S.goldPoint;
      if (window.SfChallenge && SfChallenge.openOriginalConfirm && current) {
        const plainReward = ladder ? '，胜利后抢夺0~1个金杯' : '，胜利后补回少量经验与金松果';
        SfChallenge.openOriginalConfirm({ owner: current.host, label: '复仇确认',
          text: '复仇需要' + info.cost + '个金松果' + plainReward + '，确定复仇吗？\n' + wallet,
          accept: go }).catch(e => { toast('确认界面加载失败，请重试。'); if (window.__errs) window.__errs.push(String(e)); });
      } else {
        modal('复仇确认', '<div class="result-box"><p>复仇需要 <b>' + info.cost + '</b> 个金松果' + reward + '，确定复仇吗？</p><p class="small-label">' + wallet + '</p></div>',
          [{ label: '确定复仇', cls: 'gold', run: go }, { label: '取消', cls: 'muted' }]);
      }
    } else {
      go();
    }
  }


  let current = null;
  let seq = 0;             // 挂载代次（异步挂载完成后核对；见 open()）
  let openTrace = '';

  function sortMessages(a, b) {
    return (Number(b.pinned) ? 1 : 0) - (Number(a.pinned) ? 1 : 0)
      || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  }
  async function refreshBoardNotice(page) {
    if (!page || !window.Online || !Online.ready) return;
    const token = window.Net && Net.token ? Net.token() : null;
    const active = () => current === page && page.host.isConnected !== false && Online.ready && (!window.Net || !Net.token || Net.token() === token);
    try {
      const inbox = await Online.get('/api/messages?limit=50');
      if (!active()) return;
      const serverRows = (inbox.messages || []).filter(m => m.kind !== 'friend_message').map(m => {
        const payload = (m.payload && typeof m.payload === 'object') ? m.payload : {};
        const claimed = !!(payload.claimedAt || m.claimedAt);
        // 胜负章：天梯/防守有自己的 kind；好友切磋与被收徒/守擂用 payload 里的
        // `defenderWin` / `win` 兜底，旧消息没有这些字段时仍显示「未知」。
        const win = (m.kind === 'rank_loss' || m.kind === 'defense_loss') ? 1
          : (m.kind === 'rank_win' || m.kind === 'defense_win') ? 0
            : (typeof payload.defenderWin === 'boolean') ? (payload.defenderWin ? 0 : 1)
              : (typeof payload.win === 'boolean') ? (payload.win ? 0 : 1) : 2;
        return {
          id: m.id, serverMessage: true, text: m.text, createdAt: m.createdAt, read: !!m.read,
          pinned: !!m.pinned,
          kind: /^rank_/.test(m.kind) ? 'rank' : m.kind === 'friend_spar' ? 'friend' : m.kind,
          winner: win,
          robbed: Number(payload.robbed) || 0,
          revenge: payload.revenge || null,
          payload: payload,
          claimable: !!payload.claimable && !claimed,
          claimed: claimed,
          online: { combatId: m.combatId || '', opponentId: m.from && m.from.accountId || 0 },
        };
      });
      // 未领取的开发者礼包固定最前；领取后服务端 pinned=false，回到普通时间序。
      page.all = page.localAll.concat(serverRows).sort(sortMessages);
      const ids = (inbox.messages || []).filter(m => m.kind === 'friend_message' && !m.read).map(m => m.id);
      page.boardUnread = ids.length > 0 || Number(window.Online && Online.badge && Online.badge.leave) > 0;
      if (page.tab === 'chat' && ids.length) {
        const readOut = await Online.post('/api/messages/read', { ids });
        if (!active()) return;
        // 服务端返回剩余留言未读（超过 50 条时这次只标了看得到的这一页）。
        page.boardUnread = Number(readOut && readOut.leave) > 0;
        if (Online.refreshBadge) void Online.refreshBadge();
      }
      paint();
    } catch (e) { if (active()) pushErr('SfMessage board notice', e); }
  }

  async function loadBoard(page) {
    if (!page || !window.Online || !Online.ready) return;
    const token = window.Net && Net.token ? Net.token() : null;
    const request = page.boardRequest = (page.boardRequest || 0) + 1;
    const active = () => current === page && page.boardRequest === request && page.host.isConnected !== false && Online.ready && (!window.Net || !Net.token || Net.token() === token);
    page.boardLoading = true;
    page.boardError = false;
    if (page.tab === 'chat') paint();
    try {
      const out = await Online.get('/api/board');
      if (!active()) return;
      page.board = (Array.isArray(out.messages) ? out.messages : []).map(m => Object.assign({}, m, { boardMessage: true }));
      page.boardLoading = false;
      if (page.tab === 'chat') paint();
    } catch (e) {
      if (active()) { page.boardLoading = false; page.boardError = true; if (page.tab === 'chat') paint(); toast(Online.errText(e)); }
    }
  }
  function replyBoard(message) {
    const target = Number(message && message.from && message.from.accountId);
    const page = current;
    const c = window.UI && UI.classic;
    if (!target || !c || !c.modal || !window.Online || !Online.ready) { toast('该玩家已不可留言。'); return; }
    const token = window.Net && Net.token ? Net.token() : null;
    const active = () => current === page && page.host.isConnected !== false && Online.ready && (!window.Net || !Net.token || Net.token() === token);
    let busy = false;
    const escape = s => String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const modal = c.modal('回复留言', '<p style="white-space:pre-wrap;overflow-wrap:anywhere">【' + escape(message.from.name) + '】：' + escape(message.text) + '</p><textarea data-board-reply maxlength="200" placeholder="输入回复（最多 200 字）" style="width:100%;min-height:80px;box-sizing:border-box"></textarea>', [
      { label: '发送', cls: 'gold', close: false, run: async () => {
        if (busy || !active() || !modal.element.isConnected) return;
        const text = String(modal.element.querySelector('[data-board-reply]').value || '').trim();
        if (!text) { toast('留言不能为空。'); return; }
        busy = true;
        try { await Online.post('/api/board', { toId: target, text }); if (active() && modal.element.isConnected) { modal.close(); toast('回复已发送。'); } }
        catch (e) { if (active()) toast(Online.errText(e)); }
        finally { busy = false; }
      } }, { label: '返回', cls: 'muted' },
    ], { small: true });
  }

  function activeTab() { return current ? current.tab : 'messages'; }


  function wireTabs() {
    const view = current && current.view;
    if (!view) return;
    for (const row of TABS) {
      wireClickable(clipOf(view, row[0]), {
        hover: 3,
        idle: () => (row[1] === activeTab() ? 2 : 1),
        press: 0,
        onFire: () => setTab(row[1]),
      });
    }
  }
  // 底栏三颗 + 左右翻页箭头。它们挂在页根唯一那一帧上，实例不会随翻页重建，接一次即可。
  function wireChrome() {
    const view = current && current.view;
    if (!view) return;

    wireClickable(clipOf(view, 'back'), {
      hover: 2,
      onFire: () => {
        if (current && current.mode === 'qualify') { current.mode = 'normal'; current.page = 1; paint(); return; }
        destroy(); if (window.UI && UI.runAction) UI.runAction('home');
      },
    });
    // `button1`(7813) = 论坛 / `button2`(7816) = 验证消息：原版分别走 `openWap(gameBBs)` 与
    // `getQualifyMessages`。联机版接服务端；单机没有加好友请求这类消息，给一句提示。
    wireClickable(clipOf(view, 'button1'), {
      hover: 2,
      onFire: () => {
        if (window.__SSDZ_ONLINE__ && window.OnlineUI && OnlineUI.forum) OnlineUI.forum();
        else toast('论坛未接入：本地怀旧版没有服务端。');
      },
    });
    wireClickable(clipOf(view, 'button2'), {
      hover: 2,
      onFire: openQualify,
    });

    const ARROW = (onFire) => ({ hover: 0, press: 0, idle: 1, onFire: onFire });
    wireClickable(clipOf(view, 'left'), ARROW(() => goPage(-1)));
    wireClickable(clipOf(view, 'right'), ARROW(() => goPage(1)));
  }


  function setTab(key) {
    if (!current) return;
    if (current.mode === 'qualify') {
      current.mode = 'normal';
      current.tab = key;
      current.page = 1;
      paint();
      if (key === 'chat' && window.__SSDZ_ONLINE__) void loadBoard(current);
      if (key === 'chat' && window.__SSDZ_ONLINE__) void refreshBoardNotice(current);
      return;
    }
    if (current.tab === key) return;
    current.tab = key;
    current.page = 1;
    paint();
    if (key === 'chat' && window.__SSDZ_ONLINE__) void loadBoard(current);
    if (key === 'chat' && window.__SSDZ_ONLINE__) void refreshBoardNotice(current);
  }

  function goPage(delta) {
    if (!current) return;
    const want = (current.page || 1) + delta;
    if (want < 1 || want > (current.pages || 1)) return;
    current.page = want;
    paint();
  }

  // 画一条记录（`slot` = 0/1；`rec` 为 null = 空槽位）。
  // ⚠ 顺序要紧：先给外层拨帧（`a1`/`b1` 换帧会把里面那颗 `a`/`b` 整个重建），
  function paintRow(slot, rec, hint) {
    const view = current.view;
    const n = slot + 1;
    const win = clipOf(view, 'win' + n);
    const aBox = clipOf(view, 'a' + n);
    const bBox = clipOf(view, 'b' + n);
    const back = clipOf(view, 'back' + n);
    const body = clipOf(view, 'text' + n);
    const time = clipOf(view, 'text' + n + n);
    const plan = current.mode === 'qualify' ? qualifyPlan(rec) : planOf(rec, current.tab);
    const text = rec ? plan.body : (hint || '');
    writeField(body, text, 3);
    writeField(time, rec ? plan.time : '', 1);
    stopAt(win, plan.win);
    stopAt(aBox, plan.a);
    stopAt(bBox, plan.b);
    stopAt(back, 1);

    const inner = (box, name, onFire) => {
      const clip = box && box.byName ? box.byName(name) : null;
      if (clip && onFire) wireClickable(clip, { hover: 2, press: 0, idle: 1, onFire: onFire });
      return clip;
    };
    const aBtn = inner(aBox, 'a', plan.onA);
    const bBtn = inner(bBox, 'b', plan.onB);

    if (plan.fallback || plan.onRow) wireClickable(back, { hover: 2, press: 0, idle: 1, onFire: plan.onRow || (() => {}) });
    return {
      slot: slot, empty: !rec, notice: !!(rec && rec.notice),
      id: rec ? rec.id || null : null, kind: rec ? rec.kind || null : null,
      win: rec ? (rec.notice ? 'leave' : (rec.winner === 0 ? 'win' : 'lose')) : 'empty',
      frames: { win: plan.win, a: plan.a, b: plan.b, back: 1 },
      buttons: { a: !!aBtn, b: !!bBtn, fallback: !!plan.fallback, row: !!plan.onRow },
      text: text, time: rec ? plan.time : '',
    };
  }

  // 鼠标在整条消息上时给该条底图拨高亮帧（第 2 帧）。
  // ⚠ 只有 `back` 是兜底按钮（这一条没有任何功能键）时才由 `wireClickable(back)` 挂
  function wireRowHover() {
    const view = current && current.view;
    if (!view || !view.g) return;
    const svg = view.g.ownerSVGElement
      || (view.g.tagName && String(view.g.tagName).toLowerCase() === 'svg' ? view.g : null)
      || (view.g.ownerDocument && view.g.ownerDocument.querySelector('#ui svg'));
    if (!svg || svg.__msgRowHover) return;
    svg.__msgRowHover = true;
    const setRow = (n, hot) => {
      const back = clipOf(view, 'back' + n);
      if (!back || !back.g) return;
      const want = hot ? 2 : 1;
      if (back.frame !== want - 1) setPinned(back, want);
    };
    const move = (ev) => {
      if (!current || current.view !== view) return;
      const x = ev.clientX, y = ev.clientY;
      for (let n = 1; n <= 2; n++) {
        const back = clipOf(view, 'back' + n);
        if (!back || !back.g) { setRow(n, false); continue; }
        const r = back.g.getBoundingClientRect();
        const inside = r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        setRow(n, inside);
      }
    };
    const leave = () => { setRow(1, false); setRow(2, false); };
    svg.addEventListener('mousemove', move);
    svg.addEventListener('mouseleave', leave);
  }


  function paint() {
    const c = current;
    if (!c) return;
    const view = c.view;
    const qualify = c.mode === 'qualify';
    const list = qualify ? (c.requests || []) : listOf(c.tab, c.all);
    const pages = Math.max(1, Math.ceil(list.length / ONE_PAGE));
    const page = Math.max(1, Math.min(pages, c.page || 1));
    c.page = page; c.pages = pages; c.list = list;

    const hint = list.length ? '' : (qualify
      ? (c.qualifyLoading ? '正在读取好友验证…' : '还没有收到好友申请。')
      : (c.tab === 'chat' && window.__SSDZ_ONLINE__ ? (c.boardLoading ? '正在读取留言…' : c.boardError ? '留言读取失败，请重新进入留言板。' : '还没有收到留言。') : (EMPTY_HINT[c.tab] || '')));
    c.rows = [];
    for (let i = 0; i < ONE_PAGE; i++) {
      const rec = list[(page - 1) * ONE_PAGE + i] || null;
      c.rows.push(paintRow(i, rec, i === 0 ? hint : ''));
    }
    setTextByName(view, 'page', page + '/' + pages);

    setVisible(clipOf(view, 'left'), page > 1);
    setVisible(clipOf(view, 'right'), page < pages);
    // 三个 new 红点（原版 `showNewMessage1`：有新的 → 1，否则 → 2）。
    stopAt(clipOf(view, 'revengeNew'), c.fresh && c.fresh.revenge ? 1 : 2);
    stopAt(clipOf(view, 'leaveNew'), window.__SSDZ_ONLINE__ && c.boardUnread ? 1 : 2);

    stopAt(clipOf(view, 'qualifyNew'), Number(c.requestCount) > 0 ? 1 : 2);
    wireTabs();
    wireRowHover();
  }

  // 「复仇」红点：可复仇的记录里有没有比 `State.msgSeenAt()` 更新的。
  // ⚠ 必须在 `markMessagesSeen()` 之前算 —— 那一步会把"看到哪了"推到最新（红点随即熄灭）。
  function freshDots(all) {
    const seen = (window.State && State.msgSeenAt) ? (Number(State.msgSeenAt()) || 0) : 0;
    return { revenge: all.filter(canRevenge).some((r) => (Number(r.createdAt) || 0) > seen) };
  }



  function tabKeyOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const at = Math.max(1, Math.min(TABS.length, Math.round(v)));
      return TABS[at - 1][1];
    }
    const k = String(v == null ? '' : v);
    if (TAB_NUM[k]) return k;
    if (k === 'leave' || k === 'chatlog') return 'chat';
    return 'messages';
  }
  function guard(promise) {
    if (promise && typeof promise.catch === 'function') promise.catch((e) => pushErr('SfMessage', e));
  }

  async function open(container, tab, page) {
    openTrace = 'start';
    if (!window.SfRender || !SfRender.mountSymbol) throw new Error('SfRender 未加载（缺 js/ssfight/render.js）');
    const t = T();
    if (!t) throw new Error('SfUiMain.toolkit 不在（缺 js/ssfight/ui-main.js）');
    let host = container || (current && current.host);
    if (!host) {
      const ui = document.getElementById('ui');
      if (ui) {
        ui.innerHTML = '<section class="classic-home ssfight-home" aria-label="松鼠消息"></section>';
        host = ui.querySelector('.ssfight-home');
      }
    }
    if (!host) { openTrace = 'no-host'; return false; }
    // 作废在途挂载：先领号再拆树（`destroy()` 只拆树、不动 `seq`，递增统一在这里）。
    // 下面每一处 `await` 之后都要核对代次 —— 过期视图直接销毁，绝不能盖掉后来进入的页面。
    const mine = ++seq;
    destroyView();
    // 从录像 / 复仇回来时带回来的落点（取走即清）。⚠ 它优先于传进来的 tab / page：
    const spot = (pending && Date.now() - (Number(pending.at) || 0) < PENDING_MS) ? pending : null;
    pending = null;
    const key = tabKeyOf(spot && spot.tab ? spot.tab : tab);
    const wantPage = Math.max(1, Math.round(Number(spot && spot.page != null ? spot.page : page) || 1));
    openTrace = 'destroyed mine=' + mine;
    await SfRender.loadExtra('tags-message.json');
    if (mine !== seq || host.isConnected === false) { openTrace = 'stale mine=' + mine; return false; }

    const view = await SfRender.mountSymbol(host, '7819', {
      frame: 1, label: '消息',
      blank: ['text1', 'text2', 'text11', 'text22', 'page'],
    });
    if (mine !== seq || host.isConnected === false) {
      try { view.destroy(); } catch (e) {}
      openTrace = 'stale-after-mount mine=' + mine;
      return false;
    }
    openTrace = 'mounted';
    const all = (window.State && State.battleHistory) ? (State.battleHistory() || []) : [];
    current = { view: view, host: host, tab: key, page: wantPage, pages: 1, all: all, localAll: all, list: [], rows: [], fresh: freshDots(all),
      mode: 'normal', requests: [], requestCount: 0, qualifyLoading: false, qualifyBusy: false };

    try { if (window.Main && Main.resizeLayout) Main.resizeLayout(); } catch (e) {}

    t.freezeDescendants(view);
    // 看过就把「消息」红点熄掉（原版每个 show*Msg 都把服务端的 hasNew* 置 false）。
    try { if (window.SfUiMain.markMessagesSeen) SfUiMain.markMessagesSeen(); } catch (e) {}
    try { wireChrome(); } catch (e) { pushErr('SfMessage wire', e); }
    try { paint(); } catch (e) { pushErr('SfMessage paint', e); }
    if (key === 'chat' && window.__SSDZ_ONLINE__) void loadBoard(current);
    if (window.__SSDZ_ONLINE__) void refreshBoardNotice(current);

    if (window.__SSDZ_ONLINE__) void loadQualify(current);
    openTrace = 'done';
    return true;
  }


  function destroyView() {
    if (current && window.SfChallenge && SfChallenge.closeOriginalDialog) SfChallenge.closeOriginalDialog(current.host);
    if (current && current.view) { try { current.view.destroy(); } catch (e) {} }
    current = null;
  }

  function destroy() {
    seq++; pending = null; destroyView();
    if (window.SfRender && SfRender.releaseExtra) SfRender.releaseExtra('tags-message.json');
  }

  window.SfMessage = Object.freeze({
    open: open,
    destroy: destroy,
    view: () => (current ? current.view : null),
    current: () => (current
      ? { tab: current.tab, tabNum: TAB_NUM[current.tab] || 1, page: current.page, pages: current.pages || 1 }
      : null),

    trace: () => openTrace,
    // 快照（调试 / 回归探针）：这一刻四个 tab 里画的是哪两条、各元件停在哪一档。
    debug: () => {
      if (!current) return null;
      const c = current;
      return {
        tab: c.tab, tabNum: TAB_NUM[c.tab] || 1, page: c.page, pages: c.pages,
        total: c.all.length, filtered: (c.list || []).length,
        rows: (c.rows || []).map((r) => Object.assign({}, r)),
      };
    },
  });
})();
