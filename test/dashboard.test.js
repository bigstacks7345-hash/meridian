import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { computePulse, depthForBins, fetchWalletPositions, fleetWallets, mergeFleet, normalizePosition, createFleetCensus, loadFleetStore } from "../standalone/fleet-census.js";
import { createSnapshotBuilder, isLoopback, parseHotPools, readDecisions, reasonKey, recentTriggers, seaHistory, startDashboard, thomasActivity } from "../standalone/dashboard.js";
import { parseVolumeChart } from "../standalone/sea-state.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const SOL = "So11111111111111111111111111111111111111112";
const W1 = "3ryaTJFiDHgA1U9CyTwuy57KkFk8UJMLnDM28mK1opui";
const W2 = "Bdrs3hKcEe4PpM91risoYm5YKceQ7tsaovs4otog6HBz";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meridian-dash-"));
}

const POOL = { poolAddress: "PoolAAA", binStep: "100", baseFee: "2", tokenX: "Rings", tokenY: "SOL", tokenYMint: SOL };

function rawPosition({ id, openedH, closedH = null, solIn = 1, tokenIn = 0, pnl = 1, bins = 69 }) {
  return {
    positionAddress: id,
    lowerBinId: 100,
    upperBinId: 100 + bins - 1,
    isClosed: closedH != null,
    createdAt: (NOW + openedH * HOUR) / 1000,
    closedAt: closedH != null ? (NOW + closedH * HOUR) / 1000 : 0,
    pnlSol: String(pnl / 100),
    pnlSolPctChange: String(pnl),
    allTimeDeposits: { tokenX: { amountSol: String(tokenIn) }, tokenY: { amountSol: String(solIn) } },
  };
}

function row(over) {
  return normalizePosition(rawPosition(over), POOL, over.wallet || W1);
}

test("dashboard and census defaults are safe", () => {
  assert.equal(config.dashboard.host, "127.0.0.1");
  assert.equal(config.dashboard.port, 8787);
  assert.equal(config.fleetCensus.everyMin, 60);
  assert.equal(config.fleetCensus.backfillHours, 144);
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
});

test("fleetWallets merges watched wallets with the bundled list without duplicates", () => {
  const dir = tempDir();
  const file = path.join(dir, "w.json");
  fs.writeFileSync(file, JSON.stringify({ wallets: [{ address: W1, label: "elite" }, { address: W2, label: "whale" }] }));
  const list = fleetWallets([W1], file);
  assert.deepEqual(list.map(w => [w.address, w.label]), [[W1, "watched"], [W2, "whale"]]);
  const bundled = JSON.parse(fs.readFileSync(new URL("../data/fleet-wallets.json", import.meta.url), "utf8"));
  assert.ok(bundled.wallets.length >= 10);
  assert.ok(bundled.wallets.every(w => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address)), "addresses only");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("normalizePosition reads side, depth and hold", () => {
  const r = row({ id: "p1", openedH: -5, closedH: -4, solIn: 2, pnl: 3 });
  assert.equal(r.side, "sol");
  assert.equal(r.bins, 69);
  assert.ok(Math.abs(r.depthPct - depthForBins(69, 100)) < 1e-9);
  assert.ok(r.depthPct > 49 && r.depthPct < 50);
  assert.equal(r.closedAt - r.openedAt, HOUR);
  assert.equal(r.name, "Rings-SOL");
  assert.equal(row({ id: "p2", openedH: -1, solIn: 0, tokenIn: 1 }).side, "token");
  assert.equal(row({ id: "p3", openedH: -1, solIn: 1, tokenIn: 1 }).depthPct, null, "two-sided has no single depth");
});

test("computePulse matches hand counts", () => {
  const rows = [
    row({ id: "a", openedH: -3, closedH: -2.9, pnl: 1 }), // <30 min, green
    row({ id: "b", openedH: -2.88, closedH: -1, pnl: -2 }), // reopened 1.2 min after a; 30m-2h, red
    row({ id: "c", openedH: -10, closedH: -1, pnl: 4, wallet: W2, bins: 200 }), // 2-12h, green, deep
    row({ id: "d", openedH: -0.5, wallet: W2 }), // open
    row({ id: "e", openedH: -30, closedH: -26, pnl: 5 }), // yesterday
  ];
  const store = mergeFleet({}, rows, { now: NOW, wallets: 2 });
  const p = computePulse(store, NOW);
  assert.equal(p.today.opened, 4);
  assert.equal(p.today.closed, 3);
  assert.equal(p.today.activeLps, 2);
  assert.equal(p.today.closedGreen, 2 / 3);
  assert.equal(p.today.medianGainPct, 1);
  assert.equal(Math.round(p.today.reopenedShare * 3), 1);
  assert.equal(p.today.byHold.find(h => h.label === "< 30 min").n, 1);
  assert.equal(p.today.byHold.find(h => h.label === "2 to 12 h").green, 1);
  assert.equal(p.today.byDepth.find(d => d.label === "80% or more").n, 1);
  assert.equal(p.yesterday.closed, 1);
  assert.equal(p.topPools[0].lps, 2);
  assert.equal(p.opensByDay.at(-1).opened, 4);
  assert.equal(p.opensByDay.at(-2).opened, 1);
});

test("mergeFleet keeps open positions and drops week-old closes", () => {
  const old = row({ id: "old", openedH: -200, closedH: -190 });
  const openOld = row({ id: "openOld", openedH: -200 });
  const store = mergeFleet({ positions: { old, openOld } }, [], { now: NOW });
  assert.deepEqual(Object.keys(store.positions), ["openOld"]);
});

test("fetchWalletPositions walks portfolio, open pools and pnl pages", async () => {
  const urls = [];
  const fetchImpl = async url => {
    const u = String(url);
    urls.push(u);
    let body;
    if (u.includes("/portfolio?")) body = { hasNext: true, pools: [{ ...POOL, lastClosedAt: (NOW - HOUR) / 1000 }, { ...POOL, poolAddress: "Old", lastClosedAt: (NOW - 100 * HOUR) / 1000 }] };
    else if (u.includes("/portfolio/open")) body = { pools: [{ ...POOL, poolAddress: "OpenPool" }] };
    else if (u.includes("status=closed")) body = { positions: [rawPosition({ id: "c1", openedH: -3, closedH: -1 }), rawPosition({ id: "c2", openedH: -90, closedH: -80 })] };
    else body = { positions: [rawPosition({ id: "o1", openedH: -2 })] };
    return { ok: true, json: async () => body };
  };
  const rows = await fetchWalletPositions(W1, { fetchImpl, now: NOW, lookbackMs: 48 * HOUR });
  assert.deepEqual(rows.map(r => r.id).sort(), ["c1", "o1"]);
  assert.equal(urls.filter(u => u.includes("/portfolio?")).length, 1, "stops paging once pools are older than the lookback");
  assert.ok(urls.some(u => u.includes("/positions/PoolAAA/pnl?user=") && u.includes("status=closed")));
  assert.ok(urls.some(u => u.includes("/positions/OpenPool/pnl?user=") && u.includes("status=open")));
});

test("census pass backfills first, survives a failing wallet and stores results", async () => {
  const dir = tempDir();
  const lookbacks = [];
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes(W2)) return { ok: false, status: 500 };
    if (u.includes("/portfolio?")) {
      return { ok: true, json: async () => ({ hasNext: false, pools: [{ ...POOL, lastClosedAt: (NOW - 100 * HOUR) / 1000 }] }) };
    }
    if (u.includes("/portfolio/open")) return { ok: true, json: async () => ({ pools: [] }) };
    return { ok: true, json: async () => ({ positions: [rawPosition({ id: "x", openedH: -101, closedH: -100 })] }) };
  };
  const logs = [];
  const census = createFleetCensus({ rules: config.fleetCensus, wallets: [{ address: W1 }, { address: W2 }], fetchImpl, now: () => NOW, dir, pace: fn => fn(), log: m => logs.push(m), schedule: (fn, ms) => { lookbacks.push(ms); return 1; } });
  await census.start();
  const store = loadFleetStore(dir);
  assert.deepEqual(Object.keys(store.positions), ["x"], "100h-old close kept by the 144h backfill");
  assert.equal(store.wallets, 2);
  assert.ok(logs.some(l => /1\/2 wallets/.test(l)));
  assert.equal(lookbacks[0], 60 * 60_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seaHistory computes one reading per day", () => {
  const rows = [];
  const start = Date.UTC(2025, 9, 1) / 1000;
  for (let i = 0; i < 460; i++) rows.push([start + i * 86400, i === 459 ? 50e6 : 100e6]);
  const h = seaHistory(parseVolumeChart({ totalDataChart: rows }).points, { ...config.seaState, calibration: [] }, 60);
  assert.equal(h.length, 60);
  assert.equal(h.at(-1).pct, -50);
  assert.equal(h.at(-2).pct, 0);
});

test("decision log readers", () => {
  const dir = tempDir();
  const at = h => new Date(NOW + h * HOUR).toISOString();
  const lines = [
    { type: "decision", id: "d1", mint: "M1", at: at(-1), decision: "proposal", trigger: { source: "gmgn", post: { symbol: "AAA", marketCapUsd: 1e6, volume5mUsd: 2e5 } }, fdvUsd: 1e6 },
    { type: "decision", id: "d2", mint: "M2", at: at(-2), decision: "skip", reason: "crashGuard: quote 63.2% below 30m high", trigger: { source: "fabriq", post: { fdvUsd: 3e6 } } },
    { type: "decision", id: "d3", mint: "M3", at: at(-3), decision: "skip", reason: "crashGuard: quote 70.1% below 30m high", trigger: { source: "gmgn", post: {} } },
    { type: "decision", id: "d4", mint: "M2", at: at(-4), decision: "pass", trigger: { source: "fabriq", post: {} } },
    { type: "exit", decisionId: "dX", at: at(-1), pnlPct: 2, holdMs: 20 * 60_000 },
    { type: "decision", mint: "OLD", at: at(-30), decision: "skip" },
  ];
  fs.writeFileSync(path.join(dir, "decisions-2026-11-27.jsonl"), lines.filter(l => l.at.startsWith("2026-11-27")).map(l => JSON.stringify(l)).join("\n") + "\ntorn{\n");
  fs.writeFileSync(path.join(dir, "decisions-2026-11-26.jsonl"), lines.filter(l => l.at.startsWith("2026-11-26")).map(l => JSON.stringify(l)).join("\n") + "\n");
  const records = readDecisions(dir, NOW - 24 * HOUR, NOW);
  assert.equal(records.length, 5);
  const t = thomasActivity(records, NOW);
  assert.deepEqual(t.kinds, { proposal: 1, pass: 1, skip: 2 });
  assert.deepEqual(t.sources, { gmgn: 2, fabriq: 2 });
  assert.deepEqual(t.topSkipReasons, [{ reason: "crashGuard: quote #% below #m high", n: 2 }]);
  assert.equal(t.proposals[0].symbol, "AAA");
  assert.equal(t.proposals[0].open, true);
  assert.equal(t.minutesSinceLastScreening, 60);
  assert.equal(t.exits.byHold[0].n, 1);
  const trig = recentTriggers(records);
  assert.deepEqual(trig.map(r => r.mint), ["M1", "M2", "M3"]);
  assert.equal(trig[1].marketCapUsd, 3e6);
  assert.equal(reasonKey("no pool for 9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey"), "no pool for <mint>");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseHotPools keeps SOL pools with real TVL, ranked by fee/TVL", () => {
  const pool = (name, tvl, fee1h, quote = "SOL") => ({ address: name, name, tvl, fees: { "1h": fee1h }, volume: { "1h": fee1h * 50 }, token_y: { symbol: quote }, token_x: { market_cap: 1e6 }, pool_config: { bin_step: 100, base_fee_pct: 2 }, created_at: NOW - 2 * 86_400_000 });
  const rows = parseHotPools({ data: [pool("dust", 3, 100), pool("A", 10_000, 100), pool("B", 50_000, 2_000), pool("usdc", 50_000, 9_000, "USDC")] }, { now: NOW });
  assert.deepEqual(rows.map(r => r.name), ["B", "A"]);
  assert.equal(rows[0].feeTvl1hPct, 4);
  assert.equal(Math.round(rows[0].ageDays), 2);
});

test("snapshot builds even when every external source is down", async () => {
  const dir = tempDir();
  const build = createSnapshotBuilder({ config, fetchImpl: async () => ({ ok: false, status: 503 }), dir, decisionsPath: dir, now: () => NOW });
  const snap = await build();
  assert.equal(snap.sea.ok, false);
  assert.equal(snap.signals.hotPools.ok, false);
  assert.equal(snap.thomas.screenings, 0);
  assert.equal(snap.weekly, null);
  assert.equal(snap.pulse.today.opened, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server serves the page and snapshot, GET only, token when not loopback", async () => {
  const snap = { ok: 1 };
  assert.equal(startDashboard({ rules: { host: "0.0.0.0", port: 0, token: "" }, buildSnapshot: async () => snap }), null, "public bind without a token refuses to start");
  const handle = startDashboard({ rules: { host: "127.0.0.1", port: 0, token: "s3cret" }, buildSnapshot: async () => snap });
  await new Promise(r => handle.server.once("listening", r));
  const base = `http://127.0.0.1:${handle.server.address().port}`;
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/snapshot?token=s3cret`)).json(), snap);
  const page = await fetch(`${base}/?token=s3cret`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Thomas Deck<\/title>/);
  assert.equal((await fetch(`${base}/api/snapshot?token=s3cret`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/nope?token=s3cret`)).status, 404);
  await handle.close();
});
