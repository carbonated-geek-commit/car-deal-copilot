# Thesis (Authoritative — Read-Only to All Agents)

*This is the document the thesis-gate agent checks every spec and task list against. It changes only by human-approved commit.*

## The problem

Car buyers walk onto dealership lots outgunned: opaque pricing, finance-office games (payment packing, rate markup, junk fees), and negotiation leverage that all sits on the dealer's side.

## Consumer thesis

A **buyer's co-pilot** across three phases: **pre-game** (credit soft-pull + pre-qualified loans), **on-the-lot** (snap a car → private-market value, VIN history, reliability, true cost of ownership including mechanical cost over time), and **in-the-office** (decode every finance-office line item).

**Business red lines (non-negotiable):**
1. **The customer pays; the customer is who we serve.** No dealer referral fees, ever. Rankings and recommendations are never influenced by who pays us.
2. **Per-deal pricing, four rails:** In-store toolkit $5 · Online-only $50 · Hybrid $100 · Concierge $500. Entitlements gate on the **deal**, not the account.
3. **One account holding paid deals.** No separate-accounts-per-deal. Deal-view vs account-view separation lives at the **UI layer**, not the data layer.
4. **Burner identity per deal (we provision):** dedicated phone + email per deal; all comms threaded into the deal's war room; burn or keep on close. The user's real number/email never touches a dealer.
5. **Three shopping paths** chosen at onboarding (online-only / hybrid / in-person-now), reshaping surfaces and coaching. Honest coaching about dealer behavior is part of the product.
6. **Web-first, app-second.** Web = war room; app = on-the-lot weapon. Live sync.
7. **The receipt trail** (append-only, timestamped, exportable dossier) is the trust engine and the concierge deliverable.

## B2B thesis

The **cockpit, not the phone company**, for high-volume buyers (fleet, small dealers, flippers, brokers).

**Business red lines (non-negotiable):**
1. **Subscription at the org level, unlimited concurrent deals.** No per-deal friction.
2. **Bring-your-own identity is the core offering.** Subscribers connect their own telephony/email; we aggregate (threading, offer extraction, receipt trail). The bounded single-generated-identity option must carry a volume ceiling + abuse monitoring.
3. **No concierge on B2B.** We are not a car-buyer-for-hire.
4. **We are never sender-of-record for a volume user's outreach.** Outbound on B2B originates from the subscriber's provider; our path is relay-only.

## Shared architectural commitments

- One shared spine (`Deal` / `DealerThread` / `Message` / `Offer`) defined **once** in `specs/00-shared-core-architecture.md`. Products diverge only at identity provisioning, billing, account model, and liability posture.
- All external providers sit behind the **anti-corruption adapter layer**.
- Crowd-sourced repair ledger + accrued valuation curves are the proprietary data moat.

## What "matching the thesis" means for the gate

A spec or task list matches the thesis if: no red line above is violated or weakened; the spine stays single-sourced; consumer and B2B remain **two distinct products** (separate pricing, liability, identity models) sharing that spine; and nothing introduces a dealer-side revenue stream or steering incentive.
