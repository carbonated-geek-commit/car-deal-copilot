-- 0013_comms_infrastructure.sql — identity binding, the consumer ledger, and
-- the two no-drop holding areas.
--
-- specs/00-shared-core-architecture.md "Comms aggregation layer"; specs/01
-- number lifecycle (burn/keep/re-use). docs/design/T-016.md §3.8, D12, §5.14.

-- Identity resolution is globally unique among ACTIVE bindings, deliberately
-- crossing the account boundary (D12): inbound routing happens BEFORE any
-- account is known — a webhook arrives addressed to a number and the store
-- must answer "whose deal is this?". A live number therefore belongs to at
-- most one deal platform-wide, so "a dealer reaches a stranger" is
-- unrepresentable. `released_at` is what lets the same number be re-bound to a
-- later deal without ever being double-bound.
CREATE TABLE deal_identities (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  deal_id      uuid NOT NULL,
  -- Provider-agnostic identity handle (@core IdentityRef).
  identity_id  text NOT NULL,
  -- Stored ALREADY NORMALIZED: E.164-shaped number, lowercased alias. The port
  -- promises normalization at bind and at resolve is identical, so the DB holds
  -- one canonical form and resolution is equality, never fuzzy matching.
  phone_number text,
  email_alias  text,
  bound_at     timestamptz NOT NULL,
  released_at  timestamptz,

  CONSTRAINT deal_identities_pkey PRIMARY KEY (id),
  CONSTRAINT deal_identities_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT deal_identities_reachable
    CHECK (phone_number IS NOT NULL OR email_alias IS NOT NULL)
);

CREATE UNIQUE INDEX deal_identities_phone_active_uidx
  ON deal_identities (phone_number) WHERE released_at IS NULL AND phone_number IS NOT NULL;

CREATE UNIQUE INDEX deal_identities_email_active_uidx
  ON deal_identities (email_alias) WHERE released_at IS NULL AND email_alias IS NOT NULL;

CREATE UNIQUE INDEX deal_identities_identity_active_uidx
  ON deal_identities (identity_id) WHERE released_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON deal_identities TO deal_copilot_app;

-- ---- consumer idempotency ledger --------------------------------------
-- The primary key IS the guarantee: an event is processed once, platform-wide.
-- Not account-scoped — the key is opaque and arrives before attribution.

CREATE TABLE processed_events (
  consumer        text NOT NULL,
  idempotency_key text NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON processed_events TO deal_copilot_app;

-- ---- quarantine: unparseable, therefore unattributable ----------------
-- Holds a REF, never the payload — "the payload never rides the bus or the
-- logs" (@comms). Deliberately account-free: an unparseable payload belongs to
-- nobody by definition, and guessing an owner would be a tenancy leak.

CREATE TABLE quarantined_payloads (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  source             text NOT NULL,
  parse_error_code   text NOT NULL,
  parse_error_message text NOT NULL,
  raw_payload_ref    text NOT NULL,
  recorded_at        timestamptz NOT NULL,

  CONSTRAINT quarantined_payloads_pkey PRIMARY KEY (id)
);

GRANT SELECT, INSERT, UPDATE ON quarantined_payloads TO deal_copilot_app;

-- ---- unrouted inbound: held whole, replayable -------------------------
-- Never dropped, never guessed onto a thread, and never minted into a new
-- global Dealership. account_id/deal_id are present exactly when the deal is
-- known, which is what makes listUnrouted(deal_id?) scopable; a
-- 'no_identity_match' record belongs to no account and appears only in the
-- operator view.

CREATE TABLE unrouted_inbound (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id  uuid,
  deal_id     uuid,
  source      text NOT NULL,
  reason      unrouted_reason NOT NULL,
  -- @core InboundComms, held whole so the item can be replayed verbatim.
  inbound     jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,

  CONSTRAINT unrouted_inbound_pkey PRIMARY KEY (id),
  CONSTRAINT unrouted_inbound_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT unrouted_inbound_reason_shape
    CHECK ((reason = 'no_thread_match') = (deal_id IS NOT NULL)),
  -- Both or neither: under MATCH SIMPLE a composite FK with one NULL column is
  -- satisfied, so a deal_id without its account_id would escape the FK check.
  CONSTRAINT unrouted_inbound_scope_paired
    CHECK ((account_id IS NULL) = (deal_id IS NULL))
);

CREATE INDEX unrouted_inbound_deal_idx ON unrouted_inbound (deal_id);

GRANT SELECT, INSERT, UPDATE ON unrouted_inbound TO deal_copilot_app;
