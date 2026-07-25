import { describe, expect, it, vi } from 'vitest';

import type { ByosSyncRuntimeOutcome } from './byosSyncRuntime';
import {
  createSyncRuntimeMessageListener,
  isSyncRuntimeCredentialsInvalidatedMessage,
  isSyncRuntimeInvalidateCredentialsMessage,
  isSyncRuntimeStatusMessage,
  isSyncRuntimeTriggerMessage,
  requestSyncCredentialInvalidation,
  requestSyncFollowUp,
  SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
  SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
  SYNC_RUNTIME_STATUS_MESSAGE,
  SYNC_RUNTIME_TRIGGER_MESSAGE,
  SyncRuntimeMessageError,
  SyncRuntimeMessagePort,
  type SyncRuntimeResponseMessage,
} from './syncRuntimeMessages';

const OUTCOME: ByosSyncRuntimeOutcome = {
  status: 'synced',
  uploaded: 1,
  downloaded: 2,
  unchanged: 3,
  conflicts: 0,
  failed: 0,
  pending: 0,
};

describe('sync runtime message protocol', () => {
  it.each([
    {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'panel-open',
    },
    {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'local-mutation',
    },
    {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'connection',
    },
    {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'identity-migration',
    },
  ])('accepts an exact trigger message %#', (message) => {
    expect(isSyncRuntimeTriggerMessage(message)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { type: SYNC_RUNTIME_TRIGGER_MESSAGE },
    { type: SYNC_RUNTIME_TRIGGER_MESSAGE, reason: 'manual' },
    {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'panel-open',
      token: 'must-not-be-accepted',
    },
  ])('rejects a non-exact trigger message %#', (message) => {
    expect(isSyncRuntimeTriggerMessage(message)).toBe(false);
  });

  it('validates an exact sanitized status response', () => {
    const message = {
      type: SYNC_RUNTIME_STATUS_MESSAGE,
      outcome: OUTCOME,
    };

    expect(isSyncRuntimeStatusMessage(message)).toBe(true);
    expect(
      isSyncRuntimeStatusMessage({
        ...message,
        outcome: { ...OUTCOME, noteTitle: 'must not pass' },
      }),
    ).toBe(false);
    expect(
      isSyncRuntimeStatusMessage({
        ...message,
        outcome: { ...OUTCOME, pending: -1 },
      }),
    ).toBe(false);
  });

  it('accepts only exact internal credential invalidation messages and acknowledgements', () => {
    expect(
      isSyncRuntimeInvalidateCredentialsMessage({
        type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
      }),
    ).toBe(true);
    expect(
      isSyncRuntimeInvalidateCredentialsMessage({
        type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
        token: 'must-not-pass',
      }),
    ).toBe(false);
    expect(
      isSyncRuntimeCredentialsInvalidatedMessage({
        type: SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
      }),
    ).toBe(true);
    expect(
      isSyncRuntimeCredentialsInvalidatedMessage({
        type: SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
        status: 'extra',
      }),
    ).toBe(false);
  });

  it('routes a valid request and returns an immutable sanitized response', async () => {
    const trigger = vi.fn(() => Promise.resolve(OUTCOME));
    const invalidateCredentials = vi.fn();
    const listener = createSyncRuntimeMessageListener({
      invalidateCredentials,
      trigger,
    });
    const sendResponse =
      vi.fn<(response: SyncRuntimeResponseMessage) => void>();

    const retained = listener(
      { type: SYNC_RUNTIME_TRIGGER_MESSAGE, reason: 'panel-open' },
      {},
      sendResponse,
    );

    expect(retained).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        type: SYNC_RUNTIME_STATUS_MESSAGE,
        outcome: OUTCOME,
      });
    });
    expect(trigger).toHaveBeenCalledOnce();
    const response = sendResponse.mock.calls[0]?.[0];
    expect(isSyncRuntimeStatusMessage(response)).toBe(true);

    if (!isSyncRuntimeStatusMessage(response)) {
      throw new Error('Expected a runtime status response.');
    }

    expect(Object.isFrozen(response.outcome)).toBe(true);
    expect(invalidateCredentials).not.toHaveBeenCalled();
  });

  it('invalidates a connection trigger and sanitizes an unexpected runtime rejection', async () => {
    const trigger = vi.fn(() =>
      Promise.reject(
        new Error('secret note body https://private.example oauth-token'),
      ),
    );
    const invalidateCredentials = vi.fn();
    const listener = createSyncRuntimeMessageListener({
      invalidateCredentials,
      trigger,
    });
    const sendResponse = vi.fn();

    expect(listener({ type: 'other' }, {}, sendResponse)).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
    expect(
      listener(
        { type: SYNC_RUNTIME_TRIGGER_MESSAGE, reason: 'connection' },
        {},
        sendResponse,
      ),
    ).toBe(true);
    expect(invalidateCredentials).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });
    expect(JSON.stringify(sendResponse.mock.calls)).not.toMatch(
      /secret|note body|private\.example|oauth-token/iu,
    );
  });

  it('invalidates worker credentials synchronously without accepting extra fields', () => {
    const invalidateCredentials = vi.fn();
    const listener = createSyncRuntimeMessageListener({
      invalidateCredentials,
      trigger: vi.fn(() => Promise.resolve(OUTCOME)),
    });
    const sendResponse = vi.fn();

    expect(
      listener(
        { type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE },
        {},
        sendResponse,
      ),
    ).toBe(false);
    expect(invalidateCredentials).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({
      type: SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
    });
    expect(
      listener(
        {
          type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
          accessToken: 'must-not-pass',
        },
        {},
        sendResponse,
      ),
    ).toBe(false);
    expect(invalidateCredentials).toHaveBeenCalledOnce();
  });

  it('sends the exact trigger and rejects malformed or failed responses with one stable error', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        type: SYNC_RUNTIME_STATUS_MESSAGE,
        outcome: OUTCOME,
      })
      .mockResolvedValueOnce({ token: 'malformed response' })
      .mockRejectedValueOnce(new Error('secret transport detail'));
    const port = new SyncRuntimeMessagePort({ send });

    await expect(port.request('local-mutation')).resolves.toEqual(OUTCOME);
    expect(send).toHaveBeenNthCalledWith(1, {
      type: SYNC_RUNTIME_TRIGGER_MESSAGE,
      reason: 'local-mutation',
    });
    await expect(port.request('panel-open')).rejects.toBeInstanceOf(
      SyncRuntimeMessageError,
    );
    await expect(port.request('connection')).rejects.toMatchObject({
      message: 'PagePerch synchronization could not be requested.',
    });
  });

  it('contains follow-up messaging failures so completed actions stay successful', async () => {
    const request = vi.fn(() =>
      Promise.reject(new Error('secret messaging failure')),
    );

    await expect(
      requestSyncFollowUp({ request }, 'identity-migration'),
    ).resolves.toBeUndefined();
  });

  it('sends and validates credential invalidation while containing missing-worker failures', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        type: SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
      })
      .mockResolvedValueOnce({ type: 'malformed-ack' });
    const port = new SyncRuntimeMessagePort({ send });

    await expect(port.invalidateCredentials()).resolves.toBeUndefined();
    expect(send).toHaveBeenNthCalledWith(1, {
      type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
    });
    await expect(port.invalidateCredentials()).rejects.toBeInstanceOf(
      SyncRuntimeMessageError,
    );
    await expect(
      requestSyncCredentialInvalidation({
        invalidateCredentials: () =>
          Promise.reject(new Error('worker unavailable secret')),
      }),
    ).resolves.toBeUndefined();
  });
});
