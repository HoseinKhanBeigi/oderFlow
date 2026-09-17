/**
 * Renderers for a briefing.
 *
 * `briefingToText` is the one to read by hand. If a trader cannot decide from
 * that text alone, the briefing is missing something and no prompt will fix it.
 */
import { formatQuote } from '../core/integrity.js';
import type { AgentBriefing, BriefingBattleSide, BriefingWall } from './types.js';

export function briefingToJson(briefing: AgentBriefing, pretty = false): string {
  return JSON.stringify(briefing, null, pretty ? 2 : 0);
}

/**
 * Rough token count for budgeting. English-with-numbers runs near 4 characters
 * per token; this is for spotting a 20K-token briefing, not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function briefingToText(b: AgentBriefing): string {
  const out: string[] = [];

  out.push(`${b.symbol} ${b.market} @ ${b.price}  (${b.at})`);

  if (!b.gate.usable) {
    out.push(`DATA NOT USABLE — ${b.gate.blockers.join('; ')}`);
  }
  out.push(
    `Confidence ${b.gate.confidence} · liquidity data quality ${b.gate.dataQuality}/100 · ` +
      `book ${b.gate.bookReliable ? 'reliable' : 'UNRELIABLE'} · last trade ${b.gate.tradeAgeMs}ms ago`,
  );

  out.push('');
  out.push('ENGINE READ');
  out.push(`  flow state        ${b.read.state}`);
  out.push(`  microstructure    ${b.read.microstructure}`);
  out.push(`  passive liquidity ${b.read.passiveState}`);
  out.push(`  entry context     ${b.read.entryContext}`);
  out.push(`  effort vs result  ${b.read.effort} (aggressor: ${b.read.aggression})`);
  out.push(
    `  price response    ${b.read.priceImpactEfficiency}${b.read.impactFaded ? ' — faded on later horizons' : ''}`,
  );
  out.push(`  path of least resistance ${b.read.pathOfLeastResistance} · directional score ${b.read.directionalScore}`);
  if (b.read.absorption) {
    out.push(
      `  ABSORPTION        ${b.read.absorption.type} by ${b.read.absorption.absorbingSide} ` +
        `(strength ${b.read.absorption.strength})`,
    );
  }
  if (b.read.reversal) {
    out.push(`  REVERSAL COND.    ${b.read.reversal.kind} — ${b.read.reversal.reasons.join('; ')}`);
  }

  out.push('');
  out.push('AGGRESSIVE FLOW');
  for (const f of b.flow) {
    out.push(
      `  ${f.window.padEnd(4)} buy ${formatQuote(f.buy).padEnd(9)} sell ${formatQuote(f.sell).padEnd(9)} ` +
        `Δ ${formatQuote(f.delta).padEnd(9)} imb ${f.imbalance >= 0 ? '+' : ''}${f.imbalance} ` +
        `p${f.netPercentile} · price ${f.priceChangePercent >= 0 ? '+' : ''}${f.priceChangePercent}% · ${f.state}`,
    );
  }

  out.push('');
  out.push(`BATTLE (${b.battle.window}) — ${b.battle.summary}`);
  out.push(`  ${b.battle.summaryWhy}`);
  out.push(battleLine('upside  ', b.battle.upside));
  out.push(battleLine('downside', b.battle.downside));

  out.push('');
  out.push('PASSIVE LIQUIDITY');
  out.push(
    `  spread ${b.liquidity.spreadBps}bps · bid depth ${formatQuote(b.liquidity.bidDepth)} ` +
      `(near ${formatQuote(b.liquidity.nearBidDepth)}) · ask depth ${formatQuote(b.liquidity.askDepth)} ` +
      `(near ${formatQuote(b.liquidity.nearAskDepth)})`,
  );
  out.push(
    `  passive buyer strength ${b.liquidity.passiveBuyerStrength} · seller strength ${b.liquidity.passiveSellerStrength}`,
  );
  for (const w of b.liquidity.askWalls) out.push(`  ${wallLine(w)}`);
  for (const w of b.liquidity.bidWalls) out.push(`  ${wallLine(w)}`);
  if (b.liquidity.upsideVacuum.detected) {
    out.push(
      `  UPSIDE VACUUM score ${b.liquidity.upsideVacuum.score}, ` +
        `next wall ${b.liquidity.upsideVacuum.distanceToNextWallBps}bps away`,
    );
  }
  if (b.liquidity.downsideVacuum.detected) {
    out.push(
      `  DOWNSIDE VACUUM score ${b.liquidity.downsideVacuum.score}, ` +
        `next wall ${b.liquidity.downsideVacuum.distanceToNextWallBps}bps away`,
    );
  }
  if (b.liquidity.floor) {
    const f = b.liquidity.floor;
    out.push(`  floor zone ${f.priceMin}–${f.priceMax} ${f.state} (${f.defended}/${f.tests} tests defended, strength ${f.strength})`);
  }
  if (b.liquidity.ceiling) {
    const c = b.liquidity.ceiling;
    out.push(`  ceiling zone ${c.priceMin}–${c.priceMax} ${c.state} (${c.defended}/${c.tests} tests defended, strength ${c.strength})`);
  }

  out.push('');
  out.push(`TARGETS (ATR ${b.targets.atr})`);
  for (const t of b.targets.upside) {
    out.push(`  up   ${t.price} (+${t.distancePercent}%) reachability ${t.reachability} ${t.difficulty}`);
  }
  for (const t of b.targets.downside) {
    out.push(`  down ${t.price} (${t.distancePercent}%) reachability ${t.reachability} ${t.difficulty}`);
  }

  out.push('');
  out.push(
    `STRUCTURE ${b.structure.bias} · shift ${b.structure.shift} · ` +
      `swing high ${b.structure.swingHigh ?? 'n/a'} · swing low ${b.structure.swingLow ?? 'n/a'}`,
  );

  if (b.footprint) {
    out.push('');
    out.push(`FOOTPRINT (${b.footprint.timeframeMinutes}m, oldest first)`);
    for (const bar of b.footprint.bars) {
      const time = new Date(bar.t * 1000).toISOString().slice(11, 16);
      const imbalances = [
        ...bar.topBuyLevels.map(([p, buy, sell]) => `${p}:+${formatQuote(buy - sell)}`),
        ...bar.topSellLevels.map(([p, buy, sell]) => `${p}:${formatQuote(buy - sell)}`),
      ].join(' ');
      out.push(
        `  ${time} o${bar.o} h${bar.h} l${bar.l} c${bar.c} Δ${formatQuote(bar.delta).padEnd(9)} ` +
          `poc ${bar.poc}  ${imbalances}`,
      );
    }
    const last3 = b.footprint.last3;
    if (last3) {
      out.push('');
      out.push(`LAST 3 CANDLES — structure ${last3.structure}`);
      if (last3.askCluster) {
        const c = last3.askCluster;
        const time = new Date(c.t * 1000).toISOString().slice(11, 16);
        out.push(`  ASK CLUSTER ${c.price} @ ${time}  ${formatQuote(c.ask)} ask vs ${formatQuote(c.bid)} bid`);
        out.push(
          `  DEFENSE ${last3.defense} · subsequent ${formatQuote(last3.subsequentBid)} bid × ${formatQuote(last3.subsequentAsk)} ask at the cluster`,
        );
      }
      for (const candle of last3.candles) {
        const time = new Date(candle.t * 1000).toISOString().slice(11, 16);
        const levels = candle.levels
          .map(([p, bid, ask]) => `${p} ${formatQuote(bid)}×${formatQuote(ask)}`)
          .join(' | ');
        out.push(`  ${time} Δ${formatQuote(candle.delta).padEnd(9)}  ${levels}`);
      }
      out.push(`  ${last3.why}`);
      const m = last3.momentum;
      const [a, b, c] = m.scores;
      const fmt = (n: number | null) => (n == null ? 'n/a' : n > 0 ? `+${n}` : String(n));
      out.push(
        `  ATTACK 3 ago ${fmt(a)} · 2 ago ${fmt(b)} · current ${fmt(c)}  ·  ` +
          `price ${m.priceFrom ?? 'n/a'} → ${m.priceTo ?? 'n/a'} ` +
          `(${m.priceChangePercent >= 0 ? '+' : ''}${m.priceChangePercent}%)`,
      );
      out.push(`  MOMENTUM ${m.state} — ${m.implies}`);
    }
  }

  if (b.daily) {
    const d = b.daily;
    out.push('');
    out.push(`${d.timeframe} CONTEXT — ${d.bias} / ${d.setup} at ${d.location} (confidence ${d.confidence})`);
    out.push(`  support ${d.support ?? 'n/a'} · resistance ${d.resistance ?? 'n/a'} · POC ${d.poc ?? 'n/a'}`);
    out.push(
      `  engine plan: ${d.plan.entryMode} entry ${d.plan.entry ?? 'n/a'} ` +
        `SL ${d.plan.sl ?? 'n/a'} TP1 ${d.plan.tp1 ?? 'n/a'} TP2 ${d.plan.tp2 ?? 'n/a'}`,
    );
    out.push(`  ${d.reason}`);
  }

  if (b.notes.length) {
    out.push('');
    out.push('SUPPORTING FACTS');
    for (const n of b.notes) out.push(`  - ${n}`);
  }

  return out.join('\n');
}

function battleLine(label: string, s: BriefingBattleSide): string {
  return (
    `  ${label} ${s.state.padEnd(24)} score ${String(s.score).padStart(3)} · ` +
    `aggression ${s.aggressivePower} vs defense ${s.defensePower} · survival ${s.survival} · ` +
    `consumption ${s.consumption}/replenish ${s.replenishment}`
  );
}

function wallLine(w: BriefingWall): string {
  const labels = w.labels.length ? ` [${w.labels.join(', ')}]` : '';
  return (
    `${w.side} wall ${w.price} (${w.distanceBps}bps) ${formatQuote(w.notional)} · ` +
    `strength ${w.strength} reliability ${w.reliability} · ${w.lifecycle} · ` +
    `${w.defended}/${w.attacks} attacks defended${labels}`
  );
}
