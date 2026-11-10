import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { supertrend, volumeProfile } from "../strategy/indicators.js";
import { lockPoc, selectProfileWindow } from "../strategy/rules.js";
import {
  birdeyeMarketData,
  buildBirdeyeOhlcvRequest,
  completed5m,
  createMarketData,
  fetchGmgn1m,
  fetchQuoteGmgn1m,
  parseBirdeyeOhlcv,
  parseGmgnKlines,
  toQuoteCandles,
} from "../strategy/market-data.js";
import { OWNER_STRATEGY } from "../strategy/defaults.js";

test("proportional 1m bars match a hand-computed TradingView VPVR", () => {
  // Range 0..4, four rows. Bar volumes are split by overlap, then the value
  // area stops before a row would carry the covered total past 70% of 24.
  const candles = [
    { t: 0, o: 0.2, h: 2, l: 0, c: 1.8, v: 10 },
    { t: 60_000, o: 2.8, h: 3, l: 1, c: 1.2, v: 6 },
    { t: 120_000, o: 2.1, h: 4, l: 2, c: 3.9, v: 8 },
  ];
  const profile = volumeProfile(candles, { rows: 4, valueArea: 0.7 });
  assert.equal(profile.label, "TradingView-VPVR-equivalent");
  assert.equal(profile.method, "tradingview-vpvr");
  assert.deepEqual(profile.rows.map(row => row.up), [5, 5, 4, 4]);
  assert.deepEqual(profile.rows.map(row => row.down), [0, 3, 3, 0]);
  assert.deepEqual(profile.rows.map(row => row.total), [5, 8, 7, 4]);
  assert.equal(profile.pocRow, 1);
  assert.equal(profile.poc, 1.5);
  assert.equal(profile.valueAreaLow, 1);
  assert.equal(profile.valueAreaHigh, 3);
  assert.equal(profile.coveredVolume, 15);
  assert.equal(profile.totalVolume, 24);
});

test("equal candidates use TradingView tie breaks and do not overshoot 70%", () => {
  // A zero-volume bar fixes the 0..5 range. Point bars put 4, 4, 10, 4, 4
  // into the five rows. Target is 18.2. The first tie is the same distance
  // from the POC, so the row above is added. The next tie is closer below,
  // so row 1 is added and row 4 stays outside. The last row of 4 would pass
  // the remaining 0.2 and is refused.
  const candles = [
    { t: 0, o: 0, h: 5, l: 0, c: 0, v: 0 },
    { t: 60_000, o: 0.5, h: 0.5, l: 0.5, c: 0.5, v: 4 },
    { t: 120_000, o: 1.5, h: 1.5, l: 1.5, c: 1.5, v: 4 },
    { t: 180_000, o: 2.5, h: 2.5, l: 2.5, c: 2.5, v: 10 },
    { t: 240_000, o: 3.5, h: 3.5, l: 3.5, c: 3.5, v: 4 },
    { t: 300_000, o: 4.5, h: 4.5, l: 4.5, c: 4.5, v: 4 },
  ];
  const profile = volumeProfile(candles, { rows: 5, valueArea: 0.7 });
  assert.deepEqual(profile.rows.map(row => row.total), [4, 4, 10, 4, 4]);
  assert.equal(profile.poc, 2.5);
  assert.equal(profile.valueAreaLow, 1);
  assert.equal(profile.valueAreaHigh, 4);
  assert.equal(profile.coveredVolume, 18);
});

test("a tied POC keeps the lower row", () => {
  const candles = [
    { t: 0, o: 0, h: 2, l: 0, c: 0, v: 0 },
    { t: 60_000, o: 0.5, h: 0.5, l: 0.5, c: 0.5, v: 5 },
    { t: 120_000, o: 1.5, h: 1.5, l: 1.5, c: 1.5, v: 5 },
  ];
  const profile = volumeProfile(candles, { rows: 2, valueArea: 0.7 });
  assert.equal(profile.pocRow, 0);
  assert.equal(profile.poc, 0.5);
});

test("POC is locked only when it is more than 60% below entry", () => {
  const rules = OWNER_STRATEGY;
  const deep = lockPoc({ poc: 39, method: "tradingview-vpvr" }, 100, rules);
  const shallow = lockPoc({ poc: 40, method: "tradingview-vpvr" }, 100, rules);
  assert.equal(deep.valid, true);
  assert.equal(shallow.valid, false);
  assert.match(shallow.reason, /ignored/);
});

test("GMGN pagination walks backwards, paces a 5-credit window, and stops on 429", async () => {
  const rules = { ...OWNER_STRATEGY, gmgnPageBars: 10, gmgnCreditLimit: 5, gmgnWindowMs: 1000, gmgnCandleCreditCost: 2 };
  const from = 0;
  const to = 25 * 60_000;
  const calls = [];
  let clock = 10_000;
  const sleeps = [];
  function candlesBetween(start, end) {
    const list = [];
    for (let t = start; t < end; t += 60_000) {
      list.push({ time: t / 1000, open: "1", high: "2", low: "1", close: "1.5", volume: "9", amount: "3" });
    }
    return { list };
  }
  const ok = await fetchGmgn1m({
    rules,
    mint: "Mint",
    from,
    to,
    apiKey: "test-key",
    now: () => clock,
    sleep: ms => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    fetchImpl: async url => {
      calls.push(String(url));
      const query = new URL(url).searchParams;
      assert.equal(query.get("resolution"), "1m");
      assert.equal(query.get("chain"), "sol");
      return { ok: true, status: 200, json: async () => candlesBetween(Number(query.get("from")), Number(query.get("to"))) };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.candles.length, 25);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("from=900000"));
  assert.ok(calls[0].includes("to=1500000"));
  assert.ok(calls[2].includes("from=0"));
  assert.deepEqual(sleeps, [1000]);
  const parsed = parseGmgnKlines({ list: [{ time: 60, open: "1", high: "1", low: "1", close: "1", volume: "8", amount: "4" }] });
  assert.equal(parsed.candles[0].v, 8);

  let fetches = 0;
  const stopped = await fetchGmgn1m({
    rules,
    mint: "Mint",
    from,
    to,
    apiKey: "test-key",
    deadline: 1,
    now: () => 0,
    sleep: () => Promise.resolve(),
    fetchImpl: async () => {
      fetches += 1;
      const status = fetches === 2 ? 429 : 200;
      return { ok: status === 200, status, json: async () => ({ list: [] }) };
    },
  });
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason, /429/);
  assert.equal(fetches, 2);
});

test("a missing minute fails closed", async () => {
  const rules = { ...OWNER_STRATEGY, gmgnPageBars: 10 };
  const result = await fetchGmgn1m({
    rules,
    mint: "Mint",
    from: 0,
    to: 3 * 60_000,
    apiKey: "test-key",
    now: () => 0,
    sleep: () => Promise.resolve(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ list: [
        { time: 0, open: "1", high: "1", low: "1", close: "1", volume: "1", amount: "9" },
        { time: 120, open: "1", high: "1", low: "1", close: "1", volume: "1", amount: "9" },
      ] }),
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /gap|incomplete/);
});

test("GMGN volume is USD notional and amount is token units", () => {
  const sample = {
    time: 1794140400000,
    open: "89.51997818",
    close: "89.5411681",
    high: "90.011559386",
    low: "89.11698592",
    volume: "347014.88535799",
    amount: "3877.094302135",
  };
  const parsed = parseGmgnKlines({ list: [sample] });
  assert.equal(parsed.ok, true);
  const candle = parsed.candles[0];
  assert.equal(candle.v, 347014.88535799);
  assert.notEqual(candle.v, 3877.094302135);
  const ratio = candle.v / Number(sample.amount);
  assert.ok(Math.abs(ratio - Number(sample.close)) < 0.05, `volume/amount ${ratio} should track the SOL price`);
  const profile = volumeProfile([candle], { rows: 4, valueArea: 0.7 });
  assert.ok(Math.abs(profile.totalVolume - candle.v) < 1e-6);
  const five = Array.from({ length: 5 }, (_, index) => ({ ...candle, t: candle.t + index * 60_000 }));
  const bar = completed5m(five).at(-1);
  assert.equal(bar.v, candle.v * 5);
  assert.ok(bar.v >= 90_000);
});

test("SOL-quoted POC and Supertrend move when SOL/USD moves and USD price does not", () => {
  const count = 16;
  const token = [];
  const solFlat = [];
  const solRising = [];
  for (let i = 0; i < count; i++) {
    const t = i * 60_000;
    token.push({ t, o: 10, h: 10.2, l: 9.8, c: 10, v: i === 0 ? 1_000 : 1 });
    solFlat.push({ t, o: 100, h: 100, l: 100, c: 100, v: 1 });
    const sol = 100 + i * 10;
    solRising.push({ t, o: sol, h: sol, l: sol, c: sol, v: 1 });
  }
  const flat = toQuoteCandles(token, solFlat);
  const moved = toQuoteCandles(token, solRising);
  assert.equal(flat.ok, true);
  assert.equal(moved.ok, true);
  assert.equal(flat.candles[0].c, 0.1);
  assert.equal(flat.candles.at(-1).c, 0.1);
  assert.ok(moved.candles.at(-1).c < flat.candles.at(-1).c);
  assert.equal(flat.candles[0].v, 1_000);
  assert.equal(moved.candles[0].v, 1_000);
  const flatProfile = volumeProfile(flat.candles, { rows: 4, valueArea: 0.7 });
  const movedProfile = volumeProfile(moved.candles, { rows: 4, valueArea: 0.7 });
  const flatTrend = supertrend(flat.candles, { atrLength: 3, factor: 3 });
  const movedTrend = supertrend(moved.candles, { atrLength: 3, factor: 3 });
  assert.ok(Math.abs(flatProfile.poc - 0.1) < 0.02);
  assert.ok(movedProfile.poc < flatProfile.poc);
  assert.notEqual(movedTrend.value, flatTrend.value);
  assert.equal(movedTrend.trend, "down");
  const shifted = solRising.map((candle, index) => index === count - 1 ? { ...candle, t: candle.t + 60_000 } : candle);
  assert.equal(toQuoteCandles(token, shifted).ok, false);
});

test("quote candle fetch pages the token and wrapped SOL on one credit budget", async () => {
  const rules = { ...OWNER_STRATEGY, gmgnPageBars: 10, gmgnCreditLimit: 5, gmgnWindowMs: 1000, gmgnCandleCreditCost: 2 };
  const calls = [];
  let clock = 0;
  const sleeps = [];
  const result = await fetchQuoteGmgn1m({
    rules,
    mint: "TokenMint",
    from: 0,
    to: 25 * 60_000,
    apiKey: "test-key",
    now: () => clock,
    sleep: ms => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    fetchImpl: async url => {
      const query = new URL(url).searchParams;
      calls.push(query.get("address"));
      const start = Number(query.get("from"));
      const end = Number(query.get("to"));
      const list = [];
      for (let t = start; t < end; t += 60_000) {
        const sol = query.get("address") === rules.quoteMint;
        list.push({ time: t / 1000, open: sol ? "100" : "10", high: sol ? "100" : "11", low: sol ? "100" : "9", close: sol ? "100" : "10", volume: "5", amount: "1" });
      }
      return { ok: true, status: 200, json: async () => ({ list }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.priceDenomination, "quote");
  assert.equal(result.candles[0].c, 0.1);
  assert.equal(result.candles[0].v, 5);
  assert.equal(calls.filter(address => address === "TokenMint").length, 3);
  assert.equal(calls.filter(address => address === rules.quoteMint).length, 3);
  assert.ok(sleeps.length >= 1);
});

test("AIcoin full-life SOL profile matches the GMGN chart row", () => {
  const bars = JSON.parse(fs.readFileSync(new URL("./fixtures/aicoin-1m-sol.json", import.meta.url), "utf8"));
  const createdAt = bars[0].t;
  const window = selectProfileWindow(bars, {
    createdAt,
    asOf: bars.at(-1).t + 60_000,
    lookbackMs: 24 * 3_600_000,
    toleranceMs: 60_000,
  });
  assert.equal(window.ok, true);
  assert.equal(window.young, true);
  assert.equal(window.candles.length, 144);
  const profile = volumeProfile(window.candles, { rows: 24, valueArea: 0.7 });
  const row = profile.rows[profile.pocRow];
  assert.ok(Math.abs(profile.poc - 0.000001239) < 5e-10);
  assert.ok(Math.abs(row.low - 0.000001131) < 5e-9);
  assert.ok(Math.abs(row.high - 0.000001348) < 5e-9);
  const clipped = bars.slice(40);
  const missingLaunch = selectProfileWindow(clipped, {
    createdAt,
    asOf: bars.at(-1).t + 60_000,
    lookbackMs: 24 * 3_600_000,
    toleranceMs: 60_000,
  });
  assert.equal(missingLaunch.ok, false);
  assert.match(missingLaunch.reason, /launch/);
});

test("Birdeye adapter is configurable, stubbed, and sends no API key", async () => {
  const request = buildBirdeyeOhlcvRequest({
    address: "Mint",
    timeFromSec: 100,
    timeToSec: 200,
  });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/defi/v3/ohlcv");
  assert.equal(url.searchParams.get("type"), "1m");
  assert.equal(url.searchParams.get("time_from"), "100");
  assert.equal(url.searchParams.get("time_to"), "200");
  assert.equal(request.headers["X-API-KEY"], undefined);
  assert.equal(request.maxBars, 5000);
  const provider = birdeyeMarketData({ ...OWNER_STRATEGY, candleProvider: "birdeye" });
  assert.deepEqual(await provider.snapshot("Mint"), { ok: false, reason: "birdeye adapter is stubbed" });
  const parsed = parseBirdeyeOhlcv({ data: { items: [{ unix_time: 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] } });
  assert.equal(parsed.candles[0].t, 60_000);
  assert.equal(parsed.candles[0].v, 10);
  assert.equal(createMarketData(OWNER_STRATEGY).id, "none");
});
