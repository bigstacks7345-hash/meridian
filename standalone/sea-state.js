// Daily "sea state" for Meteora DLMM, modeled on LiquidFleet's Sea Index.
// Compares the last closed UTC day's DLMM volume with the average of the
// previous `lookbackDays` days, after calibrating DefiLlama's history, and maps
// the percent difference to a band (Dead calm ... Storm).
//
// Read-only: two public GETs (DefiLlama, alternative.me), one JSON file per day
// under the state directory, and one optional Telegram line. It never signs.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

const DAY_MS = 86_400_000;
const num = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

export const DEFAULT_SEA_BANDS = [
  { name: "Dead calm", maxPct: -60 },
  { name: "Smooth", maxPct: -30 },
  { name: "Normal", maxPct: 5 },
  { name: "Choppy", maxPct: 45 },
  { name: "Storm", maxPct: null },
];

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** DefiLlama /summary/dexs/<slug> → [{ day: "YYYY-MM-DD", ms, volumeUsd }], oldest first, one per day. */
export function parseVolumeChart(body) {
  const chart = body?.totalDataChart;
  if (!Array.isArray(chart)) return { ok: false, reason: "defillama reply has no totalDataChart", points: [] };
  const byDay = new Map();
  for (const entry of chart) {
    const t = num(Array.isArray(entry) ? entry[0] : null);
    const v = num(Array.isArray(entry) ? entry[1] : null);
    if (t == null || v == null || v < 0) continue;
    const ms = t * 1000;
    byDay.set(utcDay(ms), { day: utcDay(ms), ms, volumeUsd: v });
  }
  const points = [...byDay.values()].sort((a, b) => a.ms - b.ms);
  return points.length ? { ok: true, points } : { ok: false, reason: "defillama chart is empty", points: [] };
}

/**
 * Scale factor for a day. `calibration` is an ordered list of
 * { until: "YYYY-MM-DD", factor } with an optional final { factor } default.
 * The first entry whose `until` is after the day applies.
 */
export function calibrationFactor(day, calibration = []) {
  for (const step of calibration) {
    if (!step) continue;
    if (step.until == null || day < step.until) {
      const f = num(step.factor);
      return f != null && f > 0 ? f : 1;
    }
  }
  return 1;
}

export function bandFor(pct, bands = DEFAULT_SEA_BANDS) {
  for (const band of bands) {
    if (band.maxPct == null || pct <= band.maxPct) return band.name;
  }
  return bands[bands.length - 1]?.name ?? "unknown";
}

/**
 * The reading for the latest day in `points`: its volume against the mean of
 * the `lookbackDays` days before it, raw and calibrated.
 */
export function computeSeaIndex(points, { lookbackDays = 400, calibration = [], bands = DEFAULT_SEA_BANDS, minHistoryDays = 30 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return { ok: false, reason: "not enough volume history" };
  const latest = points[points.length - 1];
  const history = points.slice(Math.max(0, points.length - 1 - lookbackDays), points.length - 1);
  if (history.length < minHistoryDays) return { ok: false, reason: `only ${history.length} days of history` };
  const scaled = p => p.volumeUsd * calibrationFactor(p.day, calibration);
  const rawAvg = history.reduce((s, p) => s + p.volumeUsd, 0) / history.length;
  const avg = history.reduce((s, p) => s + scaled(p), 0) / history.length;
  if (!(rawAvg > 0) || !(avg > 0)) return { ok: false, reason: "average volume is zero" };
  const volume = scaled(latest);
  const rawPct = (latest.volumeUsd / rawAvg - 1) * 100;
  const pct = (volume / avg - 1) * 100;
  return {
    ok: true,
    day: latest.day,
    volumeUsd: latest.volumeUsd,
    calibratedVolumeUsd: volume,
    rawAvgUsd: rawAvg,
    avgUsd: avg,
    rawPct,
    pct,
    band: bandFor(pct, bands),
    historyDays: history.length,
  };
}

/** alternative.me /fng/ → { value, label } or null. */
export function parseFearGreed(body) {
  const row = Array.isArray(body?.data) ? body.data[0] : null;
  const value = num(row?.value);
  if (value == null) return null;
  return { value, label: typeof row.value_classification === "string" ? row.value_classification : null };
}

function usd(n) {
  if (n == null) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

function signed(pct) {
  const r = Math.round(pct);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
}

export function formatSeaLine(reading) {
  const date = new Date(`${reading.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const parts = [
    `🌊 Sea state ${date}: ${reading.band} ${signed(reading.pct)} (raw ${signed(reading.rawPct)})`,
    `DLMM ${usd(reading.calibratedVolumeUsd)} vs ${reading.historyDays}d avg ${usd(reading.avgUsd)}`,
  ];
  if (reading.fearGreed) parts.push(`Fear & Greed ${reading.fearGreed.value}${reading.fearGreed.label ? ` (${reading.fearGreed.label})` : ""}`);
  if (reading.stale) parts.push(`⚠️ latest DefiLlama day is ${reading.day}`);
  return parts.join(" · ");
}

async function getJson(fetchImpl, url, label) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res?.ok) throw new Error(`${label} status ${res?.status ?? "unknown"}`);
  return res.json();
}

/** Fetch and compute one reading. Fear & Greed is optional: its failure only drops that field. */
export async function fetchSeaState(rules, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = await getJson(fetchImpl, rules.volumeUrl, "defillama");
  const parsed = parseVolumeChart(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  const reading = computeSeaIndex(parsed.points, rules);
  if (!reading.ok) throw new Error(reading.reason);
  reading.stale = reading.day < utcDay(now - DAY_MS);
  reading.fearGreed = null;
  if (rules.fearGreedUrl) {
    try { reading.fearGreed = parseFearGreed(await getJson(fetchImpl, rules.fearGreedUrl, "fear-greed")); } catch { /* optional */ }
  }
  reading.fetchedAt = new Date(now).toISOString();
  return reading;
}

export function seaStateFile(day, dir = stateDir()) {
  return path.join(dir, `sea-${day}.json`);
}

export function writeSeaState(reading, dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = seaStateFile(reading.day, dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reading, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** Milliseconds until the next HH:MM UTC at or after `now`. */
export function msUntilUtc(now, hour, minute) {
  const d = new Date(now);
  let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  if (target <= now) target += DAY_MS;
  return target - now;
}

/**
 * Runs once a day at rules.runAtUtc. On start it also runs if today's run time
 * has passed and yesterday's reading is not on disk yet, so a restart neither
 * skips a day nor posts twice. If DefiLlama has not closed yesterday yet, it
 * retries every rules.retryMin, up to rules.maxRetries, then saves and posts the
 * stale reading with a warning.
 */
export function createSeaStateScheduler({
  rules,
  fetchImpl = fetch,
  now = Date.now,
  notify = async () => {},
  log = () => {},
  dir = stateDir(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  clear = id => clearTimeout(id),
} = {}) {
  let stopped = false;
  let timer = null;
  const [hour, minute] = String(rules.runAtUtc || "01:30").split(":").map(Number);
  const retryMs = Math.max(1, Number(rules.retryMin) || 30) * 60_000;

  function next(ms) {
    if (!stopped) timer = schedule(() => run(0), ms);
  }

  async function run(attempt) {
    if (stopped) return;
    const t = now();
    const target = utcDay(t - DAY_MS);
    try {
      const reading = await fetchSeaState(rules, { fetchImpl, now: t });
      if (reading.stale && attempt < rules.maxRetries) {
        log(`DefiLlama has ${reading.day}, waiting for ${target}; retry ${attempt + 1}/${rules.maxRetries} in ${Math.round(retryMs / 60_000)}m`);
        if (!stopped) timer = schedule(() => run(attempt + 1), retryMs);
        return;
      }
      if (fs.existsSync(seaStateFile(reading.day, dir))) {
        log(`${reading.day} already recorded`);
      } else {
        const file = writeSeaState(reading, dir);
        const line = formatSeaLine(reading);
        log(`${line} → ${path.basename(file)}`);
        if (rules.notify) await notify(line);
      }
    } catch (error) {
      log(`sea state failed: ${error.message}`);
      if (attempt < rules.maxRetries) {
        if (!stopped) timer = schedule(() => run(attempt + 1), retryMs);
        return;
      }
    }
    next(msUntilUtc(now(), hour, minute));
  }

  return {
    start() {
      const t = now();
      const todayRun = Math.floor(t / DAY_MS) * DAY_MS + (hour * 60 + minute) * 60_000;
      if (t >= todayRun && !fs.existsSync(seaStateFile(utcDay(t - DAY_MS), dir))) return run(0);
      next(msUntilUtc(t, hour, minute));
      return Promise.resolve();
    },
    stop() { stopped = true; if (timer != null) clear(timer); timer = null; },
  };
}
