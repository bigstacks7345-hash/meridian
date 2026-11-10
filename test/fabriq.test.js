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
import { enqueueSignal, ingestFabriqAlerts, resetPursuitDeps, setNotifySink, setPursuitDeps, useRuntimeStore } from "../standalone/runtime.js";

const fixture = fs.readFileSync(new URL("./fixtures/fabriqalert.html", import.meta.url), "utf8");
const mint = "BH5bq6NamreYUbu1hG6RQyCXXzrDvQ7Zi7w82mrbpump";

function tempStore() {
  const file = path.join(os.tmpdir(), `meridian-fabriq-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return { file, store: new MonitorStore(file) };
}

function walletEvent(wallet, at, token = mint) {
  return { id: `${wallet}:${at}`, mint: token, wallet, pool: "PoolA", at, depositSol: 1, position: "pos", slot: 1, shares: "10" };
}

test("fabriq config is watch-only and on by default", () => {
  assert.equal(config.externalSignals.fabriq.enabled, true);
  assert.equal(config.externalSignals.fabriq.pollSec, 20);
  assert.equal(config.externalSignals.fabriq.channel, "fabriqalert");
  assert.equal(config.externalSignals.fabriq.url, "https://t.me/s/fabriqalert");
  const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
  assert.equal(example.externalSignals.fabriq.enabled, true);
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

test("Fabriq never triggers, and a real two-wallet signal keeps the alert as context", async () => {
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
  try {
    const added = ingestFabriqAlerts([perp, second], now);
    assert.equal(added.length, 2);
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
    assert.ok(notices.some(text => text.startsWith("👀 Signal:") && text.includes("Fabriq HOT seen 4m ago (127238, $26.71K)")));
    assert.ok(notices.some(text => text.includes("Shadow proposal") && text.includes("Fabriq HOT seen 4m ago (127238, $26.71K)")));
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
