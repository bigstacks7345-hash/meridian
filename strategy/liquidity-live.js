// Live compound and reshape. The shadow simulator decides; this module only
// builds and sends when every gate is open. A closed gate returns the
// simulation unchanged and does not touch a pool.

import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { simulateLiquidity } from "./liquidity-management.js";
import {
  DEFAULT_CHUNK_BINS,
  REMOVE_ALL_BPS,
  SHRINK_NO_SHRINK_BOTH,
  binRange,
  chunkDistribution,
  liquidityDistribution,
  splitHalf,
} from "./hybrid-weights.js";

const COMPUTE_UNIT_LIMIT = 1_400_000;
const DEFAULT_CU_PRICE = 500;
const DEFAULT_ADD_BACK_CU_PRICE = 1_000;
const DEFAULT_ADD_BACK_TIP = 10_000;
const DEFAULT_CU_MARGIN = 0.15;
const DEFAULT_MAX_TX_BYTES = 1_232;
const DEFAULT_TIP_ACCOUNT = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const DEFAULT_SLIPPAGE_PCT = 1;
const DEFAULT_DRIFT_BINS = 2;
const DEFAULT_PRIORITY_FEE_SOL = 0.00002;

export function liquidityLiveGate({ shadowMode, dryRunBlocksSubmit, walletKeyPresent, execute } = {}) {
  const blocks = [];
  if (shadowMode !== false) blocks.push("shadowMode");
  if (dryRunBlocksSubmit !== false) blocks.push("dryRun");
  if (walletKeyPresent !== true) blocks.push("walletKey");
  if (execute !== true) blocks.push("execute");
  return { allowed: blocks.length === 0, blocks };
}

function bn(value) {
  if (BN.isBN(value)) return value;
  if (value == null) return new BN(0);
  return new BN(value.toString());
}

function sumAmounts(bins, field) {
  return bins.reduce((total, row) => total.add(bn(row?.[field])), new BN(0));
}

function shapeKey(shape) {
  if (shape === "bid_ask" || shape === "bidask") return "BidAsk";
  if (shape === "curve") return "Curve";
  if (shape === "spot") return "Spot";
  return null;
}

function strategyOf(strategyTypes, shape) {
  const key = shapeKey(shape);
  const value = key ? strategyTypes?.[key] : undefined;
  if (value == null) throw new Error(`unsupported liquidity shape ${shape}`);
  return value;
}

function clampWindow(fromBin, toBin, lower, upper) {
  const from = Math.max(lower, fromBin);
  const to = Math.min(upper, toBin);
  if (to < from) return null;
  return { fromBinId: from, toBinId: to };
}

export function planLiquidityAction(event, observation = {}) {
  const active = Number(event.activeBin);
  const lower = Number(observation.lowerBin);
  const upper = Number(observation.upperBin);
  if (!Number.isInteger(active) || !Number.isInteger(lower) || !Number.isInteger(upper)) return null;
  if (event.kind === "compound") {
    return {
      kind: "compound",
      activeBin: active,
      claim: true,
      adds: [
        event.tokenShape ? { side: "token", shape: event.tokenShape, ...clampWindow(active, upper, lower, upper) } : null,
        event.solShape ? { side: "sol", shape: event.solShape, ...clampWindow(lower, active - 1, lower, upper) } : null,
      ].filter(row => row?.fromBinId != null),
    };
  }
  if (event.kind === "profit-take") {
    const from = Number.isInteger(event.compoundActiveBin) ? event.compoundActiveBin : active - Number(event.binsMoved || 0);
    const window = clampWindow(from, active - 1, lower, upper);
    if (!window) return null;
    return { kind: "profit-take", activeBin: active, shape: event.solShape || "bidask", ...window };
  }
  if (event.kind !== "reshape") return null;
  if (event.reshapedSide === "both") {
    return { kind: "reshape", activeBin: active, shape: event.shapeAfter || "curve", fromBinId: lower, toBinId: upper };
  }
  if (event.reshapedSide === "token") {
    const window = clampWindow(active, upper, lower, upper);
    if (!window) return null;
    return { kind: "reshape", activeBin: active, shape: event.shapeAfter || "spot_bidask_5050", side: "token", ...window };
  }
  const width = Number(event.binsMoved ?? event.pumpReshapeBins ?? 20);
  const window = clampWindow(active - width, active - 1, lower, upper);
  if (!window) return null;
  return { kind: "reshape", activeBin: active, shape: event.shapeAfter || "spot_bidask_5050", side: "sol", ...window };
}

function binsIn(positionData, fromBinId, toBinId) {
  const rows = positionData?.positionBinData || positionData?.positionData?.positionBinData || [];
  return rows.filter(row => Number(row.binId) >= fromBinId && Number(row.binId) <= toBinId);
}

function feeAmounts(positionData) {
  const data = positionData?.positionData || positionData || {};
  return { x: bn(data.feeX), y: bn(data.feeY) };
}

function sideAmounts(positionData, plan) {
  const rows = binsIn(positionData, plan.fromBinId, plan.toBinId);
  return {
    x: sumAmounts(rows, "positionXAmount"),
    y: sumAmounts(rows, "positionYAmount"),
  };
}

function addLegs(plan, amounts, strategyTypes) {
  const x = bn(amounts.x);
  const y = bn(amounts.y);
  if (x.isZero() && y.isZero()) return [];
  const hybrid = plan.shape === "spot_bidask_5050";
  if (!hybrid) {
    return [{
      shape: plan.shape,
      strategyType: strategyOf(strategyTypes, plan.shape),
      minBinId: plan.fromBinId,
      maxBinId: plan.toBinId,
      totalXAmount: x,
      totalYAmount: y,
    }];
  }
  const halfX = x.divn(2);
  const halfY = y.divn(2);
  return [
    { shape: "spot", strategyType: strategyOf(strategyTypes, "spot"), minBinId: plan.fromBinId, maxBinId: plan.toBinId, totalXAmount: halfX, totalYAmount: halfY },
    { shape: "bidask", strategyType: strategyOf(strategyTypes, "bidask"), minBinId: plan.fromBinId, maxBinId: plan.toBinId, totalXAmount: x.sub(halfX), totalYAmount: y.sub(halfY) },
  ];
}

function priorityMicroLamports(rules) {
  const sol = Number(rules?.autoCompound?.priorityFeeSol ?? rules?.reshapeLiquidity?.priorityFeeSol ?? DEFAULT_PRIORITY_FEE_SOL);
  const lamports = Number.isFinite(sol) && sol > 0 ? Math.round(sol * 1e9) : 0;
  return Math.max(0, Math.round((lamports * 1e6) / COMPUTE_UNIT_LIMIT));
}

function withBudget(tx, microLamports) {
  const next = new Transaction();
  next.feePayer = tx?.feePayer;
  next.recentBlockhash = tx?.recentBlockhash;
  next.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...(tx?.instructions || []),
  );
  return next;
}

async function sendPrepared(tx, io, rules) {
  const prepared = withBudget(tx, priorityMicroLamports(rules));
  const simulated = await io.connection.simulateTransaction(prepared, io.signers || []);
  const value = simulated?.value ?? simulated;
  if (value?.err) {
    const error = new Error("transaction simulation failed");
    error.abort = true;
    error.detail = value.err;
    throw error;
  }
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const signature = await io.send(prepared);
      io.signatures.push(signature);
      return signature;
    } catch (error) {
      last = error;
      if (attempt === 3) throw error;
    }
  }
  throw last;
}

async function sendMany(txs, io, rules) {
  const list = (Array.isArray(txs) ? txs : [txs]).filter(Boolean);
  const signatures = [];
  for (const tx of list) signatures.push(await sendPrepared(tx, io, rules));
  return signatures;
}

function slippageOf(rules) {
  const value = Number(rules?.reshapeLiquidity?.slippagePct ?? rules?.autoCompound?.slippagePct ?? DEFAULT_SLIPPAGE_PCT);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLIPPAGE_PCT;
}

function driftLimit(rules) {
  const value = Number(rules?.reshapeLiquidity?.maxActiveBinDrift ?? rules?.autoCompound?.maxActiveBinDrift ?? DEFAULT_DRIFT_BINS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DRIFT_BINS;
}

async function readActiveBin(io) {
  const active = await io.pool.getActiveBin();
  const binId = Number(active?.binId);
  if (!Number.isInteger(binId)) throw new Error("active bin unavailable");
  return binId;
}

function sameWindow(plan, adds) {
  return adds.every(add => add.minBinId === plan.fromBinId && add.maxBinId === plan.toBinId);
}

async function submitAdds(adds, io, rules, positionId) {
  const signatures = [];
  const steps = [];
  for (const add of adds) {
    if (add.totalXAmount.isZero() && add.totalYAmount.isZero()) continue;
    const width = add.maxBinId - add.minBinId + 1;
    const chunkable = width > 69 && typeof io.pool.addLiquidityByStrategyChunkable === "function";
    const method = chunkable ? "addLiquidityByStrategyChunkable" : "addLiquidityByStrategy";
    if (width > 69 && !chunkable) {
      const error = new Error(`range ${width} bins needs addLiquidityByStrategyChunkable`);
      error.abort = true;
      throw error;
    }
    await io.assertBinArrays?.(add.minBinId, add.maxBinId);
    const txs = await io.pool[method]({
      positionPubKey: positionId,
      user: io.owner,
      totalXAmount: add.totalXAmount,
      totalYAmount: add.totalYAmount,
      strategy: { minBinId: add.minBinId, maxBinId: add.maxBinId, strategyType: add.strategyType },
      slippage: slippageOf(rules),
    });
    signatures.push(...await sendMany(txs, io, rules));
    steps.push(method);
  }
  return { signatures, steps };
}

function liveEvent(event, extra) {
  return { ...event, simulated: false, executionDisabled: false, ...extra };
}

function remembered(position, liquidity) {
  return { ...position, liquidity: { ...(position.liquidity || {}), ...liquidity } };
}

export async function runLiquidityExecution({ position, observation, rules, now, gate, io, record, alert }) {
  const savedRecovery = position?.liquidity?.recovery;
  if (savedRecovery) {
    if (!gate?.(savedRecovery.kind)?.allowed) {
      alert?.(`liquidity recovery is waiting for ${savedRecovery.kind} on ${position?.id}`);
      return { position, events: [], recovered: false };
    }
    return recover(position, rules, io, record, alert);
  }
  const simulated = simulateLiquidity(position, observation, rules, now || Date.now());
  const wanted = simulated.events.filter(event => gate?.(event.kind)?.allowed);
  if (!wanted.length || !io) return simulated;
  let current = simulated.position;
  const events = [];
  for (const event of simulated.events) {
    if (!gate?.(event.kind)?.allowed) {
      events.push(event);
      continue;
    }
    const outcome = await perform(event, position, simulated.position, observation, rules, io, record, alert);
    if (outcome.recovery) {
      current = remembered(position, { ...(position.liquidity || {}), recovery: outcome.recovery });
      events.push(outcome.event);
      break;
    }
    if (outcome.advanced === false) {
      current = position;
      events.push(outcome.event);
      break;
    }
    events.push(outcome.event);
    current = remembered(simulated.position, { recovery: null });
  }
  return { position: current, events, executed: events.some(event => event.executed === true) };
}

async function perform(event, position, intended, observation, rules, io, record, alert) {
  const plan = planLiquidityAction(event, observation);
  if (!plan) {
    const skipped = liveEvent(event, { executed: false, aborted: "unplanned" });
    record?.(skipped);
    return { event: skipped, advanced: false };
  }
  const liveBin = await readActiveBin(io);
  if (Math.abs(liveBin - plan.activeBin) > driftLimit(rules)) {
    const aborted = liveEvent(event, { executed: false, aborted: "active-bin drift", liveBin, signatures: [] });
    record?.(aborted);
    return { event: aborted, advanced: false };
  }
  io.signatures = [];
  const onchain = await io.pool.getPosition(position.id);
  try {
    if (plan.claim) return await compound(event, plan, onchain, position, intended, rules, io, record);
    return await reshape(event, plan, onchain, position, intended, rules, io, record, alert);
  } catch (error) {
    if (error.recovery) return { event: error.event, recovery: error.recovery, advanced: false };
    const aborted = liveEvent(event, { executed: false, aborted: error.message, signatures: [...(io.signatures || [])] });
    record?.(aborted);
    alert?.(`liquidity ${event.kind} aborted on ${position?.id}: ${error.message}`);
    return { event: aborted, advanced: false };
  }
}

async function compound(event, plan, onchain, position, intended, rules, io, record) {
  const fees = feeAmounts(onchain);
  const claim = io.pool.claimSwapFee || io.pool.claimFee;
  if (!claim) throw new Error("pool has no claimFee method");
  const claimTxs = await claim.call(io.pool, { owner: io.owner, position: onchain });
  const signatures = [...await sendMany(claimTxs, io, rules)];
  const steps = ["claimFee"];
  const legs = [];
  for (const add of plan.adds) {
    const amounts = add.side === "token" ? { x: fees.x, y: new BN(0) } : { x: new BN(0), y: fees.y };
    legs.push(...addLegs({ ...add, shape: add.shape }, amounts, io.strategyTypes));
  }
  const recovery = {
    kind: "compound",
    phase: "claimed",
    positionId: position.id,
    adds: legs.map(serializeAdd),
    snapshot: positionSnapshot(intended),
  };
  await io.persist?.(remembered(position, { recovery }));
  try {
    const added = await submitAdds(legs, io, rules, position.id);
    signatures.push(...added.signatures);
    steps.push(...added.steps);
  } catch (error) {
    const partial = liveEvent(event, { executed: false, partial: true, phase: "claimed", signatures, steps });
    record?.(partial);
    error.recovery = recovery;
    error.event = partial;
    throw error;
  }
  const done = liveEvent(event, { executed: true, signatures, steps, profitTake: false, binsMoved: null });
  record?.(done);
  return { event: done, advanced: true };
}

function isPublicKey(value) {
  return value instanceof PublicKey;
}

function payerKey(io) {
  if (isPublicKey(io.owner)) return io.owner;
  try { return new PublicKey(io.owner); } catch { return SystemProgram.programId; }
}

function tipAccount(rules) {
  const configured = rules?.reshapeLiquidity?.jitoTipAccount || DEFAULT_TIP_ACCOUNT;
  return new PublicKey(configured);
}

function estimateBytes(descriptors) {
  let bytes = 180;
  for (const item of descriptors) bytes += 64 + (item.binCount || 0) * 8;
  return bytes;
}

function asInstruction(descriptor) {
  return new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [],
    data: Buffer.from(descriptor.name || "ix"),
  });
}

function budgeted(descriptors, { cuPrice, cuLimit, tipLamports, payer, tipTo }) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
  if (tipLamports > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipTo, lamports: tipLamports }));
  }
  for (const item of descriptors) tx.add(asInstruction(item));
  return tx;
}

async function sendPacked(descriptors, options, io) {
  const margin = Number.isFinite(options.margin) ? options.margin : DEFAULT_CU_MARGIN;
  const probe = budgeted(descriptors, { ...options, cuLimit: COMPUTE_UNIT_LIMIT, tipLamports: 0 });
  const simulated = await io.connection.simulateTransaction(probe, io.signers || []);
  const value = simulated?.value ?? simulated;
  if (value?.err) {
    const error = new Error("transaction simulation failed");
    error.abort = true;
    error.detail = value.err;
    throw error;
  }
  const consumed = Number(value?.unitsConsumed);
  const cuLimit = Number.isFinite(consumed) && consumed > 0
    ? Math.min(COMPUTE_UNIT_LIMIT, Math.max(1, Math.ceil(consumed * (1 + margin))))
    : COMPUTE_UNIT_LIMIT;
  const tx = budgeted(descriptors, { ...options, cuLimit });
  io.batches = io.batches || [];
  io.batches.push({
    names: descriptors.map(item => item.name),
    legs: descriptors.map(item => item.leg || null),
    cuPriceMicroLamports: options.cuPrice,
    cuLimit,
    jitoTipLamports: options.tipLamports || 0,
  });
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const signature = await io.send(tx);
      io.signatures.push(signature);
      return signature;
    } catch (error) {
      last = error;
      if (attempt === 3 || error.abort) throw error;
    }
  }
  throw last;
}

async function executeHybrid(event, plan, amounts, position, intended, rules, io, record, alert) {
  const bins = binRange(plan.fromBinId, plan.toBinId);
  const [spotX, bidX] = splitHalf(amounts.x);
  const [spotY, bidY] = splitHalf(amounts.y);
  const chunkBins = Number(rules?.reshapeLiquidity?.chunkBins) || DEFAULT_CHUNK_BINS;
  const spotChunks = chunkDistribution(liquidityDistribution(bins, plan.activeBin, "spot"), spotX, spotY, chunkBins, "spot");
  const bidChunks = chunkDistribution(liquidityDistribution(bins, plan.activeBin, "bidask"), bidX, bidY, chunkBins, "bidask");
  const remove = await io.pool.rebalanceLiquidity({
    position: position.id,
    user: io.owner,
    fromBinId: plan.fromBinId,
    toBinId: plan.toBinId,
    bps: REMOVE_ALL_BPS,
    adds: [],
    shrinkMode: SHRINK_NO_SHRINK_BOTH,
    shouldClaimFee: false,
    maxActiveBinSlippage: Number(rules?.reshapeLiquidity?.maxActiveBinSlippage ?? 32767),
  });
  const removeIx = { ...(remove || {}), name: "rebalanceLiquidity", binCount: 0, leg: null };
  const addIxs = [];
  for (const chunk of [...spotChunks, ...bidChunks]) {
    const built = await io.pool.addLiquidity2({
      position: position.id,
      user: io.owner,
      leg: chunk.leg,
      amountX: chunk.amountX,
      amountY: chunk.amountY,
      binLiquidityDist: chunk.binLiquidityDist,
    });
    addIxs.push({
      ...(built || {}),
      name: "addLiquidity2",
      leg: chunk.leg,
      binCount: chunk.binCount,
      amountX: chunk.amountX,
      amountY: chunk.amountY,
      binLiquidityDist: chunk.binLiquidityDist,
    });
  }
  const reshapeRules = rules?.reshapeLiquidity || {};
  const onePrice = Number(reshapeRules.cuPriceMicroLamports ?? DEFAULT_CU_PRICE);
  const addPrice = Number(reshapeRules.addBackCuPriceMicroLamports ?? DEFAULT_ADD_BACK_CU_PRICE);
  const tip = Number(reshapeRules.addBackJitoTipLamports ?? DEFAULT_ADD_BACK_TIP);
  const maxBytes = Number(reshapeRules.maxTxBytes ?? DEFAULT_MAX_TX_BYTES);
  const margin = Number(reshapeRules.cuLimitMargin ?? DEFAULT_CU_MARGIN);
  const payer = payerKey(io);
  const tipTo = tipAccount(rules);
  const packed = [removeIx, ...addIxs];
  const options = { payer, tipTo, margin };
  if (estimateBytes(packed) <= maxBytes) {
    const signature = await sendPacked(packed, { ...options, cuPrice: onePrice, tipLamports: 0 }, io);
    const done = liveEvent(event, {
      executed: true,
      signatures: [signature],
      steps: packed.map(item => item.name),
      legs: ["spot", "bidask"],
      inRangeMode: plan.side === "both" || event.inRangeMode === "both_sides_full" ? "both_sides_full" : "one_side",
      removeBps: REMOVE_ALL_BPS,
      shrinkMode: SHRINK_NO_SHRINK_BOTH,
      profitTake: false,
    });
    record?.(done);
    return { event: done, advanced: true };
  }
  const removedSig = await sendPacked([removeIx], { ...options, cuPrice: onePrice, tipLamports: 0 }, io);
  const recovery = {
    kind: event.kind,
    phase: "removed",
    positionId: position.id,
    fromBinId: plan.fromBinId,
    toBinId: plan.toBinId,
    adds: addIxs.map(item => ({
      leg: item.leg,
      amountX: item.amountX.toString(),
      amountY: item.amountY.toString(),
      binLiquidityDist: item.binLiquidityDist,
      binCount: item.binCount,
    })),
    snapshot: positionSnapshot(intended),
    hybrid: true,
  };
  await io.persist?.(remembered(position, { recovery }));
  try {
    const addedSig = await sendPacked(addIxs, { ...options, cuPrice: addPrice, tipLamports: tip }, io);
    const done = liveEvent(event, {
      executed: true,
      signatures: [removedSig, addedSig],
      steps: ["rebalanceLiquidity", "addLiquidity2"],
      split: true,
      legs: ["spot", "bidask"],
      removeBps: REMOVE_ALL_BPS,
      shrinkMode: SHRINK_NO_SHRINK_BOTH,
    });
    record?.(done);
    return { event: done, advanced: true };
  } catch (error) {
    const partial = liveEvent(event, {
      executed: false,
      partial: true,
      phase: "removed",
      split: true,
      signatures: [removedSig],
      steps: ["rebalanceLiquidity"],
    });
    record?.(partial);
    alert?.(`liquidity ${event.kind} removed bins ${plan.fromBinId}-${plan.toBinId} on ${position?.id} but the add did not confirm`);
    error.recovery = recovery;
    error.event = partial;
    throw error;
  }
}

async function reshape(event, plan, onchain, position, intended, rules, io, record, alert) {
  const amounts = sideAmounts(onchain, plan);
  if (amounts.x.isZero() && amounts.y.isZero()) {
    const skipped = liveEvent(event, { executed: false, aborted: "empty side", signatures: [] });
    record?.(skipped);
    alert?.(`liquidity ${event.kind} found no liquidity in ${plan.fromBinId}-${plan.toBinId} on ${position?.id}`);
    return { event: skipped, advanced: false };
  }
  if (plan.shape === "spot_bidask_5050") {
    return executeHybrid(event, plan, amounts, position, intended, rules, io, record, alert);
  }
  const legs = addLegs(plan, amounts, io.strategyTypes);
  if (!sameWindow(plan, legs)) throw new Error("add window left the removed range");
  await io.assertBinArrays?.(plan.fromBinId, plan.toBinId);
  const removed = await io.pool.removeLiquidity({
    user: io.owner,
    position: position.id,
    fromBinId: plan.fromBinId,
    toBinId: plan.toBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: false,
  });
  const signatures = [...await sendMany(removed, io, rules)];
  const recovery = {
    kind: event.kind,
    phase: "removed",
    positionId: position.id,
    fromBinId: plan.fromBinId,
    toBinId: plan.toBinId,
    adds: legs.map(serializeAdd),
    snapshot: positionSnapshot(intended),
  };
  await io.persist?.(remembered(position, { recovery }));
  const steps = ["removeLiquidity"];
  try {
    const added = await submitAdds(legs, io, rules, position.id);
    signatures.push(...added.signatures);
    steps.push(...added.steps);
  } catch (error) {
    const partial = liveEvent(event, {
      executed: false,
      partial: true,
      phase: "removed",
      signatures,
      steps,
      profitTake: event.kind === "profit-take",
      binsMoved: event.binsMoved ?? (plan.toBinId - plan.fromBinId + 1),
    });
    record?.(partial);
    alert?.(`liquidity ${event.kind} removed bins ${plan.fromBinId}-${plan.toBinId} on ${position?.id} but the add did not confirm`);
    error.recovery = recovery;
    error.event = partial;
    throw error;
  }
  const done = liveEvent(event, {
    executed: true,
    signatures,
    steps,
    profitTake: event.kind === "profit-take",
    binsMoved: event.binsMoved ?? (plan.toBinId - plan.fromBinId + 1),
  });
  record?.(done);
  return { event: done, advanced: true };
}

function serializeAdd(add) {
  return {
    shape: add.shape,
    strategyType: add.strategyType,
    minBinId: add.minBinId,
    maxBinId: add.maxBinId,
    totalXAmount: add.totalXAmount.toString(),
    totalYAmount: add.totalYAmount.toString(),
  };
}

function hydrateAdd(add) {
  return { ...add, totalXAmount: bn(add.totalXAmount), totalYAmount: bn(add.totalYAmount) };
}

function positionSnapshot(position) {
  const liquidity = { ...(position.liquidity || {}) };
  delete liquidity.recovery;
  return liquidity;
}

async function resendHybridAdds(recovery, rules, io, positionId) {
  const addIxs = [];
  for (const add of recovery.adds || []) {
    const built = await io.pool.addLiquidity2({
      position: positionId,
      user: io.owner,
      leg: add.leg,
      amountX: bn(add.amountX),
      amountY: bn(add.amountY),
      binLiquidityDist: add.binLiquidityDist,
    });
    addIxs.push({ ...(built || {}), name: "addLiquidity2", leg: add.leg, binCount: add.binCount || add.binLiquidityDist?.length || 0 });
  }
  const reshapeRules = rules?.reshapeLiquidity || {};
  const signature = await sendPacked(addIxs, {
    cuPrice: Number(reshapeRules.addBackCuPriceMicroLamports ?? DEFAULT_ADD_BACK_CU_PRICE),
    tipLamports: Number(reshapeRules.addBackJitoTipLamports ?? DEFAULT_ADD_BACK_TIP),
    margin: Number(reshapeRules.cuLimitMargin ?? DEFAULT_CU_MARGIN),
    payer: payerKey(io),
    tipTo: tipAccount(rules),
  }, io);
  return { signatures: [signature], steps: addIxs.map(item => item.name) };
}

async function recover(position, rules, io, record, alert) {
  const recovery = position.liquidity.recovery;
  io.signatures = [];
  try {
    const added = recovery.hybrid
      ? await resendHybridAdds(recovery, rules, io, position.id)
      : await submitAdds((recovery.adds || []).map(hydrateAdd), io, rules, position.id);
    const done = {
      type: "liquidity-sim",
      kind: recovery.kind,
      simulated: false,
      executed: true,
      executionDisabled: false,
      recovered: true,
      phase: recovery.phase,
      signatures: added.signatures,
      steps: added.steps,
      positionId: position.id,
    };
    record?.(done);
    const liquidity = { ...(recovery.snapshot || {}), recovery: null };
    return { position: { ...position, liquidity }, events: [done], executed: true, recovered: true };
  } catch (error) {
    alert?.(`liquidity recovery still failing for ${position?.id}: ${error.message}`);
    const failed = {
      type: "liquidity-sim",
      kind: recovery.kind,
      simulated: false,
      executed: false,
      partial: true,
      phase: recovery.phase,
      aborted: error.message,
      positionId: position.id,
    };
    record?.(failed);
    return { position, events: [failed], executed: false, recovered: false };
  }
}

export function observationFromPortfolio(portfolio, now = Date.now()) {
  return {
    at: now,
    activeBin: portfolio?.active_bin ?? null,
    lowerBin: portfolio?.lower_bin ?? null,
    upperBin: portfolio?.upper_bin ?? null,
    unclaimedFeesUsd: portfolio?.unclaimed_fees_usd ?? null,
    tokenFeesUsd: portfolio?.unclaimed_fee_token_usd ?? null,
    solFeesUsd: portfolio?.unclaimed_fee_sol_usd ?? null,
    price: portfolio?.quote_price ?? null,
    upperPrice: portfolio?.upper_price ?? null,
    binStep: portfolio?.bin_step ?? null,
    solPriceUsd: portfolio?.sol_price_usd ?? null,
  };
}

export async function maintainLivePosition(portfolio, deps) {
  const gate = deps.gate || (() => ({ allowed: false }));
  if (!["compound", "profit-take", "reshape"].some(kind => gate(kind)?.allowed)) return { handled: false, claimed: false };
  const saved = deps.load?.(portfolio.position) || {};
  const now = deps.now ?? Date.now();
  const position = {
    id: portfolio.position,
    lowerBin: portfolio.lower_bin,
    upperBin: portfolio.upper_bin,
    openedAt: saved.openedAt ?? now,
    liquidity: saved.liquidity,
  };
  const io = await deps.createIo(portfolio);
  const result = await runLiquidityExecution({
    position,
    observation: observationFromPortfolio(portfolio, now),
    rules: deps.rules,
    now,
    gate,
    io,
    record: deps.record,
    alert: deps.alert,
  });
  await deps.save?.({ openedAt: position.openedAt, liquidity: result.position?.liquidity || null });
  return {
    handled: true,
    claimed: result.events?.some(event => event.kind === "compound" && event.executed === true) === true,
  };
}
