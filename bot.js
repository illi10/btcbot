#!/usr/bin/env node
/* 多幣趨勢自動交易（Termux / Node.js）
 * 訊號、選幣、風險與停用規則全部沿用網頁 index.html 的同一套引擎（engine.js 由同一份原始碼產生）。
 * 模式：notify＝只通知不下單；testnet＝Binance 合約測試網；live＝實盤。
 * 每次執行：①對帳（止損／止盈是否成交、到期平倉、補掛缺少的保護單）②若剛過 4 小時收盤，分析並開新倉。
 * 用法：node bot.js            執行一次（給排程用）
 *       node bot.js status     顯示目前狀態
 *       node bot.js test-notify 測試手機通知
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), {execFileSync} = require("child_process");
const DIR = process.env.BTCBOT_DIR || __dirname;
process.env.BTCBOT_DIR = DIR;
const E = require("./engine.js"), CORE = E.CORE, DATA = E.DATA;

const H4 = 4 * 3600000, D1 = 86400000;
const MAKER_BPS = 2;                      // 止盈限價單的掛單手續費（Binance U 本位一般用戶 0.02%）；回測仍保守以吃單＋滑價計
const ENTRY_WINDOW = 30 * 60000;          // 收盤後 30 分鐘內才開新倉（延遲測試結果）
const MIN_AFTER_CLOSE = 90 * 1000;        // 收盤後至少 90 秒再抓資料，確保 K 棒已收
const BASES = {live: "https://fapi.binance.com", testnet: "https://demo-fapi.binance.com"};   // testnet＝Binance 模擬交易（demo.binance.com）
const CLOSED = new Set(["TRIGGERED", "FINISHED"]), DEAD = new Set(["CANCELED", "EXPIRED", "REJECTED"]);

/* ── 設定與狀態 ── */
const CFG_FILE = path.join(DIR, "config.json"), STATE_FILE = path.join(DIR, "state.json"), LOG_FILE = path.join(DIR, "log.txt");
function loadCfg() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) { throw new Error("讀不到 config.json：" + e.message); }
  c.mode = c.mode || "notify";
  if (!["notify", "testnet", "live"].includes(c.mode)) throw new Error("config.json 的 mode 只能是 notify、testnet、live");
  if (c.mode !== "notify") {
    if (!c.apiKey) throw new Error(`${c.mode} 模式需要 apiKey`);
    if (c.privateKeyFile) c.privKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(DIR, c.privateKeyFile)));   // Ed25519 金鑰
    else if (!c.apiSecret) throw new Error(`${c.mode} 模式需要 apiSecret（HMAC）或 privateKeyFile（Ed25519）`);
  }
  c.equity = Number(c.equity) || 0;                       // 最多用多少 USDT 計算部位（0＝用帳戶全部）
  if (c.mode === "notify" && !(c.equity >= 20)) throw new Error("notify 模式請在 config.json 填 equity（你的資金，USDT）");
  c.risk = c.risk === undefined || c.risk === "auto" ? "auto" : Number(c.risk);   // 每筆風險 %；auto＝和網頁相同的自動選擇
  if (c.risk !== "auto" && !(c.risk >= 0.1 && c.risk <= 3)) throw new Error("risk 只能是 \"auto\" 或 0.1～3");
  c.autoMin = c.autoMin !== false;
  return c;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {trades: [], closed: [], lastBar: 0, day: null, peak: 0}; }
}
function saveState(S) { fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(S, null, 1)); fs.renameSync(STATE_FILE + ".tmp", STATE_FILE); }

/* ── 紀錄與通知 ── */
const tpe = ms => new Date(ms).toLocaleString("zh-TW", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei"});
function log(s) {
  const line = `[${new Date().toLocaleString("zh-TW", {hour12: false, timeZone: "Asia/Taipei"})}] ${s}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
    if (fs.statSync(LOG_FILE).size > 2e6) { const t = fs.readFileSync(LOG_FILE, "utf8"); fs.writeFileSync(LOG_FILE, t.slice(-1e6)); }
  } catch (e) {}
}
let notifyN = 0, NTFY = null;                // 雲端主機：用 ntfy（手機裝 ntfy App 訂閱同一個主題）推播
function notify(title, text, urgent = false) {
  log(`通知｜${title}｜${text.replace(/\n/g, " / ")}`);
  if (process.env.BTCBOT_NO_NOTIFY) return;
  if (NTFY === null) { try { NTFY = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")).ntfyTopic || ""; } catch (e) { NTFY = ""; } }
  if (NTFY) {
    fetch("https://ntfy.sh/", {method: "POST", headers: {"Content-Type": "application/json"},           // JSON 發佈：中文標題不受 HTTP 標頭編碼限制
      body: JSON.stringify({topic: NTFY, title, message: text, priority: urgent ? 5 : 4, tags: [urgent ? "warning" : "chart_with_upwards_trend"]})})
      .catch(e => log("ntfy 推播失敗：" + e.message));
    return;
  }
  try {
    execFileSync("termux-notification", ["--title", title, "--content", text, "--id", "btcbot" + (Date.now() % 100000) + (notifyN++),
      "--priority", urgent ? "max" : "high", ...(urgent ? ["--vibrate", "300,200,300"] : [])], {timeout: 15000});
  } catch (e) {}
}

/* ── Binance 合約 API（簽章） ── */
let CFG, BASE, OFFSET = 0;
async function api(method, p, params = {}, signed = true) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  if (signed) {
    q.set("recvWindow", "10000"); q.set("timestamp", String(Date.now() + OFFSET));
    q.set("signature", CFG.privKey ? crypto.sign(null, Buffer.from(q.toString()), CFG.privKey).toString("base64")
      : crypto.createHmac("sha256", CFG.apiSecret).update(q.toString()).digest("hex"));
  }
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);
  let r, txt;
  try {
    r = await fetch(`${BASE}${p}${q.toString() ? "?" + q : ""}`, {method, headers: signed ? {"X-MBX-APIKEY": CFG.apiKey} : {}, signal: ac.signal});
    txt = await r.text();
  } finally { clearTimeout(to); }
  let js; try { js = JSON.parse(txt); } catch (e) { js = {msg: txt}; }
  if (!r.ok || (js && typeof js.code === "number" && js.code < 0)) {
    const err = new Error(`${method} ${p} → ${js.code ?? r.status} ${js.msg || ""}`.trim()); err.code = js.code; err.status = r.status; throw err;
  }
  return js;
}
async function syncTime() { const t0 = Date.now(), js = await api("GET", "/fapi/v1/time", {}, false); OFFSET = js.serverTime - Math.round((t0 + Date.now()) / 2); }
async function account() {
  const a = await api("GET", "/fapi/v3/account");
  return {equity: +a.totalMarginBalance, wallet: +a.totalWalletBalance, avail: +a.availableBalance};
}
async function positions() {
  const m = {}; for (const p of await api("GET", "/fapi/v3/positionRisk")) m[p.symbol] = (m[p.symbol] || 0) + +p.positionAmt;
  return m;
}
let TICKS = null;                       // 交易端的下單規則：數量級距、最小名目、價格級距
async function tradeFilters() {
  if (TICKS) return TICKS;
  const info = await api("GET", "/fapi/v1/exchangeInfo", {}, false), m = {};
  for (const sy of info.symbols) {
    const f = {};
    for (const x of sy.filters) {
      if (x.filterType === "MARKET_LOT_SIZE") f.step = +x.stepSize;
      if (x.filterType === "LOT_SIZE") f.lot = +x.stepSize;
      if (x.filterType === "MIN_NOTIONAL") f.min = +x.notional;
      if (x.filterType === "PRICE_FILTER") f.tick = +x.tickSize;
    }
    f.step = Math.max(f.step || 0, f.lot || 0);
    if (f.step > 0 && f.tick > 0) m[sy.symbol] = f;
  }
  return (TICKS = m);
}
const dec = s => Math.max(0, Math.ceil(-Math.log10(s) - 1e-9));
const roundTo = (x, s, mode = "round") => { const k = Math[mode](x / s + (mode === "floor" ? 1e-9 : mode === "ceil" ? -1e-9 : 0)); return +(k * s).toFixed(dec(s)); };
const cid = (...a) => "bt" + crypto.createHash("sha1").update(a.join("|")).digest("hex").slice(0, 26);

async function getAlgo(clientAlgoId) { try { return await api("GET", "/fapi/v1/algoOrder", {clientAlgoId}); } catch (e) { return null; } }
async function cancelAlgo(clientAlgoId) { try { await api("DELETE", "/fapi/v1/algoOrder", {clientAlgoId}); return true; } catch (e) { return false; } }
/* 止盈＝一般限價單（只減倉、GTC，從開倉起就掛在止盈價，成交收掛單費）；狀態換算成和條件單相同的字樣 */
const LIM_STATUS = {FILLED: "FINISHED", NEW: "NEW", PARTIALLY_FILLED: "NEW", CANCELED: "CANCELED", EXPIRED: "EXPIRED", REJECTED: "REJECTED", EXPIRED_IN_MATCH: "EXPIRED"};
async function getLimit(sym, id) {
  try { const o = await api("GET", "/fapi/v1/order", {symbol: sym, origClientOrderId: id}); return {algoStatus: LIM_STATUS[o.status] || o.status, actualPrice: o.avgPrice, raw: o}; }
  catch (e) { return null; }
}
async function cancelLimit(sym, id) { try { await api("DELETE", "/fapi/v1/order", {symbol: sym, origClientOrderId: id}); return true; } catch (e) { return false; } }
const getProt = (t, kind) => !t[kind + "Id"] ? Promise.resolve(null) : kind === "sl" ? getAlgo(t.slId) : getLimit(t.sym, t.tpId);
const cancelProt = (t, kind) => !t[kind + "Id"] ? Promise.resolve(false) : kind === "sl" ? cancelAlgo(t.slId) : cancelLimit(t.sym, t.tpId);
async function placeProtect(t, kind) {          // kind: "sl"（止損：市價條件單）| "tp"（止盈：限價單）；同一個 id 已存在就沿用
  const id = t.id.slice(0, 30) + (kind === "sl" ? "s" : "t") + (t[kind + "N"] || 0);
  const old = kind === "sl" ? await getAlgo(id) : await getLimit(t.sym, id);
  if (old && !DEAD.has(old.algoStatus)) { t[kind + "Id"] = id; return old; }
  const side = t.side > 0 ? "SELL" : "BUY";
  const js = kind === "sl"
    ? await api("POST", "/fapi/v1/algoOrder", {algoType: "CONDITIONAL", symbol: t.sym, side, type: "STOP_MARKET", quantity: t.qtyS, reduceOnly: "true",
        triggerPrice: t.slS, workingType: "CONTRACT_PRICE", clientAlgoId: id})
    : await api("POST", "/fapi/v1/order", {symbol: t.sym, side, type: "LIMIT", timeInForce: "GTC", price: t.tpS, quantity: t.qtyS, reduceOnly: "true",
        newClientOrderId: id});
  t[kind + "Id"] = id; return js;
}
async function marketClose(t, qty) {
  return api("POST", "/fapi/v1/order", {symbol: t.sym, side: t.side > 0 ? "SELL" : "BUY", type: "MARKET", quantity: qty, reduceOnly: "true",
    newClientOrderId: cid(t.id, "close", Date.now()), newOrderRespType: "RESULT"});
}

/* ── 入金／出金：用「淨值指數」排除資金劃轉，停用線與單日虧損只反映交易損益 ──
 * 做法同基金淨值：指數＝權益÷單位數。入金或出金時以當下指數增減單位數，指數不變；交易損益才會讓指數變動。
 * 劃轉紀錄來自 /fapi/v1/income（TRANSFER 等類型）。查詢失敗時沿用上一次的指數，不會把劃轉誤判成損益。 */
const FLOW_TYPES = new Set(["TRANSFER", "INTERNAL_TRANSFER", "COIN_SWAP_DEPOSIT", "COIN_SWAP_WITHDRAW", "WELCOME_BONUS"]);
const FLOW_ASSETS = new Set(["USDT", "USDC", "FDUSD", "BNFCR"]);
async function newFlows(S, now) {
  const F = S.flow || (S.flow = {lastT: now, seen: []});
  let start = F.lastT - 3600000, total = 0, ids = [];   // 往前多查 1 小時，避免交易所紀錄延遲而漏掉（靠 seen 去重）
  for (let page = 0; page < 10; page++) {
    const rows = await api("GET", "/fapi/v1/income", {startTime: start, endTime: now, limit: 1000});
    for (const r of rows) {
      const key = String(r.tranId) + "|" + r.time + "|" + r.incomeType;
      if (!FLOW_TYPES.has(r.incomeType) || !FLOW_ASSETS.has(r.asset) || F.seen.includes(key)) continue;
      total += +r.income; ids.push(key);
    }
    if (rows.length < 1000) break;
    start = Math.max(...rows.map(r => +r.time)) + 1;
  }
  return {total, ids};
}
async function updateNav(S, equity, now) {
  if (!(S.nav && S.nav.units > 0)) {                       // 第一次（或舊版狀態）：指數從 1 開始
    S.nav = {units: Math.max(equity, 1e-9), index: 1, peak: 1};
    S.flow = {lastT: now, seen: []};
    try { S.flow.seen = (await newFlows(S, now)).ids; } catch (e) {}   // 起算前的劃轉已含在權益裡，只記下不計入
    return S.nav;
  }
  let fl;
  try { fl = await newFlows(S, now); }
  catch (e) { log(`查不到劃轉紀錄，沿用上次淨值：${e.message}`); return S.nav; }
  const N = S.nav;
  if (fl.total) {
    const pre = equity - fl.total;                         // 劃轉前的權益（兩次執行間的交易損益很小，歸在劃轉前）
    const idx = pre > 0 ? pre / N.units : N.index;
    N.units = Math.max(N.units + fl.total / idx, 1e-9);
    log(`偵測到${fl.total > 0 ? "入金" : "出金"} ${Math.abs(fl.total).toFixed(2)}U，已排除於損益之外`);
    notify(`偵測到${fl.total > 0 ? "入金" : "出金"} ${Math.abs(fl.total).toFixed(2)} U`, `合約帳戶權益約 ${equity.toFixed(2)}U；停用線與單日虧損只計交易損益，不受影響。`);
  }
  N.index = equity / N.units;
  N.peak = Math.max(N.peak || N.index, N.index);
  S.flow.lastT = now;
  S.flow.seen = [...S.flow.seen, ...fl.ids].slice(-500);
  return N;
}

/* ── ① 對帳：每次執行都做 ── */
async function reconcile(S) {
  if (!S.trades.length) return;
  const pos = await positions();
  for (const t of [...S.trades]) {
    const amt = pos[t.sym] || 0;
    const sl = await getProt(t, "sl"), tp = await getProt(t, "tp");
    let exit = null;
    if (sl && CLOSED.has(sl.algoStatus)) exit = {why: "止損", px: +sl.actualPrice || t.sl};
    else if (tp && CLOSED.has(tp.algoStatus)) exit = {why: "止盈", px: +tp.actualPrice || t.tp};
    else {
      const rem = t.qty - (tp && tp.raw ? +tp.raw.executedQty || 0 : 0);   // 止盈限價單部分成交後，剩餘數量
      if (Math.sign(amt) !== t.side || Math.abs(amt) < rem * 0.5) exit = {why: "倉位已不在（可能手動平倉或強平）", px: NaN};
    }
    if (exit) {
      if (exit.why === "止損") await cancelProt(t, "tp");
      else if (exit.why === "止盈") await cancelProt(t, "sl");
      else { await cancelProt(t, "sl"); await cancelProt(t, "tp"); }
      closeTrade(S, t, exit.why, exit.px);
      continue;
    }
    /* 到期：市價平掉這一筆的數量 */
    if (Date.now() >= t.deadline) {
      try {
        await cancelProt(t, "tp");
        const r = await marketClose(t, t.qtyS);
        await cancelProt(t, "sl");
        closeTrade(S, t, "到期平倉", +r.avgPrice || NaN);
      } catch (e) { notify("⚠ 到期平倉失敗", `${t.sym}：${e.message}。請手動市價平倉 ${t.qtyS}。`, true); }
      continue;
    }
    /* 保護單遺失就補掛；止損補不上就平倉 */
    for (const kind of ["sl", "tp"]) {
      const o = kind === "sl" ? sl : tp;
      if (kind === "tp" && t.tpS === null) continue;
      if (t[kind + "Id"] && !(o && DEAD.has(o.algoStatus))) continue;     // 查詢失敗時不補掛，避免重複
      t[kind + "N"] = (t[kind + "N"] || 0) + 1;
      try { await placeProtect(t, kind); log(`補掛${kind === "sl" ? "止損" : "止盈"} ${t.sym}`); }
      catch (e) {
        if (kind === "sl") {
          try { const r = await marketClose(t, t.qtyS); await cancelProt(t, "tp"); closeTrade(S, t, "止損無法掛上，已平倉", +r.avgPrice || NaN); }
          catch (e2) { notify("⚠ 止損遺失且平倉失敗", `${t.sym}：${e2.message}。請立刻手動處理。`, true); }
          break;
        }
        notify("止盈補掛失敗", `${t.sym}：${e.message}（止損仍在）`);
      }
    }
    saveState(S);
  }
  /* 某幣已無倉位：清掉該幣殘留的條件單 */
  const live = new Set(S.trades.map(t => t.sym));
  for (const sym of S.touched || []) if (!live.has(sym) && !(pos[sym])) { try { await api("DELETE", "/fapi/v1/algoOpenOrders", {symbol: sym}); } catch (e) {} try { await api("DELETE", "/fapi/v1/allOpenOrders", {symbol: sym}); } catch (e) {} }
  S.touched = [...live];
  saveState(S);
}
function closeTrade(S, t, why, px) {
  const pnl = Number.isFinite(px) ? t.side * (px - t.entry) * t.qty : NaN, R = pnl / t.riskUsd;
  S.trades = S.trades.filter(x => x.id !== t.id);
  S.closed.push({...t, exitT: Date.now(), exitPx: px, why, pnl, R});
  if (S.closed.length > 500) S.closed = S.closed.slice(-500);
  notify(`${E.coin(t.sym)} ${why}`, Number.isFinite(pnl) ? `損益約 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}U（${R >= 0 ? "+" : ""}${R.toFixed(2)}R）` : "請到 App 確認損益");
  saveState(S);
}

/* ── ② 分析：和網頁 analyze() 相同的計算（不含畫面） ── */
async function analyze(equity) {
  let poolList, viaFapi = true, filters = {};
  try { const u = await E.loadPool(); poolList = u.poolList; filters = u.filters; }
  catch (e) { viaFapi = false; poolList = E.FALLBACK.map(b => ({sym: b + "USDT", base: b})); }
  E.setFilters(filters);
  if (!poolList.some(c => c.sym === "BTCUSDT")) poolList.unshift({sym: "BTCUSDT", base: "BTC"});
  const p = await E.pickProvider();
  if (!p) throw new Error("連不到任何交易所的公開行情");
  const daily = {};
  if (viaFapi) await E.pool(poolList.map(c => async () => { try { const d = await E.dailyVol(c.sym, CORE.HTF_START - 100 * D1); if (d.t.length) daily[c.sym] = d; } catch (e) {} }), 4, 20);
  const inst = [], loaded = new Map();
  let months = null, eligible;
  const loadCoin = async sym => {
    const rows = await E.cachedRows(p, sym, 60, CORE.HTF_START, () => {});
    const b60 = DATA.toBars(rows, Date.now(), 60);
    if (b60.time.length < 24 * 90) throw new Error("資料太少");
    const f = await E.fetchFunding(CORE.HTF_START, sym);
    for (const tf of E.TFS) {
      const b = tf === 60 ? b60 : DATA.toBars(rows, Date.now(), tf);
      CORE.attachFunding(b, f.fr); b.fundingSrc = f.src;
      inst.push({sym, tf, bars: b, P: CORE.prepare(b, tf)});
    }
    loaded.set(sym, true);
  };
  if (Object.keys(daily).length >= E.TOP_N) {
    for (let round = 0; round < 6; round++) {
      months = CORE.monthlyUniverse(daily, CORE.HTF_START, Date.now());
      const need = [...new Set(months.flatMap(x => x.top).concat("BTCUSDT"))].filter(sym => !loaded.has(sym));
      if (!need.length) break;
      for (const sym of need) { try { log(`載入 ${sym}`); await loadCoin(sym); } catch (e) { delete daily[sym]; } }
    }
    eligible = CORE.eligibleFrom(months);
  } else {
    for (const c of poolList.slice(0, E.TOP_N)) { try { await loadCoin(c.sym); } catch (e) {} }
  }
  const curTop = months ? months[months.length - 1].top.filter(sym => loaded.has(sym)) : [...loaded.keys()];
  if (!loaded.has("BTCUSDT") || curTop.length < 3) throw new Error("可用幣種不足");
  const FW = CORE.forward(inst, eligible);
  const SYS = CORE.systemReport(FW.run, FW.I, CORE.FROZEN.strats, eligible);
  const Q = await CORE.qualitySuite(SYS, inst, async () => {}, {fee: E.FEE_BPS, slip: E.SLIP_BPS, nRand: 60});
  const realFor = rk => CORE.portfolio(FW.I, E.baseRisk(equity, rk), {strats: CORE.FROZEN.strats, maxOpenRisk: 6 * rk, maxCoinRisk: 3 * rk, eligible,
    real: {filters, autoMin: CFG.autoMin, maxAuto: E.MAX_AUTO_RISK}});
  const riskRows = CORE.TRIAL.risks.map(rk => { const run = realFor(rk); return {risk: rk, run, st: CORE.portfolioStats(run)}; });
  const recT = CORE.pickRisk(riskRows), recG = CORE.pickGrowth(riskRows);
  const trialOK = Q.grade === "高" && SYS.full.psr >= CORE.TRIAL.psrMin;
  const stopFW = ["fail", "fail_inconclusive"].includes(FW.status);
  const autoRec = FW.status === "pass" ? (recG || recT) : recT;
  const riskPct = CFG.risk === "auto" ? (autoRec ? autoRec.risk : 0.005) : CFG.risk / 100;
  const row = riskRows.find(r => Math.abs(r.risk - riskPct) < 1e-9) || (() => { const run = realFor(riskPct); return {risk: riskPct, run, st: CORE.portfolioStats(run)}; })();
  const ddStop = Math.min(0.5, Math.abs(row.st.mdd) * CORE.TRIAL.ddMult), dd = CORE.ddSince(row.run, CORE.FREEZE), stopDD = dd.max <= -ddStop;
  const mode = stopFW || stopDD ? "stop" : FW.status === "pass" ? "proven" : trialOK ? "trial" : "paper";
  const dctx = CORE.dimContext(inst);
  return {FW, SYS, Q, mode, riskPct, ddStop, dd, curTop, filters, dctx, provider: p, viaFapi};
}

/* 依網頁下單卡相同規則產生訂單計畫（只取剛收盤那根 K 的新訊號） */
function plans(A, closeT, equity, prices) {          // bars.time 是收盤時間
  const openMap = new Map(A.FW.run.open.map(o => [o.sym + "|" + o.tf + "|" + o.strat, o]));
  const cur = new Set(A.curTop), out = [];
  for (const x of A.FW.I) {
    if (!cur.has(x.sym)) continue;
    const n = x.bars.time.length;
    if (x.bars.time[n - 1] !== closeT) continue;                            // 最後一根必須正是剛收盤那根
    for (const [name, st] of Object.entries(CORE.FROZEN.strats)) {
      if (openMap.has(x.sym + "|" + x.tf + "|" + name)) continue;            // 模擬中這個策略已持倉
      const side = x.P.sig[name][n - 1]; if (!side) continue;
      const price = prices[x.sym], u = x.P.unit[n - 1];
      if (!(price > 0) || !(u > 0)) continue;
      const drift = Math.abs(price - x.bars.close[n - 1]) / u;
      const F = A.filters[x.sym] || {step: 0.001, min: 5};
      const R = {...E.baseRisk(equity, A.riskPct), qty_step: F.step, min_notional: F.min};
      const dist = st.stop_atr * u, perUnit = dist + 2 * (E.FEE_BPS + E.SLIP_BPS) / 1e4 * price;
      let [qty, notional, rk] = CORE.sizeOrder(equity, price, dist, R), auto = false;
      const minQty = Math.ceil(F.min / price / F.step - 1e-9) * F.step;
      if (qty <= 0 && CFG.autoMin && minQty * perUnit / equity <= E.MAX_AUTO_RISK + 1e-12 && minQty * price <= equity * R.max_eff_lev) { qty = minQty; notional = qty * price; rk = qty * perUnit; auto = true; }
      out.push({sym: x.sym, tf: x.tf, strat: name, st, side, price, u, dist, drift, qty, notional, risk: rk, actRisk: rk / equity, auto,
        lev: E.suggestLeverage(notional, equity, dist / price, R.mmr), flags: CORE.dimFlags(A.dctx, x.sym, x.tf, n - 1, side)});
    }
  }
  return out;
}

/* ── 開倉：市價單＋止損＋止盈（各自為 reduceOnly，數量＝這一筆） ── */
async function openTrade(S, pl, barT, F) {
  const id = cid(pl.sym, pl.strat, barT);
  if (S.trades.some(t => t.id === id) || (S.closed || []).some(t => t.id === id)) return null;   // 同一根 K 的同一訊號只做一次
  try { await api("POST", "/fapi/v1/marginType", {symbol: pl.sym, marginType: "ISOLATED"}); }
  catch (e) { if (![-4046, -4048].includes(e.code)) throw e; }          // -4046 本來就是逐倉；-4048 已有倉位（沿用原設定）
  try { await api("POST", "/fapi/v1/leverage", {symbol: pl.sym, leverage: pl.lev}); }
  catch (e) { if (!(S.trades.some(t => t.sym === pl.sym))) throw e; }   // 已有倉位時沿用原槓桿
  const qtyS = pl.qty.toFixed(dec(F.step));
  S.pending = {id, pl, barT}; saveState(S);                            // 先記下，萬一中途當掉，下次可接手
  let o;
  try { o = await api("GET", "/fapi/v1/order", {symbol: pl.sym, origClientOrderId: id}); }   // 上次執行到一半？先查
  catch (e) { o = null; }
  if (!o) o = await api("POST", "/fapi/v1/order", {symbol: pl.sym, side: pl.side > 0 ? "BUY" : "SELL", type: "MARKET", quantity: qtyS,
    newClientOrderId: id, newOrderRespType: "RESULT"});
  return afterFill(S, pl, barT, F, id, o);
}
async function afterFill(S, pl, barT, F, id, o) {
  const qty = +o.executedQty, fill = +o.avgPrice;
  if (!(qty > 0 && fill > 0)) { delete S.pending; saveState(S); throw new Error(`市價單未成交（狀態 ${o.status}）`); }
  const t = {id, sym: pl.sym, strat: pl.strat, side: pl.side, qty, qtyS: o.executedQty, entry: fill, t0: Date.now(), barT,
    sl: roundTo(fill - pl.side * pl.dist, F.tick), tp: pl.st.tp_atr ? roundTo(fill + pl.side * pl.st.tp_atr * pl.u, F.tick) : null,
    deadline: Date.now() + pl.st.hold_h * 3600000, riskUsd: qty * (pl.dist + 2 * (E.FEE_BPS + E.SLIP_BPS) / 1e4 * fill), lev: pl.lev};
  t.slS = t.sl.toFixed(dec(F.tick)); t.tpS = t.tp === null ? null : t.tp.toFixed(dec(F.tick));
  S.trades.push(t); delete S.pending; S.touched = [...new Set([...(S.touched || []), t.sym])]; saveState(S);
  try { await placeProtect(t, "sl"); }
  catch (e) {
    t.slN = 1;
    try { await placeProtect(t, "sl"); }
    catch (e2) {
      const r = await marketClose(t, t.qtyS).catch(e3 => { notify("⚠ 止損掛不上且平倉失敗", `${t.sym}：${e3.message}。請立刻手動平倉。`, true); return null; });
      if (r) closeTrade(S, t, "止損掛不上，已立即平倉", +r.avgPrice || NaN);
      return null;
    }
  }
  saveState(S);
  if (t.tpS !== null) { try { await placeProtect(t, "tp"); } catch (e) { log(`止盈掛單失敗，下次執行補掛：${e.message}`); } }
  saveState(S);
  return t;
}

/* ── 主流程 ── */
async function main() {
  CFG = loadCfg(); BASE = BASES[CFG.mode] || BASES.live;
  if (CFG.baseUrl) BASE = CFG.baseUrl;                                  // 測試用
  const S = loadState(), now = Date.now();
  const trade = CFG.mode !== "notify";
  let eq = CFG.equity;
  if (trade) {
    /* 換了模式或金鑰（例如模擬交易→實盤）：舊帳戶的持倉紀錄與淨值不適用，封存後重新起算 */
    const tag = CFG.mode + ":" + crypto.createHash("sha1").update(CFG.apiKey).digest("hex").slice(0, 12);
    if (S.acct && S.acct !== tag) {
      const arc = path.join(DIR, `state-${S.acct.split(":")[0]}-${Date.now()}.json`);
      fs.renameSync(STATE_FILE, arc);
      log(`帳戶已切換（${S.acct.split(":")[0]} → ${CFG.mode}），舊紀錄封存為 ${path.basename(arc)}`);
      for (const k of Object.keys(S)) delete S[k];
      Object.assign(S, {trades: [], closed: [], lastBar: 0, day: null});
    }
    S.acct = tag;
    await syncTime();
    const dual = await api("GET", "/fapi/v1/positionSide/dual");
    if (dual.dualSidePosition) { notify("⚠ 需改成單向持倉", "App 合約設定 → 持倉模式改為「單向持倉」後才會下單。", true); return; }
    if (S.pending) {                                                      // 上次開倉到一半中斷
      const {id, pl, barT: b} = S.pending;
      let o = null; try { o = await api("GET", "/fapi/v1/order", {symbol: pl.sym, origClientOrderId: id}); } catch (e) {}
      if (o && +o.executedQty > 0) { log(`接手中斷的開倉 ${pl.sym}`); await afterFill(S, pl, b, (await tradeFilters())[pl.sym], id, o); }
      else { delete S.pending; saveState(S); }
    }
    await reconcile(S);
    const acct = await account();
    eq = CFG.equity > 0 ? Math.min(CFG.equity, acct.equity) : acct.equity;   // 資金設 0＝跟著帳戶
    const N = await updateNav(S, acct.equity, now);
    const day = Math.floor(now / D1);
    if (!S.day || S.day.d !== day || S.day.idx === undefined) S.day = {d: day, idx: N.index};
    S.lastEq = acct.equity; saveState(S);
  }
  /* 只在 4 小時收盤後的 30 分鐘內分析與開倉 */
  const barT = Math.floor(now / H4) * H4 - H4, closeT = barT + H4;
  if (S.lastBar >= barT) return;
  if (now - closeT < MIN_AFTER_CLOSE) return;
  if (now - closeT > ENTRY_WINDOW) { S.lastBar = barT; saveState(S); log(`已超過收盤後 30 分鐘（${tpe(closeT)} 收盤），這根略過`); return; }
  log(`分析 ${tpe(closeT)} 收盤（${CFG.mode}，資金 ${eq.toFixed(2)}U）`);
  const A = await analyze(eq);
  const prices = {};
  await E.pool(A.curTop.map(sym => async () => {
    try { prices[sym] = trade ? +(await api("GET", "/fapi/v1/ticker/price", {symbol: sym}, false)).price : await A.provider.price(sym); } catch (e) {}
  }), 4, 0);
  const all = plans(A, closeT, eq, prices);
  const MODE_ZH = {stop: "停用", proven: "已驗證", trial: "試行", paper: "暫不下實單"}[A.mode];
  S.lastBar = barT; S.lastMode = A.mode; S.lastRisk = A.riskPct; saveState(S);
  log(`狀態：${MODE_ZH}；每筆風險 ${(A.riskPct * 100).toFixed(2)}%；前向 ${A.FW.n} 筆（${A.FW.status}）；新訊號 ${all.length} 個`);
  if (!all.length) return;

  /* 不開新倉的情況 */
  const blocks = [];
  if (A.mode === "stop") blocks.push("系統已停用（見網頁最上方）");
  if (A.mode === "paper") blocks.push("不符試行資格");
  if (trade && S.nav && S.nav.index <= S.nav.peak * (1 - A.ddStop)) blocks.push(`實際帳戶（扣除入出金）從高點回落達 ${(A.ddStop * 100).toFixed(0)}%`);
  if (trade && S.nav && S.day && S.nav.index <= S.day.idx * (1 - 0.03)) blocks.push("今日交易虧損已達 3%");

  /* 風險上限：沿用網頁規則，並把已開的實際倉位算進去 */
  const cap = 6 * A.riskPct, coinCap = 3 * A.riskPct;
  let used = (S.trades || []).reduce((s, t) => s + t.riskUsd / eq, 0);
  const usedCoin = {}; for (const t of S.trades || []) usedCoin[t.sym] = (usedCoin[t.sym] || 0) + t.riskUsd / eq;
  const lines = [];
  const pos = trade ? await positions() : {};
  const F = trade ? await tradeFilters() : {};
  for (const pl of all) {
    const tag = `${E.coin(pl.sym)} ${pl.side > 0 ? "做多" : "做空"}（${CORE.FROZEN.strats[pl.strat].zh}）`;
    let why = blocks[0] || null;
    if (!why && Date.now() - closeT > ENTRY_WINDOW) why = "分析耗時超過收盤後 30 分鐘";
    if (!why && S.trades.some(t => t.sym === pl.sym && t.strat === pl.strat)) why = "同幣同策略已有持倉";
    if (!why && pl.drift > E.DRIFT_UNIT) why = `價格已偏離 ${pl.drift.toFixed(2)} 單位`;
    if (!why && pl.qty <= 0) why = "資金不足以下最小量";
    if (!why && (used + pl.actRisk > cap + 1e-9 || (usedCoin[pl.sym] || 0) + pl.actRisk > coinCap + 1e-9)) why = "超過風險上限";
    if (!why && trade && pos[pl.sym] && Math.sign(pos[pl.sym]) !== pl.side) why = "同幣已有反向倉位（單向持倉無法同時多空）";
    if (!why && trade && !F[pl.sym]) why = "交易端沒有這個合約";
    if (why) { lines.push(`略過 ${tag}：${why}`); continue; }
    if (!trade) {
      const tp = pl.st.tp_atr ? pl.price + pl.side * pl.st.tp_atr * pl.u : null, d = pl.price < 10 ? 4 : 2;
      const gain = tp ? pl.qty * (pl.st.tp_atr * pl.u - (E.FEE_BPS + E.SLIP_BPS + MAKER_BPS) / 1e4 * pl.price) : null;
      lines.push(`${tag} ${E.qtyFmt(pl.qty, (A.filters[pl.sym] || {step: 0.001}).step)} ${E.coin(pl.sym)}、逐倉 ${pl.lev}x、止損 ${(pl.price - pl.side * pl.dist).toFixed(d)}（虧約 ${pl.risk.toFixed(2)}U）${tp ? `、止盈 ${tp.toFixed(d)}（賺約 ${gain.toFixed(2)}U）` : ""}`);
      used += pl.actRisk; usedCoin[pl.sym] = (usedCoin[pl.sym] || 0) + pl.actRisk;
      continue;
    }
    const q = roundTo(pl.qty, F[pl.sym].step, "floor");
    if (!(q > 0) || q * pl.price < (F[pl.sym].min || 0)) { lines.push(`略過 ${tag}：數量低於交易端最小量`); continue; }
    try {
      const t = await openTrade(S, {...pl, qty: q}, barT, F[pl.sym]);
      if (t) {
        used += t.riskUsd / eq; usedCoin[pl.sym] = (usedCoin[pl.sym] || 0) + t.riskUsd / eq; pos[pl.sym] = (pos[pl.sym] || 0) + t.side * t.qty;
        const gain = t.tp === null ? null : t.qty * (Math.abs(t.tp - t.entry) - (E.FEE_BPS + E.SLIP_BPS + MAKER_BPS) / 1e4 * t.entry);
        lines.push(`已開 ${tag} ${t.qtyS} @ ${t.entry.toFixed(dec(F[pl.sym].tick))}，止損 ${t.slS}（虧約 ${t.riskUsd.toFixed(2)}U）${t.tpS ? `、止盈 ${t.tpS}（賺約 ${gain.toFixed(2)}U）` : ""}`);
      }
    } catch (e) { lines.push(`開倉失敗 ${tag}：${e.message}`); }
  }
  const title = trade ? `BTC 組合：${lines.filter(l => l.startsWith("已開")).length} 筆已下單` : `新訊號 ${lines.filter(l => !l.startsWith("略過")).length} 筆（${MODE_ZH}）`;
  notify(title, lines.join("\n"), lines.some(l => l.startsWith("開倉失敗")));
}

/* ── 指令 ── */
async function status() {
  CFG = loadCfg(); BASE = CFG.baseUrl || BASES[CFG.mode] || BASES.live;
  const S = loadState();
  console.log(`模式 ${CFG.mode}｜上次分析 ${S.lastBar ? tpe(S.lastBar + H4) + " 收盤" : "—"}｜狀態 ${S.lastMode || "—"}｜每筆風險 ${S.lastRisk ? (S.lastRisk * 100).toFixed(2) + "%" : "—"}`);
  if (S.nav) console.log(`交易淨值指數 ${S.nav.index.toFixed(4)}（高點 ${S.nav.peak.toFixed(4)}，回落 ${((S.nav.index / S.nav.peak - 1) * 100).toFixed(1)}%；已排除入出金）`);
  console.log(`持倉中 ${S.trades.length} 筆：`);
  for (const t of S.trades) console.log(`  ${t.sym} ${t.side > 0 ? "多" : "空"} ${t.qtyS} @ ${t.entry}｜止損 ${t.slS}｜止盈 ${t.tpS ?? "—"}｜到期 ${tpe(t.deadline)}`);
  const R = (S.closed || []).map(t => t.R).filter(Number.isFinite);
  console.log(`已結束 ${S.closed ? S.closed.length : 0} 筆${R.length ? `，平均 ${(R.reduce((a, b) => a + b, 0) / R.length).toFixed(2)}R` : ""}`);
}

let LOCK = path.join(DIR, ".lock");
async function run() {
  const cmd = process.argv[2] || "run";
  if (cmd === "status") return status();
  if (cmd === "warmup") {                                               // 第一次安裝：先把 7 年歷史下載到快取
    CFG = loadCfg(); E.setProg(s => process.stdout.write("\r" + s.slice(0, 60).padEnd(60)));
    const A = await analyze(CFG.equity || 500);
    console.log(`\n完成：本月名單 ${A.curTop.map(E.coin).join("、")}；狀態 ${A.mode}；每筆風險 ${(A.riskPct * 100).toFixed(2)}%；前向 ${A.FW.n} 筆`);
    return;
  }
  if (cmd === "keygen") {                                               // 產生 Ed25519 金鑰：公鑰貼到 Binance，私鑰留在手機
    const f = path.join(DIR, "private.pem");
    if (fs.existsSync(f)) { console.log("private.pem 已存在，不覆蓋。"); }
    else {
      const {publicKey, privateKey} = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(f, privateKey.export({type: "pkcs8", format: "pem"}), {mode: 0o600});
      fs.writeFileSync(path.join(DIR, "public.pem"), publicKey.export({type: "spki", format: "pem"}));
    }
    console.log("把下面這段公鑰（含 BEGIN/END 兩行）貼到 Binance 建立 API 的「自行生成」欄位：\n");
    console.log(fs.readFileSync(path.join(DIR, "public.pem"), "utf8"));
    return;
  }
  if (cmd === "check") {                                                // 雲端主機：確認這台機器連得到 Binance（美國等地區會被擋）
    const urls = [["合約行情", "https://fapi.binance.com/fapi/v1/time"], ["現貨行情", "https://api.binance.com/api/v3/time"], ["模擬交易", "https://demo-fapi.binance.com/fapi/v1/time"]];
    let bad = 0;
    for (const [name, u] of urls) {
      try {
        const r = await fetch(u, {signal: AbortSignal.timeout(15000)});
        const okk = r.ok; if (!okk && name !== "模擬交易") bad++;
        console.log(`${okk ? "✔" : "✘"} ${name}：HTTP ${r.status}${r.status === 451 || r.status === 403 ? "（此地區被 Binance 封鎖）" : ""}`);
      } catch (e) { if (name !== "模擬交易") bad++; console.log(`✘ ${name}：${e.message}`); }
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (cmd === "test-notify") { notify("BTC 組合 通知測試", "看到這則就代表通知正常。"); return; }
  try { const st = fs.statSync(LOCK); if (Date.now() - st.mtimeMs < 40 * 60000) { log("上一次還在執行，略過"); return; } fs.unlinkSync(LOCK); } catch (e) {}
  fs.writeFileSync(LOCK, String(process.pid));
  try { await main(); S_failN(0); }
  catch (e) {
    log("錯誤：" + (e.stack || e.message));
    const n = S_failN(1);
    if (n === 3 || n % 12 === 0) notify("⚠ 自動交易連續出錯", `${e.message}（已連續 ${n} 次）。已開的倉位止損仍掛在交易所。`, true);
  } finally { try { fs.unlinkSync(LOCK); } catch (e) {} }
}
function S_failN(add) { const S = loadState(); S.failN = add ? (S.failN || 0) + 1 : 0; saveState(S); return S.failN; }
if (require.main === module) run();
module.exports = {plans, roundTo, cid, main, reconcile, loadState};
