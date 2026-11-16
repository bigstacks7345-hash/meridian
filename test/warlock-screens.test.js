import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { evaluateEntry, evaluateExit, evaluateOorReposition } from "../strategy/rules.js";
import { stepShadowPosition } from "../strategy/shadow.js";
import { liquidityLiveGate } from "../strategy/liquidity-live.js";

const rules = OWNER_STRATEGY;
const now = Date.parse("2026-11-16T00:00:00Z");

function book(extra = {}) {
  return {
    status: "proposed",
    pnlDenomination: "quote",
    entryQuotePrice: 100,
    range: { upper: 100, lower: 40 },
    peakPnlPct: 0,
    pocValid: false,
    upperBin: 200,
    lowerBin: 100,
    oorRepositions: 0,
    ...extra,
  };
}

test("emergency take-profit and the breakeven lock log the rule that fires", () => {
  const mid = (100 + 40) / 2;
  const emergency = evaluateExit(book(), { pnlDenomination: "quote", positionPnlPct: 10, quotePrice: mid }, rules);
  assert.equal(emergency.rule, "emergency-take-profit");
  const aboveMid = evaluateExit(book(), { pnlDenomination: "quote", positionPnlPct: 10, quotePrice: mid + 0.01 }, rules);
  assert.equal(aboveMid.rule, "hard-take-profit");
  const short = evaluateExit(book(), { pnlDenomination: "quote", positionPnlPct: 9.99, quotePrice: mid }, rules);
  assert.equal(short.rule, "hard-take-profit");
  const locked = evaluateExit(book({ peakPnlPct: 5 }), { pnlDenomination: "quote", pnlPct: 0 }, rules);
  assert.equal(locked.rule, "breakeven-lock");
  const stillGreen = evaluateExit(book({ peakPnlPct: 4.99 }), { pnlDenomination: "quote", pnlPct: 4 }, rules);
  assert.equal(stillGreen.action, null);
  const armedDrop = evaluateExit(book({ peakPnlPct: 5 }), { pnlDenomination: "quote", pnlPct: -17 }, rules);
  assert.equal(armedDrop.rule, "breakeven-lock");
  const freshStop = evaluateExit(book({ peakPnlPct: 0 }), { pnlDenomination: "quote", pnlPct: -17 }, rules);
  assert.equal(freshStop.rule, "stop");
});

test("extra entry screens reject, fail closed, and can pass", () => {
  const base = passingSnapshot();
  assert.equal(evaluateEntry(base, rules).pass, true);
  const lowFee = evaluateEntry({ ...base, feeTvl30mPct: 0.59 }, rules);
  assert.ok(lowFee.reasons.some(reason => reason.includes("30m fee/TVL")));
  assert.ok(evaluateEntry({ ...base, feeTvl30mPct: null }, rules).reasons.some(reason => reason.includes("30m fee/TVL unavailable")));
  assert.equal(evaluateEntry({ ...base, feeTvl30mPct: 0.6 }, rules).pass, true);

  const hot = evaluateEntry({ ...base, liquidityUsd: 24_999, feeTvl24hPct: 60.01, pools: [{ liquidityUsd: 24_999 }] }, rules);
  assert.ok(hot.reasons.some(reason => reason.includes("fee turnover")));
  assert.equal(evaluateEntry({ ...base, liquidityUsd: 25_000, feeTvl24hPct: 90, pools: [{ liquidityUsd: 25_000 }] }, rules).pass, true);
  assert.ok(evaluateEntry({ ...base, liquidityUsd: 10_000, feeTvl24hPct: null, pools: [{ liquidityUsd: 10_000 }] }, rules).reasons.some(reason => reason.includes("24h fee/TVL unavailable")));
  assert.ok(evaluateEntry({ ...base, liquidityUsd: null }, rules).reasons.some(reason => reason.includes("fee turnover TVL unavailable")));

  const flagged = evaluateEntry({ ...base, rugRisky: true, checkedAt: now }, rules);
  assert.ok(flagged.reasons.some(reason => reason.includes("sticky rug")));
  const sticky = evaluateEntry({ ...base, rugRisky: false, rugFlaggedAt: now - 1000, checkedAt: now }, rules);
  assert.ok(sticky.reasons.some(reason => reason.includes("stays blocked")));
  const expired = evaluateEntry({ ...base, rugRisky: false, rugFlaggedAt: now - rules.stickyRug.ttlMs, checkedAt: now }, rules);
  assert.equal(expired.pass, true);
  assert.ok(evaluateEntry({ ...base, rugRisky: undefined, rugFlaggedAt: undefined }, rules).reasons.some(reason => reason.includes("rug check unavailable")));

  const twin = evaluateEntry({
    ...base,
    liquidityUsd: 20_000,
    pools: [
      { liquidityUsd: 20_000 },
      { liquidityUsd: 40_000 },
      { liquidityUsd: 9_000 },
    ],
  }, rules);
  assert.ok(twin.reasons.some(reason => reason.includes("keep biggest")));
  assert.equal(evaluateEntry({ ...base, pools: [{ liquidityUsd: 50_000 }, { liquidityUsd: 9_000 }] }, rules).pass, true);
  assert.ok(evaluateEntry({ ...base, pools: undefined }, rules).reasons.some(reason => reason.includes("pool siblings unavailable")));

  const cooled = evaluateEntry({ ...base, slClosedAt: now - 1000, checkedAt: now }, rules);
  assert.ok(cooled.reasons.some(reason => reason.includes("stop-loss blacklist")));
  assert.equal(evaluateEntry({ ...base, slClosedAt: now - rules.slMintBlacklist.cooldownMs, checkedAt: now }, rules).pass, true);
  assert.ok(evaluateEntry({ ...base, slClosedAt: undefined }, rules).reasons.some(reason => reason.includes("stop-loss history unavailable")));
});

test("an out-of-range pump repositions in shadow only, within the cap and floors", () => {
  const position = book({ upperBin: 200, lowerBin: 100 });
  const tick = (bin, pnl) => ({ pnlDenomination: "quote", pnlPct: pnl, activeBin: bin, upperBin: position.upperBin, lowerBin: position.lowerBin });
  assert.equal(evaluateOorReposition(position, tick(205, 0), rules, 0).action, null);
  const first = stepShadowPosition(position, tick(206, 0), rules);
  assert.equal(first.exit, null);
  assert.equal(first.reposition.rule, "oor-reposition");
  assert.equal(first.reposition.simulated, true);
  assert.equal(first.reposition.executed, false);
  assert.deepEqual(first.reposition.hybrid.legs, ["spot", "bidask"]);
  assert.equal(first.position.upperBin, 206);
  assert.equal(first.position.lowerBin, 106);
  assert.equal(first.position.oorRepositions, 1);
  const second = stepShadowPosition(first.position, { ...tick(212, 0), upperBin: 206, lowerBin: 106 }, rules);
  assert.equal(second.position.oorRepositions, 2);
  const capped = evaluateOorReposition(second.position, { ...tick(220, 0), upperBin: second.position.upperBin, lowerBin: second.position.lowerBin }, rules, 0);
  assert.match(capped.reason, /cap/);
  assert.match(evaluateOorReposition(position, tick(206, -3.01), rules, -3.01).reason, /below/);
  assert.equal(evaluateOorReposition(position, tick(206, -3), rules, -3).action, "reposition");
  const profit = evaluateExit(position, tick(206, 0.5), rules);
  assert.equal(profit.rule, "oor-take-profit");
  const under = evaluateExit(position, tick(206, 0.49), rules);
  assert.equal(under.action, null);
  assert.equal(rules.oorReposition.execute, false);
  const gate = liquidityLiveGate({
    shadowMode: true,
    dryRunBlocksSubmit: true,
    walletKeyPresent: false,
    execute: rules.oorReposition.execute === true,
  });
  assert.equal(gate.allowed, false);
});
