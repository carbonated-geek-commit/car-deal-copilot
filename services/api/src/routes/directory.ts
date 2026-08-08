/**
 * The GLOBAL dealership directory (docs/design/T-020.md §2.2, D2, D15;
 * specs/00-shared-core-architecture.md "Dealership data tenancy"; Q12 AMENDED).
 *
 * specs/00: "Dealership names and locations are global; the people are
 * private." `@core.Dealership` already carries no account field and no
 * `staff[]`; this port keeps the other half of the rule structural —
 * **no method here takes an account**, so an account-scoped dealership read is
 * not merely forbidden, it is inexpressible. The private half
 * (`DealershipContact`) has no home on this port at all: it exists only as
 * `DealerThread.working_with`, reachable only through a `DealHandle` the gate
 * minted.
 *
 * D15 — create-or-find only. There is no update and no delete. The global table
 * is writable by every account, so an update path would be a cross-account
 * mutation surface: one account renaming a row another account's deals depend
 * on. Find-or-create by the natural key is additive and therefore safe.
 *
 * D2 — ids are DETERMINISTIC. `dealershipId` is a pure function of the natural
 * key `packages/db/migrations/0004_dealerships_global.sql` makes unique
 * (`lower(name)`, `upper(state)`, `lower(city)`, `zip_code`), so two accounts
 * entering the same real dealership converge on one global row without any
 * coordination — which is the entire point of a shared directory. No
 * `node:crypto` is imported and nothing is random: a replayed request produces
 * a byte-identical id.
 *
 * §8.4 — this in-memory implementation is correct for the ADR-008 DEFAULT
 * posture and is a known gap in Postgres mode: `@comms`'s `CommsStore` has no
 * dealership method and `@store-pg` never writes `dealerships`, so no durable
 * implementation of this port exists yet. Nothing outside this module assumes
 * the id FORMAT, so a later task can back the same port with Postgres and store
 * the slug as an `external_id` beside `0004`'s uuid primary key.
 */

import type { Dealership } from '@core';

/** The natural key migration `0004` makes unique. Global — there is no account here. */
export interface DealershipNaturalKey {
  readonly name: string;
  readonly state: string;
  readonly city: string;
  readonly zip_code: string;
}

/**
 * The outcome of a find-or-create.
 *
 * DEVIATION from design §2.2, recorded in place: the design declared
 * `Promise<{ dealership; created }>`, which cannot express the
 * `dealership_id_collision` row the same design's §4.2 error table requires —
 * two distinct natural keys whose slug AND 32-bit hash both coincide. House
 * style is failures-as-values, so a third member was added rather than throwing
 * or silently overwriting a foreign row. No other field or call site moves.
 */
export type DirectoryEnsure =
  | { readonly outcome: 'created'; readonly dealership: Dealership }
  | { readonly outcome: 'found'; readonly dealership: Dealership }
  /** The minted id is already held by a DIFFERENT natural key. Never overwritten. */
  | { readonly outcome: 'id_collision' };

export interface DealershipSearchPage {
  readonly items: readonly Dealership[];
  readonly next_cursor?: string;
}

export interface DealershipDirectory {
  get(dealership_id: string): Promise<Dealership | undefined>;
  /** Find-or-create by the natural key. NEVER updates an existing row (D15). */
  ensure(key: DealershipNaturalKey): Promise<DirectoryEnsure>;
  /** Prefix search over name, bounded by the caller's limit. Global read. */
  search(q: string | undefined, limit: number, cursor?: string): Promise<DealershipSearchPage>;
}

// ---- deterministic identity (D2) ----------------------------------------

/**
 * FNV-1a, 32-bit. Chosen because it is four lines of integer arithmetic with no
 * import: T-019's static-invariant suite pins the import allowlist for
 * `services/api/src/**` and `node:crypto` is not on it, so `randomUUID` and
 * `createHash` are both unavailable without editing a foreign test. This is not
 * a security primitive and is not used as one — it is a collision-resistant
 * suffix that keeps two different dealerships with the same slug apart, and the
 * one case where it fails is reported as `id_collision` rather than absorbed.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The canonical form of migration `0004`'s uniqueness tuple. */
export function canonicalNaturalKey(key: DealershipNaturalKey): string {
  return [
    key.name.trim().toLowerCase(),
    key.state.trim().toUpperCase(),
    key.city.trim().toLowerCase(),
    key.zip_code.trim(),
  ].join('|');
}

const SLUG_MAX = 40;

function slugFor(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/u, '');
}

/**
 * D2 — `dl-<slug>-<fnv1a32>`. Matches T-019's `opaqueId` charset by
 * construction, so a minted id is always a legal path parameter on the very
 * routes that read it back.
 */
export function dealershipId(key: DealershipNaturalKey): string {
  const slug = slugFor(key.name);
  const digest = fnv1a32(canonicalNaturalKey(key));
  return slug === '' ? `dl-${digest}` : `dl-${slug}-${digest}`;
}

// ---- the ADR-008 default implementation ---------------------------------

/**
 * In-memory directory. Two indexes over the same rows: by id (the read path)
 * and by canonical natural key (the find-or-create path). Rows are frozen
 * copies, so no caller holds a mutable reference into the global table.
 */
export function createInMemoryDealershipDirectory(seed: readonly Dealership[] = []): DealershipDirectory {
  const by_id = new Map<string, Dealership>();
  const by_key = new Map<string, string>();

  const remember = (dealership: Dealership): Dealership => {
    const stored: Dealership = Object.freeze({ ...dealership });
    by_id.set(stored.id, stored);
    by_key.set(canonicalNaturalKey(stored), stored.id);
    return stored;
  };

  for (const dealership of seed) remember(dealership);

  return {
    get(dealership_id: string): Promise<Dealership | undefined> {
      return Promise.resolve(by_id.get(dealership_id));
    },

    ensure(key: DealershipNaturalKey): Promise<DirectoryEnsure> {
      const canonical = canonicalNaturalKey(key);
      const existing_id = by_key.get(canonical);
      if (existing_id !== undefined) {
        const found = by_id.get(existing_id);
        // The two indexes are written together, so this is unreachable; it is
        // an honest `undefined` rather than a non-null assertion.
        if (found !== undefined) return Promise.resolve({ outcome: 'found', dealership: found });
      }

      const id = dealershipId(key);
      const held = by_id.get(id);
      if (held !== undefined) return Promise.resolve({ outcome: 'id_collision' });

      const created = remember({
        id,
        name: key.name.trim(),
        state: key.state.trim().toUpperCase(),
        city: key.city.trim(),
        zip_code: key.zip_code.trim(),
      });
      return Promise.resolve({ outcome: 'created', dealership: created });
    },

    search(q: string | undefined, limit: number, cursor?: string): Promise<DealershipSearchPage> {
      const needle = q === undefined ? undefined : q.trim().toLowerCase();
      const matched = [...by_id.values()]
        .filter((row) => needle === undefined || row.name.trim().toLowerCase().startsWith(needle))
        .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)));

      const start = cursor === undefined ? 0 : matched.findIndex((row) => row.id === cursor) + 1;
      const page = matched.slice(start, start + limit);
      const next = matched.length > start + limit ? page[page.length - 1]?.id : undefined;
      return Promise.resolve({ items: page, ...(next !== undefined && { next_cursor: next }) });
    },
  };
}
