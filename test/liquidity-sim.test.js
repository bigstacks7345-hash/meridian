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
  const early = simulateLiquidity(seeded.position, observe(114, 10_000), rules, 10_000);
  assert.equal(early.events.length, 0);
  const moved = simulateLiquidity(seeded.position, observe(114, 61_000), rules, 61_000);
  assert.equal(moved.events.length, 1);
  assert.equal(moved.events[0].kind, "reshape");
  assert.equal(moved.events[0].reason, "bin movement");
  assert.equal(moved.events[0].shapeBefore, "curve");
  assert.equal(moved.events[0].activeBin, 114);
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

test("a dump reshapes only the token side and a pump reshapes only the SOL side", () => {
  const seeded = simulateLiquidity(position(), observe(120, 0), rules, 0);
  const before = seeded.position.liquidity.bins.map(row => ({ ...row }));
  const dumped = simulateLiquidity(seeded.position, observe(110, 61_000), rules, 61_000);
  const dump = dumped.events[0];
  assert.equal(dump.direction, "down");
  assert.equal(dump.reshapedSide, "token");
  assert.equal(dump.keptSide, "sol");
  assert.equal(dump.mode, "one_side");
  assert.equal(dump.shapeAfter, "spot_bidask_5050");
  for (const row of dumped.position.liquidity.bins.filter(item => item.bin < 110)) {
    assert.equal(row.share, before.find(item => item.bin === row.bin).share);
  }
  const wide = { ...position(), lowerBin: 80, upperBin: 220 };
  const wideSeed = simulateLiquidity(wide, { ...observe(120, 0), lowerBin: 80, upperBin: 220 }, rules, 0);
  for (const binsUp of [6, 19, 20]) {
    const held = simulateLiquidity(wideSeed.position, { ...observe(120 + binsUp, 61_000), lowerBin: 80, upperBin: 220 }, rules, 61_000);
    assert.equal(held.events.length, 0, `${binsUp} bins up`);
  }
  const pumped = simulateLiquidity(wideSeed.position, { ...observe(141, 61_000), lowerBin: 80, upperBin: 220 }, rules, 61_000);
  const pump = pumped.events[0];
  assert.equal(pump.direction, "up");
  assert.equal(pump.reshapedSide, "sol");
  assert.equal(pump.keptSide, "token");
  assert.equal(pump.pumpAllowedBinMovement, 20);
  assert.equal(pump.pumpReshapeBins, 20);
  assert.equal(pump.allowedBinMovement, 5);
  const pumpBefore = wideSeed.position.liquidity.bins;
  for (const row of pumped.position.liquidity.bins.filter(item => item.bin >= 141 || item.bin < 121)) {
    assert.equal(row.share, pumpBefore.find(item => item.bin === row.bin).share);
  }
  const movedBins = pumped.position.liquidity.bins.filter(item => item.bin >= 121 && item.bin < 141);
  assert.equal(movedBins.length, 20);
  const lowerEdge = simulateLiquidity(seeded.position, observe(101, 61_000), rules, 61_000);
  assert.equal(lowerEdge.events[0].reason, "flip buffer");
  assert.equal(lowerEdge.events[0].reshapedSide, "token");
  assert.equal(lowerEdge.events[0].keptSide, "sol");
  const upperEdge = simulateLiquidity(seeded.position, observe(139, 61_000), rules, 61_000);
  assert.equal(upperEdge.events[0].reason, "flip buffer");
  assert.equal(upperEdge.events[0].reshapedSide, "sol");
  assert.equal(upperEdge.events[0].keptSide, "token");
  const bothRules = { ...rules, reshapeLiquidity: { ...rules.reshapeLiquidity, mode: "both_sides" } };
  const both = simulateLiquidity(seeded.position, observe(110, 61_000), bothRules, 61_000);
  assert.equal(both.events[0].reshapedSide, "both");
  assert.equal(both.events[0].keptSide, null);
  assert.equal(both.events[0].shapeAfter, "curve");
  assert.ok(dump.estimatedCostSol < both.events[0].estimatedCostSol);
  assert.equal(both.events[0].executed, false);
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
