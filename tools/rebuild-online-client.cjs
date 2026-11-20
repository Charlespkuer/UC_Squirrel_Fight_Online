#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/rebuild-online-client.cjs — 开发机「一键打包并重启」的执行体
 * ------------------------------------------------------------
 * 由设置 → 开发者同步 → 「一键打包并重启」（Tauri 命令 `online_dev_rebuild`）拉起；
 * 也可以手动跑：
 *     node tools/rebuild-online-client.cjs --target <正在运行的 exe>
 *
 *   1. `node tools/build-online-app.cjs --stage`：编译**轻壳** EXE（页面从仓库磁盘读，
 *      不再重打前端快照），新包先落 `squirrel_fight_online.new.exe`（**不动**正在运行的 exe）；
 *   2. 等旧客户端让出文件（调用方拉起本脚本后会主动退出）；
 *   3. 旧 exe 改名 `.old.exe` → 新 exe 复制回原路径 → 从临时目录重新启动。
 *      任何一步失败都保留旧客户端，打印原因并停住窗口。
 *
 * 参数：
 *   `--target <exe>` 要替换的客户端；省略 = 仓库根 `squirrel_fight_online.exe`
 *   `--skip-build`   复用已有的 `.new.exe`（构建过、只想替换/重启时）
 *   `--no-launch`    只替换、不启动（检查产物时用）
 * ============================================================ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
function valueOf(name) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !String(argv[at + 1]).startsWith('--') ? String(argv[at + 1]) : '';
}
const targetArg = valueOf('--target') || argv.find((arg) => !arg.startsWith('--')) || '';
const target = path.resolve(targetArg || path.join(ROOT, 'squirrel_fight_online.exe'));
const staged = path.join(ROOT, 'squirrel_fight_online.new.exe');
const old = path.join(path.dirname(target), 'squirrel_fight_online.old.exe');

const say = (msg) => console.log('[SSDZ] ' + msg);
/* 主线程等一会儿：只在这台开发机的小工具里用，不引第三方依赖。 */
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/* 失败时把窗口停住：由游戏拉起时控制台会一闪而过，不按住就看不到原因。 */
function pause() {
  try { spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'pause'], { stdio: 'inherit' }); } catch (_) {}
}
function fail(msg) {
  console.error('\n[SSDZ] 打包/替换失败：' + msg);
  pause();
  process.exit(1);
}
function remove(file) { try { fs.rmSync(file, { force: true }); } catch (_) {} }

if (!fs.existsSync(path.dirname(target))) fail('找不到客户端目录：' + path.dirname(target));
say('目标客户端：' + target);

if (!has('--skip-build')) {
  say('重新编译轻壳客户端，通常需要 10~60 秒…');
  const built = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-online-app.cjs'), '--stage'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (built.error) fail('无法启动 build-online-app.cjs：' + built.error.message);
  if (built.status !== 0) fail('构建失败（退出码 ' + built.status + '），旧客户端没有替换。');
}
if (!fs.existsSync(staged)) fail('没有找到新包：' + staged + '（先跑一次不带 --skip-build 的构建）');

/* Windows 允许重命名正在运行的 exe，所以先改名、再把新包复制到原路径；
 * 客户端已经退出时这一步是空等的 0 次。 */
remove(old);
let renamed = false;
let lastError = null;
for (let i = 0; i < 40; i++) {
  try {
    if (fs.existsSync(target)) fs.renameSync(target, old);
    renamed = true;
    break;
  } catch (e) {
    lastError = e;
    sleep(250);
  }
}
if (!renamed) fail('旧客户端仍被占用，无法替换（先完全关掉游戏再试）：' + (lastError && lastError.message));
try {
  fs.copyFileSync(staged, target);
} catch (e) {
  try { if (fs.existsSync(old) && !fs.existsSync(target)) fs.renameSync(old, target); } catch (_) {}
  fail('写入新客户端失败，旧客户端已恢复：' + e.message);
}
remove(staged);
remove(old);
say('已替换为最新构建。');

if (has('--no-launch')) {
  say('--no-launch：不启动客户端。');
  process.exit(0);
}
say('重新启动客户端…');
try {
  /* 从临时目录启动：别让游戏进程把仓库目录当工作目录（会让整个文件夹没法改名/移动）。 */
  const child = spawn(target, [], { cwd: os.tmpdir(), detached: true, stdio: 'ignore' });
  child.unref();
} catch (e) {
  fail('新客户端已就位，但自动启动失败，请手动打开：' + e.message);
}
say('完成。');
