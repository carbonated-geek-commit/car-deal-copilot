-- 0008_offers.sql — offers, their fee lines, and their flag set.
--
-- ADR-005 (sale_price optional; a flag missing a required input is UNEVALUABLE,
-- never zero), ADR-002 (payment_packing canonical), ADR-007 (above_market is
-- against the instance's own RETAIL band). docs/design/T-016.md §3.4, §5.11.
--
-- Every optional money/rate column below is NULLABLE AND HAS NO DEFAULT. NULL
-- means "the dealer stated no price" and T-017 maps it to `undefined`, never to
-- 0. A zero default on any of them would be ADR-005's silently-passed flag
-- expressed in DDL, so none of them has one.

CREATE TABLE offers (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL,
  deal_id          uuid NOT NULL,
  -- Absent for a deal-level offer record not yet attributed to a thread.
  thread_id        uuid,
  sale_price_cents bigint,
  apr              numeric(6,3),
  term_months      smallint,
  monthly_cents    bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT offers_pkey PRIMARY KEY (id),
  CONSTRAINT offers_account_id_uk UNIQUE (account_id, id),
  CONSTRAINT offers_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT offers_thread_fk
    FOREIGN KEY (account_id, thread_id) REFERENCES dealer_threads (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT offers_sale_price_nonneg
    CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
  CONSTRAINT offers_monthly_nonneg
    CHECK (monthly_cents IS NULL OR monthly_cents >= 0),
  CONSTRAINT offers_term_positive
    CHECK (term_months IS NULL OR term_months > 0),
  CONSTRAINT offers_apr_nonneg
    CHECK (apr IS NULL OR apr >= 0)
);

CREATE INDEX offers_deal_idx ON offers (deal_id);

GRANT SELECT, INSERT, UPDATE ON offers TO deal_copilot_app;

-- ---- fee lines --------------------------------------------------------

CREATE TABLE offer_fees (
  offer_id     uuid   NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  -- Preserves fees[] order; the array index, not a surrogate key.
  idx          int    NOT NULL,
  name         text   NOT NULL,
  -- Sign is deliberately UNCONSTRAINED: a negative line is a discount, and
  -- inventing a rule here would be drift.
  amount_cents bigint NOT NULL,

  CONSTRAINT offer_fees_pkey PRIMARY KEY (offer_id, idx),
  CONSTRAINT offer_fees_idx_nonneg CHECK (idx >= 0)
);

GRANT SELECT, INSERT, UPDATE ON offer_fees TO deal_copilot_app;

-- ---- flag set ---------------------------------------------------------

CREATE TABLE offer_flags (
  offer_id uuid       NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  flag     offer_flag NOT NULL,

  -- Set semantics an array cannot give: no duplicate flag on one offer.
  CONSTRAINT offer_flags_pkey PRIMARY KEY (offer_id, flag)
);
-- The database STORES the flag engine's output. It never computes a flag, and
-- it holds no valuation input with which it could.

GRANT SELECT, INSERT, UPDATE ON offer_flags TO deal_copilot_app;

-- ---- back-fill the thread -> current_offer edge (design §3.4) ---------

ALTER TABLE dealer_threads
  ADD CONSTRAINT dealer_threads_current_offer_fk
  FOREIGN KEY (account_id, current_offer_id) REFERENCES offers (account_id, id)
  ON DELETE RESTRICT;
