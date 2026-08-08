/**
 * Minimal ambient typings for the Node builtins used by the T-001 test suite.
 *
 * Root devDeps are frozen to typescript + vitest (CLAUDE.md invariant 2 /
 * docs/design/T-001.md §1.2), so @types/node is deliberately absent. Tests run
 * under Node 24 where these APIs exist at runtime; this file only gives the
 * typechecker the handful of signatures the tests touch. Test-scope only —
 * nothing in src/ may use these.
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
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): DirentLike[];
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

/** Used only by the AC-17 gate (typecheck.test.ts), which shells out to `tsc`. */
declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options: { cwd?: string; encoding: 'utf8' },
  ): SpawnSyncResult;
}

/** Only the member the AC-17 gate touches. */
declare const process: {
  execPath: string;
};
