/**
 * Minimal ambient typings for the Node builtins the T-018 test suite uses.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so `@types/node` is deliberately absent — the
 * same pattern as `packages/core/test/node-shim.d.ts`,
 * `packages/adapters/nhtsa/test/node-shim.d.ts`, and
 * `services/comms/test/node-shim.d.ts`. Tests run under Node 24 where these
 * APIs exist; this file only gives the typechecker the handful of signatures
 * the tests touch.
 *
 * TEST SCOPE ONLY. Nothing in `src/` may use these: the package has no
 * filesystem access and never reads `process.env` itself (design T-018 D10 —
 * the composition root owns the environment). The only consumers are the
 * standing surface scan in `surface.test.ts` and the ADR-008 skip gate in
 * `s3-live.test.ts`.
 *
 * NO COLLISION with `src/node-shim.d.ts`: that file declares `node:crypto`,
 * `structuredClone`, `TextEncoder`, `TextDecoder`, and `setTimeout`; this one
 * declares a disjoint set. Both are included by the single
 * `packages/object-store/tsconfig.json` program, so a duplicate declaration
 * would be a compile error — there is none.
 */

interface ImportMeta {
  url: string;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

/**
 * Only what the ADR-008 skip gate reads. `s3-live.test.ts` SKIPS — never
 * silently passes — when `OBJECT_STORE_BUCKET` is absent.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
