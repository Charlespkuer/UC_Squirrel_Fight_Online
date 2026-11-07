'use strict';
/* 服务器主人的只读预览 / 更新信息接口。
 *
 * 只回答：这个请求的 TCP 对端是不是配置的 OWNER_IPS、当前客户端包在哪、
 * 以及「从客户端版本 X 升到服务器版本 Y」会改动哪些文件（按发布清单比较）。
 * 不写存档、不改游戏数据；清单只用于设置页的「将要同步哪些内容」预览。
 * IP 不是凭据，只决定主人按钮的可见性；下载仍走公开的 /download/*。
 */
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

function manifestDir() { return path.join(config.dataDir, 'downloads', 'manifests'); }

function readManifest(file) {
  const data = readJson(file, null);
  if (!data || !Array.isArray(data.files)) return null;
  return { version: String(data.version || ''), files: data.files };
}

/** 当前版本清单随服务端包部署；第一次预览时把它留一份到 downloads/manifests/。 */
function currentManifest(version) {
  const file = path.join(config.gameRoot, 'server', 'web-manifest.json');
  const data = readManifest(file);
  if (!data) return null;
  try {
    const dir = manifestDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, (safeVersion(version) || data.version) + '.json');
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify(data));
  } catch (_) { /* 写历史清单失败不影响预览 */ }
  return data;
}

function oldManifest(version) {
  if (!version) return null;
  return readManifest(path.join(manifestDir(), version + '.json'));
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

function packageInfo(version) {
  const exe = version ? 'squirrel_fight_online-' + version + '.exe' : '';
  const apk = version ? 'squirrel_fight_online-' + version + '-arm64.apk' : '';
  let exeSize = 0;
  try { exeSize = fs.statSync(path.join(config.dataDir, 'downloads', exe)).size; } catch (_) {}
  return {
    platform: '',
    exe: existing(exe) ? '/download/' + exe : '',
    apk: existing(apk) ? '/download/' + apk : '',
    exeSize,
  };
}

function owner(ctx) {
  return config.ownerIps.includes(clientIp(ctx.req));
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

/** 预览：客户端版本 X → 服务器当前版本，按清单给出文件级差异。 */
function preview(ctx) {
  if (!owner(ctx)) return { ok: true, owner: false };
  const build = readJson(path.join(config.gameRoot, 'scripts', 'version.json'), {});
  const policy = readJson(path.join(config.gameRoot, 'server', 'update.json'), {});
  const version = String(build.version || '');
  const fromVersion = safeVersion(ctx.query && ctx.query.from);
  const current = currentManifest(version);
  let diff = null;
  let diffReason = '';
  if (!fromVersion) {
    diffReason = '客户端没有上报版本号，只能整包更新。';
  } else if (fromVersion === version) {
    diff = diffManifests(current ? current.files : [], current ? current.files : []);
  } else if (!current) {
    diffReason = '服务器还没有当前版本的文件清单，只能整包更新。';
  } else {
    const old = oldManifest(fromVersion);
    if (!old) diffReason = '服务器没有 v' + fromVersion + ' 的文件清单（旧版客户端），只能整包更新。';
    else diff = diffManifests(old.files, current.files);
  }
  return Object.assign({
    ok: true,
    owner: true,
    version,
    fromVersion,
    notes: String(policy.notes || ''),
    totalFiles: current ? current.files.length : 0,
    diff,
    diffReason,
  }, packageInfo(version), {
    platform: String((ctx.req.headers && ctx.req.headers['x-device-platform']) || ''),
  });
}

module.exports = { status, preview };
