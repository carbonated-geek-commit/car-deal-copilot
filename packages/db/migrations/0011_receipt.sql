-- 0011_receipt.sql — the receipt trail, append-only IN THREE LAYERS.
--
-- specs/00-shared-core-architecture.md "Receipt layer (trust engine)": every
-- buyer note, SMS, email, and call-metadata record is "append-only,
-- timestamped, exportable", and "each entry carries its author ... so
-- self-authored evidence is never presented as if it came from the dealer".
-- docs/design/T-016.md D4, D7, D8, §3.6, §5.7, §5.8.
--
-- The three layers cover three different attackers:
--   (a) PRIVILEGE  — the application role is granted SELECT, INSERT and holds
--                    no UPDATE/DELETE verb at all;
--   (b) TRIGGER    — binds the table owner, a later migration, and a psql
--                    operator, none of whom a grant constrains;
--   (c) NO CASCADE — every foreign key in this schema is ON DELETE RESTRICT,
--                    so no parent delete can reach the trail by accident.
--
-- Immutability therefore does not depend on application discipline (AC-6).

CREATE TABLE receipt_bundles (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  -- Per-bundle counter. The UPDATE in the stamp trigger takes this row's lock,
  -- which serializes concurrent appends with no gap and no max(seq)+1 race —
  -- no advisory lock and no sequence needed.
  next_seq   bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT receipt_bundles_pkey PRIMARY KEY (id),
  CONSTRAINT receipt_bundles_account_id_uk UNIQUE (account_id, id)
);

GRANT SELECT, INSERT, UPDATE ON receipt_bundles TO deal_copilot_app;

CREATE TABLE receipt_entries (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL,
  receipt_bundle_id     uuid NOT NULL,
  -- Trigger-assigned. @receipt ReceiptEntryStamp: "Store-assigned at append
  -- time; never caller-supplied" — so the durable store cannot forge ordering
  -- even if a caller tries.
  seq                   bigint NOT NULL,
  kind                  receipt_entry_kind NOT NULL,
  -- AC-7. NOT NULL, NO DEFAULT, never inferred and never derived from `kind`,
  -- `direction`, or provider metadata. The concierge honesty guarantee rests
  -- on this column, so it is the last one that may ever acquire a default.
  author                message_author     NOT NULL,
  direction             message_direction  NOT NULL,
  -- Derived from `kind` — a bijection under v0.5 (@receipt). Generated in the
  -- schema so the trail cannot mislabel a channel even if T-017 has a bug.
  channel               message_channel GENERATED ALWAYS AS (
                          CASE kind
                            WHEN 'note'  THEN 'note'::message_channel
                            WHEN 'sms'   THEN 'sms'::message_channel
                            WHEN 'email' THEN 'email'::message_channel
                            ELSE 'call'::message_channel
                          END) STORED,
  occurred_at           timestamptz NOT NULL,
  appended_at           timestamptz NOT NULL,     -- trigger-assigned
  body                  text,
  subject               text,
  call_started_at       timestamptz,
  call_duration_seconds int,
  call_party            text,
  provider_message_ref  text,
  dedupe_key            text,

  CONSTRAINT receipt_entries_pkey PRIMARY KEY (id),
  CONSTRAINT receipt_entries_bundle_fk
    FOREIGN KEY (account_id, receipt_bundle_id)
    REFERENCES receipt_bundles (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT receipt_entries_bundle_seq_uk UNIQUE (receipt_bundle_id, seq),
  CONSTRAINT receipt_entries_note_shape
    CHECK (kind <> 'note'
           OR (direction = 'internal' AND author <> 'dealer'
               AND provider_message_ref IS NULL AND body IS NOT NULL)),
  CONSTRAINT receipt_entries_call_shape
    CHECK (kind = 'call_meta'
           OR (call_started_at IS NULL AND call_duration_seconds IS NULL
               AND call_party IS NULL)),
  CONSTRAINT receipt_entries_call_author
    CHECK (kind <> 'call_meta' OR author <> 'dealer')
);
-- No recording_url, no transcript, no audio_ref, no bytea. A call leaves
-- metadata behind and nothing else (specs/01 consent posture; Q14; AC-12).

CREATE INDEX receipt_entries_bundle_seq_idx ON receipt_entries (receipt_bundle_id, seq);

-- D8 (BINDING, from @receipt's contract): only a NON-BLANK key anchors. A
-- blank or whitespace-only key means "no anchor was supplied" and the entry
-- appends normally — it is normalized to NULL, never rejected, because the
-- safe failure direction for a trail whose value is completeness is a possible
-- duplicate, never a loss.
CREATE UNIQUE INDEX receipt_entries_bundle_dedupe_uidx
  ON receipt_entries (receipt_bundle_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE FUNCTION receipt_entries_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE receipt_bundles SET next_seq = next_seq + 1
     WHERE id = NEW.receipt_bundle_id
    RETURNING next_seq - 1 INTO NEW.seq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown receipt bundle'
        USING ERRCODE = '23503', TABLE = 'receipt_entries';
    END IF;
    NEW.appended_at := now();
    IF btrim(coalesce(NEW.dedupe_key, '')) = '' THEN
      NEW.dedupe_key := NULL;
    END IF;
    RETURN NEW;
  END;
$$;

CREATE TRIGGER receipt_entries_stamp
  BEFORE INSERT ON receipt_entries FOR EACH ROW
  EXECUTE FUNCTION receipt_entries_stamp();

-- ---- layer (b): the trigger wall -------------------------------------
-- SQLSTATE DC001 is project-specific (design D6): PL/pgSQL's default P0001 is
-- indistinguishable from any other RAISE, so a caller could not tell "you
-- wrote against the receipt trail" from "a check failed". @db owns the
-- SQLSTATE -> DbErrorCode map so no caller ever string-matches a message.

CREATE FUNCTION receipt_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'receipt_entries is append-only: % is not permitted', TG_OP
      USING ERRCODE = 'DC001', TABLE = 'receipt_entries';
  END;
$$;

CREATE TRIGGER receipt_entries_no_update
  BEFORE UPDATE ON receipt_entries FOR EACH ROW
  EXECUTE FUNCTION receipt_entries_append_only();

CREATE TRIGGER receipt_entries_no_delete
  BEFORE DELETE ON receipt_entries FOR EACH ROW
  EXECUTE FUNCTION receipt_entries_append_only();

CREATE TRIGGER receipt_entries_no_truncate
  BEFORE TRUNCATE ON receipt_entries FOR EACH STATEMENT
  EXECUTE FUNCTION receipt_entries_append_only();

-- ---- layer (a): the application literally does not hold the verbs -----

GRANT SELECT, INSERT ON receipt_entries TO deal_copilot_app;
REVOKE UPDATE, DELETE, TRUNCATE ON receipt_entries FROM deal_copilot_app;
REVOKE UPDATE, DELETE, TRUNCATE ON receipt_entries FROM PUBLIC;

-- ---- back-fill the deal -> bundle edge -------------------------------
-- Composite, so a deal cannot point at another account's bundle. RESTRICT, so
-- a bundle with entries cannot be removed out from under its trail.

ALTER TABLE deals
  ADD CONSTRAINT deals_receipt_bundle_fk
  FOREIGN KEY (account_id, receipt_bundle_id)
  REFERENCES receipt_bundles (account_id, id)
  ON DELETE RESTRICT;
