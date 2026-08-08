/**
 * Liveness and readiness (docs/design/T-019.md §3.3, D6).
 *
 * Neither endpoint has an account context and neither touches the store, which
 * is why they are foundation rather than `src/routes/**` (T-020's subtree).
 *
 * `/readyz` names MODES only — never a URL, host, bucket, credential, or
 * connection string. The two fields that look like noise are the point:
 * `raw_payload_durability: "volatile"` and `provider: "none"` are exactly the
 * two things an operator would otherwise assume were fine (D1, D7).
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { AppContainer } from '../composition/container.js';
import type { AccountContextResolver } from '../context/account-context.js';
import { describePlan } from '../config/storage.js';

export interface HealthPluginDeps {
  readonly container: AppContainer;
  readonly resolver: AccountContextResolver;
}

export interface ReadinessBody {
  readonly status: 'ready';
  readonly storage: Readonly<Record<string, string>>;
  readonly auth: { readonly resolver: string; readonly provider: 'none' };
}

export function healthPlugin(deps: HealthPluginDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    /**
     * Liveness. Touches NO dependency: a liveness probe that queries the
     * database restarts a healthy process during a database blip, which turns
     * one outage into two.
     */
    app.get('/healthz', () => ({ status: 'ok' }));

    /**
     * Readiness. The container exists, therefore the preflight passed and every
     * configured backend was reachable at startup — a configured-but-unreachable
     * `DATABASE_URL` aborts before `listen`, so there is no state in which this
     * process is serving and its database was never verified.
     *
     * AC-4 is visible here: `provider: 'none'` is a literal, not a variable.
     * There is no auth provider to report because none is selected or wired.
     */
    app.get('/readyz', (): ReadinessBody => ({
      status: 'ready',
      storage: describePlan(deps.container.plan),
      auth: { resolver: deps.resolver.source, provider: 'none' },
    }));

    return Promise.resolve();
  };
}
