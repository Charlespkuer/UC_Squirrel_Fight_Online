'use strict';
// 服务器主人的只读预览 / 更新信息接口。
// 只回答：这个请求的 TCP 对端是不是配置的 OWNER_IPS、当前客户端包在哪、
// 以及「从客户端版本 X 升到服务器版本 Y」会改动哪些文件（按发布清单比较）。
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');
const { clientIp } = require('../http');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; } catch (_) { return fallback; }
}

function existing(name) {
  if (!name) return false;
  try { return fs.statSync(path.join(config.dataDir, 'downloads', name)).isFile(); } catch (_) { return false; }
}

function safeVersion(value) {
  const v = String(value || '').trim();
  return /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(v) ? v : '';
}

// 构建号：新清单直接写 `build`（构建脚本写的是整份快照的 SHA-256）；
// 旧清单没有这个字段，用它自己的原始文本算一个 FNV-1a —— 客户端读到的是同一份
// `web-manifest.json`，两边算出来必须一致，才能在版本号没变时也判断"是不是同一个构建"。
function hashText(text) {
  const s = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function safeBuild(value) {
  const v = String(value || '').trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(v) ? v : '';
}

function manifestDir() { return path.join(config.dataDir, 'downloads', 'manifests'); }

function readManifestText(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { return null; }
  if (!data || !Array.isArray(data.files)) return null;
  const build = String(data.build || (hashText(raw) + '-' + data.files.length));
  return { version: String(data.version || ''), build, files: data.files, raw };
}

// 当前版本清单随服务端包部署；第一次预览时把它留一份到 downloads/manifests/。
function currentManifest(version) {
  const file = path.join(config.gameRoot, 'server', 'web-manifest.json');
  const data = readManifestText(file);
  if (!data) return null;
  try {
    const dir = manifestDir();
    fs.mkdirSync(dir, { recursive: true });
    const raw = data.raw || JSON.stringify({ version: data.version, build: data.build, files: data.files });
    const dest = path.join(dir, (safeVersion(version) || data.version) + '.json');
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, raw);
    const byBuild = path.join(dir, String(data.build).replace(/[^\w.-]/g, '_') + '.json');
    if (!fs.existsSync(byBuild)) fs.writeFileSync(byBuild, raw);
  } catch (_) {  }
  return { version: data.version, build: data.build, files: data.files };
}

function oldManifest(version) {
  if (!version) return null;
  const data = readManifestText(path.join(manifestDir(), version + '.json'));
  return data ? { version: data.version, build: data.build, files: data.files } : null;
}

function oldManifestByBuild(build) {
  if (!build) return null;
  const data = readManifestText(path.join(manifestDir(), String(build).replace(/[^\w.-]/g, '_') + '.json'));
  return data ? { version: data.version, build: data.build, files: data.files } : null;
}

function diffManifests(oldFiles, newFiles) {
  const oldMap = new Map((oldFiles || []).map((f) => [String(f.path), f]));
  const newMap = new Map((newFiles || []).map((f) => [String(f.path), f]));
  const files = [];
  const categories = {};
  let added = 0, changed = 0, removed = 0, bytes = 0;
  const bump = (filePath) => {
    const key = filePath.includes('/') ? filePath.split('/')[0] : '根目录';
    categories[key] = (categories[key] || 0) + 1;
  };
  for (const f of newFiles || []) {
    const before = oldMap.get(String(f.path));
    if (!before) {
      files.push({ path: f.path, status: 'added', size: Number(f.size) || 0 });
      added++; bytes += Number(f.size) || 0; bump(String(f.path));
    } else if (String(before.sha256) !== String(f.sha256)) {
      files.push({ path: f.path, status: 'changed', size: Number(f.size) || 0 });
      changed++; bytes += Number(f.size) || 0; bump(String(f.path));
    }
  }
  for (const f of oldFiles || []) {
    if (newMap.has(String(f.path))) continue;
    files.push({ path: f.path, status: 'removed', size: Number(f.size) || 0 });
    removed++; bump(String(f.path));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const shown = files.slice(0, 500);
  return {
    added, changed, removed, count: files.length, bytes,
    categories,
    files: shown,
    truncated: files.length > shown.length,
  };
}

function versionParts(value) {
  return String(value || '').split('.').map((n) => Number(n) || 0);
}
function cmpVersion(a, b) {
  const A = versionParts(a), B = versionParts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d;
  }
  return 0;
}
// iOS 不一定与 EXE/APK 同版本发布：当前版本没有 IPA 时，退回下载目录里最新的 iOS 包。
function latestIpa(legacy) {
  const prefix = 'squirrel_fight_online_';
  const suffix = legacy ? '_ios_legacy_unsigned.ipa' : '_ios_unsigned.ipa';
  let best = null;
  try {
    for (const name of fs.readdirSync(path.join(config.dataDir, 'downloads'))) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const version = name.slice(prefix.length, -suffix.length);
      if (!/^\d+(?:\.\d+)*$/.test(version)) continue;
      if (!best || cmpVersion(version, best.version) > 0) best = { version, name };
    }
  } catch (_) {  }
  return best;
}

function packageInfo(version) {
  const exe = version ? 'squirrel_fight_online-' + version + '.exe' : '';
  const apk = version ? 'squirrel_fight_online-' + version + '-arm64.apk' : '';
  const apkX86 = version ? 'squirrel_fight_online-' + version + '-x86_64.apk' : '';
  /* IPA 文件名由 iOS 出包脚本固定为 `squirrel_fight_online_<版本>_ios[_legacy]_unsigned.ipa`。 */
  const ipaName = version ? 'squirrel_fight_online_' + version + '_ios_unsigned.ipa' : '';
  const ipaLegacyName = version ? 'squirrel_fight_online_' + version + '_ios_legacy_unsigned.ipa' : '';
  const ipa = (ipaName && existing(ipaName) ? { version, name: ipaName } : latestIpa(false));
  const ipaLegacy = (ipaLegacyName && existing(ipaLegacyName) ? { version, name: ipaLegacyName } : latestIpa(true));
  const sizeOf = (name) => {
    try { return fs.statSync(path.join(config.dataDir, 'downloads', name)).size; } catch (_) { return 0; }
  };
  return {
    platform: '',
    exe: existing(exe) ? '/download/' + exe : '',
    apk: existing(apk) ? '/download/' + apk : '',
    apkX86: existing(apkX86) ? '/download/' + apkX86 : '',
    ipa: ipa ? '/download/' + ipa.name : '',
    ipaLegacy: ipaLegacy ? '/download/' + ipaLegacy.name : '',
    ipaVersion: ipa ? ipa.version : '',
    ipaLegacyVersion: ipaLegacy ? ipaLegacy.version : '',
    exeSize: sizeOf(exe),
    apkSize: sizeOf(apk),
    apkX86Size: sizeOf(apkX86),
    ipaSize: ipa ? sizeOf(ipa.name) : 0,
    ipaLegacySize: ipaLegacy ? sizeOf(ipaLegacy.name) : 0,
  };
}

function owner(ctx) {
  const ip = clientIp(ctx.req);
  if (!ip || !config.ownerIps.includes(ip)) return false;
  if (config.ownerIpOnly) return true;
  // IP 只是第一道门：同一公网 IP 的其它设备、或把远端变成 127.0.0.1 的本机反代都会命中。
  // 主人面板再要求创作者设备（CREATOR_DEVICES）；普通设备即使和主人同 IP 也看不到。
  const device = ctx.auth && ctx.auth.device;
  return !!(device && device.creator);
}

function status(ctx) {
  if (!owner(ctx)) return { ok: true, owner: false };
  const build = readJson(path.join(config.gameRoot, 'scripts', 'version.json'), {});
  const policy = readJson(path.join(config.gameRoot, 'server', 'update.json'), {});
  const version = String(build.version || '');
  return Object.assign({ ok: true, owner: true, version, notes: String(policy.notes || '') },
    packageInfo(version),
    { platform: String((ctx.req.headers && ctx.req.headers['x-device-platform']) || '') });
}

// 预览：客户端版本 / 构建 → 服务器当前版本 / 构建，按清单给出文件级差异。
// 新客户端会带 `build`（它自带 `web-manifest.json` 的构建号）：版本号相同但代码变过
// 也能识别；并把服务器当前清单回给它，由客户端逐文件对比（旧客户端不读这份清单）。
function preview(ctx) {
  if (!owner(ctx)) return { ok: true, owner: false };
  const build = readJson(path.join(config.gameRoot, 'scripts', 'version.json'), {});
  const policy = readJson(path.join(config.gameRoot, 'server', 'update.json'), {});
  const version = String(build.version || '');
  const fromVersion = safeVersion(ctx.query && ctx.query.from);
  const clientBuild = safeBuild(ctx.query && ctx.query.build);
  const current = currentManifest(version);
  const currentBuild = current ? current.build : '';
  let diff = null;
  let diffReason = '';
  let stale = false;
  if (clientBuild) {
    if (!current) {
      // 连当前清单都没有：不能证明客户端是最新的，按"有改动"处理，让主人自己决定。
      stale = true;
      diffReason = '服务器还没有当前版本的文件清单，只能整包更新。';
    } else if (clientBuild === currentBuild) {
      diff = diffManifests(current.files, current.files);
    } else {
      stale = true;
      // 旧构建清单还在（服务端按 build 留过档）就能直接给差异；
      // 没有的话客户端会用自己那份清单和下面返回的 manifest 自己算。
      const old = oldManifestByBuild(clientBuild) ||
        (fromVersion && fromVersion !== version ? oldManifest(fromVersion) : null);
      if (old) diff = diffManifests(old.files, current.files);
      else diffReason = '服务器没有这个构建的文件清单（旧客户端或首次启用），请直接整包更新。';
    }
  } else if (!fromVersion) {
    diffReason = '客户端没有上报版本号或构建号，只能整包更新。';
  } else if (fromVersion === version) {
    // 旧客户端只报版本：同版本时无法确认文件是否一致，先按「一致」返回。
    diff = diffManifests(current ? current.files : [], current ? current.files : []);
  } else if (!current) {
    diffReason = '服务器还没有当前版本的文件清单，只能整包更新。';
  } else {
    const old = oldManifest(fromVersion);
    if (!old) diffReason = '服务器没有 v' + fromVersion + ' 的文件清单（旧版客户端），只能整包更新。';
    else diff = diffManifests(old.files, current.files);
    stale = true;
  }
  if (diff && diff.count) stale = true;
  return Object.assign({
    ok: true,
    owner: true,
    version,
    fromVersion,
    build: currentBuild,
    clientBuild,
    stale,
    notes: String(policy.notes || ''),
    totalFiles: current ? current.files.length : 0,
    diff,
    diffReason,
    // 只有带 build 的新客户端需要：拿它和自己包里的清单算逐文件差异。
    manifest: clientBuild && current ? current.files : undefined,
  }, packageInfo(version), {
    platform: String((ctx.req.headers && ctx.req.headers['x-device-platform']) || ''),
  });
}

module.exports = { status, preview, packageInfo };
