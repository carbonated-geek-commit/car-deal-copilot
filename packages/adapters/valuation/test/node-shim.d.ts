/**
 * Minimal ambient typings for the Node builtins the T-013 posture gate uses.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so `@types/node` is deliberately absent. Tests run
 * under Node 24 where these APIs exist at runtime; this file gives the
 * typechecker only the handful of signatures the suite touches.
 *
 * TEST SCOPE ONLY — nothing under `src/` may use these. The posture gate itself
 * asserts that: a src file importing `node:fs` fails the mock-only scan.
 * (Pattern follows packages/adapters/nhtsa/test/node-shim.d.ts.)
 */

interface ImportMeta {
  url: string;
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readdirSync(
    path: string | URL,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean; isFile(): boolean }[];
}
