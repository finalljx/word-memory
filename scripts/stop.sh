#!/bin/bash
# 停止后台运行的词卡
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$DIR/.server.pid"
PORT="${PORT:-4610}"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "词卡已停止（PID ${PID}）"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

echo "没有找到后台运行的词卡。"
echo "如果页面还能打开，可能是从终端前台启动的，回到那个终端按 Ctrl+C 即可。"
