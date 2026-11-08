#!/bin/bash
# 双击启动词卡（前台运行，关掉这个窗口就停止）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4610}"
URL="http://127.0.0.1:${PORT}"

clear
echo "🃏  词卡"
echo "──────────────────────────────"

if curl -s -o /dev/null --max-time 1 "$URL"; then
  echo "词卡已经在运行了，正在打开浏览器…"
  open "$URL"
  sleep 1
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。"
  echo "请先到 https://nodejs.org 下载 LTS 版本安装，装完再双击本文件。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
NODE_MINOR="$(node -p "process.versions.node.split('.')[1]")"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "Node.js 版本太旧（当前 $(node -v)），需要 22.5 以上。"
  echo "请到 https://nodejs.org 装最新 LTS。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "正在启动… 浏览器会自动打开"
echo "关掉这个窗口，服务就停了。"
echo ""

node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 1 "$URL"; then
    open "$URL"
    break
  fi
  sleep 0.25
done

wait "$SERVER_PID"
