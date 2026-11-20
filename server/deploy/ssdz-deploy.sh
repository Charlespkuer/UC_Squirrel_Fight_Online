#!/usr/bin/env bash
# 在**新服 140.143.142.110** 上装/更新 松鼠大战 Online 的 API 服务（直连 5896）。
#
# 用法（在本机）：
#   tar -czf out/ssdz-api.tgz server js shared css audio images scripts/version.json scripts/index-online.html
#   scp out/ssdz-api.tgz ubuntu@140.143.142.110:/tmp/
#   scp server/deploy/ssdz-deploy.sh ubuntu@140.143.142.110:/tmp/
#   ssh ubuntu@140.143.142.110 "bash /tmp/ssdz-deploy.sh /tmp/ssdz-api.tgz"
#
# 纯网页端（http://140.143.142.110:5896/）由同一个 Node 进程直接下发静态资源：
# SERVE_STATIC=true 且 ALLOW_BROWSER_DEVICES=true。首次部署或前端资源有改动时，
# 包里必须带 css/ audio/ images/，否则页面只能加载 js、样式与素材会 404。
#
# 幂等：重复执行只覆盖代码并重启服务，**不动数据库**。
# 新服 80/443 是同机已有 Docker Caddy（open-webui / 单机网页 / 云存档）的，本脚本不碰它。
set -euo pipefail

PKG="${1:-/tmp/ssdz-api.tgz}"
APP=/opt/ssdz
DATA=/var/lib/ssdz
NODE=/opt/node22/bin/node

echo "== 0. 前置检查 =="
[ -x "$NODE" ] || { echo "缺少 $NODE；先按 docs/服务器与部署.md 装 Node 22（apt 的 Node 18 不能用 node:sqlite）"; exit 1; }
tar -tzf "$PKG" >/dev/null || { echo "坏包：$PKG"; exit 1; }

echo "== 1. 用户与目录 =="
if ! id ssdz >/dev/null 2>&1; then
  getent group ssdz >/dev/null || sudo -n groupadd --system ssdz
  sudo -n useradd --system --gid ssdz --home "$APP" --shell /usr/sbin/nologin ssdz
fi
sudo -n install -d -o root -g root -m 755 "$APP" "$APP/scripts"
sudo -n install -d -o ssdz -g ssdz -m 755 "$DATA"

echo "== 2. 解包（server/ js/ shared/ scripts/） =="
STAGE=$(mktemp -d)
tar -xzf "$PKG" -C "$STAGE"
sudo -n systemctl stop ssdz-online 2>/dev/null || true
sudo -n rm -rf "$APP/server" "$APP/js" "$APP/shared"
sudo -n mkdir -p "$APP/scripts"
sudo -n tar -xzf "$PKG" -C "$APP"
rm -rf "$STAGE"

echo "== 3. 权限 =="
sudo -n find "$APP" -type d -exec chmod 755 {} \;
sudo -n find "$APP" -type f -exec chmod 644 {} \;
sudo -n chown -R root:root "$APP/js" "$APP/shared" "$APP/scripts" "$APP/tools" "$APP/css" "$APP/audio" "$APP/images" 2>/dev/null || true
sudo -n chown -R ssdz:ssdz "$APP/server" "$DATA"
sudo -n chmod 600 "$DATA"/*.db 2>/dev/null || true
[ -f "$APP/css/style.css" ] || echo "!! 缺少 $APP/css/style.css：网页端会 404（打包时带上 css/ audio/ images/）"

echo "== 4. systemd =="
sudo -n tee /etc/systemd/system/ssdz-online.service >/dev/null <<'UNIT'
[Unit]
Description=SSDZ Online API (松鼠大战 Online)
After=network.target

[Service]
Type=simple
User=ssdz
Group=ssdz
WorkingDirectory=/opt/ssdz/server
Environment=NODE_ENV=production
Environment=PORT=5896
Environment=BIND=0.0.0.0
Environment=DATA_DIR=/var/lib/ssdz
Environment=GAME_ROOT=/opt/ssdz
Environment=TZ=Asia/Shanghai
Environment=TZ_NAME=Asia/Shanghai
Environment=SERVE_STATIC=true
Environment=TRUST_PROXY=false
Environment=ALLOW_BROWSER_DEVICES=true
# 可选：静态资源交给 COS/CDN 时填 https://<bucket>.cos.<region>.myqcloud.com
# （只 301 /images /js /css /audio，/api 仍直连本机；COS 要配 CORS）。
# Environment=ASSET_BASE=
Environment=ALLOW_ORIGIN=tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://140.143.142.110:5896,http://127.0.0.1:5896,http://localhost:5896
Environment=LOG_REQUESTS=0
EnvironmentFile=-/etc/ssdz/creator.env
EnvironmentFile=-/etc/ssdz/owner.env
ExecStart=/opt/node22/bin/node index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/ssdz
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
sudo -n systemctl daemon-reload
sudo -n systemctl enable ssdz-online >/dev/null 2>&1 || true
sudo -n systemctl restart ssdz-online
echo "== 5. 自检 =="
# 启动时要先做一次整库备份（100+ MB 的库约 5 秒），固定 sleep 2 会在服务还没监听时误判失败。
HEALTH_OK=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:5896/api/health; then
    echo
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [ "$HEALTH_OK" != "1" ]; then
  echo "!! 服务 30 秒内没有通过 /api/health，保留旧包以便回滚"
  sudo -n systemctl status ssdz-online --no-pager -l | tail -20 || true
  sudo -n journalctl -u ssdz-online -n 40 --no-pager || true
  exit 1
fi
curl -sS -m 8 http://140.143.142.110:5896/api/health
echo
systemctl is-active ssdz-online
echo "== 6. 清理旧包（只留当前版本） =="
VERSION=$(/opt/node22/bin/node -p "require('/opt/ssdz/scripts/version.json').version" 2>/dev/null || true)
if [ -n "$VERSION" ] && [ -f "$DATA/downloads/squirrel_fight_online-$VERSION.exe" ]; then
  KEEP="squirrel_fight_online-$VERSION.exe squirrel_fight_online-$VERSION-arm64.apk squirrel_fight_online-$VERSION-x86_64.apk squirrel_fight_online_${VERSION}_ios_unsigned.ipa squirrel_fight_online_${VERSION}_ios_legacy_unsigned.ipa"
  for k in $KEEP; do
    [ -f "$DATA/downloads/$k" ] || echo "  ⚠ 缺少当前版本包：$k（旧包仍会按版本清理）"
  done
  cd "$DATA/downloads"
  for f in squirrel_fight_online*; do
    [ -f "$f" ] || continue
    keep=0
    for k in $KEEP; do [ "$f" = "$k" ] && keep=1 && break; done
    if [ "$keep" = 0 ]; then
      sudo -n rm -f -- "$f" && echo "  删除旧包：$f"
    fi
  done
else
  echo "  SKIP：当前版本 ${VERSION:-未知} 的 EXE 不在 downloads（先上传包，再部署）"
fi
echo "== done =="
