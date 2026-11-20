# tools/ 目录规范（给 AI Agent）

> 这个目录只放**会被反复用到**的开发工具。
> 历史上这里堆过 125 个一次性探针 / 审计 / 截图脚本，2026-10 被用户整批删掉过一次
> （远端提交「精简 tools/ + 第十八/十九批功能与文档」）。**不要重演。**

## 硬性规则

1. **只做重要且必要的测试。** 改完先跑**已有**套件（`test-*.cjs` /
   `check-asset-paths.cjs`），不要为一次性验证新建 `test-xxx.cjs`，也不要顺手往现有测试里
   多塞几条"顺带断言"。
2. **一次性脚本不许留在 tools/。** 临时的探测 / 测量 / 对比脚本写到 `out/`（已 gitignore），
   用完即删（`out/` 的保留清单与清理步骤见 `out/AGENT.md`）。只有「会长期反复使用」的才配留在本目录。
   **跑图 / 截图产物同理**：渲染图、对比图、审计截图一律写 `out/`（例：战斗回归的渲染图落
   `out/battle-check/`）。2026-10 曾从 `tools/verification/`（118 张）与 `tools/research/`
   （32 张）清掉 60 MB 这类本地产物 —— 不要往 `tools/` 里再堆 PNG。
3. **不新增 HTML 探针页**（`*-probe.html` / `*-check.html`）。需要交互式验证时先问用户。
4. **一个改动最多加一条用例。** 优先放进主题相符**且体积小**的套件。**严禁**往
   `test-fixes-round.cjs` 这类 600 KB+ 的历史文件里追加，也不要为了"顺手"多断言几条。
   新建测试文件时目标 < 300 行。
5. **一条 `test('中文描述', ...)` 对应一条可感知的规则。** 禁止为凑覆盖率写
   "把 40 个字段全断言一遍"式的用例；概率类断言必须用 `randomGame()` 之类的真随机，
   或显式固定随机流，两者在注释里写清楚。
6. **测试只依赖仓库里的东西。** 游戏数据从 `js/gamedict.js` 读（和 `scripts/index-online.html` 同一个数据源），
   **不要再去读 `references/`**：那只是本机参考资料、不进仓库，CI 检出后根本没有。
   CI（`.github/workflows/ci.yml`）会枚举 `tools/test-*.cjs` 全跑一遍，所以本地跑通不等于
   提交后跑通 —— 新增/改名套件不用改 workflow，但也别让套件依赖本机文件。
7. **读源码做文本断言时先把 CRLF 归一成 LF。** 抠函数体 / 数出现次数 / 「切行 + `/^...$/`」
   这类断言一律走 `readFileSync(...).replace(/\r\n/g, '\n')`（`test-fixes-round.cjs` 里的
   `readSrc()` 就是干这个的）。Git for Windows 默认 `core.autocrlf=true`，Windows 检出会把
   LF 变成 CRLF，行尾多出来的 `\r` 会让锚定正则全部打空 —— 这是「本机绿、Windows 红」的经典
   原因（2026-10 `需求71` 就这么挂过一次）。另外清临时目录的 `fs.rmSync` 记得带
   `maxRetries`：Windows 上刚退出的子进程可能还占着文件。
8. **同一次构建里，同一份内容只算一次哈希、只验一次。** 构建脚本里重复的“保险”验证不算稳健，
   只是白烧 CPU / I/O：
   - `build-online-app.cjs` 的 `fingerprint()` 已经逐文件读过 buffer，`web-manifest.json` 直接
     复用这份 `size + sha256`，**不要**再去遍历暂存目录重读一遍（96 MB）；
   - 构建成功后**不要**再 spawn `--check` / `--web --check`：同一份源码再读一遍、再算一遍指纹，
     属于重复验证。`--check` 只保留给「单独检查已有快照」的手动/CI 场景，一次即可；
   - `.so` 的 ELF / ABI / 16 KiB 对齐只在**最终 APK** 上验一次；不要先验裸 `.so`、再验包里
     的同一份；
   - 签名（`apksigner verify`）、`aapt2 badging`、`zipalign -c` 各保留一次；只有检查**不同事实**
     的才允许并存（例：zipalign 查 ZIP、ELF 检查查 LOAD 段 —— 它们不重复）。
   - 判据：删掉的是「验证同一事实的第二次调用」，不是发布前唯一的那道门禁。
   - 反例（2026-11 已删）：`build-apk.ps1` 编译后 + 发布前各跑一次 `--web --check`；`tauri.yml`
     里 `--web` 后面紧跟 `--web --check`；`build-online-apk.cjs` 先 `check-android-package --library`
     再对最终 APK 跑一次。
   - **当前分工（2026-11-10 核对，别再叠）**：`build-online-app.cjs` 的 `fingerprint()` 只读一遍
     源码、只算一遍 `size + sha256`；`--web` 用它写 `web-stamp.json` + `web-manifest.json`；
     `--check` 只重算一次聚合指纹，不重读暂存目录。`build-online-apk.cjs` 开头 `--web` 一次，
     之后 `apksigner verify`（签名）、`zipalign -c`（ZIP 对齐）、`check-android-package`
     （ELF ABI + LOAD 对齐）、`aapt2 badging`（清单身份/版本/权限）各一次。
     `check-asset-paths` 与 `check-encodings` 虽然都遍历仓库，但一个查引用、一个查编码，
     属于不同事实，允许并存；不要为了“少读一遍”把两种断言硬塞进一个脚本。

## 新增脚本的门槛（三条都满足才留下）

- 会被反复调用（构建 / 回归 / 发布），而不是只服务某一次改动；
- 无第三方依赖（Node 内置模块优先，与现有 `test-*.cjs` 一致）；
- `node tools/xxx.cjs` 不带参数就能跑，且有合理默认。

## 现有工具的分类（留档，别随意增删）

经典界面定位：`node tools/ssfight-index.cjs` 默认列当前加载链与 API；`--name info1,expNum` / `--id 4756` 查询已提交的元件与文本索引，`--code routerOf` 给当前代码位置。纯 Node 只读查询，不产生文件、不依赖 `references/`。

| 类别 | 文件 |
|---|---|
| 构建 | `build-online-app.cjs`（**联机版客户端主入口**：**默认出完整包**到 `src-tauri/dist`（自带前端，给玩家 / 发布）；`--shell` 出**轻壳**到仓库根（页面直接读仓库里的 js/css/images，改代码不用重打，只有改 Rust 才重编）；`--web` 只生成前端快照 + 清单，`--check` 只校验已有快照；`--stage` 出 `squirrel_fight_online.new.exe` 给「一键打包并重启」用，走的是轻壳构建）、`rebuild-online-client.cjs`（开发机「一键打包并重启」执行体：`--stage` 构建 → 旧 exe 改名 `.old.exe` → 新包回原路径并从临时目录重启；`--target` / `--skip-build` / `--no-launch`）、`build-online-apk.cjs`（联机版 APK；默认 arm64 正式包，`SSDZ_ONLINE_ABI=x86_64` 出本机模拟器测试包）、`build-online-ios.cjs`（联机 iOS 快照 + 远程 Mac 构建；依赖 `build-ios-remote.cjs` 的传输层）、`build-ios.cjs`（iOS 快照内的 Mac 侧打包器：Xcode 归档 → 未签名 IPA；由 `build-online-ios.cjs` 上传到配对 Mac 执行）、`check-android-package.cjs`（APK 原生库 ELF ABI / LOAD 对齐复检；ZIP 对齐由 `zipalign -c` 单独负责，不重复）、`prune-dist.cjs`（发布物保留策略：`src-tauri/dist` **只留 `scripts/version.json` 当前版本**的 EXE + 同版本 arm64/x86_64 APK + 两个 iOS IPA，旧包直接删；本次不发 iOS 时才保留最新一版 IPA；`--dry` 先看要删什么；`build-online-apk.cjs` / `build-online-app.cjs` 出包成功后自动调用） |
| 开发机同步 | `pull-win.cjs`（从 Windows peer agent 拉联机版源码；读 `~/.peer/config.json` 的 win/token，按对端 `.gitignore` + 内置清单过滤，覆盖前备份；只用于开发机，不进客户端包） |
| 回归 | `run-tests.cjs`（并行跑 `tools/test-*.cjs`：`--jobs N` / `--serial` / `--only 正则`；CI 用它，35 套件 4 路并行约 44s；失败注解与 job summary 口径不变）、`test-*.cjs`（主题套件，含 `test-online-api-surface.cjs` = 加载链里的 `State.<名字>` 必须存在 + 融合价唯一真值 `fusionCostOf`）、`check-asset-paths.cjs`（资源引用检查；已退役现代素材按前缀跳过）、`check-encodings.cjs`（文本编码 / `.ps1` BOM 体检，CI 也跑） |
| 全流程对账（**不是** `test-*.cjs`，所以不进 CI：跑一次几分钟，按需手跑） | `verify.cjs` —— 三个验证合在一个入口：`story`（剧情机器人：从第 1 层爬到上千层，逐条核对 `docs/剧情触发条件.md`）、`layer100`（整百层那两段的定向回归：22 种「进层前」局面 × 轮数）、`stacking`（同名叠加审计：叠层 / 上限 / 效果随层数放大） |
| 数值 / 数据 | `stage-balance.cjs`、`gen-vendor-data.cjs`（从 `references/orig/` 重新生成 `js/gamedict.js`；**非运行时**，缺参考目录时明确报错） |
| 经典模式素材 + **索引** | `gen-ssfight-ui.cjs`（从原版整片导出提素材到 `images/ssfight/ui/`；**顺带产出两张索引**：`textfields-index.json` = 每个文本字段的框宽/字号/每行几个全角字，`symbol-index.json` = 具名元件 → 元件号/帧数/出现在宿主第几帧）、`gen-ssfight-textfields.cjs`（文本字段元数据 `textfields.json`，**是上面那张索引的框宽来源**）。改经典界面前先查这两张表、别开浏览器 —— 用法见 `docs/经典模式-优化与取证Skill.md` |
| 指南 | 联机构建与发布见根 `AGENTS.md` §1；原 `build-guide.md`（单机跨平台构建）已随单机出包链退役到 `reference/retired/2026-11-10-online-b0/` |

> `verify.cjs` 是 2026-10 第一百零一批加的三个验证工具（用户要求「充分测试 + 写应当条件文档并与实测对照」），
> 第一百零四批**合并成一个入口**（三个原来各带一套一模一样的 vm 引导）；它是**长期要反复跑**的验证工具，
> 所以按上面的门槛留在 `tools/`；一次性探针仍然写 `out/`、用完即删。
> 命名故意不带 `test-` 前缀 —— CI 枚举的是 `tools/test-*.cjs`，它跑一轮要几分钟，交给人工按需跑。
> 同一批还把 `publish-guide.md` + `tauri-guide.md` 合成 `build-guide.md`、
> 把 `build-tauri-web.cjs` 并进 `build-tauri-app.cjs --web`（9 个文件 → 3 个）。

> ⚠️ **别用 PowerShell 的文本 cmdlet 改源码**：`Get-Content` / `Set-Content` / `Add-Content` 在没有
> BOM 的文件上会按系统 ANSI（中文机器 = GBK）解码再写回，**中文会被写坏成乱码 / 非法 UTF-8**
>（2026-10 真踩过两次：一次把 `js/tower-plot.js` 整份写坏、一次把 `js/debug.js` 的注释写坏）。
> 改文件一律用编辑工具（或 Node 读写 Buffer）；确实要用 PowerShell 复制/删除才用 `Copy-Item` / `Remove-Item`。

> ⚠️ **`.ps1` 含中文就必须带 UTF-8 BOM**（另一回事：文件本身是合法 UTF-8，但 **Windows PowerShell 5.1
> 对没有 BOM 的 `.ps1` 按 ANSI 解码**，中文变乱码、甚至把注释块/字符串里的引号拆坏 → 整个脚本解析失败）。
> 本仓库 2026-11 起没有联机出包 `.ps1`，但 `scripts/sync/*.ps1` 等仍受这条约束。
> **编辑工具重写 `.ps1` 时会把 BOM 抹掉**（2026-10 曾把 `tools/build-release.ps1` 弄出 27 个语法错；
> 该文件已随单机出包链退役），改完 `.ps1` 一定复查：`node tools/check-encodings.cjs`（CI 也跑它；
> 它会指出「含中文却没有 UTF-8 BOM」，并给出补 BOM 的一行命令）。

> 文档类内容不要写在这里：改动要点写进 `docs/更新记录.md`（见 `docs/AGENTS.md`）。
