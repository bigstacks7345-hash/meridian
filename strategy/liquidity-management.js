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
    bins: null,
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

function fullDistribution(shape, lower, upper, center) {
  if (lower == null || upper == null || upper < lower) return [];
  const clamped = Math.min(upper, Math.max(lower, center));
  return weights(shape, lower, upper, clamped);
}

function sumShares(rows) {
  return rows.reduce((total, row) => total + row.share, 0);
}

function nearShareOf(bins, active, radius) {
  if (!bins?.length || active == null) return null;
  return bins.filter(row => Math.abs(row.bin - active) <= radius).reduce((total, row) => total + row.share, 0);
}

function sidePlan(reshape, direction) {
  if (reshape.mode === "both_sides") return { reshapedSide: "both", keptSide: null };
  const action = direction === "down"
    ? (reshape.onDump || "reshape_token_side_keep_sol")
    : (reshape.onPump || "reshape_sol_side_keep_token");
  if (action === "reshape_sol_side_keep_token") return { reshapedSide: "sol", keptSide: "token" };
  return { reshapedSide: "token", keptSide: "sol" };
}

function reshapeBins(bins, active, plan, shape, windowBins) {
  if (plan.reshapedSide === "both") {
    const lower = bins[0].bin;
    const upper = bins[bins.length - 1].bin;
    return { bins: fullDistribution(shape, lower, upper, active), reshapedShare: 1 };
  }
  const tokenSide = plan.reshapedSide === "token";
  const moving = tokenSide
    ? bins.filter(row => row.bin >= active)
    : bins.filter(row => row.bin < active && (windowBins == null || row.bin >= active - windowBins));
  const kept = tokenSide
    ? bins.filter(row => row.bin < active)
    : bins.filter(row => row.bin >= active || (windowBins != null && row.bin < active - windowBins));
  const mass = sumShares(moving);
  if (!moving.length || mass <= 0) return { bins, reshapedShare: 0 };
  const center = tokenSide ? moving[0].bin : moving[moving.length - 1].bin;
  const fresh = fullDistribution(shape, moving[0].bin, moving[moving.length - 1].bin, center)
    .map(row => ({ bin: row.bin, share: row.share * mass }));
  const next = [...kept, ...fresh].sort((a, b) => a.bin - b.bin);
  return { bins: next, reshapedShare: mass };
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
  if (state.anchorBin == null && active != null && lower != null && upper != null) {
    state.anchorBin = active;
    state.lastReshapeAt = position?.openedAt ?? now;
    state.shape = rules?.reshapeLiquidity?.startShape || "curve";
    state.bins = fullDistribution(state.shape, lower, upper, active);
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
    const pumpAllowed = clampInt(reshape.pumpAllowedBinMovement, 1, 200, 20);
    const pumpWindow = clampInt(reshape.pumpReshapeBins, 1, 200, 20);
    const delta = active - state.anchorBin;
    const direction = delta < 0 || (buffered && active <= lower + buffer) ? "down" : "up";
    const moved = reshape.mode === "both_sides"
      ? Math.abs(delta) > allowed
      : (direction === "down" ? -delta > allowed : delta > pumpAllowed);
    const waited = state.lastReshapeAt == null || now - state.lastReshapeAt >= intervalMs;
    const desired = reshape.mode === "both_sides"
      ? (buffered ? (reshape.alternateShape || "spot_bidask_5050") : (reshape.startShape || "curve"))
      : (reshape.oneSideShape || "spot_bidask_5050");
    if ((entered || moved) && waited && state.bins?.length) {
      const plan = sidePlan(reshape, direction);
      const beforeBins = state.bins.map(row => ({ ...row }));
      const rebuilt = reshapeBins(beforeBins, active, plan, desired, direction === "up" ? pumpWindow : null);
      const before = nearShareOf(beforeBins, active, allowed);
      const after = nearShareOf(rebuilt.bins, active, allowed);
      const baselineBins = fullDistribution(reshape.startShape || "curve", lower, upper, state.entryBin ?? state.anchorBin);
      const baseline = nearShareOf(baselineBins, active, allowed);
      const uplift = before != null && after != null && fees != null ? Math.max(0, after - (baseline ?? before)) * fees : null;
      const factor = plan.reshapedSide === "both" ? 1 : rebuilt.reshapedShare;
      events.push(event("reshape", position, observation, now, {
        reason: entered ? "flip buffer" : "bin movement",
        direction,
        mode: reshape.mode || "one_side",
        reshapedSide: plan.reshapedSide,
        keptSide: plan.keptSide,
        allowedBinMovement: allowed,
        pumpAllowedBinMovement: pumpAllowed,
        pumpReshapeBins: pumpWindow,
        activeBin: active,
        feesUsd: fees,
        estimatedCostSol: cost.sol * factor,
        estimatedCostUsd: cost.usd == null ? null : cost.usd * factor,
        shapeBefore: state.shape,
        shapeAfter: desired,
        nearShareBefore: before,
        nearShareAfter: after,
        estimatedFeeUpliftUsd: uplift,
      }));
      state.shape = desired;
      state.bins = rebuilt.bins;
      state.anchorBin = active;
      state.lastReshapeAt = now;
      state.reshapes += 1;
      state.estimatedCostSol += cost.sol * factor;
      if (cost.usd != null) state.estimatedCostUsd += cost.usd * factor;
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
    const before = nearShareOf(state.bins, active, allowed);
    const afterBins = state.lowerBin != null && state.upperBin != null
      ? fullDistribution(shapeAfter, state.lowerBin, state.upperBin, active ?? state.anchorBin)
      : state.bins;
    const after = nearShareOf(afterBins, active, allowed);
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
