import { emptyLiquidityResponse } from '../liquidity-response/empty.js';
import { mergeConfig, type EngineConfig } from '../config/index.js';
import { buildNetAggression } from '../flow/net-aggression.js';
import type { AlertEvent, MultiWindowSnapshot, SpotPerpSnapshot, WindowSnapshot } from '../models/signals.js';
import type {
  LiquidationEvent,
  MarketTrade,
  MarketType,
  OrderBookDelta,
  OrderBookSnapshot,
  WindowId,
} from '../models/trade.js';
import { SymbolEngine, type EngineListener } from './symbol-engine.js';

type ConfigOverrides = Parameters<typeof mergeConfig>[0];

function key(symbol: string, marketType: MarketType): string {
  return `${marketType}:${symbol}`;
}

export class OrderFlowEngine {
  readonly config: EngineConfig;
  private readonly engines = new Map<string, SymbolEngine>();
  private readonly listeners = new Set<EngineListener>();

  constructor(overrides: ConfigOverrides = {}) {
    this.config = mergeConfig(overrides);
  }

  getSymbol(symbol: string, marketType: MarketType): SymbolEngine {
    const k = key(symbol, marketType);
    let engine = this.engines.get(k);
    if (!engine) {
      engine = new SymbolEngine(symbol, marketType, this.config);
      for (const listener of this.listeners) engine.on(listener);
      this.engines.set(k, engine);
    }
    return engine;
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    for (const engine of this.engines.values()) engine.on(listener);
    return () => this.listeners.delete(listener);
  }

  ingestTrade(trade: MarketTrade): void {
    this.getSymbol(trade.symbol, trade.marketType).ingestTrade(trade);
  }

  ingestBookSnapshot(snapshot: OrderBookSnapshot): void {
    this.getSymbol(snapshot.symbol, snapshot.marketType).ingestBookSnapshot(snapshot);
  }

  ingestBookDelta(delta: OrderBookDelta): void {
    this.getSymbol(delta.symbol, delta.marketType).ingestBookDelta(delta);
  }

  ingestLiquidation(liq: LiquidationEvent): void {
    this.getSymbol(liq.symbol, liq.marketType).ingestLiquidation(liq);
  }

  snapshot(symbol: string, marketType: MarketType, window: WindowId, now?: number): WindowSnapshot {
    return this.getSymbol(symbol, marketType).snapshot(window, now);
  }

  multiWindow(symbol: string, marketType: MarketType, now?: number): MultiWindowSnapshot {
    return this.getSymbol(symbol, marketType).multiWindow(now);
  }

  spotPerp(symbol: string, window: WindowId, now?: number): SpotPerpSnapshot {
    const spotEngine = this.engines.get(key(symbol, 'spot'));
    const perpEngine = this.engines.get(key(symbol, 'perp'));
    const spot = spotEngine ? spotEngine.snapshot(window, now) : null;
    const perp = perpEngine ? perpEngine.snapshot(window, now) : null;
    const combined = combineSnapshots(symbol, spot, perp, window);
    const timestamp = now ?? spot?.priceEnd ?? perp?.priceEnd ?? Date.now();
    return {
      symbol,
      timestamp,
      price: perp?.price ?? spot?.price ?? 0,
      spot,
      perp,
      combined,
    };
  }

  noteReconnect(symbol: string, marketType: MarketType, now: number): void {
    this.getSymbol(symbol, marketType).noteReconnect(now);
  }
}

function combineSnapshots(
  symbol: string,
  spot: WindowSnapshot | null,
  perp: WindowSnapshot | null,
  window: WindowId,
): WindowSnapshot | null {
  if (!spot && !perp) return null;
  if (spot && !perp) return { ...spot, marketType: 'combined' };
  if (perp && !spot) return { ...perp, marketType: 'combined' };
  const a = spot!;
  const b = perp!;
  const buy = a.aggressiveBuyVolume + b.aggressiveBuyVolume;
  const sell = a.aggressiveSellVolume + b.aggressiveSellVolume;
  const total = buy + sell;
  const delta = buy - sell;
  const buyCount = a.buyTradeCount + b.buyTradeCount;
  const sellCount = a.sellTradeCount + b.sellTradeCount;
  const largeBuy = a.largeBuyVolume + b.largeBuyVolume;
  const largeSell = a.largeSellVolume + b.largeSellVolume;
  return {
    ...b,
    symbol,
    marketType: 'combined',
    window,
    aggressiveBuyVolume: buy,
    aggressiveSellVolume: sell,
    buyTradeCount: buyCount,
    sellTradeCount: sellCount,
    averageBuySize: buy / Math.max(1, buyCount),
    averageSellSize: sell / Math.max(1, sellCount),
    delta,
    deltaPercent: total === 0 ? 0 : delta / total,
    largeBuyVolume: largeBuy,
    largeSellVolume: largeSell,
    forcedBuyVolume: a.forcedBuyVolume + b.forcedBuyVolume,
    forcedSellVolume: a.forcedSellVolume + b.forcedSellVolume,
    largestBuy: Math.max(a.largestBuy, b.largestBuy),
    largestSell: Math.max(a.largestSell, b.largestSell),
    liquidityResponse: emptyLiquidityResponse(),
    netAggression: buildNetAggression({
      window,
      buyVolume: buy,
      sellVolume: sell,
      buyCount,
      sellCount,
      largeBuyVolume: largeBuy,
      largeSellVolume: largeSell,
      buyPercentile: Math.max(a.netAggression?.buyPercentile ?? 50, b.netAggression?.buyPercentile ?? 50),
      sellPercentile: Math.max(a.netAggression?.sellPercentile ?? 50, b.netAggression?.sellPercentile ?? 50),
      netMagnitudePercentile: Math.max(
        a.netAggression?.netPercentile ?? 50,
        b.netAggression?.netPercentile ?? 50,
      ),
    }),
  };
}

export type { AlertEvent };
