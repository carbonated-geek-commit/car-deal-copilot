-- 0002_enums.sql — the spine's closed sets, transcribed as pg enum types.
--
-- docs/design/T-016.md §3.1. Nine of these mirror a frozen array in `@core`
-- label-for-label and IN ORDER; `PG_ENUMS` in src/schema.ts carries the same
-- tuples so the DB suite compares them (design §6.1 T2) and a spine change
-- breaks the build instead of silently diverging (ADR-001).
--
-- ADR-002: the canonical flag name is `payment_packing` — `packed_payment` is
-- not a label, so it cannot enter the database at all.
-- ADR-007: `above_market` compares an offer price to the RETAIL band of that
-- VehicleInstance's ValuationSnapshot; the label lives here, the computation
-- never does.

-- ---- spine enums (packages/core/src/domain.ts) ------------------------

CREATE TYPE deal_path AS ENUM ('online', 'hybrid', 'in_person');

CREATE TYPE deal_status AS ENUM ('draft', 'active', 'negotiating', 'closed', 'burned');

CREATE TYPE message_channel AS ENUM ('call', 'sms', 'email', 'note');

CREATE TYPE message_direction AS ENUM ('in', 'out', 'internal');

CREATE TYPE message_author AS ENUM ('dealer', 'buyer', 'concierge');

CREATE TYPE vehicle_condition AS ENUM ('new', 'used', 'certified');

CREATE TYPE dealership_contact_role AS ENUM (
  'general_manager',
  'sales_manager',
  'finance_manager',
  'sales_agent'
);

CREATE TYPE process_step AS ENUM (
  'information_gather',
  'deal_negotiation',
  'deal_approval',
  'financing',
  'final_sale',
  'pickup'
);

CREATE TYPE offer_flag AS ENUM (
  'payment_packing',
  'rate_markup',
  'junk_fee',
  'over_walkaway',
  'above_market'
);

-- ---- infrastructure enums (@receipt, @comms, specs/00 Store) ----------

CREATE TYPE receipt_entry_kind AS ENUM ('note', 'sms', 'email', 'call_meta');

CREATE TYPE message_origin_kind AS ENUM ('provider', 'in_app');

CREATE TYPE unrouted_reason AS ENUM ('no_identity_match', 'no_thread_match');

CREATE TYPE object_ref_kind AS ENUM ('email_attachment', 'document', 'dossier', 'raw_payload');

-- Local to thread_contact_points (design §3.1 last line).
CREATE TYPE contact_point_kind AS ENUM ('phone', 'email');
