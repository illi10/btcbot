#!/usr/bin/env bash
# 切換模式並填入金鑰（金鑰只存在這台主機的 config.json）
cd "$(dirname "$0")"
echo "1) 只通知  2) 模擬交易（demo.binance.com 的金鑰）  3) 實盤"
read -r -p "選擇 1/2/3：" M
case "$M" in 1) MODE=notify;; 2) MODE=testnet;; 3) MODE=live;; *) echo "取消"; exit 1;; esac
KEY=""; SEC=""
if [ "$MODE" != notify ]; then
  read -r -p "貼上 API Key：" KEY
  read -r -p "貼上 Secret Key（用 Ed25519 自行生成的請直接按 Enter）：" SEC
fi
node -e '
const fs=require("fs");const [mode,key,sec]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync("config.json"));
c.mode=mode; if(key){c.apiKey=key.trim();} if(sec){c.apiSecret=sec.trim();c.privateKeyFile="";} else if(mode!=="notify"&&!c.apiSecret&&fs.existsSync("private.pem")) c.privateKeyFile="private.pem";
fs.writeFileSync("config.json",JSON.stringify(c,null,2),{mode:0o600});console.log("已設定為",mode,"模式。5 分鐘內生效。");' "$MODE" "$KEY" "$SEC"
