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
process.env.FIGHT_INTERVAL_MS = '0'; // 本套件连续打切磋场，连点闸门在别处测

const { start } = require('../server/index.js');
const db = require('../server/db');
const store = require('../server/game/store');
const apprentice = require('../server/game/apprentice');
const fighter = require('../server/game/fighter');
const snapshots = require('../server/game/snapshot');
const { localDate } = require('../server/config');

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

  /* 师父升级后，徒弟进战斗前请求刷新：只同步「师父驾到」用的等级，并落回权威存档。 */
  await levelUp(C.token, idC, 55, 0);
  const refreshed = await call('POST', '/api/apprentice/refresh', {}, B.token);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.master && refreshed.master.level, 55, '刷新接口应返回师父当前等级');
  assert.equal((await state(B.token)).save.master.level, 55, '徒弟存档的师父等级要立即更新');

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
  /* 师徒页与「查看」按当前存档实时算：防守快照落后时也不能显示旧属性。 */
  db.tx(() => store.runOnSave(idB, ({ save }) => {
    save.level = 33; save.power = 321; save.maxHp = 777;
    save.dailyStatsDate = localDate(); save.dailyWins = 7; save.dailyFails = 3;
    save.allWins = 70; save.allFails = 30;
  }));
  const liveListA = await ap(A.token);
  assert.equal(liveListA.prentices[0].stats.power, 321, '徒弟属性按当前存档下发，不读可能落后的防守快照');
  const livePreviewB = await call('GET', '/api/fighter?accountId=' + idB, undefined, A.token);
  assert.equal(livePreviewB.fighter.power, 321, '好友页「查看」按账号取实时面板');
  /* 状态页的胜率 / 场次也读同一份实时存档；日计数跨天没战斗时不能把昨天的人头带出来。 */
  assert.equal(livePreviewB.dailyWins, 7, '好友页「查看」实时下发今日胜场');
  assert.equal(livePreviewB.allWins + livePreviewB.allFails, 100, '好友页「查看」实时下发累计场次');
  const liveFriendsA = await call('GET', '/api/friends', undefined, A.token);
  const liveRowB = liveFriendsA.friends.find((f) => Number(f.accountId) === idB);
  assert.equal(liveRowB && liveRowB.dailyWins, 7, '好友名单也要带实时今日胜场（查看失败时不回落到 0）');
  assert.equal(liveRowB && liveRowB.allWins, 70, '好友名单也要带实时累计场次');
  db.tx(() => store.runOnSave(idB, ({ save }) => { save.dailyStatsDate = '2000-01-01'; }));
  const stalePreviewB = await call('GET', '/api/fighter?accountId=' + idB, undefined, A.token);
  assert.equal(stalePreviewB.dailyWins, 0, '好友跨天还没战斗时今日胜场要从 0 算');
  assert.equal(stalePreviewB.allWins, 70, '累计场次跨天不清零');
  /* 高等级徒弟 + 旧档缺镜像：师父存档里没有 `prentices` 行时，
   * `/api/state` 要按当前存档补出面板，关卡也要让这个徒弟先上阵；不能退回师父。 */
  await levelUp(B.token, idB, 65, 0);
  db.tx(() => store.runOnSave(idA, ({ save }) => {
    save.prentices = [];
    save.props = Object.assign({}, save.props, { 23: 5 });
  }, { snapshotSource: 'apprentice-test' }));
  const stHigh = await state(A.token);
  assert.ok(stHigh.save.prentices.some((p) => Number(p.accountId) === idB && Number(p.level) === 65),
    '缺镜像的真人徒弟要按当前存档补进师父面板');
  const highStage = await call('POST', '/api/battle', { kind: 'stage', stageId: 1, rev: stHigh.rev }, A.token);
  assert.equal(highStage.stage && highStage.stage.role, 'prentice', '等级高于师父的徒弟也要在关卡先上阵');
  assert.equal(highStage.me && highStage.me.level, 65, '关卡战斗面板要用徒弟当前等级');
  assert.ok((await state(A.token)).save.prentices.some((p) => Number(p.accountId) === idB && Number(p.level) === 65),
    '关卡开打后师父存档镜像要补回徒弟');
  const bRecruitMsg = (await call('GET', '/api/messages', undefined, B.token)).messages.find((m) => m.kind === 'apprentice');
  assert.ok(bRecruitMsg && bRecruitMsg.payload && bRecruitMsg.payload.win === false,
    '徒弟要收到师徒消息，并带被收徒这一场的胜负');

  /* 师徒默认成为好友；删好友不拆师徒，师徒仍能互相切磋（按快照或账号 id 都能开打）。 */
  const friendsA = await call('GET', '/api/friends', undefined, A.token);
  const friendsB = await call('GET', '/api/friends', undefined, B.token);
  assert.ok(friendsA.friends.some((f) => Number(f.accountId) === idB), '收徒后师父好友列表要有徒弟');
  assert.ok(friendsB.friends.some((f) => Number(f.accountId) === idA), '收徒后徒弟好友列表要有师父');
  const saveKinA = await state(A.token), saveKinB = await state(B.token);
  assert.ok((saveKinA.save.friends || []).some((f) => Number(f.accountId || f.remoteId) === idB),
    '师父存档好友镜像也要有徒弟');
  assert.ok((saveKinB.save.friends || []).some((f) => Number(f.accountId || f.remoteId) === idA),
    '徒弟存档好友镜像也要有师父');
  const snapB = snapshots.currentSnapshot(idB, 'classic');
  assert.ok(snapB && snapB.id, '徒弟应有当前战斗快照');
  const kinSpar = await call('POST', '/api/battle',
    { kind: 'friend', snapshotId: snapB.id, rev: (await state(A.token)).rev, idemKey: 'kin-spar-friend' }, A.token);
  assert.equal(kinSpar.ok, true, '师徒成为好友后能切磋');
  await call('DELETE', '/api/friends/' + idB, undefined, A.token);
  assert.equal((await call('GET', '/api/friends', undefined, A.token)).friends.some((f) => Number(f.accountId) === idB), false,
    '删好友后好友列表不再有徒弟');
  assert.equal((await ap(A.token)).prentices.length, 1, '删好友不能拆师徒（师父侧）');
  assert.equal((await ap(B.token)).master && (await ap(B.token)).master.accountId, idA, '删好友不能拆师徒（徒弟侧）');
  const kinSparById = await call('POST', '/api/battle',
    { kind: 'friend', snapshotId: String(idB), rev: (await state(A.token)).rev, idemKey: 'kin-spar-account' }, A.token);
  assert.equal(kinSparById.ok, true, '删除好友后师徒仍能按账号 id 切磋');
  assert.equal(apprentice.backfillFriendships(), 0, '删掉的师徒好友不会被启动补齐重新加回');

  /* 师徒也是社交关系：没有好友关系也能互相留言（好友页「留言」/ 消息页 tab4）。 */
  await call('POST', '/api/board', { toId: idB, text: '徒弟，晚上切磋' }, A.token);
  const kinBoardB = await call('GET', '/api/board', undefined, B.token);
  assert.ok(kinBoardB.messages.some((m) => m.text === '徒弟，晚上切磋' && m.from.accountId === idA),
    '师父应能给徒弟留言');
  await call('POST', '/api/board', { toId: idA, text: '好的师父' }, B.token);
  const kinBoardA = await call('GET', '/api/board', undefined, A.token);
  assert.ok(kinBoardA.messages.some((m) => m.text === '好的师父' && m.from.accountId === idB),
    '徒弟也应能给师父留言');

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

  /* 4b. 收徒次日起算：收徒当天已经过完，次日要能领到这一天的日供（不能当成“今天刚收”）。 */
  db.run('UPDATE apprenticeships SET since_date = ?, last_tribute_date = ? WHERE prentice_id = ?',
    yesterday, '', idB);
  const recruitDay = apprentice.tributeOf(apprentice.rowFor(idB));
  assert.equal(recruitDay.newPrentice, false, '收徒当天已经过完，次日应结算');
  assert.equal(recruitDay.exp, 100, '收徒当天的经验也要计入');
  assert.equal(recruitDay.gold, 50, '收徒当天的金松果也要计入');
  assert.equal(recruitDay.claimable, true);

  /* 4c. 邮件金松果是赠送，不是当日个人收益：不能写进 earnHistory，也不能折算成师傅日供。 */
  db.tx(() => store.runOnSave(idB, ({ save }) => { save.earnHistory = []; }));
  db.run('INSERT INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
    'qa-ap-mail-gold', idB, 'announcement', '测试奖励邮件', JSON.stringify({ claimable: true, gold: 500 }), Date.now());
  const beforeMail = await state(B.token);
  const mailClaim = await call('POST', '/api/messages/claim', { id: 'qa-ap-mail-gold' }, B.token);
  assert.equal(mailClaim.ok, true);
  assert.equal(mailClaim.already, false);
  assert.equal((await state(B.token)).save.goldPoint, beforeMail.save.goldPoint + 500, '邮件金松果要入账');
  const mailEarn = (store.peek(idB).earnHistory || []).filter((d) => d && Number(d.gold) > 0);
  assert.equal(mailEarn.length, 0, '邮件金松果不能记进当日收益');
  db.run('UPDATE apprenticeships SET since_date = ?, last_tribute_date = ? WHERE prentice_id = ?',
    yesterday, '', idB);
  const mailTribute = apprentice.tributeOf(apprentice.rowFor(idB));
  assert.equal(mailTribute.gold, 0, '邮件金松果不能折算成师傅日供');
  assert.equal(mailTribute.claimable, false, '只有邮件收益时没有可领的日供');

  /* 4d. 每位徒弟每日日供上限：经验 1000、金松果 300。 */
  db.tx(() => store.runOnSave(idB, ({ save }) => {
    save.earnHistory = [{ date: yesterday, exp: 50000, gold: 10000 }];
  }));
  db.run('UPDATE apprenticeships SET since_date = ?, last_tribute_date = ? WHERE prentice_id = ?',
    yesterday, '', idB);
  const cappedTribute = apprentice.tributeOf(apprentice.rowFor(idB));
  assert.equal(cappedTribute.exp, 1000, '徒弟日供经验上限 1000');
  assert.equal(cappedTribute.gold, 300, '徒弟日供金松果上限 300');
  const beforeCapClaim = await state(A.token);
  const capClaim = await call('POST', '/api/apprentice/tribute', { rev: beforeCapClaim.rev }, A.token);
  assert.equal(capClaim.totalExp, 1000, '领取接口也要按经验上限结算');
  assert.equal(capClaim.totalGold, 300, '领取接口也要按金松果上限结算');

  /* 5. 徒弟加油：每个徒弟一次、随机锁一项属性 +5%；只叠加到师父主动战斗，
   *    防守快照不烘入；徒弟换师父后加成跟到新师父，旧师父自然失效。 */
  const cheer1 = await call('POST', '/api/apprentice/cheer', undefined, B.token);
  assert.equal(cheer1.ok, true);
  assert.equal(cheer1.already, false);
  assert.ok(['power', 'agility', 'speed'].includes(cheer1.stat), '加油应随机锁定一项三属性');
  const cheerAgain = await call('POST', '/api/apprentice/cheer', undefined, B.token);
  assert.equal(cheerAgain.already, true, '同一徒弟重复加油只回原结果');
  assert.equal(cheerAgain.stat, cheer1.stat);
  const cheerMessages = async () => (await call('GET', '/api/messages', undefined, A.token)).messages
    .filter((m) => m.kind === 'apprentice' && /为你加油/.test(String(m.text || '')));
  const cheerMsg1 = await cheerMessages();
  assert.equal(cheerMsg1.length, 1, '师父应收到一条加油消息');
  assert.ok(String(cheerMsg1[0].text).includes(cheer1.statLabel), '消息要写明提升的属性');
  await call('POST', '/api/apprentice/cheer', undefined, B.token);
  assert.equal((await cheerMessages()).length, 1, '重复加油不应重复发消息');
  const plain = db.tx(() => store.runOnSave(idA, () => fighter.fighterFromState({ useProps: false })).value);
  const buffed = db.tx(() => store.runOnSave(idA, () => fighter.fighterFromState({ useProps: false, cheerAccountId: idA })).value);
  assert.equal(buffed[cheer1.stat], Math.round(plain[cheer1.stat] * 1.05), '主动战斗按 5% 叠加');
  for (const stat of ['power', 'agility', 'speed']) {
    if (stat !== cheer1.stat) assert.equal(buffed[stat], plain[stat], '只加随机锁定的那一项');
  }
  const defenseSnap = snapshots.currentSnapshot(idA, 'classic');
  assert.ok(defenseSnap && Number(defenseSnap.fighter[cheer1.stat]) === Number(plain[cheer1.stat]),
    '防守快照不能烘入徒弟加油');

  /* 6. 逐出师门：每天一次，乙的师父被清空。 */
  const stA3 = await state(A.token);
  const kicked = await call('POST', '/api/apprentice/kick', { targetAccountId: idB, rev: stA3.rev }, A.token);
  assert.equal(kicked.ok, true);
  assert.equal((await ap(A.token)).prentices.length, 0);
  assert.equal((await state(B.token)).save.master, null, '被逐出的徒弟不再有师父');
  await expectError(() => call('POST', '/api/apprentice/kick', { targetAccountId: idC, rev: kicked.rev }, A.token), 409, '同一天踢第二次');

  /* 7. 乙换师父：踢出后乙没有师父；让丙重新收乙，加油应自动跟到丙。 */
  await levelUp(C.token, idC, 60, 0);
  await setStats(C.token, idC, { power: 500, agility: 50, speed: 50, hp: 200000 });
  const stC2 = await state(C.token);
  const cRecruitB = await call('POST', '/api/apprentice/recruit', { targetAccountId: idB, rev: stC2.rev }, C.token);
  assert.equal(cRecruitB.settlement.recruited, true, '丙应重新收下乙');
  const listC = await ap(C.token);
  assert.equal(listC.prentices[0].cheer && listC.prentices[0].cheer.stat, cheer1.stat, '加油记录跟徒弟走');
  assert.equal(listC.oiling.count, 1, '新师父收到这条加油');
  assert.equal((await ap(A.token)).oiling.count, 0, '旧师父失去这条加油');

  console.log('PASS 联机师徒：拜师人机 / 打师父收徒 / 真人日供 10%+10% 且每人每日上限 1000+300 / 逐出 / 出师 / 徒弟加油 5% / 高等级徒弟关卡先上阵');
}

main().then(() => { cleanup(); }, (e) => { console.error(e); cleanup(); process.exitCode = 1; });
