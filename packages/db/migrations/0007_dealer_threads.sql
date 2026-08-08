-- 0007_dealer_threads.sql — threads, their own vehicle instances, and the
-- account-private inbound routing index.
--
-- specs/00-shared-core-architecture.md "Cardinality invariants": MANY
-- dealerships per deal, and "each thread carries its own `VehicleInstance`".
-- docs/design/T-016.md §3.2, §3.4.

CREATE TABLE dealer_threads (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL,
  deal_id                uuid NOT NULL,
  dealership_id          uuid NOT NULL REFERENCES dealerships (id) ON DELETE RESTRICT,
  process_step           process_step NOT NULL DEFAULT 'information_gather',
  -- Absent until the buyer is handed to a person (@core: "Optional — absent
  -- until handed to a person"). Nullable is load-bearing: see the composite FK.
  working_with_contact_id uuid,
  -- ADR-006 output only. Its foreign key is added in 0008 (offers do not exist
  -- yet); the cycle is broken by ordering, not by a deferred constraint.
  current_offer_id       uuid,
  -- @comms RollupState, stored VERBATIM. No trigger, view, or generated column
  -- recomputes the per-field newest-wins merge — a second implementation in SQL
  -- would be ADR-001's parallel definition in a different language (D/§5.13).
  rollup_state           jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dealer_threads_pkey PRIMARY KEY (id),

  -- One thread per dealership per deal, and the deterministic key that makes
  -- resolveOrCreateThread idempotent (CONSTRAINTS.thread_per_dealership).
  CONSTRAINT dealer_threads_deal_dealership_uk UNIQUE (deal_id, dealership_id),

  -- Referencable targets for the composite (account-carrying) foreign keys of
  -- every child table. Each exists for a named referrer, not for symmetry.
  CONSTRAINT dealer_threads_account_id_uk UNIQUE (account_id, id),
  CONSTRAINT dealer_threads_account_deal_id_uk UNIQUE (account_id, deal_id, id),
  CONSTRAINT dealer_threads_account_deal_dealership_uk
    UNIQUE (account_id, deal_id, dealership_id),

  -- The account on THIS row is not free: it is pinned to the deal's account,
  -- so it cannot be set to a stranger's account in order to reach a stranger's
  -- contact — the row would then dangle off a deal that account does not own.
  CONSTRAINT dealer_threads_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,

  -- AC-4, the whole tenancy split in one constraint. MATCH SIMPLE (the
  -- default) is exactly right: a NULL contact satisfies it, so "no contact
  -- yet" is legal, while a contact belonging to another account is a 23503.
  CONSTRAINT dealer_threads_contact_fk
    FOREIGN KEY (account_id, working_with_contact_id)
    REFERENCES dealership_contacts (account_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX dealer_threads_deal_idx ON dealer_threads (deal_id);

GRANT SELECT, INSERT, UPDATE ON dealer_threads TO deal_copilot_app;

-- ---- vehicle instances — one per thread (AC-9) ------------------------

CREATE TABLE vehicle_instances (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  thread_id  uuid NOT NULL,
  -- User-entered and UNVALIDATED at launch (Q16; specs/01 backlog 4; AC-11):
  -- no length check, no regex, no checksum, no uniqueness. Absent is normal.
  vin        text,
  year       int NOT NULL,
  trim       text,
  mileage    int,
  condition  vehicle_condition NOT NULL,
  additions  text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_instances_pkey PRIMARY KEY (id),
  -- "each thread carries its own VehicleInstance": an instance cannot be
  -- shared across threads and a thread cannot have two. An absent instance is
  -- simply no row, which is legal during information_gather.
  CONSTRAINT vehicle_instances_thread_uk UNIQUE (thread_id),
  CONSTRAINT vehicle_instances_account_id_uk UNIQUE (account_id, id),
  CONSTRAINT vehicle_instances_thread_fk
    FOREIGN KEY (account_id, thread_id) REFERENCES dealer_threads (account_id, id)
    ON DELETE RESTRICT
);
-- NOTE: there is no make/model column here. A thread that contradicts the
-- deal's anchor is unrepresentable, exactly as in @core.

GRANT SELECT, INSERT, UPDATE ON vehicle_instances TO deal_copilot_app;

-- ---- contact points — the account-private inbound routing index -------

CREATE TABLE thread_contact_points (
  account_id    uuid NOT NULL,
  deal_id       uuid NOT NULL,
  dealership_id uuid NOT NULL,
  point_kind    contact_point_kind NOT NULL,
  -- Stored ALREADY NORMALIZED (E.164-shaped phone, lowercased address), so
  -- resolution is an equality match and never fuzzy.
  point_value   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Leads with deal_id: a contact lookup that is not scoped to one deal is
  -- inexpressible at the index level — the schema-side mirror of the port rule
  -- that resolveDealershipByContact takes deal_id first and mandatory.
  CONSTRAINT thread_contact_points_pkey PRIMARY KEY (deal_id, point_kind, point_value),
  CONSTRAINT thread_contact_points_thread_fk
    FOREIGN KEY (account_id, deal_id, dealership_id)
    REFERENCES dealer_threads (account_id, deal_id, dealership_id)
    ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE ON thread_contact_points TO deal_copilot_app;
