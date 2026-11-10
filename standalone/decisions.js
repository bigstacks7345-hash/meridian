// Append-only screening and exit snapshots. One JSONL file per UTC day.
// Records are for offline review. They must not contain secrets.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { decisionsDir } from "./paths.js";
import { entryRange, evaluateEntry, lockPoc, selectProfileWindow } from "../strategy/rules.js";

export const DECISION_RETENTION_DAYS = 90;
const SECRET_KEY = /private|secret|apikey|api_key|authorization|password|walletkey|mnemonic|seed/i;

const directoryStore = new AsyncLocalStorage();
let directoryOverride = null;

export function setDecisionDirectory(dir) {
  directoryOverride = dir || null;
}

export function withDecisionDirectory(dir, fn) {
  return directoryStore.run(dir, fn);
}

export function decisionDirectory() {
  return directoryStore.getStore() || directoryOverride || decisionsDir();
}

export function decisionFile(now = Date.now(), dir = decisionDirectory()) {
  return path.join(dir, `decisions-${utcDayKey(now)}.jsonl`);
}

export function utcDayStart(now = Date.now()) {
  return Date.parse(`${utcDayKey(now)}T00:00:00.000Z`);
}

function utcDayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function sanitizeDecision(value) {
  if (Array.isArray(value)) return value.map(sanitizeDecision);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitizeDecision(item);
  }
  return out;
}

export function pruneDecisionLogs(dir = decisionDirectory(), now = Date.now(), keepDays = DECISION_RETENTION_DAYS) {
  if (!fs.existsSync(dir)) return [];
  const oldest = utcDayStart(now) - (keepDays - 1) * 24 * 3600_000;
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (Number.isFinite(day) && day < oldest) {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export function appendDecision(record, now = Date.now()) {
  const dir = decisionDirectory();
  const clean = sanitizeDecision(record);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(decisionFile(now, dir), `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  pruneDecisionLogs(dir, now);
  return clean;
}

function openOnMint(book, mint) {
  return (book || [])
    .filter(position => position?.mint === mint && position.status === "proposed")
    .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
}

function triggerOf(signal) {
  if (signal?.source === "fabriq") {
    const alert = signal.fabriqAlert || {};
    return {
      source: "fabriq",
      post: {
        id: alert.id ?? null,
        symbol: alert.symbol ?? null,
        score: alert.score ?? null,
        pool: alert.pool ?? signal.pool ?? null,
        poolAge: alert.poolAge ?? null,
        fdvUsd: finite(alert.fdvUsd),
        liquidityUsd: finite(alert.liquidityUsd),
        volume5mUsd: finite(alert.volume5mUsd),
        at: alert.at ?? null,
      },
    };
  }
  return {
    source: "wallets",
    wallets: (signal?.events || []).map(event => ({
      wallet: event?.wallet ?? null,
      pool: event?.pool ?? null,
      at: event?.at ?? null,
      depositSol: finite(event?.depositSol),
    })),
  };
}

function indicatorsOf(snapshot, rules) {
  const entry = snapshot ? evaluateEntry(snapshot, rules) : { display: {} };
  const display = entry.display || {};
  const trend = display.supertrend || null;
  const previous = Array.isArray(snapshot?.closed5m) ? snapshot.closed5m[snapshot.closed5m.length - 1] : null;
  const series = Array.isArray(snapshot?.closed1m)
    ? selectProfileWindow(snapshot.closed1m, {
      createdAt: snapshot.createdAt,
      asOf: snapshot.asOf,
      lookbackMs: rules.pocLookbackHours * 3_600_000,
      toleranceMs: rules.pocLaunchToleranceMs,
    })
    : { ok: false };
  const poc = lockPoc(display.profile, snapshot?.livePrice, rules);
  const range = trend?.support != null ? entryRange(snapshot?.livePrice, trend.support, snapshot?.binStep, rules) : null;
  const bars = series.ok ? series.candles : [];
  return {
    priceSol: finite(snapshot?.livePrice),
    supertrend: trend ? { value: finite(trend.value), direction: trend.trend ?? null } : null,
    rsi: finite(display.rsi),
    rsiSma: finite(display.rsiSma),
    volume5mUsd: finite(previous?.v),
    volumeSma20: finite(display.volume?.average),
    poc: {
      price: finite(poc.price),
      valid: poc.valid === true,
      reason: poc.reason ?? null,
      window: series.ok ? {
        from: bars[0]?.t ?? null,
        to: bars[bars.length - 1]?.t ?? null,
        bars: bars.length,
        young: series.young === true,
        hours: rules.pocLookbackHours,
      } : null,
    },
    range: range?.ok ? { upper: range.upper, lower: range.lower } : null,
    bollinger: display.bollinger ? {
      basis: finite(display.bollinger.basis),
      upper: finite(display.bollinger.upper),
      lower: finite(display.bollinger.lower),
    } : null,
    crashDrawdownPct: finite(display.crashGuard?.drawdownPct),
    poolVolToLiq5m: finite(display.poolDepth?.volToLiq),
  };
}

export function decisionKind(result) {
  if (result?.ok && result.proposal) return "proposal";
  if (result?.filtersPassed) return "pass";
  return "skip";
}

export function buildScreeningRecord({ now = Date.now(), signal, snapshot, book = [], rules, result, reason }) {
  const alert = signal?.fabriqAlert || {};
  const open = openOnMint(book, signal?.mint);
  const first = open[0] || null;
  const kind = result ? decisionKind(result) : "skip";
  return {
    type: "decision",
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    mint: signal?.mint ?? null,
    pool: (signal?.source === "fabriq" && signal.pool) || snapshot?.poolAddress || signal?.pool || null,
    trigger: triggerOf(signal),
    position: {
      ordinal: open.length + 1,
      first: first ? {
        id: first.id ?? null,
        decisionId: first.decisionId ?? null,
        ageMs: finite(now - (first.openedAt || now)),
        pnlPct: finite(first.pnlPct),
      } : null,
    },
    indicators: indicatorsOf(snapshot, rules),
    poolAge: alert.poolAge ?? snapshot?.poolAge ?? null,
    fdvUsd: finite(snapshot?.mcapUsd ?? snapshot?.fdvUsd ?? alert.fdvUsd),
    liquidityUsd: finite(snapshot?.liquidityUsd ?? alert.liquidityUsd),
    decision: kind,
    reason: reason || result?.reason || (kind === "proposal" ? "shadow proposal recorded" : null),
  };
}

export function recordScreening(input) {
  const now = input.now ?? Date.now();
  const record = buildScreeningRecord(input);
  appendDecision(record, now);
  return record;
}

export function buildExitRecord({ now = Date.now(), position, reason, pnlPct, exitPrice }) {
  const openedAt = position?.openedAt ?? null;
  const closedAt = position?.closedAt ?? now;
  const entryPrice = finite(position?.entryQuotePrice);
  const pnl = finite(pnlPct ?? position?.pnlPct);
  const derivedExit = entryPrice != null && pnl != null ? entryPrice * (1 + pnl / 100) : null;
  return {
    type: "exit",
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    positionId: position?.id ?? position?.position ?? null,
    decisionId: position?.decisionId ?? null,
    mint: position?.mint ?? position?.base_mint ?? null,
    pool: position?.poolAddress ?? position?.pool ?? null,
    entryPrice,
    exitPrice: finite(exitPrice ?? position?.exitQuotePrice) ?? derivedExit,
    pnlPct: pnl,
    holdMs: openedAt != null ? Math.max(0, closedAt - openedAt) : (position?.age_minutes != null ? position.age_minutes * 60_000 : null),
    reason: reason || position?.closeReason || null,
  };
}

export function recordLiquidity(event, now = Date.now()) {
  return appendDecision({ ...event, simulated: true, executed: false, executionDisabled: true }, now);
}

export function recordExit(input) {
  const now = input.now ?? Date.now();
  const record = buildExitRecord({ ...input, now });
  appendDecision(record, now);
  return record;
}
