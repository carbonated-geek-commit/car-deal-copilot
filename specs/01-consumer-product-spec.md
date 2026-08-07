# Consumer Product Spec (v0.1)

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
- **Burn:** release or quarantine the number, disable the alias, archive (never delete) the thread. Quarantine prevents a released number reaching a stranger with the old dealer's follow-up.

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

---

## Open decisions — YOUR call

Generic error-path discipline is baked into Shared Core. These are consumer-specific and yours to name, because *we're sender-of-record* here:

1. **Call-recording consent posture.** Two-party-consent states: record (disclosure-gated) or transcribe-only / no-record? Legal exposure concentrates here.
2. **Burner-number reuse.** Retire forever (cleanest isolation, higher cost) or quarantine-and-reuse (cheaper, non-zero leakage risk)? What structurally prevents a dealer reaching a stranger?
3. **Credit data residency.** Does credit data land in *your* DB (full FCRA/GLBA weight) or stay pass-through to a provider's hosted flow so it never touches your systems?
4. **Concierge agent access.** A human operating a user's burner identity and adjacent-to-credit data — what must that agent *never* see or do, enforced rather than trusted?
