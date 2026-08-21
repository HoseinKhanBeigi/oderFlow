import type { EngineConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import { LiquidityDepthEngine } from '../liquidity/liquidity-depth-engine.js';
import { LiquidityDynamicsEngine } from '../liquidity/liquidity-dynamics-engine.js';
import { LiquidityVacuumDetector } from '../liquidity/liquidity-vacuum-detector.js';
import { LiquidityWallDetector } from '../liquidity/liquidity-wall-detector.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type { AbsorptionResult } from '../models/signals.js';
import type { LiquidityDynamicsSnapshot, LiquidityVacuum, LiquidityWall } from '../models/liquidity.js';
import type {
  DirectionAnalysis,
  LiquidityTarget,
  MovePotentialSnapshot,
  PathOfLeastResistance,
} from '../models/movement.js';
import type { PriceImpactEfficiency } from '../models/trade.js';
import { FlowLiquidityRatio } from './flow-liquidity-ratio.js';
import { TargetReachabilityEngine } from './target-reachability-engine.js';

export interface MovePotentialInput {
  symbol: string;
  book: LocalOrderBook;
  buyVolume: number;
  sellVolume: number;
  priceHigh: number;
  priceLow: number;
  impactEfficiency: PriceImpactEfficiency;
  absorption: AbsorptionResult;
  dataQualityScore: number;
}

export class MovePotentialEngine {
  readonly depth: LiquidityDepthEngine;
  readonly ratios: FlowLiquidityRatio;
  readonly reachability: TargetReachabilityEngine;
  readonly dynamics: LiquidityDynamicsEngine;
  readonly walls: LiquidityWallDetector;
  readonly vacuums: LiquidityVacuumDetector;
  private lastBuyDelta = 0;
  private lastSellDelta = 0;

  constructor(config: EngineConfig) {
    this.depth = new LiquidityDepthEngine(config.movePotential, config.historicalBaselineSamples);
    this.ratios = new FlowLiquidityRatio(config.movePotential, config.historicalBaselineSamples);
    this.reachability = new TargetReachabilityEngine(config.movePotential);
    this.dynamics = new LiquidityDynamicsEngine(60_000, config.historicalBaselineSamples);
    this.walls = new LiquidityWallDetector(config.movePotential, config.historicalBaselineSamples);
    this.vacuums = new LiquidityVacuumDetector(config.movePotential);
  }

  observe(now: number, book: LocalOrderBook, buyDelta: number, sellDelta: number): void {
    this.dynamics.observe(now, book, buyDelta, sellDelta);
    this.lastBuyDelta = this.dynamics.lastBuyFlowAvailable;
    this.lastSellDelta = this.dynamics.lastSellFlowAvailable;
  }

  evaluate(input: MovePotentialInput): MovePotentialSnapshot {
    const { book } = input;
    const currentPrice = book.mid();
    const dyn = this.dynamics.snapshot();
    if (book.empty() || currentPrice <= 0) {
      return emptySnapshot(input.symbol, currentPrice, input.impactEfficiency, input.dataQualityScore, dyn);
    }
    const map = this.depth.map(book, input.priceHigh, input.priceLow);
    const nearby = this.depth.nearby(book);
    const flow = this.ratios.measure(input.buyVolume, input.sellVolume, nearby.ask, nearby.bid);
    const wallScan = this.walls.detect(book, this.dynamics, this.lastBuyDelta, this.lastSellDelta);
    const vacuumScan = this.vacuums.detect(map.upside, map.downside);

    const quality = clamp(input.dataQualityScore, 0, 1);
    const buyAbs = input.absorption.detected && input.absorption.type === 'BUYER_ABSORPTION';
    const sellAbs = input.absorption.detected && input.absorption.type === 'SELLER_ABSORPTION';

    const upside = map.upside.map((target) =>
      this.scoreTarget('UP', target, input, flow, nearby.ask, map.atr, quality, buyAbs, dyn, wallScan.walls, vacuumScan.vacuums),
    );
    const downside = map.downside.map((target) =>
      this.scoreTarget('DOWN', target, input, flow, nearby.bid, map.atr, quality, sellAbs, dyn, wallScan.walls, vacuumScan.vacuums),
    );

    const upsidePotential = meanScore(upside.map((t) => t.reachabilityScore));
    const downsidePotential = meanScore(downside.map((t) => t.reachabilityScore));
    const direction = this.direction(flow.buyPressureRatio, flow.sellPressureRatio, quality);
    const path = this.path(upsidePotential, downsidePotential, direction.direction);
    const events = [...new Set([...wallScan.events, ...vacuumScan.events])];

    return {
      symbol: input.symbol,
      currentPrice,
      atr: map.atr,
      dataQualityScore: quality,
      direction,
      movePotential: { upsidePotential, downsidePotential },
      pathOfLeastResistance: path,
      flow,
      liquidity: {
        nearbyAskLiquidity: nearby.ask,
        nearbyBidLiquidity: nearby.bid,
        nearbyAskDensityClass: this.depth.classifyDensity(
          nearby.ask / Math.max(configNearbyPct(map.atr, currentPrice), 1e-6),
        ),
        nearbyBidDensityClass: this.depth.classifyDensity(
          nearby.bid / Math.max(configNearbyPct(map.atr, currentPrice), 1e-6),
        ),
        askConsumptionRate: dyn.askConsumptionRate,
        bidConsumptionRate: dyn.bidConsumptionRate,
        askReplenishmentRate: dyn.askReplenishmentRate,
        bidReplenishmentRate: dyn.bidReplenishmentRate,
        askPullRate: dyn.askPullRate,
        bidPullRate: dyn.bidPullRate,
        walls: wallScan.walls,
        vacuums: vacuumScan.vacuums,
        events,
      },
      targets: { upside, downside },
      priceImpactEfficiency: input.impactEfficiency,
      warnings: this.warnings(flow, nearby, buyAbs, sellAbs, input.impactEfficiency, path, dyn, events),
    };
  }

  private scoreTarget(
    side: 'UP' | 'DOWN',
    target: Parameters<TargetReachabilityEngine['score']>[0]['target'],
    input: MovePotentialInput,
    flow: MovePotentialSnapshot['flow'],
    opposingNearby: number,
    atr: number,
    quality: number,
    absorptionToward: boolean,
    dyn: LiquidityDynamicsSnapshot,
    walls: LiquidityWall[],
    vacuums: LiquidityVacuum[],
  ): LiquidityTarget {
    const askSide = side === 'UP';
    const lo = Math.min(input.book.mid(), target.price);
    const hi = Math.max(input.book.mid(), target.price);
    const wallAhead = walls.some((w) => {
      const match = askSide ? w.kind === 'ASK_LIQUIDITY_WALL' : w.kind === 'BID_LIQUIDITY_WALL';
      return match && w.status === 'ACTIVE' && w.price >= lo && w.price <= hi;
    });
    const vacuumAhead = vacuums.some((v) => {
      const match = askSide ? v.kind === 'UPSIDE_LIQUIDITY_VACUUM' : v.kind === 'DOWNSIDE_LIQUIDITY_VACUUM';
      const a = Math.min(v.fromPrice, v.toPrice);
      const b = Math.max(v.fromPrice, v.toPrice);
      return match && a >= lo && b <= hi + 1e-9;
    });

    return this.reachability.score({
      side,
      target,
      flowToward: askSide ? input.buyVolume : input.sellVolume,
      opposingNearby,
      pressureRatio: askSide ? flow.buyPressureRatio : flow.sellPressureRatio,
      pressurePercentile: askSide ? flow.buyPressurePercentile : flow.sellPressurePercentile,
      atr,
      impactEfficiency: input.impactEfficiency,
      absorptionToward,
      dataQualityScore: quality,
      consumptionEase: askSide ? dyn.askConsumptionNorm : dyn.bidConsumptionNorm,
      replenishmentDrag: askSide ? dyn.askReplenishmentNorm : dyn.bidReplenishmentNorm,
      pullEase: askSide ? dyn.askPullNorm : dyn.bidPullNorm,
      wallAhead,
      vacuumAhead,
    });
  }

  private direction(buy: number, sell: number, quality: number): DirectionAnalysis {
    const total = buy + sell;
    if (total <= 0.05) {
      return { direction: 'NEUTRAL', score: 50, confidence: 0.25 * quality };
    }
    const edge = (buy - sell) / Math.max(total, 1e-9);
    const band = 0.12;
    let direction: DirectionAnalysis['direction'] = 'NEUTRAL';
    if (edge > band) direction = 'UP';
    else if (edge < -band) direction = 'DOWN';
    const score = Math.round(clamp(50 + edge * 50, 0, 100));
    const confidence = clamp(Math.abs(edge) * quality, 0, 1);
    return { direction, score, confidence };
  }

  private path(up: number, down: number, bias: DirectionAnalysis['direction']): PathOfLeastResistance {
    if (Math.abs(up - down) < 8 && bias === 'NEUTRAL') return 'BALANCED';
    if (up >= down + 8) return 'UP';
    if (down >= up + 8) return 'DOWN';
    if (bias === 'UP') return 'UP';
    if (bias === 'DOWN') return 'DOWN';
    return 'BALANCED';
  }

  private warnings(
    flow: MovePotentialSnapshot['flow'],
    nearby: { ask: number; bid: number },
    buyAbs: boolean,
    sellAbs: boolean,
    efficiency: PriceImpactEfficiency,
    path: PathOfLeastResistance,
    dyn: LiquidityDynamicsSnapshot,
    events: MovePotentialSnapshot['liquidity']['events'],
  ): string[] {
    const out: string[] = [];
    if (flow.buyLabel === 'VERY_STRONG' && nearby.ask > 0 && flow.buyPressureRatio >= 1) {
      out.push('Current aggressive buy flow is sufficient relative to nearby displayed ask liquidity.');
    }
    if (flow.sellLabel === 'VERY_STRONG' && nearby.bid > 0 && flow.sellPressureRatio >= 1) {
      out.push('Current aggressive sell flow is sufficient relative to nearby displayed bid liquidity.');
    }
    if (nearby.ask > nearby.bid * 2) {
      out.push('Upside path currently has heavier displayed ask liquidity than bids below.');
    }
    if (nearby.bid > nearby.ask * 2) {
      out.push('Downside path currently has heavier displayed bid liquidity than asks above.');
    }
    if (buyAbs) out.push('Buyer absorption is active — upside reachability is reduced.');
    if (sellAbs) out.push('Seller absorption is active — downside reachability is reduced.');
    if (dyn.askReplenishmentNorm > 0.55 && flow.buyPressureRatio >= 0.6) {
      out.push('Ask liquidity is replenishing during aggressive buying (possible passive sell absorption).');
    }
    if (dyn.bidReplenishmentNorm > 0.55 && flow.sellPressureRatio >= 0.6) {
      out.push('Bid liquidity is replenishing during aggressive selling (possible passive buy absorption).');
    }
    if (events.includes('ASK_LIQUIDITY_PULLED')) {
      out.push('Ask liquidity was pulled rather than filled — upside path is easier.');
    }
    if (events.includes('BID_LIQUIDITY_PULLED')) {
      out.push('Bid liquidity was pulled rather than filled — downside path is easier.');
    }
    if (events.includes('UPSIDE_LIQUIDITY_VACUUM')) {
      out.push('Thin ask pocket detected above — a break could travel quickly through that region.');
    }
    if (events.includes('DOWNSIDE_LIQUIDITY_VACUUM')) {
      out.push('Thin bid pocket detected below — a break could travel quickly through that region.');
    }
    if (efficiency === 'LOW' && (flow.buyPressureRatio > 0.6 || flow.sellPressureRatio > 0.6)) {
      out.push('Aggressive flow is not producing a matching price response.');
    }
    if (path !== 'BALANCED') {
      out.push(`Continuation conditions toward ${path} are elevated, but not guaranteed.`);
    }
    return out;
  }
}

function meanScore(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

function configNearbyPct(atr: number, price: number): number {
  if (price <= 0) return 0.35;
  return Math.max(0.15, (atr / price) * 100 * 0.5);
}

function emptyDynamics(): LiquidityDynamicsSnapshot {
  return {
    askConsumptionRate: 0,
    bidConsumptionRate: 0,
    askReplenishmentRate: 0,
    bidReplenishmentRate: 0,
    askPullRate: 0,
    bidPullRate: 0,
    askConsumptionNorm: 0,
    bidConsumptionNorm: 0,
    askReplenishmentNorm: 0,
    bidReplenishmentNorm: 0,
    askPullNorm: 0,
    bidPullNorm: 0,
  };
}

function emptySnapshot(
  symbol: string,
  currentPrice: number,
  impactEfficiency: PriceImpactEfficiency,
  dataQualityScore: number,
  dyn: LiquidityDynamicsSnapshot = emptyDynamics(),
): MovePotentialSnapshot {
  return {
    symbol,
    currentPrice,
    atr: 0,
    dataQualityScore,
    direction: { direction: 'NEUTRAL', score: 50, confidence: 0 },
    movePotential: { upsidePotential: 0, downsidePotential: 0 },
    pathOfLeastResistance: 'BALANCED',
    flow: {
      buyPressureRatio: 0,
      sellPressureRatio: 0,
      buyPressurePercentile: 50,
      sellPressurePercentile: 50,
      buyLabel: 'VERY_WEAK',
      sellLabel: 'VERY_WEAK',
      netFlow: 0,
      netFlowVsMedian: 1,
    },
    liquidity: {
      nearbyAskLiquidity: 0,
      nearbyBidLiquidity: 0,
      nearbyAskDensityClass: 'THIN',
      nearbyBidDensityClass: 'THIN',
      askConsumptionRate: dyn.askConsumptionRate,
      bidConsumptionRate: dyn.bidConsumptionRate,
      askReplenishmentRate: dyn.askReplenishmentRate,
      bidReplenishmentRate: dyn.bidReplenishmentRate,
      askPullRate: dyn.askPullRate,
      bidPullRate: dyn.bidPullRate,
      walls: [],
      vacuums: [],
      events: [],
    },
    targets: { upside: [], downside: [] },
    priceImpactEfficiency: impactEfficiency,
    warnings: ['Order book unavailable — move potential is not scored.'],
  };
}
