-- Preserve all existing three-role receipts. New live reviews split the same
-- 90% operator share across the two or three roles that actually completed.
ALTER TABLE earning_allocations DROP CONSTRAINT earning_allocations_policy_check;
ALTER TABLE earning_allocations ADD COLUMN completed_roles SMALLINT NOT NULL DEFAULT 3,
    ADD CONSTRAINT earning_allocations_policy_check CHECK (
        (policy = 'three_roles_90_10_v1' AND completed_roles = 3)
        OR (policy = 'investigate_verify_90_10_v1' AND completed_roles IN (2, 3))
    );

CREATE OR REPLACE FUNCTION check_earning_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation earning_allocations; actual_count INTEGER; role_total NUMERIC;
BEGIN
    SELECT * INTO STRICT allocation FROM earning_allocations WHERE invoice_id = NEW.invoice_id;
    SELECT count(*), sum(amount) INTO actual_count, role_total FROM operator_earnings WHERE invoice_id = NEW.invoice_id;
    IF actual_count <> allocation.completed_roles OR role_total <> allocation.operator_amount
        OR NOT EXISTS (SELECT 1 FROM operator_earnings WHERE invoice_id=NEW.invoice_id AND role='investigator')
        OR NOT EXISTS (SELECT 1 FROM operator_earnings WHERE invoice_id=NEW.invoice_id AND role='reproducer')
        OR NOT EXISTS (
            SELECT 1 FROM payment_ledger l JOIN payment_invoices i ON i.id = l.invoice_id
            WHERE l.invoice_id = NEW.invoice_id AND l.asset = allocation.asset
                AND l.amount = allocation.gross_amount AND l.credit = 'customer_funds'
                AND i.state = 'settled' AND i.account_id = l.account_id
        ) THEN RAISE EXCEPTION 'earning allocation is not fully backed and balanced'; END IF;
    RETURN NULL;
END;
$$;
