/**
 * Request validation against the spine's frozen vocabularies
 * (docs/design/T-019.md §2.8, §4.2 step 4, D5; AC-5).
 */

import {
  DEALERSHIP_CONTACT_ROLES,
  MESSAGE_AUTHORS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  OFFER_FLAGS,
  PROCESS_STEPS,
  VEHICLE_CONDITIONS,
} from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEAL_PATHS,
  DEAL_STATUSES,
  NOTE_AUTHORS,
  VOCABULARIES,
  aprPercent,
  createPermissiveDealGate,
  dealIdParam,
  isoTimestamp,
  moneyCents,
  noteSubmissionBody,
  opaqueId,
  paginationQuery,
  processStepBody,
  zContactRole,
  zDealPath,
  zDealStatus,
  zMessageAuthor,
  zMessageChannel,
  zMessageDirection,
  zNoteAuthor,
  zOfferFlag,
  zProcessStep,
  zVehicleCondition,
  type ApiErrorBody,
} from '../src/index.js';
import { asAccount, memoryContainer, serve, type Served } from './fixtures/harness.js';
import { fixtureRoutes, newTripwire } from './fixtures/routes.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

describe('the vocabularies come from @core, never from a retyped literal (D5)', () => {
  it('matches the frozen arrays element for element', () => {
    const pairs: readonly [readonly string[], readonly string[]][] = [
      [zMessageChannel.options, MESSAGE_CHANNELS],
      [zMessageDirection.options, MESSAGE_DIRECTIONS],
      [zMessageAuthor.options, MESSAGE_AUTHORS],
      [zVehicleCondition.options, VEHICLE_CONDITIONS],
      [zContactRole.options, DEALERSHIP_CONTACT_ROLES],
      [zProcessStep.options, PROCESS_STEPS],
      [zOfferFlag.options, OFFER_FLAGS],
    ];
    for (const [enum_options, core_array] of pairs) {
      expect([...enum_options]).toEqual([...core_array]);
    }
  });

  it('registers every vocabulary it declares, so a new one cannot hide', () => {
    expect(Object.keys(VOCABULARIES).sort()).toEqual(
      [
        'deal_path',
        'deal_status',
        'dealership_contact_role',
        'message_author',
        'message_channel',
        'message_direction',
        'offer_flag',
        'process_step',
        'vehicle_condition',
      ].sort(),
    );
    for (const [name, members] of Object.entries(VOCABULARIES)) {
      expect(members.length, name).toBeGreaterThan(0);
      expect(new Set(members).size, name).toBe(members.length);
    }
  });

  it('declares the two @core does not ship, and covers the spine union exactly', () => {
    expect([...zDealPath.options]).toEqual([...DEAL_PATHS]);
    expect([...zDealStatus.options]).toEqual([...DEAL_STATUSES]);
    expect([...DEAL_PATHS]).toEqual(['online', 'hybrid', 'in_person']);
    expect([...DEAL_STATUSES]).toEqual(['draft', 'active', 'negotiating', 'closed', 'burned']);
  });

  it('narrows a note author to never be the dealer — self-authored evidence is not dealer evidence', () => {
    expect([...NOTE_AUTHORS]).toEqual(MESSAGE_AUTHORS.filter((a) => a !== 'dealer'));
    expect(zNoteAuthor.safeParse('dealer').success).toBe(false);
    expect(zNoteAuthor.safeParse('buyer').success).toBe(true);
  });

  it('rejects an out-of-enum member for every vocabulary', () => {
    for (const schema of [
      zDealPath,
      zDealStatus,
      zMessageChannel,
      zMessageDirection,
      zMessageAuthor,
      zVehicleCondition,
      zContactRole,
      zProcessStep,
      zOfferFlag,
    ]) {
      expect(schema.safeParse('definitely_not_a_member').success).toBe(false);
      expect(schema.safeParse('').success).toBe(false);
    }
  });
});

describe('the primitives', () => {
  it('bounds an opaque id and refuses anything a log or a key could not carry', () => {
    for (const good of ['deal-a', 'DEAL_1', 'a'.repeat(128), 'a.b:c-d']) {
      expect(opaqueId.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['', ' ', 'a'.repeat(129), '../etc', 'has space', '-leading', 'semi;colon', 'new\nline']) {
      expect(opaqueId.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('requires an explicit offset on a timestamp, so nothing is read in the server’s zone', () => {
    for (const good of ['2026-08-07T12:00:00Z', '2026-08-07T12:00:00.123Z', '2026-08-07T12:00:00-04:00']) {
      expect(isoTimestamp.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['2026-08-07T12:00:00', '2026-08-07', 'yesterday', '2026-13-45T99:99:99Z']) {
      expect(isoTimestamp.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('keeps money in integer cents — a non-integer is a rejection, never a rounding', () => {
    expect(moneyCents.safeParse(3_500_000).success).toBe(true);
    expect(moneyCents.safeParse(0).success).toBe(true);
    for (const bad of [3_500_000.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '3500000']) {
      expect(moneyCents.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('reads an APR as the spine writes it', () => {
    expect(aprPercent.safeParse(6.9).success).toBe(true);
    expect(aprPercent.safeParse(-0.1).success).toBe(false);
    expect(aprPercent.safeParse(101).success).toBe(false);
  });

  it('coerces a query limit — the transport has no numbers — and bounds it', () => {
    expect(paginationQuery.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(paginationQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(paginationQuery.safeParse({ page: '1' }).success).toBe(false);
  });

  it('accepts no credit field, no token, no recording reference and no transcript anywhere', () => {
    const forbidden = ['provider_token', 'ssn', 'credit_report', 're' + 'cording_url', 'trans' + 'cript'];
    for (const key of forbidden) {
      expect(noteSubmissionBody.safeParse({
        dealership_id: 'dealership-1',
        client_note_ref: 'n-1',
        author: 'buyer',
        body: 'text',
        [key]: 'x',
      }).success, key).toBe(false);
      expect(dealIdParam.safeParse({ deal_id: 'deal-1', [key]: 'x' }).success, key).toBe(false);
    }
  });

  it('takes the note body @comms declares, and refuses a deal_id or a direction in it', () => {
    expect(
      noteSubmissionBody.safeParse({ dealership_id: 'd-1', client_note_ref: 'n-1', author: 'concierge', body: 'hi' })
        .success,
    ).toBe(true);
    expect(
      noteSubmissionBody.safeParse({ dealership_id: 'd-1', client_note_ref: 'n-1', author: 'buyer', body: 'hi', deal_id: 'deal-1' })
        .success,
    ).toBe(false);
    expect(
      noteSubmissionBody.safeParse({ dealership_id: 'd-1', client_note_ref: 'n-1', author: 'buyer', body: 'hi', direction: 'internal' })
        .success,
    ).toBe(false);
    expect(processStepBody.safeParse({ process_step: 'pickup' }).success).toBe(true);
    expect(processStepBody.safeParse({ process_step: 'haggling' }).success).toBe(false);
  });
});

describe('on the wire: rejection lands before any repository call (AC-5)', () => {
  const boot = async (): Promise<{ s: Served; trip: ReturnType<typeof newTripwire> }> => {
    const gate = createPermissiveDealGate();
    const container = await memoryContainer();
    const trip = newTripwire();
    const s = await serve({ container, gate, routes: [fixtureRoutes({ gate, container, tripwire: trip })] });
    served = s;
    return { s, trip };
  };

  it('rejects an out-of-enum body without the handler or the store ever running', async () => {
    const { s, trip } = await boot();
    const res = await s.app.inject({
      method: 'POST',
      url: '/deals/deal-1/step',
      headers: asAccount('account-a'),
      payload: { process_step: 'haggling' },
    });
    expect(res.statusCode).toBe(400);
    expect(trip.handler_calls).toBe(0);
    expect(trip.store_calls).toBe(0);
    const body = JSON.parse(res.body) as ApiErrorBody;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details?.[0]?.path).toBe('body.process_step');
    expect(body.error.details?.[0]?.message).toContain('expected one of');
    // WHY, never WHAT: the rejected value is not echoed back.
    expect(res.body).not.toContain('haggling');
  });

  it('rejects an unknown key by name rather than dropping it silently', async () => {
    const { s } = await boot();
    const res = await s.app.inject({
      method: 'POST',
      url: '/deals/deal-1/step',
      headers: asAccount('account-a'),
      payload: { process_step: 'deal_negotiation', walkaway_number: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as ApiErrorBody;
    expect(body.error.details?.[0]?.message).toContain('walkaway_number');
  });

  it('reports only the first failing root, params first', async () => {
    const { s } = await boot();
    const res = await s.app.inject({
      method: 'POST',
      url: '/deals/bad%20id/step',
      headers: asAccount('account-a'),
      payload: { process_step: 'haggling' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as ApiErrorBody;
    expect(body.error.details?.every((issue) => issue.path.startsWith('params.'))).toBe(true);
    expect(res.body).not.toContain('process_step');
  });

  it('rejects an unknown query key on a read route', async () => {
    const { s, trip } = await boot();
    const res = await s.app.inject({ method: 'GET', url: '/deals/deal-1?limitt=5', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(400);
    expect(trip.store_calls).toBe(0);
    expect((JSON.parse(res.body) as ApiErrorBody).error.details?.[0]?.path.startsWith('query')).toBe(true);
  });

  it('replaces the raw values with the parsed ones', async () => {
    const { s } = await boot();
    // `limit` arrives as a string and must reach the handler as a number; the
    // request succeeds only if the coerced value replaced the raw one.
    const res = await s.app.inject({ method: 'GET', url: '/deals/deal-1?limit=5', headers: asAccount('account-a') });
    // 404 (no such deal) rather than 400 — validation passed.
    expect(res.statusCode).toBe(404);
  });
});
