import fs from 'node:fs';
import { repoPath } from '../repo-root.js';

export class MonitorStore {
  constructor(file = repoPath('wallet-monitor-state.json')) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version: 1, wallets: {}, pending: {}, seen: {}, events: [], signals: {}, attempts: {}, paused: false,
    };
    if (this.data.version !== 1 || !this.data.wallets || !this.data.attempts || !Array.isArray(this.data.events)) throw new Error('Invalid monitor state; refusing to discard recovery history');
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  prune(now = Date.now()) {
    const day = 24 * 3600_000;
    this.data.events = (this.data.events || []).filter(e => now - e.at < 10 * 60_000);
    for (const [key, at] of Object.entries(this.data.seen || {})) if (now - at > day) delete this.data.seen[key];
    for (const [key, pending] of Object.entries(this.data.pending || {})) {
      if (now - (pending.queuedAt || 0) > day) delete this.data.pending[key];
    }
    for (const [mint, signal] of Object.entries(this.data.signals || {})) {
      const closedAt = signal.closedAt || signal.createdAt || 0;
      const staleDone = signal.done && now - closedAt > day;
      const staleExpired = !signal.done && signal.deadline != null && now > signal.deadline + day;
      if (staleDone || staleExpired) delete this.data.signals[mint];
    }
    // Attempt records double as mint-level duplicate protection. Never prune mid-submit checkpoints.
    for (const [mint, attempt] of Object.entries(this.data.attempts || {})) {
      if (attempt.status !== "submitting" && now - attempt.at > day) delete this.data.attempts[mint];
    }
    if (Array.isArray(this.data.shadowBook)) {
      this.data.shadowBook = this.data.shadowBook.filter(position => position.status === "proposed" || now - (position.closedAt || position.openedAt || 0) < day);
    }
    pruneFabriqAlerts(this, now);
  }
}

const FABRIQ_RETENTION_MS = 24 * 3600_000;

function pruneFabriqAlerts(store, now) {
  for (const [mint, list] of Object.entries(store.data.fabriqAlerts || {})) {
    const kept = (list || []).filter(alert => alert?.at != null && now - alert.at < FABRIQ_RETENTION_MS && alert.at <= now + 60_000);
    if (kept.length) store.data.fabriqAlerts[mint] = kept;
    else delete store.data.fabriqAlerts[mint];
  }
  for (const [id, at] of Object.entries(store.data.fabriqSeen || {})) {
    if (now - at > FABRIQ_RETENTION_MS) delete store.data.fabriqSeen[id];
  }
}

// Recent HOT posts. Opening a signal is a separate decision from storing one.
export function recordFabriqAlerts(store, alerts, now = Date.now()) {
  if (!store.data.fabriqAlerts) store.data.fabriqAlerts = {};
  if (!store.data.fabriqSeen) store.data.fabriqSeen = {};
  const added = [];
  for (const alert of alerts || []) {
    if (!alert?.id || !alert.mint) continue;
    if (store.data.fabriqSeen[alert.id]) continue;
    store.data.fabriqSeen[alert.id] = now;
    if (alert.at == null || now - alert.at >= FABRIQ_RETENTION_MS) continue;
    const list = store.data.fabriqAlerts[alert.mint] || [];
    list.push(alert);
    store.data.fabriqAlerts[alert.mint] = list;
    added.push(alert);
  }
  pruneFabriqAlerts(store, now);
  if (added.length) store.save();
  return added;
}

// A Fabriq alert is its own signal. An active pursuit is refreshed in place.
// A finished signal stays finished until its cooldown ends.
export function acceptFabriqAlert(store, alert, now = Date.now()) {
  if (!alert?.mint) return { action: "ignore", signal: null };
  if (!store.data.signals) store.data.signals = {};
  const existing = store.data.signals[alert.mint];
  if (existing && !existing.done) {
    existing.lastAlertAt = now;
    existing.fabriqAlert = alert;
    if (alert.pool) existing.pool = alert.pool;
    store.save();
    return { action: "refresh", signal: existing };
  }
  if (existing?.done && now < (existing.cooldownUntil || 0)) return { action: "cooldown", signal: existing };
  const signal = {
    mint: alert.mint,
    source: "fabriq",
    pool: alert.pool || null,
    createdAt: now,
    deadline: null,
    lastAlertAt: now,
    nextCheck: now,
    fabriqAlert: alert,
    events: [],
    done: false,
  };
  store.data.signals[alert.mint] = signal;
  store.save();
  return { action: "open", signal };
}
export function qualifyingEvents(events, mint, options, now = Date.now()) {
  const latest = new Map();
  for (const e of events) {
    if (e.mint !== mint || e.at > now || now - e.at > options.windowSec * 1000 || e.depositSol < options.minDepositSol) continue;
    const group = options.walletGroups[e.wallet] || e.wallet;
    if (!latest.has(group) || latest.get(group).at < e.at) latest.set(group, e);
  }
  return [...latest.values()];
}
export function acceptEvents(store, events, options, now = Date.now()) {
  for (const e of events) {
    if (!store.data.events.some(old => old.id === e.id)) store.data.events.push(e);
  }
  const triggered = [];
  for (const mint of new Set(events.map(e => e.mint))) {
    const existing = store.data.signals[mint];
    const recent = qualifyingEvents(store.data.events, mint, options, now);
    if (existing && (!existing.done || now < existing.cooldownUntil)) continue;
    // A completed signal cannot be reused after its cooldown.
    const fresh = recent.filter(e => !existing || e.at > existing.closedAt);
    if (fresh.length < options.walletThreshold) continue;
    const signal = { mint, createdAt: now, deadline: signalDeadline(now, options), nextCheck: now, events: fresh, done: false };
    store.data.signals[mint] = signal;
    triggered.push(signal);
  }
  store.prune(now);
  store.save();
  return triggered;
}
export function signalDeadline(now, options = {}) {
  const sec = options?.screeningDeadlineSec;
  if (sec == null || sec === 0) return null;
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? now + n * 1000 : null;
}

export function dropUnfinishedSignals(store) {
  let dropped = 0;
  for (const [mint, signal] of Object.entries(store.data.signals || {})) {
    if (!signal.done) {
      delete store.data.signals[mint];
      dropped++;
    }
  }
  if (dropped) store.save();
  return dropped;
}

export function finishSignal(store, signal, reason, options = {}, now = Date.now()) {
  const cooldownSec = Number(options?.cooldownSec);
  const cooldown = Number.isFinite(cooldownSec) && cooldownSec >= 0 ? cooldownSec : 0;
  Object.assign(signal, { done: true, reason, closedAt: now, cooldownUntil: now + cooldown * 1000 });
  store.save();
}
