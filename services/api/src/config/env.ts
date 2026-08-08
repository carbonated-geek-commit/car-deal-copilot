/**
 * The composition root's view of the environment (docs/design/T-019.md §2.1).
 *
 * This is the ONLY module in the service that reads environment variables, and
 * it reads them from a RECORD passed in by the caller — never from
 * `process.env` reached for internally (T-015 §2.2 rule 4; T-018 D10). Every
 * configuration branch is therefore testable with no global mutation, and the
 * one place `process.env` is touched at all is `start.ts`.
 *
 * The two storage switches are delegated, not re-implemented: `@db`'s
 * `readDbConfigFromEnv` and `@object-store`'s `readObjectStoreConfig` already
 * encode ADR-008's distinction between "absent ⇒ not configured" and
 * "partial ⇒ misconfigured", and re-deriving it here would be a second opinion
 * about the same rule.
 */

import { readDbConfigFromEnv, type DbConfig } from '@db';
import { readObjectStoreConfig, type ObjectStoreConfig, type ObjectStoreResult } from '@object-store';

import { apiError, fail, ok, type ApiResult } from '../errors/envelope.js';

export type ApiLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: readonly ApiLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug'];

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_LOG_LEVEL: ApiLogLevel = 'info';

export interface ApiConfig {
  /**
   * Default `127.0.0.1`, NOT `0.0.0.0`.
   *
   * §8.7: the E2 account resolver trusts an unsigned header, so this service
   * must not be reachable from an untrusted network until E3 replaces it. A
   * loopback default means exposing it is a deliberate act rather than an
   * oversight.
   */
  readonly host: string;
  readonly port: number;
  readonly body_limit_bytes: number;
  readonly log_level: ApiLogLevel;
  /** `undefined` ⇒ Postgres NOT configured (ADR-008: the normal PoC state). */
  readonly database?: DbConfig;
  /**
   * Passed through VERBATIM from `readObjectStoreConfig`, including its
   * three-way answer:
   *   `undefined`    ⇒ not configured — compose the in-memory store
   *   `{ ok: false }` ⇒ PARTIALLY configured — a misconfiguration; startup fails
   *   `{ ok: true }`  ⇒ configured
   * This service does not re-interpret a distinction that package already owns.
   */
  readonly object_store?: ObjectStoreResult<ObjectStoreConfig>;
}

export type ApiConfigResult = ApiResult<ApiConfig>;

export function readApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfigResult {
  const port = readInt(env['PORT'], DEFAULT_PORT);
  if (!port.ok) return fail(apiError('internal', 'PORT is not a valid port number'));
  if (port.value < 0 || port.value > 65_535) return fail(apiError('internal', 'PORT is outside 0..65535'));

  const body_limit = readInt(env['API_BODY_LIMIT_BYTES'], DEFAULT_BODY_LIMIT_BYTES);
  if (!body_limit.ok) return fail(apiError('internal', 'API_BODY_LIMIT_BYTES is not an integer'));
  if (body_limit.value < 1) return fail(apiError('internal', 'API_BODY_LIMIT_BYTES must be positive'));

  const raw_level = trimmed(env['LOG_LEVEL']);
  if (raw_level !== undefined && !(LOG_LEVELS as readonly string[]).includes(raw_level)) {
    return fail(apiError('internal', `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`));
  }

  const database = readDbConfigFromEnv(env);
  const object_store = readObjectStoreConfig(env);

  return ok({
    host: trimmed(env['API_HOST']) ?? DEFAULT_HOST,
    port: port.value,
    body_limit_bytes: body_limit.value,
    log_level: (raw_level as ApiLogLevel | undefined) ?? DEFAULT_LOG_LEVEL,
    ...(database !== undefined && { database }),
    ...(object_store !== undefined && { object_store }),
  });
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

/**
 * Absent ⇒ the default. Present-but-unparseable ⇒ an ERROR, never the default:
 * a typo in `PORT` that silently yields 3000 is a service listening somewhere
 * nobody asked for, which is the same class of quiet wrongness ADR-008's
 * fail-fast rule exists to prevent.
 */
function readInt(raw: string | undefined, fallback: number): { ok: true; value: number } | { ok: false } {
  const value = trimmed(raw);
  if (value === undefined) return { ok: true, value: fallback };
  if (!/^-?\d+$/u.test(value)) return { ok: false };
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : { ok: false };
}
