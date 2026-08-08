/**
 * T-010 tester — AC-17 gate: `packages/core` typechecks standalone.
 *
 * Why this test exists: vitest erases types at runtime, so every
 * `expectTypeOf`, `satisfies`, and `@ts-expect-error` assertion in this suite is
 * inert unless a compiler actually runs. This spec runs
 * `tsc -p packages/core --noEmit` inside the suite, which makes the whole
 * type-level half of the T-010 contract load-bearing:
 *
 *  - a removed field reappearing (recording_url, resolved_vehicle, …) fails an
 *    `@ts-expect-error` that no longer errors → non-zero exit → this test fails;
 *  - a widened union or a renamed field fails an `expectTypeOf` → same.
 *
 * It also enforces AC-17 literally: this package must be green on its own while
 * T-011…T-014 are still mid-migration, so the project scope is packages/core
 * only — downstream breakage is expected and must not be read as a T-010 defect.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const tscEntry = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

describe('AC-17 — packages/core typechecks standalone', () => {
  it('the local typescript compiler is resolvable from the repo root', () => {
    expect(existsSync(tscEntry), `missing ${tscEntry}`).toBe(true);
  });

  it('`tsc -p packages/core --noEmit` exits clean (src AND test)', () => {
    const run = spawnSync(
      process.execPath,
      [tscEntry, '-p', resolve(repoRoot, 'packages', 'core'), '--noEmit', '--pretty', 'false'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    expect(output, 'typecheck diagnostics').toBe('');
    expect(run.status).toBe(0);
  }, 180_000);
});
