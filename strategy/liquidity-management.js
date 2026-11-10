// Shadow simulation of HawkFi-style auto-compound and reshape.
// This module has no transaction builder and no submit path. `execute` is ignored.

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function blankState(rules) {
  return {
    shape: rules?.reshapeLiquidity?.startShape || "curve",
    anchorBin: null,
    entryBin: null,
    lowerBin: null,
    upperBin: null,
    lastReshapeAt: null,
    inBuffer: false,
    compoundedFeesUsd: 0,
    compounds: 0,
    reshapes: 0,
    estimatedCostSol: 0,
    estimatedCostUsd: 0,
    estimatedExtraFeesUsd: 0,
  };
}

function txCost(observation, rules) {
  const config = rules?.autoCompound || {};
  const base = finite(observation?.baseFeeSol ?? config.baseFeeSol) ?? 0.000005;
  const priority = finite(observation?.priorityFeeSol ?? config.priorityFeeSol) ?? 0;
  const rent = finite(observation?.rentSol ?? config.rentSol) ?? 0;
  const sol = base + priority + rent;
  const price = finite(observation?.solPriceUsd);
  return { sol, usd: price != null && price > 0 ? sol * price : null };
}

function weights(shape, lower, upper, center) {
  const bins = [];
  for (let bin = lower; bin <= upper; bin++) bins.push(bin);
  if (!bins.length) return [];
  const spot = bins.map(() => 1);
  const curve = bins.map(bin => 1 / (1 + Math.abs(bin - center)));
  const bidask = bins.map(bin => 1 + Math.abs(bin - center));
  const raw = shape === "curve" ? curve
    : shape === "bidask" ? bidask
    : shape === "spot_bidask_5050" ? spot.map((value, index) => 0.5 * value + 0.5 * bidask[index])
    : spot;
  const sum = raw.reduce((total, value) => total + value, 0);
  return bins.map((bin, index) => ({ bin, share: raw[index] / sum }));
}

function nearShare(shape, lower, upper, center, active, radius) {
  if (lower == null || upper == null || active == null || upper < lower) return null;
  const clamped = Math.min(upper, Math.max(lower, center));
  return weights(shape, lower, upper, clamped)
    .filter(row => Math.abs(row.bin - active) <= radius)
    .reduce((total, row) => total + row.share, 0);
}

function inFlipBuffer(active, lower, upper, buffer) {
  if (active == null || lower == null || upper == null) return false;
  return active <= lower + buffer || active >= upper - buffer;
}

export function simulateLiquidity(position, observation = {}, rules = {}, now = Date.now()) {
  const next = {
    ...position,
    liquidity: { ...blankState(rules), ...(position?.liquidity || {}) },
  };
  const state = next.liquidity;
  const events = [];
  const active = finite(observation.activeBin);
  const lower = finite(observation.lowerBin ?? state.lowerBin ?? position?.lowerBin);
  const upper = finite(observation.upperBin ?? state.upperBin ?? position?.upperBin);
  if (lower != null) state.lowerBin = lower;
  if (upper != null) state.upperBin = upper;
  if (state.entryBin == null && active != null) state.entryBin = active;
  if (state.anchorBin == null && active != null) {
    state.anchorBin = active;
    state.lastReshapeAt = position?.openedAt ?? now;
    state.shape = rules?.reshapeLiquidity?.startShape || "curve";
  }

  const reshape = rules.reshapeLiquidity || {};
  const compound = rules.autoCompound || {};
  const allowed = clampInt(reshape.allowedBinMovement, 1, 51, 5);
  const buffer = clampInt(reshape.flipBufferBins, 0, 51, 2);
  const intervalMs = Math.max(0, Number(reshape.minIntervalSec ?? 60)) * 1000;
  const cost = txCost(observation, rules);
  const fees = finite(observation.unclaimedFeesUsd);

  if (reshape.enabled !== false && active != null && state.anchorBin != null && lower != null && upper != null) {
    const buffered = inFlipBuffer(active, lower, upper, buffer);
    const entered = buffered && !state.inBuffer;
    const moved = Math.abs(active - state.anchorBin) > allowed;
    const waited = state.lastReshapeAt == null || now - state.lastReshapeAt >= intervalMs;
    const desired = buffered ? (reshape.alternateShape || "spot_bidask_5050") : (reshape.startShape || "curve");
    if ((entered || moved) && waited) {
      const before = nearShare(state.shape, lower, upper, state.anchorBin, active, allowed);
      const after = nearShare(desired, lower, upper, active, active, allowed);
      const baseline = nearShare(reshape.startShape || "curve", lower, upper, state.entryBin ?? state.anchorBin, active, allowed);
      const uplift = before != null && after != null && fees != null ? Math.max(0, after - (baseline ?? before)) * fees : null;
      events.push(event("reshape", position, observation, now, {
        reason: entered ? "flip buffer" : "bin movement",
        activeBin: active,
        feesUsd: fees,
        estimatedCostSol: cost.sol,
        estimatedCostUsd: cost.usd,
        shapeBefore: state.shape,
        shapeAfter: desired,
        nearShareBefore: before,
        nearShareAfter: after,
        estimatedFeeUpliftUsd: uplift,
      }));
      state.shape = desired;
      state.anchorBin = active;
      state.lastReshapeAt = now;
      state.reshapes += 1;
      state.estimatedCostSol += cost.sol;
      if (cost.usd != null) state.estimatedCostUsd += cost.usd;
      if (uplift != null) state.estimatedExtraFeesUsd += uplift;
    }
    state.inBuffer = buffered;
  }

  const freshFees = fees == null ? null : Math.max(0, fees - (state.compoundedFeesUsd || 0));
  const multiple = Number(compound.requireFeesExceedCostX ?? 3);
  const minFees = Number(compound.minFeesUsd ?? 5);
  const costlyEnough = cost.usd != null && freshFees != null && freshFees >= multiple * cost.usd;
  if (compound.enabled !== false && freshFees != null && freshFees >= minFees && costlyEnough) {
    const shapeAfter = compound.shape || "spot";
    const before = nearShare(state.shape, state.lowerBin, state.upperBin, state.anchorBin ?? active, active, allowed);
    const after = nearShare(shapeAfter, state.lowerBin, state.upperBin, active ?? state.anchorBin, active, allowed);
    events.push(event("compound", position, observation, now, {
      activeBin: active,
      feesUsd: freshFees,
      estimatedCostSol: cost.sol,
      estimatedCostUsd: cost.usd,
      shapeBefore: state.shape,
      shapeAfter,
      nearShareBefore: before,
      nearShareAfter: after,
      estimatedFeeUpliftUsd: before != null && after != null ? Math.max(0, after - before) * freshFees : null,
    }));
    state.shape = shapeAfter;
    state.compoundedFeesUsd += freshFees;
    state.compounds += 1;
    state.estimatedCostSol += cost.sol;
    if (cost.usd != null) state.estimatedCostUsd += cost.usd;
  }

  return { position: next, events, executed: false };
}

function event(kind, position, observation, now, fields) {
  return {
    type: "liquidity-sim",
    kind,
    simulated: true,
    executed: false,
    executionDisabled: true,
    positionId: position?.id ?? null,
    at: new Date(observation.at ?? now).toISOString(),
    ...fields,
  };
}

export function liquidityCloseSummary(position, now = Date.now()) {
  const state = position?.liquidity || {};
  return {
    type: "liquidity-summary",
    simulated: true,
    executed: false,
    positionId: position?.id ?? null,
    at: new Date(now).toISOString(),
    compounds: state.compounds || 0,
    reshapes: state.reshapes || 0,
    estimatedCostSol: state.estimatedCostSol || 0,
    estimatedCostUsd: state.estimatedCostUsd || 0,
    estimatedExtraFeesUsd: state.estimatedExtraFeesUsd || 0,
  };
}
