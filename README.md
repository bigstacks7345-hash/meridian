# Meridian

Standalone wallet-triggered Meteora DLMM bot for Solana. It waits for fresh LP entries by tracked wallets, screens the matching token, and manages positions with deterministic rules. No LLM or Meridian server is required.

## Flow

1. Watch tracked LP wallets through Solana WebSocket notifications, with signature backfill for missed events.
2. Count distinct wallets adding meaningful quote-side liquidity to the same **mint address**, across pools, within a rolling window (default: two wallets in 120 seconds).
3. Screen that mint and its eligible token/SOL pools using Meteora and Jupiter data and on-chain token checks.
4. Recheck exposure, price movement, balances, and transaction safety before entry. Failed screening waits within a bounded deadline.
5. Monitor positions independently and execute rule-based closes and fee claims.

With no `user-config.json`, or with `shadowMode` omitted, the process stays in shadow mode. Shadow mode forces `DRY_RUN` to the exact string `true` and blocks deploy, claim, close, and swap submits. It records entry proposals. `close`, `claim`, and `swap` return before any signature or broadcast. A deploy that passes the local gates still reads pool data before that return. Read [user-config.example.json](user-config.example.json) for supported settings. Monitoring and screening implementation details are in [standalone/](standalone/).

## Setup

Use Node.js 18 or newer and a Solana RPC provider supporting WebSocket subscriptions and transaction history.

```sh
npm install
npm run setup
node cli.js wallets add --wallet ADDRESS --name NAME
node cli.js wallets add --wallet OTHER_ADDRESS --name OTHER_NAME
npm start
```

Setup writes `user-config.json` and sets `shadowMode` to `true`. It preserves existing settings when prompts are left blank, including the example `rpcUrl` when you do not type one. That example host is a public mainnet RPC. Starting the daemon uses it for wallet subscriptions and reads even while submits are blocked. Set credentials in your environment or local `.env`; see [.env.example](.env.example). For read-only operation, `WALLET_ADDRESS` / `walletAddress` can identify the portfolio without a private key. Live signing requires `WALLET_PRIVATE_KEY`. A `walletKey` field inside `user-config.json` is also loaded as that private key; keep the key in `.env` instead.

Supported infrastructure overrides:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Default Solana endpoint and transaction submission |
| `MONITOR_RPC_URL`, `MONITOR_WS_URL` | Wallet monitoring endpoints |
| `BALANCE_RPC_URL` | Standard SOL and token balance reads |
| `FALLBACK_RPC_URL` | Fallback for monitor/balance reads |
| `PNL_SOURCE` | `meteora` (default) or `rpc` |
| `PNL_RPC_URL` | Optional on-chain PnL engine endpoint |
| `JUPITER_API_KEY` | Jupiter price and swap access. Required for authenticated calls; the process has no built-in key |
| `JUPITER_REFERRAL_ACCOUNT`, `JUPITER_REFERRAL_FEE_BPS` | Optional override for the live-swap referral |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional outbound notifications |
| `TELEGRAM_ALLOWED_USER_IDS` | Enables the in-chat admin console. Leave unset to keep it off |

Balances use standard RPC, including SPL Token and Token-2022. PnL defaults to Meteora portfolio and position APIs, with an on-chain fallback. Jupiter supplies prices, token data, and swaps. Live swaps attach the built-in referral unless those referral variables override it.

`npm start` and `npm run pm2:start` do not themselves set `DRY_RUN`. `npm run dev` does. File edits to `user-config.json` apply on restart. The admin console, once `TELEGRAM_ALLOWED_USER_IDS` is set, can change thresholds immediately, switch `shadowMode`, and import or display the private key. Switching shadow off deletes the in-process `DRY_RUN` lock unless the `.env` file itself contains `DRY_RUN=true`.

Submits are blocked while `shadowMode` is anything other than `false`, and also while `DRY_RUN` is exactly `true`. `false`, `1`, and `TRUE` do not block. To enable live trading, review thresholds, the wallet list, and shadow proposals, set `shadowMode` to `false`, remove any `DRY_RUN=true` override, restart, and confirm `npm run safety` prints `"willSubmit": true` before leaving the process running.

## Commands

```sh
node cli.js help
node cli.js status
node cli.js balance
node cli.js positions
node cli.js screen --mint ADDRESS
node cli.js pool --pool ADDRESS
node cli.js manage --dry-run
node cli.js close --position ADDRESS --dry-run
node cli.js performance
```

`screen --mint` is read-only and never deploys. New entries are available only through wallet convergence. Manual close, claim, and swap operations remain available; pass `--dry-run` to force the non-broadcast return. A live close swaps the base token back to SOL unless `--skip-swap` is set. Run `help` for arguments. The CLI no longer writes skills into your home directory.

For a managed daemon:

```sh
npm run pm2:start
npm run pm2:logs
```

## Local state

Wallets, settings, position state, signal checkpoints, decisions, and logs stay local and are ignored by Git. `performance.js` retains closed-position accounting in the existing `lessons.json` file so historical records remain readable; it does not generate LLM lessons or contact HiveMind. Pool history and cooldowns remain in `pool-memory.json`.

A `submitting` attempt left by a restart needs on-chain reconciliation before that mint can be attempted again. Do not erase recovery state to bypass it.

## Validation

```sh
npm test
npm run safety
```

`npm test` checks JavaScript syntax, the standalone signal/rule tests, module imports, CLI behavior, the Meteora PnL path with mocked data, and the non-broadcast dry-run gate. Tests do not submit transactions. `npm run safety` prints shadow mode, whether submits are blocked, and whether a key or Telegram admin allowlist is set. It prints an RPC host, never a URL or secret.

## Legacy archive

The local **`legacy` branch** preserves the complete pre-cleanup snapshot at **`fd835b7`**, including the earlier LLM runtime in its history. The branch was advanced without rewriting any commits. No archive directory is loaded by the new application.

```sh
git show legacy:agent.js
git show legacy:tools/screening.js
git log legacy
```

The archive includes the old prompts/tool catalog, broad scanning, HiveMind and lesson evolution, LPAgent/Meridian relays, top-LPer studies, chart indicators, GMGN enrichment, Discord listener, Claude agent presets, and old setup/CLI. It has not been pushed automatically.
