// Offline shadow replay. It does not read a private key, sign, or broadcast.
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { planShadowEntry, stepShadowPosition } from "../strategy/shadow.js";
import { watchedConvergence } from "../strategy/rules.js";

const mint = "MintReplay11111111111111111111111111111111";
const now = Date.parse("2026-11-09T00:00:00Z");
const [first, second] = OWNER_STRATEGY.wallets;
const signal = {
  mint,
  events: [
    { wallet: second, mint, pool: "PoolB", at: now - 30_000, depositSol: 0.4 },
    { wallet: first, mint, pool: "PoolA", at: now - 90_000, depositSol: 2 },
  ],
};
const snapshot = passingSnapshot(mint);
const decision = planShadowEntry({ signal, snapshot, book: [], rules: OWNER_STRATEGY, now });
if (!decision.ok) {
  console.log(JSON.stringify({ ok: false, reason: decision.reason }, null, 2));
  process.exitCode = 1;
} else {
  const ticks = [
    { at: now + 60_000, pnlPct: 1, label: "+1% before activation" },
    { at: now + 120_000, pnlPct: -0.5, label: "-0.5% before activation" },
    { at: now + 180_000, pnlPct: 1.85, label: "activation at +1.85%" },
    { at: now + 240_000, pnlPct: 2, label: "peak +2%" },
    { at: now + 300_000, pnlPct: 1, label: "trail exit at +1%" },
  ];
  let position = decision.proposal;
  const trace = [];
  for (const tick of ticks) {
    const stepped = stepShadowPosition(position, tick, OWNER_STRATEGY);
    position = stepped.position;
    trace.push({ label: tick.label, pnlPct: tick.pnlPct, exit: stepped.exit?.rule || null, status: position.status });
    if (position.status === "closed") break;
  }
  const report = {
    mode: "shadow",
    submitted: false,
    provider: OWNER_STRATEGY.candleProvider,
    profile: decision.proposal.pocMethod,
    pocValid: decision.proposal.pocValid,
    pocPrice: decision.proposal.pocPrice,
    livePrice: decision.proposal.livePrice,
    legs: decision.proposal.legs,
    range: { upper: decision.proposal.range.upper, lower: decision.proposal.range.lower, binsBelow: decision.proposal.range.binsBelow },
    rsi: decision.proposal.rsi,
    rsiSma: decision.proposal.rsiSma,
    bollinger: decision.proposal.bollinger,
    wallets: decision.proposal.wallets,
    convergence: watchedConvergence(signal.events, OWNER_STRATEGY, now).length,
    trace,
  };
  console.log(JSON.stringify(report, null, 2));
}
