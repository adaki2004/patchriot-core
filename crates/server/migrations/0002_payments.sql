-- Exact-output invoices are created only by trusted core code after admission.
-- The current browser prototype has no paid checkout or invoice-creation route.
CREATE TABLE payment_invoices (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    request_id UUID NOT NULL,
    asset TEXT NOT NULL CHECK (length(asset) BETWEEN 1 AND 256),
    recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 1 AND 256),
    required_amount BIGINT NOT NULL CHECK (required_amount > 0),
    correlation_id TEXT NOT NULL UNIQUE,
    deposit_address TEXT NOT NULL,
    deposit_memo TEXT NOT NULL DEFAULT '',
    quote_request JSONB NOT NULL,
    quote JSONB NOT NULL,
    deadline TIMESTAMPTZ NOT NULL,
    watch_until TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
        'pending', 'processing', 'incomplete', 'expired', 'failed',
        'refunded', 'settled', 'held', 'needs_review'
    )),
    reason TEXT,
    received_amount BIGINT CHECK (received_amount > 0),
    provider_updated_at TIMESTAMPTZ,
    terminal_reported BOOLEAN NOT NULL DEFAULT false,
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    poll_token UUID,
    poll_until TIMESTAMPTZ,
    poll_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, request_id),
    UNIQUE (deposit_address, deposit_memo),
    CHECK (watch_until > deadline)
);
CREATE INDEX payment_invoices_poll ON payment_invoices(next_check_at)
    WHERE state NOT IN ('settled', 'held', 'needs_review');

-- A transfer stores both sides in one row: debit the treasury asset and credit
-- the customer's liability in the same asset and integer amount. It cannot be
-- partially posted. No payouts, spending or held-fund release exists yet.
CREATE TABLE payment_ledger (
    id UUID PRIMARY KEY,
    invoice_id UUID NOT NULL UNIQUE REFERENCES payment_invoices(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    asset TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    debit TEXT NOT NULL CHECK (debit = 'treasury_asset'),
    credit TEXT NOT NULL CHECK (credit IN ('customer_funds', 'customer_held_funds')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_ledger_account ON payment_ledger(account_id, asset);

CREATE FUNCTION payment_ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'payment ledger entries cannot be changed or removed';
END;
$$;
CREATE TRIGGER immutable_payment_ledger
    BEFORE UPDATE OR DELETE ON payment_ledger
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();

-- Saved in the same transaction as the ledger. A later order adapter must
-- consume invoice_id once; a recorded payment does not itself dispatch work.
CREATE TABLE payment_funding_events (
    invoice_id UUID PRIMARY KEY REFERENCES payment_invoices(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    request_id UUID NOT NULL,
    asset TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ
);
