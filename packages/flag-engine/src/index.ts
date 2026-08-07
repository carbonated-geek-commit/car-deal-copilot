/**
 * @flag-engine public API — the only import surface for this package
 * (docs/design/T-002.md §2).
 *
 * Exactly one function, its three input types, and its result type
 * (`FlagEvaluation` — ADR-005: the unevaluable set travels with flag results).
 * Deliberately NOT exported: per-flag predicates (internal detail), any
 * "attach flags to offer" helper (callers spread
 * `{ ...offer, flags: evaluateOffer(...).flags }` so the replace-not-merge
 * rule stays visible in caller code — design D5), and any re-export of
 * `@core` types (consumers import the spine from `@core`).
 */

export { evaluateOffer } from './engine.js';
export type { FlagContext, FlagEngineConfig, FeeFairCap, FlagEvaluation } from './engine.js';
