// GMGN trending watch, ported from the PC script gmgn-alerts/lp_alert.ps1.
// Polls GET /v1/market/rank (the endpoint behind `gmgn-cli market trending`)
// and turns each token that passes the 5m volume / market cap / bundler rules
// into an external alert. This module only fetches and parses. It never signs.

import { gmgnFetch, gmgnRequestInit, stampGmgnAuth, parseGmgnResetAt } from "../strategy/market-data.js";

const num = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

export function gmgnTrendingUrl(rules) {
  const url = new URL(rules.path, rules.baseUrl);
  url.searchParams.set("chain", rules.chain);
  url.searchParams.set("interval", rules.interval);
  url.searchParams.set("min_volume", String(rules.minVolume5mUsd));
  url.searchParams.set("min_marketcap", String(rules.minMarketCapUsd));
  url.searchParams.set("max_bundler_rate", String(rules.maxBundlerRate));
  url.searchParams.set("order_by", "volume");
  url.searchParams.set("limit", String(rules.limit));
  return url;
}

function usdLabel(n) {
  if (n == null) return null;
  return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;
}

// GMGN filters server-side. Every row is checked again here so a loosened
// server filter never slips through. Rows with a missing metric are dropped.
export function parseGmgnTrending(body, rules, now = Date.now()) {
  const rows = body?.data?.rank;
  if (!Array.isArray(rows)) return { ok: false, reason: "gmgn rank payload incomplete", alerts: [] };
  const bucketMs = Math.max(1, rules.refreshMin) * 60_000;
  const bucket = Math.floor(now / bucketMs);
  const alerts = [];
  for (const row of rows) {
    const mint = typeof row?.address === "string" ? row.address : null;
    const volume = num(row?.volume);
    const mcap = num(row?.market_cap);
    const bundler = num(row?.bundler_rate);
    if (!mint || volume == null || mcap == null || bundler == null) continue;
    if (volume < rules.minVolume5mUsd || mcap < rules.minMarketCapUsd || bundler >= rules.maxBundlerRate) continue;
    alerts.push({
      // One id per mint per refresh window: a token that stays on the list
      // refreshes its pursuit instead of logging a new alert every poll.
      id: `gmgn/${mint}/${bucket}`,
      source: "gmgn",
      mint,
      symbol: typeof row.symbol === "string" ? row.symbol : null,
      pool: null,
      volume5mUsd: volume,
      volume5mLabel: usdLabel(volume),
      marketCapUsd: mcap,
      liquidityUsd: num(row.liquidity),
      bundlerRate: bundler,
      change5mPct: num(row.price_change_percent5m),
      at: now,
    });
  }
  return { ok: true, alerts };
}

export function createGmgnTrendingPoller({
  rules,
  apiKey = process.env.GMGN_API_KEY ?? "",
  fetchImpl = gmgnFetch,
  now = Date.now,
  onAlerts = () => {},
  log = () => {},
  gate = null,
  schedule = (fn, ms) => setTimeout(fn, ms),
  clear = id => clearTimeout(id),
} = {}) {
  let stopped = false;
  let timer = null;
  const base = Math.max(30, Number(rules.pollSec) || 60) * 1000;
  async function tick() {
    if (stopped) return;
    let delay = base;
    try {
      const t = now();
      if (gate?.pausedUntil > t) {
        delay = Math.max(base, gate.pausedUntil - t);
        log(`GMGN paused by a 429 reset, next poll in ${Math.round(delay / 1000)}s`);
      } else {
        const response = await fetchImpl(stampGmgnAuth(gmgnTrendingUrl(rules), t), gmgnRequestInit(apiKey));
        if (response?.status === 429) {
          let body = null;
          try { body = await response.json(); } catch { /* reset header may still be present */ }
          const resetAt = parseGmgnResetAt(response, body, now());
          delay = Math.max(rules.rateLimitPauseSec * 1000, resetAt ? resetAt - now() : 0);
          if (gate) gate.pausedUntil = Math.max(gate.pausedUntil || 0, now() + delay);
          log(`GMGN rate limit hit, pausing ${Math.round(delay / 1000)}s`);
        } else if (!response?.ok) {
          throw new Error(`gmgn status ${response?.status ?? "unknown"}`);
        } else {
          const parsed = parseGmgnTrending(await response.json(), rules, now());
          if (!parsed.ok) throw new Error(parsed.reason);
          log(`${parsed.alerts.length} match(es)`);
          onAlerts(parsed.alerts);
        }
      }
    } catch (error) {
      log(`poll failed: ${error.message}`);
    }
    if (!stopped) timer = schedule(() => tick(), delay);
  }
  return {
    start() { return tick(); },
    stop() { stopped = true; if (timer != null) clear(timer); timer = null; },
  };
}
