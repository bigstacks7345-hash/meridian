// Fill pool fields GMGN did not return. Missing inputs stay missing.
// This module does not sign, broadcast, or decide an entry.

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowsOf(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && (body.address || body.pool_address || body.mint_x || body.token_x)) return [body];
  return [];
}

export function parseMeteoraPools(body, mint, solMint) {
  const matches = [];
  for (const row of rowsOf(body)) {
    const tokenX = row?.token_x?.address || row?.mint_x;
    const tokenY = row?.token_y?.address || row?.mint_y;
    if (mint && tokenX && tokenX !== mint) continue;
    if (solMint && tokenY && tokenY !== solMint) continue;
    // Meteora's datapi moved bin step to pool_config.bin_step and made volume
    // an object keyed by window ({"30m":..,"1h":..}). Read old and new shapes.
    const volume = row?.volume;
    const parsed = {
      binStep: num(row?.dlmm_params?.bin_step ?? row?.pool_config?.bin_step ?? row?.bin_step),
      liquidityUsd: num(row?.tvl ?? row?.liquidity),
      livePrice: num(row?.pool_price ?? row?.current_price),
      volume5mUsd: volume && typeof volume === "object" ? num(volume["5m"]) : num(volume),
      poolAddress: row?.pool_address || row?.address || null,
    };
    if (parsed.binStep == null && parsed.liquidityUsd == null && parsed.livePrice == null) continue;
    matches.push(parsed);
  }
  matches.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return matches[0] || null;
}

export function parseDexScreener(body, mint, solMint) {
  const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
  const matches = [];
  for (const pair of pairs) {
    if (pair?.chainId && pair.chainId !== "solana") continue;
    if (mint && pair?.baseToken?.address && pair.baseToken.address !== mint) continue;
    const quote = pair?.quoteToken?.address;
    const solQuote = !quote || !solMint || quote === solMint;
    matches.push({
      mcapUsd: num(pair?.marketCap ?? pair?.fdv),
      liquidityUsd: num(pair?.liquidity?.usd),
      livePrice: solQuote ? num(pair?.priceNative) : null,
      rank: num(pair?.liquidity?.usd) || 0,
    });
  }
  matches.sort((a, b) => b.rank - a.rank);
  if (!matches.length) return null;
  return { mcapUsd: matches[0].mcapUsd, liquidityUsd: matches[0].liquidityUsd, livePrice: matches[0].livePrice };
}

export function fillMissingMarket(snapshot, { meteora = null, dex = null } = {}) {
  const next = { ...snapshot, marketSources: { ...(snapshot?.marketSources || {}) } };
  const take = (field, value, source) => {
    if (num(value) == null) return;
    if (num(next[field]) != null) return;
    next[field] = Number(value);
    next.marketSources[field] = source;
  };
  if (meteora) {
    take("binStep", meteora.binStep, "meteora");
    take("liquidityUsd", meteora.liquidityUsd, "meteora");
    take("livePrice", meteora.livePrice, "meteora");
    take("poolVolume5mUsd", meteora.volume5mUsd, "meteora");
    if (!next.poolAddress && meteora.poolAddress) next.poolAddress = meteora.poolAddress;
  }
  if (dex) {
    take("mcapUsd", dex.mcapUsd, "dexscreener");
    take("livePrice", dex.livePrice, "dexscreener");
    take("liquidityUsd", dex.liquidityUsd, "dexscreener");
  }
  return next;
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response?.ok) throw new Error(`status ${response?.status ?? "unknown"}`);
  return typeof response.json === "function" ? response.json() : null;
}

export async function enrichMissingMarket(snapshot, {
  mint,
  pool = null,
  solMint,
  fetchImpl,
  meteoraPoolsUrl = "https://dlmm.datapi.meteora.ag/pools",
  dexscreenerTokensUrl = "https://api.dexscreener.com/latest/dex/tokens",
} = {}) {
  if (!snapshot?.ok || typeof fetchImpl !== "function") return snapshot;
  const needPool = num(snapshot.binStep) == null || num(snapshot.liquidityUsd) == null || num(snapshot.livePrice) == null;
  const needDex = num(snapshot.mcapUsd) == null || num(snapshot.livePrice) == null || num(snapshot.liquidityUsd) == null;
  if (!needPool && !needDex) return snapshot;
  let meteora = null;
  let dex = null;
  const fallbackErrors = [];
  if (needPool) {
    try {
      const url = pool
        ? `${meteoraPoolsUrl}/${pool}`
        : `${meteoraPoolsUrl}?${new URLSearchParams({ query: mint, page_size: "20", sort_by: "tvl:desc" })}`;
      meteora = parseMeteoraPools(await readJson(fetchImpl, url), mint, solMint);
      if (!meteora) fallbackErrors.push(`meteora: no ${pool ? "match for pool" : "mint/SOL DLMM pool"}`);
    } catch (error) {
      meteora = null;
      fallbackErrors.push(`meteora: ${error.message}`);
    }
  }
  const stillNeedDex = needDex && (num(snapshot.mcapUsd) == null || (num(snapshot.livePrice) == null && num(meteora?.livePrice) == null) || (num(snapshot.liquidityUsd) == null && num(meteora?.liquidityUsd) == null));
  if (stillNeedDex) {
    try {
      dex = parseDexScreener(await readJson(fetchImpl, `${dexscreenerTokensUrl}/${mint}`), mint, solMint);
      if (!dex) fallbackErrors.push("dexscreener: no pairs");
    } catch (error) {
      dex = null;
      fallbackErrors.push(`dexscreener: ${error.message}`);
    }
  }
  const filled = fillMissingMarket(snapshot, { meteora, dex });
  return fallbackErrors.length ? { ...filled, fallbackErrors } : filled;
}
