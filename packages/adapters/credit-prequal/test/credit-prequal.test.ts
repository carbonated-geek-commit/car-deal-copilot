/**
 * T-006 tester — credit-prequal pass-through mock (docs/design/T-006.md §5).
 *
 * Coverage map (design section → describe block):
 *   §5.1 hosted-flow round trip against fixtures
 *   §5.2 serialization leak check (exactly token + prequal fields on outputs)
 *   §5.3 type-level leak check (forbidden fields inexpressible)
 *   §5.4 error-path table (§4.1, one test per row, retryable booleans)
 *   §5.5 never-throws across the adapter boundary
 *   §5.6 determinism / idempotency under injected clocks
 *   §4.2 hosted-flow harness behavior (unknown scenario throws; D5 tokens)
 *   §2 / §4.3 boundary rules: no provider shape, no webhook/HTTP surface,
 *       log-safe error messages (no tokens/APRs/amounts in messages)
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  CreditPrequalAdapter,
  PrequalResult,
} from '@core';
import {
  createMockCreditPrequal,
  DEFAULT_PREQUAL_FIXTURES,
  MOCK_CREDIT_PREQUAL_SOURCE,
  type MockHostedFlow,
  type PrequalFixture,
  type PrequalScenario,
} from '@adapters/credit-prequal';
import * as publicApi from '@adapters/credit-prequal';

const T0 = '2026-08-07T12:00:00.000Z';
const T1 = '2026-08-07T13:30:00.000Z';
const fixedClock = () => T0;

function make(overrides?: {
  fixtures?: readonly PrequalFixture[];
  now?: () => string;
}) {
  const fixtures = overrides?.fixtures;
  return createMockCreditPrequal({
    ...(fixtures !== undefined ? { fixtures } : {}),
    now: overrides?.now ?? fixedClock,
  });
}

/** Unwrap ok or fail loudly with the error code. */
async function mustOk(
  adapter: CreditPrequalAdapter,
  token: string,
): Promise<PrequalResult> {
  const res = await adapter.getPrequal(token);
  if (!res.ok) {
    throw new Error(`expected ok for token, got ${res.error.code}`);
  }
  return res.value;
}

/** Unwrap error or fail loudly. */
async function mustErr(
  adapter: CreditPrequalAdapter,
  token: string,
): Promise<AdapterError> {
  const res = await adapter.getPrequal(token);
  if (res.ok) {
    throw new Error('expected an error result, got ok');
  }
  return res.error;
}

function approvedFixture(id: string): Extract<PrequalScenario, { kind: 'approved' }> {
  const fixture = DEFAULT_PREQUAL_FIXTURES.find((f) => f.scenario_id === id);
  if (!fixture || fixture.scenario.kind !== 'approved') {
    throw new Error(`default fixture "${id}" missing or not approved`);
  }
  return fixture.scenario;
}

// ---- §5.1 hosted-flow round trip ---------------------------------------

describe('hosted-flow round trip (design §5.1)', () => {
  it('complete("prime") mints a token that redeems to the prime fixture values', async () => {
    const { adapter, hostedFlow } = make();
    const prime = approvedFixture('prime');

    const { provider_token } = hostedFlow.complete('prime');
    const value = await mustOk(adapter, provider_token);

    expect(value.provider_token).toBe(provider_token);
    expect(value.qualified_apr).toBe(prime.qualified_apr);
    expect(value.approved_amount_max).toBe(prime.approved_amount_max);
    expect(value.fetched_at).toBe(T0);
  });

  it('a second fixture (near-prime) maps its own token to distinct values — token→scenario mapping is real', async () => {
    const { adapter, hostedFlow } = make();
    const prime = approvedFixture('prime');
    const nearPrime = approvedFixture('near-prime');

    const primeToken = hostedFlow.complete('prime').provider_token;
    const nearToken = hostedFlow.complete('near-prime').provider_token;
    expect(nearToken).not.toBe(primeToken);

    const value = await mustOk(adapter, nearToken);
    expect(value.qualified_apr).toBe(nearPrime.qualified_apr);
    expect(value.approved_amount_max).toBe(nearPrime.approved_amount_max);
    // and the two scenarios really differ, so the mapping is distinguishable
    expect(nearPrime.qualified_apr).not.toBe(prime.qualified_apr);
  });

  it('adapter.source is the exported mock source id', () => {
    const { adapter } = make();
    expect(adapter.source).toBe(MOCK_CREDIT_PREQUAL_SOURCE);
    expect(MOCK_CREDIT_PREQUAL_SOURCE).toBe('mock-credit-prequal');
  });

  it('works with caller-supplied fixtures (control surface, not provider shape)', async () => {
    const { adapter, hostedFlow } = make({
      fixtures: [
        {
          scenario_id: 'custom',
          scenario: {
            kind: 'approved',
            qualified_apr: 3.4,
            approved_amount_max: 1_000_000,
          },
        },
      ],
    });
    const token = hostedFlow.complete('custom').provider_token;
    const value = await mustOk(adapter, token);
    expect(value.qualified_apr).toBe(3.4);
    expect(value.approved_amount_max).toBe(1_000_000);
  });
});

// ---- §5.2 serialization leak check -------------------------------------

describe('serialization leak check (design §5.2 / AC-2)', () => {
  const EXPECTED_KEYS = [
    'approved_amount_max',
    'fetched_at',
    'provider_token',
    'qualified_apr',
  ];

  it('success output has EXACTLY the four token+prequal keys', async () => {
    const { adapter, hostedFlow } = make();
    const value = await mustOk(
      adapter,
      hostedFlow.complete('prime').provider_token,
    );
    expect(Object.keys(value).sort()).toEqual(EXPECTED_KEYS);
  });

  it('JSON round trip is unchanged — nothing hidden, nothing extra survives serialization', async () => {
    const { adapter, hostedFlow } = make();
    for (const id of ['prime', 'near-prime']) {
      const value = await mustOk(
        adapter,
        hostedFlow.complete(id).provider_token,
      );
      const roundTripped = JSON.parse(JSON.stringify(value));
      expect(roundTripped).toEqual(value);
      expect(Object.keys(roundTripped).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  it('error outputs carry only the uniform AdapterError shape (no payload/fixture leak)', async () => {
    const { adapter } = make();
    const error = await mustErr(adapter, 'mock-pq-unknown-token');
    expect(Object.keys(error).sort()).toEqual([
      'code',
      'message',
      'retryable',
      'source',
    ]);
  });
});

// ---- §5.3 type-level leak check ----------------------------------------

describe('type-level leak check (design §5.3 / AC-2, AC-3)', () => {
  it('keyof PrequalResult is exactly the four-key union', () => {
    expectTypeOf<keyof PrequalResult>().toEqualTypeOf<
      'provider_token' | 'qualified_apr' | 'approved_amount_max' | 'fetched_at'
    >();
  });

  it('no raw-credit-shaped key exists on PrequalResult or PrequalScenario', () => {
    type Forbidden = 'score' | 'report' | 'tradelines' | 'ssn' | 'applicant';
    expectTypeOf<keyof PrequalResult & Forbidden>().toEqualTypeOf<never>();
    // union type: keyof over all variants
    expectTypeOf<PrequalScenario extends infer S
      ? S extends unknown
        ? keyof S
        : never
      : never>().toEqualTypeOf<'kind' | 'qualified_apr' | 'approved_amount_max' | 'code'>();
  });

  it('MockHostedFlow.complete accepts an opaque scenario_id string ONLY (D2 — no applicant fields)', () => {
    expectTypeOf<Parameters<MockHostedFlow['complete']>>().toEqualTypeOf<
      [scenario_id: string]
    >();
    expectTypeOf<ReturnType<MockHostedFlow['complete']>>().toEqualTypeOf<{
      provider_token: string;
    }>();
  });

  it('getPrequal returns Promise<AdapterResult<PrequalResult>> and nothing wider', () => {
    expectTypeOf<
      ReturnType<CreditPrequalAdapter['getPrequal']>
    >().toEqualTypeOf<Promise<AdapterResult<PrequalResult>>>();
    const { adapter } = make();
    expectTypeOf(adapter).toEqualTypeOf<CreditPrequalAdapter>();
  });
});

// ---- §5.4 error-path table (design §4.1) -------------------------------

describe('error paths (design §4.1 table / §5.4)', () => {
  it('empty / whitespace token → invalid_input, not retryable', async () => {
    const { adapter } = make();
    for (const bad of ['', '   ', '\n\t']) {
      const error = await mustErr(adapter, bad);
      expect(error.code).toBe('invalid_input');
      expect(error.retryable).toBe(false);
      expect(error.source).toBe(MOCK_CREDIT_PREQUAL_SOURCE);
    }
  });

  it('non-string token (loosely-typed caller) → invalid_input', async () => {
    const { adapter } = make();
    for (const bad of [null, undefined, 42, {}, [], Symbol('x')]) {
      const res = await adapter.getPrequal(bad as unknown as string);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid_input');
    }
  });

  it('unknown token (hosted flow never completed / expired) → not_found, not retryable', async () => {
    const { adapter } = make();
    const error = await mustErr(adapter, 'mock-pq-never-completed');
    expect(error.code).toBe('not_found');
    expect(error.retryable).toBe(false);
  });

  it('no_offer scenario (declined) → not_found per D1, not retryable', async () => {
    const { adapter, hostedFlow } = make();
    const token = hostedFlow.complete('no-offer').provider_token;
    const error = await mustErr(adapter, token);
    expect(error.code).toBe('not_found');
    expect(error.retryable).toBe(false);
  });

  it.each<[string, AdapterErrorCode, boolean]>([
    ['error-auth', 'auth', false],
    ['error-rate-limited', 'rate_limited', true],
    ['error-provider-unavailable', 'provider_unavailable', true],
    ['error-malformed-response', 'malformed_response', false],
  ])(
    'scenario %s → code %s with retryable=%s',
    async (scenarioId, code, retryable) => {
      const { adapter, hostedFlow } = make();
      const token = hostedFlow.complete(scenarioId).provider_token;
      const error = await mustErr(adapter, token);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.source).toBe(MOCK_CREDIT_PREQUAL_SOURCE);
    },
  );

  it('fixture shape drift (extra field where raw credit data could hide) → malformed_response', async () => {
    const drifted = {
      scenario_id: 'drifted',
      scenario: {
        kind: 'approved',
        qualified_apr: 5.0,
        approved_amount_max: 1_000_000,
        credit_score: 780, // the forbidden thing — must be rejected, not passed through
      },
    } as unknown as PrequalFixture;
    const { adapter, hostedFlow } = make({ fixtures: [drifted] });
    const token = hostedFlow.complete('drifted').provider_token;
    const error = await mustErr(adapter, token);
    expect(error.code).toBe('malformed_response');
    expect(error.retryable).toBe(false);
    // and the smuggled value must never appear anywhere in the result
    expect(JSON.stringify(error)).not.toContain('780');
  });

  it('duplicate scenario_id (D5 collision-free contract broken) → malformed_response on redemption', async () => {
    const dup: PrequalFixture[] = [
      {
        scenario_id: 'twin',
        scenario: { kind: 'approved', qualified_apr: 4.0, approved_amount_max: 100 },
      },
      {
        scenario_id: 'twin',
        scenario: { kind: 'approved', qualified_apr: 9.0, approved_amount_max: 200 },
      },
    ];
    const { adapter, hostedFlow } = make({ fixtures: dup });
    const token = hostedFlow.complete('twin').provider_token;
    const error = await mustErr(adapter, token);
    expect(error.code).toBe('malformed_response');
  });

  it('drifted fixture with unusable scenario_id mints no token at all', () => {
    const { hostedFlow } = make({
      fixtures: [
        { scenario: { kind: 'no_offer' } } as unknown as PrequalFixture,
        { scenario_id: '   ', scenario: { kind: 'no_offer' } } as PrequalFixture,
      ],
    });
    expect(() => hostedFlow.complete('   ')).toThrowError();
    expect(() => hostedFlow.complete('undefined')).toThrowError();
  });
});

// ---- §5.5 never-throws -------------------------------------------------

describe('never throws across the adapter boundary (design §5.5)', () => {
  it('garbage inputs resolve (never reject/throw) to {ok:false}', async () => {
    const { adapter } = make();
    const garbage: unknown[] = [
      null,
      undefined,
      0,
      NaN,
      true,
      {},
      [],
      { provider_token: 'mock-pq-prime' },
      'x'.repeat(1_000_000), // oversized string
      ' ',
    ];
    for (const g of garbage) {
      const res = await adapter.getPrequal(g as string).catch((e: unknown) => {
        throw new Error(`getPrequal rejected instead of resolving: ${String(e)}`);
      });
      expect(res.ok).toBe(false);
    }
  });
});

// ---- §5.6 determinism / idempotency ------------------------------------

describe('determinism / idempotency (design §5.6, D3)', () => {
  it('two calls with the same token yield identical values (pure read, retry-safe)', async () => {
    const { adapter, hostedFlow } = make();
    const token = hostedFlow.complete('prime').provider_token;
    const a = await mustOk(adapter, token);
    const b = await mustOk(adapter, token);
    expect(b).toEqual(a);
  });

  it('distinct clock injections change only fetched_at', async () => {
    const fixtures = DEFAULT_PREQUAL_FIXTURES;
    const first = createMockCreditPrequal({ fixtures, now: () => T0 });
    const second = createMockCreditPrequal({ fixtures, now: () => T1 });
    const token = first.hostedFlow.complete('prime').provider_token;
    expect(second.hostedFlow.complete('prime').provider_token).toBe(token);

    const a = await mustOk(first.adapter, token);
    const b = await mustOk(second.adapter, token);
    expect(a.fetched_at).toBe(T0);
    expect(b.fetched_at).toBe(T1);
    expect({ ...a, fetched_at: null }).toEqual({ ...b, fetched_at: null });
  });

  it('same scenario_id always mints the same token (D5 determinism)', () => {
    const { hostedFlow } = make();
    const t1 = hostedFlow.complete('prime').provider_token;
    const t2 = hostedFlow.complete('prime').provider_token;
    expect(t2).toBe(t1);
  });
});

// ---- §4.2 hosted-flow harness ------------------------------------------

describe('hosted-flow harness (design §4.2)', () => {
  it('unknown scenario_id throws synchronously (test-fixture misuse, not adapter boundary)', () => {
    const { hostedFlow } = make();
    expect(() => hostedFlow.complete('no-such-scenario')).toThrowError(
      /no scenario/,
    );
  });

  it('default fixture set covers prime / near-prime / no-offer / every provider error code', () => {
    const ids = DEFAULT_PREQUAL_FIXTURES.map((f) => f.scenario_id);
    expect(new Set(ids).size).toBe(ids.length); // collision-free (D5)
    expect(ids).toEqual(
      expect.arrayContaining([
        'prime',
        'near-prime',
        'no-offer',
        'error-auth',
        'error-rate-limited',
        'error-provider-unavailable',
        'error-malformed-response',
      ]),
    );
    const errorCodes = DEFAULT_PREQUAL_FIXTURES.filter(
      (f): f is PrequalFixture & { scenario: { kind: 'provider_error'; code: string } } =>
        f.scenario.kind === 'provider_error',
    ).map((f) => f.scenario.code);
    expect(errorCodes.sort()).toEqual([
      'auth',
      'malformed_response',
      'provider_unavailable',
      'rate_limited',
    ]);
  });
});

// ---- §2 / §4.1 / §4.3 boundary rules -----------------------------------

describe('boundary rules (design §2, §4.1 "never logged", §4.3)', () => {
  it('error messages are log-safe: no token values, APRs, amounts, or fixture contents', async () => {
    const { adapter, hostedFlow } = make();
    const prime = approvedFixture('prime');
    const probes = [
      hostedFlow.complete('no-offer').provider_token,
      hostedFlow.complete('error-auth').provider_token,
      'mock-pq-unknown-xyz',
      '',
    ];
    for (const token of probes) {
      const res = await adapter.getPrequal(token);
      if (res.ok) throw new Error('expected error result');
      const msg = res.error.message;
      if (token.trim() !== '') {
        expect(msg).not.toContain(token); // capability handle never logged
      }
      expect(msg).not.toContain(String(prime.qualified_apr));
      expect(msg).not.toContain(String(prime.approved_amount_max));
    }
  });

  it('public API surface exports exactly the designed names — no webhook/HTTP/provider affordance (§2, §4.3)', () => {
    // Runtime exports only (types are erased). No handler, route, endpoint,
    // URL, or credential surface may exist in this package (mock_only).
    expect(Object.keys(publicApi).sort()).toEqual([
      'DEFAULT_PREQUAL_FIXTURES',
      'MOCK_CREDIT_PREQUAL_SOURCE',
      'createMockCreditPrequal',
    ]);
  });

  it('factory result exposes only { adapter, hostedFlow }; adapter exposes only { source, getPrequal }', () => {
    const mock = make();
    expect(Object.keys(mock).sort()).toEqual(['adapter', 'hostedFlow']);
    expect(Object.keys(mock.adapter).sort()).toEqual(['getPrequal', 'source']);
    expect(Object.keys(mock.hostedFlow).sort()).toEqual(['complete']);
  });
});
