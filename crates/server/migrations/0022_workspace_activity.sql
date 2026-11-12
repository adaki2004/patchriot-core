-- One recent workspace timestamp per account, not a browsing/event history.
CREATE TABLE workspace_activity (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspace_activity_seen ON workspace_activity(last_seen_at);
