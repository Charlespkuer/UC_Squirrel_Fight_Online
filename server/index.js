'use strict';
/* ============================================================
 * server/index.js — 联机版 HTTP 入口
 * ------------------------------------------------------------
 * 一个 Node 进程同时干三件事（内测够用；正式部署让 Caddy 发静态、这里只跑 /api）：
 *   1. 静态资源（联机版网页）；`/server`、`/save`、`/tools` 等一律 404；
 *   2. `/api/*` JSON 接口；
 *   3. 健康检查与版本。
 * ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { config, localDate } = require('./config');
const db = require('./db');
const runtime = require('./game/runtime');
const { ApiError, fail, sendJson, sendError, corsHeaders, readJson, clientIp, matchPath, rateLimit } = require('./http');
const auth = require('./auth');

const api = {
  account: require('./api/account'),
  state: require('./api/state'),
  battle: require('./api/battle'),
  social: require('./api/social'),
  apprentice: require('./api/apprentice'),
  ladder: require('./api/ladder'),
  campaign: require('./api/campaign'),
  forum: require('./api/forum'),
  owner: require('./api/owner'),
};

/* ============================================================
 * 路由表
 * ============================================================ */
const ROUTES = [
  /* 公开 */
  ['POST', '/api/register', api.account.register, { auth: false, body: true }],
  ['POST', '/api/login', api.account.login, { auth: false, body: true }],
  ['POST', '/api/recover', api.account.recover, { auth: false, body: true }],
  ['GET', '/api/meta', api.account.meta, { auth: false }],
  ['GET', '/api/check-name', api.account.checkName, { auth: false }],
  ['GET', '/api/health', health, { auth: false }],
  ['GET', '/api/version', version, { auth: false }],
  ['GET', '/api/update', updateInfo, { auth: false }],

  /* 会话 */
  ['POST', '/api/logout', api.account.logout, { auth: true }],
  ['POST', '/api/account/delete', api.account.deleteAccount, { auth: true, body: true }],
  ['POST', '/api/account/password', api.account.changePassword, { auth: true, body: true }],
  ['POST', '/api/account/name', api.account.changeName, { auth: true, body: true }],
  ['GET', '/api/profile', api.account.profile, { auth: true }],
  ['GET', '/api/device/quota', api.account.deviceQuota, { auth: true }],
  /* 主人 IP 专属的只读状态（设置页「一键同步更改」可见性）；非主人只拿到 owner:false。 */
  ['GET', '/api/owner/status', api.owner.status, { auth: true }],
  /* 主人 IP 专属：从客户端版本 X 到服务器当前版本的文件级预览（只读）。 */
  ['GET', '/api/owner/sync/preview', api.owner.preview, { auth: true }],

  /* 存档与动作 */
  ['GET', '/api/state', api.state.getState, { auth: true }],
  ['GET', '/api/state/summary', api.state.summary, { auth: true }],
  ['POST', '/api/action', api.state.act, { auth: true, body: true }],
  ['GET', '/api/snapshot', api.state.snapshot, { auth: true }],
  ['POST', '/api/snapshot/sync', api.state.syncSnapshot, { auth: true, body: true }],

  /* 战斗 */
  ['POST', '/api/battle', api.battle.battle, { auth: true, body: true }],
  ['GET', '/api/battle/chest', api.battle.pendingChests, { auth: true }],
  ['POST', '/api/battle/chest', api.battle.claimChest, { auth: true, body: true }],
  ['POST', '/api/battle/pickup', api.battle.claimPickup, { auth: true, body: true }],
  ['GET', '/api/opponents', api.battle.opponents, { auth: true }],
  ['GET', '/api/fighter', api.battle.fighter, { auth: true }],
  ['GET', '/api/combat/:id', api.battle.combat, { auth: true }],
  ['GET', '/api/replay/:id', api.battle.replay, { auth: true }],
  ['POST', '/api/arena/join', api.battle.arenaJoin, { auth: true, body: true }],
  ['GET', '/api/arena/state', api.battle.arenaState, { auth: true }],

  /* 天梯 */
  ['GET', '/api/ladder', api.ladder.ladder, { auth: true }],
  ['GET', '/api/ladder/award', api.social.rankAward, { auth: true }],
  ['POST', '/api/ladder/award', api.social.claimRankAward, { auth: true, body: true }],

  /* 消息 / 好友 / 师徒 */
  ['GET', '/api/messages', api.social.messages, { auth: true }],
  ['GET', '/api/messages/badge', api.social.badge, { auth: true }],
  ['POST', '/api/messages/seen', api.social.seenMessages, { auth: true, body: true }],
  ['POST', '/api/messages/read', api.social.readMessages, { auth: true, body: true }],
  ['POST', '/api/messages/claim', api.social.claimMail, { auth: true, body: true }],
  ['GET', '/api/friends', api.social.friends, { auth: true }],
  ['POST', '/api/friends', api.social.addFriend, { auth: true, body: true }],
  ['GET', '/api/friends/requests', api.social.friendRequests, { auth: true }],
  ['POST', '/api/friends/requests/:id', api.social.respondFriendRequest, { auth: true, body: true }],
  ['POST', '/api/friends/ai', api.social.addAiFriend, { auth: true, body: true }],
  ['DELETE', '/api/friends/:id', api.social.removeFriend, { auth: true }],
  ['GET', '/api/players', api.social.search, { auth: true }],
  ['GET', '/api/board', api.social.friendMessages, { auth: true }],
  ['POST', '/api/board', api.social.leaveFriendMessage, { auth: true, body: true }],
  ['GET', '/api/apprentices', api.apprentice.list, { auth: true }],
  ['GET', '/api/apprentice', api.apprentice.list, { auth: true }],
  ['GET', '/api/apprentice/candidates', api.apprentice.candidates, { auth: true }],
  ['POST', '/api/apprentice/master', api.apprentice.master, { auth: true, body: true }],
  ['POST', '/api/apprentice/recruit', api.apprentice.recruit, { auth: true, body: true }],
  ['POST', '/api/apprentice/kick', api.apprentice.kick, { auth: true, body: true }],
  ['POST', '/api/apprentice/leave', api.apprentice.leave, { auth: true, body: true }],
  ['POST', '/api/apprentice/tribute', api.apprentice.tribute, { auth: true, body: true }],

  ['GET', '/api/forum/posts', api.forum.list, { auth: true }],
  ['POST', '/api/forum/posts', api.forum.create, { auth: true, body: true }],
  ['GET', '/api/forum/posts/:id', api.forum.detail, { auth: true }],
  ['DELETE', '/api/forum/posts/:id', api.forum.removePost, { auth: true }],
  ['POST', '/api/forum/posts/:id/replies', api.forum.reply, { auth: true, body: true }],
  ['DELETE', '/api/forum/replies/:id', api.forum.removeReply, { auth: true }],

  /* 论坛管理（登录 + forum_admins 角色；没有公开 token 接口）。 */
  ['GET', '/api/forum/admin/overview', api.forum.overview, { auth: true }],
  ['POST', '/api/forum/admin/words', api.forum.addWord, { auth: true, body: true }],
  ['POST', '/api/forum/admin/words/delete', api.forum.removeWord, { auth: true, body: true }],
  ['POST', '/api/forum/admin/admins', api.forum.grantAdmin, { auth: true, body: true }],
  ['POST', '/api/forum/admin/admins/delete', api.forum.revokeAdmin, { auth: true, body: true }],
  ['POST', '/api/forum/admin/prune', api.forum.prune, { auth: true, body: true }],

  /* 征战（四人组队） */
  ['GET', '/api/campaign/bosses', api.campaign.bosses, { auth: true }],
  ['POST', '/api/campaign/queue', api.campaign.joinQueue, { auth: true, body: true }],
  ['POST', '/api/campaign/random', api.campaign.randomMatch, { auth: true, body: true }],
  ['GET', '/api/campaign/current', api.campaign.current, { auth: true }],
  ['POST', '/api/campaign/queue/leave', api.campaign.leaveQueue, { auth: true, body: true }],
  ['POST', '/api/campaign/rooms', api.campaign.create, { auth: true, body: true }],
  ['GET', '/api/campaign/rooms', api.campaign.list, { auth: true }],
  ['POST', '/api/campaign/rooms/:code/join', api.campaign.join, { auth: true, body: true }],
  ['GET', '/api/campaign/rooms/:code', api.campaign.status, { auth: true }],
  ['POST', '/api/campaign/rooms/:code/leave', api.campaign.leave, { auth: true, body: true }],
  ['POST', '/api/campaign/rooms/:code/roll', api.campaign.roll, { auth: true, body: true }],
  ['POST', '/api/campaign/rooms/:code/ack', api.campaign.ack, { auth: true, body: true }],
];

function health() {
  const row = db.get('SELECT 1 AS ok');
  return {
    ok: true,
    version: require('./game/runtime').boot().simVersion,
    db: row && row.ok === 1 ? 'ok' : 'bad',
    season: require('./game/settlement').weekKey(),
    date: localDate(),
    uptime: Math.round(process.uptime()),
    serverTime: Date.now(),
  };
}

function version() {
  const info = runtime.boot();
  return { ok: true, version: info.simVersion, levelCap: info.levelCap, files: info.files.length };
}

/** 客户端更新清单：版本号取部署时写入的 scripts/version.json，
 *  「是否强制 / 更新说明 / 下载页 / 轮询秒数」由 server/update.json 控制。
 *  注意这里只做**通知**；客户端是本地打包资源，不能由服务端直接热替换。 */
function updateInfo() {
  let build = {};
  try { build = JSON.parse(fs.readFileSync(path.join(config.gameRoot, 'scripts', 'version.json'), 'utf8')) || {}; }
  catch (e) { build = {}; }
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'update.json'), 'utf8')) || {}; }
  catch (e) { policy = {}; }
  const versionText = String(build.version || '');
  const poll = Math.max(20, Math.min(600, Number(policy.pollSeconds) || 60));
  return {
    ok: true,
    version: versionText,
    notes: String(policy.notes || build.note || ''),
    minVersion: String(policy.minVersion || ''),
    force: policy.force === true,
    url: String(policy.url || 'https://github.com/Charlespkuer/UC_Squirrel_Fight_remake/releases/latest'),
    pollSeconds: poll,
    releasedAt: String(policy.releasedAt || build.date || ''),
    serverTime: Date.now(),
  };
}

/* ============================================================
 * 静态资源
 * ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/** 静态目录里永远不对外的东西：源码之外的服务端/存档/工具/文档/凭据。
 *  ⚠ 一律用小写比较（URL 大小写不敏感的那部分），所以这里也全写小写。 */
const DENY_PREFIX = [
  '/server/', '/save/', '/out/', '/tools/', '/docs/', '/reference/', '/references/', '/shared/',
  '/.git/', '/src-tauri/', '/node_modules/', '/.agents/', '/.github/', '/.vscode/',
  '/scripts/sync/', '/package.json', '/package-lock.json',
  '/agents.md', '/readme.md', '/license', '/.gitignore', '/.gitattributes',
  '/squirrel_fight_online.exe',
];

function denyPath(pathname) {
  const p = pathname.toLowerCase();
  return DENY_PREFIX.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix));
}

/**
 * 把 URL 里的路径变成可安全拼接的绝对路径。
 * ⚠ 不能让 `path.join(root, '/foo/../server/x')` 或 Windows 的 `\` 绕过
 * DENY_PREFIX：先统一斜杠、消掉 `.`/`..`，再按**解析后的相对路径**做黑名单。
 * 返回 `null` 表示拒绝（NUL、盘符、UNC/双斜杠等）。
 */
function staticPath(pathname) {
  if (typeof pathname !== 'string' || pathname.indexOf('\0') !== -1) return null;
  const slashed = pathname.replace(/\\/g, '/');
  if (slashed.startsWith('//') || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed);
  if (normalized.indexOf('\0') !== -1) return null;
  const rel = normalized === '/' ? '/scripts/index-online.html'
    : normalized === '/index.html' ? '/scripts/index-online.html'
      : normalized;
  const rootAbs = path.resolve(config.wwwRoot);
  const resolved = path.resolve(rootAbs, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const relative = path.relative(rootAbs, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  const canonical = relative ? '/' + relative.split(path.sep).join('/') : '/';
  if (denyPath(canonical)) return null;
  return { normalized, resolved, canonical };
}

/** 静态资源 gzip 缓存：同一版本（mtime+size）只压一次。
 *  玩家第一次进游戏要拉几十个 js/css，重复 gzip 是纯 CPU；ETag 只挡重复下载，
 *  挡不住「另一个玩家第一次下载」时的压缩。上限 128 项，超出按插入顺序淘汰。 */
const gzipCache = new Map();

function serveStatic(req, res, pathname) {
  if (!config.serveStatic) return false;
  const target = staticPath(pathname);
  if (!target) { sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', msg: '不存在' } }, req); return true; }
  const { resolved } = target;
  let st = null;
  try { st = fs.statSync(resolved); } catch (_) { st = null; }
  if (!st || !st.isFile()) return false;
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
  const headers = { 'content-type': type, etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const cache = /^\/(images|audio)\//.test(target.canonical) ? 'public, max-age=604800, immutable'
    : /^\/(js|css)\//.test(target.canonical) ? 'public, max-age=300' : 'no-cache';
  headers['cache-control'] = cache;
  const accept = String(req.headers['accept-encoding'] || '');
  const compressible = /^(text\/|application\/(javascript|json|svg)|image\/svg)/.test(type) && st.size > 2048;
  if (compressible && /\bgzip\b/.test(accept)) {
    const key = resolved + '|' + st.size + '|' + Math.round(st.mtimeMs);
    const hit = gzipCache.get(key);
    if (hit) {
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = String(hit.length);
      headers['vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(hit);
      return true;
    }
    fs.readFile(resolved, (err, buf) => {
      if (err) { res.writeHead(500); res.end(); return; }
      const gz = zlib.gzipSync(buf, { level: 5 });
      if (gzipCache.size >= 128) gzipCache.delete(gzipCache.keys().next().value);
      gzipCache.set(key, gz);
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = String(gz.length);
      headers['vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      res.end(gz);
    });
    return true;
  }
  headers['content-length'] = String(st.size);
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}

/* ============================================================
 * 客户端更新包下载
 * ------------------------------------------------------------
 * 线上 `SERVE_STATIC=false`，整棵站点不对外；这里只开放 DATA_DIR/downloads
 * 下白名单扩展名的安装包（/download 是给人看的列表页）。文件名里不允许
 * 路径分隔符，避免目录穿越；目录本身由部署脚本之外单独上传。
 * ============================================================ */
const DOWNLOAD_DIR = path.join(config.dataDir, 'downloads');
const DOWNLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|apk|ipa|dmg|zip)$/i;

function downloadFiles() {
  try {
    return fs.readdirSync(DOWNLOAD_DIR)
      .filter((name) => DOWNLOAD_NAME.test(name))
      .map((name) => {
        let size = 0;
        try { size = fs.statSync(path.join(DOWNLOAD_DIR, name)).size; } catch (e) {}
        return { name, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return [];
  }
}

function downloadPage() {
  const version = updateInfo().version;
  const rows = downloadFiles().map((f) => {
    const mb = (f.size / 1048576).toFixed(1);
    const platform = /\.apk$/i.test(f.name) ? 'Android' : /\.exe$/i.test(f.name) ? 'Windows' : '安装包';
    return '<li><a href="/download/' + encodeURIComponent(f.name) + '">' + platform + ' · ' + f.name + '</a><span>' + mb + ' MB</span></li>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>松鼠大战 Online 更新</title>' +
    '<style>body{margin:0;padding:28px 18px;font:16px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;' +
    'background:#f6ecd2;color:#6b4a24}h1{margin:0 0 6px;font-size:24px;color:#a3701d}' +
    'p{margin:6px 0}ul{list-style:none;padding:0;margin:18px 0;max-width:760px}' +
    'li{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:12px 16px;margin:8px 0;' +
    'border-radius:14px;background:#fff8df;box-shadow:inset 0 0 0 2px #e8c46a}' +
    'a{color:#8a4b12;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}' +
    'span{color:#9b7b51;white-space:nowrap}.hint{color:#9b7b51;font-size:13px}</style>' +
    '<h1>松鼠大战 Online 客户端下载</h1>' +
    '<p>服务器当前版本 <b>v' + version + '</b>。Windows 下载 .exe，Android 下载 .apk。</p>' +
    '<p class="hint">下载后请完全退出旧版本，再运行安装包；存档与账号不会丢失。</p>' +
    '<ul>' + (rows || '<li>更新包还没上传，请稍后再试</li>') + '</ul>' +
    '<p class="hint">如果浏览器拦截下载，请允许来自本站的下载。</p></html>';
}

function serveDownload(req, res, pathname) {
  if (pathname === '/download' || pathname === '/download/') {
    const body = Buffer.from(downloadPage(), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return true;
  }
  const m = /^\/download\/([^/]+)$/.exec(pathname);
  if (!m || !DOWNLOAD_NAME.test(m[1])) return false;
  const name = m[1];
  const file = path.join(DOWNLOAD_DIR, name);
  let st = null;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const mime = /\.apk$/i.test(name) ? 'application/vnd.android.package-archive'
    : /\.exe$/i.test(name) ? 'application/vnd.microsoft.portable-executable'
      : 'application/octet-stream';
  res.writeHead(200, {
    'content-type': mime,
    'content-length': st.size,
    'content-disposition': 'attachment; filename="' + name.replace(/["\\]/g, '') + '"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).on('error', () => { try { res.destroy(); } catch (e) {} }).pipe(res);
  return true;
}

/* ============================================================
 * 请求处理
 * ============================================================ */
async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (_) { throw fail('BAD_REQUEST', '无效的请求路径'); }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);

  if (!pathname.startsWith('/api/')) {
    if (serveDownload(req, res, pathname)) return;
    if (serveStatic(req, res, pathname)) return;
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', msg: '页面不存在' } }, req);
    return;
  }

  let matched = null;
  let params = {};
  let allowed = [];
  for (const [method, pattern, handler, opts] of ROUTES) {
    const m = matchPath(pattern, pathname);
    if (!m) continue;
    if (method !== req.method) { allowed.push(method); continue; }
    matched = { handler, opts };
    params = m;
    break;
  }
  if (!matched) {
    if (allowed.length) throw fail('BAD_REQUEST', '方法不允许，应该用 ' + allowed.join('/'));
    throw fail('NOT_FOUND', '接口不存在：' + pathname);
  }

  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  let session = null;
  if (matched.opts.auth !== false) {
    session = auth.sessionFromRequest(req);
    if (!session) {
      if (req.__authKicked) {
        const reason = String(req.__authKicked.reason || '');
        const msg = /^password_/.test(reason)
          ? '密码已修改，请重新登录'
          : '账号已在其他设备登录，本设备已下线。若不是你本人操作，请立即修改密码。';
        throw fail('SESSION_KICKED', msg);
      }
      throw fail('AUTH', '登录已失效，请重新登录');
    }
    if (Number(session.account.banned)) throw fail('FORBIDDEN', '账号已被封禁');
    if (req.method === 'GET') rateLimit('read:' + session.account.id, 300, 60000);
  }

  const body = matched.opts.body ? await readJson(req) : {};
  const ctx = {
    req, res, query, params, body,
    headers: req.headers,
    account: session ? session.account : null,
    auth: session,
  };
  const out = await matched.handler(ctx);
  if (matched.opts.auth !== false && session) auth.touchSession(session.session);
  if (res.headersSent) return;
  sendJson(res, 200, out, req);
}

function start(port) {
  runtime.boot();
  db.open();
  /* 论坛：默认违禁词 + 创始管理员（玩家编号 100000）幂等种入。 */
  try { require('./game/forum').bootstrap(); } catch (e) { console.error('[forum] init failed', e && e.message); }
  /* 天梯：启动时先把本周的人机名册补齐；周结算（玩家减半 / 人机回 300）在第一次读分时懒执行。 */
  try {
    const settle = require('./game/settlement');
    settle.weekTick();
    settle.ensureBots();
  } catch (e) { console.error('[rank] week init failed', e && e.message); }
  /* 追加型表（战斗录像/动作账本/消息/周积分/宝箱…）的保留期清理：
   * 启动跑一次，之后定时跑；定时器已 unref，不会阻止进程退出。 */
  const maintenance = require('./game/maintenance');
  maintenance.startScheduler();
  /* 整库备份：启动一次，之后按 BACKUP_INTERVAL_MS 定时跑；只写 backup/auto。 */
  const backup = require('./game/backup');
  backup.startScheduler();
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    if (config.logRequests) {
      /* 只记方法/路径/状态/耗时 —— 不记令牌、不记请求体。排查「客户端到底连没连上」用。 */
      res.on('finish', () => {
        console.log('[req] ' + req.method + ' ' + String(req.url || '').split('?')[0] +
          ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
      });
    }
    handle(req, res).catch((err) => {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      sendError(res, err, req);
    });
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  server.on('close', () => { maintenance.stopScheduler(); backup.stopScheduler(); });
  const p = port == null ? config.port : port;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, config.bind, () => {
      const addr = server.address();
      console.log('[ssdz-online] listening on http://' + config.bind + ':' + addr.port +
        '  (data=' + config.dataDir + ', game=' + config.gameRoot + ')');
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  start().then(({ port }) => {
    process.on('SIGTERM', () => { db.close(); process.exit(0); });
    process.on('SIGINT', () => { db.close(); process.exit(0); });
  }).catch((e) => {
    console.error('[ssdz-online] 启动失败：', e);
    process.exit(1);
  });
}

module.exports = { start, handle, ROUTES };
