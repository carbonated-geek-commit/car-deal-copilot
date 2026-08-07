/**
 * AutoCheck MOCK — fixture-driven, offline, mock_only (CLAUDE.md MOCK-ONLY
 * list). No live credentials, endpoints, or SDKs; the provider name appears
 * only in the source-id string, doc comments, and this filename.
 */

import type { VehicleHistoryAdapter } from '@core';
import { AUTOCHECK_FIXTURES } from './fixtures.js';
import {
  createMockHistoryAdapter,
  type MockHistoryOptions,
} from './mock-history-adapter.js';

/** Adapter id — the `source` provenance string on every result/error. */
export const AUTOCHECK_MOCK_SOURCE: 'mock-autocheck' = 'mock-autocheck';

/** AutoCheck mock — source id "mock-autocheck". */
export function createAutoCheckMock(
  options?: MockHistoryOptions,
): VehicleHistoryAdapter {
  return createMockHistoryAdapter(
    AUTOCHECK_MOCK_SOURCE,
    AUTOCHECK_FIXTURES,
    options,
  );
}
