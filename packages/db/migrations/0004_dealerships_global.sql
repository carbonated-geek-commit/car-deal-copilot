-- 0004_dealerships_global.sql — the GLOBAL half of the tenancy split.
--
-- specs/00-shared-core-architecture.md "Dealership data tenancy": "A
-- `Dealership` record (name, state, city, zip) is shared across all accounts —
-- one row per real dealership, so a directory can be batch-loaded later."
-- decisions/OPEN-QUESTIONS.md Q12 (AMENDED); specs/01 "Backlog" item 5.
-- docs/design/T-016.md §3.2.
--
-- There is NO account, owner, or tenant column here, and none may be added:
-- an account column on this table would BE the bug the tenancy rule names.

CREATE TABLE dealerships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  state      text NOT NULL,
  city       text NOT NULL,
  zip_code   text NOT NULL,          -- text: leading zeros are real ZIPs
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Batch-load key (specs/01 backlog 5): a later bulk directory import is an
-- idempotent `INSERT ... ON CONFLICT DO NOTHING`, not a dedupe project.
CREATE UNIQUE INDEX dealerships_natural_uidx
  ON dealerships (lower(name), upper(state), lower(city), zip_code);

GRANT SELECT, INSERT, UPDATE ON dealerships TO deal_copilot_app;
