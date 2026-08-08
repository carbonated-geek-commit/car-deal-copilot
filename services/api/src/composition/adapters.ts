/**
 * The telephony/email adapter slots `createCommsService` requires
 * (docs/design/T-019.md §1.1).
 *
 * Real Twilio/SES translation is a LATER EPIC behind the same `@core`
 * contracts; this task composes whatever adapter it is handed. `ContainerDeps`
 * therefore takes both adapters as required injections, and the defaults below
 * exist only so the service can start with nothing wired — which is the
 * ADR-008 posture applied to providers as well as to storage.
 *
 * The refusal shape is chosen to preserve the no-drop rule rather than to be
 * tidy. `WebhookIntake` turns a parse failure into a QUARANTINED payload and
 * still acks `200` (`services/comms/src/intake.ts` §5.1 row 1), so an inbound
 * webhook that arrives before a provider is wired is held, operator-visible,
 * and replayable — not lost, and not 5xx'd into an infinite provider retry.
 */

import type { AdapterResult, EmailAdapter, InboundComms, ProviderSendReceipt, TelephonyAdapter } from '@core';

export const UNWIRED_TELEPHONY_SOURCE = 'unwired-telephony';
export const UNWIRED_EMAIL_SOURCE = 'unwired-email';

const parseRefusal = (source: string): AdapterResult<InboundComms> => ({
  ok: false,
  error: {
    code: 'malformed_response',
    retryable: false,
    source,
    // Log-safe by contract: names the wiring gap, never the payload.
    message: 'no provider adapter is wired for this channel; payload quarantined',
  },
});

const sendRefusal = (source: string): AdapterResult<ProviderSendReceipt> => ({
  ok: false,
  error: {
    code: 'auth',
    retryable: false,
    source,
    message: 'no provider adapter is wired for this channel',
  },
});

/**
 * Outbound is TYPE ONLY this epic (`services/comms/src/ports.ts`: "Nothing
 * implements or calls it; origination/relay is a later epic"), so `sendSms`
 * refusing is the honest answer rather than a gap.
 */
export function createUnwiredTelephonyAdapter(): TelephonyAdapter {
  return {
    source: UNWIRED_TELEPHONY_SOURCE,
    sendSms: () => Promise.resolve(sendRefusal(UNWIRED_TELEPHONY_SOURCE)),
    parseInboundWebhook: () => parseRefusal(UNWIRED_TELEPHONY_SOURCE),
  };
}

export function createUnwiredEmailAdapter(): EmailAdapter {
  return {
    source: UNWIRED_EMAIL_SOURCE,
    sendEmail: () => Promise.resolve(sendRefusal(UNWIRED_EMAIL_SOURCE)),
    parseInboundWebhook: () => parseRefusal(UNWIRED_EMAIL_SOURCE),
  };
}
