-- Core saves the requested review and payment/refund terms before contacting
-- the dispatcher or provider. A short claim prevents concurrent quote creation;
-- no database transaction is held open during either HTTP call.
CREATE TABLE checkout_orders (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    request_id UUID NOT NULL,
    terms JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    review_id UUID UNIQUE,
    invoice_id UUID UNIQUE REFERENCES payment_invoices(id),
    state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN (
        'preparing','awaiting_payment','activated','cancelled','expired','needs_review'
    )),
    operation_token UUID,
    operation_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, request_id),
    CHECK ((operation_token IS NULL) = (operation_until IS NULL)),
    CHECK (state NOT IN ('awaiting_payment','activated') OR (review_id IS NOT NULL AND invoice_id IS NOT NULL))
);
CREATE INDEX checkout_orders_account ON checkout_orders(account_id, created_at DESC);
