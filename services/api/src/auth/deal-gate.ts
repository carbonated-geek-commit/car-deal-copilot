/**
 * The deal-scoped authorization choke point (docs/design/T-019.md §2.5, D2, D3;
 * AC-3).
 *
 * **E3's entire diff is this file.** `createPermissiveDealGate` becomes a real
 * gate; `AuthzDenyReason` already carries `grant_expired` and
 * `role_not_permitted` (specs/01 "Concierge tier" enforced controls 1 and 3),
 * `DealAction` already carries `export` (control 2), and `AccountContext.role`
 * already carries `concierge_agent` (control 1). No route, repository, or
 * response type moves.
 *
 * D2 — why a token and not a convention. "Every deal-addressed request passes
 * through the gate" is unverifiable as a rule someone remembers. `DealHandle`
 * carries a module-private `unique symbol` and is constructible only here, and
 * every store-touching signature in the service takes the handle instead of a
 * `deal_id: string`. The forgetful version does not compile. The boot-time
 * route audit (`http/audit.ts`) is the belt to that brace: it refuses to start
 * a server whose `:deal_id` route skipped this hook, which is how the property
 * survives T-020 adding routes this task does not own.
 *
 * D3 — why a foreign account's deal is `404` and not `403`. A `403` on a deal
 * id is an existence oracle: it confirms the id is real to a caller who is not
 * allowed to know that. `403` is reserved for role/grant denials INSIDE an
 * account the caller does own, which are declared here and unreachable in E2.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireAccountContext, type AccountContext, type AccountScopeShape } from '../context/account-context.js';
import { ApiErrorException, apiError, type ApiErrorCode } from '../errors/envelope.js';
import { MESSAGE_BY_CODE } from '../errors/mapping.js';
import { markHook } from '../http/marks.js';

/** `export` is declared for specs/01 concierge control 2; unused in E2. */
export type DealAction = 'read' | 'write' | 'export';

export type AuthzDenyReason =
  | 'not_owned' // E2-reachable — the account does not own this deal
  | 'deal_not_found' // E2-reachable
  | 'grant_expired' // E3 (concierge control 3) — declared, unreachable today
  | 'role_not_permitted'; // E3 (concierge controls 1 & 2) — declared, unreachable today

export type AuthzDecision =
  | { readonly outcome: 'permit'; readonly reason: 'account_owns_deal' }
  | { readonly outcome: 'deny'; readonly reason: AuthzDenyReason };

/**
 * Module-private and NOT exported. `declare const` means it has no runtime
 * value at all, so there is nothing to import, copy, or reconstruct — a handle
 * can only come from `mintHandle` below.
 */
declare const DEAL_HANDLE_BRAND: unique symbol;

/**
 * Proof that (a) an account context exists and (b) the gate permitted this
 * action on this deal.
 */
export interface DealHandle {
  readonly [DEAL_HANDLE_BRAND]: true;
  readonly deal_id: string;
  readonly action: DealAction;
  readonly account: AccountContext;
  /** Convenience; identical to `account.scope`. */
  readonly scope: AccountScopeShape;
}

export interface DealAccessGate {
  readonly name: string;
  authorize(ctx: AccountContext, deal_id: string, action: DealAction): Promise<AuthzDecision>;
}

export const PERMISSIVE_GATE = 'permissive-e2';

/**
 * The E2 gate. Permits every action for a resolved context.
 *
 * It deliberately does NOT read the store. Ownership is verified on the READ
 * path instead (`auth/scoped-store.ts` re-checks `deal.owner_id` after every
 * read), which keeps the gate a pure policy function with no store dependency —
 * so E3 replaces a policy, not a data-access layer, and the gate cannot itself
 * become a way to probe for a deal's existence.
 */
export function createPermissiveDealGate(): DealAccessGate {
  return {
    name: PERMISSIVE_GATE,
    authorize(): Promise<AuthzDecision> {
      return Promise.resolve({ outcome: 'permit', reason: 'account_owns_deal' });
    },
  };
}

/** The ONE construction site. The cast is legal here and nowhere else. */
function mintHandle(account: AccountContext, deal_id: string, action: DealAction): DealHandle {
  return { deal_id, action, account, scope: account.scope } as DealHandle;
}

/** D3 made mechanical: the deny reason decides the status, once. */
export const STATUS_CODE_BY_DENY_REASON: Readonly<Record<AuthzDenyReason, ApiErrorCode>> = {
  not_owned: 'not_found',
  deal_not_found: 'not_found',
  grant_expired: 'forbidden',
  role_not_permitted: 'forbidden',
};

/**
 * The `preHandler` factory every deal-addressed route MUST use.
 *
 * Reads `:deal_id` from the ALREADY-VALIDATED params — `preValidation` has run
 * by this point in the Fastify lifecycle, so the gate never sees a raw path
 * segment, and the route audit refuses to start a server where that ordering
 * was not wired.
 */
export function dealGate(
  gate: DealAccessGate,
  action: DealAction,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return markHook(async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const account = requireAccountContext(req);
    const deal_id = (req.params as { deal_id?: unknown } | undefined)?.deal_id;
    if (typeof deal_id !== 'string' || deal_id.length === 0) {
      // Unreachable through an audited route: validation would have rejected
      // it first. Reported as OUR defect rather than the caller's, because a
      // route reaching here means the wiring, not the request, is wrong.
      throw new ApiErrorException(
        apiError('internal', MESSAGE_BY_CODE.internal, { cause: 'deal gate ran on a route without a validated :deal_id' }),
      );
    }

    const decision = await gate.authorize(account, deal_id, action);
    if (decision.outcome === 'deny') {
      const code = STATUS_CODE_BY_DENY_REASON[decision.reason];
      req.log.warn({
        event: 'tenancy_reject',
        gate: gate.name,
        reason: decision.reason,
        action,
        account_id: account.scope.account_id,
        deal_id,
      });
      throw new ApiErrorException(apiError(code, MESSAGE_BY_CODE[code]));
    }

    req.deal_handle = mintHandle(account, deal_id, action);
  }, 'deal-gate');
}

/**
 * Reads the minted handle. Throws `internal` when the gate did not run — a
 * state the route audit makes unreachable for any registered route.
 */
export function requireDealHandle(req: FastifyRequest): DealHandle {
  const handle = req.deal_handle;
  if (handle === undefined) {
    throw new ApiErrorException(
      apiError('internal', MESSAGE_BY_CODE.internal, { cause: 'deal handle requested on a request the gate never authorized' }),
    );
  }
  return handle;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Optional BECAUSE the webhook plane never mints one (§3.4). */
    deal_handle?: DealHandle;
  }
}
