import type { LiquidityResponseConfig } from '../config/types.js';
import type { MicrostructureState } from '../models/liquidity-response.js';

export class StatePersistenceEngine {
  private state: MicrostructureState = 'NO_DIRECTIONAL_EDGE';
  private since = 0;
  private askDefend = 0;
  private bidDefend = 0;

  constructor(private readonly config: LiquidityResponseConfig) {}

  stabilize(
    now: number,
    candidate: MicrostructureState,
    strength: number,
    confidenceScore: number,
  ): MicrostructureState {
    if (candidate === this.state) {
      this.bumpDefense(candidate);
      return this.state;
    }

    const opposite = isOpposite(this.state, candidate);
    const heldMs = this.since > 0 ? now - this.since : 0;
    const strong = strength >= this.config.persistMinStrength && confidenceScore >= 55;

    if (isControl(this.state) && candidate !== this.state) {
      if (opposite && !strong) {
        this.bumpDefense(this.state);
        return this.state;
      }
      if (
        (candidate === 'NO_DIRECTIONAL_EDGE' || candidate === 'BALANCED' || candidate === 'TRANSITION') &&
        heldMs < this.config.persistMs &&
        !strong
      ) {
        this.bumpDefense(this.state);
        return this.state;
      }
    }

    if (this.state === 'PASSIVE_SELLERS_DEFENDING' && candidate === 'BUYERS_BEING_ABSORBED') {
      this.askDefend += 1;
      if (this.askDefend >= this.config.defendEscalateCount) {
        this.commit(now, 'BUYERS_BEING_ABSORBED');
        return this.state;
      }
      return this.state;
    }
    if (this.state === 'PASSIVE_BUYERS_DEFENDING' && candidate === 'SELLERS_BEING_ABSORBED') {
      this.bidDefend += 1;
      if (this.bidDefend >= this.config.defendEscalateCount) {
        this.commit(now, 'SELLERS_BEING_ABSORBED');
        return this.state;
      }
      return this.state;
    }

    this.commit(now, candidate);
    this.bumpDefense(candidate);
    return this.state;
  }

  escalateDefense(candidate: MicrostructureState): MicrostructureState {
    if (candidate === 'PASSIVE_SELLERS_DEFENDING' && this.askDefend >= this.config.defendEscalateCount) {
      return 'BUYERS_BEING_ABSORBED';
    }
    if (candidate === 'PASSIVE_BUYERS_DEFENDING' && this.bidDefend >= this.config.defendEscalateCount) {
      return 'SELLERS_BEING_ABSORBED';
    }
    return candidate;
  }

  get current(): MicrostructureState {
    return this.state;
  }

  private commit(now: number, state: MicrostructureState): void {
    this.state = state;
    this.since = now;
    if (state !== 'PASSIVE_SELLERS_DEFENDING' && state !== 'BUYERS_BEING_ABSORBED') this.askDefend = 0;
    if (state !== 'PASSIVE_BUYERS_DEFENDING' && state !== 'SELLERS_BEING_ABSORBED') this.bidDefend = 0;
  }

  private bumpDefense(state: MicrostructureState): void {
    if (state === 'PASSIVE_SELLERS_DEFENDING' || state === 'BUYERS_BEING_ABSORBED') this.askDefend += 1;
    if (state === 'PASSIVE_BUYERS_DEFENDING' || state === 'SELLERS_BEING_ABSORBED') this.bidDefend += 1;
  }
}

function isControl(state: MicrostructureState): boolean {
  return state === 'BUYERS_IN_CONTROL' || state === 'SELLERS_IN_CONTROL';
}

function isOpposite(a: MicrostructureState, b: MicrostructureState): boolean {
  return (
    (a === 'BUYERS_IN_CONTROL' && b === 'SELLERS_IN_CONTROL') ||
    (a === 'SELLERS_IN_CONTROL' && b === 'BUYERS_IN_CONTROL')
  );
}
