/**
 * T-014 tester — the v0.4 speech-capture vocabulary, assembled at runtime.
 *
 * These strings are built by concatenation ON PURPOSE. The standing gate this
 * task inherits (design §4 row 1) is that a text scan of `services/comms/**`
 * finds ZERO occurrences of the speech-capture vocabulary — comments, fixture
 * names, and test names included. A checker that spells the words it is
 * looking for would poison its own corpus and make the gate meaningless, so
 * nothing in this file (or in any file that imports it) contains a literal
 * occurrence of any of them.
 *
 * Sources: specs/01 (consent posture, resolved 2026-08-07) and
 * decisions/OPEN-QUESTIONS.md Q14 removed audio and speech-to-text from the
 * product entirely; T-010 removed the corresponding spine fields; T-014
 * removed the port, both consumers, the store method, and the subscriptions.
 */

/** Substrings that must not appear anywhere under `services/comms/**`. */
export const REMOVED_VOCABULARY: readonly string[] = [
  'trans' + 'cript',
  're' + 'cording',
  'a' + 's' + 'r',
  'call' + '_' + 'ref',
];

/** Field names that must never appear on a stored `Message`, on any channel. */
export const REMOVED_MESSAGE_FIELDS: readonly string[] = [
  're' + 'cording' + '_url',
  'trans' + 'cript',
  'audio_ref',
  'audio_url',
  'call' + '_' + 'ref',
  'media_url',
];

/** The deleted port's name and its deleted store method (design D1). */
export const REMOVED_PORT_NAME = 'Trans' + 'criptStub';
export const REMOVED_STORE_METHOD = 'set' + 'Trans' + 'cript';
