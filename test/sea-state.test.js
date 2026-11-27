import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  bandFor,
  calibrationFactor,
  computeSeaIndex,
  createSeaStateScheduler,
  fetchSeaState,
  formatSeaLine,
  msUntilUtc,
  parseFearGreed,
  parseVolumeChart,
  seaStateFile,
} from "../standalone/sea-state.js";

const rules = config.seaState;
const DAY = 86_400;
const START = Date.UTC(2025, 9, 1) / 1000; // 2025-10-01

// 401 days: 400 history days at $100M, then a last day of `last`.
function chart(last, value = 100e6, days = 400) {
  const rows = [];
  for (let i = 0; i < days; i++) rows.push([START + i * DAY, value]);
  rows.push([START + days * DAY, last]);
  return { totalDataChart: rows };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meridian-sea-"));
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("sea state defaults", () => {
  assert.equal(rules.enabled, true);
  assert.equal(rules.notify, true);
  assert.equal(rules.runAtUtc, "01:30");
  assert.equal(rules.lookbackDays, 400);
  assert.deepEqual(rules.calibration, [{ until: "2026-11-04", factor: 1.42 }, { factor: 1.01 }]);
  assert.match(rules.volumeUrl, /^https:\/\/api\.llama\.fi\/summary\/dexs\/meteora-dlmm/);
});

test("bands follow the LiquidFleet cut-offs", () => {
  assert.equal(bandFor(-67), "Dead calm");
  assert.equal(bandFor(-60), "Dead calm");
  assert.equal(bandFor(-59.9), "Smooth");
  assert.equal(bandFor(-30), "Smooth");
  assert.equal(bandFor(0), "Normal");
  assert.equal(bandFor(5), "Normal");
  assert.equal(bandFor(20), "Choppy");
  assert.equal(bandFor(45.1), "Storm");
});

test("calibration picks the first step whose cut-off is after the day", () => {
  assert.equal(calibrationFactor("2026-11-03", rules.calibration), 1.42);
  assert.equal(calibrationFactor("2026-11-04", rules.calibration), 1.01);
  assert.equal(calibrationFactor("2026-11-26", []), 1);
});

test("parseVolumeChart keeps one point per UTC day and drops bad rows", () => {
  const parsed = parseVolumeChart({ totalDataChart: [[START, 5], [START, 7], [START + DAY, null], ["x", 1], [START + 2 * DAY, 9]] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.points.map(p => [p.day, p.volumeUsd]), [["2025-10-01", 7], ["2025-10-03", 9]]);
  assert.equal(parseVolumeChart({}).ok, false);
});

test("computeSeaIndex compares the last day with the previous lookback days", () => {
  const { points } = parseVolumeChart(chart(45e6));
  const r = computeSeaIndex(points, { lookbackDays: 400, calibration: [] });
  assert.equal(r.ok, true);
  assert.equal(r.historyDays, 400);
  assert.equal(Math.round(r.rawPct), -55);
  assert.equal(r.band, "Smooth");
});

test("calibration lifts old history and deepens the reading (2026-11-26 shape)", () => {
  // Old days counted short before the cut-off: raw -55%, calibrated about -67%.
  const rows = [];
  const cut = Date.UTC(2026, 10, 4) / 1000;
  const last = Date.UTC(2026, 10, 26) / 1000;
  for (let t = last - 400 * DAY; t < last; t += DAY) rows.push([t, 173.4e6]);
  rows.push([last, 78.6e6]);
  const { points } = parseVolumeChart({ totalDataChart: rows });
  const r = computeSeaIndex(points, rules);
  assert.equal(r.day, "2026-11-26");
  assert.equal(Math.round(r.rawPct), -55);
  assert.ok(r.pct < -64 && r.pct > -70, `calibrated ${r.pct}`);
  assert.equal(r.band, "Dead calm");
  assert.ok(points.some(p => p.ms < cut * 1000));
});

test("computeSeaIndex refuses thin history", () => {
  const { points } = parseVolumeChart(chart(1, 1, 10));
  assert.equal(computeSeaIndex(points, { lookbackDays: 400 }).ok, false);
});

test("parseFearGreed reads alternative.me", () => {
  assert.deepEqual(parseFearGreed({ data: [{ value: "12", value_classification: "Extreme Fear" }] }), { value: 12, label: "Extreme Fear" });
  assert.equal(parseFearGreed({ data: [] }), null);
});

test("formatSeaLine is one Telegram line", () => {
  const line = formatSeaLine({ day: "2026-11-26", band: "Dead calm", pct: -67.3, rawPct: -54.6, calibratedVolumeUsd: 79.4e6, avgUsd: 242.9e6, historyDays: 400, fearGreed: { value: 12, label: "Extreme Fear" } });
  assert.equal(line, "🌊 Sea state 26 Nov: Dead calm −67% (raw −55%) · DLMM $79.4M vs 400d avg $242.9M · Fear & Greed 12 (Extreme Fear)");
});

test("fetchSeaState survives a Fear & Greed outage and flags a stale day", async () => {
  const fetchImpl = async url => (String(url).includes("llama") ? jsonResponse(chart(45e6)) : jsonResponse({}, 500));
  const lastDay = START + 400 * DAY;
  const fresh = await fetchSeaState({ ...rules, calibration: [] }, { fetchImpl, now: (lastDay + DAY + 3600) * 1000 });
  assert.equal(fresh.fearGreed, null);
  assert.equal(fresh.stale, false);
  const stale = await fetchSeaState({ ...rules, calibration: [] }, { fetchImpl, now: (lastDay + 3 * DAY) * 1000 });
  assert.equal(stale.stale, true);
});

test("msUntilUtc rolls to tomorrow once the time has passed", () => {
  const t = Date.UTC(2026, 10, 27, 1, 0);
  assert.equal(msUntilUtc(t, 1, 30), 30 * 60_000);
  assert.equal(msUntilUtc(Date.UTC(2026, 10, 27, 2, 0), 1, 30), 23.5 * 3600_000);
});

test("scheduler catches up after a restart, writes once and posts once", async () => {
  const dir = tempDir();
  const lastDay = START + 400 * DAY;
  const now = () => (lastDay + DAY) * 1000 + 2 * 3600_000; // 02:00 UTC the day after the last point
  const posted = [];
  const scheduled = [];
  const fetchImpl = async url => (String(url).includes("llama") ? jsonResponse(chart(45e6)) : jsonResponse({ data: [{ value: "40", value_classification: "Fear" }] }));
  const make = () => createSeaStateScheduler({
    rules: { ...rules, calibration: [] },
    fetchImpl,
    now,
    dir,
    notify: async text => { posted.push(text); },
    schedule: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    clear: () => {},
  });
  await make().start();
  const day = new Date(lastDay * 1000).toISOString().slice(0, 10);
  assert.ok(fs.existsSync(seaStateFile(day, dir)));
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Smooth −55%/);
  assert.equal(scheduled.at(-1), 23.5 * 3600_000);

  // Second process start the same day: file exists, so no run and no post.
  await make().start();
  assert.equal(posted.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scheduler retries while DefiLlama has not closed yesterday", async () => {
  const dir = tempDir();
  const lastDay = START + 400 * DAY;
  const now = () => (lastDay + 2 * DAY) * 1000 + 2 * 3600_000; // yesterday missing
  const posted = [];
  const pending = [];
  const scheduler = createSeaStateScheduler({
    rules: { ...rules, calibration: [], maxRetries: 1, retryMin: 30 },
    fetchImpl: async url => (String(url).includes("llama") ? jsonResponse(chart(45e6)) : jsonResponse({}, 500)),
    now,
    dir,
    notify: async text => { posted.push(text); },
    schedule: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    clear: () => {},
  });
  await scheduler.start();
  assert.equal(posted.length, 0);
  assert.equal(pending[0].ms, 30 * 60_000);
  await pending[0].fn();
  assert.equal(posted.length, 1);
  assert.match(posted[0], /⚠️ latest DefiLlama day/);
  scheduler.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
