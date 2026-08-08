# Consumer Product Spec (v0.3)

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

**No recording and no transcription — the buyer writes the notes.** *(Amended 2026-08-07: automated transcription is dropped from scope and moved to backlog.)*

The buyer types what the dealer said, in their own words, and the offer extractor parses the terms out of that text — the extractor is channel-agnostic, so a typed note works exactly like any other message. Consequences:

- `Message.recording_url` stays null by policy; no audio is ever captured or stored.
- No ASR/transcription provider is required, so none is approved or wired.
- Legal exposure from two-party-consent states is **avoided entirely** rather than managed — there is nothing to consent to.
- The receipt trail carries buyer-authored notes with timestamps. They are weaker evidence than a recording, and that trade is accepted.

**Backlog:** if call transcription is ever revived, it re-opens the consent question and requires a new decision plus an approved provider.

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
Credit consent + soft pull → target **make/model** (*or* "scan on the lot") → budget → derived walk-away → the fork → coaching card.

**The one-vehicle explainer is part of onboarding, not fine print.** When the buyer commits to a make/model, the app says plainly *why* the deal locks to it: this is the only way we can honestly tell you whether a price is good, because every valuation and flag is a comparison against one known vehicle. Buyers who don't yet know what they want are served by the pre-deal phase (backlog, below) — not by loosening the deal.

### Web surface (war-room-first)

| # | Screen | Purpose |
|---|--------|---------|
| W1 | **Dashboard** (Glovebox) | All active deals, budget, pre-qual loans, walk-away. |
| W2 | **Deal War Room** | Core screen. One make/model, **many dealerships side-by-side** — each column is one dealership's **specific car** (VIN, year, trim, mileage, add-ons) and its offer. Packing/markup/junk-fee flags, walk-away tracker, and per-dealership **who you're working with** (agent → sales manager → finance manager) plus **process step** (information gather → deal negotiation → deal approval → financing → final sale → pickup). Entry is **notes-first** — the buyer types what was said and the extractor parses the offer out of it. A vehicle entered against the wrong make/model is **rejected and shown in red against its VIN**, with a prompt to open a new deal. **Burner inbox** (texts/emails threaded per dealership) lands post-beta. |
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

A human runs the **same deal war room** on the user's behalf, using the **same burner identity**. This is the "show the work" TikTok model, productized — the dossier *is* the deliverable.

**What the customer is buying — resolved 2026-08-07.** The deliverable is **comparative, not forensic**: the concierge works **several deals in parallel** and presents the best one (or best few) with the full offer history behind each. The proof is that the customer can see what else was on the table and why the recommendation beat it.

This is a **trust relationship, not an evidence chain.** Either the customer trusts the service or they don't; a verbatim transcript of a call the customer wasn't on does not change that, and it is not clear what a transcript would give the operator that they cannot enter themselves. Operator-authored notes carry the `concierge` author label (shared core `Message.author`), so nothing self-authored is ever presented as if the dealer said it.

Explicitly **not** offered on B2B (that's a car-buyer-for-hire services business, deliberately out of scope).

*Backlog:* importing external call artifacts (e.g. Zoom transcripts) into a deal — under consideration, not scoped.

**Enforced agent controls** *(resolved 2026-08-07 — enforcement, not trust)*:
1. **Role-scoped views** — the agent role sees the prequal summary only (qualified rate, budget); credit detail is absent from the agent API surface.
2. **No export** — receipt artifacts (notes, messages, documents) are viewable in-app by the agent; the export/download path does not exist on the agent role.
3. **Per-deal grants that expire** — access is granted per deal and auto-revokes on close/burn; no standing access to any account.
4. **Full audit log** — every agent action (view, send, call) lands in the deal's append-only receipt trail, visible to the customer.
5. **Identity cutout** — the agent never needs and never sees the customer's real identity or full profile; the design must function even when a pseudonymous cutout is the counterparty.
6. **No signing authority** — the concierge agent cannot execute the purchase or sign documents; final purchase and signatures are customer-only acts.

---

## Resolved decisions (v0.2)

All four v0.1 open decisions were resolved in the 2026-08-07 architect interview and are folded into the sections above (consent posture, number lifecycle, credit residency, concierge controls). Full answers with rationale: `decisions/OPEN-QUESTIONS.md` Q1–Q4 and Q9.

---

## Backlog (explicitly out of current scope)

Recorded so they are not silently forgotten, and not planned until promoted.

1. **Pre-deal phase — vehicle shortlist.** Onboarding for a buyer who does not yet know which vehicle they want: compare several candidates, build a portfolio on the account, then commit to one and open a Deal. This is where "I'm not sure yet" belongs — *not* inside the deal system, whose honesty depends on a single anchor vehicle. Until this exists, undecided buyers open one deal per candidate.
2. **External call-artifact import** (e.g. Zoom transcripts) attached to a deal. Under consideration; the open question is what a transcript gives the buyer that they cannot type themselves.
3. **Call transcription / ASR.** Dropped from launch (Q14). Reviving it re-opens the two-party-consent question and needs an approved provider.
4. **VIN decode validation.** At launch VIN is user-entered and unvalidated — the buyer's own record. A decode lookup would let the app verify make/model against the VIN rather than trusting entry.
5. **Dealership directory batch load.** Dealership records are user-entered at launch; the schema accepts a bulk import later. No Maps/business API is approved (Q13).
6. **Facebook Marketplace and other private-party comps.** Meta publishes no Marketplace API and scraping violates their terms, so at launch **the buyer sources their own comps and the app points them at good marketplaces to look.** A licensed aggregator remains a future option.
