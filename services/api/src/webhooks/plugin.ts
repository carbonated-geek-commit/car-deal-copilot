/**
 * The webhook plane — structurally storeless (docs/design/T-019.md §2.9, §5.9,
 * D6; AC-7).
 *
 * specs/00 "Comms aggregation layer": "webhooks ack immediately, all heavy work
 * (extraction, valuation refresh, notification) runs on the event bus. Provider
 * timeouts must never drop a dealer message."
 *
 * This plugin's only call is `intake.ingest`, which is a sync-pure adapter
 * parse plus a durable enqueue (`services/comms/src/intake.ts`). Nothing else
 * is reachable from here, and that is enforced by ENCAPSULATION rather than by
 * discipline: the plugin is registered in its own Fastify scope, the
 * account-context hook and the deal gate are NOT registered in that scope, so
 * no handler here can obtain an `AccountContext` or a `DealHandle` — and
 * `StoreSessionFactory.forDeal` takes a handle that cannot exist on this plane
 * (D2). Extraction, valuation, and notification are unreachable by
 * construction, not by convention.
 *
 * The status is `WebhookIngestOutcome.http_status` VERBATIM. The API adds no
 * status of its own and makes no ack decision: `200` means the envelope
 * (parsed OR quarantined) is durably enqueued and nothing more; `503` is the
 * ONE deliberate non-ack, after which the provider's retry IS the durability
 * mechanism. Parse failure is not representable as non-200, by construction.
 *
 * D12: JSON only. `@fastify/formbody` is a dependency edit (T-015-only,
 * ADR-009), so a form-encoded provider webhook currently receives `415` through
 * the envelope. The comms adapters in this epic are fixtures, so nothing
 * form-encoded exists to accept yet — recorded in §8.3 as a real gap for the
 * epic that wires Twilio/SES.
 */

import type { WebhookChannelKind, WebhookIntake } from '@comms';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { ApiErrorException, STATUS_BY_CODE, apiError } from '../errors/envelope.js';

export interface WebhookPluginDeps {
  /** `@comms`'s intake. It performs NO store reads/writes, NO routing, NO extraction. */
  readonly intake: WebhookIntake;
}

export interface WebhookAckBody {
  readonly ok: true;
  readonly disposition: 'parsed' | 'quarantined';
}

export function webhookPlugin(deps: WebhookPluginDeps): FastifyPluginAsync {
  const handler =
    (channel: WebhookChannelKind) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<WebhookAckBody> => {
      const outcome = await deps.intake.ingest(channel, req.body);

      if (outcome.kind === 'enqueue_failed') {
        req.log.error({ event: 'enqueue_failed', channel });
        // `WebhookIngestOutcome` already ENCODES the status (T-014 D1: "the
        // eventual HTTP shell maps it 1:1 and decides nothing"). The envelope
        // renders `unavailable` at 503, and this checks that the two still
        // agree rather than leaving "verbatim" as a coincidence a later edit
        // to `STATUS_BY_CODE` could quietly break.
        const code = STATUS_BY_CODE.unavailable === outcome.http_status ? 'unavailable' : 'internal';
        throw new ApiErrorException(
          apiError(code, 'event could not be durably enqueued', { retryable: code === 'unavailable' }),
        );
      }

      // A quarantined payload is still a 200: a 5xx makes the provider retry
      // the same unparseable payload forever, and giving up drops a dealer
      // message. Only the REF is logged — `services/comms/src/ports.ts`: "The
      // payload NEVER rides the bus or the logs."
      req.log.info({ event: 'webhook_ingested', channel, disposition: outcome.disposition });
      reply.code(outcome.http_status);
      return { ok: true, disposition: outcome.disposition };
    };

  return (app: FastifyInstance): Promise<void> => {
    app.post('/webhooks/telephony', handler('telephony'));
    app.post('/webhooks/email', handler('email'));
    return Promise.resolve();
  };
}
