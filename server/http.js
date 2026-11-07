'use strict';
/* ============================================================
 * server/http.js — JSON 收发 / 错误 / 限流 / gzip
 * ============================================================ */

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

function corsHeaders(req) {
  const allow = config.allowOrigin;
  const origin = req.headers.origin;
  const headers = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-client-version,x-device-id,x-device-platform,x-device-provider',
    'access-control-max-age': '600',
  };
  if (allow === '*') headers['access-control-allow-origin'] = '*';
  else if (origin && allow.split(',').map((s) => s.trim()).includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  return headers;
}

/** 发 JSON；body 大于阈值时 gzip（浏览器 fetch 会自动解开）。 */
function sendJson(res, status, obj, req) {
  let text = JSON.stringify(obj);
  let buf = Buffer.from(text, 'utf8');
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const accept = String((req && req.headers['accept-encoding']) || '');
  if (buf.length > 1024 && /\bgzip\b/.test(accept)) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = String(buf.length);
  res.writeHead(status, headers);
  res.end(buf);
}

function sendError(res, err, req) {
  const code = err && err.code && STATUS_BY_CODE[err.code] ? err.code : 'SERVER';
  const status = err && err.status ? err.status : (STATUS_BY_CODE[code] || 500);
  const body = { ok: false, error: { code, msg: status >= 500 && code === 'SERVER' ? '服务器错误' : String((err && err.message) || '服务器错误') } };
  if (err && err.extra) body.error.extra = err.extra;
  if (status >= 500 && code === 'SERVER') console.error('[api] 500', err && err.stack ? err.stack : err);
  sendJson(res, status, body, req);
}

/** 读请求体（支持 gzip / deflate），带体积上限。 */
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

/* ---------------- 内存滑窗限流 ---------------- */
const buckets = new Map();

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
  /* 周期性清理，避免内存长尾巴 */
  if (buckets.size > 4096) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs * 4) buckets.delete(k);
    }
  }
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

/** 简单路径匹配：'/api/combat/:id' → { id } */
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
  readBody, readJson, rateLimit, clientIp, matchPath, STATUS_BY_CODE,
};
