/**
 * vPIC raw-shape narrowing — INTERNAL module (docs/design/T-004.md §1).
 *
 * The types describing NHTSA vPIC JSON live here and are never re-exported
 * from `index.ts`; since `@adapters/nhtsa` resolves only to `src/index.ts`,
 * no caller can import a provider shape — the anti-corruption boundary is
 * structural (specs/00 "Core services never see a provider's shape").
 *
 * Endpoint shape narrowed here: flat-format decode,
 * `GET {vpicBaseUrl}/vehicles/DecodeVinValues/{vin}?format=json` — a single
 * response object in `Results[0]` carrying ~140 string-valued fields. Exactly
 * the fields needed for the spine's `VinDecode` are read; everything else is
 * dropped at this boundary.
 */

import type { Vin, VinDecode } from '@core';

/**
 * Outcome of narrowing a vPIC decode body. Instantiates docs/design/T-004.md
 * §4.1 rows 6–8; the adapter maps these onto `AdapterError` codes:
 *   ok          → success
 *   not_found   → `not_found` (row 7: shape fine, no usable make/model/year)
 *   invalid_vin → `invalid_input` (row 8: vPIC in-band error says the VIN
 *                 itself is structurally invalid despite passing local checks)
 *   malformed   → `malformed_response` (row 6: body is not the recorded
 *                 vPIC contract — operator alert; fixtures must be re-recorded)
 */
export type VpicDecodeNarrowing =
  | { readonly kind: 'ok'; readonly decode: VinDecode }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_vin' }
  | { readonly kind: 'malformed'; readonly detail: string };

/**
 * vPIC `ErrorCode` values (comma-separated in-band) that indicate the VIN
 * string itself is structurally invalid even though it passed the local
 * 17-char/alphabet check (D3 deliberately omits check-digit math):
 *   1 — check digit (9th position) does not calculate properly
 *   6 — incomplete VIN
 * Other non-zero codes (partial decode, manufacturer not registered, no
 * detailed data) are treated as "no usable data" → not_found, per §4.1 row 7.
 */
const STRUCTURALLY_INVALID_VIN_CODES: ReadonlySet<string> = new Set(['1', '6']);

/** Read a non-empty trimmed string field off a raw record, else undefined. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Best-effort engine description from vPIC fields; undefined when absent. */
function readEngine(record: Record<string, unknown>): string | undefined {
  const engineModel = readString(record, 'EngineModel');
  if (engineModel !== undefined) return engineModel;
  const displacement = readString(record, 'DisplacementL');
  if (displacement === undefined) return undefined;
  const cylinders = readString(record, 'EngineCylinders');
  return cylinders === undefined
    ? `${displacement}L`
    : `${displacement}L ${cylinders}-cyl`;
}

/**
 * Narrow an HTTP-200 vPIC decode body (already JSON-parsed) into the spine's
 * `VinDecode` or a typed failure. Pure — no I/O, no logging, no throwing.
 * `vin` is the locally normalized VIN; the returned decode always carries it
 * (canonical form), never whatever echo the provider sent back.
 */
export function narrowVpicDecode(body: unknown, vin: Vin): VpicDecodeNarrowing {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'malformed', detail: 'body is not a JSON object' };
  }
  const results = (body as Record<string, unknown>)['Results'];
  if (!Array.isArray(results) || results.length === 0) {
    return { kind: 'malformed', detail: 'Results missing or empty' };
  }
  const first: unknown = results[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    return { kind: 'malformed', detail: 'Results[0] is not an object' };
  }
  const record = first as Record<string, unknown>;

  const make = readString(record, 'Make');
  const model = readString(record, 'Model');
  const yearRaw = readString(record, 'ModelYear');
  const year = yearRaw === undefined ? Number.NaN : Number.parseInt(yearRaw, 10);

  if (make !== undefined && model !== undefined && Number.isInteger(year)) {
    const trim = readString(record, 'Trim');
    const bodyClass = readString(record, 'BodyClass');
    const engine = readEngine(record);
    const decode: VinDecode = {
      vin,
      make,
      model,
      year,
      ...(trim !== undefined ? { trim } : {}),
      ...(bodyClass !== undefined ? { body_class: bodyClass } : {}),
      ...(engine !== undefined ? { engine } : {}),
    };
    return { kind: 'ok', decode };
  }

  // No usable make/model/year — decide not_found vs invalid_vin from the
  // provider's in-band ErrorCode (comma/space-separated numeric codes).
  const errorCodes = (readString(record, 'ErrorCode') ?? '')
    .split(/[^0-9]+/)
    .filter((code) => code !== '' && code !== '0');
  const structurallyInvalid = errorCodes.some((code) =>
    STRUCTURALLY_INVALID_VIN_CODES.has(code),
  );
  return structurallyInvalid ? { kind: 'invalid_vin' } : { kind: 'not_found' };
}
