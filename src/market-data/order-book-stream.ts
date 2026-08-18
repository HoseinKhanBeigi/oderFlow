import type { OrderBookDelta, OrderBookSnapshot } from '../models/trade.js';

export class OrderBookStream {
  private readonly snapshots = new Set<(s: OrderBookSnapshot) => void>();
  private readonly deltas = new Set<(d: OrderBookDelta) => void>();

  onSnapshot(handler: (s: OrderBookSnapshot) => void): () => void {
    this.snapshots.add(handler);
    return () => this.snapshots.delete(handler);
  }

  onDelta(handler: (d: OrderBookDelta) => void): () => void {
    this.deltas.add(handler);
    return () => this.deltas.delete(handler);
  }

  pushSnapshot(snapshot: OrderBookSnapshot): void {
    for (const h of this.snapshots) h(snapshot);
  }

  pushDelta(delta: OrderBookDelta): void {
    for (const h of this.deltas) h(delta);
  }
}
