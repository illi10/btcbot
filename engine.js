/* 自動產生（build_bot.py），請勿手改：內容與網頁 index.html 的引擎完全相同 */
"use strict";

/* ═══════════════ 核心引擎（無 DOM，可在 Node 測試） ═══════════════ */
const EPS = 1e-12;
const CORE = {};
CORE.STRATS = {
  breakout: {name: "breakout", zh: "通道突破", desc: "4h 通道突破＋日線順勢＋波動擴張", stop_atr: 1.5, tp_atr: 3.0, hold_h: 8},
  meanrev:  {name: "meanrev",  zh: "均值回歸", desc: "低波動時偏離 VWAP 過大反向",   stop_atr: 1.5, tp_atr: 1.5, hold_h: 4},
  funding:  {name: "funding",  zh: "資金費率", desc: "資金費率極端＋動能轉向",       stop_atr: 2.0, tp_atr: 3.0, hold_h: 8},
};
CORE.defaultRisk = () => ({equity: 500, risk_pct: 0.01, max_eff_lev: 3.0, exch_lev: 5, mmr: 0.004,
  fee_bps: 5.0, slip_bps: 1.0, daily_loss_pct: 0.03, max_dd_pct: 0.20, min_notional: 100, qty_step: 0.001});

/* ── 數值工具 ── */
function rollStat(x, w, minp, kind) {               // kind: "std" | "sum" | "mean"
  const n = x.length, out = new Float64Array(n).fill(NaN);
  let s = 0, s2 = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) { s += v; s2 += v * v; c++; }
    if (i >= w) { const u = x[i - w]; if (Number.isFinite(u)) { s -= u; s2 -= u * u; c--; } }
    if (c >= minp && c > 0) {
      if (kind === "sum") out[i] = s;
      else if (kind === "mean") out[i] = s / c;
      else if (c > 1) { const m = s / c; out[i] = Math.sqrt(Math.max((s2 - c * m * m) / (c - 1), 0)); }
    }
  }
  return out;
}
function rollStdExact(x, w, minp) {                  // 兩段式計算，避免大數相減誤差（用於小數值序列）
  const n = x.length, out = new Float64Array(n).fill(NaN);
  const mean = rollStat(x, w, minp, "mean");
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(mean[i])) continue;
    let ss = 0, c = 0;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) { const v = x[k]; if (Number.isFinite(v)) { ss += (v - mean[i]) ** 2; c++; } }
    if (c > 1) out[i] = Math.sqrt(ss / (c - 1));
  }
  return out;
}
function rollExt(x, w, isMax) {                      // min_periods = w；單調佇列 O(n)，結果與逐窗計算完全相同
  const n = x.length, out = new Float64Array(n).fill(NaN), dq = new Int32Array(n);
  let head = 0, tail = 0, lastBad = -1;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { lastBad = i; head = tail = 0; continue; }
    while (tail > head && (isMax ? x[dq[tail - 1]] <= v : x[dq[tail - 1]] >= v)) tail--;
    dq[tail++] = i;
    while (dq[head] <= i - w) head++;
    if (i >= w - 1 && lastBad <= i - w) out[i] = x[dq[head]];
  }
  return out;
}
function rollStdRun(x, w, minp) {                    // 滑動視窗樣本標準差 O(n)，以視窗首值平移減少誤差
  const n = x.length, out = new Float64Array(n).fill(NaN);
  let s = 0, s2 = 0, c = 0, sh = NaN;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) { if (!Number.isFinite(sh)) sh = v; const d = v - sh; s += d; s2 += d * d; c++; }
    if (i >= w) { const u = x[i - w]; if (Number.isFinite(u)) { const d = u - sh; s -= d; s2 -= d * d; c--; } }
    if (c >= minp && c > 1) out[i] = Math.sqrt(Math.max((s2 - s * s / c) / (c - 1), 0));
  }
  return out;
}
function ewmAdjFalse(x, alpha, minp) {
  const n = x.length, out = new Float64Array(n).fill(NaN);
  let y = NaN, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) { y = Number.isFinite(y) ? (1 - alpha) * y + alpha * v : v; cnt++; }
    if (cnt >= minp) out[i] = y;
  }
  return out;
}
function normCdf(z) {                                // erfc 的 Chebyshev 近似（Numerical Recipes erfcc），相對誤差 < 1.2e-7
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - r / 2 : r / 2;
}
function normPpf(p) {                                // Acklam 演算法
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function sharpeStats(r) {
  const n = r.length;
  if (n < 3) return [0, 0, 3];
  const m = mean(r);
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  if (sd === 0) return [0, 0, 3];
  const m2 = r.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  const m3 = r.reduce((s, v) => s + (v - m) ** 3, 0) / n;
  const m4 = r.reduce((s, v) => s + (v - m) ** 4, 0) / n;
  return [m / sd, m3 / m2 ** 1.5, m4 / (m2 * m2)];
}
function psr(r, srStar) {
  const [sr, g3, g4] = sharpeStats(r);
  const den = Math.sqrt(Math.max(1 - g3 * sr + (g4 - 1) / 4 * sr * sr, EPS));
  return normCdf((sr - srStar) * Math.sqrt(Math.max(r.length - 1, 1)) / den);
}
function dsr(r, trials) {
  const N = trials.length;
  if (N < 2) return psr(r, 0);
  const m = mean(trials), v = trials.reduce((s, x) => s + (x - m) ** 2, 0) / (N - 1);
  const g = 0.5772156649;
  const sr0 = Math.sqrt(v) * ((1 - g) * normPpf(1 - 1 / N) + g * normPpf(1 - 1 / (N * Math.E)));
  return psr(r, sr0);
}
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function percentile(arr, p) {                        // numpy 線性內插
  const s = Float64Array.from(arr).sort(), k = (s.length - 1) * p / 100, f = Math.floor(k), c = Math.ceil(k);
  return f === c ? s[f] : s[f] + (s[c] - s[f]) * (k - f);
}
function median(arr) { return percentile(arr, 50); }
const dayKey = ms => Math.floor(ms / 86400000);

/* ── 資料組裝 ──
   bars: {time[] (K 棒收盤時刻 ms), open[], high[], low[], close[], volume[], quote_volume[]}
   funding: [{t: ms, rate}] 依時間排序 */
CORE.attachFunding = function (bars, funding) {
  const n = bars.time.length, fr = new Float64Array(n).fill(NaN), fz = new Float64Array(n).fill(NaN);
  const fsum = new Float64Array(n);
  bars.fundingSum = fsum;
  bars.fundingCover = 0;
  if (!funding || funding.length === 0) { bars.fundingRate = fr; bars.funding_z = fz; return; }
  // 每根 K 棒收取 (上一根收盤, 本根收盤] 之間所有資金費率結算的總和
  let e = 0;
  for (let i = 0; i < n; i++) {
    const hi = bars.time[i], lo = i > 0 ? bars.time[i - 1] : hi - (n > 1 ? bars.time[1] - bars.time[0] : 0);
    while (e < funding.length && funding[e].t <= lo) e++;
    let k = e;
    while (k < funding.length && funding[k].t <= hi) { fsum[i] += funding[k].rate; k++; }
  }
  const f0 = funding[0].t;
  bars.fundingCover = bars.time.filter(t => t >= f0).length / n;
  const rates = funding.map(f => f.rate);
  const m = rollStat(rates, 90, 10, "mean"), sd = rollStdExact(rates, 90, 10);
  const z = rates.map((r, i) => (r - m[i]) / (sd[i] + EPS));
  let k = -1;
  for (let i = 0; i < n; i++) {
    while (k + 1 < funding.length && funding[k + 1].t <= bars.time[i]) k++;
    if (k >= 0 && bars.time[i] - funding[k].t <= 9 * 3600000) { fr[i] = rates[k]; fz[i] = z[k]; }
  }
  bars.fundingRate = fr; bars.funding_z = fz;
};

CORE.features = function (bars, imin) {
  const S = Math.max(4, Math.floor(240 / imin)), L = Math.max(16, Math.floor(1440 / imin));
  const {open: o, high: h, low: l, close: c, volume: v, quote_volume: qv} = bars;
  const n = c.length;
  const lr = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i]) - Math.log(c[i - 1]);
  const rvS = rollStdExact(lr, S, Math.floor(S / 2)), rvL = rollStdExact(lr, L, Math.floor(L / 2));
  const f = {rv_ratio: new Float64Array(n), momS: new Float64Array(n).fill(NaN), momL: new Float64Array(n).fill(NaN)};
  for (let i = 0; i < n; i++) {
    f.rv_ratio[i] = Math.log((rvS[i] + EPS) / (rvL[i] + EPS));
    if (i >= S) f.momS[i] = Math.log(c[i] / c[i - S]) / (rvL[i] * Math.sqrt(S) + EPS);
    if (i >= L) f.momL[i] = Math.log(c[i] / c[i - L]) / (rvL[i] * Math.sqrt(L) + EPS);
  }
  const tr = new Float64Array(n);
  for (let i = 0; i < n; i++) tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  f.atr = ewmAdjFalse(tr, 1 / 14, 14);
  f.ema_d = ewmAdjFalse(c, 2 / (L + 1), L);
  const hs = new Float64Array(n).fill(NaN), ls = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) { hs[i] = h[i - 1]; ls[i] = l[i - 1]; }
  f.don_hi = rollExt(hs, S, true); f.don_lo = rollExt(ls, S, false);
  const sq = rollStat(qv, L, L, "sum"), sv = rollStat(v, L, L, "sum");
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.log(c[i] / (sq[i] / (sv[i] + EPS)));
  const dsd = rollStdExact(dev, 7 * L, L);
  f.dev_z = dev.map((x, i) => x / (dsd[i] + EPS));
  f.funding_z = bars.funding_z || new Float64Array(n).fill(NaN);
  f.S = S; f.L = L;
  return f;
};

CORE.signals = function (bars, f) {
  const n = bars.close.length, c = bars.close, sig = {};
  const br = new Int8Array(n), mr = new Int8Array(n), fu = new Int8Array(n);
  let fcnt = 0;
  for (let i = 0; i < n; i++) {
    const vol = f.rv_ratio[i] > 0;
    if (c[i] > f.don_hi[i] && c[i] > f.ema_d[i] && vol) br[i] = 1;
    else if (c[i] < f.don_lo[i] && c[i] < f.ema_d[i] && vol) br[i] = -1;
    const calm = f.rv_ratio[i] < 0 && Math.abs(f.momL[i]) < 1.5;
    if (calm && f.dev_z[i] < -2.2) mr[i] = 1; else if (calm && f.dev_z[i] > 2.2) mr[i] = -1;
    const fz = f.funding_z[i];
    if (Number.isFinite(fz)) fcnt++;
    if (fz < -2 && f.momS[i] > 0) fu[i] = 1; else if (fz > 2 && f.momS[i] < 0) fu[i] = -1;
  }
  sig.breakout = br; sig.meanrev = mr;
  if (fcnt / n > 0.5) sig.funding = fu;
  return sig;
};

/* ── 風控與模擬器（與 Python 版逐行對應） ── */
/* 安全槓桿：強平距離 ≥ 停損距離 × 2，最多 maxLev 倍 */
CORE.safeLev = (stopPct, maxLev = 5, mmr = 0.004) => { let lev = maxLev; while (lev > 1 && (1 / lev - mmr) < 2 * stopPct) lev--; return lev; };
CORE.liqPrice = (entry, side, lev, mmr) => side > 0 ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
CORE.sizeOrder = function (equity, entry, stopDist, R) {
  const cost = (R.fee_bps + R.slip_bps) / 1e4, riskAmt = equity * R.risk_pct, perUnit = stopDist + entry * cost * 2;
  let qty = Math.min(riskAmt / perUnit, equity * R.max_eff_lev / entry);
  qty = Math.floor(qty / R.qty_step + 1e-9) * R.qty_step;
  const notional = qty * entry;
  if (notional < R.min_notional || qty <= 0) return [0, 0, riskAmt];
  return [qty, notional, qty * perUnit];
};
CORE.simulate = function (bars, atr, sig, st, R, imin, start, useHalt) {
  const {open: o, high: h, low: l, close: c, time: t} = bars, n = c.length;
  const fund = bars.fundingSum || new Float64Array(n);
  const maxHold = Math.max(1, Math.round(st.hold_h * 60 / imin));
  const fee = R.fee_bps / 1e4, slip = R.slip_bps / 1e4;
  let eq = R.equity, peak = R.equity, day = null, dayEq = eq, locked = false, halted = false;
  const curve = new Float64Array(n).fill(NaN), trades = [];
  let pos = null;
  for (let j = start; j < n; j++) {
    const dk = dayKey(t[j]);
    if (dk !== day) { day = dk; dayEq = eq; locked = false; }
    if (pos) {
      const sd = pos.side; let px = null, why = null;
      if (sd > 0) {
        if (o[j] <= pos.liq) why = "liquidated";
        else if (o[j] <= pos.stop) { px = o[j]; why = "stop_gap"; }
        else if (l[j] <= pos.stop) { px = pos.stop; why = "stop"; }
        else if (h[j] >= pos.tp) { px = Math.max(o[j], pos.tp); why = "tp"; }
      } else {
        if (o[j] >= pos.liq) why = "liquidated";
        else if (o[j] >= pos.stop) { px = o[j]; why = "stop_gap"; }
        else if (h[j] >= pos.stop) { px = pos.stop; why = "stop"; }
        else if (l[j] <= pos.tp) { px = Math.min(o[j], pos.tp); why = "tp"; }
      }
      if (px === null && why !== "liquidated" && j - pos.j0 + 1 >= maxHold) { px = c[j]; why = "time"; }
      if (px === null && why !== "liquidated" && useHalt && halted === true) { px = c[j]; why = "kill"; }
      if (fund[j] !== 0 && (why === null || why === "time" || why === "kill")) pos.fund -= sd * pos.qty * c[j] * fund[j];
      if (why === "liquidated") {
        const pnl = -pos.margin - fee * pos.qty * pos.fill;
        trades.push({...pos, exit_j: j, exit: pos.liq, why, pnl}); eq += pnl; pos = null;
      } else if (px !== null) {
        const fill = px * (1 - sd * slip);
        const pnl = sd * pos.qty * (fill - pos.fill) - fee * pos.qty * (fill + pos.fill) + pos.fund;
        trades.push({...pos, exit_j: j, exit: fill, why, pnl}); eq += pnl; pos = null;
      }
      if (pos && st.trail) pos.stop = sd > 0 ? Math.max(pos.stop, c[j] - st.trail * pos.u0) : Math.min(pos.stop, c[j] + st.trail * pos.u0);
    }
    const mtm = eq + (pos ? pos.side * pos.qty * (c[j] - pos.fill) + pos.fund : 0);
    curve[j] = mtm; peak = Math.max(peak, mtm);
    if (mtm <= peak * (1 - R.max_dd_pct) && halted === false) halted = useHalt ? true : t[j];
    if (eq <= dayEq * (1 - R.daily_loss_pct)) locked = true;
    if (!pos && !(useHalt && halted) && !locked && j < n - 1 && sig[j] !== 0 && Number.isFinite(atr[j]) && atr[j] > 0) {
      const sd = sig[j], dist = st.stop_atr * atr[j];
      const [qty, , rk] = CORE.sizeOrder(eq, c[j], dist, R);
      if (qty > 0) {
        const fill = o[j + 1] * (1 + sd * slip);
        pos = {side: sd, j0: j + 1, sig_j: j, qty, fill, risk: rk, stop: fill - sd * dist, tp: st.tp_atr ? fill + sd * st.tp_atr * atr[j] : sd * Infinity,
               liq: CORE.liqPrice(fill, sd, R.exch_lev, R.mmr), margin: qty * fill / R.exch_lev, fund: 0, u0: atr[j]};
      }
    }
  }
  return {trades, curve, pos, halted};
};

CORE.evaluate = function (trades, curve, times, R) {
  if (!trades.length) return {n: 0};
  const Rm = trades.map(x => x.pnl / x.risk);
  const days = new Map();
  for (let i = 0; i < curve.length; i++) if (Number.isFinite(curve[i])) days.set(dayKey(times[i]), curve[i]);
  const dv = [...days.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const daily = [];
  for (let i = 1; i < dv.length; i++) daily.push(dv[i] / dv[i - 1] - 1);
  const rnd = mulberry32(12345), boots = [];
  for (let b = 0; b < 2000; b++) { let s = 0; for (let k = 0; k < Rm.length; k++) s += Rm[Math.floor(rnd() * Rm.length)]; boots.push(s / Rm.length); }
  const half = median(trades.map(x => x.j0));
  const h1 = Rm.filter((_, i) => trades[i].j0 <= half), h2 = Rm.filter((_, i) => trades[i].j0 > half);
  let gp = 0, gl = 0, streak = 0, mx = 0;
  trades.forEach(x => { if (x.pnl > 0) { gp += x.pnl; streak = 0; } else { gl -= x.pnl; streak++; mx = Math.max(mx, streak); } });
  let pk = -Infinity, mdd = 0;
  const eqs = Array.from(curve).filter(Number.isFinite);
  eqs.forEach(v => { pk = Math.max(pk, v); mdd = Math.min(mdd, v / pk - 1); });
  const why = {};
  trades.forEach(x => why[x.why] = (why[x.why] || 0) + 1);
  return {n: trades.length, win: trades.filter(x => x.pnl > 0).length / trades.length, avgR: mean(Rm),
    R_ci: [percentile(boots, 2.5), percentile(boots, 97.5)], pf: gl > 0 ? gp / gl : Infinity,
    ret: eqs[eqs.length - 1] / R.equity - 1, mdd, sr_d: daily.length > 3 ? sharpeStats(daily)[0] : 0, daily,
    R_h1: h1.length ? mean(h1) : NaN, R_h2: h2.length ? mean(h2) : NaN, maxloss_streak: mx,
    worst: Math.min(...Rm), liq: trades.filter(x => x.why === "liquidated").length, why,
    long_share: trades.filter(x => x.side > 0).length / trades.length};
};
CORE.tier = function (ev, d, minA = 100, minB = 30) {
  if (!ev.n) return "C";
  if (ev.n >= minA && d > 0.95 && ev.R_h1 > 0 && ev.R_h2 > 0 && ev.R_ci[0] > 0) return "A";
  if (ev.n >= minB && ev.avgR > 0 && ev.R_h1 > 0 && ev.R_h2 > 0) return "B";
  return "C";
};
CORE.backtest = function (bars, imin, R) {
  const f = CORE.features(bars, imin), sig = CORE.signals(bars, f);
  const warm = 7 * Math.max(16, Math.floor(1440 / imin)), res = {};
  for (const [name, st] of Object.entries(CORE.STRATS)) {
    if (!sig[name]) continue;
    const sim = CORE.simulate(bars, f.atr, sig[name], st, R, imin, warm, false);
    res[name] = CORE.evaluate(sim.trades, sim.curve, bars.time, R);
    res[name].halted = sim.halted;
  }
  const trials = Object.values(res).filter(e => e.n).map(e => e.sr_d);
  for (const ev of Object.values(res)) {
    ev.dsr = ev.n && ev.daily.length > 3 ? dsr(ev.daily, trials) : 0;
    ev.tier = CORE.tier(ev, ev.dsr);
    delete ev.daily;
  }
  return res;
};
/* ═══ 長週期（4 小時／日線）策略族：參數為經典設定，事前固定 ═══ */
CORE.STRATS_HTF = {
  trend:  {name: "trend",  zh: "通道突破", desc: "20 日通道突破＋50 日均線順勢（海龜系統）", stop_atr: 2.0, tp_atr: 6.0, hold_h: 480},
  tsmom:  {name: "tsmom",  zh: "時間動能", desc: "20 日與 60 日報酬同向就順勢",             stop_atr: 2.5, tp_atr: 5.0, hold_h: 240},
  macross:{name: "macross",zh: "均線交叉", desc: "10 日均線穿越 30 日均線",                  stop_atr: 2.0, tp_atr: 6.0, hold_h: 720},
};
CORE.HTF_START = Date.UTC(2019, 9, 1);   // Binance 合約資金費率起點
CORE.featuresHTF = function (bars, tfMin, scale = 1) {
  const bpd = 1440 / tfMin, c = bars.close, h = bars.high, l = bars.low, n = c.length;
  const D = d => Math.max(1, Math.round(d * scale)) * bpd;          // 天數 → K 棒數（scale 只用於參數穩定度檢驗）
  const lr = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) lr[i] = Math.log(c[i] / c[i - 1]);
  const sd = rollStdRun(lr, 20 * bpd, 10 * bpd);
  const f = {unit: new Float64Array(n), r20: new Float64Array(n).fill(NaN), r60: new Float64Array(n).fill(NaN)};
  for (let i = 0; i < n; i++) f.unit[i] = c[i] * sd[i] * Math.sqrt(bpd);           // 一個「日波動」的價格距離
  const hs = new Float64Array(n).fill(NaN), ls = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) { hs[i] = h[i - 1]; ls[i] = l[i - 1]; }
  f.hh = rollExt(hs, D(20), true); f.ll = rollExt(ls, D(20), false);
  f.ema50 = ewmAdjFalse(c, 2 / (D(50) + 1), D(50));
  f.ema10 = ewmAdjFalse(c, 2 / (D(10) + 1), D(10));
  f.ema30 = ewmAdjFalse(c, 2 / (D(30) + 1), D(30));
  const k20 = D(20), k60 = D(60);
  for (let i = 0; i < n; i++) {
    if (i >= k20) f.r20[i] = Math.log(c[i] / c[i - k20]);
    if (i >= k60) f.r60[i] = Math.log(c[i] / c[i - k60]);
  }
  f.warm = Math.max(60 * bpd, k60, D(50));
  return f;
};
CORE.signalsHTF = function (bars, f) {
  const c = bars.close, n = c.length, tr = new Int8Array(n), ts = new Int8Array(n), mc = new Int8Array(n);
  for (let i = 1; i < n; i++) {
    if (c[i] > f.hh[i] && c[i] > f.ema50[i]) tr[i] = 1; else if (c[i] < f.ll[i] && c[i] < f.ema50[i]) tr[i] = -1;
    if (f.r20[i] > 0 && f.r60[i] > 0) ts[i] = 1; else if (f.r20[i] < 0 && f.r60[i] < 0) ts[i] = -1;
    if (f.ema10[i] > f.ema30[i] && f.ema10[i - 1] <= f.ema30[i - 1]) mc[i] = 1;
    else if (f.ema10[i] < f.ema30[i] && f.ema10[i - 1] >= f.ema30[i - 1]) mc[i] = -1;
  }
  return {trend: tr, tsmom: ts, macross: mc};
};
/* 一個週期的完整準備：特徵、訊號、停損單位、暖機長度 */
CORE.prepare = function (bars, tfMin, scale = 1) {
  if (tfMin === 15) {
    const f = CORE.features(bars, 15);
    return {tf: 15, strats: CORE.STRATS, sig: CORE.signals(bars, f), unit: f.atr, warm: 7 * 96, f};
  }
  const f = CORE.featuresHTF(bars, tfMin, scale);
  return {tf: tfMin, strats: CORE.STRATS_HTF, sig: CORE.signalsHTF(bars, f), unit: f.unit, warm: f.warm, f};
};
/* 一族策略一起評等：DSR 的試驗次數＝這一族全部組合 */
CORE.backtestFamily = function (items, R, minA, minB) {
  const all = [];
  for (const {key, bars, tf} of items) {
    const P = CORE.prepare(bars, tf);
    for (const [name, st] of Object.entries(P.strats)) {
      if (!P.sig[name]) continue;
      const sim = CORE.simulate(bars, P.unit, P.sig[name], st, R, tf, P.warm, false);
      const ev = CORE.evaluate(sim.trades, sim.curve, bars.time, R);
      ev.halted = sim.halted; ev.key = key; ev.name = name;
      all.push(ev);
    }
  }
  const trials = all.filter(e => e.n).map(e => e.sr_d);
  const out = {};
  for (const ev of all) {
    ev.dsr = ev.n && ev.daily.length > 3 ? dsr(ev.daily, trials) : 0;
    ev.tier = CORE.tier(ev, ev.dsr, minA, minB);
    delete ev.daily;
    (out[ev.key] = out[ev.key] || {})[ev.name] = ev;
  }
  return out;
};
/* ═══ 多幣組合（事前登記的設計，見介面說明） ═══ */
CORE.STRATS_TRAIL = {
  trend:  {...CORE.STRATS_HTF.trend,  tp_atr: null, trail: 3.0, hold_h: 1440},
  tsmom:  {...CORE.STRATS_HTF.tsmom,  tp_atr: null, trail: 3.0, hold_h: 1440},
  macross:{...CORE.STRATS_HTF.macross,tp_atr: null, trail: 3.0, hold_h: 1440},
};
CORE.SPLIT_DATE = Date.UTC(2023, 0, 1);    // 移動停損的設計期／驗證期分界
/* inst: [{sym, tf, bars, P}]；opt: {strats, maxOpenRisk, maxCoinRisk(皆為占權益比例)}。出場邏輯與 CORE.simulate 逐行相同 */
/* opt.eligible(sym, t)：該時點該幣可否開新倉（逐月選幣）；opt.real = {filters, autoMin, maxAuto}：用交易所最小下單量與級距模擬實際下單 */
CORE.portfolio = function (inst, R, opt) {
  const strats = opt.strats, maxOpen = opt.maxOpenRisk, maxCoin = opt.maxCoinRisk || Infinity;
  const eligible = opt.eligible || (() => true), real = opt.real || null;
  const times = Float64Array.from(new Set(inst.flatMap(x => Array.from(x.bars.time)))).sort();
  const idx = inst.map(x => { const m = new Map(); x.bars.time.forEach((t, i) => m.set(t, i)); return m; });
  const slots = [];
  inst.forEach((x, a) => { for (const [name, st] of Object.entries(strats)) if (x.P.sig[name]) slots.push({a, name, st, pos: null, maxHold: Math.max(1, Math.round(st.hold_h * 60 / (x.tf || 240)))}); });
  const last = inst.map(() => -1), fee = R.fee_bps / 1e4, slip = R.slip_bps / 1e4;
  let eq = R.equity, day = null, dayEq = eq, locked = false;
  const curve = new Float64Array(times.length), trades = [], skipped = {risk: 0, lev: 0, size: 0};
  let maxOpenSeen = 0, maxCoinSeen = 0;
  for (let k = 0; k < times.length; k++) {
    const t = times[k], dk = dayKey(t);
    if (dk !== day) { day = dk; dayEq = eq; locked = false; }
    inst.forEach((x, a) => { const j = idx[a].get(t); if (j !== undefined) last[a] = j; });
    for (const sl of slots) {
      const pos = sl.pos; if (!pos) continue;
      const j = idx[sl.a].get(t); if (j === undefined) continue;
      const b = inst[sl.a].bars, o = b.open[j], h = b.high[j], l = b.low[j], c = b.close[j], sd = pos.side;
      let px = null, why = null;
      if (sd > 0) {
        if (o <= pos.liq) why = "liquidated"; else if (o <= pos.stop) { px = o; why = "stop_gap"; }
        else if (l <= pos.stop) { px = pos.stop; why = "stop"; } else if (h >= pos.tp) { px = Math.max(o, pos.tp); why = "tp"; }
      } else {
        if (o >= pos.liq) why = "liquidated"; else if (o >= pos.stop) { px = o; why = "stop_gap"; }
        else if (h >= pos.stop) { px = pos.stop; why = "stop"; } else if (l <= pos.tp) { px = Math.min(o, pos.tp); why = "tp"; }
      }
      if (px === null && why !== "liquidated" && j - pos.j0 + 1 >= sl.maxHold) { px = c; why = "time"; }
      const fs = b.fundingSum ? b.fundingSum[j] : 0;
      if (fs !== 0 && (why === null || why === "time")) pos.fund -= sd * pos.qty * c * fs;
      if (why === "liquidated") {
        const pnl = -pos.margin - fee * pos.qty * pos.fill;
        trades.push({...pos, sym: inst[sl.a].sym, tf: inst[sl.a].tf || 240, strat: sl.name, exit_j: j, exit_t: t, why, pnl}); eq += pnl; sl.pos = null;
      } else if (px !== null) {
        const fill = px * (1 - sd * slip);
        const pnl = sd * pos.qty * (fill - pos.fill) - fee * pos.qty * (fill + pos.fill) + pos.fund;
        trades.push({...pos, sym: inst[sl.a].sym, tf: inst[sl.a].tf || 240, strat: sl.name, exit_j: j, exit_t: t, why, pnl}); eq += pnl; sl.pos = null;
      } else if (sl.st.trail) pos.stop = sd > 0 ? Math.max(pos.stop, c - sl.st.trail * pos.u0) : Math.min(pos.stop, c + sl.st.trail * pos.u0);
    }
    let mtm = eq, openRisk = 0, openNot = 0;
    const coinRisk = {};
    for (const sl of slots) if (sl.pos) {
      const b = inst[sl.a].bars, c = b.close[last[sl.a]], sym = inst[sl.a].sym;
      mtm += sl.pos.side * sl.pos.qty * (c - sl.pos.fill) + sl.pos.fund; openRisk += sl.pos.risk; openNot += sl.pos.qty * c;
      coinRisk[sym] = (coinRisk[sym] || 0) + sl.pos.risk;
    }
    curve[k] = mtm;
    if (eq <= dayEq * (1 - R.daily_loss_pct)) locked = true;
    if (locked) continue;
    for (const sl of slots) {
      if (sl.pos) continue;
      const x = inst[sl.a], j = idx[sl.a].get(t);
      if (j === undefined || j < x.P.warm || j >= x.bars.time.length - 1) continue;
      const s = x.P.sig[sl.name][j], u = x.P.unit[j];
      if (s === 0 || !(Number.isFinite(u) && u > 0)) continue;
      if (!eligible(x.sym, x.bars.time[j])) { skipped.universe = (skipped.universe || 0) + 1; continue; }
      const c = x.bars.close[j], dist = sl.st.stop_atr * u;
      let qty, notional, rk;
      if (real) {
        const F = real.filters[x.sym] || {step: 0.001, min: 5};
        [qty, notional, rk] = CORE.sizeOrder(eq, c, dist, {...R, qty_step: F.step, min_notional: F.min});
        if (qty <= 0 && real.autoMin) {
          const perUnit = dist + 2 * (R.fee_bps + R.slip_bps) / 1e4 * c, mq = Math.ceil(F.min / c / F.step - 1e-9) * F.step;
          if (mq * perUnit / eq <= real.maxAuto + 1e-12 && mq * c <= eq * R.max_eff_lev) { qty = mq; notional = mq * c; rk = mq * perUnit; }
        }
      } else [qty, notional, rk] = CORE.sizeOrder(eq, c, dist, R);
      if (qty <= 0) { skipped.size++; continue; }
      if (openRisk + rk > maxOpen * eq + 1e-9) { skipped.risk++; continue; }
      if ((coinRisk[x.sym] || 0) + rk > maxCoin * eq + 1e-9) { skipped.coin = (skipped.coin || 0) + 1; continue; }
      if (openNot + notional > R.max_eff_lev * eq + 1e-9) { skipped.lev++; continue; }
      const fill = x.bars.open[j + 1] * (1 + s * slip), lev = CORE.safeLev(dist / c, R.exch_lev, R.mmr);
      sl.pos = {side: s, j0: j + 1, sig_j: j, t0: x.bars.time[j], qty, fill, risk: rk, stop: fill - s * dist,
        tp: sl.st.tp_atr ? fill + s * sl.st.tp_atr * u : s * Infinity, liq: CORE.liqPrice(fill, s, lev, R.mmr),
        margin: qty * fill / lev, fund: 0, u0: u, lev};
      openRisk += rk; openNot += notional; coinRisk[x.sym] = (coinRisk[x.sym] || 0) + rk;
      maxOpenSeen = Math.max(maxOpenSeen, openRisk / eq);
      maxCoinSeen = Math.max(maxCoinSeen, coinRisk[x.sym] / eq);
    }
  }
  const open = slots.filter(sl => sl.pos).map(sl => ({sym: inst[sl.a].sym, tf: inst[sl.a].tf || 240, strat: sl.name, ...sl.pos}));
  return {times, curve, trades, skipped, open, maxOpenSeen, maxCoinSeen};
};
/* 組合統計：年化、回撤、Sharpe、PSR、前後半段、逐年、區塊 bootstrap 的年化信賴區間 */
CORE.portfolioStats = function (res, R, from = -Infinity, to = Infinity) {
  const d = new Map();
  for (let k = 0; k < res.times.length; k++) if (res.times[k] >= from && res.times[k] < to) d.set(dayKey(res.times[k]), res.curve[k]);
  const days = [...d.keys()].sort((a, b) => a - b), eqs = days.map(k => d.get(k));
  if (eqs.length < 30) return null;
  const rets = []; for (let i = 1; i < eqs.length; i++) rets.push(eqs[i] / eqs[i - 1] - 1);
  const yrs = (days[days.length - 1] - days[0]) / 365.25;
  const cagr = Math.pow(eqs[eqs.length - 1] / eqs[0], 1 / yrs) - 1;
  let pk = -Infinity, mdd = 0; eqs.forEach(v => { pk = Math.max(pk, v); mdd = Math.min(mdd, v / pk - 1); });
  const [sr] = sharpeStats(rets);
  /* 區塊抽樣 1000 條 7 年路徑（固定種子：不同風險級距抽到同樣的日期區塊，可直接比較）；同時記錄每條路徑的最大回撤 */
  const rnd = mulberry32(99), B = 20, boot = [], bootDD = [];
  for (let b = 0; b < 1000; b++) {
    let lg = 0, n = 0, pk = 0, dd = 0;
    while (n < rets.length) {
      const st = Math.floor(rnd() * (rets.length - B));
      for (let q = 0; q < B && n < rets.length; q++, n++) { lg += Math.log(Math.max(1 + rets[st + q], 1e-9)); if (lg > pk) pk = lg; else if (lg - pk < dd) dd = lg - pk; }
    }
    boot.push(Math.exp(lg / yrs) - 1); bootDD.push(Math.exp(dd) - 1);
  }
  const yearly = {};
  days.forEach((k, i) => { const y = new Date(k * 86400000).getUTCFullYear(); (yearly[y] = yearly[y] || [eqs[i], eqs[i]])[1] = eqs[i]; });
  Object.keys(yearly).forEach(y => yearly[y] = yearly[y][1] / yearly[y][0] - 1);
  const pT = boot.filter(v => v >= CORE.TARGET).length / boot.length, p0 = boot.filter(v => v < 0).length / boot.length;
  const pHalf = bootDD.filter(v => v <= -0.5).length / bootDD.length;
  return {cagr, mdd, sharpe: sr * Math.sqrt(365), psr: psr(rets, 0), ci: [percentile(boot, 2.5), percentile(boot, 97.5)], pT, p0,
    q25: percentile(boot, 25), q50: percentile(boot, 50), pHalf, ddMed: percentile(bootDD, 50), yearly, yrs, start: days[0] * 86400000};
};
CORE.slotStats = function (trades, splitT) {
  const by = {};
  trades.forEach(x => { const k = x.sym + "|" + (x.tf || 240) + "|" + x.strat; (by[k] = by[k] || []).push(x); });
  const f = arr => {
    const Rm = arr.map(x => x.pnl / x.risk);
    if (!Rm.length) return {n: 0};
    const rnd = mulberry32(5), b = [];
    for (let q = 0; q < 2000; q++) { let s = 0; for (let w = 0; w < Rm.length; w++) s += Rm[Math.floor(rnd() * Rm.length)]; b.push(s / Rm.length); }
    const h1 = arr.filter(x => x.t0 < splitT).map(x => x.pnl / x.risk), h2 = arr.filter(x => x.t0 >= splitT).map(x => x.pnl / x.risk);
    return {n: Rm.length, avgR: mean(Rm), ci: [percentile(b, 2.5), percentile(b, 97.5)], win: Rm.filter(r => r > 0).length / Rm.length,
      h1: h1.length ? mean(h1) : NaN, h2: h2.length ? mean(h2) : NaN};
  };
  const out = {};
  for (const [k, arr] of Object.entries(by)) out[k] = f(arr);
  out.__f = f;
  return out;
};
/* ═══ 逐月選幣（事前固定）：每月 1 號 UTC，用「前 90 個完整日」的合約日成交額中位數排名，
   需有 90 天完整資料才參與；取前 N 名，當月只有這些幣可開新倉 ═══ */
CORE.UNIV = {window: 90, top: 10};
const monthStart = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
/* daily: {sym: {t: 日開盤時間陣列(ms, 遞增), qv: 日成交額陣列}} → [{m: 月初 ms, top: [sym...], vals: {sym: 中位數}}] */
CORE.monthlyUniverse = function (daily, from, to, top = CORE.UNIV.top, win = CORE.UNIV.window) {
  const out = [], D = 86400000;
  for (let m = monthStart(from); m <= to; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) {
    const lo = m - win * D, vals = {};
    for (const [sym, d] of Object.entries(daily)) {
      const xs = [];
      for (let i = 0; i < d.t.length; i++) if (d.t[i] >= lo && d.t[i] < m && Number.isFinite(d.qv[i])) xs.push(d.qv[i]);   // 只用月初以前的資料
      if (xs.length >= win) vals[sym] = median(xs);
    }
    const ranked = Object.keys(vals).sort((a, b) => vals[b] - vals[a]);
    out.push({m, top: ranked.slice(0, top), vals});
  }
  return out;
};
CORE.eligibleFrom = function (months) {
  const map = new Map(months.map(x => [x.m, new Set(x.top)]));
  return (sym, t) => { const s = map.get(monthStart(t)); return !!s && s.has(sym); };
};

/* 事前登記的研究流程：所有門檻寫死在這裡，不依結果調整 */
CORE.PSR_MIN = 1 - 0.05 / 4;   // 從 4 個版本（固定/移動停損 × 只用 4 小時/三週期）中挑選，Bonferroni 校正
CORE.researchPortfolio = function (inst, baseR, eligible) {
  const run = (I, strats, risk) => CORE.portfolio(I, {...baseR, equity: 10000, risk_pct: risk, qty_step: 1e-9, min_notional: 0}, {strats, maxOpenRisk: 6 * risk, maxCoinRisk: 3 * risk, eligible});
  const S = (r, a = -Infinity, b = Infinity) => CORE.portfolioStats(r, null, a, b);
  const base = 0.005;
  const evalSet = I => {
    const fx = run(I, CORE.STRATS_HTF, base), tr = run(I, CORE.STRATS_TRAIL, base);
    const cmp = {fixD: S(fx, -Infinity, CORE.SPLIT_DATE), fixV: S(fx, CORE.SPLIT_DATE), trD: S(tr, -Infinity, CORE.SPLIT_DATE), trV: S(tr, CORE.SPLIT_DATE)};
    const adopt = !!(cmp.fixD && cmp.fixV && cmp.trD && cmp.trV && cmp.trD.sharpe > cmp.fixD.sharpe && cmp.trV.sharpe > cmp.fixV.sharpe);
    return {I, adopt, cmp, strats: adopt ? CORE.STRATS_TRAIL : CORE.STRATS_HTF, main: adopt ? tr : fx};
  };
  const tfsAll = [...new Set(inst.map(x => x.tf || 240))].sort((a, b) => a - b);
  const set4 = evalSet(inst.filter(x => (x.tf || 240) === 240));
  const setAll = tfsAll.length > 1 ? evalSet(inst) : null;
  let useAll = false, tfCmp = null;
  if (setAll) {
    tfCmp = {d4: S(set4.main, -Infinity, CORE.SPLIT_DATE), v4: S(set4.main, CORE.SPLIT_DATE), dA: S(setAll.main, -Infinity, CORE.SPLIT_DATE), vA: S(setAll.main, CORE.SPLIT_DATE)};
    useAll = !!(tfCmp.d4 && tfCmp.v4 && tfCmp.dA && tfCmp.vA && tfCmp.dA.sharpe > tfCmp.d4.sharpe && tfCmp.vA.sharpe > tfCmp.v4.sharpe);
  }
  const C = useAll ? setAll : set4;
  return {...CORE.systemReport(C.main, C.I, C.strats, eligible), adopt: C.adopt, cmp: C.cmp, useAll, tfCmp, tfsAll};
};
/* 檢驗一個「指定的系統」：全期、前後半段、BTC 以外（樣本外）三項；研究挑出的版本與凍結系統都用同一套 */
CORE.systemReport = function (main, I, strats, eligible) {
  const S = (r, a = -Infinity, b = Infinity) => CORE.portfolioStats(r, null, a, b);
  const t0 = main.times[0], t1 = main.times[main.times.length - 1], mid = (t0 + t1) / 2;
  const full = S(main), h1 = S(main, -Infinity, mid), h2 = S(main, mid);
  const slots = CORE.slotStats(main.trades, mid);
  const nonBTC = slots.__f(main.trades.filter(x => x.sym !== "BTCUSDT")), btc = slots.__f(main.trades.filter(x => x.sym === "BTCUSDT"));
  const tfsUsed = [...new Set(I.map(x => x.tf || 240))].sort((a, b) => a - b), byTF = {};
  for (const tf of tfsUsed) byTF[tf] = slots.__f(main.trades.filter(x => (x.tf || 240) === tf));
  delete slots.__f;
  const checks = {psr: !!(full && full.psr > CORE.PSR_MIN), halves: !!(h1 && h2 && h1.cagr > 0 && h2.cagr > 0), oos: nonBTC.n >= 30 && nonBTC.ci[0] > 0};
  return {strats, main, inst: I, eligible, full, h1, h2, mid, slots, nonBTC, btc, byTF, checks, valid: checks.psr && checks.halves && checks.oos,
    tfsUsed, syms: [...new Set(I.map(x => x.sym))]};
};
/* ═══ 訊號品質檢驗：8 項交叉驗證，及格標準事前固定 ═══ */
CORE.bootMean = function (arr, reps = 2000, seed = 3, alpha = 0.05) {
  if (arr.length < 3) return [NaN, NaN];
  const rnd = mulberry32(seed), b = [];
  for (let q = 0; q < reps; q++) { let t = 0; for (let w = 0; w < arr.length; w++) t += arr[Math.floor(rnd() * arr.length)]; b.push(t / arr.length); }
  return [percentile(b, 100 * alpha / 2), percentile(b, 100 * (1 - alpha / 2))];
};
CORE.bootDiff = function (a, b, reps = 2000, seed = 4, alpha = 0.01) {   // 平均數差異的 bootstrap 信賴區間
  if (a.length < 10 || b.length < 10) return [NaN, NaN];
  const rnd = mulberry32(seed), d = [];
  for (let q = 0; q < reps; q++) {
    let x = 0, y = 0;
    for (let w = 0; w < a.length; w++) x += a[Math.floor(rnd() * a.length)];
    for (let w = 0; w < b.length; w++) y += b[Math.floor(rnd() * b.length)];
    d.push(x / a.length - y / b.length);
  }
  return [percentile(d, 100 * alpha / 2), percentile(d, 100 * (1 - alpha / 2))];
};
const lookupIdx = (times, t) => { let lo = 0, hi = times.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
CORE.qualitySuite = async function (RS, instAll, yieldFn = async () => {}, opts = {}) {
  const risk = 0.005, base = RS.inst, strats = RS.strats;
  const R0 = {...CORE.defaultRisk(), equity: 10000, risk_pct: risk, qty_step: 1e-9, min_notional: 0, fee_bps: opts.fee ?? 5, slip_bps: opts.slip ?? 1};
  const run = (I, st = strats, R = R0) => CORE.portfolio(I, R, {strats: st, maxOpenRisk: 6 * risk, maxCoinRisk: 3 * risk, eligible: RS.eligible});
  const S = r => CORE.portfolioStats(r);
  const mainS = S(RS.main), tests = [];
  const heavy = base.some(x => x.tf === 60);
  /* 1 隨機進場對照 */
  const nRand = opts.nRand ?? (heavy ? 30 : 80), rs = [];
  for (let k = 0; k < nRand; k++) {
    const rnd = mulberry32(1000 + k);
    const I = base.map(x => {
      const sig = {};
      for (const [name, arr] of Object.entries(x.P.sig)) {
        let nz = 0; for (let j = x.P.warm; j < arr.length; j++) if (arr[j] !== 0) nz++;
        const rate = nz / Math.max(1, arr.length - x.P.warm), r2 = new Int8Array(arr.length);
        for (let j = 0; j < arr.length; j++) if (rnd() < rate) r2[j] = rnd() < 0.5 ? 1 : -1;
        sig[name] = r2;
      }
      return {...x, P: {...x.P, sig}};
    });
    const st = S(run(I)); rs.push(st ? st.sharpe : -Infinity);
    if (k % 5 === 4) await yieldFn(`隨機進場對照 ${k + 1}/${nRand}`);
  }
  const beat = rs.filter(v => v >= mainS.sharpe).length / rs.length;
  tests.push({id: "random", name: "勝過隨機進場", pass: beat <= 0.05,
    detail: `策略 Sharpe ${mainS.sharpe.toFixed(2)}；${nRand} 次隨機進場（同樣停損與風控）有 ${(beat * 100).toFixed(0)}% 達到它，隨機中位數 ${percentile(rs, 50).toFixed(2)}`, need: "≤ 5%"});
  /* 2 參數鄰近穩定（天數 ×0.75/1/1.25，停損 ×0.75/1/1.25） */
  const grid = [];
  for (const sc of [0.75, 1, 1.25]) {
    const I = sc === 1 ? base : base.map(x => ({...x, P: CORE.prepare(x.bars, x.tf, sc)}));
    for (const k of [0.75, 1, 1.25]) {
      const st = {}; for (const [n2, v] of Object.entries(strats)) st[n2] = {...v, stop_atr: v.stop_atr * k};
      const a = S(run(I, st)); grid.push({sc, k, cagr: a ? a.cagr : NaN, sharpe: a ? a.sharpe : NaN});
      await yieldFn(`參數鄰近穩定 ${grid.length}/9`);
    }
  }
  const posN = grid.filter(g => g.cagr > 0).length;
  tests.push({id: "params", name: "參數鄰近穩定", pass: posN >= 7, grid,
    detail: `天數與停損各 ±25% 的 9 組中 ${posN} 組賺錢，年化 ${(Math.min(...grid.map(g => g.cagr)) * 100).toFixed(1)}%～${(Math.max(...grid.map(g => g.cagr)) * 100).toFixed(1)}%`, need: "≥ 7 組"});
  /* 3 成本加倍 */
  const cs = S(run(base, strats, {...R0, fee_bps: R0.fee_bps * 2, slip_bps: R0.slip_bps * 3}));
  tests.push({id: "cost", name: "成本加倍", pass: cs.cagr > 0, detail: `手續費 ${R0.fee_bps * 2}bp＋滑價 ${R0.slip_bps * 3}bp：年化 ${(cs.cagr * 100).toFixed(1)}%`, need: "> 0"});
  await yieldFn("成本加倍");
  /* 4 延遲一根進場 */
  const ds = S(run(base.map(x => { const sig = {}; for (const [n2, arr] of Object.entries(x.P.sig)) { const r2 = new Int8Array(arr.length); for (let j = 1; j < arr.length; j++) r2[j] = arr[j - 1]; sig[n2] = r2; } return {...x, P: {...x.P, sig}}; })));
  tests.push({id: "delay", name: "延遲一根進場", pass: ds.cagr > 0, keep: mainS.cagr > 0 ? ds.cagr / mainS.cagr : NaN, detail: `年化 ${(ds.cagr * 100).toFixed(1)}%（準時 ${(mainS.cagr * 100).toFixed(1)}%）`, need: "> 0"});
  await yieldFn("延遲進場");
  /* 5 逐年一致（只算完整年度） */
  const y0 = new Date(mainS.start).getUTCFullYear(), y1 = new Date(RS.main.times[RS.main.times.length - 1]).getUTCFullYear();
  const yrs = Object.entries(mainS.yearly).filter(([y]) => +y > y0 && +y < y1);
  const posY = yrs.filter(([, v]) => v > 0).length;
  tests.push({id: "years", name: "逐年一致", pass: yrs.length >= 3 && posY / yrs.length >= 0.6, detail: `完整年度 ${posY}/${yrs.length} 年賺錢，最差 ${(Math.min(...yrs.map(([, v]) => v)) * 100).toFixed(1)}%`, need: "≥ 60%"});
  /* 6 逐一剔除幣種 */
  const syms = [...new Set(base.map(x => x.sym))], lo = [];
  for (const sy of syms) { const a = S(run(base.filter(x => x.sym !== sy))); lo.push({sym: sy, cagr: a.cagr}); await yieldFn(`逐一剔除幣種 ${lo.length}/${syms.length}`); }
  const worst = lo.reduce((a, b) => b.cagr < a.cagr ? b : a);
  tests.push({id: "loo", name: "逐一剔除幣種", pass: lo.every(x => x.cagr > 0), detail: `年化 ${(Math.min(...lo.map(x => x.cagr)) * 100).toFixed(1)}%～${(Math.max(...lo.map(x => x.cagr)) * 100).toFixed(1)}%，影響最大：${worst.sym.replace("USDT", "")}`, need: "每次 > 0"});
  /* 7 多空拆分；8 大盤狀態（BTC 日線站上／跌破 200 日均線） */
  const Rof = t => t.pnl / t.risk, tr = RS.main.trades;
  const L = tr.filter(t => t.side > 0).map(Rof), Sh = tr.filter(t => t.side < 0).map(Rof);
  const ciL = CORE.bootMean(L), ciS = CORE.bootMean(Sh);
  tests.push({id: "sides", name: "多空拆分", pass: !(ciL[1] < 0) && !(ciS[1] < 0),
    detail: `做多 ${L.length} 筆 ${mean(L).toFixed(2)}R［${ciL[0].toFixed(2)}, ${ciL[1].toFixed(2)}］；做空 ${Sh.length} 筆 ${mean(Sh).toFixed(2)}R［${ciS[0].toFixed(2)}, ${ciS[1].toFixed(2)}］`, need: "皆非顯著虧損"});
  const btcD = instAll.find(x => x.sym === "BTCUSDT" && x.tf === 1440);
  let regime = null;
  if (btcD) {
    const ma = rollStat(btcD.bars.close, 200, 200, "mean");
    const bull = [], bear = [];
    for (const t of tr) { const i = lookupIdx(btcD.bars.time, t.t0); if (i < 0 || !Number.isFinite(ma[i])) continue; (btcD.bars.close[i] > ma[i] ? bull : bear).push(Rof(t)); }
    const cb = CORE.bootMean(bull), cr = CORE.bootMean(bear);
    regime = {bull, bear};
    tests.push({id: "regime", name: "大盤多空狀態", pass: !(cb[1] < 0) && !(cr[1] < 0),
      detail: `BTC 多頭 ${bull.length} 筆 ${mean(bull).toFixed(2)}R［${cb[0].toFixed(2)}, ${cb[1].toFixed(2)}］；空頭 ${bear.length} 筆 ${mean(bear).toFixed(2)}R［${cr[0].toFixed(2)}, ${cr[1].toFixed(2)}］`, need: "皆非顯著虧損"});
  }
  /* 評等：隨機進場對照是唯一檢驗「擇時能力」的項目，必須通過（以隨機資料負對照校準：其餘 7 項在運氣好的隨機資料上也會通過） */
  const passN = tests.filter(t => t.pass).length, timing = tests[0].pass;
  return {tests, passN, total: tests.length, timing, grade: !timing ? "低" : passN >= 7 ? "高" : passN >= 5 ? "中" : "低"};
};

/* ═══ 多面向診斷：5 個面向，只顯示、不改變訊號；差異用 99% 信賴區間（5 項多重比較校正） ═══ */
CORE.DIMS = [
  {id: "vol", zh: "成交量放大", short: "量能", desc: "進場那根成交量 ≥ 過去 20 天平均的 1.2 倍"},
  {id: "btc", zh: "BTC 大盤同向", short: "大盤", desc: "BTC 4 小時 20 日與 60 日報酬都和這筆方向一致"},
  {id: "fund", zh: "資金費率不擁擠", short: "費率", desc: "沒有出現同方向的極端資金費率（z 分數超過 ±1.5）"},
  {id: "daily", zh: "日線趨勢同向", short: "日線", desc: "同幣日線 60 日報酬和這筆方向一致"},
  {id: "calm", zh: "非極端波動", short: "波動", desc: "近 20 日波動不超過過去一年平均的 1.3 倍"},
];
CORE.dimContext = function (instAll) {
  const ctx = new Map();
  for (const x of instAll) {
    const bpd = 1440 / x.tf, v = x.bars.volume, n = v.length;
    const vs = new Float64Array(n).fill(NaN); for (let i = 1; i < n; i++) vs[i] = v[i - 1];
    const vavg = rollStat(vs, 20 * bpd, 10 * bpd, "mean");
    const volp = Float64Array.from(x.P.unit, (u, i) => u / x.bars.close[i]);
    const vol365 = rollStat(volp, 365 * bpd, 60 * bpd, "mean");
    ctx.set(x.sym + "|" + x.tf, {x, vavg, volp, vol365});
  }
  return ctx;
};
CORE.dimFlags = function (ctx, sym, tf, j, side) {
  const c = ctx.get(sym + "|" + tf); if (!c) return {};
  const x = c.x, t = x.bars.time[j], out = {};
  out.vol = Number.isFinite(c.vavg[j]) && c.vavg[j] > 0 ? x.bars.volume[j] >= 1.2 * c.vavg[j] : null;
  const b4 = ctx.get("BTCUSDT|240");
  if (b4) { const i = lookupIdx(b4.x.bars.time, t), f = b4.x.P.f; out.btc = i >= 0 && Number.isFinite(f.r20[i]) && Number.isFinite(f.r60[i]) ? Math.sign(f.r20[i]) === side && Math.sign(f.r60[i]) === side : null; }
  const fz = x.bars.funding_z ? x.bars.funding_z[j] : NaN;
  out.fund = Number.isFinite(fz) ? !((side > 0 && fz > 1.5) || (side < 0 && fz < -1.5)) : null;
  const d1 = ctx.get(sym + "|1440");
  if (d1) { const i = lookupIdx(d1.x.bars.time, t), r = d1.x.P.f.r60[i]; out.daily = i >= 0 && Number.isFinite(r) ? Math.sign(r) === side : null; }
  out.calm = Number.isFinite(c.vol365[j]) && Number.isFinite(c.volp[j]) ? c.volp[j] <= 1.3 * c.vol365[j] : null;
  return out;
};
CORE.dimStats = function (trades, ctx) {
  const res = {};
  for (const d of CORE.DIMS) res[d.id] = {yes: [], no: []};
  for (const t of trades) {
    const fl = CORE.dimFlags(ctx, t.sym, t.tf || 240, t.sig_j, t.side), R = t.pnl / t.risk;
    for (const d of CORE.DIMS) if (fl[d.id] === true) res[d.id].yes.push(R); else if (fl[d.id] === false) res[d.id].no.push(R);
  }
  for (const d of CORE.DIMS) {
    const r = res[d.id];
    r.ny = r.yes.length; r.nn = r.no.length; r.my = r.ny ? mean(r.yes) : NaN; r.mn = r.nn ? mean(r.no) : NaN;
    r.diff = CORE.bootDiff(r.yes, r.no);
    r.sig = Number.isFinite(r.diff[0]) && (r.diff[0] > 0 || r.diff[1] < 0);
    delete r.yes; delete r.no;
  }
  return res;
};
/* ═══ 延遲容忍度：把訊號搬到 1 小時 K 上，模擬晚 k 小時才進場（出場也用 1 小時 K 判斷） ═══ */
CORE.DELAY_KEEP = 0.75;   // 事前固定：年化需保有準時的 75% 以上
CORE.DRIFT_UNIT = 0.3;    // 與下單畫面相同：進場時價格偏離訊號收盤價超過 0.3 個停損單位就放棄
/* 晚 k 小時進場：把 4 小時訊號搬到 1 小時 K，在 T+k 小時那根收盤後進場；若當下價格已偏離超過 0.3 單位就不進場（和實際操作規則相同）。
   準時（k=0）時與 4 小時引擎結果相同。 */
CORE.delayCurve = async function (RS, instAll, ks = [0, 1, 2, 3, 4], yieldFn = async () => {}, engineDelay4 = null) {
  const risk = 0.005, R0 = {...CORE.defaultRisk(), equity: 10000, risk_pct: risk, qty_step: 1e-9, min_notional: 0};
  const out = [];
  for (const k of ks) {
    const I = [];
    let drop = 0;
    for (const x of RS.inst) {
      const h = instAll.find(y => y.sym === x.sym && y.tf === 60);
      if (!h) continue;
      const n1 = h.bars.time.length, pos = new Map();
      h.bars.time.forEach((t, i) => pos.set(t, i));
      const sig = {}, unit = new Float64Array(n1).fill(NaN), sigT = new Float64Array(n1).fill(NaN);
      for (const [name, arr] of Object.entries(x.P.sig)) {
        const s1 = new Int8Array(n1);
        for (let j = x.P.warm; j < arr.length; j++) {
          if (arr[j] === 0) continue;
          const i = pos.get(x.bars.time[j] + k * 3600000);
          if (i === undefined) continue;
          if (Math.abs(h.bars.close[i] - x.bars.close[j]) > CORE.DRIFT_UNIT * x.P.unit[j]) { drop++; continue; }
          s1[i] = arr[j]; unit[i] = x.P.unit[j]; sigT[i] = x.bars.time[j];
        }
        sig[name] = s1;
      }
      I.push({sym: x.sym, tf: 60, bars: h.bars, P: {sig, unit, warm: 0}, sigT});
    }
    /* 選幣資格以「訊號那根 4 小時 K 的時間」判斷，避免延遲跨月時誤判 */
    const elig = RS.eligible ? (sym, t) => { const x = I.find(z => z.sym === sym); const i = x ? lookupIdx(x.bars.time, t) : -1; return RS.eligible(sym, i >= 0 && Number.isFinite(x.sigT[i]) ? x.sigT[i] : t); } : undefined;
    const r = CORE.portfolio(I, R0, {strats: RS.strats, maxOpenRisk: 6 * risk, maxCoinRisk: 3 * risk, eligible: elig});
    const st = CORE.portfolioStats(r);
    out.push({k, cagr: st ? st.cagr : NaN, sharpe: st ? st.sharpe : NaN, drop});
    await yieldFn(`延遲容忍度 ${k} 小時`);
  }
  const base = out[0].cagr;
  for (const o of out) {
    o.keep1h = base > 0 ? o.cagr / base : NaN;
    o.keep = o.keep1h;
    if (o.k === 4 && engineDelay4 && Number.isFinite(engineDelay4.keep)) { o.keepEngine = engineDelay4.keep; o.keep = Math.min(o.keep1h, engineDelay4.keep); }   // 兩種測試取較差
  }
  let ok = 0;
  for (const o of out) { if (o.k === 0) continue; if (o.keep >= CORE.DELAY_KEEP) ok = o.k; else break; }   // 1..k 每一級都要達標
  return {curve: out, maxDelayH: ok};
};
/* ═══ 前向驗證（事前固定，2026/11/7 凍結）═══
   凍結的系統：4 小時、固定停利、逐月選幣、每筆 0.5%、總風險 ×6、單幣 ×3。
   只計算凍結時點之後才收盤的訊號 K 棒所開的交易（設計時從未看過的資料），交易結束後才計入。
   只在第 50 筆與第 100 筆判定；每次用 95% 區間（單邊 2.5%），兩次合計誤判率 ≤ 5%。 */
CORE.FREEZE = Date.UTC(2026, 10, 7, 8, 0, 0);          // 台北 2026/11/7 16:00
CORE.TARGET = 0.10;                                      // 你的目標：長期年化 10%
/* 試行實單（事前固定）：
   資格＝訊號品質「高」（含勝過隨機進場）且全期 Sharpe>0 機率 ≥ 95%；
   風險＝以你的資金實測，回撤不超過 30% 的級距中，年化 ≥10% 機率最高者（同分取較低風險）；
   停用＝凍結後實測帳戶從高點回落 ≥ 實測歷史最大回撤 × 1.25，或前向判定失敗。 */
CORE.TRIAL = {psrMin: 0.95, ddMax: 0.30, ddMult: 1.25, risks: [0.0025, 0.005, 0.0075, 0.01, 0.0125, 0.015, 0.02]};
/* 成長模式（前向驗證通過後才可用，事前固定）：腰斬機率（抽樣路徑最大回撤 ≥ 50%）≤ 10% 的級距中，
   取第 25 百分位長期年化最高者（同分取較低風險）。比全凱利保守，因為它把「優勢估計有誤差」算進去。 */
CORE.GROWTH = {pHalfMax: 0.10};
CORE.pickGrowth = function (rows) {
  const ok = rows.filter(r => r.st && r.st.pHalf <= CORE.GROWTH.pHalfMax);
  if (!ok.length) return null;
  return ok.reduce((a, b) => b.st.q25 > a.st.q25 + 1e-9 ? b : a);
};
/* 理論天花板：全凱利長期成長 ≈ Sharpe² / 2（連續時間近似），對應年波動 ≈ Sharpe */
CORE.kellyCeiling = sh => ({cagr: Math.exp(sh * sh / 2) - 1, vol: sh});
CORE.pickRisk = function (rows) {
  const ok = rows.filter(r => r.st && r.st.mdd >= -CORE.TRIAL.ddMax);
  if (!ok.length) return null;
  return ok.reduce((a, b) => b.st.pT > a.st.pT + 1e-9 ? b : a);
};
CORE.ddSince = function (run, t0) {
  let pk = -Infinity, dd = 0, cur = 0;
  for (let k = 0; k < run.times.length; k++) {
    if (run.times[k] < t0) continue;
    pk = Math.max(pk, run.curve[k]); cur = run.curve[k] / pk - 1; dd = Math.min(dd, cur);
  }
  return {max: dd, now: cur};
};
CORE.FROZEN = {tf: 240, strats: CORE.STRATS_HTF, risk: 0.005};
CORE.FW_LOOKS = [50, 100];
CORE.forward = function (inst, eligible) {
  const I = inst.filter(x => x.tf === CORE.FROZEN.tf), r = CORE.FROZEN.risk;
  const run = CORE.portfolio(I, {...CORE.defaultRisk(), equity: 10000, risk_pct: r, qty_step: 1e-9, min_notional: 0},
    {strats: CORE.FROZEN.strats, maxOpenRisk: 6 * r, maxCoinRisk: 3 * r, eligible});
  const tr = run.trades.filter(t => t.t0 >= CORE.FREEZE).sort((a, b) => a.exit_t - b.exit_t);
  const R = tr.map(t => t.pnl / t.risk), n = R.length;
  /* 依序檢查判定點；第一個有結論的判定點就是最終結果，之後不再改變（判定只用到達該點時的前 k 筆） */
  let status = "pending", look = 0, ci = [NaN, NaN];
  for (const k of CORE.FW_LOOKS) {
    if (n < k) break;
    look = k; ci = CORE.bootMean(R.slice(0, k));
    if (ci[0] > 0) { status = "pass"; break; }
    if (ci[1] < 0) { status = "fail"; break; }
    status = k === CORE.FW_LOOKS[CORE.FW_LOOKS.length - 1] ? "fail_inconclusive" : "continue";
  }
  const openN = run.open.filter(o => o.t0 >= CORE.FREEZE).length;
  return {run, I, trades: tr, R, n, mean: n ? mean(R) : NaN, sum: R.reduce((a, b) => a + b, 0), ciNow: CORE.bootMean(R), look, ciLook: ci, status, openN};
};
if (typeof module !== "undefined") module.exports = {CORE, rollStat, rollStdExact, normCdf, normPpf, psr, dsr, sharpeStats};


/* ═══════════════ 資料層純函式（無 DOM，可在 Node 測試） ═══════════════ */
const DATA = {};
DATA.BAR = 15 * 60000;
DATA.parseTime = function (raw) {
  const s = String(raw).trim().replace(/^"|"$/g, "");
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = +s;
    if (n > 1e17) return Math.round(n / 1e6);        // 奈秒
    if (n > 1e14) return Math.round(n / 1e3);        // 微秒（Binance 2025 年起的現貨檔）
    if (n > 1e11) return n;                          // 毫秒
    if (n > 1e8) return n * 1000;                    // 秒
    return NaN;
  }
  let iso = s.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) iso += "Z";  // 沒寫時區一律視為 UTC
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};
DATA.parseCSV = function (text) {
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // 跳過檔頭說明列（例如 CryptoDataDownload 第一行是網址）：從第一個含 open/close 或資金費率字樣、或以數字開頭的列開始
  const start = lines.findIndex((l, i) => i < 5 && (/open/i.test(l) && /close/i.test(l) || /funding/i.test(l) || /^\d/.test(l)));
  if (start > 0) lines = lines.slice(start);
  if (!lines.length) return {kind: null, rows: []};
  const sep = lines[0].includes(";") && !lines[0].includes(",") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const split = l => l.split(sep).map(x => x.trim().replace(/^"|"$/g, ""));
  const first = split(lines[0]);
  const hasHeader = first.some(x => /^[A-Za-z_ ()]+$/.test(x));
  const body = hasHeader ? lines.slice(1) : lines;
  const names = hasHeader ? first.map(x => x.toLowerCase().replace(/[\s()]/g, "")) : [];
  const find = (...cands) => names.findIndex(n => cands.includes(n));
  if (hasHeader && find("last_funding_rate", "fundingrate", "funding_rate", "rate") >= 0 && find("open", "close") < 0) {
    const ti = find("calc_time", "fundingtime", "funding_time", "time", "timestamp", "date", "datetime");
    const ri = find("last_funding_rate", "fundingrate", "funding_rate", "rate");
    const rows = [];
    for (const l of body) { const c = split(l); const t = DATA.parseTime(c[ti]), r = +c[ri]; if (Number.isFinite(t) && Number.isFinite(r)) rows.push({t, rate: r}); }
    return {kind: "funding", rows};
  }
  let idx;
  if (hasHeader) {
    idx = {t: find("open_time", "opentime", "unix", "unixtimestamp", "time", "timestamp", "date", "datetime", "ts"),
      o: find("open"), h: find("high"), l: find("low"), c: find("close"),
      v: find("volume", "vol", "volume_btc", "volumebtc", "volccy"), q: find("quote_volume", "quote_asset_volume", "turnover", "volccyquote", "volume_usdt", "volumeusdt", "volume_usd", "volumeusd")};
    if ([idx.t, idx.o, idx.h, idx.l, idx.c].some(i => i < 0)) return {kind: null, rows: [], error: "找不到 時間/開/高/低/收 欄位"};
  } else {
    if (first.length < 6) return {kind: null, rows: [], error: "欄位太少"};
    idx = {t: 0, o: 1, h: 2, l: 3, c: 4, v: 5, q: first.length >= 8 ? 7 : -1};   // Binance K 線檔格式
  }
  const rows = [];
  for (const l of body) {
    const c = split(l), t = DATA.parseTime(c[idx.t]);
    const r = {ot: t, o: +c[idx.o], h: +c[idx.h], l: +c[idx.l], c: +c[idx.c], v: idx.v >= 0 ? +c[idx.v] : NaN, q: idx.q >= 0 ? +c[idx.q] : NaN};
    if (Number.isFinite(t) && r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0) rows.push(r);
  }
  return {kind: "kline", rows};
};
/* 標準化成 15 分 K：去重、排序、偵測週期、小週期合成、只保留完整的 K 棒 */
DATA.toBars = function (rows, now, tfMin = 15) {
  const BAR = tfMin * 60000;
  const m = new Map();
  for (const r of rows) m.set(r.ot, r);
  const a = [...m.values()].sort((x, y) => x.ot - y.ot);
  if (a.length < 2) throw new Error("K 線資料太少");
  const diffs = [];
  for (let i = 1; i < a.length; i++) diffs.push(a[i].ot - a[i - 1].ot);
  diffs.sort((x, y) => x - y);
  const step = diffs[Math.floor(diffs.length / 2)], stepMin = Math.round(step / 60000);
  if (!(stepMin >= 1 && stepMin <= tfMin && tfMin % stepMin === 0))
    throw new Error(`偵測到 ${stepMin} 分鐘週期，無法合成 ${tfMin >= 1440 ? "日" : tfMin >= 60 ? tfMin / 60 + " 小時" : tfMin + " 分"} K，需要能整除的較短週期`);
  const need = tfMin / stepMin, out = [];
  const minN = need >= 16 ? need - Math.floor(need * 0.05) : need;   // 長週期容許少量缺漏（交易所維護）
  let cur = null;
  const flush = () => { if (cur && cur.n >= minN) out.push(cur); };
  for (const r of a) {
    const v = Number.isFinite(r.v) ? r.v : 0;
    const q = Number.isFinite(r.q) ? r.q : v * (r.h + r.l + r.c) / 3;
    const b = Math.floor(r.ot / BAR) * BAR;
    if (!cur || cur.ot !== b) { flush(); cur = {ot: b, o: r.o, h: r.h, l: r.l, c: r.c, v, q, n: 1}; }
    else { cur.h = Math.max(cur.h, r.h); cur.l = Math.min(cur.l, r.l); cur.c = r.c; cur.v += v; cur.q += q; cur.n++; }
  }
  flush();
  const done = out.filter(x => x.ot + BAR <= now);
  let gaps = 0;
  for (let i = 1; i < done.length; i++) if (done[i].ot - done[i - 1].ot !== BAR) gaps++;
  const col = k => Float64Array.from(done, x => x[k]);
  return {time: Float64Array.from(done, x => x.ot + BAR), open: col("o"), high: col("h"), low: col("l"), close: col("c"),
    volume: col("v"), quote_volume: col("q"), gaps, srcStep: stepMin};
};
DATA.sliceDays = function (bars, days) {
  const n = bars.time.length, t0 = bars.time[n - 1] - days * 86400000;
  let i = 0; while (i < n && bars.time[i] <= t0) i++;
  const o = {};
  for (const k of ["time", "open", "high", "low", "close", "volume", "quote_volume", "fundingRate", "funding_z"]) if (bars[k]) o[k] = bars[k].slice(i);
  return o;
};
if (typeof module !== "undefined") module.exports.DATA = DATA;


/* ── Node 環境替代：網頁的 localStorage / IndexedDB / 進度文字 ── */
const fs = require("fs"), path = require("path"), v8 = require("v8"), crypto = require("crypto");
const BOT_DIR = process.env.BTCBOT_DIR || __dirname, CACHE_DIR = path.join(BOT_DIR, "cache");
fs.mkdirSync(CACHE_DIR, {recursive: true});
const STORE_FILE = path.join(BOT_DIR, "store.json");
const store = {
  get(k, d) { try { const o = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); return k in o ? o[k] : d; } catch (e) { return d; } },
  set(k, v) { let o = {}; try { o = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (e) {} o[k] = v; fs.writeFileSync(STORE_FILE + ".tmp", JSON.stringify(o)); fs.renameSync(STORE_FILE + ".tmp", STORE_FILE); },
};
let PROG = () => {};
const prog = s => PROG(s);
const DRIFT_UNIT = CORE.DRIFT_UNIT, MAX_AUTO_RISK = 0.03, TOP_N = CORE.UNIV.top, POOL_N = 40, FEE_BPS = 5, SLIP_BPS = 1;
const TFS = [60, 240, 1440], TF_NAME = {60: "1 小時", 240: "4 小時", 1440: "日線"};
const FAPI = "https://fapi.binance.com";
/* 排除：穩定幣、法幣、黃金代幣、包裝幣 */
const EXCLUDE = new Set(["USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USDE", "PYUSD", "USD1", "RLUSD", "XUSD", "BFUSD", "USDS", "FRAX", "LUSD", "GUSD",
  "SUSD", "USTC", "UST", "EUR", "EURI", "AEUR", "GBP", "TRY", "BRL", "PAXG", "XAUT", "WBTC", "WBETH", "STETH", "BTCDOM"]);
const FALLBACK = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX", "TRX", "LTC", "BCH"];
let FILTERS = {};
const fmt = (x, d = 1) => Number(x).toLocaleString("en-US", {minimumFractionDigits: d, maximumFractionDigits: d});
const tpeMD = ms => new Date(ms).toLocaleString("zh-TW", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei"});
const ymd = ms => new Date(ms).toLocaleDateString("zh-TW", {timeZone: "Asia/Taipei"});
const sideTxt = s => s > 0 ? "▲ 做多" : "▼ 做空";
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const coin = sym => sym.replace(/USDT$/, "");
const stratZh = s => (CORE.STRATS_HTF[s] || {zh: s}).zh;
const pct = (x, d = 1) => Number.isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%" : "—";
const rr = (x, d = 2) => Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "—";
const qtyFmt = (q, step) => q.toFixed(Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
function baseRisk(equity, riskPct) { const R = CORE.defaultRisk(); R.equity = equity; R.risk_pct = riskPct; R.fee_bps = FEE_BPS; R.slip_bps = SLIP_BPS; return R; }
/* 槓桿：強平距離（1/槓桿 − 維持保證金率）必須 ≥ 停損距離的 2 倍，否則會先被強平；最多 5 倍、最少 1 倍 */
function suggestLeverage(notional, equity, stopPct, mmr = 0.004) { return CORE.safeLev(stopPct, 5, mmr); }

async function getJSON(url, ms = 20000) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, {cache: "no-store", signal: ac.signal}); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(to); }
}
async function pool(tasks, conc, gap, onDone) {
  const out = []; let i = 0, done = 0;
  const worker = async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); done++; onDone && onDone(done, tasks.length); if (gap) await sleep(gap); } };
  await Promise.all(Array.from({length: Math.min(conc, tasks.length)}, worker));
  return out;
}
function windows(startMs, stepMin, perReq) {
  const step = stepMin * 60000, end = Date.now(), w = [];
  for (let s = Math.floor(startMs / step) * step; s < end; s += perReq * step) w.push([s, Math.min(s + perReq * step - 1, end)]);
  return w;
}

/* ── 各交易所公開行情（依序備援） ── */
const BN_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com"];
let bnHost = store.get("btc_host", BN_HOSTS[0]);
async function bnGet(path) {
  let last;
  for (const h of [bnHost, ...BN_HOSTS.filter(x => x !== bnHost)]) {
    try { const js = await getJSON(h + path); if (h !== bnHost) { bnHost = h; store.set("btc_host", h); } return js; } catch (e) { last = e; }
  }
  throw last;
}
const PROVIDERS = [
  {id: "binance", name: "Binance 現貨 BTCUSDT",
    probe: () => bnGet("/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=2"),
    rows: async (start, tf, cb, sym = "BTCUSDT") => {
      const iv = {15: "15m", 60: "1h", 240: "4h", 1440: "1d"}[tf];
      const res = await pool(windows(start, tf, 1000).map(([s, e]) => () => bnGet(`/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${s}&endTime=${e}&limit=1000`)), 4, 0, cb);
      return res.flat().map(r => ({ot: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7]}));
    },
    price: async (sym = "BTCUSDT") => +(await bnGet(`/api/v3/ticker/price?symbol=${sym}`)).price},
  {id: "bybit", name: "Bybit 永續 BTCUSDT",
    probe: async () => { const j = await getJSON("https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=2"); if (j.retCode !== 0) throw new Error(j.retMsg); },
    rows: async (start, tf, cb, sym = "BTCUSDT") => {
      const iv = {15: "15", 60: "60", 240: "240", 1440: "D"}[tf];
      const res = await pool(windows(start, tf, 1000).map(([s, e]) => async () => {
        const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${iv}&start=${s}&end=${e}&limit=1000`);
        if (j.retCode !== 0) throw new Error(j.retMsg); return j.result.list;
      }), 4, 50, cb);
      return res.flat().map(r => ({ot: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[6]}));
    },
    price: async (sym = "BTCUSDT") => +(await getJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`)).result.list[0].lastPrice},
  {id: "okx", name: "OKX 永續 BTC-USDT-SWAP",
    probe: async () => { const j = await getJSON("https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=2"); if (j.code !== "0") throw new Error(j.msg); },
    rows: async (start, tf, cb, sym = "BTCUSDT") => {
      const iv = {15: "15m", 60: "1H", 240: "4H", 1440: "1Dutc"}[tf], inst = sym.replace("USDT", "-USDT-SWAP");
      const res = await pool(windows(start, tf, 100).map(([s, e]) => async () => {
        const j = await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${iv}&after=${e + 1}&before=${s - 1}&limit=100`);
        if (j.code !== "0") throw new Error(j.msg); return j.data.filter(r => r[8] === "1");
      }), 3, 220, cb);
      return res.flat().map(r => ({ot: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6], q: +r[7]}));
    },
    price: async (sym = "BTCUSDT") => +(await getJSON(`https://www.okx.com/api/v5/market/ticker?instId=${sym.replace("USDT", "-USDT-SWAP")}`)).data[0].last},
  {id: "coinbase", name: "Coinbase 現貨 BTC-USD",
    probe: () => getJSON("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    rows: async (start, tf, cb, sym = "BTCUSDT") => {
      const g = tf === 240 ? 60 : tf, prod = sym.replace("USDT", "-USD");   // Coinbase 沒有 4 小時，抓 1 小時再合成
      const res = await pool(windows(start, g, 300).map(([s, e]) => () =>
        getJSON(`https://api.exchange.coinbase.com/products/${prod}/candles?granularity=${g * 60}&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`)), 3, 120, cb);
      return res.flat().map(r => ({ot: r[0] * 1000, o: +r[3], h: +r[2], l: +r[1], c: +r[4], v: +r[5], q: NaN}));
    },
    price: async (sym = "BTCUSDT") => +(await getJSON(`https://api.exchange.coinbase.com/products/${sym.replace("USDT", "-USD")}/ticker`)).price},
];
const FUNDING = [
  {id: "binance", get: async (start, sym = "BTCUSDT") => {
    const end = Date.now(); let cur = start; const out = [];
    while (cur < end) {
      const js = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cur}&endTime=${end}&limit=1000`);
      if (!js.length) break; js.forEach(x => out.push({t: +x.fundingTime, rate: +x.fundingRate}));
      if (js.length < 1000) break; cur = +js[js.length - 1].fundingTime + 1;
    }
    return out;
  }},
  {id: "bybit", get: async (start, sym = "BTCUSDT") => {
    let end = Date.now(); const out = [];
    for (let k = 0; k < 60 && end > start; k++) {
      const j = await getJSON(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&startTime=${start}&endTime=${end}&limit=200`);
      if (j.retCode !== 0) throw new Error(j.retMsg);
      const l = j.result.list; if (!l.length) break;
      l.forEach(x => out.push({t: +x.fundingRateTimestamp, rate: +x.fundingRate}));
      end = Math.min(...l.map(x => +x.fundingRateTimestamp)) - 1;
      if (l.length < 200) break;
    }
    return out;
  }},
  {id: "okx", get: async (start, sym = "BTCUSDT") => {
    let after = Date.now(); const out = [];
    for (let k = 0; k < 60 && after > start; k++) {
      const j = await getJSON(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${sym.replace("USDT", "-USDT-SWAP")}&after=${after}&limit=100`);
      if (j.code !== "0") throw new Error(j.msg);
      if (!j.data.length) break;
      j.data.forEach(x => out.push({t: +x.fundingTime, rate: +x.fundingRate}));
      after = Math.min(...j.data.map(x => +x.fundingTime));
      if (j.data.length < 100) break;
    }
    return out.filter(x => x.t >= start);
  }},
];
function cleanFunding(arr) { const m = new Map(); arr.forEach(x => m.set(x.t, x)); return [...m.values()].sort((a, b) => a.t - b.t); }

async function pickProvider() {
  const pref = store.get("btc_src", null);
  const order = [...PROVIDERS].sort((a, b) => (b.id === pref) - (a.id === pref));
  for (const p of order) { prog(`連線 ${p.name}…`); try { await p.probe(); store.set("btc_src", p.id); return p; } catch (e) {} }
  return null;
}
/* 資金費率：快取已發生的結算紀錄，之後只向同一來源補抓新的部分 */
async function fetchFunding(start, sym = "BTCUSDT") {
  const key = `fund|${sym}|${start}`, old = await cGet(key);
  if (old && old.t && old.t.length && sortedOK(old.t)) {
    const f = FUNDING.find(x => x.id === old.src);
    try {
      const add = f ? await f.get(old.t[old.t.length - 1] + 1, sym) : [];
      const fr = cleanFunding(Array.from(old.t, (t, i) => ({t, rate: old.rate[i]})).concat(add));
      await cPut(key, {src: old.src, t: Float64Array.from(fr, x => x.t), rate: Float64Array.from(fr, x => x.rate)});
      return {fr, src: old.src};
    } catch (e) {}
  }
  const r = await fetchFundingRaw(start, sym);
  if (r.src) await cPut(key, {src: r.src, t: Float64Array.from(r.fr, x => x.t), rate: Float64Array.from(r.fr, x => x.rate)});
  return r;
}
async function fetchFundingRaw(start, sym = "BTCUSDT") {
  for (const f of FUNDING) {
    try { prog(`下載 ${sym} 資金費率…`); const fr = cleanFunding(await f.get(start, sym)); if (fr.length > 10) return {fr, src: f.id}; } catch (e) {}
  }
  return {fr: [], src: null};
}
/* ── 本機快取（IndexedDB）：已收盤的 K 線不會再變，之後只下載新的部分；任何錯誤都改為直接下載 ── */
let dbP = null, cacheOn = false;
function idb() {
  if (dbP) return dbP;
  dbP = new Promise(res => {
    try {
      const rq = indexedDB.open("pf_cache", 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("k")) rq.result.createObjectStore("k"); };
      rq.onsuccess = () => { cacheOn = true; res(rq.result); }; rq.onerror = () => res(null); rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return dbP;
}
async function cGet(key) { const db = await idb(); if (!db) return null; return new Promise(res => { try { const r = db.transaction("k").objectStore("k").get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); } catch (e) { res(null); } }); }
async function cPut(key, val) { const db = await idb(); if (!db) return; return new Promise(res => { try { const tx = db.transaction("k", "readwrite"); tx.objectStore("k").put(val, key); tx.oncomplete = tx.onerror = tx.onabort = () => res(); } catch (e) { res(); } }); }
const COLS = ["ot", "o", "h", "l", "c", "v", "q"];
const toCols = rows => { const o = {}; COLS.forEach(k => o[k] = Float64Array.from(rows, r => r[k])); return o; };
const fromCols = c => Array.from(c.ot, (t, i) => ({ot: t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: c.v[i], q: c.q[i]}));
const sortedOK = a => { for (let i = 1; i < a.length; i++) if (!(a[i] > a[i - 1])) return false; return a.length > 0; };
/* 只保存已收盤的 K 棒；讀回時檢查時間遞增，不合格就整筆丟棄重下 */
async function cachedRows(p, sym, tf, start, cb) {
  const step = tf * 60000, key = `bars|${p.id}|${sym}|${tf}|${start}`, now = Date.now();
  let old = await cGet(key);
  if (old && !(old.ot && sortedOK(old.ot))) old = null;
  let rows;
  if (old) {
    const from = old.ot[old.ot.length - 1] + step;
    const add = from + step <= now ? await p.rows(from, tf, cb, sym) : [];
    const m = new Map(fromCols(old).map(r => [r.ot, r])); add.forEach(r => m.set(r.ot, r));
    rows = [...m.values()].sort((a, b) => a.ot - b.ot);
  } else rows = await p.rows(start, tf, cb, sym);
  const done = rows.filter(r => r.ot + step <= now);
  if (done.length) await cPut(key, toCols(done));
  return rows;
}
/* 合約日成交額（USDT），用於逐月排名 */
async function dailyVol(sym, start) {
  const D = 86400000, key = `dv|${sym}|${start}`, now = Date.now();
  let old = await cGet(key);
  if (old && !(old.t && sortedOK(old.t))) old = null;
  const m = new Map(); if (old) old.t.forEach((t, i) => m.set(t, old.qv[i]));
  let cur = old ? old.t[old.t.length - 1] + D : start;
  for (let k = 0; k < 10 && cur + D <= now; k++) {
    const js = await getJSON(`${FAPI}/fapi/v1/klines?symbol=${sym}&interval=1d&startTime=${cur}&limit=1000`);
    if (!js.length) break;
    js.forEach(r => { if (+r[0] + D <= now) m.set(+r[0], +r[7]); });
    if (js.length < 1000) break;
    cur = +js[js.length - 1][0] + D;
  }
  const t = Float64Array.from([...m.keys()].sort((a, b) => a - b)), qv = Float64Array.from(t, x => m.get(x));
  if (t.length) await cPut(key, {t, qv});
  return {t, qv};
}
/* 候選池：目前交易中的 USDT 永續合約，排除穩定幣、黃金、包裝代幣、千倍合約，取 24 小時成交額前 POOL_N 名 */
async function loadPool() {
  const info = await getJSON(FAPI + "/fapi/v1/exchangeInfo", 25000);
  const perps = new Map();
  for (const sy of info.symbols) {
    if (sy.contractType !== "PERPETUAL" || sy.quoteAsset !== "USDT" || sy.status !== "TRADING") continue;
    const f = {};
    for (const x of sy.filters) {
      if (x.filterType === "MARKET_LOT_SIZE") f.step = +x.stepSize; if (x.filterType === "MIN_NOTIONAL") f.min = +x.notional;
      if (x.filterType === "PRICE_FILTER") f.tick = +x.tickSize;      // 價格級距：止損、止盈價必須是它的整數倍
    }
    if (f.step > 0 && f.min > 0) perps.set(sy.symbol, {base: sy.baseAsset, ...f});
  }
  /* 候選池每月只決定一次（當月第一次分析時），整個月固定，避免每天的成交額變動改寫過去的逐月排名 */
  const m0 = monthStart(Date.now()), saved = store.get("pf_pool", null);
  let poolList;
  if (saved && saved.m === m0 && Array.isArray(saved.syms) && saved.syms.length) {
    poolList = saved.syms.filter(sym => perps.has(sym)).map(sym => ({sym, base: perps.get(sym).base}));   // 已下架的移除
  } else {
    const tick = await getJSON(FAPI + "/fapi/v1/ticker/24hr", 25000);
    poolList = tick.filter(t => perps.has(t.symbol)).map(t => ({sym: t.symbol, base: perps.get(t.symbol).base, qv24: +t.quoteVolume}))
      .filter(c => !EXCLUDE.has(c.base) && !/^\d/.test(c.base)).sort((a, b) => b.qv24 - a.qv24).slice(0, POOL_N);
    store.set("pf_pool", {m: m0, syms: poolList.map(c => c.sym)});
  }
  const filters = {};
  perps.forEach((v, k) => filters[k] = {step: v.step, min: v.min, tick: v.tick});
  return {poolList, filters};
}


/* 快取改存檔案（v8 序列化，保留 Float64Array） */
function idb() { cacheOn = true; return Promise.resolve(true); }
const cFile = key => path.join(CACHE_DIR, crypto.createHash("sha1").update(key).digest("hex") + ".bin");
async function cGet(key) { try { return v8.deserialize(fs.readFileSync(cFile(key))); } catch (e) { return null; } }
async function cPut(key, val) { try { const f = cFile(key); fs.writeFileSync(f + ".tmp", v8.serialize(val)); fs.renameSync(f + ".tmp", f); } catch (e) {} }
module.exports = Object.assign(module.exports, {
  getJSON, pool, PROVIDERS, pickProvider, fetchFunding, cachedRows, dailyVol, loadPool, monthStart, baseRisk, suggestLeverage, qtyFmt, coin,
  EXCLUDE, FALLBACK, TOP_N, POOL_N, FEE_BPS, SLIP_BPS, MAX_AUTO_RISK, DRIFT_UNIT, TFS, FAPI, store,
  setProg: f => { PROG = f; }, getFilters: () => FILTERS, setFilters: f => { FILTERS = f; },
});
