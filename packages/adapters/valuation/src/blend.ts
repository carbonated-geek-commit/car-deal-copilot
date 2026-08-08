/**
 * The blend step (specs/00 "Valuation": "Blend into wholesale vs trade-in vs
 * retail. Snapshot + cache."), rebound to the v0.5 spine (T-013 §2.3, §3.4).
 *
 * Two pieces:
 * - `blendSnapshots` — a pure merge over per-source `ValuationSnapshot`s.
 * - `createBlendedValuationAdapter` — a composite that IS a `ValuationAdapter`,
 *   so callers see exactly one shape whether they talk to a single source or
 *   the blend (anti-corruption rule stays airtight).
 *
 * A `ValuationSnapshot` is ALWAYS of one specific car, so the blend is too: a
 * contributing snapshot naming a different `vehicle_instance_id` is DISCARDED
 * rather than averaged in (D6). Averaging two cars would produce a snapshot of
 * nothing, which is exactly the incomparability the one-vehicle rule exists to
 * prevent — and it would let another car's `retail` become this car's
 * `above_market` basis (ADR-007).
 */

import type {
  AdapterError,
  AdapterResult,
  MoneyCents,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
} from '@core';

/** Blend provenance: 'blend(' + contributing sources joined by '+' + ')' — e.g. "blend(mock-kbb+mock-manheim)". */
export const BLEND_SOURCE_PREFIX = 'blend(';

/** The flat spine bands, in the spec's own order. */
const BAND_FIELDS = ['wholesale', 'trade_in', 'retail', 'private_party'] as const;

type BandField = (typeof BAND_FIELDS)[number];

function blendSource(sources: readonly string[]): string {
  return `${BLEND_SOURCE_PREFIX}${sources.join('+')})`;
}

/**
 * Pure merge (no I/O), total. Blending zero snapshots is a COMPILE error
 * (non-empty tuple), so no empty-input runtime path exists.
 *
 * Rules (T-013 §2.3):
 * - `vehicle_instance_id` = `snapshots[0].vehicle_instance_id`. Any snapshot
 *   naming a different instance is DISCARDED before merging (D6) and is absent
 *   from `source`. The head always survives, so a non-empty input always yields
 *   a result.
 * - Each band is taken from the surviving snapshot that supplies it; if more
 *   than one does, the newest `captured_at` wins (ties: earliest input order).
 * - `captured_at` = OLDEST surviving `captured_at`: the blend is only as fresh
 *   as its stalest input, keeping caller-side cache logic conservative.
 * - `source` = 'blend(' + surviving sources in input order joined '+' + ')'.
 * - A band no survivor supplies is ABSENT, never zero (ADR-005).
 */
export function blendSnapshots(
  snapshots: readonly [ValuationSnapshot, ...ValuationSnapshot[]],
): ValuationSnapshot {
  const head = snapshots[0];
  const instanceId = head.vehicle_instance_id;
  // D6: a blend is always of one specific car. The head is its own match, so
  // `survivors` is never empty.
  const survivors = snapshots.filter((s) => s.vehicle_instance_id === instanceId);

  const bands: Partial<Record<BandField, MoneyCents>> = {};
  for (const field of BAND_FIELDS) {
    let winner: ValuationSnapshot | undefined;
    for (const snap of survivors) {
      if (snap[field] === undefined) continue;
      if (
        winner === undefined ||
        Date.parse(snap.captured_at) > Date.parse(winner.captured_at)
      ) {
        winner = snap;
      }
    }
    const v = winner?.[field];
    if (v !== undefined) bands[field] = v;
  }

  let oldest: ValuationSnapshot = head;
  for (const snap of survivors) {
    if (Date.parse(snap.captured_at) < Date.parse(oldest.captured_at)) oldest = snap;
  }

  return {
    vehicle_instance_id: instanceId,
    ...bands,
    source: blendSource(survivors.map((s) => s.source)),
    captured_at: oldest.captured_at,
  };
}

/** Sources feeding the composite. Roles, not providers — anti-corruption holds at the composite too. */
export interface BlendedValuationSources {
  /**
   * KBB-mock today: retail, trade-in, and (Q15) private-party bands.
   * Deliberately NOT renamed — the field names the specs/00 "Valuation" table
   * row it wires, and a rename would churn every composition root for no gain.
   */
  retail_trade_in: ValuationAdapter;
  /** Manheim-mock today: wholesale. */
  wholesale: ValuationAdapter;
  /**
   * Deliberately DECLARED BUT UNWIRED (D5). Q15 RESOLVED admits no comps or
   * marketplace source — Meta publishes no API and scraping violates their
   * terms, and buyer-entered comps are user data rather than an external feed,
   * so they have no home in the anti-corruption layer at all. A licensed
   * aggregator is a future option; nothing in this repo may fill this slot
   * without a new ADR.
   */
  private_party?: ValuationAdapter;
}

/**
 * Composite `ValuationAdapter`: fans `getValuation` out to each wired source
 * concurrently, blends per §3.4, returns one `AdapterResult<ValuationSnapshot>`.
 *
 * Outcomes (T-013 §7.2):
 * - All ok → blended snapshot; `source` names every contributor.
 * - Some fail, ≥1 ok → `ok` PARTIAL snapshot: only surviving sources' bands are
 *   present. Missing bands are ABSENT, never zero (ADR-005); `source` names
 *   contributors only, so provenance doubles as the degradation signal and no
 *   side channel is needed.
 * - All fail → one `AdapterError`: a retryable contributor's code wins over a
 *   terminal one; among equals the wired-role order decides (deterministic).
 *   `source` = the blend id; `message` names contributor codes only (log-safe);
 *   `retryable` = OR over contributors.
 *
 * Stateless: no internal retry, no caching. "Snapshot + cache" is caller-side
 * (the store layer), so repeated calls are idempotent.
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
        // All wired sources failed → single error (§7.2, precedence rule).
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

      const [first, ...rest] = survivors as [ValuationSnapshot, ...ValuationSnapshot[]];
      const blended = blendSnapshots([first, ...rest]);

      // The composite stamps the requested instance — authoritative, because
      // every contributor was asked about that same car (§3.4).
      return {
        ok: true,
        value: { ...blended, vehicle_instance_id: req.instance.id },
      };
    },
  };
}
