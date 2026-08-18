import { formatQuote, formatTapeTime } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type { TapeEntry, TapeFilter } from '../models/flow.js';
import type { RelativeSizeClass } from '../models/trade.js';

export class LargeTradeTape {
  private readonly ring: RingBuffer<TapeEntry>;

  constructor(capacity: number) {
    this.ring = new RingBuffer(capacity);
  }

  push(entry: TapeEntry): void {
    this.ring.push(entry);
  }

  query(filter: TapeFilter = {}): TapeEntry[] {
    const out: TapeEntry[] = [];
    for (const e of this.ring.values()) {
      if (filter.symbol && e.symbol !== filter.symbol) continue;
      if (filter.side && e.side !== filter.side) continue;
      if (filter.minQuoteValue !== undefined && e.quoteValue < filter.minQuoteValue) continue;
      if (filter.fromTimestamp !== undefined && e.timestamp < filter.fromTimestamp) continue;
      if (filter.toTimestamp !== undefined && e.timestamp > filter.toTimestamp) continue;
      if (
        filter.minRelativePercentile !== undefined &&
        relativeFloor(e.relativeClass) < filter.minRelativePercentile
      ) {
        continue;
      }
      out.push(e);
    }
    return out;
  }

  format(filter: TapeFilter = {}): string {
    const rows = this.query(filter);
    const header = 'TIME       SIDE    PRICE       SIZE';
    const lines = rows.map((e) => {
      const time = formatTapeTime(e.timestamp).padEnd(10);
      const side = e.side.padEnd(7);
      const price = e.price.toFixed(2).padEnd(12);
      return `${time}${side}${price}${formatQuote(e.quoteValue)}`;
    });
    return [header, ...lines].join('\n');
  }
}

function relativeFloor(cls: RelativeSizeClass): number {
  switch (cls) {
    case 'EXTREME':
      return 99.9;
    case 'VERY_LARGE':
      return 99;
    case 'LARGE':
      return 95;
    default:
      return 0;
  }
}
