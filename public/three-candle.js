/**
 * Last-3-candle footprint read for the dashboard.
 *
 * Same rules as src/footprint/structure.ts: find the largest ask-side cluster,
 * then ask whether later candles defended it or collapsed through it.
 */
const LAST_N = 3;
const DEFEND_RATIO = 0.45;
const CLUSTER_SHARE = 0.25;
const CLUSTER_LEAD = 1.2;
const DISPLAY_LEVELS = 5;
const FLAT_ATTACK = 10;

export function readThreeCandleFootprint(bars) {
  if (!bars?.length) return null;
  const window = bars.slice(-LAST_N).map(normalizeBar);
  const momentum = readAttackMomentum(window);
  const cluster = findAskCluster(window);
  const candles = window.map((bar) => ({
    t: bar.time,
    delta: bar.totalBuy - bar.totalSell,
    levels: selectLevels(bar.levels, cluster?.price),
  }));

  if (!cluster) {
    return {
      candles,
      askCluster: null,
      subsequentBid: 0,
      subsequentAsk: 0,
      defense: 'unobserved',
      structure: 'indeterminate',
      why: 'No sell-dominant ask cluster in the last 3 candles.',
      momentum,
    };
  }

  const later = window.slice(cluster.index + 1);
  if (!later.length) {
    return {
      candles,
      askCluster: toCluster(cluster),
      subsequentBid: 0,
      subsequentAsk: 0,
      defense: 'unobserved',
      structure: 'indeterminate',
      why: `Largest ask cluster ${fmtUsd(cluster.ask)} at ${cluster.price} is on the latest candle — no subsequent bar to judge defense.`,
      momentum,
    };
  }

  const tick = tickSize(cluster.price);
  const near = volumeNear(later, cluster.price, tick);
  const last = window[window.length - 1];
  const clusterBar = window[cluster.index];
  const laterHigh = maxOf(later, (b) => b.high);
  const laterLow = minOf(later, (b) => b.low);
  const threeHigh = maxOf(window, (b) => b.high);
  const laterDelta = later.reduce((s, b) => s + (b.totalBuy - b.totalSell), 0);

  const acceptedBelow = last.close < cluster.price - tick;
  const held = last.close >= cluster.price - tick;
  const gappedDown = laterHigh < cluster.price - tick;
  const gappedUp = laterLow > cluster.price + tick;
  const atHigh = cluster.price >= threeHigh - 2 * tick;
  const madeNewHigh = laterHigh > clusterBar.high + tick;
  const bidRatio = cluster.ask > 0 ? near.buy / cluster.ask : 0;
  const volumeDefended = near.buy >= near.sell && bidRatio >= DEFEND_RATIO;
  const volumeCollapsed = near.buy < near.sell && bidRatio < DEFEND_RATIO;

  const defense = resolveDefense({
    volumeDefended,
    volumeCollapsed,
    gappedUp,
    gappedDown,
    acceptedBelow,
    held,
  });
  const structure = resolveStructure({
    defense,
    held,
    acceptedBelow,
    atHigh,
    madeNewHigh,
    gappedDown,
    laterDelta,
  });

  const laterLabel = later.length === 1 ? 'next candle' : `next ${later.length} candles`;
  return {
    candles,
    askCluster: toCluster(cluster),
    subsequentBid: near.buy,
    subsequentAsk: near.sell,
    defense,
    structure,
    why:
      `Largest ask cluster ${fmtUsd(cluster.ask)} at ${cluster.price} (bid ${fmtUsd(cluster.bid)}). ` +
      `${laterLabel} printed ${fmtUsd(near.buy)} bid × ${fmtUsd(near.sell)} ask there and closed ${last.close}. ` +
      `Defense ${defense} → ${structure}.`,
      momentum,
  };
}

export function renderLast3(host, read, opts = {}) {
  if (!host) return;
  if (!read) {
    host.innerHTML = `<div class="last3-empty">Waiting for footprint…</div>`;
    host.dataset.structure = '';
    return;
  }

  const tf = opts.tfMinutes ? `${opts.tfMinutes}m` : '';
  const cluster = read.askCluster;
  const clusterHtml = cluster
    ? `<div class="last3-cluster">
        <span>ASK CLUSTER <strong>${fmtPrice(cluster.price)}</strong> @ ${fmtHm(cluster.t)}</span>
        <span>${fmtUsd(cluster.ask)} ask vs ${fmtUsd(cluster.bid)} bid</span>
        <span class="last3-def last3-def-${read.defense}">${read.defense} · subsequent ${fmtUsd(read.subsequentBid)} bid × ${fmtUsd(read.subsequentAsk)} ask</span>
      </div>`
    : `<div class="last3-cluster last3-cluster-none">No sell-dominant ask cluster</div>`;

  const candles = read.candles
    .map((c) => {
          const levels = displayLevels(c.levels, cluster?.price)
            .map(([p, bid, ask]) => {
          const mark = cluster && p === cluster.price ? ' is-cluster' : '';
          return `<div class="last3-lv${mark}"><span>${fmtPrice(p)}</span><span>${fmtUsd(bid)} × ${fmtUsd(ask)}</span></div>`;
        })
        .join('');
      const deltaCls = c.delta >= 0 ? 'pos' : 'neg';
      return `<div class="last3-bar">
        <div class="last3-bar-head"><span>${fmtHm(c.t)}</span><span class="${deltaCls}">Δ ${fmtUsd(c.delta)}</span></div>
        ${levels || '<div class="last3-lv muted">no levels</div>'}
      </div>`;
    })
    .join('');

  host.dataset.structure = read.structure;
  host.dataset.momentum = read.momentum?.state ?? '';
  host.innerHTML = `
    <div class="last3-head">
      <h3>Last 3 candles${tf ? ` · ${tf}` : ''}</h3>
      <span class="last3-structure last3-structure-${read.structure}">${read.structure}</span>
    </div>
    ${clusterHtml}
    <div class="last3-candles">${candles}</div>
    <p class="last3-why">${escapeHtml(read.why)}</p>
    ${momentumHtml(read.momentum)}
  `;
}

function momentumHtml(m) {
  if (!m) return '';
  const fmt = (n) => (n == null ? 'n/a' : n > 0 ? `+${n}` : String(n));
  const [a, b, c] = m.scores;
  const from = m.priceFrom == null ? 'n/a' : fmtPrice(m.priceFrom);
  const to = m.priceTo == null ? 'n/a' : fmtPrice(m.priceTo);
  const pct = `${m.priceChangePercent >= 0 ? '+' : ''}${Number(m.priceChangePercent).toFixed(3)}%`;
  return `<div class="last3-momentum last3-momentum-${m.state}">
    <div class="last3-momentum-row">
      <span>ATTACK</span>
      <span>3 ago ${fmt(a)} · 2 ago ${fmt(b)} · now ${fmt(c)}</span>
    </div>
    <div class="last3-momentum-row">
      <span>PRICE</span>
      <span>${from} → ${to} (${pct})</span>
    </div>
    <div class="last3-momentum-row">
      <span class="last3-momentum-state">${m.state}</span>
      <span>${escapeHtml(m.implies)}</span>
    </div>
  </div>`;
}

function normalizeBar(bar) {
  const levels = levelsOf(bar);
  return {
    time: bar.time,
    open: Number(bar.open) || Number(bar.close) || 0,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    totalBuy: Number(bar.totalBuy) || levels.reduce((s, l) => s + (l.buy || 0), 0),
    totalSell: Number(bar.totalSell) || levels.reduce((s, l) => s + (l.sell || 0), 0),
    levels,
  };
}

function levelsOf(bar) {
  if (!bar?.levels) return [];
  if (bar.levels instanceof Map) return [...bar.levels.values()];
  if (Array.isArray(bar.levels)) return bar.levels;
  return Object.values(bar.levels);
}

function readAttackMomentum(bars) {
  const window = bars.slice(-LAST_N);
  const raw = window.map(attackScore);
  const scores = [
    raw.length >= 3 ? raw[raw.length - 3] : null,
    raw.length >= 2 ? raw[raw.length - 2] : null,
    raw.length >= 1 ? raw[raw.length - 1] : null,
  ];
  const first = window[0];
  const last = window[window.length - 1];
  const priceFrom = first ? first.open : null;
  const priceTo = last ? last.close : null;
  const priceChangePercent =
    priceFrom != null && priceTo != null && priceFrom > 0 ? ((priceTo - priceFrom) / priceFrom) * 100 : 0;

  if (scores[0] == null || scores[2] == null || priceFrom == null || priceTo == null) {
    return {
      scores,
      priceFrom,
      priceTo,
      priceChangePercent: Number(priceChangePercent.toFixed(3)),
      state: 'flat',
      implies: 'Need 3 candles to judge whether attack is building into price.',
    };
  }

  const a = scores[0];
  const b = scores[1] ?? a;
  const c = scores[2];
  const attackChange = c - a;
  const tick = tickSize(priceFrom);
  const priceUp = priceTo > priceFrom + tick;
  const priceDown = priceTo < priceFrom - tick;
  const attackQuiet = Math.abs(attackChange) < FLAT_ATTACK && Math.abs(c - b) < FLAT_ATTACK;
  const priceQuiet = !priceUp && !priceDown;

  let state;
  if (attackQuiet && priceQuiet) state = 'flat';
  else if (!attackQuiet && ((attackChange > 0 && priceUp) || (attackChange < 0 && priceDown))) state = 'building';
  else state = 'diverging';

  const fmt = (n) => (n > 0 ? `+${n}` : String(n));
  const scoreLine = `Attack 3 ago ${fmt(a)}, 2 ago ${fmt(b)}, current ${fmt(c)}.`;
  const priceLine = `Price ${priceFrom} → ${priceTo} (${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(3)}%).`;
  const label = `momentum_state = ${state}.`;
  const side = attackChange > 0 || (attackChange === 0 && c >= 0) ? 'Buy' : 'Sell';
  let implies;
  if (state === 'building') {
    implies = `${scoreLine} ${priceLine} ${label} ${side} attack is expanding with price — continuation; fading this fights the tape.`;
  } else if (state === 'diverging') {
    implies = `${scoreLine} ${priceLine} ${label} Attack and price disagree — effort without result (absorption) or a move without follow-through; wait.`;
  } else {
    implies = `${scoreLine} ${priceLine} ${label} Attack is not trending — no momentum edge on this setup.`;
  }

  return {
    scores,
    priceFrom,
    priceTo,
    priceChangePercent: Number(priceChangePercent.toFixed(3)),
    state,
    implies,
  };
}

function attackScore(bar) {
  const total = bar.totalBuy + bar.totalSell;
  if (!(total > 0)) return 0;
  return Math.round(((bar.totalBuy - bar.totalSell) / total) * 100);
}

function findAskCluster(bars) {
  const candidates = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    for (const level of bar.levels) {
      if (level.sell <= 0 || level.sell <= level.buy) continue;
      candidates.push({ index: i, price: level.price, ask: level.sell, bid: level.buy, t: bar.time });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ask - a.ask || a.bid - b.bid || a.index - b.index);
  const best = candidates[0];
  const secondAsk = candidates[1]?.ask ?? 0;
  const clustered = best.ask >= bars[best.index].totalSell * CLUSTER_SHARE || best.ask >= secondAsk * CLUSTER_LEAD;
  return clustered ? best : null;
}

function selectLevels(levels, clusterPrice) {
  const withVolume = levels.filter((l) => l.buy > 0 || l.sell > 0);
  return [...withVolume]
    .sort((a, b) => b.price - a.price)
    .map((l) => [l.price, l.buy, l.sell]);
}

function volumeNear(bars, price, tick) {
  let buy = 0;
  let sell = 0;
  for (const bar of bars) {
    for (const level of bar.levels) {
      if (Math.abs(level.price - price) <= tick + 1e-9) {
        buy += level.buy;
        sell += level.sell;
      }
    }
  }
  return { buy, sell };
}

function resolveDefense(input) {
  if (input.gappedDown || (input.acceptedBelow && !input.volumeDefended)) return 'collapsed';
  if (input.volumeDefended || input.gappedUp) return 'defended';
  if (input.held && !input.volumeCollapsed) return 'defended';
  if (input.volumeCollapsed) return 'collapsed';
  return 'unobserved';
}

function resolveStructure(input) {
  if (input.defense === 'defended' && input.held) return 'absorption';
  if (input.atHigh && !input.madeNewHigh && !input.held && input.laterDelta <= 0 && !input.gappedDown) {
    return 'distribution';
  }
  if (input.acceptedBelow && input.defense === 'collapsed') return 'breakout';
  if (input.atHigh && !input.madeNewHigh && input.laterDelta < 0 && input.defense !== 'defended') {
    return 'distribution';
  }
  return 'indeterminate';
}

function toCluster(cluster) {
  return { price: cluster.price, t: cluster.t, ask: cluster.ask, bid: cluster.bid };
}

function displayLevels(levels, clusterPrice) {
  if (levels.length <= DISPLAY_LEVELS) return levels;
  const ranked = [...levels].sort((a, b) => b[1] + b[2] - (a[1] + a[2]));
  const top = ranked.slice(0, DISPLAY_LEVELS);
  if (clusterPrice != null && !top.some((l) => l[0] === clusterPrice)) {
    const cluster = levels.find((l) => l[0] === clusterPrice);
    if (cluster) top[top.length - 1] = cluster;
  }
  return top.sort((a, b) => b[0] - a[0]);
}

function maxOf(bars, pick) {
  let max = -Infinity;
  for (const bar of bars) max = Math.max(max, pick(bar));
  return max;
}

function minOf(bars, pick) {
  let min = Infinity;
  for (const bar of bars) min = Math.min(min, pick(bar));
  return min;
}

function tickSize(price) {
  if (price >= 10000) return 10;
  if (price >= 1000) return 1;
  if (price >= 100) return 0.5;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  return 0.001;
}

function fmtUsd(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPrice(p) {
  if (p >= 100) return Number(p).toFixed(2);
  if (p >= 1) return Number(p).toFixed(3);
  return Number(p).toFixed(5);
}

function fmtHm(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
