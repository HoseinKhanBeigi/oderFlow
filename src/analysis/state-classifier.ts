import type { ExhaustionConfig, VacuumConfig } from '../config/types.js';
import type { AbsorptionResult } from '../models/signals.js';
import type {
  AccelerationLabel,
  MarketState,
  PriceImpactEfficiency,
  WindowId,
} from '../models/trade.js';
import { WINDOW_MS } from '../models/trade.js';

export interface StateInput {
  window: WindowId;
  absorption: AbsorptionResult;
  buyBurst: boolean;
  sellBurst: boolean;
  persistentBuy: boolean;
  persistentSell: boolean;
  largeBuy: boolean;
  largeSell: boolean;
  flowMultipleBuy: number;
  flowMultipleSell: number;
  buyPressure: number;
  sellPressure: number;
  priceChangePercent: number;
  impactEfficiency: PriceImpactEfficiency;
  accelerationBuy: AccelerationLabel;
  accelerationSell: AccelerationLabel;
  priorAccelerationBuy: AccelerationLabel;
  priorAccelerationSell: AccelerationLabel;
}

const IMPACT_RANK: Record<PriceImpactEfficiency, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  EXTREME: 3,
};

const ACCEL_RANK: Record<AccelerationLabel, number> = {
  NONE: 0,
  DECELERATING: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3,
};

export class StateClassifier {
  constructor(
    private readonly vacuum: VacuumConfig,
    private readonly exhaustion: ExhaustionConfig,
  ) {}

  classify(input: StateInput): MarketState {
    if (input.absorption.detected && input.absorption.type === 'BUYER_ABSORPTION') {
      return 'BUYER_ABSORPTION';
    }
    if (input.absorption.detected && input.absorption.type === 'SELLER_ABSORPTION') {
      return 'SELLER_ABSORPTION';
    }

    if (this.vacuumUp(input)) return 'LIQUIDITY_VACUUM_UP';
    if (this.vacuumDown(input)) return 'LIQUIDITY_VACUUM_DOWN';

    if (this.exhaustionBuy(input)) return 'FLOW_EXHAUSTION_BUY';
    if (this.exhaustionSell(input)) return 'FLOW_EXHAUSTION_SELL';

    const shortWindow = WINDOW_MS[input.window] <= 10_000;
    if (shortWindow && input.buyBurst) return 'BUY_BURST';
    if (shortWindow && input.sellBurst) return 'SELL_BURST';

    if (input.persistentBuy) return 'PERSISTENT_BUY_FLOW';
    if (input.persistentSell) return 'PERSISTENT_SELL_FLOW';

    if (input.buyBurst) return 'BUY_BURST';
    if (input.sellBurst) return 'SELL_BURST';

    if (input.largeBuy) return 'LARGE_BUY_FLOW';
    if (input.largeSell) return 'LARGE_SELL_FLOW';

    return 'NO_SIGNAL';
  }

  private vacuumUp(input: StateInput): boolean {
    return (
      input.buyPressure >= this.vacuum.minPressure &&
      input.priceChangePercent >= this.vacuum.minPriceChangePercent &&
      input.flowMultipleBuy <= this.vacuum.maxFlowMultiple &&
      IMPACT_RANK[input.impactEfficiency] >= IMPACT_RANK[this.vacuum.minImpact]
    );
  }

  private vacuumDown(input: StateInput): boolean {
    return (
      input.sellPressure >= this.vacuum.minPressure &&
      input.priceChangePercent <= -this.vacuum.minPriceChangePercent &&
      input.flowMultipleSell <= this.vacuum.maxFlowMultiple &&
      IMPACT_RANK[input.impactEfficiency] >= IMPACT_RANK[this.vacuum.minImpact]
    );
  }

  private exhaustionBuy(input: StateInput): boolean {
    return (
      ACCEL_RANK[input.priorAccelerationBuy] >= ACCEL_RANK[this.exhaustion.requiredPriorAcceleration] &&
      input.accelerationBuy === 'DECELERATING' &&
      (input.largeBuy || input.persistentBuy)
    );
  }

  private exhaustionSell(input: StateInput): boolean {
    return (
      ACCEL_RANK[input.priorAccelerationSell] >= ACCEL_RANK[this.exhaustion.requiredPriorAcceleration] &&
      input.accelerationSell === 'DECELERATING' &&
      (input.largeSell || input.persistentSell)
    );
  }
}
