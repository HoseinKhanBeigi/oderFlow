import type {
  DeltaAnalysis,
  LiquidityDepthView,
  MarketMechanics,
  PercentileBandConfig,
  WhyFact,
} from '../models/liquidity-response.js';
import { mechanicsInterpretation } from './mechanics.js';
import { percentileBand, percentileTooltip } from './percentile-band.js';
import { changeTooltip } from './side-response.js';

export interface WhyBuildInput {
  buy: number;
  buyPct: number;
  sell: number;
  sellPct: number;
  delta: DeltaAnalysis;
  ask: LiquidityDepthView;
  bid: LiquidityDepthView;
  movePct: number;
  priceMovePercent: number;
  mechanics: MarketMechanics;
  bands: PercentileBandConfig;
}

export function buildWhy(input: WhyBuildInput): WhyFact[] {
  const facts: WhyFact[] = [];
  const buyBand = percentileBand(input.buyPct, input.bands);
  facts.push({
    label: 'Aggressive Buying',
    value: `${buyBand} · ${Math.round(input.buyPct)}th percentile`,
    percentile: input.buyPct,
    band: buyBand,
    tooltip: percentileTooltip(input.buyPct),
    detail: `Current aggressive buying is stronger than only ${Math.round(input.buyPct)}% of comparable historical observations.`,
  });

  const dir =
    input.delta.direction === 'BALANCED'
      ? 'balanced'
      : input.delta.direction === 'BUY'
        ? 'BUY dominated'
        : 'SELL dominated';
  facts.push({
    label: 'Delta',
    value: `${fmtUsd(input.delta.delta)} · ${dir} · ${Math.round(input.delta.absoluteDeltaPercentile)}th percentile magnitude`,
    percentile: input.delta.absoluteDeltaPercentile,
    tooltip: percentileTooltip(input.delta.absoluteDeltaPercentile),
  });

  const askChange =
    input.ask.changePercent == null
      ? `UNKNOWN${input.ask.changeReason ? ` · ${input.ask.changeReason.replace(/_/g, ' ')}` : ''}`
      : `${input.ask.changePercent >= 0 ? '+' : ''}${input.ask.changePercent.toFixed(0)}%`;
  facts.push({
    label: 'Current Ask Liquidity',
    value: `${fmtUsd(input.ask.current)} · ${Math.round(input.ask.currentPercentile)}th percentile`,
    percentile: input.ask.currentPercentile,
    tooltip: percentileTooltip(input.ask.currentPercentile),
  });
  facts.push({
    label: 'Ask Liquidity Change',
    value: askChange,
    tooltip: changeTooltip(input.ask.changePercent, input.ask.changeReason),
  });
  if (input.ask.removed > 0 && input.ask.changeState !== 'UNKNOWN') {
    facts.push({
      label: 'Ask Removal',
      value: `${input.ask.changeState.replace(/_/g, ' ')} · consumed ${fmtUsd(input.ask.consumed)} · cancelled ${fmtUsd(input.ask.cancelled)}`,
    });
  }

  const moveBand = percentileBand(input.movePct, input.bands);
  facts.push({
    label: 'Price Displacement',
    value: `${moveBand} · ${Math.round(input.movePct)}th percentile · ${input.priceMovePercent >= 0 ? '+' : ''}${input.priceMovePercent.toFixed(2)}%`,
    percentile: input.movePct,
    band: moveBand,
    tooltip: percentileTooltip(input.movePct),
  });

  facts.push({
    label: 'Interpretation',
    value: mechanicsInterpretation(input.mechanics),
  });

  return facts.slice(0, 7);
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `${sign}$${(a / 1_000_000_000).toFixed(1)}B`;
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}
