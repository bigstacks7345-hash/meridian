// Explicit Spot and Bid-Ask weights for a 50/50 hybrid.
// X (token) is placed at and above the active bin. Y (SOL) is placed below it.
// Each side's weights sum to 10,000 bps. The second leg receives any odd remainder.

import BN from "bn.js";

export const WEIGHT_BPS = 10_000;
export const SHRINK_NO_SHRINK_BOTH = 3;
export const REMOVE_ALL_BPS = 10_000;
export const DEFAULT_CHUNK_BINS = 45;

export function asBn(value) {
  if (BN.isBN(value)) return value;
  if (value == null) return new BN(0);
  return new BN(value.toString());
}

export function splitHalf(amount) {
  const value = asBn(amount);
  const first = value.divn(2);
  return [first, value.sub(first)];
}

export function binRange(fromBin, toBin) {
  const bins = [];
  for (let bin = fromBin; bin <= toBin; bin++) bins.push(bin);
  return bins;
}

function largestRemainder(rawWeights) {
  if (!rawWeights.length) return [];
  const total = rawWeights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return rawWeights.map(() => 0);
  const exact = rawWeights.map(value => (value / total) * WEIGHT_BPS);
  const floors = exact.map(value => Math.floor(value));
  let left = WEIGHT_BPS - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const out = floors.slice();
  for (let i = 0; i < left; i++) out[order[i % order.length].index] += 1;
  return out;
}

export function spotWeights(binIds) {
  return largestRemainder(binIds.map(() => 1));
}

export function bidAskWeights(binIds, activeBin) {
  return largestRemainder(binIds.map(bin => 1 + Math.abs(bin - activeBin)));
}

export function liquidityDistribution(binIds, activeBin, shape) {
  const xBins = binIds.filter(bin => bin >= activeBin);
  const yBins = binIds.filter(bin => bin <= activeBin);
  const xWeights = shape === "bidask" ? bidAskWeights(xBins, activeBin) : spotWeights(xBins);
  const yWeights = shape === "bidask" ? bidAskWeights(yBins, activeBin) : spotWeights(yBins);
  const xMap = new Map(xBins.map((bin, index) => [bin, xWeights[index] || 0]));
  const yMap = new Map(yBins.map((bin, index) => [bin, yWeights[index] || 0]));
  return binIds.map(bin => ({
    binId: bin,
    distributionX: xMap.get(bin) || 0,
    distributionY: yMap.get(bin) || 0,
  }));
}

function shareOf(amount, weights, start, end) {
  const value = asBn(amount);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const part = weights.slice(start, end).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || value.isZero()) return new BN(0);
  return value.muln(part).divn(total);
}

function renormalize(rows) {
  const x = largestRemainder(rows.map(row => row.distributionX));
  const y = largestRemainder(rows.map(row => row.distributionY));
  return rows.map((row, index) => ({
    binId: row.binId,
    distributionX: x[index],
    distributionY: y[index],
  }));
}

export function chunkDistribution(rows, amountX, amountY, chunkBins, leg) {
  const size = Math.max(1, chunkBins || DEFAULT_CHUNK_BINS);
  const slices = [];
  for (let index = 0; index < rows.length; index += size) slices.push(rows.slice(index, index + size));
  const xWeights = rows.map(row => row.distributionX);
  const yWeights = rows.map(row => row.distributionY);
  let usedX = new BN(0);
  let usedY = new BN(0);
  const totalX = asBn(amountX);
  const totalY = asBn(amountY);
  return slices.map((slice, index) => {
    const start = index * size;
    const last = index === slices.length - 1;
    const x = last ? totalX.sub(usedX) : shareOf(totalX, xWeights, start, start + slice.length);
    const y = last ? totalY.sub(usedY) : shareOf(totalY, yWeights, start, start + slice.length);
    usedX = usedX.add(x);
    usedY = usedY.add(y);
    return {
      leg,
      amountX: x,
      amountY: y,
      binLiquidityDist: renormalize(slice),
      binCount: slice.length,
    };
  }).filter(chunk => !chunk.amountX.isZero() || !chunk.amountY.isZero());
}

export function hybridBinShares(lower, upper, active) {
  const bins = binRange(lower, upper);
  if (!bins.length || active == null) return [];
  const spot = liquidityDistribution(bins, active, "spot");
  const bid = liquidityDistribution(bins, active, "bidask");
  const raw = bins.map((_, index) => 0.5 * (spot[index].distributionX + spot[index].distributionY) + 0.5 * (bid[index].distributionX + bid[index].distributionY));
  const sum = raw.reduce((total, value) => total + value, 0);
  return bins.map((bin, index) => ({ bin, share: sum > 0 ? raw[index] / sum : 0 }));
}
