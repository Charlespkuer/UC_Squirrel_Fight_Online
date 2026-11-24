// online-social.js — 联机天梯对手 / 好友 / 论坛
(function () {
  'use strict';
  const U = window.OnlineUI;
  if (!U || !U._) return;
  const { O, esc, toast, C, uiRoot, confirmBox, showLogin } = U._;

  function identity(item) {
    const it = item || {}, bot = it.source === 'bot' || it.bot === true || it.isAI === true || it.dummy === true;
    const player = !bot && (it.source === 'player' || it.player === true || Number(it.accountId || it.remoteId) > 0);

    return { bot, player, label: bot ? 'AI' : player ? '玩家' : '?',
      detail: bot ? (it.kind === 'friend' ? 'AI 好友：免费切磋，不结算奖励。'
        : it.practice ? 'AI 陪练：免费，不计排名、次数与奖励。'
          : '赛区人机：按天梯规则结算积分、次数与奖励；本段位全部人机和所有真人一起按积分差权重抽取，最近打过的真人不会进池。') :
        player ? '玩家战斗快照，异步挑战，不代表此刻在线。' : '对手来源尚未确认。' };
  }
  async function roster(kind) {
    const data = kind === 'friends' ? await O.get('/api/friends') : await O.battle.opponents({ kind: kind || 'rank' });
    const entries = kind === 'friends' ? data.friends || [] : data.opponents || [];
    // 服务端已经把战斗体塞在列表里了（原版 `randomfriends.do` 也是这么做的）：
    // 一页最多 3 个对手（天梯现在只抽 1 个）= 1 次请求。只有老服务端/超出预算的好友才回落到 `/api/fighter`。
    // 师徒行的装备/属性/武技在服务端是当前快照，存档里的 `master` / `prentices` 只是拜师/收徒
    // 当时的镜像；好友页把师徒行也画在同一份名单里，所以这里一并取最新的。
    const kinRequest = kind === 'friends' ? O.get('/api/apprentice').catch(() => null) : null;
    const opponents = await Promise.all(entries.map(async entry => {
      const isBot = entry && (entry.source === 'bot' || entry.bot === true);
      const row = Object.assign({}, entry, kind === 'friends' ? { source: isBot ? 'bot' : 'player', player: !isBot, kind: 'friend', friend: true } : {});
      const embedded = entry && entry.fighter;
      if (embedded && typeof embedded === 'object') {
        return Object.assign({}, embedded, row, { hp: embedded.maxHp || embedded.hp });
      }
      if (!row.snapshotId) return Object.assign(row, { previewUnavailable: true });
      try {
        const info = await O.get('/api/fighter?snapshotId=' + encodeURIComponent(row.snapshotId));
        return Object.assign({}, info.fighter, row, { hp: info.fighter.maxHp || info.fighter.hp });
      } catch (e) { return Object.assign(row, { previewUnavailable: true }); }
    }));
    const out = Object.assign({}, data, { opponents });
    if (kinRequest) {
      const kin = await kinRequest;
      if (kin && kin.ok) out.kin = kin;
    }
    return out;
  }

  async function friendRequests() {
    return await O.get('/api/friends/requests');
  }

  async function respondFriendRequest(id, accept) {
    const out = await O.post('/api/friends/requests/' + encodeURIComponent(String(id)), { accept: !!accept });

    try { if (O.refreshBadge) void O.refreshBadge(); } catch (e) {}
    return out;
  }
  function addFriendPage(player, done) {
    if (player && !identity(player).player) { toast('AI对手不能添加为玩家好友。'); return; }
    const c = C(); if (!c || !c.modal) return;
    let busy = false;
    const requestKey = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const m = c.modal('添加好友', '<p>输入玩家昵称或玩家 ID，也可随机添加 AI 好友（最多 10 位）。</p><input class="online-player-input" data-player-name aria-label="玩家昵称或玩家 ID" value="' + esc(player && (player.display || player.name) || '') + '" placeholder="玩家昵称或玩家 ID">',
      [{ label: '添加好友', close: false, run: async () => {
        if (busy) return;
        const input = m.element.querySelector('[data-player-name]'), target = input.value.trim();
        if (!target) { toast('请输入玩家昵称或玩家 ID。'); return; }
        busy = true;
        try {
          const out = await O.post('/api/friends', player && player.accountId ? { accountId: player.accountId } : { target });

          const accepted = !!(out && (out.accepted || out.already));
          if (accepted) await O.syncState();
          toast(out && out.accepted ? '已成功添加好友。' : out && out.already ? '你们已经是好友。'
            : '已发送好友申请！在其验证通过后双方即自动成为好友。');
          if (m.element.isConnected) { m.close(); if (accepted && done) done(); }
        }
        catch (e) { toast(O.errText(e)); } finally { busy = false; }
      } }, { label: '随机添加 AI', close: false, run: async () => {
        if (busy) return; busy = true;
        try { const out = await O.post('/api/friends/ai', { requestKey }); if (m.element.isConnected) { toast('已添加 AI 好友【' + out.friend.fighter.name + '】。'); m.close(); if (done) done(); } }
        catch (e) { if (m.element.isConnected) toast(O.errText(e)); } finally { busy = false; }
      } }, { label: '返回', cls: 'muted' }], { small: true });
  }
  // 天梯开打：服务端把本段位全部人机和真人按积分差权重洗成一个池，取第一签。
  // 第一签就是加权抽签结果，不能再在候选里均匀随机，否则最终对手概率会被摊平。
  // 「战斗准备中」要显示双方名次：真人对手的 rank 在候选行里，自己的 myRank 在响应顶层。
  async function autoMatch() {
    let data;
    try { data = await roster('rank'); } catch (e) { toast(O.errText(e)); return null; }
    const list = data.opponents || [];
    if (!list.length) { toast('现在没有可挑战的对手，过一会儿再来。'); return null; }
    return Object.assign({}, list[0], { myRank: Number(data.myRank) || 0, myScore: data.myScore });
  }

  function accountDialog(remove) {
    const c = C(); if (!c) return;
    if (!remove) {
      const m = c.modal('退出登录', '<p>角色进度保存在服务器，重新登录后可以继续游戏。</p>', [
        { label: '退出登录', cls: 'gold', close: false, run: async () => {
          if (m.element.dataset.busy) return;
          m.element.dataset.busy = '1';
          m.element.querySelectorAll('button').forEach(b => { b.disabled = true; });
          try { await OnlineUI.logout(); } catch (e) { showLogin('login'); }
        } }, { label: '返回', cls: 'muted' },
      ], { small: true });
      return;
    }
    const account = Net.account() || {};
    c.modal('注销账号', '<p>将永久删除 <b>' + esc(account.name || State.state().name) + '</b> 的账号、角色进度及好友关系。</p>' +
      '<p>此操作无法撤销。若只是换账号，请使用「退出登录」。</p>' +
      '<p class="small-label">同一网络每天的注销次数有限，超出需等次日 0 点；设置页「本设备已创建账号」里会显示今日用量。</p>', [
      { label: '继续注销', cls: 'gold', run: () => {
        const m = c.modal('确认永久注销', '<form class="online-account-form"><label>输入当前账号密码<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label>' +
          '<p class="online-account-error" role="alert"></p></form>', [
          { label: '永久注销', cls: 'gold', close: false, run: submit }, { label: '返回', cls: 'muted' },
        ], { small: true });
        async function submit() {
          if (m.element.dataset.busy) return;
          const input = m.element.querySelector('input'), note = m.element.querySelector('[role="alert"]');
          if (!input.value) { note.textContent = '请输入当前账号的密码。'; input.focus(); return; }
          m.element.dataset.busy = '1';
          m.element.querySelectorAll('button').forEach(b => { b.disabled = true; });
          note.textContent = '正在注销…';
          try {
            await O.deleteAccount(input.value);
            input.value = ''; m.close(); showLogin('login'); toast('账号已注销。');
          } catch (e) {
            if (m.element.isConnected) note.textContent = O.errText(e);
          } finally {
            delete m.element.dataset.busy;
            m.element.querySelectorAll('button').forEach(b => { b.disabled = false; });
          }
        }
        m.element.querySelector('form').onsubmit = e => { e.preventDefault(); void submit(); };
        m.element.querySelector('input').focus();
      } }, { label: '保留账号', cls: 'muted' },
    ], { small: true });
  }


  function forum() {
    const c = C();
    if (!c || !c.modal || !O.ready) return;
    const token = Net.token(), accountId = Number((Net.account() || {}).accountId);
    const modal = c.modal('松鼠论坛', '<div class="online-forum" aria-live="polite"></div>', [], { small: false });
    if (modal.element && modal.element.classList) modal.element.classList.add('forum-dialog');
    const panel = modal.element.querySelector('.online-forum');
    const active = () => modal.element.isConnected && O.ready && Net.token() === token;
    const key = () => window.crypto && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    const stamp = t => { const d = new Date(Number(t)); return Number.isFinite(d.getTime()) ? d.toLocaleString() : ''; };
    const badge = a => a && a.role ? '<span class="online-forum-badge" title="论坛管理员">管理员</span>' : '';
    const who = a => esc(a && a.name || '玩家') + badge(a);
    const sizeText = bytes => {
      const n = Math.max(0, Number(bytes) || 0);
      if (n < 1024) return n + ' B';
      if (n < 1048576) return Math.round(n / 1024) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    };
    let view = 'list', listPage = 1, threadId = 0, replyPage = 1, request = 0, busy = false, requestKey = key();
    let search = { q: '', no: '' };
    const account = Net.account() || {};
    let forumMe = { admin: !!account.forumAdmin, role: account.forumRole || '', postsToday: 0, repliesToday: 0, postLimit: 20, replyLimit: 100 };
    let capacity = null;

    function quotaText() {
      const f = (used, limit) => (Number(limit) > 0 ? used + '/' + limit : used + '/不限');
      return '今日发帖 ' + f(forumMe.postsToday || 0, forumMe.postLimit) + ' · 回复 ' + f(forumMe.repliesToday || 0, forumMe.replyLimit);
    }
    function capPercent(cap) { return Math.min(100, Math.max(0, Number(cap && cap.percent) || 0)); }
    function capLabel(cap) { return cap.level === 'full' ? '已满' : cap.level === 'warn' ? '偏高' : '充足'; }
    function capacityChip() {
      if (!capacity) return '';
      const pct = capPercent(capacity);
      return '<span class="online-forum-cap-mini ' + capacity.level + '" title="帖子 ' + capacity.posts + '/' + capacity.maxPosts +
        '，回复 ' + capacity.replies + '/' + capacity.maxReplies + '">容量 <b>' + pct.toFixed(1) + '%</b>' +
        '<span class="online-forum-cap-bar"><i class="' + capacity.level + '" style="width:' + pct + '%"></i></span></span>';
    }
    function capacityPanel(cap) {
      if (!cap) return '';
      const pct = capPercent(cap);
      return '<section class="online-forum-cap-panel ' + cap.level + '">' +
        '<div class="online-forum-cap-title"><b>论坛容量</b><span>' + capLabel(cap) + ' · ' + pct.toFixed(1) + '%</span></div>' +
        '<div class="online-forum-cap-bar big"><i class="' + cap.level + '" style="width:' + pct + '%"></i></div>' +
        '<p>帖子 <b>' + cap.posts + '</b> / ' + cap.maxPosts + '（' + Number(cap.postPercent).toFixed(1) + '%） · 回复 <b>' + cap.replies + '</b> / ' + cap.maxReplies + '（' + Number(cap.replyPercent).toFixed(1) + '%） · 单帖回复上限 ' + cap.maxRepliesPerPost + '</p>' +
        '<p>正文约 ' + sizeText(cap.contentBytes) + '，估算占用 ' + sizeText(cap.estimatedBytes) + '，数据库 ' + sizeText(cap.dbBytes) + '。告警线 ' + cap.warnPercent + '%；到 100% 会暂停新帖和新回复。</p>' +
        '<p class="online-forum-hint">' + (cap.retentionDays > 0 ? '自动保留期：' + cap.retentionDays + ' 天。' : '自动清理：关闭，可在下方手动清理旧帖。') + '</p></section>';
    }
    function searchHtml() {
      return '<form class="online-forum-search" data-forum-form="search">' +
        '<label class="online-forum-search-q"><span>关键词</span><input name="q" maxlength="50" value="' + esc(search.q) + '" placeholder="标题 / 正文 / 作者"></label>' +
        '<label class="online-forum-search-no"><span>帖子编号</span><input name="no" inputmode="numeric" maxlength="15" value="' + esc(search.no) + '" placeholder="如 12"></label>' +
        '<button type="submit" class="uc-button gold">查找</button>' +
        (search.q || search.no ? '<button type="button" class="uc-button" data-forum="clear-search">清除</button>' : '') +
        '</form>';
    }
    function toolsHtml(opts) {
      opts = opts || {};
      const full = capacity && capacity.level === 'full';
      let html = '<div class="online-forum-tools">';
      if (opts.newPost) html += '<button class="uc-button gold" data-forum="new"' + (full ? ' disabled title="论坛容量已满，请联系管理员清理"' : '') + '>发布帖子</button>';
      if (opts.admin) html += '<button class="uc-button" data-forum="admin">管理</button>';
      if (opts.back) html += '<button class="uc-button" data-forum="list">返回列表</button>';
      if (opts.cancel) html += '<button class="uc-button" data-forum="cancel">返回</button>';
      if (opts.reply) html += '<button class="uc-button gold" data-forum="compose-reply"' + (full ? ' disabled title="论坛容量已满"' : '') + '>回复</button>';
      if (opts.deletePost) html += '<button class="uc-button" data-forum="delete-post">删除帖子</button>';
      if (opts.refresh) html += '<button class="uc-button" data-forum="refresh">刷新</button>';
      html += '<button class="uc-button muted" data-forum="close">返回消息</button>';
      html += '<span class="online-forum-quota">' + quotaText() + '</span></div>';
      return html;
    }
    function pager(page, pages) {
      if (Number(pages) <= 1) return '<div class="online-forum-pager"><span>' + page + ' / ' + pages + '</span></div>';
      return '<div class="online-forum-pager"><button class="uc-button gold" data-forum="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button><span>' + page + ' / ' + pages + '</span><button class="uc-button gold" data-forum="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button></div>';
    }
    function loading(text) { panel.innerHTML = '<div class="online-forum-loading">' + esc(text) + '</div>'; }
    function noteOf(form) { return form && form.querySelector ? form.querySelector('[role="alert"]') : null; }
    function setNote(form, text) { const el = noteOf(form); if (el) el.textContent = text || ''; }
    function setFormBusy(form, on) {
      if (!form) return;
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = !!on;
    }
    function syncAccountRole() {
      if (window.Net && Net.setAccount) Net.setAccount(Object.assign({}, Net.account() || {}, { forumAdmin: !!forumMe.admin, forumRole: forumMe.role || '' }));
    }

    async function loadList(page) {
      view = 'list'; const n = ++request;
      loading('正在读取论坛…');
      let query = '/api/forum/posts?page=' + encodeURIComponent(page);
      if (search.q) query += '&q=' + encodeURIComponent(search.q);
      if (search.no) query += '&no=' + encodeURIComponent(search.no);
      try {
        const data = await O.get(query);
        if (!active() || n !== request) return;
        listPage = data.page; forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        if (data.search) search = { q: String(data.search.q || ''), no: data.search.no ? String(data.search.no) : '' };
        const title = data.search && (data.search.q || data.search.no)
          ? '搜索到 ' + data.total + ' 篇帖子' + (data.search.no ? '（编号 #' + data.search.no + '）' : '')
          : '共 ' + data.total + ' 篇帖子';
        const rows = data.posts.length ? '<div class="online-forum-list">' + data.posts.map(p =>
          '<button class="online-forum-row" data-forum="open" data-id="' + p.id + '">' +
          '<span class="online-forum-no" title="帖子编号 ' + p.id + '">#' + p.id + '</span>' +
          '<b title="' + esc(p.title) + '">' + esc(p.title) + '</b>' +
          '<span class="online-forum-row-meta">' + who(p.author) + ' · ' + esc(stamp(p.updatedAt)) + ' · ' + p.replies + ' 回复</span>' +
          '</button>').join('') + '</div>'
          : '<p class="online-forum-empty">' + (data.search && (data.search.q || data.search.no) ? '没有找到匹配的帖子。' : '还没有帖子，来发布第一篇吧。') + '</p>';
        panel.innerHTML = '<div class="online-forum-head"><div class="online-forum-search-row">' + searchHtml() + '</div>' +
          toolsHtml({ newPost: true, admin: !!forumMe.admin }) + '</div>' +
          '<div class="online-forum-scroll"><div class="online-forum-summary">' + title + '</div>' + rows + '</div>' +
          pager(data.page, data.pages);
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ refresh: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    async function loadThread(id, page) {
      view = 'thread'; threadId = id; const n = ++request;
      loading('正在读取帖子…');
      try {
        const data = await O.get('/api/forum/posts/' + encodeURIComponent(id) + '?page=' + encodeURIComponent(page));
        if (!active() || n !== request) return;
        replyPage = data.page; forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        const p = data.post, own = p.author.accountId === accountId, admin = !!forumMe.admin;
        const canDeletePost = own || admin;
        const replies = data.replies.length ? data.replies.map(r => {
          const canDelete = r.author.accountId === accountId || admin;
          return '<article class="online-forum-reply"><div class="online-forum-reply-head">' +
            '<span class="online-forum-no" title="回复编号 ' + r.id + '">回复 #' + r.id + '</span>' +
            '<span class="online-forum-meta">' + who(r.author) + ' · ' + esc(stamp(r.createdAt)) + '</span>' +
            (canDelete ? '<button type="button" class="online-forum-delete" data-forum="delete-reply" data-id="' + r.id + '">删除</button>' : '') +
            '</div><div class="online-forum-content">' + esc(r.body) + '</div></article>';
        }).join('') : '<p class="online-forum-empty">暂无回复。</p>';
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true, reply: true, deletePost: canDeletePost, admin: admin }) + '</div>' +
          '<div class="online-forum-scroll">' +
          '<article class="online-forum-post"><div class="online-forum-post-head">' +
          '<span class="online-forum-no" title="帖子编号 ' + p.id + '">帖子 #' + p.id + '</span><h3>' + esc(p.title) + '</h3></div>' +
          '<div class="online-forum-meta">' + who(p.author) + ' · ' + esc(stamp(p.createdAt)) + '</div>' +
          '<div class="online-forum-content">' + esc(p.body) + '</div></article>' +
          '<div class="online-forum-replies">' + replies + '</div></div>' +
          pager(data.page, data.pages);
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    function editor(reply) {
      ++request; view = reply ? 'reply' : 'new'; requestKey = key();
      panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ cancel: true }) + '</div>' +
        '<div class="online-forum-scroll"><h3 class="online-forum-editor-title">' + (reply ? '回复帖子 #' + threadId : '发布新帖') + '</h3>' +
        '<form class="online-forum-form" data-forum-form="editor">' +
        (reply ? '' : '<label>标题<input name="title" maxlength="80" required placeholder="帖子标题"></label>') +
        '<label>' + (reply ? '回复内容' : '帖子正文') + '<textarea name="body" maxlength="' + (reply ? 1000 : 2000) + '" required placeholder="写下你的内容"></textarea></label>' +
        '<p class="online-forum-hint">发布前会自动检查违禁词；' + quotaText() + '。</p>' +
        '<p class="online-forum-error" role="alert"></p>' +
        '<div class="online-forum-form-actions"><button type="submit" class="uc-button gold">' + (reply ? '发送回复' : '发布') + '</button></div></form></div>';
      const input = panel.querySelector('textarea');
      if (input) input.focus();
    }

    function actionLabel(action) {
      return ({
        'forum.post.delete': '删除帖子', 'forum.reply.delete': '删除回复',
        'forum.word.add': '添加违禁词', 'forum.word.remove': '删除违禁词',
        'forum.admin.grant': '授予管理员', 'forum.admin.revoke': '撤销管理员',
        'forum.prune': '清理旧帖',
      })[action] || action;
    }
    function adminBody(data) {
      const words = data.words || [], admins = data.admins || [], latest = data.latestPosts || [], recent = data.recent || [];
      const wordHtml = words.length ? words.map(w =>
        '<span class="online-forum-word"><b>' + esc(w.word) + '</b><small>' + esc(w.category) + '</small>' +
        '<button type="button" class="online-forum-word-del" data-forum="word-del" data-word="' + esc(w.word) + '" title="删除这个违禁词">×</button></span>').join('')
        : '<span class="online-forum-hint">还没有违禁词。</span>';
      const adminHtml = admins.length ? admins.map(a =>
        '<div class="online-forum-admin-row"><span class="online-forum-admin-name">' + esc(a.name) +
        ' <small>玩家编号 ' + (a.playerId || '—') + '</small></span>' +
        (admins.length > 1 ? '<button type="button" class="online-forum-delete" data-forum="admin-del" data-id="' + a.accountId + '" data-name="' + esc(a.name) + '">撤销</button>' : '<span class="online-forum-hint">至少保留一位</span>') +
        '</div>').join('') : '';
      const postHtml = latest.length ? latest.map(p =>
        '<div class="online-forum-admin-row"><button type="button" class="online-forum-link" data-forum="open" data-id="' + p.id + '">#' + p.id + ' ' + esc(p.title) + '</button>' +
        '<span class="online-forum-meta">' + who(p.author) + ' · ' + p.replies + ' 回复</span>' +
        '<button type="button" class="online-forum-delete" data-forum="admin-post-del" data-id="' + p.id + '">删除</button></div>').join('')
        : '<p class="online-forum-hint">还没有帖子。</p>';
      const recentHtml = recent.length ? recent.map(x =>
        '<li><span class="online-forum-log-time">' + esc(stamp(x.createdAt)) + '</span>' +
        '<b>' + esc(x.actor && x.actor.name || '未知') + '</b> ' + esc(actionLabel(x.action)) +
        (x.detail ? '：' + esc(x.detail) : '') + '</li>').join('') : '<li class="online-forum-hint">暂无管理操作。</li>';
      return capacityPanel(data.capacity) +
        '<section class="online-forum-admin-section"><h3>违禁词 <small>' + words.length + ' 条</small></h3>' +
        '<p class="online-forum-hint">命中任意词会拒绝发帖/回复；匹配时忽略空格、标点、全半角和零宽字符。</p>' +
        '<div class="online-forum-words">' + wordHtml + '</div>' +
        '<form class="online-forum-admin-form" data-forum-form="word"><input name="word" maxlength="32" placeholder="新增违禁词">' +
        '<select name="category"><option>辱骂</option><option>广告</option><option>其他</option></select>' +
        '<button type="submit" class="uc-button gold">添加</button><p class="online-forum-error" role="alert"></p></form></section>' +
        '<section class="online-forum-admin-section"><h3>管理员 <small>' + admins.length + ' 位</small></h3>' +
        '<div class="online-forum-admins">' + adminHtml + '</div>' +
        '<form class="online-forum-admin-form" data-forum-form="admin"><input name="account" maxlength="32" placeholder="玩家编号或昵称">' +
        '<button type="submit" class="uc-button gold">授予管理员</button><p class="online-forum-error" role="alert"></p></form>' +
        '<p class="online-forum-hint">管理员可以删除任意帖子/回复、管理违禁词和清理旧帖；所有操作都会留痕。</p></section>' +
        '<section class="online-forum-admin-section"><h3>帖子管理 <small>最新 20 篇</small></h3>' +
        '<div class="online-forum-admin-posts">' + postHtml + '</div>' +
        '<p class="online-forum-hint">在论坛列表的搜索框里按关键词或帖子编号找到目标，再打开帖子删除。</p></section>' +
        '<section class="online-forum-admin-section"><h3>清理旧帖</h3>' +
        '<form class="online-forum-admin-form" data-forum-form="prune"><label>删除创建时间早于 <input name="days" type="number" min="7" max="3650" value="180"> 天的帖子</label>' +
        '<button type="submit" class="uc-button">清理旧帖</button><p class="online-forum-error" role="alert"></p></form>' +
        '<p class="online-forum-hint">回复会随帖子一起删除，操作不可撤销；日常自动清理默认关闭。</p></section>' +
        '<section class="online-forum-admin-section"><h3>最近管理操作</h3><ul class="online-forum-admin-log">' + recentHtml + '</ul></section>';
    }

    async function loadAdmin() {
      view = 'admin'; const n = ++request;
      loading('正在读取管理数据…');
      try {
        const data = await O.get('/api/forum/admin/overview');
        if (!active() || n !== request) return;
        forumMe = data.me || forumMe; capacity = data.capacity || capacity;
        syncAccountRole();
        panel.innerHTML = '<div class="online-forum-head"><div class="online-forum-admin-head"><b>论坛管理</b>' + capacityChip() + '</div>' +
          toolsHtml({ back: true, refresh: true }) + '</div>' +
          '<div class="online-forum-scroll">' + adminBody(data) + '</div>';
      } catch (e) {
        if (!active() || n !== request) return;
        panel.innerHTML = '<div class="online-forum-head">' + toolsHtml({ back: true }) + '</div>' +
          '<div class="online-forum-scroll"><p class="online-forum-error">读取管理数据失败：' + esc(O.errText(e)) + '</p></div>';
      }
    }

    function confirmDelete(type, id, adminSurface) {
      const isPost = type === 'post', label = isPost ? '删除帖子 #' + id : '删除回复 #' + id;
      const extra = isPost ? '帖子下的全部回复也会一起删除。' : '';
      const audit = adminSurface ? '管理员删除会写入管理日志。' : '';
      c.modal(label, '<p>确定删除吗？' + extra + audit + '</p>', [
        { label: '取消', cls: 'muted' }, { label: '删除', cls: 'gold', run: async () => {
          try {
            await O.del('/api/forum/' + (isPost ? 'posts/' : 'replies/') + encodeURIComponent(id));
            if (!active()) return;
            toast(isPost ? '帖子已删除。' : '回复已删除。');
            if (adminSurface) await loadAdmin();
            else if (isPost) await loadList(listPage);
            else await loadThread(threadId, replyPage);
          } catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmWord(word) {
      c.modal('删除违禁词', '<p>删除「' + esc(word) + '」后，包含它的内容可以再次发布。</p>', [
        { label: '取消', cls: 'muted' }, { label: '删除', cls: 'gold', run: async () => {
          try { await O.post('/api/forum/admin/words/delete', { word }); if (active()) { toast('违禁词已删除。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmRevoke(admin) {
      c.modal('撤销管理员', '<p>撤销 <b>' + esc(admin.name) + '</b> 的论坛管理员权限？</p>', [
        { label: '取消', cls: 'muted' }, { label: '撤销', cls: 'gold', run: async () => {
          try { await O.post('/api/forum/admin/admins/delete', { accountId: Number(admin.accountId) }); if (active()) { toast('管理员已撤销。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }
    function confirmPrune(days) {
      c.modal('清理旧帖', '<p>将删除创建时间早于 <b>' + days + '</b> 天的帖子及其全部回复，无法恢复。</p>', [
        { label: '取消', cls: 'muted' }, { label: '确认清理', cls: 'gold', run: async () => {
          try { const out = await O.post('/api/forum/admin/prune', { days }); if (active()) { toast('已清理 ' + out.posts + ' 篇旧帖。'); await loadAdmin(); } }
          catch (e) { if (active()) toast(O.errText(e)); }
        } },
      ], { small: true });
    }

    panel.addEventListener('submit', async ev => {
      const form = ev.target.closest('form[data-forum-form]');
      if (!form || !panel.contains(form)) return;
      ev.preventDefault();
      const kind = form.dataset.forumForm;
      if (kind === 'search') {
        const q = String(form.elements.q.value || '').trim(), no = String(form.elements.no.value || '').trim();
        if (no && !/^\d+$/.test(no)) { setNote(form, '帖子编号只能是数字。'); return; }
        search = { q: q.slice(0, 50), no };
        await loadList(1);
        return;
      }
      if (busy) return;
      if (kind === 'editor') {
        const reply = view === 'reply';
        const title = reply ? '' : String(form.elements.title.value || '').trim();
        const body = String(form.elements.body.value || '').trim();
        if ((!reply && !title) || !body) { setNote(form, '请填写完整内容。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在发布…');
        try {
          const result = await O.post(reply ? '/api/forum/posts/' + encodeURIComponent(threadId) + '/replies' : '/api/forum/posts',
            reply ? { body, requestKey } : { title, body, requestKey });
          if (!active()) return;
          if (result.quota) Object.assign(forumMe, result.quota);
          if (result.capacity) capacity = result.capacity;
          toast(reply ? '回复已发布。' : '帖子已发布。');
          if (reply) await loadThread(threadId, 100000);
          else await loadThread(result.post.id, 1);
        } catch (e) {
          if (active() && form.isConnected) setNote(form, O.errText(e));
        } finally {
          busy = false;
          if (form.isConnected) setFormBusy(form, false);
        }
        return;
      }
      if (kind === 'word') {
        const word = String(form.elements.word.value || '').trim();
        if (!word) { setNote(form, '请填写违禁词。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在添加…');
        try {
          await O.post('/api/forum/admin/words', { word, category: String(form.elements.category.value || '其他') });
          if (active()) { toast('违禁词已添加。'); await loadAdmin(); }
        } catch (e) { if (active() && form.isConnected) setNote(form, O.errText(e)); }
        finally { busy = false; if (form.isConnected) setFormBusy(form, false); }
        return;
      }
      if (kind === 'admin') {
        const accountKey = String(form.elements.account.value || '').trim();
        if (!accountKey) { setNote(form, '请填写玩家编号或昵称。'); return; }
        busy = true; setFormBusy(form, true); setNote(form, '正在授予…');
        try {
          const out = await O.post('/api/forum/admin/admins', { account: accountKey });
          if (active()) { toast('已授予 ' + (out.account && out.account.name || accountKey) + ' 管理员。'); await loadAdmin(); }
        } catch (e) { if (active() && form.isConnected) setNote(form, O.errText(e)); }
        finally { busy = false; if (form.isConnected) setFormBusy(form, false); }
        return;
      }
      if (kind === 'prune') {
        const days = Number(form.elements.days.value);
        if (!Number.isFinite(days) || days < 7 || days > 3650) { setNote(form, '天数须为 7 至 3650。'); return; }
        confirmPrune(Math.floor(days));
      }
    });

    panel.addEventListener('click', ev => {
      const b = ev.target.closest('[data-forum]');
      if (!b || b.disabled || !panel.contains(b)) return;
      const action = b.dataset.forum;
      if (action === 'close') { modal.close(); return; }
      if (action === 'new') editor(false);
      else if (action === 'compose-reply') editor(true);
      else if (action === 'cancel') { if (view === 'reply') void loadThread(threadId, replyPage); else void loadList(listPage); }
      else if (action === 'list') void loadList(listPage);
      else if (action === 'open') void loadThread(Number(b.dataset.id), 1);
      else if (action === 'prev' || action === 'next') {
        const delta = action === 'prev' ? -1 : 1;
        if (view === 'list') void loadList(listPage + delta);
        else if (view === 'thread') void loadThread(threadId, replyPage + delta);
      } else if (action === 'clear-search') { search = { q: '', no: '' }; void loadList(1); }
      else if (action === 'refresh') { if (view === 'admin') void loadAdmin(); else void loadList(listPage); }
      else if (action === 'admin') void loadAdmin();
      else if (action === 'delete-post') confirmDelete('post', threadId, false);
      else if (action === 'delete-reply') confirmDelete('reply', Number(b.dataset.id), false);
      else if (action === 'admin-post-del') confirmDelete('post', Number(b.dataset.id), true);
      else if (action === 'admin-del') confirmRevoke({ accountId: Number(b.dataset.id), name: String(b.dataset.name || '该账号') });
      else if (action === 'word-del') confirmWord(String(b.dataset.word || ''));
    });

    void loadList(1);
    return modal;
  }

  // 设置页「修改密码」：当前密码 + 新密码 + 确认。
  // 服务端换 salt/hash 并撤销其它设备会话，当前 Bearer 继续有效。

  U.identity = identity;
  U.roster = roster;
  U.friendRequests = friendRequests;
  U.respondFriendRequest = respondFriendRequest;
  U.addFriendPage = addFriendPage;
  U.autoMatch = autoMatch;
  U.accountDialog = accountDialog;
  U.forum = forum;
})();
