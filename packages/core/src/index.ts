/**
 * @core public API — the ONLY import surface for the shared spine.
 *
 * Cross-package imports go exclusively through this file via the bare `@core`
 * alias (docs/design/T-001.md D3). Deep imports are forbidden by construction:
 * no `@core/*` alias entries exist.
 */

export * from './domain.js';
export * from './adapters.js';
export * from './events.js';
