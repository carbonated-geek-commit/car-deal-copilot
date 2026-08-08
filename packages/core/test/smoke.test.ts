/**
 * Trivial smoke spec (T-001 builder) — proves the `@core` alias resolves
 * through both tsconfig paths and the vitest alias map, and that vitest exits
 * green with only packages/core present (AC-8).
 *
 * The full smoke-test design (docs/design/T-001.md §6) is the tester stage's
 * scope; this file only keeps the pipeline runnable.
 */
import { describe, expect, it } from 'vitest';
import { OFFER_FLAGS } from '@core';

describe('@core smoke', () => {
  it('resolves the @core alias and exports the ADR-002 flag vocabulary', () => {
    expect(OFFER_FLAGS).toContain('payment_packing');
    expect(OFFER_FLAGS).not.toContain('packing');
  });
});
