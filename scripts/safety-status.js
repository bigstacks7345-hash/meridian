// Print arming state without secrets, RPC paths, or network calls.
import "../envcrypt.js";
import { config, transactionsAreDryRun } from "../config.js";

function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

const dryRunBlocksSubmit = transactionsAreDryRun();
const allowed = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(",")
  .map(part => part.trim())
  .filter(Boolean);

process.stdout.write(JSON.stringify({
  shadowMode: config.standalone.shadow,
  dryRunBlocksSubmit,
  willSubmit: !dryRunBlocksSubmit,
  walletAddressSet: Boolean(config.standalone.walletAddress),
  privateKeySet: Boolean(process.env.WALLET_PRIVATE_KEY),
  rpcHost: hostOf(config.standalone.monitorRpcUrl || process.env.RPC_URL || ""),
  jupiterKeySet: Boolean(process.env.JUPITER_API_KEY),
  telegramTokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  telegramAdminArmed: Boolean(process.env.TELEGRAM_BOT_TOKEN) && allowed.length > 0,
}, null, 2) + "\n");
