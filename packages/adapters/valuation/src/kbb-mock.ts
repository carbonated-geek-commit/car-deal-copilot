/**
 * KBB-mock valuation adapter — retail/trade-in need (specs/00 "Valuation"
 * table row 1: Retail/trade-in → KBB).
 *
 * mock_only (CLAUDE.md approved-targets list): "KBB" exists here ONLY as the
 * `mock-kbb` id string, this filename, and doc comments — no SDK, endpoint,
 * credential, or HTTP anywhere. The factory returns the ONE spine
 * `ValuationAdapter` interface; no KBB-specific shape exists (AC-1).
 */

import type { ValuationAdapter } from '@core';
import { createFixtureMockAdapter, type MockValuationOptions } from './mock-adapter.js';
import { KBB_DEFAULT_FIXTURES } from './fixtures/kbb.fixtures.js';

/** Provenance id — the only place the provider name appears at runtime. */
export const KBB_MOCK_SOURCE = 'mock-kbb';

/** Retail / trade-in need (specs/00 Valuation table row 1). source === KBB_MOCK_SOURCE. */
export function createKbbMockAdapter(opts?: MockValuationOptions): ValuationAdapter {
  return createFixtureMockAdapter(KBB_MOCK_SOURCE, KBB_DEFAULT_FIXTURES, opts);
}
