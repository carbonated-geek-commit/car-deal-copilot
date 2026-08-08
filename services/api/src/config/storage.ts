/**
 * The storage plan — one pure decision, then no more branching
 * (docs/design/T-019.md §2.2, D7; ADR-008).
 *
 * Computed ONCE, from `ApiConfig`, before any I/O. After this point no module
 * in the service asks "are we on Postgres?" — every consumer holds a port
 * (`CommsStore`, `RawPayloadStore`, `ObjectStore`, `ReceiptStore`,
 * `StoreSessionFactory`). `StoragePlan` is consulted in exactly two places:
 * `composition/container.ts` and `/readyz`.
 *
 * The rule that carries the weight, stated so a reader does not have to infer
 * it from the absence of an `else`: **there is no code path from a Postgres
 * failure to an in-memory store.** Not a guarded one — none. `plan` is fixed
 * before a socket is opened, and `createContainer` builds the in-memory pair
 * only when `plan.relational === 'memory'`. That is what makes ADR-008's "must
 * never silently degrade to in-memory" structural rather than a promise.
 */

import { apiError, fail, ok, type ApiResult } from '../errors/envelope.js';
import type { ApiConfig } from './env.js';

export type RelationalMode = 'memory' | 'postgres';
export type ObjectMode = 'memory' | 's3';

export interface StoragePlan {
  readonly relational: RelationalMode;
  readonly objects: ObjectMode;
  /**
   * `volatile` when `relational === 'postgres'` and `objects === 'memory'`:
   * durable rows will reference raw-payload bytes that do not survive a
   * restart. Logged `warn` at startup and reported in `/readyz`. Never silently
   * true — an operator who never sees this word will assume it is `durable`.
   */
  readonly raw_payload_durability: 'durable' | 'volatile';
}

/**
 * `{ ok: false }` here means PARTIALLY configured — `readObjectStoreConfig`'s
 * `{ ok: false }` case. It is a startup ABORT, never a fallback: `@object-store`
 * config states that a configured-but-broken store which degraded silently
 * "would accept an artifact, return success, and lose it — healthy-looking data
 * loss".
 *
 * D7: the two switches are INDEPENDENT. ADR-008 gives no authority to require
 * the pair, so Postgres-without-an-object-store is permitted and reported as
 * `volatile` rather than refused by invented policy (§8.4 asks the lead whether
 * it should become an abort).
 */
export function resolveStoragePlan(config: ApiConfig): ApiResult<StoragePlan> {
  const relational: RelationalMode = config.database === undefined ? 'memory' : 'postgres';

  let objects: ObjectMode = 'memory';
  if (config.object_store !== undefined) {
    if (!config.object_store.ok) {
      return fail(
        apiError('internal', 'object store is partially configured', { cause: config.object_store.error }),
      );
    }
    objects = 's3';
  }

  return ok({
    relational,
    objects,
    raw_payload_durability: relational === 'postgres' && objects === 'memory' ? 'volatile' : 'durable',
  });
}

/** The `/readyz` and startup-log shape. Names MODES only — never a URL, host, bucket, or credential. */
export const describePlan = (plan: StoragePlan): Readonly<Record<string, string>> => ({
  relational: plan.relational,
  objects: plan.objects,
  raw_payload_durability: plan.raw_payload_durability,
});
