// Candle math for the owner strategy. Candles are { t, o, h, l, c, v }, oldest first.
// v is USD notional. Missing or non-finite inputs return null so callers fail closed.

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function closesOf(candles) {
  if (!Array.isArray(candles)) return null;
  const closes = [];
  for (const candle of candles) {
    const close = finite(candle?.c);
    if (close == null) return null;
    closes.push(close);
  }
  return closes;
}

export function sma(values, length) {
  if (!Array.isArray(values) || !Number.isInteger(length) || length < 1 || values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i++) {
    const n = finite(values[i]);
    if (n == null) return null;
    sum += n;
  }
  return sum / length;
}

export function populationStdev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = sma(values, values.length);
  if (mean == null) return null;
  let square = 0;
  for (const value of values) {
    const n = finite(value);
    if (n == null) return null;
    square += (n - mean) ** 2;
  }
  return Math.sqrt(square / values.length);
}

// Wilder RSI. The seed average is the simple mean of the first `length` changes.
// Later points use avg = (prev * (length - 1) + current) / length.
export function wilderRsi(candles, length = 14) {
  const closes = closesOf(candles);
  if (!closes || !Number.isInteger(length) || length < 1 || closes.length < length + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / length;
  let avgLoss = loss / length;
  const series = [rsiFromAverages(avgGain, avgLoss)];
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (length - 1) + up) / length;
    avgLoss = (avgLoss * (length - 1) + down) / length;
    series.push(rsiFromAverages(avgGain, avgLoss));
  }
  return { value: series[series.length - 1], series };
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function rsiWithSma(candles, length = 14, smaLength = 14) {
  const rsi = wilderRsi(candles, length);
  if (!rsi) return null;
  return { value: rsi.value, sma: sma(rsi.series, smaLength), series: rsi.series };
}

export function volumeAboveSma(candles, length = 20) {
  if (!Array.isArray(candles) || candles.length < length) return null;
  const window = candles.slice(-length);
  const volumes = [];
  for (const candle of window) {
    const volume = finite(candle?.v);
    if (volume == null || volume < 0) return null;
    volumes.push(volume);
  }
  const average = sma(volumes, length);
  const current = volumes[volumes.length - 1];
  if (average == null) return null;
  return { current, average, above: current > average };
}

function trueRanges(candles) {
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = finite(candles[i].h);
    const low = finite(candles[i].l);
    const prev = finite(candles[i - 1].c);
    if (high == null || low == null || prev == null || high < low) return null;
    ranges.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  return ranges;
}

export function wilderAtr(candles, length = 10) {
  if (!Array.isArray(candles) || !Number.isInteger(length) || length < 1 || candles.length < length + 1) return null;
  const ranges = trueRanges(candles);
  if (!ranges || ranges.length < length) return null;
  const series = new Array(candles.length).fill(null);
  let atr = 0;
  for (let i = 0; i < length; i++) atr += ranges[i];
  atr /= length;
  series[length] = atr;
  for (let i = length; i < ranges.length; i++) {
    atr = (atr * (length - 1) + ranges[i]) / length;
    series[i + 1] = atr;
  }
  return series;
}

// Supertrend on completed candles. trend "up" is the green support line below price.
// The latest line is compared with a separate live price by the entry rule.
export function supertrend(candles, { atrLength = 10, factor = 3 } = {}) {
  if (!Array.isArray(candles) || !(factor > 0)) return null;
  for (const candle of candles) {
    if (finite(candle?.h) == null || finite(candle?.l) == null || finite(candle?.c) == null) return null;
    if (candle.h < candle.l) return null;
  }
  const atr = wilderAtr(candles, atrLength);
  if (!atr) return null;
  let finalLower = null;
  let finalUpper = null;
  let line = null;
  let trend = null;
  for (let i = atrLength; i < candles.length; i++) {
    if (atr[i] == null) return null;
    const mid = (candles[i].h + candles[i].l) / 2;
    const basicLower = mid - factor * atr[i];
    const basicUpper = mid + factor * atr[i];
    const prevClose = candles[i - 1].c;
    const prevLower = finalLower;
    const prevUpper = finalUpper;
    finalLower = prevLower == null || basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    finalUpper = prevUpper == null || basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
    if (line == null) {
      trend = candles[i].c >= finalUpper ? "down" : "up";
      line = trend === "up" ? finalLower : finalUpper;
      continue;
    }
    const prevLine = line;
    if (prevLine === prevUpper && candles[i].c <= finalUpper) {
      line = finalUpper;
      trend = "down";
    } else if (prevLine === prevUpper && candles[i].c > finalUpper) {
      line = finalLower;
      trend = "up";
    } else if (prevLine === prevLower && candles[i].c >= finalLower) {
      line = finalLower;
      trend = "up";
    } else if (prevLine === prevLower && candles[i].c < finalLower) {
      line = finalUpper;
      trend = "down";
    } else {
      line = trend === "up" ? finalLower : finalUpper;
    }
  }
  if (line == null || (trend !== "up" && trend !== "down")) return null;
  return { value: line, trend, support: trend === "up" ? line : null };
}

// Bollinger Bands, SMA basis, population standard deviation, offset 0 = no shift.
// Display only. A short history returns null and must not become an entry failure.
export function bollinger(candles, { length = 20, mult = 2, offset = 0 } = {}) {
  if (offset !== 0) return null;
  const closes = closesOf(candles);
  if (!closes || closes.length < length) return null;
  const window = closes.slice(-length);
  const basis = sma(window, length);
  const deviation = populationStdev(window);
  if (basis == null || deviation == null) return null;
  return { basis, upper: basis + mult * deviation, lower: basis - mult * deviation, offset };
}

export function continuousSeries(candles, intervalMs, count) {
  if (!Array.isArray(candles) || candles.length !== count || !(intervalMs > 0)) {
    return { ok: false, reason: "1m history incomplete" };
  }
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const candle = sorted[i];
    if (!Number.isFinite(candle?.t)) return { ok: false, reason: "1m history incomplete" };
    if (i > 0 && candle.t - sorted[i - 1].t !== intervalMs) return { ok: false, reason: "1m history has a gap" };
    if (i > 0 && candle.t === sorted[i - 1].t) return { ok: false, reason: "1m history has a duplicate" };
  }
  return { ok: true, candles: sorted };
}

/**
 * TradingView Visible Range Volume Profile equivalent, built from lower-timeframe
 * bars (1-minute bars for a 24h window).
 *
 * Each bar's volume is spread in proportion to how much of its [low, high] range
 * overlaps each row. Close >= open is up volume; otherwise down. POC is the
 * midpoint of the row with the greatest up+down volume. Equal POC totals keep
 * the lower row.
 *
 * The value area follows TradingView's published adjacency steps: start at the
 * POC, then compare the single next row above with the single next row below and
 * add the larger one only when it does not exceed the remaining 70% target.
 * Equal candidates use the row closer to the POC, and the row above when the
 * distances match. A row that would pass the target is not added.
 */
export function volumeProfile(candles, { rows = 24, valueArea = 0.7 } = {}) {
  if (!Array.isArray(candles) || candles.length === 0 || !Number.isInteger(rows) || rows < 1) return null;
  if (!(valueArea > 0) || valueArea > 1) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const candle of candles) {
    const high = finite(candle?.h);
    const low = finite(candle?.l);
    const open = finite(candle?.o);
    const close = finite(candle?.c);
    const volume = finite(candle?.v);
    if (high == null || low == null || open == null || close == null || volume == null || volume < 0 || high < low) return null;
    lo = Math.min(lo, low);
    hi = Math.max(hi, high);
  }
  if (!(hi > lo)) return null;
  const height = (hi - lo) / rows;
  const bins = Array.from({ length: rows }, (_, index) => ({
    index,
    low: lo + index * height,
    high: lo + (index + 1) * height,
    up: 0,
    down: 0,
  }));
  for (const candle of candles) {
    const side = candle.c >= candle.o ? "up" : "down";
    const span = candle.h - candle.l;
    if (span === 0) {
      let index = Math.floor((candle.c - lo) / height);
      if (index >= rows) index = rows - 1;
      if (index < 0) return null;
      bins[index][side] += candle.v;
      continue;
    }
    for (const bin of bins) {
      const overlap = Math.min(candle.h, bin.high) - Math.max(candle.l, bin.low);
      if (overlap > 0) bin[side] += candle.v * (overlap / span);
    }
  }
  let total = 0;
  for (const bin of bins) {
    bin.total = bin.up + bin.down;
    bin.mid = (bin.low + bin.high) / 2;
    total += bin.total;
  }
  if (!(total > 0)) return null;
  let poc = bins[0];
  for (const bin of bins) if (bin.total > poc.total) poc = bin;
  const area = expandValueArea(bins, poc.index, total * valueArea);
  return {
    method: "tradingview-vpvr",
    label: "TradingView-VPVR-equivalent",
    poc: poc.mid,
    pocRow: poc.index,
    valueAreaHigh: area.high,
    valueAreaLow: area.low,
    coveredVolume: area.covered,
    totalVolume: total,
    rows: bins.map(bin => ({ low: bin.low, high: bin.high, mid: bin.mid, up: bin.up, down: bin.down, total: bin.total })),
  };
}

function expandValueArea(bins, pocIndex, target) {
  let low = pocIndex;
  let high = pocIndex;
  let covered = bins[pocIndex].total;
  let above = pocIndex + 1;
  let below = pocIndex - 1;
  while (covered < target && (above < bins.length || below >= 0)) {
    const aboveVol = above < bins.length ? bins[above].total : null;
    const belowVol = below >= 0 ? bins[below].total : null;
    let pick;
    if (aboveVol == null && belowVol == null) break;
    else if (aboveVol == null) pick = "below";
    else if (belowVol == null) pick = "above";
    else if (aboveVol > belowVol) pick = "above";
    else if (belowVol > aboveVol) pick = "below";
    else {
      const aboveDistance = above - pocIndex;
      const belowDistance = pocIndex - below;
      pick = belowDistance < aboveDistance ? "below" : "above";
    }
    const volume = pick === "above" ? aboveVol : belowVol;
    if (covered + volume > target) break;
    if (pick === "above") {
      high = above;
      above += 1;
    } else {
      low = below;
      below -= 1;
    }
    covered += volume;
  }
  return { low: bins[low].low, high: bins[high].high, covered };
}
