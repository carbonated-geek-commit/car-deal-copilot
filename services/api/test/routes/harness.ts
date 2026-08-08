/**
 * Shared harness for the T-020 route suite (docs/design/T-020.md §1.2, §6).
 *
 * NOT a test file (vitest collects `*.test.ts` only).
 *
 * Everything here is OFFLINE by construction (ADR-008): the container is the
 * in-memory pair composed with no `DATABASE_URL` and no object-store config, the
 * dealership directory is in-memory, and the valuation lookup is either
 * `NO_VALUATIONS` or a fixed table. No adapter, no socket, no clock the test
 * cannot see. The mock-only integrations (KBB, Manheim, Carfax, AutoCheck,
 * credit) are not reachable from this service at all — T-019's import allowlist
 * excludes `@adapters/*` — so there is nothing here to accidentally point at a
 * live provider.
 */

import type { Dealership, ValuationSnapshot } from '@core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { AccountContextResolver, AppContainer, DealHandle } from '../../src/index.js';
import {
  NO_VALUATIONS,
  createFixedValuationLookup,
  createInMemoryDealershipDirectory,
  createRouteSuite,
  dealershipId,
  type DealershipDirectory,
  type DealershipNaturalKey,
  type ValuationLookup,
} from '../../src/routes/index.js';
import { asAccount, memoryContainer, serve, type Served } from '../fixtures/harness.js';

export const ACCOUNT_A = 'account-a';
export const ACCOUNT_B = 'account-b';

/** Fixed clock, so a receipt entry's `occurred_at` is an asserted constant. */
export const NOW = '2026-08-08T15:04:05.000Z';

/** Counts every lookup so "no route consulted a valuation" is provable. */
export interface ValuationSpy extends ValuationLookup {
  readonly calls: string[];
}

export const spyValuations = (snapshots: readonly ValuationSnapshot[] = []): ValuationSpy => {
  const inner = snapshots.length === 0 ? NO_VALUATIONS : createFixedValuationLookup(snapshots);
  const calls: string[] = [];
  return {
    calls,
    snapshotFor(vehicle_instance_id: string): Promise<ValuationSnapshot | undefined> {
      calls.push(vehicle_instance_id);
      return inner.snapshotFor(vehicle_instance_id);
    },
  };
};

export interface BootOptions {
  readonly dealerships?: readonly Dealership[];
  readonly valuations?: ValuationLookup;
  readonly directory?: DealershipDirectory;
  readonly container?: AppContainer;
  /** Defaults to T-019's poc-header resolver, so tests can name an account. */
  readonly resolver?: AccountContextResolver;
}

export interface Booted {
  readonly app: FastifyInstance;
  readonly container: AppContainer;
  readonly directory: DealershipDirectory;
  close(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<Booted> {
  const container = options.container ?? (await memoryContainer());
  const directory = options.directory ?? createInMemoryDealershipDirectory(options.dealerships ?? []);
  const routes = createRouteSuite({
    directory,
    ...(options.valuations !== undefined && { valuations: options.valuations }),
    now: () => NOW,
  });
  const served: Served = await serve({
    container,
    routes,
    ...(options.resolver !== undefined && { resolver: options.resolver }),
  });
  return {
    app: served.app,
    container,
    directory,
    close: () => served.close(),
  };
}

// ---- requests -------------------------------------------------------------

export type Method = 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';

export function call(
  booted: Booted,
  method: Method,
  url: string,
  account: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return booted.app.inject({
    method,
    url,
    headers: asAccount(account),
    ...(payload !== undefined && { payload: payload as object }),
  });
}

export const bodyOf = <T>(res: LightMyRequestResponse): T => JSON.parse(res.body) as T;

export const errorCodeOf = (res: LightMyRequestResponse): string =>
  (JSON.parse(res.body) as { error: { code: string } }).error.code;

// ---- request fixtures -----------------------------------------------------

export interface DealBody {
  path: string;
  budget: number;
  walk_away_number: number;
  target_vehicle: { make: string; model: string; year_range?: { from: number; to: number } };
}

export const dealBody = (over: Partial<DealBody> = {}): DealBody => ({
  path: 'hybrid',
  budget: 3_200_000,
  walk_away_number: 3_000_000,
  target_vehicle: { make: 'Honda', model: 'Accord', year_range: { from: 2019, to: 2023 } },
  ...over,
});

export const NORTHSIDE: DealershipNaturalKey = {
  name: 'Northside Motors',
  state: 'NC',
  city: 'Raleigh',
  zip_code: '27601',
};

export const SOUTHSIDE: DealershipNaturalKey = {
  name: 'Southside Auto',
  state: 'NC',
  city: 'Durham',
  zip_code: '27701',
};

export const idFor = (key: DealershipNaturalKey): string => dealershipId(key);

export const vehicleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  make: 'Honda',
  model: 'Accord',
  vin: '1HGCV1F34LA012345',
  year: 2021,
  condition: 'used',
  ...over,
});

// ---- composite setup ------------------------------------------------------

/** Creates the GLOBAL dealership through its own route and returns its id. */
export async function createDealership(
  booted: Booted,
  account: string,
  key: DealershipNaturalKey,
): Promise<string> {
  const res = await call(booted, 'POST', '/dealerships', account, key);
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`dealership create failed: ${String(res.statusCode)} ${res.body}`);
  }
  return bodyOf<{ id: string }>(res).id;
}

export interface Scenario {
  readonly booted: Booted;
  readonly deal_id: string;
  readonly dealership_id: string;
}

/**
 * The common arrangement: one account, one draft deal anchored to a
 * Honda/Accord, one GLOBAL dealership, one thread bound to it.
 */
export async function scenario(
  booted: Booted,
  options: {
    readonly account?: string;
    readonly deal_id?: string;
    readonly deal?: Partial<DealBody>;
    readonly key?: DealershipNaturalKey;
  } = {},
): Promise<Scenario> {
  const account = options.account ?? ACCOUNT_A;
  const deal_id = options.deal_id ?? 'deal-1';
  const key = options.key ?? NORTHSIDE;

  const created = await call(booted, 'PUT', `/deals/${deal_id}`, account, dealBody(options.deal ?? {}));
  if (created.statusCode !== 201) throw new Error(`deal create failed: ${created.body}`);

  const dealership_id = await createDealership(booted, account, key);
  const thread = await call(booted, 'PUT', `/deals/${deal_id}/threads/${dealership_id}`, account, {});
  if (thread.statusCode !== 201) throw new Error(`thread create failed: ${thread.body}`);

  return { booted, deal_id, dealership_id };
}

// ---- direct store access (test-only) --------------------------------------

/**
 * A handle a test can hold.
 *
 * `DealHandle`'s brand is module-private, so this cast is the only way to build
 * one outside `auth/deal-gate.ts` — which is exactly the property T-019's
 * static suite asserts `src/**` never uses, and which this file, being a test,
 * is permitted to use to seed state no route can produce (there is deliberately
 * no `POST /offers` — design D14).
 */
export const handleFor = (deal_id: string, account_id: string): DealHandle =>
  ({
    deal_id,
    action: 'write',
    account: { scope: { account_id }, role: 'owner', source: 'test', request_id: 'r' },
    scope: { account_id },
  }) as unknown as DealHandle;

/** Runs `fn` against the container's real store through the only door there is. */
export async function withStore<T>(
  booted: Booted,
  deal_id: string,
  account_id: string,
  fn: (session: import('../../src/index.js').StoreSession) => T,
): Promise<T> {
  const result = await booted.container.sessions.withDeal(handleFor(deal_id, account_id), (session) =>
    Promise.resolve(fn(session)),
  );
  if (!result.ok) throw new Error(`store session failed: ${result.error.message}`);
  return result.value;
}
