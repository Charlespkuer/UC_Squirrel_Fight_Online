#!/usr/bin/env node
// tools/prune-dist.cjs — 本地发布物保留策略：**只留当前版本**
//
//   node tools/prune-dist.cjs            # 只保留 scripts/version.json 对应版本的包
//   node tools/prune-dist.cjs --dry      # 只列出计划
//   node tools/prune-dist.cjs --temp-age-min 30
//
// 规则（用户 2026-11-18 口径：pack 永远只保留最新版，旧包直接删）：
//   · 版本号以 `scripts/version.json` 为准；APK（arm64/x86_64 两个 ABI）与 IPA
//     （modern/legacy 两个变体）只留这一版，旧版本一律删除，不做归档。
//   · EXE：优先保留当前版本的带版本号文件；当前版本还没出 EXE 时保留最新一个
//     （出包脚本写的是不带版本号的 `squirrel_fight_online.exe`），其余删除。
//   · 当前版本一个 IPA 都没有时（本次不发 iOS），保留最新一版 IPA，避免清空 iOS 包。
//   · `online-pending.*` / `online-aligned-unsigned.apk` 只在超过 `--temp-age-min`
//     （默认 60 分钟）未修改时删除，避免误删正在跑的出包中间文件。
//
// 由 `build-online-apk.cjs` / `build-online-app.cjs` 在出包成功后自动调用；
// 服务器 `/var/lib/ssdz/downloads` 的同类清理在 `server/deploy/ssdz-deploy.sh`。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'src-tauri', 'dist');
const APK_RE = /^squirrel_fight_online-(\d+(?:\.\d+)*)-([A-Za-z0-9_]+)\.apk(\.idsig)?$/;
const EXE_RE = /^squirrel_fight_online(?:-(\d+(?:\.\d+)*))?\.exe$/;
const IPA_RE = /^squirrel_fight_online[_-](\d+(?:\.\d+)*)_ios(?:_legacy)?_unsigned\.ipa$/;
const TEMP_RE = /^(?:online-pending\.apk(?:\.idsig)?|online-aligned-unsigned\.apk)$/;

function projectVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'version.json'), 'utf8')).version || '');
  } catch (_) { return ''; }
}
function parseVersion(text) {
  return text ? text.split('.').map(Number) : null;
}
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
function artifact(name) {
  let m = APK_RE.exec(name);
  if (m) return { kind: 'apk', version: parseVersion(m[1]), arch: m[2] };
  m = EXE_RE.exec(name);
  if (m) return { kind: 'exe', version: parseVersion(m[1]), versioned: !!m[1] };
  m = IPA_RE.exec(name);
  if (m) return { kind: 'ipa', version: parseVersion(m[1]) };
  return null;
}
function mtimeOf(name) {
  try { return fs.statSync(path.join(DIST, name)).mtimeMs; } catch (_) { return 0; }
}

function prune(opts = {}) {
  const tempAgeMin = Number.isFinite(opts.tempAgeMin) ? opts.tempAgeMin : 60;
  const dry = opts.dry === true;
  const result = { removed: [], keptVersion: '', apk: [], exe: '', ipa: [] };
  if (!fs.existsSync(DIST)) return result;

  const files = fs.readdirSync(DIST).filter((name) => {
    try { return fs.statSync(path.join(DIST, name)).isFile(); } catch (_) { return false; }
  });
  const parsed = files.map((name) => ({ name, info: artifact(name) })).filter((x) => x.info);
  const versions = [...new Set(parsed.filter((x) => x.info.version).map((x) => x.info.version.join('.')))]
    .sort((a, b) => cmpVersion(a.split('.').map(Number), b.split('.').map(Number)));

  const wanted = projectVersion();
  const target = wanted && parseVersion(wanted) ? wanted : (versions[versions.length - 1] || '');
  result.keptVersion = target;

  const doomed = [];
  for (const x of parsed) {
    const v = x.info.version ? x.info.version.join('.') : '';
    if (x.info.kind === 'apk') {
      if (v === target) result.apk.push(x.name);
      else doomed.push(x.name);
    } else if (x.info.kind === 'ipa') {
      if (v === target) { result.ipa.push(x.name); continue; }
      doomed.push(x.name);
    }
  }
  // 当前版本一个 IPA 都没有（本次不发 iOS）：保留最新一版的两个变体，别把 iOS 包清空。
  if (!result.ipa.length) {
    const newestIpa = versions.filter((v) => parsed.some((x) => x.info.kind === 'ipa' && x.info.version && x.info.version.join('.') === v)).pop();
    if (newestIpa) {
      for (const x of parsed) {
        if (x.info.kind !== 'ipa') continue;
        if (x.info.version && x.info.version.join('.') === newestIpa) {
          result.ipa.push(x.name);
          const at = doomed.indexOf(x.name);
          if (at >= 0) doomed.splice(at, 1);
        }
      }
    }
  }

  // EXE：优先当前版本；没有就保留最新修改的一个（含无版本号出包产物）。
  const exes = parsed.filter((x) => x.info.kind === 'exe')
    .map((x) => ({ ...x, mtime: mtimeOf(x.name) }))
    .sort((a, b) => {
      if (a.mtime !== b.mtime) return b.mtime - a.mtime;
      if (a.info.versioned !== b.info.versioned) return a.info.versioned ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const currentExe = exes.find((x) => x.info.versioned && x.info.version && x.info.version.join('.') === target) || exes[0];
  result.exe = currentExe ? currentExe.name : '';
  for (const exe of exes) if (!currentExe || exe.name !== currentExe.name) doomed.push(exe.name);

  const now = Date.now();
  for (const name of files) {
    if (!TEMP_RE.test(name)) continue;
    if ((now - mtimeOf(name)) / 60000 >= tempAgeMin) doomed.push(name);
  }

  for (const name of [...new Set(doomed)].sort()) {
    const abs = path.join(DIST, name);
    if (!abs.startsWith(DIST + path.sep)) continue;
    if (dry) { result.removed.push(name + '  (dry)'); continue; }
    fs.unlinkSync(abs);
    result.removed.push(name);
  }
  return result;
}

function report(result) {
  const kept = '版本 ' + (result.keptVersion || '无') + '；APK ' + (result.apk.join(' / ') || '无') +
    '；EXE ' + (result.exe || '无') + '；IPA ' + (result.ipa.join(' / ') || '无');
  if (!result.removed.length) { console.log('发布物保留：没有需要清理的旧包（' + kept + '）'); return; }
  console.log('发布物保留：清理 ' + result.removed.length + ' 个旧包（保留 ' + kept + '）');
  for (const file of result.removed) console.log('  - ' + file);
}

module.exports = { prune, artifact, DIST };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ageAt = argv.indexOf('--temp-age-min');
  report(prune({
    tempAgeMin: ageAt >= 0 ? Number(argv[ageAt + 1]) : 60,
    dry: argv.includes('--dry'),
  }));
}
