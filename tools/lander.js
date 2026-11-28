// Transaction landing: Jito bundles with a live tip, RPC fallback with a live priority fee.
//
// Every wallet write in tools/dlmm.js goes through landTransactions(). A group of
// up to five transactions is sent to the Jito block engine as one bundle, so they
// land in the same block, in order, or not at all. The tip is a SOL transfer to a
// Jito tip account appended to the last transaction, sized from Jito's live
// landed-tip percentiles and clamped per tier (entry / exit / routine).
//
// If a bundle does not land after `attempts` tries, the same instructions are sent
// one by one through the normal RPC with a priority fee from recent fees on the
// touched accounts. Items marked `optional` (the zap-out swap) are dropped on that
// fallback so the position still closes; the executor's post-close sweep sells the
// token afterwards.
//
// Shadow builds never reach this module's network code: landTransactions() checks
// transactionsAreDryRun() first and returns without fetching, signing or sending.
// Nothing here runs at import time.

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config, transactionsAreDryRun } from "../config.js";
import { log } from "../logger.js";

export const JITO_MAX_BUNDLE_TXS = 5;
export const JITO_MIN_TIP_LAMPORTS = 1000;

// Published Jito mainnet tip accounts. getTipAccounts is tried first; this list is the fallback.
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const LANDING_DEFAULTS = Object.freeze({
  mode: "jito", // jito | rpc
  blockEngineUrl: "https://frankfurt.mainnet.block-engine.jito.wtf",
  tipFloorUrl: "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
  // Percentile of recently landed Jito tips to pay, per tier: 25 | 50 | 75 | 95 | 99 | "ema50".
  entryTipPercentile: 50,
  exitTipPercentile: 75,
  routineTipPercentile: 25,
  minTipLamports: JITO_MIN_TIP_LAMPORTS,
  maxEntryTipLamports: 100_000, // 0.0001 SOL
  maxExitTipLamports: 1_000_000, // 0.001 SOL
  maxRoutineTipLamports: 20_000,
  fallbackTipLamports: 10_000, // used when the tip floor cannot be read
  bundlePriorityMicroLamports: 0, // ordering inside a bundle is fixed; the tip buys inclusion
  attempts: 2, // Jito tries per bundle before the RPC fallback
  rpcFallback: true,
  priorityFeePercentile: 75, // RPC fallback: percentile of recent fees on the touched accounts
  minPriorityMicroLamports: 10_000,
  maxPriorityMicroLamports: 1_000_000,
  pollMs: 400,
  inflightPollMs: 1200, // Jito allows about 1 request a second per IP and region
  confirmTimeoutMs: 60_000,
  // Zap-out swap inside the close bundle.
  swapInBundle: true,
  swapSlippageBps: 500,
  swapAmountBufferBps: 100, // sell 1% less than the estimate so a small shortfall cannot fail the bundle
  swapComputeUnitLimit: 400_000,
});

const TIERS = new Set(["entry", "exit", "routine"]);
const PERCENTILE_KEYS = {
  25: "landed_tips_25th_percentile",
  50: "landed_tips_50th_percentile",
  75: "landed_tips_75th_percentile",
  95: "landed_tips_95th_percentile",
  99: "landed_tips_99th_percentile",
  ema50: "ema_landed_tips_50th_percentile",
};

const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function landingSettings(overrides = {}) {
  return { ...LANDING_DEFAULTS, ...(config.landing || {}), ...overrides };
}

// ─── Tips ──────────────────────────────────────────────────────

let tipFloorCache = { at: 0, value: null };
let tipAccountsCache = { at: 0, value: null };

export function resetLanderCaches() {
  tipFloorCache = { at: 0, value: null };
  tipAccountsCache = { at: 0, value: null };
}

export async function fetchTipFloor(settings = landingSettings(), now = Date.now()) {
  if (tipFloorCache.value && now - tipFloorCache.at < 10_000) return tipFloorCache.value;
  const res = await fetch(settings.tipFloorUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`tip floor ${res.status}`);
  const body = await res.json();
  const row = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== "object") throw new Error("tip floor empty");
  tipFloorCache = { at: now, value: row };
  return row;
}

export function tipCapFor(tier, settings) {
  if (tier === "exit") return settings.maxExitTipLamports;
  if (tier === "entry") return settings.maxEntryTipLamports;
  return settings.maxRoutineTipLamports;
}

/** Lamports to tip for a tier, from a tip-floor row (values in SOL). Pure. */
export function pickTipLamports(floorRow, tier, settings = landingSettings()) {
  if (!TIERS.has(tier)) throw new Error(`unknown landing tier ${tier}`);
  const percentile = tier === "exit" ? settings.exitTipPercentile : tier === "entry" ? settings.entryTipPercentile : settings.routineTipPercentile;
  const key = PERCENTILE_KEYS[percentile];
  if (!key) throw new Error(`unsupported tip percentile ${percentile}`);
  const sol = Number(floorRow?.[key]);
  const raw = Number.isFinite(sol) && sol > 0 ? Math.ceil(sol * 1e9) : Number(settings.fallbackTipLamports);
  const floor = Math.max(JITO_MIN_TIP_LAMPORTS, Number(settings.minTipLamports) || 0);
  const cap = Math.max(floor, Number(tipCapFor(tier, settings)) || floor);
  return Math.min(cap, Math.max(floor, raw));
}

async function resolveTip(tier, settings) {
  try {
    return pickTipLamports(await fetchTipFloor(settings), tier, settings);
  } catch (error) {
    log("landing_warn", `Tip floor unavailable (${error.message}); using fallback tip`);
    return pickTipLamports(null, tier, settings);
  }
}

async function resolveTipAccount(settings, now = Date.now()) {
  if (!tipAccountsCache.value || now - tipAccountsCache.at > 600_000) {
    try {
      const result = await jitoRpc(settings, "getTipAccounts", [], "/api/v1/getTipAccounts");
      if (Array.isArray(result) && result.length) tipAccountsCache = { at: now, value: result };
    } catch {
      // fall back to the published list
    }
  }
  const list = tipAccountsCache.value || JITO_TIP_ACCOUNTS;
  return new PublicKey(list[Math.floor(Math.random() * list.length)]);
}

// ─── Jito block engine ─────────────────────────────────────────

async function jitoRpc(settings, method, params, path = "/api/v1/bundles") {
  const url = `${String(settings.blockEngineUrl).replace(/\/+$/, "")}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (process.env.JITO_AUTH_UUID) headers["x-jito-auth"] = process.env.JITO_AUTH_UUID;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep raw text for the error */ }
  if (!res.ok || body?.error) throw new Error(`Jito ${method} ${res.status}: ${body?.error?.message || text.slice(0, 200)}`);
  return body?.result;
}

// ─── Building ──────────────────────────────────────────────────

export function isComputeUnitPriceIx(ix) {
  return ix?.programId?.toBase58?.() === COMPUTE_BUDGET_ID && ix.data?.[0] === 3;
}

export function isComputeUnitLimitIx(ix) {
  return ix?.programId?.toBase58?.() === COMPUTE_BUDGET_ID && ix.data?.[0] === 2;
}

function payerOf(item) {
  const signer = item.signers?.[0];
  if (!signer?.publicKey) throw new Error("landing item has no fee payer signer");
  return signer.publicKey;
}

/**
 * Compile one item into a signed transaction. Items are either
 *   { tx: Transaction, signers }                                  (Meteora SDK)
 *   { v0: { instructions, lookupTableAccounts }, signers }        (Jupiter swap)
 * Existing compute-unit price instructions are replaced; limits are kept.
 */
export function compileItem(item, { blockhash, lastValidBlockHeight, cuPriceMicroLamports = 0, extraInstructions = [] }) {
  const payer = payerOf(item);
  const priceIxs = cuPriceMicroLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.round(cuPriceMicroLamports) })] : [];
  const source = item.tx ? item.tx.instructions : item.v0?.instructions;
  if (!Array.isArray(source)) throw new Error("landing item has no instructions");
  const body = source.filter((ix) => !isComputeUnitPriceIx(ix));
  const instructions = [...priceIxs, ...body, ...extraInstructions];

  if (item.tx) {
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: item.tx.feePayer || payer });
    tx.add(...instructions);
    tx.sign(...item.signers);
    const raw = tx.serialize();
    return { raw, signature: bs58.encode(tx.signature), writable: writableKeys(instructions) };
  }
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
    .compileToV0Message(item.v0.lookupTableAccounts || []);
  const vtx = new VersionedTransaction(message);
  vtx.sign(item.signers);
  const raw = vtx.serialize();
  if (raw.length > 1232) throw new Error(`transaction too large (${raw.length} bytes)`);
  return { raw, signature: bs58.encode(vtx.signatures[0]), writable: writableKeys(instructions) };
}

function writableKeys(instructions) {
  const out = new Set();
  for (const ix of instructions) for (const key of ix.keys || []) if (key.isWritable) out.add(key.pubkey.toBase58());
  return [...out];
}

/**
 * Sign a bundle with the tip appended to the last transaction. If that makes the
 * last transaction too large, the tip goes into its own small transaction instead.
 */
export function buildSignedBundle(items, { blockhash, lastValidBlockHeight, tipLamports, tipAccount, cuPriceMicroLamports = 0 }) {
  if (!items.length) throw new Error("empty bundle");
  if (items.length > JITO_MAX_BUNDLE_TXS) throw new Error(`bundle has ${items.length} transactions; Jito allows ${JITO_MAX_BUNDLE_TXS}`);
  const opts = { blockhash, lastValidBlockHeight, cuPriceMicroLamports };
  const last = items[items.length - 1];
  const tipIx = SystemProgram.transfer({ fromPubkey: payerOf(last), toPubkey: tipAccount, lamports: tipLamports });
  const head = items.slice(0, -1).map((item) => compileItem(item, opts));
  try {
    return [...head, compileItem(last, { ...opts, extraInstructions: [tipIx] })];
  } catch (error) {
    if (!/too large|overruns|encoding/i.test(error.message)) throw error;
    if (items.length >= JITO_MAX_BUNDLE_TXS) throw new Error("no room for a separate tip transaction in a full bundle");
    const tipItem = { tx: new Transaction().add(tipIx), signers: [last.signers[0]] };
    return [...head, compileItem(last, opts), compileItem(tipItem, opts)];
  }
}

/** Items the RPC fallback still sends: optional steps (the bundled swap) are dropped. */
export function fallbackItems(chunk) {
  const required = chunk.filter((item) => !item.optional);
  return { required, dropped: required.length < chunk.length };
}

/** Split items into bundles of at most five, keeping order. */
export function chunkItems(items, size = JITO_MAX_BUNDLE_TXS) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── Confirmation ──────────────────────────────────────────────

async function waitForSignatures(connection, signatures, lastValidBlockHeight, settings, bundleId = null) {
  const started = Date.now();
  let lastInflight = 0;
  while (Date.now() - started < settings.confirmTimeoutMs) {
    const { value } = await connection.getSignatureStatuses(signatures, { searchTransactionHistory: false });
    const failed = value.find((status) => status?.err);
    if (failed) return { landed: false, reason: `on-chain error ${JSON.stringify(failed.err)}` };
    if (value.every((status) => status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"))) {
      return { landed: true, slot: value[0]?.slot ?? null };
    }
    if (bundleId && Date.now() - lastInflight >= settings.inflightPollMs) {
      lastInflight = Date.now();
      try {
        const inflight = await jitoRpc(settings, "getInflightBundleStatuses", [[bundleId]], "/api/v1/getInflightBundleStatuses");
        const status = inflight?.value?.[0]?.status;
        // "Invalid" can show briefly before the engine indexes a new bundle, so it only
        // counts as final after a grace period.
        if (status === "Failed" || (status === "Invalid" && Date.now() - started > 10_000)) {
          return { landed: false, reason: `bundle ${status}` };
        }
      } catch {
        // status polling is best effort; signature statuses decide
      }
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) return { landed: false, reason: "blockhash expired" };
    await sleep(settings.pollMs);
  }
  return { landed: false, reason: "confirmation timeout" };
}

// ─── Priority fee for the RPC fallback ─────────────────────────

export function percentileOf(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

async function estimatePriorityFee(connection, writable, settings) {
  let fee = null;
  try {
    const recent = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: writable.slice(0, 128).map((key) => new PublicKey(key)),
    });
    fee = percentileOf(recent.map((row) => Number(row.prioritizationFee)), settings.priorityFeePercentile);
  } catch (error) {
    log("landing_warn", `Priority fee estimate failed: ${error.message}`);
  }
  const min = Number(settings.minPriorityMicroLamports) || 0;
  const max = Math.max(min, Number(settings.maxPriorityMicroLamports) || min);
  return Math.min(max, Math.max(min, fee ?? min));
}

async function sendViaRpc(connection, items, settings, label) {
  const signatures = [];
  for (const item of items) {
    const probe = await connection.getLatestBlockhash("confirmed");
    const draft = compileItem(item, { ...probe, cuPriceMicroLamports: 0 });
    const cuPrice = await estimatePriorityFee(connection, draft.writable, settings);
    const fresh = await connection.getLatestBlockhash("confirmed");
    const signed = compileItem(item, { ...fresh, cuPriceMicroLamports: cuPrice });
    await connection.sendRawTransaction(signed.raw, { skipPreflight: false, maxRetries: 3 });
    const outcome = await waitForSignatures(connection, [signed.signature], fresh.lastValidBlockHeight, settings);
    if (!outcome.landed) throw new Error(`${label}: RPC send did not land (${outcome.reason}) ${signed.signature}`);
    log("landing", `${label}: landed via RPC, priority ${cuPrice} µlamports/CU: ${signed.signature}`);
    signatures.push(signed.signature);
  }
  return signatures;
}

// ─── Entry point ───────────────────────────────────────────────

/**
 * Land an ordered list of items. Returns
 *   { signatures, method: "jito" | "rpc" | "mixed", bundles, tip_lamports, dropped_optional }
 * Throws when a required item cannot be landed. In shadow returns { dry_run: true }
 * without any network call.
 */
export async function landTransactions({ label, tier = "routine", items, connection, settings: overrides = {} }) {
  if (transactionsAreDryRun()) {
    return { dry_run: true, would_land: { label, tier, transactions: items?.length ?? 0 } };
  }
  if (!Array.isArray(items) || !items.length) throw new Error(`${label}: nothing to land`);
  const settings = landingSettings(overrides);
  const signatures = [];
  const bundles = [];
  const methods = new Set();
  let tipTotal = 0;
  let droppedOptional = false;

  for (const chunk of chunkItems(items)) {
    let landed = false;
    if (settings.mode === "jito") {
      for (let attempt = 1; attempt <= Math.max(1, settings.attempts) && !landed; attempt++) {
        try {
          const tipLamports = await resolveTip(tier, settings);
          const tipAccount = await resolveTipAccount(settings);
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          const signed = buildSignedBundle(chunk, {
            blockhash, lastValidBlockHeight, tipLamports, tipAccount,
            cuPriceMicroLamports: settings.bundlePriorityMicroLamports,
          });
          const bundleId = await jitoRpc(settings, "sendBundle", [signed.map((tx) => Buffer.from(tx.raw).toString("base64")), { encoding: "base64" }]);
          const sigs = signed.map((tx) => tx.signature);
          log("landing", `${label}: bundle ${bundleId} sent (${signed.length} tx, tip ${tipLamports} lamports, attempt ${attempt})`);
          const outcome = await waitForSignatures(connection, sigs, lastValidBlockHeight, settings, bundleId);
          if (outcome.landed) {
            landed = true;
            signatures.push(...sigs);
            bundles.push({ bundle_id: bundleId, slot: outcome.slot, transactions: sigs.length, tip_lamports: tipLamports });
            tipTotal += tipLamports;
            methods.add("jito");
            log("landing", `${label}: bundle landed in slot ${outcome.slot}`);
          } else {
            log("landing_warn", `${label}: bundle ${bundleId} did not land (${outcome.reason})`);
          }
        } catch (error) {
          log("landing_warn", `${label}: Jito attempt ${attempt} failed: ${error.message}`);
        }
      }
    }
    if (landed) continue;
    if (settings.mode === "jito" && !settings.rpcFallback) throw new Error(`${label}: bundle did not land and RPC fallback is off`);
    const { required, dropped } = fallbackItems(chunk);
    if (dropped) {
      droppedOptional = true;
      log("landing_warn", `${label}: sending without the optional step(s) via RPC`);
    }
    if (required.length) {
      signatures.push(...await sendViaRpc(connection, required, settings, label));
      methods.add("rpc");
    }
  }

  return {
    signatures,
    method: methods.size > 1 ? "mixed" : [...methods][0] || "none",
    bundles,
    tip_lamports: tipTotal,
    dropped_optional: droppedOptional,
  };
}
