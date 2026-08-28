/**
 * Microstructure backtest / forward-test lab types.
 *
 * Causal rule: at timestamp T the strategy may only read information
 * known at or before T. Outcome metrics (forward returns, MAE/MFE) are
 * measured after the fact and must never feed the next decision.
 */

export type LabMode = 'BACKTEST' | 'REPLAY' | 'FORWARD_TEST' | 'WALK_FORWARD';
export type TradeDirection = 'LONG' | 'SHORT';
export type FillModel = 'OPTIMISTIC' | 'REALISTIC' | 'CONSERVATIVE';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type StopKind =
  | 'FIXED_PCT'
  | 'ATR'
  | 'SWING'
  | 'LIQUIDITY'
  | 'ABSORPTION'
  | 'STRUCTURE'
  | 'TRAILING'
  | 'TIME';
export type TakeProfitKind = 'FIXED_RR' | 'FIXED_PCT' | 'ATR' | 'LIQUIDITY' | 'SWING' | 'TRAILING';
export type SizingKind = 'FIXED_DOLLAR' | 'FIXED_QTY' | 'PCT_EQUITY' | 'RISK';
export type PercentileWindowId = '100' | '500' | '1000' | '1d' | '7d' | '30d';
export type StructureShift =
  | 'BULLISH_CHOCH'
  | 'BEARISH_CHOCH'
  | 'BULLISH_BOS'
  | 'BEARISH_BOS'
  | 'NONE';
export type StructureBias = 'HH_HL' | 'LH_LL' | 'HH_LL' | 'LH_HL' | 'NONE';
export type EffortVsResult =
  | 'EFFICIENT_BUYING'
  | 'INEFFICIENT_BUYING'
  | 'BUYER_ABSORPTION'
  | 'EFFICIENT_SELLING'
  | 'INEFFICIENT_SELLING'
  | 'SELLER_ABSORPTION'
  | 'BALANCED'
  | 'INSUFFICIENT';
export type CvdDivergence = 'BULLISH' | 'BEARISH' | 'NONE';
export type CrossLead = 'SPOT' | 'FUTURES' | 'BROAD' | 'NONE';
export type SignalKind =
  | 'LONG_SETUP'
  | 'LONG_ENTRY'
  | 'LONG_EXIT'
  | 'LONG_STOP'
  | 'SHORT_SETUP'
  | 'SHORT_ENTRY'
  | 'SHORT_EXIT'
  | 'SHORT_STOP'
  | 'ABSORPTION'
  | 'LIQUIDITY_VACUUM'
  | 'SHORT_SQUEEZE'
  | 'LONG_SQUEEZE'
  | 'LEVERAGE_DRIVEN_RALLY'
  | 'LEVERAGE_DRIVEN_SELLOFF'
  | 'CONTEXT';

export type ConditionOperator =
  | '>'
  | '>='
  | '<'
  | '<='
  | '='
  | '!='
  | 'crosses_above'
  | 'crosses_below'
  | 'increases'
  | 'decreases'
  | 'turns_positive'
  | 'turns_negative'
  | 'percentile_above'
  | 'percentile_below'
  | 'changes_by_pct'
  | 'persists_for';

export type MetricId =
  | 'price'
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'aggressiveBuy'
  | 'aggressiveSell'
  | 'aggressiveBuyPercentile'
  | 'aggressiveSellPercentile'
  | 'delta'
  | 'deltaPercent'
  | 'absDelta'
  | 'deltaPercentile'
  | 'cvd'
  | 'cvdSlope'
  | 'cvdDivergence'
  | 'executedVolume'
  | 'tradeCount'
  | 'avgTradeSize'
  | 'largeTradeVolume'
  | 'whaleTradeVolume'
  | 'buySellImbalance'
  | 'stackedBuyImbalance'
  | 'stackedSellImbalance'
  | 'footprintPoc'
  | 'spotAggressiveBuy'
  | 'spotAggressiveSell'
  | 'spotDelta'
  | 'spotDeltaPercent'
  | 'spotCvd'
  | 'spotCvdSlope'
  | 'spotVolume'
  | 'spotBuySellImbalance'
  | 'spotPriceEfficiency'
  | 'spotAbsorption'
  | 'futuresAggressiveBuy'
  | 'futuresAggressiveSell'
  | 'futuresDelta'
  | 'futuresCvd'
  | 'bidDepth'
  | 'askDepth'
  | 'bidDepthPercentile'
  | 'askDepthPercentile'
  | 'depthImbalance'
  | 'askConsumption'
  | 'bidConsumption'
  | 'askConsumptionRatio'
  | 'bidConsumptionRatio'
  | 'askReplenishment'
  | 'bidReplenishment'
  | 'askWithdrawal'
  | 'bidWithdrawal'
  | 'buyerAbsorption'
  | 'sellerAbsorption'
  | 'absorptionStrength'
  | 'absorbedVolume'
  | 'absorptionDuration'
  | 'absorptionPercentile'
  | 'priceMovePct'
  | 'priceDisplacement'
  | 'displacementPercentile'
  | 'upsideEfficiency'
  | 'downsideEfficiency'
  | 'priceEfficiency'
  | 'atr'
  | 'realizedVol'
  | 'upsideVacuum'
  | 'downsideVacuum'
  | 'vacuumStrength'
  | 'spotFuturesDeltaDiv'
  | 'spotLed'
  | 'futuresLed'
  | 'broadBuying'
  | 'broadSelling'
  | 'leverageDrivenRally'
  | 'leverageDrivenSelloff'
  | 'swingHigh'
  | 'swingLow'
  | 'higherHigh'
  | 'higherLow'
  | 'lowerHigh'
  | 'lowerLow'
  | 'bosBullish'
  | 'bosBearish'
  | 'chochBullish'
  | 'chochBearish'
  | 'distanceFromSupport'
  | 'distanceFromResistance'
  | 'failedBreakout'
  | 'dataQuality'
  | 'oi'
  | 'oiChange'
  | 'funding'
  | 'longLiquidations'
  | 'shortLiquidations';

export interface Condition {
  type: 'cond';
  metric: MetricId;
  op: ConditionOperator;
  value: number;
  /** For persists_for: bars the inner comparison must hold. */
  persistBars?: number;
}

export interface ConditionGroup {
  type: 'group';
  bool: 'AND' | 'OR';
  not?: boolean;
  children: RuleNode[];
}

export type RuleNode = Condition | ConditionGroup;

export interface TakeProfitLevel {
  kind: TakeProfitKind;
  value: number;
  closePct: number;
}

export interface ExecutionConfig {
  orderType: OrderType;
  fillModel: FillModel;
  limitOffsetBps: number;
  limitPrice?: number;
  conservativeBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  slippageBps: number;
  latencyMs: number;
}

export interface RiskConfig {
  stopKind: StopKind;
  stopValue: number;
  takeProfits: TakeProfitLevel[];
  timeStopBars?: number;
  sizing: SizingKind;
  accountEquity: number;
  riskPct: number;
  fixedDollar: number;
  fixedQty: number;
}

export interface Strategy {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  notes?: string;
  longSetup?: RuleNode;
  longEntry?: RuleNode;
  shortSetup?: RuleNode;
  shortEntry?: RuleNode;
  /** Context-only rules — logged, never auto-enter. */
  context?: RuleNode;
  execution: ExecutionConfig;
  risk: RiskConfig;
}

export interface MarketBar {
  /** Bar open, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  aggressiveBuy: number;
  aggressiveSell: number;
  trades: number;
  buyTrades: number;
  sellTrades: number;
  largestBuy: number;
  largestSell: number;
  levels: Array<{ price: number; buy: number; sell: number }>;
  hasFootprint: boolean;
  hasBook: boolean;
  spotBuy: number;
  spotSell: number;
  futuresBuy: number;
  futuresSell: number;
  bidDepth: number | null;
  askDepth: number | null;
  bidReplenishment: number | null;
  askReplenishment: number | null;
  bidWithdrawal: number | null;
  askWithdrawal: number | null;
  oi: number | null;
  oiChange: number | null;
  funding: number | null;
  longLiquidations: number | null;
  shortLiquidations: number | null;
}

export interface StructureState {
  swingHigh: number | null;
  swingLow: number | null;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  bias: StructureBias;
  shift: StructureShift;
  /** Unix seconds of the confirmed swing high bar. */
  swingHighTime: number | null;
  swingLowTime: number | null;
}

export interface FeatureSnapshot {
  timestamp: number;
  barTime: number;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;

  aggressiveBuy: number;
  aggressiveSell: number;
  buyPercentile: number;
  sellPercentile: number;

  delta: number;
  deltaPercent: number;
  absDelta: number;
  deltaPercentile: number;

  cvd: number;
  cvdSlope: number;
  cvdDivergence: CvdDivergence;

  executedVolume: number;
  tradeCount: number;
  avgTradeSize: number;
  largeTradeVolume: number;
  whaleTradeVolume: number;
  buySellImbalance: number;
  stackedBuyImbalance: number;
  stackedSellImbalance: number;
  footprintPoc: number;

  spotDelta: number;
  spotCvd: number;
  spotCvdSlope: number;
  futuresDelta: number;
  futuresCvd: number;

  askDepth: number;
  bidDepth: number;
  askConsumption: number;
  bidConsumption: number;
  askReplenishment: number;
  bidReplenishment: number;
  askWithdrawal: number;
  bidWithdrawal: number;

  buyerAbsorption: number;
  sellerAbsorption: number;
  absorptionStrength: number;
  absorbedVolume: number;
  absorptionDuration: number;
  absorptionPercentile: number;

  priceMovePct: number;
  priceDisplacement: number;
  displacementPercentile: number;
  upsideEfficiency: number;
  downsideEfficiency: number;
  priceEfficiency: number;
  effortVsResult: EffortVsResult;
  atr: number;
  realizedVol: number;

  upsideVacuum: number;
  downsideVacuum: number;
  vacuumStrength: number;

  spotLed: number;
  futuresLed: number;
  broadBuying: number;
  broadSelling: number;
  leverageDrivenRally: number;
  leverageDrivenSelloff: number;

  oi: number;
  oiChange: number;
  funding: number;
  longLiquidations: number;
  shortLiquidations: number;

  volatility: number;
  structure: StructureState;
  dataQuality: number;
  hasFootprint: boolean;
  hasBook: boolean;
}

export interface SignalEvidence {
  label: string;
  value: string;
  percentile?: number;
}

export interface LabSignal {
  id: string;
  kind: SignalKind;
  strategy: string;
  strategyVersion: number;
  timestamp: number;
  barTime: number;
  price: number;
  score: number;
  confidence: number;
  snapshot: FeatureSnapshot;
  evidence: SignalEvidence[];
  traded: boolean;
  forwardReturns: Record<string, number | null>;
}

export interface LabTrade {
  id: string;
  signalId: string;
  strategy: string;
  strategyVersion: number;
  direction: TradeDirection;
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  stopPrice: number;
  targetPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  r: number;
  mae: number;
  mfe: number;
  maePct: number;
  mfePct: number;
  fees: number;
  slippage: number;
  durationBars: number;
  confidence: number;
  exitReason: string | null;
  evidence: SignalEvidence[];
  open: boolean;
}

export interface DataCoverage {
  candles: number;
  trades: number;
  l2: number;
  oi: number;
  funding: number;
  liquidations: number;
  spot: number;
  futures: number;
  fromSec: number;
  toSec: number;
  barCount: number;
  warnings: string[];
}

export interface PerformanceStats {
  netPnl: number;
  grossPnl: number;
  returnPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  averageR: number;
  medianR: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  feesPaid: number;
  estimatedSlippage: number;
  sampleSize: number;
  insufficientSample: boolean;
}

export interface SignalTypeStats {
  kind: string;
  trades: number;
  winRate: number;
  avgR: number;
  netPnl: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdownPct: number;
}

export interface WalkForwardSplit {
  is: PerformanceStats | null;
  oos: PerformanceStats | null;
  overfitting: boolean;
}

export interface BacktestResult {
  mode: LabMode;
  strategy: Strategy;
  coverage: DataCoverage;
  stats: PerformanceStats;
  bySignalType: SignalTypeStats[];
  trades: LabTrade[];
  signals: LabSignal[];
  equity: EquityPoint[];
  snapshots: FeatureSnapshot[];
  walkForward?: WalkForwardSplit;
  elapsedMs: number;
  eventsProcessed: number;
}

export interface BacktestRunConfig {
  mode: LabMode;
  tfMinutes: number;
  percentileWindow: PercentileWindowId;
  minDataQuality: number;
  /** First timestamp that may emit entries. Earlier bars are warmup only. */
  signalFromSec?: number;
  isFromSec?: number;
  isToSec?: number;
  oosFromSec?: number;
  oosToSec?: number;
}

export const FORWARD_HORIZONS_MIN = [1, 5, 15, 30, 60, 240, 720, 1440] as const;
export type ForwardHorizonMin = (typeof FORWARD_HORIZONS_MIN)[number];

export const DEFAULT_EXECUTION: ExecutionConfig = {
  orderType: 'MARKET',
  fillModel: 'REALISTIC',
  limitOffsetBps: 0,
  conservativeBps: 2,
  makerFeeBps: 2,
  takerFeeBps: 4,
  slippageBps: 1,
  latencyMs: 150,
};

export const DEFAULT_RISK: RiskConfig = {
  stopKind: 'ATR',
  stopValue: 1.5,
  takeProfits: [{ kind: 'FIXED_RR', value: 2, closePct: 1 }],
  sizing: 'RISK',
  accountEquity: 100_000,
  riskPct: 0.5,
  fixedDollar: 10_000,
  fixedQty: 0.1,
};
