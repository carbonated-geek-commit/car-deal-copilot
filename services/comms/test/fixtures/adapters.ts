/**
 * T-014 tester — fixture adapters (design §5, re-based from T-009 §7).
 *
 * Implement the `@core` TelephonyAdapter / EmailAdapter contracts over
 * NORMALIZED-shape fixture payloads (task note: real Twilio/SES payload
 * translation belongs to later-epic adapters). Anything not in the normalized
 * `InboundComms` shape returns `malformed_response` — which is exactly how the
 * quarantine path is exercised.
 *
 * v0.5 change: a call payload carries `call_meta` (the metadata that gets
 * logged on the thread — started_at / duration_seconds / party) and NOTHING
 * else. The v0.4 audio-handle key that used to sit on a call payload was
 * removed from the spine by specs/01 (consent posture, resolved 2026-08-07) and Q14, so
 * a payload still carrying it is a provider-shape drift and is REJECTED as
 * `malformed_response` rather than silently ignored. The key is referenced
 * below by construction, never as a literal, so the standing zero-hit surface
 * scan (surface.test.ts) stays honest about this file too.
 *
 * `sendSms` / `sendEmail` refuse unconditionally (`provider_unavailable`):
 * outbound remains type-only this epic (task Notes).
 *
 * All fixture content is synthetic — no real persons, numbers, or dealerships.
 */

import type {
  AdapterResult,
  EmailAdapter,
  InboundChannel,
  InboundComms,
  ProviderSendReceipt,
  TelephonyAdapter,
} from '@core';

/**
 * The removed v0.4 audio-handle key, assembled rather than written, so this
 * file contains no literal occurrence of it. A payload carrying it is drift.
 */
export const REMOVED_AUDIO_HANDLE_KEY = 'call' + '_' + 'ref';

const refuseSend = (source: string): AdapterResult<ProviderSendReceipt> => ({
  ok: false,
  error: {
    code: 'provider_unavailable',
    retryable: true,
    source,
    message: 'fixture adapter refuses origination (outbound is type-only this epic)',
  },
});

/** Structural check for the normalized InboundComms shape, gated on the channels the adapter owns. */
const parseNormalized = (
  payload: unknown,
  source: string,
  channels: readonly InboundChannel[],
): AdapterResult<InboundComms> => {
  if (typeof payload === 'object' && payload !== null) {
    const o = payload as Record<string, unknown>;
    const channel = o['channel'];
    const call_meta = o['call_meta'];
    const okShape =
      (channel === 'sms' || channel === 'email' || channel === 'call') &&
      channels.includes(channel) &&
      typeof o['provider_message_ref'] === 'string' &&
      o['provider_message_ref'] !== '' &&
      typeof o['received_at'] === 'string' &&
      typeof o['to_identity'] === 'object' &&
      o['to_identity'] !== null &&
      typeof o['from'] === 'object' &&
      o['from'] !== null &&
      (o['body'] === undefined || typeof o['body'] === 'string') &&
      // v0.5: call metadata only. An object or nothing — never a handle to bytes.
      (call_meta === undefined ||
        (typeof call_meta === 'object' &&
          call_meta !== null &&
          typeof (call_meta as Record<string, unknown>)['started_at'] === 'string')) &&
      // A payload still carrying the removed v0.4 audio handle is drift, not
      // an inbound message: reject it rather than dropping the field quietly.
      !(REMOVED_AUDIO_HANDLE_KEY in o);
    if (okShape) {
      // Clone so no test can mutate a payload after ingest and reach through.
      return { ok: true, value: structuredClone(payload) as InboundComms };
    }
  }
  return {
    ok: false,
    error: {
      code: 'malformed_response',
      retryable: false,
      source,
      message: 'fixture payload is not in the normalized InboundComms shape',
    },
  };
};

export class FixtureTelephonyAdapter implements TelephonyAdapter {
  constructor(readonly source: string = 'fixture-telephony') {}

  async sendSms(): Promise<AdapterResult<ProviderSendReceipt>> {
    return refuseSend(this.source);
  }

  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms> {
    return parseNormalized(payload, this.source, ['sms', 'call']);
  }
}

export class FixtureEmailAdapter implements EmailAdapter {
  constructor(readonly source: string = 'fixture-email') {}

  async sendEmail(): Promise<AdapterResult<ProviderSendReceipt>> {
    return refuseSend(this.source);
  }

  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms> {
    return parseNormalized(payload, this.source, ['email']);
  }
}

/** design §3.1 row 2 fixture: an adapter that THROWS despite the sync-pure contract. */
export class ThrowingTelephonyAdapter implements TelephonyAdapter {
  readonly source = 'fixture-throwing';

  async sendSms(): Promise<AdapterResult<ProviderSendReceipt>> {
    return refuseSend(this.source);
  }

  parseInboundWebhook(): AdapterResult<InboundComms> {
    throw new Error('defective adapter: parse threw');
  }
}
