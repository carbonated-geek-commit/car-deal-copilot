/**
 * `@deal-copilot/api` public surface — the barrel (docs/design/T-019.md §1.1,
 * §2).
 *
 * Nothing imports `services/api` in the dependency graph (ADR-009
 * §consequences), so this file exists for two consumers: this service's own
 * tests, and T-020's route plugins, which are registered through
 * `buildServer({ routes })`.
 *
 * NO SPINE TYPE IS DEFINED, WIDENED, OR MIRRORED HERE (ADR-001). `Deal`,
 * `DealerThread`, `Message`, `Offer`, `VehicleInstance`, `VehicleTarget`,
 * `Dealership`, `DealershipContact`, `IdentityRef`, `IsoTimestamp`,
 * `MoneyCents`, `PrequalResult`, `AdapterError`, and every enum union plus
 * vocabulary array come from `@core`. `CommsStore`, `CommsReadModel`,
 * `CommsService`, `RawPayloadStore`, `EventQueue`, `WebhookIngestOutcome`,
 * `NoteSubmission`, `NoteSubmitOutcome`, and `UnroutedRecord` come from
 * `@comms`. `DbHandle`/`DbConfig`/`DbError` come from `@db`,
 * `ObjectStore`/`ObjectStoreConfig` from `@object-store`, `ReceiptStore` from
 * `@receipt`. This service exports only its own edge, authorization,
 * validation, projection, composition, and transport concerns.
 */

// ---- the one error envelope (§2.7) --------------------------------------
export type { ApiError, ApiErrorBody, ApiErrorCode, ApiFieldIssue, ApiResult } from './errors/envelope.js';
export {
  ApiErrorException,
  STATUS_BY_CODE,
  apiError,
  defaultRetryable,
  fail,
  isApiErrorBody,
  ok,
  statusFor,
  throwApi,
  toEnvelope,
} from './errors/envelope.js';
export type { ValidationRoot } from './errors/mapping.js';
export {
  MESSAGE_BY_CODE,
  fromAdapterError,
  fromDbError,
  fromFrameworkError,
  fromReceiptError,
  fromUnknown,
  fromZodError,
  toFieldIssues,
} from './errors/mapping.js';

// ---- configuration and the storage plan (§2.1, §2.2) --------------------
export type { ApiConfig, ApiConfigResult, ApiLogLevel } from './config/env.js';
export {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  readApiConfig,
} from './config/env.js';
export type { ObjectMode, RelationalMode, StoragePlan } from './config/storage.js';
export { describePlan, resolveStoragePlan } from './config/storage.js';

// ---- composition (§2.3) --------------------------------------------------
export type { AppContainer, ContainerDeps } from './composition/container.js';
export { createContainer } from './composition/container.js';
export type { RelationalBindDeps, RelationalBinder, RelationalBinding } from './composition/relational.js';
export { UNAVAILABLE_BINDER, createUnavailableRelationalBinder } from './composition/relational.js';
export {
  UNWIRED_EMAIL_SOURCE,
  UNWIRED_TELEPHONY_SOURCE,
  createUnwiredEmailAdapter,
  createUnwiredTelephonyAdapter,
} from './composition/adapters.js';

// ---- account context at the edge (§2.4) ---------------------------------
export type {
  AccountContext,
  AccountContextResolver,
  AccountContextResult,
  AccountScopeShape,
  ActorRole,
} from './context/account-context.js';
export {
  ACCOUNT_HEADER,
  FIXED_ACCOUNT_SOURCE,
  POC_HEADER_SOURCE,
  accountContext,
  createFixedAccountResolver,
  createPocHeaderResolver,
  requireAccountContext,
} from './context/account-context.js';

// ---- the authorization choke point (§2.5) — E3's entire diff -------------
export type { AuthzDecision, AuthzDenyReason, DealAccessGate, DealAction, DealHandle } from './auth/deal-gate.js';
export {
  PERMISSIVE_GATE,
  STATUS_CODE_BY_DENY_REASON,
  createPermissiveDealGate,
  dealGate,
  requireDealHandle,
} from './auth/deal-gate.js';

// ---- the scoped store seam (§2.6) — no unscoped side --------------------
export type {
  MemorySessionDeps,
  ScopedReadModel,
  ScopedReadModelDeps,
  StoreSession,
  StoreSessionFactory,
  TenancyLogger,
} from './auth/scoped-store.js';
export {
  createMemoryStoreSessionFactory,
  createScopedReadModel,
  runWithSession,
  sessionUnavailable,
} from './auth/scoped-store.js';

// ---- validation (§2.8) --------------------------------------------------
export {
  DEAL_PATHS,
  DEAL_STATUSES,
  NOTE_AUTHORS,
  VOCABULARIES,
  zContactRole,
  zDealPath,
  zDealStatus,
  zMessageAuthor,
  zMessageChannel,
  zMessageDirection,
  zNoteAuthor,
  zOfferFlag,
  zProcessStep,
  zVehicleCondition,
} from './validation/vocab.js';
export type {
  DealIdParam,
  DealThreadParams,
  NoteSubmissionBody,
  PaginationQuery,
} from './validation/schemas.js';
export {
  aprPercent,
  dealIdParam,
  dealThreadParams,
  dealershipIdParam,
  isoTimestamp,
  moneyCents,
  noteSubmissionBody,
  opaqueId,
  paginationQuery,
  processStepBody,
} from './validation/schemas.js';
export type { ValidationSpec } from './validation/plugin.js';
export { validate, validated } from './validation/plugin.js';

// ---- response projections and guards (§3.2, §5.4, §5.5) -----------------
export type {
  AssertNoAudio,
  AssertNoCredit,
  AssertResponseSafe,
  ForbiddenAudioKey,
  ForbiddenCreditKey,
  ForbiddenResponseKey,
  GuardFinding,
} from './projection/guards.js';
export {
  FORBIDDEN_RESPONSE_KEYS,
  assertResponseSafe,
  findGuardViolations,
  omitAbsent,
} from './projection/guards.js';
export type {
  CallMetaView,
  DealView,
  DealerThreadView,
  DealershipContactView,
  DealershipPublicView,
  MessageView,
  OfferView,
  PrequalSummaryView,
  VehicleInstanceView,
  VehicleTargetView,
} from './projection/views.js';
export {
  projectDeal,
  projectDealership,
  projectMessage,
  projectOffer,
  projectPrequal,
  projectThread,
} from './projection/views.js';

// ---- transport (§2.10, §3.3) --------------------------------------------
export type { ApiScope, ServerOptions } from './http/server.js';
export { JSON_CONTENT_TYPE, REQUEST_ID_HEADER, buildServer } from './http/server.js';
export type { RouteAuditFinding, RouteAuditFindingKind } from './http/audit.js';
export { RouteAuditError, auditRoute, auditRouteTable, installRouteAudit } from './http/audit.js';
export type { HealthPluginDeps, ReadinessBody } from './http/health.js';
export { healthPlugin } from './http/health.js';
export type { ApiLogEvent, ApiLogLevelName, ApiLogger } from './http/request-log.js';
export { REDACTED_LOG_PATHS, logSerializers } from './http/request-log.js';
export type { HookMark } from './http/marks.js';
export { chainHasMark, hookMarkOf, markHook } from './http/marks.js';

// ---- the webhook plane (§2.9) — no context, no gate, no store -----------
export type { WebhookAckBody, WebhookPluginDeps } from './webhooks/plugin.js';
export { webhookPlugin } from './webhooks/plugin.js';

// ---- process entry point -------------------------------------------------
export { main } from './start.js';
