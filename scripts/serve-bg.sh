#!/bin/bash
# 后台启动词卡：不弹终端窗口，启动后自动开浏览器。
# 被「词卡.app」和「启动词卡（后台）.command」调用。
set -u

# AppleScript 启动时 PATH 很短，补上常见的 node 安装位置
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

PORT="${PORT:-4610}"
URL="http://127.0.0.1:${PORT}"
PIDFILE="$DIR/.server.pid"
LOG="$DIR/logs/server.log"

say() {
  [ -n "${NO_DIALOG:-}" ] && return 0
  osascript -e "display dialog \"$1\" buttons {\"好\"} default button 1 with title \"词卡\"" >/dev/null 2>&1
}

open_browser() {
  [ -n "${NO_OPEN:-}" ] && return 0
  open "$URL"
}

# 已经在跑：直接开浏览器
if curl -s -o /dev/null --max-time 1 "$URL"; then
  open_browser
  exit 0
fi

# 检查 Node
if ! command -v node >/dev/null 2>&1; then
  say "没有找到 Node.js。\\n\\n请先到 nodejs.org 下载 LTS 版本安装，装完再双击一次。"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
NODE_MINOR="$(node -p "process.versions.node.split('.')[1]")"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  say "Node.js 版本太旧（当前 $(node -v)）。\\n\\n需要 22.5 以上，请到 nodejs.org 装最新 LTS。"
  exit 1
fi

mkdir -p "$DIR/logs"

# 端口被别的程序占了？
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "端口 $PORT 被别的程序占用了。\\n\\n关掉那个程序，或者用 PORT=4611 重新启动。"
  exit 1
fi

nohup node server.js >>"$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PIDFILE"
disown "$SERVER_PID" 2>/dev/null || true

# 等端口就绪（最多 15 秒）
for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 1 "$URL"; then
    open_browser
    exit 0
  fi
  sleep 0.25
done

say "启动超时了，可以看看 logs/server.log 里的报错。"
exit 1
