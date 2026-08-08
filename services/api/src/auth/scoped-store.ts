/**
 * The scoped store seam — the only door to the spine, and it has no unscoped
 * side (docs/design/T-019.md §2.6, §5.1; AC-2).
 *
 * Every function here is keyed by `DealHandle`. There is no `forAccount()`, no
 * `unscoped()`, no `raw()`, and no method that takes a bare `deal_id: string`.
 * A caller that has not been through the gate has nothing to pass.
 *
 * Two absences are load-bearing and are kept BY ABSENCE rather than by a check:
 * `listQuarantined` and the unscoped half of `listUnrouted`.
 * `services/comms/src/ports.ts` says the unscoped call "must never be reached
 * from an account-scoped API (T-019/T-020 inherit this rule)"; an unparseable
 * payload and a `no_identity_match` record belong to no account, so there is
 * nothing here to scope them with. They are operator surfaces and this is not
 * an operator API.
 */

import type { Deal, DealerThread } from '@core';
import type { CommsReadModel, CommsStore, RawPayloadStore, UnroutedRecord } from '@comms';
import type { ReceiptStore } from '@receipt';

import type { AccountScopeShape } from '../context/account-context.js';
import { apiError, fail, ok, type ApiError, type ApiResult } from '../errors/envelope.js';
import { MESSAGE_BY_CODE, fromUnknown } from '../errors/mapping.js';
import type { DealHandle } from './deal-gate.js';

/** Log sink for tenancy rejections. Injected so this module needs no logger. */
export type TenancyLogger = (event: {
  readonly event: 'tenancy_reject';
  readonly layer: 'response';
  readonly account_id: string;
  readonly deal_id: string;
}) => void;

/**
 * Reads, keyed by handle.
 *
 * `CommsReadModel.getDeal(deal_id)` is UNSCOPED by signature. This wrapper is
 * the only permitted caller of it, and it re-checks
 * `deal.owner_id === handle.scope.account_id` after every read, reporting
 * `undefined` (⇒ 404, indistinguishable from absent — D3) on mismatch.
 *
 * That check is NOT redundant with a SQL `WHERE`: `InMemoryCommsStore` has no
 * account column at all, so in the ADR-008 DEFAULT mode this is the ONLY
 * tenancy enforcement in the service. A design that put tenancy solely in the
 * query would be tenancy-free in the mode the PoC actually runs.
 */
export interface ScopedReadModel {
  getDeal(handle: DealHandle): Promise<Deal | undefined>;
  getThread(handle: DealHandle, dealership_id: string): Promise<DealerThread | undefined>;
  /** The scoped half only — records attributed to THIS deal. */
  listUnrouted(handle: DealHandle): Promise<readonly UnroutedRecord[]>;
}

export interface ScopedReadModelDeps {
  readonly read: CommsReadModel;
  readonly log?: TenancyLogger;
}

export function createScopedReadModel(deps: ScopedReadModelDeps): ScopedReadModel {
  const owned = (handle: DealHandle, deal: Deal | undefined): Deal | undefined => {
    if (deal === undefined) return undefined;
    if (deal.owner_id === handle.scope.account_id) return deal;
    deps.log?.({
      event: 'tenancy_reject',
      layer: 'response',
      account_id: handle.scope.account_id,
      deal_id: handle.deal_id,
    });
    return undefined;
  };

  return {
    getDeal(handle: DealHandle): Promise<Deal | undefined> {
      return Promise.resolve(owned(handle, deps.read.getDeal(handle.deal_id)));
    },
    getThread(handle: DealHandle, dealership_id: string): Promise<DealerThread | undefined> {
      // Ownership is established on the DEAL before the thread is read: a
      // thread carries no owner of its own, so reading it first and checking
      // afterwards would mean answering from a row we had no right to load.
      if (owned(handle, deps.read.getDeal(handle.deal_id)) === undefined) return Promise.resolve(undefined);
      return Promise.resolve(deps.read.getThread(handle.deal_id, dealership_id));
    },
    listUnrouted(handle: DealHandle): Promise<readonly UnroutedRecord[]> {
      if (owned(handle, deps.read.getDeal(handle.deal_id)) === undefined) return Promise.resolve([]);
      return Promise.resolve(deps.read.listUnrouted(handle.deal_id));
    },
  };
}

/**
 * A unit of work.
 *
 * In Postgres mode this is one `PgCommsSession` over one transaction (T-017
 * §2.4). In memory mode it is a pass-through whose `commit()` is a no-op.
 * Handlers cannot tell which, and that is exactly AC-8: substituting the
 * infrastructure changes no code in this service.
 */
export interface StoreSession {
  readonly handle: DealHandle;
  /** `@comms` port, verbatim. */
  readonly store: CommsStore;
  /** `@comms` port, verbatim. */
  readonly raw_payloads: RawPayloadStore;
  /** `@receipt` port, verbatim — append + read, and nothing else exists. */
  readonly receipts: ReceiptStore;
  commit(): Promise<ApiResult<void>>;
  rollback(): Promise<void>;
}

export interface StoreSessionFactory {
  readonly mode: 'memory' | 'postgres';
  /** A handle or nothing. There is no other way in. */
  forDeal(handle: DealHandle): Promise<ApiResult<StoreSession>>;
  /** open → run → commit, rollback on rejection. Never throws; failures are values. */
  withDeal<T>(handle: DealHandle, fn: (session: StoreSession) => Promise<T>): Promise<ApiResult<T>>;
}

export interface MemorySessionDeps {
  readonly store: CommsStore;
  readonly raw_payloads: RawPayloadStore;
  /**
   * Scope-bound receipt store. In memory mode `@receipt`'s implementation is
   * keyed by `receipt_bundle_id` and has no account column, so the binding is
   * nominal — the real containment is that a bundle id is only ever obtained by
   * reading a deal through `ScopedReadModel`. In Postgres mode T-017's
   * `createPgReceiptStore(q, scope)` makes it a `WHERE` clause.
   */
  readonly receiptsFor: (scope: AccountScopeShape) => ReceiptStore;
}

/**
 * The ADR-008 default. Mutations apply immediately, so `commit()` is a no-op
 * and `rollback()` cannot undo — stated here rather than implied, because a
 * `rollback` that silently does nothing is worse than one that says so.
 */
export function createMemoryStoreSessionFactory(deps: MemorySessionDeps): StoreSessionFactory {
  const openSession = (handle: DealHandle): StoreSession => ({
    handle,
    store: deps.store,
    raw_payloads: deps.raw_payloads,
    receipts: deps.receiptsFor(handle.scope),
    commit: () => Promise.resolve(ok(undefined)),
    rollback: () => Promise.resolve(),
  });

  return {
    mode: 'memory',
    forDeal(handle: DealHandle): Promise<ApiResult<StoreSession>> {
      return Promise.resolve(ok(openSession(handle)));
    },
    withDeal<T>(handle: DealHandle, fn: (session: StoreSession) => Promise<T>): Promise<ApiResult<T>> {
      return runWithSession(openSession(handle), fn);
    },
  };
}

/**
 * The shared open → run → commit → rollback dance, so the memory factory and
 * the eventual Postgres factory cannot drift on ordering or on which failures
 * roll back.
 */
export async function runWithSession<T>(
  session: StoreSession,
  fn: (session: StoreSession) => Promise<T>,
): Promise<ApiResult<T>> {
  let value: T;
  try {
    value = await fn(session);
  } catch (cause) {
    await session.rollback();
    return fail(unwrap(cause));
  }
  const committed = await session.commit();
  if (!committed.ok) {
    await session.rollback();
    return fail(committed.error);
  }
  return ok(value);
}

const unwrap = (cause: unknown): ApiError => {
  if (typeof cause === 'object' && cause !== null && 'api_error' in cause) {
    return (cause as { api_error: ApiError }).api_error;
  }
  return fromUnknown(cause);
};

/** Used by the Postgres binder when a session cannot be opened at all. */
export const sessionUnavailable = (cause: unknown): ApiError =>
  apiError('unavailable', MESSAGE_BY_CODE.unavailable, { retryable: true, cause });
