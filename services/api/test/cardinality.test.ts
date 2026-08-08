/**
 * Cardinality invariants at the API edge (specs/00 "Cardinality invariants";
 * docs/design/T-019.md §5.6, §5.7).
 *
 * "One deal, one make/model" and "a thread that contradicts the anchor is
 * unrepresentable" are the spine's properties. What this task owes is that no
 * request shape it publishes can express the violation, and that the rule is
 * never reimplemented here.
 */

import { isTargetVehicleLocked } from '@core';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  dealIdParam,
  dealThreadParams,
  noteSubmissionBody,
  paginationQuery,
  processStepBody,
  projectDeal,
  projectThread,
} from '../src/index.js';
import { makeDeal, makeOffer, makeThread } from './fixtures/harness.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

describe('no published request shape can move a locked target vehicle', () => {
  it('accepts no make, model or target_vehicle anywhere', () => {
    const schemas = [dealIdParam, dealThreadParams, noteSubmissionBody, paginationQuery, processStepBody];
    const attempts: readonly Record<string, unknown>[] = [
      { make: 'Honda' },
      { model: 'CR-V' },
      { target_vehicle: { make: 'Honda', model: 'CR-V' } },
      { vehicle_instance: { year: 2022 } },
    ];
    for (const schema of schemas) {
      for (const attempt of attempts) {
        // `.strict()` everywhere: an unknown key is a rejection, never a
        // silent drop, so no route built on these can smuggle one through.
        expect(
          schema.safeParse({ deal_id: 'deal-1', dealership_id: 'd-1', ...attempt }).success,
          JSON.stringify(attempt),
        ).toBe(false);
      }
    }
  });

  it('publishes no schema that could create or edit a globally shared Dealership', () => {
    const dealership_row = { id: 'd-9', name: 'New Motors', state: 'NC', city: 'Cary', zip_code: '27511' };
    for (const schema of [dealIdParam, dealThreadParams, noteSubmissionBody, processStepBody]) {
      expect(schema.safeParse(dealership_row).success).toBe(false);
    }
  });
});

describe('the lock rule lives in @core and is not restated here (D10, ADR-001)', () => {
  it('is @core’s function, and it answers the spec’s question', () => {
    const draft = makeDeal({ status: 'draft', offers: [], dealer_threads: [makeThread()] });
    expect(isTargetVehicleLocked(draft)).toBe(false);
    expect(isTargetVehicleLocked({ ...draft, status: 'active' })).toBe(true);
    expect(isTargetVehicleLocked({ ...draft, offers: [makeOffer()] })).toBe(true);
    expect(
      isTargetVehicleLocked({ ...draft, dealer_threads: [makeThread({ current_offer: makeOffer() })] }),
    ).toBe(true);
  });

  it('has no rival implementation in this service', () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/status\s*!==\s*'draft'/u);
      expect(text, file).not.toMatch(/offers\.length\s*>\s*0/u);
    }
  });
});

describe('a thread cannot contradict the deal’s anchor', () => {
  it('projects a vehicle instance with no make and no model — the spine gives it none', () => {
    const thread = projectThread(
      makeThread({
        vehicle_instance: { id: 'vi-1', year: 2022, condition: 'used', mileage: 31_000, additions: ['tow package'] },
      }),
    );
    expect(Object.keys(thread.vehicle_instance ?? {}).sort()).toEqual(['additions', 'condition', 'id', 'mileage', 'year']);
    expect(JSON.stringify(thread.vehicle_instance)).not.toContain('make');
    expect(JSON.stringify(thread.vehicle_instance)).not.toContain('model');
  });

  it('projects the anchor exactly once, at deal level', () => {
    const view = projectDeal('owner', makeDeal({ target_vehicle: { make: 'Toyota', model: 'RAV4' } }));
    expect(view.target_vehicle).toEqual({ make: 'Toyota', model: 'RAV4' });
    for (const thread of view.dealer_threads) {
      expect(JSON.stringify(thread)).not.toContain('RAV4');
    }
  });
});
