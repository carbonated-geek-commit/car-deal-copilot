# ADR-007: `above_market` measures against the **retail** valuation band

- **Date:** 2026-08-07
- **Author:** chief-architect (session role), on Corban's explicit instruction ("ADR as retail")
- **Status:** accepted

## Decision
The `above_market` flag compares an offer's price against the `ValuationSnapshot.retail` band for that specific `VehicleInstance`. Retail is the reference because it is what a dealership legitimately sells that car for — the buyer's honest question is "is this dealer asking more than this car retails for?", not "am I paying more than the dealer paid?".

## Spec basis
`specs/00-shared-core-architecture.md` → "Budget ceiling vs. fair price" (fair price is judged per instance against that car's own `ValuationSnapshot`) and "Flag engine" (`above_market`). The band was left uncalibrated; gate verdict 2026-08-07-4 finding 20b named it as needing an ADR.

## Alternatives considered
- **Wholesale / Manheim MMR** — what the dealer likely paid. Flags nearly every legitimate transaction, since dealers must sell above wholesale to exist; would cry wolf and train buyers to ignore the flag.
- **Trade-in** — even lower than retail; same false-positive problem.
- **Private-party** — the right comparison for a private sale, not a dealership one; would systematically flag dealer offers that carry legitimate reconditioning and warranty value.

## Consequences
- `FlagContext` gains the instance's retail value; `above_market` fires when the offer's price exceeds it (tolerance is a config threshold, like the other flags — not hard-coded).
- Absent a `ValuationSnapshot`, `above_market` is **unevaluable**, never "not triggered" (ADR-005 semantics).
- The wholesale/trade-in spread stays available for the war room's *informational* spread view — it simply isn't the flag's trigger.
- Revisiting the band requires a superseding ADR.
