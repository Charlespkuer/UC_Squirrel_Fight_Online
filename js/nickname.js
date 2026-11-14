// nickname.js — 昵称长度规则（浏览器 / 服务端共用）
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NicknameRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_UNITS = 21;
  const MAX_WEIGHT = 7;
  const MAX_ASCII = 21;
  const TOO_LONG = '昵称最多 7 个汉字（英文/数字按 1/3 个汉字计，最多 21 个）';


  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .trim();
  }


  function charUnits(ch) {
    return /^[\x20-\x7e]$/.test(ch) ? 1 : 3;
  }


  function unitsOf(value) {
    let n = 0;
    for (const ch of clean(value)) n += charUnits(ch);
    return n;
  }


  function weightOf(value) {
    return unitsOf(value) / 3;
  }

  // 是否超过上限。
  function tooLong(value) {
    return unitsOf(value) > MAX_UNITS;
  }

  // 校验昵称，返回统一结果（服务端 `auth.normalizeName` / 注册页即时提示共用）。
  function check(value) {
    const name = clean(value);
    if (!name) return { ok: false, name: '', units: 0, weight: 0, reason: '名字不能为空' };
    const units = unitsOf(name);
    if (units > MAX_UNITS) {
      return { ok: false, name, units, weight: units / 3, reason: TOO_LONG };
    }
    return { ok: true, name, units, weight: units / 3, reason: '' };
  }


  function truncate(value, maxUnits) {
    const limit = Number.isFinite(Number(maxUnits)) ? Math.max(0, Math.floor(Number(maxUnits))) : MAX_UNITS;
    let out = '', used = 0;
    for (const ch of clean(value)) {
      const u = charUnits(ch);
      if (used + u > limit) break;
      out += ch; used += u;
    }
    return out;
  }

  return {
    MAX_UNITS, MAX_WEIGHT, MAX_ASCII, TOO_LONG,
    clean, unitsOf, weightOf, tooLong, check, truncate,
  };
});
