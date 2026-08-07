# Consumer Product Spec (v0.2)

*Builds on [Shared Core](./00-shared-core-architecture.md). Distinct from the [B2B product](./02-b2b-product-spec.md) — different buyer, pricing, and liability posture. This spec covers only what's specific to the consumer business.*

**Buyer:** an individual buying a car, most often anxious and outgunned on the dealership floor.
**Promise:** the customer pays, so the customer is unambiguously who the product serves. **No dealer referral fees**, ever.
**Shape:** web-first, app-second. Live sync.

---

## Frame

One data model, two surfaces:
- **Web = the war room.** Big screen for strategy, side-by-side comparison, reading fine print, running deals in parallel.
- **App = the weapon on the lot.** Camera, instant valuation, real-time flags, the burner dialer/texter in your pocket.

Three phases the whole product is organized around: **pre-game** (credit + pre-qual loans) → **on-the-lot** (scan → value/reliability/true-cost) → **in-office** (decode every finance-office line).

---

## Account model *(the piece we locked)*

**One account, holding paid deals.** Not separate accounts per deal — that's privacy theater (same email + card links them anyway) and it blinds us to our own repeat customers while wrecking the receipt trail. Killed.

But the *feeling* that made per-deal-accounts tempting is preserved at the **UI layer, not the data layer**:

- App **defaults into the current deal's war room.** That's home.
- The **account overview is a deliberate step up** — all deals, budgets, saved cars, pre-qual loans.
- Deals stay psychologically walled without the backend pretending they're strangers.

**Billing entity separation:** `Account` owns `Deals`; each `Deal` carries its own `entitlement` (which rail was paid). Features gate on the **deal's entitlement, not the account** — so one $5 in-store deal today and a $50 online deal next month coexist with no tier weirdness.

## Identity provisioning — *we provide* (consumer-specific)

On first dealer contact within a deal (lazy — don't burn numbers on empty drafts), **we provision**:
- a phone number (Twilio to start; Telnyx / Bandwidth if per-number cost bites), and
- an email alias — catch-all `deal-{token}@yourdomain`, inbound-parsed (SES + Lambda, or SendGrid / Postmark).

Threading/capture/extraction is the shared aggregation layer. What's consumer-specific:

- **We are sender-of-record.** So the consent and isolation obligations are *ours* (see Open Decisions).
- **Whisper on forward:** if forwarding an inbound call to the user's real phone, ring with a whisper ("call from your Honda deal") so their real number never touches the dealer.
- **Number lifecycle (user-controlled — Burn / Keep / Re-use):** on deal close the user chooses:
  - **Burn** — the number is detached from the deal profile and the user's name/profile is never attached to it again; the alias is disabled; the thread is archived (never deleted). Platform-side, a burned number is **retired to the carrier at launch — never reassigned to another platform user** (zero cross-user leakage; revisit pooling only if number cost bites at scale).
  - **Keep** — the number stays attached to the closed deal's profile on the user's account; the user monitors anything that still arrives on it.
  - **Re-use** — when opening a new deal, the user may carry a number they generated in a previous deal into the new deal.

## Consent & recording posture *(resolved 2026-08-07)*

**Transcribe-only, no audio retention — uniform in all states.** Calls are transcribed in real time; no audio is ever stored. `Message.recording_url` stays null by policy on consumer; the receipt trail and dossier carry transcripts. No per-state policy engine exists or is planned.

## Credit data residency *(resolved 2026-08-07)*

**Pass-through only.** Soft pull runs in the credit provider's hosted flow; we store a provider token + prequal results (qualified APR, amounts) and nothing else. Raw credit data never lands in our systems — the full FCRA/GLBA data-holder build is intentionally avoided.

## The shopping-path fork *(onboarding)*

Chosen at onboarding, reshapes both surfaces, not permanent:

- **Online-only** — patient; national dealer net + shipping folded into true price; coaching holds the line against FOMO (expect 3–5 days of back-and-forth).
- **Hybrid** — win the number in writing online, then flip to floor mode to close.
- **In-person now** — skip the slow dance; front-load scanner + war room for real-time combat.

Honest coaching card up front: most *local* dealers stall on price over email because they want you in the door — naming it manages the expectation. And what they want isn't your problem: a good out-of-state price plus $1–2k shipping can still win.

---

## Screen map

### 0. Onboarding & fork
Credit consent + soft pull → target (make/model/trim *or* "scan on the lot") → budget → derived walk-away → the fork → coaching card.

### Web surface (war-room-first)

| # | Screen | Purpose |
|---|--------|---------|
| W1 | **Dashboard** (Glovebox) | All active deals, budget, pre-qual loans, walk-away. |
| W2 | **Deal War Room** | Core screen. Dealer threads side-by-side, offer grid, packing/markup/junk-fee flags, walk-away tracker, **burner inbox** (calls/texts/emails threaded per dealer). |
| W3 | **Compare & Fine-Print** | Side-by-side vehicles; TCO layer; contract line-item decoder. |
| W4 | **Vault** | Saved cars, closed deals, ownership tracker — repair ledger + "keep or dump" month for a car you bought. |

### App surface (scanner-first)

| # | Screen | Purpose |
|---|--------|---------|
| A1 | **Scanner** (home) | Camera → vehicle ID → value / VIN / reliability card. Enter mileage to refine. |
| A2 | **True-Cost card** | Swipe up: depreciation, insurance est, **repair-by-year**, the mechanical "cliff." |
| A3 | **Pocket War Room** | Enter their offer → instant flags + walk-away nudge. Burner dialer/texter lives here. |
| A4 | **Alerts** | Push: "stretched to 84 months," "rate marked up 1.8 pts," "end-of-quarter — dealer's chasing quota." |

---

## Pricing — the four rails (Stripe, per-deal)

| Rail | Price | Scope |
|------|-------|-------|
| In-store toolkit | $5 | One-time, per deal — impulse-buy arming for anyone on a lot today. |
| Online-only | $50 | One-time, per deal. |
| Hybrid | $100 | One-time, per deal. |
| Concierge | $500 | One-time + internal ops (below). |

## Concierge tier (consumer-only)

A human runs the **same deal war room** on the user's behalf, using the **same burner identity**, so all proof is captured automatically. This is the "show the work" TikTok model, productized — the dossier *is* the deliverable. Explicitly **not** offered on B2B (that's a car-buyer-for-hire services business, deliberately out of scope).

**Enforced agent controls** *(resolved 2026-08-07 — enforcement, not trust)*:
1. **Role-scoped views** — the agent role sees the prequal summary only (qualified rate, budget); credit detail is absent from the agent API surface.
2. **No export** — transcripts and receipt artifacts are viewable in-app by the agent; the export/download path does not exist on the agent role.
3. **Per-deal grants that expire** — access is granted per deal and auto-revokes on close/burn; no standing access to any account.
4. **Full audit log** — every agent action (view, send, call) lands in the deal's append-only receipt trail, visible to the customer.
5. **Identity cutout** — the agent never needs and never sees the customer's real identity or full profile; the design must function even when a pseudonymous cutout is the counterparty.
6. **No signing authority** — the concierge agent cannot execute the purchase or sign documents; final purchase and signatures are customer-only acts.

---

## Resolved decisions (v0.2)

All four v0.1 open decisions were resolved in the 2026-08-07 architect interview and are folded into the sections above (consent posture, number lifecycle, credit residency, concierge controls). Full answers with rationale: `decisions/OPEN-QUESTIONS.md` Q1–Q4 and Q9.
