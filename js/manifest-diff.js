// manifest-diff.js — 前端「同步预览」与服务端 /api/owner 共用的清单差异计算
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ManifestDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
      added, changed, removed, count: files.length, bytes, categories,
      files: shown, truncated: files.length > shown.length,
    };
  }

  return { diffManifests };
});
