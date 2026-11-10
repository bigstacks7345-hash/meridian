import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { crashDrawdown, evaluateEntry, poolDepth } from "../strategy/rules.js";
import { buildScreeningRecord } from "../standalone/decisions.js";

const rules = OWNER_STRATEGY;

function minuteBars({ start, count, high, close }) {
  const closed1m = [];
  for (let i = 0; i < count - 1; i++) {
    const price = high(i);
    closed1m.push({ t: start + i * 60_000, o: price, h: price, l: price * 0.99, c: price, v: 1_000 });
  }
  const last = close;
  const current1m = { t: start + (count - 1) * 60_000, o: last, h: Math.max(last, high(count - 1)), l: last, c: last, v: 1_000 };
  return { closed1m, current1m, livePrice: last };
}

function pmurtSnapshot() {
  const start = Date.parse("2026-11-09T22:30:00.000Z");
  const bars = minuteBars({
    start,
    count: 30,
    high: index => (index < 29 ? 0.001 : 0.001),
    close: 0.0003,
  });
  return {
    ...passingSnapshot("PMURT"),
    ...bars,
    closed5m: [{ t: start, v: 139_000 }],
    liquidityUsd: 1_270,
    poolLiquidityUsd: 1_270,
    poolVolume5mUsd: 45_000,
    poolAddress: "9sp5hSYyStJAAcLEH2zSwv8QfV7uCp36Zd2Fkm6idzs3",
  };
}

test("a PMURT-like dump and thin pool fail both guards, and a healthy book passes", () => {
  const healthy = passingSnapshot();
  const passed = evaluateEntry(healthy, rules);
  assert.equal(passed.pass, true, passed.reasons.join("; "));
  assert.ok(passed.display.crashGuard.drawdownPct < 60);
  assert.ok(passed.display.poolDepth.volToLiq < 10);

  const rug = pmurtSnapshot();
  const crash = crashDrawdown(rug, rules);
  assert.equal(crash.ok, false);
  assert.equal(crash.drawdownPct, 70);
  assert.match(crash.reason, /70% below the 30m high/);
  const depth = poolDepth(rug, rules);
  assert.equal(depth.ok, false);
  assert.equal(depth.volToLiq, 35.43);
  assert.match(depth.reason, /35\.43 exceeds 15/);

  const decision = evaluateEntry(rug, rules);
  assert.equal(decision.pass, false);
  assert.ok(decision.reasons.some(reason => reason.includes("70%")));
  assert.ok(decision.reasons.some(reason => reason.includes("35.43")));

  const record = buildScreeningRecord({
    now: Date.parse("2026-11-09T23:00:00.000Z"),
    signal: { mint: rug.mint, source: "fabriq", pool: rug.poolAddress },
    snapshot: rug,
    rules,
    reason: decision.reasons.join("; "),
  });
  assert.equal(record.indicators.crashDrawdownPct, 70);
  assert.equal(record.indicators.poolVolToLiq5m, 35.43);
  assert.match(record.reason, /70%/);
});

test("crash guard uses a 60% line and pool depth fails closed without pool volume", () => {
  const start = Date.parse("2026-11-09T22:30:00.000Z");
  const flat = minuteBars({ start, count: 30, high: () => 1, close: 0.4 });
  assert.equal(crashDrawdown({ ...flat }, rules).ok, true);
  const dumped = minuteBars({ start, count: 30, high: () => 1, close: 0.399 });
  const rejected = crashDrawdown({ ...dumped }, rules);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.drawdownPct, 60.1);

  const older = minuteBars({ start, count: 40, high: index => (index < 5 ? 1 : 0.9), close: 0.8 });
  assert.equal(crashDrawdown({ ...older }, rules).ok, true);

  const disabled = crashDrawdown({ ...dumped }, { crashGuard: { enabled: false, maxDrawdownPct: 60, lookbackMin: 30 } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.drawdownPct, 60.1);

  const tokenOnly = { ...passingSnapshot(), poolVolume5mUsd: null, closed5m: [{ t: start, v: 139_000 }] };
  const missing = poolDepth(tokenOnly, rules);
  assert.equal(missing.ok, false);
  assert.equal(missing.volToLiq, null);
  assert.match(missing.reason, /not using token volume/);
  assert.equal(poolDepth({ ...passingSnapshot(), poolVolume5mUsd: 40_000 }, rules).ok, true);
  assert.equal(poolDepth(tokenOnly, { poolDepth: { enabled: false, maxVolToLiq5m: 10 } }).ok, true);
});
