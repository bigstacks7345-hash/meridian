// Deterministic market fixture for shadow replay. No network and no private keys.

import { OWNER_STRATEGY } from "./defaults.js";
import { completed5m } from "./market-data.js";

export function passingMinuteHistory(start = 0) {
  const closed1m = [];
  let price = 20;
  for (let i = 0; i < OWNER_STRATEGY.pocExpectedBars; i++) {
    const lowZone = i < 1200;
    const pullback = i % 6 === 5;
    const next = pullback ? price - 0.08 : price + 0.15;
    const open = lowZone ? 10 : price;
    const close = lowZone ? 10.1 : next;
    closed1m.push({
      t: start + i * 60_000,
      o: open,
      h: lowZone ? 10.4 : Math.max(open, close) + 0.02,
      l: lowZone ? 9.6 : Math.min(open, close) - 0.02,
      c: close,
      v: i >= 1435 ? 20_000 : lowZone ? 5_000 : 100,
    });
    if (!lowZone) price = next;
  }
  const current1m = {
    t: start + closed1m.length * 60_000,
    o: price,
    h: price + 0.3,
    l: price - 0.05,
    c: price + 0.2,
    v: 50_000,
  };
  return {
    closed1m,
    current1m,
    closed5m: completed5m(closed1m),
    livePrice: current1m.c,
    createdAt: closed1m[0].t,
    asOf: current1m.t,
  };
}

export function passingSnapshot(mint = "MintReplay11111111111111111111111111111111") {
  const history = passingMinuteHistory();
  return {
    ok: true,
    mint,
    poolAddress: "PoolReplay111111111111111111111111111111111",
    binStep: 100,
    liquidityUsd: 50_000,
    poolVolume5mUsd: 100_000,
    mcapUsd: 400_000,
    holders: 2_000,
    priceDenomination: "quote",
    quoteMint: OWNER_STRATEGY.quoteMint,
    quoteSymbol: OWNER_STRATEGY.quoteSymbol,
    volumeDenomination: "usd",
    ...history,
  };
}
