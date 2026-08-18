import type { LiquidationEvent } from '../models/trade.js';

export class LiquidationStream {
  private readonly handlers = new Set<(liq: LiquidationEvent) => void>();

  on(handler: (liq: LiquidationEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  push(liq: LiquidationEvent): void {
    for (const h of this.handlers) h(liq);
  }
}
