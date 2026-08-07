/**
 * @adapters/valuation public API — the only import surface (T-001 D3
 * bare-alias rule; deep imports fail to resolve by construction).
 *
 * KBB-mock + Manheim-mock behind the ONE spine `ValuationAdapter` interface
 * from `@core`, plus the blend step (itself a `ValuationAdapter`) that
 * combines them into the wholesale vs trade-in vs retail view emitted as a
 * cached, timestamped `ValuationSnapshot`.
 *
 * mock_only: no provider SDK, endpoint, credential, or HTTP exists anywhere in
 * this package — fixtures are the entire data source (CLAUDE.md invariant 2).
 * No KBB- or Manheim-specific shape is exported or expressible (AC-1).
 */

export {
  type ValuationFixtureRow,
  type MockValuationOptions,
} from './mock-adapter.js';

export { KBB_MOCK_SOURCE, createKbbMockAdapter } from './kbb-mock.js';
export { MANHEIM_MOCK_SOURCE, createManheimMockAdapter } from './manheim-mock.js';

export {
  BLEND_SOURCE_PREFIX,
  blendSnapshots,
  type BlendedValuationSources,
  createBlendedValuationAdapter,
} from './blend.js';

export { KBB_DEFAULT_FIXTURES } from './fixtures/kbb.fixtures.js';
export { MANHEIM_DEFAULT_FIXTURES } from './fixtures/manheim.fixtures.js';
