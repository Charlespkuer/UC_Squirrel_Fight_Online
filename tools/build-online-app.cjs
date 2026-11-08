#!/usr/bin/env node
'use strict';
// Independent Online client builds. Never read server/, save/, or the offline target.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const TAURI = path.join(ROOT, 'src-tauri');
const WEB = path.join(TAURI, 'web');
const TARGET = path.join(TAURI, 'target');
const args = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8')).version;
const apiFlag = args.indexOf('--api');
const base = String(apiFlag >= 0 ? args[apiFlag + 1] : process.env.SSDZ_ONLINE_API ||
  JSON.parse(fs.readFileSync(path.join(TAURI, 'online-api.json'), 'utf8')).base).replace(/\/+$/, '');
const api = new URL(base);
if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash)
  throw new Error('API must be a public http(s) base URL without credentials, query, or fragment');

const allowed = ['js', 'css', 'audio', 'images', 'shared'];
const excluded = /(?:^|\/)(?:_reference|references|\.bak-upscale|node_modules|\.git|out)(?:\/|$)|(?:\.bak|\.log|\.sqlite(?:-wal|-shm)?|\.db|\.local\.json|\.p12|\.mobileprovision)$/i;
/* 联机版只有经典界面：单机版的现代界面素材与只服务现代模式的脚本**不进联机包**
 * （仓库里仍保留给 `scripts/index.html` 单机网页版与 GitHub Pages 用）。
 *   · images/ui/screens —— 现代首页底图 / 加载图 / 战果图 / 新手提示等屏幕图；
 *   · images/battle/bg —— 现代 canvas 战斗的场地背景（经典战斗用 ssfight 元件）；
 *   · js/battle.js —— 现代 canvas 战斗；联机战斗一律走 SfFight；
 *   · js/debug.js / css/debug.css / js/tauri-bridge.js —— 单机页面才加载。
 * 这些路径同时参与 `--web` 快照的指纹，删/加要一起改。 */
const ONLINE_EXCLUDED_FILES = new Set(['js/battle.js', 'js/debug.js', 'js/tauri-bridge.js', 'css/debug.css']);
const ONLINE_EXCLUDED_DIRS = ['images/ui/screens/', 'images/battle/bg/'];
function onlineExcluded(name) {
  if (ONLINE_EXCLUDED_FILES.has(name)) return true;
  return ONLINE_EXCLUDED_DIRS.some((prefix) => name === prefix.slice(0, -1) || (name + '/').startsWith(prefix));
}
const sources = [];
function collect(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? rel + '/' + ent.name : ent.name;
    if (excluded.test(name) || onlineExcluded(name) || ent.name === 'AGENTS.md' || ent.name === 'AGENT.md') continue;
    if (ent.isSymbolicLink()) throw new Error('Refusing symlink in client assets: ' + name);
    if (ent.isDirectory()) collect(path.join(dir, ent.name), name);
    else if (ent.isFile()) sources.push(name);
  }
}
for (const dir of allowed) collect(path.join(ROOT, dir), dir);
sources.push('scripts/index-online.html');
if (fs.existsSync(path.join(ROOT, 'scripts', 'version.json'))) sources.push('scripts/version.json');
sources.sort();
/* 逐文件的 size + sha256 只算一次：既给快照指纹，也给下面的 `web-manifest.json`。
 * ⚠ 以前 `writeWebManifest()` 会把暂存目录再遍历、再读一遍（96 MB）算同样的哈希 ——
 *   同一份内容算两次，纯浪费；这里直接复用这次读到的 buffer。 */
const fileHashes = new Map();
function fingerprint() {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  hash.update(base); hash.update(version); hash.update(fs.readFileSync(__filename));
  for (const rel of sources) {
    const buffer = fs.readFileSync(path.join(ROOT, rel));
    hash.update(rel); hash.update(buffer); bytes += buffer.length;
    fileHashes.set(rel, { size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
  }
  return { hash: hash.digest('hex'), files: sources.length, bytes, api: base };
}
const stamp = fingerprint();
/** 客户端文件清单：给服务器主人的「将要同步哪些内容」预览用。
 *  - 写进 `src-tauri/web/web-manifest.json`（客户端自带，可选）；
 *  - 同一份写进 `server/web-manifest.json`（随服务端包部署，作为当前版本清单）。
 *  清单只做路径 / 大小 / sha256，不写时间戳，内容不变时完全一致。
 *  数据来自 `fingerprint()` 已读过的 buffer；只有两个生成文件要现算。 */
function writeWebManifest(entryText, configText) {
  const files = [];
  for (const rel of sources) {
    if (rel === 'scripts/index-online.html') continue; // 最终入口是注入过 online-config.js 的 index.html
    const meta = fileHashes.get(rel);
    if (meta) files.push({ path: rel, size: meta.size, sha256: meta.sha256 });
  }
  const addText = (rel, text) => {
    const buf = Buffer.from(text, 'utf8');
    files.push({ path: rel, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  };
  addText('index.html', entryText);
  addText('online-config.js', configText);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const text = JSON.stringify({ version, files });
  fs.writeFileSync(path.join(WEB, 'web-manifest.json'), text);
  fs.writeFileSync(path.join(ROOT, 'server', 'web-manifest.json'), text);
  console.log('Online manifest: ' + files.length + ' files');
  return files.length;
}
if (args.includes('--check')) {
  const old = JSON.parse(fs.readFileSync(path.join(TAURI, 'web-stamp.json'), 'utf8'));
  if (old.hash !== stamp.hash || !fs.existsSync(path.join(WEB, 'index.html')))
    throw new Error('Online frontend snapshot is stale; rebuild before packaging');
  const manifestFile = path.join(WEB, 'web-manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('Online manifest is missing; rebuild before packaging');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('Online manifest does not match tauri.conf version; rebuild before packaging');
  console.log('Online client snapshot verified: ' + stamp.files + ' files, manifest ' + manifest.files.length);
  process.exit(0);
}
// WEB is a fixed child of this Online repo, never a path supplied by a caller.
if (path.dirname(WEB) !== TAURI) throw new Error('Invalid staging directory');
fs.rmSync(WEB, { recursive: true, force: true, maxRetries: 5 });
fs.mkdirSync(WEB, { recursive: true });
for (const rel of sources) {
  const dest = path.join(WEB, rel === 'scripts/index-online.html' ? 'index.html' : rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}
const entry = path.join(WEB, 'index.html');
const entryText = fs.readFileSync(entry, 'utf8').replace('<head>',
  '<head>\n<script src="online-config.js"></script>');
fs.writeFileSync(entry, entryText);
/* 降级地址：安装包默认写 https，但**云防火墙可能只放行 80**（本机实测 443 不可达）。
 * 客户端启动时并行探 `__SSDZ_ONLINE_API__` 与这里的候选，谁先答应用谁；
 * 等 443 放行后，同一份安装包会自动回到 https，不用重新打包。 */
const fallbacks = [];
(function deriveFallbacks() {
  const host = api.hostname, port = api.port;
  if (!port) fallbacks.push((api.protocol === 'https:' ? 'http://' : 'https://') + host);
  if (port === '443') fallbacks.push('http://' + host);
  if (port === '80') fallbacks.push('https://' + host);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(TAURI, 'online-api.json'), 'utf8'));
    if (Array.isArray(cfg.fallbacks)) {
      for (const f of cfg.fallbacks) {
        try { fallbacks.push(String(new URL(String(f)).href).replace(/\/+$/, '')); } catch (_) {}
      }
    }
  } catch (_) {}
})();
const uniqueFallbacks = [...new Set(fallbacks.map((u) => u.replace(/\/+$/, '')))].filter((u) => u !== base);
const configText =
  'window.__SSDZ_ONLINE_API__ = ' + JSON.stringify(base) + ';\n' +
  'window.__SSDZ_ONLINE_API_FALLBACKS__ = ' + JSON.stringify(uniqueFallbacks) + ';\n' +
  'window.__SSDZ_VERSION = ' + JSON.stringify(version) + ';\n';
fs.writeFileSync(path.join(WEB, 'online-config.js'), configText);
writeWebManifest(entryText, configText);
fs.writeFileSync(path.join(TAURI, 'web-stamp.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log('Online staged: ' + stamp.files + ' files, ' + (stamp.bytes / 1048576).toFixed(1) + ' MiB; API ' + base +
  (uniqueFallbacks.length ? ' (fallback: ' + uniqueFallbacks.join(', ') + ')' : ''));
if (args.includes('--web')) process.exit(0);
if (process.platform !== 'win32') throw new Error('Use --web on this platform, then the native platform builder');
const cargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
const env = { ...process.env, CARGO_TARGET_DIR: TARGET, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
  PATH: path.dirname(cargo) + path.delimiter + process.env.PATH };
if (!fs.existsSync(path.join(TAURI, 'icons', 'icon.ico'))) {
  const cli = path.join(TAURI, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!fs.existsSync(cli)) throw new Error('Install native build dependencies: cd src-tauri && npm install');
  const icon = spawnSync(process.execPath, [cli, 'icon', 'app-icon.png'], { cwd: TAURI, env, stdio: 'inherit' });
  if (icon.error || icon.status !== 0) throw icon.error || new Error('Online icon generation failed');
}
const result = spawnSync(cargo, ['build', '--release', '--features', 'custom-protocol'], { cwd: TAURI, env, stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error || new Error('Online Cargo build failed: ' + result.status);
/* 不再编译完再 spawn 一次 `--check`：那会把同一份 96 MB 源码再读一遍、再算一遍指纹，
 * 纯粹重复验证。要单独检查已有快照时手动跑 `node tools/build-online-app.cjs --check`（一次）。 */
const exe = path.join(TARGET, 'release', 'squirrel_fight_online.exe');
if (!fs.existsSync(exe)) throw new Error('Expected Online EXE was not generated');
fs.copyFileSync(exe, path.join(ROOT, 'squirrel_fight_online.exe'));
const dist = path.join(TAURI, 'dist'); fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(exe, path.join(dist, 'squirrel_fight_online.exe'));
console.log('Online EXE ready: ' + path.join(ROOT, 'squirrel_fight_online.exe'));
