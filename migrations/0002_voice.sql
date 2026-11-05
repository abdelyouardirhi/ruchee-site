-- No names, audio or transcripts: only domain-separated HMACs and metadata.
-- Submission-time cleanup retains at most 48 hours on an active endpoint.
CREATE TABLE voice_requests (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('greet', 'transcribe')),
  fingerprint TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown'))
);

CREATE INDEX voice_requests_created ON voice_requests (created_at);
CREATE INDEX voice_requests_action_created ON voice_requests (action, created_at);
CREATE INDEX voice_requests_action_ip_created ON voice_requests (action, ip_hash, created_at);
