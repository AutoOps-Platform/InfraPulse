import type { Clock } from '../../src/common/clock.js';

export class TestClock implements Clock {
  constructor(
    private wall = 0,
    private monotonic = 0,
  ) {}
  nowMs(): number {
    return this.wall;
  }
  monotonicMs(): number {
    return this.monotonic;
  }
  advance(ms: number): void {
    this.wall += ms;
    this.monotonic += ms;
  }
  setWall(ms: number): void {
    this.wall = ms;
  }
}
