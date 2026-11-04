-- Provider subjects are stable identities. An email match never links a login
-- to an existing password account or grants administrator access.
ALTER TABLE accounts DROP CONSTRAINT accounts_auth_method_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_auth_method_check CHECK (auth_method IN ('invite','password','google','github'));
CREATE TABLE oauth_identities (
    provider TEXT NOT NULL CHECK (provider IN ('github','google')),
    subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    account_id UUID NOT NULL REFERENCES accounts(id),
    verified_email TEXT NOT NULL CHECK (length(verified_email) BETWEEN 3 AND 254),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(provider,subject),
    UNIQUE(account_id,provider)
);
CREATE TABLE oauth_attempts (
    state_hash TEXT PRIMARY KEY CHECK (length(state_hash)=64),
    browser_hash TEXT NOT NULL CHECK (length(browser_hash)=64),
    provider TEXT NOT NULL CHECK (provider IN ('github','google')),
    verifier TEXT NOT NULL CHECK (length(verifier) BETWEEN 43 AND 128),
    nonce TEXT NOT NULL CHECK (length(nonce)=64),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires_at);
