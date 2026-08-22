import { RingBuffer } from '../core/ring-buffer.js';

interface LiqTick {
  timestamp: number;
  bid: number;
  ask: number;
  bidAdded: number;
  askAdded: number;
  bidRemoved: number;
  askRemoved: number;
}

export interface PassiveWindowTotals {
  bidLiquidityAdded: number;
  askLiquidityAdded: number;
  bidLiquidityRemoved: number;
  askLiquidityRemoved: number;
  bidLiquidityInitial: number;
  askLiquidityInitial: number;
  bidLiquidityFinal: number;
  askLiquidityFinal: number;
}

/**
 * Tracks displayed nearby bid/ask notional path.
 * Added/removed here is book change, not the same as executed passive volume.
 */
export class PassiveFlowEngine {
  private readonly ticks: RingBuffer<LiqTick>;
  private lastBid = 0;
  private lastAsk = 0;
  private primed = false;

  constructor(capacity = 4_096) {
    this.ticks = new RingBuffer(capacity);
  }

  observe(timestamp: number, bid: number, ask: number): void {
    const bidAdded = this.primed ? Math.max(0, bid - this.lastBid) : 0;
    const askAdded = this.primed ? Math.max(0, ask - this.lastAsk) : 0;
    const bidRemoved = this.primed ? Math.max(0, this.lastBid - bid) : 0;
    const askRemoved = this.primed ? Math.max(0, this.lastAsk - ask) : 0;
    this.ticks.push({
      timestamp,
      bid,
      ask,
      bidAdded,
      askAdded,
      bidRemoved,
      askRemoved,
    });
    this.lastBid = bid;
    this.lastAsk = ask;
    this.primed = true;
  }

  window(now: number, windowMs: number): PassiveWindowTotals {
    const start = now - windowMs;
    let bidAdded = 0;
    let askAdded = 0;
    let bidRemoved = 0;
    let askRemoved = 0;
    let bidInitial = 0;
    let askInitial = 0;
    let bidFinal = this.lastBid;
    let askFinal = this.lastAsk;
    let first = true;
    for (const tick of this.ticks.toArray()) {
      if (tick.timestamp < start || tick.timestamp > now) continue;
      if (first) {
        bidInitial = tick.bid - tick.bidAdded + tick.bidRemoved;
        askInitial = tick.ask - tick.askAdded + tick.askRemoved;
        first = false;
      }
      bidAdded += tick.bidAdded;
      askAdded += tick.askAdded;
      bidRemoved += tick.bidRemoved;
      askRemoved += tick.askRemoved;
      bidFinal = tick.bid;
      askFinal = tick.ask;
    }
    return {
      bidLiquidityAdded: bidAdded,
      askLiquidityAdded: askAdded,
      bidLiquidityRemoved: bidRemoved,
      askLiquidityRemoved: askRemoved,
      bidLiquidityInitial: Math.max(0, bidInitial),
      askLiquidityInitial: Math.max(0, askInitial),
      bidLiquidityFinal: bidFinal,
      askLiquidityFinal: askFinal,
    };
  }

  reset(): void {
    this.ticks.clear();
    this.lastBid = 0;
    this.lastAsk = 0;
    this.primed = false;
  }
}
