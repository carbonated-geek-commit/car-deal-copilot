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
  it('throws out of register and records the finding on the instance', async () => {
    const app = Fastify({ logger: false });
    installRouteAudit(app);
    await expect(
      app.register(async (scope) => {
        scope.get('/deals/:deal_id', () => ({ ok: true }));
      }),
    ).rejects.toBeInstanceOf(RouteAuditError);
    expect(kinds(auditRouteTable(app))).toContain('deal_route_without_gate');
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
   * FINDING (T-019, http/audit.ts + http/server.ts).
   *
   * `installRouteAudit` throws out of the `onRoute` hook, and avvio calls a
   * plugin function WITHOUT a try/catch (`avvio/lib/plugin.js` `Plugin.exec`:
   * `const maybePromiseLike = func(this.server, ...)`). A `FastifyPluginAsync`
   * written as a NON-async function that returns a promise — which is exactly
   * how this service writes `healthPlugin`, `webhookPlugin`, and how a route
   * plugin may legally be written — therefore throws SYNCHRONOUSLY, escapes
   * avvio entirely as an uncaught exception, and the boot promise never
   * settles.
   *
   * Consequence: for that plugin style `buildServer` never resolves, so the
   * `RouteAuditError` branch (fatal `route_audit_failed` log + `fail(...)` so
   * `start.ts` can `abort()`) is unreachable, and `container.close()` never
   * runs. The server still never serves — but the designed abort (§4.1 "Route
   * audit finding ⇒ Abort … Logged fatal") does not happen, and the guarantee
   * must not depend on a route plugin's syntax, since T-020 owns those files.
   *
   * The fix is available without new dependencies: findings are already
   * recorded on the instance before the throw, so `buildServer` can inspect
   * `auditRouteTable(app)` after `ready()` instead of relying on propagation.
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
});
