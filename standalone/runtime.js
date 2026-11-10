// Standalone orchestrator: monitor → convergence signal → focused screening →
// revalidated deploy → deterministic exits. No Meridian server, no LLM authority.
//
// Entry and exit paths are independent: exits keep running while a signal is
// being screened, and wallet mutations are serialized by the wallet lock
// (close_position > other writes > deploy_position) in standalone/transactions.js.

import fs from "node:fs";
import { config, computeDeployAmount, transactionsAreDryRun } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { sendMessage as tgSend, isEnabled as tgEnabled } from "../telegram.js";
import { MonitorStore, acceptFabriqAlert, dropUnfinishedSignals, finishSignal, recordFabriqAlerts } from "./store.js";
import { createFabriqPoller, withFabriqContext } from "./fabriq.js";
import { WalletMonitor } from "./monitor.js";
import { screenMint, poolDetail } from "./screening.js";
import { exposureStillPresent } from "./events.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPositions, confirmPeak, updatePnlAndCheckExits, registerExitSignal, syncOpenPositions } from "../state.js";
import { recordPositionSnapshot } from "../pool-memory.js";
import { getDeterministicCloseRule, computeBinsBelow } from "../exit-rules.js";
import { startAdmin } from "./telegram-admin.js";
import { planShadowEntry, stepShadowBook } from "../strategy/shadow.js";
import { liquidityCloseSummary, simulateLiquidity } from "../strategy/liquidity-management.js";
import { recordExit, recordLiquidity, recordScreening } from "./decisions.js";
import { createGmgnGate, createMarketData, createRequestBudget } from "../strategy/market-data.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let store = null;
let monitor = null;
let lockPath = null;
let stopAdmin = null;
let stopFabriq = () => {};
let notifySink = null;
let fabriqStartupPending = true;
let shuttingDown = false;
let manageBusy = false;
let pollBusy = false;
const timers = {};
const signalQueue = [];
const signalInflight = new Set();
let idleWaiters = [];
const defaultPursuitDeps = {
  sleep,
  exposureStillPresent,
  createMarketData: deadline => createOwnerMarketData({ deadline }),
};
const pursuitDeps = { ...defaultPursuitDeps };

export function resetPursuitDeps() {
  Object.assign(pursuitDeps, defaultPursuitDeps);
}

export function resetFabriqStartup() {
  fabriqStartupPending = true;
}

function signalOptions() {
  return config.standalone;
}

function endSignal(signal, reason, now = Date.now()) {
  finishSignal(store, signal, reason, signalOptions(), now);
}

function signalStillOpen(signal, now = Date.now()) {
  return !signal.done && (signal.deadline == null || now < signal.deadline);
}

function nextRetryMs(signal, now = Date.now()) {
  const age = now - (signal.createdAt || now);
  const fast = Math.max(0, Number(config.standalone.retrySec ?? 15)) * 1000;
  const slow = Math.max(fast, Number(config.standalone.slowRetrySec ?? 60) * 1000);
  const after = Math.max(0, Number(config.standalone.slowRetryAfterSec ?? 300)) * 1000;
  let wait = age < after ? fast : slow;
  if (signal.deadline != null) wait = Math.min(wait, Math.max(0, signal.deadline - now));
  else if (wait === 0) wait = 1000;
  return wait;
}

export function setPursuitDeps(next = {}) {
  Object.assign(pursuitDeps, next);
}

export function useRuntimeStore(next) {
  store = next;
}

export function signalPursuitSettled() {
  if (signalInflight.size === 0 && signalQueue.length === 0) return Promise.resolve();
  return new Promise(resolve => { idleWaiters.push(resolve); });
}

export function enqueueSignal(signal) {
  onSignal(signal);
  return signalPursuitSettled();
}

function noteIdle() {
  if (signalInflight.size === 0 && signalQueue.length === 0 && idleWaiters.length) {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

export function setNotifySink(fn) {
  notifySink = fn;
}

async function notify(text) {
  try { notifySink?.(text); } catch { /* the test sink must not affect the daemon */ }
  try { if (tgEnabled()) await tgSend(text); } catch { /* notifications are best-effort */ }
}

function logFabriq(alert) {
  log("fabriq", `HOT ${alert.symbol ?? "?"} ${alert.mint.slice(0, 8)} score=${alert.score ?? "?"} 5m=${alert.volume5mLabel ?? "?"} pool=${alert.pool ? alert.pool.slice(0, 8) : "n/a"} id=${alert.id}`);
}

// Store every new post. The first poll after startup does not turn posts older
// than three poll intervals into signals. A newer post for an active mint only
// refreshes that pursuit.
export function ingestFabriqAlerts(alerts, now = Date.now(), options = {}) {
  if (!store) return [];
  const startup = options.startup !== undefined ? options.startup : fabriqStartupPending;
  if (options.startup === undefined) fabriqStartupPending = false;
  const maxAge = Math.max(1, Number(config.externalSignals?.fabriq?.pollSec ?? 20)) * 3 * 1000;
  const ignored = [];
  const actionable = [];
  for (const alert of alerts || []) {
    if (!alert?.id || !alert.mint) continue;
    if (startup && Number.isFinite(alert.at) && now - alert.at > maxAge) ignored.push(alert);
    else actionable.push(alert);
  }
  recordFabriqAlerts(store, ignored, now);
  const startupLimitSec = Math.round(maxAge / 1000);
  if (ignored.length) log("fabriq", `startup skipped ${ignored.length} post(s) older than ${startupLimitSec}s (pollSec*3). staleAfterSec does not apply to this skip`);
  for (const alert of ignored) log("fabriq", `startup skip ${alert.id} ${alert.mint.slice(0, 8)} (${Math.round((now - alert.at) / 1000)}s old, limit ${startupLimitSec}s)`);
  const added = recordFabriqAlerts(store, actionable, now);
  for (const alert of added) {
    logFabriq(alert);
    const result = acceptFabriqAlert(store, alert, now);
    if (result.action === "open") enqueueSignal(result.signal);
    else if (result.action === "refresh") log("fabriq", `Refreshed ${alert.mint.slice(0, 8)} (${alert.id})`);
    else if (result.action === "cooldown") log("fabriq", `Cooldown holds ${alert.mint.slice(0, 8)}; ${alert.id} did not open a signal`);
  }
  return added;
}

// ─── Signal pursuit ──────────────────────────────────────────────────────────

function globalPursuitLimit() {
  return Math.max(1, Number(config.standalone.maxActiveSignals ?? 5));
}

function fabriqPursuitLimit() {
  return Math.max(1, Number(config.externalSignals?.fabriq?.maxActive ?? 3));
}

function isFabriq(signal) {
  return signal?.source === "fabriq";
}

function fabriqInflightCount() {
  let count = 0;
  for (const mint of signalInflight) if (isFabriq(store?.data?.signals?.[mint])) count++;
  return count;
}

function fabriqPursuitCount() {
  return fabriqInflightCount() + signalQueue.filter(isFabriq).length;
}

function sourceLabel(signal) {
  if (isFabriq(signal)) return "Fabriq HOT";
  const names = (signal?.events || []).map(event => String(event.wallet || "").slice(0, 6)).filter(Boolean);
  return `2 wallets: ${names.join(", ")}`;
}

function notifyAbout(signal, text) {
  const body = isFabriq(signal) ? text : withFabriqContext(store, signal.mint, text);
  void notify(body);
}

function evictOldestFabriq() {
  let oldest = null;
  for (const mint of signalInflight) {
    const signal = store?.data?.signals?.[mint];
    if (!isFabriq(signal) || signal.done) continue;
    const started = signal.startedAt || signal.createdAt || 0;
    if (!oldest || started < (oldest.startedAt || oldest.createdAt || 0)) oldest = signal;
  }
  if (!oldest) return false;
  endSignal(oldest, "evicted for a wallet signal");
  signalInflight.delete(oldest.mint);
  log("signal", `Evicted Fabriq pursuit ${oldest.mint.slice(0, 8)} for a wallet signal`);
  return true;
}

function onSignal(signal) {
  if (!signal || signal.done) return;
  if (signalInflight.has(signal.mint) || signalQueue.some(queued => queued.mint === signal.mint)) return;
  if (isFabriq(signal) && fabriqPursuitCount() >= fabriqPursuitLimit()) {
    endSignal(signal, "fabriq pursuit cap full");
    log("fabriq", `Dropped ${signal.mint.slice(0, 8)}: fabriq cap ${fabriqPursuitLimit()} is full`);
    noteIdle();
    return;
  }
  if (isFabriq(signal)) signalQueue.push(signal);
  else {
    signalQueue.unshift(signal);
    while (signalInflight.size >= globalPursuitLimit() && evictOldestFabriq()) { /* wallet signals take the slot */ }
  }
  drainSignals();
}

export function drainSignals() {
  const limit = globalPursuitLimit();
  while (!shuttingDown && signalInflight.size < limit && signalQueue.length) {
    const walletIndex = signalQueue.findIndex(signal => !isFabriq(signal) && !signal.done);
    let index = walletIndex;
    if (index < 0) {
      if (fabriqInflightCount() >= fabriqPursuitLimit()) break;
      index = signalQueue.findIndex(signal => !signal.done);
    }
    if (index < 0) break;
    const signal = signalQueue.splice(index, 1)[0];
    if (!signal || signal.done || signalInflight.has(signal.mint)) continue;
    signal.startedAt = signal.startedAt || Date.now();
    signalInflight.add(signal.mint);
    void pursueSignal(signal).catch(error => {
      try { if (!signal.done) endSignal(signal, `error: ${error.message}`); }
      catch (finishError) { log("signal_error", `Signal finish failed: ${finishError.message}`); }
      log("signal_error", `Signal ${signal.mint.slice(0, 8)} aborted: ${error.message}`);
    }).finally(() => {
      signalInflight.delete(signal.mint);
      drainSignals();
      noteIdle();
    });
  }
  noteIdle();
  return signalPursuitSettled();
}

function fabriqWentStale(signal, now = Date.now()) {
  if (!isFabriq(signal)) return false;
  const staleSec = Number(config.externalSignals?.fabriq?.staleAfterSec ?? 1800);
  const last = signal.lastAlertAt || signal.createdAt || now;
  return now - last >= Math.max(1, staleSec) * 1000;
}

async function triggeringExposureGone(signal) {
  if (isFabriq(signal)) return false;
  const events = signal.events || [];
  if (!events.length) return false;
  let present = 0;
  for (const event of events) {
    let still = false;
    try { still = await pursuitDeps.exposureStillPresent(event); }
    catch { return false; }
    if (still) present++;
  }
  return present < config.standalone.walletThreshold;
}

// Screen and enter until the deadline, or indefinitely when deadline is null.
// Temporary failures back off. A terminal result or departed wallets ends it.
export async function pursueSignal(signal) {
  const deadlineLabel = signal.deadline == null ? "no deadline" : `${config.standalone.screeningDeadlineSec}s deadline`;
  log("signal", `${sourceLabel(signal)} on ${signal.mint.slice(0, 8)} — screening with ${deadlineLabel}`);
  notifyAbout(signal, `👀 Signal: ${sourceLabel(signal)} on ${signal.mint.slice(0, 8)}`);
  let lastReason = "no attempt";
  while (!shuttingDown && signalStillOpen(signal)) {
    if (fabriqWentStale(signal)) {
      endSignal(signal, "fabriq alert went stale");
      log("signal", `Signal ${signal.mint.slice(0, 8)} ended: fabriq alert went stale`);
      return;
    }
    if (await triggeringExposureGone(signal)) {
      endSignal(signal, "triggering wallets left the token");
      log("signal", `Signal ${signal.mint.slice(0, 8)} ended: triggering wallets left the token`);
      return;
    }
    const reason = await attemptEntry(signal);
    if (reason == null || signal.done) return;
    lastReason = reason;
    const wait = nextRetryMs(signal);
    if (wait > 0) await pursuitDeps.sleep(wait);
  }
  if (!signal.done) {
    endSignal(signal, lastReason);
    log("signal", `Signal ${signal.mint.slice(0, 8)} expired: ${lastReason}`);
  }
}

// One entry attempt. Returns null when the signal is finished (entered,
// terminal rejection, or fatal condition), or a reason string to retry.
function watchedWallets() {
  return {
    wallets: config.ownerStrategy.wallets.map((address, index) => ({
      address,
      name: `watch-${index + 1}`,
      type: "lp",
    })),
  };
}

async function attemptEntry(signal) {
  if (config.ownerStrategy.enabled) return attemptOwnerEntry(signal);
  return attemptLegacyEntry(signal);
}

const ownerGmgn = { budget: null, gate: null, cache: new Map() };

export function ownerSnapshotWindow(now, rules = config.ownerStrategy) {
  const to = now - (now % 60_000);
  const from = to - rules.pocLookbackHours * 3_600_000;
  return { from, to };
}

export function createOwnerMarketData(overrides = {}) {
  const rules = { ...config.ownerStrategy, ...overrides.rules };
  if (!ownerGmgn.budget) ownerGmgn.budget = createRequestBudget(rules);
  if (!ownerGmgn.gate) ownerGmgn.gate = createGmgnGate();
  return createMarketData(rules, {
    apiKey: overrides.apiKey ?? process.env.GMGN_API_KEY ?? "",
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    budget: overrides.budget ?? ownerGmgn.budget,
    gate: overrides.gate ?? ownerGmgn.gate,
    cache: overrides.cache ?? ownerGmgn.cache,
    deadline: overrides.deadline,
  });
}

async function attemptOwnerEntry(signal) {
  const rules = config.ownerStrategy;
  const book = Array.isArray(store.data.shadowBook) ? store.data.shadowBook : [];
  const now = Date.now();
  const window = ownerSnapshotWindow(now, rules);
  let snapshot;
  try {
    snapshot = await pursuitDeps.createMarketData(signal.deadline).snapshot(signal.mint, {
      ...window,
      deadline: signal.deadline,
    });
  } catch (error) {
    const reason = `market data error: ${error.message}`;
    safeScreeningLog({ now, signal, snapshot: null, book, rules, reason });
    return reason;
  }
  if (signal.done) return null;
  if (signal.pool && snapshot?.ok) snapshot = { ...snapshot, poolAddress: signal.pool };
  snapshot = await attachPoolVolume(signal, snapshot);
  const decision = planShadowEntry({ signal, snapshot, book, rules, now });
  const logged = safeScreeningLog({ now, signal, snapshot, book, rules, result: decision, reason: decision.ok ? "shadow proposal recorded" : decision.reason });
  if (decision.proposal && logged) decision.proposal.decisionId = logged.id;
  if (signal.done) return null;
  if (!decision.ok) {
    log("entry", `shadow skip ${signal.mint.slice(0, 8)}: ${decision.reason}`);
    if (decision.terminal) {
      endSignal(signal, decision.reason);
      return null;
    }
    return decision.reason;
  }
  store.data.shadowBook = [...book, decision.proposal];
  store.data.attempts[signal.mint] = {
    at: now,
    mint: signal.mint,
    pool: decision.proposal.poolAddress,
    wallets: decision.proposal.wallets,
    status: "proposed",
    failures: 0,
    position: decision.proposal.id,
    txs: [],
    shadow: true,
  };
  store.save();
  endSignal(signal, "shadow proposal recorded");
  log("entry", `[SHADOW] Would open ${decision.proposal.totalSol} SOL (${decision.proposal.legs.map(leg => `${leg.strategy} ${leg.amountSol}`).join(" + ")}) on ${signal.mint.slice(0, 8)}; nothing submitted`);
  notifyAbout(signal, `🕯️ Shadow proposal (${sourceLabel(signal)}): ${decision.proposal.totalSol} SOL split ${decision.proposal.legs.map(leg => `${leg.amountSol} ${leg.strategy}`).join(" + ")} on ${signal.mint.slice(0, 8)}. Not submitted.`);
  return null;
}

async function attachPoolVolume(signal, snapshot) {
  if (!snapshot?.ok || snapshot.poolVolume5mUsd != null) return snapshot;
  const pool = signal.pool || snapshot.poolAddress;
  if (!pool) return snapshot;
  try {
    const detail = await poolDetail(pool, "5m");
    const volume = Number(detail?.volume);
    const liquidity = Number(detail?.tvl);
    return {
      ...snapshot,
      poolVolume5mUsd: Number.isFinite(volume) ? volume : null,
      poolLiquidityUsd: Number.isFinite(liquidity) && liquidity > 0 ? liquidity : snapshot.poolLiquidityUsd,
    };
  } catch {
    return snapshot;
  }
}

function noteShadowLiquidity(livePositions) {
  if (!store?.data?.shadowBook?.length) return;
  const now = Date.now();
  let changed = false;
  store.data.shadowBook = store.data.shadowBook.map(position => {
    if (position.status !== "proposed") return position;
    const live = livePositions.find(item => item.base_mint === position.mint || item.position === position.id);
    if (!live || live.active_bin == null && live.unclaimed_fees_usd == null) return position;
    const simulated = simulateLiquidity(position, {
      at: now,
      activeBin: live.active_bin,
      lowerBin: live.lower_bin,
      upperBin: live.upper_bin,
      unclaimedFeesUsd: live.unclaimed_fees_usd,
      solPriceUsd: live.sol_price_usd ?? null,
    }, config.ownerStrategy, now);
    if (simulated.events.length) changed = true;
    for (const event of simulated.events) {
      try { recordLiquidity(event, now); } catch (error) { log("decision", `liquidity log failed: ${error.message}`); }
    }
    return simulated.position;
  });
  if (changed) store.save();
}

function safeScreeningLog(input) {
  try { return recordScreening(input); }
  catch (error) { log("decision", `screening log failed: ${error.message}`); return null; }
}

function safeExitLog(input) {
  try { return recordExit(input); }
  catch (error) { log("decision", `exit log failed: ${error.message}`); return null; }
}

export function reviewShadowBook(book, tick) {
  const now = tick?.at ?? Date.now();
  const managed = applyShadowLiquidity(book, tick, now);
  const stepped = stepShadowBook(managed, tick, config.ownerStrategy);
  for (const exit of stepped.exits) {
    const position = stepped.book.find(item => item.id === exit.id);
    safeExitLog({ now, position, reason: exit.reason, pnlPct: position?.pnlPct, exitPrice: tick?.quotePrice });
    try { recordLiquidity(liquidityCloseSummary(position, now), now); } catch (error) { log("decision", `liquidity summary failed: ${error.message}`); }
  }
  return stepped;
}

function applyShadowLiquidity(book, observation, now) {
  return (book || []).map(position => {
    if (position?.status !== "proposed") return position;
    if (observation?.activeBin == null && observation?.unclaimedFeesUsd == null) return position;
    const simulated = simulateLiquidity(position, observation, config.ownerStrategy, now);
    for (const event of simulated.events) {
      try { recordLiquidity(event, now); } catch (error) { log("decision", `liquidity log failed: ${error.message}`); }
    }
    return simulated.position;
  });
}

async function attemptLegacyEntry(signal) {
  const mint = signal.mint;
  const attempt = store.data.attempts[mint];
  // One attempt chain per mint; bounded retries only for temporary failures.
  if (attempt && ["entered", "proposed", "submitting"].includes(attempt.status)) {
    endSignal(signal, `mint already attempted (${attempt.status})`);
    return null;
  }
  if (attempt?.status === "failed" && (attempt.failures ?? 0) >= 2) {
    endSignal(signal, "deploy failed repeatedly");
    return null;
  }

  // A failed position read is unavailable data, never "no positions".
  const positions = await getMyPositions({ force: true }).catch(() => null);
  if (!positions || positions.error || !Array.isArray(positions.positions)) return "position read unavailable";
  if (positions.positions.length >= config.risk.maxPositions) {
    endSignal(signal, "portfolio full");
    return null;
  }

  // Focused screening: this mint and its eligible pools only.
  let screened;
  try {
    screened = await screenMint(mint);
  } catch (e) {
    return `screening error: ${e.message}`;
  }
  if (!screened.pass) {
    if (screened.terminal) {
      endSignal(signal, `blocked: ${screened.reason}`);
      return null;
    }
    return screened.reason;
  }

  const gate = await finalRecheck(signal, screened);
  if (gate) return gate;

  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  const amountY = computeDeployAmount(balances.sol);
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) {
    endSignal(signal, "insufficient spendable SOL");
    return null;
  }

  const pool = screened.pool;
  const binsBelow = computeBinsBelow(pool.volatility);
  // Checkpoint before building anything: a crash mid-sequence leaves a
  // recovery pointer instead of a silent duplicate-entry risk.
  store.data.attempts[mint] = {
    at: Date.now(), mint, pool: pool.pool_address, wallets: signal.events.map(e => e.wallet),
    status: "submitting", failures: attempt?.failures ?? 0, position: null, txs: [],
  };
  store.save();

  let submitted = 0;
  const result = await executeTool("deploy_position", {
    pool_address: pool.pool_address,
    amount_y: amountY,
    bins_below: binsBelow,
    before_submit: async () => {
      // Gate only the first transaction of the sequence. Once creation has
      // been sent, completing the sequence is safer than abandoning a
      // half-built position.
      if (submitted++ > 0) return;
      const fresh = await finalRecheck(signal, screened);
      if (fresh) throw new Error(`Pre-submit recheck failed: ${fresh}`);
    },
    on_prepared: position => {
      store.data.attempts[mint].position = position;
      store.save();
    },
  }).catch(e => ({ error: e.message }));

  const record = store.data.attempts[mint];
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (ok) {
    record.status = result.dry_run ? "proposed" : "entered";
    record.position = result.position ?? record.position;
    record.txs = result.txs ?? [];
    record.amountSol = amountY;
    store.save();
    endSignal(signal, record.status === "proposed" ? "shadow proposal recorded" : "entered");
    const label = result.dry_run ? "[SHADOW] Would deploy" : "Deployed";
    log("entry", `${label} ${amountY} SOL → pool ${pool.pool_address.slice(0, 8)} mint ${mint.slice(0, 8)} (${binsBelow} bins below, ${signal.events.length}-wallet convergence)`);
    notifyAbout(signal, `${result.dry_run ? "🕯️ Shadow proposal" : "✅ Entry"} (${sourceLabel(signal)}): ${amountY} SOL → ${pool.pool_address.slice(0, 8)} (mint ${mint.slice(0, 8)})`);
    return null;
  }

  record.status = "failed";
  record.failures = (record.failures ?? 0) + 1;
  record.error = result?.error || result?.reason || "unknown";
  if (Array.isArray(record.txs) && record.txs.length > 0) record.note = "transaction submitted before failure — outcome uncertain";
  store.save();
  return `deploy failed (${record.error})`;
}

// Immediate pre-entry conditions: the triggering wallets still hold their
// exposure, the market has not run away since screening, and spendable funds
// cover the entry. Returns null when everything holds, else the reason.
async function finalRecheck(signal, screened) {
  let present = 0;
  for (const e of signal.events) {
    try { if (await exposureStillPresent(e)) present++; } catch { /* unreadable position = not confirmed */ }
  }
  if (present < config.standalone.walletThreshold) {
    return `wallet exposure gone (${present}/${signal.events.length} remain)`;
  }
  try {
    const fresh = await poolDetail(screened.pool.pool_address);
    const base = Number(screened.pool.pool_price);
    const now = Number(fresh.pool_price);
    if (!(base > 0) || !(now > 0)) return "price unavailable for move check";
    const movePct = Math.abs(now - base) / base * 100;
    if (movePct > config.standalone.maxPriceMovePct) return `price moved ${movePct.toFixed(1)}% since screening`;
  } catch (e) {
    return `fresh pool read failed (${e.message})`;
  }
  const balances = await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) return "insufficient spendable SOL";
  return null;
}

// ─── Exits (deterministic, no LLM) ──────────────────────────────────────────

// One management pass: trailing/rule exits and fee claims. Never triggers
// screening — an empty portfolio just waits for the next convergence signal.
export async function manageOnce() {
  if (manageBusy || shuttingDown) return null;
  manageBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) {
      log("manage_warn", "Position read unavailable — holding this cycle");
      return null;
    }
    syncOpenPositions(live.positions.map(p => p.position));
    noteShadowLiquidity(live.positions);
    if (live.positions.length === 0) return "No open positions";
    for (const p of live.positions) {
      recordPositionSnapshot(p.pool, p);
      // Slow backstop: raise peaks immediately and act on detected exits.
      // Real-time confirmation lives in the fast poller below.
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      const closeRule = exit
        ? { action: "CLOSE", rule: "exit", reason: exit.reason }
        : getDeterministicCloseRule(p, config.management);
      let action = null;
      if (closeRule?.action === "CLOSE") {
        action = { tool: "close_position", args: { position_address: p.position, reason: closeRule.reason }, label: `close (${closeRule.reason})` };
      } else if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        action = { tool: "claim_fees", args: { position_address: p.position }, label: "claim fees" };
      }
      // LLM-set free-text instructions have no execution path in standalone — hold.
      if (!action) continue;
      const res = await executeTool(action.tool, action.args).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      const outcome = res?.dry_run ? "shadow (not submitted)" : ok ? "done" : `FAILED — ${res?.error || res?.reason || "unknown"}`;
      log("manage", `${p.pair ?? p.position.slice(0, 8)}: ${action.label} ${outcome}`);
      if (action.tool === "close_position") safeExitLog({ position: p, reason: closeRule.reason, pnlPct: p.pnl_pct });
    }
    return null;
  } finally {
    manageBusy = false;
  }
}

// Fast exit poller (RPC + Meteora deposits, no LLM). An exit fires only after
// `confirmTicks` consecutive confirming polls; confirmed exits close directly.
function startPnlPoller() {
  const pollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  timers.pnl = setInterval(async () => {
    if (manageBusy || pollBusy || shuttingDown) return;
    if (getTrackedPositions(true).length === 0) return;
    pollBusy = true;
    try {
      const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!live?.positions?.length) return;
      noteShadowLiquidity(live.positions);
      for (const p of live.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null;
        if (exit) { signal = exit.action ?? "EXIT"; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; }
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;
        log("poll", `Exit confirmed (${confirmTicks} ticks): ${p.pair ?? p.position.slice(0, 8)} — ${reason} — closing`);
        manageBusy = true; // hold the slow cycle off this position
        try {
          const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
          const ok = res?.success !== false && !res?.error && !res?.blocked;
          const outcome = res?.dry_run ? "shadow (not submitted)" : ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`;
          log("poll", `${p.pair ?? p.position.slice(0, 8)}: ${outcome}`);
          safeExitLog({ position: p, reason, pnlPct: p.pnl_pct });
        } finally {
          manageBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      pollBusy = false;
    }
  }, pollMs);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function startHeartbeat() {
  timers.heartbeat = setInterval(() => {
    const stats = monitor?.stats ?? {};
    const active = Object.values(store.data.signals).filter(s => !s.done).length;
    const activePursuits = signalInflight.size;
    const pending = Object.keys(store.data.pending).length;
    const lag = stats.lastLagMs != null ? `${(stats.lastLagMs / 1000).toFixed(1)}s` : "n/a";
    const mode = transactionsAreDryRun() ? (config.standalone.shadow ? "shadow" : "dry-run") : "live";
    log("heartbeat", `mode=${mode} | monitor tx=${stats.transactions ?? 0} entries=${stats.entries ?? 0} lag=${lag} pending=${pending} errors=${stats.errors ?? 0} | signals active=${active} pursuing=${activePursuits} queued=${signalQueue.length}`);
    store.prune();
    store.save();
  }, 60_000);
}

function startFabriqWatch() {
  const fabriq = config.externalSignals?.fabriq;
  if (!fabriq?.enabled) return () => {};
  const poller = createFabriqPoller({
    url: fabriq.url,
    pollSec: fabriq.pollSec,
    userAgent: fabriq.userAgent,
    log: message => log("fabriq", message),
    onAlerts: alerts => { ingestFabriqAlerts(alerts); },
  });
  void poller.start();
  log("fabriq", `Watching ${fabriq.url} every ${fabriq.pollSec}s as a trigger (maxActive=${fabriq.maxActive}, staleAfterSec=${fabriq.staleAfterSec}). First poll ignores posts older than ${fabriq.pollSec * 3}s`);
  return () => poller.stop();
}

function acquireLock() {
  lockPath = repoPath("standalone.lock");
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* not running or invalid pid */ }
    if (alive && pid !== process.pid) throw new Error(`Another standalone instance is running (pid ${pid}) — refusing to start`);
    log("runtime", `Removing stale standalone lock (pid ${pid || "unknown"} is not running)`);
    fs.rmSync(lockPath);
  }
  fs.writeFileSync(lockPath, String(process.pid));
}

async function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("runtime", `${signalName} received — shutting down`);
  for (const timer of Object.values(timers)) clearInterval(timer);
  try { stopFabriq(); } catch { /* best-effort */ }
  try { stopAdmin?.(); } catch { /* best-effort */ }
  try { await monitor?.stop(); } catch { /* best-effort */ }
  // Best-effort stop notice; never let a slow Telegram call hold shutdown.
  await Promise.race([notify(`🛑 Meridian stopped (${signalName})`), sleep(3000)]).catch(() => {});
  try { if (lockPath) fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  process.exit(0);
}

export async function startStandalone() {
  if (!config.standalone.monitorRpcUrl) throw new Error("Standalone requires RPC_URL or MONITOR_RPC_URL");
  acquireLock();

  store = new MonitorStore();
  const dropped = dropUnfinishedSignals(store);
  if (dropped) log("runtime", `Dropped ${dropped} unfinished signal(s) from the previous process so they can re-trigger`);
  for (const [mint, attempt] of Object.entries(store.data.attempts)) {
    if (attempt.status === "submitting") {
      log("runtime_warn", `Mint ${mint.slice(0, 8)} was mid-submit at shutdown (position ${attempt.position ?? "unknown"}, txs ${attempt.txs?.length ?? 0}) — reconcile on-chain before re-enabling entries`);
    }
  }

  monitor = new WalletMonitor(store, config.standalone, { onSignal, wallets: watchedWallets });
  stopFabriq = startFabriqWatch();
  const modeLabel = transactionsAreDryRun()
    ? (config.standalone.shadow ? "SHADOW MODE (proposals recorded, nothing submitted)" : "DRY RUN (shadow is off, but DRY_RUN=true still blocks submits)")
    : "LIVE MODE";
  const deadlineLabel = config.standalone.screeningDeadlineSec == null ? "none" : `${config.standalone.screeningDeadlineSec}s`;
  log("runtime", `Standalone starting — ${modeLabel} | threshold=${config.standalone.walletThreshold} wallets / ${config.standalone.windowSec}s window | screening deadline=${deadlineLabel} | active signals=${config.standalone.maxActiveSignals}`);

  await monitor.start();
  if (!monitor.healthy()) {
    log("runtime_warn", "Monitor baseline incomplete — wallets without a portfolio baseline produce no signals until reconciliation succeeds");
  }

  // Entries come only from signals; exits run on their own cadences.
  timers.manage = setInterval(() => { void manageOnce(); }, Math.max(1, config.schedule.managementIntervalMin) * 60_000);
  startPnlPoller();
  startHeartbeat();
  void manageOnce();
  stopAdmin = startAdmin({
    monitor,
    activeSignals: () => Object.values(store.data.signals).filter(s => !s.done).length,
  });

  const trackedWallets = Object.keys(store.data.wallets).length;
  const started = transactionsAreDryRun()
    ? (config.standalone.shadow ? "SHADOW (nothing submitted)" : "DRY RUN (nothing submitted)")
    : "LIVE";
  void notify(`🤖 Meridian started — ${started}\n${trackedWallets} wallet(s) monitored | trigger: ${config.standalone.walletThreshold} within ${config.standalone.windowSec}s | exits: ${config.pnl.pollIntervalSec}s poller`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log("runtime", `Running — exits every ${config.schedule.managementIntervalMin}m + ${config.pnl.pollIntervalSec}s poller; waiting for wallet convergence`);
}
