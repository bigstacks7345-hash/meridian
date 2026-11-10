// Pure owner-strategy decisions. Missing inputs fail closed. Nothing here signs or broadcasts.

import { bollinger, rsiWithSma, sma, supertrend, volumeAboveSma, volumeProfile } from "./indicators.js";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function watchedConvergence(events, rules, now) {
  const allowed = new Set(rules.wallets || []);
  const latest = new Map();
  for (const event of events || []) {
    if (!allowed.has(event?.wallet) || event?.mint == null) continue;
    const at = num(event.at);
    const deposit = num(event.depositSol);
    if (at == null || deposit == null || at > now || now - at > rules.windowSec * 1000) continue;
    if (deposit < rules.minDepositSol) continue;
    const prior = latest.get(event.wallet);
    if (!prior || prior.at < at) latest.set(event.wallet, event);
  }
  const byMint = new Map();
  for (const event of latest.values()) {
    const group = byMint.get(event.mint) || [];
    group.push(event);
    byMint.set(event.mint, group);
  }
  const triggered = [];
  for (const [mint, group] of byMint) {
    if (group.length >= rules.walletThreshold) {
      triggered.push({ mint, wallets: group.map(event => event.wallet), events: group });
    }
  }
  return triggered;
}

export function evaluateEntry(snapshot, rules) {
  const reasons = [];
  const display = {};
  if (!snapshot || snapshot.ok === false) {
    return { pass: false, reasons: [snapshot?.reason || "market snapshot unavailable"], display };
  }
  const binStep = num(snapshot.binStep);
  const liquidity = num(snapshot.liquidityUsd);
  const mcap = num(snapshot.mcapUsd);
  const holders = num(snapshot.holders);
  const livePrice = num(snapshot.livePrice);
  if (snapshot.priceDenomination !== rules.priceDenomination) reasons.push("price denomination is not the pool quote");
  if (binStep == null) reasons.push("bin step unavailable");
  else if (binStep < rules.binStepMin || binStep > rules.binStepMax) reasons.push(`bin step ${binStep} outside ${rules.binStepMin}-${rules.binStepMax}`);
  if (liquidity == null) reasons.push("pool liquidity unavailable");
  else if (liquidity < rules.liquidityMinUsd || liquidity > rules.liquidityMaxUsd) reasons.push(`liquidity ${liquidity} outside ${rules.liquidityMinUsd}-${rules.liquidityMaxUsd}`);
  if (mcap == null) reasons.push("market cap unavailable");
  else if (mcap < rules.mcapMinUsd || (rules.mcapMaxUsd != null && mcap > rules.mcapMaxUsd)) reasons.push(`market cap ${mcap} outside limits`);
  if (holders == null) reasons.push("holders unavailable");
  else if (holders < rules.holdersMin) reasons.push(`holders ${holders} below ${rules.holdersMin}`);
  if (livePrice == null || livePrice <= 0) reasons.push("live price unavailable");

  const closed5m = snapshot.closed5m;
  if (!Array.isArray(closed5m) || closed5m.length < 1) reasons.push("previous 5m volume unavailable");
  else {
    const previous = closed5m[closed5m.length - 1];
    const volume = num(previous?.v);
    if (volume == null) reasons.push("previous 5m volume unavailable");
    else if (volume < rules.prev5mVolumeMinUsd) reasons.push(`previous 5m volume ${volume} below ${rules.prev5mVolumeMinUsd}`);
  }

  const bars1m = Array.isArray(snapshot.closed1m) && snapshot.current1m
    ? [...snapshot.closed1m, snapshot.current1m]
    : null;
  const volumeCheck = bars1m ? volumeAboveSma(bars1m, rules.volumeSmaPeriod) : null;
  if (!volumeCheck) reasons.push("1m volume SMA unavailable");
  else if (!volumeCheck.above) reasons.push("current 1m volume is not above its SMA");
  display.volume = volumeCheck;

  const rsi = bars1m ? rsiWithSma(bars1m, rules.rsiLength, rules.rsiSmaLength) : null;
  if (!rsi || rsi.value == null) reasons.push("1m RSI unavailable");
  else if (rsi.value < rules.rsiMin || rsi.value > rules.rsiMax) reasons.push(`RSI ${rsi.value} outside ${rules.rsiMin}-${rules.rsiMax}`);
  display.rsi = rsi ? rsi.value : null;
  display.rsiSma = rsi ? rsi.sma : null;

  const trend = Array.isArray(snapshot.closed1m) ? supertrend(snapshot.closed1m, {
    atrLength: rules.supertrendAtrLength,
    factor: rules.supertrendFactor,
  }) : null;
  if (!trend || trend.trend !== "up" || trend.support == null) reasons.push("1m Supertrend support unavailable");
  else if (!(livePrice > trend.value)) reasons.push("live price is not above the 1m Supertrend");
  display.supertrend = trend;

  display.bollinger = bars1m ? bollinger(bars1m, {
    length: rules.bollingerLength,
    mult: rules.bollingerMult,
    offset: rules.bollingerOffset,
  }) : null;

  const series = selectProfileWindow(snapshot.closed1m, {
    createdAt: snapshot.createdAt,
    asOf: snapshot.asOf,
    lookbackMs: rules.pocLookbackHours * 3_600_000,
    toleranceMs: rules.pocLaunchToleranceMs,
  });
  let profile = null;
  if (!series.ok) reasons.push(series.reason);
  else {
    profile = volumeProfile(series.candles, { rows: rules.pocRows, valueArea: rules.pocValueArea });
    if (!profile) reasons.push("volume profile unavailable");
  }
  display.profile = profile;

  return { pass: reasons.length === 0, reasons, display };
}

export function entryRange(entryPrice, support, binStep, rules) {
  const entry = num(entryPrice);
  const line = num(support);
  const step = num(binStep);
  if (entry == null || entry <= 0 || line == null || line <= 0 || step == null || step <= 0) {
    return { ok: false, reason: "range inputs unavailable" };
  }
  const rawLower = line * (1 - rules.supertrendDiscount);
  const shallow = entry * (1 - rules.rangeMinBelowEntry);
  const deep = entry * (1 - rules.rangeMaxBelowEntry);
  const lower = Math.min(shallow, Math.max(deep, rawLower));
  const upper = entry;
  if (!(lower > 0) || !(upper > lower)) return { ok: false, reason: "range is invalid" };
  const base = 1 + step / 10_000;
  const binsBelow = Math.ceil(Math.log(upper / lower) / Math.log(base));
  if (!Number.isInteger(binsBelow) || binsBelow < rules.minBinsBelow) {
    return { ok: false, reason: `range is below the ${rules.minBinsBelow}-bin floor` };
  }
  return {
    ok: true,
    upper,
    lower,
    rawLower,
    clamped: rawLower !== lower,
    binsBelow,
    binsAbove: 0,
  };
}

export function positionLegs(rules) {
  const total = num(rules.sizeSol);
  const spotFraction = num(rules.spotFraction);
  const bidFraction = num(rules.bidAskFraction);
  if (total == null || total <= 0 || spotFraction == null || bidFraction == null) return null;
  if (Math.abs(spotFraction + bidFraction - 1) > 1e-9) return null;
  const spot = roundSol(total * spotFraction);
  const bidAsk = roundSol(total - spot);
  if (!rules.singleSidedSol) return null;
  return {
    totalSol: total,
    legs: [
      { strategy: "spot", amountSol: spot, amountToken: 0 },
      { strategy: "bid_ask", amountSol: bidAsk, amountToken: 0 },
    ],
  };
}

function roundSol(value) {
  return Math.round(value * 1e9) / 1e9;
}

export function canOpen(book, proposal, rules, now) {
  const open = (book || []).filter(position => position.status === "proposed");
  if (open.length >= rules.maxOpenPositions) return { ok: false, terminal: true, reason: "max open positions reached" };
  const sameToken = open.filter(position => position.mint === proposal.mint);
  if (sameToken.length > 0 && !rules.allowSecondSameToken) return { ok: false, terminal: true, reason: "token already open" };
  const last = open.reduce((max, position) => Math.max(max, position.openedAt || 0), 0);
  if (last && now - last < rules.minSecondsBetweenOpenings * 1000) {
    return { ok: false, terminal: false, reason: "minimum time between openings has not elapsed" };
  }
  return { ok: true };
}

export function lockPoc(profile, entryPrice, rules) {
  const entry = num(entryPrice);
  const poc = num(profile?.poc);
  if (entry == null || poc == null) return { valid: false, reason: "POC unavailable", method: rules.pocMethod };
  const valid = poc < entry * (1 - rules.pocMinBelowEntry);
  return {
    valid,
    price: poc,
    method: profile.method || rules.pocMethod,
    reason: valid ? "POC locked" : "POC is not more than 60% below entry; POC exit ignored",
  };
}

// Same-tick tie break, in time-independent order: stop, hard target, trail, POC.
// A replay steps ticks in order, so the first tick that qualifies is the exit.
// Younger than the lookback: every 1m bar from creation. Older: the prior 24h only.
// A young token whose first bar is more than about a minute after creation is missing
// its launch and cannot be profiled.
export function selectProfileWindow(candles, { createdAt, asOf, lookbackMs, toleranceMs, intervalMs = 60_000 } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return { ok: false, reason: "1m history incomplete" };
  const created = num(createdAt);
  if (created == null) return { ok: false, reason: "token creation time unavailable" };
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    if (!Number.isFinite(sorted[i]?.t) || sorted[i].t - sorted[i - 1].t !== intervalMs) {
      return { ok: false, reason: "1m history has a gap" };
    }
  }
  const first = sorted[0].t;
  const last = sorted[sorted.length - 1].t;
  const end = num(asOf) ?? last + intervalMs;
  if (end <= created) return { ok: false, reason: "token creation time unavailable" };
  if (end - created <= lookbackMs) {
    if (first > created + toleranceMs || first < created - toleranceMs) {
      return { ok: false, reason: "launch 1m history is missing" };
    }
    return { ok: true, candles: sorted.filter(candle => candle.t < end), young: true };
  }
  const start = end - lookbackMs;
  const selected = sorted.filter(candle => candle.t >= start && candle.t < end);
  if (selected.length !== lookbackMs / intervalMs || selected[0]?.t !== start) {
    return { ok: false, reason: "1m history incomplete" };
  }
  return { ok: true, candles: selected, young: false };
}

export function quoteMovePct(entryQuote, markQuote) {
  const entry = num(entryQuote);
  const mark = num(markQuote);
  if (entry == null || mark == null || entry <= 0 || mark <= 0) return null;
  return (mark / entry - 1) * 100;
}

// Stop, trail, and hard target are percentages of quote value, not of the USD price.
export function resolveQuotePnl(position, tick) {
  if (tick?.quotePrice != null && tick?.priceDenomination !== "usd") {
    const pnlPct = quoteMovePct(position?.entryQuotePrice, tick.quotePrice);
    if (pnlPct == null) return { ok: false, reason: "quote price unavailable" };
    return { ok: true, pnlPct };
  }
  if (tick?.pnlDenomination === "usd" || tick?.priceDenomination === "usd" || tick?.completed5mCloseDenomination === "usd") {
    return { ok: false, reason: "price denomination is not the pool quote" };
  }
  if (tick?.pnlDenomination !== "quote" && position?.pnlDenomination !== "quote") {
    return { ok: false, reason: "pnl denomination is not quote" };
  }
  if (tick?.pnlPct == null || !Number.isFinite(Number(tick.pnlPct))) {
    return { ok: false, reason: "pnl unavailable" };
  }
  return { ok: true, pnlPct: Number(tick.pnlPct) };
}

export function evaluateExit(position, tick, rules) {
  const resolved = resolveQuotePnl(position, tick);
  if (!resolved.ok) return { action: null, reason: resolved.reason };
  const pnl = resolved.pnlPct;
  const peak = num(position?.peakPnlPct);
  if (pnl <= rules.stopLossPct) return { action: "CLOSE", rule: "stop", reason: `stop loss ${pnl}%` };
  if (pnl >= rules.hardTakeProfitPct) return { action: "CLOSE", rule: "hard-take-profit", reason: `hard take profit ${pnl}%` };
  if (peak != null && peak >= rules.trailActivatePct && pnl <= peak - rules.trailDistancePct) {
    return { action: "CLOSE", rule: "trail", reason: `trail peak ${peak}% current ${pnl}%` };
  }
  const close = num(tick?.completed5mClose);
  if (position?.pocValid && close != null && close < position.pocPrice) {
    return { action: "CLOSE", rule: "poc", reason: `5m close ${close} below locked POC ${position.pocPrice}` };
  }
  return { action: null, reason: "hold" };
}

export function smaDisplay(values, length) {
  return sma(values, length);
}
