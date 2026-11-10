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
    compoundedTokenFeesUsd: 0,
    compoundedSolFeesUsd: 0,
    pendingCurveCompound: null,
    compounds: 0,
    reshapes: 0,
    profitTakes: 0,
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

const DEFAULT_BANDS = [
  { maxDistPct: 10, tokenShape: "curve", solShape: "bidask" },
  { maxDistPct: 25, tokenShape: "spot", solShape: "spot" },
  { maxDistPct: 40, tokenShape: "bidask", solShape: "curve" },
];

function bandList(compound) {
  const rows = Array.isArray(compound?.bands) && compound.bands.length ? compound.bands : DEFAULT_BANDS;
  return rows
    .map(row => ({
      maxDistPct: finite(row?.maxDistPct),
      tokenShape: row?.tokenShape || "spot",
      solShape: row?.solShape || "spot",
    }))
    .filter(row => row.maxDistPct != null)
    .sort((a, b) => a.maxDistPct - b.maxDistPct);
}

function selectBand(dist, compound) {
  const bands = bandList(compound);
  const configured = compound?.fallbackBand && typeof compound.fallbackBand === "object" ? compound.fallbackBand : null;
  const last = bands[bands.length - 1];
  const fallback = {
    maxDistPct: finite(configured?.maxDistPct),
    tokenShape: configured?.tokenShape || last?.tokenShape || "bidask",
    solShape: configured?.solShape || last?.solShape || "curve",
  };
  const match = dist != null ? bands.find(row => dist <= row.maxDistPct) : null;
  return match ? { band: match, bandFallback: false, bands } : { band: fallback, bandFallback: true, bands };
}

function binQuote(bin, binStep) {
  const step = finite(binStep);
  if (bin == null || !(step > 0)) return null;
  return (1 + step / 10_000) ** bin;
}

function distanceBelowTop(observation, active, upperBin) {
  let upper = finite(observation?.upperPrice ?? observation?.upperQuotePrice);
  let price = finite(observation?.price ?? observation?.quotePrice);
  if (!(upper > 0) || price == null) {
    upper = binQuote(upperBin, observation?.binStep);
    price = binQuote(active, observation?.binStep);
  }
  if (!(upper > 0) || price == null) return null;
  return ((upper - price) / upper) * 100;
}

function freshSideFees(observation, state) {
  const token = finite(observation?.tokenFeesUsd);
  const sol = finite(observation?.solFeesUsd);
  const reported = finite(observation?.unclaimedFeesUsd);
  const tokenFresh = token == null ? null : Math.max(0, token - (state.compoundedTokenFeesUsd || 0));
  const solFresh = sol == null ? null : Math.max(0, sol - (state.compoundedSolFeesUsd || 0));
  const fresh = tokenFresh != null || solFresh != null
    ? (tokenFresh ?? 0) + (solFresh ?? 0)
    : (reported == null ? null : Math.max(0, reported - (state.compoundedFeesUsd || 0)));
  return { tokenFresh, solFresh, fresh };
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
  const waited = state.lastReshapeAt == null || now - state.lastReshapeAt >= intervalMs;
  let reshapedThisTick = false;

  const profit = compound.curveProfitTake || {};
  const profitBins = clampInt(profit.binsUp, 1, 200, 4);
  const pending = state.pendingCurveCompound;
  const risen = pending && active != null ? active - pending.activeBin : null;
  if (profit.enabled !== false && pending && risen >= profitBins && waited && state.bins?.length && active != null) {
    const profitShape = profit.solShape || pending.solShape || "bidask";
    const beforeBins = state.bins.map(row => ({ ...row }));
    const rebuilt = reshapeBins(beforeBins, active, { reshapedSide: "sol", keptSide: "token" }, profitShape, risen);
    const factor = rebuilt.reshapedShare;
    events.push(event("profit-take", position, observation, now, {
      reason: "curve profit-take",
      profitTake: true,
      binsMoved: risen,
      direction: "up",
      reshapedSide: "sol",
      keptSide: "token",
      solShape: profitShape,
      tokenShape: pending.tokenShape,
      band: pending.band,
      bandFallback: false,
      distFromTopPct: pending.distFromTopPct,
      activeBin: active,
      compoundActiveBin: pending.activeBin,
      estimatedCostSol: cost.sol * factor,
      estimatedCostUsd: cost.usd == null ? null : cost.usd * factor,
    }));
    state.bins = rebuilt.bins;
    state.shape = profitShape;
    state.anchorBin = active;
    state.lastReshapeAt = now;
    state.pendingCurveCompound = null;
    state.reshapes += 1;
    state.profitTakes += 1;
    state.estimatedCostSol += cost.sol * factor;
    if (cost.usd != null) state.estimatedCostUsd += cost.usd * factor;
    reshapedThisTick = true;
  }

  if (!reshapedThisTick && reshape.enabled !== false && active != null && state.anchorBin != null && lower != null && upper != null) {
    const buffered = inFlipBuffer(active, lower, upper, buffer);
    const entered = buffered && !state.inBuffer;
    const pumpAllowed = clampInt(reshape.pumpAllowedBinMovement, 1, 200, 20);
    const pumpWindow = clampInt(reshape.pumpReshapeBins, 1, 200, 20);
    const delta = active - state.anchorBin;
    const direction = delta < 0 || (buffered && active <= lower + buffer) ? "down" : "up";
    const moved = reshape.mode === "both_sides"
      ? Math.abs(delta) > allowed
      : (direction === "down" ? -delta > allowed : delta > pumpAllowed);
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
      const binsMoved = direction === "up" ? Math.min(pumpWindow, Math.max(0, delta)) : Math.max(0, -delta);
      events.push(event("reshape", position, observation, now, {
        reason: entered ? "flip buffer" : "bin movement",
        profitTake: false,
        binsMoved,
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
      state.pendingCurveCompound = null;
      state.reshapes += 1;
      state.estimatedCostSol += cost.sol * factor;
      if (cost.usd != null) state.estimatedCostUsd += cost.usd * factor;
      if (uplift != null) state.estimatedExtraFeesUsd += uplift;
    }
    state.inBuffer = buffered;
  }

  const { tokenFresh, solFresh, fresh } = freshSideFees(observation, state);
  const multiple = Number(compound.requireFeesExceedCostX ?? 0);
  const minFees = Number(compound.minFeesUsd ?? 5);
  const costGate = Number.isFinite(multiple) && multiple > 0;
  const costlyEnough = !costGate || (cost.usd != null && fresh != null && fresh >= multiple * cost.usd);
  const dist = distanceBelowTop(observation, active, upper);
  const basis = compound.bandBasis || "pct_below_top";
  if (compound.enabled !== false && basis === "pct_below_top" && fresh != null && fresh >= minFees && costlyEnough && dist != null && active != null) {
    const selected = selectBand(dist, compound);
    const { band, bandFallback } = selected;
    let bins = state.bins ? state.bins.map(row => ({ ...row })) : [];
    if (tokenFresh > 0) bins = reshapeBins(bins, active, { reshapedSide: "token", keptSide: "sol" }, band.tokenShape, null).bins;
    if (solFresh > 0) bins = reshapeBins(bins, active, { reshapedSide: "sol", keptSide: "token" }, band.solShape, null).bins;
    const top = selected.bands[0];
    const curveBand = !bandFallback && tokenFresh > 0 && band.tokenShape === "curve" && top && band.maxDistPct === top.maxDistPct;
    events.push(event("compound", position, observation, now, {
      bandBasis: basis,
      distFromTopPct: dist,
      band: { maxDistPct: band.maxDistPct, tokenShape: band.tokenShape, solShape: band.solShape },
      bandFallback,
      tokenShape: band.tokenShape,
      solShape: band.solShape,
      tokenFeesUsd: tokenFresh,
      solFeesUsd: solFresh,
      feesUsd: fresh,
      profitTake: false,
      binsMoved: null,
      activeBin: active,
      estimatedCostSol: cost.sol,
      estimatedCostUsd: cost.usd,
      requireFeesExceedCostX: costGate ? multiple : 0,
    }));
    state.bins = bins;
    state.shape = band.tokenShape;
    if (tokenFresh != null) state.compoundedTokenFeesUsd += tokenFresh;
    if (solFresh != null) state.compoundedSolFeesUsd += solFresh;
    state.compoundedFeesUsd += fresh;
    state.compounds += 1;
    state.estimatedCostSol += cost.sol;
    if (cost.usd != null) state.estimatedCostUsd += cost.usd;
    state.pendingCurveCompound = curveBand && profit.enabled !== false ? {
      activeBin: active,
      at: now,
      distFromTopPct: dist,
      tokenShape: band.tokenShape,
      solShape: band.solShape,
      band: { maxDistPct: band.maxDistPct, tokenShape: band.tokenShape, solShape: band.solShape },
    } : null;
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
    profitTakes: state.profitTakes || 0,
    estimatedCostSol: state.estimatedCostSol || 0,
    estimatedCostUsd: state.estimatedCostUsd || 0,
    estimatedExtraFeesUsd: state.estimatedExtraFeesUsd || 0,
  };
}
