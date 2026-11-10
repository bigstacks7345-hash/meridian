import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWNER_STRATEGY } from "../strategy/defaults.js";
import { passingSnapshot } from "../strategy/fixtures.js";
import { planShadowEntry } from "../strategy/shadow.js";
import {
  appendDecision,
  decisionFile,
  pruneDecisionLogs,
  recordExit,
  recordScreening,
  setDecisionDirectory,
} from "../standalone/decisions.js";
import { reviewShadowBook } from "../standalone/runtime.js";

const mint = "MintDecision111111111111111111111111111111";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meridian-decisions-"));
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function signal(now) {
  const [first, second] = OWNER_STRATEGY.wallets;
  return {
    mint,
    source: "wallets",
    events: [
      { wallet: first, mint, pool: "PoolA", at: now - 1_000, depositSol: 1 },
      { wallet: second, mint, pool: "PoolB", at: now - 500, depositSol: 1 },
    ],
  };
}

test("screening decisions and linked exits append to a daily JSONL file", () => {
  const dir = tempDir();
  setDecisionDirectory(dir);
  try {
    const now = Date.parse("2026-11-10T06:00:00.000Z");
    const snapshot = passingSnapshot(mint);
    const proposed = planShadowEntry({ signal: signal(now), snapshot, book: [], rules: OWNER_STRATEGY, now });
    const proposalLog = recordScreening({ now, signal: signal(now), snapshot, book: [], rules: OWNER_STRATEGY, result: proposed });
    assert.equal(proposalLog.decision, "proposal");
    assert.equal(proposalLog.indicators.priceSol, snapshot.livePrice);
    assert.equal(proposalLog.indicators.supertrend.direction, "up");
    assert.ok(proposalLog.indicators.rsi > 0);
    assert.ok(proposalLog.indicators.volume5mUsd > 0);
    assert.ok(proposalLog.indicators.volumeSma20 > 0);
    assert.ok(proposalLog.indicators.poc.price > 0);
    assert.equal(proposalLog.indicators.poc.window.bars > 0, true);
    assert.ok(proposalLog.indicators.range.upper > proposalLog.indicators.range.lower);
    assert.ok(proposalLog.indicators.bollinger.upper > proposalLog.indicators.bollinger.lower);
    assert.equal(proposalLog.position.ordinal, 1);
    assert.equal(proposalLog.position.first, null);
    assert.equal(proposalLog.trigger.source, "wallets");
    assert.equal(proposalLog.trigger.wallets.length, 2);
    assert.equal(proposalLog.liquidityUsd, snapshot.liquidityUsd);
    assert.equal(proposalLog.fdvUsd, snapshot.mcapUsd);

    const open = { ...proposed.proposal, decisionId: proposalLog.id, status: "proposed", pnlPct: 1.2, openedAt: now - 60_000 };
    const second = recordScreening({
      now: now + 180_000,
      signal: signal(now + 180_000),
      snapshot,
      book: [open],
      rules: OWNER_STRATEGY,
      result: { ok: false, filtersPassed: true, reason: "minimum time between openings has not elapsed" },
    });
    assert.equal(second.decision, "pass");
    assert.equal(second.position.ordinal, 2);
    assert.equal(second.position.first.decisionId, proposalLog.id);
    assert.equal(second.position.first.ageMs, 240_000);
    assert.equal(second.position.first.pnlPct, 1.2);
    assert.match(second.reason, /minimum time/);

    const skipped = recordScreening({
      now,
      signal: signal(now),
      snapshot: { ok: false, reason: "candle provider is not configured" },
      book: [],
      rules: OWNER_STRATEGY,
      result: { ok: false, filtersPassed: false, reason: "candle provider is not configured" },
    });
    assert.equal(skipped.decision, "skip");
    assert.equal(skipped.indicators.priceSol, null);

    const fabriq = recordScreening({
      now,
      signal: { mint, source: "fabriq", pool: "PoolFromPost", fabriqAlert: { id: "fabriqalert/1", symbol: "PERPULATOR-SOL", score: 10, poolAge: "5m", fdvUsd: 172040, liquidityUsd: 12170, at: now } },
      snapshot,
      book: [],
      rules: OWNER_STRATEGY,
      result: proposed,
    });
    assert.equal(fabriq.trigger.source, "fabriq");
    assert.equal(fabriq.trigger.post.id, "fabriqalert/1");
    assert.equal(fabriq.poolAge, "5m");
    assert.equal(fabriq.pool, "PoolFromPost");

    open.decisionId = proposalLog.id;
    const closed = reviewShadowBook([open], { at: now + 300_000, pnlPct: 1, pnlDenomination: "quote", quotePrice: open.entryQuotePrice * 1.01 });
    assert.equal(closed.exits.length, 0);
    const stopped = reviewShadowBook([open], { at: now + 360_000, pnlPct: -17, pnlDenomination: "quote" });
    assert.equal(stopped.exits.length, 1);
    const lines = readLines(decisionFile(now, dir));
    const exit = lines.find(line => line.type === "exit");
    assert.equal(exit.decisionId, proposalLog.id);
    assert.equal(exit.positionId, open.id);
    assert.equal(exit.pnlPct, -17);
    assert.equal(exit.entryPrice, open.entryQuotePrice);
    assert.ok(exit.exitPrice < exit.entryPrice);
    assert.equal(exit.holdMs, 420_000);
    assert.match(exit.reason, /stop loss/);

    const secret = "do-not-keep-this-token";
    appendDecision({ type: "decision", mint: "x", apiKey: secret, nested: { walletKey: secret } }, now);
    const text = fs.readFileSync(decisionFile(now, dir), "utf8");
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("apiKey"), false);
  } finally {
    setDecisionDirectory(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("decision files rotate daily and keep 90 days", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "decisions-2026-08-12.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "decisions-2026-08-13.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep\n");
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    const removed = pruneDecisionLogs(dir, now, 90);
    assert.deepEqual(removed, ["decisions-2026-08-12.jsonl"]);
    assert.equal(fs.existsSync(path.join(dir, "decisions-2026-08-13.jsonl")), true);
    assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
