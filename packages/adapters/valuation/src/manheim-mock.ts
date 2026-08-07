/**
 * Manheim-mock valuation adapter — wholesale/auction (MMR) need (specs/00
 * "Valuation" table row 2: Wholesale/auction → Manheim (MMR)).
 *
 * mock_only (CLAUDE.md approved-targets list): "Manheim" exists here ONLY as
 * the `mock-manheim` id string, this filename, and doc comments — no SDK,
 * endpoint, credential, or HTTP anywhere. The factory returns the ONE spine
 * `ValuationAdapter` interface; no Manheim/MMR-specific shape exists (AC-1).
 */

import type { ValuationAdapter } from '@core';
import { createFixtureMockAdapter, type MockValuationOptions } from './mock-adapter.js';
import { MANHEIM_DEFAULT_FIXTURES } from './fixtures/manheim.fixtures.js';

/** Provenance id — the only place the provider name appears at runtime. */
export const MANHEIM_MOCK_SOURCE = 'mock-manheim';

/** Wholesale / auction (MMR) need (specs/00 Valuation table row 2). source === MANHEIM_MOCK_SOURCE. */
export function createManheimMockAdapter(opts?: MockValuationOptions): ValuationAdapter {
  return createFixtureMockAdapter(MANHEIM_MOCK_SOURCE, MANHEIM_DEFAULT_FIXTURES, opts);
}
