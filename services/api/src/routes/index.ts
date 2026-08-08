/**
 * The route suite (docs/design/T-020.md §2.1, D16).
 *
 * `createRouteSuite(deps)` returns the plugins T-019's `buildServer({ routes })`
 * registers INSIDE the api scope — so every route below inherits the
 * account-context hook and the `api_scope` decoration, and the boot-time route
 * audit still applies to every route they add. Nothing here registers a hook, a
 * scope, an error handler, or a serializer: those are the foundation's, and
 * AC-16 is satisfied by there being no second one to find.
 *
 * D16 — this task adds NO health endpoint. `/healthz` and `/readyz` already
 * exist on T-019's health plane, which deliberately has no account context and
 * no store; a second health route inside the api scope would sit behind a
 * context hook that a probe cannot satisfy, and a readiness probe that returns
 * `401` is worse than none. The war-room read surface AC-1 asks for is
 * `GET /deals/:deal_id/war-room`.
 *
 * Deliberate absences, so they read as decisions rather than oversights
 * (§8.8): no `GET /deals` account list (no port exposes a per-account listing
 * without an unscoped scan, which is the one thing T-019's seam refuses); no
 * `POST /offers` (ADR-006's rollup is the only producer); no dealership update
 * or delete; no cross-thread ranking; no outbound send.
 */

import type { FastifyPluginAsync } from 'fastify';

import { resolveRouteDeps, type RouteSuiteDeps } from './context.js';
import { dealRoutes } from './deals.js';
import { dealershipRoutes } from './dealerships.js';
import { messageRoutes } from './messages.js';
import { offerRoutes } from './offers.js';
import { targetVehicleRoutes } from './target-vehicle.js';
import { threadRoutes } from './threads.js';
import { vehicleInstanceRoutes } from './vehicle-instances.js';

export function createRouteSuite(deps: RouteSuiteDeps = {}): readonly FastifyPluginAsync[] {
  const resolved = resolveRouteDeps(deps);
  return [
    dealRoutes(resolved),
    targetVehicleRoutes(resolved),
    threadRoutes(resolved),
    vehicleInstanceRoutes(resolved),
    messageRoutes(resolved),
    offerRoutes(resolved),
    dealershipRoutes(resolved),
  ];
}

// ---- the suite's own surface ---------------------------------------------
export type { IdFactory, ResolvedRouteDeps, RouteRuntime, RouteSuiteDeps } from './context.js';
export { DETERMINISTIC_IDS, resolveRouteDeps } from './context.js';

export type {
  DealershipDirectory,
  DealershipNaturalKey,
  DealershipSearchPage,
  DirectoryEnsure,
} from './directory.js';
export { canonicalNaturalKey, createInMemoryDealershipDirectory, dealershipId } from './directory.js';

export type { ValuationLookup } from './valuations.js';
export { NO_VALUATIONS, createFixedValuationLookup } from './valuations.js';

export type { AnchorMatch } from './anchor.js';
export { matchesAnchor, normalizeAnchorTerm, yearDrift } from './anchor.js';

export type { Evaluability, EvaluabilityInput, ThreadAssessmentInput, WarRoomInput } from './assessment.js';
export {
  assessDealOffers,
  assessOffer,
  assessThread,
  budgetSignal,
  buildWarRoom,
  deriveEvaluability,
  fairPriceSignal,
} from './assessment.js';

export type { DealFieldPatch, ThreadFieldPatch } from './aggregate.js';
export { findThread, patchDeal, patchThread, withThread } from './aggregate.js';

export type { RejectionFacts, RejectionKind, RejectionMark, RouteLogger } from './receipt-events.js';
export { appendRejectionMark, receiptAuthorFor, rejectionEntry } from './receipt-events.js';

export type {
  BudgetSignalView,
  DealOffersView,
  DealershipPageView,
  FairPriceSignalView,
  FlagStatus,
  FlagStatusView,
  MessagePageView,
  NoteAcceptedView,
  OfferAssessmentView,
  ReceiptTrailView,
  ThreadAssessmentView,
  UnevaluableReason,
  WarRoomView,
  YearDriftView,
} from './views.js';

export {
  dealershipBody,
  dealershipSearchQuery,
  messageBody,
  patchDealBody,
  putDealBody,
  putThreadBody,
  targetVehicleBody,
  vehicleInstanceBody,
  workingWithBody,
  yearRangeBody,
} from './schemas.js';

export { dealRoutes } from './deals.js';
export { dealershipRoutes } from './dealerships.js';
export { messageRoutes } from './messages.js';
export { offerRoutes } from './offers.js';
export { targetVehicleRoutes } from './target-vehicle.js';
export { threadRoutes } from './threads.js';
export { vehicleInstanceRoutes } from './vehicle-instances.js';
