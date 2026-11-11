#!/bin/bash
# btcbot 自動安裝：建立 Vultr 主機時，貼到「Cloud-Init User-Data」欄位
EQUITY=500                     # 你的資金（USDT）
NTFY_TOPIC=把這裡換成你的通知主題
apt-get update -y && apt-get install -y git curl ca-certificates
git clone --depth 1 https://github.com/illi10/btcbot /root/btcbot-vps
cd /root/btcbot-vps && EQUITY=$EQUITY NTFY_TOPIC=$NTFY_TOPIC bash install.sh --auto > /root/btcbot-install.log 2>&1
