import { describe, expect, it } from 'vitest';

import {
  calculateSyncRetryDelayMs,
  SYNC_RETRY_BASE_DELAY_MS,
  SYNC_RETRY_MAX_ATTEMPT_COUNT,
  SYNC_RETRY_MAX_DELAY_MS,
  SyncQueueError,
} from './syncQueue';

describe('sync retry schedule', () => {
  it('grows exponentially, applies bounded positive jitter, and saturates', () => {
    expect(calculateSyncRetryDelayMs(1, 0)).toBe(SYNC_RETRY_BASE_DELAY_MS);
    expect(calculateSyncRetryDelayMs(2, 0)).toBe(SYNC_RETRY_BASE_DELAY_MS * 2);
    expect(calculateSyncRetryDelayMs(2, 0.5)).toBe(
      SYNC_RETRY_BASE_DELAY_MS * 3,
    );
    expect(
      calculateSyncRetryDelayMs(SYNC_RETRY_MAX_ATTEMPT_COUNT, 0.999_999),
    ).toBe(SYNC_RETRY_MAX_DELAY_MS);
  });

  it.each([
    [0, 0],
    [1.5, 0],
    [SYNC_RETRY_MAX_ATTEMPT_COUNT + 1, 0],
    [1, -0.01],
    [1, 1],
    [1, Number.NaN],
  ])('rejects invalid attempt/random input (%s, %s)', (attempt, random) => {
    expect(() => calculateSyncRetryDelayMs(attempt, random)).toThrow(
      SyncQueueError,
    );
    expect(() => calculateSyncRetryDelayMs(attempt, random)).toThrow(
      'Sync retry scheduling input is invalid.',
    );
  });
});
