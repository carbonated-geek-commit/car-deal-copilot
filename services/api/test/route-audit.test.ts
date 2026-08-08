/**
 * The boot-time route audit (docs/design/T-019.md §2.10, §5.8; AC-3, AC-5).
 *
 * The guarantee under test is not "T-020 will remember" — it is "a server whose
 * deal-addressed route skipped the gate does not start".
 */

import Fastify from 'fastify';
import type { FastifyPluginAsync } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  RouteAuditError,
  auditRoute,
  auditRouteTable,
  buildServer,
  createPermissiveDealGate,
  createPocHeaderResolver,
  dealGate,
  dealIdParam,
  installRouteAudit,
  markHook,
  validate,
  type ApiLogEvent,
  type RouteAuditFinding,
} from '../src/index.js';
import { configFor, memoryContainer } from './fixtures/harness.js';

const gate = createPermissiveDealGate();
const kinds = (findings: readonly RouteAuditFinding[]): string[] => findings.map((f) => f.kind);

describe('auditRoute — the rule set, without a server', () => {
  it('passes a fully wired deal route', () => {
    expect(
      auditRoute({
        method: 'GET',
        url: '/deals/:deal_id',
        preValidation: validate({ params: dealIdParam }),
        preHandler: dealGate(gate, 'read'),
      }),
    ).toEqual([]);
  });

  it('refuses a :deal_id route with no gate', () => {
    expect(
      kinds(auditRoute({ method: 'GET', url: '/deals/:deal_id', preValidation: validate({ params: dealIdParam }) })),
    ).toEqual(['deal_route_without_gate']);
  });

  it('refuses a :deal_id route with no validation', () => {
    expect(kinds(auditRoute({ method: 'GET', url: '/deals/:deal_id', preHandler: dealGate(gate, 'read') }))).toEqual([
      'deal_route_without_validation',
    ]);
  });

  it('refuses a :deal_id route with neither, and reports both findings', () => {
    expect(kinds(auditRoute({ method: 'GET', url: '/deals/:deal_id/messages' }))).toEqual([
      'deal_route_without_gate',
      'deal_route_without_validation',
    ]);
  });

  it('is not fooled by a similarly-shaped hook that was never marked', () => {
    const impostor = async (): Promise<void> => {};
    Object.defineProperty(impostor, 'name', { value: 'dealGate' });
    expect(
      kinds(
        auditRoute({
          method: 'GET',
          url: '/deals/:deal_id',
          preValidation: validate({ params: dealIdParam }),
          preHandler: impostor,
        }),
      ),
    ).toEqual(['deal_route_without_gate']);
  });

  it('accepts the marked hooks anywhere in a chain', () => {
    const other = markHook(async (): Promise<void> => {}, 'account-context');
    expect(
      auditRoute({
        method: ['GET', 'HEAD'],
        url: '/deals/:deal_id',
        preValidation: [other, validate({ params: dealIdParam })],
        preHandler: [other, dealGate(gate, 'read')],
      }),
    ).toEqual([]);
  });

  it('audits every method of a multi-method registration', () => {
    const findings = auditRoute({ method: ['GET', 'POST'], url: '/deals/:deal_id' });
    expect(findings).toHaveLength(4);
    expect(new Set(findings.map((f) => f.method))).toEqual(new Set(['GET', 'POST']));
  });

  it('refuses DELETE anywhere — the trail is append-only, and so is the surface', () => {
    for (const url of ['/deals/:deal_id/messages', '/dealerships/:dealership_id', '/anything']) {
      expect(kinds(auditRoute({ method: 'DELETE', url })), url).toContain('mutation_on_append_only_path');
    }
  });

  it('refuses PUT/PATCH on an append-only path and allows them elsewhere', () => {
    for (const method of ['PUT', 'PATCH'] as const) {
      for (const segment of ['/messages', '/receipt', '/notes']) {
        expect(
          kinds(
            auditRoute({
              method,
              url: `/deals/:deal_id${segment}`,
              preValidation: validate({ params: dealIdParam }),
              preHandler: dealGate(gate, 'write'),
            }),
          ),
          `${method} ${segment}`,
        ).toEqual(['mutation_on_append_only_path']);
      }
      expect(
        auditRoute({
          method,
          url: '/deals/:deal_id/step',
          preValidation: validate({ params: dealIdParam }),
          preHandler: dealGate(gate, 'write'),
        }),
      ).toEqual([]);
    }
  });

  it('reports the route TEMPLATE, never a concrete url', () => {
    const [finding] = auditRoute({ method: 'DELETE', url: '/deals/:deal_id' });
    expect(finding?.url).toBe('/deals/:deal_id');
  });
});

describe('installRouteAudit — registration time, not request time', () => {
  /**
   * The hook RECORDS and must never throw: `onRoute` runs inside the plugin
   * function avvio invokes without a try/catch, so a throw escapes
   * synchronously for a non-async plugin and the boot promise never settles.
   * `buildServer` reads the table after `ready()` instead — see the last case
   * in this file, which is the regression that forced the change.
   */
  it('records the finding on the instance without throwing out of register', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    await expect(
      app.register(async (scope) => {
        scope.get('/deals/:deal_id', () => ({ ok: true }));
      }),
    ).resolves.not.toThrow();
    expect(kinds(auditRouteTable(app))).toContain('deal_route_without_gate');
    await app.close();
  });

  /**
   * Recording rather than throwing also means the table no longer stops at the
   * first offending registration: Fastify auto-generates a HEAD route for every
   * GET, and that HEAD is just as unguarded, so both are now named.
   */
  it('records findings for a non-async plugin exactly as for an async one', async () => {
    const table = async (plugin: FastifyPluginAsync): Promise<string[]> => {
      const app = Fastify({ logger: false });
      installRouteAudit(app);
      await app.register(plugin);
      await app.ready();
      const rows = auditRouteTable(app).map((f) => `${f.method} ${f.kind}`);
      await app.close();
      return rows.sort();
    };

    const from_sync = await table((scope) => {
      scope.get('/deals/:deal_id/sync', () => ({ ok: true }));
      return Promise.resolve();
    });
    const from_async = await table(async (scope) => {
      scope.get('/deals/:deal_id/sync', () => ({ ok: true }));
    });

    expect(from_sync).toEqual(from_async);
    expect(from_sync).toEqual([
      'GET deal_route_without_gate',
      'GET deal_route_without_validation',
      'HEAD deal_route_without_gate',
      'HEAD deal_route_without_validation',
    ]);
  });

  it('accumulates every offending route, not only the first', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    await app.register(async (scope) => {
      scope.get('/deals/:deal_id/a', () => ({ ok: true }));
      scope.delete('/anything', () => ({ ok: true }));
    });
    await app.ready();
    expect(new Set(auditRouteTable(app).map((f) => f.url))).toEqual(new Set(['/deals/:deal_id/a', '/anything']));
    await app.close();
  });

  it('reports an empty table on a clean instance', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    app.get('/healthz', () => ({ status: 'ok' }));
    await app.ready();
    expect(auditRouteTable(app)).toEqual([]);
    await app.close();
  });

  it('names the kind, the method and the url in the error message', () => {
    const error = new RouteAuditError([{ kind: 'deal_route_without_gate', method: 'GET', url: '/deals/:deal_id' }]);
    expect(error.message).toContain('deal_route_without_gate');
    expect(error.message).toContain('GET /deals/:deal_id');
  });
});

describe('buildServer refuses to start on a finding', () => {
  const start = async (plugin: FastifyPluginAsync): Promise<{ ok: boolean; message: string }> => {
    const config = configFor();
    const container = await memoryContainer();
    const result = await buildServer({
      container,
      config,
      resolver: createPocHeaderResolver(),
      gate,
      routes: [plugin],
      logger: false,
    });
    if (result.ok) {
      await result.value.close();
      await container.close();
      return { ok: true, message: '' };
    }
    await container.close();
    return { ok: false, message: result.error.message };
  };

  it('refuses a gate-less :deal_id route added by a route plugin', async () => {
    const outcome = await start(async (app) => {
      app.get('/deals/:deal_id/notes', { preValidation: validate({ params: dealIdParam }) }, () => ({ ok: true }));
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('deal_route_without_gate');
  });

  it('refuses an unvalidated :deal_id route', async () => {
    const outcome = await start(async (app) => {
      app.get('/deals/:deal_id/x', { preHandler: dealGate(gate, 'read') }, () => ({ ok: true }));
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('deal_route_without_validation');
  });

  it('refuses a DELETE route', async () => {
    const outcome = await start(async (app) => {
      app.delete(
        '/deals/:deal_id',
        { preValidation: validate({ params: dealIdParam }), preHandler: dealGate(gate, 'write') },
        () => ({ ok: true }),
      );
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('mutation_on_append_only_path');
  });

  it('starts when every rule is honoured', async () => {
    const outcome = await start(async (app) => {
      app.get(
        '/deals/:deal_id/ok',
        { preValidation: validate({ params: dealIdParam }), preHandler: dealGate(gate, 'read') },
        () => ({ ok: true }),
      );
    });
    expect(outcome).toEqual({ ok: true, message: '' });
  });

  /**
   * REGRESSION (fixed: http/audit.ts records instead of throwing;
   * http/server.ts reads `auditRouteTable(app)` after `ready()`).
   *
   * avvio calls a plugin function WITHOUT a try/catch (`avvio/lib/plugin.js`
   * `Plugin.exec`: `const maybePromiseLike = func(this.server, ...)`). While
   * `installRouteAudit` threw out of its `onRoute` hook, a `FastifyPluginAsync`
   * written as a NON-async function returning a promise — exactly how this
   * service writes `healthPlugin` and `webhookPlugin`, and legal for any route
   * plugin T-020 writes — threw SYNCHRONOUSLY, escaped avvio as an uncaught
   * exception, and the boot promise NEVER SETTLED. The designed abort (§4.1
   * "Route audit finding ⇒ Abort … Logged fatal", `fail(...)` so `start.ts` can
   * `abort(1)`) was therefore dead code for that style and `container.close()`
   * never ran.
   *
   * The guarantee must not depend on the syntax of a plugin in a subtree T-019
   * does not own, which is precisely what the boot audit exists to make
   * syntax-independent. This case is the pin.
   */
  it('reports the finding as a value for EVERY legal plugin style, not only async ones', async () => {
    const settled = await Promise.race([
      start((app) => {
        app.get('/deals/:deal_id/sync', () => ({ ok: true }));
        return Promise.resolve();
      }).then((outcome) => outcome),
      new Promise<{ ok: boolean; message: string }>((resolve) =>
        setTimeout(() => resolve({ ok: true, message: 'buildServer never settled' }), 2_000),
      ),
    ]);
    expect(settled.ok, settled.message).toBe(false);
    expect(settled.message).toContain('deal_route_without_gate');
  });

  /** §4.1: the abort is LOGGED FATAL, and that must hold for the sync style too. */
  it('logs route_audit_failed at fatal before failing, for a non-async plugin', async () => {
    const events: ApiLogEvent[] = [];
    const container = await memoryContainer();
    const result = await buildServer({
      container,
      config: configFor(),
      resolver: createPocHeaderResolver(),
      gate,
      logger: false,
      log: (event) => events.push(event),
      routes: [
        (app): Promise<void> => {
          app.get('/deals/:deal_id/sync', () => ({ ok: true }));
          return Promise.resolve();
        },
      ],
    });
    expect(result.ok).toBe(false);
    const fatal = events.find((event) => event.event === 'route_audit_failed');
    expect(fatal?.level).toBe('fatal');
    // GET plus the HEAD Fastify generates for it, each missing gate and validation.
    expect(fatal?.detail).toEqual({ findings: 4 });
    await container.close();
  });
});
