# images/ 入口（图像素材）

按用途分区：`ui/`（按钮 / 卡片 / 数字 / 界面块）、`atlas/`（图集）、`battle/`
（`bg/` 战斗背景、`fx/` 战斗特效、`outfit/` 穿戴件——原 `images/effect` / `images/equip` 已并入这里）、
`ssfight/`（经典模式）。**运行期只有这四个目录**。

- 运行时按硬编码路径取图（`js/gamedict.js`、引擎与经典界面里都有 `images/...` 字面量）——
  改目录名 / 挪文件前先跑 `node tools/check-asset-paths.cjs` 看引用会不会断。
- `ssfight/ui/` 是 `tools/gen-ssfight-ui.cjs` 从原版导出的素材：导出物，别手改 —— 改生成器或源码再重导。
- `ssfight/ui/bitmap/` 的 1x 原件归档在 `reference/.bak-upscale/`（有 `.hd.jpg|.hd.png` 时生成器不再落 1x）。
- **退场素材**：2026-11 把现代界面时代留下的、运行期零引用的图（原 `classic/` 整棵 973 张、
  `ui/skins/`、`ui/sprites/` 里没被拼到的切图、`ui/characters/*-card.png` 等）统一移到了
  `reference/retired/2026-11-08/`（保留原相对路径 + `deadset.json` 清单）。
  那里是**归档**：不进仓库、不进发布包，运行时也不再读；要复活某张图，先拷回对应素材目录再改代码。

截图 / 对比图一律写 `out/`。
