/**
 * Logging — the allow list IS the specification (docs/design/T-019.md §4.5).
 *
 * **Logged:** `request_id`, method, ROUTE TEMPLATE (`/deals/:deal_id/…`, never
 * the raw URL), status, `account_id`, `deal_id`, `dealership_id`,
 * `message_ref`, error code, SQLSTATE class, constraint name, `duration_ms`,
 * storage plan, resolver source, raw-payload REF PREFIX (first 12 hex — enough
 * to correlate, not enough to address; T-018 §4.8).
 *
 * **Never logged, at any level:** request or response bodies · message or note
 * text · a rejected input value · `DATABASE_URL` or any part of it ·
 * object-store credentials or signatures · a raw webhook payload
 * (`services/comms/src/ports.ts`: "The payload NEVER rides the bus or the
 * logs") · `provider_token` · `qualified_apr` or any prequal amount · a
 * `DealershipContact` name, phone, or email · any header value.
 *
 * The raw URL is excluded deliberately and not out of tidiness: a query string
 * is caller-controlled content, and a path segment is a deal id that a log
 * aggregator will happily index and retain past the deal's own lifetime.
 *
 * Fastify's bundled logger is used through `app.log`. NO logging library is
 * added — that would be a dependency edit, which ADR-009 reserves for T-015.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiErrorCode } from '../errors/envelope.js';

export type ApiLogLevelName = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

/**
 * The structured events this service emits outside the per-request pair. The
 * `event` names are a closed set so a dashboard can be built on them rather
 * than on message text.
 */
export interface ApiLogEvent {
  readonly level: ApiLogLevelName;
  readonly event:
    | 'startup'
    | 'storage_plan'
    | 'auth_posture'
    | 'raw_payload_store_volatile'
    | 'db_preflight_failed'
    | 'route_audit_failed'
    | 'shutdown'
    | 'raw_payload_flush_incomplete';
  readonly message: string;
  readonly code?: ApiErrorCode;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export type ApiLogger = (event: ApiLogEvent) => void;

/**
 * Header values are redacted rather than omitted so their PRESENCE is still
 * visible for debugging. `x-dc-account-id` is on the list even though the
 * account id is logged separately as a field: the field is the resolver's
 * output, the header is unvalidated caller input, and only one of those should
 * be in a log.
 */
export const REDACTED_LOG_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-dc-account-id"]',
  'req.headers["x-api-key"]',
  'req.body',
  'res.body',
];

/**
 * Serializers replace Fastify's defaults, which log `req.url` and every header.
 * Replacing rather than filtering means a future Fastify default cannot
 * reintroduce a field this list never named.
 */
export const logSerializers = {
  req(request: FastifyRequest): Readonly<Record<string, unknown>> {
    return {
      request_id: String(request.id),
      method: request.method,
      // The TEMPLATE (`/deals/:deal_id`), which is a constant, not the URL,
      // which contains ids and a caller-controlled query string.
      route: request.routeOptions.url ?? 'unmatched',
    };
  },
  res(reply: FastifyReply): Readonly<Record<string, unknown>> {
    return { status: reply.statusCode };
  },
};
