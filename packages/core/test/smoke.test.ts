/**
 * Smoke spec — proves the `@core` alias resolves through both tsconfig paths and
 * the vitest alias map, and that the v0.5 runtime surface is reachable.
 */
import { describe, expect, it } from 'vitest';
import { MESSAGE_CHANNELS, OFFER_FLAGS, isTargetVehicleLocked } from '@core';

describe('@core smoke', () => {
  it('resolves the @core alias and exports the ADR-002/ADR-007 flag vocabulary', () => {
    expect(OFFER_FLAGS).toContain('payment_packing');
    expect(OFFER_FLAGS).toContain('above_market');
    expect(OFFER_FLAGS).not.toContain('packing');
  });

  it('exports the v0.5 message vocabulary and the write-once predicate', () => {
    expect(MESSAGE_CHANNELS).toContain('note');
    expect(isTargetVehicleLocked({ status: 'draft', offers: [], dealer_threads: [] })).toBe(false);
  });
});
