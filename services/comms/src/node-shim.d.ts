/**
 * Minimal ambient typings for the Node 24 builtins this service uses.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so @types/node is deliberately absent — the
 * same pattern as packages/core/test/node-shim.d.ts. Design T-009 §0 D2
 * explicitly sanctions `node:crypto` as a builtin, not a dependency.
 *
 * Only the exact signatures this service touches are declared.
 */

declare module 'node:crypto' {
  export interface Sha256Hash {
    update(data: string): Sha256Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Sha256Hash;
  export function randomUUID(): string;
}

/** Node 24 global (structuredClone) — lib.es2022 has no declaration for it. */
declare function structuredClone<T>(value: T): T;
