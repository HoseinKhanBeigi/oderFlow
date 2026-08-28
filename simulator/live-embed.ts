import type { MarketSimulationState } from '../src/simulation/types.js';

export interface LiveSimulatorHandle {
  setState(state: MarketSimulationState | null): void;
  destroy(): void;
}

/**
 * Compact live microstructure strip — not a physics / game renderer.
 */
export function mountLiveSimulator(parent: HTMLElement): LiveSimulatorHandle {
  parent.innerHTML = `
    <div class="live-micro">
      <div>
        <div class="muted">Aggressive buy vs sell</div>
        <div class="bar-track" id="lm-flow"><i class="buy" style="width:50%"></i><i class="sell" style="width:50%"></i></div>
      </div>
      <div>
        <div class="muted">Bid vs ask depth</div>
        <div class="bar-track" id="lm-book"><i class="buy" style="width:50%"></i><i class="sell" style="width:50%"></i></div>
      </div>
      <div>Price <strong id="lm-px">—</strong></div>
      <div>Delta <strong id="lm-delta">—</strong></div>
      <div>Efficiency <strong id="lm-eff">—</strong></div>
      <div>State <strong id="lm-st">—</strong></div>
    </div>`;

  const flow = parent.querySelector('#lm-flow') as HTMLElement;
  const book = parent.querySelector('#lm-book') as HTMLElement;
  const px = parent.querySelector('#lm-px') as HTMLElement;
  const delta = parent.querySelector('#lm-delta') as HTMLElement;
  const eff = parent.querySelector('#lm-eff') as HTMLElement;
  const st = parent.querySelector('#lm-st') as HTMLElement;

  return {
    setState(state) {
      if (!state) return;
      const buy = Math.max(0, state.aggressiveBuy);
      const sell = Math.max(0, state.aggressiveSell);
      const tot = buy + sell || 1;
      (flow.children[0] as HTMLElement).style.width = `${(buy / tot) * 100}%`;
      (flow.children[1] as HTMLElement).style.width = `${(sell / tot) * 100}%`;
      const bd = Math.max(0, state.bidDepth);
      const ad = Math.max(0, state.askDepth);
      const dt = bd + ad || 1;
      (book.children[0] as HTMLElement).style.width = `${(bd / dt) * 100}%`;
      (book.children[1] as HTMLElement).style.width = `${(ad / dt) * 100}%`;
      px.textContent = state.price >= 1000 ? `$${state.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${state.price.toFixed(2)}`;
      delta.textContent = fmt(state.delta);
      eff.textContent = state.priceEfficiency;
      st.textContent = state.marketState.replace(/_/g, ' ');
    },
    destroy() {
      parent.innerHTML = '';
    },
  };
}

function fmt(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(0)}`;
}

declare global {
  interface Window {
    mountLiveSimulator: typeof mountLiveSimulator;
  }
}

window.mountLiveSimulator = mountLiveSimulator;
