'use strict';
// server/index.js — 联机版 HTTP 入口
// 2. `/api/*` JSON 接口；

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { config, localDate } = require('./config');
const db = require('./db');
const runtime = require('./game/runtime');
const settlement = require('./game/settlement');
const { ApiError, fail, sendJson, sendError, corsHeaders, readJson, clientIp, matchPath, rateLimit } = require('./http');
const auth = require('./auth');
const enforcement = require('./game/enforcement');

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
  client: require('./api/client'),
};

const ROUTES = [

  ['POST', '/api/register', api.account.register, { auth: false, body: true }],
  ['POST', '/api/login', api.account.login, { auth: false, body: true }],
  ['POST', '/api/recover', api.account.recover, { auth: false, body: true }],
  ['GET', '/api/meta', api.account.meta, { auth: false }],
  ['GET', '/api/check-name', api.account.checkName, { auth: false }],
  ['GET', '/api/health', health, { auth: false }],
  ['GET', '/api/version', version, { auth: false }],
  ['GET', '/api/update', updateInfo, { auth: false }],
  // 纯网页端「下载客户端」：按上报的系统 / 架构给出对应安装包（没有时返回原因）。
  ['GET', '/api/client/download', api.client.download, { auth: false }],


  ['POST', '/api/logout', api.account.logout, { auth: true }],
  ['POST', '/api/account/delete', api.account.deleteAccount, { auth: true, body: true }],
  ['POST', '/api/account/password', api.account.changePassword, { auth: true, body: true }],
  ['POST', '/api/account/name', api.account.changeName, { auth: true, body: true }],
  ['GET', '/api/profile', api.account.profile, { auth: true }],
  ['GET', '/api/device/quota', api.account.deviceQuota, { auth: true }],

  ['GET', '/api/owner/status', api.owner.status, { auth: true }],
  // 主人 IP 专属：从客户端版本 X 到服务器当前版本的文件级预览（只读）。
  ['GET', '/api/owner/sync/preview', api.owner.preview, { auth: true }],

  // 存档与动作
  ['GET', '/api/state', api.state.getState, { auth: true }],
  ['GET', '/api/state/summary', api.state.summary, { auth: true }],
  ['POST', '/api/action', api.state.act, { auth: true, body: true }],
  ['GET', '/api/snapshot', api.state.snapshot, { auth: true }],
  ['POST', '/api/snapshot/sync', api.state.syncSnapshot, { auth: true, body: true }],


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


  ['GET', '/api/ladder', api.ladder.ladder, { auth: true }],
  ['GET', '/api/ladder/award', api.social.rankAward, { auth: true }],
  ['POST', '/api/ladder/award', api.social.claimRankAward, { auth: true, body: true }],


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
  ['POST', '/api/apprentice/refresh', api.apprentice.refresh, { auth: true, body: true }],
  ['POST', '/api/apprentice/recruit', api.apprentice.recruit, { auth: true, body: true }],
  ['POST', '/api/apprentice/kick', api.apprentice.kick, { auth: true, body: true }],
  ['POST', '/api/apprentice/leave', api.apprentice.leave, { auth: true, body: true }],
  ['POST', '/api/apprentice/tribute', api.apprentice.tribute, { auth: true, body: true }],
  ['POST', '/api/apprentice/cheer', api.apprentice.cheer, { auth: true }],

  ['GET', '/api/forum/posts', api.forum.list, { auth: true }],
  ['POST', '/api/forum/posts', api.forum.create, { auth: true, body: true }],
  ['GET', '/api/forum/posts/:id', api.forum.detail, { auth: true }],
  ['DELETE', '/api/forum/posts/:id', api.forum.removePost, { auth: true }],
  ['POST', '/api/forum/posts/:id/replies', api.forum.reply, { auth: true, body: true }],
  ['DELETE', '/api/forum/replies/:id', api.forum.removeReply, { auth: true }],

  // 论坛管理（登录 + forum_admins 角色；没有公开 token 接口）。
  ['GET', '/api/forum/admin/overview', api.forum.overview, { auth: true }],
  ['POST', '/api/forum/admin/words', api.forum.addWord, { auth: true, body: true }],
  ['POST', '/api/forum/admin/words/delete', api.forum.removeWord, { auth: true, body: true }],
  ['POST', '/api/forum/admin/admins', api.forum.grantAdmin, { auth: true, body: true }],
  ['POST', '/api/forum/admin/admins/delete', api.forum.revokeAdmin, { auth: true, body: true }],
  ['POST', '/api/forum/admin/prune', api.forum.prune, { auth: true, body: true }],


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
    enforcement: enforcement.health(),
  };
}

function version() {
  const info = runtime.boot();
  return { ok: true, version: info.simVersion, levelCap: info.levelCap, files: info.files.length };
}

// 客户端更新清单：版本号取部署时写入的 scripts/version.json，
// 注意这里只做通知；客户端是本地打包资源，不能由服务端直接热替换。
function updateInfo(ctx) {
  let build = {};
  try { build = JSON.parse(fs.readFileSync(path.join(config.gameRoot, 'scripts', 'version.json'), 'utf8')) || {}; }
  catch (e) { build = {}; }
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'update.json'), 'utf8')) || {}; }
  catch (e) { policy = {}; }
  const versionText = String(build.version || '');
  const poll = Math.max(20, Math.min(600, Number(policy.pollSeconds) || 60));
  // 客户端「立即更新」要直接用这两个地址整包替换（不是打开下载页）：
  // 只有本版本对应的安装包真的在下载目录里时才给地址。
  const pkg = api.owner.packageInfo(versionText);
  /* iOS 包常比 EXE/APK 落后一版：iOS 客户端按 iOS 最新包的版本判断，
   * 否则装完最新 IPA 仍会被服务器版本号反复提示。 */
  const platform = String((ctx && ctx.req && ctx.req.headers && ctx.req.headers['x-device-platform']) || '').toLowerCase();
  const iosVersion = platform === 'ios' ? String(pkg.ipaVersion || '') : '';
  const version = iosVersion || versionText;
  return {
    ok: true,
    version,
    notes: String(policy.notes || build.note || ''),
    minVersion: iosVersion ? '' : String(policy.minVersion || ''),
    force: iosVersion ? false : policy.force === true,
    url: String(policy.url || 'https://github.com/Charlespkuer/UC_Squirrel_Fight_remake/releases/latest'),
    exe: pkg.exe,
    apk: pkg.apk,
    apkX86: pkg.apkX86,
    ipa: pkg.ipa,
    ipaLegacy: pkg.ipaLegacy,
    ipaVersion: pkg.ipaVersion,
    ipaLegacyVersion: pkg.ipaLegacyVersion,
    exeSize: pkg.exeSize,
    apkSize: pkg.apkSize,
    apkX86Size: pkg.apkX86Size,
    ipaSize: pkg.ipaSize,
    ipaLegacySize: pkg.ipaLegacySize,
    downloads: downloadFiles(),
    pollSeconds: poll,
    releasedAt: String(policy.releasedAt || build.date || ''),
    serverTime: Date.now(),
  };
}

// 开发页 / 浏览器版读取的「当前构建」清单（与 server/web-manifest.json 同源）。
// EXE/APK 里自带同一份文件，浏览器版没有打进包，所以由服务端补这一条。
function webManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.gameRoot, 'server', 'web-manifest.json'), 'utf8'));
  } catch (e) {
    return { ok: false, error: { code: 'NOT_FOUND', msg: '服务器还没有文件清单' } };
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 静态目录里永远不对外的东西：源码之外的服务端/存档/工具/文档/凭据。
// ⚠ 一律用小写比较（URL 大小写不敏感的那部分），所以这里也全写小写。
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

// 把 URL 里的路径变成可安全拼接的绝对路径。
// ⚠ 不能让 `path.join(root, '/foo/../server/x')` 或 Windows 的 `\` 绕过
// DENY_PREFIX：先统一斜杠、消掉 `.`/`..`，再按解析后的相对路径做黑名单。
function staticPath(pathname) {
  if (typeof pathname !== 'string' || pathname.indexOf('\0') !== -1) return null;
  const slashed = pathname.replace(/\\/g, '/');
  if (slashed.startsWith('//') || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed);
  if (normalized.indexOf('\0') !== -1) return null;
  const rel = normalized === '/' ? '/scripts/index-online.html'
    : normalized === '/index.html' ? '/scripts/index-online.html'
      : normalized === '/play' || normalized === '/play/' ? '/scripts/index-online.html'
        : normalized === '/favicon.ico' ? '/images/ui/web/favicon.svg'
          : normalized;
  const rootAbs = path.resolve(config.wwwRoot);
  const resolved = path.resolve(rootAbs, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const relative = path.relative(rootAbs, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  const canonical = relative ? '/' + relative.split(path.sep).join('/') : '/';
  if (denyPath(canonical)) return null;
  return { normalized, resolved, canonical };
}

// 静态资源 gzip 缓存：同一版本（mtime+size）只压一次。
// 压缩走 libuv 线程池（zlib.gzip 回调），不再用 gzipSync 堵事件循环；同一文件并发首访只压一次。
const gzipCache = new Map();
const gzipPending = new Map();
const LONG_CACHE = 'public, max-age=31536000, immutable';

function gzipAsync(buf) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, { level: 5 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

// 网页端构建号：版本号 + 前端文件指纹。只改一个 JS/JSON 也必须换 URL，
// 否则一年 immutable 会把旧文件钉在玩家浏览器里。
let webVersionCache = { at: 0, value: '' };
function latestAssetHash() {
  const lines = [];
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of list) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (depth > 0) walk(full, depth - 1); continue; }
      if (!/\.(js|css|json|webp|png|jpe?g|svg|mp3|ogg|wav)$/i.test(ent.name)) continue;
      try {
        const st = fs.statSync(full);
        lines.push(ent.name + ':' + st.size + ':' + Math.round(st.mtimeMs));
      } catch (_) {}
    }
  };
  walk(path.join(config.gameRoot, 'js'), 2);
  walk(path.join(config.gameRoot, 'css'), 0);
  walk(path.join(config.gameRoot, 'audio'), 0);
  walk(path.join(config.gameRoot, 'images', 'ssfight', 'ui'), 1);
  if (!lines.length) return '';
  lines.sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 10);
}
function webVersion() {
  const now = Date.now();
  if (webVersionCache.at && now - webVersionCache.at < 5000) return webVersionCache.value;
  let base = '';
  try {
    const info = JSON.parse(fs.readFileSync(path.join(config.gameRoot, 'scripts', 'version.json'), 'utf8'));
    base = String((info && info.version) || '');
  } catch (_) { base = ''; }
  const hash = latestAssetHash();
  const value = (base || hash) ? [base, hash].filter(Boolean).join('-') : '';
  webVersionCache = { at: now, value };
  return value;
}

// 入口页按构建号改写脚本/样式 URL，并注入 `__SSDZ_WEB_VERSION__`：
// 原生包不走这里；网页端刷新后不会出现「新 JS + 旧 UI JSON」的混版本。
function serveDocument(req, res, resolved, st) {
  let html;
  try { html = fs.readFileSync(resolved, 'utf8'); } catch (_) { return false; }
  const version = webVersion();
  if (version) {
    const q = encodeURIComponent(version);
    html = html.replace(/(src|href)="((?:js|css)\/[^"?]+)"/g, (all, attr, file) => attr + '="' + file + '?v=' + q + '"');
    if (html.indexOf('__SSDZ_WEB_VERSION__') < 0) {
      html = html.replace('</head>', '<script>window.__SSDZ_WEB_VERSION__=' + JSON.stringify(version) + ';</script></head>');
    }
  }
  const buf = Buffer.from(html, 'utf8');
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '-' + version.replace(/[^A-Za-z0-9._-]/g, '') + '"';
  const headers = { 'content-type': 'text/html; charset=utf-8', etag, 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  headers['content-length'] = String(buf.length);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else res.end(buf);
  return true;
}

// 可选 CDN：只转发静态资源，`/api` 永远留本机（否则 IP 会变成 CDN 回源地址）。
function redirectAsset(req, res, pathname) {
  if (!config.assetBase || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (!/^\/(images|js|css|audio)\//.test(pathname)) return false;
  // manifest / favicon / PWA 图标必须同源，不能给 CDN。
  if (/^\/images\/ui\/web\//.test(pathname)) return false;
  let base;
  try { base = new URL(config.assetBase); } catch (_) { return false; }
  if (!base || !/^https?:$/.test(base.protocol)) return false;
  const target = staticPath(pathname);
  if (!target) return false;
  const raw = String(req.url || '');
  const search = raw.indexOf('?') >= 0 ? raw.slice(raw.indexOf('?')) : '';
  res.writeHead(301, {
    location: config.assetBase + target.canonical + search,
    'cache-control': 'public, max-age=86400',
    'content-length': '0',
  });
  res.end();
  return true;
}

async function serveStatic(req, res, pathname) {
  if (!config.serveStatic) return false;
  if (redirectAsset(req, res, pathname)) return true;
  const target = staticPath(pathname);
  if (!target) { sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', msg: '不存在' } }, req); return true; }
  const { resolved } = target;
  let st = null;
  try { st = fs.statSync(resolved); } catch (_) { st = null; }
  if (!st || !st.isFile()) return false;
  if (target.canonical === '/scripts/index-online.html') return serveDocument(req, res, resolved, st);
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
  const headers = { 'content-type': type, etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const versioned = /[?&]v=/.test(String(req.url || ''));
  let cache = 'no-cache';
  if (/\.webmanifest$/.test(resolved)) cache = 'no-cache';
  else if (/^\/(images|audio)\//.test(target.canonical)) {
    cache = (/\.json$/i.test(resolved) && !versioned) ? 'no-cache'
      : (versioned ? LONG_CACHE : 'public, max-age=604800, immutable');
  } else if (/^\/(js|css)\//.test(target.canonical)) {
    cache = versioned ? LONG_CACHE : 'public, max-age=300';
  }
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
    let pending = gzipPending.get(key);
    if (!pending) {
      pending = fs.promises.readFile(resolved)
        .then((buf) => gzipAsync(buf))
        .then((gz) => {
          if (gzipCache.size >= 128) gzipCache.delete(gzipCache.keys().next().value);
          gzipCache.set(key, gz);
          gzipPending.delete(key);
          return gz;
        }, (err) => { gzipPending.delete(key); throw err; });
      gzipPending.set(key, pending);
    }
    let gz;
    try { gz = await pending; } catch (_) { res.writeHead(500); res.end(); return true; }
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(gz.length);
    headers['vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(gz);
    return true;
  }
  headers['content-length'] = String(st.size);
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}

// 客户端更新包下载
// 路径分隔符，避免目录穿越；目录本身由部署脚本之外单独上传。
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
  const info = updateInfo();
  const version = info.version;
  const mb = (n) => (Number(n) / 1048576).toFixed(1);
  const pkgRow = (url, label, size) => url
    ? '<li><a href="' + url + '">' + label + ' · ' + url.split('/').pop() + '</a><span>' + mb(size) + ' MB</span></li>'
    : '';
  const iosRows = [
    pkgRow(info.ipa, 'iOS 26+（越狱 / TrollStore）', info.ipaSize),
    pkgRow(info.ipaLegacy, 'iOS 15~25（越狱 / TrollStore）', info.ipaLegacySize),
  ].filter(Boolean).join('');
  const currentRows = [
    pkgRow(info.exe, 'Windows', info.exeSize),
    pkgRow(info.apk, 'Android（手机 / 平板，arm64）', info.apkSize),
    pkgRow(info.apkX86, 'Android（模拟器 / Intel，x86_64）', info.apkX86Size),
  ].filter(Boolean).join('');
  const currentNames = new Set([info.exe, info.apk, info.apkX86, info.ipa, info.ipaLegacy]
    .filter(Boolean).map((url) => url.split('/').pop()));
  const rows = downloadFiles().filter((f) => !currentNames.has(f.name)).map((f) => {
    const platform = /\.apk$/i.test(f.name)
      ? (/x86_64/i.test(f.name) ? 'Android（模拟器 / Intel）' : 'Android（手机 / 平板）')
      : /\.ipa$/i.test(f.name)
        ? (/legacy/i.test(f.name) ? 'iOS 15~25（越狱 / TrollStore）' : 'iOS 26+（越狱 / TrollStore）')
        : /\.exe$/i.test(f.name) ? 'Windows' : '安装包';
    return '<li><a href="/download/' + encodeURIComponent(f.name) + '">' + platform + ' · ' + f.name + '</a><span>' + mb(f.size) + ' MB</span></li>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>松鼠大战 Online 更新</title>' +
    '<style>body{margin:0;padding:28px 18px;font:16px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;' +
    'background:#f6ecd2;color:#6b4a24}h1{margin:0 0 6px;font-size:24px;color:#a3701d}' +
    'h2{margin:22px 0 4px;font-size:17px;color:#8a4b12}' +
    'p{margin:6px 0}ul{list-style:none;padding:0;margin:8px 0 18px;max-width:760px}' +
    'li{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:12px 16px;margin:8px 0;' +
    'border-radius:14px;background:#fff8df;box-shadow:inset 0 0 0 2px #e8c46a}' +
    'a{color:#8a4b12;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}' +
    'span{color:#9b7b51;white-space:nowrap}.hint{color:#9b7b51;font-size:13px}</style>' +
    '<h1>松鼠大战 Online 客户端下载</h1>' +
    '<p>服务器当前版本 <b>v' + version + '</b>。Windows 下载 .exe；Android 普通手机选 arm64，x86_64 只给模拟器 / Intel 设备。</p>' +
    '<p>iOS 越狱 / TrollStore 用户：按系统版本下载对应未签名 IPA（iOS 26+ 用默认包，iOS 15~25 用 legacy 包），用 TrollStore、AltStore 或 Sideloadly 安装；保持同一 Bundle ID，服务器账号与进度不会丢。</p>' +
    '<p>不想装客户端？直接用浏览器打开 <a href="/">网页版</a>：手机、平板、电脑都能玩，进度与客户端互通。</p>' +
    (iosRows ? '<h2>iOS 最新包' + (info.ipaVersion && info.ipaVersion !== version ? ' v' + info.ipaVersion : '') +
      '（越狱 / TrollStore）</h2><ul>' + iosRows + '</ul>' : '') +
    (currentRows ? '<h2>当前版本 v' + version + '</h2><ul>' + currentRows + '</ul>' : '') +
    '<h2>历史版本</h2><ul>' + (rows || '<li>没有其它历史包</li>') + '</ul>' +
    '<p class="hint">下载后请完全退出旧版本，再运行安装包；存档与账号不会丢失。如果浏览器拦截下载，请允许来自本站的下载。</p></html>';
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
    // 开发页 / 浏览器版读「当前构建」清单：客户端包（EXE/APK）自带同一份文件，
    // 这里只让浏览器里的设置页也能算出构建号；生产 SERVE_STATIC=false 时不影响客户端。
    if (pathname === '/web-manifest.json') { sendJson(res, 200, webManifest(), req); return; }
    if (await serveStatic(req, res, pathname)) return;
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

  const ipOpen = pathname === '/api/health' || pathname === '/api/meta'
    || pathname === '/api/login' || pathname === '/api/register' || pathname === '/api/recover';
  if (!ipOpen) {
    const ipBan = enforcement.ipBanFor(clientIp(req));
    if (ipBan) {
      const e = fail('FORBIDDEN', '此网络因关联账号违规已被封禁。解封请加 QQ 群 ' + enforcement.QQ_GROUP + ' 联系群主。');
      e.extra = enforcement.banExtra(ipBan);
      throw e;
    }
  }

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
    if (Number(session.account.banned)) {
      const e = fail('FORBIDDEN', '账号已被封禁：' + (session.account.ban_reason || '违规'));
      e.extra = enforcement.banExtra({ status: 'banned', reason: session.account.ban_reason || '违规' });
      throw e;
    }
    if (req.method === 'GET') rateLimit('read:' + session.account.id, 300, 60000);
  }

  // 赛区名次是纯展示数据：同一请求里 profile / 领奖 / 榜单会重复算整赛区。
  // 每个 API 请求开头清一次，跨请求仍拿最新库（测试/运维直接改 ratings 也不会读到旧名次）。
  settlement.invalidateDivisionRows();
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
  // 抽奖单价以服务端 config 为唯一真值；客户端只从 /api/meta 读取展示，不能本地改价。
  if (globalThis.GData) globalThis.GData.LOTTERY_PRICE = config.lotteryPrice;
  db.open();

  try {
    const levelReward = require('./game/level-reward');
    const grant = levelReward.backfill();
    if (!grant.skipped) {
      console.log('[level-reward] 差额补偿邮件：' + grant.recipients + ' 人 / ' + grant.bottles + ' 瓶');
    }
  } catch (e) { console.error('[level-reward] 差额补偿邮件失败：' + ((e && e.message) || e)); }

  try {
    const apprentice = require('./game/apprentice');
    const added = apprentice.backfillFriendships();
    if (added) console.log('[apprentice] 师徒好友补齐：' + added + ' 对');
  } catch (e) { console.error('[apprentice] 师徒好友补齐失败：' + ((e && e.message) || e)); }

  try { require('./game/forum').bootstrap(); } catch (e) { console.error('[forum] init failed', e && e.message); }

  try {
    const settle = require('./game/settlement');
    settle.weekTick();
    settle.ensureBots();
  } catch (e) { console.error('[rank] week init failed', e && e.message); }

  const maintenance = require('./game/maintenance');
  maintenance.startScheduler();
  enforcement.startScheduler();

  const backup = require('./game/backup');
  backup.startScheduler();
  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    if (config.logRequests) {
      // 只记方法/路径/状态/耗时 —— 不记令牌、不记请求体。排查「客户端到底连没连上」用。
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
  server.on('close', () => { maintenance.stopScheduler(); backup.stopScheduler(); enforcement.stopScheduler(); });
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
