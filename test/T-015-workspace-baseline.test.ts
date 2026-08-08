/**
 * T-015 tester — Epic-2 workspace + dependency baseline.
 *
 * Source of truth: tasks/T-015-epic2-workspace-dependency-baseline.md (AC-1..AC-7)
 * and docs/design/T-015.md (§1 inventory, §2 alias/import contract, §3 data shapes,
 * §4 error paths, §5 invariant touchpoints).
 *
 * T-015 ships no TypeScript value and no type. Its *interface* is the module graph
 * and the dependency set (design §2), so every case below reads a manifest, a
 * tsconfig, the vitest alias map, or the lockfile and asserts the contract those
 * files are supposed to encode. The error-path cases (§4) are the ones that matter
 * most: they encode the failure modes the design named but that nothing else checks.
 *
 * PLACEMENT NOTE (tester deviation, non-blocking): T-015's file_ownership is
 * manifests + root config only — it contains no test path, and design §1.2 forbids
 * this task from creating `test/` inside any of the four new members (those subtrees
 * belong to T-016/T-017/T-018/T-019). A root-level `test/` collides with no task's
 * ownership and sits in the same root-config zone T-015 exclusively owns. The single
 * `test/**\/*.test.ts` include glob added to vitest.workspace.ts (a T-015-owned file)
 * is what makes this file collectable; the alias map — the actual deliverable — was
 * not touched.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p: string[]) => resolve(repoRoot, ...p);
const readJson = (...p: string[]) => JSON.parse(readFileSync(at(...p), 'utf8'));
const readText = (...p: string[]) => readFileSync(at(...p), 'utf8');

// ---------------------------------------------------------------------------
// The contract, transcribed from the design. A change to either side of a row
// without a matching change to the other is exactly what these tests exist to catch.
// ---------------------------------------------------------------------------

/** design §1.2 / §3.2 — the four members this task creates, and nothing else. */
const NEW_MEMBERS = [
  {
    dir: 'packages/db',
    name: '@deal-copilot/db',
    dependencies: { pg: '^8' },
    devDependencies: { '@types/pg': '^8' },
  },
  {
    dir: 'packages/store-pg',
    name: '@deal-copilot/store-pg',
    dependencies: { pg: '^8' },
    devDependencies: { '@types/pg': '^8' },
  },
  {
    dir: 'packages/object-store',
    name: '@deal-copilot/object-store',
    dependencies: { '@aws-sdk/client-s3': '^3' },
    devDependencies: undefined,
  },
  {
    dir: 'services/api',
    name: '@deal-copilot/api',
    dependencies: { fastify: '^5', zod: '^4' },
    devDependencies: undefined,
  },
] as const;

/** design §2.1 / §3.3 — twelve entries, this order, these targets. ADR-009 §1. */
const ALIAS_CONTRACT: ReadonlyArray<readonly [string, string]> = [
  ['@core', 'packages/core/src/index.ts'],
  ['@flag-engine', 'packages/flag-engine/src/index.ts'],
  ['@adapters/valuation', 'packages/adapters/valuation/src/index.ts'],
  ['@adapters/nhtsa', 'packages/adapters/nhtsa/src/index.ts'],
  ['@adapters/vehicle-history', 'packages/adapters/vehicle-history/src/index.ts'],
  ['@adapters/credit-prequal', 'packages/adapters/credit-prequal/src/index.ts'],
  ['@offer-extraction', 'packages/offer-extraction/src/index.ts'],
  ['@receipt', 'packages/receipt/src/index.ts'],
  ['@comms', 'services/comms/src/index.ts'],
  ['@db', 'packages/db/src/index.ts'],
  ['@store-pg', 'packages/store-pg/src/index.ts'],
  ['@object-store', 'packages/object-store/src/index.ts'],
];

/** All thirteen workspace members (the nine that predate this task + the four new). */
const ALL_MEMBERS = [
  'packages/core',
  'packages/flag-engine',
  'packages/offer-extraction',
  'packages/receipt',
  'packages/adapters/valuation',
  'packages/adapters/nhtsa',
  'packages/adapters/vehicle-history',
  'packages/adapters/credit-prequal',
  'services/comms',
  'packages/db',
  'packages/store-pg',
  'packages/object-store',
  'services/api',
];

/** The nine members that had sources when T-015 landed — design §3.1. */
const SOURCE_MEMBERS_IN_TYPECHECK_CHAIN = [
  'packages/core',
  'packages/flag-engine',
  'packages/offer-extraction',
  'packages/receipt',
  'packages/adapters/valuation',
  'packages/adapters/nhtsa',
  'packages/adapters/vehicle-history',
  'packages/adapters/credit-prequal',
  'services/comms',
];

/** ADR-008's five slots, plus the two root devDeps that predate Epic 2. */
const APPROVED_DEPENDENCIES = new Set([
  'typescript',
  'vitest',
  'pg',
  '@types/pg',
  '@aws-sdk/client-s3',
  'fastify',
  'zod',
]);

const rootPkg = readJson('package.json');
const lock = readJson('package-lock.json');
const tsBase = readJson('tsconfig.base.json');
const vitestWorkspaceText = readText('vitest.workspace.ts');

const declaredDepsOf = (dir: string) => {
  const pkg = readJson(dir, 'package.json');
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  } as Record<string, string>;
};

// ===========================================================================
// AC-1 — the four members are registered under the EXISTING npm-workspaces globs
// ===========================================================================
describe('AC-1 — workspace registration (ADR-003; design D1)', () => {
  it.each(NEW_MEMBERS)('$dir exists and carries a manifest', ({ dir }) => {
    expect(existsSync(at(dir, 'package.json')), `${dir}/package.json`).toBe(true);
  });

  it('the workspaces globs are UNCHANGED — registration is by manifest, not by editing the array (D1)', () => {
    expect(rootPkg.workspaces).toEqual(['packages/*', 'packages/adapters/*', 'services/*']);
  });

  it('each new member is matched by one of those globs', () => {
    const globs: RegExp[] = rootPkg.workspaces.map(
      (g: string) => new RegExp(`^${g.replace(/\*/g, '[^/]+')}$`),
    );
    for (const { dir } of NEW_MEMBERS) {
      expect(globs.some((re) => re.test(dir)), `${dir} matched by no workspace glob`).toBe(true);
    }
  });

  it('the lockfile registers all four as workspace entries', () => {
    for (const { dir } of NEW_MEMBERS) {
      expect(lock.packages[dir], `${dir} absent from package-lock.json`).toBeDefined();
    }
  });

  it('no pnpm or yarn workspace/lock artifact was introduced (ADR-003)', () => {
    for (const f of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
      expect(existsSync(at(f)), `${f} must not exist`).toBe(false);
    }
  });
});

// ===========================================================================
// AC-2 — @deal-copilot/<name> manifests + bare TS path aliases
// ===========================================================================
describe('AC-2 — package names (ADR-004 §1)', () => {
  it.each(NEW_MEMBERS)('$dir is named $name and is private', ({ dir, name }) => {
    const pkg = readJson(dir, 'package.json');
    expect(pkg.name).toBe(name);
    expect(pkg.private).toBe(true);
  });

  it.each(NEW_MEMBERS)(
    '$dir carries a LEGAL npm name, not the bare alias form (§4.1 EINVALIDPACKAGENAME)',
    ({ dir }) => {
      const { name } = readJson(dir, 'package.json');
      expect(name).toMatch(/^@deal-copilot\/[a-z0-9][a-z0-9-]*$/);
      // `@db` etc. are alias-only; a bare-scoped manifest name is an install-time failure.
      expect(name.includes('/'), `${name} is not a scoped name`).toBe(true);
    },
  );

  it.each(NEW_MEMBERS)(
    '$dir is a workspace marker only — no main/exports/types/version/files (§3.2)',
    ({ dir }) => {
      const pkg = readJson(dir, 'package.json');
      for (const field of ['main', 'exports', 'types', 'typings', 'version', 'files']) {
        expect(pkg[field], `${dir} declares "${field}"`).toBeUndefined();
      }
    },
  );

  it.each(NEW_MEMBERS)(
    '$dir declares no cross-package @deal-copilot dependency (§3.2 — resolution is by alias, not npm graph)',
    ({ dir }) => {
      const declared = Object.keys(declaredDepsOf(dir));
      expect(declared.filter((d) => d.startsWith('@deal-copilot/'))).toEqual([]);
    },
  );
});

describe('AC-2 — the alias contract, exactly twelve entries (design §2.1/§3.3, ADR-009 §1)', () => {
  const paths: Record<string, string[]> = tsBase.compilerOptions.paths;

  it('tsconfig.base.json paths is the twelve-entry map, in order, target-for-target', () => {
    expect(Object.entries(paths).map(([k, v]) => [k, v[0]])).toEqual(
      ALIAS_CONTRACT.map(([k, v]) => [k, v]),
    );
  });

  it('vitest.workspace.ts declares the same twelve, in the same order (parity is positional)', () => {
    const aliasBlock = vitestWorkspaceText.slice(
      vitestWorkspaceText.indexOf('const alias = {'),
      vitestWorkspaceText.indexOf('export default'),
    );
    const parsed = [...aliasBlock.matchAll(/'([^']+)':\s*r\('([^']+)'\)/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(parsed).toEqual(ALIAS_CONTRACT.map(([k, v]) => [k, v]));
  });

  it('neither map declares an entry the other lacks (§3.3 sync rule — silent drift in both directions)', () => {
    const rCount = (vitestWorkspaceText.match(/r\('/g) ?? []).length;
    expect(rCount).toBe(Object.keys(paths).length);
    expect(rCount).toBe(ALIAS_CONTRACT.length);
  });

  it('every alias is BARE — no /* entry, so deep imports past a barrel are unresolvable (T-001 D3)', () => {
    for (const [alias, targets] of Object.entries(paths)) {
      expect(alias.endsWith('/*'), alias).toBe(false);
      expect(alias.includes('*'), alias).toBe(false);
      expect(targets, alias).toHaveLength(1);
      expect(targets[0].endsWith('/src/index.ts'), `${alias} -> ${targets[0]}`).toBe(true);
    }
  });

  it('services/api gets no alias — it is the composition root, imported by nothing (D4)', () => {
    const targets = Object.values(paths).map((t) => t[0]);
    expect(targets.filter((t) => t.startsWith('services/api'))).toEqual([]);
  });

  it('@comms resolves to the comms barrel — the in-memory queue/store home T-017/T-019 import (D2)', () => {
    expect(paths['@comms']).toEqual(['services/comms/src/index.ts']);
    expect(existsSync(at('services/comms/src/index.ts'))).toBe(true);
  });
});

// ===========================================================================
// AC-3 — the Epic-2 dependency set: added here, per-package (D3)
// ===========================================================================
describe('AC-3 — dependency placement is per package (design D3, §3.2)', () => {
  it.each(NEW_MEMBERS)('$dir declares exactly its own slot', (member) => {
    const pkg = readJson(member.dir, 'package.json');
    expect(pkg.dependencies).toEqual(member.dependencies);
    expect(pkg.devDependencies).toEqual(member.devDependencies);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('root devDependencies are still typescript + vitest only; root declares no dependencies (D3)', () => {
    expect(rootPkg.devDependencies).toEqual({ typescript: '^5.5', vitest: '^3' });
    expect(rootPkg.dependencies).toBeUndefined();
  });

  it('pg lives only in @db and @store-pg (§5.5 anti-corruption, checkable from a manifest diff)', () => {
    const owners = ALL_MEMBERS.filter((d) => 'pg' in declaredDepsOf(d));
    expect(owners.sort()).toEqual(['packages/db', 'packages/store-pg']);
  });

  it('the S3 client lives only in @object-store', () => {
    const owners = ALL_MEMBERS.filter((d) => '@aws-sdk/client-s3' in declaredDepsOf(d));
    expect(owners).toEqual(['packages/object-store']);
  });

  it('fastify and zod live only in services/api', () => {
    for (const lib of ['fastify', 'zod']) {
      const owners = ALL_MEMBERS.filter((d) => lib in declaredDepsOf(d));
      expect(owners, lib).toEqual(['services/api']);
    }
  });

  it('the nine pre-Epic-2 members still declare zero dependencies', () => {
    for (const dir of ALL_MEMBERS.filter((d) => !NEW_MEMBERS.some((m) => m.dir === d))) {
      expect(Object.keys(declaredDepsOf(dir)), dir).toEqual([]);
    }
  });

  it('the five installed libraries resolve at the ranges §3.2 recorded', () => {
    const resolved = (name: string) => lock.packages[`node_modules/${name}`]?.version as string;
    expect(resolved('pg')).toMatch(/^8\./);
    expect(resolved('@types/pg')).toMatch(/^8\./);
    expect(resolved('@aws-sdk/client-s3')).toMatch(/^3\./);
    expect(resolved('fastify')).toMatch(/^5\./);
    expect(resolved('zod')).toMatch(/^4\./);
  });

  it('@types/node arrives transitively — no fifth root devDependency was needed (§8 item 3)', () => {
    expect(lock.packages['node_modules/@types/node']).toBeDefined();
    expect(rootPkg.devDependencies['@types/node']).toBeUndefined();
  });
});

// ===========================================================================
// AC-4 — nothing unapproved entered (CLAUDE.md invariant 2; design §5.2)
// ===========================================================================
describe('AC-4 — no unapproved integration, no managed queue (design §5.2)', () => {
  it('every dependency declared anywhere in the workspace is on the approved list', () => {
    const offenders: string[] = [];
    for (const dir of ALL_MEMBERS) {
      for (const dep of Object.keys(declaredDepsOf(dir))) {
        if (!APPROVED_DEPENDENCIES.has(dep)) offenders.push(`${dir}: ${dep}`);
      }
    }
    for (const dep of Object.keys({
      ...(rootPkg.dependencies ?? {}),
      ...(rootPkg.devDependencies ?? {}),
    })) {
      if (!APPROVED_DEPENDENCIES.has(dep)) offenders.push(`root: ${dep}`);
    }
    expect(offenders).toEqual([]);
  });

  it('exactly five packages were installed for Epic 2 — a sixth declared dep is a hard stop (§4.1)', () => {
    const declaredAcrossWorkspace = new Set(ALL_MEMBERS.flatMap((d) => Object.keys(declaredDepsOf(d))));
    expect([...declaredAcrossWorkspace].sort()).toEqual([
      '@aws-sdk/client-s3',
      '@types/pg',
      'fastify',
      'pg',
      'zod',
    ]);
  });

  const installed = new Set(
    Object.keys(lock.packages)
      .filter((k) => k.includes('node_modules/'))
      .map((k) => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length)),
  );

  it('no managed-queue client is present — the in-memory EventQueue stands this epic (AC-4)', () => {
    for (const q of [
      'kafkajs',
      'bullmq',
      'bull',
      'amqplib',
      'ioredis',
      'redis',
      '@aws-sdk/client-sqs',
      '@aws-sdk/client-sns',
      '@google-cloud/pubsub',
    ]) {
      expect(installed.has(q), `${q} is installed`).toBe(false);
    }
  });

  it('no ORM, query builder, or migration framework — plain .sql keeps tenancy + append-only readable (ADR-008, §5.6)', () => {
    for (const orm of [
      'prisma',
      '@prisma/client',
      'drizzle-orm',
      'knex',
      'sequelize',
      'typeorm',
      'mikro-orm',
      'kysely',
      'objection',
      'mongoose',
      'node-pg-migrate',
      'db-migrate',
      'umzug',
    ]) {
      expect(installed.has(orm), `${orm} is installed`).toBe(false);
    }
  });

  it('no auth SDK — specs/00 lists Auth0/Clerk/Cognito as unchosen alternates (§5.2)', () => {
    for (const auth of ['auth0', '@clerk/backend', '@clerk/clerk-sdk-node', 'amazon-cognito-identity-js']) {
      expect(installed.has(auth), `${auth} is installed`).toBe(false);
    }
  });

  it('no client for a MOCK-ONLY integration exists — their absence from the lockfile is the proof (§5.2)', () => {
    for (const vendor of ['kbb', 'manheim', 'carfax', 'autocheck', 'plaid', 'experian', 'transunion', 'equifax']) {
      expect(installed.has(vendor), `${vendor} is installed`).toBe(false);
    }
  });

  it('no mock-only vendor name appears in any workspace manifest', () => {
    const vendors = /\b(kbb|manheim|carfax|autocheck|plaid|experian|transunion|equifax|twilio|sendgrid|postmark)\b/i;
    for (const dir of ALL_MEMBERS) {
      expect(vendors.test(readText(dir, 'package.json')), `${dir}/package.json`).toBe(false);
    }
    expect(vendors.test(readText('package.json'))).toBe(false);
  });

  it('no audio/transcription/media dependency — the easiest path stays the compliant one (§5.12)', () => {
    for (const media of [
      '@aws-sdk/client-transcribe',
      '@google-cloud/speech',
      '@deepgram/sdk',
      'assemblyai',
      'fluent-ffmpeg',
      'ffmpeg-static',
      'whisper',
    ]) {
      expect(installed.has(media), `${media} is installed`).toBe(false);
    }
  });

  it('no TS runtime loader was pre-registered — D7 stays open and escalates to the lead (§4.6)', () => {
    for (const loader of ['tsx', 'ts-node', '@swc/register', 'esbuild-register', 'babel-register']) {
      expect(installed.has(loader), `${loader} is installed`).toBe(false);
    }
  });

  it('no dependency-resolution escape hatch was used to force the set through (§4.1 peer conflict)', () => {
    expect(rootPkg.overrides).toBeUndefined();
    expect(rootPkg.resolutions).toBeUndefined();
    if (existsSync(at('.npmrc'))) {
      expect(readText('.npmrc')).not.toMatch(/legacy-peer-deps|force\s*=\s*true/);
    }
  });
});

// ===========================================================================
// AC-5 — package-lock.json is the single, deterministic root artifact
// ===========================================================================
describe('AC-5 — lockfile is a root artifact, pinned and deterministic (ADR-004 §2)', () => {
  it('lockfileVersion 3', () => {
    expect(lock.lockfileVersion).toBe(3);
  });

  it('each installed Epic-2 library is pinned by resolved URL + integrity hash', () => {
    for (const name of ['pg', '@types/pg', '@aws-sdk/client-s3', 'fastify', 'zod']) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, name).toBeDefined();
      expect(typeof entry.resolved, `${name}.resolved`).toBe('string');
      expect(typeof entry.integrity, `${name}.integrity`).toBe('string');
    }
  });

  it('no member carries its own lockfile — there is exactly one, at the root', () => {
    for (const dir of ALL_MEMBERS) {
      expect(existsSync(at(dir, 'package-lock.json')), `${dir}/package-lock.json`).toBe(false);
      expect(existsSync(at(dir, 'node_modules')), `${dir}/node_modules`).toBe(false);
    }
  });

  it('the lockfile root entry mirrors root package.json exactly', () => {
    expect(lock.packages[''].workspaces).toEqual(rootPkg.workspaces);
    expect(lock.packages[''].devDependencies).toEqual(rootPkg.devDependencies);
  });
});

// ===========================================================================
// AC-6 / AC-7 — root scripts cover the four members; the repo stays green empty
// ===========================================================================
describe('AC-6 — root typecheck and test scripts cover the new members (design §3.1, D5)', () => {
  const typecheck: string = rootPkg.scripts.typecheck;
  const projects = [...typecheck.matchAll(/tsc\s+-p\s+(\S+)/g)].map((m) => m[1]);

  it('the explicit tsc chain names exactly the nine members that have sources', () => {
    expect(projects).toEqual(SOURCE_MEMBERS_IN_TYPECHECK_CHAIN);
  });

  it('the four EMPTY members are NOT in the explicit chain — tsc exits 2 with TS18003 on them (§4.2, D5)', () => {
    for (const { dir } of NEW_MEMBERS) {
      expect(projects, `${dir} would break AC-7 while empty`).not.toContain(dir);
    }
  });

  it('the chain ends with the member-agnostic half, so coverage becomes automatic (D5)', () => {
    expect(typecheck.trim().endsWith('npm run typecheck --workspaces --if-present')).toBe(true);
  });

  it('if a new member has added its own typecheck script, it is the ADR-009 §2 line verbatim', () => {
    for (const { dir } of NEW_MEMBERS) {
      const scripts = readJson(dir, 'package.json').scripts;
      if (scripts?.typecheck !== undefined) {
        expect(scripts.typecheck, dir).toBe('tsc -p . --noEmit');
      }
    }
  });

  it('the root test script is unchanged and the vitest globs already reach the new members', () => {
    expect(rootPkg.scripts.test).toBe('vitest run');
    for (const glob of [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'services/**/src/**/*.test.ts',
      'services/**/test/**/*.test.ts',
    ]) {
      expect(vitestWorkspaceText).toContain(glob);
    }
  });
});

// ===========================================================================
// §1.2 — manifests only: no src/, test/, or migrations/ from this task
// ===========================================================================
describe('§1.2 — the four members hold manifests and nothing else', () => {
  it.each(NEW_MEMBERS)('$dir contains exactly package.json + tsconfig.json', ({ dir }) => {
    const entries = readdirSync(at(dir)).sort();
    expect(entries).toEqual(['package.json', 'tsconfig.json']);
  });

  it.each(NEW_MEMBERS)('$dir has no src/, test/, migrations/, or .gitkeep placeholder', ({ dir }) => {
    for (const sub of ['src', 'test', 'migrations', '.gitkeep']) {
      expect(existsSync(at(dir, sub)), `${dir}/${sub} belongs to a later task`).toBe(false);
    }
  });
});

// ===========================================================================
// §3.4 / §5.7 — one shared toolchain, no local escape hatches
// ===========================================================================
describe('§3.4 — every new tsconfig is the house shape (ADR-001 one toolchain)', () => {
  it.each(NEW_MEMBERS)('$dir/tsconfig.json extends the base with include only', ({ dir }) => {
    const cfg = readJson(dir, 'tsconfig.json');
    expect(cfg.extends).toBe('../../tsconfig.base.json');
    expect(cfg.include).toEqual(['src', 'test']);
    expect(cfg.compilerOptions, `${dir} overrides the shared toolchain`).toBeUndefined();
    expect(cfg.references).toBeUndefined();
  });

  it.each(NEW_MEMBERS)('$dir extends target actually resolves — a bad path is TS5083 (§4.2)', ({ dir }) => {
    const cfg = readJson(dir, 'tsconfig.json');
    expect(existsSync(resolve(at(dir), cfg.extends)), `${dir} -> ${cfg.extends}`).toBe(true);
  });

  it('the shared strictness the base fixes is intact', () => {
    const co = tsBase.compilerOptions;
    expect(co.strict).toBe(true);
    expect(co.noUncheckedIndexedAccess).toBe(true);
    expect(co.exactOptionalPropertyTypes).toBe(true);
    expect(co.noEmit).toBe(true);
    expect(co.types).toEqual([]);
  });

  it.each(NEW_MEMBERS)(
    '$dir hand-writes no node shim — @types/node is transitive and would collide (§5.7)',
    ({ dir }) => {
      const shim = readdirSync(at(dir)).filter((f) => f.endsWith('.d.ts'));
      expect(shim, `${dir} declares ambient types locally`).toEqual([]);
    },
  );
});

// ===========================================================================
// §4.5 — the CJS/ESM interop hazard the pg choice imposes (runtime, not typecheck)
// ===========================================================================
describe('§4.5 — pg is CommonJS under a "type": "module" root', () => {
  it('the hazard is real: root is ESM and the installed pg ships no "type": "module"', () => {
    expect(rootPkg.type).toBe('module');
    const pgPkg = JSON.parse(readFileSync(at('node_modules/pg/package.json'), 'utf8'));
    expect(pgPkg.type).not.toBe('module');
  });

  it('no owned source uses the named-VALUE import form for pg (guard for T-016/T-017)', () => {
    const offenders: string[] = [];
    for (const dir of ['packages/db', 'packages/store-pg']) {
      for (const file of tsFilesUnder(at(dir))) {
        const text = readFileSync(file, 'utf8');
        // `import type { Pool } from 'pg'` is fine; `import { Pool } from 'pg'` is the trap.
        if (/(^|\n)\s*import\s+(?!type\b)\{[^}]*\}\s*from\s*['"]pg['"]/.test(text)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// §5.8 / §5.2 — kit mandates this task's dependency set has to keep possible
// ===========================================================================
describe('kit mandates the baseline must not make un-implementable', () => {
  const epic2Sources = [...NEW_MEMBERS.map((m) => at(m.dir))].flatMap((d) => tsFilesUnder(d));

  it('no zod schema turns an absent money field into zero — ADR-005: missing is UNEVALUABLE (§5.8)', () => {
    const zeroDefault = /\.(default|catch)\s*\(\s*0\s*\)/;
    const offenders = epic2Sources.filter((f) => zeroDefault.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no Epic-2 package re-declares a spine or port type — it imports from @core/@comms (§2.2 rules 1-2)', () => {
    const redeclare =
      /\b(?:interface|type|class|enum)\s+(Deal|DealerThread|Message|Offer|VehicleTarget|VehicleInstance|Dealership|DealershipContact|ValuationSnapshot|VehicleData|CommsStore|RawPayloadStore|EventQueue|StoredMessage)\b/;
    const offenders = epic2Sources.filter((f) => redeclare.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no receipt update/delete surface exists in any Epic-2 package (append-only, I-8)', () => {
    const mutator = /\b(?:update|delete|remove|purge|redact|overwrite)(?:Receipt|Message|Thread|Deal|Offer)\w*\s*\(/i;
    const offenders = epic2Sources.filter((f) => mutator.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no credential value and no .env file entered the repo (§3.5, CLAUDE.md approved integrations)', () => {
    // Scan for *any* dotenv-shaped file rather than a fixed list of four names:
    // .env.staging, .env.ci, .env.local.bak and friends carry credentials just as
    // well, and a name-list guard waves them through. (.env.example / .env.sample
    // are templates by convention and carry no value, but the secret-assignment
    // scan below still reads them.)
    const secretAssignment = /(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|DATABASE_URL)\s*=\s*['"]?\S+/;
    const dotenvShaped = (d: string) =>
      (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : [])
        .filter((e) => e.isFile() && /^\.env(?:$|\.)/.test(e.name))
        .map((e) => e.name);

    for (const dir of ['.', ...NEW_MEMBERS.map((m) => m.dir)]) {
      const present = dotenvShaped(at(dir));
      const disallowed = present.filter((n) => !/^\.env\.(example|sample|template)$/.test(n));
      expect(disallowed, `${dir} must hold no .env file`).toEqual([]);
      for (const name of present) {
        expect(secretAssignment.test(readText(dir, name)), `${dir}/${name}`).toBe(false);
      }
    }
    for (const dir of ALL_MEMBERS) {
      expect(secretAssignment.test(readText(dir, 'package.json')), dir).toBe(false);
    }
    expect(secretAssignment.test(readText('package.json'))).toBe(false);
  });
});

// ===========================================================================
// ADR-008 — DB-dependent tests SKIP when DATABASE_URL is unset. Never a fake pass.
// ===========================================================================
describe('ADR-008 — the Postgres path is exercised only when DATABASE_URL is set', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  it.skipIf(!hasDb)(
    'pg connects to DATABASE_URL and the ESM default-import form works at runtime (§4.5)',
    async () => {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
      });
      try {
        const res = await pool.query('select 1 as one');
        expect(res.rows[0].one).toBe(1);
      } finally {
        await pool.end();
      }
    },
    20_000,
  );

  it('the only load of pg in this suite is inside the DATABASE_URL-guarded case, and nothing fakes it', () => {
    // ADR-008 says a DB-dependent case is SKIPPED when DATABASE_URL is unset —
    // never reported as passed. The skip itself is carried by `it.skipIf(!hasDb)`
    // above; what this case proves is the honesty half of that rule, which the
    // skip alone cannot: that the default (no-DATABASE_URL) path neither opens a
    // connection nor substitutes a fake one for it. So it reads this file's own
    // source and asserts structurally where pg may be loaded.
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');

    // 1. No module-scope import of pg: a static import would load the driver on
    //    every run, including the skipped one.
    expect(/^\s*import\b[^\n]*\bfrom\s*['"]pg['"]/m.test(selfSource), 'static pg import').toBe(
      false,
    );

    // 2. No test double stands in for a real connection — a mocked pg would let a
    //    "DB test" go green with no database behind it, the exact failure ADR-008
    //    forbids.
    expect(/\bvi\s*\.\s*mock\s*\(\s*['"]pg['"]/.test(selfSource), 'mocked pg').toBe(false);

    // 3. Every dynamic load of pg sits inside the guarded case — i.e. between
    //    `it.skipIf(!hasDb)(` and the start of the next case.
    const guardStart = selfSource.indexOf('it.skipIf(!hasDb)(');
    expect(guardStart, 'the DATABASE_URL guard must exist').toBeGreaterThan(-1);
    const guardEnd = selfSource.indexOf('\n  it(', guardStart);
    expect(guardEnd, 'the guarded case must be closed by a following case').toBeGreaterThan(
      guardStart,
    );

    const loads = [
      ...selfSource.matchAll(/(?:\bimport|\brequire)\s*\(\s*['"]pg['"]\s*\)/g),
    ].map((m) => m.index ?? -1);
    expect(loads.length, 'the guarded case must actually load pg').toBe(1);
    for (const i of loads) {
      expect(i > guardStart && i < guardEnd, `pg loaded outside the guard at offset ${i}`).toBe(
        true,
      );
    }

    // 4. And the guarded case is the only place a Pool is constructed.
    const pools = [...selfSource.matchAll(/new\s+pg\s*\.\s*Pool\s*\(/g)].map((m) => m.index ?? -1);
    expect(pools.length).toBe(1);
    expect(pools[0] > guardStart && pools[0] < guardEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}
