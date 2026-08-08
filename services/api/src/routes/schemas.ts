/**
 * Route request schemas (docs/design/T-020.md §3.2).
 *
 * REQUEST shapes only, built ON T-019's primitives (`opaqueId`, `moneyCents`,
 * `isoTimestamp`, `noteSubmissionBody`, `paginationQuery`) and its `@core`-derived
 * zod enums. Nothing here re-declares a vocabulary literal: `packages/core`
 * states why ("validators import these rather than re-declaring the literals,
 * which would be ADR-001's 'parallel type definition' in a different syntax").
 *
 * Every object is `.strict()`. An unknown key is `invalid_request`, never a
 * silent drop — silent dropping is how a client believes it set
 * `walk_away_number` when it actually set `walkaway_number`.
 *
 * §5.1 layer 2 — `make`/`model` appear in exactly THREE shapes: the deal create,
 * the target-vehicle write, and the wire-only claim on a vehicle-instance write.
 * `patchDealBody` cannot express them at all, so the ordinary edit path cannot
 * reach the write-once invariant.
 *
 * §5.3 — `vin` is `z.string().min(1).max(64)` and nothing more. No checksum, no
 * 17-character rule, no charset rule, no decode call anywhere in this suite
 * (Q16: "VIN is user-entered and unvalidated at launch — the buyer's own record,
 * not a lookup key").
 */

import { z } from 'zod';

import { moneyCents, noteSubmissionBody, paginationQuery } from '../validation/schemas.js';
import { zContactRole, zDealPath, zDealStatus, zProcessStep, zVehicleCondition } from '../validation/vocab.js';

/** Free text the buyer typed, bounded so it is safe as a storage value. */
const shortText = (max: number): z.ZodString => z.string().trim().min(1).max(max);

/**
 * A SOFT GUIDE (`@core`: "`year_range` is NOT readonly"). Bounded to plausible
 * model years and ordered, because an inverted range describes no span at all —
 * that is a malformed value, not a drift the guide is meant to tolerate.
 */
export const yearRangeBody = z
  .object({ from: z.number().int().min(1900).max(2200), to: z.number().int().min(1900).max(2200) })
  .strict()
  .refine((range) => range.from <= range.to);

const anchorTerms = {
  make: shortText(80),
  model: shortText(80),
};

/**
 * `PUT /deals/:deal_id` — creation (D1).
 *
 * There is no `owner_id` and no `id` here: the id is the URL and the owner is
 * the handle's scope. There is no `status` either — a created deal is `draft`,
 * which is the only state in which `target_vehicle` is settable.
 */
export const putDealBody = z
  .object({
    path: zDealPath,
    budget: moneyCents,
    walk_away_number: moneyCents,
    target_vehicle: z
      .object({ ...anchorTerms, year_range: yearRangeBody.optional() })
      .strict(),
  })
  .strict();

/**
 * `PATCH /deals/:deal_id`.
 *
 * `make`/`model` are structurally absent — §5.1 layer 2. The only reachable
 * part of `target_vehicle` is the soft guide.
 */
export const patchDealBody = z
  .object({
    path: zDealPath.optional(),
    status: zDealStatus.optional(),
    budget: moneyCents.optional(),
    /** The DEAL-level budget ceiling (Q20). No thread or offer shape can express it. */
    walk_away_number: moneyCents.optional(),
    target_vehicle: z.object({ year_range: yearRangeBody }).strict().optional(),
  })
  .strict();

/** `PUT /deals/:deal_id/target-vehicle` — the ONE make/model write path. */
export const targetVehicleBody = z
  .object({
    ...anchorTerms,
    year_range: yearRangeBody.optional(),
    /** Optional caller anchor; only affects the rejection receipt's `dedupe_key`. */
    client_attempt_ref: z.string().min(1).max(200).optional(),
  })
  .strict();

/** Account-PRIVATE contact (specs/00 "Dealership data tenancy"). */
export const workingWithBody = z
  .object({
    name: shortText(160),
    role: zContactRole,
    phone: z.string().trim().min(1).max(40).optional(),
    email: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

/** `PUT /deals/:deal_id/threads/:dealership_id` — create/ensure. */
export const putThreadBody = z
  .object({
    process_step: zProcessStep.optional(),
    working_with: workingWithBody.optional(),
  })
  .strict()
  .optional();

/**
 * `PUT …/vehicle-instance`.
 *
 * D3 — `make` and `model` are carried at the WIRE ONLY. They are compared
 * against the deal anchor and then DISCARDED: `@core.VehicleInstance` has no
 * field for them, which is exactly why the check belongs at this boundary.
 */
export const vehicleInstanceBody = z
  .object({
    ...anchorTerms,
    vin: z.string().trim().min(1).max(64).optional(),
    year: z.number().int().min(1900).max(2200),
    trim: shortText(80).optional(),
    mileage: z.number().int().min(0).max(10_000_000).optional(),
    condition: zVehicleCondition,
    additions: z.array(shortText(120)).max(100).optional(),
    client_attempt_ref: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * `POST /deals/:deal_id/threads/:dealership_id/messages`.
 *
 * T-019's `noteSubmissionBody`, NARROWED — never re-declared. `dealership_id`
 * is a path parameter here for the same reason T-019 kept `deal_id` out of that
 * body: two sources for the value the route authorizes against is one source
 * too many. `direction` is absent because `@comms` fixes it to `internal`, and
 * `author` stays REQUIRED because specs/00 says it is "never inferred".
 */
export const messageBody = noteSubmissionBody.omit({ dealership_id: true });

/** `POST /dealerships` — the GLOBAL natural key (migration `0004`). */
export const dealershipBody = z
  .object({
    name: shortText(160),
    state: z.string().trim().min(2).max(16),
    city: shortText(120),
    zip_code: z.string().trim().min(3).max(12),
  })
  .strict();

/** `GET /dealerships` — bounded prefix search over the global directory. */
export const dealershipSearchQuery = paginationQuery.extend({ q: z.string().trim().min(1).max(120).optional() });

export type PutDealBody = z.infer<typeof putDealBody>;
export type PatchDealBody = z.infer<typeof patchDealBody>;
export type TargetVehicleBody = z.infer<typeof targetVehicleBody>;
export type WorkingWithBody = z.infer<typeof workingWithBody>;
export type PutThreadBody = z.infer<typeof putThreadBody>;
export type VehicleInstanceBody = z.infer<typeof vehicleInstanceBody>;
export type MessageBody = z.infer<typeof messageBody>;
export type DealershipBody = z.infer<typeof dealershipBody>;
export type DealershipSearchQuery = z.infer<typeof dealershipSearchQuery>;
