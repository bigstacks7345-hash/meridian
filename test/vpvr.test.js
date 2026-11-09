import test from "node:test";
import assert from "node:assert/strict";
import { volumeProfile } from "../strategy/indicators.js";
import { lockPoc } from "../strategy/rules.js";
import {
  birdeyeMarketData,
  buildBirdeyeOhlcvRequest,
  completed5m,
  createMarketData,
  fetchGmgn1m,
  parseBirdeyeOhlcv,
  parseGmgnKlines,
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
