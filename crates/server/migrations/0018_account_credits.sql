-- Dollar-denominated service credit. Only a settled USDC top-up can add funds;
-- coupons remain separate and never create a cash balance.
CREATE TABLE credit_topups (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    request_id UUID NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 200 AND 100000),
    terms JSONB NOT NULL,
    presentation JSONB NOT NULL,
    invoice_id UUID UNIQUE REFERENCES payment_invoices(id),
    expires_at TIMESTAMPTZ NOT NULL,
    operation_token UUID,
    operation_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(account_id,request_id),
    CHECK ((operation_token IS NULL) = (operation_until IS NULL))
);
CREATE INDEX credit_topups_account ON credit_topups(account_id,created_at DESC);

CREATE TABLE credit_purchases (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    request_id UUID NOT NULL,
    pentest_id UUID NOT NULL,
    product TEXT NOT NULL CHECK (product IN ('black','grey')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    consent JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    review_id UUID UNIQUE,
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','admitted','funding','activated','completed','released','needs_review')),
    operation_token UUID,
    operation_until TIMESTAMPTZ,
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancel_requested_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(account_id,request_id),
    UNIQUE(pentest_id),
    CHECK ((operation_token IS NULL) = (operation_until IS NULL)),
    CHECK (state NOT IN ('admitted','funding','activated','completed') OR review_id IS NOT NULL)
);
CREATE INDEX credit_purchases_work ON credit_purchases(next_check_at) WHERE state NOT IN ('completed','released','needs_review');

CREATE FUNCTION credit_terms_unchanged() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME='credit_topups' THEN
        IF (NEW.id,NEW.account_id,NEW.request_id,NEW.amount_cents,NEW.terms,NEW.presentation,NEW.expires_at,NEW.created_at)
            IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.request_id,OLD.amount_cents,OLD.terms,OLD.presentation,OLD.expires_at,OLD.created_at)
            OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
            THEN RAISE EXCEPTION 'credit top-up terms are immutable'; END IF;
    ELSE
        IF (NEW.id,NEW.account_id,NEW.request_id,NEW.pentest_id,NEW.product,NEW.amount_cents,NEW.consent,NEW.expires_at,NEW.created_at)
            IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.request_id,OLD.pentest_id,OLD.product,OLD.amount_cents,OLD.consent,OLD.expires_at,OLD.created_at)
            OR (OLD.review_id IS NOT NULL AND NEW.review_id IS DISTINCT FROM OLD.review_id)
            OR (OLD.state IN ('activated','completed') AND NEW.state IN ('reserved','admitted','funding','released'))
            OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
            OR (OLD.state='released' AND NEW.state<>'released')
            OR (OLD.state='completed' AND NEW.state<>'completed')
            THEN RAISE EXCEPTION 'credit purchase terms are immutable'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_credit_topup_terms BEFORE UPDATE ON credit_topups
    FOR EACH ROW EXECUTE FUNCTION credit_terms_unchanged();
CREATE TRIGGER immutable_credit_purchase_terms BEFORE UPDATE ON credit_purchases
    FOR EACH ROW EXECUTE FUNCTION credit_terms_unchanged();

CREATE TABLE credit_ledger (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL CHECK (kind IN ('topup','reserve','release')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
    topup_id UUID REFERENCES credit_topups(id),
    purchase_id UUID REFERENCES credit_purchases(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind='topup' AND topup_id IS NOT NULL AND purchase_id IS NULL AND amount_cents>0)
        OR (kind='reserve' AND purchase_id IS NOT NULL AND topup_id IS NULL AND amount_cents<0)
        OR (kind='release' AND purchase_id IS NOT NULL AND topup_id IS NULL AND amount_cents>0)),
    UNIQUE(topup_id),
    UNIQUE(purchase_id,kind)
);
CREATE INDEX credit_ledger_account ON credit_ledger(account_id,created_at DESC);
CREATE TRIGGER immutable_credit_ledger BEFORE UPDATE OR DELETE ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();

CREATE FUNCTION credit_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- All spending and refunds serialize on the account, including concurrent tabs.
    PERFORM 1 FROM accounts WHERE id=NEW.account_id FOR UPDATE;
    IF COALESCE((SELECT sum(amount_cents) FROM credit_ledger WHERE account_id=NEW.account_id),0)+NEW.amount_cents<0
        THEN RAISE EXCEPTION 'insufficient service credit'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER credit_balance_nonnegative BEFORE INSERT ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION credit_balance_guard();

CREATE FUNCTION credit_entry_backing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='topup' THEN
        IF NOT EXISTS (SELECT 1 FROM credit_topups t JOIN payment_invoices i ON i.id=t.invoice_id JOIN payment_ledger l ON l.invoice_id=i.id
            WHERE t.id=NEW.topup_id AND t.account_id=NEW.account_id AND t.amount_cents=NEW.amount_cents
            AND i.account_id=t.account_id AND i.request_id=t.request_id AND i.state='settled'
            AND i.asset='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
            AND i.required_amount=t.amount_cents*10000 AND l.amount=i.required_amount AND l.asset=i.asset
            AND l.account_id=t.account_id AND l.credit='customer_funds')
            THEN RAISE EXCEPTION 'credit top-up lacks settled backing'; END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM credit_purchases p WHERE p.id=NEW.purchase_id AND p.account_id=NEW.account_id
            AND p.amount_cents=abs(NEW.amount_cents)
            AND (NEW.kind='reserve' OR (NEW.kind='release' AND p.state='released'
                AND NOT EXISTS(SELECT 1 FROM earning_allocations a WHERE a.invoice_id=p.id)
                AND EXISTS(SELECT 1 FROM credit_ledger r WHERE r.purchase_id=p.id AND r.kind='reserve' AND r.amount_cents=-p.amount_cents))))
            THEN RAISE EXCEPTION 'credit purchase entry mismatch'; END IF;
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credit_entry_is_backed AFTER INSERT ON credit_ledger
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_entry_backing();

-- Keep the legacy funding identifier and API fields, but record whether it
-- names a settlement invoice or a credit purchase. No artificial chain receipt
-- is created when an existing balance pays for work.
ALTER TABLE earning_allocations DROP CONSTRAINT earning_allocations_invoice_id_fkey;
ALTER TABLE earning_allocations ADD COLUMN funding_kind TEXT NOT NULL DEFAULT 'invoice'
    CHECK (funding_kind IN ('invoice','credits'));
CREATE OR REPLACE FUNCTION check_earning_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation earning_allocations; actual_count INTEGER; role_total NUMERIC; backed BOOLEAN;
BEGIN
    SELECT * INTO STRICT allocation FROM earning_allocations WHERE invoice_id=NEW.invoice_id;
    SELECT count(*),sum(amount) INTO actual_count,role_total FROM operator_earnings WHERE invoice_id=NEW.invoice_id;
    IF allocation.funding_kind='invoice' THEN
        SELECT EXISTS(SELECT 1 FROM payment_ledger l JOIN payment_invoices i ON i.id=l.invoice_id
            WHERE l.invoice_id=NEW.invoice_id AND l.asset=allocation.asset AND l.amount=allocation.gross_amount
            AND l.credit='customer_funds' AND i.state='settled' AND i.account_id=l.account_id
            AND NOT EXISTS(SELECT 1 FROM credit_topups t WHERE t.invoice_id=i.id)) INTO backed;
    ELSE
        SELECT EXISTS(SELECT 1 FROM credit_purchases p JOIN credit_ledger l ON l.purchase_id=p.id AND l.kind='reserve'
            WHERE p.id=NEW.invoice_id AND p.review_id=allocation.review_id AND p.state IN ('activated','completed')
            AND p.amount_cents*10000=allocation.gross_amount AND l.account_id=p.account_id AND l.amount_cents=-p.amount_cents
            AND allocation.asset='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
            AND NOT EXISTS(SELECT 1 FROM credit_ledger r WHERE r.purchase_id=p.id AND r.kind='release')) INTO backed;
    END IF;
    IF actual_count<>allocation.completed_roles OR role_total<>allocation.operator_amount OR NOT backed
        OR NOT EXISTS(SELECT 1 FROM operator_earnings WHERE invoice_id=NEW.invoice_id AND role='investigator')
        OR NOT EXISTS(SELECT 1 FROM operator_earnings WHERE invoice_id=NEW.invoice_id AND role='reproducer')
        THEN RAISE EXCEPTION 'earning allocation is not fully backed and balanced'; END IF;
    RETURN NULL;
END;
$$;
