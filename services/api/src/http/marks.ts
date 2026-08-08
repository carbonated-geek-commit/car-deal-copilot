/**
 * Hook identity marks (docs/design/T-019.md §2.10).
 *
 * The boot-time route audit has to answer "did this route wire the gate?" while
 * holding only the route's hook ARRAYS — anonymous closures produced by
 * `dealGate(...)` and `validate(...)`. Comparing function identity is
 * impossible (each call returns a fresh closure) and comparing `fn.name` is a
 * string convention that a bundler or a refactor breaks silently.
 *
 * A brand on the function object is neither: it survives renaming, it cannot be
 * produced by writing a similarly-named hook, and the audit's question becomes
 * a lookup rather than a heuristic. This is the mechanism that lets AC-3 and
 * AC-5 keep holding over `src/routes/**`, which this task does not own.
 */

const HOOK_MARK = Symbol.for('deal-copilot.api.hook-mark');

export type HookMark = 'account-context' | 'validation' | 'deal-gate';

/** Brands a hook in place and returns it, so factories can `return markHook(...)`. */
export function markHook<F extends (...args: never[]) => unknown>(fn: F, mark: HookMark): F {
  Object.defineProperty(fn, HOOK_MARK, { value: mark, enumerable: false, configurable: false, writable: false });
  return fn;
}

export function hookMarkOf(candidate: unknown): HookMark | undefined {
  if (typeof candidate !== 'function') return undefined;
  const mark = (candidate as unknown as Record<symbol, unknown>)[HOOK_MARK];
  return typeof mark === 'string' ? (mark as HookMark) : undefined;
}

/** True when any hook in a route's (possibly absent, possibly single) chain carries `mark`. */
export function chainHasMark(chain: unknown, mark: HookMark): boolean {
  if (chain === undefined || chain === null) return false;
  const hooks = Array.isArray(chain) ? chain : [chain];
  return hooks.some((hook) => hookMarkOf(hook) === mark);
}
