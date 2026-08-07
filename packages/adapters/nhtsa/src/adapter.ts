/**
 * NHTSA vPIC + Recall API vehicle-data adapter (T-004).
 *
 * Implements the frozen `VehicleDataAdapter` contract from `@core`
 * (packages/core/src/adapters.ts) against the real, free, credential-free
 * NHTSA public endpoints — live-approved on the CLAUDE.md "build and wire
 * now" list. Design: docs/design/T-004.md.
 *
 * Key properties (design D1–D9):
 * - Zero runtime dependencies: HTTP is Node's built-in `fetch`, injectable
 *   via `NhtsaAdapterOptions.fetchFn` so tests are hermetic (D1).
 * - `getRecalls(vin)` is internally two-step — vPIC decode, then
 *   `recallsByVehicle` keyed on make/model/modelYear — because the free
 *   Recall API is not VIN-keyed (D2). Callers see only the spine signature.
 * - Stateless, zero internal retries (D6); `retryable` is reported truthfully
 *   and backoff policy belongs to the caller (T-001 §5.1).
 * - Per-request timeout via `AbortSignal.timeout`, default 10 000 ms (D8).
 * - Error messages are log-safe: no VIN, no raw provider payload (§4.4).
 */

import type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  IsoTimestamp,
  RecallRecord,
  VehicleData,
  VehicleDataAdapter,
  Vin,
  VinDecode,
} from '@core';
import { normalizeVin } from './vin.js';
import { narrowVpicDecode } from './vpic.js';
import { narrowRecalls } from './recalls.js';

/** Adapter id used in `source` fields and error provenance (design D4). */
export const NHTSA_SOURCE = 'nhtsa-vpic' as const;

/** All optional; defaults target the real public endpoints (live-approved, credential-free). */
export interface NhtsaAdapterOptions {
  /** HTTP client injection point — tests pass a fixture-backed stub (D1). Default: globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Default: 'https://vpic.nhtsa.dot.gov/api' */
  vpicBaseUrl?: string;
  /** Default: 'https://api.nhtsa.gov' */
  recallsBaseUrl?: string;
  /** Per-request timeout, ms. Default 10_000 (D8). */
  timeoutMs?: number;
}

const DEFAULT_VPIC_BASE_URL = 'https://vpic.nhtsa.dot.gov/api';
const DEFAULT_RECALLS_BASE_URL = 'https://api.nhtsa.gov';
const DEFAULT_TIMEOUT_MS = 10_000;

/** `retryable` is derived from `code`, stated explicitly (core contract). */
function isRetryable(code: AdapterErrorCode): boolean {
  return code === 'rate_limited' || code === 'provider_unavailable';
}

/** Build the uniform failure arm. `message` must be VIN-free and payload-free (§4.4). */
function failure(code: AdapterErrorCode, message: string): { ok: false; error: AdapterError } {
  return {
    ok: false,
    error: { code, retryable: isRetryable(code), source: NHTSA_SOURCE, message },
  };
}

/** Outcome of one HTTP GET: parsed JSON body, or an already-mapped failure. */
type HttpOutcome =
  | { readonly kind: 'body'; readonly body: unknown }
  | { readonly kind: 'failure'; readonly result: { ok: false; error: AdapterError } };

/**
 * Single-attempt GET + JSON parse with the §4.1 transport-level mapping:
 * rejection/timeout → provider_unavailable; 5xx → provider_unavailable;
 * 429 → rate_limited; other 4xx → malformed_response (endpoint contract
 * drifted — operator alert); non-JSON 200 body → malformed_response.
 */
async function getJson(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  op: string,
): Promise<HttpOutcome> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return {
      kind: 'failure',
      result: failure('provider_unavailable', `${op}: request failed or timed out`),
    };
  }
  const status = response.status;
  if (status >= 500) {
    return {
      kind: 'failure',
      result: failure('provider_unavailable', `${op}: provider returned HTTP ${status}`),
    };
  }
  if (status === 429) {
    return {
      kind: 'failure',
      result: failure('rate_limited', `${op}: provider throttled the request (HTTP 429)`),
    };
  }
  if (status >= 400) {
    return {
      kind: 'failure',
      result: failure(
        'malformed_response',
        `${op}: unexpected HTTP ${status} — endpoint contract may have drifted`,
      ),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'failure',
      result: failure('malformed_response', `${op}: response body was not valid JSON`),
    };
  }
  return { kind: 'body', body };
}

/** Factory — returns a stateless implementation of the @core contract. */
export function createNhtsaVehicleDataAdapter(
  options: NhtsaAdapterOptions = {},
): VehicleDataAdapter {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const vpicBaseUrl = (options.vpicBaseUrl ?? DEFAULT_VPIC_BASE_URL).replace(/\/+$/, '');
  const recallsBaseUrl = (options.recallsBaseUrl ?? DEFAULT_RECALLS_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function decodeVin(vin: Vin): Promise<AdapterResult<VinDecode>> {
    const checked = normalizeVin(vin);
    if (!checked.valid) {
      // §4.1 row 1: local pre-validation, before any HTTP (D3).
      return failure(
        'invalid_input',
        'decodeVin: VIN failed local validation (17 chars, alphanumeric excluding I/O/Q)',
      );
    }
    const url = `${vpicBaseUrl}/vehicles/DecodeVinValues/${checked.vin}?format=json`;
    const outcome = await getJson(fetchFn, url, timeoutMs, 'decodeVin');
    if (outcome.kind === 'failure') return outcome.result;

    const narrowed = narrowVpicDecode(outcome.body, checked.vin);
    switch (narrowed.kind) {
      case 'ok':
        return { ok: true, value: narrowed.decode };
      case 'not_found':
        // §4.1 row 7 — terminal; message stays VIN-less.
        return failure('not_found', 'decodeVin: vPIC has no usable vehicle data for this VIN');
      case 'invalid_vin':
        // §4.1 row 8 — vPIC's in-band verdict on a VIN that passed local checks.
        return failure('invalid_input', 'decodeVin: vPIC reports the VIN as structurally invalid');
      case 'malformed':
        // §4.1 row 6 — operator alert; never the raw body.
        return failure(
          'malformed_response',
          `decodeVin: vPIC response did not match the recorded contract (${narrowed.detail})`,
        );
    }
  }

  async function getRecalls(vin: Vin): Promise<AdapterResult<RecallRecord[]>> {
    // Step 1 (D2): decode to obtain make/model/modelYear — the free Recall
    // API is vehicle-keyed, not VIN-keyed. A decode failure propagates as the
    // SAME AdapterError (§4.2 row 1); source stays 'nhtsa-vpic'.
    const decoded = await decodeVin(vin);
    if (!decoded.ok) return decoded;

    // Step 2: recallsByVehicle.
    const query = new URLSearchParams({
      make: decoded.value.make,
      model: decoded.value.model,
      modelYear: String(decoded.value.year),
    });
    const url = `${recallsBaseUrl}/recalls/recallsByVehicle?${query.toString()}`;
    const outcome = await getJson(fetchFn, url, timeoutMs, 'getRecalls');
    if (outcome.kind === 'failure') return outcome.result;

    const narrowed = narrowRecalls(outcome.body);
    if (narrowed.kind === 'malformed') {
      // §4.2 row 5 — operator alert; raw body never logged.
      return failure(
        'malformed_response',
        `getRecalls: recall response did not match the recorded contract (${narrowed.detail})`,
      );
    }
    // §4.2 row 6: zero campaigns is a SUCCESSFUL answer ({ ok: true, value: [] }).
    return { ok: true, value: narrowed.recalls };
  }

  return { source: NHTSA_SOURCE, decodeVin, getRecalls };
}

/**
 * Pure assembly of the cached, timestamped aggregate (specs/00 core model;
 * design AC-3, D5). Caching/persistence of the result is the caller's job —
 * the adapter holds no state. `history` is deliberately absent: Carfax/
 * AutoCheck is T-005's mock-only territory.
 */
export function toVehicleData(
  decode: VinDecode,
  recalls: RecallRecord[],
  fetched_at: IsoTimestamp,
): VehicleData {
  return { vin: decode.vin, decode, recalls, fetched_at };
}
