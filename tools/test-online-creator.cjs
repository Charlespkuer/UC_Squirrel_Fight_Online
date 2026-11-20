#!/usr/bin/env node
'use strict';
/* 创作者设备白名单：只按设备指纹发卡，允许浏览器端、注册名额与一机多号；
 * 普通设备仍受浏览器端限制、注册名额与「同设备最多 3 个账号」约束。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_creator-api-'));
process.env.DATA_DIR = DATA;
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.LOG_LEVEL = 'warn';
process.env.ALLOW_BROWSER_DEVICES = 'false';
process.env.ACCOUNTS_PER_IP = '0';
process.env.ACCOUNT_DAILY_LIMIT = '0'; // 本套件同 IP 连开多个测试号；每日闸门在 test-online-api 里单独验。
process.env.REGISTRATION_LIMIT = '1000';
// 主人面板：同一回环 IP 下，只有创作者设备能看到；普通设备即使同 IP 也必须 owner:false。
process.env.OWNER_IPS = '127.0.0.1,::1';

const hashOf = (platform, id) => crypto.createHash('sha256').update(platform + '\0' + id).digest('hex');
const CREATOR_BROWSER_ID = 'c'.repeat(64);
const CREATOR_NATIVE_ID = 'f'.repeat(64);
const NORMAL_BROWSER_ID = 'd'.repeat(64);
const NORMAL_NATIVE_ID = 'e'.repeat(64);
process.env.CREATOR_DEVICES = [hashOf('browser', CREATOR_BROWSER_ID), hashOf('windows', CREATOR_NATIVE_ID)].join(',');

const { start } = require('../server/index.js');
const db = require('../server/db');

let BASE = '', running = null;
function cleanup() {
  try { if (running) running.close(); } catch (_) {}
  try { db.close(); } catch (_) {}
  if (path.dirname(DATA) !== OUT || !path.basename(DATA).startsWith('_creator-api-')) throw new Error('invalid test data path');
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function call(method, url, body, device, token) {
  const headers = { 'content-type': 'application/json' };
  if (device) {
    headers['x-device-id'] = device.id;
    headers['x-device-platform'] = device.platform;
    headers['x-device-provider'] = device.provider;
  }
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

const browser = (id) => ({ id, platform: 'browser', provider: 'installation' });
const native = (id) => ({ id, platform: 'windows', provider: 'machine-guid' });

(async () => {
  const started = await start(0);
  running = started.server;
  BASE = 'http://127.0.0.1:' + started.port;

  let r = await call('POST', '/api/register', { name: '普通浏览器', password: 'pass-1' }, browser(NORMAL_BROWSER_ID));
  assert.equal(r.status, 403, '普通浏览器设备必须被拒');
  assert.equal(r.body.error.code, 'DEVICE_UNSUPPORTED');

  const normalTokens = [];
  for (let i = 1; i <= 3; i++) {
    r = await call('POST', '/api/register', { name: '普通' + i + '号', password: 'pass-' + i }, native(NORMAL_NATIVE_ID));
    assert.equal(r.status, 200, '普通原生设备第 ' + i + ' 个账号注册通过（限额 3）');
    normalTokens.push(r.body.token);
  }

  r = await call('POST', '/api/register', { name: '普通4号', password: 'pass-4' }, native(NORMAL_NATIVE_ID));
  assert.equal(r.status, 403, '普通设备第 4 个账号必须被拒');
  assert.equal(r.body.error.code, 'DEVICE_ACCOUNT_LIMIT');

  r = await call('GET', '/api/device/quota', undefined, native(NORMAL_NATIVE_ID), normalTokens[0]);
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 3, '设置页额度：已创建 3 个');
  assert.equal(r.body.limit, 3, '设置页额度：上限 3');

  for (let i = 1; i <= 7; i++) {
    r = await call('POST', '/api/register', { name: '创作浏览器' + i, password: 'pass-1' }, browser(CREATOR_BROWSER_ID));
    assert.equal(r.status, 200, '创作者浏览器第 ' + i + ' 个账号应成功（绕过 6 次/时限流与设备额度）');
  }
  r = await call('POST', '/api/login', { name: '创作浏览器7', password: 'pass-1' }, browser(CREATOR_BROWSER_ID));
  assert.equal(r.status, 200, '创作者设备可以登录同设备的其它测试号');
  assert.ok(r.body.token);
  const creatorToken = r.body.token;

  /* 主人面板（开发者同步）不能只看 IP：同一回环 IP 的普通设备也必须被挡。 */
  const ownerCreator = await call('GET', '/api/owner/status', undefined, browser(CREATOR_BROWSER_ID), creatorToken);
  assert.equal(ownerCreator.status, 200);
  assert.equal(ownerCreator.body.owner, true, '创作者设备 + 主人 IP 才看得到开发者同步');
  const ownerNormal = await call('GET', '/api/owner/status', undefined, native(NORMAL_NATIVE_ID), normalTokens[0]);
  assert.equal(ownerNormal.status, 200);
  assert.equal(ownerNormal.body.owner, false, '普通设备即使同主人 IP 也不能看到开发者同步');

  console.log('PASS test-online-creator（创作者设备不受限；普通设备最多 3 个账号、第 4 个拒绝、额度 x/y 正确；主人面板只给创作者设备）');
})().then(cleanup, (e) => { console.error(e); cleanup(); process.exitCode = 1; });
