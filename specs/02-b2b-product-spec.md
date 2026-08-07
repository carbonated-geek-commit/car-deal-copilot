# B2B Product Spec (v0.1)

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

**Two options for the subscriber:**

1. **Bring your own** *(the core offering)* — connect their own telephony (their Twilio, etc.) and their own email/workspace (their Google Workspace, etc.). Their provider, their numbers, their compliance.
2. **Single generated identity** — one number + one inbox we generate for them, if they'd rather not connect anything. Bounded, low-volume-shaped, not a pool of disposable numbers.

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
- **Per-provider adapters:** one each for the telephony and email providers you support at launch (start with the one or two most common; it's the same adapter pattern as Shared Core, pointed the other direction).
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

Subscription, org-level, monthly. Unlimited concurrent deals. Tiering (by seats and/or connected-identity volume) TBD — but **not** usage-metered in a way that reintroduces per-deal friction; the whole point is unlimited.

---

## The invariant that defines this product

**We must never be the sender-of-record for a volume user's outreach.**

- *Structurally prevented by:* the bring-your-own connector model — outbound always originates from the subscriber's own provider; our outbound path is relay-only, never origination.
- *How a violation would be detected:* any outbound message whose originating identity resolves to a number/alias *we* own (rather than a connected one) on a B2B org is a red flag — alert and block.
- *What could make it false that isn't in the flow yet:* the "single generated identity" option (#2 above) is the one place we *do* issue an identity to a B2B user. That option needs its own volume ceiling and abuse monitoring, or it quietly reintroduces exactly the liability the bring-your-own model was designed to shed.

---

## Open decisions — YOUR call (B2B-specific)

1. **The generated-identity option's ceiling.** What volume cap + abuse monitoring on option #2 keeps it from becoming a harassment pool? (This is the crack in the invariant.)
2. **Launch connectors.** Which telephony + email providers do you support first? (Twilio + Google Workspace is the obvious starting pair.)
3. **Pricing axis.** Seats, connected-identities, or flat org fee — which scales with *your* cost (webhook/storage/transcription volume) without punishing the "unlimited" promise?
4. **Where B2B liability lives on the generated option.** When *they* bring the number, consent + abuse ride on their provider. On the generated option, some of that rides back to you — how much are you willing to own?
