import type { MovePotentialConfig } from '../config/types.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import { safeDiv } from '../core/integrity.js';
import type {
  LiquidityDensityClass,
  LiquidityDistanceMap,
  UnscoredLiquidityTarget,
} from '../models/movement.js';
import type { LocalOrderBook } from './local-order-book.js';
import { LiquidityTargetGenerator } from '../movement/liquidity-target-generator.js';
import { atrFromRange, distancePercent } from '../movement/math.js';

export class LiquidityDepthEngine {
  private readonly askNotionalHist: RollingDistribution;
  private readonly bidNotionalHist: RollingDistribution;
  private readonly densityHist: RollingDistribution;
  private readonly generator: LiquidityTargetGenerator;

  constructor(
    private readonly config: MovePotentialConfig,
    sampleSize = 1_024,
  ) {
    this.askNotionalHist = new RollingDistribution(sampleSize);
    this.bidNotionalHist = new RollingDistribution(sampleSize);
    this.densityHist = new RollingDistribution(sampleSize);
    this.generator = new LiquidityTargetGenerator(config);
  }

  observeBook(book: LocalOrderBook): void {
    if (book.empty()) return;
    const mid = book.mid();
    const nearbyAsk = book.notionalWithin('ask', mid, this.config.nearbyBandPct);
    const nearbyBid = book.notionalWithin('bid', mid, this.config.nearbyBandPct);
    if (nearbyAsk > 0) this.askNotionalHist.add(nearbyAsk);
    if (nearbyBid > 0) this.bidNotionalHist.add(nearbyBid);
  }

  map(book: LocalOrderBook, priceHigh = 0, priceLow = 0): LiquidityDistanceMap {
    const currentPrice = book.mid();
    const atr = atrFromRange(currentPrice, priceHigh, priceLow, this.config.minAtrPctOfPrice);
    if (currentPrice <= 0 || book.empty()) {
      return { currentPrice, atr, upside: [], downside: [] };
    }

    this.observeBook(book);

    const upside = this.generator.prices(currentPrice, atr, 'UP').map((price) =>
      this.target(book, currentPrice, price, 'ask'),
    );
    const downside = this.generator.prices(currentPrice, atr, 'DOWN').map((price) =>
      this.target(book, currentPrice, price, 'bid'),
    );
    return { currentPrice, atr, upside, downside };
  }

  nearby(book: LocalOrderBook): { ask: number; bid: number } {
    const mid = book.mid();
    return {
      ask: book.notionalWithin('ask', mid, this.config.nearbyBandPct),
      bid: book.notionalWithin('bid', mid, this.config.nearbyBandPct),
    };
  }

  classifyDensity(density: number): LiquidityDensityClass {
    const median = this.densityHist.median();
    if (median <= 0) {
      if (density <= 0) return 'THIN';
      return 'NORMAL';
    }
    const ratio = density / median;
    if (ratio < this.config.densityThinRatio) return 'THIN';
    if (ratio >= this.config.densityExtremeRatio) return 'EXTREMELY_THICK';
    if (ratio >= this.config.densityThickRatio) return 'THICK';
    return 'NORMAL';
  }

  private target(
    book: LocalOrderBook,
    currentPrice: number,
    price: number,
    side: 'ask' | 'bid',
  ): UnscoredLiquidityTarget {
    const cumulativeLiquidity = book.notionalBetween(side, currentPrice, price);
    const distPct = Math.abs(distancePercent(currentPrice, price));
    const liquidityDensity = safeDiv(cumulativeLiquidity, Math.max(distPct, 1e-6));
    if (liquidityDensity > 0) this.densityHist.add(liquidityDensity);

    const hist = side === 'ask' ? this.askNotionalHist : this.bidNotionalHist;
    const relativeLiquidity = hist.size > 4 ? hist.ratioToMedian(cumulativeLiquidity) : 1;
    const difficultyScore = hist.size > 4 ? hist.percentileRank(cumulativeLiquidity) : 50;

    return {
      price,
      distancePercent: side === 'ask' ? distPct : -distPct,
      cumulativeLiquidity,
      liquidityDensity,
      relativeLiquidity: Number.isFinite(relativeLiquidity) ? relativeLiquidity : 1,
      difficultyScore,
      densityClass: this.classifyDensity(liquidityDensity),
    };
  }
}
