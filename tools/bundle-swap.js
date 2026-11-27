// Build a Jupiter swap as raw instructions so it can ride inside a Jito bundle.
//
// Thomas's normal swaps use Jupiter Swap V2 order -> execute, where Jupiter signs
// off and lands the transaction itself. That cannot join a bundle, so the zap-out
// path asks the Swap v1 API for the instructions instead and compiles them into a
// v0 transaction that tools/lander.js signs and bundles behind the close.
//
// Jupiter cannot simulate this swap when it is built: the wallet only receives the
// token from the close earlier in the same bundle. So dynamic compute-unit sizing
// is off and a fixed limit is set here. Jupiter's own compute-budget instructions
// are discarded; lander.js controls price and tip.
//
// The referral fee configured for Swap V2 is not applied on this path.

import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { config } from "../config.js";

const LITE_API = "https://lite-api.jup.ag/swap/v1";
const KEYED_API = "https://api.jup.ag/swap/v1";

export function jupiterSwapApiBase(apiKey = config.jupiter?.apiKey) {
  return apiKey ? KEYED_API : LITE_API;
}

export function toInstruction(raw) {
  if (!raw?.programId || !Array.isArray(raw.accounts) || typeof raw.data !== "string") {
    throw new Error("malformed Jupiter instruction");
  }
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: Boolean(account.isSigner),
      isWritable: Boolean(account.isWritable),
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

/** Order the instructions Jupiter returns, minus its compute-budget ones, behind our own limit. */
export function assembleSwapInstructions(body, computeUnitLimit) {
  if (!body?.swapInstruction) throw new Error(body?.error || "Jupiter returned no swap instruction");
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ...(body.setupInstructions || []).map(toInstruction),
    toInstruction(body.swapInstruction),
    ...(body.cleanupInstruction ? [toInstruction(body.cleanupInstruction)] : []),
  ];
}

/**
 * Returns a landing item { v0, signers, optional: true, quote } for lander.js.
 * `amountRaw` is the input amount in the token's smallest unit, as a string.
 */
export async function buildBundledSwapItem({ connection, wallet, inputMint, outputMint, amountRaw, slippageBps, computeUnitLimit }) {
  if (!/^[1-9]\d*$/.test(String(amountRaw))) throw new Error(`invalid swap amount ${amountRaw}`);
  const apiKey = config.jupiter?.apiKey || "";
  const base = jupiterSwapApiBase(apiKey);
  const headers = { accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) };

  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: "true",
  });
  const quoteRes = await fetch(`${base}/quote?${query}`, { headers });
  if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`);
  const quote = await quoteRes.json();
  if (!quote?.outAmount) throw new Error(quote?.error || "Jupiter quote has no route");

  const ixRes = await fetch(`${base}/swap-instructions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: false,
    }),
  });
  if (!ixRes.ok) throw new Error(`Jupiter swap-instructions ${ixRes.status}: ${(await ixRes.text()).slice(0, 200)}`);
  const body = await ixRes.json();
  const instructions = assembleSwapInstructions(body, computeUnitLimit);

  const lookupTableAccounts = [];
  for (const address of body.addressLookupTableAddresses || []) {
    const table = (await connection.getAddressLookupTable(new PublicKey(address))).value;
    if (!table) throw new Error(`lookup table ${address} not found`);
    lookupTableAccounts.push(table);
  }

  return {
    v0: { instructions, lookupTableAccounts },
    signers: [wallet],
    optional: true,
    quote: { in_amount: quote.inAmount, out_amount: quote.outAmount, min_out_amount: quote.otherAmountThreshold, slippage_bps: quote.slippageBps },
  };
}

/** Raw token-X amount to sell after a full close: position X plus unclaimed X fees, minus a buffer. */
export function estimateCloseSwapAmount(positionData, bufferBps) {
  const x = positionData?.totalXAmountExcludeTransferFee;
  const fee = positionData?.feeXExcludeTransferFee;
  if (!x || typeof x.add !== "function") return null;
  const total = fee && typeof fee.add === "function" ? x.add(fee) : x;
  const keep = 10_000 - Math.max(0, Math.min(9_999, Math.round(Number(bufferBps) || 0)));
  const amount = total.muln(keep).divn(10_000);
  return amount.gtn(0) ? amount.toString() : null;
}
