/**
 * The unit of work (docs/design/T-019.md §2.6, §4.3).
 *
 * Failures are VALUES here, not exceptions: `withDeal` never throws, and the
 * memory factory's `commit()` is a documented no-op rather than a pretence.
 */

import { describe, expect, it } from 'vitest';

import {
  apiError,
  createMemoryStoreSessionFactory,
  runWithSession,
  sessionUnavailable,
  type ApiResult,
  type DealHandle,
  type StoreSession,
} from '../src/index.js';
import { memoryContainer } from './fixtures/harness.js';

const handle = {
  deal_id: 'deal-1',
  action: 'write',
  account: { scope: { account_id: 'account-a' }, role: 'owner', source: 'test', request_id: 'r' },
  scope: { account_id: 'account-a' },
} as unknown as DealHandle;

const fakeSession = (overrides: Partial<StoreSession> = {}): { session: StoreSession; log: string[] } => {
  const log: string[] = [];
  const session: StoreSession = {
    handle,
    store: {} as never,
    raw_payloads: {} as never,
    receipts: {} as never,
    commit: () => {
      log.push('commit');
      return Promise.resolve({ ok: true, value: undefined } as ApiResult<void>);
    },
    rollback: () => {
      log.push('rollback');
      return Promise.resolve();
    },
    ...overrides,
  };
  return { session, log };
};

describe('the memory factory (the ADR-008 default)', () => {
  it('opens a session only for a handle, and hands over ports', async () => {
    const container = await memoryContainer();
    const opened = await container.sessions.forDeal(handle);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.handle).toBe(handle);
      expect(typeof opened.value.store.putDeal).toBe('function');
      expect(typeof opened.value.raw_payloads.stash).toBe('function');
      expect(typeof opened.value.receipts.append).toBe('function');
    }
    await container.close();
  });

  it('commits as a no-op and says so, rather than pretending to be transactional', async () => {
    const factory = createMemoryStoreSessionFactory({
      store: {} as never,
      raw_payloads: {} as never,
      receiptsFor: () => ({}) as never,
    });
    expect(factory.mode).toBe('memory');
    const opened = await factory.forDeal(handle);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(await opened.value.commit()).toEqual({ ok: true, value: undefined });
  });

  it('binds the receipt store to the handle’s own scope', async () => {
    const scopes: string[] = [];
    const factory = createMemoryStoreSessionFactory({
      store: {} as never,
      raw_payloads: {} as never,
      receiptsFor: (scope) => {
        scopes.push(scope.account_id);
        return {} as never;
      },
    });
    await factory.forDeal(handle);
    expect(scopes).toEqual(['account-a']);
  });
});

describe('runWithSession — open, run, commit; rollback on failure', () => {
  it('commits after the callback and returns the value', async () => {
    const { session, log } = fakeSession();
    expect(await runWithSession(session, () => Promise.resolve(42))).toEqual({ ok: true, value: 42 });
    expect(log).toEqual(['commit']);
  });

  it('rolls back and never commits when the callback rejects', async () => {
    const { session, log } = fakeSession();
    const result = await runWithSession(session, () => Promise.reject(new Error('handler blew up')));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      // The thrown value rides `cause` and never the wire.
      expect(result.error.message).toBe('internal error');
    }
    expect(log).toEqual(['rollback']);
  });

  it('preserves an ApiError thrown by the callback instead of flattening it to internal', async () => {
    const { session } = fakeSession();
    const result = await runWithSession(session, () =>
      Promise.reject(Object.assign(new Error('conflict'), { api_error: apiError('conflict', 'already set') })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toBe('already set');
    }
  });

  it('rolls back when the commit itself fails', async () => {
    const { session, log } = fakeSession({
      commit: () => Promise.resolve({ ok: false, error: apiError('unavailable', 'temporarily unavailable') }),
    });
    const result = await runWithSession(session, () => Promise.resolve('written'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unavailable');
      // §4.4: `unavailable` is the one default-retryable code, and a 503 here
      // is retry-safe by construction (`ON CONFLICT DO NOTHING` keyed writes).
      expect(result.error.retryable).toBe(true);
    }
    expect(log).toEqual(['rollback']);
  });

  /**
   * The stated boundary of "never throws": `commit()` is contractually a
   * `Promise<ApiResult<void>>`, so a session whose commit REJECTS has already
   * broken its own contract. `runWithSession` does not catch that, and no
   * rollback runs for it. Harmless in memory mode (commit is a no-op); recorded
   * here so T-017's Postgres session is written to return failures rather than
   * to reject, and so the gap is visible if it ever changes.
   */
  it('propagates a commit that breaks the ApiResult contract, and does not roll back', async () => {
    const { session, log } = fakeSession({ commit: () => Promise.reject(new Error('commit exploded')) });
    await expect(runWithSession(session, () => Promise.resolve(1))).rejects.toThrow('commit exploded');
    expect(log).toEqual([]);
  });

  it('reports an unopenable session as retryable 503', () => {
    const error = sessionUnavailable(new Error('pool exhausted'));
    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('pool exhausted');
  });
});
