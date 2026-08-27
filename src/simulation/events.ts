import type { SimulationMarketType } from './types.js';

export type SimulationEventKind =
  | 'trade'
  | 'book_snapshot'
  | 'book_delta'
  | 'oi'
  | 'funding'
  | 'liquidation';

export interface BookLevelQuote {
  price: number;
  quoteValue: number;
}

interface BaseEvent {
  seq: number;
  timestamp: number;
  symbol: string;
  marketType: SimulationMarketType;
}

export interface TradeSimEvent extends BaseEvent {
  kind: 'trade';
  price: number;
  quantity: number;
  quoteValue: number;
  side: 'BUY' | 'SELL';
  isForced?: boolean;
  tradeId?: string | number;
}

export interface BookSnapshotSimEvent extends BaseEvent {
  kind: 'book_snapshot';
  bids: BookLevelQuote[];
  asks: BookLevelQuote[];
}

export interface BookDeltaSimEvent extends BaseEvent {
  kind: 'book_delta';
  bids: BookLevelQuote[];
  asks: BookLevelQuote[];
}

export interface OiSimEvent extends BaseEvent {
  kind: 'oi';
  openInterest: number;
}

export interface FundingSimEvent extends BaseEvent {
  kind: 'funding';
  fundingRate: number;
}

export interface LiquidationSimEvent extends BaseEvent {
  kind: 'liquidation';
  type: 'LONG_LIQUIDATION' | 'SHORT_LIQUIDATION';
  price: number;
  quoteValue: number;
}

export type SimulationEvent =
  | TradeSimEvent
  | BookSnapshotSimEvent
  | BookDeltaSimEvent
  | OiSimEvent
  | FundingSimEvent
  | LiquidationSimEvent;

export class EventSequencer {
  private seq = 0;

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  reset(): void {
    this.seq = 0;
  }

  get value(): number {
    return this.seq;
  }
}

export function compareEvents(a: SimulationEvent, b: SimulationEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.seq - b.seq;
}

export function cloneEvent(event: SimulationEvent): SimulationEvent {
  return structuredClone(event);
}
