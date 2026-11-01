-- Invitation approval stays with the operator; a public request never creates an account.
ALTER TABLE accounts ADD COLUMN contact_email TEXT;
ALTER TABLE accounts DROP CONSTRAINT accounts_auth_method_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_auth_method_check CHECK (auth_method IN ('invite', 'google', 'password'));
CREATE UNIQUE INDEX accounts_contact_email ON accounts (lower(contact_email)) WHERE contact_email IS NOT NULL;

CREATE TABLE account_credentials (
    account_id UUID PRIMARY KEY REFERENCES accounts(id),
    username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,39}$'),
    password_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE invites ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'activation'));

CREATE TABLE access_requests (
    id UUID PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
    note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    account_id UUID REFERENCES accounts(id),
    decided_by UUID REFERENCES accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    CHECK ((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND account_id IS NULL)
        OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND account_id IS NOT NULL)
        OR (status = 'declined' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND account_id IS NULL))
);
CREATE UNIQUE INDEX access_requests_pending_email ON access_requests (email) WHERE status = 'pending';
CREATE INDEX access_requests_queue ON access_requests (status, created_at);

-- Keys are hashes of action + socket peer or username, never raw IP addresses.
CREATE TABLE auth_attempts (
    key TEXT PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0)
);
CREATE TABLE account_access_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id UUID NOT NULL REFERENCES accounts(id),
    account_id UUID REFERENCES accounts(id),
    request_id UUID REFERENCES access_requests(id),
    action TEXT NOT NULL CHECK (action IN ('created', 'approved', 'declined', 'invite_renewed', 'disabled', 'coupon_issued')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An account-specific coupon cannot be reserved by anyone else who sees the code.
ALTER TABLE review_codes ADD COLUMN issued_to UUID REFERENCES accounts(id);
ALTER TABLE review_codes ADD CONSTRAINT review_codes_recipient CHECK (issued_to IS NULL OR account_id IS NULL OR issued_to = account_id);
