// Candle providers. The default provider does not call the network.
// GMGN token_kline is paginated backwards. Birdeye is a configurable stub.

import { continuousSeries } from "./indicators.js";

export function createMarketData(rules, deps = {}) {
  if (rules?.candleProvider === "fixture") return fixtureMarketData(deps.fixtures || {});
  if (rules?.candleProvider === "gmgn") return gmgnMarketData(rules, deps);
  if (rules?.candleProvider === "birdeye") return birdeyeMarketData(rules, deps);
  return {
    id: "none",
    async snapshot() {
      return { ok: false, reason: "candle provider is not configured" };
    },
  };
}

export function fixtureMarketData(fixtures) {
  return {
    id: "fixture",
    async snapshot(mint) {
      const found = fixtures[mint];
      if (!found) return { ok: false, reason: "fixture snapshot missing" };
      return { ok: true, ...found };
    },
  };
}

export function createRequestBudget({ limit = 5, windowMs = 1000 } = {}) {
  const stamps = [];
  function fresh(now) {
    const kept = stamps.filter(at => now - at < windowMs);
    stamps.length = 0;
    stamps.push(...kept);
    return kept;
  }
  return {
    take(cost, now) {
      if (!(cost > 0) || cost > limit) return false;
      const kept = fresh(now);
      if (kept.length + cost > limit) return false;
      for (let i = 0; i < cost; i++) stamps.push(now);
      return true;
    },
    waitMs(cost, now) {
      if (!(cost > 0) || cost > limit) return null;
      const kept = fresh(now);
      if (kept.length + cost <= limit) return 0;
      const drop = kept.length + cost - limit;
      return Math.max(0, kept[drop - 1] + windowMs - now);
    },
  };
}

// GMGN token_kline: `volume` is quote/USD notional and `amount` is token units.
export function parseGmgnKlines(body, usdField = "volume") {
  const list = Array.isArray(body?.list) ? body.list : Array.isArray(body?.data?.list) ? body.data.list : null;
  if (!list) return { ok: false, reason: "gmgn kline payload incomplete" };
  const candles = [];
  for (const row of list) {
    const rawTime = Number(row?.time);
    const t = rawTime < 1e12 ? rawTime * 1000 : rawTime;
    const usd = Number(row?.[usdField]);
    const candle = {
      t,
      o: Number(row?.open),
      h: Number(row?.high),
      l: Number(row?.low),
      c: Number(row?.close),
      v: usd,
    };
    if (![candle.t, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite) || candle.h < candle.l || candle.v < 0) {
      return { ok: false, reason: "gmgn candle is incomplete" };
    }
    candles.push(candle);
  }
  return { ok: true, candles };
}

export function gmgnKlineUrl(rules, { mint, from, to }) {
  const url = new URL(rules.gmgnCandlePath, rules.gmgnBaseUrl);
  url.searchParams.set("chain", rules.gmgnChain);
  url.searchParams.set("address", mint);
  url.searchParams.set("resolution", rules.gmgnResolution);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  return url;
}

export function createGmgnGate() {
  return { pausedUntil: 0 };
}

export function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  const found = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : null;
}

export function parseGmgnResetAt(response, body, now) {
  const retryAfter = headerValue(response, "retry-after");
  if (retryAfter != null && retryAfter !== "") {
    if (/^\d+(\.\d+)?$/.test(String(retryAfter).trim())) return now + Number(retryAfter) * 1000;
    const dated = Date.parse(retryAfter);
    if (Number.isFinite(dated)) return dated;
  }
  const resetHeader = headerValue(response, "x-ratelimit-reset") ?? headerValue(response, "ratelimit-reset");
  const bodyReset = body?.retry_after ?? body?.reset ?? body?.reset_at ?? body?.data?.retry_after ?? body?.data?.reset ?? body?.data?.reset_at;
  const raw = resetHeader ?? bodyReset;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return now + n * 1000;
}

async function waitForGmgn(gate, now, sleep) {
  if (!gate) return;
  const wait = gate.pausedUntil - now();
  if (wait > 0) await sleep(wait);
}

export async function fetchGmgn1m({
  rules,
  mint,
  from,
  to,
  fetchImpl,
  sleep = () => Promise.resolve(),
  now = Date.now,
  budget = createRequestBudget(rules),
  apiKey = "",
  gate = null,
  cache = null,
  deadline = null,
}) {
  if (!(to > from) || (to - from) % 60_000 !== 0) return { ok: false, reason: "1m window is invalid" };
  const cacheKey = `raw:${mint}:${from}:${to}`;
  const cached = cache?.get(cacheKey);
  if (cached && now() - cached.at < (rules.candleCacheMs ?? 60_000)) return cached.value;
  const pageMs = rules.gmgnPageBars * 60_000;
  const cost = rules.gmgnCandleCreditCost;
  let cursor = to;
  const collected = [];
  while (cursor > from) {
    const pageFrom = Math.max(from, cursor - pageMs);
    await waitForGmgn(gate, now, sleep);
    if (!budget.take(cost, now())) {
      const wait = budget.waitMs(cost, now());
      if (wait == null) return { ok: false, reason: "gmgn credit window exhausted" };
      await sleep(wait);
      if (!budget.take(cost, now())) return { ok: false, reason: "gmgn credit window exhausted" };
    }
    const url = gmgnKlineUrl(rules, { mint, from: pageFrom, to: cursor });
    let response;
    try {
      response = await fetchImpl(url, {
        headers: apiKey ? { "X-APIKEY": apiKey } : {},
      });
    } catch (error) {
      return { ok: false, reason: `gmgn request failed: ${error.message}` };
    }
    if (response.status === 429) {
      const body = await response.json?.().catch(() => null);
      const resetAt = parseGmgnResetAt(response, body, now()) ?? now() + (rules.gmgnWindowMs ?? 1000);
      if (gate) gate.pausedUntil = Math.max(gate.pausedUntil, resetAt);
      if (deadline != null && resetAt <= deadline) {
        await sleep(Math.max(0, resetAt - now()));
        continue;
      }
      return { ok: false, reason: "gmgn 429; paused until reset" };
    }
    if (!response.ok) return { ok: false, reason: `gmgn status ${response.status}` };
    const parsed = parseGmgnKlines(await response.json(), rules.gmgnUsdField);
    if (!parsed.ok) return parsed;
    collected.push(...parsed.candles);
    cursor = pageFrom;
  }
  const merged = dedupeCandles(collected.filter(candle => candle.t >= from && candle.t < to));
  if (!merged.ok) return merged;
  const series = continuousSeries(merged.candles, 60_000, (to - from) / 60_000);
  if (series.ok) cache?.set(cacheKey, { at: now(), value: series });
  return series;
}

function dedupeCandles(candles) {
  const byTime = new Map();
  for (const candle of candles) {
    const prior = byTime.get(candle.t);
    if (!prior) {
      byTime.set(candle.t, candle);
      continue;
    }
    if (prior.o !== candle.o || prior.h !== candle.h || prior.l !== candle.l || prior.c !== candle.c || prior.v !== candle.v) {
      return { ok: false, reason: "gmgn pages disagree" };
    }
  }
  return { ok: true, candles: [...byTime.values()] };
}

// GMGN OHLC is USD. Quote OHLC divides each token candle by the quote-token
// (wrapped SOL) USD candle at the same timestamp. Volume stays the token's USD
// notional, so VPVR weights and dollar filters do not change units. High and low
// use the cross of the two ranges so a SOL wick cannot invert the quote candle.
export function toQuoteCandles(tokenCandles, quoteUsdCandles) {
  if (!Array.isArray(tokenCandles) || !Array.isArray(quoteUsdCandles) || tokenCandles.length === 0) {
    return { ok: false, reason: "quote candle timestamps are misaligned" };
  }
  if (tokenCandles.length !== quoteUsdCandles.length) return { ok: false, reason: "quote candle timestamps are misaligned" };
  const quoteByTime = new Map();
  for (const candle of quoteUsdCandles) {
    if (!Number.isFinite(candle?.t) || quoteByTime.has(candle.t)) return { ok: false, reason: "quote candle timestamps are misaligned" };
    quoteByTime.set(candle.t, candle);
  }
  const candles = [];
  for (const token of tokenCandles) {
    const quote = quoteByTime.get(token.t);
    if (!quote) return { ok: false, reason: "quote candle timestamps are misaligned" };
    const quoteOpen = Number(quote.o);
    const quoteHigh = Number(quote.h);
    const quoteLow = Number(quote.l);
    const quoteClose = Number(quote.c);
    if (![quoteOpen, quoteHigh, quoteLow, quoteClose].every(price => price > 0)) {
      return { ok: false, reason: "quote candle price is invalid" };
    }
    const open = token.o / quoteOpen;
    const close = token.c / quoteClose;
    const candidates = [open, close, token.h / quoteLow, token.l / quoteHigh];
    if (candidates.some(price => !Number.isFinite(price) || price <= 0) || !Number.isFinite(token.v) || token.v < 0) {
      return { ok: false, reason: "quote candle price is invalid" };
    }
    candles.push({
      t: token.t,
      o: open,
      h: Math.max(...candidates),
      l: Math.min(...candidates),
      c: close,
      v: token.v,
      priceDenomination: "quote",
      volumeDenomination: "usd",
    });
  }
  return { ok: true, candles };
}

export async function fetchQuoteGmgn1m(args) {
  const { rules, mint } = args;
  const budget = args.budget || createRequestBudget(rules);
  const shared = { ...args, budget };
  const token = await fetchGmgn1m(shared);
  if (!token.ok) return token;
  if (mint === rules.quoteMint) {
    return {
      ok: true,
      candles: token.candles.map(candle => ({ ...candle, priceDenomination: "quote", volumeDenomination: "usd" })),
      priceDenomination: "quote",
    };
  }
  const quote = await fetchGmgn1m({ ...shared, mint: rules.quoteMint });
  if (!quote.ok) return quote;
  const converted = toQuoteCandles(token.candles, quote.candles);
  if (!converted.ok) return converted;
  return { ...converted, priceDenomination: "quote" };
}

export function parseTokenCreatedAt(body) {
  const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
  const raw = data?.creation_timestamp ?? data?.created_timestamp ?? data?.open_timestamp ?? data?.creation_time ?? data?.created_at;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "token creation time unavailable" };
  return { ok: true, createdAt: n < 1e12 ? n * 1000 : n };
}

export async function fetchTokenCreatedAt({ rules, mint, fetchImpl, sleep = () => Promise.resolve(), now = Date.now, budget, apiKey = "", gate = null, cache = null, deadline = null }) {
  const cacheKey = `created:${mint}`;
  const cached = cache?.get(cacheKey);
  if (cached && now() - cached.at < (rules.candleCacheMs ?? 60_000)) return cached.value;
  const cost = rules.gmgnInfoCreditCost ?? 1;
  await waitForGmgn(gate, now, sleep);
  if (!budget.take(cost, now())) {
    const wait = budget.waitMs(cost, now());
    if (wait == null) return { ok: false, reason: "gmgn credit window exhausted" };
    await sleep(wait);
    if (!budget.take(cost, now())) return { ok: false, reason: "gmgn credit window exhausted" };
  }
  const url = new URL(rules.gmgnTokenInfoPath, rules.gmgnBaseUrl);
  url.searchParams.set("chain", rules.gmgnChain);
  url.searchParams.set("address", mint);
  let response;
  try {
    response = await fetchImpl(url, { headers: apiKey ? { "X-APIKEY": apiKey } : {} });
  } catch (error) {
    return { ok: false, reason: `gmgn request failed: ${error.message}` };
  }
  if (response.status === 429) {
    const body = await response.json?.().catch(() => null);
    const resetAt = parseGmgnResetAt(response, body, now()) ?? now() + (rules.gmgnWindowMs ?? 1000);
    if (gate) gate.pausedUntil = Math.max(gate.pausedUntil, resetAt);
    if (deadline != null && resetAt <= deadline) {
      await sleep(Math.max(0, resetAt - now()));
      return fetchTokenCreatedAt({ rules, mint, fetchImpl, sleep, now, budget, apiKey, gate, cache, deadline });
    }
    return { ok: false, reason: "gmgn 429; paused until reset" };
  }
  if (!response.ok) return { ok: false, reason: `gmgn status ${response.status}` };
  const parsed = parseTokenCreatedAt(await response.json());
  if (parsed.ok) cache?.set(cacheKey, { at: now(), value: parsed });
  return parsed;
}

export function gmgnMarketData(rules, deps = {}) {
  const budget = deps.budget || createRequestBudget(rules);
  return {
    id: "gmgn",
    async snapshot(mint, window = {}) {
      const apiKey = deps.apiKey ?? process.env.GMGN_API_KEY ?? "";
      if (!apiKey) return { ok: false, reason: "gmgn api key is not configured" };
      const clock = deps.now ?? Date.now;
      const to = window.to ?? clock() - (clock() % 60_000);
      const deadline = window.deadline ?? deps.deadline ?? null;
      const created = await fetchTokenCreatedAt({ ...deps, rules, mint, budget, apiKey, deadline });
      if (!created.ok) return created;
      const lookbackStart = to - rules.pocLookbackHours * 3_600_000;
      const lifeStart = created.createdAt - (created.createdAt % 60_000);
      const from = Math.max(window.from ?? lookbackStart, lifeStart);
      if (!(to > from)) return { ok: false, reason: "gmgn window is incomplete" };
      const cacheKey = `quote:${mint}:${from}:${to}`;
      const cached = deps.cache?.get(cacheKey);
      if (cached && clock() - cached.at < (rules.candleCacheMs ?? 60_000)) return cached.value;
      const series = await fetchQuoteGmgn1m({ ...deps, rules, mint, from, to, budget, apiKey, deadline });
      if (!series.ok) return series;
      const value = {
        ok: true,
        priceDenomination: "quote",
        quoteMint: rules.quoteMint,
        quoteSymbol: rules.quoteSymbol,
        volumeDenomination: "usd",
        createdAt: created.createdAt,
        closed1m: series.candles,
        closed5m: completed5m(series.candles),
      };
      deps.cache?.set(cacheKey, { at: clock(), value });
      return value;
    },
  };
}

export function completed5m(closed1m) {
  if (!Array.isArray(closed1m) || closed1m.length < 5) return [];
  const buckets = new Map();
  for (const candle of closed1m) {
    const bucket = candle.t - (candle.t % 300_000);
    const group = buckets.get(bucket) || [];
    group.push(candle);
    buckets.set(bucket, group);
  }
  const out = [];
  for (const [bucket, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length !== 5) continue;
    const ordered = group.sort((a, b) => a.t - b.t);
    if (ordered.some((candle, index) => candle.t !== bucket + index * 60_000)) continue;
    out.push({
      t: bucket,
      o: ordered[0].o,
      h: Math.max(...ordered.map(candle => candle.h)),
      l: Math.min(...ordered.map(candle => candle.l)),
      c: ordered[4].c,
      v: ordered.reduce((sum, candle) => sum + candle.v, 0),
      priceDenomination: ordered[0].priceDenomination,
      volumeDenomination: ordered[0].volumeDenomination,
    });
  }
  return out;
}

export function buildBirdeyeOhlcvRequest({
  baseUrl = "https://public-api.birdeye.so",
  path = "/defi/v3/ohlcv",
  address,
  timeFromSec,
  timeToSec,
  apiKey = "",
  maxBars = 5000,
} = {}) {
  const url = new URL(path, baseUrl);
  url.searchParams.set("address", address);
  url.searchParams.set("type", "1m");
  url.searchParams.set("currency", "usd");
  url.searchParams.set("mode", "range");
  url.searchParams.set("time_from", String(timeFromSec));
  url.searchParams.set("time_to", String(timeToSec));
  url.searchParams.set("padding", "false");
  const headers = { "x-chain": "solana", accept: "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  return { url: url.toString(), headers, maxBars };
}

export function parseBirdeyeOhlcv(body, maxBars = 5000) {
  const items = body?.data?.items;
  if (!Array.isArray(items)) return { ok: false, reason: "birdeye ohlcv payload incomplete" };
  if (items.length > maxBars) return { ok: false, reason: "birdeye ohlcv exceeds 5000 bars" };
  const candles = items.map(row => ({
    t: Number(row.unix_time ?? row.unixTime) * 1000,
    o: Number(row.o),
    h: Number(row.h),
    l: Number(row.l),
    c: Number(row.c),
    v: Number(row.v),
  }));
  if (candles.some(candle => ![candle.t, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite))) {
    return { ok: false, reason: "birdeye candle is incomplete" };
  }
  return { ok: true, candles };
}

export function birdeyeMarketData(rules) {
  return {
    id: "birdeye",
    async snapshot() {
      if (!rules?.birdeyeEnabled) return { ok: false, reason: "birdeye adapter is stubbed" };
      return { ok: false, reason: "birdeye adapter is stubbed" };
    },
    request: window => buildBirdeyeOhlcvRequest({
      baseUrl: rules.birdeyeBaseUrl,
      path: rules.birdeyePath,
      address: window.mint,
      timeFromSec: Math.floor(window.from / 1000),
      timeToSec: Math.floor(window.to / 1000),
      apiKey: "",
      maxBars: rules.birdeyeMaxBars,
    }),
  };
}
