import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { canOpen, entryRange, evaluateEntry, evaluateExit, positionLegs, watchedConvergence } from "../strategy/rules.js";
import { planShadowEntry, stepShadowPosition } from "../strategy/shadow.js";
import { REPO_ROOT } from "../repo-root.js";

const rules = OWNER_STRATEGY;
const mint = "MintReplay11111111111111111111111111111111";
const now = Date.parse("2026-11-09T00:00:00Z");
const wallets = rules.wallets;

function events(pairs) {
  return pairs.map((pair, index) => ({
    wallet: pair.wallet,
    mint,
    pool: pair.pool || `Pool${index}`,
    at: pair.at ?? now - 10_000,
    depositSol: pair.depositSol ?? 1,
  }));
}

test("any two watched wallets trigger, with no priority and different pools allowed", () => {
  assert.equal(new Set(wallets).size, 14);
  const lateSmall = watchedConvergence(events([
    { wallet: wallets[13], pool: "PoolA", at: now - 20_000, depositSol: 0.2 },
    { wallet: wallets[0], pool: "PoolB", at: now - 100_000, depositSol: 5 },
  ]), rules, now);
  const otherPair = watchedConvergence(events([
    { wallet: wallets[3], pool: "PoolC" },
    { wallet: wallets[8], pool: "PoolD" },
  ]), rules, now);
  assert.equal(lateSmall.length, 1);
  assert.deepEqual(lateSmall[0].wallets.sort(), [wallets[0], wallets[13]].sort());
  assert.equal(otherPair.length, 1);
  assert.equal(watchedConvergence(events([{ wallet: wallets[1] }]), rules, now).length, 0);
  assert.equal(watchedConvergence(events([
    { wallet: wallets[1], at: now - 130_000 },
    { wallet: wallets[2], at: now - 1_000 },
  ]), rules, now).length, 0);
  assert.equal(watchedConvergence(events([
    { wallet: "NotAWatchedWallet111111111111111111111111111", pool: "PoolA" },
    { wallet: wallets[1], pool: "PoolB" },
  ]), rules, now).length, 0);
});

test("every entry filter fails closed on its own and together they can pass", () => {
  const base = passingSnapshot(mint);
  assert.equal(evaluateEntry(base, rules).pass, true);
  const missing = [
    ["binStep", null, "bin step"],
    ["liquidityUsd", 9_000, "liquidity"],
    ["liquidityUsd", 200_000, "liquidity"],
    ["mcapUsd", 349_000, "market cap"],
    ["holders", 1499, "holders"],
    ["livePrice", null, "live price"],
  ];
  for (const [key, value, text] of missing) {
    const result = evaluateEntry({ ...base, [key]: value }, rules);
    assert.equal(result.pass, false, key);
    assert.ok(result.reasons.some(reason => reason.includes(text)), result.reasons.join("; "));
  }
  const thinVolume = { ...base, closed5m: [{ ...base.closed5m.at(-1), v: 89_999 }] };
  assert.ok(evaluateEntry(thinVolume, rules).reasons.some(reason => reason.includes("5m volume")));
  const quiet = { ...base, current1m: { ...base.current1m, v: 1 } };
  assert.ok(evaluateEntry(quiet, rules).reasons.some(reason => reason.includes("volume")));
  assert.equal(evaluateEntry({ ...base, mcapUsd: 50_000_000 }, rules).pass, true);
  assert.equal(evaluateEntry({ ok: false, reason: "candle provider is not configured" }, rules).pass, false);
});

test("range clamps 40% below Supertrend into 65–73% below entry", () => {
  const inside = entryRange(100, 50, 100, rules);
  assert.equal(inside.ok, true);
  assert.equal(inside.upper, 100);
  assert.equal(inside.rawLower, 30);
  assert.equal(inside.lower, 30);
  const tooShallow = entryRange(100, 80, 100, rules);
  assert.equal(tooShallow.lower, 35);
  const tooDeep = entryRange(100, 40, 100, rules);
  assert.equal(tooDeep.lower, 27);
  assert.equal(tooShallow.binsAbove, 0);
  assert.ok(tooDeep.binsBelow >= 35);
});

test("size is 0.25 spot plus 0.25 bid/ask, with two positions and a three minute gap", () => {
  const sized = positionLegs(rules);
  assert.deepEqual(sized.legs, [
    { strategy: "spot", amountSol: 0.25, amountToken: 0 },
    { strategy: "bid_ask", amountSol: 0.25, amountToken: 0 },
  ]);
  const snapshot = passingSnapshot(mint);
  const signal = { mint, events: events([{ wallet: wallets[0] }, { wallet: wallets[1] }]) };
  const first = planShadowEntry({ signal, snapshot, book: [], rules, now });
  assert.equal(first.ok, true);
  assert.equal(first.proposal.submitted, false);
  const second = planShadowEntry({
    signal: { mint, events: events([{ wallet: wallets[2], at: now + 110_000 }, { wallet: wallets[3], at: now + 115_000 }]) },
    snapshot,
    book: [first.proposal],
    rules,
    now: now + 120_000,
  });
  assert.equal(second.ok, false);
  assert.match(second.reason, /minimum time/);
  const later = planShadowEntry({
    signal: { mint, events: events([{ wallet: wallets[2], at: now + 170_000 }, { wallet: wallets[3], at: now + 175_000 }]) },
    snapshot,
    book: [first.proposal],
    rules,
    now: now + 180_000,
  });
  assert.equal(later.ok, true);
  assert.equal(canOpen([first.proposal, later.proposal], { mint }, rules, now + 400_000).ok, false);
});

test("exits are stop, hard target, one-point trail, or a completed 5m close below a deep POC", () => {
  const quote = { pnlDenomination: "quote" };
  const hold = { status: "proposed", peakPnlPct: 0, pocValid: true, pocPrice: 10, pnlDenomination: "quote", entryQuotePrice: 1 };
  assert.equal(stepShadowPosition(hold, { ...quote, pnlPct: 1 }, rules).exit, null);
  assert.equal(stepShadowPosition(hold, { ...quote, pnlPct: -0.5 }, rules).exit, null);
  assert.equal(stepShadowPosition(hold, { ...quote, pnlPct: 1.85 }, rules).exit, null);
  assert.equal(evaluateExit({ ...hold, peakPnlPct: 2, pocValid: false }, { ...quote, pnlPct: 1 }, rules).rule, "trail");
  assert.equal(evaluateExit({ ...hold, peakPnlPct: 2, pocValid: false }, { ...quote, pnlPct: 1.01 }, rules).action, null);
  assert.equal(evaluateExit({ ...hold, peakPnlPct: 4, pocValid: false }, { ...quote, pnlPct: 5 }, rules).rule, "hard-take-profit");
  assert.equal(evaluateExit({ ...hold, peakPnlPct: 0, pocValid: false }, { ...quote, pnlPct: -17 }, rules).rule, "stop");
  assert.equal(evaluateExit(hold, { ...quote, pnlPct: 0.2 }, rules).action, null);
  assert.equal(evaluateExit(hold, { ...quote, pnlPct: 0.2, completed5mClose: 9.9 }, rules).rule, "poc");
  assert.equal(evaluateExit({ ...hold, pocValid: false }, { ...quote, pnlPct: 0.2, completed5mClose: 9.9 }, rules).action, null);
  assert.equal(stepShadowPosition(hold, { ...quote, pnlPct: null }, rules).held, "pnl unavailable");
  assert.equal(evaluateExit(hold, { pnlDenomination: "usd", pnlPct: -17 }, rules).action, null);
  const meme = { ...hold, entryQuotePrice: 0.001, pocValid: false };
  assert.equal(evaluateExit(meme, { quotePrice: 0.00083 }, rules).rule, "stop");
  assert.equal(evaluateExit(meme, { quotePrice: 0.00099 }, rules).action, null);
});

test("the example config matches the owner defaults and admin polling stays off", () => {
  const example = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "user-config.example.json"), "utf8"));
  assert.deepEqual(example.ownerStrategy, OWNER_STRATEGY);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({}) }; };
    const { startAdmin } = await import("./standalone/telegram-admin.js");
    const stop = startAdmin();
    stop();
    if (calls.length) throw new Error(calls.join(","));
    console.log("admin-off");
  `], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /admin-off/);
});

test("shadow replay proposes both legs and trails out without submitting", () => {
  const child = spawnSync(process.execPath, ["scripts/shadow-replay.js"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
  assert.equal(report.submitted, false);
  assert.equal(report.profile, "tradingview-vpvr");
  assert.equal(report.pocValid, true);
  assert.equal(report.legs[0].amountSol, 0.25);
  assert.equal(report.legs[1].strategy, "bid_ask");
  assert.deepEqual(report.trace.map(step => step.exit), [null, null, null, null, "trail"]);
});
