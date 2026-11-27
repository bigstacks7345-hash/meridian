// Weekly coin-cycle study: for each coin Thomas screened, how far it ran after
// the trigger and how deep it dumped before giving an exit bounce.
//
// Universe: the decision log (state/decisions-*.jsonl), first trigger per mint.
// Candles: GeckoTerminal's free OHLCV (5m, USD, priced in the mint itself), so
// this study never spends the GMGN credits that live screening needs.
// Market cap moves with price (supply is fixed), so every multiple below is a
// price ratio applied to the trigger market cap.
//
// Read-only. It never signs and never touches positions.

import fs from "node:fs";
import path from "node:path";

const num = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const BAR_MS = 5 * 60_000;
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";

/** Trigger market cap and source from one decision record. */
export function triggerOfRecord(record) {
  const trigger = record?.trigger || {};
  const post = trigger.post || {};
  const source = trigger.source || "wallets";
  const positive = value => (num(value) > 0 ? num(value) : null);
  const marketCapUsd = positive(post.marketCapUsd) ?? positive(post.fdvUsd) ?? positive(record?.fdvUsd);
  return { source, marketCapUsd, symbol: post.symbol ?? null };
}

/**
 * First screening record per mint whose time falls in [from, to).
 * Reads decisions-YYYY-MM-DD.jsonl files for the covered UTC days.
 */
export function loadTriggers(dir, from, to) {
  const firstByMint = new Map();
  if (!fs.existsSync(dir)) return [];
  for (let day = Math.floor(from / 86_400_000) * 86_400_000; day < to; day += 86_400_000) {
    const file = path.join(dir, `decisions-${new Date(day).toISOString().slice(0, 10)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== "decision" || typeof record.mint !== "string") continue;
      const at = Date.parse(record.at);
      if (!Number.isFinite(at) || at < from || at >= to) continue;
      const prior = firstByMint.get(record.mint);
      if (prior && prior.at <= at) continue;
      const trigger = triggerOfRecord(record);
      firstByMint.set(record.mint, {
        mint: record.mint,
        pool: typeof record.pool === "string" ? record.pool : null,
        at,
        decision: record.decision ?? null,
        ...trigger,
      });
    }
  }
  return [...firstByMint.values()].sort((a, b) => a.at - b.at);
}

/** GeckoTerminal ohlcv_list ([t, o, h, l, c, v], newest first) → candles oldest first. */
export function parseGeckoOhlcv(body) {
  const list = body?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return { ok: false, reason: "geckoterminal ohlcv payload incomplete", candles: [] };
  const candles = [];
  for (const row of list) {
    if (!Array.isArray(row)) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c, v].every(Number.isFinite) || h < l || l <= 0) continue;
    candles.push({ t: t * 1000, o, h, l, c, v });
  }
  candles.sort((a, b) => a.t - b.t);
  return { ok: true, candles };
}

/** Pool with the most USD reserve for a mint, from GeckoTerminal's token pools list. */
export function pickTopPool(body, mint) {
  const pools = Array.isArray(body?.data) ? body.data : [];
  let best = null;
  for (const pool of pools) {
    const attrs = pool?.attributes || {};
    const base = pool?.relationships?.base_token?.data?.id;
    const quote = pool?.relationships?.quote_token?.data?.id;
    if (base !== `solana_${mint}` && quote !== `solana_${mint}`) continue;
    const reserve = num(attrs.reserve_in_usd) ?? 0;
    if (!best || reserve > best.reserve) best = { address: attrs.address, reserve };
  }
  return best?.address ?? null;
}

/**
 * Cycle metrics from 5m candles that start at or before the trigger.
 * - entry: close of the candle holding the trigger time
 * - peak: highest high in the window; run = peak / entry
 * - first bounce: after the peak, the first close >= running low x (1 + bounce)
 * - dumpFromPeak: 1 - low before that bounce / peak
 * - deepestFromEntry: 1 - lowest low in the window / entry (0 when it never went below entry)
 * - retrace: share of the peak-to-low drop the bounce recovered
 * - volumeDecay: 1h volume 24h after the peak / 1h volume around the peak
 */
export function cycleMetrics(candles, { at, windowHours = 72, bouncePct = 20 } = {}) {
  if (!Array.isArray(candles) || !candles.length) return { ok: false, reason: "no candles" };
  // GeckoTerminal omits 5m bars with no trades, so the series has gaps and a
  // dead coin simply stops printing. Entry is the last bar at or before the
  // trigger (within 30 min), else the first bar within 15 min after it.
  const end = at + windowHours * 3_600_000;
  let startIdx = -1;
  for (let i = 0; i < candles.length && candles[i].t <= at; i++) startIdx = i;
  if (startIdx >= 0 && at - candles[startIdx].t > 30 * 60_000) startIdx = -1;
  if (startIdx < 0) {
    const after = candles.findIndex(c => c.t > at && c.t - at <= 15 * 60_000);
    if (after < 0) return { ok: false, reason: "no candle at the trigger time" };
    startIdx = after;
  }
  const bars = candles.slice(startIdx).filter(c => c.t < end);
  if (bars.length < 12) return { ok: false, reason: `only ${bars.length} bars after the trigger` };

  const entry = bars[0].c;
  let peakIdx = 0;
  let lowest = bars[0].l;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].h > bars[peakIdx].h) peakIdx = i;
    if (bars[i].l < lowest) lowest = bars[i].l;
  }
  const peak = bars[peakIdx].h;

  const bounceFactor = 1 + bouncePct / 100;
  let low = Infinity;
  let lowIdx = -1;
  let bounceIdx = -1;
  for (let i = peakIdx + 1; i < bars.length; i++) {
    if (bars[i].l < low) { low = bars[i].l; lowIdx = i; }
    if (lowIdx >= 0 && i > lowIdx && bars[i].c >= low * bounceFactor) { bounceIdx = i; break; }
  }
  // A bounce of +bouncePct off the low can only happen after a drop of at least
  // 1 - 1/(1 + bouncePct) from the peak (16.7% at +20%). Coins that never fell
  // that far did not "fail to bounce": `bounced` is null for them.
  const dumpLowForCheck = lowIdx >= 0 ? low : peak;
  const dumped = 1 - dumpLowForCheck / peak >= 1 - 1 / bounceFactor;
  const bounced = dumped ? bounceIdx >= 0 : null;
  let bounceHigh = null;
  if (bounced) {
    bounceHigh = 0;
    for (let i = bounceIdx; i < bars.length; i++) bounceHigh = Math.max(bounceHigh, bars[i].h);
  }
  const dumpLow = lowIdx >= 0 ? low : peak;

  // A missing bar inside the window means no trades, so it counts as zero volume.
  const hourVolume = from => {
    if (from + 3_600_000 > end) return null;
    return bars.filter(c => c.t >= from && c.t < from + 3_600_000).reduce((s, c) => s + c.v, 0);
  };
  const peakT = bars[peakIdx].t;
  const peakVolume = hourVolume(peakT - 30 * 60_000);
  const laterVolume = hourVolume(peakT + 24 * 3_600_000 - 30 * 60_000);

  return {
    ok: true,
    entryPrice: entry,
    peakPrice: peak,
    runMultiple: peak / entry,
    minutesToPeak: Math.round((peakT - bars[0].t) / 60_000),
    dumpFromPeakPct: (1 - dumpLow / peak) * 100,
    deepestFromEntryPct: Math.max(0, (1 - lowest / entry) * 100),
    bounced,
    bounceMultiple: bounced ? bounceHigh / dumpLow : null,
    retraceShare: bounced && peak > dumpLow ? Math.min(1, (bounceHigh - dumpLow) / (peak - dumpLow)) : null,
    minutesPeakToLow: lowIdx >= 0 ? Math.round((bars[lowIdx].t - peakT) / 60_000) : null,
    volumeDecay: peakVolume && laterVolume != null ? laterVolume / peakVolume : null,
    bars: bars.length,
  };
}

/** Calls fn at most once per `gapMs`, so GeckoTerminal's free 30/min limit holds. */
export function createPacer(gapMs, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last = -Infinity;
  return async fn => {
    const wait = last + gapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    return fn();
  };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** GET with the pacer; a 429 waits a minute and retries, up to 3 times. */
export async function geckoJson(fetchImpl, pace, url, { sleep = defaultSleep, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await pace(() => fetchImpl(url, { headers: { accept: "application/json" } }));
    if (res?.status === 429 && attempt < retries) {
      await sleep(60_000);
      continue;
    }
    if (!res?.ok) throw new Error(`geckoterminal status ${res?.status ?? "unknown"}`);
    return res.json();
  }
}

/**
 * 5m candles covering [at - 5m, at + windowHours]. One OHLCV request covers
 * 83 hours. Cached per mint+trigger so a re-run costs nothing.
 */
export async function loadCandles(trigger, { fetchImpl = fetch, pace, cacheDir = null, windowHours = 72, sleep = defaultSleep } = {}) {
  const get = url => geckoJson(fetchImpl, pace, url, { sleep });
  const cacheFile = cacheDir ? path.join(cacheDir, `${trigger.mint}-${trigger.at}.json`) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* refetch */ }
  }
  let pool = trigger.pool;
  if (!pool) {
    pool = pickTopPool(await get(`${GECKO}/tokens/${trigger.mint}/pools?page=1`), trigger.mint);
    if (!pool) return { ok: false, reason: "no pool found" };
  }
  const before = Math.floor((trigger.at + windowHours * 3_600_000 + BAR_MS) / 1000);
  const url = `${GECKO}/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=${trigger.mint}&before_timestamp=${before}`;
  const parsed = parseGeckoOhlcv(await get(url));
  const result = parsed.ok ? { ok: true, pool, candles: parsed.candles } : { ok: false, reason: parsed.reason };
  if (cacheFile && result.ok) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result));
  }
  return result;
}
