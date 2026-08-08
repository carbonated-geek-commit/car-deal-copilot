-- 0010_instance_bound_records.sql — cached, INSTANCE-bound adapter output.
--
-- specs/00-shared-core-architecture.md "Core domain model": ValuationSnapshot
-- and VehicleData key on `vehicle_instance_id`; "make + model alone is not
-- priceable" and a snapshot is "ALWAYS of one specific car — never of a bare
-- make/model". ADR-007: `above_market` compares the offer price to the RETAIL
-- band of THAT VehicleInstance's snapshot. docs/design/T-016.md §3.5, §5.4.
--
-- There is NO deal_id column on either table and NO deal-level valuation table
-- anywhere. A make/model-level price is unrepresentable — that is how the
-- schema protects the honesty promise, rather than asking callers to remember.
--
-- All four bands are nullable with no default: an adapter that returned only
-- retail leaves the rest ABSENT, and absent stays absent (ADR-005). A thread
-- with no snapshot has no row, which is how "unevaluable" survives the round
-- trip instead of arriving as a 0.

CREATE TABLE valuation_snapshots (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL,
  vehicle_instance_id uuid NOT NULL,
  wholesale_cents     bigint,
  trade_in_cents      bigint,
  retail_cents        bigint,          -- ADR-007: the above_market reference band
  private_party_cents bigint,
  -- Adapter id (e.g. 'mock-kbb') — provenance only. Never a credential, never
  -- an endpoint, never a provider payload.
  source              text NOT NULL,
  captured_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT valuation_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT valuation_snapshots_instance_fk
    FOREIGN KEY (account_id, vehicle_instance_id)
    REFERENCES vehicle_instances (account_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX valuation_snapshots_instance_captured_idx
  ON valuation_snapshots (vehicle_instance_id, captured_at);

GRANT SELECT, INSERT, UPDATE ON valuation_snapshots TO deal_copilot_app;

CREATE TABLE vehicle_data (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL,
  vehicle_instance_id uuid NOT NULL,
  -- @core VinDecode / RecallRecord[] / VehicleHistorySummary — cached adapter
  -- OUTPUT, never a provider's wire format (specs/00 anti-corruption layer).
  decode              jsonb,
  recalls             jsonb NOT NULL DEFAULT '[]',
  history             jsonb,
  captured_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_data_pkey PRIMARY KEY (id),
  CONSTRAINT vehicle_data_instance_fk
    FOREIGN KEY (account_id, vehicle_instance_id)
    REFERENCES vehicle_instances (account_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX vehicle_data_instance_captured_idx
  ON vehicle_data (vehicle_instance_id, captured_at);

GRANT SELECT, INSERT, UPDATE ON vehicle_data TO deal_copilot_app;
