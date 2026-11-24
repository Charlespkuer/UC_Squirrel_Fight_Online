/* ============================================================
 * tools/check-asset-paths.cjs —— 跨平台发布体检（Windows / macOS / Linux）
 *
 *   node tools/check-asset-paths.cjs
 *
 * 三项检查：
 *   1. 代码里写死的资源引用（`images/...` 这类，含目录前缀）逐段核对**真实大小写**。
 *      Windows 与 macOS 的文件系统默认不区分大小写，写错也能跑；发布到
 *      GitHub Pages / 任何 Linux 主机就会 404。
 *   2. 仓库里是否存在「只差大小写」的重复路径：这种文件在 Windows/macOS 上
 *      会互相覆盖，在 Linux 上又是两个文件，checkout 出来两边不一致。
 *   3. 断链：引用了但文件真的不存在。
 * ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
/** 项目根：从脚本所在目录往上找含 index.html 的那一层（tools/ 放哪都能用）。 */
function findRoot(start) {
  const fsx = require('node:fs'), px = require('node:path');
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fsx.existsSync(px.join(d, 'index.html'))) return d;
    const up = px.dirname(d);
    if (up === d) break;
    d = up;
  }
  return px.resolve(start, '..');
}


const ROOT = findRoot(__dirname);
const SCAN_EXT = ['.html', '.css', '.js', '.json'];
/* 跳过不参与发布的目录：
 *   · reference/ 与 references/ —— 只作参考的素材（原版归档源码、截图、原 APK、取证报告）。
 *     2026-10 起本机归档目录叫 `reference/`（单数），历史上文档与 .gitignore 写的是
 *     `references/`（复数）；**两种都跳过**，否则一份 214 MB 的归档会被当成发布内容扫描，
 *     整个体检白跑 3 秒多。
 *   · src-tauri / apk-audit / research/original / out —— 构建产物与本地取证/超分产物。
 * 这些目录都不进仓库或不属于发布内容，扫描它们只会产生假警报。
 * ⚠ `js/orig`（本机另存的原版 H5 源码副本）**2026-10 第一百零一批已整目录删除** ——
 *   原版源码只留 `reference/ssfight` 一份，所以这里不再为它保留死配置。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'references', 'reference', 'src-tauri', 'apk-audit', 'research/original', 'out']);
/* 跳过**个别文件**的名单：
 *   · `server/web-manifest.json` 是 `tools/build-online-app.cjs` 生成的**发布清单**
 *     （每个随包文件的 path/size/sha256）。它当然会把 `images/...` 全列一遍，但那不是
 *     「代码引用图片」而是「清单记录随包内容」—— 拿它当引用源，只要素材整理过一次
 *     就会报出几百条「引用了但文件不存在」的假断链。
 *   · 历史上还有两份 `images/classic` 下的 manifest.json（原版 APK 出处记录）；
 *     那份归档 2026-11 已移到 `reference/`（整目录跳过），不再需要逐文件例外。 */
const SKIP_FILES = new Set(['server/web-manifest.json']);
/* 联机版已退役的现代素材（2026-11-10 移到 `reference/retired/2026-11-10-online-b0/`）：
 *   · `images/ui/screens/` —— 现代首页 / 加载 / 战果整屏图；
 *   · `images/battle/bg/` —— 现代 canvas 战斗的场地背景。
 * `js/gamedict.js` 仍保留这些 sheet id（单机版与历史安装包要用），所以静态引用还在；
 * 运行时联机版不加载它们。这里放行断链检查，避免每次体检报 30 条假错。
 * ⚠ 只对**这两棵已退役目录**放行；别把其它 `images/` 路径加进来。 */
const RETIRED_PREFIXES = ['images/ui/screens/', 'images/battle/bg/'];
/* 2026-11-11 起联机版不再加载的 atlas 单图（gamedict 仍保留原始素材目录条目，
 * 但 Engine 的联机调用方只用到 tl/xh/xm/woodman/SQ/resource_1/resource_10）。
 * 按**完整路径**放行，避免把整个 images/atlas/ 误设成退役目录。 */
const RETIRED_FILES = new Set([
  'images/atlas/daoju.png', 'images/atlas/jinbeidaoju.png', 'images/atlas/jineng.png',
  'images/atlas/resource_2.png', 'images/atlas/resource_3.png', 'images/atlas/resource_4.png',
  'images/atlas/resource_5.png', 'images/atlas/resource_6.png', 'images/atlas/resource_7.png',
  'images/atlas/resource_9.png', 'images/atlas/resource_11.png', 'images/atlas/resource_12.png',
  'images/atlas/resource_13.png', 'images/atlas/resource_14.png', 'images/atlas/resource_15.png',
  'images/atlas/resource_16.png', 'images/atlas/resource8.png', 'images/atlas/wuqi.png',
  'images/atlas/wuqi2.png', 'images/atlas/resource_1.png', 'images/atlas/resource_10.png',
  /* 2026-11-23 退役的现代 canvas 战斗特效：联机经典入口只用 main_e1 与
   * tl/xh/xm/woodman 五张三侠特效，其余 gamedict 条目不再随包。 */
  'images/battle/fx/beatBack.png', 'images/battle/fx/die.png',
  'images/battle/fx/effectCommonAttack.png', 'images/battle/fx/GM_01.png', 'images/battle/fx/GM_02.png',
  'images/battle/fx/hurtRunBack.png',
  'images/battle/fx/lightning1.png', 'images/battle/fx/lightning2.png', 'images/battle/fx/lightning3.png',
  'images/battle/fx/lightning4.png', 'images/battle/fx/lightning5.png',
  'images/battle/fx/main_e2.png', 'images/battle/fx/main_e3.png', 'images/battle/fx/runAround.png',
  'images/battle/fx/skill_13.png', 'images/battle/fx/skill_14.png', 'images/battle/fx/skill_15.png',
  'images/battle/fx/skill_15_d.png', 'images/battle/fx/skill_16_1.png', 'images/battle/fx/skill_16_2.png',
  'images/battle/fx/skill_17.png', 'images/battle/fx/skill_18.png', 'images/battle/fx/skill_18_d_1.png',
  'images/battle/fx/skill_18_d_2.png', 'images/battle/fx/skill_23.png', 'images/battle/fx/skill_6.png',
  'images/battle/fx/skill_7.png', 'images/battle/fx/skill_8.png', 'images/battle/fx/skill_8_d.png',
  'images/battle/fx/skill_9.png', 'images/battle/fx/skill_9_d.png', 'images/battle/fx/starter_effect.png',
  'images/battle/fx/think.png', 'images/battle/fx/throwEffect.png', 'images/battle/fx/throwweaponAttack.png',
  'images/battle/fx/weaponAttack.png', 'images/battle/fx/weaponEffect.png', 'images/battle/fx/win_effect.png',
  'images/battle/fx/main_e1.png',
  /* 2026-11-23 退役的位图数字条：联机经典入口只用 tanchutiao 进度条，数字改 CSS 文本。 */
  'images/ui/numbers/energyNum.png', 'images/ui/numbers/expNum.png', 'images/ui/numbers/fightNum_g.png',
  'images/ui/numbers/fightNum_r.png', 'images/ui/numbers/fightNum_y.png', 'images/ui/numbers/jingyanshuzi.png',
  'images/ui/numbers/num_28.png', 'images/ui/numbers/num_36.png', 'images/ui/numbers/shade.png',
  'images/ui/numbers/substarate0.png', 'images/ui/numbers/tilishuzi.png',
  // 2026-11-24 进度条改矢量：gamedict 里那条 PNG 已退役，main.js 按 URL 加载 tanchutiao.svg。
  'images/ui/numbers/tanchutiao.png',
]);
let retiredRefs = 0;
const ROOTS = 'images|css|js|audio|music|fonts|assets';
// 引号/括号里的资源路径：以四个已知资源目录开头，允许中文与常见符号
const REF_RE = new RegExp('["\'(`]((?:' + ROOTS + ')/[A-Za-z0-9_@%\\-./\\u4e00-\\u9fa5]*)', 'g');

const cache = new Map();
function listing(dir) {
  if (!cache.has(dir)) cache.set(dir, fs.existsSync(dir) ? fs.readdirSync(dir) : null);
  return cache.get(dir);
}
/** 逐段核对大小写；返回 null 表示存在，否则返回问题描述。 */
function resolveExact(rel, wantDir) {
  const parts = rel.split('/').filter(Boolean);
  let dir = ROOT;
  for (let i = 0; i < parts.length; i++) {
    const entries = listing(dir);
    if (!entries) return '父目录不存在：' + (path.relative(ROOT, dir).replace(/\\/g, '/') || '.');
    const hit = entries.find((name) => name === parts[i]);
    if (!hit) {
      const ci = entries.find((name) => name.toLowerCase() === parts[i].toLowerCase());
      return ci ? '大小写不一致 → 应为 ' + parts.slice(0, i).concat(ci).join('/') : '不存在';
    }
    dir = path.join(dir, hit);
  }
  const isDir = fs.statSync(dir).isDirectory();
  if (wantDir && !isDir) return '期望是目录，实际是文件';
  if (!wantDir && isDir) return '期望是文件，实际是目录';
  return null;
}
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || Array.from(SKIP_DIRS).some((s) => rel === s || rel.endsWith('/' + s))) continue;
      walk(full, out);
    } else if (SCAN_EXT.includes(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(rel)) out.push(rel);
  }
  return out;
}

/* ---------- 1 + 3：静态引用的路径与大小写 ---------- */
const files = walk(ROOT, []);
const problems = [];
let checked = 0;
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const seen = new Set();
  for (const match of text.matchAll(REF_RE)) {
    let ref = match[1];
    if (ref.includes('${')) ref = ref.slice(0, ref.indexOf('${'));   // 模板拼接只查前缀
    const isDir = ref.endsWith('/');
    const base = ref.replace(/\/+$/, '');
    if (!base || seen.has(base)) continue;
    seen.add(base);
    // 没有扩展名又不是目录结尾的（例如 'images/ui/icons/' + kind + '.png' 被切成 images/ui/icons）
    const looksFile = /\.[a-z0-9]{2,5}$/i.test(base);
    if (!isDir && !looksFile) continue;                              // 交给目录前缀那条规则
    if (RETIRED_FILES.has(base) || RETIRED_PREFIXES.some((prefix) => (base + '/').startsWith(prefix))) { retiredRefs++; continue; }
    checked++;
    const issue = resolveExact(base, isDir || !looksFile);
    if (issue) problems.push(rel + '  →  ' + ref + '   [' + issue + ']');
  }
}

/* ---------- 2：只差大小写的重复路径 ---------- */
/* 只比**会发布的内容**：以前这里只跳过 `.git` / `node_modules`，于是每跑一次都要
 * 把 `src-tauri/target`（十几万个 Rust 产物）、`reference/`（两万份归档）、
 * `out/` 一起枚举一遍 —— 2026-11 实测 15.7 万个文件、3.7 秒，而且这些目录本来就
 * 不在发布包里，报出来也没人修。现在与上面共用 SKIP_DIRS。 */
const all = [];
(function walkAll(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || Array.from(SKIP_DIRS).some((s) => rel === s || rel.endsWith('/' + s))) continue;
      walkAll(full);
    } else all.push(rel);
  }
})(ROOT);
const byLower = new Map();
for (const rel of all) {
  const key = rel.toLowerCase();
  if (!byLower.has(key)) byLower.set(key, []);
  byLower.get(key).push(rel);
}
const collisions = [...byLower.values()].filter((group) => group.length > 1);

console.log('扫描 ' + files.length + ' 个源文件、' + all.length + ' 个仓库文件，核对 ' + checked + ' 条静态资源引用' +
  (retiredRefs ? '（另有 ' + retiredRefs + ' 条已退役现代素材引用跳过）' : ''));
if (!problems.length) console.log('✓ 引用路径与大小写全部命中');
else {
  console.log('✗ 发现 ' + problems.length + ' 条引用问题：');
  for (const p of problems) console.log('  ' + p);
}
if (!collisions.length) console.log('✓ 没有只差大小写的重复路径（Windows/macOS/Linux checkout 一致）');
else {
  console.log('✗ 发现 ' + collisions.length + ' 组只差大小写的路径：');
  for (const group of collisions) console.log('  ' + group.join('  ==  '));
}
process.exitCode = problems.length || collisions.length ? 1 : 0;
