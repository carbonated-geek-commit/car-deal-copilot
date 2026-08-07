# Amendment 1 — Consumer Product Spec (v0.1 → v0.2)

*Drafted by the architect session 2026-08-07 from Corban's interview answers (OPEN-QUESTIONS Q1–Q4, Q9). Promoted by Corban's approval in the same session.*

## Diff description

1. **Identity provisioning → "Burn" paragraph** replaced with the **number lifecycle** model: user-controlled Burn / Keep / Re-use; burned numbers are retired to carrier at launch, never reassigned to another platform user (Q2, Q9).
2. **New section "Consent & recording posture":** transcribe-only, no audio retention, uniform in all states; `Message.recording_url` stays null by policy for consumer (Q1).
3. **New section "Credit data residency":** pass-through only; token + prequal results stored, raw credit data never lands in our DB (Q3).
4. **Concierge tier** gains enforced controls: role-scoped views, no export, expiring per-deal grants, full audit log, identity cutout (agent never sees the customer's real identity), no signing authority (Q4).
5. **"Open decisions — YOUR call" section** replaced by "Resolved decisions (v0.2)" pointing at decisions/OPEN-QUESTIONS.md.
