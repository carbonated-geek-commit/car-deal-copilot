-- 0012_object_refs.sql — references to bytes, never the bytes.
--
-- specs/00-shared-core-architecture.md "Core domain model" (Store): "object
-- store (S3 or equiv.) for email attachments, uploaded documents, and
-- generated dossiers" — and "No audio is stored".
-- docs/design/T-016.md §3.7, D13, §5.10.
--
-- No table in this schema stores raw bytes. object_refs is the only place in
-- the system where stored bytes are addressable at all, which makes it the only
-- place the no-audio rule can be structural rather than remembered.

CREATE TABLE object_refs (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  kind         object_ref_kind NOT NULL,
  bucket       text NOT NULL,
  object_key   text NOT NULL,
  content_type text,
  size_bytes   bigint,
  sha256       text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT object_refs_pkey PRIMARY KEY (id),
  CONSTRAINT object_refs_location_uk UNIQUE (bucket, object_key),
  CONSTRAINT object_refs_account_id_uk UNIQUE (account_id, id),
  -- D13. Video is deliberately NOT blocked: no spec line addresses it, and
  -- inventing one here would be drift (design §8 item 3).
  CONSTRAINT object_refs_no_audio
    CHECK (content_type IS NULL OR content_type NOT LIKE 'audio/%')
);

GRANT SELECT, INSERT, UPDATE ON object_refs TO deal_copilot_app;

-- ---- uploaded documents ----------------------------------------------

CREATE TABLE deal_documents (
  account_id    uuid NOT NULL,
  deal_id       uuid NOT NULL,
  object_ref_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deal_documents_pkey PRIMARY KEY (deal_id, object_ref_id),
  CONSTRAINT deal_documents_deal_fk
    FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT deal_documents_object_fk
    FOREIGN KEY (account_id, object_ref_id) REFERENCES object_refs (account_id, id)
    ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE ON deal_documents TO deal_copilot_app;

-- ---- generated dossiers (the exportable receipt) ----------------------

CREATE TABLE dossiers (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL,
  receipt_bundle_id uuid NOT NULL,
  object_ref_id     uuid NOT NULL,
  generated_at      timestamptz NOT NULL,

  CONSTRAINT dossiers_pkey PRIMARY KEY (id),
  CONSTRAINT dossiers_bundle_fk
    FOREIGN KEY (account_id, receipt_bundle_id)
    REFERENCES receipt_bundles (account_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT dossiers_object_fk
    FOREIGN KEY (account_id, object_ref_id) REFERENCES object_refs (account_id, id)
    ON DELETE RESTRICT
);

GRANT SELECT, INSERT, UPDATE ON dossiers TO deal_copilot_app;

-- ---- back-fill the attachment -> object edge (created in 0009) --------

ALTER TABLE message_attachments
  ADD CONSTRAINT message_attachments_object_fk
  FOREIGN KEY (account_id, object_ref_id) REFERENCES object_refs (account_id, id)
  ON DELETE RESTRICT;
