/**
 * T-004 tester — `getRecalls` (docs/design/T-004.md §4.2 + D2 two-step + §5).
 *
 * Coverage map (design row → test):
 *   D2       two-step composition: vPIC decode first, then recallsByVehicle
 *            keyed on make/model/modelYear — invisible to the caller
 *   §4.2 #1  step-1 decode failure propagates as the SAME AdapterError
 *   §4.2 #2  step-2 network/5xx/timeout → provider_unavailable
 *   §4.2 #3  step-2 429 → rate_limited
 *   §4.2 #4  step-2 other 4xx → malformed_response
 *   §4.2 #5  step-2 200 wrong shape → malformed_response
 *   §4.2 #6  step-2 200 zero campaigns → { ok: true, value: [] } — success
 *   §3       RecallRecord mapping (campaign_id/component/summary/issued_at),
 *            date normalization to IsoTimestamp, provider fields dropped
 *   §4.3/D6  zero internal retries; §4.4 log-safe messages
 */

import { describe, expect, it } from 'vitest';
import type { RecallRecord } from '@core';
import { createNhtsaVehicleDataAdapter } from '@adapters/nhtsa';
import {
  clone,
  expectFailure,
  expectOk,
  forbiddenFetch,
  jsonResponse,
  loadFixture,
  recordingFetch,
  textResponse,
} from './helpers.js';

const VIN = '1FTFW1ET5DFC10312';
const VPIC_SUCCESS = loadFixture('vpic-decode-success.json');
const VPIC_UNDECODABLE = loadFixture('vpic-decode-undecodable.json');
const RECALLS_SUCCESS = loadFixture('recalls-success.json');
const RECALLS_EMPTY = loadFixture('recalls-empty.json');

type RawRecalls = { Count: number; results: Array<Record<string, unknown>> };

const isVpicUrl = (url: string) => url.includes('/vehicles/DecodeVinValues/');
const isRecallsUrl = (url: string) => url.includes('/recalls/recallsByVehicle');

/**
 * Standard two-step wiring: vPIC URLs get the recorded decode fixture,
 * recall URLs get `recallsResponse` (default: the recorded success fixture).
 */
function twoStepAdapter(
  recallsRespond: (url: string) => Response | Promise<Response> = () =>
    jsonResponse(RECALLS_SUCCESS),
) {
  const { fetchFn, calls } = recordingFetch((url) => {
    if (isVpicUrl(url)) return jsonResponse(VPIC_SUCCESS);
    if (isRecallsUrl(url)) return recallsRespond(url);
    throw new Error(`unexpected URL requested: ${url}`);
  });
  return { adapter: createNhtsaVehicleDataAdapter({ fetchFn }), calls };
}

describe('getRecalls — D2 two-step composition and endpoint construction', () => {
  it('performs vPIC decode first, then recallsByVehicle keyed on make/model/modelYear', async () => {
    const { adapter, calls } = twoStepAdapter();
    expectOk(await adapter.getRecalls(VIN));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${VIN}?format=json`,
    );
    expect(calls[1]!.url).toBe(
      'https://api.nhtsa.gov/recalls/recallsByVehicle?make=FORD&model=F-150&modelYear=2013',
    );
  });

  it('honors a custom recallsBaseUrl and trims trailing slashes', async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      isVpicUrl(url) ? jsonResponse(VPIC_SUCCESS) : jsonResponse(RECALLS_SUCCESS),
    );
    const adapter = createNhtsaVehicleDataAdapter({
      fetchFn,
      recallsBaseUrl: 'https://recalls.example.test//',
    });
    expectOk(await adapter.getRecalls(VIN));
    expect(calls[1]!.url).toBe(
      'https://recalls.example.test/recalls/recallsByVehicle?make=FORD&model=F-150&modelYear=2013',
    );
  });

  it('URL-encodes query values derived from the decode', async () => {
    const spaced = clone(VPIC_SUCCESS) as { Results: Array<Record<string, unknown>> };
    spaced.Results[0]!['Make'] = 'LAND ROVER';
    spaced.Results[0]!['Model'] = 'RANGE ROVER SPORT';
    const { fetchFn, calls } = recordingFetch((url) =>
      isVpicUrl(url) ? jsonResponse(spaced) : jsonResponse(RECALLS_EMPTY),
    );
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectOk(await adapter.getRecalls(VIN));
    expect(calls[1]!.url).toContain('make=LAND+ROVER');
    expect(calls[1]!.url).toContain('model=RANGE+ROVER+SPORT');
  });
});

describe('getRecalls — §3 success mapping (fixture: recorded Recall API shape)', () => {
  it('maps recorded campaigns into spine RecallRecords, dropping provider fields', async () => {
    const { adapter } = twoStepAdapter();
    const recalls = expectOk(await adapter.getRecalls(VIN));
    expect(recalls).toHaveLength(2);
    const first = recalls[0]!;
    expect(first).toEqual({
      campaign_id: '16V643000',
      component: 'LATCHES/LOCKS/LINKAGES:DOORS:LATCH',
      summary: expect.stringContaining('side door latches') as unknown as string,
      issued_at: '2016-09-06T00:00:00.000Z',
    });
    // Anti-corruption: exactly the spine's four fields — Manufacturer,
    // Consequence, Remedy, parkIt etc. are dropped at the boundary.
    for (const record of recalls) {
      expect(Object.keys(record).sort()).toEqual([
        'campaign_id',
        'component',
        'issued_at',
        'summary',
      ]);
    }
    expect(recalls[1]!.campaign_id).toBe('17V209000');
    expect(recalls[1]!.issued_at).toBe('2017-03-29T00:00:00.000Z');
  });

  it('normalizes an ISO-prefixed ReportReceivedDate as well as the US format', async () => {
    const iso = clone(RECALLS_SUCCESS) as RawRecalls;
    iso.results[0]!['ReportReceivedDate'] = '2016-09-06';
    iso.results = [iso.results[0]!];
    iso.Count = 1;
    const { adapter } = twoStepAdapter(() => jsonResponse(iso));
    const recalls = expectOk(await adapter.getRecalls(VIN));
    expect(recalls[0]!.issued_at).toBe('2016-09-06T00:00:00.000Z');
  });

  it('§4.2 #6 — zero campaigns is a SUCCESSFUL empty array, never an error', async () => {
    const { adapter } = twoStepAdapter(() => jsonResponse(RECALLS_EMPTY));
    const recalls = expectOk(await adapter.getRecalls(VIN));
    expect(recalls).toEqual([]);
  });

  it('accepts a zero-campaign body that omits the results array when Count is 0', async () => {
    const { adapter } = twoStepAdapter(() =>
      jsonResponse({ Count: 0, Message: 'Results returned successfully' }),
    );
    expect(expectOk(await adapter.getRecalls(VIN))).toEqual([]);
  });

  it('accepts an uppercase Results key (provider-side normalization tolerance)', async () => {
    const upper = {
      Count: (RECALLS_SUCCESS as RawRecalls).Count,
      Results: (RECALLS_SUCCESS as RawRecalls).results,
    };
    const { adapter } = twoStepAdapter(() => jsonResponse(upper));
    expect(expectOk(await adapter.getRecalls(VIN))).toHaveLength(2);
  });
});

describe('getRecalls — §4.2 #1 step-1 decode failure propagates unchanged', () => {
  it('propagates invalid_input for a mangled VIN with ZERO fetch calls', async () => {
    const { fetchFn, calls } = forbiddenFetch();
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectFailure(await adapter.getRecalls('NOT-A-VIN'), 'invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('propagates provider_unavailable from a step-1 500 without attempting step 2', async () => {
    const { fetchFn, calls } = recordingFetch((url) => {
      if (isVpicUrl(url)) return textResponse('down', 500);
      throw new Error('step 2 must not run when step 1 fails');
    });
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectFailure(await adapter.getRecalls(VIN), 'provider_unavailable');
    expect(calls).toHaveLength(1);
  });

  it('propagates not_found from an undecodable VIN without attempting step 2', async () => {
    const { fetchFn, calls } = recordingFetch((url) => {
      if (isVpicUrl(url)) return jsonResponse(VPIC_UNDECODABLE);
      throw new Error('step 2 must not run when step 1 fails');
    });
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    const error = expectFailure(await adapter.getRecalls('ZZZZZZZZZZZZZZZZZ'), 'not_found');
    expect(error.source).toBe('nhtsa-vpic'); // composition invisible: one coherent source
    expect(calls).toHaveLength(1);
  });

  it('propagates rate_limited from a step-1 429 without attempting step 2', async () => {
    const { fetchFn, calls } = recordingFetch((url) => {
      if (isVpicUrl(url)) return textResponse('throttled', 429);
      throw new Error('step 2 must not run when step 1 fails');
    });
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectFailure(await adapter.getRecalls(VIN), 'rate_limited');
    expect(calls).toHaveLength(1);
  });
});

describe('getRecalls — §4.2 #2–#4 step-2 transport and status mapping', () => {
  it('maps a step-2 rejected fetch to provider_unavailable (single attempt, D6)', async () => {
    const { adapter, calls } = twoStepAdapter(() => {
      return Promise.reject(new Error('ECONNRESET')) as Promise<Response>;
    });
    expectFailure(await adapter.getRecalls(VIN), 'provider_unavailable');
    expect(calls).toHaveLength(2); // decode + exactly one recall attempt
  });

  it('maps a step-2 500 to provider_unavailable', async () => {
    const { adapter } = twoStepAdapter(() => textResponse('down', 500));
    expectFailure(await adapter.getRecalls(VIN), 'provider_unavailable');
  });

  it('maps a step-2 429 to rate_limited', async () => {
    const { adapter } = twoStepAdapter(() => textResponse('throttled', 429));
    expectFailure(await adapter.getRecalls(VIN), 'rate_limited');
  });

  it('maps a step-2 404 to malformed_response (contract drift, operator alert)', async () => {
    const { adapter } = twoStepAdapter(() => textResponse('gone', 404));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });
});

describe('getRecalls — §4.2 #5 step-2 malformed 200 bodies', () => {
  it('rejects a 200 body that is not valid JSON', async () => {
    const { adapter } = twoStepAdapter(() => textResponse('<html>nope</html>'));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects a top-level array body', async () => {
    const { adapter } = twoStepAdapter(() => jsonResponse([]));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects a missing results array when Count is non-zero', async () => {
    const { adapter } = twoStepAdapter(() => jsonResponse({ Count: 3 }));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects results that is not an array', async () => {
    const { adapter } = twoStepAdapter(() => jsonResponse({ Count: 1, results: 'many' }));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects a campaign element missing a required field', async () => {
    const dropped = clone(RECALLS_SUCCESS) as RawRecalls;
    delete dropped.results[0]!['NHTSACampaignNumber'];
    const { adapter } = twoStepAdapter(() => jsonResponse(dropped));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects a campaign element with an unparseable date (contract drift)', async () => {
    const badDate = clone(RECALLS_SUCCESS) as RawRecalls;
    badDate.results[0]!['ReportReceivedDate'] = 'September 6th, 2016';
    const { adapter } = twoStepAdapter(() => jsonResponse(badDate));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects an out-of-range US date (month 13)', async () => {
    const badDate = clone(RECALLS_SUCCESS) as RawRecalls;
    badDate.results[0]!['ReportReceivedDate'] = '13/06/2016';
    const { adapter } = twoStepAdapter(() => jsonResponse(badDate));
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });

  it('rejects a campaign element that is not an object', async () => {
    const { adapter } = twoStepAdapter(() =>
      jsonResponse({ Count: 1, results: ['16V643000'] }),
    );
    expectFailure(await adapter.getRecalls(VIN), 'malformed_response');
  });
});

describe('getRecalls — uniform contract properties', () => {
  it('never includes the VIN in any error message (§4.4)', async () => {
    const failures: Array<() => Response> = [
      () => textResponse('x', 500),
      () => textResponse('x', 429),
      () => textResponse('x', 404),
      () => textResponse('not json'),
      () => jsonResponse({ Count: 9 }),
    ];
    for (const respond of failures) {
      const { adapter } = twoStepAdapter(respond);
      const res = await adapter.getRecalls(VIN);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).not.toContain(VIN);
        expect(res.error.source).toBe('nhtsa-vpic');
      }
    }
  });

  it('returns RecallRecord[] assignable to the spine type (compile-time check)', async () => {
    const { adapter } = twoStepAdapter();
    const recalls: RecallRecord[] = expectOk(await adapter.getRecalls(VIN));
    expect(Array.isArray(recalls)).toBe(true);
  });
});
