'use strict';
/* server 性能基准：临时库 + 子进程服务端，按场景量顺序延迟与并发吞吐。
 * 只在本机跑；数据目录在 out/ 下，跑完即删。用法：
 *   node tools/bench-server.cjs                 # 全部场景，顺序 + 混合并发
 *   node tools/bench-server.cjs --only state    # 只跑名字含 state 的场景
 *   node tools/bench-server.cjs --prof          # 服务端带 --cpu-prof，产物在 out/bench-prof/
 */
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_bench-server-'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SEQ = Math.max(5, Number(opt('seq', 40)));
const CONC = Math.max(1, Number(opt('conc', 12)));
const DURATION = Math.max(1000, Number(opt('duration', 5000)));
const ONLY = opt('only', '');
const PROF = flag('prof');
const ACCOUNTS = Math.max(2, Number(opt('accounts', 12)));
const IMG = opt('img', 'atlas/SQ_01.png');

process.env.DATA_DIR = DATA;
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.SERVE_STATIC = 'true';
process.env.ALLOW_BROWSER_DEVICES = 'true';
process.env.ACCOUNTS_PER_IP = '0';
process.env.ACCOUNT_DAILY_LIMIT = '0';
process.env.OWNER_IPS = '127.0.0.1,::1';
process.env.OWNER_IP_ONLY = 'true';
process.env.FIGHT_INTERVAL_MS = '0';
process.env.ACTION_INTERVAL_MS = '0';
process.env.OPPONENTS_RATE_PER_MIN = '100000';
process.env.ACTION_RATE_PER_MIN = '100000';
process.env.READ_RATE_PER_MIN = '1000000';
process.env.FIGHT_RATE_PER_MIN = '100000';
process.env.ENFORCEMENT_ENABLED = '0';
process.env.BACKUP_ENABLED = 'false';
process.env.LOG_REQUESTS = 'false';

const device = (id) => ({
  'x-device-id': String(id).padEnd(32, '_'),
  'x-device-platform': 'browser',
  'x-device-provider': 'installation',
});

function cleanup() {
  if (path.dirname(DATA) !== OUT || !path.basename(DATA).startsWith('_bench-server-')) throw new Error('invalid bench data path');
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); return; } catch (_) {}
  }
}

async function seed() {
  const db = require('../server/db');
  const auth = require('../server/auth');
  const store = require('../server/game/store');
  require('../server/game/runtime').boot();
  db.open();
  const players = [];
  for (let i = 0; i < ACCOUNTS; i++) {
    const name = 'bench' + String.fromCharCode(97 + (i % 26)) + i;
    const d = device('bench' + i);
    const { account } = auth.register({ name, password: 'pass-a1', ip: '10.0.0.' + (i + 1), device: (() => {
      const dev = require('../server/device');
      return dev.fromRequest({ headers: d });
    })() });
    const id = Number(account.id);
    store.createSave(id, name);
    // 存档形状对齐真实玩家：battles 占大半（线上 20 条 ≈ 6.5 KB），这里给 40 条 ≈ 13 KB。
    const pad = [];
    for (let k = 0; k < 40; k++) {
      pad.push({
        me: { name, level: 40, power: 300 + k, agility: 200, speed: 180, maxHp: 4200 },
        foe: { name: 'rival' + k, level: 40, power: 280, agility: 210, speed: 190, maxHp: 4000 },
        result: { names: [name, 'rival' + k], winner: k % 2, maxHp: [4200, 4000], rounds: 8 },
        region: 0, kind: 'challenge', online: { opponentId: 0, snapshotId: '', combatId: 'c_bench' + k },
        winner: k % 2, id: 'b' + k, createdAt: 1600000000000 + k,
      });
    }
    store.runOnSave(id, ({ save }) => {
      save.level = 40;
      save.exp = 0;
      save.goldPoint = 5000000;
      save.energy = 200;
      save.battles = pad.slice();
    }, { snapshotSource: 'bench' });
    const settlement = require('../server/game/settlement');
    settlement.ensureRating(id, settlement.weekKey());
    db.run('UPDATE ratings SET score = ? WHERE account_id = ? AND season = ?', 300 + i * 10, id, settlement.weekKey());
    players.push({ id, name, token: '', device: d });
  }
  db.close();
  return players;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const args = [path.join(ROOT, 'server', 'index.js')];
  if (PROF) {
    const dir = path.join(OUT, 'bench-prof');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    args.unshift('--cpu-prof', '--cpu-prof-dir=' + dir);
  }
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DATA_DIR: DATA, PORT: String(port), BIND: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write('[server] ' + b));
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server boot timeout: ' + buf)), 30000);
    child.stdout.on('data', (b) => {
      buf += String(b);
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, base: 'http://127.0.0.1:' + m[1] }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + buf)); });
  });
}

const stats = (list) => {
  const arr = list.slice().sort((a, b) => a - b);
  if (!arr.length) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const at = (p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return { n: arr.length, mean: arr.reduce((a, b) => a + b, 0) / (arr.length || 1), p50: at(0.5), p95: at(0.95), max: arr[arr.length - 1] };
};

let BASE = '';
// 用 node:http + 共享 keep-alive Agent：全局 fetch(undici) 在本机约 15ms 固定开销，量不到服务端。
let origin = null;
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
function httpCall(method, url, h, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, origin);
    const req = http.request({
      host: origin.hostname, port: origin.port, path: u.pathname + u.search, method, headers: h, agent,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        if (String(res.headers['content-encoding'] || '') === 'gzip') {
          try { body = zlib.gunzipSync(body); } catch (e) { return reject(e); }
        }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function call(method, url, { body, token, deviceId, headers } = {}) {
  const h = Object.assign({ 'accept-encoding': 'gzip' }, device(deviceId || 'bench0'), headers || {});
  if (token) h.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = Buffer.from(JSON.stringify(body)); }
  const res = await httpCall(method, url, h, payload);
  const text = res.body.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(method + ' ' + url + ' -> ' + res.status + ' ' + text.slice(0, 200));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { status: res.status, bytes: Buffer.byteLength(text), json };
}

async function login(players) {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const out = await call('POST', '/api/login', { body: { name: p.name, password: 'pass-a1' }, deviceId: 'bench' + i });
    p.token = out.json.token;
    const st = await call('GET', '/api/state', { token: p.token, deviceId: 'bench' + i });
    p.rev = Number(st.json.rev) || 1;
  }
}

// 场景：run(i) → Promise，i 是递增序号（用来切换要写入的值）。
// `mix: false` = 写操作有资源门槛（体力/每日次数），只放顺序段，避免并发段全是失败请求。
function scenarios(players) {
  const revs = new Map();
  let step = 1;
  const who = (i) => {
    const n = i % players.length;
    return { p: players[n], deviceId: 'bench' + n };
  };
  const track = (r) => {
    const id = Number(r.json && r.json.accountId);
    return r;
  };
  return [
    { name: 'health', run: () => call('GET', '/api/health') },
    { name: 'update', run: () => call('GET', '/api/update') },
    { name: 'meta', run: () => call('GET', '/api/meta') },
    { name: 'static-html', run: () => call('GET', '/') },
    { name: 'static-js', run: () => call('GET', '/js/sim.js') },
    { name: 'static-img', run: () => call('GET', '/images/' + IMG) },
    {
      name: 'state',
      run: (i) => {
        const { p, deviceId } = who(i);
        return call('GET', '/api/state', { token: p.token, deviceId }).then((r) => {
          revs.set(p.id, Number(r.json.rev) || revs.get(p.id) || 1);
          return r;
        });
      },
    },
    {
      name: 'badge', run: (i) => { const { p, deviceId } = who(i); return call('GET', '/api/messages/badge', { token: p.token, deviceId }); },
    },
    {
      name: 'messages', run: (i) => { const { p, deviceId } = who(i); return call('GET', '/api/messages', { token: p.token, deviceId }); },
    },
    {
      name: 'ladder', run: (i) => { const { p, deviceId } = who(i); return call('GET', '/api/ladder', { token: p.token, deviceId }); },
    },
    {
      name: 'opponents', run: (i) => { const { p, deviceId } = who(i); return call('GET', '/api/opponents?kind=random', { token: p.token, deviceId }); },
    },
    {
      name: 'action-write',
      run: (i) => {
        const { p, deviceId } = who(i);
        step = step === 1 ? 2 : 1;
        return call('POST', '/api/action', {
          token: p.token, deviceId, body: { name: 'setTutorialStep', args: [step], rev: revs.get(p.id) || p.rev || 1 },
        }).then((r) => { revs.set(p.id, Number(r.json.rev) || revs.get(p.id)); return r; });
      },
    },
    {
      name: 'snapshot-sync',
      run: (i) => {
        const { p, deviceId } = who(i);
        return call('POST', '/api/snapshot/sync', { token: p.token, deviceId, body: {} })
          .then((r) => { revs.set(p.id, Number(r.json.rev) || revs.get(p.id)); return r; });
      },
    },
    {
      name: 'battle-random', mix: false,
      run: async (i) => {
        const { p, deviceId } = who(i);
        const opp = await call('GET', '/api/opponents?kind=random', { token: p.token, deviceId });
        const target = (opp.json.opponents || []).find((o) => o && o.snapshotId);
        if (!target) throw new Error('no opponent');
        const r = await call('POST', '/api/battle', {
          token: p.token, deviceId,
          body: { kind: 'random', snapshotId: target.snapshotId, rev: revs.get(p.id) || p.rev || 1, idemKey: '' },
        });
        revs.set(p.id, Number(r.json.rev) || revs.get(p.id));
        return r;
      },
    },
  ].filter((s) => !ONLY || s.name.includes(ONLY));
}

async function sequential(base, list, count) {
  const out = [];
  for (const sc of list) {
    const times = [];
    let bytes = 0;
    let err = null;
    for (let i = 0; i < count + 2; i++) {
      const t = process.hrtime.bigint();
      try {
        const r = await sc.run(i);
        bytes = r.bytes;
      } catch (e) { err = e; break; }
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      if (i >= 2) times.push(ms);
    }
    out.push({ name: sc.name, err, bytes, ...stats(times) });
  }
  return out;
}

async function mixed(base, list, conc, durationMs) {
  const until = Date.now() + durationMs;
  let n = 0, errors = 0, bytes = 0;
  const latency = [];
  const pick = () => list[n % list.length];
  const worker = async () => {
    while (Date.now() < until) {
      const sc = pick();
      const t = process.hrtime.bigint();
      try {
        const r = await sc.run(++n);
        bytes += r.bytes;
        latency.push(Number(process.hrtime.bigint() - t) / 1e6);
      } catch (e) { errors++; if (errors < 4) console.error('  ! ' + e.message); }
    }
  };
  const t = Date.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const secs = (Date.now() - t) / 1000;
  return { rps: n / secs, errors, bytesPerReq: bytes / Math.max(1, n), ...stats(latency) };
}

(async () => {
  const players = await seed();
  const { child, base } = await startServer();
  BASE = base;
  origin = new URL(base);
  let code = 0;
  try {
    await login(players);
    console.log('bench base=' + base + ' accounts=' + players.length + ' seq=' + SEQ + ' conc=' + CONC);
    const list = scenarios(players);
    const seq = await sequential(base, list, SEQ);
    console.log('\n== 顺序延迟（毫秒，' + SEQ + ' 次） ==');
    console.log('scenario'.padEnd(16) + 'bytes'.padStart(9) + 'mean'.padStart(9) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'max'.padStart(9));
    for (const r of seq) {
      if (r.err) { console.log(r.name.padEnd(16) + '  FAILED: ' + r.err.message); code = 1; continue; }
      console.log(r.name.padEnd(16) + String(r.bytes).padStart(9) +
        r.mean.toFixed(2).padStart(9) + r.p50.toFixed(2).padStart(9) + r.p95.toFixed(2).padStart(9) + r.max.toFixed(2).padStart(9));
    }
    if (!ONLY) {
      const mix = await mixed(base, list.filter((s) => s.mix !== false && s.name !== 'static-img'), CONC, DURATION);
      console.log('\n== 混合并发（并发 ' + CONC + '，' + DURATION + 'ms） ==');
      console.log('rps=' + mix.rps.toFixed(1) + ' p50=' + mix.p50.toFixed(2) + ' p95=' + mix.p95.toFixed(2) +
        ' errors=' + mix.errors + ' bytes/req=' + Math.round(mix.bytesPerReq));
      if (mix.errors) code = 1;
    }
  } finally {
    child.kill();
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    if (PROF) console.log('\ncpu profile: ' + path.join(OUT, 'bench-prof'));
    cleanup();
  }
  process.exitCode = code;
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
