import { clamp, safeDiv } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { SpotAbsorptionSnapshot } from './types.js';

export interface AbsorptionEvidence {
  buyVolume: number;
  sellVolume: number;
  delta: number;
  priceChangePercent: number;
  buyNearAskShare: number;
  sellNearBidShare: number;
  askReplenishment: number | null;
  bidReplenishment: number | null;
  hasBook: boolean;
}

/**
 * Passive absorption needs price stall *and* preferably book evidence.
 * Large aggressive volume alone is never enough.
 */
export class SpotAbsorptionDetector {
  private readonly absDelta = new RollingDistribution(256);
  private readonly absMove = new RollingDistribution(256);

  observe(absDelta: number, absMovePct: number): void {
    if (absDelta > 0) this.absDelta.add(absDelta);
    if (absMovePct > 0) this.absMove.add(absMovePct);
  }

  detect(input: AbsorptionEvidence): SpotAbsorptionSnapshot {
    const total = input.buyVolume + input.sellVolume;
    const empty: SpotAbsorptionSnapshot = {
      detected: false,
      type: null,
      confidence: 0,
      usedBookEvidence: false,
    };
    if (total <= 0) return empty;

    const absDelta = Math.abs(input.delta);
    const absMove = Math.abs(input.priceChangePercent);
    const deltaRank = this.absDelta.size >= 8 ? this.absDelta.percentileRank(absDelta) : 50;
    const moveRank = this.absMove.size >= 8 ? this.absMove.percentileRank(absMove) : 50;
    const largeFlow = deltaRank >= 65;
    const littleDisplacement = moveRank <= 40 || absMove < 0.02;

    const nearAsk = input.buyNearAskShare >= 0.55;
    const nearBid = input.sellNearBidShare >= 0.55;
    const askRepl = (input.askReplenishment ?? 0) >= 0.35;
    const bidRepl = (input.bidReplenishment ?? 0) >= 0.35;
    const bookOk = input.hasBook;

    // Seller absorption: aggressive buying absorbed by passive sellers.
    if (input.delta > 0 && largeFlow && littleDisplacement && input.priceChangePercent <= 0.08) {
      const touch = nearAsk || askRepl;
      if (!touch) return empty;
      const usedBook = bookOk && (nearAsk || askRepl);
      const confidence = clamp(
        0.45 +
          (nearAsk ? 0.15 : 0) +
          (askRepl ? 0.15 : 0) +
          (littleDisplacement ? 0.1 : 0) +
          (deltaRank >= 80 ? 0.1 : 0),
        0,
        1,
      );
      if (confidence < 0.55) return empty;
      return {
        detected: true,
        type: 'PASSIVE_SELL_ABSORPTION',
        confidence,
        usedBookEvidence: usedBook,
      };
    }

    // Buyer absorption: aggressive selling absorbed by passive buyers.
    if (input.delta < 0 && largeFlow && littleDisplacement && input.priceChangePercent >= -0.08) {
      const touch = nearBid || bidRepl;
      if (!touch) return empty;
      const usedBook = bookOk && (nearBid || bidRepl);
      const confidence = clamp(
        0.45 +
          (nearBid ? 0.15 : 0) +
          (bidRepl ? 0.15 : 0) +
          (littleDisplacement ? 0.1 : 0) +
          (deltaRank >= 80 ? 0.1 : 0),
        0,
        1,
      );
      if (confidence < 0.55) return empty;
      return {
        detected: true,
        type: 'PASSIVE_BUY_ABSORPTION',
        confidence,
        usedBookEvidence: usedBook,
      };
    }

    return empty;
  }
}

export function nearTouchShare(executedNear: number, sideVolume: number): number {
  return safeDiv(executedNear, sideVolume);
}
