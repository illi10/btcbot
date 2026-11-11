# btcbot：多幣趨勢自動交易（Binance U 本位合約）

訊號、選幣、風險與停用規則和網頁版「多幣趨勢開倉」使用同一套引擎（engine.js 由同一份原始碼產生）。
程式碼不含任何金鑰；金鑰只存在主機的 config.json（已排除在版本控制之外）。

## 雲端主機一鍵安裝（Vultr，Ubuntu 24.04）

建立主機時勾選「Enable Cloud-Init User-Data」，貼上 `userdata.example.sh` 的內容（把通知主題換成自己的）。
主機開機後會自動安裝、下載歷史資料並啟動「只通知」模式，完成或失敗都會推播到 ntfy。

## 常用指令（Termius 連上主機後）

| 用途 | 指令 |
| --- | --- |
| 狀態 | `cd ~/btcbot-vps && node bot.js status` |
| 紀錄 | `tail -n 30 ~/btcbot-vps/log.txt` |
| 切換模式／填金鑰 | `bash ~/btcbot-vps/setmode.sh` |
| 更新程式 | `cd ~/btcbot-vps && git pull` |
| 暫停／恢復 | `systemctl stop btcbot.timer` ／ `systemctl start btcbot.timer` |
