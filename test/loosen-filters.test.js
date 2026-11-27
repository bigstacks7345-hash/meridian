import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { chooseIndicatorCandles, evaluateEntry, formatScreenSummary } from "../strategy/rules.js";
import { createRequestBudget, fetchGmgn1m, fetchTokenCreatedAt } from "../strategy/market-data.js";
import { enrichMissingMarket, fillMissingMarket, parseDexScreener, parseMeteoraPools } from "../strategy/pool-fallbacks.js";
import { MonitorStore } from "../standalone/store.js";
import { ingestFabriqAlerts, resetPursuitDeps, setPursuitDeps, signalPursuitSettled, useRuntimeStore } from "../standalone/runtime.js";
import { parseFabriqPage } from "../standalone/fabriq.js";

const rules = OWNER_STRATEGY;
const sol = rules.quoteMint;

function bar(t, price, volume = 1_000) {
  return { t, o: price, h: price + 0.2, l: price - 0.05, c: price + 0.1, v: volume };
}

function rising(count, step, start, volumeStart = 1_000) {
  return Array.from({ length: count }, (_, index) => bar(index * step, start + index * 0.2, volumeStart + index * 50));
}

function priced(extra = {}) {
  return {
    ok: true,
    priceDenomination: "quote",
    binStep: 100,
    liquidityUsd: 50_000,
    poolLiquidityUsd: 50_000,
    poolVolume5mUsd: 20_000,
    mcapUsd: 400_000,
    holders: 2_000,
    livePrice: 20,
    ...extra,
  };
}

test("the 5m volume floor is $30k and holders do not block", () => {
  const closed5m = [{ t: 0, v: 30_000 }];
  const one = rising(40, 60_000, 10, 100);
  const snapshot = priced({
    closed1m: one,
    current1m: bar(40 * 60_000, 18, 5_000),
    closed5m,
    livePrice: 18.1,
    createdAt: one[0].t,
    asOf: 40 * 60_000,
  });
  const atFloor = evaluateEntry(snapshot, rules);
  assert.equal(atFloor.display.checks.vol5m, "pass", atFloor.reasons.join("; "));
  const below = evaluateEntry({ ...snapshot, closed5m: [{ t: 0, v: 29_999 }] }, rules);
  assert.ok(below.reasons.some(reason => reason.includes("29999") && reason.includes("30000")));
  const missingHolders = evaluateEntry({ ...snapshot, holders: null }, rules);
  assert.equal(missingHolders.display.checks.holders, "skip");
  assert.equal(missingHolders.reasons.some(reason => reason.includes("holders")), false);
  const required = evaluateEntry({ ...snapshot, holders: null }, { ...rules, holdersRequired: true });
  assert.ok(required.reasons.some(reason => reason.includes("holders unavailable")));
});

test("incomplete 1m history does not skip, and a short history uses 5m candles", () => {
  const one = rising(40, 60_000, 10);
  const asOf = one.at(-1).t + 60_000;
  const old = evaluateEntry(priced({
    closed1m: one,
    current1m: bar(asOf, 18, 4_000),
    closed5m: [{ t: 0, v: 40_000 }],
    livePrice: 18.2,
    createdAt: asOf - 48 * 3_600_000,
    asOf,
  }), rules);
  assert.equal(old.display.checks.poc, "skip");
  assert.match(old.display.pocNote, /incomplete/);
  assert.equal(old.reasons.some(reason => reason.includes("1m history incomplete")), false);

  const five = rising(24, 300_000, 10, 100);
  const short = priced({
    closed1m: rising(10, 60_000, 10),
    closed5m: five,
    current1m: null,
    livePrice: five.at(-1).c + 0.1,
    createdAt: five[0].t,
    asOf: five.at(-1).t + 300_000,
  });
  const chosen = chooseIndicatorCandles(short, rules);
  assert.equal(chosen.timeframe, "5m");
  assert.equal(chosen.fallback, true);
  const decision = evaluateEntry(short, rules);
  assert.equal(decision.display.indicatorTimeframe, "5m");
  assert.equal(decision.reasons.some(reason => reason.includes("1m history incomplete")), false);
  assert.equal(decision.reasons.some(reason => reason.includes("1m Supertrend")), false);

  const empty = evaluateEntry(priced({ closed1m: [], closed5m: [], current1m: null, livePrice: 1 }), rules);
  assert.ok(empty.reasons.some(reason => reason === "no candles"));
  assert.match(formatScreenSummary("MintExample", empty, { gmgnCalls: 2 }), /fail/);
  assert.match(formatScreenSummary("MintExample", empty, { gmgnCalls: 2 }), /gmgnCalls=2/);

  const youngStart = Date.parse("2026-11-20T00:00:00Z");
  const youngBars = rising(20, 60_000, 10).map((candle, index) => ({ ...candle, t: youngStart + (index + 10) * 60_000 }));
  const young = evaluateEntry(priced({
    closed1m: youngBars,
    closed5m: [{ t: youngBars[0].t, v: 40_000 }],
    current1m: null,
    livePrice: youngBars.at(-1).c,
    createdAt: youngStart,
    asOf: youngBars.at(-1).t + 60_000,
  }), rules);
  assert.ok(young.reasons.some(reason => reason.includes("launch")));
});

test("Meteora and DexScreener fill only the missing pool fields", async () => {
  const mint = "MintFallback111111111111111111111111111111";
  const meteora = parseMeteoraPools({
    data: [
      { token_x: { address: mint }, token_y: { address: sol }, tvl: 12_000, dlmm_params: { bin_step: 80 }, pool_price: 0.4, volume: 9_000, pool_address: "PoolSmall" },
      { token_x: { address: mint }, token_y: { address: sol }, tvl: 40_000, dlmm_params: { bin_step: 100 }, pool_price: 0.5, volume: 20_000, pool_address: "PoolBig" },
    ],
  }, mint, sol);
  assert.equal(meteora.poolAddress, "PoolBig");
  assert.equal(meteora.binStep, 100);
  const dex = parseDexScreener({
    pairs: [
      { chainId: "solana", baseToken: { address: mint }, quoteToken: { address: "usdc" }, priceNative: "2", marketCap: 10, liquidity: { usd: 1 } },
      { chainId: "solana", baseToken: { address: mint }, quoteToken: { address: sol }, priceNative: "0.5", marketCap: 450_000, liquidity: { usd: 30_000 } },
    ],
  }, mint, sol);
  assert.equal(dex.mcapUsd, 450_000);
  assert.equal(dex.livePrice, 0.5);
  const kept = fillMissingMarket({ binStep: 125, liquidityUsd: null, livePrice: null, mcapUsd: null }, { meteora, dex });
  assert.equal(kept.binStep, 125);
  assert.equal(kept.liquidityUsd, 40_000);
  assert.equal(kept.marketSources.liquidityUsd, "meteora");
  assert.equal(kept.mcapUsd, 450_000);
  assert.equal(kept.marketSources.mcapUsd, "dexscreener");

  const calls = [];
  const filled = await enrichMissingMarket({
    ok: true,
    binStep: null,
    liquidityUsd: null,
    livePrice: null,
    mcapUsd: null,
  }, {
    mint,
    solMint: sol,
    meteoraPoolsUrl: "https://dlmm.example/pools",
    dexscreenerTokensUrl: "https://dex.example/tokens",
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).includes("dlmm.example")) {
        return { ok: true, json: async () => ({ data: [{ token_x: { address: mint }, token_y: { address: sol }, tvl: 22_000, bin_step: 80, pool_price: 0.2, pool_address: "PoolA" }] }) };
      }
      return { ok: true, json: async () => ({ pairs: [{ chainId: "solana", baseToken: { address: mint }, quoteToken: { address: sol }, priceNative: "0.2", marketCap: 360_000, liquidity: { usd: 22_000 } }] }) };
    },
  });
  assert.equal(filled.binStep, 80);
  assert.equal(filled.mcapUsd, 360_000);
  assert.equal(filled.marketSources.binStep, "meteora");
  assert.equal(filled.marketSources.mcapUsd, "dexscreener");
  assert.equal(calls.length, 2);
  const already = await enrichMissingMarket({ ok: true, binStep: 100, liquidityUsd: 10_000, livePrice: 1, mcapUsd: 400_000 }, {
    mint,
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  assert.equal(already.binStep, 100);
});

test("Meteora datapi rows with pool_config.bin_step and windowed volume fill bin step", async () => {
  const mint = "81TW4gTEH4aNsSaKCoBhoznx9AG8AiYoBXfvEzJkpump";
  const sol = "So11111111111111111111111111111111111111112";
  // Shape returned by dlmm.datapi.meteora.ag/pools on 2026-11-27.
  const row = {
    address: "CLjyfDdfVi9KFD4UEixM2UoMzvgXwjmyxT3LwxsSKYRp",
    token_x: { address: mint }, token_y: { address: sol },
    tvl: 18_500, current_price: 5.97e-7,
    volume: { "30m": 4_000, "1h": 9_000, "24h": 10_551 },
    pool_config: { bin_step: 100, base_fee_pct: 2 },
  };
  const parsed = parseMeteoraPools({ data: [row] }, mint, sol);
  assert.equal(parsed.binStep, 100);
  assert.equal(parsed.liquidityUsd, 18_500);
  assert.equal(parsed.poolAddress, row.address);
  assert.equal(parsed.volume5mUsd, null, "no 5m window in the object means unknown, not NaN");
  assert.equal(parseMeteoraPools({ data: [{ ...row, volume: { "5m": 1_200 } }] }, mint, sol).volume5mUsd, 1_200);

  const filled = await enrichMissingMarket({ ok: true, binStep: null, liquidityUsd: null, livePrice: null, mcapUsd: null }, {
    mint, solMint: sol,
    meteoraPoolsUrl: "https://dlmm.example/pools",
    dexscreenerTokensUrl: "https://dex.example/tokens",
    fetchImpl: async url => String(url).includes("dlmm.example")
      ? { ok: true, json: async () => ({ data: [row] }) }
      : { ok: false, status: 429 },
  });
  assert.equal(filled.binStep, 100);
  assert.equal(filled.marketSources.binStep, "meteora");
  assert.deepEqual(filled.fallbackErrors, ["dexscreener: status 429"], "a failed fallback is reported, not swallowed");
});

test("GMGN caches token info for 30 minutes and klines for 60 seconds, and a 429 is queued", async () => {
  const cache = new Map();
  let clock = 1_000_000;
  let infoCalls = 0;
  const info = {
    rules,
    mint: "MintInfo",
    apiKey: "secret-key",
    budget: createRequestBudget({ ...rules, gmgnCreditLimit: 5, gmgnWindowMs: 1000 }),
    cache,
    now: () => clock,
    sleep: async () => {},
    fetchImpl: async () => {
      infoCalls += 1;
      return { ok: true, status: 200, json: async () => ({ creation_timestamp: 10 }) };
    },
  };
  assert.equal((await fetchTokenCreatedAt(info)).ok, true);
  assert.equal((await fetchTokenCreatedAt(info)).createdAt, 10_000);
  assert.equal(infoCalls, 1);
  clock += 30 * 60 * 1000;
  await fetchTokenCreatedAt(info);
  assert.equal(infoCalls, 2);

  let klineCalls = 0;
  const klineCache = new Map();
  const calls = { n: 0 };
  const kline = {
    rules: { ...rules, gmgnPageBars: 10, gmgnCandleCreditCost: 1, gmgnCreditLimit: 5 },
    mint: "MintKline",
    from: 0,
    to: 60_000,
    apiKey: "secret-key",
    cache: klineCache,
    calls,
    now: () => clock,
    sleep: async () => {},
    budget: createRequestBudget({ gmgnCreditLimit: 5, gmgnWindowMs: 1000 }),
    fetchImpl: async () => {
      klineCalls += 1;
      return { ok: true, status: 200, json: async () => ({ list: [{ time: 0, open: "1", high: "1", low: "1", close: "1", volume: "1", amount: "1" }] }) };
    },
  };
  assert.equal((await fetchGmgn1m(kline)).ok, true);
  assert.equal((await fetchGmgn1m(kline)).ok, true);
  assert.equal(klineCalls, 1);
  assert.equal(calls.n, 1);
  clock += 60_000;
  await fetchGmgn1m({ ...kline, budget: createRequestBudget({ gmgnCreditLimit: 5, gmgnWindowMs: 1000 }) });
  assert.equal(klineCalls, 2);

  const paused = await fetchGmgn1m({
    ...kline,
    cache: new Map(),
    calls: { n: 0 },
    deadline: clock,
    budget: createRequestBudget({ gmgnCreditLimit: 5, gmgnWindowMs: 1000 }),
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => "5" }, json: async () => ({ message: "slow down" }) }),
  });
  assert.equal(paused.retry, true);
  assert.equal(paused.retryAt, clock + 5_000);
  assert.match(paused.reason, /429/);
});

test("a repeated Fabriq alert is not rescreened inside the cooldown", async () => {
  const file = path.join(os.tmpdir(), `meridian-loosen-${process.pid}-${Date.now()}.json`);
  const store = new MonitorStore(file);
  const html = fs.readFileSync(new URL("./fixtures/fabriqalert.html", import.meta.url), "utf8");
  const now = Date.now();
  const alert = { ...parseFabriqPage(html).alerts.find(item => item.id === "fabriqalert/40761"), at: now };
  const mint = alert.mint;
  let snapshots = 0;
  let sleeps = 0;
  setPursuitDeps({
    sleep: async () => {
      sleeps += 1;
      if (sleeps >= 2) store.data.signals[mint].lastAlertAt = Date.now() - (1800 * 1000) - 5;
    },
    exposureStillPresent: async () => true,
    createMarketData: () => ({
      snapshot: async () => {
        snapshots += 1;
        return { ok: false, reason: "candle provider is not configured", gmgnCalls: 0 };
      },
    }),
  });
  useRuntimeStore(store);
  try {
    ingestFabriqAlerts([alert], now, { startup: false });
    await signalPursuitSettled();
    assert.equal(snapshots, 1);
    assert.equal(store.data.signals[mint].reason, "fabriq alert went stale");
    assert.ok(sleeps >= 2);
  } finally {
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});
