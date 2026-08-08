/**
 * `Account` owns `Deals`, and `Dealership` is global while `DealershipContact`
 * is account-private (docs/design/T-019.md §2.6, §5.1, §5.3; AC-2, AC-10).
 *
 * In the ADR-008 DEFAULT mode `InMemoryCommsStore` has no account column at
 * all, so the response-path re-check is not belt-and-braces — it is the ONLY
 * tenancy enforcement in the service. These tests exercise it as such.
 */

import type { Deal, DealerThread } from '@core';
import type { CommsReadModel, UnroutedRecord } from '@comms';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPermissiveDealGate,
  createScopedReadModel,
  projectDealership,
  projectThread,
  type ApiErrorBody,
  type DealHandle,
} from '../src/index.js';
import {
  asAccount,
  makeContact,
  makeDeal,
  makeDealership,
  makeThread,
  memoryContainer,
  serve,
  type Served,
} from './fixtures/harness.js';
import { fixtureRoutes } from './fixtures/routes.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

/**
 * A handle a test can hold. `DealHandle`'s brand is module-private, so this
 * cast is the ONLY way to build one outside `auth/deal-gate.ts` — which is
 * exactly the property `static-invariants.test.ts` asserts `src/**` never uses.
 */
const handleFor = (deal_id: string, account_id: string): DealHandle =>
  ({
    deal_id,
    action: 'read',
    account: { scope: { account_id }, role: 'owner', source: 'test', request_id: 'r' },
    scope: { account_id },
  }) as unknown as DealHandle;

interface ReadSpy extends CommsReadModel {
  readonly calls: string[];
}

const readSpy = (deals: readonly Deal[], threads: readonly [string, DealerThread][] = []): ReadSpy => {
  const calls: string[] = [];
  const thread_map = new Map(threads);
  return {
    calls,
    getDeal(deal_id: string): Deal | undefined {
      calls.push(`getDeal:${deal_id}`);
      return deals.find((deal) => deal.id === deal_id);
    },
    getThread(deal_id: string, dealership_id: string): DealerThread | undefined {
      calls.push(`getThread:${deal_id}:${dealership_id}`);
      return thread_map.get(`${deal_id}:${dealership_id}`);
    },
    listQuarantined() {
      calls.push('listQuarantined');
      return [];
    },
    listUnrouted(deal_id?: string): readonly UnroutedRecord[] {
      calls.push(`listUnrouted:${deal_id ?? '<UNSCOPED>'}`);
      return [];
    },
  };
};

describe('ScopedReadModel — the only door, and it re-checks owner_id', () => {
  it('answers for the owning account', async () => {
    const deal = makeDeal({ id: 'deal-1', owner_id: 'account-a' });
    const read = createScopedReadModel({ read: readSpy([deal]) });
    expect((await read.getDeal(handleFor('deal-1', 'account-a')))?.id).toBe('deal-1');
  });

  it('answers `undefined` for another account, indistinguishably from absent (D3)', async () => {
    const deal = makeDeal({ id: 'deal-1', owner_id: 'account-a' });
    const rejections: unknown[] = [];
    const read = createScopedReadModel({ read: readSpy([deal]), log: (event) => rejections.push(event) });
    expect(await read.getDeal(handleFor('deal-1', 'account-b'))).toBeUndefined();
    expect(await read.getDeal(handleFor('deal-nonexistent', 'account-a'))).toBeUndefined();
    expect(rejections).toEqual([
      { event: 'tenancy_reject', layer: 'response', account_id: 'account-b', deal_id: 'deal-1' },
    ]);
  });

  it('establishes ownership on the DEAL before it will read a thread', async () => {
    const deal = makeDeal({ id: 'deal-1', owner_id: 'account-a' });
    const thread = makeThread({ dealership_id: 'dealership-1', working_with: makeContact() });
    const spy = readSpy([deal], [['deal-1:dealership-1', thread]]);
    const read = createScopedReadModel({ read: spy });

    expect(await read.getThread(handleFor('deal-1', 'account-b'), 'dealership-1')).toBeUndefined();
    // The thread row was never even loaded for the foreign account.
    expect(spy.calls).toEqual(['getDeal:deal-1']);

    expect(await read.getThread(handleFor('deal-1', 'account-a'), 'dealership-1')).toBeDefined();
    expect(spy.calls).toContain('getThread:deal-1:dealership-1');
  });

  it('never reaches the unscoped operator surfaces', async () => {
    const deal = makeDeal({ id: 'deal-1', owner_id: 'account-a' });
    const spy = readSpy([deal]);
    const read = createScopedReadModel({ read: spy });

    // The rule is kept BY ABSENCE: there is nothing here to call.
    expect(Object.keys(read).sort()).toEqual(['getDeal', 'getThread', 'listUnrouted']);
    expect((read as unknown as Record<string, unknown>)['listQuarantined']).toBeUndefined();

    await read.listUnrouted(handleFor('deal-1', 'account-a'));
    expect(spy.calls).toContain('listUnrouted:deal-1');
    expect(spy.calls).not.toContain('listUnrouted:<UNSCOPED>');
    expect(spy.calls).not.toContain('listQuarantined');

    // …and a foreign account gets an empty list, not the operator's view.
    expect(await read.listUnrouted(handleFor('deal-1', 'account-b'))).toEqual([]);
  });

  it('keys every read by the handle’s own deal id — one handle cannot read another deal', async () => {
    const spy = readSpy([makeDeal({ id: 'deal-1' }), makeDeal({ id: 'deal-2' })]);
    const read = createScopedReadModel({ read: spy });
    expect((await read.getDeal(handleFor('deal-2', 'account-a')))?.id).toBe('deal-2');
    expect(spy.calls).toEqual(['getDeal:deal-2']);
  });
});

describe('the store session seam has no unscoped side', () => {
  it('offers a handle-keyed door and nothing else', async () => {
    const container = await memoryContainer();
    expect(Object.keys(container.sessions).sort()).toEqual(['forDeal', 'mode', 'withDeal']);
    for (const forbidden of ['forAccount', 'unscoped', 'raw', 'all']) {
      expect((container.sessions as unknown as Record<string, unknown>)[forbidden], forbidden).toBeUndefined();
    }
    await container.close();
  });

  it('binds an append-only receipt store to the session — no update, no delete exists', async () => {
    const container = await memoryContainer();
    const opened = await container.sessions.forDeal(handleFor('deal-1', 'account-a'));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(Object.keys(opened.value.receipts).sort()).toEqual(['append', 'read']);
      for (const forbidden of ['update', 'delete', 'remove', 'overwrite', 'truncate', 'put']) {
        expect((opened.value.receipts as unknown as Record<string, unknown>)[forbidden], forbidden).toBeUndefined();
      }
    }
    await container.close();
  });
});

describe('end to end: a read never crosses an account or a deal', () => {
  const boot = async (deals: readonly Deal[]): Promise<Served> => {
    const gate = createPermissiveDealGate();
    const container = await memoryContainer();
    const s = await serve({ container, gate, routes: [fixtureRoutes({ gate, container, seeds: deals })] });
    served = s;
    for (const deal of deals) {
      const seeded = await s.app.inject({
        method: 'POST',
        url: `/deals/${deal.id}/seed`,
        headers: asAccount(deal.owner_id),
      });
      expect(seeded.statusCode, `seeding ${deal.id}`).toBe(200);
    }
    return s;
  };

  it('serves the owner and refuses everyone else with the same 404', async () => {
    const deal = makeDeal({ id: 'deal-1', owner_id: 'account-a' });
    const s = await boot([deal]);

    const owner = await s.app.inject({ method: 'GET', url: '/deals/deal-1', headers: asAccount('account-a') });
    expect(owner.statusCode).toBe(200);
    expect((JSON.parse(owner.body) as { id: string }).id).toBe('deal-1');

    const stranger = await s.app.inject({ method: 'GET', url: '/deals/deal-1', headers: asAccount('account-b') });
    const absent = await s.app.inject({ method: 'GET', url: '/deals/deal-999', headers: asAccount('account-b') });
    expect(stranger.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);

    const strip = (raw: string): unknown => ({ ...(JSON.parse(raw) as ApiErrorBody).error, request_id: '<id>' });
    expect(strip(stranger.body)).toEqual(strip(absent.body));
    // Nothing about the real deal leaks into the refusal.
    expect(stranger.body).not.toContain('account-a');
    expect(stranger.body).not.toContain('RAV4');
  });

  it('never serves one deal in answer to a request for another', async () => {
    const s = await boot([
      makeDeal({ id: 'deal-1', owner_id: 'account-a', target_vehicle: { make: 'Toyota', model: 'RAV4' } }),
      makeDeal({ id: 'deal-2', owner_id: 'account-a', target_vehicle: { make: 'Honda', model: 'CR-V' } }),
    ]);
    const res = await s.app.inject({ method: 'GET', url: '/deals/deal-2', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Deal;
    expect(body.id).toBe('deal-2');
    expect(body.target_vehicle.model).toBe('CR-V');
    expect(res.body).not.toContain('RAV4');
  });

  it('keeps a DealershipContact inside the owning account’s thread response only', async () => {
    const contact = makeContact({ name: 'Dana Reyes', phone: '+15550001111', email: 'dana@northside.example' });
    const deal = makeDeal({
      id: 'deal-1',
      owner_id: 'account-a',
      dealer_threads: [makeThread({ dealership_id: 'dealership-1', working_with: contact })],
    });
    const s = await boot([deal]);

    const owner = await s.app.inject({
      method: 'GET',
      url: '/deals/deal-1/threads/dealership-1',
      headers: asAccount('account-a'),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain('Dana Reyes');

    const stranger = await s.app.inject({
      method: 'GET',
      url: '/deals/deal-1/threads/dealership-1',
      headers: asAccount('account-b'),
    });
    expect(stranger.statusCode).toBe(404);
    for (const private_value of ['Dana Reyes', '+15550001111', 'dana@northside.example']) {
      expect(stranger.body, private_value).not.toContain(private_value);
    }
  });
});

describe('the tenancy split is structural, not a filter someone must remember', () => {
  it('gives the global Dealership view no place to put a contact (AC-10)', () => {
    const projected = projectDealership({
      ...makeDealership(),
      // A widened spine row, as a defensive case: the projection is a `Pick`.
      ...({ working_with: makeContact(), staff: [makeContact()] } as unknown as Record<string, never>),
    });
    expect(Object.keys(projected).sort()).toEqual(['city', 'id', 'name', 'state', 'zip_code']);
    expect(JSON.stringify(projected)).not.toContain('Dana Reyes');
  });

  it('carries the account-private contact only in the deal-scoped thread projection', () => {
    const thread = projectThread(makeThread({ working_with: makeContact({ name: 'Dana Reyes' }) }));
    expect(thread.working_with?.name).toBe('Dana Reyes');
    const bare = projectThread(makeThread());
    expect('working_with' in bare).toBe(false);
  });
});
