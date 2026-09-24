#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const KNOWLEDGE_FILE = path.join(__dirname, 'bigs_wipe_knowledge.json');
const INTERVAL = 60_000;
let stopping = false;

async function json(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'BIGSWIPE-final/1.0' }, signal: AbortSignal.timeout(12_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 100)}`);
  return JSON.parse(text);
}

function candles(raw) {
  return raw.map(row => ({
    time: Number(row[0]) * 1000,
    high: Number(row[2]),
    low: Number(row[1]),
    close: Number(row[4]),
    volume: Number(row[5]) || 0
  })).sort((a, b) => a.time - b.time);
}

async function coinbase(seconds) {
  const raw = await json(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${seconds}`);
  return candles(raw);
}

async function kraken(minutes) {
  const response = await json(`https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=${minutes}`);
  const key = Object.keys(response.result || {}).find(name => name !== 'last');
  return (response.result?.[key] || []).map(row => ({
    time: Number(row[0]) * 1000, high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[6]) || 0
  }));
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) result = values[i] * multiplier + result * (1 - multiplier);
  return result;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i += 1) { const change = values[i] - values[i - 1]; gain += Math.max(change, 0); loss += Math.max(-change, 0); }
  let averageGain = gain / period, averageLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
}
function atr(rows, period = 14) {
  const ranges = [];
  for (let i = 1; i < rows.length; i += 1) ranges.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - rows[i - 1].close), Math.abs(rows[i].low - rows[i - 1].close)));
  return ranges.length >= period ? mean(ranges.slice(-period)) : null;
}
function analyze(rows) {
  if (rows.length < 60) return null;
  const close = rows.map(row => row.close);
  const price = close.at(-1);
  const e9 = ema(close, 9), e21 = ema(close, 21), e50 = ema(close, 50);
  const macd = ema(close, 12) - ema(close, 26);
  const band = mean(close.slice(-20));
  const deviation = Math.sqrt(mean(close.slice(-20).map(value => (value - band) ** 2)));
  const relativeStrength = rsi(close);
  let score = 0;
  score += e9 > e21 ? 1 : -1;
  score += e21 > e50 ? 1 : -1;
  score += macd > 0 ? 1 : -1;
  score += relativeStrength > 55 ? 1 : relativeStrength < 45 ? -1 : 0;
  score += price > band ? 1 : -1;
  const move = bars => close.length > bars ? (price / close.at(-(bars + 1)) - 1) * 100 : 0;
  return { price, e9, e21, e50, macd, rsi: relativeStrength, band, upper: band + deviation * 2, lower: band - deviation * 2, atr: atr(rows), return15: move(15), score, bias: score >= 3 ? 'UP' : score <= -3 ? 'DOWN' : 'MIXED' };
}

function readKnowledge() {
  try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8')); }
  catch (_) { return { predictions: [], settled: 0, correct: 0 }; }
}
function learn(report) {
  const knowledge = readKnowledge();
  const now = Date.now();
  for (const old of knowledge.predictions) {
    if (old.settled || now - old.time < 15 * 60 * 1000) continue;
    const change = report.price / old.price - 1;
    const actual = Math.abs(change) < 0.0005 ? 'MIXED' : change > 0 ? 'UP' : 'DOWN';
    old.settled = true; old.actual = actual; old.change = change;
    knowledge.settled += 1;
    if (actual === old.signal) knowledge.correct += 1;
  }
  const cycle = Math.floor(now / (15 * 60 * 1000));
  if (report.signal !== 'MIXED' && !knowledge.predictions.some(item => item.cycle === cycle)) knowledge.predictions.push({ cycle, time: now, price: report.price, signal: report.signal, settled: false });
  knowledge.predictions = knowledge.predictions.slice(-500);
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
  return knowledge;
}

function paperPlan(report) {
  if (report.signal === 'MIXED') return 'NO TRADE: mixed signal.';
  const range = Math.max(report.averageAtr * 0.75, report.price * 0.0015);
  const risk = Math.max(report.averageAtr * 0.5, report.price * 0.001);
  const target = report.signal === 'UP' ? report.price + range : report.price - range;
  const stop = report.signal === 'UP' ? report.price - risk : report.price + risk;
  const quantity = 100 / report.price;
  const profit = quantity * Math.abs(target - report.price);
  const loss = quantity * Math.abs(stop - report.price);
  return `${report.signal} paper only | entry $${report.price.toFixed(2)} | target $${target.toFixed(2)} | stop $${stop.toFixed(2)} | $100 size: +$${profit.toFixed(2)} target / -$${loss.toFixed(2)} stop | R:R ${(profit / loss).toFixed(2)}`;
}

async function cycle() {
  const jobs = [['CB 1m', () => coinbase(60), 1], ['CB 5m', () => coinbase(300), 2], ['CB 15m', () => coinbase(900), 3], ['Kraken 1m', () => kraken(1), 1], ['Kraken 5m', () => kraken(5), 2], ['Kraken 15m', () => kraken(15), 3]];
  const analyses = [];
  for (const [name, load, weight] of jobs) { try { const result = analyze(await load()); if (result) analyses.push({ name, weight, result }); } catch (error) { console.log(`${name} unavailable: ${error.message}`); } }
  if (!analyses.length) throw new Error('No public candle feeds available');
  const price = analyses[0].result.price;
  const weighted = analyses.reduce((sum, item) => sum + item.result.score * item.weight, 0) / analyses.reduce((sum, item) => sum + item.weight, 0);
  const signal = weighted >= 1.5 ? 'UP' : weighted <= -1.5 ? 'DOWN' : 'MIXED';
  const averageAtr = mean(analyses.map(item => item.result.atr).filter(Number.isFinite));
  const knowledge = learn({ price, signal, time: Date.now() });
  const accuracy = knowledge.settled ? `${(knowledge.correct / knowledge.settled * 100).toFixed(1)}%` : 'building';
  console.log(`\nETH 15-MIN PAPER CALL | ${new Date().toISOString()}`);
  console.log(`Signal: ${signal} | Score: ${weighted.toFixed(2)} | Feed agreement: ${analyses.filter(item => item.result.bias === signal).length}/${analyses.length}`);
  console.log(`Price: $${price.toFixed(2)} | Knowledge: ${knowledge.settled} settled, accuracy ${accuracy}`);
  for (const item of analyses) console.log(`${item.name.padEnd(10)} ${item.result.bias.padEnd(5)} RSI ${item.result.rsi.toFixed(1)} | EMA9/21 ${item.result.e9.toFixed(2)}/${item.result.e21.toFixed(2)} | 15m ${item.result.return15.toFixed(3)}%`);
  console.log(`PAPER ENTRY / EXIT: ${paperPlan({ signal, price, averageAtr })}`);
  console.log('No orders, notifications, or private keys are used.');
}

async function run() { try { await cycle(); } catch (error) { console.error(`Cycle failed: ${error.message}`); } if (!stopping && !process.argv.includes('--once')) setTimeout(run, INTERVAL); }
process.on('SIGINT', () => { stopping = true; console.log('\nStopped.'); });
process.on('SIGTERM', () => { stopping = true; });
console.log('BIGSWIPE FINAL: keyless ETH paper predictor');
run();
