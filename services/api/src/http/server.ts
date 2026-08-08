/**
 * Server assembly (docs/design/T-019.md §2.10, §4.2, D4).
 *
 * ## The per-request pipeline, and why the ORDER is the contract (§4.2)
 *
 *   1. assign `request_id`                       `genReqId`
 *   2. body limit + content type                 Fastify core → 413/415 THROUGH the envelope
 *   3. resolve account context                   `onRequest`     → 401
 *   4. validate params → query → body            `preValidation` → 400 + details[]
 *   5. deal authorization gate                   `preHandler`    → 404 / 403
 *   6. handler — the only place a session opens
 *   7. projection + forbidden-field + no-null    `preSerialization`
 *   8. error / not-found                         the envelope, always
 *
 * Ordering 3 before 4 is a SECURITY property, not a preference: an
 * unauthenticated caller gets `401` and learns nothing about the schema — no
 * field names, no enum members. Ordering 4 before 5 is what makes "validation
 * runs before any repository call" true even for the gate, which reads
 * `:deal_id` out of the params.
 *
 * ## D4 — one envelope means ONE envelope
 *
 * The realistic failure mode is not an endpoint inventing a shape. It is the
 * FRAMEWORK emitting `{statusCode, error, message}` for a route that was never
 * reached: an oversized body, an unsupported content type, an unmatched URL.
 * That body is a second error contract and it leaks the framework. So
 * `setErrorHandler` and `setNotFoundHandler` are both replaced, and a
 * `preSerialization` guard is the last line: any non-2xx payload that is not an
 * `ApiErrorBody` is REPLACED, not passed through.
 *
 * ## Encapsulation is the security boundary, not a folder convention
 *
 * Three scopes are registered, and what is absent from each is the point:
 *   - health  — no account context, no gate, no store
 *   - webhook — no account context, no gate, therefore no `DealHandle`,
 *               therefore no store (§2.9)
 *   - api     — the account-context hook lives HERE and only here; T-020's
 *               route plugins are registered inside it, and the boot audit
 *               still applies to every route they add.
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

import type { AppContainer } from '../composition/container.js';
import type { ApiConfig } from '../config/env.js';
import { accountContext, type AccountContextResolver } from '../context/account-context.js';
import type { DealAccessGate } from '../auth/deal-gate.js';
import {
  ApiErrorException,
  apiError,
  fail,
  isApiErrorBody,
  ok,
  statusFor,
  toEnvelope,
  type ApiError,
  type ApiResult,
} from '../errors/envelope.js';
import { MESSAGE_BY_CODE, fromFrameworkError } from '../errors/mapping.js';
import { assertResponseSafe } from '../projection/guards.js';
import { webhookPlugin } from '../webhooks/plugin.js';
import { RouteAuditError, auditRouteTable, installRouteAudit } from './audit.js';
import { healthPlugin } from './health.js';
import { REDACTED_LOG_PATHS, logSerializers, type ApiLogger } from './request-log.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface ServerOptions {
  readonly container: AppContainer;
  readonly resolver: AccountContextResolver;
  readonly gate: DealAccessGate;
  readonly config: ApiConfig;
  /** T-020 registers its route plugins through here; the boot audit still applies to them. */
  readonly routes?: readonly FastifyPluginAsync[];
  /** Deterministic seam — tests inject a counter so `request_id` is reproducible. */
  readonly gen_request_id?: () => string;
  /** Escape hatch for tests: `false` silences Fastify's bundled logger entirely. */
  readonly logger?: FastifyServerOptions['logger'];
  readonly log?: ApiLogger;
}

/**
 * What T-020's route plugins read to reach the spine. Decorated on the API
 * scope only — the health and webhook scopes never see it, so a handler on
 * those planes cannot reach the store even by asking the instance for it.
 */
export interface ApiScope {
  readonly container: AppContainer;
  readonly gate: DealAccessGate;
  readonly config: ApiConfig;
}

export async function buildServer(options: ServerOptions): Promise<ApiResult<FastifyInstance>> {
  const { config, container, gate, resolver } = options;

  const server_options: FastifyServerOptions = {
    bodyLimit: config.body_limit_bytes,
    // Fastify's default id is a per-process counter, which collides across
    // replicas in a log aggregator. An injectable generator also makes tests
    // deterministic without freezing anything global.
    ...(options.gen_request_id !== undefined && { genReqId: options.gen_request_id }),
    logger: options.logger ?? {
      level: config.log_level,
      redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
      serializers: logSerializers,
    },
  };
  const app = Fastify(server_options);

  installRouteAudit(app);

  // ---- the single render site for every failure (D4) ---------------------
  app.setErrorHandler((error: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const api = error instanceof ApiErrorException ? error.api_error : fromFrameworkError(error);
    logApiError(req, api);
    void reply
      .code(statusFor(api))
      .type(JSON_CONTENT_TYPE)
      .send(toEnvelope(api, String(req.id)));
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const api = apiError('not_found', MESSAGE_BY_CODE.not_found);
    void reply.code(statusFor(api)).type(JSON_CONTENT_TYPE).send(toEnvelope(api, String(req.id)));
  });

  // ---- step 7: projection guards, and the envelope backstop --------------
  app.addHook('preSerialization', (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.statusCode >= 400) {
      // The backstop. A non-2xx body that is not an envelope is REPLACED
      // rather than thrown on: throwing here would re-enter the error handler
      // and re-enter this hook. Replacement terminates, and the anomaly is
      // still visible in the log.
      if (isApiErrorBody(payload)) return Promise.resolve(payload);
      req.log.error({ event: 'non_envelope_error_body', status: reply.statusCode });
      return Promise.resolve(toEnvelope(apiError('internal', MESSAGE_BY_CODE.internal), String(req.id)));
    }
    // A leak is a defect, never a response (AC-9, AC-11, D9). This throws; the
    // error handler turns it into a bare `internal` and the finding stays in
    // the log where it belongs.
    assertResponseSafe(payload);
    return Promise.resolve(payload);
  });

  app.addHook('onSend', (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    void reply.header(REQUEST_ID_HEADER, String(req.id));
    return Promise.resolve(payload);
  });

  // D12 — JSON is the only accepted request content type. Fastify ships a
  // `text/plain` parser by default, which would let a provider POST a body
  // this service never agreed to parse; removing it makes "JSON only" true
  // rather than nearly true, and anything else now yields `415` through the
  // envelope. `@fastify/formbody` is a dependency edit (T-015-only, ADR-009),
  // so form-encoded bodies stay unsupported and §8.3 records that gap for the
  // epic that wires Twilio/SES.
  app.removeContentTypeParser('text/plain');

  try {
    // ---- three scopes; what is ABSENT from each is the point -------------
    await app.register(healthPlugin({ container, resolver }));
    await app.register(webhookPlugin({ intake: container.comms.intake }));

    const routes = options.routes ?? [];
    await app.register(async (scope: FastifyInstance): Promise<void> => {
      const api_scope: ApiScope = { container, gate, config };
      scope.decorate('api_scope', api_scope);
      // Step 3. Registered on the SCOPE, so the webhook and health planes
      // cannot acquire a context even by accident.
      scope.addHook('onRequest', accountContext(resolver));
      for (const plugin of routes) {
        await scope.register(plugin);
      }
    });

    await app.ready();

    // The boot audit is read HERE, not raised from its hook. `onRoute` runs
    // inside the plugin function avvio calls without a try/catch, so a throw
    // from it escapes synchronously for a non-async plugin and the boot promise
    // never settles (see http/audit.ts). Reading the recorded table after
    // `ready()` makes the abort a value for EVERY legal plugin style, and
    // reports every finding rather than only the first route that tripped.
    const findings = auditRouteTable(app);
    if (findings.length > 0) throw new RouteAuditError(findings);
  } catch (cause) {
    if (cause instanceof RouteAuditError) {
      options.log?.({
        level: 'fatal',
        event: 'route_audit_failed',
        message: cause.message,
        detail: { findings: cause.findings.length },
      });
      await app.close();
      return fail(apiError('internal', cause.message, { cause: cause.findings }));
    }
    await app.close();
    return fail(apiError('internal', 'server failed to start', { cause }));
  }

  return ok(app);
}

/**
 * Level by class: a `500` is our defect and carries the cause; a `4xx` is the
 * caller's and carries only the code. `cause` never reaches a response — it is
 * not read by `toEnvelope` — so this is the only place it is observable.
 */
function logApiError(req: FastifyRequest, error: ApiError): void {
  const base = { event: 'request_failed', code: error.code, retryable: error.retryable };
  if (statusFor(error) >= 500) {
    req.log.error({ ...base, cause: error.cause });
    return;
  }
  req.log.warn(base);
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Present ONLY inside the api scope. Absent on the health and webhook planes. */
    api_scope?: ApiScope;
  }
}
