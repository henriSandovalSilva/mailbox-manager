CREATE TABLE mailboxes (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  imap_host TEXT NOT NULL,
  imap_port INT DEFAULT 993,
  imap_user TEXT NOT NULL,
  imap_pass TEXT NOT NULL,
  imap_tls BOOLEAN DEFAULT TRUE,
  smtp_host TEXT NOT NULL,
  smtp_port INT DEFAULT 465,
  smtp_user TEXT NOT NULL,
  smtp_pass TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE emails (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id TEXT UNIQUE,
  uid INT NOT NULL,
  sender JSONB,
  recipients JSONB,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ,
  raw_headers JSONB,
  has_attachments BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE mailbox_sync_status (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  mailbox_id BIGINT UNIQUE REFERENCES mailboxes(id) ON DELETE CASCADE,
  last_processed_uid INT DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  initial_sync_completed_at TIMESTAMPTZ
);

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_sync_status ENABLE ROW LEVEL SECURITY;