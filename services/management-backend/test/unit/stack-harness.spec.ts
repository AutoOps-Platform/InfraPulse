import { startIfOptedIn, boundedSend, IsolatedStack } from '../support/stack-harness.js';

// Breaks caught: collection/default execution invokes lifecycle; an opted-in
// prerequisite error becomes a skip; retries rebuild bytes or overrun deadline.
describe('Task13 full absence observation window', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it.each(['absent', 'forwarded', 'query error'] as const)(
    'queries immediately and at the full30s deadline: %s',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      const stack = new IsolatedStack();
      const queriedAt: number[] = [];
      const vector = vi.spyOn(stack, 'vector').mockImplementation(async () => {
        queriedAt.push(performance.now());
        if (performance.now() >= 30_000) {
          if (outcome === 'query error') throw new Error('query unavailable');
          if (outcome === 'forwarded') return [{}];
        }
        return [];
      });
      const capture = vi.spyOn(stack, 'capture').mockReturnValue('unused');
      const observation = stack.absent('offline-run');
      const assertion = outcome === 'absent'
        ? expect(observation).resolves.toBeUndefined()
        : expect(observation).rejects.toThrow(
          outcome === 'forwarded' ? 'unexpectedly forwarded' : 'query unavailable',
        );
      expect(queriedAt).toEqual([0]);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(queriedAt.at(-1)).toBe(30_000);
      expect(vector).toHaveBeenCalledTimes(61);
      expect(vector).toHaveBeenLastCalledWith('infrapulse_e2e_value{run_id="offline-run"}');
      if (outcome === 'absent') {
        expect(capture).toHaveBeenCalledExactlyOnceWith('absence-window', JSON.stringify({
          run_id: 'offline-run', elapsed_ms: 30_000, queries: 61,
        }));
      } else expect(capture).not.toHaveBeenCalled();
    },
  );
});

describe('Task13 offline lifecycle and immutable bounded sender', () => {
  it('performs no lifecycle work without the exact opt-in', async () => {
    let calls = 0;
    const start = async () => { calls++; return { ready: true }; };
    expect(await startIfOptedIn({}, start)).toBeNull();
    expect(await startIfOptedIn({ INFRAPULSE_RUN_MANAGEMENT_E2E: 'true' }, start)).toBeNull();
    expect(calls).toBe(0);
  });
  it('propagates opted prerequisite failures rather than skipping', async () => {
    await expect(startIfOptedIn({ INFRAPULSE_RUN_MANAGEMENT_E2E: '1' }, async () => {
      throw new Error('isolated prerequisite failed');
    })).rejects.toThrow('isolated prerequisite failed');
  });
  it('retries the same immutable bytes at most three times', async () => {
    let now = 0;
    const original = new Uint8Array([1, 2, 3]);
    const bodies: number[][] = [];
    const result = await boundedSend(original, async (body) => {
      bodies.push([...body]); original[0] = 99;
      return { status: bodies.length === 3 ? 204 : 503 };
    }, { now: () => now, pause: async (ms) => { now += ms; }, deadlineMs: 10_000 });
    expect(result.status).toBe(204);
    expect(bodies).toEqual([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
  });
  it('never retries terminal refusals', async () => {
    let calls = 0;
    expect((await boundedSend(new Uint8Array(), async () => {
      calls++; return { status: 401 };
    })).status).toBe(401);
    expect(calls).toBe(1);
  });
  it('does not start another attempt when its total deadline is spent', async () => {
    let now = 0, calls = 0;
    const result = await boundedSend(new Uint8Array([7]), async () => {
      calls++; now += 600; return { status: 503 };
    }, { now: () => now, pause: async (ms) => { now += ms; }, deadlineMs: 1000 });
    expect(result.status).toBe(503);
    expect(calls).toBe(1);
    expect(now).toBeLessThanOrEqual(1000);
  });
});
