// Read-only web dashboard for Thomas: sea state, Thomas's own activity, signals,
// the fleet's LP Pulse and the weekly coin cycles. One JSON snapshot endpoint
// that the page polls every 30 seconds.
//
// Serves GET only. Binds to loopback by default; any other host needs a token.
// It never signs, never changes config and never touches wallet material.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, decisionsDir } from "./paths.js";
import { computeSeaIndex, parseFearGreed, parseVolumeChart } from "./sea-state.js";
import { computePulse, loadFleetStore, HOLD_BUCKETS } from "./fleet-census.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const num = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** Daily sea-state readings for the last `days` days, each against its own prior window. */
export function seaHistory(points, rules, days = 60) {
  const out = [];
  for (let end = Math.max(2, points.length - days + 1); end <= points.length; end++) {
    const r = computeSeaIndex(points.slice(0, end), rules);
    if (r.ok) out.push({ day: r.day, pct: Math.round(r.pct * 10) / 10, rawPct: Math.round(r.rawPct * 10) / 10, band: r.band, volumeUsd: Math.round(r.calibratedVolumeUsd), avgUsd: Math.round(r.avgUsd) });
  }
  return out;
}

/** Records from decisions-*.jsonl in [from, to). */
export function readDecisions(dir, from, to) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    const file = path.join(dir, `decisions-${new Date(day).toISOString().slice(0, 10)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const at = Date.parse(record.at);
        if (Number.isFinite(at) && at >= from && at < to) out.push({ ...record, atMs: at });
      } catch { /* skip a torn line */ }
    }
  }
  return out;
}

/** "crashGuard: quote 63.2% below 30m high" → "crashGuard: quote #% below #m high" */
export function reasonKey(reason) {
  if (typeof reason !== "string" || !reason) return "unknown";
  return reason.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<mint>").replace(/\d+(\.\d+)?/g, "#").slice(0, 70);
}

const median = values => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
};

/** Thomas's own last 24h from the decision log. */
export function thomasActivity(records, now = Date.now()) {
  const decisions = records.filter(r => r.type === "decision");
  const exits = records.filter(r => r.type === "exit");
  const kinds = { proposal: 0, pass: 0, skip: 0 };
  const sources = {};
  const reasons = {};
  for (const r of decisions) {
    kinds[r.decision] = (kinds[r.decision] || 0) + 1;
    const source = r.trigger?.source || "wallets";
    sources[source] = (sources[source] || 0) + 1;
    if (r.decision === "skip") {
      const key = reasonKey(r.reason);
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  const exitByDecision = new Set(exits.map(e => e.decisionId).filter(Boolean));
  const proposals = decisions.filter(r => r.decision === "proposal").sort((a, b) => b.atMs - a.atMs);
  const byHold = HOLD_BUCKETS.map(b => {
    const rows = exits.filter(e => Number.isFinite(e.holdMs) && HOLD_BUCKETS.find(x => e.holdMs < x.max)?.label === b.label);
    return { label: b.label, n: rows.length, green: rows.length ? rows.filter(e => e.pnlPct > 0).length / rows.length : null, medianPnlPct: median(rows.map(e => e.pnlPct)) };
  });
  const last = decisions.reduce((m, r) => Math.max(m, r.atMs), 0);
  return {
    screenings: decisions.length,
    kinds,
    sources,
    lastScreeningAt: last ? new Date(last).toISOString() : null,
    minutesSinceLastScreening: last ? Math.round((now - last) / 60_000) : null,
    topSkipReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, n]) => ({ reason, n })),
    proposals: proposals.slice(0, 8).map(r => ({
      at: r.at,
      mint: r.mint,
      symbol: r.trigger?.post?.symbol ?? null,
      source: r.trigger?.source ?? "wallets",
      fdvUsd: num(r.fdvUsd),
      range: r.indicators?.range ?? null,
      open: !exitByDecision.has(r.id),
    })),
    exits: { n: exits.length, green: exits.length ? exits.filter(e => e.pnlPct > 0).length / exits.length : null, medianPnlPct: median(exits.map(e => e.pnlPct)), byHold },
  };
}

/** Recent GMGN / Fabriq / wallet triggers, newest first, one per mint. */
export function recentTriggers(records, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const r of records.filter(r => r.type === "decision").sort((a, b) => b.atMs - a.atMs)) {
    if (seen.has(r.mint)) continue;
    seen.add(r.mint);
    const post = r.trigger?.post || {};
    out.push({
      at: r.at,
      mint: r.mint,
      symbol: post.symbol ?? null,
      source: r.trigger?.source ?? "wallets",
      marketCapUsd: num(post.marketCapUsd) ?? num(post.fdvUsd) ?? num(r.fdvUsd),
      volume5mUsd: num(post.volume5mUsd),
      decision: r.decision,
      reason: r.decision === "skip" ? reasonKey(r.reason) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Meteora datapi pools sorted by last-hour fees → SOL pools with real TVL, ranked by fee/TVL. */
export function parseHotPools(body, { minTvlUsd = 5_000, limit = 8, now = Date.now() } = {}) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .filter(p => p?.token_y?.symbol === "SOL" && num(p.tvl) >= minTvlUsd && num(p.fees?.["1h"]) > 0)
    .map(p => ({
      pool: p.address,
      name: p.name,
      binStep: num(p.pool_config?.bin_step),
      baseFeePct: num(p.pool_config?.base_fee_pct),
      tvlUsd: num(p.tvl),
      fees1hUsd: num(p.fees["1h"]),
      volume1hUsd: num(p.volume?.["1h"]),
      feeTvl1hPct: (num(p.fees["1h"]) / num(p.tvl)) * 100,
      marketCapUsd: num(p.token_x?.market_cap),
      ageDays: num(p.created_at) ? (now - num(p.created_at)) / DAY : null,
    }))
    .sort((a, b) => b.feeTvl1hPct - a.feeTvl1hPct)
    .slice(0, limit);
}

function latestWeekly(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(n => /^weekly-\d{4}-W\d{2}\.json$/.test(n)).sort();
  if (!files.length) return null;
  try {
    const report = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8"));
    const { coins, ...summary } = report;
    return { ...summary, coinsMeasured: Array.isArray(coins) ? coins.length : 0 };
  } catch {
    return null;
  }
}

function cached(ttlMs, load) {
  let value = null;
  let at = 0;
  let pending = null;
  return async now => {
    if (value && now - at < ttlMs) return value;
    if (!pending) {
      pending = load().then(v => { value = v; at = Date.now(); return v; }).finally(() => { pending = null; });
    }
    try { return await pending; } catch (error) { if (value) return value; throw error; }
  };
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res?.ok) throw new Error(`${new URL(url).host} status ${res?.status ?? "unknown"}`);
  return res.json();
}

/** Builds snapshots. Each external source is cached and fails on its own. */
export function createSnapshotBuilder({ config, fetchImpl = fetch, dir = stateDir(), decisionsPath = decisionsDir(), now = Date.now } = {}) {
  const sea = cached(HOUR, async () => {
    const parsed = parseVolumeChart(await getJson(fetchImpl, config.seaState.volumeUrl));
    if (!parsed.ok) throw new Error(parsed.reason);
    return seaHistory(parsed.points, config.seaState, 60);
  });
  const fearGreed = cached(HOUR, async () => parseFearGreed(await getJson(fetchImpl, config.seaState.fearGreedUrl)));
  const hotPools = cached(2 * 60_000, async () => parseHotPools(await getJson(fetchImpl, "https://dlmm.datapi.meteora.ag/pools?page_size=50&sort_by=fee_1h:desc"), { now: now() }));

  const settle = async (fn, t) => {
    try { return { ok: true, data: await fn(t) }; } catch (error) { return { ok: false, error: error.message }; }
  };

  return async () => {
    const t = now();
    const records = readDecisions(decisionsPath, t - DAY, t + 60_000);
    const [seaRes, fgRes, poolsRes] = await Promise.all([settle(sea, t), settle(fearGreed, t), settle(hotPools, t)]);
    const fleet = loadFleetStore(dir);
    return {
      generatedAt: new Date(t).toISOString(),
      sea: seaRes.ok ? { ok: true, latest: seaRes.data[seaRes.data.length - 1] ?? null, history: seaRes.data } : seaRes,
      fearGreed: fgRes.ok ? { ok: true, ...(fgRes.data || {}) } : fgRes,
      thomas: thomasActivity(records, t),
      signals: {
        hotPools: poolsRes.ok ? { ok: true, rows: poolsRes.data } : poolsRes,
        triggers: recentTriggers(records),
        eliteOpens: Object.values(fleet.positions || {})
          .filter(p => p.openedAt >= t - 6 * HOUR)
          .sort((a, b) => b.openedAt - a.openedAt)
          .slice(0, 8)
          .map(p => ({ at: new Date(p.openedAt).toISOString(), wallet: p.wallet, name: p.name, pool: p.pool, depositSol: p.depositSol, side: p.side, depthPct: p.depthPct, binStep: p.binStep })),
      },
      pulse: { updatedAt: fleet.updatedAt, ...computePulse(fleet, t) },
      weekly: latestWeekly(dir),
    };
  };
}

export function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Starts the HTTP server. Returns { server, close }. */
export function startDashboard({ rules, buildSnapshot, log = () => {}, htmlPath = path.join(HERE, "dashboard.html") }) {
  if (!isLoopback(rules.host) && !rules.token) {
    log(`dashboard not started: host ${rules.host} needs DASHBOARD_TOKEN`);
    return null;
  }
  let snapshot = null;
  let snapshotAt = 0;
  let building = null;
  const getSnapshot = async () => {
    if (snapshot && Date.now() - snapshotAt < 20_000) return snapshot;
    if (!building) building = buildSnapshot().then(s => { snapshot = s; snapshotAt = Date.now(); return s; }).finally(() => { building = null; });
    return building;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://dashboard.local");
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (req.method !== "GET") {
      res.writeHead(405, headers).end("GET only");
      return;
    }
    if (rules.token && url.searchParams.get("token") !== rules.token) {
      res.writeHead(401, headers).end("token required");
      return;
    }
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(htmlPath));
      } else if (url.pathname === "/api/snapshot") {
        res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify(await getSnapshot()));
      } else {
        res.writeHead(404, headers).end("not found");
      }
    } catch (error) {
      log(`dashboard error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500, headers).end("snapshot failed");
    }
  });
  server.listen(rules.port, rules.host, () => log(`dashboard on http://${rules.host}:${rules.port}/`));
  server.on("error", error => log(`dashboard server error: ${error.message}`));
  return { server, close: () => new Promise(resolve => server.close(() => resolve())) };
}
