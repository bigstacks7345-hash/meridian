// Fleet census: what a fleet of tracked LP wallets did on Meteora DLMM.
// Pulls each wallet's recent positions from Meteora's public datapi
// (/portfolio, /portfolio/open, /positions/<pool>/pnl) once an hour, keeps a
// rolling 7-day store, and computes LP Pulse style stats: opens, closes,
// green share, median gain, hold-time results, range depth, most opened pools.
//
// Wallet universe: Thomas's watched wallets plus data/fleet-wallets.json.
// Read-only. It never signs.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";
import { repoPath } from "../repo-root.js";

const DATAPI = "https://dlmm.datapi.meteora.ag";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const num = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

export function fleetWallets(ownerWallets = [], file = repoPath("data/fleet-wallets.json")) {
  const out = new Map();
  for (const address of ownerWallets) if (typeof address === "string") out.set(address, { address, label: "watched" });
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const row of Array.isArray(list?.wallets) ? list.wallets : []) {
      if (typeof row?.address === "string" && !out.has(row.address)) out.set(row.address, { address: row.address, label: row.label || "elite" });
    }
  } catch { /* the bundled list is optional */ }
  return [...out.values()];
}

/** Depth below the active price that `bins` bins span at `binStep` bps, in percent. */
export function depthForBins(bins, binStep) {
  if (!(bins > 0) || !(binStep > 0)) return null;
  return (1 - Math.pow(1 + binStep / 10_000, -bins)) * 100;
}

/** One datapi position + its pool context → a flat record. */
export function normalizePosition(raw, pool, wallet) {
  const created = num(raw?.createdAt);
  if (!raw?.positionAddress || created == null) return null;
  const closed = raw.isClosed ? num(raw.closedAt) : null;
  const depX = num(raw.allTimeDeposits?.tokenX?.amountSol) ?? 0;
  const depY = num(raw.allTimeDeposits?.tokenY?.amountSol) ?? 0;
  const binStep = num(pool?.binStep);
  const bins = Number.isFinite(raw.upperBinId - raw.lowerBinId) ? raw.upperBinId - raw.lowerBinId + 1 : null;
  const side = depX <= 1e-9 && depY > 0 ? "sol" : depY <= 1e-9 && depX > 0 ? "token" : "both";
  return {
    id: raw.positionAddress,
    wallet,
    pool: pool?.poolAddress ?? null,
    name: pool?.tokenX && pool?.tokenY ? `${pool.tokenX}-${pool.tokenY}` : null,
    binStep,
    baseFee: num(pool?.baseFee),
    quoteIsSol: pool?.tokenYMint === "So11111111111111111111111111111111111111112",
    openedAt: created * 1000,
    closedAt: closed != null ? closed * 1000 : null,
    side,
    depositSol: depX + depY,
    bins,
    depthPct: side === "sol" ? depthForBins(bins, binStep) : null,
    pnlSolPct: num(raw.pnlSolPctChange),
    pnlSol: num(raw.pnlSol),
  };
}

async function getJson(fetchImpl, pace, url) {
  const res = await pace(() => fetchImpl(url, { headers: { accept: "application/json" } }));
  if (!res?.ok) throw new Error(`datapi status ${res?.status ?? "unknown"}`);
  return res.json();
}

/**
 * Positions for one wallet: closed positions in pools it closed in within
 * `lookbackMs`, plus every open position. Capped per wallet so a bot wallet
 * with thousands of pools cannot stall the pass.
 */
export async function fetchWalletPositions(wallet, { fetchImpl = fetch, pace = fn => fn(), now = Date.now(), lookbackMs = 2 * DAY, maxPools = 20, maxPages = 3 } = {}) {
  const since = (now - lookbackMs) / 1000;
  const pools = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const body = await getJson(fetchImpl, pace, `${DATAPI}/portfolio?user=${wallet}&page=${page}&page_size=50`);
    const rows = Array.isArray(body?.pools) ? body.pools : [];
    let older = false;
    for (const pool of rows) {
      if (num(pool.lastClosedAt) != null && pool.lastClosedAt < since) { older = true; continue; }
      if (pools.size < maxPools) pools.set(pool.poolAddress, { pool, status: "closed" });
    }
    if (older || !body?.hasNext || pools.size >= maxPools) break;
  }
  const open = await getJson(fetchImpl, pace, `${DATAPI}/portfolio/open?user=${wallet}`);
  const openPools = (Array.isArray(open?.pools) ? open.pools : []).slice(0, maxPools).map(pool => ({ pool, status: "open" }));

  const out = [];
  for (const { pool, status } of [...pools.values(), ...openPools]) {
    const body = await getJson(fetchImpl, pace, `${DATAPI}/positions/${pool.poolAddress}/pnl?user=${wallet}&status=${status}&pageSize=50&page=1`);
    for (const raw of Array.isArray(body?.positions) ? body.positions : []) {
      const row = normalizePosition(raw, pool, wallet);
      if (!row) continue;
      if (status === "closed" && (row.closedAt == null || row.closedAt < now - lookbackMs)) continue;
      out.push(row);
    }
  }
  return out;
}

export function fleetStoreFile(dir = stateDir()) {
  return path.join(dir, "fleet-positions.json");
}

export function loadFleetStore(dir = stateDir()) {
  try { return JSON.parse(fs.readFileSync(fleetStoreFile(dir), "utf8")); } catch { return { updatedAt: null, wallets: 0, positions: {} }; }
}

/** Merge fresh rows into the store and drop anything older than `keepMs`. */
export function mergeFleet(store, rows, { now = Date.now(), keepMs = 7 * DAY, wallets = null } = {}) {
  const positions = { ...(store?.positions || {}) };
  for (const row of rows) positions[row.id] = row;
  for (const [id, row] of Object.entries(positions)) {
    const last = row.closedAt ?? now;
    if (last < now - keepMs && row.openedAt < now - keepMs) delete positions[id];
  }
  return { updatedAt: new Date(now).toISOString(), wallets: wallets ?? store?.wallets ?? 0, positions };
}

export function saveFleetStore(store, dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fleetStoreFile(dir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(store));
  fs.renameSync(`${file}.tmp`, file);
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const share = (rows, test) => (rows.length ? rows.filter(test).length / rows.length : null);

export const HOLD_BUCKETS = [
  { label: "< 30 min", max: 30 * 60_000 },
  { label: "30 min to 2 h", max: 2 * HOUR },
  { label: "2 to 12 h", max: 12 * HOUR },
  { label: "12 to 24 h", max: DAY },
  { label: "over 1 day", max: Infinity },
];

export const DEPTH_BUCKETS = [
  { label: "under 20%", max: 20 },
  { label: "20 to 45%", max: 45 },
  { label: "45 to 55%", max: 55 },
  { label: "55 to 80%", max: 80 },
  { label: "80% or more", max: Infinity },
];

function bucketOf(buckets, value) {
  return buckets.find(b => value < b.max)?.label ?? null;
}

function dayStats(rows, from, to) {
  const opened = rows.filter(r => r.openedAt >= from && r.openedAt < to);
  const closed = rows.filter(r => r.closedAt != null && r.closedAt >= from && r.closedAt < to);
  const active = new Set([...opened.map(r => r.wallet), ...rows.filter(r => r.openedAt < to && (r.closedAt == null || r.closedAt >= from)).map(r => r.wallet)]);
  const reopened = closed.filter(c => rows.some(o => o.wallet === c.wallet && o.pool === c.pool && o.id !== c.id && o.openedAt >= c.closedAt && o.openedAt - c.closedAt <= 2 * 60_000));
  const solOpened = opened.filter(r => r.side === "sol");
  const byHold = HOLD_BUCKETS.map(b => {
    const rs = closed.filter(r => bucketOf(HOLD_BUCKETS, r.closedAt - r.openedAt) === b.label);
    return { label: b.label, n: rs.length, green: share(rs, r => r.pnlSolPct > 0), medianGainPct: median(rs.map(r => r.pnlSolPct)) };
  });
  const solClosed = closed.filter(r => r.side === "sol" && r.depthPct != null);
  const solOpenedDepth = solOpened.filter(r => r.depthPct != null);
  const byDepth = DEPTH_BUCKETS.map(b => {
    const rs = solClosed.filter(r => bucketOf(DEPTH_BUCKETS, r.depthPct) === b.label);
    return {
      label: b.label,
      n: rs.length,
      green: share(rs, r => r.pnlSolPct > 0),
      openShare: share(solOpenedDepth, r => bucketOf(DEPTH_BUCKETS, r.depthPct) === b.label),
    };
  });
  return {
    opened: opened.length,
    closed: closed.length,
    activeLps: active.size,
    closedGreen: share(closed, r => r.pnlSolPct > 0),
    medianGainPct: median(closed.map(r => r.pnlSolPct)),
    medianHoldMin: median(closed.map(r => (r.closedAt - r.openedAt) / 60_000)),
    reopenedShare: closed.length ? reopened.length / closed.length : null,
    setup: {
      sol: share(opened, r => r.side === "sol"),
      both: share(opened, r => r.side === "both"),
      token: share(opened, r => r.side === "token"),
    },
    medianSizeSol: median(opened.map(r => r.depositSol)),
    medianDepthPct: median(solOpenedDepth.map(r => r.depthPct)),
    byHold,
    byDepth,
  };
}

/** LP Pulse over the 24h ending at `now`, with the 24h before for comparison. */
export function computePulse(store, now = Date.now()) {
  const rows = Object.values(store?.positions || {});
  const today = dayStats(rows, now - DAY, now);
  const yesterday = dayStats(rows, now - 2 * DAY, now - DAY);
  const pools = new Map();
  for (const r of rows.filter(r => r.openedAt >= now - DAY)) {
    const p = pools.get(r.pool) || { pool: r.pool, name: r.name, binStep: r.binStep, baseFee: r.baseFee, wallets: new Set(), sol: 0, opens: 0 };
    p.wallets.add(r.wallet);
    p.sol += r.depositSol || 0;
    p.opens += 1;
    pools.set(r.pool, p);
  }
  const topPools = [...pools.values()]
    .map(p => ({ ...p, lps: p.wallets.size, wallets: undefined }))
    .sort((a, b) => b.lps - a.lps || b.sol - a.sol)
    .slice(0, 5);
  const opensByDay = [];
  for (let i = 4; i >= 0; i--) {
    const end = now - i * DAY;
    opensByDay.push({ day: new Date(end - DAY).toISOString().slice(0, 10), opened: rows.filter(r => r.openedAt >= end - DAY && r.openedAt < end).length });
  }
  return { window: { from: new Date(now - DAY).toISOString(), to: new Date(now).toISOString() }, wallets: store?.wallets ?? 0, positions: rows.length, today, yesterday, topPools, opensByDay };
}

/** Hourly pass over every fleet wallet. A failing wallet is skipped, not fatal. */
export function createFleetCensus({
  rules,
  wallets,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
  dir = stateDir(),
  pace,
  schedule = (fn, ms) => setTimeout(fn, ms),
  clear = id => clearTimeout(id),
} = {}) {
  let stopped = false;
  let timer = null;
  let gap = 0;
  const pacer = pace || (async fn => {
    const wait = gap + rules.requestGapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    gap = Date.now();
    return fn();
  });

  async function run() {
    if (stopped) return;
    try {
      await pass();
    } catch (error) {
      log(`fleet census failed: ${error.message}`);
    }
    if (!stopped) timer = schedule(run, rules.everyMin * 60_000);
  }

  async function pass() {
    const list = typeof wallets === "function" ? wallets() : wallets;
    const t = now();
    const rows = [];
    let failed = 0;
    // The first pass on an empty store backfills, so the 5-day chart is complete from day one.
    const prior = loadFleetStore(dir);
    const lookbackHours = Object.keys(prior.positions || {}).length ? rules.lookbackHours : rules.backfillHours;
    for (const w of list) {
      if (stopped) return;
      try {
        rows.push(...await fetchWalletPositions(w.address, { fetchImpl, pace: pacer, now: t, lookbackMs: lookbackHours * HOUR, maxPools: rules.maxPoolsPerWallet }));
      } catch (error) {
        failed += 1;
        log(`fleet wallet ${w.address.slice(0, 6)} failed: ${error.message}`);
      }
    }
    const store = mergeFleet(loadFleetStore(dir), rows, { now: now(), wallets: list.length });
    saveFleetStore(store, dir);
    log(`fleet census: ${list.length - failed}/${list.length} wallets, ${rows.length} recent positions, ${Object.keys(store.positions).length} stored`);
  }

  return {
    start() { return run(); },
    stop() { stopped = true; if (timer != null) clear(timer); timer = null; },
  };
}
