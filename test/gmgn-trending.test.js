import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { MonitorStore, finishSignal } from "../standalone/store.js";
import { createGmgnTrendingPoller, gmgnTrendingUrl, parseGmgnTrending } from "../standalone/gmgn-trending.js";
import { ingestGmgnAlerts, resetPursuitDeps, setNotifySink, setPursuitDeps, signalPursuitSettled, useRuntimeStore } from "../standalone/runtime.js";
import { buildScreeningRecord } from "../standalone/decisions.js";

const rules = config.externalSignals.gmgnTrending;
const mint = "DVdWuNK8ncn79B6z8nCiwcNAiwyFcmBPfChgxJGTpump";

function row(over = {}) {
  return { address: mint, symbol: "4CHAN", volume: 308123, market_cap: 1338640, liquidity: 156211, bundler_rate: 0.2472, price_change_percent5m: -6.2, ...over };
}

function tempStore() {
  const file = path.join(os.tmpdir(), `meridian-gmgn-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return { file, store: new MonitorStore(file) };
}

test("gmgn trending defaults match the PC lp_alert.ps1 script", () => {
  assert.equal(rules.enabled, true);
  assert.equal(rules.pollSec, 60);
  assert.equal(rules.minVolume5mUsd, 150_000);
  assert.equal(rules.minMarketCapUsd, 750_000);
  assert.equal(rules.maxBundlerRate, 0.5);
  const url = gmgnTrendingUrl(rules);
  assert.equal(url.origin + url.pathname, "https://openapi.gmgn.ai/v1/market/rank");
  assert.equal(url.searchParams.get("interval"), "5m");
  assert.equal(url.searchParams.get("min_volume"), "150000");
  assert.equal(url.searchParams.get("min_marketcap"), "750000");
  assert.equal(url.searchParams.get("max_bundler_rate"), "0.5");
  assert.equal(url.searchParams.get("order_by"), "volume");
  const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
  assert.equal(example.externalSignals.gmgnTrending.minVolume5mUsd, 150000);
});

test("parser re-checks every rule locally and drops rows with missing metrics", () => {
  const now = Date.UTC(2026, 10, 25, 14, 0, 0);
  const body = { data: { rank: [
    row(),
    row({ address: "LowVol", volume: 149_999 }),
    row({ address: "LowMcap", market_cap: 700_000 }),
    row({ address: "Bundled", bundler_rate: 0.5 }),
    row({ address: "NoBundler", bundler_rate: null }),
  ] } };
  const parsed = parseGmgnTrending(body, rules, now);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.alerts.map(a => a.mint), [mint]);
  const alert = parsed.alerts[0];
  assert.equal(alert.source, "gmgn");
  assert.equal(alert.volume5mLabel, "$308K");
  assert.equal(alert.id, parseGmgnTrending(body, rules, now + 60_000).alerts[0].id, "same refresh window keeps one id");
  assert.equal(parseGmgnTrending({ data: {} }, rules, now).ok, false);
});

test("parser reads the raw OpenAPI envelope { code, data: { data: { rank } } }", () => {
  const now = Date.UTC(2026, 10, 27, 5, 0, 0);
  const raw = { code: 0, message: "success", data: { data: { rank: [row(), row({ address: "LowVol", volume: 1 })] } } };
  const parsed = parseGmgnTrending(raw, rules, now);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.alerts.map(a => a.mint), [mint]);

  const failed = parseGmgnTrending({ code: 40001, message: "bad sign" }, rules, now);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /code 40001.*bad sign/);
  assert.match(parseGmgnTrending({ code: 0, data: { other: [] } }, rules, now).reason, /data keys: other/);
});

test("poller logs matches for a raw OpenAPI reply", async () => {
  const logs = [];
  const seen = [];
  const poller = createGmgnTrendingPoller({
    rules,
    apiKey: "test-key",
    log: m => logs.push(m),
    onAlerts: alerts => seen.push(...alerts),
    schedule: () => 1,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { data: { rank: [row()] } } }) }),
  });
  await poller.start();
  poller.stop();
  assert.ok(logs.some(m => m === "1 match(es)"), logs.join(" | "));
  assert.deepEqual(seen.map(a => a.mint), [mint]);
});

test("poller pauses on a 429 and shares the pause through the gate", async () => {
  const gate = { pausedUntil: 0 };
  const delays = [];
  const logs = [];
  let calls = 0;
  let clock = 1_000_000;
  const poller = createGmgnTrendingPoller({
    rules,
    apiKey: "test-key",
    now: () => clock,
    gate,
    log: m => logs.push(m),
    schedule: (fn, ms) => { delays.push(ms); return 1; },
    fetchImpl: async (url, init) => {
      calls++;
      assert.ok(url.searchParams.get("timestamp") && url.searchParams.get("client_id"));
      assert.equal(init.headers["X-APIKEY"], "test-key");
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
    },
  });
  await poller.start();
  assert.equal(calls, 1);
  assert.equal(delays[0], rules.rateLimitPauseSec * 1000);
  assert.equal(gate.pausedUntil, clock + rules.rateLimitPauseSec * 1000);
  assert.ok(logs.some(m => m.includes("rate limit")));
  poller.stop();
});

test("a GMGN hit opens its own pursuit, refreshes it, and records a shadow proposal", async () => {
  const { file, store } = tempStore();
  const notices = [];
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({ snapshot: async () => passingSnapshot(mint) }),
  });
  setNotifySink(text => notices.push(text));
  useRuntimeStore(store);
  try {
    const now = Date.now();
    const [alert] = parseGmgnTrending({ data: { rank: [row()] } }, rules, now).alerts;
    const opened = ingestGmgnAlerts([alert], now);
    assert.equal(opened.length, 1);
    await signalPursuitSettled();
    const signal = store.data.signals[mint];
    assert.equal(signal.source, "gmgn");
    assert.equal(signal.events.length, 0);
    assert.equal(signal.reason, "shadow proposal recorded");
    assert.equal(store.data.shadowBook.at(-1).submitted, false);
    assert.ok(notices.some(text => text.includes("GMGN trending")));

    // Finished and cooling down: the next poll does not reopen it.
    assert.equal(ingestGmgnAlerts([{ ...alert, id: "gmgn/x/2" }], now + 1000).length, 0);
    const record = buildScreeningRecord({ now, signal, snapshot: null, book: [], rules: config.ownerStrategy, result: null, reason: "x" });
    assert.equal(record.trigger.source, "gmgn");
    assert.equal(record.trigger.post.volume5mUsd, 308123);
  } finally {
    setNotifySink(null);
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("an active GMGN pursuit is refreshed in place, not duplicated", () => {
  const { file, store } = tempStore();
  useRuntimeStore(store);
  try {
    const now = Date.now();
    store.data.signals[mint] = { mint, source: "gmgn", createdAt: now - 60_000, lastAlertAt: now - 60_000, deadline: null, events: [], done: false };
    const [alert] = parseGmgnTrending({ data: { rank: [row()] } }, rules, now).alerts;
    assert.equal(ingestGmgnAlerts([alert], now).length, 0);
    assert.equal(store.data.signals[mint].lastAlertAt, now);
    assert.equal(store.data.signals[mint].gmgnAlert.mint, mint);
    finishSignal(store, store.data.signals[mint], "done", { cooldownSec: 0 }, now);
  } finally {
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});
