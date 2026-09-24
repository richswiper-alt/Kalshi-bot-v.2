#!/usr/bin/env node
'use strict';

const INTERVAL_MS = 60_000;
const USER_AGENT = 'kalshi-bot-keyless-paper-predictor/1.0';
let stopping = false;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

function candle(time, open, high, low, close, volume) {
  return { time: Number(time) * 1000, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) || 0 };
}

async function coinbase(granularity) {
  const rows = await getJson(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${granularity}`);
  return rows.map(row => candle(row[0], row[3], row[2], row[1], row[4], row[5])).sort((a, b) => a.time - b.time);
}

async function kraken(interval) {
  const response = await getJson(`https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=${interval}`);
  const key = Object.keys(response.result || {}).find(name => name !== 'last');
  return (response.result?.[key] || []).map(row => candle(row[0], row[1], row[2], row[3], row[4], row[6]));
}

async function bitstamp(step) {
  const response = await getJson(`https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=${step}&limit=200`);
  return (response.data?.ohlc || []).map(row => candle(row.timestamp, row.open, row.high, row.low, row.close, row.volume));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result = values[index] * multiplier + result * (1 - multiplier);
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(rows, period = 14) {
  if (rows.length <= period) return null;
  const ranges = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close)));
  }
  return mean(ranges.slice(-period));
}

function analyze(rows) {
  if (!rows || rows.length < 60) return null;
  const closes = rows.map(row => row.close);
  const price = closes.at(-1);
  const fast = ema(closes, 9);
  const medium = ema(closes, 21);
  const slow = ema(closes, 50);
  const macd = ema(closes, 12) - ema(closes, 26);
  const middleBand = mean(closes.slice(-20));
  const deviation = standardDeviation(closes.slice(-20));
  const upperBand = middleBand + deviation * 2;
  const lowerBand = middleBand - deviation * 2;
  const relativeStrength = rsi(closes);
  let score = 0;
  if (fast > medium) score += 1; else score -= 1;
  if (medium > slow) score += 1; else score -= 1;
  if (macd > 0) score += 1; else score -= 1;
  if (relativeStrength > 55) score += 1;
  else if (relativeStrength < 45) score -= 1;
  if (price > middleBand) score += 1; else score -= 1;
  const returnFor = bars => closes.length > bars ? (price / closes.at(-(bars + 1)) - 1) * 100 : null;
  return {
    time: new Date(rows.at(-1).time).toISOString(),
    price,
    ema9: fast,
    ema21: medium,
    ema50: slow,
    rsi14: relativeStrength,
    macd,
    bbUpper: upperBand,
    bbLower: lowerBand,
    atr14: atr(rows),
    return15: returnFor(15),
    return30: returnFor(30),
    score,
    bias: score >= 3 ? 'UP' : score <= -3 ? 'DOWN' : 'MIXED'
  };
}

function normalizeKalshiMarket(raw) {
  const yes = Number(raw?.yes_ask_dollars ?? raw?.yes_bid_dollars ?? 0);
  const no = Number(raw?.no_ask_dollars ?? raw?.no_bid_dollars ?? 0);
  const floorStrike = Number(raw?.floor_strike ?? 0);
  const topProb = Math.max(yes, no);
  const side = yes >= no ? 'YES' : 'NO';
  return {
    ticker: raw?.ticker ?? '',
    title: raw?.title || raw?.name || '',
    eventTicker: raw?.event_ticker ?? '',
    closeTime: raw?.close_time ?? '',
    status: raw?.status ?? '',
    yes,
    no,
    topProb,
    side,
    floorStrike,
    volume: Number(raw?.volume_24h_fp ?? raw?.volume_fp ?? 0),
    liquidity: Number(raw?.liquidity_dollars ?? 0),
    lastPrice: Number(raw?.last_price_dollars ?? 0),
    spread: Math.abs(yes - no)
  };
}

async function loadKalshiSeriesMarkets(seriesTicker) {
  const data = await getJson(`https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open&limit=100`);
  return (data?.markets || []).map(normalizeKalshiMarket);
}

async function buildHighOutcomeSummary() {
  const series = ['KXETH15M', 'KXBTC15M', 'KXETH30M', 'KXBTC30M', 'KXETH1H', 'KXBTC1H', 'KXXRP15M', 'KXSOL15M'];
  const ranked = [];
  for (const seriesTicker of series) {
    try {
      const markets = await loadKalshiSeriesMarkets(seriesTicker);
      ranked.push(...markets.filter(m => m.ticker && (m.yes > 0.05 || m.no > 0.05)));
    } catch (error) {
      // Fail closed: continue without blocking the market report.
    }
  }

  const sorted = ranked.sort((a, b) => (b.topProb - a.topProb) || (b.volume - a.volume));
  const top = sorted[0] || null;
  const bestScalperEntry = top ? (() => {
    const side = top.side;
    const entryTarget = side === 'YES' ? Math.min(0.48, Math.max(0.38, top.yes - 0.05)) : Math.min(0.48, Math.max(0.38, top.no - 0.05));
    return `${side} only if it dips to about ${entryTarget.toFixed(2)} and holds; avoid chasing near ${Math.max(top.yes, top.no).toFixed(2)} when the spread is dead flat.`;
  })() : 'No live accessible market found right now. Wait for a fresh directional move away from mid.';

  const bestExit = top ? (() => {
    const side = top.side;
    const target = side === 'YES' ? top.yes + 0.03 : top.no + 0.03;
    const hardStop = side === 'YES' ? top.yes - 0.02 : top.no - 0.02;
    return `${side} first target: ${Math.min(target, 0.95).toFixed(2)}; hard stop: ${Math.max(hardStop, 0.05).toFixed(2)}. Exit after the first 60-180s directional push or when momentum stalls.`;
  })() : 'No exit edge available without a fresh market move.';

  const multiplierTiming = top ? (() => {
    const side = top.side;
    const buyPrice = side === 'YES' ? Math.min(top.yes, 0.6) : Math.min(top.no, 0.6);
    return `Best multiplier / higher-yield buy window is when ${side} is temporarily discounted below 0.60, especially in the first 0-5 minutes after a breakout or after a sharp flush that restores trend. Do not chase it near 0.50-0.52 unless momentum is confirmed.`;
  })() : 'No high-yield buy setup available right now. Wait for a fresh breakout/dislocation.';

  const topList = sorted.slice(0, 5).map((m, index) => {
    const side = m.side;
    const prob = Math.max(m.yes, m.no);
    return `${index + 1}. ${m.ticker} | ${side} ${Math.max(m.yes, m.no).toFixed(2)} | NO ${m.no.toFixed(2)} | YES ${m.yes.toFixed(2)} | ${m.title || 'market'} ${m.closeTime ? `| closes ${m.closeTime.slice(11, 16)}Z` : ''}`.trim();
  });

  return {
    top,
    ranked: sorted,
    summary: {
      bestScalperEntry,
      bestExit,
      multiplierTiming,
      topList
    }
  };
}

async function collect() {
  const jobs = [
    ['Coinbase 1m', () => coinbase(60), 1],
    ['Coinbase 5m', () => coinbase(300), 2],
    ['Coinbase 15m', () => coinbase(900), 3],
    ['Kraken 1m', () => kraken(1), 1],
    ['Kraken 5m', () => kraken(5), 2],
    ['Kraken 15m', () => kraken(15), 3],
    ['Bitstamp 1m', () => bitstamp(60), 1]
  ];
  const analyses = [];
  const failures = [];
  for (const [name, load, weight] of jobs) {
    try {
      const result = analyze(await load());
      if (result) analyses.push({ name, weight, result });
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  let spot = null;
  let dayChange = null;
  let derivatives = null;
  try {
    const quote = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true');
    spot = quote.ethereum?.usd ?? null;
    dayChange = quote.ethereum?.usd_24h_change ?? null;
  } catch (error) {
    failures.push(`CoinGecko: ${error.message}`);
  }
  try {
    const ticker = await getJson('https://www.deribit.com/api/v2/public/ticker?instrument_name=ETH-PERPETUAL');
    derivatives = {
      index: ticker.result?.index_price,
      change24h: ticker.result?.stats?.price_change,
      openInterest: ticker.result?.open_interest,
      funding8h: ticker.result?.funding_8h
    };
  } catch (error) {
    failures.push(`Deribit: ${error.message}`);
  }

  const kalshiSummary = await buildHighOutcomeSummary().catch(() => ({ summary: { bestScalperEntry: 'Kalshi market summary unavailable right now.', bestExit: 'No exit edge available right now.', multiplierTiming: 'No high-yield timing available right now.', topList: [] } }));

  const weightedScore = analyses.reduce((sum, item) => sum + item.result.score * item.weight, 0);
  const weightTotal = analyses.reduce((sum, item) => sum + item.weight, 0);
  const score = weightTotal ? weightedScore / weightTotal : 0;
  const prediction = score >= 1.5 ? 'UP' : score <= -1.5 ? 'DOWN' : 'MIXED';
  const agreement = analyses.filter(item => item.result.bias === prediction).length;
  return { generatedAt: new Date().toISOString(), prediction, score, agreement, spot, dayChange, derivatives, analyses, failures, kalshiSummary };
}

function print(report) {
  console.log(`\nETH 15-MIN PAPER PREDICTION | ${report.generatedAt}`);
  console.log(`Prediction: ${report.prediction} | Weighted score: ${report.score.toFixed(2)} | Agreement: ${report.agreement}/${report.analyses.length}`);
  if (report.spot != null) console.log(`Spot: $${report.spot.toFixed(2)} | 24h: ${report.dayChange?.toFixed(2)}%`);
  if (report.derivatives?.index != null) console.log(`Deribit index: $${report.derivatives.index.toFixed(2)} | OI: ${report.derivatives.openInterest ?? 'n/a'} | 8h funding: ${report.derivatives.funding8h ?? 'n/a'}`);
  for (const item of report.analyses) {
    const value = item.result;
    console.log(`${item.name.padEnd(16)} ${value.bias.padEnd(5)} RSI ${value.rsi14.toFixed(1).padStart(5)} | EMA9/21 ${value.ema9.toFixed(1)}/${value.ema21.toFixed(1)} | 15m ${value.return15.toFixed(3)}%`);
  }
  if (report.kalshiSummary?.summary) {
    console.log('\nSCALPER / MULTIPLIER MARKET SUMMARY');
    console.log(`BEST ENTRY: ${report.kalshiSummary.summary.bestScalperEntry}`);
    console.log(`BEST EXIT: ${report.kalshiSummary.summary.bestExit}`);
    console.log(`BEST MULTIPLIER / YIELD TIMING: ${report.kalshiSummary.summary.multiplierTiming}`);
    if (report.kalshiSummary.summary.topList.length) {
      console.log('TOP HIGH-PROBABILITY MARKETS');
      for (const line of report.kalshiSummary.summary.topList) console.log(`  ${line}`);
    }
  }
  if (report.failures.length) console.log(`Unavailable: ${report.failures.join(' | ')}`);
  console.log('Paper analysis only. No orders, Telegram messages, or authenticated APIs are used.');
}

async function run() {
  try {
    print(await collect());
  } catch (error) {
    console.error(`Prediction cycle failed: ${error.message}`);
  }
  if (!stopping && !process.argv.includes('--once')) setTimeout(run, INTERVAL_MS);
}

process.on('SIGINT', () => { stopping = true; console.log('\nStopped.'); });
process.on('SIGTERM', () => { stopping = true; });
console.log('Starting keyless ETH prediction service. Press Ctrl+C to stop.');
run();
