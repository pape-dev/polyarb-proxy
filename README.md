# POLYARB — Bayesian arbitrage bot for Polymarket

Automated trading bot that detects correlated Polymarket market pairs, estimates
an edge via a Bayesian model with causal correction, and executes Kelly-sized
positions — in paper trading or live.

## Architecture
polyarb-proxy/
├── index.js          # Express proxy: Polymarket API, Postgres, AI, signed CLOB orders
├── package.json
└── public/
└── index.html    # React/Babel frontend (scanner, execution, config, backtest)
## Features

- **Pair scanner**: automatic discovery of correlated Polymarket markets (Gamma API)
- **Bayesian model with causal correction**: tests whether A's price at time *t*
  predicts B at time *t+lag* (`leadLagSamples`), instead of simple contemporaneous
  correlation — not exploitable since both prices move at the same time
- **Anti pseudo-replication statistical correction**: effective N derived from
  sample autocorrelation (AR(1)), minimum spacing between retained observations
  (`minSampleGapMs`), to avoid false signals from overly close ticks
- **Fractional Kelly sizing**, weighted by Wilson CI width and (optionally) an AI
  confidence analysis
- **Real costs modeled**: estimated fees + gas (`feeBps`) deducted from edge, Kelly
  sizing, and realized PnL
- **Correctly signed BUY/SELL PnL** everywhere (live engine + backtest)
- **Automatic exits**: stop-loss, take-profit, signal flip, and automatic
  settlement when a market resolves
- **Dual-mode backtest**:
  - Synthetic (Brownian motion) — verifies the engine runs without bugs
  - **Real data** — actual Polymarket price history, aligned by interpolation,
    the only valid measure of potential profitability
- **PostgreSQL persistence** (positions, bankroll, history, config) — survives
  restarts and redeploys
- **Signed CLOB execution** (EIP-712 via `@polymarket/clob-client`) for live
  trading, with explicit fallback to paper mode if no key is configured

## Deployment (Railway)

### Required environment variables

| Variable | Required | Role |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection (persistence) |
| `ANTHROPIC_API_KEY` | No | AI signal analysis (`/ai`) |
| `POLY_PRIVATE_KEY` | No | Signs real orders — without it, paper mode only |
| `POLY_FUNDER` | No | Polymarket wallet address (proxy wallet), for live trading |

### Installation

```bash
npm install
npm start
Proxy routes
Route
Role
GET /markets
List of active markets (Gamma API)
GET /price?slug=
Market price + resolution detection
GET /book?tokenId=
CLOB order book
GET /history?tokenId=
Price history (real backtest)
POST /ai
AI signal analysis (server-side key only)
GET/POST /cfg
Persisted config (legacy)
GET/POST /state
Persisted state (positions, bankroll, history)
POST /order
Order execution (signed if POLY_PRIVATE_KEY present, else paper)
Disclaimer
This bot executes real financial transactions if configured in live mode. No
profitability is guaranteed — use the real-data backtest before any live
deployment, and start with paper trading.
