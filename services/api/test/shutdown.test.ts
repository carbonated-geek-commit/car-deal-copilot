/**
 * Startup and shutdown as a real process-facing surface
 * (docs/design/T-019.md §4.1, §4.6).
 *
 * The loopback listen here is not an external service: it is the ADR-008
 * default posture actually serving over a socket, with no database and no
 * object store anywhere. Requests are made with `agent: false` so every
 * connection closes itself — a keep-alive socket would make `app.close()` wait
 * on the client rather than on the work, and that would be a test artefact
 * masquerading as a drain.
 */

import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createPermissiveDealGate } from '../src/index.js';
import { memoryContainer, serve, type Served } from './fixtures/harness.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

interface HttpAnswer {
  readonly status: number;
  readonly body: string;
  readonly request_id: string | undefined;
}

const fetchOnce = (url: string, headers: Record<string, string> = {}): Promise<HttpAnswer> =>
  new Promise((resolve, reject) => {
    const request = get(url, { agent: false, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          request_id: response.headers['x-request-id'] as string | undefined,
        }),
      );
    });
    request.on('error', reject);
  });

describe('the container closes cleanly and more than once', () => {
  it('is idempotent — a second close is not a second teardown', async () => {
    const container = await memoryContainer();
    await container.close();
    await expect(container.close()).resolves.toBeUndefined();
    await expect(container.close()).resolves.toBeUndefined();
  });

  it('closes with nothing configured, because there is nothing to drain', async () => {
    const container = await memoryContainer();
    expect(container.plan.objects).toBe('memory');
    await expect(container.close()).resolves.toBeUndefined();
  });
});

describe('the server serves over a real socket and drains before it stops', () => {
  it('listens on loopback with zero external services and answers', async () => {
    served = await serve();
    const address = await served.app.listen({ host: '127.0.0.1', port: 0 });
    expect(address).toContain('127.0.0.1');

    const answer = await fetchOnce(`${address}/healthz`);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ status: 'ok' });
    expect(answer.request_id).toBeTruthy();
  }, 20_000);

  it('finishes an in-flight request rather than dropping it (§4.6 step 1)', async () => {
    const gate = createPermissiveDealGate();
    const container = await memoryContainer();
    const s = await serve({
      container,
      gate,
      routes: [
        async (app) => {
          app.get('/slow', async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            return { done: true };
          });
        },
      ],
    });
    served = s;
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });

    const in_flight = fetchOnce(`${address}/slow`, { 'x-dc-account-id': 'account-a' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const closing = s.app.close();

    const answer = await in_flight;
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ done: true });
    await closing;

    // Ordering: the socket is closed and in-flight work drained BEFORE the
    // container's own teardown runs, so a payload the process already acked is
    // never dropped by a flush that raced a still-growing backlog.
    await expect(container.close()).resolves.toBeUndefined();
    served = undefined;
  }, 20_000);
});
