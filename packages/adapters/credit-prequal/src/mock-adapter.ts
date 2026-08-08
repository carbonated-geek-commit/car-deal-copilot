/**
 * Mock credit-prequal adapter — pass-through hosted-flow shape (T-006).
 *
 * specs/01 "Credit data residency": the soft pull happens inside the
 * provider's hosted flow — outside our systems. Our side receives and stores
 * a provider token + prequal results (qualified APR, amounts) and nothing
 * else. Raw credit data never lands in our systems; the types here give it
 * nowhere to live.
 *
 * mock_only: no HTTP, no provider SDK, no credentials, no storage machinery.
 * Credential absence is the structural enforcement (CLAUDE.md).
 *
 * Behavioral contract: docs/design/T-006.md §4 (instantiating the binding
 * T-001 §5.1 error-path table). The adapter never throws across the boundary.
 */

import type {
  AdapterErrorCode,
  AdapterResult,
  CreditPrequalAdapter,
  IsoTimestamp,
  PrequalResult,
} from '@core';

import type { PrequalFixture, PrequalScenario } from './fixtures.js';
import { DEFAULT_PREQUAL_FIXTURES } from './fixtures.js';

/** Adapter id used as `source` on results and errors. */
export const MOCK_CREDIT_PREQUAL_SOURCE = 'mock-credit-prequal' as const;

export interface MockCreditPrequalOptions {
  /** Defaults to DEFAULT_PREQUAL_FIXTURES. */
  fixtures?: readonly PrequalFixture[];
  /** Injectable clock for fetched_at (design D3). Defaults to system time. */
  now?: () => IsoTimestamp;
}

/**
 * Simulates the PROVIDER side of the hosted flow: the applicant completes the
 * provider's hosted UI (where the soft pull happens — outside our systems)
 * and our side receives back an opaque token. Input is a scenario id only —
 * structurally no applicant or credit fields (design D2).
 */
export interface MockHostedFlow {
  /** Returns the provider_token redeemable via CreditPrequalAdapter.getPrequal. */
  complete(scenario_id: string): { provider_token: string };
}

export interface MockCreditPrequal {
  /** The ONLY thing core services / composition roots receive (specs/00 anti-corruption). */
  adapter: CreditPrequalAdapter;
  /** Test/demo harness — never handed to core services. */
  hostedFlow: MockHostedFlow;
}

// ---- internals ---------------------------------------------------------

/**
 * Mock token namespace (design D5): deterministic, collision-free within a
 * fixture set. Callers must treat tokens as opaque; this prefix is a
 * mock-internal convenience for fixtures and never appears in caller logic.
 */
const TOKEN_PREFIX = 'mock-pq-';

/** Retryability is derived from code (T-001 §3.1), stated so callers never guess. */
const RETRYABLE: Record<AdapterErrorCode, boolean> = {
  invalid_input: false,
  not_found: false,
  auth: false,
  rate_limited: true,
  provider_unavailable: true,
  malformed_response: false,
};

/**
 * Static, log-safe descriptions per error code. By contract these carry no
 * token values, APRs, amounts, fixture contents, or anything applicant-shaped
 * (design §4.1 "Never logged").
 */
const ERROR_MESSAGES: Record<AdapterErrorCode, string> = {
  invalid_input: 'provider_token must be a non-empty string',
  not_found: 'no prequal result exists for this token',
  auth: 'simulated provider credential failure',
  rate_limited: 'simulated provider rate limit',
  provider_unavailable: 'simulated provider outage or timeout',
  malformed_response: 'fixture shape drifted outside the PrequalScenario contract',
};

function err(code: AdapterErrorCode): AdapterResult<never> {
  return {
    ok: false,
    error: {
      code,
      retryable: RETRYABLE[code],
      source: MOCK_CREDIT_PREQUAL_SOURCE,
      message: ERROR_MESSAGES[code],
    },
  };
}

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth',
  'rate_limited',
  'provider_unavailable',
  'malformed_response',
]);

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((k, i) => k === expected[i])
  );
}

/**
 * Structural validation of a fixture at factory load (design §4.1 last row):
 * a fixture carrying fields outside the PrequalScenario contract — anywhere
 * raw credit data could hide — is fixture-shape drift. Its token still mints,
 * but redeeming it surfaces `malformed_response`.
 */
function isWellFormedScenario(scenario: unknown): scenario is PrequalScenario {
  if (typeof scenario !== 'object' || scenario === null) return false;
  const s = scenario as Record<string, unknown>;
  switch (s['kind']) {
    case 'approved':
      return (
        hasExactKeys(s, ['kind', 'qualified_apr', 'approved_amount_max']) &&
        typeof s['qualified_apr'] === 'number' &&
        Number.isFinite(s['qualified_apr']) &&
        typeof s['approved_amount_max'] === 'number' &&
        Number.isInteger(s['approved_amount_max'])
      );
    case 'no_offer':
      return hasExactKeys(s, ['kind']);
    case 'provider_error':
      return (
        hasExactKeys(s, ['kind', 'code']) &&
        typeof s['code'] === 'string' &&
        PROVIDER_ERROR_CODES.has(s['code'])
      );
    default:
      return false;
  }
}

function isWellFormedFixture(fixture: unknown): fixture is PrequalFixture {
  if (typeof fixture !== 'object' || fixture === null) return false;
  const f = fixture as Record<string, unknown>;
  return (
    hasExactKeys(f, ['scenario_id', 'scenario']) &&
    typeof f['scenario_id'] === 'string' &&
    f['scenario_id'].trim() !== '' &&
    isWellFormedScenario(f['scenario'])
  );
}

// ---- factory -----------------------------------------------------------

export function createMockCreditPrequal(
  options?: MockCreditPrequalOptions,
): MockCreditPrequal {
  const fixtures = options?.fixtures ?? DEFAULT_PREQUAL_FIXTURES;
  const now: () => IsoTimestamp =
    options?.now ?? (() => new Date().toISOString());

  // token → scenario; `null` marks fixture-shape drift detected at load
  // (redeeming that token surfaces `malformed_response`, design §4.1).
  const byToken = new Map<string, PrequalScenario | null>();
  // scenario_id → token, for the hosted-flow harness.
  const tokenByScenarioId = new Map<string, string>();

  for (const fixture of fixtures) {
    if (!isWellFormedFixture(fixture)) {
      // Drift with an unusable scenario_id cannot mint a token at all; a
      // drifted-but-addressable fixture still registers so getPrequal can
      // surface the malformed_response path deterministically.
      const id =
        typeof (fixture as { scenario_id?: unknown })?.scenario_id === 'string'
          ? (fixture as { scenario_id: string }).scenario_id
          : undefined;
      if (id !== undefined && id.trim() !== '') {
        const token = TOKEN_PREFIX + id;
        byToken.set(token, null);
        tokenByScenarioId.set(id, token);
      }
      continue;
    }
    const token = TOKEN_PREFIX + fixture.scenario_id;
    if (tokenByScenarioId.has(fixture.scenario_id)) {
      // Duplicate scenario_id breaks the "collision-free within a fixture
      // set" mock contract (design D5) — treat as fixture-set drift.
      byToken.set(token, null);
      continue;
    }
    byToken.set(token, fixture.scenario);
    tokenByScenarioId.set(fixture.scenario_id, token);
  }

  const adapter: CreditPrequalAdapter = {
    source: MOCK_CREDIT_PREQUAL_SOURCE,

    async getPrequal(
      provider_token: string,
    ): Promise<AdapterResult<PrequalResult>> {
      // Never throws across the boundary — every input, including garbage
      // passed through a loosely-typed caller, resolves to an AdapterResult.
      if (
        typeof provider_token !== 'string' ||
        provider_token.trim() === ''
      ) {
        return err('invalid_input');
      }

      const scenario = byToken.get(provider_token);
      if (scenario === undefined) {
        // Unknown token: hosted flow never completed, or expired.
        return err('not_found');
      }
      if (scenario === null) {
        return err('malformed_response');
      }

      switch (scenario.kind) {
        case 'approved':
          // The ONLY success output: token + prequal results and nothing
          // else (specs/01). PrequalResult has no field for anything more.
          return {
            ok: true,
            value: {
              provider_token,
              qualified_apr: scenario.qualified_apr,
              approved_amount_max: scenario.approved_amount_max,
              fetched_at: now(),
            },
          };
        case 'no_offer':
          // Declined / no prequal offers → not_found (design D1).
          return err('not_found');
        case 'provider_error':
          return err(scenario.code);
      }
    },
  };

  const hostedFlow: MockHostedFlow = {
    complete(scenario_id: string): { provider_token: string } {
      const token = tokenByScenarioId.get(scenario_id);
      if (token === undefined) {
        // Test-fixture misuse, not an adapter-boundary failure: throwing
        // synchronously is correct here (design §4.2). AdapterResult
        // discipline applies only at the adapter boundary.
        throw new Error(
          `mock hosted flow has no scenario "${scenario_id}"; known scenario ids: ${[...tokenByScenarioId.keys()].join(', ')}`,
        );
      }
      return { provider_token: token };
    },
  };

  return { adapter, hostedFlow };
}
