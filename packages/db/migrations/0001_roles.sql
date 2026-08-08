-- 0001_roles.sql — the application role.
--
-- docs/design/T-016.md §1.1, §3.6 layer (a), §4.5 (last row).
-- specs/00-shared-core-architecture.md "Receipt layer (trust engine)".
--
-- The append-only guarantee (AC-6) rests first on PRIVILEGE: the role the
-- application connects as must not hold UPDATE or DELETE on receipt_entries.
-- That is only meaningful if the role exists, so it is created here, in the
-- first migration, before any table. Creating it requires CREATEROLE on the
-- migrating role; if that is absent this migration FAILS (mapped to
-- `permission_denied`) rather than being skipped — a schema that quietly
-- skipped its grants would claim an immutability it does not have
-- (design §4.5, §8 item 4).
--
-- NOLOGIN: this role is a privilege bucket. Deployment grants it to whichever
-- login role the connection string uses; inventing a password here would be a
-- credential in the repo.

DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deal_copilot_app') THEN
      CREATE ROLE deal_copilot_app NOLOGIN;
    END IF;
  END
$$;

GRANT USAGE ON SCHEMA public TO deal_copilot_app;
