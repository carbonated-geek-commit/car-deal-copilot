/**
 * T-009 tester — fixture adapters (design §7).
 *
 * Implement the `@core` TelephonyAdapter / EmailAdapter contracts over
 * NORMALIZED-shape fixture payloads (task note: real Twilio/SES payload
 * translation belongs to later-epic adapters). Anything not in the
 * normalized InboundComms shape returns `malformed_response` — which is
 * exactly how the quarantine path is exercised.
 *
 * `sendSms` / `sendEmail` refuse unconditionally (`provider_unavailable`):
 * nothing may originate in Epic 1 (design D10).
 *
 * All fixture content is synthetic — no real persons, numbers, or dealers
 * (T-007 D7 hygiene).
 */

import type {
  AdapterResult,
  EmailAdapter,
  InboundComms,
  MessageChannel,
  ProviderSendReceipt,
  TelephonyAdapter,
} from '@core';

const refuseSend = (source: string): AdapterResult<ProviderSendReceipt> => ({
  ok: false,
  error: {
    code: 'provider_unavailable',
    retryable: true,
    source,
    message: 'fixture adapter refuses origination (Epic 1 — design D10)',
  },
});

/** Structural check for the normalized InboundComms shape, gated on the channels the adapter owns. */
const parseNormalized = (
  payload: unknown,
  source: string,
  channels: readonly MessageChannel[],
): AdapterResult<InboundComms> => {
  if (typeof payload === 'object' && payload !== null) {
    const o = payload as Record<string, unknown>;
    const channel = o['channel'];
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
      (o['call_ref'] === undefined || typeof o['call_ref'] === 'string');
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

/** §5.1 row 4 fixture: an adapter that THROWS despite the sync-pure contract. */
export class ThrowingTelephonyAdapter implements TelephonyAdapter {
  readonly source = 'fixture-throwing';

  async sendSms(): Promise<AdapterResult<ProviderSendReceipt>> {
    return refuseSend(this.source);
  }

  parseInboundWebhook(): AdapterResult<InboundComms> {
    throw new Error('defective adapter: parse threw');
  }
}
