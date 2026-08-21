import type { MovePotentialConfig } from '../config/types.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { FlowLiquidityRatios, PressureLabel } from '../models/movement.js';

/**
 * BuyPressureRatio = aggressive buy flow / nearby ask liquidity, then scaled vs this asset's history.
 * Same for sells vs bids. Raw dollars are never compared across assets.
 */
export class FlowLiquidityRatio {
  private readonly buyHist: RollingDistribution;
  private readonly sellHist: RollingDistribution;
  private readonly netHist: RollingDistribution;

  constructor(
    private readonly config: MovePotentialConfig,
    sampleSize = 1_024,
  ) {
    this.buyHist = new RollingDistribution(sampleSize);
    this.sellHist = new RollingDistribution(sampleSize);
    this.netHist = new RollingDistribution(sampleSize);
  }

  measure(buyVolume: number, sellVolume: number, nearbyAsk: number, nearbyBid: number): FlowLiquidityRatios {
    const buyPressureRatio = nearbyAsk > 0 ? buyVolume / nearbyAsk : buyVolume > 0 ? 8 : 0;
    const sellPressureRatio = nearbyBid > 0 ? sellVolume / nearbyBid : sellVolume > 0 ? 8 : 0;
    const netFlow = buyVolume - sellVolume;

    if (buyVolume + sellVolume > 0) {
      this.buyHist.add(buyPressureRatio);
      this.sellHist.add(sellPressureRatio);
      this.netHist.add(netFlow);
    }

    const netMedian = this.netHist.median();
    return {
      buyPressureRatio,
      sellPressureRatio,
      buyPressurePercentile: this.buyHist.percentileRank(buyPressureRatio),
      sellPressurePercentile: this.sellHist.percentileRank(sellPressureRatio),
      buyLabel: this.label(buyPressureRatio),
      sellLabel: this.label(sellPressureRatio),
      netFlow,
      netFlowVsMedian: netMedian === 0 ? (netFlow === 0 ? 1 : 99) : netFlow / netMedian,
    };
  }

  seed(buyRatios: number[], sellRatios: number[]): void {
    for (const v of buyRatios) this.buyHist.add(v);
    for (const v of sellRatios) this.sellHist.add(v);
  }

  private label(ratio: number): PressureLabel {
    if (ratio >= this.config.pressureVeryStrong) return 'VERY_STRONG';
    if (ratio >= this.config.pressureStrong) return 'STRONG';
    if (ratio >= this.config.pressureModerate) return 'MODERATE';
    return 'VERY_WEAK';
  }
}
