/**
 * T-016 tester — configuration and the error vocabulary (design §2.1, §2.3,
 * §4.1, §4.2, §4.3, §4.7).
 *
 * Two things are load-bearing here and neither needs a server:
 *
 *  1. **`undefined` from `readDbConfigFromEnv` is a STATE, not a fault.**
 *     ADR-008 makes the in-memory store the default, so "no `DATABASE_URL`"
 *     must be an ordinary answer. The failure mode worth testing is the
 *     opposite one: a fabricated `postgres://localhost/...` default, which
 *     turns "not configured" into "misconfigured" on every machine that never
 *     asked for a database.
 *
 *  2. **`classifySqlstate` never guesses `retryable: true`.** A wrong retry on
 *     a non-idempotent INSERT is how a dealer message gets applied twice, and
 *     specs/00 names dropping/duplicating a dealer message outright. Every row
 *     of the design's mapping table is asserted, including the two deliberate
 *     asymmetries (`57014` is NOT retryable; class `28` is NOT retryable).
 */

import { describe, expect, it } from 'vitest';

import {
  APP_ROLE,
  classifySqlstate,
  createDbHandle,
  MIN_SERVER_VERSION_NUM,
  readDbConfigFromEnv,
  SQLSTATE_APPEND_ONLY,
  SQLSTATE_TENANCY,
  SQLSTATE_WRITE_ONCE,
  type DbErrorCode,
} from '@db';

import { fromUnknown } from '../src/errors.js';
import { expectErr } from './helpers.js';

describe('readDbConfigFromEnv (§4.1)', () => {
  it('returns undefined when DATABASE_URL is absent — the normal PoC state', () => {
    expect(readDbConfigFromEnv({})).toBeUndefined();
  });

  it('treats an empty or whitespace DATABASE_URL as absent, not as a connection', () => {
    expect(readDbConfigFromEnv({ DATABASE_URL: '' })).toBeUndefined();
    expect(readDbConfigFromEnv({ DATABASE_URL: '   ' })).toBeUndefined();
  });

  it('never fabricates a localhost default', () => {
    const config = readDbConfigFromEnv({ SOMETHING_ELSE: 'x' });
    expect(config).toBeUndefined();
    // The failure this guards: a default would make every developer machine
    // attempt a connection it never asked for, and fail at startup.
    expect(JSON.stringify(config ?? null)).not.toContain('localhost');
  });

  it('returns the trimmed connection string when one is configured', () => {
    expect(readDbConfigFromEnv({ DATABASE_URL: '  postgres://u@h/db  ' })).toEqual({
      connection_string: 'postgres://u@h/db',
    });
  });

  it('does NOT swallow a present-but-unparseable URL into undefined', () => {
    // Silently falling back to in-memory when a database WAS configured is the
    // degradation that 2xx's a dealer webhook and loses the message.
    const config = readDbConfigFromEnv({ DATABASE_URL: 'not a url at all' });
    expect(config).toBeDefined();
    expect(config?.connection_string).toBe('not a url at all');
  });

  it('leaves every optional tuning field absent rather than materialising a default', () => {
    const config = readDbConfigFromEnv({ DATABASE_URL: 'postgres://u@h/db' });
    expect(Object.keys(config ?? {})).toEqual(['connection_string']);
  });

  it('pins the app role name and the server floor', () => {
    expect(APP_ROLE).toBe('deal_copilot_app');
    expect(MIN_SERVER_VERSION_NUM).toBe(140000);
  });
});

describe('classifySqlstate (§2.3, §4.3)', () => {
  const CASES: ReadonlyArray<readonly [string, DbErrorCode, boolean]> = [
    ['42501', 'permission_denied', false],
    ['23505', 'unique_violation', false],
    ['23503', 'foreign_key_violation', false],
    ['23502', 'not_null_violation', false],
    ['23514', 'check_violation', false],
    ['22P02', 'check_violation', false],
    ['22003', 'check_violation', false],
    [SQLSTATE_APPEND_ONLY, 'append_only_violation', false],
    [SQLSTATE_WRITE_ONCE, 'write_once_violation', false],
    [SQLSTATE_TENANCY, 'tenancy_violation', false],
    ['40001', 'serialization_failure', true],
    ['40P01', 'serialization_failure', true],
    ['57014', 'statement_timeout', false],
    ['57P01', 'unavailable', true],
    ['53300', 'unavailable', true],
    ['08006', 'connection_failed', true],
    ['08001', 'connection_failed', true],
    ['28P01', 'connection_failed', false],
    ['XX000', 'unknown', false],
    ['', 'unknown', false],
  ];

  it.each(CASES)('maps %s to %s (retryable=%s)', (sqlstate, code, retryable) => {
    expect(classifySqlstate(sqlstate)).toEqual({ code, retryable });
  });

  it('uses the project SQLSTATEs the triggers actually raise', () => {
    expect(SQLSTATE_APPEND_ONLY).toBe('DC001');
    expect(SQLSTATE_WRITE_ONCE).toBe('DC002');
    expect(SQLSTATE_TENANCY).toBe('DC003');
  });

  it('never guesses an unmapped failure as retryable', () => {
    for (const sqlstate of ['P0001', 'ZZ999', '99999', 'abcde']) {
      expect(classifySqlstate(sqlstate).retryable, sqlstate).toBe(false);
    }
  });

  it('is total and pure — a mutated result cannot poison the next lookup', () => {
    const first = classifySqlstate('23505');
    first.retryable = true;
    first.code = 'unknown';
    expect(classifySqlstate('23505')).toEqual({ code: 'unique_violation', retryable: false });
  });
});

describe('fromUnknown — nothing from a driver reaches a log (§4.8)', () => {
  it('maps a SQLSTATE-bearing rejection and keeps table and constraint', () => {
    const error = fromUnknown(
      { code: '23503', table: 'dealer_threads', constraint: 'dealer_threads_contact_fk' },
      'query failed',
    );
    expect(error.code).toBe('foreign_key_violation');
    expect(error.sqlstate).toBe('23503');
    expect(error.constraint).toBe('dealer_threads_contact_fk');
  });

  it('never copies the driver message through — a row value must not become a log line', () => {
    const error = fromUnknown(
      {
        code: '23505',
        message: 'Key (deal_id, message_ref)=(abc, +15551234567) already exists',
        detail: 'buyer@example.com said the price is 42000',
      },
      'query failed',
    );
    expect(error.message).not.toContain('+15551234567');
    expect(error.message).not.toContain('buyer@example.com');
    expect(error.message).not.toContain('42000');
    expect(error.message).toBe('query failed (sqlstate 23505)');
  });

  it('treats an errno-style driver code as a connection failure, not as a SQLSTATE', () => {
    const error = fromUnknown({ code: 'ECONNREFUSED' }, 'could not connect');
    expect(error.code).toBe('connection_failed');
    expect(error.retryable).toBe(true);
    expect(error.sqlstate).toBeUndefined();
  });

  it('falls back to unknown, not retryable, for a non-object rejection', () => {
    const error = fromUnknown('boom', 'query failed');
    expect(error).toEqual({ code: 'unknown', retryable: false, message: 'query failed' });
  });

  it('omits optional fields rather than assigning undefined (exactOptionalPropertyTypes)', () => {
    const error = fromUnknown({ code: '23514' }, 'query failed');
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable', 'sqlstate']);
  });
});

describe('createDbHandle is lazy and its close is idempotent (§4.2)', () => {
  it('constructs against an unreachable target without throwing or connecting', async () => {
    const handle = createDbHandle({
      connection_string: 'postgres://nobody@127.0.0.1:1/nothing',
      connect_timeout_ms: 500,
    });
    // No socket has been opened, so closing immediately must be clean.
    await handle.close();
    await handle.close();
    expect(true).toBe(true);
  });

  it('reports a failure to reach the server as a VALUE, never as a throw', async () => {
    const handle = createDbHandle({
      connection_string: 'postgres://nobody@127.0.0.1:1/nothing',
      connect_timeout_ms: 500,
    });
    const pinged = await handle.ping();
    const error = expectErr(pinged);
    expect(['connection_failed', 'unavailable', 'unknown']).toContain(error.code);
    // Log-safe by contract: the connection string carries a password.
    expect(error.message).not.toContain('nobody');
    await handle.close();
  });
});
