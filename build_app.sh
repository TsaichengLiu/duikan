#!/bin/bash
# 構建 對勘.app 到 build/ 目錄
set -euo pipefail
cd "$(dirname "$0")"
APP="build/對勘.app"
mkdir -p build
if [ ! -f build/AppIcon.icns ] || [ macos/make_icon.swift -nt build/AppIcon.icns ]; then
  swiftc -O -o build/make_icon macos/make_icon.swift
  build/make_icon build/icon_1024.png
  rm -rf build/AppIcon.iconset && mkdir build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon_1024.png --out build/AppIcon.iconset/icon_${s}x${s}.png >/dev/null
    sips -z $((s*2)) $((s*2)) build/icon_1024.png --out build/AppIcon.iconset/icon_${s}x${s}@2x.png >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
  rm -rf build/AppIcon.iconset build/icon_1024.png build/make_icon
fi
# 先在臨時目錄構建，再同步進現有的 App 包（App 運行中也可以更新；Python 部分重啟後生效）
STAGE="build/.stage.app"
rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/bin"
swiftc -O -o "$STAGE/Contents/MacOS/DuiKan" macos/main.swift
swiftc -O -o "$STAGE/Contents/Resources/bin/dkhelper" macos/dkhelper.swift
rsync -a --exclude __pycache__ --exclude '*.pyc' app/ "$STAGE/Contents/Resources/app/"
cp macos/Info.plist "$STAGE/Contents/Info.plist"
cp build/AppIcon.icns "$STAGE/Contents/Resources/AppIcon.icns"
# ./build_app.sh --install：直接同步到 /Applications（App 運行中也可以；Python 部分重啟後生效），
# 不在 build/ 裡另留一份——否則聚焦搜索、啟動台裡會出現兩個「對勘」。
if [ "${1:-}" = "--install" ]; then
  APP="/Applications/對勘.app"
fi
codesign --force --deep -s - "$STAGE" 2>/dev/null
mkdir -p "$APP"
rsync -a --delete --checksum "$STAGE/" "$APP/"
rm -rf build/.stage.app
echo "已生成 $APP"
