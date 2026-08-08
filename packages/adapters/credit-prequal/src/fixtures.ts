/**
 * Mock hosted-flow scenario fixtures for the credit-prequal adapter (T-006).
 *
 * These types are the mock's control surface for tests and composition roots
 * ONLY — they never cross the adapter boundary, and no core service imports
 * them (specs/00 "Core services never see a provider's shape").
 *
 * Note what is structurally ABSENT here: no applicant identity (name, SSN,
 * DOB, address, income), no score, no report, no tradelines. The mock models
 * the BOUNDARY of the provider's hosted flow (token out), not its interior
 * (the soft pull), so nothing credit-shaped can transit our types even in
 * tests — specs/01 "Credit data residency" / design D2.
 */

import type { AdapterErrorCode, MoneyCents } from '@core';

/**
 * What a completed hosted flow can resolve to. Note what is NOT here: no
 * score, no report, no tradelines, no applicant identity — the type has no
 * field where raw credit data could fit (specs/01 "Credit data residency").
 */
export type PrequalScenario =
  | {
      kind: 'approved';
      /** Percent, e.g. 6.9 — same unit convention as Offer.apr (design D4). */
      qualified_apr: number;
      approved_amount_max: MoneyCents;
    }
  | {
      /** Declined / no offers — surfaces as `not_found` per design D1. */
      kind: 'no_offer';
    }
  | {
      /** Simulated provider-side failure, for exercising caller error paths. */
      kind: 'provider_error';
      code: Extract<
        AdapterErrorCode,
        'auth' | 'rate_limited' | 'provider_unavailable' | 'malformed_response'
      >;
    };

/** One named hosted-flow outcome the mock can produce. */
export interface PrequalFixture {
  /** Opaque scenario id; the ONLY thing the mock hosted flow accepts (design D2). */
  scenario_id: string;
  scenario: PrequalScenario;
}

/**
 * Default fixture set: prime / near-prime / no-offer / one of each simulated
 * provider error code. APRs are plain percentages (unit-aligned with
 * `Offer.apr`, design D4); amounts are integer USD cents (`MoneyCents`).
 */
export const DEFAULT_PREQUAL_FIXTURES: readonly PrequalFixture[] = [
  {
    scenario_id: 'prime',
    scenario: {
      kind: 'approved',
      qualified_apr: 5.9,
      approved_amount_max: 4_500_000, // $45,000.00
    },
  },
  {
    scenario_id: 'near-prime',
    scenario: {
      kind: 'approved',
      qualified_apr: 9.9,
      approved_amount_max: 2_500_000, // $25,000.00
    },
  },
  {
    scenario_id: 'no-offer',
    scenario: { kind: 'no_offer' },
  },
  {
    scenario_id: 'error-auth',
    scenario: { kind: 'provider_error', code: 'auth' },
  },
  {
    scenario_id: 'error-rate-limited',
    scenario: { kind: 'provider_error', code: 'rate_limited' },
  },
  {
    scenario_id: 'error-provider-unavailable',
    scenario: { kind: 'provider_error', code: 'provider_unavailable' },
  },
  {
    scenario_id: 'error-malformed-response',
    scenario: { kind: 'provider_error', code: 'malformed_response' },
  },
];
