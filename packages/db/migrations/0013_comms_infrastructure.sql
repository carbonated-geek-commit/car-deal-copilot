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

-- ---- one number, one account, for all time ----------------------------
-- The three partial indexes above bind a value to at most one deal while it is
-- ACTIVE. They say nothing once `released_at` is set, and specs/01 is
-- categorical about the gap that leaves: a burned number is "retired to the
-- carrier at launch — never reassigned to another platform user (zero
-- cross-user leakage)", and Re-use is scoped to the SAME user carrying a number
-- into a new deal. Without this trigger a released number is re-bindable by ANY
-- account, which is the one thing that clause forbids outright.
--
-- No owner table is needed: nothing in this schema is ever deleted (D5), so
-- `deal_identities` IS the complete ownership history. AFTER, not BEFORE, so
-- the ACTIVE double-bind keeps failing at the partial unique index as a plain
-- 23505 — this trigger answers only the question the indexes cannot see, which
-- is who held the value BEFORE it was released.
--
-- Concurrency: of two concurrent binds of one value at most one survives the
-- active partial indexes, and the survivor's trigger has already seen every
-- committed predecessor. DC003 is @db's reserved "cross-account reference
-- caught by a trigger" SQLSTATE (packages/db/src/errors.ts) — this is it.

CREATE FUNCTION deal_identities_owner_pinned() RETURNS trigger
LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.phone_number IS NOT NULL AND EXISTS (
         SELECT 1 FROM deal_identities d
          WHERE d.phone_number = NEW.phone_number
            AND d.account_id <> NEW.account_id
            AND d.id <> NEW.id) THEN
      RAISE EXCEPTION
        'this phone_number was bound by another account and is never reassigned'
        USING ERRCODE = 'DC003', TABLE = 'deal_identities', COLUMN = 'phone_number';
    END IF;
    IF NEW.email_alias IS NOT NULL AND EXISTS (
         SELECT 1 FROM deal_identities d
          WHERE d.email_alias = NEW.email_alias
            AND d.account_id <> NEW.account_id
            AND d.id <> NEW.id) THEN
      RAISE EXCEPTION
        'this email_alias was bound by another account and is never reassigned'
        USING ERRCODE = 'DC003', TABLE = 'deal_identities', COLUMN = 'email_alias';
    END IF;
    RETURN NULL;
  END;
$$;

CREATE TRIGGER deal_identities_owner_pinned
  AFTER INSERT OR UPDATE ON deal_identities FOR EACH ROW
  EXECUTE FUNCTION deal_identities_owner_pinned();

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
