export type {
  BacktestResult,
  BacktestRunConfig,
  Condition,
  ConditionGroup,
  DataCoverage,
  ExecutionConfig,
  FeatureSnapshot,
  LabMode,
  LabSignal,
  LabTrade,
  MarketBar,
  MetricId,
  PerformanceStats,
  RiskConfig,
  RuleNode,
  SignalEvidence,
  Strategy,
} from './types.js';
export {
  DEFAULT_EXECUTION,
  DEFAULT_RISK,
  FORWARD_HORIZONS_MIN,
} from './types.js';
export { METRICS, METRIC_BY_ID, OPERATORS } from './metrics.js';
export { FeatureBuilder, metricValue, windowBars } from './features.js';
export { CausalStructure, emptyStructure } from './structure.js';
export { evalRule, and, or, not, cond, collectMetrics } from './conditions.js';
export { coverageGate, strategyMetrics } from './coverage.js';
export { MicrostructureBacktestEngine } from './engine.js';
export { runSignalStudy, getStudyPreset, STUDY_PRESETS } from './signal-study.js';
export type { SignalStudyResult, StudyPreset, HorizonStudy } from './signal-study.js';
export {
  listStrategyPresets,
  getStrategyPreset,
  cloneStrategy,
  emptyCustomStrategy,
} from './presets.js';
export { mergeDataset, klinesToCandles, footprintFromWire, tfToInterval, sourceTfMinutes, rollCandles } from './dataset.js';
export { summarizeTrades, attachForwardReturns, equityCurve, horizonKey } from './stats.js';
