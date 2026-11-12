import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { liquidityLiveGate, runLiquidityExecution } from "../strategy/liquidity-live.js";
import { config, transactionsAreDryRun } from "../config.js";

const types = { Spot: "Spot", Curve: "Curve", BidAsk: "BidAsk" };
const rules = {
  ...OWNER_STRATEGY,
  autoCompound: { ...OWNER_STRATEGY.autoCompound, execute: true },
  reshapeLiquidity: { ...OWNER_STRATEGY.reshapeLiquidity, execute: true },
};

function gate(open, overrides = {}) {
  return kind => liquidityLiveGate({
    shadowMode: overrides.shadowMode ?? false,
    dryRunBlocksSubmit: overrides.dryRunBlocksSubmit ?? false,
    walletKeyPresent: overrides.walletKeyPresent ?? true,
    execute: open.includes(kind) && overrides.execute !== false,
  });
}

function book(active) {
  const rows = [];
  for (let bin = 80; bin <= 220; bin++) {
    rows.push({
      binId: bin,
      positionXAmount: bin >= active ? "1000" : "0",
      positionYAmount: bin < active ? "1000" : "0",
    });
  }
  return rows;
}

function ioFor(active) {
  const calls = [];
  const io = {
    owner: "owner",
    signers: ["signer"],
    strategyTypes: types,
    signatures: [],
    calls,
    sends: 0,
    inventoryActive: active,
    feeX: 0,
    feeY: 0,
    connection: {
      simulateTransaction: async (tx) => {
        calls.push({ op: "simulate", instructions: tx.instructions?.length ?? 0 });
        return { value: { err: io.simulateErr || null, unitsConsumed: io.unitsConsumed ?? 1000 } };
      },
    },
    send: async () => {
      io.sends += 1;
      if (io.failSends > 0) {
        io.failSends -= 1;
        throw new Error("blockhash not found");
      }
      if (io.failAddBack && (io.batches?.length || 0) >= 2) throw new Error("add failed");
      return `sig-${io.sends}`;
    },
    pool: {
      getActiveBin: async () => ({ binId: io.liveBin ?? io.inventoryActive }),
      getPosition: async () => ({
        positionData: { feeX: new BN(io.feeX), feeY: new BN(io.feeY), positionBinData: book(io.inventoryActive) },
      }),
      removeLiquidity: async (args) => {
        calls.push({ op: "remove", fromBinId: args.fromBinId, toBinId: args.toBinId, bps: args.bps.toString(), shouldClaimAndClose: args.shouldClaimAndClose });
        return [new Transaction()];
      },
      rebalanceLiquidity: async (args) => {
        calls.push({ op: "rebalanceLiquidity", fromBinId: args.fromBinId, toBinId: args.toBinId, bps: args.bps, shrinkMode: args.shrinkMode, adds: args.adds, shouldClaimFee: args.shouldClaimFee });
        return { name: "rebalanceLiquidity" };
      },
      addLiquidity2: async (args) => {
        calls.push({
          op: "addLiquidity2",
          leg: args.leg,
          x: args.amountX.toString(),
          y: args.amountY.toString(),
          bins: args.binLiquidityDist.map(row => row.binId),
          distributionX: args.binLiquidityDist.map(row => row.distributionX),
          distributionY: args.binLiquidityDist.map(row => row.distributionY),
        });
        if (io.failAdd) throw new Error("add failed");
        return { name: "addLiquidity2", leg: args.leg };
      },
      claimSwapFee: async () => {
        calls.push({ op: "claimFee" });
        return [new Transaction()];
      },
      addLiquidityByStrategy: async (args) => {
        calls.push({
          op: "add",
          strategyType: args.strategy.strategyType,
          minBinId: args.strategy.minBinId,
          maxBinId: args.strategy.maxBinId,
          x: args.totalXAmount.toString(),
          y: args.totalYAmount.toString(),
          slippage: args.slippage,
        });
        if (io.failAdd) throw new Error("add failed");
        return new Transaction();
      },
      addLiquidityByStrategyChunkable: async (args) => {
        calls.push({
          op: "chunk",
          strategyType: args.strategy.strategyType,
          minBinId: args.strategy.minBinId,
          maxBinId: args.strategy.maxBinId,
          x: args.totalXAmount.toString(),
          y: args.totalYAmount.toString(),
          slippage: args.slippage,
        });
        if (io.failAdd) throw new Error("add failed");
        return [new Transaction()];
      },
    },
  };
  return io;
}

function position() {
  return { id: "pos", lowerBin: 80, upperBin: 220, openedAt: 0 };
}

function observe(active, at, fees = 0, dist = 15) {
  return {
    at,
    activeBin: active,
    lowerBin: 80,
    upperBin: 220,
    unclaimedFeesUsd: fees,
    tokenFeesUsd: fees / 2,
    solFeesUsd: fees / 2,
    price: 100 * (1 - dist / 100),
    upperPrice: 100,
    solPriceUsd: 100,
    priorityFeeSol: 1,
  };
}

function removes(io) {
  return io.calls.filter(call => call.op === "remove");
}

function adds(io) {
  return io.calls.filter(call => call.op === "add" || call.op === "chunk");
}

async function seeded(io, open = ["reshape", "compound", "profit-take"]) {
  return runLiquidityExecution({
    position: position(),
    observation: observe(120, 0),
    rules,
    now: 0,
    gate: gate(open),
    io,
    record: () => {},
    alert: () => {},
  });
}

test("the live gate stays closed on this build", () => {
  assert.equal(config.standalone.shadow, true);
  assert.equal(transactionsAreDryRun(), true);
  assert.equal(config.ownerStrategy.autoCompound.execute, false);
  assert.equal(config.ownerStrategy.reshapeLiquidity.execute, false);
  for (const overrides of [
    { execute: false },
    { shadowMode: true },
    { dryRunBlocksSubmit: true },
    { walletKeyPresent: false },
  ]) {
    const closed = liquidityLiveGate({
      shadowMode: false,
      dryRunBlocksSubmit: false,
      walletKeyPresent: true,
      execute: true,
      ...overrides,
    });
    assert.equal(closed.allowed, false);
  }
  const source = fs.readFileSync(new URL("../strategy/liquidity-live.js", import.meta.url), "utf8");
  assert.equal(source.includes("WALLET_PRIVATE_KEY"), false);
  assert.equal(source.includes("fromSecretKey"), false);
  assert.equal(source.includes("sendAndConfirmTransaction"), false);
});

test("a closed gate builds no transaction", async () => {
  const io = ioFor(114);
  const seededPosition = await seeded(io, []);
  const moved = await runLiquidityExecution({
    position: seededPosition.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate([], { execute: false }),
    io,
    record: () => {},
  });
  assert.equal(moved.events.length, 1);
  assert.equal(moved.events[0].executed, false);
  assert.equal(io.calls.length, 0);
  assert.equal(io.sends, 0);
});

test("a dump reshapes only the token side and a pump reshapes only the SOL window", async () => {
  const dumpIo = ioFor(114);
  const dumpSeed = await seeded(dumpIo);
  const held = await runLiquidityExecution({
    position: dumpSeed.position,
    observation: observe(115, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: dumpIo,
  });
  assert.equal(held.events.length, 0);
  assert.equal(removes(dumpIo).length, 0);
  const dumped = await runLiquidityExecution({
    position: dumpSeed.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: dumpIo,
  });
  const dump = dumpIo.calls.find(call => call.op === "rebalanceLiquidity");
  assert.equal(dumped.events[0].executed, true);
  assert.equal(dumped.events[0].shrinkMode, 3);
  assert.deepEqual(dumped.events[0].legs, ["spot", "bidask"]);
  assert.equal(dump.fromBinId, 114);
  assert.equal(dump.toBinId, 220);
  assert.equal(dump.bps, 10000);
  assert.equal(dump.shrinkMode, 3);
  assert.deepEqual(dump.adds, []);
  assert.equal(dump.shouldClaimFee, false);
  const dumpAdds = dumpIo.calls.filter(call => call.op === "addLiquidity2");
  assert.ok(dumpAdds.some(row => row.leg === "spot") && dumpAdds.some(row => row.leg === "bidask"));
  assert.ok(dumpAdds.every(row => row.bins.length <= 45 && row.y === "0"));
  const spotX = dumpAdds.filter(row => row.leg === "spot").reduce((sum, row) => sum + Number(row.x), 0);
  const bidX = dumpAdds.filter(row => row.leg === "bidask").reduce((sum, row) => sum + Number(row.x), 0);
  assert.ok(Math.abs(spotX - bidX) <= 1);

  const pumpIo = ioFor(141);
  const pumpSeed = await seeded(pumpIo);
  for (const binsUp of [6, 19, 20]) {
    const quiet = await runLiquidityExecution({
      position: pumpSeed.position,
      observation: observe(120 + binsUp, 61_000),
      rules,
      now: 61_000,
      gate: gate(["reshape"]),
      io: pumpIo,
    });
    assert.equal(quiet.events.length, 0, `${binsUp} bins`);
  }
  const pumped = await runLiquidityExecution({
    position: pumpSeed.position,
    observation: observe(141, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: pumpIo,
  });
  const pump = pumpIo.calls.find(call => call.op === "rebalanceLiquidity");
  assert.equal(pumped.events[0].executed, true);
  assert.equal(pump.fromBinId, 121);
  assert.equal(pump.toBinId, 140);
  assert.equal(pump.shrinkMode, 3);
  assert.deepEqual(pump.adds, []);
  const pumpAdds = pumpIo.calls.filter(call => call.op === "addLiquidity2");
  assert.deepEqual(pumpAdds.map(row => row.leg), ["spot", "bidask"]);
  assert.ok(pumpAdds.every(row => row.x === "0" && row.bins[0] === 121 && row.bins.at(-1) === 140));
  assert.equal(pumpIo.batches.length, 1);
  assert.deepEqual(pumpIo.batches[0].names, ["rebalanceLiquidity", "addLiquidity2", "addLiquidity2"]);
  assert.equal(pumpIo.batches[0].cuPriceMicroLamports, 500);
  assert.equal(pumpIo.batches[0].jitoTipLamports, 0);
  assert.equal(pumpIo.batches[0].cuLimit, 1150);
  const spotLeg = pumpAdds.find(row => row.leg === "spot");
  const bidLeg = pumpAdds.find(row => row.leg === "bidask");
  assert.equal(spotLeg.distributionY[0], spotLeg.distributionY.at(-1));
  assert.ok(bidLeg.distributionY[0] > bidLeg.distributionY.at(-1));
  assert.equal(spotLeg.distributionY.reduce((sum, value) => sum + value, 0), 10_000);
  assert.equal(bidLeg.distributionY.reduce((sum, value) => sum + value, 0), 10_000);
  const again = await runLiquidityExecution({
    position: pumped.position,
    observation: observe(130, 70_000),
    rules,
    now: 70_000,
    gate: gate(["reshape"]),
    io: pumpIo,
  });
  assert.equal(again.events.length, 0);
  assert.equal(pumpIo.calls.filter(call => call.op === "rebalanceLiquidity").length, 1);
});

test("compound bands claim fees and put each side back in its shape", async () => {
  const expectBand = [
    [5, "Curve", "BidAsk", false],
    [15, "Spot", "Spot", false],
    [30, "BidAsk", "Curve", false],
    [50, "BidAsk", "Curve", true],
  ];
  for (const [dist, tokenShape, solShape, fallback] of expectBand) {
    const io = ioFor(120);
    io.feeX = 800;
    io.feeY = 400;
    const seed = await seeded(io);
    const compounded = await runLiquidityExecution({
      position: seed.position,
      observation: observe(120, 0, 5, dist),
      rules,
      now: 0,
      gate: gate(["compound"]),
      io,
    });
    const event = compounded.events[0];
    assert.equal(event.executed, true, `${dist}%`);
    assert.equal(event.bandFallback, fallback);
    assert.equal(io.calls.some(call => call.op === "remove"), false);
    assert.equal(io.calls.filter(call => call.op === "claimFee").length, 1);
    const legs = adds(io);
    assert.equal(legs.length, 2);
    assert.equal(legs[0].strategyType, tokenShape);
    assert.equal(legs[0].minBinId, 120);
    assert.equal(legs[0].maxBinId, 220);
    assert.equal(legs[0].x, "800");
    assert.equal(legs[0].y, "0");
    assert.equal(legs[1].strategyType, solShape);
    assert.equal(legs[1].minBinId, 80);
    assert.equal(legs[1].maxBinId, 119);
    assert.equal(legs[1].x, "0");
    assert.equal(legs[1].y, "400");
  }
  const poor = ioFor(120);
  poor.feeX = 800;
  const poorSeed = await seeded(poor);
  const skipped = await runLiquidityExecution({
    position: poorSeed.position,
    observation: observe(120, 0, 4.99, 15),
    rules,
    now: 0,
    gate: gate(["compound"]),
    io: poor,
  });
  assert.equal(skipped.events.length, 0);
  assert.equal(poor.calls.length, 0);
});

test("a curve compound profit-takes after 4 bins and does not reshape twice", async () => {
  const io = ioFor(120);
  io.feeX = 500;
  io.feeY = 500;
  const seed = await seeded(io);
  const compounded = await runLiquidityExecution({
    position: seed.position,
    observation: observe(120, 0, 5, 5),
    rules,
    now: 0,
    gate: gate(["compound", "profit-take", "reshape"]),
    io,
  });
  assert.equal(compounded.events[0].tokenShape, "curve");
  const removesBefore = removes(io).length;
  io.inventoryActive = 123;
  const three = await runLiquidityExecution({
    position: compounded.position,
    observation: observe(123, 61_000, 0, 5),
    rules,
    now: 61_000,
    gate: gate(["compound", "profit-take", "reshape"]),
    io,
  });
  assert.equal(three.events.length, 0);
  io.inventoryActive = 124;
  const early = await runLiquidityExecution({
    position: compounded.position,
    observation: observe(124, 10_000, 0, 5),
    rules,
    now: 10_000,
    gate: gate(["profit-take", "reshape"]),
    io,
  });
  assert.equal(early.events.length, 0);
  const taken = await runLiquidityExecution({
    position: compounded.position,
    observation: observe(124, 61_000, 0, 5),
    rules,
    now: 61_000,
    gate: gate(["profit-take", "reshape"]),
    io,
  });
  assert.equal(taken.events.length, 1);
  assert.equal(taken.events[0].kind, "profit-take");
  assert.equal(taken.events[0].executed, true);
  assert.equal(taken.events[0].binsMoved, 4);
  const profit = removes(io).at(-1);
  assert.equal(profit.fromBinId, 120);
  assert.equal(profit.toBinId, 123);
  assert.equal(adds(io).at(-1).strategyType, "BidAsk");
  assert.equal(removes(io).length, removesBefore + 1);

  const wide = ioFor(120);
  wide.feeX = 500;
  wide.feeY = 500;
  const wideSeed = await seeded(wide);
  const wideCompound = await runLiquidityExecution({
    position: wideSeed.position,
    observation: observe(120, 0, 5, 5),
    rules,
    now: 0,
    gate: gate(["compound"]),
    io: wide,
  });
  wide.inventoryActive = 141;
  wide.liveBin = 141;
  const once = await runLiquidityExecution({
    position: wideCompound.position,
    observation: observe(141, 61_000, 0, 5),
    rules,
    now: 61_000,
    gate: gate(["profit-take", "reshape"]),
    io: wide,
  });
  assert.equal(once.events.length, 1);
  assert.equal(once.events[0].kind, "profit-take");
  assert.equal(once.events[0].binsMoved, 21);
  assert.equal(removes(wide).length, 1);
  assert.equal(removes(wide)[0].fromBinId, 120);
  assert.equal(removes(wide)[0].toBinId, 140);

  const mid = ioFor(120);
  mid.feeX = 500;
  mid.feeY = 500;
  const midSeed = await seeded(mid);
  const midCompound = await runLiquidityExecution({
    position: midSeed.position,
    observation: observe(120, 0, 5, 15),
    rules,
    now: 0,
    gate: gate(["compound"]),
    io: mid,
  });
  mid.inventoryActive = 124;
  const noTake = await runLiquidityExecution({
    position: midCompound.position,
    observation: observe(124, 61_000, 0, 15),
    rules,
    now: 61_000,
    gate: gate(["profit-take", "reshape"]),
    io: mid,
  });
  assert.equal(noTake.events.length, 0);
  assert.equal(removes(mid).length, 0);
});

test("drift, simulation failure, and a lost add are recovered without a second remove", async () => {
  const drift = ioFor(114);
  drift.liveBin = 120;
  const driftSeed = await seeded(drift);
  const alerts = [];
  const drifted = await runLiquidityExecution({
    position: driftSeed.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: drift,
    alert: (message) => alerts.push(message),
  });
  assert.equal(drifted.events[0].aborted, "active-bin drift");
  assert.equal(drifted.events[0].executed, false);
  assert.equal(drifted.position.liquidity.anchorBin, 120);
  assert.equal(removes(drift).length, 0);
  assert.equal(drift.sends, 0);

  const rejected = ioFor(114);
  rejected.simulateErr = { InstructionError: [0, "Custom"] };
  const rejectedSeed = await seeded(rejected);
  const aborted = await runLiquidityExecution({
    position: rejectedSeed.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: rejected,
    alert: () => {},
  });
  assert.equal(aborted.events[0].executed, false);
  assert.match(aborted.events[0].aborted, /simulation failed/);
  assert.equal(rejected.calls.filter(call => call.op === "rebalanceLiquidity").length, 1);
  assert.equal(rejected.sends, 0);
  assert.equal(aborted.position.liquidity.recovery, undefined);

  const partial = ioFor(114);
  partial.failAddBack = true;
  const partialSeed = await seeded(partial);
  const broken = await runLiquidityExecution({
    position: partialSeed.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: partial,
    alert: (message) => alerts.push(message),
  });
  assert.equal(broken.events[0].partial, true);
  assert.equal(broken.events[0].phase, "removed");
  assert.equal(broken.position.liquidity.recovery.phase, "removed");
  assert.equal(partial.calls.filter(call => call.op === "rebalanceLiquidity").length, 1);
  partial.failAddBack = false;
  const repaired = await runLiquidityExecution({
    position: broken.position,
    observation: observe(114, 130_000),
    rules,
    now: 130_000,
    gate: gate(["reshape"]),
    io: partial,
  });
  assert.equal(repaired.recovered, true);
  assert.equal(repaired.events[0].executed, true);
  assert.equal(partial.calls.filter(call => call.op === "rebalanceLiquidity").length, 1);
  assert.equal(partial.batches.at(-1).jitoTipLamports, 10_000);
  assert.equal(partial.batches.at(-1).cuPriceMicroLamports, 1_000);
  assert.equal(repaired.position.liquidity.recovery, null);
  assert.ok(alerts.some(message => message.includes("add did not confirm")));

  const retry = ioFor(114);
  retry.failSends = 2;
  const retrySeed = await seeded(retry);
  const retried = await runLiquidityExecution({
    position: retrySeed.position,
    observation: observe(114, 61_000),
    rules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: retry,
  });
  assert.equal(retried.events[0].executed, true);
  assert.ok(retry.sends >= 3);
});

test("hybrid weights, 45-bin chunks, and both in-range modes", async () => {
  const { splitHalf, liquidityDistribution, WEIGHT_BPS } = await import("../strategy/hybrid-weights.js");
  const { simulateLiquidity } = await import("../strategy/liquidity-management.js");
  const [first, second] = splitHalf(new BN(1001));
  assert.equal(first.toString(), "500");
  assert.equal(second.toString(), "501");
  assert.equal(first.add(second).toString(), "1001");
  const bins = [];
  for (let bin = 10; bin <= 14; bin++) bins.push(bin);
  const spot = liquidityDistribution(bins, 12, "spot");
  const bid = liquidityDistribution(bins, 12, "bidask");
  assert.equal(spot.reduce((sum, row) => sum + row.distributionX, 0), WEIGHT_BPS);
  assert.equal(bid.reduce((sum, row) => sum + row.distributionY, 0), WEIGHT_BPS);
  const spotX = spot.filter(row => row.binId >= 12).map(row => row.distributionX);
  assert.equal(Math.max(...spotX) - Math.min(...spotX) <= 1, true);
  const below = bid.filter(row => row.binId <= 12);
  assert.ok(below[0].distributionY > below.at(-1).distributionY);

  const wideRules = {
    ...rules,
    reshapeLiquidity: { ...rules.reshapeLiquidity, maxTxBytes: 20_000 },
  };
  const wide = ioFor(30);
  const seededWide = await runLiquidityExecution({
    position: { id: "wide", lowerBin: 0, upperBin: 89, openedAt: 0 },
    observation: { ...observe(40, 0), activeBin: 40, lowerBin: 0, upperBin: 89 },
    rules: wideRules,
    now: 0,
    gate: gate(["reshape"]),
    io: wide,
  });
  wide.inventoryActive = 34;
  wide.liveBin = 34;
  const chunked = await runLiquidityExecution({
    position: seededWide.position,
    observation: { ...observe(34, 61_000), activeBin: 34, lowerBin: 0, upperBin: 89 },
    rules: wideRules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: wide,
  });
  const chunks = wide.calls.filter(call => call.op === "addLiquidity2");
  assert.equal(chunked.events[0].executed, true);
  assert.ok(chunks.some(row => row.bins.length === 45));
  assert.ok(chunks.every(row => row.bins.length <= 45));
  assert.equal(wide.batches.length, 1);
  assert.equal(wide.batches[0].names[0], "rebalanceLiquidity");

  const fullRules = {
    ...rules,
    reshapeLiquidity: { ...rules.reshapeLiquidity, inRangeMode: "both_sides_full", maxTxBytes: 20_000 },
  };
  const fullIo = ioFor(114);
  const fullSeed = simulateLiquidity(
    { id: "full", lowerBin: 100, upperBin: 140, openedAt: 0 },
    { ...observe(120, 0), lowerBin: 100, upperBin: 140 },
    fullRules,
    0,
  );
  const full = await runLiquidityExecution({
    position: fullSeed.position,
    observation: { ...observe(114, 61_000), lowerBin: 100, upperBin: 140 },
    rules: fullRules,
    now: 61_000,
    gate: gate(["reshape"]),
    io: fullIo,
  });
  const removed = fullIo.calls.find(call => call.op === "rebalanceLiquidity");
  assert.equal(full.events[0].inRangeMode, "both_sides_full");
  assert.equal(full.events[0].reshapedSide, "both");
  assert.deepEqual(full.events[0].legs, ["spot", "bidask"]);
  assert.equal(removed.fromBinId, 100);
  assert.equal(removed.toBinId, 140);
  assert.equal(full.events[0].shrinkMode, 3);
});
