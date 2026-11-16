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

  const crash = crashDrawdown(snapshot, rules);
  display.crashGuard = crash;
  if (!crash.ok && crash.reason) reasons.push(crash.reason);
  const depth = poolDepth(snapshot, rules);
  display.poolDepth = depth;
  if (!depth.ok && depth.reason) reasons.push(depth.reason);

  const screens = extraEntryScreens(snapshot, rules);
  display.screens = screens.display;
  reasons.push(...screens.reasons);

  return { pass: reasons.length === 0, reasons, display };
}

export function extraEntryScreens(snapshot, rules = {}) {
  const reasons = [];
  const display = {};
  const now = num(snapshot?.checkedAt ?? snapshot?.asOf);
  reasons.push(...feeTvlScreen(snapshot, rules, display));
  reasons.push(...feeTurnoverScreen(snapshot, rules, display));
  reasons.push(...stickyRugScreen(snapshot, rules, now, display));
  reasons.push(...keepBiggestScreen(snapshot, rules, display));
  reasons.push(...slBlacklistScreen(snapshot, rules, now, display));
  return { reasons: reasons.filter(Boolean), display };
}

function feeTvlScreen(snapshot, rules, display) {
  const screen = rules.feeTvl30m || {};
  if (screen.enabled === false) return [];
  const minPct = Number.isFinite(Number(screen.minPct)) ? Number(screen.minPct) : 0.6;
  const value = presentNumber(snapshot?.feeTvl30mPct);
  display.feeTvl30m = { minPct, feeTvl30mPct: value };
  if (value == null) return ["30m fee/TVL unavailable"];
  if (value < minPct) return [`30m fee/TVL ${value}% below ${minPct}%`];
  return [];
}

function feeTurnoverScreen(snapshot, rules, display) {
  const screen = rules.feeTurnover || {};
  if (screen.enabled === false) return [];
  const maxPct = Number.isFinite(Number(screen.maxFeeTvl24hPct)) ? Number(screen.maxFeeTvl24hPct) : 60;
  const maxTvl = Number.isFinite(Number(screen.maxTvlUsd)) ? Number(screen.maxTvlUsd) : 25_000;
  const tvl = presentNumber(snapshot?.liquidityUsd);
  const ratio = presentNumber(snapshot?.feeTvl24hPct);
  display.feeTurnover = { maxFeeTvl24hPct: maxPct, maxTvlUsd: maxTvl, liquidityUsd: tvl, feeTvl24hPct: ratio };
  if (tvl == null) return ["fee turnover TVL unavailable"];
  if (tvl >= maxTvl) return [];
  if (ratio == null) return ["24h fee/TVL unavailable"];
  if (ratio > maxPct) return [`fee turnover: 24h fee/TVL ${ratio}% above ${maxPct}% on ${tvl} liquidity`];
  return [];
}

function stickyRugScreen(snapshot, rules, now, display) {
  const screen = rules.stickyRug || {};
  if (screen.enabled === false) return [];
  const ttl = Number.isFinite(Number(screen.ttlMs)) ? Number(screen.ttlMs) : 7 * 24 * 60 * 60 * 1000;
  const risky = snapshot?.rugRisky;
  const flaggedAt = snapshot?.rugFlaggedAt;
  display.stickyRug = { ttlMs: ttl, rugRisky: risky === undefined ? null : risky, rugFlaggedAt: flaggedAt ?? null };
  if (risky === true) return ["sticky rug: mint is flagged risky"];
  if (flaggedAt === undefined && risky === undefined) return ["rug check unavailable"];
  if (typeof flaggedAt === "number") {
    if (now == null) return ["rug check clock unavailable"];
    if (now - flaggedAt < ttl) return ["sticky rug: mint stays blocked after an earlier flag"];
  }
  return [];
}

function keepBiggestScreen(snapshot, rules, display) {
  const screen = rules.keepBiggest || {};
  if (screen.enabled === false) return [];
  const floor = Number.isFinite(Number(screen.minTwinLiquidityUsd)) ? Number(screen.minTwinLiquidityUsd) : 10_000;
  if (!Array.isArray(snapshot?.pools)) return ["pool siblings unavailable"];
  const mine = presentNumber(snapshot.liquidityUsd);
  if (mine == null) return ["pool liquidity unavailable for keep-biggest"];
  const contenders = snapshot.pools
    .map(pool => presentNumber(pool?.liquidityUsd))
    .filter(value => value != null && value >= floor);
  const biggest = contenders.reduce((max, value) => Math.max(max, value), 0);
  display.keepBiggest = { minTwinLiquidityUsd: floor, liquidityUsd: mine, biggest };
  if (mine < floor) {
    if (contenders.length > 0) return [`keep biggest: pool liquidity ${mine} is below ${floor} and a larger pool exists`];
    return [];
  }
  if (biggest > mine) return [`keep biggest: pool liquidity ${mine} is below ${biggest}`];
  return [];
}

function slBlacklistScreen(snapshot, rules, now, display) {
  const screen = rules.slMintBlacklist || {};
  if (screen.enabled === false) return [];
  const cooldown = Number.isFinite(Number(screen.cooldownMs)) ? Number(screen.cooldownMs) : 30 * 60 * 1000;
  const closedAt = snapshot?.slClosedAt;
  display.slMintBlacklist = { cooldownMs: cooldown, slClosedAt: closedAt ?? null };
  if (closedAt === undefined) return ["stop-loss history unavailable"];
  if (closedAt == null) return [];
  if (now == null) return ["stop-loss clock unavailable"];
  if (now - Number(closedAt) < cooldown) return ["stop-loss blacklist: mint is in cooldown"];
  return [];
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

export function lowerRangeMidpoint(position) {
  const entry = num(position?.entryQuotePrice);
  const lower = num(position?.range?.lower ?? position?.lowerPrice);
  if (entry == null || lower == null || entry <= 0 || lower <= 0 || lower >= entry) return null;
  return (entry + lower) / 2;
}

export function evaluateExit(position, tick, rules) {
  const resolved = resolveQuotePnl(position, tick);
  if (!resolved.ok && num(tick?.positionPnlPct) == null) return { action: null, reason: resolved.reason };
  const pnl = num(tick?.positionPnlPct) ?? resolved.pnlPct;
  const peak = num(position?.peakPnlPct);
  const lock = rules.breakevenLock || {};
  const armed = lock.enabled !== false && peak != null && peak >= (Number(lock.armPnlPct) || 5);
  const lockExit = Number.isFinite(Number(lock.exitPnlPct)) ? Number(lock.exitPnlPct) : 0;
  if (armed && pnl <= lockExit) {
    return { action: "CLOSE", rule: "breakeven-lock", reason: `breakeven lock after peak ${peak}% at ${pnl}%` };
  }
  if (pnl <= rules.stopLossPct) return { action: "CLOSE", rule: "stop", reason: `stop loss ${pnl}%` };
  const emergency = rules.emergencyTakeProfit || {};
  if (emergency.enabled !== false && pnl >= (Number(emergency.minPnlPct) || 10)) {
    const mid = lowerRangeMidpoint(position);
    const price = num(tick?.quotePrice);
    if (mid != null && price != null && price <= mid) {
      return { action: "CLOSE", rule: "emergency-take-profit", reason: `emergency take profit ${pnl}% at or below range midpoint ${mid}` };
    }
  }
  if (pnl >= rules.hardTakeProfitPct) return { action: "CLOSE", rule: "hard-take-profit", reason: `hard take profit ${pnl}%` };
  const oor = oorTakeProfit(position, tick, rules, pnl);
  if (oor) return oor;
  if (peak != null && peak >= rules.trailActivatePct && pnl <= peak - rules.trailDistancePct) {
    return { action: "CLOSE", rule: "trail", reason: `trail peak ${peak}% current ${pnl}%` };
  }
  const close = num(tick?.completed5mClose);
  if (position?.pocValid && close != null && close < position.pocPrice) {
    return { action: "CLOSE", rule: "poc", reason: `5m close ${close} below locked POC ${position.pocPrice}` };
  }
  return { action: null, reason: "hold" };
}

function oorTakeProfit(position, tick, rules, pnl) {
  const cfg = rules.oorReposition || {};
  if (cfg.enabled === false) return null;
  const active = num(tick?.activeBin ?? position?.activeBin);
  const upper = num(tick?.upperBin ?? position?.upperBin);
  if (active == null || upper == null) return null;
  const above = active - upper;
  const bins = Number.isFinite(Number(cfg.binsAbove)) ? Number(cfg.binsAbove) : 5;
  const take = Number.isFinite(Number(cfg.takeProfitPct)) ? Number(cfg.takeProfitPct) : 0.5;
  if (above > bins && pnl >= take) {
    return { action: "CLOSE", rule: "oor-take-profit", reason: `oor take profit ${pnl}% after ${above} bins above the range` };
  }
  return null;
}

export function evaluateOorReposition(position, tick, rules, pnl) {
  const cfg = rules.oorReposition || {};
  if (cfg.enabled === false) return { action: null, simulated: true, executed: false };
  const active = num(tick?.activeBin ?? position?.activeBin);
  const upper = num(tick?.upperBin ?? position?.upperBin);
  const lower = num(tick?.lowerBin ?? position?.lowerBin);
  if (active == null || upper == null || lower == null || !(upper > lower)) {
    return { action: null, simulated: true, executed: false, reason: "oor bins unavailable" };
  }
  const above = active - upper;
  const bins = Number.isFinite(Number(cfg.binsAbove)) ? Number(cfg.binsAbove) : 5;
  if (!(above > bins)) return { action: null, simulated: true, executed: false };
  const floor = Number.isFinite(Number(cfg.floorPnlPct)) ? Number(cfg.floorPnlPct) : -3;
  if (pnl == null) return { action: null, simulated: true, executed: false, reason: "oor pnl unavailable" };
  if (pnl < floor) return { action: null, simulated: true, executed: false, reason: `oor reposition skipped: pnl ${pnl}% below ${floor}%` };
  const count = Number(position?.oorRepositions) || 0;
  const cap = Number.isFinite(Number(cfg.maxRepositions)) ? Number(cfg.maxRepositions) : 2;
  if (count >= cap) return { action: null, simulated: true, executed: false, reason: "oor reposition cap reached" };
  const width = upper - lower;
  return {
    action: "reposition",
    rule: "oor-reposition",
    reason: `oor reposition ${count + 1} of ${cap} after ${above} bins above the range`,
    simulated: true,
    executed: false,
    binsAbove: above,
    hybrid: { removeBps: 10000, shrinkMode: 3, legs: ["spot", "bidask"] },
    next: { upperBin: active, lowerBin: active - width, oorRepositions: count + 1 },
  };
}

export function smaDisplay(values, length) {
  return sma(values, length);
}
