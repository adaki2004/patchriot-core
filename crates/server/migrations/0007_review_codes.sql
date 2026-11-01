-- A code sponsors one review; it never creates a payment receipt or a balance.
-- Reserve before contacting dispatcher. A lost reply must keep the same request.
CREATE TABLE review_codes (
    id UUID PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    account_id UUID REFERENCES accounts(id),
    request_id UUID,
    site_check_id UUID,
    consent JSONB,
    reserved_at TIMESTAMPTZ,
    review_id UUID UNIQUE,
    operation_token UUID,
    operation_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, request_id),
    CHECK ((account_id IS NULL AND request_id IS NULL AND site_check_id IS NULL AND consent IS NULL AND reserved_at IS NULL)
        OR (account_id IS NOT NULL AND request_id IS NOT NULL AND site_check_id IS NOT NULL AND consent IS NOT NULL AND reserved_at IS NOT NULL)),
    CHECK (review_id IS NULL OR account_id IS NOT NULL),
    CHECK (revoked_at IS NULL OR account_id IS NULL),
    CHECK ((operation_token IS NULL) = (operation_until IS NULL))
);
CREATE INDEX review_codes_account ON review_codes(account_id, reserved_at DESC);

-- Include failed guesses, not only successful reservations. There is no public
-- code lookup or issuance route, and no raw code is retained.
CREATE TABLE review_code_attempts (
    account_id UUID PRIMARY KEY REFERENCES accounts(id),
    started_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 20)
);
