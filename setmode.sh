#!/bin/sh
# 切換模式、填金鑰、設定資金（金鑰只存在這台主機的 config.json）
cd "$(dirname "$0")"
CUR=$(node -e 'const c=JSON.parse(require("fs").readFileSync("config.json"));console.log((c.mode||"notify")+" "+(c.equity??500))')
echo "目前：模式 ${CUR% *}，資金 ${CUR#* }（0＝跟著帳戶）"
echo "1) 只通知  2) 模擬交易（demo.binance.com 的金鑰）  3) 實盤  4) 只改資金"
printf "選擇 1/2/3/4："; read -r M
case "$M" in 1) MODE=notify;; 2) MODE=testnet;; 3) MODE=live;; 4) MODE=keep;; *) echo "取消"; exit 1;; esac
KEY=""; SEC=""
if [ "$MODE" = testnet ] || [ "$MODE" = live ]; then
  printf "貼上 API Key（直接 Enter＝沿用原本的）："; read -r KEY
  printf "貼上 Secret Key（直接 Enter＝沿用原本的）："; read -r SEC
fi
echo "資金：填數字＝最多用這個金額計算部位；填 0＝跟著合約帳戶餘額（入金後自動放大）"
printf "資金 USDT（直接 Enter＝不變）："; read -r EQ
node -e '
const fs=require("fs");const [mode,key,sec,eq]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync("config.json"));const prev=c.mode||"notify";
if(mode!=="keep") c.mode=mode;
if(key){c.apiKey=key.trim();} if(sec){c.apiSecret=sec.trim();c.privateKeyFile="";}
else if(key&&!c.apiSecret&&fs.existsSync("private.pem")) c.privateKeyFile="private.pem";
if(eq!==""){const v=Number(eq); if(!(v===0||v>=20)){console.log("資金要填 0 或至少 20，未變更資金");} else c.equity=v;}
if(c.mode==="notify"&&c.equity===0){c.equity=500;console.log("只通知模式讀不到帳戶，資金不能設 0，已改為 500");}
if(c.mode!=="notify"&&!c.apiKey){console.log("⚠ 這個模式需要 API Key，請重新執行並貼上");}
if(["testnet","live"].includes(mode)&&!key&&prev!==mode&&prev!=="notify"){console.log("⚠ 模擬交易和實盤的金鑰不同，若剛切換請重新執行並貼上對應的金鑰");}
fs.writeFileSync("config.json",JSON.stringify(c,null,2),{mode:0o600});
console.log(`已設定：模式 ${c.mode}，資金 ${c.equity===0?"跟著帳戶":c.equity+" USDT"}。5 分鐘內生效。`);' "$MODE" "$KEY" "$SEC" "$EQ"
