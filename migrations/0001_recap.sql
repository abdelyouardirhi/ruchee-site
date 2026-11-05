-- No contact data or demo content: only domain-separated HMACs and request metadata.
-- Retention is enforced on submission; idle databases need a later scheduled cleanup.
CREATE TABLE recap_requests (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'failed', 'unknown'))
);

CREATE INDEX recap_requests_created ON recap_requests (created_at);
CREATE INDEX recap_requests_ip_created ON recap_requests (ip_hash, created_at);
CREATE INDEX recap_requests_email_created ON recap_requests (email_hash, created_at);
