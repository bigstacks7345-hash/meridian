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

function candleList(value) {
  return Array.isArray(value) ? value.filter(bar => Number.isFinite(bar?.t)) : [];
}

// Enough 1m bars run the indicators. Fewer bars use 5m candles. No candles fails closed.
export function chooseIndicatorCandles(snapshot, rules = {}) {
  const minBars = Number(rules.minIndicatorBars) > 0 ? Number(rules.minIndicatorBars) : 30;
  const closed1m = candleList(snapshot?.closed1m);
  const one = snapshot?.current1m && Number.isFinite(snapshot.current1m.t) ? [...closed1m, snapshot.current1m] : closed1m;
  if (one.length >= minBars) return { ok: true, candles: one, closed: closed1m, timeframe: "1m" };
  const five = candleList(snapshot?.closed5m);
  if (five.length > 0) return { ok: true, candles: five, closed: five, timeframe: "5m", fallback: true };
  if (one.length > 0) return { ok: true, candles: one, closed: closed1m, timeframe: "1m", short: true };
  return { ok: false, reason: "no candles" };
}

export function formatScreenSummary(mint, result, { gmgnCalls = 0 } = {}) {
  const checks = result?.display?.checks || {};
  const body = Object.entries(checks).map(([key, state]) => `${key}=${state}`).join(" ");
  const detail = body || (result?.reasons || []).filter(Boolean).join("; ") || "no checks";
  const id = mint ? String(mint).slice(0, 8) : "?";
  return `screen ${id} ${result?.pass ? "pass" : "fail"} ${detail} gmgnCalls=${gmgnCalls}`;
}

export function evaluateEntry(snapshot, rules) {
  const reasons = [];
  const display = { checks: {} };
  if (!snapshot || snapshot.ok === false) {
    return { pass: false, reasons: [snapshot?.reason || "market snapshot unavailable"], display };
  }
  const binStep = num(snapshot.binStep);
  const liquidity = num(snapshot.liquidityUsd);
  const mcap = num(snapshot.mcapUsd);
  const holders = snapshot.holders == null || snapshot.holders === "" ? null : num(snapshot.holders);
  const livePrice = num(snapshot.livePrice);
  if (snapshot.priceDenomination !== rules.priceDenomination) reasons.push("price denomination is not the pool quote");
  if (binStep == null) {
    reasons.push("bin step unavailable");
    display.checks.bin = "fail";
  } else if (binStep < rules.binStepMin || binStep > rules.binStepMax) {
    reasons.push(`bin step ${binStep} outside ${rules.binStepMin}-${rules.binStepMax}`);
    display.checks.bin = "fail";
  } else display.checks.bin = "pass";
  if (liquidity == null) {
    reasons.push("pool liquidity unavailable");
    display.checks.liq = "fail";
  } else if (liquidity < rules.liquidityMinUsd || liquidity > rules.liquidityMaxUsd) {
    reasons.push(`liquidity ${liquidity} outside ${rules.liquidityMinUsd}-${rules.liquidityMaxUsd}`);
    display.checks.liq = "fail";
  } else display.checks.liq = "pass";
  if (mcap == null) {
    reasons.push("market cap unavailable");
    display.checks.mcap = "fail";
  } else if (mcap < rules.mcapMinUsd || (rules.mcapMaxUsd != null && mcap > rules.mcapMaxUsd)) {
    reasons.push(`market cap ${mcap} outside limits`);
    display.checks.mcap = "fail";
  } else display.checks.mcap = "pass";
  if (holders == null) {
    display.holdersNote = "holders unavailable";
    display.checks.holders = rules.holdersRequired === true ? "fail" : "skip";
    if (rules.holdersRequired === true) reasons.push("holders unavailable");
  } else if (holders < rules.holdersMin) {
    display.holdersNote = `holders ${holders} below ${rules.holdersMin}`;
    display.checks.holders = rules.holdersRequired === true ? "fail" : "skip";
    if (rules.holdersRequired === true) reasons.push(`holders ${holders} below ${rules.holdersMin}`);
  } else display.checks.holders = "pass";
  if (livePrice == null || livePrice <= 0) {
    reasons.push("live price unavailable");
    display.checks.price = "fail";
  } else display.checks.price = "pass";

  const closed5m = snapshot.closed5m;
  if (!Array.isArray(closed5m) || closed5m.length < 1) {
    reasons.push("previous 5m volume unavailable");
    display.checks.vol5m = "fail";
  } else {
    const previous = closed5m[closed5m.length - 1];
    const volume = num(previous?.v);
    if (volume == null) {
      reasons.push("previous 5m volume unavailable");
      display.checks.vol5m = "fail";
    } else if (volume < rules.prev5mVolumeMinUsd) {
      reasons.push(`previous 5m volume ${volume} below ${rules.prev5mVolumeMinUsd}`);
      display.checks.vol5m = "fail";
    } else display.checks.vol5m = "pass";
  }

  const chosen = chooseIndicatorCandles(snapshot, rules);
  display.indicatorTimeframe = chosen.timeframe || null;
  const tf = chosen.timeframe || "1m";
  const indicatorBars = chosen.ok ? chosen.candles : null;
  const volumeCheck = indicatorBars ? volumeAboveSma(indicatorBars, rules.volumeSmaPeriod) : null;
  if (!volumeCheck) {
    reasons.push(chosen.ok ? `${tf} volume SMA unavailable` : chosen.reason);
    display.checks.volSma = "fail";
  } else if (!volumeCheck.above) {
    reasons.push(`current ${tf} volume is not above its SMA`);
    display.checks.volSma = "fail";
  } else display.checks.volSma = "pass";
  display.volume = volumeCheck;

  const rsi = indicatorBars ? rsiWithSma(indicatorBars, rules.rsiLength, rules.rsiSmaLength) : null;
  if (!rsi || rsi.value == null) {
    if (chosen.ok) reasons.push(`${tf} RSI unavailable`);
    display.checks.rsi = "fail";
  } else if (rsi.value < rules.rsiMin || rsi.value > rules.rsiMax) {
    reasons.push(`RSI ${rsi.value} outside ${rules.rsiMin}-${rules.rsiMax}`);
    display.checks.rsi = "fail";
  } else display.checks.rsi = "pass";
  display.rsi = rsi ? rsi.value : null;
  display.rsiSma = rsi ? rsi.sma : null;

  const trendSource = chosen.ok ? (tf === "1m" ? chosen.closed : chosen.candles) : null;
  const trend = trendSource && trendSource.length ? supertrend(trendSource, {
    atrLength: rules.supertrendAtrLength,
    factor: rules.supertrendFactor,
  }) : null;
  if (!trend || trend.trend !== "up" || trend.support == null) {
    if (chosen.ok) reasons.push(`${tf} Supertrend support unavailable`);
    display.checks.trend = "fail";
  } else if (!(livePrice > trend.value)) {
    reasons.push(`live price is not above the ${tf} Supertrend`);
    display.checks.trend = "fail";
  } else display.checks.trend = "pass";
  display.supertrend = trend;

  display.bollinger = indicatorBars ? bollinger(indicatorBars, {
    length: rules.bollingerLength,
    mult: rules.bollingerMult,
    offset: rules.bollingerOffset,
  }) : null;

  const hasCandles = candleList(snapshot.closed1m).length > 0 || candleList(snapshot.closed5m).length > 0;
  const series = hasCandles ? selectProfileWindow(snapshot.closed1m, {
    createdAt: snapshot.createdAt,
    asOf: snapshot.asOf,
    lookbackMs: rules.pocLookbackHours * 3_600_000,
    toleranceMs: rules.pocLaunchToleranceMs,
  }) : { ok: false, reason: "no candles" };
  let profile = null;
  if (!hasCandles) {
    if (!reasons.includes("no candles")) reasons.push("no candles");
    display.checks.poc = "fail";
  } else if (!series.ok) {
    const created = num(snapshot.createdAt);
    const asOf = num(snapshot.asOf);
    const young = created != null && asOf != null && asOf - created <= rules.pocLookbackHours * 3_600_000;
    if (young) {
      reasons.push(series.reason);
      display.checks.poc = "fail";
    } else {
      display.pocNote = series.reason;
      display.checks.poc = "skip";
    }
  } else {
    profile = volumeProfile(series.candles, { rows: rules.pocRows, valueArea: rules.pocValueArea });
    if (!profile) {
      reasons.push("volume profile unavailable");
      display.checks.poc = "fail";
    } else display.checks.poc = "pass";
  }
  display.profile = profile;

  const crash = crashDrawdown(snapshot, rules);
  display.crashGuard = crash;
  display.checks.crash = crash.ok ? "pass" : "fail";
  if (!crash.ok && crash.reason) reasons.push(crash.reason);
  const depth = poolDepth(snapshot, rules);
  display.poolDepth = depth;
  display.checks.depth = depth.ok ? "pass" : "fail";
  if (!depth.ok && depth.reason) reasons.push(depth.reason);

  return { pass: reasons.length === 0, reasons, display };
}

export function crashDrawdown(snapshot, rules = {}) {
  const guard = rules.crashGuard || {};
  const lookbackMin = Number(guard.lookbackMin) > 0 ? Number(guard.lookbackMin) : 30;
  const maxDrawdownPct = Number.isFinite(Number(guard.maxDrawdownPct)) ? Number(guard.maxDrawdownPct) : 60;
  const enabled = guard.enabled !== false;
  const price = num(snapshot?.livePrice);
  const bars = [
    ...(Array.isArray(snapshot?.closed1m) ? snapshot.closed1m : []),
    ...(snapshot?.current1m ? [snapshot.current1m] : []),
  ].filter(bar => Number.isFinite(bar?.t) && num(bar.h) != null && num(bar.h) > 0);
  if (price == null || price <= 0 || bars.length === 0) {
    return { ok: !enabled, enabled, drawdownPct: null, lookbackMin, maxDrawdownPct, high: null, price, reason: enabled ? "crash guard lookback unavailable" : null };
  }
  const end = Math.max(...bars.map(bar => bar.t));
  const start = end - (lookbackMin - 1) * 60_000;
  const window = bars.filter(bar => bar.t >= start && bar.t <= end);
  if (window.length === 0) {
    return { ok: !enabled, enabled, drawdownPct: null, lookbackMin, maxDrawdownPct, high: null, price, reason: enabled ? "crash guard lookback unavailable" : null };
  }
  const high = Math.max(...window.map(bar => bar.h));
  const drawdownPct = Math.round((high - price) / high * 1000) / 10;
  const breached = drawdownPct > maxDrawdownPct;
  return {
    ok: !enabled || !breached,
    enabled,
    drawdownPct,
    high,
    price,
    lookbackMin,
    maxDrawdownPct,
    reason: enabled && breached ? `crash guard: price is ${drawdownPct}% below the ${lookbackMin}m high` : null,
  };
}

export function poolDepth(snapshot, rules = {}) {
  const guard = rules.poolDepth || {};
  const maxVolToLiq5m = Number(guard.maxVolToLiq5m) > 0 ? Number(guard.maxVolToLiq5m) : 15;
  const enabled = guard.enabled !== false;
  const volume = presentNumber(snapshot?.poolVolume5mUsd);
  const liquidity = presentNumber(snapshot?.poolLiquidityUsd ?? snapshot?.liquidityUsd);
  if (volume == null || volume < 0) {
    return { ok: !enabled, enabled, volToLiq: null, volume5mUsd: null, liquidityUsd: liquidity, maxVolToLiq5m, reason: enabled ? "pool 5m volume unavailable; not using token volume" : null };
  }
  if (liquidity == null || liquidity <= 0) {
    return { ok: !enabled, enabled, volToLiq: null, volume5mUsd: volume, liquidityUsd: null, maxVolToLiq5m, reason: enabled ? "pool liquidity unavailable for depth check" : null };
  }
  const volToLiq = Math.round(volume / liquidity * 100) / 100;
  const breached = volToLiq > maxVolToLiq5m;
  return {
    ok: !enabled || !breached,
    enabled,
    volToLiq,
    volume5mUsd: volume,
    liquidityUsd: liquidity,
    maxVolToLiq5m,
    reason: enabled && breached ? `pool depth: 5m volume/liquidity ${volToLiq} exceeds ${maxVolToLiq5m}` : null,
  };
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

function presentNumber(value) {
  if (value == null || value === "") return null;
  return num(value);
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
