'use strict';

const db = require('../db');
const { config, localDate } = require('../config');
const { fail } = require('../http');

const DAY = 86400000;
const WORD_LIMIT = 1000;

const DEFAULT_WORDS = [
  ['傻逼', '辱骂'], ['傻b', '辱骂'], ['煞笔', '辱骂'], ['沙比', '辱骂'], ['脑残', '辱骂'],
  ['操你妈', '辱骂'], ['草泥马', '辱骂'], ['你妈的', '辱骂'], ['他妈的', '辱骂'], ['妈了个逼', '辱骂'],
  ['婊子', '辱骂'], ['贱人', '辱骂'], ['狗娘养', '辱骂'], ['杂种', '辱骂'], ['王八蛋', '辱骂'],
  ['死全家', '辱骂'], ['全家死光', '辱骂'], ['尼玛', '辱骂'], ['妈逼', '辱骂'],
  ['fuck', '辱骂'], ['shit', '辱骂'], ['bitch', '辱骂'],
  ['加我微信', '广告'], ['加我qq', '广告'], ['加我vx', '广告'], ['私聊我', '广告'], ['代练', '广告'],
  ['代充', '广告'], ['卖号', '广告'], ['收号', '广告'], ['刷金', '广告'], ['刷元宝', '广告'],
  ['外挂', '广告'], ['脚本辅助', '广告'], ['私服', '广告'], ['博彩', '广告'], ['赌博', '广告'],
  ['色情', '广告'], ['裸聊', '广告'], ['招嫖', '广告'], ['贷款', '广告'], ['发票', '广告'],
  ['兼职日结', '广告'], ['点击链接', '广告'],
];

let wordCache = null;
let statsCache = { at: 0, value: null };

function metaGet(key) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', String(key));
  return row ? String(row.value) : '';
}
function metaSet(key, value) {
  db.run('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key), String(value));
}

function matchKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function seedWords() {
  if (metaGet('forum.words.seeded') === '1') return;
  db.tx(() => {
    const now = Date.now();
    for (const [word, category] of DEFAULT_WORDS) {
      const key = matchKey(word);
      if (!key) continue;
      db.run('INSERT OR IGNORE INTO forum_banned_words (word,match_key,category,note,created_by,created_at) VALUES (?,?,?,?,?,?)',
        word, key, category, '默认词库', 0, now);
    }
    metaSet('forum.words.seeded', '1');
  });
  wordCache = null;
}

function seedFounder() {
  const hasAdmin = !!db.get('SELECT 1 AS x FROM forum_admins LIMIT 1');
  if (hasAdmin && metaGet('forum.founder.seeded') === '1') return;
  for (const playerId of config.forumFounderPlayerIds) {
    const row = db.get('SELECT account_id FROM player_ids WHERE player_id = ?', Number(playerId));
    if (!row) continue;
    db.run('INSERT OR IGNORE INTO forum_admins (account_id,role,created_at,created_by,note) VALUES (?,?,?,?,?)',
      Number(row.account_id), 'admin', Date.now(), 0, '创始管理员（玩家编号 ' + playerId + '）');
    metaSet('forum.founder.seeded', '1');
    return;
  }
}

function bootstrap() {
  try { seedWords(); seedFounder(); } catch (e) {
    console.warn('[forum] bootstrap failed:', e && e.message);
  }
}

function roleOf(accountId) {
  const row = db.get('SELECT role FROM forum_admins WHERE account_id = ?', Number(accountId));
  return row ? String(row.role) : '';
}
function isAdmin(accountId) { return !!roleOf(accountId); }
function adminRows() {
  return db.all(`SELECT fa.account_id,fa.role,fa.created_at,fa.note,
      a.name,a.tag,(SELECT player_id FROM player_ids p WHERE p.account_id=a.id) AS player_id
    FROM forum_admins fa JOIN accounts a ON a.id=fa.account_id
    ORDER BY fa.created_at ASC, fa.account_id ASC`).map((row) => ({
    accountId: Number(row.account_id), playerId: Number(row.player_id) || 0,
    name: String(row.name), role: String(row.role), note: String(row.note || ''),
    createdAt: Number(row.created_at),
  }));
}
function logAdmin(actorId, action, targetType, targetId, detail) {
  db.run('INSERT INTO forum_admin_log (actor_id,action,target_type,target_id,detail,created_at) VALUES (?,?,?,?,?,?)',
    Number(actorId) || 0, String(action), String(targetType || ''), String(targetId == null ? '' : targetId),
    String(detail || '').slice(0, 300), Date.now());
}
function recentAdminLog(limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  return db.all(`SELECT l.id,l.actor_id,l.action,l.target_type,l.target_id,l.detail,l.created_at,
      a.name AS actor_name,(SELECT player_id FROM player_ids p WHERE p.account_id=l.actor_id) AS actor_player_id
    FROM forum_admin_log l LEFT JOIN accounts a ON a.id=l.actor_id
    ORDER BY l.id DESC LIMIT ?`, n).map((row) => ({
    id: Number(row.id), action: String(row.action), targetType: String(row.target_type || ''),
    targetId: String(row.target_id || ''), detail: String(row.detail || ''), createdAt: Number(row.created_at),
    actor: {
      accountId: Number(row.actor_id) || 0, playerId: Number(row.actor_player_id) || 0,
      name: String(row.actor_name || '已注销账号'),
    },
  }));
}
function grant(actorId, targetId, targetName) {
  const id = Number(targetId);
  if (!id) throw fail('BAD_REQUEST', '无效的账号');
  if (roleOf(id)) throw fail('CONFLICT', '该账号已经是论坛管理员');
  db.run('INSERT INTO forum_admins (account_id,role,created_at,created_by,note) VALUES (?,?,?,?,?)',
    id, 'admin', Date.now(), Number(actorId) || 0, '');
  logAdmin(actorId, 'forum.admin.grant', 'account', id, String(targetName || ''));
  return adminRows();
}
function revoke(actorId, targetId) {
  const id = Number(targetId);
  if (!roleOf(id)) throw fail('NOT_FOUND', '该账号不是论坛管理员');
  if (Number(db.get('SELECT COUNT(*) AS n FROM forum_admins').n) <= 1) {
    throw fail('CONFLICT', '论坛至少需要保留一位管理员');
  }
  db.run('DELETE FROM forum_admins WHERE account_id = ?', id);
  logAdmin(actorId, 'forum.admin.revoke', 'account', id, '');
  return adminRows();
}

function words() {
  if (!wordCache) {
    wordCache = db.all('SELECT word,match_key,category,note,created_at FROM forum_banned_words ORDER BY category,word');
  }
  return wordCache;
}
function wordRows() {
  return words().map((row) => ({
    word: String(row.word), key: String(row.match_key), category: String(row.category || '其他'),
    note: String(row.note || ''), createdAt: Number(row.created_at),
  }));
}
// 返回命中的原始违禁词（最多 5 个，避免把整张表回给客户端）。
function checkContent(...parts) {
  const list = words();
  if (!list.length) return [];
  const hits = [];
  for (const part of parts) {
    const text = matchKey(part);
    if (!text) continue;
    for (const row of list) {
      if (text.indexOf(String(row.match_key)) !== -1 && !hits.includes(String(row.word))) {
        hits.push(String(row.word));
      }
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}
function addWord(actorId, rawWord, rawCategory, rawNote) {
  const word = String(rawWord == null ? '' : rawWord).trim();
  if (!word || Array.from(word).length > 32) throw fail('BAD_REQUEST', '违禁词须为 1 至 32 字');
  const key = matchKey(word);
  if (key.length < 2) throw fail('BAD_REQUEST', '违禁词至少要有 2 个汉字/字母/数字');
  if (Number(db.get('SELECT COUNT(*) AS n FROM forum_banned_words').n) >= WORD_LIMIT) {
    throw fail('CONFLICT', '违禁词表最多保存 ' + WORD_LIMIT + ' 条');
  }
  if (db.get('SELECT 1 AS x FROM forum_banned_words WHERE match_key = ?', key)) {
    throw fail('CONFLICT', '这个违禁词已经在名单里了');
  }
  const category = String(rawCategory == null ? '' : rawCategory).trim().slice(0, 20) || '其他';
  const note = String(rawNote == null ? '' : rawNote).trim().slice(0, 200);
  db.run('INSERT INTO forum_banned_words (word,match_key,category,note,created_by,created_at) VALUES (?,?,?,?,?,?)',
    word, key, category, note, Number(actorId) || 0, Date.now());
  wordCache = null;
  logAdmin(actorId, 'forum.word.add', 'word', key, word + '（' + category + '）');
  return wordRows();
}
function removeWord(actorId, rawWord) {
  const key = matchKey(rawWord);
  const row = key ? db.get('SELECT word FROM forum_banned_words WHERE match_key = ?', key) : null;
  if (!row) throw fail('NOT_FOUND', '违禁词不存在');
  db.run('DELETE FROM forum_banned_words WHERE match_key = ?', key);
  wordCache = null;
  logAdmin(actorId, 'forum.word.remove', 'word', key, String(row.word));
  return wordRows();
}

function todayCount(accountId, kind) {
  const row = db.get('SELECT count FROM daily_counts WHERE account_id = ? AND kind = ? AND date = ?',
    Number(accountId), String(kind), localDate());
  return row ? Number(row.count) : 0;
}
function bumpDaily(accountId, kind) {
  db.run(`INSERT INTO daily_counts (account_id,kind,date,count) VALUES (?,?,?,1)
          ON CONFLICT(account_id,kind,date) DO UPDATE SET count = count + 1`,
    Number(accountId), String(kind), localDate());
}
function limitOf(kind) {
  return kind === 'post' ? Number(config.forumDailyPostLimit) : Number(config.forumDailyReplyLimit);
}
function leftOf(limit, used) {
  return limit > 0 ? Math.max(0, limit - used) : null;
}
function quota(accountId) {
  const postsToday = todayCount(accountId, 'forum_post');
  const repliesToday = todayCount(accountId, 'forum_reply');
  const postLimit = limitOf('post'), replyLimit = limitOf('reply');
  return {
    postsToday, repliesToday, postLimit, replyLimit,
    postsLeft: leftOf(postLimit, postsToday), repliesLeft: leftOf(replyLimit, repliesToday),
  };
}
// 在事务内扣一次额度；到上限时抛 429，插入失败会随事务回滚。
function consumeQuota(accountId, kind) {
  const limit = limitOf(kind), used = todayCount(accountId, kind === 'post' ? 'forum_post' : 'forum_reply');
  if (limit > 0 && used >= limit) {
    throw fail('RATE_LIMIT', kind === 'post'
      ? '今天最多发 ' + limit + ' 篇帖子，明天 0 点后恢复'
      : '今天最多回复 ' + limit + ' 条，明天 0 点后恢复', { limit, used });
  }
  bumpDaily(accountId, kind === 'post' ? 'forum_post' : 'forum_reply');
  return quota(accountId);
}

function stats(force) {
  const now = Date.now();
  if (!force && statsCache.value && now - statsCache.at < 2000) return statsCache.value;
  const posts = db.get(`SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(body AS BLOB))),0) AS bytes,
      MIN(created_at) AS oldest, MAX(created_at) AS newest FROM forum_posts`);
  const replies = db.get(`SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(CAST(body AS BLOB))),0) AS bytes,
      MIN(created_at) AS oldest, MAX(created_at) AS newest FROM forum_replies`);
  let dbBytes = 0;
  try {
    const pageCount = db.get('PRAGMA page_count');
    const pageSize = db.get('PRAGMA page_size');
    const count = Number(pageCount && (pageCount.page_count ?? Object.values(pageCount)[0])) || 0;
    const size = Number(pageSize && (pageSize.page_size ?? Object.values(pageSize)[0])) || 0;
    dbBytes = count * size;
  } catch (_) { dbBytes = 0; }
  const postCount = Number(posts.n) || 0, replyCount = Number(replies.n) || 0;
  const maxPosts = Math.max(1, Number(config.forumMaxPosts) || 1);
  const maxReplies = Math.max(1, Number(config.forumMaxReplies) || 1);
  const postPercent = postCount / maxPosts * 100, replyPercent = replyCount / maxReplies * 100;
  const percent = Math.max(postPercent, replyPercent);
  const warnPercent = Math.max(1, Math.min(100, Number(config.forumWarnPercent) || 80));
  const level = postPercent >= 100 || replyPercent >= 100 ? 'full'
    : percent >= warnPercent ? 'warn' : 'ok';
  const contentBytes = (Number(posts.bytes) || 0) + (Number(replies.bytes) || 0);
  const value = {
    posts: postCount, replies: replyCount,
    maxPosts, maxReplies, maxRepliesPerPost: Number(config.forumMaxRepliesPerPost),
    warnPercent, retentionDays: Number(config.forumRetentionDays),
    postPercent: Number(postPercent.toFixed(1)), replyPercent: Number(replyPercent.toFixed(1)),
    percent: Number(percent.toFixed(1)), level,
    contentBytes, estimatedBytes: contentBytes + postCount * 120 + replyCount * 80, dbBytes,
    oldestPostAt: Number(posts.oldest) || 0, newestPostAt: Number(posts.newest) || 0,
    oldestReplyAt: Number(replies.oldest) || 0, newestReplyAt: Number(replies.newest) || 0,
  };
  statsCache = { at: now, value };
  return value;
}
function invalidateStats() { statsCache = { at: 0, value: null }; }
// 写之前检查硬上限；80% 只报警，不拦正常发帖。
function assertWritable(kind, replyCount) {
  const cap = stats();
  if (kind === 'post' && cap.posts >= cap.maxPosts) {
    throw fail('UNAVAILABLE', '论坛帖子容量已满（' + cap.posts + '/' + cap.maxPosts + '），请联系管理员清理旧帖');
  }
  if (kind === 'reply' && cap.replies >= cap.maxReplies) {
    throw fail('UNAVAILABLE', '论坛回复容量已满（' + cap.replies + '/' + cap.maxReplies + '），请联系管理员清理旧帖');
  }
  if (kind === 'reply' && Number(replyCount) >= cap.maxRepliesPerPost) {
    throw fail('RATE_LIMIT', '这篇帖子的回复已达上限（' + cap.maxRepliesPerPost + ' 条）');
  }
}

function prune(days, actorId) {
  const n = Math.max(7, Math.min(3650, Math.floor(Number(days) || 180)));
  const cutoff = Date.now() - n * DAY;
  const count = Number(db.get('SELECT COUNT(*) AS n FROM forum_posts WHERE created_at < ?', cutoff).n) || 0;
  if (count) db.run('DELETE FROM forum_posts WHERE created_at < ?', cutoff);
  invalidateStats();
  logAdmin(actorId, 'forum.prune', 'post', '', '清理 ' + n + ' 天前帖子 ' + count + ' 篇');
  return { days: n, posts: count };
}

module.exports = {
  bootstrap, matchKey,
  roleOf, isAdmin, adminRows, grant, revoke, recentAdminLog, logAdmin,
  words, wordRows, checkContent, addWord, removeWord,
  quota, consumeQuota,
  stats, invalidateStats, assertWritable, prune,
};
