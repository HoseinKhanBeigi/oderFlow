import type { ExchangeId } from '../exchange/venues.js';
import type { LiquidationEvent, MarketTrade, OrderBookSnapshot } from '../models/trade.js';
import { EventSequencer, type SimulationEvent } from './events.js';
import { MarketSimulationEngine } from './market-simulation-engine.js';
import { CrossMarketSimulationEngine } from './cross-market-engine.js';
import { ReplayEngine } from './replay-engine.js';
import type {
  CrossMarketSimulationState,
  MarketSimulationState,
  SimulationChannel,
  SimulationMarketType,
} from './types.js';

export interface HubBook {
  symbol: string;
  bids: Array<{ price: number; quoteValue: number }>;
  asks: Array<{ price: number; quoteValue: number }>;
}

/**
 * Consumes the application's already-normalized streams.
 * Does not open its own exchange connections.
 */
export class SimulationHub {
  private readonly engines = new Map<string, MarketSimulationEngine>();
  private readonly combined = new Map<string, CrossMarketSimulationEngine>();
  private readonly logs = new Map<string, ReplayEngine>();
  private readonly sequencer = new EventSequencer();
  private readonly lastEmit = new Map<string, number>();

  key(symbol: string, market: SimulationMarketType): string {
    return `${market}:${symbol}`;
  }

  engine(symbol: string, market: SimulationMarketType): MarketSimulationEngine {
    const k = this.key(symbol, market);
    let engine = this.engines.get(k);
    if (!engine) {
      engine = new MarketSimulationEngine({
        symbol,
        marketType: market,
        fillMode: 'print',
      });
      engine.mode = 'realtime';
      this.engines.set(k, engine);
    }
    return engine;
  }

  cross(symbol: string): CrossMarketSimulationEngine {
    let engine = this.combined.get(symbol);
    if (!engine) {
      engine = new CrossMarketSimulationEngine({
        symbol,
        spot: this.engine(symbol, 'spot'),
        futures: this.engine(symbol, 'perp'),
      });
      this.combined.set(symbol, engine);
    }
    return engine;
  }

  log(symbol: string, market: SimulationMarketType): ReplayEngine {
    const k = this.key(symbol, market);
    let replay = this.logs.get(k);
    if (!replay) {
      replay = new ReplayEngine({ capacity: 20_000 });
      this.logs.set(k, replay);
    }
    return replay;
  }

  ingestTrade(trade: MarketTrade, _exchange?: ExchangeId): void {
    const market: SimulationMarketType = trade.marketType === 'spot' ? 'spot' : 'perp';
    const event: SimulationEvent = {
      kind: 'trade',
      seq: this.sequencer.next(),
      timestamp: trade.timestamp,
      symbol: trade.symbol,
      marketType: market,
      price: trade.price,
      quantity: trade.quantity,
      quoteValue: trade.quoteValue,
      side: trade.side,
      isForced: Boolean(trade.isForced),
      tradeId: trade.tradeId,
    };
    this.push(event);
  }

  ingestBook(snapshot: OrderBookSnapshot | (HubBook & { marketType?: SimulationMarketType; timestamp?: number })): void {
    const market: SimulationMarketType = 'marketType' in snapshot && snapshot.marketType === 'spot' ? 'spot' : 'perp';
    const event: SimulationEvent = {
      kind: 'book_snapshot',
      seq: this.sequencer.next(),
      timestamp: 'timestamp' in snapshot && snapshot.timestamp ? snapshot.timestamp : Date.now(),
      symbol: snapshot.symbol,
      marketType: market,
      bids: snapshot.bids.map((l) => ({
        price: l.price,
        quoteValue: 'quoteValue' in l ? l.quoteValue : 0,
      })),
      asks: snapshot.asks.map((l) => ({
        price: l.price,
        quoteValue: 'quoteValue' in l ? l.quoteValue : 0,
      })),
    };
    this.push(event);
  }

  ingestLiquidation(liq: LiquidationEvent): void {
    this.push({
      kind: 'liquidation',
      seq: this.sequencer.next(),
      timestamp: liq.timestamp,
      symbol: liq.symbol,
      marketType: liq.marketType === 'spot' ? 'spot' : 'perp',
      type: liq.type,
      price: liq.price,
      quoteValue: liq.quoteValue,
    });
  }

  ingestOi(symbol: string, openInterest: number, timestamp = Date.now()): void {
    this.push({
      kind: 'oi',
      seq: this.sequencer.next(),
      timestamp,
      symbol,
      marketType: 'perp',
      openInterest,
    });
  }

  ingestFunding(symbol: string, fundingRate: number, timestamp = Date.now()): void {
    this.push({
      kind: 'funding',
      seq: this.sequencer.next(),
      timestamp,
      symbol,
      marketType: 'perp',
      fundingRate,
    });
  }

  tick(symbol: string, market: SimulationMarketType, now = Date.now()): MarketSimulationState {
    return this.engine(symbol, market).tick(now);
  }

  tickCombined(symbol: string, now = Date.now()): CrossMarketSimulationState {
    return this.cross(symbol).tick(now);
  }

  snapshot(symbol: string, channel: SimulationChannel, now = Date.now()): MarketSimulationState | CrossMarketSimulationState {
    if (channel === 'combined') return this.tickCombined(symbol, now);
    return this.tick(symbol, channel === 'spot' ? 'spot' : 'perp', now);
  }

  shouldEmit(symbol: string, market: string, minIntervalMs = 80): boolean {
    const k = `${market}:${symbol}`;
    const last = this.lastEmit.get(k) ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) return false;
    this.lastEmit.set(k, now);
    return true;
  }

  private push(event: SimulationEvent): void {
    this.log(event.symbol, event.marketType).record(event);
    this.engine(event.symbol, event.marketType).ingest(event);
  }
}
