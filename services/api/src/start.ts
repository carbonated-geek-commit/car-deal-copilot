/**
 * The process entry point (docs/design/T-019.md §1.1, §4.1, §4.6).
 *
 * The ONLY file in the service that reads the real `process.env` and the only
 * one that calls `process.exit`. Everything below it takes configuration as a
 * parameter, which is what makes every startup branch testable without
 * mutating a global.
 *
 * Startup is a sequence of gates, and every one of them ABORTS rather than
 * degrades (ADR-008):
 *
 *   read config          → a malformed PORT/LOG_LEVEL is a refusal, not a default
 *   resolve storage plan → a PARTIAL object-store config is a refusal
 *   create container     → `DbHandle.ping()` must resolve ok when Postgres is
 *                          configured; there is no branch from that failure to
 *                          an in-memory store
 *   build server         → a route-audit finding is a refusal (§2.10)
 *   listen
 *
 * The process therefore either serves with the posture it reported, or it does
 * not serve. It never serves with a quieter one.
 */

import process from 'node:process';

import { createContainer, type AppContainer } from './composition/container.js';
import { readApiConfig } from './config/env.js';
import { resolveStoragePlan } from './config/storage.js';
import { createPermissiveDealGate } from './auth/deal-gate.js';
import { createPocHeaderResolver } from './context/account-context.js';
import type { ApiError } from './errors/envelope.js';
import { buildServer } from './http/server.js';
import type { ApiLogEvent, ApiLogger } from './http/request-log.js';

/**
 * Startup logging predates the server, so it cannot use `app.log`. This writes
 * one JSON object per line to stderr — no logging library is added, because
 * that would be a dependency edit (ADR-009 reserves those for T-015).
 */
const consoleLogger: ApiLogger = (event: ApiLogEvent): void => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
};

function abort(log: ApiLogger, message: string, error: ApiError): never {
  log({ level: 'fatal', event: 'startup', message, code: error.code, detail: { reason: error.message } });
  process.exit(1);
}

export async function main(log: ApiLogger = consoleLogger): Promise<void> {
  const config_result = readApiConfig(process.env);
  if (!config_result.ok) abort(log, 'configuration is invalid', config_result.error);
  const config = config_result.value;

  const plan_result = resolveStoragePlan(config);
  // The object store is PARTIALLY configured. Degrading here would accept an
  // artifact, return success, and lose it — healthy-looking data loss, which is
  // exactly what ADR-008's fail-fast rule exists to prevent.
  if (!plan_result.ok) abort(log, 'storage configuration is invalid', plan_result.error);
  const plan = plan_result.value;

  const container_result = await createContainer({ config, plan, log });
  if (!container_result.ok) abort(log, 'storage backends could not be composed', container_result.error);
  const container: AppContainer = container_result.value;

  const resolver = createPocHeaderResolver();

  // §8.7 — stated out loud, at `warn`, every boot. The failure mode this
  // guards against is an operator seeing a working account-scoped API and
  // concluding it is secured. It is not: the resolver trusts an unsigned
  // header, and the default bind is loopback for that reason.
  log({
    level: 'warn',
    event: 'auth_posture',
    message: 'no authentication provider is wired; account context comes from an unsigned request header',
    detail: { resolver: resolver.source, provider: 'none', host: config.host },
  });

  const server_result = await buildServer({
    container,
    resolver,
    gate: createPermissiveDealGate(),
    config,
    log,
  });
  if (!server_result.ok) {
    await container.close();
    abort(log, 'server could not be built', server_result.error);
  }
  const app = server_result.value;

  let shutting_down = false;
  const shutdown = (signal: string): void => {
    if (shutting_down) return;
    shutting_down = true;
    log({ level: 'info', event: 'shutdown', message: 'shutting down', detail: { signal } });
    void (async (): Promise<void> => {
      // §4.6 order: (1) stop accepting and drain in-flight, THEN (2) flush the
      // raw-payload write-behind window and (3) close the database handle —
      // both of which `container.close()` owns. Reversing (1) and (2) would
      // flush a backlog that is still growing.
      await app.close();
      await container.close();
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    // The cause is deliberately not logged: a listen failure carries the bind
    // address, and `EADDRINUSE` plus the port is the whole diagnosis anyway.
    await app.close();
    await container.close();
    log({ level: 'fatal', event: 'startup', message: 'could not listen', detail: { port: config.port } });
    process.exit(1);
  }

  log({
    level: 'info',
    event: 'startup',
    message: 'listening',
    detail: { host: config.host, port: config.port, relational: plan.relational, objects: plan.objects },
  });
}
