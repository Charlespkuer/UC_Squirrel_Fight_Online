'use strict';
/* 服务端冒烟：临时库 + 随机端口，跑注册/登录/存档/动作/战斗/回放/天梯/好友/征战。 */
const path = require('node:path');
const fs = require('node:fs');
const OUT = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_mixed-opponents-api-'));
process.env.DATA_DIR = DATA;
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.LOG_LEVEL = 'warn';
process.env.ALLOW_BROWSER_DEVICES = 'true'; // Explicitly opt this isolated QA server into weak installation IDs.
process.env.ACCOUNTS_PER_IP = '0'; // 本地测试所有账号同 IP；IP 额度只测设备维度，避免测试互相挤占。
process.env.ACCOUNT_DAILY_LIMIT = '0'; // 本套件会建很多号；每日注册/注销闸门在单独用例里临时打开。
process.env.OWNER_IPS = '127.0.0.1,::1'; // 本机请求应被识别为服务器主人（设置页一键同步按钮）。
process.env.OWNER_IP_ONLY = 'true'; // 本套件用普通 QA 设备验主人 IP；创作设备门槛在 test-online-creator 里验。
process.env.FIGHT_INTERVAL_MS = '0'; // 套件连续打很多场；连点器闸门在单独用例里临时打开。
process.env.ACTION_INTERVAL_MS = '0'; // 套件连续领奖/升级；动作连点闸门在单独用例里临时打开。
process.env.OPPONENTS_RATE_PER_MIN = '240'; // 最后一项会连续拉 60 次候选找真人快照，放宽以免撞上限。

const { start } = require('../server/index.js');
const db = require('../server/db');

let BASE = '', runningServer;
function cleanup() {
  if (runningServer) runningServer.close();
  db.close();
  if (path.dirname(DATA) !== OUT || !path.basename(DATA).startsWith('_mixed-opponents-api-')) throw new Error('invalid test data path');
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const qaDevice = id => ({ 'x-device-id': id.padEnd(32, '_'), 'x-device-platform': 'browser', 'x-device-provider': 'installation' });
const tokenDevices = new Map(), nameDevices = new Map([['甲鼠', qaDevice('qa-a')], ['乙鼠', qaDevice('qa-b')]]);
async function call(method, url, body, token, extraHeaders) {
  const device = tokenDevices.get(token) || nameDevices.get(body && body.name) || qaDevice('qa-a');
  const headers = { 'content-type': 'application/json', ...device, ...extraHeaders };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 400) }; }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + (json && json.error ? json.error.code + ':' + json.error.msg : text.slice(0, 200)));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  if (json.token) tokenDevices.set(json.token, { 'x-device-id': headers['x-device-id'], 'x-device-platform': headers['x-device-platform'], 'x-device-provider': headers['x-device-provider'] });
  return json;
}

const results = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const economy = save => ['level', 'exp', 'goldPoint', 'goldCup', 'energy', 'integral', 'props'].map(k => save[k]);
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  if (!cond) console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''));
  else console.log('  ✓ ' + name);
}

async function main() {
  const { server, port } = await start(0);
  runningServer = server;
  BASE = 'http://127.0.0.1:' + port;
  console.log('server on', BASE);

  /* 1. 健康检查 / meta */
  const health = await call('GET', '/api/health');
  ok('health ok', health.ok === true && health.db === 'ok');
  const meta = await call('GET', '/api/meta');
  ok('meta has actions', meta.ok && meta.actions && meta.actions.doUpgrade && meta.actions.doUpgrade.mode === 'async');
  ok('meta socketGem async', meta.ok && meta.actions && meta.actions.socketGem && meta.actions.socketGem.mode === 'async');
  ok('meta sellGear compat sync', meta.ok && meta.actions && meta.actions.sellGear && meta.actions.sellGear.mode === 'sync' && Array.isArray(meta.actions.sellGear.args) && meta.actions.sellGear.args[1] === 'bool');
  ok('meta has limits', meta.limits && meta.limits.rankDaily === 0 && meta.limits.rankFree === 10
    && meta.limits.rankPaidCost === 5 && meta.limits.rankLateCost === 10
    && meta.limits.rankCapFrom === 30 && meta.limits.rankCapCost === 20
    && meta.limits.opponentRatingSpread === 200 && meta.limits.opponentRatingWeightFloor === 0.2
    && meta.limits.lotteryPrice === 25);
  const update = await call('GET', '/api/update');
  ok('update manifest', update.ok === true && /^\d+\.\d+/.test(String(update.version || ''))
    && Number(update.pollSeconds) >= 20 && /^https?:\/\//.test(String(update.url || ''))
    /* 客户端「立即更新」直接用这个地址拉整包；没有对应安装包时是空串。 */
    && typeof update.exe === 'string' && (!update.exe || /^\/download\/[^/]+\.exe$/.test(update.exe))
    && typeof update.apk === 'string' && (!update.apk || /^\/download\/[^/]+\.apk$/.test(update.apk))
    && typeof update.apkX86 === 'string' && (!update.apkX86 || /^\/download\/[^/]+\.apk$/.test(update.apkX86))
    && typeof update.ipa === 'string' && (!update.ipa || /^\/download\/[^/]+\.ipa$/.test(update.ipa))
    && typeof update.ipaLegacy === 'string' && (!update.ipaLegacy || /^\/download\/[^/]+\.ipa$/.test(update.ipaLegacy))
    && typeof update.ipaSize === 'number' && typeof update.ipaLegacySize === 'number'
    && typeof update.ipaVersion === 'string' && typeof update.ipaLegacyVersion === 'string'
    && Array.isArray(update.downloads));

  /* 纯网页端「下载客户端」：系统 / 架构 → 服务器上的对应安装包；没有包时说明原因。 */
  const downloadsDir = path.join(DATA, 'downloads');
  const pkgPrefix = 'squirrel_fight_online-' + update.version;
  const ipaPrefix = 'squirrel_fight_online_' + update.version;
  fs.mkdirSync(downloadsDir, { recursive: true });
  for (const name of [
    pkgPrefix + '.exe', pkgPrefix + '-arm64.apk', pkgPrefix + '-x86_64.apk',
    ipaPrefix + '_ios_unsigned.ipa', ipaPrefix + '_ios_legacy_unsigned.ipa',
  ]) fs.writeFileSync(path.join(downloadsDir, name), 'test');
  const winPkg = await call('GET', '/api/client/download?os=windows&arch=x64');
  const x86Pkg = await call('GET', '/api/client/download?os=android&arch=x86_64');
  const armPkg = await call('GET', '/api/client/download?os=android');
  const arm32Pkg = await call('GET', '/api/client/download?os=android&arch=arm');
  const iosPkg = await call('GET', '/api/client/download?os=ios&ios=18');
  const ios26Pkg = await call('GET', '/api/client/download?os=ios&ios=26');
  const macPkg = await call('GET', '/api/client/download?os=macos&arch=arm64');
  ok('网页端下载客户端按系统/架构选包', winPkg.ok && winPkg.package && /\.exe$/.test(winPkg.package.url)
    && x86Pkg.package && /x86_64\.apk$/.test(x86Pkg.package.url)
    && armPkg.package && /-arm64\.apk$/.test(armPkg.package.url) && /arm64/.test(armPkg.package.note || '')
    && iosPkg.package && /_ios_legacy_unsigned\.ipa$/.test(iosPkg.package.url)
    && ios26Pkg.package && /_ios_unsigned\.ipa$/.test(ios26Pkg.package.url)
    && !arm32Pkg.package && arm32Pkg.reason === 'unsupported-arch'
    && !macPkg.package && macPkg.reason === 'unsupported-platform' && macPkg.downloadPage === '/download');
  fs.rmSync(downloadsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  /* 2. 注册两个号 */
  const A = await call('POST', '/api/register', { name: '甲鼠', password: 'pass-a1' });
  // 新号还没到 30 级：天梯没有赛区，候选为空；随机挑战照旧由真 State.genAI 补位。
  const emptyRandom = await call('GET', '/api/opponents?kind=random', undefined, A.token);
  const emptyRank = await call('GET', '/api/opponents', undefined, A.token);
  const bot = emptyRandom.opponents[0];
  const botPreview = await call('GET', '/api/fighter?snapshotId=' + bot.snapshotId, undefined, A.token);
  const beforePractice = await call('GET', '/api/state', undefined, A.token);
  /* 天梯默认 0 分、300 分真人段；不到 30 级没有赛区也就没有天梯候选。 */
  ok('天梯默认 0 分起步、30 级前没有赛区候选', emptyRank.myScore === 0 && emptyRank.match && emptyRank.match.threshold === 300
    && emptyRank.match.weighted === false && beforePractice.save.integral === 0
    && emptyRank.opponents.length === 0);
  let wrongUse;
  try { await call('POST', '/api/battle', { kind: 'rank', snapshotId: bot.snapshotId, rev: beforePractice.rev }, A.token); } catch (e) { wrongUse = e; }
  // 固定随机流检查高等级生成器的幻兽没有被候选包装层抹掉。
  const highBot = require('../server/game/runtime').withState(beforePractice.save, ({ api }) =>
    require('../server/game/battle').withSeed(20261026, () => require('../server/game/opponents').buildRandomFoe(api, 60))).value;
  ok('随机挑战 AI 仍是普通挑战，票据不能跨用途冒用',
    emptyRandom.opponents.length === 3
    && emptyRandom.opponents.every(x => x.source === 'bot' && x.bot && !x.player && !x.practice && x.accountId === 0)
    && botPreview.fighter.level >= 1 && botPreview.fighter.level <= 4
    && highBot.level >= 59 && highBot.level <= 63 && highBot.pets.length > 0
    && wrongUse && wrongUse.status === 400);
  const B = await call('POST', '/api/register', { name: '乙鼠', password: 'pass-b1' });
  ok('register A', A.ok && A.token && A.profile.account.name === '甲鼠');
  ok('register B', B.ok && B.token);
  ok('账号显示名只显示昵称、不再拼 #tag',
    A.profile.account.display === '甲鼠' && B.profile.account.display === '乙鼠'
    && !/#/.test(A.profile.account.display + B.profile.account.display));
  ok('recovery code', /^[A-Z0-9]{4}-/.test(A.recoveryCode || ''));

  /* 3. 登录 + 错口令 */
  const login = await call('POST', '/api/login', { name: '甲鼠', password: 'pass-a1' });
  ok('login', login.ok && login.token);
  A.token = login.token; // 单会话：新登录会顶掉注册时那枚令牌
  /* 主人 IP 只影响设置页按钮可见性；本机 QA 请求必须拿到 owner:true 和当前版本。 */
  const owner = await call('GET', '/api/owner/status', undefined, A.token);
  const ownerVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'version.json'), 'utf8')).version;
  ok('owner status', owner.ok === true && owner.owner === true && owner.version === ownerVersion
    && !Object.prototype.hasOwnProperty.call(owner, 'ip'));
  const serverConfig = require('../server/config').config;
  const savedOwnerIps = serverConfig.ownerIps;
  serverConfig.ownerIps = ['203.0.113.9'];
  const nobody = await call('GET', '/api/owner/status', undefined, B.token);
  serverConfig.ownerIps = savedOwnerIps;
  ok('owner status hides from non-owner', nobody.ok === true && nobody.owner === false
    && !Object.prototype.hasOwnProperty.call(nobody, 'version'));
  /* 开发者同步：版本号没变、只改了代码时也要能识别（用户 2026-11 口径：
   * "检测到代码有变化就可以进行同步"，不必等版本号 +1）。
   * 客户端带自己的构建号来：同一个 build → 0 个文件；换一个 build → 不能算最新，
   * 并把服务器当前清单回给客户端，让它用包里的清单自己算逐文件差异。 */
  const previewAny = await call('GET', '/api/owner/sync/preview?from=' + ownerVersion, undefined, A.token);
  ok('owner preview reports current build', previewAny.ok === true && previewAny.owner === true
    && typeof previewAny.build === 'string' && previewAny.build.length > 0);
  const previewSame = await call('GET', '/api/owner/sync/preview?from=' + ownerVersion +
    '&build=' + encodeURIComponent(previewAny.build), undefined, A.token);
  ok('owner preview same build is up to date', previewSame.ok === true && previewSame.stale === false
    && previewSame.diff && previewSame.diff.count === 0 && Array.isArray(previewSame.manifest));
  const previewStale = await call('GET', '/api/owner/sync/preview?from=' + ownerVersion +
    '&build=deadbeef', undefined, A.token);
  ok('owner preview changed build is stale', previewStale.ok === true && previewStale.stale === true
    && previewStale.clientBuild === 'deadbeef' && Array.isArray(previewStale.manifest)
    && previewStale.manifest.length > 1);
  let bad = null;
  try { await call('POST', '/api/login', { name: '甲鼠', password: 'nope' }); } catch (e) { bad = e; }
  ok('bad password rejected', bad && bad.status === 401);

  /* 3b. 昵称全服唯一 + 新密码规范（2026-11） */
  const authCore = require('../server/auth');
  let dupName = null;
  try {
    authCore.register({
      name: '甲鼠', password: 'pass-z1', ip: '127.0.0.1',
      device: { hash: 'd'.repeat(64), platform: 'windows', provider: 'machine-guid', weak: false },
    });
  } catch (e) { dupName = e; }
  const takenName = await call('GET', '/api/check-name?name=' + encodeURIComponent('甲鼠'));
  const freeName = await call('GET', '/api/check-name?name=' + encodeURIComponent('还没人用的昵称'));
  const name7 = await call('GET', '/api/check-name?name=' + encodeURIComponent('七个汉字测试名'));
  const name8 = await call('GET', '/api/check-name?name=' + encodeURIComponent('八个汉字测试名字'));
  const latin21Text = 'abcdefghijklmnopqrstu';
  const latin21 = await call('GET', '/api/check-name?name=' + encodeURIComponent(latin21Text));
  const latin22 = await call('GET', '/api/check-name?name=' + encodeURIComponent('abcdefghijklmnopqrstuv'));
  /* 存档摘要/战斗体不能再用旧的 `slice(0, 12)` 把 21 个字母或旧账号的 12 个汉字截掉。 */
  const storeCore = require('../server/game/store');
  const latinSummary = storeCore.summaryOf({ name: latin21Text, level: 1 });
  const legacyName = '老'.repeat(12);
  const legacySummary = storeCore.summaryOf({ name: legacyName, level: 1 });
  let tooLongName = null;
  try {
    await call('POST', '/api/register', { name: '八个汉字测试名字', password: 'pass-l1' }, undefined, qaDevice('qa-long-name'));
  } catch (e) { tooLongName = e; }
  let shortPass = null, letterOnly = null;
  try { await call('POST', '/api/account/password', { password: 'pass-a1', newPassword: 'a1' }, A.token); } catch (e) { shortPass = e; }
  try { await call('POST', '/api/account/password', { password: 'pass-a1', newPassword: 'abcdef' }, A.token); } catch (e) { letterOnly = e; }
  ok('昵称全服唯一（check-name + 注册双重拦截）',
    dupName && dupName.code === 'CONFLICT' && takenName.available === false && freeName.available === true);
  ok('昵称最多 7 个汉字（英文/数字按 1/3 个汉字计）',
    name7.available === true && name8.available === false && /7 个汉字/.test(String(name8.reason || ''))
    && latin21.available === true && latin22.available === false && tooLongName && tooLongName.status === 400
    && latinSummary.name === latin21Text && legacySummary.name === legacyName);
  ok('新密码至少 6 位且同时包含字母和数字',
    shortPass && shortPass.status === 400 && letterOnly && letterOnly.status === 400);

  /* 4. 无 token 401 */
  let noAuth = null;
  try { await call('GET', '/api/state'); } catch (e) { noAuth = e; }
  ok('no token → 401', noAuth && noAuth.status === 401);

  const token = A.token;
  const stateA = await call('GET', '/api/state', undefined, token);
  ok('state has save', stateA.ok && stateA.save && stateA.save.level === 1);
  ok('state has snapshot', stateA.ok && stateA.snapshot && stateA.snapshot.fighter && stateA.snapshot.fighter.level === 1);
  ok('save has no dual fields', stateA.ok && !('__dualMode' in stateA.save) && stateA.save.settings.uiMode === 'classic');
  const questsA = stateA.save.quests;
  ok('每日任务由服务端下发', !!(questsA && questsA.date && Array.isArray(questsA.list) && questsA.list.length === 3));
  const stateARepeat = await call('GET', '/api/state', undefined, token);
  ok('每日任务重复拉档不重摇', JSON.stringify(stateARepeat.save.quests) === JSON.stringify(questsA));
  const rev0 = stateARepeat.rev;

  /* 5. 动作：买道具（sync）+ 非法动作 */
  const buy = await call('POST', '/api/action', { name: 'buyProp', args: [1, 1], rev: rev0 }, token);
  ok('buyProp ok', buy.ok && buy.rev > rev0 && buy.patch && buy.patch.set.props);
  let forbidden = null;
  try { await call('POST', '/api/action', { name: 'gainExp', args: [100000], rev: buy.rev }, token); } catch (e) { forbidden = e; }
  ok('gainExp forbidden', forbidden && forbidden.status === 403);
  let stale = null;
  try { await call('POST', '/api/action', { name: 'buyProp', args: [1, 1], rev: rev0 }, token); } catch (e) { stale = e; }
  ok('stale rev → 409', stale && stale.status === 409);
  const beforeGuide = await call('GET', '/api/state', undefined, token);
  await call('POST', '/api/action', {name:'setTutorialStep', args:[7], rev:beforeGuide.rev}, token);
  const savedGuide = await call('GET', '/api/state', undefined, token);
  const prematureGear = await call('POST', '/api/action', {name:'grantStarterGear', args:[], rev:savedGuide.rev}, token);
  ok('新手引导进度由服务器保存，低于 5 级不可领取赠装', savedGuide.save.tutorial.step === 7 && prematureGear.result == null);

  /* 6. 随机挑战 */
  const st1 = await call('GET', '/api/state', undefined, token);
  const fight1 = await call('POST', '/api/battle', {
    kind: 'random', snapshotId: bot.snapshotId, rev: st1.rev, idemKey: 'selected-bot',
    foe: { hp: 1, power: 0 }, result: { winner: 0 },
  }, token);
  ok('random battle', fight1.ok && fight1.result && fight1.result.rounds.length > 0, fight1.error);
  ok('random battle has me/foe', fight1.me && fight1.foe && fight1.me.name && fight1.foe.name);
  ok('random battle settlement', fight1.settlement && typeof fight1.settlement.exp === 'number');
  ok('random battle rev advanced', fight1.rev > 0);
  /* 消息红点：打开消息页要把"看到哪了"写进服务端存档。以前 `markMessagesSeen` 是 local 动作，
   * 联机版只改内存、`save()` 又是空操作，重进游戏被服务端旧档覆盖 → 每次都有 NEW。 */
  const seen = await call('POST', '/api/action', { name: 'markMessagesSeen', args: [], rev: fight1.rev }, token);
  const seenState = await call('GET', '/api/state', undefined, token);
  const newestBattleAt = Number(seenState.save.battles[0].createdAt) || 0;
  const seenAgain = await call('POST', '/api/action', { name: 'markMessagesSeen', args: [], rev: seen.rev }, token);
  ok('消息红点记账落服务端存档：看过一次后重进不再亮，重复上报幂等',
    seen.ok && seen.patch && seen.patch.set && Number(seen.patch.set.msgSeenAt) === newestBattleAt
    && Number(seenState.save.msgSeenAt) === newestBattleAt
    && seenAgain.ok && !seenAgain.patch && Number(seenAgain.result) === newestBattleAt);
  let foreignPickup;
  try { await call('POST', '/api/battle/pickup', { combatId: fight1.combatId, index: 0 }, B.token); } catch (e) { foreignPickup = e; }
  const firstPickup = await call('POST', '/api/battle/pickup', { combatId: fight1.combatId, index: 0, prize: { id:8, count:999999 } }, token);
  const afterPickup = await call('GET', '/api/state', undefined, token);
  const retryPickup = await call('POST', '/api/battle/pickup', { combatId: fight1.combatId, index: 0 }, token);
  const afterPickupRetry = await call('GET', '/api/state', undefined, token);
  ok('悬浮奖励由服务器生成并验证账号，重试不会重复发放', fight1.pickups.length === 3 && foreignPickup && foreignPickup.status === 404
    && same(firstPickup.prize, fight1.pickups[0]) && !firstPickup.duplicate && retryPickup.duplicate
    && same(afterPickup.save, afterPickupRetry.save));
  const afterFight = await call('GET', '/api/state', undefined, token);
  ok('今日胜率与战斗场次写服务端存档',
    Number(afterFight.save.dailyWins) + Number(afterFight.save.dailyFails) === 1
    && Number(afterFight.save.allWins) + Number(afterFight.save.allFails) === 1);
  await call('POST', '/api/action', { name: 'buyProp', args: [1, 1], rev: afterFight.rev }, token);
  const beforeRetry = await call('GET', '/api/state', undefined, token);
  const retried = await call('POST', '/api/battle', { kind: 'random', snapshotId: bot.snapshotId, rev: st1.rev, idemKey: 'selected-bot' }, token);
  const afterRetry = await call('GET', '/api/state', undefined, token);
  const sim = require('../server/game/battle');
  const botReplay = await call('GET', '/api/replay/' + fight1.combatId, undefined, token);
  ok('选中AI面板与实战/回放一致，客户端胜负无效，幂等不重复扣体力/发奖',
    same(fight1.foe, botPreview.fighter) && fight1.opponent.source === 'bot'
    && afterFight.save.energy === st1.save.energy - 10
    && same(fight1.result, sim.simulate(fight1.seed, fight1.me, fight1.foe))
    && retried.duplicate && retried.combatId === fight1.combatId && same(retried.foe, fight1.foe)
    && retried.rev === beforeRetry.rev && same(retried.save, beforeRetry.save)
    && same(afterRetry.save, beforeRetry.save) && same(botReplay.foe, fight1.foe));

  /* 7. 回放 */
  const replay = await call('GET', '/api/combat/' + fight1.combatId, undefined, token);
  ok('combat replay', replay.ok && replay.result.rounds.length === fight1.result.rounds.length);
  const replayDef = await call('GET', '/api/combat/' + fight1.combatId + '?as=defender', undefined, token);
  ok('defender view flipped', replayDef.ok && replayDef.result.winner === 1 - fight1.result.winner);

  /* 8. B 也要有战斗快照。先给 B 加等级（走动作做不到，直接改库） */
  const stB = await call('GET', '/api/state', undefined, B.token);
  ok('B state', stB.ok && stB.save.level === 1);
  // 固定匹配等级，避免第一场随机升级多少让这个真人用例碰巧出圈。
  const store = require('../server/game/store');
  db.tx(() => store.runOnSave(B.profile.account.accountId, ({ save }) => { save.level = afterFight.save.level; }, { snapshotSource: 'test-match' }));
  /* 天梯 30 级开启；同一组真人用例保持双方同级，随机/rank 候选都能命中。 */
  db.tx(() => store.runOnSave(A.profile.account.accountId, ({ save }) => { save.level = 30; }, { snapshotSource: 'test-rank' }));
  db.tx(() => store.runOnSave(B.profile.account.accountId, ({ save }) => { save.level = 30; }, { snapshotSource: 'test-rank' }));
  await call('POST', '/api/snapshot/sync', {}, A.token);
  await call('POST', '/api/snapshot/sync', {}, B.token);
  /* 随机挑战的 30 个人机签 + 真人签：先单测权重，再用真实接口找到一次真人候选。 */
  {
    const { drawRandomPool } = require('../server/game/opponents');
    let seed = 20261103;
    const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let hit = 0, multi = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const slots = drawRandomPool([{ accountId: 99 }], 3, 30, rng);
      if (slots.some((x) => x && x.accountId === 99)) hit++;
      if (slots.filter(Boolean).length > 1) multi++;
    }
    const rate = hit / N;
    ok('随机挑战 30 个人机签 + 真人签：单个真人约 3/31 出现，且同一页不重复同一位真人',
      rate > 0.08 && rate < 0.12 && multi === 0, { rate });
  }
  /* 不再保证第一页有真人：最多刷 300 次，抓到 B 的那一页作为后续真人战斗用例。 */
  let mixed = null, player = null;
  for (let i = 0; i < 300 && !player; i++) {
    mixed = await call('GET', '/api/opponents?kind=random', undefined, token);
    player = mixed.opponents.find((x) => x.player) || null;
  }
  const playerPreview = await call('GET', '/api/fighter?snapshotId=' + player.snapshotId, undefined, token);

  /* 9. 天梯对手：两个同级号应该能互相看到（随后统一抬到 30 级开天梯） */
  /* 给 A 一个接近人机基准分的积分，保证 300 分以下也会补人机候选。 */
  db.run('UPDATE ratings SET score = 250 WHERE account_id = ? AND season = ?',
    A.profile.account.accountId, require('../server/game/settlement').weekKey());
  /* 「战斗准备中」要显示真人名次：B 先有本周 rating，才会出现在赛区名次表里。 */
  require('../server/game/settlement').ensureRating(B.profile.account.accountId,
    require('../server/game/settlement').weekKey());
  const opp = await call('GET', '/api/opponents', undefined, token);
  ok('opponents list 带赛区名次（真人对手有 rank，自己 myRank 在顶层）',
    opp.ok && Array.isArray(opp.opponents)
    && Number.isInteger(opp.myRank) && opp.myRank >= 1
    && opp.opponents.some((o) => o.player && Number(o.rank) >= 1)
    && opp.opponents.filter((o) => o.bot).every((o) => !o.rank));
  ok('opponents exclude self', !opp.opponents.some((o) => o.accountId === A.profile.account.accountId));

  /* 10. 天梯战斗（需要对手快照；30 级才开启） */
  if (opp.opponents.length) {
    /* 10a. 500 分以下的 AI 是正常天梯对手（积分/金杯/次数/经验都结算）。 */
    const botOffer = opp.opponents.find((x) => x.bot);
    const realOffer = opp.opponents.find((x) => x.player);
    /* 给 A 一个非 0 分，避免严格零和在 0 分下限把这场压成双方 0 变化。 */
    db.tx(() => {
      db.run('UPDATE ratings SET score = 100 WHERE account_id = ? AND season = ?',
        A.profile.account.accountId, require('../server/game/settlement').weekKey());
      store.runOnSave(A.profile.account.accountId, ({ save }) => { save.integral = 100; }, { snapshotSource: 'test-rank-bot' });
    });
    const stBot = await call('GET', '/api/state', undefined, token);
    const botRank = await call('POST', '/api/battle', {
      kind: 'rank', snapshotId: botOffer.snapshotId, rev: stBot.rev,
    }, token);
    const afterBot = await call('GET', '/api/state', undefined, token);
    const boardAfterBot = await call('GET', '/api/ladder?limit=200', undefined, token);
    const botRow = boardAfterBot.top.find((x) => x.botId === botOffer.botId);
    ok('500 分以下 AI 天梯对手按正常规则结算积分、金杯与次数（人机只掉 1 分）',
      botOffer && botRank.ok && botRank.settlement.practice === false && botRank.settlement.bot === true
      && botRank.settlement.integral && botRank.settlement.integral.delta !== 0
      && botRank.daily.played === 1 && !botRank.chest && botRank.pickups && botRank.pickups.length === 3
      && afterBot.save.integral === botRank.settlement.integral.new
      && afterBot.save.goldCup === stBot.save.goldCup + botRank.settlement.goldCup
      /* 人机是防守方：只固定 ±1（挑战方赢 → -1，输 → +1），从周基准 300 分出发。 */
      && botRank.settlement.defender && botRank.settlement.defender.delta === -Math.sign(botRank.settlement.integral.delta)
      && botRow && botRow.score === 300 + botRank.settlement.defender.delta);
    /* 挑战方和被挑战方都放到非 0 分，便于核对「防守方只动 ±1」。 */
    db.tx(() => {
      const week = require('../server/game/settlement').weekKey();
      for (const who of [A, B]) {
        db.run('UPDATE ratings SET score = 100 WHERE account_id = ? AND season = ?',
          who.profile.account.accountId, week);
        store.runOnSave(who.profile.account.accountId, ({ save }) => { save.integral = 100; }, { snapshotSource: 'test-rank-both' });
      }
    });
    const st2 = await call('GET', '/api/state', undefined, token);
    const bBeforeRank = await call('GET', '/api/state', undefined, B.token);
    let rawRank = null;
    try {
      await call('POST', '/api/battle', {
        kind: 'rank', snapshotId: stB.snapshot.id, rev: st2.rev,
      }, token);
    } catch (e) { rawRank = e; }
    const rank = await call('POST', '/api/battle', {
      kind: 'rank', snapshotId: realOffer.snapshotId, rev: st2.rev,
    }, token);
    const bAfterRank = await call('GET', '/api/state', undefined, B.token);
    const bRating = db.get('SELECT score FROM ratings WHERE account_id = ? AND season = ?',
      B.profile.account.accountId, require('../server/game/settlement').weekKey());
    ok('真人天梯：挑战方按积分档位结算，防守方只固定 ±1 并即时写入存档镜像',
      realOffer && rank.ok && rank.settlement && rank.settlement.practice !== true
      && rank.settlement.integral && rank.settlement.integral.delta !== 0
      && rank.settlement.defender && rank.settlement.defender.delta === -Math.sign(rank.settlement.integral.delta)
      && bAfterRank.save.integral === bBeforeRank.save.integral + rank.settlement.defender.delta
      && bAfterRank.rev > bBeforeRank.rev
      && bAfterRank.save.integral === bRating.score, { bBefore: bBeforeRank.save.integral,
        bAfter: bAfterRank.save.integral, defDelta: rank.settlement && rank.settlement.defender && rank.settlement.defender.delta,
        rating: bRating && bRating.score, revBefore: bBeforeRank.rev,
        revAfter: bAfterRank.rev });
    ok('rank battle', rank.ok && rank.result && rank.settlement && rank.settlement.integral
      && rank.settlement.defender && rank.settlement.defender.exp >= 2 && rank.settlement.defender.exp <= 4
      && rawRank && rawRank.status === 403, rank.error);
    ok('rank daily counted', rank.daily && rank.daily.played >= 2);
    const settleMod = require('../server/game/settlement');
    const scoreRange = (my, foe, lo, hi) => {
      const at = (r) => settleMod.integralDelta(my, foe, true, r);
      const low = at(0), high = at(0.999999);
      const neg = settleMod.integralDelta(my, foe, false, 0);
      return low >= lo && low <= hi && high >= lo && high <= hi && neg === -low;
    };
    ok('天梯积分差新档位（0-50 / 51-100 / 101-200 / 201-500 / 501+；低于对手 1-50 / 51-100 / 101-300 / 301+）',
      scoreRange(1000, 1000, 14, 17) && scoreRange(1051, 1000, 10, 15)
      && scoreRange(1101, 1000, 7, 12) && scoreRange(1201, 1000, 5, 10)
      && scoreRange(1501, 1000, 1, 2) && scoreRange(1000, 1050, 15, 18)
      && scoreRange(1000, 1100, 16, 19) && scoreRange(1000, 1200, 17, 20)
      && scoreRange(1000, 1400, 20, 25));
    const winPair = settleMod.rankDeltaPair(1000, 1050, true, 0);
    const losePair = settleMod.rankDeltaPair(1000, 1050, false, 0);
    const zeroAttacker = settleMod.rankDeltaPair(0, 0, false, 0);
    const capAttacker = settleMod.rankDeltaPair(100000, 100000, true, 0);
    const botFloor = settleMod.rankDeltaPair(1000, 50, true, 0, 50);
    ok('天梯积分只对挑战方生效：防守方固定 ±1（贴下限/上限时压成 0）',
      winPair.attackerDelta > 1 && winPair.defenderDelta === -1
      && losePair.attackerDelta < -1 && losePair.defenderDelta === 1
      && zeroAttacker.attackerDelta === 0 && zeroAttacker.defenderDelta === 1
      && capAttacker.attackerDelta === 0 && capAttacker.defenderDelta === -1
      && botFloor.defenderDelta === 0,
      { winPair, losePair, zeroAttacker, capAttacker, botFloor });
    const ladder = await call('GET', '/api/ladder', undefined, token);
    ok('ladder list', ladder.ok && Array.isArray(ladder.top) && ladder.me);
    const messages = await call('GET', '/api/messages', undefined, B.token);
    const defenderMessage = messages.messages && messages.messages.find((m) => m.kind === 'rank_win' || m.kind === 'rank_loss');
    const badgeBefore = await call('GET', '/api/messages/badge', undefined, B.token);
    const seenMessages = await call('POST', '/api/messages/seen', {}, B.token);
    const badgeAfter = await call('GET', '/api/messages/badge', undefined, B.token);
    ok('被挑战消息带快照等级；主界面 NEW 只由未读被动消息驱动，打开消息页后清零',
      !!defenderMessage && Number(defenderMessage.payload.level) === 30
      && badgeBefore.unread >= 1 && badgeBefore.total >= 1
      && seenMessages.ok && badgeAfter.total === 0,
      { level: defenderMessage && defenderMessage.payload.level, before: badgeBefore, after: badgeAfter });

    /* 复仇：只认**被抢方当天**的战报，费用 (n+1)*20 金松果、抢 (n+1)*5+3 金杯；
     * 不占每日场次、不发宝箱/飘物。这里把原战报补成“B 防守失败且被抢 3 杯”。 */
    if (rank && rank.combatId && rank.settlement && !rank.settlement.practice) {
      const victim = B, foe = A;
      const victimId = victim.profile.account.accountId, foeId = foe.profile.account.accountId;
      db.tx(() => {
        const row = db.get('SELECT settlement FROM combats WHERE id = ?', rank.combatId);
        const saved = JSON.parse(row.settlement || '{}');
        saved.defender = Object.assign({}, saved.defender || {}, { robbed: 3 });
        saved.robbed = 3;
        db.run('UPDATE combats SET winner = 0, settlement = ? WHERE id = ?', JSON.stringify(saved), rank.combatId);
        store.runOnSave(victimId, ({ save }) => {
          save.goldPoint = 1000; save.goldCup = 100;
          /* 让被抢方稳定赢下复仇，便于核对金杯公式；正常对局不需要这段。
           * 先手 + 100 血：徒手至少 7 点，5 点血会被对手一击带走（谁先手看随机）。 */
          save.power = 600; save.agility = 1; save.speed = 100;
          save.maxHp = 100; save.hp = 100;
        }, { snapshotSource: 'test-revenge' });
        store.runOnSave(foeId, ({ save }) => {
          save.goldPoint = 1000; save.goldCup = 100;
          save.power = 1; save.agility = 1; save.speed = 1;
          save.maxHp = 100; save.hp = 100;
        }, { snapshotSource: 'test-revenge' });
      });
      const inbox = await call('GET', '/api/messages', undefined, victim.token);
      const msg = inbox.messages && inbox.messages.find((m) => m.combatId === rank.combatId);
      const beforeRev = await call('GET', '/api/state', undefined, victim.token);
      const pendingBeforeRev = await call('GET', '/api/battle/chest', undefined, victim.token);
      const rev = await call('POST', '/api/battle', {
        kind: 'rank', snapshotId: st2.snapshot.id, rev: beforeRev.rev, idemKey: 'revenge-test-1',
        revengeOf: rank.combatId,
      }, victim.token);
      const afterRev = await call('GET', '/api/state', undefined, victim.token);
      const pendingAfterRev = await call('GET', '/api/battle/chest', undefined, victim.token);
      const revp = rev.settlement && rev.settlement.revenge;
      ok('复仇：被抢方当天战报可复仇，原版费用/金杯，不占每日、不发宝箱/飘物', !!revp
        && msg && msg.payload && msg.payload.revenge && msg.payload.revenge.eligible
        && revp.count === 0 && revp.cost === 20 && revp.cups === 8 && revp.stolen === 8
        && rev.settlement.win === true
        && afterRev.save.goldPoint === beforeRev.save.goldPoint - 20
        && afterRev.save.goldCup === beforeRev.save.goldCup + 8
        && rev.daily && rev.daily.played === beforeRev.daily.played
        && !rev.chest && !rev.pickups
        && pendingAfterRev.pendingCount === pendingBeforeRev.pendingCount,
        { eligible: !!(msg && msg.payload && msg.payload.revenge), revp, win: rev.settlement && rev.settlement.win,
          gold: [beforeRev.save.goldPoint, afterRev.save.goldPoint],
          cup: [beforeRev.save.goldCup, afterRev.save.goldCup],
          daily: [beforeRev.daily.played, rev.daily && rev.daily.played],
          chest: !!rev.chest, pickups: !!rev.pickups,
          pending: [pendingBeforeRev.pendingCount, pendingAfterRev.pendingCount] });
    }
  } else {
    ok('opponents non-empty (skip rank)', false, { count: opp.opponents.length });
  }
  let foreign, badId;
  try { await call('GET', '/api/fighter?snapshotId=' + player.snapshotId, undefined, B.token); } catch (e) { foreign = e; }
  const beforeSelected = await call('GET', '/api/state', undefined, token);
  try { await call('POST', '/api/battle', { kind: 'random', snapshotId: 'o_forged', rev: beforeSelected.rev }, token); } catch (e) { badId = e; }
  const selectedPlayer = await call('POST', '/api/battle', {
    kind: 'random', snapshotId: player.snapshotId, rev: beforeSelected.rev, idemKey: 'selected-player',
    fighter: { hp: 1 }, winner: 0,
  }, token);
  const playerReplay = await call('GET', '/api/replay/' + selectedPlayer.combatId, undefined, token);
  const bRandomInbox = await call('GET', '/api/messages', undefined, B.token);
  const randomDefense = bRandomInbox.messages.find((m) => /^defense_/.test(m.kind) && m.combatId === selectedPlayer.combatId);
  const randomDefenseReplay = await call('GET', '/api/combat/' + selectedPlayer.combatId, undefined, B.token);
  // 同一客户端 key 属于不同账号时不能读到 A 的战斗，也不能偷用 A 的候选。
  const bState = await call('GET', '/api/state', undefined, B.token);
  const bFight = await call('POST', '/api/battle', { kind: 'random', rev: bState.rev, idemKey: 'selected-player' }, B.token);
  ok('真人抽签：选中真人不重抽，同一页其余仍是 AI，票据与幂等键不能跨账号冒用；防守方收到带等级/胜负的挑战消息并可回放',
    mixed.opponents.length === 3 && player.source === 'player' && player.player && !player.bot
    && player.accountId === B.profile.account.accountId
    && mixed.opponents.filter((x) => x.player).length === 1
    && mixed.opponents.filter((x) => x.bot).length === 2
    && mixed.opponents.every(x => x.accountId !== A.profile.account.accountId)
    && foreign && foreign.status === 403 && badId && badId.status === 404
    && same(selectedPlayer.foe, playerPreview.fighter) && same(playerReplay.foe, playerPreview.fighter)
    && selectedPlayer.opponent.source === 'player' && bFight.combatId !== selectedPlayer.combatId
    && !!randomDefense && Number(randomDefense.payload.level) === 30
    && randomDefense.payload.defenderWin === (selectedPlayer.result.winner !== 0)
    && randomDefenseReplay.view === 'defender'
    && randomDefenseReplay.result.winner === (randomDefense.payload.defenderWin ? 0 : 1));

  /* 10 次刷新冷却：出现后紧接着 10 次不能出现；第 11 次只恢复**资格**（是否抽中由抽签决定）。 */
  const randomAccount = A.profile.account.accountId;
  const pickSeq = Number(db.get('SELECT refresh_no FROM random_refresh_state WHERE account_id = ?', randomAccount).refresh_no);
  const pickEx = db.get('SELECT through_refresh FROM random_refresh_exclusions WHERE account_id = ? AND opponent_id = ?',
    randomAccount, player.accountId);
  const blocked = [];
  for (let i=0;i<10;i++) blocked.push(await call('GET','/api/opponents?kind=random',undefined,token));
  const stillExcluded = db.get('SELECT through_refresh FROM random_refresh_exclusions WHERE account_id = ? AND opponent_id = ?',
    randomAccount, player.accountId);
  await call('GET','/api/opponents?kind=random',undefined,token);
  const eligibleAgain = db.get('SELECT through_refresh FROM random_refresh_exclusions WHERE account_id = ? AND opponent_id = ?',
    randomAccount, player.accountId);
  ok('真人出现后接下来 10 次刷新均排除，第 11 次才恢复资格（由抽签决定是否出现）',
    pickEx && Number(pickEx.through_refresh) === pickSeq + 10
    && blocked.every(x=>!x.opponents.some(y=>y.accountId===player.accountId))
    && stillExcluded && Number(stillExcluded.through_refresh) === pickSeq + 10
    /* 第 11 次可能又抽中（会写一条新冷却），也可能没抽中；两种都证明旧冷却已清掉。 */
    && (!eligibleAgain || Number(eligibleAgain.through_refresh) === pickSeq + 21));

  /* 10b. 赛区制：B 抬到 35 级仍在 30-39 赛区；A 到 300 分以后人机按 0 分参与匹配。
   * 同一个真人至少隔 5 场；同赛区没有真人时回落一个人机（本场不动积分）。 */
  const weekNow = require('../server/game/settlement').weekKey();
  const aId = A.profile.account.accountId, bId = B.profile.account.accountId;
  db.tx(() => store.runOnSave(bId, ({ save }) => { save.level = 35; }, { snapshotSource: 'test-history' }));
  /* 造一个「模拟账号」（魔王）在天梯榜/匹配池里，分数比真人都高；它必须被排除。 */
  db.run("INSERT INTO accounts (name,tag,pass_hash,pass_salt,recovery_hash,created_at,last_seen) VALUES ('魔王','9001','x','x','x',?,?)", Date.now(), Date.now());
  const demonId = Number(db.get("SELECT id FROM accounts WHERE name='魔王'").id);
  store.createSave(demonId, '魔王');
  db.tx(() => store.runOnSave(demonId, ({ save }) => { save.level = 30; }, { snapshotSource: 'test-demon' }));
  db.run('INSERT INTO simulated_accounts (account_id, note) VALUES (?, ?)', demonId, 'test');
  db.run('INSERT INTO ratings (account_id, season, score, wins, losses, streak, updated_at) VALUES (?,?,1500,20,2,5,?)', demonId, weekNow, Date.now());
  /* 清掉 A 之前的真人战报，只留赛区真人 B；A 到 300 分。 */
  db.run("DELETE FROM combats WHERE attacker_id = ? AND kind = 'rank'", aId);
  db.run('UPDATE ratings SET score = 300 WHERE account_id = ? AND season = ?', aId, weekNow);
  const highRank = await call('GET', '/api/opponents', undefined, token);
  ok('300 分以上：真人按积分差权重抽取，人机按 0 分计权重（1/5），模拟账号不进池',
    highRank.match.weighted === true && highRank.match.botWeight === 0.2 && highRank.match.realCount >= 1
    && highRank.match.botCount === 0 && highRank.opponents.length === 1
    && highRank.opponents[0].accountId === bId
    && !highRank.opponents.some((x) => x.accountId === demonId));
  const oppMod = require('../server/game/opponents');
  const weightAt = (my, foe) => oppMod.ratingWeight(my, foe);
  ok('天梯抽取权重：同分 1、100 分差 0.6、200 分及更远保底 1/5',
    weightAt(1000, 1000) === 1 && Math.abs(weightAt(1000, 1100) - 0.6) < 1e-9
    && Math.abs(weightAt(1000, 1200) - 0.2) < 1e-9
    && Math.abs(weightAt(1000, 1500) - 0.2) < 1e-9
    && Math.abs(weightAt(500, 0) - 0.2) < 1e-9);
  const ladderNoBots = await call('GET', '/api/ladder?limit=200', undefined, token);
  /* 上周的积分行不参与本周榜（每周一 0 点从 0 开始）。 */
  db.run('INSERT OR REPLACE INTO ratings (account_id, season, score, wins, losses, streak, updated_at) VALUES (?,?,9999,50,0,0,?)',
    aId, '2000-01-03', Date.now());
  const staleWeek = await call('GET', '/api/ladder?limit=5', undefined, token);
  db.run('DELETE FROM ratings WHERE account_id = ? AND season = ?', aId, '2000-01-03');
  ok('赛区榜：只列本赛区真人 + 30 个人机，模拟账号不上榜，上周积分不参与',
    ladderNoBots.ok && ladderNoBots.division && ladderNoBots.division.key === 'd30' && ladderNoBots.frame === 1
    && ladderNoBots.top.filter((x) => x.bot).length === 30
    && ladderNoBots.top.filter((x) => x.bot && x.score === 300).length >= 29
    && ladderNoBots.top.filter((x) => x.bot).every((x) => x.level >= 30 && x.level <= 39)
    && !ladderNoBots.top.some((x) => x.accountId === demonId)
    && staleWeek.me.score !== 9999 && staleWeek.week === weekNow);
  /* B 离开 30-39 赛区 → A 没有真人可打：300 分以上按 0 分权重给 1 个兜底人机。 */
  db.tx(() => store.runOnSave(bId, ({ save }) => { save.level = 55; }, { snapshotSource: 'test-rank' }));
  const noRealRank = await call('GET', '/api/opponents', undefined, token);
  ok('300 分以上没有真人时仍匹配到赛区人机（按 0 分权重 1/5）',
    noRealRank.match.weighted === true && noRealRank.match.realCount === 0 && noRealRank.match.botCount === 1
    && noRealRank.opponents.length === 1 && noRealRank.opponents[0].bot === true);
  const stFb = await call('GET', '/api/state', undefined, token);
  const fbBattle = await call('POST', '/api/battle', { kind: 'rank', snapshotId: noRealRank.opponents[0].snapshotId, rev: stFb.rev }, token);
  const afterFb = await call('GET', '/api/state', undefined, token);
  ok('300 分以上的赛区人机同样结算积分（挑战方档位、人机 ±1）',
    fbBattle.ok && fbBattle.settlement.fallback === false && fbBattle.settlement.bot === true
    && fbBattle.settlement.integral && fbBattle.settlement.integral.old === 300
    && Math.abs(fbBattle.settlement.integral.delta) >= 1
    && fbBattle.settlement.defender && fbBattle.settlement.defender.delta === -Math.sign(fbBattle.settlement.integral.delta)
    && afterFb.save.integral === fbBattle.settlement.integral.new);
  /* 0 分时排在 30 个人机之后：不先超过一个人机就进不了前 30。 */
  db.run('UPDATE ratings SET score = 0 WHERE account_id = ? AND season = ?', aId, weekNow);
  const lowLadder = await call('GET', '/api/ladder?limit=30', undefined, token);
  ok('0 分排在 30 个人机之后（进不了前 30）',
    lowLadder.top.filter((x) => x.bot).length === 30 && lowLadder.me.rank > 30 && lowLadder.me.score === 0);
  /* 同一个真人至少隔 5 场：打一场后隐藏，再打 5 场（这里直接落 5 条人机战报）恢复。 */
  db.tx(() => store.runOnSave(bId, ({ save }) => { save.level = 35; }, { snapshotSource: 'test-rank-2' }));
  db.run("DELETE FROM combats WHERE attacker_id = ? AND kind = 'rank'", aId);
  db.run('UPDATE ratings SET score = 300 WHERE account_id = ? AND season = ?', aId, weekNow);
  const list1 = await call('GET', '/api/opponents', undefined, token);
  const real = list1.opponents.find((x) => x.accountId === bId);
  const stReal = await call('GET', '/api/state', undefined, token);
  await call('POST', '/api/battle', { kind: 'rank', snapshotId: real.snapshotId, rev: stReal.rev }, token);
  const afterOne = await call('GET', '/api/opponents', undefined, token);
  const hidden = !afterOne.opponents.some((x) => x.accountId === bId);
  db.tx(() => {
    for (let i = 0; i < 5; i++) {
      db.run(`INSERT INTO combats (id, idem_key, kind, season, attacker_id, defender_id, snapshot_id, seed, result, hash, sim_version, winner, settlement, attacker_rev, defender_rev, created_at)
              VALUES (?, '', 'rank', ?, ?, 0, '', 1, ?, 'h', 'test', 0, '{}', 0, 0, ?)`,
        'c_pad' + i + '_' + Date.now(), weekNow, aId, Buffer.from('{}'), Date.now() + i);
    }
  });
  const afterFive = await call('GET', '/api/opponents', undefined, token);
  ok('同一个真人至少相隔 5 场：刚打完隐藏，5 场后恢复',
    !!real && hidden && afterFive.opponents.some((x) => x.accountId === bId));

  /* 11. 好友 */
  const search = await call('GET', '/api/players?q=乙鼠', undefined, token);
  ok('search player', search.ok && search.results.some((r) => r.name === '乙鼠'));
  const target = (search.results.find((r) => r.name === '乙鼠') || {});
  const exactName = await call('GET', '/api/players?q=' + encodeURIComponent(target.display), undefined, token);
  const exactId = await call('GET', '/api/players?q=' + target.playerId, undefined, token);
  ok('完整名字和六位数字 ID 均可搜索，首位账号为 100000', A.profile.account.playerId === 100000 && B.profile.account.playerId === 100001 && exactName.results.some(r => r.accountId === target.accountId) && exactId.results.some(r => r.accountId === target.accountId));
  const add = await call('POST', '/api/friends', { target: String(target.playerId) }, token);
  ok('好友申请：只写申请，不直接成为好友', add.ok && add.pending === true && !!(add.request && add.request.messageId));
  const dupAdd = await call('POST', '/api/friends', { target: String(target.playerId) }, token);
  ok('重复申请不叠加', dupAdd.ok && dupAdd.pending === true && dupAdd.duplicate === true);
  const friends = await call('GET', '/api/friends', undefined, token);
  const recipient = await call('GET', '/api/friends', undefined, B.token);
  const requestBadge = await call('GET', '/api/messages/badge', undefined, B.token);
  ok('好友上限按服务端安全线 50 返回（原版无上限）', friends.limit === 50 && recipient.limit === 50,
    { limit: friends.limit, recipientLimit: recipient.limit });
  ok('申请未通过时双方好友列表为空，收件人待验证数 1，主界面 NEW 也记这条验证',
    friends.friends.length === 0 && recipient.friends.length === 0
    && recipient.requestCount === 1 && friends.requestCount === 0 && requestBadge.requests === 1,
    { n: friends.friends.length, recipientRequests: recipient.requestCount, badge: requestBadge });
  const incoming = await call('GET', '/api/friends/requests', undefined, B.token);
  ok('收件人能看到待验证申请（名字 / 等级 / messageId）', incoming.ok && incoming.count === 1
    && incoming.requests[0].name === '甲鼠' && incoming.requests[0].messageId === add.request.messageId
    && Number(incoming.requests[0].level) > 0);
  const acceptedReq = await call('POST', '/api/friends/requests/' + incoming.requests[0].messageId, { accept: true }, B.token);
  ok('同意申请后双方成为好友', acceptedReq.ok && acceptedReq.accepted === true);
  const friendsAfter = await call('GET', '/api/friends', undefined, token);
  const friendsOther = await call('GET', '/api/friends', undefined, B.token);
  ok('双方好友列表都出现对方、待验证数归零', friendsAfter.friends.length === 1 && friendsOther.friends.length === 1
    && friendsAfter.requestCount === 0 && friendsOther.requestCount === 0);
  /* 超级松鼠等级是账号实时状态，不能跟着战斗快照冻结。 */
  const vipBefore = JSON.parse(JSON.stringify(stB.save.vip || {}));
  db.tx(() => store.runOnSave(target.accountId, ({ save }) => {
    save.vip = Object.assign({}, vipBefore, { level: 6, until: Date.now() + 86400000, capAdded: 60, capApplied: true });
  }));
  const vipList = await call('GET', '/api/friends', undefined, token);
  const vipRow = vipList.friends.find((f) => f.accountId === target.accountId);
  db.tx(() => store.runOnSave(target.accountId, ({ save }) => { save.vip.until = Date.now() - 1000; }));
  const expiredList = await call('GET', '/api/friends', undefined, token);
  const expiredRow = expiredList.friends.find((f) => f.accountId === target.accountId);
  db.tx(() => store.runOnSave(target.accountId, ({ save }) => { save.vip = vipBefore; }));
  ok('好友列表按账号实时下发超级松鼠等级，到期立即隐藏（不读战斗快照）',
    !!vipRow && vipRow.vipLevel === 6 && !!expiredRow && expiredRow.vipLevel === 0,
    { active: vipRow && vipRow.vipLevel, expired: expiredRow && expiredRow.vipLevel });
  const bots = [];
  for (let i = 0; i < 10; i++) bots.push(await call('POST', '/api/friends/ai', { requestKey: 'friend-ai-test-' + String(i).padStart(4, '0') }, token));
  const retryBot = await call('POST', '/api/friends/ai', { requestKey: 'friend-ai-test-0000' }, token);
  let overflow = false, foreignBot = false;
  try { await call('POST', '/api/friends/ai', { requestKey: 'friend-ai-test-0010' }, token); } catch (e) { overflow = e.status === 409; }
  const beforeBot = await call('GET', '/api/state', undefined, token);
  const botFight = await call('POST', '/api/battle', { kind:'friend', snapshotId:bots[0].friend.snapshotId, rev:beforeBot.rev, idemKey:'ai-friend-fight' }, token);
  const afterBot = await call('GET', '/api/state', undefined, token);
  const remoteBefore = await call('GET', '/api/state', undefined, B.token);
  try { await call('POST', '/api/battle', {kind:'friend',snapshotId:bots[0].friend.snapshotId,rev:remoteBefore.rev}, B.token); } catch (e) { foreignBot = e.status === 404; }
  const aiList = await call('GET', '/api/friends', undefined, token);
  await call('DELETE', '/api/friends/' + bots[0].friend.snapshotId, undefined, token);
  const afterRemoveAi = await call('GET', '/api/friends', undefined, token);
  ok('AI 好友服务端生成、上限十位、重试去重且仅本人可无奖励切磋和删除',
    bots[0].friend.snapshotId === retryBot.friend.snapshotId && overflow && foreignBot && aiList.aiCount === 10 && afterRemoveAi.aiCount === 9
    && botFight.opponent.bot && botFight.settlement.exp === 0 && same(economy(beforeBot.save), economy(afterBot.save)));
  const beforeWood = await call('GET', '/api/state', undefined, token);
  const woodArgs = { kind:'wood', rev:beforeWood.rev, idemKey:'wood-retry-test' };
  const wood = await call('POST', '/api/battle', woodArgs, token);
  const woodRetry = await call('POST', '/api/battle', woodArgs, token);
  const afterWood = await call('GET', '/api/state', undefined, token);
  const counted = wood.result.rounds.filter(r => r.attacker === 0 && !r.selfDot).reduce((n,r) => n + Math.max(0, Math.floor(Number(r.dmg) || 0)), 0);
  ok('木头人训练由服务器计算、记录分项并可幂等重试，不消耗或发放资源',
    wood.foe.npcType === 'wood' && wood.foe.practiceRounds === 10 && wood.foe.hp === 800
    && wood.settlement.record.current.total === counted && woodRetry.combatId === wood.combatId
    && afterWood.save.woodCount === (Number(beforeWood.save.woodCount)||0) + 1
    && same(economy(beforeWood.save), economy(afterWood.save)) && !wood.chest);
  await call('POST', '/api/board', { toId: target.accountId, text: '你好，乙鼠' }, token);
  const board = await call('GET', '/api/board', undefined, B.token);
  ok('真实账号留言可在收件人留言板查看并携带回复 ID', board.messages.some(m => m.text === '你好，乙鼠' && m.from.accountId === A.profile.account.accountId));
  await call('POST', '/api/board', { toId: A.profile.account.accountId, text: '收到' }, B.token);
  const reply = await call('GET', '/api/board', undefined, token);
  ok('留言回复投递给原发送者', reply.messages.some(m => m.text === '收到' && m.from.accountId === target.accountId));

  const boardBadgeBefore = await call('GET', '/api/messages/badge', undefined, B.token);
  await call('POST', '/api/board', { toId: target.accountId, text: '留言红点测试' }, token);
  const boardBadgeAfter = await call('GET', '/api/messages/badge', undefined, B.token);
  const boardInbox = await call('GET', '/api/messages', undefined, B.token);
  const boardNotice = boardInbox.messages.find((m) => m.kind === 'friend_message' && String(m.text).indexOf('留言红点测试') >= 0);
  const boardSeen = await call('POST', '/api/messages/seen', {}, B.token);
  const boardBadgeSeen = await call('GET', '/api/messages/badge', undefined, B.token);
  await call('POST', '/api/messages/read', { ids: boardNotice ? [boardNotice.id] : [] }, B.token);
  const boardBadgeRead = await call('GET', '/api/messages/badge', undefined, B.token);
  ok('留言板新消息点亮主界面 NEW，打开消息页不灭，读完留言才灭',
    !!boardNotice
    && boardBadgeAfter.leave === boardBadgeBefore.leave + 1
    && boardBadgeAfter.unread === boardBadgeBefore.unread + 1
    && boardBadgeAfter.total === boardBadgeBefore.total + 1
    && boardSeen.leave === boardBadgeAfter.leave
    && boardBadgeSeen.leave === boardBadgeAfter.leave
    && boardBadgeRead.leave === boardBadgeAfter.leave - 1,
    { before: boardBadgeBefore, after: boardBadgeAfter, seen: boardSeen, badgeSeen: boardBadgeSeen, read: boardBadgeRead });

  // 两个真实账号：发帖/回复的重试、跨账号删除保护及列表与详情。
  const postData = { title: '测试 <帖子>', body: '论坛正文', requestKey: 'forum-qa-post-000001' };
  const post = await call('POST', '/api/forum/posts', postData, token);
  const repeatedPost = await call('POST', '/api/forum/posts', postData, token);
  const replyData = { body: '第二位玩家的回复', requestKey: 'forum-qa-reply-00001' };
  const threadUrl = '/api/forum/posts/' + post.post.id;
  const forumReply = await call('POST', threadUrl + '/replies', replyData, B.token);
  const repeatedReply = await call('POST', threadUrl + '/replies', replyData, B.token);
  const listing = await call('GET', '/api/forum/posts', undefined, B.token);
  const detail = await call('GET', threadUrl, undefined, token);
  let denied = false;
  try { await call('DELETE', threadUrl, undefined, B.token); } catch (e) { denied = e.status === 403; }
  await call('DELETE', '/api/forum/replies/' + forumReply.reply.id, undefined, B.token);
  await call('DELETE', threadUrl, undefined, token);
  const emptyForum = await call('GET', '/api/forum/posts', undefined, token);
  ok('论坛发帖回复幂等、显示真实账号、限制跨账号删除并支持本人删除',
    post.post.id === repeatedPost.post.id && forumReply.reply.id === repeatedReply.reply.id && denied
    && listing.posts.some(p => p.id === post.post.id) && detail.replies.length === 1
    && detail.replies[0].author.accountId === target.accountId && !emptyForum.posts.some(p => p.id === post.post.id));

  // 论坛细化：管理员标识、编号检索、违禁词、每日额度与管理员删帖/词库接口。
  const adminPost = await call('POST', '/api/forum/posts', { title: '管理员编号测试', body: '管理正文', requestKey: 'forum-admin-post-0001' }, token);
  const adminThread = '/api/forum/posts/' + adminPost.post.id;
  const byNumber = await call('GET', '/api/forum/posts?no=' + adminPost.post.id, undefined, B.token);
  let bannedWord = null;
  try { await call('POST', '/api/forum/posts', { title: '傻 逼', body: '正文', requestKey: 'forum-banned-000001' }, B.token); } catch (e) { bannedWord = e; }
  let overviewDenied = false;
  try { await call('GET', '/api/forum/admin/overview', undefined, B.token); } catch (e) { overviewDenied = e.status === 403; }
  const overview = await call('GET', '/api/forum/admin/overview', undefined, token);
  const managedReply = await call('POST', adminThread + '/replies', { body: '给管理员删的回复', requestKey: 'forum-admin-reply-01' }, B.token);
  const adminDeleteReply = await call('DELETE', '/api/forum/replies/' + managedReply.reply.id, undefined, token);
  const wordAdd = await call('POST', '/api/forum/admin/words', { word: '自定义测试词', category: '其他' }, token);
  let customBanned = false;
  try { await call('POST', '/api/forum/posts', { title: '自定义测试词', body: '正文', requestKey: 'forum-custom-000001' }, B.token); } catch (e) { customBanned = e.status === 400; }
  await call('POST', '/api/forum/admin/words/delete', { word: '自定义测试词' }, token);
  const forumConfig = require('../server/config').config;
  const oldPostLimit = forumConfig.forumDailyPostLimit;
  forumConfig.forumDailyPostLimit = 2;
  let quotaDenied = false;
  try { await call('POST', '/api/forum/posts', { title: '额度测试', body: '正文', requestKey: 'forum-quota-000001' }, token); } catch (e) { quotaDenied = e.status === 429; }
  forumConfig.forumDailyPostLimit = oldPostLimit;
  await call('DELETE', adminThread, undefined, token);
  ok('论坛管理：管理员标识、编号检索、违禁词、每日额度与管理员删帖接口',
    A.profile.account.forumAdmin === true && B.profile.account.forumAdmin === false
    && byNumber.posts.length === 1 && byNumber.posts[0].author.admin === true
    && bannedWord && bannedWord.status === 400 && overviewDenied && overview.ok
    && overview.capacity.posts >= 1 && overview.words.length > 0
    && overview.admins.some(a => a.accountId === A.profile.account.accountId)
    && adminDeleteReply.ok && adminDeleteReply.admin
    && wordAdd.words.some(w => w.word === '自定义测试词') && customBanned && quotaDenied);

  /* 对真实 API 使用独立存档：其他竞技场门票不能代付，重试不能重复结算。 */
  const C = await call('POST', '/api/register', { name: '丙鼠测', password: 'pass-c1' }, undefined, qaDevice('qa-c'));
  const cid = C.profile.account.accountId;
  db.tx(() => store.runOnSave(cid, ({ save }) => {
    save.level = 20; save.energy = 0; save.lastEnergyTs = Date.now(); save.props = { 39: 1, 23: 2, 1: 2, 2: 1 };
  }, { snapshotSource: 'test-arena' }));
  const noTicketBefore = await call('GET', '/api/state', undefined, C.token);
  let wrongTicket = null;
  try { await call('POST', '/api/arena/join', { kind: 0, rev: noTicketBefore.rev }, C.token); } catch (e) { wrongTicket = e; }
  const noTicketAfter = await call('GET', '/api/state', undefined, C.token);
  db.tx(() => store.runOnSave(cid, ({ save }) => { save.props[36] = 1; }));
  const withTicket = await call('GET', '/api/state', undefined, C.token);
  const joined = await call('POST', '/api/arena/join', { kind: 0, rev: withTicket.rev }, C.token);
  const afterJoin = await call('GET', '/api/state', undefined, C.token);
  ok('竞技场只消耗对应门票，失败报名不扣其他场门票；不自动喝药', wrongTicket && wrongTicket.status === 409
    && same(noTicketBefore.save, noTicketAfter.save)
    && noTicketAfter.save.props[1] === 2 && noTicketAfter.save.props[2] === 1
    && joined.paid.itemId === 36
    && !afterJoin.save.props[36] && afterJoin.save.props[39] === 1
    && afterJoin.save.props[1] === 2 && afterJoin.save.props[2] === 1);

  /* 竞技场药丸口径（用户 2026-11）：属性丸不进面板、也不扣次数；经验丸只在经验场发经验时扣 1 次。 */
  db.tx(() => store.runOnSave(cid, ({ save }) => {
    save.propsStates = { 3: 20, 7: 20 };
  }, { snapshotSource: 'test-arena-pills' }));

  const cases = [
    { kind: 'arena' },
    { kind: 'stage', stageId: 1 },
    { kind: 'friend', snapshotId: require('../server/game/snapshot').currentSnapshot(B.profile.account.accountId).id },
  ];
  /* 切磋现在要求双方是好友；C 也是独立账号：先申请 → B 拒绝（关系不成立）→ 再申请 → B 同意。 */
  await call('POST', '/api/friends', { target: B.profile.account.display }, C.token);
  const cReq1 = (await call('GET', '/api/friends/requests', undefined, B.token)).requests[0];
  await call('POST', '/api/friends/requests/' + cReq1.messageId, { accept: false }, B.token);
  const cRejected = await call('GET', '/api/friends', undefined, C.token);
  await call('POST', '/api/friends', { target: B.profile.account.display }, C.token);
  const cReq2 = (await call('GET', '/api/friends/requests', undefined, B.token)).requests[0];
  await call('POST', '/api/friends/requests/' + cReq2.messageId, { accept: true }, B.token);
  const cFriends = await call('GET', '/api/friends', undefined, C.token);
  ok('拒绝好友申请不会建立关系，重新申请并同意后才成为好友',
    cRejected.friends.length === 0 && cFriends.friends.some((f) => f.accountId === B.profile.account.accountId));
  let replaySafe = true;
  for (const item of cases) {
    const before = await call('GET', '/api/state', undefined, C.token);
    const body = { ...item, rev: before.rev, idemKey: 'retry-' + item.kind };
    const first = await call('POST', '/api/battle', body, C.token);
    const settled = await call('GET', '/api/state', undefined, C.token);
    const second = await call('POST', '/api/battle', body, C.token);
    const after = await call('GET', '/api/state', undefined, C.token);
    replaySafe = replaySafe && second.duplicate && first.combatId === second.combatId
      && same(first.result, second.result) && same(first.settlement, second.settlement)
      && same(first[item.kind], second[item.kind]) && same(settled.save, after.save) && settled.rev === after.rev;
  }
  let missingRev = null;
  try { await call('POST', '/api/battle', { kind: 'stage', stageId: 1 }, C.token); } catch (e) { missingRev = e; }
  ok('关卡、竞技和切磋断线重试保留原战斗与结算，缺版本被拒', replaySafe && missingRev && missingRev.status === 400);

  /* 上面 cases 里那一场是竞技半决赛（不发经验）：属性丸/经验丸都不该动；
   * 接着打决赛（经验场，一定发经验）：只扣经验丸 1 次，属性丸仍然不动。 */
  const pillSemiState = await call('GET', '/api/state', undefined, C.token);
  const pillSemi = pillSemiState.save.propsStates || {};
  const cupBefore = Number(pillSemiState.save.goldCup) || 0;
  const cupTodayBefore = Number(pillSemiState.save.goldCupToday) || 0;
  const powerBefore = pillSemiState.save.power;
  db.tx(() => store.runOnSave(cid, ({ save }) => {
    if (!save.classicArenaRun) throw new Error('missing arena run');
    save.classicArenaRun.phase = 'final';
    save.classicArenaRun.finalist = Object.assign({}, save.classicArenaRun.finalist, {
      power: 1, agility: 1, speed: 1, hp: 1, maxHp: 1, weapons: [], skills: [], pets: [],
    });
    save.power = 100000;
  }, { snapshotSource: 'test-arena-champion' }));
  const championState = await call('GET', '/api/state', undefined, C.token);
  const pillFinal = await call('POST', '/api/battle', { kind: 'arena', rev: championState.rev, idemKey: 'arena-pill-final' }, C.token);
  const pillAfterState = await call('GET', '/api/state', undefined, C.token);
  const pillAfter = pillAfterState.save.propsStates || {};
  db.tx(() => store.runOnSave(cid, ({ save }) => { save.power = powerBefore; }, { snapshotSource: 'test-arena-restore' }));
  ok('竞技场不扣属性丸次数，经验丸只在经验场发经验时扣 1 次',
    pillSemi[3] === 20 && pillSemi[7] === 20
    && pillAfter[3] === 20
    && pillAfter[7] === (Number(pillFinal.settlement && pillFinal.settlement.exp) > 0 ? 19 : 20));
  ok('任一竞技场冠军固定 +1 金杯',
    pillFinal.ok && pillFinal.settlement && pillFinal.settlement.position === 0
    && pillFinal.settlement.goldCup === 1 && pillFinal.arena && pillFinal.arena.rewards && pillFinal.arena.rewards.goldCup === 1
    && (Number(pillAfterState.save.goldCup) || 0) === cupBefore + 1
    && (pillAfterState.save.goldCupDate !== pillSemiState.save.goldCupDate
      || (Number(pillAfterState.save.goldCupToday) || 0) === cupTodayBefore + 1),
    { position: pillFinal.settlement && pillFinal.settlement.position, cup: pillFinal.settlement && pillFinal.settlement.goldCup,
      before: cupBefore, after: pillAfterState.save.goldCup });

  db.tx(() => store.runOnSave(cid, ({ save }) => { save.level = 40; save.props[87] = 1; }, { snapshotSource: 'campaign-test' }));
  const campaigns = require('../server/game/campaign');
  const createdRoom = campaigns.create({ accountId: cid, bossId: 1 });
  const playedRoom = campaigns.runRoom(createdRoom.room.id);
  const campaignReplay = await call('GET', '/api/combat/' + playedRoom.settled[0].reward.combatId, undefined, C.token);
  ok('征战录像保留参战者与真实首领外观', campaignReplay.me.name === '丙鼠测'
    && campaignReplay.foe.campaign.bossId === 1 && campaignReplay.result.rounds.length > 0);
  campaigns.ack({ accountId: cid, code: createdRoom.room.code });

  const D = await call('POST', '/api/register', { name: '丁鼠测', password: 'pass-d1' }, undefined, qaDevice('qa-d'));
  const E = await call('POST', '/api/register', { name: '戊鼠测', password: 'pass-e1' }, undefined, qaDevice('qa-e'));
  const did = D.profile.account.accountId, eid = E.profile.account.accountId;
  for (const id of [cid, did, eid]) db.tx(() => store.runOnSave(id, ({ save }) => { save.level = 40; save.props[87] = 1; }));
  const queue = campaigns.enqueue({ accountId: cid, bossId: 1 });
  campaigns.join({ accountId: did, code: queue.room.code });
  const repeatJoin = campaigns.enqueue({ accountId: did, bossId: 1 }); // 已在队列里，返回原房间。
  const left = campaigns.leave({ accountId: cid, code: queue.room.code });
  const afterHost = campaigns.roomOf(queue.room.id);
  campaigns.join({ accountId: eid, code: queue.room.code });
  const seats = db.all('SELECT seat FROM campaign_members WHERE room_id = ? ORDER BY seat', queue.room.id).map(r => r.seat);
  const dailyMod = require('../server/game/settlement');
  db.run('UPDATE campaign_rooms SET resolve_at = ? WHERE id = ?', Date.now() - 1, queue.room.id);
  campaigns.pump();
  const dailyAfterTimeout = [cid, did, eid].map(id => dailyMod.todayCount(id, 'campaign'));
  ok('征战真人等待超时不扣门票/次数，房主移交且空位可复用', repeatJoin.already && !left.refunded
    && Number(afterHost.host_id) === did && same(seats, [0, 1])
    && [cid, did, eid].every(id => Number(store.peek(id).props[87]) === 1)
    && same(dailyAfterTimeout, [1, 0, 0])
    && campaigns.roomOf(queue.room.id).status === 'failed'
    && campaigns.roomOf(queue.room.id).failed_reason === 'timeout');

  /* 12. 征战 */
  const bosses = await call('GET', '/api/campaign/bosses', undefined, token);
  ok('campaign bosses', bosses.ok && bosses.bosses.length === 5 && bosses.bosses[4].locked === true);
  ok('campaign tickets 0', bosses.tickets === 0);
  /* C 在上一段已用掉 1 次；补 2 次到 3 次上限，第 4 次必须被拒。 */
  db.tx(() => store.runOnSave(cid, ({ save }) => { save.props[87] = 5; }, { snapshotSource: 'campaign-test' }));
  let dailyError = null;
  for (let i = 0; i < 2; i++) {
    const room = campaigns.create({ accountId: cid, bossId: 1 });
    campaigns.runRoom(room.room.id);
    campaigns.ack({ accountId: cid, code: room.room.code });
  }
  try { campaigns.create({ accountId: cid, bossId: 1 }); } catch (e) { dailyError = e; }
  ok('征战每天 3 次：第 4 次被拒，服务端计数为 3',
    dailyMod.todayCount(cid, 'campaign') === 3 && dailyError && /3 次/.test(dailyError.message));

  /* 13. 快照同步 */
  const sync = await call('POST', '/api/snapshot/sync', {}, token);
  ok('snapshot sync', sync.ok && sync.snapshot);

  /* 14. 静态资源入口 */
  const pageRes = await fetch(BASE + '/');
  ok('static index served or 404-with-json', pageRes.status === 200 || pageRes.status === 404);
  const traversalRes = await fetch(BASE + '/foo/%5c..%5cserver/config.js');
  ok('static deny prefix cannot be bypassed with encoded backslash', traversalRes.status === 404);

  /* 15. 动作版本与随机选择同属服务端权威，不能省略版本或伪造/重抽候选。 */
  const rejects = async (body, status) => { try { await call('POST', '/api/action', body, B.token); return false; } catch (e) { return e.status === status; } };
  let authority = true;
  for (const invalid of [undefined, null, 0, -1, 1.5, '1', 'bad']) {
    authority = await rejects({ name: 'buyProp', args: [1, 1], rev: invalid }, 400) && authority;
  }
  db.tx(() => store.runOnSave(B.profile.account.accountId, ({ save }) => {
    save.level = 60; save.weapons = ['1:1', '2:1', '3:1', '4:1']; save.skills = []; save.props = { 47: 3, 48: 2 };
  }));
  for (const fruit of [47, 48]) {
    const before = await call('GET', '/api/state', undefined, B.token);
    const opened = await call('POST', '/api/action', { name: 'useProp', args: [fruit], rev: before.rev }, B.token);
    const repeated = await call('POST', '/api/action', { name: 'fruitOptions', args: [fruit], rev: opened.rev }, B.token);
    const candidates = [];
    if (fruit === 48) for (const ref of before.save.weapons) candidates.push({ kind: 'weapon', id: parseInt(ref) });
    else for (const kind of ['weapon', 'skill']) (kind === 'weapon' ? globalThis.weaponsMap : globalThis.skillsMap).each((_, v) => {
      if (globalThis.GData.canLearn(kind, v.id, before.save.level)) candidates.push({ kind, id: Number(v.id) });
    });
    const choices = opened.result.options;
    const forged = candidates.find(c => !choices.some(x => x.kind === c.kind && Number(x.id) === c.id)
      && !(before.save[c.kind === 'weapon' ? 'weapons' : 'skills'] || []).some(ref => parseInt(ref) === c.id));
    // 恶魔果实的伪造项应为已掌握、但本轮随机结果未给出的武器。
    const outside = fruit === 48 ? candidates.find(c => !choices.some(x => x.kind === c.kind && Number(x.id) === c.id)) : forged;
    authority = choices.length === 1 && !!outside
      && await rejects({ name: 'applyFruitChoice', args: [fruit, outside.kind, outside.id], rev: repeated.rev }, 400) && authority;
    const picked = choices[0];
    const applied = await call('POST', '/api/action', { name: 'applyFruitChoice', args: [fruit, picked.kind, Number(picked.id)], rev: repeated.rev }, B.token);
    const after = await call('GET', '/api/state', undefined, B.token);
    authority = authority && opened.result.needsFruitChoice && same(choices, repeated.result.options)
      && opened.rev > before.rev && repeated.rev === opened.rev && applied.result.ok
      && after.save.props[fruit] === before.save.props[fruit] - 1
      && await rejects({ name: 'applyFruitChoice', args: [fruit, picked.kind, Number(picked.id)], rev: applied.rev }, 400);
  }
  ok('动作必须携带有效版本；果实一次只给 1 个随机武技、重复打开不重抽、仅能结算本轮候选且领取一次', authority);

  /* 取消：果实照常消耗、不改变武技，但记进 fruitSeen —— 下一次先给没出现过的。 */
  const cancelBefore = await call('GET', '/api/state', undefined, B.token);
  const cancelOpen = await call('POST', '/api/action', { name: 'useProp', args: [47], rev: cancelBefore.rev }, B.token);
  const cancelPick = cancelOpen.result.options[0];
  const cancelled = await call('POST', '/api/action', { name: 'cancelFruitChoice', args: [47], rev: cancelOpen.rev }, B.token);
  const afterCancel = await call('GET', '/api/state', undefined, B.token);
  const seenCode = (cancelPick.kind === 'weapon' ? 'w' : 's') + Number(cancelPick.id);
  const noReplay = await rejects({ name: 'applyFruitChoice', args: [47, cancelPick.kind, Number(cancelPick.id)], rev: afterCancel.rev }, 400);
  const nextOpen = await call('POST', '/api/action', { name: 'useProp', args: [47], rev: afterCancel.rev }, B.token);
  const nextPick = nextOpen.result.options[0];
  const rotated = !(nextPick.kind === cancelPick.kind && Number(nextPick.id) === Number(cancelPick.id));
  const nextApplied = await call('POST', '/api/action', { name: 'applyFruitChoice', args: [47, nextPick.kind, Number(nextPick.id)], rev: nextOpen.rev }, B.token);
  ok('果实取消也消耗；取消过的武技记入 fruitSeen，下一次换一个，旧候选不能再结算',
    cancelled.result.ok && nextApplied.result.ok && rotated && noReplay
      && Array.isArray(afterCancel.save.fruitSeen && afterCancel.save.fruitSeen[47])
      && afterCancel.save.fruitSeen[47].indexOf(seenCode) >= 0
      && afterCancel.save.props[47] === cancelBefore.save.props[47] - 1);

  /* 战后宝箱：断线恢复与重复请求都不能把同一份奖励发两次。 */
  const pendingBefore = await call('GET', '/api/battle/chest', undefined, token);
  let foreignChest;
  try { await call('POST', '/api/battle/chest', { combatId: fight1.combatId, index: 2 }, B.token); }
  catch (e) { foreignChest = e; }
  const beforeChest = await call('GET', '/api/state', undefined, token);
  // 真实关闭并重开 SQLite，检验票据不是进程内对象；游戏服务器仍在同一端口。
  db.close(); db.open();
  const restored = await call('GET', '/api/battle/chest', undefined, token);
  const claimed = await call('POST', '/api/battle/chest', { combatId: fight1.combatId, index: 2,
    prize: { id: 8, count: 999999 } }, token);
  const firstGrant = await call('GET', '/api/state', undefined, token);
  const retriedChest = await call('POST', '/api/battle/chest', { combatId: fight1.combatId, index: 0 }, token);
  const retriedClaimedBattle = await call('POST', '/api/battle', { kind: 'random', rev: st1.rev, idemKey: 'selected-bot' }, token);
  await call('GET', '/api/replay/' + fight1.combatId, undefined, token);
  const afterChest = await call('GET', '/api/state', undefined, token);
  const pendingAfter = await call('GET', '/api/battle/chest', undefined, token);
  const prize = claimed.prize;
  const granted = prize.id === 8
    ? firstGrant.save.goldPoint === beforeChest.save.goldPoint + prize.count
    : prize.id === 15 ? firstGrant.rev > beforeChest.rev
      : (firstGrant.save.props[prize.id] || 0) === (beforeChest.save.props[prize.id] || 0) + prize.count;
  ok('宝箱先持久化且不泄露奖池，账号绑定，断线可恢复，四选一仅发一次且回放不发奖',
    fight1.chest && !fight1.settlement.drop && foreignChest && foreignChest.status === 404
    && pendingBefore.chests.some(c => c.combatId === fight1.combatId)
    && pendingBefore.chests.every(c => !c.items && !c.prizes && c.choices === 4)
    && restored.chests.some(c => c.combatId === fight1.combatId)
    && !claimed.duplicate && claimed.items.length === 4 && same(claimed.items[2], prize) && granted
    && retriedChest.duplicate && retriedChest.picked === 2 && same(retriedChest.items, claimed.items)
    && retriedClaimedBattle.duplicate && retriedClaimedBattle.chest.claimed
    && same(firstGrant.save, afterChest.save) && same(retriedChest.save, firstGrant.save)
    && pendingAfter.pendingCount === pendingBefore.pendingCount - 1
    && !pendingAfter.chests.some(c => c.combatId === fight1.combatId));

  /* 金宝箱：begin/confirm 走服务端，固定 10 点 + 其它；重开接口已移除。 */
  db.tx(() => store.runOnSave(A.profile.account.accountId, ({ save }) => {
    save.props = Object.assign({}, save.props, { 90: 1 });
    save.chestPending = null;
    save.goldPoint = 10000;
  }));
  let chestState = await call('GET', '/api/state', undefined, token);
  const beginChestOut = await call('POST', '/api/action', { name: 'beginChest', args: [90], rev: chestState.rev }, token);
  const beginPending = beginChestOut.result && beginChestOut.result.pending;
  const pointGainKey = beginPending && beginPending.pointsGain ? JSON.stringify(beginPending.pointsGain) : '';
  const confirm = await call('POST', '/api/action', { name: 'confirmChest', args: [], rev: beginChestOut.rev }, token);
  chestState = await call('GET', '/api/state', undefined, token);
  ok('金宝箱走服务端动作：固定 10 点属性 + 其它奖励，重开接口已移除',
    !!beginChestOut.result && beginChestOut.result.ok === true
    && !!beginPending && beginPending.points === 10 && beginPending.reward.kind !== 'points'
    && pointGainKey
    && confirm.result && confirm.result.ok === true && confirm.result.points === 10
    && JSON.stringify(confirm.result.pointsGain) === pointGainKey && !chestState.save.chestPending);

  /* 设备协议（2026-11 新口径）：
   *  · 同一设备最多**创建** 3 个账号，第 4 个拒绝（DEVICE_ACCOUNT_LIMIT）；
   *  · 同一设备可以登录多个已有账号，登录不占创建额度；
   *  · 同一账号只保留一个在线会话：第二次登录顶掉旧令牌，旧令牌收到 SESSION_KICKED；
   *  · 换设备只提醒、不拦。 */
  const cfg = require('../server/config').config, httpApi = require('../server/http');
  const native = { 'x-device-id': 'native-qa'.padEnd(64, '_'), 'x-device-platform': 'windows', 'x-device-provider': 'machine-guid' };
  const native2 = { ...native, 'x-device-id': 'legacy-qa'.padEnd(64, '_') };
  const noDevice = { 'x-device-id': '', 'x-device-platform': '', 'x-device-provider': '' };
  const deviceDenied = async (method, url, body, authToken, headers, code) => {
    try { await call(method, url, body, authToken, headers); return false; } catch (e) { return e.status === 403 && e.body.error.code === code; }
  };
  cfg.allowBrowserDevices = false;
  const blockedWeak = await deviceDenied('GET', '/api/state', undefined, token, undefined, 'DEVICE_UNSUPPORTED');
  const blockedOld = await deviceDenied('POST', '/api/action', { name: 'buyProp', args: [1, 1], rev: 1 }, token, noDevice, 'DEVICE_REQUIRED');
  /* 注册限流按 IP 算：测试里给每个新号一个独立 XFF，才能单独验证“设备 3 个”而不是先撞 429。 */
  cfg.trustProxy = true;
  const regIp = (n) => ({ ...native, 'x-forwarded-for': '203.0.113.' + n });
  const F = await call('POST', '/api/register', { name: '设备甲', password: 'pass-f1' }, undefined, regIp(11));
  const F2 = await call('POST', '/api/register', { name: '设备乙', password: 'pass-g1' }, undefined, regIp(12));
  const F3 = await call('POST', '/api/register', { name: '设备丙', password: 'pass-h1' }, undefined, regIp(13));
  const blockedFourth = await deviceDenied('POST', '/api/register', { name: '设备丁', password: 'pass-i1' }, undefined, regIp(14), 'DEVICE_ACCOUNT_LIMIT');
  const switchB = await call('POST', '/api/login', { name: '乙鼠', password: 'pass-b1' }, undefined, native);
  if (switchB.token) B.token = switchB.token; // 新会话顶掉旧令牌，后续测试用最新令牌
  const quota = await call('GET', '/api/device/quota', undefined, F.token, native);
  const kickFirst = F.token;
  const FLogin2 = await call('POST', '/api/login', { name: '设备甲', password: 'pass-f1' }, undefined, native);
  let kickErr = null;
  try { await call('GET', '/api/state', undefined, kickFirst, native); } catch (e) { kickErr = e; }
  /* 旧会话迁移到新设备：只提醒，不因设备已绑定报 DEVICE_BOUND。 */
  const regA = db.get('SELECT reg_ip, reg_device_hash, reg_platform, reg_at FROM accounts WHERE id = ?', A.profile.account.accountId);
  const legacyF = 'legacy-session-f', authApi = require('../server/auth');
  db.run('INSERT INTO sessions(token_hash,account_id,created_at,last_seen,expires_at) VALUES (?,?,?,?,?)',
    authApi.sha256(legacyF), F.profile.account.accountId, Date.now(), Date.now(), Date.now() + 60000);
  const migratedF = await call('GET', '/api/state', undefined, legacyF, native2);
  /* ANDROID_ID 不可用时客户端退回本安装随机标识（platform=android / provider=installation）：
   * 即使服务端关了浏览器设备，也必须放行原生安卓兜底。 */
  const androidFallback = { ...native, 'x-device-id': 'android-fallback'.padEnd(64, '_'),
    'x-device-platform': 'android', 'x-device-provider': 'installation' };
  const fallbackReg = await call('POST', '/api/register', { name: '安卓兜底', password: 'pass-j1' },
    undefined, { ...androidFallback, 'x-forwarded-for': '203.0.113.16' });
  cfg.allowBrowserDevices = true; cfg.trustProxy = true;
  await call('GET', '/api/profile', undefined, FLogin2.token, { ...native, 'x-forwarded-for': '198.51.100.99,203.0.113.7' });
  const sharedB = await call('GET', '/api/state', undefined, B.token);
  const adminReport = require('../server/admin-audit').report(db.handle(), { days: 7, limit: 50, ip: '', account: '' });
  const directIp = httpApi.clientIp({ socket: { remoteAddress: '198.51.100.4' }, headers: { 'x-forwarded-for': '1.1.1.1' } });
  cfg.trustProxy = false;
  ok('设备协议：同设备最多创建 3 账号 / 同账号单会话顶掉旧设备 / 换机只提醒',
    blockedWeak && blockedOld && F.ok && F2.ok && F3.ok && blockedFourth
    && quota.ok && quota.created === 3 && quota.limit === 3 && quota.ipLimit === 0
    && kickErr && kickErr.status === 401 && kickErr.body.error.code === 'SESSION_KICKED'
    && FLogin2.ok && migratedF.save.name === '设备甲'
    && migratedF.alerts.some((a) => a.payload && a.payload.newDevice === true)
    && !!regA && !!regA.reg_ip && !!regA.reg_device_hash && regA.reg_platform === 'browser' && regA.reg_at > 0
    && sharedB.save.name === '乙鼠'
    && !db.get('SELECT id FROM accounts WHERE name = ?', '设备丁')
    && adminReport.sharedIps.some(row => row.accounts >= 2)
    && adminReport.events.some(row => row.event === 'ip_change' && row.ip === '203.0.113.7')
    && !JSON.stringify(adminReport).includes(native['x-device-id']) && !JSON.stringify(adminReport).includes(F.token)
    && directIp === '198.51.100.4');
  ok('安卓 ANDROID_ID 不可用时的安装标识兜底仍可注册',
    !!fallbackReg.token && fallbackReg.profile && fallbackReg.profile.account
    && fallbackReg.profile.account.name === '安卓兜底');

  /* IP 额度：同一来源 IP 最多创建 3 个账号；用不同设备也不能绕过。 */
  const oldIpLimit = cfg.accountsPerIp;
  cfg.accountsPerIp = 1;
  cfg.trustProxy = true;
  const ipNative = (n) => ({ ...native, 'x-device-id': ('ip-qa-' + n).padEnd(64, '_') });
  const ipOne = await call('POST', '/api/register', { name: '网络一号', password: 'pass-ip1' }, undefined,
    { ...ipNative(1), 'x-forwarded-for': '203.0.113.50' });
  const ipBlocked = await deviceDenied('POST', '/api/register', { name: '网络二号', password: 'pass-ip2' }, undefined,
    { ...ipNative(2), 'x-forwarded-for': '203.0.113.50' }, 'DEVICE_ACCOUNT_LIMIT');
  cfg.accountsPerIp = oldIpLimit;
  cfg.trustProxy = false;
  ok('同一 IP 最多创建 3 个账号（限额按 IP 统计，不因换设备绕过）', ipOne.ok && ipBlocked);

  /* 天梯周奖励：本赛区前 30、且至少超过一个人机；同周只领一次。 */
  db.run('UPDATE ratings SET score = 0 WHERE account_id = ? AND season = ?', aId, weekNow);
  const notPassed = await call('GET', '/api/ladder/award', undefined, token);
  const notPassedClaim = await call('POST', '/api/ladder/award', {}, token);
  db.run('UPDATE ratings SET score = 400 WHERE account_id = ? AND season = ?', aId, weekNow);
  const awardStatus = await call('GET', '/api/ladder/award', undefined, token);
  const inactiveAward = await call('GET', '/api/ladder/award', undefined, C.token);
  const beforeAward = await call('GET', '/api/state', undefined, token);
  const claimedAward = await call('POST', '/api/ladder/award', {}, token);
  const afterAward = await call('GET', '/api/state', undefined, token);
  const againAward = await call('POST', '/api/ladder/award', {}, token);
  const inactiveClaim = await call('POST', '/api/ladder/award', {}, C.token);
  ok('天梯周奖励只发赛区前30名且超过人机，金杯一次入账且同周不可重复',
    notPassed.eligible === false && notPassed.surpassedBot === false
    && notPassedClaim.ok === false && notPassedClaim.error && notPassedClaim.error.code === 'NOT_ELIGIBLE'
    && awardStatus.eligible === true && awardStatus.played > 0 && awardStatus.rank > 0 && awardStatus.surpassedBot === true
    && claimedAward.ok === true && Number(claimedAward.cups) === 50
    && afterAward.save.goldCup === beforeAward.save.goldCup + 50
    && againAward.ok === false && againAward.already === true
    && againAward.error && againAward.error.code === 'ALREADY_CLAIMED' && /已经领取过/.test(againAward.error.msg || '')
    && inactiveAward.eligible === false && inactiveAward.rank > 30 && inactiveAward.played === 0
    && inactiveClaim.ok === false && inactiveClaim.error && inactiveClaim.error.code === 'NOT_ELIGIBLE',
    { awardStatus, claimedAward, againAward, inactiveAward, inactiveClaim, notPassedClaim,
      beforeCup: beforeAward.save.goldCup, afterCup: afterAward.save.goldCup });

  /* 周一结算：玩家上周 800 → 本周 400；人机同时回到 300。 */
  const lastWeek = (() => {
    const base = Date.parse(weekNow + 'T00:00:00Z') - 7 * 86400000;
    return new Date(base).toISOString().slice(0, 10);
  })();
  db.run('DELETE FROM ratings WHERE account_id = ? AND season = ?', aId, weekNow);
  db.run('INSERT INTO ratings (account_id, season, score, wins, losses, streak, updated_at) VALUES (?,?,800,0,0,1,?)', aId, lastWeek, Date.now());
  db.run('UPDATE rank_bots SET week = ?', lastWeek);
  db.run("UPDATE meta SET value = ? WHERE key = 'rank_week'", lastWeek);
  const halved = await call('GET', '/api/ladder?limit=5', undefined, token);
  ok('周一积分减半：上周 800 → 本周 400，人机回到 300',
    halved.me.score === 400 && halved.top.filter((x) => x.bot).every((x) => x.score === 300));

  /* 人机积分硬下限 50（人机作为防守方只掉 1 分，这里直接给一个越界变化量试夹取）。 */
  const settleGame = require('../server/game/settlement');
  const floorId = settleGame.botsFor('d30')[0].id;
  db.run('UPDATE rank_bots SET score = 55 WHERE id = ?', floorId);
  settleGame.applyBotResult(floorId, true, -100);
  const floored = settleGame.botById(floorId).score;
  db.run('UPDATE rank_bots SET score = 300 WHERE id = ?', floorId);
  ok('人机积分有 50 硬下限', floored === 50);

  /* 每日次数不限（用户 2026-11 口径）：前 10 场免费、11-20 每场 5 金、21-30 每场 10 金、第 31 场起 20 金封顶。 */
  const day = settleGame.rankDailyStatus(aId).date;
  const beforeTier = settleGame.rankDailyStatus(aId).played;
  db.run('INSERT INTO daily_counts (account_id,kind,date,count) VALUES (?,?,?,10) ON CONFLICT(account_id,kind,date) DO UPDATE SET count=10', aId, 'rank', day);
  const paidTier = settleGame.rankDailyStatus(aId);
  db.run('UPDATE daily_counts SET count = 20 WHERE account_id = ? AND kind = ? AND date = ?', aId, 'rank', day);
  const lateTier = settleGame.rankDailyStatus(aId);
  db.run('UPDATE daily_counts SET count = 30 WHERE account_id = ? AND kind = ? AND date = ?', aId, 'rank', day);
  const capTier = settleGame.rankDailyStatus(aId);
  db.run('UPDATE daily_counts SET count = 999 WHERE account_id = ? AND kind = ? AND date = ?', aId, 'rank', day);
  const overTier = settleGame.rankDailyStatus(aId);
  db.run('UPDATE daily_counts SET count = ? WHERE account_id = ? AND kind = ? AND date = ?', beforeTier, aId, 'rank', day);
  ok('天梯每日次数不限：11-20 场 5 金、21-30 场 10 金、第31场起 20 金封顶，打到 999 场仍可继续',
    paidTier.cost === 5 && paidTier.tier === 'paid' && paidTier.tierStart === 11
    && lateTier.cost === 10 && lateTier.tier === 'late' && lateTier.tierStart === 21
    && capTier.cost === 20 && capTier.tier === 'cap' && capTier.tierStart === 31
    && overTier.played === 999 && overTier.cost === 20 && overTier.left === null
    && lateTier.limit === 0 && lateTier.unlimited === true && lateTier.left === null);

  /* 注销只删除自己；共享战绩匿名保留，不改其他玩家的已结算经济。 */
  const bid = B.profile.account.accountId, aid = A.profile.account.accountId;
  const secondSession = await call('POST', '/api/login', { name: '乙鼠', password: 'pass-b1' });
  B.token = secondSession.token; // 单会话：旧令牌已被第二会话顶掉
  const statusOf = async (method, url, body, authToken) => { try { await call(method, url, body, authToken); return 200; } catch (e) { return e.status; } };
  /* 连点器：同一账号两次开战的最小间隔由服务端执行；同一 idemKey 的断线重试放行。 */
  const paceCfg = require('../server/config').config;
  const paceBefore = await call('GET', '/api/state', undefined, token);
  const oldFightInterval = paceCfg.fightIntervalMs;
  paceCfg.fightIntervalMs = 2000;
  const pacedFirst = await call('POST', '/api/battle', { kind: 'wood', rev: paceBefore.rev, idemKey: 'qa-pace-1' }, token);
  const pacedSecond = await statusOf('POST', '/api/battle', { kind: 'wood', rev: pacedFirst.rev, idemKey: 'qa-pace-2' }, token);
  const pacedCross = await statusOf('POST', '/api/battle', { kind: 'stage', stageId: 1, rev: pacedFirst.rev, idemKey: 'qa-pace-1' }, token);
  const pacedRetry = await call('POST', '/api/battle', { kind: 'wood', rev: paceBefore.rev, idemKey: 'qa-pace-1' }, token);
  paceCfg.fightIntervalMs = oldFightInterval;
  ok('连点器限速：两次开战间隔不足被拒，同一场的断线重试仍返回原结果',
    pacedSecond === 429 && pacedCross === 429 && pacedRetry.duplicate === true && pacedRetry.combatId === pacedFirst.combatId,
    { second: pacedSecond, cross: pacedCross, duplicate: pacedRetry.duplicate });
  /* 动作入口同样的服务端闸门（async 动作）：不依赖客户端「连点保护」开关。 */
  const actBefore = await call('GET', '/api/state', undefined, token);
  const oldActionInterval = paceCfg.actionIntervalMs;
  paceCfg.actionIntervalMs = 2000;
  const pacedAct1 = await call('POST', '/api/action', { name: 'doUpgrade', args: ['skill', 999], rev: actBefore.rev }, token);
  const pacedAct2 = await statusOf('POST', '/api/action', { name: 'doUpgrade', args: ['skill', 999], rev: pacedAct1.rev }, token);
  paceCfg.actionIntervalMs = oldActionInterval;
  ok('连点器限速：同一账号两次 async 动作间隔不足被服务端拒绝', pacedAct2 === 429, { act2: pacedAct2 });
  const wrongPassword = await statusOf('POST', '/api/account/delete', { password: 'wrong' }, B.token);
  const stillLoggedIn = await statusOf('GET', '/api/state', undefined, B.token);
  await call('POST', '/api/board', { toId: aid, text: '测试留言' }, B.token);
  const deletedAccountPost = await call('POST', '/api/forum/posts', { title: '待注销账号的帖子', body: '测试', requestKey: 'forum-delete-account-01' }, B.token);
  db.tx(() => {
    db.run('INSERT INTO campaign_rooms (id,code,boss_id,boss_level,host_id,created_at) VALUES (?,?,?,?,?,?)', 'delete-room', 'DELTEST', 1, 60, bid, Date.now());
    for (const [seat, id] of [bid, aid].entries()) db.run('INSERT INTO campaign_members (room_id,account_id,seat,joined_at) VALUES (?,?,?,?)', 'delete-room', id, seat, Date.now());
  });
  const beforeDelete = await call('GET', '/api/state', undefined, token);
  const deleted = await call('POST', '/api/account/delete', { password: 'pass-b1' }, B.token);
  const afterDelete = await call('GET', '/api/state', undefined, token);
  const anonReplay = await call('GET', '/api/replay/' + selectedPlayer.combatId, undefined, token);
  const remnants = ['accounts', 'sessions', 'saves', 'battle_snapshots', 'ratings', 'daily_counts', 'action_log', 'rank_awards', 'campaign_members', 'combat_chests', 'account_devices', 'account_ips']
    .some(table => db.get('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + (table === 'accounts' ? 'id' : 'account_id') + ' = ?', bid).n);
  ok('注销需正确密码、撤销全部会话与候选，匿名保留他人战绩及队列且经济不变',
    wrongPassword === 403 && stillLoggedIn === 200 && deleted.deleted && !remnants
    && await statusOf('GET', '/api/state', undefined, B.token) === 401
    && await statusOf('GET', '/api/state', undefined, secondSession.token) === 401
    && await statusOf('GET', '/api/fighter?snapshotId=' + player.snapshotId, undefined, token) === 404
    && anonReplay.foe.name === '已注销玩家' && anonReplay.result.names[1] === '已注销玩家'
    && !(await call('GET', '/api/forum/posts', undefined, token)).posts.some(p => p.id === deletedAccountPost.post.id)
    && !JSON.stringify(afterDelete.save).includes('乙鼠') && same(economy(beforeDelete.save), economy(afterDelete.save))
    && db.get('SELECT host_id FROM campaign_rooms WHERE id = ?', 'delete-room').host_id === aid
    && db.get('SELECT COUNT(*) AS n FROM friendships WHERE account_id = ? OR friend_id = ?', bid, bid).n === 0);

  /* 同一 IP 每天最多注册 / 注销各 5 次（2026-11 用户口径）。注册和注销分开计数：
   * 注册 5 次成功、第 6 次 429；换一个 IP 注销这 5 个 + 另 1 个账号，前 5 次成功、第 6 次 429。 */
  const dailyCfg = require('../server/config').config;
  const oldDailyLimit = dailyCfg.accountDailyLimit;
  const oldDailyTrust = dailyCfg.trustProxy;
  dailyCfg.accountDailyLimit = 5;
  dailyCfg.trustProxy = true;
  const dailyIp = (n) => ({ 'x-forwarded-for': '198.51.100.' + n });
  const regResults = [];
  for (let i = 0; i < 6; i += 1) {
    try {
      regResults.push(await call('POST', '/api/register', { name: '日限注册' + i, password: 'pass-q1' },
        null, { ...qaDevice('daily-reg-' + i), ...dailyIp(10) }));
    } catch (e) { regResults.push(e); }
  }
  let sixthAccount = null;
  try {
    sixthAccount = await call('POST', '/api/register', { name: '日限注销六', password: 'pass-q1' },
      null, { ...qaDevice('daily-del-six'), ...dailyIp(12) });
  } catch (e) { sixthAccount = e; }
  const deleteResults = [];
  for (const account of regResults.slice(0, 5).concat([sixthAccount])) {
    try {
      deleteResults.push(await call('POST', '/api/account/delete', { password: 'pass-q1' },
        account.token, dailyIp(11)));
    } catch (e) { deleteResults.push(e); }
  }
  dailyCfg.accountDailyLimit = oldDailyLimit;
  dailyCfg.trustProxy = oldDailyTrust;
  const blockedCode = (x) => x && x.status === 429 && x.body && x.body.error && x.body.error.code;
  ok('同一 IP 每天最多注册 / 注销各 5 次：第 6 次 429',
    regResults.slice(0, 5).every((x) => x && x.ok) &&
    blockedCode(regResults[5]) === 'ACCOUNT_DAILY_LIMIT' &&
    sixthAccount && sixthAccount.ok &&
    deleteResults.slice(0, 5).every((x) => x && x.deleted === true) &&
    blockedCode(deleteResults[5]) === 'ACCOUNT_DAILY_LIMIT',
    { regs: regResults.map((x) => x && (x.ok ? 'ok' : blockedCode(x) || 'unexpected')),
      dels: deleteResults.map((x) => x && (x.deleted ? 'ok' : blockedCode(x) || 'unexpected')) });

  const config = require('../server/config').config;
  const oldLimit = config.registrationLimit;
  const oldTrustProxy = config.trustProxy;
  const countBefore = Number(db.get('SELECT COUNT(*) AS n FROM accounts').n);
  config.registrationLimit = countBefore + 1;
  config.trustProxy = true;
  const capResults = await Promise.allSettled([
    call('POST', '/api/register', { name: '容量测试甲', password: 'pass-a1' }, null, { ...qaDevice('capacity-a'), 'x-forwarded-for': '192.0.2.1' }),
    call('POST', '/api/register', { name: '容量测试乙', password: 'pass-b1' }, null, { ...qaDevice('capacity-b'), 'x-forwarded-for': '192.0.2.2' }),
  ]);
  config.registrationLimit = oldLimit;
  config.trustProxy = oldTrustProxy;
  ok('注册容量阀门并发时只允许最后一个名额',
    capResults.filter(r => r.status === 'fulfilled').length === 1 &&
    capResults.filter(r => r.status === 'rejected' && r.reason.status === 503).length === 1 &&
    Number(db.get('SELECT COUNT(*) AS n FROM accounts').n) === countBefore + 1);
  const capWon = capResults.find(r => r.status === 'fulfilled');
  const capToken = capWon && capWon.value.token;
  const capAccountId = capWon && capWon.value.profile.account.accountId;

  const broadcast = require('../server/admin-broadcast').broadcast;
  const beforeGift = await call('GET', '/api/state', undefined, token);
  const gift = { id: 'test-gift-2026', text: '测试公告', gold: 17, cup: 4, props: { 23: 2, 36: 1 } };
  const sentGift = broadcast(gift), duplicateGift = broadcast(gift);
  let changedGiftRejected = false;
  try { broadcast({ ...gift, gold: 18 }); } catch (_) { changedGiftRejected = true; }
  const unclaimedGift = await call('GET', '/api/state', undefined, token);
  const giftInbox = await call('GET', '/api/messages', undefined, token);
  const giftMessage = giftInbox.messages.find(m => m.kind === 'announcement' && m.payload.broadcastId === gift.id);
  const claim = await call('POST', '/api/messages/claim', { id: giftMessage && giftMessage.id }, token);
  const claimAgain = await call('POST', '/api/messages/claim', { id: giftMessage && giftMessage.id }, token);
  const afterGift = await call('GET', '/api/state', undefined, token);
  const afterInbox = await call('GET', '/api/messages', undefined, token);
  const afterMessage = afterInbox.messages.find(m => m.id === (giftMessage && giftMessage.id));
  const beforeProps = beforeGift.save.props || {};
  ok('全服奖励邮件：先写待领邮件，点领取才入账；同一封只能领一次',
    !sentGift.duplicate && duplicateGift.duplicate && changedGiftRejected &&
    /* 广播本身不改存档 */
    unclaimedGift.save.goldPoint === beforeGift.save.goldPoint &&
    Number(unclaimedGift.save.goldCup || 0) === Number(beforeGift.save.goldCup || 0) &&
    Number(unclaimedGift.save.props[23] || 0) === Number(beforeProps[23] || 0) &&
    !!giftMessage && giftMessage.pinned === true && giftInbox.messages[0].id === giftMessage.id &&
    giftMessage.payload.claimable === true && !giftMessage.payload.claimedAt &&
    /可领取：/.test(giftMessage.text) && /挑战书 ×2/.test(giftMessage.text) && /金杯 4/.test(giftMessage.text) &&
    /* 领取才入账；重复领取不叠加 */
    claim.ok && claim.claimed === true && claim.already === false &&
    claim.rewards && claim.rewards.gold === 17 && claim.rewards.cup === 4 &&
    afterGift.save.goldPoint === beforeGift.save.goldPoint + 17 &&
    Number(afterGift.save.goldCup || 0) === Number(beforeGift.save.goldCup || 0) + 4 &&
    Number(afterGift.save.props[23] || 0) === Number(beforeProps[23] || 0) + 2 &&
    Number(afterGift.save.props[36] || 0) === Number(beforeProps[36] || 0) + 1 &&
    claimAgain.ok && claimAgain.already === true && claimAgain.claimed === true &&
    afterMessage && afterMessage.pinned === false && afterMessage.payload.claimedAt > 0,
    { sentGift, duplicateGift, changedGiftRejected, goldBefore: beforeGift.save.goldPoint, goldAfter: afterGift.save.goldPoint,
      cupBefore: beforeGift.save.goldCup, cupAfter: afterGift.save.goldCup,
      propsBefore: beforeProps, propsAfter: afterGift.save.props, claim, claimAgain, message: giftMessage });

  /* 开服奖励邮件（server/game/server-mail.js 的模板邮件）：**默认停用**（enabled:false）——
   * 等级到了也不投递；显式打开后才按等级自动投递，重复拉取不重复写，一封只能领一次。 */
  const serverMail = require('../server/game/server-mail');
  const mailTpl = serverMail.TEMPLATES[0];
  /* 同一 IP 的注册按小时限流 6 次，这里和上面的容量测试一样临时信任 X-Forwarded-For 换个 IP。 */
  const oldMailTrustProxy = config.trustProxy;
  config.trustProxy = true;
  const rookie = await call('POST', '/api/register', { name: '开服新号', password: 'pass-r1' }, null,
    { ...qaDevice('open-mail'), 'x-forwarded-for': '192.0.2.21' });
  config.trustProxy = oldMailTrustProxy;
  const rookieId = rookie.profile.account.accountId;
  const rookieBefore = await call('GET', '/api/state', undefined, rookie.token);
  const rookieLv1 = await call('GET', '/api/messages', undefined, rookie.token);
  db.tx(() => store.runOnSave(rookieId, ({ save }) => { save.level = mailTpl.minLevel; }, { snapshotSource: 'test-server-mail' }));
  const rookieDisabled = await call('GET', '/api/messages', undefined, rookie.token);
  /* 临时打开这个模板（模板是静态常量：改 enabled 后 reload 让缓存重读），断言完恢复原值。 */
  const mailWasEnabled = mailTpl.enabled;
  mailTpl.enabled = true;
  serverMail.reload();
  const rookieInbox = await call('GET', '/api/messages', undefined, rookie.token);
  const rookieMail = rookieInbox.messages.find(m => m.kind === mailTpl.kind);
  const rookieAgain = await call('GET', '/api/messages', undefined, rookie.token);
  const rookieClaim = await call('POST', '/api/messages/claim', { id: rookieMail && rookieMail.id }, rookie.token);
  const rookieClaimAgain = await call('POST', '/api/messages/claim', { id: rookieMail && rookieMail.id }, rookie.token);
  const rookieAfter = await call('GET', '/api/state', undefined, rookie.token);
  mailTpl.enabled = mailWasEnabled;
  serverMail.reload();
  const beforeMailProps = rookieBefore.save.props || {}, afterMailProps = rookieAfter.save.props || {};
  const wantMailProps = Object.entries(mailTpl.props || {}).map(([id, count]) => ({ id: Number(id), count }));
  ok('开服奖励邮件默认停用、打开后按等级投递：停用不发、2 级一封、重复拉取不重复、只能领一次',
    mailWasEnabled === false && rookieBefore.save.level === 1
    && !rookieLv1.messages.some(m => m.kind === mailTpl.kind)
    && !rookieDisabled.messages.some(m => m.kind === mailTpl.kind)
    && !!rookieMail && rookieMail.payload.claimable === true && rookieMail.payload.minLevel === mailTpl.minLevel
    && /可领取：/.test(rookieMail.text)
    && rookieAgain.messages.filter(m => m.id === rookieMail.id).length === 1
    && rookieClaim.ok && rookieClaim.claimed === true && rookieClaim.already === false
    && rookieClaim.rewards.gold === mailTpl.gold && same(rookieClaim.rewards.props, wantMailProps)
    && rookieAfter.save.goldPoint === rookieBefore.save.goldPoint + mailTpl.gold
    && wantMailProps.every(p => Number(afterMailProps[p.id] || 0) === Number(beforeMailProps[p.id] || 0) + p.count)
    && rookieClaimAgain.ok && rookieClaimAgain.already === true && rookieClaimAgain.claimed === true,
    { template: mailTpl, level1: rookieLv1.messages, disabled: rookieDisabled.messages, mail: rookieMail,
      claim: rookieClaim, again: rookieClaimAgain, propsBefore: beforeMailProps, propsAfter: afterMailProps });

  /* 2026-11-17 开服庆祝邮件：模板默认启用，2 级自动投递；奖励 500 金松果 + 10 种道具。 */
  const celebrationMail = rookieInbox.messages.find((m) => m.kind === 'opening_gift');
  const celebrationClaim = await call('POST', '/api/messages/claim', { id: celebrationMail && celebrationMail.id }, rookie.token);
  const celebrationAgain = await call('POST', '/api/messages/claim', { id: celebrationMail && celebrationMail.id }, rookie.token);
  const celebrationAfter = await call('GET', '/api/state', undefined, rookie.token);
  const wantCelebrationProps = Object.entries({
    2: 10, 23: 3, 36: 3, 39: 3, 41: 3, 42: 3, 43: 3, 44: 5, 82: 3, 87: 3,
  }).map(([id, count]) => ({ id: Number(id), count }));
  const celebrationBeforeProps = rookieAfter.save.props || {}, celebrationAfterProps = celebrationAfter.save.props || {};
  ok('开服庆祝邮件：2 级自动投递 500 金松果 + 10 种道具，只能领一次',
    !!celebrationMail && celebrationMail.payload.title === '庆祝联机版开服'
    && celebrationMail.payload.claimable === true
    && celebrationClaim.ok && celebrationClaim.claimed === true && celebrationClaim.already === false
    && celebrationClaim.rewards.gold === 500
    && same(celebrationClaim.rewards.props, wantCelebrationProps)
    && celebrationAfter.save.goldPoint === rookieAfter.save.goldPoint + 500
    && wantCelebrationProps.every(p => Number(celebrationAfterProps[p.id] || 0) === Number(celebrationBeforeProps[p.id] || 0) + p.count)
    && celebrationAgain.ok && celebrationAgain.already === true && celebrationAgain.claimed === true,
    { mail: celebrationMail, claim: celebrationClaim, again: celebrationAgain,
      propsBefore: celebrationBeforeProps, propsAfter: celebrationAfterProps });

  /* 每日任务：服务端题面 + 进度 + 领取一条龙。用容量测试留下的账号（A/B 已注销），
   * 把第一条的计数器直接置满，再走真实 claimQuest 动作，确认奖励落 patch 而不是只改客户端。 */
  await call('GET', '/api/state', undefined, capToken);
  const seeded = store.runOnSave(capAccountId, ({ save }) => {
    const q = save.quests && save.quests.list && save.quests.list[0];
    if (!q) return null;
    save.dailyCounters = save.dailyCounters || {};
    save.dailyCounters[q.key] = q.need;
    return { key: q.key, need: q.need };
  });
  const questState = await call('GET', '/api/state', undefined, capToken);
  const questClaim = await call('POST', '/api/action', { name: 'claimQuest', args: [0], rev: questState.rev }, capToken);
  const questAfter = await call('GET', '/api/state', undefined, capToken);
  const questAgain = await call('POST', '/api/action', { name: 'claimQuest', args: [0], rev: questAfter.rev }, capToken);
  ok('每日任务服务端可领取并入 patch',
    !!seeded.value && questClaim.ok && questClaim.result && questClaim.result.ok === true &&
    /领取成功/.test(String(questClaim.result.msg || '')) &&
    questClaim.patch && questClaim.patch.set && questClaim.patch.set.quests &&
    questClaim.patch.set.quests.list[0].claimed === true &&
    questAfter.save.quests.list[0].claimed === true && questAgain.result.ok === false &&
    !!(questClaim.patch && questClaim.patch.set &&
      (questClaim.patch.set.props || questClaim.patch.set.goldPoint || questClaim.patch.set.exp)),
    { seeded: seeded.value, claim: questClaim, quests: questState.save && questState.save.quests,
      counters: questState.save && questState.save.dailyCounters });

  /* 30 级支持作者提示：取提示权必须是 sync 动作，否则联机版 save() 空操作，
   * 服务端永远看不到 supportPromptShown，每次同步/开背包都会重弹。 */
  db.tx(() => store.runOnSave(A.profile.account.accountId, ({ save }) => {
    save.supportPrompt = true;
    save.supportPromptShown = false;
  }, { snapshotSource: 'support-prompt-test' }));
  const promptState = await call('GET', '/api/state', undefined, token);
  const promptTake = await call('POST', '/api/action', { name: 'supportPromptTake', args: [], rev: promptState.rev }, token);
  const promptAfter = await call('GET', '/api/state', undefined, token);
  const promptAgain = await call('POST', '/api/action', { name: 'supportPromptTake', args: [], rev: promptAfter.rev }, token);
  ok('支持作者提示的“已提示”落服务端，重复取提示权不再变更',
    promptTake.ok && promptTake.result === true &&
    !!(promptTake.patch && promptTake.patch.set && promptTake.patch.set.supportPromptShown === true) &&
    promptAfter.save.supportPromptShown === true &&
    promptAgain.ok && promptAgain.result === false && !promptAgain.patch,
    { take: promptTake, again: promptAgain, saved: promptAfter.save.supportPromptShown });

  /* 无尽塔周奖励：服务端发奖、周限 10 张、同一 runId 幂等、跨周重置。
   * 层数 / 铸币由本机对局在结算时提交；服务端不校验塔内过程，只守周上限。 */
  const tw0 = await call('GET', '/api/state', undefined, token);
  const twBase = Number((tw0.save.props || {})[50] || 0);
  let twBad = 0;
  try { await call('POST', '/api/action', { name: 'claimEndlessTower', args: [0, 11, 'qa-tower-bad'], rev: tw0.rev }, token); }
  catch (e) { twBad = e.status; }
  const tw1 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [76, 11, 'qa-tower-1', false], rev: tw0.rev }, token);
  const tw2 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [76, 11, 'qa-tower-1', false], rev: tw1.rev }, token);
  const tw3 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [95, 0, 'qa-tower-2', false], rev: tw2.rev }, token);
  const tw4 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [95, 0, 'qa-tower-3', false], rev: tw3.rev }, token);
  // 第 101 层：周限已满，百层奖励仍应发；第 4 个参数模拟旧客户端的 false。
  const tw5 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [101, 0, 'qa-tower-4', false], rev: tw4.rev }, token);
  db.tx(() => store.runOnSave(A.profile.account.accountId, ({ save }) => {
    save.towerWeek = { week: '2000-01-01', tickets: 10, runs: [] };
  }));
  const tw6State = await call('GET', '/api/state', undefined, token);
  const tw6 = await call('POST', '/api/action', { name: 'claimEndlessTower', args: [75, 0, 'qa-tower-5'], rev: tw6State.rev }, token);
  ok('无尽塔周奖励：服务端发奖、周限 10 张、同一局幂等、百层奖励、跨周重置、明显不合理结算被拒',
    twBad === 400 &&
    tw1.result.granted === 8 && tw1.result.raw === 8 && tw1.result.weekCap === 10 &&
    !!(tw1.patch && tw1.patch.set && tw1.patch.set.towerWeek) &&
    tw1.patch.set.towerWeek.tickets === 8 &&
    Number((tw1.patch.set.props || {})[50]) === twBase + 8 &&
    tw2.result.duplicate === true && tw2.result.granted === 8 &&
    tw3.result.granted === 2 && tw3.result.capped === true &&
    tw4.result.granted === 0 && tw4.result.capped === true &&
    tw5.result.granted === 2 && tw5.result.victoryBonus === 2 && tw5.result.trueEnd === true &&
    tw5.result.weekUsed === 10 && tw5.result.weekLeft === 0 && tw5.result.capped === true &&
    Number((tw5.patch.set.props || {})[50]) === twBase + 12 &&
    tw6.result.granted === 7 && !!(tw6.patch && tw6.patch.set && tw6.patch.set.towerWeek) &&
    tw6.patch.set.towerWeek.week !== '2000-01-01' && tw6.patch.set.towerWeek.tickets === 7,
    { first: tw1.result, duplicate: tw2.result, capped: tw3.result, full: tw4.result,
      at101: tw5.result, reset: tw6.result });

  /* 修改密码：当前密码校验 + 旧口令失效 + 新口令可登录（设置页「联机账号」入口）。 */
  const wrongChange = await statusOf('POST', '/api/account/password', { password: 'nope', newPassword: 'pass-new-a1' }, token);
  const changed = await call('POST', '/api/account/password', { password: 'pass-a1', newPassword: 'pass-new-a1' }, token);
  let oldLogin = 0;
  try { await call('POST', '/api/login', { name: '甲鼠', password: 'pass-a1' }); }
  catch (e) { oldLogin = e.status; }
  const newLogin = await call('POST', '/api/login', { name: '甲鼠', password: 'pass-new-a1' });
  ok('修改密码：当前密码校验、旧口令失效、新口令可登录',
    wrongChange === 403 && changed.ok && changed.changed === true && oldLogin === 401 && newLogin.ok,
    { wrongChange, changed, oldLogin, newLogin: !!newLogin.ok });

  /* 修改昵称：全服唯一 + 存档/防守快照同步 + 旧昵称不能再登录（设置页「联机账号」入口）。
   * 注册限流按 IP 算：给这个测试号一个独立 XFF，避免撞上前面用掉的 6 次/小时。 */
  const oldRenameTrust = cfg.trustProxy;
  cfg.trustProxy = true;
  const renameHeaders = { ...qaDevice('qa-rename'), 'x-forwarded-for': '203.0.113.77' };
  const R = await call('POST', '/api/register', { name: '改名测试甲', password: 'pass-rn1' }, undefined, renameHeaders);
  const renameSame = await statusOf('POST', '/api/account/name', { name: '改名测试甲' }, R.token);
  const renameTaken = await statusOf('POST', '/api/account/name', { name: '甲鼠' }, R.token);
  const renameTooLong = await statusOf('POST', '/api/account/name', { name: '八个汉字测试名字' }, R.token);
  const renamed = await call('POST', '/api/account/name', { name: '改名之后' }, R.token);
  const renamedState = await call('GET', '/api/state', undefined, R.token);
  let oldNameLogin = 0;
  try { await call('POST', '/api/login', { name: '改名测试甲', password: 'pass-rn1' }, undefined, renameHeaders); }
  catch (e) { oldNameLogin = e.status; }
  const newNameLogin = await call('POST', '/api/login', { name: '改名之后', password: 'pass-rn1' }, undefined, renameHeaders);
  cfg.trustProxy = oldRenameTrust;
  ok('修改昵称：全服唯一、存档/快照同步、旧昵称不能登录、新昵称可登录',
    renameSame === 400 && renameTaken === 409 && renameTooLong === 400
    && renamed.ok && renamed.name === '改名之后'
    && renamed.account && renamed.account.name === '改名之后'
    && renamed.patch && renamed.patch.set && renamed.patch.set.name === '改名之后'
    && renamedState.save.name === '改名之后'
    && renamedState.snapshot && renamedState.snapshot.fighter.name === '改名之后'
    && oldNameLogin === 401 && newNameLogin.ok && newNameLogin.profile.account.name === '改名之后',
    { renameSame, renameTaken, renameTooLong, renamed, save: renamedState.save && renamedState.save.name, oldNameLogin });

  /* 随机挑战「查看」保存原始快照号（snapshotRef）：内存 offer 过期 / 服务重启后，
   * 仍能用同一颗快照继续开打（旧行为只能靠 10 分钟的 o_… offer）。 */
  {
    // 改密码用例已经用新口令登录过一次，旧 token 会被踢；这里用最后一次登录的 token。
    const refToken = newLogin.token || token;
    let late = null;
    for (let i = 0; i < 60 && !late; i++) {
      const data = await call('GET', '/api/opponents?kind=random', undefined, refToken);
      late = data.opponents.find((x) => x.player && x.snapshotRef) || null;
    }
    const stLate = await call('GET', '/api/state', undefined, refToken);
    const refFight = late ? await call('POST', '/api/battle', {
      kind: 'random', snapshotId: late.snapshotRef, rev: stLate.rev, idemKey: 'raw-snapshot-ref',
    }, refToken) : { ok: false, error: '没有真人候选' };
    ok('随机挑战可用原始快照号（snapshotRef）继续战斗：重启 / offer 过期后同一颗快照仍能打',
      !!late && refFight.ok && refFight.opponent
      && refFight.opponent.snapshotId === late.snapshotRef
      && refFight.opponent.accountId === late.accountId,
      { ref: late && late.snapshotRef, offer: late && late.snapshotId, err: refFight.error });
  }

  /* 汇总 */
  const failed = results.filter((r) => !r.pass).map((r) => r.name);
  if (failed.length) console.log('FAILED: ' + failed.join(' | '));
  const pass = results.filter((r) => r.pass).length;
  console.log('\n' + pass + '/' + results.length + ' passed');
  cleanup();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE FAILED', e); try { cleanup(); } catch (cleanupError) { console.error(cleanupError); } process.exit(1); });
