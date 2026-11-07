'use strict';
/* 联机师徒端到端：拜师人机 / 收真人徒弟（打师父或本人）/ 真人日供 / 逐出 / 出师。
 * 只跑本进程临时库，不依赖外部服务。 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const OUT = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_apprentice-api-'));
process.env.DATA_DIR = DATA;
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.LOG_LEVEL = 'warn';
process.env.ALLOW_BROWSER_DEVICES = 'true';
process.env.ACCOUNTS_PER_IP = '0'; // 本地测试同 IP，关闭 IP 额度避免测试号互挤

const { start } = require('../server/index.js');
const db = require('../server/db');
const store = require('../server/game/store');
const apprentice = require('../server/game/apprentice');

let BASE = '';
let running = null;
function cleanup() {
  if (running) running.close();
  db.close();
  if (path.dirname(DATA) !== OUT || !path.basename(DATA).startsWith('_apprentice-api-')) return;
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const device = (id) => ({ 'x-device-id': id.padEnd(32, '_'), 'x-device-platform': 'browser', 'x-device-provider': 'installation' });
const devices = { 甲鼠: device('qa-ap-a'), 乙鼠: device('qa-ap-b'), 丙鼠: device('qa-ap-c') };
const tokenDevices = new Map();
async function call(method, url, body, token) {
  const who = tokenDevices.get(token) || devices[body && body.name] || device('qa-ap-a');
  const headers = { 'content-type': 'application/json', ...who };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + JSON.stringify(json && json.error));
    err.status = res.status; err.body = json;
    throw err;
  }
  if (json && json.token) tokenDevices.set(json.token, devices[body && body.name] || device('qa-ap-a'));
  return json;
}
function expectError(fn, status, label) {
  return fn().then(() => { throw new Error(label + '：应当失败'); }, (e) => {
    assert.equal(e.status, status, label + '：期望 HTTP ' + status + '，实际 ' + e.status + ' ' + e.message);
  });
}
async function levelUp(token, accountId, level, power) {
  db.tx(() => store.runOnSave(accountId, ({ save }) => {
    save.level = level;
    if (power) { save.power = power; save.maxHp = 200000; save.hp = 200000; }
  }, { snapshotSource: 'apprentice-test' }));
  await call('POST', '/api/snapshot/sync', {}, token);
}
/** 永久属性总和必须 ≤ 651，直接写大数会被 clamp；这里按合法总值写。 */
async function setStats(token, accountId, stats) {
  db.tx(() => store.runOnSave(accountId, ({ save }) => {
    save.power = stats.power; save.agility = stats.agility;
    save.speed = stats.speed; save.maxHp = stats.hp;
  }, { snapshotSource: 'apprentice-test' }));
  await call('POST', '/api/snapshot/sync', {}, token);
}

async function main() {
  const server = await start(0);
  running = server.server;
  BASE = 'http://127.0.0.1:' + server.port;

  const A = await call('POST', '/api/register', { name: '甲鼠', password: 'pass-a1' });
  const B = await call('POST', '/api/register', { name: '乙鼠', password: 'pass-b1' });
  const C = await call('POST', '/api/register', { name: '丙鼠', password: 'pass-c1' });
  const idA = A.profile.account.accountId, idB = B.profile.account.accountId, idC = C.profile.account.accountId;

  const state = (token) => call('GET', '/api/state', undefined, token);
  const ap = (token) => call('GET', '/api/apprentice', undefined, token);
  const cands = (token) => call('GET', '/api/apprentice/candidates', undefined, token);

  /* 1. 拜人机师父：候选由服务端生成，选中后学会师父驾到；已有师父不能再拜。 */
  const candA = await cands(A.token);
  assert.equal(candA.masters.length, 3, '应生成 3 位人机师父');
  assert.ok(candA.masters.every((m) => m.name && m.level >= 3), '候选要有名字和等级');
  const stA0 = await state(A.token);
  const botMaster = await call('POST', '/api/apprentice/master', { index: 1, rev: stA0.rev }, A.token);
  assert.equal(botMaster.ok, true);
  assert.equal(botMaster.master.bot, true);
  const stA1 = await state(A.token);
  assert.ok(stA1.save.master && stA1.save.master.bot === true, '存档要记下人机师父');
  assert.ok(stA1.save.skills.some((s) => Number(String(s).split(':')[0]) === 13), '拜师后学会师父驾到');
  await expectError(() => call('POST', '/api/apprentice/master', { index: 0, rev: stA1.rev }, A.token), 409, '已有师父再拜师');

  /* 2. 出师：扣 20 金松果，师父与师徒表一起清掉。 */
  const beforeLeave = await state(A.token);
  const left = await call('POST', '/api/apprentice/leave', { rev: beforeLeave.rev }, A.token);
  assert.equal(left.ok, true);
  const afterLeave = await state(A.token);
  assert.equal(afterLeave.save.master, null);
  assert.equal(afterLeave.save.goldPoint, beforeLeave.save.goldPoint - 20);
  assert.equal((await ap(A.token)).master, null);
  await expectError(() => call('POST', '/api/apprentice/leave', { rev: afterLeave.rev }, A.token), 409, '没有师父时出师');

  /* 3. 收真人徒弟：丙先收乙（乙没有师父，直接打乙本人）；甲再收乙时要先打乙的师父丙。 */
  await levelUp(C.token, idC, 60, 0);
  await setStats(C.token, idC, { power: 500, agility: 50, speed: 50, hp: 255 });
  await levelUp(B.token, idB, 20, 0);
  await levelUp(A.token, idA, 20, 0);
  const stC = await state(C.token);
  const cRecruit = await call('POST', '/api/apprentice/recruit', { targetAccountId: idB, rev: stC.rev }, C.token);
  assert.equal(cRecruit.ok, true);
  assert.equal(cRecruit.settlement.via, 'self', '乙没有师父，直接挑战本人');
  assert.equal(cRecruit.settlement.recruited, true, '丙应能收下乙');
  const stB1 = await state(B.token);
  assert.equal(stB1.save.master && stB1.save.master.accountId, idC, '乙的师父应是丙');
  assert.equal((await ap(C.token)).prentices.length, 1, '丙的徒弟列表应有乙');

  /* 候选列表要能看到「有师父的乙」，并标出要先打丙。 */
  const candsA = await cands(A.token);
  const bCand = candsA.prentices.find((p) => p.accountId === idB);
  assert.ok(bCand, '有师父的乙也应出现在可收服候选里');
  assert.equal(bCand.master && bCand.master.accountId, idC, '候选要标出乙的师父是丙');

  /* 丙放水：把师父面板降到 1 级、最低属性，保证「先打师父」这一场能稳定打赢。 */
  await levelUp(C.token, idC, 1, 0);
  await setStats(C.token, idC, { power: 1, agility: 1, speed: 1, hp: 5 });
  await levelUp(A.token, idA, 60, 0);

  const stA2 = await state(A.token);
  const aRecruit = await call('POST', '/api/apprentice/recruit', { targetAccountId: idB, rev: stA2.rev }, A.token);
  assert.equal(aRecruit.ok, true);
  assert.equal(aRecruit.settlement.via, 'master', '乙有师父时必须先打他的师父');
  assert.equal(aRecruit.settlement.masterAccountId, idC);
  assert.equal(aRecruit.settlement.recruited, true, '甲打赢丙后应把乙收过来');
  const stB2 = await state(B.token);
  assert.equal(stB2.save.master && stB2.save.master.accountId, idA, '乙的师父应换成甲');
  assert.ok(stB2.save.skills.some((s) => Number(String(s).split(':')[0]) === 13), '被收为徒后学会师父驾到');
  assert.equal((await ap(C.token)).prentices.length, 0, '乙被收走后要从丙的徒弟列表移除');
  const listA = await ap(A.token);
  assert.equal(listA.prentices.length, 1);
  assert.equal(listA.prentices[0].accountId, idB);
  const bRecruitMsg = (await call('GET', '/api/messages', undefined, B.token)).messages.find((m) => m.kind === 'apprentice');
  assert.ok(bRecruitMsg && bRecruitMsg.payload && bRecruitMsg.payload.win === false,
    '徒弟要收到师徒消息，并带被收徒这一场的胜负');

  /* 4. 真人日供：只按徒弟昨日的经验/金松果各 10%，同一天只能领一次。 */
  const yesterday = apprentice.yesterday();
  db.tx(() => store.runOnSave(idB, ({ save }) => {
    save.earnHistory = [{ date: yesterday, exp: 1000, gold: 500 }];
  }));
  db.run('UPDATE apprenticeships SET since_date = ?, last_tribute_date = ? WHERE prentice_id = ?',
    apprentice.previousDate(yesterday), '', idB);
  const beforeTribute = await state(A.token);
  const beforeB = await state(B.token);
  const tribute = await call('POST', '/api/apprentice/tribute', { rev: beforeTribute.rev }, A.token);
  assert.equal(tribute.ok, true);
  assert.equal(tribute.totalExp, 100, '徒弟昨日 1000 经验 → 师父 100');
  assert.equal(tribute.totalGold, 50, '徒弟昨日 500 金松果 → 师父 50');
  const afterTribute = await state(A.token);
  assert.equal(afterTribute.save.goldPoint, beforeTribute.save.goldPoint + 50);
  assert.equal(afterTribute.save.exp, beforeTribute.save.exp + 100);
  assert.equal((await state(B.token)).save.exp, beforeB.save.exp, '徒弟自己的经验不能被扣');
  const againTribute = await call('POST', '/api/apprentice/tribute', { rev: afterTribute.rev }, A.token);
  assert.equal(againTribute.ok, false, '同一天不能重复领取');

  /* 5. 逐出师门：每天一次，乙的师父被清空。 */
  const stA3 = await state(A.token);
  const kicked = await call('POST', '/api/apprentice/kick', { targetAccountId: idB, rev: stA3.rev }, A.token);
  assert.equal(kicked.ok, true);
  assert.equal((await ap(A.token)).prentices.length, 0);
  assert.equal((await state(B.token)).save.master, null, '被逐出的徒弟不再有师父');
  await expectError(() => call('POST', '/api/apprentice/kick', { targetAccountId: idC, rev: kicked.rev }, A.token), 409, '同一天踢第二次');

  console.log('PASS 联机师徒：拜师人机 / 打师父收徒 / 真人日供 10%+10% / 逐出 / 出师');
}

main().then(() => { cleanup(); }, (e) => { console.error(e); cleanup(); process.exitCode = 1; });
