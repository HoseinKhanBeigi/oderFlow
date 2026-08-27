import type { LiquidationSimEvent } from './events.js';
import type { LiquidationZone } from './types.js';
import { EPSILON } from './types.js';

export interface CascadeImpulse {
  side: 'BUY' | 'SELL';
  quoteValue: number;
  zoneId: string;
  zonePrice: number;
  forced: true;
}

/**
 * Forced secondary aggression when price reaches a liquidation cluster.
 * Cascades are iterative: a forced buy may walk price into the next cluster.
 */
export class LiquidationCascadeEngine {
  private zones: LiquidationZone[] = [];
  private longNotional = 0;
  private shortNotional = 0;

  reset(): void {
    this.zones = [];
    this.longNotional = 0;
    this.shortNotional = 0;
  }

  setZones(zones: Array<Omit<LiquidationZone, 'triggered' | 'triggeredAt'>>): void {
    this.zones = zones.map((z) => ({ ...z, triggered: false }));
  }

  addZone(zone: Omit<LiquidationZone, 'triggered' | 'triggeredAt'>): void {
    this.zones.push({ ...zone, triggered: false });
  }

  ingestLive(event: LiquidationSimEvent): CascadeImpulse {
    if (event.type === 'SHORT_LIQUIDATION') {
      this.shortNotional += event.quoteValue;
      return { side: 'BUY', quoteValue: event.quoteValue, zoneId: `live-${event.seq}`, zonePrice: event.price, forced: true };
    }
    this.longNotional += event.quoteValue;
    return { side: 'SELL', quoteValue: event.quoteValue, zoneId: `live-${event.seq}`, zonePrice: event.price, forced: true };
  }

  /**
   * Check untriggered zones against current price. Caller must apply the
   * returned impulse (walk the book) then call again until empty — that is
   * the cascade.
   */
  trigger(price: number, timestamp: number): CascadeImpulse[] {
    const out: CascadeImpulse[] = [];
    for (const zone of this.zones) {
      if (zone.triggered || zone.quoteValue <= EPSILON) continue;
      const hit = zone.side === 'short' ? price >= zone.price : price <= zone.price;
      if (!hit) continue;
      zone.triggered = true;
      zone.triggeredAt = timestamp;
      if (zone.side === 'short') {
        this.shortNotional += zone.quoteValue;
        out.push({ side: 'BUY', quoteValue: zone.quoteValue, zoneId: zone.id, zonePrice: zone.price, forced: true });
      } else {
        this.longNotional += zone.quoteValue;
        out.push({ side: 'SELL', quoteValue: zone.quoteValue, zoneId: zone.id, zonePrice: zone.price, forced: true });
      }
    }
    return out;
  }

  beginTick(): void {
    this.longNotional = 0;
    this.shortNotional = 0;
  }

  current(): { longLiquidations: number; shortLiquidations: number; zones: LiquidationZone[] } {
    return {
      longLiquidations: this.longNotional,
      shortLiquidations: this.shortNotional,
      zones: this.zones.map((z) => ({ ...z })),
    };
  }
}
