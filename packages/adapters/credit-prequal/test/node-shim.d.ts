/**
 * Minimal ambient typings for the Node builtins the T-013 posture gate uses.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2), so
 * `@types/node` is deliberately absent. TEST SCOPE ONLY — nothing under `src/`
 * may use these, and the posture gate itself asserts that.
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
