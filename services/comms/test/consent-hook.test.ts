/**
 * T-014 tester — the per-product hook gates nothing (AC-4; design D2, D3).
 *
 * specs/01 (consent posture, resolved 2026-08-07): "Legal
 * exposure from two-party-consent states is **avoided entirely** rather than
 * managed — there is nothing to consent to." The hook survives as a per-product
 * OBSERVATION seam, and the design proves it cannot be anything else in three
 * ways at once:
 *
 *   1. it returns `void`, so there is no channel through which to authorise or
 *      veto anything;
 *   2. it runs AFTER the call message is durably appended (D3), so even a hook
 *      that throws cannot cost a dealer record;
 *   3. it is invoked for calls only — sms, email and notes never reach it.
 *
 * A hook that tries to return a decision anyway is the interesting case: the
 * behavioral assertion below is that the returned value changes NOTHING.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { InboundComms } from '@core';
import type { ConsentHook } from '../src/index.js';
import { passThroughConsent } from '../src/index.js';
import {
  callPayload,
  DEALERSHIP_A,
  emailPayload,
  IDENTITY_A,
  makeHarness,
  onlyThread,
  seedDeal,
  smsPayload,
  T1,
} from './fixtures/harness.js';

describe('the inbound-call hook is an observation seam, not a gate (AC-4)', () => {
  it('is invoked exactly once per inbound call, with the resolved deal and the inbound item', async () => {
    const seen: Array<{ deal_id: string; inbound: InboundComms }> = [];
    const h = makeHarness({
      consent: { onInboundCall: (deal_id, inbound) => void seen.push({ deal_id, inbound }) },
    });
    seedDeal(h, 'deal-a', IDENTITY_A);

    const payload = callPayload({ ref: 'call-1', at: T1 });
    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.deal_id).toBe('deal-a');
    expect(seen[0]!.inbound).toStrictEqual(payload);
  });

  it('is NOT invoked for sms, email, or a note', async () => {
    const seen: string[] = [];
    const h = makeHarness({ consent: { onInboundCall: (deal_id) => void seen.push(deal_id) } });
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1' }));
    await h.service.intake.ingest('email', emailPayload({ ref: 'em-1' }));
    await h.queue.drain();
    await h.service.notes.submitNote({
      deal_id: 'deal-a',
      dealership_id: DEALERSHIP_A,
      client_note_ref: 'n-1',
      author: 'buyer',
      body: 'The price is $23,500 for this one.',
    });
    await h.queue.drain();

    expect(seen).toStrictEqual([]);
    expect(onlyThread(h).messages).toHaveLength(3);
  });

  it('runs AFTER the call is durably appended: the hook can already read the message (D3)', async () => {
    let messagesAtHookTime = -1;
    const h = makeHarness({
      consent: (store) => ({
        onInboundCall: (deal_id) => {
          messagesAtHookTime = store.getThread(deal_id, DEALERSHIP_A)?.messages.length ?? -1;
        },
      }),
    });
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    expect(messagesAtHookTime).toBe(1); // already durable when the hook fires
  });

  it('a hook that throws costs bounded retries and a dead letter — never the dealer record', async () => {
    const h = makeHarness({
      maxAttempts: 2,
      consent: {
        onInboundCall: () => {
          throw new Error('per-product hook is defective');
        },
      },
    });
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    // The call is threaded exactly once despite every attempt re-running the
    // handler: the append is keyed, so redelivery is a no-op.
    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.channel).toBe('call');

    // …and the defect is operator-visible with the envelope intact.
    const dead = h.queue.deadLetters;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.consumer).toBe('inbound-router');
    expect(dead[0]!.attempts).toBe(2);
    expect(dead[0]!.last_reason).toContain('consent_hook_threw:');
    expect(dead[0]!.event.type).toBe('comms.inbound.received.v1');
  });

  it('a hook that returns a would-be decision suppresses nothing — there is no gate to close', async () => {
    // The seam has no return channel by type. This case proves the BEHAVIOR
    // matches: even a hook smuggling a decision past the type system cannot
    // stop the message being threaded, extracted from, or alerted on.
    const smuggler = {
      onInboundCall: () => ({ capture: false, gate: 'deny' }),
    } as unknown as ConsentHook;
    const h = makeHarness({ consent: smuggler });
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.channel).toBe('call');
    expect(h.alerts.map((a) => a.kind)).toStrictEqual(['call_logged']);
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('the hook signature has no return channel and the default is inert', () => {
    expectTypeOf<ConsentHook['onInboundCall']>().returns.toBeVoid();
    expectTypeOf<ConsentHook>().toHaveProperty('onInboundCall');
    // One method, no others: nothing else to hang a policy decision off.
    expect(Object.keys(passThroughConsent)).toStrictEqual(['onInboundCall']);
    expect(passThroughConsent.onInboundCall('deal-a', callPayload({ ref: 'call-x' }))).toBeUndefined();
  });
});
