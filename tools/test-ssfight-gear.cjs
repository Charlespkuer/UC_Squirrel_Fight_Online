#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const json = f => JSON.parse(read('images/ssfight/ui/' + f));
const gear = json('tags-gear.json');
const env = { window: {}, console };
vm.createContext(env);
vm.runInContext(read('js/ssfight/render.js'), env);
const frames = id => env.window.SfRender.buildFrames(gear.find(t => String(t.id) === String(id)).Sf);

test('狂战各品质使用完整 B 装备容器，护肩随对应衣服帧穿戴', () => {
  const slots = json('gear-slots.json');
  const ids = slots.container.flatMap(c => c.ids.map(String));
  assert.deepEqual(ids, ['1918', '1914', '2013', '1908', '2007', '1910']);
  const manifest = json('manifest.json');
  assert.deepEqual(Object.entries(manifest.pageRootIds).filter(([name]) => name.startsWith('gear')).map(([, id]) => id), ids,
    '导出清单的容器来源必须与实际挂载表一致');
  for (const id of ids) assert.equal(frames(id).length, 187, id + ' 必须是完整换装容器');
  const arm = frames(2007);
  for (const [frame, shoulder] of [[71, '1968'], [113, '1979'], [119, '1964']]) {
    assert.equal(arm[frame - 1].get(1).id, shoulder, '紫/橙/黑狂战必须各取自己的护肩画稿');
  }
  assert.ok(slots.slots.filter(s => s.type === 2 && s.which === 1).every(s => s.containerId === '2007'));
  const portraitIds = slots.portraitContainer.flatMap(c => c.ids.map(String));
  assert.deepEqual(portraitIds, ['1919', '1915', '2014', '1909', '2010', '1912'],
    '状态立绘使用 showFace 的无 B 容器，不能复用位图化容器的局部原点');
  for (const id of portraitIds) assert.equal(frames(id).length, 187, id + ' 必须是完整立绘换装容器');
  assert.ok(!/gearSlotTail|ARM_GEAR_BBOX/.test(read('js/ssfight/ui-main.js')),
    '原版护肩挂点不能补成普通袖口的落点');
});

test('经典装备矢量图标带 SVG 命名空间（缺 xmlns 时 <img> 整张不渲染）', () => {
  const dir = path.join(ROOT, 'images/ui/icons/gear');
  const files = fs.readdirSync(dir).filter((name) => /-classic\.svg$/.test(name));
  assert.ok(files.length >= 8, '经典装备矢量图必须存在');
  for (const name of files) {
    const head = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 300);
    assert.match(head, /<svg[^>]*\sxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/, name + ' 缺少 xmlns');
  }
});

test('橙色狂战头盔/短靴与紫狂战取景框一致', () => {
  const dir = path.join(ROOT, 'images/ui/icons/gear');
  const vb = (name) => {
    const head = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 300);
    return (/\bviewBox="([^"]+)"/.exec(head) || [])[1];
  };
  assert.equal(vb('gear-205-classic.svg'), vb('gear-201-classic.svg'), '橙盔取景框应与紫盔一致');
  assert.equal(vb('gear-208-classic.svg'), vb('gear-204-classic.svg'), '橙靴取景框应与紫靴一致');
});

test('无尽塔经典预告的 7232 挂点使用 showFace 的非 B 容器', () => {
  const src = read('js/tower-ui.js');
  const start = src.indexOf('async function loadClassicGear');
  const end = src.indexOf('function classicGearType', start);
  assert.ok(start > 0 && end > start, 'tower-ui 的经典装备表入口应存在');
  const body = src.slice(start, end);
  assert.match(body, /for \(const c of slots\.portraitContainer \|\| \[\]\)/,
    '无尽塔预告与随机挑战 showFace 共用非 B 立绘容器，B 容器原点不同会推偏整套装备');
  assert.doesNotMatch(body, /slots\.container/);
});

test('更换装备的怒战头盔逐强化档取原版卡片，并保留卡片父层与角的矩阵精度', () => {
  const table = json('gear-colors.json').byGear;
  assert.deepEqual(table['177']['4'], { 0: 1419, 1: 1419, 2: 1417, 3: 1413 },
    '原版橙1导出名末尾的空格不能使未强化头盔误取橙2画稿');
  const colored = new Map(json('tags-gear-color.json').map(t => [String(t.id), t]));
  const cardFrame = id => env.window.SfRender.buildFrames(colored.get(String(id)).Sf)[0];
  assert.equal(cardFrame(1419).get(16).id, '1418', '基础画稿应保留完整原稿');
  const blackCard = cardFrame(table['185']['5']['0']).get(16);
  assert.equal(blackCard.id, '1410');
  assert.equal(Number(blackCard.ma.split(',')[0]), 14710 / 65536, '卡片自有父层同样保留原精度');
  const blackArt = cardFrame(blackCard.id);
  for (const id of ['1406', '1409']) {
    const part = [...blackArt.values()].find(p => p.id === id);
    assert.equal(Number(part.ma.split(',')[0]), 35061 / 65536);
    assert.equal(Number(part.ma.split(',')[3]), 35065 / 65536);
  }
});

test('黑怒战角填充与描线保留 SWF 矩阵精度，切页顺序不换回舍入稿', async () => {
  const head = frames(1918)[121];
  const fill = [...head.values()].find(p => p.id === '1406');
  const outline = [...head.values()].find(p => p.id === '1409');
  for (const part of [fill, outline]) {
    const m = part.ma.split(',').map(Number);
    assert.equal(m[0], 35061 / 65536);
    assert.equal(m[3], 35065 / 65536);
  }
  assert.equal(outline.ma.split(',')[4] - fill.ma.split(',')[4], 534.25,
    '填充与描线沿用原稿的平移关系');
  assert.equal(frames(1918)[115].get(1).id, '1418', '橙怒战基础帧仍按原版 116 取稿');
  assert.ok(!/GEAR_FRAME_FIX|gearFrameFix/.test(read('js/ssfight/render.js')),
    '不能把基础配色强行拨到强化帧 117');
  const sandbox = {
    window: {}, console,
    fetch: async url => ({ ok: true, json: async () => json(String(url).split('/').pop()) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/ssfight/render.js'), sandbox);
  const render = sandbox.window.SfRender;
  await render.loadExtra('tags-gear-color.json');
  const loaded = await render.loadExtra('tags-gear.json');
  await render.loadExtra('tags-fight.json');
  const selected = loaded.hash.get('1918');
  const current = render.buildFrames(selected.Sf)[121];
  assert.equal([...current.values()].find(p => p.id === '1406').ma, fill.ma);
});

test('全部 288 件装备都有矢量图标文件（装备显示不再回退 PNG）', () => {
  const dir = path.join(ROOT, 'images/ui/icons/gear');
  const rows = json('gear-frames.json').gear;
  const files = new Set(fs.readdirSync(dir).filter((name) => /^gear-\d+-classic\.svg$/.test(name)));
  const missing = rows.filter((row) => !files.has('gear-' + row.id + '-classic.svg')).map((row) => row.id);
  assert.deepEqual(missing, [], '这些装备没有矢量图标：' + missing.join(','));
  /* 装备路径只允许 SVG；PNG 兜底会让新装备回到 404。 */
  for (const file of ['js/classic-ui.js', 'js/classic-fusion.js', 'js/online-campaign.js',
    'js/ssfight/ui-status.js', 'js/ssfight/ui-challenge.js', 'js/ssfight/ui-compose.js',
    'js/ui-base.js', 'js/classic-extras.js']) {
    assert.doesNotMatch(read(file), /images\/ui\/icons\/gear\/[^\n]{0,90}\.png/,
      file + ' 还留着装备 PNG 兜底');
  }
  const props = read('js/classic-ui.js').match(/const PROP_SVG_IDS = new Set\(\[([\s\S]*?)\]\)/);
  const propIds = props ? props[1].split(',').map((s) => Number(s.trim())).filter(Boolean) : [];
  const propFiles = new Set(fs.readdirSync(path.join(ROOT, 'images/ui/icons/prop'))
    .filter((name) => /^prop-\d+\.svg$/.test(name)).map((name) => Number(name.match(/prop-(\d+)\.svg/)[1])));
  const propMissing = propIds.filter((id) => !propFiles.has(id));
  assert.deepEqual(propMissing, [], '这些道具没有矢量图标：' + propMissing.join(','));
});

test('gamedata 补登记的道具都有矢量图标，且进了 PROP_SVG_IDS（漏一个就显示透明占位）', () => {
  const gamedata = read('js/gamedata.js');
  const start = gamedata.indexOf('const EXTRA_PROPS');
  const block = gamedata.slice(start, gamedata.indexOf('];', start));
  const ids = [...block.matchAll(/\['(\d+)',/g)].map((m) => Number(m[1]));
  assert.ok(ids.includes(80) && ids.includes(89), 'EXTRA_PROPS 解析异常（应当包含黑色卡片 / 黑装自选箱）');
  const props = read('js/classic-ui.js').match(/const PROP_SVG_IDS = new Set\(\[([\s\S]*?)\]\)/);
  const listed = new Set(props[1].split(',').map((s) => Number(s.trim())).filter(Boolean));
  const missing = ids.filter((id) => !listed.has(id) || !fs.existsSync(path.join(ROOT, 'images/ui/icons/prop/prop-' + id + '.svg')));
  assert.deepEqual(missing, [], '这些道具缺矢量图或没登记进 PROP_SVG_IDS：' + missing.join(','));
});
