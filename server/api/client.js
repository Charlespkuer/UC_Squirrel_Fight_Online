'use strict';
// 纯网页端「下载客户端」：按客户端上报的系统 / 架构返回服务器上对应的安装包。
// 包名与可用性只认 DATA_DIR/downloads（owner.packageInfo），这里不另拼文件名。
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');
const owner = require('./owner');

const OS_LABELS = {
  windows: 'Windows', android: 'Android', ios: 'iOS',
  macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', other: '当前设备',
};

function serverVersion() {
  try {
    const build = JSON.parse(fs.readFileSync(path.join(config.gameRoot, 'scripts', 'version.json'), 'utf8')) || {};
    return String(build.version || '');
  } catch (_) { return ''; }
}

function fileName(rel) { return String(rel || '').split('/').pop(); }

function pkg(platform, label, rel, size, version, note) {
  return {
    platform,
    label,
    name: fileName(rel),
    url: rel,
    size: Number(size) || 0,
    version: String(version || ''),
    note: String(note || ''),
  };
}

function miss(reason, message) { return { pkg: null, reason, message }; }

function androidFamily(arch) {
  if (arch === 'x86_64' || arch === 'x64') return 'x86_64';
  if (arch === 'x86') return 'x86';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'arm') return 'arm';
  return '';
}

function pick(os, arch, iosMajor, info, version) {
  if (os === 'windows') {
    if (!info.exe) return miss('no-package', '服务器还没有 Windows 客户端安装包。');
    const note = arch === 'arm64' ? '当前设备是 Windows ARM64，将运行 x64 兼容版客户端。' : '';
    return { pkg: pkg('windows', 'Windows 客户端', info.exe, info.exeSize, version, note) };
  }
  if (os === 'android') {
    const family = androidFamily(arch);
    if (family === 'x86' || family === 'arm') {
      return miss('unsupported-arch', '服务器只提供 64 位 Android 安装包，当前设备是 32 位。');
    }
    if (family === 'x86_64') {
      if (!info.apkX86) return miss('no-package', '服务器还没有 Android x86_64 安装包；普通手机请用 arm64 包。');
      return { pkg: pkg('android', 'Android 客户端（x86_64）', info.apkX86, info.apkX86Size, version, '') };
    }
    if (!info.apk) return miss('no-package', '服务器还没有 Android arm64 安装包。');
    const note = family ? '' : '没能识别 CPU 架构，默认提供 arm64 包；模拟器 / Intel 设备请到下载页选 x86_64 包。';
    return { pkg: pkg('android', 'Android 客户端（arm64）', info.apk, info.apkSize, version, note) };
  }
  if (os === 'ios') {
    if (iosMajor && iosMajor < 15) return miss('unsupported-os', 'iOS 15 以下没有可用的客户端安装包。');
    const legacy = iosMajor >= 15 && iosMajor < 26;
    const rel = legacy ? info.ipaLegacy : info.ipa;
    const relVersion = legacy ? info.ipaLegacyVersion : info.ipaVersion;
    if (!rel) return miss('no-package', legacy ? '服务器还没有 iOS 15~25 的 legacy 安装包。' : '服务器还没有 iOS 26+ 的安装包。');
    const note = !iosMajor
      ? '没能识别系统版本，默认提供 iOS 26+ 包；iOS 15~25 请到下载页选 legacy 包。'
      : (relVersion && version && relVersion !== version ? 'iOS 包版本为 v' + relVersion + '（服务器版本 v' + version + '）。' : '');
    return {
      pkg: pkg('ios', legacy ? 'iOS 客户端（iOS 15~25）' : 'iOS 客户端（iOS 26+）',
        rel, legacy ? info.ipaLegacySize : info.ipaSize, relVersion || version, note),
    };
  }
  if (os === 'other') return miss('unsupported-platform', '没能识别本机系统；可以到下载页手动选包，或直接用网页版游玩。');
  const name = OS_LABELS[os] || '当前设备';
  return miss('unsupported-platform', '服务器暂时没有 ' + name + ' 客户端；可以直接用网页版游玩，进度与客户端互通。');
}

function download(ctx) {
  const q = (ctx && ctx.query) || {};
  const rawOs = String(q.os || '').toLowerCase();
  const os = OS_LABELS[rawOs] ? rawOs : 'other';
  const arch = String(q.arch || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const iosMajor = Math.max(0, Math.min(99, parseInt(q.ios, 10) || 0));
  const version = serverVersion();
  const out = pick(os, arch, iosMajor, owner.packageInfo(version), version);
  return {
    ok: true,
    version,
    detected: { os, arch, iosMajor },
    package: out.pkg,
    reason: out.reason || '',
    message: out.message || '',
    downloadPage: '/download',
  };
}

module.exports = { download };
