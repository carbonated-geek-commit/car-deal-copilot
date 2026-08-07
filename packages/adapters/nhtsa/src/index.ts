/**
 * @adapters/nhtsa — public API (docs/design/T-004.md §2).
 *
 * Exactly three exports (plus the options type): the adapter id, the factory,
 * and the pure `VehicleData` assembly helper. Raw NHTSA shapes live in the
 * internal `vpic.ts` / `recalls.ts` modules and are deliberately NOT
 * re-exported — since the `@adapters/nhtsa` alias resolves only to this file,
 * a caller cannot import a provider shape even deliberately (anti-corruption
 * boundary, specs/00 "Core services never see a provider's shape").
 */

export { NHTSA_SOURCE, createNhtsaVehicleDataAdapter, toVehicleData } from './adapter.js';
export type { NhtsaAdapterOptions } from './adapter.js';
