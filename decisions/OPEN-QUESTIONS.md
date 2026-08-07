# Open Architecture Decisions — the Architect's Interview Agenda

*Parked in the specs deliberately; Corban's to answer. The /architect session works through these one at a time, records answers here, and drafts resulting spec amendments to specs-draft/.*

---

## Consumer (we are sender-of-record)

### Q1 — Call-recording consent posture
**Context:** Two-party-consent states make recording without disclosure illegal; exposure concentrates here (consumer spec → Open decisions #1).
**Options:** (a) record everywhere, disclosure-gated before any recording; (b) transcribe-only, no audio retention; (c) per-state policy engine (record in one-party states, transcribe-only in two-party).
**ANSWER:** PENDING

### Q2 — Burner-number reuse
**Context:** A released number handed to a new user can receive the previous dealer's follow-up (consumer spec → Open decisions #2). What must never happen: a dealer reaching a stranger.
**Options:** (a) retire forever — cleanest isolation, higher per-number cost; (b) quarantine 30–90 days then reuse — cheaper at scale, non-zero leakage risk + monitoring burden.
**ANSWER:** PENDING

### Q3 — Credit data residency
**Context:** FCRA/GLBA weight attaches if credit data lands in our DB (consumer spec → Open decisions #3).
**Options:** (a) pass-through only — provider-hosted flow, we store a token + prequal results, raw credit data never touches our systems; (b) store in our DB — full compliance/audit build.
**ANSWER:** PENDING

### Q4 — Concierge agent access
**Context:** A human operates a user's burner identity adjacent to credit data (consumer spec → Open decisions #4). Needs enforcement, not trust.
**Options (composable):** role-scoped views (no credit detail, prequal summary only); no export of recordings; per-deal grants that expire on close; full audit log of agent actions.
**ANSWER:** PENDING

## B2B (they are sender-of-record — except the crack)

### Q5 — Generated-identity ceiling
**Context:** The single-generated-identity option is the one place we issue identity to a volume user — the crack in the never-sender-of-record invariant (B2B spec → Open decisions #1).
**Options:** hard message/day cap; recipient-count cap; automated abuse triggers (complaint rate, unique-recipient velocity) with auto-suspend; or drop the option entirely at launch.
**ANSWER:** PENDING

### Q6 — Launch connectors
**Context:** Each BYO provider = one adapter of real integration work (B2B spec → Open decisions #2).
**Options:** Twilio + Google Workspace first (obvious pair); alternates: Telnyx/Bandwidth, Microsoft 365.
**ANSWER:** PENDING

### Q7 — B2B pricing axis
**Context:** Must scale with our cost (webhook/storage/transcription volume) without breaking the "unlimited deals" promise (B2B spec → Open decisions #3).
**Options:** per-seat; per-connected-identity; flat org fee with fair-use; hybrid (flat + seat).
**ANSWER:** PENDING

### Q8 — Liability on the generated option
**Context:** On BYO, consent/abuse ride the subscriber's provider; on the generated option some rides back to us (B2B spec → Open decisions #4).
**Options:** contractual indemnity + strict caps; ToS-only; insurance-backed; or (again) drop the option.
**ANSWER:** PENDING

---

*New questions surfaced by the /architect session get appended below with the same format.*
