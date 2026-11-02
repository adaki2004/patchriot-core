-- Convert a completed service's customer liability into operator liabilities
-- and platform revenue. The original receipt remains immutable.
CREATE TABLE earning_allocations (
    invoice_id UUID PRIMARY KEY REFERENCES payment_invoices(id),
    review_id UUID NOT NULL UNIQUE,
    asset TEXT NOT NULL,
    gross_amount BIGINT NOT NULL CHECK (gross_amount >= 10),
    platform_amount BIGINT NOT NULL CHECK (platform_amount = gross_amount / 10),
    operator_amount BIGINT NOT NULL CHECK (operator_amount = gross_amount - platform_amount),
    result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
    policy TEXT NOT NULL CHECK (policy = 'three_roles_90_10_v1'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE operator_earnings (
    invoice_id UUID NOT NULL REFERENCES earning_allocations(invoice_id),
    role TEXT NOT NULL CHECK (role IN ('investigator','reproducer','challenger')),
    operator_id UUID NOT NULL REFERENCES accounts(id),
    device_id UUID NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    reported_duration_ms BIGINT NOT NULL CHECK (reported_duration_ms >= 0),
    reported_model TEXT NOT NULL CHECK (length(reported_model) BETWEEN 1 AND 160),
    inference_calls INTEGER NOT NULL CHECK (inference_calls BETWEEN 1 AND 4),
    terminal_calls INTEGER NOT NULL CHECK (terminal_calls BETWEEN 1 AND 16),
    PRIMARY KEY (invoice_id, role),
    UNIQUE (invoice_id, device_id)
);
CREATE INDEX operator_earnings_account ON operator_earnings(operator_id, invoice_id);
CREATE TRIGGER immutable_earning_allocation BEFORE UPDATE OR DELETE ON earning_allocations
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();
CREATE TRIGGER immutable_operator_earnings BEFORE UPDATE OR DELETE ON operator_earnings
    FOR EACH ROW EXECUTE FUNCTION payment_ledger_is_append_only();

CREATE FUNCTION check_earning_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation earning_allocations; role_count INTEGER; role_total NUMERIC;
BEGIN
    SELECT * INTO STRICT allocation FROM earning_allocations WHERE invoice_id = NEW.invoice_id;
    SELECT count(*), sum(amount) INTO role_count, role_total FROM operator_earnings WHERE invoice_id = NEW.invoice_id;
    IF role_count <> 3 OR role_total <> allocation.operator_amount OR NOT EXISTS (
        SELECT 1 FROM payment_ledger l JOIN payment_invoices i ON i.id = l.invoice_id
        WHERE l.invoice_id = NEW.invoice_id AND l.asset = allocation.asset
            AND l.amount = allocation.gross_amount AND l.credit = 'customer_funds'
            AND i.state = 'settled' AND i.account_id = l.account_id
    ) THEN RAISE EXCEPTION 'earning allocation is not fully backed and balanced'; END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_earning_allocation AFTER INSERT ON earning_allocations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_earning_allocation();
CREATE CONSTRAINT TRIGGER balanced_operator_earnings AFTER INSERT ON operator_earnings
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_earning_allocation();

ALTER TABLE payment_funding_events ADD COLUMN earnings_next_check_at TIMESTAMPTZ DEFAULT now(),
    ADD COLUMN earnings_error TEXT;
CREATE INDEX pending_earnings ON payment_funding_events(earnings_next_check_at)
    WHERE delivery_state = 'delivered' AND earnings_next_check_at IS NOT NULL;
