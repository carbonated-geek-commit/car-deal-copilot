/**
 * The Postgres binding seam — the one file `@store-pg` plugs into
 * (docs/design/T-019.md §2.3, §8.6; ADR-008).
 *
 * ## Why this seam exists in this shape
 *
 * The design composes `@store-pg`'s `PgSessionFactory` directly. That package
 * has no `src/` yet: T-017 is `status: blocked` on its E1 escalation, so the
 * `@store-pg` alias resolves to nothing and importing it would not compile.
 * §8.6 says a divergence from T-017's designed surface is a STOP, not a shim —
 * so this file does not shim it. It declares the shape this service needs, and
 * leaves the implementation absent.
 *
 * What that buys, and what it costs, stated plainly:
 *
 *  - The ADR-008 DEFAULT posture is fully built and fully testable: with no
 *    `DATABASE_URL` the service composes in-memory and serves.
 *  - A configured-but-UNREACHABLE `DATABASE_URL` still fails fast exactly as
 *    ADR-008 requires — `createContainer` runs `DbHandle.ping()` before this
 *    binder is consulted, so an unreachable database aborts startup on the
 *    connection, not on the missing binding.
 *  - A configured and REACHABLE `DATABASE_URL` also aborts startup, loudly,
 *    naming T-017. It does NOT degrade to in-memory. There is no branch here
 *    that could: `bind` returns a failure, and `createContainer` propagates it.
 *
 * When T-017 lands, `createPostgresBinder` is written against its `§2` surface
 * and registered as the default `relational_binder`. Nothing else in this
 * service changes — no route, no handler, no projection, no validator.
 */

import type { CommsStore } from '@comms';
import type { DbHandle } from '@db';
import type { ReceiptStore } from '@receipt';

import type { AccountScopeShape } from '../context/account-context.js';
import type { StoreSessionFactory } from '../auth/scoped-store.js';
import { apiError, fail, type ApiResult } from '../errors/envelope.js';

/**
 * Everything a Postgres-backed composition must supply. Every member is a port
 * declared elsewhere — `@comms`'s store and read model, `@receipt`'s store,
 * this service's own session factory. No `pg` type, no SQL, and no
 * `@store-pg`-specific shape appears on it, so the binding is a swap rather
 * than a coupling (AC-8).
 */
export interface RelationalBinding {
  /**
   * Handed to `createCommsService` as its `store`, so `@comms` builds its read
   * model over it exactly as it does over the in-memory one — this service
   * never assembles a second read path.
   */
  readonly store: CommsStore;
  readonly receiptsFor: (scope: AccountScopeShape) => ReceiptStore;
  readonly sessions: StoreSessionFactory;
  close(): Promise<void>;
}

/*
 * There is deliberately NO `raw_payloads` on this interface. The raw-payload
 * store follows the OBJECT-store plan, not the relational one — that is what
 * `StoragePlan.raw_payload_durability` measures (D7), and two raw-payload
 * stores in one process would report two different durability answers for the
 * same `ref`.
 */

export interface RelationalBindDeps {
  /** Already created AND pinged by `createContainer` — never opened here. */
  readonly handle: DbHandle;
}

export interface RelationalBinder {
  readonly name: string;
  bind(deps: RelationalBindDeps): Promise<ApiResult<RelationalBinding>>;
}

export const UNAVAILABLE_BINDER = 'store-pg-unavailable';

/**
 * The default binder while `@store-pg` does not exist.
 *
 * It fails. That is the entire behaviour, and it is the correct one: ADR-008
 * says a configured database "must never silently degrade to in-memory", and
 * the only two honest answers to "Postgres is configured but no Postgres store
 * is built" are *refuse to start* or *lie*. The message names the task so an
 * operator is not left diagnosing a mystery.
 */
export function createUnavailableRelationalBinder(): RelationalBinder {
  return {
    name: UNAVAILABLE_BINDER,
    bind(): Promise<ApiResult<RelationalBinding>> {
      return Promise.resolve(
        fail(
          apiError(
            'internal',
            'DATABASE_URL is configured but no Postgres store implementation is bound (@store-pg / T-017 is not built); refusing to start rather than degrade to in-memory',
          ),
        ),
      );
    },
  };
}
