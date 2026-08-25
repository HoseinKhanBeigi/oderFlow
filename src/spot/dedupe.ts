/**
 * Drop duplicate prints from the same venue (reconnect replay, dual-channel overlap).
 * Cross-exchange aggregation still sums distinct venue executions — those are not duplicates.
 */
export class TradeDeduper {
  private readonly keys: string[];
  private write = 0;
  private filled = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly capacity: number) {
    this.keys = new Array(capacity);
  }

  accept(exchange: string, symbol: string, tradeId: string | number | undefined): boolean {
    if (tradeId === undefined || tradeId === '') return true;
    const key = `${exchange}|${symbol}|${tradeId}`;
    if (this.seen.has(key)) return false;
    if (this.filled === this.capacity) {
      const evicted = this.keys[this.write];
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    this.keys[this.write] = key;
    this.write = (this.write + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
    this.seen.add(key);
    return true;
  }
}
