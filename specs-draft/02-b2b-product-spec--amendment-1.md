# Amendment 1 — B2B Product Spec (v0.1 → v0.2)

*Drafted by the architect session 2026-08-07 from Corban's interview answers (OPEN-QUESTIONS Q5–Q8). Promoted by Corban's approval in the same session.*

## Diff description

1. **Identity provisioning:** the "single generated identity" option is **dropped at launch** — B2B is BYO-only. The option is recorded as deferred; any future revival requires hard volume caps + abuse monitoring + the Q8 liability posture as preconditions (Q5, Q8).
2. **The invariant section** simplifies: with no generated option, no B2B outbound ever originates from an identity we own; detection rule (alert-and-block on our-owned originating identity) stays as a tripwire.
3. **Connector layer:** launch adapters named — Twilio (telephony) + Google Workspace (email); Telnyx/Bandwidth and M365 noted as fast-follow, not launch scope (Q6).
4. **Pricing:** flat org fee + per-seat, monthly; deals stay unlimited (Q7).
5. **"Open decisions — YOUR call" section** replaced by "Resolved decisions (v0.2)" pointing at decisions/OPEN-QUESTIONS.md.
