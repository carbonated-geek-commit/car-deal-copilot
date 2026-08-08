/**
 * Minimal ambient typings for the Node builtins the T-014 test suite uses.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so `@types/node` is deliberately absent — the
 * same pattern as `packages/core/test/node-shim.d.ts`. Tests run under Node 24
 * where these APIs exist; this file only gives the typechecker the handful of
 * signatures the tests touch.
 *
 * TEST SCOPE ONLY. Nothing in `src/` may use these: the service has no
 * filesystem access and no HTTP client by construction (design T-014 §4).
 * The only consumer is the standing surface scan in `surface.test.ts`.
 */

interface ImportMeta {
  url: string;
}

declare module 'node:fs' {
  export interface DirentLike {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
