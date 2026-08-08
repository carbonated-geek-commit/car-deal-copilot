/**
 * Every route this task registers survives T-019's boot audit
 * (docs/design/T-020.md §1.2, §5.8; AC-16).
 *
 * The audit is what makes AC-3/AC-5 keep holding after this task adds routes to
 * a service it does not own: a server whose deal-addressed route skipped the
 * gate does not start. So the assertion here is not "we remembered" — it is that
 * the real suite boots clean, that every `:deal_id` route carries BOTH marks,
 * and that the refusal still fires when a non-compliant route is registered
 * alongside this suite.
 */

import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  auditRoute,
  auditRouteTable,
  buildServer,
  chainHasMark,
  createPermissiveDealGate,
  createPocHeaderResolver,
  dealIdParam,
  validate,
} from '../../src/index.js';
import { createInMemoryDealershipDirectory, createRouteSuite } from '../../src/routes/index.js';
import { configFor, memoryContainer } from '../fixtures/harness.js';
import { boot, type Booted } from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

/**
 * Wraps each suite plugin so its route registrations are observable. Calling the
 * plugin directly means the routes land on THIS encapsulated instance, so the
 * `onRoute` hook below sees every one of them.
 */
function collectingSuite(): { readonly plugins: readonly FastifyPluginAsync[]; readonly routes: RouteOptions[] } {
  const routes: RouteOptions[] = [];
  const plugins = createRouteSuite({ directory: createInMemoryDealershipDirectory() }).map(
    (plugin): FastifyPluginAsync =>
      async (app: FastifyInstance): Promise<void> => {
        app.addHook('onRoute', (route: RouteOptions) => {
          routes.push(route);
        });
        await plugin(app, {});
      },
  );
  return { plugins, routes };
}

const methodsOf = (route: RouteOptions): readonly string[] =>
  (Array.isArray(route.method) ? route.method : [route.method]).map((m) => String(m).toUpperCase());

describe('the real suite boots clean', () => {
  it('produces an empty audit table', async () => {
    booted = await boot();
    expect(auditRouteTable(booted.app)).toEqual([]);
  });

  it('registers every route in the design’s inventory and nothing else', async () => {
    const { plugins, routes } = collectingSuite();
    const container = await memoryContainer();
    const built = await buildServer({
      container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate: createPermissiveDealGate(),
      routes: plugins,
      logger: false,
    });
    expect(built.ok).toBe(true);
    if (built.ok) await built.value.close();
    await container.close();

    const inventory = routes
      .flatMap((route) => methodsOf(route).map((method) => `${method} ${route.url}`))
      // Fastify auto-generates HEAD for every GET; it carries the same chain.
      .filter((line) => !line.startsWith('HEAD '))
      .sort();

    expect(inventory).toEqual(
      [
        'PUT /deals/:deal_id',
        'GET /deals/:deal_id',
        'PATCH /deals/:deal_id',
        'GET /deals/:deal_id/war-room',
        'GET /deals/:deal_id/receipt',
        'GET /deals/:deal_id/offers',
        'PUT /deals/:deal_id/target-vehicle',
        'PUT /deals/:deal_id/threads/:dealership_id',
        'GET /deals/:deal_id/threads/:dealership_id',
        'PATCH /deals/:deal_id/threads/:dealership_id',
        'PUT /deals/:deal_id/threads/:dealership_id/working-with',
        'PUT /deals/:deal_id/threads/:dealership_id/vehicle-instance',
        'POST /deals/:deal_id/threads/:dealership_id/messages',
        'GET /deals/:deal_id/threads/:dealership_id/messages',
        'GET /deals/:deal_id/threads/:dealership_id/current-offer',
        'POST /dealerships',
        'GET /dealerships',
        'GET /dealerships/:dealership_id',
      ].sort(),
    );
  });

  it('carries BOTH marks on every :deal_id route', async () => {
    const { plugins, routes } = collectingSuite();
    const container = await memoryContainer();
    const built = await buildServer({
      container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate: createPermissiveDealGate(),
      routes: plugins,
      logger: false,
    });
    if (built.ok) await built.value.close();
    await container.close();

    const deal_routes = routes.filter((route) => route.url.includes(':deal_id'));
    expect(deal_routes.length).toBeGreaterThan(10);
    for (const route of deal_routes) {
      expect(chainHasMark(route.preValidation, 'validation'), `validation on ${route.url}`).toBe(true);
      expect(chainHasMark(route.preHandler, 'deal-gate'), `gate on ${route.url}`).toBe(true);
      expect(
        auditRoute({
          method: route.method,
          url: route.url,
          ...(route.preHandler !== undefined && { preHandler: route.preHandler }),
          ...(route.preValidation !== undefined && { preValidation: route.preValidation }),
        }),
        route.url,
      ).toEqual([]);
    }
  });

  it('registers no DELETE and no mutation on an append-only path', async () => {
    const { plugins, routes } = collectingSuite();
    const container = await memoryContainer();
    const built = await buildServer({
      container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate: createPermissiveDealGate(),
      routes: plugins,
      logger: false,
    });
    if (built.ok) await built.value.close();
    await container.close();

    for (const route of routes) {
      for (const method of methodsOf(route)) {
        expect(method, `${method} ${route.url}`).not.toBe('DELETE');
        if (method === 'PUT' || method === 'PATCH') {
          for (const segment of ['/messages', '/receipt', '/notes']) {
            expect(route.url.includes(segment), `${method} ${route.url}`).toBe(false);
          }
        }
      }
    }
  });

  it('validates params before the gate reads :deal_id — a malformed id never reaches authorization', async () => {
    booted = await boot();
    const res = await booted.app.inject({
      method: 'GET',
      url: '/deals/%20%20/war-room',
      headers: { 'x-dc-account-id': 'account-a' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the refusal still fires with this suite loaded', () => {
  const container = memoryContainer();

  it('refuses to start when a gate-less :deal_id route is registered alongside the suite', async () => {
    const bad: FastifyPluginAsync = (app: FastifyInstance): Promise<void> => {
      app.get('/deals/:deal_id/rogue', { preValidation: validate({ params: dealIdParam }) }, () =>
        Promise.resolve({ ok: true }),
      );
      return Promise.resolve();
    };

    const built = await buildServer({
      container: await container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate: createPermissiveDealGate(),
      routes: [...createRouteSuite({ directory: createInMemoryDealershipDirectory() }), bad],
      logger: false,
    });

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.message).toContain('deal_route_without_gate');
  });

  it('refuses a DELETE registered alongside the suite', async () => {
    const bad: FastifyPluginAsync = (app: FastifyInstance): Promise<void> => {
      app.delete('/dealerships/:dealership_id', () => Promise.resolve({ ok: true }));
      return Promise.resolve();
    };

    const built = await buildServer({
      container: await container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate: createPermissiveDealGate(),
      routes: [...createRouteSuite({ directory: createInMemoryDealershipDirectory() }), bad],
      logger: false,
    });

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.message).toContain('mutation_on_append_only_path');
  });

  it('closes the shared container', async () => {
    await (await container).close();
  });
});
