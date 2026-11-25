// Candle providers. The default provider does not call the network.
// GMGN token_kline is paginated backwards. Birdeye is a configurable stub.

import https from "node:https";
import { randomUUID } from "node:crypto";
import { log as writeLog } from "../logger.js";
import { continuousSeries } from "./indicators.js";

// GMGN OpenAPI: every request needs a unix-seconds timestamp and a new UUID
// client_id. A repeated client_id within 20 seconds is rejected as a replay.
// The official API also rejects IPv6, so the default client uses IPv4 only.
export const GMGN_IPV4 = { family: 4, keepAlive: true };

let ipv4Agent;
export function gmgnIpv4Agent() {
  if (!ipv4Agent) ipv4Agent = new https.Agent(GMGN_IPV4);
  return ipv4Agent;
}

export function gmgnRequestInit(apiKey, agent = gmgnIpv4Agent()) {
  return {
    headers: apiKey ? { "X-APIKEY": apiKey } : {},
    agent,
    family: GMGN_IPV4.family,
  };
}

export function stampGmgnAuth(url, nowMs = Date.now()) {
  url.searchParams.set("timestamp", String(Math.floor(Number(nowMs) / 1000)));
  url.searchParams.set("client_id", randomUUID());
  return url;
}

function gmgnClient(fetchImpl) {
  if (typeof fetchImpl === "function" && fetchImpl !== globalThis.fetch) return fetchImpl;
  return gmgnFetch;
}

export function gmgnFetch(url, init = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || "GET",
      headers: init.headers,
      agent: init.agent ?? gmgnIpv4Agent(),
      family: 4,
      servername: target.hostname,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: {
            get(name) {
              const value = res.headers[String(name).toLowerCase()];
              if (Array.isArray(value)) return value.join(", ");
              return value ?? null;
            },
          },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function reportGmgn(logImpl, message) {
  (logImpl || writeLog)("GMGN", message);
}

async function gmgnBody(response) {
  if (typeof response?.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function gmgnErrorText(body) {
  if (!body || typeof body !== "object") return "";
  return [body.message, body.error].filter(value => typeof value === "string" && value.trim()).join(" ");
}

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

export function gmgnRetryWithinDeadline(deadline, resetAt) {
  return deadline == null || resetAt <= deadline;
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
  log = null,
  calls = null,
}) {
  if (!(to > from) || (to - from) % 60_000 !== 0) return { ok: false, reason: "1m window is invalid" };
  const cacheKey = `raw:${mint}:${from}:${to}`;
  const cached = cache?.get(cacheKey);
  if (cached && now() - cached.at < (rules.klineCacheMs ?? rules.candleCacheMs ?? 60_000)) return cached.value;
  const seriesKey = `kline:${mint}:${rules.gmgnResolution || "1m"}`;
  const seriesTtl = rules.klineCacheMs ?? rules.candleCacheMs ?? 60_000;
  const seriesHit = cache?.get(seriesKey);
  if (seriesHit && now() - seriesHit.at < seriesTtl && seriesHit.from <= from && seriesHit.to >= to) {
    const sliced = seriesHit.candles.filter(candle => candle.t >= from && candle.t < to);
    const reused = continuousSeries(sliced, 60_000, (to - from) / 60_000);
    if (reused.ok) return reused;
  }
  const pageMs = rules.gmgnPageBars * 60_000;
  const cost = rules.gmgnCandleCreditCost;
  let cursor = to;
  let rateRetries = 0;
  const collected = [];
  while (cursor > from) {
    const pageFrom = Math.max(from, cursor - pageMs);
    await waitForGmgn(gate, now, sleep);
    if (!budget.take(cost, now())) {
      const wait = budget.waitMs(cost, now());
      if (wait == null) return { ok: false, reason: "gmgn credit window exhausted", retryAt: now() + (rules.gmgnWindowMs ?? 1000), retry: true };
      await sleep(wait);
      if (!budget.take(cost, now())) return { ok: false, reason: "gmgn credit window exhausted", retryAt: now() + (rules.gmgnWindowMs ?? 1000), retry: true };
    }
    const url = stampGmgnAuth(gmgnKlineUrl(rules, { mint, from: pageFrom, to: cursor }), now());
    if (calls) calls.n += 1;
    let response;
    try {
      response = await gmgnClient(fetchImpl)(url, gmgnRequestInit(apiKey));
    } catch (error) {
      return { ok: false, reason: `gmgn request failed: ${error.message}` };
    }
    if (response.status === 429) {
      const body = await gmgnBody(response);
      const detail = gmgnErrorText(body);
      reportGmgn(log, detail ? `status 429 ${detail}` : "status 429");
      const resetAt = parseGmgnResetAt(response, body, now()) ?? now() + (rules.gmgnWindowMs ?? 1000);
      if (gate) gate.pausedUntil = Math.max(gate.pausedUntil, resetAt);
      if (gmgnRetryWithinDeadline(deadline, resetAt) && rateRetries < 3) {
        rateRetries += 1;
        await sleep(Math.max(0, resetAt - now()));
        continue;
      }
      return { ok: false, reason: "gmgn 429; paused until reset", retryAt: resetAt, retry: true };
    }
    if (!response.ok) {
      const body = await gmgnBody(response);
      const detail = gmgnErrorText(body);
      const reason = detail ? `gmgn status ${response.status} ${detail}` : `gmgn status ${response.status}`;
      reportGmgn(log, reason);
      return { ok: false, reason };
    }
    const parsed = parseGmgnKlines(await response.json(), rules.gmgnUsdField);
    if (!parsed.ok) return parsed;
    collected.push(...parsed.candles);
    rateRetries = 0;
    cursor = pageFrom;
  }
  const merged = dedupeCandles(collected.filter(candle => candle.t >= from && candle.t < to));
  if (!merged.ok) return merged;
  const series = continuousSeries(merged.candles, 60_000, (to - from) / 60_000);
  if (series.ok) {
    cache?.set(cacheKey, { at: now(), value: series });
    cache?.set(seriesKey, { at: now(), from, to, candles: merged.candles });
  }
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

export async function fetchTokenCreatedAt({ rules, mint, fetchImpl, sleep = () => Promise.resolve(), now = Date.now, budget, apiKey = "", gate = null, cache = null, deadline = null, rateRetries = 0, log = null, calls = null }) {
  const cacheKey = `created:${mint}`;
  const cached = cache?.get(cacheKey);
  const infoTtl = rules.tokenInfoCacheMs ?? 30 * 60 * 1000;
  if (cached && now() - cached.at < infoTtl) return cached.value;
  const cost = rules.gmgnInfoCreditCost ?? 1;
  await waitForGmgn(gate, now, sleep);
  if (!budget.take(cost, now())) {
    const wait = budget.waitMs(cost, now());
    if (wait == null) return { ok: false, reason: "gmgn credit window exhausted", retryAt: now() + (rules.gmgnWindowMs ?? 1000), retry: true };
    await sleep(wait);
    if (!budget.take(cost, now())) return { ok: false, reason: "gmgn credit window exhausted", retryAt: now() + (rules.gmgnWindowMs ?? 1000), retry: true };
  }
  if (calls) calls.n += 1;
  const url = stampGmgnAuth(new URL(rules.gmgnTokenInfoPath, rules.gmgnBaseUrl), now());
  url.searchParams.set("chain", rules.gmgnChain);
  url.searchParams.set("address", mint);
  let response;
  try {
    response = await gmgnClient(fetchImpl)(url, gmgnRequestInit(apiKey));
  } catch (error) {
    return { ok: false, reason: `gmgn request failed: ${error.message}` };
  }
  if (response.status === 429) {
    const body = await gmgnBody(response);
    const detail = gmgnErrorText(body);
    reportGmgn(log, detail ? `status 429 ${detail}` : "status 429");
    const resetAt = parseGmgnResetAt(response, body, now()) ?? now() + (rules.gmgnWindowMs ?? 1000);
    if (gate) gate.pausedUntil = Math.max(gate.pausedUntil, resetAt);
    if (gmgnRetryWithinDeadline(deadline, resetAt) && rateRetries < 3) {
      await sleep(Math.max(0, resetAt - now()));
      return fetchTokenCreatedAt({ rules, mint, fetchImpl, sleep, now, budget, apiKey, gate, cache, deadline, log, calls, rateRetries: rateRetries + 1 });
    }
    return { ok: false, reason: "gmgn 429; paused until reset", retryAt: resetAt, retry: true };
  }
  if (!response.ok) {
    const body = await gmgnBody(response);
    const detail = gmgnErrorText(body);
    const reason = detail ? `gmgn status ${response.status} ${detail}` : `gmgn status ${response.status}`;
    reportGmgn(log, reason);
    return { ok: false, reason };
  }
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
      const calls = deps.calls || { n: 0 };
      const counted = { ...deps, calls };
      const withCalls = result => ({ ...result, gmgnCalls: calls.n });
      const created = await fetchTokenCreatedAt({ ...counted, rules, mint, budget, apiKey, deadline, calls });
      if (!created.ok) return withCalls(created);
      const lookbackStart = to - rules.pocLookbackHours * 3_600_000;
      const lifeStart = created.createdAt - (created.createdAt % 60_000);
      const from = Math.max(window.from ?? lookbackStart, lifeStart);
      if (!(to > from)) return withCalls({ ok: false, reason: "gmgn window is incomplete" });
      const cacheKey = `quote:${mint}:${from}:${to}`;
      const cached = deps.cache?.get(cacheKey);
      if (cached && clock() - cached.at < (rules.klineCacheMs ?? rules.candleCacheMs ?? 60_000)) return withCalls(cached.value);
      const series = await fetchQuoteGmgn1m({ ...counted, rules, mint, from, to, budget, apiKey, deadline, calls });
      if (!series.ok) return withCalls(series);
      const value = {
        ok: true,
        priceDenomination: "quote",
        quoteMint: rules.quoteMint,
        quoteSymbol: rules.quoteSymbol,
        volumeDenomination: "usd",
        createdAt: created.createdAt,
        closed1m: series.candles,
        closed5m: completed5m(series.candles),
        gmgnCalls: calls.n,
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
