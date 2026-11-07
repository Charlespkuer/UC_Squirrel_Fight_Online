#!/usr/bin/env node
/* ============================================================
 * tools/prune-dist.cjs —— 发布物保留策略（本地 dist 只留最近两版）
 *
 *   node tools/prune-dist.cjs            # 按策略清理（默认保留最近 2 个版本）
 *   node tools/prune-dist.cjs --dry      # 只列计划，不删
 *   node tools/prune-dist.cjs --keep 3   # 改保留数量
 *
 * 管的是 `src-tauri/dist/`（本机出包产物，不进仓库）：
 *   · `squirrel_fight_online-<版本>-<arch>.apk` / `.ipa` 及其 `.idsig`：
 *     按**版本号**（不是文件时间）排序，保留最近 N 个版本，其余删掉；
 *   · `online-pending.apk` / `online-aligned-unsigned.apk` / `*.idsig` 这类
 *     **出包中间文件**：只在超过 `--temp-age-min`（默认 60 分钟）没被改动时删，
 *     避免把正在跑的构建的临时包删掉；
 *   · `squirrel_fight_online.exe`、`src-tauri/keys/` 一律不动。
 *
 * 由 `tools/build-online-apk.cjs` 在出包成功后自动调用（所以旧包不会越堆越多）；
 * iOS 的 `build-ios-release.cjs` 本来就有「只留两个签名 IPA」的逻辑，不在这里重复。
 * 磁盘占用参考：每版 APK ≈ 77–82 MB，保留 2 版 ≈ 160 MB；不清理时
 * 2026-11 一度堆到 2.6 GB / 35 个 APK。
 * ============================================================ */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'src-tauri', 'dist');

/** 从文件名拆版本：squirrel_fight_online-1.0.50-arm64.apk(.idsig) → [1,0,50]。 */
function versionOf(name) {
  const m = /^squirrel_fight_online-(\d+(?:\.\d+)*)(?:-[A-Za-z0-9_]+)?\.(?:apk|ipa)(?:\.idsig)?$/.exec(name);
  return m ? m[1].split('.').map(Number) : null;
}
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function prune(opts = {}) {
  const keep = Math.max(1, Number(opts.keep) || 2);
  const tempAgeMin = Number.isFinite(opts.tempAgeMin) ? opts.tempAgeMin : 60;
  const dry = opts.dry === true;
  if (!fs.existsSync(DIST)) return { removed: [], kept: [] };

  const files = fs.readdirSync(DIST).filter((n) => fs.statSync(path.join(DIST, n)).isFile());
  const versions = new Map(); // '1.0.50' -> [file...]
  for (const name of files) {
    const v = versionOf(name);
    if (!v) continue;
    const key = v.join('.');
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push(name);
  }
  const ordered = [...versions.keys()].sort((a, b) =>
    cmpVersion(a.split('.').map(Number), b.split('.').map(Number)));
  const doomed = [];
  for (const key of ordered.slice(0, Math.max(0, ordered.length - keep))) doomed.push(...versions.get(key));

  /* 中间文件：只在「够老」时删，避免误伤正在跑的构建。 */
  const now = Date.now();
  for (const name of files) {
    if (!/^(?:online-pending\.(?:apk|apk\.idsig)|online-aligned-unsigned\.apk)$/.test(name)) continue;
    const ageMin = (now - fs.statSync(path.join(DIST, name)).mtimeMs) / 60000;
    if (ageMin >= tempAgeMin) doomed.push(name);
  }

  const kept = ordered.slice(-keep);
  const removed = [];
  for (const name of [...new Set(doomed)].sort()) {
    const abs = path.join(DIST, name);
    if (!abs.startsWith(DIST + path.sep)) continue; // 双保险：永远不越出 dist/
    if (dry) { removed.push(name + '  (dry)'); continue; }
    fs.unlinkSync(abs);
    removed.push(name);
  }
  return { removed, kept };
}

function report(result) {
  if (!result.removed.length) console.log('发布物保留策略：没有需要清理的旧包（保留 ' + result.kept.length + ' 个版本）');
  else {
    console.log('发布物保留策略：清理 ' + result.removed.length + ' 个文件，保留版本 ' + result.kept.join(' / '));
    for (const f of result.removed) console.log('  - ' + f);
  }
}

module.exports = { prune, versionOf, DIST };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const keepAt = argv.indexOf('--keep');
  const ageAt = argv.indexOf('--temp-age-min');
  report(prune({
    keep: keepAt >= 0 ? Number(argv[keepAt + 1]) : 2,
    tempAgeMin: ageAt >= 0 ? Number(argv[ageAt + 1]) : 60,
    dry: argv.includes('--dry'),
  }));
}
