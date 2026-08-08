/**
 * T-004 tester — `decodeVin` (docs/design/T-004.md §4.1 error table + §5).
 *
 * Coverage map (design row → test):
 *   §4.1 #1  mangled VIN → invalid_input, ZERO fetch calls (D3)
 *   §4.1 #2  network rejection / timeout-abort → provider_unavailable (D8)
 *   §4.1 #3  HTTP 5xx → provider_unavailable
 *   §4.1 #4  HTTP 429 → rate_limited
 *   §4.1 #5  other 4xx → malformed_response
 *   §4.1 #6  200 non-JSON / wrong shape → malformed_response
 *   §4.1 #7  200 undecodable (recorded fixture, ErrorCode 8) → not_found
 *   §4.1 #8  200 vPIC in-band structurally-invalid VIN (ErrorCode 1/6) → invalid_input
 *   §4.3/D6  zero internal retries — exactly one HTTP attempt per call
 *   §4.4     log-safe messages: no VIN, no raw payload fragments
 *   §2       endpoint/query construction, VIN normalization (D3), base-URL handling
 *   §3       anti-corruption mapping into the spine's VinDecode only
 */

import { describe, expect, it } from 'vitest';
import { createNhtsaVehicleDataAdapter, NHTSA_SOURCE } from '@adapters/nhtsa';
import {
  clone,
  expectFailure,
  expectOk,
  forbiddenFetch,
  hangingFetch,
  jsonResponse,
  loadFixture,
  recordingFetch,
  textResponse,
} from './helpers.js';

const VIN = '1FTFW1ET5DFC10312';
const VPIC_SUCCESS = loadFixture('vpic-decode-success.json');
const VPIC_UNDECODABLE = loadFixture('vpic-decode-undecodable.json');
const VPIC_MALFORMED = loadFixture('vpic-malformed.json');

type RawVpic = { Results: Array<Record<string, unknown>> };

/** Adapter wired to a stub that always serves `response` (or a per-call responder). */
function adapterWith(respond: (url: string, i: number) => Response | Promise<Response>) {
  const { fetchFn, calls } = recordingFetch(respond);
  return { adapter: createNhtsaVehicleDataAdapter({ fetchFn }), calls };
}

describe('decodeVin — success mapping (fixture: recorded vPIC flat decode)', () => {
  it('maps the recorded vPIC shape into the spine VinDecode, dropping provider fields', async () => {
    const { adapter, calls } = adapterWith(() => jsonResponse(VPIC_SUCCESS));
    const decode = expectOk(await adapter.decodeVin(VIN));
    expect(decode).toEqual({
      vin: VIN,
      make: 'FORD',
      model: 'F-150',
      year: 2013,
      trim: 'SuperCrew-SSV',
      body_class: 'Pickup',
      engine: 'GTDI',
    });
    // Anti-corruption: exactly the spine's fields, none of vPIC's ~140 raw keys.
    expect(Object.keys(decode).sort()).toEqual([
      'body_class',
      'engine',
      'make',
      'model',
      'trim',
      'vin',
      'year',
    ]);
    expect(calls).toHaveLength(1);
  });

  it('targets the documented vPIC endpoint with format=json (§2 endpoints table)', async () => {
    const { adapter, calls } = adapterWith(() => jsonResponse(VPIC_SUCCESS));
    expectOk(await adapter.decodeVin(VIN));
    expect(calls[0]!.url).toBe(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${VIN}?format=json`,
    );
  });

  it('normalizes the VIN (trim + uppercase, D3) for both the URL and the returned decode', async () => {
    const { adapter, calls } = adapterWith(() => jsonResponse(VPIC_SUCCESS));
    const decode = expectOk(await adapter.decodeVin('  1ftfw1et5dfc10312  '));
    expect(decode.vin).toBe(VIN);
    expect(calls[0]!.url).toContain(`/DecodeVinValues/${VIN}?`);
  });

  it('returns the canonical local VIN, never the provider echo (anti-corruption)', async () => {
    const echoed = clone(VPIC_SUCCESS) as RawVpic;
    echoed.Results[0]!['VIN'] = 'PROVIDER-ECHO-DIFFERS';
    const { adapter } = adapterWith(() => jsonResponse(echoed));
    const decode = expectOk(await adapter.decodeVin(VIN));
    expect(decode.vin).toBe(VIN);
  });

  it('honors a custom vpicBaseUrl and trims trailing slashes', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(VPIC_SUCCESS));
    const adapter = createNhtsaVehicleDataAdapter({
      fetchFn,
      vpicBaseUrl: 'https://vpic.example.test/api///',
    });
    expectOk(await adapter.decodeVin(VIN));
    expect(calls[0]!.url).toBe(
      `https://vpic.example.test/api/vehicles/DecodeVinValues/${VIN}?format=json`,
    );
  });

  it('omits optional fields when vPIC sends empty strings (exact-optional semantics)', async () => {
    const sparse = clone(VPIC_SUCCESS) as RawVpic;
    const record = sparse.Results[0]!;
    record['Trim'] = '';
    record['BodyClass'] = '   ';
    record['EngineModel'] = '';
    record['DisplacementL'] = '';
    record['EngineCylinders'] = '';
    const { adapter } = adapterWith(() => jsonResponse(sparse));
    const decode = expectOk(await adapter.decodeVin(VIN));
    expect('trim' in decode).toBe(false);
    expect('body_class' in decode).toBe(false);
    expect('engine' in decode).toBe(false);
    expect(decode.make).toBe('FORD');
  });

  it('falls back to displacement + cylinders for engine when EngineModel is absent', async () => {
    const noModel = clone(VPIC_SUCCESS) as RawVpic;
    noModel.Results[0]!['EngineModel'] = '';
    const { adapter } = adapterWith(() => jsonResponse(noModel));
    expect(expectOk(await adapter.decodeVin(VIN)).engine).toBe('3.5L 6-cyl');

    const noCyl = clone(VPIC_SUCCESS) as RawVpic;
    noCyl.Results[0]!['EngineModel'] = '';
    noCyl.Results[0]!['EngineCylinders'] = '';
    const { adapter: adapter2 } = adapterWith(() => jsonResponse(noCyl));
    expect(expectOk(await adapter2.decodeVin(VIN)).engine).toBe('3.5L');
  });
});

describe('decodeVin — §4.1 #1 local pre-validation (invalid_input, no HTTP)', () => {
  const badVins = [
    ['too short', '1FTFW1ET5DFC1031'],
    ['too long', '1FTFW1ET5DFC103122'],
    ['contains I', '1FTFW1ETIDFC10312'],
    ['contains O', '1FTFW1ETODFC10312'],
    ['contains Q', '1FTFW1ETQDFC10312'],
    ['illegal punctuation', '1FTFW1ET5DFC1031!'],
    ['empty', ''],
    ['whitespace only', '                 '],
  ] as const;

  for (const [label, vin] of badVins) {
    it(`rejects a mangled VIN (${label}) with invalid_input and ZERO fetch calls`, async () => {
      const { fetchFn, calls } = forbiddenFetch();
      const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
      const error = expectFailure(await adapter.decodeVin(vin), 'invalid_input');
      expect(calls).toHaveLength(0);
      // §4.4 — the VIN itself never appears in the log-safe message.
      if (vin.trim() !== '') {
        expect(error.message).not.toContain(vin.trim());
      }
    });
  }
});

describe('decodeVin — §4.1 #2 transport failures (provider_unavailable, retryable)', () => {
  it('maps a rejected fetch to provider_unavailable', async () => {
    const { fetchFn, calls } = recordingFetch(() => {
      return Promise.reject(new Error('ECONNRESET'));
    });
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectFailure(await adapter.decodeVin(VIN), 'provider_unavailable');
    expect(calls).toHaveLength(1); // D6: single attempt, no internal retry
  });

  it('maps a synchronously-throwing fetch to provider_unavailable (never throws across the boundary)', async () => {
    const badFetch = (() => {
      throw new Error('sync explosion');
    }) as unknown as typeof fetch;
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn: badFetch });
    expectFailure(await adapter.decodeVin(VIN), 'provider_unavailable');
  });

  it('times out via the injected AbortSignal (D8) and maps to provider_unavailable', async () => {
    const { fetchFn, calls } = hangingFetch();
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn, timeoutMs: 25 });
    expectFailure(await adapter.decodeVin(VIN), 'provider_unavailable');
    expect(calls).toHaveLength(1);
    const signal = calls[0]!.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('decodeVin — §4.1 #3–#5 HTTP status mapping', () => {
  it('maps HTTP 500 to provider_unavailable (retryable)', async () => {
    const { adapter, calls } = adapterWith(() => textResponse('oops', 500));
    expectFailure(await adapter.decodeVin(VIN), 'provider_unavailable');
    expect(calls).toHaveLength(1);
  });

  it('maps HTTP 503 to provider_unavailable (retryable)', async () => {
    const { adapter } = adapterWith(() => textResponse('maintenance', 503));
    expectFailure(await adapter.decodeVin(VIN), 'provider_unavailable');
  });

  it('maps HTTP 429 to rate_limited (retryable)', async () => {
    const { adapter } = adapterWith(() => textResponse('slow down', 429));
    expectFailure(await adapter.decodeVin(VIN), 'rate_limited');
  });

  it('maps HTTP 404 (endpoint moved / contract broke) to malformed_response, not retryable', async () => {
    const { adapter } = adapterWith(() => textResponse('not here', 404));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('maps HTTP 400 to malformed_response, not retryable', async () => {
    const { adapter } = adapterWith(() => textResponse('bad request', 400));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });
});

describe('decodeVin — §4.1 #6 malformed 200 bodies (malformed_response)', () => {
  it('rejects a 200 body that is not valid JSON', async () => {
    const { adapter } = adapterWith(() => textResponse('<html>definitely not json</html>'));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('rejects the recorded malformed fixture (Results key missing)', async () => {
    const { adapter } = adapterWith(() => jsonResponse(VPIC_MALFORMED));
    const error = expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
    // §4.4 — never the raw body in the message.
    expect(error.message).not.toContain('unexpected');
    expect(error.message).not.toContain('SearchCriteria');
  });

  it('rejects a top-level JSON array', async () => {
    const { adapter } = adapterWith(() => jsonResponse([1, 2, 3]));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('rejects a top-level JSON null', async () => {
    const { adapter } = adapterWith(() => jsonResponse(null));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('rejects an empty Results array', async () => {
    const { adapter } = adapterWith(() => jsonResponse({ Count: 0, Results: [] }));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('rejects Results that is not an array', async () => {
    const { adapter } = adapterWith(() => jsonResponse({ Results: { Make: 'FORD' } }));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });

  it('rejects Results[0] that is not an object', async () => {
    const { adapter } = adapterWith(() => jsonResponse({ Results: ['FORD'] }));
    expectFailure(await adapter.decodeVin(VIN), 'malformed_response');
  });
});

describe('decodeVin — §4.1 #7/#8 vPIC in-band verdicts', () => {
  it('maps the recorded undecodable fixture (ErrorCode 8, empty fields) to not_found', async () => {
    const { adapter } = adapterWith(() => jsonResponse(VPIC_UNDECODABLE));
    const error = expectFailure(await adapter.decodeVin('ZZZZZZZZZZZZZZZZZ'), 'not_found');
    expect(error.message).not.toContain('ZZZZZZZZZZZZZZZZZ'); // §4.4
  });

  it('maps in-band ErrorCode 1 (check digit) to invalid_input (row 8)', async () => {
    const bad = clone(VPIC_UNDECODABLE) as RawVpic;
    bad.Results[0]!['ErrorCode'] = '1';
    const { adapter } = adapterWith(() => jsonResponse(bad));
    expectFailure(await adapter.decodeVin(VIN), 'invalid_input');
  });

  it('maps in-band ErrorCode 6 (incomplete VIN) to invalid_input (row 8)', async () => {
    const bad = clone(VPIC_UNDECODABLE) as RawVpic;
    bad.Results[0]!['ErrorCode'] = '6';
    const { adapter } = adapterWith(() => jsonResponse(bad));
    expectFailure(await adapter.decodeVin(VIN), 'invalid_input');
  });

  it('maps a comma-separated in-band code list containing 1 to invalid_input', async () => {
    const bad = clone(VPIC_UNDECODABLE) as RawVpic;
    bad.Results[0]!['ErrorCode'] = '1,14';
    const { adapter } = adapterWith(() => jsonResponse(bad));
    expectFailure(await adapter.decodeVin(VIN), 'invalid_input');
  });

  it('maps other non-zero codes (partial decode, no data) to not_found (row 7)', async () => {
    const bad = clone(VPIC_UNDECODABLE) as RawVpic;
    bad.Results[0]!['ErrorCode'] = '14';
    const { adapter } = adapterWith(() => jsonResponse(bad));
    expectFailure(await adapter.decodeVin(VIN), 'not_found');
  });

  it('maps a shape-valid body with missing year to not_found (no usable make/model/year)', async () => {
    const noYear = clone(VPIC_SUCCESS) as RawVpic;
    noYear.Results[0]!['ModelYear'] = '';
    noYear.Results[0]!['ErrorCode'] = '0';
    const { adapter } = adapterWith(() => jsonResponse(noYear));
    expectFailure(await adapter.decodeVin(VIN), 'not_found');
  });
});

describe('decodeVin — uniform contract properties', () => {
  it('reports source "nhtsa-vpic" (D4) on the adapter and every error', async () => {
    expect(NHTSA_SOURCE).toBe('nhtsa-vpic');
    const { adapter } = adapterWith(() => textResponse('oops', 500));
    expect(adapter.source).toBe('nhtsa-vpic');
    const res = await adapter.decodeVin(VIN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.source).toBe('nhtsa-vpic');
  });

  it('never includes the VIN in any error message (§4.4 log discipline)', async () => {
    const scenarios: Array<() => Response> = [
      () => textResponse('x', 500),
      () => textResponse('x', 429),
      () => textResponse('x', 404),
      () => textResponse('not json'),
      () => jsonResponse(VPIC_MALFORMED),
      () => jsonResponse(VPIC_UNDECODABLE),
    ];
    for (const respond of scenarios) {
      const { adapter } = adapterWith(respond);
      const res = await adapter.decodeVin(VIN);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).not.toContain(VIN);
    }
  });

  it('makes exactly one HTTP attempt per call even across repeated failures (D6)', async () => {
    const { adapter, calls } = adapterWith(() => textResponse('x', 500));
    await adapter.decodeVin(VIN);
    await adapter.decodeVin(VIN);
    expect(calls).toHaveLength(2); // one per invocation — never more
  });
});
