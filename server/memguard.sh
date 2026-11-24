#!/bin/sh
# 把 ssdz-online 的冷页缓存压回水位线；MemorySwapMax=0 保证不会换出 Node 堆。
# 单次最多回收 256M，避免和备份/请求高峰抢 I/O；剩余部分下一轮再收。
set -eu
CG=/sys/fs/cgroup/system.slice/ssdz-online.service
LIMIT=${SSDZ_MEM_LIMIT:-$((440 * 1024 * 1024))}
[ -r "$CG/memory.current" ] || exit 0
cur=$(cat "$CG/memory.current")
[ "$cur" -gt "$LIMIT" ] || exit 0
need=$((cur - LIMIT))
cap=$((256 * 1024 * 1024))
[ "$need" -gt "$cap" ] && need=$cap
if printf '%s\n' "$need" > "$CG/memory.reclaim" 2>/dev/null; then
  logger -t ssdz-memguard "reclaimed ${need}B current=${cur} limit=${LIMIT}" || true
else
  logger -t ssdz-memguard "reclaim failed current=${cur} need=${need}" || true
fi
