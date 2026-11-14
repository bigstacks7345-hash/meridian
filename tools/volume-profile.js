// ─── Volume-profile liquidity shape ─────────────────────────────
// Builds a per-bin SOL distribution that mirrors a volume profile:
// bins whose price traded the most volume get the most liquidity.
//
// Pure helpers (no network) are exported for tests. fetchCandles() is the
// only network call and is read-only (GeckoTerminal public OHLCV API).

import BN from "bn.js";

const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/solana/pools";

export const VOLUME_PROFILE_DEFAULTS = Object.freeze({
  timeframe: "minute",   // minute | hour | day (GeckoTerminal)
  aggregate: 1,          // candle size multiplier (minute: 1, 5, 15)
  lookbackCandles: 240,  // how many candles feed the profile (240 x 1m = 4h)
  smoothBins: 1,         // moving-average radius in bins (0 = raw bars)
  floorPct: 0.05,        // every bin gets at least this share of the tallest bar
  power: 1,              // >1 sharpens peaks, <1 flattens them
  halfLifeCandles: 0,    // >0 weights recent candles more (0 = all equal)
  minInRangeVolumePct: 10, // refuse if less than this % of profile volume lands in range
  maxPriceMismatchPct: 25, // last candle close vs pool active price sanity check
  shapeMode: "curves",     // "curves" = a bell per high-volume cluster, "bars" = follow the raw bars
  clusterThresholdPct: 30, // a cluster = bins with at least this % of the tallest bar
  minSigmaBins: 1.5,       // narrowest allowed curve (in bins)
});

/** Bin offset (relative to the active bin) for a price, using the pool's bin step. */
export function priceToBinOffset(price, activePrice, binStep) {
  return Math.log(price / activePrice) / Math.log(1 + binStep / 10_000);
}

/**
 * Turn OHLCV candles into volume per bin offset.
 * candles: [{ high, low, close, volume }] oldest → newest.
 * Each candle's volume is spread evenly across every bin between its low and high,
 * the same approximation charting volume profiles use for candle data.
 */
export function buildVolumeProfile(candles, { activePrice, binStep, minOffset, maxOffset, halfLifeCandles = 0 }) {
  const profile = new Map();
  let totalVolume = 0;
  let inRangeVolume = 0;
  const n = candles.length;

  candles.forEach((c, i) => {
    const vol = Number(c.volume);
    const hi = Number(c.high);
    const lo = Number(c.low);
    if (!(vol > 0) || !(hi > 0) || !(lo > 0)) return;
    const age = n - 1 - i;
    const decay = halfLifeCandles > 0 ? Math.pow(0.5, age / halfLifeCandles) : 1;
    const v = vol * decay;

    const a = Math.round(priceToBinOffset(Math.min(lo, hi), activePrice, binStep));
    const b = Math.round(priceToBinOffset(Math.max(lo, hi), activePrice, binStep));
    const span = b - a + 1;
    const perBin = v / span;
    totalVolume += v;
    for (let off = a; off <= b; off++) {
      if (off < minOffset || off > maxOffset) continue;
      profile.set(off, (profile.get(off) ?? 0) + perBin);
      inRangeVolume += perBin;
    }
  });

  return { profile, totalVolume, inRangeVolume };
}

/** Shape raw per-bin volume into final weights (smoothing, power, floor). */
/**
 * Fit one bell curve to each high-volume cluster (a run of bins at or above
 * clusterThresholdPct of the tallest bar). Each bell sits on the cluster's
 * volume-weighted center, is as wide as the cluster's spread, and holds the
 * cluster's volume, so a big cluster gets a big curve.
 */
export function fitClusterCurves(values, { clusterThresholdPct = 30, minSigmaBins = 1.5 } = {}) {
  const peak = Math.max(...values, 0);
  if (!(peak > 0)) return { curve: values.map(() => 0), clusters: [] };
  const cut = peak * (clusterThresholdPct / 100);
  const clusters = [];
  let i = 0;
  while (i < values.length) {
    if (values[i] < cut) { i++; continue; }
    let j = i;
    while (j + 1 < values.length && values[j + 1] >= cut) j++;
    let vol = 0, m = 0;
    for (let k = i; k <= j; k++) { vol += values[k]; m += k * values[k]; }
    const center = m / vol;
    let v = 0;
    for (let k = i; k <= j; k++) v += values[k] * (k - center) ** 2;
    const sigma = Math.max(minSigmaBins, Math.sqrt(v / vol));
    clusters.push({ start: i, end: j, center, sigma, volume: vol });
    i = j + 1;
  }
  const curve = values.map((_, k) => clusters.reduce((sum, c) =>
    sum + (c.volume / (c.sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((k - c.center) / c.sigma) ** 2), 0));
  return { curve, clusters };
}

export function shapeWeights(profile, {
  minOffset, maxOffset, smoothBins = 1, power = 1, floorPct = 0.05,
  shapeMode = "curves", clusterThresholdPct = 30, minSigmaBins = 1.5,
}) {
  const offsets = [];
  for (let off = minOffset; off <= maxOffset; off++) offsets.push(off);
  const raw = offsets.map((off) => profile.get(off) ?? 0);

  const smoothed = raw.map((_, i) => {
    if (smoothBins <= 0) return raw[i];
    let sum = 0;
    let count = 0;
    for (let j = i - smoothBins; j <= i + smoothBins; j++) {
      if (j < 0 || j >= raw.length) continue;
      sum += raw[j];
      count++;
    }
    return sum / count;
  });

  const shaped = shapeMode === "curves"
    ? fitClusterCurves(smoothed, { clusterThresholdPct, minSigmaBins }).curve
    : smoothed;
  const powered = shaped.map((v) => Math.pow(v, power));
  const peak = Math.max(...powered, 0);
  const floor = peak * Math.max(0, floorPct);
  const weights = powered.map((v) => Math.max(v, floor));
  return offsets.map((off, i) => ({ offset: off, weight: weights[i] }));
}

/** Convert weights to integer basis points that sum to exactly 10,000, each bin ≥ 1 bps. */
export function weightsToBps(weights) {
  const total = weights.reduce((s, w) => s + w.weight, 0);
  if (!(total > 0)) throw new Error("Volume profile is empty — no volume to shape from.");
  const budget = 10_000 - weights.length; // reserve 1 bps per bin
  if (budget < 0) throw new Error(`Too many bins (${weights.length}) for basis-point weights.`);
  const exact = weights.map((w) => (w.weight / total) * budget);
  const bps = exact.map((x) => Math.floor(x) + 1);
  let remainder = 10_000 - bps.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((p, q) => q.frac - p.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) bps[order[k].i] += 1;
  return weights.map((w, i) => ({ offset: w.offset, bps: bps[i] }));
}

/** Parse GeckoTerminal OHLCV payload → candles oldest → newest. */
export function parseGeckoOhlcv(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("OHLCV response missing ohlcv_list");
  return list
    .map(([ts, open, high, low, close, volume]) => ({ ts, open, high, low, close, volume }))
    .sort((a, b) => a.ts - b.ts);
}

export async function fetchCandles({ poolAddress, tokenXMint, timeframe, aggregate, limit }) {
  const url = `${GT_BASE}/${poolAddress}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=${Math.min(1000, limit)}&currency=token&token=${tokenXMint}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OHLCV API ${res.status}`);
  return parseGeckoOhlcv(await res.json());
}

/**
 * Align candle prices to the pool's SOL-per-token price. GeckoTerminal may quote the
 * pair the other way round, so try both orientations and keep the one that matches.
 */
export function alignCandlesToPool(candles, activePrice, maxMismatchPct) {
  const last = candles.at(-1);
  if (!last) throw new Error("No candles returned");
  const close = Number(last.close);
  const mismatch = (p) => Math.abs(p / activePrice - 1) * 100;
  if (mismatch(close) <= maxMismatchPct) return candles;
  if (close > 0 && mismatch(1 / close) <= maxMismatchPct) {
    return candles.map((c) => ({ ...c, high: 1 / Number(c.low), low: 1 / Number(c.high), close: 1 / Number(c.close) }));
  }
  throw new Error(
    `Candle price ${close} does not match pool price ${activePrice} (>${maxMismatchPct}% off) — refusing to shape from it.`,
  );
}

/**
 * Full pipeline used by deployPosition.
 * Returns the SDK xYAmountDistribution (single-sided SOL → all on Y) plus a readable preview.
 */
export function buildVolumeProfileDistribution(candles, {
  activeBinId,
  activePrice,
  binStep,
  minBinId,
  maxBinId,
  options = {},
}) {
  const o = { ...VOLUME_PROFILE_DEFAULTS, ...options };
  const aligned = alignCandlesToPool(candles, activePrice, o.maxPriceMismatchPct);
  const minOffset = minBinId - activeBinId;
  const maxOffset = maxBinId - activeBinId;

  const { profile, totalVolume, inRangeVolume } = buildVolumeProfile(aligned, {
    activePrice, binStep, minOffset, maxOffset, halfLifeCandles: o.halfLifeCandles,
  });
  const inRangePct = totalVolume > 0 ? (inRangeVolume / totalVolume) * 100 : 0;
  if (inRangePct < o.minInRangeVolumePct) {
    throw new Error(
      `Only ${inRangePct.toFixed(1)}% of recent volume traded inside the deploy range (need ${o.minInRangeVolumePct}%).`,
    );
  }

  const weights = shapeWeights(profile, { minOffset, maxOffset, ...o });
  const bps = weightsToBps(weights);

  const distribution = bps.map(({ offset, bps: b }) => ({
    binId: activeBinId + offset,
    xAmountBpsOfTotal: new BN(0),
    yAmountBpsOfTotal: new BN(b),
  }));

  return {
    distribution,
    preview: {
      candles: aligned.length,
      in_range_volume_pct: Number(inRangePct.toFixed(1)),
      bins: bps.length,
      bars: renderBars(bps),
    },
  };
}

// ─── Double-sided volume profile ────────────────────────────────
// SOL in the bins below price, the token in the bins above, both shaped by volume.
// The range is picked automatically: it grows out from the price toward the heavier
// side until it holds valueAreaPct of the volume, capped at maxBelowPct / maxAbovePct
// and at 70 bins (one position).

export const DOUBLE_SIDED_DEFAULTS = Object.freeze({
  maxBelowPct: 38,
  maxAbovePct: 30,
  valueAreaPct: 70,
  maxBins: 70,
  minTotalBins: 35,
  maxTokenSharePct: 50, // never swap more than this % of the SOL budget into the token
});

export function pctToBins(pct, binStep, side) {
  const r = Math.log(1 + binStep / 10_000);
  return side === "below"
    ? Math.floor(-Math.log(1 - pct / 100) / r)
    : Math.floor(Math.log(1 + pct / 100) / r);
}

/**
 * Pick the range [lo, hi] (always containing the price, offset 0) that holds valueAreaPct of the
 * volume in the fewest bins. If no window that fits in maxBins gets there, take the window that
 * holds the most volume. Checks every window, so separate clusters with a gap between them are found.
 */
export function pickValueArea(volumeAt, { capBelow, capAbove, valueAreaPct, maxBins, minTotalBins }) {
  const prefix = new Map();
  let run = 0;
  prefix.set(-capBelow - 1, 0);
  for (let o = -capBelow; o <= capAbove; o++) {
    run += volumeAt(o);
    prefix.set(o, run);
  }
  const total = run;
  const sum = (lo, hi) => prefix.get(hi) - prefix.get(lo - 1);
  const target = (valueAreaPct / 100) * total;
  const minWidth = Math.min(minTotalBins, maxBins, capBelow + capAbove + 1);

  let best = null;
  for (let lo = -capBelow; lo <= 0; lo++) {
    for (let hi = 0; hi <= capAbove; hi++) {
      const width = hi - lo + 1;
      if (width > maxBins || width < minWidth) continue;
      const covered = sum(lo, hi);
      const hits = covered >= target;
      const better = !best
        || (hits && !best.hits)
        || (hits && best.hits && (width < best.width || (width === best.width && covered > best.covered)))
        || (!hits && !best.hits && (covered > best.covered || (covered === best.covered && width < best.width)));
      if (better) best = { lo, hi, width, covered, hits };
    }
  }
  if (!best) return { lo: 0, hi: 0, covered: volumeAt(0), total };
  return { lo: best.lo, hi: best.hi, covered: best.covered, total };
}

export function buildDoubleSidedVolumeProfile(candles, {
  activeBinId,
  activePrice,
  binStep,
  options = {},
}) {
  const o = { ...VOLUME_PROFILE_DEFAULTS, ...DOUBLE_SIDED_DEFAULTS, ...options };
  const aligned = alignCandlesToPool(candles, activePrice, o.maxPriceMismatchPct);
  const capBelow = pctToBins(o.maxBelowPct, binStep, "below");
  const capAbove = pctToBins(o.maxAbovePct, binStep, "above");

  const { profile, totalVolume } = buildVolumeProfile(aligned, {
    activePrice, binStep, minOffset: -capBelow, maxOffset: capAbove, halfLifeCandles: o.halfLifeCandles,
  });
  const smoothed = new Map(
    shapeWeights(profile, { minOffset: -capBelow, maxOffset: capAbove, smoothBins: o.smoothBins, power: 1, floorPct: 0, shapeMode: "bars" })
      .map((w) => [w.offset, w.weight]),
  );
  const { lo, hi, covered, total } = pickValueArea((off) => smoothed.get(off) ?? 0, {
    capBelow, capAbove, valueAreaPct: o.valueAreaPct, maxBins: o.maxBins, minTotalBins: o.minTotalBins,
  });

  const inRangePct = totalVolume > 0 ? (covered / totalVolume) * 100 : 0;
  if (!(total > 0) || inRangePct < o.minInRangeVolumePct) {
    throw new Error(
      `Only ${inRangePct.toFixed(1)}% of recent volume traded inside the allowed range (need ${o.minInRangeVolumePct}%).`,
    );
  }
  if (hi <= 0) throw new Error("No volume above price — use the SOL-only volume_profile instead.");
  if (lo >= 0) throw new Error("No volume below price — nothing for the SOL side to do.");

  const weights = shapeWeights(profile, { minOffset: lo, maxOffset: hi, ...o });
  const below = weightsToBps(weights.filter((w) => w.offset <= 0));
  const above = weightsToBps(weights.filter((w) => w.offset >= 0));
  const yBps = new Map(below.map((b) => [b.offset, b.bps]));
  const xBps = new Map(above.map((b) => [b.offset, b.bps]));

  // Share of the SOL budget to swap into the token = volume weight above price (+ half the active bin).
  const sumW = weights.reduce((s, w) => s + w.weight, 0);
  const aboveW = weights.reduce((s, w) => s + (w.offset > 0 ? w.weight : w.offset === 0 ? w.weight / 2 : 0), 0);
  const tokenShare = Math.min(aboveW / sumW, Math.max(0, o.maxTokenSharePct) / 100);

  const distribution = weights.map((w) => ({
    binId: activeBinId + w.offset,
    xAmountBpsOfTotal: new BN(xBps.get(w.offset) ?? 0),
    yAmountBpsOfTotal: new BN(yBps.get(w.offset) ?? 0),
  }));

  const r = Math.log(1 + binStep / 10_000);
  const combined = weights.map((w) => ({ offset: w.offset, bps: Math.round((w.weight / sumW) * 10_000) }));
  return {
    distribution,
    binsBelow: -lo,
    binsAbove: hi,
    tokenShare,
    preview: {
      candles: aligned.length,
      in_range_volume_pct: Number(inRangePct.toFixed(1)),
      bins: weights.length,
      range_pct: {
        below: Number(((1 - Math.exp(lo * r)) * 100).toFixed(1)),
        above: Number(((Math.exp(hi * r) - 1) * 100).toFixed(1)),
      },
      token_share_pct: Number((tokenShare * 100).toFixed(1)),
      bars: renderBars(combined),
    },
  };
}

/** Tiny text histogram (top = highest price) for logs / Telegram / dry runs. */
export function renderBars(bps, width = 20) {
  const max = Math.max(...bps.map((b) => b.bps));
  return [...bps]
    .reverse()
    .map((b) => `${String(b.offset).padStart(4)} ${"█".repeat(Math.max(1, Math.round((b.bps / max) * width)))} ${(b.bps / 100).toFixed(2)}%`)
    .join("\n");
}
