/**
 * The spec-fixed vocabularies as zod enums (docs/design/T-019.md §2.8, D5;
 * AC-5).
 *
 * `packages/core/src/domain.ts` states why the frozen arrays exist: "validators
 * import these rather than re-declaring the literals, which would be ADR-001's
 * 'parallel type definition' in a different syntax." Every enum below is built
 * from the `@core` array, so adding a member to the spine widens the API
 * automatically and no literal is ever typed twice.
 *
 * D5 — the two exceptions, handled so they cannot drift silently: `@core`
 * exports a frozen array for seven of the nine spec-fixed enums but none for
 * `DealPath` or `DealStatus`. `packages/core` belongs to T-010 and is complete,
 * so those two are declared here WITH a compile-time exhaustiveness guard
 * against the `@core` union. Adding `leased` to `DealStatus` in the spine stops
 * THIS package compiling; it does not silently narrow the API. §8.1 recommends
 * a task that owns `@core` add the arrays so these locals can be deleted.
 */

import {
  DEALERSHIP_CONTACT_ROLES,
  MESSAGE_AUTHORS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  OFFER_FLAGS,
  PROCESS_STEPS,
  VEHICLE_CONDITIONS,
  type DealPath,
  type DealStatus,
  type MessageAuthor,
} from '@core';
import { z } from 'zod';

// ---- D5: the two vocabularies @core does not ship, guarded --------------

export const DEAL_PATHS = ['online', 'hybrid', 'in_person'] as const satisfies readonly DealPath[];
export const DEAL_STATUSES = [
  'draft',
  'active',
  'negotiating',
  'closed',
  'burned',
] as const satisfies readonly DealStatus[];

/**
 * The trip-wire. `satisfies` above proves every local literal is a member of
 * the spine union; these two prove the converse — that the union has no member
 * the local array is missing. Without them, a spine that grew a `DealStatus`
 * would leave this validator quietly rejecting a legal value as out-of-enum.
 */
type MissingDealPath = Exclude<DealPath, (typeof DEAL_PATHS)[number]>;
type MissingDealStatus = Exclude<DealStatus, (typeof DEAL_STATUSES)[number]>;
const _deal_path_vocab_is_exhaustive: MissingDealPath extends never ? true : never = true;
const _deal_status_vocab_is_exhaustive: MissingDealStatus extends never ? true : never = true;
void _deal_path_vocab_is_exhaustive;
void _deal_status_vocab_is_exhaustive;

// ---- the enums ----------------------------------------------------------

export const zDealPath = z.enum(DEAL_PATHS);
export const zDealStatus = z.enum(DEAL_STATUSES);
export const zMessageChannel = z.enum(MESSAGE_CHANNELS);
export const zMessageDirection = z.enum(MESSAGE_DIRECTIONS);
export const zMessageAuthor = z.enum(MESSAGE_AUTHORS);
export const zVehicleCondition = z.enum(VEHICLE_CONDITIONS);
export const zContactRole = z.enum(DEALERSHIP_CONTACT_ROLES);
export const zProcessStep = z.enum(PROCESS_STEPS);
export const zOfferFlag = z.enum(OFFER_FLAGS);

/**
 * `note` is authored in-app, so a note's author is never the dealer
 * (`@comms/notes.ts`: "a dealer-authored internal record is a contradiction of
 * the spec's own gloss"). Derived by filtering the `@core` array, exactly as
 * `@comms` derives `NoteAuthor` by `Exclude` — the rule is stated once in the
 * spine and narrowed here, never restated.
 */
export const NOTE_AUTHORS = MESSAGE_AUTHORS.filter(
  (author): author is Exclude<MessageAuthor, 'dealer'> => author !== 'dealer',
);
export const zNoteAuthor = z.enum(NOTE_AUTHORS);

/**
 * The registry the vocabulary-parity test walks: every zod enum in this module
 * paired with the `@core` array it was built from. A new enum that forgets to
 * register here is visible as an absence in one place instead of invisible
 * across seven.
 */
export const VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  deal_path: DEAL_PATHS,
  deal_status: DEAL_STATUSES,
  message_channel: MESSAGE_CHANNELS,
  message_direction: MESSAGE_DIRECTIONS,
  message_author: MESSAGE_AUTHORS,
  vehicle_condition: VEHICLE_CONDITIONS,
  dealership_contact_role: DEALERSHIP_CONTACT_ROLES,
  process_step: PROCESS_STEPS,
  offer_flag: OFFER_FLAGS,
};
