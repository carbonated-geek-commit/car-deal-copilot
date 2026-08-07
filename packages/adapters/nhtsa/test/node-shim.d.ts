/**
 * Minimal ambient typings for the Node builtins used by the T-004 test suite.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so @types/node is deliberately absent. Tests run
 * under Node 24 where these APIs exist at runtime; this file only gives the
 * typechecker the handful of signatures the tests touch. Test-scope only —
 * nothing in src/ may use these. (Pattern follows packages/core/test/node-shim.d.ts.)
 */

interface ImportMeta {
  url: string;
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}

/** Only what the opt-in live-smoke gate reads (design D7). */
declare const process: {
  env: Record<string, string | undefined>;
};
