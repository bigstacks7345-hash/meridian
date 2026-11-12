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

function atDistance(activeBin, at, fees, distPct, extra = {}) {
  const upperPrice = 100;
  return {
    ...observe(activeBin, at, fees),
    price: upperPrice * (1 - distPct / 100),
    upperPrice,
    tokenFeesUsd: fees / 2,
    solFeesUsd: fees / 2,
    ...extra,
  };
}

function shares(rows, bins) {
  return bins.map(bin => rows.find(row => row.bin === bin).share);
}

test("compound fires at $5 with no cost multiple and stays unexecuted", () => {
  const seeded = simulateLiquidity(position(), atDistance(120, 0, 0, 15), rules, 0);
  const short = simulateLiquidity(seeded.position, atDistance(120, 0, 4.99, 15), rules, 0);
  assert.equal(short.events.length, 0);
  const costly = atDistance(120, 0, 5, 15, { priorityFeeSol: 1 });
  const compounded = simulateLiquidity(seeded.position, costly, rules, 0);
  assert.equal(compounded.events.length, 1);
  assert.equal(compounded.events[0].kind, "compound");
  assert.equal(compounded.events[0].executed, false);
  assert.equal(compounded.events[0].feesUsd, 5);
  assert.equal(compounded.events[0].requireFeesExceedCostX, 0);
  assert.ok(compounded.events[0].estimatedCostUsd > compounded.events[0].feesUsd);
  const repeat = simulateLiquidity(compounded.position, costly, rules, 1_000);
  assert.equal(repeat.events.length, 0);
  const gatedRules = { ...rules, autoCompound: { ...rules.autoCompound, requireFeesExceedCostX: 3 } };
  const gated = simulateLiquidity(seeded.position, costly, gatedRules, 0);
  assert.equal(gated.events.length, 0);
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
  const dumped = simulateLiquidity(seeded.position, observe(114, 61_000), rules, 61_000);
  const dump = dumped.events[0];
  assert.equal(dump.direction, "down");
  assert.equal(dump.reshapedSide, "token");
  assert.equal(dump.keptSide, "sol");
  assert.equal(dump.mode, "one_side");
  assert.equal(dump.shapeAfter, "spot_bidask_5050");
  assert.ok(dump.rangeFraction < 0.5);
  for (const row of dumped.position.liquidity.bins.filter(item => item.bin < 114)) {
    assert.equal(row.share, before.find(item => item.bin === row.bin).share);
  }
  const wide = { ...position(), lowerBin: 80, upperBin: 220 };
  const wideSeed = simulateLiquidity(wide, { ...observe(120, 0), lowerBin: 80, upperBin: 220 }, rules, 0);
  const tooSoon = simulateLiquidity(wideSeed.position, { ...observe(123, 61_000), lowerBin: 80, upperBin: 220 }, rules, 61_000);
  assert.equal(tooSoon.events.length, 0);
  const firstPump = simulateLiquidity(wideSeed.position, { ...observe(124, 61_000), lowerBin: 80, upperBin: 220 }, rules, 61_000);
  assert.equal(firstPump.events[0].direction, "up");
  assert.equal(firstPump.events[0].reshapedSide, "sol");
  assert.equal(firstPump.events[0].firstPump, true);
  assert.equal(firstPump.events[0].pumpTriggerBins, 4);
  assert.equal(firstPump.events[0].binsMoved, 4);
  const laterShort = simulateLiquidity(firstPump.position, { ...observe(144, 130_000), lowerBin: 80, upperBin: 220 }, rules, 130_000);
  assert.equal(laterShort.events.length, 0);
  const later = simulateLiquidity(firstPump.position, { ...observe(145, 130_000), lowerBin: 80, upperBin: 220 }, rules, 130_000);
  const pump = later.events[0];
  assert.equal(pump.direction, "up");
  assert.equal(pump.reshapedSide, "sol");
  assert.equal(pump.keptSide, "token");
  assert.equal(pump.firstPump, false);
  assert.equal(pump.pumpAllowedBinMovement, 20);
  assert.equal(pump.pumpTriggerBins, 20);
  assert.equal(pump.pumpReshapeBins, 20);
  assert.equal(pump.binsMoved, 20);
  const pumpBefore = firstPump.position.liquidity.bins;
  for (const row of later.position.liquidity.bins.filter(item => item.bin >= 145 || item.bin < 125)) {
    assert.equal(row.share, pumpBefore.find(item => item.bin === row.bin).share);
  }
  const movedBins = later.position.liquidity.bins.filter(item => item.bin >= 125 && item.bin < 145);
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

test("compound bands pick a shape for each side and fall back past 40%", () => {
  const expectBand = [
    [5, 10, "curve", "bidask", false],
    [15, 25, "spot", "spot", false],
    [30, 40, "bidask", "curve", false],
    [50, null, "bidask", "curve", true],
  ];
  for (const [dist, maxDist, tokenShape, solShape, fallback] of expectBand) {
    const seeded = simulateLiquidity(position(), atDistance(120, 0, 0, dist), rules, 0);
    const compounded = simulateLiquidity(seeded.position, atDistance(120, 0, 5, dist), rules, 0);
    const event = compounded.events[0];
    assert.equal(event.kind, "compound", `${dist}%`);
    assert.ok(Math.abs(event.distFromTopPct - dist) < 1e-9);
    assert.equal(event.bandBasis, "pct_below_top");
    assert.equal(event.band.maxDistPct, maxDist);
    assert.equal(event.tokenShape, tokenShape);
    assert.equal(event.solShape, solShape);
    assert.equal(event.bandFallback, fallback);
    assert.equal(event.profitTake, false);
    assert.equal(event.tokenFeesUsd, 2.5);
    assert.equal(event.solFeesUsd, 2.5);
  }
  const seeded = simulateLiquidity(position(), atDistance(120, 0, 0, 5), rules, 0);
  const before = seeded.position.liquidity.bins;
  const top = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 5), rules, 0).position.liquidity.bins;
  const token = shares(top, [120, 124, 140]);
  const sol = shares(top, [100, 110, 119]);
  assert.ok(token[0] > token[1] && token[1] > token[2]);
  assert.ok(sol[0] > sol[1] && sol[1] > sol[2]);
  const mid = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 15), rules, 0).position.liquidity.bins;
  assert.equal(shares(mid, [120, 140])[0], shares(mid, [120, 140])[1]);
  assert.equal(shares(mid, [100, 119])[0], shares(mid, [100, 119])[1]);
  const deep = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 30), rules, 0).position.liquidity.bins;
  assert.ok(shares(deep, [120, 140])[0] < shares(deep, [120, 140])[1]);
  assert.ok(shares(deep, [100, 119])[0] < shares(deep, [100, 119])[1]);
  const tokenOnly = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 5, { tokenFeesUsd: 5, solFeesUsd: 0 }), rules, 0);
  for (const row of tokenOnly.position.liquidity.bins.filter(item => item.bin < 120)) {
    assert.equal(row.share, before.find(item => item.bin === row.bin).share);
  }
  const solOnly = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 5, { tokenFeesUsd: 0, solFeesUsd: 5 }), rules, 0);
  for (const row of solOnly.position.liquidity.bins.filter(item => item.bin >= 120)) {
    assert.equal(row.share, before.find(item => item.bin === row.bin).share);
  }
  const custom = {
    ...rules,
    autoCompound: { ...rules.autoCompound, fallbackBand: { tokenShape: "spot", solShape: "spot" } },
  };
  const fallback = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 50), custom, 0);
  assert.equal(fallback.events[0].bandFallback, true);
  assert.equal(fallback.events[0].tokenShape, "spot");
  assert.equal(fallback.events[0].solShape, "spot");
});

test("a curve compound profit-takes after 4 bins up and does not reshape twice", () => {
  const seeded = simulateLiquidity(position(), atDistance(120, 0, 0, 5), rules, 0);
  const compounded = simulateLiquidity(seeded.position, atDistance(120, 0, 5, 5), rules, 0);
  assert.equal(compounded.events[0].tokenShape, "curve");
  const placed = compounded.position.liquidity.bins;
  const early = simulateLiquidity(compounded.position, observe(124, 10_000), rules, 10_000);
  assert.equal(early.events.length, 0);
  const three = simulateLiquidity(compounded.position, observe(123, 61_000), rules, 61_000);
  assert.equal(three.events.length, 0);
  const taken = simulateLiquidity(compounded.position, observe(124, 61_000), rules, 61_000);
  assert.equal(taken.events.length, 1);
  assert.equal(taken.events.filter(item => item.kind === "reshape").length, 0);
  const profit = taken.events[0];
  assert.equal(profit.kind, "profit-take");
  assert.equal(profit.profitTake, true);
  assert.equal(profit.binsMoved, 4);
  assert.equal(profit.solShape, "bidask");
  assert.equal(profit.reshapedSide, "sol");
  assert.equal(profit.keptSide, "token");
  assert.equal(profit.executed, false);
  for (const row of taken.position.liquidity.bins.filter(item => item.bin >= 124 || item.bin < 120)) {
    assert.equal(row.share, placed.find(item => item.bin === row.bin).share);
  }
  const converted = taken.position.liquidity.bins.filter(item => item.bin >= 120 && item.bin < 124);
  assert.equal(converted.length, 4);
  assert.ok(converted.some(row => row.share !== placed.find(item => item.bin === row.bin).share));
  const repeat = simulateLiquidity(taken.position, observe(124, 122_000), rules, 122_000);
  assert.equal(repeat.events.length, 0);
  const sixMore = simulateLiquidity(taken.position, observe(130, 122_000), rules, 122_000);
  assert.equal(sixMore.events.length, 0);

  const wide = { lowerBin: 80, upperBin: 220 };
  const wideSeed = simulateLiquidity(position(wide), atDistance(120, 0, 0, 5, wide), rules, 0);
  const wideCompound = simulateLiquidity(wideSeed.position, atDistance(120, 0, 5, 5, wide), rules, 0);
  const both = simulateLiquidity(wideCompound.position, { ...observe(141, 61_000), ...wide }, rules, 61_000);
  assert.equal(both.events.length, 1);
  assert.equal(both.events[0].kind, "profit-take");
  assert.equal(both.events[0].binsMoved, 21);
  assert.equal(both.events.filter(item => item.kind === "reshape").length, 0);

  const midSeed = simulateLiquidity(position(), atDistance(120, 0, 0, 15), rules, 0);
  const mid = simulateLiquidity(midSeed.position, atDistance(120, 0, 5, 15), rules, 0);
  assert.equal(mid.events[0].tokenShape, "spot");
  const noTake = simulateLiquidity(mid.position, observe(124, 61_000), rules, 61_000);
  assert.equal(noTake.events.filter(item => item.kind === "profit-take").length, 0);
  assert.equal(noTake.events[0].kind, "reshape");
  assert.equal(noTake.events[0].firstPump, true);
});

test("halfway through the range reshapes both sides, and 49% stays one side", () => {
  const span = { lowerBin: 0, upperBin: 100 };
  const open = (bin) => simulateLiquidity(position(span), { ...observe(bin, 0), ...span }, rules, 0);
  const below = simulateLiquidity(open(0).position, { ...observe(49, 61_000), ...span }, rules, 61_000);
  assert.equal(below.events[0].reshapedSide, "sol");
  assert.ok(Math.abs(below.events[0].rangeFraction - 0.49) < 1e-9);
  assert.equal(below.events[0].inRangeMode, "one_side");
  const halfway = simulateLiquidity(open(0).position, { ...observe(50, 61_000), ...span }, rules, 61_000);
  assert.equal(halfway.events[0].reshapedSide, "both");
  assert.equal(halfway.events[0].keptSide, null);
  assert.equal(halfway.events[0].inRangeMode, "both_sides_full");
  assert.ok(Math.abs(halfway.events[0].rangeFraction - 0.5) < 1e-9);
  assert.deepEqual(halfway.events[0].legs, ["spot", "bidask"]);
  const dumped = simulateLiquidity(open(100).position, { ...observe(50, 61_000), ...span }, rules, 61_000);
  assert.equal(dumped.events[0].direction, "down");
  assert.equal(dumped.events[0].reshapedSide, "both");
  const shallow = simulateLiquidity(open(100).position, { ...observe(51, 61_000), ...span }, rules, 61_000);
  assert.equal(shallow.events[0].reshapedSide, "token");
  assert.ok(shallow.events[0].rangeFraction < 0.5);
});

test("the liquidity simulator has no transaction or submit path", () => {
  const source = fs.readFileSync(new URL("../strategy/liquidity-management.js", import.meta.url), "utf8");
  for (const token of ["executeTool", "sendTransaction", "sendRawTransaction", "VersionedTransaction", "signTransaction"]) {
    assert.equal(source.includes(token), false, token);
  }
  const forced = simulateLiquidity(position(), atDistance(120, 0, 50, 15), { ...rules, autoCompound: { ...rules.autoCompound, execute: true } }, 0);
  assert.equal(forced.executed, false);
  assert.equal(forced.events.every(item => item.executed === false && item.simulated === true), true);
});
