/**
 * C2 — transcription-stub-worker (design T-009 §4.2, D9).
 *
 * Consumes `comms.transcription.requested.v1` and resolves the transcript
 * via the injected `TranscriptStub` (fixture-backed in tests). `undefined`
 * ⇒ transcript unavailable ⇒ `retry` (bounded → DLQ), exercising the poison
 * path. The real transcription integration is a later epic behind this same
 * seam.
 *
 * Audio is never fetched, stored, or referenced beyond the opaque
 * `call_ref` inside events (specs/01 transcribe-only posture; T-001 §7 —
 * transcription events carry call_ref + transcript, never audio bytes).
 */

import type { EventEnvelope, TranscriptionCompletedV1 } from '@core';
import type { ConsumeResult, EventHandler, EventQueue, CommsStore, TranscriptStub } from '../ports.js';
import type { EventSeams } from '../envelope.js';

export const TRANSCRIPTION_STUB_WORKER = 'transcription-stub-worker';

export interface TranscriptionStubWorkerDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
  transcribe: TranscriptStub;
}

export function createTranscriptionStubWorker(deps: TranscriptionStubWorkerDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'comms.transcription.requested.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    if (deps.store.hasProcessed(TRANSCRIPTION_STUB_WORKER, event.idempotency_key)) {
      return { status: 'done' };
    }

    const { deal_id, dealer_id, call_ref, provider_message_ref } = event.payload;

    const transcript = deps.transcribe.transcriptFor(call_ref);
    if (transcript === undefined) {
      // §5.3 C2: bounded retries → DLQ. The call Message is ALREADY threaded
      // (D7) — the dealer contact is never lost; the missing transcript is
      // operator-visible via the dead-letter list.
      return { status: 'retry', reason: 'transcript_unavailable' };
    }

    const completed: EventEnvelope<'comms.transcription.completed.v1', TranscriptionCompletedV1> = {
      event_id: deps.new_event_id(),
      type: 'comms.transcription.completed.v1',
      occurred_at: deps.now(),
      deal_id,
      idempotency_key: `${deal_id}:${provider_message_ref}:transcription-complete`,
      payload: { deal_id, dealer_id, provider_message_ref, transcript },
    };
    const published = await deps.queue.publish(completed);
    if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

    deps.store.markProcessed(TRANSCRIPTION_STUB_WORKER, event.idempotency_key);
    return { status: 'done' };
  };
}
