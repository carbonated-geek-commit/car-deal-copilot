/**
 * `@deal-copilot/object-store` public surface — the ONE internal interface for
 * durable object storage over an S3-compatible backend (docs/design/T-018.md
 * §2).
 *
 * specs/00 "Core domain model" (**Store**): the object store holds "email
 * attachments, uploaded documents, and generated dossiers. **No audio is
 * stored.**" specs/01 "Consent & recording posture": "no audio is ever
 * captured or stored." There is no method, no content-type allowlist entry,
 * and no key convention here through which a recording could enter, and
 * `ArtifactKind` has no audio member for one to be requested with.
 *
 * specs/00 "Integrations — anti-corruption / adapter layer (shared)": "Every
 * external feed sits behind one internal interface. Core services never see a
 * provider's shape." Nothing below exposes `@aws-sdk/client-s3` — no client,
 * no command, no stream, no exception type. That SDK is imported by exactly
 * one module, `s3-backend.ts`, which is NOT exported from this barrel, so
 * moving to another S3-compatible provider is a wiring change.
 *
 * ADR-001: no spine type is defined here. `AdapterResult`/`AdapterError`/
 * `IsoTimestamp` come from `@core`; `RawPayloadStore` and `canonicalJson` come
 * from `@comms`. This package moves BYTES PLUS A LOCATION and knows nothing
 * else about the domain — no Deal, Offer, VehicleInstance, valuation band, or
 * flag appears anywhere in it.
 */

// the internal contract — types only, no provider shape
export type {
  ArtifactKind,
  ArtifactLocation,
  ListFilter,
  ListPage,
  ObjectMetadata,
  ObjectRef,
  ObjectStore,
  ObjectStoreConfig,
  ObjectStoreLogEvent,
  ObjectStoreLogger,
  ObjectStoreResult,
  ObjectSummary,
  PutArtifactRequest,
  PutOutcome,
  PutResult,
  StoredArtifact,
} from './contract.js';
export { ARTIFACT_KINDS } from './contract.js';

// references and content addressing (AC-5: a Postgres row carries `ObjectRef`)
export {
  buildArtifactRef,
  isRefOwnedBy,
  parseArtifactRef,
  sha256Hex,
} from './keys.js';

// content policy — the AC-3 gate, exported so a caller can pre-check an upload
export { ALLOWED_CONTENT_TYPES, DEFAULT_MAX_BYTES } from './content-policy.js';

// factories
export { createInMemoryObjectStore, createS3ObjectStore } from './artifact-store.js';

// configuration (D10: the composition root owns `process.env`, not this package)
export { readObjectStoreConfig } from './config.js';

// the RawPayloadStore seam (ADR-009 §1; D5 write-behind)
export type { RawPayloadStoreOptions, S3RawPayloadStore } from './raw-payloads.js';
export { createS3RawPayloadStore } from './raw-payloads.js';
