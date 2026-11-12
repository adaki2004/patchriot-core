-- Allow a single $1 assessment to be funded. Existing deposits keep their terms;
-- the application still caps new top-ups at $5 during the pilot.
ALTER TABLE credit_topups DROP CONSTRAINT credit_topups_amount_cents_check;
ALTER TABLE credit_topups ADD CONSTRAINT credit_topups_amount_cents_check
    CHECK (amount_cents BETWEEN 100 AND 100000);
