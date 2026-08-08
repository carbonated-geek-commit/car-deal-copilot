/**
 * Reusable request primitives (docs/design/T-019.md §2.8, §1.1).
 *
 * REQUEST shapes only. There is no response schema here and there will not be
 * one: responses are `projection/views.ts`'s job, and a second description of
 * the same shape in a second syntax is ADR-001's parallel definition.
 *
 * Every object is `.strict()`. An unknown key is `invalid_request`, never a
 * silent drop — silent dropping is how a client believes it set
 * `walk_away_number` when it actually set `walkaway_number`, and then wonders
 * why `over_walkaway` never fires.
 *
 * There is deliberately NO schema anywhere in this directory that accepts a
 * credit field, a `provider_token`, a recording reference, or a transcript
 * (AC-9, AC-11). The absence is the enforcement: a route cannot validate an
 * input shape that does not exist.
 */

import { z } from 'zod';

import { zNoteAuthor, zProcessStep } from './vocab.js';

/**
 * Opaque spine identifier.
 *
 * NOT `z.uuid()`. `@store-pg` will store uuids, but ADR-008 makes the
 * in-memory store the DEFAULT mode, and `@comms`'s own fixtures use ids like
 * `deal-a`. A uuid-only rule would make the default posture unusable and would
 * put a storage-backend detail into the request contract — the exact coupling
 * AC-8 exists to prevent. Bounded and charset-restricted so an id is always
 * safe to put in a log line and a storage key.
 */
export const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

/**
 * ISO-8601 instant with an EXPLICIT offset — the same rule `@comms/notes.ts`
 * applies to `NoteSubmission.occurred_at`. Conservative on purpose: a bare
 * local time would be silently interpreted in the server's zone, which puts a
 * wrong timestamp into an append-only evidence trail.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export const isoTimestamp = z
  .string()
  .regex(ISO_INSTANT)
  .refine((value) => !Number.isNaN(Date.parse(value)));

/**
 * `@core`: "Integer USD cents. All money in the spine is integer cents — no
 * floats." A non-integer is a rejection, never a rounding: rounding a price
 * silently changes the number the receipt trail will later be asked to prove.
 */
export const moneyCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Annual percentage rate as the spine writes it — e.g. `6.9`, not `0.069`. */
export const aprPercent = z.number().min(0).max(100);

export const dealIdParam = z.object({ deal_id: opaqueId }).strict();

export const dealThreadParams = z.object({ deal_id: opaqueId, dealership_id: opaqueId }).strict();

export const dealershipIdParam = z.object({ dealership_id: opaqueId }).strict();

/**
 * Cursor pagination. `limit` arrives as a query string, so it is coerced —
 * this is the one place coercion is correct, because the transport has no
 * numbers. Bounded so a caller cannot ask for an unbounded page.
 */
export const paginationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * The in-app note body (`@comms` `NoteSubmission`).
 *
 * `deal_id` is NOT here — it is a path parameter, and accepting it in the body
 * too would create two sources for the value the gate authorizes against.
 * `direction` is NOT here — `@comms` fixes it to `internal`.
 *
 * `author` is accepted but constrained to `buyer | concierge`: `@comms` states
 * it must come "from the authenticated session on the write path, NEVER from a
 * request body". Until E3 supplies a session, the shape must still be
 * expressible; T-020's handler is responsible for preferring the account
 * context over this field, and the narrowed enum means the worst a body can
 * claim is a role that is already unable to author dealer evidence (AC — specs/00
 * "Receipt layer": "self-authored evidence is never presented as if it came
 * from the dealer").
 */
export const noteSubmissionBody = z
  .object({
    dealership_id: opaqueId,
    client_note_ref: z.string().min(1).max(200),
    author: zNoteAuthor,
    body: z.string().min(1).max(20_000),
    occurred_at: isoTimestamp.optional(),
  })
  .strict();

/** Thread negotiation state — the only mutable half of a `DealerThread` here. */
export const processStepBody = z.object({ process_step: zProcessStep }).strict();

export type DealIdParam = z.infer<typeof dealIdParam>;
export type DealThreadParams = z.infer<typeof dealThreadParams>;
export type PaginationQuery = z.infer<typeof paginationQuery>;
export type NoteSubmissionBody = z.infer<typeof noteSubmissionBody>;
