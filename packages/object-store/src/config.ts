/**
 * Configuration from an environment RECORD (docs/design/T-018.md §3.6, D10).
 *
 * The package never touches `process.env` itself: the composition root decides
 * and passes the record in, mirroring T-015 §2.2 rule 4 (`@db` owns the
 * connection, `@store-pg` receives a handle). Every configuration branch is
 * then testable with no global mutation.
 *
 * The three names are the ones T-015 registered — no fourth is introduced:
 *
 *   OBJECT_STORE_BUCKET    absent ⇒ NOT configured (the bucket is the switch)
 *   OBJECT_STORE_REGION    required once the bucket is set
 *   OBJECT_STORE_ENDPOINT  optional; present ⇒ path-style addressing (D12)
 *
 * Return contract, and the distinction is load-bearing (ADR-008):
 *
 *   undefined      ⇒ NOT configured. The caller composes the in-memory store.
 *                    This is *defaulting* to in-memory.
 *   { ok: false }  ⇒ PARTIALLY configured — a real misconfiguration. The
 *                    caller FAILS FAST at startup and MUST NOT degrade to a
 *                    volatile store. A configured-but-broken store that
 *                    silently degraded would accept an artifact, return
 *                    success, and lose it — healthy-looking data loss, which
 *                    is precisely what the fail-fast rule exists to prevent.
 */

import type { ObjectStoreConfig, ObjectStoreResult } from './contract.js';
import { OBJECT_STORE_SOURCE, storeError } from './contract.js';

export const ENV_BUCKET = 'OBJECT_STORE_BUCKET';
export const ENV_REGION = 'OBJECT_STORE_REGION';
export const ENV_ENDPOINT = 'OBJECT_STORE_ENDPOINT';

export function readObjectStoreConfig(
  env: Readonly<Record<string, string | undefined>>,
): ObjectStoreResult<ObjectStoreConfig> | undefined {
  const bucket = trimmed(env[ENV_BUCKET]);
  if (bucket === undefined) {
    // A region or endpoint without a bucket is an orphan, not an intent: the
    // bucket is the switch. Reported as "not configured" rather than promoted
    // into a half-configuration we would then have to guess at.
    return undefined;
  }

  const region = trimmed(env[ENV_REGION]);
  if (region === undefined) {
    // D2: config errors map to 'auth' — `AdapterErrorCode` is frozen in
    // packages/core, and 'auth' is the identical handling class (never retry,
    // alert an operator, do not degrade).
    return storeError('auth', OBJECT_STORE_SOURCE, `${ENV_BUCKET} is set but ${ENV_REGION} is missing`);
  }

  const endpoint = trimmed(env[ENV_ENDPOINT]);
  return {
    ok: true,
    value: {
      bucket,
      region,
      ...(endpoint !== undefined ? { endpoint } : {}),
    },
  };
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}
