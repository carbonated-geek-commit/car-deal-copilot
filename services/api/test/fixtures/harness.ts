/**
 * Shared test harness for `services/api` (docs/design/T-019.md §6).
 *
 * NOT a test file (vitest collects `*.test.ts` only). Everything here is
 * offline: the ADR-008 default posture is composed with zero external
 * services, which is the property under test rather than a convenience.
 *
 * Route fixtures live here rather than in `test/routes/**` — that subtree
 * belongs to T-020 and this task must not create it.
 */

import type { Deal, DealerThread, Dealership, DealershipContact, Message, Offer } from '@core';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  buildServer,
  createContainer,
  createPermissiveDealGate,
  createPocHeaderResolver,
  readApiConfig,
  resolveStoragePlan,
  type AccountContextResolver,
  type ApiConfig,
  type AppContainer,
  type DealAccessGate,
  type StoragePlan,
} from '../../src/index.js';

// ---- configuration -------------------------------------------------------

export function configFor(env: Readonly<Record<string, string | undefined>> = {}): ApiConfig {
  const result = readApiConfig(env);
  if (!result.ok) throw new Error(`config unexpectedly invalid: ${result.error.message}`);
  return result.value;
}

export function planFor(config: ApiConfig): StoragePlan {
  const result = resolveStoragePlan(config);
  if (!result.ok) throw new Error(`plan unexpectedly invalid: ${result.error.message}`);
  return result.value;
}

/** The ADR-008 default: no `DATABASE_URL`, no object-store config, no I/O. */
export async function memoryContainer(): Promise<AppContainer> {
  const config = configFor();
  const result = await createContainer({ config, plan: planFor(config) });
  if (!result.ok) throw new Error(`container did not build: ${result.error.message}`);
  return result.value;
}

// ---- server --------------------------------------------------------------

export interface ServeOptions {
  readonly routes?: readonly FastifyPluginAsync[];
  readonly resolver?: AccountContextResolver;
  readonly gate?: DealAccessGate;
  readonly config?: ApiConfig;
  readonly container?: AppContainer;
}

export interface Served {
  readonly app: FastifyInstance;
  readonly container: AppContainer;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions = {}): Promise<Served> {
  const config = options.config ?? configFor();
  const container = options.container ?? (await memoryContainer());
  const result = await buildServer({
    container,
    config,
    resolver: options.resolver ?? createPocHeaderResolver(),
    gate: options.gate ?? createPermissiveDealGate(),
    ...(options.routes !== undefined && { routes: options.routes }),
    logger: false,
  });
  if (!result.ok) throw new Error(`server did not build: ${result.error.message}`);
  const app = result.value;
  return {
    app,
    container,
    close: async (): Promise<void> => {
      await app.close();
      await container.close();
    },
  };
}

export const ACCOUNT_HEADER_NAME = 'x-dc-account-id';

export const asAccount = (account_id: string): Record<string, string> => ({
  [ACCOUNT_HEADER_NAME]: account_id,
});

// ---- spine fixtures ------------------------------------------------------

export const T0 = '2026-08-07T12:00:00.000Z';

export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return { fees: [], flags: [], ...overrides };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return { channel: 'sms', direction: 'in', author: 'dealer', body: 'hello', timestamp: T0, ...overrides };
}

export function makeContact(overrides: Partial<DealershipContact> = {}): DealershipContact {
  return { name: 'Dana Reyes', role: 'sales_agent', phone: '+15550001111', ...overrides };
}

export function makeThread(overrides: Partial<DealerThread> = {}): DealerThread {
  return {
    dealership_id: 'dealership-1',
    process_step: 'information_gather',
    messages: [makeMessage()],
    ...overrides,
  };
}

export function makeDealership(overrides: Partial<Dealership> = {}): Dealership {
  return { id: 'dealership-1', name: 'Northside Motors', state: 'NC', city: 'Raleigh', zip_code: '27601', ...overrides };
}

export function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'deal-1',
    owner_id: 'account-a',
    path: 'hybrid',
    status: 'active',
    target_vehicle: { make: 'Toyota', model: 'RAV4' },
    budget: 3_500_000,
    walk_away_number: 3_200_000,
    dealer_threads: [makeThread()],
    offers: [],
    created_at: T0,
    ...overrides,
  };
}
