-- 0006_deals.sql — the deal, with its ONE vehicle target embedded.
--
-- specs/00-shared-core-architecture.md "Cardinality invariants (structurally
-- enforced)": one deal, one make/model. docs/design/T-016.md D1, §3.3.
--
-- AC-8's "exactly one vehicle target per deal" costs zero enforcement code
-- here because the target is COLUMNS ON THE DEAL, not a child table. A second
-- target is not rejected — it is UNREPRESENTABLE, which is strictly stronger
-- than `UNIQUE (deal_id)` on a `vehicle_targets` table (that would still allow
-- delete-and-replace and a nullable zero-row state). There is deliberately no
-- `vehicle_targets` table and no `deals.target_vehicle_id`.
--
-- Q20 / specs/00 "Budget ceiling vs. fair price": `walk_away_cents` is the
-- buyer's BUDGET CEILING for the whole deal. It is not a fair-price verdict —
-- that is per-instance, against that car's own ValuationSnapshot (ADR-007) —
-- and no SQL in this schema compares it to anything.
--
-- `receipt_bundle_id` gets its foreign key in 0011, once receipt_bundles
-- exists; the cycle is broken by ordering, not by a deferred constraint.

CREATE TABLE deals (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  -- IS Deal.owner_id (D3). One column, projected onto owner_id on read.
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  path              deal_path   NOT NULL,
  status            deal_status NOT NULL DEFAULT 'draft',

  -- VehicleTarget, embedded (D1).
  target_make       text NOT NULL,
  target_model      text NOT NULL,
  target_year_from  int,
  target_year_to    int,

  budget_cents      bigint NOT NULL,
  walk_away_cents   bigint NOT NULL,
  receipt_bundle_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  burned_at         timestamptz,

  CONSTRAINT deals_pkey PRIMARY KEY (id),
  CONSTRAINT deals_account_id_uk UNIQUE (account_id, id),

  -- ONE bundle per deal (specs/00 Core domain model, `Deal.receipt_bundle_id`).
  -- receipt_entries key only on receipt_bundle_id, so two deals sharing a bundle
  -- would put deal B's evidence inside a dossier assembled for deal A with
  -- nothing anywhere able to detect it. NULL is unconstrained by a UNIQUE in
  -- Postgres, so a deal with no bundle yet stays legal.
  CONSTRAINT deals_receipt_bundle_uk UNIQUE (receipt_bundle_id),

  -- @core YearRange requires BOTH fields: both present or both absent.
  CONSTRAINT deals_year_range_paired
    CHECK ((target_year_from IS NULL) = (target_year_to IS NULL)),
  -- Well-formedness of the RANGE ITSELF, and nothing else. There is
  -- deliberately NO constraint anywhere relating vehicle_instances.year to
  -- these columns: year drift is a soft guide, not a hard rejection
  -- (specs/00 "Year drift"; Q16; AC-10).
  CONSTRAINT deals_year_range_ordered
    CHECK (target_year_from IS NULL OR target_year_from <= target_year_to),
  CONSTRAINT deals_burned_at_only_when_burned
    CHECK (burned_at IS NULL OR status = 'burned'),
  CONSTRAINT deals_money_nonneg
    CHECK (budget_cents >= 0 AND walk_away_cents >= 0)
);

CREATE INDEX deals_account_idx ON deals (account_id);

GRANT SELECT, INSERT, UPDATE ON deals TO deal_copilot_app;
