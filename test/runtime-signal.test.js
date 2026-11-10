import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { MonitorStore, dropUnfinishedSignals, finishSignal, signalDeadline, acceptEvents } from "../standalone/store.js";
import { enqueueSignal, resetPursuitDeps, setPursuitDeps, useRuntimeStore } from "../standalone/runtime.js";

const mint = "MintReplay11111111111111111111111111111111";

function tempStore() {
  const file = path.join(os.tmpdir(), `meridian-signals-${process.pid}-${Date.now()}.json`);
  const store = new MonitorStore(file);
  return { file, store };
}

function signal(now, extra = {}) {
  const [first, second] = OWNER_STRATEGY.wallets;
  const item = {
    mint,
    createdAt: now,
    deadline: now + 60_000,
    done: false,
    events: [],
    ...extra,
  };
  const eventAt = item.eventAt ?? now;
  item.events = [
    { wallet: first, mint: item.mint, pool: "PoolA", at: eventAt - 1_000, depositSol: 1, position: "pos-a", slot: 1, shares: "10" },
    { wallet: second, mint: item.mint, pool: "PoolB", at: eventAt - 500, depositSol: 1, position: "pos-b", slot: 1, shares: "10" },
  ];
  return item;
}

test("finishSignal defaults missing options and a null deadline is persisted", () => {
  const { file, store } = tempStore();
  try {
    const now = Date.now();
    const open = { mint: "MintA", createdAt: now, deadline: null, done: false, events: [] };
    finishSignal(store, open, "closed without options");
    assert.equal(open.done, true);
    assert.equal(open.cooldownUntil, open.closedAt);
    assert.equal(signalDeadline(now, { screeningDeadlineSec: null }), null);
    assert.equal(signalDeadline(now, { screeningDeadlineSec: 0 }), null);
    assert.equal(signalDeadline(now, { screeningDeadlineSec: 120 }), now + 120_000);
    const options = { walletThreshold: 1, windowSec: 120, minDepositSol: 0, screeningDeadlineSec: null, cooldownSec: 0, walletGroups: {} };
    const triggered = acceptEvents(store, [{ id: "e1", mint: "MintB", wallet: "w", at: now, depositSol: 1 }], options, now);
    assert.equal(triggered[0].deadline, null);
    for (const item of triggered) item.done = true;
    store.data.pending.old = { queuedAt: now - 25 * 3600_000 };
    store.data.signals.MintOld = { done: true, createdAt: now - 25 * 3600_000, closedAt: now - 25 * 3600_000 };
    store.data.signals.MintLive = { done: false, createdAt: now - 3600_000, deadline: null };
    store.prune(now);
    assert.equal(store.data.pending.old, undefined);
    assert.equal(store.data.signals.MintOld, undefined);
    assert.equal(store.data.signals.MintLive.done, false);
    store.data.signals.MintLive.done = false;
    assert.equal(dropUnfinishedSignals(store), 1);
    assert.equal(store.data.signals.MintLive, undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("runtime pursuit records a proposal, a wallet exit, and an expiry without a manual cooldown", async () => {
  const { file, store } = tempStore();
  const sleeps = [];
  let exposure = async () => true;
  let snapshot = async () => ({ ok: false, reason: "candle provider is not configured" });
  setPursuitDeps({
    sleep: async ms => { sleeps.push(ms); },
    exposureStillPresent: async () => exposure(),
    createMarketData: () => ({ snapshot: mintArg => snapshot(mintArg) }),
  });
  useRuntimeStore(store);
  try {
    const proposedAt = Date.now();
    snapshot = async () => passingSnapshot(mint);
    const proposed = signal(proposedAt);
    await enqueueSignal(proposed);
    assert.equal(proposed.done, true);
    assert.match(proposed.reason, /shadow proposal/);
    assert.equal(store.data.shadowBook.length, 1);
    assert.equal(store.data.shadowBook[0].submitted, false);

    sleeps.length = 0;
    exposure = async () => false;
    const skipped = signal(Date.now(), { mint: "MintSkip1111111111111111111111111111111111" });
    await enqueueSignal(skipped);
    assert.equal(skipped.done, true);
    assert.match(skipped.reason, /left the token/);
    assert.equal(sleeps.length, 0);

    sleeps.length = 0;
    exposure = async () => true;
    snapshot = async () => ({ ok: false, reason: "candle provider is not configured" });
    const expired = signal(Date.now(), { deadline: Date.now() - 1, mint: "MintExpire11111111111111111111111111111111" });
    await enqueueSignal(expired);
    assert.equal(expired.done, true);
    assert.equal(expired.reason, "no attempt");
    assert.ok(Number.isFinite(expired.cooldownUntil));

    sleeps.length = 0;
    const young = signal(Date.now(), { deadline: null, mint: "MintYoung111111111111111111111111111111111" });
    let leftYoung = false;
    exposure = async () => !leftYoung;
    snapshot = async () => { leftYoung = true; return { ok: false, reason: "candle provider is not configured" }; };
    await enqueueSignal(young);
    assert.equal(sleeps[0], 15_000);

    sleeps.length = 0;
    const slow = signal(Date.now() - 6 * 60_000, { deadline: null, eventAt: Date.now(), mint: "MintSlow1111111111111111111111111111111111" });
    let left = false;
    exposure = async () => !left;
    snapshot = async () => { left = true; return { ok: false, reason: "candle provider is not configured" }; };
    await enqueueSignal(slow);
    assert.equal(slow.done, true);
    assert.match(slow.reason, /left the token/);
    assert.equal(sleeps[0], 60_000);
  } finally {
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});
