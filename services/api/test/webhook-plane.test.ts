/**
 * The webhook plane — ack immediately, enqueue, and reach nothing else
 * (docs/design/T-019.md §2.9, §5.9, D6, D12; AC-7).
 */

import { InMemoryQueue, InMemoryRawPayloadStore, createCommsService } from '@comms';
import type { CommsStore, WebhookIngestOutcome, WebhookIntake } from '@comms';
import type { AdapterResult, InboundComms, TelephonyAdapter } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createUnwiredEmailAdapter,
  createUnwiredTelephonyAdapter,
  webhookPlugin,
  type ApiErrorBody,
  type AppContainer,
  type WebhookPluginDeps,
} from '../src/index.js';
import { asAccount, memoryContainer, serve, type Served } from './fixtures/harness.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

/** Any store call at all is a failure: the ack path performs none. */
const throwingStore = (): { store: CommsStore; calls: string[] } => {
  const calls: string[] = [];
  const store = new Proxy(
    {},
    {
      get: (_target, property) => {
        return (...args: unknown[]) => {
          calls.push(String(property));
          throw new Error(`the webhook plane reached the store: ${String(property)}(${args.length} args)`);
        };
      },
    },
  ) as CommsStore;
  return { store, calls };
};

const parsingTelephony = (): TelephonyAdapter => ({
  source: 'fixture-telephony',
  sendSms: () => Promise.resolve({ ok: false, error: { code: 'auth', retryable: false, source: 'fixture-telephony', message: 'x' } }),
  parseInboundWebhook: (): AdapterResult<InboundComms> => ({
    ok: true,
    value: {
      channel: 'sms',
      to_identity: { phone_number: '+15559990000' },
      from: { phone: '+15550001111' },
      body: 'we can do 31k',
      provider_message_ref: 'sm-1',
      received_at: '2026-08-07T12:00:00.000Z',
    } satisfies InboundComms,
  }),
});

const withIntake = async (intake: WebhookIntake): Promise<Served> => {
  const base = await memoryContainer();
  const container: AppContainer = { ...base, comms: { ...base.comms, intake } };
  const s = await serve({ container });
  served = s;
  return s;
};

describe('a webhook is acked and enqueued, and nothing else happens on the request path', () => {
  it('acks 200 and quarantines when no provider adapter is wired', async () => {
    const spy = throwingStore();
    const queue = new InMemoryQueue();
    const comms = createCommsService({
      telephony: createUnwiredTelephonyAdapter(),
      email: createUnwiredEmailAdapter(),
      queue,
      store: spy.store,
      raw_payloads: new InMemoryRawPayloadStore(),
    });
    const s = await withIntake(comms.intake);

    for (const channel of ['telephony', 'email']) {
      const res = await s.app.inject({
        method: 'POST',
        url: `/webhooks/${channel}`,
        headers: { 'content-type': 'application/json' },
        payload: { From: '+15550001111', Body: 'we can do 31k' },
      });
      expect(res.statusCode, channel).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, disposition: 'quarantined' });
    }

    // The event is durably enqueued and NOT processed inline: extraction,
    // valuation and notification are the bus's job (specs/00).
    expect(spy.calls).toEqual([]);
    expect(queue.deadLetters).toEqual([]);
  });

  it('acks 200 with disposition `parsed` when an adapter understands the payload', async () => {
    const spy = throwingStore();
    const comms = createCommsService({
      telephony: parsingTelephony(),
      email: createUnwiredEmailAdapter(),
      queue: new InMemoryQueue(),
      store: spy.store,
      raw_payloads: new InMemoryRawPayloadStore(),
    });
    const s = await withIntake(comms.intake);
    const res = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: { anything: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, disposition: 'parsed' });
    expect(spy.calls).toEqual([]);
  });

  it('needs no account context — the plane has none to give (§2.9)', async () => {
    const s = await withIntake({
      ingest: (): Promise<WebhookIngestOutcome> =>
        Promise.resolve({ kind: 'enqueued', http_status: 200, disposition: 'parsed' }),
    });
    const anonymous = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(anonymous.statusCode).toBe(200);
    // And an asserted identity buys nothing here either.
    const asserted = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json', ...asAccount('account-a') },
      payload: {},
    });
    expect(asserted.statusCode).toBe(200);
    // The api scope's decorator never leaks out of its own encapsulation.
    expect(s.app.api_scope).toBeUndefined();
  });

  it('takes the status VERBATIM from the outcome — 503 on an enqueue failure, retryable', async () => {
    const s = await withIntake({
      ingest: (): Promise<WebhookIngestOutcome> => Promise.resolve({ kind: 'enqueue_failed', http_status: 503 }),
    });
    const res = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: { From: '+1555' },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as ApiErrorBody;
    expect(body.error.code).toBe('unavailable');
    expect(body.error.retryable).toBe(true);
    // The provider's retry is the durability mechanism — the payload is never echoed.
    expect(res.body).not.toContain('+1555');
  });

  it('reports an enqueue failure through the REAL intake too', async () => {
    const queue = new InMemoryQueue();
    queue.failNextPublishes(1);
    const comms = createCommsService({
      telephony: parsingTelephony(),
      email: createUnwiredEmailAdapter(),
      queue,
      store: throwingStore().store,
      raw_payloads: new InMemoryRawPayloadStore(),
    });
    const s = await withIntake(comms.intake);
    const res = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect((JSON.parse(res.body) as ApiErrorBody).error.retryable).toBe(true);
  });

  it('answers only POST — a GET on a webhook url is the envelope’s 404', async () => {
    const s = await withIntake({
      ingest: (): Promise<WebhookIngestOutcome> =>
        Promise.resolve({ kind: 'enqueued', http_status: 200, disposition: 'parsed' }),
    });
    const res = await s.app.inject({ method: 'GET', url: '/webhooks/telephony' });
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.body) as ApiErrorBody).error.code).toBe('not_found');
  });
});

describe('the plane is storeless by construction, not by discipline', () => {
  it('takes an intake and nothing else', () => {
    const deps: WebhookPluginDeps = {
      intake: {
        ingest: (): Promise<WebhookIngestOutcome> =>
          Promise.resolve({ kind: 'enqueued', http_status: 200, disposition: 'parsed' }),
      },
    };
    expect(Object.keys(deps)).toEqual(['intake']);
    // No container, no session factory, no gate, no resolver is accepted.
    expect(typeof webhookPlugin(deps)).toBe('function');
  });
});
