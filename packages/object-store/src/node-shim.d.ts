/**
 * Minimal ambient typings for the Node 24 builtins this package uses.
 *
 * WHY THIS FILE EXISTS (deviation from docs/design/T-018.md §7, recorded here
 * rather than in a commit message so the next reader finds it):
 *
 * T-015 §5.7 forbade the new Epic-2 packages from hand-writing a shim on the
 * premise that `@types/node` reaches any program touching `pg`/`fastify`/the
 * S3 SDK through an explicit `/// <reference types="node" />` in the library
 * typings. That premise was tested here and is FALSE for this package:
 * `tsconfig.base.json` sets `"types": []`, and a program consisting of
 * `packages/object-store/{src,test}` plus `@aws-sdk/client-s3` and `@comms`
 * still reports `TS2307 Cannot find module 'node:crypto'` — for this
 * package's files AND for the `services/comms` files that the ADR-009-mandated
 * `@comms` import edge pulls in (their own shim lives in `services/comms/src`
 * and is not reachable from this program, because an ambient `.d.ts` is
 * included by a tsconfig `include` glob, never by an import).
 *
 * The duplicate-identifier collision T-015 §5.7 was guarding against therefore
 * cannot occur: no program includes two of these shims, since no `include`
 * glob spans two packages. The design's alternative — a root
 * `devDependencies` entry for `@types/node` — is T-015 territory and outside
 * this task's ownership, so it is reported to the lead as a note rather than
 * taken unilaterally. This file is inside `packages/object-store/src/**`,
 * adds no dependency, and overrides no compiler option.
 *
 * Only the exact signatures this package touches are declared.
 */

declare module 'node:crypto' {
  export interface Sha256Hash {
    update(data: string | Uint8Array): Sha256Hash;
    digest(encoding: 'hex' | 'base64'): string;
  }
  export function createHash(algorithm: 'sha256'): Sha256Hash;
  /** Not used by this package; declared because the `@comms` sources this
   *  program pulls in through the ADR-009 import edge use it. */
  export function randomUUID(): string;
}

/** Node 24 global used by the `@comms` sources — lib.es2022 has no declaration. */
declare function structuredClone<T>(value: T): T;

/** Node 24 globals (WHATWG encoding + timers) — not in lib.es2022. */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}

declare function setTimeout(handler: () => void, timeout?: number): unknown;
