/**
 * In-memory event queue — a faithful at-least-once simulator, not a toy
 * (design T-009 §3.1, D11). Seam: managed queue (SQS/SNS or equivalent),
 * specs/00 "Async backbone" — the swap is wiring, not redesign, because
 * downstream code is designed against the same behavior now:
 *
 *   - at-least-once, per-(consumer, type) delivery with bounded redelivery
 *     (`maxAttempts`, default 3);
 *   - an inspectable dead-letter list with envelopes intact (T-001 §5.3:
 *     never silently dropped);
 *   - a test hook to fail the next N publishes — the only way to exercise
 *     the T-001 §5.2 enqueue-failure 503 row deterministically;
 *   - `drain()` delivers until quiescent, including events published by
 *     handlers mid-drain.
 *
 * Payloads on the wire are exactly `@core` SpineEvent envelopes —
 * JSON-serializable by the T-001 smoke contract (AC-5). Events are cloned at
 * publish so no handler can mutate another consumer's delivery (serialization
 * boundary fidelity).
 */

import type { SpineEvent, SpineEventType } from '@core';
import type { DeadLetter, EnqueueResult, EventHandler, EventQueue } from '../ports.js';

interface Subscription {
  consumer: string;
  type: SpineEventType;
  handler: EventHandler;
}

interface Delivery {
  event: SpineEvent;
  consumer: string;
  handler: EventHandler;
  attempts: number;
}

export class InMemoryQueue implements EventQueue {
  private readonly maxAttempts: number;
  private readonly subscriptions: Subscription[] = [];
  private readonly pending: Delivery[] = [];
  private readonly dead: DeadLetter[] = [];
  private failPublishes = 0;

  constructor(opts: { maxAttempts?: number } = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /** Never throws — failure is a value (§3.1). */
  async publish(event: SpineEvent): Promise<EnqueueResult> {
    if (this.failPublishes > 0) {
      this.failPublishes -= 1;
      return { ok: false, reason: 'induced_publish_failure' };
    }
    for (const sub of this.subscriptions) {
      if (sub.type === event.type) {
        // Clone per subscription: each consumer gets its own envelope copy,
        // as it would across a real serialization boundary.
        this.pending.push({
          event: structuredClone(event),
          consumer: sub.consumer,
          handler: sub.handler,
          attempts: 0,
        });
      }
    }
    // Zero subscribers is still a durable enqueue (e.g. alert.dispatch has no
    // consumer in this service — dispatch is a later epic).
    return { ok: true };
  }

  subscribe(consumer_name: string, type: SpineEventType, handler: EventHandler): void {
    this.subscriptions.push({ consumer: consumer_name, type, handler });
  }

  /** Deliver until quiescent — including events published by handlers mid-drain. */
  async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const delivery = this.pending.shift();
      if (delivery === undefined) break;
      delivery.attempts += 1;
      let verdict;
      try {
        verdict = await delivery.handler(delivery.event);
      } catch (err) {
        // Handlers classify their own poison (e.g. C4); an uncaught throw at
        // this level is treated as transient (§5.3 store-unavailable class).
        verdict = {
          status: 'retry' as const,
          reason: err instanceof Error ? err.message : 'handler_threw',
        };
      }
      if (verdict.status === 'done') continue;
      if (verdict.status === 'poison' || delivery.attempts >= this.maxAttempts) {
        this.dead.push({
          event: delivery.event, // envelope intact (T-001 §5.3)
          consumer: delivery.consumer,
          attempts: delivery.attempts,
          last_reason: verdict.reason,
        });
        continue;
      }
      // Redeliver at the back of the line — unordered-delivery discipline.
      this.pending.push(delivery);
    }
  }

  get deadLetters(): readonly DeadLetter[] {
    return this.dead;
  }

  /** Test hook: make the next n publish() calls return { ok: false } (§5.2 row 3). */
  failNextPublishes(n: number): void {
    this.failPublishes = n;
  }
}
