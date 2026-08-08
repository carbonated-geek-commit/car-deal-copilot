-- 0005_dealership_contacts_private.sql — the PRIVATE half of the tenancy split.
--
-- specs/00-shared-core-architecture.md "Dealership data tenancy": contacts are
-- "scoped to the account that entered them and are never exposed to another
-- account". decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
-- docs/design/T-016.md §3.2, D2 (composite-FK tenancy, not RLS).
--
-- `UNIQUE (account_id, id)` is not redundant with the primary key: it is the
-- referencable target that lets every referring row carry its OWN account into
-- the foreign key (see dealer_threads_contact_fk in 0007). Under MATCH SIMPLE
-- a composite FK with a NULL column is satisfied, so "no contact yet" stays
-- legal while "a contact belonging to another account" is a 23503.

CREATE TABLE dealership_contacts (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  dealership_id uuid NOT NULL REFERENCES dealerships (id) ON DELETE RESTRICT,
  name          text NOT NULL,
  role          dealership_contact_role NOT NULL,
  phone         text,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dealership_contacts_pkey PRIMARY KEY (id),
  CONSTRAINT dealership_contacts_account_id_uk UNIQUE (account_id, id)
);

CREATE INDEX dealership_contacts_account_dealership_idx
  ON dealership_contacts (account_id, dealership_id);

GRANT SELECT, INSERT, UPDATE ON dealership_contacts TO deal_copilot_app;
