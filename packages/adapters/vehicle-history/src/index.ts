/**
 * @adapters/vehicle-history public API — the only import surface (T-001 D3).
 *
 * Complete surface per docs/design/T-005.md §2: two factories returning the
 * `@core` `VehicleHistoryAdapter`, their source-id constants, the shared
 * options type, and the well-known FIXTURE_VINS. Nothing else — no fixture
 * tables (fixtures are reachable only through `getHistory`), no provider-
 * specific result types, no URL/key/env configuration: such options are
 * inexpressible in this API by design (mock_only enforcement).
 */

export { createCarfaxMock, CARFAX_MOCK_SOURCE } from './carfax-mock.js';
export { createAutoCheckMock, AUTOCHECK_MOCK_SOURCE } from './autocheck-mock.js';
export type { MockHistoryOptions } from './mock-history-adapter.js';
export { FIXTURE_VINS } from './fixtures.js';
