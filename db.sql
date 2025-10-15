CREATE TABLE mailboxes (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INT DEFAULT 993,
  smtp_host TEXT NOT NULL,
  smtp_port INT DEFAULT 465,
  smtp_secure BOOLEAN DEFAULT TRUE,
  imap_secure BOOLEAN DEFAULT TRUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE emails (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  message_id TEXT,
  uid INT NOT NULL,
  sender JSONB,
  recipients JSONB,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ,
  raw_headers JSONB,
  original_from TEXT,
  has_attachments BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (mailbox_id, uid)
);

CREATE TABLE mailbox_sync_status (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  mailbox_id BIGINT UNIQUE REFERENCES mailboxes(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  last_processed_uid INT DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  initial_sync_completed_at TIMESTAMPTZ
);

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_sync_status ENABLE ROW LEVEL SECURITY;