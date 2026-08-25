import type { ExchangeId } from '../exchange/venues.js';
import { SPOT_EXCHANGE_IDS, type SpotExchangeId } from './types.js';

export function isSpotExchangeId(value: string): value is SpotExchangeId {
  return (SPOT_EXCHANGE_IDS as readonly string[]).includes(value);
}

export function parseSpotExchangesEnv(raw = process.env.SPOT_EXCHANGES): SpotExchangeId[] {
  if (!raw?.trim()) return [...SPOT_EXCHANGE_IDS];
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isSpotExchangeId);
  const unique = [...new Set(ids)];
  if (!unique.includes('binance')) unique.unshift('binance');
  return unique.length ? unique : [...SPOT_EXCHANGE_IDS];
}

export function asSpotExchange(exchange: ExchangeId): SpotExchangeId | null {
  return isSpotExchangeId(exchange) ? exchange : null;
}
