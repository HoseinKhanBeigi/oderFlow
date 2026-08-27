import Phaser from 'phaser';
import { formatUsd, logScale } from '../src/simulation/math.js';
import type { LiquidityLevel, MarketSimulationState } from '../src/simulation/types.js';

const BUY = 0x22c55e;
const SELL = 0xef4444;
const ACCENT = 0x60a5fa;
const GOLD = 0xfbbf24;
const FORCED = 0xa78bfa;
const WALL_ASK = 0xef4444;
const WALL_BID = 0x22c55e;

interface Particle {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  color: number;
  forced: boolean;
}

/**
 * Phaser renders SimulationState only. No order-book math lives here.
 */
export class PhaserRenderer {
  private readonly game: Phaser.Game;
  private scene: RenderScene | null = null;

  constructor(parent: HTMLElement) {
    const self = this;
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: '#080a0e',
      scale: {
        mode: Phaser.Scale.RESIZE,
        parent,
        width: parent.clientWidth || 900,
        height: parent.clientHeight || 640,
      },
      render: { antialias: true, pixelArt: false },
      scene: class extends RenderScene {
        constructor() {
          super();
          self.scene = this;
        }
      },
      banner: false,
    });
  }

  setState(state: MarketSimulationState | null): void {
    this.scene?.setState(state);
  }

  destroy(): void {
    this.game.destroy(true);
  }
}

class RenderScene extends Phaser.Scene {
  private state: MarketSimulationState | null = null;
  private gfx!: Phaser.GameObjects.Graphics;
  private trailGfx!: Phaser.GameObjects.Graphics;
  private particleGfx!: Phaser.GameObjects.Graphics;
  private priceDot!: Phaser.GameObjects.Arc;
  private halo!: Phaser.GameObjects.Arc;
  private priceLabel!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private levelTexts: Phaser.GameObjects.Text[] = [];
  private particles: Particle[] = [];
  private lastTs = 0;
  private fadeAsk = new Map<number, number>();
  private fadeBid = new Map<number, number>();

  constructor() {
    super({ key: 'sim' });
  }

  setState(state: MarketSimulationState | null): void {
    this.state = state;
    if (!state) return;
    this.ingestImpulses(state);
    for (const fade of state.visual.fades) {
      const map = fade.side === 'ask' ? this.fadeAsk : this.fadeBid;
      map.set(fade.price, 1);
    }
  }

  create(): void {
    this.gfx = this.add.graphics();
    this.trailGfx = this.add.graphics();
    this.particleGfx = this.add.graphics();
    this.halo = this.add.circle(0, 0, 18, ACCENT, 0.18);
    this.priceDot = this.add.circle(0, 0, 7, 0xf8fafc);
    this.priceLabel = this.add.text(0, 0, '', {
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '13px',
      color: '#eef0f3',
    });
    this.banner = this.add.text(16, 12, '', {
      fontFamily: 'Inter, sans-serif',
      fontSize: '13px',
      color: '#fbbf24',
      fontStyle: 'bold',
    });
    this.banner.setDepth(10);
  }

  update(_: number, delta: number): void {
    const s = this.state;
    const w = this.scale.width;
    const h = this.scale.height;
    this.gfx.clear();
    this.trailGfx.clear();
    this.particleGfx.clear();
    if (!s || !s.price) {
      this.drawEmpty(w, h);
      return;
    }

    const cx = w * 0.42;
    const cy = h * 0.5;
    const pxPerPrice = this.scaleY(s, h);
    const maxQuote = this.maxQuote(s);
    const toY = (price: number) => cy - (price - s.price) * pxPerPrice;

    this.drawGrid(w, h, cy);
    this.drawTrail(s, cx, toY);
    this.drawWalls(s.asks, 'ask', cx, toY, maxQuote, w);
    this.drawWalls(s.bids, 'bid', cx, toY, maxQuote, w);
    this.stepParticles(delta, cx, cy, toY, s);
    this.drawPrice(s, cx, cy);
    this.drawBanner(s, w);
    this.decayFades(delta);
  }

  private drawEmpty(w: number, h: number): void {
    this.priceDot.setPosition(w / 2, h / 2);
    this.halo.setPosition(w / 2, h / 2);
    this.priceLabel.setText('Waiting for simulation state…').setPosition(w / 2 - 120, h / 2 + 18);
    this.banner.setText('');
  }

  private drawGrid(w: number, h: number, cy: number): void {
    this.gfx.lineStyle(1, 0x1c2230, 1);
    this.gfx.lineBetween(0, cy, w, cy);
    this.gfx.fillStyle(0x111419, 0.35);
    this.gfx.fillRect(0, 0, w, cy);
    this.gfx.fillStyle(0x0d1015, 0.35);
    this.gfx.fillRect(0, cy, w, h - cy);
  }

  private drawTrail(s: MarketSimulationState, cx: number, toY: (p: number) => number): void {
    if (s.trail.length < 2) return;
    this.trailGfx.lineStyle(2, ACCENT, 0.55);
    this.trailGfx.beginPath();
    const n = s.trail.length;
    s.trail.forEach((p, i) => {
      const x = cx - (n - i) * 1.15;
      const y = toY(p.price);
      if (i === 0) this.trailGfx.moveTo(x, y);
      else this.trailGfx.lineTo(x, y);
    });
    this.trailGfx.strokePath();
  }

  private drawWalls(
    levels: LiquidityLevel[],
    side: 'ask' | 'bid',
    cx: number,
    toY: (p: number) => number,
    maxQuote: number,
    w: number,
  ): void {
    const color = side === 'ask' ? WALL_ASK : WALL_BID;
    const fades = side === 'ask' ? this.fadeAsk : this.fadeBid;
    const maxW = Math.min(280, w * 0.32);
    for (const [i, text] of this.levelTexts.entries()) {
      if (i >= 32) text.setVisible(false);
    }
    levels.forEach((lvl, idx) => {
      const y = toY(lvl.price);
      const width = Math.max(8, logScale(lvl.restingLiquidity, maxQuote) * maxW);
      const fade = fades.get(lvl.price) ?? 0;
      const hit = this.state?.visual.wallHits.some((h) => h.side === side && Math.abs(h.price - lvl.price) < 1e-6);
      const alpha = 0.22 + 0.55 * (1 - fade) + (hit ? 0.2 : 0);
      this.gfx.fillStyle(color, alpha);
      this.gfx.fillRoundedRect(cx + 18, y - 9, width, 18, 3);
      if (lvl.executedLiquidity > 0) {
        const consumedW = logScale(lvl.executedLiquidity, maxQuote) * maxW;
        this.gfx.fillStyle(GOLD, 0.55);
        this.gfx.fillRoundedRect(cx + 18 + width, y - 9, Math.max(4, consumedW * 0.35), 18, 2);
      }
      if (lvl.replenishedLiquidity > 0) {
        this.gfx.lineStyle(1, 0x38bdf8, 0.8);
        this.gfx.strokeRoundedRect(cx + 16, y - 11, width + 4, 22, 4);
      }
      const label = this.levelText(idx + (side === 'ask' ? 0 : 16));
      const tag = this.levelTag(lvl, fade);
      label
        .setVisible(true)
        .setPosition(cx + 24 + width, y - 8)
        .setColor(side === 'ask' ? '#fca5a5' : '#86efac')
        .setText(`${fmtPrice(lvl.price)}  ${formatUsd(lvl.restingLiquidity)}${tag}`);
    });
  }

  private levelTag(lvl: LiquidityLevel, fade: number): string {
    if (fade > 0.2) return '  WITHDRAWAL';
    if (lvl.executedLiquidity > 0 && lvl.replenishedLiquidity > 0) return '  REPLENISH';
    if (lvl.executedLiquidity > 0) return `  CONSUMED ${formatUsd(lvl.executedLiquidity)}`;
    if (lvl.replenishedLiquidity > 0) return '  REPLENISH';
    if (lvl.cancelledLiquidity > 0) return '  WITHDRAWAL';
    return '';
  }

  private drawPrice(s: MarketSimulationState, cx: number, cy: number): void {
    const up = s.price >= s.previousPrice;
    this.priceDot.setFillStyle(up ? BUY : SELL);
    this.priceDot.setPosition(cx, cy);
    this.halo.setPosition(cx, cy);
    this.halo.setFillStyle(s.visual.absorptionAsk || s.visual.absorptionBid ? GOLD : ACCENT, 0.2);
    this.priceLabel
      .setText(`● ${s.symbol.replace('USDT', '')}  ${fmtPrice(s.price)}`)
      .setPosition(cx - 70, cy + 14);
  }

  private drawBanner(s: MarketSimulationState, w: number): void {
    const bits: string[] = [];
    if (s.visual.absorptionAsk) bits.push('PASSIVE SELLER ABSORPTION');
    if (s.visual.absorptionBid) bits.push('PASSIVE BUYER ABSORPTION');
    if (s.visual.upsideVacuum) bits.push('UPSIDE LIQUIDITY VACUUM');
    if (s.visual.downsideVacuum) bits.push('DOWNSIDE LIQUIDITY VACUUM');
    if (s.visual.forcedBuyImpulse > 0.05) bits.push('FORCED LIQUIDATION BUY');
    if (s.visual.forcedSellImpulse > 0.05) bits.push('FORCED LIQUIDATION SELL');
    this.banner.setText(bits.join('  ·  '));
    this.banner.setPosition(16, 12);
    this.banner.setWordWrapWidth(w - 32);
  }

  private ingestImpulses(s: MarketSimulationState): void {
    if (s.timestamp === this.lastTs) return;
    this.lastTs = s.timestamp;
    const spawn = (mag: number, dir: number, color: number, forced: boolean) => {
      const n = Math.min(10, Math.max(0, Math.round(mag * 8)));
      for (let i = 0; i < n; i++) {
        if (this.particles.length > 90) this.particles.shift();
        this.particles.push({
          x: 0,
          y: 0,
          vy: dir * (1.6 + mag * 3 + Math.random() * 0.8),
          life: 1,
          maxLife: 0.7 + mag * 0.5,
          r: forced ? 4.5 : 2.4 + mag * 2,
          color,
          forced,
        });
      }
    };
    spawn(s.visual.buyImpulse, -1, BUY, false);
    spawn(s.visual.sellImpulse, 1, SELL, false);
    spawn(s.visual.forcedBuyImpulse, -1, FORCED, true);
    spawn(s.visual.forcedSellImpulse, 1, FORCED, true);
  }

  private stepParticles(
    delta: number,
    cx: number,
    cy: number,
    toY: (p: number) => number,
    s: MarketSimulationState,
  ): void {
    const dt = Math.min(0.05, delta / 1000);
    const askY = s.asks[0] ? toY(s.asks[0].price) : cy - 40;
    const bidY = s.bids[0] ? toY(s.bids[0].price) : cy + 40;
    this.particles = this.particles.filter((p) => {
      if (p.x === 0 && p.y === 0) {
        p.x = cx + (Math.random() - 0.5) * 16;
        p.y = cy;
      }
      p.y += p.vy * dt * 60;
      p.life -= dt / p.maxLife;
      if (p.vy < 0 && p.y <= askY) p.vy *= -0.15;
      if (p.vy > 0 && p.y >= bidY) p.vy *= -0.15;
      const a = Math.max(0, p.life);
      this.particleGfx.fillStyle(p.color, 0.25 + a * 0.7);
      this.particleGfx.fillCircle(p.x, p.y, p.r);
      if (p.forced) {
        this.particleGfx.lineStyle(1, GOLD, a);
        this.particleGfx.strokeCircle(p.x, p.y, p.r + 2);
      }
      return p.life > 0;
    });
  }

  private decayFades(delta: number): void {
    const k = Math.min(1, delta / 400);
    for (const map of [this.fadeAsk, this.fadeBid]) {
      for (const [px, v] of map) {
        const next = v - k;
        if (next <= 0) map.delete(px);
        else map.set(px, next);
      }
    }
  }

  private scaleY(s: MarketSimulationState, h: number): number {
    const prices = [...s.asks.map((l) => l.price), ...s.bids.map((l) => l.price), s.price];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = Math.max(max - min, s.price * 0.001, 1);
    return (h * 0.72) / (span * 2);
  }

  private maxQuote(s: MarketSimulationState): number {
    const qs = [...s.asks, ...s.bids].map((l) => l.restingLiquidity);
    return Math.max(1, ...qs);
  }

  private levelText(i: number): Phaser.GameObjects.Text {
    let t = this.levelTexts[i];
    if (!t) {
      t = this.add.text(0, 0, '', {
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '11px',
        color: '#7a8494',
      });
      this.levelTexts[i] = t;
    }
    return t;
  }
}

function fmtPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toPrecision(4);
}
