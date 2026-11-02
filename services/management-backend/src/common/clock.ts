import { performance } from 'node:perf_hooks';

export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
export const systemClock: Clock = Object.freeze({
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
});
