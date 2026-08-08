/**
 * The account context, resolved ONCE at the edge (docs/design/T-019.md §2.4,
 * D1; AC-2, AC-4).
 *
 * This module is the ONLY place in the service permitted to read an identity
 * off the wire. Nothing downstream touches `req.headers`; everything downstream
 * receives an `AccountContext` that has already been produced by a named
 * resolver. That is what makes AC-4 survivable: E3 registers a different
 * resolver and no route, repository, projection, or validator changes.
 *
 * AC-4 forbids selecting or wiring an auth provider, while AC-2 requires an
 * account context on every request. Something has to produce the id in
 * between. The honest shape is a PORT with one deliberately weak
 * implementation that names its own weakness — `poc-header` — rather than a
 * half-chosen provider or an invisible default.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiErrorException, apiError } from '../errors/envelope.js';
import { MESSAGE_BY_CODE } from '../errors/mapping.js';
import { markHook } from '../http/marks.js';

/**
 * The tenancy argument carried through every scoped call.
 *
 * DEVIATION FROM THE DESIGN, recorded in place: §2.4 imports `AccountScope`
 * from `@store-pg`, but `packages/store-pg` has no `src/` — T-017 is
 * `status: blocked` on its E1 escalation, so the `@store-pg` alias resolves to
 * nothing and that import cannot compile today. This is a STRUCTURAL alias to
 * the exact shape T-017 §2.1 specifies (`{ readonly account_id: string }`), not
 * a competing declaration: an `AccountScope` is assignable to it and it is
 * assignable to an `AccountScope`, so when `@store-pg` ships, this alias is
 * replaced by the import and no field, call site, or signature moves. Declaring
 * a rival `interface AccountScope` here is what ADR-001 forbids, and this is
 * deliberately not that.
 */
export type AccountScopeShape = { readonly account_id: string };

/**
 * Declared NOW so E3's role-scoped views (specs/01 "Concierge tier" enforced
 * control 1) need no new plumbing. E2 only ever produces `owner`.
 */
export type ActorRole = 'owner' | 'concierge_agent';

export interface AccountContext {
  /** `account_id` IS `Deal.owner_id` (T-016 D3) — one column, two names. */
  readonly scope: AccountScopeShape;
  readonly role: ActorRole;
  /** Which resolver produced this — `poc-header` today. Logged, never trusted. */
  readonly source: string;
  readonly request_id: string;
}

export type AccountContextResult =
  | { readonly outcome: 'resolved'; readonly context: AccountContext }
  | { readonly outcome: 'unresolved'; readonly reason: 'absent' | 'malformed' };

export interface AccountContextResolver {
  /** Stable identifier for logs and `/readyz`. */
  readonly source: string;
  resolve(req: FastifyRequest): Promise<AccountContextResult>;
}

export const ACCOUNT_HEADER = 'x-dc-account-id';

/** Same bound as `validation/schemas.ts` `opaqueId`: log-safe, key-safe, bounded. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const POC_HEADER_SOURCE = 'poc-header';
export const FIXED_ACCOUNT_SOURCE = 'fixed-account';

/**
 * E2 ONLY.
 *
 * This is an IDENTITY ASSERTION, NOT AUTHENTICATION. The header is
 * unauthenticated, unsigned, and trivially spoofable. It exists so the
 * account-scoping seam is exercised end to end BEFORE an auth provider is
 * chosen (AC-4 — Auth0/Clerk/Cognito are named in specs/00 as alternates, and
 * choosing one is E3's decision, not a side effect of needing an id here).
 *
 * The name says so in code, in the startup log, and in `/readyz`, because the
 * failure mode this guards against is an operator seeing a working
 * account-scoped API and concluding it is secured. The default bind address is
 * `127.0.0.1` for the same reason (`config/env.ts`).
 */
export function createPocHeaderResolver(): AccountContextResolver {
  return {
    source: POC_HEADER_SOURCE,
    resolve(req: FastifyRequest): Promise<AccountContextResult> {
      const raw = req.headers[ACCOUNT_HEADER];
      // A repeated header arrives as an array. Two asserted identities is not
      // an identity — resolved as malformed rather than by picking one.
      if (Array.isArray(raw)) return Promise.resolve({ outcome: 'unresolved', reason: 'malformed' });
      if (raw === undefined || raw.trim() === '') {
        return Promise.resolve({ outcome: 'unresolved', reason: 'absent' });
      }
      const account_id = raw.trim();
      if (!ACCOUNT_ID_PATTERN.test(account_id)) {
        return Promise.resolve({ outcome: 'unresolved', reason: 'malformed' });
      }
      return Promise.resolve({
        outcome: 'resolved',
        context: {
          scope: { account_id },
          role: 'owner',
          source: POC_HEADER_SOURCE,
          request_id: String(req.id),
        },
      });
    },
  };
}

/** Tests and single-tenant demos: one account, no wire input at all. */
export function createFixedAccountResolver(account_id: string, role: ActorRole = 'owner'): AccountContextResolver {
  return {
    source: FIXED_ACCOUNT_SOURCE,
    resolve(req: FastifyRequest): Promise<AccountContextResult> {
      return Promise.resolve({
        outcome: 'resolved',
        context: { scope: { account_id }, role, source: FIXED_ACCOUNT_SOURCE, request_id: String(req.id) },
      });
    },
  };
}

/**
 * The edge hook. Registered `onRequest`, which Fastify runs BEFORE
 * `preValidation` (§4.2 step 3 before step 4).
 *
 * That order is a security property, not a preference: an unauthenticated
 * caller gets `401` and learns nothing about the request schema — no field
 * names, no enum members, no hint about which resources exist.
 */
export function accountContext(
  resolver: AccountContextResolver,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return markHook(async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const result = await resolver.resolve(req);
    if (result.outcome === 'unresolved') {
      // The REASON is logged; the response carries only the code. Telling a
      // caller "malformed" vs "absent" describes our parsing rules to someone
      // who has not identified themselves.
      req.log.warn({ event: 'auth_unresolved', reason: result.reason, resolver: resolver.source });
      throw new ApiErrorException(apiError('unauthenticated', MESSAGE_BY_CODE.unauthenticated));
    }
    req.account_context = result.context;
  }, 'account-context');
}

/**
 * Reads what the hook stored.
 *
 * Throws `internal` when called on a plane that has no context — the webhook
 * plane genuinely has none (§2.9), and a caught defect is strictly better than
 * a silent `undefined` that would then be scoped against.
 */
export function requireAccountContext(req: FastifyRequest): AccountContext {
  const context = req.account_context;
  if (context === undefined) {
    throw new ApiErrorException(
      apiError('internal', MESSAGE_BY_CODE.internal, {
        cause: 'account context requested on a request that never resolved one',
      }),
    );
  }
  return context;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Optional BECAUSE the webhook plane has neither (§3.4). Read only through
     * `requireAccountContext`, never destructured directly.
     */
    account_context?: AccountContext;
  }
}
