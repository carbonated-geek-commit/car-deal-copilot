/**
 * The route runtime — the shared seam every handler in this suite reaches the
 * spine through (docs/design/T-020.md §2.1, D2, D8; §4.4).
 *
 * DEVIATION from design §1.1's file inventory, recorded in place: the inventory
 * listed no module for the handler-shared helpers, and the three natural
 * candidates were all wrong homes — `aggregate.ts` is pure and imports no
 * transport, `views.ts` is types, and putting them in `deals.ts` would make
 * every other route file import a sibling ROUTE module. Nothing about the
 * exposed interface changes: `index.ts` re-exports `RouteSuiteDeps`,
 * `IdFactory`, and `createRouteSuite` exactly as §2.1 declares them.
 *
 * D2 — every identifier this API mints is DETERMINISTIC, derived from data the
 * caller already supplied. Two forces meet: T-019's static-invariant suite pins
 * the import allowlist for `services/api/src/**` and `node:crypto` is not on it,
 * so `randomUUID` is unavailable without editing a foreign test; and
 * determinism is BETTER here anyway, because a replayed `PUT` then produces
 * byte-identical state and idempotency becomes a property of the data rather
 * than of a remembered key. `ids` stays injectable for the epic that wants
 * uuids.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Deal, DealerThread, IsoTimestamp } from '@core';

import type { DealHandle } from '../auth/deal-gate.js';
import type { StoreSession } from '../auth/scoped-store.js';
import type { AppContainer } from '../composition/container.js';
import type { DealAccessGate } from '../auth/deal-gate.js';
import { ApiErrorException, apiError, type ApiError } from '../errors/envelope.js';
import { MESSAGE_BY_CODE } from '../errors/mapping.js';
import { findThread } from './aggregate.js';
import { dealershipId, createInMemoryDealershipDirectory, type DealershipDirectory, type DealershipNaturalKey } from './directory.js';
import { appendRejectionMark, type RejectionMark } from './receipt-events.js';
import { NO_VALUATIONS, type ValuationLookup } from './valuations.js';

/** D2 — the deterministic minting surface, injectable end to end. */
export interface IdFactory {
  receiptBundleId(deal_id: string): string;
  /**
   * One instance per thread is the spine's own cardinality
   * (`DealerThread.vehicle_instance` is singular), so the thread key IS the
   * instance key.
   */
  vehicleInstanceId(deal_id: string, dealership_id: string): string;
  dealershipId(key: DealershipNaturalKey): string;
}

export const DETERMINISTIC_IDS: IdFactory = {
  receiptBundleId: (deal_id: string): string => `receipt:${deal_id}`,
  vehicleInstanceId: (deal_id: string, dealership_id: string): string => `vi:${deal_id}:${dealership_id}`,
  dealershipId,
};

export interface RouteSuiteDeps {
  /** The GLOBAL dealership directory. Default: in-memory (ADR-008 posture). */
  readonly directory?: DealershipDirectory;
  /** Per-instance market value. Default: `NO_VALUATIONS` — every lookup `undefined`. */
  readonly valuations?: ValuationLookup;
  /** Injectable clock. Default `() => new Date().toISOString()`. */
  readonly now?: () => IsoTimestamp;
  /** Injectable identifier minting. Default is deterministic (D2). */
  readonly ids?: IdFactory;
}

export interface ResolvedRouteDeps {
  readonly directory: DealershipDirectory;
  readonly valuations: ValuationLookup;
  readonly now: () => IsoTimestamp;
  readonly ids: IdFactory;
}

export function resolveRouteDeps(deps: RouteSuiteDeps = {}): ResolvedRouteDeps {
  return {
    directory: deps.directory ?? createInMemoryDealershipDirectory(),
    valuations: deps.valuations ?? NO_VALUATIONS,
    now: deps.now ?? ((): IsoTimestamp => new Date().toISOString()),
    ids: deps.ids ?? DETERMINISTIC_IDS,
  };
}

/** Everything a handler needs: the injected deps plus the api scope's wiring. */
export interface RouteRuntime extends ResolvedRouteDeps {
  readonly container: AppContainer;
  readonly gate: DealAccessGate;
}

/**
 * Reads the `ApiScope` T-019 decorates onto the api scope.
 *
 * A plain `Error` on purpose: this can only fail at REGISTRATION time, where
 * `buildServer` already turns a throw into `fail(...)` and the process never
 * listens. An `ApiErrorException` would imply a request to answer.
 */
export function runtimeFor(app: FastifyInstance, deps: ResolvedRouteDeps): RouteRuntime {
  const scope = app.api_scope;
  if (scope === undefined) {
    throw new Error('route suite registered outside the api scope: no api_scope decoration is visible');
  }
  return { ...deps, container: scope.container, gate: scope.gate };
}

// ---- shared failures ------------------------------------------------------

/**
 * D3 (T-019) — absent and not-owned are the SAME answer, byte for byte. A `403`
 * on a deal id is an existence oracle.
 */
export const notFound = (): ApiErrorException =>
  new ApiErrorException(apiError('not_found', MESSAGE_BY_CODE.not_found));

export const conflict = (message: string): ApiErrorException =>
  new ApiErrorException(apiError('conflict', message));

export const unprocessable = (message: string): ApiErrorException =>
  new ApiErrorException(apiError('unprocessable', message));

export const forbidden = (): ApiErrorException =>
  new ApiErrorException(apiError('forbidden', MESSAGE_BY_CODE.forbidden));

// ---- reads ----------------------------------------------------------------

/**
 * The ONLY read door. `ScopedReadModel` re-checks `deal.owner_id` against the
 * handle's scope after every read and reports `undefined` on mismatch, which is
 * the only tenancy enforcement that exists in the ADR-008 default mode
 * (`InMemoryCommsStore` has no account column at all).
 */
export async function requireOwnedDeal(rt: RouteRuntime, handle: DealHandle): Promise<Deal> {
  const deal = await rt.container.read.getDeal(handle);
  if (deal === undefined) throw notFound();
  return deal;
}

export function requireThread(deal: Deal, dealership_id: string): DealerThread {
  const thread = findThread(deal, dealership_id);
  if (thread === undefined) throw notFound();
  return thread;
}

// ---- writes ---------------------------------------------------------------

/**
 * A mutating unit of work with no rejection path: open → read → write →
 * commit, rolling back on any throw. Failures arrive as VALUES from
 * `withDeal` and are re-thrown as the one envelope.
 */
export async function runWrite<T>(
  rt: RouteRuntime,
  handle: DealHandle,
  fn: (session: StoreSession) => Promise<T>,
): Promise<T> {
  const result = await rt.container.sessions.withDeal(handle, fn);
  if (!result.ok) throw new ApiErrorException(result.error);
  return result.value;
}

/**
 * The outcome of a unit of work that may REJECT on a domain invariant.
 *
 * A rejection is returned rather than thrown so the ordering §4.4 fixes is
 * expressible: the session must be rolled back with nothing written BEFORE the
 * receipt mark is appended, and `withDeal` cannot carry the mark's facts out
 * through its failure value.
 */
export type Guarded<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'reject'; readonly error: ApiError; readonly mark: RejectionMark };

/**
 * §4.4 — rejection before receipt, receipt OUTSIDE the session (D8).
 *
 * On rejection: roll back with nothing written → append the mark through
 * `container.receiptsFor(handle.scope)` in its own unit of work → throw the
 * rejection. Appending inside the doomed transaction would roll the mark back
 * with the write (migration `0014` says so in as many words); appending before
 * deciding would mark a rejection that might not happen.
 *
 * A failed mark never changes the caller's outcome — see `appendRejectionMark`.
 */
export async function runGuarded<T>(
  rt: RouteRuntime,
  req: FastifyRequest,
  handle: DealHandle,
  fn: (session: StoreSession) => Promise<Guarded<T>>,
): Promise<T> {
  const opened = await rt.container.sessions.forDeal(handle);
  if (!opened.ok) throw new ApiErrorException(opened.error);
  const session = opened.value;

  let outcome: Guarded<T>;
  try {
    outcome = await fn(session);
  } catch (cause) {
    await rollbackQuietly(session);
    throw cause;
  }

  if (outcome.kind === 'reject') {
    await rollbackQuietly(session);
    await appendRejectionMark(rt.container.receiptsFor(handle.scope), outcome.mark, req.log);
    throw new ApiErrorException(outcome.error);
  }

  let committed;
  try {
    committed = await session.commit();
  } catch (cause) {
    await rollbackQuietly(session);
    throw new ApiErrorException(apiError('unavailable', MESSAGE_BY_CODE.unavailable, { retryable: true, cause }));
  }
  if (!committed.ok) {
    await rollbackQuietly(session);
    throw new ApiErrorException(committed.error);
  }
  return outcome.value;
}

/**
 * A `rollback()` that itself fails must not replace the reason it was called
 * for — the same rule `auth/scoped-store.ts` states for `runWithSession`.
 */
async function rollbackQuietly(session: StoreSession): Promise<void> {
  try {
    await session.rollback();
  } catch {
    /* deliberately ignored — see above */
  }
}
