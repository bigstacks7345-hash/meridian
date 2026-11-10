import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { createGmgnGate, createRequestBudget } from "../strategy/market-data.js";
import { createOwnerMarketData, ownerSnapshotWindow } from "../standalone/runtime.js";

const rules = {
  ...OWNER_STRATEGY,
  candleProvider: "gmgn",
  gmgnPageBars: 10,
  pocLookbackHours: 10 / 60,
  gmgnCreditLimit: 5,
  gmgnWindowMs: 1000,
  gmgnCandleCreditCost: 2,
  gmgnInfoCreditCost: 1,
  candleCacheMs: 60_000,
};

function klines(url) {
  const query = new URL(url).searchParams;
  const start = Number(query.get("from"));
  const end = Number(query.get("to"));
  const sol = query.get("address") === OWNER_STRATEGY.quoteMint;
  const list = [];
  for (let t = start; t < end; t += 60_000) {
    list.push({
      time: t / 1000,
      open: sol ? "100" : "10",
      high: sol ? "100" : "11",
      low: sol ? "100" : "9",
      close: sol ? "100" : "10",
      volume: "5",
      amount: "1",
    });
  }
  return { list };
}

test("runtime market-data path sends the GMGN key and a from/to window", async () => {
  const calls = [];
  let clock = 600_000;
  const provider = createOwnerMarketData({
    apiKey: "runtime-key",
    rules,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    budget: createRequestBudget(rules),
    gate: createGmgnGate(),
    cache: new Map(),
    fetchImpl: async (url, init) => {
      const href = String(url);
      calls.push({ href, key: init?.headers?.["X-APIKEY"] });
      if (href.includes("/v1/token/info")) {
        return { ok: true, status: 200, json: async () => ({ creation_timestamp: 1 }) };
      }
      return { ok: true, status: 200, json: async () => klines(href) };
    },
  });
  const window = ownerSnapshotWindow(clock, rules);
  const first = await provider.snapshot("TokenMint", { ...window, deadline: clock + 60_000 });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.priceDenomination, "quote");
  assert.ok(first.closed1m.length > 0);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every(call => call.key === "runtime-key"));
  assert.ok(calls.some(call => call.href.includes("/v1/market/token_kline") && call.href.includes("from=") && call.href.includes("to=")));
  assert.ok(calls.some(call => call.href.includes(OWNER_STRATEGY.quoteMint)));
  const after = calls.length;
  const second = await provider.snapshot("TokenMint", { ...window, deadline: clock + 60_000 });
  assert.equal(second.ok, true);
  assert.equal(calls.length, after);
});

test("a GMGN 429 pauses until the reset, then the same snapshot is retried", async () => {
  const sleeps = [];
  let clock = 600_000;
  let tokenPages = 0;
  const provider = createOwnerMarketData({
    apiKey: "runtime-key",
    rules,
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    budget: createRequestBudget(rules),
    gate: createGmgnGate(),
    cache: new Map(),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/v1/token/info")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ creation_timestamp: 1 }) };
      }
      const sol = new URL(href).searchParams.get("address") === OWNER_STRATEGY.quoteMint;
      if (!sol) {
        tokenPages += 1;
        if (tokenPages === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: name => name.toLowerCase() === "retry-after" ? "2" : null },
            json: async () => ({ retry_after: 2 }),
          };
        }
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => klines(href) };
    },
  });
  const window = ownerSnapshotWindow(clock, rules);
  const result = await provider.snapshot("TokenMint", { ...window, deadline: clock + 30_000 });
  assert.equal(result.ok, true, result.reason);
  assert.ok(sleeps.includes(2000));
  assert.ok(tokenPages >= 2);
});
