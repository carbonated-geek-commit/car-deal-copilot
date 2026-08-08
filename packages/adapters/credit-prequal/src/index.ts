/**
 * @adapters/credit-prequal public API — the only import surface (T-001 D3).
 *
 * Callers wire the mock via `createMockCreditPrequal` and hand core services
 * the resulting `CreditPrequalAdapter` (from `@core`) and NOTHING else. The
 * scenario/fixture/hosted-flow types below are the mock's harness surface for
 * tests and composition roots; no core service imports them, and none is a
 * provider (Array/Plaid/MeasureOne/bureau) shape — specs/00 anti-corruption.
 */

export type {
  PrequalFixture,
  PrequalScenario,
} from './fixtures.js';
export { DEFAULT_PREQUAL_FIXTURES } from './fixtures.js';

export type {
  MockCreditPrequal,
  MockCreditPrequalOptions,
  MockHostedFlow,
} from './mock-adapter.js';
export {
  createMockCreditPrequal,
  MOCK_CREDIT_PREQUAL_SOURCE,
} from './mock-adapter.js';
