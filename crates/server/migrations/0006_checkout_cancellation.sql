-- Closing checkout locally prevents new funding attempts immediately. Remote
-- cancellation is confirmed separately; neither action is a refund receipt.
ALTER TABLE checkout_orders
    ADD COLUMN cancel_requested_at TIMESTAMPTZ,
    ADD COLUMN cancel_confirmed_at TIMESTAMPTZ,
    ADD COLUMN cancel_review_state TEXT
        CHECK (cancel_review_state IN ('cancelled','failed','completed','needs_review')),
    ADD COLUMN cancel_next_attempt_at TIMESTAMPTZ,
    ADD CONSTRAINT checkout_cancellation_shape CHECK (
        (cancel_requested_at IS NULL AND cancel_confirmed_at IS NULL AND cancel_review_state IS NULL AND cancel_next_attempt_at IS NULL)
        OR (cancel_requested_at IS NOT NULL AND review_id IS NOT NULL
            AND ((cancel_confirmed_at IS NULL AND cancel_review_state IS NULL)
                OR (cancel_confirmed_at IS NOT NULL AND cancel_review_state IS NOT NULL AND cancel_next_attempt_at IS NULL)))
    );
CREATE INDEX checkout_cancellation_due ON checkout_orders(cancel_next_attempt_at)
    WHERE cancel_requested_at IS NOT NULL AND cancel_confirmed_at IS NULL;
