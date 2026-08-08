/**
 * @adapters/valuation public API — the only import surface (T-001 D3
 * bare-alias rule; deep imports fail to resolve by construction).
 *
 * KBB-mock + Manheim-mock behind the ONE spine `ValuationAdapter` interface
 * from `@core`, plus the blend step (itself a `ValuationAdapter`) that
 * combines them into the wholesale vs trade-in vs retail view emitted as a
 * cached, timestamped `ValuationSnapshot`.
 *
 * v0.5 (T-013): every snapshot names a `vehicle_instance_id` and every request
 * carries the instance's own year, trim, mileage and condition — a valuation of
 * a bare make/model is not expressible through this surface. Private-party
 * value is KBB's band (Q15); no comps, marketplace or scraping source exists.
 *
 * mock_only: no provider SDK, endpoint, credential, or HTTP exists anywhere in
 * this package — fixtures are the entire data source (CLAUDE.md invariant 2).
 * No KBB- or Manheim-specific shape is exported or expressible.
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
