-- A coupon can buy exactly one kind of assessment. Old reservations keep
-- their original target and consent bytes.
ALTER TABLE review_codes ADD COLUMN pentest_id UUID;
ALTER TABLE review_codes DROP CONSTRAINT review_codes_material;
ALTER TABLE review_codes ADD CONSTRAINT review_codes_material CHECK (
    (account_id IS NULL AND request_id IS NULL AND site_check_id IS NULL AND source_id IS NULL AND pentest_id IS NULL AND consent IS NULL AND reserved_at IS NULL)
    OR (account_id IS NOT NULL AND request_id IS NOT NULL AND num_nonnulls(site_check_id, source_id, pentest_id) = 1 AND consent IS NOT NULL AND reserved_at IS NOT NULL)
);

-- Live agents record scoped HTTP requests, not fictitious terminal calls.
ALTER TABLE operator_earnings ADD COLUMN http_requests INTEGER NOT NULL DEFAULT 0 CHECK (http_requests BETWEEN 0 AND 500);
ALTER TABLE operator_earnings DROP CONSTRAINT operator_earnings_inference_calls_check;
ALTER TABLE operator_earnings ADD CONSTRAINT operator_earnings_inference_calls_check CHECK (inference_calls BETWEEN 1 AND 48);
ALTER TABLE operator_earnings DROP CONSTRAINT operator_earnings_terminal_calls_check;
ALTER TABLE operator_earnings ADD CONSTRAINT operator_earnings_terminal_calls_check CHECK (terminal_calls BETWEEN 0 AND 16);
ALTER TABLE operator_earnings ADD CONSTRAINT operator_earnings_work_observed CHECK (terminal_calls > 0 OR http_requests > 0);
