import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { createPacer, cycleMetrics, loadCandles, loadTriggers, parseGeckoOhlcv, pickTopPool, triggerOfRecord } from "../standalone/coin-cycles.js";
import { binsForDepth, buildWeeklyReport, createWeeklyScheduler, formatWeeklyReport, isoWeek, lastWeeklyRun, mcBucket, percentile, rangeAdvice, seaBandFor, weeklyFile } from "../standalone/weekly-report.js";
import { writeSeaState } from "../standalone/sea-state.js";

const rules = config.coinCycles;
const BAR = 5 * 60_000;
const T0 = Date.UTC(2026, 10, 16, 12, 0); // Mon 16 Nov 2026 12:00 UTC
const MINT = "DVdWuNK8ncn79B6z8nCiwcNAiwyFcmBPfChgxJGTpump";
const POOL = "Ak4wr2ueEAJMqZSEcGPMX9EhCrwWRngP8CskvdEh1e6H";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cycles-"));
}

/** 5m candles from a list of [hoursFromT0, price] knots, linear in between, 0.5% wick each side. */
function series(knots, start = T0, hours = 80) {
  const out = [];
  for (let t = start; t < start + hours * 3_600_000; t += BAR) {
    const h = (t - start) / 3_600_000;
    let price = knots[knots.length - 1][1];
    for (let i = 1; i < knots.length; i++) {
      if (h <= knots[i][0]) {
        const [h0, p0] = knots[i - 1];
        const [h1, p1] = knots[i];
        price = p0 + (p1 - p0) * ((h - h0) / (h1 - h0));
        break;
      }
    }
    out.push({ t, o: price, h: price * 1.005, l: price * 0.995, c: price, v: 1000 });
  }
  return out;
}

function geckoBody(candles) {
  return { data: { attributes: { ohlcv_list: [...candles].reverse().map(c => [c.t / 1000, c.o, c.h, c.l, c.c, c.v]) } } };
}

function writeDecisions(dir, records) {
  for (const record of records) {
    const file = path.join(dir, `decisions-${record.at.slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  }
}

test("coin-cycle defaults", () => {
  assert.equal(rules.windowHours, 72);
  assert.equal(rules.bouncePct, 20);
  assert.equal(rules.minBins, 35);
  assert.equal(rules.maxSingleTxBins, 69);
  assert.ok(rules.requestGapMs >= 2100, "stays under GeckoTerminal's 30/min");
});

test("triggerOfRecord reads GMGN, Fabriq and wallet records", () => {
  assert.deepEqual(triggerOfRecord({ trigger: { source: "gmgn", post: { marketCapUsd: 1.3e6, symbol: "A" } } }), { source: "gmgn", marketCapUsd: 1.3e6, symbol: "A" });
  assert.equal(triggerOfRecord({ trigger: { source: "fabriq", post: { fdvUsd: 2e6 } } }).marketCapUsd, 2e6);
  assert.deepEqual(triggerOfRecord({ trigger: { source: "wallets" }, fdvUsd: 9e5 }), { source: "wallets", marketCapUsd: 9e5, symbol: null });
});

test("loadTriggers keeps the first screening per mint inside the window", () => {
  const dir = tempDir();
  writeDecisions(dir, [
    { type: "decision", mint: MINT, pool: POOL, at: new Date(T0 + 3_600_000).toISOString(), decision: "skip", trigger: { source: "gmgn", post: { marketCapUsd: 2e6 } } },
    { type: "decision", mint: MINT, at: new Date(T0).toISOString(), decision: "pass", trigger: { source: "gmgn", post: { marketCapUsd: 1e6 } } },
    { type: "exit", mint: MINT, at: new Date(T0).toISOString() },
    { type: "decision", mint: "OTHER", at: new Date(T0 + 8 * 86_400_000).toISOString(), trigger: { source: "fabriq", post: {} } },
  ]);
  fs.appendFileSync(path.join(dir, `decisions-${new Date(T0).toISOString().slice(0, 10)}.jsonl`), "not json\n");
  const triggers = loadTriggers(dir, T0 - 86_400_000, T0 + 7 * 86_400_000);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].at, T0);
  assert.equal(triggers[0].marketCapUsd, 1e6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseGeckoOhlcv sorts oldest first and drops bad rows", () => {
  const parsed = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[200, 1, 2, 1, 2, 5], [100, 1, 1, 1, 1, 3], [300, "x", 1, 1, 1, 1]] } } });
  assert.deepEqual(parsed.candles.map(c => c.t), [100_000, 200_000]);
  assert.equal(parseGeckoOhlcv({}).ok, false);
});

test("pickTopPool chooses the deepest pool that holds the mint", () => {
  const body = { data: [
    { attributes: { address: "small", reserve_in_usd: "900" }, relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: "solana_SOL" } } } },
    { attributes: { address: "big", reserve_in_usd: "18000" }, relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: "solana_SOL" } } } },
    { attributes: { address: "unrelated", reserve_in_usd: "99999" }, relationships: { base_token: { data: { id: "solana_X" } }, quote_token: { data: { id: "solana_Y" } } } },
  ] };
  assert.equal(pickTopPool(body, MINT), "big");
});

test("cycleMetrics: run 3x, dump to 40% below entry, then a bounce", () => {
  // entry 1.0 → peak 3.0 at 6h → low 0.6 at 30h → 0.9 at 40h → flat
  const candles = series([[0, 1], [6, 3], [30, 0.6], [40, 0.9], [80, 0.9]]);
  const m = cycleMetrics(candles, { at: T0 + 60_000, windowHours: 72, bouncePct: 20 });
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.runMultiple - 3.015) < 0.02, `run ${m.runMultiple}`);
  assert.equal(m.minutesToPeak, 360);
  assert.ok(Math.abs(m.deepestFromEntryPct - 40.3) < 0.5, `deepest ${m.deepestFromEntryPct}`);
  assert.ok(Math.abs(m.dumpFromPeakPct - 80.2) < 0.5, `fromPeak ${m.dumpFromPeakPct}`);
  assert.equal(m.bounced, true);
  assert.ok(m.retraceShare > 0.1 && m.retraceShare < 0.15, `retrace ${m.retraceShare}`);
});

test("cycleMetrics: a coin that bleeds out never bounces", () => {
  const m = cycleMetrics(series([[0, 1], [2, 1.2], [72, 0.1], [80, 0.1]]), { at: T0, windowHours: 72, bouncePct: 20 });
  assert.equal(m.ok, true);
  assert.equal(m.bounced, false);
  assert.equal(m.bounceMultiple, null);
  assert.ok(m.deepestFromEntryPct > 85);
});

test("cycleMetrics: never below entry reads 0% depth", () => {
  const m = cycleMetrics(series([[0, 1], [10, 2], [80, 1.5]]), { at: T0, windowHours: 72 });
  assert.ok(m.deepestFromEntryPct < 1, "only the entry candle's own wick sits below entry");
});

test("cycleMetrics refuses a short or missing window", () => {
  assert.equal(cycleMetrics(series([[0, 1]], T0, 0.5), { at: T0 }).ok, false);
  assert.equal(cycleMetrics(series([[0, 1]]), { at: T0 - 86_400_000 }).ok, false);
});

test("cycleMetrics tolerates gaps and a coin that stops trading", () => {
  // Drop every third bar and everything after 20h (dead coin).
  const gappy = series([[0, 1], [4, 2], [20, 0.3]]).filter((c, i) => i % 3 !== 1 && c.t < T0 + 20 * 3_600_000);
  const m = cycleMetrics(gappy, { at: T0 + 7 * 60_000, windowHours: 72 });
  assert.equal(m.ok, true);
  assert.ok(m.runMultiple > 1.9);
  assert.ok(m.deepestFromEntryPct > 65);
  assert.equal(m.volumeDecay, 0, "no trades 24h after the peak");
  // Trigger lands before the pool's first bar: use the first bar within 15 min.
  assert.equal(cycleMetrics(series([[0, 1]]), { at: T0 - 10 * 60_000 }).ok, true);
});

test("binsForDepth matches the plan's table", () => {
  assert.equal(binsForDepth(40, 100), 51);
  assert.equal(binsForDepth(60, 100), 92);
  assert.equal(binsForDepth(80, 250), 64);
  assert.equal(binsForDepth(0, 100), 0);
  const advice = rangeAdvice(40, rules);
  assert.deepEqual(advice.find(a => a.binStep === 250), { binStep: 250, bins: 21, useBins: 35, widePath: false });
  assert.equal(advice.find(a => a.binStep === 80).widePath, false);
  assert.equal(rangeAdvice(60, rules).find(a => a.binStep === 100).widePath, true);
});

test("percentile and buckets", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4);
  assert.equal(percentile([], 0.5), null);
  assert.equal(mcBucket(9e5), "<$1M");
  assert.equal(mcBucket(2e6), "$1M–$5M");
  assert.equal(mcBucket(30e6), ">$20M");
  assert.equal(mcBucket(null), "unknown");
});

test("isoWeek and lastWeeklyRun", () => {
  assert.equal(isoWeek(Date.UTC(2026, 10, 23)), "2026-W48");
  assert.equal(isoWeek(Date.UTC(2027, 0, 1)), "2026-W53");
  const fri = Date.UTC(2026, 10, 27, 10);
  assert.equal(lastWeeklyRun(fri, 2, 0), Date.UTC(2026, 10, 23, 2));
  assert.equal(lastWeeklyRun(Date.UTC(2026, 10, 23, 1), 2, 0), Date.UTC(2026, 10, 16, 2));
});

test("seaBandFor reads the trigger day, then the day before", () => {
  const dir = tempDir();
  writeSeaState({ day: "2026-11-15", band: "Dead calm" }, dir);
  assert.equal(seaBandFor(T0, dir), "Dead calm");
  writeSeaState({ day: "2026-11-16", band: "Choppy" }, dir);
  assert.equal(seaBandFor(T0, dir), "Choppy");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadCandles resolves a pool, asks for the window, and caches", async () => {
  const dir = tempDir();
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (String(url).includes("/tokens/")) {
      return { ok: true, json: async () => ({ data: [{ attributes: { address: POOL, reserve_in_usd: "1" }, relationships: { base_token: { data: { id: `solana_${MINT}` } } } }] }) };
    }
    return { ok: true, json: async () => geckoBody(series([[0, 1]])) };
  };
  const pace = fn => fn();
  const trigger = { mint: MINT, pool: null, at: T0 };
  const first = await loadCandles(trigger, { fetchImpl, pace, cacheDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.pool, POOL);
  assert.match(urls[1], new RegExp(`/pools/${POOL}/ohlcv/minute\\?aggregate=5&limit=1000&currency=usd&token=${MINT}&before_timestamp=${(T0 + 72 * 3_600_000 + BAR) / 1000}`));
  await loadCandles(trigger, { fetchImpl, pace, cacheDir: dir });
  assert.equal(urls.length, 2, "second load comes from the cache");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createPacer spaces calls", async () => {
  let clock = 0;
  const waits = [];
  const pace = createPacer(2500, { now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; } });
  await pace(() => 1);
  clock += 1000;
  await pace(() => 2);
  assert.deepEqual(waits, [1500]);
});

test("weekly report formats and flags the wide path", () => {
  const coin = (over) => ({ ok: true, source: "gmgn", bucket: "<$1M", seaBand: "Dead calm", runMultiple: 1.5, minutesToPeak: 90, dumpFromPeakPct: 60, deepestFromEntryPct: 55, bounced: true, retraceShare: 0.3, volumeDecay: 0.2, ...over });
  const report = buildWeeklyReport([coin({}), coin({ deepestFromEntryPct: 65, bounced: false }), coin({ bucket: "$1M–$5M", deepestFromEntryPct: 30 })], { rules, from: T0, to: T0 + 7 * 86_400_000, skipped: 1, failures: { "no pool found": 1 } });
  assert.equal(report.triggers, 4);
  assert.equal(report.measured, 3);
  assert.equal(report.byMarketCap["<$1M"].n, 2);
  assert.equal(report.byMarketCap["<$1M"].neverBouncedShare, 0.5);
  const text = formatWeeklyReport(report, { week: "2026-W48" });
  assert.match(text, /⚓ Coin cycles 2026-W48/);
  assert.match(text, /3\/4 coins measured/);
  assert.match(text, /<\$1M \(n=2\)/);
  assert.match(text, /\*@100/, "p75 depth over 69 bins at step 100 is flagged");
  assert.match(text, /Dead calm \(n=3\)/);
  assert.match(formatWeeklyReport(buildWeeklyReport([], { rules, from: T0, to: T0 }), { week: "x" }), /No coins had a full window/);
});

test("weekly scheduler measures last week once and posts once", async () => {
  const dir = tempDir();
  const decisions = tempDir();
  // Run time Mon 23 Nov 02:00 → week covers triggers 13 Nov 02:00 to 20 Nov 02:00.
  writeDecisions(decisions, [
    { type: "decision", mint: MINT, pool: POOL, at: new Date(T0).toISOString(), decision: "skip", trigger: { source: "gmgn", post: { marketCapUsd: 8e5 } } },
    { type: "decision", mint: "LATE", at: new Date(Date.UTC(2026, 10, 21)).toISOString(), trigger: { source: "gmgn", post: {} } },
  ]);
  const posted = [];
  const delays = [];
  const make = () => createWeeklyScheduler({
    rules,
    now: () => Date.UTC(2026, 10, 23, 3),
    dir,
    decisionsPath: decisions,
    fetchImpl: async () => ({ ok: true, json: async () => geckoBody(series([[0, 1], [6, 3], [30, 0.6], [40, 0.9], [80, 0.9]])) }),
    pace: fn => fn(),
    notify: async text => { posted.push(text); },
    schedule: (fn, ms) => { delays.push(ms); return 1; },
    clear: () => {},
  });
  await make().start();
  const file = weeklyFile("2026-W48", dir);
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.measured, 1);
  assert.equal(saved.triggers, 1, "the 21 Nov trigger has no full window yet");
  assert.equal(saved.coins[0].peakMarketCapUsd > 2.3e6, true);
  assert.equal(posted.length, 1);
  assert.equal(delays.at(-1), 7 * 86_400_000 - 3_600_000);
  await make().start();
  assert.equal(posted.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(decisions, { recursive: true, force: true });
});

test("geckoJson waits out a 429 and retries", async () => {
  const { geckoJson } = await import("../standalone/coin-cycles.js");
  const statuses = [429, 429, 200];
  const slept = [];
  const body = await geckoJson(async () => {
    const status = statuses.shift();
    return { ok: status === 200, status, json: async () => ({ fine: true }) };
  }, fn => fn(), "u", { sleep: async ms => { slept.push(ms); } });
  assert.deepEqual(body, { fine: true });
  assert.deepEqual(slept, [60_000, 60_000]);
  await assert.rejects(geckoJson(async () => ({ ok: false, status: 429 }), fn => fn(), "u", { sleep: async () => {}, retries: 1 }), /429/);
});

test("a coin that never fell far enough is not counted as dead", () => {
  const m = cycleMetrics(series([[0, 1], [10, 1.1], [80, 1.0]]), { at: T0, windowHours: 72, bouncePct: 20 });
  assert.equal(m.bounced, null);
  const report = buildWeeklyReport([{ ok: true, bucket: ">$20M", source: "gmgn", ...m }], { rules, from: T0, to: T0 });
  assert.equal(report.all.neverBouncedShare, 0);
  assert.equal(report.all.dumpedShare, 0);
  assert.equal(triggerOfRecord({ trigger: { post: { marketCapUsd: 0 } } }).marketCapUsd, null);
});
