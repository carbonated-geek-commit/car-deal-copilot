-- 0009_messages.sql — the message spine and its attachment refs.
--
-- specs/00-shared-core-architecture.md "Core domain model" (`Message`) and
-- "Comms aggregation layer" ("Provider timeouts must never drop a dealer
-- message"). specs/01 "Consent & recording posture": "There is no
-- `recording_url` field on `Message` at all"; no audio is stored.
-- docs/design/T-016.md §3.4.
--
-- THIS TABLE POINTS AT NO AUDIO, NO RECORDING, AND NO CALL TEXT, AND NEITHER
-- DOES ANY OTHER TABLE IN THIS SCHEMA (AC-12, Q14). The fields were removed from the spine
-- rather than left null, and this schema does not resurrect them. Call
-- metadata — start, duration, other party — is all that a call leaves behind.

CREATE TABLE messages (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL,
  deal_id               uuid NOT NULL,
  thread_id             uuid NOT NULL,
  channel               message_channel   NOT NULL,
  direction             message_direction NOT NULL,
  -- Who produced this text. NOT NULL and NO DEFAULT: a default would be an
  -- inference wearing a different hat (specs/00 "Receipt layer"; @core Q22).
  author                message_author    NOT NULL,
  -- Verbatim for sms/email, authored for note, absent for a bare call record.
  body                  text,
  call_started_at       timestamptz,
  call_duration_seconds int,
  call_party            text,
  occurred_at           timestamptz NOT NULL,
  -- Provider message id, or `note:<client_note_ref>` for an in-app note.
  -- Envelope-derived persistence metadata, not a spine field (@comms).
  message_ref           text NOT NULL,
  origin_kind           message_origin_kind NOT NULL,
  origin_source         text,
  extracted_offer_id    uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_account_id_uk UNIQUE (account_id, id),

  -- CONSTRAINTS.message_dedupe. The keyed write that makes at-least-once
  -- redelivery safe: T-017 inserts ON CONFLICT DO NOTHING and reads row_count.
  -- A duplicate here is expected traffic, not an incident.
  CONSTRAINT messages_deal_message_ref_uk UNIQUE (deal_id, message_ref),

  CONSTRAINT messages_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT messages_thread_fk
    FOREIGN KEY (account_id, thread_id) REFERENCES dealer_threads (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT messages_extracted_offer_fk
    FOREIGN KEY (account_id, extracted_offer_id) REFERENCES offers (account_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT messages_call_shape
    CHECK (channel = 'call'
           OR (call_started_at IS NULL
               AND call_duration_seconds IS NULL
               AND call_party IS NULL)),
  -- Mirrors @core's gloss and @receipt's NoteEntryInput: a note is authored
  -- in-app, internal, and never by the dealer. A fabricated dealer-authored
  -- note is unrepresentable, not merely discouraged.
  CONSTRAINT messages_note_shape
    CHECK (channel <> 'note'
           OR (direction = 'internal' AND author <> 'dealer' AND origin_kind = 'in_app')),
  CONSTRAINT messages_origin_shape
    CHECK ((origin_kind = 'provider') = (origin_source IS NOT NULL))
);

CREATE INDEX messages_thread_occurred_idx ON messages (thread_id, occurred_at);

GRANT SELECT, INSERT, UPDATE ON messages TO deal_copilot_app;

-- extracted_offer_id is FILL-ONCE, matching attachExtractedOffer's
-- 'set' | 'already_set' contract: NULL -> value is allowed, value -> the same
-- value is a no-op, value -> a DIFFERENT value is the write-once violation.
CREATE FUNCTION messages_extracted_offer_fill_once() RETURNS trigger
LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.extracted_offer_id IS NOT NULL
    AND NEW.extracted_offer_id IS DISTINCT FROM OLD.extracted_offer_id THEN
      RAISE EXCEPTION
        'message % already has an extracted offer; the link is fill-once', OLD.id
        USING ERRCODE = 'DC002', TABLE = 'messages', COLUMN = 'extracted_offer_id';
    END IF;
    RETURN NEW;
  END;
$$;

CREATE TRIGGER messages_extracted_offer_fill_once
  BEFORE UPDATE ON messages FOR EACH ROW
  EXECUTE FUNCTION messages_extracted_offer_fill_once();

-- ---- attachment join (object refs only, never bytes) ------------------
-- The object_ref foreign key is added in 0012, where object_refs is created.

CREATE TABLE message_attachments (
  account_id    uuid NOT NULL,
  message_id    uuid NOT NULL,
  object_ref_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_attachments_pkey PRIMARY KEY (message_id, object_ref_id),
  CONSTRAINT message_attachments_message_fk
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id)
    ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE ON message_attachments TO deal_copilot_app;
