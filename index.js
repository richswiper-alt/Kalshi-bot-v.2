process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { EventEmitter } = require('events');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- PID LOCK: prevent multiple instances ---
const PID_FILE = path.join(__dirname, '.bot.pid');
const existingPid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8').trim()) : null;
if (existingPid) {
  try { process.kill(existingPid, 0); console.error(`⚠️ Bot already running (PID ${existingPid}). Killing old process...`); process.kill(existingPid, 'SIGTERM'); } catch (_) { /* old process dead */ }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch (_) {} });

// ============================================
// CONFIG
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const KALSHI_API_KEY = process.env.KALSHI_API_KEY;
const YOUR_TELEGRAM_ID = process.env.YOUR_TELEGRAM_ID;
const PUBLIC_TELEGRAM_ID = process.env.PUBLIC_TELEGRAM_ID; // optional: public group/channel ID
const KALSHI_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';
const ALPHA_VANTAGE_KEY = null; // removed — all commodities now use Yahoo Finance

const KALSHI_KEY_PATH = process.env.KALSHI_KEY_PATH || './kalshi_key.pem';
let KALSHI_API_SECRET = null;
try {
  let rawKey = fs.readFileSync(KALSHI_KEY_PATH, 'utf8');
  if (rawKey.charCodeAt(0) === 0xFEFF) rawKey = rawKey.slice(1);
  KALSHI_API_SECRET = rawKey.trim() + '\n';
} catch (err) {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`⚠️ Private key unavailable at ${KALSHI_KEY_PATH}; Kalshi features are disabled.`);
  }
}

const isPlaceholder = (value) => !value || /^REPLACE_WITH/i.test(value) || value === '-';
const HAS_TELEGRAM_CREDENTIALS = !isPlaceholder(TELEGRAM_TOKEN) && !isPlaceholder(YOUR_TELEGRAM_ID);
const HAS_KALSHI_CREDENTIALS = !isPlaceholder(KALSHI_API_KEY) && Boolean(KALSHI_API_SECRET);
const NO_CREDENTIALS_MODE = !HAS_TELEGRAM_CREDENTIALS || !HAS_KALSHI_CREDENTIALS;

if (NO_CREDENTIALS_MODE) {
  console.warn('ℹ️ Running in no-credentials mode: public data and local state only; trading and Telegram are disabled.');
}

// ============================================
// BANKROLL & RISK MANAGEMENT
// ============================================
const BANKROLL = parseFloat(process.env.BANKROLL || '50');

const RISK_RULES = {
  maxPerTradePercent: parseFloat(process.env.MAX_TRADE_SIZE || '0.05'), // 5% portfolio max per trade
  positionSizePct: parseFloat(process.env.POSITION_SIZE || '0.02'),     // 2% default risk unit
  kellyFraction: 0.3,
  minConfidenceToTrade: parseFloat(process.env.MIN_CONFIDENCE || '0.55'),
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '0.02') >= 1 ? parseFloat(process.env.DAILY_LOSS_LIMIT || '5') / 1000 : parseFloat(process.env.DAILY_LOSS_LIMIT || '0.02'), // $5 daily loss soft stop (if >=1 treated as $, else as %)
  dailyLossLimitDollars: parseFloat(process.env.DAILY_LOSS_LIMIT || '5') >= 1 ? parseFloat(process.env.DAILY_LOSS_LIMIT || '5') : 5, // $5 daily loss in dollars
  maxDrawdown: parseFloat(process.env.MAX_DRAWDOWN || '0.15'),          // 15% peak-to-trough halt
  emergencyStopPct: parseFloat(process.env.EMERGENCY_STOP_PCT || '0.10'), // 10% daily drawdown = full halt
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '0.02')          // 2% stop reference (vol-aware)
};
// How many 30s price samples define the "recent high/low" window. Bigger =
// catches larger swings = more signals. Tune via .env without code edits.
const SCAN_LOOKBACK = parseInt(process.env.SCAN_LOOKBACK || '20', 10);

// ============================================
// FIXED BET SIZE  — every trade risks exactly this many dollars.
// Change with FIXED_BET in .env (default $1). Overrides Kelly sizing entirely.
// ============================================
const FIXED_BET_USD = parseFloat(process.env.FIXED_BET || '1');

// ============================================
// TWO-PLAY STRATEGY — FAVORITE + UNDERDOG
// FAVORITE: bet the side priced 58-64¢ (the favorite) with history/intel backing
// UNDERDOG: bet the side priced 37-43¢ (the underdog) with edge + memory intel
// ============================================
const PLAY_STRATEGY = {
  FAVORITE: {
    label: 'FAVORITE',
    priceMin: 0.58, priceMax: 0.64,
    stakeMin: parseFloat(process.env.FAV_STAKE_MIN || '0.25'),
    stakeMax: parseFloat(process.env.FAV_STAKE_MAX || '1.00'),
    stakeDefault: parseFloat(process.env.FAV_STAKE || '0.75'),
    minEdge: 0.03,
    minWinProb: 0.56,
    requireMemory: true
  },
  UNDERDOG: {
    label: 'UNDERDOG',
    priceMin: 0.37, priceMax: 0.43,
    stakeMin: parseFloat(process.env.UNDER_STAKE_MIN || '1.50'),
    stakeMax: parseFloat(process.env.UNDER_STAKE_MAX || '1.50'),
    stakeDefault: parseFloat(process.env.UNDER_STAKE || '1.50'),
    minEdge: 0.06,
    minWinProb: 0.48,
    requireMemory: true
  }
};

// ============================================
// AUTO HIT CYCLE — fully autonomous, trade as much as optimal
// ============================================
const AUTO_HIT_CYCLE = {
  enabled: true,
  maxPlaysPerCycle: parseInt(process.env.AUTO_HIT_MAX || '20', 10),
  minEdge: parseFloat(process.env.AUTO_HIT_MIN_EDGE || '0.02'),        // 2pp minimum edge
  minWinProb: parseFloat(process.env.AUTO_HIT_MIN_WIN || '0.50'),     // 50% win prob
  minMemoryBits: parseInt(process.env.AUTO_HIT_MIN_MEM || '0', 10),   // no memory required
  mode: process.env.AUTO_HIT_MODE || 'hybrid',                        // hybrid = 15m + longer
  maxSettleMinsStrict: parseInt(process.env.AUTO_HIT_MAX_SETTLE_STRICT || '17', 10),
  maxSettleMinsFallback: parseInt(process.env.AUTO_HIT_MAX_SETTLE_FALLBACK || '1440', 10),
  allowedCategories: ['CRYPTO', 'COMMODITY', 'NICHE', 'QUANT_NICHE', 'LONGSHOT'], // all categories
  cooldownSec: parseInt(process.env.AUTO_HIT_COOLDOWN || '30', 10),   // 30 sec between same market
  dailyMaxLoss: parseFloat(process.env.AUTO_HIT_DAILY_MAX_LOSS || process.env.DAILY_LOSS_LIMIT || '5'), // $5 daily loss cap
  dailyLoss: 0,
  dailyLossDate: null,
  maxConsecutiveLosses: parseInt(process.env.AUTO_HIT_MAX_LOSSES || '10', 10), // halt after 10 losses
  consecutiveLosses: 0,
  lastFire: {},  // ticker_side -> timestamp
  // Runtime tracking fields (persisted in state)
  attemptCount: 0,
  lastAttempt: 0,
  totalFired: 0,
  lastFired: 0,
  // Adaptive thresholds
  adaptiveThresholds: {
    enabled: true,
    minEdgeRange: [0.01, 0.10],      // 1-10pp adaptive
    minWinProbRange: [0.45, 0.65],   // 45-65% adaptive
    maxPlaysRange: [1, 20]           // 1-20 plays per cycle adaptive
  }
};

// ============================================
// "TRADE LIKE IT'S MY OWN MONEY" — OWNER-REVIEW GATE
// A prudent second look before firing: shrinks overconfident model edges using
// the asset's real track record, vetoes patterns that have historically lost,
// and tightens up during losing streaks. Toggle with OWNER_MODE=false.
// ============================================
const OWNER_MODE = process.env.OWNER_MODE !== 'false';
// Realized round-trip cost buffer (fees/slippage) the owner won't trade through.
const FEE_BUFFER = parseFloat(process.env.FEE_BUFFER || '0.02'); // 2pp
// After this many net losers in a row, require extra edge before firing.
const STREAK_TIGHTEN_AFTER = parseInt(process.env.STREAK_TIGHTEN_AFTER || '3', 10);
// Min samples in a memory bucket before we trust its win-rate for a decision.
const MIN_SAMPLES_TO_TRUST = parseInt(process.env.MIN_SAMPLES_TO_TRUST || '8', 10);

// ============================================
// PROFIT-TAKING — bank gains when the tape is shaky, ride when it's calm.
// ============================================
const PROFIT_TAKE_ENABLED = process.env.PROFIT_TAKE_ENABLED !== 'false';
// Minimum unrealized profit (in $) worth banking (covers fees on a $1 bet).
const PROFIT_MIN_USD = parseFloat(process.env.PROFIT_MIN_USD || '0.05');
// "Shaky" = recent per-minute volatility above this (fraction). Above → take.
const SHAKY_SIGMA = parseFloat(process.env.SHAKY_SIGMA || '0.0015');
// Always bank profit once it reaches this fraction of the max possible gain,
// even in a calm market (a bird in the hand).
const PROFIT_LOCK_FRAC = parseFloat(process.env.PROFIT_LOCK_FRAC || '0.75');
// How often (seconds) to sweep open positions for profit-taking.
const PROFIT_SWEEP_SEC = parseInt(process.env.PROFIT_SWEEP_SEC || '60', 10);

// ============================================
// SCOUT PLAYS — small-stake longshots & niche/obscure hunts
// Stake scales with conviction between SCOUT_MIN and SCOUT_MAX (your $0.05–$0.32).
// ============================================
const SCOUT_MIN_USD = parseFloat(process.env.SCOUT_MIN || '0.05');
const SCOUT_MAX_USD = parseFloat(process.env.SCOUT_MAX || '0.32');
const LONGSHOT_MAX_PRICE = parseFloat(process.env.LONGSHOT_MAX_PRICE || '0.28'); // cheap contracts ≤ 28¢ (niches need room)
const LONGSHOT_MIN_EV = parseFloat(process.env.LONGSHOT_MIN_EV || '0.10');       // ≥ +10% EV
const NICHE_SCAN_MIN = parseFloat(process.env.NICHE_SCAN_MIN || '8');            // niche sweep cadence (min) — quality > spam
const NICHE_MIN_VOLUME = parseFloat(process.env.NICHE_MIN_VOLUME || '5');        // skip dead books
const NICHE_MIN_PRICE = parseFloat(process.env.NICHE_MIN_PRICE || '0.02');       // skip 0–1¢ untradeable junk
const NICHE_MAX_PRICE = parseFloat(process.env.NICHE_MAX_PRICE || '0.35');       // keep niches cheap/asymmetric
const NICHE_WINDOW_MAX = parseInt(process.env.NICHE_WINDOW_MAX || '3', 10);      // only the BEST niches per window
const NICHE_MIN_HIT_SCORE = parseFloat(process.env.NICHE_MIN_HIT_SCORE || '0.8'); // best-only, still reachable
const LONGSHOT_WINDOW_MAX = parseInt(process.env.LONGSHOT_WINDOW_MAX || '4', 10);
// QUANT NICHE — same hunter spirit as niche, but across ALL asset classes + stricter research backbone
const QUANT_NICHE_WINDOW_MAX = parseInt(process.env.QUANT_NICHE_WINDOW_MAX || '4', 10);
const QUANT_NICHE_MIN_EV = parseFloat(process.env.QUANT_NICHE_MIN_EV || '0.12');
const QUANT_NICHE_MAX_PRICE = parseFloat(process.env.QUANT_NICHE_MAX_PRICE || '0.40');
const QUANT_NICHE_MIN_SCORE = parseFloat(process.env.QUANT_NICHE_MIN_SCORE || '1.2');
// Prefer markets that settle soon (15m / 30m / 1h / few hours).
const SHORT_SETTLE_MAX_MIN = parseFloat(process.env.SHORT_SETTLE_MAX_MIN || '180'); // 3h default
const FAST_SETTLE_MAX_MIN = parseFloat(process.env.FAST_SETTLE_MAX_MIN || '60');   // 1h = "fast" 

// Stake sizer: maps EV (from LONGSHOT_MIN_EV up ~0.6 higher) onto [SCOUT_MIN, SCOUT_MAX].
function scoutStake(ev) {
  const t = clamp(((ev || 0) - LONGSHOT_MIN_EV) / 0.6, 0, 1);
  return Math.max(SCOUT_MIN_USD, Math.round((SCOUT_MIN_USD + t * (SCOUT_MAX_USD - SCOUT_MIN_USD)) * 100) / 100);
}
// Weather stakes mirror niche/scout sizing (small $0.05–$0.32), NOT the $1 fixed crypto size.
// Maps |edge| so a 6pp edge ≈ floor and ~20pp+ edge ≈ SCOUT_MAX.
function weatherStake(edge) {
  const e = Math.abs(Number(edge) || 0);
  const t = clamp((e - WEATHER_SETTINGS.minEdgeToTrade) / 0.14, 0, 1);
  return Math.max(SCOUT_MIN_USD, Math.round((SCOUT_MIN_USD + t * (SCOUT_MAX_USD - SCOUT_MIN_USD)) * 100) / 100);
}

// ============================================
// PER-WINDOW PROPOSAL BUDGET — best researched crypto plays per 15-min cycle.
// (Auto-fire is dormant; this caps how many proposals you get, not executions.)
// Raise WINDOW_PROPOSAL_MAX in .env if you want even more proposals.
// ============================================
const WINDOW_PROPOSAL_MAX = parseInt(process.env.WINDOW_PROPOSAL_MAX || '8', 10);
const WINDOW_PROPOSAL_MIN = parseInt(process.env.WINDOW_PROPOSAL_MIN || '8', 10);
let _wKey = null, _wCount = 0; const _wDedup = new Set();
function _rollWindow() { const k = (typeof liveWindowKey === 'function') ? liveWindowKey() : Math.floor(Date.now() / (15 * 60 * 1000)); if (k !== _wKey) { _wKey = k; _wCount = 0; _wDedup.clear(); } }
// True if we're allowed to surface a NEW proposal for this market/side this window.
function windowGate(id, side) { _rollWindow(); if (_wCount >= WINDOW_PROPOSAL_MAX) return false; return !_wDedup.has(`${id}_${side}`); }
function windowMark(id, side) { _rollWindow(); _wDedup.add(`${id}_${side}`); _wCount++; }
function windowLeft() { _rollWindow(); return Math.max(0, WINDOW_PROPOSAL_MAX - _wCount); }

// Adaptive auto-radar: hunts hard early in each 15-min cycle, eases off later.
const RADAR_AUTO = process.env.RADAR_AUTO !== 'false';

// ===== QUANT ENGINE CONFIG =====
// SIMPLE 15-MINUTE CYCLE (wall-clock :00/:15/:30/:45):
//   Each window: load research + prior cycle memory → fire best plays you think will hit → deposit → repeat.
// No hourly phase flip / full-edge grind. One clear loop.
const CRYPTO_EDGE_THRESHOLD = parseFloat(process.env.CRYPTO_EDGE || '0.04'); // 4pp quality bar (was 6pp)
const CRYPTO_EDGE_THRESHOLD_EDGE = CRYPTO_EDGE_THRESHOLD; // kept for compat — same bar always
const MIN_MARKET_VOLUME = parseFloat(process.env.MIN_VOLUME || '10');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const VOL_MULT = parseFloat(process.env.VOL_MULT || '1.28');
// One primary scan near each 15m open + light mid-window refresh
const QUANT_SCAN_MIN = parseFloat(process.env.QUANT_SCAN_MIN || '1');  // 1 min scans
const QUANT_PHASE_EDGE_AT_MIN = 99; // disabled — no mid-hour phase flip
const QUANT_CYCLE_MS = 15 * 60 * 1000; // cycle = 15m window
const QUANT_LIVE_WINDOW_MS = 15 * 60 * 1000;
const firedQuant = new Set();
const CYCLE_DEPOSIT_MAX = parseInt(process.env.CYCLE_DEPOSIT_MAX || '200', 10);
// Max quant cards per 15m window (sharp, not spam)
const QUANT_FIRE_MAX = parseInt(process.env.QUANT_FIRE_MAX || '8', 10);

// Auto-execute: small plays fire automatically, larger ones ask for approval.
// AUTO_EXECUTE=false disables auto entirely (everything asks first).
// AUTO_EXECUTE_MAX = the $ ceiling for auto-firing (defaults to your max-per-trade).
const AUTO_EXECUTE = process.env.AUTO_EXECUTE !== 'false';
const AUTO_EXECUTE_MAX = parseFloat(process.env.AUTO_EXECUTE_MAX || (BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2));
let autoExecuteEnabled = true; // AUTO-FIRE enabled by default
let _betIdCounter = 0; // monotonic counter for unique bet IDs

// Safety brake for auto-fire: once total money in open+in-flight positions
// reaches this, the bot stops AUTO-firing and switches those plays to
// ask-for-approval instead. 0 = no cap (full send). Set MAX_AUTO_EXPOSURE in
// .env, e.g. 25 = never let auto-fire commit more than $25 at once.
const MAX_AUTO_EXPOSURE = parseFloat(process.env.MAX_AUTO_EXPOSURE || (BANKROLL * 0.5).toFixed(2)); // default: half bankroll cap

// Optional anti-spam: minutes before re-proposing the SAME asset/market/side.
// Default 0 = fires freely.
const REPROPOSE_COOLDOWN_MIN = parseFloat(process.env.REPROPOSE_COOLDOWN_MIN || '0');
const lastProposalAt = {};
function withinCooldown(key) {
  if (REPROPOSE_COOLDOWN_MIN <= 0) return false;
  const last = lastProposalAt[key];
  return last ? (Date.now() - last) < REPROPOSE_COOLDOWN_MIN * 60 * 1000 : false;
}
function markProposed(key) { lastProposalAt[key] = Date.now(); }

// ============================================
// CRYPTO THRESHOLDS (buyDrop -> YES on dip, sellGain -> NO on pump)
// ============================================
const THRESHOLDS = {
  BTC:  { buyDrop: 0.10, sellGain: 0.35, name: 'Bitcoin' },
  ETH:  { buyDrop: 0.12, sellGain: 0.40, name: 'Ethereum' },
  SOL:  { buyDrop: 0.15, sellGain: 0.55, name: 'Solana' },
  XRP:  { buyDrop: 0.15, sellGain: 0.55, name: 'XRP' },
  DOGE: { buyDrop: 0.20, sellGain: 0.70, name: 'Dogecoin' }
};

// Crypto series the quant engine hunts. Default = 15-min only. After running
// /discover_crypto in Telegram, add the real longer-timeframe series tickers to
// your .env (comma-separated) to let the bot trade 30-min / hourly / daily
// markets too — no code editing needed. Example:
//   KX_BTC_SERIES=KXBTC15M,KXBTCH,KXBTCD
// Extra coins (XRP/ADA/AVAX/LINK/MATIC/etc.) can be added via KX_EXTRA_CRYPTO_SERIES
// as asset:series pairs, e.g. KX_EXTRA_CRYPTO_SERIES=XRP:KXXRP15M,ADA:KXADA15M
// Default = live 15m series only. Add 30m/hourly via .env after /discover_crypto:
//   KX_BTC_SERIES=KXBTC15M,KXBTC30M,KXBTCH
const BINANCE_SYM = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', DOGE: 'DOGEUSDT', XRP: 'XRPUSDT',
  ADA: 'ADAUSDT', AVAX: 'AVAXUSDT', LINK: 'LINKUSDT', MATIC: 'MATICUSDT',
  BNB: 'BNBUSDT', BCH: 'BCHUSDT', NEAR: 'NEARUSDT', UNI: 'UNIUSDT',
  ATOM: 'ATOMUSDT', SUI: 'SUIUSDT', APT: 'APTUSDT', INJ: 'INJUSDT',
  SEI: 'SEIUSDT', TIA: 'TIAUSDT', RENDER: 'RENDERUSDT', FET: 'FETUSDT',
  JUP: 'JUPUSDT', PENDLE: 'PENDLEUSDT', ENA: 'ENAUSDT', ARB: 'ARBUSDT',
  OP: 'OPUSDT', TON: 'TONUSDT', SHIB: 'SHIBUSDT', WLD: 'WLDUSDT',
  HYPE: 'HYPEUSDT', EIGEN: 'EIGENUSDT', AERO: 'AEROUSDT', GMX: 'GMXUSDT',
  DYDX: 'DYDXUSDT', AEVO: 'AEVOUSDT', W: 'WUSDT', PEPE: 'PEPEUSDT',
  FIL: 'FILUSDT', KAS: 'KASUSDT', ICP: 'ICPUSDT', ALGO: 'ALGOUSDT'
};
let _cgCooldownUntil = 0;
let _binanceBlocked = false;
const CRYPTO_SERIES = {
  BTC:  (process.env.KX_BTC_SERIES  || 'KXBTC15M').split(',').map(s => s.trim()).filter(Boolean),
  ETH:  (process.env.KX_ETH_SERIES  || 'KXETH15M').split(',').map(s => s.trim()).filter(Boolean),
  SOL:  (process.env.KX_SOL_SERIES  || 'KXSOL15M').split(',').map(s => s.trim()).filter(Boolean),
  XRP:  (process.env.KX_XRP_SERIES  || 'KXXRP15M').split(',').map(s => s.trim()).filter(Boolean),
  DOGE: (process.env.KX_DOGE_SERIES || 'KXDOGE15M').split(',').map(s => s.trim()).filter(Boolean)
};
// Load ALL KX_*_SERIES from .env — auto-discovers every crypto token Kalshi has
(function loadAllCryptoSeries() {
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith('KX_') || !key.endsWith('_SERIES') || !val) continue;
    // Skip the 5 already loaded above
    if (['KX_BTC_SERIES','KX_ETH_SERIES','KX_SOL_SERIES','KX_XRP_SERIES','KX_DOGE_SERIES'].includes(key)) continue;
    // Extract asset name: KX_ADA_SERIES → ADA, KX_HYPE_SERIES → HYPE
    const asset = key.replace(/^KX_/, '').replace(/_SERIES$/, '').toUpperCase();
    if (!asset) continue;
    const seriesList = val.split(',').map(s => s.trim()).filter(Boolean);
    if (!seriesList.length) continue;
    if (!CRYPTO_SERIES[asset]) CRYPTO_SERIES[asset] = [];
    for (const s of seriesList) {
      if (!CRYPTO_SERIES[asset].includes(s)) CRYPTO_SERIES[asset].push(s);
    }
    if (!THRESHOLDS[asset]) {
      THRESHOLDS[asset] = { buyDrop: 0.20, sellGain: 0.70, name: asset };
    }
  }
  console.log(`📡 Loaded ${Object.keys(CRYPTO_SERIES).length} crypto assets: ${Object.keys(CRYPTO_SERIES).join(', ')}`);
})();
function cryptoMarketSpecs() {
  const specs = [];
  for (const asset of Object.keys(CRYPTO_SERIES))
    for (const series of CRYPTO_SERIES[asset]) specs.push({ asset, series });
  return specs;
}

// Prefer short-settlement crypto series first (15m → 30m → hourly → rest).
function is15mSeries(series) {
  return /15M|15m|15MIN|15min|_15/.test(String(series || ''));
}
function is30mSeries(series) {
  return /30M|30m|30MIN|30min|_30/.test(String(series || ''));
}
function isHourlySeries(series) {
  const s = String(series || '');
  if (is15mSeries(s) || is30mSeries(s)) return false;
  return /(^|[^0-9A-Z])(H|1H|60M|HOUR|HOURLY)([^A-Z0-9]|$)/i.test(s) || /H$/i.test(s);
}
function shortSeriesRank(series) {
  if (is15mSeries(series)) return 0;
  if (is30mSeries(series)) return 1;
  if (isHourlySeries(series)) return 2;
  return 3;
}
function cryptoMarketSpecsPrefer15m() {
  return cryptoMarketSpecs().slice().sort((a, b) => shortSeriesRank(a.series) - shortSeriesRank(b.series));
}
function settleBoost(minsToClose) {
  if (minsToClose == null || !Number.isFinite(minsToClose)) return 0;
  if (minsToClose <= 20) return 0.025;                 // 15m cycle
  if (minsToClose <= 45) return 0.018;                 // ~30m
  if (minsToClose <= FAST_SETTLE_MAX_MIN) return 0.012; // ≤1h
  if (minsToClose <= SHORT_SETTLE_MAX_MIN) return 0.006; // ≤ few hours
  return 0;
}
function isShortSettle(minsToClose) {
  return Number.isFinite(minsToClose) && minsToClose > 0 && minsToClose <= SHORT_SETTLE_MAX_MIN;
}
function formatMinsLeft(mins) {
  if (!Number.isFinite(mins)) return '?';
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const h = mins / 60;
  if (h < 24) return `${h.toFixed(h < 3 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
function money(n, d = 2) { return `$${(Number(n) || 0).toFixed(d)}`; }
function pct(n, d = 0) { return `${((Number(n) || 0) * 100).toFixed(d)}%`; }
function pp(n, d = 1) { return `${((Number(n) || 0) * 100).toFixed(d)}pp`; }
function cents(n) { return `${((Number(n) || 0) * 100).toFixed(0)}¢`; }
function payoutX(price) { return price > 0 ? `${(1 / price).toFixed(2)}x` : 'n/a'; }
function verdictFromEdge(edge, winProb, minsToClose) {
  if (edge >= 0.12 && winProb >= 0.62) return { emoji: '🟢', label: 'STRONG — lean ACCEPT', why: 'Large model edge + solid win chance.' };
  if (edge >= 0.08 && winProb >= 0.58) return { emoji: '🟡', label: 'SOLID — good ACCEPT if you like thesis', why: 'Clear edge vs market odds.' };
  if (edge >= CRYPTO_EDGE_THRESHOLD && winProb >= RISK_RULES.minConfidenceToTrade) {
    return {
      emoji: '🟠',
      label: isShortSettle(minsToClose) ? 'OK FAST PLAY — accept if you want action' : 'MARGINAL — only if you agree',
      why: isShortSettle(minsToClose) ? 'Meets bar and settles soon.' : 'Barely clears the research bar.'
    };
  }
  return { emoji: '⚪', label: 'WEAK — lean REJECT', why: 'Edge/confidence thin after fees & uncertainty.' };
}

// ============================================
// WEATHER CONFIG — multi-source free ensemble
// Sources (no paid keys required): NWS, Open-Meteo, wttr.in
// Optional: OPENWEATHER_KEY for OpenWeather One Call / free 2.5
// ============================================
const WEATHER_CITIES = {
  DAL: { name: 'Dallas', kalshiSeriesTicker: process.env.KX_WX_DAL || 'KXHIGHTDAL', lat: 32.8998, lon: -97.0403 },
  NYC: { name: 'New York City', kalshiSeriesTicker: process.env.KX_WX_NYC || 'KXHIGHNY', lat: 40.7812, lon: -73.9665 },
  CHI: { name: 'Chicago', kalshiSeriesTicker: process.env.KX_WX_CHI || 'KXHIGHCHI', lat: 41.7868, lon: -87.7522 },
  MIA: { name: 'Miami', kalshiSeriesTicker: process.env.KX_WX_MIA || 'KXHIGHMIA', lat: 25.7959, lon: -80.2870 },
  LAX: { name: 'Los Angeles', kalshiSeriesTicker: process.env.KX_WX_LAX || 'KXHIGHLAX', lat: 33.9425, lon: -118.4081 },
  DEN: { name: 'Denver', kalshiSeriesTicker: process.env.KX_WX_DEN || 'KXHIGHDEN', lat: 39.8561, lon: -104.6737 },
  ATL: { name: 'Atlanta', kalshiSeriesTicker: process.env.KX_WX_ATL || 'KXHIGHTATL', lat: 33.6407, lon: -84.4277 },
  PHX: { name: 'Phoenix', kalshiSeriesTicker: process.env.KX_WX_PHX || 'KXHIGHTPHX', lat: 33.4373, lon: -112.0078 },
  SEA: { name: 'Seattle', kalshiSeriesTicker: process.env.KX_WX_SEA || 'KXHIGHTSEA', lat: 47.4502, lon: -122.3088 },
  BOS: { name: 'Boston', kalshiSeriesTicker: process.env.KX_WX_BOS || 'KXHIGHTBOS', lat: 42.3656, lon: -71.0096 }
};
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY || process.env.OPENWEATHERMAP_KEY || null;
const WEATHER_SETTINGS = {
  forecastStdDevF: parseFloat(process.env.WEATHER_STD || '3.2'),
  minEdgeToTrade: parseFloat(process.env.WEATHER_MIN_EDGE || '0.10'),
  minSources: parseInt(process.env.WEATHER_MIN_SOURCES || '1', 10),
  maxOpps: parseInt(process.env.WEATHER_MAX_OPPS || '2', 10),
  cacheMin: parseFloat(process.env.WEATHER_CACHE_MIN || '12')
};
const weatherEnsembleCache = {}; // cityCode -> { at, ensemble }

// ============================================
// COMMODITIES CONFIG
// ============================================
// ⚠️ Series tickers below are BEST-GUESS placeholders. Run /discover_commodities
// in Telegram to find the REAL Kalshi series tickers, then set them in your .env
// (KX_OIL, KX_NATGAS, KX_GOLD, KX_SILVER) — no code editing needed.
// Prices: oil & natural gas via Alpha Vantage; gold & silver via Stooq (free, no key).
// stddev = rough daily price move, used as the probability-model uncertainty band.
const COMMODITIES = {
  OIL:    { name: 'Crude Oil (WTI)', kalshiSeriesTicker: process.env.KX_OIL    || 'KXWTI',      source: 'yahoo',  yahooSymbol: 'CL=F',  stddev: parseFloat(process.env.KX_OIL_STD    || '2.5'),  unit: '$/bbl' },
  NATGAS: { name: 'Natural Gas',     kalshiSeriesTicker: process.env.KX_NATGAS || 'KXNATGASD',  source: 'yahoo',  yahooSymbol: 'NG=F',  stddev: parseFloat(process.env.KX_NATGAS_STD || '0.25'), unit: '$/MMBtu' },
  GOLD:   { name: 'Gold',            kalshiSeriesTicker: process.env.KX_GOLD   || 'KXGOLDH',    source: 'yahoo',  yahooSymbol: 'GC=F',  stddev: parseFloat(process.env.KX_GOLD_STD   || '12'),   unit: '$/oz' },
  SILVER: { name: 'Silver',          kalshiSeriesTicker: process.env.KX_SILVER || 'KXSILVERD',  source: 'yahoo',  yahooSymbol: 'SI=F',  stddev: parseFloat(process.env.KX_SILVER_STD || '1.0'),  unit: '$/oz' }
};
const COMMODITY_SETTINGS = { minEdgeToTrade: parseFloat(process.env.COMMODITY_MIN_EDGE || '0.08') };
const commodityPriceCache = {};
// Alpha Vantage free tier = 1 req/sec, 25/day. Throttle to stay under it.
// ============================================
// STATE
// ============================================
let botState = {
  isRunning: false,
  prices: { BTC: null, ETH: null, SOL: null, DOGE: null },
  priceHistory: { BTC: [], ETH: [], SOL: [], DOGE: [] },
  openBets: [],
  pendingBets: [],
  closedBets: [],
  stats: { totalBets: 0, wins: 0, losses: 0, totalProfit: 0 },
  settlementHistory: [],
  shadowPlays: [],  // tracks ALL proposals (approved/denied) for learning
  // Risk engine state (daily P&L, peak equity, emergency halt)
  risk: {
    dayKey: null,
    dayStartEquity: null,
    dayPnl: 0,
    peakEquity: null,
    emergencyHalt: false,
    haltReason: null
  },
  // ---- LONG-TERM MEMORY + KNOWLEDGE DEPOSITORY (persisted) ----
  // assets / patterns / categories: outcome learning used by ownerReview
  // depository: durable knowledge bank the bot consults on every play
  //   trades, markets, series, sides, hours, lessons, notes, denials
  memory: {
    assets: {}, patterns: {}, categories: {}, insights: [], updatedAt: null,
    depository: {
      trades: [],      // compact settled trade ledger (last N)
      markets: {},     // per-ticker track record
      series: {},      // per series ticker (KXBTC15M etc.)
      sides: {},       // YES vs NO performance by category
      hours: {},       // hour-of-day (America/Chicago-ish via local) performance
      lessons: [],     // auto-generated takeaways
      notes: [],       // user-taught notes via /remember
      denials: [],     // plays you rejected (preference learning)
      plays: [],      // every play sent to you (pattern fuel even if skipped)
      cycles: [],     // hourly cycle deposits (always logged)
      research: [],   // online research backbone snapshots
      stats: { proposals: 0, approvals: 0, denials: 0, settles: 0, cycles: 0, playsLogged: 0 }
    }
  }
};

const STATE_FILE = './kalshi_state.json';
const MEMORY_FILE = process.env.MEMORY_FILE || './kalshi_memory.json'; // durable knowledge depository
const MEMORY_TRADE_MAX = parseInt(process.env.MEMORY_TRADE_MAX || '400', 10);
const MEMORY_LESSON_MAX = parseInt(process.env.MEMORY_LESSON_MAX || '80', 10);
const MEMORY_NOTE_MAX = parseInt(process.env.MEMORY_NOTE_MAX || '100', 10);
const MEMORY_DENY_MAX = parseInt(process.env.MEMORY_DENY_MAX || '200', 10);

function emptyDepository() {
  return {
    trades: [], markets: {}, series: {}, sides: {}, hours: {},
    lessons: [], notes: [], denials: [],
    plays: [],      // every proposed play (even if not taken) for pattern learning
    cycles: [],     // hourly cycle deposits (always written, even if no plays taken)
    research: [],   // online research snapshots consulted by the model
    stats: { proposals: 0, approvals: 0, denials: 0, settles: 0, cycles: 0, playsLogged: 0 }
  };
}
function ensureMemoryShape() {
  if (!botState.memory) botState.memory = { assets: {}, patterns: {}, categories: {}, insights: [], updatedAt: null, depository: emptyDepository() };
  botState.memory.assets = botState.memory.assets || {};
  botState.memory.patterns = botState.memory.patterns || {};
  botState.memory.categories = botState.memory.categories || {};
  botState.memory.insights = botState.memory.insights || [];
  const d = botState.memory.depository || emptyDepository();
  botState.memory.depository = {
    trades: Array.isArray(d.trades) ? d.trades : [],
    markets: d.markets || {},
    series: d.series || {},
    sides: d.sides || {},
    hours: d.hours || {},
    lessons: Array.isArray(d.lessons) ? d.lessons : [],
    notes: Array.isArray(d.notes) ? d.notes : [],
    denials: Array.isArray(d.denials) ? d.denials : [],
    plays: Array.isArray(d.plays) ? d.plays : [],
    cycles: Array.isArray(d.cycles) ? d.cycles : [],
    research: Array.isArray(d.research) ? d.research : [],
    stats: Object.assign({ proposals: 0, approvals: 0, denials: 0, settles: 0, cycles: 0, playsLogged: 0 }, d.stats || {})
  };
}
function saveMemoryDepository() {
  try {
    ensureMemoryShape();
    const payload = {
      savedAt: new Date().toISOString(),
      updatedAt: botState.memory.updatedAt,
      assets: botState.memory.assets,
      patterns: botState.memory.patterns,
      categories: botState.memory.categories,
      insights: botState.memory.insights,
      depository: botState.memory.depository
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(payload, null, 2));
  } catch (err) { console.error('Memory depository save failed:', err.message); }
}
function loadMemoryDepository() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    // Merge depository file into state (file is source of truth for long-term knowledge if present)
    botState.memory = botState.memory || {};
    if (raw.assets) botState.memory.assets = { ...(botState.memory.assets || {}), ...raw.assets };
    if (raw.patterns) botState.memory.patterns = { ...(botState.memory.patterns || {}), ...raw.patterns };
    if (raw.categories) botState.memory.categories = { ...(botState.memory.categories || {}), ...raw.categories };
    if (Array.isArray(raw.insights) && raw.insights.length) botState.memory.insights = raw.insights;
    if (raw.depository) botState.memory.depository = raw.depository;
    if (raw.updatedAt) botState.memory.updatedAt = raw.updatedAt;
  } catch (err) { console.error('Memory depository load failed:', err.message); }
}
function saveState() {
  try {
    ensureMemoryShape();
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
    saveMemoryDepository();
  } catch (err) { console.error('Error saving state:', err.message); console.error(err.stack); }
}
function ensureAssetState(asset) {
  if (!botState.prices) botState.prices = {};
  if (!botState.priceHistory) botState.priceHistory = {};
  if (!(asset in botState.prices)) botState.prices[asset] = null;
  if (!Array.isArray(botState.priceHistory[asset])) botState.priceHistory[asset] = [];
}
function ensureAllConfiguredAssets() {
  for (const asset of Object.keys(CRYPTO_SERIES)) ensureAssetState(asset);
  for (const asset of Object.keys(THRESHOLDS)) ensureAssetState(asset);
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) botState = { ...botState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) { console.log('Starting fresh state'); }
  if (!botState.risk) botState.risk = { dayKey: null, dayStartEquity: null, dayPnl: 0, peakEquity: null, emergencyHalt: false, haltReason: null };
  if (typeof botState.autoExecuteEnabled !== 'boolean') botState.autoExecuteEnabled = true;
  if (!botState.AUTO_HIT_CYCLE) botState.AUTO_HIT_CYCLE = { ...AUTO_HIT_CYCLE };
  else botState.AUTO_HIT_CYCLE = { ...AUTO_HIT_CYCLE, ...botState.AUTO_HIT_CYCLE };
  ensureMemoryShape();
  loadMemoryDepository(); // merge durable knowledge bank
  ensureMemoryShape();
  ensureAllConfiguredAssets();
  try { ensureRiskDay(); } catch (_) {}
}

// ============================================
// TELEGRAM BOT
// ============================================
const bot = HAS_TELEGRAM_CREDENTIALS
  ? new TelegramBot(TELEGRAM_TOKEN, { polling: true })
  : (() => {
      const offlineBot = new EventEmitter();
      offlineBot.onText = () => offlineBot;
      offlineBot.sendMessage = async () => ({ offline: true });
      offlineBot.sendPhoto = async () => ({ offline: true });
      offlineBot.answerCallbackQuery = async () => ({ offline: true });
      offlineBot.editMessageReplyMarkup = async () => ({ offline: true });
      offlineBot.deleteMessage = async () => ({ offline: true });
      return offlineBot;
    })();

function notify(message, opts = {}) {
  // Public channel filtering: keep best sauce (quant/auto-hit) private
  // Only allow: NICHE, LONGSHOT, QUANT_NICHE, SCOUT, WEATHER, COMMODITY, system alerts
  const publicCategories = ['NICHE', 'LONGSHOT', 'QUANT_NICHE', 'SCOUT', 'WEATHER', 'COMMODITY'];
  const systemAlerts = ['CIRCUIT BREAKER', 'SCAN STALLED', 'STOP LOSS', 'AUTO-HIT STOP LOSS', 'AUTO-HIT'];
  
  const isPublicCategory = publicCategories.some(cat => message.includes(cat));
  const isSystemAlert = systemAlerts.some(alert => message.includes(alert));
  const isPublicAllowed = (message.includes('NICHE') || message.includes('LONGSHOT') || 
                          message.includes('QUANT_NICHE') || message.includes('SCOUT') ||
                          message.includes('WEATHER') || message.includes('COMMODITY') ||
                          isSystemAlert) || opts.forcePublic;
  
  const targets = [YOUR_TELEGRAM_ID];
  if (opts.public && isPublicAllowed && PUBLIC_TELEGRAM_ID) targets.push(PUBLIC_TELEGRAM_ID);
  
  return Promise.all(targets.map(id => {
    let finalMessage = message;
    // Append disclaimer when sending to public channel
    if (id === PUBLIC_TELEGRAM_ID) {
      finalMessage = message + publicDisclaimer();
    }
    return bot.sendMessage(id, finalMessage, { ...opts, parse_mode: 'HTML' })
      .catch(err => console.error(`Telegram send error to ${id}:`, err.message));
  }));
}

// Disclaimer for public channel
function publicDisclaimer() {
  return '\n\n⚠️ <b>DISCLAIMER</b>: This is NOT financial advice. Niche/longshot/quant-niche plays are HIGH-RISK speculative trades. You WILL lose money on many of these. Only trade what you can afford to lose. Do your own research. Past performance ≠ future results. You are responsible for your own trades.';
}

// Inline Approve/Deny/Copy buttons
function proposalKeyboard(id, tradeData = null) {
  const buttons = [
    { text: '✅ Approve', callback_data: `ap_${id}` },
    { text: '❌ Deny',    callback_data: `dn_${id}` }
  ];
  if (tradeData) {
    buttons.push({ text: '📋 Copy Trade', callback_data: `cp_${id}` });
  }
  return { reply_markup: { inline_keyboard: [buttons] } };
}

bot.onText(/\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🤖 Alpha Hound\n\n' +
    `Bankroll: $${BANKROLL.toFixed(2)} | Max/trade: $${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)}\n` +
    `Mode: ${DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE'} | Auto-fire: ${autoExecuteEnabled ? `ON (≤$${AUTO_EXECUTE_MAX.toFixed(2)})` : '✋ DORMANT'}\n\n` +
    'Scans crypto (YES dips / NO pumps), weather, commodities + hunts longshots & niche plays. Auto-fire is DORMANT — you approve every play (tap ✅/❌). Shaky positions ping you with a 🔒 Lock button.\n\n' +
    'CONTROL (all commands work with /go prefix: /go_start, /go_auto, etc.)\n' +
    '/start_bot · /stop_bot · /check_now\n' +
    '/panic - STOP + wipe all pending (emergency)\n' +
    '/clear_pending - clear pending queue\n' +
    '/auto on|off - enable/disable auto-firing (default OFF)\n' +
    '/gomakemoney - best researched short-settle play\n' +
    '/radar - concise 🟢/🔴 read + tap-to-fire\n' +
    '/radar_auto on|off - adaptive auto-radar posting\n' +
    '/scout - longshots + best niches + quant-niche\n' +
    '/quant_niche - multi-asset researched niche hunt\n' +
    '/debug_scan - why plays are not firing\n' +
    '/take - check open positions for lockable profit\n' +
    '/buy [ASSET] [amt] - manual crypto buy (YES)\n\n' +
    'MARKETS\n' +
    '/find_market [ASSET] - crypto lookup\n' +
    '/find_weather [CITY] - multi-source weather ensemble\n' +
    '/find_commodity [CODE] - commodity lookup\n' +
    '/discover_commodities - find real Kalshi commodity tickers\n' +
    '/discover_crypto - find crypto series (add 30m/hourly/daily)\n' +
    '/discover_sports [NBA|WNBA|NHL|MLB]\n\n' +
    'MEMORY & CYCLE\n' +
    '/cycle - current 15m cycle + deposit\n' +
    '/analysis - data-driven flow from cycle history\n' +
    '/plays - every play sent (even if skipped)\n' +
    '/memory [section] - full depository\n' +
    '/research - online research backbone snapshot\n' +
    '/strategy - SMA trend + RSI/BB mean-reversion read\n' +
    '/backtest [ASSET] - Binance SMA/MR backtest\n' +
    '/risk - daily P&L · drawdown · emergency stop\n' +
    '/remember [note] · /lessons · /forget_notes\n\n' +
    'INFO\n' +
    '/status · /stats · /balance · /chart\n' +
    '/pending - list awaiting-approval trades\n' +
    '/check_settlements\n' +
    '/approve [id] · /deny [id] (buttons also work)\n'
  );
});

bot.onText(/\/start_bot/, async (msg) => {
  if (!botState.isRunning) {
    botState.isRunning = true;
    if (botState.risk) { botState.risk.emergencyHalt = false; botState.risk.haltReason = null; }
    ensureRiskDay();
    saveState();
  }
  bot.sendMessage(msg.chat.id,
    `🟢 Bot started / scanning.\n\n` +
    `Bankroll $${BANKROLL} | max $${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)}/trade.\n` +
    `15m hit cycles · research + memory each window\n` +
    `Edge ${pp(CRYPTO_EDGE_THRESHOLD)} · conf ${pct(RISK_RULES.minConfidenceToTrade)} · max ${QUANT_FIRE_MAX}/window\n` +
    `Auto-fire: ${autoExecuteEnabled ? `ON ≤$${AUTO_EXECUTE_MAX.toFixed(2)}` : 'OFF (you approve)'}\n` +
    `Weather: rare + approval-only · niches best-only\n` +
    `Scanning...`
  );
  try {
    await runQuantScan({ verbose: true });
    await runScouts({ preferShort: true, moreNiche: false });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Scan error: ${e.message}. Try /debug_scan.`);
  }
});

bot.onText(/\/auto (on|off)/i, (msg, m) => {
  autoExecuteEnabled = m[1].toLowerCase() === 'on';
  bot.sendMessage(msg.chat.id, autoExecuteEnabled
    ? `⚡ Auto-fire ON — plays ≤ $${AUTO_EXECUTE_MAX.toFixed(2)} execute automatically; bigger ones still ask.`
    : `✋ Auto-fire OFF — every play now waits for your ✅/❌.`);
});

bot.onText(/\/go_auto_hit (on|off)/i, (msg, m) => {
  const enabled = m[1].toLowerCase() === 'on';
  AUTO_HIT_CYCLE.enabled = enabled;
  bot.sendMessage(msg.chat.id, enabled
    ? `🎯 AUTO-HIT CYCLE ON\n` +
      `• Fires at :00 :15 :30 :45 (15m boundaries)\n` +
      `• Only 15m crypto/commodity markets\n` +
      `• Top ${AUTO_HIT_CYCLE.maxPlaysPerCycle} plays per cycle\n` +
      `• Min edge ${pp(AUTO_HIT_CYCLE.minEdge)} · conf ${pct(AUTO_HIT_CYCLE.minConf)} · vol ≥$${AUTO_HIT_CYCLE.minVolume}\n` +
      `• Must pass memory + strategy gates\n\n` +
      `Use /auto_hit_status to check.`
    : `🛑 AUTO-HIT CYCLE OFF — no boundary auto-firing.`);
});

bot.onText(/\/go_auto_hit_status/, (msg) => {
  const st = AUTO_HIT_CYCLE.enabled ? '🟢 ON' : '🔴 OFF';
  const last = Object.keys(AUTO_HIT_CYCLE.lastFire).length ? Math.max(...Object.values(AUTO_HIT_CYCLE.lastFire)) : null;
  const lastStr = last ? `<t:${Math.floor(last/1000)}:R>` : 'never';
  bot.sendMessage(msg.chat.id,
    `🎯 AUTO-HIT CYCLE: ${st}\n` +
    `Max plays/cycle: ${AUTO_HIT_CYCLE.maxPlaysPerCycle}\n` +
    `Min edge: ${pp(AUTO_HIT_CYCLE.minEdge)} | Min conf: ${pct(AUTO_HIT_CYCLE.minConf)} | Min vol: $${AUTO_HIT_CYCLE.minVolume}\n` +
    `Cooldown: ${AUTO_HIT_CYCLE.cooldownSec}s per ticker+side\n` +
    `Last fire: ${lastStr}\n` +
    `Categories: CRYPTO + COMMODITIES (15m only)`);
});

bot.onText(/\/go_auto_hit_config (\d+\.?\d*) (\d+\.?\d*) (\d+\.?\d*) (\d+)/, (msg, m) => {
  // /auto_hit_config <minEdge> <minConf> <minVolume> <maxPlays>
  const [, minEdge, minConf, minVol, maxPlays] = m;
  AUTO_HIT_CYCLE.minEdge = parseFloat(minEdge);
  AUTO_HIT_CYCLE.minConf = parseFloat(minConf);
  AUTO_HIT_CYCLE.minVolume = parseFloat(minVol);
  AUTO_HIT_CYCLE.maxPlaysPerCycle = parseInt(maxPlays);
  bot.sendMessage(msg.chat.id,
    `✅ AUTO-HIT CONFIG UPDATED\n` +
    `Min edge: ${pp(AUTO_HIT_CYCLE.minEdge)} | Min conf: ${pct(AUTO_HIT_CYCLE.minConf)} | Min vol: $${AUTO_HIT_CYCLE.minVolume} | Max plays: ${AUTO_HIT_CYCLE.maxPlaysPerCycle}`);
});

bot.onText(/\/stop_bot/, (msg) => {
  botState.isRunning = false;
  saveState();
  bot.sendMessage(msg.chat.id, '⛔ Bot stopped. No new trades will be placed.');
});

bot.onText(/\/panic/, (msg) => {
  botState.isRunning = false;
  if (botState.risk) { botState.risk.emergencyHalt = true; botState.risk.haltReason = 'manual /panic'; }
  const n = botState.pendingBets.length;
  botState.pendingBets = [];
  try { stopBinanceTradeStream(); } catch (_) {}
  saveState();
  bot.sendMessage(msg.chat.id,
    `🛑 PANIC\n\nBot STOPPED and ${n} pending trade(s) wiped.\n` +
    `⚠️ Your ${botState.openBets.length} OPEN position(s) are already live on Kalshi and are NOT cancelled here — ` +
    `manage those on kalshi.com if needed.\n\nUse /start_bot to resume.`);
});

bot.onText(/\/clear_pending/, (msg) => {
  const n = botState.pendingBets.length;
  botState.pendingBets = [];
  saveState();
  bot.sendMessage(msg.chat.id, `🧹 Cleared ${n} pending trade(s). Open positions untouched.`);
});

bot.onText(/\/check_now/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔍 Scanning crypto & commodities now...');
  await checkAndScan();
  await checkCommoditiesOnce();
  bot.sendMessage(msg.chat.id, '✅ Scan complete.');
});

// Opportunity radar — full quant read on every live crypto market/timeframe.
bot.onText(/\/radar/, async (msg) => {
  bot.sendMessage(msg.chat.id, '📡 Scanning live markets (15m cycle first)...');
  const analyses = [];
  for (const spec of cryptoMarketSpecsPrefer15m()) {
    let a;
    try { a = await analyzeCryptoMarket(spec.asset, spec.series); } catch (e) { a = { asset: spec.asset, series: spec.series, error: e.message }; }
    analyses.push(a);
    await sleep(350);
  }
  await bot.sendMessage(msg.chat.id,
    `📡 RADAR · ${quantCyclePhase().label} · edge bar ${(activeEdgeBar() * 100).toFixed(0)}pp · budget ${windowLeft()}/${WINDOW_PROPOSAL_MAX}\n` +
    `🟢▲ up · 🔴▼ down · 🎯 tradeable now\n\n` +
    renderRadar(analyses));
  // Tap-to-fire buttons for the best tradeable plays (respects the window budget).
  const buys = analyses
    .filter(a => quantTradeable(a))
    .sort((x, y) => {
      const xb = settleBoost(x.minsToClose) + (x.edge || 0);
      const yb = settleBoost(y.minsToClose) + (y.edge || 0);
      return yb - xb;
    })
    .slice(0, Math.max(6, WINDOW_PROPOSAL_MIN));
  let proposed = 0;
  const blocked = [];
  for (const a of buys) {
    if (windowLeft() <= 0) { blocked.push('window budget full'); break; }
    if (!windowGate(a.ticker, a.side)) { blocked.push(`${a.asset}: already proposed this window`); continue; }
    const features = buildFeatures(a);
    const review = ownerReview({ asset: a.asset, side: a.side, winProb: a.winProb, features, category: 'CRYPTO' });
    if (!review.ok) { blocked.push(`${a.asset} ${a.side}: ${review.note}`); continue; }
    windowMark(a.ticker, a.side);
    const b = Math.max(0.1, (1 - a.price) / a.price);
    const betAmount = calculateKellyBetSize(review.prob, b);
    const meta = { features, patternKey: review.patternKey, market: a.market, ticker: a.ticker, series: a.series, tf: a.tf };
    const pending = {
      id: Date.now() + Math.floor(Math.random() * 1000), type: 'crypto', asset: a.asset,
      analysis: { price: a.S },
      play: { side: a.side, winProb: review.prob, dir: 'quant', move: a.edge * 100 },
      side: a.side, betAmount, meta, market: a.market, ticker: a.ticker,
      timestamp: Date.now()
    };
    botState.pendingBets.push(pending);
    saveState();
    proposed++;
    await bot.sendMessage(msg.chat.id,
      quantDecisionCard(a, review.prob, betAmount, review.note, pending.id),
      proposalKeyboard(pending.id));
  }
  if (proposed === 0) {
    const errs = analyses.filter(a => a && a.error).map(a => `${a.asset}${a.series ? '['+a.series+']' : ''}: ${a.error}`);
    const near = analyses.filter(a => a && !a.error && a.side).sort((x,y)=>(y.edge||0)-(x.edge||0)).slice(0,5)
      .map(a => `${a.asset}${a.tf?' '+a.tf:''} ${a.side.toUpperCase()} edge ${pp(a.edge)} win ${pct(a.winProb)} @ ${cents(a.price)}`);
    await bot.sendMessage(msg.chat.id,
      `🕳 No playable cards right now.\n` +
      `Bar: edge ≥ ${pp(activeEdgeBar())} · conf ≥ ${pct(activeConfBar())} · phase ${quantCyclePhase().name} · budget ${windowLeft()}/${WINDOW_PROPOSAL_MAX}\n` +
      (near.length ? `Closest reads:\n${near.join('\n')}\n` : 'No live side/edge computed.\n') +
      (blocked.length ? `Blocked by gates:\n${blocked.slice(0,6).join('\n')}\n` : '') +
      (errs.length ? `Market errors:\n${errs.slice(0,6).join('\n')}\n` : '') +
      `Try /debug_scan · /scout · or wait for next 15m cycle.`);
  }

});

// Scout longshots + niche/obscure plays on demand.
bot.onText(/\/scout/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔎 Scouting best niches…');
  const n = await runScouts({ preferShort: true, moreNiche: false });
  bot.sendMessage(msg.chat.id, n ? `✅ Surfaced ${n} scout play(s) — tap ✅ on any to fire.` : '🫥 No scout plays clear the bar right now. Try /debug_scan.');
});

bot.onText(/\/quant_niche/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🧪 Quant-niche scan…');
  try {
    const rows = await scanQuantNiche({ preferShort: true });
    let n = 0;
    for (const row of rows) {
      if (n >= QUANT_NICHE_WINDOW_MAX) break;
      if (await proposeQuantNiche(row)) n++;
    }
    bot.sendMessage(msg.chat.id, n
      ? `✅ Surfaced ${n} quant-niche play(s) from ${rows.length} researched candidates.`
      : `🫥 No quant-niche clears score≥${QUANT_NICHE_MIN_SCORE} / EV≥${pct(QUANT_NICHE_MIN_EV)} right now.`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Quant-niche error: ${e.message}`);
  }
});

// Hourly cycle status + latest deposit
bot.onText(/\/cycle/, async (msg) => {
  resetCycleRuntimeIfNeeded();
  const phase = quantCyclePhase();
  const d = dep();
  const id = currentCycleId();
  const cur = (d.cycles || []).find(c => c.id === id);
  const lines = [
    `⏱ 15m CYCLE ${id}`,
    `Mode: ${phase.label}`,
    `Bar ${pp(CRYPTO_EDGE_THRESHOLD)} · conf ${pct(RISK_RULES.minConfidenceToTrade)} · max ${QUANT_FIRE_MAX}`,
    `This window: scans ${_cycleState.scanCount || 0} · sent ${_cycleState.proposed || 0}`,
    `Budget left: ${windowLeft()}/${WINDOW_PROPOSAL_MAX}`
  ];
  if (_cycleState.bestEdges && _cycleState.bestEdges.length) {
    lines.push('Best edges seen:');
    for (const b of _cycleState.bestEdges.slice(0, 5)) {
      lines.push(`· ${b.asset} ${String(b.side || '').toUpperCase()} ${b.edge != null ? pp(b.edge) : '?'} ${b.tradeable === false ? '(blocked)' : ''}`);
    }
  }
  if (_cycleState.researchBits && _cycleState.researchBits.length) {
    lines.push('Research:');
    for (const r of _cycleState.researchBits.slice(0, 4)) lines.push(`· ${r}`);
  }
  if (cur) lines.push(`Deposit snapshot: p${cur.proposed || 0}/t${cur.taken || 0} final=${!!cur.final}`);
  else lines.push('Deposit: not written yet (snapshots every ~4 scans + hour-end).');
  const prev = (d.cycles || []).filter(c => c.id !== id).slice(0, 3);
  if (prev.length) {
    lines.push('Prior cycles:');
    for (const c of prev) lines.push(`· ${c.id} p${c.proposed || 0}/t${c.taken || 0} ${c.phaseAtWrite || ''}`);
  }
  lines.push('', 'Commands: /analysis · /plays · /memory');
  await bot.sendMessage(msg.chat.id, lines.join('\n').slice(0, 3500));
});

// Data-driven analysis from cycle deposits + play ledger
bot.onText(/\/analysis/, async (msg) => {
  ensureMemoryShape();
  const linesOut = ['📊 DATA-DRIVEN ANALYSIS', ...cycleAnalysisBrief(8)];
  const d = dep();
  const sides = Object.entries(d.sides || {}).filter(([, v]) => (v.trades || 0) >= 3)
    .sort((a, b) => (b[1].trades || 0) - (a[1].trades || 0)).slice(0, 6);
  if (sides.length) {
    linesOut.push('', 'Side buckets:');
    for (const [k, v] of sides) {
      const s = bucketStats(v);
      linesOut.push(`· ${k}: ${pct(s.winRate)} / ${s.n} · ${s.net >= 0 ? '+' : ''}${money(s.net)}`);
    }
  }
  for (const cat of ['CRYPTO', 'QUANT_NICHE', 'NICHE', 'LONGSHOT', 'WEATHER', 'COMMODITY']) {
    const cs = categoryStats(cat, 30);
    if (cs) linesOut.push(`Mem ${cat}: ${cs.wins}/${cs.n} (${pct(cs.winRate)}) net ${cs.net >= 0 ? '+' : ''}${money(cs.net)}`);
  }
  const plays = d.plays || [];
  if (plays.length) {
    const taken = plays.filter(p => p.taken).length;
    linesOut.push('', `Play take-rate: ${taken}/${plays.length} (${pct(taken / Math.max(1, plays.length))})`);
    const byPhase = {};
    for (const p of plays.slice(0, 100)) {
      const ph = p.phase || 'n/a';
      if (!byPhase[ph]) byPhase[ph] = { n: 0, taken: 0 };
      byPhase[ph].n++; if (p.taken) byPhase[ph].taken++;
    }
    for (const [ph, v] of Object.entries(byPhase)) linesOut.push(`· phase ${ph}: sent ${v.n} taken ${v.taken}`);
  }
  if ((d.research || []).length) {
    linesOut.push('', 'Recent research snapshots:');
    for (const r of d.research.slice(0, 3)) {
      linesOut.push(`· ${new Date(r.t).toLocaleString()} ${r.label || r.kind}`);
      for (const t of (r.top || []).slice(0, 2)) linesOut.push(`  — ${t}`);
    }
  }
  let buf = linesOut.join('\n');
  while (buf.length) {
    await bot.sendMessage(msg.chat.id, buf.slice(0, 3500));
    buf = buf.slice(3500);
  }
});

// Every play the bot sent you (including skipped)
bot.onText(/\/plays(?:\s+(\d+))?/i, async (msg, match) => {
  ensureMemoryShape();
  const limit = Math.min(30, parseInt(match[1] || '12', 10) || 12);
  const plays = (dep().plays || []).slice(0, limit);
  if (!plays.length) {
    bot.sendMessage(msg.chat.id, 'No plays logged yet — once the bot sends cards they land here even if you skip.');
    return;
  }
  const linesOut = [`🧾 PLAY LEDGER (last ${plays.length})`, `Total logged: ${(dep().plays || []).length} · proposals ${(dep().stats || {}).playsLogged || 0}`];
  for (const p of plays) {
    linesOut.push(
      `${p.taken ? '✅' : '·'} ${p.category || '?'} ${p.asset || '?'} ${String(p.side || '').toUpperCase()} ` +
      `${p.edge != null ? pp(p.edge) : ''} ${p.winProb != null ? pct(p.winProb) : ''} ` +
      `${p.phase || ''} ${p.ticker || ''}`.trim()
    );
  }
  linesOut.push('', 'Tip: /analysis for flows · /memory');
  let buf = linesOut.join('\n');
  while (buf.length) {
    await bot.sendMessage(msg.chat.id, buf.slice(0, 3500));
    buf = buf.slice(3500);
  }
});

bot.onText(/\/research/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🌐 Pulling online research backbone...');
  try {
    const linesOut = ['🌐 RESEARCH BACKBONE'];
    const fng = await getNewsSentiment('BTC');
    const global = await getBtcDominanceResearch();
    const news = await getCryptoHeadlinesResearch();
    linesOut.push(`F&G: ${fng.label} (score ${fng.score})`);
    linesOut.push(`Global: ${global.label}`);
    linesOut.push(`Headlines: ${news.label}`);
    for (const a of Object.keys(CRYPTO_SERIES).slice(0, 6)) {
      const md = await getAssetMarketResearch(a);
      linesOut.push(`${a}: ${md.label}`);
    }
    if (news.top && news.top.length) {
      linesOut.push('', 'Top headlines:');
      for (const t of news.top.slice(0, 5)) linesOut.push(`· ${t.title} (${t.source})`);
    }
    const bundle = await getFullResearchBundle('BTC');
    linesOut.push('', `Combined BTC research score: ${bundle.score.toFixed(2)}`);
    for (const b of bundle.bits) linesOut.push(`· ${b}`);
    await bot.sendMessage(msg.chat.id, linesOut.join('\n').slice(0, 3500));
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Research error: ${e.message}`);
  }
});

// Live diagnostic: raw edges, errors, owner-review — why plays aren't firing.

bot.onText(/\/strategy(?:\s+(BTC|ETH|SOL|DOGE|XRP|ADA|AVAX|LINK))?/i, async (msg, match) => {
  const asset = (match[1] || 'BTC').toUpperCase();
  bot.sendMessage(msg.chat.id, `📐 Strategy read ${asset}…`);
  try {
    let closes = await getMinuteSeriesCached(asset);
    if (!closes || closes.length < 100) closes = await fetchHistoricalCloses(asset, '1m', 300);
    if (!closes || closes.length < 100) {
      bot.sendMessage(msg.chat.id, 'Not enough bars yet — try again in a minute.');
      return;
    }
    const ind = computeIndicators(closes);
    const sig = tradingBot.calculateSignals(closes);
    const sma = { fast: ind.sma50, slow: ind.sma100, trend: ind.smaTrend, cross: ind.smaCross };
    const lines = [
      `${(assetColor(asset).emoji || '⚪')} ${asset} STRATEGY`,
      `Spot ${money(ind.spot, asset === 'DOGE' ? 4 : 2)}`,
      '',
      '📈 TREND (SMA 50 / 100)',
      `SMA50 ${sma.fast != null ? money(sma.fast, 2) : 'n/a'} · SMA100 ${sma.slow != null ? money(sma.slow, 2) : 'n/a'}`,
      `Trend: ${sma.trend || 'flat'} · Cross: ${sma.cross || 'none'}`,
      sma.cross === 'bull' ? '→ BUY bias (50 crossed above 100)' : null,
      sma.cross === 'bear' ? '→ EXIT/FADE bias (50 crossed below 100)' : null,
      '',
      '↩️ MEAN REVERSION (RSI + Bollinger)',
      `RSI ${ind.rsi != null ? ind.rsi.toFixed(1) : '?'} · %B ${ind.bbPercent != null ? ind.bbPercent.toFixed(2) : '?'}`,
      `BB ${ind.bbLower != null ? money(ind.bbLower, 2) : '?'} – ${ind.bbUpper != null ? money(ind.bbUpper, 2) : '?'}`,
      sig.buy ? '→ MR BUY (RSI<30 & below lower band)' : null,
      sig.sell ? '→ MR SELL (RSI>70 & above upper band)' : null,
      '',
      `Combined: ${ind.strategyBias ? ind.strategyBias.label : 'n/a'}${ind.strategyBias && ind.strategyBias.clear ? ' ✓ clear shift' : ' · waiting for clear shift'}`,
      ind.strategyBias && ind.strategyBias.bits && ind.strategyBias.bits.length
        ? ind.strategyBias.bits.map(b => `• ${b}`).join('\n') : null,
      '',
      `Stop ref: ${pct(RISK_RULES.stopLossPct)} · Size unit ${pct(RISK_RULES.positionSizePct)} · Max ${pct(RISK_RULES.maxPerTradePercent)}`
    ].filter(x => x != null);
    await bot.sendMessage(msg.chat.id, lines.join('\n').slice(0, 3500));
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Strategy error: ${e.message}`);
  }
});

bot.onText(/\/backtest(?:\s+(BTC|ETH|SOL|DOGE|XRP|ADA|AVAX|LINK))?(?:\s+(\d+m|\d+h|1d))?/i, async (msg, match) => {
  const asset = (match[1] || 'BTC').toUpperCase();
  const interval = (match[2] || '1m').toLowerCase();
  bot.sendMessage(msg.chat.id, `🧪 Backtesting ${asset} ${interval} (SMA cross + RSI/BB)…`);
  try {
    const r = await runAssetBacktest(asset, interval, 500);
    if (r.error) { bot.sendMessage(msg.chat.id, `Backtest failed: ${r.error}`); return; }
    const lines = [
      `🧪 BACKTEST ${r.asset} · ${r.interval} · ${r.bars} bars`,
      `Trades ${r.trades} · Win ${pct(r.win_rate)} (${r.wins}W/${r.losses}L)`,
      `P&L (1u/trade): ${r.profit_loss >= 0 ? '+' : ''}${r.profit_loss.toFixed(2)}u`,
      ''
    ];
    if (r.byKind) {
      for (const [k, v] of Object.entries(r.byKind)) {
        lines.push(`· ${k}: n${v.n} wr ${v.n ? pct(v.wins / v.n) : '0%'} pnl ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(1)}`);
      }
    }
    lines.push('', 'Sim uses next-bar direction @ flat 50¢ — directional skill check, not Kalshi odds.');
    await bot.sendMessage(msg.chat.id, lines.join('\n').slice(0, 3500));
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Backtest error: ${e.message}`);
  }
});

bot.onText(/\/risk/, async (msg) => {
  ensureRiskDay();
  const equity = portfolioEquity();
  const r = botState.risk || {};
  const start = r.dayStartEquity || equity;
  const dayPnl = r.dayPnl || 0;
  const dayPct = start > 0 ? dayPnl / start : 0;
  const peak = r.peakEquity || equity;
  const dd = peak > 0 ? (equity - peak) / peak : 0;
  const gate = checkRiskLimits();
  const lines = [
    '🛡 RISK ENGINE',
    `Equity ~${money(equity)} (bankroll ${money(BANKROLL)} + realized ${money(botState.stats.totalProfit || 0)})`,
    `Day P&L: ${dayPnl >= 0 ? '+' : ''}${money(dayPnl)} (${dayPct >= 0 ? '+' : ''}${pct(dayPct)})`,
    `Peak DD: ${pct(dd)} (max ${pct(RISK_RULES.maxDrawdown)})`,
    `Daily loss limit ${pct(RISK_RULES.dailyLossLimit)} · Emergency ${pct(RISK_RULES.emergencyStopPct)}`,
    `Size unit ${pct(RISK_RULES.positionSizePct)} · Max/trade ${pct(RISK_RULES.maxPerTradePercent)} · Stop ref ${pct(RISK_RULES.stopLossPct)}`,
    `Open exposure ${money(currentExposure())}`,
    `Gate: ${gate.ok ? '✅ OPEN' : '⛔ ' + gate.reason}`,
    r.emergencyHalt ? `🛑 HALT: ${r.haltReason}` : 'Running normally',
    '',
    'Commands: /strategy BTC · /backtest ETH · /panic'
  ];
  await bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/\/debug_scan/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🧪 Debug scan — markets, edges, owner gates...');
  const lines = [];
  lines.push(`Running: ${botState.isRunning ? 'YES' : 'NO — send /start_bot'}`);
  lines.push(`DRY_RUN: ${DRY_RUN} · Owner: ${OWNER_MODE} · Auto-fire: ${autoExecuteEnabled}`);
  lines.push(`Hour ${currentCycleId()} · phase ${quantCyclePhase().label}`);
  lines.push(`Edge bar ${pp(activeEdgeBar())} (pattern ${pp(CRYPTO_EDGE_THRESHOLD)} / edge ${pp(CRYPTO_EDGE_THRESHOLD_EDGE)}) · conf ${pct(activeConfBar())}`);
  lines.push(`Window budget left ${windowLeft()}/${WINDOW_PROPOSAL_MAX}`);
  lines.push(`Series: ${cryptoMarketSpecs().map(s => s.series).join(', ')}`);
  const prices = await getAllSpotPrices();
  lines.push(`Spot: ${prices ? Object.entries(prices).map(([k,v]) => `${k}=${v}`).join(' ') : 'FETCH FAILED (CoinGecko?)'}`);
  if (prices) for (const asset of Object.keys(CRYPTO_SERIES)) if (prices[asset]) recordPrice(asset, prices[asset]);

  const analyses = [];
  for (const spec of cryptoMarketSpecsPrefer15m()) {
    try { analyses.push(await analyzeCryptoMarket(spec.asset, spec.series)); }
    catch (e) { analyses.push({ asset: spec.asset, series: spec.series, error: e.message }); }
    await sleep(250);
  }
  for (const a of analyses) {
    if (!a) continue;
    if (a.error) { lines.push(`❌ ${a.asset}[${a.series||'?'}]: ${a.error}`); continue; }
    const review = a.side ? ownerReview({ asset: a.asset, side: a.side, winProb: a.winProb, features: buildFeatures(a), category: 'CRYPTO' }) : null;
    lines.push(
      `${quantTradeable(a) ? '🎯' : '·'} ${a.asset}${a.tf ? ' '+a.tf : ''} ${a.side ? a.side.toUpperCase() : '--'} ` +
      `edge ${pp(a.edge||0)} win ${pct(a.winProb||0)} @ ${cents(a.price||0)} · ${quantTradeable(a) ? 'TRADEABLE' : 'below-bar'}` +
      (review ? ` · owner ${review.ok ? 'PASS' : 'VETO'}: ${review.note}` : '')
    );
  }
  for (const cat of ['CRYPTO', 'WEATHER', 'COMMODITY', 'LONGSHOT', 'NICHE', 'QUANT_NICHE']) {
    const cs = categoryStats(cat, 30);
    if (cs) lines.push(`Mem ${cat}: n=${cs.n} wr=${pct(cs.winRate)} net=$${cs.net.toFixed(2)}`);
  }
  let buf = lines.join('\n');
  while (buf.length) {
    const chunk = buf.slice(0, 3500);
    buf = buf.slice(3500);
    await bot.sendMessage(msg.chat.id, chunk);
  }
});

// Toggle adaptive auto-radar posting.
let autoRadarEnabled = RADAR_AUTO;
bot.onText(/\/radar_auto (on|off)/i, (msg, m) => {
  autoRadarEnabled = m[1].toLowerCase() === 'on';
  bot.sendMessage(msg.chat.id, autoRadarEnabled ? '📡 Auto-radar ON — hunts each 15-min cycle.' : '📡 Auto-radar OFF — use /radar manually.');
});

// /gomakemoney — same researched proposal path as /radar + quant engine.
// Ranks live crypto (15m first, then other configured TFs), weather, commodities,
// and longshots, then surfaces the single best play with ✅/❌ approval.
bot.onText(/\/gomakemoney/, async (msg) => {
  bot.sendMessage(msg.chat.id, '🔎 Hunting researched crypto / weather / commodity plays (same logic as radar)...');
  const candidates = [];

  // 1) Quant crypto — data-driven model edge vs Kalshi odds (prefer 15m cycle)
  try {
    const prices = await getAllSpotPrices();
    if (prices) for (const asset of Object.keys(CRYPTO_SERIES)) if (prices[asset]) recordPrice(asset, prices[asset]);
    for (const spec of cryptoMarketSpecsPrefer15m()) {
      try {
        const a = await analyzeCryptoMarket(spec.asset, spec.series);
        if (!a || a.error || !a.side) continue;
        if (!quantTradeable(a)) continue;
        const features = buildFeatures(a);
        const review = ownerReview({ asset: a.asset, side: a.side, winProb: a.winProb, features, category: 'CRYPTO' });
        if (!review.ok) continue;
        candidates.push({
          kind: 'quant',
          score: a.edge + settleBoost(a.minsToClose),
          a: { ...a, winProb: review.prob },
          review,
          features
        });
      } catch (e) { console.error(`gomakemoney quant ${spec.asset}/${spec.series}:`, e.message); }
      await sleep(300);
    }
  } catch (e) { console.error('gomakemoney crypto:', e.message); }

  // 2) Weather edges (NWS model vs market) — only if they clear owner review
  try {
    for (const opp of await scanWeatherEdge()) {
      const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
      const review = ownerReview({ asset: `WX:${opp.cityCode}`, side: opp.side, winProb, features: { edge: opp.edge }, category: 'WEATHER' });
      if (!review.ok) continue;
      candidates.push({ kind: 'weather', opp, score: Math.abs(opp.edge), review });
    }
  } catch (e) { console.error('gomakemoney weather:', e.message); }

  // 3) Commodity edges
  try {
    for (const opp of await scanCommodityEdge()) {
      const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
      const review = ownerReview({ asset: `CM:${opp.code}`, side: opp.side, winProb, features: { edge: opp.edge }, category: 'COMMODITY' });
      if (!review.ok) continue;
      candidates.push({ kind: 'commodity', opp, score: Math.abs(opp.edge), review });
    }
  } catch (e) { console.error('gomakemoney commodity:', e.message); }

  // 4) Modeled longshots (asymmetric crypto) as a last-ditch researched option
  try {
    for (const ls of (await scanLongshots()).slice(0, 6)) {
      const review = ownerReview({ asset: ls.asset, side: ls.side, winProb: ls.prob, features: { edge: ls.ev }, category: 'LONGSHOT' });
      if (!review.ok) continue;
      // score longshots by EV but lightly so true high-edge quant plays still win
      candidates.push({ kind: 'longshot', ls, score: Math.min(ls.ev * 0.15, 0.25), review });
    }
  } catch (e) { console.error('gomakemoney longshot:', e.message); }

  if (candidates.length === 0) {
    bot.sendMessage(msg.chat.id,
      `🕳 Nothing clears the researched bar right now.\n` +
      `• Quant needs live 15m markets + CoinGecko price series\n` +
      `• Edge bar: ≥${(activeEdgeBar() * 100).toFixed(0)}pp · conf ${(activeConfBar() * 100).toFixed(0)}% · phase ${quantCyclePhase().name}\n` +
      `Try /radar for a full board, or wait for the next 15-min cycle.`);
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best.kind === 'quant') {
    const a = best.a;
    const label = `${THRESHOLDS[a.asset]?.name || a.asset}${a.tf ? ' ' + a.tf : ''}`;
    bot.sendMessage(msg.chat.id,
      `🏆 Best researched play: ${label} ${a.side.toUpperCase()}\n` +
      `Edge ${(a.edge * 100).toFixed(1)}pp · model ${(a.modelProb * 100).toFixed(0)}% · owner: ${best.review.note}`);
    // Reuse the same proposal path as quant/radar so approval works identically
    const b = Math.max(0.1, (1 - a.price) / a.price);
    const betAmount = calculateKellyBetSize(a.winProb, b);
    const pending = {
      id: Date.now(),
      type: 'crypto',
      asset: a.asset,
      analysis: { price: a.S },
      play: { side: a.side, winProb: a.winProb, dir: 'quant', move: a.edge * 100 },
      side: a.side,
      betAmount,
      meta: { features: best.features, patternKey: best.review.patternKey, market: a.market, ticker: a.ticker, series: a.series, tf: a.tf },
      market: a.market,
      ticker: a.ticker,
      timestamp: Date.now()
    };
    botState.pendingBets.push(pending); saveState();
    bot.sendMessage(msg.chat.id,
      quantDecisionCard(a, a.winProb, betAmount, best.review.note, pending.id),
      proposalKeyboard(pending.id));
  } else if (best.kind === 'weather') {
    bot.sendMessage(msg.chat.id, `🏆 Best: ${best.opp.cityName} weather ${best.opp.side.toUpperCase()} (edge ${(Math.abs(best.opp.edge) * 100).toFixed(1)}pp)`);
    proposeWeather(best.opp);
  } else if (best.kind === 'commodity') {
    bot.sendMessage(msg.chat.id, `🏆 Best: ${best.opp.name} ${best.opp.side.toUpperCase()} (edge ${(Math.abs(best.opp.edge) * 100).toFixed(1)}pp)`);
    proposeCommodity(best.opp);
  } else if (best.kind === 'longshot') {
    bot.sendMessage(msg.chat.id, `🏆 Best asymmetric: ${best.ls.asset} longshot ${best.ls.side.toUpperCase()}`);
    await proposeLongshot(best.ls);
  }
});

bot.onText(/\/buy (BTC|ETH|SOL|DOGE)(?:\s+([\d.]+))?/i, async (msg, match) => {
  const asset = match[1].toUpperCase();
  const customAmount = match[2] ? parseFloat(match[2]) : null;
  const price = botState.prices[asset];
  if (!price) { bot.sendMessage(msg.chat.id, `❌ No price for ${asset} yet. Run /start_bot and wait a few seconds.`); return; }

  const amount = customAmount || (BANKROLL * RISK_RULES.maxPerTradePercent);
  const capped = Math.min(amount, BANKROLL * RISK_RULES.maxPerTradePercent);
  if (customAmount && customAmount > capped) bot.sendMessage(msg.chat.id, `⚠️ Capped to max-per-trade $${capped.toFixed(2)}.`);

  bot.sendMessage(msg.chat.id, `⏳ Placing YES order on ${asset}...`);
  reservedExposure += capped;
  let orderResult;
  try { orderResult = await placeKalshiOrder(asset, 'yes', capped); } finally { reservedExposure -= capped; }
  if (!orderResult.success) { bot.sendMessage(msg.chat.id, `❌ Order failed: ${orderResult.reason}`); return; }

  const bet = { id: Date.now() + '_' + (++_betIdCounter), asset, entryPrice: price, amount: capped, manual: true, ticker: orderResult.ticker, contractCount: orderResult.contractCount, side: 'yes', timestamp: Date.now(), status: 'open' };
  if (!orderResult.dryRun) { botState.openBets.push(bet); botState.stats.totalBets++; }
  saveState();
  bot.sendMessage(msg.chat.id, orderResult.dryRun
    ? `🧪 DRY RUN — would buy ${orderResult.contractCount} on ${orderResult.ticker} (~$${capped.toFixed(2)})`
    : `✅ REAL ORDER PLACED\nMarket: ${orderResult.ticker}\nContracts: ${orderResult.contractCount}\nCost: ~$${capped.toFixed(2)}\nBet ID: ${bet.id}`);
});

bot.onText(/\/find_market (BTC|ETH|SOL|DOGE)/i, async (msg, match) => {
  const asset = match[1].toUpperCase();
  bot.sendMessage(msg.chat.id, `🔍 Looking up live ${asset} market...`);
  const market = await findLiveMarketTicker(asset);
  if (!market) { bot.sendMessage(msg.chat.id, `❌ No open 15-min market found for ${asset}. Check console.`); return; }
  const hrs = ((new Date(market.close_time) - new Date()) / 3600000).toFixed(1);
  bot.sendMessage(msg.chat.id, `✅ ${market.ticker}\n${market.title}\nCloses in ${hrs}h\nYes ask $${market.yes_ask_dollars} | No ask $${market.no_ask_dollars}`);
});

bot.onText(/\/find_weather(?:\s+([A-Za-z]{3}))?/, async (msg, match) => {
  const code = match[1] ? match[1].toUpperCase() : null;
  if (code && !WEATHER_CITIES[code]) { bot.sendMessage(msg.chat.id, `❌ Unknown city "${code}". Options: ${Object.keys(WEATHER_CITIES).join(', ')}`); return; }
  const codes = code ? [code] : Object.keys(WEATHER_CITIES);
  bot.sendMessage(msg.chat.id, `🌤️ Multi-source weather check: ${codes.join(', ')}...`);
  for (const c of codes) {
    const city = WEATHER_CITIES[c];
    const ens = await getWeatherEnsemble(c);
    if (!ens) { bot.sendMessage(msg.chat.id, `❌ ${city.name}: all free weather sources failed.`); continue; }
    const markets = await findMarketsBySeries(city.kalshiSeriesTicker);
    let text = `🌡️ ${city.name} ensemble high **${ens.tempF.toFixed(1)}°F**\n`;
    text += `σ ${ens.stdDev.toFixed(2)}° · disagree ${ens.disagree.toFixed(2)}° · sources ${ens.sourceCount}\n`;
    text += ens.sources.map(s => `• ${s.name}: ${s.high.toFixed(1)}°F`).join('\n') + '\n';
    if (!markets) {
      text += `\n❌ No open Kalshi markets for ${city.kalshiSeriesTicker}`;
      bot.sendMessage(msg.chat.id, text);
      continue;
    }
    text += `\nKalshi vs model:\n`;
    for (const m of markets.slice(0, 8)) {
      const strike = m.floor_strike != null ? m.floor_strike : m.cap_strike;
      if (strike == null) continue;
      const mp = probAbove(ens.tempF, strike, ens.stdDev);
      const price = parseFloat(m.yes_ask_dollars);
      if (!Number.isFinite(price)) continue;
      const edge = (mp - price) * 100;
      text += `  ≥${strike}°F: mkt ${(price*100).toFixed(0)}¢ vs model ${(mp*100).toFixed(0)}% (${edge>=0?'+':''}${edge.toFixed(1)}pp)\n`;
    }
    bot.sendMessage(msg.chat.id, text);
  }
});

bot.onText(/\/find_commodity(?:\s+([A-Za-z]+))?/, async (msg, match) => {
  const code = match[1] ? match[1].toUpperCase() : null;
  if (code && !COMMODITIES[code]) { bot.sendMessage(msg.chat.id, `❌ Unknown code "${code}". Options: ${Object.keys(COMMODITIES).join(', ')}`); return; }
  const codes = code ? [code] : Object.keys(COMMODITIES);
  bot.sendMessage(msg.chat.id, `🛢️ Checking: ${codes.join(', ')}...`);
  for (const c of codes) {
    const cm = COMMODITIES[c];
    const spot = await getCommoditySpot(c);
    if (spot == null) { bot.sendMessage(msg.chat.id, `❌ ${cm.name}: price fetch failed.`); continue; }
    const markets = await findMarketsBySeries(cm.kalshiSeriesTicker);
    if (!markets) {
      const any = await kalshiRequest('GET', `/markets?series_ticker=${cm.kalshiSeriesTicker}&limit=10`);
      const all = any && any.markets ? any.markets : [];
      if (all.length === 0) {
        bot.sendMessage(msg.chat.id, `❌ ${cm.name}: Kalshi has NO markets at all under "${cm.kalshiSeriesTicker}" — ticker likely needs changing. Pick another from /discover_commodities and set it in .env as KX_${c}=<ticker>, then restart.`);
      } else {
        const statuses = [...new Set(all.map(m => m.status))].join(', ');
        const nextClose = all.map(m => m.close_time).filter(Boolean).sort()[0];
        bot.sendMessage(msg.chat.id, `⏳ ${cm.name}: series "${cm.kalshiSeriesTicker}" exists (${all.length} market(s)) but none are OPEN right now — statuses: ${statuses}. This one trades in windows; it'll go live when a market opens${nextClose ? ` (nearest close ${nextClose})` : ''}.`);
      }
      continue;
    }
    let text = `🛢️ ${cm.name}: spot ${spot} ${cm.unit}\n`;
    for (const m of markets.slice(0, 6)) {
      const mp = probAbove(spot, m.floor_strike, cm.stddev);
      const price = parseFloat(m.yes_ask_dollars);
      const edge = (mp - price) * 100;
      text += `  ${m.floor_strike}: mkt ${(price*100).toFixed(0)}¢ vs model ${(mp*100).toFixed(0)}% (${edge>=0?'+':''}${edge.toFixed(1)}pp)\n`;
    }
    bot.sendMessage(msg.chat.id, text);
  }
});

bot.onText(/\/discover_commodities/i, async (msg) => {
  bot.sendMessage(msg.chat.id, `🔍 Asking Kalshi for its commodity series (so you can set the real tickers)...`);
  let data = await kalshiRequest('GET', `/series?category=Commodities`);
  if (!data || !data.series || data.series.length === 0) data = await kalshiRequest('GET', `/series`);
  if (!data || !data.series) { bot.sendMessage(msg.chat.id, `❌ Could not fetch series list. Check console.`); return; }
  const groups = { OIL: ['oil','crude','wti','brent'], NATGAS: ['natural gas','natgas','henry hub'], GOLD: ['gold'], SILVER: ['silver'] };
  let text = `📋 ${data.series.length} series scanned. Commodity matches:\n\n`;
  for (const [g, terms] of Object.entries(groups)) {
    const matches = data.series.filter(s => terms.some(t => (s.title||'').toLowerCase().includes(t) || (s.ticker||'').toLowerCase().includes(t)));
    text += `${g}:\n`;
    if (matches.length) matches.slice(0,5).forEach(m => { text += `  ${m.ticker} — ${m.title}\n`; });
    else text += `  (none found)\n`;
    text += '\n';
  }
  text += `➡️ Put the right tickers in .env as KX_OIL / KX_NATGAS / KX_GOLD / KX_SILVER, then restart.`;
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/discover_crypto/i, async (msg) => {
  bot.sendMessage(msg.chat.id, `🔍 Asking Kalshi for its crypto series (15m + any other offered)...`);
  let data = await kalshiRequest('GET', `/series?category=Crypto`);
  if (!data || !data.series || data.series.length === 0) data = await kalshiRequest('GET', `/series`);
  if (!data || !data.series) { bot.sendMessage(msg.chat.id, `❌ Could not fetch series list. Check console.`); return; }
  const groups = {
    BTC: ['btc', 'bitcoin'], ETH: ['eth', 'ethereum'], SOL: ['sol', 'solana'], DOGE: ['doge', 'dogecoin'],
    XRP: ['xrp', 'ripple'], ADA: ['ada', 'cardano'], AVAX: ['avax', 'avalanche'], LINK: ['link', 'chainlink'],
    MATIC: ['matic', 'polygon'], LTC: ['ltc', 'litecoin'], DOT: ['dot', 'polkadot'], SHIB: ['shib'],
    PEPE: ['pepe'], SUI: ['sui'], APT: ['apt'], NEAR: ['near'], TON: ['ton'], TRX: ['trx', 'tron']
  };
  let text = `📋 ${data.series.length} series scanned. Crypto matches:\n\n`;
  const claimed = new Set();
  for (const [g, terms] of Object.entries(groups)) {
    const matches = data.series.filter(s => terms.some(t => (s.ticker || '').toLowerCase().includes(t) || (s.title || '').toLowerCase().includes(t)));
    text += `${g}:\n`;
    if (matches.length) matches.slice(0, 12).forEach(m => {
      claimed.add(m.ticker);
      text += `  ${m.ticker} — ${m.title}${m.frequency ? ' (' + m.frequency + ')' : ''}\n`;
    });
    else text += `  (none found)\n`;
    text += '\n';
  }
  // Any remaining crypto series Kalshi offers that we didn't bucket above.
  const extras = data.series.filter(s => !claimed.has(s.ticker)).slice(0, 20);
  if (extras.length) {
    text += `OTHER:\n`;
    extras.forEach(m => { text += `  ${m.ticker} — ${m.title}${m.frequency ? ' (' + m.frequency + ')' : ''}\n`; });
    text += '\n';
  }
  text += `➡️ Wire series into .env, then restart:\n` +
    `KX_BTC_SERIES=KXBTC15M,KXBTCH,KXBTCD\n` +
    `(same for KX_ETH_SERIES / KX_SOL_SERIES / KX_DOGE_SERIES)\n` +
    `Extra coins: KX_EXTRA_CRYPTO_SERIES=XRP:KXXRP15M,ADA:KXADA15M`;
  // Telegram hard-caps messages ~4096 chars
  if (text.length > 3900) text = text.slice(0, 3890) + '\n…(truncated)';
  bot.sendMessage(msg.chat.id, text);
});

// ============================================
// /go_check_15m — scan for 15m crypto markets, alert if found
// ============================================
async function check15mMarkets(chatId) {
  let data = await kalshiRequest('GET', `/series?category=Crypto`);
  if (!data || !data.series || data.series.length === 0) data = await kalshiRequest('GET', `/series`);
  if (!data || !data.series) return { found: false, series: [] };

  const terms = ['15m', '15min', '15-min', 'fifteen'];
  const matches = data.series.filter(s => terms.some(t =>
    (s.ticker || '').toLowerCase().includes(t) || (s.title || '').toLowerCase().includes(t)
  ));
  return { found: matches.length > 0, series: matches };
}

bot.onText(/\/go_check_15m/i, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Scanning Kalshi for 15m crypto markets...');
  const { found, series } = await check15mMarkets(chatId);
  if (found) {
    let text = `🚨 15m MARKETS FOUND (${series.length}):\n\n`;
    series.forEach(s => { text += `• ${s.ticker} — ${s.title}${s.frequency ? ' (' + s.frequency + ')' : ''}\n`; });
    text += `\n➡️ Run /go_auto_hit_on to start trading them.`;
    bot.sendMessage(chatId, text);
    // Also alert owner
    if (chatId !== YOUR_TELEGRAM_ID) bot.sendMessage(YOUR_TELEGRAM_ID, `🚨 15m markets live: ${series.map(s => s.ticker).join(', ')}`);
  } else {
    bot.sendMessage(chatId, '📭 No 15m crypto markets yet. Check back in a few days.');
  }
});

// Auto-scan every 6 hours + notify if 15m appears
setInterval(async () => {
  try {
    const { found, series } = await check15mMarkets(YOUR_TELEGRAM_ID);
    if (found) {
      bot.sendMessage(YOUR_TELEGRAM_ID, `🚨 AUTO-SCAN: 15m markets live!\n${series.map(s => s.ticker).join(', ')}\nRun /go_auto_hit_on`);
    }
  } catch (_) {}
}, 6 * 60 * 60 * 1000);

bot.onText(/\/discover_sports(?:\s+(\w+))?/i, async (msg, match) => {
  const filter = match[1] ? match[1].toUpperCase() : null;
  bot.sendMessage(msg.chat.id, `🔍 Asking Kalshi for its sports series...`);
  let data = await kalshiRequest('GET', `/series?category=Sports`);
  if (!data || !data.series || data.series.length === 0) data = await kalshiRequest('GET', `/series`);
  if (!data || !data.series) { bot.sendMessage(msg.chat.id, `❌ Could not fetch series list.`); return; }
  const keywords = { NBA: ['nba','basketball'], WNBA: ['wnba'], NHL: ['nhl','hockey'], MLB: ['mlb','baseball'] };
  const wanted = filter && keywords[filter] ? { [filter]: keywords[filter] } : keywords;
  let text = `📋 ${data.series.length} series. Matches:\n\n`;
  for (const [sport, terms] of Object.entries(wanted)) {
    const matches = data.series.filter(s => terms.some(t => s.title.toLowerCase().includes(t) || s.ticker.toLowerCase().includes(t)));
    text += `${sport}:\n`;
    if (matches.length) matches.slice(0,5).forEach(m => text += `  ${m.ticker} — ${m.title} (${m.frequency})\n`);
    else text += `  no matches\n`;
    text += '\n';
  }
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/pending/, (msg) => {
  if (botState.pendingBets.length === 0) { bot.sendMessage(msg.chat.id, '📭 No pending trades.'); return; }
  for (const p of botState.pendingBets) {
    let line;
    if (p.type === 'weather') line = `🌤️ #${p.id} ${p.opportunity.cityName} ${p.side.toUpperCase()} · $${p.betAmount.toFixed(2)}`;
    else if (p.type === 'commodity') line = `🛢️ #${p.id} ${p.opportunity.name} ${p.side.toUpperCase()} · $${p.betAmount.toFixed(2)}`;
    else line = `📈 #${p.id} ${THRESHOLDS[p.asset].name} ${p.side.toUpperCase()} · $${p.betAmount.toFixed(2)}`;
    bot.sendMessage(msg.chat.id, line, proposalKeyboard(p.id));
  }
});

bot.onText(/\/approve (\d+)/, async (msg, match) => { await resolvePending(parseInt(match[1]), 'ap', msg.chat.id); });
bot.onText(/\/deny (\d+)/, async (msg, match) => { await resolvePending(parseInt(match[1]), 'dn', msg.chat.id); });

// Inline button handler
bot.on('callback_query', async (q) => {
  bot.answerCallbackQuery(q.id).catch(() => {});
  const chatId = q.message ? q.message.chat.id : YOUR_TELEGRAM_ID;
  const data = q.data || '';
  // Lock-profit buttons.
  const lk = data.match(/^(lk|li)_(\d+)$/);
  if (lk) {
    if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    if (lk[1] === 'li') { bot.sendMessage(chatId, `💤 Riding position #${lk[2]} out.`); return; }
    await lockNow(parseInt(lk[2]), chatId);
    return;
  }
  // Copy trade button
  const cp = data.match(/^cp_(\d+)$/);
  if (cp) {
    const pending = botState.pendingBets.find(b => b.id === parseInt(cp[1]));
    if (pending) {
      const copyText = formatCopyTrade(pending);
      bot.sendMessage(chatId, `📋 <b>Copy Trade Format</b>\n\n<code>${copyText}</code>\n\nTap to copy above`, { parse_mode: 'HTML' });
    } else {
      bot.answerCallbackQuery(q.id, { text: 'Trade not found', show_alert: true }).catch(() => {});
    }
    return;
  }
  // Approve/Deny trade buttons.
  const m = data.match(/^(ap|dn)_(\d+)$/);
  if (!m) return;
  if (q.message) {
    if (m[1] === 'dn') {
      bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
    } else {
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    }
  }
  await resolvePending(parseInt(m[2]), m[1], chatId);
});

async function resolvePending(betId, action, chatId) {
  const pending = botState.pendingBets.find(b => b.id === betId);
  if (!pending) { bot.sendMessage(chatId, `⚠️ Trade #${betId} is no longer pending.`); return; }
  botState.pendingBets = botState.pendingBets.filter(b => b.id !== betId);
  if (action === 'dn') {
    trackShadowPlay(pending, 'denied');
    recordDenialMemory(pending);
    saveState();
    // Message already deleted by callback handler; no new message needed
    return;
  }
  trackShadowPlay(pending, 'approved');
  recordApprovalMemory(pending);
  saveState();
  bot.sendMessage(chatId, `✅ Approved #${betId} — placing...`);
  if (pending.type === 'weather') await executeWeatherTrade(pending);
  else if (pending.type === 'commodity') await executeCommodityTrade(pending);
  else if (pending.type === 'scout') await executeScoutTrade(pending);
  else await executeTrade(pending.asset, pending.analysis, pending.betAmount, pending.side, pending.play, pending.meta || {});
}

bot.onText(/\/status/, (msg) => {
  const status = botState.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
  const exposure = botState.openBets.reduce((s, b) => s + b.amount, 0);
  let text = `${status} · Auto-fire ${autoExecuteEnabled ? 'ON' : 'OFF'}\n\n📊 Prices:\n`;
  text += `BTC $${botState.prices.BTC?.toFixed(2) || 'N/A'} | ETH $${botState.prices.ETH?.toFixed(2) || 'N/A'}\n`;
  text += `SOL $${botState.prices.SOL?.toFixed(2) || 'N/A'} | DOGE $${botState.prices.DOGE?.toFixed(4) || 'N/A'}\n\n`;
  text += `📋 Open: ${botState.openBets.length} | 📨 Pending: ${botState.pendingBets.length}\n`;
  text += `💰 Exposure: $${exposure.toFixed(2)}${reservedExposure > 0 ? ` (+$${reservedExposure.toFixed(2)} in-flight)` : ''}`;
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/balance/, async (msg) => {
  bot.sendMessage(msg.chat.id, '💰 Fetching Kalshi balance...');
  const bal = await getKalshiBalance();
  bot.sendMessage(msg.chat.id, bal == null ? '❌ Could not fetch balance (check console).' : `💰 Kalshi balance: $${bal.toFixed(2)}`);
});

// Full memory + knowledge depository dump.
bot.onText(/\/memory(?:\s+(assets|patterns|series|markets|lessons|notes|denials|cycles|plays|research|all))?/i, (msg, match) => {
  ensureMemoryShape();
  const section = (match[1] || 'all').toLowerCase();
  const d = dep();
  const chunks = [];
  const push = (t) => chunks.push(t);

  push(`🧠 MEMORY DEPOSITORY\nFile: ${MEMORY_FILE}\nUpdated: ${botState.memory.updatedAt ? new Date(botState.memory.updatedAt).toLocaleString() : 'never'}`);
  push(`Stats: proposals ${d.stats.proposals||0} · approvals ${d.stats.approvals||0} · denials ${d.stats.denials||0} · settles ${d.stats.settles||0}`);

  if (section === 'all' || section === 'assets') {
    const assets = botState.memory.assets;
    const akeys = Object.keys(assets);
    let text = '\n📈 Assets:\n';
    if (!akeys.length) text += '(none yet)\n';
    else {
      for (const k of akeys.sort((a, b) => assets[b].netProfit - assets[a].netProfit).slice(0, 12)) {
        const m = assets[k];
        const wr = m.trades ? (m.wins / m.trades * 100).toFixed(0) : '0';
        const cal = m.probSum > 0 ? ` · pred ${(m.probSum / m.trades * 100).toFixed(0)}% vs real ${(m.hitSum / m.trades * 100).toFixed(0)}%` : '';
        text += `• ${k}: ${m.wins}W-${m.losses}L (${wr}%) · ${m.netProfit >= 0 ? '+' : ''}$${m.netProfit.toFixed(2)} streak ${m.streak||0}${cal}\n`;
      }
    }
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'patterns') {
    const pats = Object.entries(botState.memory.patterns).filter(([, p]) => p.trades >= Math.min(3, MIN_SAMPLES_TO_TRUST));
    let text = '\n🔎 Patterns:\n';
    if (!pats.length) text += '(none trusted yet)\n';
    else {
      pats.sort((a, b) => (b[1].wins / Math.max(1,b[1].trades)) - (a[1].wins / Math.max(1,a[1].trades)));
      for (const [k, p] of pats.slice(0, 8)) text += `• ${k}: ${(p.wins / p.trades * 100).toFixed(0)}% / ${p.trades} · ${p.netProfit>=0?'+':''}$${(p.netProfit||0).toFixed(2)}\n`;
    }
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'series') {
    let text = '\n📚 Series buckets:\n';
    const rows = Object.entries(d.series || {});
    if (!rows.length) text += '(none)\n';
    else {
      rows.sort((a,b)=>b[1].trades-a[1].trades);
      for (const [k, v] of rows.slice(0, 10)) {
        const wr = v.trades ? (v.wins / v.trades * 100).toFixed(0) : '0';
        text += `• ${k}: ${v.wins}W-${v.losses}L (${wr}%) · ${v.netProfit>=0?'+':''}$${(v.netProfit||0).toFixed(2)}\n`;
      }
    }
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'markets') {
    let text = '\n🏷️ Markets/tickers:\n';
    const rows = Object.entries(d.markets || {});
    if (!rows.length) text += '(none)\n';
    else {
      rows.sort((a,b)=>(b[1].trades||0)-(a[1].trades||0));
      for (const [k, v] of rows.slice(0, 10)) {
        const wr = v.trades ? (v.wins / v.trades * 100).toFixed(0) : '0';
        text += `• ${k}: ${v.trades||0}t ${wr}% · denials ${v.denials||0}\n`;
      }
    }
    push(text.trimEnd());
  }

  if (section === 'all') {
    const cats = Object.keys(botState.memory.categories || {});
    if (cats.length) {
      let text = '\n🗓️ Categories (30d):\n';
      for (const c of cats) {
        const cs = categoryStats(c, 30);
        if (!cs) continue;
        const flag = (cs.winRate < 0.45 || cs.net < 0) ? '🔴' : '🟢';
        text += `${flag} ${c}: ${cs.wins}/${cs.n} (${(cs.winRate * 100).toFixed(0)}%) · ${cs.net >= 0 ? '+' : ''}$${cs.net.toFixed(2)}\n`;
      }
      push(text.trimEnd());
    }
  }

  if (section === 'all' || section === 'lessons') {
    let text = '\n💡 Lessons:\n';
    const lessons = d.lessons || [];
    if (!lessons.length) text += '(none yet — fills as trades settle)\n';
    else for (const l of lessons.slice(0, 8)) text += `• ${l.text}\n`;
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'notes') {
    let text = '\n📝 Your notes:\n';
    const notes = d.notes || [];
    if (!notes.length) text += '(none — teach me with /remember ...)\n';
    else for (const n of notes.slice(0, 10)) text += `• ${n.text}${n.tags&&n.tags.length? ' ['+n.tags.join(',')+']':''}\n`;
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'denials') {
    let text = '\n🚫 Recent denials (preference learning):\n';
    const den = d.denials || [];
    if (!den.length) text += '(none)\n';
    else for (const x of den.slice(0, 8)) text += `• ${x.asset||'?'} ${String(x.side||'').toUpperCase()} ${x.ticker||''}\n`;
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'cycles') {
    let text = '\n⏳ Hourly cycle deposits:\n';
    const cycles = d.cycles || [];
    if (!cycles.length) text += '(none yet — deposits write each hour even if you skip plays)\n';
    else {
      for (const c of cycles.slice(0, 8)) {
        text += `• ${c.id} p${c.proposed||0}/t${c.taken||0} scans ${c.scanCount||0} ${c.final ? 'FINAL' : 'snap'} ${c.phaseAtWrite||''}\n`;
      }
    }
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'plays') {
    let text = '\n🧾 Play ledger (sent to you):\n';
    const plays = d.plays || [];
    if (!plays.length) text += '(none yet)\n';
    else {
      for (const p of plays.slice(0, 10)) {
        text += `${p.taken ? '✅' : '•'} ${p.category||'?'} ${p.asset||'?'} ${String(p.side||'').toUpperCase()} ${p.edge!=null?pp(p.edge):''} ${p.phase||''}\n`;
      }
      text += `(total ${plays.length} — /plays for more)\n`;
    }
    push(text.trimEnd());
  }

  if (section === 'all' || section === 'research') {
    let text = '\n🌐 Research snapshots:\n';
    const res = d.research || [];
    if (!res.length) text += '(none yet — fills from online backbone)\n';
    else for (const r of res.slice(0, 5)) text += `• ${new Date(r.t).toLocaleString()} ${r.label||r.kind}\n`;
    push(text.trimEnd());
  }

  if (section === 'all') {
    push('\nCommands: /memory assets|patterns|series|markets|lessons|notes|denials|cycles|plays|research\n/cycle · /analysis · /plays · /research\n/remember [note] · /forget_notes · /lessons');
  }

  // send in chunks
  let buf = chunks.join('\n');
  (async () => {
    while (buf.length) {
      await bot.sendMessage(msg.chat.id, buf.slice(0, 3500));
      buf = buf.slice(3500);
    }
  })().catch(e => bot.sendMessage(msg.chat.id, `Memory error: ${e.message}`));
});

// Teach the bot something durable (stored in depository notes).
bot.onText(/\/remember(?:\s+(.+))?/i, (msg, match) => {
  const text = (match[1] || '').trim();
  if (!text) {
    bot.sendMessage(msg.chat.id, 'Usage: /remember avoid thin ETH NO near open\nOptional tags: /remember BTC,15m prefer YES on RSI dip — note text');
    return;
  }
  // If starts with comma-separated tags then em-dash/hyphen note
  let tags = [];
  let body = text;
  const m = text.match(/^([A-Za-z0-9_,\s]{1,40})\s*[—\-:]\s*(.+)$/);
  if (m) {
    tags = m[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
    body = m[2].trim();
  } else {
    // auto tags from known keywords
    for (const t of ['BTC','ETH','SOL','DOGE','CRYPTO','WEATHER','YES','NO','15m','30m','1h']) {
      if (new RegExp('\b' + t + '\b', 'i').test(body)) tags.push(t);
    }
  }
  const note = rememberNote(body, tags);
  bot.sendMessage(msg.chat.id, `📝 Saved to depository${tags.length ? ' ['+tags.join(', ')+']' : ''}:\n${note.text}`);
});

bot.onText(/\/forget_notes/, (msg) => {
  ensureMemoryShape();
  const n = (dep().notes || []).length;
  dep().notes = [];
  botState.memory.updatedAt = Date.now();
  saveState();
  bot.sendMessage(msg.chat.id, `🧹 Cleared ${n} user note(s). Trade history kept.`);
});

bot.onText(/\/lessons/, (msg) => {
  ensureMemoryShape();
  const lessons = dep().lessons || [];
  if (!lessons.length) { bot.sendMessage(msg.chat.id, '💡 No auto-lessons yet — they appear as trades settle.'); return; }
  let text = '💡 Recent lessons from the depository:\n\n';
  for (const l of lessons.slice(0, 15)) text += `• ${l.text}\n`;
  bot.sendMessage(msg.chat.id, text.slice(0, 3500));
});

// Manually trigger a profit-taking sweep now.
bot.onText(/\/take/, async (msg) => {
  if (!PROFIT_TAKE_ENABLED) { bot.sendMessage(msg.chat.id, '💤 Profit-lock alerts are disabled (PROFIT_TAKE_ENABLED=false).'); return; }
  bot.sendMessage(msg.chat.id, `🔎 Checking ${botState.openBets.length} open position(s) for lockable profit...`);
  for (const bet of [...botState.openBets]) { lockAlertAt[bet.id] = 0; } // clear cooldown so /take always re-alerts
  await checkProfitTaking();
  bot.sendMessage(msg.chat.id, '✅ Done — any lockable positions have a 🔒 button above.');
});

// ============================================
// PIMPED /stats
// ============================================
function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}
function currentStreak() {
  const h = botState.settlementHistory;
  if (h.length === 0) return '—';
  const last = h[h.length - 1].result;
  let n = 0;
  for (let i = h.length - 1; i >= 0 && h[i].result === last; i--) n++;
  return `${n}${last === 'win' ? 'W 🔥' : 'L 🧊'}`;
}

bot.onText(/\/stats/, async (msg) => {
  bot.sendMessage(msg.chat.id, '📊 Crunching the numbers...');
  const bal = await getKalshiBalance();
  const s = botState.stats;
  const settled = s.wins + s.losses;
  const winRate = settled > 0 ? (s.wins / settled * 100) : 0;
  const netGainPct = BANKROLL > 0 ? (s.totalProfit / BANKROLL * 100) : 0;
  const avg = settled > 0 ? s.totalProfit / settled : 0;

  const hist = botState.settlementHistory;
  const best = hist.length ? hist.reduce((a, b) => b.profit > a.profit ? b : a) : null;
  const worst = hist.length ? hist.reduce((a, b) => b.profit < a.profit ? b : a) : null;

  const byAsset = {};
  for (const c of botState.closedBets) {
    const k = c.asset || '?';
    byAsset[k] = byAsset[k] || { w: 0, l: 0, p: 0 };
    if (c.won) byAsset[k].w++; else byAsset[k].l++;
    byAsset[k].p += (c.profit || 0);
  }

  const pl = s.totalProfit;
  let t = `💎═══ PERFORMANCE ═══💎\n\n`;
  t += `💰 Kalshi Balance: ${bal == null ? 'N/A' : '$' + bal.toFixed(2)}\n`;
  t += `🏦 Bankroll: $${BANKROLL.toFixed(2)}\n`;
  t += `${pl >= 0 ? '📈' : '📉'} Total P&L: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}  (${netGainPct >= 0 ? '+' : ''}${netGainPct.toFixed(1)}% net)\n\n`;
  t += `🎯 Win Rate: ${winRate.toFixed(1)}%\n${progressBar(winRate)}\n`;
  t += `✅ ${s.wins}W  ❌ ${s.losses}L  ⏳ ${botState.openBets.length} open\n`;
  t += `🔥 Streak: ${currentStreak()}  📊 Settled: ${settled}\n`;
  t += `⚖️ Avg/trade: ${avg >= 0 ? '+' : ''}$${avg.toFixed(2)}\n`;
  if (best) t += `🏆 Best: +$${best.profit.toFixed(2)} (${best.asset})\n`;
  if (worst && worst.profit < 0) t += `💀 Worst: $${worst.profit.toFixed(2)} (${worst.asset})\n`;
  if (Object.keys(byAsset).length) {
    t += `\n📂 By market:\n`;
    for (const [k, v] of Object.entries(byAsset)) t += `  ${k}: ${v.p >= 0 ? '+' : ''}$${v.p.toFixed(2)} (${v.w}W/${v.l}L)\n`;
  }
  t += `\n📨 Pending: ${botState.pendingBets.length} | ⚡ Auto: ${autoExecuteEnabled ? 'ON' : 'OFF'}`;
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/\/check_settlements/, async (msg) => {
  bot.sendMessage(msg.chat.id, `🔍 Checking ${botState.openBets.length} open position(s)...`);
  const before = botState.settlementHistory.length;
  await checkAllSettlements();
  const n = botState.settlementHistory.length - before;
  bot.sendMessage(msg.chat.id, n > 0 ? `✅ ${n} settled.` : `📭 Nothing settled yet. ${botState.openBets.length} still open.`);
});

bot.onText(/\/chart/, async (msg) => {
  if (botState.settlementHistory.length === 0) { bot.sendMessage(msg.chat.id, `📭 No settled trades yet.`); return; }
  const labels = botState.settlementHistory.map((_, i) => `#${i + 1}`);
  const data = botState.settlementHistory.map(h => h.cumulativeProfit.toFixed(2));
  const chartConfig = { type: 'line', data: { labels, datasets: [{ label: 'Cumulative P&L ($)', data, borderColor: 'rgb(75,192,100)', fill: false }] }, options: { title: { display: true, text: 'Trading Progress' } } };
  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  const wr = botState.stats.totalBets > 0 ? ((botState.stats.wins / (botState.stats.wins + botState.stats.losses)) * 100).toFixed(1) : '0.0';
  try { await bot.sendPhoto(msg.chat.id, url, { caption: `📈 ${botState.stats.wins}W/${botState.stats.losses}L (${wr}%) — P&L $${botState.stats.totalProfit.toFixed(2)}` }); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ Chart failed.`); }
});

// ============================================
// /go COMMAND ALIAS — maps /go_<cmd> to /<cmd>
// ============================================
const GO_ALIASES = {
  auto_hit_on: '/auto_hit on',
  auto_hit_off: '/auto_hit off',
  auto_hit_status: '/auto_hit_status',
  start_bot: '/start_bot',
  stop_bot: '/stop_bot',
  check_now: '/check_now',
  radar: '/radar',
  scout: '/scout',
  quant_niche: '/quant_niche',
  cycle: '/cycle',
  analysis: '/analysis',
  plays: '/plays',
  research: '/research',
  strategy: '/strategy',
  backtest: '/backtest',
  risk: '/risk',
  debug_scan: '/debug_scan',
  radar_auto_on: '/radar_auto on',
  radar_auto_off: '/radar_auto off',
  gomakemoney: '/gomakemoney',
  buy: '/buy',
  find_market: '/find_market',
  find_weather: '/find_weather',
  find_commodity: '/find_commodity',
  discover_commodities: '/discover_commodities',
  discover_crypto: '/discover_crypto',
  discover_sports: '/discover_sports',
  pending: '/pending',
  approve: '/approve',
  deny: '/deny',
  status: '/status',
  balance: '/balance',
  memory: '/memory',
  remember: '/remember',
  forget_notes: '/forget_notes',
  lessons: '/lessons',
  take: '/take',
  stats: '/stats',
  check_settlements: '/check_settlements',
  chart: '/chart',
  panic: '/panic',
  clear_pending: '/clear_pending',
  auto_on: '/auto on',
  auto_off: '/auto off'
};

bot.onText(/\/go_?(.+)/, (msg, match) => {
  const full = match[1].trim().toLowerCase();
  const parts = full.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1).join(' ');
  const alias = GO_ALIASES[cmd] || GO_ALIASES[full];
  if (alias) {
    // Re-emit as the real command
    const text = alias + (args ? ' ' + args : '');
    bot.emit('message', { ...msg, text: '/' + text });
  } else {
    bot.sendMessage(msg.chat.id, `❓ Unknown /go command: ${cmd}\nTry: /go_auto_hit_on, /go_radar, /go_start_bot, /go_status, etc.`);
  }
});

// ============================================
// KALSHI API AUTH (RSA-PSS)
// ============================================
function signKalshiRequest(method, path, timestamp) {
  return crypto.sign('sha256', Buffer.from(timestamp + method + path), {
    key: KALSHI_API_SECRET,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
}

// Rate limiter & circuit breaker for Kalshi API
const kalshiRateLimiter = {
  lastCall: 0,
  minInterval: 500, // min ms between calls (2 req/s)
  backoffMs: 1000,
  maxBackoff: 30000,
  failures: 0,
  maxFailures: 5,
  circuitOpen: false,
  circuitOpenTime: 0,
  circuitResetMs: 60000,
  // Semaphore for concurrent request limiting
  activeRequests: 0,
  maxConcurrent: 4,
  waitingQueue: [],
};

async function acquireRateLimitSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (kalshiRateLimiter.activeRequests < kalshiRateLimiter.maxConcurrent) {
        kalshiRateLimiter.activeRequests++;
        resolve();
      } else {
        kalshiRateLimiter.waitingQueue.push(resolve);
      }
    };
    tryAcquire();
  });
}

function releaseRateLimitSlot() {
  kalshiRateLimiter.activeRequests--;
  if (kalshiRateLimiter.waitingQueue.length > 0) {
    const nextResolve = kalshiRateLimiter.waitingQueue.shift();
    kalshiRateLimiter.activeRequests++;
    nextResolve();
  }
}

// Simple cache for market data (TTL: 10 seconds)
const kalshiMarketCache = new Map();
const CACHE_TTL = 10000; // 10 seconds

async function kalshiRequest(method, path, body = null) {
  if (NO_CREDENTIALS_MODE || !HAS_KALSHI_CREDENTIALS) return null;

  // Auto-reset circuit breaker after cooldown
  if (kalshiRateLimiter.circuitOpen && Date.now() - kalshiRateLimiter.circuitOpenTime >= kalshiRateLimiter.circuitResetMs) {
    kalshiRateLimiter.circuitOpen = false;
    kalshiRateLimiter.failures = 0;
    console.log('✅ Circuit breaker RESET — resuming API calls');
  }

  const cacheKey = method + ':' + path;
  const cached = kalshiMarketCache.get(cacheKey);
  if (method === 'GET' && cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }
  // Reject immediately if circuit is open
  if (kalshiRateLimiter.circuitOpen) {
    return null;
  }
  
  // Acquire rate limit slot
  await acquireRateLimitSlot();
  
  try {
    const timestamp = Date.now().toString();
    const signedPath = '/trade-api/v2' + path.split('?')[0];
    let signature;
    try { signature = signKalshiRequest(method, signedPath, timestamp); }
    catch (err) { console.error('Kalshi signing failed:', err.message); return null; }
    
    const headers = {
      'KALSHI-ACCESS-KEY': KALSHI_API_KEY,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json'
    };
    
    let attempt = 0;
    const maxRetries = 3;
    
    while (attempt <= maxRetries) {
      try {
        const response = await axios({ 
          method, 
          url: `${KALSHI_BASE_URL}${path}`, 
          headers, 
          data: body,
          timeout: 10000 
        });
        
        // Success - reset backoff
        kalshiRateLimiter.backoffMs = 1000;
        kalshiRateLimiter.failures = 0;
        
        // Cache successful GET responses
        if (method === 'GET') {
          kalshiMarketCache.set(cacheKey, { data: response.data, ts: Date.now() });
        }
        
        return response.data;
        
      } catch (error) {
        const status = error.response?.status;
        const isRateLimit = status === 429 || status === 503;
        const isServerError = status >= 500;
        const isRetryable = isRateLimit || isServerError;
        
        if (isRetryable && attempt < maxRetries) {
          const waitTime = kalshiRateLimiter.backoffMs + Math.random() * 1000; // jitter
          console.log(`⚠️ Kalshi ${status} — retry in ${Math.round(waitTime)}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(waitTime);
          kalshiRateLimiter.backoffMs = Math.min(kalshiRateLimiter.backoffMs * 2, kalshiRateLimiter.maxBackoff);
          attempt++;
          continue;
        }
        
        // Non-retryable or max retries exceeded
        kalshiRateLimiter.failures++;
        if (kalshiRateLimiter.failures >= kalshiRateLimiter.maxFailures) {
          kalshiRateLimiter.circuitOpen = true;
          kalshiRateLimiter.circuitOpenTime = Date.now();
          console.error('⚡ Circuit breaker OPENED — too many failures');
        }
        console.error(`Kalshi API error (${path}):`, error.response?.data || error.message);
        return null;
      }
    }
    
    return null;
  } finally {
    releaseRateLimitSlot();
  }
}

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function getKalshiBalance() {
  const d = await kalshiRequest('GET', '/portfolio/balance');
  if (!d) return null;
  if (typeof d.balance === 'number') return d.balance / 100; // Kalshi returns cents
  if (typeof d.portfolio_value === 'number') return d.portfolio_value / 100;
  return null;
}

async function findLiveMarketBySeries(seriesTicker) {
  if (!seriesTicker) return null;
  const data = await kalshiRequest('GET', `/markets?series_ticker=${seriesTicker}&status=open&limit=10`);
  if (!data || !data.markets || data.markets.length === 0) return null;
  return data.markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0];
}
async function findLiveMarketTicker(asset) {
  for (const series of (CRYPTO_SERIES[asset] || [])) {
    const m = await findLiveMarketBySeries(series);
    if (m) return m;
  }
  return null;
}

async function findMarketsBySeries(seriesTicker) {
  const data = await kalshiRequest('GET', `/markets?series_ticker=${seriesTicker}&status=open&limit=20`);
  if (!data || !data.markets || data.markets.length === 0) return null;
  return data.markets;
}

// Bulk-fetch ALL open crypto markets per-series, cached 5 min. Skips dead series.
let _bulkMarketCache = { ts: 0, markets: [], bySeries: {} };
const _deadSeries = new Set(); // series that returned 0 markets — skip next time
let _lastDeadRecheck = 0;

// Extract series ticker from market ticker (e.g. "KXBTC15M-26JUL201945-45" → "KXBTC15M")
function extractSeriesFromTicker(m) {
  if (m.series_ticker) return m.series_ticker;
  const t = m.ticker || m.event_ticker || '';
  const dash = t.indexOf('-');
  if (dash > 0) return t.substring(0, dash);
  return '';
}

// Get volume from market (handles old dollar_volume/volume and new volume_fp)
function getMarketVolume(m) {
  if (m.volume_fp != null) return m.volume_fp;
  if (m.dollar_volume != null) return m.dollar_volume;
  if (m.volume != null) return m.volume;
  return 0;
}

async function fetchAllOpenCryptoMarkets() {
  const now = Date.now();
  if (now - _bulkMarketCache.ts < 300000 && _bulkMarketCache.markets.length > 0) return _bulkMarketCache;
  try {
    const allMarkets = [];
    const allSpecs = cryptoMarketSpecs();
    // Only query series that haven't been marked dead, plus re-check dead ones every 10 min
    const uniqueSeries = [...new Set(allSpecs.map(s => s.series))]
      .filter(s => !_deadSeries.has(s) || (now - (_lastDeadRecheck || 0)) > 600000);
    _lastDeadRecheck = now;
    const BATCH = 6;
    for (let i = 0; i < uniqueSeries.length; i += BATCH) {
      const batch = uniqueSeries.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (series) => {
        try {
          const data = await kalshiRequest('GET', `/markets?series_ticker=${series}&status=open&limit=5`);
          return (data?.markets || []).map(m => ({ ...m, _series_ticker: series }));
        } catch (_) { return []; }
      }));
      for (let j = 0; j < batch.length; j++) {
        const series = batch[j];
        if (results[j].length === 0) _deadSeries.add(series);
        else _deadSeries.delete(series);
        allMarkets.push(...results[j]);
      }
    }

    const bySeries = {};
    for (const m of allMarkets) {
      const st = m._series_ticker;
      if (!bySeries[st]) bySeries[st] = [];
      bySeries[st].push(m);
    }
    for (const st of Object.keys(bySeries)) {
      bySeries[st].sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    }
    _bulkMarketCache = { ts: now, markets: allMarkets, bySeries };
  } catch (e) { console.error('Bulk market fetch failed:', e.message); }
  return _bulkMarketCache;
}

// ============================================
// WEATHER MODULE — multi-source free ensemble
// NWS + Open-Meteo + wttr.in (+ optional OpenWeather)
// Consensus high + disagreement-aware stddev → better edges
// ============================================
const WX_UA = { 'User-Agent': '(kalshi-bot/weather-ensemble; contact-not-provided)', Accept: 'application/json' };

function cToF(c) { return (c * 9) / 5 + 32; }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function sampleStd(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

async function getNWSForecastHighF(lat, lon) {
  try {
    const pointRes = await axios.get(`https://api.weather.gov/points/${lat},${lon}`, { headers: WX_UA, timeout: 10000 });
    const forecastUrl = pointRes.data?.properties?.forecast;
    if (!forecastUrl) return null;
    const forecastRes = await axios.get(forecastUrl, { headers: WX_UA, timeout: 10000 });
    const todayHigh = (forecastRes.data?.properties?.periods || []).find(p => p.isDaytime);
    if (!todayHigh || typeof todayHigh.temperature !== 'number') return null;
    // Prefer gridpoint hourly max if available for a tighter high estimate
    let gridHigh = null;
    try {
      const gridUrl = pointRes.data?.properties?.forecastGridData;
      if (gridUrl) {
        const g = await axios.get(gridUrl, { headers: WX_UA, timeout: 10000 });
        const vals = (g.data?.properties?.maxTemperature?.values || [])
          .map(v => v.value)
          .filter(v => typeof v === 'number')
          .map(cToF);
        if (vals.length) gridHigh = vals[0];
      }
    } catch (_) { /* optional */ }
    const tempF = gridHigh != null ? (todayHigh.temperature * 0.55 + gridHigh * 0.45) : todayHigh.temperature;
    return { tempF, name: todayHigh.name || 'Today', source: 'NWS', raw: { period: todayHigh.temperature, grid: gridHigh } };
  } catch (error) { console.error('NWS fetch failed:', error.message); return null; }
}

async function getOpenMeteoHighF(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&temperature_unit=fahrenheit&timezone=auto&forecast_days=2`;
    const r = await axios.get(url, { timeout: 10000 });
    const maxes = r.data?.daily?.temperature_2m_max;
    const mins = r.data?.daily?.temperature_2m_min;
    const pops = r.data?.daily?.precipitation_probability_max;
    if (!Array.isArray(maxes) || !Number.isFinite(maxes[0])) return null;
    return {
      tempF: maxes[0],
      lowF: Array.isArray(mins) ? mins[0] : null,
      pop: Array.isArray(pops) ? pops[0] : null,
      name: 'Today',
      source: 'Open-Meteo',
      raw: { max: maxes[0], min: mins?.[0] }
    };
  } catch (e) { console.error('Open-Meteo failed:', e.message); return null; }
}

// wttr is flaky (ECONNRESET/timeouts) — optional only, failures stay silent
let _wttrFailAt = 0;
async function getWttrHighF(lat, lon) {
  if (Date.now() < _wttrFailAt) return null; // cool off after failures
  try {
    const url = `https://wttr.in/${lat},${lon}?format=j1`;
    const r = await axios.get(url, { timeout: 6000, headers: { 'User-Agent': 'kalshi-bot' } });
    const weather = r.data?.weather?.[0];
    if (!weather) return null;
    const maxF = parseFloat(weather.maxtempF);
    const minF = parseFloat(weather.mintempF);
    if (!Number.isFinite(maxF)) return null;
    const hours = weather.hourly || [];
    const hourTemps = hours.map(h => parseFloat(h.tempF)).filter(Number.isFinite);
    const hourMax = hourTemps.length ? Math.max(...hourTemps) : null;
    const tempF = hourMax != null ? (maxF * 0.7 + hourMax * 0.3) : maxF;
    return { tempF, lowF: Number.isFinite(minF) ? minF : null, name: 'Today', source: 'wttr.in', raw: { maxF, hourMax } };
  } catch (e) {
    _wttrFailAt = Date.now() + 45 * 60 * 1000; // skip wttr 45m after fail
    return null;
  }
}

async function getOpenWeatherHighF(lat, lon) {
  if (!OPENWEATHER_KEY) return null;
  try {
    // Free current+forecast 2.5 (works with free key). Prefer daily max from 3h forecast.
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=imperial&appid=${OPENWEATHER_KEY}`;
    const r = await axios.get(url, { timeout: 10000 });
    const list = r.data?.list || [];
    if (!list.length) return null;
    const today = new Date().toDateString();
    const todays = list.filter(x => new Date(x.dt * 1000).toDateString() === today);
    const pool = todays.length ? todays : list.slice(0, 8);
    const temps = pool.map(x => x.main?.temp_max ?? x.main?.temp).filter(Number.isFinite);
    if (!temps.length) return null;
    return { tempF: Math.max(...temps), name: 'Today', source: 'OpenWeather', raw: { n: temps.length } };
  } catch (e) { return null; }
}

// Ensemble high temperature from free sources. Returns rich object for cards + model.
async function getWeatherEnsemble(cityCode) {
  const city = WEATHER_CITIES[cityCode];
  if (!city) return null;
  const cached = weatherEnsembleCache[cityCode];
  if (cached && Date.now() - cached.at < WEATHER_SETTINGS.cacheMin * 60 * 1000) return cached.ensemble;

  // Primary free sources first (reliable). wttr is optional fallback only.
  const primary = await Promise.all([
    getNWSForecastHighF(city.lat, city.lon),
    getOpenMeteoHighF(city.lat, city.lon),
    getOpenWeatherHighF(city.lat, city.lon)
  ]);
  let sources = primary.filter(r => r && Number.isFinite(r.tempF));
  if (sources.length < Math.max(1, WEATHER_SETTINGS.minSources)) {
    const wttr = await getWttrHighF(city.lat, city.lon);
    if (wttr && Number.isFinite(wttr.tempF)) sources.push(wttr);
  }
  if (sources.length < WEATHER_SETTINGS.minSources) return null;

  // Weighted consensus: NWS slightly heavier when present (official US), Open-Meteo solid, others light.
  const weightOf = (src) => {
    if (src === 'NWS') return 1.35;
    if (src === 'Open-Meteo') return 1.15;
    if (src === 'OpenWeather') return 1.0;
    return 0.85; // wttr
  };
  let wSum = 0, tSum = 0;
  for (const s of sources) {
    const w = weightOf(s.source);
    wSum += w; tSum += s.tempF * w;
  }
  const consensus = tSum / wSum;
  const temps = sources.map(s => s.tempF);
  const disagree = sampleStd(temps);
  // Effective model stddev = base forecast error + source disagreement
  const stdDev = Math.max(WEATHER_SETTINGS.forecastStdDevF, Math.sqrt(WEATHER_SETTINGS.forecastStdDevF ** 2 + (disagree * 1.1) ** 2));
  const lows = sources.map(s => s.lowF).filter(Number.isFinite);
  const ensemble = {
    tempF: consensus,
    lowF: lows.length ? mean(lows) : null,
    stdDev,
    disagree,
    sources: sources.map(s => ({ name: s.source, high: s.tempF, low: s.lowF ?? null })),
    sourceCount: sources.length,
    name: 'Today',
    // back-compat fields used by older cards
    label: sources.map(s => `${s.source} ${s.tempF.toFixed(1)}°`).join(' · ')
  };
  weatherEnsembleCache[cityCode] = { at: Date.now(), ensemble };
  return ensemble;
}

function normalCDF(x, mean, stdDev) {
  const z = (x - mean) / (stdDev * Math.sqrt(2));
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}
function probAbove(value, threshold, stdDev) { return 1 - normalCDF(threshold, value, stdDev); }

// Box-Muller: generate standard normal random variable
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Monte Carlo simulator: run N GBM paths from S0 to expiry T (in minutes),
// return fraction that finish above strike K.
// This IS the real probability, not a vibe.
function monteCarloPrice(S0, K, T_min, sigmaPerMin, muPerMin, N = 3000) {
  if (T_min <= 0 || sigmaPerMin <= 0 || S0 <= 0) return null;
  const T = T_min / (24 * 60); // convert to days for consistent vol scaling
  const sigma = sigmaPerMin * Math.sqrt(T_min); // total vol to expiry
  const drift = (muPerMin - 0.5 * sigmaPerMin * sigmaPerMin) * T_min;
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const z = randn();
    const ST = S0 * Math.exp(drift + sigma * z);
    if (ST > K) hits++;
  }
  return hits / N;
}

// Kalshi taker fee: ceil(0.07 * C * P * (1-P))
function kalshiFee(price, contracts) {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

// Kalshi maker fee: ceil(0.0175 * C * P * (1-P))
function kalshiMakerFee(price, contracts) {
  return Math.ceil(0.0175 * contracts * price * (1 - price) * 100) / 100;
}

async function scanWeatherEdgeForCity(cityCode) {
  const city = WEATHER_CITIES[cityCode];
  if (!city) return [];
  const ensemble = await getWeatherEnsemble(cityCode);
  if (!ensemble) return [];
  const markets = await findMarketsBySeries(city.kalshiSeriesTicker);
  if (!markets) return [];
  const opps = [];
  for (const market of markets) {
    // Support floor_strike and cap_strike style high-temp contracts
    const strike = market.floor_strike != null ? market.floor_strike
      : (market.cap_strike != null ? market.cap_strike : null);
    if (strike == null) continue;
    const modelProb = probAbove(ensemble.tempF, strike, ensemble.stdDev);
    const yesPrice = parseFloat(market.yes_ask_dollars);
    if (isNaN(yesPrice)) continue;
    const edge = modelProb - yesPrice;
    if (Math.abs(edge) >= WEATHER_SETTINGS.minEdgeToTrade) {
      opps.push({
        cityCode, cityName: city.name, market,
        forecast: ensemble, // rich ensemble object
        modelProb, marketYesPrice: yesPrice, edge,
        side: edge > 0 ? 'yes' : 'no',
        strike,
        stdDev: ensemble.stdDev,
        sourceCount: ensemble.sourceCount
      });
    }
  }
  return opps.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}
async function scanWeatherEdge() {
  const all = [];
  for (const code of Object.keys(WEATHER_CITIES)) {
    try { all.push(...await scanWeatherEdgeForCity(code)); }
    catch (e) { console.error(`Weather ${code}:`, e.message); }
    await sleep(200);
  }
  return all.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, WEATHER_SETTINGS.maxOpps);
}


// ============================================
// COMMODITIES MODULE
// ============================================
async function getCommoditySpot(code) {
  const c = COMMODITIES[code];
  if (!c) return null;
  const today = new Date().toDateString();
  if (commodityPriceCache[code] && commodityPriceCache[code].date === today) return commodityPriceCache[code].price;
  let price = null;
  try {
    if (c.source === 'yahoo' && c.yahooSymbol) {
      const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${c.yahooSymbol}`, {
        params: { interval: '1d', range: '1d' },
        timeout: 10000
      });
      price = r.data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    }
  } catch (e) { console.error(`Commodity price fetch ${code}:`, e.message); }
  if (price != null) commodityPriceCache[code] = { date: today, price };
  return price;
}

async function scanCommodityEdgeForCode(code) {
  const c = COMMODITIES[code];
  const spot = await getCommoditySpot(code);
  if (spot == null) return [];
  const markets = await findMarketsBySeries(c.kalshiSeriesTicker);
  if (!markets) return [];
  const opps = [];
  for (const market of markets) {
    if (market.floor_strike == null) continue;
    const modelProb = probAbove(spot, market.floor_strike, c.stddev);
    const yesPrice = parseFloat(market.yes_ask_dollars);
    if (isNaN(yesPrice)) continue;
    const edge = modelProb - yesPrice;
    if (Math.abs(edge) >= COMMODITY_SETTINGS.minEdgeToTrade)
      opps.push({ code, name: c.name, unit: c.unit, spot, market, modelProb, marketYesPrice: yesPrice, edge, side: edge > 0 ? 'yes' : 'no' });
  }
  return opps.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}
async function scanCommodityEdge() {
  const all = [];
  for (const code of Object.keys(COMMODITIES)) {
    try { all.push(...await scanCommodityEdgeForCode(code)); } catch (e) { console.error(`Commodity ${code}:`, e.message); }
  }
  return all.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, 2);
}

// ============================================
// ORDER PLACEMENT
// ============================================
async function placeKalshiOrderOnMarket(market, side, dollarAmount) {
  const priceInDollars = parseFloat(side === 'yes' ? market.yes_ask_dollars : market.no_ask_dollars);
  if (!priceInDollars || priceInDollars <= 0) return { success: false, reason: 'Could not read a valid price from the market.' };
  const contractCount = Math.max(1, Math.floor(dollarAmount / priceInDollars));
  const priceInCents = Math.round(priceInDollars * 100);
  const bookSide = side === 'yes' ? 'bid' : 'ask';

  let priceStr;
  if (side === 'yes') priceStr = market.yes_ask_dollars;
  else {
    const decimals = (String(market.no_ask_dollars).split('.')[1] || '').length || 2;
    let converted = 1 - parseFloat(market.no_ask_dollars);
    converted = Math.min(0.99, Math.max(0.01, converted));
    priceStr = converted.toFixed(decimals);
  }

  const orderBody = {
    ticker: market.ticker,
    client_order_id: `bot-${Date.now()}`,
    action: 'buy',
    type: 'limit',
    side: bookSide,
    count: String(Math.floor(contractCount)),
    price: priceStr,
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross'
  };

  if (DRY_RUN) return { success: true, dryRun: true, ticker: market.ticker, contractCount, priceInCents, orderBodyPreview: orderBody };
  const result = await kalshiRequest('POST', '/portfolio/events/orders', orderBody);
  if (!result) return { success: false, reason: 'Kalshi API rejected the order — check console.' };
  return { success: true, dryRun: false, ticker: market.ticker, contractCount, priceInCents, orderResult: result };
}
async function placeKalshiOrder(asset, side, dollarAmount) {
  const market = await findLiveMarketTicker(asset);
  if (!market) return { success: false, reason: `No live Kalshi market for ${asset}.` };
  return placeKalshiOrderOnMarket(market, side, dollarAmount);
}

// ============================================
// PRICE FEED
// ============================================
const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin',
  XRP: 'ripple', ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink',
  MATIC: 'matic-network', DOT: 'polkadot', LTC: 'litecoin', BCH: 'bitcoin-cash',
  SHIB: 'shiba-inu', PEPE: 'pepe', SUI: 'sui', APT: 'aptos', NEAR: 'near',
  TON: 'the-open-network', TRX: 'tron', UNI: 'uniswap', ATOM: 'cosmos',
  BNB: 'binancecoin', HYPE: 'hyperliquid', WLD: 'worldcoin-wld',
  ARB: 'arbitrum', OP: 'optimism', INJ: 'injective-protocol',
  SEI: 'sei-network', TIA: 'celestia', RENDER: 'render-token',
  FET: 'fetch-ai', JUP: 'jupiter-exchange-solana', PENDLE: 'pendle',
  W: 'wormhole', ENA: 'ethena', EIGEN: 'eigenlayer',
  ETHFI: 'ether-fi', AERO: 'aerodrome-finance', VELODROME: 'velodrome-finance',
  MORPHO: 'morpho', GMX: 'gmx', GNS: 'gains-network',
  SNX: 'havven', DYDX: 'dydx-chain', PERP: 'perpetual-protocol',
  AEVO: 'aevo', HYPERLIQUID: 'hyperliquid', VERTEX: 'vertex-protocol',
  DRIFT: 'drift-protocol', JUPITER: 'jupiter-exchange-solana',
  ORCA: 'orca', METEORA: 'meteora', PHOENIX: 'phoenix',
  ZETACH: 'zetachain', BLAST: 'blast', MODE: 'mode',
  LINEA: 'linea', SCROLL: 'scroll', ZKSYNC: 'zksync',
  BASE: 'base-protocol', OPTIMISM: 'optimism', ARBITRUM: 'arbitrum',
  POLYGON: 'matic-network', AVALANCHE: 'avalanche-2', FANTOM: 'fantom',
  WLD: 'worldcoin-wld', SHIB: 'shiba-inu'
};
async function getAllSpotPrices() {
  const wanted = Object.keys(CRYPTO_SERIES);
  if (!wanted.length) return null;
  const prices = {};

  // 1) Binance (if not geo-blocked)
  if (!_binanceBlocked) {
    try {
      const r = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 5000 });
      const map = {};
      for (const row of (r.data || [])) map[row.symbol] = parseFloat(row.price);
      for (const asset of wanted) {
        const sym = (typeof BINANCE_SYM !== 'undefined' && BINANCE_SYM[asset]) || (asset + 'USDT');
        if (map[sym] && Number.isFinite(map[sym])) prices[asset] = map[sym];
      }
    } catch (e) {
      if (e.response?.status === 451) {
        _binanceBlocked = true;
        console.log('⚠️ Binance geo-blocked (451) — using free fallbacks');
      }
    }
  }

  const missing = wanted.filter(a => prices[a] == null && COIN_IDS[a]);
  if (!missing.length) return Object.keys(prices).length ? prices : null;

  // 1.5) Pyth WebSocket (real-time from Kalshi) — check cached prices
  for (const asset of missing) {
    const pyth = getPythPrice(asset);
    if (pyth) prices[asset] = pyth;
  }

  // 2) CoinGecko (primary free)
  if (Date.now() >= (_cgCooldownUntil || 0)) {
    try {
      const ids = missing.map(a => COIN_IDS[a]).join(',');
      const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { timeout: 10000 });
      for (const asset of missing) prices[asset] = response.data[COIN_IDS[asset]]?.usd || null;
    } catch (error) {
      if (error.response?.status === 429) {
        _cgCooldownUntil = Date.now() + 10 * 60 * 1000;
        if (!getAllSpotPrices._cgLog) { console.log('CoinGecko rate-limited — 10m cooldown'); getAllSpotPrices._cgLog = true; }
      } else console.error('CoinGecko fetch failed:', error.message);
    }
  }

  // 3) CoinLore (free, no key, good backup)
  const stillMissing = missing.filter(a => prices[a] == null);
  if (stillMissing.length) {
    try {
      const response = await axios.get('https://api.coinlore.net/api/tickers/', { timeout: 8000 });
      const map = {};
      for (const coin of (response.data?.data || [])) map[coin.symbol.toLowerCase()] = parseFloat(coin.price_usd);
      for (const asset of stillMissing) {
        const sym = asset.toLowerCase();
        if (map[sym]) prices[asset] = map[sym];
      }
    } catch (e) { /* silent */ }
  }

  // 4) CoinPaprika — fetch ALL tickers (no ids filter), map by CoinGecko ID
  const stillMissing2 = stillMissing.filter(a => prices[a] == null);
  if (stillMissing2.length) {
    try {
      // Build reverse map: CoinGecko ID → asset name
      const idToAsset = {};
      for (const asset of stillMissing2) {
        if (COIN_IDS[asset]) idToAsset[COIN_IDS[asset]] = asset;
      }
      // Fetch all tickers (returns ~100 coins, enough to cover ours)
      const response = await axios.get('https://api.coinpaprika.com/v1/tickers?quotes=USD', { timeout: 12000 });
      let found = 0;
      for (const coin of (response.data || [])) {
        if (idToAsset[coin.id] && coin.quotes?.USD?.price) {
          prices[idToAsset[coin.id]] = coin.quotes.USD.price;
          found++;
        }
      }
    } catch (e) { /* silent */ }
  }

  // 5) CoinCap (free, no key, returns top 100 by market cap)
  const stillMissing3 = stillMissing2.filter(a => prices[a] == null);
  if (stillMissing3.length) {
    try {
      const response = await axios.get('https://api.coincap.io/v2/assets?limit=100', { timeout: 8000 });
      const map = {};
      for (const coin of (response.data?.data || [])) map[coin.symbol.toLowerCase()] = parseFloat(coin.priceUsd);
      for (const asset of stillMissing3) {
        const sym = asset.toLowerCase();
        if (map[sym]) prices[asset] = map[sym];
      }
    } catch (e) { /* silent */ }
  }

  return Object.keys(prices).length ? prices : null;
}
function recordPrice(asset, price) {
  ensureAssetState(asset);
  botState.prices[asset] = price;
  botState.priceHistory[asset].push({ time: Date.now(), price });
  if (botState.priceHistory[asset].length > 100) botState.priceHistory[asset].shift();
}

// ============================================
// KELLY SIZING
// ============================================
// FIXED SIZING: every trade risks exactly FIXED_BET_USD (default $1), regardless
// of Kelly/win-probability. Signature kept so all existing call sites still work.
function calculateKellyBetSize(winProbability, payoutRatio) {
  const risk = checkRiskLimits();
  if (!risk.ok) return 0;
  return applyRiskToStake(FIXED_BET_USD);
}

// ============================================
// PLAY TYPE CLASSIFICATION + STRATEGY SIZING
// ============================================
function classifyPlayType(price, side) {
  for (const [type, cfg] of Object.entries(PLAY_STRATEGY)) {
    if (price >= cfg.priceMin && price <= cfg.priceMax) return { type, ...cfg };
  }
  return null;
}

function calculateStrategyStake(playType, winProb, edge, memoryStrength) {
  if (!playType) return applyRiskToStake(FIXED_BET_USD);
  let stake = playType.stakeDefault;
  if (memoryStrength >= 3) stake = Math.min(stake * 1.2, playType.stakeMax);
  if (edge >= 0.10) stake = Math.min(stake * 1.1, playType.stakeMax);
  if (winProb >= 0.65) stake = Math.min(stake * 1.1, playType.stakeMax);
  return Math.max(playType.stakeMin, Math.min(stake, playType.stakeMax));
}

function memoryStrength(a) {
  let score = 0;
  try {
    const d = dep();
    const catKey = `CRYPTO|${a.side}`;
    if (d.sides[catKey] && d.sides[catKey].trades >= 3) {
      const wr = d.sides[catKey].wins / d.sides[catKey].trades;
      if (wr >= 0.55) score += 2;
      else if (wr >= 0.48) score += 1;
    }
    const asset = a.asset;
    const am = d.trades ? d.trades.filter(t => t.asset === asset && t.side === a.side) : [];
    if (am.length >= 3) { score += 1; }
    const pwr = patternWinRate(patternKey(asset, a.side, buildFeatures(a)));
    if (pwr != null && pwr >= 0.55) score += 1;
    if (a.research && a.research.score >= 1.2) score += 1;
  } catch (_) {}
  return score;
}

// ============================================
// REASONING ENGINE — WHY is the bot betting?
// ============================================
function buildTradeReasoning(a, playType, review) {
  const reasons = [];
  const name = assetDisplayName(a.asset);
  const side = (a.side || '').toUpperCase();
  const dec = a.asset === 'DOGE' ? 4 : 2;

  // 1. Market price thesis
  if (a.S != null && a.K != null) {
    const above = a.S >= a.K;
    const dist = Math.abs(a.S - a.K).toFixed(dec);
    reasons.push(`Spot ${money(a.S, dec)} is ${above ? 'ABOVE' : 'BELOW'} strike ${money(a.K, dec)} by ${dist} — ${above ? 'YES' : 'NO'} is the ${above ? 'holding' : 'fading'} side.`);
  }

  // 2. Model vs market mispricing
  if (a.side === 'yes') {
    reasons.push(`Model says ${pct(a.modelProb)} YES vs market ask ${cents(a.yesAsk)} — ${a.modelProb > parseFloat(a.yesAsk) ? 'underpriced by ' + pp(a.modelProb - parseFloat(a.yesAsk)) : 'fair or overpriced'}.`);
  } else {
    const noProb = 1 - (a.modelProb || 0);
    reasons.push(`Model says ${pct(noProb)} NO vs market ask ${cents(a.noAsk)} — ${noProb > parseFloat(a.noAsk) ? 'underpriced by ' + pp(noProb - parseFloat(a.noAsk)) : 'fair or overpriced'}.`);
  }

  // 3. Play type reasoning
  if (playType) {
    if (playType.type === 'FAVORITE') {
      reasons.push(`FAVORITE play (${cents(playType.priceMin)}–${cents(playType.priceMax)} zone): backing the side the market already favors at ${(a.price * 100).toFixed(0)}¢. History shows favorites hold more often than not when momentum aligns.`);
    } else if (playType.type === 'UNDERDOG') {
      reasons.push(`UNDERDOG play (${cents(playType.priceMin)}–${cents(playType.priceMax)} zone): the market overprices the other side. At ${(a.price * 100).toFixed(0)}¢, risk/reward is asymmetric — small loss if wrong, big payout if right.`);
    }
  }

  // 4. Technical indicators
  if (a.ind) {
    const tech = [];
    if (a.ind.smaTrend) tech.push(`SMA trend: ${a.ind.smaTrend}${a.ind.smaCross && a.ind.smaCross !== 'none' ? ' (cross ' + a.ind.smaCross + ')' : ''}`);
    if (a.ind.rsi != null) tech.push(`RSI ${a.ind.rsi.toFixed(0)}${a.ind.rsi >= 70 ? ' (overbought)' : a.ind.rsi <= 30 ? ' (oversold)' : ''}`);
    if (a.ind.bbPercent != null) tech.push(`BB %B ${a.ind.bbPercent.toFixed(2)}${a.ind.bbPercent > 0.9 ? ' (near upper)' : a.ind.bbPercent < 0.1 ? ' (near lower)' : ''}`);
    if (a.ind.momentum != null) tech.push(`Momentum ${a.ind.momentum >= 0 ? '+' : ''}${(a.ind.momentum * 100).toFixed(2)}%`);
    if (tech.length) reasons.push(`Technical: ${tech.join(' · ')}.`);
  }

  // 5. Strategy alignment
  if (a.strategy && a.strategy.clear) {
    reasons.push(`Strategy signal: ${a.strategy.label} — ${a.strategy.bits ? a.strategy.bits.slice(0, 2).join(', ') : 'aligned'}.`);
  }

  // 6. Memory backing (CRITICAL — user wants knowledge-backed plays)
  if (review && review.memoryBits && review.memoryBits.length) {
    const mem = review.memoryBits.filter(b => !b.startsWith('Note:') && !b.startsWith('Lesson:')).slice(0, 3);
    if (mem.length) reasons.push(`Memory intel: ${mem.join(' · ')}.`);
  }
  const lessons = review && review.memoryBits ? review.memoryBits.filter(b => b.startsWith('Lesson:')).slice(0, 1) : [];
  if (lessons.length) reasons.push(`Prior lesson: ${lessons[0].replace('Lesson: ', '')}.`);

  // 7. Risk/reward math
  const stake = a.betAmount || FIXED_BET_USD;
  const winPayout = a.side === 'yes'
    ? stake * ((1 / (a.price || 0.5)) - 1)
    : stake * ((1 / (a.price || 0.5)) - 1);
  const ev = (a.winProb || 0.5) * winPayout - (1 - (a.winProb || 0.5)) * stake;
  reasons.push(`Risk $${stake.toFixed(2)} → win ~+$${winPayout.toFixed(2)} · lose −$${stake.toFixed(2)} · EV ${ev >= 0 ? '+' : ''}$${ev.toFixed(2)}.`);

  // 8. Settle speed
  if (a.minsToClose != null) {
    if (a.minsToClose <= 15) reasons.push(`Settles in ${formatMinsLeft(a.minsToClose)} — fast cash recycle.`);
    else if (a.minsToClose <= 60) reasons.push(`Settles in ${formatMinsLeft(a.minsToClose)}.`);
    else reasons.push(`Settles in ${formatMinsLeft(a.minsToClose)}.`);
  }

  // 9. Cycle history — how often do our signals hit?
  try {
    const hist = cycleHistorySummary(10);
    if (hist) reasons.push(`Cycle history (last 10): ${hist.proposed} proposed · ${hist.taken} taken (${pct(hist.saveRate)} saved) · ${hist.hit} hit (${pct(hist.hitRate)})`);
  } catch (_) {}

  return reasons;
}

// ============================================
// REGIME-AWARE STRATEGY MODULE — disciplined 15m cycle trading
// Detects regime (trend/range), aligns signals, sizes with capped Kelly
// ============================================
const REGIME = {
  // ADX threshold for trending
  ADX_TREND: 25,
  // EMA slope threshold for trend
  EMA_SLOPE_THRESHOLD: 0.0005,
  // Volatility percentile for regime
  VOL_HIGH_PCTL: 75,
  VOL_LOW_PCTL: 25,
};

const SIGNAL_HISTORY = {}; // per-asset per-signal calibration

function initSignalHistory(asset) {
  if (!SIGNAL_HISTORY[asset]) {
    SIGNAL_HISTORY[asset] = {
      mr_yes: { wins: 0, losses: 0, lastUpdate: 0 },
      mr_no: { wins: 0, losses: 0, lastUpdate: 0 },
      mom_yes: { wins: 0, losses: 0, lastUpdate: 0 },
      mom_no: { wins: 0, losses: 0, lastUpdate: 0 },
    };
  }
}

function updateSignalHistory(asset, signalType, won) {
  initSignalHistory(asset);
  const hist = SIGNAL_HISTORY[asset][signalType];
  if (!hist) return;
  if (won) hist.wins++; else hist.losses++;
  hist.lastUpdate = Date.now();
}

function getSignalWinRate(asset, signalType) {
  initSignalHistory(asset);
  const hist = SIGNAL_HISTORY[asset][signalType];
  if (!hist || hist.wins + hist.losses < 3) return 0.5; // insufficient data
  return hist.wins / (hist.wins + hist.losses);
}

// Detect market regime: 'trend' | 'range' | 'choppy'
function detectRegime(asset, price) {
  ensureAssetState(asset);
  const history = botState.priceHistory[asset];
  if (!history || history.length < 30) return 'unknown';
  
  const recent = history.slice(-30).map(h => h.price);
  const prices = recent;
  
  // ADX-like trend strength
  let adx = 0;
  if (prices.length >= 14) {
    let plusDM = 0, minusDM = 0, trSum = 0;
    for (let i = 1; i < 14; i++) {
      const up = prices[i] - prices[i-1];
      const down = prices[i-1] - prices[i];
      plusDM += Math.max(0, up > down ? up : 0);
      minusDM += Math.max(0, down > up ? down : 0);
      const tr = Math.max(
        prices[i] - prices[i-1],
        Math.abs(prices[i] - prices[i-1]),
        Math.abs(prices[i-1] - prices[i])
      );
      trSum += tr;
    }
    const diPlus = trSum > 0 ? (plusDM / trSum) * 100 : 0;
    const diMinus = trSum > 0 ? (minusDM / trSum) * 100 : 0;
    const dx = (diPlus + diMinus) > 0 ? Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100 : 0;
    adx = dx;
  }
  
  // EMA slope (20-period)
  let emaSlope = 0;
  if (prices.length >= 20) {
    const k = 2 / 21;
    let ema = prices[0];
    for (let i = 1; i < 20; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    emaSlope = (ema - prices[0]) / prices[0];
  }
  
  // Volatility percentile (20-period)
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i-1]));
  }
  const vol = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + r*r, 0) / returns.length) : 0;
  
  // Volatility history for percentile
  const volHistory = botState.priceHistory[asset].slice(-100).map(h => h.price);
  const volReturns = [];
  for (let i = 1; i < volHistory.length; i++) {
    volReturns.push(Math.log(volHistory[i] / volHistory[i-1]));
  }
  const volPctl = volReturns.length > 10 ? 
    (volReturns.filter(r => r < vol).length / volReturns.length) * 100 : 50;
  
  // Regime classification
  if (adx > REGIME.ADX_TREND && Math.abs(emaSlope) > REGIME.EMA_SLOPE_THRESHOLD) {
    return emaSlope > 0 ? 'trend_up' : 'trend_down';
  }
  if (volPctl > REGIME.VOL_HIGH_PCTL) return 'choppy';
  if (volPctl < REGIME.VOL_LOW_PCTL) return 'range';
  return 'range';
}

// Calibrated win probability based on signal history + regime
function calibratedProb(baseProb, asset, signalType, regime) {
  const histRate = getSignalWinRate(asset, signalType);
  if (histRate === 0.5) return baseProb; // no history
  
  // Regime adjustment
  let regimeMult = 1.0;
  if (signalType.startsWith('mr_')) {
    regimeMult = regime === 'range' ? 1.1 : regime === 'trend_up' || regime === 'trend_down' ? 0.85 : 0.9;
  } else {
    regimeMult = regime.startsWith('trend') ? 1.1 : regime === 'choppy' ? 0.85 : 0.9;
  }
  
  // Blend: 70% base, 30% history * regime
  return 0.7 * baseProb + 0.3 * histRate * regimeMult;
}

// Proper Kelly with cap: f = (bp - q) / b, capped at maxFraction
function kellySize(winProb, payout, maxFraction = 0.02) {
  if (winProb <= 0 || winProb >= 1) return 0;
  const b = payout; // net profit per $1 risked
  const p = winProb;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  const capped = Math.max(0, Math.min(kelly, maxFraction));
  return capped;
}

// Regime-aware thresholds
function getThresholds(asset, regime) {
  const base = THRESHOLDS[asset] || { buyDrop: 0.15, sellGain: 0.55 };
  const mult = regime === 'range' ? 0.8 : regime.startsWith('trend') ? 1.3 : 1.1;
  return {
    buyDrop: base.buyDrop * mult,
    sellGain: base.sellGain * mult,
  };
}

// Build aligned signal with scoring
function buildSignal(analysis, asset, regime) {
  const thresholds = getThresholds(asset, regime);
  const signals = [];
  
  // Mean-reversion: buy dips (YES)
  if (analysis.dropPercent >= thresholds.buyDrop) {
    const baseProb = Math.min(0.75, 0.55 + (analysis.dropPercent / thresholds.buyDrop - 1) * 0.08);
    const calProb = calibratedProb(baseProb, asset, 'mr_yes', regime);
    signals.push({
      type: 'mr_yes',
      side: 'yes',
      label: 'Mean-rev YES (dip)',
      prob: calProb,
      edge: calProb - 0.5,
      strength: analysis.dropPercent / thresholds.buyDrop,
      regimeFit: regime === 'range' ? 1.2 : regime === 'choppy' ? 0.8 : 1.0,
    });
  }
  
  // Mean-reversion: fade pumps (NO)
  if (analysis.gainPercent >= thresholds.sellGain) {
    const baseProb = Math.min(0.75, 0.55 + (analysis.gainPercent / thresholds.sellGain - 1) * 0.08);
    const calProb = calibratedProb(baseProb, asset, 'mr_no', regime);
    signals.push({
      type: 'mr_no',
      side: 'no',
      label: 'Mean-rev NO (pump)',
      prob: calProb,
      edge: calProb - 0.5,
      strength: analysis.gainPercent / thresholds.sellGain,
      regimeFit: regime === 'range' ? 1.2 : regime === 'choppy' ? 0.8 : 1.0,
    });
  }
  
  // Momentum: breakout (YES near highs)
  if (analysis.nearHigh && regime.startsWith('trend')) {
    const baseProb = 0.58;
    const calProb = calibratedProb(baseProb, asset, 'mom_yes', regime);
    signals.push({
      type: 'mom_yes',
      side: 'yes',
      label: 'Momentum YES (breakout)',
      prob: calProb,
      edge: calProb - 0.5,
      strength: 1.0,
      regimeFit: 1.3,
    });
  }
  
  // Momentum: breakdown (NO near lows)
  if (analysis.nearLow && regime.startsWith('trend')) {
    const baseProb = 0.58;
    const calProb = calibratedProb(baseProb, asset, 'mom_no', regime);
    signals.push({
      type: 'mom_no',
      side: 'no',
      label: 'Momentum NO (breakdown)',
      prob: calProb,
      edge: calProb - 0.5,
      strength: 1.0,
      regimeFit: 1.3,
    });
  }
  
  return signals;
}

// Score and pick best signal
function pickBestSignal(signals) {
  if (!signals.length) return null;
  // Score = edge * regimeFit * prob * strength
  return signals
    .map(s => ({ ...s, score: s.edge * s.regimeFit * s.prob * s.strength }))
    .sort((a, b) => b.score - a.score)[0];
}

// Kelly sizing with bankroll cap
function kellySize(winProb, payout, maxFraction = 0.02) {
  if (winProb <= 0 || payout <= 0) return 0;
  const edge = winProb - (1 - winProb) / payout;
  if (edge <= 0) return 0;
  const kelly = edge / payout;
  return Math.min(kelly, maxFraction);
}

// Dynamic stake: $0.25-$0.75 based on win probability and signal type
function calcStake(winProb, price, bankroll = BANKROLL, signalType = 'mr') {
  const payout = (1 / price) - 1;
  const kellyFrac = kellySize(winProb, payout, 0.02); // max 2% bankroll
  let stake = Math.round(kellyFrac * bankroll * 100) / 100;
  
  // Dynamic range: $0.25-$0.75 based on win probability
  // Higher prob = larger stake, but capped
  const probMult = Math.max(0.5, winProb * 2 - 0.5); // scales from ~0.5 at 50% to 1.0 at 75%+
  
  // Momentum plays get slightly smaller sizing (more volatile)
  const typeMult = signalType.startsWith('mom') ? 0.8 : 1.0;
  
  stake = stake * probMult * typeMult;
  
  // Clamp to $0.25 - $0.75 range
  return Math.max(0.25, Math.min(0.75, stake));
}

// ============================================
// ANALYSIS — mean-reversion (dips/pumps) + momentum (breakouts/breakdowns)
function analyzeAsset(asset, price) {
  ensureAssetState(asset);
  const history = botState.priceHistory[asset];
  if (!history || history.length < 5) return null;
  const threshold = THRESHOLDS[asset];
  if (!threshold) return null;
  const recent = history.slice(-SCAN_LOOKBACK).map(h => h.price);
  const high = Math.max(...recent), low = Math.min(...recent);
  const dropPercent = ((high - price) / high) * 100;  // below recent high
  const gainPercent = ((price - low) / low) * 100;     // above recent low
  const volatility = ((high - low) / low) * 100;
  // Mean-reversion signals: buy dips, fade pumps
  const buySignal = dropPercent >= threshold.buyDrop;
  const sellSignal = gainPercent >= threshold.sellGain;
  // Momentum signals: buy breakouts (price near highs), sell breakdowns (price near lows)
  const nearHigh = (high - price) / high < 0.001 && gainPercent > threshold.buyDrop * 0.5;
  const nearLow = (price - low) / low < 0.001 && dropPercent > threshold.sellGain * 0.5;
  // Volatility-aware win probability: reward moves that clear the trigger,
  // and add a bounce-bonus in choppier tape (mean-reversion is stronger there).
  const volBonus = Math.min(0.06, volatility * 0.015);
  const buyProb = Math.min(0.80, 0.50 + Math.max(0, dropPercent / threshold.buyDrop - 1) * 0.10 + (buySignal ? volBonus : 0));
  const sellProb = Math.min(0.80, 0.50 + Math.max(0, gainPercent / threshold.sellGain - 1) * 0.10 + (sellSignal ? volBonus : 0));
  // Momentum win probs: slightly lower than mean-reversion (trend is weaker signal on 15m)
  const momBuyProb = Math.min(0.75, 0.52 + volBonus * 0.5);
  const momSellProb = Math.min(0.75, 0.52 + volBonus * 0.5);
  return { price, high, low, dropPercent, gainPercent, volatility, buySignal, sellSignal, buyProb, sellProb, threshold, nearHigh, nearLow, momBuyProb, momSellProb };
}

// Picks the strongest actionable play across mean-reversion + momentum sides.
function bestCryptoPlay(analysis) {
  const plays = [];
  // Mean-reversion: buy dips (YES), fade pumps (NO)
  if (analysis.buySignal) plays.push({ side: 'yes', dir: 'dip', winProb: analysis.buyProb, move: analysis.dropPercent, edge: analysis.buyProb - 0.5 });
  if (analysis.sellSignal) plays.push({ side: 'no', dir: 'pump', winProb: analysis.sellProb, move: analysis.gainPercent, edge: analysis.sellProb - 0.5 });
  // Momentum: ride breakouts (YES at highs), ride breakdowns (NO at lows)
  if (analysis.nearHigh) plays.push({ side: 'yes', dir: 'breakout', winProb: analysis.momBuyProb, move: analysis.gainPercent, edge: analysis.momBuyProb - 0.5 });
  if (analysis.nearLow) plays.push({ side: 'no', dir: 'breakdown', winProb: analysis.momSellProb, move: analysis.dropPercent, edge: analysis.momSellProb - 0.5 });
  const clear = plays.filter(p => p.winProb >= RISK_RULES.minConfidenceToTrade);
  if (clear.length === 0) return null;
  return clear.sort((a, b) => b.edge - a.edge)[0];
}

let reservedExposure = 0;
// checkRiskLimits implemented in STRATEGY ENGINE section (TradingBotRisk)
function currentExposure() { return botState.openBets.reduce((s, b) => s + b.amount, 0); }
function shouldAutoExecute(amount) {
  if (!autoExecuteEnabled) return false;
  if (amount > AUTO_EXECUTE_MAX) return false;
  if (MAX_AUTO_EXPOSURE > 0 && (currentExposure() + reservedExposure + amount) > MAX_AUTO_EXPOSURE) return false;
  return true;
}

// ============================================
// EXECUTION
// ============================================
async function executeTrade(asset, analysis, betAmount, side = 'yes', play = null, meta = {}) {
  const risk = checkRiskLimits();
  if (!risk.ok || !(betAmount > 0)) {
    sendAlert('risk_block', risk.reason || 'stake 0');
    return null;
  }
  reservedExposure += betAmount;
  let orderResult;
  try {
    // Prefer the exact market the quant/radar researched (correct 15m strike/window).
    if (meta && meta.market) orderResult = await placeKalshiOrderOnMarket(meta.market, side, betAmount);
    else orderResult = await placeKalshiOrder(asset, side, betAmount);
  } finally { reservedExposure -= betAmount; }
  if (!orderResult.success) { notify(`❌ Order failed for ${asset} (${side.toUpperCase()}): ${orderResult.reason}`); return null; }
  const assetName = (THRESHOLDS[asset] && THRESHOLDS[asset].name) || asset;
  const entryPrice = analysis ? analysis.price : null;
  const contractCount = orderResult.contractCount || 0;
  const entryFee = entryPrice ? kalshiFee(entryPrice, contractCount) : 0;
  const actualCost = contractCount * (entryPrice || 0) + entryFee;
  const bet = {
    id: Date.now() + '_' + (++_betIdCounter), asset, category: 'CRYPTO',
    entryPrice, amount: betAmount, actualCost, entryFee,
    estimatedWinProbability: play ? play.winProb : null,
    ticker: orderResult.ticker, contractCount, side,
    timestamp: Date.now(), status: 'open',
    patternKey: meta.patternKey || null,
    features: meta.features || null,
    series: (meta && meta.series) || (meta.features && meta.features.series) || null
  };
  if (!orderResult.dryRun) { botState.openBets.push(bet); botState.stats.totalBets++; }
  saveState();
  notify(orderResult.dryRun
    ? `🧪 DRY RUN — ${assetName} ${side.toUpperCase()}: would buy ${orderResult.contractCount} on ${orderResult.ticker} (~$${betAmount.toFixed(2)})`
    : `✅ TRADE PLACED — ${assetName} ${side.toUpperCase()}\nMarket: ${orderResult.ticker}\nContracts: ${orderResult.contractCount}\nCost: ~$${betAmount.toFixed(2)}\n🕐 Started: ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\nBet ID: ${bet.id}`);
  return bet;
}

// Weather completely disabled — no notifications, no trades
async function executeWeatherTrade(pending) {
  bot.sendMessage(pending.meta?.chatId || YOUR_TELEGRAM_ID,
    `⚠️ Weather trades disabled. This play was skipped.`);
}

async function executeCommodityTrade(pending) {
  const { side, betAmount, opportunity } = pending;
  reservedExposure += betAmount;
  let orderResult;
  try { orderResult = await placeKalshiOrderOnMarket(opportunity.market, side, betAmount); } finally { reservedExposure -= betAmount; }
  if (!orderResult.success) { notify(`❌ Commodity order failed: ${orderResult.reason}`); return null; }
  const bet = { id: Date.now() + '_' + (++_betIdCounter), asset: `CM:${opportunity.code}`, ticker: orderResult.ticker, side, amount: betAmount, contractCount: orderResult.contractCount, timestamp: Date.now(), status: 'open' };
  if (!orderResult.dryRun) { botState.openBets.push(bet); botState.stats.totalBets++; }
  saveState();
  notify(orderResult.dryRun
    ? `🧪 DRY RUN — ${opportunity.name} ${side.toUpperCase()}: ${orderResult.contractCount} contracts (~$${betAmount.toFixed(2)})`
    : `✅ COMMODITY TRADE — ${opportunity.name} ${side.toUpperCase()}\n${orderResult.ticker}\nContracts: ${orderResult.contractCount}\nCost: ~$${betAmount.toFixed(2)}\nBet ID: ${bet.id}`);
  return bet;
}

// ============================================
// PROPOSALS (with tap buttons) — rich, plain-English cards
// ============================================
function assetDisplayName(asset) {
  return (THRESHOLDS[asset] && THRESHOLDS[asset].name) || asset;
}
function expectedProfit(stake, price, winProb) {
  if (!(price > 0) || !(stake > 0)) return null;
  const contracts = Math.max(1, Math.floor(stake / price));
  const winPayout = contracts * (1 - price); // profit if win (rough, pre-fees)
  const lose = contracts * price;
  const ev = winProb * winPayout - (1 - winProb) * lose;
  return { contracts, winPayout, lose, ev };
}
function formatThesisBullets(bullets) {
  return (bullets || []).filter(Boolean).map(b => `• ${b}`).join('\n');
}

// Bright asset color tags (Telegram plain text — emoji = color)
const ASSET_COLOR = {
  BTC:  { emoji: '₿',   name: 'Bitcoin',  hex: '#F7931A' },
  ETH:  { emoji: 'Ξ',   name: 'Ethereum', hex: '#627EEA' },
  SOL:  { emoji: '◎',   name: 'Solana',   hex: '#9945FF' },
  DOGE: { emoji: 'Ð',   name: 'Dogecoin', hex: '#C2A633' },
  XRP:  { emoji: '✕',   name: 'XRP',      hex: '#23292F' },
  ADA:  { emoji: '🅰️', name: 'Cardano',  hex: '#0033AD' },
  AVAX: { emoji: '🔺',  name: 'Avalanche',hex: '#E84142' },
  LINK: { emoji: '🔗',  name: 'Chainlink',hex: '#2A5ADA' },
  WX:   { emoji: '☁️',  name: 'Weather',  hex: '#4FC3F7' },
  CM:   { emoji: '🛢️',  name: 'Commodity',hex: '#8D6E63' },
  NX:   { emoji: '🎲',  name: 'Niche',    hex: '#00C853' },
  QN:   { emoji: '🧪',  name: 'QuantNiche', hex: '#00BFA5' },
  LS:   { emoji: '🎯',  name: 'Longshot', hex: '#FF6F00' }
};
function assetColor(asset) {
  const b = baseAsset(asset);
  if (ASSET_COLOR[b]) return ASSET_COLOR[b];
  if (String(asset || '').startsWith('WX')) return ASSET_COLOR.WX;
  if (String(asset || '').startsWith('CM')) return ASSET_COLOR.CM;
  if (String(asset || '').startsWith('NX')) return ASSET_COLOR.NX;
  if (String(asset || '').startsWith('QN')) return ASSET_COLOR.QN;
  return { emoji: '⚪', name: String(asset || '?'), hex: '#999' };
}
function sideBadge(side) {
  return String(side || '').toLowerCase() === 'yes' ? '🟢 YES' : '🔴 NO';
}
function simpleWhyProfit({ side, price, winProb, edge, stake }) {
  const ep = expectedProfit(stake, price, winProb);
  const mkt = price != null ? Number(price) : null;
  const lines = [];
  if (winProb != null && mkt != null) {
    lines.push(`Market prices this at ${cents(mkt)} but model says ${pct(winProb)} chance.`);
  }
  if (edge != null) lines.push(`That's a ${pp(edge)} edge in your favor.`);
  if (ep) {
    lines.push(`Risk ${money(stake)} → win ~+${money(ep.winPayout)} · lose −${money(ep.lose)}.`);
    if (ep.ev != null) lines.push(`Expected value ~${ep.ev >= 0 ? '+' : ''}${money(ep.ev)}.`);
  }
  return lines;
}

// ============================================
// TIERED VERDICT — 4 quality levels with clear colors
// A=Excellent (edge≥12pp & win≥65%), B=Good (edge≥8pp & win≥60%), C=Decent (edge≥5pp & win≥55%), D=Speculative
// ============================================
function verdictFromEdge(edge, winProb, minsToClose, playType) {
  const e = edge || 0, w = winProb || 0;
  
  if (e >= 0.12 && w >= 0.65) {
    return { tier: 'A', label: 'EXCELLENT', emoji: '🟢', why: 'High edge + strong win prob' };
  }
  if (e >= 0.08 && w >= 0.60) {
    return { tier: 'B', label: 'GOOD', emoji: '🔵', why: 'Solid edge, decent win prob' };
  }
  if (e >= 0.05 && w >= 0.55) {
    return { tier: 'C', label: 'DECENT', emoji: '🟡', why: 'Marginal edge, needs conviction' };
  }
  return { tier: 'D', label: 'SPECULATIVE', emoji: '🟠', why: 'Thin edge or low confidence' };
}

// Format clean copy-paste trade format for sharing
function formatCopyTrade(pending) {
  const a = pending.asset;
  const side = (pending.side || pending.play?.side || '').toUpperCase();
  const price = pending.price || pending.play?.price || 0.5;
  const stake = pending.betAmount || pending.stake || 0;
  const ticker = pending.ticker || pending.meta?.market?.ticker || pending.market?.ticker || '';
  const winProb = pending.winProb || pending.play?.winProb || 0.5;
  const edge = pending.edge || pending.play?.edge || 0;
  const mins = pending.minsToClose || pending.meta?.minsToClose || 15;
  
  const payout = (1 / price - 1).toFixed(2) + 'x';
  const profit = (stake * (1/price - 1)).toFixed(2);
  const loss = stake.toFixed(2);
  
  return `${a} ${side} @ ${(price*100).toFixed(0)}¢ (${payout})
Stake: $${stake.toFixed(2)} | Win: $${profit} / Loss: -$${loss}
Win: ${(winProb*100).toFixed(0)}% | Edge: ${(edge*100).toFixed(1)}pp
⏱ ${mins}m | ${ticker}
#Kalshi #${a} #${side}`;
}

// CLEAN, FAST decision card — scannable in 3 seconds
function formatDecisionCard({
  title, subtitle, side, price, winProb, edge, stake, minsToClose, marketTitle, ticker,
  thesis = [], risks = [], ownerNote = null, category = 'CRYPTO', extras = [], memoryBits = [],
  asset = null, playType = null
}) {
  const col = assetColor(asset || (title || ''));
  const v = verdictFromEdge(edge || 0, winProb || 0, minsToClose, playType);
  const ep = expectedProfit(stake, price, winProb);
  const why = simpleWhyProfit({ side, price, winProb, edge, stake });
  const oneLineWhy = (thesis || []).filter(Boolean)[0] || why[0] || v.why;
  const riskOne = (risks || []).filter(Boolean)[0] || null;
  const memOne = (memoryBits || []).filter(Boolean)[0] || null;
  const resOne = (extras || []).filter(Boolean).find(x => !/^Bet ID/i.test(x) && !/^Series/i.test(x) && !/^ID /i.test(x)) || null;

  const lines = [];
  
  // Header with tier color
  const tierBadge = `${v.color} ${v.tier}`;
  lines.push(`${col.emoji} ${title || 'PLAY'}  ${tierBadge}`);
  if (subtitle) lines.push(subtitle);
  lines.push('━━━━━━━━━━━━━━━');
  
  // Core play info - compact
  const sideTag = side === 'yes' ? '🟢 YES' : '🔴 NO';
  const now = new Date();
  const startStr = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  const endTime = new Date(now.getTime() + minsToClose * 60000);
  const endStr = endTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  lines.push(`${sideTag}  @  ${cents(price)}  (${payoutX(price)}x)`);
  lines.push(`🕐 Start: ${startStr}  →  End: ${endStr}  (${formatMinsLeft(minsToClose)} left)`);
  lines.push(`💵 ${money(stake)}`);
  if (ticker) lines.push(`🏷 ${ticker}`);
  lines.push('');
  
  // Why it pays (max 3 bullets)
  lines.push('💡 WHY');
  for (const w of why.slice(0, 3)) lines.push(`• ${w}`);
  if (oneLineWhy && !why.includes(oneLineWhy)) lines.push(`• ${oneLineWhy}`);
  lines.push('');
  
  // Key metrics
  lines.push(`📊 Win ${pct(winProb)}  ·  Edge ${pp(edge)}`);
  if (ep) lines.push(`📈 EV ${ep.ev >= 0 ? '+' : ''}${money(ep.ev)}  |  W +${money(ep.winPayout)} / L −${money(ep.lose)}`);
  
  // Memory intel (high value)
  if (memOne) lines.push(`🧠 ${memOne}`);
  
  // Research/strategy signal
  if (resOne) lines.push(`🔎 ${resOne}`);
  
  // Risk (only if meaningful)
  if (riskOne && !riskOne.includes('Thin book')) lines.push(`⚠️ ${riskOne}`);
  
  // Owner gate (only if not clean)
  if (ownerNote && ownerNote !== 'clean') lines.push(`✅ ${ownerNote}`);
  
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('✅ Play  ·  ❌ Skip');
  return lines.join('\n');
}

// Format clean copy-paste trade format for sharing
function formatCopyTrade(pending) {
  const a = pending.asset;
  const side = (pending.side || pending.play?.side || '').toUpperCase();
  const price = pending.price || pending.play?.price || 0.5;
  const stake = pending.betAmount || pending.stake || 0;
  const ticker = pending.ticker || pending.meta?.market?.ticker || pending.market?.ticker || '';
  const winProb = pending.winProb || pending.play?.winProb || 0.5;
  const edge = pending.edge || pending.play?.edge || 0;
  const mins = pending.minsToClose || pending.meta?.minsToClose || 15;
  
  const payout = (1 / price - 1).toFixed(2) + 'x';
  const profit = (stake * (1/price - 1)).toFixed(2);
  const loss = stake.toFixed(2);
  
  return `${a} ${side} @ ${(price*100).toFixed(0)}¢ (${payout})
Stake: $${stake.toFixed(2)} | Win: $${profit} / Loss: -$${loss}
Win: ${(winProb*100).toFixed(0)}% | Edge: ${(edge*100).toFixed(1)}pp
⏱ ${mins}m | ${ticker}
#Kalshi #${a} #${side}`;
}

function proposeCrypto(asset, analysis, play) {
  const betAmount = calculateKellyBetSize(play.winProb, 0.9);
  const pending = { id: Date.now(), type: 'crypto', asset, analysis, play, side: play.side, betAmount, timestamp: Date.now() };
  botState.pendingBets.push(pending);
  saveState();
  const name = assetDisplayName(asset);
  const edge = play.edge != null ? play.edge : (play.winProb - 0.5);
  const thesis = [
    play.dir === 'dip'
      ? `${name} dipped ${play.move.toFixed(2)}% off recent high — mean-reversion YES setup.`
      : `${name} pumped ${play.move.toFixed(2)}% off recent low — fade/NO setup.`,
    `Momentum scanner win estimate ${pct(play.winProb)} (min bar ${pct(RISK_RULES.minConfidenceToTrade)}).`,
    `Short crypto cycle style play — same approve/deny flow as quant.`
  ];
  const risks = [
    'This path is the simple dip/pump scanner (not full quant strike model).',
    'Needs live open market; price can move before fill.',
    analysis.volatility != null ? `Recent range volatility ~${analysis.volatility.toFixed(2)}% — chop can fake signals.` : null
  ];
  notify(formatDecisionCard({
    title: `📊 MOMENTUM PLAY — ${name}`,
    subtitle: `${play.side.toUpperCase()} · ${play.dir} · spot $${analysis.price.toFixed(asset === 'DOGE' ? 4 : 2)}`,
    side: play.side, price: 0.5, winProb: play.winProb, edge, stake: betAmount,
    minsToClose: 15, marketTitle: `${name} live crypto market`, ticker: null,
    thesis, risks, category: 'CRYPTO',
    extras: [
      `Move: ${play.move.toFixed(2)}%  ·  High $${analysis.high?.toFixed?.(2) || '?'} / Low $${analysis.low?.toFixed?.(2) || '?'}`,
      `Bet ID: ${pending.id}`
    ]
  }), proposalKeyboard(pending.id));
}
function proposeWeather(opp) {
  const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
  const betAmount = weatherStake(opp.edge);
  const pending = {
    id: Date.now(), type: 'weather', category: 'WEATHER',
    asset: `WX:${opp.cityCode}`, ticker: opp.market.ticker,
    side: opp.side, betAmount, opportunity: opp, timestamp: Date.now()
  };
  botState.pendingBets.push(pending);
  saveState();
  recordProposalMemory(pending);
  const mins = Math.max(0.5, (new Date(opp.market.close_time) - Date.now()) / 60000);
  const price = opp.side === 'yes' ? opp.marketYesPrice : (1 - opp.marketYesPrice);
  const ens = opp.forecast || {};
  const strike = opp.strike != null ? opp.strike : opp.market.floor_strike;
  notify(formatDecisionCard({
    title: `🩵 ${opp.cityName}`,
    subtitle: `WEATHER · high-temp · approval only`,
    side: opp.side, price: Math.max(0.01, Math.min(0.99, price)), winProb,
    edge: Math.abs(opp.edge), stake: betAmount,
    minsToClose: mins, marketTitle: opp.market.title || opp.market.ticker,
    ticker: opp.market.ticker, asset: `WX:${opp.cityCode}`,
    thesis: [
      `Forecast ~${Number(ens.tempF).toFixed(1)}°F vs strike ${strike}°F.`,
      `Model ${pct(opp.modelProb)} vs market ${cents(opp.marketYesPrice)}.`
    ],
    risks: ['Weather can still swing before official high is set.'],
    category: 'WEATHER',
    extras: [`Sources: ${(ens.sourceCount || 1)}`, `ID ${pending.id}`],
    memoryBits: memoryBriefForCard({ asset: `WX:${opp.cityCode}`, side: opp.side, features: { edge: opp.edge }, category: 'WEATHER', ticker: opp.market.ticker })
  }), proposalKeyboard(pending.id));
}

function proposeCommodity(opp) {
  const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
  const betAmount = calculateKellyBetSize(winProb, 0.9);
  const pending = { id: Date.now(), type: 'commodity', ticker: opp.market.ticker, side: opp.side, betAmount, opportunity: opp, timestamp: Date.now() };
  botState.pendingBets.push(pending);
  saveState();
  const mins = Math.max(0.5, (new Date(opp.market.close_time) - Date.now()) / 60000);
  const price = opp.side === 'yes' ? opp.marketYesPrice : (1 - opp.marketYesPrice);
  notify(formatDecisionCard({
    title: `🛢️ COMMODITY PLAY — ${opp.name}`,
    subtitle: `${opp.side.toUpperCase()} · spot ${opp.spot} ${opp.unit}`,
    side: opp.side, price: Math.max(0.01, Math.min(0.99, price)), winProb, edge: Math.abs(opp.edge), stake: betAmount,
    minsToClose: mins, marketTitle: opp.market.title || opp.market.ticker, ticker: opp.market.ticker,
    thesis: [
      `Spot ${opp.spot} ${opp.unit} vs strike ${opp.market.floor_strike}.`,
      `Model ${pct(opp.modelProb)} YES vs market ${cents(opp.marketYesPrice)} → edge ${pp(opp.edge)}.`,
      'Mispricing vs simple spot/strike probability band.'
    ],
    risks: [
      'Commodity series tickers can be wrong — verify with /discover_commodities.',
      'Spot sources lag or gap on news.',
      'Often slower settlement than crypto 15–30m cycles.'
    ],
    category: 'COMMODITY',
    extras: [`Bet ID: ${pending.id}`]
  }), proposalKeyboard(pending.id));
}

// Auto-fire small plays, else propose for approval.
async function handleCryptoPlay(asset, analysis, play) {
  const key = `crypto_${asset}_${play.side}`;
  if (withinCooldown(key)) return;
  if (!windowGate(key, play.side)) return;

  // OWNER REVIEW — consult memory + patterns + 30-day category record.
  const features = buildFeatures(analysis);
  const review = ownerReview({ asset, side: play.side, winProb: play.winProb, features, category: 'CRYPTO' });
  if (!review.ok) { console.log(`Owner skip ${asset}/${play.side}: ${review.note}`); return; }
  markProposed(key); windowMark(key, play.side);
  play = { ...play, winProb: review.prob };
  const meta = { features, patternKey: review.patternKey };

  // Use regime-aware analysis with Kelly sizing
  const regimeAnalysis = analyzeAsset(asset, analysis.price);
  const stake = regimeAnalysis.best ? calcStake(regimeAnalysis.best.prob, regimeAnalysis.best.edge + 0.5) : calculateKellyBetSize(play.winProb, 0.9);
  
  if (shouldAutoExecute(stake)) {
    notify(`⚡ Auto-firing ${THRESHOLDS[asset].name} ${play.side.toUpperCase()} (${play.dir}) — $${stake.toFixed(2)}, win ${(play.winProb * 100).toFixed(0)}% · 🧠 ${review.note}`);
    await executeTrade(asset, analysis, stake, play.side, play, meta);
  } else proposeCrypto(asset, analysis, play);
}
async function handleWeatherOpportunity(opp) {
  const key = `weather_${opp.market.ticker}_${opp.side}`;
  if (withinCooldown(key)) return;
  // Weather: approval-only, rare, uses scout budget — NEVER auto-fire.
  if (!scoutGate(opp.market.ticker, opp.side, 'weather')) return;
  const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
  // Stricter edge for weather spam control
  if (Math.abs(opp.edge) < Math.max(WEATHER_SETTINGS.minEdgeToTrade, 0.08)) return;
  const review = ownerReview({ asset: `WX:${opp.cityCode}`, side: opp.side, winProb, features: { edge: Math.abs(opp.edge) }, category: 'WEATHER' });
  if (!review.ok) {
    console.log(`Owner skip weather ${opp.cityCode}/${opp.side}: ${review.note}`);
    return;
  }
  markProposed(key); scoutMark(opp.market.ticker, opp.side, 'weather');
  // Always propose — user must tap ✅. No auto-execute path for weather.
  proposeWeather(opp);
}
async function handleCommodityOpportunity(opp) {
  const key = `commodity_${opp.market.ticker}_${opp.side}`;
  if (withinCooldown(key)) return;
  if (!windowGate(opp.market.ticker, opp.side)) return;
  const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
  const review = ownerReview({ asset: `CM:${opp.code}`, side: opp.side, winProb, features: { edge: opp.edge }, category: 'COMMODITY' });
  if (!review.ok) { console.log(`Owner skip commodity ${opp.code}/${opp.side}: ${review.note}`); return; }
  markProposed(key); windowMark(opp.market.ticker, opp.side);
  const betAmount = calculateKellyBetSize(review.prob, 0.9);
  const pending = { id: Date.now(), type: 'commodity', ticker: opp.market.ticker, side: opp.side, betAmount, opportunity: opp, timestamp: Date.now() };
  if (shouldAutoExecute(betAmount)) { notify(`⚡ Auto-firing ${opp.name} ${opp.side.toUpperCase()} — $${betAmount.toFixed(2)}`); await executeCommodityTrade(pending); }
  else proposeCommodity(opp);
}

// ============================================
// SCANNERS
// ============================================
// ============================================
// QUANT ENGINE — data-driven binary-option model
// Prices each live Kalshi market with realized volatility + technicals + news,
// then trades the mispricing vs the market's own implied odds.
// ============================================
function stddev(arr) {
  if (arr.length === 0) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}
// Price series with multi-source fallback (Binance first = free & fast, CoinGecko backup).

let _seriesFetchQueue = Promise.resolve();
async function getMinuteSeriesBinance(asset) {
  if (_binanceBlocked) return null;
  const sym = BINANCE_SYM[asset];
  if (!sym) return null;
  try {
    const r = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=500`, { timeout: 5000 });
    const prices = (r.data || []).map(k => parseFloat(k[4])).filter(Number.isFinite);
    return prices.length > 20 ? prices : null;
  } catch (e) {
    if (e.response?.status === 451) {
      _binanceBlocked = true;
      console.log('⚠️ Binance klines geo-blocked (451) — using CoinGecko');
    }
    return null;
  }
}
async function getMinuteSeriesCoinGecko(asset) {
  const id = COIN_IDS[asset];
  if (!id) return null;
  if (Date.now() < _cgCooldownUntil) return null;
  try {
    const r = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=1`, { timeout: 12000 });
    const prices = ((r.data && r.data.prices) || []).map(p => p[1]).filter(Number.isFinite);
    return prices.length > 12 ? prices : null;
  } catch (e) {
    if (e.response?.status === 429) {
      _cgCooldownUntil = Date.now() + 10 * 60 * 1000; // back off 10 min
      if (!getMinuteSeriesCoinGecko._logged) { console.log('CoinGecko limited — Binance primary for 10m'); getMinuteSeriesCoinGecko._logged = true; }
    } else console.error(`market_chart ${asset}:`, e.message);
    return null;
  }
}
async function getMinuteSeries(asset) {
  // If Binance is geo-blocked, go straight to CoinGecko
  if (_binanceBlocked) {
    return await getMinuteSeriesCoinGecko(asset);
  }
  let prices = await getMinuteSeriesBinance(asset);
  if (prices) return prices;
  prices = await getMinuteSeriesCoinGecko(asset);
  return prices;
}
// Long cache + serialized fetches to stop stampeding free APIs.
const seriesCache = {};
async function getMinuteSeriesCached(asset) {
  const c = seriesCache[asset];
  if (c && Date.now() - c.at < 4 * 60 * 1000) return c.data; // 4 min cache
  // serialize
  const run = _seriesFetchQueue.then(async () => {
    const c2 = seriesCache[asset];
    if (c2 && Date.now() - c2.at < 4 * 60 * 1000) return c2.data;
    const data = await getMinuteSeries(asset);
    if (data) seriesCache[asset] = { at: Date.now(), data };
    await sleep(200);
    return data;
  });
  _seriesFetchQueue = run.catch(() => null);
  return run;
}
// Human-readable timeframe from minutes-to-close (for radar/summaries).
function tfLabel(mins) {
  if (mins <= 20) return '15m';
  if (mins <= 45) return '30m';
  if (mins <= 120) return '1h';
  if (mins <= 6 * 60) return `${Math.round(mins / 60)}h`;
  if (mins <= 26 * 60) return '1d';
  return `${Math.round(mins / 60)}h`;
}
function computeIndicators(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const recent = rets.slice(-Math.min(72, rets.length)); // ~6h of 5-min bars
  const sigmaPerInterval = stddev(recent) || 0.0005;
  // Binance 1m bars → per-minute; CoinGecko ~5m fallback still OK with /sqrt(5) bias small
  const barMin = prices.length > 200 ? 1 : 5;
  const sigmaPerMin = (sigmaPerInterval / Math.sqrt(barMin)) * VOL_MULT;
  const rsi = computeRSI(prices, 14);
  const k = Math.min(6, prices.length - 1);
  const momentum = prices[prices.length - 1] / prices[prices.length - 1 - k] - 1;
  const sma = computeSMACross(prices, 50, 100);
  const bb = computeBollinger(prices, 20, 2);
  const mr = meanReversionSignal(rsi, bb);
  return {
    sigmaPerMin, rsi, momentum, spot: prices[prices.length - 1],
    sma50: sma.fast, sma100: sma.slow, smaTrend: sma.trend, smaCross: sma.cross,
    bbUpper: bb.upper, bbMid: bb.mid, bbLower: bb.lower, bbPercent: bb.percent,
    meanRevBuy: mr.buy, meanRevSell: mr.sell, strategyBias: strategyBiasFromIndicators({ rsi, sma, bb, mr, momentum })
  };
}

// ============================================
// STRATEGY ENGINE — Trend · Mean Reversion · Risk
// Ported from classic TradingBot patterns (SMA cross, RSI+BB, 2% stops)
// ============================================
function smaSeries(prices, period) {
  if (!prices || prices.length < period) return null;
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) sum += prices[i];
  return sum / period;
}
function computeSMACross(prices, fastPeriod = 50, slowPeriod = 100) {
  if (!prices || prices.length < slowPeriod + 2) {
    return { fast: null, slow: null, trend: 'flat', cross: 'none' };
  }
  const fast = smaSeries(prices, fastPeriod);
  const slow = smaSeries(prices, slowPeriod);
  // prior bar SMAs for cross detection
  const prevFast = smaSeries(prices.slice(0, -1), fastPeriod);
  const prevSlow = smaSeries(prices.slice(0, -1), slowPeriod);
  let cross = 'none';
  if (prevFast != null && prevSlow != null && fast != null && slow != null) {
    if (prevFast <= prevSlow && fast > slow) cross = 'bull';   // 50 crosses above 100 → buy trend
    else if (prevFast >= prevSlow && fast < slow) cross = 'bear'; // 100 back above 50 → exit/fade
  }
  let trend = 'flat';
  if (fast != null && slow != null) {
    if (fast > slow * 1.0005) trend = 'up';
    else if (fast < slow * 0.9995) trend = 'down';
  }
  return { fast, slow, trend, cross };
}
function computeBollinger(prices, period = 20, numStd = 2) {
  if (!prices || prices.length < period) {
    return { upper: null, mid: null, lower: null, percent: 0.5 };
  }
  const slice = prices.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, x) => s + (x - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance) || 1e-12;
  const upper = mid + numStd * sd;
  const lower = mid - numStd * sd;
  const last = prices[prices.length - 1];
  // %B: <0 below lower band, >1 above upper
  const percent = (last - lower) / (upper - lower);
  return { upper, mid, lower, percent, sd };
}
function meanReversionSignal(rsi, bb) {
  // Classic: oversold RSI + price at/below lower BB → buy / YES bias
  //          overbought RSI + price at/above upper BB → sell / NO bias
  const buy = (rsi != null && rsi < 30) && (bb.percent != null && bb.percent < 0);
  const sell = (rsi != null && rsi > 70) && (bb.percent != null && bb.percent > 1);
  const softBuy = (rsi != null && rsi < 35) && (bb.percent != null && bb.percent < 0.15);
  const softSell = (rsi != null && rsi > 65) && (bb.percent != null && bb.percent > 0.85);
  return { buy: !!(buy || softBuy), sell: !!(sell || softSell), hardBuy: !!buy, hardSell: !!sell };
}
function strategyBiasFromIndicators({ rsi, sma, bb, mr, momentum }) {
  // Combined directional bias in [-1, +1] for YES/NO tilt on Kalshi binaries
  let bias = 0;
  const bits = [];
  if (sma && sma.trend === 'up') { bias += 0.35; bits.push('SMA trend UP'); }
  if (sma && sma.trend === 'down') { bias -= 0.35; bits.push('SMA trend DOWN'); }
  if (sma && sma.cross === 'bull') { bias += 0.45; bits.push('SMA50× above SMA100'); }
  if (sma && sma.cross === 'bear') { bias -= 0.45; bits.push('SMA50× below SMA100'); }
  if (mr && mr.hardBuy) { bias += 0.40; bits.push('MR buy RSI+BB'); }
  else if (mr && mr.buy) { bias += 0.20; bits.push('MR soft buy'); }
  if (mr && mr.hardSell) { bias -= 0.40; bits.push('MR sell RSI+BB'); }
  else if (mr && mr.sell) { bias -= 0.20; bits.push('MR soft sell'); }
  if (momentum != null) {
    if (momentum > 0.004) { bias += 0.1; bits.push('mom+'); }
    if (momentum < -0.004) { bias -= 0.1; bits.push('mom-'); }
  }
  // Wait for clear directional shift — shrink noise
  if (Math.abs(bias) < 0.25) {
    return { bias: 0, clear: false, label: 'no clear shift', bits };
  }
  return {
    bias: clamp(bias, -1, 1),
    clear: true,
    label: bias > 0 ? 'BULL bias' : 'BEAR bias',
    bits
  };
}

// ---- Binance historical klines (REST) ----
const BINANCE_BASE = 'https://api.binance.com/api/v3';
async function fetchHistoricalData(symbol, interval = '1m', startTime = null, limit = 1000) {
  if (_binanceBlocked) return [];
  const params = { symbol, interval, limit: Math.min(1000, limit || 1000) };
  if (startTime) params.startTime = startTime;
  try {
    const r = await axios.get(`${BINANCE_BASE}/klines`, { params, timeout: 5000 });
    return (r.data || []).map(k => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      volume: +k[5], closeTime: k[6]
    }));
  } catch (e) {
    if (e.response?.status === 451) {
      _binanceBlocked = true;
      console.log('⚠️ Binance historical geo-blocked (451)');
    }
    return [];
  }
}
async function fetchHistoricalCloses(asset, interval = '1m', limit = 300) {
  const sym = BINANCE_SYM[asset];
  if (!sym) return null;
  const rows = await fetchHistoricalData(sym, interval, null, limit);
  const closes = rows.map(r => r.close).filter(Number.isFinite);
  return closes.length > 30 ? closes : null;
}

// ---- Lightweight WS trade stream (OPTIONAL — REST is enough) ----
// Binance WS often returns HTTP 451 from some regions/ISPs. Default OFF.
// Enable with ENABLE_WS=true in .env only if your network allows it.
const ENABLE_WS = process.env.ENABLE_WS === 'true';
const streamState = { sockets: {}, lastTrade: {}, running: false, failLogged: false };
function processStreamMessage(asset, msg) {
  try {
    const price = parseFloat(msg.p || msg.price);
    if (!Number.isFinite(price)) return;
    streamState.lastTrade[asset] = { price, t: Date.now() };
    recordPrice(asset, price);
  } catch (_) { /* ignore */ }
}
function startBinanceTradeStream(assets = ['BTC', 'ETH', 'SOL', 'DOGE']) {
  if (!ENABLE_WS) {
    console.log('Live WS off (REST/Binance OK). Set ENABLE_WS=true only if your network allows Binance sockets.');
    return;
  }
  if (streamState.running) return;
  let WebSocket;
  try { WebSocket = require('ws'); } catch (e) {
    console.log('Live stream off (optional: npm i ws). REST/Binance active.');
    return;
  }
  streamState.running = true;
  // Prefer public data host; fall back list
  const hosts = [
    process.env.BINANCE_WS_HOST || 'wss://data-stream.binance.vision',
    'wss://stream.binance.com:9443'
  ];
  for (const asset of assets) {
    const sym = (BINANCE_SYM[asset] || '').toLowerCase();
    if (!sym) continue;
    const url = `${hosts[0]}/ws/${sym}@trade`;
    try {
      const ws = new WebSocket(url);
      streamState.sockets[asset] = ws;
      ws.on('open', () => {
        console.log(`📡 Binance stream ${asset} live`);
      });
      ws.on('message', (raw) => {
        try { processStreamMessage(asset, JSON.parse(raw.toString())); }
        catch (_) { /* ignore */ }
      });
      ws.on('close', () => {
        delete streamState.sockets[asset];
      });
      ws.on('error', (err) => {
        // 451 / geo blocks are common — one quiet line, no Telegram spam
        if (!streamState.failLogged) {
          streamState.failLogged = true;
          console.log(`Live WS unavailable (${err.message || 'blocked'}). Staying on REST — bot is fine.`);
        }
        try { ws.close(); } catch (_) {}
        delete streamState.sockets[asset];
      });
    } catch (e) {
      if (!streamState.failLogged) {
        streamState.failLogged = true;
        console.log(`Live WS unavailable (${e.message}). Staying on REST — bot is fine.`);
      }
    }
  }
}
function stopBinanceTradeStream() {
  for (const [a, ws] of Object.entries(streamState.sockets)) {
    try { ws.close(); } catch (_) {}
    delete streamState.sockets[a];
  }
  streamState.running = false;
}

// ============================================
// PYTH WEBSOCKET PRICE FEED — free, real-time Pyth prices via Kalshi WS
// ============================================
let pythWs = null;
let pythReconnectTimer = null;
let pythPrices = {}; // asset -> { price, ts, confidence }

function startPythPriceStream(assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
  if (pythWs && pythWs.readyState === WebSocket.OPEN) return;
  
  let WebSocket;
  try { WebSocket = require('ws'); } catch (e) {
    console.log('Pyth WS off (optional: npm i ws).');
    return;
  }

  // Kalshi WS endpoint for Pyth prices (authenticated)
  const wsUrl = 'wss://api.elections.kalshi.com/trade-api/v2/ws';
  
  const connect = () => {
    try {
      pythWs = new WebSocket(wsUrl);
      
      pythWs.on('open', () => {
        console.log('🔮 Pyth WS connected');
        
        // Authenticate first
        const ts = Date.now().toString();
        const sig = signKalshiRequest('GET', '/trade-api/v2/ws', ts);
        pythWs.send(JSON.stringify({
          type: 'auth',
          key: KALSHI_API_KEY,
          timestamp: ts,
          signature: sig
        }));
        
        // Subscribe to Pyth prices for our assets
        const tickers = assets.map(a => `crypto.${a.toLowerCase()}`).join(',');
        pythWs.send(JSON.stringify({
          type: 'subscribe',
          channel: 'pyth_value',
          tickers: tickers
        }));
        console.log(`🔮 Subscribed to Pyth: ${tickers}`);
      });
      
      pythWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          
          // Handle error messages from Kalshi
          if (msg.type === 'error' || msg.error) {
            const errorMsg = msg.error || msg.message || msg.detail || 'Unknown error';
            console.error('🔮 Pyth WS server error:', errorMsg);
            
            // Handle specific "Streaming response failed" error
            if (errorMsg.toLowerCase().includes('streaming response failed')) {
              console.log('🔮 Streaming response failed - will reconnect after delay');
              // Force reconnect by closing the connection
              try { pythWs.close(); } catch (_) {}
              return;
            }
            
            // Handle authentication errors
            if (errorMsg.toLowerCase().includes('auth') || errorMsg.toLowerCase().includes('unauthorized')) {
              console.error('🔮 Auth error - check API credentials');
            }
            
            // Handle subscription errors
            if (errorMsg.toLowerCase().includes('subscription') || errorMsg.toLowerCase().includes('subscribe')) {
              console.error('🔮 Subscription error - will retry on reconnect');
            }
            return;
          }
          
          if (msg.type === 'pyth_value' && msg.data) {
            for (const update of msg.data) {
              // update: { ticker: 'crypto.btc', price: 67420.5, conf: 12.3, ts: 1234567890 }
              const asset = update.ticker.replace('crypto.', '').toUpperCase();
              if (assets.includes(asset)) {
                pythPrices[asset] = {
                  price: parseFloat(update.price),
                  confidence: parseFloat(update.conf || 0),
                  ts: Date.now()
                };
                // Also record to our price history for analysis
                if (pythPrices[asset].price > 0) recordPrice(asset, pythPrices[asset].price);
}
}

// ============================================
// FAIL-SAFES & RESILIENCE — never crash, always recover
// ============================================

// Safe WebSocket wrapper with auto-reconnect
let pythReconnectAttempts = 0;
const MAX_PYTH_RECONNECT_ATTEMPTS = 10;

function safePythConnect() {
  if (pythReconnectAttempts >= 10) {
    console.error('🔮 Max Pyth reconnect attempts reached — pausing 5 min');
    setTimeout(startPythPriceStream, 5 * 60 * 1000);
    pythReconnectAttempts = 0;
    return;
  }
  pythReconnectAttempts++;
  startPythPriceStream();
}

// Safe executeTrade with auto-retry
const originalExecuteTrade = executeTrade;
executeTrade = async function(...args) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await originalExecuteTrade.apply(this, arguments);
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`⚠️ Trade retry ${attempt}/3:`, err.message);
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
};

// Safe executeTrade with auto-retry for shouldAutoExecute
const originalShouldAutoExecute = shouldAutoExecute;
shouldAutoExecute = function(amount) {
  try {
    return originalShouldAutoExecute(amount);
  } catch (e) {
    console.error('shouldAutoExecute error:', e.message);
    return false;
  }
};

// Global uncaught exception handler - never crash
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message, err.stack);
  saveState();
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason?.message || reason);
});

// Graceful shutdown
const shutdown = () => {
  console.log('\n🛑 Graceful shutdown...');
  try { stopPythPriceStream(); } catch (_) {}
  try { stopBinanceTradeStream(); } catch (_) {}
  try { saveState(); } catch (_) {}
  console.log('👋 Bye!');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Global uncaught exception handler - never crash
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message, err.stack);
  saveState();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason?.message || reason);
});
            console.log(`🔮 Pyth subscribed: ${msg.channel}`);
          }
        } catch (_) {}
      });
      
      pythWs.on('close', () => {
        console.log('🔮 Pyth WS closed, reconnecting in 10s...');
        pythReconnectTimer = setTimeout(connect, 10000);
      });
      
      pythWs.on('error', (err) => {
        // Handle specific Kalshi WebSocket errors
        const errMsg = err.message || err.toString();
        
        if (errMsg.includes('Streaming response failed')) {
          console.error('🔮 Streaming response failed - forcing reconnect');
          try { pythWs.close(); } catch (_) {}
          return;
        }
        
        if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) {
          // Network issues - will reconnect automatically
          console.log('🔮 Network issue - will reconnect');
          return;
        }
        
        if (errMsg.includes('ECONNRESET') || errMsg.includes('ETIMEDOUT')) {
          console.log('🔮 Connection reset/timeout - will reconnect');
          return;
        }
        
        // Only log unexpected errors
        console.error('Pyth WS error:', err.message);
      });
    } catch (e) {
      console.error('Pyth WS connect failed:', e.message);
      pythReconnectTimer = setTimeout(connect, 10000);
    }
  };
  
  connect();
}

function stopPythPriceStream() {
  if (pythReconnectTimer) clearTimeout(pythReconnectTimer);
  if (pythWs) {
    try { pythWs.close(); } catch (_) {}
    pythWs = null;
  }
}

// Get latest Pyth price for an asset (or null if stale >30s)
function getPythPrice(asset) {
  const p = pythPrices[asset];
  if (!p) return null;
  if (Date.now() - p.ts > 30000) return null; // stale after 30s
  return p.price;
}

// Add Pyth to our price source chain
function addPythToPriceSources() {
  // This will be called from getAllSpotPrices
}

// ---- Alerts (Telegram-friendly) ----
function sendAlert(eventType, details) {
  const alerts = {
    trade_executed: `✅ Trade placed: ${details}`,
    position_change: `📌 Position updated: ${details}`,
    pnl_update: `💰 P&L: ${details}`,
    error: `🚨 ERROR: ${details}`,
    connection_lost: `🔌 DISCONNECTED: ${details}`,
    emergency_stop: `🛑 EMERGENCY STOP: ${details}`,
    risk_block: `⛔ Risk block: ${details}`,
    strategy: `📐 Strategy: ${details}`
  };
  const msg = alerts[eventType] || `Event: ${details}`;
  try { notify(msg); } catch (_) { console.log(msg); }
  return msg;
}

// ---- Portfolio risk engine (TradingBot-style) ----
class TradingBotRisk {
  constructor(initialPortfolioValue) {
    this.positionSize = RISK_RULES.positionSizePct; // 2%
    this.maxDrawdown = RISK_RULES.maxDrawdown;       // 15%
    this.portfolioValue = initialPortfolioValue || BANKROLL;
  }
  calculateSignals(closes) {
    if (!closes || closes.length < 100) return { buy: false, sell: false, rsi: null, bbPercent: null };
    const rsi = computeRSI(closes, 14);
    const bb = computeBollinger(closes, 20, 2);
    const buy = (rsi < 30) && (bb.percent < 0);
    const sell = (rsi > 70) && (bb.percent > 1);
    return { buy, sell, rsi, bbPercent: bb.percent, bb };
  }
  checkRiskLimits(position = {}) {
    const equity = this.portfolioValue + (position.unrealized_pnl || 0);
    const peak = botState.risk.peakEquity != null ? botState.risk.peakEquity : this.portfolioValue;
    const dd = peak > 0 ? (equity - peak) / peak : 0;
    if (dd <= -this.maxDrawdown) {
      return { ok: false, reason: `max drawdown ${pct(Math.abs(dd))} ≥ ${pct(this.maxDrawdown)}` };
    }
    return { ok: true, drawdown: dd };
  }
  sizeForTrade(equity) {
    const base = (equity || this.portfolioValue) * this.positionSize;
    const cap = (equity || this.portfolioValue) * RISK_RULES.maxPerTradePercent;
    return Math.max(0.05, Math.min(base, cap, FIXED_BET_USD * 3));
  }
}
const tradingBot = new TradingBotRisk(BANKROLL);

function dayKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
function ensureRiskDay() {
  if (!botState.risk) botState.risk = { dayKey: null, dayStartEquity: null, dayPnl: 0, peakEquity: null, emergencyHalt: false, haltReason: null };
  const k = dayKeyNow();
  const equity = portfolioEquity();
  if (botState.risk.dayKey !== k) {
    botState.risk.dayKey = k;
    botState.risk.dayStartEquity = equity;
    botState.risk.dayPnl = 0;
    // don't clear emergency across days automatically if still deep — reset daily
    botState.risk.emergencyHalt = false;
    botState.risk.haltReason = null;
  }
  if (botState.risk.peakEquity == null || equity > botState.risk.peakEquity) {
    botState.risk.peakEquity = equity;
  }
  tradingBot.portfolioValue = equity;
  return botState.risk;
}
function portfolioEquity() {
  // Use live Kalshi balance if available (refreshed every 60s)
  if (botState.liveBalance != null && isFinite(botState.liveBalance)) {
    return botState.liveBalance;
  }
  const closed = botState.stats.totalProfit || 0;
  const open = (botState.openBets || []).reduce((s, b) => s + (b.amount || 0), 0);
  // mark open at cost (conservative); realized lives in totalProfit
  return BANKROLL + closed;
}
function dailyPnl() {
  ensureRiskDay();
  return botState.risk.dayPnl || 0;
}
function haltAllTrading(reason) {
  botState.isRunning = false;
  botState.risk.emergencyHalt = true;
  botState.risk.haltReason = reason || 'halt';
  saveState();
  sendAlert('emergency_stop', reason || 'trading halted');
}
function checkEmergencyStop() {
  ensureRiskDay();
  const equity = portfolioEquity();
  const start = botState.risk.dayStartEquity || equity;
  const dayPnl = botState.risk.dayPnl || 0;
  
  // Daily loss limit (percentage-based)
  if (start > 0 && dayPnl < 0 && Math.abs(dayPnl / start) >= RISK_RULES.dailyLossLimit) {
    haltAllTrading(`daily drawdown ${pct(Math.abs(dayPnl / start))} ≥ ${pct(RISK_RULES.dailyLossLimit)}`);
    return true;
  }
  
  // Dollar-based emergency stop
  const dailyLossLimitDollars = RISK_RULES.dailyLossLimitDollars || RISK_RULES.dailyLossLimit * start;
  if (dayPnl < 0 && Math.abs(dayPnl) >= dailyLossLimitDollars) {
    haltAllTrading(`daily dollar loss $${Math.abs(dayPnl).toFixed(2)} hits $${dailyLossLimitDollars.toFixed(2)} emergency stop`);
    return true;
  }
  
  // Max drawdown from peak
  const peak = botState.risk.peakEquity || equity;
  if (peak > 0 && (equity - peak) / peak <= -RISK_RULES.maxDrawdown) {
    haltAllTrading(`max drawdown from peak ≥ ${pct(RISK_RULES.maxDrawdown)}`);
    return true;
  }
  
  // Emergency stop percentage
  if (start > 0 && dayPnl < 0 && Math.abs(dayPnl / start) >= RISK_RULES.emergencyStopPct) {
    haltAllTrading(`emergency stop: drawdown ${pct(Math.abs(dayPnl / start))} ≥ ${pct(RISK_RULES.emergencyStopPct)}`);
    return true;
  }
  
  return false;
}
function checkRiskLimits(position = {}) {
  // Emergency halt
  if (botState.risk && botState.risk.emergencyHalt) {
    return { ok: false, reason: `emergency halt: ${botState.risk.haltReason || 'trading halted'}` };
  }
  // Daily loss cap (dollar-based)
  const equity = portfolioEquity();
  const dayStart = (botState.risk && botState.risk.dayStartEquity) || equity;
  const dayPnl = (botState.risk && botState.risk.dayPnl) || 0;
  const dailyLimitDollars = RISK_RULES.dailyLossLimitDollars || 5;
  if (dayPnl < 0 && Math.abs(dayPnl) >= dailyLimitDollars) {
    return { ok: false, reason: `daily loss $${Math.abs(dayPnl).toFixed(2)} >= $${dailyLimitDollars.toFixed(2)} limit` };
  }
  // Max drawdown from peak
  const peak = (botState.risk && botState.risk.peakEquity) || equity;
  if (peak > 0 && (equity - peak) / peak <= -RISK_RULES.maxDrawdown) {
    return { ok: false, reason: `drawdown ${pct(Math.abs((equity - peak) / peak))} >= ${pct(RISK_RULES.maxDrawdown)} max` };
  }
  // Open exposure cap — only count crypto 15m/30m bets, ignore stale/wrong-market bets
  const cryptoOpenBets = (botState.openBets || []).filter(b => {
    const t = b.ticker || '';
    if (!t.startsWith('KX')) return false; // ignore non-Kalshi or wrong-market bets
    if (b.status === 'locked' || b.status === 'stopped') return false; // already hedged, not real exposure
    const age = Date.now() - (b.timestamp || 0);
    if (age > 90 * 60 * 1000) return false; // older than 90 min = stale, ignore
    return true;
  });
  const openExposure = cryptoOpenBets.reduce((s, b) => s + (b.amount || 0), 0) + (reservedExposure || 0);
  if (openExposure >= BANKROLL * 0.8) {
    return { ok: false, reason: `open exposure $${openExposure.toFixed(2)} >= 80% bankroll` };
  }
  return { ok: true };
}

function applyRiskToStake(desired) {
  const equity = Math.max(0, portfolioEquity());
  const base = Math.max(equity, BANKROLL);
  const maxTrade = base * RISK_RULES.maxPerTradePercent;
  const unit = base * RISK_RULES.positionSizePct;
  let stake = desired != null ? desired : Math.min(FIXED_BET_USD, unit);
  stake = Math.min(stake, maxTrade, unit * 1.5);
  // Vol-aware 2% stop reference: if recent sigma huge, cut size
  return Math.max(0.05, Math.round(stake * 100) / 100);
}

// ---- Backtest harness (offline /telegram /backtest) ----
function generateSignal(dataPoint, params = {}) {
  // dataPoint: { closes: number[] } full series up to bar
  const closes = dataPoint.closes || dataPoint;
  if (!closes || closes.length < (params.slow || 100) + 5) return null;
  const rsi = computeRSI(closes, params.rsiPeriod || 14);
  const bb = computeBollinger(closes, params.bbPeriod || 20, params.bbStd || 2);
  const sma = computeSMACross(closes, params.fast || 50, params.slow || 100);
  // Priority: clear SMA cross, else hard mean-reversion
  if (sma.cross === 'bull') return { side: 'yes', kind: 'trend_cross_bull', rsi, bb: bb.percent, trend: sma.trend };
  if (sma.cross === 'bear') return { side: 'no', kind: 'trend_cross_bear', rsi, bb: bb.percent, trend: sma.trend };
  if ((rsi < 30) && (bb.percent < 0)) return { side: 'yes', kind: 'mean_rev_buy', rsi, bb: bb.percent, trend: sma.trend };
  if ((rsi > 70) && (bb.percent > 1)) return { side: 'no', kind: 'mean_rev_sell', rsi, bb: bb.percent, trend: sma.trend };
  return null;
}
function executeTradeSim(dataPoint, signal, stake = 1) {
  // Next-bar binary proxy: YES wins if next close > this close
  const closes = dataPoint.closes;
  const i = closes.length - 1;
  if (i + 1 >= dataPoint.full.length) return null;
  const px = dataPoint.full[i];
  const nxt = dataPoint.full[i + 1];
  const up = nxt > px;
  const won = (signal.side === 'yes' && up) || (signal.side === 'no' && !up);
  // Assume ~ fair 50¢ entry for sim edge study
  const profit = won ? stake : -stake;
  return { t: i, side: signal.side, kind: signal.kind, won, profit, rsi: signal.rsi };
}
function calculateMetrics(results) {
  const trades = results.trades || [];
  const wins = trades.filter(t => t.won).length;
  const pnl = trades.reduce((s, t) => s + (t.profit || 0), 0);
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    win_rate: trades.length ? wins / trades.length : 0,
    profit_loss: pnl,
    byKind: trades.reduce((m, t) => {
      m[t.kind] = m[t.kind] || { n: 0, wins: 0, pnl: 0 };
      m[t.kind].n++; if (t.won) m[t.kind].wins++; m[t.kind].pnl += t.profit || 0;
      return m;
    }, {})
  };
}
function backtestStrategy(historicalCloses, strategyParams = {}) {
  const results = { trades: [], profit_loss: 0, win_rate: 0 };
  if (!historicalCloses || historicalCloses.length < 120) return { ...calculateMetrics(results), error: 'not enough bars' };
  const full = historicalCloses;
  const slow = strategyParams.slow || 100;
  for (let i = slow + 5; i < full.length - 1; i++) {
    const closes = full.slice(0, i + 1);
    const signal = generateSignal({ closes, full }, strategyParams);
    if (!signal) continue;
    const trade = executeTradeSim({ closes, full }, signal, strategyParams.stake || 1);
    if (trade) results.trades.push(trade);
  }
  return calculateMetrics(results);
}
async function runAssetBacktest(asset, interval = '1m', limit = 500) {
  const closes = await fetchHistoricalCloses(asset, interval, limit);
  if (!closes) return { asset, error: 'no data' };
  const metrics = backtestStrategy(closes, { fast: 50, slow: 100, stake: 1 });
  return { asset, interval, bars: closes.length, ...metrics };
}

// ============================================
// ONLINE RESEARCH BACKBONE — free public sources
// Feeds every category (quant / niche / quant-niche / weather / commodity).
// ============================================
const researchCache = { global: null, byAsset: {}, headlines: null };
async function fetchJsonSafe(url, timeout = 10000) {
  try {
    const r = await axios.get(url, { timeout, headers: { 'User-Agent': 'KalshiQuantBot/3.0' } });
    return r.data;
  } catch (e) {
    return null;
  }
}
async function getBtcDominanceResearch() {
  const c = researchCache.global;
  if (c && Date.now() - c.at < 20 * 60 * 1000) return c.val;
  // CoinGecko global — free
  const data = await fetchJsonSafe('https://api.coingecko.com/api/v3/global');
  if (!data || !data.data) return { score: 0, label: 'global n/a', btcDom: null, mcapChange: null };
  const g = data.data;
  const btcDom = g.market_cap_percentage && g.market_cap_percentage.btc != null ? g.market_cap_percentage.btc : null;
  const mcapChange = g.market_cap_change_percentage_24h_usd != null ? g.market_cap_change_percentage_24h_usd : null;
  // Mild tilt: strong 24h mcap dump → slight contrarian bounce bias; pump → slight fade
  let score = 0;
  if (mcapChange != null) score = clamp(-mcapChange / 8, -0.6, 0.6); // contrarian on 24h mcap
  const val = {
    score,
    label: `mcap24h ${mcapChange != null ? mcapChange.toFixed(1) + '%' : '?'} · btcDom ${btcDom != null ? btcDom.toFixed(1) + '%' : '?'}`,
    btcDom, mcapChange
  };
  researchCache.global = { at: Date.now(), val };
  return val;
}
async function getAssetMarketResearch(asset) {
  const id = COIN_IDS[asset];
  if (!id) return { score: 0, label: 'n/a', bits: [] };
  const c = researchCache.byAsset[asset];
  if (c && Date.now() - c.at < 12 * 60 * 1000) return c.val;
  const data = await fetchJsonSafe(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`);
  if (!data || !data.market_data) return { score: 0, label: 'md n/a', bits: [] };
  const md = data.market_data;
  const ch1 = md.price_change_percentage_1h_in_currency && md.price_change_percentage_1h_in_currency.usd;
  const ch24 = md.price_change_percentage_24h;
  const ch7 = md.price_change_percentage_7d;
  const bits = [];
  if (ch1 != null) bits.push(`1h ${ch1 >= 0 ? '+' : ''}${Number(ch1).toFixed(2)}%`);
  if (ch24 != null) bits.push(`24h ${ch24 >= 0 ? '+' : ''}${Number(ch24).toFixed(2)}%`);
  if (ch7 != null) bits.push(`7d ${ch7 >= 0 ? '+' : ''}${Number(ch7).toFixed(1)}%`);
  // Objective tilt: short-horizon continuation mild, fade extremes
  let score = 0;
  if (ch1 != null) score += clamp(ch1 / 3, -0.4, 0.4); // mild continuation 1h
  if (ch24 != null && Math.abs(ch24) > 6) score += clamp(-ch24 / 20, -0.3, 0.3); // fade big 24h moves
  const val = { score: clamp(score, -1, 1), label: bits.join(' · ') || 'md', bits, ch1, ch24, ch7 };
  researchCache.byAsset[asset] = { at: Date.now(), val };
  return val;
}
async function getCryptoHeadlinesResearch() {
  const c = researchCache.headlines;
  if (c && Date.now() - c.at < 25 * 60 * 1000) return c.val;
  // CryptoCompare social/news — free tier, no key required for general news
  const data = await fetchJsonSafe('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
  const articles = (data && data.Data) || [];
  if (!articles.length) return { score: 0, label: 'news n/a', top: [] };
  const top = articles.slice(0, 6).map(a => ({
    title: (a.title || '').slice(0, 120),
    source: a.source_info && a.source_info.name || a.source || '?',
    cats: a.categories || ''
  }));
  // Naive keyword polarity
  let bull = 0, bear = 0;
  const blob = top.map(t => t.title).join(' ').toLowerCase();
  for (const w of ['surge', 'rally', 'etf', 'approval', 'record', 'bull', 'inflow', 'partnership']) if (blob.includes(w)) bull++;
  for (const w of ['hack', 'sec', 'ban', 'crash', 'lawsuit', 'fraud', 'outflow', 'bear', 'probe']) if (blob.includes(w)) bear++;
  const score = clamp((bull - bear) / 5, -1, 1);
  const val = { score, label: `news Δ${bull - bear} (b${bull}/s${bear})`, top, bull, bear };
  researchCache.headlines = { at: Date.now(), val };
  // Persist a slim snapshot into depository research log
  try {
    const d = dep();
    d.research = d.research || [];
    d.research.unshift({ t: Date.now(), kind: 'headlines', label: val.label, top: top.slice(0, 3).map(x => x.title) });
    if (d.research.length > 80) d.research.length = 80;
  } catch (_) { /* ignore */ }
  return val;
}
async function getFullResearchBundle(asset) {
  const [fng, global, mkt, news] = await Promise.all([
    getNewsSentiment(asset),
    getBtcDominanceResearch(),
    getAssetMarketResearch(asset),
    getCryptoHeadlinesResearch()
  ]);
  // Combined score: F&G contrarian + market structure + headlines (damped)
  const score = clamp(
    (fng.score || 0) * 0.45 + (global.score || 0) * 0.2 + (mkt.score || 0) * 0.25 + (news.score || 0) * 0.1,
    -1, 1
  );
  const bits = [
    fng.label ? `F&G ${fng.label}` : null,
    global.label ? `Global ${global.label}` : null,
    mkt.label ? `${asset} ${mkt.label}` : null,
    news.label ? `Headlines ${news.label}` : null
  ].filter(Boolean);
  return { score, bits, fng, global, mkt, news };
}

// ============================================
// SIMPLE 15-MINUTE QUANT CYCLE
// Every :00/:15/:30/:45 — research + prior memory → fire best hits → deposit → repeat.
// ============================================
function currentCycleId(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const q = Math.floor(d.getMinutes() / 15) * 15;
  const qq = String(q).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${qq}`;
}
function minutesIntoHour(ts = Date.now()) {
  const d = new Date(ts);
  return d.getMinutes() + d.getSeconds() / 60;
}
function msToNextHour(ts = Date.now()) {
  // next 15m boundary (compat name)
  return msToNext15(ts);
}
// Single phase always — research + memory → hit plays. No full-edge flip.
function quantCyclePhase(ts = Date.now()) {
  const d = new Date(ts);
  const minIntoWindow = d.getMinutes() % 15 + d.getSeconds() / 60;
  return {
    name: 'hit',
    label: '15m HIT CYCLE',
    edgeBar: CRYPTO_EDGE_THRESHOLD,
    confBar: RISK_RULES.minConfidenceToTrade,
    preferLowMoney: false,
    maxFire: QUANT_FIRE_MAX,
    minIntoHour: minutesIntoHour(ts),
    minIntoWindow
  };
}
function liveWindowKey(ts = Date.now()) {
  return currentCycleId(ts);
}
let _cycleState = {
  cycleId: null,
  depositWritten: false,
  phaseNotified: null,
  liveWindow: null,
  scanCount: 0,
  proposed: 0,
  firedKeys: new Set(),
  bestEdges: [],
  researchBits: [],
  phaseStats: { hit: 0, pattern: 0, edge: 0 },
  startedAt: null,
  // Cycle history for learning
  history: []  // { cycleId, proposed, taken, hit, timestamp }
};
function resetCycleRuntimeIfNeeded(ts = Date.now()) {
  const id = currentCycleId(ts);
  if (_cycleState.cycleId !== id) {
    if (_cycleState.cycleId && !_cycleState.depositWritten) {
      try { finalizeCycleDeposit('rollover'); } catch (_) { /* ignore */ }
    }
    _cycleState = {
      cycleId: id,
      depositWritten: false,
      phaseNotified: null,
      liveWindow: id,
      scanCount: 0,
      proposed: 0,
      firedKeys: new Set(),
      bestEdges: [],
      researchBits: [],
      phaseStats: { hit: 0, pattern: 0, edge: 0 },
      startedAt: ts
    };
    firedQuant.clear();
    console.log(`⏱ New 15m cycle ${_cycleState.cycleId}`);
  }
  return _cycleState;
}
function finalizeCycleDeposit(reason = 'window-end') {
  ensureMemoryShape();
  const d = dep();
  const id = _cycleState.cycleId || currentCycleId();
  if ((d.cycles || []).some(c => c.id === id && c.final)) {
    _cycleState.depositWritten = true;
    return null;
  }
  const phase = quantCyclePhase();
  const plays = (d.plays || []).filter(p => p.cycleId === id);
  const taken = plays.filter(p => p.taken);
  const deposit = {
    id,
    t: Date.now(),
    reason,
    final: reason === 'window-end' || reason === 'rollover' || reason === 'hour-end',
    phaseAtWrite: phase.name,
    scanCount: _cycleState.scanCount || 0,
    proposed: _cycleState.proposed || plays.length,
    taken: taken.length,
    phaseStats: { ...(_cycleState.phaseStats || {}) },
    bestEdges: (_cycleState.bestEdges || []).slice(0, 8),
    researchBits: (_cycleState.researchBits || []).slice(0, 8),
    plays: plays.slice(0, 20).map(p => ({
      asset: p.asset, side: p.side, ticker: p.ticker, edge: p.edge,
      winProb: p.winProb, category: p.category, taken: !!p.taken, phase: p.phase
    })),
    categorySnap: ['CRYPTO', 'NICHE', 'QUANT_NICHE', 'LONGSHOT', 'WEATHER', 'COMMODITY'].map(cat => {
      const cs = categoryStats(cat, 30);
      return cs ? { cat, n: cs.n, wr: cs.winRate, net: cs.net } : { cat, n: 0 };
    })
  };
  d.cycles = d.cycles || [];
  const idx = d.cycles.findIndex(c => c.id === id);
  if (idx >= 0) d.cycles[idx] = deposit;
  else d.cycles.unshift(deposit);
  if (d.cycles.length > CYCLE_DEPOSIT_MAX) d.cycles.length = CYCLE_DEPOSIT_MAX;
  d.stats.cycles = (d.stats.cycles || 0) + (deposit.final ? 1 : 0);
  botState.memory.updatedAt = Date.now();
  _cycleState.depositWritten = !!deposit.final;
  saveState();

  // Track cycle history for learning (last 50 cycles)
  _cycleState.history = _cycleState.history || [];
  _cycleState.history.unshift({
    cycleId: id,
    proposed: deposit.proposed || 0,
    taken: deposit.taken || 0,
    hit: deposit.taken || 0, // simplified - actual hits tracked at settlement
    timestamp: Date.now()
  });
  if (_cycleState.history.length > 50) _cycleState.history.length = 50;

  return deposit;
}
function cycleMemoryHints() {
  // What prior cycles taught us — used to rank plays this window
  ensureMemoryShape();
  const d = dep();
  const hints = { boost: {}, fade: {}, notes: [] };
  // Side performance
  for (const [k, v] of Object.entries(d.sides || {})) {
    if ((v.trades || 0) < 4) continue;
    const s = bucketStats(v);
    if (s.winRate >= 0.58) hints.boost[k] = s.winRate;
    if (s.winRate <= 0.40) hints.fade[k] = s.winRate;
  }
  // Hot patterns
  const pats = Object.entries(botState.memory.patterns || {})
    .filter(([, p]) => (p.trades || 0) >= MIN_SAMPLES_TO_TRUST)
    .sort((a, b) => (b[1].wins / b[1].trades) - (a[1].wins / a[1].trades));
  for (const [k, p] of pats.slice(0, 5)) {
    const wr = p.wins / p.trades;
    if (wr >= 0.55) hints.notes.push(`hot pattern ${k.split('|').slice(0, 2).join('|')} ${pct(wr)}`);
    if (wr <= 0.35) hints.notes.push(`cold pattern ${k.split('|').slice(0, 2).join('|')} ${pct(wr)}`);
  }
  // Last few cycle deposits
  for (const c of (d.cycles || []).slice(0, 4)) {
    if (c.bestEdges && c.bestEdges[0]) {
      const b = c.bestEdges[0];
      hints.notes.push(`prior ${c.id}: best ${b.asset} ${b.side} ${b.edge != null ? pp(b.edge) : ''}`);
    }
  }
  return hints;
}
function cycleHistorySummary(limit = 10) {
  ensureMemoryShape();
  const d = dep();
  const cycles = d.cycles || [];
  if (!cycles.length) return null;
  const last = cycles.slice(0, limit);
  let proposed = 0, taken = 0, hit = 0;
  for (const c of last) {
    proposed += c.proposed || 0;
    taken += c.taken || 0;
    hit += c.hit || 0;
  }
  return { proposed, taken, hit, saveRate: proposed > 0 ? taken / proposed : 0, hitRate: taken > 0 ? hit / taken : 0 };
}
function cycleAnalysisBrief(limit = 6) {
  ensureMemoryShape();
  const d = dep();
  const cycles = d.cycles || [];
  if (!cycles.length) return ['No cycle history yet — first 15m window will seed it.'];
  const lines = [];
  const last = cycles.slice(0, limit);
  let taken = 0, proposed = 0;
  for (const c of last) { taken += c.taken || 0; proposed += c.proposed || 0; }
  lines.push(`Last ${last.length} windows: sent ${proposed} · taken ${taken}`);
  for (const c of last.slice(0, 4)) {
    const be = (c.bestEdges || [])[0];
    lines.push(`· ${c.id} p${c.proposed || 0}/t${c.taken || 0}` + (be ? ` best ${be.asset || ''} ${String(be.side || '').toUpperCase()}` : ''));
  }
  const plays = d.plays || [];
  if (plays.length >= 3) {
    const yes = plays.filter(p => p.side === 'yes').length;
    const no = plays.filter(p => p.side === 'no').length;
    lines.push(`Ledger: ${plays.length} plays · YES ${yes} / NO ${no} · taken ${plays.filter(p => p.taken).length}`);
  }
  return lines;
}

let fngCache = null;
// Crypto Fear & Greed index — free, no key. Market-wide sentiment 0-100.
// Applied contrarian & mild: extreme fear = slight bullish tilt, extreme greed = slight bearish.
async function getNewsSentiment(asset) {
  const now = Date.now();
  if (fngCache && now - fngCache.at < 30 * 60 * 1000) return fngCache.val;
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 10000 });
    const d = r.data && r.data.data && r.data.data[0];
    if (!d) return { score: 0, label: 'n/a' };
    const value = parseInt(d.value, 10);
    const score = clamp((50 - value) / 50, -1, 1); // contrarian
    const val = { score, label: `${d.value_classification} ${value}`, value };
    fngCache = { at: now, val };
    return val;
  } catch (e) { console.error('Fear&Greed fetch:', e.message); return { score: 0, label: 'err' }; }
}

// Full data-driven read of one asset's live market (default = first series, i.e.
// 15-min). Pass a seriesTicker to analyze a specific timeframe (30m/hourly/daily).
async function analyzeCryptoMarket(asset, seriesTicker = null) {
  const market = seriesTicker ? await findLiveMarketBySeries(seriesTicker) : await findLiveMarketTicker(asset);
  if (!market) return { asset, series: seriesTicker, error: 'no open market' };
  const K = (market.floor_strike != null) ? market.floor_strike : (market.cap_strike != null ? market.cap_strike : null);
  const yesAsk = parseFloat(market.yes_ask_dollars);
  const noAsk = parseFloat(market.no_ask_dollars);
  const minsToClose = Math.max(0.5, (new Date(market.close_time) - Date.now()) / 60000);
  const volume = getMarketVolume(market);
  const series = await getMinuteSeriesCached(asset);
  if (!series) return { asset, series: seriesTicker, market, ticker: market.ticker, minsToClose, volume, error: 'no price series' };
  const ind = computeIndicators(series);
  const S = botState.prices[asset] || ind.spot;
  if (K == null || isNaN(yesAsk) || isNaN(noAsk)) return { asset, series: seriesTicker, market, ticker: market.ticker, ind, minsToClose, volume, error: 'market missing strike/price' };

  // Diffusion model: P(S_T > K) with momentum drift + realized vol.
  // Tighter drift clamp + higher VOL_MULT reduces overconfident short-window edges.
  const muPerMin = clamp(ind.momentum / 45, -0.00035, 0.00035);
  const sigmaT = Math.max(ind.sigmaPerMin * Math.sqrt(minsToClose), 1e-5);
  const drift = (muPerMin - 0.5 * ind.sigmaPerMin ** 2) * minsToClose;
  let modelProb = normalCDF((Math.log(Math.max(S, 1e-12) / Math.max(K, 1e-12)) + drift) / sigmaT, 0, 1);

  // Technical tilt — mean-reversion only at true extremes, smaller than before
  if (ind.rsi < 25) modelProb += 0.02; else if (ind.rsi > 75) modelProb -= 0.02;
  else if (ind.rsi < 30) modelProb += 0.01; else if (ind.rsi > 70) modelProb -= 0.01;

  // STRATEGY ENGINE: clear trend (SMA50/100) + mean reversion (RSI+BB)
  // Only act on clear directional shifts — wait for signal, don't force noise.
  const strat = ind.strategyBias || { bias: 0, clear: false, bits: [] };
  if (strat.clear) {
    modelProb = clamp(modelProb + strat.bias * 0.04, 0.03, 0.97);
  }

  // Online research backbone (cached — don't hammer free APIs each market)
  if (!analyzeCryptoMarket._rCache) analyzeCryptoMarket._rCache = {};
  const _rc = analyzeCryptoMarket._rCache[asset];
  let research;
  if (_rc && Date.now() - _rc.at < 8 * 60 * 1000) research = _rc.val;
  else {
    try { research = await getFullResearchBundle(asset); }
    catch (_) { research = { score: 0, bits: [], fng: { score: 0, label: 'n/a' } }; }
    analyzeCryptoMarket._rCache[asset] = { at: Date.now(), val: research };
  }
  const news = research.fng || { score: 0, label: 'n/a' };
  modelProb = clamp(modelProb + (research.score || 0) * 0.025, 0.03, 0.97);

  // Moneyline sanity: if spot is already far past strike relative to remaining vol,
  // pull model toward the obvious side (reduces "fade a locked ITM" disasters).
  const moneyness = Math.log(Math.max(S, 1e-12) / Math.max(K, 1e-12)) / sigmaT;
  if (moneyness > 2.2) modelProb = Math.max(modelProb, 0.82);
  if (moneyness < -2.2) modelProb = Math.min(modelProb, 0.18);
  if (moneyness > 1.4) modelProb = Math.max(modelProb, 0.68);
  if (moneyness < -1.4) modelProb = Math.min(modelProb, 0.32);

  const yesEdge = modelProb - yesAsk;
  const noEdge = (1 - modelProb) - noAsk;
  let side = null, edge = 0, winProb = 0, price = 0;
  if (yesEdge >= noEdge && yesEdge > 0) { side = 'yes'; edge = yesEdge; winProb = modelProb; price = yesAsk; }
  else if (noEdge > 0) { side = 'no'; edge = noEdge; winProb = 1 - modelProb; price = noAsk; }

  // Pattern memory soft prior: if this fingerprint historically wins/loses, nudge
  try {
    const tmpFeat = { rsi: ind.rsi, momentum: ind.momentum, sigmaPerMin: ind.sigmaPerMin, minsToClose, edge, fng: news.value };
    if (side) {
      const pk = patternKey(asset, side, tmpFeat);
      const pwr = patternWinRate(pk);
      if (pwr != null) {
        // Blend 15% pattern prior into winProb (objective+pattern phase leans on this harder upstream)
        winProb = clamp(winProb * 0.85 + pwr * 0.15, 0.03, 0.97);
        edge = side === 'yes' ? (winProb - yesAsk) : (winProb - noAsk);
        modelProb = side === 'yes' ? winProb : (1 - winProb);
      }
    }
  } catch (_) { /* ignore */ }

  const stratBits = (strat && strat.bits) ? strat.bits.slice(0, 3) : [];
  return {
    asset, series: seriesTicker, tf: tfLabel(minsToClose), market, ticker: market.ticker,
    K, S, yesAsk, noAsk, minsToClose, volume, modelProb, side, edge, winProb, price, ind, news,
    research, researchBits: [...(research.bits || []).slice(0, 2), ...stratBits.map(b => `Strat ${b}`)],
    moneyness, strategy: strat
  };
}

function activeEdgeBar() { return CRYPTO_EDGE_THRESHOLD; }
function activeConfBar() { return RISK_RULES.minConfidenceToTrade; }
function quantTradeable(a, opts = {}) {
  if (!a || a.error || !a.side) return false;
  const risk = checkRiskLimits();
  if (!risk.ok) return false;

  // Classify the play type by price zone
  const playType = classifyPlayType(a.price, a.side);

  // If it's in a strategy zone, use strategy-specific bars
  let edgeBar, confBar;
  if (playType) {
    edgeBar = playType.minEdge;
    confBar = playType.minWinProb;
  } else {
    edgeBar = opts.edgeBar != null ? opts.edgeBar : CRYPTO_EDGE_THRESHOLD;
    confBar = opts.confBar != null ? opts.confBar : RISK_RULES.minConfidenceToTrade;
  }

  // Memory-driven edge adjustment
  try {
    const d = dep();
    const sideKey = `CRYPTO|${a.side}`;
    if (d.sides[sideKey] && d.sides[sideKey].trades >= 6) {
      const sw = d.sides[sideKey].wins / d.sides[sideKey].trades;
      if (sw >= 0.58) edgeBar = Math.max(0.02, edgeBar - 0.02);
      else if (sw < 0.42) edgeBar = edgeBar + 0.02;
    }
  } catch (_) {}

  if (!(a.edge >= edgeBar)) return false;
  if (!(a.winProb >= confBar)) return false;
  if (MIN_MARKET_VOLUME > 0 && a.volume != null && a.volume < MIN_MARKET_VOLUME) return false;
  if (a.moneyness != null) {
    if (a.side === 'no' && a.moneyness > 2.2) return false;
    if (a.side === 'yes' && a.moneyness < -2.2) return false;
  }
  if (a.strategy && a.strategy.clear) {
    if (a.side === 'yes' && a.strategy.bias < -0.35) return false;
    if (a.side === 'no' && a.strategy.bias > 0.35) return false;
  }
  try {
    const pk = patternKey(a.asset, a.side, buildFeatures(a));
    const pwr = patternWinRate(pk);
    if (pwr != null && pwr < 0.30) return false;
  } catch (_) {}

  // Attach play type for downstream sizing
  a._playType = playType;
  return true;
}

function quantSummary(a) {
  const mktProb = a.side === 'yes' ? a.yesAsk : a.noAsk;
  const name = assetDisplayName(a.asset);
  return `${name} ${a.side.toUpperCase()} @ ${cents(a.price)} (${payoutX(a.price)})\n` +
    `Model ${pct(a.modelProb)} vs market ${cents(mktProb)} · edge ${pp(a.edge)}\n` +
    `σ ${(a.ind.sigmaPerMin * 100).toFixed(3)}%/min · RSI ${a.ind.rsi.toFixed(0)} · mom ${pct(a.ind.momentum, 2)} · ${formatMinsLeft(a.minsToClose)} left` +
    (a.news ? ` · F&G ${a.news.label}` : '');
}

function quantDecisionCard(a, winProb, betAmount, reviewNote, betId, playType, reasoning) {
  const col = assetColor(a.asset);
  const name = assetDisplayName(a.asset);
  const above = a.S != null && a.K != null ? (a.S >= a.K) : null;
  const dec = a.asset === 'DOGE' ? 4 : 2;

  // Play type badge
  const ptLabel = playType ? playType.label : (a._playType ? a._playType.label : null);
  const ptBadge = ptLabel === 'FAVORITE' ? '⭐ FAVORITE' : ptLabel === 'UNDERDOG' ? '🎯 UNDERDOG' : null;

  const thesis = reasoning && reasoning.length ? reasoning : [
    above == null ? null : (above
      ? `Spot ${money(a.S, dec)} is ABOVE strike ${money(a.K, dec)} — YES is the natural side if it holds.`
      : `Spot ${money(a.S, dec)} is BELOW strike ${money(a.K, dec)} — NO is the natural side if it holds.`),
    a.side === 'yes'
      ? `Model ${pct(a.modelProb)} YES vs ask ${cents(a.yesAsk)} — buy the mispriced YES.`
      : `Model ${pct(1 - (a.modelProb || 0))} NO vs ask ${cents(a.noAsk)} — buy the mispriced NO.`,
    isShortSettle(a.minsToClose) ? `Settles in ${formatMinsLeft(a.minsToClose)} — fast cash recycle.` : null
  ];

  const risks = [
    a.ind && a.ind.rsi >= 70 ? 'RSI hot — can snap back.' : null,
    a.ind && a.ind.rsi <= 30 ? 'RSI washed — bounce risk on fades.' : null,
    a.volume != null && a.volume < 80 ? 'Thin book — slippage risk.' : null,
    ptLabel === 'UNDERDOG' ? 'Underdog — higher variance, size reflects that.' : null
  ];
  const extras = [
    a.strategy && a.strategy.clear ? `Strat ${a.strategy.label}: ${(a.strategy.bits || []).slice(0, 2).join(', ')}` : null,
    a.ind && a.ind.smaTrend ? `SMA ${a.ind.smaTrend}${a.ind.smaCross && a.ind.smaCross !== 'none' ? ' · cross ' + a.ind.smaCross : ''}` : null,
    a.ind ? `RSI ${a.ind.rsi.toFixed(0)}${a.ind.bbPercent != null ? ' · %B ' + a.ind.bbPercent.toFixed(2) : ''}` : null,
    a.news ? `F&G ${a.news.label}` : null,
    betId != null ? `ID ${betId}` : null
  ];
  const memoryBits = memoryBriefForCard({
    asset: a.asset, side: a.side, features: buildFeatures(a), category: 'CRYPTO',
    ticker: a.ticker, series: a.series
  });
  return formatDecisionCard({
    title: `${col.emoji} ${name}${a.tf ? ' ' + a.tf : ''}${ptBadge ? ' · ' + ptBadge : ''}`,
    subtitle: `QUANT · edge ${pp(a.edge)} · ${formatMinsLeft(a.minsToClose)}${ptBadge ? ' · ' + ptBadge : ''}`,
    side: a.side, price: a.price, winProb, edge: a.edge, stake: betAmount,
    minsToClose: a.minsToClose,
    marketTitle: (a.market && (a.market.title || a.market.ticker)) || a.ticker,
    ticker: a.ticker, asset: a.asset,
    thesis, risks, ownerNote: reviewNote, category: 'CRYPTO', extras, memoryBits
  });
}

async function handleQuantPlay(a, opts = {}) {
  const phase = opts.phase || quantCyclePhase();
  const risk = checkRiskLimits();
  if (!risk.ok) {
    console.log(`Risk block quant: ${risk.reason}`);
    return false;
  }
  const key = `quant_${a.ticker}_${a.side}`;
  if (withinCooldown(key)) return false;
  if (!windowGate(a.ticker, a.side)) return false;

  const features = buildFeatures(a);
  features.edge = a.edge;
  features.researchScore = a.research ? a.research.score : null;
  const review = ownerReview({
    asset: a.asset, side: a.side, winProb: a.winProb, features,
    category: 'CRYPTO', ticker: a.ticker, series: a.series
  });
  if (!review.ok) { console.log(`Skip ${a.asset}/${a.side}: ${review.note}`); return false; }
  markProposed(key); windowMark(a.ticker, a.side);
  const winProb = review.prob;

  // Strategy-aware sizing: FAVORITE (58-64¢) or UNDERDOG (37-43¢)
  const playType = a._playType || classifyPlayType(a.price, a.side);
  const memStr = memoryStrength(a);
  const betAmount = playType
    ? calculateStrategyStake(playType, winProb, a.edge, memStr)
    : applyRiskToStake(FIXED_BET_USD);

  // Build reasoning
  a.betAmount = betAmount;
  const reasoning = buildTradeReasoning(a, playType, review);

  const meta = {
    features, patternKey: review.patternKey, market: a.market, ticker: a.ticker,
    series: a.series, tf: a.tf, memoryBits: review.memoryBits || [],
    researchBits: a.researchBits || [], phase: phase.name, cycleId: currentCycleId(),
    playType: playType ? playType.type : null, reasoning
  };
  const pendingBase = {
    id: Date.now() + Math.floor(Math.random() * 500),
    type: 'crypto', category: 'CRYPTO', asset: a.asset,
    analysis: { price: a.S },
    play: { side: a.side, winProb, dir: 'quant', move: a.edge * 100, price: a.price },
    side: a.side, betAmount, meta, market: a.market, ticker: a.ticker,
    price: a.price, edge: a.edge, winProb, phase: phase.name, cycleId: currentCycleId(),
    researchBits: a.researchBits || [], timestamp: Date.now()
  };
  recordProposalMemory(pendingBase);
  try {
    resetCycleRuntimeIfNeeded();
    _cycleState.proposed = (_cycleState.proposed || 0) + 1;
    _cycleState.phaseStats.hit = (_cycleState.phaseStats.hit || 0) + 1;
    _cycleState.bestEdges.push({ asset: a.asset, side: a.side, edge: a.edge, winProb, phase: 'hit', ticker: a.ticker });
    _cycleState.bestEdges.sort((x, y) => (y.edge || 0) - (x.edge || 0));
    _cycleState.bestEdges = _cycleState.bestEdges.slice(0, 12);
    if (a.researchBits && a.researchBits.length) {
      _cycleState.researchBits = Array.from(new Set([...(a.researchBits || []), ...(_cycleState.researchBits || [])])).slice(0, 8);
    }
  } catch (_) { /* ignore */ }

  const reviewNote = review.note || 'clean';
  if (shouldAutoExecute(betAmount)) {
    notify(`⚡ AUTO\n${quantDecisionCard(a, winProb, betAmount, reviewNote, null, playType, reasoning)}`);
    await executeTrade(a.asset, { price: a.S }, betAmount, a.side, { winProb, dir: 'quant' }, meta);
    markPlayTaken(pendingBase);
  } else {
    botState.pendingBets.push(pendingBase);
    saveState();
    notify(quantDecisionCard(a, winProb, betAmount, reviewNote, pendingBase.id, playType, reasoning), proposalKeyboard(pendingBase.id));
  }
  return true;
}

async function checkAndScan() {
  const prices = await getAllSpotPrices();
  if (!prices) return;
  for (const asset of Object.keys(THRESHOLDS)) {
    const price = prices[asset];
    if (!price) continue;
    recordPrice(asset, price);
    const analysis = analyzeAsset(asset, price);
    if (!analysis) continue;
    const play = bestCryptoPlay(analysis);
    if (play) await handleCryptoPlay(asset, analysis, play);
  }
  saveState();
}

async function checkWeatherOnce() {
  try {
    const opps = await scanWeatherEdge();
    console.log(`Weather scan: ${opps.length} opportunity(ies)`);
    for (const opp of opps) {
      try { await handleWeatherOpportunity(opp); }
      catch (e) { console.error(`Weather handle ${opp.cityCode}:`, e.message); }
    }
  } catch (e) { console.error('Weather scan error:', e.message); }
}

async function checkCommoditiesOnce() {
  try { for (const opp of await scanCommodityEdge()) await handleCommodityOpportunity(opp); }
  catch (e) { console.error('Commodity scan error:', e.message); }
}

// ============================================
// AUTONOMOUS FINAL-MINUTES ENGINE — THE ONLY AUTO FUNCTION
// Scans ALL crypto markets across ALL cycle lengths (15m/30m/1h/daily/weekly).
// Enters in the final 5 minutes when BTC has moved $0-$100 during the cycle.
// Buys contracts priced $0.80-$0.99 that resolve at $1.00.
// Always operates WITH the trend. Backed by research + memory.
// Also manages exits: auto-lock profit, stop-loss.
// ============================================
let _engineLock = false;
let _engineLastRun = 0;
let _engineLastReason = 'init';
async function runFinalMinutesAllCryptos() {
  _engineLastRun = Date.now();
  if (_engineLock) { _engineLastReason = 'lock-held'; return false; }
  _engineLock = true;

  const AC = botState.AUTO_HIT_CYCLE;
  if (!AC.enabled || !botState.isRunning) { _engineLock = false; _engineLastReason = `disabled:${AC.enabled}/running:${botState.isRunning}`; return false; }

  const now = Date.now();
  botState.scanCount = (botState.scanCount || 0) + 1;
  if (botState.health) botState.health.lastScan = now;

  const today = new Date(now).toDateString();
  if (AC.dailyLossDate !== today) {
    AC.dailyLoss = 0;
    AC.dailyLossDate = today;
    AC.consecutiveLosses = 0;
  }

  try {
    const risk = checkRiskLimits();
    if (!risk.ok) { _engineLastReason = `risk:${risk.reason}`; return false; }
    if (AC.dailyLoss >= AC.dailyMaxLoss) { _engineLastReason = `dailyLoss:${AC.dailyLoss}>=${AC.dailyMaxLoss}`; return false; }
    if (AC.consecutiveLosses >= AC.maxConsecutiveLosses) {
      AC.enabled = false;
      notify(`🛑 AUTO STOP — ${AC.consecutiveLosses} consecutive losses. Use /go_auto_hit_on to re-enable.`, { public: true });
      _engineLastReason = `consecLoss:${AC.consecutiveLosses}`;
      return false;
    }

    const prices = await getAllSpotPrices();
    if (prices) {
      for (const [asset, price] of Object.entries(prices)) {
        if (price) recordPrice(asset, price);
      }
    }
    saveState();

    const btcSpot = botState.prices['BTC'];
    if (!btcSpot) { _engineLastReason = 'no-btc-spot'; return false; }

    await manageFinalMinutesExits();
    saveState();

    const bulkMarkets = await fetchAllOpenCryptoMarkets();
    if (!bulkMarkets.markets.length) { _engineLastReason = 'no-markets-fetch'; saveState(); return false; }

    // --- SCORE every market and rank by confidence ---
    const candidates = [];
    let seriesChecked = 0;
    const allSpecs = cryptoMarketSpecs();

    for (const spec of allSpecs) {
      const { asset, series } = spec;

      // Cooldown
      const fireKey = `FM_${series}`;
      const cooldownMs = getCycleLengthMs(series) * 0.5;
      if (AC.lastFire && AC.lastFire[fireKey] && now - AC.lastFire[fireKey] < cooldownMs) continue;

      // Find market from bulk cache
      const seriesMarkets = bulkMarkets.bySeries[series] || [];
      const market = seriesMarkets.length ? seriesMarkets[0] : null;
      if (!market) continue;
      seriesChecked++;

      // Time window — FINAL 5 MINUTES
      const closeTime = new Date(market.close_time).getTime();
      const msUntilClose = closeTime - now;
      if (msUntilClose > 600000 || msUntilClose < 15000) continue;

      // Market prices
      const yesAsk = parseFloat(market.yes_ask_dollars);
      const noAsk = parseFloat(market.no_ask_dollars);
      const K = market.floor_strike ?? market.cap_strike ?? null;
      if (isNaN(yesAsk) || isNaN(noAsk) || K == null) continue;

      // Volume minimum
      const volume = getMarketVolume(market);
      if (volume < 5) continue;

      // --- VOLATILITY from price history ---
      const hist = botState.priceHistory[asset] || [];
      if (hist.length < 3) continue; // need at least 3 points for vol
      const histPrices = hist.map(p => p.price).filter(p => p > 0);
      if (histPrices.length < 3) continue;
      const histRets = [];
      for (let i = 1; i < histPrices.length; i++) histRets.push(Math.log(histPrices[i] / histPrices[i - 1]));
      const sigmaPerBar = stddev(histRets) || 0.0005;
      const barInterval = 30; // price history recorded every ~30s
      const sigmaPerMin = sigmaPerBar / Math.sqrt(barInterval / 60);

      // --- MOMENTUM / DRIFT ---
      const cycleMs = getCycleLengthMs(series);
      const cycleStartMs = closeTime - cycleMs;
      let startPrice = null, midPrice = null, endPrice = null;
      for (const pt of hist) {
        if (pt.time >= cycleStartMs - 30000 && !startPrice) startPrice = pt.price;
        if (pt.time >= cycleStartMs + cycleMs * 0.5 && !midPrice) midPrice = pt.price;
        if (pt.time <= now) endPrice = pt.price;
      }
      if (!startPrice || !endPrice) continue;
      const momentum = (endPrice - startPrice) / startPrice;
      const muRaw = momentum / Math.max(1, (msUntilClose / 60000));
      const muPerMin = Math.max(-sigmaPerMin * 2, Math.min(sigmaPerMin * 2, muRaw));

      // --- BTC correlation ---
      const btcUp = btcIsUp(cycleStartMs, now);
      const assetMovingUp = momentum > 0;
      const alignedWithBTC = (btcUp === assetMovingUp) || btcUp === null;

      // Determine side
      const isUp = assetMovingUp || (btcUp && momentum === 0);
      const side = isUp ? 'yes' : 'no';
      const buyPrice = isUp ? yesAsk : noAsk;
      const oppositePrice = isUp ? noAsk : yesAsk;

      // --- MONTE CARLO: simulate N paths, count fraction that finish above strike ---
      const S0 = endPrice;
      const minsLeft = Math.max(0.5, msUntilClose / 60000);
      const mcProbYes = monteCarloPrice(S0, K, minsLeft, sigmaPerMin, muPerMin, 3000);
      if (mcProbYes == null) continue;
      const mcProb = side === 'yes' ? mcProbYes : (1 - mcProbYes);
      const edge = mcProb - buyPrice;
      const fee = kalshiFee(buyPrice, 1);
      const netEdge = edge - fee; // edge after fees

      // --- FILTERS ---
      if (oppositePrice < 0.02) continue;
      if (oppositePrice > 0.30) continue;
      if (buyPrice < 0.55) continue; // minimum viable probability
      if (edge <= 0) continue; // no negative edge trades

      // Log MC diagnostics periodically
      if (fired === 0 && candidates.length === 0) {
        console.log(`📊 MC ${asset}: S0=${S0} K=${K} σ=${sigmaPerMin.toFixed(5)}/min drift=${muPerMin.toFixed(6)} ${minsLeft.toFixed(1)}min left | P(yes)=${(mcProbYes*100).toFixed(1)}% side=${side} buy=${buyPrice} edge=${pp(edge)} net=${pp(netEdge)}`);
      }

      candidates.push({
        asset, series, market, side, buyPrice, oppositePrice,
        confidence: mcProb, edge, netEdge, fee, momentum, sigmaPerMin,
        muPerMin, mcProbYes, alignedWithBTC, closeTime, msUntilClose,
        cycleMs, K, volume, fireKey, cycleStartMs
      });
    }

    // --- SORT by net edge (real edge after fees) ---
    candidates.sort((a, b) => b.netEdge - a.netEdge);
    if (candidates.length === 0 && seriesChecked > 0) {
      console.log(`📭 No MC candidates this cycle (checked ${seriesChecked} markets)`);
    } else if (candidates.length > 0) {
      console.log(`🎯 MC found ${candidates.length} candidates — best: ${candidates[0].asset} ${candidates[0].side} netEdge=${pp(candidates[0].netEdge)} MC=${Math.round(candidates[0].confidence*100)}%`);
    }

    // --- FIRE the best plays ---
    let fired = 0;
    let cycleSpend = 0;
    const bankroll = BANKROLL;
    const maxCycleSpend = bankroll * 0.45;
    const maxFires = Math.min(AC.maxPlaysPerCycle || 5, 5);

    for (const c of candidates) {
      if (fired >= maxFires) break;

      const { asset, series, market, side, buyPrice, oppositePrice,
              confidence, edge, netEdge, fee, momentum, sigmaPerMin,
              muPerMin, mcProbYes, alignedWithBTC, closeTime, msUntilClose, cycleMs, fireKey, cycleStartMs } = c;

      // --- EDGE-BASED BET SIZING ---
      let betAmount;
      if (netEdge >= 0.10) {
        betAmount = Math.min(bankroll * 0.40, 1.00);
      } else if (netEdge >= 0.06) {
        betAmount = Math.min(bankroll * 0.25, 0.65);
      } else if (netEdge >= 0.04) {
        betAmount = Math.min(bankroll * 0.15, 0.40);
      } else {
        betAmount = Math.min(bankroll * 0.10, 0.25);
      }
      betAmount = Math.max(0.10, Math.round(betAmount * 100) / 100);
      betAmount = Math.min(betAmount, bankroll * 0.45);
      if (cycleSpend + betAmount > maxCycleSpend) continue;

      // Research
      let research = { score: 0, bits: [] };
      try {
        if (!runFinalMinutesAllCryptos._rCache) runFinalMinutesAllCryptos._rCache = {};
        const cached = runFinalMinutesAllCryptos._rCache[asset];
        if (cached && now - cached.at < 8 * 60 * 1000) research = cached.val;
        else {
          research = await getFullResearchBundle(asset);
          runFinalMinutesAllCryptos._rCache[asset] = { at: now, val: research };
        }
      } catch (_) {}

      // Memory veto
      const features = {
        rsi: null, momentum: momentum * 100, sigmaPerMin: null,
        minsToClose: msUntilClose / 60000, edge: buyPrice - 0.5, fng: research?.fng?.score
      };
      const memBits = memoryBriefForCard({ asset, side, features, category: 'CRYPTO', ticker: market.ticker, series });
      const review = ownerReview({
        asset, side, winProb: buyPrice, features,
        category: 'CRYPTO', ticker: market.ticker, series
      });
      if (!review.ok) continue;

      // --- EXECUTE ---
      const meta = {
        autoHit: true, category: 'CRYPTO', asset, strategy: 'final-minutes',
        market, series, confidence: Math.round(confidence * 100) + '%',
        momentum: (momentum * 100).toFixed(3) + '%',
        research: research.bits,
        memory: memBits.filter(b => !b.startsWith('Memory:')),
        cycleLength: formatCycleLength(series),
        minsLeft: Math.round(msUntilClose / 60000)
      };

      try {
        const result = await executeTrade(asset, { price: buyPrice }, betAmount, side, { winProb: confidence, dir: 'final-minutes' }, meta);
        if (result) {
          if (!AC.lastFire) AC.lastFire = {};
          AC.lastFire[fireKey] = now;

          const cycleLabel = formatCycleLength(series);
          const movePct = (momentum * 100).toFixed(3);
          const btcStr = alignedWithBTC ? '✅ BTC aligned' : '⚠️ BTC divergent';

          notify(
            `⚡ ${cycleLabel} ${asset} ${side.toUpperCase()} @ ${cents(buyPrice)}\n` +
            `MC prob: ${Math.round(confidence * 100)}% · edge ${pp(netEdge)} · σ ${sigmaPerMin.toFixed(5)}/min\n` +
            `${btcStr} · $${betAmount.toFixed(2)} bet\n` +
            `${Math.round(msUntilClose / 60000)}min left · resolves $1`,
            { public: true }
          );
          console.log(`🎯 ${cycleLabel} ${asset}: ${side} @ ${cents(buyPrice)} MC ${Math.round(confidence * 100)}% edge ${pp(edge)} fee $${fee.toFixed(2)} net ${pp(netEdge)} $${betAmount.toFixed(2)} ${Math.round(msUntilClose/1000)}s left`);
          fired++;
          cycleSpend += betAmount;
        }
      } catch (e) { console.error(`FINAL ${asset}/${series}:`, e.message); }

      await sleep(200);
    }

    if (fired > 0) {
      AC.totalFired = (AC.totalFired || 0) + fired;
      AC.lastFired = now;
    }

    return fired > 0;
  } finally {
    saveState();
    _engineLock = false;
  }
}

// --- HELPERS for the autonomous engine ---

// Detect cycle length in ms from series ticker
function getCycleLengthMs(series) {
  const s = String(series || '');
  if (is15mSeries(s))  return 15 * 60 * 1000;
  if (is30mSeries(s))  return 30 * 60 * 1000;
  if (isHourlySeries(s)) return 60 * 60 * 1000;
  // Check for daily (D, D26, etc.)
  if (/D\b|DAY|DAILY/i.test(s) && !/15M|30M|H\b/i.test(s)) return 24 * 60 * 60 * 1000;
  // Check for weekly (MINY, MAXY)
  if (/MINY|MAXY|WEEK/i.test(s)) return 7 * 24 * 60 * 60 * 1000;
  // FLIP, EU, ATHEX = special events, treat as 15m
  return 15 * 60 * 1000;
}

function formatCycleLength(series) {
  const ms = getCycleLengthMs(series);
  if (ms <= 15 * 60000) return '15m';
  if (ms <= 30 * 60000) return '30m';
  if (ms <= 60 * 60000) return '1h';
  if (ms <= 24 * 60 * 60 * 1000) return '1d';
  return '1w';
}

// Check if BTC is trending up during a time window
function btcIsUp(windowStart, windowEnd) {
  const btcHist = botState.priceHistory['BTC'] || [];
  let startPrice = null, endPrice = null;
  for (const pt of btcHist) {
    if (pt.time >= windowStart - 30000 && !startPrice) startPrice = pt.price;
    if (pt.time <= windowEnd + 5000) endPrice = pt.price;
  }
  if (!startPrice || !endPrice) return null;
  return endPrice > startPrice;
}

// Get directional signal: use asset's own price move, fallback to BTC
function getDirectionalSignal(asset, cycleStart, cycleEnd, btcSpot, btcDirection) {
  // Try asset's own price history
  const hist = botState.priceHistory[asset] || [];
  let startPrice = null, endPrice = null;
  for (const pt of hist) {
    if (pt.time >= cycleStart - 30000 && !startPrice) startPrice = pt.price;
    if (pt.time <= cycleEnd + 5000) endPrice = pt.price;
  }
  if (startPrice && endPrice) return endPrice > startPrice;
  // Fallback: use BTC direction (BTC leads all crypto)
  return btcDirection != null ? btcDirection : true;
}

// Get human-readable move info
function getMoveInfo(asset, cycleStart, now) {
  const hist = botState.priceHistory[asset] || [];
  let startPrice = null;
  for (const pt of hist) {
    if (pt.time >= cycleStart - 30000) { startPrice = pt.price; break; }
  }
  const current = botState.prices[asset];
  if (!startPrice || !current) return 'BTC led';
  const move = current - startPrice;
  const pctMove = ((move / startPrice) * 100).toFixed(2);
  return `${move >= 0 ? '↑' : '↓'} $${Math.abs(move).toFixed(2)} (${pctMove}%)`;
}

// Auto-manage exits for open positions
async function manageFinalMinutesExits() {
  const openBets = botState.openBets || [];
  if (!openBets.length) return;

  for (const bet of [...openBets]) {
    try {
      if (!bet.ticker || bet.status !== 'open') continue;
      // Find the market to check current price
      const data = await kalshiRequest('GET', `/markets/${bet.ticker}`);
      if (!data || !data.market) continue;
      const mkt = data.market;

      const currentPrice = bet.side === 'yes'
        ? parseFloat(mkt.yes_ask_dollars)
        : parseFloat(mkt.no_ask_dollars);
      if (isNaN(currentPrice)) continue;

      const costBasis = bet.entryPrice || 0.50;
      const profitPerContract = currentPrice - costBasis;
      const ageMinutes = (Date.now() - bet.timestamp) / 60000;

      // AUTO-LOCK: if position is up $0.01+ per contract in first 2 minutes
      if (profitPerContract >= 0.01 && ageMinutes <= 2) {
        const hedgeSide = bet.side === 'yes' ? 'no' : 'yes';
        const hedgePrice = bet.side === 'yes' ? parseFloat(mkt.no_ask_dollars) : parseFloat(mkt.yes_ask_dollars);
        if (!isNaN(hedgePrice) && hedgePrice > 0 && hedgePrice < 0.20) {
          const contracts = bet.contractCount || Math.max(1, Math.floor(bet.amount / costBasis));
          const hedgeCost = contracts * hedgePrice;
          const entryFee = bet.entryFee || 0;
          const hedgeFee = kalshiFee(hedgePrice, contracts);
          const guaranteedProfit = contracts * (1 - costBasis - hedgePrice) - entryFee - hedgeFee;
          if (guaranteedProfit > 0.005 && hedgeCost < bet.amount * 1.2) {
            try {
              const lockResult = await placeKalshiOrderOnMarket(mkt, hedgeSide, hedgeCost);
              if (lockResult && lockResult.success) {
                botState.stats.totalProfit = (botState.stats.totalProfit || 0) + guaranteedProfit;
                bet.status = 'locked';
                saveState();
                console.log(`🔒 AUTO-LOCK ${bet.asset} ${bet.ticker}: +$${guaranteedProfit.toFixed(3)} guaranteed`);
              } else {
                console.log(`⚠️ AUTO-LOCK order failed ${bet.asset} ${bet.ticker}`);
              }
            } catch (_) {}
          }
        }
      }

      // STOP-LOSS: if position is down > 40% and past halfway through cycle
      const closeTime = new Date(mkt.close_time).getTime();
      const msUntilClose = closeTime - Date.now();
      const cycleMs = getCycleLengthMs(bet.series || '');
      const halfwayMs = cycleMs * 0.5;
      if (profitPerContract < -0.15 && (cycleMs - msUntilClose) > halfwayMs) {
        // Cut loss — sell at whatever bid is available
        const hedgeSide = bet.side === 'yes' ? 'no' : 'yes';
        const hedgePrice = bet.side === 'yes' ? parseFloat(mkt.no_ask_dollars) : parseFloat(mkt.yes_ask_dollars);
        if (!isNaN(hedgePrice) && hedgePrice > 0 && hedgePrice < 0.60) {
          const contracts = bet.contractCount || Math.max(1, Math.floor(bet.amount / costBasis));
          const hedgeCost = contracts * hedgePrice;
          try {
            const orderResult = await placeKalshiOrderOnMarket(mkt, hedgeSide, hedgeCost);
            if (orderResult && orderResult.success) {
              bet.status = 'stopped';
              botState.AUTO_HIT_CYCLE.consecutiveLosses = (botState.AUTO_HIT_CYCLE.consecutiveLosses || 0) + 1;
              botState.AUTO_HIT_CYCLE.dailyLoss = (botState.AUTO_HIT_CYCLE.dailyLoss || 0) + (bet.amount || FIXED_BET_USD);
              saveState();
              console.log(`🛑 STOP-LOSS ${bet.asset} ${bet.ticker}: sold hedge @ ${cents(hedgePrice)}`);
            } else {
              console.log(`⚠️ STOP-LOSS order failed ${bet.asset} ${bet.ticker}`);
            }
          } catch (e) { console.error(`STOP-LOSS ${bet.ticker}:`, e.message); }
        }
      }

    } catch (e) { console.error(`Exit manage ${bet.ticker}:`, e.message); }
    await sleep(200);
  }
}

// ============================================
// AUTO HIT CYCLE — fully autonomous, adaptive, max throughput
// Scans ALL markets, adaptive thresholds, max throughput
// ============================================
async function runAutoHitCycle() {
  const AC = botState.AUTO_HIT_CYCLE;
  if (!AC.enabled || !botState.isRunning) return;
  const now = Date.now();
  const today = new Date(now).toDateString();
  if (AC.dailyLossDate !== today) {
    AC.dailyLoss = 0;
    AC.dailyLossDate = today;
  }
  // Track attempts
  AC.attemptCount = (AC.attemptCount || 0) + 1;
  AC.lastAttempt = now;
  saveState(); // persist attempt counter
  // Global risk gate
  const risk = checkRiskLimits();
  if (!risk.ok) { console.log(`Auto-hit risk block: ${risk.reason}`); return; }
  if (AC.dailyLoss >= AC.dailyMaxLoss) {
    console.log(`Auto-hit: daily loss cap hit ($${AC.dailyLoss.toFixed(2)})`);
    return;
  }
  // Stop loss: halt auto-hit after max consecutive losses
  if (AC.consecutiveLosses >= AC.maxConsecutiveLosses) {
    console.log(`Auto-hit: STOP LOSS triggered — ${AC.consecutiveLosses} consecutive losses. Use /auto_hit_on to re-enable.`);
    AC.enabled = false;
    notify(`🛑 AUTO-HIT STOP LOSS — ${AC.consecutiveLosses} losses in a row. Disabled. Use /go_auto_hit_on to re-enable.`, { public: true });
    return;
  }

  // Adaptive thresholds based on recent performance
  const adaptive = AC.adaptiveThresholds || { enabled: true, minEdgeRange: [0.01, 0.10], minWinProbRange: [0.45, 0.65], maxPlaysRange: [1, 20] };
  const recentWins = AC.consecutiveLosses === 0 ? 1 : 0;
  const performance = recentWins > 0 ? 1.0 : 0.5; // reduce thresholds after losses

  // Adaptive thresholds based on recent performance
  const minEdge = adaptive.enabled ? adaptive.minEdgeRange[0] + (adaptive.minEdgeRange[1] - adaptive.minEdgeRange[0]) * performance : 0.02;
  const minWinProb = adaptive.enabled ? adaptive.minWinProbRange[0] + (adaptive.minWinProbRange[1] - adaptive.minWinProbRange[0]) * performance : 0.50;
  const maxPlays = Math.floor(adaptive.enabled ? adaptive.maxPlaysRange[0] + (adaptive.maxPlaysRange[1] - adaptive.maxPlaysRange[0]) * performance : 20);

  // Track attempt
  AC.attemptCount = (AC.attemptCount || 0) + 1;
  AC.lastAttempt = Date.now();

  // Scan ALL crypto + commodity markets (not just 15m)
  const cryptoSpecs = cryptoMarketSpecs(); // all series
  const commoditySpecs = Object.values(COMMODITIES).map(c => ({ asset: c.name, series: c.kalshiSeriesTicker, type: 'commodity' }));
  const allSpecs = [
    ...cryptoSpecs.map(s => ({ ...s, type: 'crypto' })),
    ...commoditySpecs
  ];

  const results = [];
  for (const spec of allSpecs) {
    try {
      let a;
      if (spec.type === 'crypto') {
        a = await analyzeCryptoMarket(spec.asset, spec.series);
      } else {
        const opps = await scanCommodityEdgeForCode(spec.asset);
        if (opps.length) a = opps[0];
      }
      if (a && !a.error) {
        a._category = spec.type === 'crypto' ? 'CRYPTO' : 'COMMODITY';
        a._asset = spec.asset;
        results.push(a);
      }
    } catch (e) { console.error(`Auto-hit scan ${spec.asset}/${spec.series}:`, e.message); }
    await sleep(50); // faster scanning
  }

  // Filter by auto-hit rules - allow all categories, no 15M restriction
  const tradeable = results
    .filter(a => AC.allowedCategories.includes(a._category))
    .filter(a => a.edge >= minEdge)
    .filter(a => a.winProb >= minWinProb)
    .filter(a => {
      // Memory backing check — optional now (minMemoryBits can be 0)
      const mem = memoryBriefForCard({
        asset: a.asset, side: a.side, features: buildFeatures(a),
        category: a._category, ticker: a.ticker, series: a.series
      });
      return mem.filter(b => !b.startsWith('Memory:')).length >= (AC.minMemoryBits || 0);
    })
    .filter(a => {
      // Cooldown per market - short cooldown for high frequency
      const key = `${a.ticker}_${a.side}`;
      const last = AC.lastFire[key] || 0;
      return now - last >= (AC.cooldownSec || 30) * 1000;
    })
    .sort((a, b) => (b.edge * b.winProb) - (a.edge * a.winProb));

  // Execute top N
  let fired = 0;
  for (const a of tradeable.slice(0, maxPlays)) {
    const risk = checkRiskLimits();
    if (!risk.ok) break;
    const key = `${a.ticker}_${a.side}`;
    AC.lastFire[key] = now;
    const winProb = a.winProb;
    const betAmount = applyRiskToStake(FIXED_BET_USD);
    const meta = { autoHit: true, category: a._category, asset: a.asset };
    try {
      await executeTrade(a.asset, { price: a.S }, betAmount, a.side, { winProb, dir: 'auto-hit' }, meta);
      notify(`⚡ AUTO-HIT ${a.asset} ${a.side.toUpperCase()} @ ${cents(a.price)} (${pct(a.winProb)}) edge ${pp(a.edge)} · $${betAmount.toFixed(2)}`, { public: true });
      fired++;
    } catch (e) { console.error(`Auto-hit fire ${a.asset}/${a.side}:`, e.message); }
  }
  if (fired) {
    console.log(`Auto-hit cycle: fired ${fired} play(s)`);
    AC.totalFired = (AC.totalFired || 0) + fired;
    AC.lastFired = Date.now();
    saveState(); // persist counters
  }
}

function isAutoHitWindow() {
  const mins = new Date().getMinutes();
  return mins % 15 === 0; // fire at :00, :15, :30, :45
}

// ============================================
// QUANT ENGINE SCHEDULER — SIMPLE 15m CYCLE
// On each :00/:15/:30/:45:
//   1) Load research + prior cycle memory
//   2) Score live markets
//   3) Fire the best plays you think will HIT
//   4) Deposit the cycle (even if you skip)
//   5) Repeat next window
// Mid-window: light refresh only (no spam).
// ============================================
function msToNext15(ts = Date.now()) {
  const d = new Date(ts);
  const mins = d.getMinutes();
  const nextQuarter = Math.floor(mins / 15) * 15 + 15;
  const next = new Date(d);
  next.setSeconds(0, 0);
  if (nextQuarter >= 60) { next.setHours(d.getHours() + 1); next.setMinutes(0); }
  else next.setMinutes(nextQuarter);
  return Math.max(1000, next.getTime() - ts);
}

async function runQuantScan({ verbose = false } = {}) {
  if (!botState.isRunning) return;
  resetCycleRuntimeIfNeeded();
  const phase = quantCyclePhase();
  _cycleState.scanCount = (_cycleState.scanCount || 0) + 1;
  const isWindowOpen = (_cycleState.scanCount === 1) || phase.minIntoWindow < 2.5;

  // Quiet banner once per window
  if (_cycleState.phaseNotified !== phase.name + _cycleState.cycleId) {
    _cycleState.phaseNotified = phase.name + _cycleState.cycleId;
    const hints = cycleMemoryHints();
    const memLine = (hints.notes || []).slice(0, 2).join(' · ');
    notify(
      `⏱ ${currentCycleId()}  ·  15m HIT CYCLE\n` +
      `Bar ${pp(CRYPTO_EDGE_THRESHOLD)} · conf ${pct(RISK_RULES.minConfidenceToTrade)} · max ${QUANT_FIRE_MAX} plays\n` +
      (memLine ? `Memory: ${memLine}` : 'Memory: building…')
    );
  }

  const prices = await getAllSpotPrices();
  if (prices) for (const asset of Object.keys(CRYPTO_SERIES)) if (prices[asset]) recordPrice(asset, prices[asset]);
  saveState();

  const results = [];
  const specs = cryptoMarketSpecsPrefer15m();
  // Prefer only 15m series first to cut API load; include others if few specs
  const primary = specs.filter(s => is15mSeries(s.series));
  const list = primary.length ? primary : specs;
  for (const spec of list) {
    try { const a = await analyzeCryptoMarket(spec.asset, spec.series); if (a) results.push(a); }
    catch (e) { console.error(`Quant ${spec.asset}/${spec.series}:`, e.message); }
    await sleep(250);
  }

  // Rank with memory boost from prior cycles
  const hints = cycleMemoryHints();
  const tradeable = results
    .filter(a => quantTradeable(a, { phase }))
    .map(a => {
      let score = (a.edge || 0) + settleBoost(a.minsToClose);
      // Align with moneyness (natural side)
      if (a.S != null && a.K != null) {
        if (a.side === 'yes' && a.S >= a.K) score += 0.015;
        if (a.side === 'no' && a.S < a.K) score += 0.015;
      }
      // Prior side performance
      const sk = `CRYPTO|${a.side}`;
      if (hints.boost[sk]) score += 0.02;
      if (hints.fade[sk]) score -= 0.02;
      try {
        const pwr = patternWinRate(patternKey(a.asset, a.side, buildFeatures(a)));
        if (pwr != null) score += (pwr - 0.5) * 0.06;
      } catch (_) { /* ignore */ }
      // Clear strategy alignment boost (trend / mean-reversion)
      if (a.strategy && a.strategy.clear) {
        if (a.side === 'yes' && a.strategy.bias > 0) score += 0.025 * a.strategy.bias;
        if (a.side === 'no' && a.strategy.bias < 0) score += 0.025 * (-a.strategy.bias);
      }
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);

  for (const row of tradeable.slice(0, 5)) {
    _cycleState.bestEdges.push({
      asset: row.a.asset, side: row.a.side, edge: row.a.edge,
      winProb: row.a.winProb, phase: 'hit', ticker: row.a.ticker, tradeable: true
    });
  }
  _cycleState.bestEdges = _cycleState.bestEdges.slice(0, 10);

  let fired = 0;
  for (const row of tradeable) {
    if (windowLeft() <= 0) break;
    if (fired >= QUANT_FIRE_MAX) break;
    const a = row.a;
    const key = `${a.ticker}_${a.side}`;
    if (firedQuant.has(key)) continue;
    firedQuant.add(key);
    const ok = await handleQuantPlay(a, { phase });
    if (ok) fired++;
  }

  // Deposit at end of first scan and on window close path
  if (isWindowOpen || fired > 0) {
    try { finalizeCycleDeposit(isWindowOpen && phase.minIntoWindow < 2 ? 'snapshot' : 'snapshot'); } catch (_) {}
  }

  if (verbose || (fired === 0 && isWindowOpen)) {
    const okRows = results.filter(r => r && !r.error && r.side)
      .sort((a, b) => (b.edge || 0) - (a.edge || 0)).slice(0, 3);
    const near = okRows.map(a =>
      `${assetColor(a.asset).emoji} ${a.asset} ${String(a.side).toUpperCase()} ${pp(a.edge)} win ${pct(a.winProb)}`
    ).join('\n');
    const errs = results.filter(r => r.error).length;
    if (fired === 0) {
      notify(
        `⏱ ${currentCycleId()} — no hit yet\n` +
        `Scanned ${results.length} · clear bar: ${tradeable.length}\n` +
        (near ? `Closest:\n${near}\n` : '') +
        (errs ? `Data gaps: ${errs}\n` : '') +
        `Next window in ${Math.round(msToNext15() / 1000)}s`
      );
    } else if (verbose) {
      notify(`⏱ ${currentCycleId()} — sent ${fired} hit play(s)`);
    }
  }
}

function startQuantEngine() {
  // Boundary-aligned 15m cycle is the primary driver
  scheduleBoundarySummary();
  // Light mid-window refresh (not spammy)
  setInterval(() => {
    runQuantScan({ verbose: false }).catch(e => console.error('Quant scan:', e.message));
  }, Math.max(2, QUANT_SCAN_MIN) * 60 * 1000);
  // Continuous auto-hit firing — runs every 30s for max throughput
  setInterval(() => {
    if (AUTO_HIT_CYCLE.enabled && botState.isRunning) {
      runFinalMinutesAllCryptos().catch(e => console.error('FinalMinutes:', e.message));
    }
  }, 30000); // every 30 seconds
}
function scheduleBoundarySummary() {
  setTimeout(async () => {
    try {
      // Seal previous window
      try {
        const prev = finalizeCycleDeposit('window-end');
        if (prev && (prev.proposed || 0) + (prev.taken || 0) > 0) {
          notify(`📦 ${prev.id} done · sent ${prev.proposed} · taken ${prev.taken}`);
        }
      } catch (_) { /* ignore */ }
      resetCycleRuntimeIfNeeded();
      if (botState.isRunning) {
        await runQuantScan({ verbose: true });
        await runFinalMinutesAllCryptos(); // auto-fire final-minutes plays at boundary
      }
    } catch (e) { console.error('15m boundary:', e.message); }
    scheduleBoundarySummary();
  }, msToNext15() + 800);
}
// Hourly schedule kept as no-op alias for compatibility
function scheduleHourlyCycle() { /* 15m cycle handles deposits */ }

// ============================================
// MEMORY, KNOWLEDGE DEPOSITORY & OWNER REVIEW
// Persistent brain: outcomes, patterns, markets, series, hours, lessons, user notes.
// Written to kalshi_state.json + kalshi_memory.json and consulted on every play.
// ============================================
function bucket(x, edges) { for (let i = 0; i < edges.length; i++) if (x < edges[i]) return i; return edges.length; }
function baseAsset(asset) { const s = String(asset || ''); return s.includes(':') ? s.split(':')[0] : s; }

function memAsset(asset) {
  if (!botState.memory.assets[asset]) {
    botState.memory.assets[asset] = {
      trades: 0, wins: 0, losses: 0, netProfit: 0,
      probSum: 0, hitSum: 0,          // calibration: avg predicted vs avg realized
      lastResult: null, lastTradedAt: null, streak: 0
    };
  }
  return botState.memory.assets[asset];
}

function dep() {
  ensureMemoryShape();
  return botState.memory.depository;
}
function localHour(ts = Date.now()) {
  try { return new Date(ts).getHours(); } catch (_) { return 0; }
}
function bumpBucket(map, key, won, profit) {
  if (!key) return;
  if (!map[key]) map[key] = { trades: 0, wins: 0, losses: 0, netProfit: 0 };
  map[key].trades++;
  if (won) map[key].wins++; else map[key].losses++;
  map[key].netProfit += profit || 0;
}
function bucketStats(b) {
  if (!b || !b.trades) return null;
  return { n: b.trades, wins: b.wins || 0, winRate: (b.wins || 0) / b.trades, net: b.netProfit || 0 };
}
function addLesson(text, tags = []) {
  const d = dep();
  const lesson = { t: Date.now(), text: String(text).slice(0, 280), tags: tags.slice(0, 6) };
  d.lessons.unshift(lesson);
  if (d.lessons.length > MEMORY_LESSON_MAX) d.lessons.length = MEMORY_LESSON_MAX;
  botState.memory.insights = botState.memory.insights || [];
  botState.memory.insights.unshift({ t: lesson.t, text: lesson.text });
  if (botState.memory.insights.length > MEMORY_LESSON_MAX) botState.memory.insights.length = MEMORY_LESSON_MAX;
  botState.memory.updatedAt = Date.now();
}
function rememberNote(text, tags = []) {
  const d = dep();
  const note = { t: Date.now(), text: String(text).slice(0, 400), tags: tags.slice(0, 8) };
  d.notes.unshift(note);
  if (d.notes.length > MEMORY_NOTE_MAX) d.notes.length = MEMORY_NOTE_MAX;
  botState.memory.updatedAt = Date.now();
  saveState();
  return note;
}
function recordProposalMemory(pendingOrMeta = {}) {
  try {
    const d = dep();
    d.stats.proposals = (d.stats.proposals || 0) + 1;
    d.stats.playsLogged = (d.stats.playsLogged || 0) + 1;
    const p = pendingOrMeta || {};
    const row = {
      t: Date.now(),
      id: p.id || null,
      type: p.type || p.kind || null,
      category: p.category || catOf(p.asset) || null,
      asset: p.asset || null,
      side: p.side || (p.play && p.play.side) || null,
      ticker: p.ticker || (p.market && p.market.ticker) || null,
      series: (p.meta && p.meta.series) || p.series || null,
      price: p.price != null ? p.price : (p.play && p.play.price != null ? p.play.price : null),
      edge: (p.meta && p.meta.features && p.meta.features.edge != null)
        ? p.meta.features.edge
        : (p.edge != null ? p.edge : (p.play && p.play.move != null ? p.play.move / 100 : null)),
      winProb: p.winProb != null ? p.winProb : (p.play ? p.play.winProb : null),
      stake: p.betAmount != null ? p.betAmount : p.stake || null,
      phase: p.phase || (typeof quantCyclePhase === 'function' ? quantCyclePhase().name : null),
      cycleId: p.cycleId || (typeof currentCycleId === 'function' ? currentCycleId() : null),
      patternKey: (p.meta && p.meta.patternKey) || p.patternKey || null,
      research: p.researchBits || (p.meta && p.meta.researchBits) || null,
      taken: false
    };
    d.plays = d.plays || [];
    d.plays.unshift(row);
    if (d.plays.length > MEMORY_TRADE_MAX * 2) d.plays.length = MEMORY_TRADE_MAX * 2;
    // Soft pattern bump on proposal (tiny) so repeated patterns are visible before settle
    if (row.patternKey) {
      const pat = memPattern(row.patternKey);
      pat.proposals = (pat.proposals || 0) + 1;
    }
    // Track as shadow play for learning
    trackShadowPlay({ ...p, id: row.id, side: row.side, ticker: row.ticker, series: row.series, price: row.price, edge: row.edge, winProb: row.winProb, stake: row.stake, category: row.category }, 'proposed');
  } catch (_) { /* ignore */ }
  botState.memory.updatedAt = Date.now();
  saveState();
}

// Shadow play tracking — records ALL proposals for learning, even denied ones
function trackShadowPlay(pending, action) { // action: 'proposed' | 'approved' | 'denied'
  const shadow = {
    t: Date.now(),
    id: pending.id,
    action,
    asset: pending.asset,
    side: pending.side,
    ticker: pending.ticker || (pending.market && pending.market.ticker),
    series: pending.meta?.series,
    price: pending.price,
    edge: pending.edge,
    winProb: pending.winProb,
    stake: pending.betAmount,
    category: pending.category,
    taken: action === 'approved'
  };
  botState.shadowPlays.push(shadow);
  if (botState.shadowPlays.length > 500) botState.shadowPlays.shift();
  saveState();
}

function markPlayTaken(pending) {
  try {
    const d = dep();
    const id = pending && pending.id;
    const ticker = pending && (pending.ticker || (pending.market && pending.market.ticker));
    const side = pending && pending.side;
    for (const row of (d.plays || []).slice(0, 40)) {
      if ((id && row.id === id) || (ticker && row.ticker === ticker && row.side === side && !row.taken)) {
        row.taken = true;
        row.takenAt = Date.now();
        break;
      }
    }
  } catch (_) { /* ignore */ }
}
function recordDenialMemory(pending) {
  try {
    const d = dep();
    d.stats.denials = (d.stats.denials || 0) + 1;
    const row = {
      t: Date.now(),
      asset: pending.asset || null,
      side: pending.side || null,
      type: pending.type || null,
      category: pending.category || catOf(pending.asset),
      ticker: pending.ticker || (pending.market && pending.market.ticker) || (pending.opportunity && pending.opportunity.market && pending.opportunity.market.ticker) || null,
      edge: (pending.meta && pending.meta.features && pending.meta.features.edge) || (pending.play && pending.play.move != null ? pending.play.move / 100 : null),
      winProb: pending.play ? pending.play.winProb : null
    };
    d.denials.unshift(row);
    if (d.denials.length > MEMORY_DENY_MAX) d.denials.length = MEMORY_DENY_MAX;
    // Preference: if user keeps denying a market/side, soft-learn it
    if (row.ticker && row.side) {
      const k = `${row.ticker}|${row.side}`;
      if (!d.markets[k]) d.markets[k] = { trades: 0, wins: 0, losses: 0, netProfit: 0, denials: 0 };
      d.markets[k].denials = (d.markets[k].denials || 0) + 1;
    }
    botState.memory.updatedAt = Date.now();
    if ((d.stats.denials % 5) === 0) {
      addLesson(`User denied ${d.stats.denials} plays — respect preference filters on repeated denials.`, ['preference', 'denial']);
    }
    saveState();
  } catch (e) { console.error('recordDenialMemory:', e.message); }
}
function trackShadowPlay(pending, action) {
  const row = {
    t: Date.now(),
    id: pending.id,
    action,
    asset: pending.asset || null,
    side: pending.side || null,
    type: pending.type || null,
    category: pending.category || catOf(pending.asset),
    ticker: pending.ticker || (pending.market && pending.market.ticker) || null,
    series: (pending.meta && pending.meta.series) || pending.series || null,
    price: pending.price != null ? pending.price : (pending.play && pending.play.price != null ? pending.play.price : null),
    edge: (pending.meta && pending.meta.features && pending.meta.features.edge != null)
      ? pending.meta.features.edge
      : (pending.edge != null ? pending.edge : (pending.play && pending.play.move != null ? pending.play.move / 100 : null)),
    winProb: pending.winProb != null ? pending.winProb : (pending.play ? pending.play.winProb : null),
    stake: pending.betAmount != null ? pending.betAmount : pending.stake || null,
    phase: pending.phase || (typeof quantCyclePhase === 'function' ? quantCyclePhase().name : null),
    cycleId: pending.cycleId || (typeof currentCycleId === 'function' ? currentCycleId() : null),
    patternKey: (pending.meta && pending.meta.patternKey) || pending.patternKey || null,
    settled: false,
    outcome: null
  };
  botState.shadowPlays = botState.shadowPlays || [];
  botState.shadowPlays.unshift(row);
  if (botState.shadowPlays.length > 500) botState.shadowPlays.length = 500;
}
function recordApprovalMemory(pending) {
  try {
    const d = dep();
    d.stats.approvals = (d.stats.approvals || 0) + 1;
    markPlayTaken(pending);
    botState.memory.updatedAt = Date.now();
  } catch (_) { /* ignore */ }
}

// Distill the market's live "fingerprint" (the acquired knowledge it observes).
function buildFeatures(a) {
  const f = {};
  if (!a) return f;
  if (a.ind) { f.rsi = a.ind.rsi; f.momentum = a.ind.momentum; f.sigmaPerMin = a.ind.sigmaPerMin; }
  if (a.news && typeof a.news.value === 'number') f.fng = a.news.value;
  if (typeof a.minsToClose === 'number') f.minsToClose = a.minsToClose;
  if (typeof a.volatility === 'number') f.volatility = a.volatility;
  if (typeof a.edge === 'number') f.edge = a.edge;
  if (typeof a.price === 'number') f.price = a.price;
  if (a.series) f.series = a.series;
  if (a.ticker) f.ticker = a.ticker;
  if (a.tf) f.tf = a.tf;
  if (a.research && typeof a.research.score === 'number') f.researchScore = a.research.score;
  if (typeof a.moneyness === 'number') f.moneyness = a.moneyness;
  if (a.researchBits) f.researchBits = a.researchBits;
  return f;
}

// Bucket a fingerprint into a stable pattern key (pattern recognition memory).
function patternKey(asset, side, f) {
  const parts = [baseAsset(asset), side];
  if (typeof f.rsi === 'number')          parts.push('rsi' + bucket(f.rsi, [30, 45, 55, 70]));
  if (typeof f.momentum === 'number')     parts.push('mom' + (f.momentum > 0.001 ? 'up' : f.momentum < -0.001 ? 'dn' : 'flat'));
  if (typeof f.sigmaPerMin === 'number')  parts.push('vol' + bucket(f.sigmaPerMin, [0.0008, 0.0015, 0.003]));
  if (typeof f.fng === 'number')          parts.push('fng' + bucket(f.fng, [25, 45, 55, 75]));
  if (typeof f.minsToClose === 'number')  parts.push('t' + bucket(f.minsToClose, [15, 60, 240]));
  if (f.tf) parts.push('tf' + f.tf);
  return parts.join('|');
}
function memPattern(key) { if (!botState.memory.patterns[key]) botState.memory.patterns[key] = { trades: 0, wins: 0, netProfit: 0 }; return botState.memory.patterns[key]; }
function patternWinRate(key) { const p = botState.memory.patterns[key]; if (!p || p.trades < MIN_SAMPLES_TO_TRUST) return null; return p.wins / p.trades; }

// ---- CATEGORY MEMORY (rolling ~30-day outcomes per category) ----
function catOf(asset) {
  const b = baseAsset(asset);
  if (b === 'WX') return 'WEATHER';
  if (b === 'CM') return 'COMMODITY';
  if (b === 'QN') return 'QUANT_NICHE';
  if (b === 'NX') return 'NICHE';
  if (CRYPTO_SERIES[b] || ['BTC', 'ETH', 'SOL', 'DOGE'].includes(b)) return 'CRYPTO';
  return 'OTHER';
}
function memCategory(cat) { if (!botState.memory.categories[cat]) botState.memory.categories[cat] = { log: [] }; return botState.memory.categories[cat]; }
function recordCategoryOutcome(cat, won, profit, edge) {
  const c = memCategory(cat);
  c.log.push({ t: Date.now(), won: !!won, profit: profit || 0, edge: (edge == null ? null : edge) });
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;      // keep last 30 days only
  c.log = c.log.filter(e => e.t >= cutoff);
}
function categoryStats(cat, days = 30) {
  const c = botState.memory.categories[cat];
  if (!c || !c.log.length) return null;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const rows = c.log.filter(e => e.t >= cutoff);
  if (!rows.length) return null;
  const wins = rows.filter(e => e.won).length;
  const net = rows.reduce((s, e) => s + (e.profit || 0), 0);
  return { n: rows.length, wins, winRate: wins / rows.length, net };
}

// Fold a settled outcome back into long-term memory + knowledge depository.
function recordTradeMemory(bet, settlement) {
  const won = !!settlement.won;
  const profit = settlement.profit || 0;
  const m = memAsset(bet.asset);
  m.trades++; won ? m.wins++ : m.losses++;
  m.netProfit += profit;
  m.lastResult = won ? 'win' : 'loss';
  m.lastTradedAt = Date.now();
  m.streak = won ? (m.streak >= 0 ? m.streak + 1 : 1) : (m.streak <= 0 ? m.streak - 1 : -1);
  if (typeof bet.estimatedWinProbability === 'number') { m.probSum += bet.estimatedWinProbability; m.hitSum += won ? 1 : 0; }
  if (bet.patternKey) { const p = memPattern(bet.patternKey); p.trades++; if (won) p.wins++; p.netProfit += profit; }
  const cat = bet.category || catOf(bet.asset);
  recordCategoryOutcome(cat, won, profit, bet.features && bet.features.edge);

  // ---- DEPOSITORY LEDGER ----
  try {
    const d = dep();
    d.stats.settles = (d.stats.settles || 0) + 1;
    const series = (bet.features && bet.features.series) || bet.series || null;
    const ticker = bet.ticker || null;
    const side = bet.side || null;
    const hour = localHour(bet.timestamp || Date.now());
    bumpBucket(d.series, series, won, profit);
    bumpBucket(d.sides, `${cat}|${side}`, won, profit);
    bumpBucket(d.hours, String(hour), won, profit);
    if (ticker) {
      if (!d.markets[ticker]) d.markets[ticker] = { trades: 0, wins: 0, losses: 0, netProfit: 0, denials: 0, lastSide: null };
      d.markets[ticker].trades++;
      if (won) d.markets[ticker].wins++; else d.markets[ticker].losses++;
      d.markets[ticker].netProfit += profit;
      d.markets[ticker].lastSide = side;
    }
    d.trades.unshift({
      t: Date.now(), asset: bet.asset, category: cat, side, ticker, series,
      amount: bet.amount, profit, won, edge: bet.features && bet.features.edge != null ? bet.features.edge : null,
      winProb: bet.estimatedWinProbability != null ? bet.estimatedWinProbability : null,
      patternKey: bet.patternKey || null, hour
    });
    if (d.trades.length > MEMORY_TRADE_MAX) d.trades.length = MEMORY_TRADE_MAX;

    // Auto-lessons from outcomes
    if (!won && bet.features && typeof bet.features.edge === 'number' && bet.features.edge >= 0.10) {
      addLesson(`Lost despite ${pp(bet.features.edge)} edge on ${bet.asset} ${String(side || '').toUpperCase()} — model can overstate short-window certainty.`, ['loss', 'edge', cat]);
    }
    if (won && bet.features && typeof bet.features.minsToClose === 'number' && bet.features.minsToClose <= 20) {
      addLesson(`Fast 15m win on ${bet.asset} ${String(side || '').toUpperCase()} — short-settle plays recycling capital well.`, ['win', '15m', cat]);
    }
    if (m.streak <= -3) addLesson(`${bet.asset} on a ${Math.abs(m.streak)}-loss streak — demand cleaner edges.`, ['streak', baseAsset(bet.asset)]);
    if (m.streak >= 3) addLesson(`${bet.asset} hot streak ${m.streak}W — still size fixed, don't tilt up.`, ['streak', 'win', baseAsset(bet.asset)]);
  } catch (e) { console.error('depository settle write:', e.message); }

  botState.memory.updatedAt = Date.now();
}

// Pull relevant knowledge for a candidate play (used by ownerReview + cards).
function consultDepository({ asset, side, features, category, ticker, series }) {
  ensureMemoryShape();
  const d = dep();
  const cat = category || catOf(asset);
  const bits = [];
  const adj = { probDelta: 0, edgeNeed: 0, notes: [], veto: null };

  // Asset record
  const a = botState.memory.assets[asset] || botState.memory.assets[baseAsset(asset)];
  if (a && a.trades >= 3) {
    const wr = a.wins / a.trades;
    bits.push(`Asset ${baseAsset(asset)}: ${a.wins}W-${a.losses}L (${pct(wr)}) net ${a.netProfit >= 0 ? '+' : ''}${money(a.netProfit)}`);
    if (a.streak <= -2) { adj.probDelta -= 0.015; adj.edgeNeed += 0.01; adj.notes.push(`asset cold streak ${a.streak}`); }
    if (a.streak >= 2) { adj.notes.push(`asset hot streak +${a.streak}`); }
  }

  // Pattern
  const pkey = patternKey(asset, side, features || {});
  const pwr = patternWinRate(pkey);
  if (pwr != null) bits.push(`Pattern ${pkey.split('|').slice(0, 3).join('|')}… wr ${pct(pwr)}`);

  // Series / market / side / hour buckets
  const ser = series || (features && features.series) || null;
  const tkr = ticker || (features && features.ticker) || null;
  if (ser && d.series[ser] && d.series[ser].trades >= 3) {
    const s = bucketStats(d.series[ser]);
    bits.push(`Series ${ser}: ${pct(s.winRate)} over ${s.n} · ${s.net >= 0 ? '+' : ''}${money(s.net)}`);
    if (s.winRate < 0.4) { adj.probDelta -= 0.02; adj.edgeNeed += 0.015; adj.notes.push(`weak series ${ser}`); }
    if (s.winRate >= 0.58) { adj.probDelta += 0.01; adj.notes.push(`strong series ${ser}`); }
  }
  if (tkr && d.markets[tkr] && d.markets[tkr].trades >= 2) {
    const s = bucketStats(d.markets[tkr]);
    bits.push(`Ticker ${tkr}: ${pct(s.winRate)} / ${s.n}`);
    if ((d.markets[tkr].denials || 0) >= 3 && (d.markets[tkr].trades || 0) <= 1) {
      adj.notes.push(`you denied this ticker often (${d.markets[tkr].denials}x)`);
      adj.edgeNeed += 0.01;
    }
  }
  const sideKey = `${cat}|${side}`;
  if (d.sides[sideKey] && d.sides[sideKey].trades >= 4) {
    const s = bucketStats(d.sides[sideKey]);
    bits.push(`${cat} ${String(side || '').toUpperCase()}: ${pct(s.winRate)} over ${s.n}`);
    if (s.winRate < 0.42) { adj.probDelta -= 0.015; adj.edgeNeed += 0.01; adj.notes.push(`weak ${cat} ${side}`); }
    else if (s.winRate >= 0.58) { adj.probDelta += 0.015; adj.notes.push(`strong ${cat} ${side} ${pct(s.winRate)}`); }
  }
  const hr = String(localHour());
  if (d.hours[hr] && d.hours[hr].trades >= 5) {
    const s = bucketStats(d.hours[hr]);
    bits.push(`Hour ${hr}:00 hist ${pct(s.winRate)} (${s.n})`);
    if (s.winRate < 0.4) { adj.edgeNeed += 0.01; adj.notes.push(`weak hour ${hr}`); }
  }

  // User notes (tag match)
  const tags = [baseAsset(asset), cat, side, ser, (features && features.tf) || null].filter(Boolean).map(String);
  const notes = (d.notes || []).filter(n => {
    if (!n.tags || !n.tags.length) return /always|never|prefer|avoid/i.test(n.text || '');
    return n.tags.some(t => tags.some(x => String(x).toLowerCase() === String(t).toLowerCase()));
  }).slice(0, 3);
  for (const n of notes) bits.push(`Note: ${n.text}`);

  // Recent lessons
  const lessons = (d.lessons || []).filter(l => !l.tags || !l.tags.length || l.tags.some(t => tags.includes(t) || tags.map(x => String(x).toLowerCase()).includes(String(t).toLowerCase()))).slice(0, 2);
  for (const l of lessons) bits.push(`Lesson: ${l.text}`);

  // Recent similar trades
  const recent = (d.trades || []).filter(tr => baseAsset(tr.asset) === baseAsset(asset) && tr.side === side).slice(0, 5);
  if (recent.length) {
    const rw = recent.filter(t => t.won).length;
    bits.push(`Last ${recent.length} similar: ${rw}W-${recent.length - rw}L`);
  }

  return { bits, adj, patternKey: pkey };
}

function memoryBriefForCard({ asset, side, features, category, ticker, series }) {
  const c = consultDepository({ asset, side, features, category, ticker, series });
  if (!c.bits.length) return ['Memory: thin history — treating as fresh research.'];
  return c.bits.slice(0, 5);
}

// If the model has been overconfident on an asset, shrink its edge toward reality.
function assetCalibration(asset) {
  const m = botState.memory.assets[asset];
  if (!m || m.trades < MIN_SAMPLES_TO_TRUST || m.probSum <= 0) return 1;
  const predicted = m.probSum / m.trades, realized = m.hitSum / m.trades;
  if (predicted <= 0.5) return 1;
  return clamp((realized - 0.5) / (predicted - 0.5), 0.4, 1.15);
}

// Consecutive realized losers across the whole book (drawdown discipline).
function netLoserStreak() {
  let s = 0; const h = botState.settlementHistory;
  for (let i = h.length - 1; i >= 0; i--) { if (h[i].result === 'loss') s++; else break; }
  return s;
}

// THE OWNER'S SECOND LOOK — integrates memory + patterns + prudence into go/no-go.
// Returns { ok, prob, note, patternKey }.
// FIX: old fee check used (prob-0.5) which silently killed longshots (prob often <50%)
// and category net<0 hard-veto silenced the entire CRYPTO book after a few losses.
function ownerReview({ asset, side, winProb, features, category, ticker, series }) {
  const pkey = patternKey(asset, side, features || {});
  if (!OWNER_MODE) return { ok: true, prob: winProb, note: 'owner-mode off', patternKey: pkey, memoryBits: [] };
  const notes = [];
  let prob = Number(winProb) || 0;
  const cat = category || catOf(asset);
  const featEdge = (features && typeof features.edge === 'number') ? features.edge : null;
  const isAsymmetric = cat === 'LONGSHOT' || cat === 'NICHE' || cat === 'QUANT_NICHE' || (featEdge != null && featEdge > 0.15 && prob < 0.5);

  // 0) Consult knowledge depository (assets/series/hours/notes/lessons)
  const knowledge = consultDepository({ asset, side, features, category: cat, ticker, series });
  if (knowledge.adj.probDelta) {
    prob = clamp(prob + knowledge.adj.probDelta, 0.01, 0.99);
    notes.push(`memΔ${(knowledge.adj.probDelta * 100).toFixed(1)}pp`);
  }
  if (knowledge.adj.notes.length) notes.push(...knowledge.adj.notes.slice(0, 2));

  // 1) Calibrate confidence (skip crushing asymmetric longshots).
  const cal = assetCalibration(asset);
  if (cal !== 1) {
    if (!isAsymmetric) {
      prob = 0.5 + (prob - 0.5) * cal;
      notes.push(`cal×${cal.toFixed(2)}`);
    } else notes.push(`cal skip (asymmetric)`);
  }

  // 2) Pattern recognition — soft nudge; hard-veto only wrecked patterns.
  const pwr = patternWinRate(pkey);
  if (pwr != null) {
    if (pwr < 0.30) return { ok: false, prob, note: `veto: pattern wins ${(pwr * 100).toFixed(0)}%`, patternKey: pkey, memoryBits: knowledge.bits };
    if (pwr < 0.45) notes.push(`weak pat ${(pwr * 100).toFixed(0)}%`);
    else {
      prob = prob * 0.8 + pwr * 0.2;
      notes.push(`pat ${(pwr * 100).toFixed(0)}%`);
    }
  }

  // 2b) CATEGORY MEMORY — soft penalty, not total book shutdown.
  const cs = categoryStats(cat, 30);
  if (cs && cs.n >= MIN_SAMPLES_TO_TRUST) {
    if (cs.winRate < 0.30 && cs.net < 0) {
      return { ok: false, prob, note: `veto: ${cat} 30d wrecked ${(cs.winRate * 100).toFixed(0)}% / $${cs.net.toFixed(2)}`, patternKey: pkey, memoryBits: knowledge.bits };
    }
    if (cs.winRate < 0.45 || cs.net < 0) {
      prob = Math.max(0.01, prob - 0.02);
      notes.push(`${cat} soft-warn ${(cs.winRate * 100).toFixed(0)}%`);
    } else {
      prob = prob * 0.85 + cs.winRate * 0.15;
      notes.push(`${cat} ${(cs.winRate * 100).toFixed(0)}%`);
    }
  }

  // 3) Fee / thin-edge check using REAL market edge when available (+ memory edge need).
  const extraNeed = knowledge.adj.edgeNeed || 0;
  if (isAsymmetric) {
    if (featEdge != null && featEdge < (FEE_BUFFER + extraNeed)) {
      return { ok: false, prob, note: `veto: asymmetric edge ${pp(featEdge)} < fee+mem`, patternKey: pkey, memoryBits: knowledge.bits };
    }
  } else {
    const cushion = featEdge != null ? featEdge : (prob - 0.5);
    if (cushion - (FEE_BUFFER + extraNeed) <= 0) {
      return { ok: false, prob, note: `veto: thin edge after fees/mem (${pp(cushion)})`, patternKey: pkey, memoryBits: knowledge.bits };
    }
  }

  // 4) Drawdown discipline.
  const streak = netLoserStreak();
  if (streak >= STREAK_TIGHTEN_AFTER) {
    if (isAsymmetric) {
      notes.push(`streak ${streak} (scout ok)`);
    } else {
      const need = 0.04 + 0.015 * (streak - STREAK_TIGHTEN_AFTER + 1) + extraNeed;
      const cushion = featEdge != null ? featEdge : (prob - 0.5);
      if (cushion < need) return { ok: false, prob, note: `veto: ${streak}-loss streak needs ≥${(need * 100).toFixed(0)}pp`, patternKey: pkey, memoryBits: knowledge.bits };
      notes.push(`streak ${streak}`);
    }
  }

  // 5) Confidence bar — skip for intentional low-prob longshots/niches.
  if (!isAsymmetric && prob < RISK_RULES.minConfidenceToTrade) {
    return { ok: false, prob, note: `veto: adj ${pct(prob)} < min`, patternKey: pkey, memoryBits: knowledge.bits };
  }

  // 6) Knowledge-backing check for strategy plays (FAVORITE/UNDERDOG).
  //    The bot should only fire these when it has intel behind the decision.
  const priceForStrategy = (features && typeof features.price === 'number') ? features.price : null;
  if (priceForStrategy != null) {
    const pt = classifyPlayType(priceForStrategy, side);
    if (pt && pt.requireMemory) {
      const hasIntel = knowledge.bits.length >= 2; // need asset history + at least one more signal
      const hasEdge = featEdge != null && featEdge >= pt.minEdge;
      const hasWinRate = prob >= pt.minWinProb;
      if (!hasIntel && !hasEdge) {
        return { ok: false, prob, note: `veto: ${pt.label} — no memory backing (need intel + edge)`, patternKey: pkey, memoryBits: knowledge.bits };
      }
    }
  }

  return { ok: true, prob, note: notes.join(' · ') || 'clean', patternKey: pkey, memoryBits: knowledge.bits };
}


// ============================================
// PROFIT-TAKING — bank gains when the tape is shaky, ride when it's calm.
// ============================================
// Recent per-minute volatility for a crypto asset from our own 30s price log.
function assetShakiness(asset) {
  const hist = (botState.priceHistory[baseAsset(asset)] || []).slice(-SCAN_LOOKBACK);
  if (hist.length < 4) return null;
  const rets = [];
  for (let i = 1; i < hist.length; i++) { const a = hist[i - 1].price, b = hist[i].price; if (a > 0 && b > 0) rets.push(Math.log(b / a)); }
  if (rets.length < 3) return null;
  return stddev(rets) * Math.sqrt(2); // ~30s samples -> per-minute
}

// The price we could exit an open position at right now (the bid we'd hit).
// The opposite side's current ask — what a full hedge costs per contract.
// Read via the SAME market fields the proven buy path uses (no sell endpoint).
function hedgeAskFor(bet, market) {
  const yesAsk = parseFloat(market.yes_ask_dollars), noAsk = parseFloat(market.no_ask_dollars);
  return bet.side === 'yes' ? (Number.isFinite(noAsk) ? noAsk : null)
                            : (Number.isFinite(yesAsk) ? yesAsk : null);
}

// HEDGE-TO-LOCK: buy N of the OPPOSITE side through placeKalshiOrderOnMarket()
// (the exact path your live buys already use). N YES + N NO pays exactly $N at
// settlement, so profit is locked with zero settlement risk & no sell endpoint.
async function hedgeLockPosition(bet, market, hedgeAsk) {
  const N = bet.contractCount || 1;
  const oppSide = bet.side === 'yes' ? 'no' : 'yes';
  const dollarAmount = (N + 0.5) * hedgeAsk; // size so floor(amount/ask) == N
  const res = await placeKalshiOrderOnMarket(market, oppSide, dollarAmount);
  return { ...res, oppSide, N };
}

// Evaluate an open position: is there lockable profit, and is the tape shaky?
async function evaluateLock(bet) {
  const data = await kalshiRequest('GET', `/markets/${bet.ticker}`);
  if (!data || !data.market) return { ok: false };
  const market = data.market;
  if (market.status && market.status !== 'active' && market.status !== 'open') return { ok: false };
  const hedgeAsk = hedgeAskFor(bet, market);
  if (hedgeAsk == null || hedgeAsk <= 0) return { ok: false };
  const N = bet.contractCount || 1;
  const entryFee = bet.entryFee || 0;
  const hedgeFee = kalshiFee(hedgeAsk, N);
  const locked = N - bet.amount - N * hedgeAsk - entryFee - hedgeFee;     // guaranteed profit if we hedge now
  if (locked < PROFIT_MIN_USD) return { ok: false };
  const maxGain = N - bet.amount;
  const frac = maxGain > 0 ? locked / maxGain : 1;
  const shake = assetShakiness(bet.asset);
  const shaky = shake != null ? shake >= SHAKY_SIGMA : true;
  const why = shaky ? (shake != null ? `shaky σ${(shake * 100).toFixed(2)}%/min` : 'unknown tape') : `captured ${(frac * 100).toFixed(0)}% of upside`;
  return { ok: true, market, hedgeAsk, N, locked, frac, shaky, why };
}

// One-tap lock button + snooze.
function lockKeyboard(betId) {
  return { reply_markup: { inline_keyboard: [[
    { text: '🔒 Lock Profit', callback_data: `lk_${betId}` },
    { text: '💤 Ride it',     callback_data: `li_${betId}` }
  ]] } };
}

// Sweep open positions; AUTO-LOCK small quick profits, ALERT on larger/shaky
const lockAlertAt = {};
const LOCK_ALERT_COOLDOWN_MIN = parseFloat(process.env.LOCK_ALERT_COOLDOWN_MIN || '5');
// Auto-lock tiny quick profits (e.g., $0.10 in first 3 min) — set AUTO_LOCK_MIN_USD=0 to disable
const AUTO_LOCK_MIN_USD = parseFloat(process.env.AUTO_LOCK_MIN_USD || '0.10');
const AUTO_LOCK_MAX_AGE_MIN = parseFloat(process.env.AUTO_LOCK_MAX_AGE_MIN || '5'); // only auto-lock in first N min

async function checkProfitTaking() {
  if (!PROFIT_TAKE_ENABLED || botState.openBets.length === 0) return;
  for (const bet of [...botState.openBets]) {
    if (!bet.ticker) continue;
    try {
      const last = lockAlertAt[bet.id];
      if (last && Date.now() - last < LOCK_ALERT_COOLDOWN_MIN * 60 * 1000) continue;
      const e = await evaluateLock(bet);
      if (!e.ok) continue;

      // AUTO-LOCK any profitable position — no permission needed
      if (e.locked >= PROFIT_MIN_USD) {
        await lockNow(bet.id, YOUR_TELEGRAM_ID);
        continue;
      }

      // Only alert if profit exists but below lock threshold
      if (!(e.shaky || e.frac >= PROFIT_LOCK_FRAC)) continue;
      lockAlertAt[bet.id] = Date.now();
      notify(
        `⚠️ SHAKY — PROFIT ON THE TABLE\n${bet.asset} ${bet.side.toUpperCase()} · ${bet.ticker}\n` +
        `Lock now → +$${e.locked.toFixed(2)} guaranteed (hedge ${e.N} @ ~${(e.hedgeAsk * 100).toFixed(0)}¢)\n${e.why}`,
        { public: true });
    } catch (err) { console.error(`Lock-eval ${bet.id}:`, err.message); }
    await sleep(300);
  }
}

// Execute the hedge-lock for one bet (fired when you tap 🔒). Honors DRY_RUN.
async function lockNow(betId, chatId) {
  const bet = botState.openBets.find(b => b.id === betId);
  if (!bet) { bot.sendMessage(chatId, `⚠️ Position #${betId} is no longer open.`); return; }
  const e = await evaluateLock(bet);
  if (!e.ok) { bot.sendMessage(chatId, `⚠️ No lockable profit on #${betId} right now.`); return; }
  const res = await hedgeLockPosition(bet, e.market, e.hedgeAsk);
  if (!res.success) { bot.sendMessage(chatId, `⚠️ Hedge-lock failed: ${res.reason}`); return; }
  if (res.dryRun) { bot.sendMessage(chatId, `🧪 DRY RUN — would HEDGE-LOCK ${bet.asset} ${bet.side.toUpperCase()} ${bet.ticker}\nBuy ${res.contractCount} ${res.oppSide.toUpperCase()} @ ~${(e.hedgeAsk * 100).toFixed(0)}¢ → +$${e.locked.toFixed(2)} guaranteed.`); return; }
  // Booked: both legs guarantee $N, so credit locked profit now and stop tracking.
  botState.openBets = botState.openBets.filter(b => b.id !== bet.id);
  botState.stats.totalProfit += e.locked;
  botState.stats.wins++;
  const prev = botState.settlementHistory.length ? botState.settlementHistory[botState.settlementHistory.length - 1].cumulativeProfit : 0;
  botState.settlementHistory.push({ time: Date.now(), result: 'win', profit: e.locked, cumulativeProfit: prev + e.locked, asset: bet.asset, closedEarly: true, method: 'hedge-lock' });
  const settlement = { won: true, profit: e.locked, settledResult: 'hedge-lock', closedEarly: true };
  botState.closedBets.push({ ...bet, ...settlement, closedAt: Date.now() });
  recordTradeMemory(bet, settlement);
  saveState();
  bot.sendMessage(chatId, `🔒 PROFIT LOCKED — ${bet.asset} ${bet.side.toUpperCase()} ${bet.ticker}\nBought ${res.contractCount} ${res.oppSide.toUpperCase()} @ ~${(e.hedgeAsk * 100).toFixed(0)}¢ → +$${e.locked.toFixed(2)} guaranteed\nRunning total: $${botState.stats.totalProfit.toFixed(2)}`);
}

// ============================================
// SCOUT PLAYS — longshots (asymmetric payoff) + niche/obscure hunts
// Separate small-stake budget so they don't crowd out your main 4–6 plays.
// ============================================
const SCOUT_WINDOW_MAX = parseInt(process.env.SCOUT_WINDOW_MAX || '18', 10); // total scout/weather proposals
const WEATHER_WINDOW_MAX = parseInt(process.env.WEATHER_WINDOW_MAX || '2', 10); // slow + rare
let _sKey = null, _sCount = 0, _sNiche = 0, _sLong = 0, _sWx = 0, _sQNiche = 0; const _sDedup = new Set();
function _rollScoutWindow() {
  const k = (typeof liveWindowKey === 'function') ? liveWindowKey() : Math.floor(Date.now() / (15 * 60 * 1000));
  if (k !== _sKey) { _sKey = k; _sCount = 0; _sNiche = 0; _sLong = 0; _sWx = 0; _sQNiche = 0; _sDedup.clear(); }
}
function scoutGate(id, side, kind = 'any') {
  _rollScoutWindow();
  if (_sCount >= SCOUT_WINDOW_MAX) return false;
  if (kind === 'niche' && _sNiche >= NICHE_WINDOW_MAX) return false;
  if (kind === 'quant_niche' && _sQNiche >= QUANT_NICHE_WINDOW_MAX) return false;
  if (kind === 'longshot' && _sLong >= LONGSHOT_WINDOW_MAX) return false;
  if (kind === 'weather' && _sWx >= WEATHER_WINDOW_MAX) return false;
  return !_sDedup.has(`${kind || 'any'}_${id}_${side}`);
}
function scoutMark(id, side, kind = 'any') {
  _rollScoutWindow();
  _sDedup.add(`${kind || 'any'}_${id}_${side}`);
  _sCount++;
  if (kind === 'niche') _sNiche++;
  if (kind === 'quant_niche') _sQNiche++;
  if (kind === 'longshot') _sLong++;
  if (kind === 'weather') _sWx++;
}
function marketMinsToClose(m) {
  if (!m || !m.close_time) return null;
  return Math.max(0.5, (new Date(m.close_time) - Date.now()) / 60000);
}
function nicheHitScore(n) {
  // Higher = more likely we should surface it. Prefers short settle + liquid + cheap asymmetric.
  const mins = n.minsToClose != null ? n.minsToClose : marketMinsToClose(n.market);
  const short = settleBoost(mins || 999);
  const vol = Number(n.volume) || 0;
  const liq = Math.min(1.2, Math.log10(vol + 10) / 3.5);
  // Cheapness vs NICHE_MAX_PRICE (not only longshot max) so 20–30¢ tickets still score
  const cheap = n.price > 0 ? clamp((NICHE_MAX_PRICE - n.price) / Math.max(0.05, NICHE_MAX_PRICE), 0, 1.2) : 0;
  const modelBoost = n.modeled && n.ev != null ? clamp(n.ev, 0, 2) : (n.modeled && n.prob != null ? clamp(n.prob - n.price, 0, 1) * 2 : 0);
  const hit = n.modeled ? clamp((n.prob || 0) - 0.45, 0, 0.5) * 2 : 0;
  // Speculative floor so thin cheap books aren't zeroed out
  const specFloor = (!n.modeled && n.price > 0 && n.price <= 0.25) ? 0.55 : 0;
  return short * 3 + liq + cheap + modelBoost + hit + specFloor;
}

// Model P(YES) for any crypto strike market using our diffusion model.
function cryptoModelProbForMarket(market, ind, spot) {
  const K = (market.floor_strike != null) ? market.floor_strike : (market.cap_strike != null ? market.cap_strike : null);
  if (K == null || !ind) return null;
  const minsToClose = Math.max(0.5, (new Date(market.close_time) - Date.now()) / 60000);
  const S = spot || ind.spot;
  const muPerMin = clamp(ind.momentum / 30, -0.0006, 0.0006);
  const sigmaT = ind.sigmaPerMin * Math.sqrt(minsToClose) || 1e-6;
  const drift = (muPerMin - 0.5 * ind.sigmaPerMin ** 2) * minsToClose;
  let p = normalCDF((Math.log(S / K) + drift) / sigmaT, 0, 1);
  if (ind.rsi < 30) p += 0.03; else if (ind.rsi > 70) p -= 0.03;
  return { prob: clamp(p, 0.01, 0.99), minsToClose, K };
}

// LONGSHOT hunter: cheap contracts (≤ LONGSHOT_MAX_PRICE) where OUR model says the
// true odds are far better than the price — small stake, asymmetric upside.
// Prefers short-settlement markets (15m–few hours).
async function scanLongshots({ preferShort = true } = {}) {
  const out = [];
  for (const asset of Object.keys(CRYPTO_SERIES)) {
    const prices = await getMinuteSeriesCached(asset);
    if (!prices) continue;
    const ind = computeIndicators(prices);
    const spot = botState.prices[asset] || ind.spot;
    for (const s of CRYPTO_SERIES[asset]) {
      const markets = await findMarketsBySeries(s);
      if (!markets) continue;
      for (const m of markets) {
        const mp = cryptoModelProbForMarket(m, ind, spot);
        if (!mp) continue;
        if (preferShort && mp.minsToClose > SHORT_SETTLE_MAX_MIN * 2) continue; // soft — don't empty the book
        const yesAsk = parseFloat(m.yes_ask_dollars), noAsk = parseFloat(m.no_ask_dollars);
        const cands = [];
        if (Number.isFinite(yesAsk) && yesAsk >= NICHE_MIN_PRICE && yesAsk <= LONGSHOT_MAX_PRICE) cands.push({ side: 'yes', price: yesAsk, prob: mp.prob });
        if (Number.isFinite(noAsk) && noAsk >= NICHE_MIN_PRICE && noAsk <= LONGSHOT_MAX_PRICE) cands.push({ side: 'no', price: noAsk, prob: 1 - mp.prob });
        for (const c of cands) {
          const ev = c.prob * (1 / c.price) - 1;              // expected return per $ staked
          if (ev >= LONGSHOT_MIN_EV) out.push({ kind: 'longshot', asset, category: 'LONGSHOT', ticker: m.ticker, market: m, side: c.side, price: c.price, prob: c.prob, ev, minsToClose: mp.minsToClose, modeled: true });
        }
      }
      await sleep(200);
    }
  }
  return out.sort((a, b) => (b.ev + settleBoost(b.minsToClose)) - (a.ev + settleBoost(a.minsToClose)));
}

// NICHE hunter: scours open Kalshi markets for cheap/asymmetric contracts.
// Pulls multiple pages so we don't only see the first 100 crypto rows.
// Modeled crypto niches rank higher; speculative niches still surface.
async function scanNiche(limit = 200, { preferShort = true } = {}) {
  const out = [];
  const seen = new Set();
  // Simple reliable pull — same style as the earlier working bot.
  const data = await kalshiRequest('GET', `/markets?status=open&limit=${Math.min(200, limit)}`);
  const markets = (data && data.markets) || [];
  if (!markets.length) {
    console.log('Niche scan: Kalshi returned 0 open markets');
    return out;
  }

  // Preload crypto indicators (best-effort; don't fail the whole scan).
  const indByAsset = {};
  for (const asset of Object.keys(CRYPTO_SERIES)) {
    try {
      const prices = await getMinuteSeriesCached(asset);
      if (prices) indByAsset[asset] = { ind: computeIndicators(prices), spot: botState.prices[asset] };
    } catch (_) { /* skip */ }
  }
  function guessAssetFromTicker(ticker, title) {
    const t = `${ticker || ''} ${title || ''}`.toUpperCase();
    for (const asset of Object.keys(CRYPTO_SERIES)) {
      if (t.includes(asset)) return asset;
      const name = (THRESHOLDS[asset] && THRESHOLDS[asset].name || '').toUpperCase();
      if (name && t.includes(name)) return asset;
    }
    return null;
  }

  for (const m of markets) {
    if (!m || !m.ticker || seen.has(m.ticker)) continue;
    seen.add(m.ticker);
    const vol = getMarketVolume(m);    // Never block unknown/zero volume — only skip clearly dead high-volume filter misses
    if (Number.isFinite(vol) && vol > 0 && vol < NICHE_MIN_VOLUME) continue;
    const mins = marketMinsToClose(m);
    const yesAsk = parseFloat(m.yes_ask_dollars), noAsk = parseFloat(m.no_ask_dollars);
    const cheap = [];
    // Require real asks (≥2¢ default). 0–1¢ multi-game lotto books are noise.
    if (Number.isFinite(yesAsk) && yesAsk >= NICHE_MIN_PRICE && yesAsk <= NICHE_MAX_PRICE) cheap.push({ side: 'yes', price: yesAsk });
    if (Number.isFinite(noAsk) && noAsk >= NICHE_MIN_PRICE && noAsk <= NICHE_MAX_PRICE) cheap.push({ side: 'no', price: noAsk });
    if (!cheap.length) continue;
    // Skip obvious multi-leg lottery series that dominate the open book with 0–2¢ tickets
    const tU = String(m.ticker || '').toUpperCase();
    if (/MULTIGAME|CROSSCATEGORY|PARLAY|SAMEGAME/.test(tU) && Math.min(yesAsk || 99, noAsk || 99) < 0.05) continue;
    if (preferShort && mins != null && mins > SHORT_SETTLE_MAX_MIN * 4) continue;

    const asset = guessAssetFromTicker(m.ticker, m.title);
    let modeledAny = false;
    if (asset && indByAsset[asset]) {
      try {
        const mp = cryptoModelProbForMarket(m, indByAsset[asset].ind, indByAsset[asset].spot || indByAsset[asset].ind.spot);
        if (mp) {
          modeledAny = true;
          for (const c of cheap) {
            const p = c.side === 'yes' ? mp.prob : (1 - mp.prob);
            const e = c.price > 0 ? (p * (1 / c.price) - 1) : 0;
            out.push({
              kind: 'niche', category: 'NICHE', ticker: m.ticker, market: m, title: m.title || m.ticker,
              side: c.side, price: c.price, volume: vol, modeled: true, asset, prob: p, ev: e,
              minsToClose: mins != null ? mins : mp.minsToClose
            });
          }
        }
      } catch (_) { modeledAny = false; }
    }
    if (!modeledAny) {
      for (const c of cheap) {
        out.push({
          kind: 'niche', category: 'NICHE', ticker: m.ticker, market: m, title: m.title || m.ticker,
          side: c.side, price: c.price, volume: vol, modeled: false, asset: asset || `NX:${m.ticker}`,
          prob: null, ev: null, minsToClose: mins
        });
      }
    }
  }
  console.log(`Niche scan raw: markets=${markets.length} candidates=${out.length}`);
  return out.sort((a, b) => nicheHitScore(b) - nicheHitScore(a)).slice(0, 50);
}

// Propose a longshot (small stake, tap ✅ to fire).
async function proposeLongshot(ls) {
  if (!scoutGate(ls.ticker, ls.side, 'longshot')) return false;
  const review = ownerReview({ asset: ls.asset, side: ls.side, winProb: ls.prob, features: { edge: ls.ev }, category: 'LONGSHOT' });
  if (!review.ok) return false;
  scoutMark(ls.ticker, ls.side, 'longshot');
  const stake = scoutStake(ls.ev);
  const pending = { id: Date.now() + Math.floor(Math.random() * 1000), type: 'scout', category: 'LONGSHOT', asset: ls.asset, market: ls.market, side: ls.side, betAmount: stake, timestamp: Date.now() };
  botState.pendingBets.push(pending); saveState();
  recordProposalMemory(pending);
  notify(formatDecisionCard({
    title: `🎯🚀 LONGSHOT — ${assetDisplayName(ls.asset)}`,
    subtitle: `${ls.side.toUpperCase()} · cheap contract · asymmetric upside`,
    side: ls.side, price: ls.price, winProb: ls.prob, edge: Math.max(0, ls.prob - ls.price), stake,
    minsToClose: ls.minsToClose, marketTitle: (ls.market && ls.market.title) || ls.ticker, ticker: ls.ticker,
    thesis: [
      `Model win chance ${pct(ls.prob)} vs price ${cents(ls.price)} → EV +${pct(ls.ev)}.`,
      `Pays ${payoutX(ls.price)} if right — small stake, convex payoff.`,
      isShortSettle(ls.minsToClose) ? `Settles in ${formatMinsLeft(ls.minsToClose)} — fast feedback loop.` : `Window ${formatMinsLeft(ls.minsToClose)}.`
    ],
    risks: [
      'Longshots lose often; size is intentionally tiny.',
      'Model can be wrong on strike/path in short windows.',
      'Illiquid cheap asks can be traps.'
    ],
    ownerNote: review.note, category: 'LONGSHOT',
    extras: [`Bet ID: ${pending.id}`],
    memoryBits: memoryBriefForCard({ asset: ls.asset, side: ls.side, features: { edge: ls.ev }, category: 'LONGSHOT', ticker: ls.ticker })
  }), proposalKeyboard(pending.id), { public: true });
  return true;
}

// Propose a niche/obscure play. Modeled niches (bot thinks it'll hit) get richer cards + higher priority.
async function proposeNiche(n) {
  if (!n || !n.ticker || !n.side || !(n.price >= NICHE_MIN_PRICE)) return false;
  if (!scoutGate(n.ticker, n.side, 'niche')) return false;
  const modeled = !!n.modeled;
  const score = nicheHitScore(n);
  // BEST-ONLY: keep quality, but don't zero-out every speculative ticket
  if (!modeled && score < NICHE_MIN_HIT_SCORE) return false;
  if (modeled && score < NICHE_MIN_HIT_SCORE * 0.75) return false;

  let reviewNote = modeled ? 'modeled niche' : 'speculative';
  let winProb = n.prob != null ? n.prob : Math.min(0.45, Math.max(0.12, n.price * 1.15));
  try {
    if (modeled && n.prob != null) {
      const review = ownerReview({
        asset: n.asset || `NX:${n.ticker}`, side: n.side, winProb: n.prob,
        features: { edge: n.ev != null ? n.ev : Math.max(0, n.prob - n.price) },
        category: 'NICHE', ticker: n.ticker
      });
      // Modeled niches: hard-veto on wrecked patterns; otherwise advisory
      if (!review.ok && /veto: pattern|veto: NICHE 30d wrecked/i.test(review.note || '')) return false;
      reviewNote = review.ok ? review.note : `note: ${review.note}`;
      if (review.ok) winProb = review.prob;
    }
  } catch (e) { reviewNote = 'review-skip'; }

  scoutMark(n.ticker, n.side, 'niche');
  const stake = scoutStake(modeled && n.ev != null ? Math.max(n.ev, LONGSHOT_MIN_EV) : LONGSHOT_MIN_EV);
  const phase = quantCyclePhase();
  const pending = {
    id: Date.now() + Math.floor(Math.random() * 1000), type: 'scout', category: 'NICHE',
    asset: n.asset || `NX:${n.ticker}`, market: n.market, side: n.side, betAmount: stake,
    timestamp: Date.now(), ticker: n.ticker, price: n.price, edge: n.ev, winProb,
    phase: phase.name, cycleId: currentCycleId(), researchBits: n.researchBits || []
  };
  botState.pendingBets.push(pending); saveState();
  recordProposalMemory(pending);
  notify(formatDecisionCard({
    title: modeled ? `💚 ${n.title}` : `💚 ${n.title}`,
    asset: n.asset || `NX:${n.ticker}`,
    subtitle: modeled
      ? `${n.side.toUpperCase()} · model thinks edge exists · best-of-window`
      : `${n.side.toUpperCase()} · high-score speculative · best-of-window`,
    side: n.side, price: n.price, winProb, edge: n.ev != null ? Math.max(0, n.prob - n.price) : Math.max(0, winProb - n.price), stake,
    minsToClose: n.minsToClose, marketTitle: n.title, ticker: n.ticker,
    thesis: modeled ? [
      `Model win ${pct(n.prob)} vs ask ${cents(n.price)} · EV ${n.ev != null ? '+' + pct(n.ev) : 'n/a'}.`,
      `Surfaced because hit-score ${score.toFixed(2)} cleared best-only bar ${NICHE_MIN_HIT_SCORE}.`,
      `Tiny stake ${money(stake)} — if it hits, asymmetric payoff ${payoutX(n.price)}.`
    ] : [
      `Cheap ${cents(n.price)} contract (${payoutX(n.price)}) with volume ${n.volume || '?'}.`,
      isShortSettle(n.minsToClose) ? `Settles in ${formatMinsLeft(n.minsToClose)} — quick resolution.` : `Settles in ${formatMinsLeft(n.minsToClose)}.`,
      `High hit-score only — still only accept if YOU understand the market.`
    ],
    risks: modeled ? [
      'Still a niche/cheap contract — higher variance than main quant plays.',
      'Model mapping from ticker→asset can be imperfect.',
      'Liquidity/slippage risk on obscure books.'
    ] : [
      '⚠️ SPECULATIVE — thinner research than quant-niche.',
      'Easy to overtrade lotto tickets; reject unless you understand the market.',
      'Can be illiquid or mispriced for structural reasons.'
    ],
    ownerNote: reviewNote, category: 'NICHE',
    extras: [
      `Hit-score ${score.toFixed(2)}`,
      ...(n.researchBits || []).slice(0, 2),
      `Bet ID: ${pending.id}`
    ],
    memoryBits: memoryBriefForCard({ asset: n.asset || `NX:${n.ticker}`, side: n.side, features: { edge: n.ev }, category: 'NICHE', ticker: n.ticker })
  }), proposalKeyboard(pending.id), { public: true });
  return true;
}

// Execute a scout play on its specific market (used on approval). Honors DRY_RUN.
async function executeScoutTrade(pending) {
  reservedExposure += pending.betAmount;
  let orderResult;
  try { orderResult = await placeKalshiOrderOnMarket(pending.market, pending.side, pending.betAmount); } finally { reservedExposure -= pending.betAmount; }
  if (!orderResult.success) { notify(`❌ ${pending.category} order failed: ${orderResult.reason}`); return null; }
  const bet = { id: Date.now() + '_' + (++_betIdCounter), asset: pending.asset, category: pending.category, ticker: orderResult.ticker, side: pending.side, amount: pending.betAmount, contractCount: orderResult.contractCount, timestamp: Date.now(), status: 'open' };
  if (!orderResult.dryRun) { botState.openBets.push(bet); botState.stats.totalBets++; }
  saveState();
  notify(orderResult.dryRun
    ? `🧪 DRY RUN — ${pending.category} ${pending.side.toUpperCase()} ${orderResult.ticker}: ${orderResult.contractCount} contracts (~$${pending.betAmount.toFixed(2)})`
    : `✅ ${pending.category} PLACED — ${orderResult.ticker} ${pending.side.toUpperCase()}\nContracts: ${orderResult.contractCount}\nCost: ~$${pending.betAmount.toFixed(2)}\nBet ID: ${bet.id}`);
  return bet;
}

// QUANT NICHE — niche-style hunter across ALL asset classes (crypto + weather + commodity + open book)
// Separate from classic NICHE. Requires model/research backbone and stricter EV/score bars.
function quantNicheScore(n) {
  const base = nicheHitScore(n);
  const researchBoost = n.researchScore != null ? clamp(n.researchScore * (n.side === 'yes' ? 1 : -1), -0.5, 0.5) : 0;
  const memBoost = n.memWin != null ? clamp((n.memWin - 0.5) * 2, -0.4, 0.4) : 0;
  const multiAsset = n.source && n.source !== 'crypto' ? 0.35 : 0;
  const modeled = n.modeled ? 0.5 : -0.8;
  return base + researchBoost + memBoost + multiAsset + modeled + (n.ev != null ? clamp(n.ev, 0, 1.5) : 0);
}

async function scanQuantNiche({ preferShort = true } = {}) {
  const out = [];
  const phase = quantCyclePhase();

  // 1) Crypto modeled cheap/asymmetric across configured series (all assets)
  try {
    for (const asset of Object.keys(CRYPTO_SERIES)) {
      const prices = await getMinuteSeriesCached(asset);
      if (!prices) continue;
      const ind = computeIndicators(prices);
      const spot = botState.prices[asset] || ind.spot;
      let research = null;
      try { research = await getFullResearchBundle(asset); } catch (_) { research = null; }
      for (const s of CRYPTO_SERIES[asset]) {
        const markets = await findMarketsBySeries(s);
        if (!markets) continue;
        for (const m of markets) {
          const mp = cryptoModelProbForMarket(m, ind, spot);
          if (!mp) continue;
          if (preferShort && mp.minsToClose > SHORT_SETTLE_MAX_MIN * 2) continue;
          const yesAsk = parseFloat(m.yes_ask_dollars), noAsk = parseFloat(m.no_ask_dollars);
          const vol = getMarketVolume(m);          const cands = [];
          if (Number.isFinite(yesAsk) && yesAsk >= NICHE_MIN_PRICE && yesAsk <= QUANT_NICHE_MAX_PRICE) cands.push({ side: 'yes', price: yesAsk, prob: mp.prob });
          if (Number.isFinite(noAsk) && noAsk >= NICHE_MIN_PRICE && noAsk <= QUANT_NICHE_MAX_PRICE) cands.push({ side: 'no', price: noAsk, prob: 1 - mp.prob });
          for (const c of cands) {
            const ev = c.price > 0 ? c.prob * (1 / c.price) - 1 : 0;
            if (ev < QUANT_NICHE_MIN_EV) continue;
            // Research agreement soft filter
            const rScore = research ? research.score : 0;
            if (c.side === 'yes' && rScore < -0.55) continue;
            if (c.side === 'no' && rScore > 0.55) continue;
            const pk = patternKey(asset, c.side, { edge: ev, minsToClose: mp.minsToClose, rsi: ind.rsi, momentum: ind.momentum });
            out.push({
              kind: 'quant_niche', category: 'QUANT_NICHE', source: 'crypto',
              asset, ticker: m.ticker, market: m, title: m.title || m.ticker,
              side: c.side, price: c.price, prob: c.prob, ev, volume: vol,
              modeled: true, minsToClose: mp.minsToClose,
              researchScore: rScore, researchBits: research ? research.bits : [],
              memWin: patternWinRate(pk), patternKey: pk
            });
          }
        }
        await sleep(150);
      }
    }
  } catch (e) { console.error('quantNiche crypto:', e.message); }

  // 2) Weather edges as quant-niche candidates (multi-source ensemble = research backbone)
  try {
    for (const opp of await scanWeatherEdge()) {
      if (!opp || !opp.market) continue;
      const price = opp.side === 'yes' ? parseFloat(opp.market.yes_ask_dollars) : parseFloat(opp.market.no_ask_dollars);
      if (!(price > 0) || price > QUANT_NICHE_MAX_PRICE) continue;
      const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
      const ev = price > 0 ? winProb * (1 / price) - 1 : 0;
      if (ev < QUANT_NICHE_MIN_EV * 0.8 && Math.abs(opp.edge) < 0.08) continue;
      out.push({
        kind: 'quant_niche', category: 'QUANT_NICHE', source: 'weather',
        asset: `WX:${opp.cityCode}`, ticker: opp.market.ticker, market: opp.market,
        title: `${opp.cityName || opp.cityCode} weather`,
        side: opp.side, price, prob: winProb, ev: Math.max(ev, Math.abs(opp.edge)),
        volume: getMarketVolume(opp.market),
        modeled: true, minsToClose: marketMinsToClose(opp.market),
        researchScore: opp.edge, researchBits: [`wx ensemble edge ${pp(opp.edge)}`, `sources ${opp.sources || '?'}`],
        memWin: null
      });
    }
  } catch (e) { console.error('quantNiche weather:', e.message); }

  // 3) Commodity edges
  try {
    for (const opp of await scanCommodityEdge()) {
      if (!opp || !opp.market) continue;
      const price = opp.side === 'yes' ? parseFloat(opp.market.yes_ask_dollars) : parseFloat(opp.market.no_ask_dollars);
      if (!(price > 0) || price > QUANT_NICHE_MAX_PRICE) continue;
      const winProb = opp.side === 'yes' ? opp.modelProb : (1 - opp.modelProb);
      const ev = price > 0 ? winProb * (1 / price) - 1 : 0;
      if (ev < QUANT_NICHE_MIN_EV * 0.8 && Math.abs(opp.edge) < 0.08) continue;
      out.push({
        kind: 'quant_niche', category: 'QUANT_NICHE', source: 'commodity',
        asset: `CM:${opp.code}`, ticker: opp.market.ticker, market: opp.market,
        title: opp.name || opp.code,
        side: opp.side, price, prob: winProb, ev: Math.max(ev, Math.abs(opp.edge)),
        volume: getMarketVolume(opp.market),
        modeled: true, minsToClose: marketMinsToClose(opp.market),
        researchScore: opp.edge, researchBits: [`spot model edge ${pp(opp.edge)}`],
        memWin: null
      });
    }
  } catch (e) { console.error('quantNiche commodity:', e.message); }

  // Phase-aware ranking: pattern phase prefers memory/research agreement
  out.sort((a, b) => {
    let sa = quantNicheScore(a), sb = quantNicheScore(b);
    if (phase.name === 'pattern') {
      if (a.memWin != null) sa += a.memWin;
      if (b.memWin != null) sb += b.memWin;
    }
    return sb - sa;
  });
  console.log(`Quant-niche raw candidates: ${out.length}`);
  return out.filter(n => quantNicheScore(n) >= QUANT_NICHE_MIN_SCORE).slice(0, 30);
}

async function proposeQuantNiche(n) {
  if (!n || !n.ticker || !n.side || !(n.price > 0)) return false;
  if (!scoutGate(n.ticker, n.side, 'quant_niche')) return false;
  const winProb0 = n.prob != null ? n.prob : Math.min(0.5, Math.max(0.15, n.price * 1.2));
  const features = { edge: n.ev != null ? n.ev : Math.max(0, winProb0 - n.price), minsToClose: n.minsToClose, researchScore: n.researchScore };
  const review = ownerReview({
    asset: n.asset || `QN:${n.ticker}`, side: n.side, winProb: winProb0,
    features, category: 'QUANT_NICHE', ticker: n.ticker
  });
  if (!review.ok) return false;
  // Require modeled + score floor (no pure lotto in quant-niche)
  if (!n.modeled) return false;
  if (quantNicheScore(n) < QUANT_NICHE_MIN_SCORE) return false;

  scoutMark(n.ticker, n.side, 'quant_niche');
  const stake = scoutStake(n.ev != null ? Math.max(n.ev, QUANT_NICHE_MIN_EV) : QUANT_NICHE_MIN_EV);
  const phase = quantCyclePhase();
  const pending = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    type: 'scout', category: 'QUANT_NICHE', asset: n.asset || `QN:${n.ticker}`,
    market: n.market, side: n.side, betAmount: stake, timestamp: Date.now(),
    ticker: n.ticker, price: n.price, edge: n.ev, winProb: review.prob,
    phase: phase.name, cycleId: currentCycleId(),
    researchBits: n.researchBits || [],
    meta: { features, patternKey: review.patternKey || n.patternKey, researchBits: n.researchBits || [], phase: phase.name }
  };
  botState.pendingBets.push(pending); saveState();
  recordProposalMemory(pending);
  notify(formatDecisionCard({
    title: `🧪 ${n.title}`,
    asset: n.asset || `QN:${n.ticker}`,
    subtitle: `${n.side.toUpperCase()} · researched across assets · ${phase.label}`,
    side: n.side, price: n.price, winProb: review.prob,
    edge: n.ev != null ? Math.max(0, (n.prob || review.prob) - n.price) : Math.max(0, review.prob - n.price),
    stake, minsToClose: n.minsToClose, marketTitle: n.title, ticker: n.ticker,
    thesis: [
      `Model/ensemble win ${pct(n.prob)} vs ask ${cents(n.price)} · EV ${n.ev != null ? '+' + pct(n.ev) : 'n/a'}.`,
      `Quant-niche = niche mechanics + full research backbone across crypto/weather/commodities.`,
      n.memWin != null ? `Pattern memory win-rate ${pct(n.memWin)} on similar fingerprints.` : `Fresh fingerprint — sized small.`,
      `Score ${quantNicheScore(n).toFixed(2)} (min ${QUANT_NICHE_MIN_SCORE}).`
    ],
    risks: [
      'Still higher variance than main quant plays — small scout stake only.',
      'Cross-asset mapping can be imperfect on obscure books.',
      'Liquidity/slippage on thinner non-crypto markets.'
    ],
    ownerNote: review.note, category: 'QUANT_NICHE',
    extras: [
      `Source ${n.source || '?'}`,
      ...(n.researchBits || []).slice(0, 3),
      `Bet ID: ${pending.id}`
    ],
    memoryBits: memoryBriefForCard({
      asset: n.asset || `QN:${n.ticker}`, side: n.side, features,
      category: 'QUANT_NICHE', ticker: n.ticker
    })
  }), proposalKeyboard(pending.id), { public: true });
  return true;
}

// Run scouts: BEST niches only (not spam) + quant-niche + longshots.
// preferShort: focus 15m–few-hour markets.
async function runScouts({ preferShort = true, moreNiche = false } = {}) {
  let n = 0;
  const lsLimit = 4;
  const nicheLimit = NICHE_WINDOW_MAX; // hard cap — only the best
  const qnLimit = QUANT_NICHE_WINDOW_MAX;

  // CLASSIC NICHE — best few only (modeled preferred; top cheap tickets still allowed)
  try {
    const niches = await scanNiche(200, { preferShort: false });
    const raw = (niches || []).filter(nc => nc && nc.ticker && nc.price >= NICHE_MIN_PRICE && nc.price <= NICHE_MAX_PRICE);
    let ordered = raw
      .filter(nc => nicheHitScore(nc) >= NICHE_MIN_HIT_SCORE)
      .filter(nc => nc.modeled || nc.price <= 0.28) // allow speculative cheap books
      .sort((a, b) => nicheHitScore(b) - nicheHitScore(a));
    // Fallback: if filters wiped everything, still surface top 1–2 by score so flow doesn't die
    if (!ordered.length && raw.length) {
      ordered = raw.slice().sort((a, b) => nicheHitScore(b) - nicheHitScore(a)).slice(0, Math.min(2, nicheLimit));
      console.log(`Niche fallback: using top ${ordered.length}/${raw.length} by score`);
    }
    let nicheProposed = 0;
    for (const nc of ordered) {
      if (nicheProposed >= nicheLimit) break;
      if (preferShort && nc.minsToClose != null && nc.minsToClose > SHORT_SETTLE_MAX_MIN * 4 && nc.price > 0.22) continue;
      try {
        if (nc.asset && CRYPTO_SERIES[baseAsset(nc.asset)]) {
          const r = await getFullResearchBundle(baseAsset(nc.asset));
          nc.researchBits = r.bits; nc.researchScore = r.score;
        }
      } catch (_) { /* ignore */ }
      try {
        if (await proposeNiche(nc)) { n++; nicheProposed++; }
      } catch (e) { console.error('proposeNiche:', e.message); }
    }
    if (raw.length && !nicheProposed) {
      const top = raw.slice().sort((a, b) => nicheHitScore(b) - nicheHitScore(a)).slice(0, 3)
        .map(x => `${(x.ticker || '').slice(0, 18)}@${cents(x.price)} s${nicheHitScore(x).toFixed(2)}${x.modeled ? 'M' : 'S'}`).join(' · ');
      console.log(`Niche scan: raw=${raw.length} ordered=${ordered.length} proposed=0 | top: ${top}`);
    } else {
      console.log(`Niche scan: raw=${raw.length} candidates=${ordered.length} proposed=${nicheProposed} (cap ${nicheLimit})`);
    }
  } catch (e) { console.error('Niche scan:', e.message); }

  // QUANT NICHE — separate category, all assets, research-backed
  try {
    const qn = await scanQuantNiche({ preferShort });
    let qnProposed = 0;
    for (const row of qn) {
      if (qnProposed >= qnLimit) break;
      try {
        if (await proposeQuantNiche(row)) { n++; qnProposed++; }
      } catch (e) { console.error('proposeQuantNiche:', e.message); }
    }
    console.log(`Quant-niche: candidates=${(qn||[]).length} proposed=${qnProposed}`);
  } catch (e) { console.error('Quant-niche scan:', e.message); }

  try {
    const longs = await scanLongshots({ preferShort });
    let lsProposed = 0;
    for (const ls of (longs || []).slice(0, lsLimit)) {
      try { if (await proposeLongshot(ls)) { n++; lsProposed++; } }
      catch (e) { console.error('proposeLongshot:', e.message); }
    }
    console.log(`Longshot scan: candidates=${(longs||[]).length} proposed=${lsProposed}`);
  } catch (e) { console.error('Longshot scan:', e.message); }
  return n;
}

// ============================================
// RADAR RENDERING — concise, colour-coded, best-first
// ============================================
function dirEmoji(mom) { return mom > 0.001 ? '🟢▲' : mom < -0.001 ? '🔴▼' : '⚪️▬'; }
function renderRadar(analyses) {
  const rows = analyses.map(a => {
    if (!a || a.error) return { score: -1, txt: `⚪️ ${a ? a.asset : '?'}${a && a.series ? ' [' + a.series + ']' : ''} · ${a ? a.error : 'n/a'}` };
    const tag = quantTradeable(a) ? '🎯' : '·';
    const arrow = dirEmoji(a.ind.momentum);
    const mktProb = a.side === 'yes' ? a.yesAsk : (a.side === 'no' ? a.noAsk : a.yesAsk);
    return {
      score: a.edge || 0,
      txt: `${tag}${arrow} ${a.asset}${a.tf ? ' ' + a.tf : ''} ${a.side ? a.side.toUpperCase() : '--'} ${a.side ? (mktProb * 100).toFixed(0) + '¢' : ''} · edge ${((a.edge || 0) * 100).toFixed(1)}pp · model ${(a.modelProb * 100).toFixed(0)}%`
    };
  });
  rows.sort((x, y) => y.score - x.score);
  return rows.slice(0, 8).map(r => r.txt).join('\n');
}

// ============================================
// AUTO-RADAR — once per 15m window, same hit logic (no phase flip)
// ============================================
function radarPhase() {
  return { hour: quantCyclePhase(), live: 'hit' };
}
let _lastScoutRadarWindow = null;
async function runAutoRadar() {
  if (typeof autoRadarEnabled !== 'undefined' && !autoRadarEnabled) return;
  if (!botState.isRunning) return;
  resetCycleRuntimeIfNeeded();
  const wk = liveWindowKey();
  // Only run scouts once per window; quant is driven by boundary scheduler
  if (_lastScoutRadarWindow !== wk) {
    _lastScoutRadarWindow = wk;
    await runScouts({ preferShort: true, moreNiche: false });
  }
}
function scheduleAutoRadar() {
  setTimeout(async () => {
    try { await runAutoRadar(); } catch (e) { console.error('Auto-radar:', e.message); }
    scheduleAutoRadar();
  }, 90 * 1000);
}

// ============================================
// SETTLEMENT
// ============================================
async function checkOneSettlement(bet) {
  const data = await kalshiRequest('GET', `/markets/${bet.ticker}`);
  if (!data || !data.market) return null;
  const market = data.market;
  const isSettled = market.status === 'finalized' || market.status === 'settled' || (market.result && market.result !== '');
  if (!isSettled) return null;
  const won = market.result === bet.side;
  const cost = bet.actualCost || (bet.contractCount * (bet.entryPrice || 0.5) + (bet.entryFee || 0));
  const profit = won ? (bet.contractCount || 0) - cost : -cost;
  return { won, profit, settledResult: market.result };
}
async function checkAllSettlements() {
  if (botState.openBets.length === 0) return;
  const stillOpen = [];
  for (const bet of botState.openBets) {
    let settlement;
    try { settlement = await checkOneSettlement(bet); } catch (e) { console.error(`Settlement ${bet.id}:`, e.message); settlement = null; }
    if (!settlement) { stillOpen.push(bet); continue; }
    botState.stats.totalProfit += settlement.profit;
    if (settlement.won) botState.stats.wins++; else botState.stats.losses++;
    try {
      ensureRiskDay();
      botState.risk.dayPnl = (botState.risk.dayPnl || 0) + settlement.profit;
      sendAlert('pnl_update', `${bet.asset} ${settlement.won ? 'WIN' : 'LOSS'} ${settlement.profit >= 0 ? '+' : ''}${money(settlement.profit)} · day ${botState.risk.dayPnl >= 0 ? '+' : ''}${money(botState.risk.dayPnl)}`);
      checkEmergencyStop();
    } catch (_) { /* ignore */ }
    const prev = botState.settlementHistory.length ? botState.settlementHistory[botState.settlementHistory.length - 1].cumulativeProfit : 0;
    botState.settlementHistory.push({ time: Date.now(), result: settlement.won ? 'win' : 'loss', profit: settlement.profit, cumulativeProfit: prev + settlement.profit, asset: bet.asset });
    botState.closedBets.push({ ...bet, ...settlement, closedAt: Date.now() });
    recordTradeMemory(bet, settlement); // learn from this outcome
    const endTime = new Date();
    const endStr = endTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    notify(`${settlement.won ? '✅ WIN' : '❌ LOSS'}: ${bet.asset} ${bet.ticker}\nProfit: ${settlement.profit >= 0 ? '+' : ''}$${settlement.profit.toFixed(2)}\nRunning total: $${botState.stats.totalProfit.toFixed(2)}\n🕐 Ended: ${endStr}`);

    // Track auto-hit consecutive losses for stop-loss
    if (bet.meta && bet.meta.autoHit) {
      if (!botState.AUTO_HIT_CYCLE.consecutiveLosses) botState.AUTO_HIT_CYCLE.consecutiveLosses = 0;
      if (!botState.AUTO_HIT_CYCLE.maxConsecutiveLosses) botState.AUTO_HIT_CYCLE.maxConsecutiveLosses = 5;
      if (settlement.won) {
        botState.AUTO_HIT_CYCLE.consecutiveLosses = 0;
      } else {
        botState.AUTO_HIT_CYCLE.consecutiveLosses++;
        if (botState.AUTO_HIT_CYCLE.consecutiveLosses >= botState.AUTO_HIT_CYCLE.maxConsecutiveLosses && botState.AUTO_HIT_CYCLE.enabled) {
          botState.AUTO_HIT_CYCLE.enabled = false;
          notify(`🛑 AUTO-HIT STOP LOSS — ${botState.AUTO_HIT_CYCLE.consecutiveLosses} consecutive losses. Disabled. Use /go_auto_hit_on to re-enable.`, { public: true });
        }
      }
    }
  }
  botState.openBets = stillOpen;
  // Settle shadow plays (denied/skipped) for learning
  if (botState.shadowPlays && botState.shadowPlays.length) {
    const unsettled = botState.shadowPlays.filter(s => !s.settled);
    for (const sp of unsettled) {
      try {
        const markets = await kalshiRequest('GET', `/markets?ticker=${sp.ticker}`);
        const m = markets?.markets?.[0];
        if (m && (m.status === 'finalized' || m.status === 'settled' || m.result)) {
          const won = m.result === sp.side;
          sp.settled = true;
          sp.outcome = won ? 'win' : 'loss';
          sp.profit = won ? (sp.stake || 0) * ((1 / (sp.price || 0.5)) - 1) : -(sp.stake || 0);
          // Log to memory for learning
          const d = dep();
          d.stats.settles = (d.stats.settles || 0) + 1;
          // Soft update: if we denied a winner, note it
          if (sp.action === 'denied' && won) {
            addLesson(`Denied play would have WON: ${sp.asset} ${sp.side} @ ${cents(sp.price)}`, ['shadow', 'denied', sp.asset]);
          }
        }
      } catch (_) {}
    }
  }
  saveState();
}

// ============================================
// MONITOR LOOPS
// ============================================
function startMonitoring() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   ALPHA HOUND — v5.1 stable       ║');
  console.log('║   Crypto (YES/NO) · Weather · Commodities║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`Bankroll: $${BANKROLL} | Max/trade: $${(BANKROLL * RISK_RULES.maxPerTradePercent).toFixed(2)} | Live: fetching...`);
  console.log(`Auto-fire: ${autoExecuteEnabled ? `ON (≤ $${AUTO_EXECUTE_MAX.toFixed(2)})` : 'OFF'} | Cooldown: ${REPROPOSE_COOLDOWN_MIN > 0 ? REPROPOSE_COOLDOWN_MIN + 'min' : 'off'}`);
  console.log(`Commodities: Yahoo Finance (WTI, NatGas, Gold, Silver) ✅`);
  console.log(`Quant engine: 15m HIT cycles · refresh ${QUANT_SCAN_MIN}m · ${cryptoMarketSpecs().length} market(s) → ${cryptoMarketSpecs().map(s => s.series).join(', ')}`);
  console.log(`Quant bar: edge ${pp(CRYPTO_EDGE_THRESHOLD)} · conf ${pct(RISK_RULES.minConfidenceToTrade)} · fire≤${QUANT_FIRE_MAX} · VOL_MULT ${VOL_MULT} · min vol $${MIN_MARKET_VOLUME}`);
  console.log(`Niche best-only cap ${NICHE_WINDOW_MAX} (score≥${NICHE_MIN_HIT_SCORE}) · Quant-niche cap ${QUANT_NICHE_WINDOW_MAX} (score≥${QUANT_NICHE_MIN_SCORE})`);
  console.log(`Weather: ${Object.values(WEATHER_CITIES).map(c => c.name).join(', ')}`);
  console.log(`Bet size: FAV $${PLAY_STRATEGY.FAVORITE.stakeDefault.toFixed(2)} (${cents(PLAY_STRATEGY.FAVORITE.priceMin)}–${cents(PLAY_STRATEGY.FAVORITE.priceMax)}) | UNDER $${PLAY_STRATEGY.UNDERDOG.stakeDefault.toFixed(2)} (${cents(PLAY_STRATEGY.UNDERDOG.priceMin)}–${cents(PLAY_STRATEGY.UNDERDOG.priceMax)}) | Owner-mode: ${OWNER_MODE ? 'ON 🧠' : 'off'}`);
  console.log(`Strategy: FAVORITE (58-64¢, history+intel backed) · UNDERDOG (37-43¢, edge+memory) · reasoning engine 📖`);
  console.log(`Price sources: Binance → CoinGecko → CoinLore → CoinPaprika → CryptoCompare → CoinCap (6 free fallbacks)`);
  console.log(`Auto-fire: DORMANT (you approve everything) | Lock alerts: ${PROFIT_TAKE_ENABLED ? 'ON 🔔' : 'off'} | Auto-radar: ${RADAR_AUTO ? 'ON 📡' : 'off'} | Proposals/window: ${WINDOW_PROPOSAL_MAX} + ${SCOUT_WINDOW_MAX} scouts`);
  ensureMemoryShape();
  const d0 = dep();
  console.log(`Weather: multi-source ensemble (NWS + Open-Meteo + wttr.in${OPENWEATHER_KEY ? ' + OpenWeather' : ''}) · ${Object.keys(WEATHER_CITIES).length} cities · min edge ${pp(WEATHER_SETTINGS.minEdgeToTrade)}`);
  console.log(`Memory depository: ${MEMORY_FILE}`);
  console.log(`Memory: ${Object.keys(botState.memory.assets).length} asset · ${Object.keys(botState.memory.patterns).length} pattern · ${Object.keys(botState.memory.categories).length} category · ${ (d0.trades||[]).length } ledger · ${ (d0.notes||[]).length } notes · ${ (d0.lessons||[]).length } lessons\n`);

  // checkAndScan REMOVED — runFinalMinutesAllCryptos is the ONLY auto engine
  // setInterval(async () => { try { if (botState.isRunning) await checkAndScan(); } catch (e) { console.error('checkAndScan:', e.message); } }, 15000);          // 15s scan
  // Weather disabled — spammy, slow settle (enable by uncommenting)
  // setInterval(async () => { try { if (botState.isRunning) await checkWeatherOnce(); } catch (e) { console.error('checkWeather:', e.message); } }, 45 * 60 * 1000);   // 45 min — rare, approval-only
  setInterval(async () => { try { if (botState.isRunning) await checkCommoditiesOnce(); } catch (e) { console.error('checkCommodities:', e.message); } }, 30 * 60 * 1000); // 30 min (respects AV daily rate limit)
  setInterval(async () => { try { if (botState.isRunning) await checkAllSettlements(); } catch (e) { console.error('checkSettlements:', e.message); } }, 90 * 1000);      // 90s
  setInterval(async () => { try { if (botState.isRunning) await checkProfitTaking(); } catch (e) { console.error('checkProfitTaking:', e.message); } }, PROFIT_SWEEP_SEC * 1000); // shaky-position lock alerts
  // runScouts REMOVED — runFinalMinutesAllCryptos is the ONLY auto engine
  // setInterval(async () => { try { if (botState.isRunning) await runScouts({ preferShort: false, moreNiche: false }); } catch (e) { console.error('runScouts:', e.message); } }, Math.max(1, NICHE_SCAN_MIN) * 60 * 1000); // best niche + quant-niche + longshot
  // THE ONLY AUTO ENGINE — scans ALL crypto markets, ALL cycle lengths, final 5 min entries + exit mgmt
  setInterval(async () => { try { if (botState.isRunning) await runFinalMinutesAllCryptos(); } catch (e) { console.error('FinalMinutes:', e.message); } }, 20000);
  // Live balance refresh — fetch real Kalshi balance every 60s
  setInterval(async () => {
    try {
      const bal = await getKalshiBalance();
      if (bal != null && isFinite(bal)) {
        botState.liveBalance = bal;
        botState.risk.peakEquity = Math.max(botState.risk.peakEquity || 0, bal);
        tradingBot.portfolioValue = bal;
      }
    } catch (e) { /* silent */ }
  }, 60000);
  // startQuantEngine REMOVED — runFinalMinutesAllCryptos is the ONLY auto engine
  // startQuantEngine();   // boundary heartbeat (+ fixed quant scan when auto-radar off)
  // scheduleAutoRadar REMOVED — runFinalMinutesAllCryptos is the ONLY auto engine
  // scheduleAutoRadar();  // adaptive hunter aligned to each 15-min cycle
  try { ensureRiskDay(); } catch (_) {}
  try { startBinanceTradeStream(Object.keys(CRYPTO_SERIES).slice(0, 5)); } catch (e) { console.error('stream:', e.message); }
  console.log(`Risk: daily loss ${pct(RISK_RULES.dailyLossLimit)} · max DD ${pct(RISK_RULES.maxDrawdown)} · emergency ${pct(RISK_RULES.emergencyStopPct)} · unit ${pct(RISK_RULES.positionSizePct)}`);
console.log('Strategy: FAVORITE + UNDERDOG dual-play · SMA/RSI/BB trend · memory-backed reasoning 📖');
  }

  // ============================================
  // HEALTH MONITOR — keeps bot alive, alerts on issues
  // ============================================
  let lastHeartbeat = Date.now();
  let lastScanTime = 0;
  let lastTradeTime = 0;
  const HEARTBEAT_INTERVAL = 60000; // 1 min
  const MAX_SCAN_GAP = 180000; // 3 min without scan = alert
  const MAX_TRADE_GAP = 3600000; // 1 hour without trade = info

  botState.health = { status: 'starting', lastScan: 0, lastTrade: 0, apiErrors: 0, consecutiveErrors: 0 };

  setInterval(() => {
    try {
      const now = Date.now();
      const scanGap = now - (botState.health?.lastScan || now);
      const tradeGap = now - (botState.health?.lastTrade || now);
      
      // Update health status
      if (kalshiRateLimiter.circuitOpen) {
        botState.health.status = 'circuit_open';
        botState.health.apiErrors++;
      } else if (scanGap > MAX_SCAN_GAP) {
        botState.health.status = 'scan_stalled';
      } else if (botState.health.consecutiveErrors > 3) {
        botState.health.status = 'degraded';
      } else {
        botState.health.status = 'healthy';
      }
      
      // WATCHDOG — force-release engine lock if stuck >60s
      if (_engineLock && botState.health?.lastScan && (now - botState.health.lastScan) > 60000) {
        console.log('🔧 WATCHDOG: force-releasing stuck engine lock');
        _engineLock = false;
      }
      
      botState.health.lastScan = botState.health?.lastScan || 0;
      botState.health.lastTrade = botState.health?.lastTrade || 0;
      
      // Heartbeat log (every 5 min)
      if (now - lastHeartbeat > 300000) {
        const uptime = Math.floor((now - botState.startTime) / 60000);
        console.log(`💓 Heartbeat: ${botState.health.status} | Uptime: ${uptime}m | Bal: $${(botState.liveBalance || BANKROLL).toFixed(2)} | Scans: ${botState.scanCount || 0} | Trades: ${botState.tradeCount || 0} | Circuit: ${kalshiRateLimiter.circuitOpen ? 'OPEN' : 'closed'}`);
        lastHeartbeat = now;
      }
      
      // Alert on issues (throttled — max once per 5 min)
      if (!botState.health._lastAlertTime) botState.health._lastAlertTime = 0;
      if (now - botState.health._lastAlertTime > 300000) {
        if (botState.health.status === 'circuit_open') {
          botState.health._lastAlertTime = now;
          notify(`⚡ CIRCUIT BREAKER OPEN — API failing. Auto-recover in ${kalshiRateLimiter.circuitResetMs/1000}s`, { public: true });
        } else if (botState.health.status === 'scan_stalled') {
          botState.health._lastAlertTime = now;
          notify(`⚠️ Scan stalled ${Math.round(scanGap/60000)}m — check bot`, { public: true });
        }
      }
      
    } catch (e) { console.error('Health monitor error:', e.message); }
  }, HEARTBEAT_INTERVAL);

  // Track scan & trade times
  const originalCheckAndScan = checkAndScan;
  checkAndScan = async function(...args) {
    lastScanTime = Date.now();
    botState.scanCount = (botState.scanCount || 0) + 1;
    return originalCheckAndScan.apply(this, args);
  };

  const originalExecuteTrade = executeTrade;
  executeTrade = async function(...args) {
    const result = await originalExecuteTrade.apply(this, args);
    if (result) {
      lastTradeTime = Date.now();
      botState.tradeCount = (botState.tradeCount || 0) + 1;
      botState.health.lastTrade = Date.now();
      botState.health.lastProfit = args[2]; // betAmount
    }
    return result;
  };

  const originalKalshiRequest = kalshiRequest;
  kalshiRequest = async function(...args) {
    const result = await originalKalshiRequest.apply(this, args);
    if (!result) {
      botState.health.consecutiveErrors++;
      botState.health.apiErrors++;
    } else {
      botState.health.consecutiveErrors = 0;
    }
    return result;
  };

  botState.startTime = Date.now();
  botState.scanCount = 0;
  botState.tradeCount = 0;
  botState.health = { status: 'healthy', lastScan: 0, lastTrade: 0, apiErrors: 0, consecutiveErrors: 0 };
  
  console.log('💓 Health monitor active — heartbeat every 60s, alerts on issues');

loadState();
botState.isRunning = !NO_CREDENTIALS_MODE;  // Live scanning requires complete credentials
console.log(NO_CREDENTIALS_MODE
  ? '✅ Bot initialized in offline mode. Add real Telegram and Kalshi credentials to enable live scanning and trading.'
  : '✅ Bot initialized. Auto-started scanning.');
if (KALSHI_API_SECRET) {
  const firstLine = KALSHI_API_SECRET.split('\n')[0];
  const looksValid = firstLine.includes('BEGIN') && firstLine.includes('PRIVATE KEY');
  console.log(`🔑 Private key loaded: ${KALSHI_API_SECRET.length} chars, first line: "${firstLine}" — ${looksValid ? 'looks valid ✅' : 'DOES NOT LOOK RIGHT ❌'}`);
}
startMonitoring();

// Fetch live Kalshi balance on startup
(async () => {
  if (NO_CREDENTIALS_MODE) return;
  try {
    const bal = await getKalshiBalance();
    if (bal != null && isFinite(bal)) {
      botState.liveBalance = bal;
      console.log(`💰 Live Kalshi balance: $${bal.toFixed(4)}`);
    } else {
      console.log('⚠️ Could not fetch live Kalshi balance — using static bankroll $' + BANKROLL);
    }
  } catch (e) { console.log('⚠️ Balance fetch failed:', e.message); }
})();

// Fire an immediate scan on startup if already running
if (botState.isRunning) {
  (async () => {
    try {
      console.log('🚀 Final-minutes engine ready — scanning all crypto markets...');
      // Price scan only — trades will fire when final 5-min windows open
      const prices = await getAllSpotPrices();
      if (prices) for (const [asset, price] of Object.entries(prices)) { if (price) recordPrice(asset, price); }
      saveState();
      console.log('🚀 Price scan complete. Engine will enter when final 5-min windows open.');
    } catch (e) {
      console.error('Startup scan error:', e.message);
    }
  })();
}
