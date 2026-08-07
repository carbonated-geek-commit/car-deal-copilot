/**
 * NHTSA Recall API raw-shape narrowing — INTERNAL module (docs/design/T-004.md
 * §1). Same anti-corruption rule as `vpic.ts`: nothing here is re-exported
 * from `index.ts`, so no caller can ever see the provider's shape.
 *
 * Endpoint shape narrowed here:
 * `GET {recallsBaseUrl}/recalls/recallsByVehicle?make=&model=&modelYear=` —
 * a `{ Count, Message, results: [...] }` body where each element carries
 * `NHTSACampaignNumber`, `Component`, `Summary`, `ReportReceivedDate` (plus
 * fields the spine does not need, dropped at this boundary).
 */

import type { IsoTimestamp, RecallRecord } from '@core';

/**
 * Outcome of narrowing a Recall API body. Instantiates docs/design/T-004.md
 * §4.2 rows 5–6:
 *   ok (possibly empty array) → success — zero campaigns is a SUCCESSFUL
 *     answer (`{ ok: true, value: [] }`), never `not_found`; a clean vehicle
 *     must not look like an error.
 *   malformed → `malformed_response` — operator alert; contract drifted.
 */
export type RecallsNarrowing =
  | { readonly kind: 'ok'; readonly recalls: RecallRecord[] }
  | { readonly kind: 'malformed'; readonly detail: string };

/** Read a non-empty trimmed string field off a raw record, else undefined. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Normalize the Recall API's `ReportReceivedDate` to the spine's
 * `IsoTimestamp`. Accepts the API's US-style `MM/DD/YYYY` and an ISO
 * `YYYY-MM-DD...` prefix; anything else is contract drift → undefined.
 */
function normalizeReportDate(raw: string): IsoTimestamp | undefined {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (us !== null) {
    const month = Number.parseInt(us[1]!, 10);
    const day = Number.parseInt(us[2]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${us[3]!}-${us[1]!}-${us[2]!}T00:00:00.000Z`;
    }
    return undefined;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso !== null) {
    return `${iso[1]!}-${iso[2]!}-${iso[3]!}T00:00:00.000Z`;
  }
  return undefined;
}

/** Narrow one raw campaign element into the spine's `RecallRecord`. */
function narrowCampaign(item: unknown): RecallRecord | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const campaignId = readString(record, 'NHTSACampaignNumber');
  const component = readString(record, 'Component');
  const summary = readString(record, 'Summary');
  const dateRaw = readString(record, 'ReportReceivedDate');
  if (
    campaignId === undefined ||
    component === undefined ||
    summary === undefined ||
    dateRaw === undefined
  ) {
    return undefined;
  }
  const issuedAt = normalizeReportDate(dateRaw);
  if (issuedAt === undefined) return undefined;
  return {
    campaign_id: campaignId,
    component,
    summary,
    issued_at: issuedAt,
  };
}

/**
 * Narrow an HTTP-200 Recall API body (already JSON-parsed) into
 * `RecallRecord[]` or a typed failure. Pure — no I/O, no logging, no throwing.
 */
export function narrowRecalls(body: unknown): RecallsNarrowing {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'malformed', detail: 'body is not a JSON object' };
  }
  const top = body as Record<string, unknown>;
  // The Recall API uses a lowercase `results` key (unlike vPIC's `Results`);
  // accept either casing so a provider-side normalization does not break us.
  const rawResults = top['results'] ?? top['Results'];
  if (rawResults === undefined || rawResults === null) {
    // Zero-campaign responses may omit the array entirely; only trust that
    // when the in-band Count corroborates it.
    if (top['Count'] === 0) return { kind: 'ok', recalls: [] };
    return { kind: 'malformed', detail: 'results missing' };
  }
  if (!Array.isArray(rawResults)) {
    return { kind: 'malformed', detail: 'results is not an array' };
  }
  const recalls: RecallRecord[] = [];
  for (const item of rawResults) {
    const narrowed = narrowCampaign(item);
    if (narrowed === undefined) {
      return { kind: 'malformed', detail: 'campaign element did not match the recorded contract' };
    }
    recalls.push(narrowed);
  }
  return { kind: 'ok', recalls };
}
