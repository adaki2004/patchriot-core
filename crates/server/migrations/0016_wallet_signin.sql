-- A verified wallet is a separate identity. Payment addresses never link accounts.
ALTER TABLE accounts DROP CONSTRAINT accounts_auth_method_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_auth_method_check CHECK (auth_method IN ('invite','password','google','github','wallet'));
CREATE TABLE wallet_identities (
    network TEXT NOT NULL CHECK (network IN ('ethereum','solana')),
    address TEXT NOT NULL CHECK (length(address) BETWEEN 32 AND 44),
    account_id UUID NOT NULL REFERENCES accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(network,address),
    UNIQUE(account_id)
);
CREATE TABLE wallet_challenges (
    nonce_hash TEXT PRIMARY KEY CHECK (length(nonce_hash)=64),
    browser_hash TEXT NOT NULL UNIQUE CHECK (length(browser_hash)=64),
    network TEXT NOT NULL CHECK (network IN ('ethereum','solana')),
    address TEXT NOT NULL CHECK (length(address) BETWEEN 32 AND 44),
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2048),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wallet_challenges_expiry ON wallet_challenges(expires_at);
