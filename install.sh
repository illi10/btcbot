#!/usr/bin/env bash
# 多幣趨勢自動交易：雲端主機（Ubuntu 22.04／24.04）一鍵安裝
# 用法：sudo bash install.sh            （互動：會問資金）
#       EQUITY=500 NTFY_TOPIC=xxx bash install.sh --auto   （建主機時的 Cloud-Init 自動安裝，不問問題）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
AUTO=0; [ "$1" = "--auto" ] && AUTO=1
export DEBIAN_FRONTEND=noninteractive
if [ "$(id -u)" != "0" ]; then echo "請用 root 執行：sudo bash install.sh"; exit 1; fi
push() {   # 安裝過程的結果直接推播到手機（ntfy），不用連線也知道
  [ -n "$NTFY_TOPIC" ] || return 0
  curl -s -m 15 -H "Content-Type: application/json" -d "{\"topic\":\"$NTFY_TOPIC\",\"title\":\"$1\",\"message\":\"$2\",\"priority\":4}" https://ntfy.sh/ >/dev/null || true
}
trap 'push "⚠ btcbot 安裝失敗" "請用 Termius 連上主機，執行 tail -n 30 /root/btcbot-install.log，截圖給 Claude。"' ERR

echo "== 1/7 安裝 Node.js"
NEED=1
if command -v node >/dev/null 2>&1; then
  V=$(node -e 'console.log(process.versions.node.split(".")[0])'); [ "$V" -ge 20 ] && NEED=0
fi
if [ "$NEED" = "1" ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 2/7 檢查這台主機能否連到 Binance"
if ! node bot.js check; then
  echo
  echo "這台主機連不到 Binance（常見原因：機房在美國）。請刪除這台主機，改選東京或新加坡機房重建，再重新安裝。"
  trap - ERR; push "⚠ 這個機房連不到 Binance" "請到 Vultr 刪除這台主機，改選另一個機房（東京↔新加坡）重建。"
  exit 1
fi

echo "== 3/7 記憶體不足 3GB 時加上 2GB 交換空間（分析時峰值約 0.8～1GB）"
MEM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM" -lt 3000 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "已加上 2GB 交換空間"
fi

echo "== 4/7 設定資金與通知"
[ -f config.json ] || cp config.example.json config.json
chmod 600 config.json
if [ "$AUTO" = "1" ]; then EQ="${EQUITY:-500}"; else read -r -p "你的資金（USDT，例如 500）：" EQ; fi
TOPIC="${NTFY_TOPIC:-btcbot-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
node -e '
const fs=require("fs");const c=JSON.parse(fs.readFileSync("config.json"));
c.equity=Number(process.argv[1])||c.equity||500; if(!c.ntfyTopic) c.ntfyTopic=process.argv[2];
fs.writeFileSync("config.json",JSON.stringify(c,null,2),{mode:0o600});console.log("通知主題："+c.ntfyTopic);' "$EQ" "$TOPIC"

echo "== 5/7 下載 7 年歷史資料（約 5～20 分鐘）"
BTCBOT_DIR="$DIR" NODE_OPTIONS=--max-old-space-size=1536 node bot.js warmup

echo "== 6/7 設定每 5 分鐘自動執行（重開機自動恢復）"
NODE="$(command -v node)"
cat > /etc/systemd/system/btcbot.service <<UNIT
[Unit]
Description=btcbot：對帳＋收盤後分析下單（執行一次）
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=BTCBOT_DIR=$DIR
Environment=NODE_OPTIONS=--max-old-space-size=1536
ExecStart=$NODE $DIR/bot.js
TimeoutStartSec=1800
UNIT
cat > /etc/systemd/system/btcbot.timer <<UNIT
[Unit]
Description=btcbot：每 5 分鐘執行
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now btcbot.timer

echo "== 7/7 測試通知"
BTCBOT_DIR="$DIR" node bot.js test-notify
sleep 2
echo
trap - ERR
push "✅ btcbot 安裝完成" "主機已開始運作（只通知模式，不會下單）。有新訊號時會通知你。"
echo "完成。目前是「只通知」模式，不會下單。"
echo "手機安裝 ntfy App，按 + 訂閱這個主題（要完全一樣）：$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config.json")).ntfyTopic)')"
echo "之後切換模式或填金鑰：sudo bash $DIR/setmode.sh"
