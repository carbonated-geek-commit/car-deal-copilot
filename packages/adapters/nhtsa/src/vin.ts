/**
 * Local VIN normalization/validation (docs/design/T-004.md D3) — pure, no I/O.
 *
 * Rules: 17 characters, alphanumeric excluding I/O/Q, uppercased before use.
 * Full check-digit math is deliberately NOT implemented — vPIC is authoritative
 * and duplicating its validation invites drift (D3). Failure here maps to
 * `invalid_input` in the adapter, before any HTTP call is made.
 */

import type { Vin } from '@core';

/** 17 chars, digits + letters excluding I, O, Q (standard VIN alphabet). */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export type VinValidation =
  | { readonly valid: true; readonly vin: Vin }
  | { readonly valid: false };

/**
 * Trim + uppercase the input, then check shape. Returns the normalized VIN on
 * success so all downstream URLs and mapped records use the canonical form.
 */
export function normalizeVin(input: Vin): VinValidation {
  const vin = input.trim().toUpperCase();
  if (!VIN_PATTERN.test(vin)) {
    return { valid: false };
  }
  return { valid: true, vin };
}
