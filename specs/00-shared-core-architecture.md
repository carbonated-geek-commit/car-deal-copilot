# Shared Core — Architecture Spine (v0.5)

*The common spine underneath both products. The [Consumer Spec](./01-consumer-product-spec.md) and the [B2B Spec](./02-b2b-product-spec.md) reference this doc and diverge from it — they never redefine what's here. If a model or service is in this file, it is the single source of truth for both.*

---

## What is genuinely shared

Two different businesses, one spine. The insight that makes this work: **the `DealerThread` / `Message` model does not care whether the phone number underneath was provisioned by us or connected by the user.** Aggregation is identical either way. So everything up to and including aggregation is shared; only *identity provisioning, billing, and liability posture* diverge into the product specs.

| Layer | Shared? | Where it diverges |
|-------|---------|-------------------|
| Domain model (`Deal`, `DealerThread`, `Message`, `Offer`) | **Shared** | — |
| Comms **aggregation** (threading, capture, extraction) | **Shared** | — |
| Comms **identity provisioning** (who owns the number/alias) | ✗ | Consumer: we provide · B2B: they bring |
| Valuation / Vehicle-data / Receipt | **Shared** | Emphasis differs, model doesn't |
| Flag engine | **Shared** | Consumer leans on it harder |
| Anti-corruption / adapter layer | **Shared** | B2B points adapters *inbound* (connectors) |
| Billing | ✗ | Consumer: per-deal · B2B: subscription |
| Account model | ✗ | Consumer: account holds paid deals · B2B: org + seats |
| Liability / sender-of-record | ✗ | Consumer: us · B2B: them |

---

## Core domain model

`Deal` is the aggregate root in both products.

```
Deal
├── id, owner_id            (owner = User in consumer, Org/Seat in B2B)
├── path                    (online | hybrid | in_person)   ← consumer-driven; B2B may ignore
├── status                  (draft | active | negotiating | closed | burned)
├── target_vehicle          (VehicleTarget — make + model; IMMUTABLE once any offer attaches)
├── budget, walk_away_number
├── identity_ref            (→ provider-agnostic; see Comms below)
├── dealer_threads[]        (MANY dealerships, each offering its own specific car)
├── offers[]                (flattened offer history across threads)
├── receipt_bundle_id
└── created_at, burned_at

VehicleTarget               (what the buyer is shopping — the deal's comparison anchor)
├── make, model             ← immutable after first offer; changing these = a NEW Deal
└── year_range?             (optional span; see "year drift" below)

VehicleInstance             (the SPECIFIC car one dealership is offering — varies per thread)
├── vin?                    (user-entered, for the buyer's record; no lookup at launch)
├── year
├── trim?                   (trim may differ freely between dealerships)
├── mileage?                (odometer; absent for new)
├── condition               (new | used | certified)
└── additions[]             (options, packages, dealer add-ons, accessories)

Dealership                  (GLOBAL — one shared record, referenced by any account's deals)
├── id, name
└── state, city, zip_code

DealershipContact           (PRIVATE to the account — never global, never shared)
├── name, role              (general_manager | sales_manager | finance_manager | sales_agent)
└── phone?, email?

DealerThread                (the per-deal relationship with ONE dealership)
├── dealership_id           (→ Dealership, global)
├── vehicle_instance        (→ VehicleInstance — this dealership's specific car)
├── working_with            (→ DealershipContact, private to the account)
├── process_step            (information_gather | deal_negotiation | deal_approval
│                            | financing | final_sale | pickup)
├── messages[]
└── current_offer

Message                     (ratified by Corban 2026-08-07)
├── channel   (call | sms | email | note)
├── direction (in | out | internal)     internal = the buyer's/operator's own record
├── author    (dealer | buyer | concierge)   who produced this text — never inferred
├── body      (text; verbatim for sms/email, authored for note)
├── call_meta?                          (started_at, duration, party) when channel = call
├── timestamp
└── extracted_offer?

Offer
├── sale_price?             (absent = the dealer stated no price — ADR-005)
├── fees[], apr?, term_months?, monthly?
└── flags[]   (payment_packing | rate_markup | junk_fee | over_walkaway | above_market)
               ADR-002 fixes `payment_packing` as canonical.
               `above_market` = priced above THIS car's own valuation (per-instance).

ValuationSnapshot           (ALWAYS of one specific car — never of a bare make/model)
├── vehicle_instance_id     (→ VehicleInstance)
├── wholesale, trade_in, retail, private_party
└── source, captured_at

VehicleData                 (decode, recalls, history for one specific car)
├── vehicle_instance_id     (→ VehicleInstance)
├── recalls[], history?, reliability?
└── captured_at
```

### Cardinality invariants (structurally enforced)

**One deal, one make/model — always.** A deal is anchored to a single `make` + `model`. That anchor is what the whole product rests on.

**Why — the load-bearing reason:** *one vehicle per deal is the only way to honestly tell a customer whether they are getting a good deal.* Valuation, walk-away, and every flag are comparisons against a known thing. Let a deal span two different vehicles and there is no longer anything to compare against — "is this a good price?" stops having an answer, and the product's central promise quietly becomes unanswerable. The constraint exists to protect the honesty of the verdict, not to police the buyer.

*Secondary benefit (not the reason):* because a switch to a different make/model forces a new deal, a dealership's "that one just sold, but I've got this other one…" move can't be laundered inside an existing negotiation. Defending against that tactic is something the design supports; it is not why the design exists.

**One deal, many dealerships — each with its own car.** `Deal.dealer_threads[]` holds a thread per dealership, and **each thread carries its own `VehicleInstance`**. Three dealerships offering the same model will differ in VIN, year, trim, mileage, and add-ons — that variation is the negotiation, so it lives per thread, never on the deal.

**What is fixed vs. what varies once a deal starts:**

| Fixed for the life of the deal | Varies per dealership / offer |
|---|---|
| make, model | VIN, year, trim, mileage, condition, additions, junk fees, price |

**Year drift:** the buyer picks make/model; model year may vary between dealerships. A `year_range` may bound the deal (roughly five years is the expected span), but this is a **soft guide, not a hard rejection** — buyers stay in a sensible range naturally, and a hard rule would block legitimate shopping.

### Budget ceiling vs. fair price — two different questions *(resolved 2026-08-07)*

"Make + model" alone is not priceable: no valuation source can price *Honda Accord* without year, trim, mileage, and condition, and all four vary per thread. `walk_away_number` therefore cannot be doing both jobs. It is split:

| Question | Scope | Answered against |
|---|---|---|
| **"Can I afford it?"** | **Deal-level** — `walk_away_number` is the buyer's budget ceiling, one figure for the whole deal | out-the-door total of any thread's offer (`over_walkaway`, unchanged) |
| **"Is this a good price?"** | **Per `VehicleInstance`** | that specific car's own `ValuationSnapshot` |

**Consequences:**
- Every fair-price verdict is a comparison against **one known car**, so the honesty promise the one-vehicle rule protects holds at the level where pricing actually happens.
- The flag engine gains a **market-value input per instance**; an offer priced above that car's own value is flagged independently of whether it fits the budget. A cheap car can be a bad deal and an expensive one a fair deal — both must be sayable.
- **Cross-dealership comparison is value-adjusted, not raw-price.** The war room ranks threads by how each offer sits against *its own* car's value, so a $2k-cheaper car with 50k more miles reads as the worse buy, which is the comparison a buyer actually needs.
- A `ValuationSnapshot` is meaningless without a `VehicleInstance`; a thread with no valuation yet reports fair-price as **unevaluable** (ADR-005 semantics), never as "fine".

*Enforcement:* `target_vehicle.make`/`model` are write-once — settable while the deal is `draft`, immutable once any offer is attached. If the buyer enters a `VehicleInstance` whose make/model does not match the deal's anchor, the app **rejects the entry, highlights that vehicle in red against its VIN, and offers to open a new Deal.** The rejection is a receipt-trail event. VIN is **user-entered and unvalidated at launch** — it is the buyer's own record, not a lookup key (VIN decode validation is backlog).

### Dealership data tenancy

**Dealership names and locations are global; the people are private.** A `Dealership` record (name, state, city, zip) is shared across all accounts — one row per real dealership, so a directory can be batch-loaded later. `DealershipContact` records (the named general manager, sales manager, finance manager, sales agent, and their direct contact details) are **scoped to the account that entered them and are never exposed to another account.** One buyer's notes on which finance manager runs which play are that buyer's, not the platform's to redistribute.

**Store:** Postgres for the relational core (deal → threads → messages → offers), object store (S3 or equiv.) for email attachments, uploaded documents, and generated dossiers. No audio is stored.

**`identity_ref` is deliberately provider-agnostic.** It points at *an* identity — a number + inbox — without the core caring who provisioned it. The consumer product fills it with an identity *we* issued; the B2B product fills it with one the user *connected*. Same threading downstream.

---

## Comms aggregation layer (provider-agnostic — shared)

This is the threading and capture engine. It handles messages regardless of who owns the underlying number/alias.

**Inbound call:** `provider webhook → Comms service → log call metadata (time, direction, party) on DealerThread → notify owner → owner writes a note → run offer-extraction on the note.` No audio is captured and no transcription runs (consumer posture, specs/01; transcription is backlog).

**Inbound SMS / email:** `webhook → thread onto DealerThread → extract offer.`

**Outbound:** `owner acts in-app → sent via that deal's identity → dealer only ever sees the deal identity, never a real personal line.`

**Offer extraction:** any message text — buyer note, SMS, or email — → parsed `Offer` (price, fees, APR, term, monthly) attached to the message and rolled into the thread's `current_offer`. The extractor is channel-agnostic and never depends on how the text was produced.

**Rule:** webhooks ack immediately, all heavy work (extraction, valuation refresh, notification) runs on the event bus. Provider timeouts must never drop a dealer message.

*What differs by product — who provisions the identity, who is sender-of-record, and the consent obligations that ride with that — lives in each product spec, not here.*

## Flag engine (shared)

Consumes an `Offer`, emits `flags[]`:
- **payment_packing** — term stretched (72/84 mo) to shrink the monthly.
- **rate_markup** — APR above what the buyer qualifies for.
- **junk_fee** — add-ons / fees above fair value.
- **over_walkaway** — out-the-door total crosses the deal's **budget ceiling**.
- **above_market** — the offer is priced above **this specific car's** own valuation. Distinct from `over_walkaway`: a car can be inside your budget and still a bad price, or over budget and priced fairly.

Provider-agnostic, pure function of `Offer` + user's qualified-rate + walk-away + **the instance's market value** (see "Budget ceiling vs. fair price"). Consumer UI foregrounds these; B2B pros may treat them as advisory. A flag whose required input is absent is **unevaluable**, never silently passed (ADR-005).

## Integrations — anti-corruption / adapter layer (shared)

Every external feed sits behind one internal interface. Core services never see a provider's shape.

### Valuation

| Need | Primary | Alternates | Note |
|------|---------|-----------|------|
| Retail / trade-in | KBB, J.D. Power (NADA) | Black Book | Licensed feeds. |
| Wholesale / auction | Manheim (MMR) | — | Dealer-side truth; powers the spread view. |
| Private-party | **KBB private-party value** + **buyer-entered comps** | Licensed aggregator (future) | No marketplace scraping — Meta publishes no API and scraping breaches their terms (Q15). The app points the buyer at good marketplaces and they enter what they find. |

Blend into **wholesale vs trade-in vs retail**. Snapshot + cache.

### Vehicle data

| Need | Source | Note |
|------|--------|------|
| VIN decode + recalls | **NHTSA vPIC + Recall API** | Free, authoritative. |
| Accident / title | Carfax, AutoCheck | Paid. |
| Reliability + repair cost | Published indices + **crowd-sourced repair ledger** | Ledger = proprietary moat. |
| Depreciation / TCO | Historical valuation curves + published data | Compounds over time. |

### Receipt layer (trust engine)

Every **buyer note, SMS, email, and call-metadata record** is **append-only, timestamped, exportable**. (No recordings or transcripts exist — see specs/01 consent posture.) Each entry carries its **author** — buyer, concierge operator, or dealer — so self-authored evidence is never presented as if it came from the dealer. Generates a shareable **deal dossier** (PDF + web link). In consumer, this is the trust proof and concierge deliverable; in B2B, it's the audit/handoff artifact.

## Async backbone (shared)

Event bus (SNS/SQS, Kafka, or managed queue) drives inbound-comms processing, offer extraction, valuation refresh, alert dispatch. Keeps real-time paths fast.

## Stack (opinionated — shared defaults)

- **Web:** Next.js · **Mobile:** React Native (native only if scan perf demands)
- **Backend:** Python (FastAPI) or Node/TS
- **DB:** Postgres + S3
- **Payments:** Stripe
- **Auth:** Auth0 / Clerk / Cognito

*Telephony/email provider defaults differ by product and live in each spec.*
