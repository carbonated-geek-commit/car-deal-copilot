/**
 * Carfax MOCK — fixture-driven, offline, mock_only (CLAUDE.md MOCK-ONLY list).
 * No live credentials, endpoints, or SDKs; the provider name appears only in
 * the source-id string, doc comments, and this filename.
 */

import type { VehicleHistoryAdapter } from '@core';
import { CARFAX_FIXTURES } from './fixtures.js';
import {
  createMockHistoryAdapter,
  type MockHistoryOptions,
} from './mock-history-adapter.js';

/** Adapter id — the `source` provenance string on every result/error. */
export const CARFAX_MOCK_SOURCE: 'mock-carfax' = 'mock-carfax';

/** Carfax mock — source id "mock-carfax". */
export function createCarfaxMock(
  options?: MockHistoryOptions,
): VehicleHistoryAdapter {
  return createMockHistoryAdapter(CARFAX_MOCK_SOURCE, CARFAX_FIXTURES, options);
}
