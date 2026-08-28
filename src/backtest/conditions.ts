import { metricValue } from './features.js';
import type { Condition, ConditionGroup, FeatureSnapshot, MetricId, RuleNode } from './types.js';

export function evalRule(
  node: RuleNode | undefined,
  history: FeatureSnapshot[],
): boolean {
  if (!node) return false;
  const snap = history[history.length - 1];
  if (!snap) return false;
  return evalNode(node, history, snap);
}

function evalNode(node: RuleNode, history: FeatureSnapshot[], snap: FeatureSnapshot): boolean {
  if (node.type === 'group') return evalGroup(node, history, snap);
  return evalCond(node, history, snap);
}

function evalGroup(group: ConditionGroup, history: FeatureSnapshot[], snap: FeatureSnapshot): boolean {
  if (!group.children.length) {
    const ok = false;
    return group.not ? !ok : ok;
  }
  let ok: boolean;
  if (group.bool === 'AND') {
    ok = group.children.every((c) => evalNode(c, history, snap));
  } else {
    ok = group.children.some((c) => evalNode(c, history, snap));
  }
  return group.not ? !ok : ok;
}

function evalCond(cond: Condition, history: FeatureSnapshot[], snap: FeatureSnapshot): boolean {
  const curr = metricValue(snap, cond.metric);
  const prevSnap = history[history.length - 2];
  const prev = prevSnap ? metricValue(prevSnap, cond.metric) : curr;
  const thr = cond.value;

  switch (cond.op) {
    case '>':
      return curr > thr;
    case '>=':
      return curr >= thr;
    case '<':
      return curr < thr;
    case '<=':
      return curr <= thr;
    case '=':
      return nearly(curr, thr);
    case '!=':
      return !nearly(curr, thr);
    case 'crosses_above':
      return prev < thr && curr >= thr;
    case 'crosses_below':
      return prev > thr && curr <= thr;
    case 'increases':
      return curr > prev;
    case 'decreases':
      return curr < prev;
    case 'turns_positive':
      return prev <= 0 && curr > 0;
    case 'turns_negative':
      return prev >= 0 && curr < 0;
    case 'percentile_above':
      return percentileOf(snap, cond.metric) >= thr;
    case 'percentile_below':
      return percentileOf(snap, cond.metric) <= thr;
    case 'changes_by_pct': {
      if (prev === 0) return false;
      return Math.abs((curr - prev) / prev) * 100 >= Math.abs(thr);
    }
    case 'persists_for': {
      const n = Math.max(1, Math.floor(cond.persistBars ?? thr));
      if (history.length < n) return false;
      const inner: Condition = { ...cond, op: persistInnerOp(cond) };
      return history.slice(-n).every((s, i) => {
        const h = history.slice(0, history.length - n + i + 1);
        return evalCond({ ...inner, persistBars: undefined }, h, s);
      });
    }
    default:
      return false;
  }
}

function persistInnerOp(cond: Condition): Condition['op'] {
  if (cond.metric === 'sellerAbsorption' || cond.metric === 'buyerAbsorption') return '>=';
  if (cond.value === 0 && (cond.metric === 'chochBullish' || cond.metric === 'chochBearish')) return '>=';
  return cond.op === 'persists_for' ? '>=' : cond.op;
}

function percentileOf(snap: FeatureSnapshot, metric: Condition['metric']): number {
  if (metric === 'aggressiveBuy' || metric === 'aggressiveBuyPercentile') return snap.buyPercentile;
  if (metric === 'aggressiveSell' || metric === 'aggressiveSellPercentile') return snap.sellPercentile;
  if (metric === 'delta' || metric === 'deltaPercentile') return snap.deltaPercentile;
  if (metric === 'priceDisplacement' || metric === 'displacementPercentile') return snap.displacementPercentile;
  if (metric === 'absorptionStrength' || metric === 'absorptionPercentile') return snap.absorptionPercentile;
  if (metric === 'bidReplenishment') return snap.bidReplenishment;
  if (metric === 'askReplenishment') return snap.askReplenishment;
  if (metric === 'bidWithdrawal') return snap.bidWithdrawal;
  if (metric === 'askWithdrawal') return snap.askWithdrawal;
  if (metric === 'downsideEfficiency') return snap.downsideEfficiency;
  if (metric === 'upsideEfficiency') return snap.upsideEfficiency;
  if (metric === 'priceEfficiency') return snap.priceEfficiency;
  return metricValue(snap, metric);
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

export function and(...children: RuleNode[]): ConditionGroup {
  return { type: 'group', bool: 'AND', children };
}

export function or(...children: RuleNode[]): ConditionGroup {
  return { type: 'group', bool: 'OR', children };
}

export function not(child: RuleNode): ConditionGroup {
  return { type: 'group', bool: 'AND', not: true, children: [child] };
}

export function cond(
  metric: Condition['metric'],
  op: Condition['op'],
  value: number,
  persistBars?: number,
): Condition {
  return persistBars != null ? { type: 'cond', metric, op, value, persistBars } : { type: 'cond', metric, op, value };
}

export function collectMetrics(node?: RuleNode): MetricId[] {
  if (!node) return [];
  if (node.type === 'cond') return [node.metric];
  return node.children.flatMap((child) => collectMetrics(child));
}
