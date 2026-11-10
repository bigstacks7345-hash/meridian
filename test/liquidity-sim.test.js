import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { liquidityCloseSummary, simulateLiquidity } from "../strategy/liquidity-management.js";

const rules = {
  ...OWNER_STRATEGY,
  autoCompound: { ...OWNER_STRATEGY.autoCompound, execute: true },
  reshapeLiquidity: { ...OWNER_STRATEGY.reshapeLiquidity, execute: true },
};

function position(extra = {}) {
  return {
    id: "shadow-pos",
    status: "proposed",
    openedAt: 0,
    lowerBin: 100,
    upperBin: 140,
    ...extra,
  };
}

function observe(activeBin, at, fees = 0) {
  return {
    at,
    activeBin,
    lowerBin: 100,
    upperBin: 140,
    unclaimedFeesUsd: fees,
    solPriceUsd: 100,
    baseFeeSol: 0.000005,
    priorityFeeSol: fees === 6 ? 0.05 : 0,
    rentSol: 0,
  };
}

test("compound waits for fees above cost, then fires without executing", () => {
  const seeded = simulateLiquidity(position(), observe(120, 0, 6), rules, 0);
  assert.equal(seeded.events.length, 0);
  assert.equal(seeded.executed, false);
  const rich = simulateLiquidity(seeded.position, observe(120, 0, 20), rules, 0);
  assert.equal(rich.events.length, 1);
  assert.equal(rich.events[0].kind, "compound");
  assert.equal(rich.events[0].executed, false);
  assert.equal(rich.events[0].shapeAfter, "spot");
  assert.ok(rich.events[0].feesUsd >= 5);
  assert.ok(rich.events[0].feesUsd >= 3 * rich.events[0].estimatedCostUsd);
  const repeat = simulateLiquidity(rich.position, observe(120, 1_000, 20), rules, 1_000);
  assert.equal(repeat.events.length, 0);
});

test("reshape follows a bin move, flips near the edge, and waits for the interval", () => {
  const seeded = simulateLiquidity(position(), observe(120, 0), rules, 0);
  const early = simulateLiquidity(seeded.position, observe(126, 10_000), rules, 10_000);
  assert.equal(early.events.length, 0);
  const moved = simulateLiquidity(seeded.position, observe(126, 61_000), rules, 61_000);
  assert.equal(moved.events.length, 1);
  assert.equal(moved.events[0].kind, "reshape");
  assert.equal(moved.events[0].reason, "bin movement");
  assert.equal(moved.events[0].shapeBefore, "curve");
  assert.equal(moved.events[0].activeBin, 126);
  assert.equal(moved.executed, false);
  const flipped = simulateLiquidity(seeded.position, observe(139, 61_000), rules, 61_000);
  assert.equal(flipped.events[0].reason, "flip buffer");
  assert.equal(flipped.events[0].shapeAfter, "spot_bidask_5050");
  assert.ok(flipped.events[0].nearShareBefore > 0 && flipped.events[0].nearShareBefore < 1);
  assert.ok(flipped.events[0].nearShareAfter > 0 && flipped.events[0].nearShareAfter < 1);
  const summary = liquidityCloseSummary(flipped.position, 120_000);
  assert.equal(summary.reshapes, 1);
  assert.equal(summary.compounds, 0);
  assert.equal(summary.executed, false);
  assert.ok(summary.estimatedCostSol > 0);
});

test("the liquidity simulator has no transaction or submit path", () => {
  const source = fs.readFileSync(new URL("../strategy/liquidity-management.js", import.meta.url), "utf8");
  for (const token of ["executeTool", "sendTransaction", "sendRawTransaction", "VersionedTransaction", "signTransaction"]) {
    assert.equal(source.includes(token), false, token);
  }
  const forced = simulateLiquidity(position(), observe(120, 0, 50), { ...rules, autoCompound: { ...rules.autoCompound, execute: true } }, 0);
  assert.equal(forced.executed, false);
  assert.equal(forced.events.every(item => item.executed === false && item.simulated === true), true);
});
