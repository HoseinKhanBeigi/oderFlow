/**
 * Offline demo — replays aggressive flow scenarios and prints engine output.
 * Run: npm run demo
 */
import { OrderFlowEngine } from '../src/engine/order-flow-engine.js';
import { formatQuote } from '../src/core/integrity.js';
import type { MarketTrade, OrderBookSnapshot } from '../src/models/trade.js';

const T0 = Date.now();

function trade(partial: {
  timestamp: number;
  price: number;
  quoteValue: number;
  side: 'BUY' | 'SELL';
  tradeId: number;
}): MarketTrade {
  const { price, quoteValue } = partial;
  return {
    symbol: 'BTCUSDT',
    marketType: 'perp',
    timestamp: partial.timestamp,
    price,
    quantity: quoteValue / price,
    quoteValue,
    side: partial.side,
    isAggressiveBuy: partial.side === 'BUY',
    isAggressiveSell: partial.side === 'SELL',
    tradeId: partial.tradeId,
  };
}

function book(timestamp: number, mid: number, askQuote = 2_000_000): OrderBookSnapshot {
  const bid = mid * 0.999;
  const ask = mid * 1.001;
  return {
    symbol: 'BTCUSDT',
    marketType: 'perp',
    timestamp,
    lastUpdateId: 1,
    bids: [{ price: bid, quantity: 5_000_000 / bid, quoteValue: 5_000_000 }],
    asks: [{ price: ask, quantity: askQuote / ask, quoteValue: askQuote }],
  };
}

function printSnapshot(label: string, snap: ReturnType<OrderFlowEngine['snapshot']>): void {
  console.log(`\n── ${label} ──`);
  console.log(`  state:        ${snap.state}`);
  console.log(`  price:        ${snap.price.toFixed(2)} (${snap.priceChangePercent >= 0 ? '+' : ''}${snap.priceChangePercent.toFixed(3)}%)`);
  console.log(`  delta:        ${formatQuote(snap.delta)} (${(snap.deltaPercent * 100).toFixed(1)}%)`);
  console.log(`  buy / sell:   ${formatQuote(snap.aggressiveBuyVolume)} / ${formatQuote(snap.aggressiveSellVolume)}`);
  console.log(`  largest buy:  ${formatQuote(snap.largestBuy)}`);
  console.log(`  burst:        buy=${snap.buyBurstDetected} sell=${snap.sellBurstDetected}`);
  console.log(`  persistent:   buy=${snap.persistentBuyFlow} sell=${snap.persistentSellFlow}`);
  console.log(`  impact:       ${snap.priceImpactEfficiency}`);
  console.log(`  absorption:   ${snap.absorption.detected ? snap.absorption.type : 'none'}`);
  console.log(`  score:        ${snap.largeFlowDirectionalScore} (confidence ${(snap.confidence * 100).toFixed(0)}%)`);
}

function runScenario(
  engine: OrderFlowEngine,
  name: string,
  run: (sym: ReturnType<OrderFlowEngine['getSymbol']>) => number,
): void {
  console.log('\n' + '='.repeat(60));
  console.log(name);
  console.log('='.repeat(60));
  const sym = engine.getSymbol('BTCUSDT', 'perp');
  const endTs = run(sym);
  printSnapshot('10s window', sym.snapshot('10s', endTs));

  const largeEvents: string[] = [];
  sym.on((ev) => {
    if (ev.kind === 'large_trade') {
      largeEvents.push(
        `${ev.event.type} ${formatQuote(ev.event.quoteValue)} @ ${ev.event.price} tier ${ev.event.tier}`,
      );
    }
  });
  // re-run once to collect events for tape display
  const tape = sym.formatTape({ minQuoteValue: 500_000 });
  if (tape.split('\n').length > 1) {
    console.log('\n  Large-trade tape:');
    console.log(tape.split('\n').map((l) => '  ' + l).join('\n'));
  }
}

const engine = new OrderFlowEngine();

// A — one massive buy
runScenario(engine, 'A. One massive aggressive buy (thin asks)', (sym) => {
  sym.ingestBookSnapshot(book(T0, 100, 400_000));
  sym.ingestTrade(trade({ timestamp: T0 + 10, price: 102, quoteValue: 8_000_000, side: 'BUY', tradeId: 1 }));
  return T0 + 10;
});

// C — huge buying, no price lift (absorption)
runScenario(engine, 'C. Huge buying with almost no price response', (sym) => {
  const t0 = T0 + 100_000;
  sym.ingestBookSnapshot(book(t0, 100));
  for (let i = 0; i < 20; i++) {
    sym.ingestTrade(trade({ timestamp: t0 + i * 20, price: 100, quoteValue: 25_000_000, side: 'BUY', tradeId: 100 + i }));
    sym.ingestBookSnapshot(book(t0 + i * 20 + 1, 100));
  }
  return t0 + 19 * 20;
});

// B — split buys burst
runScenario(engine, 'B. Many split buys in 5 seconds', (sym) => {
  const t0 = T0 + 200_000;
  sym.seedFlowBaseline('BUY', Array.from({ length: 200 }, () => 40_000));
  sym.ingestBookSnapshot(book(t0, 100));
  for (let i = 0; i < 80; i++) {
    sym.ingestTrade(
      trade({
        timestamp: t0 + i * 60,
        price: 100 + i * 0.02,
        quoteValue: 120_000 + (i % 4) * 80_000,
        side: 'BUY',
        tradeId: 200 + i,
      }),
    );
  }
  return t0 + 79 * 60;
});

console.log('\nDone. Run `npm run demo:live` for real Binance data.\n');
