import { collectMetrics } from './conditions.js';
import type { DataCoverage, MetricId, Strategy } from './types.js';

const FOOTPRINT: ReadonlySet<MetricId> = new Set([
  'aggressiveBuy',
  'aggressiveSell',
  'aggressiveBuyPercentile',
  'aggressiveSellPercentile',
  'delta',
  'deltaPercent',
  'absDelta',
  'deltaPercentile',
  'cvd',
  'cvdSlope',
  'cvdDivergence',
  'executedVolume',
  'tradeCount',
  'avgTradeSize',
  'largeTradeVolume',
  'whaleTradeVolume',
  'buySellImbalance',
  'stackedBuyImbalance',
  'stackedSellImbalance',
  'footprintPoc',
  'buyerAbsorption',
  'sellerAbsorption',
  'absorptionStrength',
  'absorbedVolume',
  'absorptionDuration',
  'absorptionPercentile',
  'upsideEfficiency',
  'downsideEfficiency',
  'priceEfficiency',
  'upsideVacuum',
  'downsideVacuum',
  'vacuumStrength',
]);

const SPOT: ReadonlySet<MetricId> = new Set([
  'spotAggressiveBuy',
  'spotAggressiveSell',
  'spotDelta',
  'spotDeltaPercent',
  'spotCvd',
  'spotCvdSlope',
  'spotVolume',
  'spotBuySellImbalance',
  'spotPriceEfficiency',
  'spotAbsorption',
  'spotFuturesDeltaDiv',
  'spotLed',
  'futuresLed',
  'broadBuying',
  'broadSelling',
  'leverageDrivenRally',
  'leverageDrivenSelloff',
]);

const L2: ReadonlySet<MetricId> = new Set([
  'bidDepth',
  'askDepth',
  'bidDepthPercentile',
  'askDepthPercentile',
  'depthImbalance',
  'askConsumption',
  'bidConsumption',
  'askConsumptionRatio',
  'bidConsumptionRatio',
  'askReplenishment',
  'bidReplenishment',
  'askWithdrawal',
  'bidWithdrawal',
]);

const OI: ReadonlySet<MetricId> = new Set(['oi', 'oiChange']);
const FUNDING: ReadonlySet<MetricId> = new Set(['funding']);
const LIQ: ReadonlySet<MetricId> = new Set(['longLiquidations', 'shortLiquidations']);

export interface CoverageGate {
  warnings: string[];
  reject: boolean;
}

export function strategyMetrics(strategy: Strategy): MetricId[] {
  return [
    ...collectMetrics(strategy.longSetup),
    ...collectMetrics(strategy.longEntry),
    ...collectMetrics(strategy.shortSetup),
    ...collectMetrics(strategy.shortEntry),
    ...collectMetrics(strategy.context),
  ];
}

export function coverageGate(strategy: Strategy, coverage: DataCoverage): CoverageGate {
  const metrics = strategyMetrics(strategy);
  const warnings: string[] = [...coverage.warnings];
  let reject = false;

  const need = (ids: ReadonlySet<MetricId>, pct: number, label: string, hard: boolean) => {
    if (!metrics.some((m) => ids.has(m))) return;
    if (pct >= 50) return;
    const msg = `${label} coverage is ${pct.toFixed(0)}% but this strategy reads ${label.toLowerCase()} metrics.`;
    warnings.push(msg);
    if (hard && pct < 5) reject = true;
  };

  need(FOOTPRINT, coverage.trades, 'Trades / footprint', true);
  need(SPOT, coverage.spot, 'Spot', false);
  need(L2, coverage.l2, 'L2 book', false);
  need(OI, coverage.oi, 'Open interest', false);
  need(FUNDING, coverage.funding, 'Funding', false);
  need(LIQ, coverage.liquidations, 'Liquidations', false);

  if (reject) {
    warnings.push('Test rejected: required trade/footprint history is missing. Absorption, delta, and CVD conditions cannot be evaluated without it.');
  }
  return { warnings, reject };
}
