import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { acceptEvents, MonitorStore, recordFabriqAlerts } from "../standalone/store.js";
import { createFabriqPoller, fabriqContextLine, parseFabriqPage, withFabriqContext } from "../standalone/fabriq.js";
import { enqueueSignal, ingestFabriqAlerts, resetFabriqStartup, resetPursuitDeps, setNotifySink, setPursuitDeps, signalPursuitSettled, useRuntimeStore } from "../standalone/runtime.js";

const fixture = fs.readFileSync(new URL("./fixtures/fabriqalert.html", import.meta.url), "utf8");
const mint = "BH5bq6NamreYUbu1hG6RQyCXXzrDvQ7Zi7w82mrbpump";

function tempStore() {
  const file = path.join(os.tmpdir(), `meridian-fabriq-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return { file, store: new MonitorStore(file) };
}

function walletEvent(wallet, at, token = mint) {
  return { id: `${wallet}:${at}`, mint: token, wallet, pool: "PoolA", at, depositSol: 1, position: "pos", slot: 1, shares: "10" };
}

test("fabriq config is enabled and bounded by default", () => {
  assert.equal(config.externalSignals.fabriq.enabled, true);
  assert.equal(config.externalSignals.fabriq.pollSec, 20);
  assert.equal(config.externalSignals.fabriq.staleAfterSec, 1800);
  assert.equal(config.externalSignals.fabriq.maxActive, 3);
  assert.equal(config.externalSignals.fabriq.channel, "fabriqalert");
  assert.equal(config.externalSignals.fabriq.url, "https://t.me/s/fabriqalert");
  const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
  assert.equal(example.externalSignals.fabriq.enabled, true);
  assert.equal(example.externalSignals.fabriq.staleAfterSec, 1800);
  assert.equal(example.externalSignals.fabriq.maxActive, 3);
  assert.equal(example.ownerStrategy.walletThreshold, 2);
});

test("parser reads a real Fabriq preview and skips a broken post", () => {
  const { alerts, errors } = parseFabriqPage(fixture);
  assert.equal(errors.length, 0);
  assert.equal(alerts.length, 20);
  const perp = alerts.find(alert => alert.id === "fabriqalert/40761");
  assert.equal(perp.symbol, "PERPULATOR-SOL");
  assert.equal(perp.mint, mint);
  assert.equal(perp.pool, "CYhy73LLqSKB9Bu1kD8xnABrJGRQNBcLvQU3wNGBUDaY");
  assert.equal(perp.poolAge, "5m");
  assert.equal(perp.score, 119523);
  assert.equal(perp.fdvUsd, 172040);
  assert.equal(perp.liquidityUsd, 12170);
  assert.equal(perp.volume5mUsd, 20420);
  assert.equal(perp.volume5mLabel, "$20.42K");
  assert.equal(perp.at, Date.parse("2026-11-10T00:04:13+00:00"));
  const noAge = alerts.find(alert => alert.id === "fabriqalert/40769");
  assert.equal(noAge.poolAge, null);
  assert.equal(noAge.symbol, "AICOIN-SOL");
  const plain = alerts.find(alert => alert.id === "fabriqalert/40757");
  assert.equal(plain.symbol, "PMURT-SOL");
  assert.equal(plain.poolAge, "2m");
  const months = alerts.find(alert => alert.id === "fabriqalert/40756");
  assert.equal(months.poolAge, "2mo");

  const broken = parseFabriqPage(`${fixture}<div class="tgme_widget_message" data-post="fabriqalert/99999"><div class="tgme_widget_message_text js-message_text">not an alert</div></div>`);
  assert.equal(broken.alerts.length, 20);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], /99999/);
  assert.doesNotThrow(() => parseFabriqPage(""));
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function alertFrom(id, now, mintOverride = mint) {
  const { alerts } = parseFabriqPage(fixture);
  const found = alerts.find(alert => alert.id === id);
  return { ...found, mint: mintOverride, at: now };
}

test("the first poll ignores old Fabriq posts, and two wallets still trigger with context", async () => {
  const { file, store } = tempStore();
  const notices = [];
  let snapshots = 0;
  const now = Date.now();
  const { alerts } = parseFabriqPage(fixture);
  const perp = { ...alerts.find(alert => alert.id === "fabriqalert/40761"), at: now - 5 * 60_000 - 500 };
  const second = { ...alerts.find(alert => alert.id === "fabriqalert/40762"), at: now - 4 * 60_000 };
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({ snapshot: async () => { snapshots += 1; return passingSnapshot(mint); } }),
  });
  setNotifySink(text => notices.push(text));
  useRuntimeStore(store);
  resetFabriqStartup();
  try {
    const added = ingestFabriqAlerts([perp, second], now);
    assert.equal(added.length, 0);
    assert.ok(store.data.fabriqAlerts[mint].length >= 1);
    assert.equal(ingestFabriqAlerts([perp], now).length, 0);
    assert.equal(snapshots, 0);
    assert.deepEqual(store.data.signals, {});
    const options = { walletThreshold: 2, windowSec: 120, minDepositSol: 0, screeningDeadlineSec: 120, cooldownSec: 180, walletGroups: {} };
    const [firstWallet, secondWallet] = OWNER_STRATEGY.wallets;
    assert.equal(acceptEvents(store, [walletEvent(firstWallet, now - 1_000)], options, now).length, 0);
    assert.equal(snapshots, 0);
    assert.equal(store.data.signals[mint], undefined);

    const triggered = acceptEvents(store, [walletEvent(secondWallet, now - 500)], options, now);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].events.length, 2);
    assert.equal(triggered[0].events.every(event => event.wallet), true);
    assert.equal(fabriqContextLine(store, mint, now), "Fabriq HOT seen 4m ago (127238, $26.71K)");

    notices.length = 0;
    snapshots = 0;
    const pursued = {
      ...triggered[0],
      deadline: now + 60_000,
    };
    await enqueueSignal(pursued);
    assert.equal(pursued.reason, "shadow proposal recorded");
    assert.equal(store.data.shadowBook.at(-1).submitted, false);
    assert.ok(notices.some(text => text.includes("2 wallets:") && text.includes(firstWallet.slice(0, 6)) && text.includes(secondWallet.slice(0, 6)) && text.includes("Fabriq HOT seen 4m ago (127238, $26.71K)")));
    assert.ok(notices.some(text => text.includes("Shadow proposal (2 wallets:") && text.includes("Fabriq HOT seen 4m ago (127238, $26.71K)")));
    assert.ok(snapshots > 0);

    assert.equal(withFabriqContext(store, "MintQuiet111111111111111111111111111111111", "👀 Signal: 2 watched wallets", now), "👀 Signal: 2 watched wallets");

    const stale = { ...perp, id: "fabriqalert/1", at: now - 25 * 3600_000 };
    assert.equal(recordFabriqAlerts(store, [stale], now).length, 0);
    store.data.fabriqAlerts[mint].push({ ...perp, id: "fabriqalert/old", at: now - 25 * 3600_000 });
    store.prune(now);
    assert.equal(store.data.fabriqAlerts[mint].some(alert => alert.id === "fabriqalert/old"), false);
    assert.equal(fabriqContextLine(store, mint, now).includes("Fabriq HOT"), true);
  } finally {
    setNotifySink(null);
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("a Fabriq alert screens on its own, refreshes in place, and then respects cooldown", async () => {
  const { file, store } = tempStore();
  const notices = [];
  const releases = [];
  let snapshots = 0;
  const now = Date.now();
  const pool = "CYhy73LLqSKB9Bu1kD8xnABrJGRQNBcLvQU3wNGBUDaY";
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({
      snapshot: () => {
        snapshots += 1;
        return new Promise(resolve => releases.push(resolve));
      },
    }),
  });
  setNotifySink(text => notices.push(text));
  useRuntimeStore(store);
  try {
    const first = alertFrom("fabriqalert/40761", now);
    const opened = ingestFabriqAlerts([first], now, { startup: false });
    assert.equal(opened.length, 1);
    await waitFor(() => snapshots === 1);
    const signal = store.data.signals[mint];
    assert.equal(signal.source, "fabriq");
    assert.equal(signal.deadline, null);
    assert.equal(signal.pool, pool);
    const seenAt = signal.lastAlertAt;
    const again = alertFrom("fabriqalert/40762", now + 1_000);
    assert.equal(ingestFabriqAlerts([again], now + 1_000, { startup: false }).length, 1);
    assert.equal(store.data.signals[mint], signal);
    assert.ok(signal.lastAlertAt > seenAt);
    assert.equal(snapshots, 1);
    releases[0](passingSnapshot(mint));
    await signalPursuitSettled();
    assert.equal(signal.reason, "shadow proposal recorded");
    assert.equal(store.data.shadowBook.length, 1);
    assert.equal(store.data.shadowBook[0].submitted, false);
    assert.equal(store.data.shadowBook[0].poolAddress, pool);
    assert.equal(store.data.shadowBook[0].source, "fabriq");
    assert.ok(notices.some(text => text.includes("Signal: Fabriq HOT")));
    assert.ok(notices.some(text => text.includes("Shadow proposal (Fabriq HOT)")));
    const third = alertFrom("fabriqalert/40763", now + 2_000);
    assert.equal(ingestFabriqAlerts([third], now + 2_000, { startup: false }).length, 1);
    assert.equal(signal.done, true);
    assert.equal(signal.reason, "shadow proposal recorded");
    assert.equal(store.data.shadowBook.length, 1);
    assert.equal(snapshots, 1);
  } finally {
    for (const release of releases) release(passingSnapshot(mint));
    setNotifySink(null);
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("a Fabriq pursuit ends when the alert goes stale and does not skip wallet convergence first", async () => {
  const { file, store } = tempStore();
  const releases = [];
  let snapshots = 0;
  const staleMint = "MintStale111111111111111111111111111111111";
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({
      snapshot: () => {
        snapshots += 1;
        return new Promise(resolve => releases.push(() => resolve({ ok: false, reason: "candle provider is not configured" })));
      },
    }),
  });
  useRuntimeStore(store);
  try {
    const alert = alertFrom("fabriqalert/40761", Date.now(), staleMint);
    ingestFabriqAlerts([alert], Date.now(), { startup: false });
    await waitFor(() => snapshots === 1);
    store.data.signals[staleMint].lastAlertAt = Date.now() - (config.externalSignals.fabriq.staleAfterSec * 1000) - 5;
    releases.shift()();
    await signalPursuitSettled();
    assert.equal(store.data.signals[staleMint].reason, "fabriq alert went stale");
    assert.equal(store.data.shadowBook, undefined);
    assert.ok(snapshots >= 1);
  } finally {
    for (const release of releases) release();
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("a wallet signal evicts the oldest Fabriq pursuit when the cap is full", async () => {
  const { file, store } = tempStore();
  const releases = new Map();
  const started = [];
  const previousCap = config.standalone.maxActiveSignals;
  const previousFabriq = config.externalSignals.fabriq.maxActive;
  config.standalone.maxActiveSignals = 1;
  config.externalSignals.fabriq.maxActive = 3;
  const fabriqMint = "MintFabriq11111111111111111111111111111111";
  const walletMint = "MintWallet11111111111111111111111111111111";
  const [firstWallet, secondWallet] = OWNER_STRATEGY.wallets;
  const now = Date.now();
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({
      snapshot: mintArg => new Promise(resolve => {
        started.push(mintArg);
        releases.set(mintArg, resolve);
      }),
    }),
  });
  useRuntimeStore(store);
  try {
    ingestFabriqAlerts([alertFrom("fabriqalert/40761", now, fabriqMint)], now, { startup: false });
    await waitFor(() => started.includes(fabriqMint));
    const walletSignal = {
      mint: walletMint,
      createdAt: now,
      deadline: now + 60_000,
      done: false,
      events: [walletEvent(firstWallet, now - 1_000, walletMint), walletEvent(secondWallet, now - 500, walletMint)],
    };
    store.data.signals[walletMint] = walletSignal;
    const settled = enqueueSignal(walletSignal);
    await waitFor(() => store.data.signals[fabriqMint].reason === "evicted for a wallet signal");
    await waitFor(() => started.includes(walletMint));
    releases.get(walletMint)(passingSnapshot(walletMint));
    releases.get(fabriqMint)(passingSnapshot(fabriqMint));
    await settled;
    assert.equal(walletSignal.reason, "shadow proposal recorded");
    assert.equal(store.data.shadowBook.at(-1).source, "wallets");
    assert.equal(store.data.shadowBook.at(-1).submitted, false);
    assert.equal(store.data.shadowBook.some(position => position.mint === fabriqMint), false);
  } finally {
    config.standalone.maxActiveSignals = previousCap;
    config.externalSignals.fabriq.maxActive = previousFabriq;
    for (const resolve of releases.values()) resolve(passingSnapshot(walletMint));
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("a new Fabriq signal is dropped when its own cap is full", async () => {
  const { file, store } = tempStore();
  const releases = [];
  const previousFabriq = config.externalSignals.fabriq.maxActive;
  config.externalSignals.fabriq.maxActive = 1;
  const firstMint = "MintCapA111111111111111111111111111111111";
  const secondMint = "MintCapB111111111111111111111111111111111";
  let snapshots = 0;
  setPursuitDeps({
    sleep: async () => {},
    exposureStillPresent: async () => true,
    createMarketData: () => ({
      snapshot: () => {
        snapshots += 1;
        return new Promise(resolve => releases.push(resolve));
      },
    }),
  });
  useRuntimeStore(store);
  try {
    const now = Date.now();
    ingestFabriqAlerts([alertFrom("fabriqalert/40761", now, firstMint)], now, { startup: false });
    await waitFor(() => snapshots === 1);
    ingestFabriqAlerts([alertFrom("fabriqalert/40764", now, secondMint)], now, { startup: false });
    assert.equal(store.data.signals[secondMint].reason, "fabriq pursuit cap full");
    assert.equal(snapshots, 1);
    releases[0]({ ok: false, reason: "candle provider is not configured" });
    store.data.signals[firstMint].lastAlertAt = Date.now() - (config.externalSignals.fabriq.staleAfterSec * 1000) - 5;
    await signalPursuitSettled();
  } finally {
    config.externalSignals.fabriq.maxActive = previousFabriq;
    for (const release of releases) release({ ok: false, reason: "stop" });
    resetPursuitDeps();
    useRuntimeStore(null);
    fs.rmSync(file, { force: true });
  }
});

test("the poller backs off, dedupes by post id, and never requests GMGN", async () => {
  const urls = [];
  const queued = [];
  let seen = [];
  let fail = true;
  const poller = createFabriqPoller({
    url: "https://t.me/s/fabriqalert",
    pollSec: 20,
    fetchImpl: async url => {
      urls.push(String(url));
      if (fail) throw new Error("down");
      return { ok: true, text: async () => fixture };
    },
    onAlerts: alerts => { seen = alerts; },
    log: () => {},
    schedule: (fn, ms) => { queued.push({ fn, ms }); return queued.length; },
    clear: () => {},
  });
  await poller.start();
  assert.deepEqual(urls, ["https://t.me/s/fabriqalert"]);
  assert.equal(queued[0].ms, 40_000);
  fail = false;
  await queued[0].fn();
  assert.equal(seen.length, 20);
  assert.equal(seen.every(alert => alert.source === "fabriq"), true);
  assert.equal(queued[1].ms, 20_000);
  assert.equal(urls.every(url => !url.includes("gmgn")), true);
  poller.stop();
});
