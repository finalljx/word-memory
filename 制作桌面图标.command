#!/bin/bash
# 在桌面生成一个「词卡.app」，以后双击图标就能用，不弹终端
cd "$(dirname "$0")" || exit 1

APP="$HOME/Desktop/词卡.app"
LAUNCHER="$PWD/scripts/serve-bg.sh"

clear
echo "正在生成桌面图标…"
echo ""

rm -rf "$APP"
TMP="$(mktemp /tmp/wm-launcher.XXXXXX).applescript"
cat > "$TMP" <<APPLESCRIPT
on run
  set p to "$LAUNCHER"
  try
    do shell script quoted form of p
  on error errMsg
    display dialog "启动失败：" & errMsg buttons {"好"} default button 1 with title "词卡"
  end try
end run
APPLESCRIPT

if osacompile -o "$APP" "$TMP"; then
  rm -f "$TMP"
  echo "已生成：$APP"
  echo ""
  echo "把它拖到程序坞，双击就能启动。"
  echo "第一次打开如果提示「无法验证开发者」，右键图标 → 打开 即可。"
  open -R "$APP"
else
  rm -f "$TMP"
  echo "生成失败，请把上面的报错截图反馈。"
fi

echo ""
read -n 1 -s -r -p "按任意键关闭…"
