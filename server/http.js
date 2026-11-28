'use strict';

const zlib = require('node:zlib');
const net = require('node:net');
const { config } = require('./config');

const STATUS_BY_CODE = {
  AUTH: 401,
  SESSION_KICKED: 401,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT: 429,
  ACCOUNT_DAILY_LIMIT: 429,
  SAVE_INVALID: 422,
  PAYLOAD_TOO_LARGE: 413,
  SERVER: 500,
  UNAVAILABLE: 503,
  DEVICE_REQUIRED: 403,
  DEVICE_MISMATCH: 403,
  DEVICE_BOUND: 403,
  DEVICE_ACCOUNT_LIMIT: 403,
  DEVICE_UNSUPPORTED: 403,
};

class ApiError extends Error {
  constructor(code, msg, extra) {
    super(msg || code);
    this.code = code || 'SERVER';
    this.status = STATUS_BY_CODE[this.code] || 500;
    this.extra = extra || null;
  }
}

const fail = (code, msg, extra) => new ApiError(code, msg, extra);

// 允许来源在进程启动时拆一次：这个函数每个请求都要跑，别再每请求 split 一遍配置串。
const ALLOW_ANY_ORIGIN = config.allowOrigin === '*';
const ALLOW_ORIGIN_LIST = ALLOW_ANY_ORIGIN
  ? []
  : String(config.allowOrigin || '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-client-version,x-device-id,x-device-platform,x-device-provider',
    'access-control-max-age': '600',
  };
  if (ALLOW_ANY_ORIGIN) headers['access-control-allow-origin'] = '*';
  else if (origin && ALLOW_ORIGIN_LIST.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  return headers;
}

function writeJson(res, status, headers, buf) {
  headers['content-length'] = String(buf.length);
  try { res.writeHead(status, headers); res.end(buf); } catch (_) {}
}

function sendJson(res, status, obj, req) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const accept = String((req && req.headers['accept-encoding']) || '');
  if (buf.length <= 1024 || !/\bgzip\b/.test(accept)) { writeJson(res, status, headers, buf); return; }
  // 大响应交给线程池压缩：`gzipSync` 会把事件循环堵在压缩里（战斗/榜单响应越大越明显）。
  zlib.gzip(buf, { level: 6 }, (err, out) => {
    if (err || res.headersSent || res.writableEnded) { if (!res.headersSent) writeJson(res, status, headers, buf); return; }
    headers['content-encoding'] = 'gzip';
    writeJson(res, status, headers, out);
  });
}

function sendError(res, err, req) {
  const code = err && err.code && STATUS_BY_CODE[err.code] ? err.code : 'SERVER';
  const status = err && err.status ? err.status : (STATUS_BY_CODE[code] || 500);
  const body = { ok: false, error: { code, msg: status >= 500 && code === 'SERVER' ? '服务器错误' : String((err && err.message) || '服务器错误') } };
  if (err && err.extra) body.error.extra = err.extra;
  if (status >= 500 && code === 'SERVER') console.error('[api] 500', err && err.stack ? err.stack : err);
  sendJson(res, status, body, req);
}

// 读请求体（支持 gzip / deflate），带体积上限。
function readBody(req, limit) {
  const cap = limit || config.maxBodyBytes;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > cap) { reject(fail('PAYLOAD_TOO_LARGE', '请求体过大')); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, buf) => { if (done) return; done = true; err ? reject(err) : resolve(buf); };
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { finish(fail('PAYLOAD_TOO_LARGE', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf, { maxOutputLength: cap });
        else if (enc === 'deflate') buf = zlib.inflateSync(buf, { maxOutputLength: cap });
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf, { maxOutputLength: cap });
      } catch (e) { finish(fail('BAD_REQUEST', '请求体解压失败')); return; }
      finish(null, buf);
    });
    req.on('error', (e) => finish(fail('BAD_REQUEST', '读取请求体失败: ' + e.message)));
    req.on('aborted', () => finish(fail('BAD_REQUEST', '请求中断')));
  });
}

const JSON_LIMIT = 256 * 1024;

async function readJson(req, limit) {
  const buf = await readBody(req, limit || JSON_LIMIT);
  if (!buf.length) return {};
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw fail('BAD_REQUEST', '不是合法的 JSON');
  }
  if (parsed == null || typeof parsed !== 'object') throw fail('BAD_REQUEST', '请求体必须是 JSON 对象');
  return parsed;
}

const buckets = new Map();
const paces = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = buckets.get(key) || [];
  while (list.length && now - list[0] > windowMs) list.shift();
  if (list.length >= max) {
    buckets.set(key, list);
    const retry = Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000));
    throw fail('RATE_LIMIT', '请求太频繁，请 ' + retry + ' 秒后再试', { retryAfter: retry });
  }
  list.push(now);
  buckets.set(key, list);

  if (buckets.size > 4096) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs * 4) buckets.delete(k);
    }
  }
}

// 同一账号同一入口的最小间隔：给「连点器把按钮当自动连发」加一道服务端闸门。
// token 是客户端可重放的幂等键（战斗的 idemKey）：同一 token 的断线重试必须放行，
// 否则响应丢了客户端就永远拿不到那场结果。返回的 commit 由调用方在「真正成功」后执行，
// 失败请求（体力不足 / 参数不对）不占冷却，否则玩家补完体力还要再等。
function pace(key, minMs, token) {
  const wait = Number(minMs) || 0;
  if (!(wait > 0)) return () => {};
  const now = Date.now();
  const last = paces.get(key);
  const same = !!(token && last && last.token === String(token));
  if (last && !same && now - last.at < wait) {
    const retry = Math.max(1, Math.ceil((wait - (now - last.at)) / 1000));
    throw fail('RATE_LIMIT', '操作太快了，请 ' + retry + ' 秒后再试', { retryAfter: retry });
  }
  if (same) return () => {};
  return () => {
    paces.set(key, { at: Date.now(), token: token ? String(token) : '' });
    if (paces.size > 4096) {
      for (const [k, v] of paces) if (now - v.at > wait * 4) paces.delete(k);
    }
  };
}

function clientIp(req) {
  const normalize = value => {
    const ip = String(value || '').trim().replace(/^::ffff:(?=\d+\.)/i, '');
    return net.isIP(ip) ? ip : '';
  };
  const loopback = ip => ip === '::1' || /^127\./.test(ip);
  const peer = normalize(req.socket && req.socket.remoteAddress);
  if (config.trustProxy && loopback(peer)) {
    const header = String(req.headers['x-forwarded-for'] || '');
    const chain = header.length <= 2048 ? header.split(',').map(normalize) : [];
// 仅 loopback 是可信代理；从右侧剥掉可信跳，不接受客户端塞在左侧的伪地址。
    if (chain.length && chain.every(Boolean)) {
      for (let i = chain.length - 1; i >= 0; i--) if (!loopback(chain[i])) return chain[i];
    }
  }
  return peer;
}

// 简单路径匹配：'/api/combat/:id' → { id }
function matchPath(pattern, pathname) {
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      if (!s[i]) return null;
      params[p[i].slice(1)] = decodeURIComponent(s[i]);
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

module.exports = {
  ApiError, fail, sendJson, sendError, corsHeaders,
  readBody, readJson, rateLimit, pace, clientIp, matchPath, STATUS_BY_CODE,
};
