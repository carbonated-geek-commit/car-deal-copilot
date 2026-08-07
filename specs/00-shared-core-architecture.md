# Shared Core — Architecture Spine (v0.1)

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
├── target_vehicle          (VehicleSpec — EXACTLY ONE, immutable after first offer)
├── resolved_vehicle        (VIN, once identified)
├── budget, walk_away_number
├── identity_ref            (→ provider-agnostic; see Comms below)
├── dealer_threads[]        (MANY dealerships may sit inside one deal)
├── offers[]
├── receipt_bundle_id
└── created_at, burned_at

VehicleSpec
├── make, model, year, trim
├── mileage                 (odometer; absent for new)
├── condition               (new | used | certified)
└── additions[]             (options, packages, dealer add-ons)

Dealership                  (shared entity — many deals may reference the same one)
├── id, name
├── state, city, zip_code
└── staff[]                 (StaffMember: name + role)

StaffMember
└── name, role              (general_manager | sales_manager | finance_manager | sales_agent)

DealerThread                (the per-deal relationship with ONE dealership)
├── dealership_id           (→ Dealership)
├── working_with            (→ StaffMember — who you are dealing with right now)
├── process_step            (information_gather | deal_negotiation | deal_approval
│                            | financing | final_sale | pickup)
├── contact info
├── messages[]
└── current_offer

Message
├── channel   (call | sms | email)
├── direction (in | out)
├── body | recording_url | transcript
├── timestamp
└── extracted_offer?

Offer
├── sale_price, fees[], apr, term_months, monthly
└── flags[]   (packing | rate_markup | junk_fee | over_walkaway)

ValuationSnapshot · VehicleData   (cached, timestamped)
```

### Cardinality invariants (structurally enforced)

**One deal, one vehicle — always.** `Account → Deal → Vehicle` is strictly 1:1. A deal never covers two vehicles; `Account1 → Deal1 → Vehicle2` must be unrepresentable, not merely discouraged.

**One deal, many dealerships.** `Deal.dealer_threads[]` holds a thread per dealership, which is what makes the side-by-side war room work — the same vehicle spec shopped against several dealers at once.

**Why the vehicle is immutable:** a dealership that can't deliver the car you came for will try to move you onto whatever is on their lot ("that one just sold, but I've got this other one…"). If a deal's vehicle could be swapped in place, that substitution would vanish into an existing negotiation, taking its valuation, walk-away number, and offer history with it. **Switching vehicles requires opening a new Deal.** The switch therefore always leaves a mark in the receipt trail, and the abandoned deal stands as evidence of the bait-and-switch.

*Enforcement:* `target_vehicle` is write-once — settable while the deal is `draft`, immutable once any offer is attached. An attempted change is rejected, not silently applied, and the rejection is a receipt-trail event.

**Store:** Postgres for the relational core (deal → threads → messages → offers), object store (S3 or equiv.) for recordings and generated dossiers.

**`identity_ref` is deliberately provider-agnostic.** It points at *an* identity — a number + inbox — without the core caring who provisioned it. The consumer product fills it with an identity *we* issued; the B2B product fills it with one the user *connected*. Same threading downstream.

---

## Comms aggregation layer (provider-agnostic — shared)

This is the threading and capture engine. It handles messages regardless of who owns the underlying number/alias.

**Inbound call:** `provider webhook → Comms service → (consent handling per product) → record/transcribe → store on DealerThread → run offer-extraction → notify owner.`

**Inbound SMS / email:** `webhook → thread onto DealerThread → extract offer.`

**Outbound:** `owner acts in-app → sent via that deal's identity → dealer only ever sees the deal identity, never a real personal line.`

**Offer extraction:** transcript/text/email → parsed `Offer` (price, fees, APR, term, monthly) attached to the message and rolled into the thread's `current_offer`.

**Rule:** webhooks ack immediately, all heavy work (transcription, extraction) runs on the event bus. Provider timeouts must never drop a dealer message.

*What differs by product — who provisions the identity, who is sender-of-record, and the consent obligations that ride with that — lives in each product spec, not here.*

## Flag engine (shared)

Consumes an `Offer`, emits `flags[]`:
- **payment_packing** — term stretched (72/84 mo) to shrink the monthly.
- **rate_markup** — APR above what the buyer qualifies for.
- **junk_fee** — add-ons / fees above fair value.
- **over_walkaway** — total crosses the deal's walk-away number.

Provider-agnostic, pure function of `Offer` + user's qualified-rate + walk-away. Consumer UI foregrounds these; B2B pros may treat them as advisory.

## Integrations — anti-corruption / adapter layer (shared)

Every external feed sits behind one internal interface. Core services never see a provider's shape.

### Valuation

| Need | Primary | Alternates | Note |
|------|---------|-----------|------|
| Retail / trade-in | KBB, J.D. Power (NADA) | Black Book | Licensed feeds. |
| Wholesale / auction | Manheim (MMR) | — | Dealer-side truth; powers the spread view. |
| Private-party | Marketplace listings | Own listings ingest | True private-market value. |

Blend into **wholesale vs trade-in vs retail**. Snapshot + cache.

### Vehicle data

| Need | Source | Note |
|------|--------|------|
| VIN decode + recalls | **NHTSA vPIC + Recall API** | Free, authoritative. |
| Accident / title | Carfax, AutoCheck | Paid. |
| Reliability + repair cost | Published indices + **crowd-sourced repair ledger** | Ledger = proprietary moat. |
| Depreciation / TCO | Historical valuation curves + published data | Compounds over time. |

### Receipt layer (trust engine)

Every recording, transcript, SMS, email is **append-only, timestamped, exportable**. Generates a shareable **deal dossier** (PDF + web link). In consumer, this is the trust proof and concierge deliverable; in B2B, it's the audit/handoff artifact.

## Async backbone (shared)

Event bus (SNS/SQS, Kafka, or managed queue) drives inbound-comms processing, transcription, offer extraction, valuation refresh, alert dispatch. Keeps real-time paths fast.

## Stack (opinionated — shared defaults)

- **Web:** Next.js · **Mobile:** React Native (native only if scan perf demands)
- **Backend:** Python (FastAPI) or Node/TS
- **DB:** Postgres + S3
- **Payments:** Stripe
- **Auth:** Auth0 / Clerk / Cognito

*Telephony/email provider defaults differ by product and live in each spec.*
