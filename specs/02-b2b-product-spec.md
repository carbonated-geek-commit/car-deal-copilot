# B2B Product Spec (v0.2)

*Builds on [Shared Core](./00-shared-core-architecture.md). A distinct business from the [Consumer product](./01-consumer-product-spec.md) — different buyer, pricing, liability model, and explicitly a different set of things it refuses to do. This spec covers only what's B2B-specific.*

**Buyer:** high-volume purchasers — fleet buyers, small dealers buying inventory, flippers, brokers.
**Promise:** be the **cockpit** for their car buying, not the phone company. Aggregate everything into one platform with a proper deal war room, valuation, VIN data, offer extraction, and a clean receipt trail.
**Shape:** subscription, unlimited concurrent deals.

---

## What this product deliberately is NOT

- **No concierge.** We are not a car-buyer-for-hire. That's a human-hours services business that fights software margins and isn't the business being built. Out of scope, on purpose.
- **Not the sender-of-record for volume outreach.** See the invariant below — this is the load-bearing design decision, not a feature preference.

## Identity provisioning — *they bring their own* (B2B-specific)

The reason this shape exists: if *we* issue phone numbers and inboxes to a volume user, we become the unwitting landlord of whatever outreach they run — including anything that reads as harassment. So on B2B, identity flips.

**One option at launch** *(resolved 2026-08-07 — the generated-identity option is dropped)*:

1. **Bring your own** *(the offering)* — connect their own telephony (their Twilio, etc.) and their own email/workspace (their Google Workspace, etc.). Their provider, their numbers, their compliance.

**Deferred: single generated identity.** The v0.1 option #2 (one number + inbox we generate) is **not offered at launch**. If it is ever revived, these are recorded preconditions, not suggestions: hard message/day and unique-recipient caps, automated abuse triggers with auto-suspend, and contractual indemnity + strict liability caps (`decisions/OPEN-QUESTIONS.md` Q5, Q8).

Either way, the platform is the **aggregation layer**: the shared `DealerThread` / `Message` model doesn't care whose number sits underneath. **That aggregation — threading, offer extraction, receipt trail — is the core value.** We're the cockpit; they own the wire.

## Connector layer (B2B-specific subsystem)

"Bring your own" means the anti-corruption adapters point **inbound**: instead of us calling out to providers, users plug *their* providers into *us*.

```
Subscriber's own providers
   (Twilio / SIP / Google Workspace / …)
              │  OAuth / API credentials
              ▼
      Connector Layer
   ├── credential vault (encrypted, per-org, revocable)
   ├── per-provider adapter (telephony, email)
   ├── webhook registration (route their inbound → our aggregation)
   └── outbound relay (send via THEIR identity, we never originate)
              │
              ▼
   Shared Comms aggregation layer  →  DealerThread / Message
```

- **Credential vaulting:** encrypted, scoped per org, revocable. We hold keys to *their* provider only as long as they say.
- **Per-provider adapters:** launch adapters are **Twilio (telephony)** and **Google Workspace (email)** *(resolved 2026-08-07)*. Telnyx/Bandwidth and Microsoft 365 are fast-follow candidates, not launch scope. Same adapter pattern as Shared Core, pointed the other direction.
- **Outbound relay, not origination:** when they send, it goes out through *their* identity. We are the UI and the record-keeper, never the originating carrier.

## Account model — org + seats (B2B-specific)

- **`Org` is the top entity**, not an individual account.
- **Subscription at the org level**, monthly, **unlimited concurrent deals.**
- Seats/users under the org (a brokerage with several buyers). Deals belong to the org; seats operate them.
- No per-deal entitlement gating — the subscription unlocks the platform; usage is unlimited by design.

## Which shared pieces matter most here

- **Valuation** (Shared Core) — *more* important to a pro than a consumer; the wholesale/auction spread is their daily bread.
- **Vehicle data / VIN** (Shared Core) — core to sourcing decisions.
- **Comms aggregation + receipt** (Shared Core) — the reason they're paying; one platform instead of a dozen phone threads.
- **Flag engine** (Shared Core) — present but **advisory**; pros already know the tricks, so packing/markup flags are a convenience, not the pitch.

## Pricing

Subscription, org-level, monthly. Unlimited concurrent deals. **Axis resolved 2026-08-07: flat org fee + per-seat.** Org size tracks our webhook/storage cost well enough (transcription is out of scope platform-wide per specs/01 — B2B included, so it is not a cost driver); connecting identities is never penalized (BYO is behavior we want); nothing is usage-metered in a way that reintroduces per-deal friction — the whole point is unlimited.

---

## The invariant that defines this product

**We must never be the sender-of-record for a volume user's outreach.**

- *Structurally prevented by:* the bring-your-own connector model — outbound always originates from the subscriber's own provider; our outbound path is relay-only, never origination.
- *How a violation would be detected:* any outbound message whose originating identity resolves to a number/alias *we* own (rather than a connected one) on a B2B org is a red flag — alert and block.
- *What could make it false that isn't in the flow yet:* the deferred "single generated identity" option was the one place we *would* issue an identity to a B2B user. **It is dropped at launch** (see Identity provisioning above), so at launch no B2B outbound can originate from an identity we own — the detection tripwire stays live anyway.

---

## Resolved decisions (v0.2)

All four v0.1 open decisions were resolved in the 2026-08-07 architect interview and are folded into the sections above (generated option dropped, Twilio + Google Workspace connectors, flat + per-seat pricing, indemnity posture bound to any future generated-option revival). Full answers with rationale: `decisions/OPEN-QUESTIONS.md` Q5–Q8.
