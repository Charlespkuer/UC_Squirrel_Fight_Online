# scripts/ 入口（联机版双击入口）

这个目录只放**联机版双击能用的入口**（`.cmd` / `.command` 薄壳）和它们对应的逻辑：

- `start-online.cmd`：启动仓库根的联机轻壳 `squirrel_fight_online.exe`（没有就先跑 `build-online.cmd`）。
  开发时起服务端仍是 `node server/index.js`，浏览器打开 `http://127.0.0.1:3100/`（入口页
  `scripts/index-online.html`，服务端会把它映射成 `/`）。
- `build-online.cmd` → `node tools/build-online-app.cjs`：完整包 / 轻壳共用入口（参数原样透传）。
- `build-online-android.cmd` → `node tools/build-online-apk.cjs`：联机版安卓 APK。
- `一键同步.*` → `sync/sync-win.ps1`（Windows 菜单）→ `sync/sync.js`（双机同步逻辑，零依赖 Node）。
  端口 / 口令 / 对端在 `sync/sync.config.json`（本机私货，不进仓库）；日志写 `save/`
  （`sync.out.log` / `sync.err.log`，运行时产物）。
  **两台机器的端口必须一样**（新版默认 18788；8788 落在 Windows 的保留段 8719-8818，
  非管理员绑不上）。换端口：`node scripts/sync/sync.js port <新端口>` → 两台都改 →
  `node scripts/sync/sync.js restart`，Windows 上再跑一次 `firewall` 放行新端口。
- 忽略规则：以仓库根 `.gitignore` 为准（前导 `/` 只锚定游戏根，改完不用重启服务）。
  被忽略的路径**永远不会同步**；`diffWithPeer` 会把「对端有、但被本机规则挡住」的文件列出来，
  看到那段提示就去改 `.gitignore` / `config.ignore`。
- `重启同步服务.cmd` / `restart-sync.cmd` → `node sync/sync.js restart`（改过口令或端口后跑一次）。

> **2026-11-10 退役**：单机版启动器（`启动游戏.*` / `停止游戏.command` / `start-game.ps1` /
> `game-exit-watch.sh` / `serve.js` / `serve.py` / `update-game.js`）、单机出包入口
> （`打包.cmd` / `清缓存.cmd` / `一键打包IPA.command`）与单机网页入口 `index.html` 已移到
> `reference/retired/2026-11-10-online-b0/`。本仓库不再提供单机版运行/出包。

约定：`.cmd` 只放 **ASCII**（cmd.exe 读 UTF-8 中文会乱），中文与逻辑放 `.ps1`（必须带 UTF-8 BOM）或 `.js`；
任何进程都**不要拿游戏目录当工作目录**（会让整个文件夹没法改名 / 移动，见 `sync/sync.js` 注释）。
