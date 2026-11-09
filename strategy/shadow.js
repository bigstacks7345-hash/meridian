// Shadow proposals only. This module never imports a signer or an RPC client.

import { canOpen, entryRange, evaluateEntry, evaluateExit, lockPoc, positionLegs, watchedConvergence } from "./rules.js";

export function planShadowEntry({ signal, snapshot, book = [], rules, now }) {
  const matches = watchedConvergence(signal?.events || [], rules, now).filter(match => match.mint === signal?.mint);
  const match = matches[0];
  if (!match) return { ok: false, terminal: true, reason: "watched-wallet convergence not met" };
  const entry = evaluateEntry(snapshot, rules);
  if (!entry.pass) return { ok: false, terminal: false, reason: entry.reasons.join("; ") || "entry filters failed" };
  const range = entryRange(snapshot.livePrice, entry.display.supertrend.support, snapshot.binStep, rules);
  if (!range.ok) return { ok: false, terminal: false, reason: range.reason };
  const sized = positionLegs(rules);
  if (!sized) return { ok: false, terminal: true, reason: "position size is invalid" };
  const poc = lockPoc(entry.display.profile, snapshot.livePrice, rules);
  const proposal = {
    id: `shadow-${signal.mint}-${now}`,
    status: "proposed",
    submitted: false,
    mint: signal.mint,
    poolAddress: snapshot.poolAddress || null,
    openedAt: now,
    wallets: [...match.wallets].sort(),
    pools: [...new Set(match.events.map(event => event.pool))].sort(),
    livePrice: snapshot.livePrice,
    totalSol: sized.totalSol,
    legs: sized.legs,
    range,
    rsi: entry.display.rsi,
    rsiSma: entry.display.rsiSma,
    bollinger: entry.display.bollinger,
    supertrend: entry.display.supertrend.value,
    pocValid: poc.valid,
    pocPrice: poc.price,
    pocMethod: poc.method,
    pocReason: poc.reason,
    peakPnlPct: 0,
  };
  const gate = canOpen(book, proposal, rules, now);
  if (!gate.ok) return { ok: false, terminal: gate.terminal, reason: gate.reason };
  return { ok: true, proposal };
}

export function stepShadowPosition(position, tick, rules) {
  if (!position || position.status !== "proposed") return { position, exit: null };
  if (tick?.pnlPct == null || !Number.isFinite(Number(tick.pnlPct))) {
    return { position, exit: null, held: "pnl unavailable" };
  }
  const pnl = Number(tick.pnlPct);
  const peak = Math.max(position.peakPnlPct ?? 0, pnl);
  const next = { ...position, peakPnlPct: peak };
  const exit = evaluateExit(next, tick, rules);
  if (!exit.action) return { position: next, exit: null };
  return {
    position: { ...next, status: "closed", closedAt: tick.at ?? null, closeReason: exit.reason, closeRule: exit.rule },
    exit,
  };
}

export function stepShadowBook(book, tick, rules) {
  const exits = [];
  const next = book.map(position => {
    if (tick.mint && position.mint !== tick.mint) return position;
    const stepped = stepShadowPosition(position, tick, rules);
    if (stepped.exit?.action) exits.push({ id: position.id, ...stepped.exit });
    return stepped.position;
  });
  return { book: next, exits };
}
