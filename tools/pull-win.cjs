#!/usr/bin/env node
'use strict';
// tools/pull-win.cjs — 从 Windows peer agent 拉取联机版源码；只用于开发机，不进客户端包。
// 地址/口令取 ~/.peer/config.json 的 hosts 与 token；用法见 --help。

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.peer', 'state');
const TRASH_DIR = path.join(HOME, '.peer', 'trash', 'win-pull');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const USAGE = `用法：node tools/pull-win.cjs [--dry] [--delete] [--verbose]

  --host <名字>    ~/.peer/config.json 里的主机名，默认 win
  --base <URL>     直接给 peer agent 地址（默认读配置的 hosts + port）
  --token <口令>   直接给 x-peer-token（默认读配置 / PEER_TOKEN）
  --remote <路径>  对端仓库根，默认 E:\\Squirrel_Fight_Online
  --local <目录>   本机仓库根，默认本脚本的上一级
  --delete         把「对端没有、本机却有」的文件移进 ~/.peer/trash（默认只报告）
  --no-hash        同尺寸文件不比对 sha1，直接覆盖（更快，慎用）
  --force          本机文件比对端新、内容又不同也覆盖（默认保留并提示）

覆盖前旧文件备份到 ~/.peer/trash/win-pull/<时间>/；构建产物、凭据、存档永远不拉。`;
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const DRY = flag('--dry');
const VERBOSE = flag('--verbose');
const DELETE = flag('--delete');
const NO_HASH = flag('--no-hash');
const FORCE_OVERWRITE = flag('--force');
const HOST = opt('--host', 'win');
const REMOTE = String(opt('--remote', 'E:\\Squirrel_Fight_Online')).replace(/[\\/]+$/, '');
const LOCAL = path.resolve(opt('--local', ROOT));

/* 这些路径永远不同步：本机凭据、构建产物、存档、参考素材。.gitignore 已经挡了大部分，
 * 这里再挡一层，避免对端 .gitignore 改坏 / 缺失时把签名或 8 GB target 拉过来。 */
const BUILTIN = [
  /^\.git\//, /(^|\/)node_modules\//, /^out\//, /^reference\//, /^references\//, /^save\//,
  /^src-tauri\/(target|gen|web|dist|keys)\//, /^src-tauri\/10月20日企业证书\//,
  /^src-tauri\/web-stamp\.json$/, /^--shot-file$/, /^squirrel_fight_online.*\.exe$/,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/, /(^|\/)\.peer-tmp-/,
  /^scripts\/sync\/sync\.config\.json$/, /\.local\.json$/, /\.(p12|mobileprovision)$/,
];
/* .gitignore 把 icons/、package-lock 当生成物；出包要用现成图标与同版本锁文件，显式拉。 */
const FORCE = [/^src-tauri\/icons(\/|$)/, /^src-tauri\/package-lock\.json$/];

function say(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function sha1(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

function loadPeerConfig() {
  const candidates = [];
  if (process.env.PEER_CONFIG) candidates.push(process.env.PEER_CONFIG);
  candidates.push(path.join(HOME, '.peer', 'config.json'));
  let cfg = {};
  for (const f of candidates) {
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (e) {}
  }
  return cfg;
}
const cfg = loadPeerConfig();
const token = String(opt('--token', process.env.PEER_TOKEN || cfg.token || ''));
const port = Number(cfg.port) || 19788;
const hostValue = cfg.hosts && cfg.hosts[HOST];
const bases = [];
if (opt('--base')) bases.push(String(opt('--base')).replace(/\/+$/, ''));
else {
  for (const h of (Array.isArray(hostValue) ? hostValue : [hostValue])) {
    if (!h) continue;
    const v = String(h).trim();
    if (!v) continue;
    bases.push(/^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : 'http://' + v + ':' + port);
  }
}
if (!bases.length) fail('没有找到对端地址：在 ~/.peer/config.json 配 hosts.' + HOST + '，或传 --base http://<ip>:' + port);
if (!token) fail('没有 peer 口令：在 ~/.peer/config.json 配 token，或用 --token / PEER_TOKEN 传');

function request(base, rel, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + rel);
    const mod = u.protocol === 'https:' ? require('node:https') : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'x-peer-token': token, accept: '*/*' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeout || 60000, () => req.destroy(new Error('请求超时：' + rel)));
    req.on('error', reject);
    req.end();
  });
}
async function call(rel, timeout) {
  let lastErr;
  for (const base of bases) {
    try {
      const r = await request(base, rel, timeout);
      if (r.status >= 400) {
        let msg = r.body.toString('utf8').slice(0, 300);
        try { msg = JSON.parse(msg).msg || msg; } catch (e) {}
        throw new Error('HTTP ' + r.status + '：' + msg);
      }
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function json(rel, timeout) {
  const r = await call(rel, timeout);
  try { return JSON.parse(r.body.toString('utf8')); } catch (e) { throw new Error('对端返回不是 JSON：' + rel); }
}
function q(p) { return encodeURIComponent(p); }
function remotePath(rel) { return REMOTE + '\\' + rel.replace(/\//g, '\\'); }

/* ---------------- .gitignore ---------------- */
function globRegex(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function parseGitignore(text) {
  const rules = [];
  for (let raw of String(text || '').split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    raw = raw.replace(/\s+$/, '');
    if (!raw) continue;
    let negate = false;
    if (raw.startsWith('!')) { negate = true; raw = raw.slice(1); }
    if (raw.startsWith('\\')) raw = raw.slice(1);
    const dirOnly = raw.endsWith('/');
    raw = raw.replace(/\/+$/, '');
    const anchored = raw.startsWith('/') || raw.includes('/');
    raw = raw.replace(/^\/+/, '');
    if (!raw) continue;
    rules.push({ negate, dirOnly, anchored, re: globRegex(raw) });
  }
  return rules;
}
function gitIgnored(rules, rel) {
  const segs = rel.split('/');
  let ignored = false;
  for (const rule of rules) {
    let hit = false;
    if (rule.anchored) {
      for (let i = 1; i <= segs.length; i++) {
        if (rule.re.test(segs.slice(0, i).join('/'))) { hit = true; break; }
      }
    } else {
      for (const s of segs) { if (rule.re.test(s)) { hit = true; break; } }
    }
    if (hit) ignored = !rule.negate;
  }
  return ignored;
}
function forced(rel) { return FORCE.some((r) => r.test(rel)); }
function neverSync(rel) {
  if (forced(rel)) return false;
  return BUILTIN.some((r) => r.test(rel));
}
function skipRemote(rel, rules) {
  return neverSync(rel) || (!forced(rel) && gitIgnored(rules, rel));
}

/* ---------------- state ---------------- */
const stateFile = path.join(STATE_DIR, 'win-pull-' + sha1(REMOTE + '|' + LOCAL).slice(0, 12) + '.json');
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && s.v === 1 && s.remote === REMOTE && s.local === LOCAL && s.files) return s;
  } catch (e) {}
  return { v: 1, remote: REMOTE, local: LOCAL, files: {} };
}
function saveState(state) {
  if (DRY) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
}

async function hashLocal(file) {
  const h = crypto.createHash('sha1');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on('data', (b) => h.update(b));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return h.digest('hex');
}
async function hashRemote(rel) {
  const r = await json('/api/fs/hash?path=' + q(remotePath(rel)), 60000);
  return String(r.sha1 || '');
}

async function pool(items, limit, worker) {
  let i = 0; const out = new Array(items.length);
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const at = i++;
      if (at >= items.length) return;
      out[at] = await worker(items[at], at);
    }
  });
  await Promise.all(runners);
  return out;
}

function backup(localAbs, rel, stamp) {
  if (DRY) return;
  const dest = path.join(TRASH_DIR, stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(localAbs, dest);
}

async function main() {
  say('peer  : ' + bases[0] + (bases.length > 1 ? '（备用 ' + (bases.length - 1) + ' 个）' : ''));
  const ping = await json('/api/ping', 8000);
  say('对端  : ' + (ping.host || ping.name || '?') + ' / ' + (ping.platform || '?') + ' / peer-agent ' + (ping.v || '?'));
  say('远端  : ' + REMOTE);
  say('本机  : ' + LOCAL);
  if (DRY) say('模式  : dry-run（不写任何文件）');

  const tree = await json('/api/fs/tree?path=' + q(REMOTE) + '&max=300000', 120000);
  if (!tree || !Array.isArray(tree.entries)) throw new Error('对端没有返回 entries');
  let ignoreRules = [];
  try {
    const gi = await call('/api/fs/get?path=' + q(REMOTE + '\\.gitignore'), 15000);
    ignoreRules = parseGitignore(gi.body.toString('utf8'));
  } catch (e) {
    say('提示  : 对端没有 .gitignore，只用内置忽略清单');
  }
  const remote = new Map();
  for (const e of tree.entries) {
    if (e.t !== 'f') continue;
    const rel = String(e.p || '').replace(/\\/g, '/');
    if (!rel || skipRemote(rel, ignoreRules)) continue;
    remote.set(rel, { size: Number(e.s) || 0, mtime: Number(e.m) || 0 });
  }

  const state = loadState();
  const next = { v: 1, remote: REMOTE, local: LOCAL, files: {} };
  const actions = [];
  const localOnly = [];
  let same = 0;

  const localFiles = new Map();
  async function walk(dir, rel) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (skipRemote(r, ignoreRules)) continue;
      const full = path.join(dir, ent.name);
      let st;
      try { st = await fsp.lstat(full); } catch (e) { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(full, r);
      else if (st.isFile()) localFiles.set(r, { size: st.size, mtime: Math.round(st.mtimeMs) });
    }
  }
  await walk(LOCAL, '');
  for (const rel of localFiles.keys()) if (!remote.has(rel)) localOnly.push(rel);

  for (const [rel, r] of remote) {
    const l = localFiles.get(rel);
    const prev = state.files[rel];
    if (!l) { actions.push({ rel, act: 'new', r }); continue; }
    if (l.size !== r.size) {
      if (l.mtime > r.mtime + 2000 && !FORCE_OVERWRITE) actions.push({ rel, act: 'diverged', r, l });
      else actions.push({ rel, act: 'update', r });
      continue;
    }
    if (prev && prev.rs === r.size && prev.rm === r.mtime && prev.ls === l.size && prev.lm === l.mtime) {
      same++;
      next.files[rel] = prev;
      continue;
    }
    if (Math.abs(l.mtime - r.mtime) <= 2000) {
      same++;
      next.files[rel] = { rs: r.size, rm: r.mtime, ls: l.size, lm: l.mtime };
      continue;
    }
    if (NO_HASH) { actions.push({ rel, act: 'update', r }); continue; }
    actions.push({ rel, act: 'maybe', r, l, prev });
  }

  const maybe = actions.filter((a) => a.act === 'maybe');
  if (maybe.length) {
    say('校验  : ' + maybe.length + ' 个同尺寸文件按 sha1 比对…');
    await pool(maybe, 8, async (a) => {
      try {
        const [lh, rh] = await Promise.all([hashLocal(path.join(LOCAL, a.rel)), hashRemote(a.rel)]);
        if (lh === rh) {
          a.act = 'same';
          next.files[a.rel] = { rs: a.r.size, rm: a.r.mtime, ls: a.l.size, lm: a.l.mtime, h: lh };
        } else if (a.l.mtime > a.r.mtime + 2000 && !FORCE_OVERWRITE) {
          a.act = 'diverged';
        } else {
          a.act = 'update';
        }
      } catch (e) {
        a.act = 'update';
        a.why = e.message;
      }
    });
  }
  for (const a of actions) if (a.act === 'same') same++;

  const todo = actions.filter((a) => a.act === 'new' || a.act === 'update');
  const diverged = actions.filter((a) => a.act === 'diverged');
  const bytes = todo.reduce((n, a) => n + (a.r.size || 0), 0);
  say('对比  : 新增 ' + todo.filter((a) => a.act === 'new').length + ' / 更新 ' +
    todo.filter((a) => a.act === 'update').length + ' / 相同 ' + same +
    ' / 仅本机 ' + localOnly.length + ' / 本机较新 ' + diverged.length);
  if (todo.length) say('传输  : ' + fmtBytes(bytes));
  if (VERBOSE) {
    for (const a of todo) say('  ' + (a.act === 'new' ? '+ ' : '~ ') + a.rel + '  ' + fmtBytes(a.r.size));
    for (const a of diverged) say('  ! ' + a.rel + '（本机较新，保留；--force 覆盖）');
    for (const rel of localOnly) say('  - ' + rel + '（仅本机）');
  }

  if (DRY) {
    say('dry-run 结束：没有写文件。去掉 --dry 才会真正拉取。');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  let added = 0;
  let updated = 0;
  let failed = 0;
  let moved = 0;
  await pool(todo, 6, async (a) => {
    const localAbs = path.join(LOCAL, a.rel.split('/').join(path.sep));
    const tmp = localAbs + '.peer-pull-' + process.pid + '-' + Math.random().toString(16).slice(2);
    try {
      const r = await call('/api/fs/get?path=' + q(remotePath(a.rel)), 120000);
      if (r.body.length !== a.r.size) throw new Error('大小不符：' + r.body.length + ' != ' + a.r.size);
      if (fs.existsSync(localAbs)) backup(localAbs, a.rel, stamp);
      fs.mkdirSync(path.dirname(localAbs), { recursive: true });
      fs.writeFileSync(tmp, r.body);
      fs.renameSync(tmp, localAbs);
      const mt = Number(r.headers['x-mtime']) || a.r.mtime;
      if (mt > 0) { try { fs.utimesSync(localAbs, mt / 1000, mt / 1000); } catch (e) {} }
      if (/\.(command|sh)$/.test(a.rel)) { try { fs.chmodSync(localAbs, 0o755); } catch (e) {} }
      next.files[a.rel] = { rs: a.r.size, rm: mt, ls: r.body.length, lm: mt };
      if (a.act === 'new') added++; else updated++;
      if (!VERBOSE) process.stdout.write('\r拉取 ' + (added + updated) + '/' + todo.length + ' ' + a.rel.slice(0, 60).padEnd(60));
    } catch (e) {
      failed++;
      try { fs.rmSync(tmp, { force: true }); } catch (x) {}
      say('\n失败  : ' + a.rel + '：' + e.message);
    }
  });
  if (todo.length) process.stdout.write('\r' + ' '.repeat(90) + '\r');

  if (DELETE) {
    const trash = path.join(TRASH_DIR, stamp, '_local-only');
    for (const rel of localOnly) {
      const full = path.join(LOCAL, rel.split('/').join(path.sep));
      try {
        const dest = path.join(trash, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(full, dest);
        moved++;
      } catch (e) { say('删除失败: ' + rel + '：' + e.message); }
    }
  }

  saveState(next);
  say('完成  : 新增 ' + added + ' / 更新 ' + updated + ' / 相同 ' + same +
    ' / 失败 ' + failed + (DELETE ? ' / 移除本机多余 ' + moved : '') +
    (todo.length ? ' / ' + fmtBytes(bytes) : ''));
  if (localOnly.length && !DELETE) say('提示  : ' + localOnly.length + ' 个文件仅本机存在（未删除，见 --verbose 或 --delete）');
  if (diverged.length) say('提示  : ' + diverged.length + ' 个文件本机比对端新，已保留；确认以对端为准后加 --force 覆盖');
  if (updated + added) say('备份  : ' + path.join(TRASH_DIR, stamp));
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('拉取失败：' + (e && e.message || e));
  process.exit(1);
});
