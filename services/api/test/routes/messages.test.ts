/**
 * Message routes — notes-first capture (docs/design/T-020.md §3.1, D13;
 * AC-7, AC-8; Q22).
 *
 * specs/01 "Consent & recording posture" (resolved 2026-08-07): the buyer TYPES
 * what the dealer said. There is no audio and no transcription anywhere in this
 * product, so the only capture surface is a note — and specs/00 requires that
 * note text be run through offer extraction exactly like an SMS or an email.
 *
 * D13 — `author` is required from the caller AND checked against the session
 * role. specs/00 says it is "never inferred" (so it may not be defaulted) and
 * `@comms/notes.ts` says it must come from the session (so it may not be taken
 * on trust). Requiring and verifying is the only shape that satisfies both.
 */

import { InMemoryQueue } from '@comms';
import type { Message, SpineEvent } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import { createFixedAccountResolver } from '../../src/index.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  bodyOf,
  boot,
  call,
  createDealership,
  dealBody,
  errorCodeOf,
  NORTHSIDE,
  scenario,
  type Booted,
  type Scenario,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const NOTE = {
  client_note_ref: 'ui-note-19',
  author: 'buyer',
  body: 'They said 28,900 plus a 1,995 doc fee at 72 months.',
};

const post = (
  s: Scenario,
  payload: Record<string, unknown>,
  account = ACCOUNT_A,
): Promise<import('fastify').LightMyRequestResponse> =>
  call(s.booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, account, payload);

const messagesOf = async (s: Scenario, account = ACCOUNT_A): Promise<readonly Message[]> => {
  const res = await call(s.booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, account);
  expect(res.statusCode).toBe(200);
  return bodyOf<{ messages: readonly Message[] }>(res).messages;
};

describe('a note is captured as channel=note / direction=internal (AC-7)', () => {
  it('accepts the note and returns @comms’s own outcome verbatim', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await post(s, NOTE);
    expect(res.statusCode).toBe(201);
    expect(bodyOf<{ message_ref: string; disposition: string }>(res)).toEqual({
      message_ref: 'note:ui-note-19',
      disposition: 'appended',
    });
  });

  it('fixes channel and direction in the service — the caller cannot state them', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await post(s, NOTE);

    const messages = await messagesOf(s);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channel).toBe('note');
    expect(messages[0]?.direction).toBe('internal');

    // Stating either one is a rejected request, not a silently-dropped key.
    for (const smuggled of [{ channel: 'sms' }, { direction: 'in' }]) {
      const res = await post(s, { ...NOTE, client_note_ref: 'ui-note-20', ...smuggled });
      expect(res.statusCode, JSON.stringify(smuggled)).toBe(400);
    }
  });

  it('runs the note through the SAME extraction path any other message uses', async () => {
    booted = await boot();
    const seen: SpineEvent[] = [];
    booted.container.queue.subscribe('test-spy', 'offer.extraction.requested.v1', (event) => {
      seen.push(event);
      return Promise.resolve({ status: 'done' as const });
    });

    const s = await scenario(booted);
    await post(s, NOTE);

    // The heavy half rides the bus, so the event is delivered on drain — the
    // note itself was already durable before the publish (@comms D5).
    const queue = booted.container.queue;
    expect(queue).toBeInstanceOf(InMemoryQueue);
    await (queue as InMemoryQueue).drain();

    expect(seen).toHaveLength(1);
    const payload = seen[0]?.payload as { channel: string; message_ref: string; text: string };
    expect(payload.channel).toBe('note');
    expect(payload.message_ref).toBe('note:ui-note-19');
    expect(payload.text).toBe(NOTE.body);
  });

  it('absorbs a replayed client_note_ref as a duplicate, not a second row', async () => {
    booted = await boot();
    const s = await scenario(booted);

    await post(s, NOTE);
    const replay = await post(s, NOTE);
    expect(replay.statusCode).toBe(201);
    expect(bodyOf<{ disposition: string }>(replay).disposition).toBe('duplicate');
    expect(await messagesOf(s)).toHaveLength(1);
  });

  it('stores the note body verbatim — never truncated, never altered', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const body = 'x'.repeat(19_999);
    await post(s, { ...NOTE, body });
    expect((await messagesOf(s))[0]?.body).toBe(body);
  });

  it('carries no audio or transcription field on any stored message', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await post(s, NOTE);

    const messages = await messagesOf(s);
    const keys = Object.keys(messages[0] ?? {});
    for (const forbidden of ['re' + 'cording', 're' + 'cording_url', 'trans' + 'cript', 'audio_url', 'media_url']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // …and no route in the suite accepts one either.
    const res = await post(s, { ...NOTE, client_note_ref: 'ui-2', ['trans' + 'cript']: 'never' });
    expect(res.statusCode).toBe(400);
  });
});

describe('author is caller-supplied and never inferred (AC-8, D13)', () => {
  it('rejects a note with no author rather than defaulting one', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const { author: _dropped, ...authorless } = NOTE;
    const res = await post(s, authorless);
    expect(res.statusCode).toBe(400);
    expect(errorCodeOf(res)).toBe('invalid_request');
    expect(await messagesOf(s)).toEqual([]);
  });

  it('cannot express `dealer` — self-authored evidence never acquires a dealer label', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await post(s, { ...NOTE, author: 'dealer' });
    expect(res.statusCode).toBe(400);
    expect(await messagesOf(s)).toEqual([]);
  });

  it('refuses an authorship the session cannot back (403), and writes nothing', async () => {
    booted = await boot();
    const s = await scenario(booted);

    // The E2 resolver always produces `owner`, so a body claiming `concierge`
    // is a claim no session can support.
    const res = await post(s, { ...NOTE, author: 'concierge' });
    expect(res.statusCode).toBe(403);
    expect(errorCodeOf(res)).toBe('forbidden');
    expect(await messagesOf(s)).toEqual([]);
  });

  it('records the author the caller stated, on the stored message', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await post(s, NOTE);
    expect((await messagesOf(s))[0]?.author).toBe('buyer');
  });

  it('maps the OTHER role the same way — a concierge session may author concierge and not buyer', async () => {
    booted = await boot({ resolver: createFixedAccountResolver(ACCOUNT_A, 'concierge_agent') });
    const s = await scenario(booted);

    const as_buyer = await post(s, NOTE);
    expect(as_buyer.statusCode).toBe(403);

    const as_concierge = await post(s, { ...NOTE, author: 'concierge' });
    expect(as_concierge.statusCode).toBe(201);
    expect((await messagesOf(s))[0]?.author).toBe('concierge');
    // Still never `dealer`, whatever the session is.
    expect((await post(s, { ...NOTE, client_note_ref: 'ui-2', author: 'dealer' })).statusCode).toBe(400);
  });
});

describe('message routes stay inside the deal and the account', () => {
  it('404s a note on a thread that does not exist', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    const dealership_id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    const res = await call(booted, 'POST', `/deals/deal-1/threads/${dealership_id}/messages`, ACCOUNT_A, NOTE);
    expect(res.statusCode).toBe(404);
  });

  it('refuses a foreign account before @comms is ever called', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await post(s, NOTE, ACCOUNT_B);
    expect(res.statusCode).toBe(404);
    expect(await messagesOf(s)).toEqual([]);
  });

  it('never serves one thread’s messages in answer to a request for another', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await post(s, NOTE);

    const other = await createDealership(booted, ACCOUNT_A, {
      name: 'Southside Auto',
      state: 'NC',
      city: 'Durham',
      zip_code: '27701',
    });
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${other}`, ACCOUNT_A, {});

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/threads/${other}/messages`, ACCOUNT_A);
    expect(bodyOf<{ messages: unknown[] }>(res).messages).toEqual([]);
    expect(res.body).not.toContain('28,900');
  });

  it('pages chronologically without reordering the trail', async () => {
    booted = await boot();
    const s = await scenario(booted);
    for (let index = 0; index < 5; index += 1) {
      await post(s, { ...NOTE, client_note_ref: `ui-${String(index)}`, body: `note ${String(index)}` });
    }

    const first = bodyOf<{ messages: readonly Message[]; next_cursor?: string }>(
      await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages?limit=2`, ACCOUNT_A),
    );
    expect(first.messages.map((m) => m.body)).toEqual(['note 0', 'note 1']);
    expect(first.next_cursor).toBe('2');

    const second = bodyOf<{ messages: readonly Message[] }>(
      await call(
        booted,
        'GET',
        `/deals/${s.deal_id}/threads/${s.dealership_id}/messages?limit=2&cursor=${String(first.next_cursor)}`,
        ACCOUNT_A,
      ),
    );
    expect(second.messages.map((m) => m.body)).toEqual(['note 2', 'note 3']);
  });

  it('registers no mutating verb on the append-only message path', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const url = `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`;

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await call(booted, method, url, ACCOUNT_A, {});
      expect(res.statusCode, method).toBe(404);
    }
  });
});
