#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash scripts/stop.sh
echo ""
read -n 1 -s -r -p "按任意键关闭…"
