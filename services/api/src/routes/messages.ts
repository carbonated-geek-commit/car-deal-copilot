/**
 * Message routes (docs/design/T-020.md §3.1, D13; AC-7, AC-8).
 *
 * specs/01 W2 makes entry notes-first: "the buyer types what was said and the
 * extractor parses the offer out of it". `@comms`'s note intake already owns the
 * whole of that — it fixes `channel: note` and `direction: internal`, appends
 * durably BEFORE publishing, and puts the heavy half on
 * `offer.extraction.requested.v1`, the same event type, consumer, and extractor
 * entry point sms and email use. So this route delegates and maps; it decides
 * nothing about threading, extraction, or idempotency.
 *
 * `NoteSubmitOutcome` encodes its own HTTP status, and this handler honours it
 * VERBATIM — including `recorded_extraction_deferred`, which is a `503` whose
 * note is already durable: the caller retries the SAME `client_note_ref`, the
 * keyed append no-ops, and only the publish is re-attempted.
 *
 * D13 — `author` is REQUIRED from the caller AND checked against the session
 * role. Two rules meet here and requiring-plus-verifying is the only shape that
 * satisfies both: specs/00 says `author` is "never inferred" (so it may not be
 * defaulted), and `@comms/notes.ts` says it comes "from the authenticated
 * session on the write path, NEVER from a request body" (so it may not be taken
 * on trust). The caller STATES the author; the API REFUSES an authorship the
 * session cannot back. `403` is T-019's reserved code for a role denial inside
 * an account the caller does own, which is exactly this.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { NoteAuthor, NoteSubmitOutcome } from '@comms';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { requireAccountContext, type ActorRole } from '../context/account-context.js';
import { ApiErrorException, apiError } from '../errors/envelope.js';
import { MESSAGE_BY_CODE } from '../errors/mapping.js';
import { projectMessage } from '../projection/views.js';
import { dealThreadParams, paginationQuery, type DealThreadParams } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import {
  forbidden,
  notFound,
  requireOwnedDeal,
  requireThread,
  runtimeFor,
  type ResolvedRouteDeps,
} from './context.js';
import { messageBody, type MessageBody } from './schemas.js';
import type { MessagePageView, NoteAcceptedView } from './views.js';

const DEFAULT_PAGE = 50;

/** D13 — the one authorship an E2 session can back. `owner ⇒ buyer`. */
const authorForRole = (role: ActorRole): NoteAuthor => (role === 'concierge_agent' ? 'concierge' : 'buyer');

export function messageRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    app.post(
      '/deals/:deal_id/threads/:dealership_id/messages',
      {
        preValidation: validate({ params: dealThreadParams, body: messageBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest, reply: FastifyReply): Promise<NoteAcceptedView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const body = validated<MessageBody>(req, 'body');
        const role = requireAccountContext(req).role;

        if (body.author !== authorForRole(role)) {
          req.log.warn({
            event: 'author_not_permitted_for_role',
            deal_id: handle.deal_id,
            dealership_id,
            role,
          });
          throw forbidden();
        }

        // Tenancy first: `@comms`'s note intake reads its store by bare
        // `deal_id`, so ownership has to be established through the scoped read
        // model before it is called. A foreign deal answers `404`, the same as
        // an absent one (T-019 D3).
        const deal = await requireOwnedDeal(rt, handle);
        requireThread(deal, dealership_id);

        const outcome: NoteSubmitOutcome = await rt.container.comms.notes.submitNote({
          deal_id: handle.deal_id,
          dealership_id,
          client_note_ref: body.client_note_ref,
          // Caller-supplied, required, verified — never inferred (AC-8).
          author: body.author,
          body: body.body,
          ...(body.occurred_at !== undefined && { occurred_at: body.occurred_at }),
        });

        switch (outcome.kind) {
          case 'recorded':
            void reply.code(outcome.http_status);
            return { message_ref: outcome.message_ref, disposition: outcome.disposition };
          case 'recorded_extraction_deferred':
            // NOT a failure: the note IS durable. Surfaced as the retryable
            // `503` the outcome itself names, so the client re-sends the same
            // `client_note_ref` and only the publish is retried.
            req.log.warn({ event: 'extraction_deferred', deal_id: handle.deal_id, dealership_id });
            throw new ApiErrorException(
              apiError('unavailable', MESSAGE_BY_CODE.unavailable, { retryable: true }),
            );
          case 'rejected':
            req.log.info({ event: 'note_rejected', reason: outcome.reason });
            throw new ApiErrorException(apiError('invalid_request', MESSAGE_BY_CODE.invalid_request));
          case 'unknown_deal':
          case 'unknown_thread':
            throw notFound();
        }
      },
    );

    app.get(
      '/deals/:deal_id/threads/:dealership_id/messages',
      {
        preValidation: validate({ params: dealThreadParams, query: paginationQuery }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<MessagePageView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const query = validated<{ limit?: number; cursor?: string }>(req, 'query');
        const limit = query.limit ?? DEFAULT_PAGE;

        const deal = await requireOwnedDeal(rt, handle);
        const thread = requireThread(deal, dealership_id);

        // Chronological, as stored — the trail's own order. Nothing is
        // re-sorted here: an append-only sequence that a reader reorders is no
        // longer the sequence that was appended.
        const parsed = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
        const start = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
        const page = thread.messages.slice(start, start + limit);
        const next = thread.messages.length > start + limit ? String(start + limit) : undefined;

        return {
          dealership_id,
          messages: page.map(projectMessage),
          ...(next !== undefined && { next_cursor: next }),
        };
      },
    );

    return Promise.resolve();
  };
}
