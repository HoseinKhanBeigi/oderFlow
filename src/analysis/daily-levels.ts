import { pctChange, safeDiv } from '../core/integrity.js';
import { tickSize } from '../footprint/tick-size.js';
import type { FootprintBar } from '../footprint/types.js';
import { detectStructure } from '../liquidity-response/structure.js';
import type { MinuteBar } from '../liquidity-response/minute-ring.js';
import type { StructureSnapshot } from '../models/liquidity-response.js';
import type { DailyLevel, DailyLocation } from '../models/daily-signal.js';

export interface DailyLevels {
  support: number | null;
  resistance: number | null;
  poc: number | null;
  hvns: number[];
  all: DailyLevel[];
  structure: StructureSnapshot;
  atr: number;
  location: DailyLocation;
}

interface ProfileBin {
  price: number;
  buy: number;
  sell: number;
  volume: number;
}

export function buildDailyLevels(bars: FootprintBar[], price: number, lookback = 20): DailyLevels {
  const recent = bars.slice(-lookback);
  const structure = detectStructure(asMinuteBars(recent));
  const atr = dailyAtr(recent);
  const profile = volumeProfile(recent, price);
  const poc = profile[0] ?? null;
  const hvns = localHighVolume(profile);
  const prior = recent[recent.length - 2];
  const last = recent[recent.length - 1];

  const candidates: DailyLevel[] = [];
  if (poc) {
    candidates.push({
      price: poc.price,
      kind: 'POC',
      source: 'volume-profile POC',
      volume: poc.volume,
    });
  }
  for (const h of hvns) {
    if (poc && nearlyEqual(h.price, poc.price, price)) continue;
    candidates.push({
      price: h.price,
      kind: 'HVN',
      source: 'high-volume node',
      volume: h.volume,
    });
  }
  pushSwing(candidates, structure.swingLow, 'SUPPORT', 'swing low');
  pushSwing(candidates, structure.swingHigh, 'RESISTANCE', 'swing high');
  if (prior) {
    pushSwing(candidates, prior.low, 'SUPPORT', 'prior-bar low');
    pushSwing(candidates, prior.high, 'RESISTANCE', 'prior-bar high');
  }
  if (last) {
    const absorbed = absorptionLevel(last);
    if (absorbed) candidates.push(absorbed);
  }

  const below = uniquePrices(candidates.filter((l) => l.price < price), price);
  const above = uniquePrices(candidates.filter((l) => l.price > price), price);
  const support = pickNearest(below, price, 'below');
  const resistance = pickNearest(above, price, 'above');

  const all = [...below, ...above, ...candidates.filter((l) => l.kind === 'POC')].sort(
    (a, b) => a.price - b.price,
  );

  return {
    support: support?.price ?? null,
    resistance: resistance?.price ?? null,
    poc: poc?.price ?? null,
    hvns: hvns.map((h) => h.price),
    all,
    structure,
    atr,
    location: locate(price, support?.price ?? null, resistance?.price ?? null, atr),
  };
}

export function dailyAtr(bars: FootprintBar[], period = 14): number {
  if (bars.length < 2) {
    const last = bars[bars.length - 1];
    return last ? Math.max(0, last.high - last.low) : 0;
  }
  const n = Math.min(period, bars.length);
  const slice = bars.slice(-n);
  let sum = 0;
  for (let i = 0; i < slice.length; i++) {
    const bar = slice[i]!;
    const prev = slice[i - 1] ?? bars[bars.length - n - 1];
    const tr = prev
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close))
      : bar.high - bar.low;
    sum += tr;
  }
  return sum / n;
}

export function locate(
  price: number,
  support: number | null,
  resistance: number | null,
  atr: number,
): DailyLocation {
  if (support == null && resistance == null) return 'UNKNOWN';
  const band = Math.max(atr * 0.35, price * 0.0025);
  if (support != null && price < support - band) return 'BELOW_SUPPORT';
  if (resistance != null && price > resistance + band) return 'ABOVE_RESISTANCE';
  if (support != null && Math.abs(price - support) <= band) return 'AT_SUPPORT';
  if (resistance != null && Math.abs(price - resistance) <= band) return 'AT_RESISTANCE';
  return 'MID_RANGE';
}

function volumeProfile(bars: FootprintBar[], mid: number): ProfileBin[] {
  const step = profileStep(mid);
  const bins = new Map<number, ProfileBin>();
  for (const bar of bars) {
    if (bar.levels.length) {
      for (const lv of bar.levels) {
        const price = bucket(lv.price, step);
        const bin = bins.get(price) ?? { price, buy: 0, sell: 0, volume: 0 };
        bin.buy += lv.buy;
        bin.sell += lv.sell;
        bin.volume += lv.buy + lv.sell;
        bins.set(price, bin);
      }
      continue;
    }
    // Kline-only bars have no footprint split — use the close as a stub node.
    if (bar.totalBuy + bar.totalSell <= 0) continue;
    const price = bucket(bar.close, step);
    const bin = bins.get(price) ?? { price, buy: 0, sell: 0, volume: 0 };
    bin.buy += bar.totalBuy;
    bin.sell += bar.totalSell;
    bin.volume += bar.totalBuy + bar.totalSell;
    bins.set(price, bin);
  }
  return [...bins.values()].sort((a, b) => b.volume - a.volume);
}

function localHighVolume(profile: ProfileBin[]): ProfileBin[] {
  if (profile.length < 3) return profile.slice(0, 1);
  const byPrice = [...profile].sort((a, b) => a.price - b.price);
  const vols = byPrice.map((b) => b.volume).sort((a, b) => a - b);
  const cutoff = vols[Math.floor(vols.length * 0.7)] ?? 0;
  const out: ProfileBin[] = [];
  for (let i = 1; i < byPrice.length - 1; i++) {
    const cur = byPrice[i]!;
    const prev = byPrice[i - 1]!;
    const next = byPrice[i + 1]!;
    if (cur.volume < cutoff) continue;
    if (cur.volume >= prev.volume && cur.volume >= next.volume) out.push(cur);
  }
  return out.sort((a, b) => b.volume - a.volume).slice(0, 6);
}

function absorptionLevel(bar: FootprintBar): DailyLevel | null {
  if (!bar.levels.length) return null;
  const range = Math.max(bar.high - bar.low, 1e-9);
  const closePos = safeDiv(bar.close - bar.low, range);
  let bestBuy = bar.levels[0]!;
  let bestSell = bar.levels[0]!;
  for (const lv of bar.levels) {
    if (lv.buy > bestBuy.buy) bestBuy = lv;
    if (lv.sell > bestSell.sell) bestSell = lv;
  }
  const buyDom = bestBuy.buy > bestBuy.sell * 1.6 && bestBuy.buy > (bar.totalBuy + bar.totalSell) * 0.08;
  const sellDom = bestSell.sell > bestSell.buy * 1.6 && bestSell.sell > (bar.totalBuy + bar.totalSell) * 0.08;
  const nearHigh = pctChange(bestBuy.price, bar.high) > -0.15 && closePos <= 0.45;
  const nearLow = pctChange(bar.low, bestSell.price) > -0.15 && closePos >= 0.55;
  if (buyDom && nearHigh) {
    return {
      price: bestBuy.price,
      kind: 'RESISTANCE',
      source: 'buy absorption at bar high',
      volume: bestBuy.buy + bestBuy.sell,
    };
  }
  if (sellDom && nearLow) {
    return {
      price: bestSell.price,
      kind: 'SUPPORT',
      source: 'sell absorption at bar low',
      volume: bestSell.buy + bestSell.sell,
    };
  }
  return null;
}

function asMinuteBars(bars: FootprintBar[]): MinuteBar[] {
  return bars.map((b) => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    buy: b.totalBuy,
    sell: b.totalSell,
    buyCount: b.buyTrades ?? 0,
    sellCount: b.sellTrades ?? 0,
    largeBuyCount: 0,
    largeSellCount: 0,
    nearAsk: 0,
    nearBid: 0,
  }));
}

function profileStep(mid: number): number {
  const tick = tickSize(mid);
  return Math.max(tick, Number((mid * 0.001).toPrecision(2)));
}

function bucket(price: number, step: number): number {
  return Number((Math.round(price / step) * step).toFixed(6));
}

function pushSwing(
  out: DailyLevel[],
  price: number | null | undefined,
  kind: DailyLevel['kind'],
  source: string,
): void {
  if (price == null || !Number.isFinite(price) || price <= 0) return;
  out.push({ price, kind, source, volume: 0 });
}

function uniquePrices(levels: DailyLevel[], mid: number): DailyLevel[] {
  const band = mid * 0.0015;
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const out: DailyLevel[] = [];
  for (const lv of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(lv.price - prev.price) <= band) {
      if (lv.volume > prev.volume) out[out.length - 1] = lv;
      continue;
    }
    out.push(lv);
  }
  return out;
}

function pickNearest(levels: DailyLevel[], price: number, side: 'below' | 'above'): DailyLevel | undefined {
  if (!levels.length) return undefined;
  const ranked = [...levels].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  const nearest = ranked[0];
  if (!nearest) return undefined;
  return side === 'below' ? nearest : nearest;
}

function nearlyEqual(a: number, b: number, mid: number): boolean {
  return Math.abs(a - b) <= mid * 0.001;
}
