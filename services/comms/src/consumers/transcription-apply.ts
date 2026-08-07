/**
 * C3 — transcription-apply (design T-009 §4.2).
 *
 * Consumes `comms.transcription.completed.v1`: fill-once `setTranscript` on
 * the stored call Message via the D3 correlation index, then hands the
 * transcript to extraction by publishing `offer.extraction.requested.v1`
 * with `text = transcript`.
 *
 * §5.3: `not_found` → retry (out-of-order/redelivery artifact — the append
 * is upstream in the causal chain); `already_set` → done (idempotent
 * duplicate — the run that set it owned the follow-up publish).
 */

import type { EventEnvelope, OfferExtractionRequestedV1 } from '@core';
import type { CommsStore, ConsumeResult, EventHandler, EventQueue } from '../ports.js';
import type { EventSeams } from '../envelope.js';

export const TRANSCRIPTION_APPLY = 'transcription-apply';

export interface TranscriptionApplyDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
}

export function createTranscriptionApply(deps: TranscriptionApplyDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'comms.transcription.completed.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    if (deps.store.hasProcessed(TRANSCRIPTION_APPLY, event.idempotency_key)) {
      return { status: 'done' };
    }

    const { deal_id, dealer_id, provider_message_ref, transcript } = event.payload;

    const result = deps.store.setTranscript(deal_id, provider_message_ref, transcript);
    if (result === 'not_found') {
      return { status: 'retry', reason: 'message_row_not_found' };
    }
    if (result === 'already_set') {
      return { status: 'done' }; // idempotent duplicate (§5.3)
    }

    const extractionRequested: EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1> = {
      event_id: deps.new_event_id(),
      type: 'offer.extraction.requested.v1',
      occurred_at: deps.now(),
      deal_id,
      idempotency_key: `${deal_id}:${provider_message_ref}:extraction-request`,
      payload: { deal_id, dealer_id, provider_message_ref, channel: 'call', text: transcript },
    };
    const published = await deps.queue.publish(extractionRequested);
    if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

    deps.store.markProcessed(TRANSCRIPTION_APPLY, event.idempotency_key);
    return { status: 'done' };
  };
}
