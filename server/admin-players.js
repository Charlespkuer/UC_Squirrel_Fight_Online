#!/usr/bin/env node
'use strict';
// 只读查看注册玩家与库存：直接读 DATA_DIR/ssdz.db，不启动游戏服务、不写库。
// 运行：node server/admin-players.js [--limit 200] [--search 名字] [--player 7] [--json]

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TIMEZONE = process.env.TZ_NAME || 'Asia/Shanghai';
const EXTRA_PROP_NAMES = {
  14: '生命转化丸', 77: '黑凤凰碎片', 78: '黑圣熊碎片', 79: '魔法袋',
  80: '黑色卡片', 82: '召唤证', 89: '黑装自选箱', 90: '金宝箱',
};

function parseArgs(argv) {
  const out = {
    db: '', limit: 200, search: '', player: '', top: 30,
    sort: 'id', json: false, summaryOnly: false, hideSim: false, hideBanned: false,
  };
  let i = 0;
  const need = () => {
    if (i + 1 >= argv.length) throw new Error('参数 ' + argv[i] + ' 缺少值');
    return argv[++i];
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--db') out.db = need();
    else if (a === '--limit') out.limit = Math.max(0, parseInt(need(), 10) || 0);
    else if (a === '--search') out.search = String(need());
    else if (a === '--player') out.player = String(need());
    else if (a === '--top') out.top = Math.max(1, parseInt(need(), 10) || 30);
    else if (a === '--sort') out.sort = String(need());
    else if (a === '--json') out.json = true;
    else if (a === '--summary') out.summaryOnly = true;
    else if (a === '--all') out.limit = 0;
    else if (a === '--hide-sim') out.hideSim = true;
    else if (a === '--hide-banned') out.hideBanned = true;
    else throw new Error('未知参数：' + a);
  }
  if (!['id', 'player', 'level', 'gold', 'last'].includes(out.sort)) {
    throw new Error('--sort 只支持 id / player / level / gold / last');
  }
  return out;
}

function usage() {
  return [
    '只读查看联机服注册玩家与库存',
    '',
    '  node server/admin-players.js                玩家表（默认前 200 个）+ 全服常见物品',
    '  node server/admin-players.js --all          所有账号（等同 --limit 0）',
    '  node server/admin-players.js --summary      只看汇总',
    '  node server/admin-players.js --player 7     单个玩家完整背包（支持 ID / 玩家ID / 名字[#tag]）',
    '  node server/admin-players.js --search 鼠    按昵称/ID 过滤',
    '  node server/admin-players.js --json         机器可读输出',
    '',
    '  --db <file>     指定数据库；默认 DATA_DIR/ssdz.db，再试 /var/lib/ssdz/ssdz.db',
    '  --top N         汇总里列多少种物品（默认 30）',
    '  --sort id|player|level|gold|last',
    '  --hide-sim      不显示模拟账号；--hide-banned 不显示封禁账号',
  ].join('\n');
}

function pickDb(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('数据库不存在：' + path.resolve(explicit));
    return path.resolve(explicit);
  }
  const tried = [];
  const add = (p) => { if (p && !tried.includes(p)) tried.push(p); };
  if (process.env.DATA_DIR) add(path.join(process.env.DATA_DIR, 'ssdz.db'));
  add('/var/lib/ssdz/ssdz.db');
  add(path.join(ROOT, 'save', 'online', 'ssdz.db'));
  for (const p of tried) if (fs.existsSync(p)) return p;
  throw new Error('找不到 ssdz.db，试过：' + tried.join('、') + '；请用 --db 指定');
}

function loadPropNames() {
  const ctx = { console };
  ctx.window = ctx;
  ctx.window.__SSDZ_ONLINE__ = true;
  try { vm.createContext(ctx); } catch (_) { return (id) => EXTRA_PROP_NAMES[id] || ('道具#' + id); }
  for (const file of ['js/gamedict.js', 'js/gamedata.js']) {
    try { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file }); }
    catch (_) { /* 名字表加载失败时退化成道具#id，不影响库存数字 */ }
  }
  const map = ctx.window.propMap;
  return (id) => {
    try {
      const item = map && typeof map.getValue === 'function' ? map.getValue(String(id)) : null;
      return (item && item.name) || EXTRA_PROP_NAMES[id] || ('道具#' + id);
    } catch (_) { return EXTRA_PROP_NAMES[id] || ('道具#' + id); }
  };
}

function decodeSave(blob) {
  if (!blob) return null;
  try { return JSON.parse(Buffer.from(blob).toString('utf8')); } catch (_) { return null; }
}

function cleanText(value, max) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > (max || 80) ? text.slice(0, (max || 80) - 1) + '…' : text;
}

function toCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function itemListOf(save, nameOf) {
  const raw = save && save.props && typeof save.props === 'object' && !Array.isArray(save.props) ? save.props : {};
  return Object.keys(raw).map((id) => ({
    id: Number(id), name: nameOf(id), count: toCount(raw[id]),
  })).filter((it) => Number.isFinite(it.id) && it.count > 0)
    .sort((a, b) => b.count - a.count || a.id - b.id);
}

function playerOf(row, save, nameOf) {
  const props = itemListOf(save, nameOf);
  const gears = Array.isArray(save && save.gears) ? save.gears.length : 0;
  const weapons = Array.isArray(save && save.weapons) ? save.weapons.length : 0;
  const skills = Array.isArray(save && save.skills) ? save.skills.length : 0;
  const pets = Array.isArray(save && save.pets) ? save.pets.length : 0;
  const wears = save && save.wears && typeof save.wears === 'object' && !Array.isArray(save.wears)
    ? Object.keys(save.wears).length : 0;
  const buildings = save && save.buildings && typeof save.buildings === 'object' && !Array.isArray(save.buildings)
    ? Object.keys(save.buildings).length : 0;
  const vipUntil = Number(row.vip_until) || 0;
  return {
    id: Number(row.id),
    playerId: Number(row.player_id) || 0,
    name: cleanText(row.name, 32),
    tag: cleanText(row.tag, 8),
    level: Number(row.level) || 1,
    exp: Number(save && save.exp) || 0,
    energy: Number(save && save.energy) || 0,
    maxEnergy: Number(save && save.maxEnergy) || 0,
    gold: Number(row.gold) || 0,
    goldCup: Number(row.gold_cup) || 0,
    integral: Number(row.integral) || 0,
    vipLevel: Number(row.vip_level) || 0,
    vipUntil,
    vipActive: vipUntil > Date.now(),
    revision: Number(row.revision) || 0,
    createdAt: Number(row.created_at) || 0,
    lastSeen: Number(row.last_seen) || Number(row.updated_at) || 0,
    banned: !!Number(row.banned),
    banReason: cleanText(row.ban_reason, 60),
    simulated: !!Number(row.simulated),
    dev: !!Number(row.dev),
    platform: cleanText(row.reg_platform, 16),
    props: props,
    propKinds: props.length,
    propTotal: props.reduce((sum, it) => sum + it.count, 0),
    gears, weapons, skills, pets, wears, buildings,
    buildingsDetail: save && save.buildings && typeof save.buildings === 'object' ? save.buildings : {},
    towerWeek: save && save.towerWeek ? save.towerWeek : null,
    saveMissing: !save,
    saveError: !!row.payload && !save,
  };
}

const nf = new Intl.NumberFormat('zh-CN');
const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function fmtNum(n) { return nf.format(Number(n) || 0); }
function fmtTime(ms) {
  if (!ms) return '-';
  try {
    const parts = dateFmt.formatToParts(new Date(Number(ms)));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  } catch (_) { return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' '); }
}
function widthOf(text) {
  let n = 0;
  for (const ch of String(text)) {
    n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return n;
}
function pad(text, width) {
  const s = String(text == null ? '' : text);
  return s + ' '.repeat(Math.max(0, width - widthOf(s)));
}
function clip(text, width) {
  let s = String(text == null ? '' : text);
  if (widthOf(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (widthOf(out + ch) > width - 1) break;
    out += ch;
  }
  return out + '…';
}

function statusOf(p) {
  const bits = [];
  if (p.banned) bits.push('封禁' + (p.banReason ? '(' + p.banReason + ')' : ''));
  if (p.simulated) bits.push('模拟');
  if (p.dev) bits.push('开发');
  return bits.length ? bits.join('/') : '正常';
}

function printTable(players) {
  const cols = [
    ['ID', 7, (p) => p.id],
    ['玩家ID', 8, (p) => p.playerId || '-'],
    ['昵称', 16, (p) => p.name],
    ['等级', 5, (p) => p.level],
    ['金松果', 10, (p) => fmtNum(p.gold)],
    ['金杯', 8, (p) => fmtNum(p.goldCup)],
    ['积分', 8, (p) => fmtNum(p.integral)],
    ['VIP', 5, (p) => p.vipLevel || '-'],
    ['道具', 12, (p) => p.propKinds + '/' + fmtNum(p.propTotal)],
    ['装备', 5, (p) => p.gears],
    ['幻兽', 5, (p) => p.pets],
    ['最后在线', 17, (p) => fmtTime(p.lastSeen)],
    ['状态', 14, (p) => statusOf(p)],
  ];
  console.log(cols.map(([name, w]) => pad(name, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const p of players) {
    console.log(cols.map(([, w, fn]) => pad(clip(fn(p), w), w)).join(' '));
  }
}

function printItemLines(items, indent) {
  const prefix = indent || '  ';
  for (const it of items) console.log(prefix + it.name + ' (#' + it.id + ') ×' + fmtNum(it.count));
}

function printPlayer(p) {
  console.log('');
  console.log('=== #' + p.id + ' ' + p.name + '#' + p.tag + ' · 玩家ID ' + (p.playerId || '-') + ' ===');
  console.log('等级 ' + p.level + ' · 经验 ' + fmtNum(p.exp) + ' · 体力 ' + p.energy + '/' + p.maxEnergy +
    ' · 金松果 ' + fmtNum(p.gold) + ' · 金杯 ' + fmtNum(p.goldCup) + ' · 积分 ' + fmtNum(p.integral));
  console.log('VIP ' + (p.vipLevel || 0) + (p.vipLevel ? (p.vipActive ? '（生效中，至 ' + fmtTime(p.vipUntil) + '）' : '（已到期）') : '') +
    ' · 注册 ' + fmtTime(p.createdAt) + ' · 最后在线 ' + fmtTime(p.lastSeen) + ' · ' + statusOf(p));
  console.log('装备 ' + p.gears + ' 件（已穿 ' + p.wears + '） · 武器 ' + p.weapons + ' · 技能 ' + p.skills +
    ' · 幻兽 ' + p.pets + ' · 建筑 ' + p.buildings);
  if (p.banned && p.banReason) console.log('封禁原因：' + p.banReason);
  console.log('背包道具：' + p.propKinds + ' 种 / 共 ' + fmtNum(p.propTotal) + ' 个');
  if (p.saveMissing) console.log('（这个账号还没有存档）');
  else if (p.saveError) console.log('（存档 JSON 解析失败，下面只能看汇总列）');
  if (p.props.length) printItemLines(p.props);
  if (p.towerWeek) {
    console.log('无尽塔本周：' + (p.towerWeek.week || '-') + ' · 已发 ' + (p.towerWeek.tickets || 0) + ' 张');
  }
  if (p.buildingsDetail && Object.keys(p.buildingsDetail).length) {
    const list = Object.entries(p.buildingsDetail).map(([k, v]) => k + ' Lv' + (v && v.level ? v.level : 1));
    console.log('建筑：' + list.join(' · '));
  }
}

function printSummary(players, top) {
  const items = new Map();
  for (const p of players) {
    for (const it of p.props) {
      const row = items.get(it.id) || { id: it.id, name: it.name, count: 0, owners: 0 };
      row.count += it.count;
      row.owners += 1;
      items.set(it.id, row);
    }
  }
  const list = [...items.values()].sort((a, b) => b.count - a.count || a.id - b.id).slice(0, top);
  console.log('');
  console.log('=== 全服常见物品（本次统计 ' + players.length + ' 个账号，按总量） ===');
  if (!list.length) { console.log('  （没有道具记录）'); return; }
  list.forEach((it, i) => {
    console.log('  ' + String(i + 1).padStart(2) + '. ' + it.name + ' (#' + it.id + ') ×' +
      fmtNum(it.count) + ' · ' + it.owners + ' 人持有');
  });
}

function totalsOf(players) {
  const total = {
    accounts: players.length,
    normal: 0, banned: 0, simulated: 0, dev: 0, vip: 0,
    levelSum: 0, levelMax: 0,
    gold: 0, goldCup: 0, integral: 0,
    propKinds: new Set(), propTotal: 0,
  };
  for (const p of players) {
    if (p.banned) total.banned++; else total.normal++;
    if (p.simulated) total.simulated++;
    if (p.dev) total.dev++;
    if (p.vipLevel) total.vip++;
    total.levelSum += p.level;
    total.levelMax = Math.max(total.levelMax, p.level);
    total.gold += p.gold;
    total.goldCup += p.goldCup;
    total.integral += p.integral;
    for (const it of p.props) total.propKinds.add(it.id);
    total.propTotal += p.propTotal;
  }
  return total;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return; }
  const dbPath = pickDb(opts.db);
  const nameOf = loadPropNames();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`
      SELECT a.id, a.name, a.tag, a.created_at, a.last_seen, a.banned, a.ban_reason,
             a.reg_platform, p.player_id,
             s.level, s.gold, s.gold_cup, s.integral, s.vip_level, s.vip_until,
             s.revision, s.updated_at, s.payload,
             (SELECT 1 FROM simulated_accounts x WHERE x.account_id = a.id) AS simulated,
             (SELECT 1 FROM dev_accounts x WHERE x.account_id = a.id) AS dev
      FROM accounts a
      LEFT JOIN saves s ON s.account_id = a.id AND s.mode = 'classic'
      LEFT JOIN player_ids p ON p.account_id = a.id
      ORDER BY a.id
    `).all();
  } finally {
    db.close();
  }

  const query = opts.search.trim().toLowerCase();
  const selected = opts.player.trim().toLowerCase();
  let players = rows.map((row) => playerOf(row, decodeSave(row.payload), nameOf));

  if (opts.hideSim) players = players.filter((p) => !p.simulated);
  if (opts.hideBanned) players = players.filter((p) => !p.banned);
  if (query) {
    players = players.filter((p) =>
      String(p.id) === query || String(p.playerId) === query ||
      (p.name + '#' + p.tag).toLowerCase().includes(query) ||
      p.name.toLowerCase().includes(query) || p.tag.toLowerCase().includes(query));
  }
  if (opts.sort === 'level') players.sort((a, b) => b.level - a.level || a.id - b.id);
  else if (opts.sort === 'gold') players.sort((a, b) => b.gold - a.gold || a.id - b.id);
  else if (opts.sort === 'last') players.sort((a, b) => b.lastSeen - a.lastSeen || a.id - b.id);
  else if (opts.sort === 'player') players.sort((a, b) => (a.playerId || 0) - (b.playerId || 0) || a.id - b.id);

  if (selected) {
    const found = players.filter((p) =>
      String(p.id) === selected || String(p.playerId) === selected ||
      (p.name + '#' + p.tag).toLowerCase() === selected || p.name.toLowerCase() === selected);
    if (!found.length) throw new Error('没有找到玩家：' + opts.player);
    if (found.length > 1) {
      console.error('匹配到多个玩家，请用 ID 或 玩家ID 精确指定：');
      for (const p of found) console.error('  #' + p.id + ' ' + p.name + '#' + p.tag + ' 玩家ID ' + (p.playerId || '-'));
      process.exitCode = 2;
      return;
    }
    const p = found[0];
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, db: dbPath, generatedAt: Date.now(), player: p }, null, 2));
      return;
    }
    printPlayer(p);
    return;
  }

  const totalAll = totalsOf(players);
  const shown = opts.limit > 0 ? players.slice(0, opts.limit) : players;
  if (opts.json) {
    const items = new Map();
    for (const p of shown) for (const it of p.props) {
      const row = items.get(it.id) || { id: it.id, name: it.name, count: 0, owners: 0 };
      row.count += it.count; row.owners += 1; items.set(it.id, row);
    }
    console.log(JSON.stringify({
      ok: true, db: dbPath, generatedAt: Date.now(),
      scope: { matched: players.length, shown: shown.length },
      totals: Object.assign({}, totalAll, { propKinds: totalAll.propKinds.size }),
      items: [...items.values()].sort((a, b) => b.count - a.count || a.id - b.id),
      players: shown,
    }, null, 2));
    return;
  }

  console.log('数据库：' + dbPath + '（只读）');
  console.log('账号：' + totalAll.accounts + '（正常 ' + totalAll.normal + ' / 封禁 ' + totalAll.banned +
    ' / 模拟 ' + totalAll.simulated + ' / 开发 ' + totalAll.dev + '）' +
    ' · 等级平均 ' + (totalAll.accounts ? (totalAll.levelSum / totalAll.accounts).toFixed(1) : '0') +
    ' / 最高 ' + totalAll.levelMax);
  console.log('金松果合计 ' + fmtNum(totalAll.gold) + ' · 金杯合计 ' + fmtNum(totalAll.goldCup) +
    ' · 积分合计 ' + fmtNum(totalAll.integral) + ' · 道具总量 ' + fmtNum(totalAll.propTotal));
  if (opts.limit > 0 && players.length > shown.length) {
    console.log('（共 ' + players.length + ' 个匹配账号，下面只列前 ' + shown.length + ' 个；--limit 0 看全部）');
  }

  if (!opts.summaryOnly) {
    console.log('');
    printTable(shown);
  }
  printSummary(shown, opts.top);
}

try { main(); } catch (e) {
  console.error('[admin-players] ' + ((e && e.message) || e));
  process.exitCode = 1;
}
