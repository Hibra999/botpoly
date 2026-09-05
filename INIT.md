# INIT

This repository is a TypeScript SDK and bot workspace for Polymarket.

## Local Git identity

Use these settings in this repository only:

```bash
git config --local user.name "Hibra999"
git config --local user.email "miarsito1@gmail.com"
git config --local core.sshCommand "ssh -i /home/gabo/.ssh/id_ed25519_hibra999 -o IdentitiesOnly=yes"
```

## Prerequisites

- Node.js 18+
- npm
- Git
- A Polymarket wallet/private key for live trading scripts

## Install

```bash
npm install
cd dashboard
npm install
npm run build
cd ..
```

## Configure

Copy `.env.example` to `.env` and set the values you need.

Important variables used by the project:

- `POLYMARKET_PRIVATE_KEY`
- `CAPITAL_USD`
- `DRY_RUN`
- `DAILY_MAX_LOSS_PCT`
- `MONTHLY_MAX_LOSS_PCT`
- `MAX_DRAWDOWN_PCT`
- `TOTAL_MAX_LOSS_PCT`

For the lower-level scripts under `scripts/`, `POLY_PRIVKEY` is also used.

## Build

```bash
npm run build
```

## Test

```bash
npm test
npm run test:integration
```

## Run examples

```bash
npm run example:basic
npm run example:smart-money
npm run example:market-analysis
npm run example:kline
npm run example:follow-wallet
npm run example:services
npm run example:realtime
npm run example:trading
npm run example:rewards
npm run example:ctf
npm run example:live-arb
npm run example:trending-arb
npm run example:arb-service
```

## Run the bot

```bash
npx tsx bot-with-dashboard.ts
```

The dashboard is expected at `http://localhost:3001`.

## Useful scripts

Examples of direct script entry points:

```bash
npx tsx scripts/verify/verify-all-apis.ts
npx tsx scripts/wallet/check-wallet-balances.ts
npx tsx scripts/trading/check-orders.ts
npx tsx scripts/deposit/deposit-native-usdc.ts check
```

## Notes

- Keep secrets in `.env`, not in the repo.
- `dashboard/` is its own buildable app with `vite`.
- `README.md`, `QUICKSTART.md`, and `BEGINNER_GUIDE.md` contain the longer project guidance.
