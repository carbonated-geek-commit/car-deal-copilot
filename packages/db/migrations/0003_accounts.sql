-- 0003_accounts.sql — the tenancy root.
--
-- specs/01-consumer-product-spec.md "Account model": "`Account` owns `Deals`".
-- docs/design/T-016.md D3 — `Deal.owner_id` IS `deals.account_id`; there is no
-- second, independently-writable owner column, because that is exactly the
-- `owner_id <> account_id` hole AC-5 exists to close.
--
-- Deliberately minimal. Authorization, credentials, and profile are E3
-- (task Notes: "Authorization is not in this epic"). This task provides the
-- scope that layer will sit on, and nothing more; inventing an auth column
-- here would be drift.

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON accounts TO deal_copilot_app;
