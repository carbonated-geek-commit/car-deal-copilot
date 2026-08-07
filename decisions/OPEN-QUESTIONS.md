# Open Architecture Decisions — the Architect's Interview Agenda

*Parked in the specs deliberately; Corban's to answer. The /architect session works through these one at a time, records answers here, and drafts resulting spec amendments to specs-draft/.*

*Interview conducted 2026-08-07 (Corban, via architect session). All eight resolved; two new questions surfaced and resolved same session.*

---

## Consumer (we are sender-of-record)

### Q1 — Call-recording consent posture
**Context:** Two-party-consent states make recording without disclosure illegal; exposure concentrates here (consumer spec → Open decisions #1).
**Options:** (a) record everywhere, disclosure-gated before any recording; (b) transcribe-only, no audio retention; (c) per-state policy engine (record in one-party states, transcribe-only in two-party).
**ANSWER:** **(b) Transcribe-only, no audio retention** — 2026-08-07.
**Rationale:** Lowest legal exposure, no per-state policy engine to build or maintain. The receipt trail carries transcripts, not audio; the dossier loses the audio artifact and that trade is accepted. Consumer `Message.recording_url` stays null by policy.

### Q2 — Burner-number reuse
**Context:** A released number handed to a new user can receive the previous dealer's follow-up (consumer spec → Open decisions #2). What must never happen: a dealer reaching a stranger.
**Options:** (a) retire forever; (b) quarantine 30–90 days then reuse.
**ANSWER:** **User-controlled lifecycle: Burn / Keep / Re-use** — 2026-08-07.
- **Burn** — the user is done with the number and never wants their name/profile attached to it again; it is detached from the deal profile. Platform-side fate: see Q9.
- **Keep** — the number stays attached to the deal profile on the user's account; the user monitors updates arriving on it.
- **Re-use** — when creating a new deal, the user may carry a number they generated in a previous deal into the new deal.
**Rationale:** The number is an account-level asset under user control, not a platform-recycled commodity. Cross-user isolation is handled by Q9.

### Q3 — Credit data residency
**Context:** FCRA/GLBA weight attaches if credit data lands in our DB (consumer spec → Open decisions #3).
**Options:** (a) pass-through only; (b) store in our DB.
**ANSWER:** **(a) Pass-through only** — 2026-08-07.
**Rationale:** Provider-hosted soft-pull flow; we store only a token + prequal results (qualified APR, amounts). Raw credit data never touches our systems; the full FCRA/GLBA compliance build is avoided at launch.

### Q4 — Concierge agent access
**Context:** A human operates a user's burner identity adjacent to credit data (consumer spec → Open decisions #4). Needs enforcement, not trust.
**ANSWER:** **All four composable controls, plus two Corban additions** — 2026-08-07.
1. Role-scoped views — prequal summary only, never credit detail (API-enforced).
2. No export of recordings/transcripts from the agent role.
3. Per-deal grants that expire on deal close/burn; no standing access.
4. Full audit log — every agent action lands in the deal's append-only receipt trail, visible to the customer.
5. **Identity cutout:** the agent never needs (and never sees) the customer's full profile/real identity — the design must work even if a pseudonymous cutout is the counterparty.
6. **No signing authority:** the concierge agent cannot execute the purchase or sign documents; final purchase and signatures are customer-only acts.

## B2B (they are sender-of-record — except the crack)

### Q5 — Generated-identity ceiling
**Context:** The single-generated-identity option is the one place we issue identity to a volume user — the crack in the never-sender-of-record invariant (B2B spec → Open decisions #1).
**ANSWER:** **Drop the option at launch** — 2026-08-07.
**Rationale:** B2B is BYO-only at launch. Cleanest invariant — we are never sender-of-record for any B2B outreach, no volume-monitoring build. If the option ever ships, it ships with hard caps + abuse monitoring + the Q8 liability posture as preconditions.

### Q6 — Launch connectors
**Context:** Each BYO provider = one adapter of real integration work (B2B spec → Open decisions #2).
**ANSWER:** **Twilio (telephony) + Google Workspace (email)** — 2026-08-07.
**Rationale:** The most common pair; one telephony adapter + one email adapter at launch. Telnyx/Bandwidth and Microsoft 365 are fast-follow candidates, not launch scope.

### Q7 — B2B pricing axis
**Context:** Must scale with our cost without breaking the "unlimited deals" promise (B2B spec → Open decisions #3).
**ANSWER:** **Flat org fee + per-seat** — 2026-08-07.
**Rationale:** Org size is a workable proxy for webhook/storage/transcription cost; standard SaaS shape; deals stay unlimited; doesn't punish connecting identities (which BYO wants to encourage).

### Q8 — Liability on the generated option
**Context:** On BYO, consent/abuse ride the subscriber's provider; on the generated option some rides back to us (B2B spec → Open decisions #4).
**ANSWER:** **Contractual indemnity + strict caps — recorded as the mandatory posture for the deferred generated option** — 2026-08-07.
**Rationale:** The option is dropped at launch (Q5), so this binds any future revival: subscriber indemnity for outreach conduct, paired with structural volume caps so exposure is small by construction, not just contractually shifted.

---

*New questions surfaced by the /architect session get appended below with the same format.*

### Q9 — Platform-side fate of a burned number *(surfaced from Q2)*
**Context:** Burn detaches a number from the user. If it re-enters a platform pool, the "dealer reaches a stranger" failure becomes possible.
**Options:** (a) retire to carrier, never reassigned to another platform user; (b) quarantine 90 days then platform pool; (c) hold dark indefinitely.
**ANSWER:** **(a) Retire at launch** — 2026-08-07.
**Rationale:** Burned numbers are released back to the carrier and never reassigned to another platform user. Zero cross-user leakage, no monitoring build. Revisit pooling only if number costs bite at scale — that cost signal is the recorded trigger for reopening.

### Q10 — Backend language *(spec leaves FastAPI vs Node/TS open)*
**ANSWER:** **Deferred to the Chief Architect, to be logged as an ADR** — 2026-08-07. Per the constitution, choosing among named alternates is within the chief's authority; the choice must land in `decisions/adr/` before dependent work.

### Q11 — Deal ↔ Vehicle ↔ Dealership cardinality
**Context:** Corban's hierarchy note (2026-08-07) pinned the shape the spine must enforce.
**ANSWER:** **One vehicle per deal (immutable); many dealerships per deal** — 2026-08-07.
`Account → Deal → Vehicle` is 1:1 and `Account1 → Deal1 → Vehicle2` must be unrepresentable. `Deal.dealer_threads[]` stays an array — the side-by-side war room across dealerships is preserved.
**Rationale (Corban):** "Dealerships will try to move a customer from a vehicle based on their availability, the only way to do that is start a new Deal structure." Making the vehicle immutable forces the substitution into a new deal, so the bait-and-switch always leaves a mark in the receipt trail instead of being laundered inside an existing negotiation. `target_vehicle` is write-once: settable while `draft`, rejected once any offer is attached, with the rejection recorded as a receipt event.

### Q12 — Dealership entity shape
**ANSWER:** **First-class shared `Dealership` + per-deal relationship fields** — 2026-08-07.
`Dealership` (shared across deals): name, state, city, zip_code, `staff[]` of {name, role} where role ∈ {general_manager, sales_manager, finance_manager, sales_agent}.
`DealerThread` (the per-deal relationship): `dealership_id`, `working_with` (which staff member the buyer is dealing with now), and `process_step` ∈ {information_gather, deal_negotiation, deal_approval, financing, final_sale, pickup}.
**Rationale:** who you're handed to and how far along you are is negotiation state, not dealership state — the same dealership sits at different steps in different deals. Tracking the hand-off up the chain (agent → sales manager → finance manager) is itself buyer leverage.

### Q13 — Dealership data sourcing
**ANSWER:** **No Maps/business API at launch — user-entered, mock the structure, batch-load later** — 2026-08-07.
**Rationale:** Corban withdrew the Google Maps Places API request. The buyer types dealership details; the schema is built to accept a bulk import later. **Consequence: no new integration and no new spend is required**, so nothing here needs escalation.

### Q14 — Call transcription
**ANSWER:** **Dropped from scope; moved to backlog** — 2026-08-07.
The buyer writes notes and the extractor parses them (it is channel-agnostic, so typed notes work like any other message). No ASR provider is needed or approved. This supersedes Q1's transcribe-only posture: two-party-consent exposure is now avoided rather than managed. Reviving transcription re-opens Q1 and requires an approved provider.

### Q15 — Private-party / marketplace comps
**Context:** Corban asked for KBB private-party value plus Facebook Marketplace vehicles. Meta publishes no Marketplace API; automated scraping violates their ToS and carries legal and blocking risk.
**ANSWER:** PENDING — KBB private-party is already covered by the existing mock-only KBB approval; the Marketplace sourcing method (user-pasted listings vs. licensed aggregator vs. other classifieds with real APIs) is still Corban's call. Blocks the valuation epic only.
