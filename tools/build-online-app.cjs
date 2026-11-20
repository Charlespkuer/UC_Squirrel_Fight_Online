#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/build-online-app.cjs — 联机版客户端出包
 * ------------------------------------------------------------
 * 两种产物，共用同一份源码：
 *   ① 轻壳（开发机，根目录 `squirrel_fight_online.exe`，约 3~5 MB）
 *         node tools/build-online-app.cjs --shell
 *      不带前端快照：启动时由 `src-tauri/src/shell.rs` 从仓库目录读 js/css/images，
 *      所以改代码不用重新打包，刷新窗口（F5）或重开一次就是新的。
 *   ② 完整包（给玩家 / 发布，`src-tauri/dist/squirrel_fight_online.exe`，约 67 MB）
 *         node tools/build-online-app.cjs
 *      前端快照 + 清单编进 exe，裸机可跑。**不再覆盖根目录那份轻壳。**
 *
 * 其它参数：
 *   `--web`    只生成前端快照 + 清单（完整包 / APK / iOS 的前置），不编译
 *   `--check`  只校验已有快照与清单，不编译
 *   `--stage`  轻壳出成 `squirrel_fight_online.new.exe`（给设置页「一键打包并重启」用）
 *   `--api`    改服务器地址（默认取 `src-tauri/online-api.json`）
 *
 * ⚠ 两个产物靠 **cargo feature + TAURI_CONFIG** 区分，源码树里不存两份：
 *   · 轻壳 = `--features custom-protocol,thin-shell` + `TAURI_CONFIG` 把 frontendDist 指向
 *     `empty/`（几百字节的「没找到游戏目录」提示页）；
 *   · 完整包 = `--features custom-protocol`，frontendDist 仍是 `tauri.conf.json` 里的 `web/`。
 *   `TAURI_CONFIG` 是 tauri-build / tauri-codegen 都认的官方覆盖方式（`tauri build --config`
 *   就是把它塞进环境变量），所以 `cargo build` 也能拿到同一份合并后的配置。
 * ============================================================ */
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
const has = (name) => args.includes(name);
/* `--stage` 只服务「一键打包并重启」：那条路换的就是根目录的轻壳，所以它也走轻壳构建。 */
const shell = has('--shell') || has('--stage');
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
 *   · js/debug.js / css/debug.css / js/tauri-bridge.js —— 单机页面才加载；
 *   · images/ssfight/ui/tags-fight.json —— 生成器 / 测试保留的整包，运行时用 core + 动作包。
 * 这些路径同时参与 `--web` 快照的指纹，删/加要一起改。
 * ⚠ 轻壳的**文件白名单**在 `src-tauri/src/shell.rs`（ALLOWED_DIRS / ALLOWED_FILES），
 *   与这里的 `allowed` 是同一套口径 —— 改一边就要改另一边。 */
const ONLINE_EXCLUDED_FILES = new Set(['js/battle.js', 'js/debug.js', 'js/tauri-bridge.js', 'css/debug.css',
  'images/ssfight/ui/tags-fight.json']);
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
  /* `build` = 整份前端快照的指纹（`fingerprint()` 已经算过）。版本号可以不变，
   * 但只要有文件变了 build 就变 —— 开发者同步靠它识别「同版本的代码改动」。 */
  const text = JSON.stringify({ version, build: stamp.hash, files });
  fs.writeFileSync(path.join(WEB, 'web-manifest.json'), text);
  fs.writeFileSync(path.join(ROOT, 'server', 'web-manifest.json'), text);
  console.log('Online manifest: ' + files.length + ' files');
  return files.length;
}
let stamp = null;
/** 生成 `src-tauri/web` 前端快照 + 清单 + 指纹（完整包 / APK / iOS 的前置）。 */
function stageWeb() {
  stamp = fingerprint();
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
   * 等 443 放行后，同一份安装包会自动回到 https，不用重新打包。
   * ⚠ 轻壳没有构建步骤，同样的推导在 `src-tauri/src/shell.rs` 的 `derived_fallbacks()` 里
   *   又写了一份 —— 改规则时两边一起改（改动很少，只为省掉「轻壳也要先构建」）。 */
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
}
if (has('--check')) {
  stamp = fingerprint();
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
/* 轻壳不碰前端快照：不复制、不算 96 MB 指纹 —— 这条路径要的就是「几秒出包」。
 * （显式 `--web` 仍然照做，它就是要快照。） */
if (!shell || has('--web')) stageWeb();
if (has('--web')) process.exit(0);
if (process.platform !== 'win32') throw new Error('Use --web on this platform, then the native platform builder');
const cargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
const env = { ...process.env, CARGO_TARGET_DIR: TARGET, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
  PATH: path.dirname(cargo) + path.delimiter + process.env.PATH };
if (shell) env.TAURI_CONFIG = JSON.stringify({ build: { frontendDist: 'empty' } });
else delete env.TAURI_CONFIG;
if (!fs.existsSync(path.join(TAURI, 'icons', 'icon.ico'))) {
  const cli = path.join(TAURI, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!fs.existsSync(cli)) throw new Error('Install native build dependencies: cd src-tauri && npm install');
  const icon = spawnSync(process.execPath, [cli, 'icon', 'app-icon.png'], { cwd: TAURI, env, stdio: 'inherit' });
  if (icon.error || icon.status !== 0) throw icon.error || new Error('Online icon generation failed');
}
/* 两个产物靠 feature 分开编（cargo 按 feature 集分别缓存），配置差在 TAURI_CONFIG：
 * 轻壳 `thin-shell` + frontendDist=empty；完整包不带 feature，frontendDist=web。 */
const featureSet = shell ? 'custom-protocol,thin-shell' : 'custom-protocol';
const result = spawnSync(cargo, ['build', '--release', '--features', featureSet], { cwd: TAURI, env, stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error || new Error('Online Cargo build failed: ' + result.status);
/* 不再编译完再 spawn 一次 `--check`：那会把同一份 96 MB 源码再读一遍、再算一遍指纹，
 * 纯粹重复验证。要单独检查已有快照时手动跑 `node tools/build-online-app.cjs --check`（一次）。 */
const exe = path.join(TARGET, 'release', 'squirrel_fight_online.exe');
if (!fs.existsSync(exe)) throw new Error('Expected Online EXE was not generated');

if (shell) {
  /* `--stage`：给设置页「开发者同步 → 一键打包并重启」用（`tools/rebuild-online-client.cjs`）。
   * 那时旧客户端还占着根目录的 exe，不能在这里覆盖；新包先落成 `.new.exe`，等客户端退出后
   * 由重建脚本改名替换。 */
  if (args.includes('--stage')) {
    const staged = path.join(ROOT, 'squirrel_fight_online.new.exe');
    try { fs.rmSync(staged, { force: true }); } catch (_) {}
    fs.copyFileSync(exe, staged);
    console.log('Online shell staged: ' + staged);
    process.exit(0);
  }
  const root = path.join(ROOT, 'squirrel_fight_online.exe');
  try {
    fs.copyFileSync(exe, root);
  } catch (e) {
    /* 双击打开的轻壳正占着这个文件。别只甩一个 EBUSY，直接告诉开发者两条路。 */
    throw new Error('写不进 ' + root + '（多半是这个轻壳正在运行）：先关掉游戏再出包，' +
      '或者用游戏里 设置 →「一键打包并重启」——它会等进程退出后自己替换。原始错误：' + e.message);
  }
  console.log('Online shell ready: ' + root +
    '（读仓库里的 js/css/images，改完刷新窗口即可；完整包走不带参数的出包）');
  process.exit(0);
}

const dist = path.join(TAURI, 'dist'); fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(exe, path.join(dist, 'squirrel_fight_online.exe'));
/* 发布物保留：只留当前版本（EXE + 两个 APK + 两个 IPA），见 tools/prune-dist.cjs。 */
try { require('./prune-dist.cjs').prune({ keep: 1 }); } catch (e) { console.warn('[prune-dist] ' + (e && e.message)); }
console.log('Online package ready: ' + path.join(dist, 'squirrel_fight_online.exe') +
  '（自带前端，给玩家 / 发布用；根目录的轻壳没有被动过）');
