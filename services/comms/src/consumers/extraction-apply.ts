/**
 * C5 — extraction-apply (design T-009 §4.2).
 *
 * Consumes `offer.extraction.completed.v1`:
 *   - no `offer` on the payload → done (thread unchanged — T-007 §5.2);
 *   - offer present → fill-once `attachExtractedOffer` (the extractor's
 *     VERBATIM per-message output, possibly partial per ADR-005), then
 *     `rollupCurrentOffer` (§6) keyed on the contributing Message.timestamp
 *     (read via the D3 correlation index — NOT processing order), then an
 *     `offer_received` alert.
 *
 * §5.3: `not_found` → retry (out-of-order artifact); `already_set` → done
 * (idempotent duplicate). Message.extracted_offer is never derived from the
 * rollup — only current_offer is composite (§6.5).
 */

import type { AlertDispatchRequestedV1, EventEnvelope } from '@core';
import type { CommsStore, ConsumeResult, EventHandler, EventQueue } from '../ports.js';
import type { EventSeams } from '../envelope.js';

export const EXTRACTION_APPLY = 'extraction-apply';

export interface ExtractionApplyDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
}

export function createExtractionApply(deps: ExtractionApplyDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'offer.extraction.completed.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    if (deps.store.hasProcessed(EXTRACTION_APPLY, event.idempotency_key)) {
      return { status: 'done' };
    }

    const { deal_id, dealership_id, message_ref, offer } = event.payload;

    if (offer === undefined) {
      // No offer in the text — valid terminal outcome; thread unchanged.
      deps.store.markProcessed(EXTRACTION_APPLY, event.idempotency_key);
      return { status: 'done' };
    }

    const attached = deps.store.attachExtractedOffer(deal_id, message_ref, offer);
    if (attached === 'not_found') {
      return { status: 'retry', reason: 'message_row_not_found' };
    }
    if (attached === 'already_set') {
      return { status: 'done' }; // idempotent duplicate (§5.3)
    }

    // Rollup contribution ordered by the contributing Message.timestamp
    // (§6.4) — read back through the correlation index (D3).
    const row = deps.store.getMessageByRef(deal_id, message_ref);
    if (row === undefined) {
      return { status: 'retry', reason: 'message_row_not_found' };
    }
    deps.store.rollupCurrentOffer(deal_id, dealership_id, {
      offer,
      at: row.message.timestamp,
      ref: message_ref,
    });

    const alert: EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1> = {
      event_id: deps.new_event_id(),
      type: 'alert.dispatch.requested.v1',
      occurred_at: deps.now(),
      deal_id,
      idempotency_key: `${deal_id}:offer_received:${message_ref}`,
      payload: {
        deal_id,
        kind: 'offer_received',
        summary: 'Offer terms extracted from a message on this thread', // PII-free
      },
    };
    const published = await deps.queue.publish(alert);
    if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

    deps.store.markProcessed(EXTRACTION_APPLY, event.idempotency_key);
    return { status: 'done' };
  };
}
