// Weekly coin-cycle report: aggregates per-coin cycle metrics into medians and
// percentiles by market cap bucket, trigger source and sea state, turns the p75
// dump depth into a range width in bins, saves state/weekly-YYYY-Www.json and
// posts a short Telegram summary. Read-only; it never changes Thomas's config.

import fs from "node:fs";
import path from "node:path";
import { stateDir, decisionsDir } from "./paths.js";
import { createPacer, cycleMetrics, loadCandles, loadTriggers } from "./coin-cycles.js";
import { seaStateFile } from "./sea-state.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

function spread(values) {
  return { p50: percentile(values, 0.5), p75: percentile(values, 0.75), p90: percentile(values, 0.9) };
}

/** Bins below the active bin needed to cover a drop of `depthPct` at `binStep` bps. */
export function binsForDepth(depthPct, binStep) {
  const d = Math.min(99, Math.max(0, depthPct)) / 100;
  if (d === 0) return 0;
  return Math.ceil(Math.log(1 - d) / Math.log(1 - binStep / 10_000));
}

export function rangeAdvice(depthPct, { binSteps = [80, 100, 125, 250], minBins = 35, maxSingleTxBins = 69 } = {}) {
  if (depthPct == null) return null;
  return binSteps.map(step => {
    const bins = binsForDepth(depthPct, step);
    return { binStep: step, bins, useBins: Math.max(minBins, bins), widePath: Math.max(minBins, bins) > maxSingleTxBins };
  });
}

export function mcBucket(mc, edges = [1e6, 5e6, 20e6]) {
  if (mc == null) return "unknown";
  const label = n => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`);
  for (let i = 0; i < edges.length; i++) {
    if (mc < edges[i]) return i === 0 ? `<${label(edges[0])}` : `${label(edges[i - 1])}–${label(edges[i])}`;
  }
  return `>${label(edges[edges.length - 1])}`;
}

/** Band on the trigger's UTC day, falling back to the day before. */
export function seaBandFor(at, dir) {
  for (const offset of [0, 1]) {
    const day = new Date(at - offset * DAY_MS).toISOString().slice(0, 10);
    const file = seaStateFile(day, dir);
    if (!fs.existsSync(file)) continue;
    try { return JSON.parse(fs.readFileSync(file, "utf8")).band ?? null; } catch { /* skip */ }
  }
  return null;
}

export function summarize(rows, rules) {
  const metric = key => rows.map(r => r[key]);
  return {
    n: rows.length,
    runMultiple: spread(metric("runMultiple")),
    minutesToPeak: spread(metric("minutesToPeak")),
    dumpFromPeakPct: spread(metric("dumpFromPeakPct")),
    deepestFromEntryPct: spread(metric("deepestFromEntryPct")),
    // Dead: fell far enough to bounce and never did. Coins that held up are not dead.
    neverBouncedShare: rows.length ? rows.filter(r => r.bounced === false).length / rows.length : null,
    dumpedShare: rows.length ? rows.filter(r => r.bounced != null).length / rows.length : null,
    retraceShare: spread(metric("retraceShare")),
    volumeDecay: spread(metric("volumeDecay")),
    range: rangeAdvice(percentile(metric("deepestFromEntryPct"), 0.75), rules),
  };
}

function groupBy(rows, keyOf) {
  const groups = {};
  for (const row of rows) (groups[keyOf(row)] ||= []).push(row);
  return groups;
}

export function buildWeeklyReport(coins, { rules, from, to, skipped = 0, failures = {} }) {
  const ok = coins.filter(c => c.ok);
  const by = keyOf => Object.fromEntries(Object.entries(groupBy(ok, keyOf)).map(([k, rows]) => [k, summarize(rows, rules)]));
  return {
    type: "weekly-coin-cycles",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    windowHours: rules.windowHours,
    bouncePct: rules.bouncePct,
    triggers: coins.length + skipped,
    measured: ok.length,
    failures,
    all: summarize(ok, rules),
    byMarketCap: by(c => c.bucket),
    bySource: by(c => c.source),
    bySeaState: by(c => c.seaBand ?? "unknown"),
    coins: coins.map(({ candles, ...rest }) => rest),
  };
}

/** ISO week label, e.g. 2026-W48. */
export function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday - jan1) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const pct = v => (v == null ? "?" : `${Math.round(v)}%`);
const mult = v => (v == null ? "?" : `${v.toFixed(1)}×`);
const mins = v => (v == null ? "?" : v >= 120 ? `${(v / 60).toFixed(1)}h` : `${Math.round(v)}m`);

export function formatWeeklyReport(report, { week, seaLine = null } = {}) {
  const lines = [`⚓ Coin cycles ${week} · triggers ${report.from.slice(5, 10)}→${report.to.slice(5, 10)}`];
  if (seaLine) lines.push(seaLine);
  lines.push(`${report.measured}/${report.triggers} coins measured · ${report.windowHours}h window · bounce = +${report.bouncePct}% off the low`);
  const a = report.all;
  if (!a.n) {
    lines.push("No coins had a full window this week.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`All: run ${mult(a.runMultiple.p50)} (p75 ${mult(a.runMultiple.p75)}) in ${mins(a.minutesToPeak.p50)} · dump below entry p50 ${pct(a.deepestFromEntryPct.p50)} / p75 ${pct(a.deepestFromEntryPct.p75)} · never bounced ${pct(a.neverBouncedShare * 100)}`);
  lines.push("");
  lines.push("By market cap at trigger:");
  for (const [bucket, s] of Object.entries(report.byMarketCap)) {
    const range = (s.range || []).map(r => `${r.useBins}${r.widePath ? "*" : ""}@${r.binStep}`).join(" ");
    lines.push(`${bucket} (n=${s.n}): run ${mult(s.runMultiple.p50)} · dump ${pct(s.deepestFromEntryPct.p50)}/${pct(s.deepestFromEntryPct.p75)} · dead ${pct(s.neverBouncedShare * 100)} · bins ${range}`);
  }
  const seas = Object.entries(report.bySeaState).filter(([k]) => k !== "unknown");
  if (seas.length) {
    lines.push("");
    lines.push("By sea state:");
    for (const [band, s] of seas) lines.push(`${band} (n=${s.n}): run ${mult(s.runMultiple.p50)} · dump p75 ${pct(s.deepestFromEntryPct.p75)} · dead ${pct(s.neverBouncedShare * 100)}`);
  }
  lines.push("");
  lines.push("bins = p75 dump depth at bin step, floor 35; * = over 69, wide path. Suggestion only.");
  return lines.join("\n");
}

/** Measure every trigger in [from, to). Failures are counted by reason, never fatal. */
export async function measureWeek({ rules, from, to, decisionsPath = decisionsDir(), dir = stateDir(), fetchImpl = fetch, pace, log = () => {} }) {
  const triggers = loadTriggers(decisionsPath, from, to);
  const capped = triggers.slice(0, rules.maxCoins);
  const failures = {};
  const coins = [];
  const fail = reason => { failures[reason] = (failures[reason] || 0) + 1; };
  for (const trigger of capped) {
    let loaded;
    try {
      loaded = await loadCandles(trigger, { fetchImpl, pace, cacheDir: path.join(dir, "candles"), windowHours: rules.windowHours });
    } catch (error) {
      fail(error.message);
      continue;
    }
    if (!loaded.ok) { fail(loaded.reason); continue; }
    const metrics = cycleMetrics(loaded.candles, { at: trigger.at, windowHours: rules.windowHours, bouncePct: rules.bouncePct });
    if (!metrics.ok) { fail(metrics.reason); continue; }
    coins.push({
      ...trigger,
      pool: loaded.pool,
      bucket: mcBucket(trigger.marketCapUsd, rules.mcBuckets),
      seaBand: seaBandFor(trigger.at, dir),
      peakMarketCapUsd: trigger.marketCapUsd != null ? trigger.marketCapUsd * metrics.runMultiple : null,
      ...metrics,
    });
  }
  log(`measured ${coins.length}/${triggers.length} triggers${triggers.length > capped.length ? ` (capped at ${rules.maxCoins})` : ""}`);
  return buildWeeklyReport(coins, { rules, from, to, skipped: triggers.length - coins.length, failures });
}

export function weeklyFile(week, dir = stateDir()) {
  return path.join(dir, `weekly-${week}.json`);
}

/** Start of this week's run (Monday at runAtUtc) at or before `now`. */
export function lastWeeklyRun(now, hour, minute) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  let run = monday + (hour * 60 + minute) * 60_000;
  if (run > now) run -= 7 * DAY_MS;
  return run;
}

/**
 * Runs every Monday at rules.runAtUtc. The week covers triggers from
 * [run - 7d - window, run - window), so every coin has its full window of
 * candles. On start it runs once if this week's file is missing.
 */
export function createWeeklyScheduler({
  rules,
  fetchImpl = fetch,
  now = Date.now,
  notify = async () => {},
  log = () => {},
  dir = stateDir(),
  decisionsPath = decisionsDir(),
  pace = createPacer(rules.requestGapMs),
  schedule = (fn, ms) => setTimeout(fn, ms),
  clear = id => clearTimeout(id),
} = {}) {
  let stopped = false;
  let timer = null;
  let running = false;
  const [hour, minute] = String(rules.runAtUtc || "02:00").split(":").map(Number);

  function scheduleNext() {
    if (stopped) return;
    const t = now();
    const next = lastWeeklyRun(t, hour, minute) + 7 * DAY_MS;
    // setTimeout tops out near 24.8 days; a week fits.
    timer = schedule(() => run(), Math.max(1000, next - t));
  }

  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      const runAt = lastWeeklyRun(now(), hour, minute);
      const week = isoWeek(runAt);
      const file = weeklyFile(week, dir);
      if (fs.existsSync(file)) {
        log(`${week} already recorded`);
      } else {
        const to = runAt - rules.windowHours * HOUR_MS;
        const from = to - 7 * DAY_MS;
        const report = await measureWeek({ rules, from, to, decisionsPath, dir, fetchImpl, pace, log });
        report.week = week;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2));
        fs.renameSync(`${file}.tmp`, file);
        const text = formatWeeklyReport(report, { week });
        log(`${week}: ${report.measured}/${report.triggers} coins → ${path.basename(file)}`);
        if (rules.notify) await notify(text);
      }
    } catch (error) {
      log(`weekly report failed: ${error.message}`);
    } finally {
      running = false;
    }
    scheduleNext();
  }

  return {
    start() {
      const runAt = lastWeeklyRun(now(), hour, minute);
      if (!fs.existsSync(weeklyFile(isoWeek(runAt), dir))) return run();
      scheduleNext();
      return Promise.resolve();
    },
    stop() { stopped = true; if (timer != null) clear(timer); timer = null; },
  };
}
