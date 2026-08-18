import type { PressureConfig } from '../config/types.js';
import { safeDiv } from '../core/integrity.js';
import type { FlowLiquidityRegime, LiquidityPressure } from '../models/liquidity.js';
import type { LocalOrderBook } from './local-order-book.js';

export class LiquidityEngine {
  constructor(private readonly config: PressureConfig) {}

  pressure(buyVolume: number, sellVolume: number, book: LocalOrderBook): LiquidityPressure {
    const near = this.config.nearBandPct;
    const mid = book.mid();
    const askLiq = book.notionalWithin('ask', mid, near);
    const bidLiq = book.notionalWithin('bid', mid, near);
    return {
      buyPressure: safeDiv(buyVolume, askLiq),
      sellPressure: safeDiv(sellVolume, bidLiq),
    };
  }

  regime(
    largeBuy: boolean,
    largeSell: boolean,
    buyVolume: number,
    sellVolume: number,
    book: LocalOrderBook,
    askReplenishment: number,
    bidReplenishment: number,
    askConsumption: number,
    bidConsumption: number,
  ): FlowLiquidityRegime {
    const mid = book.mid();
    const asks = book.notionalWithin('ask', mid, this.config.nearBandPct);
    const bids = book.notionalWithin('bid', mid, this.config.nearBandPct);
    const thinAsks = asks > 0 && asks <= this.config.thinAskQuote;
    const thinBids = bids > 0 && bids <= this.config.thinBidQuote;
    const heavyAskRepl = askReplenishment > askConsumption && askReplenishment > 0;
    const heavyBidRepl = bidReplenishment > bidConsumption && bidReplenishment > 0;

    if (largeBuy && heavyAskRepl) return 'LARGE_BUY_FLOW_HEAVY_ASK_REPLENISHMENT';
    if (largeSell && heavyBidRepl) return 'LARGE_SELL_FLOW_HEAVY_BID_REPLENISHMENT';
    if (largeBuy && (thinAsks || buyVolume > asks * 3)) return 'LARGE_BUY_FLOW_THIN_ASKS';
    if (largeSell && (thinBids || sellVolume > bids * 3)) return 'LARGE_SELL_FLOW_THIN_BIDS';
    return 'BALANCED';
  }
}
