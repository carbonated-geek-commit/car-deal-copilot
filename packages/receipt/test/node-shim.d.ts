/**
 * Minimal ambient typings for the Node builtins used by the T-008 test suite.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so @types/node is deliberately absent. Tests run
 * under Node 24 where these APIs exist at runtime; this file only gives the
 * typechecker the handful of signatures the tests touch. Test-scope only —
 * nothing in src/ may use these. (Same pattern as packages/core/test/node-shim.d.ts.)
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
