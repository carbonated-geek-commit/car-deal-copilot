/**
 * Minimal ambient typings for the Node builtins used by the T-011 test suite.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so @types/node is deliberately absent. Tests run
 * under Node 24 where these APIs exist at runtime; this file only gives the
 * typechecker the handful of signatures the structural suites touch.
 * Test-scope only — nothing in src/ may use these (the engine is pure and
 * imports nothing but @core: docs/design/T-011.md §4.1 row 9).
 *
 * Same shape as packages/core/test/node-shim.d.ts, trimmed to what is used here.
 */

interface ImportMeta {
  url: string;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
