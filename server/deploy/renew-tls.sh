#!/bin/sh
# 旧服 111.229.39.217 的 Let's Encrypt IP 证书安装脚本（旧服 ssdz 已于 2026-11-04 删除）。
# 新服 140.143.142.110 的游戏 API 直连 5896、不用 TLS；不要在新服运行本脚本。
set -eu
install -d -m 750 -o root -g caddy /etc/caddy/ssdz-tls
install -m 644 -o root -g caddy /etc/letsencrypt/live/111.229.39.217/fullchain.pem /etc/caddy/ssdz-tls/fullchain.pem
install -m 640 -o root -g caddy /etc/letsencrypt/live/111.229.39.217/privkey.pem /etc/caddy/ssdz-tls/privkey.pem
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
