import { and, cond, or } from './conditions.js';
import {
  DEFAULT_EXECUTION,
  DEFAULT_RISK,
  type RuleNode,
  type Strategy,
} from './types.js';

function strat(
  id: string,
  name: string,
  notes: string,
  rules: Pick<Strategy, 'longSetup' | 'longEntry' | 'shortSetup' | 'shortEntry' | 'context'>,
): Strategy {
  return {
    id,
    name,
    version: 1,
    createdAt: 0,
    notes,
    execution: { ...DEFAULT_EXECUTION },
    risk: { ...DEFAULT_RISK, takeProfits: [{ kind: 'FIXED_RR', value: 2, closePct: 1 }] },
    ...rules,
  };
}

const sellerAbsSetup: RuleNode = and(
  cond('aggressiveSell', 'percentile_above', 85),
  cond('bidReplenishment', '>=', 80),
  cond('bidWithdrawal', '<=', 30),
  cond('downsideEfficiency', '<=', 35),
  cond('sellerAbsorption', 'persists_for', 1, 2),
  cond('lowerLow', '=', 0),
);

const sellerAbsEntry: RuleNode = and(cond('spotDelta', 'turns_positive', 0), cond('chochBullish', '=', 1));

const buyerAbsSetup: RuleNode = and(
  cond('aggressiveBuy', 'percentile_above', 85),
  cond('askReplenishment', '>=', 80),
  cond('askWithdrawal', '<=', 30),
  cond('upsideEfficiency', '<=', 35),
  cond('buyerAbsorption', '>=', 1),
  cond('higherHigh', '=', 0),
);

const buyerAbsEntry: RuleNode = and(cond('spotDelta', 'turns_negative', 0), cond('chochBearish', '=', 1));

export const STRATEGY_PRESETS: Strategy[] = [
  strat(
    'STRONG_BUY_BREAKOUT',
    'Strong Buy Breakout',
    'Aggressive buying consumes asks, replenishment is weak, price is efficient, bullish BOS.',
    {
      longEntry: and(
        cond('aggressiveBuy', 'percentile_above', 85),
        cond('spotDelta', '>', 0),
        cond('cvdSlope', '>', 0),
        cond('askConsumption', 'percentile_above', 75),
        cond('askReplenishment', '<=', 40),
        cond('askWithdrawal', '>=', 60),
        cond('priceEfficiency', '>=', 75),
        cond('bosBullish', '=', 1),
      ),
    },
  ),
  strat(
    'SELLER_ABSORPTION',
    'Seller Absorption Reversal',
    'Heavy selling absorbed by passive bids, then spot delta flips and micro CHoCH confirms the long.',
    { longSetup: sellerAbsSetup, longEntry: sellerAbsEntry },
  ),
  strat(
    'BUYER_ABSORPTION',
    'Buyer Absorption Reversal',
    'Heavy buying absorbed by passive offers, then spot delta flips and bearish CHoCH confirms the short.',
    { shortSetup: buyerAbsSetup, shortEntry: buyerAbsEntry },
  ),
  strat(
    'UPSIDE_LIQUIDITY_VACUUM',
    'Upside Liquidity Vacuum',
    'Asks withdraw, depth is thin, displacement expands. Context, not an automatic long.',
    {
      context: and(cond('upsideVacuum', '=', 1), cond('askWithdrawal', '>=', 60)),
      longEntry: and(cond('upsideVacuum', '=', 1), cond('aggressiveBuy', 'percentile_above', 70), cond('bosBullish', '=', 1)),
    },
  ),
  strat(
    'DOWNSIDE_LIQUIDITY_VACUUM',
    'Downside Liquidity Vacuum',
    'Bids withdraw and displacement expands to the downside.',
    {
      context: and(cond('downsideVacuum', '=', 1), cond('bidWithdrawal', '>=', 60)),
      shortEntry: and(cond('downsideVacuum', '=', 1), cond('aggressiveSell', 'percentile_above', 70), cond('bosBearish', '=', 1)),
    },
  ),
  strat(
    'SHORT_SQUEEZE',
    'Short Squeeze',
    'Forced buy + short liquidations + rising price. Uses liquidation fields when the feed has them.',
    {
      context: and(cond('shortLiquidations', '>', 0), cond('priceMovePct', '>', 0)),
      longEntry: and(cond('shortLiquidations', '>', 0), cond('aggressiveBuy', 'percentile_above', 75), cond('priceMovePct', '>', 0.05)),
    },
  ),
  strat(
    'LONG_SQUEEZE',
    'Long Squeeze',
    'Forced sell + long liquidations + falling price.',
    {
      context: and(cond('longLiquidations', '>', 0), cond('priceMovePct', '<', 0)),
      shortEntry: and(cond('longLiquidations', '>', 0), cond('aggressiveSell', 'percentile_above', 75), cond('priceMovePct', '<', -0.05)),
    },
  ),
  strat(
    'FAKE_BREAKOUT',
    'Fake Breakout',
    'Break of structure that fails to follow through — fade the failed break.',
    {
      shortEntry: and(cond('failedBreakout', '=', 1), cond('buyerAbsorption', '>=', 1), cond('chochBearish', '=', 1)),
      longEntry: and(cond('failedBreakout', '=', 1), cond('sellerAbsorption', '>=', 1), cond('chochBullish', '=', 1)),
    },
  ),
  strat(
    'BALANCED_MARKET',
    'Balanced Market',
    'Diagnostic: both sides active, no directional edge. No automatic entries.',
    {
      context: and(
        cond('aggressiveBuy', 'percentile_below', 70),
        cond('aggressiveSell', 'percentile_below', 70),
        cond('buyerAbsorption', '=', 0),
        cond('sellerAbsorption', '=', 0),
      ),
    },
  ),
  strat(
    'SPOT_LED_RALLY',
    'Spot-led Rally',
    'Spot delta leads futures. Long only with bullish structure confirmation.',
    {
      longEntry: and(cond('spotLed', '=', 1), cond('spotDelta', '>', 0), cond('cvdSlope', '>', 0), cond('bosBullish', '=', 1)),
    },
  ),
  strat(
    'FUTURES_LED_RALLY',
    'Futures-led Rally',
    'Futures aggression leads. Treated as context unless structure confirms.',
    {
      context: cond('futuresLed', '=', 1),
      longEntry: and(cond('futuresLed', '=', 1), cond('bosBullish', '=', 1), cond('priceEfficiency', '>=', 60)),
    },
  ),
  strat(
    'SPOT_FUTURES_DIVERGENCE',
    'Spot/Futures Divergence Reversal',
    'Spot and futures deltas disagree; fade the futures-only move when spot does not confirm.',
    {
      longEntry: and(cond('spotDelta', 'turns_positive', 0), cond('futuresDelta', '<', 0), cond('chochBullish', '=', 1)),
      shortEntry: and(cond('spotDelta', 'turns_negative', 0), cond('futuresDelta', '>', 0), cond('chochBearish', '=', 1)),
    },
  ),
  strat(
    'OI_EXPANSION_BREAKOUT',
    'OI Expansion Breakout',
    'Open interest rising with efficient directional flow.',
    {
      longEntry: and(cond('oiChange', '>', 0.05), cond('aggressiveBuy', 'percentile_above', 80), cond('bosBullish', '=', 1)),
      shortEntry: and(cond('oiChange', '>', 0.05), cond('aggressiveSell', 'percentile_above', 80), cond('bosBearish', '=', 1)),
    },
  ),
  strat(
    'OI_UNWIND_REVERSAL',
    'OI Unwind Reversal',
    'OI contracting after a directional push — covering / unwind.',
    {
      longEntry: and(cond('oiChange', '<', -0.05), cond('sellerAbsorption', '>=', 1), cond('chochBullish', '=', 1)),
      shortEntry: and(cond('oiChange', '<', -0.05), cond('buyerAbsorption', '>=', 1), cond('chochBearish', '=', 1)),
    },
  ),
  strat(
    'LIQUIDATION_CASCADE',
    'Liquidation Cascade',
    'Liquidation-driven displacement. Context plus optional continuation entry.',
    {
      context: or(cond('shortLiquidations', '>', 0), cond('longLiquidations', '>', 0)),
      longEntry: and(cond('shortLiquidations', '>', 0), cond('upsideVacuum', '=', 1)),
      shortEntry: and(cond('longLiquidations', '>', 0), cond('downsideVacuum', '=', 1)),
    },
  ),
  strat(
    'CVD_DIVERGENCE',
    'CVD Divergence',
    'Price makes an extreme the cumulative delta does not confirm.',
    {
      longEntry: and(cond('cvdDivergence', '=', 1), cond('chochBullish', '=', 1)),
      shortEntry: and(cond('cvdDivergence', '=', -1), cond('chochBearish', '=', 1)),
    },
  ),
  strat(
    'PASSIVE_BUYER_DEFENSE',
    'Passive Buyer Defense',
    'Bids replenish under sell pressure — same family as seller absorption.',
    { longSetup: sellerAbsSetup, longEntry: sellerAbsEntry },
  ),
  strat(
    'PASSIVE_SELLER_DEFENSE',
    'Passive Seller Defense',
    'Asks replenish under buy pressure — same family as buyer absorption.',
    { shortSetup: buyerAbsSetup, shortEntry: buyerAbsEntry },
  ),
];

export function listStrategyPresets(): Strategy[] {
  return STRATEGY_PRESETS.map(cloneStrategy);
}

export function getStrategyPreset(id: string): Strategy {
  const found = STRATEGY_PRESETS.find((s) => s.id === id) ?? STRATEGY_PRESETS[1]!;
  return cloneStrategy(found);
}

export function cloneStrategy(s: Strategy): Strategy {
  return structuredClone(s);
}

export function emptyCustomStrategy(): Strategy {
  return strat('custom', 'Custom strategy', 'Edit conditions in the builder.', {
    longEntry: and(cond('aggressiveSell', 'percentile_above', 85), cond('sellerAbsorption', '>=', 1)),
  });
}
