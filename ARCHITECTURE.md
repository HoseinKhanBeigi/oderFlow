# Architecture

Real-time microstructure engine that measures **aggressive executed flow**, then asks whether that flow is unusual, persistent, consuming liquidity, and actually moving price.

The engine never infers trader identity. Large, clustered, or persistent aggression is described as observable behavior (execution style, absorption, vacuum), not as “a whale.”

```
Exchange WebSocket
      ↓
Exchange Adapter          (spot and perp stay separate)
      ↓
Normalized Trades + Book + optional liquidations
      ↓
Integrity Gate            (gaps, dupes, stale book → confidence ↓)
      ↓
Large Flow Detector       (absolute tiers + relative percentiles)
      ↓
Rolling Flow / Delta / CVD / Burst / Cluster
      ↓
Liquidity Engine          (nearby depth, consumption, replenishment)
      ↓
Price Response + Absorption
      ↓
Scores + State Classifier
      ↓
Signal API (events, snapshots, tape, alerts)
```

## Core model

```
Price impact  ≈  aggressive order flow  /  available opposing liquidity
```

This is a conceptual relationship, not a physical law. Every conclusion is relative to the asset’s own rolling baseline.

```
LARGE EXECUTED FLOW
       ↓
Is it unusual vs this asset’s history?
       ↓
Is it one print, a burst, a cluster, or persistent?
       ↓
Is opposing liquidity consumed or replenished?
       ↓
Does price respond?
      / \
    YES  NO
     ↓    ↓
Effective flow     Absorption?
```

**Large aggressive BUY does not mean LONG.**  
Effective buying requires a meaningful upward price response. Huge buy aggression with almost no lift is buyer absorption (passive sellers winning). The directional score may still show buy dominance while `state` is `BUYER_ABSORPTION`.

## Process layout

| Layer | Responsibility |
| --- | --- |
| `exchange/` | Binance (and later other) adapters. WS, reconnect, sequence IDs. Output is normalized models only. |
| `market-data/` | Per-symbol trade, book, and liquidation streams. Dedup, ordering, staleness. |
| `flow/` | Aggression flags, large prints, tape, bursts, clusters, rolling windows, delta, CVD. |
| `liquidity/` | Local book, nearby bid/ask notional, consumption vs replenishment, iceberg-like flags. |
| `analysis/` | Price impact efficiency, absorption, large-participant flow score, directional score, confidence, market state. |
| `engine/` | One `SymbolEngine` per `symbol + marketType`. Orchestrator merges spot/perp views without blindly summing them. |
| `config/` | Every threshold, percentile, window, and score weight. Defaults are examples, not constants baked into detectors. |

Spot and perpetual flow are stored separately. Combined snapshots exist, but a spot-buy / perp-sell split must remain visible.

Liquidation executions are tracked as **forced** buy/sell volume and are never folded into discretionary aggressive flow.

## Performance

Thousands of trades per second are expected.

- Individual prints live in a **bounded ring** used for short windows, bursts, clusters, and the large-trade tape.
- Aggregates for 1s–15m windows use a **time-bucket ring** (default 100ms) with incremental sums. Window queries are O(buckets in range), not a full rescan of every trade.
- Mean / std / percentiles use a bounded rolling sample (Welford + on-demand quantiles), not an unbounded history.
- Largest-in-window is the max of per-bucket maxima (exact for max, not for “which trade”).

Detectors update incrementally on each ingest. They do not recompute the world from scratch after every trade.

## Multi-window

Every symbol maintains 1s, 5s, 10s, 30s, 1m, 5m (and optionally 15m) snapshots at once. Short windows catch bursts; longer windows catch persistence. A 1s `BUY_BURST` and a 5m `NO_SIGNAL` can coexist — that is a short impulse, not a regime.

## Data integrity

Reconnects, duplicate trade IDs, out-of-order timestamps, depth sequence gaps, and stale books set integrity flags. Confidence is forced low; high-confidence alerts are suppressed until the book and trade stream are healthy again.

## What this repo builds first

Analytical core only: models, rolling engine, large-trade / burst / delta / CVD / price-response / absorption, adapters as normalizers, and tests. No dashboard.
