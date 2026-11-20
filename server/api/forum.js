'use strict';
// server/api/forum.js — 松鼠论坛 HTTP 路由
// `server/game/forum.js`，这里只做参数校验、分页、SQL 与响应。
// 公开给登录玩家的接口：

const db = require('../db');
const auth = require('../auth');
const forum = require('../game/forum');
const { config } = require('../config');
const { fail, rateLimit } = require('../http');

const REPLIES_PER_PAGE = 20;

function pageSize() {
  return Math.max(5, Math.min(50, Number(config.forumPageSize) || 15));
}
function idOf(value) {
  const text = String(value == null ? '' : value);
  if (!/^[1-9]\d{0,14}$/.test(text) || !Number.isSafeInteger(Number(text))) throw fail('BAD_REQUEST', '无效的帖子编号');
  return Number(text);
}
function pageOf(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100000) : 1; }
function content(value, limit, label) {
  if (typeof value !== 'string') throw fail('BAD_REQUEST', label + '不能为空');
  const text = value.trim();
  if (!text || Array.from(text).length > limit) throw fail('BAD_REQUEST', label + '须为 1 至 ' + limit + ' 字');
  return text;
}
function keyOf(value) {
  const key = String(value || '');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw fail('BAD_REQUEST', '请求标识无效，请重新打开编辑器');
  return key;
}
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function searchOf(query) {
  const q = String((query && query.q) || '').trim();
  if (Array.from(q).length > 50) throw fail('BAD_REQUEST', '搜索关键词最多 50 字');
  const rawNo = String((query && query.no) || '').trim();
  const no = rawNo ? idOf(rawNo) : 0;
  const where = [];
  const params = [];
  if (no) {
    where.push('p.id = ?');
    params.push(no);
  } else if (q) {
    const like = '%' + escapeLike(q) + '%';
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  return { q, no, where: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}
function authorOf(row) {
  const role = String(row.author_role || '');
  return { accountId: Number(row.author_id), name: row.name, tag: row.tag, role, admin: !!role };
}
function postRow(row) {
  return {
    id: Number(row.id), title: row.title, body: row.body,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    author: authorOf(row), replies: Number(row.reply_count || 0),
  };
}
function replyRow(row) {
  return {
    id: Number(row.id), postId: Number(row.post_id), body: row.body,
    createdAt: Number(row.created_at), author: authorOf(row),
  };
}
function meOf(account) {
  const id = Number(account.id), role = forum.roleOf(id);
  return Object.assign({ admin: !!role, role }, forum.quota(id));
}
function requireAdmin(ctx) {
  const id = Number(ctx.account.id);
  if (!forum.isAdmin(id)) throw fail('FORBIDDEN', '需要论坛管理员权限');
  return id;
}

const POST_SELECT = `SELECT p.*, a.name, a.tag, fa.role AS author_role,
    (SELECT COUNT(*) FROM forum_replies r WHERE r.post_id=p.id) AS reply_count
  FROM forum_posts p JOIN accounts a ON a.id=p.author_id
  LEFT JOIN forum_admins fa ON fa.account_id=p.author_id`;
const REPLY_SELECT = `SELECT r.*, a.name, a.tag, fa.role AS author_role
  FROM forum_replies r JOIN accounts a ON a.id=r.author_id
  LEFT JOIN forum_admins fa ON fa.account_id=r.author_id`;

function getPost(id) { return db.get(POST_SELECT + ' WHERE p.id=?', id); }
function getReply(id) { return db.get(REPLY_SELECT + ' WHERE r.id=?', id); }

module.exports = {
  list(ctx) {
    forum.bootstrap();
    const size = pageSize();
    const search = searchOf(ctx.query);
    const total = Number(db.get('SELECT COUNT(*) AS n FROM forum_posts p JOIN accounts a ON a.id=p.author_id' + search.where,
      ...search.params).n);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pageOf(ctx.query.page), pages);
    const rows = db.all(POST_SELECT + search.where + ' ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?',
      ...search.params, size, (page - 1) * size);
    return {
      ok: true, page, pages, total,
      posts: rows.map(postRow),
      search: { q: search.q, no: search.no },
      me: meOf(ctx.account),
      capacity: forum.stats(),
    };
  },

  create(ctx) {
    forum.bootstrap();
    const author = Number(ctx.account.id), key = keyOf(ctx.body.requestKey);
    const title = content(ctx.body.title, 80, '标题'), body = content(ctx.body.body, 2000, '正文');
    const old = db.get('SELECT id, title, body FROM forum_posts WHERE author_id=? AND request_key=?', author, key);
    if (old) {
      if (old.title !== title || old.body !== body) throw fail('CONFLICT', '该请求标识已用于其他内容');
      return { ok: true, post: postRow(getPost(old.id)), quota: forum.quota(author), capacity: forum.stats() };
    }
    const hits = forum.checkContent(title, body);
    if (hits.length) throw fail('BAD_REQUEST', '内容包含违禁词：' + hits.join('、'), { words: hits });
    rateLimit('forum-post:' + author, 5, 60000);
    rateLimit('forum-all-post', Number(config.forumGlobalPostsPerMin) || 60, 60000);
    forum.assertWritable('post');
    let out;
    db.tx(() => {
      const quota = forum.consumeQuota(author, 'post');
      const now = Date.now();
      const result = db.run('INSERT INTO forum_posts (author_id,request_key,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        author, key, title, body, now, now);
      out = { post: postRow(getPost(Number(result.lastInsertRowid))), quota };
    });
    forum.invalidateStats();
    return { ok: true, post: out.post, quota: out.quota, capacity: forum.stats(true) };
  },

  detail(ctx) {
    forum.bootstrap();
    const id = idOf(ctx.params.id), post = getPost(id);
    if (!post) throw fail('NOT_FOUND', '帖子不存在或已删除');
    const pages = Math.max(1, Math.ceil(Number(post.reply_count) / REPLIES_PER_PAGE));
    const page = Math.min(pageOf(ctx.query.page), pages);
    const rows = db.all(REPLY_SELECT + ' WHERE r.post_id=? ORDER BY r.id ASC LIMIT ? OFFSET ?',
      id, REPLIES_PER_PAGE, (page - 1) * REPLIES_PER_PAGE);
    return {
      ok: true, post: postRow(post), replies: rows.map(replyRow), page, pages,
      me: meOf(ctx.account), capacity: forum.stats(),
    };
  },

  reply(ctx) {
    forum.bootstrap();
    const postId = idOf(ctx.params.id), author = Number(ctx.account.id), key = keyOf(ctx.body.requestKey);
    const body = content(ctx.body.body, 1000, '回复');
    const old = db.get('SELECT id,post_id,body FROM forum_replies WHERE author_id=? AND request_key=?', author, key);
    if (old) {
      if (Number(old.post_id) !== postId || old.body !== body) throw fail('CONFLICT', '该请求标识已用于其他内容');
      return { ok: true, reply: replyRow(getReply(old.id)), quota: forum.quota(author), capacity: forum.stats() };
    }
    const hits = forum.checkContent(body);
    if (hits.length) throw fail('BAD_REQUEST', '内容包含违禁词：' + hits.join('、'), { words: hits });
    rateLimit('forum-reply:' + author, 20, 60000);
    rateLimit('forum-all-reply', Number(config.forumGlobalRepliesPerMin) || 300, 60000);
    let out;
    db.tx(() => {
      const post = getPost(postId);
      if (!post) throw fail('NOT_FOUND', '帖子不存在或已删除');
      forum.assertWritable('reply', post.reply_count);
      const quota = forum.consumeQuota(author, 'reply');
      const now = Date.now();
      const result = db.run('INSERT INTO forum_replies (post_id,author_id,request_key,body,created_at) VALUES (?,?,?,?,?)',
        postId, author, key, body, now);
      db.run('UPDATE forum_posts SET updated_at=? WHERE id=?', now, postId);
      out = { reply: replyRow(getReply(Number(result.lastInsertRowid))), quota };
    });
    forum.invalidateStats();
    return { ok: true, reply: out.reply, quota: out.quota, capacity: forum.stats(true) };
  },

  removePost(ctx) {
    const id = idOf(ctx.params.id), post = getPost(id);
    if (!post) throw fail('NOT_FOUND', '帖子不存在或已删除');
    const actor = Number(ctx.account.id), admin = forum.isAdmin(actor), mine = Number(post.author_id) === actor;
    if (!mine && !admin) throw fail('FORBIDDEN', '只能删除自己的帖子');
    db.tx(() => {
      db.run('DELETE FROM forum_posts WHERE id=?', id);
      if (admin) forum.logAdmin(actor, 'forum.post.delete', 'post', id,
        '《' + String(post.title || '').slice(0, 80) + '》作者 ' + post.name + '#' + post.author_id);
    });
    forum.invalidateStats();
    return { ok: true, admin: admin && !mine };
  },

  removeReply(ctx) {
    const id = idOf(ctx.params.id), row = getReply(id);
    if (!row) throw fail('NOT_FOUND', '回复不存在或已删除');
    const actor = Number(ctx.account.id), admin = forum.isAdmin(actor), mine = Number(row.author_id) === actor;
    if (!mine && !admin) throw fail('FORBIDDEN', '只能删除自己的回复');
    db.tx(() => {
      db.run('DELETE FROM forum_replies WHERE id=?', id);
      if (admin) forum.logAdmin(actor, 'forum.reply.delete', 'reply', id,
        '帖子 #' + row.post_id + ' 的回复，作者 ' + row.name + '#' + row.author_id);
    });
    forum.invalidateStats();
    return { ok: true, admin: admin && !mine };
  },


  overview(ctx) {
    forum.bootstrap();
    const actor = requireAdmin(ctx);
    const latest = db.all(POST_SELECT + ' ORDER BY p.id DESC LIMIT 20');
    return {
      ok: true,
      capacity: forum.stats(true),
      words: forum.wordRows(),
      admins: forum.adminRows(),
      recent: forum.recentAdminLog(12),
      latestPosts: latest.map(postRow),
      me: meOf(ctx.account),
      actor,
    };
  },

  addWord(ctx) {
    const actor = requireAdmin(ctx);
    rateLimit('forum-admin:' + actor, 30, 60000);
    const words = forum.addWord(actor, ctx.body.word, ctx.body.category, ctx.body.note);
    return { ok: true, words };
  },

  removeWord(ctx) {
    const actor = requireAdmin(ctx);
    rateLimit('forum-admin:' + actor, 30, 60000);
    const words = forum.removeWord(actor, ctx.body.word);
    return { ok: true, words };
  },

  grantAdmin(ctx) {
    const actor = requireAdmin(ctx);
    rateLimit('forum-admin:' + actor, 30, 60000);
    const key = String(ctx.body.account == null ? '' : ctx.body.account).trim();
    if (!key) throw fail('BAD_REQUEST', '请填写玩家编号或昵称');
    const target = auth.findAccountStrict(key);
    if (!target) throw fail('NOT_FOUND', '找不到这个玩家（可填玩家编号或昵称）');
    const admins = forum.grant(actor, target.id, target.name);
    return { ok: true, admins, account: { accountId: Number(target.id), name: String(target.name) } };
  },

  revokeAdmin(ctx) {
    const actor = requireAdmin(ctx);
    rateLimit('forum-admin:' + actor, 30, 60000);
    let targetId = 0;
    if (ctx.body.accountId != null) targetId = Number(ctx.body.accountId);
    else if (ctx.body.account != null) {
      const target = auth.findAccountStrict(String(ctx.body.account).trim());
      targetId = target ? Number(target.id) : 0;
    }
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw fail('BAD_REQUEST', '无效的账号');
    const admins = forum.revoke(actor, targetId);
    return { ok: true, admins };
  },

  prune(ctx) {
    const actor = requireAdmin(ctx);
    rateLimit('forum-admin:' + actor, 10, 60000);
    return Object.assign({ ok: true }, forum.prune(ctx.body.days, actor), { capacity: forum.stats(true) });
  },
};
