/**
 * The log allow list IS the specification (docs/design/T-019.md §4.5).
 *
 * What is asserted here is mostly an ABSENCE: the serializers REPLACE Fastify's
 * defaults, so a field this list never named cannot be reintroduced by a
 * framework default.
 */

import { describe, expect, it } from 'vitest';

import { ACCOUNT_HEADER, REDACTED_LOG_PATHS, logSerializers } from '../src/index.js';

describe('request and reply serializers', () => {
  it('logs the route TEMPLATE, never the raw url or its query string', () => {
    const logged = logSerializers.req({
      id: 'req-7',
      method: 'GET',
      routeOptions: { url: '/deals/:deal_id/threads/:dealership_id' },
    });
    expect(logged).toEqual({
      request_id: 'req-7',
      method: 'GET',
      route: '/deals/:deal_id/threads/:dealership_id',
    });
    // No url, no headers, no body, no query — they are not in the output at all.
    for (const forbidden of ['url', 'headers', 'body', 'query', 'params', 'hostname', 'remoteAddress']) {
      expect(Object.keys(logged), forbidden).not.toContain(forbidden);
    }
  });

  it('reports an unmatched request as `unmatched` rather than by echoing its url', () => {
    expect(logSerializers.req({ id: 1, method: 'POST' })).toEqual({
      request_id: '1',
      method: 'POST',
      route: 'unmatched',
    });
  });

  it('logs a status and nothing else off the reply', () => {
    expect(logSerializers.res({ statusCode: 503 })).toEqual({ status: 503 });
  });
});

describe('the redaction list', () => {
  it('covers every credential-bearing header and both bodies', () => {
    expect(REDACTED_LOG_PATHS).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
      `req.headers["${ACCOUNT_HEADER}"]`,
      'req.headers["x-api-key"]',
      'req.body',
      'res.body',
    ]);
  });

  it('redacts the account header even though the account id is logged as a field', () => {
    // The FIELD is the resolver's output; the HEADER is unvalidated caller
    // input. Only one of those belongs in a log line.
    expect(REDACTED_LOG_PATHS).toContain(`req.headers["${ACCOUNT_HEADER}"]`);
    expect(ACCOUNT_HEADER).toBe('x-dc-account-id');
  });
});
