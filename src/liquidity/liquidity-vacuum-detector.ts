import type { MovePotentialConfig } from '../config/types.js';
import type { LiquidityVacuum, MovePotentialEventType } from '../models/liquidity.js';
import type { UnscoredLiquidityTarget } from '../models/movement.js';

/**
 * Thin opposing-liquidity pockets between consecutive path targets.
 */
export class LiquidityVacuumDetector {
  constructor(private readonly config: MovePotentialConfig) {}

  detect(
    upside: UnscoredLiquidityTarget[],
    downside: UnscoredLiquidityTarget[],
  ): { vacuums: LiquidityVacuum[]; events: MovePotentialEventType[] } {
    const events: MovePotentialEventType[] = [];
    const vacuums: LiquidityVacuum[] = [
      ...this.scan(upside, 'UPSIDE_LIQUIDITY_VACUUM', events),
      ...this.scan(downside, 'DOWNSIDE_LIQUIDITY_VACUUM', events),
    ];
    return { vacuums, events };
  }

  private scan(
    path: UnscoredLiquidityTarget[],
    kind: LiquidityVacuum['kind'],
    events: MovePotentialEventType[],
  ): LiquidityVacuum[] {
    const out: LiquidityVacuum[] = [];
    for (let i = 0; i < path.length; i++) {
      const anchor = path[i]!;
      if (anchor.cumulativeLiquidity <= 0) continue;
      if (anchor.densityClass === 'THIN') continue;
      const far = path.find(
        (t, j) => j > i && Math.abs(t.distancePercent - anchor.distancePercent) >= 0.15,
      );
      if (!far) continue;
      const dist = Math.abs(far.distancePercent - anchor.distancePercent);
      const segment = Math.max(0, far.cumulativeLiquidity - anchor.cumulativeLiquidity);
      const anchorDist = Math.max(1e-6, Math.abs(anchor.distancePercent));
      const prevDensity = anchor.cumulativeLiquidity / anchorDist;
      const density = segment / dist;
      const relative = prevDensity > 0 ? density / prevDensity : 1;
      if (relative > this.config.vacuumDensityRatio) continue;
      out.push({
        kind,
        fromPrice: anchor.price,
        toPrice: far.price,
        segmentLiquidity: segment,
        relativeDensity: relative,
      });
      events.push(kind);
      break;
    }
    return out;
  }
}
