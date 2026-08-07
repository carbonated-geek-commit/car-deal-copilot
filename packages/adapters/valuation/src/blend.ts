/**
 * The blend step (specs/00 "Valuation": "Blend into wholesale vs trade-in vs
 * retail.").
 *
 * Two pieces (docs/design/T-003.md D1, §4.3):
 * - `blendSnapshots` — a pure merge over per-source `ValuationSnapshot`s.
 * - `createBlendedValuationAdapter` — a composite that IS a `ValuationAdapter`,
 *   so callers see exactly one shape whether they talk to a single source or
 *   the blend (anti-corruption rule stays airtight).
 */

import type {
  AdapterError,
  AdapterResult,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
} from '@core';

/** Blend provenance: 'blend(' + contributing sources joined by '+' + ')' — e.g. "blend(mock-kbb+mock-manheim)". */
export const BLEND_SOURCE_PREFIX = 'blend(';

const VALUE_FIELDS = ['wholesale', 'trade_in', 'retail', 'private_party'] as const;

function blendSource(sources: readonly string[]): string {
  return `${BLEND_SOURCE_PREFIX}${sources.join('+')})`;
}

/**
 * Pure merge (no I/O): combines per-source snapshots into the spec's
 * wholesale vs trade-in vs retail view.
 *
 * Rules (docs/design/T-003.md D2, D3, §4.3):
 * - Each `values` field is taken from the snapshot that supplies it; if more
 *   than one snapshot supplies the same field (mis-wired roles), the most
 *   recent `fetched_at` wins (ties: earliest in the input order) — deterministic.
 * - `fetched_at` = OLDEST contributing `fetched_at` (D3): the blend is only as
 *   fresh as its stalest input, keeping caller-side cache logic conservative.
 * - `source` = 'blend(' + contributing sources in input order joined '+' + ')'.
 * - `vehicle` / `mileage` are taken from the first snapshot; the composite
 *   adapter overrides them with an echo of the request.
 *
 * Non-empty tuple type: blending zero snapshots is a compile-time error, so no
 * runtime failure path exists (§4.2).
 */
export function blendSnapshots(
  snapshots: readonly [ValuationSnapshot, ...ValuationSnapshot[]],
): ValuationSnapshot {
  const values: ValuationSnapshot['values'] = {};
  for (const field of VALUE_FIELDS) {
    let winner: ValuationSnapshot | undefined;
    for (const snap of snapshots) {
      if (snap.values[field] === undefined) continue;
      if (winner === undefined || Date.parse(snap.fetched_at) > Date.parse(winner.fetched_at)) {
        winner = snap;
      }
    }
    const v = winner?.values[field];
    if (v !== undefined) values[field] = v;
  }

  let oldest: ValuationSnapshot = snapshots[0];
  for (const snap of snapshots) {
    if (Date.parse(snap.fetched_at) < Date.parse(oldest.fetched_at)) oldest = snap;
  }

  const first = snapshots[0];
  return {
    vehicle: first.vehicle,
    values,
    source: blendSource(snapshots.map((s) => s.source)),
    fetched_at: oldest.fetched_at,
    ...(first.mileage !== undefined ? { mileage: first.mileage } : {}),
  };
}

/** Sources feeding the composite. Roles, not providers — anti-corruption holds. */
export interface BlendedValuationSources {
  /** KBB-mock in Epic 1; any ValuationAdapter later. */
  retail_trade_in: ValuationAdapter;
  /** Manheim-mock in Epic 1. */
  wholesale: ValuationAdapter;
  /** Deliberately open third slot (specs/00 Valuation row 3). NOT implemented in Epic 1 (D9). */
  private_party?: ValuationAdapter;
}

/**
 * Composite ValuationAdapter (D1): fans getValuation out to each wired source
 * concurrently, blends per §4.3, returns one AdapterResult<ValuationSnapshot>.
 *
 * Outcomes (docs/design/T-003.md §4.3):
 * - All ok → blended snapshot; `source` names every contributor.
 * - Some fail, ≥1 ok → `ok` PARTIAL snapshot (D2): only surviving sources'
 *   fields present; `source` names contributors only, so provenance doubles as
 *   the degradation signal.
 * - All fail → one AdapterError: a retryable error wins over a terminal one;
 *   among equals the retail_trade_in-role error wins (wired-role order —
 *   deterministic). `source` = the blend id; `message` names contributor codes
 *   only (log-safe); `retryable` = OR of contributors.
 */
export function createBlendedValuationAdapter(
  sources: BlendedValuationSources,
): ValuationAdapter {
  // Wired-role order is fixed: retail_trade_in, wholesale, private_party.
  const wired: readonly { role: string; adapter: ValuationAdapter }[] = [
    { role: 'retail_trade_in', adapter: sources.retail_trade_in },
    { role: 'wholesale', adapter: sources.wholesale },
    ...(sources.private_party !== undefined
      ? [{ role: 'private_party', adapter: sources.private_party }]
      : []),
  ];
  const blendId = blendSource(wired.map((w) => w.adapter.source));

  return {
    source: blendId,
    async getValuation(
      req: ValuationRequest,
    ): Promise<AdapterResult<ValuationSnapshot>> {
      const results = await Promise.all(wired.map((w) => w.adapter.getValuation(req)));

      const survivors: ValuationSnapshot[] = [];
      const failures: { role: string; error: AdapterError }[] = [];
      results.forEach((res, i) => {
        const entry = wired[i];
        if (entry === undefined) return; // unreachable; satisfies noUncheckedIndexedAccess
        if (res.ok) survivors.push(res.value);
        else failures.push({ role: entry.role, error: res.error });
      });

      if (survivors.length === 0) {
        // All wired sources failed → single error (§4.3, precedence rule).
        let chosen = failures[0] as { role: string; error: AdapterError };
        for (const f of failures) {
          if (f.error.retryable && !chosen.error.retryable) chosen = f;
        }
        return {
          ok: false,
          error: {
            code: chosen.error.code,
            retryable: failures.some((f) => f.error.retryable),
            source: blendId,
            message: `all valuation sources failed: ${failures
              .map((f) => `${f.role}=${f.error.code}`)
              .join(', ')}`,
          },
        };
      }

      const [head, ...rest] = survivors as [ValuationSnapshot, ...ValuationSnapshot[]];
      const blended = blendSnapshots([head, ...rest]);

      // vehicle/mileage echoed from the request (§4.3).
      const snapshot: ValuationSnapshot = {
        vehicle: req.vehicle,
        values: blended.values,
        source: blended.source,
        fetched_at: blended.fetched_at,
        ...(req.mileage !== undefined ? { mileage: req.mileage } : {}),
      };
      return { ok: true, value: snapshot };
    },
  };
}
