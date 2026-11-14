import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  priceToBinOffset,
  buildVolumeProfileDistribution,
  alignCandlesToPool,
  parseGeckoOhlcv,
} from "../tools/volume-profile.js";

const require = createRequire(import.meta.url);
const { toWeightDistribution } = require("@meteora-ag/dlmm");
const BN = require("bn.js");

const BIN_STEP = 100;
const ACTIVE_BIN = -1200;
const ACTIVE_PRICE = 0.0006848; // matches the Affair Inu screenshot

// Two humps like the screenshot: heavy volume around 0.00078 (above) and 0.00040 (below).
function twoHumpCandles() {
  const candles = [];
  let ts = 1_700_000_000;
  for (let i = 0; i < 60; i++) candles.push({ ts: ts++, high: 0.00042, low: 0.00038, close: 0.0004, volume: 5000 });
  for (let i = 0; i < 20; i++) candles.push({ ts: ts++, high: 0.00056, low: 0.00046, close: 0.0005, volume: 800 });
  for (let i = 0; i < 60; i++) candles.push({ ts: ts++, high: 0.0008, low: 0.00076, close: 0.00078, volume: 6000 });
  candles.push({ ts: ts++, high: 0.0007, low: 0.00068, close: ACTIVE_PRICE, volume: 1000 });
  return candles;
}

test("offset math matches the bin step", () => {
  assert.equal(Math.round(priceToBinOffset(ACTIVE_PRICE * 1.01, ACTIVE_PRICE, 100)), 1);
  assert.equal(Math.round(priceToBinOffset(ACTIVE_PRICE * 1.01 ** -20, ACTIVE_PRICE, 100)), -20);
});

test("single-sided SOL shape puts the most SOL on the lower volume hump", () => {
  const { distribution, preview } = buildVolumeProfileDistribution(twoHumpCandles(), {
    activeBinId: ACTIVE_BIN,
    activePrice: ACTIVE_PRICE,
    binStep: BIN_STEP,
    minBinId: ACTIVE_BIN - 69,
    maxBinId: ACTIVE_BIN,
  });

  assert.equal(distribution.length, 70);
  const total = distribution.reduce((s, d) => s + d.yAmountBpsOfTotal.toNumber(), 0);
  assert.equal(total, 10_000);
  assert.ok(distribution.every((d) => d.xAmountBpsOfTotal.isZero() && d.yAmountBpsOfTotal.toNumber() >= 1));

  const peak = distribution.reduce((a, b) => (b.yAmountBpsOfTotal.gt(a.yAmountBpsOfTotal) ? b : a));
  const peakPrice = ACTIVE_PRICE * 1.01 ** (peak.binId - ACTIVE_BIN);
  assert.ok(peakPrice > 0.00037 && peakPrice < 0.00043, `peak at ${peakPrice}`);
  assert.ok(preview.bars.includes("█"));

  // The SDK must accept it: every bin keeps a non-zero on-chain weight.
  const weights = toWeightDistribution(new BN(0), new BN(1_000_000_000), distribution, BIN_STEP);
  assert.equal(weights.length, 70);
});

test("inverted candle quotes are flipped, garbage prices are refused", () => {
  const inverted = twoHumpCandles().map((c) => ({ ...c, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close }));
  const aligned = alignCandlesToPool(inverted, ACTIVE_PRICE, 25);
  assert.ok(Math.abs(aligned.at(-1).close / ACTIVE_PRICE - 1) < 1e-9);
  assert.throws(() => alignCandlesToPool([{ high: 5, low: 4, close: 4.5, volume: 1 }], ACTIVE_PRICE, 25));
});

test("refuses when recent volume never traded inside the range", () => {
  const above = [{ ts: 1, high: 0.0009, low: 0.00085, close: 0.00069, volume: 1000 }];
  assert.throws(() => buildVolumeProfileDistribution(above, {
    activeBinId: ACTIVE_BIN, activePrice: ACTIVE_PRICE, binStep: BIN_STEP,
    minBinId: ACTIVE_BIN - 69, maxBinId: ACTIVE_BIN,
  }), /inside the deploy range/);
});

test("parses GeckoTerminal OHLCV oldest-first", () => {
  const c = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[2, 1, 2, 0.5, 1.5, 10], [1, 1, 2, 0.5, 1, 5]] } } });
  assert.deepEqual(c.map((x) => x.ts), [1, 2]);
});

import { buildDoubleSidedVolumeProfile, pctToBins, pickValueArea } from "../tools/volume-profile.js";

test("double-sided: range caps at -38% / +30% and 70 bins", () => {
  assert.equal(pctToBins(38, 100, "below"), 48);
  assert.equal(pctToBins(30, 100, "above"), 26);
  const flat = pickValueArea(() => 1, { capBelow: 48, capAbove: 26, valueAreaPct: 100, maxBins: 70, minTotalBins: 35 });
  assert.equal(flat.hi - flat.lo + 1, 70);
  assert.ok(flat.lo >= -48 && flat.hi <= 26);
});

test("double-sided on the Affair Inu shape: SOL on the lower hump, token on the upper hump", () => {
  // The lower hump (~0.0004) is ~42% below price, so this test widens the downside cap to 45%.
  const plan = buildDoubleSidedVolumeProfile(twoHumpCandles(), {
    activeBinId: ACTIVE_BIN, activePrice: ACTIVE_PRICE, binStep: BIN_STEP, options: { maxBelowPct: 45 },
  });
  const ySum = plan.distribution.reduce((s, d) => s + d.yAmountBpsOfTotal.toNumber(), 0);
  const xSum = plan.distribution.reduce((s, d) => s + d.xAmountBpsOfTotal.toNumber(), 0);
  assert.equal(ySum, 10_000);
  assert.equal(xSum, 10_000);
  assert.ok(plan.distribution.length <= 70);
  for (const d of plan.distribution) {
    if (d.binId < ACTIVE_BIN) assert.ok(d.xAmountBpsOfTotal.isZero());
    if (d.binId > ACTIVE_BIN) assert.ok(d.yAmountBpsOfTotal.isZero());
  }
  const priceOf = (d) => ACTIVE_PRICE * 1.01 ** (d.binId - ACTIVE_BIN);
  const topY = plan.distribution.reduce((a, b) => (b.yAmountBpsOfTotal.gt(a.yAmountBpsOfTotal) ? b : a));
  const topX = plan.distribution.reduce((a, b) => (b.xAmountBpsOfTotal.gt(a.xAmountBpsOfTotal) ? b : a));
  assert.ok(priceOf(topY) > 0.00037 && priceOf(topY) < 0.00044, `SOL peak ${priceOf(topY)}`);
  assert.ok(priceOf(topX) > 0.00074 && priceOf(topX) < 0.00083, `token peak ${priceOf(topX)}`);
  assert.ok(plan.tokenShare > 0.2 && plan.tokenShare <= 0.5);
  assert.ok(plan.preview.range_pct.below <= 45 && plan.preview.range_pct.above <= 30);
  // SDK check with value-matched amounts (token amount worth the same SOL at the active bin price).
  const tokenRaw = new BN(Math.floor(1e9 / Math.pow(1.01, ACTIVE_BIN)).toString());
  assert.equal(toWeightDistribution(tokenRaw, new BN(1e9), plan.distribution, BIN_STEP).length, plan.distribution.length);
});

test("double-sided: default 38% cap leaves the lower hump out and caps the token swap at 50%", () => {
  const plan = buildDoubleSidedVolumeProfile(twoHumpCandles(), {
    activeBinId: ACTIVE_BIN, activePrice: ACTIVE_PRICE, binStep: BIN_STEP,
  });
  assert.ok(plan.preview.range_pct.below <= 38);
  assert.equal(plan.tokenShare, 0.5);
});

import { fitClusterCurves } from "../tools/volume-profile.js";

test("curves mode: each volume cluster becomes one smooth bell (a wave)", () => {
  const values = [0, 0, 5, 9, 9, 9, 5, 0, 0, 0, 0, 0, 4, 8, 8, 4, 0, 0];
  const { curve, clusters } = fitClusterCurves(values, { clusterThresholdPct: 30 });
  assert.equal(clusters.length, 2);
  const peakAt = (a, b) => { let m = a; for (let k = a; k <= b; k++) if (curve[k] > curve[m]) m = k; return m; };
  const p1 = peakAt(0, 9), p2 = peakAt(10, 17);
  for (let k = 1; k <= p1; k++) assert.ok(curve[k] >= curve[k - 1] - 1e-9, "rises into first peak");
  for (let k = p2 + 1; k < curve.length; k++) assert.ok(curve[k] <= curve[k - 1] + 1e-9, "falls after second peak");
  const valley = Math.min(...curve.slice(p1, p2 + 1));
  assert.ok(valley < curve[p1] * 0.2 && valley < curve[p2] * 0.2, "deep valley between the humps");
});
