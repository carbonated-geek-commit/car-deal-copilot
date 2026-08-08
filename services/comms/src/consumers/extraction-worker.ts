/**
 * C4 — extraction-worker (design T-009 §4.2).
 *
 * THE ONLY MODULE IN THIS SERVICE THAT IMPORTS `@offer-extraction` (§1
 * binding placement rule; §8 invariant — a verifier grep for the alias
 * outside this file is a finding). Extraction runs ONLY as a bus consumer,
 * never inline in the webhook path (specs/00; T-007 §5.2 seam rule).
 *
 * `extractOffer` is pure, total, deterministic (T-007): `{ found: false }`
 * is a valid terminal outcome (the text contained no offer) and the
 * completed event simply omits `offer` (core contract). A THROW is a T-007
 * D4 contract violation → `poison`, immediate DLQ with envelope intact —
 * never silent.
 */

import type { EventEnvelope, OfferExtractionCompletedV1 } from '@core';
import { extractOffer, type ExtractionResult } from '@offer-extraction';
import type { CommsStore, ConsumeResult, EventHandler, EventQueue } from '../ports.js';
import type { EventSeams } from '../envelope.js';

export const EXTRACTION_WORKER = 'extraction-worker';

export interface ExtractionWorkerDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
}

export function createExtractionWorker(deps: ExtractionWorkerDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'offer.extraction.requested.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    if (deps.store.hasProcessed(EXTRACTION_WORKER, event.idempotency_key)) {
      return { status: 'done' };
    }

    const { deal_id, dealership_id, message_ref, channel, text } = event.payload;

    let result: ExtractionResult;
    try {
      result = extractOffer({ channel, text });
    } catch (err) {
      return {
        status: 'poison',
        reason: 'extractOffer_threw:' + (err instanceof Error ? err.message : 'unknown'),
      };
    }

    const completed: EventEnvelope<'offer.extraction.completed.v1', OfferExtractionCompletedV1> = {
      event_id: deps.new_event_id(),
      type: 'offer.extraction.completed.v1',
      occurred_at: deps.now(),
      deal_id,
      idempotency_key: `${deal_id}:${message_ref}:extraction-complete`,
      payload: {
        deal_id,
        dealership_id,
        message_ref,
        // Absent when no offer was found — a valid, terminal outcome (AC/core).
        ...(result.found ? { offer: result.offer } : {}),
      },
    };
    const published = await deps.queue.publish(completed);
    if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

    deps.store.markProcessed(EXTRACTION_WORKER, event.idempotency_key);
    return { status: 'done' };
  };
}
