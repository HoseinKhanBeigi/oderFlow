import { formatQuote } from '../core/integrity.js';
import { percentileBand, percentileTooltip } from '../liquidity-response/percentile-band.js';
import type { PercentileBandConfig, WhyFact } from '../models/liquidity-response.js';
import type {
  LiquidityZone,
  PassiveLiquidityMarketState,
  PassiveSideMetrics,
} from '../models/passive-liquidity.js';

export interface WhyInput {
  state: PassiveLiquidityMarketState;
  bid: PassiveSideMetrics;
  ask: PassiveSideMetrics;
  aggressiveBuyNotional: number;
  aggressiveSellNotional: number;
  aggressiveBuyPercentile: number;
  aggressiveSellPercentile: number;
  upsideDisplacementPercentile: number;
  downsideDisplacementPercentile: number;
  priceChangePercent: number;
  nearImbalance: number;
  floor: LiquidityZone | null;
  ceiling: LiquidityZone | null;
  passiveBuyerStrength: number;
  passiveSellerStrength: number;
  dataQuality: number;
  dataTrustworthy: boolean;
  dataQualityReasons: string[];
  bands: PercentileBandConfig;
}

function fact(
  label: string,
  value: string,
  percentile: number | undefined,
  bands: PercentileBandConfig,
  detail?: string,
): WhyFact {
  if (percentile === undefined) return { label, value, detail };
  return {
    label,
    value,
    percentile,
    band: percentileBand(percentile, bands),
    tooltip: percentileTooltip(percentile),
    detail,
  };
}

/**
 * Every state has to show its work. These are the measurements the
 * classification was actually made from, not a post-hoc narrative.
 */
export function buildWhy(input: WhyInput): WhyFact[] {
  const { bands } = input;
  const sellersActive = input.aggressiveSellPercentile >= input.aggressiveBuyPercentile;

  const facts: WhyFact[] = [
    fact(
      'Aggressive Sell',
      formatQuote(input.aggressiveSellNotional),
      input.aggressiveSellPercentile,
      bands,
    ),
    fact(
      'Aggressive Buy',
      formatQuote(input.aggressiveBuyNotional),
      input.aggressiveBuyPercentile,
      bands,
    ),
    fact(
      'Bid Consumption',
      formatQuote(input.bid.consumedNotional),
      input.bid.consumedPercentile,
      bands,
    ),
    fact(
      'Ask Consumption',
      formatQuote(input.ask.consumedNotional),
      input.ask.consumedPercentile,
      bands,
    ),
    fact(
      'Bid Replenishment',
      formatQuote(input.bid.replenishedNotional),
      input.bid.replenishedPercentile,
      bands,
      `ratio ${input.bid.replenishmentRatio.toFixed(2)} of consumed`,
    ),
    fact(
      'Ask Replenishment',
      formatQuote(input.ask.replenishedNotional),
      input.ask.replenishedPercentile,
      bands,
      `ratio ${input.ask.replenishmentRatio.toFixed(2)} of consumed`,
    ),
    fact(
      'Bid Withdrawal',
      formatQuote(input.bid.cancelledNotional),
      input.bid.cancelledPercentile,
      bands,
    ),
    fact(
      'Ask Withdrawal',
      formatQuote(input.ask.cancelledNotional),
      input.ask.cancelledPercentile,
      bands,
    ),
    fact(
      sellersActive ? 'Downside Efficiency' : 'Upside Efficiency',
      `${input.priceChangePercent.toFixed(3)}%`,
      sellersActive ? input.downsideDisplacementPercentile : input.upsideDisplacementPercentile,
      bands,
      'price displacement per unit of aggression',
    ),
    fact('Near Bid Depth', formatQuote(input.bid.nearDepthNotional), input.bid.nearDepthPercentile, bands),
    fact('Near Ask Depth', formatQuote(input.ask.nearDepthNotional), input.ask.nearDepthPercentile, bands),
    fact(
      'Bid Persistence',
      `${Math.round(input.bid.persistenceScore)}/100`,
      undefined,
      bands,
      'notional-weighted level persistence',
    ),
    fact(
      'Ask Persistence',
      `${Math.round(input.ask.persistenceScore)}/100`,
      undefined,
      bands,
      'notional-weighted level persistence',
    ),
    fact(
      'Passive Buyer Strength',
      `${Math.round(input.passiveBuyerStrength)}/100`,
      undefined,
      bands,
    ),
    fact(
      'Passive Seller Strength',
      `${Math.round(input.passiveSellerStrength)}/100`,
      undefined,
      bands,
    ),
    fact(
      'Near Book Imbalance',
      input.nearImbalance.toFixed(2),
      undefined,
      bands,
      '-1 ask dominance, +1 bid dominance',
    ),
  ];

  const structure = input.floor ?? input.ceiling;
  if (structure) {
    facts.push(
      fact(
        'Defended Tests',
        `${structure.defendedTests} of ${structure.testCount}`,
        undefined,
        bands,
        `${structure.state} between ${structure.priceMin} and ${structure.priceMax}`,
      ),
    );
  }

  facts.push(
    fact('Data Quality', `${Math.round(input.dataQuality)}/100`, undefined, bands),
    fact('Interpretation', interpret(input), undefined, bands),
  );
  return facts;
}

function interpret(input: WhyInput): string {
  switch (input.state) {
    case 'BUYER_ABSORPTION':
      return 'Aggressive sellers kept hitting bids while passive buyers replenished the liquidity they consumed, and price produced progressively weaker downside displacement.';
    case 'SELLER_ABSORPTION':
      return 'Aggressive buyers kept lifting asks while passive sellers replenished the liquidity they consumed, and price failed to extend higher.';
    case 'UPSIDE_LIQUIDITY_VACUUM':
      return 'Near ask depth is unusually thin, ask liquidity is being withdrawn rather than replenished, and modest buying is producing outsized upward displacement.';
    case 'DOWNSIDE_LIQUIDITY_VACUUM':
      return 'Near bid depth is unusually thin, bid liquidity is being withdrawn rather than replenished, and modest selling is producing outsized downward displacement.';
    case 'BUILDING_FLOOR':
      return 'Sellers repeatedly attacked the same region while passive buyers replenished liquidity and price failed to extend lower.';
    case 'BUILDING_CEILING':
      return 'Buyers repeatedly attacked the same region while passive sellers replenished liquidity and price failed to extend higher.';
    case 'PASSIVE_BUYERS_DEFENDING':
      return 'Bid liquidity is persistent and replenishing with low withdrawal, so passive buyers are currently the stronger passive side.';
    case 'PASSIVE_SELLERS_DEFENDING':
      return 'Ask liquidity is persistent and replenishing with low withdrawal, so passive sellers are currently the stronger passive side.';
    case 'BUYERS_EXPANDING':
      return 'Aggressive buying is consuming ask liquidity faster than it is replaced and price is advancing with it.';
    case 'SELLERS_EXPANDING':
      return 'Aggressive selling is consuming bid liquidity faster than it is replaced and price is declining with it.';
    case 'BALANCED':
      return 'Passive liquidity is close to symmetric near the touch with no side clearly consuming or withdrawing.';
    case 'NO_DIRECTIONAL_EDGE':
      // Untrustworthy data and a genuinely featureless book both land here, and
      // conflating them would tell the reader to distrust a healthy feed.
      return input.dataTrustworthy
        ? 'No passive liquidity condition stands out against this market\'s own history: consumption, replenishment and withdrawal are all near typical levels, so there is nothing to act on rather than something being hidden.'
        : `Passive liquidity cannot be classified because the data is not trustworthy (quality ${Math.round(input.dataQuality)}/100${input.dataQualityReasons.length ? `: ${input.dataQualityReasons.join('; ')}` : ''}).`;
    default:
      return 'Evidence is insufficient to classify passive liquidity behaviour.';
  }
}
