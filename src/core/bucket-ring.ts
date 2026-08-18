export interface FlowBucket {
  startMs: number;
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  largestBuy: number;
  largestSell: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  forcedBuyVolume: number;
  forcedSellVolume: number;
  priceOpen: number;
  priceHigh: number;
  priceLow: number;
  priceClose: number;
}

export interface WindowAggregate {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  largestBuy: number;
  largestSell: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  forcedBuyVolume: number;
  forcedSellVolume: number;
  priceOpen: number;
  priceHigh: number;
  priceLow: number;
  priceClose: number;
  bucketCount: number;
}

const EMPTY: WindowAggregate = {
  buyVolume: 0,
  sellVolume: 0,
  buyCount: 0,
  sellCount: 0,
  largestBuy: 0,
  largestSell: 0,
  largeBuyVolume: 0,
  largeSellVolume: 0,
  forcedBuyVolume: 0,
  forcedSellVolume: 0,
  priceOpen: 0,
  priceHigh: 0,
  priceLow: 0,
  priceClose: 0,
  bucketCount: 0,
};

function emptyBucket(startMs: number): FlowBucket {
  return {
    startMs,
    buyVolume: 0,
    sellVolume: 0,
    buyCount: 0,
    sellCount: 0,
    largestBuy: 0,
    largestSell: 0,
    largeBuyVolume: 0,
    largeSellVolume: 0,
    forcedBuyVolume: 0,
    forcedSellVolume: 0,
    priceOpen: 0,
    priceHigh: 0,
    priceLow: 0,
    priceClose: 0,
  };
}

/**
 * Fixed-size ring of time buckets. Window queries sum a contiguous range of buckets.
 */
export class BucketRing {
  private readonly buckets: FlowBucket[];
  private filled = 0;
  private lastIndex = -1;
  private lastStart = Number.NaN;

  constructor(
    readonly bucketMs: number,
    readonly maxBuckets: number,
  ) {
    this.buckets = Array.from({ length: maxBuckets }, () => emptyBucket(0));
  }

  bucketStart(timestamp: number): number {
    return Math.floor(timestamp / this.bucketMs) * this.bucketMs;
  }

  add(
    timestamp: number,
    side: 'BUY' | 'SELL',
    quoteValue: number,
    price: number,
    isLarge: boolean,
    isForced: boolean,
  ): void {
    const start = this.bucketStart(timestamp);
    const bucket = this.ensureBucket(start);
    if (!bucket) return;

    if (bucket.buyCount + bucket.sellCount === 0 && bucket.priceOpen === 0) {
      bucket.priceOpen = price;
      bucket.priceHigh = price;
      bucket.priceLow = price;
    } else {
      if (bucket.priceOpen === 0) bucket.priceOpen = price;
      if (price > bucket.priceHigh) bucket.priceHigh = price;
      if (bucket.priceLow === 0 || price < bucket.priceLow) bucket.priceLow = price;
    }
    bucket.priceClose = price;

    if (side === 'BUY') {
      bucket.buyVolume += quoteValue;
      bucket.buyCount += 1;
      if (quoteValue > bucket.largestBuy) bucket.largestBuy = quoteValue;
      if (isLarge) bucket.largeBuyVolume += quoteValue;
      if (isForced) bucket.forcedBuyVolume += quoteValue;
    } else {
      bucket.sellVolume += quoteValue;
      bucket.sellCount += 1;
      if (quoteValue > bucket.largestSell) bucket.largestSell = quoteValue;
      if (isLarge) bucket.largeSellVolume += quoteValue;
      if (isForced) bucket.forcedSellVolume += quoteValue;
    }
  }

  touchPrice(timestamp: number, price: number): void {
    if (price <= 0) return;
    const start = this.bucketStart(timestamp);
    const bucket = this.ensureBucket(start);
    if (!bucket) return;
    if (bucket.priceOpen === 0) {
      bucket.priceOpen = price;
      bucket.priceHigh = price;
      bucket.priceLow = price;
    } else {
      if (price > bucket.priceHigh) bucket.priceHigh = price;
      if (bucket.priceLow === 0 || price < bucket.priceLow) bucket.priceLow = price;
    }
    bucket.priceClose = price;
  }

  aggregate(fromMs: number, toMs: number): WindowAggregate {
    if (this.filled === 0) return { ...EMPTY };

    const fromStart = this.bucketStart(fromMs);
    const toStart = this.bucketStart(Math.max(toMs - 1, fromMs));
    const out: WindowAggregate = { ...EMPTY };
    let opened = false;

    const steps = Math.min(
      this.maxBuckets,
      Math.max(0, Math.floor((toStart - fromStart) / this.bucketMs) + 1),
    );

    for (let i = 0; i < steps; i++) {
      const start = fromStart + i * this.bucketMs;
      const bucket = this.getBucket(start);
      if (!bucket) continue;
      if (bucket.buyCount + bucket.sellCount === 0 && bucket.priceOpen === 0) continue;

      out.buyVolume += bucket.buyVolume;
      out.sellVolume += bucket.sellVolume;
      out.buyCount += bucket.buyCount;
      out.sellCount += bucket.sellCount;
      out.largeBuyVolume += bucket.largeBuyVolume;
      out.largeSellVolume += bucket.largeSellVolume;
      out.forcedBuyVolume += bucket.forcedBuyVolume;
      out.forcedSellVolume += bucket.forcedSellVolume;
      if (bucket.largestBuy > out.largestBuy) out.largestBuy = bucket.largestBuy;
      if (bucket.largestSell > out.largestSell) out.largestSell = bucket.largestSell;
      out.bucketCount += 1;

      if (!opened) {
        out.priceOpen = bucket.priceOpen;
        out.priceHigh = bucket.priceHigh;
        out.priceLow = bucket.priceLow;
        opened = true;
      } else {
        if (bucket.priceHigh > out.priceHigh) out.priceHigh = bucket.priceHigh;
        if (bucket.priceLow > 0 && (out.priceLow === 0 || bucket.priceLow < out.priceLow)) {
          out.priceLow = bucket.priceLow;
        }
      }
      out.priceClose = bucket.priceClose || out.priceClose;
    }

    return out;
  }

  latestPrice(): number {
    if (this.lastIndex < 0) return 0;
    return this.buckets[this.lastIndex]?.priceClose ?? 0;
  }

  buyVolumesForLastN(n: number, now: number): number[] {
    const values: number[] = [];
    const current = this.bucketStart(now);
    for (let i = n - 1; i >= 0; i--) {
      const start = current - i * this.bucketMs;
      const bucket = this.getBucket(start);
      values.push(bucket?.buyVolume ?? 0);
    }
    return values;
  }

  sellVolumesForLastN(n: number, now: number): number[] {
    const values: number[] = [];
    const current = this.bucketStart(now);
    for (let i = n - 1; i >= 0; i--) {
      const start = current - i * this.bucketMs;
      const bucket = this.getBucket(start);
      values.push(bucket?.sellVolume ?? 0);
    }
    return values;
  }

  private ensureBucket(startMs: number): FlowBucket | null {
    if (Number.isNaN(this.lastStart)) {
      this.lastStart = startMs;
      this.lastIndex = 0;
      this.buckets[0] = emptyBucket(startMs);
      this.filled = 1;
      return this.buckets[0];
    }

    if (startMs === this.lastStart) {
      return this.buckets[this.lastIndex] ?? null;
    }

    if (startMs < this.lastStart) {
      return this.getBucket(startMs) ?? null;
    }

    const gap = Math.floor((startMs - this.lastStart) / this.bucketMs);
    if (gap >= this.maxBuckets) {
      this.buckets.forEach((_, i) => {
        this.buckets[i] = emptyBucket(0);
      });
      this.lastStart = startMs;
      this.lastIndex = 0;
      this.buckets[0] = emptyBucket(startMs);
      this.filled = 1;
      return this.buckets[0];
    }

    for (let i = 0; i < gap; i++) {
      this.lastIndex = (this.lastIndex + 1) % this.maxBuckets;
      const nextStart = this.lastStart + this.bucketMs;
      this.buckets[this.lastIndex] = emptyBucket(nextStart);
      this.lastStart = nextStart;
      if (this.filled < this.maxBuckets) this.filled += 1;
    }
    return this.buckets[this.lastIndex] ?? null;
  }

  private getBucket(startMs: number): FlowBucket | undefined {
    if (this.filled === 0 || Number.isNaN(this.lastStart)) return undefined;
    const offset = Math.round((this.lastStart - startMs) / this.bucketMs);
    if (offset < 0 || offset >= this.filled) return undefined;
    const index = (this.lastIndex - offset + this.maxBuckets) % this.maxBuckets;
    const bucket = this.buckets[index];
    return bucket?.startMs === startMs ? bucket : undefined;
  }
}
